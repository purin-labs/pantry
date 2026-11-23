import { compareCodePoints } from "@purin-labs/std";
import type { ArrivalSourceId } from "../../identity.ts";
import type { CompiledScenario } from "../../scenario.ts";
import type { RunState } from "../../state.ts";
import {
  FINANCIER_FLAVOURS,
  FINANCIER_FLAVOUR_PRODUCTS,
  financierFlavourOf,
  type FinancierFlavour,
} from "./financier-flavours.ts";
import { PIE_TYPES, PIE_PRODUCTS, type PieType } from "./pie-products.ts";
import type { BakeryServiceShiftInput } from "./shift-preset.ts";

export type RetailSku = `${FinancierFlavour}-financier` | `${PieType}-pie`;

export const FINANCIER_RETAIL_SKUS = [
  "hazelnut-financier",
  "coffee-financier",
  "matcha-financier",
  "black-sesame-financier",
] as const satisfies readonly `${FinancierFlavour}-financier`[];

export const PIE_RETAIL_SKUS = [
  "steak-and-pepper-pie",
  "beef-bourguignon-pie",
] as const satisfies readonly `${PieType}-pie`[];

export const ALL_RETAIL_SKUS = [
  ...FINANCIER_RETAIL_SKUS,
  ...PIE_RETAIL_SKUS,
] as const satisfies readonly RetailSku[];

export type RetailStockBySku = Readonly<Record<RetailSku, number>>;
export type FinancierStockBySku = Readonly<
  Record<`${FinancierFlavour}-financier`, number>
>;

export type RetailOrder = Readonly<{
  id: string;
  atSeconds: number;
  sku: RetailSku;
  units: number;
}>;
export type RetailSupply = Readonly<{
  eventIndex: number;
  task: string;
  atSeconds: number;
  sku: RetailSku;
  units: number;
}>;
export type RetailReceipt = Readonly<{
  order: RetailOrder;
  stockBefore: number;
  fulfilledUnits: number;
  stockedOutUnits: number;
  stockAfter: number;
  revenueJpy: number;
}>;
export type ShiftInventory = Readonly<{
  throughSeconds: number;
  openingStock: RetailStockBySku;
  stockBySku: RetailStockBySku;
  supply: readonly RetailSupply[];
  receipts: readonly RetailReceipt[];
  pendingOrders: readonly RetailOrder[];
  openingUnits: number;
  producedUnits: number;
  soldUnits: number;
  stockedOutUnits: number;
  remainingUnits: number;
  revenueJpy: number;
}>;
export type ReplenishmentWaveDecision = Readonly<{
  waveIndex: number;
  waveArrivalSeconds: number;
  checkAtSeconds: number;
  reorderThresholdUnits: number;
  stockByFinancierSku: FinancierStockBySku;
  flavoursBelowThreshold: readonly FinancierFlavour[];
  action: "dispatch-wave" | "suppress-wave";
  closedSources: readonly ArrivalSourceId[];
}>;

function skuOfOutput(task: string, destination: string): RetailSku | null {
  if (destination === "packed-pieces") {
    const flavour = financierFlavourOf(task);
    return flavour === null ? null : `${flavour}-financier`;
  }
  for (const pie of PIE_TYPES)
    if (destination === `packed-${pie}-pies`) return `${pie}-pie`;
  return null;
}

function price(sku: RetailSku): number {
  for (const flavour of FINANCIER_FLAVOURS)
    if (sku === `${flavour}-financier`)
      return FINANCIER_FLAVOUR_PRODUCTS[flavour].unitPriceJpy;
  for (const pie of PIE_TYPES)
    if (sku === `${pie}-pie`) return PIE_PRODUCTS[pie].unitPriceJpy;
  throw new Error(`Unknown retail SKU: ${sku}`);
}

function compareSupply(left: RetailSupply, right: RetailSupply): number {
  return left.atSeconds - right.atSeconds || left.eventIndex - right.eventIndex;
}

function compareOrders(left: RetailOrder, right: RetailOrder): number {
  return (
    left.atSeconds - right.atSeconds || compareCodePoints(left.id, right.id)
  );
}

function normalizeRetailStock(
  raw: Partial<Record<RetailSku, number>>,
): RetailStockBySku {
  const out = {} as Record<RetailSku, number>;
  for (const sku of ALL_RETAIL_SKUS) {
    const units = raw[sku] ?? 0;
    out[sku] = Number.isFinite(units) && units > 0 ? Math.trunc(units) : 0;
  }
  return out;
}

/** Only accepted packing receipts put saleable units on the shelf. Drinks
 * remain made-to-order workflows in the engine's production report. */
