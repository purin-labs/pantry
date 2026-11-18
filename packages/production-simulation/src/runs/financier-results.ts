import type {
  Blocker,
  CapacityCategories,
  CompiledScenario,
  HostView,
} from "../index.ts";
import type { RecurringFinancierInput } from "../recipes/bakery/recurring-financier.ts";
import { canonicalJson, isRecord } from "@seams/std";
import type { Variant } from "@seams/type-utils";

/** Read-only results of one completed recurring financier shift. */
export type FinancierResult = Readonly<{
  /** The scenario and engine. The engine is deterministic, so equal identities give equal results. */
  identity: string;
  bundle: string;
  input: RecurringFinancierInput;
  endSeconds: number;
  packedPieces: number;
  piecesPerHour: number;
  meanBatchMinutes: number;
  longestBatchMinutes: number;
  longestQueue: Readonly<{ place: string; waiting: number }> | null;
  bakerUse: number;
  ovenBakingSeconds: number;
  ovenBlockedSeconds: number;
  ovenIdleSeconds: number;
}>;

export function financierInput(
  scenario: CompiledScenario,
): RecurringFinancierInput | null {
  if (scenario.id !== "recurring-financier") return null;
  let interval: number | null = null;
  for (const arrival of scenario.arrivals)
    if (arrival.id === "financier-batches" && arrival.kind === "periodic")
      interval = arrival.interval;
  let cooling: number | null = null;
  for (const storage of scenario.storages)
    if (storage.id === "loaded-grids" && storage.capacity.kind === "carriers")
      cooling = storage.capacity.slots;
  if (interval === null || cooling === null) return null;
  let workers = 0;
  for (const resource of scenario.resources)
    if (resource.kind === "worker") workers += 1;
  let trays = 0;
  for (const carrier of scenario.carriers)
    if (carrier.id.startsWith("tray-")) trays += 1;
  return {
    arrivalMinutes: interval / 60e6,
    workers,
    trays,
    coolingPositions: cooling,
  };
}

/** Only a completed shift with complete histories enters a comparison. */
export function financierResult(
  scenario: CompiledScenario,
  bundle: string,
  view: HostView,
): FinancierResult | null {
  const input = financierInput(scenario);
  if (input === null || view.status.kind !== "completed") return null;
  if (
    view.resourceHistory.kind !== "available" ||
    view.schedulingHistory.kind !== "available" ||
    view.production.kind !== "available" ||
    view.resourceHistory.after !== 0 ||
    view.resourceHistory.through !== view.time ||
    view.schedulingHistory.after !== 0 ||
    view.schedulingHistory.through !== view.time
  )
    return null;
  let packed = 0;
  for (const total of view.totals)
    if (total.destination === "packed-pieces") packed = total.amount;
  let count = 0;
  let total = 0;
  let longest = 0;
  for (const order of view.production.orders) {
    if (order.kind !== "completed") return null;
    count += 1;
    total += order.leadTime;
    longest = Math.max(longest, order.leadTime);
  }
  let occupied = 0;
  let capacity = 0;
  for (const resource of view.resourceHistory.resources)
    if (resource.resource.startsWith("baker-")) {
      occupied += resource.occupiedUnitSeconds;
      capacity += resource.capacityUnitSeconds;
    }
  let oven: CapacityCategories | null = null;
  for (const resource of view.schedulingHistory.resources)
    if (resource.resource === "oven") oven = resource.unitSeconds;
  if (oven === null || count === 0 || capacity === 0) return null;
  const hours = view.time / 3600e6;
  return {
    identity: canonicalJson({ bundle, scenario: scenario.sources }),
    bundle,
    input,
    endSeconds: view.time / 1e6,
    packedPieces: packed,
    piecesPerHour: Math.round((packed / hours) * 10) / 10,
    meanBatchMinutes: Math.round(total / count / 6e6) / 10,
    longestBatchMinutes: Math.round(longest / 6e6) / 10,
    longestQueue: longestQueue(view.schedulingHistory.waits),
    bakerUse: Math.round((occupied / capacity) * 100) / 100,
    ovenBakingSeconds: oven.running,
    ovenBlockedSeconds: oven.blocked,
    ovenIdleSeconds: oven.idle,
  };
}

/**
 * The most tasks that waited at once for one store or piece of equipment.
 * Waits for a baker, material or an earlier step are not physical queues.
 */
