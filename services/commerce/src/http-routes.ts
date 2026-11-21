import {
  parseCommerceDemoProfile,
  type CommerceDemoProfile,
} from "@purin-labs/commerce-client";
import type { BuiltInPluginId } from "@purin-labs/commerce-contracts";

import {
  decodePathSegment,
  pathPattern,
  routeFor,
  type RouteDefinition,
} from "./route-definitions.ts";
import {
  COLLECTIONS_BUYER_ROUTE_KINDS,
  COLLECTIONS_ROUTES,
  type CollectionsRoute,
} from "./plugins/collections/index.ts";
import {
  MEDIA_BUYER_ROUTE_KINDS,
  MEDIA_ROUTES,
  type MediaRoute,
} from "./plugins/media/index.ts";
import {
  MARKETS_BUYER_ROUTE_KINDS,
  MARKETS_ROUTES,
  type MarketsRoute,
} from "./plugins/markets/index.ts";
import {
  DISCOUNTS_BUYER_ROUTE_KINDS,
  DISCOUNTS_ROUTES,
  type DiscountsRoute,
} from "./plugins/discounts/index.ts";
import {
  CUSTOMERS_BUYER_ROUTE_KINDS,
  CUSTOMERS_ROUTES,
  type CustomersRoute,
} from "./plugins/customers/index.ts";
import {
  DRAFT_ORDERS_BUYER_ROUTE_KINDS,
  DRAFT_ORDERS_ROUTES,
  type DraftOrdersRoute,
} from "./plugins/draft-orders/index.ts";
import {
  RETURNS_BUYER_ROUTE_KINDS,
  RETURNS_ROUTES,
  type ReturnsRoute,
} from "./plugins/returns/index.ts";
import {
  STORED_VALUE_BUYER_ROUTE_KINDS,
  STORED_VALUE_ROUTES,
  type StoredValueRoute,
} from "./plugins/stored-value/index.ts";
import {
  FOOD_SERVICE_BUYER_ROUTE_KINDS,
  FOOD_SERVICE_ROUTES,
  type FoodServiceRoute,
} from "./plugins/food-service/index.ts";
import {
  PURCHASING_BUYER_ROUTE_KINDS,
  PURCHASING_ROUTES,
  type PurchasingRoute,
} from "./plugins/purchasing/index.ts";
import {
  PRODUCTION_DEMAND_BUYER_ROUTE_KINDS,
  PRODUCTION_DEMAND_ROUTES,
  type ProductionDemandRoute,
} from "./plugins/production-demand/index.ts";
import {
  COMPANIES_BUYER_ROUTE_KINDS,
  COMPANIES_ROUTES,
  type CompaniesRoute,
} from "./plugins/companies/index.ts";
import type { Variant } from "@purin-labs/type-utils";

export type CheckoutProfileRoute =
  | Readonly<{ kind: "list_checkout_profiles"; merchantId: string }>
  | Readonly<{ kind: "list_checkout_profile_activations"; merchantId: string }>
  | Readonly<{
      kind: "list_storefronts";
      merchantId: string;
    }>
  | Readonly<{
      kind: "read_storefront";
      merchantId: string;
      storefrontId: string;
    }>
  | Readonly<{ kind: "create_checkout_profile"; merchantId: string }>
  | Readonly<{
      kind: "read_checkout_profile";
      merchantId: string;
      checkoutProfileId: string;
      revision: number;
    }>
  | Readonly<{
      kind: "replace_checkout_profile_draft";
      merchantId: string;
      checkoutProfileId: string;
    }>
  | Readonly<{
      kind: "publish_checkout_profile";
      merchantId: string;
      checkoutProfileId: string;
    }>
  | Readonly<{
      kind: "retire_checkout_profile";
      merchantId: string;
      checkoutProfileId: string;
    }>
  | Readonly<{
      kind: "activate_checkout_profile";
      merchantId: string;
      storefrontId: string;
    }>
  | Readonly<{
      kind: "read_active_checkout_profile";
      merchantId: string;
      storefrontId: string;
    }>;

type CounterSaleRoute =
  | Readonly<{
      kind: "read_counter_sale";
      merchantId: string;
      checkoutId: string;
    }>
  | Readonly<{
      kind: "reconcile_counter_sale_payment";
      merchantId: string;
      checkoutId: string;
    }>
  | Readonly<{
      kind: "record_counter_sale_handoff_result";
      merchantId: string;
      checkoutId: string;
    }>
  | Readonly<{
      kind: "reconcile_counter_sale_refund";
      merchantId: string;
      checkoutId: string;
    }>;

