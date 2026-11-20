import type { OrganisationDatabase } from "../database-handles";
import {
  areCostUnitsCompatible,
  isCostFormulaColumn,
  isValidCostFormulaString,
  normalizeCostForecastPlan,
  type CostForecastPlan,
  type CostUnit,
  type LotCostLineWrite,
  type OfferPriceWrite,
  type OrganisationCostPlan,
  type ProductCostPlanEntry,
  type SupplyLotInvoiceCost,
} from "@purin-labs/kitchen-control-api";
import {
  commerceCommandInput,
  type CommerceAdminClient,
} from "@purin-labs/commerce-client";

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

type OfferPriceSaveResult =
  | Readonly<{ ok: true; merchantRevision: number | null }>
  | Readonly<{
      ok: false;
      code:
        | "underclerk_unavailable"
        | "underclerk_scope_mismatch"
        | "offer_price_changed";
    }>
  | Readonly<{ ok: false; code: "offer_price_invalid"; detail: string }>;

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

export async function saveOrganisationCostPlan(
  input: Readonly<{
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
  }>,
): Promise<CostPlanSaveResult> {
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

  if (input.expectedPlanRevision === null) {
    if (current.revision !== null) {
      if (
        current.revision === 1 &&
        samePlanState(
          current,
          nextDailyLaborMinor,
          nextDailyRentMinor,
          nextProducts,
          nextForecastJson,
        )
      ) {
        return { ok: true, revision: 1, plan: current };
      }
      return { ok: false, code: "cost_plan_changed" };
    }

    const nextRevision = 1;
    const statements: D1PreparedStatement[] = [
      input.db
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
        ),
      ...buildGuardedProductStatements(
        input.db,
        input.organisationId,
        nextRevision,
        nextProducts,
        input.nowMs,
      ),
    ];

    const batchResults = await input.db.batch(statements);
    if ((batchResults[0]?.meta.changes ?? 0) !== 1) {
      return { ok: false, code: "cost_plan_changed" };
    }
    return {
      ok: true,
      revision: nextRevision,
      plan: {
        revision: nextRevision,
        dailyLaborMinor: nextDailyLaborMinor,
        dailyRentMinor: nextDailyRentMinor,
        products: nextProducts,
        ...(nextForecast !== undefined ? { forecast: nextForecast } : {}),
      },
    };
  }

  if (current.revision === null) {
    return { ok: false, code: "cost_plan_changed" };
  }
  if (current.revision !== input.expectedPlanRevision) {
    if (
      current.revision === input.expectedPlanRevision + 1 &&
      samePlanState(
        current,
        nextDailyLaborMinor,
        nextDailyRentMinor,
        nextProducts,
        nextForecastJson,
      )
    ) {
      return { ok: true, revision: current.revision, plan: current };
    }
    return { ok: false, code: "cost_plan_changed" };
  }

  const nextRevision = input.expectedPlanRevision + 1;
  const statements: D1PreparedStatement[] = [
    input.db
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
        input.expectedPlanRevision,
      ),
    ...buildGuardedProductStatements(
      input.db,
      input.organisationId,
      nextRevision,
      nextProducts,
      input.nowMs,
    ),
  ];

  const batchResults = await input.db.batch(statements);
  if ((batchResults[0]?.meta.changes ?? 0) !== 1) {
    return { ok: false, code: "cost_plan_changed" };
  }
  return {
    ok: true,
    revision: nextRevision,
    plan: {
      revision: nextRevision,
      dailyLaborMinor: nextDailyLaborMinor,
      dailyRentMinor: nextDailyRentMinor,
      products: nextProducts,
      ...(nextForecast !== undefined ? { forecast: nextForecast } : {}),
    },
  };
}

