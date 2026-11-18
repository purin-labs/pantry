import { parsePurchasingPresetPublishRequest } from "@seams/commerce-client";
import type { BuyerRoute, CommerceRoute } from "../../http-routes.ts";
import { errorMessage } from "@seams/std";
import { FOOD_SERVICE_ROUTES } from "../admission.ts";
import type { HttpRouteContext } from "../context.ts";
import {
  hasCheckoutId,
  hasFulfillmentId,
  hasMerchantId,
  hasOrderId,
  hasPaymentAttemptId,
  hasProductId,
  hasShipmentId,
  readJsonBody,
} from "../request-body.ts";
import { entityPlaneErrorResponse, jsonResponse } from "../responses.ts";

export async function merchantCommandRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    {
      kind:
        | "create_location"
        | "prepare_catalog_listing"
        | "update_product_description"
        | "place_channel_listing"
        | "configure_pickup_storefront"
        | "configure_shipping_storefront"
        | "create_in_person_checkout"
        | "create_pickup_checkout"
        | "begin_checkout_payment"
        | "collect_in_person_checkout_payment"
        | "record_checkout_payment_capture"
        | "observe_payment_dispute"
        | "place_paid_checkout"
        | "mark_pickup_ready"
        | "complete_pickup"
        | "cancel_order"
        | "refund_order"
        | "resolve_checkout_payment"
        | "expire_checkout"
        | "create_preparation_station"
        | "create_modifier_group_revision"
        | "create_recipe_revision"
        | "configure_stock_policy"
        | "publish_menu"
        | "mark_sold_out"
        | "manage_preparation_ticket"
        | "complete_production_batch"
        | "purchase_shipping_label"
        | "attach_fulfillment_tracking"
        | "record_shipping_tracking"
        | "publish_catalog_listing"
        | "create_inventory_item"
        | "open_inventory_position"
        | "receive_inventory";
    }
  >,
): Promise<Response> {
  if (FOOD_SERVICE_ROUTES.has(route.kind) && !ctx.authority.hasFoodService)
    return jsonResponse(404, {
      message: "The food service extension is not installed",
    });
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    (route.kind === "update_product_description" &&
      !hasProductId(body.value, route.productId)) ||
    ((route.kind === "begin_checkout_payment" ||
      route.kind === "collect_in_person_checkout_payment") &&
      !hasCheckoutId(body.value, route.checkoutId)) ||
    ((route.kind === "record_checkout_payment_capture" ||
      route.kind === "place_paid_checkout") &&
      (!hasCheckoutId(body.value, route.checkoutId) ||
        !hasPaymentAttemptId(body.value, route.paymentAttemptId))) ||
    (route.kind === "mark_pickup_ready" &&
      (!hasOrderId(body.value, route.orderId) ||
        !hasFulfillmentId(body.value, route.fulfillmentId))) ||
    (route.kind === "complete_pickup" &&
      (!hasOrderId(body.value, route.orderId) ||
        !hasFulfillmentId(body.value, route.fulfillmentId))) ||
    (route.kind === "cancel_order" && !hasOrderId(body.value, route.orderId)) ||
    (route.kind === "refund_order" && !hasOrderId(body.value, route.orderId)) ||
    (route.kind === "resolve_checkout_payment" &&
      (!hasCheckoutId(body.value, route.checkoutId) ||
        !hasPaymentAttemptId(body.value, route.paymentAttemptId))) ||
    (route.kind === "expire_checkout" &&
      !hasCheckoutId(body.value, route.checkoutId)) ||
    ((route.kind === "purchase_shipping_label" ||
      route.kind === "attach_fulfillment_tracking" ||
      route.kind === "record_shipping_tracking") &&
      !hasShipmentId(body.value, route.shipmentId))
  ) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  return jsonResponse(
    200,
    route.kind === "create_location"
      ? ctx.authority.createLocation(body.value)
      : route.kind === "prepare_catalog_listing"
        ? ctx.authority.prepareCatalogListing(body.value)
        : route.kind === "update_product_description"
          ? ctx.authority.updateProductDescription(body.value)
          : route.kind === "place_channel_listing"
            ? ctx.authority.placeChannelListing(body.value)
            : route.kind === "configure_pickup_storefront"
              ? ctx.authority.configurePickupStorefront(body.value)
              : route.kind === "configure_shipping_storefront"
                ? ctx.authority.configureShippingStorefront(body.value)
                : route.kind === "create_in_person_checkout"
                  ? ctx.authority.createInPersonCheckout(body.value)
                  : route.kind === "create_pickup_checkout"
                    ? ctx.authority.createPickupCheckout(body.value)
                    : route.kind === "begin_checkout_payment"
                      ? ctx.authority.beginCheckoutPayment(body.value)
                      : route.kind === "collect_in_person_checkout_payment"
                        ? await ctx.authority.collectInPersonCheckoutPayment(
                            body.value,
                          )
                        : route.kind === "record_checkout_payment_capture"
                          ? ctx.authority.recordCheckoutPaymentCapture(
                              body.value,
                            )
                          : route.kind === "observe_payment_dispute"
                            ? ctx.authority.observePaymentDispute(body.value)
                            : route.kind === "place_paid_checkout"
                              ? ctx.authority.placePaidCheckout(body.value)
                              : route.kind === "mark_pickup_ready"
                                ? ctx.authority.markPickupReady(body.value)
                                : route.kind === "complete_pickup"
                                  ? ctx.authority.completePickup(body.value)
                                  : route.kind === "cancel_order"
                                    ? await ctx.authority.cancelOrder(
                                        body.value,
                                      )
                                    : route.kind === "refund_order"
                                      ? await ctx.authority.refundOrder(
                                          body.value,
                                        )
                                      : route.kind ===
                                          "resolve_checkout_payment"
                                        ? ctx.authority.resolveCheckoutPayment(
                                            body.value,
                                          )
                                        : route.kind === "expire_checkout"
                                          ? ctx.authority.expireCheckout(
                                              body.value,
                                            )
                                          : route.kind ===
                                              "create_preparation_station"
                                            ? ctx.authority.createPreparationStation(
                                                body.value,
                                              )
                                            : route.kind ===
                                                "create_modifier_group_revision"
                                              ? ctx.authority.createModifierGroupRevision(
                                                  body.value,
                                                )
                                              : route.kind ===
                                                  "create_recipe_revision"
                                                ? ctx.authority.createRecipeRevision(
                                                    body.value,
                                                  )
                                                : route.kind ===
                                                    "configure_stock_policy"
                                                  ? ctx.authority.configureStockPolicy(
                                                      body.value,
                                                    )
                                                  : route.kind ===
                                                      "publish_menu"
                                                    ? ctx.authority.publishMenu(
                                                        body.value,
                                                      )
                                                    : route.kind ===
                                                        "mark_sold_out"
                                                      ? ctx.authority.markSoldOut(
                                                          body.value,
                                                        )
                                                      : route.kind ===
                                                          "manage_preparation_ticket"
                                                        ? ctx.authority.managePreparationTicket(
                                                            body.value,
                                                          )
                                                        : route.kind ===
                                                            "complete_production_batch"
                                                          ? ctx.authority.completeProductionBatch(
                                                              body.value,
                                                            )
                                                          : route.kind ===
                                                              "purchase_shipping_label"
                                                            ? ctx.authority.purchaseShippingLabel(
                                                                body.value,
                                                              )
                                                            : route.kind ===
                                                                "attach_fulfillment_tracking"
                                                              ? ctx.authority.attachFulfillmentTracking(
                                                                  body.value,
                                                                )
                                                              : route.kind ===
                                                                  "record_shipping_tracking"
                                                                ? ctx.authority.recordShippingTracking(
                                                                    body.value,
                                                                  )
                                                                : route.kind ===
                                                                    "publish_catalog_listing"
                                                                  ? ctx.authority.publishCatalogListing(
                                                                      body.value,
                                                                    )
                                                                  : route.kind ===
                                                                      "create_inventory_item"
                                                                    ? ctx.authority.createInventoryItem(
                                                                        body.value,
                                                                      )
                                                                    : route.kind ===
                                                                        "open_inventory_position"
                                                                      ? ctx.authority.openInventoryPosition(
                                                                          body.value,
                                                                        )
                                                                      : ctx.authority.receiveInventory(
                                                                          body.value,
                                                                        ),
  );
}

export async function publishProductionDemandPresetRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "publish_production_demand_preset" }
  >,
): Promise<Response> {
  if (ctx.entityPlane === undefined)
    return jsonResponse(503, { message: "Entity plane unavailable" });
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  try {
    const command = parsePurchasingPresetPublishRequest(body.value);
    if (command.merchantId !== route.merchantId)
      return jsonResponse(400, { message: "Merchant scope mismatch" });
    return jsonResponse(
      200,
      ctx.entityPlane.publishProductionDemandPreset(command),
    );
  } catch (error) {
    return (
      entityPlaneErrorResponse(error) ??
      jsonResponse(400, { message: errorMessage(error) })
    );
  }
}

export async function reconcileInventoryRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "reconcile_inventory" }
  >,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (!hasMerchantId(body.value, route.merchantId))
    return jsonResponse(400, { error: "merchant_scope_mismatch" });
  return jsonResponse(200, ctx.authority.reconcileInventory(body.value));
}
