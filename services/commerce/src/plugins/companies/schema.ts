// The tables of the companies built-in plugin (Plan 76 phase 8 slice 2,
// schema 77). The core schema builds them in its fixed order; only this
// plugin's code names them. A customer buys for at most one company; an
// invoice is one order on the company's terms.
export const COMPANY_SCHEMA = `
CREATE TABLE IF NOT EXISTS company (
  merchant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  company_json TEXT NOT NULL CHECK (json_valid(company_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, company_id)
) STRICT;
CREATE TABLE IF NOT EXISTS company_member (
  merchant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  PRIMARY KEY (merchant_id, customer_id),
  FOREIGN KEY (merchant_id, company_id)
    REFERENCES company (merchant_id, company_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS company_invoice (
  merchant_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  company_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'overdue', 'paid')),
  due_at TEXT NOT NULL,
  invoice_json TEXT NOT NULL CHECK (json_valid(invoice_json)),
  PRIMARY KEY (merchant_id, invoice_id),
  UNIQUE (merchant_id, payment_id)
) STRICT;
CREATE INDEX IF NOT EXISTS company_invoice_due
  ON company_invoice (merchant_id, due_at) WHERE state = 'open';`;
