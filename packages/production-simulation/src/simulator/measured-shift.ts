import {
  fields,
  parseSettings,
  type Operation,
  type Settings,
  type SettingsField,
} from "@seams/bakery-model/bakery";
import type { Variant } from "@seams/type-utils";
import { isRecord } from "@seams/std";

const phases = [
  "stage",
  "portion",
  "load",
  "bake",
  "unload",
  "cool",
  "demould",
  "finishCooling",
  "pack",
] as const;

export const measuredSettingFields: readonly SettingsField[] = [
  "batchCount",
  "workerCount",
  "ovenTrays",
  "rackTrays",
  "traysPerBatch",
  "piecesPerTray",
  "stage",
  "portion",
  "loadSeconds",
  "bake",
  "unloadSeconds",
  "cool",
  "demould",
  "finishCooling",
  "pack",
  "horizonMinutes",
];

type Phase = (typeof phases)[number];
type MeasuredPhaseField = Operation | "loadSeconds" | "unloadSeconds";
const validated: unique symbol = Symbol("validated measured bakery shift");
type ObservedInterval = Readonly<{ start: number; end: number }>;
type MeasuredBatch = Readonly<{
  id: string;
  trayCount: number;
  intervals: Readonly<Record<Phase, ObservedInterval>>;
}>;

export type MeasuredShift = Readonly<{
  [validated]: true;
  shiftId: string;
  site: string;
  startTime: string;
  measurementMethod: string;
  evidenceRef: string;
  ovenId: string;
  mouldId: string;
  recipeRevision: string;
  emptyTrayMassKg: number;
  filledTrayMassKg: number;
  portionMassGrams: number;
  workerIds: readonly string[];
  ovenTrays: number;
  rackTrays: number;
  piecesPerTray: number;
  batches: readonly [MeasuredBatch, ...MeasuredBatch[]];
}>;

export type MeasuredShiftImport =
  | Readonly<{ kind: "valid"; shift: MeasuredShift; message?: never }>
  | Readonly<{ kind: "invalid"; message: string; shift?: never }>;

export type MeasuredValue = Readonly<{
  field: MeasuredPhaseField;
  observedSeconds: number;
  minimumSeconds: number;
  maximumSeconds: number;
  recommended: number;
}>;

export type MeasuredShiftRecommendation =
  | Readonly<{
      kind: "valid";
      settings: Settings;
      values: readonly MeasuredValue[];
      message?: never;
    }>
  | Readonly<{
      kind: "unsupported";
      message: string;
      values: readonly MeasuredValue[];
      settings?: never;
    }>;

export function parseMeasuredShift(text: string): MeasuredShiftImport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalid("Choose a measured-shift JSON file.");
  }
  if (
    !isRecord(raw) ||
    raw.kind !== "bakery-measured-shift" ||
    raw.schemaVersion !== 2
  )
    return invalid(
      "Use a version 2 measured shift with separate in-mould and post-demould cooling observations. Download the current template; do not invent missing timestamps.",
    );
  const shiftId = measuredText(raw.shiftId, "shiftId");
  const site = measuredText(raw.site, "site");
  const measurementMethod = measuredText(
    raw.measurementMethod,
    "measurementMethod",
  );
  const evidenceRef = measuredText(raw.evidenceRef, "evidenceRef");
  const ovenId = measuredText(raw.ovenId, "ovenId");
  const mouldId = measuredText(raw.mouldId, "mouldId");
  const recipeRevision = measuredText(raw.recipeRevision, "recipeRevision");
  const missing = [
    shiftId,
    site,
    measurementMethod,
    evidenceRef,
    ovenId,
    mouldId,
    recipeRevision,
  ].find(isMissingText);
  if (missing !== undefined) return invalid(missing.message);
  if (
    typeof raw.startTime !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
      raw.startTime,
    ) ||
    !Number.isFinite(Date.parse(raw.startTime))
  )
    return invalid("Use an ISO shift start time with a timezone offset.");
  if (
    shiftId.kind !== "valid" ||
    site.kind !== "valid" ||
    measurementMethod.kind !== "valid" ||
    evidenceRef.kind !== "valid" ||
    ovenId.kind !== "valid" ||
    mouldId.kind !== "valid" ||
    recipeRevision.kind !== "valid" ||
    !nonnegativeNumber(raw.emptyTrayMassKg) ||
    !positiveNumber(raw.filledTrayMassKg) ||
    !positiveNumber(raw.portionMassGrams) ||
    raw.filledTrayMassKg <= raw.emptyTrayMassKg ||
    !boundedInteger(raw.ovenTrays, 1, 4) ||
    !boundedInteger(raw.rackTrays, 1, 16) ||
    !boundedInteger(raw.piecesPerTray, 1, 96) ||
    !Array.isArray(raw.workerIds) ||
    raw.workerIds.length < 1 ||
    raw.workerIds.length > 3 ||
    !raw.workerIds.every(isWorkerId) ||
    new Set(raw.workerIds).size !== raw.workerIds.length
  )
    return invalid(
      "Check empty/filled tray mass, portion mass, capacities, pieces and distinct workers.",
    );
  if (
    !Array.isArray(raw.batches) ||
    raw.batches.length < 1 ||
    raw.batches.length > 6
  )
    return invalid("Record between one and six measured batches.");

  const batches: MeasuredBatch[] = [];
  for (const [index, item] of raw.batches.entries()) {
    const batch = parseBatch(item, String.fromCharCode(65 + index));
    if (batch.kind === "invalid") return batch;
    batches.push(batch.batch);
  }
  const [first, ...rest] = batches;
  if (first === undefined)
    return invalid("Record between one and six measured batches.");
  const trayCount = first.trayCount;
  if (batches.some(differentTrayCount.bind(null, trayCount)))
    return invalid(
      "Use the same tray count for every batch in this bounded model.",
    );
  const capacity = measuredCapacityCheck(
    batches,
    raw.workerIds.length,
    raw.ovenTrays,
    raw.rackTrays,
  );
  if (capacity !== null) return invalid(capacity);

  return {
    kind: "valid",
    shift: {
      [validated]: true,
      shiftId: shiftId.value,
      site: site.value,
      startTime: raw.startTime,
      measurementMethod: measurementMethod.value,
      evidenceRef: evidenceRef.value,
      ovenId: ovenId.value,
      mouldId: mouldId.value,
      recipeRevision: recipeRevision.value,
      emptyTrayMassKg: raw.emptyTrayMassKg,
      filledTrayMassKg: raw.filledTrayMassKg,
      portionMassGrams: raw.portionMassGrams,
      workerIds: Object.freeze([...raw.workerIds]),
      ovenTrays: raw.ovenTrays,
      rackTrays: raw.rackTrays,
      piecesPerTray: raw.piecesPerTray,
      batches: Object.freeze([first, ...rest] as const),
    },
  };
}

