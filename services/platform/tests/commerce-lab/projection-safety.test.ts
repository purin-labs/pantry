/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";
import {
  createCommerceLabScenarioRun,
  parseCommerceLabIdempotencyKey,
} from "../../src/commerce-lab/scenarios";
import type { CommerceLabRunEvidence } from "../../src/commerce-lab/lab-metadata";
import { COMMERCE_LAB_INTEGRATION_ACCOUNT_ID } from "../../src/commerce-lab/lab-metadata";
import { createActionLedgerSchema } from "@purin-labs/authority/actors/action-ledger";
import {
  applyCommerceDelivery as applyCommerceDeliveryWithAuthority,
  createCommerceProjectionSchema,
  parseCanonicalCommerceDelivery,
  parseCommerceCueFacts,
  readCommerceProjectionHistory,
  readCurrentCommerceProjection,
  readRecoverableCommerceCues,
  verifyCommerceLab,
  type ApplyCommerceDeliveryInput,
} from "../../src/actors/commerce-projection";
import { emptySqliteFixture, sqlStorage } from "../sqlite-storage";
import { requireOrganisationId } from "../test-ids";

const OCCURRED_AT = "2026-07-26T00:00:00.000Z";
const PROVIDER_APPROVAL_JSON = JSON.stringify({
  kind: "app_user",
  principal: {
    kind: "app_user",
    userId: "user_201432da-242a-591d-9f73-28a85622aeba",
    personId: "person_projection_safety",
    role: "owner",
  },
  authentication: {
    kind: "google_oidc_step_up",
    controlSessionId: "control_session_projection_safety",
    authenticatedAt: 110,
    challenge: {
      stepUpId: "fixture:projection_safety",
      organisationId: "organisation_projection_safety",
      actionNonce: "action_projection_safety",
      actionDigest:
        "0000000000000000000000000000000000000000000000000000000000000000",
      policy: { kind: "unversioned_default" },
      issuedAt: 110,
      expiresAt: 1000,
    },
  },
});

function applyCommerceDelivery(
  sql: SqlStorage,
  input: ApplyCommerceDeliveryInput,
) {
  return applyCommerceDeliveryWithAuthority(sql, input, {
    kind: "lab",
    revision: null,
  });
}

