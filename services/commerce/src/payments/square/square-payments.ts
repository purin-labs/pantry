// Square payments that Commerce runs itself (Plan 77 step 8). A merchant
// connects its Square account (square-connection.ts, Plan 80 step 4) and
// lets locations of that account take payments; Commerce calls Square with
// the connection's token. Online, the buyer's browser
// turns a card into a one-time source token with Square's Web Payments SDK,
// and Commerce makes the payment from that token. At the counter,
// Commerce sends a Terminal checkout to the location's Square Terminal and
// reads the payment it took. A payment of another provider, and a merchant
// with no Square location, go to the fallback gateway: Stripe, or a refusal
// as unavailable.
import { createHash } from "node:crypto";

import type {
  CommerceInPersonCollectionResultV1,
  CommercePaymentCaptureResultV1,
  CommercePaymentRefundResultV1,
  CommercePaymentSessionResultV1,
} from "@purin-labs/commerce-client";
import type {
  InPersonPaymentBinding,
  InPersonPaymentMethod,
  OnlinePaymentBinding,
} from "@purin-labs/commerce-contracts";
import { isRecord } from "@purin-labs/std";
import type { VariantBy } from "@purin-labs/type-utils";

import type { CommerceDatabase } from "../../database.ts";
import type {
  InPersonCollectionGateway,
  MerchantInPersonCollectionCommand,
  MerchantPaymentReconciliationCommand,
  MerchantPaymentRefundCommand,
  MerchantPaymentSessionCommand,
  PaymentProvider,
} from "../provider.ts";
import type { SquareApi, SquareEnvironment } from "./square-api.ts";
import {
  isReference,
  type SquareConnections,
  type SquareResult,
} from "./square-connection.ts";

const RETRY_SECONDS = 60;
/** A Terminal checkout that waits for the card is read again this soon. */
const TERMINAL_RETRY_SECONDS = 5;
/** Square limits a refund reason to 192 characters. */
const REASON_LIMIT = 192;

type SquareOnlineBinding = VariantBy<
  OnlinePaymentBinding,
  "provider",
  "square_online"
>;

type SquareTerminalBinding = VariantBy<
  InPersonPaymentBinding,
  "provider",
  "square_terminal"
>;

/** What an online and a Terminal binding both name: a location of an account. */
type SquareLocationBinding = Readonly<{
  locationId: string;
  account: Readonly<{ providerAccountId: string; currency: string }>;
}>;

type SquarePaymentAccountV1 = Readonly<{
  provider: "square";
  paymentProviderBindingId: string;
  providerAccountId: string;
  locationId: string;
  environment: SquareEnvironment;
  country: string;
  currency: string;
  state: "active";
  updatedAt: string;
}>;

type SquareAccountResult<Value> = SquareResult<Value>;

type AccountRow = Readonly<{
  paymentProviderBindingId: string;
  providerAccountId: string;
  locationId: string;
  applicationId: string;
  environment: SquareEnvironment;
  country: string;
  currency: string;
  updatedAt: string;
}>;

/**
 * The locations of the merchant's Square connection that take payments
 * here, each under a payment binding id. Calls use the connection's token.
 */
export class SquarePaymentAccounts {
  readonly #database: CommerceDatabase;
  readonly #connections: SquareConnections;
  readonly #now: () => string;

  constructor(
    options: Readonly<{
      database: CommerceDatabase;
      connections: SquareConnections;
      now: () => string;
    }>,
  ) {
    this.#database = options.database;
    this.#connections = options.connections;
    this.#now = options.now;
  }

  get api(): SquareApi {
    return this.#connections.api;
  }

  get connections(): SquareConnections {
    return this.#connections;
  }

