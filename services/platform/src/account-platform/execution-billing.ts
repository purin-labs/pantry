import type {
  HarnessCheckpointRecord,
  HarnessTurnLease,
  ModelRoute,
} from "@seams/contracts";
import type { StrictUnion } from "@seams/type-utils";
import {
  assertNever,
  canonicalJson,
  hasExactKeys,
  isNonEmptyString,
  isRecord,
  parseJsonOrNull,
  sha256Hex,
} from "@seams/std";
import type { Env } from "../env";
import type { Result } from "../result";
import { preflightHarnessTurnLeaseInTransaction } from "../actors/agent-session-harness-authority";
import { createAccountPlatformClient } from "./client";
import { resolvePantryAccountBinding } from "./binding";
import {
  parseAccountScope,
  readAccountUsageReceipt,
  sameAccountScope,
  type AccountExecutionFunding,
  type AccountScope,
  type AccountUsageRequest,
  type AccountUsageReceipt,
  type PantryAccountBinding,
} from "./types";
import { armAlarmBy } from "../actors/lifecycle/actor-alarm";

const PREFIX = "account_execution:";
const PRICE_VERSION = "satyr-completed-turn-test-v1";
const RETRY_MS = 5_000;

type ExecutionIdentity = Readonly<{
  organisationId: string;
  scope: AccountScope;
  instanceId: string;
  sessionId: string;
  turnId: string;
  executionId: string;
  admittedAt: number;
  funding: AccountExecutionFunding;
}>;

type Terminal = StrictUnion<
  | Readonly<{
      kind: "completed";
      sourceRecordId: string;
      sourceDigest: string;
      occurredAt: number;
    }>
  | Readonly<{
      kind: "cancelled";
      sourceRecordId: string;
      canonicalReceipt: string;
      occurredAt: number;
    }>
>;

type Hold = Readonly<{ reservationId: string; createdAt: string }>;
type PaidPhase = StrictUnion<
  | Readonly<{
      kind: "reserve_pending";
      ending:
        | { kind: "open" }
        | {
            kind: "cancelled";
            terminal: Extract<Terminal, { kind: "cancelled" }>;
          };
    }>
  | Readonly<{ kind: "held"; hold: Hold }>
  | Readonly<{ kind: "dispatched"; hold: Hold }>
  | Readonly<{ kind: "indeterminate"; hold: Hold }>
  | Readonly<{ kind: "terminal_pending"; hold: Hold; terminal: Terminal }>
  | Readonly<{
      kind: "delivered";
      hold: Hold;
      terminal: Extract<Terminal, { kind: "completed" }>;
      receipt: Extract<AccountUsageReceipt, { kind: "charged" }>;
    }>
  | Readonly<{
      kind: "delivered";
      hold: Hold;
      terminal: Extract<Terminal, { kind: "cancelled" }>;
      receipt: {
        kind: "recorded_without_charge";
        reason: "nonbillable_outcome";
      };
    }>
>;
type UnpricedPhase = StrictUnion<
  | Readonly<{ kind: "admitted" }>
  | Readonly<{ kind: "dispatched" }>
  | Readonly<{ kind: "recorded"; terminal: Terminal }>
>;

export type PantryExecutionBilling = StrictUnion<
  | Readonly<{
      kind: "customer_unpriced";
      identity: ExecutionIdentity;
      phase: UnpricedPhase;
    }>
  | Readonly<{
      kind: "isolated_e2e_completed_turn";
      identity: ExecutionIdentity;
      priceVersion: typeof PRICE_VERSION;
      unitMinor: 1;
      phase: PaidPhase;
    }>
>;

export type PantryExecutionBillingError = Readonly<{
  code:
    | "account_execution_billing_unavailable"
    | "account_execution_billing_conflict"
    | "account_execution_billing_pending";
}>;

type Context = Readonly<{ env: Env; storage: DurableObjectStorage }>;
type BillingRow = {
  effect_id: string;
  organisation_id: string;
  originating_event_id: string;
  request_envelope: string;
  state_kind: string;
  state_projection: string;
  updated_at: number;
};

/**
 * The native binding and the current explicit fee policy for a turn that has
 * no billing yet. The reads have no effect, so they can run beside the turn's
 * authority check. A turn that already has billing reads nothing.
 */
export async function readPantryExecutionAdmissionBinding(
  context: Context,
  lease: HarnessTurnLease,
): Promise<Result<PantryAccountBinding | null, PantryExecutionBillingError>> {
  if (
    readPantryExecutionBilling(context.storage.sql, lease.turn.turnId) !== null
  )
    return { ok: true, value: null };
  const binding = await resolvePantryAccountBinding(
    context.env,
    lease.session.organisationId,
  );
  return binding.ok ? binding : unavailable();
}

