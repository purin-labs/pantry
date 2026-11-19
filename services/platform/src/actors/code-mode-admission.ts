import { SessionExecutionAdmission } from "./session-execution-admission";
import { authorizeChatHarnessLease } from "../chat/turn-access";
import type {
  AgentSessionLifecycle,
  CodeModeExecutionReceipt,
  EventEnvelope,
  HarnessTurnLease,
  SessionTransition,
  WorkspaceExecutorUsage,
  WorkspaceRevisionReceipt,
} from "@purin-labs/contracts";

import { validateCanonicalSessionAdvance } from "../actor-wasm";
import type { Env } from "../env";
import {
  newRequestId,
  parseSessionId,
  type SessionId,
  type OrganisationId,
} from "../ids";
import { traceLog, traceWarn } from "../observability";
import {
  CODE_MODE_PILOT_BUDGET,
  CODE_MODE_ENGINE_RESERVED_COST_MICROS,
  CODE_MODE_PRICE_BOOK_REVISION_V2,
  WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
  type CodeModeOrganisationReserveInput,
  type CodeModeOrganisationSettleInput,
} from "./code-mode-budget";
import { codeModePlatformGovernor } from "./code-mode-platform-governor-stub";
import { routeCodeModeExecution } from "./code-mode-router";
import { preflightHarnessTurnLease } from "./agent-session-harness-authority";
import {
  codeModeExecutionReceiptId,
  settleCodeModeExecutionDurably,
  resumeCodeModeExecutionSettlement,
} from "./agent-session-code-mode-settlement";
import {
  commitExecutionRequestedSession,
  type ExecutionRequestedSessionCommit,
} from "./actor-journal";
import { readCanonicalSessionProjection } from "./agent-session-canonical";
import { requireActiveOrganisationActorAtPlacement } from "./actor-router";
import { CodeModeAdmissionFrozenError, type HarnessCodeModeAdmission, type HarnessCodeModeAdmittedExecution, type HarnessCodeModeExecutionLease, type HarnessCodeModeExecutionOutcome } from "../agent-tools/catalog/types";
import {
  parseCodeModeExecutionProjection,
  writeCodeModeExecutionCounter,
  type CodeModeExecutionProjection,
} from "./code-mode-execution-projection";
import {
  codeModeExecutionLeaseId,
  deriveCodeModeLeaseBinding,
  readCodeModeExecution,
  type CodeModeExecutionRecord,
} from "./code-mode-execution-record";
import type { Variant } from "@purin-labs/type-utils";
import { sha256Hex } from "@purin-labs/std";

const CLEANUP_MARGIN_MS = 5_000;
const EMPTY_REQUIREMENTS_DIGEST =
  "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

type DurableExecution = {
  /** `null` for a record that predates the stored deadline. */
  readonly executionDeadlineAt: number | null;
  readonly identity: {
    readonly executionId: string;
    readonly leaseId: string;
    readonly organisationId: OrganisationId;
    readonly admissionDigest: string;
    readonly priceBookRevision: string;
    readonly reservedCostMicros: number;
  };
  readonly counter: {
    readonly capabilityCalls: number;
    readonly inputBytes: number;
    readonly outputBytes: number;
  };
  readonly workspaceRevisionReceipt: WorkspaceRevisionReceipt | null;
};

export function createHarnessCodeModeAdmission(input: {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly organisationId: OrganisationId;
  readonly lease: HarnessTurnLease;
  readonly catalogDigest: string;
}): HarnessCodeModeAdmission {
  return {
    begin: beginCodeModeExecution.bind(null, input),
    claim: claimCodeModeCapability.bind(null, input),
    complete: completeCodeModeCapability.bind(null, input),
    abandon: abandonCodeModeCapabilities.bind(null, input),
    settle: settleCodeModeExecution.bind(null, input),
  };
}

