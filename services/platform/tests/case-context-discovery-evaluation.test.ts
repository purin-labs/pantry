import { describe, expect, it, vi } from "vitest";

import {
  createCaseContextDiscoveryEvaluationSchema,
  publishCaseContextDiscoveryPolicy,
  readCaseContextDiscoveryPolicy,
  reserveCaseContextDiscoveryEvaluation,
  settleCaseContextDiscoveryEvaluation,
} from "../src/case-context-discovery/evaluation-store";
import { evaluateSyntheticCaseContextDiscovery } from "../src/case-context-discovery/synthetic-evaluation";
import { CASE_CONTEXT_DISCOVERY_JEV_MODEL } from "../src/case-context-discovery/jev";
import {
  parseCaseContextDiscoveryPolicy,
  type CaseContextDiscoveryPolicy,
} from "../src/case-context-discovery/policy";
import { parseOrganisationId } from "../src/ids";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { createTypeSafeConnectionSchema } from "../src/integrations/typesafe/connection";
import { createMigratedDatabase } from "./sqlite-d1";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";

const NOW = 1_789_000_000_000;
const KEY = "apikey_synthetic-test-key-never-a-real-credential";
const DIGEST = "a".repeat(64);

describe("Organisation-owned CaseContextCollection evaluations", suite);

function suite(): void {
  it(
    "retains the current policy after an unbound historical credential failure",
    ignoresUnboundCredentialFailure,
  );
  it(
    "settles stale billing exactly once and preserves the daily limit",
    settlesStaleBilling,
  );
  it(
    "replays saved receipts after credential withdrawal without another request",
    replaysAfterWithdrawal,
  );
  it(
    "isolates CaseContextCollection replay, settlement, budget and invalidation from other purposes",
    isolatesPurposes,
  );
  it(
    "preserves the daily aggregate budget across configuration publications",
    publicationCannotResetBudget,
  );
  it(
    "settles expired reservations without repeating an uncertain request",
    expiresReservation,
  );
  it(
    "stops future evaluations when estimated cost exceeds the reservation",
    stopsCostOverrun,
  );
  it(
    "disables the policy when observed tokens exceed the reservation",
    stopsTokenOverrun,
  );
  it(
    "defaults to inactive and reserves nothing without configuration",
    disabledByDefault,
  );
  it(
    "runs one bounded synthetic evaluation and replays its durable receipt",
    evaluatesOnce,
  );
  it(
    "withdraws missing credentials and requires a fresh publication",
    withdrawsCredentials,
  );
  it(
    "reserves before I/O and preserves consumed budget after restart",
    budgetsBeforeIo,
  );
  it(
    "fences an in-flight evaluation when the operator disables discovery",
    fencesInFlight,
  );
  it(
    "rejects a changed payload under a stable command identity",
    rejectsCommandCollision,
  );
  it(
    "atomically rolls back policy publication and pending-work invalidation",
    publicationIsAtomic,
  );
  it(
    "does not refund ambiguous provider failures or retain their bodies",
    failureConsumesReservation,
  );
  it(
    "disables the route after a provider credential rejection",
    rejectedCredentialDisables,
  );
  it(
    "permits an explicitly configured Gmail source in shadow mode",
    evaluatesConfiguredGmail,
  );
  it(
    "rejects reply-context activation at the evaluation boundary",
    replyContextRemainsBlocked,
  );
}

async function ignoresUnboundCredentialFailure(): Promise<void> {
  const f = await fixture();
  publish(f);
  const input = {
    organisationId: f.organisationId,
    evaluationId: "unbound-history",
    requestDigest: DIGEST,
    policyRevision: 1,
    inputBytes: 100,
    disclosureDecisionDigest: "d".repeat(64),
    now: NOW,
  };
  expect(
    reserveCaseContextDiscoveryEvaluation(f.sql, f.transaction, input).ok,
  ).toBe(true);
  f.sql.exec(
    "UPDATE typesafe_evaluation SET funding = NULL, connection_revision = NULL, state = 'stale'",
  );
  expect(
    settleCaseContextDiscoveryEvaluation({
      sql: f.sql,
      transaction: f.transaction,
      organisationId: f.organisationId,
      evaluationId: input.evaluationId,
      requestDigest: input.requestDigest,
      now: NOW + 1,
      result: { ok: false, error: { code: "jev_credential_rejected" } },
    }),
  ).toMatchObject({ ok: true, value: { kind: "stale" } });
  expect(readCaseContextDiscoveryPolicy(f.sql, f.organisationId)).toEqual({
    revision: 1,
    policy: f.policy,
  });
  f.sqlite.database.close();
}

