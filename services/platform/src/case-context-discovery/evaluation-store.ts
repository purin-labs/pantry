import type { OrganisationId } from "../ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { isOrganisationExecutionActive } from "../actors/actor-execution-quiescence";
import { queueAllCaseContextCollectionInvalidations } from "./relationships";
import type { Result } from "../result";
import type { SchemaTransaction } from "../actors/schema-migrations";
import { assertRequiredColumns } from "../actors/schema-migrations";
import { createTypeSafeUsageSchema } from "../integrations/typesafe/usage-store";
import type { TypeSafeAuthority } from "../integrations/typesafe/authority";
import {
  caseContextDiscoveryRoute,
  caseContextDiscoveryRouteAuthority,
  integerIn,
  parseCaseContextDiscoveryPolicy,
  type CaseContextDiscoveryPolicy,
} from "./policy";
import {
  CASE_CONTEXT_DISCOVERY_INPUT_TOKEN_RESERVATION,
  type JevEvaluation,
} from "./jev";
import type { JevError } from "../integrations/typesafe/system-one-client";
import {
  invalidateTypeSafeEvaluations,
  replayTypeSafeEvaluation,
  reserveTypeSafeEvaluation,
  settleTypeSafeEvaluation,
  type TypeSafeEvaluationKey,
  type TypeSafeEvaluationReceipt,
  type TypeSafeUsageAuthority,
  type TypeSafeUsageError,
  type TypeSafeUsageMeasurement,
} from "../integrations/typesafe/evaluation-ledger";
import { assertNever } from "@seams/std";

export type CaseContextDiscoveryEvaluationDispatch =
  Readonly<{ kind: "unissued" }> | Readonly<{ kind: "issued" }>;