function parseBatch(
  value: unknown,
  expectedId: string,
):
  | Readonly<{ kind: "valid"; batch: MeasuredBatch }>
  | Readonly<{ kind: "invalid"; message: string }> {
  if (
    !isRecord(value) ||
    value.id !== expectedId ||
    !boundedInteger(value.trayCount, 1, 4) ||
    !isRecord(value.intervals)
  )
    return invalid(
      `Record batch ${expectedId} with its tray count and intervals.`,
    );
  const intervals: Partial<Record<Phase, ObservedInterval>> = {};
  let previousEnd = 0;
  for (const phase of phases) {
    const interval = value.intervals[phase];
    if (
      !isRecord(interval) ||
      !boundedInteger(interval.start, 0, 43_200) ||
      !boundedInteger(interval.end, 1, 43_200) ||
      interval.start < previousEnd ||
      interval.end <= interval.start
    )
      return invalid(
        `Batch ${expectedId}: check ${phase} start/end seconds and phase order.`,
      );
    intervals[phase] = { start: interval.start, end: interval.end };
    previousEnd = interval.end;
  }
  const {
    stage,
    portion,
    load,
    bake,
    unload,
    cool,
    demould,
    finishCooling,
    pack,
  } = intervals;
  if (
    stage === undefined ||
    portion === undefined ||
    load === undefined ||
    bake === undefined ||
    unload === undefined ||
    cool === undefined ||
    demould === undefined ||
    finishCooling === undefined ||
    pack === undefined
  )
    return invalid(`Batch ${expectedId}: record every phase.`);
  return {
    kind: "valid",
    batch: {
      id: expectedId,
      trayCount: value.trayCount,
      intervals: {
        stage,
        portion,
        load,
        bake,
        unload,
        cool,
        demould,
        finishCooling,
        pack,
      },
    },
  };
}

export function recommendMeasuredSettings(
  current: Settings,
  shift: MeasuredShift,
): MeasuredShiftRecommendation {
  const raw: Record<string, number> = {};
  for (const field of fields) raw[field.key] = current[field.key];
  raw.batchCount = shift.batches.length;
  raw.workerCount = shift.workerIds.length;
  raw.ovenTrays = shift.ovenTrays;
  raw.rackTrays = shift.rackTrays;
  raw.traysPerBatch = shift.batches[0].trayCount;
  raw.piecesPerTray = shift.piecesPerTray;
  raw.horizonMinutes = Math.max(
    current.horizonMinutes,
    Math.ceil(Math.max(...shift.batches.map(packEnd)) / 60),
  );

  const values: MeasuredValue[] = [];
  for (const phase of phases) {
    const durations = observedDurations(phase, shift.batches);
    durations.sort(ascending);
    const observedSeconds = median(durations);
    const field = measurementField(phase);
    const recommended =
      phase === "load" || phase === "unload"
        ? Math.round(observedSeconds)
        : Math.max(1, Math.round(observedSeconds / 60));
    raw[field] = recommended;
    values.push({
      field,
      observedSeconds,
      minimumSeconds: durations[0] ?? observedSeconds,
      maximumSeconds: durations.at(-1) ?? observedSeconds,
      recommended,
    });
  }
  const parsed = parseSettings(raw);
  if (parsed.kind === "invalid")
    return {
      kind: "unsupported",
      values,
      message: `These observations exceed the current model: ${parsed.field} — ${parsed.message}`,
    };
  return { kind: "valid", settings: parsed.settings, values };
}

