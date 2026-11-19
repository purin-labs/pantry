import type { CommerceOfferV1 } from "@purin-labs/commerce-client";

import { listOffers } from "./commerce-persistence";
import type { CommerceDatabase } from "./database";
import { refreshCommerceAttributeRelation } from "./entity-plane/commerce-attribute-relation";
import { writeCommerceEntityRelationText } from "./entity-plane/relation-text";
import type { OfferPricePolicy } from "./commerce-authority/offer-pricing";

type PolicyRow = Readonly<{
  offerId: string;
  revision: number;
  lifecycle: string;
  referenceOfferRevision: number | null;
  referencePriceMinor: number | null;
  currency: string | null;
  maxMovementBps: number | null;
}>;

type OfferPriceRow = Readonly<{
  revision: number;
  amountMinor: number;
  currency: string;
  lifecycleState: string;
}>;

/** The Offer state a price change is decided against, re-read at execution. */
type CurrentOfferPrice = Readonly<{
  revision: number;
  priceMinor: number;
  currency: string;
  /** Only a listed Offer is priced for buyers; a prepared one has no listing. */
  listed: boolean;
}>;

export function readCurrentOfferPrice(
  database: CommerceDatabase,
  merchantId: string,
  offerId: string,
): CurrentOfferPrice | null {
  const row = database
    .prepare(
      `SELECT revision, amount_minor AS amountMinor, currency,
            lifecycle_state AS lifecycleState
       FROM offer WHERE merchant_id = ? AND resource_id = ?`,
    )
    .get<OfferPriceRow>(merchantId, offerId);
  if (row === undefined) return null;
  return {
    revision: row.revision,
    priceMinor: row.amountMinor,
    currency: row.currency,
    listed: row.lifecycleState === "listed",
  };
}

/**
 * The stored policy for one Offer.
 *
 * An Offer with no row has never had a policy set, which is the same refusal
 * as an explicitly disabled one: neither carries pricing authority. Returning
 * a disabled policy at revision zero would invent a revision no command could
 * have bound to, so absence is reported as absence.
 */
export function readOfferPricePolicy(
  database: CommerceDatabase,
  merchantId: string,
  offerId: string,
): OfferPricePolicy | null {
  const row = database
    .prepare(
      `SELECT offer_id AS offerId, revision, lifecycle,
            reference_offer_revision AS referenceOfferRevision,
            reference_price_minor AS referencePriceMinor,
            currency, max_movement_bps AS maxMovementBps
       FROM offer_price_policy WHERE merchant_id = ? AND offer_id = ?`,
    )
    .get<PolicyRow>(merchantId, offerId);
  if (row === undefined) return null;
  if (
    row.lifecycle === "enabled" &&
    row.referenceOfferRevision !== null &&
    row.referencePriceMinor !== null &&
    row.currency !== null &&
    row.maxMovementBps !== null
  ) {
    return {
      kind: "enabled",
      offerId: row.offerId,
      revision: row.revision,
      referenceOfferRevision: row.referenceOfferRevision,
      referencePriceMinor: row.referencePriceMinor,
      currency: row.currency,
      maxMovementBps: row.maxMovementBps,
    };
  }
  return { kind: "disabled", offerId: row.offerId, revision: row.revision };
}

/**
 * Enables or resets a policy, capturing the reference from the Offer itself.
 *
 * The caller passes the Offer it read, never a price from a request body, so
 * an owner cannot set a reference the Offer never had and widen the allowance
 * by choosing its midpoint.
 */
export function writeEnabledOfferPricePolicy(
  input: Readonly<{
    database: CommerceDatabase;
    merchantId: string;
    offerId: string;
    expectedRevision: number | null;
    offer: CurrentOfferPrice;
    maxMovementBps: number;
    updatedAt: string;
  }>,
): boolean {
  return writePolicy({
    ...input,
    lifecycle: "enabled",
    referenceOfferRevision: input.offer.revision,
    referencePriceMinor: input.offer.priceMinor,
    currency: input.offer.currency,
    maxMovementBps: input.maxMovementBps,
  });
}