async function beginCodeModeExecution(
  authority: AdmissionAuthority,
  source: string,
  callId: string,
): Promise<HarnessCodeModeAdmittedExecution> {
  await requireChatHarnessAccess(authority);
  requireLiveHarnessLease(authority);
  const reserve = await buildReserveInput(authority, source, callId);
  const existing = readAdmittedExecution(
    authority.storage.sql,
    reserve.executionId,
  );
  if (existing.kind === "found") {
    // The identity of an execution outlives a runtime generation. Its lease
    // does not: the execution runs only under the lease of this generation,
    // and a recovery binds that lease at each owner before the task resumes.
    if (
      existing.execution.identity.leaseId !== reserve.leaseId ||
      existing.execution.executionDeadlineAt === null
    ) {
      throw new Error(
        "Code Mode execution admission conflicts with durable state",
      );
    }
    return {
      executionId: reserve.executionId,
      leaseId: reserve.leaseId,
      // The deadline of the first admission, not of this call.
      executionDeadlineAt: existing.execution.executionDeadlineAt,
      // The digest covers the program, the catalog, and the policy. A
      // difference means that this runtime offers another tool contract.
      runnable:
        existing.execution.identity.admissionDigest === reserve.admissionDigest,
    };
  }
  if (existing.kind === "corrupt") {
    throw new Error("Code Mode execution admission state is corrupt");
  }
  if (existing.kind === "rebinding") {
    throw new Error("Code Mode execution lease is not bound to this runtime");
  }
  const platform = codeModePlatformGovernor(authority.env);
  const platformReserved = await platform.reserve(reserve);
  if (!platformReserved.ok || platformReserved.value.kind !== "reserved") {
    const reason = platformReserved.ok
      ? platformReserved.value.kind
      : platformReserved.error.code;
    traceWarn("code_mode.platform_admission_failed", {
      requestId: reserve.requestId,
      organisation_id: reserve.organisationId,
      session_id: reserve.sessionId,
      turn_id: reserve.turnId,
      execution_id: reserve.executionId,
      reason,
    });
    throw new Error(`Code Mode platform admission failed: ${reason}`);
  }
  const organisation = await requireCodeModeOrganisation(authority);
  const organisationReserved =
    await organisation.reserveCodeModeBudget(reserve);
  if (
    !organisationReserved.ok ||
    organisationReserved.value.kind !== "reserved"
  ) {
    const reason = organisationReserved.ok
      ? organisationReserved.value.kind
      : organisationReserved.error.code;
    await platform.cancel({
      requestId: newRequestId(),
      organisationId: reserve.organisationId,
      executionId: reserve.executionId,
      leaseId: reserve.leaseId,
      reason: "admission_compensated",
      now: Date.now(),
    });
    traceWarn("code_mode.organisation_admission_failed", {
      requestId: reserve.requestId,
      organisation_id: reserve.organisationId,
      session_id: reserve.sessionId,
      turn_id: reserve.turnId,
      execution_id: reserve.executionId,
      reason,
    });
    throw new Error(`Code Mode organisation admission failed: ${reason}`);
  }
  await requireChatHarnessAccess(authority);
  requireLiveHarnessLease(authority);
  const committed = commitExecutionRequest(authority, reserve, Date.now());
  if (!committed) {
    const now = Date.now();
    await organisation.cancelCodeModeBudget({
      requestId: newRequestId(),
      organisationId: reserve.organisationId,
      executionId: reserve.executionId,
      leaseId: reserve.leaseId,
      reason: "admission_compensated",
      now,
    });
    await platform.cancel({
      requestId: newRequestId(),
      organisationId: reserve.organisationId,
      executionId: reserve.executionId,
      leaseId: reserve.leaseId,
      reason: "admission_compensated",
      now,
    });
    throw new Error("Code Mode execution request commit failed");
  }
  traceLog("code_mode.execution_admitted", {
    requestId: reserve.requestId,
    organisation_id: reserve.organisationId,
    session_id: reserve.sessionId,
    turn_id: reserve.turnId,
    execution_id: reserve.executionId,
    placement: reserve.placement,
  });
  return {
    executionId: reserve.executionId,
    leaseId: reserve.leaseId,
    executionDeadlineAt: reserve.executionDeadlineAt,
    runnable: true,
  };
}

async function claimCodeModeCapability(
  authority: AdmissionAuthority,
  lease: HarnessCodeModeExecutionLease,
  callId: string,
  inputBytes: number,
): Promise<void> {
  await requireChatHarnessAccess(authority);
  requireLiveHarnessLease(authority);
  const execution = requireAdmittedExecution(authority.storage.sql, lease);
  // A frozen admission stops new capability dispatch. Completion and
  // settlement of calls that are already admitted do not pass through here.
  if (!(await codeModePlatformGovernor(authority.env).isAdmissionOpen()))
    throw new CodeModeAdmissionFrozenError();
  const organisation = await requireCodeModeOrganisation(authority);
  const claimed = await organisation.claimCodeModeCapability({
    requestId: newRequestId(),
    organisationId: execution.identity.organisationId,
    executionId: execution.identity.executionId,
    leaseId: execution.identity.leaseId,
    callId,
    inputBytes,
    now: Date.now(),
  });
  if (!claimed.ok)
    throw new Error(`Code Mode capability claim failed: ${claimed.error.code}`);
  writeExecutionCounter(authority.storage, lease, {
    capabilityCalls: claimed.value.capabilityCalls,
    inputBytes: claimed.value.inputBytes,
    outputBytes: claimed.value.outputBytes,
  });
  await requireChatHarnessAccess(authority);
  requireLiveHarnessLease(authority);
}

