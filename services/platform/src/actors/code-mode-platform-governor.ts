import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import { readIsolateLocation } from "../isolate-location";
import {
  parseRequestId,
  parseSessionId,
  parseOrganisationId,
  type RequestId,
} from "../ids";
import type { Result } from "../result";
import {
  decideCodeModeLeaseRebind,
  parseCodeModeCancelInput,
  parseCodeModeLeaseRebindInput,
  parseCodeModeReconcileInput,
  parseCodeModeReserveInput,
  parseCodeModeSettleInput,
  parseWorkspaceExecutorAllocationCancelInput,
  parseWorkspaceExecutorAllocationReserveInput,
  parseWorkspaceExecutorAllocationSettleInput,
  CODE_MODE_ENGINE_RESERVED_COST_MICROS,
  CODE_MODE_PRICE_BOOK_REVISION_V2,
  WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
  WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
  type CodeModeBudgetError,
  type CodeModeLeaseRebindInput,
  type CodeModeOrganisationCancelInput,
  type CodeModeOrganisationReconcileInput,
  type CodeModeOrganisationReserveInput,
  type CodeModeOrganisationSettleInput,
  type WorkspaceExecutorAllocationCancelInput,
  type WorkspaceExecutorAllocationParent,
  type WorkspaceExecutorAllocationReservation,
  type WorkspaceExecutorAllocationReserveInput,
  type WorkspaceExecutorAllocationSettleInput,
} from "./code-mode-budget";
import { isNonNegativeInteger, isPositiveInteger } from "@seams/std";

const MAX_CONCURRENT_EXECUTIONS = 8;
const DAILY_COST_LIMIT_MICROS = 100_000_000;
const MONTHLY_COST_LIMIT_MICROS = 1_000_000_000;
const BURN_WINDOW_MS = 60_000;
const BURN_WINDOW_LIMIT_MICROS = 10_000_000;
const MAX_CONCURRENT_WORKSPACE_ALLOCATIONS = 4;
const EXECUTION_ID_PATTERN = /^cmx-[a-zA-Z0-9_-]{1,120}$/;
const WORKSPACE_ALLOCATION_ID_PATTERN = /^wxa-[a-zA-Z0-9_-]{1,120}$/;
const OPAQUE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,191}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type CodeModePlatformGovernorPing = {
  readonly ok: true;
  readonly kind: "code-mode-platform-governor";
};

type CodeModePlatformAdmissionUser = {
  readonly requestId: RequestId;
  readonly idempotencyKey: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly now: number;
};

export type CodeModePlatformAdmissionControlInput =
  | (CodeModePlatformAdmissionUser & {
      readonly command: "freeze_admission";
    })
  | (CodeModePlatformAdmissionUser & {
      readonly command: "open_admission";
    });

type CodeModePlatformAdmissionState =
  | {
      readonly state: "open";
      readonly generation: number;
      readonly updatedAt: number;
      readonly requestId: RequestId;
      readonly reason?: never;
    }
  | {
      readonly state: "frozen";
      readonly generation: number;
      readonly updatedAt: number;
      readonly requestId: RequestId;
      readonly reason: string;
    };

type CodeModePlatformCutoverBlocker =
  | { readonly kind: "admission_open" }
  | { readonly kind: "live_root_reservations"; readonly count: number }
  | { readonly kind: "live_workspace_allocations"; readonly count: number }
  | { readonly kind: "settled_unreconciled"; readonly count: number }
  | { readonly kind: "scheduled_alarm"; readonly scheduledAt: number };

type CodeModePlatformCutoverBase = {
  readonly schemaVersion: "code_mode_platform_cutover.v1";
  readonly inspectedAt: number;
  readonly admission: CodeModePlatformAdmissionState;
  readonly remoteEnabled: boolean;
  readonly settledUnreconciled: number;
};

type CodeModePlatformCutoverQuiescence =
  | (CodeModePlatformCutoverBase & {
      readonly kind: "quiescent";
      readonly blockers: readonly [];
    })
  | (CodeModePlatformCutoverBase & {
      readonly kind: "blocked";
      readonly blockers: readonly [
        CodeModePlatformCutoverBlocker,
        ...CodeModePlatformCutoverBlocker[],
      ];
    });

type PlatformReservationIdentity = {
  readonly organisationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runtimeGeneration: number;
  readonly executionId: string;
  readonly admissionDigest: string;
  readonly leaseId: string;
};

export type CodeModePlatformReservation =
  | (PlatformReservationIdentity & {
      readonly kind: "reserved";
      readonly reservedCostMicros: number;
      readonly executionDeadlineAt: number;
      readonly leaseExpiresAt: number;
    })
  | (PlatformReservationIdentity & {
      readonly kind: "settled";
      readonly receiptId: string;
      readonly receiptDigest: string;
      readonly actualCostMicros: number;
      readonly outcome: CodeModeOrganisationSettleInput["outcome"];
      readonly settledAt: number;
    })
  | (PlatformReservationIdentity & {
      readonly kind: "reconciled";
      readonly receiptId: string;
      readonly receiptDigest: string;
      readonly actualCostMicros: number;
      readonly providerCostMicros: number;
      readonly outcome: CodeModeOrganisationSettleInput["outcome"];
      readonly settledAt: number;
      readonly reconciledAt: number;
    })
  | (PlatformReservationIdentity & {
      readonly kind: "cancelled";
      readonly reason: CodeModeOrganisationCancelInput["reason"];
      readonly cancelledAt: number;
    })
  | (PlatformReservationIdentity & {
      readonly kind: "expired";
      readonly expiredAt: number;
    });

export type CodeModePlatformGovernorError =
  | CodeModeBudgetError
  | { readonly code: "code_mode_platform_disabled" }
  | { readonly code: "code_mode_remote_placement_disabled" }
  | { readonly code: "code_mode_platform_concurrency_exceeded" }
  | { readonly code: "code_mode_platform_daily_budget_exceeded" }
  | { readonly code: "code_mode_platform_monthly_budget_exceeded" }
  | { readonly code: "code_mode_platform_burn_rate_exceeded" }
  | { readonly code: "code_mode_workspace_platform_concurrency_exceeded" }
  | { readonly code: "code_mode_platform_operator_conflict" }
  | { readonly code: "code_mode_platform_state_invalid" };

type PlatformAdmissionStateRow = Record<string, SqlStorageValue> & {
  admission_state: string;
  generation: number;
  updated_at: number;
  request_id: string;
  reason: string | null;
};

type PlatformOperatorRequestRow = Record<string, SqlStorageValue> & {
  idempotency_key: string;
  command: string;
  reason: string;
  request_id: string;
  requested_by: string;
  applied_at: number;
  resulting_state: string;
  resulting_generation: number;
};

type PlatformRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  session_id: string;
  turn_id: string;
  runtime_generation: number;
  execution_id: string;
  admission_digest: string;
  idempotency_key: string;
  lease_id: string;
  state: string;
  reserved_cost_micros: number;
  execution_deadline_at: number;
  lease_expires_at: number | null;
  receipt_id: string | null;
  receipt_digest: string | null;
  actual_cost_micros: number | null;
  provider_cost_micros: number | null;
  outcome: string | null;
  terminal_at: number | null;
  terminal_reason: string | null;
  reconciled_at: number | null;
};

