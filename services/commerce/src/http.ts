import { functionScope } from "./plugins/function-runtime.ts";
import { commandActor } from "./command-actor.ts";
import type { CommerceFetch } from "@purin-labs/commerce-client";
import { CommerceAuthority } from "./commerce-authority.ts";
import type { NotificationGateway } from "./notification-gateway.ts";
import type { WebhookSender } from "./webhooks.ts";
import type { ArchiveStore } from "./archive.ts";
import type { MediaStore } from "./plugins/media/index.ts";
import { isBuyerRoute, matchRoute } from "./http-routes.ts";
import { BuyerSessionAuthority } from "./buyer-session.ts";
import type { BuyerAccountGateway } from "./buyer-account.ts";
import { ShippingAddressValidationService } from "./shipping-address-validation.ts";
import { EntityPlaneService } from "./entity-plane/service.ts";
import type { ApiAccess } from "./api-access.ts";
import type { BankPayouts } from "./payments/bank-payouts.ts";
import type { SquarePaymentAccounts } from "./payments/square/square-payments.ts";
import type { StripePaymentAccounts } from "./payments/stripe/stripe-payments.ts";
import type { FeedConsumers } from "./feed-consumers.ts";
import type { ShopNameRegistry } from "./shop-names.ts";
import {
  admitAdminRequest,
  commandRequest,
  pausedPlugin,
} from "./http/admission.ts";
import type { HttpRouteContext } from "./http/context.ts";
import { requireToken } from "./http/request-body.ts";
import { jsonResponse } from "./http/responses.ts";
import { customerBuyerAccountGateway } from "./http/routes/buyer-account.ts";
import { handleBuyerRoute } from "./http/routes/buyer.ts";
import { handleServiceRoute } from "./http/routes/service.ts";

type CommerceHttpApiOptions = Readonly<{
  authority: CommerceAuthority;
  buyerSessions: BuyerSessionAuthority;
  addressValidations?: ShippingAddressValidationService;
  serviceToken: string;
  /**
   * API keys and app installations of this merchant database. Without it,
   * only the operator token (serviceToken) opens the admin routes.
   */
  access?: ApiAccess;
  /** Event feed readers that keep their cursor here. */
  feedConsumers?: FeedConsumers;
  /** Connected Stripe accounts; without them Commerce runs no Stripe payment itself. */
  paymentAccounts?: StripePaymentAccounts;
  /** Connected Square locations; without them Commerce runs no Square payment itself. */
  squareAccounts?: SquarePaymentAccounts;
  /** The money that the providers send to the bank; without it the read is empty. */
  bankPayouts?: BankPayouts;
  notifications?: NotificationGateway;
  webhooks?: WebhookSender;
  archive?: ArchiveStore;
  /** Product image bytes; without it uploads are refused and the catalog lists no uploads. */
  media?: MediaStore;
  /** Shop names (Plan 40B phase 2); without it the shop name routes answer 503. */
  shopNames?: ShopNameRegistry;
  entityPlane?: EntityPlaneService;
}>;

export class CommerceHttpApi {
  readonly #authority: CommerceAuthority;
  readonly #buyerSessions: BuyerSessionAuthority;
  readonly #addressValidations: ShippingAddressValidationService | undefined;
  readonly #serviceToken: string;
  readonly #access: ApiAccess | undefined;
  readonly #paymentAccounts: StripePaymentAccounts | undefined;
  readonly #squareAccounts: SquarePaymentAccounts | undefined;
  readonly #bankPayouts: BankPayouts | undefined;
  readonly #feedConsumers: FeedConsumers | undefined;
  readonly #buyerAccounts: BuyerAccountGateway;
  readonly #entityPlane: EntityPlaneService | undefined;
  readonly #notifications: NotificationGateway | undefined;
  readonly #webhooks: WebhookSender | undefined;
  readonly #archive: ArchiveStore | undefined;
  readonly #media: MediaStore | undefined;
  readonly #shopNames: ShopNameRegistry | undefined;
  readonly #routes: HttpRouteContext;

