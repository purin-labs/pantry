import {
  parseRequestId,
  parseSessionId,
  parseOrganisationId,
  type RequestId,
  type SessionId,
  type OrganisationId,
} from "../ids";
import type { Result } from "../result";
import { isNonNegativeInteger, isPositiveInteger, isRecord } from "@purin-labs/std";
import type { CodeModeExecutionOutcome } from "@purin-labs/contracts";

const EXECUTION_ID_PATTERN = /^cmx-[a-zA-Z0-9_-]{1,120}$/;
const OPAQUE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,191}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DAY_MS = 86_400_000;
const PILOT_ORGANISATION_DAILY_COST_MICROS = 25_000_000;
const PILOT_ORGANISATION_MONTHLY_COST_MICROS = 250_000_000;
const PILOT_ORGANISATION_MAX_CONCURRENT_EXECUTIONS = 2;
const PILOT_EXECUTION_CLEANUP_MARGIN_MS = 5_000;
const WORKSPACE_ALLOCATION_ID_PATTERN = /^wxa-[a-zA-Z0-9_-]{1,120}$/;

export const CODE_MODE_PRICE_BOOK_REVISION_V2 = "code-mode-price-book-v2";
/** What price book v2 reserves for the engine of one script. */
export const CODE_MODE_ENGINE_RESERVED_COST_MICROS = 1_000;
export const WORKSPACE_EXECUTOR_RESERVED_COST_MICROS = 250;

export const WORKSPACE_EXECUTOR_ALLOCATION_PROFILE = {
  kind: "workspace_executor_container",
  instanceType: "lite",
  network: "denied",
  maxDurationMs: 30_000,
  // Matches the executor's own attachment cap. Raising this changes the
  // persisted profile field-by-field, which quarantines in-flight allocation
  // intents: drain pending workspace allocations before deploying it.
  maxInputBytes: 32 * 1024 * 1024,
  maxOutputBytes: 1_048_576,
  maxAllocations: 1,
} as const;

export const CODE_MODE_PILOT_BUDGET: CodeModeBudget = {
  maxDurationMs: 30_000,
  maxCapabilityCalls: 8,
  maxConcurrentCalls: 2,
  maxSourceBytes: 65_536,
  maxOutputBytes: 24_576,
};

/**
 * Where the generated code of one execution runs, and under which build: the
 * QuickJS VM of the sandbox Worker.
 */
export type CodeModePlacement = {
  readonly kind: "cloudflare_sandbox_worker";
  readonly adapterRevision: string;
  /** The pinned Pi Code Mode package that the sandbox Worker serves. */
  readonly packageVersion: string;
  readonly reason: "generated_javascript_remote_execution";
  readonly evidenceDigest: string;
};

export type CodeModeBudget = {
  readonly maxDurationMs: number;
  readonly maxCapabilityCalls: number;
  readonly maxConcurrentCalls: number;
  readonly maxSourceBytes: number;
  readonly maxOutputBytes: number;
};

export type CodeModeOrganisationReserveInput = {
  readonly requestId: RequestId;
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
  readonly turnId: string;
  readonly runtimeGeneration: number;
  readonly executionId: string;
  readonly idempotencyKey: string;
  readonly leaseId: string;
  readonly executionDeadlineAt: number;
  readonly leaseExpiresAt: number;
  readonly admissionDigest: string;
  readonly programDigest: string;
  readonly requirementsDigest: string;
  readonly policyDigest: string;
  readonly catalogDigest: string;
  readonly routerRevision: string;
  readonly runtimeRevision: string;
  readonly priceBookRevision: string;
  readonly placement: CodeModePlacement;
  readonly budget: CodeModeBudget;
  readonly reservedCostMicros: number;
  readonly customerDisposition: "included_interactive";
  readonly now: number;
};

export type CodeModeOrganisationSettleInput = {
  readonly requestId: RequestId;
  readonly organisationId: OrganisationId;
  readonly executionId: string;
  readonly leaseId: string;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly actualCostMicros: number;
  readonly capabilityCalls: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly outcome: CodeModeExecutionOutcome;
  readonly now: number;
};

export type CodeModeCapabilityClaimInput = {
  readonly requestId: RequestId;
  readonly organisationId: OrganisationId;
  readonly executionId: string;
  readonly leaseId: string;
  readonly callId: string;
  readonly inputBytes: number;
  readonly now: number;
};

export type CodeModeCapabilityCompleteInput = {
  readonly requestId: RequestId;
  readonly organisationId: OrganisationId;
  readonly executionId: string;
  readonly leaseId: string;
  readonly callId: string;
  readonly outputBytes: number;
  readonly now: number;
};

/** Names the execution whose abandoned capability calls end. */
export type CodeModeCapabilityAbandonInput = {
  readonly requestId: RequestId;
  readonly organisationId: OrganisationId;
  readonly executionId: string;
  readonly leaseId: string;
  readonly now: number;
};

export type CodeModeCapabilityCounter = {
  readonly executionId: string;
  readonly capabilityCalls: number;
  readonly inFlightCalls: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
};

export type CodeModeOrganisationCancelInput = {
  readonly requestId: RequestId;
  readonly organisationId: OrganisationId;
  readonly executionId: string;
  readonly leaseId: string;
  readonly reason: "admission_compensated" | "turn_cancelled";
  readonly now: number;
};

/**
 * The renewable part of an execution's authority. The execution identity,
 * its admission digest, its deadline, and its accounting stay with the
 * reservation. A recovered Session Actor binds them to the lease of its new
 * runtime generation.
 */
export type CodeModeLeaseBinding = {
  readonly leaseId: string;
  readonly runtimeGeneration: number;
};

export type CodeModeLeaseRebindInput = {
  readonly requestId: RequestId;
  readonly organisationId: OrganisationId;
  readonly executionId: string;
  readonly admissionDigest: string;
  readonly previous: CodeModeLeaseBinding;
  readonly next: CodeModeLeaseBinding;
  readonly now: number;
};

type CodeModeLeaseRebindDecision = "rebind" | "already_bound" | "conflict";

export type CodeModeOrganisationReconcileInput = {
  readonly requestId: RequestId;
  readonly organisationId: OrganisationId;
  readonly executionId: string;
  readonly receiptId: string;
  readonly providerCostMicros: number;
  readonly now: number;
};

type WorkspaceExecutorAllocationProfile =
  typeof WORKSPACE_EXECUTOR_ALLOCATION_PROFILE;

export type WorkspaceExecutorAllocationParent =
  | {
      readonly kind: "code_mode_execution";
      readonly executionId: string;
      readonly leaseId: string;
      readonly preparationId?: never;
      readonly sessionId?: never;
      readonly turnId?: never;
      readonly runtimeGeneration?: never;
    }
  | {
      readonly kind: "attachment_preparation";
      readonly preparationId: string;
      readonly leaseId: string;
      readonly sessionId: SessionId;
      readonly turnId: string;
      readonly runtimeGeneration: number;
      readonly executionId?: never;
    };

export type WorkspaceExecutorAllocationReserveInput = {
  readonly requestId: RequestId;
  readonly organisationId: OrganisationId;
  readonly parent: WorkspaceExecutorAllocationParent;
  readonly allocationId: string;
  readonly idempotencyKey: string;
  readonly allocationDigest: string;
  readonly priceBookRevision: typeof CODE_MODE_PRICE_BOOK_REVISION_V2;
  readonly profile: WorkspaceExecutorAllocationProfile;
  readonly reservedCostMicros: typeof WORKSPACE_EXECUTOR_RESERVED_COST_MICROS;
  readonly executionDeadlineAt: number;
  readonly leaseExpiresAt: number;
  readonly now: number;
};

export type WorkspaceExecutorAllocationSettleInput = {
  readonly requestId: RequestId;
  readonly organisationId: OrganisationId;
  readonly parent: WorkspaceExecutorAllocationParent;
  readonly allocationId: string;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly actualCostMicros: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly durationMs: number;
  readonly outcome: CodeModeOrganisationSettleInput["outcome"];
  readonly now: number;
};

export type WorkspaceExecutorAllocationCancelInput = {
  readonly requestId: RequestId;
  readonly organisationId: OrganisationId;
  readonly parent: WorkspaceExecutorAllocationParent;
  readonly allocationId: string;
  readonly reason: CodeModeOrganisationCancelInput["reason"];
  readonly now: number;
};

type WorkspaceExecutorAllocationIdentity = {
  readonly organisationId: OrganisationId;
  readonly parent: WorkspaceExecutorAllocationParent;
  readonly allocationId: string;
  readonly idempotencyKey: string;
  readonly allocationDigest: string;
};

export type WorkspaceExecutorAllocationReservation =
  | (WorkspaceExecutorAllocationIdentity & {
      readonly kind: "reserved";
      readonly priceBookRevision: typeof CODE_MODE_PRICE_BOOK_REVISION_V2;
      readonly profile: WorkspaceExecutorAllocationProfile;
      readonly reservedCostMicros: typeof WORKSPACE_EXECUTOR_RESERVED_COST_MICROS;
      readonly executionDeadlineAt: number;
      readonly leaseExpiresAt: number;
    })
  | (WorkspaceExecutorAllocationIdentity & {
      readonly kind: "settled";
      readonly receiptId: string;
      readonly receiptDigest: string;
      readonly reservedCostMicros: typeof WORKSPACE_EXECUTOR_RESERVED_COST_MICROS;
      readonly actualCostMicros: number;
      readonly inputBytes: number;
      readonly outputBytes: number;
      readonly durationMs: number;
      readonly outcome: CodeModeOrganisationSettleInput["outcome"];
      readonly settledAt: number;
    })
  | (WorkspaceExecutorAllocationIdentity & {
      readonly kind: "cancelled";
      readonly reason: CodeModeOrganisationCancelInput["reason"];
      readonly cancelledAt: number;
    })
  | (WorkspaceExecutorAllocationIdentity & {
      readonly kind: "expired";
      readonly expiredAt: number;
    });

type CodeModeReservationIdentity = {
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
  readonly turnId: string;
  readonly runtimeGeneration: number;
  readonly executionId: string;
  readonly idempotencyKey: string;
  readonly leaseId: string;
};

export type CodeModeOrganisationReservation =
  | (CodeModeReservationIdentity & {
      readonly kind: "reserved";
      readonly reservedCostMicros: number;
      readonly leaseExpiresAt: number;
      readonly priceBookRevision: string;
    })
  | (CodeModeReservationIdentity & {
      readonly kind: "settled";
      readonly reservedCostMicros: number;
      readonly receiptId: string;
      readonly receiptDigest: string;
      readonly actualCostMicros: number;
      readonly outcome: CodeModeExecutionOutcome;
      readonly settledAt: number;
      readonly priceBookRevision: string;
    })
  | (CodeModeReservationIdentity & {
      readonly kind: "reconciled";
      readonly reservedCostMicros: number;
      readonly receiptId: string;
      readonly receiptDigest: string;
      readonly actualCostMicros: number;
      readonly providerCostMicros: number;
      readonly outcome: CodeModeExecutionOutcome;
      readonly settledAt: number;
      readonly reconciledAt: number;
      readonly priceBookRevision: string;
    })
  | (CodeModeReservationIdentity & {
      readonly kind: "cancelled";
      readonly reason: "admission_compensated" | "turn_cancelled";
      readonly cancelledAt: number;
    })
  | (CodeModeReservationIdentity & {
      readonly kind: "expired";
      readonly expiredAt: number;
    });

