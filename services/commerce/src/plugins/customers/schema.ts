// The tables of the customers built-in plugin (Plan 77 step 6). The core
// schema builds them in its fixed order; only this plugin's code names them.
// Customer accounts. Personal fields live only in sealed_profile, sealed
// with the customer's own key; erasure deletes that key and the lookup value.
// Links, consent state and notification receipts hold no personal fields.
// Customer accounts. Personal fields live only in sealed_profile, sealed
// with the customer's own key; erasure deletes that key and the lookup value.
// Links, consent state and notification receipts hold no personal fields.
export const CUSTOMER_SCHEMA = `
CREATE TABLE IF NOT EXISTS customer (
  merchant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'erased')),
  email_lookup TEXT,
  sealed_profile TEXT,
  public_json TEXT NOT NULL CHECK (json_valid(public_json)),
  created_at TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, customer_id),
  CHECK (
    (state = 'active' AND email_lookup IS NOT NULL AND sealed_profile IS NOT NULL)
    OR (state = 'erased' AND email_lookup IS NULL AND sealed_profile IS NULL)
  )
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS customer_email
  ON customer (merchant_id, email_lookup) WHERE email_lookup IS NOT NULL;
CREATE TABLE IF NOT EXISTS customer_key (
  merchant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  wrapped_key TEXT NOT NULL,
  PRIMARY KEY (merchant_id, customer_id),
  FOREIGN KEY (merchant_id, customer_id)
    REFERENCES customer (merchant_id, customer_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS customer_link (
  merchant_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('checkout', 'order')),
  subject_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, subject_kind, subject_id),
  FOREIGN KEY (merchant_id, customer_id)
    REFERENCES customer (merchant_id, customer_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS customer_link_customer
  ON customer_link (merchant_id, customer_id, subject_kind);
CREATE TABLE IF NOT EXISTS customer_sign_in (
  merchant_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL,
  storefront_id TEXT NOT NULL,
  email_lookup TEXT NOT NULL,
  code_digest TEXT NOT NULL,
  sealed_message TEXT,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, challenge_id)
) STRICT;
`;
