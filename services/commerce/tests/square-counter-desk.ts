// The counter steps of the Square journeys (Plan 77 step 8, Plan 80 step 4):
// a tin listed in the location's currency, the counter policy, a sale rung
// up and collected on a Square Terminal, and a part refund. Each run passes
// its own id, because Square keeps idempotency keys from run to run.
import type {
  CommerceAdminClient,
  CommerceCounterSaleV1,
} from "@seams/commerce-client";
import type { InPersonPaymentBinding } from "@seams/commerce-contracts";

import {
  CHANNEL,
  LOCATION,
  NOW,
  PRODUCT,
  StaffDesk,
  merchantId,
  organisationId,
  required,
  teaOffer,
  teaPlan,
  teaVariant,
} from "./journey-support.ts";

export const AUD_TIN = "variant_tea_counter_au";

export class SquareCounterDesk extends StaffDesk {
  readonly run: number;

  constructor(admin: CommerceAdminClient, run: number) {
    super(admin, "square");
    this.run = run;
  }

  async refund(
    order: Readonly<{ id: string; revision: number }>,
    payment: Readonly<{ id: string; revision: number }>,
    orderLineId: string,
    amount: Readonly<{ amountMinor: number; currency: string }>,
  ) {
    return this.edit(
      this.admin.refundOrder({
        ...(await this.base(`refund_${this.run}`)),
        orderId: order.id,
        orderRevision: order.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId: `refund_square_part_${this.run}`,
        refundPolicyId: "refund_policy_standard",
        amount,
        allocation: {
          lineAllocations: [{ orderLineId, amount }],
          taxAllocations: [],
          dutyAllocations: [],
          shippingAllocation: { amountMinor: 0, currency: amount.currency },
        },
        reason: "One tin arrived dented",
      }),
    );
  }
  /** A tin that the counter sells in the Square location's currency. */
  async listTin(currency: string) {
    return this.edit(
      this.admin.placeChannelListing({
        ...(await this.base("listing_counter_tin")),
        salesChannelId: CHANNEL,
        catalog: {
          kind: "new_variant",
          productId: PRODUCT,
          productRevision: 1,
          variant: teaVariant(AUD_TIN, "Counter tin", "TEA-COUNTER-AU", [
            { name: "Size", value: "Counter" },
            { name: "Leaf", value: "Sencha" },
          ]),
          consumptionPlan: teaPlan(AUD_TIN),
        },
        offer: {
          ...teaOffer(AUD_TIN, 0),
          price: { amountMinor: 1_350, currency },
        },
      }),
    );
  }

  publishPolicy(currency: string) {
    return required(
      this.admin.publishPointOfSaleConfiguration({
        schemaVersion: "underclerk.publish-point-of-sale-configuration.v1",
        merchantId,
        expectedRevision: null,
        publishedAt: NOW,
        publishedBy: "operator_manager",
        configuration: {
          configurationId: "pos_configuration_counter_au",
          organisationId,
          satyrLocationId: LOCATION,
          salesChannelId: CHANNEL,
          currency,
          supportedItems: [{ variantId: AUD_TIN, maxQuantityPerLine: 10 }],
          quoteTtlSeconds: 900,
          tax: { kind: "percentage", basisPoints: 1_000 },
          pickupReadyLeadTimeSeconds: 0,
          afterSalePolicy: {
            cancellationPolicyId: "cancellation_counter",
            refundPolicyId: "refund_policy_standard",
            refundGovernance: { kind: "approval_required" },
          },
          presentationPolicy: {
            locale: "en-AU",
            merchantDisplayName: "Satyr Cafe",
            termsPolicyId: "terms_counter",
            privacyPolicyId: "privacy_counter",
            supportContact: "support@example.test",
          },
        },
      }),
    );
  }

  async ring(checkoutId: string) {
    const snapshot = await required(this.admin.readSnapshot(merchantId));
    return this.edit(
      this.admin.createInPersonCheckout({
        merchantId,
        expectedMerchantRevision: snapshot.merchantRevision,
        idempotencyKey: `ring_${checkoutId}`,
        satyrLocationId: LOCATION,
        posConfigurationRevision: 1,
        operatorIdentity: "operator_barista",
        terminalAssignmentRevision: 1,
        buyer: { kind: "anonymous" },
        checkoutId,
        lines: [
          {
            cartLineId: `cart_line_${checkoutId}`,
            checkoutLineId: `checkout_line_${checkoutId}`,
            source: { kind: "catalog", variantId: AUD_TIN },
            quantity: { amount: 1, scale: 0, unit: "each" },
          },
        ],
      }),
    );
  }

  async collect(
    sale: CommerceCounterSaleV1,
    paymentBinding: InPersonPaymentBinding,
  ) {
    const snapshot = await required(this.admin.readSnapshot(merchantId));
    const quote = sale.checkout.lifecycle.quote;
    return required(
      this.admin.collectInPersonCheckoutPayment({
        merchantId,
        expectedMerchantRevision: snapshot.merchantRevision,
        idempotencyKey: `collect_${sale.checkout.checkoutId}`,
        checkoutId: sale.checkout.checkoutId,
        checkoutRevision: sale.checkout.revision,
        quoteDigest: quote.quoteDigest,
        paymentAttemptId: `payment_attempt_counter_${this.run}`,
        providerRequestId: `square_terminal_${this.run}`,
        amount: quote.totals.total,
        paymentBinding,
      }),
    );
  }}
