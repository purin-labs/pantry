import { acceptedExecutionAccountAuthority } from "../account-platform/access";
import {
  MAX_EVAL_REPLY_LENGTH,
  type EvalObservation,
  type EvalTaskExecution,
  type EvalTaskOutcome,
  type EvalTaskPins,
  type EvalUnavailableReason,
} from "@seams/control-api";
import type { SessionProposal } from "@seams/contracts";
import {
  parseEntityRef,
  SUPPLIER_ENTITY_TYPE_ID,
} from "@seams/commerce-client";

import {
  BACKGROUND_MEMORY_DEADLINE_MS,
  prepareTurnAuthority,
  prepareTurnContext,
} from "../context/turn-context";
import { readContactVerificationStanding } from "../data/contact-verification";
import { readAgentMailboxBinding } from "../data/email-mailbox";
import { readGmailInferenceEligibility } from "../data/gmail-inference-eligibility";
import { ensureOrganisationDefaultWorkspace } from "../data/organisation-workspace";
import {
  composeAgentInstructions,
  resolveCaseTurnAgentProfile,
} from "../data/pinned-agent-profile";
import type { Env } from "../env";
import { readEvalRunFixture } from "../evals/access";
import { scoreEvalScenario } from "../evals/scorer";
import type { GmailMessageContent } from "../mail/gmail-adapter";
import {
  newRequestId,
  parseAssignmentId,
  parseCaseId,
  parseIntegrationAccountId,
  parseOrganisationId,
  parseSessionId,
} from "../ids";
import { supplierReplyRecipient } from "../mail-inbox/verified-sender";
import { createEvalTurnMemoryReader } from "../memory/access";
import {
  digestModelRoute,
  resolveOrganisationModelRouteForSelection,
} from "../models/route";
import { traceWarn } from "../observability";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  loadOrganisationPolicyOrDefaultDeny,
  type PinnedSessionPolicy,
} from "../policy-snapshot";
import {
  canonicalFlowLabel,
  digestCanonical,
  FlowBinding,
} from "../policy/information-flow";
import { ensureCaseProject } from "../projects/case-project";
import { buildAgentMailboxAuthority } from "../request-authority";
import { isActorExecutionActive } from "./actor-execution-quiescence";
import { serializeContextBundle } from "./actor-journal/parsers";
import {
  resolveActiveCaseActor,
  resolveActiveSessionActor,
} from "./actor-router";
import {
  prepareTransientEmailAssignment,
  settleTransientEmailAssignment,
} from "./case-walking-path";
import {
  emailTokenWindowTotals,
  releaseEmailReservation,
  reserveEmailTokens,
  settleAbandonedEmailReservation,
  settleEmailReservation,
  utcDayKey,
} from "./connector-email";
import {
  EVAL_RUN_TOKEN_BUDGET,
  EVAL_TASK_TOKEN_ALLOWANCE,
  evalRunTokensUsed,
  settleEvalTask,
  type ClaimedEvalTask,
  type SettledEvalTask,
} from "./connector-eval";
import { emailTurnDestinationMayReceive } from "./email-case-context-collection-evidence";
import {
  EMAIL_HARNESS_INSTRUCTIONS,
  emailReplyRequest,
} from "./email-case-processing";
import { MODEL_AUTHORITY_EXHAUSTED } from "./transient-turn";

/**
 * One task of an eval run: one scenario, under one configuration, on one
 * inference authority.
 *
 * The task is a mailbox reply turn on the scenario's synthetic message. It
 * runs as the mailbox agent the Eval tries, with that agent's instructions
 * and the Memory an ordinary turn for the same supplier would load, or with
 * the run's candidate revision in place of one accepted Memory. It has one
 * assignment on the run's Case and its own Session. Nothing is drafted or
 * sent: the agent's choice is scored and kept as the task's result.
 *
 * A task ends once. A turn that was interrupted after its assignment began
 * is not run again, because its first outcome is unknown: the task ends as
 * indeterminate.
 */

