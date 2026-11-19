import {
  checkoutPointOfSaleSource,
  checkoutProfileOf,
  parseObservePaymentDisputeCommand,
  parseCollectInPersonCheckoutPaymentCommand,
  type CollectCommerceInPersonCheckoutPaymentV1,
  type CommerceInPersonCheckoutPaymentCollectionV1,
  type CommerceCounterSaleV1,
  type CommerceMutationResultV1,
  type ObserveCommercePaymentDisputeV1,
} from "@purin-labs/commerce-client";
import { readPointOfSaleConfigurationForCheckout } from "../../point-of-sale-configuration-persistence.ts";
import { rejected, sha256, validateMerchant } from "../ledger.ts";
import { parseStripeDisputeEvent } from "../../payments/stripe/stripe-disputes.ts";
import { readStripePaymentIntent } from "../../payments/stripe/stripe-payments.ts";
import {
  listRefundAttemptsForOrder,
  readPaymentDisputeByProviderReference,
} from "../../payments/payment-records.ts";
import {
  readCheckout,
  readCheckoutPaymentAttempt,
} from "../../checkout-persistence.ts";
import { invalidCommand } from "../command-guards.ts";
import {
  TERMINAL_FAST_POLL_SECONDS,
  TERMINAL_POLL_SECONDS,
  TERMINAL_POLL_WINDOW_SECONDS,
  TERMINAL_SLOW_POLL_SECONDS,
  inPersonCollectionRejection,
  requireCounterSale,
  requireSuccessfulCounterSaleMutation,
  unavailableInPersonCheckoutCollection,
} from "../counter-sales.ts";
import { timestampAfter } from "../checkout-shared.ts";
import { providerResolutionOutcome } from "../checkout-payment-planning.ts";
import {
  buildObservedPaymentDispute,
  resolvePaymentDisputeCorrelation,
} from "../payment-disputes.ts";
import { CheckoutFamily } from "./checkout.ts";

/**
 * Counter sale payments and refunds, and payment disputes.
 */
