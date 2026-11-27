import { expect, it } from "vitest";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { createTypeSafeConnectionSchema } from "@purin-labs/agent/typesafe/connection";
import {
  invalidateTypeSafeEvaluations,
  replayTypeSafeEvaluation,
  reserveTypeSafeEvaluation,
  settleTypeSafeEvaluation,
  type TypeSafeEvaluationKey,
  type TypeSafeUsageAuthority,
} from "@purin-labs/agent/typesafe/evaluation-ledger";
import {
  createTypeSafeUsageSchema,
  readDailyTypeSafeUsage,
  type TypeSafePurpose,
} from "@purin-labs/agent/typesafe/usage-store";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

const NOW = 1_789_000_000_000;
it(
  "binds replay to the original disclosure decision without another charge",
  pinsDisclosureDecision,
);

function pinsDisclosureDecision(): void {
  const f = fixture();
  const evaluation = key(
    f,
    "case_context_discovery_relationship",
    "disclosure_pin",
  );
  const current = authority(1, 1);
  expect(reserve(f, evaluation, current).ok).toBe(true);
  expect(
    reserveTypeSafeEvaluation(
      f.sql,
      {
        ...evaluation,
        policyRevision: 1,
        inputBytes: 100,
        reservedInputTokens: 100,
        disclosureDecisionDigest: "e".repeat(64),
        now: NOW,
      },
      current,
    ),
  ).toEqual({ ok: false, error: { code: "command_conflict" } });
  expect(
    readDailyTypeSafeUsage(f.sql, f.organisationId, evaluation.purpose, NOW)
      .evaluations,
  ).toBe(1);
  f.sqlite.database.close();
}

it(
  "rejects inconsistent stored receipt state at the persistence boundary",
  rejectsCorruptReceipt,
);
it(
  "fences the original connection independently of the current policy snapshot",
  pinsConnection,
);
it(
  "distinguishes observed zero tokens from unavailable usage and never recounts replay",
  distinguishesUnknownUsage,
);
it(
  "holds concurrency across invalidation and midnight, releasing it on expiry or settlement",
  boundsConcurrency,
);
it(
  "charges late token overruns once and preserves token admission limits across publication",
  boundsInputTokens,
);

function boundsInputTokens(): void {
  const f = fixture();
  const evaluation = key(
    f,
    "case_context_discovery_relationship",
    "token-overrun",
  );
  const original = authority(1, 1);
  expect(reserve(f, evaluation, authority(1, 1, 2, 99))).toEqual({
    ok: false,
    error: { code: "budget_exhausted" },
  });
  expect(reserve(f, evaluation, original).ok).toBe(true);
  invalidateTypeSafeEvaluations(f.sql, f.organisationId, evaluation.purpose, 1);
  const current = authority(2, 1);
  const result = settleTypeSafeEvaluation(
    f.sql,
    evaluation,
    current,
    {
      ok: true,
      value: { inputTokens: 150, outputTokens: 10, estimatedCostMicrousd: 20 },
    },
    NOW + 1,
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      kind: "settled",
      receipt: { kind: "stale" },
      budget: "exceeded",
    },
  });
  expect(settle(f, evaluation, current, 20)).toMatchObject({
    ok: true,
    value: { kind: "replayed" },
  });
  expect(
    readDailyTypeSafeUsage(f.sql, f.organisationId, evaluation.purpose, NOW),
  ).toMatchObject({
    evaluations: 1,
    observedInputTokens: 150,
    chargedInputTokens: 150,
  });
  expect(reserve(f, key(f, evaluation.purpose, "next"), current)).toEqual({
    ok: false,
    error: { code: "budget_exhausted" },
  });
  f.sqlite.database.close();
}

function fixture() {
  const sqlite = emptySqliteFixture();
  const sql = sqlStorage(sqlite.storage);
  const organisation = parseOrganisationId("organisation_typesafe_ledger");
  if (!organisation.ok) throw new Error("invalid fixture organisation");
  createTypeSafeUsageSchema(sql);
  createTypeSafeConnectionSchema(sql);
  sql.exec(
    `INSERT INTO typesafe_connection (organisation_id, revision, provider, vault_handle, tested_at, updated_by)
    VALUES (?, 1, 'typesafe', ?, ?, 'fixture')`,
    organisation.value,
    `vault:${organisation.value}:typesafe:fixture`,
    NOW,
  );
  return { sqlite, sql, organisationId: organisation.value };
}

