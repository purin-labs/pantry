import {
  checkDocumentSize,
  defineSharedDoc,
  sharedDocFailure as failure,
  sharedDocSuccess as success,
  type SharedDocEncoding,
  type SharedDocError,
  type SharedDocResult,
} from "@purin-labs/collaboration";
import * as Y from "yjs";
import {
  COSTS_SHEET_CELL_LIMIT,
  COSTS_SHEET_STATE_LIMIT,
  COSTS_SHEET_STATE_VECTOR_LIMIT,
  COSTS_SHEET_UPDATE_LIMIT,
} from "./limits.ts";
export {
  COSTS_SHEET_STATE_VECTOR_LIMIT,
  COSTS_SHEET_UPDATE_LIMIT,
} from "./limits.ts";

/**
 * Plan 86 Phase 3: the shared multiplayer Costs & margins workbook of one
 * Organisation. Each entry in `cells` is a sparse cell override over the
 * saved Commerce and regional D1 baseline; concurrent edits to distinct
 * cells merge without conflict, while edits to one cell keep the later value.
 */
export const COSTS_SHEET_SCHEMA = "costs_sheet_crdt.v1";

export const META_SAVED_AT_CELL_KEY = "meta:savedAt";
export const OVERHEAD_LABOR_CELL_KEY = "overhead:dailyLabor";
export const OVERHEAD_RENT_CELL_KEY = "overhead:dailyRent";
export const SCENARIO_PRESET_CELL_KEY = "scenario:preset";
export const SCENARIO_BAKE_WASTE_CELL_KEY = "scenario:bakeShelfWastePct";
export const SCENARIO_PREP_REJECT_CELL_KEY = "scenario:prepRejectPct";
export const SCENARIO_CHANNEL_FEE_CELL_KEY = "scenario:channelFeeBps";
export const SCENARIO_INCLUDED_TAX_CELL_KEY = "scenario:includedTaxBps";
export const SCENARIO_BULK_TIERS_CELL_KEY = "scenario:applyBulkTiers";
export const SCENARIO_LOT_COST_BASIS_CELL_KEY = "scenario:lotCostBasis";
export const FORECAST_OPENING_CASH_CELL_KEY = "forecast:opening_cash";
export const FORECAST_DEMAND_CURVE_CELL_KEY = "forecast:demand_curve";
export const FORECAST_SUPPLIER_TERMS_CELL_KEY = "forecast:supplier_terms";
export const FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY =
  "forecast:extra_shift_pct";
export const FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY =
  "forecast:extra_shift_minor";
export const FORECAST_CAPEX_MINOR_CELL_KEY = "forecast:capex_minor";

export type CostsSheetTab =
  | "margins"
  | "weekly"
  | "actuals"
  | "forecast"
  | "supplies";

export type CostsSheetSupplyField =
  | "packQuantity"
  | "packUnit"
  | "packPriceMajor"
  | "bulkMin7dQuantity"
  | "bulkPackQuantity"
  | "bulkPackPriceMajor";

export type CostsSheetLotInvoiceField =
  | "invoiceReference"
  | "invoiceTotalMajor";

export type CostsSheetCell = Readonly<{
  cellKey: string;
  value: string;
}>;

export type CostsSheetCellChange = Readonly<{
  cellKey: string;
  /** `null` removes the cell override so the baseline value shows again. */
  value: string | null;
}>;

type CostsSheetSnapshot = Readonly<{
  cells: readonly CostsSheetCell[];
}>;

/** The active sheet tab and focused cell that a participant works on. */
export type CostsSheetSelection = Readonly<{
  sheet: CostsSheetTab;
  cellKey: string | null;
}>;

/**
 * The document's own failures, beside the failures of an encoding. No call
 * gives `record_conflict` today: an edit that changes nothing gives null.
 * The failure frame of the room keeps the code.
 */
