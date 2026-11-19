import type {
  CommercePaymentClientConfirmationV1,
  CommerceInPersonCollectionResultV1,
  CommercePaymentRefundResultV1,
  CommercePaymentSessionResultV1,
  CommercePaymentCaptureResultV1,
} from "@seams/commerce-client";
import type {
  CheckoutPaymentProviderBinding,
  InPersonPaymentBinding,
  InPersonPaymentMethod,
  OnlinePaymentBinding,
} from "@seams/commerce-contracts";
import type { VariantBy } from "@seams/type-utils";

type MerchantPaymentRequestBase<
  TBinding extends CheckoutPaymentProviderBinding,
> = Readonly<{
  merchantId: string;
  providerRequestId: string;
  paymentAttemptId: string;
  checkoutId: string;
  idempotencyKey: string;
  money: Readonly<{ amountMinor: number; currency: string }>;
  paymentBinding: TBinding;
}>;

export type MerchantPaymentSessionCommand =
  MerchantPaymentRequestBase<OnlinePaymentBinding> &
    Readonly<{
      expiresAt: string;
      returnUrl: string;
    }>;

export type MerchantPaymentReconciliationCommand =
  MerchantPaymentRequestBase<CheckoutPaymentProviderBinding> &
    Readonly<{
      confirmation: CommercePaymentClientConfirmationV1;
    }>;

export type MerchantInPersonCollectionCommand = Readonly<{
  merchantId: string;
  providerRequestId: string;
  paymentAttemptId: string;
  checkoutId: string;
  idempotencyKey: string;
  money: Readonly<{ amountMinor: number; currency: string }>;
  paymentBinding: InPersonPaymentBinding;
  paymentMethod?: InPersonPaymentMethod;
  expiresAt: string;
  receiptSummary: Readonly<{
    merchantName: string;
    lineCount: number;
  }>;
}>;

export type MerchantPaymentRefundCommand =
  MerchantPaymentRequestBase<CheckoutPaymentProviderBinding> &
    Readonly<{
      orderId: string;
      refundAttemptId: string;
      providerPaymentReference: string;
      refundMoney: Readonly<{ amountMinor: number; currency: string }>;
      reason: string;
      /**
       * What an earlier try of this refund left: the provider's refund while
       * it is pending, or nothing known when its answer was lost. A gateway
       * reads that refund before it asks for a new one.
       */
      earlierTry?:
        | Readonly<{ kind: "processing"; providerRefundReference: string }>
        | Readonly<{ kind: "unknown" }>;
    }>;

export interface PaymentGateway {
  binding(
    paymentProviderBindingId: string,
    merchantId: string,
  ): Promise<OnlinePaymentBinding | null>;
  createSession(
    request: MerchantPaymentSessionCommand,
  ): Promise<CommercePaymentSessionResultV1>;
  reconcile(
    request: MerchantPaymentReconciliationCommand,
  ): Promise<CommercePaymentCaptureResultV1>;
}

export interface PaymentRefundGateway {
  refund(
    request: MerchantPaymentRefundCommand,
  ): Promise<CommercePaymentRefundResultV1>;
}

/**
 * The port of an outside payment provider (Plan 77 step 2): start a session,
 * reconcile what the buyer did, and refund. A refund first reads the
 * provider's refund of an earlier try (`earlierTry`), so a lost answer is
 * found again. Stripe, Square and the deterministic test gateway implement
 * it; GMO waits for its own plan. Stored value and manual tenders are
 * not providers: the refund engine resolves them in its own transaction.
 */
export type PaymentProvider = PaymentGateway & PaymentRefundGateway;

export interface InPersonCollectionGateway {
  createInPersonCollection(
    request: MerchantInPersonCollectionCommand,
  ): Promise<CommerceInPersonCollectionResultV1>;
}

/**
 * The end of the gateway chain: a payment that no provider here runs. Stripe
 * and Square run inside Commerce (Plan 80); any other binding, such as GMO,
 * is refused as unavailable, and no payment goes to another service.
 */
