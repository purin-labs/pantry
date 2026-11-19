import {
  createPrivateKey,
  createPublicKey,
  sign as signPayload,
  type KeyObject,
} from "node:crypto";

import { isMerchantId } from "./merchant-id.ts";
import { DurableObject } from "cloudflare:workers";

import quickjsWasm from "quickjs-wasi/quickjs.wasm?module";

import { CommerceAuthority } from "./commerce-authority.ts";
import { QuickJsFunctionRuntime } from "./plugins/function-runtime.ts";
import type { CommerceSigner } from "./commerce-authority/contracts.ts";
import { DurableObjectCommerceDatabase } from "./durable-object-database.ts";
import { CommerceHttpApi } from "./http.ts";
import { isBuyerRoute, parseRoute } from "./http-routes.ts";
import {
  createSessionThroughSnapshot,
  readCatalogThroughSnapshot,
} from "./catalog-snapshots.ts";
import { migrateOutboxSignatures } from "./entity-plane/outbox-signing-migration.ts";
import { EntityPlaneService } from "./entity-plane/service.ts";
import { BuyerSessionAuthority } from "./buyer-session.ts";
import {
  UnavailablePaymentGateway,
  type PaymentProvider,
} from "./payments/provider.ts";
import { readCommerceMigrationInventory } from "./migration-inventory.ts";
import { createJapanExportShipping } from "./plugins/japan-export/index.ts";
import { initializeCommerceSchema } from "./schema.ts";
import {
  localAddressValidationProvider,
  ShippingAddressValidationService,
} from "./shipping-address-validation.ts";
import { errorMessage, isNormalizedText, isRecord } from "@purin-labs/std";
import {
  CloudflareEmailGateway,
  type CloudflareEmailBinding,
} from "./notification-gateway.ts";
import { FetchWebhookSender, publicHttpsAddress } from "./webhooks.ts";
import { ApiAccess } from "./api-access.ts";
import { FeedConsumers } from "./feed-consumers.ts";
import {
  StripeApi,
  StripePaymentAccounts,
  StripePaymentGateway,
} from "./payments/stripe/stripe-payments.ts";
import {
  SquarePaymentAccounts,
  SquarePaymentGateway,
  SquareTerminalGateway,
} from "./payments/square/square-payments.ts";
import { BankPayouts } from "./payments/bank-payouts.ts";
import { SquareApi } from "./payments/square/square-api.ts";
import { SquareConnections } from "./payments/square/square-connection.ts";
import { CustomerVault } from "./plugins/customers/index.ts";
import { verifiedStripeNotification } from "./payments/stripe/stripe-webhooks.ts";
import type { CommerceApiScope } from "@purin-labs/commerce-client";
import { R2ArchiveStore, type R2BucketLike } from "./archive.ts";
import { R2MediaStore, type R2MediaBucket } from "./plugins/media/index.ts";
import {
  lookUpShopName,
  merchantShopNameRegistry,
  parseShopNameOwner,
  type ShopNameOwner,
} from "./shop-names.ts";
import { handleMcpRequest, mcpMerchantId } from "./mcp-server.ts";

const SHOP_NAME_OWNER_KEY = "owner";

export class UnderclerkShopNameDO extends DurableObject {
  /**
   * Takes the name for a storefront, or moves its pointer to the
   * storefront's current name. Another storefront's name stays taken.
   */
  async claim(owner: ShopNameOwner): Promise<"claimed" | "taken"> {
    const stored = parseShopNameOwner(
      await this.ctx.storage.get(SHOP_NAME_OWNER_KEY),
    );
    if (
      stored !== undefined &&
      (stored.merchantId !== owner.merchantId ||
        stored.storefrontId !== owner.storefrontId)
    )
      return "taken";
    await this.ctx.storage.put(SHOP_NAME_OWNER_KEY, {
      merchantId: owner.merchantId,
      storefrontId: owner.storefrontId,
      currentName: owner.currentName,
    });
    return "claimed";
  }

