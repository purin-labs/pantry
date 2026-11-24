import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { CommerceStockSnapshot } from "@purin-labs/commerce-client";
import {
  areCostUnitsCompatible,
  isCostFormulaColumn,
  isValidCostFormulaString,
  normalizeCostForecastPlan,
  type CostForecastPlan,
  type CostUnit,
  type LotCostLineWrite,
  type OrganisationCostPlan,
  type ProductCostPlanEntry,
  type SupplyLotInvoiceCost,
} from "@purin-labs/kitchen-control-api";

type PlanHeaderRow = Readonly<{
  revision: number;
  daily_labor_minor: number;
  daily_rent_minor: number;
  forecast_json?: string | null;
}>;

type ProductPlanRow = Readonly<{
  product_id: string;
  mon_units: number;
  tue_units: number;
  wed_units: number;
  thu_units: number;
  fri_units: number;
  sat_units: number;
  sun_units: number;
  spoil_bps: number | null;
  cogs_override_minor?: number | null;
  waste_override_minor?: number | null;
  formulas_json?: string | null;
}>;

export type CostPlanSaveResult =
  | Readonly<{ ok: true; revision: number; plan: OrganisationCostPlan }>
  | Readonly<{ ok: false; code: "cost_plan_changed" }>
  | Readonly<{ ok: false; code: "cost_plan_invalid"; detail: string }>;

export type LotCostSaveResult =
  | Readonly<{ ok: true; revision: number; invoiceCost: SupplyLotInvoiceCost }>
  | Readonly<{ ok: false; code: "lot_cost_changed" }>
  | Readonly<{
      ok: false;
      code: "lot_cost_invalid" | "lot_cost_unit_mismatch";
      detail: string;
    }>;

export type ReplenishmentPayableSummary = Readonly<{
  payableId: string;
  supplierId: string;
  currency: string;
  grossAmountMinor: number;
  settledMinor: number;
  lifecycle: string;
  revision: number;
  updatedAtMs: number;
}>;

export function emptyOrganisationCostPlan(): OrganisationCostPlan {
  return {
    revision: null,
    dailyLaborMinor: 0,
    dailyRentMinor: 0,
    products: [],
  };
}

export async function readOrganisationCostPlan(
  db: OrganisationDatabase,
  organisationId: string,
): Promise<OrganisationCostPlan> {
  const [header, productRows] = await Promise.all([
    db
      .prepare(
        `SELECT *
           FROM bakery_cost_plan
          WHERE organisation_id = ?1`,
      )
      .bind(organisationId)
      .first<PlanHeaderRow>(),
    db
      .prepare(
        `SELECT *
           FROM bakery_cost_product_plan
          WHERE organisation_id = ?1
          ORDER BY product_id ASC`,
      )
      .bind(organisationId)
      .all<ProductPlanRow>(),
  ]);

  if (header === null) {
    return emptyOrganisationCostPlan();
  }

  const products: ProductCostPlanEntry[] = (productRows.results ?? []).map(
    (row) => {
      const formulas = parseFormulasJson(row.formulas_json);
      const cogsOverrideMinor =
        row.cogs_override_minor === null ||
        row.cogs_override_minor === undefined
          ? null
          : nonNegInt(row.cogs_override_minor);
      const wasteOverrideMinor =
        row.waste_override_minor === null ||
        row.waste_override_minor === undefined
          ? null
          : nonNegInt(row.waste_override_minor);
      return {
        productId: String(row.product_id),
        weekUnits: [
          nonNegInt(row.mon_units),
          nonNegInt(row.tue_units),
          nonNegInt(row.wed_units),
          nonNegInt(row.thu_units),
          nonNegInt(row.fri_units),
          nonNegInt(row.sat_units),
          nonNegInt(row.sun_units),
        ],
        spoilBps:
          row.spoil_bps === null || row.spoil_bps === undefined
            ? null
            : Math.min(9_500, nonNegInt(row.spoil_bps)),
        ...(cogsOverrideMinor !== null ? { cogsOverrideMinor } : {}),
        ...(wasteOverrideMinor !== null ? { wasteOverrideMinor } : {}),
        ...(Object.keys(formulas).length > 0 ? { formulas } : {}),
      };
    },
  );

  const forecast = parseForecastJson(header.forecast_json);
  return {
    revision: Math.max(1, Math.trunc(Number(header.revision))),
    dailyLaborMinor: nonNegInt(header.daily_labor_minor),
    dailyRentMinor: nonNegInt(header.daily_rent_minor),
    products,
    ...(forecast !== undefined ? { forecast } : {}),
  };
}