export type CodeModeBudgetError =
  | { readonly code: "invalid_code_mode_budget_input"; readonly field: string }
  | { readonly code: "code_mode_reservation_conflict" }
  | { readonly code: "code_mode_reservation_not_found" }
  | { readonly code: "code_mode_reservation_lease_conflict" }
  | {
      readonly code: "code_mode_reservation_expired";
      readonly leaseExpiresAt: number;
    }
  | {
      readonly code: "code_mode_reservation_invalid_transition";
      readonly state: string;
    }
  | {
      readonly code: "code_mode_cost_exceeds_reservation";
      readonly reservedCostMicros: number;
    }
  | { readonly code: "code_mode_organisation_daily_budget_exceeded" }
  | { readonly code: "code_mode_organisation_monthly_budget_exceeded" }
  | { readonly code: "code_mode_organisation_concurrency_exceeded" }
  | { readonly code: "code_mode_execution_deadline_elapsed" }
  | { readonly code: "code_mode_capability_call_limit_exceeded" }
  | { readonly code: "code_mode_capability_concurrency_exceeded" }
  | { readonly code: "code_mode_capability_input_limit_exceeded" }
  | { readonly code: "code_mode_capability_output_limit_exceeded" }
  | { readonly code: "code_mode_capability_call_not_found" }
  | { readonly code: "code_mode_capability_calls_in_flight" }
  | { readonly code: "code_mode_workspace_allocation_limit_exceeded" };

type CounterRow = Record<string, SqlStorageValue> & {
  execution_id: string;
  capability_calls: number;
  in_flight_calls: number;
  input_bytes: number;
  output_bytes: number;
};

type CallRow = Record<string, SqlStorageValue> & {
  state: string;
  admission_digest: string;
  input_bytes: number;
  output_bytes: number | null;
};

type ReceiptRow = Record<string, SqlStorageValue> & {
  receipt_id: string;
  receipt_digest: string;
  actual_cost_micros: number;
  capability_calls: number;
  input_bytes: number;
  output_bytes: number;
  outcome: string;
};

type ReservationRow = Record<string, SqlStorageValue> & {
  admission_digest: string;
  organisation_id: string;
  session_id: string;
  turn_id: string;
  runtime_generation: number;
  execution_id: string;
  idempotency_key: string;
  lease_id: string;
  state: string;
  program_digest: string;
  requirements_digest: string;
  policy_digest: string;
  catalog_digest: string;
  router_revision: string;
  runtime_revision: string;
  placement_json: string;
  budget_json: string;
  customer_disposition: string;
  reserved_cost_micros: number;
  execution_deadline_at: number;
  lease_expires_at: number | null;
  price_book_revision: string;
  receipt_id: string | null;
  receipt_digest: string | null;
  actual_cost_micros: number | null;
  outcome: string | null;
  terminal_at: number | null;
  terminal_reason: string | null;
  provider_cost_micros: number | null;
  reconciled_at: number | null;
};

type ReconciliationRow = Record<string, SqlStorageValue> & {
  provider_cost_micros: number;
  reconciled_at: number;
};

type WorkspaceAllocationRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  parent_kind: string;
  parent_id: string;
  parent_lease_id: string;
  session_id: string;
  turn_id: string;
  runtime_generation: number;
  allocation_id: string;
  idempotency_key: string;
  allocation_digest: string;
  state: string;
  utc_day: string;
  utc_month: string;
  price_book_revision: string;
  profile_json: string;
  reserved_cost_micros: number;
  execution_deadline_at: number;
  lease_expires_at: number | null;
  receipt_id: string | null;
  receipt_digest: string | null;
  actual_cost_micros: number | null;
  input_bytes: number | null;
  output_bytes: number | null;
  duration_ms: number | null;
  outcome: string | null;
  terminal_at: number | null;
  terminal_reason: string | null;
};

type TableInfoRow = Record<string, SqlStorageValue> & {
  name: string;
};

const WORKSPACE_ALLOCATION_TABLE = "code_execution_nested_allocation";
const WORKSPACE_ALLOCATION_CURRENT_COLUMNS = [
  "organisation_id",
  "parent_kind",
  "parent_id",
  "parent_lease_id",
  "session_id",
  "turn_id",
  "runtime_generation",
  "allocation_id",
  "idempotency_key",
  "allocation_digest",
  "state",
  "utc_day",
  "utc_month",
  "price_book_revision",
  "profile_json",
  "reserved_cost_micros",
  "execution_deadline_at",
  "lease_expires_at",
  "receipt_id",
  "receipt_digest",
  "actual_cost_micros",
  "input_bytes",
  "output_bytes",
  "duration_ms",
  "outcome",
  "reserved_at",
  "terminal_at",
  "terminal_reason",
] as const;

export function createCodeModeBudgetSchema(
  storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
): void {
  storage.transactionSync(
    createCodeModeBudgetSchemaInTransaction.bind(null, storage.sql),
  );
}

function createCodeModeBudgetSchemaInTransaction(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS code_execution_reservation (
      organisation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      runtime_generation INTEGER NOT NULL CHECK (runtime_generation >= 1),
      execution_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      lease_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'reconciled', 'cancelled', 'expired')),
      utc_day TEXT NOT NULL,
      utc_month TEXT NOT NULL,
      admission_digest TEXT NOT NULL,
      program_digest TEXT NOT NULL,
      requirements_digest TEXT NOT NULL,
      policy_digest TEXT NOT NULL,
      catalog_digest TEXT NOT NULL,
      router_revision TEXT NOT NULL,
      runtime_revision TEXT NOT NULL,
      price_book_revision TEXT NOT NULL,
      placement_json TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      reserved_cost_micros INTEGER NOT NULL CHECK (reserved_cost_micros >= 1),
      customer_disposition TEXT NOT NULL CHECK (customer_disposition = 'included_interactive'),
      reserved_at INTEGER NOT NULL CHECK (reserved_at >= 0),
      execution_deadline_at INTEGER NOT NULL CHECK (execution_deadline_at >= reserved_at),
      lease_expires_at INTEGER,
      receipt_id TEXT,
      receipt_digest TEXT,
      actual_cost_micros INTEGER,
      outcome TEXT,
      terminal_at INTEGER,
      terminal_reason TEXT,
      provider_cost_micros INTEGER,
      reconciled_at INTEGER,
      UNIQUE (organisation_id, session_id, turn_id),
      CHECK (
        (state = 'reserved' AND lease_expires_at IS NOT NULL AND receipt_id IS NULL AND terminal_at IS NULL) OR
        (state = 'settled' AND lease_expires_at IS NULL AND receipt_id IS NOT NULL AND receipt_digest IS NOT NULL AND actual_cost_micros IS NOT NULL AND outcome IN ('succeeded', 'platform_failed', 'organisation_failed') AND terminal_at IS NOT NULL AND terminal_reason IS NULL) OR
        (state = 'reconciled' AND lease_expires_at IS NULL AND receipt_id IS NOT NULL AND receipt_digest IS NOT NULL AND actual_cost_micros IS NOT NULL AND outcome IN ('succeeded', 'platform_failed', 'organisation_failed') AND terminal_at IS NOT NULL AND terminal_reason IS NULL AND provider_cost_micros IS NOT NULL AND reconciled_at IS NOT NULL) OR
        (state = 'cancelled' AND lease_expires_at IS NULL AND receipt_id IS NULL AND terminal_at IS NOT NULL AND terminal_reason IN ('admission_compensated', 'turn_cancelled')) OR
        (state = 'expired' AND lease_expires_at IS NULL AND receipt_id IS NULL AND terminal_at IS NOT NULL AND terminal_reason = 'lease_expired')
      )
    )`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS code_execution_reservation_expiry
     ON code_execution_reservation (state, lease_expires_at)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS code_execution_receipt (
      receipt_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL UNIQUE,
      receipt_digest TEXT NOT NULL,
      price_book_revision TEXT NOT NULL,
      actual_cost_micros INTEGER NOT NULL CHECK (actual_cost_micros >= 0),
      capability_calls INTEGER NOT NULL CHECK (capability_calls >= 0),
      input_bytes INTEGER NOT NULL CHECK (input_bytes >= 0),
      output_bytes INTEGER NOT NULL CHECK (output_bytes >= 0),
      outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'platform_failed', 'organisation_failed')),
      settled_at INTEGER NOT NULL CHECK (settled_at >= 0)
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS code_execution_call_counter (
      execution_id TEXT PRIMARY KEY,
      capability_calls INTEGER NOT NULL CHECK (capability_calls >= 0),
      in_flight_calls INTEGER NOT NULL CHECK (in_flight_calls >= 0),
      input_bytes INTEGER NOT NULL CHECK (input_bytes >= 0),
      output_bytes INTEGER NOT NULL CHECK (output_bytes >= 0)
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS code_execution_call (
      execution_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('claimed', 'completed')),
      input_bytes INTEGER NOT NULL CHECK (input_bytes >= 0),
      output_bytes INTEGER,
      claimed_at INTEGER NOT NULL CHECK (claimed_at >= 0),
      completed_at INTEGER,
      PRIMARY KEY (execution_id, call_id),
      CHECK (
        (state = 'claimed' AND output_bytes IS NULL AND completed_at IS NULL) OR
        (state = 'completed' AND output_bytes IS NOT NULL AND completed_at IS NOT NULL)
      )
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS code_execution_reconciliation (
      execution_id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      provider_cost_micros INTEGER NOT NULL CHECK (provider_cost_micros >= 0),
      reconciled_at INTEGER NOT NULL CHECK (reconciled_at >= 0)
    )`,
  );
  ensureWorkspaceAllocationSchema(sql);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS code_execution_nested_allocation_expiry
     ON code_execution_nested_allocation (state, lease_expires_at)`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS code_execution_nested_allocation_parent
     ON code_execution_nested_allocation (parent_kind, parent_id)`,
  );
}

function ensureWorkspaceAllocationSchema(sql: SqlStorage): void {
  const columns = new Set(
    sql
      .exec<TableInfoRow>(`PRAGMA table_info(${WORKSPACE_ALLOCATION_TABLE})`)
      .toArray()
      .map((row) => row.name),
  );
  if (columns.size === 0) {
    createWorkspaceAllocationTable(sql);
    return;
  }
  if (!WORKSPACE_ALLOCATION_CURRENT_COLUMNS.every(columns.has.bind(columns)))
    throw new Error("code_mode_workspace_allocation_schema_invalid");
}

