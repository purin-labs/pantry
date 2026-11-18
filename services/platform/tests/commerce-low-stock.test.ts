import { createMigratedDatabase } from "./sqlite-d1";
import { activateActorFixture } from "./organisation-execution-fixture";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { CASE_ACTOR_SCHEMA_VERSION } from "../src/actors/actor-schema-versions";
import type { OrganisationId, CaseId } from "../src/ids";
import type { CanonicalCommerceDelivery } from "@seams/contracts";
import type {
  CommerceDeliveryV1,
  CommerceInventoryMovementV1,
  CommerceFirstPartyShipmentV1,
  CommerceTrackingEventV1,
} from "@seams/commerce-client";
import { expect, it, vi } from "vitest";

vi.mock(
  "../src/policy/information-flow/source-labels",
  async function mockSourceLabels() {
    const { FlowLabel } = await import("../src/policy/information-flow/labels");
    const { sourceReaderForAuthority } =
      await import("../src/policy/information-flow/source-readers");
    return {
      createCurrentSourceFlowLabel: async function createFixtureSourceLabel(
        input: Readonly<{
          readonly kind: string;
          readonly authority: import("@seams/contracts").RequestAuthority;
        }>,
      ) {
        if (input.kind !== "ingress") {
          return {
            ok: false as const,
            error: { code: "source_policy_invalid" as const, field: "kind" },
          };
        }
        return FlowLabel.create([
          {
            owner: {
              kind: "organisation",
              organisationId: input.authority.organisationId,
            },
            readers: [sourceReaderForAuthority(input.authority)],
          },
        ]);
      },
    };
  },
);

import { CaseDO } from "../src/actors/case";
import type { CaseSnapshot } from "../src/actors/case/types";
import {
  runDirectTwoSessionCasePath,
  type CaseWalkingSession,
  type DirectTwoSessionCasePathResult,
} from "../src/actors/case-walking-path";
import {
  applyCommerceDelivery,
  createCommerceProjectionSchema,
  readAcceptedCommerceProjectionSequence,
  readCurrentCommerceProjection,
  readRecoverableCommerceCues,
  type PendingCommerceCue,
} from "../src/actors/commerce-projection";
import {
  claimCueDelivery,
  completeClaimedCueDelivery,
  createCueDeliverySchema,
} from "../src/actors/cue-delivery";
import { normalizeCommerceEngineDelivery } from "../src/commerce/provider";
import {
  parseAssignmentId,
  parseCaseId,
  parseIntegrationAccountId,
  parseRequestId,
  parseSessionId,
  parseOrganisationId,
} from "../src/ids";
import { fixtureDirectTwoSessionContext } from "./fixtures/plan25-turn";
import { sqlStorage, emptySqliteFixture } from "./sqlite-storage";
import {
  flowBindingForContext,
  InformationFlowContext,
  type SerializedFlowBinding,
} from "../src/policy";
import { sha256Hex } from "@seams/std";
import { platformEnv } from "./worker-fakes";

const ORGANISATION_ID = parseOrganisationId(
  "organisation_underclerk_low_stock",
);
const INTEGRATION_ACCOUNT_ID = parseIntegrationAccountId(
  "integration_underclerk_low_stock",
);
const ACCEPT_ALL_COMMERCE_DELIVERIES = { verify: acceptCommerceDelivery };