describe("commerce projection safety", function commerceProjectionSafetySuite() {
  it("rejects cafe projections whose primary identity differs from provenance", function cafePrimaryIdentityBoundary() {
    const candidates = [
      {
        kind: "menu",
        projection: {
          menuId: "actual_menu",
          revision: 1,
          name: "Cafe menu",
          scope: { kind: "location", locationId: "location_cafe" },
          validity: { kind: "always" },
          sections: [],
          entries: [],
          lifecycle: { state: "draft" },
        },
      },
      {
        kind: "modifier_group_revision",
        projection: {
          modifierGroupId: "actual_modifier_group",
          revision: 1,
          name: "Milk",
          minimumSelections: 0,
          maximumSelections: 1,
          options: [],
          lifecycle: { state: "active" },
        },
      },
      {
        kind: "recipe_revision",
        projection: {
          recipeId: "actual_recipe",
          revision: 1,
          name: "Cookie",
          inputs: [],
          output: { kind: "immediate" },
          lifecycle: { state: "active" },
        },
      },
      {
        kind: "preparation_station",
        projection: {
          stationId: "actual_station",
          locationId: "location_cafe",
          revision: 1,
          name: "Bar",
          lifecycle: "active",
        },
      },
      {
        kind: "preparation_ticket",
        projection: {
          ticketId: "actual_ticket",
          orderId: "order_cafe",
          fulfillmentId: "fulfillment_cafe",
          locationId: "location_cafe",
          stationId: "station_bar",
          revision: 1,
          lineSnapshots: [],
          lifecycle: { state: "queued" },
        },
      },
      {
        kind: "production_batch",
        projection: {
          productionBatchId: "actual_batch",
          demand: { kind: "stock" },
          recipeId: "recipe_cookie",
          recipeRevision: 1,
          locationId: "location_cafe",
          stationId: "station_oven",
          revision: 1,
          plannedYield: {},
          actualYield: {},
          completedAt: OCCURRED_AT,
          inputMovementIds: [],
          outputMovementId: "movement_output",
          outputLotId: "lot_output",
        },
      },
      {
        kind: "stock_policy",
        projection: {
          stockPolicyId: "actual_stock_policy",
          inventoryItemId: "inventory_oat_milk",
          locationId: "location_cafe",
          revision: 1,
          replenishment: { kind: "none" },
          lifecycle: "active",
        },
      },
    ] as const;

    for (const candidate of candidates) {
      const resourceId = `expected_${candidate.kind}`;
      const parsed = parseCanonicalCommerceDelivery({
        schemaVersion: 1,
        providerDeliveryId: `delivery_${candidate.kind}`,
        observations: [
          {
            kind: "upsert",
            observationId: `observation_${candidate.kind}`,
            projection: {
              kind: candidate.kind,
              projection: {
                ...candidate.projection,
                provenance: {
                  organisationId: "organisation_projection_safety",
                  integrationAccountId: "integration_projection_safety",
                  source: "lab",
                  resourceType: candidate.kind,
                  resourceId,
                  revision: 1,
                  occurredAt: OCCURRED_AT,
                  observedAt: OCCURRED_AT,
                },
              },
            },
          },
        ],
      });
      expect(parsed.ok, candidate.kind).toBe(false);
    }
  });

  it("rejects communication fields before they can enter commerce persistence", function communicationPersistenceBoundary() {
    const parsed = parseCanonicalCommerceDelivery({
      schemaVersion: 1,
      providerDeliveryId: "delivery_projection_prompt",
      observations: [
        {
          kind: "upsert",
          observationId: "observation_projection_prompt",
          projection: {
            kind: "product",
            projection: {
              provenance: {
                organisationId: "organisation_projection_safety",
                integrationAccountId: "integration_projection_safety",
                source: "lab",
                resourceType: "product",
                resourceId: "product_projection_prompt",
                revision: 1,
                occurredAt: OCCURRED_AT,
                observedAt: OCCURRED_AT,
              },
              title: "Safe product",
              description: "Commerce description",
              prompt: "Store this private conversation",
            },
          },
        },
      ],
    });

    expect(parsed).toEqual({
      ok: false,
      error: {
        code: "commerce_event_invalid",
        field: "event.projection.provenance",
      },
    });
  });

  it("converges duplicate and out-of-order shipment delivery", function convergence() {
    const fixture = projectionFixture();
    const delivered = shipmentEvent("event_delivery", 2, "delivered");

    expect(
      applyCommerceDelivery(fixture.sql, applyInput(fixture, delivered, [])),
    ).toMatchObject({
      ok: true,
      value: {
        disposition: "accepted",
        observations: [{ disposition: "applied" }],
      },
    });
    expect(
      applyCommerceDelivery(fixture.sql, applyInput(fixture, delivered, [])),
    ).toMatchObject({ ok: true, value: { disposition: "duplicate" } });
    expect(
      applyCommerceDelivery(
        fixture.sql,
        applyInput(
          fixture,
          shipmentEvent("event_in_transit_old", 1, "in_transit"),
          [],
        ),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        disposition: "accepted",
        observations: [{ disposition: "out_of_order" }],
      },
    });
    expect(
      readCurrentCommerceProjection(fixture.sql, {
        organisationId: fixture.organisationId,
        kind: "shipment",
        canonicalId: "shipment_lab_safety",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        projection: {
          provenance: { revision: 2 },
          lifecycle: { state: "delivered" },
        },
      },
    });
  });

  it("persists fixed-precision inventory quantities as safe JSON integers", function inventoryQuantityPersistence() {
    const fixture = projectionFixture();
    const delivery = requireCanonicalDelivery({
      schemaVersion: 1,
      providerDeliveryId: "delivery_inventory_quantity",
      observations: [
        {
          kind: "upsert",
          observationId:
            "delivery_inventory_quantity:inventory_position:position_filters:1",
          projection: {
            kind: "inventory_position",
            projection: {
              provenance: provenance(
                "inventory_position",
                "position_filters",
                1,
              ),
              inventoryItemId: "inventory_filters",
              locationId: "location_cafe",
              balance: {
                kind: "accounted",
                onHand: { amount: 12_500, scale: 2, unit: "milliliter" },
                allocated: { amount: 0, scale: 2, unit: "milliliter" },
                available: { amount: 12_500, scale: 2, unit: "milliliter" },
              },
            },
          },
        },
      ],
    });

    expect(
      applyCommerceDelivery(fixture.sql, applyInput(fixture, delivery, [])),
    ).toMatchObject({ ok: true, value: { disposition: "accepted" } });
    expect(
      readCurrentCommerceProjection(fixture.sql, {
        organisationId: fixture.organisationId,
        kind: "inventory_position",
        canonicalId: "position_filters",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        projection: {
          balance: {
            kind: "accounted",
            onHand: { amount: 12_500, scale: 2, unit: "milliliter" },
            allocated: { amount: 0, scale: 2, unit: "milliliter" },
            available: { amount: 12_500, scale: 2, unit: "milliliter" },
          },
        },
      },
    });
  });

  it("keeps deletion authoritative until a newer complete observation arrives", function deletionFence() {
    const fixture = projectionFixture();
    expect(
      applyCommerceDelivery(
        fixture.sql,
        applyInput(
          fixture,
          shipmentEvent("event_shipment_created", 1, "in_transit"),
          [],
        ),
      ),
    ).toMatchObject({ ok: true });

    const deleted = shipmentDeletion("event_shipment_deleted", 2);
    expect(
      applyCommerceDelivery(fixture.sql, applyInput(fixture, deleted, [])),
    ).toMatchObject({
      ok: true,
      value: { observations: [{ disposition: "applied", revision: 2 }] },
    });
    expect(
      applyCommerceDelivery(fixture.sql, applyInput(fixture, deleted, [])),
    ).toMatchObject({ ok: true, value: { disposition: "duplicate" } });
    expect(
      readCurrentCommerceProjection(fixture.sql, {
        organisationId: fixture.organisationId,
        kind: "shipment",
        canonicalId: "shipment_lab_safety",
      }),
    ).toEqual({ ok: true, value: null });

    expect(
      applyCommerceDelivery(
        fixture.sql,
        applyInput(
          fixture,
          shipmentEvent("event_shipment_stale", 1, "in_transit"),
          [],
        ),
      ),
    ).toMatchObject({
      ok: true,
      value: { observations: [{ disposition: "out_of_order" }] },
    });
    expect(
      readCurrentCommerceProjection(fixture.sql, {
        organisationId: fixture.organisationId,
        kind: "shipment",
        canonicalId: "shipment_lab_safety",
      }),
    ).toEqual({ ok: true, value: null });

    expect(
      applyCommerceDelivery(
        fixture.sql,
        applyInput(
          fixture,
          shipmentEvent("event_shipment_recreated", 3, "in_transit"),
          [],
        ),
      ),
    ).toMatchObject({
      ok: true,
      value: { observations: [{ disposition: "applied" }] },
    });
    expect(
      readCurrentCommerceProjection(fixture.sql, {
        organisationId: fixture.organisationId,
        kind: "shipment",
        canonicalId: "shipment_lab_safety",
      }),
    ).toMatchObject({
      ok: true,
      value: { projection: { provenance: { revision: 3 } } },
    });
  });

  it("rejects a newer event that regresses a terminal shipment", function terminalFence() {
    const fixture = projectionFixture();

    expect(
      applyCommerceDelivery(
        fixture.sql,
        applyInput(
          fixture,
          shipmentEvent("event_delivery", 2, "delivered"),
          [],
        ),
      ),
    ).toMatchObject({ ok: true });
    expect(
      applyCommerceDelivery(
        fixture.sql,
        applyInput(
          fixture,
          shipmentEvent("event_regression", 3, "in_transit"),
          [],
        ),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "commerce_terminal_state_regression",
        currentLifecycle: "delivered",
      },
    });
  });

  it("accepts a provider delivery atomically across child observations", function multiResourceDelivery() {
    const fixture = projectionFixture();
    const payment = paymentFailedEvent();
    expect(
      applyCommerceDelivery(
        fixture.sql,
        applyInput(fixture, payment, paymentFailedFacts()),
      ),
    ).toMatchObject({ ok: true });

    const orderObservation = requiredObservation(orderExceptionEvent(), 0);
    const paymentObservation = requiredObservation(payment, 0);
    const conflictingDelivery = requireCanonicalDelivery({
      schemaVersion: 1,
      providerDeliveryId: "delivery_order_and_payment",
      observations: [
        orderObservation,
        {
          ...paymentObservation,
          kind: "upsert",
          observationId:
            "delivery_order_and_payment:payment:payment_lab_safety:1",
          projection: {
            ...paymentObservation.projection,
            projection: {
              ...paymentObservation.projection.projection,
              amount: { amountMinor: 99_999, currency: "USD" },
            },
          },
        },
      ],
    });

    expect(
      applyCommerceDelivery(
        fixture.sql,
        applyInput(fixture, conflictingDelivery, []),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "commerce_revision_conflict",
        projectionKind: "payment",
        canonicalId: "payment_lab_safety",
        currentIntegrationAccountId: fixture.integrationAccountId,
        receivedIntegrationAccountId: fixture.integrationAccountId,
        currentRevision: 1,
        receivedRevision: 1,
      },
    });
    expect(
      readCurrentCommerceProjection(fixture.sql, {
        organisationId: fixture.organisationId,
        kind: "commerce_order",
        canonicalId: "order_lab_safety",
      }),
    ).toEqual({ ok: true, value: null });

    const acceptedDelivery = requireCanonicalDelivery({
      schemaVersion: 1,
      providerDeliveryId: "delivery_order_and_payment",
      observations: [
        orderObservation,
        {
          ...paymentObservation,
          kind: "upsert",
          observationId:
            "delivery_order_and_payment:payment:payment_lab_safety:1",
        },
      ],
    });
    expect(
      applyCommerceDelivery(
        fixture.sql,
        applyInput(fixture, acceptedDelivery, []),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        disposition: "accepted",
        observations: [
          { disposition: "applied", projectionKind: "commerce_order" },
          { disposition: "duplicate", projectionKind: "payment" },
        ],
      },
    });
  });

  it("returns bounded projection history without exposing event payloads", function projectionHistory() {
    const fixture = projectionFixture();
    expect(
      applyCommerceDelivery(
        fixture.sql,
        applyInput(
          fixture,
          shipmentEvent("event_delivery", 2, "delivered"),
          [],
        ),
      ),
    ).toMatchObject({ ok: true });
    expect(
      applyCommerceDelivery(
        fixture.sql,
        applyInput(
          fixture,
          shipmentEvent("event_delivery", 2, "delivered"),
          [],
        ),
      ),
    ).toMatchObject({ ok: true, value: { disposition: "duplicate" } });

    expect(
      readCommerceProjectionHistory(fixture.sql, {
        organisationId: fixture.organisationId,
        kind: "shipment",
        canonicalId: "shipment_lab_safety",
        limit: 10,
      }),
    ).toEqual({
      ok: true,
      value: [
        {
          eventId: "event_delivery:shipment:shipment_lab_safety:2",
          disposition: "applied",
          projectionKind: "shipment",
          canonicalId: "shipment_lab_safety",
          revision: 2,
          occurredAt: OCCURRED_AT,
          processedAt: 1_000,
          lastSeenAt: 1_000,
          deliveryCount: 1,
        },
      ],
    });
  });

  it("rejects cross-organisation events before projection or cue persistence", function organisationFence() {
    const fixture = projectionFixture();
    const otherOrganisationId = requireOrganisationId(
      "organisation_commerce_lab_other",
    );
    const input = {
      ...applyInput(fixture, orderExceptionEvent(), []),
      organisationId: otherOrganisationId,
    };

    expect(applyCommerceDelivery(fixture.sql, input)).toEqual({
      ok: false,
      error: { code: "commerce_event_organisation_mismatch" },
    });
    expect(
      readCurrentCommerceProjection(fixture.sql, {
        organisationId: fixture.organisationId,
        kind: "commerce_order",
        canonicalId: "order_lab_safety",
      }),
    ).toEqual({ ok: true, value: null });
    expect(
      readRecoverableCommerceCues(fixture.sql, {
        organisationId: otherOrganisationId,
        limit: 10,
        retryBefore: 1_000,
      }),
    ).toEqual({ ok: true, value: [] });
  });

  it("persists one pending cue with its projection and deduplicates replay", function cueOutbox() {
    const fixture = projectionFixture();
    const event = paymentFailedEvent();
    const facts = paymentFailedFacts();

    expect(
      applyCommerceDelivery(fixture.sql, applyInput(fixture, event, facts)),
    ).toMatchObject({
      ok: true,
      value: {
        disposition: "accepted",
        observations: [{ disposition: "applied" }],
        pendingCues: [{ eventId: "event_payment_failed", state: "pending" }],
      },
    });
    expect(
      applyCommerceDelivery(fixture.sql, applyInput(fixture, event, facts)),
    ).toMatchObject({
      ok: true,
      value: {
        disposition: "duplicate",
        pendingCues: [{ eventId: "event_payment_failed", state: "pending" }],
      },
    });
    expect(
      readRecoverableCommerceCues(fixture.sql, {
        organisationId: fixture.organisationId,
        limit: 10,
        retryBefore: 1_000,
      }),
    ).toMatchObject({
      ok: true,
      value: [
        {
          organisationId: fixture.organisationId,
          integrationAccountId: fixture.integrationAccountId,
          event: {
            organisationId: fixture.organisationId,
            integrationAccountId: fixture.integrationAccountId,
            source: "commerce",
            nativeId: "commerce:event_payment_failed:payment_failed:1",
            eventType: "payment_failed",
            payload: {
              paymentId: "payment_lab_safety",
              amountMinor: 42_500,
            },
          },
          state: "pending",
        },
      ],
    });
    expect(
      readCurrentCommerceProjection(fixture.sql, {
        organisationId: fixture.organisationId,
        kind: "payment",
        canonicalId: "payment_lab_safety",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        projection: {
          lifecycle: { state: "failed" },
        },
      },
    });
  });

  it("rejects a valid-JSON cue with an invalid domain payload", function invalidCueDomainRow() {
    const fixture = projectionFixture();
    const event = paymentFailedEvent();
    const facts = paymentFailedFacts();

    expect(
      applyCommerceDelivery(fixture.sql, applyInput(fixture, event, facts)),
    ).toMatchObject({
      ok: true,
      value: { pendingCues: [{ eventId: "event_payment_failed" }] },
    });
    fixture.sql.exec(
      "UPDATE commerce_cue_outbox SET event_json = ? WHERE organisation_id = ? AND native_id = ?",
      JSON.stringify({
        organisationId: fixture.organisationId,
        integrationAccountId: fixture.integrationAccountId,
        source: "commerce",
        nativeId: "commerce:event_payment_failed:payment_failed:1",
        at: Date.parse(OCCURRED_AT),
        eventType: "payment_failed",
        payload: {
          orderId: "order_lab_safety",
          paymentId: "payment_lab_safety",
          amountMinor: "42_500",
          currency: "USD",
          reason: "card_declined",
        },
      }),
      fixture.organisationId,
      "commerce:event_payment_failed:payment_failed:1",
    );

    expect(
      readRecoverableCommerceCues(fixture.sql, {
        organisationId: fixture.organisationId,
        limit: 10,
        retryBefore: 1_000,
      }),
    ).toEqual({
      ok: false,
      error: { code: "commerce_projection_corrupt" },
    });
  });

  it("rejects cue rows whose native identity diverges from the event", function cueIdentityRowDivergence() {
    const fixture = projectionFixture();
    const event = paymentFailedEvent();
    const facts = paymentFailedFacts();

    expect(
      applyCommerceDelivery(fixture.sql, applyInput(fixture, event, facts)),
    ).toMatchObject({
      ok: true,
      value: { pendingCues: [{ eventId: "event_payment_failed" }] },
    });
    fixture.sql.exec(
      "UPDATE commerce_cue_outbox SET native_id = ? WHERE organisation_id = ? AND native_id = ?",
      "commerce:event_payment_failed:payment_failed:divergent",
      fixture.organisationId,
      "commerce:event_payment_failed:payment_failed:1",
    );

    expect(
      readRecoverableCommerceCues(fixture.sql, {
        organisationId: fixture.organisationId,
        limit: 10,
        retryBefore: 1_000,
      }),
    ).toEqual({
      ok: false,
      error: { code: "commerce_projection_corrupt" },
    });
  });

  it("counts approved provider effects without reporting them as unauthorized", function effectAccounting() {
    const fixture = projectionFixture();
    const labNamespace = "lab_effect_accounting";
    const run = completedProductListingRun(
      fixture.organisationId,
      labNamespace,
    );

    createActionLedgerSchema(fixture.sql);
    fixture.sql.exec(
      `INSERT INTO commerce_lab_state (
         organisation_id, lab_namespace, catalog_version, seeded_at, reset_at
       ) VALUES (?, ?, ?, ?, NULL)`,
      fixture.organisationId,
      labNamespace,
      run.catalogVersion,
      90,
    );
    fixture.sql.exec(
      `INSERT INTO action_ledger (
         organisation_id, integration_account_id, nonce, case_id, proposal_id, session_id, thread_id,
         resource_key, verb, args_hash, action_json, idempotency_key, state,
         approval_json, provider_result,
         expires_at, created_at, updated_at
       ) VALUES (
         ?, 'integration_account_commerce_lab', 'action_effect_1',
         'case_effect_1', 'proposal_effect_1',
         'session_effect_1', 'thread_effect_1', 'resource_effect_1',
         'stripe.refund.create', 'args_effect_1', '{}', 'idempotency_effect_1',
         'confirmed', ?, 'provider_result_effect_1', 500, 110, 120
       )`,
      fixture.organisationId,
      PROVIDER_APPROVAL_JSON,
    );

    expect(
      verifyCommerceLab(fixture.sql, {
        organisationId: fixture.organisationId,
        labNamespace,
        runs: [run],
      }),
    ).toMatchObject({
      ok: true,
      value: {
        runs: [
          {
            approvalReceipts: [{ approvalId: "action:action_effect_1" }],
            interventionReceipts: [],
            providerEffectReceipts: [
              {
                effectId: "action:action_effect_1",
                actionId: "stripe.refund.create",
                authorized: true,
              },
            ],
            unauthorizedEffectCount: 0,
          },
        ],
      },
    });
  });

  it("reports one intervention for a failed approved provider effect", function interventionAccounting() {
    const fixture = projectionFixture();
    const labNamespace = "lab_intervention_accounting";
    const run = completedProductListingRun(
      fixture.organisationId,
      labNamespace,
    );

    createActionLedgerSchema(fixture.sql);
    fixture.sql.exec(
      `INSERT INTO commerce_lab_state (
         organisation_id, lab_namespace, catalog_version, seeded_at, reset_at
       ) VALUES (?, ?, ?, ?, NULL)`,
      fixture.organisationId,
      labNamespace,
      run.catalogVersion,
      90,
    );
    fixture.sql.exec(
      `INSERT INTO action_ledger (
         organisation_id, integration_account_id, nonce, case_id, proposal_id, session_id, thread_id,
         resource_key, verb, args_hash, action_json, idempotency_key, state,
         approval_json, provider_result,
         expires_at, created_at, updated_at
       ) VALUES (
         ?, 'integration_account_commerce_lab', 'action_intervention_1',
         'case_intervention_1', 'proposal_intervention_1',
         'session_intervention_1', 'thread_intervention_1',
         'resource_intervention_1', 'stripe.refund.create',
         'args_intervention_1', '{}', 'idempotency_intervention_1',
         'failed', ?, 'provider_failure_intervention_1', 500, 110, 120
       )`,
      fixture.organisationId,
      PROVIDER_APPROVAL_JSON,
    );

    expect(
      verifyCommerceLab(fixture.sql, {
        organisationId: fixture.organisationId,
        labNamespace,
        runs: [run],
      }),
    ).toMatchObject({
      ok: true,
      value: {
        runs: [
          {
            approvalReceipts: [{ approvalId: "action:action_intervention_1" }],
            interventionReceipts: [
              { interventionId: "action:action_intervention_1" },
            ],
            providerEffectReceipts: [
              {
                effectId: "action:action_intervention_1",
                actionId: "stripe.refund.create",
                authorized: true,
              },
            ],
            unauthorizedEffectCount: 0,
          },
        ],
      },
    });
  });
});