/**
 * Admission retains the selected provider route. Account fees never select a
 * model route. Call it only after the turn's authority check passes: it writes
 * the billing record and can reserve funds.
 */
export async function admitPantryExecutionBilling(
  context: Context,
  input: Readonly<{
    lease: HarnessTurnLease;
    binding: PantryAccountBinding | null;
    modelRoute: ModelRoute;
    modelRouteDigest: string;
    continuation: "fresh" | "resume_turn";
  }>,
): Promise<Result<void, PantryExecutionBillingError>> {
  let operation = readPantryExecutionBilling(
    context.storage.sql,
    input.lease.turn.turnId,
  );
  if (operation !== null) {
    if (!sameExecution(operation.identity, input)) return conflict();
  } else {
    // No binding was read because the turn had billing then. Billing is never
    // admitted twice for one turn.
    if (input.binding === null) return conflict();
    const admitted = context.storage.transactionSync(
      writePantryExecutionAdmissionInTransaction.bind(
        null,
        context.storage.sql,
        {
          binding: input.binding,
          lease: input.lease,
          modelRoute: input.modelRoute,
          modelRouteDigest: input.modelRouteDigest,
          admittedAt: Date.now(),
        },
      ),
    );
    if (!admitted.ok) return admitted;
    operation = admitted.value;
  }
  if (operation.kind === "customer_unpriced") {
    switch (operation.phase.kind) {
      case "admitted":
        return { ok: true, value: undefined };
      case "dispatched":
        return input.continuation === "resume_turn"
          ? { ok: true, value: undefined }
          : pending();
      case "recorded":
        return conflict();
      default:
        return assertNever(operation.phase);
    }
  }
  await scheduleBilling(context.storage);
  if (operation.phase.kind === "reserve_pending") {
    await deliverBilling(context, operation);
    operation = readPantryExecutionBilling(
      context.storage.sql,
      input.lease.turn.turnId,
    );
    if (operation === null || operation.kind !== "isolated_e2e_completed_turn")
      return conflict();
  }
  switch (operation.phase.kind) {
    case "held":
      return { ok: true, value: undefined };
    case "dispatched":
    case "indeterminate":
      return input.continuation === "resume_turn"
        ? { ok: true, value: undefined }
        : pending();
    case "reserve_pending":
      return unavailable();
    case "terminal_pending":
    case "delivered":
      return conflict();
    default:
      return assertNever(operation.phase);
  }
}

/** Retain the resolved explicit fee policy and pinned funding before any account request. */
export function writePantryExecutionAdmissionInTransaction(
  sql: SqlStorage,
  input: Readonly<{
    binding: PantryAccountBinding;
    lease: HarnessTurnLease;
    modelRoute: ModelRoute;
    modelRouteDigest: string;
    admittedAt: number;
  }>,
): Result<PantryExecutionBilling, PantryExecutionBillingError> {
  // Cancellation can finish while the immutable binding and explicit fee policy load.
  if (
    input.binding.nativeOrganisationId !== input.lease.session.organisationId ||
    !preflightHarnessTurnLeaseInTransaction(sql, input.lease, input.admittedAt)
      .ok
  )
    return conflict();
  const identity: ExecutionIdentity = {
    organisationId: input.lease.session.organisationId,
    scope: input.binding.scope,
    instanceId: input.binding.instanceId,
    sessionId: input.lease.session.sessionId,
    turnId: input.lease.turn.turnId,
    executionId: JSON.stringify([
      input.lease.session.sessionId,
      input.lease.turn.turnId,
    ]),
    admittedAt: input.admittedAt,
    funding: executionFunding(input.modelRoute, input.modelRouteDigest),
  };
  let operation: PantryExecutionBilling;
  switch (input.binding.feePolicy.kind) {
    case "customer_unpriced":
      operation = {
        kind: "customer_unpriced",
        identity,
        phase: { kind: "admitted" },
      };
      break;
    case "isolated_e2e_completed_turn":
      operation = {
        kind: "isolated_e2e_completed_turn",
        identity,
        priceVersion: PRICE_VERSION,
        unitMinor: 1,
        phase: { kind: "reserve_pending", ending: { kind: "open" } },
      };
      break;
    default:
      return assertNever(input.binding.feePolicy);
  }
  const concurrent = readPantryExecutionBilling(sql, input.lease.turn.turnId);
  if (concurrent !== null) {
    if (
      concurrent.kind !== operation.kind ||
      concurrent.identity.instanceId !== identity.instanceId ||
      !sameAccountScope(concurrent.identity.scope, identity.scope) ||
      !sameExecution(concurrent.identity, input)
    )
      return conflict();
    return { ok: true, value: concurrent };
  }
  writeBilling(sql, operation);
  return { ok: true, value: operation };
}