  async owner(): Promise<ShopNameOwner | null> {
    return (
      parseShopNameOwner(await this.ctx.storage.get(SHOP_NAME_OWNER_KEY)) ??
      null
    );
  }
}

const ARCHIVE_LAST_RUN_KEY = "archive:last_run_ms";
const CUSTOMER_DATA_ROOT_KEY = "customers:data_root_v1";
const ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type Env = Readonly<{
  UNDERCLERK_MERCHANT: DurableObjectNamespace<UnderclerkMerchantDO>;
  /** One object for each shop name (Plan 40B phase 2). */
  UNDERCLERK_SHOP_NAME?: DurableObjectNamespace<UnderclerkShopNameDO>;
  UNDERCLERK_SERVICE_TOKEN: string;
  UNDERCLERK_BUYER_SESSION_SECRET: string;
  UNDERCLERK_SIGNING_KEY_ID: string;
  UNDERCLERK_SIGNING_PRIVATE_KEY_PKCS8_B64: string;
  JAPAN_CARRIER_SIGNING_KEY: string;
  /**
   * The standalone shop site that took over the pages Commerce served
   * before; a page request here moves there.
   */
  SHOP_SITE_ORIGIN?: string;
  /** Cloudflare Email Service binding and sender for buyer email. */
  NOTIFICATION_EMAIL?: CloudflareEmailBinding;
  NOTIFICATION_FROM?: string;
  /**
   * The one R2 bucket (APAC location hint) for archived orders and events
   * and for product image bytes, under separate prefixes.
   */
  BUCKET?: R2BucketLike & R2MediaBucket;
  /**
   * Plan 78: `typescript` makes the TypeScript entity-plane parsers decide.
   * Unset or `rust` keeps the Rust result; both run and are compared.
   */
  /**
   * Stripe payments that Commerce runs itself (Plan 76 phase 3), with the
   * platform's Connect keys and the Connect webhook secret. The secret key
   * alone lets merchants connect accounts; payments also need the
   * publishable key, and without it every online payment is unavailable.
   */
  STRIPE_SECRET_KEY?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /**
   * The Square application that issues merchants' OAuth tokens (Plan 77
   * step 8). Without it a connected Square token is used until it expires.
   */
  SQUARE_OAUTH_CLIENT_ID?: string;
  SQUARE_OAUTH_CLIENT_SECRET?: string;
}>;