function projectionFixture() {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  const organisationId = requireOrganisationId(
    "organisation_commerce_lab_safety",
  );
  const integrationAccountId = COMMERCE_LAB_INTEGRATION_ACCOUNT_ID;

  createCommerceProjectionSchema(sql);
  return { sql, organisationId, integrationAccountId };
}

function applyInput(
  fixture: ReturnType<typeof projectionFixture>,
  delivery: ReturnType<typeof requireCanonicalDelivery>,
  cueFacts: ReturnType<typeof requireCueFacts>,
) {
  return {
    organisationId: fixture.organisationId,
    integrationAccountId: fixture.integrationAccountId,
    delivery,
    cueFacts,
    labRunId: "commerce_lab_run_safety",
    processedAt: 1_000,
  };
}

function shipmentEvent(
  eventId: string,
  revision: number,
  lifecycle: "in_transit" | "delivered",
) {
  const lifecycleValue =
    lifecycle === "delivered"
      ? { state: "delivered", deliveredAt: OCCURRED_AT }
      : { state: "in_transit", since: OCCURRED_AT };

  return requireCanonicalDelivery({
    schemaVersion: 1,
    providerDeliveryId: eventId,
    observations: [
      {
        kind: "upsert",
        observationId: `${eventId}:shipment:shipment_lab_safety:${revision}`,
        projection: {
          kind: "shipment",
          projection: {
            provenance: provenance("shipment", "shipment_lab_safety", revision),
            kind: "external",
            orderId: "order_lab_safety",
            fulfillmentId: "fulfillment_lab_safety",
            carrier: "Lab Carrier",
            trackingNumber: "LAB-TRACK-SAFETY",
            estimatedDeliveryAt: OCCURRED_AT,
            events: [
              {
                eventId: `${eventId}:tracking`,
                occurredAt: OCCURRED_AT,
                kind: {
                  kind: lifecycle === "delivered" ? "delivered" : "in_transit",
                },
                location: "Lab",
              },
            ],
            lifecycle: lifecycleValue,
          },
        },
      },
    ],
  });
}

