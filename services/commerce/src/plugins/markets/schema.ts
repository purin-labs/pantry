// The tables of the markets built-in plugin (Plan 77 step 6). The core
// schema builds them in its fixed order; only this plugin's code names them.
// Markets: a currency and its prices for some countries and storefronts.
export const MARKET_SCHEMA = `
CREATE TABLE IF NOT EXISTS market (
  merchant_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  market_json TEXT NOT NULL CHECK (json_valid(market_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, market_id)
) STRICT;`;
