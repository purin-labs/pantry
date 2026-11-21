import { runtimeFetch } from "../../runtime-fetch";
import { createTransientGoalExecution } from "../session-goal-usage";
import type { HarnessToolHost } from "../embedded-harness";
import {
  parseMailAssistantResult,
  type MailAssistantResult,
} from "@purin-labs/control-api";
import { authorizeMailAssistant } from "../../mail-inbox/assistant-eligibility";
import {
  decideAutomaticContextAdmission,
  FlowLabel as StoredFlowLabel,
} from "../../policy/information-flow";
import { recordTransientTurnContext } from "../actor-journal/transactions";
import { runTaskBeforeDeadline } from "@purin-labs/async-control/deadline";
import type {
  AcceptedInputRef,
  SessionIdentity,
  SessionContract,
  HarnessTurnLease,
} from "@purin-labs/contracts";
import { parseSessionId, newRequestId } from "../../ids";
import { traceWarn } from "../../observability";
import type { Result } from "../../result";
import {
  SessionExecutionAdmission,
  admittedSessionModelRoute,
  admittedSessionToolHost,
} from "../session-execution-admission";
import { readCanonicalSessionForPersistence } from "../agent-session-canonical";
import { readCaseSessionAssignment } from "../actor-journal/transactions";
import { restoreSessionTurnContext } from "../actor-journal";
import { renderModelContext } from "../model-context-prompt";
import { digestModelRoute } from "../../models/route";
import type { EmbeddedHarnessModelUsage } from "../embedded-harness";
import { createEmailHarnessToolHost } from "../email-harness-tools";
import { verifyTransientReplySources } from "../email-reply-source-verification";
import { NO_REPLY_SOURCES } from "../../mail-inbox/reply-sources";
import { EmailTurnInformationFlow } from "../email-case-context-collection-evidence";
import {
  parseCaseContextCollectionEvidenceDependency,
  caseContextCollectionEvidenceDependency,
} from "../../case-context-discovery/evidence";
import { readGmailInferenceEligibility } from "../../mail-inbox/contract/gmail-inference-eligibility";
import { runTransientTurn } from "../transient-turn";
import { createWhatsAppHarnessToolHost } from "../whatsapp-harness-tools";
import { selectEmbeddedHarnessAdapterForModelRoute } from "../embedded-harness-adapter";
import { authorityPartitionKeyMatchesRequest } from "../../authorization/access-grants/turn-authority";
import { ObservationEvidence } from "../../policy";
import { digestCanonical } from "../../policy";
import { memoryModelContext } from "../session/model-context";
import { createEmbeddedHarnessModelRouteLease } from "../session/model-route";
import { type TransientSessionExecution } from "../session/support";
import {
  KNOWN_ZERO_MODEL_USAGE,
  runTransientMailHarness,
  transientModelAdmissionError,
} from "../session/transient-turns";
import {
  admitTransientHarnessTurn,
  boundRecipients,
  isTransientHarnessOpen,
  settleTransientHarnessTurn,
  startNoTransientTeardown,
  transientPlacementFailure,
  transientResultModelUsage,
} from "../session/turn-completion";
import type { TransientModelTurnError } from "../session/types";
import type { SessionTransientHost } from "../session/transient-host";
import {
  TRANSIENT_EMAIL_PROMPT_BYTES,
  completeTransientWhatsAppTurn,
  reauthorizeTransientEmail,
  reauthorizeTransientMailAssistant,
  rejectMailAssistantTool,
  startTransientWhatsAppSessionLifecycle,
} from "./support";
import {
  type TransientEmailTurnReply,
  type TransientEmailTurnRequest,
  type TransientEvalTurnReply,
  type TransientEvalTurnRequest,
  type TransientMailAssistantRequest,
  type TransientWhatsAppTurnReply,
  type TransientWhatsAppTurnRequest,
  type TransientWhatsAppTurnResult,
} from "./rpc";

