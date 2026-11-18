// The tables of the collections built-in plugin (Plan 77 step 6). The core
// schema builds them in its fixed order; only this plugin's code names them.
// Collections: a storefront list of products, with stored, ordered members.
// Collections: a storefront list of products, with stored, ordered members.
export const COLLECTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS collection (
  merchant_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  handle TEXT NOT NULL,
  sales_channel_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'draft')),
  collection_json TEXT NOT NULL CHECK (json_valid(collection_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, collection_id),
  UNIQUE (merchant_id, handle)
) STRICT;
CREATE TABLE IF NOT EXISTS collection_member (
  merchant_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (merchant_id, collection_id, product_id),
  FOREIGN KEY (merchant_id, collection_id)
    REFERENCES collection (merchant_id, collection_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS collection_member_order
  ON collection_member (merchant_id, collection_id, position);
CREATE INDEX IF NOT EXISTS collection_member_product
  ON collection_member (merchant_id, product_id);`;