type Fixture = ReturnType<typeof fixture>;

function authority(
  revision: number,
  connectionRevision: number,
  maxConcurrentEvaluations = 2,
  maxInputTokens = 200,
): TypeSafeUsageAuthority {
  return {
    kind: "active",
    revision,
    funding: { kind: "organisation_byo", connectionRevision },
    limits: {
      maxEvaluations: 2,
      maxConcurrentEvaluations,
      maxInputBytes: 1_000,
      maxInputTokens,
      maxWallMs: 2_000,
      maxCostMicrousd: 200,
      reservationMicrousd: 100,
      requestTimeoutMs: 1_000,
    },
  };
}

function key(
  f: Fixture,
  purpose: TypeSafePurpose,
  evaluationId: string,
): TypeSafeEvaluationKey {
  return {
    organisationId: f.organisationId,
    purpose,
    evaluationId,
    requestDigest: "a".repeat(64),
  };
}

function reserve(
  f: Fixture,
  evaluation: TypeSafeEvaluationKey,
  current: TypeSafeUsageAuthority,
  now = NOW,
) {
  return f.sqlite.storage.transactionSync(
    reserveTypeSafeEvaluation.bind(
      null,
      f.sql,
      {
        organisationId: evaluation.organisationId,
        purpose: evaluation.purpose,
        evaluationId: evaluation.evaluationId,
        requestDigest: evaluation.requestDigest,
        policyRevision: current.revision,
        inputBytes: 100,
        disclosureDecisionDigest: "d".repeat(64),
        reservedInputTokens: 100,
        now,
      },
      current,
    ),
  );
}

function settle(
  f: Fixture,
  evaluation: TypeSafeEvaluationKey,
  current: TypeSafeUsageAuthority,
  estimatedCostMicrousd: number,
  now = NOW + 1,
) {
  return f.sqlite.storage.transactionSync(
    settleTypeSafeEvaluation.bind(
      null,
      f.sql,
      evaluation,
      current,
      {
        ok: true,
        value: { estimatedCostMicrousd, inputTokens: 50, outputTokens: 10 },
      },
      now,
    ),
  );
}

function replay(
  f: Fixture,
  evaluation: TypeSafeEvaluationKey,
  current: TypeSafeUsageAuthority,
) {
  return f.sqlite.storage.transactionSync(
    replayTypeSafeEvaluation.bind(null, f.sql, evaluation, current, NOW + 2),
  );
}

function rejectsCorruptReceipt(): void {
  const f = fixture();
  const evaluation = key(f, "case_context_discovery_relationship", "invalid");
  const current = authority(1, 1);
  expect(reserve(f, evaluation, current).ok).toBe(true);
  f.sql.exec("UPDATE typesafe_evaluation SET state = 'evaluated'");
  expect(replay.bind(null, f, evaluation, current)).toThrow(
    "typesafe_receipt_corrupt",
  );
  f.sqlite.database.close();
}

function pinsConnection(): void {
  const f = fixture();
  const evaluation = key(
    f,
    "case_context_discovery_relationship",
    "connection-pin",
  );
  expect(reserve(f, evaluation, authority(1, 1)).ok).toBe(true);
  f.sql.exec("UPDATE typesafe_connection SET revision = 2");
  // Even a caller carrying the same feature revision cannot rebind the old attempt.
  const rebound = authority(1, 2);
  expect(replay(f, evaluation, rebound)).toMatchObject({
    ok: true,
    value: { kind: "stale" },
  });
  expect(settle(f, evaluation, rebound, 30)).toMatchObject({
    ok: true,
    value: {
      kind: "settled",
      receipt: { kind: "stale" },
      dependencyState: "stale",
    },
  });
  expect(
    f.sql
      .exec(
        "SELECT connection_revision, estimated_cost_microusd FROM typesafe_evaluation",
      )
      .toArray(),
  ).toEqual([{ connection_revision: 1, estimated_cost_microusd: 30 }]);
  f.sqlite.database.close();
}

