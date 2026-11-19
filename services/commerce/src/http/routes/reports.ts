import type { BuyerRoute, CommerceRoute } from "../../http-routes.ts";
import { parseProductSalesWindow } from "../../commerce-authority/product-sales.ts";
import { parseBankPayoutWindow } from "../../payments/bank-payouts.ts";
import { errorMessage } from "@purin-labs/std";
import type { HttpRouteContext } from "../context.ts";
import { jsonResponse } from "../responses.ts";
import type { Variant } from "@purin-labs/type-utils";

export async function readProductSalesRoute(
  ctx: HttpRouteContext,
  url: URL,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_product_sales">,
): Promise<Response> {
  const window = parseProductSalesWindow(
    url.searchParams.get("start"),
    url.searchParams.get("end"),
  );
  if (window === null)
    return jsonResponse(422, {
      message: "A valid half-open UTC start/end window is required",
    });
  const report = ctx.authority.readProductSales(route.merchantId, window);
  return report === undefined
    ? jsonResponse(404, { message: "Merchant not found" })
    : jsonResponse(200, report);
}

export async function readFailedPaymentsRoute(
  ctx: HttpRouteContext,
  url: URL,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_failed_payments">,
): Promise<Response> {
  const window = parseProductSalesWindow(
    url.searchParams.get("start"),
    url.searchParams.get("end"),
  );
  if (window === null)
    return jsonResponse(422, {
      message: "A valid half-open UTC start/end window is required",
    });
  const failed = ctx.authority.readFailedPayments(route.merchantId, window);
  return failed === undefined
    ? jsonResponse(404, { message: "Merchant not found" })
    : jsonResponse(200, failed);
}

export async function readPaymentsRoute(
  ctx: HttpRouteContext,
  url: URL,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_payments">,
): Promise<Response> {
  const window = parseProductSalesWindow(
    url.searchParams.get("start"),
    url.searchParams.get("end"),
  );
  if (window === null)
    return jsonResponse(422, {
      message: "A valid half-open UTC start/end window is required",
    });
  const payments = ctx.authority.readPayments(route.merchantId, window);
  return payments === undefined
    ? jsonResponse(404, { message: "Merchant not found" })
    : jsonResponse(200, payments);
}

export async function readOrderTimesRoute(
  ctx: HttpRouteContext,
  url: URL,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_order_times">,
): Promise<Response> {
  const window = parseProductSalesWindow(
    url.searchParams.get("start"),
    url.searchParams.get("end"),
  );
  if (window === null)
    return jsonResponse(422, {
      message: "A valid half-open UTC start/end window is required",
    });
  const times = ctx.authority.readOrderTimes(route.merchantId, window);
  return times === undefined
    ? jsonResponse(404, { message: "Merchant not found" })
    : jsonResponse(200, times);
}

export async function readBankPayoutsRoute(
  ctx: HttpRouteContext,
  url: URL,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_bank_payouts">,
): Promise<Response> {
  const window = parseBankPayoutWindow(
    url.searchParams.get("start"),
    url.searchParams.get("end"),
  );
  if (window === null)
    return jsonResponse(422, {
      message: "A valid half-open window of calendar days is required",
    });
  return jsonResponse(
    200,
    ctx.bankPayouts === undefined
      ? {
          schemaVersion: "underclerk.bank-payouts.v1",
          merchantId: route.merchantId,
          sources: [],
          truncated: false,
          payouts: [],
        }
      : await ctx.bankPayouts.read(route.merchantId, window),
  );
}

export async function readSnapshotRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_snapshot">,
): Promise<Response> {
  const snapshot = ctx.authority.readSnapshot(route.merchantId);
  return snapshot === undefined
    ? jsonResponse(404, { message: "Merchant not found" })
    : jsonResponse(200, snapshot);
}

export async function readMigrationInventoryRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_migration_inventory">,
): Promise<Response> {
  const inventory = ctx.authority.readMigrationInventory(route.merchantId);
  return inventory === undefined
    ? jsonResponse(404, { message: "Merchant not found" })
    : jsonResponse(200, inventory);
}

export async function readFoodServiceSnapshotRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_food_service_snapshot">,
): Promise<Response> {
  const snapshot = ctx.authority.readFoodServiceSnapshot(route.merchantId);
  return snapshot === undefined
    ? jsonResponse(404, { message: "Merchant not found" })
    : jsonResponse(200, snapshot);
}

export async function readStockSnapshotRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_stock_snapshot">,
): Promise<Response> {
  const snapshot = ctx.authority.readStockSnapshot(route.merchantId);
  return snapshot === undefined
    ? jsonResponse(404, { message: "Merchant not found" })
    : jsonResponse(200, snapshot);
}

export async function readPickupQueueRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_pickup_queue">,
): Promise<Response> {
  const queue = ctx.authority.readPickupQueue(route.merchantId);
  return queue === undefined
    ? jsonResponse(404, { message: "Merchant not found" })
    : jsonResponse(200, queue);
}

export async function readSoldOutMarksRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_sold_out_marks">,
): Promise<Response> {
  const marks = ctx.authority.readSoldOutMarks(route.merchantId);
  return marks === undefined
    ? jsonResponse(404, { message: "Merchant not found" })
    : jsonResponse(200, marks);
}

export async function readPreparationTicketRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_preparation_ticket">,
): Promise<Response> {
  const ticket = ctx.authority.readPreparationTicket(
    route.merchantId,
    route.ticketId,
  );
  return ticket === undefined
    ? jsonResponse(404, { message: "Preparation ticket not found" })
    : jsonResponse(200, ticket);
}

export async function readEventsRoute(
  ctx: HttpRouteContext,
  url: URL,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_events">,
): Promise<Response> {
  const after = url.searchParams.get("after") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? "100");
  if (!Number.isSafeInteger(limit) || limit < 1)
    return jsonResponse(400, {
      message: "limit must be a positive integer",
    });
  try {
    return jsonResponse(200, {
      schemaVersion: "underclerk.events.v1",
      ...(await ctx.authority.readEvents(
        route.merchantId,
        after,
        limit,
        ctx.archive,
      )),
    });
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
}

export async function readOrderRecordRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_order_record">,
): Promise<Response> {
  const record = await ctx.authority.readOrderRecord(
    route.merchantId,
    route.orderId,
    ctx.archive,
  );
  return record === undefined
    ? jsonResponse(404, { message: "Order not found" })
    : jsonResponse(200, record);
}
