import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { parsePointOfSaleConfiguration } from "@purin-labs/commerce-client";

import { NodeCommerceDatabase } from "../src/node-database.ts";
import { PointOfSaleConfigurationService } from "../src/point-of-sale-configuration-service.ts";
import { readPointOfSaleConfigurationForCheckout } from "../src/point-of-sale-configuration-persistence.ts";
import { initializeCommerceSchema } from "../src/schema.ts";

const AT = "2026-09-05T00:00:00.000Z";
const LATER = "2026-09-05T01:00:00.000Z";
const MERCHANT = "merchant_counter";

let database: NodeCommerceDatabase;
let databasePath: string;
let service: PointOfSaleConfigurationService;

function configuration(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    configurationId: "pos_configuration_counter",
    organisationId: "organisation_counter",
    merchantId: MERCHANT,
    pantryLocationId: "location_cafe",
    salesChannelId: "channel_cafe",
    currency: "JPY",
    supportedItems: [
      { variantId: "variant_cookie_single", maxQuantityPerLine: 5 },
    ],
    quoteTtlSeconds: 900,
    tax: { kind: "percentage", basisPoints: 1_000 },
    pickupReadyLeadTimeSeconds: 0,
    afterSalePolicy: {
      cancellationPolicyId: "cancellation_counter",
      refundPolicyId: "refund_counter",
      refundGovernance: { kind: "approval_required" },
    },
    presentationPolicy: {
      locale: "ja-JP",
      merchantDisplayName: "Pantry Cafe",
      termsPolicyId: "terms_counter",
      privacyPolicyId: "privacy_counter",
      supportContact: "support@example.test",
    },
    ...overrides,
  };
}

function publishedConfiguration(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...configuration(),
    revision: 1,
    lifecycle: {
      state: "published",
      publishedAt: AT,
      publishedBy: "operator_manager",
    },
    ...overrides,
  };
}

function seedMerchant(): void {
  database
    .prepare(
      `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
     VALUES (?, 'organisation_counter', 1, ?, ?)`,
    )
    .run(MERCHANT, AT, AT);
}

describe("point of sale configuration publication", function publicationSuite() {
  beforeEach(function freshDatabase() {
    databasePath = join(
      tmpdir(),
      `commerce-pos-config-${randomUUID()}.sqlite3`,
    );
    database = new NodeCommerceDatabase(databasePath);
    initializeCommerceSchema(database, AT);
    seedMerchant();
    service = new PointOfSaleConfigurationService(database);
  });

  afterEach(function removeDatabase() {
    database.close();
    rmSync(databasePath, { force: true });
  });

  it("refuses a caller that has not seen the current revision", function staleCaller() {
    service.publish({
      merchantId: MERCHANT,
      expectedRevision: null,
      publishedAt: AT,
      publishedBy: "operator_manager",
      configuration: configuration(),
    });
    expect(
      service.publish({
        merchantId: MERCHANT,
        expectedRevision: null,
        publishedAt: LATER,
        publishedBy: "operator_manager",
        configuration: configuration({ quoteTtlSeconds: 60 }),
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "revision_conflict",
        expectedRevision: null,
        actualRevision: 1,
      },
    });
    expect(
      service.readPublished(MERCHANT, "location_cafe")?.quoteTtlSeconds,
    ).toBe(900);
  });

  it("leaves an already-pinned revision readable after republication", function pinned() {
    service.publish({
      merchantId: MERCHANT,
      expectedRevision: null,
      publishedAt: AT,
      publishedBy: "operator_manager",
      configuration: configuration(),
    });
    const republished = service.publish({
      merchantId: MERCHANT,
      expectedRevision: 1,
      publishedAt: LATER,
      publishedBy: "operator_manager",
      configuration: configuration({
        tax: { kind: "percentage", basisPoints: 1_500 },
      }),
    });
    expect(republished.ok && republished.value.revision).toBe(2);
    // A sale rung up under revision 1 still resolves the tax it was quoted at.
    const pinnedRevision = readPointOfSaleConfigurationForCheckout(
      database,
      MERCHANT,
      "location_cafe",
      1,
    );
    expect(pinnedRevision?.tax).toEqual({
      kind: "percentage",
      basisPoints: 1_000,
    });
    expect(service.readPublished(MERCHANT, "location_cafe")?.tax).toEqual({
      kind: "percentage",
      basisPoints: 1_500,
    });
  });

  it("rejects an automatic refund threshold in another currency", function refundThreshold() {
    expect(function parseInvalidConfiguration() {
      parsePointOfSaleConfiguration(
        publishedConfiguration({
          afterSalePolicy: {
            cancellationPolicyId: "cancellation_counter",
            refundPolicyId: "refund_counter",
            refundGovernance: {
              kind: "automatic_up_to",
              threshold: { amountMinor: 500, currency: "USD" },
            },
          },
        }),
      );
    }).toThrow(/afterSalePolicy/u);
  });
});
