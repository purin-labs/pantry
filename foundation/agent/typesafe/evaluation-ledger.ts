import type { OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
import type { Result } from "@purin-labs/kernel/result";
import {
  sameTypeSafeAuthority,
  typeSafeAuthorityFromStored,
  typeSafeAuthorityIsCurrent as pinnedAuthorityIsCurrent,
  type TypeSafeAuthority,
} from "./authority";
import type { JevError } from "./system-one-client";
import {
  readDailyTypeSafeUsage,
  readMonthlyPantryTypeSafeCost,
  readRecentPantryTypeSafeCount,
  readTypeSafeInFlightCount,
  type TypeSafePurpose,
} from "./usage-store";
import { isRecord } from "@purin-labs/std";
import { DEFAULT_PLAN_ID, organisationPlan } from "@purin-labs/tenancy/plans";

/**
 * Plan 88 D3: $1.00 of TypeSafe cost on Pantry's key each UTC month. The plan
 * catalog holds the number (Plan 95).
 */
export const JEV_MONTHLY_ALLOWANCE_MICROUSD =
  organisationPlan(DEFAULT_PLAN_ID).freeJevUseMicrousd;
/** Plan 88 D8: at most 5 Pantry-funded Jev requests a second for each Organisation. */
const JEV_REQUESTS_PER_SECOND = 5;

export type TypeSafeUsageLimits = Readonly<{
  maxEvaluations: number;
  maxConcurrentEvaluations: number;
  maxInputBytes: number;
  maxInputTokens: number;
  maxWallMs: number;
  maxCostMicrousd: number;
  reservationMicrousd: number;
  requestTimeoutMs: number;
}>;

export type TypeSafeUsageAuthority =
  | Readonly<{
      kind: "inactive";
      revision: number;
      funding?: never;
      limits?: never;
    }>
  | Readonly<{
      kind: "active";
      revision: number;
      funding: TypeSafeAuthority;
      limits: TypeSafeUsageLimits;
    }>;

export function parseTypeSafeUsageLimits(
  raw: unknown,
): TypeSafeUsageLimits | null {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 8 ||
    !integerIn(raw.maxEvaluations, 1, 1000) ||
    !integerIn(raw.maxConcurrentEvaluations, 1, raw.maxEvaluations) ||
    !integerIn(raw.maxInputBytes, 1, 24_576_000) ||
    !integerIn(raw.maxInputTokens, 1, 65_536_000) ||
    !integerIn(raw.maxWallMs, 1, 10_000_000) ||
    !integerIn(raw.maxCostMicrousd, 1, 10_000_000) ||
    !integerIn(raw.reservationMicrousd, 1, raw.maxCostMicrousd) ||
    !integerIn(raw.requestTimeoutMs, 1, 10_000) ||
    raw.requestTimeoutMs > raw.maxWallMs
  )
    return null;
  return {
    maxEvaluations: raw.maxEvaluations,
    maxConcurrentEvaluations: raw.maxConcurrentEvaluations,
    maxInputBytes: raw.maxInputBytes,
    maxInputTokens: raw.maxInputTokens,
    maxWallMs: raw.maxWallMs,
    maxCostMicrousd: raw.maxCostMicrousd,
    reservationMicrousd: raw.reservationMicrousd,
    requestTimeoutMs: raw.requestTimeoutMs,
  };
}

export type TypeSafeEvaluationReceipt = Readonly<{
  evaluationId: string;
  policyRevision: number;
}> &
  (
    | Readonly<{ kind: "reserved"; expiresAt: number; failureCode?: never }>
    | Readonly<{
        kind: "evaluated" | "stale";
        expiresAt?: never;
        failureCode?: never;
      }>
    | Readonly<{
        kind: "failed";
        failureCode: JevError["code"];
        expiresAt?: never;
      }>
  );

export type TypeSafeUsageError = Readonly<{
  code:
    | "revision_conflict"
    | "command_conflict"
    | "inactive"
    | "budget_exhausted"
    | "allowance_reached"
    | "spending_limit_reached"
    | "paid_use_unfunded"
    | "rate_limited"
    | "store_invalid";
}>;

/**
 * Paid use above the free use of the month (Plan 88 section 4, Plan 95
 * step 6). The Jev features of the integrations area give it, and the Worker
 * registers it; the ledger keeps no paid-use row. It admits one Pantry-funded
 * call that the free use does not cover, or says why the call does not run.
 * `commit` stores what the admission holds; the ledger calls it in the
 * transaction of the reservation, after its own checks pass.
 */