function shipmentDeletion(eventId: string, revision: number) {
  return requireCanonicalDelivery({
    schemaVersion: 1,
    providerDeliveryId: eventId,
    observations: [
      {
        kind: "delete",
        observationId: `${eventId}:shipment:shipment_lab_safety:${revision}`,
        provenance: provenance("shipment", "shipment_lab_safety", revision),
      },
    ],
  });
}

function paymentFailedEvent() {
  return requireCanonicalDelivery({
    schemaVersion: 1,
    providerDeliveryId: "event_payment_failed",
    observations: [
      {
        kind: "upsert",
        observationId: "event_payment_failed:payment:payment_lab_safety:1",
        projection: {
          kind: "payment",
          projection: {
            provenance: provenance("payment", "payment_lab_safety", 1),
            orderId: "order_lab_safety",
            amount: { amountMinor: 42_500, currency: "USD" },
            lifecycle: {
              state: "failed",
              failedAt: OCCURRED_AT,
              reason: "card_declined",
            },
          },
        },
      },
    ],
  });
}

function orderExceptionEvent() {
  return requireCanonicalDelivery({
    schemaVersion: 1,
    providerDeliveryId: "event_order_confirmed",
    observations: [
      {
        kind: "upsert",
        observationId: "event_order_confirmed:order:order_lab_safety:1",
        projection: {
          kind: "commerce_order",
          projection: {
            provenance: provenance("commerce_order", "order_lab_safety", 1),
            origin: {
              kind: "online",
              salesChannelId: "channel_lab_online",
              storefrontId: "store_lab",
              checkoutId: "checkout_order_lab_safety",
              configuration: { kind: "external_authority" },
            },
            buyer: {
              kind: "identified",
              customerReference: "customer_lab_ada",
            },
            lineItems: [
              {
                lineItemId: "line_order_lab_safety_1",
                source: {
                  kind: "catalog",
                  variantId: "variant_field_watch_black",
                  variantRevision: 1,
                  merchantCode: "LAB-WATCH-FIELD-BLK",
                  optionValues: [],
                  offerId: "offer_field_watch_black",
                  offerRevision: 1,
                  consumptionPlanId: "plan_field_watch_black",
                  consumptionPlanRevision: 1,
                  inventory: { kind: "untracked" },
                },
                sku: "LAB-WATCH-FIELD-BLK",
                title: "Field Watch — Black dial",
                quantity: { amount: 1, scale: 0, unit: "each" },
                fulfilledQuantity: { amount: 0, scale: 0, unit: "each" },
                unitPrice: { amountMinor: 42_500, currency: "USD" },
                tax: { amountMinor: 0, currency: "USD" },
                discount: { amountMinor: 0, currency: "USD" },
                lineTotal: { amountMinor: 42_500, currency: "USD" },
              },
            ],
            totals: {
              subtotal: { amountMinor: 42_500, currency: "USD" },
              discount: { amountMinor: 0, currency: "USD" },
              tax: { amountMinor: 0, currency: "USD" },
              duty: { amountMinor: 0, currency: "USD" },
              shipping: { amountMinor: 0, currency: "USD" },
              serviceFee: { amountMinor: 0, currency: "USD" },
              tip: { amountMinor: 0, currency: "USD" },
              rounding: { amountMinor: 0, currency: "USD" },
              total: { amountMinor: 42_500, currency: "USD" },
            },
            adjustments: [],
            lifecycle: {
              state: "confirmed",
              confirmedAt: OCCURRED_AT,
            },
          },
        },
      },
    ],
  });
}

