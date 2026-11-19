// The checkout pipeline's shared stages (Plan 77 step 2). Pickup and
// shipping checkouts price their lines in their own way, then run the same
// stages in the same order: discounts off the lines, tax and shipping on what
// is left, the total, and stored value against the total. Each stage returns
// its part of the quote and the holds that it takes. A stage whose plugin the
// merchant paused (step 3) takes nothing and holds nothing. Merchant plugin
// hooks (step 4) run next to the stages: lines after pricing, discount after
// the code discounts, tenders before stored value, delivery when the ready
// time or the shipping quote is known, and validate on the priced quote.
import type { CommerceResourcesV1 } from "@purin-labs/commerce-client";
import type { CommerceMutationErrorV1 } from "@purin-labs/commerce-client";
import type {
  CheckoutPluginRun,
  CheckoutQuoteSnapshot,
  CheckoutStoredValueTender,
} from "@purin-labs/commerce-contracts";

import type { CommerceDatabase } from "../database.ts";
import {
  parseDeliveryOutput,
  parseDiscountOutput,
  parseLinesOutput,
  parseTendersOutput,
  runCheckoutHook,
  type HookInput,
} from "../plugins/checkout-hooks.ts";
import { activeCompanyOf } from "../plugins/companies/index.ts";
import { pluginActive } from "../plugins/plugin-state.ts";
import {
  validateStage,
  type CheckoutValidationInput,
  type PluginFunctionFailure,
  type ValidationResult,
} from "../plugins/merchant-plugins.ts";
import {
  evaluateCheckoutDiscounts,
  type CheckoutDiscountRequest,
  type DiscountHold,
} from "../plugins/discounts/index.ts";
import {
  evaluateCheckoutStoredValue,
  type CheckoutStoredValueRequest,
} from "../plugins/stored-value/index.ts";

type Money = Readonly<{ amountMinor: number; currency: string }>;
type QuoteLine = CheckoutQuoteSnapshot["lines"][number];

/**
 * B2B company prices (Plan 76 phase 8 slice 2): a signed-in member of an
 * active company pays the company's unit price of each listed catalog line,
 * when the checkout is in the company's currency. It runs on shop prices,
 * before the lines hook and the discounts.
 */
export function companyPriceStage(
  database: CommerceDatabase,
  merchantId: string,
  input: Readonly<{
    customerId: string | null;
    currency: string;
    lines: readonly QuoteLine[];
  }>,
): readonly QuoteLine[] {
  if (!pluginActive(database, merchantId, "companies")) return input.lines;
  const company = activeCompanyOf(database, merchantId, input.customerId);
  if (company === undefined || company.prices.currency !== input.currency)
    return input.lines;
  return input.lines.map((line) => {
    const source = line.source;
    if (source.kind !== "catalog" || line.priceOverride !== undefined)
      return line;
    const item = company.prices.items.find(
      (candidate) => candidate.variantId === source.variantId,
    );
    return item === undefined
      ? line
      : {
          ...line,
          unitPrice: {
            amountMinor: item.amountMinor,
            currency: input.currency,
          },
          lineTotal: {
            amountMinor: item.amountMinor * line.quantity.amount,
            currency: input.currency,
          },
        };
  });
}

type StageResult<T> =
  | Readonly<{ kind: "applied"; value: T }>
  | Readonly<{ kind: "rejected"; field: string }>;

type DiscountStage = Readonly<{
  /** The lines with each discount taken off its line total. */
  lines: readonly QuoteLine[];
  discountTotal: number;
  holds: readonly DiscountHold[];
  customerId: string | null;
}>;

/** Discounts come off the lines before tax, so tax is on what is paid. */
export function discountStage(
  database: CommerceDatabase,
  merchantId: string,
  input: Readonly<{
    checkoutId: string;
    request: CheckoutDiscountRequest | undefined;
    at: string;
    currency: string;
    lines: readonly QuoteLine[];
    variants: CommerceResourcesV1["variants"];
  }>,
): StageResult<DiscountStage> {
  const request = input.request ?? { codes: [], customerId: null };
  if (!pluginActive(database, merchantId, "discounts"))
    return {
      kind: "applied",
      value: {
        lines: input.lines,
        discountTotal: 0,
        holds: [],
        customerId: request.customerId,
      },
    };
  const evaluation = evaluateCheckoutDiscounts(database, merchantId, {
    checkoutId: input.checkoutId,
    request,
    at: input.at,
    currency: input.currency,
    lines: input.lines.map((line) => ({
      productId:
        line.source.kind === "order_balance"
          ? null
          : (input.variants.find(
              (variant) =>
                line.source.kind !== "order_balance" &&
                variant.id === line.source.variantId,
            )?.productId ?? null),
      amountMinor: line.lineTotal.amountMinor,
    })),
  });
  if (evaluation.kind === "rejected") return evaluation;
  let discountTotal = 0;
  const lines = input.lines.map((line, index) => {
    const discount = evaluation.lineDiscounts[index] ?? 0;
    if (discount === 0) return line;
    discountTotal += discount;
    return {
      ...line,
      lineTotal: {
        amountMinor: line.lineTotal.amountMinor - discount,
        currency: input.currency,
      },
      discount: { amountMinor: discount, currency: input.currency },
    };
  });
  return {
    kind: "applied",
    value: {
      lines,
      discountTotal,
      holds: evaluation.holds,
      customerId: request.customerId,
    },
  };
}