export type TypeSafePaidUse = (
  sql: SqlStorage,
  call: Readonly<{
    organisationId: OrganisationId;
    purpose: TypeSafePurpose;
    reservedInputTokens: number;
    now: number;
  }>,
) => Result<
  Readonly<{ commit(): void }>,
  "allowance_reached" | "spending_limit_reached" | "paid_use_unfunded"
>;

export const typeSafePaidUse = definePort<TypeSafePaidUse>("typesafe_paid_use");

export type TypeSafeEvaluationKey = Readonly<{
  organisationId: OrganisationId;
  purpose: TypeSafePurpose;
  evaluationId: string;
  requestDigest: string;
}>;

type TypeSafeReservation = TypeSafeEvaluationKey &
  Readonly<{
    policyRevision: number;
    inputBytes: number;
    reservedInputTokens: number;
    disclosureDecisionDigest: string;
    now: number;
  }>;

export type TypeSafeSettlement =
  | Readonly<{
      kind: "replayed";
      receipt: TypeSafeEvaluationReceipt;
      budget?: never;
      providerFailure?: never;
      dependencyState?: never;
    }>
  | Readonly<{
      kind: "settled";
      receipt: TypeSafeEvaluationReceipt;
      budget: "within_reservation" | "exceeded";
      providerFailure: JevError["code"] | null;
      dependencyState: "current" | "stale";
    }>;

export type TypeSafeUsageMeasurement = Readonly<{
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicrousd: number;
}>;

type StoredEvaluation = Readonly<{
  receipt: TypeSafeEvaluationReceipt;
  requestDigest: string;
  expiresAt: number;
  settlement: "pending" | "settled";
  reservedCostMicrousd: number;
  reservedInputTokens: number;
  connection: ConnectionDependency;
  disclosure: DisclosureDependency;
}>;

type DisclosureDependency =
  | Readonly<{ kind: "unavailable"; digest?: never }>
  | Readonly<{ kind: "pinned"; digest: string }>;

type ConnectionDependency =
  | Readonly<{ kind: "unavailable"; funding?: never }>
  | Readonly<{ kind: "pinned"; funding: TypeSafeAuthority }>;

/** All operations run synchronously inside the owning Actor's transaction. */
export function reserveTypeSafeEvaluation(
  sql: SqlStorage,
  input: TypeSafeReservation,
  authority: TypeSafeUsageAuthority,
): Result<
  Readonly<{
    kind: "claimed" | "replayed";
    receipt: TypeSafeEvaluationReceipt;
  }>,
  TypeSafeUsageError
> {
  if (!validReservation(input)) return failure("store_invalid");
  const stored = readEvaluation(sql, input);
  if (
    stored !== null &&
    stored.disclosure.kind === "pinned" &&
    stored.disclosure.digest !== input.disclosureDecisionDigest
  )
    return failure("command_conflict");
  const previous = replayTypeSafeEvaluation(sql, input, authority, input.now);
  if (!previous.ok) return previous;
  if (previous.value !== null) {
    return { ok: true, value: { kind: "replayed", receipt: previous.value } };
  }
  if (authority.revision !== input.policyRevision)
    return failure("revision_conflict");
  if (
    authority.kind === "inactive" ||
    !typeSafeAuthorityIsCurrent(sql, input.organisationId, authority)
  ) {
    return failure("inactive");
  }
  const limits = authority.limits;
  let paid: Readonly<{ commit(): void }> | null = null;
  if (authority.funding.kind === "pantry_platform") {
    if (
      readRecentPantryTypeSafeCount(sql, input.organisationId, input.now) >=
      JEV_REQUESTS_PER_SECOND
    )
      return failure("rate_limited");
    if (
      readMonthlyPantryTypeSafeCost(sql, input.organisationId, input.now) +
        limits.reservationMicrousd >
      JEV_MONTHLY_ALLOWANCE_MICROUSD
    ) {
      // Above the free use only paid use admits a call (Plan 88 section 4).
      const admitted = typeSafePaidUse.use()(sql, {
        organisationId: input.organisationId,
        purpose: input.purpose,
        reservedInputTokens: input.reservedInputTokens,
        now: input.now,
      });
      if (!admitted.ok) return failure(admitted.error);
      paid = admitted.value;
    }
  }
  const usage = readDailyTypeSafeUsage(
    sql,
    input.organisationId,
    input.purpose,
    input.now,
  );
  if (
    readTypeSafeInFlightCount(
      sql,
      input.organisationId,
      input.purpose,
      input.now,
    ) >= limits.maxConcurrentEvaluations ||
    usage.evaluations >= limits.maxEvaluations ||
    usage.bytes + input.inputBytes > limits.maxInputBytes ||
    usage.chargedInputTokens + input.reservedInputTokens >
      limits.maxInputTokens ||
    usage.wall + limits.requestTimeoutMs > limits.maxWallMs ||
    usage.cost + limits.reservationMicrousd > limits.maxCostMicrousd
  )
    return failure("budget_exhausted");
  if (paid !== null) paid.commit();
  const expiresAt = input.now + limits.requestTimeoutMs;
  sql.exec(
    `INSERT INTO typesafe_evaluation (
    organisation_id, purpose, evaluation_id, request_digest, policy_revision, funding, connection_revision, input_bytes, reserved_input_tokens, disclosure_decision_digest,
    reserved_wall_ms, reserved_cost_microusd, reserved_at, expires_at, state
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`,
    input.organisationId,
    input.purpose,
    input.evaluationId,
    input.requestDigest,
    authority.revision,
    authority.funding.kind,
    authority.funding.kind === "organisation_byo"
      ? authority.funding.connectionRevision
      : null,
    input.inputBytes,
    input.reservedInputTokens,
    input.disclosureDecisionDigest,
    limits.requestTimeoutMs,
    limits.reservationMicrousd,
    input.now,
    expiresAt,
  );
  return {
    ok: true,
    value: {
      kind: "claimed",
      receipt: {
        kind: "reserved",
        evaluationId: input.evaluationId,
        policyRevision: authority.revision,
        expiresAt,
      },
    },
  };
}