/**
 * The transient turns of the Inbox: a mailbox turn, an eval turn, a mail
 * assistant turn and a WhatsApp turn. They keep no Session history. The
 * Session gives each one a host, and the class of the Worker gives each one
 * its RPC method.
 */
export async function prepareTransientEmailTurn(
  host: SessionTransientHost,
  input: TransientEmailTurnRequest,
  transient: TransientSessionExecution,
): Promise<Result<TransientEmailTurnReply, TransientModelTurnError>> {
  const execution = await SessionExecutionAdmission.resolve(
    host.env,
    host.ctx.storage,
    input.requestingOrganisationId,
  );
  if (execution === null || !(await execution.isActive()))
    return {
      ok: false,
      error: transientModelAdmissionError(
        new Error("session_placement_conflict"),
      ),
    };
  const session = await readCanonicalSessionForPersistence(
    host.persistence,
    host.ctx.storage.sql,
    input.requestingOrganisationId,
  );
  if (!session.ok)
    return {
      ok: false,
      error: { code: session.error.code, modelUsage: null },
    };
  const lifecycle = session.value.lifecycle;
  if (lifecycle.kind !== "sleeping" && lifecycle.kind !== "processing") {
    return {
      ok: false,
      error: {
        code: "transient_email_session_unavailable",
        modelUsage: null,
      },
    };
  }
  const identity = lifecycle.state.identity;
  const contract = lifecycle.state.contract;
  const parsedSessionId = parseSessionId(identity.sessionId);
  if (!parsedSessionId.ok) {
    return {
      ok: false,
      error: {
        code: "transient_email_session_identity_invalid",
        modelUsage: null,
      },
    };
  }
  const eligibility = await readGmailInferenceEligibility({
    db: execution.scope.database,
    organisationId: input.requestingOrganisationId,
    modelRoute: contract.modelRoute,
    now: Date.now(),
  });
  if (eligibility.kind === "blocked") {
    return {
      ok: false,
      error: { code: "gmail_inference_route_blocked", modelUsage: null },
    };
  }
  if (input.requestAuthority.kind !== "agent_mailbox")
    return {
      ok: false,
      error: { code: "transient_email_authority_invalid", modelUsage: null },
    };
  const evidenceDependency = parseCaseContextCollectionEvidenceDependency(
    input.evidenceDependency,
  );
  if (evidenceDependency === null)
    return {
      ok: false,
      error: {
        code: "case_context_collection_evidence_invalid",
        modelUsage: null,
      },
    };
  const assignment = readCaseSessionAssignment(host.ctx.storage.sql);
  if (
    assignment === null ||
    assignment.caseId !== input.caseId ||
    assignment.assignmentId !== input.assignmentId ||
    assignment.sessionId !== parsedSessionId.value ||
    assignment.caseRevision !== input.caseRevision ||
    assignment.authorityPartition.digest !== input.authorityPartitionDigest ||
    input.requestAuthority.organisationId !== input.requestingOrganisationId ||
    !authorityPartitionKeyMatchesRequest(
      assignment.authorityPartition.key,
      input.requestAuthority,
    ) ||
    input.manifest.integrationAccountId !==
      input.requestAuthority.integrationAccountId ||
    JSON.stringify(assignment.context.evidenceDependency) !==
      JSON.stringify(
        await caseContextCollectionEvidenceDependency(evidenceDependency),
      )
  )
    return {
      ok: false,
      error: { code: "transient_email_assignment_changed", modelUsage: null },
    };
  const informationFlow = await EmailTurnInformationFlow.create({
    env: host.env,
    authority: input.requestAuthority,
    caseId: input.caseId,
    dependency: evidenceDependency,
    sessionId: parsedSessionId.value,
    turnId: input.turnId,
    authorityPartitionDigest: input.authorityPartitionDigest,
  });
  if (!informationFlow.ok)
    return {
      ok: false,
      error: { code: informationFlow.error.code, modelUsage: null },
    };

  const context = await restoreSessionTurnContext(input.context);
  if (
    context === null ||
    context.bundleDigest !== input.contextBundleDigest ||
    context.bundle.organisationId !== input.requestingOrganisationId ||
    context.bundle.caseId !== input.caseId ||
    context.bundle.assignmentId !== input.assignmentId ||
    context.bundle.sessionId !== parsedSessionId.value
  )
    return {
      ok: false,
      error: { code: "transient_email_context_invalid", modelUsage: null },
    };
  // A mailbox turn reads its thread through tools. Of its assembled
  // context it is shown accepted Memory, ahead of the request.
  const rendered = renderModelContext(
    memoryModelContext(context.modelContext),
    input.turnPrompt,
    TRANSIENT_EMAIL_PROMPT_BYTES,
    { memoryReferences: true },
  );
  // What the model is about to receive is recorded before it is asked.
  // Each attempt keeps its own record; an earlier one is never replaced.
  const recorded = recordTransientTurnContext(host.ctx.storage.sql, {
    turnId: input.turnId,
    organisationId: input.requestingOrganisationId,
    sessionId: parsedSessionId.value,
    context,
    memoryRendering: {
      revisions: rendered.memory,
      omittedForBytes: rendered.memoryOmittedForBytes,
    },
  });
  if (!recorded.ok)
    return {
      ok: false,
      error: { code: "transient_email_context_conflict", modelUsage: null },
    };
  for (const item of context.bundle.items) {
    const source = item.source;
    if (
      source.kind !== "memory" ||
      !rendered.memory.some(
        (ref) =>
          ref.memoryId === source.memoryId && ref.revision === source.revision,
      )
    )
      continue;
    const observed = await informationFlow.value.observeMemory(
      item.observationEvidence,
      item.inputLabel,
    );
    if (!observed.ok)
      return {
        ok: false,
        error: { code: observed.error.code, modelUsage: null },
      };
  }
  if (!(await execution.isActive())) return transientPlacementFailure(null);

  const toolHost = await createEmailHarnessToolHost({
    env: host.env,
    organisationId: input.requestingOrganisationId,
    manifest: input.manifest,
    responsePolicy: input.responsePolicy,
    authority: input.requestAuthority,
    caseId: input.caseId,
    now: Date.now,
    fetcher: runtimeFetch,
    informationFlow: informationFlow.value,
  });
  const result = await runTransientMailHarness(
    execution,
    transient,
    {
      env: host.env,
      storage: host.ctx.storage,
      liveRuns: host.liveGoalRuns,
    },
    identity,
    contract,
    { ...input, turnPrompt: rendered.text },
    toolHost,
    host.toolRules,
    reauthorizeTransientEmail.bind(
      null,
      execution.scope,
      input.requestingOrganisationId,
      contract.modelRoute,
    ),
  );
  if (!(await execution.isActive()))
    return transientPlacementFailure(transientResultModelUsage(result));
  if (!result.ok) return result;
  const outcome = toolHost.outcome();
  if (outcome.kind === "none") {
    return {
      ok: false,
      error: {
        code: "transient_email_outcome_missing",
        modelUsage: result.value.modelUsage,
      },
    };
  }
  const sources =
    outcome.kind === "approval_required"
      ? await verifyTransientReplySources(host.ctx.storage.sql, {
          lookup: {
            turnId: input.turnId,
            organisationId: input.requestingOrganisationId,
            sessionId: parsedSessionId.value,
          },
          bundleDigest: context.bundleDigest,
          outcome,
          commerceReads: toolHost.recordReads(),
        })
      : NO_REPLY_SOURCES;
  return {
    ok: true,
    value: {
      outcome,
      modelUsage: result.value.modelUsage,
      breaches: toolHost.breaches(),
      commerceEvidence: toolHost.commerceEvidence(),
      sources,
      flowBinding: toolHost.flowBinding(),
      memory: rendered.memory.map((shown) => ({
        memoryId: shown.memoryId,
        revision: shown.revision,
      })),
    },
  };
}