function measurementField(phase: Phase): MeasuredPhaseField {
  switch (phase) {
    case "load":
      return "loadSeconds";
    case "unload":
      return "unloadSeconds";
    case "stage":
    case "portion":
    case "bake":
    case "cool":
    case "demould":
    case "finishCooling":
    case "pack":
      return phase satisfies Operation;
  }
}

function observedDurations(
  phase: Phase,
  batches: readonly MeasuredBatch[],
): number[] {
  const durations: number[] = [];
  const seenBakeIntervals = new Set<string>();
  for (const batch of batches) {
    const interval = batch.intervals[phase];
    if (phase === "bake") {
      const key = `${interval.start}:${interval.end}`;
      if (seenBakeIntervals.has(key)) continue;
      seenBakeIntervals.add(key);
    }
    durations.push(interval.end - interval.start);
  }
  return durations;
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) throw new RangeError("median of no values");
  const lower = sorted[middle - 1];
  return sorted.length % 2 === 0 && lower !== undefined
    ? (lower + upper) / 2
    : upper;
}

function ascending(left: number, right: number): number {
  return left - right;
}

function differentTrayCount(count: number, batch: MeasuredBatch): boolean {
  return batch.trayCount !== count;
}

type Occupancy = Readonly<{ start: number; end: number; units: number }>;
type OccupancyEvent = Readonly<{ time: number; change: number }>;

function measuredCapacityCheck(
  batches: readonly MeasuredBatch[],
  workers: number,
  ovenTrays: number,
  rackTrays: number,
): string | null {
  const workerSpans: Occupancy[] = [];
  const ovenSpans: Occupancy[] = [];
  const rackSpans: Occupancy[] = [];
  const attended: readonly Phase[] = [
    "stage",
    "portion",
    "load",
    "unload",
    "demould",
    "pack",
  ];
  for (const batch of batches) {
    for (const phase of attended) {
      const interval = batch.intervals[phase];
      workerSpans.push({ start: interval.start, end: interval.end, units: 1 });
    }
    ovenSpans.push({
      start: batch.intervals.load.start,
      end: batch.intervals.unload.end,
      units: batch.trayCount,
    });
    rackSpans.push({
      start: batch.intervals.cool.start,
      end: batch.intervals.pack.start,
      units: batch.trayCount,
    });
  }
  if (!fitsCapacity(workerSpans, workers))
    return "Observed active work exceeds the recorded worker count.";
  if (!fitsCapacity(ovenSpans, ovenTrays))
    return "Observed loaded trays exceed usable oven capacity.";
  if (!fitsCapacity(rackSpans, rackTrays))
    return "Observed cooling trays exceed usable rack capacity.";
  return null;
}

function fitsCapacity(spans: readonly Occupancy[], capacity: number): boolean {
  const events: OccupancyEvent[] = [];
  for (const span of spans) {
    events.push({ time: span.start, change: span.units });
    events.push({ time: span.end, change: -span.units });
  }
  events.sort(compareOccupancyEvents);
  let occupied = 0;
  for (const event of events) {
    occupied += event.change;
    if (occupied > capacity) return false;
  }
  return true;
}

function compareOccupancyEvents(
  left: OccupancyEvent,
  right: OccupancyEvent,
): number {
  return left.time - right.time || left.change - right.change;
}

function packEnd(batch: MeasuredBatch): number {
  return batch.intervals.pack.end;
}

type ParsedText =
  | Readonly<{ kind: "valid"; value: string; message?: never }>
  | Readonly<{ kind: "missing"; message: string; value?: never }>;

function measuredText(value: unknown, key: string): ParsedText {
  return nonemptyText(value, 200)
    ? { kind: "valid", value }
    : { kind: "missing", message: `Enter ${key} in the measured shift.` };
}

function isMissingText(
  value: ParsedText,
): value is Variant<ParsedText, "missing"> {
  return value.kind === "missing";
}

function isWorkerId(value: unknown): value is string {
  return nonemptyText(value, 80);
}

function nonemptyText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= max
  );
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function invalid(message: string): Variant<MeasuredShiftImport, "invalid"> {
  return { kind: "invalid", message };
}
