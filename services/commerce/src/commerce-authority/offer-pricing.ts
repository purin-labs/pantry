import type { Variant } from "@purin-labs/type-utils";
import { isPositiveInteger } from "@purin-labs/std";

/**
 * The revisioned price policy that bounds automated Offer price changes.
 *
 * Disabled is the default and carries no pricing authority, so a merchant who
 * has not opted in cannot have a price moved by an agent at all. An enabled
 * policy pins a reference price captured by this boundary when an owner
 * enabled or explicitly reset it; the reference never moves on an ordinary
 * price change, so repeated small steps cannot walk a price away from what
 * the owner approved.
 */
export type OfferPricePolicy =
  | Readonly<{ kind: "disabled"; offerId: string; revision: number }>
  | Readonly<{
      kind: "enabled";
      offerId: string;
      revision: number;
      /** The Offer revision the reference price was captured from. */
      referenceOfferRevision: number;
      /** Positive minor units in the Offer's currency. */
      referencePriceMinor: number;
      currency: string;
      /** Allowed movement from the reference, 0 through 10,000 basis points. */
      maxMovementBps: number;
    }>;

const MAX_MOVEMENT_BPS = 10_000;
const BPS_SCALE = 10_000;

type OfferPriceChangeRequest = Readonly<{
  offerId: string;
  /** The Offer revision the proposal was built against. */
  expectedOfferRevision: number;
  /** The policy revision the approval was bound to. */
  expectedPolicyRevision: number;
  proposedPriceMinor: number;
  currency: string;
}>;

type OfferPriceChangeRefusal = Readonly<{
  code:
    | "offer_price_policy_disabled"
    | "offer_price_policy_stale"
    | "offer_price_policy_currency_mismatch"
    | "offer_revision_stale"
    | "offer_price_not_positive"
    | "offer_price_movement_exceeded"
    | "offer_price_unchanged";
}>;

export type OfferPriceChangeDecision = Readonly<{
  offerId: string;
  fromPriceMinor: number;
  toPriceMinor: number;
  currency: string;
  /** Signed change against the current price, for the operator to read. */
  changeFromCurrentMinor: number;
  /** Signed change against the policy reference, which the limit bounds. */
  changeFromReferenceMinor: number;
  /** Absolute movement from the reference in basis points, rounded down. */
  movementFromReferenceBps: number;
  maxMovementBps: number;
  referencePriceMinor: number;
  policyRevision: number;
  offerRevision: number;
}>;

type OfferPriceChangeResult =
  | Readonly<{ ok: true; decision: OfferPriceChangeDecision }>
  | Readonly<{ ok: false; refusal: OfferPriceChangeRefusal }>;

/**
 * Decides one Offer price change against its policy and current state.
 *
 * Enforcement uses exact integer arithmetic: for reference `B`, proposal `P`
 * and limit `C`, the change is allowed when `|P - B| * 10000 <= B * C`. The
 * basis-point figure this returns is for display and is rounded down, so a
 * value shown as exactly at the limit was inside it.
 */