export type PointOfSaleConfigurationRoute =
  | Readonly<{ kind: "list_point_of_sale_configurations"; merchantId: string }>
  | Readonly<{
      kind: "publish_point_of_sale_configuration";
      merchantId: string;
    }>
  | Readonly<{
      kind: "read_point_of_sale_configuration";
      merchantId: string;
      pantryLocationId: string;
    }>;

export type CommerceRoute =
  | CheckoutProfileRoute
  | CounterSaleRoute
  | PointOfSaleConfigurationRoute
  | Readonly<{
      kind: "create_buyer_session";
      merchantId: string;
      storefrontId: string;
    }>
  | Readonly<{
      kind: "read_buyer_catalog";
      merchantId: string;
      storefrontId: string;
    }>
  | Readonly<{
      kind: "search_buyer_catalog";
      merchantId: string;
      storefrontId: string;
    }>
  | Readonly<{
      kind: "create_buyer_cart";
      merchantId: string;
      storefrontId: string;
    }>
  | Readonly<{
      kind: "read_buyer_cart";
      merchantId: string;
      storefrontId: string;
      cartId: string;
    }>
  | Readonly<{
      kind: "replace_buyer_cart";
      merchantId: string;
      storefrontId: string;
      cartId: string;
    }>
  | Readonly<{
      kind: "validate_buyer_shipping_address";
      merchantId: string;
      storefrontId: string;
    }>
  | Readonly<{
      kind: "create_buyer_checkout";
      merchantId: string;
      storefrontId: string;
    }>
  | Readonly<{
      kind: "read_buyer_checkout";
      merchantId: string;
      storefrontId: string;
      checkoutId: string;
    }>
  | Readonly<{
      kind: "create_buyer_payment_session";
      merchantId: string;
      storefrontId: string;
      checkoutId: string;
    }>
  | Readonly<{
      kind: "reconcile_buyer_payment";
      merchantId: string;
      storefrontId: string;
      checkoutId: string;
    }>
  | Readonly<{
      kind: "refresh_buyer_checkout";
      merchantId: string;
      storefrontId: string;
      checkoutId: string;
    }>
  | Readonly<{
      kind: "read_buyer_order";
      merchantId: string;
      storefrontId: string;
      checkoutId: string;
    }>
  | Readonly<{ kind: "provision_merchant"; merchantId: string }>
  | Readonly<{
      kind: "provision_demo";
      merchantId: string;
      profile: CommerceDemoProfile;
    }>
  | Readonly<{ kind: "read_snapshot"; merchantId: string }>
  | Readonly<{ kind: "read_product_sales"; merchantId: string }>
  | Readonly<{ kind: "read_failed_payments"; merchantId: string }>
  | Readonly<{ kind: "read_payments"; merchantId: string }>
  | Readonly<{ kind: "list_unplaced_captures"; merchantId: string }>
  | Readonly<{
      kind: "resolve_unplaced_capture";
      merchantId: string;
      paymentAttemptId: string;
    }>
  | Readonly<{ kind: "read_order_times"; merchantId: string }>
  | Readonly<{ kind: "read_bank_payouts"; merchantId: string }>
  | Readonly<{ kind: "read_migration_inventory"; merchantId: string }>
  | Readonly<{ kind: "read_stock_snapshot"; merchantId: string }>
  | Readonly<{ kind: "create_location"; merchantId: string }>
  | Readonly<{ kind: "prepare_catalog_listing"; merchantId: string }>
  | Readonly<{
      kind: "update_product_description";
      merchantId: string;
      productId: string;
    }>
  | Readonly<{ kind: "update_product"; merchantId: string; productId: string }>
  | Readonly<{ kind: "delete_product"; merchantId: string; productId: string }>
  | Readonly<{ kind: "edit_order"; merchantId: string; orderId: string }>
  | Readonly<{
      kind: "record_order_manual_payment";
      merchantId: string;
      orderId: string;
    }>
  | Readonly<{ kind: "list_notifications"; merchantId: string }>
  | Readonly<{ kind: "read_events"; merchantId: string }>
  | Readonly<{ kind: "read_order_record"; merchantId: string; orderId: string }>
  | Readonly<{ kind: "run_archive"; merchantId: string }>
  | Readonly<{
      kind: "read_feed_consumer";
      merchantId: string;
      consumerId: string;
    }>
  | Readonly<{
      kind: "advance_feed_consumer";
      merchantId: string;
      consumerId: string;
    }>
  | Readonly<{ kind: "list_payment_accounts"; merchantId: string }>
  | Readonly<{ kind: "link_stripe_account"; merchantId: string }>
  | Readonly<{ kind: "link_square_account"; merchantId: string }>
  | Readonly<{ kind: "connect_square"; merchantId: string }>
  | Readonly<{ kind: "read_square_connection"; merchantId: string }>
  | Readonly<{ kind: "disconnect_square"; merchantId: string }>
  | Readonly<{ kind: "list_square_locations"; merchantId: string }>
  | Readonly<{ kind: "list_square_devices"; merchantId: string }>
  | Readonly<{ kind: "create_square_device_code"; merchantId: string }>
  | Readonly<{
      kind: "read_square_device_code";
      merchantId: string;
      deviceCodeId: string;
    }>
  | Readonly<{ kind: "start_stripe_onboarding"; merchantId: string }>
  | Readonly<{
      kind: "settle_online_payment";
      merchantId: string;
      paymentAttemptId: string;
    }>
  | Readonly<{
      kind: "read_catalog_snapshot";
      merchantId: string;
      storefrontId: string;
    }>
  | Readonly<{
      kind: "observe_stripe_dispute";
      merchantId: string;
      paymentAttemptId: string;
    }>
  | Readonly<{ kind: "issue_api_key"; merchantId: string }>
  | Readonly<{ kind: "close_merchant"; merchantId: string }>
  | Readonly<{ kind: "list_api_credentials"; merchantId: string }>
  | Readonly<{
      kind: "revoke_api_key";
      merchantId: string;
      credentialId: string;
    }>
  | Readonly<{ kind: "install_app"; merchantId: string; appId: string }>
  | Readonly<{
      kind: "read_app_installation";
      merchantId: string;
      appId: string;
    }>
  | Readonly<{ kind: "uninstall_app"; merchantId: string; appId: string }>
  | Readonly<{ kind: "create_webhook_subscription"; merchantId: string }>
  | Readonly<{ kind: "list_webhook_subscriptions"; merchantId: string }>
  | Readonly<{
      kind: "restart_webhook_subscription";
      merchantId: string;
      subscriptionId: string;
    }>
  | Readonly<{
      kind: "rotate_webhook_secret";
      merchantId: string;
      subscriptionId: string;
    }>
  | Readonly<{
      kind: "delete_webhook_subscription";
      merchantId: string;
      subscriptionId: string;
    }>
  | Readonly<{ kind: "read_order_changes"; merchantId: string; orderId: string }>
  | Readonly<{
      kind: "open_buyer_order_balance";
      merchantId: string;
      storefrontId: string;
      checkoutId: string;
    }>
  | Readonly<{ kind: "list_plugins"; merchantId: string }>
  | Readonly<{
      kind: "preview_plugin_change";
      merchantId: string;
      pluginId: string;
    }>
  | Readonly<{ kind: "pause_plugin"; merchantId: string; pluginId: string }>
  | Readonly<{ kind: "remove_plugin"; merchantId: string; pluginId: string }>
  | Readonly<{ kind: "install_merchant_plugin"; merchantId: string }>
  | Readonly<{
      kind: "set_plugin_field_values";
      merchantId: string;
      pluginId: string;
      entityType: string;
      entityId: string;
    }>
  | Readonly<{
      kind: "list_plugin_field_values";
      merchantId: string;
      pluginId: string;
    }>
  | Readonly<{
      kind: "run_plugin_action";
      merchantId: string;
      pluginId: string;
      actionId: string;
    }>
  | Readonly<{ kind: "run_plugin_function"; merchantId: string }>
  | Readonly<{ kind: "preview_merchant_plugin"; merchantId: string }>
  | Readonly<{ kind: "resume_plugin"; merchantId: string; pluginId: string }>
  | Readonly<{
      kind: "configure_plugin";
      merchantId: string;
      pluginId: string;
    }>
  | Readonly<{
      kind: "read_storefront_shop_name";
      merchantId: string;
      storefrontId: string;
    }>
  | Readonly<{
      kind: "set_storefront_shop_name";
      merchantId: string;
      storefrontId: string;
    }>
  | Readonly<{ kind: "update_variant"; merchantId: string; variantId: string }>
  | Readonly<{ kind: "update_offer"; merchantId: string; offerId: string }>
  | Readonly<{
      kind: "update_storefront_tax";
      merchantId: string;
      storefrontId: string;
    }>
  | Readonly<{ kind: "place_channel_listing"; merchantId: string }>
  | Readonly<{ kind: "configure_pickup_storefront"; merchantId: string }>
  | Readonly<{ kind: "configure_shipping_storefront"; merchantId: string }>
  | Readonly<{ kind: "create_in_person_checkout"; merchantId: string }>
  | Readonly<{ kind: "create_pickup_checkout"; merchantId: string }>
  | Readonly<{
      kind: "begin_checkout_payment";
      merchantId: string;
      checkoutId: string;
    }>
  | Readonly<{
      kind: "collect_in_person_checkout_payment";
      merchantId: string;
      checkoutId: string;
    }>
  | Readonly<{
      kind: "record_counter_cash_payment";
      merchantId: string;
      checkoutId: string;
    }>
  | Readonly<{
      kind: "record_checkout_payment_capture";
      merchantId: string;
      checkoutId: string;
      paymentAttemptId: string;
    }>
  | Readonly<{ kind: "observe_payment_dispute"; merchantId: string }>
  | Readonly<{
      kind: "place_paid_checkout";
      merchantId: string;
      checkoutId: string;
      paymentAttemptId: string;
    }>
  | Readonly<{
      kind: "mark_pickup_ready";
      merchantId: string;
      orderId: string;
      fulfillmentId: string;
    }>
  | Readonly<{
      kind: "complete_pickup";
      merchantId: string;
      orderId: string;
      fulfillmentId: string;
    }>
  | Readonly<{
      kind: "cancel_order";
      merchantId: string;
      orderId: string;
    }>
  | Readonly<{
      kind: "refund_order";
      merchantId: string;
      orderId: string;
    }>
  | Readonly<{
      kind: "record_counter_manual_cash_refund";
      merchantId: string;
      orderId: string;
    }>
  | Readonly<{
      kind: "refund_order_tenders";
      merchantId: string;
      orderId: string;
    }>
  | Readonly<{
      kind: "resolve_checkout_payment";
      merchantId: string;
      checkoutId: string;
      paymentAttemptId: string;
    }>
  | Readonly<{
      kind: "expire_checkout";
      merchantId: string;
      checkoutId: string;
    }>
  | Readonly<{
      kind: "quote_shipment_label_rate";
      merchantId: string;
      shipmentId: string;
    }>
  | Readonly<{
      kind: "purchase_shipping_label";
      merchantId: string;
      shipmentId: string;
    }>
  | Readonly<{
      kind: "attach_fulfillment_tracking";
      merchantId: string;
      shipmentId: string;
    }>
  | Readonly<{
      kind: "read_offer_price_policy";
      merchantId: string;
      offerId: string;
    }>
  | Readonly<{
      kind: "set_offer_price_policy";
      merchantId: string;
      offerId: string;
    }>
  | Readonly<{
      kind: "disable_offer_price_policy";
      merchantId: string;
      offerId: string;
    }>
  | Readonly<{
      kind: "adjust_offer_price";
      merchantId: string;
      offerId: string;
    }>
  | Readonly<{
      kind: "record_shipping_tracking";
      merchantId: string;
      shipmentId: string;
    }>
  | Readonly<{ kind: "publish_catalog_listing"; merchantId: string }>
  | Readonly<{ kind: "create_inventory_item"; merchantId: string }>
  | Readonly<{ kind: "open_inventory_position"; merchantId: string }>
  | Readonly<{ kind: "receive_inventory"; merchantId: string }>
  | Readonly<{ kind: "reconcile_inventory"; merchantId: string }>
  | Readonly<{
      kind: "acknowledge_delivery";
      merchantId: string;
      deliveryId: string;
    }>
  | Readonly<{ kind: "entity_plane_list_entry"; merchantId: string }>
  | Readonly<{ kind: "entity_plane_query"; merchantId: string }>
  | Readonly<{ kind: "entity_plane_query_plan"; merchantId: string }>
  | Readonly<{ kind: "entity_plane_capability_metadata"; merchantId: string }>
  | Readonly<{
      kind: "entity_plane_published_resource_metadata";
      merchantId: string;
    }>
  | Readonly<{ kind: "entity_plane_export_preset"; merchantId: string }>
  | Readonly<{ kind: "entity_plane_relationship_step"; merchantId: string }>
  | Readonly<{ kind: "entity_plane_command"; merchantId: string }>
  | Readonly<{ kind: "entity_plane_changes"; merchantId: string }>
  | Readonly<{ kind: "entity_plane_system_extensions"; merchantId: string }>
  | CollectionsRoute
  | MediaRoute
  | MarketsRoute
  | DiscountsRoute
  | CustomersRoute
  | DraftOrdersRoute
  | ReturnsRoute
  | StoredValueRoute
  | FoodServiceRoute
  | PurchasingRoute
  | ProductionDemandRoute
  | CompaniesRoute;

