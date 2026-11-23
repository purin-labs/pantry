import { describe, expect, it } from "vitest";

import {
  createCommerceLabScenarioRun,
  parseCommerceLabIdempotencyKey,
  parseCommerceLabScenarioId,
} from "@purin-labs/area-commerce/server/commerce-lab/scenarios";

describe("commerce lab scenario catalog", function commerceLabCatalogSuite() {
  it("creates the same run and provider event identities on replay", function deterministicRun() {
    const scenarioId = requireScenarioId("happy-order");
    const idempotencyKey = requireIdempotencyKey("commerce_lab_replay_0001");
    const input = { scenarioId, idempotencyKey, startedAt: 1_000 };

    const first = createCommerceLabScenarioRun(input);
    const replay = createCommerceLabScenarioRun(input);

    expect(first).toEqual(replay);

    if (!first.ok) {
      throw new Error(first.error.code);
    }

    expect(first.value.events).toHaveLength(
      first.value.providerEventIds.length,
    );
    expect(new Set(first.value.providerEventIds).size).toBe(
      first.value.providerEventIds.length,
    );
  });
});

function requireScenarioId(raw: string) {
  const parsed = parseCommerceLabScenarioId(raw);

  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }

  return parsed.value;
}

function requireIdempotencyKey(raw: string) {
  const parsed = parseCommerceLabIdempotencyKey(raw);

  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }

  return parsed.value;
}