export abstract class PaymentFamily extends CheckoutFamily {
  async collectInPersonCheckoutPayment(
    rawCommand: unknown,
  ): Promise<CommerceInPersonCheckoutPaymentCollectionV1> {
    let command: CollectCommerceInPersonCheckoutPaymentV1;
    try {
      command = parseCollectInPersonCheckoutPaymentCommand(rawCommand);
    } catch (error) {
      return inPersonCollectionRejection(invalidCommand(error));
    }
    const started = this.checkoutCommands.startInPersonCheckoutPayment(command);
    if (started.outcome === "rejected") {
      return inPersonCollectionRejection(started.error);
    }
    const checkout = readCheckout(
      this.database,
      command.merchantId,
      command.checkoutId,
    );
    const paymentAttempt = readCheckoutPaymentAttempt(
      this.database,
      command.merchantId,
      command.paymentAttemptId,
    );
    if (
      checkout?.lifecycle.state !== "payment_pending" ||
      checkout.lifecycle.paymentAttemptId !== command.paymentAttemptId ||
      paymentAttempt === undefined ||
      paymentAttempt.binding.checkoutRevision !== command.checkoutRevision ||
      paymentAttempt.binding.quoteDigest !== command.quoteDigest ||
      JSON.stringify(paymentAttempt.binding.paymentBinding) !==
        JSON.stringify(command.paymentBinding)
    ) {
      return inPersonCollectionRejection({
        code: "resource_relationship_invalid",
        field: "inPersonCheckoutPayment.paymentAttempt",
      });
    }
    // The receipt's merchant name comes from whatever priced the sale. A
    // counter sale is priced by its own published configuration, so requiring a
    // storefront profile here would make an in-person collection depend on an
    // online one that need not exist.
    const onlineProfile = checkoutProfileOf(checkout);
    const posSource = checkoutPointOfSaleSource(checkout);
    const merchantDisplayName =
      onlineProfile !== undefined
        ? this.readCheckoutProfile(
            command.merchantId,
            onlineProfile.checkoutProfileId,
            onlineProfile.revision,
          )?.configuration.presentationPolicy.merchantDisplayName
        : posSource === undefined
          ? undefined
          : readPointOfSaleConfigurationForCheckout(
              this.database,
              command.merchantId,
              posSource.satyrLocationId,
              posSource.posConfigurationRevision,
            )?.presentationPolicy.merchantDisplayName;
    if (merchantDisplayName === undefined) {
      return inPersonCollectionRejection({
        code: "resource_relationship_invalid",
        field: "inPersonCheckoutPayment.checkoutConfiguration",
      });
    }
    if (command.paymentBinding.provider === "gmo_stera") {
      return {
        schemaVersion: "underclerk.in-person-checkout-payment-collection.v1",
        outcome: "ready",
        mutationOutcome: started.outcome,
        receipt: started.receipt,
        paymentAttemptId: command.paymentAttemptId,
        session: {
          kind: "gateway_terminal_checkout",
          gatewayId: command.paymentBinding.gatewayId,
          deviceSourceKey: command.paymentBinding.deviceSourceKey,
          expiresAt: checkout.lifecycle.quote.expiresAt,
        },
      };
    }
    const gateway = this.inPersonCollectionGateway;
    if (gateway === undefined) {
      return unavailableInPersonCheckoutCollection(
        started,
        timestampAfter(this.now(), 60),
      );
    }
    let provider;
    try {
      provider = await gateway.createInPersonCollection({
        merchantId: command.merchantId,
        providerRequestId: command.providerRequestId,
        paymentAttemptId: command.paymentAttemptId,
        checkoutId: command.checkoutId,
        idempotencyKey: command.idempotencyKey,
        money: paymentAttempt.binding.amount,
        paymentBinding: command.paymentBinding,
        ...(command.paymentMethod === undefined
          ? {}
          : { paymentMethod: command.paymentMethod }),
        expiresAt: checkout.lifecycle.quote.expiresAt,
        receiptSummary: {
          merchantName: merchantDisplayName,
          lineCount: checkout.lifecycle.quote.lines.length,
        },
      });
    } catch {
      return unavailableInPersonCheckoutCollection(
        started,
        timestampAfter(this.now(), 60),
      );
    }
    if (provider.kind === "unavailable") {
      return unavailableInPersonCheckoutCollection(
        started,
        provider.retryAfter,
      );
    }
    if (provider.paymentAttemptId !== command.paymentAttemptId) {
      return inPersonCollectionRejection({
        code: "resource_relationship_invalid",
        field: "inPersonCheckoutPayment.providerCollection",
      });
    }
    return {
      schemaVersion: "underclerk.in-person-checkout-payment-collection.v1",
      outcome: "ready",
      mutationOutcome: started.outcome,
      receipt: started.receipt,
      paymentAttemptId: command.paymentAttemptId,
      session: provider.session,
    };
  }