const BUYER_ROUTE_KINDS = [
  "create_buyer_session",
  "read_buyer_catalog",
  "search_buyer_catalog",
  "create_buyer_cart",
  "read_buyer_cart",
  "replace_buyer_cart",
  "validate_buyer_shipping_address",
  "create_buyer_checkout",
  "read_buyer_checkout",
  "create_buyer_payment_session",
  "reconcile_buyer_payment",
  "refresh_buyer_checkout",
  "read_buyer_order",
  "open_buyer_order_balance",
  ...COLLECTIONS_BUYER_ROUTE_KINDS,
  ...MEDIA_BUYER_ROUTE_KINDS,
  ...MARKETS_BUYER_ROUTE_KINDS,
  ...DISCOUNTS_BUYER_ROUTE_KINDS,
  ...CUSTOMERS_BUYER_ROUTE_KINDS,
  ...DRAFT_ORDERS_BUYER_ROUTE_KINDS,
  ...RETURNS_BUYER_ROUTE_KINDS,
  ...STORED_VALUE_BUYER_ROUTE_KINDS,
  ...FOOD_SERVICE_BUYER_ROUTE_KINDS,
  ...PURCHASING_BUYER_ROUTE_KINDS,
  ...PRODUCTION_DEMAND_BUYER_ROUTE_KINDS,
  ...COMPANIES_BUYER_ROUTE_KINDS,
] as const satisfies readonly CommerceRoute["kind"][];

