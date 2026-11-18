export type CheckoutLineAllocationInput = Readonly<{
  checkoutLineId: string;
  weightMinor: number;
}>;

type JpyCheckoutLineAllocation = Readonly<{
  checkoutLineId: string;
  amount: Readonly<{ amountMinor: number; currency: "JPY" }>;
}>;

export function allocateJpyAcrossCheckoutLines(
  totalAmountMinor: number,
  lines: readonly CheckoutLineAllocationInput[],
): JpyCheckoutLineAllocation[] {
  requireAllocationInput(totalAmountMinor, lines);
  const totalWeight = lines.reduce(sumAllocationWeight, 0);
  return totalWeight === 0
    ? allocateEvenly(totalAmountMinor, lines)
    : allocateProportionally(totalAmountMinor, totalWeight, lines);
}

function requireAllocationInput(
  totalAmountMinor: number,
  lines: readonly CheckoutLineAllocationInput[],
): void {
  if (
    !Number.isSafeInteger(totalAmountMinor) ||
    totalAmountMinor < 0 ||
    lines.length === 0
  ) {
    throw new Error(
      "Checkout line allocation requires a non-negative total and at least one line",
    );
  }
  const lineIds = new Set<string>();
  for (const line of lines) {
    if (
      line.checkoutLineId.length === 0 ||
      line.checkoutLineId !== line.checkoutLineId.trim() ||
      lineIds.has(line.checkoutLineId) ||
      !Number.isSafeInteger(line.weightMinor) ||
      line.weightMinor < 0
    ) {
      throw new Error("Checkout line allocation input is invalid");
    }
    lineIds.add(line.checkoutLineId);
  }
}

function sumAllocationWeight(
  total: number,
  line: CheckoutLineAllocationInput,
): number {
  const next = total + line.weightMinor;
  if (!Number.isSafeInteger(next))
    throw new Error("Checkout line allocation weight is too large");
  return next;
}

function allocateProportionally(
  totalAmountMinor: number,
  totalWeight: number,
  lines: readonly CheckoutLineAllocationInput[],
): JpyCheckoutLineAllocation[] {
  const allocations: JpyCheckoutLineAllocation[] = [];
  let assigned = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined)
      throw new Error("Checkout allocation line disappeared");
    const amountMinor =
      index === lines.length - 1
        ? totalAmountMinor - assigned
        : Number(
            (BigInt(totalAmountMinor) * BigInt(line.weightMinor)) /
              BigInt(totalWeight),
          );
    assigned += amountMinor;
    allocations.push(toAllocation(line.checkoutLineId, amountMinor));
  }
  return allocations;
}

function allocateEvenly(
  totalAmountMinor: number,
  lines: readonly CheckoutLineAllocationInput[],
): JpyCheckoutLineAllocation[] {
  const quotient = Math.floor(totalAmountMinor / lines.length);
  const remainder = totalAmountMinor % lines.length;
  return lines.map(toEvenAllocation.bind(undefined, quotient, remainder));
}

function toEvenAllocation(
  quotient: number,
  remainder: number,
  line: CheckoutLineAllocationInput,
  index: number,
): JpyCheckoutLineAllocation {
  return toAllocation(
    line.checkoutLineId,
    quotient + (index < remainder ? 1 : 0),
  );
}

function toAllocation(
  checkoutLineId: string,
  amountMinor: number,
): JpyCheckoutLineAllocation {
  return { checkoutLineId, amount: { amountMinor, currency: "JPY" } };
}
