import type {
  AcceptedInputRef,
  AgentSessionLifecycle,
  CausationRef,
  EventEnvelope,
  EventPrincipal,
  HarnessTurnLease,
  RequestAuthority,
  RuntimeLease,
  SessionTransition,
  Timestamp,
  TurnLeaseGeneration,
} from "@seams/contracts";

import { validateCanonicalSessionAdvance } from "../actor-wasm";
import type { Result } from "../result";
import type {
  AcceptedSessionInputCommit,
  RuntimeActivatedSessionCommit,
} from "./actor-journal";
import type { Variant } from "@seams/type-utils";

export type CanonicalTextTurnOrigin =
  | {
      readonly kind: "command";
      readonly principal: EventPrincipal;
      readonly scheduleId?: never;
      readonly componentId?: never;
    }
  | {
      readonly kind: "schedule";
      readonly scheduleId: string;
      readonly componentId: string;
      readonly principal?: never;
    };

export type CanonicalTextTurnStartRequest = {
  readonly startId: string;
  readonly correlationId: string;
  readonly acceptedAt: Timestamp;
  readonly admittedAt: Timestamp;
  readonly harnessLeaseExpiresAt: Timestamp;
  readonly input: AcceptedInputRef;
  readonly requestAuthority: RequestAuthority;
  readonly authorityPartitionDigest: string;
  readonly turnId: string;
  readonly runtimeLease: RuntimeLease;
  readonly turnLeaseGeneration: TurnLeaseGeneration;
  readonly origin: CanonicalTextTurnOrigin;
};

/**
 * A start request that names no runtime generation. The Session takes the
 * next generation from its own resume point, so its caller does not read the
 * Session first.
 */
export type CanonicalCaseTurnStartRequest = Omit<
  CanonicalTextTurnStartRequest,
  "runtimeLease" | "turnLeaseGeneration"
>;

/** Give a start request the next runtime generation of a sleeping Session. */
export function withNextRuntimeGeneration(
  current: Variant<AgentSessionLifecycle, "sleeping">,
  request: CanonicalCaseTurnStartRequest,
): CanonicalTextTurnStartRequest {
  const resume = current.state.resumePoint;
  const generation =
    resume.kind === "new" ? 1 : resume.checkpoint.runtimeGeneration + 1;
  return {
    ...request,
    runtimeLease: {
      generation,
      leaseId: `runtime_${request.turnId}_${generation}`,
    },
    turnLeaseGeneration: generation,
  };
}

type CanonicalTextTurnStart = {
  readonly acceptedInput: AcceptedSessionInputCommit;
  readonly activatedRuntime: RuntimeActivatedSessionCommit;
  readonly harnessLease: HarnessTurnLease;
};

export type CanonicalTextTurnStartError = {
  readonly code: "canonical_text_turn_start_invalid";
  readonly reason: string;
};

export function buildCanonicalTextTurnStart(input: {
  readonly current: Variant<AgentSessionLifecycle, "sleeping">;
  readonly request: CanonicalTextTurnStartRequest;
}): Result<CanonicalTextTurnStart, CanonicalTextTurnStartError> {
  if (!validStartRequest(input.request)) return startError("invalid_request");
  const activating = activatingState(input.current, input.request);
  const accepted = acceptedInputCommit(activating, input.request);
  const acceptedValidation = validateCanonicalSessionAdvance({
    current: input.current,
    command: {
      kind: "accept_input",
      input: input.request.input,
      turnId: input.request.turnId,
      runtimeGeneration: input.request.runtimeLease.generation,
    },
    transition: accepted.event.body,
    state: activating,
  });
  if (!acceptedValidation.ok) return startError(acceptedValidation.error.code);

  const processing = processingState(activating, input.request);
  const harnessLease = harnessTurnLease(processing, input.request);
  const activated = activatedRuntimeCommit(
    processing,
    harnessLease,
    input.request,
  );
  const activationValidation = validateCanonicalSessionAdvance({
    current: activating,
    command: {
      kind: "activate_runtime",
      runtimeLease: input.request.runtimeLease,
      turnLeaseGeneration: input.request.turnLeaseGeneration,
      admittedAt: input.request.admittedAt,
    },
    transition: activated.event.body,
    state: processing,
  });
  return activationValidation.ok
    ? {
        ok: true,
        value: {
          acceptedInput: accepted,
          activatedRuntime: activated,
          harnessLease,
        },
      }
    : startError(activationValidation.error.code);
}

function activatingState(
  current: Variant<AgentSessionLifecycle, "sleeping">,
  request: CanonicalTextTurnStartRequest,
): Variant<AgentSessionLifecycle, "activating"> {
  return {
    kind: "activating",
    state: {
      identity: current.state.identity,
      contract: nextContract(current.state.contract),
      turnId: request.turnId,
      inputId: request.input.inputId,
      resumePoint: current.state.resumePoint,
      runtimeGeneration: request.runtimeLease.generation,
    },
  };
}

function processingState(
  activating: Variant<AgentSessionLifecycle, "activating">,
  request: CanonicalTextTurnStartRequest,
): Variant<AgentSessionLifecycle, "processing"> {
  return {
    kind: "processing",
    state: {
      identity: activating.state.identity,
      contract: nextContract(activating.state.contract),
      resumePoint: activating.state.resumePoint,
      runtimeLease: request.runtimeLease,
      activeTurn: {
        kind: "admitted",
        state: {
          identity: {
            turnId: activating.state.turnId,
            inputId: activating.state.inputId,
            turnLeaseGeneration: request.turnLeaseGeneration,
            budgetRevision: activating.state.contract.budgetRevision,
          },
          admittedAt: request.admittedAt,
        },
      },
    },
  };
}