export async function prepareTransientEvalTurn(
  host: SessionTransientHost,
  input: TransientEvalTurnRequest,
  transient: TransientSessionExecution,
): Promise<Result<TransientEvalTurnReply, TransientModelTurnError>> {
  // Each refusal of this preparation precedes provider dispatch, so the
  // attempt has known zero usage. A caller charges nothing for it.
  const refused = (code: string) => ({
    ok: false as const,
    error: { code, modelUsage: KNOWN_ZERO_MODEL_USAGE },
  });
  const execution = await SessionExecutionAdmission.resolve(
    host.env,
    host.ctx.storage,
    input.requestingOrganisationId,
  );
  if (execution === null || !(await execution.isActive()))
    return {
      ok: false,
      error: transientModelAdmissionError(
        new Error("session_placement_conflict"),
      ),
    };
  const session = await readCanonicalSessionForPersistence(
    host.persistence,
    host.ctx.storage.sql,
    input.requestingOrganisationId,
  );
  if (!session.ok) return refused(session.error.code);
  const lifecycle = session.value.lifecycle;
  if (lifecycle.kind !== "sleeping" && lifecycle.kind !== "processing")
    return refused("transient_eval_session_unavailable");
  const identity = lifecycle.state.identity;
  const contract = lifecycle.state.contract;
  const parsedSessionId = parseSessionId(identity.sessionId);
  if (!parsedSessionId.ok)
    return refused("transient_eval_session_identity_invalid");
  const eligibility = await readGmailInferenceEligibility({
    db: execution.scope.database,
    organisationId: input.requestingOrganisationId,
    modelRoute: contract.modelRoute,
    now: Date.now(),
  });
  if (eligibility.kind === "blocked")
    return refused("gmail_inference_route_blocked");
  const authority = input.requestAuthority;
  if (authority.kind !== "agent_mailbox")
    return refused("transient_eval_authority_invalid");
  const evidenceDependency = { kind: "source_only" } as const;
  const assignment = readCaseSessionAssignment(host.ctx.storage.sql);
  if (
    assignment === null ||
    assignment.caseId !== input.caseId ||
    assignment.assignmentId !== input.assignmentId ||
    assignment.sessionId !== parsedSessionId.value ||
    assignment.caseRevision !== input.caseRevision ||
    assignment.authorityPartition.digest !== input.authorityPartitionDigest ||
    authority.organisationId !== input.requestingOrganisationId ||
    authority.integrationAccountId !== input.integrationAccountId ||
    !authorityPartitionKeyMatchesRequest(
      assignment.authorityPartition.key,
      authority,
    ) ||
    JSON.stringify(assignment.context.evidenceDependency) !==
      JSON.stringify(
        await caseContextCollectionEvidenceDependency(evidenceDependency),
      )
  )
    return refused("transient_eval_assignment_changed");
  const informationFlow = await EmailTurnInformationFlow.create({
    env: host.env,
    authority,
    caseId: input.caseId,
    dependency: evidenceDependency,
    sessionId: parsedSessionId.value,
    turnId: input.turnId,
    authorityPartitionDigest: input.authorityPartitionDigest,
  });
  if (!informationFlow.ok) return refused(informationFlow.error.code);

  const context = await restoreSessionTurnContext(input.context);
  if (
    context === null ||
    context.bundleDigest !== input.contextBundleDigest ||
    context.bundle.organisationId !== input.requestingOrganisationId ||
    context.bundle.caseId !== input.caseId ||
    context.bundle.assignmentId !== input.assignmentId ||
    context.bundle.sessionId !== parsedSessionId.value
  )
    return refused("transient_eval_context_invalid");
  // The scenario is the turn's first source. The mailbox agent must be a
  // reader of the Eval revision it comes from before the model sees it.
  // A label bound to one recipient stays bound: the turn's result is
  // released only on the review surface, which holds it to that recipient.
  const fixtureLabel = await StoredFlowLabel.restore(input.fixture.inputLabel);
  if (!fixtureLabel.ok) return refused("transient_eval_fixture_invalid");
  const bound = boundRecipients(fixtureLabel.value);
  if (bound.length > 1) return refused("transient_eval_fixture_not_admitted");
  const admitted = await decideAutomaticContextAdmission({
    subject: {
      kind: "authority_derived",
      requestAuthority: authority,
      caseId: input.caseId,
    },
    inputLabel: fixtureLabel.value,
    recipient: bound[0] ?? null,
  });
  if (admitted.kind !== "admit")
    return refused("transient_eval_fixture_not_admitted");
  const fixtureEvidence = await ObservationEvidence.create({
    source: {
      kind: "organisation_record",
      organisationId: input.requestingOrganisationId,
      recordId: `eval:${input.fixture.evalId}:${input.fixture.scenarioId}`,
    },
    sourceRevision: input.fixture.revision,
    contentDigest: await digestCanonical(input.fixture.message),
    inputLabel: fixtureLabel.value,
    observedAt: Date.now(),
  });
  if (!fixtureEvidence.ok) return refused("transient_eval_fixture_invalid");
  // The flow records any organisation record the way it records Memory.
  const fixtureObserved = await informationFlow.value.observeMemory(
    fixtureEvidence.value,
    fixtureLabel.value,
  );
  if (!fixtureObserved.ok) return refused(fixtureObserved.error.code);
  // As in a reply turn, accepted Memory is shown ahead of the request and
  // recorded before the model is asked.
  const rendered = renderModelContext(
    memoryModelContext(context.modelContext),
    input.turnPrompt,
    TRANSIENT_EMAIL_PROMPT_BYTES,
    { memoryReferences: true },
  );
  const recorded = recordTransientTurnContext(host.ctx.storage.sql, {
    turnId: input.turnId,
    organisationId: input.requestingOrganisationId,
    sessionId: parsedSessionId.value,
    context,
    memoryRendering: {
      revisions: rendered.memory,
      omittedForBytes: rendered.memoryOmittedForBytes,
    },
  });
  if (!recorded.ok) return refused("transient_eval_context_conflict");
  for (const item of context.bundle.items) {
    const source = item.source;
    if (
      source.kind !== "memory" ||
      !rendered.memory.some(
        (ref) =>
          ref.memoryId === source.memoryId && ref.revision === source.revision,
      )
    )
      continue;
    const observed = await informationFlow.value.observeMemory(
      item.observationEvidence,
      item.inputLabel,
    );
    if (!observed.ok) return refused(observed.error.code);
  }
  if (!(await execution.isActive())) return transientPlacementFailure(null);

  const fixtureMessage = input.fixture.message;
  const toolHost = await createEmailHarnessToolHost({
    env: host.env,
    organisationId: input.requestingOrganisationId,
    manifest: {
      integrationAccountId: input.integrationAccountId,
      messageIds: [fixtureMessage.messageId],
      maxMessageBytes: fixtureMessage.decodedBodyBytes,
      maxAttachmentBytes: 0,
      expiresAt: Date.now() + input.maxWallMs,
    },
    responsePolicy: "cue_routed",
    authority,
    caseId: input.caseId,
    now: Date.now,
    fetcher: runtimeFetch,
    informationFlow: informationFlow.value,
    fixture: async () => ({ ok: true, value: fixtureMessage }),
  });
  const result = await runTransientMailHarness(
    execution,
    transient,
    {
      env: host.env,
      storage: host.ctx.storage,
      liveRuns: host.liveGoalRuns,
    },
    identity,
    contract,
    { ...input, turnPrompt: rendered.text },
    toolHost,
    host.toolRules,
    reauthorizeTransientEmail.bind(
      null,
      execution.scope,
      input.requestingOrganisationId,
      contract.modelRoute,
    ),
  );
  if (!(await execution.isActive()))
    return transientPlacementFailure(transientResultModelUsage(result));
  if (!result.ok) return result;
  const outcome = toolHost.outcome();
  if (outcome.kind === "none")
    return {
      ok: false,
      error: {
        code: "transient_email_outcome_missing",
        modelUsage: result.value.modelUsage,
      },
    };
  return {
    ok: true,
    value: {
      outcome,
      modelUsage: result.value.modelUsage,
      flowBinding: toolHost.flowBinding(),
      toolCatalogDigest: toolHost.catalogDigest,
      memory: rendered.memory.map((shown) => ({
        memoryId: shown.memoryId,
        revision: shown.revision,
      })),
    },
  };
}