  /**
   * Lets a location of the connected account take payments under a binding
   * id. Commerce reads the location first, so a location that cannot take
   * card payments is refused.
   */
  async link(
    merchantId: string,
    body: unknown,
  ): Promise<SquareAccountResult<SquarePaymentAccountV1>> {
    if (
      !isRecord(body) ||
      Object.keys(body).some(
        (key) => key !== "paymentProviderBindingId" && key !== "locationId",
      ) ||
      !isReference(body.paymentProviderBindingId) ||
      !isReference(body.locationId)
    )
      return invalid(
        "A Square location needs a payment binding id and its location id",
      );
    const bindingId = body.paymentProviderBindingId;
    const locationId = body.locationId;
    const connection = this.#connections.read(merchantId);
    if (connection === undefined)
      return { kind: "error", status: 409, message: "Square is not connected" };
    const locationOwner = this.#database
      .prepare(
        `SELECT payment_provider_binding_id AS bindingId FROM square_payment_account
         WHERE merchant_id = ? AND location_id = ?`,
      )
      .get<Readonly<{ bindingId: string }>>(merchantId, locationId);
    const stripeOwner = this.#database
      .prepare(
        `SELECT 1 AS found FROM payment_provider_account
         WHERE merchant_id = ? AND payment_provider_binding_id = ?`,
      )
      .get<Readonly<{ found: number }>>(merchantId, bindingId);
    if (
      stripeOwner !== undefined ||
      (locationOwner !== undefined && locationOwner.bindingId !== bindingId)
    )
      return {
        kind: "error",
        status: 409,
        message: "This location or payment binding belongs to another account",
      };
    const location = await this.#connections.location(merchantId, locationId);
    if (location.kind !== "ok")
      return location.status === 404
        ? {
            kind: "error",
            status: 409,
            message: "Square does not show this location to the connection",
          }
        : location;
    if (!location.value.cardPayments)
      return {
        kind: "error",
        status: 409,
        message: "This Square location cannot take card payments",
      };
    this.#database
      .prepare(
        `INSERT INTO square_payment_account (
           merchant_id, payment_provider_binding_id, provider_account_id,
           location_id, country, currency, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (merchant_id, payment_provider_binding_id) DO UPDATE SET
           provider_account_id = excluded.provider_account_id,
           location_id = excluded.location_id,
           country = excluded.country,
           currency = excluded.currency,
           updated_at = excluded.updated_at`,
      )
      .run(
        merchantId,
        bindingId,
        connection.providerAccountId,
        locationId,
        location.value.country,
        location.value.currency,
        this.#now(),
      );
    const row = this.#row(merchantId, bindingId);
    if (row === undefined) throw new Error("Square account was not stored");
    return { kind: "ok", value: toSummary(row) };
  }

  list(merchantId: string): readonly SquarePaymentAccountV1[] {
    return this.#database
      .prepare(
        `${ACCOUNT_SELECT} WHERE account.merchant_id = ? ORDER BY account.payment_provider_binding_id`,
      )
      .all<AccountRow>(merchantId)
      .map(toSummary);
  }

  activeBinding(
    merchantId: string,
    paymentProviderBindingId: string,
  ): SquareOnlineBinding | null {
    const row = this.#row(merchantId, paymentProviderBindingId);
    return row === undefined ? null : squareBinding(row);
  }

  /** The binding id of the merchant's account for a Square payment binding. */
  bindingIdFor(
    merchantId: string,
    binding: SquareLocationBinding,
  ): string | undefined {
    return this.#database
      .prepare(
        `SELECT payment_provider_binding_id AS bindingId FROM square_payment_account
         WHERE merchant_id = ? AND location_id = ? AND provider_account_id = ?`,
      )
      .get<Readonly<{ bindingId: string }>>(
        merchantId,
        binding.locationId,
        binding.account.providerAccountId,
      )?.bindingId;
  }

  /**
   * The environment and a token that is valid now for a linked location: the
   * connection refreshes a token close to its expiry first.
   */
  async credential(
    merchantId: string,
    paymentProviderBindingId: string,
  ): Promise<
    | Readonly<{ environment: SquareEnvironment; accessToken: string }>
    | undefined
  > {
    const row = this.#row(merchantId, paymentProviderBindingId);
    if (row === undefined) return undefined;
    const credential = await this.#connections.credential(merchantId);
    return credential === undefined ||
      credential.providerAccountId !== row.providerAccountId
      ? undefined
      : {
          environment: credential.environment,
          accessToken: credential.accessToken,
        };
  }

  #row(
    merchantId: string,
    paymentProviderBindingId: string,
  ): AccountRow | undefined {
    return this.#database
      .prepare(
        `${ACCOUNT_SELECT} WHERE account.merchant_id = ? AND account.payment_provider_binding_id = ?`,
      )
      .get<AccountRow>(merchantId, paymentProviderBindingId);
  }
}

type SquarePaymentRow = Readonly<{
  paymentProviderBindingId: string;
  idempotencyKey: string;
  sourceToken: string | null;
  paymentId: string | null;
}>;

export class SquarePaymentGateway implements PaymentProvider {
  readonly #accounts: SquarePaymentAccounts;
  readonly #database: CommerceDatabase;
  readonly #fallback: PaymentProvider;
  readonly #now: () => string;