function acceptedInputCommit(
  state: Variant<AgentSessionLifecycle, "activating">,
  request: CanonicalTextTurnStartRequest,
): AcceptedSessionInputCommit {
  const commandId = `${request.startId}:accept-input`;
  const transition: Variant<SessionTransition, "input_accepted"> = {
    kind: "input_accepted",
    input: request.input,
    state: state.state,
  };
  return {
    source: "surface_actor",
    commandId,
    event: eventEnvelope({
      state,
      body: transition,
      commandId,
      eventId: `${request.startId}:input-accepted`,
      idempotencyKey: request.input.inputId,
      correlationId: request.correlationId,
      acceptedAt: request.acceptedAt,
      origin: request.origin,
    }),
    state,
  };
}

function activatedRuntimeCommit(
  state: Variant<AgentSessionLifecycle, "processing">,
  harnessLease: HarnessTurnLease,
  request: CanonicalTextTurnStartRequest,
): RuntimeActivatedSessionCommit {
  const commandId = `${request.startId}:activate-runtime`;
  const transition: Variant<SessionTransition, "runtime_activated"> = {
    kind: "runtime_activated",
    state: state.state,
  };
  return {
    source: "capacity_governor",
    commandId,
    event: eventEnvelope({
      state,
      body: transition,
      commandId,
      eventId: `${request.startId}:runtime-activated`,
      idempotencyKey: `${request.startId}:runtime-activated`,
      correlationId: request.correlationId,
      acceptedAt: request.admittedAt,
      origin: {
        kind: "command",
        principal: { kind: "system", componentId: "capacity_governor" },
      },
    }),
    state,
    harnessLease,
  };
}

function harnessTurnLease(
  state: Variant<AgentSessionLifecycle, "processing">,
  request: CanonicalTextTurnStartRequest,
): HarnessTurnLease {
  return {
    leaseId: `${request.startId}:harness-lease`,
    session: state.state.identity,
    turn: state.state.activeTurn.state.identity,
    runtimeLease: state.state.runtimeLease,
    runtimeRevision: state.state.contract.runtimeRevision,
    requestAuthority: request.requestAuthority,
    authorityPartitionDigest: request.authorityPartitionDigest,
    issuedAt: request.admittedAt,
    expiresAt: request.harnessLeaseExpiresAt,
  };
}

function eventEnvelope<T extends SessionTransition>(input: {
  readonly state: AgentSessionLifecycle;
  readonly body: T;
  readonly commandId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly acceptedAt: Timestamp;
  readonly origin: CanonicalTextTurnOrigin;
}): EventEnvelope<T> {
  return {
    envelopeVersion: "actor-envelope.v1",
    payloadVersion: "session-transition.v1",
    eventId: input.eventId,
    organisationId: input.state.state.identity.organisationId,
    actorId: input.state.state.identity.sessionId,
    streamId: input.state.state.identity.streamId,
    sequence: input.state.state.contract.lastEventSequence,
    sourceTime: { kind: "satyr", issuedAt: input.acceptedAt },
    acceptedAt: input.acceptedAt,
    correlationId: input.correlationId,
    causation: causationForOrigin(input.origin, input.commandId),
    idempotencyKey: input.idempotencyKey,
    runtimeRevision: input.state.state.contract.runtimeRevision,
    principal: principalForOrigin(input.origin),
    sensitivity: "organisation_private",
    retention: "session",
    body: input.body,
  };
}

function nextContract(
  contract: AgentSessionLifecycle["state"]["contract"],
): AgentSessionLifecycle["state"]["contract"] {
  return { ...contract, lastEventSequence: contract.lastEventSequence + 1 };
}

function validStartRequest(request: CanonicalTextTurnStartRequest): boolean {
  return (
    request.startId.length > 0 &&
    request.correlationId.length > 0 &&
    request.turnId.length > 0 &&
    request.input.inputId.length > 0 &&
    SHA256_PATTERN.test(request.input.contextBundleDigest) &&
    SHA256_PATTERN.test(request.authorityPartitionDigest) &&
    Number.isSafeInteger(request.acceptedAt) &&
    request.acceptedAt >= 0 &&
    Number.isSafeInteger(request.admittedAt) &&
    request.admittedAt >= request.acceptedAt &&
    Number.isSafeInteger(request.harnessLeaseExpiresAt) &&
    request.harnessLeaseExpiresAt > request.admittedAt &&
    validOrigin(request.origin)
  );
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function causationForOrigin(
  origin: CanonicalTextTurnOrigin,
  commandId: string,
): CausationRef {
  switch (origin.kind) {
    case "command":
      return { kind: "command", commandId };
    case "schedule":
      return { kind: "schedule", scheduleId: origin.scheduleId };
  }
}

function principalForOrigin(origin: CanonicalTextTurnOrigin): EventPrincipal {
  switch (origin.kind) {
    case "command":
      return origin.principal;
    case "schedule":
      return { kind: "system", componentId: origin.componentId };
  }
}

function validOrigin(origin: CanonicalTextTurnOrigin): boolean {
  switch (origin.kind) {
    case "command":
      return validPrincipal(origin.principal);
    case "schedule":
      return origin.scheduleId.length > 0 && origin.componentId.length > 0;
  }
}

function validPrincipal(principal: EventPrincipal): boolean {
  switch (principal.kind) {
    case "human":
      return principal.principalId.length > 0;
    case "agent":
      return principal.actorId.length > 0 && principal.sessionId.length > 0;
    case "application":
      return principal.applicationId.length > 0;
    case "system":
      return principal.componentId.length > 0;
  }
}

function startError(
  reason: string,
): Result<never, CanonicalTextTurnStartError> {
  return {
    ok: false,
    error: { code: "canonical_text_turn_start_invalid", reason },
  };
}
