import { type ReconcileCommerceBuyerPaymentV1 } from "@purin-labs/commerce-client";
import { isOnlinePaymentBinding } from "@purin-labs/commerce-contracts";
import {
  readCheckout,
  readCheckoutPaymentAttempt,
} from "../../checkout-persistence.ts";
import { balanceCheckoutOrder } from "../order-changes.ts";
import {
  buyerCheckoutCanReconcilePayment,
  buyerPaymentAttemptConflicts,
  buyerPaymentAttemptResult,
  buyerPaymentIdentityDigest,
} from "./payments.ts";
import { orderBuyer } from "./placements.ts";
import { timestampAfter } from "../checkout-shared.ts";
import { providerResolutionOutcome } from "../checkout-payment-planning.ts";
import type {
  BuyerCheckoutProfileClaims,
  BuyerPaymentResult,
} from "./types.ts";
import { BuyerPlacementStage } from "./placement-stage.ts";

/**
 * Stage 8 of a buyer checkout: the reconciliation of a payment with the provider.
 */
export abstract class BuyerReconcileStage extends BuyerPlacementStage {
  async reconcileBuyerCheckoutPayment(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      checkoutId: string;
      command: ReconcileCommerceBuyerPaymentV1;
    }>,
  ): Promise<BuyerPaymentResult> {
    let merchant = this.options.readMerchant(input.claims.merchantId);
    if (merchant === undefined) {
      throw new Error("Verified buyer session lost its merchant");
    }
    const identityDigest = buyerPaymentIdentityDigest(input);
    const paymentAttemptId = `payment_attempt_${identityDigest}`;
    const paymentId = `payment_${identityDigest}`;
    const fulfillmentId = `fulfillment_${identityDigest}`;
    const shipmentId = `shipment_${identityDigest}`;
    let checkout = readCheckout(
      this.options.database,
      input.claims.merchantId,
      input.checkoutId,
    );
    // A balance checkout pays an order that exists, so it names that order.
    const balance =
      checkout === undefined ? undefined : balanceCheckoutOrder(checkout);
    const orderId = balance?.orderId ?? `order_${identityDigest}`;
    const readPlacement = () =>
      balance === undefined
        ? this.readBuyerOrderPlacement(
            input.claims.merchantId,
            input.checkoutId,
            input.claims.sessionId,
            input.claims.storefrontId,
            orderId,
            paymentId,
            fulfillmentId,
          )
        : this.readBuyerBalancePlacement(
            input.claims.merchantId,
            input.checkoutId,
            input.claims.sessionId,
            input.claims.storefrontId,
            paymentId,
          );
    if (
      checkout !== undefined &&
      (checkout.lifecycle.quote.checkoutRevision !==
        input.command.checkoutRevision ||
        checkout.lifecycle.quote.quoteDigest !== input.command.quoteDigest)
    ) {
      return {
        kind: "rejected",
        error: {
          code: "idempotency_conflict",
          idempotencyKey: input.command.idempotencyKey,
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
    const existing = readPlacement();
    if (existing !== undefined) return { kind: "resolved", result: existing };
    const priorResult = buyerPaymentAttemptResult(
      checkout,
      paymentAttempt,
      paymentAttemptId,
      input.claims.sessionId,
      input.claims.storefrontId,
    );
    if (
      priorResult !== undefined &&
      (priorResult.state === "declined" ||
        Date.parse(this.options.now()) < Date.parse(priorResult.reconcileAfter))
    ) {
      return { kind: "resolved", result: priorResult };
    }
    if (
      !buyerCheckoutCanReconcilePayment(
        checkout,
        input.claims.sessionId,
        input.claims.storefrontId,
        input.command,
        paymentAttemptId,
      )
    ) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "buyerCheckout.payment",
        },
      };
    }
    if (
      merchant === undefined ||
      checkout?.lifecycle.state !== "payment_pending" ||
      checkout.lifecycle.paymentAttemptId !== paymentAttemptId ||
      paymentAttempt === undefined ||
      (paymentAttempt.lifecycle.state !== "pending" &&
        paymentAttempt.lifecycle.state !== "processing" &&
        paymentAttempt.lifecycle.state !== "indeterminate" &&
        paymentAttempt.lifecycle.state !== "captured")
    ) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "buyerCheckout.paymentAttempt",
        },
      };
    }
    const paymentBinding = paymentAttempt.binding.paymentBinding;
    if (!isOnlinePaymentBinding(paymentBinding)) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "buyerCheckout.paymentBinding",
        },
      };
    }
    if (paymentAttempt.lifecycle.state !== "captured") {
      let provider;
      try {
        provider = await this.options.paymentGateway.reconcile({
          merchantId: input.claims.merchantId,
          providerRequestId: paymentAttempt.binding.providerRequestId,
          paymentAttemptId,
          checkoutId: input.checkoutId,
          idempotencyKey: paymentAttempt.binding.idempotencyKey,
          paymentBinding,
          money: paymentAttempt.binding.amount,
          confirmation: input.command.confirmation,
        });
      } catch {
        provider = {
          schemaVersion: "underclerk.payment-capture-result.v1" as const,
          kind: "indeterminate" as const,
          reason: "provider_transport_interrupted",
          reconcileAfter: timestampAfter(this.options.now(), 60),
        };
      }
      if (provider.kind !== "captured") {
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
        if (
          merchant === undefined ||
          checkout === undefined ||
          paymentAttempt === undefined
        ) {
          throw new Error("Payment resources disappeared before resolution");
        }
        const resolved = this.resolveCheckoutPayment({
          schemaVersion: "underclerk.resolve-checkout-payment.v1",
          merchantId: input.claims.merchantId,
          expectedMerchantRevision: merchant.revision,
          idempotencyKey: `buyer_payment_resolve_${identityDigest}_${paymentAttempt.revision}_${provider.kind}`,
          requestedAt: this.options.now(),
          checkoutId: input.checkoutId,
          checkoutRevision: checkout.revision,
          quoteDigest: input.command.quoteDigest,
          paymentAttemptId,
          paymentAttemptRevision: paymentAttempt.revision,
          outcome: providerResolutionOutcome(provider),
        });
        if (resolved.outcome === "rejected")
          return { kind: "rejected", error: resolved.error };
        const resolvedAttempt = readCheckoutPaymentAttempt(
          this.options.database,
          input.claims.merchantId,
          paymentAttemptId,
        );
        const result = buyerPaymentAttemptResult(
          readCheckout(
            this.options.database,
            input.claims.merchantId,
            input.checkoutId,
          ),
          resolvedAttempt,
          paymentAttemptId,
          input.claims.sessionId,
          input.claims.storefrontId,
        );
        if (result === undefined)
          throw new Error("Applied buyer payment result is unavailable");
        return { kind: "resolved", result };
      }
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
      if (
        merchant === undefined ||
        checkout === undefined ||
        paymentAttempt === undefined
      ) {
        throw new Error(
          "Payment resources disappeared before capture recording",
        );
      }
      const recorded = this.recordCheckoutPaymentCapture({
        schemaVersion: "underclerk.record-checkout-payment-capture.v1",
        merchantId: input.claims.merchantId,
        expectedMerchantRevision: merchant.revision,
        idempotencyKey: `buyer_payment_capture_record_${identityDigest}`,
        requestedAt: this.options.now(),
        checkoutId: input.checkoutId,
        checkoutRevision: checkout.revision,
        quoteDigest: input.command.quoteDigest,
        paymentAttemptId,
        paymentAttemptRevision: paymentAttempt.revision,
        providerPaymentReference: provider.providerPaymentReference,
        capturedAt: provider.capturedAt,
      });
      if (recorded.outcome === "rejected")
        return { kind: "rejected", error: recorded.error };
    }
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
    if (
      merchant === undefined ||
      checkout === undefined ||
      paymentAttempt === undefined ||
      paymentAttempt.lifecycle.state !== "captured"
    ) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "buyerCheckout.payment",
        },
      };
    }
    const placed = this.placePaidCheckout({
      schemaVersion: "underclerk.place-paid-checkout.v1",
      merchantId: input.claims.merchantId,
      expectedMerchantRevision: merchant.revision,
      idempotencyKey: `buyer_paid_checkout_place_${identityDigest}`,
      requestedAt: this.options.now(),
      checkoutId: input.checkoutId,
      checkoutRevision: checkout.revision,
      quoteDigest: input.command.quoteDigest,
      paymentAttemptId,
      paymentAttemptRevision: paymentAttempt.revision,
      orderId,
      paymentId,
      fulfillmentId,
      buyer: orderBuyer(input.claims),
      placement:
        checkout.lifecycle.quote.fulfillment.kind === "pickup"
          ? { kind: "pickup" }
          : { kind: "shipping", shipmentId },
    });
    if (placed.outcome === "rejected")
      return { kind: "rejected", error: placed.error };
    const placement = readPlacement();
    if (placement === undefined)
      throw new Error("Applied buyer placement is unavailable");
    return { kind: "resolved", result: placement };
  }
}
