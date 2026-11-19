// Who may call a merchant's admin routes (Plan 76 phase 2). The operator
// token opens every route. An API key or an app installation token opens the
// routes of its scopes, on its own merchant only: the credential lives in
// that merchant's database, so another merchant's object never finds it.
//
// An app installation token is checked against the token that the current
// operator token derives, not against the hash stored at install. When the
// operator token is rotated, every earlier app token stops at once, and the
// app's operator goes on with the token it derives from the new one: no app
// needs to be installed again.
//
// Each credential moves through CREDENTIAL_MACHINE (Refactor 15, refactor
// 11): `active`, then `revoked` or `expired`. A key that an app installation
// issued names it as its parent, and a revoke reaches every key below the
// revoked credential. An app installed again after a revoke gets a random
// nonce in its token, so the revoked token stays refused. A merchant whose
// Organisation ended is closed: every credential is revoked, and none is
// issued again.
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  COMMERCE_API_KEY_PREFIX,
  COMMERCE_API_SCOPES,
  COMMERCE_APP_TOKEN_PREFIX,
  isCommerceApiScope,
  commerceAppInstallationId,
  commerceAppInstallationToken,
  commerceAppTokenMessage,
  type CommerceApiScope,
} from "@seams/commerce-client";
import { commerceTransition } from "@seams/commerce-contracts";
import { isRecord } from "@seams/std";

import type { CommerceDatabase } from "./database.ts";
import type { BuyerRoute, CommerceRoute } from "./http-routes.ts";
import { COLLECTIONS_ROUTE_ACCESS } from "./plugins/collections/index.ts";
import { MEDIA_ROUTE_ACCESS } from "./plugins/media/index.ts";
import { MARKETS_ROUTE_ACCESS } from "./plugins/markets/index.ts";
import { DISCOUNTS_ROUTE_ACCESS } from "./plugins/discounts/index.ts";
import { CUSTOMERS_ROUTE_ACCESS } from "./plugins/customers/index.ts";
import { DRAFT_ORDERS_ROUTE_ACCESS } from "./plugins/draft-orders/index.ts";
import { RETURNS_ROUTE_ACCESS } from "./plugins/returns/index.ts";
import { STORED_VALUE_ROUTE_ACCESS } from "./plugins/stored-value/index.ts";
import { FOOD_SERVICE_ROUTE_ACCESS } from "./plugins/food-service/index.ts";
import { PURCHASING_ROUTE_ACCESS } from "./plugins/purchasing/index.ts";
import { PRODUCTION_DEMAND_ROUTE_ACCESS } from "./plugins/production-demand/index.ts";
import { COMPANIES_ROUTE_ACCESS } from "./plugins/companies/index.ts";

type AdminRouteKind = Exclude<CommerceRoute, BuyerRoute>["kind"];

/** The scope each admin route needs; "operator" routes take only the operator token. */
const ADMIN_ROUTE_ACCESS: Readonly<
  Record<AdminRouteKind, CommerceApiScope | "operator">