const TURN_MAX_WALL_MS = 5 * 60 * 1_000;
const MAX_REPLY_BODY_CHARS = 20_000;
/** How soon a task that waits on another turn or a lookup is tried again. */
const RETRY_DELAY_MS = 30_000;

type EvalTaskInput = Readonly<{
  scope: OrganisationExecutionScope;
  connectorSql: SqlStorage;
  organisationId: string;
  integrationAccountId: string;
  mailboxBindingId: string;
  bindingRevision: number;
  mailboxPolicyVersion: number;
  dailyTokenBudget: number;
  claim: ClaimedEvalTask;
  now: number;
}>;

/**
 * How one claim of a task ended. `settled` is recorded already. `deferred`
 * leaves the task claimed for another try, and names what it ends with if no
 * tries are left.
 */
export type EvalTaskEnd =
  | Readonly<{ kind: "settled"; outcome: EvalTaskOutcome }>
  | Readonly<{
      kind: "deferred";
      retryAt: number;
      exhausted: EvalTaskOutcome;
    }>
  /** The Connector stopped being the active instance. Nothing was changed. */
  | Readonly<{ kind: "inactive" }>;

type TaskRecord = Readonly<{
  execution: EvalTaskExecution | null;
  pins: EvalTaskPins | null;
  totalTokens: number | null;
  flowLabel: unknown;
}>;

const NO_RECORD: TaskRecord = {
  execution: null,
  pins: null,
  totalTokens: null,
  flowLabel: null,
};