/** Routes a storefront buyer calls without the service token. */
export type BuyerRoute = Variant<CommerceRoute, (typeof BUYER_ROUTE_KINDS)[number]>;

export function isBuyerRoute(route: CommerceRoute): route is BuyerRoute {
  return BUYER_ROUTE_KINDS.some((kind) => kind === route.kind);
}

const route = routeFor<CommerceRoute>();

/**
 * The core's routes. A definition that returns undefined rejects the
 * request.
 */
const CORE_ROUTES: readonly RouteDefinition<CommerceRoute>[] = [
  route(
    "POST",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/sessions",
    "create_buyer_session",
  ),
  route(
    "GET",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/catalog",
    "read_buyer_catalog",
  ),
  route(
    "GET",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/catalog/search",
    "search_buyer_catalog",
  ),
  route(
    "POST",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/carts",
    "create_buyer_cart",
  ),
  route(
    "GET",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/carts/:cartId",
    "read_buyer_cart",
  ),
  route(
    "PUT",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/carts/:cartId",
    "replace_buyer_cart",
  ),
  route(
    "POST",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/address-validations",
    "validate_buyer_shipping_address",
  ),
  route(
    "POST",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/checkouts",
    "create_buyer_checkout",
  ),
  route(
    "GET",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/checkouts/:checkoutId",
    "read_buyer_checkout",
  ),
  route(
    "POST",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/checkouts/:checkoutId/payment-sessions",
    "create_buyer_payment_session",
  ),
  route(
    "POST",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/checkouts/:checkoutId/reconcile",
    "reconcile_buyer_payment",
  ),
  route(
    "POST",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/checkouts/:checkoutId/refresh",
    "refresh_buyer_checkout",
  ),
  route(
    "GET",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/checkouts/:checkoutId/order",
    "read_buyer_order",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/counter-sales/:checkoutId",
    "read_counter_sale",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/counter-sales/:checkoutId/reconciliation",
    "reconcile_counter_sale_payment",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/counter-sales/:checkoutId/handoff-result",
    "record_counter_sale_handoff_result",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/counter-sales/:checkoutId/refund-reconciliation",
    "reconcile_counter_sale_refund",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/point-of-sale-configurations",
    "list_point_of_sale_configurations",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/point-of-sale-configurations",
    "publish_point_of_sale_configuration",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/point-of-sale-configurations/:pantryLocationId",
    "read_point_of_sale_configuration",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/checkout-profiles",
    "list_checkout_profiles",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/checkout-profiles",
    "create_checkout_profile",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/checkout-profile-activations",
    "list_checkout_profile_activations",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/storefronts",
    "list_storefronts",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/storefronts/:storefrontId",
    "read_storefront",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/storefronts/:storefrontId/shop-name",
    "read_storefront_shop_name",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/storefronts/:storefrontId/shop-name",
    "set_storefront_shop_name",
  ),
  {
    method: "GET",
    kind: "read_checkout_profile",
    pattern: pathPattern(
      "/v1/admin/merchants/:merchantId/checkout-profiles/:checkoutProfileId/revisions/:revision",
    ),
    route: ([merchantId, checkoutProfileId, revision]) => {
      const parsedRevision = parsePathRevision(revision);
      if (parsedRevision === undefined) return undefined;
      return {
        kind: "read_checkout_profile",
        merchantId: decodePathSegment(merchantId),
        checkoutProfileId: decodePathSegment(checkoutProfileId),
        revision: parsedRevision,
      };
    },
  },
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/checkout-profiles/:checkoutProfileId/draft",
    "replace_checkout_profile_draft",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/checkout-profiles/:checkoutProfileId/publication",
    "publish_checkout_profile",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/checkout-profiles/:checkoutProfileId/retirement",
    "retire_checkout_profile",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/storefronts/:storefrontId/checkout-profile-activation",
    "activate_checkout_profile",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/storefronts/:storefrontId/checkout-profile-activation",
    "read_active_checkout_profile",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/entity-plane/list-entry",
    "entity_plane_list_entry",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/entity-plane/query",
    "entity_plane_query",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/entity-plane/query-plan",
    "entity_plane_query_plan",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/entity-plane/capability-metadata",
    "entity_plane_capability_metadata",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/entity-plane/published-resources",
    "entity_plane_published_resource_metadata",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/entity-plane/export-preset",
    "entity_plane_export_preset",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/entity-plane/relationship-step",
    "entity_plane_relationship_step",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/entity-plane/commands",
    "entity_plane_command",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/entity-plane/changes",
    "entity_plane_changes",
  ),
  route(
    "POST",
    "/v1/internal/merchants/:merchantId/entity-plane/system-extensions",
    "entity_plane_system_extensions",
  ),
  route("PUT", "/v1/admin/merchants/:merchantId", "provision_merchant"),
  {
    method: "PUT",
    kind: "provision_demo",
    pattern: pathPattern(
      "/v1/admin/merchants/:merchantId/demo-profiles/:profile",
    ),
    route: ([merchantId, profile]) => {
      try {
        return {
          kind: "provision_demo",
          merchantId: decodePathSegment(merchantId),
          profile: parseCommerceDemoProfile(decodePathSegment(profile)),
        };
      } catch {
        return undefined;
      }
    },
  },
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/reports/product-sales",
    "read_product_sales",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/reports/failed-payments",
    "read_failed_payments",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/reports/payments",
    "read_payments",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/unplaced-captures",
    "list_unplaced_captures",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/unplaced-captures/:paymentAttemptId/resolution",
    "resolve_unplaced_capture",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/reports/order-times",
    "read_order_times",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/reports/bank-payouts",
    "read_bank_payouts",
  ),
  route("GET", "/v1/admin/merchants/:merchantId/snapshot", "read_snapshot"),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/migration-inventory",
    "read_migration_inventory",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/locations",
    "create_location",
    "commerce.create-location.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/catalog/listings",
    "prepare_catalog_listing",
    "commerce.prepare-catalog-listing.v1",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/products/:productId/description",
    "update_product_description",
    "commerce.update-product-description.v1",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/products/:productId",
    "update_product",
    "commerce.update-product.v1",
  ),
  route(
    "DELETE",
    "/v1/admin/merchants/:merchantId/products/:productId",
    "delete_product",
    "commerce.delete-product.v1",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/variants/:variantId",
    "update_variant",
    "commerce.update-variant.v1",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/offers/:offerId",
    "update_offer",
    "commerce.update-offer.v1",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/storefronts/:storefrontId/tax",
    "update_storefront_tax",
    "commerce.update-storefront-tax.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/orders/:orderId/edits",
    "edit_order",
    "commerce.edit-order.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/orders/:orderId/manual-payment",
    "record_order_manual_payment",
    "commerce.record-order-manual-payment.v1",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/notifications",
    "list_notifications",
  ),
  route("GET", "/v1/admin/merchants/:merchantId/events", "read_events"),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/feed-consumers/:consumerId",
    "read_feed_consumer",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/feed-consumers/:consumerId",
    "advance_feed_consumer",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/payment-accounts",
    "list_payment_accounts",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/payment-accounts/stripe",
    "link_stripe_account",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/payment-accounts/stripe/onboarding",
    "start_stripe_onboarding",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/payment-accounts/square",
    "link_square_account",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/square/connection",
    "connect_square",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/square/connection",
    "read_square_connection",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/square/connection/revocation",
    "disconnect_square",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/square/locations",
    "list_square_locations",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/square/devices",
    "list_square_devices",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/square/device-codes",
    "create_square_device_code",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/square/device-codes/:deviceCodeId",
    "read_square_device_code",
  ),
  route(
    "POST",
    "/v1/internal/merchants/:merchantId/payment-attempts/:paymentAttemptId/settlement",
    "settle_online_payment",
  ),
  route(
    "POST",
    "/v1/internal/merchants/:merchantId/payment-attempts/:paymentAttemptId/stripe-disputes",
    "observe_stripe_dispute",
  ),
  route(
    "GET",
    "/v1/internal/merchants/:merchantId/storefronts/:storefrontId/catalog-snapshot",
    "read_catalog_snapshot",
  ),
  route("POST", "/v1/admin/merchants/:merchantId/api-keys", "issue_api_key"),
  route("POST", "/v1/admin/merchants/:merchantId/closure", "close_merchant"),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/api-credentials",
    "list_api_credentials",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/api-keys/:credentialId/revocation",
    "revoke_api_key",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/app-installations/:appId",
    "install_app",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/app-installations/:appId",
    "read_app_installation",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/app-installations/:appId/revocation",
    "uninstall_app",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/orders/:orderId",
    "read_order_record",
  ),
  route("POST", "/v1/admin/merchants/:merchantId/archive-runs", "run_archive"),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/webhook-subscriptions",
    "create_webhook_subscription",
    "commerce.create-webhook-subscription.v1",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/webhook-subscriptions",
    "list_webhook_subscriptions",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/webhook-subscriptions/:subscriptionId/restart",
    "restart_webhook_subscription",
    "commerce.restart-webhook-subscription.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/webhook-subscriptions/:subscriptionId/secret-rotations",
    "rotate_webhook_secret",
    "commerce.rotate-webhook-secret.v1",
  ),
  route(
    "DELETE",
    "/v1/admin/merchants/:merchantId/webhook-subscriptions/:subscriptionId",
    "delete_webhook_subscription",
    "commerce.delete-webhook-subscription.v1",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/orders/:orderId/changes",
    "read_order_changes",
  ),
  route(
    "POST",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/checkouts/:checkoutId/order/balance-checkouts",
    "open_buyer_order_balance",
  ),
  route("GET", "/v1/admin/merchants/:merchantId/plugins", "list_plugins"),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/plugins/:pluginId/previews",
    "preview_plugin_change",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/plugins/:pluginId/pause",
    "pause_plugin",
    "commerce.pause-plugin.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/plugins/:pluginId/resume",
    "resume_plugin",
    "commerce.resume-plugin.v1",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/plugins/:pluginId/settings",
    "configure_plugin",
    "commerce.configure-plugin.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/plugins/:pluginId/remove",
    "remove_plugin",
    "commerce.remove-plugin.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/merchant-plugins",
    "install_merchant_plugin",
    "commerce.install-merchant-plugin.v1",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/plugins/:pluginId/fields/:entityType/:entityId",
    "set_plugin_field_values",
    "commerce.set-plugin-field-values.v1",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/plugins/:pluginId/fields",
    "list_plugin_field_values",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/plugins/:pluginId/actions/:actionId/runs",
    "run_plugin_action",
    "commerce.run-plugin-action.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/merchant-plugins/runs",
    "run_plugin_function",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/merchant-plugins/previews",
    "preview_merchant_plugin",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/channel-listings",
    "place_channel_listing",
    "commerce.place-channel-listing.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/pickup-storefronts",
    "configure_pickup_storefront",
    "commerce.configure-pickup-storefront.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/shipping-storefronts",
    "configure_shipping_storefront",
    "commerce.configure-shipping-storefront.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/in-person-checkouts",
    "create_in_person_checkout",
    "commerce.create-in-person-checkout.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/pickup-checkouts",
    "create_pickup_checkout",
    "commerce.create-pickup-checkout.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/pickup-checkouts/:checkoutId/payment-attempts",
    "begin_checkout_payment",
    "commerce.begin-checkout-payment.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/pickup-checkouts/:checkoutId/payment-attempts/in-person-collections",
    "collect_in_person_checkout_payment",
    "commerce.collect-in-person-checkout-payment.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/counter-sales/:checkoutId/cash-payment",
    "record_counter_cash_payment",
    "commerce.record-counter-cash-payment.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/pickup-checkouts/:checkoutId/payment-attempts/:paymentAttemptId/captures",
    "record_checkout_payment_capture",
    "commerce.record-checkout-payment-capture.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/payment-dispute-observations",
    "observe_payment_dispute",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/pickup-checkouts/:checkoutId/payment-attempts/:paymentAttemptId/placements",
    "place_paid_checkout",
    "commerce.place-paid-checkout.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/orders/:orderId/pickup-fulfillments/:fulfillmentId/ready",
    "mark_pickup_ready",
    "commerce.mark-pickup-ready.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/orders/:orderId/pickup-fulfillments/:fulfillmentId/complete",
    "complete_pickup",
    "commerce.complete-pickup.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/orders/:orderId/cancellations",
    "cancel_order",
    "commerce.cancel-order.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/orders/:orderId/refunds",
    "refund_order",
    "commerce.refund-order.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/orders/:orderId/manual-cash-refunds",
    "record_counter_manual_cash_refund",
    "commerce.record-counter-manual-cash-refund.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/orders/:orderId/tender-refunds",
    "refund_order_tenders",
    "commerce.refund-order-tenders.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/pickup-checkouts/:checkoutId/payment-attempts/:paymentAttemptId/resolution",
    "resolve_checkout_payment",
    "commerce.resolve-checkout-payment.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/pickup-checkouts/:checkoutId/expiration",
    "expire_checkout",
    "commerce.expire-checkout.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/shipments/:shipmentId/label-rates",
    "quote_shipment_label_rate",
    "commerce.quote-shipment-label-rate.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/shipments/:shipmentId/labels",
    "purchase_shipping_label",
    "commerce.purchase-shipping-label.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/shipments/:shipmentId/tracking",
    "record_shipping_tracking",
    "commerce.record-shipping-tracking.v1",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/offers/:offerId/price-policy",
    "read_offer_price_policy",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/offers/:offerId/price-policy",
    "set_offer_price_policy",
  ),
  route(
    "DELETE",
    "/v1/admin/merchants/:merchantId/offers/:offerId/price-policy",
    "disable_offer_price_policy",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/offers/:offerId/price",
    "adjust_offer_price",
    "commerce.adjust-offer-price.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/shipments/:shipmentId/tracking-attachment",
    "attach_fulfillment_tracking",
    "commerce.attach-fulfillment-tracking.v1",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/inventory/snapshot",
    "read_stock_snapshot",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/actions/publish-catalog-listing",
    "publish_catalog_listing",
    "commerce.publish-catalog-listing.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/inventory/items",
    "create_inventory_item",
    "commerce.create-inventory-item.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/inventory/positions",
    "open_inventory_position",
    "commerce.open-inventory-position.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/inventory/receipts",
    "receive_inventory",
    "commerce.receive-inventory.v3",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/inventory/reconciliations",
    "reconcile_inventory",
    "commerce.reconcile-inventory.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/deliveries/:deliveryId/acknowledgements",
    "acknowledge_delivery",
  ),
];