  async reconcileCounterSalePayment(
    merchantId: string,
    checkoutId: string,
  ): Promise<CommerceCounterSaleV1> {
    let merchant = this.ledger.readMerchant(merchantId);
    let sale = this.readCounterSale(merchantId, checkoutId);
    if (merchant === undefined || sale === undefined) {
      throw new Error("Counter sale not found");
    }
    const source = checkoutPointOfSaleSource(sale.checkout);
    if (source === undefined) throw new Error("Counter sale source is invalid");
    if (sale.checkout.lifecycle.state === "accepted") return sale;
    const paymentAttempt = sale.paymentAttempt;
    if (
      sale.checkout.lifecycle.state !== "payment_pending" ||
      paymentAttempt === null ||
      sale.checkout.lifecycle.paymentAttemptId !==
        paymentAttempt.paymentAttemptId ||
      paymentAttempt.binding.paymentBinding.provider !== "square_terminal"
    ) {
      throw new Error("Counter sale has no reconcilable payment");
    }
    const identityDigest = sha256(
      `${merchantId}:${checkoutId}:counter-sale-payment`,
    );
    if (paymentAttempt.lifecycle.state !== "captured") {
      let provider;
      try {
        provider = await this.paymentGateway.reconcile({
          merchantId,
          providerRequestId: paymentAttempt.binding.providerRequestId,
          paymentAttemptId: paymentAttempt.paymentAttemptId,
          checkoutId,
          idempotencyKey: paymentAttempt.binding.idempotencyKey,
          paymentBinding: paymentAttempt.binding.paymentBinding,
          money: paymentAttempt.binding.amount,
          confirmation: { kind: "provider_ui_completed" },
        });
      } catch {
        provider = {
          schemaVersion: "underclerk.payment-capture-result.v1" as const,
          kind: "indeterminate" as const,
          reason: "provider_transport_interrupted",
          reconcileAfter: timestampAfter(this.now(), 60),
        };
      }
      merchant = this.ledger.readMerchant(merchantId);
      sale = this.readCounterSale(merchantId, checkoutId);
      if (
        merchant === undefined ||
        sale === undefined ||
        sale.paymentAttempt === null
      ) {
        throw new Error("Counter sale disappeared during reconciliation");
      }
      // A Terminal that still waits for the card changes nothing; the alarm
      // reads it again without a new event each time.
      if (
        provider.kind === "processing" &&
        sale.paymentAttempt.lifecycle.state === "processing"
      )
        return sale;
      if (provider.kind !== "captured") {
        const resolved = this.checkoutCommands.resolveCheckoutPayment({
          schemaVersion: "underclerk.resolve-checkout-payment.v1",
          merchantId,
          expectedMerchantRevision: merchant.revision,
          idempotencyKey: `counter_payment_resolve_${identityDigest}_${sale.paymentAttempt.revision}_${provider.kind}`,
          requestedAt: this.now(),
          checkoutId,
          checkoutRevision: sale.checkout.revision,
          quoteDigest: sale.paymentAttempt.binding.quoteDigest,
          paymentAttemptId: sale.paymentAttempt.paymentAttemptId,
          paymentAttemptRevision: sale.paymentAttempt.revision,
          outcome: providerResolutionOutcome(provider),
        });
        requireSuccessfulCounterSaleMutation(
          resolved,
          "Counter sale payment resolution failed",
        );
        return requireCounterSale(this.readCounterSale(merchantId, checkoutId));
      }
      const recorded = this.checkoutCommands.recordCheckoutPaymentCapture({
        schemaVersion: "underclerk.record-checkout-payment-capture.v1",
        merchantId,
        expectedMerchantRevision: merchant.revision,
        idempotencyKey: `counter_payment_capture_${identityDigest}`,
        requestedAt: this.now(),
        checkoutId,
        checkoutRevision: sale.checkout.revision,
        quoteDigest: sale.paymentAttempt.binding.quoteDigest,
        paymentAttemptId: sale.paymentAttempt.paymentAttemptId,
        paymentAttemptRevision: sale.paymentAttempt.revision,
        providerPaymentReference: provider.providerPaymentReference,
        capturedAt: provider.capturedAt,
        ...(provider.paymentMethod === undefined
          ? {}
          : { paymentMethod: provider.paymentMethod }),
        ...(provider.tenderBrand === undefined
          ? {}
          : { tenderBrand: provider.tenderBrand }),
        ...(provider.providerRefundable === undefined
          ? {}
          : { providerRefundable: provider.providerRefundable }),
      });
      requireSuccessfulCounterSaleMutation(
        recorded,
        "Counter sale capture recording failed",
      );
    }
    merchant = this.ledger.readMerchant(merchantId);
    sale = this.readCounterSale(merchantId, checkoutId);
    if (
      merchant === undefined ||
      sale === undefined ||
      sale.paymentAttempt === null ||
      sale.paymentAttempt.lifecycle.state !== "captured"
    ) {
      throw new Error("Counter sale capture is unavailable");
    }
    const buyer =
      source.buyer.kind === "anonymous"
        ? { kind: "guest" as const }
        : {
            kind: "identified" as const,
            customerReference: source.buyer.customerId,
          };
    const placed = this.checkoutCommands.placePaidCheckout({
      schemaVersion: "underclerk.place-paid-checkout.v1",
      merchantId,
      expectedMerchantRevision: merchant.revision,
      idempotencyKey: `counter_paid_checkout_${identityDigest}`,
      requestedAt: this.now(),
      checkoutId,
      checkoutRevision: sale.checkout.revision,
      quoteDigest: sale.paymentAttempt.binding.quoteDigest,
      paymentAttemptId: sale.paymentAttempt.paymentAttemptId,
      paymentAttemptRevision: sale.paymentAttempt.revision,
      orderId: `order_counter_${identityDigest}`,
      paymentId: `payment_counter_${identityDigest}`,
      fulfillmentId: `fulfillment_counter_${identityDigest}`,
      buyer,
      placement: { kind: "pickup" },
    });
    requireSuccessfulCounterSaleMutation(
      placed,
      "Counter sale placement failed",
    );
    return requireCounterSale(this.readCounterSale(merchantId, checkoutId));
  }

