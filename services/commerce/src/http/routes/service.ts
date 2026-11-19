import {
  isCheckoutProfileRoute,
  isPointOfSaleConfigurationRoute,
  type BuyerRoute,
  type CommerceRoute,
} from "../../http-routes.ts";
import { errorMessage } from "@seams/std";
import type { HttpRouteContext } from "../context.ts";
import { jsonResponse } from "../responses.ts";
import {
  adjustOfferPriceRoute,
  catalogEditRoute,
  collectionCommandRoute,
  deleteProductRoute,
  disableOfferPricePolicyRoute,
  listCollectionsRoute,
  readCatalogSnapshotRoute,
  readOfferPricePolicyRoute,
  setOfferPricePolicyRoute,
  updateStorefrontTaxRoute,
} from "./catalog.ts";
import {
  handleCheckoutProfile,
  handlePointOfSaleConfiguration,
} from "./checkout-profiles.ts";
import {
  merchantCommandRoute,
  publishProductionDemandPresetRoute,
  reconcileInventoryRoute,
} from "./commands.ts";
import {
  companyCommandRoute,
  customerCommandRoute,
  exportCustomerRoute,
  listCompaniesRoute,
  listMarketsRoute,
  listNotificationsRoute,
  marketCommandRoute,
  readCustomerRoute,
} from "./customers.ts";
import { handleEntityPlane } from "./entity-plane.ts";
import {
  createWebhookSubscriptionRoute,
  credentialRoute,
  feedConsumerRoute,
  listWebhookSubscriptionsRoute,
  webhookSubscriptionChangeRoute,
} from "./integrations.ts";
import {
  listMediaRoute,
  readMediaContentRoute,
  mediaCommandRoute,
  uploadMediaRoute,
} from "./media.ts";
import {
  acknowledgeDeliveryRoute,
  handleShopName,
  provisionDemoRoute,
  closeMerchantRoute,
  provisionMerchantRoute,
  runArchiveRoute,
} from "./merchants.ts";
import {
  draftOrderCommandRoute,
  invoiceCommandRoute,
  listInvoicesRoute,
  listOrderReturnsRoute,
  orderEditRoute,
  quoteShipmentLabelRateRoute,
  readDraftOrderRoute,
  readOrderChangesRoute,
  refundOrderTendersRoute,
  returnCommandRoute,
} from "./orders.ts";
import {
  linkSquareAccountRoute,
  listPaymentAccountsRoute,
  listUnplacedCapturesRoute,
  observeStripeDisputeRoute,
  resolveUnplacedCaptureRoute,
  settleOnlinePaymentRoute,
  squareConnectionRoute,
  stripeAccountRoute,
} from "./payments.ts";
import {
  configurePluginRoute,
  installMerchantPluginRoute,
  listPluginFieldValuesRoute,
  listPluginsRoute,
  merchantPluginFunctionRoute,
  pluginStateRoute,
  previewPluginChangeRoute,
  runPluginActionRoute,
  setPluginFieldValuesRoute,
} from "./plugins.ts";
import {
  readBankPayoutsRoute,
  readEventsRoute,
  readFailedPaymentsRoute,
  readFoodServiceSnapshotRoute,
  readMigrationInventoryRoute,
  readOrderRecordRoute,
  readOrderTimesRoute,
  readPaymentsRoute,
  readPickupQueueRoute,
  readPreparationTicketRoute,
  readProductSalesRoute,
  readSnapshotRoute,
  readSoldOutMarksRoute,
  readStockSnapshotRoute,
} from "./reports.ts";
import {
  discountCommandRoute,
  listDiscountsRoute,
  listStoredValueAccountsRoute,
  readStoredValueLiabilityRoute,
  storedValueCommandRoute,
} from "./stored-value.ts";

