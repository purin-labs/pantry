import {
  parseCheckoutPaymentAttempt,
  requireCheckoutProfile,
  type CreateCommerceBuyerPaymentSessionV1,
  type ResolveCommerceCheckoutPaymentV1,
  type CommerceBuyerV1,
  type CommerceMutationErrorV1,
  type CommercePaymentCaptureResultV1,
} from "@purin-labs/commerce-client";
import {
  isOnlinePaymentBinding,
  type CheckoutPaymentAttempt,
} from "@purin-labs/commerce-contracts";
import {
  readCheckout,
  readCheckoutPaymentAttempt,
} from "../../checkout-persistence.ts";
import {
  openUnplacedCapture,
  readUnplacedCapture,
} from "../../payments/unplaced-captures.ts";
import { readProfile } from "../../checkout-profile-persistence.ts";
import { amountDue, timestampAfter } from "../checkout-shared.ts";
import { balanceCheckoutOrder } from "../order-changes.ts";
import {
  buyerCheckoutCanStartPayment,
  buyerPaymentAttemptConflicts,
  buyerPaymentIdentityDigest,
} from "./payments.ts";
import { orderBuyer } from "./placements.ts";
import type {
  BuyerCheckoutProfileClaims,
  BuyerPaymentSessionResult,
} from "./types.ts";
import { BuyerCheckoutRefreshStage } from "./refresh-stage.ts";

/**
 * Stage 6 of a buyer checkout: the payment session and the online settlement.
 */
