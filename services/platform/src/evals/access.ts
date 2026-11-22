import { parseEvalCommand, parseEvalRunCommand } from "@purin-labs/control-api";
import type {
  EvalCommandErrorCode,
  EvalCommandReceipt,
  EvalSenderChoice,
  EvalConfiguration,
  EvalContent,
  EvalRevisionView,
  EvalRunCommandReceipt,
  EvalRunResult,
  EvalRunView,
  EvalView,
  MemoryEvidence,
} from "@purin-labs/control-api";
import { assertNever, sameJson } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";

import {
  requireActiveOrganisationActorAtPlacement,
  resolveActiveConnectorActorAtPlacement,
} from "@purin-labs/actor-runtime/actors/actor-router";
import type { AuthorizedConversationScope as ConversationScope } from "@purin-labs/tenancy/organisation-access/access";
import { verifiedContacts } from "../mail-inbox/contract/verified-contacts";
import { gmailConnectorId } from "../mail-inbox/contract/connector-ids";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationActorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import {
  parseIntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  citedRecord,
  inspectableMemory,
  joinCitedEvidence,
  createReviewMemo,
  organisationActor,
  reviewTogether,
  type ReviewMemo,
  resolveMemoryViewer,
  viewerMayInspectRevisions,
  viewerMayRead,
  type MemoryAccessError,
  type MemoryViewer,
} from "../memory/access";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  canonicalFlowLabel,
  digestCanonical,
  FlowLabel,
  joinFlowLabels,
} from "../policy/information-flow";
import type { Result } from "@purin-labs/kernel/result";
import {
  restoreSerializedEval,
  restoreSerializedEvalRunResult,
  type Eval,
  type EvalRevision,
  type StoredEvalRunResult,
} from "./store";

export type EvalAccessError = Readonly<{
  code:
    | EvalCommandErrorCode
    /** A cited record has no recorded provenance this boundary can verify. */
    | "eval_evidence_unsupported";
}>;

/**
 * Every Eval this person may inspect in full. An Eval with any revision or
 * cited record hidden from them is absent, so the list's length, order and
 * head revisions reveal nothing about what was withheld.
 */
export async function readEvalViews(
  env: Env,
  scope: ConversationScope,
  execution?: OrganisationExecutionScope,
): Promise<Result<readonly EvalView[], EvalAccessError>> {
  const viewer = await resolveMemoryViewer(env, scope, execution);
  if (viewer === null) return failure("eval_unavailable");
  const organisation = await organisationActor(viewer);
  const stored = await organisation.readEvals({
    organisationId: scope.organisationId,
  });
  if (!stored.ok) return failure("eval_unavailable");
  const review = createReviewMemo();
  const views = await reviewTogether(stored.value, async (serialized) => {
    const restored = await restoreSerializedEval(
      scope.organisationId,
      serialized,
    );
    // A record that fails verification is withheld like a hidden one.
    return restored !== null &&
      (await viewerMayInspect(viewer, restored, review))
      ? evalView(restored)
      : null;
  });
  return { ok: true, value: views };
}

/**
 * How many Evals wait for this person's decision: those whose newest
 * revision is a candidate and that the person may inspect in full. It is a
 * count over the list that `readEvalViews` returns for the same person. Null
 * is a failed read, which decides nothing.
 */
export async function countEvalsToReview(
  viewer: MemoryViewer,
  organisation: OrganisationActorStub,
  review: ReviewMemo,
): Promise<number | null> {
  const stored = await organisation.readEvals({
    organisationId: viewer.scope.organisationId,
  });
  if (!stored.ok) return null;
  const waiting = await reviewTogether(stored.value, async (serialized) => {
    const restored = await restoreSerializedEval(
      viewer.scope.organisationId,
      serialized,
    );
    return restored !== null &&
      restored.revisions.at(-1)?.kind === "candidate" &&
      (await viewerMayInspect(viewer, restored, review))
      ? restored.evalId
      : null;
  });
  return waiting.length;
}

/**
 * The verified contacts that a person can name as the sender of a scenario
 * of one Eval: the contacts whose verification stands now for the mailbox
 * that the Eval tries.
 *
 * A contact's address is source-derived content of that mailbox. It is
 * released only to a person who may inspect the Eval in full. For an Eval of
 * a mailbox that is decided on the reply review surface of the corrections
 * it cites, under the reply review authorization of that mailbox. An Eval
 * that does not exist and one with anything hidden answer the same.
 */