type PlatformWorkspaceAllocationRow = Record<string, SqlStorageValue> & {
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
  burn_bucket: number;
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

type PlatformTableInfoRow = Record<string, SqlStorageValue> & {
  name: string;
};

const PLATFORM_WORKSPACE_ALLOCATION_TABLE =
  "code_mode_platform_workspace_allocation";
const PLATFORM_WORKSPACE_ALLOCATION_CURRENT_COLUMNS = [
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
  "burn_bucket",
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

export class CodeModePlatformGovernorActor extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.transactionSync(
      createPlatformGovernorSchema.bind(null, this.ctx.storage.sql),
    );
  }

  /**
   * Empties a governor of an earlier name. The operator route calls it only
   * for an object that is not the governor of this build.
   */
  async eraseUnregisteredState(): Promise<Result<null, never>> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { ok: true, value: null };
  }

  async ping(): Promise<CodeModePlatformGovernorPing> {
    return { ok: true, kind: "code-mode-platform-governor" };
  }

  /**
   * The Cloudflare location that runs the governor. Each script calls the
   * governor, so an operator reads this after a release that moves it.
   */
  async location(): Promise<string | null> {
    return readIsolateLocation(this.env);
  }

  async controlAdmission(
    input: CodeModePlatformAdmissionControlInput,
  ): Promise<
    Result<CodeModePlatformAdmissionState, CodeModePlatformGovernorError>
  > {
    const parsed = parsePlatformAdmissionControlInput(input);
    if (!parsed.ok) return parsed;
    const result = this.ctx.storage.transactionSync(
      applyPlatformAdmissionControl.bind(
        null,
        this.ctx.storage.sql,
        parsed.value,
      ),
    );
    await schedulePlatformAlarm(this.ctx.storage, this.ctx.storage.sql);
    return result;
  }

  /**
   * Whether new Code Mode work may be admitted now. A Session Actor asks
   * before each capability call, so that a freeze also stops the calls of a
   * script that is already running.
   */
  async isAdmissionOpen(): Promise<boolean> {
    const control = this.ctx.storage.sql
      .exec<{ enabled: number }>(
        `SELECT enabled FROM code_mode_platform_control WHERE singleton = 1`,
      )
      .toArray()[0];
    return control?.enabled === 1;
  }

  async inspectCutoverQuiescence(input: {
    readonly now: number;
  }): Promise<
    Result<CodeModePlatformCutoverQuiescence, CodeModePlatformGovernorError>
  > {
    if (!isNonNegativeInteger(input.now)) {
      return invalidPlatformInput("now");
    }
    const alarmAt = await this.ctx.storage.getAlarm();
    return inspectPlatformCutoverQuiescence({
      sql: this.ctx.storage.sql,
      inspectedAt: input.now,
      alarmAt,
    });
  }

  async reserve(
    input: CodeModeOrganisationReserveInput,
  ): Promise<
    Result<CodeModePlatformReservation, CodeModePlatformGovernorError>
  > {
    const parsed = parseCodeModeReserveInput(input);
    if (!parsed.ok) return parsed;
    const result = this.ctx.storage.transactionSync(
      reservePlatformBudget.bind(null, this.ctx.storage.sql, parsed.value),
    );
    await schedulePlatformAlarm(this.ctx.storage, this.ctx.storage.sql);
    return result;
  }

  async settle(
    input: CodeModeOrganisationSettleInput,
  ): Promise<
    Result<CodeModePlatformReservation, CodeModePlatformGovernorError>
  > {
    const parsed = parseCodeModeSettleInput(input);
    if (!parsed.ok) return parsed;
    const result = this.ctx.storage.transactionSync(
      settlePlatformBudget.bind(null, this.ctx.storage.sql, parsed.value),
    );
    await schedulePlatformAlarm(this.ctx.storage, this.ctx.storage.sql);
    return result;
  }

  async cancel(
    input: CodeModeOrganisationCancelInput,
  ): Promise<
    Result<CodeModePlatformReservation, CodeModePlatformGovernorError>
  > {
    const parsed = parseCodeModeCancelInput(input);
    if (!parsed.ok) return parsed;
    const result = this.ctx.storage.transactionSync(
      cancelPlatformBudget.bind(null, this.ctx.storage.sql, parsed.value),
    );
    await schedulePlatformAlarm(this.ctx.storage, this.ctx.storage.sql);
    return result;
  }

  /**
   * Binds a live reservation to the lease of a Session Actor's next runtime
   * generation. A frozen admission refuses it, so that no VM resumes during a
   * freeze. Settlement and cancellation do not pass through here.
   */
  async rebindLease(
    input: CodeModeLeaseRebindInput,
  ): Promise<
    Result<CodeModePlatformReservation, CodeModePlatformGovernorError>
  > {
    const parsed = parseCodeModeLeaseRebindInput(input);
    if (!parsed.ok) return parsed;
    const result = this.ctx.storage.transactionSync(
      rebindPlatformLease.bind(null, this.ctx.storage.sql, parsed.value),
    );
    await schedulePlatformAlarm(this.ctx.storage, this.ctx.storage.sql);
    return result;
  }

  async reconcile(
    input: CodeModeOrganisationReconcileInput,
  ): Promise<
    Result<CodeModePlatformReservation, CodeModePlatformGovernorError>
  > {
    const parsed = parseCodeModeReconcileInput(input);
    if (!parsed.ok) return parsed;
    const result = this.ctx.storage.transactionSync(
      reconcilePlatformBudget.bind(null, this.ctx.storage.sql, parsed.value),
    );
    return result;
  }

  async reserveWorkspaceAllocation(
    input: WorkspaceExecutorAllocationReserveInput,
  ): Promise<
    Result<
      WorkspaceExecutorAllocationReservation,
      CodeModePlatformGovernorError
    >
  > {
    const parsed = parseWorkspaceExecutorAllocationReserveInput(input);
    if (!parsed.ok) return parsed;
    const result = this.ctx.storage.transactionSync(
      reservePlatformWorkspaceAllocation.bind(
        null,
        this.ctx.storage.sql,
        parsed.value,
      ),
    );
    await schedulePlatformAlarm(this.ctx.storage, this.ctx.storage.sql);
    return result;
  }

  async settleWorkspaceAllocation(
    input: WorkspaceExecutorAllocationSettleInput,
  ): Promise<
    Result<
      WorkspaceExecutorAllocationReservation,
      CodeModePlatformGovernorError
    >
  > {
    const parsed = parseWorkspaceExecutorAllocationSettleInput(input);
    if (!parsed.ok) return parsed;
    const result = this.ctx.storage.transactionSync(
      settlePlatformWorkspaceAllocation.bind(
        null,
        this.ctx.storage.sql,
        parsed.value,
      ),
    );
    await schedulePlatformAlarm(this.ctx.storage, this.ctx.storage.sql);
    return result;
  }

  async cancelWorkspaceAllocation(
    input: WorkspaceExecutorAllocationCancelInput,
  ): Promise<
    Result<
      WorkspaceExecutorAllocationReservation,
      CodeModePlatformGovernorError
    >
  > {
    const parsed = parseWorkspaceExecutorAllocationCancelInput(input);
    if (!parsed.ok) return parsed;
    const result = this.ctx.storage.transactionSync(
      cancelPlatformWorkspaceAllocation.bind(
        null,
        this.ctx.storage.sql,
        parsed.value,
      ),
    );
    await schedulePlatformAlarm(this.ctx.storage, this.ctx.storage.sql);
    return result;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(
      expirePlatformReservations.bind(null, this.ctx.storage.sql, now),
    );
    await schedulePlatformAlarm(this.ctx.storage, this.ctx.storage.sql);
  }
}

function createPlatformGovernorSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS code_mode_platform_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      remote_enabled INTEGER NOT NULL CHECK (remote_enabled IN (0, 1))
    )`,
  );
  sql.exec(
    `INSERT OR IGNORE INTO code_mode_platform_control
     (singleton, enabled, remote_enabled) VALUES (1, 1, 1)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS code_mode_platform_workspace_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
    )`,
  );
  sql.exec(
    `INSERT OR IGNORE INTO code_mode_platform_workspace_control
     (singleton, enabled) VALUES (1, 1)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS code_mode_platform_reservation (
      organisation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      runtime_generation INTEGER NOT NULL CHECK (runtime_generation >= 1),
      execution_id TEXT PRIMARY KEY,
      admission_digest TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      lease_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'reconciled', 'cancelled', 'expired')),
      utc_day TEXT NOT NULL,
      utc_month TEXT NOT NULL,
      burn_bucket INTEGER NOT NULL,
      reserved_cost_micros INTEGER NOT NULL CHECK (reserved_cost_micros >= 1),
      execution_deadline_at INTEGER NOT NULL,
      lease_expires_at INTEGER,
      receipt_id TEXT,
      receipt_digest TEXT,
      actual_cost_micros INTEGER,
      provider_cost_micros INTEGER,
      outcome TEXT,
      reserved_at INTEGER NOT NULL,
      terminal_at INTEGER,
      terminal_reason TEXT,
      reconciled_at INTEGER,
      UNIQUE (organisation_id, session_id, turn_id),
      CHECK (
        (state = 'reserved' AND lease_expires_at IS NOT NULL AND terminal_at IS NULL) OR
        (state = 'settled' AND lease_expires_at IS NULL AND receipt_id IS NOT NULL AND receipt_digest IS NOT NULL AND actual_cost_micros IS NOT NULL AND terminal_at IS NOT NULL AND reconciled_at IS NULL) OR
        (state = 'reconciled' AND lease_expires_at IS NULL AND receipt_id IS NOT NULL AND receipt_digest IS NOT NULL AND actual_cost_micros IS NOT NULL AND provider_cost_micros IS NOT NULL AND terminal_at IS NOT NULL AND reconciled_at IS NOT NULL) OR
        (state = 'cancelled' AND lease_expires_at IS NULL AND terminal_at IS NOT NULL AND terminal_reason IN ('admission_compensated', 'turn_cancelled')) OR
        (state = 'expired' AND lease_expires_at IS NULL AND terminal_at IS NOT NULL AND terminal_reason = 'lease_expired')
      )
    )`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS code_mode_platform_reservation_expiry
     ON code_mode_platform_reservation (state, lease_expires_at)`,
  );
  ensurePlatformWorkspaceAllocationSchema(sql);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS code_mode_platform_workspace_allocation_expiry
     ON code_mode_platform_workspace_allocation (state, lease_expires_at)`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS code_mode_platform_workspace_allocation_parent
     ON code_mode_platform_workspace_allocation (parent_kind, parent_id)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS code_mode_platform_cutover_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      admission_state TEXT NOT NULL CHECK (admission_state IN ('open', 'frozen')),
      generation INTEGER NOT NULL CHECK (generation >= 1),
      updated_at INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      reason TEXT
    )`,
  );
  sql.exec(
    `INSERT OR IGNORE INTO code_mode_platform_cutover_control (
       singleton, admission_state, generation, updated_at, request_id, reason
     )
     SELECT 1,
            CASE WHEN platform.enabled = 1 AND workspace.enabled = 1
              THEN 'open' ELSE 'frozen' END,
            1, 0, 'req-code-mode-bootstrap',
            CASE WHEN platform.enabled = 1 AND workspace.enabled = 1
              THEN NULL ELSE 'preexisting_platform_control' END
     FROM code_mode_platform_control AS platform
     CROSS JOIN code_mode_platform_workspace_control AS workspace
     WHERE platform.singleton = 1 AND workspace.singleton = 1`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS code_mode_platform_operator_request (
      idempotency_key TEXT PRIMARY KEY,
      command TEXT NOT NULL CHECK (command IN ('freeze_admission', 'open_admission')),
      reason TEXT NOT NULL,
      request_id TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      resulting_state TEXT NOT NULL CHECK (resulting_state IN ('open', 'frozen')),
      resulting_generation INTEGER NOT NULL CHECK (resulting_generation >= 1)
    )`,
  );
}

function ensurePlatformWorkspaceAllocationSchema(sql: SqlStorage): void {
  const columns = new Set(
    sql
      .exec<PlatformTableInfoRow>(
        `PRAGMA table_info(${PLATFORM_WORKSPACE_ALLOCATION_TABLE})`,
      )
      .toArray()
      .map((row) => row.name),
  );
  if (columns.size === 0) {
    createPlatformWorkspaceAllocationTable(sql);
    return;
  }
  if (
    !PLATFORM_WORKSPACE_ALLOCATION_CURRENT_COLUMNS.every(
      columns.has.bind(columns),
    )
  ) {
    throw new Error("code_mode_platform_workspace_allocation_schema_invalid");
  }
}

function createPlatformWorkspaceAllocationTable(
  sql: SqlStorage,
  table = PLATFORM_WORKSPACE_ALLOCATION_TABLE,
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
      burn_bucket INTEGER NOT NULL,
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

function parsePlatformAdmissionControlInput(
  input: CodeModePlatformAdmissionControlInput,
): Result<
  CodeModePlatformAdmissionControlInput,
  CodeModePlatformGovernorError
> {
  const requestId = parseRequestId(input.requestId);
  if (!requestId.ok) return invalidPlatformInput("requestId");
  if (!isStableOperatorField(input.idempotencyKey)) {
    return invalidPlatformInput("idempotencyKey");
  }
  if (!isStableOperatorField(input.requestedBy)) {
    return invalidPlatformInput("requestedBy");
  }
  if (!isStableOperatorField(input.reason)) {
    return invalidPlatformInput("reason");
  }
  if (!isNonNegativeInteger(input.now)) return invalidPlatformInput("now");
  switch (input.command) {
    case "freeze_admission":
      return {
        ok: true,
        value: {
          command: "freeze_admission",
          requestId: requestId.value,
          idempotencyKey: input.idempotencyKey,
          requestedBy: input.requestedBy,
          reason: input.reason,
          now: input.now,
        },
      };
    case "open_admission":
      return {
        ok: true,
        value: {
          command: "open_admission",
          requestId: requestId.value,
          idempotencyKey: input.idempotencyKey,
          requestedBy: input.requestedBy,
          reason: input.reason,
          now: input.now,
        },
      };
  }
}

function applyPlatformAdmissionControl(
  sql: SqlStorage,
  input: CodeModePlatformAdmissionControlInput,
): Result<CodeModePlatformAdmissionState, CodeModePlatformGovernorError> {
  const existing = readPlatformOperatorRequest(sql, input.idempotencyKey);
  if (existing !== undefined) {
    return platformOperatorRequestMatches(existing, input)
      ? parsePlatformOperatorResult(existing)
      : { ok: false, error: { code: "code_mode_platform_operator_conflict" } };
  }
  const current = readPlatformAdmissionState(sql);
  if (!current.ok) return current;
  const target = input.command === "freeze_admission" ? "frozen" : "open";
  const generation =
    current.value.state === target
      ? current.value.generation
      : current.value.generation + 1;
  const enabled = target === "open" ? 1 : 0;

  sql.exec(
    `UPDATE code_mode_platform_control SET enabled = ? WHERE singleton = 1`,
    enabled,
  );
  sql.exec(
    `UPDATE code_mode_platform_workspace_control SET enabled = ? WHERE singleton = 1`,
    enabled,
  );
  sql.exec(
    `UPDATE code_mode_platform_cutover_control
     SET admission_state = ?, generation = ?, updated_at = ?, request_id = ?, reason = ?
     WHERE singleton = 1`,
    target,
    generation,
    input.now,
    input.requestId,
    target === "frozen" ? input.reason : null,
  );
  sql.exec(
    `INSERT INTO code_mode_platform_operator_request (
       idempotency_key, command, reason, request_id, requested_by, applied_at,
       resulting_state, resulting_generation
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.idempotencyKey,
    input.command,
    input.reason,
    input.requestId,
    input.requestedBy,
    input.now,
    target,
    generation,
  );
  return readPlatformAdmissionState(sql);
}

