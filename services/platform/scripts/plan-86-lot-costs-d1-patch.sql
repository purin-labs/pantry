-- Plan 86 Phase 5: Per-lot purchase invoice cost records in regional D1.
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