> = {
  provision_merchant: "operator",
  provision_demo: "operator",
  run_archive: "operator",
  read_migration_inventory: "operator",
  // A merchant manages its own API keys (Plan 80 step 3).
  issue_api_key: "credentials:write",
  list_api_credentials: "credentials:write",
  revoke_api_key: "credentials:write",
  install_app: "operator",
  read_app_installation: "operator",
  uninstall_app: "operator",
  // Platform closes the merchant of an Organisation that it purges.
  close_merchant: "operator",
  // Only the Worker calls it, after it checked a provider notification.
  settle_online_payment: "operator",
  observe_stripe_dispute: "operator",
  read_catalog_snapshot: "operator",
  read_feed_consumer: "events:read",
  advance_feed_consumer: "events:read",
  list_payment_accounts: "settings:read",
  link_stripe_account: "settings:write",
  start_stripe_onboarding: "settings:write",
  link_square_account: "settings:write",
  connect_square: "settings:write",
  read_square_connection: "settings:read",
  disconnect_square: "settings:write",
  list_square_locations: "settings:read",
  list_square_devices: "settings:read",
  create_square_device_code: "settings:write",
  read_square_device_code: "settings:read",

  read_snapshot: "orders:read",
  read_events: "events:read",
  acknowledge_delivery: "events:read",
  create_webhook_subscription: "webhooks:write",
  restart_webhook_subscription: "webhooks:write",
  rotate_webhook_secret: "webhooks:write",
  delete_webhook_subscription: "webhooks:write",
  list_webhook_subscriptions: "events:read",

  update_product: "catalog:write",
  delete_product: "catalog:write",
  update_product_description: "catalog:write",
  update_variant: "catalog:write",
  update_offer: "catalog:write",
  update_storefront_tax: "settings:write",
  adjust_offer_price: "catalog:write",
  set_offer_price_policy: "catalog:write",
  disable_offer_price_policy: "catalog:write",
  read_offer_price_policy: "catalog:read",
  prepare_catalog_listing: "catalog:write",
  publish_catalog_listing: "catalog:write",
  place_channel_listing: "catalog:write",

  create_inventory_item: "inventory:write",
  open_inventory_position: "inventory:write",
  receive_inventory: "inventory:write",
  reconcile_inventory: "inventory:write",
  read_stock_snapshot: "inventory:read",

  create_pickup_checkout: "orders:write",
  create_in_person_checkout: "orders:write",
  begin_checkout_payment: "orders:write",
  collect_in_person_checkout_payment: "orders:write",
  record_counter_cash_payment: "orders:write",
  reconcile_counter_sale_payment: "orders:write",
  reconcile_counter_sale_refund: "orders:write",
  read_counter_sale: "orders:read",
  place_paid_checkout: "orders:write",
  expire_checkout: "orders:write",
  record_checkout_payment_capture: "payments:record",
  observe_payment_dispute: "payments:record",
  resolve_checkout_payment: "payments:record",
  read_order_record: "orders:read",
  read_order_changes: "orders:read",
  read_product_sales: "orders:read",
  read_failed_payments: "orders:read",
  read_payments: "orders:read",
  list_unplaced_captures: "orders:read",
  resolve_unplaced_capture: "orders:write",
  read_order_times: "orders:read",
  read_bank_payouts: "orders:read",
  edit_order: "orders:write",
  cancel_order: "orders:write",
  refund_order: "orders:write",
  refund_order_tenders: "orders:write",
  mark_pickup_ready: "orders:write",
  complete_pickup: "orders:write",
  quote_shipment_label_rate: "orders:write",
  purchase_shipping_label: "orders:write",
  attach_fulfillment_tracking: "orders:write",
  record_shipping_tracking: "orders:write",
  record_order_manual_payment: "orders:write",
  list_plugins: "settings:read",
  preview_plugin_change: "settings:read",
  pause_plugin: "settings:write",
  resume_plugin: "settings:write",
  configure_plugin: "settings:write",
  remove_plugin: "settings:write",
  install_merchant_plugin: "settings:write",
  set_plugin_field_values: "catalog:write",
  list_plugin_field_values: "catalog:read",
  run_plugin_function: "settings:read",
  // The call also needs the scope of each command that the plugin submits.
  run_plugin_action: "settings:read",
  preview_merchant_plugin: "settings:read",

  list_notifications: "customers:read",

  create_location: "settings:write",
  configure_pickup_storefront: "settings:write",
  configure_shipping_storefront: "settings:write",
  list_storefronts: "settings:read",
  read_storefront: "settings:read",
  read_storefront_shop_name: "settings:read",
  set_storefront_shop_name: "settings:write",
  list_checkout_profiles: "settings:read",
  list_checkout_profile_activations: "settings:read",
  create_checkout_profile: "settings:write",
  read_checkout_profile: "settings:read",
  replace_checkout_profile_draft: "settings:write",
  publish_checkout_profile: "settings:write",
  retire_checkout_profile: "settings:write",
  activate_checkout_profile: "settings:write",
  read_active_checkout_profile: "settings:read",
  list_point_of_sale_configurations: "settings:read",
  publish_point_of_sale_configuration: "settings:write",
  read_point_of_sale_configuration: "settings:read",

  entity_plane_query: "entity_plane:read",
  entity_plane_query_plan: "entity_plane:read",
  entity_plane_list_entry: "entity_plane:read",
  entity_plane_relationship_step: "entity_plane:read",
  entity_plane_changes: "entity_plane:read",
  entity_plane_capability_metadata: "entity_plane:read",
  entity_plane_published_resource_metadata: "entity_plane:read",
  entity_plane_system_extensions: "entity_plane:read",
  entity_plane_export_preset: "entity_plane:read",
  entity_plane_command: "entity_plane:write",
  ...COLLECTIONS_ROUTE_ACCESS,
  ...MEDIA_ROUTE_ACCESS,
  ...MARKETS_ROUTE_ACCESS,
  ...DISCOUNTS_ROUTE_ACCESS,
  ...CUSTOMERS_ROUTE_ACCESS,
  ...DRAFT_ORDERS_ROUTE_ACCESS,
  ...RETURNS_ROUTE_ACCESS,
  ...STORED_VALUE_ROUTE_ACCESS,
  ...FOOD_SERVICE_ROUTE_ACCESS,
  ...PURCHASING_ROUTE_ACCESS,
  ...PRODUCTION_DEMAND_ROUTE_ACCESS,
  ...COMPANIES_ROUTE_ACCESS,
};