const FAILURES = [
  "invalid_document_shape",
  "collection_limit",
  "cell_invalid",
  "record_conflict",
] as const;
export type CostsSheetCrdtError = SharedDocError<(typeof FAILURES)[number]>;

type CostsSheetCrdtResult<T> = SharedDocResult<
  T,
  CostsSheetCrdtError["code"]
>;

const ENCODING_LIMITS = {
  state: COSTS_SHEET_STATE_LIMIT,
  update: COSTS_SHEET_UPDATE_LIMIT,
  stateVector: COSTS_SHEET_STATE_VECTOR_LIMIT,
} as const;

export const costsSheetDocument = defineSharedDoc({
  schema: COSTS_SHEET_SCHEMA,
  limits: ENCODING_LIMITS,
  failures: FAILURES,
  roots: { cells: "map" },
  shapeFailure: "invalid_document_shape",
  validate: validateDocument,
});

type Schema = typeof COSTS_SHEET_SCHEMA;
type CostsSheetState = SharedDocEncoding<"state", Schema>;
export type CostsSheetUpdate = SharedDocEncoding<"update", Schema>;
export type CostsSheetStateVector = SharedDocEncoding<"state_vector", Schema>;

export const parseCostsSheetState = costsSheetDocument.parseState;

export function productDailyCellKey(productId: string): string {
  return `product:${productId}:daily`;
}

export function productDayCellKey(productId: string, dayIndex: number): string {
  return `product:${productId}:day:${dayIndex}`;
}

export function productSpoilCellKey(productId: string): string {
  return `product:${productId}:spoil`;
}

export function productPriceCellKey(productId: string): string {
  return `product:${productId}:price`;
}

export function productCogsCellKey(productId: string): string {
  return `product:${productId}:cogs`;
}

export function productWasteCellKey(productId: string): string {
  return `product:${productId}:waste`;
}

export function productFormulaCellKey(
  productId: string,
  column: string,
): string {
  return `product:${productId}:fx:${column}`;
}

export function productMarginSelectionKey(productId: string): string {
  return `product:${productId}:margin`;
}

export function productUnitNetSelectionKey(productId: string): string {
  return `product:${productId}:unitNet`;
}

export function productNetDaySelectionKey(productId: string): string {
  return `product:${productId}:netDay`;
}

export function supplyFieldCellKey(
  itemId: string,
  field: CostsSheetSupplyField,
): string {
  return `supply:${itemId}:${field}`;
}

export function lotInvoiceFieldCellKey(
  lotId: string,
  field: CostsSheetLotInvoiceField,
): string {
  return `lot:${lotId}:${field}`;
}

export function forecastWeekIndexCellKey(weekIndex: number): string {
  return `forecast:week_idx:${weekIndex}`;
}

export function forecastReadonlySelectionKey(
  rowId: string,
  col: string,
): string {
  return `forecast:row:${rowId}:${col}`;
}

export class CostsSheetDoc extends costsSheetDocument.Doc {
  static create(): CostsSheetDoc {
    return new CostsSheetDoc(costsSheetDocument.emptyDocument());
  }

  /** A new document with the same cells and none of their edit history. */
  static compact(
    snapshot: CostsSheetSnapshot,
  ): CostsSheetCrdtResult<CostsSheetDoc> {
    const doc = costsSheetDocument.emptyDocument();
    const cells = doc.getMap("cells");
    doc.transact(writeSnapshotCells.bind(null, cells, snapshot.cells));
    const valid = validateDocument(doc);
    if (!valid.ok) {
      doc.destroy();
      return valid;
    }
    return success(new CostsSheetDoc(doc));
  }

  static restore(
    state: CostsSheetState,
  ): CostsSheetCrdtResult<CostsSheetDoc> {
    const doc = costsSheetDocument.restore(state);
    return doc.ok ? success(new CostsSheetDoc(doc.value)) : doc;
  }

