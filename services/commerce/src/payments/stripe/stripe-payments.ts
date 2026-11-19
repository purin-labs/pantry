// Stripe payments that Commerce runs itself (Plan 76 phase 3). A merchant
// connects its own Stripe account to the platform's Stripe Connect account.
// Commerce calls Stripe with the platform key and names the merchant's
// account in the Stripe-Account header, so no merchant secret is stored. A
// payment that did not start here (no stored PaymentIntent) and a merchant
// with no connected account go to the fallback gateway: Square, or a refusal
// as unavailable.
import type {
  CommercePaymentCaptureResultV1,
  CommercePaymentRefundResultV1,
  CommercePaymentSessionResultV1,
} from "@purin-labs/commerce-client";
import { CURRENCY_MINOR_UNITS } from "@purin-labs/commerce-client";
import type { OnlinePaymentBinding } from "@purin-labs/commerce-contracts";
import { isRecord } from "@purin-labs/std";
import type { VariantBy } from "@purin-labs/type-utils";

import type { CommerceDatabase } from "../../database.ts";
import type {
  MerchantPaymentReconciliationCommand,
  MerchantPaymentRefundCommand,
  MerchantPaymentSessionCommand,
  PaymentProvider,
} from "../provider.ts";

// The platform account's default version on 2026-10-21.
const STRIPE_API_VERSION = "2026-03-25.dahlia";
const STRIPE_API_ORIGIN = "https://api.stripe.com";
const RETRY_SECONDS = 60;

type StripeOnlineBinding = VariantBy<
  OnlinePaymentBinding,
  "provider",
  "stripe_online"
>;

type StripeEnvironment = "development" | "production";

type StripeResponse =
  | Readonly<{ kind: "ok"; body: Record<string, unknown> }>
  | Readonly<{ kind: "refused"; status: number; code: string | null }>
  | Readonly<{ kind: "unavailable" }>;

/** The platform's Stripe API, acting as itself or as a connected account. */
export class StripeApi {
  readonly environment: StripeEnvironment;
  readonly #secretKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: Readonly<{ secretKey: string; fetch?: typeof fetch }>) {
    const mode = /^(?:sk|rk)_(test|live)_[A-Za-z0-9_]+$/u.exec(
      options.secretKey,
    )?.[1];
    if (mode === undefined)
      throw new Error("STRIPE_SECRET_KEY is not a Stripe secret key");
    this.environment = mode === "live" ? "production" : "development";
    this.#secretKey = options.secretKey;
    this.#fetch = options.fetch ?? fetch.bind(globalThis);
  }

  async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: Readonly<{
      account?: string;
      idempotencyKey?: string;
      form?: Readonly<Record<string, string>>;
      /** A v2 API body. */
      json?: unknown;
    }> = {},
  ): Promise<StripeResponse> {
    const headers = new Headers({
      authorization: `Bearer ${this.#secretKey}`,
      "stripe-version": STRIPE_API_VERSION,
    });
    if (options.account !== undefined)
      headers.set("stripe-account", options.account);
    if (options.idempotencyKey !== undefined)
      headers.set("idempotency-key", options.idempotencyKey);
    let body: URLSearchParams | string | undefined;
    if (options.form !== undefined) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(options.form);
    } else if (options.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.json);
    }
    let response: Response;
    try {
      response = await this.#fetch(`${STRIPE_API_ORIGIN}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      return { kind: "unavailable" };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { kind: "unavailable" };
    }
    if (response.ok && isRecord(payload)) return { kind: "ok", body: payload };
    if (
      response.status >= 500 ||
      response.status === 408 ||
      response.status === 429
    )
      return { kind: "unavailable" };
    const code =
      isRecord(payload) &&
      isRecord(payload.error) &&
      typeof payload.error.code === "string"
        ? payload.error.code
        : null;
    return { kind: "refused", status: response.status, code };
  }
}

type StripeAccountState = "onboarding" | "active" | "restricted";