function createWorkspaceAllocationTable(
  sql: SqlStorage,
  table = WORKSPACE_ALLOCATION_TABLE,
): void {
  sql.exec(
    `CREATE TABLE ${table} (
      organisation_id TEXT NOT NULL,
      parent_kind TEXT NOT NULL CHECK (parent_kind IN ('code_mode_execution', 'attachment_preparation')),
      parent_id TEXT NOT NULL,
      parent_lease_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      runtime_generation INTEGER NOT NULL CHECK (runtime_generation >= 1),
      allocation_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      allocation_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'cancelled', 'expired')),
      utc_day TEXT NOT NULL,
      utc_month TEXT NOT NULL,
      price_book_revision TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      reserved_cost_micros INTEGER NOT NULL CHECK (reserved_cost_micros >= 1),
      execution_deadline_at INTEGER NOT NULL,
      lease_expires_at INTEGER,
      receipt_id TEXT,
      receipt_digest TEXT,
      actual_cost_micros INTEGER,
      input_bytes INTEGER,
      output_bytes INTEGER,
      duration_ms INTEGER,
      outcome TEXT,
      reserved_at INTEGER NOT NULL,
      terminal_at INTEGER,
      terminal_reason TEXT,
      UNIQUE (parent_kind, parent_id),
      CHECK (
        (state = 'reserved' AND lease_expires_at IS NOT NULL AND terminal_at IS NULL) OR
        (state = 'settled' AND lease_expires_at IS NULL AND receipt_id IS NOT NULL AND receipt_digest IS NOT NULL AND actual_cost_micros IS NOT NULL AND input_bytes IS NOT NULL AND output_bytes IS NOT NULL AND duration_ms IS NOT NULL AND outcome IN ('succeeded', 'platform_failed', 'organisation_failed') AND terminal_at IS NOT NULL AND terminal_reason IS NULL) OR
        (state = 'cancelled' AND lease_expires_at IS NULL AND receipt_id IS NULL AND terminal_at IS NOT NULL AND terminal_reason IN ('admission_compensated', 'turn_cancelled')) OR
        (state = 'expired' AND lease_expires_at IS NULL AND receipt_id IS NULL AND terminal_at IS NOT NULL AND terminal_reason = 'lease_expired')
      )
    )`,
  );
}