type StoredValueStage = Readonly<{
  tenders: readonly CheckoutStoredValueTender[];
  /** The quote's stored value part, when an account pays. */
  quote: CheckoutQuoteSnapshot["storedValue"];
}>;

/** Gift cards and store credit pay the taxed total; they are not discounts. */
export function storedValueStage(
  database: CommerceDatabase,
  merchantId: string,
  input: Readonly<{
    checkoutId: string;
    request: CheckoutStoredValueRequest | undefined;
    at: string;
    total: Money;
  }>,
): StageResult<StoredValueStage> {
  const evaluation =
    input.request === undefined ||
    !pluginActive(database, merchantId, "stored_value")
      ? { kind: "applied" as const, tenders: [] }
      : evaluateCheckoutStoredValue(database, merchantId, {
          checkoutId: input.checkoutId,
          request: input.request,
          at: input.at,
          total: input.total,
        });
  if (evaluation.kind === "rejected") return evaluation;
  const amount = evaluation.tenders.reduce(
    (sum, tender) => sum + tender.amount.amountMinor,
    0,
  );
  const { currency } = input.total;
  return {
    kind: "applied",
    value: {
      tenders: evaluation.tenders,
      quote:
        evaluation.tenders.length === 0
          ? undefined
          : {
              tenders: [...evaluation.tenders],
              amount: { amountMinor: amount, currency },
              due: { amountMinor: input.total.amountMinor - amount, currency },
            },
    },
  };
}

type ValidationQuote = Readonly<{
  checkoutId: string;
  kind: "pickup" | "shipping";
  quotedAt: string;
  currency: string;
  readyBy: string;
  lines: readonly QuoteLine[];
  variants: CommerceResourcesV1["variants"];
  subtotalMinor: number;
  totalMinor: number;
  /** The signed-in buyer, or null for a guest. A plugin never reads it. */
  customerId: string | null;
}>;

/**
 * Merchant plugins check the priced quote (Plan 77 step 4). A refusal ends
 * the checkout with the plugin's message; the runs go on the quote. A plugin
 * with customer fields reads its values on the buyer as
 * `checkout.customerFields`.
 */
export function validationStage(
  database: CommerceDatabase,
  merchantId: string,
  input: ValidationQuote,
): ValidationResult {
  return validateStage(
    database,
    merchantId,
    checkoutValidationInput(input),
    input.customerId,
  );
}

/** What a `checkout.validate` function reads of a quote. */
export function checkoutValidationInput(
  input: Omit<ValidationQuote, "customerId">,
): CheckoutValidationInput {
  return {
    checkoutId: input.checkoutId,
    kind: input.kind,
    quotedAt: input.quotedAt,
    currency: input.currency,
    readyBy: input.readyBy,
    lines: input.lines.map((line) => {
      const variantId =
        line.source.kind === "order_balance" ? null : line.source.variantId;
      return {
        checkoutLineId: line.checkoutLineId,
        variantId,
        productId:
          input.variants.find((variant) => variant.id === variantId)
            ?.productId ?? null,
        sku: line.source.kind === "catalog" ? line.source.merchantCode : null,
        title: line.title ?? "",
        quantity: line.quantity.amount,
        unitPriceMinor: line.unitPrice.amountMinor,
        lineTotalMinor: line.lineTotal.amountMinor,
      };
    }),
    subtotalMinor: input.subtotalMinor,
    totalMinor: input.totalMinor,
  };
}

/** The quote as far as it is priced, for the hooks before validate. */
type HookQuote = Readonly<{
  checkoutId: string;
  kind: "pickup" | "shipping";
  quotedAt: string;
  currency: string;
  lines: readonly QuoteLine[];
  variants: CommerceResourcesV1["variants"];
}>;