export async function fetchCaseContextDiscoveryEvaluation(
  input: Readonly<{
    sql: SqlStorage;
    scope: OrganisationExecutionScope;
    fetcher: typeof fetch;
  }>,
  dispatch: { state: CaseContextDiscoveryEvaluationDispatch },
  request: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<Response> {
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    throw new Error("organisation_placement_conflict");
  dispatch.state = { kind: "issued" };
  // The runtime's fetch throws "Illegal invocation" when it is called as a
  // property of another object, so the call does not go through `input`.
  const fetcher = input.fetcher;
  return fetcher(request, init);
}

export function releaseUnissuedCaseContextDiscoveryEvaluation(
  input: Readonly<{
    sql: SqlStorage;
    scope: OrganisationExecutionScope;
    evaluationId: string;
    requestDigest: string;
    dispatch: Extract<
      CaseContextDiscoveryEvaluationDispatch,
      { kind: "unissued" }
    >;
  }>,
): void {
  // The caller owns this reservation and its guarded transport never issued it.
  input.sql.exec(
    `DELETE FROM typesafe_evaluation WHERE organisation_id = ?
       AND purpose = 'case_context_discovery_relationship' AND evaluation_id = ?
       AND request_digest = ? AND state IN ('reserved', 'stale')
       AND settlement_state = 'pending'`,
    input.scope.organisationId,
    input.evaluationId,
    input.requestDigest,
  );
}

export type CaseContextDiscoveryPolicyHead = Readonly<{
  revision: number;
  policy: CaseContextDiscoveryPolicy;
}>;

export type CaseContextCollectionStoreError = Readonly<{
  code:
    | "case_context_collection_revision_conflict"
    | "case_context_collection_command_conflict"
    | "case_context_collection_inactive"
    | "case_context_discovery_budget_exhausted"
    | "case_context_discovery_allowance_reached"
    | "case_context_discovery_spending_limit_reached"
    | "case_context_discovery_paid_use_unfunded"
    | "case_context_discovery_rate_limited"
    | "case_context_collection_store_invalid";
}>;

type HeadRow = { revision: number; policy: string };

export function createCaseContextDiscoveryEvaluationSchema(
  sql: SqlStorage,
): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS case_context_discovery_policy (
    organisation_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    policy TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS case_context_discovery_policy_command (
    organisation_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (organisation_id, command_id)
  )`);
  createTypeSafeUsageSchema(sql);
  assertRequiredColumns(sql, "case_context_discovery_policy", [
    "organisation_id",
    "revision",
    "policy",
    "updated_by",
    "updated_at",
  ]);
}

export function readCaseContextDiscoveryPolicy(
  sql: SqlStorage,
  organisationId: OrganisationId,
): CaseContextDiscoveryPolicyHead {
  const row = sql
    .exec<HeadRow>(
      "SELECT revision, policy FROM case_context_discovery_policy WHERE organisation_id = ?",
      organisationId,
    )
    .toArray()[0];
  if (row === undefined) return { revision: 0, policy: { mode: "disabled" } };
  const parsed = parseCaseContextDiscoveryPolicy(JSON.parse(row.policy));
  if (!parsed.ok || !integerIn(row.revision, 1, Number.MAX_SAFE_INTEGER)) {
    throw new Error("case_context_discovery_policy_corrupt");
  }
  return { revision: row.revision, policy: parsed.value };
}

export function publishCaseContextDiscoveryPolicy(input: {
  readonly sql: SqlStorage;
  readonly transaction: SchemaTransaction;
  readonly organisationId: OrganisationId;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly expectedRevision: number;
  readonly policy: CaseContextDiscoveryPolicy;
  readonly actorId: string;
  readonly now: number;
}): Result<{ revision: number }, CaseContextCollectionStoreError> {
  return input.transaction(publishPolicyTransaction.bind(null, input));
}

function publishPolicyTransaction(
  input: Parameters<typeof publishCaseContextDiscoveryPolicy>[0],
): Result<{ revision: number }, CaseContextCollectionStoreError> {
  const previous = input.sql
    .exec<{ request_digest: string; revision: number }>(
      `SELECT request_digest, revision FROM case_context_discovery_policy_command WHERE organisation_id = ? AND command_id = ?`,
      input.organisationId,
      input.commandId,
    )
    .toArray()[0];
  if (previous !== undefined) {
    return previous.request_digest === input.requestDigest
      ? { ok: true, value: { revision: previous.revision } }
      : failure("case_context_collection_command_conflict");
  }
  const current = readCaseContextDiscoveryPolicy(
    input.sql,
    input.organisationId,
  );
  if (current.revision !== input.expectedRevision)
    return failure("case_context_collection_revision_conflict");
  const revision = current.revision + 1;
  input.sql.exec(
    `INSERT INTO case_context_discovery_policy (organisation_id, revision, policy, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (organisation_id) DO UPDATE SET revision = excluded.revision,
    policy = excluded.policy, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    input.organisationId,
    revision,
    JSON.stringify(input.policy),
    input.actorId,
    input.now,
  );
  input.sql.exec(
    `INSERT INTO case_context_discovery_policy_command (organisation_id, command_id, request_digest, revision)
    VALUES (?, ?, ?, ?)`,
    input.organisationId,
    input.commandId,
    input.requestDigest,
    revision,
  );
  invalidateTypeSafeEvaluations(
    input.sql,
    input.organisationId,
    "case_context_discovery_relationship",
    current.revision,
  );
  queueAllCaseContextCollectionInvalidations(input.sql, input.organisationId);
  return { ok: true, value: { revision } };
}

type CaseContextDiscoveryEvaluationKey = Readonly<{
  organisationId: OrganisationId;
  evaluationId: string;
  requestDigest: string;
  now: number;
}>;

type CaseContextDiscoveryReservation = CaseContextDiscoveryEvaluationKey &
  Readonly<{
    policyRevision: number;
    inputBytes: number;
    disclosureDecisionDigest: string;
  }>;

export function reserveCaseContextDiscoveryEvaluation(
  sql: SqlStorage,
  transaction: SchemaTransaction,
  input: CaseContextDiscoveryReservation,
): Result<
  Readonly<{
    kind: "claimed" | "replayed";
    receipt: TypeSafeEvaluationReceipt;
  }>,
  CaseContextCollectionStoreError
> {
  return transaction(reserveTransaction.bind(null, sql, input));
}

function reserveTransaction(
  sql: SqlStorage,
  input: CaseContextDiscoveryReservation,
) {
  return caseContextCollectionStoreResult(
    reserveTypeSafeEvaluation(
      sql,
      {
        organisationId: input.organisationId,
        purpose: "case_context_discovery_relationship",
        evaluationId: input.evaluationId,
        requestDigest: input.requestDigest,
        policyRevision: input.policyRevision,
        inputBytes: input.inputBytes,
        reservedInputTokens: CASE_CONTEXT_DISCOVERY_INPUT_TOKEN_RESERVATION,
        disclosureDecisionDigest: input.disclosureDecisionDigest,
        now: input.now,
      },
      usageAuthority(readCaseContextDiscoveryPolicy(sql, input.organisationId)),
    ),
  );
}

export function replayCaseContextDiscoveryEvaluation(
  sql: SqlStorage,
  transaction: SchemaTransaction,
  input: CaseContextDiscoveryEvaluationKey,
): Result<TypeSafeEvaluationReceipt | null, CaseContextCollectionStoreError> {
  return transaction(replayEvaluation.bind(null, sql, input));
}

function replayEvaluation(
  sql: SqlStorage,
  input: CaseContextDiscoveryEvaluationKey,
) {
  return caseContextCollectionStoreResult(
    replayTypeSafeEvaluation(
      sql,
      usageKey(input),
      usageAuthority(readCaseContextDiscoveryPolicy(sql, input.organisationId)),
      input.now,
    ),
  );
}

export function settleCaseContextDiscoveryEvaluation(input: {
  readonly sql: SqlStorage;
  readonly transaction: SchemaTransaction;
  readonly organisationId: OrganisationId;
  readonly evaluationId: string;
  readonly requestDigest: string;
  readonly result: Result<JevEvaluation, JevError>;
  readonly now: number;
}): Result<TypeSafeEvaluationReceipt, CaseContextCollectionStoreError> {
  return input.transaction(settleTransaction.bind(null, input));
}

function settleTransaction(
  input: Parameters<typeof settleCaseContextDiscoveryEvaluation>[0],
): Result<TypeSafeEvaluationReceipt, CaseContextCollectionStoreError> {
  const head = readCaseContextDiscoveryPolicy(input.sql, input.organisationId);
  const authority = usageAuthority(head);
  const measured: Result<TypeSafeUsageMeasurement, JevError> = input.result.ok
    ? {
        ok: true,
        value: {
          inputTokens: input.result.value.usage.inputTokens,
          outputTokens: input.result.value.usage.outputTokens,
          estimatedCostMicrousd: Math.ceil(
            input.result.value.usage.costUsd * 1_000_000,
          ),
        },
      }
    : input.result;
  const result = caseContextCollectionStoreResult(
    settleTypeSafeEvaluation(
      input.sql,
      usageKey(input),
      authority,
      measured,
      input.now,
    ),
  );
  if (!result.ok) return result;
  const settlement = result.value;
  if (
    settlement.kind === "settled" &&
    head.policy.mode !== "disabled" &&
    (settlement.budget === "exceeded" ||
      (settlement.dependencyState === "current" &&
        (settlement.providerFailure === "jev_credential_rejected" ||
          settlement.providerFailure === "jev_budget_exhausted")))
  ) {
    disableCaseContextDiscoveryPolicy(
      input.sql,
      input.organisationId,
      head.revision,
      input.now,
    );
  }
  return { ok: true, value: settlement.receipt };
}

/** Withdrawal advances the fence even if the operator later republishes identical config. */
export function disableCaseContextDiscoveryPolicy(
  sql: SqlStorage,
  organisationId: OrganisationId,
  expectedRevision: number,
  now: number,
): void {
  sql.exec(
    "UPDATE case_context_discovery_policy SET revision = revision + 1, policy = ?, updated_by = 'system:case-context-collection-safety-stop', updated_at = ? WHERE organisation_id = ? AND revision = ?",
    JSON.stringify({ mode: "disabled" }),
    now,
    organisationId,
    expectedRevision,
  );
  queueAllCaseContextCollectionInvalidations(sql, organisationId);
  invalidateTypeSafeEvaluations(
    sql,
    organisationId,
    "case_context_discovery_relationship",
    expectedRevision,
  );
}

/**
 * Moves an enabled policy to a new TypeSafe authority when the Organisation
 * connects or removes its own key. The new revision fences the evaluations in
 * flight; the switch stays on (Plan 88 section 1).
 */
export function repinCaseContextDiscoveryPolicy(
  sql: SqlStorage,
  organisationId: OrganisationId,
  expectedRevision: number,
  authority: TypeSafeAuthority,
  now: number,
): void {
  const head = readCaseContextDiscoveryPolicy(sql, organisationId);
  if (head.revision !== expectedRevision || head.policy.mode === "disabled")
    return;
  sql.exec(
    "UPDATE case_context_discovery_policy SET revision = revision + 1, policy = ?, updated_by = 'system:typesafe-authority-change', updated_at = ? WHERE organisation_id = ? AND revision = ?",
    JSON.stringify({
      ...head.policy,
      route: caseContextDiscoveryRoute(authority),
    }),
    now,
    organisationId,
    expectedRevision,
  );
  invalidateTypeSafeEvaluations(
    sql,
    organisationId,
    "case_context_discovery_relationship",
    expectedRevision,
  );
}

function usageAuthority(
  head: CaseContextDiscoveryPolicyHead,
): TypeSafeUsageAuthority {
  if (head.policy.mode === "disabled") {
    return { kind: "inactive", revision: head.revision };
  }
  return {
    kind: "active",
    revision: head.revision,
    funding: caseContextDiscoveryRouteAuthority(head.policy.route),
    limits: head.policy.limits,
  };
}

function usageKey(
  input: CaseContextDiscoveryEvaluationKey,
): TypeSafeEvaluationKey {
  return {
    organisationId: input.organisationId,
    purpose: "case_context_discovery_relationship",
    evaluationId: input.evaluationId,
    requestDigest: input.requestDigest,
  };
}

function caseContextCollectionStoreResult<Value>(
  result: Result<Value, TypeSafeUsageError>,
): Result<Value, CaseContextCollectionStoreError> {
  if (result.ok) return result;
  switch (result.error.code) {
    case "revision_conflict":
      return failure("case_context_collection_revision_conflict");
    case "command_conflict":
      return failure("case_context_collection_command_conflict");
    case "inactive":
      return failure("case_context_collection_inactive");
    case "budget_exhausted":
      return failure("case_context_discovery_budget_exhausted");
    case "allowance_reached":
      return failure("case_context_discovery_allowance_reached");
    case "spending_limit_reached":
      return failure("case_context_discovery_spending_limit_reached");
    case "paid_use_unfunded":
      return failure("case_context_discovery_paid_use_unfunded");
    case "rate_limited":
      return failure("case_context_discovery_rate_limited");
    case "store_invalid":
      return failure("case_context_collection_store_invalid");
    default:
      return assertNever(result.error.code);
  }
}

function failure(
  code: CaseContextCollectionStoreError["code"],
): Result<never, CaseContextCollectionStoreError> {
  return { ok: false, error: { code } };
}