function inspectPlatformCutoverQuiescence(input: {
  readonly sql: SqlStorage;
  readonly inspectedAt: number;
  readonly alarmAt: number | null;
}): Result<CodeModePlatformCutoverQuiescence, CodeModePlatformGovernorError> {
  const admission = readPlatformAdmissionState(input.sql);
  if (!admission.ok) return admission;
  const rootControl = input.sql
    .exec<{ enabled: number; remote_enabled: number }>(
      `SELECT enabled, remote_enabled FROM code_mode_platform_control WHERE singleton = 1`,
    )
    .toArray()[0];
  const workspaceControl = input.sql
    .exec<{ enabled: number }>(
      `SELECT enabled FROM code_mode_platform_workspace_control WHERE singleton = 1`,
    )
    .toArray()[0];
  const expectedEnabled = admission.value.state === "open" ? 1 : 0;
  if (
    rootControl === undefined ||
    workspaceControl === undefined ||
    rootControl.enabled !== expectedEnabled ||
    workspaceControl.enabled !== expectedEnabled ||
    (rootControl.remote_enabled !== 0 && rootControl.remote_enabled !== 1)
  ) {
    return { ok: false, error: { code: "code_mode_platform_state_invalid" } };
  }
  const liveRoots = countPlatformLive(input.sql);
  const liveWorkspaces = countPlatformWorkspaceAllocations(input.sql);
  const settledUnreconciled = input.sql
    .exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM code_mode_platform_reservation WHERE state = 'settled'`,
    )
    .toArray()[0]?.count;
  if (
    !isNonNegativeInteger(settledUnreconciled) ||
    (input.alarmAt !== null && !isNonNegativeInteger(input.alarmAt))
  ) {
    return { ok: false, error: { code: "code_mode_platform_state_invalid" } };
  }
  const blockers: CodeModePlatformCutoverBlocker[] = [];
  if (admission.value.state === "open")
    blockers.push({ kind: "admission_open" });
  if (liveRoots > 0)
    blockers.push({ kind: "live_root_reservations", count: liveRoots });
  if (liveWorkspaces > 0) {
    blockers.push({
      kind: "live_workspace_allocations",
      count: liveWorkspaces,
    });
  }
  if (settledUnreconciled > 0) {
    blockers.push({ kind: "settled_unreconciled", count: settledUnreconciled });
  }
  if (input.alarmAt !== null) {
    blockers.push({ kind: "scheduled_alarm", scheduledAt: input.alarmAt });
  }
  const base: CodeModePlatformCutoverBase = {
    schemaVersion: "code_mode_platform_cutover.v1",
    inspectedAt: input.inspectedAt,
    admission: admission.value,
    remoteEnabled: rootControl.remote_enabled === 1,
    settledUnreconciled,
  };
  const [first, ...rest] = blockers;
  return {
    ok: true,
    value:
      first === undefined
        ? { ...base, kind: "quiescent", blockers: [] }
        : { ...base, kind: "blocked", blockers: [first, ...rest] },
  };
}

function readPlatformAdmissionState(
  sql: SqlStorage,
): Result<CodeModePlatformAdmissionState, CodeModePlatformGovernorError> {
  const row = sql
    .exec<PlatformAdmissionStateRow>(
      `SELECT admission_state, generation, updated_at, request_id, reason
     FROM code_mode_platform_cutover_control WHERE singleton = 1`,
    )
    .toArray()[0];
  if (
    row === undefined ||
    !isPositiveInteger(row.generation) ||
    !isNonNegativeInteger(row.updated_at)
  ) {
    return { ok: false, error: { code: "code_mode_platform_state_invalid" } };
  }
  const requestId = parseRequestId(row.request_id);
  if (!requestId.ok) {
    return { ok: false, error: { code: "code_mode_platform_state_invalid" } };
  }
  if (row.admission_state === "open" && row.reason === null) {
    return {
      ok: true,
      value: {
        state: "open",
        generation: row.generation,
        updatedAt: row.updated_at,
        requestId: requestId.value,
      },
    };
  }
  if (
    row.admission_state === "frozen" &&
    typeof row.reason === "string" &&
    row.reason.length > 0
  ) {
    return {
      ok: true,
      value: {
        state: "frozen",
        generation: row.generation,
        updatedAt: row.updated_at,
        requestId: requestId.value,
        reason: row.reason,
      },
    };
  }
  return { ok: false, error: { code: "code_mode_platform_state_invalid" } };
}

function readPlatformOperatorRequest(
  sql: SqlStorage,
  idempotencyKey: string,
): PlatformOperatorRequestRow | undefined {
  return sql
    .exec<PlatformOperatorRequestRow>(
      `SELECT * FROM code_mode_platform_operator_request WHERE idempotency_key = ?`,
      idempotencyKey,
    )
    .toArray()[0];
}

function platformOperatorRequestMatches(
  row: PlatformOperatorRequestRow,
  input: CodeModePlatformAdmissionControlInput,
): boolean {
  return (
    row.command === input.command &&
    row.reason === input.reason &&
    row.requested_by === input.requestedBy
  );
}

function parsePlatformOperatorResult(
  row: PlatformOperatorRequestRow,
): Result<CodeModePlatformAdmissionState, CodeModePlatformGovernorError> {
  const requestId = parseRequestId(row.request_id);
  if (
    !requestId.ok ||
    !isPositiveInteger(row.resulting_generation) ||
    !isNonNegativeInteger(row.applied_at)
  ) {
    return { ok: false, error: { code: "code_mode_platform_state_invalid" } };
  }
  if (row.resulting_state === "open") {
    return {
      ok: true,
      value: {
        state: "open",
        generation: row.resulting_generation,
        updatedAt: row.applied_at,
        requestId: requestId.value,
      },
    };
  }
  if (row.resulting_state === "frozen") {
    return {
      ok: true,
      value: {
        state: "frozen",
        generation: row.resulting_generation,
        updatedAt: row.applied_at,
        requestId: requestId.value,
        reason: row.reason,
      },
    };
  }
  return { ok: false, error: { code: "code_mode_platform_state_invalid" } };
}

function invalidPlatformInput(
  field: string,
): Result<never, CodeModePlatformGovernorError> {
  return {
    ok: false,
    error: { code: "invalid_code_mode_budget_input", field },
  };
}

function isStableOperatorField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 200 &&
    value.trim() === value
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

function reservePlatformBudget(
  sql: SqlStorage,
  input: CodeModeOrganisationReserveInput,
): Result<CodeModePlatformReservation, CodeModePlatformGovernorError> {
  expirePlatformReservations(sql, input.now);
  const control = sql
    .exec<{ enabled: number; remote_enabled: number }>(
      `SELECT enabled, remote_enabled FROM code_mode_platform_control WHERE singleton = 1`,
    )
    .toArray()[0];
  if (control?.enabled !== 1) {
    return { ok: false, error: { code: "code_mode_platform_disabled" } };
  }
  if (control.remote_enabled !== 1) {
    return {
      ok: false,
      error: { code: "code_mode_remote_placement_disabled" },
    };
  }
  const existing = readPlatformRow(sql, input.executionId);
  if (existing !== undefined) {
    return platformRowMatches(existing, input)
      ? parsePlatformRow(existing)
      : { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  const turnReservation = sql
    .exec<{ execution_id: string }>(
      `SELECT execution_id FROM code_mode_platform_reservation
     WHERE organisation_id = ? AND session_id = ? AND turn_id = ?`,
      input.organisationId,
      input.sessionId,
      input.turnId,
    )
    .toArray()[0];
  if (turnReservation !== undefined) {
    return { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  if (countPlatformLive(sql) >= MAX_CONCURRENT_EXECUTIONS) {
    return {
      ok: false,
      error: { code: "code_mode_platform_concurrency_exceeded" },
    };
  }
  const period = platformPeriod(input.now);
  if (
    platformCost(sql, "utc_day", period.day) + input.reservedCostMicros >
    DAILY_COST_LIMIT_MICROS
  ) {
    return {
      ok: false,
      error: { code: "code_mode_platform_daily_budget_exceeded" },
    };
  }
  if (
    platformCost(sql, "utc_month", period.month) + input.reservedCostMicros >
    MONTHLY_COST_LIMIT_MICROS
  ) {
    return {
      ok: false,
      error: { code: "code_mode_platform_monthly_budget_exceeded" },
    };
  }
  const burnBucket = Math.floor(input.now / BURN_WINDOW_MS);
  if (
    platformBurn(sql, burnBucket) + input.reservedCostMicros >
    BURN_WINDOW_LIMIT_MICROS
  ) {
    return {
      ok: false,
      error: { code: "code_mode_platform_burn_rate_exceeded" },
    };
  }
  sql.exec(
    `INSERT INTO code_mode_platform_reservation (
      organisation_id, session_id, turn_id, runtime_generation, execution_id,
      admission_digest, idempotency_key, lease_id, state, utc_day, utc_month,
      burn_bucket, reserved_cost_micros, execution_deadline_at, lease_expires_at,
      reserved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?)`,
    input.organisationId,
    input.sessionId,
    input.turnId,
    input.runtimeGeneration,
    input.executionId,
    input.admissionDigest,
    input.idempotencyKey,
    input.leaseId,
    period.day,
    period.month,
    burnBucket,
    input.reservedCostMicros,
    input.executionDeadlineAt,
    input.leaseExpiresAt,
    input.now,
  );
  return parsePlatformRow(requirePlatformRow(sql, input.executionId));
}

function reservePlatformWorkspaceAllocation(
  sql: SqlStorage,
  input: WorkspaceExecutorAllocationReserveInput,
): Result<
  WorkspaceExecutorAllocationReservation,
  CodeModePlatformGovernorError
> {
  expirePlatformReservations(sql, input.now);
  const control = sql
    .exec<{ enabled: number }>(
      `SELECT enabled FROM code_mode_platform_workspace_control WHERE singleton = 1`,
    )
    .toArray()[0];
  if (control?.enabled !== 1) {
    return { ok: false, error: { code: "code_mode_platform_disabled" } };
  }
  const parent = validatePlatformWorkspaceParent(sql, input);
  if (!parent.ok) return parent;
  const existing = readPlatformWorkspaceAllocation(sql, input.allocationId);
  if (existing !== undefined) {
    return platformWorkspaceAllocationMatches(existing, input)
      ? parsePlatformWorkspaceAllocation(existing)
      : { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  if (
    readPlatformWorkspaceAllocationForParent(sql, input.parent) !== undefined
  ) {
    return {
      ok: false,
      error: { code: "code_mode_workspace_allocation_limit_exceeded" },
    };
  }
  if (
    countPlatformWorkspaceAllocations(sql) >=
    MAX_CONCURRENT_WORKSPACE_ALLOCATIONS
  ) {
    return {
      ok: false,
      error: { code: "code_mode_workspace_platform_concurrency_exceeded" },
    };
  }
  const period = platformPeriod(input.now);
  if (input.parent.kind === "attachment_preparation") {
    if (
      platformCost(sql, "utc_day", period.day) + input.reservedCostMicros >
      DAILY_COST_LIMIT_MICROS
    ) {
      return {
        ok: false,
        error: { code: "code_mode_platform_daily_budget_exceeded" },
      };
    }
    if (
      platformCost(sql, "utc_month", period.month) + input.reservedCostMicros >
      MONTHLY_COST_LIMIT_MICROS
    ) {
      return {
        ok: false,
        error: { code: "code_mode_platform_monthly_budget_exceeded" },
      };
    }
    const burnBucket = Math.floor(input.now / BURN_WINDOW_MS);
    if (
      platformBurn(sql, burnBucket) + input.reservedCostMicros >
      BURN_WINDOW_LIMIT_MICROS
    ) {
      return {
        ok: false,
        error: { code: "code_mode_platform_burn_rate_exceeded" },
      };
    }
  }
  const burnBucket = Math.floor(input.now / BURN_WINDOW_MS);
  sql.exec(
    `INSERT INTO code_mode_platform_workspace_allocation (
      organisation_id, parent_kind, parent_id, parent_lease_id, session_id, turn_id,
      runtime_generation, allocation_id, idempotency_key, allocation_digest, state,
      utc_day, utc_month, burn_bucket, profile_json, reserved_cost_micros,
      execution_deadline_at, lease_expires_at, reserved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.organisationId,
    input.parent.kind,
    platformWorkspaceParentId(input.parent),
    input.parent.leaseId,
    parent.value.sessionId,
    parent.value.turnId,
    parent.value.runtimeGeneration,
    input.allocationId,
    input.idempotencyKey,
    input.allocationDigest,
    period.day,
    period.month,
    burnBucket,
    JSON.stringify(input.profile),
    input.reservedCostMicros,
    input.executionDeadlineAt,
    input.leaseExpiresAt,
    input.now,
  );
  return parsePlatformWorkspaceAllocation(
    requirePlatformWorkspaceAllocation(sql, input.allocationId),
  );
}