type HookStageResult<T> =
  | Readonly<{
      kind: "applied";
      value: T;
      runs: readonly CheckoutPluginRun[];
      failures: readonly PluginFunctionFailure[];
    }>
  | Readonly<{ kind: "refused"; error: CommerceMutationErrorV1 }>;

function hookCheckout(
  quote: HookQuote,
  more: Readonly<{ readyBy?: string; totalMinor?: number }> = {},
): HookInput["checkout"] {
  const subtotalMinor = quote.lines.reduce(
    (sum, line) => sum + line.lineTotal.amountMinor,
    0,
  );
  return {
    ...checkoutValidationInput({
      ...quote,
      readyBy: more.readyBy ?? quote.quotedAt,
      subtotalMinor,
      totalMinor: more.totalMinor ?? subtotalMinor,
    }),
    readyBy: more.readyBy ?? null,
    totalMinor: more.totalMinor ?? null,
  };
}

/**
 * `checkout.lines`: plugins lower the unit price of catalog lines. A price
 * names a line of this checkout, and is not above the line's price; the
 * lowest of the plugins' prices applies.
 */
export function linesHookStage(
  database: CommerceDatabase,
  merchantId: string,
  quote: HookQuote,
): HookStageResult<readonly QuoteLine[]> {
  const result = runCheckoutHook(
    database,
    merchantId,
    "checkout.lines",
    { checkout: hookCheckout(quote) },
    (output) => {
      const prices = parseLinesOutput(output);
      return prices?.every((price) => {
        const line = quote.lines.find(
          (candidate) => candidate.checkoutLineId === price.checkoutLineId,
        );
        return (
          line !== undefined &&
          line.source.kind === "catalog" &&
          line.priceOverride === undefined &&
          price.unitPriceMinor <= line.unitPrice.amountMinor
        );
      })
        ? prices
        : undefined;
    },
  );
  if (result.kind === "refused") return result;
  const lines = quote.lines.map((line) => {
    const lowest = Math.min(
      line.unitPrice.amountMinor,
      ...result.outputs.flatMap(({ output }) =>
        output
          .filter((price) => price.checkoutLineId === line.checkoutLineId)
          .map((price) => price.unitPriceMinor),
      ),
    );
    return lowest === line.unitPrice.amountMinor
      ? line
      : {
          ...line,
          unitPrice: { amountMinor: lowest, currency: quote.currency },
          lineTotal: {
            amountMinor: lowest * line.quantity.amount,
            currency: quote.currency,
          },
        };
  });
  return { ...result, kind: "applied", value: lines };
}

/**
 * `checkout.discount`: plugins take an amount off one line, or off the order
 * split over the lines by what is left of each. No line goes below zero.
 */
export function discountHookStage(
  database: CommerceDatabase,
  merchantId: string,
  quote: HookQuote,
): HookStageResult<
  Readonly<{ lines: readonly QuoteLine[]; discountTotal: number }>
> {
  const result = runCheckoutHook(
    database,
    merchantId,
    "checkout.discount",
    { checkout: hookCheckout(quote) },
    (output) => {
      const discounts = parseDiscountOutput(output);
      return discounts?.every(
        (discount) =>
          discount.checkoutLineId === null ||
          quote.lines.some(
            (line) => line.checkoutLineId === discount.checkoutLineId,
          ),
      )
        ? discounts
        : undefined;
    },
  );
  if (result.kind === "refused") return result;
  const left = quote.lines.map((line) => line.lineTotal.amountMinor);
  const taken = quote.lines.map(() => 0);
  for (const { output } of result.outputs)
    for (const discount of output) {
      if (discount.checkoutLineId !== null) {
        const index = quote.lines.findIndex(
          (line) => line.checkoutLineId === discount.checkoutLineId,
        );
        const amount = Math.min(discount.amountMinor, left[index] ?? 0);
        left[index] = (left[index] ?? 0) - amount;
        taken[index] = (taken[index] ?? 0) + amount;
        continue;
      }
      const shares = splitByWeight(
        Math.min(
          discount.amountMinor,
          left.reduce((sum, amount) => sum + amount, 0),
        ),
        left,
      );
      shares.forEach((share, index) => {
        left[index] = (left[index] ?? 0) - share;
        taken[index] = (taken[index] ?? 0) + share;
      });
    }
  const lines = quote.lines.map((line, index) => {
    const amount = taken[index] ?? 0;
    if (amount === 0) return line;
    return {
      ...line,
      lineTotal: {
        amountMinor: line.lineTotal.amountMinor - amount,
        currency: quote.currency,
      },
      discount: {
        amountMinor: (line.discount?.amountMinor ?? 0) + amount,
        currency: quote.currency,
      },
    };
  });
  return {
    ...result,
    kind: "applied",
    value: {
      lines,
      discountTotal: taken.reduce((sum, amount) => sum + amount, 0),
    },
  };
}