export async function readEvalSenderChoices(
  env: Env,
  scope: ConversationScope,
  evalId: string,
): Promise<Result<readonly EvalSenderChoice[], EvalAccessError>> {
  const inspected = await readInspectableEval(env, scope, evalId);
  const subject = inspected?.stored.revisions.at(-1)?.subject;
  if (inspected === null || subject === undefined)
    return failure("eval_unavailable");
  const account = parseIntegrationAccountId(subject.integrationAccountId);
  if (!account.ok) return failure("eval_unavailable");
  const contacts = await verifiedContacts.use().listVerifiedContactEndpoints({
    db: inspected.viewer.execution.database,
    organisationId: scope.organisationId,
    integrationAccountId: account.value,
  });
  if (contacts === null) return failure("eval_unavailable");
  return {
    ok: true,
    value: contacts.flatMap((contact) =>
      contact.endpoint.channel === "gmail"
        ? [
            {
              verificationId: contact.verificationId,
              revision: contact.revision,
              address: contact.endpoint.address,
            },
          ]
        : [],
    ),
  };
}

/**
 * Applies one command for the signed-in person. The request supplies only the
 * command: the principal comes from the live session, and a revision's label
 * is the label of the revision it inherits from, joined with every record it
 * newly cites.
 */
export async function commandEvalAsOperator(
  env: Env,
  scope: ConversationScope,
  body: unknown,
): Promise<Result<EvalCommandReceipt, EvalAccessError>> {
  const command = parseEvalCommand(body);
  if (command === null) return failure("eval_invalid");
  const viewer = await resolveMemoryViewer(env, scope);
  if (viewer === null) return failure("eval_unavailable");
  const organisation = await organisationActor(viewer);
  // A person changes only an Eval they may inspect in full, so a command
  // cannot confirm that a hidden one exists.
  const stored = await inspectableEval(viewer, organisation, command.evalId);
  if (stored === null) return failure("eval_unavailable");
  let flowLabel: FlowLabel | null = null;
  if (command.kind === "revise") {
    const joined = await revisionLabel(viewer, stored, command.content);
    if (!joined.ok) return joined;
    flowLabel = joined.value;
  }
  const result = await organisation.commandEval({
    organisationId: scope.organisationId,
    principal: {
      kind: "operator",
      personId: viewer.authority.requesterPersonId,
    },
    body: command,
    flowLabel: flowLabel === null ? null : canonicalFlowLabel(flowLabel),
  });
  if (result.ok) return result;
  // An Actor placement or initialization failure says nothing about an Eval.
  return failure(
    isEvalCommandErrorCode(result.error.code)
      ? result.error.code
      : "eval_unavailable",
  );
}

/**
 * Pantry's candidate Eval from one reviewed reply correction.
 *
 * The label joins what the learning turn observed with the correction's own
 * label, so the candidate carries every source the corrected draft drew on.
 * The command identity is derived from the exact correction, so a repeated
 * run proposes nothing new: the same content returns the first receipt, and
 * different content is refused and the first candidate stands. An agent
 * cannot revise or decide an Eval.
 */
export async function proposeEvalFromCorrection(
  input: Readonly<{
    env: Env;
    execution: OrganisationExecutionScope;
    organisationId: OrganisationId;
    agent: Readonly<{
      caseId: string;
      assignmentId: string;
      sessionId: string;
    }>;
    correction: Variant<MemoryEvidence, "proposal_correction">;
    turnLabel: FlowLabel;
    title: string;
    scenario: EvalContent["scenarios"][number];
  }>,
): Promise<
  Result<
    Readonly<{
      kind: "proposed" | "already_proposed";
      evalId: string;
      revision: number;
    }>,
    Readonly<{ code: "eval_evidence_unavailable" | "eval_unavailable" }>
  >