export async function saveOfferPriceWrites(input: Readonly<{
  adminClient: CommerceAdminClient;
  merchantId: string;
  idempotencyKey: string;
  writes: readonly OfferPriceWrite[];
}>): Promise<OfferPriceSaveResult> {
  if (input.writes.length === 0) {
    return { ok: true, merchantRevision: null };
  }
  let latestMerchantRevision: number | null = null;
  const baseKey = input.idempotencyKey.slice(0, 80);

  for (const offerWrite of input.writes) {
    const updated = await input.adminClient.updateOffer(
      commerceCommandInput({
        merchantId: input.merchantId,
        idempotencyKey: `${baseKey}:offer:${offerWrite.offerId}`,
        offerId: offerWrite.offerId,
        expectedOfferRevision: offerWrite.expectedOfferRevision,
        changes: {
          price: {
            amountMinor: offerWrite.priceMinor,
            currency: offerWrite.currency,
          },
        },
      }),
    );
    if (!updated.ok) {
      return { ok: false, code: "underclerk_unavailable" };
    }
    if (updated.value.outcome === "rejected") {
      const code = updated.value.error.code;
      if (code === "resource_not_found" || code === "invalid_command") {
        return {
          ok: false,
          code: "offer_price_invalid",
          detail: `Offer ${offerWrite.offerId} rejected (${code}).`,
        };
      }
      return { ok: false, code: "offer_price_changed" };
    }
    if (updated.value.receipt.merchantId !== input.merchantId) {
      return { ok: false, code: "underclerk_scope_mismatch" };
    }
    latestMerchantRevision = Number(updated.value.receipt.merchantRevision);
  }

  return { ok: true, merchantRevision: latestMerchantRevision };
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
  let rows: D1Result<LotInvoiceCostRow>;
  try {
    rows = await db
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("bakery_lot_invoice_cost")) {
      return new Map();
    }
    throw error;
  }

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
  let rows: D1Result<SupplierPayableRow>;
  try {
    rows = await db
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("supplier_payable")) {
      return new Map();
    }
    throw error;
  }

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

export async function saveOrganisationLotInvoiceCost(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: string;
    updatedBy: string;
    nowMs: number;
    write: LotCostLineWrite;
    knownLotsById?: ReadonlyMap<
      string,
      Readonly<{ inventoryItemId: string; baseUnit: CostUnit }>
    >;
  }>,
): Promise<LotCostSaveResult> {
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

  await ensureLotInvoiceCostTable(input.db);
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

  if (write.expectedRevision === null) {
    if (existing !== null) {
      if (existing.revision === 1 && sameLotInvoiceCost(existing, write)) {
        return {
          ok: true,
          revision: 1,
          invoiceCost: existing,
        };
      }
      return { ok: false, code: "lot_cost_changed" };
    }

    const nextRevision = 1;
    const inserted = await input.db
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
      .run();

    if ((inserted.meta.changes ?? 0) !== 1) {
      return { ok: false, code: "lot_cost_changed" };
    }

    return {
      ok: true,
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
    };
  }

  if (existing === null) {
    return { ok: false, code: "lot_cost_changed" };
  }
  if (existing.revision !== write.expectedRevision) {
    if (
      existing.revision === write.expectedRevision + 1 &&
      sameLotInvoiceCost(existing, write)
    ) {
      return {
        ok: true,
        revision: existing.revision,
        invoiceCost: existing,
      };
    }
    return { ok: false, code: "lot_cost_changed" };
  }

  const nextRevision = write.expectedRevision + 1;
  const updated = await input.db
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
      write.expectedRevision,
    )
    .run();

  if ((updated.meta.changes ?? 0) !== 1) {
    return { ok: false, code: "lot_cost_changed" };
  }

  return {
    ok: true,
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
  };
}

async function ensureLotInvoiceCostTable(
  db: OrganisationDatabase,
): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS bakery_lot_invoice_cost (
         organisation_id TEXT NOT NULL,
         lot_id TEXT NOT NULL,
         inventory_item_id TEXT NOT NULL,
         revision INTEGER NOT NULL CHECK (revision >= 1),
         currency TEXT NOT NULL,
         invoiced_quantity REAL NOT NULL CHECK (invoiced_quantity > 0),
         invoiced_unit TEXT NOT NULL CHECK (invoiced_unit IN ('each', 'gram', 'kilogram', 'milliliter', 'liter')),
         invoice_total_minor INTEGER NOT NULL CHECK (invoice_total_minor >= 0),
         invoice_reference TEXT,
         supplier_id TEXT,
         updated_by TEXT NOT NULL,
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (organisation_id, lot_id)
       )`,
    )
    .run();
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