/** Call synchronously after the final execution-authority check and before startTurn. */
export function markPantryExecutionDispatched(
  sql: SqlStorage,
  turnId: string,
): Result<void, PantryExecutionBillingError> {
  const operation = readPantryExecutionBilling(sql, turnId);
  if (operation === null) return conflict();
  if (operation.kind === "customer_unpriced") {
    if (operation.phase.kind === "recorded") return conflict();
    writeBilling(sql, {
      kind: operation.kind,
      identity: operation.identity,
      phase: { kind: "dispatched" },
    });
    return { ok: true, value: undefined };
  }
  switch (operation.phase.kind) {
    case "held":
    case "dispatched":
    case "indeterminate":
      writeBilling(
        sql,
        paidOperation(operation, {
          kind: "dispatched",
          hold: operation.phase.hold,
        }),
      );
      return { ok: true, value: undefined };
    case "reserve_pending":
    case "terminal_pending":
    case "delivered":
      return conflict();
    default:
      return assertNever(operation.phase);
  }
}

/** An issued provider request has no financial outcome until accepted native evidence exists. */
export function retainPantryExecutionUncertainty(
  sql: SqlStorage,
  turnId: string,
): void {
  const operation = readPantryExecutionBilling(sql, turnId);
  if (
    operation?.kind === "isolated_e2e_completed_turn" &&
    operation.phase.kind === "dispatched"
  ) {
    writeBilling(
      sql,
      paidOperation(operation, {
        kind: "indeterminate",
        hold: operation.phase.hold,
      }),
    );
  }
}

/** The caller owns the checkpoint, terminal-stream and outbox SQLite transaction. */
export function recordPantryTurnCompletionInTransaction(
  sql: SqlStorage,
  checkpoint: HarnessCheckpointRecord,
): Result<void, { code: "invalid_persisted_state" }> {
  const operation = readPantryExecutionBilling(sql, checkpoint.turn.turnId);
  if (
    operation === null ||
    operation.identity.sessionId !== checkpoint.session.sessionId ||
    operation.identity.organisationId !== checkpoint.session.organisationId ||
    operation.identity.funding.modelRouteDigest !== checkpoint.modelRouteDigest
  )
    return invalidState();
  const terminal: Terminal = {
    kind: "completed",
    sourceRecordId: `finalize_${checkpoint.turn.turnId}_${checkpoint.cursor.lastSequence}`,
    sourceDigest: checkpoint.blob.sha256,
    occurredAt: checkpoint.blob.createdAt,
  };
  return recordTerminal(sql, operation, terminal);
}

/** A fenced native cancellation proves that this turn cannot accept a completed checkpoint. */
export function recordPantryTurnCancellationInTransaction(
  sql: SqlStorage,
  input: Readonly<{
    turnId: string;
    sourceRecordId: string;
    canonicalReceipt: string;
    occurredAt: number;
  }>,
): Result<void, { code: "invalid_persisted_state" }> {
  const operation = readPantryExecutionBilling(sql, input.turnId);
  // Preparation can fail before account admission and before any provider dispatch.
  if (operation === null) return { ok: true, value: undefined };
  return recordTerminal(sql, operation, {
    kind: "cancelled",
    sourceRecordId: input.sourceRecordId,
    canonicalReceipt: input.canonicalReceipt,
    occurredAt: input.occurredAt,
  });
}