export async function handleServiceRoute(
  ctx: HttpRouteContext,
  request: Request,
  url: URL,
  route: Exclude<CommerceRoute, BuyerRoute>,
): Promise<Response> {
  if (isCheckoutProfileRoute(route)) {
    return handleCheckoutProfile(ctx, request, route);
  }
  if (isPointOfSaleConfigurationRoute(route)) {
    return handlePointOfSaleConfiguration(ctx, request, route);
  }
  if (
    route.kind === "read_storefront_shop_name" ||
    route.kind === "set_storefront_shop_name"
  ) {
    return handleShopName(ctx, request, route);
  }
  if (route.kind === "read_counter_sale") {
    const sale = ctx.authority.readCounterSale(
      route.merchantId,
      route.checkoutId,
    );
    return sale === undefined
      ? jsonResponse(404, { message: "Counter sale not found" })
      : jsonResponse(200, sale);
  }
  if (route.kind === "reconcile_counter_sale_payment") {
    try {
      const sale = await ctx.authority.reconcileCounterSalePayment(
        route.merchantId,
        route.checkoutId,
      );
      return jsonResponse(200, sale);
    } catch (error) {
      return jsonResponse(409, { message: errorMessage(error) });
    }
  }
  if (route.kind === "reconcile_counter_sale_refund") {
    try {
      const sale = await ctx.authority.reconcileCounterSaleRefund(
        route.merchantId,
        route.checkoutId,
      );
      return jsonResponse(200, sale);
    } catch (error) {
      return jsonResponse(409, { message: errorMessage(error) });
    }
  }
  if (
    route.kind === "entity_plane_list_entry" ||
    route.kind === "entity_plane_query" ||
    route.kind === "entity_plane_query_plan" ||
    route.kind === "entity_plane_capability_metadata" ||
    route.kind === "entity_plane_published_resource_metadata" ||
    route.kind === "entity_plane_export_preset" ||
    route.kind === "entity_plane_purchasing_preset" ||
    route.kind === "entity_plane_purchasing_reconcile" ||
    route.kind === "entity_plane_relationship_step" ||
    route.kind === "entity_plane_command" ||
    route.kind === "entity_plane_changes" ||
    route.kind === "entity_plane_system_extensions"
  ) {
    return handleEntityPlane(ctx, request, route);
  }
  switch (route.kind) {
    case "read_product_sales":
      return readProductSalesRoute(ctx, url, route);
    case "read_failed_payments":
      return readFailedPaymentsRoute(ctx, url, route);
    case "read_payments":
      return readPaymentsRoute(ctx, url, route);
    case "list_unplaced_captures":
      return listUnplacedCapturesRoute(ctx, route);
    case "resolve_unplaced_capture":
      return resolveUnplacedCaptureRoute(ctx, request, route);
    case "read_order_times":
      return readOrderTimesRoute(ctx, url, route);
    case "read_bank_payouts":
      return readBankPayoutsRoute(ctx, url, route);
    case "read_snapshot":
      return readSnapshotRoute(ctx, route);
    case "read_migration_inventory":
      return readMigrationInventoryRoute(ctx, route);
    case "read_food_service_snapshot":
      return readFoodServiceSnapshotRoute(ctx, route);
    case "read_stock_snapshot":
      return readStockSnapshotRoute(ctx, route);
    case "read_pickup_queue":
      return readPickupQueueRoute(ctx, route);
    case "read_sold_out_marks":
      return readSoldOutMarksRoute(ctx, route);
    case "read_preparation_ticket":
      return readPreparationTicketRoute(ctx, route);
    case "provision_merchant":
      return provisionMerchantRoute(ctx, request, route);
    case "close_merchant":
      return closeMerchantRoute(ctx, route);
    case "provision_demo":
      return provisionDemoRoute(ctx, request, route);
    case "acknowledge_delivery":
      return acknowledgeDeliveryRoute(ctx, request, route);
    case "create_location":
    case "prepare_catalog_listing":
    case "update_product_description":
    case "place_channel_listing":
    case "configure_pickup_storefront":
    case "configure_shipping_storefront":
    case "create_in_person_checkout":
    case "create_pickup_checkout":
    case "begin_checkout_payment":
    case "collect_in_person_checkout_payment":
    case "record_counter_cash_payment":
    case "record_checkout_payment_capture":
    case "observe_payment_dispute":
    case "place_paid_checkout":
    case "mark_pickup_ready":
    case "complete_pickup":
    case "cancel_order":
    case "refund_order":
    case "record_counter_manual_cash_refund":
    case "resolve_checkout_payment":
    case "expire_checkout":
    case "create_preparation_station":
    case "create_modifier_group_revision":
    case "create_recipe_revision":
    case "configure_stock_policy":
    case "publish_menu":
    case "mark_sold_out":
    case "manage_preparation_ticket":
    case "complete_production_batch":
    case "purchase_shipping_label":
    case "attach_fulfillment_tracking":
    case "record_shipping_tracking":
    case "publish_catalog_listing":
    case "create_inventory_item":
    case "open_inventory_position":
    case "receive_inventory":
      return merchantCommandRoute(ctx, request, route);
    case "publish_production_demand_preset":
      return publishProductionDemandPresetRoute(ctx, request, route);
    case "reconcile_inventory":
      return reconcileInventoryRoute(ctx, request, route);
    case "read_offer_price_policy":
      return readOfferPricePolicyRoute(ctx, route);
    case "set_offer_price_policy":
      return setOfferPricePolicyRoute(ctx, request, route);
    case "disable_offer_price_policy":
      return disableOfferPricePolicyRoute(ctx, request, route);
    case "create_customer":
    case "update_customer":
    case "erase_customer":
      return customerCommandRoute(ctx, request, route);
    case "read_customer":
      return readCustomerRoute(ctx, route);
    case "export_customer":
      return exportCustomerRoute(ctx, route);
    case "create_company":
    case "update_company":
      return companyCommandRoute(ctx, request, route);
    case "create_market":
    case "update_market":
      return marketCommandRoute(ctx, request, route);
    case "upload_media":
      return uploadMediaRoute(ctx, request, route);
    case "create_media":
    case "update_media":
    case "delete_media":
    case "set_product_media":
      return mediaCommandRoute(ctx, request, route);
    case "list_media":
      return listMediaRoute(ctx, route);
    case "read_media_content":
      return readMediaContentRoute(ctx, route);
    case "list_markets":
      return listMarketsRoute(ctx, route);
    case "list_invoices":
      return listInvoicesRoute(ctx, route);
    case "place_draft_order_on_terms":
    case "record_invoice_payment":
      return invoiceCommandRoute(ctx, request, route);
    case "list_companies":
      return listCompaniesRoute(ctx, route);
    case "create_discount":
    case "deactivate_discount":
      return discountCommandRoute(ctx, request, route);
    case "list_discounts":
      return listDiscountsRoute(ctx, route);
    case "issue_gift_card":
    case "credit_store_credit":
    case "disable_stored_value_account":
      return storedValueCommandRoute(ctx, request, route);
    case "list_stored_value_accounts":
      return listStoredValueAccountsRoute(ctx, route);
    case "read_stored_value_liability":
      return readStoredValueLiabilityRoute(ctx, url, route);
    case "create_collection":
    case "update_collection":
    case "delete_collection":
      return collectionCommandRoute(ctx, request, route);
    case "list_collections":
      return listCollectionsRoute(ctx, route);
    case "read_events":
      return readEventsRoute(ctx, url, route);
    case "read_order_record":
      return readOrderRecordRoute(ctx, route);
    case "read_feed_consumer":
    case "advance_feed_consumer":
      return feedConsumerRoute(ctx, request, route);
    case "list_payment_accounts":
      return listPaymentAccountsRoute(ctx, route);
    case "link_square_account":
      return linkSquareAccountRoute(ctx, request, route);
    case "connect_square":
    case "read_square_connection":
    case "disconnect_square":
    case "list_square_locations":
    case "list_square_devices":
    case "create_square_device_code":
    case "read_square_device_code":
      return squareConnectionRoute(ctx, request, url, route);
    case "link_stripe_account":
    case "start_stripe_onboarding":
      return stripeAccountRoute(ctx, request, route);
    case "settle_online_payment":
      return settleOnlinePaymentRoute(ctx, route);
    case "read_catalog_snapshot":
      return readCatalogSnapshotRoute(ctx, request, route);
    case "observe_stripe_dispute":
      return observeStripeDisputeRoute(ctx, request, route);
    case "issue_api_key":
    case "list_api_credentials":
    case "revoke_api_key":
    case "install_app":
    case "read_app_installation":
    case "uninstall_app":
      return credentialRoute(ctx, request, route);
    case "run_archive":
      return runArchiveRoute(ctx, route);
    case "create_webhook_subscription":
      return createWebhookSubscriptionRoute(ctx, request, route);
    case "restart_webhook_subscription":
    case "rotate_webhook_secret":
    case "delete_webhook_subscription":
      return webhookSubscriptionChangeRoute(ctx, request, route);
    case "list_webhook_subscriptions":
      return listWebhookSubscriptionsRoute(ctx, route);
    case "list_notifications":
      return listNotificationsRoute(ctx, route);
    case "read_order_changes":
      return readOrderChangesRoute(ctx, route);
    case "edit_order":
    case "record_order_manual_payment":
    case "exchange_order_lines":
      return orderEditRoute(ctx, request, route);
    case "list_order_returns":
      return listOrderReturnsRoute(ctx, route);
    case "request_return":
    case "authorize_return":
    case "receive_return":
    case "close_return":
      return returnCommandRoute(ctx, request, route);
    case "read_draft_order":
      return readDraftOrderRoute(ctx, route);
    case "list_plugins":
      return listPluginsRoute(ctx, route);
    case "preview_plugin_change":
      return previewPluginChangeRoute(ctx, request, route);
    case "install_merchant_plugin":
      return installMerchantPluginRoute(ctx, request, route);
    case "set_plugin_field_values":
      return setPluginFieldValuesRoute(ctx, request, route);
    case "run_plugin_action":
      return runPluginActionRoute(ctx, request, route);
    case "list_plugin_field_values":
      return listPluginFieldValuesRoute(ctx, route);
    case "run_plugin_function":
    case "preview_merchant_plugin":
      return merchantPluginFunctionRoute(ctx, request, route);
    case "pause_plugin":
    case "resume_plugin":
    case "remove_plugin":
      return pluginStateRoute(ctx, request, route);
    case "configure_plugin":
      return configurePluginRoute(ctx, request, route);
    case "refund_order_tenders":
      return refundOrderTendersRoute(ctx, request, route);
    case "create_draft_order":
    case "update_draft_order":
    case "cancel_draft_order":
    case "mark_draft_order_paid":
    case "send_draft_invoice":
      return draftOrderCommandRoute(ctx, request, route);
    case "update_product":
    case "update_variant":
    case "update_offer":
      return catalogEditRoute(ctx, request, route);
    case "delete_product":
      return deleteProductRoute(ctx, request, route);
    case "update_storefront_tax":
      return updateStorefrontTaxRoute(ctx, request, route);
    case "adjust_offer_price":
      return adjustOfferPriceRoute(ctx, request, route);
    case "quote_shipment_label_rate":
      return quoteShipmentLabelRateRoute(ctx, request, route);
  }
}