function distinguishesUnknownUsage(): void {
  const f = fixture();
  const current = authority(1, 1);
  const measured = key(f, "case_context_discovery_relationship", "measured");
  const missing = key(f, measured.purpose, "missing");
  expect(reserve(f, measured, current).ok).toBe(true);
  expect(reserve(f, missing, current).ok).toBe(true);
  expect(
    f.sqlite.storage.transactionSync(
      settleTypeSafeEvaluation.bind(
        null,
        f.sql,
        measured,
        current,
        {
          ok: true,
          value: { inputTokens: 0, outputTokens: 0, estimatedCostMicrousd: 0 },
        },
        NOW + 1,
      ),
    ),
  ).toMatchObject({
    ok: true,
    value: { kind: "settled" },
  });
  expect(
    f.sqlite.storage.transactionSync(
      settleTypeSafeEvaluation.bind(
        null,
        f.sql,
        missing,
        current,
        { ok: false, error: { code: "jev_unavailable" } },
        NOW + 1,
      ),
    ),
  ).toMatchObject({
    ok: true,
    value: { kind: "settled", receipt: { kind: "failed" } },
  });
  expect(settle(f, measured, current, 50)).toMatchObject({
    ok: true,
    value: { kind: "replayed" },
  });
  expect(
    readDailyTypeSafeUsage(f.sql, f.organisationId, measured.purpose, NOW),
  ).toEqual({
    evaluations: 2,
    bytes: 200,
    wall: 2_000,
    cost: 200,
    observedInputTokens: 0,
    observedOutputTokens: 0,
    unmeasuredEvaluations: 1,
    chargedInputTokens: 200,
  });
  f.sqlite.database.close();
}

function boundsConcurrency(): void {
  const f = fixture();
  const dayMs = 24 * 60 * 60 * 1_000;
  const beforeMidnight = Math.floor(NOW / dayMs) * dayMs + dayMs - 10;
  const original = authority(1, 1, 1);
  const current = authority(2, 1, 1);
  const first = key(f, "case_context_discovery_relationship", "in-flight");
  const next = key(f, first.purpose, "next");
  expect(reserve(f, first, original, beforeMidnight)).toMatchObject({
    ok: true,
    value: { kind: "claimed" },
  });
  expect(reserve(f, next, original, beforeMidnight + 1)).toEqual({
    ok: false,
    error: { code: "budget_exhausted" },
  });
  f.sqlite.storage.transactionSync(
    invalidateTypeSafeEvaluations.bind(
      null,
      f.sql,
      f.organisationId,
      first.purpose,
      1,
    ),
  );
  expect(reserve(f, first, current, beforeMidnight + 20)).toMatchObject({
    ok: true,
    value: { kind: "replayed", receipt: { kind: "stale" } },
  });
  expect(reserve(f, next, current, beforeMidnight + 20)).toEqual({
    ok: false,
    error: { code: "budget_exhausted" },
  });
  expect(reserve(f, next, current, beforeMidnight + 1_000)).toMatchObject({
    ok: true,
    value: { kind: "claimed" },
  });
  expect(settle(f, next, current, 20, beforeMidnight + 1_001).ok).toBe(true);
  expect(
    reserve(
      f,
      key(f, first.purpose, "after-settlement"),
      current,
      beforeMidnight + 1_002,
    ),
  ).toMatchObject({ ok: true, value: { kind: "claimed" } });
  expect(
    readDailyTypeSafeUsage(
      f.sql,
      f.organisationId,
      first.purpose,
      beforeMidnight,
    ),
  ).toMatchObject({ evaluations: 1, cost: 100 });
  expect(
    readDailyTypeSafeUsage(
      f.sql,
      f.organisationId,
      first.purpose,
      beforeMidnight + 1_002,
    ),
  ).toMatchObject({ evaluations: 2, cost: 200 });
  f.sqlite.database.close();
}