export class UnderclerkMerchantDO extends DurableObject<Env> {
  readonly #database: DurableObjectCommerceDatabase;
  readonly #env: Env;
  readonly #access: ApiAccess;
  readonly #stripeAccounts: StripePaymentAccounts | undefined;
  #api: Promise<CommerceHttpApi> | undefined;
  #webhookPass: Promise<void> | undefined;
  #webhookPassAgain = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#database = new DurableObjectCommerceDatabase(ctx.storage);
    this.#env = env;
    initializeCommerceSchema(this.#database, this.now());
    this.#access = new ApiAccess({
      database: this.#database,
      operatorToken: env.UNDERCLERK_SERVICE_TOKEN,
      now: () => this.now(),
    });
    this.#stripeAccounts = this.#connectStripe(env);
  }

  // A wrong Stripe key leaves online payments unavailable; it must not stop
  // the merchant's object.
  #connectStripe(env: Env): StripePaymentAccounts | undefined {
    if (env.STRIPE_SECRET_KEY === undefined) return undefined;
    try {
      return new StripePaymentAccounts({
        database: this.#database,
        api: new StripeApi({ secretKey: env.STRIPE_SECRET_KEY }),
        now: () => this.now(),
      });
    } catch (error) {
      console.warn("underclerk.stripe_unconfigured", errorMessage(error));
      return undefined;
    }
  }

  #stripeGateway(
    fallback: UnavailablePaymentGateway,
  ): StripePaymentGateway | undefined {
    const accounts = this.#stripeAccounts;
    const publishableKey = this.#env.STRIPE_PUBLISHABLE_KEY;
    if (accounts === undefined || publishableKey === undefined)
      return undefined;
    try {
      return new StripePaymentGateway({
        accounts,
        database: this.#database,
        publishableKey,
        fallback,
        now: () => this.now(),
      });
    } catch (error) {
      console.warn("underclerk.stripe_unconfigured", errorMessage(error));
      return undefined;
    }
  }

  // The routes this object answers before the HTTP API: an API key or an
  // app installation needs `access`, the operator token opens them all.
  #refused(
    request: Request,
    merchantId: string,
    access: CommerceApiScope | "operator",
  ): Response | undefined {
    const decision = this.#access.authorize(request, merchantId, access);
    return decision.kind === "allowed"
      ? undefined
      : jsonResponse(decision.status, {
          message: "Unauthorized",
          code: decision.code,
        });
  }

  // The client fixture Worker (tests/fixture-worker) overrides the clock and
  // the payment gateways; production uses these.
  protected now(): string {
    return currentTimestamp();
  }

  /** The addresses that webhooks may post to. */
  protected webhookAddressAllowed(url: string): boolean {
    return publicHttpsAddress(url);
  }

  protected paymentGateways(): Readonly<{
    paymentGateway: PaymentProvider;
  }> {
    const unavailable = new UnavailablePaymentGateway();
    return {
      paymentGateway: this.#stripeGateway(unavailable) ?? unavailable,
    };
  }

  async #migrateOutboxSignatures(signer: CommerceSigner): Promise<void> {
    // v2 runs again for deliveries that a newer receiver parse refused.
    const key = "entity_plane_outbox_signing_migration_v2";
    const stored = await this.ctx.storage.get<unknown>(key);
    if (stored === "complete") return;
    let cursor = typeof stored === "string" ? stored : null;
    while (true) {
      const batch = migrateOutboxSignatures(this.#database, signer, cursor);
      console.info("underclerk.outbox_signing_migration", batch);
      await this.ctx.storage.put(
        key,
        batch.kind === "complete" ? "complete" : batch.afterDeliveryId,
      );
      if (batch.kind === "complete") return;
      cursor = batch.afterDeliveryId;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const commandReceiptLookup = parseCommandReceiptLookup(request);
    if (commandReceiptLookup !== undefined) {
      return this.#readMutationReceipt(request, commandReceiptLookup);
    }
    if (isMigrationInventoryRequest(request)) {
      const merchantId = parseMerchantId(new URL(request.url).pathname);
      if (merchantId === undefined)
        return jsonResponse(404, { message: "Route not found" });
      const refusal = this.#refused(request, merchantId, "operator");
      if (refusal !== undefined) return refusal;
      const inventory = readCommerceMigrationInventory(
        this.#database,
        merchantId,
      );
      return inventory === undefined
        ? jsonResponse(404, { message: "Merchant not found" })
        : jsonResponse(200, inventory);
    }
    const api = await this.#initializedApi();
    // The MCP server's tools call this same API (Plan 40B phase 6).
    const mcpMerchant = mcpMerchantId(request);
    const response =
      mcpMerchant === undefined
        ? await api.handle(request)
        : await handleMcpRequest(request, mcpMerchant, {
            access: this.#access,
            dispatch: (inner) => api.handle(inner),
          });
    // Email and webhooks go out after the command committed; a failure
    // leaves them queued for the alarm.
    this.ctx.waitUntil(api.deliverNotifications().catch(() => 0));
    this.ctx.waitUntil(this.#deliverWebhooks(api));
    this.ctx.waitUntil(this.#runDueWork(api));
    return response;
  }

  // Pantry learns of new events from the merchant's webhook posts and reads
  // the feed every minute as a backstop (Plan 77 step 8), so the alarm only
  // runs the merchant's own queued work.
  async alarm(): Promise<void> {
    await this.#deliverQueuedWork();
  }

  // Email, webhooks, due work and the daily archive. A failure is logged and
  // waits for the next alarm.
  async #deliverQueuedWork(): Promise<void> {
    try {
      const api = await this.#initializedApi();
      await api.deliverNotifications().catch(() => 0);
      await this.#deliverWebhooks(api);
      await this.#runDueWork(api);
      await this.#archiveDaily(api);
    } catch (error) {
      console.warn("underclerk.alarm_delivery_failed", errorMessage(error));
    }
  }

  // Moves finished orders and old events to R2 at most once a day, and keeps
  // a daily alarm so the archive runs without traffic.
  async #archiveDaily(api: CommerceHttpApi): Promise<void> {
    if (this.#env.BUCKET === undefined) return;
    const last = await this.ctx.storage.get<number>(ARCHIVE_LAST_RUN_KEY);
    if (last === undefined || Date.now() - last >= ARCHIVE_INTERVAL_MS) {
      const merchantIds = this.#database
        .prepare("SELECT merchant_id AS merchantId FROM merchant")
        .all<Readonly<{ merchantId: string }>>()
        .map((row) => row.merchantId);
      try {
        await api.runArchive(merchantIds);
        await this.ctx.storage.put(ARCHIVE_LAST_RUN_KEY, Date.now());
      } catch (error) {
        console.warn("underclerk.archive_failed", errorMessage(error));
      }
    }
    const next = Date.now() + ARCHIVE_INTERVAL_MS;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next)
      await this.ctx.storage.setAlarm(next);
  }

  // Reads due pending refunds again and releases the stock of lapsed
  // checkouts, then wakes the object when the next item is due. An item that
  // stays due waits at least a minute, so a failing step cannot spin the
  // alarm.
  async #runDueWork(api: CommerceHttpApi): Promise<void> {
    let next: string | null;
    try {
      next = await api.runDueWork();
    } catch (error) {
      console.warn("underclerk.due_work_failed", errorMessage(error));
      return;
    }
    if (next === null) return;
    const at = Math.max(Date.parse(next), Date.now() + 60_000);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  // One webhook pass at a time: every request starts a pass, and two passes
  // at once would both post a delivery that neither has marked yet. A
  // request during a pass asks for one more pass after it, for the events
  // that the request committed.
  #deliverWebhooks(api: CommerceHttpApi): Promise<void> {
    if (this.#webhookPass !== undefined) {
      this.#webhookPassAgain = true;
      return this.#webhookPass;
    }
    this.#webhookPass = (async () => {
      do {
        this.#webhookPassAgain = false;
        await this.#deliverWebhooksOnce(api);
      } while (this.#webhookPassAgain);
    })().finally(() => {
      this.#webhookPass = undefined;
    });
    return this.#webhookPass;
  }

  // Posts due webhooks, then wakes the object again for the next retry
  // unless an earlier alarm is already set. A retry that stays due waits at
  // least a second, so a delivery that a pass cannot settle cannot spin the
  // alarm.
  async #deliverWebhooksOnce(api: CommerceHttpApi): Promise<void> {
    let next: string | null;
    try {
      next = await api.deliverWebhooks();
    } catch {
      return;
    }
    if (next === null) return;
    const at = Math.max(Date.parse(next), Date.now() + 1_000);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  async #readMutationReceipt(
    request: Request,
    lookup: CommandReceiptLookup,
  ): Promise<Response> {
    const refusal = this.#refused(request, lookup.merchantId, "orders:read");
    if (refusal !== undefined) return refusal;
    const row = this.#database
      .prepare(
        `SELECT receipt_json AS receiptJson
       FROM command_receipt
       WHERE merchant_id = ? AND idempotency_key = ?`,
      )
      .get<{ readonly receiptJson: string }>(
        lookup.merchantId,
        lookup.idempotencyKey,
      );
    if (row === undefined) return jsonResponse(200, null);
    try {
      return jsonResponse(200, JSON.parse(row.receiptJson));
    } catch {
      return jsonResponse(500, {
        message: "Stored command receipt is invalid",
      });
    }
  }

  #initializedApi(): Promise<CommerceHttpApi> {
    if (this.#api === undefined)
      this.#api = this.ctx.blockConcurrencyWhile(this.#createApi.bind(this));
    return this.#api;
  }

  // Each merchant object makes its own root key for customer data on first
  // use and keeps it in its storage. Erasure still works: it deletes the
  // customer's own key, which this root only wraps.
  async #customerDataRoot(): Promise<string> {
    const stored = await this.ctx.storage.get<string>(CUSTOMER_DATA_ROOT_KEY);
    if (stored !== undefined) return stored;
    const root = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("base64url");
    await this.ctx.storage.put(CUSTOMER_DATA_ROOT_KEY, root);
    return root;
  }

  async #createApi(): Promise<CommerceHttpApi> {
    const signer = new Ed25519WorkerSigner(this.#env);
    await this.#migrateOutboxSignatures(signer);
    const now = (): string => this.now();
    const shipping = createJapanExportShipping(
      this.#env.JAPAN_CARRIER_SIGNING_KEY,
    );
    const customerDataRoot = await this.#customerDataRoot();
    const squareConnections = new SquareConnections({
      database: this.#database,
      vault: new CustomerVault(customerDataRoot),
      api: new SquareApi(),
      ...(this.#env.SQUARE_OAUTH_CLIENT_ID === undefined ||
      this.#env.SQUARE_OAUTH_CLIENT_SECRET === undefined
        ? {}
        : {
            oauth: {
              clientId: this.#env.SQUARE_OAUTH_CLIENT_ID,
              clientSecret: this.#env.SQUARE_OAUTH_CLIENT_SECRET,
            },
          }),
      now,
    });
    const squareAccounts = new SquarePaymentAccounts({
      database: this.#database,
      connections: squareConnections,
      now,
    });
    const gateways = this.paymentGateways();
    const authority = new CommerceAuthority({
      database: this.#database,
      signer,
      ...gateways,
      paymentGateway: new SquarePaymentGateway({
        accounts: squareAccounts,
        database: this.#database,
        fallback: gateways.paymentGateway,
        now,
      }),
      inPersonCollectionGateway: new SquareTerminalGateway({
        accounts: squareAccounts,
        database: this.#database,
        now,
      }),
      now,
      shippingGateway: shipping.gateway,
      customerDataRoot,
      shipping,
      functionRuntime: new QuickJsFunctionRuntime(quickjsWasm),
      webhookAddressAllowed: (url) => this.webhookAddressAllowed(url),
    });
    return new CommerceHttpApi({
      authority,
      buyerSessions: new BuyerSessionAuthority({
        secret: this.#env.UNDERCLERK_BUYER_SESSION_SECRET,
        now,
      }),
      addressValidations: new ShippingAddressValidationService({
        database: this.#database,
        provider: localAddressValidationProvider,
        now,
        validitySeconds: 1_800,
      }),
      serviceToken: this.#env.UNDERCLERK_SERVICE_TOKEN,
      access: this.#access,
      feedConsumers: new FeedConsumers({ database: this.#database, now }),
      ...(this.#stripeAccounts === undefined
        ? {}
        : { paymentAccounts: this.#stripeAccounts }),
      squareAccounts,
      bankPayouts: new BankPayouts({
        database: this.#database,
        ...(this.#stripeAccounts === undefined
          ? {}
          : { stripe: this.#stripeAccounts }),
        square: squareAccounts,
        now,
      }),
      webhooks: new FetchWebhookSender(),
      ...(this.#env.UNDERCLERK_SHOP_NAME === undefined
        ? {}
        : {
            shopNames: merchantShopNameRegistry(
              this.ctx.storage,
              this.#env.UNDERCLERK_SHOP_NAME,
              (event, detail) => console.warn(event, detail),
            ),
          }),
      ...(this.#env.BUCKET === undefined
        ? {}
        : {
            archive: new R2ArchiveStore(this.#env.BUCKET),
            media: new R2MediaStore(this.#env.BUCKET),
          }),
      ...(this.#env.NOTIFICATION_EMAIL === undefined ||
      this.#env.NOTIFICATION_FROM === undefined
        ? {}
        : {
            notifications: new CloudflareEmailGateway(
              this.#env.NOTIFICATION_EMAIL,
              this.#env.NOTIFICATION_FROM,
            ),
          }),
      entityPlane: new EntityPlaneService({
        database: this.#database,
        now,
        signer,
      }),
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse(200, { ok: true, service: "underclerk" });
    }
    // Commerce serves no pages. An old shop link opens the shop site.
    if (
      !url.pathname.startsWith("/v1/") &&
      request.method === "GET" &&
      env.SHOP_SITE_ORIGIN !== undefined
    ) {
      return Response.redirect(
        `${env.SHOP_SITE_ORIGIN}${url.pathname}${url.search}`,
        301,
      );
    }
    if (
      url.pathname === "/v1/providers/stripe/webhooks" &&
      request.method === "POST"
    )
      return stripeWebhook(request, env);
    const shopName = /^\/v1\/public\/shop-names\/([^/]+)$/u.exec(url.pathname);
    if (shopName !== null && request.method === "GET")
      return readShopName(env, shopName[1] ?? "");
    // Catalog reads and guest sessions come from the storefront snapshot.
    const buyerRoute = parseRoute(url.pathname, request.method);
    if (
      buyerRoute?.kind === "read_buyer_catalog" ||
      buyerRoute?.kind === "search_buyer_catalog" ||
      buyerRoute?.kind === "create_buyer_session"
    ) {
      const options = {
        sessionSecret: env.UNDERCLERK_BUYER_SESSION_SECRET,
        serviceToken: env.UNDERCLERK_SERVICE_TOKEN,
        merchantObject: env.UNDERCLERK_MERCHANT.getByName(
          merchantObjectName(buyerRoute.merchantId),
        ),
      };
      return buyerRoute.kind === "create_buyer_session"
        ? createSessionThroughSnapshot(request, buyerRoute, options)
        : readCatalogThroughSnapshot(request, buyerRoute, options);
    }
    // The merchant object checks the credential of an admin request: the
    // operator token, or an API key or app installation kept in that
    // merchant's own database.
    if (
      !isBuyerRequest(request) &&
      (url.pathname.startsWith("/v1/public/") ||
        !request.headers.get("authorization")?.startsWith("Bearer "))
    ) {
      return jsonResponse(401, { message: "Unauthorized" });
    }
    const merchantId = parseMerchantId(url.pathname);
    if (merchantId === undefined)
      return jsonResponse(404, { message: "Route not found" });
    return env.UNDERCLERK_MERCHANT.getByName(
      merchantObjectName(merchantId),
    ).fetch(request);
  },
};

// A shop site asks which storefront a name opens. A name that no shop holds
// answers 404, as an unknown name of any form does.
async function readShopName(env: Env, raw: string): Promise<Response> {
  if (env.UNDERCLERK_SHOP_NAME === undefined)
    return jsonResponse(503, { message: "Shop names are unavailable" });
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return jsonResponse(404, { message: "Shop not found" });
  }
  const found = await lookUpShopName(env.UNDERCLERK_SHOP_NAME, name);
  if (found === undefined)
    return jsonResponse(404, { message: "Shop not found" });
  const response = jsonResponse(200, found);
  response.headers.set("cache-control", "public, max-age=30");
  return response;
}

class Ed25519WorkerSigner implements CommerceSigner {
  readonly keyId: string;
  readonly publicKeyB64: string;
  readonly #privateKey: KeyObject;

  constructor(env: Env) {
    this.keyId = requireText(
      env.UNDERCLERK_SIGNING_KEY_ID,
      "UNDERCLERK_SIGNING_KEY_ID",
    );
    this.#privateKey = createPrivateKey({
      key: Buffer.from(
        requireText(
          env.UNDERCLERK_SIGNING_PRIVATE_KEY_PKCS8_B64,
          "UNDERCLERK_SIGNING_PRIVATE_KEY_PKCS8_B64",
        ),
        "base64url",
      ),
      format: "der",
      type: "pkcs8",
    });
    const publicJwk = createPublicKey(this.#privateKey).export({
      format: "jwk",
    });
    if (
      publicJwk.kty !== "OKP" ||
      publicJwk.crv !== "Ed25519" ||
      publicJwk.x === undefined
    ) {
      throw new Error("Underclerk signing key must be Ed25519");
    }
    this.publicKeyB64 = publicJwk.x;
  }

  sign(payload: Uint8Array): string {
    return signPayload(null, payload, this.#privateKey).toString("base64url");
  }
}

// Stripe's Connect notifications. A notification of an Commerce payment
// asks that merchant's object to settle the attempt; the object reads the
// payment from Stripe. Any failure answers 500, so Stripe sends it again.
export async function stripeWebhook(
  request: Request,
  env: Pick<
    Env,
    | "STRIPE_WEBHOOK_SECRET"
    | "STRIPE_SECRET_KEY"
    | "UNDERCLERK_MERCHANT"
    | "UNDERCLERK_SERVICE_TOKEN"
  >,
  // Stripe's API; a journey passes its own.
  stripeFetch?: typeof fetch,
): Promise<Response> {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (secret === undefined)
    return jsonResponse(404, { message: "Route not found" });
  const body = await request.text();
  const notification = verifiedStripeNotification(
    body,
    request.headers.get("stripe-signature"),
    secret,
    Math.floor(Date.now() / 1_000),
  );
  if (notification === undefined)
    return jsonResponse(400, { message: "Invalid Stripe signature" });
  if (notification.kind === "ignored")
    return jsonResponse(200, { received: true });
  if (notification.kind === "dispute")
    return stripeDispute(notification, body, env, stripeFetch);
  const merchant = encodeURIComponent(notification.merchantId);
  const attempt = encodeURIComponent(notification.paymentAttemptId);
  try {
    const settled = await env.UNDERCLERK_MERCHANT.getByName(
      merchantObjectName(notification.merchantId),
    ).fetch(
      new Request(
        `https://underclerk.internal/v1/internal/merchants/${merchant}/payment-attempts/${attempt}/settlement`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${env.UNDERCLERK_SERVICE_TOKEN}` },
        },
      ),
    );
    if (!settled.ok) return jsonResponse(500, { message: "Settlement failed" });
    const body: unknown = await settled.json();
    return isRecord(body) && body.state === "conflict"
      ? jsonResponse(500, { message: "Settlement conflict" })
      : jsonResponse(200, { received: true });
  } catch (error) {
    console.warn("underclerk.stripe_webhook_failed", errorMessage(error));
    return jsonResponse(500, { message: "Settlement failed" });
  }
}

// A dispute of an Commerce payment goes to the merchant whose metadata the
// PaymentIntent carries. A PaymentIntent without it is not Commerce's, and
// its dispute is acknowledged and left alone. A refused
// dispute cannot change on a retry, so it is acknowledged with a warning.
async function stripeDispute(
  notification: Readonly<{
    eventId: string;
    accountId: string;
    paymentIntentId: string;
  }>,
  body: string,
  env: Pick<
    Env,
    "STRIPE_SECRET_KEY" | "UNDERCLERK_MERCHANT" | "UNDERCLERK_SERVICE_TOKEN"
  >,
  stripeFetch: typeof fetch | undefined,
): Promise<Response> {
  if (env.STRIPE_SECRET_KEY === undefined)
    return jsonResponse(200, { received: true });
  const intent = await new StripeApi({
    secretKey: env.STRIPE_SECRET_KEY,
    ...(stripeFetch === undefined ? {} : { fetch: stripeFetch }),
  }).request(
    "GET",
    `/v1/payment_intents/${encodeURIComponent(notification.paymentIntentId)}`,
    { account: notification.accountId },
  );
  if (intent.kind === "unavailable")
    return jsonResponse(500, { message: "Stripe is unavailable" });
  const metadata =
    intent.kind === "ok" && isRecord(intent.body.metadata)
      ? intent.body.metadata
      : {};
  const merchantId = metadata.underclerk_merchant_id;
  const paymentAttemptId = metadata.underclerk_payment_attempt_id;
  if (typeof merchantId !== "string" || typeof paymentAttemptId !== "string")
    return jsonResponse(200, { received: true });
  try {
    const observed = await env.UNDERCLERK_MERCHANT.getByName(
      merchantObjectName(merchantId),
    ).fetch(
      new Request(
        `https://underclerk.internal/v1/internal/merchants/${encodeURIComponent(merchantId)}/payment-attempts/${encodeURIComponent(paymentAttemptId)}/stripe-disputes`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.UNDERCLERK_SERVICE_TOKEN}`,
            "content-type": "application/json",
          },
          body,
        },
      ),
    );
    if (!observed.ok) return jsonResponse(500, { message: "Dispute failed" });
    const result: unknown = await observed.json();
    if (isRecord(result) && result.outcome === "rejected")
      console.warn(
        "underclerk.stripe_dispute_refused",
        notification.eventId,
        JSON.stringify(result.error),
      );
    return jsonResponse(200, { received: true });
  } catch (error) {
    console.warn("underclerk.stripe_dispute_failed", errorMessage(error));
    return jsonResponse(500, { message: "Dispute failed" });
  }
}

// Generation 2 starts empty: storage written before the Organisation rename
// is never read.
function merchantObjectName(merchantId: string): string {
  return `${merchantId}:g2`;
}

function parseMerchantId(pathname: string): string | undefined {
  const match = pathname.match(
    /^\/v1\/(?:admin|public|internal)\/merchants\/([^/]+)(?:\/|$)/u,
  );
  if (match?.[1] === undefined) return undefined;
  try {
    const merchantId = decodeURIComponent(match[1]);
    return isMerchantId(merchantId) ? merchantId : undefined;
  } catch {
    return undefined;
  }
}

type CommandReceiptLookup = Readonly<{
  merchantId: string;
  idempotencyKey: string;
}>;

function parseCommandReceiptLookup(
  request: Request,
): CommandReceiptLookup | undefined {
  if (request.method !== "GET") return undefined;
  const match = new URL(request.url).pathname.match(
    /^\/v1\/admin\/merchants\/([^/]+)\/command-receipts\/([^/]+)$/u,
  );
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const merchantId = parsePathSegment(match[1]);
  const idempotencyKey = parsePathSegment(match[2]);
  return merchantId === undefined || idempotencyKey === undefined
    ? undefined
    : { merchantId, idempotencyKey };
}

function parsePathSegment(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 &&
      decoded === decoded.trim() &&
      !decoded.includes("/")
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}

// A buyer route of the route table. The merchant object checks the buyer's
// session where the route needs one; every other public path is refused here.
function isBuyerRequest(request: Request): boolean {
  const route = parseRoute(new URL(request.url).pathname, request.method);
  return route !== undefined && isBuyerRoute(route);
}

function isMigrationInventoryRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  return /^\/v1\/admin\/merchants\/[^/]+\/migration-inventory$/u.test(
    new URL(request.url).pathname,
  );
}

function currentTimestamp(): string {
  return new Date().toISOString();
}

function requireText(value: string, field: string): string {
  if (!isNormalizedText(value))
    throw new Error(`${field} must be normalized text`);
  return value;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