export function reserveCodeModeOrganisationBudget(
  sql: SqlStorage,
  raw: CodeModeOrganisationReserveInput,
): Result<CodeModeOrganisationReservation, CodeModeBudgetError> {
  const parsed = parseCodeModeReserveInput(raw);
  if (!parsed.ok) {
    return parsed;
  }
  expireCodeModeOrganisationReservations(sql, parsed.value.now);
  const existing = readReservationByExecution(sql, parsed.value.executionId);
  if (existing !== undefined) {
    return reservationMatches(existing, parsed.value)
      ? parseReservationRow(existing)
      : { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  if (readReservationForTurn(sql, parsed.value) !== undefined) {
    return { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  if (
    countLiveExecutions(sql) >= PILOT_ORGANISATION_MAX_CONCURRENT_EXECUTIONS
  ) {
    return {
      ok: false,
      error: { code: "code_mode_organisation_concurrency_exceeded" },
    };
  }
  const period = accountingPeriod(parsed.value.now);
  const dailyReserved = readReservedCost(sql, "utc_day", period.day);
  const monthlyReserved = readReservedCost(sql, "utc_month", period.month);
  if (
    dailyReserved + parsed.value.reservedCostMicros >
    PILOT_ORGANISATION_DAILY_COST_MICROS
  ) {
    return {
      ok: false,
      error: { code: "code_mode_organisation_daily_budget_exceeded" },
    };
  }
  if (
    monthlyReserved + parsed.value.reservedCostMicros >
    PILOT_ORGANISATION_MONTHLY_COST_MICROS
  ) {
    return {
      ok: false,
      error: { code: "code_mode_organisation_monthly_budget_exceeded" },
    };
  }
  sql.exec(
    `INSERT INTO code_execution_reservation (
      organisation_id, session_id, turn_id, runtime_generation, execution_id, idempotency_key, lease_id,
      state, utc_day, utc_month, admission_digest, program_digest, requirements_digest,
      policy_digest, catalog_digest, router_revision, runtime_revision,
      price_book_revision, placement_json, budget_json, reserved_cost_micros,
      customer_disposition, reserved_at, execution_deadline_at, lease_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    parsed.value.organisationId,
    parsed.value.sessionId,
    parsed.value.turnId,
    parsed.value.runtimeGeneration,
    parsed.value.executionId,
    parsed.value.idempotencyKey,
    parsed.value.leaseId,
    period.day,
    period.month,
    parsed.value.admissionDigest,
    parsed.value.programDigest,
    parsed.value.requirementsDigest,
    parsed.value.policyDigest,
    parsed.value.catalogDigest,
    parsed.value.routerRevision,
    parsed.value.runtimeRevision,
    parsed.value.priceBookRevision,
    JSON.stringify(parsed.value.placement),
    JSON.stringify(parsed.value.budget),
    parsed.value.reservedCostMicros,
    parsed.value.customerDisposition,
    parsed.value.now,
    parsed.value.executionDeadlineAt,
    parsed.value.leaseExpiresAt,
  );
  sql.exec(
    `INSERT INTO code_execution_call_counter (
      execution_id, capability_calls, in_flight_calls, input_bytes, output_bytes
    ) VALUES (?, 0, 0, 0, 0)`,
    parsed.value.executionId,
  );
  return parseReservationRow(requireReservation(sql, parsed.value.executionId));
}

export function claimCodeModeCapabilityCall(
  sql: SqlStorage,
  input: CodeModeCapabilityClaimInput,
): Result<CodeModeCapabilityCounter, CodeModeBudgetError> {
  const parsed = parseCapabilityClaimInput(input);
  if (!parsed.ok) return parsed;
  const reservation = readLiveFencedReservation(sql, parsed.value);
  if (!reservation.ok) return reservation;
  const existing = readCapabilityCall(
    sql,
    parsed.value.executionId,
    parsed.value.callId,
  );
  if (existing !== undefined) {
    return existing.input_bytes === parsed.value.inputBytes
      ? readCapabilityCounter(sql, parsed.value.executionId)
      : { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  const budget = parseStoredBudget(reservation.value.budget_json);
  if (!budget.ok) return budget;
  const counter = requireCapabilityCounter(sql, parsed.value.executionId);
  if (counter.capability_calls >= budget.value.maxCapabilityCalls) {
    return {
      ok: false,
      error: { code: "code_mode_capability_call_limit_exceeded" },
    };
  }
  if (counter.in_flight_calls >= budget.value.maxConcurrentCalls) {
    return {
      ok: false,
      error: { code: "code_mode_capability_concurrency_exceeded" },
    };
  }
  if (
    counter.input_bytes + parsed.value.inputBytes >
    budget.value.maxSourceBytes
  ) {
    return {
      ok: false,
      error: { code: "code_mode_capability_input_limit_exceeded" },
    };
  }
  sql.exec(
    `INSERT INTO code_execution_call (
      execution_id, call_id, state, input_bytes, claimed_at
    ) VALUES (?, ?, 'claimed', ?, ?)`,
    parsed.value.executionId,
    parsed.value.callId,
    parsed.value.inputBytes,
    parsed.value.now,
  );
  sql.exec(
    `UPDATE code_execution_call_counter
     SET capability_calls = capability_calls + 1,
         in_flight_calls = in_flight_calls + 1,
         input_bytes = input_bytes + ?
     WHERE execution_id = ?`,
    parsed.value.inputBytes,
    parsed.value.executionId,
  );
  return readCapabilityCounter(sql, parsed.value.executionId);
}

export function completeCodeModeCapabilityCall(
  sql: SqlStorage,
  input: CodeModeCapabilityCompleteInput,
): Result<CodeModeCapabilityCounter, CodeModeBudgetError> {
  const parsed = parseCapabilityCompleteInput(input);
  if (!parsed.ok) return parsed;
  const reservation = readLiveFencedReservation(sql, parsed.value);
  if (!reservation.ok) return reservation;
  const call = readCapabilityCall(
    sql,
    parsed.value.executionId,
    parsed.value.callId,
  );
  if (call === undefined) {
    return {
      ok: false,
      error: { code: "code_mode_capability_call_not_found" },
    };
  }
  if (call.state === "completed") {
    return call.output_bytes === parsed.value.outputBytes
      ? readCapabilityCounter(sql, parsed.value.executionId)
      : { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  const budget = parseStoredBudget(reservation.value.budget_json);
  if (!budget.ok) return budget;
  const counter = requireCapabilityCounter(sql, parsed.value.executionId);
  if (
    counter.output_bytes + parsed.value.outputBytes >
    budget.value.maxOutputBytes
  ) {
    // The call has ended, and the Session delivers none of its output, so it
    // ends here with no output bytes. A call left in flight would hold a slot
    // of the script and refuse the settlement of the execution.
    endCapabilityCall(sql, parsed.value, 0);
    return {
      ok: false,
      error: { code: "code_mode_capability_output_limit_exceeded" },
    };
  }
  endCapabilityCall(sql, parsed.value, parsed.value.outputBytes);
  return readCapabilityCounter(sql, parsed.value.executionId);
}

function endCapabilityCall(
  sql: SqlStorage,
  call: {
    readonly executionId: string;
    readonly callId: string;
    readonly now: number;
  },
  outputBytes: number,
): void {
  sql.exec(
    `UPDATE code_execution_call
     SET state = 'completed', output_bytes = ?, completed_at = ?
     WHERE execution_id = ? AND call_id = ? AND state = 'claimed'`,
    outputBytes,
    call.now,
    call.executionId,
    call.callId,
  );
  sql.exec(
    `UPDATE code_execution_call_counter
     SET in_flight_calls = in_flight_calls - 1,
         output_bytes = output_bytes + ?
     WHERE execution_id = ? AND in_flight_calls >= 1`,
    outputBytes,
    call.executionId,
  );
}

/**
 * Ends the capability calls that a lost process, or a claim or a completion
 * whose answer the Session did not receive, left in flight. The process that
 * holds the lease calls this before settlement, after its own calls ended.
 * An abandoned call delivered no output, so it adds no output bytes, and it
 * stays counted as a call. Settlement work is not bound by the execution
 * deadline.
 */
export function abandonCodeModeCapabilityCalls(
  sql: SqlStorage,
  input: CodeModeCapabilityAbandonInput,
): Result<CodeModeCapabilityCounter, CodeModeBudgetError> {
  const requestId = parseRequestId(input.requestId);
  const organisationId = parseOrganisationId(input.organisationId);
  if (!requestId.ok) return invalid("requestId");
  if (!organisationId.ok) return invalid("organisationId");
  if (!validExecutionId(input.executionId)) return invalid("executionId");
  if (!validOpaqueId(input.leaseId)) return invalid("leaseId");
  if (!isNonNegativeInteger(input.now)) return invalid("now");
  const row = readReservationByExecution(sql, input.executionId);
  if (row === undefined || row.organisation_id !== organisationId.value) {
    return { ok: false, error: { code: "code_mode_reservation_not_found" } };
  }
  if (row.lease_id !== input.leaseId) {
    return {
      ok: false,
      error: { code: "code_mode_reservation_lease_conflict" },
    };
  }
  if (row.state !== "reserved") {
    return {
      ok: false,
      error: {
        code: "code_mode_reservation_invalid_transition",
        state: row.state,
      },
    };
  }
  sql.exec(
    `UPDATE code_execution_call
     SET state = 'completed', output_bytes = 0, completed_at = ?
     WHERE execution_id = ? AND state = 'claimed'`,
    input.now,
    input.executionId,
  );
  sql.exec(
    `UPDATE code_execution_call_counter SET in_flight_calls = 0
     WHERE execution_id = ?`,
    input.executionId,
  );
  return readCapabilityCounter(sql, input.executionId);
}

export function reserveWorkspaceExecutorOrganisationAllocation(
  sql: SqlStorage,
  raw: WorkspaceExecutorAllocationReserveInput,
): Result<WorkspaceExecutorAllocationReservation, CodeModeBudgetError> {
  const parsed = parseWorkspaceExecutorAllocationReserveInput(raw);
  if (!parsed.ok) return parsed;
  expireCodeModeOrganisationReservations(sql, parsed.value.now);
  const parent = validateWorkspaceAllocationParent(sql, parsed.value);
  if (!parent.ok) return parent;
  const existing = readWorkspaceAllocationById(sql, parsed.value.allocationId);
  if (existing !== undefined) {
    return workspaceAllocationMatches(existing, parsed.value)
      ? parseWorkspaceAllocationRow(existing)
      : { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  if (readWorkspaceAllocationByParent(sql, parsed.value.parent) !== undefined) {
    return {
      ok: false,
      error: { code: "code_mode_workspace_allocation_limit_exceeded" },
    };
  }
  if (parsed.value.parent.kind === "attachment_preparation") {
    const period = accountingPeriod(parsed.value.now);
    const dailyReserved = readReservedCost(sql, "utc_day", period.day);
    const monthlyReserved = readReservedCost(sql, "utc_month", period.month);
    if (
      dailyReserved + parsed.value.reservedCostMicros >
      PILOT_ORGANISATION_DAILY_COST_MICROS
    ) {
      return {
        ok: false,
        error: { code: "code_mode_organisation_daily_budget_exceeded" },
      };
    }
    if (
      monthlyReserved + parsed.value.reservedCostMicros >
      PILOT_ORGANISATION_MONTHLY_COST_MICROS
    ) {
      return {
        ok: false,
        error: { code: "code_mode_organisation_monthly_budget_exceeded" },
      };
    }
  }
  const period = accountingPeriod(parsed.value.now);
  sql.exec(
    `INSERT INTO code_execution_nested_allocation (
      organisation_id, parent_kind, parent_id, parent_lease_id, session_id, turn_id,
      runtime_generation, allocation_id,
      idempotency_key, allocation_digest, state, price_book_revision, profile_json,
      reserved_cost_micros, execution_deadline_at, lease_expires_at, utc_day,
      utc_month, reserved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?)`,
    parsed.value.organisationId,
    parsed.value.parent.kind,
    workspaceAllocationParentId(parsed.value.parent),
    parsed.value.parent.leaseId,
    workspaceAllocationParentSessionId(parsed.value.parent, parent.value),
    workspaceAllocationParentTurnId(parsed.value.parent, parent.value),
    workspaceAllocationParentRuntimeGeneration(
      parsed.value.parent,
      parent.value,
    ),
    parsed.value.allocationId,
    parsed.value.idempotencyKey,
    parsed.value.allocationDigest,
    parsed.value.priceBookRevision,
    JSON.stringify(parsed.value.profile),
    parsed.value.reservedCostMicros,
    parsed.value.executionDeadlineAt,
    parsed.value.leaseExpiresAt,
    period.day,
    period.month,
    parsed.value.now,
  );
  return parseWorkspaceAllocationRow(
    requireWorkspaceAllocation(sql, parsed.value.allocationId),
  );
}

export function settleWorkspaceExecutorOrganisationAllocation(
  sql: SqlStorage,
  raw: WorkspaceExecutorAllocationSettleInput,
): Result<WorkspaceExecutorAllocationReservation, CodeModeBudgetError> {
  const parsed = parseWorkspaceExecutorAllocationSettleInput(raw);
  if (!parsed.ok) return parsed;
  expireCodeModeOrganisationReservations(sql, parsed.value.now);
  const row = readWorkspaceAllocationById(sql, parsed.value.allocationId);
  const fenced = validateWorkspaceAllocationFence(row, parsed.value);
  if (!fenced.ok) return fenced;
  if (fenced.value.state === "settled") {
    return settledWorkspaceAllocationMatches(fenced.value, parsed.value)
      ? parseWorkspaceAllocationRow(fenced.value)
      : { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  if (fenced.value.state !== "reserved") {
    return {
      ok: false,
      error: {
        code: "code_mode_reservation_invalid_transition",
        state: fenced.value.state,
      },
    };
  }
  if (
    parsed.value.actualCostMicros > fenced.value.reserved_cost_micros ||
    parsed.value.inputBytes >
      WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.maxInputBytes ||
    parsed.value.outputBytes >
      WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.maxOutputBytes ||
    parsed.value.durationMs >
      WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.maxDurationMs
  ) {
    return { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  sql.exec(
    `UPDATE code_execution_nested_allocation
     SET state = 'settled', lease_expires_at = NULL, receipt_id = ?,
         receipt_digest = ?, actual_cost_micros = ?, input_bytes = ?,
         output_bytes = ?, duration_ms = ?, outcome = ?, terminal_at = ?,
         terminal_reason = NULL
     WHERE allocation_id = ? AND state = 'reserved'`,
    parsed.value.receiptId,
    parsed.value.receiptDigest,
    parsed.value.actualCostMicros,
    parsed.value.inputBytes,
    parsed.value.outputBytes,
    parsed.value.durationMs,
    parsed.value.outcome,
    parsed.value.now,
    parsed.value.allocationId,
  );
  return parseWorkspaceAllocationRow(
    requireWorkspaceAllocation(sql, parsed.value.allocationId),
  );
}

export function cancelWorkspaceExecutorOrganisationAllocation(
  sql: SqlStorage,
  raw: WorkspaceExecutorAllocationCancelInput,
): Result<WorkspaceExecutorAllocationReservation, CodeModeBudgetError> {
  const parsed = parseWorkspaceExecutorAllocationCancelInput(raw);
  if (!parsed.ok) return parsed;
  expireCodeModeOrganisationReservations(sql, parsed.value.now);
  const row = readWorkspaceAllocationById(sql, parsed.value.allocationId);
  const fenced = validateWorkspaceAllocationFence(row, parsed.value);
  if (!fenced.ok) return fenced;
  if (
    fenced.value.state === "cancelled" &&
    fenced.value.terminal_reason === parsed.value.reason
  ) {
    return parseWorkspaceAllocationRow(fenced.value);
  }
  if (fenced.value.state !== "reserved") {
    return {
      ok: false,
      error: {
        code: "code_mode_reservation_invalid_transition",
        state: fenced.value.state,
      },
    };
  }
  sql.exec(
    `UPDATE code_execution_nested_allocation
     SET state = 'cancelled', lease_expires_at = NULL, terminal_at = ?,
         terminal_reason = ?
     WHERE allocation_id = ? AND state = 'reserved'`,
    parsed.value.now,
    parsed.value.reason,
    parsed.value.allocationId,
  );
  return parseWorkspaceAllocationRow(
    requireWorkspaceAllocation(sql, parsed.value.allocationId),
  );
}

export function settleCodeModeOrganisationBudget(
  sql: SqlStorage,
  raw: CodeModeOrganisationSettleInput,
): Result<CodeModeOrganisationReservation, CodeModeBudgetError> {
  const parsed = parseCodeModeSettleInput(raw);
  if (!parsed.ok) {
    return parsed;
  }
  expireCodeModeOrganisationReservations(sql, parsed.value.now);
  const row = readReservationByExecution(sql, parsed.value.executionId);
  if (
    row === undefined ||
    row.organisation_id !== parsed.value.organisationId
  ) {
    return { ok: false, error: { code: "code_mode_reservation_not_found" } };
  }
  if (row.lease_id !== parsed.value.leaseId) {
    return {
      ok: false,
      error: { code: "code_mode_reservation_lease_conflict" },
    };
  }
  if (row.state === "settled") {
    return settledReceiptMatches(sql, row, parsed.value)
      ? parseReservationRow(row)
      : { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  if (row.state === "expired") {
    return {
      ok: false,
      error: {
        code: "code_mode_reservation_expired",
        leaseExpiresAt: row.terminal_at ?? 0,
      },
    };
  }
  if (row.state !== "reserved") {
    return {
      ok: false,
      error: {
        code: "code_mode_reservation_invalid_transition",
        state: row.state,
      },
    };
  }
  if (parsed.value.actualCostMicros > row.reserved_cost_micros) {
    return {
      ok: false,
      error: {
        code: "code_mode_cost_exceeds_reservation",
        reservedCostMicros: row.reserved_cost_micros,
      },
    };
  }
  const counter = requireCapabilityCounter(sql, parsed.value.executionId);
  if (counter.in_flight_calls !== 0) {
    return {
      ok: false,
      error: { code: "code_mode_capability_calls_in_flight" },
    };
  }
  if (
    counter.capability_calls !== parsed.value.capabilityCalls ||
    counter.input_bytes !== parsed.value.inputBytes ||
    counter.output_bytes !== parsed.value.outputBytes
  ) {
    return { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  sql.exec(
    `INSERT INTO code_execution_receipt (
      receipt_id, execution_id, receipt_digest, price_book_revision,
      actual_cost_micros, capability_calls, input_bytes, output_bytes, outcome, settled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    parsed.value.receiptId,
    parsed.value.executionId,
    parsed.value.receiptDigest,
    row.price_book_revision,
    parsed.value.actualCostMicros,
    counter.capability_calls,
    counter.input_bytes,
    counter.output_bytes,
    parsed.value.outcome,
    parsed.value.now,
  );
  sql.exec(
    `UPDATE code_execution_reservation
     SET state = 'settled', lease_expires_at = NULL, receipt_id = ?, receipt_digest = ?,
         actual_cost_micros = ?, outcome = ?, terminal_at = ?, terminal_reason = NULL
     WHERE execution_id = ? AND state = 'reserved'`,
    parsed.value.receiptId,
    parsed.value.receiptDigest,
    parsed.value.actualCostMicros,
    parsed.value.outcome,
    parsed.value.now,
    parsed.value.executionId,
  );
  return parseReservationRow(requireReservation(sql, parsed.value.executionId));
}

export function cancelCodeModeOrganisationBudget(
  sql: SqlStorage,
  raw: CodeModeOrganisationCancelInput,
): Result<CodeModeOrganisationReservation, CodeModeBudgetError> {
  const parsed = parseCodeModeCancelInput(raw);
  if (!parsed.ok) {
    return parsed;
  }
  expireCodeModeOrganisationReservations(sql, parsed.value.now);
  const row = readReservationByExecution(sql, parsed.value.executionId);
  if (
    row === undefined ||
    row.organisation_id !== parsed.value.organisationId
  ) {
    return { ok: false, error: { code: "code_mode_reservation_not_found" } };
  }
  if (row.lease_id !== parsed.value.leaseId) {
    return {
      ok: false,
      error: { code: "code_mode_reservation_lease_conflict" },
    };
  }
  if (
    row.state === "cancelled" &&
    row.terminal_reason === parsed.value.reason
  ) {
    return parseReservationRow(row);
  }
  if (row.state !== "reserved") {
    return {
      ok: false,
      error: {
        code: "code_mode_reservation_invalid_transition",
        state: row.state,
      },
    };
  }
  sql.exec(
    `UPDATE code_execution_reservation
     SET state = 'cancelled', lease_expires_at = NULL, terminal_at = ?, terminal_reason = ?
     WHERE execution_id = ? AND state = 'reserved'`,
    parsed.value.now,
    parsed.value.reason,
    parsed.value.executionId,
  );
  return parseReservationRow(requireReservation(sql, parsed.value.executionId));
}

/**
 * Moves a live reservation to the lease of a later runtime generation. The
 * previous lease loses its authority in the same statement: a later claim,
 * completion, settlement, or cancellation under it fails as a lease conflict.
 * Claims, counters, the deadline, and the expiry keep their values, so a
 * rebind neither restores consumed allowance nor extends the execution.
 * Repeating the same rebind returns the same reservation.
 */
export function rebindCodeModeOrganisationLease(
  sql: SqlStorage,
  raw: CodeModeLeaseRebindInput,
): Result<CodeModeOrganisationReservation, CodeModeBudgetError> {
  const parsed = parseCodeModeLeaseRebindInput(raw);
  if (!parsed.ok) return parsed;
  expireCodeModeOrganisationReservations(sql, parsed.value.now);
  const row = readReservationByExecution(sql, parsed.value.executionId);
  if (
    row === undefined ||
    row.organisation_id !== parsed.value.organisationId
  ) {
    return { ok: false, error: { code: "code_mode_reservation_not_found" } };
  }
  if (row.admission_digest !== parsed.value.admissionDigest) {
    return { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  const decision = decideCodeModeLeaseRebind(
    { leaseId: row.lease_id, runtimeGeneration: row.runtime_generation },
    parsed.value,
  );
  if (decision === "conflict") {
    return {
      ok: false,
      error: { code: "code_mode_reservation_lease_conflict" },
    };
  }
  if (row.state === "expired") {
    return {
      ok: false,
      error: {
        code: "code_mode_reservation_expired",
        leaseExpiresAt: row.terminal_at ?? 0,
      },
    };
  }
  if (row.state !== "reserved") {
    return {
      ok: false,
      error: {
        code: "code_mode_reservation_invalid_transition",
        state: row.state,
      },
    };
  }
  if (decision === "rebind") {
    sql.exec(
      `UPDATE code_execution_reservation
       SET lease_id = ?, runtime_generation = ?
       WHERE execution_id = ? AND state = 'reserved' AND lease_id = ?`,
      parsed.value.next.leaseId,
      parsed.value.next.runtimeGeneration,
      parsed.value.executionId,
      parsed.value.previous.leaseId,
    );
  }
  return parseReservationRow(requireReservation(sql, parsed.value.executionId));
}

/** The rule that each owner of an execution applies to a rebind request. */
export function decideCodeModeLeaseRebind(
  current: CodeModeLeaseBinding,
  input: Pick<CodeModeLeaseRebindInput, "previous" | "next">,
): CodeModeLeaseRebindDecision {
  if (sameLeaseBinding(current, input.next)) return "already_bound";
  return sameLeaseBinding(current, input.previous) ? "rebind" : "conflict";
}

function sameLeaseBinding(
  left: CodeModeLeaseBinding,
  right: CodeModeLeaseBinding,
): boolean {
  return (
    left.leaseId === right.leaseId &&
    left.runtimeGeneration === right.runtimeGeneration
  );
}

export function reconcileCodeModeOrganisationBudget(
  sql: SqlStorage,
  input: CodeModeOrganisationReconcileInput,
): Result<CodeModeOrganisationReservation, CodeModeBudgetError> {
  const parsed = parseCodeModeReconcileInput(input);
  if (!parsed.ok) return parsed;
  const row = readReservationByExecution(sql, parsed.value.executionId);
  if (
    row === undefined ||
    row.organisation_id !== parsed.value.organisationId
  ) {
    return { ok: false, error: { code: "code_mode_reservation_not_found" } };
  }
  if (row.state === "reconciled") {
    const existing = readReconciliation(sql, parsed.value.executionId);
    return existing !== undefined &&
      row.receipt_id === parsed.value.receiptId &&
      existing.provider_cost_micros === parsed.value.providerCostMicros
      ? parseReservationRow(row)
      : { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  if (row.state !== "settled" || row.receipt_id !== parsed.value.receiptId) {
    return {
      ok: false,
      error: {
        code: "code_mode_reservation_invalid_transition",
        state: row.state,
      },
    };
  }
  sql.exec(
    `INSERT INTO code_execution_reconciliation (
      execution_id, receipt_id, provider_cost_micros, reconciled_at
    ) VALUES (?, ?, ?, ?)`,
    parsed.value.executionId,
    parsed.value.receiptId,
    parsed.value.providerCostMicros,
    parsed.value.now,
  );
  sql.exec(
    `UPDATE code_execution_reservation
     SET state = 'reconciled', provider_cost_micros = ?, reconciled_at = ?
     WHERE execution_id = ? AND state = 'settled'`,
    parsed.value.providerCostMicros,
    parsed.value.now,
    parsed.value.executionId,
  );
  return parseReservationRow(requireReservation(sql, parsed.value.executionId));
}

export function expireCodeModeOrganisationReservations(
  sql: SqlStorage,
  now: number,
): void {
  sql.exec(
    `UPDATE code_execution_nested_allocation
     SET state = 'expired', lease_expires_at = NULL, terminal_at = ?,
         terminal_reason = 'lease_expired'
     WHERE state = 'reserved' AND lease_expires_at <= ?`,
    now,
    now,
  );
  sql.exec(
    `UPDATE code_execution_reservation
     SET state = 'expired', lease_expires_at = NULL, terminal_at = ?, terminal_reason = 'lease_expired'
     WHERE state = 'reserved' AND lease_expires_at <= ?`,
    now,
    now,
  );
}

export function readNextCodeModeOrganisationAlarmAt(
  sql: SqlStorage,
): number | null {
  const value = sql
    .exec<{ next_at: number | null }>(
      `SELECT MIN(next_at) AS next_at FROM (
       SELECT MIN(lease_expires_at) AS next_at
       FROM code_execution_reservation WHERE state = 'reserved'
       UNION ALL
       SELECT MIN(lease_expires_at) AS next_at
       FROM code_execution_nested_allocation WHERE state = 'reserved'
     )`,
    )
    .toArray()[0]?.next_at;
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

export function parseWorkspaceExecutorAllocationReserveInput(
  input: WorkspaceExecutorAllocationReserveInput,
): Result<WorkspaceExecutorAllocationReserveInput, CodeModeBudgetError> {
  const identity = parseWorkspaceAllocationIdentity(input);
  if (!identity.ok) return identity;
  if (!validOpaqueId(input.idempotencyKey)) return invalid("idempotencyKey");
  if (!isSha256(input.allocationDigest)) return invalid("allocationDigest");
  if (input.priceBookRevision !== CODE_MODE_PRICE_BOOK_REVISION_V2) {
    return invalid("priceBookRevision");
  }
  if (!validWorkspaceExecutorProfile(input.profile)) return invalid("profile");
  if (input.reservedCostMicros !== WORKSPACE_EXECUTOR_RESERVED_COST_MICROS) {
    return invalid("reservedCostMicros");
  }
  if (
    !isNonNegativeInteger(input.executionDeadlineAt) ||
    input.executionDeadlineAt <= input.now ||
    input.executionDeadlineAt - input.now >
      WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.maxDurationMs
  ) {
    return invalid("executionDeadlineAt");
  }
  if (
    input.leaseExpiresAt !==
    input.executionDeadlineAt + PILOT_EXECUTION_CLEANUP_MARGIN_MS
  ) {
    return invalid("leaseExpiresAt");
  }
  return { ok: true, value: { ...input, parent: identity.value.parent } };
}

export function parseWorkspaceExecutorAllocationSettleInput(
  input: WorkspaceExecutorAllocationSettleInput,
): Result<WorkspaceExecutorAllocationSettleInput, CodeModeBudgetError> {
  const identity = parseWorkspaceAllocationIdentity(input);
  if (!identity.ok) return identity;
  const fields: ReadonlyArray<
    readonly [string, unknown, (value: unknown) => boolean]
  > = [
    ["receiptId", input.receiptId, validOpaqueId],
    ["receiptDigest", input.receiptDigest, isSha256],
    ["actualCostMicros", input.actualCostMicros, isNonNegativeInteger],
    ["inputBytes", input.inputBytes, isNonNegativeInteger],
    ["outputBytes", input.outputBytes, isNonNegativeInteger],
    ["durationMs", input.durationMs, isNonNegativeInteger],
  ];
  for (const [field, value, validate] of fields) {
    if (!validate(value)) return invalid(field);
  }
  if (!isOutcome(input.outcome)) return invalid("outcome");
  return { ok: true, value: { ...input, parent: identity.value.parent } };
}

export function parseWorkspaceExecutorAllocationCancelInput(
  input: WorkspaceExecutorAllocationCancelInput,
): Result<WorkspaceExecutorAllocationCancelInput, CodeModeBudgetError> {
  const identity = parseWorkspaceAllocationIdentity(input);
  if (!identity.ok) return identity;
  if (
    input.reason !== "admission_compensated" &&
    input.reason !== "turn_cancelled"
  ) {
    return invalid("reason");
  }
  return { ok: true, value: { ...input, parent: identity.value.parent } };
}

function parseWorkspaceAllocationIdentity(input: {
  readonly requestId: RequestId;
  readonly organisationId: OrganisationId;
  readonly parent: WorkspaceExecutorAllocationParent;
  readonly allocationId: string;
  readonly now: number;
}): Result<
  {
    readonly requestId: RequestId;
    readonly organisationId: OrganisationId;
    readonly parent: WorkspaceExecutorAllocationParent;
  },
  CodeModeBudgetError
> {
  const requestId = parseRequestId(input.requestId);
  const organisationId = parseOrganisationId(input.organisationId);
  if (!requestId.ok) return invalid("requestId");
  if (!organisationId.ok) return invalid("organisationId");
  const parent = parseWorkspaceAllocationParent(input.parent);
  if (!parent.ok) return parent;
  if (!validWorkspaceAllocationId(input.allocationId))
    return invalid("allocationId");
  if (!isNonNegativeInteger(input.now)) return invalid("now");
  return {
    ok: true,
    value: {
      requestId: requestId.value,
      organisationId: organisationId.value,
      parent: parent.value,
    },
  };
}

function parseWorkspaceAllocationParent(
  raw: unknown,
): Result<WorkspaceExecutorAllocationParent, CodeModeBudgetError> {
  if (!isRecord(raw)) return invalid("parent");
  if (!validOpaqueId(raw.leaseId)) return invalid("parent.leaseId");
  switch (raw.kind) {
    case "code_mode_execution":
      return validExecutionId(raw.executionId)
        ? {
            ok: true,
            value: {
              kind: "code_mode_execution",
              executionId: raw.executionId,
              leaseId: raw.leaseId,
            },
          }
        : invalid("parent.executionId");
    case "attachment_preparation": {
      if (typeof raw.sessionId !== "string") return invalid("parent.sessionId");
      const sessionId = parseSessionId(raw.sessionId);
      if (!sessionId.ok) return invalid("parent.sessionId");
      if (!validOpaqueId(raw.preparationId))
        return invalid("parent.preparationId");
      if (!validOpaqueId(raw.turnId)) return invalid("parent.turnId");
      if (!isPositiveInteger(raw.runtimeGeneration)) {
        return invalid("parent.runtimeGeneration");
      }
      return {
        ok: true,
        value: {
          kind: "attachment_preparation",
          preparationId: raw.preparationId,
          leaseId: raw.leaseId,
          sessionId: sessionId.value,
          turnId: raw.turnId,
          runtimeGeneration: raw.runtimeGeneration,
        },
      };
    }
    default:
      return invalid("parent.kind");
  }
}

export function parseCodeModeReserveInput(
  input: CodeModeOrganisationReserveInput,
): Result<CodeModeOrganisationReserveInput, CodeModeBudgetError> {
  const identity = parseCommonIdentity(input);
  if (!identity.ok) {
    return identity;
  }
  const fields: ReadonlyArray<
    readonly [string, unknown, (value: unknown) => boolean]
  > = [
    ["idempotencyKey", input.idempotencyKey, validOpaqueId],
    ["leaseId", input.leaseId, validOpaqueId],
    ["executionDeadlineAt", input.executionDeadlineAt, isNonNegativeInteger],
    ["leaseExpiresAt", input.leaseExpiresAt, isNonNegativeInteger],
    ["admissionDigest", input.admissionDigest, isSha256],
    ["programDigest", input.programDigest, isSha256],
    ["requirementsDigest", input.requirementsDigest, isSha256],
    ["policyDigest", input.policyDigest, isSha256],
    ["catalogDigest", input.catalogDigest, isSha256],
    ["routerRevision", input.routerRevision, validOpaqueId],
    ["runtimeRevision", input.runtimeRevision, validOpaqueId],
    ["priceBookRevision", input.priceBookRevision, validOpaqueId],
    ["reservedCostMicros", input.reservedCostMicros, isPositiveInteger],
    ["now", input.now, isNonNegativeInteger],
  ];
  for (const [field, value, validate] of fields) {
    if (!validate(value)) {
      return invalid(field);
    }
  }
  if (
    input.executionDeadlineAt <= input.now ||
    input.executionDeadlineAt - input.now > CODE_MODE_PILOT_BUDGET.maxDurationMs
  ) {
    return invalid("executionDeadlineAt");
  }
  if (
    input.leaseExpiresAt !==
    input.executionDeadlineAt + PILOT_EXECUTION_CLEANUP_MARGIN_MS
  ) {
    return invalid("leaseExpiresAt");
  }
  if (!validPlacement(input.placement)) {
    return invalid("placement");
  }
  if (!validPilotBudget(input.budget)) {
    return invalid("budget");
  }
  if (input.customerDisposition !== "included_interactive") {
    return invalid("customerDisposition");
  }
  return { ok: true, value: { ...input, ...identity.value } };
}

export function parseCodeModeSettleInput(
  input: CodeModeOrganisationSettleInput,
): Result<CodeModeOrganisationSettleInput, CodeModeBudgetError> {
  const organisationId = parseOrganisationId(input.organisationId);
  const requestId = parseRequestId(input.requestId);
  if (!requestId.ok) return invalid("requestId");
  if (!organisationId.ok) return invalid("organisationId");
  const fields: ReadonlyArray<
    readonly [string, unknown, (value: unknown) => boolean]
  > = [
    ["executionId", input.executionId, validExecutionId],
    ["leaseId", input.leaseId, validOpaqueId],
    ["receiptId", input.receiptId, validOpaqueId],
    ["receiptDigest", input.receiptDigest, isSha256],
    ["actualCostMicros", input.actualCostMicros, isNonNegativeInteger],
    ["capabilityCalls", input.capabilityCalls, isNonNegativeInteger],
    ["inputBytes", input.inputBytes, isNonNegativeInteger],
    ["outputBytes", input.outputBytes, isNonNegativeInteger],
    ["now", input.now, isNonNegativeInteger],
  ];
  for (const [field, value, validate] of fields) {
    if (!validate(value)) return invalid(field);
  }
  if (!isOutcome(input.outcome)) return invalid("outcome");
  return {
    ok: true,
    value: {
      ...input,
      requestId: requestId.value,
      organisationId: organisationId.value,
    },
  };
}

function parseCapabilityClaimInput(
  input: CodeModeCapabilityClaimInput,
): Result<CodeModeCapabilityClaimInput, CodeModeBudgetError> {
  const common = parseCapabilityIdentity(input);
  if (!common.ok) return common;
  if (!isNonNegativeInteger(input.inputBytes)) return invalid("inputBytes");
  return { ok: true, value: { ...input, ...common.value } };
}

function parseCapabilityCompleteInput(
  input: CodeModeCapabilityCompleteInput,
): Result<CodeModeCapabilityCompleteInput, CodeModeBudgetError> {
  const common = parseCapabilityIdentity(input);
  if (!common.ok) return common;
  if (!isNonNegativeInteger(input.outputBytes)) return invalid("outputBytes");
  return { ok: true, value: { ...input, ...common.value } };
}

function parseCapabilityIdentity(input: {
  readonly requestId: RequestId;
  readonly organisationId: OrganisationId;
  readonly executionId: string;
  readonly leaseId: string;
  readonly callId: string;
  readonly now: number;
}): Result<
  {
    readonly requestId: RequestId;
    readonly organisationId: OrganisationId;
  },
  CodeModeBudgetError
> {
  const requestId = parseRequestId(input.requestId);
  const organisationId = parseOrganisationId(input.organisationId);
  if (!requestId.ok) return invalid("requestId");
  if (!organisationId.ok) return invalid("organisationId");
  if (!validExecutionId(input.executionId)) return invalid("executionId");
  if (!validOpaqueId(input.leaseId)) return invalid("leaseId");
  if (!validOpaqueId(input.callId)) return invalid("callId");
  if (!isNonNegativeInteger(input.now)) return invalid("now");
  return {
    ok: true,
    value: { requestId: requestId.value, organisationId: organisationId.value },
  };
}

export function parseCodeModeCancelInput(
  input: CodeModeOrganisationCancelInput,
): Result<CodeModeOrganisationCancelInput, CodeModeBudgetError> {
  const organisationId = parseOrganisationId(input.organisationId);
  const requestId = parseRequestId(input.requestId);
  if (!requestId.ok) return invalid("requestId");
  if (!organisationId.ok) return invalid("organisationId");
  if (!validExecutionId(input.executionId)) return invalid("executionId");
  if (!validOpaqueId(input.leaseId)) return invalid("leaseId");
  if (!isNonNegativeInteger(input.now)) return invalid("now");
  if (
    input.reason !== "admission_compensated" &&
    input.reason !== "turn_cancelled"
  ) {
    return invalid("reason");
  }
  return {
    ok: true,
    value: {
      ...input,
      requestId: requestId.value,
      organisationId: organisationId.value,
    },
  };
}

export function parseCodeModeLeaseRebindInput(
  input: CodeModeLeaseRebindInput,
): Result<CodeModeLeaseRebindInput, CodeModeBudgetError> {
  const organisationId = parseOrganisationId(input.organisationId);
  const requestId = parseRequestId(input.requestId);
  if (!requestId.ok) return invalid("requestId");
  if (!organisationId.ok) return invalid("organisationId");
  if (!validExecutionId(input.executionId)) return invalid("executionId");
  if (!isSha256(input.admissionDigest)) return invalid("admissionDigest");
  if (!validLeaseBinding(input.previous)) return invalid("previous");
  if (!validLeaseBinding(input.next)) return invalid("next");
  // A generation has one lease. A rebind moves forward, and never sideways.
  if (
    input.next.runtimeGeneration <= input.previous.runtimeGeneration ||
    input.next.leaseId === input.previous.leaseId
  )
    return invalid("next");
  if (!isNonNegativeInteger(input.now)) return invalid("now");
  return {
    ok: true,
    value: {
      requestId: requestId.value,
      organisationId: organisationId.value,
      executionId: input.executionId,
      admissionDigest: input.admissionDigest,
      previous: {
        leaseId: input.previous.leaseId,
        runtimeGeneration: input.previous.runtimeGeneration,
      },
      next: {
        leaseId: input.next.leaseId,
        runtimeGeneration: input.next.runtimeGeneration,
      },
      now: input.now,
    },
  };
}

function validLeaseBinding(value: CodeModeLeaseBinding): boolean {
  return (
    isRecord(value) &&
    validOpaqueId(value.leaseId) &&
    isPositiveInteger(value.runtimeGeneration)
  );
}

export function parseCodeModeReconcileInput(
  input: CodeModeOrganisationReconcileInput,
): Result<CodeModeOrganisationReconcileInput, CodeModeBudgetError> {
  const organisationId = parseOrganisationId(input.organisationId);
  const requestId = parseRequestId(input.requestId);
  if (!requestId.ok) return invalid("requestId");
  if (!organisationId.ok) return invalid("organisationId");
  if (!validExecutionId(input.executionId)) return invalid("executionId");
  if (!validOpaqueId(input.receiptId)) return invalid("receiptId");
  if (!isNonNegativeInteger(input.providerCostMicros))
    return invalid("providerCostMicros");
  if (!isNonNegativeInteger(input.now)) return invalid("now");
  return {
    ok: true,
    value: {
      ...input,
      requestId: requestId.value,
      organisationId: organisationId.value,
    },
  };
}

function parseCommonIdentity(input: CodeModeOrganisationReserveInput): Result<
  {
    readonly requestId: RequestId;
    readonly organisationId: OrganisationId;
    readonly sessionId: SessionId;
  },
  CodeModeBudgetError
> {
  const requestId = parseRequestId(input.requestId);
  const organisationId = parseOrganisationId(input.organisationId);
  const sessionId = parseSessionId(input.sessionId);
  if (!requestId.ok) return invalid("requestId");
  if (!organisationId.ok) return invalid("organisationId");
  if (!sessionId.ok) return invalid("sessionId");
  if (!validOpaqueId(input.turnId)) return invalid("turnId");
  if (!isPositiveInteger(input.runtimeGeneration))
    return invalid("runtimeGeneration");
  if (!validExecutionId(input.executionId)) return invalid("executionId");
  return {
    ok: true,
    value: {
      requestId: requestId.value,
      organisationId: organisationId.value,
      sessionId: sessionId.value,
    },
  };
}

function invalid(field: string): Result<never, CodeModeBudgetError> {
  return {
    ok: false,
    error: { code: "invalid_code_mode_budget_input", field },
  };
}

function validPlacement(value: CodeModePlacement): boolean {
  return (
    // The value crossed an RPC boundary, so its kind is not proven.
    value.kind === "cloudflare_sandbox_worker" &&
    validOpaqueId(value.adapterRevision) &&
    validOpaqueId(value.packageVersion) &&
    value.reason === "generated_javascript_remote_execution" &&
    SHA256_PATTERN.test(value.evidenceDigest)
  );
}

function validWorkspaceExecutorProfile(
  value: WorkspaceExecutorAllocationProfile,
): boolean {
  return (
    value.kind === WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.kind &&
    value.instanceType === WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.instanceType &&
    value.network === WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.network &&
    value.maxDurationMs ===
      WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.maxDurationMs &&
    value.maxInputBytes ===
      WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.maxInputBytes &&
    value.maxOutputBytes ===
      WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.maxOutputBytes &&
    value.maxAllocations ===
      WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.maxAllocations
  );
}

function validPilotBudget(value: CodeModeBudget): boolean {
  return (
    value.maxDurationMs === CODE_MODE_PILOT_BUDGET.maxDurationMs &&
    value.maxCapabilityCalls === CODE_MODE_PILOT_BUDGET.maxCapabilityCalls &&
    value.maxConcurrentCalls === CODE_MODE_PILOT_BUDGET.maxConcurrentCalls &&
    value.maxSourceBytes === CODE_MODE_PILOT_BUDGET.maxSourceBytes &&
    value.maxOutputBytes === CODE_MODE_PILOT_BUDGET.maxOutputBytes
  );
}

function isOutcome(
  value: string,
): value is CodeModeOrganisationSettleInput["outcome"] {
  return (
    value === "succeeded" ||
    value === "platform_failed" ||
    value === "organisation_failed"
  );
}

function validExecutionId(value: unknown): value is string {
  return typeof value === "string" && EXECUTION_ID_PATTERN.test(value);
}

function validWorkspaceAllocationId(value: unknown): value is string {
  return (
    typeof value === "string" && WORKSPACE_ALLOCATION_ID_PATTERN.test(value)
  );
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function accountingPeriod(now: number): {
  readonly day: string;
  readonly month: string;
} {
  const day = new Date(Math.floor(now / DAY_MS) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return { day, month: day.slice(0, 7) };
}

function readReservedCost(
  sql: SqlStorage,
  column: "utc_day" | "utc_month",
  period: string,
): number {
  const row = sql
    .exec<{ total: number | null }>(
      `SELECT SUM(
       CASE
         WHEN source = 'root' AND state IN ('settled', 'reconciled') THEN actual_cost_micros
         WHEN source = 'root' AND state = 'cancelled' AND terminal_reason = 'admission_compensated' THEN 0
         WHEN source = 'root' THEN reserved_cost_micros
         WHEN source = 'preparation' AND state = 'settled' THEN actual_cost_micros
         WHEN source = 'preparation' AND state = 'cancelled' AND terminal_reason = 'admission_compensated' THEN 0
         WHEN source = 'preparation' THEN reserved_cost_micros
         ELSE 0
       END
     ) AS total
     FROM (
       SELECT 'root' AS source, state, terminal_reason, reserved_cost_micros,
              actual_cost_micros
       FROM code_execution_reservation WHERE ${column} = ?
       UNION ALL
       SELECT 'preparation' AS source, state, terminal_reason, reserved_cost_micros,
              actual_cost_micros
       FROM code_execution_nested_allocation
       WHERE parent_kind = 'attachment_preparation' AND ${column} = ?
     )`,
      period,
      period,
    )
    .toArray()[0];
  return row?.total ?? 0;
}

function countLiveExecutions(sql: SqlStorage): number {
  const count = sql
    .exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM code_execution_reservation WHERE state = 'reserved'`,
    )
    .toArray()[0]?.count;
  return typeof count === "number" && Number.isSafeInteger(count) ? count : 0;
}

function readReservationByExecution(
  sql: SqlStorage,
  executionId: string,
): ReservationRow | undefined {
  return sql
    .exec<ReservationRow>(
      `SELECT * FROM code_execution_reservation WHERE execution_id = ?`,
      executionId,
    )
    .toArray()[0];
}

function readWorkspaceAllocationById(
  sql: SqlStorage,
  allocationId: string,
): WorkspaceAllocationRow | undefined {
  return sql
    .exec<WorkspaceAllocationRow>(
      `SELECT * FROM code_execution_nested_allocation WHERE allocation_id = ?`,
      allocationId,
    )
    .toArray()[0];
}

function readWorkspaceAllocationByParent(
  sql: SqlStorage,
  parent: WorkspaceExecutorAllocationParent,
): WorkspaceAllocationRow | undefined {
  return sql
    .exec<WorkspaceAllocationRow>(
      `SELECT * FROM code_execution_nested_allocation
     WHERE parent_kind = ? AND parent_id = ?`,
      parent.kind,
      workspaceAllocationParentId(parent),
    )
    .toArray()[0];
}

function requireWorkspaceAllocation(
  sql: SqlStorage,
  allocationId: string,
): WorkspaceAllocationRow {
  const row = readWorkspaceAllocationById(sql, allocationId);
  if (row === undefined) throw new Error("workspace_allocation_write_lost");
  return row;
}

type WorkspaceAllocationParentContext = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runtimeGeneration: number;
};

function validateWorkspaceAllocationParent(
  sql: SqlStorage,
  input: WorkspaceExecutorAllocationReserveInput,
): Result<WorkspaceAllocationParentContext, CodeModeBudgetError> {
  switch (input.parent.kind) {
    case "attachment_preparation":
      return {
        ok: true,
        value: {
          sessionId: input.parent.sessionId,
          turnId: input.parent.turnId,
          runtimeGeneration: input.parent.runtimeGeneration,
        },
      };
    case "code_mode_execution": {
      const parent = readLiveFencedReservation(sql, {
        organisationId: input.organisationId,
        executionId: input.parent.executionId,
        leaseId: input.parent.leaseId,
        now: input.now,
      });
      if (!parent.ok) return { ok: false, error: parent.error };
      if (
        parent.value.price_book_revision !== CODE_MODE_PRICE_BOOK_REVISION_V2 ||
        parent.value.reserved_cost_micros <
          CODE_MODE_ENGINE_RESERVED_COST_MICROS +
            WORKSPACE_EXECUTOR_RESERVED_COST_MICROS ||
        input.executionDeadlineAt > parent.value.execution_deadline_at ||
        input.leaseExpiresAt > (parent.value.lease_expires_at ?? 0)
      ) {
        return { ok: false, error: { code: "code_mode_reservation_conflict" } };
      }
      return {
        ok: true,
        value: {
          sessionId: parent.value.session_id,
          turnId: parent.value.turn_id,
          runtimeGeneration: parent.value.runtime_generation,
        },
      };
    }
  }
}

function workspaceAllocationParentId(
  parent: WorkspaceExecutorAllocationParent,
): string {
  switch (parent.kind) {
    case "code_mode_execution":
      return parent.executionId;
    case "attachment_preparation":
      return parent.preparationId;
  }
}

function workspaceAllocationParentSessionId(
  parent: WorkspaceExecutorAllocationParent,
  context: WorkspaceAllocationParentContext,
): string {
  return parent.kind === "attachment_preparation"
    ? parent.sessionId
    : context.sessionId;
}

function workspaceAllocationParentTurnId(
  parent: WorkspaceExecutorAllocationParent,
  context: WorkspaceAllocationParentContext,
): string {
  return parent.kind === "attachment_preparation"
    ? parent.turnId
    : context.turnId;
}

function workspaceAllocationParentRuntimeGeneration(
  parent: WorkspaceExecutorAllocationParent,
  context: WorkspaceAllocationParentContext,
): number {
  return parent.kind === "attachment_preparation"
    ? parent.runtimeGeneration
    : context.runtimeGeneration;
}

function validateWorkspaceAllocationFence(
  row: WorkspaceAllocationRow | undefined,
  input: Pick<
    WorkspaceExecutorAllocationSettleInput,
    "organisationId" | "parent" | "allocationId"
  >,
): Result<WorkspaceAllocationRow, CodeModeBudgetError> {
  if (
    row === undefined ||
    row.organisation_id !== input.organisationId ||
    row.parent_kind !== input.parent.kind ||
    row.parent_id !== workspaceAllocationParentId(input.parent) ||
    row.allocation_id !== input.allocationId
  ) {
    return { ok: false, error: { code: "code_mode_reservation_not_found" } };
  }
  return row.parent_lease_id === input.parent.leaseId &&
    workspaceAllocationRunIdentityMatches(row, input.parent)
    ? { ok: true, value: row }
    : row.parent_lease_id === input.parent.leaseId
      ? { ok: false, error: { code: "code_mode_reservation_conflict" } }
      : { ok: false, error: { code: "code_mode_reservation_lease_conflict" } };
}

function workspaceAllocationRunIdentityMatches(
  row: WorkspaceAllocationRow,
  parent: WorkspaceExecutorAllocationParent,
): boolean {
  return (
    parent.kind !== "attachment_preparation" ||
    (row.session_id === parent.sessionId &&
      row.turn_id === parent.turnId &&
      row.runtime_generation === parent.runtimeGeneration)
  );
}

function readLiveFencedReservation(
  sql: SqlStorage,
  input: {
    readonly organisationId: OrganisationId;
    readonly executionId: string;
    readonly leaseId: string;
    readonly now: number;
  },
): Result<ReservationRow, CodeModeBudgetError> {
  const row = readReservationByExecution(sql, input.executionId);
  if (row === undefined || row.organisation_id !== input.organisationId) {
    return { ok: false, error: { code: "code_mode_reservation_not_found" } };
  }
  if (row.lease_id !== input.leaseId) {
    return {
      ok: false,
      error: { code: "code_mode_reservation_lease_conflict" },
    };
  }
  if (row.state !== "reserved") {
    return {
      ok: false,
      error: {
        code: "code_mode_reservation_invalid_transition",
        state: row.state,
      },
    };
  }
  if (input.now >= row.execution_deadline_at) {
    return {
      ok: false,
      error: { code: "code_mode_execution_deadline_elapsed" },
    };
  }
  return { ok: true, value: row };
}

function readCapabilityCall(
  sql: SqlStorage,
  executionId: string,
  callId: string,
): CallRow | undefined {
  return sql
    .exec<CallRow>(
      `SELECT state, input_bytes, output_bytes
     FROM code_execution_call WHERE execution_id = ? AND call_id = ?`,
      executionId,
      callId,
    )
    .toArray()[0];
}

function readReconciliation(
  sql: SqlStorage,
  executionId: string,
): ReconciliationRow | undefined {
  return sql
    .exec<ReconciliationRow>(
      `SELECT provider_cost_micros, reconciled_at
     FROM code_execution_reconciliation WHERE execution_id = ?`,
      executionId,
    )
    .toArray()[0];
}

function requireCapabilityCounter(
  sql: SqlStorage,
  executionId: string,
): CounterRow {
  const row = sql
    .exec<CounterRow>(
      `SELECT * FROM code_execution_call_counter WHERE execution_id = ?`,
      executionId,
    )
    .toArray()[0];
  if (row === undefined) throw new Error("code_mode_counter_missing");
  return row;
}

function readCapabilityCounter(
  sql: SqlStorage,
  executionId: string,
): Result<CodeModeCapabilityCounter, CodeModeBudgetError> {
  const row = requireCapabilityCounter(sql, executionId);
  return {
    ok: true,
    value: {
      executionId: row.execution_id,
      capabilityCalls: row.capability_calls,
      inFlightCalls: row.in_flight_calls,
      inputBytes: row.input_bytes,
      outputBytes: row.output_bytes,
    },
  };
}

function parseStoredBudget(
  raw: string,
): Result<CodeModeBudget, CodeModeBudgetError> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  if (!isRecord(value)) {
    return { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  const budget: CodeModeBudget = {
    maxDurationMs: numberField(value, "maxDurationMs"),
    maxCapabilityCalls: numberField(value, "maxCapabilityCalls"),
    maxConcurrentCalls: numberField(value, "maxConcurrentCalls"),
    maxSourceBytes: numberField(value, "maxSourceBytes"),
    maxOutputBytes: numberField(value, "maxOutputBytes"),
  };
  return validPilotBudget(budget)
    ? { ok: true, value: budget }
    : { ok: false, error: { code: "code_mode_reservation_conflict" } };
}

function numberField(value: Record<string, unknown>, field: string): number {
  const candidate = value[field];
  return typeof candidate === "number" ? candidate : Number.NaN;
}

function readReservationForTurn(
  sql: SqlStorage,
  input: Pick<
    CodeModeOrganisationReserveInput,
    "organisationId" | "sessionId" | "turnId"
  >,
): ReservationRow | undefined {
  return sql
    .exec<ReservationRow>(
      `SELECT * FROM code_execution_reservation
     WHERE organisation_id = ? AND session_id = ? AND turn_id = ?`,
      input.organisationId,
      input.sessionId,
      input.turnId,
    )
    .toArray()[0];
}

function requireReservation(
  sql: SqlStorage,
  executionId: string,
): ReservationRow {
  const row = readReservationByExecution(sql, executionId);
  if (row === undefined) throw new Error("code_mode_reservation_write_lost");
  return row;
}

function reservationMatches(
  row: ReservationRow,
  input: CodeModeOrganisationReserveInput,
): boolean {
  return (
    row.organisation_id === input.organisationId &&
    row.session_id === input.sessionId &&
    row.turn_id === input.turnId &&
    row.runtime_generation === input.runtimeGeneration &&
    row.idempotency_key === input.idempotencyKey &&
    row.lease_id === input.leaseId &&
    row.admission_digest === input.admissionDigest &&
    row.execution_deadline_at === input.executionDeadlineAt &&
    row.lease_expires_at === input.leaseExpiresAt &&
    row.program_digest === input.programDigest &&
    row.requirements_digest === input.requirementsDigest &&
    row.policy_digest === input.policyDigest &&
    row.catalog_digest === input.catalogDigest &&
    row.router_revision === input.routerRevision &&
    row.runtime_revision === input.runtimeRevision &&
    row.placement_json === JSON.stringify(input.placement) &&
    row.budget_json === JSON.stringify(input.budget) &&
    row.customer_disposition === input.customerDisposition &&
    row.reserved_cost_micros === input.reservedCostMicros &&
    row.price_book_revision === input.priceBookRevision
  );
}

function workspaceAllocationMatches(
  row: WorkspaceAllocationRow,
  input: WorkspaceExecutorAllocationReserveInput,
): boolean {
  return (
    row.organisation_id === input.organisationId &&
    row.parent_kind === input.parent.kind &&
    row.parent_id === workspaceAllocationParentId(input.parent) &&
    row.parent_lease_id === input.parent.leaseId &&
    workspaceAllocationRunIdentityMatches(row, input.parent) &&
    row.allocation_id === input.allocationId &&
    row.idempotency_key === input.idempotencyKey &&
    row.allocation_digest === input.allocationDigest &&
    row.price_book_revision === input.priceBookRevision &&
    row.profile_json === JSON.stringify(input.profile) &&
    row.reserved_cost_micros === input.reservedCostMicros &&
    row.execution_deadline_at === input.executionDeadlineAt &&
    (row.state === "reserved"
      ? row.lease_expires_at === input.leaseExpiresAt
      : row.lease_expires_at === null)
  );
}

function settledWorkspaceAllocationMatches(
  row: WorkspaceAllocationRow,
  input: WorkspaceExecutorAllocationSettleInput,
): boolean {
  return (
    row.receipt_id === input.receiptId &&
    row.receipt_digest === input.receiptDigest &&
    row.actual_cost_micros === input.actualCostMicros &&
    row.input_bytes === input.inputBytes &&
    row.output_bytes === input.outputBytes &&
    row.duration_ms === input.durationMs &&
    row.outcome === input.outcome
  );
}

function settledReceiptMatches(
  sql: SqlStorage,
  row: ReservationRow,
  input: CodeModeOrganisationSettleInput,
): boolean {
  const receipt = sql
    .exec<ReceiptRow>(
      `SELECT receipt_id, receipt_digest, actual_cost_micros, capability_calls,
            input_bytes, output_bytes, outcome
     FROM code_execution_receipt WHERE execution_id = ?`,
      input.executionId,
    )
    .toArray()[0];
  const counter = requireCapabilityCounter(sql, input.executionId);
  return (
    receipt !== undefined &&
    row.receipt_id === input.receiptId &&
    row.receipt_digest === input.receiptDigest &&
    row.actual_cost_micros === input.actualCostMicros &&
    row.outcome === input.outcome &&
    receipt.receipt_id === input.receiptId &&
    receipt.receipt_digest === input.receiptDigest &&
    receipt.actual_cost_micros === input.actualCostMicros &&
    receipt.capability_calls === counter.capability_calls &&
    receipt.input_bytes === counter.input_bytes &&
    receipt.output_bytes === counter.output_bytes &&
    receipt.outcome === input.outcome
  );
}

function parseReservationRow(
  row: ReservationRow,
): Result<CodeModeOrganisationReservation, CodeModeBudgetError> {
  const organisationId = parseOrganisationId(row.organisation_id);
  const sessionId = parseSessionId(row.session_id);
  if (!organisationId.ok || !sessionId.ok) {
    return { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  const identity: CodeModeReservationIdentity = {
    organisationId: organisationId.value,
    sessionId: sessionId.value,
    turnId: row.turn_id,
    runtimeGeneration: row.runtime_generation,
    executionId: row.execution_id,
    idempotencyKey: row.idempotency_key,
    leaseId: row.lease_id,
  };
  switch (row.state) {
    case "reserved":
      if (row.lease_expires_at === null) break;
      return {
        ok: true,
        value: {
          ...identity,
          kind: "reserved",
          reservedCostMicros: row.reserved_cost_micros,
          leaseExpiresAt: row.lease_expires_at,
          priceBookRevision: row.price_book_revision,
        },
      };
    case "settled":
      const outcome = row.outcome;
      if (
        row.receipt_id === null ||
        row.receipt_digest === null ||
        row.actual_cost_micros === null ||
        row.terminal_at === null ||
        outcome === null ||
        !isOutcome(outcome)
      )
        break;
      return {
        ok: true,
        value: {
          ...identity,
          kind: "settled",
          reservedCostMicros: row.reserved_cost_micros,
          receiptId: row.receipt_id,
          receiptDigest: row.receipt_digest,
          actualCostMicros: row.actual_cost_micros,
          outcome,
          settledAt: row.terminal_at,
          priceBookRevision: row.price_book_revision,
        },
      };
    case "reconciled": {
      const reconciledOutcome = row.outcome;
      if (
        row.receipt_id === null ||
        row.receipt_digest === null ||
        row.actual_cost_micros === null ||
        row.terminal_at === null ||
        reconciledOutcome === null ||
        !isOutcome(reconciledOutcome) ||
        row.provider_cost_micros === null ||
        row.reconciled_at === null
      )
        break;
      return {
        ok: true,
        value: {
          ...identity,
          kind: "reconciled",
          reservedCostMicros: row.reserved_cost_micros,
          receiptId: row.receipt_id,
          receiptDigest: row.receipt_digest,
          actualCostMicros: row.actual_cost_micros,
          providerCostMicros: row.provider_cost_micros,
          outcome: reconciledOutcome,
          settledAt: row.terminal_at,
          reconciledAt: row.reconciled_at,
          priceBookRevision: row.price_book_revision,
        },
      };
    }
    case "cancelled":
      if (
        row.terminal_at === null ||
        (row.terminal_reason !== "admission_compensated" &&
          row.terminal_reason !== "turn_cancelled")
      )
        break;
      return {
        ok: true,
        value: {
          ...identity,
          kind: "cancelled",
          reason: row.terminal_reason,
          cancelledAt: row.terminal_at,
        },
      };
    case "expired":
      if (row.terminal_at === null) break;
      return {
        ok: true,
        value: { ...identity, kind: "expired", expiredAt: row.terminal_at },
      };
    default:
      break;
  }
  return { ok: false, error: { code: "code_mode_reservation_conflict" } };
}

function parseWorkspaceAllocationRow(
  row: WorkspaceAllocationRow,
): Result<WorkspaceExecutorAllocationReservation, CodeModeBudgetError> {
  const organisationId = parseOrganisationId(row.organisation_id);
  const parent = parseWorkspaceAllocationParentRow(row);
  if (
    !organisationId.ok ||
    !parent.ok ||
    !validWorkspaceAllocationId(row.allocation_id) ||
    !validOpaqueId(row.idempotency_key) ||
    !isSha256(row.allocation_digest)
  ) {
    return { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  const identity: WorkspaceExecutorAllocationIdentity = {
    organisationId: organisationId.value,
    parent: parent.value,
    allocationId: row.allocation_id,
    idempotencyKey: row.idempotency_key,
    allocationDigest: row.allocation_digest,
  };
  switch (row.state) {
    case "reserved":
      if (
        row.price_book_revision !== CODE_MODE_PRICE_BOOK_REVISION_V2 ||
        row.profile_json !==
          JSON.stringify(WORKSPACE_EXECUTOR_ALLOCATION_PROFILE) ||
        row.reserved_cost_micros !== WORKSPACE_EXECUTOR_RESERVED_COST_MICROS ||
        row.lease_expires_at === null
      )
        break;
      return {
        ok: true,
        value: {
          ...identity,
          kind: "reserved",
          priceBookRevision: CODE_MODE_PRICE_BOOK_REVISION_V2,
          profile: WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
          reservedCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
          executionDeadlineAt: row.execution_deadline_at,
          leaseExpiresAt: row.lease_expires_at,
        },
      };
    case "settled": {
      const outcome = row.outcome;
      if (
        row.reserved_cost_micros !== WORKSPACE_EXECUTOR_RESERVED_COST_MICROS ||
        row.receipt_id === null ||
        row.receipt_digest === null ||
        row.actual_cost_micros === null ||
        row.input_bytes === null ||
        row.output_bytes === null ||
        row.duration_ms === null ||
        row.terminal_at === null ||
        outcome === null ||
        !isOutcome(outcome)
      )
        break;
      return {
        ok: true,
        value: {
          ...identity,
          kind: "settled",
          receiptId: row.receipt_id,
          receiptDigest: row.receipt_digest,
          reservedCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
          actualCostMicros: row.actual_cost_micros,
          inputBytes: row.input_bytes,
          outputBytes: row.output_bytes,
          durationMs: row.duration_ms,
          outcome,
          settledAt: row.terminal_at,
        },
      };
    }
    case "cancelled":
      if (
        row.terminal_at === null ||
        (row.terminal_reason !== "admission_compensated" &&
          row.terminal_reason !== "turn_cancelled")
      )
        break;
      return {
        ok: true,
        value: {
          ...identity,
          kind: "cancelled",
          reason: row.terminal_reason,
          cancelledAt: row.terminal_at,
        },
      };
    case "expired":
      if (row.terminal_at === null) break;
      return {
        ok: true,
        value: { ...identity, kind: "expired", expiredAt: row.terminal_at },
      };
    default:
      break;
  }
  return { ok: false, error: { code: "code_mode_reservation_conflict" } };
}

function parseWorkspaceAllocationParentRow(
  row: WorkspaceAllocationRow,
): Result<WorkspaceExecutorAllocationParent, CodeModeBudgetError> {
  const sessionId = parseSessionId(row.session_id);
  if (
    !sessionId.ok ||
    !validOpaqueId(row.parent_lease_id) ||
    !validOpaqueId(row.turn_id) ||
    !isPositiveInteger(row.runtime_generation)
  ) {
    return { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  switch (row.parent_kind) {
    case "code_mode_execution":
      return validExecutionId(row.parent_id)
        ? {
            ok: true,
            value: {
              kind: "code_mode_execution",
              executionId: row.parent_id,
              leaseId: row.parent_lease_id,
            },
          }
        : { ok: false, error: { code: "code_mode_reservation_conflict" } };
    case "attachment_preparation":
      return validOpaqueId(row.parent_id)
        ? {
            ok: true,
            value: {
              kind: "attachment_preparation",
              preparationId: row.parent_id,
              leaseId: row.parent_lease_id,
              sessionId: sessionId.value,
              turnId: row.turn_id,
              runtimeGeneration: row.runtime_generation,
            },
          }
        : { ok: false, error: { code: "code_mode_reservation_conflict" } };
    default:
      return { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
}