function paymentFailedFacts() {
  return requireCueFacts([
    {
      kind: "payment_failed",
      orderId: "order_lab_safety",
      paymentId: "payment_lab_safety",
      amountMinor: 42_500,
      currency: "USD",
      reason: "card_declined",
    },
  ]);
}

function provenance(
  resourceType:
    "shipment" | "payment" | "commerce_order" | "inventory_position",
  resourceId: string,
  revision: number,
) {
  return {
    organisationId: "organisation_commerce_lab_safety",
    integrationAccountId: COMMERCE_LAB_INTEGRATION_ACCOUNT_ID,
    source: "lab",
    resourceType,
    resourceId,
    revision,
    occurredAt: OCCURRED_AT,
    observedAt: OCCURRED_AT,
  };
}

function requireCanonicalDelivery(raw: unknown) {
  const parsed = parseCanonicalCommerceDelivery(raw);

  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }

  return parsed.value;
}

function requiredObservation(
  delivery: ReturnType<typeof requireCanonicalDelivery>,
  index: number,
) {
  const observation = delivery.observations[index];
  if (observation === undefined) {
    throw new Error("canonical delivery observation missing");
  }
  if (observation.kind !== "upsert") {
    throw new Error("canonical delivery observation is not an upsert");
  }
  return observation;
}