/** Accepted Session termination fences every unresolved turn in that Session. */
export function recordPantrySessionCancellationInTransaction(
  sql: SqlStorage,
  input: Readonly<{
    sessionId: string;
    sourceRecordId: string;
    sequence: number;
    occurredAt: number;
  }>,
): Result<void, { code: "invalid_persisted_state" }> {
  const rows = sql
    .exec<{ turn_id: string }>(
      "SELECT originating_event_id AS turn_id FROM actor_outbox WHERE effect_id GLOB ? ORDER BY effect_id",
      PREFIX + "*",
    )
    .toArray();
  for (const row of rows) {
    const operation = readPantryExecutionBilling(sql, row.turn_id);
    if (operation === null || operation.identity.sessionId !== input.sessionId)
      continue;
    if (
      operation.kind === "isolated_e2e_completed_turn" &&
      (operation.phase.kind === "terminal_pending" ||
        operation.phase.kind === "delivered" ||
        (operation.phase.kind === "reserve_pending" &&
          operation.phase.ending.kind === "cancelled"))
    )
      continue;
    if (
      operation.kind === "customer_unpriced" &&
      operation.phase.kind === "recorded"
    )
      continue;
    const recorded = recordTerminal(sql, operation, {
      kind: "cancelled",
      sourceRecordId: input.sourceRecordId,
      canonicalReceipt: canonicalJson({
        sessionId: input.sessionId,
        turnId: operation.identity.turnId,
        eventId: input.sourceRecordId,
        sequence: input.sequence,
        resolution: "terminal",
        acceptedAt: input.occurredAt,
      }),
      occurredAt: input.occurredAt,
    });
    if (!recorded.ok) return recorded;
  }
  return { ok: true, value: undefined };
}

/**
 * The pending and dispatching outbox effects other than Pantry's billing of
 * turns. A Session termination settles that billing itself.
 */
export function countOpenEffectsBesidesBilling(sql: SqlStorage): number {
  return sql
    .exec<{ count: number }>(
      "SELECT count(*) AS count FROM actor_outbox WHERE state_kind IN ('pending', 'dispatching') AND effect_id NOT GLOB ?",
      PREFIX + "*",
    )
    .one().count;
}

function recordTerminal(
  sql: SqlStorage,
  operation: PantryExecutionBilling,
  terminal: Terminal,
): Result<void, { code: "invalid_persisted_state" }> {
  if (operation.kind === "customer_unpriced") {
    if (operation.phase.kind === "recorded")
      return sameTerminal(operation.phase.terminal, terminal)
        ? { ok: true, value: undefined }
        : invalidState();
    if (terminal.kind === "completed" && operation.phase.kind !== "dispatched")
      return invalidState();
    writeBilling(sql, {
      kind: operation.kind,
      identity: operation.identity,
      phase: { kind: "recorded", terminal },
    });
    return { ok: true, value: undefined };
  }
  switch (operation.phase.kind) {
    case "reserve_pending":
      if (terminal.kind !== "cancelled") return invalidState();
      if (
        operation.phase.ending.kind === "cancelled" &&
        !sameTerminal(operation.phase.ending.terminal, terminal)
      )
        return invalidState();
      writeBilling(
        sql,
        paidOperation(operation, {
          kind: "reserve_pending",
          ending: { kind: "cancelled", terminal },
        }),
      );
      return { ok: true, value: undefined };
    case "held":
      if (terminal.kind === "completed") return invalidState();
      writeBilling(
        sql,
        paidOperation(operation, {
          kind: "terminal_pending",
          hold: operation.phase.hold,
          terminal,
        }),
      );
      return { ok: true, value: undefined };
    case "dispatched":
    case "indeterminate":
      writeBilling(
        sql,
        paidOperation(operation, {
          kind: "terminal_pending",
          hold: operation.phase.hold,
          terminal,
        }),
      );
      return { ok: true, value: undefined };
    case "terminal_pending":
    case "delivered":
      return sameTerminal(operation.phase.terminal, terminal)
        ? { ok: true, value: undefined }
        : invalidState();
    default:
      return assertNever(operation.phase);
  }
}

/** Producer delivery deliberately has no user-session or active-instance admission. */
export async function reconcilePantryExecutionBilling(
  context: Context,
): Promise<void> {
  const rows = context.storage.sql
    .exec<{ turn_id: string }>(
      "SELECT originating_event_id AS turn_id FROM actor_outbox WHERE effect_id GLOB ? AND state_kind IN ('pending', 'dispatching', 'indeterminate') ORDER BY updated_at, effect_id",
      PREFIX + "*",
    )
    .toArray();
  for (const row of rows) {
    const operation = readPantryExecutionBilling(
      context.storage.sql,
      row.turn_id,
    );
    if (operation !== null && operation.kind === "isolated_e2e_completed_turn")
      await deliverBilling(context, operation);
  }
  if (hasPendingBilling(context.storage.sql))
    await scheduleBilling(context.storage);
}

