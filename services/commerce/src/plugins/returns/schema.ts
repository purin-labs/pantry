// The tables of the returns built-in plugin (Plan 77 step 6). The core
// schema builds them in its fixed order; only this plugin's code names them.
// Schema 53: returns of fulfilled order lines (not the commerce_return table
// that schema 42 removed). Restocked units enter the stock
// ledger as receipts that name the return.
// Schema 53: returns of fulfilled order lines (not the commerce_return table
// that schema 42 removed). Restocked units enter the stock
// ledger as receipts that name the return.
export const ORDER_RETURN_SCHEMA = `
CREATE TABLE IF NOT EXISTS order_return (
  merchant_id TEXT NOT NULL,
  return_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('requested', 'authorized', 'rejected', 'received', 'closed')
  ),
  return_json TEXT NOT NULL CHECK (json_valid(return_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, return_id),
  FOREIGN KEY (merchant_id, order_id)
    REFERENCES commerce_order (merchant_id, resource_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS order_return_order
  ON order_return (merchant_id, order_id);`;