  constructor(
    options: Readonly<{
      accounts: SquarePaymentAccounts;
      database: CommerceDatabase;
      fallback: PaymentProvider;
      now: () => string;
    }>,
  ) {
    this.#accounts = options.accounts;
    this.#database = options.database;
    this.#fallback = options.fallback;
    this.#now = options.now;
  }

  async binding(
    paymentProviderBindingId: string,
    merchantId: string,
  ): Promise<OnlinePaymentBinding | null> {
    return (
      this.#accounts.activeBinding(merchantId, paymentProviderBindingId) ??
      this.#fallback.binding(paymentProviderBindingId, merchantId)
    );
  }

  /** The buyer's browser tokenizes the card with Square's Web Payments SDK. */
  async createSession(
    request: MerchantPaymentSessionCommand,
  ): Promise<CommercePaymentSessionResultV1> {
    const binding = request.paymentBinding;
    if (
      binding.provider !== "square_online" ||
      this.#accounts.bindingIdFor(request.merchantId, binding) === undefined
    )
      return this.#fallback.createSession(request);
    if (!payable(request.money, binding))
      return this.#unavailableSession("payment_request_invalid");
    return {
      schemaVersion: "underclerk.payment-session-result.v1",
      kind: "ready",
      paymentAttemptId: request.paymentAttemptId,
      session: {
        kind: "embedded_public_session",
        providerSessionReference: request.paymentAttemptId,
        publicConfiguration: {
          provider: "square_online",
          applicationId: binding.applicationId,
          locationId: binding.locationId,
          environment: binding.account.environment,
        },
        expiresAt: request.expiresAt,
      },
    };
  }