  read(): CostsSheetSnapshot {
    const cells: CostsSheetCell[] = [];
    for (const [cellKey, value] of this.doc.getMap("cells")) {
      if (typeof value === "string") {
        cells.push({ cellKey, value });
      }
    }
    cells.sort(compareCells);
    return { cells };
  }

  cellsRecord(): Readonly<Record<string, string>> {
    const record: Record<string, string> = {};
    for (const [cellKey, value] of this.doc.getMap("cells")) {
      if (typeof value === "string") {
        record[cellKey] = value;
      }
    }
    return record;
  }

  cell(cellKey: string): string | null {
    const value = this.doc.getMap("cells").get(cellKey);
    return typeof value === "string" ? value : null;
  }

  /** Sets or deletes one or more cell overrides in a single Yjs transaction. */
  setCells(
    changes: readonly CostsSheetCellChange[],
  ): CostsSheetCrdtResult<CostsSheetUpdate | null> {
    for (const change of changes) {
      if (change.value === null) {
        if (!isCostsSheetCellKey(change.cellKey)) {
          return failure("cell_invalid");
        }
      } else if (!isCostsSheetCellEntry(change.cellKey, change.value)) {
        return failure("cell_invalid");
      }
    }
    return this.#mutate(applyCellChanges.bind(null, changes));
  }

  /** Clears all non-metadata draft cells so open pages return to the saved baseline. */
  clearAllDraftCells(): CostsSheetCrdtResult<CostsSheetUpdate | null> {
    return this.#mutate(clearDraftCells);
  }

  /**
   * Clears committed cell keys after `Save changes` or an agent save, and
   * stamps `meta:savedAt` so open tabs refresh the saved baseline.
   */
  settleSavedCells(
    cellKeys: readonly string[],
    savedAtMs: number,
    clearPriceCells = false,
  ): CostsSheetCrdtResult<CostsSheetUpdate | null> {
    if (!Number.isSafeInteger(savedAtMs) || savedAtMs <= 0) {
      return failure("cell_invalid");
    }
    for (const key of cellKeys) {
      if (!isCostsSheetCellKey(key)) {
        return failure("cell_invalid");
      }
    }
    return this.#mutate(
      applySettleSavedCells.bind(null, cellKeys, savedAtMs, clearPriceCells),
    );
  }

  /** One Yjs transaction for the whole operation; null when nothing changed. */
  #mutate(
    operation: (doc: Y.Doc) => CostsSheetCrdtResult<boolean>,
  ): CostsSheetCrdtResult<CostsSheetUpdate | null> {
    return this.mutateIfChanged((candidate) =>
      candidate.transact(() => operation(candidate)),
    );
  }
}

const ENTITY_ID_PATTERN = /^[A-Za-z0-9_:.-]{1,160}$/u;
const SUPPLY_ID_PATTERN = /^[A-Za-z0-9_:.-]{1,128}$/u;
const PRESET_VALUES: ReadonlySet<string> = new Set([
  "saved",
  "weekend",
  "rainy",
  "custom",
]);
const SUPPLY_UNITS: ReadonlySet<string> = new Set([
  "each",
  "gram",
  "kilogram",
  "milliliter",
  "liter",
]);
const SUPPLY_FIELDS: ReadonlySet<string> = new Set([
  "packQuantity",
  "packUnit",
  "packPriceMajor",
  "bulkMin7dQuantity",
  "bulkPackQuantity",
  "bulkPackPriceMajor",
]);
const LOT_INVOICE_FIELDS: ReadonlySet<string> = new Set([
  "invoiceReference",
  "invoiceTotalMajor",
]);
const LOT_COST_BASIS_VALUES: ReadonlySet<string> = new Set([
  "standing",
  "fifo_lot",
  "weighted_lot",
]);
const FORECAST_DEMAND_CURVE_VALUES: ReadonlySet<string> = new Set([
  "steady",
  "seasonal_holiday",
  "growth_ramp",
  "winter_dip",
  "custom",
]);
const FORECAST_SUPPLIER_TERMS_VALUES: ReadonlySet<string> = new Set([
  "cod",
  "net_15",
  "net_30",
]);
const PRODUCT_FORMULA_COLUMNS: ReadonlySet<string> = new Set([
  "units",
  "spoil",
  "price",
  "cogs",
  "waste",
  "unitNet",
  "margin",
  "netDay",
]);