type StripePaymentAccountV1 = Readonly<{
  provider: "stripe";
  paymentProviderBindingId: string;
  providerAccountId: string;
  environment: StripeEnvironment;
  country: string;
  currency: string;
  state: StripeAccountState;
  updatedAt: string;
}>;

type StripeAccountResult<Value> =
  | Readonly<{ kind: "ok"; value: Value }>
  | Readonly<{ kind: "error"; status: 404 | 409 | 422 | 503; message: string }>;

type AccountRow = Readonly<{
  paymentProviderBindingId: string;
  providerAccountId: string;
  environment: StripeEnvironment;
  country: string;
  currency: string;
  state: StripeAccountState;
  updatedAt: string;
}>;

/** The Stripe accounts that merchants connected, and their payment bindings. */
export class StripePaymentAccounts {
  readonly #database: CommerceDatabase;
  readonly #api: StripeApi;
  readonly #now: () => string;

  constructor(
    options: Readonly<{
      database: CommerceDatabase;
      api: StripeApi;
      now: () => string;
    }>,
  ) {
    this.#database = options.database;
    this.#api = options.api;
    this.#now = options.now;
  }

  get api(): StripeApi {
    return this.#api;
  }

  /**
   * Connects a Stripe account that is already connected to the platform, or
   * reads its state again. Stripe answers only for the platform's own
   * connected accounts, so another platform's account is refused.
   */
  async link(
    merchantId: string,
    body: unknown,
  ): Promise<StripeAccountResult<StripePaymentAccountV1>> {
    if (
      !isRecord(body) ||
      Object.keys(body).some(
        (key) => key !== "paymentProviderBindingId" && key !== "accountId",
      ) ||
      !isReference(body.paymentProviderBindingId) ||
      typeof body.accountId !== "string" ||
      !/^acct_[A-Za-z0-9]+$/u.test(body.accountId)
    )
      return invalid(
        "A Stripe account needs its acct_ id and a payment binding id",
      );
    if (!this.#merchantExists(merchantId))
      return { kind: "error", status: 404, message: "Merchant not found" };
    const owner = this.#byAccount(merchantId, body.accountId);
    if (
      owner !== undefined &&
      owner.paymentProviderBindingId !== body.paymentProviderBindingId
    )
      return {
        kind: "error",
        status: 409,
        message: "This Stripe account has another payment binding",
      };
    const account = await this.#api.request(
      "GET",
      `/v1/accounts/${encodeURIComponent(body.accountId)}`,
    );
    if (account.kind === "unavailable")
      return { kind: "error", status: 503, message: "Stripe is unavailable" };
    if (account.kind === "refused")
      return {
        kind: "error",
        status: 409,
        message:
          "Stripe does not show this account as connected to the platform",
      };
    const parsed = parseAccount(account.body);
    if (parsed === undefined || parsed.id !== body.accountId)
      return {
        kind: "error",
        status: 503,
        message: "Stripe answered with an invalid account",
      };
    this.#store(merchantId, body.paymentProviderBindingId, parsed);
    return {
      kind: "ok",
      value: this.#summary(merchantId, body.paymentProviderBindingId),
    };
  }