export async function prepareTransientMailAssistant(
  host: SessionTransientHost,
  input: TransientMailAssistantRequest,
  transient: TransientSessionExecution,
): Promise<
  Result<
    {
      readonly response: MailAssistantResult;
      readonly modelUsage: EmbeddedHarnessModelUsage;
    },
    Readonly<{ code: string }>
  >
> {
  const execution = await SessionExecutionAdmission.resolve(
    host.env,
    host.ctx.storage,
    input.requestingOrganisationId,
  );
  if (execution === null || !(await execution.isActive()))
    return {
      ok: false,
      error: transientModelAdmissionError(
        new Error("session_placement_conflict"),
      ),
    };
  const authorized = await authorizeMailAssistant(host.env, input.mailbox);
  if (!authorized.ok) return authorized;
  if (
    input.requestingOrganisationId !== input.mailbox.identity.organisationId ||
    input.sourcePin !== authorized.value.sourcePin ||
    input.modelRouteDigest !== authorized.value.modelRouteDigest
  )
    return {
      ok: false,
      error: { code: "mail_assistant_authority_changed" },
    };
  const session = await readCanonicalSessionForPersistence(
    host.persistence,
    host.ctx.storage.sql,
    input.requestingOrganisationId,
  );
  if (!session.ok) return { ok: false, error: { code: session.error.code } };
  const lifecycle = session.value.lifecycle;
  if (
    lifecycle.kind !== "sleeping" ||
    (await digestModelRoute(lifecycle.state.contract.modelRoute)) !==
      input.modelRouteDigest
  )
    return {
      ok: false,
      error: { code: "mail_assistant_session_unavailable" },
    };
  const toolHost: HarnessToolHost = {
    mode: "hybrid",
    catalogDigest: await digestCanonical({
      kind: "mail_assistant_read_only_v1",
      definitions: [],
    }),
    definitions: [],
    codeMode: { kind: "disabled" },
    executeTool: rejectMailAssistantTool,
  };
  const result = await runTransientMailHarness(
    execution,
    transient,
    {
      env: host.env,
      storage: host.ctx.storage,
      liveRuns: host.liveGoalRuns,
    },
    lifecycle.state.identity,
    lifecycle.state.contract,
    input,
    toolHost,
    host.toolRules,
    reauthorizeTransientMailAssistant.bind(null, host.env, input),
  );
  if (!(await execution.isActive()))
    return transientPlacementFailure(transientResultModelUsage(result));
  if (!result.ok) return result;
  let raw: unknown;
  try {
    raw = JSON.parse(result.value.body);
  } catch {
    raw = null;
  }
  const response = parseMailAssistantResult(raw);
  if (response === null)
    return {
      ok: false,
      error: { code: "mail_assistant_output_invalid" },
    };
  return {
    ok: true,
    value: { response, modelUsage: result.value.modelUsage },
  };
}