export function isCostsSheetTab(value: unknown): value is CostsSheetTab {
  return (
    value === "margins" ||
    value === "weekly" ||
    value === "actuals" ||
    value === "forecast" ||
    value === "supplies"
  );
}

function isIntegerStringInRange(
  value: string,
  min: number,
  max: number,
): boolean {
  if (!/^(0|[1-9][0-9]{0,15})$/u.test(value)) {
    return false;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max;
}

function isPctString(value: string, max: number): boolean {
  if (!/^(0|[1-9][0-9]?)(\.[0-9]{1,2})?$/u.test(value)) {
    return false;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= max;
}

export function isCostsSheetCellKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 220) {
    return false;
  }
  if (
    value === META_SAVED_AT_CELL_KEY ||
    value === OVERHEAD_LABOR_CELL_KEY ||
    value === OVERHEAD_RENT_CELL_KEY ||
    value === SCENARIO_PRESET_CELL_KEY ||
    value === SCENARIO_BAKE_WASTE_CELL_KEY ||
    value === SCENARIO_PREP_REJECT_CELL_KEY ||
    value === SCENARIO_CHANNEL_FEE_CELL_KEY ||
    value === SCENARIO_INCLUDED_TAX_CELL_KEY ||
    value === SCENARIO_BULK_TIERS_CELL_KEY ||
    value === SCENARIO_LOT_COST_BASIS_CELL_KEY ||
    value === FORECAST_OPENING_CASH_CELL_KEY ||
    value === FORECAST_DEMAND_CURVE_CELL_KEY ||
    value === FORECAST_SUPPLIER_TERMS_CELL_KEY ||
    value === FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY ||
    value === FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY ||
    value === FORECAST_CAPEX_MINOR_CELL_KEY
  ) {
    return true;
  }
  if (value.startsWith("forecast:week_idx:")) {
    return /^forecast:week_idx:([0-9]|1[01])$/u.test(value);
  }
  if (value.startsWith("product:")) {
    const rest = value.slice("product:".length);
    const fxMatch = /^([A-Za-z0-9_:.-]{1,160}):fx:([a-zA-Z]{2,16})$/u.exec(rest);
    if (fxMatch !== null) {
      return (
        !fxMatch[1]!.includes(":fx:") &&
        PRODUCT_FORMULA_COLUMNS.has(fxMatch[2]!)
      );
    }
    const dayMatch = /^([A-Za-z0-9_:.-]{1,160}):day:([0-6])$/u.exec(rest);
    if (dayMatch !== null) {
      return !dayMatch[1]!.includes(":fx:");
    }
    for (const suffix of [":daily", ":spoil", ":price", ":cogs", ":waste"]) {
      if (rest.endsWith(suffix)) {
        const productId = rest.slice(0, -suffix.length);
        return (
          !productId.includes(":fx:") && ENTITY_ID_PATTERN.test(productId)
        );
      }
    }
    return false;
  }
  if (value.startsWith("supply:")) {
    const rest = value.slice("supply:".length);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon <= 0) {
      return false;
    }
    const itemId = rest.slice(0, lastColon);
    const field = rest.slice(lastColon + 1);
    return SUPPLY_ID_PATTERN.test(itemId) && SUPPLY_FIELDS.has(field);
  }
  if (value.startsWith("lot:")) {
    const rest = value.slice("lot:".length);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon <= 0) {
      return false;
    }
    const lotId = rest.slice(0, lastColon);
    const field = rest.slice(lastColon + 1);
    return ENTITY_ID_PATTERN.test(lotId) && LOT_INVOICE_FIELDS.has(field);
  }
  return false;
}