async function deliverBilling(
  context: Context,
  operation: Extract<
    PantryExecutionBilling,
    { kind: "isolated_e2e_completed_turn" }
  >,
): Promise<void> {
  const client = createAccountPlatformClient(context.env);
  if (!client.ok) return;
  const identity = operation.identity;
  switch (operation.phase.kind) {
    case "reserve_pending": {
      const reserved = await client.value.reserveFunds({
        version: 1,
        operationId: operationId(identity, "reserve"),
        instanceId: identity.instanceId,
        executionId: identity.executionId,
        requestedMinor: operation.unitMinor,
        priceVersion: operation.priceVersion,
      });
      if (!reserved.ok) return;
      const reservation = reserved.value.reservation;
      if (
        reservation.instanceId !== identity.instanceId ||
        !sameAccountScope(reservation.scope, identity.scope) ||
        reservation.executionId !== identity.executionId ||
        reservation.requestedMinor !== operation.unitMinor ||
        reservation.priceVersion !== operation.priceVersion ||
        reservation.kind !== "reserved"
      )
        return;
      const current = readPantryExecutionBilling(
        context.storage.sql,
        identity.turnId,
      );
      if (
        current?.kind !== "isolated_e2e_completed_turn" ||
        current.phase.kind !== "reserve_pending"
      )
        return;
      const hold: Hold = {
        reservationId: reservation.reservationId,
        createdAt: reservation.createdAt,
      };
      const phase: PaidPhase =
        current.phase.ending.kind === "cancelled"
          ? {
              kind: "terminal_pending",
              hold,
              terminal: current.phase.ending.terminal,
            }
          : { kind: "held", hold };
      const accepted = paidOperation(current, phase);
      // Acknowledgement is durable before any caller may dispatch the provider.
      writeBilling(context.storage.sql, accepted);
      if (accepted.phase.kind === "terminal_pending")
        await deliverBilling(context, accepted);
      return;
    }
    case "held":
      return;
    case "dispatched":
    case "indeterminate": {
      const marked = await client.value.markIndeterminate({
        version: 1,
        operationId: operationId(identity, "indeterminate"),
        reservationId: operation.phase.hold.reservationId,
        executionId: identity.executionId,
      });
      if (!marked.ok) return;
      const current = readPantryExecutionBilling(
        context.storage.sql,
        identity.turnId,
      );
      if (
        current?.kind === "isolated_e2e_completed_turn" &&
        (current.phase.kind === "dispatched" ||
          current.phase.kind === "indeterminate")
      )
        writeBilling(
          context.storage.sql,
          paidOperation(current, {
            kind: "indeterminate",
            hold: current.phase.hold,
          }),
        );
      return;
    }
    case "terminal_pending": {
      const terminal = operation.phase.terminal;
      const sourceDigest =
        terminal.kind === "completed"
          ? terminal.sourceDigest
          : await sha256Hex(terminal.canonicalReceipt);
      const receipt = await client.value.recordUsage(
        terminalUsageRequest(
          identity,
          operation.phase.hold,
          terminal,
          sourceDigest,
        ),
      );
      if (!receipt.ok) return;
      const delivered = deliveredPhase(
        operation.phase.hold,
        terminal,
        receipt.value,
      );
      if (delivered === null) return;
      const current = readPantryExecutionBilling(
        context.storage.sql,
        identity.turnId,
      );
      if (
        current?.kind === "isolated_e2e_completed_turn" &&
        current.phase.kind === "terminal_pending" &&
        sameTerminal(current.phase.terminal, terminal)
      )
        writeBilling(context.storage.sql, paidOperation(current, delivered));
      return;
    }
    case "delivered":
      return;
    default:
      return assertNever(operation.phase);
  }
}

function operationId(
  identity: ExecutionIdentity,
  action: "reserve" | "indeterminate",
): string {
  return JSON.stringify([
    "satyr",
    identity.instanceId,
    identity.sessionId,
    identity.turnId,
    action,
  ]);
}

function terminalUsageRequest(
  identity: ExecutionIdentity,
  hold: Hold,
  terminal: Terminal,
  sourceDigest: string,
): AccountUsageRequest {
  const eventId = JSON.stringify([
    "satyr",
    identity.instanceId,
    identity.sessionId,
    identity.turnId,
    "terminal",
  ]);
  const occurredAt = new Date(terminal.occurredAt).toISOString();
  switch (terminal.kind) {
    case "completed":
      return {
        version: 1,
        eventId,
        instanceId: identity.instanceId,
        occurredAt,
        meterId: "satyr.completed_turn.test",
        quantity: 1,
        unit: "turn",
        evidence: {
          kind: "satyr_turn",
          sessionId: identity.sessionId,
          turnId: identity.turnId,
          terminalOutcome: "completed",
          reservationId: hold.reservationId,
          sourceRecordId: terminal.sourceRecordId,
          sourceDigest,
          funding: identity.funding,
        },
      };
    case "cancelled":
      return {
        version: 1,
        eventId,
        instanceId: identity.instanceId,
        occurredAt,
        meterId: "satyr.completed_turn.test",
        quantity: 0,
        unit: "turn",
        evidence: {
          kind: "satyr_turn",
          sessionId: identity.sessionId,
          turnId: identity.turnId,
          terminalOutcome: "cancelled",
          reservationId: hold.reservationId,
          sourceRecordId: terminal.sourceRecordId,
          sourceDigest,
          funding: identity.funding,
        },
      };
    default:
      return assertNever(terminal);
  }
}