  /**
   * Makes the payment from the buyer's source token, or reads the payment
   * that an earlier try made. A try whose answer was lost sends the same
   * token under the same idempotency key again, and Square answers with the
   * payment it already made.
   */
  async reconcile(
    request: MerchantPaymentReconciliationCommand,
  ): Promise<CommercePaymentCaptureResultV1> {
    const binding = request.paymentBinding;
    if (binding.provider === "square_terminal")
      return this.#reconcileTerminal(request, binding);
    if (binding.provider !== "square_online")
      return this.#fallback.reconcile(request);
    const bindingId = this.#accounts.bindingIdFor(request.merchantId, binding);
    if (bindingId === undefined) return this.#fallback.reconcile(request);
    if (!payable(request.money, binding))
      return this.#indeterminate("payment_request_invalid");
    let row = this.#payment(request.merchantId, request.paymentAttemptId);
    if (row === undefined) {
      if (request.confirmation.kind !== "square_source_token")
        return {
          schemaVersion: "underclerk.payment-capture-result.v1",
          kind: "declined",
          reason: "payment_method_required",
        };
      const sourceToken = request.confirmation.sourceToken;
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO square_payment (
             merchant_id, payment_attempt_id, payment_provider_binding_id,
             idempotency_key, source_token, payment_id, created_at
           ) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          request.merchantId,
          request.paymentAttemptId,
          bindingId,
          squareKey(
            request.merchantId,
            request.paymentAttemptId,
            request.idempotencyKey,
            sourceToken,
          ),
          sourceToken,
          this.#now(),
        );
      row = this.#payment(request.merchantId, request.paymentAttemptId);
      if (row === undefined) throw new Error("Square payment was not stored");
    }
    const credential = await this.#accounts.credential(
      request.merchantId,
      row.paymentProviderBindingId,
    );
    if (credential === undefined)
      return this.#indeterminate("payment_credential_unavailable");
    const response =
      row.paymentId !== null
        ? await this.#accounts.api.request(
            credential.environment,
            credential.accessToken,
            "GET",
            `/v2/payments/${encodeURIComponent(row.paymentId)}`,
          )
        : await this.#accounts.api.request(
            credential.environment,
            credential.accessToken,
            "POST",
            "/v2/payments",
            {
              source_id: row.sourceToken,
              idempotency_key: row.idempotencyKey,
              amount_money: {
                amount: request.money.amountMinor,
                currency: request.money.currency,
              },
              autocomplete: true,
              location_id: binding.locationId,
              reference_id: paymentReference(
                request.merchantId,
                request.paymentAttemptId,
              ),
              note: `Underclerk ${request.paymentAttemptId}`,
            },
          );
    if (response.kind === "unavailable")
      return this.#indeterminate("provider_unavailable");
    if (response.kind === "refused") {
      // A refused payment cannot pay on a retry; the buyer may try another
      // card, which gets a new token and so a new idempotency key.
      if (row.paymentId === null) this.#forget(request);
      return {
        schemaVersion: "underclerk.payment-capture-result.v1",
        kind: "declined",
        reason:
          response.category === "PAYMENT_METHOD_ERROR"
            ? "payment_declined"
            : "payment_request_refused",
      };
    }
    const payment = parsePayment(response.body.payment);
    if (
      payment === undefined ||
      payment.referenceId !==
        paymentReference(request.merchantId, request.paymentAttemptId) ||
      payment.amountMinor !== request.money.amountMinor ||
      payment.currency !== request.money.currency
    )
      return this.#indeterminate("provider_response_invalid");
    if (row.paymentId === null)
      this.#database
        .prepare(
          `UPDATE square_payment SET payment_id = ?, source_token = NULL
           WHERE merchant_id = ? AND payment_attempt_id = ?`,
        )
        .run(payment.id, request.merchantId, request.paymentAttemptId);
    switch (payment.status) {
      case "COMPLETED":
        return {
          schemaVersion: "underclerk.payment-capture-result.v1",
          kind: "captured",
          providerPaymentReference: payment.id,
          capturedAt: this.#now(),
        };
      case "APPROVED":
      case "PENDING":
        return {
          schemaVersion: "underclerk.payment-capture-result.v1",
          kind: "processing",
          reason: "payment_processing",
          reconcileAfter: this.#later(),
        };
      case "CANCELED":
        return {
          schemaVersion: "underclerk.payment-capture-result.v1",
          kind: "declined",
          reason: "payment_cancelled",
        };
      case "FAILED":
        return {
          schemaVersion: "underclerk.payment-capture-result.v1",
          kind: "declined",
          reason: "payment_declined",
        };
      default:
        return this.#indeterminate("payment_state_unexpected");
    }
  }

  /**
   * Reads the Terminal checkout of a counter payment. A completed checkout
   * is evidence that a payment exists, not proof of what was collected, so
   * the payment itself is read and checked: card, location, the exact
   * amount and no tip.
   */
  async #reconcileTerminal(
    request: MerchantPaymentReconciliationCommand,
    binding: SquareTerminalBinding,
  ): Promise<CommercePaymentCaptureResultV1> {
    const row = readTerminalCheckout(
      this.#database,
      request.merchantId,
      request.paymentAttemptId,
    );
    if (row === undefined) return this.#fallback.reconcile(request);
    if (!payable(request.money, binding))
      return this.#indeterminate("payment_request_invalid");
    const credential = await this.#accounts.credential(
      request.merchantId,
      row.paymentProviderBindingId,
    );
    if (credential === undefined)
      return this.#indeterminate("payment_credential_unavailable");
    const read = await this.#accounts.api.request(
      credential.environment,
      credential.accessToken,
      "GET",
      `/v2/terminals/checkouts/${encodeURIComponent(row.checkoutId)}`,
    );
    if (read.kind !== "ok") return this.#indeterminate("provider_unavailable");
    const checkout = read.body.checkout;
    if (!isRecord(checkout) || checkout.id !== row.checkoutId)
      return this.#indeterminate("provider_response_invalid");
    switch (checkout.status) {
      case "PENDING":
      case "IN_PROGRESS":
      case "CANCEL_REQUESTED":
        // The buyer stands at the counter, so the merchant's alarm reads
        // the Terminal again within seconds.
        return {
          schemaVersion: "underclerk.payment-capture-result.v1",
          kind: "processing",
          reason: "payment_processing",
          reconcileAfter: new Date(
            Date.parse(this.#now()) + TERMINAL_RETRY_SECONDS * 1_000,
          ).toISOString(),
        };
      case "CANCELED":
        return {
          schemaVersion: "underclerk.payment-capture-result.v1",
          kind: "declined",
          reason: "payment_cancelled",
        };
      case "COMPLETED":
        break;
      default:
        return this.#indeterminate("payment_state_unexpected");
    }
    const paymentId = Array.isArray(checkout.payment_ids)
      ? checkout.payment_ids[0]
      : undefined;
    if (typeof paymentId !== "string")
      return this.#indeterminate("provider_response_invalid");
    const paid = await this.#accounts.api.request(
      credential.environment,
      credential.accessToken,
      "GET",
      `/v2/payments/${encodeURIComponent(paymentId)}`,
    );
    if (paid.kind !== "ok") return this.#indeterminate("provider_unavailable");
    const payment = parsePayment(paid.body.payment);
    const raw = paid.body.payment;
    const tip =
      isRecord(raw) && isRecord(raw.tip_money) ? raw.tip_money.amount : 0;
    const tenderEvidence =
      isRecord(raw) ? verifySquareTerminalTender(row.paymentMethod, raw) : undefined;
    if (
      payment === undefined ||
      !isRecord(raw) ||
      tenderEvidence === undefined ||
      payment.id !== paymentId ||
      payment.status !== "COMPLETED" ||
      raw.location_id !== binding.locationId ||
      payment.amountMinor !== request.money.amountMinor ||
      payment.currency !== request.money.currency ||
      tip !== 0
    )
      return this.#indeterminate("provider_response_invalid");
    return {
      schemaVersion: "underclerk.payment-capture-result.v1",
      kind: "captured",
      providerPaymentReference: payment.id,
      capturedAt: this.#now(),
      paymentMethod: row.paymentMethod,
      tenderBrand: tenderEvidence.tenderBrand,
      providerRefundable: tenderEvidence.providerRefundable,
    };
  }

  async refund(
    request: MerchantPaymentRefundCommand,
  ): Promise<CommercePaymentRefundResultV1> {
    const binding = request.paymentBinding;
    if (
      binding.provider !== "square_online" &&
      binding.provider !== "square_terminal"
    )
      return this.#fallback.refund(request);
    const bindingId = this.#accounts.bindingIdFor(request.merchantId, binding);
    if (bindingId === undefined) return this.#fallback.refund(request);
    if (
      !payable(request.refundMoney, binding) ||
      request.refundMoney.currency !== request.money.currency ||
      request.refundMoney.amountMinor > request.money.amountMinor
    )
      return {
        schemaVersion: "underclerk.payment-refund-result.v1",
        kind: "rejected",
        reason: "refund_request_invalid",
      };
    const credential = await this.#accounts.credential(
      request.merchantId,
      bindingId,
    );
    if (credential === undefined) return this.#unknownRefund(request);
    const earlier = await this.#earlierRefund(request, credential);
    if (earlier !== undefined) return earlier;
    const response = await this.#accounts.api.request(
      credential.environment,
      credential.accessToken,
      "POST",
      "/v2/refunds",
      {
        idempotency_key: squareKey(
          request.merchantId,
          request.refundAttemptId,
          request.idempotencyKey,
        ),
        payment_id: request.providerPaymentReference,
        amount_money: {
          amount: request.refundMoney.amountMinor,
          currency: request.refundMoney.currency,
        },
        reason: refundReason(request),
      },
    );
    if (response.kind === "unavailable") return this.#unknownRefund(request);
    if (response.kind === "refused")
      return {
        schemaVersion: "underclerk.payment-refund-result.v1",
        kind: "rejected",
        reason: "refund_rejected",
      };
    return this.#refundResult(request, response.body.refund);
  }

  // A refund that an earlier try left is read, never asked for again. A
  // pending refund is read by its id; a lost answer is found among the
  // payment's refunds by the attempt id in the refund's reason. Undefined
  // means that no earlier refund exists.
  async #earlierRefund(
    request: MerchantPaymentRefundCommand,
    credential: Readonly<{
      environment: SquareEnvironment;
      accessToken: string;
    }>,
  ): Promise<CommercePaymentRefundResultV1 | undefined> {
    const earlier = request.earlierTry;
    if (earlier === undefined) return undefined;
    if (earlier.kind === "processing") {
      const read = await this.#accounts.api.request(
        credential.environment,
        credential.accessToken,
        "GET",
        `/v2/refunds/${encodeURIComponent(earlier.providerRefundReference)}`,
      );
      return read.kind === "ok"
        ? this.#refundResult(request, read.body.refund)
        : {
            schemaVersion: "underclerk.payment-refund-result.v1",
            kind: "processing",
            reconciliationIdentity: earlier.providerRefundReference,
            reconcileAfter: this.#later(),
          };
    }
    const payment = await this.#accounts.api.request(
      credential.environment,
      credential.accessToken,
      "GET",
      `/v2/payments/${encodeURIComponent(request.providerPaymentReference)}`,
    );
    if (payment.kind !== "ok" || !isRecord(payment.body.payment))
      return this.#unknownRefund(request);
    const refundIds = payment.body.payment.refund_ids;
    for (const refundId of Array.isArray(refundIds) ? refundIds : []) {
      if (typeof refundId !== "string") continue;
      const read = await this.#accounts.api.request(
        credential.environment,
        credential.accessToken,
        "GET",
        `/v2/refunds/${encodeURIComponent(refundId)}`,
      );
      if (read.kind !== "ok") return this.#unknownRefund(request);
      const refund = read.body.refund;
      if (
        isRecord(refund) &&
        typeof refund.reason === "string" &&
        refund.reason.endsWith(refundMarker(request))
      )
        return this.#refundResult(request, refund);
    }
    return undefined;
  }

  #refundResult(
    request: MerchantPaymentRefundCommand,
    refund: unknown,
  ): CommercePaymentRefundResultV1 {
    if (
      !isRecord(refund) ||
      typeof refund.id !== "string" ||
      !isRecord(refund.amount_money) ||
      refund.amount_money.amount !== request.refundMoney.amountMinor ||
      refund.amount_money.currency !== request.refundMoney.currency
    )
      return this.#unknownRefund(request);
    switch (refund.status) {
      case "COMPLETED":
        return {
          schemaVersion: "underclerk.payment-refund-result.v1",
          kind: "refunded",
          providerRefundReference: refund.id,
          money: request.refundMoney,
          refundedAt: this.#now(),
        };
      case "PENDING":
        return {
          schemaVersion: "underclerk.payment-refund-result.v1",
          kind: "processing",
          reconciliationIdentity: refund.id,
          reconcileAfter: this.#later(),
        };
      default:
        return {
          schemaVersion: "underclerk.payment-refund-result.v1",
          kind: "rejected",
          reason: "refund_rejected",
        };
    }
  }

  #unknownRefund(
    request: MerchantPaymentRefundCommand,
  ): CommercePaymentRefundResultV1 {
    return {
      schemaVersion: "underclerk.payment-refund-result.v1",
      kind: "indeterminate",
      reconciliationIdentity: request.idempotencyKey,
      reconcileAfter: this.#later(),
    };
  }

  #payment(
    merchantId: string,
    paymentAttemptId: string,
  ): SquarePaymentRow | undefined {
    return this.#database
      .prepare(
        `SELECT payment_provider_binding_id AS paymentProviderBindingId,
                idempotency_key AS idempotencyKey, source_token AS sourceToken,
                payment_id AS paymentId
         FROM square_payment WHERE merchant_id = ? AND payment_attempt_id = ?`,
      )
      .get<SquarePaymentRow>(merchantId, paymentAttemptId);
  }

  #forget(request: MerchantPaymentReconciliationCommand): void {
    this.#database
      .prepare(
        "DELETE FROM square_payment WHERE merchant_id = ? AND payment_attempt_id = ? AND payment_id IS NULL",
      )
      .run(request.merchantId, request.paymentAttemptId);
  }

  #later(): string {
    return new Date(
      Date.parse(this.#now()) + RETRY_SECONDS * 1_000,
    ).toISOString();
  }

  #unavailableSession(reason: string): CommercePaymentSessionResultV1 {
    return {
      schemaVersion: "underclerk.payment-session-result.v1",
      kind: "unavailable",
      reason,
      retryAfter: this.#later(),
    };
  }

  #indeterminate(reason: string): CommercePaymentCaptureResultV1 {
    return {
      schemaVersion: "underclerk.payment-capture-result.v1",
      kind: "indeterminate",
      reason,
      reconcileAfter: this.#later(),
    };
  }
}