export function isCostsSheetSelectionKey(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (value !== META_SAVED_AT_CELL_KEY && isCostsSheetCellKey(value)) {
    return true;
  }
  if (value.startsWith("product:")) {
    const rest = value.slice("product:".length);
    for (const suffix of [":margin", ":unitNet", ":netDay", ":taxFee"]) {
      if (rest.endsWith(suffix)) {
        const productId = rest.slice(0, -suffix.length);
        return ENTITY_ID_PATTERN.test(productId);
      }
    }
  }
  if (value.startsWith("actuals:")) {
    return /^actuals:[A-Za-z0-9_:.-]{1,160}:[A-Za-z0-9_]{1,24}$/u.test(value);
  }
  if (value.startsWith("forecast:row:")) {
    return /^forecast:row:[A-Za-z0-9_]{1,32}:[A-Za-z0-9_]{1,24}$/u.test(value);
  }
  return false;
}

export function isCostsSheetCellEntry(
  cellKey: unknown,
  value: unknown,
): value is string {
  if (!isCostsSheetCellKey(cellKey) || typeof value !== "string") {
    return false;
  }
  switch (cellKey) {
    case META_SAVED_AT_CELL_KEY:
      return isIntegerStringInRange(value, 1, 9_000_000_000_000_000);
    case OVERHEAD_LABOR_CELL_KEY:
    case OVERHEAD_RENT_CELL_KEY:
    case FORECAST_OPENING_CASH_CELL_KEY:
    case FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY:
    case FORECAST_CAPEX_MINOR_CELL_KEY:
      return isIntegerStringInRange(value, 0, 10_000_000_000);
    case FORECAST_DEMAND_CURVE_CELL_KEY:
      return FORECAST_DEMAND_CURVE_VALUES.has(value);
    case FORECAST_SUPPLIER_TERMS_CELL_KEY:
      return FORECAST_SUPPLIER_TERMS_VALUES.has(value);
    case FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY:
      return isIntegerStringInRange(value, 101, 400);
    case SCENARIO_PRESET_CELL_KEY:
      return PRESET_VALUES.has(value);
    // The margin engine takes the same range (COST_SCENARIO_LIMITS of
    // kitchen-control-api).
    case SCENARIO_BAKE_WASTE_CELL_KEY:
    case SCENARIO_PREP_REJECT_CELL_KEY:
      return isPctString(value, 95);
    case SCENARIO_CHANNEL_FEE_CELL_KEY:
      return isIntegerStringInRange(value, 0, 5_000);
    case SCENARIO_INCLUDED_TAX_CELL_KEY:
      return isIntegerStringInRange(value, 0, 10_000);
    case SCENARIO_BULK_TIERS_CELL_KEY:
      return value === "true" || value === "false";
    case SCENARIO_LOT_COST_BASIS_CELL_KEY:
      return LOT_COST_BASIS_VALUES.has(value);
  }
  if (cellKey.startsWith("forecast:week_idx:")) {
    return isIntegerStringInRange(value, 10, 500);
  }
  if (cellKey.startsWith("product:")) {
    if (cellKey.includes(":fx:")) {
      if (value === "default") return true;
      const trimmed = value.trim();
      return (
        trimmed.startsWith("=") &&
        trimmed.length >= 2 &&
        value.length <= 160 &&
        !/[\u0000-\u001f]/u.test(value)
      );
    }
    if (cellKey.endsWith(":daily") || /:day:[0-6]$/u.test(cellKey)) {
      return isIntegerStringInRange(value, 0, 100_000);
    }
    if (cellKey.endsWith(":spoil")) {
      return value === "default" || isIntegerStringInRange(value, 0, 9_500);
    }
    if (cellKey.endsWith(":price")) {
      return isIntegerStringInRange(value, 0, 1_000_000_000);
    }
    if (cellKey.endsWith(":cogs") || cellKey.endsWith(":waste")) {
      return (
        value === "default" || isIntegerStringInRange(value, 0, 1_000_000_000)
      );
    }
    return false;
  }
  if (cellKey.startsWith("supply:")) {
    const field = cellKey.slice(cellKey.lastIndexOf(":") + 1);
    if (field === "packUnit") {
      return SUPPLY_UNITS.has(value);
    }
    if (field === "packPriceMajor" || field === "bulkPackPriceMajor") {
      return value.length <= 24 && /^[0-9]{0,12}(\.[0-9]{0,4})?$/u.test(value);
    }
    return value.length <= 24 && /^[0-9]{0,12}(\.[0-9]{0,6})?$/u.test(value);
  }
  if (cellKey.startsWith("lot:")) {
    const field = cellKey.slice(cellKey.lastIndexOf(":") + 1);
    if (field === "invoiceReference") {
      return (
        value.length >= 1 &&
        value.length <= 120 &&
        !/[\u0000-\u001f]/u.test(value)
      );
    }
    if (field === "invoiceTotalMajor") {
      return (
        value.length <= 24 && /^[0-9]{0,12}(\.[0-9]{0,4})?$/u.test(value)
      );
    }
    return false;
  }
  return false;
}

