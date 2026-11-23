-- One-time upgrade for databases created before Plan 29's authorization product.
-- Check PRAGMA table_info(provider_connection) before applying; SQLite ALTER
-- TABLE ADD COLUMN cannot be repeated. Existing scope parsing handles standard.
ALTER TABLE provider_connection ADD COLUMN authorization_product TEXT NOT NULL
  DEFAULT 'standard' CHECK (
    authorization_product IN ('standard', 'full_mailbox_pilot', 'send_only')
    AND (provider = 'gmail' OR authorization_product = 'standard')
  );