/** Each built-in plugin's routes, from its index.ts. */
export const PLUGIN_ROUTES: Readonly<
  Partial<Record<BuiltInPluginId, readonly RouteDefinition<CommerceRoute>[]>>
> = {
  collections: COLLECTIONS_ROUTES,
  media: MEDIA_ROUTES,
  markets: MARKETS_ROUTES,
  discounts: DISCOUNTS_ROUTES,
  customers: CUSTOMERS_ROUTES,
  draft_orders: DRAFT_ORDERS_ROUTES,
  returns: RETURNS_ROUTES,
  stored_value: STORED_VALUE_ROUTES,
  food_service: FOOD_SERVICE_ROUTES,
  purchasing: PURCHASING_ROUTES,
  production_demand: PRODUCTION_DEMAND_ROUTES,
  companies: COMPANIES_ROUTES,
};

/**
 * Every Commerce route: the core's, then each plugin's. No two routes
 * match the same path, so the order does not decide a match.
 */
const ROUTES: readonly RouteDefinition<CommerceRoute>[] = [
  ...CORE_ROUTES,
  ...Object.values(PLUGIN_ROUTES).flat(),
];

export function parseRoute(
  pathname: string,
  method: string,
): CommerceRoute | undefined {
  return matchRoute(pathname, method)?.route;
}