/**
 * Sends counter payments to the location's Square Terminal. A sale on
 * another provider, or on a Square location that no account here connects,
 * is refused as unavailable.
 */
export class SquareTerminalGateway implements InPersonCollectionGateway {
  readonly #accounts: SquarePaymentAccounts;
  readonly #database: CommerceDatabase;
  readonly #now: () => string;

  constructor(
    options: Readonly<{
      accounts: SquarePaymentAccounts;
      database: CommerceDatabase;
      now: () => string;
    }>,
  ) {
    this.#accounts = options.accounts;
    this.#database = options.database;
    this.#now = options.now;
  }

  /**
   * Starts the Terminal checkout, or reads the one that an earlier try
   * started: Square answers a repeated request under the same idempotency
   * key with the checkout it already made.
   */
  async createInPersonCollection(
    request: MerchantInPersonCollectionCommand,
  ): Promise<CommerceInPersonCollectionResultV1> {
    const binding = request.paymentBinding;
    if (binding.provider !== "square_terminal") {
      return this.#unavailable("payment_authority_unavailable");
    }
    const bindingId = this.#accounts.bindingIdFor(request.merchantId, binding);
    if (bindingId === undefined)
      return this.#unavailable("payment_authority_unavailable");
    if (
      binding.transport !== "server_terminal" ||
      !payable(request.money, binding)
    )
      return this.#unavailable("payment_request_invalid");
    const credential = await this.#accounts.credential(
      request.merchantId,
      bindingId,
    );
    if (credential === undefined)
      return this.#unavailable("payment_credential_unavailable");
    const paymentMethod: InPersonPaymentMethod = request.paymentMethod ?? "card";
    const response = await this.#accounts.api.request(
      credential.environment,
      credential.accessToken,
      "POST",
      "/v2/terminals/checkouts",
      {
        idempotency_key: squareKey(
          request.merchantId,
          request.paymentAttemptId,
          request.idempotencyKey,
        ),
        checkout: {
          amount_money: {
            amount: request.money.amountMinor,
            currency: request.money.currency,
          },
          reference_id: paymentReference(
            request.merchantId,
            request.paymentAttemptId,
          ),
          note: `${request.receiptSummary.merchantName.slice(0, 200)} (${request.receiptSummary.lineCount})`,
          payment_type: squareTerminalPaymentType(paymentMethod),
          device_options: {
            device_id: binding.deviceId,
            // A tip would make the collected total differ from the quote.
            tip_settings: { allow_tipping: false },
          },
          payment_options: {
            autocomplete: true,
            accept_partial_authorization: false,
          },
        },
      },
    );
    if (response.kind !== "ok")
      return this.#unavailable(
        response.kind === "unavailable"
          ? "provider_unavailable"
          : "provider_refused",
      );
    const checkout = response.body.checkout;
    if (
      !isRecord(checkout) ||
      typeof checkout.id !== "string" ||
      checkout.reference_id !==
        paymentReference(request.merchantId, request.paymentAttemptId) ||
      !isRecord(checkout.device_options) ||
      checkout.device_options.device_id !== binding.deviceId
    )
      return this.#unavailable("provider_response_invalid");
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO square_terminal_checkout (
           merchant_id, payment_attempt_id, payment_provider_binding_id,
           checkout_id, payment_method, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.merchantId,
        request.paymentAttemptId,
        bindingId,
        checkout.id,
        paymentMethod,
        this.#now(),
      );
    return {
      schemaVersion: "underclerk.in-person-collection-result.v1",
      kind: "ready",
      paymentAttemptId: request.paymentAttemptId,
      session: {
        kind: "server_terminal_checkout",
        providerCheckoutReference: checkout.id,
        deviceId: binding.deviceId,
        expiresAt: request.expiresAt,
      },
    };
  }

  #unavailable(reason: string): CommerceInPersonCollectionResultV1 {
    return {
      schemaVersion: "underclerk.in-person-collection-result.v1",
      kind: "unavailable",
      reason,
      retryAfter: new Date(
        Date.parse(this.#now()) + RETRY_SECONDS * 1_000,
      ).toISOString(),
    };
  }
}