/**
 * `checkout.tenders`: plugins refuse gift cards or store credit for this
 * checkout. A refusal of a tender that the buyer asked for refuses the
 * checkout with the plugin's message.
 */
export function tendersHookStage(
  database: CommerceDatabase,
  merchantId: string,
  quote: HookQuote,
  totalMinor: number,
  request: CheckoutStoredValueRequest | undefined,
): HookStageResult<null> {
  const asked = {
    giftCards: request?.giftCardCodes.length ?? 0,
    storeCredit: request?.storeCredit === true,
  };
  const result = runCheckoutHook(
    database,
    merchantId,
    "checkout.tenders",
    { checkout: hookCheckout(quote, { totalMinor }), tenders: asked },
    parseTendersOutput,
  );
  if (result.kind === "refused") return result;
  for (const { pluginId, output } of result.outputs)
    for (const refusal of output)
      if (
        (refusal.tender === "gift_card" && asked.giftCards > 0) ||
        (refusal.tender === "store_credit" && asked.storeCredit)
      )
        return {
          kind: "refused",
          error: {
            code: "checkout_refused",
            pluginId,
            message: refusal.message,
          },
        };
  return { ...result, kind: "applied", value: null };
}

/** The furthest ahead that a plugin can move a pickup. */
const DELIVERY_AHEAD_LIMIT_MS = 60 * 24 * 60 * 60 * 1_000;

/**
 * `checkout.delivery`: plugins refuse the delivery, or make a pickup ready
 * no earlier than a time. The latest of their times applies; a buyer's own
 * earlier pickup time is refused with the plugin's message.
 */
export function deliveryHookStage(
  database: CommerceDatabase,
  merchantId: string,
  quote: HookQuote,
  totalMinor: number,
  fulfillment:
    | Readonly<{ kind: "pickup"; readyAt: string; chosen: boolean }>
    | Readonly<{
        kind: "shipping";
        serviceCode: string;
        shippingMinor: number;
        latestDeliveryAt: string | null;
      }>,
): HookStageResult<Readonly<{ readyAt: string | null }>> {
  const result = runCheckoutHook(
    database,
    merchantId,
    "checkout.delivery",
    {
      checkout: hookCheckout(quote, {
        totalMinor,
        ...(fulfillment.kind === "pickup"
          ? { readyBy: fulfillment.readyAt }
          : {}),
      }),
      fulfillment,
    },
    (output) => {
      const delivery = parseDeliveryOutput(output);
      return delivery === undefined ||
        (fulfillment.kind === "shipping" &&
          delivery.earliestReadyAt !== null) ||
        (delivery.earliestReadyAt !== null &&
          Date.parse(delivery.earliestReadyAt) >
            Date.parse(quote.quotedAt) + DELIVERY_AHEAD_LIMIT_MS)
        ? undefined
        : delivery;
    },
  );
  if (result.kind === "refused") return result;
  for (const { pluginId, output } of result.outputs) {
    const refusal = output.refusals[0];
    if (refusal !== undefined)
      return {
        kind: "refused",
        error: { code: "checkout_refused", pluginId, message: refusal },
      };
  }
  if (fulfillment.kind === "shipping")
    return { ...result, kind: "applied", value: { readyAt: null } };
  let readyAt = fulfillment.readyAt;
  for (const { pluginId, output } of result.outputs) {
    if (
      output.earliestReadyAt === null ||
      Date.parse(output.earliestReadyAt) <= Date.parse(readyAt)
    )
      continue;
    if (fulfillment.chosen)
      return {
        kind: "refused",
        error: {
          code: "checkout_refused",
          pluginId,
          message:
            output.message ??
            `This order can be ready at ${output.earliestReadyAt} at the earliest.`,
        },
      };
    readyAt = output.earliestReadyAt;
  }
  return { ...result, kind: "applied", value: { readyAt } };
}

// Splits an amount over weights in proportion, with the remainder to the
// largest fractions first, so that the parts add up to the amount.
function splitByWeight(amount: number, weights: readonly number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total === 0 || amount === 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (amount * weight) / total);
  const parts = exact.map(Math.floor);
  let rest = amount - parts.reduce((sum, part) => sum + part, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort(
      (left, right) =>
        right.fraction - left.fraction || left.index - right.index,
    );
  for (const { index } of order) {
    if (rest === 0) break;
    parts[index] = (parts[index] ?? 0) + 1;
    rest -= 1;
  }
  return parts;
}