export function replayTypeSafeEvaluation(
  sql: SqlStorage,
  key: TypeSafeEvaluationKey,
  authority: TypeSafeUsageAuthority,
  now: number,
): Result<TypeSafeEvaluationReceipt | null, TypeSafeUsageError> {
  const row = readCurrentEvaluation(sql, key, authority, now);
  if (row === null) return { ok: true, value: null };
  if (row.requestDigest !== key.requestDigest)
    return failure("command_conflict");
  return { ok: true, value: row.receipt };
}

export function settleTypeSafeEvaluation(
  sql: SqlStorage,
  key: TypeSafeEvaluationKey,
  authority: TypeSafeUsageAuthority,
  result: Result<TypeSafeUsageMeasurement, JevError>,
  now: number,
): Result<TypeSafeSettlement, TypeSafeUsageError> {
  const row = readCurrentEvaluation(sql, key, authority, now);
  if (row === null) return failure("store_invalid");
  if (row.requestDigest !== key.requestDigest)
    return failure("command_conflict");
  if (row.settlement === "settled") {
    return { ok: true, value: { kind: "replayed", receipt: row.receipt } };
  }
  const estimatedCost = result.ok ? result.value.estimatedCostMicrousd : null;
  if (
    result.ok &&
    (!integerIn(
      result.value.estimatedCostMicrousd,
      0,
      Number.MAX_SAFE_INTEGER,
    ) ||
      !integerIn(result.value.inputTokens, 0, Number.MAX_SAFE_INTEGER) ||
      !integerIn(result.value.outputTokens, 0, Number.MAX_SAFE_INTEGER))
  ) {
    return failure("store_invalid");
  }
  const overReservation =
    (estimatedCost !== null && estimatedCost > row.reservedCostMicrousd) ||
    (result.ok && result.value.inputTokens > row.reservedInputTokens);
  const providerFailure = result.ok ? null : result.error.code;
  let failureCode = providerFailure;
  if (overReservation) failureCode = "jev_budget_exhausted";
  let state: "stale" | "evaluated" | "failed";
  if (
    row.receipt.kind === "stale" ||
    authority.revision !== row.receipt.policyRevision ||
    now >= row.expiresAt
  ) {
    state = "stale";
  } else if (failureCode !== null) {
    state = "failed";
  } else {
    state = "evaluated";
  }
  sql.exec(
    `UPDATE typesafe_evaluation SET state = ?, settlement_state = 'settled',
    failure_code = ?, estimated_cost_microusd = ?, input_tokens = ?, output_tokens = ?
    WHERE organisation_id = ? AND purpose = ? AND evaluation_id = ? AND settlement_state = 'pending'`,
    state,
    failureCode,
    estimatedCost,
    result.ok ? result.value.inputTokens : null,
    result.ok ? result.value.outputTokens : null,
    key.organisationId,
    key.purpose,
    key.evaluationId,
  );
  return {
    ok: true,
    value: {
      kind: "settled",
      receipt: settledReceipt(
        key.evaluationId,
        row.receipt.policyRevision,
        state,
        failureCode,
      ),
      budget: overReservation ? "exceeded" : "within_reservation",
      providerFailure,
      dependencyState: evaluationAuthorityIsCurrent(sql, key, authority, row)
        ? "current"
        : "stale",
    },
  };
}