export function adminRouteAccess(
  kind: AdminRouteKind,
): CommerceApiScope | "operator" {
  return ADMIN_ROUTE_ACCESS[kind];
}

export type ApiCaller =
  | Readonly<{ kind: "operator" }>
  | Readonly<{
      kind: "api_key" | "app_installation";
      credentialId: string;
      appId: string | null;
      scopes: readonly CommerceApiScope[];
    }>;

type ApiAccessDecision =
  | Readonly<{ kind: "allowed"; caller: ApiCaller }>
  | Readonly<{
      kind: "refused";
      status: 401 | 403;
      code: "unauthorized" | "app_not_installed" | "missing_scope";
    }>;

type ApiCredentialSummary = Readonly<{
  credentialId: string;
  kind: "api_key" | "app_installation";
  appId: string | null;
  label: string;
  scopes: readonly CommerceApiScope[];
  createdAt: string;
  revokedAt: string | null;
  state: CredentialState;
  revokedBy: string | null;
  expiresAt: string | null;
  parentCredentialId: string | null;
}>;

type CredentialState = "active" | "revoked" | "expired";

type CredentialRow = Readonly<{
  credentialId: string;
  kind: "api_key" | "app_installation";
  appId: string | null;
  externalReference: string | null;
  label: string;
  secretSha256: string;
  scopesJson: string;
  createdAt: string;
  revokedAt: string | null;
  state: CredentialState;
  revokedBy: string | null;
  expiresAt: string | null;
  parentCredentialId: string | null;
  installNonce: string | null;
}>;

export type CredentialCommandResult<Value> =
  | Readonly<{ kind: "ok"; status: 200 | 201; value: Value }>
  | Readonly<{ kind: "error"; status: 404 | 409 | 422; message: string }>;

/** The operator token and the credentials kept in one merchant database. */
export class ApiAccess {
  readonly #database: CommerceDatabase;
  readonly #operatorToken: string;
  readonly #now: () => string;

  constructor(
    options: Readonly<{
      database: CommerceDatabase;
      operatorToken: string;
      now: () => string;
    }>,
  ) {
    this.#database = options.database;
    this.#operatorToken = options.operatorToken;
    this.#now = options.now;
  }