export async function processEvalTask(
  env: Env,
  input: EvalTaskInput,
): Promise<EvalTaskEnd> {
  const { run, task } = input.claim;
  const sql = input.connectorSql;
  const key = `${run.runId.slice("evalrun_".length)}_${task.position}`;
  const organisationId = parseOrganisationId(input.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    input.integrationAccountId,
  );
  const caseId = parseCaseId(run.caseId);
  const sessionId = parseSessionId(`session_eval_${key}`);
  const assignmentId = parseAssignmentId(`assignment_eval_${key}`);
  const settle = (
    outcome: EvalTaskOutcome,
    record: TaskRecord = NO_RECORD,
  ): EvalTaskEnd => {
    const settled: SettledEvalTask = {
      result: {
        outcome,
        execution: record.execution,
        pins: record.pins,
        totalTokens: record.totalTokens,
      },
      flowLabel: record.flowLabel,
    };
    settleEvalTask(sql, { runId: run.runId, taskId: task.taskId, ...settled });
    return { kind: "settled", outcome };
  };
  const unavailable = (reason: EvalUnavailableReason) =>
    settle({ kind: "unavailable", reason });
  const failed = (code: string) =>
    settle({ kind: "failed", code: outcomeCode(code) });
  const defer = (exhausted: EvalTaskOutcome): EvalTaskEnd => ({
    kind: "deferred",
    retryAt: input.now + RETRY_DELAY_MS,
    exhausted,
  });
  const active = () => isActorExecutionActive(sql, input.scope);
  if (
    !organisationId.ok ||
    !integrationAccountId.ok ||
    !caseId.ok ||
    !sessionId.ok ||
    !assignmentId.ok ||
    organisationId.value !== input.scope.organisationId
  )
    return failed("eval_task_identity_invalid");
  const turnId = `turn_eval_${key}`;
  const inputId = `eval_${key}`;
  // A released reservation keeps its name, so each claim reserves under its own.
  const reservationName = (attempt: number) => `eval_${key}_a${attempt}`;
  const reservationId = reservationName(input.claim.attempt);
  const earlierReservations = Array.from(
    { length: input.claim.attempt - 1 },
    (_unused, index) => reservationName(index + 1),
  );
  const execution: EvalTaskExecution = {
    assignmentId: assignmentId.value,
    sessionId: sessionId.value,
    turnId,
  };
  if (!(await active())) return { kind: "inactive" };

  const workspace = await ensureOrganisationDefaultWorkspace({
    scope: input.scope,
    archive: env.ARCHIVE,
    now: input.now,
  });
  if (!workspace.ok)
    return defer({ kind: "failed", code: outcomeCode(workspace.error.code) });
  const placed = await ensureCaseProject({
    scope: input.scope,
    caseId: caseId.value,
    origin: "direct",
    now: input.now,
  });
  if (!placed.ok)
    return defer({ kind: "failed", code: outcomeCode(placed.error.code) });
  const [caseActor, session] = await Promise.all([
    resolveActiveCaseActor({
      env,
      namespace: env.CASE,
      organisationId: organisationId.value,
      caseId: caseId.value,
      now: input.now,
    }),
    resolveActiveSessionActor({
      env,
      namespace: env.SESSION,
      organisationId: organisationId.value,
      sessionId: sessionId.value,
      now: input.now,
    }),
  ]);
  if (!(await active())) return { kind: "inactive" };
  if (!caseActor.ok)
    return defer({ kind: "failed", code: outcomeCode(caseActor.error.code) });
  if (!session.ok)
    return defer({ kind: "failed", code: outcomeCode(session.error.code) });
  const ensured = await caseActor.value.ensure({
    identity: { organisationId: organisationId.value, caseId: caseId.value },
    purpose: `Eval run ${run.runId}`,
    workspaceRevision: workspace.value.revision,
    lifecycle: { kind: "open", openedAt: input.now },
  });
  if (!(await active())) return { kind: "inactive" };
  if (!ensured.ok)
    return defer({ kind: "failed", code: outcomeCode(ensured.error.code) });

  // An earlier claim of this task may have stopped with its turn. What it
  // left on the Case decides whether the task may still run.
  if (input.claim.attempt > 1) {
    const snapshot = await caseActor.value.inspect();
    if (!(await active())) return { kind: "inactive" };
    if (!snapshot.ok)
      return defer({ kind: "failed", code: outcomeCode(snapshot.error.code) });
    const earlier = snapshot.value.assignmentLifecycles.find(
      (lifecycle) => lifecycle.assignment.assignmentId === assignmentId.value,
    );
    if (earlier?.kind === "settled") {
      // Its turn ended and its result was not recorded here.
      for (const name of earlierReservations)
        settleAbandonedEmailReservation(sql, name);
      return settle(
        { kind: "indeterminate", code: "eval_result_lost" },
        { ...NO_RECORD, execution },
      );
    }
    if (earlier?.kind === "running") {
      const turns = await session.value.releaseStoppedTransientTurns({
        organisationId: organisationId.value,
        sessionId: sessionId.value,
      });
      if (!(await active())) return { kind: "inactive" };
      if (!turns.ok || turns.value.kind === "running")
        return defer({ kind: "indeterminate", code: "eval_turn_unresolved" });
      const abandoned = await settleTransientEmailAssignment({
        caseActor: caseActor.value,
        assignment: earlier.assignment,
        startId: earlier.start.startId,
        disposition: {
          kind: "failed",
          code: "eval_turn_interrupted",
          settledAt: Math.max(input.now, Number(earlier.start.acceptedAt)),
        },
      });
      if (!abandoned.ok)
        return defer({ kind: "indeterminate", code: "eval_turn_unresolved" });
      // The model may have been asked, and its usage was never reported.
      for (const name of earlierReservations)
        settleAbandonedEmailReservation(sql, name);
      return settle(
        { kind: "indeterminate", code: "eval_turn_interrupted" },
        { ...NO_RECORD, execution },
      );
    }
    // Nothing began under an earlier claim, so it asked the model nothing.
    for (const name of earlierReservations) releaseEmailReservation(sql, name);
  }

  const read = await readEvalRunFixture({
    env,
    execution: input.scope,
    organisationId: organisationId.value,
    eval: run.eval,
    scenarioId: task.scenarioId,
  });
  if (!(await active())) return { kind: "inactive" };
  if (read.kind === "unreadable")
    return defer({ kind: "unavailable", reason: "fixture_unavailable" });
  if (read.kind === "missing") return unavailable("fixture_unavailable");
  const fixture = read.fixture;
  if (fixture.subject.integrationAccountId !== input.integrationAccountId)
    return unavailable("fixture_unavailable");
  const { scenario } = fixture;
  // The scenario's sender is whoever its verification names today.
  const standing = await readContactVerificationStanding({
    db: input.scope.database,
    organisationId: organisationId.value,
    verificationId: scenario.sender.verificationId,
    expectedRevision: scenario.sender.revision,
  });
  if (!(await active())) return { kind: "inactive" };
  if (standing.kind === "unreadable")
    return defer({ kind: "unavailable", reason: "fixture_unavailable" });
  if (standing.kind !== "verified") return unavailable("fixture_unavailable");
  const verified = standing.endpoint;
  const { target, endpoint } = verified;
  if (
    verified.integrationAccountId !== integrationAccountId.value ||
    endpoint.channel !== "gmail" ||
    target.kind !== "supplier_contact"
  )
    return unavailable("fixture_unavailable");
  let supplier;
  try {
    supplier = parseEntityRef({
      origin: "custom",
      typeId: SUPPLIER_ENTITY_TYPE_ID,
      entityId: target.supplierId,
    });
  } catch {
    return unavailable("fixture_unavailable");
  }
  const recipient = await supplierReplyRecipient({
    ...verified,
    target,
    endpoint,
  });

  const configuration = run.configurations.find(
    (entry) => entry.kind === task.configuration,
  );
  if (configuration === undefined) return failed("eval_task_identity_invalid");

  // The task's tokens come from the run's budget and from the mailbox's own
  // daily budget, whichever has less left.
  const window = emailTokenWindowTotals(sql, utcDayKey(input.now));
  const allowance = Math.min(
    input.dailyTokenBudget - window.reserved - window.consumed,
    EVAL_RUN_TOKEN_BUDGET - evalRunTokensUsed(sql, run.runId),
    EVAL_TASK_TOKEN_ALLOWANCE,
  );
  if (allowance <= 0) return unavailable("budget_exhausted");

  const modelRoute = await resolveOrganisationModelRouteForSelection({
    env,
    scope: input.scope,
    now: input.now,
    selection: { kind: task.route },
  });
  if (!(await active())) return { kind: "inactive" };
  // The task is pinned to this authority. It never tries another one.
  if (!modelRoute.ok) return unavailable("authority_unavailable");
  const eligibility = await readGmailInferenceEligibility({
    db: input.scope.database,
    organisationId: organisationId.value,
    modelRoute: modelRoute.value,
    now: input.now,
  });
  if (!(await active())) return { kind: "inactive" };
  if (eligibility.kind === "blocked")
    return unavailable("authority_unavailable");
  const loaded = await loadOrganisationPolicyOrDefaultDeny({
    bindings: { db: input.scope.database, kv: env.POLICY_KV },
    organisationId: organisationId.value,
    now: input.now,
  });
  if (!(await active())) return { kind: "inactive" };
  const policy: PinnedSessionPolicy = {
    version: loaded.snapshot.version,
    egress: loaded.snapshot.egress,
    authz: loaded.snapshot.authz,
    conversationRisk: loaded.snapshot.conversationRisk,
    modelRoute: modelRoute.value,
  };

  const mailboxBinding = await readAgentMailboxBinding({
    db: input.scope.database,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
  });
  if (!(await active())) return { kind: "inactive" };
  if (
    !mailboxBinding.ok ||
    mailboxBinding.value.binding.mailboxBindingId !== input.mailboxBindingId ||
    mailboxBinding.value.currentRevision.revision !== input.bindingRevision
  )
    return unavailable("agent_unavailable");
  const agent = await resolveCaseTurnAgentProfile(input.scope, {
    caseId: caseId.value,
    assignmentId: assignmentId.value,
    // An eval task requires its agent, and the pin is recorded here, before
    // the Case holds the assignment.
    assignment: "new",
    selection: {
      kind: "installed",
      installationId: mailboxBinding.value.currentRevision.installationId,
    },
    now: input.now,
  });
  if (!(await active())) return { kind: "inactive" };
  if (agent.kind !== "resolved") return unavailable("agent_unavailable");

  const authority = buildAgentMailboxAuthority({
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    mailboxBindingId: input.mailboxBindingId,
    bindingRevision: input.bindingRevision,
    mailboxPolicyVersion: input.mailboxPolicyVersion,
  }).requestAuthority;
  const fixtureIds = await fixtureIdentity(key);
  // The objective is kept with the assignment, so it names records only.
  const objective =
    `Try eval scenario ${task.scenarioId} of ${run.eval.evalId} ` +
    `revision ${run.eval.revision} as message ${fixtureIds.messageId}.`;
  // The agent is asked what a turn for arrived mail is asked. Nothing that
  // it reads names the Eval, the scenario or the run.
  const turnPrompt = emailReplyRequest(fixtureIds.threadId, [
    fixtureIds.messageId,
  ]);
  // What became of the candidate Memory for this turn, when it applies.
  let candidateShown = "not_applicable" as
    "not_applicable" | "offered" | "excluded";
  const preparedContext = await prepareTurnContext({
    db: input.scope.database,
    accountAccess: input.scope.accountAccess,
    userAuthority: acceptedExecutionAccountAuthority(sessionId.value, assignmentId.value),
    action: "execute",
    organisationId: organisationId.value,
    caseId: caseId.value,
    assignmentId: assignmentId.value,
    sessionId: sessionId.value,
    requestAuthority: authority,
    policy,
    query: turnPrompt,
    now: input.now,
    tailReader: caseActor.value,
    replyRecipient: recipient,
    memoryDeadlineMs: BACKGROUND_MEMORY_DEADLINE_MS,
    memoryReader: createEvalTurnMemoryReader({
      env,
      execution: input.scope,
      organisationId: organisationId.value,
      onCandidateDecided: (offered) => {
        candidateShown = offered ? "offered" : "excluded";
      },
      subjects: {
        applicability: [
          ...agent.profile.skills.map((skill) => ({
            kind: "skill" as const,
            skillId: skill.skillId,
          })),
          {
            kind: "commerce_entity",
            merchantId: verified.merchantId,
            entity: supplier,
          },
        ],
      },
      // What a reply to this scenario's sender could carry, as in a turn
      // on real mail from that sender.
      destinationMayReceive: async (label) =>
        emailTurnDestinationMayReceive(
          input.scope.database,
          authority,
          { kind: "source_only" },
          label,
          recipient,
        ),
      now: input.now,
      candidate:
        configuration.kind === "candidate" ? configuration.memory : null,
    }),
  });
  if (!(await active())) return { kind: "inactive" };
  if (!preparedContext.ok)
    return defer({
      kind: "failed",
      code: outcomeCode(preparedContext.error.code),
    });
  const context = preparedContext.value.context;
  // The candidate applies to this scenario and this turn may not be shown
  // it, or a size limit left it out of the bundle. Either way the turn would
  // try some other configuration than the one the task names. Neither
  // changes on a later try, so the task ends now.
  if (
    configuration.kind === "candidate" &&
    (candidateShown === "excluded" ||
      (candidateShown === "offered" &&
        !(context.bundle.memory.revisions ?? []).some(
          (shown) =>
            shown.memoryId === configuration.memory.memoryId &&
            shown.revision === configuration.memory.revision,
        )))
  )
    return unavailable("memory_unavailable");
  // A Memory read that did not complete may complete on a later try.
  if (context.bundle.memory.kind === "unavailable")
    return defer({ kind: "unavailable", reason: "memory_unavailable" });

  const reserved = reserveEmailTokens(sql, {
    reservationId,
    utcDay: utcDayKey(input.now),
    tokens: allowance,
    limit: input.dailyTokenBudget,
    now: input.now,
  });
  if (reserved.kind === "exhausted") return unavailable("budget_exhausted");
  if (reserved.kind === "duplicate")
    return failed("eval_task_reservation_conflict");
  const prepared = await prepareTransientEmailAssignment({
    env,
    scope: input.scope,
    connectorSql: sql,
    projectContext: null,
    evidenceDependency: { kind: "source_only" },
    pinnedAgent: agent.profile,
    caseActor: caseActor.value,
    session: session.value,
    organisationId: organisationId.value,
    requestId: newRequestId(),
    sessionId: sessionId.value,
    caseId: caseId.value,
    inputId,
    assignmentId: assignmentId.value,
    purpose: `Eval run ${run.runId}`,
    objective,
    principal: { kind: "system", componentId: "eval_runner" },
    policy,
    workspaceRevisionReceipt: workspace.value,
    receivedAt: input.now,
    turnAuthority: preparedContext.value.turnAuthority,
    revalidateTurnAuthority: prepareTurnAuthority.bind(null, {
      db: input.scope.database,
      accountAccess: input.scope.accountAccess,
      userAuthority: acceptedExecutionAccountAuthority(sessionId.value, assignmentId.value),
      action: "execute",
      organisationId: organisationId.value,
      requestAuthority: authority,
      policy,
    }),
    context,
  });
  if (!prepared.ok) {
    releaseEmailReservation(sql, reservationId);
    if (prepared.error.kind === "placement_changed")
      return { kind: "inactive" };
    return defer({ kind: "failed", code: outcomeCode(prepared.error.code) });
  }
  const turnAllowance = Math.min(allowance, prepared.value.budget.maxTokens);
  const maxWallMs = Math.min(TURN_MAX_WALL_MS, prepared.value.budget.maxWallMs);
  const harnessInstructions = composeAgentInstructions(
    EMAIL_HARNESS_INSTRUCTIONS,
    agent.profile,
  );
  const message = fixtureMessage(
    fixtureIds,
    scenario.message,
    endpoint.address,
  );
  const turn = await session.value.runTransientEvalTurn({
    requestingOrganisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    turnId,
    inputId,
    caseId: caseId.value,
    assignmentId: assignmentId.value,
    caseRevision: prepared.value.assignment.caseRevision,
    contentDigest: context.bundleDigest,
    workspaceRevision: workspace.value.revision,
    contextBundleDigest: context.bundleDigest,
    context: {
      bundle: serializeContextBundle(context.bundle),
      bundleDigest: context.bundleDigest,
      modelContext: context.modelContext,
    },
    requestAuthority: authority,
    authorityPartitionDigest:
      prepared.value.assignment.authority.authorityPartitionDigest,
    harnessInstructions,
    turnPrompt,
    allowanceTokens: turnAllowance,
    maxWallMs,
    maxBodyChars: MAX_REPLY_BODY_CHARS,
    fixture: {
      evalId: run.eval.evalId,
      revision: run.eval.revision,
      scenarioId: task.scenarioId,
      inputLabel: canonicalFlowLabel(fixture.flowLabel),
      message,
    },
  });
  const settleAssignment = (
    disposition: Parameters<
      typeof settleTransientEmailAssignment
    >[0]["disposition"],
  ) =>
    settleTransientEmailAssignment({
      caseActor: caseActor.value,
      assignment: prepared.value.assignment,
      startId: prepared.value.startId,
      disposition,
    });
  // The task keeps the failure that it found. Each refusal that a Case gives
  // to a failed settlement is final, so no later try can settle it. The
  // refusal is traced, because the Case's record then differs from the task.
  const settleFailedAssignment = async (code: string): Promise<void> => {
    const settled = await settleAssignment({
      kind: "failed",
      code,
      settledAt: input.now + 1,
    });
    if (!settled.ok)
      traceWarn("connector.eval_assignment_settlement_refused", {
        requestId: newRequestId(),
        reason: settled.error.code,
      });
  };
  if (!turn.ok) {
    // A failed turn may name its cause. Only a cause in code form is kept.
    const cause =
      "detail" in turn.error &&
      typeof turn.error.detail === "string" &&
      /^[a-z0-9_:.-]{1,80}$/u.test(turn.error.detail)
        ? `:${turn.error.detail}`
        : "";
    const code = turn.error.code;
    // Only missing provider usage falls back to the whole reservation. A
    // turn that was refused before the model was asked reports zero.
    const totalTokens =
      turn.error.modelUsage === null
        ? turnAllowance
        : turn.error.modelUsage.totalTokens;
    settleEmailReservation(sql, { reservationId, actualTokens: totalTokens });
    await settleFailedAssignment(code);
    return settle(turnFailureOutcome(code, cause), {
      ...NO_RECORD,
      execution,
      totalTokens,
    });
  }
  const totalTokens = turn.value.modelUsage.totalTokens;
  settleEmailReservation(sql, { reservationId, actualTokens: totalTokens });
  const record: TaskRecord = {
    execution,
    pins: {
      model: modelRoute.value.model,
      modelRouteDigest: await digestModelRoute(modelRoute.value),
      instructionDigest: await digestCanonical({
        kind: "satyr_eval_instructions_v1",
        instructions: harnessInstructions,
        agent: {
          installationId: agent.profile.installationId,
          agentDefinitionId: agent.profile.agentDefinitionId,
          definitionRevision: agent.profile.definitionRevision,
        },
      }),
      toolCatalogDigest: turn.value.toolCatalogDigest,
      contextBundleDigest: context.bundleDigest,
      policyVersion: policy.version,
    },
    totalTokens,
    flowLabel: null,
  };
  const observed = observe(turn.value.outcome, turn.value.memory);
  // The criteria judge the whole reply. The result keeps a bounded part.
  const observation: EvalObservation | null =
    observed === null
      ? null
      : {
          ...observed,
          reply: observed.reply?.slice(0, MAX_EVAL_REPLY_LENGTH) ?? null,
        };
  const binding = await FlowBinding.restore(turn.value.flowBinding);
  if (observed === null || observation === null || !binding.ok) {
    const code =
      observation === null ? "eval_outcome_invalid" : "eval_flow_invalid";
    await settleFailedAssignment(code);
    return settle({ kind: "failed", code }, record);
  }
  const scored = scoreEvalScenario(scenario.criteria, observed);
  // The Case keeps what the task found as an accepted observation, under
  // the turn's own flow. The reply text stays with the result alone.
  const proposal: SessionProposal = {
    proposalId: `proposal_eval_${key}`,
    assignmentId: assignmentId.value,
    caseId: caseId.value,
    sessionId: sessionId.value,
    turnId,
    basedOnRevision: prepared.value.assignment.caseRevision,
    entries: [
      {
        kind: "observation",
        entryId: `entry_eval_${key}`,
        content: {
          kind: "text",
          text:
            `Eval task ${task.taskId}: outcome ${observation.outcome}, ` +
            `verdict ${scored.verdict} (` +
            scored.criteria
              .map(
                (criterion) =>
                  `${criterion.criterionId}=${criterion.met ? "met" : "not met"}`,
              )
              .join(", ") +
            ").",
        },
      },
    ],
    requestedEffects: [],
  };
  const accepted = await caseActor.value.acceptSessionProposal({
    proposal,
    requestAuthority: authority,
    acceptedAt: input.now + 1,
    flowBinding: turn.value.flowBinding,
  });
  if (!accepted.ok || accepted.value.disposition.kind !== "accepted") {
    const code = "eval_evidence_not_accepted";
    await settleFailedAssignment(code);
    return settle({ kind: "failed", code }, record);
  }
  const completed = await settleAssignment({
    kind: "completed",
    proposalId: proposal.proposalId,
    settledAt: input.now + 1,
  });
  if (!completed.ok)
    return settle(
      { kind: "failed", code: outcomeCode(completed.error.code) },
      record,
    );
  return settle(
    { kind: "assessed", ...scored, observation },
    {
      ...record,
      flowLabel: canonicalFlowLabel(binding.value.flowLabel),
    },
  );
}

