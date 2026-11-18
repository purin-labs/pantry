/// <reference types="@cloudflare/workers-types" />

import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  createCommerceProjectionSchema,
  parseCanonicalCommerceDelivery,
  resetCommerceLab,
  seedCommerceLab,
} from "../../src/actors/commerce-projection";
import { createCueDeliverySchema } from "../../src/actors/cue-delivery";
import { emptySqliteFixture, sqlStorage } from "../sqlite-storage";
import {
  requireIntegrationAccountId,
  requireOrganisationId,
} from "../test-ids";

describe("commerce lab projection reset", function commerceLabResetSuite() {
  it("refuses unmarked organisations and namespace mismatches", function resetFence() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    const organisationId = requireOrganisationId("organisation_T0BGQSSG45N");

    createCommerceProjectionSchema(sql);
    createCueDeliverySchema(sql);

    expect(
      resetCommerceLab(sql, {
        organisationId,
        labNamespace: "lab_acceptance",
        resetAt: 1_000,
      }),
    ).toEqual({
      ok: false,
      error: { code: "commerce_lab_state_missing" },
    });

    sql.exec(
      `INSERT INTO commerce_lab_state (
         organisation_id, lab_namespace, catalog_version, seeded_at, reset_at
       ) VALUES (?, ?, ?, ?, NULL)`,
      organisationId,
      "lab_acceptance",
      "2026-07-26.2",
      900,
    );

    expect(
      resetCommerceLab(sql, {
        organisationId,
        labNamespace: "lab_other",
        resetAt: 1_000,
      }),
    ).toEqual({
      ok: false,
      error: { code: "commerce_lab_namespace_mismatch" },
    });
    expect(
      resetCommerceLab(sql, {
        organisationId,
        labNamespace: "lab_acceptance",
        resetAt: 1_000,
      }),
    ).toEqual({ ok: true, value: null });
  });

  it("recreates the exact canonical state after reset and the same seed", function deterministicResetSeed() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    const organisationId = requireOrganisationId(
      "organisation_commerce_lab_repeatable_seed",
    );
    const seed = commerceLabSeed(organisationId);

    createCommerceProjectionSchema(sql);
    createCueDeliverySchema(sql);
    expect(seedCommerceLab(sql, seed)).toMatchObject({ ok: true });
    insertProviderProjection(fixture.database, organisationId);
    insertLabCueDelivery(fixture.database, organisationId);

    expect(
      resetCommerceLab(sql, {
        organisationId,
        labNamespace: seed.labNamespace,
        resetAt: 2_000,
      }),
    ).toEqual({ ok: true, value: null });
    expect(commerceProjectionCount(fixture.database)).toBe(1);
    expect(providerProjectionCount(fixture.database)).toBe(1);
    expect(commerceLabCueDeliveryCount(fixture.database)).toBe(0);

    expect(seedCommerceLab(sql, seed)).toMatchObject({ ok: true });
    expect(commerceProjectionCount(fixture.database)).toBe(2);
    expect(providerProjectionCount(fixture.database)).toBe(1);
  });
});

function insertProviderProjection(
  database: DatabaseSync,
  organisationId: string,
): void {
  database
    .prepare(
      `INSERT INTO commerce_projection (
       organisation_id, projection_kind, canonical_id, integration_account_id,
       revision, lifecycle, projection_json, updated_at, validated_at, lab_run_id
     ) VALUES (?, 'product', 'underclerk:merchant_demo:product_1',
       'integration_underclerk_demo', 1, 'active', ?, 1000, 1000, NULL)`,
    )
    .run(
      organisationId,
      JSON.stringify({
        kind: "product",
        projection: {
          provenance: {
            organisationId,
            integrationAccountId: "integration_underclerk_demo",
            source: "underclerk",
            resourceType: "product",
            resourceId: "underclerk:merchant_demo:product_1",
            revision: 1,
            occurredAt: "2026-07-26T00:00:00Z",
            observedAt: "2026-07-26T00:00:00Z",
          },
          title: "Provider product",
          description: "Preserved across a lab reset.",
        },
      }),
    );
}

function providerProjectionCount(database: DatabaseSync): number {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count FROM commerce_projection
     WHERE integration_account_id = 'integration_underclerk_demo'`,
    )
    .get() as { readonly count: number | bigint };
  return Number(row.count);
}

function insertLabCueDelivery(
  database: DatabaseSync,
  organisationId: string,
): void {
  database
    .prepare(
      `INSERT INTO cue_delivery (
       organisation_id, cue_id, dedup_key, subscription_id, source, native_id,
       state, outcome, lease_id, lease_expires_at, claimed_at,
       delivered_at
     ) VALUES (?, ?, ?, ?, 'commerce', ?, 'delivered', 'proposed',
       NULL, NULL, ?, ?)`,
    )
    .run(
      organisationId,
      "cue_lab_previous_run",
      "cue_lab_previous_run_dedup",
      "onboarding-commerce-payment-failed",
      "commerce:commerce_lab_run_payment-failed_previous:event:1",
      1_000,
      1_000,
    );
}

function commerceLabCueDeliveryCount(database: DatabaseSync): number {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count FROM cue_delivery
     WHERE source = 'commerce'
       AND native_id LIKE 'commerce:commerce_lab_run_%'`,
    )
    .get() as { count: number };
  return row.count;
}

function commerceLabSeed(
  organisationId: ReturnType<typeof requireOrganisationId>,
) {
  const integrationAccountId = requireIntegrationAccountId(
    "integration_commerce_lab_repeatable_seed",
  );
  const occurredAt = "2026-07-26T00:00:00Z";
  const delivery = parseCanonicalCommerceDelivery({
    schemaVersion: 1,
    providerDeliveryId: "commerce_lab_seed_catalog_product_field_watch",
    observations: [
      {
        kind: "upsert",
        observationId:
          "commerce_lab_seed_catalog_product_field_watch:catalog_item:product_field_watch:1",
        projection: {
          kind: "product",
          projection: {
            provenance: {
              organisationId,
              integrationAccountId,
              source: "lab",
              resourceType: "product",
              resourceId: "product_field_watch",
              revision: 1,
              occurredAt,
              observedAt: occurredAt,
            },
            title: "Field Watch",
            description: "Synthetic automatic field watch.",
          },
        },
      },
    ],
  });
  if (!delivery.ok) {
    throw new Error(delivery.error.code);
  }

  return {
    organisationId,
    labNamespace: "lab_repeatable_seed",
    catalogVersion: "2026-07-26.2",
    seededAt: 1_000,
    events: [
      {
        organisationId,
        integrationAccountId,
        delivery: delivery.value,
        cueFacts: [],
        labRunId: "commerce_lab_seed_2026_07_26_1",
        processedAt: 1_000,
      },
    ],
  };
}

function commerceProjectionCount(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM commerce_projection")
    .get() as { readonly count: number | bigint };
  return Number(row.count);
}