/**
 * Ends a reservation that TypeSafe did not run, such as a call that it
 * refused with 429. The call counts no use, and the same evaluation can be
 * reserved again.
 */
export function releaseTypeSafeEvaluation(
  sql: SqlStorage,
  key: TypeSafeEvaluationKey,
): void {
  sql.exec(
    `DELETE FROM typesafe_evaluation
    WHERE organisation_id = ? AND purpose = ? AND evaluation_id = ? AND request_digest = ?
      AND settlement_state = 'pending'`,
    key.organisationId,
    key.purpose,
    key.evaluationId,
    key.requestDigest,
  );
}

export function invalidateTypeSafeEvaluations(
  sql: SqlStorage,
  organisationId: OrganisationId,
  purpose: TypeSafePurpose,
  throughRevision: number,
): void {
  sql.exec(
    `UPDATE typesafe_evaluation SET state = 'stale'
    WHERE organisation_id = ? AND purpose = ? AND state = 'reserved' AND policy_revision <= ?`,
    organisationId,
    purpose,
    throughRevision,
  );
}

function typeSafeAuthorityIsCurrent(
  sql: SqlStorage,
  organisationId: OrganisationId,
  authority: TypeSafeUsageAuthority,
): boolean {
  if (authority.kind === "inactive") return false;
  return pinnedAuthorityIsCurrent(sql, organisationId, authority.funding);
}

function readCurrentEvaluation(
  sql: SqlStorage,
  key: TypeSafeEvaluationKey,
  authority: TypeSafeUsageAuthority,
  now: number,
): StoredEvaluation | null {
  const row = readEvaluation(sql, key);
  if (
    row === null ||
    (row.receipt.kind !== "reserved" && row.receipt.kind !== "evaluated")
  )
    return row;
  if (
    evaluationAuthorityIsCurrent(sql, key, authority, row) &&
    (row.receipt.kind !== "reserved" || row.expiresAt > now)
  )
    return row;
  sql.exec(
    "UPDATE typesafe_evaluation SET state = 'stale' WHERE organisation_id = ? AND purpose = ? AND evaluation_id = ?",
    key.organisationId,
    key.purpose,
    key.evaluationId,
  );
  return {
    receipt: {
      kind: "stale",
      evaluationId: row.receipt.evaluationId,
      policyRevision: row.receipt.policyRevision,
    },
    requestDigest: row.requestDigest,
    expiresAt: row.expiresAt,
    settlement: row.settlement,
    reservedCostMicrousd: row.reservedCostMicrousd,
    reservedInputTokens: row.reservedInputTokens,
    connection: row.connection,
    disclosure: row.disclosure,
  };
}

function evaluationAuthorityIsCurrent(
  sql: SqlStorage,
  key: TypeSafeEvaluationKey,
  authority: TypeSafeUsageAuthority,
  row: StoredEvaluation,
): boolean {
  return (
    authority.kind === "active" &&
    row.disclosure.kind === "pinned" &&
    row.connection.kind === "pinned" &&
    sameTypeSafeAuthority(row.connection.funding, authority.funding) &&
    authority.revision === row.receipt.policyRevision &&
    typeSafeAuthorityIsCurrent(sql, key.organisationId, authority)
  );
}