async function completeCodeModeCapability(
  authority: AdmissionAuthority,
  lease: HarnessCodeModeExecutionLease,
  callId: string,
  outputBytes: number,
): Promise<void> {
  const execution = requireAdmittedExecution(authority.storage.sql, lease);
  const organisation = await requireCodeModeOrganisation(authority);
  const completed = await organisation.completeCodeModeCapability({
    requestId: newRequestId(),
    organisationId: execution.identity.organisationId,
    executionId: execution.identity.executionId,
    leaseId: execution.identity.leaseId,
    callId,
    outputBytes,
    now: Date.now(),
  });
  if (!completed.ok)
    throw new Error(
      `Code Mode capability completion failed: ${completed.error.code}`,
    );
  writeExecutionCounter(authority.storage, lease, {
    capabilityCalls: completed.value.capabilityCalls,
    inputBytes: completed.value.inputBytes,
    outputBytes: completed.value.outputBytes,
  });
  await requireChatHarnessAccess(authority);
  requireLiveHarnessLease(authority);
}

async function abandonCodeModeCapabilities(
  authority: AdmissionAuthority,
  lease: HarnessCodeModeExecutionLease,
): Promise<void> {
  const execution = requireAdmittedExecution(authority.storage.sql, lease);
  const organisation = await requireCodeModeOrganisation(authority);
  const abandoned = await organisation.abandonCodeModeCapabilityCalls({
    requestId: newRequestId(),
    organisationId: execution.identity.organisationId,
    executionId: execution.identity.executionId,
    leaseId: execution.identity.leaseId,
    now: Date.now(),
  });
  if (!abandoned.ok)
    throw new Error(
      `Code Mode capability release failed: ${abandoned.error.code}`,
    );
  writeExecutionCounter(authority.storage, lease, {
    capabilityCalls: abandoned.value.capabilityCalls,
    inputBytes: abandoned.value.inputBytes,
    outputBytes: abandoned.value.outputBytes,
  });
  requireLiveHarnessLease(authority);
}

async function settleCodeModeExecution(
  authority: AdmissionAuthority,
  lease: HarnessCodeModeExecutionLease,
  outcome: HarnessCodeModeExecutionOutcome,
  outputBytes: number,
): Promise<void> {
  const resumed = await resumeCodeModeExecutionSettlement({
    env: authority.env,
    storage: authority.storage,
    organisationId: authority.organisationId,
    lease: authority.lease,
    executionLease: lease,
    outcome,
    outputBytes,
  });
  if (!resumed.ok)
    throw new Error(
      `Code Mode settlement recovery failed: ${resumed.error.code}`,
    );
  if (resumed.value.kind === "settled") return;
  const execution = requireAdmittedExecution(authority.storage.sql, lease);
  requireLiveHarnessLease(authority);
  const workspaceRevisionReceipt = currentExecutionWorkspaceReceipt(
    authority,
    execution,
  );
  // No Code Mode operation allocates a workspace executor since Plan 92.
  const workspaceExecutorUsage: WorkspaceExecutorUsage = { kind: "unused" };
  const aggregateOutcome = outcome;
  const actualCostMicros = CODE_MODE_ENGINE_RESERVED_COST_MICROS;
  const receiptDigest = await sha256Hex(
    JSON.stringify({
      executionId: execution.identity.executionId,
      admissionDigest: execution.identity.admissionDigest,
      priceBookRevision: execution.identity.priceBookRevision,
      actualCostMicros,
      capabilityCalls: execution.counter.capabilityCalls,
      inputBytes: execution.counter.inputBytes,
      toolOutputBytes: execution.counter.outputBytes,
      outcome: aggregateOutcome,
      outputBytes,
      workspaceExecutorUsage,
      workspaceRevisionReceipt,
    }),
  );
  const settle: CodeModeOrganisationSettleInput = {
    requestId: newRequestId(),
    organisationId: execution.identity.organisationId,
    executionId: execution.identity.executionId,
    leaseId: execution.identity.leaseId,
    receiptId: codeModeExecutionReceiptId(execution.identity.executionId),
    receiptDigest,
    actualCostMicros,
    capabilityCalls: execution.counter.capabilityCalls,
    inputBytes: execution.counter.inputBytes,
    outputBytes: execution.counter.outputBytes,
    outcome: aggregateOutcome,
    now: Date.now(),
  };
  const receipt: CodeModeExecutionReceipt = {
    executionId: execution.identity.executionId,
    turn: authority.lease.turn,
    admissionDigest: execution.identity.admissionDigest,
    receiptDigest,
    priceBookRevision: execution.identity.priceBookRevision,
    reservedCostMicros: execution.identity.reservedCostMicros,
    actualCostMicros,
    capabilityCalls: execution.counter.capabilityCalls,
    inputBytes: execution.counter.inputBytes,
    outputBytes: execution.counter.outputBytes,
    rootOutputBytes: outputBytes,
    workspaceExecutorUsage,
    outcome: aggregateOutcome,
    workspaceRevisionReceipt,
  };
  const settled = await settleCodeModeExecutionDurably({
    env: authority.env,
    storage: authority.storage,
    organisationId: authority.organisationId,
    settle,
    lease: authority.lease,
    receipt,
  });
  if (!settled.ok) {
    throw new Error(
      `Code Mode durable settlement failed: ${settled.error.code}${"reason" in settled.error ? ` (${settled.error.reason})` : ""}`,
    );
  }
  traceLog("code_mode.execution_settled", {
    requestId: settle.requestId,
    organisation_id: settle.organisationId,
    session_id: authority.lease.session.sessionId,
    turn_id: authority.lease.turn.turnId,
    execution_id: settle.executionId,
    outcome: settle.outcome,
    capability_calls: settle.capabilityCalls,
    actual_cost_micros: settle.actualCostMicros,
  });
}