function deliveredPhase(
  hold: Hold,
  terminal: Terminal,
  receipt: AccountUsageReceipt,
): Extract<PaidPhase, { kind: "delivered" }> | null {
  switch (terminal.kind) {
    case "completed":
      if (
        receipt.kind !== "charged" ||
        receipt.amountMinor !== 1 ||
        receipt.priceVersion !== PRICE_VERSION
      )
        return null;
      return { kind: "delivered", hold, terminal, receipt };
    case "cancelled":
      if (
        receipt.kind !== "recorded_without_charge" ||
        receipt.reason !== "nonbillable_outcome"
      )
        return null;
      return {
        kind: "delivered",
        hold,
        terminal,
        receipt: {
          kind: "recorded_without_charge",
          reason: "nonbillable_outcome",
        },
      };
    default:
      return assertNever(terminal);
  }
}

function executionFunding(
  route: ModelRoute,
  modelRouteDigest: string,
): AccountExecutionFunding {
  switch (route.keySource) {
    case "platform":
      return {
        kind: "platform",
        selection: "satyr_platform",
        modelRouteDigest,
      };
    case "organisation_byo":
      switch (route.provider) {
        case "openai":
          return {
            kind: "customer",
            selection: "organisation_openai_api_key",
            modelRouteDigest,
          };
        case "anthropic":
          return {
            kind: "customer",
            selection: "organisation_anthropic_api_key",
            modelRouteDigest,
          };
        default:
          return assertNever(route);
      }
    case "organisation_oauth":
      return { kind: "customer", selection: "claude_oauth", modelRouteDigest };
    case "organisation_subscription":
      return {
        kind: "customer",
        selection: "codex_subscription",
        modelRouteDigest,
      };
    default:
      return assertNever(route);
  }
}

function sameExecution(
  identity: ExecutionIdentity,
  input: Readonly<{
    lease: HarnessTurnLease;
    modelRoute: ModelRoute;
    modelRouteDigest: string;
  }>,
): boolean {
  return (
    identity.organisationId === input.lease.session.organisationId &&
    identity.sessionId === input.lease.session.sessionId &&
    identity.turnId === input.lease.turn.turnId &&
    canonicalJson(identity.funding) ===
      canonicalJson(executionFunding(input.modelRoute, input.modelRouteDigest))
  );
}

function sameTerminal(left: Terminal, right: Terminal): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function paidOperation(
  operation: Extract<
    PantryExecutionBilling,
    { kind: "isolated_e2e_completed_turn" }
  >,
  phase: PaidPhase,
): Extract<PantryExecutionBilling, { kind: "isolated_e2e_completed_turn" }> {
  return {
    kind: operation.kind,
    identity: operation.identity,
    priceVersion: operation.priceVersion,
    unitMinor: operation.unitMinor,
    phase,
  };
}

function writeBilling(sql: SqlStorage, operation: PantryExecutionBilling): void {
  sql.exec(
    `INSERT INTO actor_outbox (effect_id, organisation_id, originating_event_id, request_envelope, state_kind, state_projection, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (effect_id) DO UPDATE SET state_kind = excluded.state_kind, state_projection = excluded.state_projection, updated_at = excluded.updated_at`,
    billingEffectId(operation.identity),
    operation.identity.organisationId,
    operation.identity.turnId,
    JSON.stringify(
      operation.kind === "customer_unpriced"
        ? { version: 1, kind: operation.kind, identity: operation.identity }
        : {
            version: 1,
            kind: operation.kind,
            identity: operation.identity,
            priceVersion: operation.priceVersion,
            unitMinor: operation.unitMinor,
          },
    ),
    outboxState(operation),
    JSON.stringify(operation.phase),
    Date.now(),
  );
}

function outboxState(
  operation: PantryExecutionBilling,
): "pending" | "dispatching" | "indeterminate" | "settled" {
  // Explicit unpriced policy settles the fee locally. Native harness state still owns provider execution.
  if (operation.kind === "customer_unpriced") return "settled";
  switch (operation.phase.kind) {
    case "reserve_pending":
    case "held":
    case "terminal_pending":
      return "pending";
    case "dispatched":
      return "dispatching";
    case "indeterminate":
      return "indeterminate";
    case "delivered":
      return "settled";
    default:
      return assertNever(operation.phase);
  }
}