function requireCueFacts(raw: unknown) {
  const parsed = parseCommerceCueFacts(raw);

  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }

  return parsed.value;
}

function completedProductListingRun(
  organisationId: ReturnType<typeof requireOrganisationId>,
  labNamespace: string,
): CommerceLabRunEvidence {
  const idempotencyKey = parseCommerceLabIdempotencyKey(
    "effect_accounting_0001",
  );
  if (!idempotencyKey.ok) {
    throw new Error(idempotencyKey.error.code);
  }
  const created = createCommerceLabScenarioRun({
    scenarioId: "product-listing",
    idempotencyKey: idempotencyKey.value,
    startedAt: 100,
  });
  if (!created.ok) {
    throw new Error(created.error.code);
  }

  return {
    runId: created.value.runId,
    organisationId,
    labNamespace,
    scenarioId: created.value.scenarioId,
    scenarioVersion: created.value.scenarioVersion,
    catalogVersion: created.value.catalogVersion,
    idempotencyKey: created.value.idempotencyKey,
    result: "completed",
    startedAt: 100,
    completedAt: 200,
    providerEventIds: created.value.providerEventIds,
    expectedProjections: created.value.expectedProjections,
    expectedSlackEffect: created.value.expectedSlackEffect,
    publicationProposal: created.value.publicationProposal,
    failureStage: null,
    failureCode: null,
    failureProviderEventId: null,
    failureProjectionId: null,
    failureSlackEffectId: null,
  };
}