it("emits one exact low-stock cue when a StockPolicy threshold is crossed", async () => {
  if (!ORGANISATION_ID.ok || !INTEGRATION_ACCOUNT_ID.ok)
    throw new Error("invalid low-stock fixture identity");
  const sqlite = emptySqliteFixture();
  const sql = sqlStorage(sqlite.storage);
  createCommerceProjectionSchema(sql);
  createCueDeliverySchema(sql);
  expect(
    readAcceptedCommerceProjectionSequence(sql, {
      organisationId: ORGANISATION_ID.value,
      integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
    }),
  ).toEqual({ ok: true, value: 0 });

  const normalized = await normalizeCommerceEngineDelivery({
    delivery: stockPolicyCrossingDelivery(),
    organisationId: ORGANISATION_ID.value,
    merchantId: "merchant_nuki_cafe",
    integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
    verifier: ACCEPT_ALL_COMMERCE_DELIVERIES,
  });
  expect(normalized.ok).toBe(true);
  if (!normalized.ok) throw new Error(normalized.error);
  if (normalized.kind !== "aggregate")
    throw new Error("expected aggregate delivery");

  const wrongAuthority = applyCommerceDelivery(
    sql,
    {
      organisationId: ORGANISATION_ID.value,
      integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
      delivery: normalized.delivery,
      cueFacts: [],
      labRunId: null,
      processedAt: Date.parse("2026-08-09T00:00:00Z"),
    },
    { kind: "shopify", revision: 1 },
  );
  expect(wrongAuthority).toEqual({
    ok: false,
    error: { code: "commerce_system_authority_mismatch" },
  });
  expect(
    sql
      .exec("SELECT COUNT(*) AS count FROM commerce_delivery_receipt")
      .toArray()[0]?.count,
  ).toBe(0);

  const applied = applyCommerceDelivery(
    sql,
    {
      organisationId: ORGANISATION_ID.value,
      integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
      delivery: normalized.delivery,
      cueFacts: [],
      labRunId: null,
      processedAt: Date.parse("2026-08-09T00:00:00Z"),
    },
    { kind: "satyr_commerce", revision: 4 },
  );
  expect(applied).toMatchObject({
    ok: true,
    value: { disposition: "accepted" },
  });
  expect(
    readAcceptedCommerceProjectionSequence(sql, {
      organisationId: ORGANISATION_ID.value,
      integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
    }),
  ).toEqual({ ok: true, value: 1 });
  const replay = applyCommerceDelivery(
    sql,
    {
      organisationId: ORGANISATION_ID.value,
      integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
      delivery: normalized.delivery,
      cueFacts: [],
      labRunId: null,
      processedAt: Date.parse("2026-08-09T00:00:01Z"),
    },
    { kind: "satyr_commerce", revision: 4 },
  );
  expect(replay).toMatchObject({
    ok: true,
    value: { disposition: "duplicate" },
  });
  expect(
    readAcceptedCommerceProjectionSequence(sql, {
      organisationId: ORGANISATION_ID.value,
      integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
    }),
  ).toEqual({ ok: true, value: 1 });
  const cues = readRecoverableCommerceCues(sql, {
    organisationId: ORGANISATION_ID.value,
    limit: 10,
    retryBefore: Date.parse("2026-08-09T00:00:00Z"),
  });
  expect(cues).toMatchObject({
    ok: true,
    value: [
      {
        nativeId:
          "commerce:inventory-low-stock:underclerk:merchant_nuki_cafe:stock_policy_oat_milk_cafe:1:underclerk:merchant_nuki_cafe:movement_oat_latte",
        event: {
          eventType: "inventory_low_stock",
          payload: {
            stockPolicyId:
              "underclerk:merchant_nuki_cafe:stock_policy_oat_milk_cafe",
            stockPolicyRevision: 1,
            crossingMovementId:
              "underclerk:merchant_nuki_cafe:movement_oat_latte",
            itemName: "Oat milk",
            merchantCode: "OAT-MILK",
            available: { amount: 7_700, scale: 0, unit: "milliliter" },
            reorderPoint: { amount: 7_800, scale: 0, unit: "milliliter" },
          },
        },
      },
    ],
  });
  expect(cues.ok && cues.value).toHaveLength(1);
  if (!cues.ok || cues.value.length !== 1 || cues.value[0] === undefined) {
    throw new Error("low-stock cue missing");
  }
  const crossingCue = cues.value[0];
  expect(crossingCue.event.eventType).toBe("inventory_low_stock");
  if (crossingCue.event.eventType !== "inventory_low_stock") {
    throw new Error("low-stock cue event missing");
  }
  expect(crossingCue.event.payload.stockPolicyRevision).toBe(1);
  expect(crossingCue.event.payload.crossingMovementId).toContain(
    "movement_oat_latte",
  );

  const crossingClaim = claimCueDelivery(
    sql,
    lowStockClaimInput(crossingCue, 1_000),
  );
  expect(crossingClaim).toMatchObject({ ok: true, value: { kind: "claimed" } });
  if (!crossingClaim.ok || crossingClaim.value.kind !== "claimed") {
    throw new Error("low-stock cue claim failed");
  }
  const crossingCase = await routeLowStockCue(
    crossingCue,
    crossingClaim.value.cueId,
  );
  expect(crossingCase.result.kind).toBe("completed");
  expect(crossingCase.snapshot.identity.caseId).toMatch(/^case_[0-9a-f]{32}$/);
  expectCaseEntryPreview(crossingCase.snapshot, "movement_oat_latte");
  expect(crossingCase.snapshot.assignmentLifecycles).toHaveLength(2);
  expect(
    completeClaimedCueDelivery(sql, {
      organisationId: ORGANISATION_ID.value,
      cueId: crossingClaim.value.cueId,
      leaseId: crossingClaim.value.leaseId,
      outcome: "proposed",
      now: 1_001,
    }),
  ).toEqual({ ok: true, value: null });

  const duplicateClaim = claimCueDelivery(
    sql,
    lowStockClaimInput(crossingCue, 1_002),
  );
  expect(duplicateClaim).toEqual({
    ok: true,
    value: { kind: "duplicate", cueId: crossingClaim.value.cueId },
  });
  const duplicateSnapshot = await crossingCase.actor.inspect();
  expect(duplicateSnapshot).toMatchObject({
    ok: true,
    value: {
      identity: { caseId: crossingCase.snapshot.identity.caseId },
    },
  });
  if (!duplicateSnapshot.ok) throw new Error(duplicateSnapshot.error.code);
  expect(duplicateSnapshot.value.entries[0]?.entryId).toContain("trigger_");
  expect(duplicateSnapshot.value.entries).toHaveLength(3);

  const below = await requireNormalizedCommerceDelivery(
    stockPolicyDecreaseDelivery(
      "delivery_oat_latte_second",
      "movement_oat_latte_second",
      3,
      7_400,
      300,
    ),
  );
  expect(
    applyCommerceDelivery(
      sql,
      {
        organisationId: ORGANISATION_ID.value,
        integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
        delivery: below,
        cueFacts: [],
        labRunId: null,
        processedAt: Date.parse("2026-08-09T00:00:02Z"),
      },
      { kind: "satyr_commerce", revision: 4 },
    ),
  ).toMatchObject({ ok: true });
  const belowCues = readRecoverableCommerceCues(sql, {
    organisationId: ORGANISATION_ID.value,
    limit: 10,
    retryBefore: Date.parse("2026-08-09T00:00:00Z"),
  });
  expect(belowCues.ok && belowCues.value).toHaveLength(1);

  const recovered = await requireNormalizedCommerceDelivery(
    stockPolicyIncreaseDelivery(
      "delivery_oat_latte_recovery",
      "movement_oat_latte_recovery",
      4,
      8_400,
      1_000,
    ),
  );
  expect(
    applyCommerceDelivery(
      sql,
      {
        organisationId: ORGANISATION_ID.value,
        integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
        delivery: recovered,
        cueFacts: [],
        labRunId: null,
        processedAt: Date.parse("2026-08-09T00:00:03Z"),
      },
      { kind: "satyr_commerce", revision: 4 },
    ),
  ).toMatchObject({ ok: true });
  const recrossed = await requireNormalizedCommerceDelivery(
    stockPolicyDecreaseDelivery(
      "delivery_oat_latte_recross",
      "movement_oat_latte_recross",
      5,
      7_700,
      700,
    ),
  );
  expect(
    applyCommerceDelivery(
      sql,
      {
        organisationId: ORGANISATION_ID.value,
        integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
        delivery: recrossed,
        cueFacts: [],
        labRunId: null,
        processedAt: Date.parse("2026-08-09T00:00:04Z"),
      },
      { kind: "satyr_commerce", revision: 4 },
    ),
  ).toMatchObject({ ok: true });
  const recrossedCues = readRecoverableCommerceCues(sql, {
    organisationId: ORGANISATION_ID.value,
    limit: 10,
    retryBefore: Date.parse("2026-08-09T00:00:00Z"),
  });
  expect(recrossedCues.ok && recrossedCues.value).toHaveLength(2);
  expect(recrossedCues.ok && recrossedCues.value[1]?.nativeId).toContain(
    "movement_oat_latte_recross",
  );
  if (
    !recrossedCues.ok ||
    recrossedCues.value.length !== 2 ||
    recrossedCues.value[1] === undefined
  ) {
    throw new Error("recrossing cue missing");
  }
  const recrossedCue = recrossedCues.value[1];
  const recrossedClaim = claimCueDelivery(
    sql,
    lowStockClaimInput(recrossedCue, 2_000),
  );
  expect(recrossedClaim).toMatchObject({
    ok: true,
    value: { kind: "claimed" },
  });
  if (!recrossedClaim.ok || recrossedClaim.value.kind !== "claimed") {
    throw new Error("recrossing cue claim failed");
  }
  const recrossedCase = await routeLowStockCue(
    recrossedCue,
    recrossedClaim.value.cueId,
  );
  expect(recrossedCase.result.kind).toBe("completed");
  expect(recrossedCase.snapshot.identity.caseId).not.toBe(
    crossingCase.snapshot.identity.caseId,
  );
  expectCaseEntryPreview(recrossedCase.snapshot, "movement_oat_latte_recross");
  expect(
    completeClaimedCueDelivery(sql, {
      organisationId: ORGANISATION_ID.value,
      cueId: recrossedClaim.value.cueId,
      leaseId: recrossedClaim.value.leaseId,
      outcome: "proposed",
      now: 2_001,
    }),
  ).toEqual({ ok: true, value: null });
});

it("canonicalizes first-party shipment package lines and label attempts", async () => {
  if (!ORGANISATION_ID.ok || !INTEGRATION_ACCOUNT_ID.ok)
    throw new Error("invalid shipment fixture identity");
  const normalized = await normalizeCommerceEngineDelivery({
    delivery: firstPartyShipmentDelivery(),
    organisationId: ORGANISATION_ID.value,
    merchantId: "merchant_nuki_cafe",
    integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
    verifier: ACCEPT_ALL_COMMERCE_DELIVERIES,
  });
  expect(normalized.ok).toBe(true);
  if (!normalized.ok) throw new Error(normalized.error);
  if (normalized.kind !== "aggregate")
    throw new Error("expected aggregate delivery");
  const observation = normalized.delivery.observations[0];
  if (
    observation?.kind !== "upsert" ||
    observation.projection.kind !== "shipment"
  ) {
    throw new Error("first-party shipment observation missing");
  }
  expect(observation.projection.projection).toMatchObject({
    kind: "first_party",
    package: {
      packageId: "underclerk:merchant_nuki_cafe:package_cafe_1",
      lineQuantities: [
        { orderLineId: "underclerk:merchant_nuki_cafe:order_line_latte" },
      ],
      customsLines: [
        { orderLineId: "underclerk:merchant_nuki_cafe:order_line_latte" },
      ],
    },
    lifecycle: {
      state: "delivered",
      labelAttemptId: "underclerk:merchant_nuki_cafe:label_attempt_1",
    },
  });
});