type AdmissionAuthority = {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly organisationId: OrganisationId;
  readonly lease: HarnessTurnLease;
  readonly catalogDigest: string;
};

async function buildReserveInput(
  authority: AdmissionAuthority,
  source: string,
  callId: string,
): Promise<CodeModeOrganisationReserveInput> {
  const programDigest = await sha256Hex(source);
  const sessionId = requireSessionId(authority.lease.session.sessionId);
  const policyDigest = await sha256Hex(
    JSON.stringify({
      authorityPartitionDigest: authority.lease.authorityPartitionDigest,
      catalogDigest: authority.catalogDigest,
    }),
  );
  // The execution is the accepted Code Mode call of a turn. A later runtime
  // generation resumes the same execution, so the generation is not part of
  // its identity.
  const executionMaterial = JSON.stringify({
    organisationId: authority.organisationId,
    sessionId,
    turnId: authority.lease.turn.turnId,
    callId,
    programDigest,
  });
  const executionDigest = await sha256Hex(executionMaterial);
  const executionId = `cmx-${executionDigest.slice(0, 32)}`;
  const binding = await deriveCodeModeLeaseBinding(
    executionId,
    authority.lease.runtimeLease.generation,
  );
  const executionDeadlineAt = Math.min(
    authority.lease.expiresAt,
    Date.now() + CODE_MODE_PILOT_BUDGET.maxDurationMs,
  );
  const route = await routeCodeModeExecution({
    workloadProfile: "sequential_read",
    invocation: "root",
    effects: "none",
    capability: "available",
    policy: "allowed",
    catalog: "current",
    budget: "feasible",
  });
  const immutable = {
    organisationId: authority.organisationId,
    sessionId,
    turnId: authority.lease.turn.turnId,
    executionId,
    idempotencyKey: `code-${executionDigest.slice(0, 32)}`,
    programDigest,
    requirementsDigest: EMPTY_REQUIREMENTS_DIGEST,
    policyDigest,
    catalogDigest: authority.catalogDigest,
    routerRevision: route.routerRevision,
    // The sandbox build. An execution that another build admitted has another
    // admission digest, and does not resume here.
    runtimeRevision: route.placement.adapterRevision,
    priceBookRevision: CODE_MODE_PRICE_BOOK_REVISION_V2,
    placement: route.placement,
    budget: CODE_MODE_PILOT_BUDGET,
    reservedCostMicros:
      CODE_MODE_ENGINE_RESERVED_COST_MICROS +
      WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    customerDisposition: "included_interactive" as const,
  };
  // The governor retains the first deadline; retry identity binds the program and authority.
  // The digest excludes the lease, so every generation of the execution agrees on it.
  const admissionDigest = await sha256Hex(JSON.stringify(immutable));
  return {
    requestId: newRequestId(),
    ...immutable,
    runtimeGeneration: binding.runtimeGeneration,
    leaseId: binding.leaseId,
    executionDeadlineAt,
    leaseExpiresAt: executionDeadlineAt + CLEANUP_MARGIN_MS,
    admissionDigest,
    now: Date.now(),
  };
}