  isOperator(request: Request): boolean {
    const token = bearerToken(request);
    return token !== undefined && sameSecret(token, this.#operatorToken);
  }

  /** Decides one admin request of `merchantId` that needs `access`. */
  authorize(
    request: Request,
    merchantId: string,
    access: CommerceApiScope | "operator",
  ): ApiAccessDecision {
    const decision = this.identify(request, merchantId);
    if (decision.kind === "refused" || decision.caller.kind === "operator")
      return decision;
    return access === "operator" || !decision.caller.scopes.includes(access)
      ? refused(403, "missing_scope")
      : decision;
  }

  /**
   * The caller of a request of `merchantId`, before any scope: the MCP
   * server (Plan 40B phase 6) lists the tools of the caller's scopes.
   */
  identify(request: Request, merchantId: string): ApiAccessDecision {
    const token = bearerToken(request);
    if (token === undefined) return refused(401, "unauthorized");
    if (sameSecret(token, this.#operatorToken))
      return { kind: "allowed", caller: { kind: "operator" } };
    const parsed = parseCredentialToken(token);
    if (parsed === undefined) return refused(401, "unauthorized");
    const row = this.#row(merchantId, parsed.credentialId);
    const expectedKind =
      parsed.prefix === COMMERCE_APP_TOKEN_PREFIX
        ? "app_installation"
        : "api_key";
    if (
      row === undefined ||
      row.kind !== expectedKind ||
      !this.#secretMatches(row, merchantId, parsed.secret)
    ) {
      // An app's own token for a merchant that has no installation of it.
      return expectedKind === "app_installation" && row === undefined
        ? refused(401, "app_not_installed")
        : refused(401, "unauthorized");
    }
    if (row.state !== "active") return refused(401, "unauthorized");
    if (row.expiresAt !== null && row.expiresAt <= this.#now()) {
      this.#expire(merchantId, row);
      return refused(401, "unauthorized");
    }
    const scopes = parseScopes(row.scopesJson);
    return {
      kind: "allowed",
      caller: {
        kind: row.kind,
        credentialId: row.credentialId,
        appId: row.appId,
        scopes,
      },
    };
  }

  #secretMatches(
    row: CredentialRow,
    merchantId: string,
    secret: string,
  ): boolean {
    if (row.kind === "api_key")
      return sameDigest(sha256(secret), row.secretSha256);
    if (row.appId === null || row.externalReference === null) return false;
    // The secret of commerceAppInstallationToken, computed synchronously.
    const derived = createHmac("sha256", this.#operatorToken)
      .update(
        commerceAppTokenMessage(
          row.appId,
          merchantId,
          row.externalReference,
          row.installNonce ?? undefined,
        ),
      )
      .digest("base64url");
    return sameSecret(secret, derived);
  }

  /**
   * Issues a new API key; its secret is returned only here. A caller other
   * than the operator grants only scopes that it holds (Plan 80 step 3).
   */
  issueApiKey(
    merchantId: string,
    body: unknown,
    caller: ApiCaller,
  ): CredentialCommandResult<ApiCredentialSummary & Readonly<{ key: string }>> {
    const input = parseCredentialBody(body, ["label", "scopes", "expiresAt"]);
    if (input === undefined || input.label === undefined)
      return invalid("An API key needs a label and its scopes");
    if (input.expiresAt !== undefined && input.expiresAt <= this.#now())
      return invalid("An API key's expiresAt must be in the future");
    for (const scope of ["payments:record", "credentials:write"] as const)
      if (input.scopes.includes(scope))
        return invalid(`An API key may not hold ${scope}`);
    if (
      caller.kind !== "operator" &&
      input.scopes.some((scope) => !caller.scopes.includes(scope))
    )
      return invalid("An API key may only get scopes that its creator holds");
    if (!this.#merchantExists(merchantId))
      return { kind: "error", status: 404, message: "Merchant not found" };
    if (this.isClosed(merchantId)) return closed();
    const credentialId = randomBytes(12).toString("hex");
    // The key belongs to the credential that issued it, so a revoke of that
    // app installation revokes the key too.
    const parentCredentialId =
      caller.kind === "operator" ? null : caller.credentialId;
    const secret = randomBytes(32).toString("base64url");
    const createdAt = this.#now();
    this.#database
      .prepare(
        `INSERT INTO api_credential (
           merchant_id, credential_id, kind, app_id, external_reference, label,
           secret_sha256, scopes_json, created_at, revoked_at, state,
           revoked_by, expires_at, parent_credential_id, install_nonce
         ) VALUES (?, ?, 'api_key', NULL, NULL, ?, ?, ?, ?, NULL, 'active',
                   NULL, ?, ?, NULL)`,
      )
      .run(
        merchantId,
        credentialId,
        input.label,
        sha256(secret),
        JSON.stringify(input.scopes),
        createdAt,
        input.expiresAt ?? null,
        parentCredentialId,
      );
    return {
      kind: "ok",
      status: 201,
      value: {
        credentialId,
        kind: "api_key",
        appId: null,
        label: input.label,
        scopes: input.scopes,
        createdAt,
        revokedAt: null,
        state: "active",
        revokedBy: null,
        expiresAt: input.expiresAt ?? null,
        parentCredentialId,
        key: `${COMMERCE_API_KEY_PREFIX}_${credentialId}_${secret}`,
      },
    };
  }

  /** `by` names who revoked it: `operator` or `credential:<id>`. */
  revokeApiKey(
    merchantId: string,
    credentialId: string,
    by = "operator",
  ): CredentialCommandResult<ApiCredentialSummary> {
    const row = this.#row(merchantId, credentialId);
    if (row === undefined || row.kind !== "api_key")
      return { kind: "error", status: 404, message: "API key not found" };
    this.#database.transaction(() =>
      this.#revoke(merchantId, credentialId, by, this.#now()),
    );
    return {
      kind: "ok",
      status: 200,
      value: this.#summary(merchantId, credentialId),
    };
  }

  /**
   * Installs an app, or changes the scopes of its installation. The token is
   * derived, so the same installation always has the same token. An app
   * installed again after a revoke or an expiry is a new credential with a
   * random nonce, so its token is new and the old one stays refused.
   */
  async installApp(
    merchantId: string,
    appId: string,
    body: unknown,
  ): Promise<
    CredentialCommandResult<ApiCredentialSummary & Readonly<{ token: string }>>
  > {
    const input = parseCredentialBody(body, [
      "scopes",
      "externalReference",
      "label",
    ]);
    if (input === undefined || input.externalReference === undefined)
      return invalid(
        "An app installation needs its scopes and the external reference",
      );
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(appId))
      return invalid("An app id is lowercase letters, digits, - and _");
    const merchant = this.#database
      .prepare(
        "SELECT external_reference AS organisationId FROM merchant WHERE merchant_id = ?",
      )
      .get<Readonly<{ organisationId: string }>>(merchantId);
    if (merchant === undefined)
      return { kind: "error", status: 404, message: "Merchant not found" };
    if (merchant.organisationId !== input.externalReference)
      return {
        kind: "error",
        status: 409,
        message: "The external reference is not this merchant's",
      };
    if (this.isClosed(merchantId)) return closed();
    const credentialId = await commerceAppInstallationId(appId, merchantId);
    const existing = this.#row(merchantId, credentialId);
    const renewed = existing !== undefined && existing.state !== "active";
    const nonce = renewed
      ? randomBytes(16).toString("base64url")
      : (existing?.installNonce ?? null);
    const token = await commerceAppInstallationToken(this.#operatorToken, {
      appId,
      merchantId,
      externalReference: input.externalReference,
      ...(nonce === null ? {} : { nonce }),
    });
    const parsed = parseCredentialToken(token);
    if (parsed === undefined) throw new Error("Derived app token is malformed");
    const now = this.#now();
    if (existing === undefined || renewed)
      // A new credential: a first install, or one after a revoke.
      this.#database
        .prepare(
          `INSERT INTO api_credential (
             merchant_id, credential_id, kind, app_id, external_reference, label,
             secret_sha256, scopes_json, created_at, revoked_at, state,
             revoked_by, expires_at, parent_credential_id, install_nonce
           ) VALUES (?, ?, 'app_installation', ?, ?, ?, ?, ?, ?, NULL, 'active',
                     NULL, NULL, NULL, ?)
           ON CONFLICT (merchant_id, credential_id) DO UPDATE SET
             external_reference = excluded.external_reference,
             label = excluded.label,
             secret_sha256 = excluded.secret_sha256,
             scopes_json = excluded.scopes_json,
             created_at = excluded.created_at,
             revoked_at = NULL,
             state = 'active',
             revoked_by = NULL,
             expires_at = NULL,
             parent_credential_id = NULL,
             install_nonce = excluded.install_nonce
           WHERE api_credential.state != 'active'`,
        )
        .run(
          merchantId,
          credentialId,
          appId,
          input.externalReference,
          input.label ?? appId,
          sha256(parsed.secret),
          JSON.stringify(input.scopes),
          now,
          nonce,
        );
    else
      // The same installation with new scopes keeps its token.
      this.#database
        .prepare(
          `UPDATE api_credential SET label = ?, scopes_json = ?
           WHERE merchant_id = ? AND credential_id = ? AND state = 'active'`,
        )
        .run(
          input.label ?? appId,
          JSON.stringify(input.scopes),
          merchantId,
          credentialId,
        );
    return {
      kind: "ok",
      status: 200,
      value: { ...this.#summary(merchantId, credentialId), token },
    };
  }

  /**
   * The token of an app's active installation, for the operator. An app that
   * derives its token cannot derive the nonce of an installation made again
   * after a revoke, so the operator-run app reads it here. The answer names
   * the installation only for its own external reference, and only while it
   * is active: a revoked installation stays refused.
   */
  async readAppInstallation(
    merchantId: string,
    appId: string,
    externalReference: string | null,
  ): Promise<
    CredentialCommandResult<ApiCredentialSummary & Readonly<{ token: string }>>
  > {
    if (externalReference === null || externalReference === "")
      return invalid("An app installation read needs its external reference");
    const credentialId = await commerceAppInstallationId(appId, merchantId);
    const row = this.#row(merchantId, credentialId);
    if (
      row === undefined ||
      row.kind !== "app_installation" ||
      row.state !== "active" ||
      row.externalReference !== externalReference
    )
      return {
        kind: "error",
        status: 404,
        message: "App installation not found",
      };
    const token = await commerceAppInstallationToken(this.#operatorToken, {
      appId,
      merchantId,
      externalReference,
      ...(row.installNonce === null ? {} : { nonce: row.installNonce }),
    });
    return {
      kind: "ok",
      status: 200,
      value: { ...toSummary(row), token },
    };
  }

  async uninstallApp(
    merchantId: string,
    appId: string,
  ): Promise<CredentialCommandResult<ApiCredentialSummary>> {
    const credentialId = await commerceAppInstallationId(appId, merchantId);
    const row = this.#row(merchantId, credentialId);
    if (row === undefined)
      return {
        kind: "error",
        status: 404,
        message: "App installation not found",
      };
    this.#database.transaction(() =>
      this.#revoke(merchantId, credentialId, "operator", this.#now()),
    );
    return {
      kind: "ok",
      status: 200,
      value: this.#summary(merchantId, credentialId),
    };
  }

  /**
   * Revokes every credential of a merchant that closes; returns how many
   * were active. The caller holds the transaction.
   */
  revokeAll(merchantId: string, now: string): number {
    const active = this.#database
      .prepare(
        `SELECT credential_id AS credentialId FROM api_credential
         WHERE merchant_id = ? AND state = 'active'`,
      )
      .all<Readonly<{ credentialId: string }>>(merchantId);
    let revoked = 0;
    for (const { credentialId } of active)
      revoked += this.#revoke(
        merchantId,
        credentialId,
        "merchant_closure",
        now,
      );
    return revoked;
  }