function writeSnapshotCells(
  cells: Y.Map<unknown>,
  entries: readonly CostsSheetCell[],
): void {
  for (const entry of entries) {
    cells.set(entry.cellKey, entry.value);
  }
}

function applyCellChanges(
  changes: readonly CostsSheetCellChange[],
  doc: Y.Doc,
): CostsSheetCrdtResult<boolean> {
  const cells = doc.getMap("cells");
  let mutated = false;
  for (const change of changes) {
    if (change.value === null) {
      if (cells.has(change.cellKey)) {
        cells.delete(change.cellKey);
        mutated = true;
      }
    } else if (cells.get(change.cellKey) !== change.value) {
      cells.set(change.cellKey, change.value);
      mutated = true;
    }
  }
  return success(mutated);
}

function clearDraftCells(doc: Y.Doc): CostsSheetCrdtResult<boolean> {
  const cells = doc.getMap("cells");
  const keysToDelete: string[] = [];
  for (const key of cells.keys()) {
    if (key !== META_SAVED_AT_CELL_KEY) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    cells.delete(key);
  }
  return success(keysToDelete.length > 0);
}

function applySettleSavedCells(
  cellKeys: readonly string[],
  savedAtMs: number,
  clearPriceCells: boolean,
  doc: Y.Doc,
): CostsSheetCrdtResult<boolean> {
  const cells = doc.getMap("cells");
  for (const key of cellKeys) {
    if (key !== META_SAVED_AT_CELL_KEY && cells.has(key)) {
      cells.delete(key);
    }
  }
  if (clearPriceCells) {
    const priceKeys: string[] = [];
    for (const key of cells.keys()) {
      if (
        key.startsWith("product:") &&
        key.endsWith(":price") &&
        !key.includes(":fx:")
      ) {
        priceKeys.push(key);
      }
    }
    for (const key of priceKeys) {
      cells.delete(key);
    }
  }
  const stamp = String(savedAtMs);
  cells.set(META_SAVED_AT_CELL_KEY, stamp);
  return success(true);
}

/** The check of the content. The shared document checks the root first. */
function validateDocument(doc: Y.Doc): CostsSheetCrdtResult<null> {
  const cells = doc.getMap("cells");
  if (cells.size > COSTS_SHEET_CELL_LIMIT) {
    return failure("collection_limit");
  }
  for (const [cellKey, value] of cells) {
    if (!isCostsSheetCellEntry(cellKey, value)) {
      return failure("invalid_document_shape");
    }
  }
  return checkDocumentSize(doc, ENCODING_LIMITS);
}

function compareCells(first: CostsSheetCell, second: CostsSheetCell): number {
  return first.cellKey.localeCompare(second.cellKey);
}
