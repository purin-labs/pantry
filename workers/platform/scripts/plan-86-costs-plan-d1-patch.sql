-- Plan 86: Organisation bakery cost plan, formulas, 12-week forecast, and lot invoice costs in regional D1.
-- Applied to production regional D1 (satyr-organisation-apac) on 2026-11-14 before satyr-edge 7e8454a3.
CREATE TABLE IF NOT EXISTS bakery_cost_plan (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  daily_labor_minor INTEGER NOT NULL CHECK (daily_labor_minor >= 0),
  daily_rent_minor INTEGER NOT NULL CHECK (daily_rent_minor >= 0),
  forecast_json TEXT,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

CREATE TABLE IF NOT EXISTS bakery_cost_product_plan (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  product_id TEXT NOT NULL CHECK (length(product_id) BETWEEN 1 AND 160),
  mon_units INTEGER NOT NULL CHECK (mon_units >= 0),
  tue_units INTEGER NOT NULL CHECK (tue_units >= 0),
  wed_units INTEGER NOT NULL CHECK (wed_units >= 0),
  thu_units INTEGER NOT NULL CHECK (thu_units >= 0),
  fri_units INTEGER NOT NULL CHECK (fri_units >= 0),
  sat_units INTEGER NOT NULL CHECK (sat_units >= 0),
  sun_units INTEGER NOT NULL CHECK (sun_units >= 0),
  spoil_bps INTEGER CHECK (spoil_bps IS NULL OR (spoil_bps >= 0 AND spoil_bps <= 9500)),
  cogs_override_minor INTEGER CHECK (cogs_override_minor IS NULL OR cogs_override_minor >= 0),
  waste_override_minor INTEGER CHECK (waste_override_minor IS NULL OR waste_override_minor >= 0),
  formulas_json TEXT,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (organisation_id, product_id)
);

CREATE TABLE IF NOT EXISTS bakery_lot_invoice_cost (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  lot_id TEXT NOT NULL CHECK (length(lot_id) BETWEEN 1 AND 160),
  inventory_item_id TEXT NOT NULL CHECK (length(inventory_item_id) BETWEEN 1 AND 160),
  revision INTEGER NOT NULL CHECK (revision > 0),
  invoice_reference TEXT NOT NULL CHECK (length(invoice_reference) BETWEEN 1 AND 120),
  supplier_id TEXT CHECK (supplier_id IS NULL OR length(supplier_id) <= 128),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  invoiced_quantity REAL NOT NULL CHECK (invoiced_quantity > 0),
  invoiced_unit TEXT NOT NULL CHECK (invoiced_unit IN ('each', 'gram', 'kilogram', 'milliliter', 'liter')),
  invoice_total_minor INTEGER NOT NULL CHECK (invoice_total_minor >= 0),
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (organisation_id, lot_id)
);
CREATE INDEX IF NOT EXISTS idx_bakery_lot_invoice_cost_item
  ON bakery_lot_invoice_cost (organisation_id, inventory_item_id);
