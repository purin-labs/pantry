import { controlRead } from "../../control-client";
import {
  type CounterSale,
  parseEnvelope,
  requireExactKeys,
  requireObject,
} from "@seams/control-api/portal/counter-sale";

export type CounterSaleMutationTransport = (
  path: string,
  method: "POST",
  body: unknown,
  intent: string,
) => Promise<unknown>;

export type CounterSaleReadTransport = (path: string) => Promise<unknown>;

export async function readCounterSale(
  organisationId: string,
  checkoutId: string,
  read: CounterSaleReadTransport = controlRead,
): Promise<CounterSale> {
  const raw = await read(
    `${counterSalesPath(organisationId)}/${encodeURIComponent(checkoutId)}`,
  );
  return parseEnvelope(raw);
}

/**
 * Present the sale on the terminal.
 *
 * The platform refuses when the sale is not collectable, and that refusal
 * carries the sale's state so the till can show why rather than only that it
 * failed. It is surfaced, never retried.
 */
export async function collectCounterSale(
  organisationId: string,
  sale: CounterSale,
  amount: Readonly<{ amountMinor: number; currency: string }>,
  mutate: CounterSaleMutationTransport,
): Promise<void> {
  if (sale.quote === null)
    throw new Error("This sale has no quote to collect.");
  const raw = await mutate(
    `${counterSalesPath(organisationId)}/${encodeURIComponent(sale.checkoutId)}/collection`,
    "POST",
    {
      satyrLocationId: sale.satyrLocationId,
      checkoutRevision: sale.quote.checkoutRevision,
      quoteDigest: sale.quote.quoteDigest,
      amount,
    },
    // The intent binds the collection to this exact quote: a re-presented sale
    // whose quote has moved is a different attempt, not a retry of this one.
    `counter-collect:${sale.checkoutId}:${sale.quote.quoteDigest}`,
  );
  const envelope = requireObject(raw, "counter sale collection response");
  if (envelope.ok !== true) {
    throw new Error("Square Terminal could not present this payment.");
  }
  const collection = requireObject(
    envelope.collection,
    "counter sale collection",
  );
  if (collection.outcome !== "ready") {
    throw new Error("Square Terminal could not present this payment.");
  }
}

export async function reconcileCounterSale(
  organisationId: string,
  checkoutId: string,
  mutate: CounterSaleMutationTransport,
): Promise<CounterSale> {
  const raw = await mutate(
    `${counterSalesPath(organisationId)}/${encodeURIComponent(checkoutId)}/reconciliation`,
    "POST",
    {},
    `counter-reconcile:${checkoutId}:${crypto.randomUUID()}`,
  );
  return parseEnvelope(raw);
}

export function markCounterSalePickupReady(
  organisationId: string,
  checkoutId: string,
  mutate: CounterSaleMutationTransport,
): Promise<CounterSale> {
  return mutateCounterSaleAfterSale(
    organisationId,
    checkoutId,
    "ready",
    mutate,
  );
}

export function handOverCounterSale(
  organisationId: string,
  checkoutId: string,
  mutate: CounterSaleMutationTransport,
): Promise<CounterSale> {
  return mutateCounterSaleAfterSale(
    organisationId,
    checkoutId,
    "handover",
    mutate,
  );
}

export function refundCounterSale(
  organisationId: string,
  checkoutId: string,
  mutate: CounterSaleMutationTransport,
): Promise<CounterSale> {
  return mutateCounterSaleAfterSale(
    organisationId,
    checkoutId,
    "refund",
    mutate,
  );
}

export async function mutateCounterSaleAfterSale(
  organisationId: string,
  checkoutId: string,
  action: "ready" | "handover" | "refund",
  mutate: CounterSaleMutationTransport,
): Promise<CounterSale> {
  const raw = await mutate(
    `${counterSalesPath(organisationId)}/${encodeURIComponent(checkoutId)}/${action}`,
    "POST",
    {},
    `counter-${action}:${checkoutId}`,
  );
  return parseEnvelope(raw);
}

export async function openCounterSale(
  organisationId: string,
  request: Readonly<{
    satyrLocationId: string;
    lines: readonly Readonly<{ variantId: string; quantity: number }>[];
  }>,
  mutate: CounterSaleMutationTransport,
  read: CounterSaleReadTransport = controlRead,
): Promise<CounterSale> {
  const checkoutId = `checkout_counter_${crypto.randomUUID()}`;
  const lines = buildCounterSaleLines(request.lines);
  const raw = await mutate(
    counterSalesPath(organisationId),
    "POST",
    {
      satyrLocationId: request.satyrLocationId,
      checkoutId,
      lines,
    },
    `counter-open:${checkoutId}`,
  );
  const envelope = requireObject(raw, "counter sale open response");
  requireExactKeys(
    envelope,
    ["ok", "counterSale"],
    "counter sale open response",
  );
  const result = requireObject(
    envelope.counterSale,
    "counter sale open result",
  );
  if (envelope.ok !== true || result.outcome !== "applied") {
    throw new Error("The counter sale could not be opened.");
  }
  return readCounterSale(organisationId, checkoutId, read);
}

export type CounterSaleOpenLine = Readonly<{
  cartLineId: string;
  checkoutLineId: string;
  source: Readonly<{ kind: "catalog"; variantId: string }>;
  quantity: Readonly<{ amount: number; scale: 0; unit: "each" }>;
}>;

export function buildCounterSaleLines(
  selections: readonly Readonly<{ variantId: string; quantity: number }>[],
): readonly CounterSaleOpenLine[] {
  const lines: CounterSaleOpenLine[] = [];
  for (const selection of selections) {
    const lineId = `line_${crypto.randomUUID()}`;
    lines.push({
      cartLineId: `cart_${lineId}`,
      checkoutLineId: lineId,
      source: { kind: "catalog", variantId: selection.variantId },
      quantity: { amount: selection.quantity, scale: 0, unit: "each" },
    });
  }
  return lines;
}

/** What the till may offer for a sale in this state. */
export function counterSaleGuidance(sale: CounterSale): string {
  if (sale.afterSale?.refundState === "completed") {
    return "The full payment was refunded.";
  }
  if (sale.afterSale?.refundState === "pending") {
    return "The refund is processing. Reconcile this refund to check its outcome.";
  }
  if (sale.afterSale?.refundState === "failed") {
    return "The refund failed. Review the payment record.";
  }
  switch (sale.state) {
    case "awaiting_collection":
      return "Ready to take payment.";
    case "collecting":
      return "The terminal is waiting for the card. Do not start another payment.";
    case "submission_unknown":
      return (
        "Seams Checkout does not yet know whether this payment went through. " +
        "Reconcile it before taking payment again."
      );
    case "declined":
      return "The card was declined. You can try again.";
    case "captured_unplaced":
      return (
        "The customer has paid, but the order is not placed yet. " +
        "Complete or refund it — do not take payment again."
      );
    case "complete":
      return "Paid and placed.";
    case "expired":
      return "This sale expired before it was paid. Ring it up again.";
  }
}

export function counterSalesPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/counter-sales`;
}