type TerminalCheckoutRow = Readonly<{
  paymentProviderBindingId: string;
  checkoutId: string;
  paymentMethod: InPersonPaymentMethod;
}>;

function readTerminalCheckout(
  database: CommerceDatabase,
  merchantId: string,
  paymentAttemptId: string,
): TerminalCheckoutRow | undefined {
  return database
    .prepare(
      `SELECT payment_provider_binding_id AS paymentProviderBindingId,
              checkout_id AS checkoutId,
              payment_method AS paymentMethod
       FROM square_terminal_checkout WHERE merchant_id = ? AND payment_attempt_id = ?`,
    )
    .get<TerminalCheckoutRow>(merchantId, paymentAttemptId);
}

function squareTerminalPaymentType(
  method: InPersonPaymentMethod,
): "CARD_PRESENT" | "FELICA_ALL" | "QR_CODE" {
  switch (method) {
    case "card":
      return "CARD_PRESENT";
    case "felica":
      return "FELICA_ALL";
    case "qr_code":
      return "QR_CODE";
  }
}

function verifySquareTerminalTender(
  method: InPersonPaymentMethod,
  raw: Readonly<Record<string, unknown>>,
): Readonly<{ tenderBrand: string; providerRefundable: boolean }> | undefined {
  switch (method) {
    case "card": {
      if (raw.source_type !== "CARD") return undefined;
      const cardDetails = isRecord(raw.card_details)
        ? raw.card_details
        : undefined;
      const card =
        cardDetails !== undefined && isRecord(cardDetails.card)
          ? cardDetails.card
          : undefined;
      const brand =
        card !== undefined &&
        typeof card.card_brand === "string" &&
        card.card_brand.trim().length > 0
          ? card.card_brand.trim()
          : "CARD";
      return { tenderBrand: brand, providerRefundable: true };
    }
    case "felica": {
      if (raw.source_type !== "FELICA" || !isRecord(raw.felica_details)) {
        return undefined;
      }
      const brand =
        typeof raw.felica_details.brand === "string" &&
        raw.felica_details.brand.trim().length > 0
          ? raw.felica_details.brand.trim()
          : "FELICA";
      return { tenderBrand: brand, providerRefundable: false };
    }
    case "qr_code": {
      if (raw.source_type !== "WALLET" || !isRecord(raw.wallet_details)) {
        return undefined;
      }
      const brand =
        typeof raw.wallet_details.brand === "string" &&
        raw.wallet_details.brand.trim().length > 0
          ? raw.wallet_details.brand.trim()
          : "WALLET";
      return { tenderBrand: brand, providerRefundable: true };
    }
  }
}