> {
  const cited = await citedRecord(input, input.correction);
  if (!cited.ok)
    return {
      ok: false,
      error: {
        code:
          cited.error.code === "unreadable"
            ? "eval_unavailable"
            : "eval_evidence_unavailable",
      },
    };
  const label = await joinFlowLabels(input.turnLabel, cited.value.label);
  if (!label.ok) return { ok: false, error: { code: "eval_unavailable" } };
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env: input.env,
    organisationId: input.organisationId,
    placement: input.execution.placement,
    now: Date.now(),
  });
  const commandId = `eval_correction_${await digestCanonical({
    integrationAccountId: input.correction.integrationAccountId,
    proposalId: input.correction.proposalId,
    version: input.correction.version,
    digest: input.correction.digest,
  })}`;
  const proposed = await organisation.commandEval({
    organisationId: input.organisationId,
    principal: { kind: "agent", ...input.agent },
    body: {
      commandId,
      content: {
        title: input.title,
        subject: {
          kind: "mailbox_reply",
          integrationAccountId: input.correction.integrationAccountId,
        },
        scenarios: [input.scenario],
        evidence: [input.correction],
        sourceCaseId: input.correction.caseId,
      } satisfies EvalContent,
    },
    flowLabel: canonicalFlowLabel(label.value),
  });
  if (proposed.ok)
    return {
      ok: true,
      value: {
        kind: "proposed",
        evalId: proposed.value.evalId,
        revision: proposed.value.revision,
      },
    };
  if (proposed.error.code !== "eval_command_conflict")
    return { ok: false, error: { code: "eval_unavailable" } };
  // An earlier run proposed another scenario. That candidate stands.
  const first = await organisation.readEvalCommandReceipt({
    organisationId: input.organisationId,
    commandId,
  });
  return first.ok && first.value !== null
    ? {
        ok: true,
        value: {
          kind: "already_proposed",
          evalId: first.value.evalId,
          revision: first.value.revision,
        },
      }
    : { ok: false, error: { code: "eval_unavailable" } };
}

/**
 * Starts or cancels one run for the signed-in person. A run tries the
 * accepted revision of an Eval they may inspect in full. A candidate
 * configuration names a Memory candidate they may inspect in full. The run
 * belongs to the mailbox agent the Eval tries, and that mailbox's Connector
 * holds it while it is in progress.
 */
export async function commandEvalRunAsOperator(
  env: Env,
  scope: ConversationScope,
  body: unknown,
): Promise<Result<EvalRunCommandReceipt, EvalAccessError>> {
  const command = parseEvalRunCommand(body);
  if (command === null) return failure("eval_invalid");
  const viewer = await resolveMemoryViewer(env, scope);
  if (viewer === null) return failure("eval_unavailable");
  const organisation = await organisationActor(viewer);
  const stored = await inspectableEval(
    viewer,
    organisation,
    command.kind === "start" ? command.eval.evalId : command.evalId,
  );
  const subject = stored?.revisions.at(-1)?.subject;
  if (stored === null || subject === undefined)
    return failure("eval_unavailable");
  const connector = await subjectConnector(viewer, subject);
  if (connector === null) return failure("eval_unavailable");
  if (command.kind === "cancel") {
    const cancelled = await connector.actor.cancelEvalRun({
      identity: connector.identity,
      now: Date.now(),
      evalId: command.evalId,
      runId: command.runId,
    });
    return cancelled.ok && cancelled.value !== null
      ? {
          ok: true,
          value: { commandId: command.commandId, ...cancelled.value },
        }
      : failure("eval_unavailable");
  }
  const requestDigest = await digestCanonical({
    personId: viewer.authority.requesterPersonId,
    command,
  });
  // A command sent again gets its first answer. The present state is checked
  // for a new command only: the Eval or the candidate may have been decided
  // since the run began.
  const earlier = await connector.actor.readEvalRunCommand({
    identity: connector.identity,
    now: Date.now(),
    commandId: command.commandId,
    requestDigest,
  });
  if (!earlier.ok)
    return failure(
      isEvalCommandErrorCode(earlier.error.code)
        ? earlier.error.code
        : "eval_unavailable",
    );
  if (earlier.value !== null)
    return {
      ok: true,
      value: { commandId: command.commandId, ...earlier.value },
    };
  const revision = stored.revisions.find(
    (entry) => entry.revision === command.eval.revision,
  );
  // A run tries reviewed behaviour, which is the accepted revision.
  if (revision === undefined || revision.kind !== "accepted")
    return failure("eval_conflict");
  for (const configuration of command.configurations) {
    if (configuration.kind !== "candidate") continue;
    const memory = await inspectableMemory(
      viewer,
      organisation,
      configuration.memory.memoryId,
    );
    if (memory === null) return failure("eval_unavailable");
    const candidate = memory.revisions.find(
      (entry) => entry.revision === configuration.memory.revision,
    );
    if (candidate?.kind !== "candidate") return failure("eval_conflict");
  }
  const key = crypto.randomUUID().replaceAll("-", "");
  const started = await connector.actor.startEvalRun({
    identity: connector.identity,
    now: Date.now(),
    runId: `evalrun_${key}`,
    caseId: `case_eval_${key}`,
    commandId: command.commandId,
    requestDigest,
    eval: command.eval,
    scenarioIds: revision.scenarios.map((scenario) => scenario.scenarioId),
    routes: command.routes,
    configurations: command.configurations,
    startedByPersonId: viewer.authority.requesterPersonId,
  });
  if (started.ok)
    return {
      ok: true,
      value: { commandId: command.commandId, ...started.value },
    };
  return failure(
    isEvalCommandErrorCode(started.error.code)
      ? started.error.code
      : "eval_unavailable",
  );
}

