// The tables of the draft-orders built-in plugin (Plan 77 step 6). The core
// schema builds them in its fixed order; only this plugin's code names them.
// Schema 52: staff draft orders. The draft holds its lines and staff prices;
// its checkouts and its order stay in their own tables.
// Schema 52: staff draft orders. The draft holds its lines and staff prices;
// its checkouts and its order stay in their own tables.
export const DRAFT_ORDER_SCHEMA = `
CREATE TABLE IF NOT EXISTS draft_order (
  merchant_id TEXT NOT NULL,
  draft_order_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  storefront_id TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('open', 'invoiced', 'cancelled')
  ),
  draft_json TEXT NOT NULL CHECK (json_valid(draft_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, draft_order_id),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;`;