it("projects first-party shipment lifecycle transitions with replay-safe canonical views", async () => {
  const sqlite = emptySqliteFixture();
  const sql = sqlStorage(sqlite.storage);
  createCommerceProjectionSchema(sql);

  const ready = await requireNormalizedCommerceDelivery(
    firstPartyShipmentLifecycleDelivery(
      "ready",
      1,
      "delivery_first_party_shipment_ready",
    ),
  );
  expect(
    applyCommerceShipmentDelivery(
      sql,
      ready,
      Date.parse("2026-08-14T10:00:00Z"),
    ),
  ).toMatchObject({
    ok: true,
    value: {
      disposition: "accepted",
      observations: [
        {
          disposition: "applied",
          canonicalId: FIRST_PARTY_SHIPMENT_CANONICAL_ID,
          revision: 1,
        },
      ],
    },
  });
  expectFirstPartyShipmentProjection(sql, "ready", 1);

  const labelPurchased = await requireNormalizedCommerceDelivery(
    firstPartyShipmentLifecycleDelivery(
      "label_purchased",
      2,
      "delivery_first_party_shipment_label_purchased",
    ),
  );
  expect(
    applyCommerceShipmentDelivery(
      sql,
      labelPurchased,
      Date.parse("2026-08-14T10:01:00Z"),
    ),
  ).toMatchObject({
    ok: true,
    value: {
      disposition: "accepted",
      observations: [
        {
          disposition: "applied",
          canonicalId: FIRST_PARTY_SHIPMENT_CANONICAL_ID,
          revision: 2,
        },
      ],
    },
  });
  expectFirstPartyShipmentProjection(sql, "label_purchased", 2);

  const inTransit = await requireNormalizedCommerceDelivery(
    firstPartyShipmentLifecycleDelivery(
      "in_transit",
      3,
      "delivery_first_party_shipment_in_transit",
    ),
  );
  expect(
    applyCommerceShipmentDelivery(
      sql,
      inTransit,
      Date.parse("2026-08-14T10:02:00Z"),
    ),
  ).toMatchObject({
    ok: true,
    value: {
      disposition: "accepted",
      observations: [
        {
          disposition: "applied",
          canonicalId: FIRST_PARTY_SHIPMENT_CANONICAL_ID,
          revision: 3,
        },
      ],
    },
  });
  expectFirstPartyShipmentProjection(sql, "in_transit", 3);

  const delivered = await requireNormalizedCommerceDelivery(
    firstPartyShipmentLifecycleDelivery(
      "delivered",
      4,
      "delivery_first_party_shipment_delivered",
    ),
  );
  expect(
    applyCommerceShipmentDelivery(
      sql,
      delivered,
      Date.parse("2026-08-14T10:03:00Z"),
    ),
  ).toMatchObject({
    ok: true,
    value: {
      disposition: "accepted",
      observations: [
        {
          disposition: "applied",
          canonicalId: FIRST_PARTY_SHIPMENT_CANONICAL_ID,
          revision: 4,
        },
      ],
    },
  });
  expectFirstPartyShipmentProjection(sql, "delivered", 4);

  expect(
    applyCommerceShipmentDelivery(
      sql,
      delivered,
      Date.parse("2026-08-14T10:04:00Z"),
    ),
  ).toMatchObject({ ok: true, value: { disposition: "duplicate" } });
  const lateInTransit = await requireNormalizedCommerceDelivery(
    firstPartyShipmentLifecycleDelivery(
      "in_transit",
      3,
      "delivery_first_party_shipment_in_transit_late",
    ),
  );
  expect(
    applyCommerceShipmentDelivery(
      sql,
      lateInTransit,
      Date.parse("2026-08-14T10:05:00Z"),
    ),
  ).toMatchObject({
    ok: true,
    value: {
      disposition: "accepted",
      observations: [
        {
          disposition: "out_of_order",
          canonicalId: FIRST_PARTY_SHIPMENT_CANONICAL_ID,
          revision: 3,
        },
      ],
    },
  });
  expectFirstPartyShipmentProjection(sql, "delivered", 4);
});

it("applies a completed production batch delivery and crosses low stock once", async () => {
  if (!ORGANISATION_ID.ok || !INTEGRATION_ACCOUNT_ID.ok)
    throw new Error("invalid low-stock fixture identity");
  const sqlite = emptySqliteFixture();
  const sql = sqlStorage(sqlite.storage);
  createCommerceProjectionSchema(sql);

  const delivery = await requireNormalizedCommerceDelivery(
    productionBatchCrossingDelivery(),
  );
  const applied = applyCommerceDelivery(
    sql,
    {
      organisationId: ORGANISATION_ID.value,
      integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
      delivery,
      cueFacts: [],
      labRunId: null,
      processedAt: Date.parse("2026-08-09T00:00:00Z"),
    },
    { kind: "satyr_commerce", revision: 4 },
  );
  expect(applied).toMatchObject({
    ok: true,
    value: { disposition: "accepted" },
  });

  expect(
    readCurrentCommerceProjection(sql, {
      organisationId: ORGANISATION_ID.value,
      kind: "production_batch",
      canonicalId: "underclerk:merchant_nuki_cafe:production_batch_oat_milk",
    }),
  ).toMatchObject({
    ok: true,
    value: {
      kind: "production_batch",
      projection: {
        productionBatchId:
          "underclerk:merchant_nuki_cafe:production_batch_oat_milk",
        inputMovementIds: [
          "underclerk:merchant_nuki_cafe:movement_production_input",
        ],
        outputMovementId:
          "underclerk:merchant_nuki_cafe:movement_production_output",
        outputLotId: "underclerk:merchant_nuki_cafe:lot_production_output",
      },
    },
  });
  expect(
    readCurrentCommerceProjection(sql, {
      organisationId: ORGANISATION_ID.value,
      kind: "inventory_movement",
      canonicalId: "underclerk:merchant_nuki_cafe:movement_production_input",
    }),
  ).toMatchObject({
    ok: true,
    value: {
      kind: "inventory_movement",
      projection: {
        change: {
          kind: "decrease",
          reason: {
            kind: "production",
            productionBatchId:
              "underclerk:merchant_nuki_cafe:production_batch_oat_milk",
            recipeRevision: 1,
          },
        },
      },
    },
  });
  for (const [kind, canonicalId] of [
    [
      "inventory_movement",
      "underclerk:merchant_nuki_cafe:movement_production_output",
    ],
    ["inventory_lot", "underclerk:merchant_nuki_cafe:lot_production_output"],
    [
      "inventory_position",
      "underclerk:merchant_nuki_cafe:position_cookie_cafe",
    ],
  ] as const) {
    expect(
      readCurrentCommerceProjection(sql, {
        organisationId: ORGANISATION_ID.value,
        kind,
        canonicalId,
      }),
    ).toMatchObject({ ok: true, value: { kind } });
  }

  const replay = applyCommerceDelivery(
    sql,
    {
      organisationId: ORGANISATION_ID.value,
      integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
      delivery,
      cueFacts: [],
      labRunId: null,
      processedAt: Date.parse("2026-08-09T00:00:01Z"),
    },
    { kind: "satyr_commerce", revision: 4 },
  );
  expect(replay).toMatchObject({
    ok: true,
    value: { disposition: "duplicate" },
  });
  const cues = readRecoverableCommerceCues(sql, {
    organisationId: ORGANISATION_ID.value,
    limit: 10,
    retryBefore: Date.parse("2026-08-09T00:00:00Z"),
  });
  expect(cues.ok && cues.value).toHaveLength(1);
  expect(cues.ok && cues.value[0]?.nativeId).toContain(
    "movement_production_input",
  );
});

it("converges to one low-stock cue when decrease deliveries arrive out of order", async () => {
  if (!ORGANISATION_ID.ok || !INTEGRATION_ACCOUNT_ID.ok)
    throw new Error("invalid low-stock fixture identity");
  const sqlite = emptySqliteFixture();
  const sql = sqlStorage(sqlite.storage);
  createCommerceProjectionSchema(sql);

  const laterDecrease = await requireNormalizedCommerceDelivery(
    stockPolicyOutOfOrderFirstDelivery(),
  );
  expect(
    applyCommerceDelivery(
      sql,
      {
        organisationId: ORGANISATION_ID.value,
        integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
        delivery: laterDecrease,
        cueFacts: [],
        labRunId: null,
        processedAt: Date.parse("2026-08-09T00:00:02Z"),
      },
      { kind: "satyr_commerce", revision: 4 },
    ),
  ).toMatchObject({
    ok: true,
    value: { disposition: "accepted" },
  });

  const earlierDecrease = await requireNormalizedCommerceDelivery(
    stockPolicyCrossingDelivery(),
  );
  expect(
    applyCommerceDelivery(
      sql,
      {
        organisationId: ORGANISATION_ID.value,
        integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
        delivery: earlierDecrease,
        cueFacts: [],
        labRunId: null,
        processedAt: Date.parse("2026-08-09T00:00:03Z"),
      },
      { kind: "satyr_commerce", revision: 4 },
    ),
  ).toMatchObject({
    ok: true,
    value: { disposition: "accepted" },
  });

  const cues = readRecoverableCommerceCues(sql, {
    organisationId: ORGANISATION_ID.value,
    limit: 10,
    retryBefore: Date.parse("2026-08-09T00:00:00Z"),
  });
  expect(cues.ok && cues.value).toHaveLength(1);
  expect(cues.ok && cues.value[0]?.nativeId).toContain(
    "movement_oat_latte_second",
  );
});

