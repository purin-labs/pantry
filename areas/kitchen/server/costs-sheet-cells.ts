/**
 * The draft cells of the costs sheet that one saved record settles. A Portal
 * save and an agent save settle the same cells for the same record.
 */
import {
  FORECAST_CAPEX_MINOR_CELL_KEY,
  FORECAST_DEMAND_CURVE_CELL_KEY,
  FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY,
  FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY,
  FORECAST_OPENING_CASH_CELL_KEY,
  FORECAST_SUPPLIER_TERMS_CELL_KEY,
  OVERHEAD_LABOR_CELL_KEY,
  OVERHEAD_RENT_CELL_KEY,
  SCENARIO_PRESET_CELL_KEY,
  forecastWeekIndexCellKey,
  lotInvoiceFieldCellKey,
  productCogsCellKey,
  productDailyCellKey,
  productDayCellKey,
  productFormulaCellKey,
  productSpoilCellKey,
  productWasteCellKey,
  supplyFieldCellKey,
} from "@purin-labs/costs-sheet-crdt";
import { COST_FORMULA_COLUMNS } from "@purin-labs/kitchen-control-api";

/** The pack and bulk tier cells of one stock item. */
export function supplyItemCellKeys(inventoryItemId: string): string[] {
  return [
    supplyFieldCellKey(inventoryItemId, "packQuantity"),
    supplyFieldCellKey(inventoryItemId, "packUnit"),
    supplyFieldCellKey(inventoryItemId, "packPriceMajor"),
    supplyFieldCellKey(inventoryItemId, "bulkMin7dQuantity"),
    supplyFieldCellKey(inventoryItemId, "bulkPackQuantity"),
    supplyFieldCellKey(inventoryItemId, "bulkPackPriceMajor"),
  ];
}

/** The invoice cells of one lot. */
export function lotInvoiceCellKeys(lotId: string): string[] {
  return [
    lotInvoiceFieldCellKey(lotId, "invoiceReference"),
    lotInvoiceFieldCellKey(lotId, "invoiceTotalMajor"),
  ];
}

/**
 * The cells of a saved cost plan: the scenario preset, labor and rent when the
 * save set them, the forecast when the save carried one, and the cells of each
 * product of the save.
 */
export function costPlanCellKeys(
  plan: Readonly<{
    dailyLaborMinor: number | null;
    dailyRentMinor: number | null;
    hasForecast: boolean;
    productIds: readonly string[];
  }>,
): string[] {
  const keys: string[] = [SCENARIO_PRESET_CELL_KEY];
  if (plan.dailyLaborMinor !== null) {
    keys.push(OVERHEAD_LABOR_CELL_KEY);
  }
  if (plan.dailyRentMinor !== null) {
    keys.push(OVERHEAD_RENT_CELL_KEY);
  }
  if (plan.hasForecast) {
    keys.push(
      FORECAST_OPENING_CASH_CELL_KEY,
      FORECAST_DEMAND_CURVE_CELL_KEY,
      FORECAST_SUPPLIER_TERMS_CELL_KEY,
      FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY,
      FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY,
      FORECAST_CAPEX_MINOR_CELL_KEY,
    );
    for (let week = 0; week < 12; week += 1) {
      keys.push(forecastWeekIndexCellKey(week));
    }
  }
  for (const productId of plan.productIds) {
    keys.push(
      productDailyCellKey(productId),
      productSpoilCellKey(productId),
      productCogsCellKey(productId),
      productWasteCellKey(productId),
    );
    for (const column of COST_FORMULA_COLUMNS) {
      keys.push(productFormulaCellKey(productId, column));
    }
    for (let day = 0; day < 7; day += 1) {
      keys.push(productDayCellKey(productId, day));
    }
  }
  return keys;
}
