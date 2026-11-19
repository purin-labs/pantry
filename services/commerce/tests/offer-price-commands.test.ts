import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CommerceAuthority } from "../src/commerce-authority.ts";
import { createJapanShippingGateway } from "../src/plugins/japan-export/index.ts";
import type {
  PaymentGateway,
  PaymentRefundGateway,
} from "../src/payments/provider.ts";
import type { CommerceSigner } from "../src/commerce-authority/contracts.ts";
import {
  disableOfferPricePolicy,
  readOfferPricePolicyView,
  setOfferPricePolicy,
} from "../src/commerce-authority/offer-price-commands.ts";
import { NodeCommerceDatabase } from "../src/node-database.ts";
import { initializeCommerceSchema } from "../src/schema.ts";

const AT = "2026-09-05T10:00:00.000Z";
const MERCHANT = "merchant_1";
const ORGANISATION = "organisation_1";
const OFFER = "offer_1";

describe("governed Offer price changes", () => {
  it("refuses a price change until an owner enables a policy", () => {
    withDatabase((database) => {
      expect(refusal(applyPrice(database, {}))).toBe(
        "offerPrice.offer_price_policy_missing",
      );

      // Explicitly disabling is the same refusal by a different route.
      expect(setPolicy(database, 1_000).ok).toBe(true);
      const disabled = disableOfferPricePolicy({
        database,
        merchantId: MERCHANT,
        offerId: OFFER,
        expectedRevision: 1,
        occurredAt: AT,
      });
      expect(disabled.ok).toBe(true);
      expect(refusal(applyPrice(database, { expectedPolicyRevision: 2 }))).toBe(
        "offerPrice.offer_price_policy_disabled",
      );
    });
  });

  it("captures the reference from the Offer and reports the allowed range", () => {
    withDatabase((database) => {
      const result = setPolicy(database, 1_000);
      if (!result.ok) throw new Error(`refused: ${result.refusal.code}`);
      expect(result.value.policy).toMatchObject({
        kind: "enabled",
        revision: 1,
        referenceOfferRevision: 1,
        referencePriceMinor: 1_000,
        currency: "JPY",
        maxMovementBps: 1_000,
      });
      expect(result.value.allowedRange).toEqual({
        minimumMinor: 900,
        maximumMinor: 1_100,
      });
      // An allowance above 100% is refused before it is stored.
      expect(
        setOfferPricePolicy({
          database,
          merchantId: MERCHANT,
          offerId: OFFER,
          expectedRevision: 1,
          maxMovementBps: 10_001,
          occurredAt: AT,
        }),
      ).toEqual({
        ok: false,
        refusal: {
          code: "offer_price_policy_invalid",
          field: "maxMovementBps",
        },
      });
    });
  });

  it("commits the change with a signed receipt and leaves the reference alone", () => {
    withDatabase((database) => {
      setPolicy(database, 1_000);
      const applied = applyPrice(database, { proposedPriceMinor: 950 });
      expect(applied.outcome).toBe("applied");
      if (applied.outcome !== "applied") return;
      // A governed action needs durable evidence, not just a changed row.
      expect(applied.receipt.commandKind).toBe("adjust_offer_price");
      expect(applied.receipt.resource).toMatchObject({
        kind: "offer",
        id: OFFER,
        revision: 2,
      });
      expect(applied.receipt.deliveryId.length).toBeGreaterThan(0);
      expect(applied.receipt.signer.signature.length).toBeGreaterThan(0);
      expect(applied.receipt.previousMerchantRevision).toBe(1);
      expect(applied.receipt.merchantRevision).toBe(2);

      const view = readOfferPricePolicyView(database, MERCHANT, OFFER);
      if (!view.ok) throw new Error(`refused: ${view.refusal.code}`);
      expect(view.value.currentPriceMinor).toBe(950);
      expect(view.value.currentOfferRevision).toBe(2);
      // The allowance still measures from the price the owner approved.
      expect(view.value.policy).toMatchObject({
        referencePriceMinor: 1_000,
        revision: 1,
      });
      expect(view.value.allowedRange).toEqual({
        minimumMinor: 900,
        maximumMinor: 1_100,
      });
    });
  });

  it("replays the same receipt when a change is delivered twice", () => {
    withDatabase((database) => {
      setPolicy(database, 1_000);
      const first = applyPrice(database, { proposedPriceMinor: 950 });
      const second = applyPrice(database, { proposedPriceMinor: 950 });
      expect(first.outcome).toBe("applied");
      expect(second.outcome).toBe("replayed");
      if (first.outcome === "rejected" || second.outcome === "rejected") return;
      // Same idempotency key: one price move, one receipt, replayed.
      expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
      const view = readOfferPricePolicyView(database, MERCHANT, OFFER);
      if (!view.ok) throw new Error("policy unreadable");
      expect(view.value.currentOfferRevision).toBe(2);
    });
  });

  it("stops repeated changes from walking past the owner's allowance", () => {
    withDatabase((database) => {
      setPolicy(database, 1_000);
      expect(applyPrice(database, { proposedPriceMinor: 950 }).outcome).toBe(
        "applied",
      );
      // Small against the new current price of 950, but one minor unit past
      // the allowance measured from the 1,000 the owner approved.
      expect(
        refusal(
          applyPrice(database, {
            proposedPriceMinor: 899,
            expectedOfferRevision: 2,
          }),
        ),
      ).toBe("offerPrice.offer_price_movement_exceeded");
      // A price exactly at either end of the allowance passes.
      expect(
        applyPrice(database, {
          proposedPriceMinor: 900,
          expectedOfferRevision: 2,
        }).outcome,
      ).toBe("applied");
      expect(
        refusal(
          applyPrice(database, {
            proposedPriceMinor: 1_101,
            expectedOfferRevision: 3,
          }),
        ),
      ).toBe("offerPrice.offer_price_movement_exceeded");
      expect(
        applyPrice(database, {
          proposedPriceMinor: 1_100,
          expectedOfferRevision: 3,
        }).outcome,
      ).toBe("applied");
      // The allowance admits no other currency and no price of zero.
      expect(
        refusal(
          applyPrice(database, {
            proposedPriceMinor: 1_050,
            expectedOfferRevision: 4,
            currency: "USD",
          }),
        ),
      ).toBe("offerPrice.offer_price_policy_currency_mismatch");
      expect(
        applyPrice(database, {
          proposedPriceMinor: 0,
          expectedOfferRevision: 4,
        }).outcome,
      ).toBe("rejected");
    });
  });

  it("refuses an approval built against a revision that has since moved", () => {
    withDatabase((database) => {
      setPolicy(database, 1_000);
      expect(applyPrice(database, { proposedPriceMinor: 950 }).outcome).toBe(
        "applied",
      );
      // The approval still names Offer revision 1, which no longer exists.
      expect(
        refusal(
          applyPrice(database, {
            proposedPriceMinor: 980,
          }),
        ),
      ).toBe("offerPrice.offer_revision_stale");
    });
  });

  it("refuses an approval bound to a policy revision that has since changed", () => {
    withDatabase((database) => {
      setPolicy(database, 1_000);
      // The owner narrows the allowance after the proposal was approved.
      const narrowed = setOfferPricePolicy({
        database,
        merchantId: MERCHANT,
        offerId: OFFER,
        expectedRevision: 1,
        maxMovementBps: 100,
        occurredAt: AT,
      });
      expect(narrowed.ok).toBe(true);
      expect(refusal(applyPrice(database, { proposedPriceMinor: 950 }))).toBe(
        "offerPrice.offer_price_policy_stale",
      );
    });
  });

  it("refuses a policy write bound to a stale policy revision", () => {
    withDatabase((database) => {
      setPolicy(database, 1_000);
      expect(
        setOfferPricePolicy({
          database,
          merchantId: MERCHANT,
          offerId: OFFER,
          expectedRevision: 99,
          maxMovementBps: 500,
          occurredAt: AT,
        }),
      ).toEqual({ ok: false, refusal: { code: "offer_price_policy_stale" } });
    });
  });

  it("refuses to price an Offer that is prepared rather than listed", () => {
    withDatabase((database) => {
      setPolicy(database, 1_000);
      database
        .prepare(
          `UPDATE offer SET lifecycle_state = 'prepared', lifecycle_json = ?
          WHERE merchant_id = ? AND resource_id = ?`,
        )
        .run(
          JSON.stringify({ state: "prepared", preparedAt: AT }),
          MERCHANT,
          OFFER,
        );
      expect(refusal(applyPrice(database, { proposedPriceMinor: 950 }))).toBe(
        "offerPrice.offer_not_listed",
      );
    });
  });

  it("refuses an unknown Offer", () => {
    withDatabase((database) => {
      expect(refusal(applyPrice(database, { offerId: "offer_missing" }))).toBe(
        "offerPrice.offer_not_found",
      );
    });
  });
});