it("converges when the receipt cohort arrives before the opening inventory delivery", async function inventoryReceiptOutOfOrderConvergence() {
  if (!ORGANISATION_ID.ok || !INTEGRATION_ACCOUNT_ID.ok)
    throw new Error("invalid inventory fixture identity");
  const sqlite = emptySqliteFixture();
  const sql = sqlStorage(sqlite.storage);
  createCommerceProjectionSchema(sql);
  const receipt =
    await requireNormalizedCommerceDelivery(oatReceiptDelivery());
  const opening =
    await requireNormalizedCommerceDelivery(oatOpeningDelivery());

  expect(
    applyCommerceDelivery(
      sql,
      {
        organisationId: ORGANISATION_ID.value,
        integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
        delivery: receipt,
        cueFacts: [],
        labRunId: null,
        processedAt: Date.parse("2026-08-14T09:30:01Z"),
      },
      { kind: "satyr_commerce", revision: 4 },
    ),
  ).toMatchObject({
    ok: true,
    value: {
      disposition: "accepted",
      observations: [
        { disposition: "applied" },
        { disposition: "applied" },
        { disposition: "applied" },
      ],
    },
  });
  expect(
    applyCommerceDelivery(
      sql,
      {
        organisationId: ORGANISATION_ID.value,
        integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
        delivery: opening,
        cueFacts: [],
        labRunId: null,
        processedAt: Date.parse("2026-08-14T09:30:02Z"),
      },
      { kind: "satyr_commerce", revision: 4 },
    ),
  ).toMatchObject({
    ok: true,
    value: {
      disposition: "accepted",
      observations: [
        { disposition: "applied" },
        { disposition: "out_of_order" },
        { disposition: "applied" },
        { disposition: "applied" },
      ],
    },
  });

  expect(
    sql
      .exec(
        `SELECT projection_kind AS kind, COUNT(*) AS count
       FROM commerce_projection
      WHERE projection_kind IN ('inventory_position', 'inventory_movement', 'inventory_lot')
      GROUP BY projection_kind
      ORDER BY projection_kind`,
      )
      .toArray(),
  ).toEqual([
    { kind: "inventory_lot", count: 1 },
    { kind: "inventory_movement", count: 1 },
    { kind: "inventory_position", count: 2 },
  ]);
});

type RoutedLowStockCase = {
  readonly actor: CaseDO;
  readonly result: DirectTwoSessionCasePathResult;
  readonly snapshot: CaseSnapshot;
};

function lowStockClaimInput(cue: PendingCommerceCue, now: number) {
  return {
    organisationId: cue.organisationId,
    subscriptionId: "onboarding-commerce-inventory-low-stock",
    source: cue.event.source,
    nativeId: cue.nativeId,
    debounceMs: 0,
    maxPerHour: 10,
    now,
    leaseDurationMs: 60_000,
  } as const;
}

async function routeLowStockCue(
  cue: PendingCommerceCue,
  cueId: string,
): Promise<RoutedLowStockCase> {
  if (cue.event.eventType !== "inventory_low_stock") {
    throw new Error("unexpected low-stock cue event");
  }
  const identities = await lowStockCaseIdentities(cue);
  const actor = await createLowStockCaseActor(
    cue.organisationId,
    identities.caseId,
  );
  const result = await runDirectTwoSessionCasePath({
    env: platformEnv({}),
    ...fixtureDirectTwoSessionContext({
      organisationId: cue.organisationId,
      caseId: identities.caseId,
      connectorId: "connector_fixture",
      participants: [
        {
          assignmentId: identities.coordinatorAssignmentId,
          sessionId: identities.coordinatorSessionId,
        },
        {
          assignmentId: identities.specialistAssignmentId,
          sessionId: identities.specialistSessionId,
        },
      ],
    }),
    caseActor: actor,
    organisationId: cue.organisationId,
    caseId: identities.caseId,
    triggerId: identities.triggerId,
    triggerSource: { kind: "cue", eventId: cueId },
    content: {
      kind: "text",
      text:
        `Review ${cue.event.payload.itemName} at ${cue.event.payload.locationId}; ` +
        `policy ${cue.event.payload.stockPolicyId}@${cue.event.payload.stockPolicyRevision} ` +
        `crossed by ${cue.event.payload.crossingMovementId}.`,
    },
    purpose: `Review low stock for ${cue.event.payload.itemName}.`,
    principal: { kind: "system", componentId: "cue_engine" },
    policy: lowStockCasePolicy(),
    pinnedAgent: null,
    workspaceRevisionReceipt: lowStockWorkspaceRevisionReceipt(),
    receivedAt: cue.createdAt,
    participants: [
      {
        session: lowStockCaseSession("coordinator"),
        requestId: identities.coordinatorRequestId,
        sessionId: identities.coordinatorSessionId,
        assignmentId: identities.coordinatorAssignmentId,
        role: "coordinator",
        objective: "Compare immediate fulfillment and restocking options.",
      },
      {
        session: lowStockCaseSession("specialist"),
        requestId: identities.specialistRequestId,
        sessionId: identities.specialistSessionId,
        assignmentId: identities.specialistAssignmentId,
        role: "specialist",
        objective:
          "Assess replenishment quantity, timing, and operational constraints.",
      },
    ],
    delivery: { kind: "none" },
  });
  if (!result.ok) throw new Error(result.error.code);
  const snapshot = await actor.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  return { actor, result: result.value, snapshot: snapshot.value };
}

function expectCaseEntryPreview(snapshot: CaseSnapshot, text: string): void {
  const entry = snapshot.entries[0];
  if (entry === undefined || entry.kind !== "inline_preview") {
    throw new Error("low-stock Case trigger entry missing");
  }
  expect(entry.preview).toContain(text);
}

async function lowStockCaseIdentities(cue: PendingCommerceCue): Promise<{
  readonly caseId: import("../src/ids").CaseId;
  readonly triggerId: string;
  readonly coordinatorRequestId: import("../src/ids").RequestId;
  readonly coordinatorSessionId: import("../src/ids").SessionId;
  readonly coordinatorAssignmentId: string;
  readonly specialistRequestId: import("../src/ids").RequestId;
  readonly specialistSessionId: import("../src/ids").SessionId;
  readonly specialistAssignmentId: string;
}> {
  const stableIdentity = `${cue.organisationId}:cue:${cue.event.source}:${cue.nativeId}`;
  const digest = (await sha256Hex(stableIdentity)).slice(0, 32);
  const caseId = parseCaseId(`case_${digest}`);
  const coordinatorRequestId = parseRequestId(
    `request_case_${digest}_coordinator`,
  );
  const coordinatorSessionId = parseSessionId(
    `session_case_${digest}_coordinator`,
  );
  const coordinatorAssignmentId = parseAssignmentId(
    `assignment_case_${digest}_coordinator`,
  );
  const specialistRequestId = parseRequestId(
    `request_case_${digest}_specialist`,
  );
  const specialistSessionId = parseSessionId(
    `session_case_${digest}_specialist`,
  );
  const specialistAssignmentId = parseAssignmentId(
    `assignment_case_${digest}_specialist`,
  );
  if (
    !caseId.ok ||
    !coordinatorRequestId.ok ||
    !coordinatorSessionId.ok ||
    !coordinatorAssignmentId.ok ||
    !specialistRequestId.ok ||
    !specialistSessionId.ok ||
    !specialistAssignmentId.ok
  ) {
    throw new Error("low-stock case identity invalid");
  }
  return {
    caseId: caseId.value,
    triggerId: `trigger_${digest}`,
    coordinatorRequestId: coordinatorRequestId.value,
    coordinatorSessionId: coordinatorSessionId.value,
    coordinatorAssignmentId: coordinatorAssignmentId.value,
    specialistRequestId: specialistRequestId.value,
    specialistSessionId: specialistSessionId.value,
    specialistAssignmentId: specialistAssignmentId.value,
  };
}