/**
 * A save of D1 rows that the caller applies in one batch. `saved` means the
 * rows already hold the values, so a repeat gives the saved result and writes
 * nothing. `write` holds a guard that fails the whole batch when another save
 * changed the rows after this read, and the statements that write them.
 */
export type PreparedRowSave<T> =
  | Readonly<{ kind: "saved"; value: T }>
  | Readonly<{
      kind: "write";
      guard: D1PreparedStatement;
      statements: readonly D1PreparedStatement[];
      value: T;
    }>;

type SavedCostPlan = Readonly<{
  revision: number;
  plan: OrganisationCostPlan;
}>;

type CostPlanPrepareResult =
  | Readonly<{ ok: true; save: PreparedRowSave<SavedCostPlan> }>
  | Exclude<CostPlanSaveResult, { ok: true }>;

export type CostPlanSaveInput = Readonly<{
  db: OrganisationDatabase;
  organisationId: string;
  updatedBy: string;
  nowMs: number;
  expectedPlanRevision: number | null;
  dailyLaborMinor: number | null;
  dailyRentMinor: number | null;
  products: readonly ProductCostPlanEntry[];
  forecast?: CostForecastPlan | null;
  replaceAllProducts: boolean;
  knownProductIds?: ReadonlySet<string>;
}>;

export async function saveOrganisationCostPlan(
  input: CostPlanSaveInput,
): Promise<CostPlanSaveResult> {
  const prepared = await prepareOrganisationCostPlanSave(input);
  if (!prepared.ok) {
    return prepared;
  }
  if (prepared.save.kind === "saved") {
    return { ok: true, ...prepared.save.value };
  }
  const batchResults = await input.db.batch([...prepared.save.statements]);
  if ((batchResults[0]?.meta.changes ?? 0) !== 1) {
    return { ok: false, code: "cost_plan_changed" };
  }
  return { ok: true, ...prepared.save.value };
}