// A location takes payments only while its account is the connected one.
const ACCOUNT_SELECT = `SELECT
  account.payment_provider_binding_id AS paymentProviderBindingId,
  account.provider_account_id AS providerAccountId,
  account.location_id AS locationId,
  connection.application_id AS applicationId,
  connection.environment AS environment,
  account.country AS country,
  account.currency AS currency,
  account.updated_at AS updatedAt
FROM square_payment_account AS account
JOIN square_connection AS connection
  ON connection.merchant_id = account.merchant_id
 AND connection.provider_account_id = account.provider_account_id`;

type ParsedPayment = Readonly<{
  id: string;
  referenceId: string | null;
  amountMinor: number;
  currency: string;
  status: string;
}>;

function parsePayment(raw: unknown): ParsedPayment | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    typeof raw.status !== "string" ||
    !isRecord(raw.amount_money) ||
    typeof raw.amount_money.amount !== "number" ||
    !Number.isSafeInteger(raw.amount_money.amount) ||
    typeof raw.amount_money.currency !== "string"
  )
    return undefined;
  return {
    id: raw.id,
    referenceId: typeof raw.reference_id === "string" ? raw.reference_id : null,
    amountMinor: raw.amount_money.amount,
    currency: raw.amount_money.currency,
    status: raw.status,
  };
}