/**
 * The runs of one Eval this person may read: those in progress, which show
 * no result, and then the settled ones, newest first. A settled run is
 * released only when the person may inspect the Eval in full, may inspect
 * every Memory a task was shown, and may read the run's own label. A run
 * with anything hidden from them is absent.
 */
export async function readEvalRunViews(
  env: Env,
  scope: ConversationScope,
  evalId: string,
): Promise<Result<readonly EvalRunView[], EvalAccessError>> {
  const viewer = await resolveMemoryViewer(env, scope);
  if (viewer === null) return failure("eval_unavailable");
  const organisation = await organisationActor(viewer);
  const stored = await inspectableEval(viewer, organisation, evalId);
  const subject = stored?.revisions.at(-1)?.subject;
  if (stored === null || subject === undefined)
    return failure("eval_unavailable");
  const runs: EvalRunView[] = [];
  const connector = await subjectConnector(viewer, subject);
  if (connector !== null) {
    const progress = await connector.actor.readEvalRunProgress({
      identity: connector.identity,
      now: Date.now(),
      evalId,
    });
    // A run names the candidate Memory it tries. A person who may not
    // inspect that Memory does not learn of the run.
    if (progress.ok)
      for (const run of progress.value.toReversed())
        if (
          await viewerMayInspectConfigurations(
            viewer,
            organisation,
            run.configurations,
          )
        )
          runs.push(run);
  }
  const results = await organisation.readEvalRunResults({
    organisationId: scope.organisationId,
    evalId,
  });
  if (!results.ok) return failure("eval_unavailable");
  for (const raw of results.value) {
    const settled = await restoreSerializedEvalRunResult(raw);
    // A result that fails verification is withheld like a hidden one.
    if (
      settled !== null &&
      (await viewerMayInspectConfigurations(
        viewer,
        organisation,
        settled.result.configurations,
      )) &&
      (await viewerMayReadRun(viewer, organisation, settled))
    )
      runs.push(settled.result);
  }
  return { ok: true, value: runs };
}

/** True when this person may inspect each candidate Memory a run tries. */
async function viewerMayInspectConfigurations(
  viewer: MemoryViewer,
  organisation: Awaited<ReturnType<typeof organisationActor>>,
  configurations: readonly EvalConfiguration[],
): Promise<boolean> {
  for (const configuration of configurations) {
    if (configuration.kind !== "candidate") continue;
    const memory = await inspectableMemory(
      viewer,
      organisation,
      configuration.memory.memoryId,
    );
    if (memory === null) return false;
  }
  return true;
}

async function viewerMayReadRun(
  viewer: MemoryViewer,
  organisation: Awaited<ReturnType<typeof organisationActor>>,
  settled: StoredEvalRunResult,
): Promise<boolean> {
  // Each Memory the run showed must stay one this person may inspect.
  const shown = new Set<string>();
  for (const task of settled.result.tasks) {
    if (task.outcome.kind !== "assessed") continue;
    for (const ref of task.outcome.observation.memory) shown.add(ref.memoryId);
  }
  for (const memoryId of shown)
    if ((await inspectableMemory(viewer, organisation, memoryId)) === null)
      return false;
  return viewerMayRead(viewer, settled.flowLabel);
}