  async reconcileCounterSaleRefund(
    merchantId: string,
    checkoutId: string,
  ): Promise<CommerceCounterSaleV1> {
    const sale = this.readCounterSale(merchantId, checkoutId);
    if (sale === undefined || sale.checkout.lifecycle.state !== "accepted") {
      throw new Error("Counter sale has no order to refund");
    }
    const attempts = listRefundAttemptsForOrder(
      this.database,
      merchantId,
      sale.checkout.lifecycle.orderId,
    );
    let refundAttemptId: string | undefined;
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      const attempt = attempts[index]?.attempt;
      if (
        attempt?.reason.kind === "order_refund" &&
        (attempt.lifecycle.state === "requested" ||
          attempt.lifecycle.state === "processing" ||
          attempt.lifecycle.state === "indeterminate")
      ) {
        refundAttemptId = attempt.refundAttemptId;
        break;
      }
    }
    if (refundAttemptId === undefined)
      throw new Error("Counter sale has no pending refund");
    const result = await this.afterSaleCommands.reconcileRefund(
      merchantId,
      refundAttemptId,
    );
    if (result.outcome === "rejected") {
      throw new Error(
        `Counter sale refund reconciliation failed: ${result.error.code}`,
      );
    }
    return requireCounterSale(this.readCounterSale(merchantId, checkoutId));
  }

  /**
   * Records a Stripe dispute of a payment that Commerce ran. The event was
   * verified by the Worker; it must name this attempt's own PaymentIntent on
   * the same connected account. Stripe's event id keys the receipt.
   */
  observeStripeDispute(
    merchantId: string,
    paymentAttemptId: string,
    event: unknown,
  ): CommerceMutationResultV1 {
    const dispute = parseStripeDisputeEvent(event);
    const merchant = this.ledger.readMerchant(merchantId);
    if (dispute === undefined || merchant === undefined)
      return rejected({ code: "invalid_command", field: "stripeDispute" });
    const intent = readStripePaymentIntent(
      this.database,
      merchantId,
      paymentAttemptId,
    );
    const attempt = this.database
      .prepare(
        `SELECT checkout_id AS checkoutId FROM checkout_payment_attempt
         WHERE merchant_id = ? AND payment_attempt_id = ?`,
      )
      .get<Readonly<{ checkoutId: string }>>(merchantId, paymentAttemptId);
    if (
      intent === undefined ||
      attempt === undefined ||
      intent.paymentIntentId !== dispute.providerPaymentReference ||
      intent.providerAccountId !== dispute.accountId
    )
      return rejected({
        code: "resource_relationship_invalid",
        field: "stripeDispute.paymentIntent",
      });
    return this.observePaymentDispute({
      schemaVersion: "underclerk.observe-payment-dispute.v1",
      organisationId: merchant.organisationId,
      merchantId,
      providerDeliveryId: dispute.eventId,
      receivedAt: this.now(),
      checkoutId: attempt.checkoutId,
      paymentAttemptId,
      providerPaymentReference: dispute.providerPaymentReference,
      providerDisputeReference: dispute.providerDisputeReference,
      amount: dispute.amount,
      reason: dispute.reason,
      evidenceReferences: [],
      lifecycle: dispute.lifecycle,
    });
  }

  observePaymentDispute(rawCommand: unknown): CommerceMutationResultV1 {
    let command: ObserveCommercePaymentDisputeV1;
    try {
      command = parseObservePaymentDisputeCommand(rawCommand);
    } catch (error) {
      return rejected(invalidCommand(error));
    }
    const merchant = this.ledger.readMerchant(command.merchantId);
    const merchantError = validateMerchant(command.merchantId, merchant);
    if (merchantError !== undefined) return rejected(merchantError);
    const replay = this.ledger.readReplay(
      command.merchantId,
      command.providerDeliveryId,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined) {
      return rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const snapshot = this.readSnapshot(command.merchantId);
    if (snapshot === undefined) {
      return rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const correlation = resolvePaymentDisputeCorrelation(
      this.database,
      command,
      snapshot.resources,
    );
    if (correlation.kind === "rejected") return rejected(correlation.error);
    const existing = readPaymentDisputeByProviderReference(
      this.database,
      command.merchantId,
      command.providerDisputeReference,
    );
    const dispute = buildObservedPaymentDispute(
      command,
      correlation.value,
      existing,
    );
    if (dispute.kind === "rejected") return rejected(dispute.error);
    return this.commitPaymentDisputeObservation(
      command,
      merchant,
      dispute.value,
      existing,
    );
  }

  /**
   * Reads again the Square Terminal checkouts of counter sales that wait for
   * their payment (Plan 80 step 4): every few seconds while the checkout is
   * new, then once a minute. A checkout older than an hour is left to staff.
   * Returns when the next read is due.
   */
  async reconcilePendingTerminalSales(): Promise<string | null> {
    const now = this.now();
    const rows = this.database
      .prepare(
        `SELECT attempt.merchant_id AS merchantId, attempt.checkout_id AS checkoutId,
           terminal.created_at AS createdAt
         FROM checkout_payment_attempt AS attempt
         JOIN square_terminal_checkout AS terminal
           ON terminal.merchant_id = attempt.merchant_id
          AND terminal.payment_attempt_id = attempt.payment_attempt_id
         WHERE attempt.payment_provider = 'square_terminal'
           AND attempt.lifecycle_state IN ('pending', 'processing', 'indeterminate')
           AND terminal.created_at > ?
         ORDER BY terminal.created_at`,
      )
      .all<
        Readonly<{ merchantId: string; checkoutId: string; createdAt: string }>
      >(timestampAfter(now, -TERMINAL_POLL_WINDOW_SECONDS));
    const due: string[] = [];
    for (const row of rows) {
      let waiting: boolean;
      try {
        const sale = await this.reconcileCounterSalePayment(
          row.merchantId,
          row.checkoutId,
        );
        waiting = sale.checkout.lifecycle.state === "payment_pending";
      } catch {
        waiting = false;
      }
      if (!waiting) continue;
      const fresh =
        row.createdAt > timestampAfter(now, -TERMINAL_FAST_POLL_SECONDS);
      due.push(
        timestampAfter(
          this.now(),
          fresh ? TERMINAL_POLL_SECONDS : TERMINAL_SLOW_POLL_SECONDS,
        ),
      );
    }
    return due.sort()[0] ?? null;
  }
}