async function fixture(maxEvaluations = 2, reservationMicrousd = 10_000) {
  const sqlite = emptySqliteFixture();
  const organisation = parseOrganisationId(
    "organisation_case_context_collection_test",
  );
  if (!organisation.ok) throw new Error("fixture invalid");
  const sql = sqlStorage(sqlite.storage);
  const db = createMigratedDatabase();
  await db
    .prepare(
      "INSERT INTO organisation (organisation_id, name, created_at) VALUES (?, 'CaseContextCollection', 1)",
    )
    .bind(organisation.value)
    .run();
  const placement = await ensureInitialOrganisationPlacement({
    db,
    organisationId: organisation.value,
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  if (!placement.ok) throw new Error(placement.error.code);
  const scope = await requireOrganisationExecutionScope(
    {
      DB: db,
      SATYR_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    organisation.value,
  );
  sql.exec(
    "CREATE TABLE state_object_policy_export_barrier (singleton INTEGER PRIMARY KEY)",
  );
  const transaction = sqlite.storage.transactionSync.bind(sqlite.storage);
  createCaseContextDiscoveryEvaluationSchema(sql);
  createTypeSafeConnectionSchema(sql);
  sql.exec(
    `INSERT INTO typesafe_connection (organisation_id, revision, provider, vault_handle, tested_at, updated_by)
    VALUES (?, 1, 'typesafe', ?, ?, 'fixture')`,
    organisation.value,
    `vault:${organisation.value}:typesafe:fixture`,
    NOW,
  );
  const policy = parseCaseContextDiscoveryPolicy({
    mode: "shadow",
    route: {
      provider: "typesafe",
      connectionRevision: 1,
      funding: "organisation_byo",
      credentialRef: "organisation_typesafe",
    },
    sources: [{ source: "commerce", integrationAccountId: "account-1" }],
    limits: {
      maxEvaluations,
      maxConcurrentEvaluations: maxEvaluations,
      maxInputBytes: 100_000,
      maxInputTokens: maxEvaluations * 65_536,
      maxWallMs: 40_000,
      maxCostMicrousd: 40_000,
      reservationMicrousd,
      requestTimeoutMs: 10_000,
    },
  });
  if (!policy.ok) throw new Error("fixture policy invalid");
  return {
    sql,
    transaction,
    sqlite,
    organisationId: organisation.value,
    scope,
    policy: policy.value,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function publish(
  f: Fixture,
  policy: CaseContextDiscoveryPolicy = f.policy,
  expectedRevision = 0,
  commandId = "configure-1",
) {
  return publishCaseContextDiscoveryPolicy({
    sql: f.sql,
    transaction: f.transaction,
    organisationId: f.organisationId,
    commandId,
    requestDigest: `${DIGEST}${commandId}`,
    expectedRevision,
    policy,
    actorId: "control-admin",
    now: NOW,
  });
}

function evaluate(
  f: Fixture,
  fetcher: typeof fetch,
  evaluationId = "eval-1",
  expectedRevision = 1,
  credential:
    | import("../src/integrations/typesafe/credential").TypeSafeCredential
    | null = {
    provider: "typesafe",
    apiKey: KEY,
    authority: { kind: "organisation_byo", connectionRevision: 1 },
  },
) {
  return evaluateSyntheticCaseContextDiscovery({
    sql: f.sql,
    transaction: f.transaction,
    credential,
    scope: f.scope,
    evaluationId,
    expectedRevision,
    source: "commerce",
    integrationAccountId: "account-1",
    signal: new AbortController().signal,
    fetcher,
    now: now,
  });
}

function now(): number {
  return NOW;
}

function response(inputTokens = 800): Response {
  return Response.json({
    model: CASE_CONTEXT_DISCOVERY_JEV_MODEL,
    answers: {
      candidate_0: { type: "choice", choice: "same_issue", confidence: 1 },
      candidate_1: {
        type: "choice",
        choice: "related_reference",
        confidence: 0.7,
      },
      candidate_2: {
        type: "choice",
        choice: "different_issue",
        confidence: 0.8,
      },
    },
    usage: { input_tokens: inputTokens, output_tokens: 150 },
  });
}

async function disabledByDefault(): Promise<void> {
  const f = await fixture();
  const fetcher = vi.fn<typeof fetch>();
  expect(readCaseContextDiscoveryPolicy(f.sql, f.organisationId)).toEqual({
    revision: 0,
    policy: { mode: "disabled" },
  });
  expect(await evaluate(f, fetcher, "eval-1", 0)).toEqual({
    ok: false,
    error: { code: "case_context_collection_inactive" },
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(evaluationCount(f)).toBe(0);
}

async function evaluatesOnce(): Promise<void> {
  const f = await fixture();
  expect(publish(f).ok).toBe(true);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
  const first = await evaluate(f, fetcher);
  expect(first).toMatchObject({
    ok: true,
    value: {
      receipt: { kind: "evaluated" },
      evaluation: {
        decisions: [
          { candidateId: "same-delivery", outcome: "same_issue" },
          { candidateId: "different-issue", outcome: "related_reference" },
          { candidateId: "different-instance", outcome: "different_issue" },
        ],
      },
    },
  });
  const replay = await evaluate(f, fetcher);
  expect(replay).toMatchObject({
    ok: true,
    value: { receipt: { kind: "evaluated" }, evaluation: null },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(evaluationCount(f)).toBe(1);
  const request = String(fetcher.mock.calls[0]?.[1]?.body);
  expect(request).toContain("Synthetic supplier");
  expect(request).not.toContain(f.organisationId);
  expect(request).not.toContain(KEY);
  const persisted = f.sqlite.database
    .prepare("SELECT * FROM typesafe_evaluation")
    .all();
  expect(JSON.stringify(persisted)).not.toContain("Synthetic supplier");
  expect(JSON.stringify(persisted)).not.toContain(KEY);
  f.sqlite.database.close();
}

async function withdrawsCredentials(): Promise<void> {
  const f = await fixture();
  publish(f);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
  expect(await evaluate(f, fetcher, "eval-1", 1, null)).toEqual({
    ok: false,
    error: { code: "case_context_collection_inactive" },
  });
  expect(readCaseContextDiscoveryPolicy(f.sql, f.organisationId)).toEqual({
    revision: 2,
    policy: { mode: "disabled" },
  });
  expect(await evaluate(f, fetcher, "eval-1", 2)).toEqual({
    ok: false,
    error: { code: "case_context_collection_inactive" },
  });
  expect(fetcher).not.toHaveBeenCalled();
}

async function budgetsBeforeIo(): Promise<void> {
  const f = await fixture(1);
  publish(f);
  const reserved = reserveCaseContextDiscoveryEvaluation(f.sql, f.transaction, {
    organisationId: f.organisationId,
    evaluationId: "crashed-call",
    requestDigest: DIGEST,
    policyRevision: 1,
    inputBytes: 24_576,
    disclosureDecisionDigest: "d".repeat(64),
    now: NOW,
  });
  expect(reserved).toMatchObject({ ok: true, value: { kind: "claimed" } });
  // Reopening the schema models an Actor wake; the reservation remains authoritative.
  createCaseContextDiscoveryEvaluationSchema(f.sql);
  const fetcher = vi.fn<typeof fetch>();
  expect(await evaluate(f, fetcher)).toEqual({
    ok: false,
    error: { code: "case_context_discovery_budget_exhausted" },
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(evaluationCount(f)).toBe(1);
}

async function fencesInFlight(): Promise<void> {
  const f = await fixture();
  publish(f);
  const fetcher = disableDuringFetch.bind(null, f);
  expect(await evaluate(f, fetcher)).toMatchObject({
    ok: true,
    value: { receipt: { kind: "stale" }, evaluation: null },
  });
  expect(readCaseContextDiscoveryPolicy(f.sql, f.organisationId).revision).toBe(
    2,
  );
  expect(publish(f, f.policy, 2, "re-enable")).toMatchObject({
    ok: true,
    value: { revision: 3 },
  });
  const after = vi.fn<typeof fetch>();
  expect(await evaluate(f, after, "eval-1", 3)).toEqual({
    ok: false,
    error: { code: "case_context_collection_command_conflict" },
  });
  expect(after).not.toHaveBeenCalled();
}

async function disableDuringFetch(f: Fixture): Promise<Response> {
  expect(publish(f, { mode: "disabled" }, 1, "disable").ok).toBe(true);
  return response();
}

async function rejectsCommandCollision(): Promise<void> {
  const f = await fixture();
  const first = publish(f);
  expect(publish(f)).toEqual(first);
  expect(
    publishCaseContextDiscoveryPolicy({
      sql: f.sql,
      transaction: f.transaction,
      organisationId: f.organisationId,
      commandId: "configure-1",
      requestDigest: "b".repeat(64),
      expectedRevision: 0,
      policy: { mode: "disabled" },
      actorId: "control-admin",
      now: NOW,
    }),
  ).toEqual({
    ok: false,
    error: { code: "case_context_collection_command_conflict" },
  });
  expect(readCaseContextDiscoveryPolicy(f.sql, f.organisationId).revision).toBe(
    1,
  );
}

async function publicationIsAtomic(): Promise<void> {
  const f = await fixture();
  f.sqlite.storage.failOnceWhen({
    queryIncludes: "INSERT INTO case_context_discovery_policy_command",
    bindingIndex: null,
    bindingValue: null,
  });
  expect(publish.bind(null, f)).toThrow();
  expect(readCaseContextDiscoveryPolicy(f.sql, f.organisationId)).toEqual({
    revision: 0,
    policy: { mode: "disabled" },
  });
  expect(publish(f).ok).toBe(true);
}

async function failureConsumesReservation(): Promise<void> {
  const f = await fixture(1);
  publish(f);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("private provider body"));
  expect(await evaluate(f, fetcher)).toMatchObject({
    ok: true,
    value: {
      receipt: { kind: "failed", failureCode: "jev_unavailable" },
      evaluation: null,
    },
  });
  expect(await evaluate(f, fetcher, "eval-2")).toEqual({
    ok: false,
    error: { code: "case_context_discovery_budget_exhausted" },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    JSON.stringify(
      f.sqlite.database.prepare("SELECT * FROM typesafe_evaluation").all(),
    ),
  ).not.toContain("private provider body");
}

async function rejectedCredentialDisables(): Promise<void> {
  const f = await fixture();
  publish(f);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("invalid key", { status: 401 }));
  expect(await evaluate(f, fetcher)).toMatchObject({
    ok: true,
    value: {
      receipt: { kind: "failed", failureCode: "jev_credential_rejected" },
    },
  });
  expect(readCaseContextDiscoveryPolicy(f.sql, f.organisationId)).toEqual({
    revision: 2,
    policy: { mode: "disabled" },
  });
}

async function evaluatesConfiguredGmail(): Promise<void> {
  const f = await fixture();
  if (f.policy.mode === "disabled") throw new Error("fixture invalid");
  publish(f, {
    mode: "shadow",
    route: f.policy.route,
    limits: f.policy.limits,
    sources: [{ source: "gmail", integrationAccountId: "account-1" }],
  });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
  expect(
    await evaluateSyntheticCaseContextDiscovery({
      sql: f.sql,
      transaction: f.transaction,
      credential: { provider: "typesafe" as const, apiKey: KEY, authority: { kind: "organisation_byo" as const, connectionRevision: 1 } },
      scope: f.scope,
      evaluationId: "eval-1",
      expectedRevision: 1,
      source: "gmail",
      integrationAccountId: "account-1",
      signal: new AbortController().signal,
      fetcher,
      now,
    }),
  ).toMatchObject({ ok: true, value: { receipt: { kind: "evaluated" } } });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(evaluationCount(f)).toBe(1);
}

async function replyContextRemainsBlocked(): Promise<void> {
  const f = await fixture();
  if (f.policy.mode === "disabled") throw new Error("fixture invalid");
  publish(f, {
    mode: "party_context",
    route: f.policy.route,
    limits: f.policy.limits,
    sources: f.policy.sources,
  });
  const fetcher = vi.fn<typeof fetch>();
  expect(await evaluate(f, fetcher)).toEqual({
    ok: false,
    error: { code: "case_context_collection_inactive" },
  });
  expect(fetcher).not.toHaveBeenCalled();
}

function evaluationCount(f: Fixture): number {
  const rows = f.sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM typesafe_evaluation",
    )
    .toArray();
  return rows[0]!.count;
}

async function expiresReservation(): Promise<void> {
  const f = await fixture();
  publish(f);
  const input = {
    organisationId: f.organisationId,
    evaluationId: "crash-1",
    requestDigest: DIGEST,
    policyRevision: 1,
    inputBytes: 24_576,
    disclosureDecisionDigest: "d".repeat(64),
    now: NOW,
  };
  expect(
    reserveCaseContextDiscoveryEvaluation(f.sql, f.transaction, input),
  ).toMatchObject({
    ok: true,
    value: { kind: "claimed" },
  });
  expect(
    reserveCaseContextDiscoveryEvaluation(f.sql, f.transaction, {
      ...input,
      now: NOW + 10_000,
    }),
  ).toMatchObject({
    ok: true,
    value: { kind: "replayed", receipt: { kind: "stale" } },
  });
  expect(evaluationCount(f)).toBe(1);
}

async function stopsCostOverrun(): Promise<void> {
  const f = await fixture(2, 1);
  publish(f);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
  expect(await evaluate(f, fetcher)).toMatchObject({
    ok: true,
    value: {
      receipt: { kind: "failed", failureCode: "jev_budget_exhausted" },
      evaluation: null,
    },
  });
  expect(readCaseContextDiscoveryPolicy(f.sql, f.organisationId)).toEqual({
    revision: 2,
    policy: { mode: "disabled" },
  });
}

async function stopsTokenOverrun(): Promise<void> {
  const f = await fixture();
  publish(f);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(65_537));
  expect(await evaluate(f, fetcher)).toMatchObject({
    ok: true,
    value: {
      receipt: { kind: "failed", failureCode: "jev_budget_exhausted" },
      evaluation: null,
    },
  });
  expect(readCaseContextDiscoveryPolicy(f.sql, f.organisationId)).toEqual({
    revision: 2,
    policy: { mode: "disabled" },
  });
  f.sqlite.database.close();
}

async function publicationCannotResetBudget(): Promise<void> {
  const f = await fixture(1);
  publish(f);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
  expect((await evaluate(f, fetcher)).ok).toBe(true);
  expect(publish(f, f.policy, 1, "configure-2").ok).toBe(true);
  expect(await evaluate(f, fetcher, "eval-2", 2)).toEqual({
    ok: false,
    error: { code: "case_context_discovery_budget_exhausted" },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
}

async function settlesStaleBilling(): Promise<void> {
  const f = await fixture();
  publish(f);
  reserveCaseContextDiscoveryEvaluation(f.sql, f.transaction, {
    organisationId: f.organisationId,
    evaluationId: "late-call",
    requestDigest: DIGEST,
    policyRevision: 1,
    inputBytes: 24_576,
    disclosureDecisionDigest: "d".repeat(64),
    now: NOW,
  });
  publish(f, f.policy, 1, "reconfigure");
  const settlement: Parameters<typeof settleCaseContextDiscoveryEvaluation>[0] =
    {
      sql: f.sql,
      transaction: f.transaction,
      organisationId: f.organisationId,
      evaluationId: "late-call",
      requestDigest: DIGEST,
      now: NOW + 1,
      result: {
        ok: true,
        value: {
          model: CASE_CONTEXT_DISCOVERY_JEV_MODEL,
          questionRevision: 1,
          decisions: [
            {
              candidateId: "same-delivery",
              outcome: "same_issue",
              confidence: 1,
            },
          ],
          usage: { inputTokens: 800, outputTokens: 150, costUsd: 0.05 },
        },
      },
    };
  const first = settleCaseContextDiscoveryEvaluation(settlement);
  expect(first).toMatchObject({ ok: true, value: { kind: "stale" } });
  expect(readCaseContextDiscoveryPolicy(f.sql, f.organisationId)).toEqual({
    revision: 3,
    policy: { mode: "disabled" },
  });
  expect(publish(f, f.policy, 3, "re-enable").ok).toBe(true);
  expect(settleCaseContextDiscoveryEvaluation(settlement)).toEqual(first);
  expect(readCaseContextDiscoveryPolicy(f.sql, f.organisationId).revision).toBe(
    4,
  );
  expect(
    reserveCaseContextDiscoveryEvaluation(f.sql, f.transaction, {
      organisationId: f.organisationId,
      evaluationId: "next-call",
      requestDigest: "b".repeat(64),
      policyRevision: 4,
      inputBytes: 24_576,
      disclosureDecisionDigest: "d".repeat(64),
      now: NOW + 2,
    }),
  ).toEqual({
    ok: false,
    error: { code: "case_context_discovery_budget_exhausted" },
  });
  expect(
    f.sql
      .exec(
        "SELECT settlement_state, estimated_cost_microusd FROM typesafe_evaluation",
      )
      .toArray(),
  ).toEqual([{ settlement_state: "settled", estimated_cost_microusd: 50_000 }]);
  f.sqlite.database.close();
}

async function replaysAfterWithdrawal(): Promise<void> {
  const f = await fixture();
  publish(f);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 401 }));
  const first = await evaluate(f, fetcher);
  expect(first).toMatchObject({
    ok: true,
    value: {
      receipt: { kind: "failed", failureCode: "jev_credential_rejected" },
    },
  });
  expect(await evaluate(f, fetcher, "eval-1", 1, null)).toEqual(first);
  expect(publish(f, f.policy, 2, "re-enable").ok).toBe(true);
  expect(await evaluate(f, fetcher)).toEqual(first);
  expect(await evaluate(f, fetcher, "eval-1", 3)).toEqual({
    ok: false,
    error: { code: "case_context_collection_command_conflict" },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  f.sqlite.database.close();
}

async function isolatesPurposes(): Promise<void> {
  const f = await fixture(1);
  f.sql.exec(
    `INSERT INTO typesafe_evaluation (
    organisation_id, purpose, evaluation_id, request_digest, policy_revision, connection_revision,
    input_bytes, reserved_input_tokens, reserved_wall_ms, reserved_cost_microusd, reserved_at, expires_at, state
  ) VALUES (?, 'ecommerce_response_verification', 'eval-1', ?, 1, 1, 100000, 65536, 40000, 40000, ?, ?, 'reserved')`,
    f.organisationId,
    DIGEST,
    NOW,
    NOW + 10000,
  );
  publish(f);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
  expect(await evaluate(f, fetcher)).toMatchObject({
    ok: true,
    value: { receipt: { kind: "evaluated" } },
  });
  expect(await evaluate(f, fetcher)).toMatchObject({
    ok: true,
    value: { receipt: { kind: "evaluated" } },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(publish(f, { mode: "disabled" }, 1, "disable").ok).toBe(true);
  expect(
    f.sql
      .exec(
        `SELECT state, settlement_state, estimated_cost_microusd FROM typesafe_evaluation
    WHERE purpose = 'ecommerce_response_verification'`,
      )
      .toArray(),
  ).toEqual([
    {
      state: "reserved",
      settlement_state: "pending",
      estimated_cost_microusd: null,
    },
  ]);
  f.sqlite.database.close();
}