export function decideOfferPriceChange(
  input: Readonly<{
    policy: OfferPricePolicy;
    request: OfferPriceChangeRequest;
    /** The Offer as it stands right now, re-read at execution. */
    currentOfferRevision: number;
    currentPriceMinor: number;
    currentCurrency: string;
  }>,
): OfferPriceChangeResult {
  const { policy, request } = input;
  if (policy.kind === "disabled") return refuse("offer_price_policy_disabled");
  if (policy.revision !== request.expectedPolicyRevision)
    return refuse("offer_price_policy_stale");
  if (input.currentOfferRevision !== request.expectedOfferRevision) {
    return refuse("offer_revision_stale");
  }
  if (
    policy.currency !== request.currency ||
    input.currentCurrency !== request.currency
  ) {
    return refuse("offer_price_policy_currency_mismatch");
  }
  if (
    !isPositiveInteger(request.proposedPriceMinor) ||
    !isPositiveInteger(policy.referencePriceMinor) ||
    !isPositiveInteger(input.currentPriceMinor)
  ) {
    return refuse("offer_price_not_positive");
  }
  if (request.proposedPriceMinor === input.currentPriceMinor) {
    return refuse("offer_price_unchanged");
  }
  const changeFromReferenceMinor =
    request.proposedPriceMinor - policy.referencePriceMinor;
  const movement = Math.abs(changeFromReferenceMinor);
  // Both sides stay within safe-integer range for any realistic price and a
  // limit capped at 10,000 bps.
  if (
    movement * BPS_SCALE >
    policy.referencePriceMinor * policy.maxMovementBps
  ) {
    return refuse("offer_price_movement_exceeded");
  }
  return {
    ok: true,
    decision: {
      offerId: policy.offerId,
      fromPriceMinor: input.currentPriceMinor,
      toPriceMinor: request.proposedPriceMinor,
      currency: request.currency,
      changeFromCurrentMinor:
        request.proposedPriceMinor - input.currentPriceMinor,
      changeFromReferenceMinor,
      movementFromReferenceBps: Math.floor(
        (movement * BPS_SCALE) / policy.referencePriceMinor,
      ),
      maxMovementBps: policy.maxMovementBps,
      referencePriceMinor: policy.referencePriceMinor,
      policyRevision: policy.revision,
      offerRevision: input.currentOfferRevision,
    },
  };
}

/**
 * The price range an enabled policy currently allows.
 *
 * Shown when an owner enables or resets a policy so the decision is legible
 * as prices rather than basis points. The bounds are inclusive and the lower
 * one never drops below one minor unit, because a zero price is unsupported.
 */
export function allowedPriceRange(
  policy: Pick<
    Variant<OfferPricePolicy, "enabled">,
    "referencePriceMinor" | "maxMovementBps"
  >,
): Readonly<{ minimumMinor: number; maximumMinor: number }> {
  const span = Math.floor(
    (policy.referencePriceMinor * policy.maxMovementBps) / BPS_SCALE,
  );
  return {
    minimumMinor: Math.max(1, policy.referencePriceMinor - span),
    maximumMinor: policy.referencePriceMinor + span,
  };
}

type OfferPricePolicyInvalid = Readonly<{
  code: "offer_price_policy_invalid";
  field:
    | "referencePriceMinor"
    | "maxMovementBps"
    | "currency"
    | "referenceOfferRevision";
}>;

/**
 * Validates an enabled policy before it is stored.
 *
 * The reference price and Offer revision come from the trusted boundary
 * reading the Offer, never from a request body, so this checks shape rather
 * than provenance.
 */
export function validateEnabledPolicy(
  input: Readonly<{
    referenceOfferRevision: number;
    referencePriceMinor: number;
    currency: string;
    maxMovementBps: number;
  }>,
): OfferPricePolicyInvalid | null {
  if (
    !Number.isSafeInteger(input.referenceOfferRevision) ||
    input.referenceOfferRevision <= 0
  ) {
    return {
      code: "offer_price_policy_invalid",
      field: "referenceOfferRevision",
    };
  }
  if (!isPositiveInteger(input.referencePriceMinor)) {
    return { code: "offer_price_policy_invalid", field: "referencePriceMinor" };
  }
  if (!/^[A-Z]{3}$/u.test(input.currency)) {
    return { code: "offer_price_policy_invalid", field: "currency" };
  }
  if (
    !Number.isSafeInteger(input.maxMovementBps) ||
    input.maxMovementBps < 0 ||
    input.maxMovementBps > MAX_MOVEMENT_BPS
  ) {
    return { code: "offer_price_policy_invalid", field: "maxMovementBps" };
  }
  return null;
}

function refuse(code: OfferPriceChangeRefusal["code"]): OfferPriceChangeResult {
  return { ok: false, refusal: { code } };
}