export async function prepareTransientWhatsAppTurn(
  host: SessionTransientHost,
  input: TransientWhatsAppTurnRequest,
  transient: TransientSessionExecution,
): Promise<TransientWhatsAppTurnResult> {
  const deadlineAt = Date.now() + input.maxWallMs;
  const execution = await SessionExecutionAdmission.resolve(
    host.env,
    host.ctx.storage,
    input.requestingOrganisationId,
  );
  if (execution === null || !(await execution.isActive()))
    return {
      ok: false,
      error: transientModelAdmissionError(
        new Error("session_placement_conflict"),
      ),
    };
  const session = await readCanonicalSessionForPersistence(
    host.persistence,
    host.ctx.storage.sql,
    input.requestingOrganisationId,
  );
  if (!session.ok)
    return {
      ok: false,
      error: transientModelAdmissionError(new Error(session.error.code)),
    };
  const lifecycle = session.value.lifecycle;
  if (lifecycle.kind !== "sleeping" && lifecycle.kind !== "processing")
    return {
      ok: false,
      error: transientModelAdmissionError(
        new Error("transient_whatsapp_session_unavailable"),
      ),
    };
  const { identity, contract } = lifecycle.state;
  const completion = runTransientWhatsAppTurnLifecycle(
    host,
    input,
    deadlineAt,
    execution,
    transient,
    identity,
    contract,
  );
  const completed = await runTaskBeforeDeadline<
    TransientWhatsAppTurnResult,
    TransientWhatsAppTurnResult
  >({
    timeoutMs: input.maxWallMs,
    start: startTransientWhatsAppSessionLifecycle.bind(
      null,
      completion,
      transient,
    ),
  });
  if (completed.kind === "completed") {
    return (await execution.isActive())
      ? completed.value
      : transientPlacementFailure(transientResultModelUsage(completed.value));
  }
  traceWarn("agent_session.transient_whatsapp_turn_failed", {
    requestId: newRequestId(),
    reason: "session_wall_clock_exhausted",
  });
  return {
    ok: false,
    error: {
      code: "transient_whatsapp_session_wall_clock_exhausted",
      modelUsage: completed.cancellation.ok
        ? completed.cancellation.value.modelUsage
        : completed.cancellation.error.modelUsage,
    },
  };
}