export function reportShiftInventory(
  run: RunState,
  orders: readonly RetailOrder[],
  openingStockInput: Partial<Record<RetailSku, number>> = {},
): ShiftInventory {
  const openingStock = normalizeRetailStock(openingStockInput);
  const supply: RetailSupply[] = [];
  for (const [eventIndex, event] of run.events.entries()) {
    if (event.kind !== "quantity-reported" || event.role !== "final-output")
      continue;
    const sku = skuOfOutput(event.task, event.destination);
    if (sku === null) continue;
    supply.push({
      eventIndex,
      task: event.task,
      atSeconds: event.time / 1e6,
      sku,
      units: event.quantity.amount,
    });
  }
  supply.sort(compareSupply);
  const stock = new Map<RetailSku, number>();
  let openingUnits = 0;
  for (const sku of ALL_RETAIL_SKUS) {
    const initial = openingStock[sku];
    stock.set(sku, initial);
    openingUnits += initial;
  }
  const receipts: RetailReceipt[] = [];
  const pendingOrders: RetailOrder[] = [];
  let nextSupply = 0;
  let producedUnits = 0;
  let soldUnits = 0;
  let stockedOutUnits = 0;
  let revenueJpy = 0;
  const throughSeconds = run.position.time / 1e6;
  for (const order of [...orders].sort(compareOrders)) {
    if (order.atSeconds > throughSeconds) {
      pendingOrders.push(order);
      continue;
    }
    while (nextSupply < supply.length) {
      const receipt = supply[nextSupply];
      if (receipt === undefined || receipt.atSeconds > order.atSeconds) break;
      stock.set(receipt.sku, (stock.get(receipt.sku) ?? 0) + receipt.units);
      producedUnits += receipt.units;
      nextSupply++;
    }
    const stockBefore = stock.get(order.sku) ?? 0;
    const fulfilledUnits = Math.min(stockBefore, order.units);
    const shortage = order.units - fulfilledUnits;
    const stockAfter = stockBefore - fulfilledUnits;
    const revenue = fulfilledUnits * price(order.sku);
    stock.set(order.sku, stockAfter);
    soldUnits += fulfilledUnits;
    stockedOutUnits += shortage;
    revenueJpy += revenue;
    receipts.push({
      order,
      stockBefore,
      fulfilledUnits,
      stockedOutUnits: shortage,
      stockAfter,
      revenueJpy: revenue,
    });
  }
  for (; nextSupply < supply.length; nextSupply++) {
    const receipt = supply[nextSupply];
    if (receipt !== undefined && receipt.atSeconds <= throughSeconds) {
      stock.set(receipt.sku, (stock.get(receipt.sku) ?? 0) + receipt.units);
      producedUnits += receipt.units;
    }
  }
  const stockBySku = normalizeRetailStock(
    Object.fromEntries(stock.entries()) as Partial<Record<RetailSku, number>>,
  );
  return {
    throughSeconds,
    openingStock,
    stockBySku,
    supply,
    receipts,
    pendingOrders,
    openingUnits,
    producedUnits,
    soldUnits,
    stockedOutUnits,
    remainingUnits: openingUnits + producedUnits - soldUnits,
    revenueJpy,
  };
}

/** Ending retail shelf stock by SKU, ready to seed the next shift's opening stock. */
export function carryoverRetailStock(
  inventory: ShiftInventory,
): RetailStockBySku {
  return { ...inventory.stockBySku };
}

/** Arrival sources that dispatch financier preparation and load waves. */
export function financierArrivalSources(
  scenario: CompiledScenario,
): readonly ArrivalSourceId[] {
  const sources: ArrivalSourceId[] = [];
  for (const source of scenario.arrivals) {
    if (
      FINANCIER_FLAVOURS.some(
        (flavour) =>
          source.id === `${flavour}-preparation-batches` ||
          source.workflow.startsWith(`load-${flavour}-`),
      )
    ) {
      sources.push(source.id);
    }
  }
  return sources;
}

/** Scheduled arrival times (in seconds) of replenishment financier waves (`wave >= 1`). */
export function financierReplenishmentWaveTimesSeconds(
  input: BakeryServiceShiftInput,
): readonly number[] {
  const times: number[] = [];
  for (let wave = 1; wave < input.financierWaves; wave++) {
    times.push(600 + wave * input.waveIntervalMinutes * 60);
  }
  return times;
}

/**
 * Evaluates live shelf stock at a replenishment wave boundary. When any
 * financier flavour is below `reorderThresholdUnits`, the wave dispatches;
 * when every financier flavour meets or exceeds the threshold, the controller
 * returns the financier arrival sources to close via `close-arrivals`.
 */
export function evaluateFinancierReplenishmentWave(
  run: RunState,
  orders: readonly RetailOrder[],
  options: Readonly<{
    waveIndex: number;
    waveArrivalSeconds: number;
    reorderThresholdUnits: number;
    openingStock?: Partial<Record<RetailSku, number>>;
  }>,
): ReplenishmentWaveDecision {
  const inventory = reportShiftInventory(run, orders, options.openingStock);
  const stockByFinancierSku: FinancierStockBySku = {
    "hazelnut-financier": inventory.stockBySku["hazelnut-financier"],
    "coffee-financier": inventory.stockBySku["coffee-financier"],
    "matcha-financier": inventory.stockBySku["matcha-financier"],
    "black-sesame-financier": inventory.stockBySku["black-sesame-financier"],
  };
  const flavoursBelowThreshold = FINANCIER_FLAVOURS.filter(
    (flavour) =>
      stockByFinancierSku[`${flavour}-financier`] <
      options.reorderThresholdUnits,
  );
  const action =
    flavoursBelowThreshold.length > 0 ? "dispatch-wave" : "suppress-wave";
  const closedSources =
    action === "suppress-wave"
      ? financierArrivalSources(run.definition.scenario)
      : [];
  return {
    waveIndex: options.waveIndex,
    waveArrivalSeconds: options.waveArrivalSeconds,
    checkAtSeconds: inventory.throughSeconds,
    reorderThresholdUnits: options.reorderThresholdUnits,
    stockByFinancierSku,
    flavoursBelowThreshold,
    action,
    closedSources,
  };
}
