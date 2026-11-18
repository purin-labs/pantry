// The tables of the stored-value built-in plugin (Plan 77 step 6). The core
// schema builds them in its fixed order; only this plugin's code names them.
// Gift cards and store credit (Plan 76 phase 8, schema 68). An account holds
// value in one currency; its entries are signed amounts whose sum is the
// balance. A checkout's hold is a negative entry that its placed order
// redeems or its expiry deletes. A gift card keeps only a digest of its code.
// Gift cards and store credit (Plan 76 phase 8, schema 68). An account holds
// value in one currency; its entries are signed amounts whose sum is the
// balance. A checkout's hold is a negative entry that its placed order
// redeems or its expiry deletes. A gift card keeps only a digest of its code.
export const STORED_VALUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS stored_value_account (
  merchant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  kind TEXT NOT NULL CHECK (kind IN ('gift_card', 'store_credit')),
  code_digest TEXT CHECK (
    code_digest IS NULL OR
    (length(code_digest) = 64 AND code_digest NOT GLOB '*[^0-9a-f]*')
  ),
  last_characters TEXT,
  customer_id TEXT,
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  expires_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, account_id),
  CHECK ((kind = 'gift_card') =
    (code_digest IS NOT NULL AND last_characters IS NOT NULL AND customer_id IS NULL)),
  CHECK ((kind = 'store_credit') =
    (customer_id IS NOT NULL AND code_digest IS NULL AND last_characters IS NULL))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS stored_value_account_code
  ON stored_value_account (merchant_id, code_digest) WHERE code_digest IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stored_value_account_customer
  ON stored_value_account (merchant_id, customer_id, currency)
  WHERE customer_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS stored_value_entry (
  merchant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('credit', 'hold', 'redemption', 'refund')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  checkout_id TEXT,
  order_id TEXT,
  payment_id TEXT,
  refund_attempt_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, account_id, entry_id),
  CHECK ((kind IN ('hold', 'redemption')) = (amount_minor < 0)),
  CHECK ((kind = 'hold') = (checkout_id IS NOT NULL AND order_id IS NULL)),
  CHECK ((kind = 'redemption') = (order_id IS NOT NULL AND payment_id IS NOT NULL
    AND refund_attempt_id IS NULL)),
  CHECK ((kind = 'refund') = (refund_attempt_id IS NOT NULL)),
  FOREIGN KEY (merchant_id, account_id)
    REFERENCES stored_value_account (merchant_id, account_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS stored_value_entry_checkout
  ON stored_value_entry (merchant_id, checkout_id) WHERE checkout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stored_value_entry_payment
  ON stored_value_entry (merchant_id, payment_id) WHERE payment_id IS NOT NULL;
`;