/** The Connector of the mailbox agent an Eval tries, or null. */
async function subjectConnector(
  viewer: MemoryViewer,
  subject: EvalContent["subject"],
) {
  const account = parseIntegrationAccountId(subject.integrationAccountId);
  const connectorId = account.ok ? gmailConnectorId(account.value) : account;
  if (!connectorId.ok) return null;
  const actor = await resolveActiveConnectorActorAtPlacement({
    env: viewer.env,
    namespace: viewer.env.CONNECTOR,
    organisationId: viewer.organisationId,
    connectorId: connectorId.value,
    placement: viewer.execution.placement,
    now: Date.now(),
  });
  return actor.ok
    ? {
        actor: actor.value,
        identity: {
          organisationId: viewer.organisationId,
          connectorId: connectorId.value,
        },
      }
    : null;
}

/**
 * Publishes one settled run to the OrganisationActor. Its label joins the
 * label of the Eval revision it tried with the label of each task's turn, so
 * the result carries every source any task observed.
 *
 * `refused` is a known fact: the revision is gone, or another result stands
 * under the run's identity. `unavailable` is a failed step that may be tried
 * again with the same result.
 */
export async function publishEvalRunResult(
  input: Readonly<{
    env: Env;
    execution: OrganisationExecutionScope;
    organisationId: OrganisationId;
    result: EvalRunResult;
    flowLabels: readonly unknown[];
  }>,
): Promise<"published" | "refused" | "unavailable"> {
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env: input.env,
    organisationId: input.organisationId,
    placement: input.execution.placement,
    now: Date.now(),
  });
  const stored = await organisation.readEval({
    organisationId: input.organisationId,
    evalId: input.result.eval.evalId,
  });
  if (!stored.ok) return "unavailable";
  const restored =
    stored.value === null
      ? null
      : await restoreSerializedEval(input.organisationId, stored.value);
  const revision = restored?.revisions.find(
    (entry) => entry.revision === input.result.eval.revision,
  );
  if (stored.value !== null && restored === null) return "unavailable";
  if (revision === undefined) return "refused";
  let joined = revision.flowLabel;
  for (const raw of input.flowLabels) {
    const label = await FlowLabel.restore(raw);
    const next = label.ok ? await joinFlowLabels(joined, label.value) : label;
    if (!next.ok) return "refused";
    joined = next.value;
  }
  const settled = await organisation.settleEvalRun({
    organisationId: input.organisationId,
    result: input.result,
    flowLabel: canonicalFlowLabel(joined),
  });
  if (settled.ok) return "published";
  return settled.error.code === "eval_conflict" ||
    settled.error.code === "eval_invalid" ||
    settled.error.code === "eval_unavailable"
    ? "refused"
    : "unavailable";
}

/** One scenario of one Eval revision as a run reads it, with its label. */
type EvalRunFixture = Readonly<{
  subject: EvalContent["subject"];
  scenario: EvalContent["scenarios"][number];
  flowLabel: FlowLabel;
}>;

/**
 * The scenario one eval task tries, read for the run itself. The run names
 * an exact revision, so the scenario and its label are what was reviewed.
 * `missing` is a known fact: there is no such revision or scenario.
 * `unreadable` is a failed lookup, which establishes nothing.
 */
export async function readEvalRunFixture(
  input: Readonly<{
    env: Env;
    execution: OrganisationExecutionScope;
    organisationId: OrganisationId;
    eval: Readonly<{ evalId: string; revision: number }>;
    scenarioId: string;
  }>,
): Promise<
  | Readonly<{ kind: "read"; fixture: EvalRunFixture }>
  | Readonly<{ kind: "missing"; fixture?: never }>
  | Readonly<{ kind: "unreadable"; fixture?: never }>
> {
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env: input.env,
    organisationId: input.organisationId,
    placement: input.execution.placement,
    now: Date.now(),
  });
  const stored = await organisation.readEval({
    organisationId: input.organisationId,
    evalId: input.eval.evalId,
  });
  if (!stored.ok) return { kind: "unreadable" };
  if (stored.value === null) return { kind: "missing" };
  const restored = await restoreSerializedEval(
    input.organisationId,
    stored.value,
  );
  if (restored === null) return { kind: "unreadable" };
  const revision = restored.revisions.find(
    (entry) => entry.revision === input.eval.revision,
  );
  const scenario = revision?.scenarios.find(
    (entry) => entry.scenarioId === input.scenarioId,
  );
  return revision === undefined || scenario === undefined
    ? { kind: "missing" }
    : {
        kind: "read",
        fixture: {
          subject: revision.subject,
          scenario,
          flowLabel: revision.flowLabel,
        },
      };
}