/** Checks a plan save against the saved plan and builds its statements. */
export async function prepareOrganisationCostPlanSave(
  input: CostPlanSaveInput,
): Promise<CostPlanPrepareResult> {
  if (input.knownProductIds !== undefined) {
    for (const entry of input.products) {
      if (!input.knownProductIds.has(entry.productId)) {
        return {
          ok: false,
          code: "cost_plan_invalid",
          detail: `Product ${entry.productId} is not an active product.`,
        };
      }
    }
  }

  const current = await readOrganisationCostPlan(
    input.db,
    input.organisationId,
  );
  const nextDailyLaborMinor = nonNegInt(
    input.dailyLaborMinor ?? current.dailyLaborMinor,
  );
  const nextDailyRentMinor = nonNegInt(
    input.dailyRentMinor ?? current.dailyRentMinor,
  );
  const nextForecast =
    input.forecast === undefined
      ? current.forecast
      : input.forecast === null
        ? undefined
        : normalizeCostForecastPlan(input.forecast);
  const nextForecastJson = serializeForecastJson(nextForecast);

  const mergedByProductId = new Map<string, ProductCostPlanEntry>();
  if (!input.replaceAllProducts) {
    for (const existing of current.products) {
      if (
        input.knownProductIds === undefined ||
        input.knownProductIds.has(existing.productId)
      ) {
        mergedByProductId.set(existing.productId, existing);
      }
    }
  }
  for (const incoming of input.products) {
    mergedByProductId.set(incoming.productId, normalizeProductEntry(incoming));
  }
  const nextProducts = [...mergedByProductId.values()].sort((left, right) =>
    left.productId.localeCompare(right.productId),
  );
  const sameAsSaved = (): boolean =>
    samePlanState(
      current,
      nextDailyLaborMinor,
      nextDailyRentMinor,
      nextProducts,
      nextForecastJson,
    );

  const expected = input.expectedPlanRevision;
  if (current.revision !== expected) {
    // A repeat of a save that already applied gives the saved plan.
    if (
      current.revision !== null &&
      current.revision === (expected ?? 0) + 1 &&
      sameAsSaved()
    ) {
      return {
        ok: true,
        save: {
          kind: "saved",
          value: { revision: current.revision, plan: current },
        },
      };
    }
    return { ok: false, code: "cost_plan_changed" };
  }

  const nextRevision = (expected ?? 0) + 1;
  const header =
    expected === null
      ? input.db
          .prepare(
            `INSERT INTO bakery_cost_plan (
               organisation_id, revision, daily_labor_minor, daily_rent_minor, forecast_json, updated_by, updated_at
             )
             SELECT ?1, 1, ?2, ?3, ?4, ?5, ?6
             WHERE NOT EXISTS (
               SELECT 1 FROM bakery_cost_plan WHERE organisation_id = ?1
             )`,
          )
          .bind(
            input.organisationId,
            nextDailyLaborMinor,
            nextDailyRentMinor,
            nextForecastJson,
            input.updatedBy,
            input.nowMs,
          )
      : input.db
          .prepare(
            `UPDATE bakery_cost_plan
                SET revision = ?2,
                    daily_labor_minor = ?3,
                    daily_rent_minor = ?4,
                    forecast_json = ?5,
                    updated_by = ?6,
                    updated_at = ?7
              WHERE organisation_id = ?1
                AND revision = ?8`,
          )
          .bind(
            input.organisationId,
            nextRevision,
            nextDailyLaborMinor,
            nextDailyRentMinor,
            nextForecastJson,
            input.updatedBy,
            input.nowMs,
            expected,
          );
  const guard =
    expected === null
      ? batchGuard(
          input.db,
          "NOT EXISTS (SELECT 1 FROM bakery_cost_plan WHERE organisation_id = ?1)",
          [input.organisationId],
          "cost_plan_changed",
        )
      : batchGuard(
          input.db,
          "EXISTS (SELECT 1 FROM bakery_cost_plan WHERE organisation_id = ?1 AND revision = ?2)",
          [input.organisationId, expected],
          "cost_plan_changed",
        );
  return {
    ok: true,
    save: {
      kind: "write",
      guard,
      statements: [
        header,
        ...buildGuardedProductStatements(
          input.db,
          input.organisationId,
          nextRevision,
          nextProducts,
          input.nowMs,
        ),
      ],
      value: {
        revision: nextRevision,
        plan: {
          revision: nextRevision,
          dailyLaborMinor: nextDailyLaborMinor,
          dailyRentMinor: nextDailyRentMinor,
          products: nextProducts,
          ...(nextForecast !== undefined ? { forecast: nextForecast } : {}),
        },
      },
    },
  };
}

/**
 * A statement that fails its batch when `condition` is false, so that no
 * write of the batch applies. The value of `code` names the reason in a log.
 */
