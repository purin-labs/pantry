import type { CommerceDatabase } from "../database";
import type { CommerceOfferV1 } from "@purin-labs/commerce-client";

import {
  readCurrentOfferPrice,
  readOfferResource,
  readOfferPricePolicy,
  writeDisabledOfferPricePolicy,
  writeEnabledOfferPricePolicy,
} from "../offer-price-persistence";
import {
  allowedPriceRange,
  decideOfferPriceChange,
  validateEnabledPolicy,
  type OfferPriceChangeDecision,
  type OfferPricePolicy,
} from "./offer-pricing";

type OfferPriceCommandRefusal = Readonly<{
  code:
    | "offer_not_found"
    | "offer_not_listed"
    | "offer_price_policy_missing"
    | "offer_price_policy_stale"
    | "offer_price_policy_invalid"
    | "offer_price_policy_disabled"
    | "offer_price_policy_currency_mismatch"
    | "offer_revision_stale"
    | "offer_price_not_positive"
    | "offer_price_movement_exceeded"
    | "offer_price_unchanged"
    | "offer_price_commit_lost";
  field?: string;
}>;

export type OfferPriceCommandResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; refusal: OfferPriceCommandRefusal }>;

export type OfferPricePolicyView = Readonly<{
  policy: OfferPricePolicy;
  /** The prices an enabled policy currently allows, for the operator. */
  allowedRange: Readonly<{ minimumMinor: number; maximumMinor: number }> | null;
  currentPriceMinor: number;
  currentOfferRevision: number;
  currency: string;
}>;

/** Reads one Offer's policy beside the price it applies to. */
export function readOfferPricePolicyView(
  database: CommerceDatabase,
  merchantId: string,
  offerId: string,
): OfferPriceCommandResult<OfferPricePolicyView> {
  const offer = readCurrentOfferPrice(database, merchantId, offerId);
  if (offer === null) return refuse("offer_not_found");
  const stored = readOfferPricePolicy(database, merchantId, offerId);
  const policy: OfferPricePolicy = stored ?? {
    kind: "disabled",
    offerId,
    revision: 0,
  };
  return {
    ok: true,
    value: {
      policy,
      allowedRange:
        policy.kind === "enabled" ? allowedPriceRange(policy) : null,
      currentPriceMinor: offer.priceMinor,
      currentOfferRevision: offer.revision,
      currency: offer.currency,
    },
  };
}

/**
 * Enables a policy, or resets an enabled one to the Offer's current price.
 *
 * Resetting is the owner's explicit decision to move the reference, so the
 * caller passes the revision it read and the new range is reported back for
 * them to see what they just widened or narrowed.
 */
export function setOfferPricePolicy(
  input: Readonly<{
    database: CommerceDatabase;
    merchantId: string;
    offerId: string;
    /** Null when no policy exists yet. */
    expectedRevision: number | null;
    maxMovementBps: number;
    occurredAt: string;
  }>,
): OfferPriceCommandResult<OfferPricePolicyView> {
  // The reference price is read from the Offer and then written into the
  // policy. Those two statements have to be one commit: a price change landing
  // between them would leave the allowance measured from a price the Offer no
  // longer carries, which is exactly the invariant the reference exists to
  // hold.
  return input.database.transaction(() => {
    const offer = readCurrentOfferPrice(
      input.database,
      input.merchantId,
      input.offerId,
    );
    if (offer === null) return refuse("offer_not_found");
    if (!offer.listed) return refuse("offer_not_listed");
    const invalid = validateEnabledPolicy({
      referenceOfferRevision: offer.revision,
      referencePriceMinor: offer.priceMinor,
      currency: offer.currency,
      maxMovementBps: input.maxMovementBps,
    });
    if (invalid !== null) {
      return {
        ok: false,
        refusal: { code: "offer_price_policy_invalid", field: invalid.field },
      };
    }
    const written = writeEnabledOfferPricePolicy({
      database: input.database,
      merchantId: input.merchantId,
      offerId: input.offerId,
      expectedRevision: input.expectedRevision,
      offer,
      maxMovementBps: input.maxMovementBps,
      updatedAt: input.occurredAt,
    });
    if (!written) return refuse("offer_price_policy_stale");
    return readOfferPricePolicyView(
      input.database,
      input.merchantId,
      input.offerId,
    );
  });
}

/** Disables a policy, withdrawing all pricing authority for this Offer. */
export function disableOfferPricePolicy(
  input: Readonly<{
    database: CommerceDatabase;
    merchantId: string;
    offerId: string;
    expectedRevision: number;
    occurredAt: string;
  }>,
): OfferPriceCommandResult<OfferPricePolicyView> {
  const written = writeDisabledOfferPricePolicy({
    database: input.database,
    merchantId: input.merchantId,
    offerId: input.offerId,
    expectedRevision: input.expectedRevision,
    updatedAt: input.occurredAt,
  });
  if (!written) return refuse("offer_price_policy_stale");
  return readOfferPricePolicyView(
    input.database,
    input.merchantId,
    input.offerId,
  );
}

type AdjustOfferPriceCommand = Readonly<{
  merchantId: string;
  offerId: string;
  expectedOfferRevision: number;
  expectedPolicyRevision: number;
  proposedPriceMinor: number;
  currency: string;
}>;

/**
 * Applies one approved price change.
 *
 * Every check runs here against state read now, not against what the proposal
 * carried: the policy, both revisions, the currency, the listing state, and
 * the allowance. An approval is permission to attempt the change, not evidence
 * that it is still valid.
 */
export function adjustOfferPriceDecision(
  input: Readonly<{
    database: CommerceDatabase;
    command: AdjustOfferPriceCommand;
  }>,
): OfferPriceCommandResult<AdjustOfferPriceDecided> {
  const { command } = input;
  const offer = readCurrentOfferPrice(
    input.database,
    command.merchantId,
    command.offerId,
  );
  if (offer === null) return refuse("offer_not_found");
  if (!offer.listed) return refuse("offer_not_listed");
  const policy = readOfferPricePolicy(
    input.database,
    command.merchantId,
    command.offerId,
  );
  if (policy === null) return refuse("offer_price_policy_missing");
  const decided = decideOfferPriceChange({
    policy,
    request: {
      offerId: command.offerId,
      expectedOfferRevision: command.expectedOfferRevision,
      expectedPolicyRevision: command.expectedPolicyRevision,
      proposedPriceMinor: command.proposedPriceMinor,
      currency: command.currency,
    },
    currentOfferRevision: offer.revision,
    currentPriceMinor: offer.priceMinor,
    currentCurrency: offer.currency,
  });
  if (!decided.ok)
    return { ok: false, refusal: { code: decided.refusal.code } };
  const resulting = readOfferResource(
    input.database,
    command.merchantId,
    command.offerId,
  );
  if (resulting === null) return refuse("offer_not_found");
  return {
    ok: true,
    value: {
      decision: decided.decision,
      // The Offer as it will stand once committed, for the observation the
      // receipt carries. Building it here keeps the observed revision and the
      // written revision from being derived separately and drifting.
      offer: {
        ...resulting,
        revision: offer.revision + 1,
        price: {
          amountMinor: decided.decision.toPriceMinor,
          currency: decided.decision.currency,
        },
      },
    },
  };
}

type AdjustOfferPriceDecided = Readonly<{
  decision: OfferPriceChangeDecision;
  offer: CommerceOfferV1;
}>;

function refuse(
  code: OfferPriceCommandRefusal["code"],
): OfferPriceCommandResult<never> {
  return { ok: false, refusal: { code } };
}