function readEvaluation(
  sql: SqlStorage,
  key: TypeSafeEvaluationKey,
): StoredEvaluation | null {
  const raw = sql
    .exec<Record<string, SqlStorageValue>>(
      `SELECT evaluation_id, request_digest, policy_revision, funding, connection_revision, disclosure_decision_digest,
    expires_at, state, settlement_state, failure_code, reserved_cost_microusd, reserved_input_tokens
    FROM typesafe_evaluation WHERE organisation_id = ? AND purpose = ? AND evaluation_id = ?`,
      key.organisationId,
      key.purpose,
      key.evaluationId,
    )
    .toArray()[0];
  if (raw === undefined) return null;
  if (
    typeof raw.evaluation_id !== "string" ||
    typeof raw.request_digest !== "string" ||
    !integerIn(raw.policy_revision, 1, Number.MAX_SAFE_INTEGER) ||
    !integerIn(raw.expires_at, 0, Number.MAX_SAFE_INTEGER) ||
    !integerIn(raw.reserved_cost_microusd, 1, Number.MAX_SAFE_INTEGER) ||
    !integerIn(raw.reserved_input_tokens, 1, Number.MAX_SAFE_INTEGER) ||
    (raw.settlement_state !== "pending" && raw.settlement_state !== "settled")
  )
    throw new Error("typesafe_receipt_corrupt");
  const connection = parseConnectionDependency(
    raw.funding,
    raw.connection_revision,
  );
  if (
    raw.disclosure_decision_digest !== null &&
    (typeof raw.disclosure_decision_digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(raw.disclosure_decision_digest))
  )
    throw new Error("typesafe_receipt_corrupt");
  let receipt: TypeSafeEvaluationReceipt;
  if (raw.state === "reserved") {
    if (raw.settlement_state !== "pending" || raw.failure_code !== null)
      throw new Error("typesafe_receipt_corrupt");
    receipt = {
      kind: "reserved",
      evaluationId: raw.evaluation_id,
      policyRevision: raw.policy_revision,
      expiresAt: raw.expires_at,
    };
  } else if (
    raw.state === "evaluated" ||
    raw.state === "failed" ||
    raw.state === "stale"
  ) {
    if (raw.state !== "stale" && raw.settlement_state !== "settled")
      throw new Error("typesafe_receipt_corrupt");
    receipt = settledReceipt(
      raw.evaluation_id,
      raw.policy_revision,
      raw.state,
      parseFailureCode(raw.failure_code),
    );
  } else {
    throw new Error("typesafe_receipt_corrupt");
  }
  return {
    receipt,
    requestDigest: raw.request_digest,
    expiresAt: raw.expires_at,
    settlement: raw.settlement_state,
    reservedCostMicrousd: raw.reserved_cost_microusd,
    reservedInputTokens: raw.reserved_input_tokens,
    connection,
    disclosure:
      raw.disclosure_decision_digest === null
        ? { kind: "unavailable" }
        : { kind: "pinned", digest: raw.disclosure_decision_digest },
  };
}

function parseConnectionDependency(
  funding: unknown,
  revision: unknown,
): ConnectionDependency {
  // Rows from before Plan 88 have no funding: an unpinned row, or the Organisation's key.
  if (funding === null && revision === null) return { kind: "unavailable" };
  const pinned = typeSafeAuthorityFromStored(
    funding ?? "organisation_byo",
    revision,
  );
  if (pinned !== null) return { kind: "pinned", funding: pinned };
  throw new Error("typesafe_receipt_corrupt");
}

function settledReceipt(
  evaluationId: string,
  policyRevision: number,
  state: "evaluated" | "failed" | "stale",
  failureCode: JevError["code"] | null,
): TypeSafeEvaluationReceipt {
  if (state === "failed") {
    if (failureCode === null) throw new Error("typesafe_receipt_corrupt");
    return { kind: "failed", evaluationId, policyRevision, failureCode };
  }
  if (state === "evaluated" && failureCode !== null)
    throw new Error("typesafe_receipt_corrupt");
  return { kind: state, evaluationId, policyRevision };
}

function parseFailureCode(raw: unknown): JevError["code"] | null {
  switch (raw) {
    case null:
    case "jev_credential_unavailable":
    case "jev_credential_rejected":
    case "jev_budget_exhausted":
    case "jev_input_invalid":
    case "jev_cancelled":
    case "jev_unavailable":
    case "jev_rate_limited":
    case "jev_response_invalid":
      return raw;
    default:
      throw new Error("typesafe_receipt_corrupt");
  }
}

function validReservation(input: TypeSafeReservation): boolean {
  return (
    typeof input.evaluationId === "string" &&
    typeof input.requestDigest === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9:_.\/-]{0,199}$/.test(input.evaluationId) &&
    /^[a-f0-9]{64}$/.test(input.requestDigest) &&
    typeof input.disclosureDecisionDigest === "string" &&
    /^[a-f0-9]{64}$/.test(input.disclosureDecisionDigest) &&
    integerIn(input.policyRevision, 1, Number.MAX_SAFE_INTEGER) &&
    integerIn(input.inputBytes, 1, 24_576) &&
    integerIn(input.reservedInputTokens, 1, Number.MAX_SAFE_INTEGER) &&
    integerIn(input.now, 0, Number.MAX_SAFE_INTEGER - 10_000)
  );
}

function integerIn(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function failure(
  code: TypeSafeUsageError["code"],
): Result<never, TypeSafeUsageError> {
  return { ok: false, error: { code } };
}