function commitExecutionRequest(
  authority: AdmissionAuthority,
  reserve: CodeModeOrganisationReserveInput,
  acceptedAt: number,
): boolean {
  const current = readCanonicalSessionProjection(
    authority.storage.sql,
    authority.lease.session.organisationId,
    authority.lease.session.sessionId,
  );
  if (current === null || current.kind !== "processing") return false;
  const request = {
    effectId: executionEffectId(reserve.executionId),
    kind: "execution" as const,
    capability: "idempotent" as const,
    idempotencyKey: reserve.idempotencyKey,
    request: {
      kind: "inline" as const,
      value: {
        executionId: reserve.executionId,
        turn: authority.lease.turn,
        admissionDigest: reserve.admissionDigest,
        workspaceRevisionReceipt: currentWorkspaceReceipt(current),
      },
    },
  };
  const state: ExecutionRequestedSessionCommit["state"] = {
    kind: "processing",
    state: {
      identity: current.state.identity,
      contract: {
        ...current.state.contract,
        lastEventSequence: current.state.contract.lastEventSequence + 1,
      },
      resumePoint: current.state.resumePoint,
      runtimeLease: current.state.runtimeLease,
      activeTurn: {
        kind: "awaiting_execution",
        state: {
          identity: authority.lease.turn,
          executionId: reserve.executionId,
          effectId: request.effectId,
        },
      },
    },
  };
  const transition: Variant<SessionTransition, "execution_requested"> = {
    kind: "execution_requested",
    request,
    state: state.state,
  };
  const commandId = `${reserve.executionId}:request-execution`;
  const event: EventEnvelope<typeof transition> = {
    envelopeVersion: "actor-envelope.v1",
    payloadVersion: "session-transition.v1",
    eventId: `${reserve.executionId}:execution-requested`,
    organisationId: current.state.identity.organisationId,
    actorId: current.state.identity.sessionId,
    streamId: current.state.identity.streamId,
    sequence: state.state.contract.lastEventSequence,
    sourceTime: { kind: "satyr", issuedAt: acceptedAt },
    acceptedAt,
    correlationId: reserve.executionId,
    causation: { kind: "command", commandId },
    idempotencyKey: reserve.idempotencyKey,
    runtimeRevision: state.state.contract.runtimeRevision,
    principal: { kind: "system", componentId: "embedded_harness" },
    sensitivity: "organisation_private",
    retention: "session",
    body: transition,
  };
  const valid = validateCanonicalSessionAdvance({
    current,
    command: {
      kind: "request_execution",
      runtimeLease: authority.lease.runtimeLease,
      turnLeaseGeneration: authority.lease.turn.turnLeaseGeneration,
      request,
    },
    transition,
    state,
  });
  if (!valid.ok) return false;
  return commitExecutionRequestedSession(authority.storage, {
    source: "harness",
    commandId,
    event,
    state,
    harnessLease: authority.lease,
    reserve,
  }).ok;
}

function currentWorkspaceReceipt(
  current: Variant<AgentSessionLifecycle, "processing">,
): WorkspaceRevisionReceipt {
  switch (current.state.resumePoint.kind) {
    case "new":
      return current.state.resumePoint.workspaceRevisionReceipt;
    case "checkpoint":
      return current.state.resumePoint.checkpoint.workspaceRevisionReceipt;
  }
}

function currentExecutionWorkspaceReceipt(
  authority: AdmissionAuthority,
  execution: DurableExecution,
): WorkspaceRevisionReceipt {
  const current = readCanonicalSessionProjection(
    authority.storage.sql,
    authority.lease.session.organisationId,
    authority.lease.session.sessionId,
  );
  if (current === null || current.kind !== "processing") {
    throw new Error("Code Mode session state is unavailable");
  }
  if (
    current.state.activeTurn.kind !== "awaiting_execution" ||
    current.state.activeTurn.state.executionId !==
      execution.identity.executionId
  ) {
    throw new Error("Code Mode execution does not own the active turn");
  }
  return execution.workspaceRevisionReceipt ?? currentWorkspaceReceipt(current);
}