type PriceOverrides = Partial<{
  offerId: string;
  expectedOfferRevision: number;
  expectedPolicyRevision: number;
  proposedPriceMinor: number;
  currency: string;
}>;

/** Applies a price change the way the HTTP route does. */
function applyPrice(
  database: NodeCommerceDatabase,
  overrides: PriceOverrides,
) {
  const offerId = overrides.offerId ?? OFFER;
  const proposedPriceMinor = overrides.proposedPriceMinor ?? 950;
  const authority = new CommerceAuthority({
    database,
    now: () => AT,
    signer: new TestSigner(),
    // A price change touches neither, but the authority owns the whole
    // commerce surface, so both have to be supplied.
    paymentGateway: new UnusedPaymentGateway(),
    shippingGateway: createJapanShippingGateway("offer-price-carrier-key"),
  });
  return authority.adjustOfferPrice({
    schemaVersion: "underclerk.adjust-offer-price.v1",
    merchantId: MERCHANT,
    idempotencyKey: `idem_${offerId}_${proposedPriceMinor}`,
    requestedAt: AT,
    offerId,
    expectedOfferRevision: overrides.expectedOfferRevision ?? 1,
    expectedPolicyRevision: overrides.expectedPolicyRevision ?? 1,
    proposedPriceMinor,
    currency: overrides.currency ?? "JPY",
  });
}

