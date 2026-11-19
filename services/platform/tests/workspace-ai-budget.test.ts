import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { OrganisationExecutionScope } from "../src/organisation-execution-scope";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import { parseInitialOrganisationPlacement } from "../src/placement";
import { d1Database } from "./sqlite-d1";
import { parseOrganisationId } from "../src/ids";
import {
  changeWorkspaceAiBudget,
  parseWorkspaceAiBudgetLimits,
  readWorkspaceAiBudget,
} from "../src/data/workspace-ai-budget";
import { conversationGenerationError } from "../src/chat/generation-failure";
import type { SessionBudgetDimension } from "@seams/contracts";

const baseline = singleDatabaseSchema();

it("provisions finite defaults and fences changes, recovery and organisation isolation", async function budgetLifecycle() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(baseline);
  sqlite.exec(
    "INSERT INTO organisation (organisation_id, name, created_at) VALUES ('organisation_budget', 'Budget', 1), ('organisation_other', 'Other', 1)",
  );
  const parsed = parseOrganisationId("organisation_budget");
  const other = parseOrganisationId("organisation_other");
  if (!parsed.ok || !other.ok) throw new Error("test identity");
  const db = d1Database(sqlite);
  const initial = await readWorkspaceAiBudget(db, parsed.value);
  expect(initial).toMatchObject({
    ok: true,
    value: {
      limits: { maxTokens: 64000, maxWallMs: 180000, maxToolCalls: 20 },
      revision: 1,
      activation: "active",
    },
  });
  const placement = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "budget-test",
    locationHint: "wnam",
  });
  if (!placement.ok) throw new Error(placement.error.code);
  await ensureInitialOrganisationPlacement({
    db,
    organisationId: parsed.value,
    placement: placement.value,
    environment: "development",
    now: 1,
  });
  const scope = await OrganisationExecutionScope.resolve(
    {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({ databaseBinding: "DB", kind: placement.value.kind, placementCellId: placement.value.placementCellId, locationHint: placement.value.locationHint }),
    },
    parsed.value,
  );
  if (!scope.ok) throw new Error(scope.error.code);
  const input = {
    scope: scope.value,
    limits: { maxTokens: 128000, maxWallMs: 180000, maxToolCalls: 20 },
    expectedRevision: 1,
    mutationReceiptId: "receipt_budget",
    now: 2,
  };
  const changed = await changeWorkspaceAiBudget(input);
  expect(changed).toMatchObject({
    ok: true,
    value: { revision: 2, activation: "pending", limits: input.limits },
  });
  expect(await changeWorkspaceAiBudget(input)).toEqual(changed);
  expect(
    await changeWorkspaceAiBudget({
      ...input,
      limits: { ...input.limits, maxTokens: 256000 },
    }),
  ).toEqual({ ok: false, error: "workspace_ai_budget_conflict" });
  expect(
    await changeWorkspaceAiBudget({
      ...input,
      mutationReceiptId: "receipt_other",
    }),
  ).toEqual({ ok: false, error: "workspace_ai_budget_conflict" });
  expect(await readWorkspaceAiBudget(db, other.value)).toMatchObject({
    ok: true,
    value: { revision: 1, limits: { maxTokens: 64000 } },
  });
  sqlite.close();
});

it("rejects unbounded, partial and fractional settings at the boundary", function invalidLimits() {
  const valid = { maxTokens: 64000, maxWallMs: 180000, maxToolCalls: 20 };
  expect(parseWorkspaceAiBudgetLimits(valid)).toEqual(valid);
  for (const limits of [
    null,
    {},
    { ...valid, maxTokens: 0 },
    { ...valid, maxTokens: 1000001 },
    { ...valid, maxWallMs: 600001 },
    { ...valid, maxToolCalls: 1.5 },
    { ...valid, maxTokens: Infinity },
    { ...valid, extra: 1 },
  ])
    expect(parseWorkspaceAiBudgetLimits(limits)).toBeNull();
});

it("reports each actual exhaustion dimension and its pinned limit", function exhaustionMessages() {
  const dimensions: SessionBudgetDimension[] = [
    "tokens",
    "active_wall_ms",
    "capability_calls",
  ];
  for (const dimension of dimensions) {
    const message = conversationGenerationError({
      kind: "budget_exhausted",
      code: "session_turn:budget_exhausted",
      budget: {
        budgetRevision: "budget_7",
        maxTokens: 64000,
        maxWallMs: 180000,
        maxToolCalls: 20,
      },
      exhaustion: {
        exhaustionId: "exhaustion_test",
        dimension,
        runId: "run_test",
        observedUsage: {
          tokens: 64001,
          activeWallMs: 180001,
          capabilityCalls: 21,
        },
        exhaustedAt: 100,
      },
    });
    expect(message).toContain("budget_7");
    switch (dimension) {
      case "tokens":
        expect(message).toContain("64000 allowed");
        break;
      case "active_wall_ms":
        expect(message).toContain("180 allowed");
        break;
      case "capability_calls":
        expect(message).toContain("20 allowed");
        break;
    }
  }
});