/**
 * The deadline that admission set for an execution. Work that its script asks
 * for ends by it: the exchange stops the script there. A resumed execution
 * keeps the deadline of its first admission.
 */
export function admittedExecutionDeadline(
  sql: SqlStorage,
  lease: HarnessCodeModeExecutionLease,
): number {
  const deadline = requireAdmittedExecution(sql, lease).executionDeadlineAt;
  if (deadline === null) throw new Error("Code Mode execution lease is stale");
  return deadline;
}

function requireAdmittedExecution(
  sql: SqlStorage,
  lease: HarnessCodeModeExecutionLease,
): DurableExecution {
  const result = readAdmittedExecution(sql, lease.executionId);
  if (
    result.kind !== "found" ||
    result.execution.identity.executionId !== lease.executionId ||
    result.execution.identity.leaseId !== lease.leaseId
  ) {
    throw new Error("Code Mode execution lease is stale");
  }
  return result.execution;
}

function readAdmittedExecution(
  sql: SqlStorage,
  executionId: string,
):
  | { readonly kind: "missing" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "rebinding" }
  | { readonly kind: "found"; readonly execution: DurableExecution } {
  const execution = readCodeModeExecution(sql, executionId);
  if (execution.kind !== "found") return execution;
  const { record, stateKind, stateProjection } = execution.stored;
  if (stateKind !== "pending" && stateKind !== "dispatching") {
    return { kind: "corrupt" };
  }
  const projection = parseCodeModeExecutionProjection(stateProjection);
  if (projection === null) return { kind: "corrupt" };
  // While a rebind is unadopted, neither lease may run the execution.
  if (record.authority.kind === "rebinding") return { kind: "rebinding" };
  return {
    kind: "found",
    execution: durableExecution(record, projection),
  };
}

function durableExecution(
  record: CodeModeExecutionRecord,
  projection: CodeModeExecutionProjection,
): DurableExecution {
  return {
    executionDeadlineAt:
      record.authority.kind === "generation_unrecorded"
        ? null
        : record.authority.executionDeadlineAt,
    identity: {
      executionId: record.executionId,
      leaseId: codeModeExecutionLeaseId(record.authority),
      organisationId: record.organisationId,
      admissionDigest: record.admissionDigest,
      priceBookRevision: record.priceBookRevision,
      reservedCostMicros: record.reservedCostMicros,
    },
    counter: {
      capabilityCalls: projection.capabilityCalls,
      inputBytes: projection.inputBytes,
      outputBytes: projection.outputBytes,
    },
    workspaceRevisionReceipt: null,
  };
}

function writeExecutionCounter(
  storage: DurableObjectStorage,
  lease: HarnessCodeModeExecutionLease,
  counter: DurableExecution["counter"],
): void {
  requireAdmittedExecution(storage.sql, lease);
  const written = writeCodeModeExecutionCounter(
    storage,
    lease,
    counter,
    Date.now(),
  );
  if (!written.ok)
    throw new Error(
      "Code Mode execution counter conflicts with workspace state",
    );
}

function executionEffectId(executionId: string): string {
  return `execution-${executionId}`;
}

function requireSessionId(raw: string): SessionId {
  const parsed = parseSessionId(raw);
  if (!parsed.ok) throw new Error("Code Mode session identity is invalid");
  return parsed.value;
}

function requireLiveHarnessLease(authority: AdmissionAuthority): void {
  const live = preflightHarnessTurnLease(
    authority.storage,
    authority.lease,
    Date.now(),
  );
  if (!live.ok)
    throw new Error(`Code Mode harness authority failed: ${live.error.code}`);
}

async function requireChatHarnessAccess(
  authority: AdmissionAuthority,
): Promise<void> {
  const execution = await SessionExecutionAdmission.resolve(
    authority.env,
    authority.storage,
    authority.organisationId,
  );
  if (execution === null) throw new Error("chat_access_revoked");
  if (
    !(await authorizeChatHarnessLease(
      authority.env.DB,
      execution.scope.database,
      authority.organisationId,
      authority.lease,
      execution.scope.accountAccess,
    ))
  )
    throw new Error("chat_access_revoked");
}

async function requireCodeModeOrganisation(authority: AdmissionAuthority) {
  const execution = await SessionExecutionAdmission.resolve(
    authority.env,
    authority.storage,
    authority.organisationId,
  );
  if (execution === null || !(await execution.isActive()))
    throw new Error("code_mode_placement_unavailable");
  return requireActiveOrganisationActorAtPlacement({
    env: authority.env,
    organisationId: authority.organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
}