function hasPendingBilling(sql: SqlStorage): boolean {
  return (
    sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM actor_outbox WHERE effect_id GLOB ? AND state_kind IN ('pending', 'dispatching', 'indeterminate')",
        PREFIX + "*",
      )
      .one().count > 0
  );
}
async function scheduleBilling(storage: DurableObjectStorage): Promise<void> {
  await armAlarmBy(storage, Date.now() + RETRY_MS);
}

export function readPantryExecutionBilling(
  sql: SqlStorage,
  turnId: string,
): PantryExecutionBilling | null {
  const rows = sql
    .exec<BillingRow>(
      "SELECT effect_id, organisation_id, originating_event_id, request_envelope, state_kind, state_projection, updated_at FROM actor_outbox WHERE effect_id GLOB ? AND originating_event_id = ?",
      PREFIX + "*",
      turnId,
    )
    .toArray();
  if (rows.length === 0) return null;
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("account_execution_billing_invalid");
  const envelope = parseJsonOrNull(rows[0].request_envelope);
  const rawPhase = parseJsonOrNull(rows[0].state_projection);
  if (!isRecord(envelope) || envelope.version !== 1)
    throw new Error("account_execution_billing_invalid");
  const identity = parseIdentity(envelope.identity);
  if (identity === null || identity.turnId !== turnId)
    throw new Error("account_execution_billing_invalid");
  switch (envelope.kind) {
    case "customer_unpriced": {
      const phase = parseUnpricedPhase(rawPhase);
      if (
        !hasExactKeys(envelope, ["version", "kind", "identity"]) ||
        phase === null
      )
        throw new Error("account_execution_billing_invalid");
      return checkedStoredBilling(rows[0], {
        kind: envelope.kind,
        identity,
        phase,
      });
    }
    case "isolated_e2e_completed_turn": {
      const phase = parsePaidPhase(rawPhase);
      if (
        !hasExactKeys(envelope, [
          "version",
          "kind",
          "identity",
          "priceVersion",
          "unitMinor",
        ]) ||
        envelope.priceVersion !== PRICE_VERSION ||
        envelope.unitMinor !== 1 ||
        phase === null
      )
        throw new Error("account_execution_billing_invalid");
      return checkedStoredBilling(rows[0], {
        kind: envelope.kind,
        identity,
        priceVersion: PRICE_VERSION,
        unitMinor: 1,
        phase,
      });
    }
    default:
      throw new Error("account_execution_billing_invalid");
  }
}

function billingEffectId(identity: ExecutionIdentity): string {
  return (
    PREFIX +
    JSON.stringify([identity.instanceId, identity.sessionId, identity.turnId])
  );
}

function checkedStoredBilling(
  row: BillingRow,
  operation: PantryExecutionBilling,
): PantryExecutionBilling {
  if (
    row.effect_id !== billingEffectId(operation.identity) ||
    row.organisation_id !== operation.identity.organisationId ||
    row.originating_event_id !== operation.identity.turnId ||
    row.state_kind !== outboxState(operation) ||
    !isTimestamp(row.updated_at)
  )
    throw new Error("account_execution_billing_invalid");
  return operation;
}