function batchGuard(
  db: OrganisationDatabase,
  condition: string,
  values: readonly unknown[],
  code: string,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN ${condition} THEN 1 ELSE json_extract('${code}', '$') END`,
    )
    .bind(...values);
}

function buildGuardedProductStatements(
  db: OrganisationDatabase,
  organisationId: string,
  expectedRevisionAfterHeader: number,
  products: readonly ProductCostPlanEntry[],
  nowMs: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `DELETE FROM bakery_cost_product_plan
          WHERE organisation_id = ?1
            AND EXISTS (
              SELECT 1 FROM bakery_cost_plan
               WHERE organisation_id = ?1 AND revision = ?2
            )`,
      )
      .bind(organisationId, expectedRevisionAfterHeader),
  ];

  for (const entry of products) {
    const formulasJson = serializeFormulasJson(entry.formulas);
    statements.push(
      db
        .prepare(
          `INSERT INTO bakery_cost_product_plan (
             organisation_id, product_id,
             mon_units, tue_units, wed_units, thu_units, fri_units, sat_units, sun_units,
             spoil_bps, cogs_override_minor, waste_override_minor, formulas_json, updated_at
           )
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
           WHERE EXISTS (
             SELECT 1 FROM bakery_cost_plan
              WHERE organisation_id = ?1 AND revision = ?15
           )`,
        )
        .bind(
          organisationId,
          entry.productId,
          entry.weekUnits[0],
          entry.weekUnits[1],
          entry.weekUnits[2],
          entry.weekUnits[3],
          entry.weekUnits[4],
          entry.weekUnits[5],
          entry.weekUnits[6],
          entry.spoilBps,
          entry.cogsOverrideMinor ?? null,
          entry.wasteOverrideMinor ?? null,
          formulasJson,
          nowMs,
          expectedRevisionAfterHeader,
        ),
    );
  }

  return statements;
}

function normalizeProductEntry(
  entry: ProductCostPlanEntry,
): ProductCostPlanEntry {
  const formulas = normalizeFormulasRecord(entry.formulas);
  const cogsOverrideMinor =
    entry.cogsOverrideMinor === null || entry.cogsOverrideMinor === undefined
      ? null
      : nonNegInt(entry.cogsOverrideMinor);
  const wasteOverrideMinor =
    entry.wasteOverrideMinor === null || entry.wasteOverrideMinor === undefined
      ? null
      : nonNegInt(entry.wasteOverrideMinor);
  return {
    productId: entry.productId,
    weekUnits: [
      nonNegInt(entry.weekUnits[0]),
      nonNegInt(entry.weekUnits[1]),
      nonNegInt(entry.weekUnits[2]),
      nonNegInt(entry.weekUnits[3]),
      nonNegInt(entry.weekUnits[4]),
      nonNegInt(entry.weekUnits[5]),
      nonNegInt(entry.weekUnits[6]),
    ],
    spoilBps:
      entry.spoilBps === null
        ? null
        : Math.min(9_500, nonNegInt(entry.spoilBps)),
    ...(cogsOverrideMinor !== null ? { cogsOverrideMinor } : {}),
    ...(wasteOverrideMinor !== null ? { wasteOverrideMinor } : {}),
    ...(Object.keys(formulas).length > 0 ? { formulas } : {}),
  };
}

function normalizeFormulasRecord(
  formulas: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (formulas === undefined) return out;
  const keys = Object.keys(formulas).sort();
  for (const key of keys) {
    const val = formulas[key];
    if (isCostFormulaColumn(key) && isValidCostFormulaString(val)) {
      out[key] = val.trim();
    }
  }
  return out;
}

function parseFormulasJson(raw: string | null | undefined): Record<string, string> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return normalizeFormulasRecord(parsed as Record<string, string>);
  } catch {
    return {};
  }
}

function serializeFormulasJson(
  formulas: Readonly<Record<string, string>> | undefined,
): string | null {
  const normalized = normalizeFormulasRecord(formulas);
  return Object.keys(normalized).length > 0 ? JSON.stringify(normalized) : null;
}

function serializeForecastJson(
  forecast: CostForecastPlan | undefined,
): string | null {
  return forecast === undefined
    ? null
    : JSON.stringify(normalizeCostForecastPlan(forecast));
}

function parseForecastJson(
  raw: string | null | undefined,
): CostForecastPlan | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    return normalizeCostForecastPlan(parsed as Partial<CostForecastPlan>);
  } catch {
    return undefined;
  }
}

function samePlanState(
  current: OrganisationCostPlan,
  dailyLaborMinor: number,
  dailyRentMinor: number,
  products: readonly ProductCostPlanEntry[],
  forecastJson: string | null,
): boolean {
  if (
    current.dailyLaborMinor !== dailyLaborMinor ||
    current.dailyRentMinor !== dailyRentMinor ||
    current.products.length !== products.length ||
    serializeForecastJson(current.forecast) !== forecastJson
  ) {
    return false;
  }
  for (let idx = 0; idx < products.length; idx += 1) {
    const left = current.products[idx];
    const right = products[idx];
    if (
      left === undefined ||
      right === undefined ||
      left.productId !== right.productId ||
      left.spoilBps !== right.spoilBps ||
      (left.cogsOverrideMinor ?? null) !== (right.cogsOverrideMinor ?? null) ||
      (left.wasteOverrideMinor ?? null) !==
        (right.wasteOverrideMinor ?? null) ||
      serializeFormulasJson(left.formulas) !==
        serializeFormulasJson(right.formulas)
    ) {
      return false;
    }
    for (let d = 0; d < 7; d += 1) {
      if (left.weekUnits[d] !== right.weekUnits[d]) {
        return false;
      }
    }
  }
  return true;
}

function nonNegInt(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

type LotInvoiceCostRow = Readonly<{
  lot_id: string;
  inventory_item_id: string;
  revision: number;
  currency: string;
  invoiced_quantity: number;
  invoiced_unit: string;
  invoice_total_minor: number;
  invoice_reference: string | null;
  supplier_id: string | null;
}>;

type SupplierPayableRow = Readonly<{
  payable_id: string;
  supplier_id: string;
  purchase_request_id: string | null;
  currency: string;
  gross_amount_minor: number;
  settled_minor: number;
  lifecycle: string;
  revision: number;
  updated_at: number;
}>;

export async function readOrganisationLotInvoiceCosts(
  db: OrganisationDatabase,
  organisationId: string,
): Promise<ReadonlyMap<string, SupplyLotInvoiceCost>> {
  const rows = await db
    .prepare(
      `SELECT lot_id, inventory_item_id, revision, currency,
              invoiced_quantity, invoiced_unit, invoice_total_minor,
              invoice_reference, supplier_id
         FROM bakery_lot_invoice_cost
        WHERE organisation_id = ?1
        ORDER BY lot_id ASC`,
    )
    .bind(organisationId)
    .all<LotInvoiceCostRow>();

  const out = new Map<string, SupplyLotInvoiceCost>();
  for (const row of rows.results ?? []) {
    const decoded = decodeLotInvoiceCostRow(row);
    if (decoded !== null) {
      out.set(String(row.lot_id), decoded);
    }
  }
  return out;
}

export async function readReplenishmentSupplierPayables(
  db: OrganisationDatabase,
  organisationId: string,
  merchantId: string,
): Promise<ReadonlyMap<string, ReplenishmentPayableSummary>> {
  const rows = await db
    .prepare(
      `SELECT payable_id, supplier_id, purchase_request_id,
              currency, gross_amount_minor, settled_minor, lifecycle,
              revision, updated_at
         FROM supplier_payable
        WHERE organisation_id = ?1
          AND merchant_id = ?2
          AND purchase_request_id IS NOT NULL
          AND lifecycle != 'void'
        ORDER BY updated_at DESC, payable_id ASC`,
    )
    .bind(organisationId, merchantId)
    .all<SupplierPayableRow>();

  const out = new Map<string, ReplenishmentPayableSummary>();
  for (const row of rows.results ?? []) {
    const purchaseRequestId =
      typeof row.purchase_request_id === "string"
        ? row.purchase_request_id.trim()
        : "";
    if (purchaseRequestId.length === 0 || out.has(purchaseRequestId)) {
      continue;
    }
    out.set(purchaseRequestId, {
      payableId: String(row.payable_id),
      supplierId: String(row.supplier_id),
      currency: String(row.currency),
      grossAmountMinor: nonNegInt(row.gross_amount_minor),
      settledMinor: nonNegInt(row.settled_minor),
      lifecycle: String(row.lifecycle),
      revision: Math.max(1, Math.trunc(Number(row.revision))),
      updatedAtMs: nonNegInt(row.updated_at),
    });
  }
  return out;
}

export type LotCostSaveInput = Readonly<{
  db: OrganisationDatabase;
  organisationId: string;
  updatedBy: string;
  nowMs: number;
  write: LotCostLineWrite;
  knownLotsById?: KnownLotsById;
}>;

/** The stock item and the base unit of each lot that can carry an invoice cost. */
export type KnownLotsById = ReadonlyMap<
  string,
  Readonly<{ inventoryItemId: string; baseUnit: CostUnit }>
>;

/** The lots of the snapshot whose stock item is not a finished good. */
export function knownLotsOfSnapshot(
  snapshot: CommerceStockSnapshot,
): KnownLotsById {
  const itemsById = new Map(
    snapshot.commerce.resources.inventoryItems.map((item) => [item.id, item]),
  );
  const lots = new Map<
    string,
    Readonly<{ inventoryItemId: string; baseUnit: CostUnit }>
  >();
  for (const lot of snapshot.lots) {
    const item = itemsById.get(lot.inventoryItemId);
    if (item === undefined || item.category === "finished_good") {
      continue;
    }
    lots.set(lot.id, {
      inventoryItemId: lot.inventoryItemId,
      baseUnit: item.baseUnit,
    });
  }
  return lots;
}

type SavedLotCost = Readonly<{
  revision: number;
  invoiceCost: SupplyLotInvoiceCost;
}>;

type LotCostPrepareResult =
  | Readonly<{ ok: true; save: PreparedRowSave<SavedLotCost> }>
  | Exclude<LotCostSaveResult, { ok: true }>;

export async function saveOrganisationLotInvoiceCost(
  input: LotCostSaveInput,
): Promise<LotCostSaveResult> {
  const prepared = await prepareOrganisationLotInvoiceCostSave(input);
  if (!prepared.ok) {
    return prepared;
  }
  if (prepared.save.kind === "saved") {
    return { ok: true, ...prepared.save.value };
  }
  const [write] = prepared.save.statements;
  const written = write === undefined ? null : await write.run();
  if ((written?.meta.changes ?? 0) !== 1) {
    return { ok: false, code: "lot_cost_changed" };
  }
  return { ok: true, ...prepared.save.value };
}

/** Checks a lot invoice cost against its lot and saved row, and builds its statement. */
export async function prepareOrganisationLotInvoiceCostSave(
  input: LotCostSaveInput,
): Promise<LotCostPrepareResult> {
  const { write } = input;
  if (input.knownLotsById !== undefined) {
    const knownLot = input.knownLotsById.get(write.lotId);
    if (knownLot === undefined) {
      return {
        ok: false,
        code: "lot_cost_invalid",
        detail: `Inventory lot ${write.lotId} was not found.`,
      };
    }
    if (knownLot.inventoryItemId !== write.inventoryItemId) {
      return {
        ok: false,
        code: "lot_cost_invalid",
        detail: `Lot ${write.lotId} belongs to item ${knownLot.inventoryItemId}, not ${write.inventoryItemId}.`,
      };
    }
    if (!areCostUnitsCompatible(write.invoicedUnit, knownLot.baseUnit)) {
      return {
        ok: false,
        code: "lot_cost_unit_mismatch",
        detail: `Invoiced unit ${write.invoicedUnit} is not compatible with ${knownLot.baseUnit}.`,
      };
    }
  }

  const existingRow = await input.db
    .prepare(
      `SELECT lot_id, inventory_item_id, revision, currency,
              invoiced_quantity, invoiced_unit, invoice_total_minor,
              invoice_reference, supplier_id
         FROM bakery_lot_invoice_cost
        WHERE organisation_id = ?1
          AND lot_id = ?2`,
    )
    .bind(input.organisationId, write.lotId)
    .first<LotInvoiceCostRow>();
  const existing =
    existingRow === null ? null : decodeLotInvoiceCostRow(existingRow);

  const expected = write.expectedRevision;
  const currentRevision = existing?.revision ?? null;
  if (currentRevision !== expected) {
    // A repeat of a save that already applied gives the saved cost.
    if (
      existing !== null &&
      existing.revision === (expected ?? 0) + 1 &&
      sameLotInvoiceCost(existing, write)
    ) {
      return {
        ok: true,
        save: {
          kind: "saved",
          value: { revision: existing.revision, invoiceCost: existing },
        },
      };
    }
    return { ok: false, code: "lot_cost_changed" };
  }

  const nextRevision = (expected ?? 0) + 1;
  const statement =
    expected === null
      ? input.db
          .prepare(
            `INSERT INTO bakery_lot_invoice_cost (
               organisation_id, lot_id, inventory_item_id, revision,
               currency, invoiced_quantity, invoiced_unit, invoice_total_minor,
               invoice_reference, supplier_id, updated_by, updated_at
             )
             SELECT ?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
             WHERE NOT EXISTS (
               SELECT 1 FROM bakery_lot_invoice_cost
                WHERE organisation_id = ?1 AND lot_id = ?2
             )`,
          )
          .bind(
            input.organisationId,
            write.lotId,
            write.inventoryItemId,
            write.currency,
            write.invoicedQuantity,
            write.invoicedUnit,
            nonNegInt(write.invoiceTotalMinor),
            write.invoiceReference,
            write.supplierId,
            input.updatedBy,
            input.nowMs,
          )
      : input.db
          .prepare(
            `UPDATE bakery_lot_invoice_cost
                SET revision = ?3,
                    inventory_item_id = ?4,
                    currency = ?5,
                    invoiced_quantity = ?6,
                    invoiced_unit = ?7,
                    invoice_total_minor = ?8,
                    invoice_reference = ?9,
                    supplier_id = ?10,
                    updated_by = ?11,
                    updated_at = ?12
              WHERE organisation_id = ?1
                AND lot_id = ?2
                AND revision = ?13`,
          )
          .bind(
            input.organisationId,
            write.lotId,
            nextRevision,
            write.inventoryItemId,
            write.currency,
            write.invoicedQuantity,
            write.invoicedUnit,
            nonNegInt(write.invoiceTotalMinor),
            write.invoiceReference,
            write.supplierId,
            input.updatedBy,
            input.nowMs,
            expected,
          );
  const guard =
    expected === null
      ? batchGuard(
          input.db,
          "NOT EXISTS (SELECT 1 FROM bakery_lot_invoice_cost WHERE organisation_id = ?1 AND lot_id = ?2)",
          [input.organisationId, write.lotId],
          "lot_cost_changed",
        )
      : batchGuard(
          input.db,
          "EXISTS (SELECT 1 FROM bakery_lot_invoice_cost WHERE organisation_id = ?1 AND lot_id = ?2 AND revision = ?3)",
          [input.organisationId, write.lotId, expected],
          "lot_cost_changed",
        );
  return {
    ok: true,
    save: {
      kind: "write",
      guard,
      statements: [statement],
      value: {
        revision: nextRevision,
        invoiceCost: {
          revision: nextRevision,
          source: "lot_invoice",
          currency: write.currency,
          invoicedQuantity: write.invoicedQuantity,
          invoicedUnit: write.invoicedUnit,
          invoiceTotalMinor: nonNegInt(write.invoiceTotalMinor),
          invoiceReference: write.invoiceReference,
          supplierId: write.supplierId,
        },
      },
    },
  };
}

function decodeLotInvoiceCostRow(
  row: LotInvoiceCostRow,
): SupplyLotInvoiceCost | null {
  const unit = parseLotCostUnit(row.invoiced_unit);
  const qty = Number(row.invoiced_quantity);
  if (unit === null || !Number.isFinite(qty) || qty <= 0) {
    return null;
  }
  return {
    revision: Math.max(1, Math.trunc(Number(row.revision))),
    source: "lot_invoice",
    currency: String(row.currency),
    invoicedQuantity: qty,
    invoicedUnit: unit,
    invoiceTotalMinor: nonNegInt(row.invoice_total_minor),
    invoiceReference:
      typeof row.invoice_reference === "string" &&
      row.invoice_reference.trim().length > 0
        ? row.invoice_reference.trim()
        : null,
    supplierId:
      typeof row.supplier_id === "string" && row.supplier_id.trim().length > 0
        ? row.supplier_id.trim()
        : null,
  };
}

function parseLotCostUnit(value: string): CostUnit | null {
  switch (value) {
    case "each":
    case "gram":
    case "kilogram":
    case "milliliter":
    case "liter":
      return value;
    default:
      return null;
  }
}

function sameLotInvoiceCost(
  existing: SupplyLotInvoiceCost,
  write: LotCostLineWrite,
): boolean {
  return (
    existing.currency === write.currency &&
    Math.abs(existing.invoicedQuantity - write.invoicedQuantity) < 1e-6 &&
    existing.invoicedUnit === write.invoicedUnit &&
    existing.invoiceTotalMinor === nonNegInt(write.invoiceTotalMinor) &&
    existing.invoiceReference === write.invoiceReference &&
    existing.supplierId === write.supplierId
  );
}