function longestQueue(
  waits: Variant<HostView["schedulingHistory"], "available">["waits"],
): FinancierResult["longestQueue"] {
  const edges = new Map<string, [number, number][]>();
  for (const wait of waits) {
    const places = new Set<string>();
    for (const blocker of wait.blockers) {
      const place = queuePlace(blocker);
      if (place !== null) places.add(place);
    }
    for (const place of places) {
      const list = edges.get(place) ?? [];
      list.push([wait.start, 1], [wait.end, -1]);
      edges.set(place, list);
    }
  }
  let best: FinancierResult["longestQueue"] = null;
  for (const [place, list] of [...edges].sort(byPlace)) {
    list.sort(byTime);
    let waiting = 0;
    let most = 0;
    for (const [, change] of list) {
      waiting += change;
      most = Math.max(most, waiting);
    }
    if (best === null || most > best.waiting) best = { place, waiting: most };
  }
  return best;
}
// An end sorts before a start at the same time: back-to-back waits do not overlap.
function byTime(left: [number, number], right: [number, number]): number {
  return left[0] - right[0] || left[1] - right[1];
}
function byPlace(left: [string, unknown], right: [string, unknown]): number {
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}
function queuePlace(blocker: Blocker): string | null {
  switch (blocker.kind) {
    case "destination":
      return blocker.storage;
    case "carrier":
      return blocker.store;
    case "resource":
    case "batch-cycle":
    case "configuration":
      return blocker.resource;
    default:
      return null;
  }
}

/** Results that share demand. Only these answer "which change helps?" */
export function sameDemand(
  left: FinancierResult,
  right: FinancierResult,
): boolean {
  return (
    left.bundle === right.bundle &&
    left.input.arrivalMinutes === right.input.arrivalMinutes
  );
}

export function sameResult(
  left: FinancierResult,
  right: FinancierResult,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

const COMPARISON_KIND = "financier-comparison";

export function comparisonFile(results: readonly FinancierResult[]): string {
  return JSON.stringify(
    { kind: COMPARISON_KIND, version: 1, results },
    null,
    2,
  );
}

/** A comparison file keeps the inputs and results of each kept scenario. */
export function readComparisonFile(raw: unknown): FinancierResult[] | null {
  if (
    !isRecord(raw) ||
    raw.kind !== COMPARISON_KIND ||
    raw.version !== 1 ||
    !Array.isArray(raw.results)
  )
    return null;
  const results: FinancierResult[] = [];
  for (const entry of raw.results) {
    const result = readResult(entry);
    if (result === null) return null;
    results.push(result);
  }
  return results;
}
class InvalidResult extends Error {}
function readResult(raw: unknown): FinancierResult | null {
  try {
    if (!isRecord(raw) || !isRecord(raw.input)) throw new InvalidResult();
    const queue = raw.longestQueue;
    if (queue !== null && !isRecord(queue)) throw new InvalidResult();
    return {
      identity: text(raw.identity),
      bundle: text(raw.bundle),
      input: {
        arrivalMinutes: count(raw.input.arrivalMinutes),
        workers: count(raw.input.workers),
        trays: count(raw.input.trays),
        coolingPositions: count(raw.input.coolingPositions),
      },
      endSeconds: measure(raw.endSeconds),
      packedPieces: count(raw.packedPieces),
      piecesPerHour: measure(raw.piecesPerHour),
      meanBatchMinutes: measure(raw.meanBatchMinutes),
      longestBatchMinutes: measure(raw.longestBatchMinutes),
      longestQueue:
        queue === null
          ? null
          : { place: text(queue.place), waiting: count(queue.waiting) },
      bakerUse: measure(raw.bakerUse),
      ovenBakingSeconds: measure(raw.ovenBakingSeconds),
      ovenBlockedSeconds: measure(raw.ovenBlockedSeconds),
      ovenIdleSeconds: measure(raw.ovenIdleSeconds),
    };
  } catch (error) {
    if (error instanceof InvalidResult) return null;
    throw error;
  }
}
function text(raw: unknown): string {
  if (typeof raw !== "string") throw new InvalidResult();
  return raw;
}
function count(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0)
    throw new InvalidResult();
  return raw;
}
function measure(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)
    throw new InvalidResult();
  return raw;
}