function parseIdentity(value: unknown): ExecutionIdentity | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "organisationId",
      "scope",
      "instanceId",
      "sessionId",
      "turnId",
      "executionId",
      "admittedAt",
      "funding",
    ]) ||
    !isNonEmptyString(value.organisationId) ||
    !isNonEmptyString(value.instanceId) ||
    !isNonEmptyString(value.sessionId) ||
    !isNonEmptyString(value.turnId) ||
    value.executionId !== JSON.stringify([value.sessionId, value.turnId]) ||
    !isTimestamp(value.admittedAt)
  )
    return null;
  const funding = parseFunding(value.funding);
  if (funding === null) return null;
  return {
    organisationId: value.organisationId,
    scope: parseAccountScope(value.scope),
    instanceId: value.instanceId,
    sessionId: value.sessionId,
    turnId: value.turnId,
    executionId: value.executionId,
    admittedAt: value.admittedAt,
    funding,
  };
}
function parseFunding(value: unknown): AccountExecutionFunding | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["kind", "selection", "modelRouteDigest"]) ||
    !isDigest(value.modelRouteDigest)
  )
    return null;
  switch (value.kind) {
    case "platform":
      return value.selection === "satyr_platform"
        ? {
            kind: value.kind,
            selection: value.selection,
            modelRouteDigest: value.modelRouteDigest,
          }
        : null;
    case "customer":
      switch (value.selection) {
        case "organisation_openai_api_key":
        case "organisation_anthropic_api_key":
        case "claude_oauth":
        case "codex_subscription":
          return {
            kind: value.kind,
            selection: value.selection,
            modelRouteDigest: value.modelRouteDigest,
          };
        default:
          return null;
      }
    default:
      return null;
  }
}
function parseTerminal(value: unknown): Terminal | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.sourceRecordId) ||
    !isTimestamp(value.occurredAt)
  )
    return null;
  switch (value.kind) {
    case "completed":
      return hasExactKeys(value, [
        "kind",
        "sourceRecordId",
        "sourceDigest",
        "occurredAt",
      ]) && isDigest(value.sourceDigest)
        ? {
            kind: value.kind,
            sourceRecordId: value.sourceRecordId,
            sourceDigest: value.sourceDigest,
            occurredAt: value.occurredAt,
          }
        : null;
    case "cancelled":
      return hasExactKeys(value, [
        "kind",
        "sourceRecordId",
        "canonicalReceipt",
        "occurredAt",
      ]) &&
        isNonEmptyString(value.canonicalReceipt) &&
        isRecord(parseJsonOrNull(value.canonicalReceipt))
        ? {
            kind: value.kind,
            sourceRecordId: value.sourceRecordId,
            canonicalReceipt: value.canonicalReceipt,
            occurredAt: value.occurredAt,
          }
        : null;
    default:
      return null;
  }
}
function parseHold(value: unknown): Hold | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["reservationId", "createdAt"]) ||
    !isNonEmptyString(value.reservationId) ||
    !isNonEmptyString(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    return null;
  return { reservationId: value.reservationId, createdAt: value.createdAt };
}
function parseUnpricedPhase(value: unknown): UnpricedPhase | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "admitted":
    case "dispatched":
      return hasExactKeys(value, ["kind"]) ? { kind: value.kind } : null;
    case "recorded": {
      const terminal = parseTerminal(value.terminal);
      return hasExactKeys(value, ["kind", "terminal"]) && terminal !== null
        ? { kind: value.kind, terminal }
        : null;
    }
    default:
      return null;
  }
}
function parsePaidPhase(value: unknown): PaidPhase | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "reserve_pending": {
      if (!hasExactKeys(value, ["kind", "ending"]) || !isRecord(value.ending))
        return null;
      if (value.ending.kind === "open" && hasExactKeys(value.ending, ["kind"]))
        return { kind: value.kind, ending: { kind: "open" } };
      const terminal = parseTerminal(value.ending.terminal);
      return value.ending.kind === "cancelled" &&
        hasExactKeys(value.ending, ["kind", "terminal"]) &&
        terminal?.kind === "cancelled"
        ? { kind: value.kind, ending: { kind: "cancelled", terminal } }
        : null;
    }
    case "held":
    case "dispatched":
    case "indeterminate": {
      const hold = parseHold(value.hold);
      return hasExactKeys(value, ["kind", "hold"]) && hold !== null
        ? { kind: value.kind, hold }
        : null;
    }
    case "terminal_pending": {
      const hold = parseHold(value.hold);
      const terminal = parseTerminal(value.terminal);
      return hasExactKeys(value, ["kind", "hold", "terminal"]) &&
        hold !== null &&
        terminal !== null
        ? { kind: value.kind, hold, terminal }
        : null;
    }
    case "delivered": {
      if (!hasExactKeys(value, ["kind", "hold", "terminal", "receipt"]))
        return null;
      const hold = parseHold(value.hold);
      const terminal = parseTerminal(value.terminal);
      return hold !== null && terminal !== null
        ? deliveredPhase(hold, terminal, readAccountUsageReceipt(value.receipt))
        : null;
    }
    default:
      return null;
  }
}
function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function conflict(): Result<never, PantryExecutionBillingError> {
  return { ok: false, error: { code: "account_execution_billing_conflict" } };
}
function pending(): Result<never, PantryExecutionBillingError> {
  return { ok: false, error: { code: "account_execution_billing_pending" } };
}
function unavailable(): Result<never, PantryExecutionBillingError> {
  return {
    ok: false,
    error: { code: "account_execution_billing_unavailable" },
  };
}
function invalidState(): Result<never, { code: "invalid_persisted_state" }> {
  return { ok: false, error: { code: "invalid_persisted_state" } };
}