/**
 * What the agent chose, with its whole reply. Null when it chose nothing a
 * reply turn offers.
 */
function observe(
  outcome: Readonly<{ kind: string; body?: string }>,
  memory: EvalObservation["memory"],
): EvalObservation | null {
  switch (outcome.kind) {
    case "reply_now":
    case "approval_required":
      return typeof outcome.body === "string" && outcome.body.trim().length > 0
        ? {
            outcome: outcome.kind,
            reply: outcome.body,
            memory,
          }
        : null;
    case "ignore":
      return { outcome: "no_reply", reply: null, memory };
    default:
      return null;
  }
}

/**
 * How a turn that did not complete ends its task. A missing authority and a
 * spent budget are reasons the task could not try the agent. Anything else
 * is an execution failure. None of them is a verdict.
 */
function turnFailureOutcome(code: string, cause: string): EvalTaskOutcome {
  // The provider refused the pinned credential because nothing is left on it.
  if (cause === `:${MODEL_AUTHORITY_EXHAUSTED}`)
    return { kind: "unavailable", reason: "authority_unavailable" };
  switch (code) {
    case "embedded_harness_model_authority_unavailable":
    case "gmail_inference_route_blocked":
      return { kind: "unavailable", reason: "authority_unavailable" };
    case "transient_email_token_budget_exhausted":
    case "goal_budget_exhausted":
      return { kind: "unavailable", reason: "budget_exhausted" };
    case "transient_eval_fixture_invalid":
    case "transient_eval_fixture_not_admitted":
      return { kind: "unavailable", reason: "fixture_unavailable" };
    default:
      return { kind: "failed", code: outcomeCode(`${code}${cause}`) };
  }
}

