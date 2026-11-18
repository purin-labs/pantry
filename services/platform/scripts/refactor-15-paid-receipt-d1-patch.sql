-- Refactor 15, refactor 12: paid-order Slack receipts leave the shop's feed.
-- Adds table paid_receipt and its index paid_receipt_due. The feed records a
-- receipt there and moves on to the next event; the every-minute pass sends
-- each due receipt.
-- Apply to each deployed REGIONAL database (and a local combined database)
-- before the release that writes it:
--   wrangler d1 execute <regional database> --env production --remote --file services/platform/scripts/refactor-15-paid-receipt-d1-patch.sql
-- Both statements are safe to repeat.
CREATE TABLE IF NOT EXISTS paid_receipt (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  receipt_id TEXT NOT NULL CHECK (length(receipt_id) > 0),
  order_id TEXT NOT NULL CHECK (length(order_id) > 0),
  connector_id TEXT NOT NULL CHECK (length(connector_id) > 0),
  delivery_json TEXT NOT NULL CHECK (json_valid(delivery_json)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'abandoned')),
  failure_reason TEXT,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  next_attempt_at INTEGER,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  PRIMARY KEY (organisation_id, receipt_id),
  CHECK ((state IN ('pending', 'failed')) = (next_attempt_at IS NOT NULL)),
  CHECK ((state IN ('failed', 'abandoned')) = (failure_reason IS NOT NULL)),
  CHECK ((state = 'sent') = (sent_at IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS paid_receipt_due
ON paid_receipt (next_attempt_at, organisation_id)
WHERE state IN ('pending', 'failed');
