-- Plan 77 step 8: adds Satyr's webhook subscription to each Underclerk
-- merchant. Apply to each deployed regional database (and a local combined
-- database) before the release that subscribes. The statement is safe to
-- repeat.
CREATE TABLE IF NOT EXISTS underclerk_webhook_subscription (
  binding_id TEXT PRIMARY KEY REFERENCES underclerk_merchant_binding (binding_id),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  subscription_id TEXT NOT NULL CHECK (length(subscription_id) > 0),
  sealed_secret TEXT NOT NULL CHECK (length(sealed_secret) > 0),
  read_queued_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