/** A code in the form a result keeps: lower case, bounded, no free text. */
function outcomeCode(code: string): string {
  const cleaned = code
    .toLowerCase()
    .replace(/[^a-z0-9_:.-]/gu, "_")
    .slice(0, 120);
  return cleaned.length === 0 ? "eval_task_failed" : cleaned;
}

type FixtureIdentity = Readonly<{ messageId: string; threadId: string }>;

/**
 * The identities of a task's message and its thread, in the form of a Gmail
 * identity: 16 hexadecimal characters. They are the same on each try of one
 * task, and they tell the agent nothing about the task.
 */
async function fixtureIdentity(key: string): Promise<FixtureIdentity> {
  const [messageId, threadId] = await Promise.all(
    (["message", "thread"] as const).map((part) =>
      digestCanonical({ kind: "satyr_eval_fixture_identity_v1", part, key }),
    ),
  );
  if (messageId === undefined || threadId === undefined)
    throw new Error("eval_fixture_identity_invalid");
  return {
    messageId: messageId.slice(0, 16),
    threadId: threadId.slice(0, 16),
  };
}

/** The scenario's message in the form the reply harness reads mail in. */
function fixtureMessage(
  identity: FixtureIdentity,
  message: Readonly<{
    subject: string;
    body: string;
    receivedAt: number;
    timezone: string;
  }>,
  address: string,
): GmailMessageContent {
  return {
    messageId: identity.messageId,
    threadId: identity.threadId,
    headers: {
      messageIdHeader: null,
      from: address,
      replyTo: null,
      subject: message.subject,
      references: null,
      date: localArrival(message.receivedAt, message.timezone),
    },
    bodyText: message.body,
    decodedBodyBytes: new TextEncoder().encode(message.body).byteLength,
    attachments: [],
  };
}

/** The arrival time as the sender's zone reads it, with the zone named. */
function localArrival(receivedAt: number, timezone: string): string {
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(receivedAt));
  return `${local} (${timezone})`;
}