export abstract class BuyerPaymentStage extends BuyerCheckoutRefreshStage {
  async createBuyerPaymentSession(
    input: Readonly<{
      claims: Readonly<{
        sessionId: string;
        merchantId: string;
        storefrontId: string;
      }> &
        Pick<BuyerCheckoutProfileClaims, "buyer">;
      checkoutId: string;
      command: CreateCommerceBuyerPaymentSessionV1;
    }>,
  ): Promise<BuyerPaymentSessionResult> {
    let merchant = this.options.readMerchant(input.claims.merchantId);
    if (merchant === undefined) {
      throw new Error("Verified buyer session lost its merchant");
    }
    const identityDigest = buyerPaymentIdentityDigest(input);
    const paymentAttemptId = `payment_attempt_${identityDigest}`;
    let checkout = readCheckout(
      this.options.database,
      input.claims.merchantId,
      input.checkoutId,
    );
    if (
      !buyerCheckoutCanStartPayment(
        checkout,
        input.claims.sessionId,
        input.claims.storefrontId,
        input.command,
      )
    ) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "buyerCheckout.paymentSession",
        },
      };
    }
    let paymentAttempt = readCheckoutPaymentAttempt(
      this.options.database,
      input.claims.merchantId,
      paymentAttemptId,
    );
    if (
      buyerPaymentAttemptConflicts(
        paymentAttempt,
        input.checkoutId,
        input.command,
      )
    ) {
      return {
        kind: "rejected",
        error: {
          code: "idempotency_conflict",
          idempotencyKey: input.command.idempotencyKey,
        },
      };
    }
    const checkoutProfile = readProfile(
      this.options.database,
      input.claims.merchantId,
      requireCheckoutProfile(checkout).checkoutProfileId,
      requireCheckoutProfile(checkout).revision,
    );
    if (
      checkoutProfile === undefined ||
      checkoutProfile.lifecycle.state === "draft"
    ) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "buyerCheckout.paymentBinding",
        },
      };
    }
    const paymentBinding = await this.options.paymentGateway.binding(
      checkoutProfile.configuration.paymentPolicy.paymentProviderBindingId,
      input.claims.merchantId,
    );
    if (paymentBinding === null) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "buyerCheckout.paymentBinding",
        },
      };
    }
    if (checkout.lifecycle.state === "quoted") {
      const started = this.beginCheckoutPayment({
        schemaVersion: "underclerk.begin-checkout-payment.v1",
        merchantId: input.claims.merchantId,
        expectedMerchantRevision: merchant.revision,
        idempotencyKey: `buyer_payment_start_${identityDigest}`,
        requestedAt: this.options.now(),
        checkoutId: input.checkoutId,
        checkoutRevision: input.command.checkoutRevision,
        quoteDigest: input.command.quoteDigest,
        paymentAttemptId,
        providerRequestId: `payment_request_${identityDigest}`,
        amount: amountDue(checkout.lifecycle.quote),
        paymentBinding,
      });
      if (started.outcome === "rejected")
        return { kind: "rejected", error: started.error };
      merchant = this.options.readMerchant(input.claims.merchantId);
      checkout = readCheckout(
        this.options.database,
        input.claims.merchantId,
        input.checkoutId,
      );
      paymentAttempt = readCheckoutPaymentAttempt(
        this.options.database,
        input.claims.merchantId,
        paymentAttemptId,
      );
    }
    if (
      merchant === undefined ||
      checkout?.lifecycle.state !== "payment_pending" ||
      checkout.lifecycle.paymentAttemptId !== paymentAttemptId ||
      paymentAttempt?.lifecycle.state !== "pending"
    ) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "buyerCheckout.paymentSession",
        },
      };
    }
    const attemptPaymentBinding = paymentAttempt.binding.paymentBinding;
    if (
      !isOnlinePaymentBinding(attemptPaymentBinding) ||
      JSON.stringify(attemptPaymentBinding) !== JSON.stringify(paymentBinding)
    ) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "buyerCheckout.paymentBinding",
        },
      };
    }
    // The order's buyer, so a provider notification can place the order
    // when the buyer does not come back (Plan 76 phase 3).
    this.options.database
      .prepare(
        `INSERT OR IGNORE INTO checkout_payment_settlement (
           merchant_id, payment_attempt_id, checkout_id, buyer_json, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.claims.merchantId,
        paymentAttemptId,
        input.checkoutId,
        JSON.stringify(orderBuyer(input.claims)),
        this.options.now(),
      );
    let providerSession;
    try {
      providerSession = await this.options.paymentGateway.createSession({
        merchantId: input.claims.merchantId,
        providerRequestId: paymentAttempt.binding.providerRequestId,
        paymentAttemptId,
        checkoutId: input.checkoutId,
        idempotencyKey: paymentAttempt.binding.idempotencyKey,
        money: paymentAttempt.binding.amount,
        paymentBinding: attemptPaymentBinding,
        expiresAt: checkout.lifecycle.quote.expiresAt,
        returnUrl: input.command.returnUrl,
      });
    } catch {
      providerSession = {
        schemaVersion: "underclerk.payment-session-result.v1" as const,
        kind: "unavailable" as const,
        reason: "provider_transport_interrupted",
        retryAfter: timestampAfter(this.options.now(), 60),
      };
    }
    if (providerSession.kind === "unavailable") {
      return {
        kind: "resolved",
        result: {
          schemaVersion: "underclerk.buyer-payment-session.v1",
          state: "unavailable",
          checkoutId: input.checkoutId,
          retryAfter: providerSession.retryAfter,
        },
      };
    }
    if (providerSession.paymentAttemptId !== paymentAttemptId) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "buyerCheckout.providerSession",
        },
      };
    }
    return {
      kind: "resolved",
      result: {
        schemaVersion: "underclerk.buyer-payment-session.v1",
        state: "ready",
        checkoutId: input.checkoutId,
        checkoutRevision: input.command.checkoutRevision,
        paymentAttemptId,
        session: providerSession.session,
      },
    };
  }

  /**
   * Settles an online payment from a provider notification, or from the
   * `payment_due` pass when the payment is due. A captured payment places the
   * order that the buyer's reconcile makes, so the buyer later reads the same
   * placement. Any other answer is written only when the attempt is due: the
   * quote expired, and a slow or lost answer reached its `reconcileAfter`.
   * Before that the buyer can still try another card on the same session, so
   * a declined card keeps the holds. A capture that cannot become an order
   * is a staff item (spec section 12); Commerce does not refund it.
   */
  async settleOnlineCheckoutPayment(
    merchantId: string,
    paymentAttemptId: string,
  ): Promise<Readonly<{ state: OnlineSettlementState }>> {
    const settlement = this.options.database
      .prepare(
        `SELECT checkout_id AS checkoutId, buyer_json AS buyerJson
         FROM checkout_payment_settlement
         WHERE merchant_id = ? AND payment_attempt_id = ?`,
      )
      .get<Readonly<{ checkoutId: string; buyerJson: string }>>(
        merchantId,
        paymentAttemptId,
      );
    const prefix = "payment_attempt_";
    if (settlement === undefined || !paymentAttemptId.startsWith(prefix))
      return { state: "not_found" };
    if (
      readUnplacedCapture(
        this.options.database,
        merchantId,
        paymentAttemptId,
      ) !== undefined
    )
      return { state: "unplaced" };
    const identityDigest = paymentAttemptId.slice(prefix.length);
    const read = () => ({
      merchant: this.options.readMerchant(merchantId),
      checkout: readCheckout(
        this.options.database,
        merchantId,
        settlement.checkoutId,
      ),
      paymentAttempt: readCheckoutPaymentAttempt(
        this.options.database,
        merchantId,
        paymentAttemptId,
      ),
    });
    let { merchant, checkout, paymentAttempt } = read();
    if (
      merchant === undefined ||
      checkout === undefined ||
      paymentAttempt === undefined ||
      !isOnlinePaymentBinding(paymentAttempt.binding.paymentBinding)
    )
      return { state: "not_found" };
    const binding = paymentAttempt.binding;
    const paymentBinding = binding.paymentBinding;
    const unplaced = (
      reason: string,
      providerPaymentReference: string,
    ): Readonly<{ state: "unplaced" }> => {
      openUnplacedCapture(this.options.database, merchantId, {
        paymentAttemptId,
        checkoutId: settlement.checkoutId,
        amount: binding.amount,
        providerPaymentReference,
        reason,
        openedAt: this.options.now(),
      });
      return { state: "unplaced" };
    };
    const reconcile = async () => {
      try {
        return await this.options.paymentGateway.reconcile({
          merchantId,
          providerRequestId: binding.providerRequestId,
          paymentAttemptId,
          checkoutId: settlement.checkoutId,
          idempotencyKey: binding.idempotencyKey,
          paymentBinding,
          money: binding.amount,
          confirmation: { kind: "provider_ui_completed" },
        });
      } catch {
        return undefined;
      }
    };
    if (checkout.lifecycle.state === "accepted")
      return checkout.lifecycle.paymentAttemptId === paymentAttemptId
        ? { state: "placed" }
        : { state: "not_found" };
    if (
      checkout.lifecycle.state !== "payment_pending" ||
      checkout.lifecycle.paymentAttemptId !== paymentAttemptId
    ) {
      // The checkout ended without this payment: it was declined or it
      // expired. If the buyer paid on the provider after all, the money has
      // no order.
      const late = await reconcile();
      return late?.kind === "captured"
        ? unplaced("checkout_expired", late.providerPaymentReference)
        : { state: "not_found" };
    }
    const quote = checkout.lifecycle.quote;
    const quoteDigest = quote.quoteDigest;
    if (paymentAttempt.lifecycle.state !== "captured") {
      const provider = await reconcile();
      if (provider === undefined) return { state: "pending" };
      ({ merchant, checkout, paymentAttempt } = read());
      if (
        merchant === undefined ||
        checkout === undefined ||
        paymentAttempt === undefined
      )
        return { state: "not_found" };
      // The buyer's own reconcile may have finished while the provider
      // answered.
      if (checkout.lifecycle.state === "accepted") return { state: "placed" };
      if (provider.kind !== "captured") {
        const now = this.options.now();
        if (
          checkout.lifecycle.state !== "payment_pending" ||
          !paymentAttemptDue(paymentAttempt.lifecycle, quote.expiresAt, now)
        )
          return { state: "pending" };
        const outcome = dueOutcome(provider, quote.expiresAt, now);
        const resolved = this.resolveCheckoutPayment({
          schemaVersion: "underclerk.resolve-checkout-payment.v1",
          merchantId,
          expectedMerchantRevision: merchant.revision,
          idempotencyKey: `payment_due_resolve_${identityDigest}_${paymentAttempt.revision}_${outcome.kind}`,
          requestedAt: now,
          checkoutId: settlement.checkoutId,
          checkoutRevision: checkout.revision,
          quoteDigest,
          paymentAttemptId,
          paymentAttemptRevision: paymentAttempt.revision,
          outcome,
        });
        if (resolved.outcome === "rejected") {
          console.warn(
            "underclerk.payment_due_refused",
            paymentAttemptId,
            JSON.stringify(resolved.error),
          );
          return { state: "pending" };
        }
        return { state: outcome.kind === "declined" ? "declined" : "pending" };
      }
      if (paymentAttempt.lifecycle.state !== "captured") {
        const recorded = this.recordCheckoutPaymentCapture({
          schemaVersion: "underclerk.record-checkout-payment-capture.v1",
          merchantId,
          expectedMerchantRevision: merchant.revision,
          idempotencyKey: `payment_settlement_capture_${identityDigest}`,
          requestedAt: this.options.now(),
          checkoutId: settlement.checkoutId,
          checkoutRevision: checkout.revision,
          quoteDigest,
          paymentAttemptId,
          paymentAttemptRevision: paymentAttempt.revision,
          providerPaymentReference: provider.providerPaymentReference,
          capturedAt: provider.capturedAt,
        });
        if (recorded.outcome === "rejected")
          return unplaced(
            refusalReason(recorded.error),
            provider.providerPaymentReference,
          );
        ({ merchant, checkout, paymentAttempt } = read());
        if (
          merchant === undefined ||
          checkout === undefined ||
          paymentAttempt === undefined
        )
          return { state: "not_found" };
      }
    }
    if (paymentAttempt.lifecycle.state !== "captured")
      return { state: "pending" };
    const balance = balanceCheckoutOrder(checkout);
    const placed = this.placePaidCheckout({
      schemaVersion: "underclerk.place-paid-checkout.v1",
      merchantId,
      expectedMerchantRevision: merchant.revision,
      idempotencyKey: `payment_settlement_place_${identityDigest}`,
      requestedAt: this.options.now(),
      checkoutId: settlement.checkoutId,
      checkoutRevision: checkout.revision,
      quoteDigest,
      paymentAttemptId,
      paymentAttemptRevision: paymentAttempt.revision,
      orderId: balance?.orderId ?? `order_${identityDigest}`,
      paymentId: `payment_${identityDigest}`,
      fulfillmentId: `fulfillment_${identityDigest}`,
      buyer: JSON.parse(settlement.buyerJson) as CommerceBuyerV1,
      placement:
        checkout.lifecycle.quote.fulfillment.kind === "pickup"
          ? { kind: "pickup" }
          : { kind: "shipping", shipmentId: `shipment_${identityDigest}` },
    });
    return placed.outcome === "rejected"
      ? unplaced(
          refusalReason(placed.error),
          paymentAttempt.lifecycle.providerPaymentReference,
        )
      : { state: "placed" };
  }

  /**
   * The `payment_due` pass of the alarm (Refactor 15, refactor 10): settles
   * each online payment that Commerce runs and that is due, so a checkout
   * whose buyer left after a declined card releases its holds. A capture
   * that the buyer's reconcile did not place is due at once. Returns when
   * the next payment is due, or null when no checkout waits for a payment.
   */
  async reconcileDuePayments(): Promise<string | null> {
    const now = this.options.now();
    let settled = 0;
    for (const payment of this.#openPayments()) {
      if (payment.dueAt > now || settled === DUE_PAYMENTS_PER_PASS) break;
      settled += 1;
      try {
        await this.settleOnlineCheckoutPayment(
          payment.merchantId,
          payment.paymentAttemptId,
        );
      } catch (error) {
        console.warn(
          "underclerk.payment_due_failed",
          payment.paymentAttemptId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return this.#openPayments()[0]?.dueAt ?? null;
  }

  // The online payments that Commerce runs for checkouts that wait for
  // them, with no staff item, the earliest due first.
  #openPayments(): readonly Readonly<{
    merchantId: string;
    paymentAttemptId: string;
    dueAt: string;
  }>[] {
    return this.options.database
      .prepare(
        `SELECT checkout.merchant_id AS merchantId,
                attempt.payment_attempt_id AS paymentAttemptId,
                json_extract(checkout.checkout_json, '$.lifecycle.quote.expiresAt')
                  AS expiresAt,
                attempt.payment_attempt_json AS attemptJson
         FROM buyer_checkout AS checkout
         JOIN checkout_payment_settlement AS settlement
           ON settlement.merchant_id = checkout.merchant_id
          AND settlement.checkout_id = checkout.checkout_id
         JOIN checkout_payment_attempt AS attempt
           ON attempt.merchant_id = settlement.merchant_id
          AND attempt.payment_attempt_id = settlement.payment_attempt_id
         WHERE checkout.lifecycle_state = 'payment_pending'
           AND attempt.payment_attempt_id =
             json_extract(checkout.checkout_json, '$.lifecycle.paymentAttemptId')
           AND NOT EXISTS (
             SELECT 1 FROM checkout_capture_unplaced AS unplaced
             WHERE unplaced.merchant_id = attempt.merchant_id
               AND unplaced.payment_attempt_id = attempt.payment_attempt_id
           )`,
      )
      .all<
        Readonly<{
          merchantId: string;
          paymentAttemptId: string;
          expiresAt: string;
          attemptJson: string;
        }>
      >()
      .map((row) => ({
        merchantId: row.merchantId,
        paymentAttemptId: row.paymentAttemptId,
        dueAt: paymentAttemptDueAt(
          parseCheckoutPaymentAttempt(JSON.parse(row.attemptJson)).lifecycle,
          row.expiresAt,
        ),
      }))
      .sort(
        (left, right) =>
          left.dueAt.localeCompare(right.dueAt) ||
          left.paymentAttemptId.localeCompare(right.paymentAttemptId),
      );
  }
}

type OnlineSettlementState =
  "placed" | "pending" | "declined" | "unplaced" | "not_found";

/** The payments that one alarm pass settles; the rest wait for the next. */
const DUE_PAYMENTS_PER_PASS = 20;

/**
 * A buyer who leaves a card authentication that the provider still waits
 * for: an hour after the quote expired, the payment is declined.
 */
const AUTHENTICATION_ABANDONED_MS = 3_600_000;

type PaymentAttemptLifecycle = CheckoutPaymentAttempt["lifecycle"];

// A captured attempt is due at once: only its placement is left. An open
// attempt is due when its quote expires, and a slow or lost answer not
// before its `reconcileAfter`.
function paymentAttemptDueAt(
  lifecycle: PaymentAttemptLifecycle,
  quoteExpiresAt: string,
): string {
  switch (lifecycle.state) {
    case "captured":
      return new Date(0).toISOString();
    case "processing":
    case "indeterminate":
      return new Date(
        Math.max(
          Date.parse(quoteExpiresAt),
          Date.parse(lifecycle.reconcileAfter),
        ),
      ).toISOString();
    case "pending":
    case "declined":
      return new Date(Date.parse(quoteExpiresAt)).toISOString();
  }
}

function paymentAttemptDue(
  lifecycle: PaymentAttemptLifecycle,
  quoteExpiresAt: string,
  now: string,
): boolean {
  return (
    Date.parse(paymentAttemptDueAt(lifecycle, quoteExpiresAt)) <=
    Date.parse(now)
  );
}

type DueOutcome = ResolveCommerceCheckoutPaymentV1["outcome"];

// What a due attempt records for an answer other than a capture.
function dueOutcome(
  provider: Exclude<
    CommercePaymentCaptureResultV1,
    Readonly<{ kind: "captured" }>
  >,
  quoteExpiresAt: string,
  now: string,
): DueOutcome {
  if (provider.kind === "declined")
    return { kind: "declined", reasonCode: provider.reason };
  if (
    provider.kind === "processing" &&
    provider.reason === "payment_authentication_required" &&
    Date.parse(now) >= Date.parse(quoteExpiresAt) + AUTHENTICATION_ABANDONED_MS
  )
    return { kind: "declined", reasonCode: "payment_authentication_abandoned" };
  return {
    kind: provider.kind,
    reasonCode: provider.reason,
    reconcileAfter: provider.reconcileAfter,
  };
}

function refusalReason(error: CommerceMutationErrorV1): string {
  return "field" in error && typeof error.field === "string"
    ? `${error.code} ${error.field}`
    : error.code;
}
