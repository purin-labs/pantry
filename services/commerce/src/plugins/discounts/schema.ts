// The tables of the discounts built-in plugin (Plan 77 step 6). The core
// schema builds them in its fixed order; only this plugin's code names them.
// Discounts, their codes, and the uses that checkouts hold and orders redeem.
// Discounts, their codes, and the uses that checkouts hold and orders redeem.
export const DISCOUNT_SCHEMA = `
CREATE TABLE IF NOT EXISTS discount (
  merchant_id TEXT NOT NULL,
  discount_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  method_kind TEXT NOT NULL CHECK (method_kind IN ('code', 'automatic')),
  discount_json TEXT NOT NULL CHECK (json_valid(discount_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, discount_id)
) STRICT;
CREATE TABLE IF NOT EXISTS discount_code (
  merchant_id TEXT NOT NULL,
  code TEXT NOT NULL,
  discount_id TEXT NOT NULL,
  PRIMARY KEY (merchant_id, code),
  FOREIGN KEY (merchant_id, discount_id)
    REFERENCES discount (merchant_id, discount_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE IF NOT EXISTS discount_redemption (
  merchant_id TEXT NOT NULL,
  discount_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  order_id TEXT,
  customer_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('held', 'redeemed')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, discount_id, checkout_id),
  CHECK ((state = 'redeemed') = (order_id IS NOT NULL)),
  FOREIGN KEY (merchant_id, discount_id)
    REFERENCES discount (merchant_id, discount_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS discount_redemption_checkout
  ON discount_redemption (merchant_id, checkout_id);`;
