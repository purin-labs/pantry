import {
  orderOriginCheckoutId,
  parseOrder,
  type CommerceOrderV1,
  type ProductSalesWindow,
  type ProductSalesReport,
} from "@purin-labs/commerce-client";
export type {
  ProductSalesWindow,
  ProductSalesReport,
} from "@purin-labs/commerce-client";
import type { CommerceDatabase } from "../database.ts";
import type { Variant } from "@purin-labs/type-utils";

type ReportedSales = Variant<ProductSalesReport, "reported">;
type SalesGroup = ReportedSales["groups"][number];
type UnmatchedLine = ReportedSales["unmatchedLines"][number];

const MAX_ORDERS = 1_000;

export function parseProductSalesWindow(
  start: string | null,
  end: string | null,
): ProductSalesWindow | null {
  if (
    !isInstant(start) ||
    !isInstant(end) ||
    Date.parse(start) >= Date.parse(end)
  )
    return null;
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
}

export function readProductSales(
  database: CommerceDatabase,
  merchantId: string,
  window: ProductSalesWindow,
): ProductSalesReport | undefined {
  return database.transaction(
    readSnapshotReport.bind(null, database, merchantId, window),
  );
}

function readSnapshotReport(
  database: CommerceDatabase,
  merchantId: string,
  window: ProductSalesWindow,
): ProductSalesReport | undefined {
  const merchant = database
    .prepare(
      "SELECT external_reference AS organisationId, revision AS merchantRevision FROM merchant WHERE merchant_id = ?",
    )
    .get<{ organisationId: string; merchantRevision: number }>(merchantId);
  if (merchant === undefined) return undefined;
  const context = { ...merchant, merchantId, window };
  const rows = database
    .prepare(
      "SELECT order_snapshot_json AS snapshot FROM commerce_order WHERE merchant_id = ? ORDER BY resource_id LIMIT ?",
    )
    .all<{ snapshot: string }>(merchantId, MAX_ORDERS + 1);
  if (rows.length > MAX_ORDERS)
    return { ...context, kind: "unavailable", reason: "population_limit" };
  const groups = new Map<string, SalesGroup>();
  const unmatchedLines: UnmatchedLine[] = [];
  const ordersWithAdjustments: string[] = [];
  let orderCount = 0;
  let lineCount = 0;
  try {
    for (const row of rows) {
      const order = parseOrder(JSON.parse(row.snapshot));
      lineCount += order.lineItems.length;
      if (lineCount > 10_000)
        return { ...context, kind: "unavailable", reason: "population_limit" };
      if (
        order.lifecycle.state === "pending_confirmation" ||
        order.lifecycle.state === "cancelled"
      )
        continue;
      const acceptedAt = acceptanceTime(database, merchantId, order);
      if (acceptedAt === null)
        return {
          ...context,
          kind: "unavailable",
          reason: "acceptance_time_missing",
        };
      if (acceptedAt < window.start || acceptedAt >= window.end) continue;
      const amounts = merchandiseAmounts(order);
      if (amounts === null)
        return {
          ...context,
          kind: "unavailable",
          reason: "money_basis_unreconciled",
        };
      orderCount += 1;
      if (order.adjustments.length > 0) ordersWithAdjustments.push(order.id);
      for (let index = 0; index < order.lineItems.length; index += 1) {
        const line = order.lineItems[index];
        const merchandiseMinor = amounts[index];
        if (line === undefined || merchandiseMinor === undefined)
          throw new Error("missing line");
        const evidence = {
          orderId: order.id,
          orderRevision: order.revision,
          lineId: line.id,
          acceptedAt,
        };
        const currency = line.unitPrice.currency;
        if (line.source.kind === "source_only") {
          unmatchedLines.push({
            ...evidence,
            reason: "source_only",
            currency,
            merchandiseMinor,
          });
          continue;
        }
        // A variant never moves to another product, so its current row names
        // the product of every revision that was sold, also after an edit.
        const variant = database
          .prepare(
            "SELECT product_id AS productId FROM sellable_variant WHERE merchant_id = ? AND resource_id = ?",
          )
          .get<{ productId: string }>(merchantId, line.source.variantId);
        if (variant === undefined) {
          unmatchedLines.push({
            ...evidence,
            reason: "variant_revision_unavailable",
            currency,
            merchandiseMinor,
          });
          continue;
        }
        const key = JSON.stringify([variant.productId, currency]);
        const current = groups.get(key);
        const total = (current?.merchandiseMinor ?? 0) + merchandiseMinor;
        if (!Number.isSafeInteger(total))
          return {
            ...context,
            kind: "unavailable",
            reason: "money_basis_unreconciled",
          };
        groups.set(key, {
          productId: variant.productId,
          currency,
          merchandiseMinor: total,
          lines: [...(current?.lines ?? []), evidence],
        });
      }
    }
  } catch {
    return { ...context, kind: "unavailable", reason: "invalid_source_record" };
  }
  return {
    ...context,
    kind: "reported",
    metric: "booked_merchandise_before_refunds",
    population: "accepted_non_cancelled_orders",
    groups: [...groups.values()],
    unmatchedLines,
    ordersWithAdjustments,
    orderCount,
  };
}