  /**
   * Opens Stripe's hosted onboarding for a merchant with no Stripe account:
   * makes an account with the merchant configuration and the full Stripe
   * Dashboard the first time (Accounts v2; Stripe refuses v1 creation for a
   * new Connect platform), then a new one-time link.
   */
  async startOnboarding(
    merchantId: string,
    body: unknown,
  ): Promise<
    StripeAccountResult<
      Readonly<{
        account: StripePaymentAccountV1;
        url: string;
        expiresAt: string;
      }>
    >
  > {
    if (
      !isRecord(body) ||
      Object.keys(body).some(
        (key) =>
          ![
            "paymentProviderBindingId",
            "country",
            "returnUrl",
            "refreshUrl",
          ].includes(key),
      ) ||
      !isReference(body.paymentProviderBindingId) ||
      typeof body.country !== "string" ||
      !/^[A-Z]{2}$/u.test(body.country) ||
      !isHttpsUrl(body.returnUrl) ||
      !isHttpsUrl(body.refreshUrl)
    )
      return invalid(
        "Onboarding needs a payment binding id, a country and https return and refresh URLs",
      );
    if (!this.#merchantExists(merchantId))
      return { kind: "error", status: 404, message: "Merchant not found" };
    let row = this.#row(merchantId, body.paymentProviderBindingId);
    if (row === undefined) {
      const created = await this.#api.request("POST", "/v2/core/accounts", {
        idempotencyKey: `underclerk_account_${merchantId}_${body.paymentProviderBindingId}`,
        json: {
          identity: { country: body.country.toLowerCase() },
          configuration: {
            merchant: { capabilities: { card_payments: { requested: true } } },
          },
          defaults: {
            responsibilities: {
              fees_collector: "stripe",
              losses_collector: "stripe",
            },
          },
          dashboard: "full",
          metadata: { underclerk_merchant_id: merchantId },
          include: ["defaults"],
        },
      });
      if (
        created.kind !== "ok" ||
        created.body.object !== "v2.core.account" ||
        typeof created.body.id !== "string"
      )
        return {
          kind: "error",
          status: 503,
          message: "Stripe did not create the account",
        };
      const defaults = isRecord(created.body.defaults)
        ? created.body.defaults
        : {};
      this.#store(merchantId, body.paymentProviderBindingId, {
        id: created.body.id,
        country: body.country,
        currency:
          typeof defaults.currency === "string" &&
          /^[a-z]{3}$/u.test(defaults.currency)
            ? defaults.currency.toUpperCase()
            : "XXX",
        chargesEnabled: false,
        detailsSubmitted: false,
      });
      row = this.#row(merchantId, body.paymentProviderBindingId);
    }
    if (row === undefined) throw new Error("Stripe account vanished");
    const link = await this.#api.request("POST", "/v2/core/account_links", {
      json: {
        account: row.providerAccountId,
        use_case: {
          type: "account_onboarding",
          account_onboarding: {
            configurations: ["merchant"],
            return_url: String(body.returnUrl),
            refresh_url: String(body.refreshUrl),
          },
        },
      },
    });
    if (
      link.kind !== "ok" ||
      typeof link.body.url !== "string" ||
      typeof link.body.expires_at !== "string"
    )
      return {
        kind: "error",
        status: 503,
        message: "Stripe did not open onboarding",
      };
    return {
      kind: "ok",
      value: {
        account: toSummary(row),
        url: link.body.url,
        expiresAt: link.body.expires_at,
      },
    };
  }

  list(merchantId: string): readonly StripePaymentAccountV1[] {
    return this.#database
      .prepare(
        `${ACCOUNT_SELECT} WHERE merchant_id = ? ORDER BY payment_provider_binding_id`,
      )
      .all<AccountRow>(merchantId)
      .map(toSummary);
  }

  /** The checkout payment binding of an active account. */
  activeBinding(
    merchantId: string,
    paymentProviderBindingId: string,
  ): StripeOnlineBinding | null {
    const row = this.#row(merchantId, paymentProviderBindingId);
    return row?.state === "active" && row.environment === this.#api.environment
      ? stripeBinding(row)
      : null;
  }

  /** Whether this merchant connected the account that a payment names. */
  owns(merchantId: string, providerAccountId: string): boolean {
    const row = this.#byAccount(merchantId, providerAccountId);
    return row !== undefined && row.environment === this.#api.environment;
  }

  #store(
    merchantId: string,
    paymentProviderBindingId: string,
    account: ParsedAccount,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO payment_provider_account (
           merchant_id, payment_provider_binding_id, provider, provider_account_id,
           environment, country, currency, state, updated_at
         ) VALUES (?, ?, 'stripe', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (merchant_id, payment_provider_binding_id) DO UPDATE SET
           provider_account_id = excluded.provider_account_id,
           environment = excluded.environment,
           country = excluded.country,
           currency = excluded.currency,
           state = excluded.state,
           updated_at = excluded.updated_at`,
      )
      .run(
        merchantId,
        paymentProviderBindingId,
        account.id,
        // An account answers only in the mode of the key that reads it.
        this.#api.environment,
        account.country,
        account.currency,
        account.chargesEnabled
          ? "active"
          : account.detailsSubmitted
            ? "restricted"
            : "onboarding",
        this.#now(),
      );
  }

  #merchantExists(merchantId: string): boolean {
    return (
      this.#database
        .prepare("SELECT 1 AS present FROM merchant WHERE merchant_id = ?")
        .get<Readonly<{ present: number }>>(merchantId) !== undefined
    );
  }

  #row(
    merchantId: string,
    paymentProviderBindingId: string,
  ): AccountRow | undefined {
    return this.#database
      .prepare(
        `${ACCOUNT_SELECT} WHERE merchant_id = ? AND payment_provider_binding_id = ?`,
      )
      .get<AccountRow>(merchantId, paymentProviderBindingId);
  }

  #byAccount(
    merchantId: string,
    providerAccountId: string,
  ): AccountRow | undefined {
    return this.#database
      .prepare(
        `${ACCOUNT_SELECT} WHERE merchant_id = ? AND provider_account_id = ?`,
      )
      .get<AccountRow>(merchantId, providerAccountId);
  }

  #summary(
    merchantId: string,
    paymentProviderBindingId: string,
  ): StripePaymentAccountV1 {
    const row = this.#row(merchantId, paymentProviderBindingId);
    if (row === undefined) throw new Error("Stripe account vanished");
    return toSummary(row);
  }
}

/**
 * Runs online Stripe payments for the merchants that connected an account
 * and passes every other payment to the fallback gateway.
 */
type StripePaymentIntentRow = Readonly<{
  paymentIntentId: string;
  providerAccountId: string;
}>;

/** The PaymentIntent that Commerce made for a payment attempt. */
export function readStripePaymentIntent(
  database: CommerceDatabase,
  merchantId: string,
  paymentAttemptId: string,
): StripePaymentIntentRow | undefined {
  return database
    .prepare(
      `SELECT payment_intent_id AS paymentIntentId, provider_account_id AS providerAccountId
       FROM stripe_payment_intent WHERE merchant_id = ? AND payment_attempt_id = ?`,
    )
    .get<StripePaymentIntentRow>(merchantId, paymentAttemptId);
}

export class StripePaymentGateway implements PaymentProvider {
  readonly #accounts: StripePaymentAccounts;
  readonly #database: CommerceDatabase;
  readonly #publishableKey: string;
  readonly #fallback: PaymentProvider;
  readonly #now: () => string;

  constructor(
    options: Readonly<{
      accounts: StripePaymentAccounts;
      database: CommerceDatabase;
      publishableKey: string;
      fallback: PaymentProvider;
      now: () => string;
    }>,
  ) {
    const mode = /^pk_(test|live)_[A-Za-z0-9_]+$/u.exec(
      options.publishableKey,
    )?.[1];
    if (
      (mode === "live" ? "production" : "development") !==
        options.accounts.api.environment ||
      mode === undefined
    )
      throw new Error(
        "STRIPE_PUBLISHABLE_KEY must be a key of the same Stripe mode",
      );
    this.#accounts = options.accounts;
    this.#database = options.database;
    this.#publishableKey = options.publishableKey;
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

  async createSession(
    request: MerchantPaymentSessionCommand,
  ): Promise<CommercePaymentSessionResultV1> {
    const binding = request.paymentBinding;
    if (
      binding.provider !== "stripe_online" ||
      !this.#accounts.owns(
        request.merchantId,
        binding.account.providerAccountId,
      )
    )
      return this.#fallback.createSession(request);
    if (
      binding.collection !== "embedded_tokenization" ||
      !chargeable(request.money)
    )
      return this.#unavailableSession("payment_request_invalid");
    const account = binding.account.providerAccountId;
    const stored = this.#intent(request.merchantId, request.paymentAttemptId);
    const response =
      stored === undefined
        ? await this.#accounts.api.request("POST", "/v1/payment_intents", {
            account,
            idempotencyKey: `underclerk_${request.merchantId}_${request.idempotencyKey}`,
            form: {
              amount: String(request.money.amountMinor),
              currency: request.money.currency.toLowerCase(),
              "automatic_payment_methods[enabled]": "true",
              "automatic_payment_methods[allow_redirects]": "never",
              "metadata[underclerk_merchant_id]": request.merchantId,
              "metadata[underclerk_checkout_id]": request.checkoutId,
              "metadata[underclerk_payment_attempt_id]":
                request.paymentAttemptId,
            },
          })
        : await this.#accounts.api.request(
            "GET",
            `/v1/payment_intents/${encodeURIComponent(stored.paymentIntentId)}`,
            { account },
          );
    if (response.kind !== "ok")
      return this.#unavailableSession("provider_unavailable");
    const intent = parsePaymentIntent(response.body);
    if (
      intent === undefined ||
      intent.paymentAttemptId !== request.paymentAttemptId ||
      intent.amountMinor !== request.money.amountMinor ||
      intent.currency !== request.money.currency ||
      intent.clientSecret === null
    )
      return this.#unavailableSession("provider_response_invalid");
    if (stored === undefined)
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO stripe_payment_intent (
             merchant_id, payment_attempt_id, provider_account_id, payment_intent_id, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          request.merchantId,
          request.paymentAttemptId,
          account,
          intent.id,
          this.#now(),
        );
    return {
      schemaVersion: "underclerk.payment-session-result.v1",
      kind: "ready",
      paymentAttemptId: request.paymentAttemptId,
      session: {
        kind: "embedded_public_session",
        providerSessionReference: intent.id,
        publicConfiguration: {
          provider: "stripe_online",
          clientSecret: intent.clientSecret,
          publishableKey: this.#publishableKey,
          connectedAccountId: account,
        },
        expiresAt: request.expiresAt,
      },
    };
  }

  /** Reads the payment's state from Stripe; nothing the buyer sends decides it. */
  async reconcile(
    request: MerchantPaymentReconciliationCommand,
  ): Promise<CommercePaymentCaptureResultV1> {
    const stored = this.#intent(request.merchantId, request.paymentAttemptId);
    if (stored === undefined) return this.#fallback.reconcile(request);
    const response = await this.#accounts.api.request(
      "GET",
      `/v1/payment_intents/${encodeURIComponent(stored.paymentIntentId)}`,
      { account: stored.providerAccountId },
    );
    if (response.kind !== "ok")
      return this.#indeterminate("provider_unavailable");
    const intent = parsePaymentIntent(response.body);
    if (
      intent === undefined ||
      intent.id !== stored.paymentIntentId ||
      intent.paymentAttemptId !== request.paymentAttemptId ||
      intent.amountMinor !== request.money.amountMinor ||
      intent.currency !== request.money.currency
    )
      return this.#indeterminate("provider_response_invalid");
    switch (intent.status) {
      case "succeeded":
        return {
          schemaVersion: "underclerk.payment-capture-result.v1",
          kind: "captured",
          providerPaymentReference: intent.id,
          capturedAt: this.#now(),
        };
      case "processing":
      case "requires_confirmation":
      case "requires_action":
        return {
          schemaVersion: "underclerk.payment-capture-result.v1",
          kind: "processing",
          reason:
            intent.status === "requires_action"
              ? "payment_authentication_required"
              : "payment_processing",
          reconcileAfter: this.#later(),
        };
      case "requires_payment_method":
        return {
          schemaVersion: "underclerk.payment-capture-result.v1",
          kind: "declined",
          reason: "payment_method_required",
        };
      case "canceled":
        return {
          schemaVersion: "underclerk.payment-capture-result.v1",
          kind: "declined",
          reason: "payment_cancelled",
        };
      default:
        // requires_capture: Commerce asks for automatic capture only.
        return this.#indeterminate("payment_state_unexpected");
    }
  }

  async refund(
    request: MerchantPaymentRefundCommand,
  ): Promise<CommercePaymentRefundResultV1> {
    const binding = request.paymentBinding;
    if (
      binding.provider !== "stripe_online" ||
      !this.#accounts.owns(
        request.merchantId,
        binding.account.providerAccountId,
      )
    )
      return this.#fallback.refund(request);
    if (
      !chargeable(request.refundMoney) ||
      request.refundMoney.currency !== request.money.currency ||
      request.refundMoney.amountMinor > request.money.amountMinor
    )
      return {
        schemaVersion: "underclerk.payment-refund-result.v1",
        kind: "rejected",
        reason: "refund_request_invalid",
      };
    const account = binding.account.providerAccountId;
    const earlier = await this.#earlierRefund(request, account);
    if (earlier !== undefined) return earlier;
    const response = await this.#accounts.api.request("POST", "/v1/refunds", {
      account,
      idempotencyKey: `underclerk_${request.merchantId}_${request.idempotencyKey}`,
      form: {
        payment_intent: request.providerPaymentReference,
        amount: String(request.refundMoney.amountMinor),
        "metadata[underclerk_merchant_id]": request.merchantId,
        "metadata[underclerk_refund_attempt_id]": request.refundAttemptId,
      },
    });
    if (response.kind === "unavailable") return this.#unknownRefund(request);
    if (response.kind === "refused")
      return {
        schemaVersion: "underclerk.payment-refund-result.v1",
        kind: "rejected",
        reason: "refund_rejected",
      };
    return this.#refundResult(request, response.body);
  }

  // A refund that an earlier try left is read, never asked for again: a
  // second POST after Stripe forgets the idempotency key (about a day) would
  // refund twice. A pending refund is read by its id; a lost answer is found
  // by the attempt id in the refund's metadata. Undefined means that no
  // earlier refund exists.
  async #earlierRefund(
    request: MerchantPaymentRefundCommand,
    account: string,
  ): Promise<CommercePaymentRefundResultV1 | undefined> {
    const earlier = request.earlierTry;
    if (earlier === undefined) return undefined;
    if (earlier.kind === "processing") {
      const read = await this.#accounts.api.request(
        "GET",
        `/v1/refunds/${encodeURIComponent(earlier.providerRefundReference)}`,
        { account },
      );
      return read.kind === "ok"
        ? this.#refundResult(request, read.body)
        : {
            schemaVersion: "underclerk.payment-refund-result.v1",
            kind: "processing",
            reconciliationIdentity: earlier.providerRefundReference,
            reconcileAfter: this.#later(),
          };
    }
    const listed = await this.#accounts.api.request(
      "GET",
      `/v1/refunds?payment_intent=${encodeURIComponent(request.providerPaymentReference)}&limit=100`,
      { account },
    );
    if (listed.kind !== "ok" || !Array.isArray(listed.body.data))
      return this.#unknownRefund(request);
    const found = listed.body.data.find(
      (refund: unknown) =>
        isRecord(refund) &&
        isRecord(refund.metadata) &&
        refund.metadata.underclerk_refund_attempt_id ===
          request.refundAttemptId,
    );
    return isRecord(found) ? this.#refundResult(request, found) : undefined;
  }

  #refundResult(
    request: MerchantPaymentRefundCommand,
    refund: Record<string, unknown>,
  ): CommercePaymentRefundResultV1 {
    if (
      refund.object !== "refund" ||
      typeof refund.id !== "string" ||
      refund.amount !== request.refundMoney.amountMinor ||
      typeof refund.currency !== "string" ||
      refund.currency.toUpperCase() !== request.refundMoney.currency
    )
      return this.#unknownRefund(request);
    switch (refund.status) {
      case "succeeded":
        return {
          schemaVersion: "underclerk.payment-refund-result.v1",
          kind: "refunded",
          providerRefundReference: refund.id,
          money: request.refundMoney,
          refundedAt: this.#now(),
        };
      case "pending":
      case "requires_action":
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

  #intent(
    merchantId: string,
    paymentAttemptId: string,
  ): StripePaymentIntentRow | undefined {
    return readStripePaymentIntent(
      this.#database,
      merchantId,
      paymentAttemptId,
    );
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

const ACCOUNT_SELECT = `SELECT
  payment_provider_binding_id AS paymentProviderBindingId,
  provider_account_id AS providerAccountId,
  environment,
  country,
  currency,
  state,
  updated_at AS updatedAt
FROM payment_provider_account`;

type ParsedAccount = Readonly<{
  id: string;
  country: string;
  currency: string;
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
}>;

function parseAccount(raw: Record<string, unknown>): ParsedAccount | undefined {
  if (
    raw.object !== "account" ||
    typeof raw.id !== "string" ||
    typeof raw.country !== "string" ||
    !/^[A-Z]{2}$/u.test(raw.country)
  )
    return undefined;
  // A new account has no default currency until onboarding sets one.
  const currency =
    typeof raw.default_currency === "string" &&
    /^[a-z]{3}$/u.test(raw.default_currency)
      ? raw.default_currency.toUpperCase()
      : "XXX";
  return {
    id: raw.id,
    country: raw.country,
    currency,
    chargesEnabled: raw.charges_enabled === true,
    detailsSubmitted: raw.details_submitted === true,
  };
}

type ParsedPaymentIntent = Readonly<{
  id: string;
  paymentAttemptId: string;
  amountMinor: number;
  currency: string;
  status: string;
  clientSecret: string | null;
}>;

function parsePaymentIntent(
  raw: Record<string, unknown>,
): ParsedPaymentIntent | undefined {
  if (
    raw.object !== "payment_intent" ||
    typeof raw.id !== "string" ||
    typeof raw.amount !== "number" ||
    !Number.isSafeInteger(raw.amount) ||
    typeof raw.currency !== "string" ||
    typeof raw.status !== "string" ||
    !isRecord(raw.metadata) ||
    typeof raw.metadata.underclerk_payment_attempt_id !== "string"
  )
    return undefined;
  return {
    id: raw.id,
    paymentAttemptId: raw.metadata.underclerk_payment_attempt_id,
    amountMinor: raw.amount,
    currency: raw.currency.toUpperCase(),
    status: raw.status,
    clientSecret:
      typeof raw.client_secret === "string" ? raw.client_secret : null,
  };
}

function stripeBinding(row: AccountRow): StripeOnlineBinding {
  return {
    provider: "stripe_online",
    account: {
      integrationAccountId: `underclerk_stripe_${row.providerAccountId}`,
      providerAccountId: row.providerAccountId,
      environment: row.environment,
      capabilityRevision: 1,
      country: row.country,
      currency: row.currency,
    },
    collection: "embedded_tokenization",
  };
}

function toSummary(row: AccountRow): StripePaymentAccountV1 {
  return { provider: "stripe", ...row };
}

// Stripe charges in any currency Commerce sells in and settles to the
// account's own currency (Plan 76A step 4A).
function chargeable(
  money: Readonly<{ amountMinor: number; currency: string }>,
): boolean {
  return (
    Number.isSafeInteger(money.amountMinor) &&
    money.amountMinor > 0 &&
    Object.hasOwn(CURRENCY_MINOR_UNITS, money.currency)
  );
}

function isReference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function invalid(message: string): StripeAccountResult<never> {
  return { kind: "error", status: 422, message };
}