/**
 * The Eval a person may inspect in full, or null. Null covers an Eval that
 * does not exist and one with anything hidden from them.
 */
async function readInspectableEval(
  env: Env,
  scope: ConversationScope,
  evalId: string,
): Promise<Readonly<{ viewer: MemoryViewer; stored: Eval }> | null> {
  const viewer = await resolveMemoryViewer(env, scope);
  if (viewer === null) return null;
  const stored = await inspectableEval(
    viewer,
    await organisationActor(viewer),
    evalId,
  );
  return stored === null ? null : { viewer, stored };
}

async function inspectableEval(
  viewer: MemoryViewer,
  organisation: Awaited<ReturnType<typeof organisationActor>>,
  evalId: string,
): Promise<Eval | null> {
  const stored = await organisation.readEval({
    organisationId: viewer.scope.organisationId,
    evalId,
  });
  if (!stored.ok || stored.value === null) return null;
  const restored = await restoreSerializedEval(
    viewer.scope.organisationId,
    stored.value,
  );
  return restored !== null && (await viewerMayInspect(viewer, restored))
    ? restored
    : null;
}

function viewerMayInspect(
  viewer: MemoryViewer,
  stored: Eval,
  review?: ReviewMemo,
): Promise<boolean> {
  return viewerMayInspectRevisions(
    viewer,
    stored.revisions.map((revision) => ({
      flowLabel: revision.flowLabel,
      evidence: revision.evidence,
      dependsOn: [],
    })),
    review,
  );
}

/**
 * The label of a person's revision. Their words go to the audience of the
 * revision they edit: the candidate under review, or the accepted revision
 * they propose to replace. Every restriction it carries stays, and each
 * record the revision newly cites adds its own.
 */
async function revisionLabel(
  viewer: MemoryViewer,
  stored: Eval,
  content: EvalContent,
): Promise<Result<FlowLabel, EvalAccessError>> {
  const head = stored.revisions.at(-1);
  if (head === undefined) return failure("eval_invalid");
  const inherited =
    head.kind === "candidate"
      ? head
      : stored.revisions.find((revision) => revision.kind === "accepted");
  if (inherited === undefined) return failure("eval_conflict");
  // A revision tries the same agent from the same origin as the one it edits.
  if (
    !sameJson(content.subject, inherited.subject) ||
    content.sourceCaseId !== inherited.sourceCaseId
  )
    return failure("eval_invalid");
  const joined = await joinCitedEvidence(
    viewer,
    inherited.flowLabel,
    content.evidence,
  );
  return joined.ok ? joined : failure(evalErrorCode(joined.error.code));
}

function evalErrorCode(
  code: MemoryAccessError["code"],
): EvalAccessError["code"] {
  switch (code) {
    case "memory_invalid":
      return "eval_invalid";
    case "memory_evidence_unsupported":
      return "eval_evidence_unsupported";
    case "memory_unavailable":
    case "memory_conflict":
    case "memory_command_conflict":
    case "memory_reviewer_required":
    case "memory_capacity_exceeded":
      return "eval_unavailable";
    default:
      return assertNever(code);
  }
}

function isEvalCommandErrorCode(code: string): code is EvalCommandErrorCode {
  return (
    code === "eval_invalid" ||
    code === "eval_unavailable" ||
    code === "eval_conflict" ||
    code === "eval_command_conflict" ||
    code === "eval_reviewer_required" ||
    code === "eval_capacity_exceeded"
  );
}

function evalView(stored: Eval): EvalView {
  return {
    evalId: stored.evalId,
    headRevision: stored.headRevision,
    revisions: stored.revisions.map(revisionView),
  };
}

// Labels stay on the server; a viewer receives the reviewed content only.
function revisionView(revision: EvalRevision): EvalRevisionView {
  const { flowLabel: _flowLabel, ...view } = revision;
  return view;
}

function failure(
  code: EvalAccessError["code"],
): Result<never, EvalAccessError> {
  return { ok: false, error: { code } };
}