function acceptanceTime(
  database: CommerceDatabase,
  merchantId: string,
  order: CommerceOrderV1,
): string | null {
  const checkoutId = orderOriginCheckoutId(order.origin);
  if (checkoutId === undefined) return null;
  const row = database
    .prepare(
      `SELECT json_extract(checkout_json, '$.lifecycle.acceptedAt') AS acceptedAt
       FROM buyer_checkout WHERE merchant_id = ? AND checkout_id = ? AND lifecycle_state = 'accepted'
        AND json_extract(checkout_json, '$.lifecycle.state') = 'accepted'
        AND json_extract(checkout_json, '$.lifecycle.orderId') = ?`,
    )
    .get<{ acceptedAt: unknown }>(merchantId, checkoutId, order.id);
  return isInstant(row?.acceptedAt)
    ? new Date(row.acceptedAt).toISOString()
    : null;
}

function merchandiseAmounts(
  order: CommerceOrderV1,
): readonly number[] | null {
  const currency = order.totals.total.currency;
  let gross = 0n;
  let discount = 0n;
  const amounts: number[] = [];
  const lineIds = new Set<string>();
  for (const line of order.lineItems) {
    if (lineIds.has(line.id)) return null;
    lineIds.add(line.id);
    for (const money of [
      line.unitPrice,
      line.discount,
      line.tax,
      line.lineTotal,
    ]) {
      if (money.currency !== currency) return null;
    }
    const numerator =
      BigInt(line.unitPrice.amountMinor) * BigInt(line.quantity.amount);
    const divisor = 10n ** BigInt(line.quantity.scale);
    if (numerator % divisor !== 0n) return null;
    const lineGross = numerator / divisor;
    const lineDiscount = BigInt(line.discount.amountMinor);
    const net = lineGross - lineDiscount;
    if (
      net < 0n ||
      net > BigInt(Number.MAX_SAFE_INTEGER) ||
      BigInt(line.lineTotal.amountMinor) !== net
    )
      return null;
    gross += lineGross;
    discount += lineDiscount;
    amounts.push(Number(net));
  }
  const totals = order.totals;
  for (const money of Object.values(totals)) {
    if (money !== true && money.currency !== currency) return null;
  }
  if (
    gross !== BigInt(totals.subtotal.amountMinor) ||
    discount !== BigInt(totals.discount.amountMinor)
  )
    return null;
  const reconciled =
    gross -
    discount +
    (totals.taxIncluded === true ? 0n : BigInt(totals.tax.amountMinor)) +
    BigInt(totals.duty.amountMinor) +
    BigInt(totals.shipping.amountMinor) +
    BigInt(totals.serviceFee.amountMinor) +
    BigInt(totals.tip.amountMinor) +
    BigInt(totals.rounding.amountMinor);
  return reconciled === BigInt(totals.total.amountMinor) ? amounts : null;
}

function isInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