async function createLowStockCaseActor(
  organisationId: OrganisationId,
  caseId: CaseId,
): Promise<CaseDO> {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  const storage = {
    sql,
    deleteAlarm: clearFixtureAlarm,
    setAlarm: vi.fn().mockResolvedValue(undefined),
    transactionSync<Value>(callback: () => Value): Value {
      fixture.database.exec("BEGIN IMMEDIATE");
      try {
        const value = callback();
        fixture.database.exec("COMMIT");
        return value;
      } catch (error) {
        fixture.database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const env = platformEnv({
    DB: createMigratedDatabase(),
    SATYR_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    EVENT_Q: { send: ignoreQueueMessage },
  });
  const actor = new CaseDO(
    { storage, waitUntil: vi.fn() } as unknown as DurableObjectState,
    env,
  );
  await activateActorFixture(
    env,
    actor,
    { objectKind: "case", organisationId, logicalObjectId: caseId },
    CASE_ACTOR_SCHEMA_VERSION,
  );
  return actor;
}

async function ignoreQueueMessage(_message: unknown): Promise<void> {}

function lowStockCaseSession(
  role: "coordinator" | "specialist",
): CaseWalkingSession {
  let sessionId: string | null = null;
  return {
    async initializeCaseSession(input) {
      sessionId = input.assignment.sessionId;
      return {
        ok: true,
        value: {
          kind: "accepted",
          eventId: `initialized_${role}`,
          sequence: 0,
        },
      };
    },
    async prepareSessionInformationFlow(input) {
      return {
        ok: true,
        value: { flowBinding: await lowStockFlowBinding(input) },
      };
    },
    async startCanonicalEmbeddedHarnessTextTurn(input) {
      if (sessionId === null)
        throw new Error("low-stock session was not initialized");
      return {
        ok: true,
        value: {
          outcome: { status: "success", summary: null, artifacts: [] },
          finalMessage: `${role} observation accepted.`,
          flowBinding: await lowStockFlowBinding({
            sessionId,
            turnId: input.start.turnId,
            authorityPartitionDigest: input.start.authorityPartitionDigest,
          }),
        },
      };
    },
  };
}

async function lowStockFlowBinding(
  input: Readonly<{
    readonly sessionId: string;
    readonly turnId: string;
    readonly authorityPartitionDigest: string;
  }>,
): Promise<SerializedFlowBinding> {
  const context = await InformationFlowContext.create({
    organisationId: "organisation_underclerk_low_stock",
    sessionId: input.sessionId,
    authorityPartitionDigest: input.authorityPartitionDigest,
  });
  if (!context.ok) throw new Error(context.error.code);
  return flowBindingForContext(context.value, input.turnId).toJSON();
}

function lowStockCasePolicy() {
  return {
    version: 1,
    egress: {
      allowedHosts: [],
      injections: [],
      modelRoute: { baseUrl: "https://model-gateway.test" },
    },
    authz: {
      allowedTools: [],
      deniedTools: [],
      approvalRequired: [],
      maxBudget: { maxTokens: 10_000, maxWallMs: 60_000, maxToolCalls: 20 },
    },
    conversationRisk: { outputScreeningMode: "stream" as const },
    modelRoute: {
      keySource: "organisation_subscription" as const,
      provider: "openai" as const,
      model: "gpt-5.6-luna",
      connectionRevision: 1,
      authProfileGeneration: 1,
    },
  };
}

function lowStockWorkspaceRevisionReceipt() {
  return {
    receiptId: "workspace_receipt_underclerk_low_stock",
    outcome: "accepted" as const,
    workspaceId: "workspace_underclerk_low_stock",
    revision: "workspace_revision_underclerk_low_stock",
    canonicalHead: "a".repeat(64),
    correlationId: "request_underclerk_low_stock",
    causation: {
      kind: "command" as const,
      commandId: "command_underclerk_low_stock",
    },
  };
}

async function acceptCommerceDelivery(): Promise<boolean> {
  return true;
}

type FirstPartyShipmentStage =
  "ready" | "label_purchased" | "in_transit" | "delivered";

const FIRST_PARTY_SHIPMENT_CANONICAL_ID =
  "underclerk:merchant_nuki_cafe:shipment_cookie_store_sg";
const FIRST_PARTY_ORDER_CANONICAL_ID =
  "underclerk:merchant_nuki_cafe:order_cookie_store_sg";
const FIRST_PARTY_FULFILLMENT_CANONICAL_ID =
  "underclerk:merchant_nuki_cafe:fulfillment_cookie_store_sg";
const FIRST_PARTY_PACKAGE_CANONICAL_ID =
  "underclerk:merchant_nuki_cafe:package_cookie_box_6";
const FIRST_PARTY_ORDER_LINE_CANONICAL_ID =
  "underclerk:merchant_nuki_cafe:order_line_cookie_box_6";
const FIRST_PARTY_LABEL_ATTEMPT_CANONICAL_ID =
  "underclerk:merchant_nuki_cafe:label_attempt_cookie_store_sg";
const FIRST_PARTY_TRACKING_NUMBER = "COOKIE-SG-001";

const FIRST_PARTY_SHIPMENT_TIMES = {
  ready: "2026-08-14T10:00:00Z",
  label_purchased: "2026-08-14T10:01:00Z",
  in_transit: "2026-08-14T10:02:00Z",
  delivered: "2026-08-14T10:03:00Z",
} as const;

function applyCommerceShipmentDelivery(
  sql: SqlStorage,
  delivery: CanonicalCommerceDelivery,
  processedAt: number,
) {
  if (!ORGANISATION_ID.ok || !INTEGRATION_ACCOUNT_ID.ok) {
    throw new Error("invalid shipment fixture identity");
  }
  return applyCommerceDelivery(
    sql,
    {
      organisationId: ORGANISATION_ID.value,
      integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
      delivery,
      cueFacts: [],
      labRunId: null,
      processedAt,
    },
    { kind: "satyr_commerce", revision: 4 },
  );
}

function expectFirstPartyShipmentProjection(
  sql: SqlStorage,
  state: FirstPartyShipmentStage,
  revision: number,
): void {
  if (!ORGANISATION_ID.ok) throw new Error("invalid shipment fixture identity");
  const current = readCurrentCommerceProjection(sql, {
    organisationId: ORGANISATION_ID.value,
    kind: "shipment",
    canonicalId: FIRST_PARTY_SHIPMENT_CANONICAL_ID,
  });
  expect(current).toMatchObject({
    ok: true,
    value: {
      kind: "shipment",
      projection: {
        kind: "first_party",
        orderId: FIRST_PARTY_ORDER_CANONICAL_ID,
        fulfillmentId: FIRST_PARTY_FULFILLMENT_CANONICAL_ID,
        package: {
          packageId: FIRST_PARTY_PACKAGE_CANONICAL_ID,
          lineQuantities: [
            { orderLineId: FIRST_PARTY_ORDER_LINE_CANONICAL_ID },
          ],
          customsLines: [{ orderLineId: FIRST_PARTY_ORDER_LINE_CANONICAL_ID }],
        },
      },
    },
  });
  if (
    !current.ok ||
    current.value?.kind !== "shipment" ||
    current.value.projection.kind !== "first_party"
  ) {
    throw new Error("first-party shipment projection missing");
  }
  expect(current.value.projection.provenance.resourceId).toBe(
    FIRST_PARTY_SHIPMENT_CANONICAL_ID,
  );
  expect(current.value.projection.provenance.revision).toBe(revision);
  switch (state) {
    case "ready":
      expect(current.value.projection.lifecycle).toEqual({
        state,
        readyAt: FIRST_PARTY_SHIPMENT_TIMES.ready,
      });
      return;
    case "label_purchased":
      expect(current.value.projection.lifecycle).toEqual({
        state,
        labelAttemptId: FIRST_PARTY_LABEL_ATTEMPT_CANONICAL_ID,
        trackingNumber: FIRST_PARTY_TRACKING_NUMBER,
        purchasedAt: FIRST_PARTY_SHIPMENT_TIMES.label_purchased,
      });
      return;
    case "in_transit":
      expect(current.value.projection.lifecycle).toEqual({
        state,
        labelAttemptId: FIRST_PARTY_LABEL_ATTEMPT_CANONICAL_ID,
        trackingNumber: FIRST_PARTY_TRACKING_NUMBER,
        handedOverAt: FIRST_PARTY_SHIPMENT_TIMES.in_transit,
      });
      return;
    case "delivered":
      expect(current.value.projection.lifecycle).toEqual({
        state,
        labelAttemptId: FIRST_PARTY_LABEL_ATTEMPT_CANONICAL_ID,
        trackingNumber: FIRST_PARTY_TRACKING_NUMBER,
        handedOverAt: FIRST_PARTY_SHIPMENT_TIMES.in_transit,
        deliveredAt: FIRST_PARTY_SHIPMENT_TIMES.delivered,
      });
      return;
  }
}

function firstPartyShipmentLifecycleDelivery(
  state: FirstPartyShipmentStage,
  revision: number,
  deliveryId: string,
): CommerceDeliveryV1 {
  const occurredAt = FIRST_PARTY_SHIPMENT_TIMES[state];
  return {
    schemaVersion: "underclerk.commerce-delivery.v1",
    deliveryId,
    organisationId: ORGANISATION_ID.ok
      ? ORGANISATION_ID.value
      : "organisation_underclerk_low_stock",
    merchantId: "merchant_nuki_cafe",
    merchantRevision: revision,
    observedAt: occurredAt,
    observations: [
      {
        kind: "shipment",
        resource: {
          id: "shipment_cookie_store_sg",
          revision,
          orderId: "order_cookie_store_sg",
          fulfillmentId: "fulfillment_cookie_store_sg",
          occurredAt,
          kind: "first_party",
          package: {
            packageId: "package_cookie_box_6",
            weight: { grams: 1_200 },
            dimensions: {
              lengthMillimeters: 300,
              widthMillimeters: 220,
              heightMillimeters: 120,
            },
            lineQuantities: [
              {
                orderLineId: "order_line_cookie_box_6",
                quantity: { amount: 1, scale: 0, unit: "each" },
              },
            ],
            customsLines: [
              {
                orderLineId: "order_line_cookie_box_6",
                description: "Six baked cookies in one retail box",
                quantity: { amount: 1, scale: 0, unit: "each" },
                weight: { grams: 1_200 },
                declaredValue: { amountMinor: 3_600, currency: "JPY" },
                countryOfOrigin: "JP",
                hsCode: "190531",
              },
            ],
          },
          lifecycle: firstPartyShipmentLifecycle(state),
          events: firstPartyShipmentEvents(state),
        },
      },
    ],
    signer: {
      keyId: "key_underclerk_low_stock",
      algorithm: "ed25519",
      signature: "signature",
    },
  };
}

function firstPartyShipmentLifecycle(
  state: FirstPartyShipmentStage,
): CommerceFirstPartyShipmentV1["lifecycle"] {
  switch (state) {
    case "ready":
      return {
        state,
        readyAt: FIRST_PARTY_SHIPMENT_TIMES.ready,
      };
    case "label_purchased":
      return {
        state,
        labelAttemptId: "label_attempt_cookie_store_sg",
        trackingNumber: FIRST_PARTY_TRACKING_NUMBER,
        purchasedAt: FIRST_PARTY_SHIPMENT_TIMES.label_purchased,
      };
    case "in_transit":
      return {
        state,
        labelAttemptId: "label_attempt_cookie_store_sg",
        trackingNumber: FIRST_PARTY_TRACKING_NUMBER,
        handedOverAt: FIRST_PARTY_SHIPMENT_TIMES.in_transit,
      };
    case "delivered":
      return {
        state,
        labelAttemptId: "label_attempt_cookie_store_sg",
        trackingNumber: FIRST_PARTY_TRACKING_NUMBER,
        handedOverAt: FIRST_PARTY_SHIPMENT_TIMES.in_transit,
        deliveredAt: FIRST_PARTY_SHIPMENT_TIMES.delivered,
      };
  }
}

function firstPartyShipmentEvents(
  state: FirstPartyShipmentStage,
): readonly CommerceTrackingEventV1[] {
  const labelCreated: CommerceTrackingEventV1 = {
    id: "tracking_event_cookie_label_created",
    occurredAt: FIRST_PARTY_SHIPMENT_TIMES.label_purchased,
    kind: { kind: "label_created" },
    location: "Tokyo",
  };
  const inTransit: CommerceTrackingEventV1 = {
    id: "tracking_event_cookie_in_transit",
    occurredAt: FIRST_PARTY_SHIPMENT_TIMES.in_transit,
    kind: { kind: "in_transit" },
    location: "Tokyo",
  };
  const delivered: CommerceTrackingEventV1 = {
    id: "tracking_event_cookie_delivered",
    occurredAt: FIRST_PARTY_SHIPMENT_TIMES.delivered,
    kind: { kind: "delivered" },
    location: "Singapore",
  };
  switch (state) {
    case "ready":
      return [];
    case "label_purchased":
      return [labelCreated];
    case "in_transit":
      return [labelCreated, inTransit];
    case "delivered":
      return [labelCreated, inTransit, delivered];
  }
}

function firstPartyShipmentDelivery(): CommerceDeliveryV1 {
  const occurredAt = "2026-08-09T00:00:00Z";
  return {
    schemaVersion: "underclerk.commerce-delivery.v1",
    deliveryId: "delivery_first_party_shipment",
    organisationId: ORGANISATION_ID.ok
      ? ORGANISATION_ID.value
      : "organisation_underclerk_low_stock",
    merchantId: "merchant_nuki_cafe",
    merchantRevision: 9,
    observedAt: occurredAt,
    observations: [
      {
        kind: "shipment",
        resource: {
          id: "shipment_cafe_1",
          revision: 1,
          orderId: "order_cafe_1",
          fulfillmentId: "fulfillment_cafe_1",
          occurredAt,
          kind: "first_party",
          package: {
            packageId: "package_cafe_1",
            weight: { grams: 650 },
            dimensions: {
              lengthMillimeters: 220,
              widthMillimeters: 160,
              heightMillimeters: 90,
            },
            lineQuantities: [
              {
                orderLineId: "order_line_latte",
                quantity: { amount: 1, scale: 0, unit: "each" },
              },
            ],
            customsLines: [
              {
                orderLineId: "order_line_latte",
                description: "Latte",
                quantity: { amount: 1, scale: 0, unit: "each" },
                weight: { grams: 650 },
                declaredValue: { amountMinor: 800, currency: "JPY" },
                countryOfOrigin: "JP",
                hsCode: "0901.21",
              },
            ],
          },
          lifecycle: {
            state: "delivered",
            labelAttemptId: "label_attempt_1",
            trackingNumber: "CAFE-TRACK-1",
            handedOverAt: "2026-08-08T00:00:00Z",
            deliveredAt: occurredAt,
          },
          events: [
            {
              id: "tracking_event_delivered",
              occurredAt,
              kind: { kind: "delivered" },
              location: "Cafe",
            },
          ],
        },
      },
    ],
    signer: {
      keyId: "key_underclerk_low_stock",
      algorithm: "ed25519",
      signature: "signature",
    },
  };
}

function stockPolicyCrossingDelivery(): CommerceDeliveryV1 {
  const occurredAt = "2026-08-09T00:00:00Z";
  const provenance = {
    organisationId: ORGANISATION_ID.ok
      ? ORGANISATION_ID.value
      : "organisation_underclerk_low_stock",
    integrationAccountId: INTEGRATION_ACCOUNT_ID.ok
      ? INTEGRATION_ACCOUNT_ID.value
      : "integration_underclerk_low_stock",
    source: "underclerk" as const,
    resourceType: "stock_policy" as const,
    resourceId: "stock_policy_oat_milk_cafe",
    revision: 1,
    occurredAt,
    observedAt: occurredAt,
  };
  return {
    schemaVersion: "underclerk.commerce-delivery.v1",
    deliveryId: "delivery_underclerk_low_stock",
    organisationId: ORGANISATION_ID.ok
      ? ORGANISATION_ID.value
      : "organisation_underclerk_low_stock",
    merchantId: "merchant_nuki_cafe",
    merchantRevision: 1,
    observedAt: occurredAt,
    observations: [
      {
        kind: "inventory_item",
        resource: {
          id: "inventory_oat_milk",
          revision: 1,
          merchantCode: "OAT-MILK",
          name: "Oat milk",
          baseUnit: "milliliter",
          category: "ingredient",
          tracking: { kind: "lot_tracked", expiry: "required" },
          lifecycle: "active",
          occurredAt,
        },
      },
      {
        kind: "stock_policy",
        resource: {
          provenance,
          stockPolicyId: "stock_policy_oat_milk_cafe",
          inventoryItemId: "inventory_oat_milk",
          locationId: "location_nuki_cafe",
          revision: 1,
          replenishment: {
            kind: "threshold",
            reorderPoint: { amount: 7_800, scale: 0, unit: "milliliter" },
            targetQuantity: { amount: 16_000, scale: 0, unit: "milliliter" },
          },
          lifecycle: "active",
        },
      },
      {
        kind: "inventory_position",
        resource: {
          id: "position_oat_milk_cafe",
          revision: 2,
          inventoryItemId: "inventory_oat_milk",
          locationId: "location_nuki_cafe",
          balance: {
            kind: "accounted",
            onHand: { amount: 7_700, scale: 0, unit: "milliliter" },
            allocated: { amount: 0, scale: 0, unit: "milliliter" },
            available: { amount: 7_700, scale: 0, unit: "milliliter" },
          },
          occurredAt,
        },
      },
      {
        kind: "inventory_movement",
        resource: {
          id: "movement_oat_latte",
          inventoryItemId: "inventory_oat_milk",
          locationId: "location_nuki_cafe",
          change: {
            kind: "decrease",
            quantity: { amount: 300, scale: 0, unit: "milliliter" },
            reason: {
              kind: "preparation",
              ticketId: "ticket_oat_latte",
              recipeRevision: 1,
            },
            lotAllocation: {
              kind: "allocated",
              lots: [
                {
                  lotId: "lot_receipt_line_oat_milk_accepted",
                  quantity: { amount: 300, scale: 0, unit: "milliliter" },
                },
              ],
            },
          },
          occurredAt,
          idempotencyKey: "preparation:ticket_oat_latte:1",
        },
      },
      {
        kind: "inventory_lot",
        resource: {
          id: "lot_receipt_line_oat_milk_accepted",
          lotCode: "OAT-20260814-A",
          inventoryItemId: "inventory_oat_milk",
          locationId: "location_nuki_cafe",
          revision: 2,
          sourceMovementId: "movement_oat_receipt",
          receivedQuantity: { amount: 8_000, scale: 0, unit: "milliliter" },
          remainingQuantity: { amount: 7_700, scale: 0, unit: "milliliter" },
          expiry: { kind: "expires", expiresAt: "2026-08-21T00:00:00.000Z" },
          lifecycle: { state: "available" },
          occurredAt,
        },
      },
    ],
    signer: {
      keyId: "key_underclerk_low_stock",
      algorithm: "ed25519",
      signature: "signature",
    },
  };
}

function productionBatchCrossingDelivery(): CommerceDeliveryV1 {
  const base = stockPolicyCrossingDelivery();
  const observations = [...base.observations];
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index];
    if (
      observation?.kind !== "inventory_movement" ||
      observation.resource.change.kind !== "decrease"
    )
      continue;
    observations[index] = {
      kind: "inventory_movement",
      resource: {
        ...observation.resource,
        id: "movement_production_input",
        change: {
          ...observation.resource.change,
          reason: {
            kind: "production",
            productionBatchId: "production_batch_oat_milk",
            recipeRevision: 1,
          },
        },
        idempotencyKey: "production:production_batch_oat_milk:input:1",
      },
    };
    break;
  }
  const occurredAt = "2026-08-09T00:00:00Z";
  observations.push(
    {
      kind: "inventory_item",
      resource: {
        id: "inventory_cookie",
        revision: 1,
        merchantCode: "COOKIE",
        name: "Cookie",
        baseUnit: "each",
        category: "finished_good",
        tracking: { kind: "lot_tracked", expiry: "required" },
        lifecycle: "active",
        occurredAt,
      },
    },
    {
      kind: "inventory_position",
      resource: {
        id: "position_cookie_cafe",
        revision: 1,
        inventoryItemId: "inventory_cookie",
        locationId: "location_nuki_cafe",
        balance: {
          kind: "accounted",
          onHand: { amount: 1, scale: 0, unit: "each" },
          allocated: { amount: 0, scale: 0, unit: "each" },
          available: { amount: 1, scale: 0, unit: "each" },
        },
        occurredAt,
      },
    },
    {
      kind: "inventory_movement",
      resource: {
        id: "movement_production_output",
        inventoryItemId: "inventory_cookie",
        locationId: "location_nuki_cafe",
        change: {
          kind: "increase",
          quantity: { amount: 1, scale: 0, unit: "each" },
          reason: {
            kind: "production",
            productionBatchId: "production_batch_oat_milk",
            recipeRevision: 1,
          },
        },
        occurredAt,
        idempotencyKey: "production:production_batch_oat_milk:output:1",
      },
    },
    {
      kind: "inventory_lot",
      resource: {
        id: "lot_production_output",
        lotCode: "COOKIE-20260809-A",
        inventoryItemId: "inventory_cookie",
        locationId: "location_nuki_cafe",
        revision: 1,
        sourceMovementId: "movement_production_output",
        receivedQuantity: { amount: 1, scale: 0, unit: "each" },
        remainingQuantity: { amount: 1, scale: 0, unit: "each" },
        expiry: { kind: "expires", expiresAt: "2026-08-16T00:00:00.000Z" },
        lifecycle: { state: "available" },
        occurredAt,
      },
    },
    {
      kind: "production_batch",
      resource: {
        provenance: {
          organisationId: ORGANISATION_ID.ok
            ? ORGANISATION_ID.value
            : "organisation_underclerk_low_stock",
          integrationAccountId: INTEGRATION_ACCOUNT_ID.ok
            ? INTEGRATION_ACCOUNT_ID.value
            : "integration_underclerk_low_stock",
          source: "underclerk",
          resourceType: "production_batch",
          resourceId: "production_batch_oat_milk",
          revision: 1,
          occurredAt,
          observedAt: occurredAt,
        },
        productionBatchId: "production_batch_oat_milk",
        demand: { kind: "stock" },
        recipeId: "recipe_cookie",
        recipeRevision: 1,
        locationId: "location_nuki_cafe",
        stationId: "station_oven",
        revision: 1,
        plannedYield: { amount: 1, scale: 0, unit: "each" },
        actualYield: { amount: 1, scale: 0, unit: "each" },
        completedAt: occurredAt,
        inputMovementIds: ["movement_production_input"],
        outputMovementId: "movement_production_output",
        outputLotId: "lot_production_output",
      },
    },
  );
  return {
    ...base,
    deliveryId: "delivery_production_batch_oat_milk",
    merchantRevision: 6,
    observations,
  };
}

function stockPolicyOutOfOrderFirstDelivery(): CommerceDeliveryV1 {
  const base = stockPolicyDecreaseDelivery(
    "delivery_oat_latte_later",
    "movement_oat_latte_second",
    3,
    7_400,
    600,
  );
  const resources = stockPolicyCrossingDelivery().observations.slice(0, 2);
  return {
    ...base,
    observations: [...resources, ...base.observations],
  };
}

function stockPolicyDecreaseDelivery(
  deliveryId: string,
  movementId: string,
  positionRevision: number,
  availableAmount: number,
  movementAmount: number,
): CommerceDeliveryV1 {
  return stockPolicyMovementDelivery(
    deliveryId,
    movementId,
    positionRevision,
    availableAmount,
    {
      kind: "decrease",
      quantity: { amount: movementAmount, scale: 0, unit: "milliliter" },
      reason: {
        kind: "preparation",
        ticketId: "ticket_oat_latte",
        recipeRevision: 1,
      },
      lotAllocation: {
        kind: "allocated",
        lots: [
          {
            lotId: "lot_receipt_line_oat_milk_accepted",
            quantity: { amount: movementAmount, scale: 0, unit: "milliliter" },
          },
        ],
      },
    },
  );
}

function stockPolicyIncreaseDelivery(
  deliveryId: string,
  movementId: string,
  positionRevision: number,
  availableAmount: number,
  movementAmount: number,
): CommerceDeliveryV1 {
  return stockPolicyMovementDelivery(
    deliveryId,
    movementId,
    positionRevision,
    availableAmount,
    {
      kind: "increase",
      quantity: { amount: movementAmount, scale: 0, unit: "milliliter" },
      reason: {
        kind: "receipt",
        purchase: { kind: "unlinked" },
        receiptId: `receipt_${movementId}`,
        receiptLineId: `receipt_line_${movementId}`,
      },
    },
  );
}

function stockPolicyMovementDelivery(
  deliveryId: string,
  movementId: string,
  positionRevision: number,
  availableAmount: number,
  change: CommerceInventoryMovementV1["change"],
): CommerceDeliveryV1 {
  const occurredAt = "2026-08-09T00:00:00Z";
  return {
    schemaVersion: "underclerk.commerce-delivery.v1",
    deliveryId,
    organisationId: ORGANISATION_ID.ok
      ? ORGANISATION_ID.value
      : "organisation_underclerk_low_stock",
    merchantId: "merchant_nuki_cafe",
    merchantRevision: positionRevision,
    observedAt: occurredAt,
    observations: [
      {
        kind: "inventory_position",
        resource: {
          id: "position_oat_milk_cafe",
          revision: positionRevision,
          inventoryItemId: "inventory_oat_milk",
          locationId: "location_nuki_cafe",
          balance: {
            kind: "accounted",
            onHand: { amount: availableAmount, scale: 0, unit: "milliliter" },
            allocated: { amount: 0, scale: 0, unit: "milliliter" },
            available: {
              amount: availableAmount,
              scale: 0,
              unit: "milliliter",
            },
          },
          occurredAt,
        },
      },
      {
        kind: "inventory_movement",
        resource: {
          id: movementId,
          inventoryItemId: "inventory_oat_milk",
          locationId: "location_nuki_cafe",
          change,
          occurredAt,
          idempotencyKey: `scenario_cafe_patisserie_v2:${movementId}:1`,
        },
      },
    ],
    signer: {
      keyId: "key_underclerk_low_stock",
      algorithm: "ed25519",
      signature: "signature",
    },
  };
}

async function requireNormalizedCommerceDelivery(
  delivery: CommerceDeliveryV1,
) {
  if (!ORGANISATION_ID.ok || !INTEGRATION_ACCOUNT_ID.ok)
    throw new Error("invalid inventory fixture identity");
  const normalized = await normalizeCommerceEngineDelivery({
    delivery,
    organisationId: ORGANISATION_ID.value,
    merchantId: "merchant_nuki_cafe",
    integrationAccountId: INTEGRATION_ACCOUNT_ID.value,
    verifier: ACCEPT_ALL_COMMERCE_DELIVERIES,
  });
  if (!normalized.ok) throw new Error(normalized.error);
  if (normalized.kind !== "aggregate")
    throw new Error("expected aggregate delivery");
  return normalized.delivery;
}

function oatOpeningDelivery(): CommerceDeliveryV1 {
  const occurredAt = "2026-08-14T09:00:00Z";
  return {
    schemaVersion: "underclerk.commerce-delivery.v1",
    deliveryId: "delivery_oat_opening",
    organisationId: ORGANISATION_ID.ok
      ? ORGANISATION_ID.value
      : "organisation_underclerk_low_stock",
    merchantId: "merchant_nuki_cafe",
    merchantRevision: 2,
    observedAt: occurredAt,
    observations: [
      {
        kind: "inventory_item",
        resource: {
          id: "inventory_oat_milk",
          revision: 1,
          merchantCode: "OAT-MILK",
          name: "Oat milk",
          baseUnit: "milliliter",
          category: "ingredient",
          tracking: { kind: "lot_tracked", expiry: "required" },
          lifecycle: "active",
          occurredAt,
        },
      },
      {
        kind: "inventory_position",
        resource: {
          id: "position_oat_milk_cafe",
          revision: 1,
          inventoryItemId: "inventory_oat_milk",
          locationId: "location_nuki_cafe",
          balance: {
            kind: "accounted",
            onHand: { amount: 0, scale: 0, unit: "milliliter" },
            allocated: { amount: 0, scale: 0, unit: "milliliter" },
            available: { amount: 0, scale: 0, unit: "milliliter" },
          },
          occurredAt,
        },
      },
      {
        kind: "inventory_item",
        resource: {
          id: "inventory_cookie",
          revision: 1,
          merchantCode: "COOKIE",
          name: "Cookie",
          baseUnit: "each",
          category: "finished_good",
          tracking: { kind: "lot_tracked", expiry: "required" },
          lifecycle: "active",
          occurredAt,
        },
      },
      {
        kind: "inventory_position",
        resource: {
          id: "position_cookie_cafe",
          revision: 1,
          inventoryItemId: "inventory_cookie",
          locationId: "location_nuki_cafe",
          balance: {
            kind: "accounted",
            onHand: { amount: 0, scale: 0, unit: "each" },
            allocated: { amount: 0, scale: 0, unit: "each" },
            available: { amount: 0, scale: 0, unit: "each" },
          },
          occurredAt,
        },
      },
    ],
    signer: {
      keyId: "key_underclerk_low_stock",
      algorithm: "ed25519",
      signature: "signature",
    },
  };
}

function oatReceiptDelivery(): CommerceDeliveryV1 {
  const occurredAt = "2026-08-14T09:30:00Z";
  return {
    schemaVersion: "underclerk.commerce-delivery.v1",
    deliveryId: "delivery_oat_receipt",
    organisationId: ORGANISATION_ID.ok
      ? ORGANISATION_ID.value
      : "organisation_underclerk_low_stock",
    merchantId: "merchant_nuki_cafe",
    merchantRevision: 3,
    observedAt: occurredAt,
    observations: [
      {
        kind: "inventory_position",
        resource: {
          id: "position_oat_milk_cafe",
          revision: 2,
          inventoryItemId: "inventory_oat_milk",
          locationId: "location_nuki_cafe",
          balance: {
            kind: "accounted",
            onHand: { amount: 8_000, scale: 0, unit: "milliliter" },
            allocated: { amount: 0, scale: 0, unit: "milliliter" },
            available: { amount: 8_000, scale: 0, unit: "milliliter" },
          },
          occurredAt,
        },
      },
      {
        kind: "inventory_movement",
        resource: {
          id: "movement_oat_receipt_20260814",
          inventoryItemId: "inventory_oat_milk",
          locationId: "location_nuki_cafe",
          change: {
            kind: "increase",
            quantity: { amount: 8_000, scale: 0, unit: "milliliter" },
            reason: {
              kind: "receipt",
              purchase: { kind: "unlinked" },
              receiptId: "receipt_oat_milk",
              receiptLineId: "receipt_line_oat_milk_accepted",
            },
          },
          occurredAt,
          idempotencyKey: "scenario_cafe_patisserie_v2:receive_oat_milk:1",
        },
      },
      {
        kind: "inventory_lot",
        resource: {
          id: "lot_receipt_line_oat_milk_accepted",
          lotCode: "OAT-20260814-A",
          inventoryItemId: "inventory_oat_milk",
          locationId: "location_nuki_cafe",
          revision: 1,
          sourceMovementId: "movement_oat_receipt_20260814",
          receivedQuantity: { amount: 8_000, scale: 0, unit: "milliliter" },
          remainingQuantity: { amount: 8_000, scale: 0, unit: "milliliter" },
          expiry: { kind: "expires", expiresAt: "2026-08-21T00:00:00.000Z" },
          lifecycle: { state: "available" },
          occurredAt,
        },
      },
    ],
    signer: {
      keyId: "key_underclerk_low_stock",
      algorithm: "ed25519",
      signature: "signature",
    },
  };
}

async function clearFixtureAlarm(): Promise<void> {}