/** Disables a policy, clearing every pricing field with it. */
export function writeDisabledOfferPricePolicy(
  input: Readonly<{
    database: CommerceDatabase;
    merchantId: string;
    offerId: string;
    expectedRevision: number | null;
    updatedAt: string;
  }>,
): boolean {
  return writePolicy({
    ...input,
    lifecycle: "disabled",
    referenceOfferRevision: null,
    referencePriceMinor: null,
    currency: null,
    maxMovementBps: null,
  });
}

/**
 * Commits one price change and its policy in the same step.
 *
 * The Offer revision advances only when it still matches what the decision was
 * made against, so a concurrent change loses rather than being overwritten.
 * The policy reference is deliberately untouched: an ordinary price change
 * never moves the allowance it was checked against.
 */
export function commitOfferPriceChange(
  input: Readonly<{
    database: CommerceDatabase;
    merchantId: string;
    offerId: string;
    expectedOfferRevision: number;
    toPriceMinor: number;
    currency: string;
    occurredAt: string;
  }>,
): boolean {
  const updated = input.database
    .prepare(
      `UPDATE offer
        SET amount_minor = ?, revision = revision + 1, occurred_at = ?
      WHERE merchant_id = ? AND resource_id = ? AND revision = ?
        AND currency = ? AND lifecycle_state = 'listed'`,
    )
    .run(
      input.toPriceMinor,
      input.occurredAt,
      input.merchantId,
      input.offerId,
      input.expectedOfferRevision,
      input.currency,
    );
  if (updated.changes !== 1) return false;
  writeCommerceEntityRelationText(
    input.database,
    input.merchantId,
    "system",
    "offer",
    input.offerId,
    input.expectedOfferRevision + 1,
    input.occurredAt,
    input.offerId,
  );
  refreshCommerceAttributeRelation(input.database, input.merchantId);
  return true;
}

/**
 * The full Offer record, for the observation a receipt carries.
 *
 * Read from the same row the price change advances, so the observed resource
 * and the written one cannot describe different offers.
 */
export function readOfferResource(
  database: CommerceDatabase,
  merchantId: string,
  offerId: string,
): CommerceOfferV1 | null {
  const rows = listOffers(database, merchantId);
  return rows.find((offer) => offer.id === offerId) ?? null;
}

function writePolicy(
  input: Readonly<{
    database: CommerceDatabase;
    merchantId: string;
    offerId: string;
    expectedRevision: number | null;
    lifecycle: "enabled" | "disabled";
    referenceOfferRevision: number | null;
    referencePriceMinor: number | null;
    currency: string | null;
    maxMovementBps: number | null;
    updatedAt: string;
  }>,
): boolean {
  if (input.expectedRevision === null) {
    // First policy for this Offer. A row that already exists means another
    // writer got there first, so this attempt loses.
    const inserted = input.database
      .prepare(
        `INSERT OR IGNORE INTO offer_price_policy (
         merchant_id, offer_id, revision, lifecycle, reference_offer_revision,
         reference_price_minor, currency, max_movement_bps, updated_at
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.merchantId,
        input.offerId,
        input.lifecycle,
        input.referenceOfferRevision,
        input.referencePriceMinor,
        input.currency,
        input.maxMovementBps,
        input.updatedAt,
      );
    return refreshedAfter(input, inserted.changes === 1);
  }
  const updated = input.database
    .prepare(
      `UPDATE offer_price_policy
        SET revision = revision + 1, lifecycle = ?, reference_offer_revision = ?,
            reference_price_minor = ?, currency = ?, max_movement_bps = ?,
            updated_at = ?
      WHERE merchant_id = ? AND offer_id = ? AND revision = ?`,
    )
    .run(
      input.lifecycle,
      input.referenceOfferRevision,
      input.referencePriceMinor,
      input.currency,
      input.maxMovementBps,
      input.updatedAt,
      input.merchantId,
      input.offerId,
      input.expectedRevision,
    );
  return refreshedAfter(input, updated.changes === 1);
}

/** The Offer's readable price policy fields follow every stored policy write. */
function refreshedAfter(
  input: Readonly<{ database: CommerceDatabase; merchantId: string }>,
  written: boolean,
): boolean {
  if (written)
    refreshCommerceAttributeRelation(input.database, input.merchantId);
  return written;
}