  constructor(options: CommerceHttpApiOptions) {
    this.#authority = options.authority;
    this.#buyerSessions = options.buyerSessions;
    this.#addressValidations = options.addressValidations;
    this.#serviceToken = requireToken(options.serviceToken);
    this.#access = options.access;
    this.#paymentAccounts = options.paymentAccounts;
    this.#squareAccounts = options.squareAccounts;
    this.#bankPayouts = options.bankPayouts;
    this.#feedConsumers = options.feedConsumers;
    this.#buyerAccounts = customerBuyerAccountGateway(
      options.authority,
      options.buyerSessions,
      options.addressValidations,
    );
    this.#entityPlane = options.entityPlane;
    this.#notifications = options.notifications;
    this.#webhooks = options.webhooks;
    this.#archive = options.archive;
    this.#media = options.media;
    this.#shopNames = options.shopNames;
    this.#routes = {
      authority: this.#authority,
      buyerSessions: this.#buyerSessions,
      addressValidations: this.#addressValidations,
      serviceToken: this.#serviceToken,
      access: this.#access,
      paymentAccounts: this.#paymentAccounts,
      squareAccounts: this.#squareAccounts,
      bankPayouts: this.#bankPayouts,
      feedConsumers: this.#feedConsumers,
      buyerAccounts: this.#buyerAccounts,
      entityPlane: this.#entityPlane,
      notifications: this.#notifications,
      webhooks: this.#webhooks,
      archive: this.#archive,
      media: this.#media,
      shopNames: this.#shopNames,
    };
  }

  /**
   * When the archive may next move a record of a merchant in this object, or
   * null when it cannot, or when no archive is bound.
   */
  nextArchiveDueAt(merchantIds: readonly string[]): number | null {
    if (this.#archive === undefined) return null;
    const due = merchantIds
      .map((merchantId) => this.#authority.nextArchiveDueAt(merchantId))
      .filter((time): time is number => time !== null);
    return due.length === 0 ? null : Math.min(...due);
  }

  /** Archives every merchant in this object; the Worker alarm runs it when due. */
  async runArchive(merchantIds: readonly string[]): Promise<number> {
    if (this.#archive === undefined) return 0;
    let moved = 0;
    for (const merchantId of merchantIds) {
      const run = await this.#authority.runArchive(merchantId, this.#archive);
      moved += run.orders + run.events;
    }
    return moved;
  }

  /** Posts due webhook deliveries; returns when the next retry is due. */
  async deliverWebhooks(): Promise<string | null> {
    if (this.#webhooks === undefined) return null;
    return (await this.#authority.dispatchWebhooks(this.#webhooks))
      .nextAttemptAt;
  }

  /**
   * Reads again the refunds that wait on the payment provider and are due;
   * returns when the next one is due. The Worker runs it from its alarm.
   */
  async reconcileRefunds(): Promise<string | null> {
    return this.#authority.reconcilePendingRefunds();
  }

  /**
   * Releases the stock that lapsed checkouts hold; returns when the next
   * quote lapses. The Worker runs it from its alarm.
   */
  expireLapsedCheckouts(): string | null {
    return this.#authority.expireLapsedCheckouts();
  }

  /**
   * Reports merchant plugin function failures as events, and pauses a plugin
   * at its third failure in a row. The Worker runs it after each response
   * and from its alarm.
   */
  reportPluginFailures(): number {
    return this.#authority.reportPluginFailures();
  }

  /**
   * Runs merchant plugin event handlers on new events. The Worker runs it
   * after each response and from its alarm, before failures are reported.
   */
  runPluginHandlers(): Promise<string | null> {
    return this.#authority.runPluginHandlers();
  }

  /**
   * The alarm's timed work; returns when the earliest next item is due. Each
   * pass runs on its own: a pass that throws is logged and runs again a
   * minute later, and the other passes still run (Refactor 15, S3).
   */
  async runDueWork(): Promise<string | null> {
    const passes: readonly DueWorkPass[] = [
      { name: "plugin_handlers", run: () => this.runPluginHandlers() },
      {
        name: "plugin_failures",
        run: async () => {
          this.reportPluginFailures();
          return null;
        },
      },
      { name: "refunds_due", run: () => this.reconcileRefunds() },
      {
        name: "terminal_sales_due",
        run: () => this.#authority.reconcilePendingTerminalSales(),
      },
      {
        name: "payment_due",
        run: () => this.#authority.reconcileDuePayments(),
      },
      {
        name: "lapsed_checkouts",
        run: async () => this.expireLapsedCheckouts(),
      },
      {
        name: "lot_expiry",
        run: async () => this.#authority.expireLapsedLots(),
      },
      {
        name: "overdue_invoices",
        run: async () => this.#authority.markOverdueInvoices(),
      },
    ];
    const next: string[] = [];
    for (const pass of passes) {
      try {
        const due = await pass.run();
        if (due !== null) next.push(due);
      } catch (error) {
        console.warn(
          "commerce.due_work_pass_failed",
          pass.name,
          error instanceof Error ? error.message : String(error),
        );
        next.push(new Date(Date.now() + 60_000).toISOString());
      }
    }
    return next.sort()[0] ?? null;
  }

  /**
   * Sends the notifications that committed commands queued. The Worker runs
   * it after each response and from its alarm; with no gateway they wait.
   */
  async deliverNotifications(): Promise<number> {
    return this.#notifications === undefined
      ? 0
      : this.#authority.deliverNotifications(this.#notifications);
  }

  readonly fetch: CommerceFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    return this.handle(request);
  };

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const matched = matchRoute(url.pathname, request.method);
    if (matched === undefined) {
      return jsonResponse(404, { message: "Route not found" });
    }
    const { route, definition } = matched;
    const respond = async (): Promise<Response> => {
      if (isBuyerRoute(route))
        return (
          pausedPlugin(this.#routes, route) ??
          handleBuyerRoute(this.#routes, request, route)
        );
      const admitted = admitAdminRequest(this.#routes, request, route);
      if (admitted instanceof Response) return admitted;
      const paused = pausedPlugin(this.#routes, route);
      if (paused !== undefined) return paused;
      return commandActor.run(admitted, async () => {
        if (definition.command === undefined)
          return handleServiceRoute(this.#routes, request, url, route);
        const command = await commandRequest(
          this.#routes,
          request,
          route,
          definition.command,
        );
        return command instanceof Response
          ? command
          : handleServiceRoute(this.#routes, command, url, route);
      });
    };
    // A merchant's plugin functions run inside the synchronous checkout
    // commit, so their clean VMs start before it (Plan 77 step 4).
    const vms =
      request.method === "GET" || !("merchantId" in route)
        ? undefined
        : await this.#authority.prepareFunctionVms(route.merchantId);
    if (vms === undefined) return respond();
    try {
      return await functionScope.run(vms, respond);
    } finally {
      vms.dispose();
    }
  }
}

/** One named pass of the alarm's timed work. */
type DueWorkPass = Readonly<{
  name: string;
  run: () => Promise<string | null>;
}>;
