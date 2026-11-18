-- Plan 79 phase 2: adds the Vault store choice (1Password) and the Vault
-- audit log. Apply to each deployed regional database (and a local combined
-- database) before the release that serves the store routes. The statements
-- are safe to repeat.
CREATE TABLE IF NOT EXISTS vault_store (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation (organisation_id),
  store TEXT NOT NULL CHECK (store = 'onepassword'),
  onepassword_vault_id TEXT NOT NULL CHECK (length(onepassword_vault_id) = 26),
  onepassword_vault_title TEXT NOT NULL CHECK (length(onepassword_vault_title) BETWEEN 1 AND 200),
  token_handle TEXT NOT NULL,
  connected_by_user_id TEXT NOT NULL,
  connected_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_item_event (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  event_id TEXT NOT NULL CHECK (length(event_id) = 32),
  kind TEXT NOT NULL CHECK (kind IN ('item_added', 'item_edited', 'sign_in_replaced', 'item_removed', 'item_moved', 'store_connected', 'store_disconnected')),
  item_id TEXT,
  item_label TEXT,
  store TEXT NOT NULL CHECK (store IN ('satyr', 'onepassword')),
  actor_user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (organisation_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_vault_item_event_item ON vault_item_event (organisation_id, item_id, at);