async function runTransientWhatsAppTurnLifecycle(
  host: SessionTransientHost,
  input: TransientWhatsAppTurnRequest,
  deadlineAt: number,
  execution: SessionExecutionAdmission,
  transient: TransientSessionExecution,
  identity: SessionIdentity,
  contract: SessionContract,
): Promise<TransientWhatsAppTurnResult> {
  const parsedSessionId = parseSessionId(identity.sessionId);
  if (!parsedSessionId.ok) {
    return {
      ok: false,
      error: transientModelAdmissionError(
        new Error("transient_whatsapp_session_identity_invalid"),
      ),
    };
  }
  const adapter = selectEmbeddedHarnessAdapterForModelRoute(
    contract.modelRoute,
  );
  const lease = await createEmbeddedHarnessModelRouteLease({
    env: host.env,
    scope: execution.scope,
    sessionId: parsedSessionId.value,
    modelRoute: contract.modelRoute,
  });
  if (!lease.ok)
    return {
      ok: false,
      error: transientModelAdmissionError(new Error(lease.error.code)),
    };
  const toolHost = await createWhatsAppHarnessToolHost({
    manifest: input.manifest,
    now: Date.now,
  });
  const now = Date.now();
  const turnLease: HarnessTurnLease = {
    leaseId: `transient_${input.turnId}`,
    session: identity,
    turn: {
      turnId: input.turnId,
      inputId: input.inputId,
      turnLeaseGeneration: 1,
      budgetRevision: contract.budgetRevision,
    },
    runtimeLease: {
      generation: 1,
      leaseId: `runtime_transient_${input.turnId}`,
    },
    runtimeRevision: contract.runtimeRevision,
    requestAuthority: input.requestAuthority,
    authorityPartitionDigest: input.authorityPartitionDigest,
    issuedAt: now,
    expiresAt: deadlineAt,
  };
  const modelRouteLease = admittedSessionModelRoute(
    {
      kind: "transient",
      admission: execution,
      lease: turnLease,
      isOpen: isTransientHarnessOpen.bind(null, transient),
    },
    lease.value,
  );
  const acceptedInput: AcceptedInputRef = {
    kind: "case",
    inputId: input.inputId,
    caseId: input.caseId,
    assignmentId: input.assignmentId,
    caseRevision: input.caseRevision,
    contentDigest: input.contentDigest,
    workspaceRevision: input.workspaceRevision,
    contextBundleDigest: input.contextBundleDigest,
  };
  let goalExecution;
  try {
    goalExecution = await createTransientGoalExecution(
      {
        env: host.env,
        storage: host.ctx.storage,
        liveRuns: host.liveGoalRuns,
      },
      turnLease,
      input.caseId,
      input.allowanceTokens,
    );
  } catch (error) {
    return { ok: false, error: transientModelAdmissionError(error) };
  }
  try {
    if (Date.now() >= deadlineAt) {
      return {
        ok: false,
        error: transientModelAdmissionError(
          new Error("transient_whatsapp_session_wall_clock_exhausted"),
        ),
      };
    }
    const result = await runTransientTurn<
      TransientWhatsAppTurnReply["outcome"]
    >({
      adapter,
      construction: {
        persistence: { kind: "transient" },
        source: { kind: "fresh" },
        inheritedHistory: [],
        inheritedAttachments: {},
        sessionId: parsedSessionId.value,
        acceptedInput,
        model: contract.modelRoute.model,
        modelTokenAllowance: input.allowanceTokens,
        goalModelCalls: goalExecution.control,
        harnessInstructions: input.harnessInstructions,
        modelRouteLease,
        checkpointBinding: {
          cursor: null,
          modelRouteDigest: await digestModelRoute(contract.modelRoute),
          instructionDigest: await digestCanonical({
            kind: "pantry_transient_whatsapp_instructions_v1",
            instructions: input.harnessInstructions,
          }),
          toolCatalogDigest: toolHost.catalogDigest,
          workspaceRevision: input.workspaceRevision,
          policyRevision: String(contract.policyVersion),
        },
        toolRules: host.toolRules,
        toolHost: admittedSessionToolHost(
          {
            kind: "transient",
            admission: execution,
            lease: turnLease,
            isOpen: isTransientHarnessOpen.bind(null, transient),
          },
          toolHost,
        ),
        turnLease,
        now: Date.now,
      },
      input: [{ kind: "text", text: input.turnPrompt }],
      onTurnStarted: admitTransientHarnessTurn.bind(null, execution, transient),
      onTurnSettled: settleTransientHarnessTurn.bind(null, transient),
      maxWallMs: Math.max(1, deadlineAt - Date.now()),
      complete: completeTransientWhatsAppTurn.bind(null, toolHost),
      teardown: startNoTransientTeardown,
    });
    if (
      goalExecution.state.stop !== null &&
      (result.ok || result.error.code === "transient_turn_output_invalid")
    ) {
      return {
        ok: false,
        error: {
          code: "transient_goal_stopped",
          modelUsage: result.ok
            ? result.value.modelUsage
            : result.error.modelUsage,
        },
      };
    }
    if (!result.ok) {
      traceWarn("agent_session.transient_whatsapp_turn_failed", {
        requestId: newRequestId(),
        reason: `${result.error.code}:${result.error.detail}`,
      });
      return {
        ok: false,
        error: {
          code:
            result.error.code === "transient_turn_output_invalid"
              ? "transient_whatsapp_outcome_missing"
              : result.error.code,
          modelUsage: result.error.modelUsage,
        },
      };
    }
    return {
      ok: true,
      value: {
        outcome: result.value.value,
        modelUsage: result.value.modelUsage,
      },
    };
  } finally {
    await goalExecution.close();
  }
}