/** The route of a path and the definition that matched it. */
export function matchRoute(
  pathname: string,
  method: string,
):
  | Readonly<{
      route: CommerceRoute;
      definition: RouteDefinition<CommerceRoute>;
    }>
  | undefined {
  for (const definition of ROUTES) {
    if (definition.method !== method) continue;
    const match = definition.pattern.exec(pathname);
    if (match === null) continue;
    const route = definition.route(match.slice(1));
    return route === undefined ? undefined : { route, definition };
  }
  return undefined;
}

export function isPointOfSaleConfigurationRoute(
  route: CommerceRoute,
): route is PointOfSaleConfigurationRoute {
  switch (route.kind) {
    case "list_point_of_sale_configurations":
    case "publish_point_of_sale_configuration":
    case "read_point_of_sale_configuration":
      return true;
    default:
      return false;
  }
}

export function isCheckoutProfileRoute(
  route: CommerceRoute,
): route is CheckoutProfileRoute {
  switch (route.kind) {
    case "list_checkout_profiles":
    case "list_checkout_profile_activations":
    case "list_storefronts":
    case "read_storefront":
    case "create_checkout_profile":
    case "read_checkout_profile":
    case "replace_checkout_profile_draft":
    case "publish_checkout_profile":
    case "retire_checkout_profile":
    case "activate_checkout_profile":
    case "read_active_checkout_profile":
      return true;
    default:
      return false;
  }
}

function parsePathRevision(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (!/^[1-9][0-9]*$/u.test(decoded)) return undefined;
  const revision = Number(decoded);
  return Number.isSafeInteger(revision) ? revision : undefined;
}