export class UnavailablePaymentGateway
  implements PaymentGateway, PaymentRefundGateway, InPersonCollectionGateway
{
  async binding(): Promise<OnlinePaymentBinding | null> {
    return null;
  }

  async createSession(): Promise<CommercePaymentSessionResultV1> {
    return unavailableSession("payment_provider_unavailable");
  }

  async reconcile(): Promise<CommercePaymentCaptureResultV1> {
    return indeterminatePayment("payment_provider_unavailable");
  }

  async createInPersonCollection(): Promise<CommerceInPersonCollectionResultV1> {
    return unavailableInPersonCollection("payment_provider_unavailable");
  }

  async refund(): Promise<CommercePaymentRefundResultV1> {
    return rejectedRefund("payment_provider_unavailable");
  }
}

export class DeterministicPaymentGateway
  implements PaymentGateway, PaymentRefundGateway
{
  readonly #now: () => string;
  readonly #paymentBinding: OnlinePaymentBinding;
  readonly #paymentProviderBindingId: string;

  constructor(
    now: () => string = currentTimestamp,
    paymentBinding: OnlinePaymentBinding = deterministicStripeBinding(),
    paymentProviderBindingId = "payment_binding_primary_online",
  ) {
    this.#now = now;
    this.#paymentBinding = paymentBinding;
    this.#paymentProviderBindingId = paymentProviderBindingId;
  }

  async binding(
    paymentProviderBindingId: string,
  ): Promise<OnlinePaymentBinding | null> {
    return paymentProviderBindingId === this.#paymentProviderBindingId
      ? this.#paymentBinding
      : null;
  }

  async createSession(
    request: MerchantPaymentSessionCommand,
  ): Promise<CommercePaymentSessionResultV1> {
    return {
      schemaVersion: "underclerk.payment-session-result.v1",
      kind: "ready",
      paymentAttemptId: request.paymentAttemptId,
      session: {
        kind: "embedded_public_session",
        providerSessionReference: `pi_test_${request.providerRequestId}`,
        publicConfiguration: {
          provider: "stripe_online",
          clientSecret: `pi_test_${request.providerRequestId}_secret_deterministic`,
          publishableKey: "pk_test_deterministic",
          connectedAccountId: request.paymentBinding.account.providerAccountId,
        },
        expiresAt: request.expiresAt,
      },
    };
  }

  async reconcile(
    request: MerchantPaymentReconciliationCommand,
  ): Promise<CommercePaymentCaptureResultV1> {
    return {
      schemaVersion: "underclerk.payment-capture-result.v1",
      kind: "captured",
      providerPaymentReference: `pi_test_${request.providerRequestId}`,
      capturedAt: this.#now(),
    };
  }

  async refund(
    request: MerchantPaymentRefundCommand,
  ): Promise<CommercePaymentRefundResultV1> {
    return {
      schemaVersion: "underclerk.payment-refund-result.v1",
      kind: "refunded",
      providerRefundReference: `re_test_${request.refundAttemptId}`,
      money: request.refundMoney,
      refundedAt: this.#now(),
    };
  }
}

function unavailableInPersonCollection(
  reason: string,
): CommerceInPersonCollectionResultV1 {
  return {
    schemaVersion: "underclerk.in-person-collection-result.v1",
    kind: "unavailable",
    reason,
    retryAfter: new Date(Date.now() + 60_000).toISOString(),
  };
}

function unavailableSession(reason: string): CommercePaymentSessionResultV1 {
  return {
    schemaVersion: "underclerk.payment-session-result.v1",
    kind: "unavailable",
    reason,
    retryAfter: new Date(Date.now() + 60_000).toISOString(),
  };
}

function indeterminatePayment(
  reason: string,
): CommercePaymentCaptureResultV1 {
  return {
    schemaVersion: "underclerk.payment-capture-result.v1",
    kind: "indeterminate",
    reason,
    reconcileAfter: new Date(Date.now() + 60_000).toISOString(),
  };
}

function rejectedRefund(reason: string): CommercePaymentRefundResultV1 {
  return {
    schemaVersion: "underclerk.payment-refund-result.v1",
    kind: "rejected",
    reason,
  };
}

function deterministicStripeBinding(): VariantBy<
  OnlinePaymentBinding,
  "provider",
  "stripe_online"
> {
  return {
    provider: "stripe_online",
    account: {
      integrationAccountId: "integration_stripe_deterministic",
      providerAccountId: "acct_deterministic",
      environment: "development",
      capabilityRevision: 1,
      country: "JP",
      currency: "JPY",
    },
    collection: "embedded_tokenization",
  };
}

function currentTimestamp(): string {
  return new Date().toISOString();
}