function settlePlatformWorkspaceAllocation(
  sql: SqlStorage,
  input: WorkspaceExecutorAllocationSettleInput,
): Result<
  WorkspaceExecutorAllocationReservation,
  CodeModePlatformGovernorError
> {
  expirePlatformReservations(sql, input.now);
  const row = readPlatformWorkspaceAllocation(sql, input.allocationId);
  const fenced = validatePlatformWorkspaceAllocationFence(row, input);
  if (!fenced.ok) return fenced;
  if (fenced.value.state === "settled") {
    return platformWorkspaceSettlementMatches(fenced.value, input)
      ? parsePlatformWorkspaceAllocation(fenced.value)
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
    input.actualCostMicros > fenced.value.reserved_cost_micros ||
    input.inputBytes > WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.maxInputBytes ||
    input.outputBytes > WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.maxOutputBytes ||
    input.durationMs > WORKSPACE_EXECUTOR_ALLOCATION_PROFILE.maxDurationMs
  ) {
    return { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  sql.exec(
    `UPDATE code_mode_platform_workspace_allocation
     SET state = 'settled', lease_expires_at = NULL, receipt_id = ?,
         receipt_digest = ?, actual_cost_micros = ?, input_bytes = ?,
         output_bytes = ?, duration_ms = ?, outcome = ?, terminal_at = ?,
         terminal_reason = NULL
     WHERE allocation_id = ? AND state = 'reserved'`,
    input.receiptId,
    input.receiptDigest,
    input.actualCostMicros,
    input.inputBytes,
    input.outputBytes,
    input.durationMs,
    input.outcome,
    input.now,
    input.allocationId,
  );
  return parsePlatformWorkspaceAllocation(
    requirePlatformWorkspaceAllocation(sql, input.allocationId),
  );
}

function cancelPlatformWorkspaceAllocation(
  sql: SqlStorage,
  input: WorkspaceExecutorAllocationCancelInput,
): Result<
  WorkspaceExecutorAllocationReservation,
  CodeModePlatformGovernorError
> {
  expirePlatformReservations(sql, input.now);
  const row = readPlatformWorkspaceAllocation(sql, input.allocationId);
  const fenced = validatePlatformWorkspaceAllocationFence(row, input);
  if (!fenced.ok) return fenced;
  if (
    fenced.value.state === "cancelled" &&
    fenced.value.terminal_reason === input.reason
  ) {
    return parsePlatformWorkspaceAllocation(fenced.value);
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
    `UPDATE code_mode_platform_workspace_allocation
     SET state = 'cancelled', lease_expires_at = NULL, terminal_at = ?,
         terminal_reason = ?
     WHERE allocation_id = ? AND state = 'reserved'`,
    input.now,
    input.reason,
    input.allocationId,
  );
  return parsePlatformWorkspaceAllocation(
    requirePlatformWorkspaceAllocation(sql, input.allocationId),
  );
}

function settlePlatformBudget(
  sql: SqlStorage,
  input: CodeModeOrganisationSettleInput,
): Result<CodeModePlatformReservation, CodeModePlatformGovernorError> {
  expirePlatformReservations(sql, input.now);
  const row = readPlatformRow(sql, input.executionId);
  const fenced = validatePlatformFence(
    row,
    input.organisationId,
    input.leaseId,
  );
  if (!fenced.ok) return fenced;
  if (row?.state === "settled") {
    return row.receipt_id === input.receiptId &&
      row.receipt_digest === input.receiptDigest &&
      row.actual_cost_micros === input.actualCostMicros &&
      row.outcome === input.outcome
      ? parsePlatformRow(row)
      : { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  if (row?.state !== "reserved") {
    return {
      ok: false,
      error: {
        code: "code_mode_reservation_invalid_transition",
        state: row?.state ?? "missing",
      },
    };
  }
  if (input.actualCostMicros > row.reserved_cost_micros) {
    return {
      ok: false,
      error: {
        code: "code_mode_cost_exceeds_reservation",
        reservedCostMicros: row.reserved_cost_micros,
      },
    };
  }
  sql.exec(
    `UPDATE code_mode_platform_reservation
     SET state = 'settled', lease_expires_at = NULL, receipt_id = ?, receipt_digest = ?,
         actual_cost_micros = ?, outcome = ?, terminal_at = ?
     WHERE execution_id = ? AND state = 'reserved'`,
    input.receiptId,
    input.receiptDigest,
    input.actualCostMicros,
    input.outcome,
    input.now,
    input.executionId,
  );
  return parsePlatformRow(requirePlatformRow(sql, input.executionId));
}

function cancelPlatformBudget(
  sql: SqlStorage,
  input: CodeModeOrganisationCancelInput,
): Result<CodeModePlatformReservation, CodeModePlatformGovernorError> {
  expirePlatformReservations(sql, input.now);
  const row = readPlatformRow(sql, input.executionId);
  const fenced = validatePlatformFence(
    row,
    input.organisationId,
    input.leaseId,
  );
  if (!fenced.ok) return fenced;
  if (row?.state === "cancelled" && row.terminal_reason === input.reason) {
    return parsePlatformRow(row);
  }
  if (row?.state !== "reserved") {
    return {
      ok: false,
      error: {
        code: "code_mode_reservation_invalid_transition",
        state: row?.state ?? "missing",
      },
    };
  }
  sql.exec(
    `UPDATE code_mode_platform_reservation
     SET state = 'cancelled', lease_expires_at = NULL, terminal_at = ?, terminal_reason = ?
     WHERE execution_id = ? AND state = 'reserved'`,
    input.now,
    input.reason,
    input.executionId,
  );
  return parsePlatformRow(requirePlatformRow(sql, input.executionId));
}

function rebindPlatformLease(
  sql: SqlStorage,
  input: CodeModeLeaseRebindInput,
): Result<CodeModePlatformReservation, CodeModePlatformGovernorError> {
  expirePlatformReservations(sql, input.now);
  // The freeze comes first. A rebind that this Actor already applied must not
  // tell a Session Actor to resume its VM while admission is frozen.
  const control = sql
    .exec<{ enabled: number; remote_enabled: number }>(
      `SELECT enabled, remote_enabled FROM code_mode_platform_control WHERE singleton = 1`,
    )
    .toArray()[0];
  if (control?.enabled !== 1) {
    return { ok: false, error: { code: "code_mode_platform_disabled" } };
  }
  if (control.remote_enabled !== 1) {
    return {
      ok: false,
      error: { code: "code_mode_remote_placement_disabled" },
    };
  }
  const row = readPlatformRow(sql, input.executionId);
  if (row === undefined || row.organisation_id !== input.organisationId) {
    return { ok: false, error: { code: "code_mode_reservation_not_found" } };
  }
  if (row.admission_digest !== input.admissionDigest) {
    return { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  const decision = decideCodeModeLeaseRebind(
    { leaseId: row.lease_id, runtimeGeneration: row.runtime_generation },
    input,
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
      `UPDATE code_mode_platform_reservation
       SET lease_id = ?, runtime_generation = ?
       WHERE execution_id = ? AND state = 'reserved' AND lease_id = ?`,
      input.next.leaseId,
      input.next.runtimeGeneration,
      input.executionId,
      input.previous.leaseId,
    );
  }
  return parsePlatformRow(requirePlatformRow(sql, input.executionId));
}

function reconcilePlatformBudget(
  sql: SqlStorage,
  input: CodeModeOrganisationReconcileInput,
): Result<CodeModePlatformReservation, CodeModePlatformGovernorError> {
  const row = readPlatformRow(sql, input.executionId);
  if (row === undefined || row.organisation_id !== input.organisationId) {
    return { ok: false, error: { code: "code_mode_reservation_not_found" } };
  }
  if (row.state === "reconciled") {
    return row.receipt_id === input.receiptId &&
      row.provider_cost_micros === input.providerCostMicros
      ? parsePlatformRow(row)
      : { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  if (row.state !== "settled" || row.receipt_id !== input.receiptId) {
    return {
      ok: false,
      error: {
        code: "code_mode_reservation_invalid_transition",
        state: row.state,
      },
    };
  }
  sql.exec(
    `UPDATE code_mode_platform_reservation
     SET state = 'reconciled', provider_cost_micros = ?, reconciled_at = ?
     WHERE execution_id = ? AND state = 'settled'`,
    input.providerCostMicros,
    input.now,
    input.executionId,
  );
  return parsePlatformRow(requirePlatformRow(sql, input.executionId));
}

function validatePlatformFence(
  row: PlatformRow | undefined,
  organisationId: string,
  leaseId: string,
): Result<PlatformRow, CodeModePlatformGovernorError> {
  if (row === undefined || row.organisation_id !== organisationId) {
    return { ok: false, error: { code: "code_mode_reservation_not_found" } };
  }
  return row.lease_id === leaseId
    ? { ok: true, value: row }
    : { ok: false, error: { code: "code_mode_reservation_lease_conflict" } };
}

function expirePlatformReservations(sql: SqlStorage, now: number): void {
  sql.exec(
    `UPDATE code_mode_platform_workspace_allocation
     SET state = 'expired', lease_expires_at = NULL, terminal_at = ?,
         terminal_reason = 'lease_expired'
     WHERE state = 'reserved' AND lease_expires_at <= ?`,
    now,
    now,
  );
  sql.exec(
    `UPDATE code_mode_platform_reservation
     SET state = 'expired', lease_expires_at = NULL, terminal_at = ?, terminal_reason = 'lease_expired'
     WHERE state = 'reserved' AND lease_expires_at <= ?`,
    now,
    now,
  );
}

async function schedulePlatformAlarm(
  storage: DurableObjectStorage,
  sql: SqlStorage,
): Promise<void> {
  const next = sql
    .exec<{ next_at: number | null }>(
      `SELECT MIN(next_at) AS next_at FROM (
       SELECT MIN(lease_expires_at) AS next_at
       FROM code_mode_platform_reservation WHERE state = 'reserved'
       UNION ALL
       SELECT MIN(lease_expires_at) AS next_at
       FROM code_mode_platform_workspace_allocation WHERE state = 'reserved'
     )`,
    )
    .toArray()[0]?.next_at;
  if (typeof next === "number" && Number.isSafeInteger(next)) {
    await storage.setAlarm(next);
    return;
  }
  await storage.deleteAlarm();
}

function countPlatformLive(sql: SqlStorage): number {
  return (
    sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM code_mode_platform_reservation WHERE state = 'reserved'`,
      )
      .toArray()[0]?.count ?? 0
  );
}

function countPlatformWorkspaceAllocations(sql: SqlStorage): number {
  return (
    sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
     FROM code_mode_platform_workspace_allocation WHERE state = 'reserved'`,
      )
      .toArray()[0]?.count ?? 0
  );
}

function platformCost(
  sql: SqlStorage,
  column: "utc_day" | "utc_month",
  period: string,
): number {
  return (
    sql
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
     ) AS total FROM (
       SELECT 'root' AS source, state, terminal_reason, reserved_cost_micros,
              actual_cost_micros
       FROM code_mode_platform_reservation WHERE ${column} = ?
       UNION ALL
       SELECT 'preparation' AS source, state, terminal_reason, reserved_cost_micros,
              actual_cost_micros
       FROM code_mode_platform_workspace_allocation
       WHERE parent_kind = 'attachment_preparation' AND ${column} = ?
     )`,
        period,
        period,
      )
      .toArray()[0]?.total ?? 0
  );
}

function platformBurn(sql: SqlStorage, burnBucket: number): number {
  return (
    sql
      .exec<{ total: number | null }>(
        `SELECT SUM(reserved_cost_micros) AS total FROM (
       SELECT reserved_cost_micros
       FROM code_mode_platform_reservation WHERE burn_bucket = ?
       UNION ALL
       SELECT reserved_cost_micros
       FROM code_mode_platform_workspace_allocation
       WHERE parent_kind = 'attachment_preparation' AND burn_bucket = ?
     )`,
        burnBucket,
        burnBucket,
      )
      .toArray()[0]?.total ?? 0
  );
}

function platformPeriod(now: number): {
  readonly day: string;
  readonly month: string;
} {
  const day = new Date(now).toISOString().slice(0, 10);
  return { day, month: day.slice(0, 7) };
}

function readPlatformRow(
  sql: SqlStorage,
  executionId: string,
): PlatformRow | undefined {
  return sql
    .exec<PlatformRow>(
      `SELECT * FROM code_mode_platform_reservation WHERE execution_id = ?`,
      executionId,
    )
    .toArray()[0];
}

function readPlatformWorkspaceAllocation(
  sql: SqlStorage,
  allocationId: string,
): PlatformWorkspaceAllocationRow | undefined {
  return sql
    .exec<PlatformWorkspaceAllocationRow>(
      `SELECT * FROM code_mode_platform_workspace_allocation WHERE allocation_id = ?`,
      allocationId,
    )
    .toArray()[0];
}

type PlatformWorkspaceParentContext = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runtimeGeneration: number;
};

function validatePlatformWorkspaceParent(
  sql: SqlStorage,
  input: WorkspaceExecutorAllocationReserveInput,
): Result<PlatformWorkspaceParentContext, CodeModePlatformGovernorError> {
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
      const parent = readPlatformRow(sql, input.parent.executionId);
      const fenced = validatePlatformFence(
        parent,
        input.organisationId,
        input.parent.leaseId,
      );
      if (!fenced.ok) return { ok: false, error: fenced.error };
      if (
        fenced.value.state !== "reserved" ||
        input.now >= fenced.value.execution_deadline_at ||
        input.executionDeadlineAt > fenced.value.execution_deadline_at ||
        input.leaseExpiresAt > (fenced.value.lease_expires_at ?? 0) ||
        fenced.value.reserved_cost_micros <
          CODE_MODE_ENGINE_RESERVED_COST_MICROS +
            WORKSPACE_EXECUTOR_RESERVED_COST_MICROS
      ) {
        return { ok: false, error: { code: "code_mode_reservation_conflict" } };
      }
      return {
        ok: true,
        value: {
          sessionId: fenced.value.session_id,
          turnId: fenced.value.turn_id,
          runtimeGeneration: fenced.value.runtime_generation,
        },
      };
    }
  }
}

function platformWorkspaceParentId(
  parent: WorkspaceExecutorAllocationParent,
): string {
  switch (parent.kind) {
    case "code_mode_execution":
      return parent.executionId;
    case "attachment_preparation":
      return parent.preparationId;
  }
}

function readPlatformWorkspaceAllocationForParent(
  sql: SqlStorage,
  parent: WorkspaceExecutorAllocationParent,
): PlatformWorkspaceAllocationRow | undefined {
  return sql
    .exec<PlatformWorkspaceAllocationRow>(
      `SELECT * FROM code_mode_platform_workspace_allocation
     WHERE parent_kind = ? AND parent_id = ?`,
      parent.kind,
      platformWorkspaceParentId(parent),
    )
    .toArray()[0];
}

function requirePlatformWorkspaceAllocation(
  sql: SqlStorage,
  allocationId: string,
): PlatformWorkspaceAllocationRow {
  const row = readPlatformWorkspaceAllocation(sql, allocationId);
  if (row === undefined)
    throw new Error("platform_workspace_allocation_write_lost");
  return row;
}

function validatePlatformWorkspaceAllocationFence(
  row: PlatformWorkspaceAllocationRow | undefined,
  input: Pick<
    WorkspaceExecutorAllocationSettleInput,
    "organisationId" | "parent" | "allocationId"
  >,
): Result<PlatformWorkspaceAllocationRow, CodeModePlatformGovernorError> {
  if (
    row === undefined ||
    row.organisation_id !== input.organisationId ||
    row.parent_kind !== input.parent.kind ||
    row.parent_id !== platformWorkspaceParentId(input.parent) ||
    row.allocation_id !== input.allocationId
  ) {
    return { ok: false, error: { code: "code_mode_reservation_not_found" } };
  }
  return row.parent_lease_id === input.parent.leaseId &&
    platformWorkspaceRunIdentityMatches(row, input.parent)
    ? { ok: true, value: row }
    : row.parent_lease_id === input.parent.leaseId
      ? { ok: false, error: { code: "code_mode_reservation_conflict" } }
      : { ok: false, error: { code: "code_mode_reservation_lease_conflict" } };
}

function platformWorkspaceRunIdentityMatches(
  row: PlatformWorkspaceAllocationRow,
  parent: WorkspaceExecutorAllocationParent,
): boolean {
  return (
    parent.kind !== "attachment_preparation" ||
    (row.session_id === parent.sessionId &&
      row.turn_id === parent.turnId &&
      row.runtime_generation === parent.runtimeGeneration)
  );
}

function requirePlatformRow(sql: SqlStorage, executionId: string): PlatformRow {
  const row = readPlatformRow(sql, executionId);
  if (row === undefined)
    throw new Error("code_mode_platform_reservation_write_lost");
  return row;
}

function platformRowMatches(
  row: PlatformRow,
  input: CodeModeOrganisationReserveInput,
): boolean {
  return (
    row.organisation_id === input.organisationId &&
    row.session_id === input.sessionId &&
    row.turn_id === input.turnId &&
    row.runtime_generation === input.runtimeGeneration &&
    row.execution_id === input.executionId &&
    row.admission_digest === input.admissionDigest &&
    row.idempotency_key === input.idempotencyKey &&
    row.lease_id === input.leaseId &&
    row.reserved_cost_micros === input.reservedCostMicros &&
    row.execution_deadline_at === input.executionDeadlineAt &&
    row.lease_expires_at === input.leaseExpiresAt
  );
}

function platformWorkspaceAllocationMatches(
  row: PlatformWorkspaceAllocationRow,
  input: WorkspaceExecutorAllocationReserveInput,
): boolean {
  return (
    row.organisation_id === input.organisationId &&
    row.parent_kind === input.parent.kind &&
    row.parent_id === platformWorkspaceParentId(input.parent) &&
    row.parent_lease_id === input.parent.leaseId &&
    platformWorkspaceRunIdentityMatches(row, input.parent) &&
    row.allocation_id === input.allocationId &&
    row.idempotency_key === input.idempotencyKey &&
    row.allocation_digest === input.allocationDigest &&
    row.profile_json === JSON.stringify(input.profile) &&
    row.reserved_cost_micros === input.reservedCostMicros &&
    row.execution_deadline_at === input.executionDeadlineAt &&
    (row.state === "reserved"
      ? row.lease_expires_at === input.leaseExpiresAt
      : row.lease_expires_at === null)
  );
}

function platformWorkspaceSettlementMatches(
  row: PlatformWorkspaceAllocationRow,
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

function parsePlatformRow(
  row: PlatformRow,
): Result<CodeModePlatformReservation, CodeModePlatformGovernorError> {
  const identity: PlatformReservationIdentity = {
    organisationId: row.organisation_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    runtimeGeneration: row.runtime_generation,
    executionId: row.execution_id,
    admissionDigest: row.admission_digest,
    leaseId: row.lease_id,
  };
  if (row.state === "reserved" && row.lease_expires_at !== null) {
    return {
      ok: true,
      value: {
        ...identity,
        kind: "reserved",
        reservedCostMicros: row.reserved_cost_micros,
        executionDeadlineAt: row.execution_deadline_at,
        leaseExpiresAt: row.lease_expires_at,
      },
    };
  }
  if (
    (row.state === "settled" || row.state === "reconciled") &&
    row.receipt_id !== null &&
    row.receipt_digest !== null &&
    row.actual_cost_micros !== null &&
    row.terminal_at !== null &&
    isPlatformOutcome(row.outcome)
  ) {
    if (row.state === "settled") {
      return {
        ok: true,
        value: {
          ...identity,
          kind: "settled",
          receiptId: row.receipt_id,
          receiptDigest: row.receipt_digest,
          actualCostMicros: row.actual_cost_micros,
          outcome: row.outcome,
          settledAt: row.terminal_at,
        },
      };
    }
    if (row.provider_cost_micros !== null && row.reconciled_at !== null) {
      return {
        ok: true,
        value: {
          ...identity,
          kind: "reconciled",
          receiptId: row.receipt_id,
          receiptDigest: row.receipt_digest,
          actualCostMicros: row.actual_cost_micros,
          providerCostMicros: row.provider_cost_micros,
          outcome: row.outcome,
          settledAt: row.terminal_at,
          reconciledAt: row.reconciled_at,
        },
      };
    }
  }
  if (
    row.state === "cancelled" &&
    row.terminal_at !== null &&
    (row.terminal_reason === "admission_compensated" ||
      row.terminal_reason === "turn_cancelled")
  ) {
    return {
      ok: true,
      value: {
        ...identity,
        kind: "cancelled",
        reason: row.terminal_reason,
        cancelledAt: row.terminal_at,
      },
    };
  }
  if (row.state === "expired" && row.terminal_at !== null) {
    return {
      ok: true,
      value: { ...identity, kind: "expired", expiredAt: row.terminal_at },
    };
  }
  return { ok: false, error: { code: "code_mode_reservation_conflict" } };
}

function parsePlatformWorkspaceAllocation(
  row: PlatformWorkspaceAllocationRow,
): Result<
  WorkspaceExecutorAllocationReservation,
  CodeModePlatformGovernorError
> {
  const organisationId = parseOrganisationId(row.organisation_id);
  const parent = parsePlatformWorkspaceParentRow(row);
  if (
    !organisationId.ok ||
    !parent.ok ||
    !validWorkspaceAllocationId(row.allocation_id) ||
    !validOpaqueId(row.idempotency_key) ||
    !SHA256_PATTERN.test(row.allocation_digest)
  ) {
    return { ok: false, error: { code: "code_mode_reservation_conflict" } };
  }
  const identity = {
    organisationId: organisationId.value,
    parent: parent.value,
    allocationId: row.allocation_id,
    idempotencyKey: row.idempotency_key,
    allocationDigest: row.allocation_digest,
  };
  if (
    row.state === "reserved" &&
    row.lease_expires_at !== null &&
    row.profile_json ===
      JSON.stringify(WORKSPACE_EXECUTOR_ALLOCATION_PROFILE) &&
    row.reserved_cost_micros === WORKSPACE_EXECUTOR_RESERVED_COST_MICROS
  ) {
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
  }
  if (
    row.state === "settled" &&
    row.receipt_id !== null &&
    row.receipt_digest !== null &&
    row.actual_cost_micros !== null &&
    row.input_bytes !== null &&
    row.output_bytes !== null &&
    row.duration_ms !== null &&
    row.terminal_at !== null &&
    isPlatformOutcome(row.outcome) &&
    row.reserved_cost_micros === WORKSPACE_EXECUTOR_RESERVED_COST_MICROS
  ) {
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
        outcome: row.outcome,
        settledAt: row.terminal_at,
      },
    };
  }
  if (
    row.state === "cancelled" &&
    row.terminal_at !== null &&
    (row.terminal_reason === "admission_compensated" ||
      row.terminal_reason === "turn_cancelled")
  ) {
    return {
      ok: true,
      value: {
        ...identity,
        kind: "cancelled",
        reason: row.terminal_reason,
        cancelledAt: row.terminal_at,
      },
    };
  }
  if (row.state === "expired" && row.terminal_at !== null) {
    return {
      ok: true,
      value: { ...identity, kind: "expired", expiredAt: row.terminal_at },
    };
  }
  return { ok: false, error: { code: "code_mode_reservation_conflict" } };
}

function parsePlatformWorkspaceParentRow(
  row: PlatformWorkspaceAllocationRow,
): Result<WorkspaceExecutorAllocationParent, CodeModePlatformGovernorError> {
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

function isPlatformOutcome(
  value: string | null,
): value is CodeModeOrganisationSettleInput["outcome"] {
  return (
    value === "succeeded" ||
    value === "platform_failed" ||
    value === "organisation_failed"
  );
}