function squareBinding(row: AccountRow): SquareOnlineBinding {
  return {
    provider: "square_online",
    account: {
      integrationAccountId: `underclerk_square_${row.providerAccountId}`,
      providerAccountId: row.providerAccountId,
      environment: row.environment,
      capabilityRevision: 1,
      country: row.country,
      currency: row.currency,
    },
    applicationId: row.applicationId,
    locationId: row.locationId,
  };
}

function toSummary(row: AccountRow): SquarePaymentAccountV1 {
  return {
    provider: "square",
    paymentProviderBindingId: row.paymentProviderBindingId,
    providerAccountId: row.providerAccountId,
    locationId: row.locationId,
    environment: row.environment,
    country: row.country,
    currency: row.currency,
    state: "active",
    updatedAt: row.updatedAt,
  };
}

/** Square takes payments only in the location's own currency. */
function payable(
  money: Readonly<{ amountMinor: number; currency: string }>,
  binding: SquareLocationBinding,
): boolean {
  return (
    Number.isSafeInteger(money.amountMinor) &&
    money.amountMinor > 0 &&
    money.currency === binding.account.currency
  );
}

/** Square takes idempotency keys of at most 45 characters. */
function squareKey(...parts: readonly string[]): string {
  return createHash("sha256")
    .update(parts.join("\n"))
    .digest("hex")
    .slice(0, 40);
}

/** Square limits a payment's reference to 40 characters. */
function paymentReference(
  merchantId: string,
  paymentAttemptId: string,
): string {
  return squareKey(merchantId, paymentAttemptId);
}

function refundMarker(request: MerchantPaymentRefundCommand): string {
  return ` [${request.refundAttemptId}]`;
}

function refundReason(request: MerchantPaymentRefundCommand): string {
  const marker = refundMarker(request);
  return `${request.reason.slice(0, Math.max(0, REASON_LIMIT - marker.length))}${marker}`;
}

function invalid(message: string): SquareAccountResult<never> {
  return { kind: "error", status: 422, message };
}
