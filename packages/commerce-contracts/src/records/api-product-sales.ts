// Plan 78 step 2: the product sales report that
// packages/commerce-client reads in src/product-sales.ts. The
// schema follows its hand-written reader: the reader keeps the fields it
// knows, and a reported population names each order line once, inside the
// window, at one revision of each order.
import { Type, type Static } from "typebox";
import {
  NonNegativeInteger,
  PositiveInteger,
} from "@purin-labs/contract-schema";
import { normalizedTextSchema } from "./fields.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;
const currency = Type.String({ pattern: "^[A-Z]{3}$" });

/** `instant`: an ISO string exactly as `Date.toISOString` writes it. */
const instantSchema = Type.Refine(text, isInstant, instantError);

function isInstant(value: string): boolean {
  return (
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function instantError(): string {
  return "product sales timestamp invalid";
}

const lineProperties = {
  orderId: text,
  orderRevision: PositiveInteger,
  lineId: text,
  acceptedAt: instantSchema,
};

const productSalesLineSchema = ReadonlyOpenObject(lineProperties);
export type ProductSalesLine = Static<typeof productSalesLineSchema>;

const productSalesGroupSchema = ReadonlyOpenObject({
  productId: text,
  currency,
  merchandiseMinor: NonNegativeInteger,
  lines: ImmutableArray(productSalesLineSchema),
});
export type ProductSalesGroup = Static<typeof productSalesGroupSchema>;

const productSalesWindowSchema = Type.Refine(
  ReadonlyOpenObject({ start: instantSchema, end: instantSchema }),
  isWindow,
  windowError,
);
export type ProductSalesWindow = Static<typeof productSalesWindowSchema>;

function isWindow(window: Readonly<{ start: string; end: string }>): boolean {
  return window.start < window.end;
}

function windowError(): string {
  return "product sales window invalid";
}

const unmatchedProductSalesLineSchema = Type.Intersect([
  ReadonlyOpenObject(lineProperties),
  ReadonlyOpenObject({
    reason: Type.Union([
      Type.Literal("source_only"),
      Type.Literal("variant_revision_unavailable"),
    ]),
    currency,
    merchandiseMinor: NonNegativeInteger,
  }),
]);
export type UnmatchedProductSalesLine = Static<
  typeof unmatchedProductSalesLineSchema
>;

const reportBase = ReadonlyOpenObject({
  organisationId: text,
  merchantId: text,
  merchantRevision: PositiveInteger,
  window: productSalesWindowSchema,
});

type ReportedFields = Readonly<{
  window: ProductSalesWindow;
  groups: readonly ProductSalesGroup[];
  unmatchedLines: readonly UnmatchedProductSalesLine[];
  ordersWithAdjustments: readonly string[];
  orderCount: number;
}>;

/** The cross checks of the reader's evidence and population. */
function isConsistentReport(value: unknown): boolean {
  const report = value as ReportedFields;
  const groupKeys = new Set<string>();
  for (const group of report.groups) {
    const key = JSON.stringify([group.productId, group.currency]);
    if (groupKeys.has(key) || group.lines.length === 0) return false;
    groupKeys.add(key);
  }
  const lines = new Set<string>();
  const orders = new Map<string, number>();
  for (const entry of [
    ...report.groups.flatMap(linesOf),
    ...report.unmatchedLines,
  ]) {
    const key = JSON.stringify([entry.orderId, entry.lineId]);
    const revision = orders.get(entry.orderId);
    if (
      lines.has(key) ||
      entry.acceptedAt < report.window.start ||
      entry.acceptedAt >= report.window.end ||
      (revision !== undefined && revision !== entry.orderRevision)
    )
      return false;
    lines.add(key);
    orders.set(entry.orderId, entry.orderRevision);
  }
  return (
    orders.size === report.orderCount &&
    new Set(report.ordersWithAdjustments).size ===
      report.ordersWithAdjustments.length &&
    report.ordersWithAdjustments.every(orders.has.bind(orders))
  );
}

function linesOf(group: ProductSalesGroup): readonly ProductSalesLine[] {
  return group.lines;
}

function inconsistentReport(): string {
  return "product sales evidence invalid";
}

const productSalesReportSchema = Type.Union([
  Type.Intersect([
    reportBase,
    ReadonlyOpenObject({
      kind: Type.Literal("unavailable"),
      reason: Type.Union([
        Type.Literal("population_limit"),
        Type.Literal("acceptance_time_missing"),
        Type.Literal("money_basis_unreconciled"),
        Type.Literal("invalid_source_record"),
      ]),
    }),
  ]),
  Type.Refine(
    Type.Intersect([
      reportBase,
      ReadonlyOpenObject({
        kind: Type.Literal("reported"),
        metric: Type.Literal("booked_merchandise_before_refunds"),
        population: Type.Literal("accepted_non_cancelled_orders"),
        groups: ImmutableArray(productSalesGroupSchema),
        unmatchedLines: ImmutableArray(unmatchedProductSalesLineSchema),
        ordersWithAdjustments: ImmutableArray(text),
        orderCount: NonNegativeInteger,
      }),
    ]),
    isConsistentReport,
    inconsistentReport,
  ),
]);
export type ProductSalesReport = Static<typeof productSalesReportSchema>;

// Parsers of the client API types (Plan 78 step 2).
export const parseProductSalesReport = wireRecordParser(
  productSalesReportSchema,
);