/** The refusal field a rejected mutation names, for a legible assertion. */
function refusal(result: ReturnType<typeof applyPrice>): string {
  if (result.outcome !== "rejected") throw new Error("expected a rejection");
  const error = result.error as Readonly<Record<string, unknown>>;
  return typeof error.field === "string" ? error.field : JSON.stringify(error);
}

function setPolicy(database: NodeCommerceDatabase, maxMovementBps: number) {
  return setOfferPricePolicy({
    database,
    merchantId: MERCHANT,
    offerId: OFFER,
    expectedRevision: null,
    maxMovementBps,
    occurredAt: AT,
  });
}

/** Neither gateway is reached by a price change; both refuse if they are. */
class UnusedPaymentGateway implements PaymentGateway, PaymentRefundGateway {
  async binding(): Promise<never> {
    throw new Error("Payment gateway is unused in Offer price tests");
  }

  async createSession(): Promise<never> {
    throw new Error("Payment gateway is unused in Offer price tests");
  }

  async reconcile(): Promise<never> {
    throw new Error("Payment gateway is unused in Offer price tests");
  }

  async refund(): Promise<never> {
    throw new Error("Payment gateway is unused in Offer price tests");
  }
}

class TestSigner implements CommerceSigner {
  readonly keyId = "key_offer_price_test";
  readonly publicKeyB64 = Buffer.alloc(32, 7).toString("base64url");

  sign(payload: Uint8Array): string {
    return createHash("sha256").update(payload).digest("hex");
  }
}

function withDatabase(body: (database: NodeCommerceDatabase) => void): void {
  const databasePath = join(
    tmpdir(),
    `underclerk-offer-price-${randomUUID()}.sqlite3`,
  );
  const database = new NodeCommerceDatabase(databasePath);
  try {
    initializeCommerceSchema(database, AT);
    seedListedOffer(database);
    body(database);
  } finally {
    database.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  }
}

/** One listed Offer at 1,000 JPY, revision 1. */
function seedListedOffer(database: NodeCommerceDatabase): void {
  database
    .prepare(
      `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)`,
    )
    .run(MERCHANT, ORGANISATION, AT, AT);
  database
    .prepare(
      `INSERT INTO sales_channel (
       merchant_id, resource_id, revision, name, kind,
       lifecycle_state, lifecycle_json, occurred_at
     ) VALUES (?, 'channel_1', 1, 'Online', 'online', 'active', ?, ?)`,
    )
    .run(MERCHANT, JSON.stringify({ state: "active" }), AT);
  database
    .prepare(
      `INSERT INTO product (
       merchant_id, resource_id, revision, title, description, occurred_at
     ) VALUES (?, 'product_1', 1, 'Matcha latte', 'Stone-ground matcha.', ?)`,
    )
    .run(MERCHANT, AT);
  database
    .prepare(
      `INSERT INTO sellable_variant (
       merchant_id, resource_id, revision, product_id, sku, title,
       definition_json, occurred_at
     ) VALUES (?, 'variant_1', 1, 'product_1', 'SKU-1', 'Regular', ?, ?)`,
    )
    .run(MERCHANT, JSON.stringify({ options: [] }), AT);
  database
    .prepare(
      `INSERT INTO offer (
       merchant_id, resource_id, revision, variant_id, sales_channel_id,
       amount_minor, currency, availability_state, availability_json,
       lifecycle_state, lifecycle_json, occurred_at
     ) VALUES (?, ?, 1, 'variant_1', 'channel_1', 1000, 'JPY',
       'available', ?, 'listed', ?, ?)`,
    )
    .run(
      MERCHANT,
      OFFER,
      JSON.stringify({ state: "available" }),
      JSON.stringify({ state: "listed", listedAt: AT }),
      AT,
    );
}