  /** True once the merchant's Organisation ended and Commerce closed it. */
  isClosed(merchantId: string): boolean {
    return (
      this.#database
        .prepare(
          "SELECT 1 AS closed FROM merchant_closure WHERE merchant_id = ?",
        )
        .get<Readonly<{ closed: number }>>(merchantId) !== undefined
    );
  }

  // Revokes one credential and every active credential that it issued,
  // through CREDENTIAL_MACHINE. Returns how many it revoked; a credential
  // that is not active is left as it is.
  #revoke(
    merchantId: string,
    credentialId: string,
    by: string,
    now: string,
  ): number {
    const row = this.#row(merchantId, credentialId);
    if (row === undefined) return 0;
    const move = commerceTransition(
      "credential",
      { state: row.state },
      "revoke",
    );
    if (!move.allowed) return 0;
    const written = this.#database
      .prepare(
        `UPDATE api_credential SET state = ?, revoked_at = ?, revoked_by = ?
         WHERE merchant_id = ? AND credential_id = ? AND state = ?`,
      )
      .run(move.to, now, by, merchantId, credentialId, row.state);
    if (written.changes === 0) return 0;
    let revoked = 1;
    const children = this.#database
      .prepare(
        `SELECT credential_id AS credentialId FROM api_credential
         WHERE merchant_id = ? AND parent_credential_id = ? AND state = 'active'`,
      )
      .all<Readonly<{ credentialId: string }>>(merchantId, credentialId);
    for (const child of children)
      revoked += this.#revoke(
        merchantId,
        child.credentialId,
        `parent:${credentialId}`,
        now,
      );
    return revoked;
  }

  // A credential whose expiresAt passed ends as expired.
  #expire(merchantId: string, row: CredentialRow): void {
    const move = commerceTransition(
      "credential",
      { state: row.state },
      "expire",
    );
    if (!move.allowed) return;
    this.#database
      .prepare(
        `UPDATE api_credential SET state = ?
         WHERE merchant_id = ? AND credential_id = ? AND state = ?
           AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .run(move.to, merchantId, row.credentialId, row.state, this.#now());
  }

  list(merchantId: string): readonly ApiCredentialSummary[] {
    return this.#database
      .prepare(
        `${CREDENTIAL_SELECT} WHERE merchant_id = ? ORDER BY created_at, credential_id`,
      )
      .all<CredentialRow>(merchantId)
      .map(toSummary);
  }

  #merchantExists(merchantId: string): boolean {
    return (
      this.#database
        .prepare("SELECT 1 AS present FROM merchant WHERE merchant_id = ?")
        .get<Readonly<{ present: number }>>(merchantId) !== undefined
    );
  }

  #row(merchantId: string, credentialId: string): CredentialRow | undefined {
    return this.#database
      .prepare(
        `${CREDENTIAL_SELECT} WHERE merchant_id = ? AND credential_id = ?`,
      )
      .get<CredentialRow>(merchantId, credentialId);
  }

  #summary(merchantId: string, credentialId: string): ApiCredentialSummary {
    const row = this.#row(merchantId, credentialId);
    if (row === undefined) throw new Error("API credential vanished");
    return toSummary(row);
  }
}

const CREDENTIAL_SELECT = `SELECT
  credential_id AS credentialId,
  kind,
  app_id AS appId,
  external_reference AS externalReference,
  label,
  secret_sha256 AS secretSha256,
  scopes_json AS scopesJson,
  created_at AS createdAt,
  revoked_at AS revokedAt,
  state,
  revoked_by AS revokedBy,
  expires_at AS expiresAt,
  parent_credential_id AS parentCredentialId,
  install_nonce AS installNonce
FROM api_credential`;

function toSummary(row: CredentialRow): ApiCredentialSummary {
  return {
    credentialId: row.credentialId,
    kind: row.kind,
    appId: row.appId,
    label: row.label,
    scopes: parseScopes(row.scopesJson),
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    state: row.state,
    revokedBy: row.revokedBy,
    expiresAt: row.expiresAt,
    parentCredentialId: row.parentCredentialId,
  };
}

function parseCredentialBody(
  body: unknown,
  allowed: readonly ("label" | "scopes" | "externalReference" | "expiresAt")[],
):
  | Readonly<{
      label?: string;
      scopes: readonly CommerceApiScope[];
      externalReference?: string;
      expiresAt?: string;
    }>
  | undefined {
  if (
    !isRecord(body) ||
    Object.keys(body).some((key) => !allowed.some((name) => name === key))
  )
    return undefined;
  const { label, scopes, externalReference, expiresAt } = body;
  if (
    expiresAt !== undefined &&
    (typeof expiresAt !== "string" ||
      Number.isNaN(Date.parse(expiresAt)) ||
      new Date(Date.parse(expiresAt)).toISOString() !== expiresAt)
  )
    return undefined;
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    !scopes.every(isCommerceApiScope)
  )
    return undefined;
  if (new Set(scopes).size !== scopes.length) return undefined;
  if (label !== undefined && !isShortText(label)) return undefined;
  if (externalReference !== undefined && !isShortText(externalReference))
    return undefined;
  return {
    scopes: COMMERCE_API_SCOPES.filter((scope) => scopes.includes(scope)),
    ...(label === undefined ? {} : { label }),
    ...(externalReference === undefined ? {} : { externalReference }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function parseScopes(json: string): readonly CommerceApiScope[] {
  const value: unknown = JSON.parse(json);
  return Array.isArray(value) ? value.filter(isCommerceApiScope) : [];
}

function parseCredentialToken(
  token: string,
):
  | Readonly<{ prefix: string; credentialId: string; secret: string }>
  | undefined {
  const match = /^(uck|uca)_([a-f0-9]{24})_([A-Za-z0-9_-]{43})$/u.exec(token);
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  )
    return undefined;
  return { prefix: match[1], credentialId: match[2], secret: match[3] };
}

function isShortText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value === value.trim()
  );
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer "))
    return undefined;
  const token = authorization.slice("Bearer ".length);
  return token.length > 0 ? token : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Both sides are hashed first, so the comparison takes the same time for
// every length and every prefix.
export function sameSecret(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );
}

function sameDigest(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function refused(
  status: 401 | 403,
  code: "unauthorized" | "app_not_installed" | "missing_scope",
): ApiAccessDecision {
  return { kind: "refused", status, code };
}

function closed(): CredentialCommandResult<never> {
  return { kind: "error", status: 409, message: "The merchant is closed" };
}

function invalid(message: string): CredentialCommandResult<never> {
  return { kind: "error", status: 422, message };
}
