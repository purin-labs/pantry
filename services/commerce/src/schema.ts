import type { CommerceDatabase } from "./database.ts";
import {
  ENTITY_PLANE_CHANGE_SCHEMA,
  initializeEntityPlaneSchema,
} from "./entity-plane/schema.ts";
import { DRAFT_ORDER_SCHEMA } from "./plugins/draft-orders/index.ts";
import { ORDER_RETURN_SCHEMA } from "./plugins/returns/index.ts";
import { CUSTOMER_SCHEMA } from "./plugins/customers/index.ts";
import { COLLECTION_SCHEMA } from "./plugins/collections/index.ts";
import { DISCOUNT_SCHEMA } from "./plugins/discounts/index.ts";
import { MARKET_SCHEMA } from "./plugins/markets/index.ts";
import { COMPANY_SCHEMA } from "./plugins/companies/index.ts";
import { MEDIA_SCHEMA } from "./plugins/media/index.ts";
import { STORED_VALUE_SCHEMA } from "./plugins/stored-value/index.ts";
import { FOOD_SERVICE_SCHEMA } from "./plugins/food-service/index.ts";

const SCHEMA_VERSION = 91;

// Schema 86: a delivery whose event was archived is `gone` (Refactor 15).
// SQLite cannot change a CHECK, so the delivery table is rebuilt with its
// rows; nothing refers to it. The DDL is frozen here.
const WEBHOOK_DELIVERY_GONE_SCHEMA_V86 = `ALTER TABLE webhook_delivery RENAME TO webhook_delivery_v85;
DROP INDEX IF EXISTS webhook_delivery_due;
CREATE TABLE webhook_delivery (
  merchant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  merchant_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'dead', 'gone')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  first_attempt_at TEXT,
  next_attempt_at TEXT NOT NULL,
  last_status INTEGER,
  delivered_at TEXT,
  PRIMARY KEY (merchant_id, subscription_id, event_id),
  FOREIGN KEY (merchant_id, subscription_id)
    REFERENCES webhook_subscription (merchant_id, subscription_id) ON DELETE CASCADE
) STRICT;
INSERT INTO webhook_delivery (
  merchant_id, subscription_id, event_id, merchant_revision, status, attempts,
  first_attempt_at, next_attempt_at, last_status, delivered_at
)
SELECT merchant_id, subscription_id, event_id, merchant_revision, status,
       attempts, first_attempt_at, next_attempt_at, last_status, delivered_at
FROM webhook_delivery_v85 ORDER BY rowid;
DROP TABLE webhook_delivery_v85;
CREATE INDEX webhook_delivery_due
  ON webhook_delivery (next_attempt_at) WHERE status = 'pending';`;

// Schema 87: a Square connection keeps the scopes that Square granted and why
// it stopped working (Refactor 15). A connection made before has no known
// scopes and stays connected until Square answers otherwise.
const SQUARE_CONNECTION_STATE_V87 = `ALTER TABLE square_connection ADD COLUMN state TEXT NOT NULL DEFAULT 'connected'
  CHECK (state IN ('connected', 'scope_missing', 'refresh_failed', 'revoked'));
ALTER TABLE square_connection ADD COLUMN scopes_json TEXT
  CHECK (scopes_json IS NULL OR json_valid(scopes_json));`;

// A capture with no order is a staff item (Refactor 15, refactor 10), and the
// payment pass reads the checkouts that wait for their payment.
const CAPTURE_UNPLACED_SCHEMA = `CREATE TABLE checkout_capture_unplaced (
  merchant_id TEXT NOT NULL REFERENCES merchant (merchant_id),
  payment_attempt_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle_state TEXT NOT NULL
    CHECK (lifecycle_state IN ('capture_unplaced', 'resolved')),
  opened_at TEXT NOT NULL,
  capture_json TEXT NOT NULL CHECK (json_valid(capture_json)),
  PRIMARY KEY (merchant_id, payment_attempt_id)
) STRICT;
CREATE INDEX buyer_checkout_payment_pending
ON buyer_checkout (merchant_id, checkout_id)
WHERE lifecycle_state = 'payment_pending';`;

// Schema 88: the same tables for a database at schema 87. The DDL is frozen
// here.
const CAPTURE_UNPLACED_SCHEMA_V88 = `CREATE TABLE checkout_capture_unplaced (
  merchant_id TEXT NOT NULL REFERENCES merchant (merchant_id),
  payment_attempt_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle_state TEXT NOT NULL
    CHECK (lifecycle_state IN ('capture_unplaced', 'resolved')),
  opened_at TEXT NOT NULL,
  capture_json TEXT NOT NULL CHECK (json_valid(capture_json)),
  PRIMARY KEY (merchant_id, payment_attempt_id)
) STRICT;
CREATE INDEX buyer_checkout_payment_pending
ON buyer_checkout (merchant_id, checkout_id)
WHERE lifecycle_state = 'payment_pending';`;

// Schema 89: a credential has one state and knows the credential that issued
// it, an app installed again after a revoke gets a new token, and a merchant
// whose Organisation ended is closed (Refactor 15, refactor 11). A credential
// that was revoked before is `revoked`. The DDL is frozen here.
const CREDENTIAL_LIFECYCLE_V89 = `ALTER TABLE api_credential ADD COLUMN state TEXT NOT NULL DEFAULT 'active'
  CHECK (state IN ('active', 'revoked', 'expired'));
ALTER TABLE api_credential ADD COLUMN revoked_by TEXT;
ALTER TABLE api_credential ADD COLUMN expires_at TEXT;
ALTER TABLE api_credential ADD COLUMN parent_credential_id TEXT;
ALTER TABLE api_credential ADD COLUMN install_nonce TEXT;
UPDATE api_credential SET state = 'revoked', revoked_by = 'operator'
WHERE revoked_at IS NOT NULL;
CREATE INDEX api_credential_children
ON api_credential (merchant_id, parent_credential_id)
WHERE parent_credential_id IS NOT NULL;
CREATE TABLE merchant_closure (
  merchant_id TEXT PRIMARY KEY REFERENCES merchant (merchant_id),
  closed_at TEXT NOT NULL,
  closure_json TEXT NOT NULL CHECK (json_valid(closure_json))
) STRICT;`;

const BANK_PAYOUT_SCHEMA_V85 = `CREATE TABLE bank_payout (
  merchant_id TEXT NOT NULL REFERENCES merchant (merchant_id),
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'square')),
  provider_payout_id TEXT NOT NULL,
  provider_account TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('on_its_way', 'arrived', 'failed', 'cancelled')),
  arrival_date TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  sales_read INTEGER NOT NULL CHECK (sales_read IN (0, 1)),
  sales_from TEXT,
  sales_to TEXT,
  read_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, provider, provider_payout_id)
) STRICT;
CREATE INDEX bank_payout_by_arrival
ON bank_payout (merchant_id, arrival_date);`;

const FAILED_PAYMENT_INDEXES_V84 = `CREATE INDEX checkout_payment_attempt_state
ON checkout_payment_attempt (merchant_id, lifecycle_state);
CREATE INDEX buyer_checkout_session
ON buyer_checkout (merchant_id, buyer_session_digest)
WHERE buyer_session_digest IS NOT NULL;`;

// The alarm's lot_expiry pass reads the lots whose expiry passed while they
// still count on hand (Refactor 15, refactor 7).
const STOCK_LOT_EXPIRY_INDEX = `CREATE INDEX stock_lot_expiry
ON stock_lot (expires_at)
WHERE expiry_kind = 'expires' AND remaining_amount > 0
  AND lifecycle IN ('available', 'expired');`;

// Schema 90's own copy, frozen when it shipped.
const STOCK_LOT_EXPIRY_INDEX_V90 = `CREATE INDEX stock_lot_expiry
ON stock_lot (expires_at)
WHERE expiry_kind = 'expires' AND remaining_amount > 0
  AND lifecycle IN ('available', 'expired');`;

const STOCK_LOT_USABLE_INDEX_V82 = `CREATE INDEX stock_lot_usable
ON stock_lot (merchant_id, inventory_item_id, location_id)
WHERE lifecycle = 'available';`;

const MENU_SOLD_OUT_MARK_V83 = `CREATE TABLE menu_sold_out_mark (
  merchant_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  sold_out_until TEXT,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, location_id, variant_id),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;`;

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migration (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;`;

const SHIPPING_CONFIGURATION_SCHEMA = `
CREATE TABLE shipping_profile (
  merchant_id TEXT NOT NULL,
  shipping_profile_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  origin_location_id TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'inactive')),
  profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
  PRIMARY KEY (merchant_id, shipping_profile_id),
  UNIQUE (merchant_id, shipping_profile_id, revision),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE,
  FOREIGN KEY (merchant_id, origin_location_id)
    REFERENCES location (merchant_id, resource_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE variant_shipping_specification (
  merchant_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  variant_revision INTEGER NOT NULL CHECK (variant_revision > 0),
  shipping_profile_id TEXT NOT NULL,
  shipping_profile_revision INTEGER NOT NULL CHECK (shipping_profile_revision > 0),
  eligibility_kind TEXT NOT NULL CHECK (eligibility_kind IN ('prohibited', 'physical')),
  specification_json TEXT NOT NULL CHECK (json_valid(specification_json)),
  PRIMARY KEY (merchant_id, variant_id, variant_revision),
  FOREIGN KEY (merchant_id, variant_id)
    REFERENCES sellable_variant (merchant_id, resource_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, shipping_profile_id, shipping_profile_revision)
    REFERENCES shipping_profile (merchant_id, shipping_profile_id, revision) ON DELETE RESTRICT
) STRICT;`;

const NORMALIZED_STOCK_LEDGER_SCHEMA = `
CREATE TABLE stock_movement (
  merchant_id TEXT NOT NULL,
  movement_id TEXT NOT NULL,
  inventory_item_id TEXT NOT NULL,
  inventory_position_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('increase', 'decrease')),
  quantity_amount INTEGER NOT NULL CHECK (quantity_amount >= 0),
  quantity_scale INTEGER NOT NULL CHECK (quantity_scale BETWEEN 0 AND 6),
  quantity_unit TEXT NOT NULL CHECK (
    quantity_unit IN ('each', 'gram', 'kilogram', 'milliliter', 'liter')
  ),
  reason_kind TEXT NOT NULL CHECK (
    reason_kind IN ('receipt', 'production', 'sale', 'preparation', 'stock_count', 'correction', 'waste', 'damage')
  ),
  reason_json TEXT CHECK (reason_json IS NULL OR json_valid(reason_json)),
  receipt_id TEXT,
  receipt_line_id TEXT,
  production_batch_id TEXT,
  order_id TEXT,
  order_line_id TEXT,
  preparation_ticket_id TEXT,
  recipe_revision INTEGER CHECK (recipe_revision > 0),
  occurred_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  PRIMARY KEY (merchant_id, movement_id),
  UNIQUE (merchant_id, idempotency_key),
  UNIQUE (merchant_id, receipt_id, receipt_line_id),
  FOREIGN KEY (merchant_id, inventory_item_id)
    REFERENCES inventory_item (merchant_id, inventory_item_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, inventory_position_id)
    REFERENCES inventory_position (merchant_id, inventory_position_id) ON DELETE RESTRICT,
  CHECK (quantity_unit != 'each' OR quantity_scale = 0),
  CHECK (quantity_amount > 0 OR (reason_kind = 'stock_count' AND direction = 'increase')),
  CHECK (
    (reason_kind = 'receipt' AND direction = 'increase' AND
      receipt_id IS NOT NULL AND receipt_line_id IS NOT NULL AND
      production_batch_id IS NULL AND order_id IS NULL AND order_line_id IS NULL AND
      preparation_ticket_id IS NULL AND recipe_revision IS NULL AND reason_json IS NOT NULL) OR
    (reason_kind = 'production' AND direction IN ('increase', 'decrease') AND
      receipt_id IS NULL AND receipt_line_id IS NULL AND
      production_batch_id IS NOT NULL AND order_id IS NULL AND order_line_id IS NULL AND
      preparation_ticket_id IS NULL AND recipe_revision IS NOT NULL AND reason_json IS NULL) OR
    (reason_kind = 'sale' AND direction = 'decrease' AND
      receipt_id IS NULL AND receipt_line_id IS NULL AND
      production_batch_id IS NULL AND order_id IS NOT NULL AND order_line_id IS NOT NULL AND
      preparation_ticket_id IS NULL AND recipe_revision IS NULL AND reason_json IS NULL) OR
    (reason_kind = 'preparation' AND direction = 'decrease' AND
      receipt_id IS NULL AND receipt_line_id IS NULL AND
      production_batch_id IS NULL AND order_id IS NULL AND order_line_id IS NULL AND
      preparation_ticket_id IS NOT NULL AND recipe_revision IS NOT NULL AND reason_json IS NULL) OR
    (reason_kind IN ('stock_count', 'correction', 'waste', 'damage') AND
      (direction = 'decrease' OR reason_kind IN ('stock_count', 'correction')) AND
      reason_json IS NOT NULL AND json_extract(reason_json, '$.kind') = reason_kind AND
      receipt_id IS NULL AND receipt_line_id IS NULL AND production_batch_id IS NULL AND
      order_id IS NULL AND order_line_id IS NULL AND preparation_ticket_id IS NULL AND recipe_revision IS NULL)
  )
) STRICT;

CREATE TABLE stock_lot (
  merchant_id TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  lot_code TEXT NOT NULL,
  inventory_item_id TEXT NOT NULL,
  inventory_position_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  source_movement_id TEXT NOT NULL,
  received_amount INTEGER NOT NULL CHECK (received_amount > 0),
  remaining_amount INTEGER NOT NULL CHECK (
    remaining_amount >= 0
  ),
  quantity_scale INTEGER NOT NULL CHECK (quantity_scale BETWEEN 0 AND 6),
  quantity_unit TEXT NOT NULL CHECK (
    quantity_unit IN ('each', 'gram', 'kilogram', 'milliliter', 'liter')
  ),
  expiry_kind TEXT NOT NULL CHECK (expiry_kind IN ('not_tracked', 'expires')),
  expires_at TEXT,
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('available', 'depleted', 'quarantined', 'expired')
  ),
  quarantine_reason TEXT,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, lot_id),
  UNIQUE (merchant_id, lot_code),
  UNIQUE (merchant_id, source_movement_id),
  FOREIGN KEY (merchant_id, inventory_item_id)
    REFERENCES inventory_item (merchant_id, inventory_item_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, inventory_position_id)
    REFERENCES inventory_position (merchant_id, inventory_position_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, source_movement_id)
    REFERENCES stock_movement (merchant_id, movement_id) ON DELETE RESTRICT,
  CHECK (quantity_unit != 'each' OR quantity_scale = 0),
  CHECK (
    (expiry_kind = 'not_tracked' AND expires_at IS NULL) OR
    (expiry_kind = 'expires' AND expires_at IS NOT NULL)
  ),
  CHECK (
    (lifecycle = 'quarantined' AND quarantine_reason IS NOT NULL) OR
    (lifecycle != 'quarantined' AND quarantine_reason IS NULL)
  )
) STRICT;

CREATE TABLE stock_movement_lot (
  merchant_id TEXT NOT NULL,
  movement_id TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  quantity_amount INTEGER NOT NULL CHECK (quantity_amount > 0),
  quantity_scale INTEGER NOT NULL CHECK (quantity_scale BETWEEN 0 AND 6),
  quantity_unit TEXT NOT NULL CHECK (
    quantity_unit IN ('each', 'gram', 'kilogram', 'milliliter', 'liter')
  ),
  PRIMARY KEY (merchant_id, movement_id, lot_id),
  FOREIGN KEY (merchant_id, movement_id)
    REFERENCES stock_movement (merchant_id, movement_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, lot_id)
    REFERENCES stock_lot (merchant_id, lot_id) ON DELETE RESTRICT,
  CHECK (quantity_unit != 'each' OR quantity_scale = 0)
) STRICT;`;

const NORMALIZED_INVENTORY_SCHEMA = `
CREATE TABLE inventory_item (
  merchant_id TEXT NOT NULL,
  inventory_item_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  merchant_code TEXT NOT NULL,
  name TEXT NOT NULL,
  base_unit TEXT NOT NULL CHECK (
    base_unit IN ('each', 'gram', 'kilogram', 'milliliter', 'liter')
  ),
  category TEXT NOT NULL CHECK (
    category IN ('ingredient', 'packaging', 'finished_good', 'operating_supply')
  ),
  tracking_kind TEXT NOT NULL CHECK (tracking_kind IN ('aggregate', 'lot_tracked')),
  expiry_policy TEXT CHECK (expiry_policy IN ('required', 'optional')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'inactive')),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, inventory_item_id),
  UNIQUE (merchant_id, merchant_code),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE,
  CHECK (
    (tracking_kind = 'aggregate' AND expiry_policy IS NULL) OR
    (tracking_kind = 'lot_tracked' AND expiry_policy IS NOT NULL)
  )
) STRICT;

CREATE TABLE inventory_position (
  merchant_id TEXT NOT NULL,
  inventory_position_id TEXT NOT NULL,
  inventory_item_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  balance_kind TEXT NOT NULL CHECK (balance_kind IN ('accounted', 'available_only')),
  on_hand_amount INTEGER CHECK (on_hand_amount >= 0),
  allocated_amount INTEGER CHECK (allocated_amount >= 0),
  available_amount INTEGER NOT NULL CHECK (available_amount >= 0),
  quantity_scale INTEGER NOT NULL CHECK (quantity_scale BETWEEN 0 AND 6),
  quantity_unit TEXT NOT NULL CHECK (
    quantity_unit IN ('each', 'gram', 'kilogram', 'milliliter', 'liter')
  ),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, inventory_position_id),
  UNIQUE (merchant_id, inventory_item_id, location_id),
  FOREIGN KEY (merchant_id, inventory_item_id)
    REFERENCES inventory_item (merchant_id, inventory_item_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, location_id)
    REFERENCES location (merchant_id, resource_id) ON DELETE RESTRICT,
  CHECK (
    (balance_kind = 'accounted' AND
      on_hand_amount IS NOT NULL AND allocated_amount IS NOT NULL AND
      allocated_amount <= on_hand_amount AND
      available_amount = on_hand_amount - allocated_amount) OR
    (balance_kind = 'available_only' AND
      on_hand_amount IS NULL AND allocated_amount IS NULL)
  ),
  CHECK (quantity_unit != 'each' OR quantity_scale = 0)
) STRICT;
${NORMALIZED_STOCK_LEDGER_SCHEMA}`;

const CHECKOUT_PROFILE_SCHEMA = `
CREATE TABLE IF NOT EXISTS checkout_profile_revision (
  merchant_id TEXT NOT NULL,
  checkout_profile_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL,
  configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('draft', 'published', 'retired')
  ),
  lifecycle_json TEXT NOT NULL CHECK (json_valid(lifecycle_json)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, checkout_profile_id, revision),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS storefront_checkout_profile_activation (
  merchant_id TEXT NOT NULL,
  storefront_id TEXT NOT NULL,
  checkout_profile_id TEXT NOT NULL,
  checkout_profile_revision INTEGER NOT NULL CHECK (checkout_profile_revision > 0),
  activated_at TEXT NOT NULL,
  activated_by TEXT NOT NULL,
  PRIMARY KEY (merchant_id, storefront_id),
  FOREIGN KEY (merchant_id, storefront_id)
    REFERENCES storefront (merchant_id, storefront_id) ON DELETE CASCADE,
  FOREIGN KEY (merchant_id, checkout_profile_id, checkout_profile_revision)
    REFERENCES checkout_profile_revision (merchant_id, checkout_profile_id, revision)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS checkout_profile_latest_revision
  ON checkout_profile_revision (merchant_id, checkout_profile_id, revision DESC);
`;

const POINT_OF_SALE_CONFIGURATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS point_of_sale_configuration (
  merchant_id TEXT NOT NULL,
  configuration_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  satyr_location_id TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('draft', 'published', 'retired')
  ),
  configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, configuration_id, revision),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;

-- One counter sells under one published policy at a time. Publishing a new
-- revision retires the previous one rather than creating a second authority.
CREATE UNIQUE INDEX IF NOT EXISTS point_of_sale_configuration_published_location
  ON point_of_sale_configuration (merchant_id, satyr_location_id)
  WHERE lifecycle_state = 'published';
`;

const BUYER_CHECKOUT_SCHEMA = `
CREATE TABLE buyer_checkout (
  merchant_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  -- Online and point-of-sale checkouts carry disjoint facts. The columns for
  -- each are nullable so neither channel has to fabricate the other's data,
  -- and the CHECK below makes exactly one set mandatory per row.
  source_kind TEXT NOT NULL CHECK (source_kind IN ('online', 'point_of_sale')),
  storefront_id TEXT,
  cart_id TEXT,
  buyer_session_digest TEXT CHECK (
    buyer_session_digest IS NULL OR (
      length(buyer_session_digest) = 64 AND
      buyer_session_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  satyr_location_id TEXT,
  operator_identity TEXT,
  terminal_assignment_revision INTEGER CHECK (
    terminal_assignment_revision IS NULL OR terminal_assignment_revision > 0
  ),
  point_of_sale_buyer_kind TEXT CHECK (
    point_of_sale_buyer_kind IS NULL OR
    point_of_sale_buyer_kind IN ('anonymous', 'identified_customer')
  ),
  point_of_sale_customer_id TEXT,
  -- What priced the sale is part of the disjoint set, not above it: an online
  -- Checkout pins a published checkout profile, a counter sale pins its own
  -- published point-of-sale configuration. Neither channel carries the other's
  -- as null-because-inapplicable.
  checkout_profile_id TEXT,
  checkout_profile_revision INTEGER CHECK (
    checkout_profile_revision IS NULL OR checkout_profile_revision > 0
  ),
  pos_configuration_revision INTEGER CHECK (
    pos_configuration_revision IS NULL OR pos_configuration_revision > 0
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('quoted', 'payment_pending', 'accepted', 'expired')
  ),
  quote_digest TEXT NOT NULL,
  checkout_json TEXT NOT NULL,
  CHECK (
    (source_kind = 'online'
      AND storefront_id IS NOT NULL AND cart_id IS NOT NULL
      AND buyer_session_digest IS NOT NULL
      AND checkout_profile_id IS NOT NULL
      AND checkout_profile_revision IS NOT NULL
      AND pos_configuration_revision IS NULL
      AND satyr_location_id IS NULL AND operator_identity IS NULL
      AND terminal_assignment_revision IS NULL
      AND point_of_sale_buyer_kind IS NULL AND point_of_sale_customer_id IS NULL)
    OR
    (source_kind = 'point_of_sale'
      AND storefront_id IS NULL AND cart_id IS NULL
      AND buyer_session_digest IS NULL
      AND checkout_profile_id IS NULL AND checkout_profile_revision IS NULL
      AND pos_configuration_revision IS NOT NULL
      AND satyr_location_id IS NOT NULL AND operator_identity IS NOT NULL
      AND point_of_sale_buyer_kind IS NOT NULL
      AND (
        (point_of_sale_buyer_kind = 'anonymous' AND point_of_sale_customer_id IS NULL)
        OR
        (point_of_sale_buyer_kind = 'identified_customer'
          AND point_of_sale_customer_id IS NOT NULL)
      ))
  ),
  PRIMARY KEY (merchant_id, checkout_id),
  UNIQUE (merchant_id, cart_id),
  FOREIGN KEY (merchant_id, storefront_id)
    REFERENCES storefront (merchant_id, storefront_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, cart_id)
    REFERENCES buyer_cart (merchant_id, cart_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, cart_id, buyer_session_digest)
    REFERENCES buyer_cart (merchant_id, cart_id, buyer_session_digest) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, checkout_profile_id, checkout_profile_revision)
    REFERENCES checkout_profile_revision (merchant_id, checkout_profile_id, revision)
    ON DELETE RESTRICT
) STRICT;
`;

const CHECKOUT_PAYMENT_ATTEMPT_SCHEMA = `
CREATE TABLE checkout_payment_attempt (
  merchant_id TEXT NOT NULL,
  payment_attempt_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  checkout_revision INTEGER NOT NULL CHECK (checkout_revision > 0),
  quote_digest TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL,
  payment_provider TEXT NOT NULL CHECK (
    payment_provider IN (
      'stripe_online', 'gmo_pg_online', 'square_online',
      'square_terminal'
    )
  ),
  provider_request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('pending', 'processing', 'captured', 'declined', 'indeterminate')
  ),
  payment_attempt_json TEXT NOT NULL,
  PRIMARY KEY (merchant_id, payment_attempt_id),
  UNIQUE (merchant_id, provider_request_id),
  UNIQUE (merchant_id, idempotency_key),
  FOREIGN KEY (merchant_id, checkout_id)
    REFERENCES buyer_checkout (merchant_id, checkout_id) ON DELETE RESTRICT
) STRICT;
`;

const CHECKOUT_PROFILE_PIN_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS buyer_cart_checkout_profile_insert
BEFORE INSERT ON buyer_cart
WHEN NOT EXISTS (
  SELECT 1 FROM checkout_profile_revision
  WHERE merchant_id = NEW.merchant_id
    AND checkout_profile_id = NEW.checkout_profile_id
    AND revision = NEW.checkout_profile_revision
)
BEGIN
  SELECT RAISE(ABORT, 'cart checkout profile must exist');
END;

CREATE TRIGGER IF NOT EXISTS buyer_cart_checkout_profile_immutable
BEFORE UPDATE OF checkout_profile_id, checkout_profile_revision ON buyer_cart
WHEN OLD.checkout_profile_id != NEW.checkout_profile_id
  OR OLD.checkout_profile_revision != NEW.checkout_profile_revision
BEGIN
  SELECT RAISE(ABORT, 'cart checkout profile cannot change');
END;

CREATE TRIGGER IF NOT EXISTS buyer_checkout_profile_insert
BEFORE INSERT ON buyer_checkout
WHEN NEW.source_kind = 'online' AND NOT EXISTS (
  SELECT 1 FROM buyer_cart
  WHERE merchant_id = NEW.merchant_id
    AND cart_id = NEW.cart_id
    AND checkout_profile_id = NEW.checkout_profile_id
    AND checkout_profile_revision = NEW.checkout_profile_revision
)
BEGIN
  SELECT RAISE(ABORT, 'checkout profile must match cart');
END;

CREATE TRIGGER IF NOT EXISTS buyer_checkout_profile_immutable
BEFORE UPDATE OF checkout_profile_id, checkout_profile_revision ON buyer_checkout
-- IS NOT is null-safe; != would silently pass when either side is NULL, which
-- is exactly the counter-sale case.
WHEN OLD.checkout_profile_id IS NOT NEW.checkout_profile_id
  OR OLD.checkout_profile_revision IS NOT NEW.checkout_profile_revision
BEGIN
  SELECT RAISE(ABORT, 'checkout profile cannot change');
END;
`;

// Schema 51 adds the editable product fields and the offer compare-at price.
const PRODUCT_DETAIL_COLUMNS = `handle TEXT CHECK (handle IS NULL OR length(handle) > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  details_json TEXT NOT NULL DEFAULT '{"productType":"","vendor":"","tags":[]}' CHECK (json_valid(details_json))`;
const PRODUCT_HANDLE_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS product_handle_unique
  ON product (merchant_id, handle) WHERE handle IS NOT NULL;`;
const OFFER_COMPARE_AT_COLUMN = `compare_at_amount_minor INTEGER CHECK (compare_at_amount_minor IS NULL OR compare_at_amount_minor > 0)`;



// An order change: an edit, or a payment that a balance checkout added. The
// order record is the current order; these rows say how it got there.
// An order change: an edit, an exchange or a later payment.
function orderChangeTable(name: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${name} (
  merchant_id TEXT NOT NULL,
  change_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('edit', 'exchange', 'payment')),
  order_revision_before INTEGER NOT NULL CHECK (order_revision_before > 0),
  order_revision_after INTEGER NOT NULL
    CHECK (order_revision_after > order_revision_before),
  payment_id TEXT,
  change_json TEXT NOT NULL CHECK (json_valid(change_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, change_id),
  UNIQUE (merchant_id, order_id, order_revision_before),
  CHECK ((kind = 'payment') = (payment_id IS NOT NULL)),
  FOREIGN KEY (merchant_id, order_id)
    REFERENCES commerce_order (merchant_id, resource_id) ON DELETE RESTRICT
) STRICT;`;
}

const ORDER_CHANGE_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS order_change_payment
  ON order_change (merchant_id, payment_id) WHERE payment_id IS NOT NULL;`;

const ORDER_CHANGE_SCHEMA = `${orderChangeTable("order_change")}${ORDER_CHANGE_INDEX}`;

const NOTIFICATION_OUTBOX_INDEX = `
CREATE INDEX IF NOT EXISTS notification_outbox_pending
  ON notification_outbox (status, created_at) WHERE status = 'pending';`;


// The buyer email outbox: one row for each message to send. The baseline
// builds it right after the customer plugin's tables.
const NOTIFICATION_OUTBOX_SCHEMA = `${notificationOutboxTable("notification_outbox")}${NOTIFICATION_OUTBOX_INDEX}`;

function notificationOutboxTable(name: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${name} (
  merchant_id TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'order_confirmation', 'ready_for_pickup', 'sign_in_code',
      'order_shipped', 'refund_issued'
    )
  ),
  order_id TEXT,
  customer_id TEXT,
  challenge_id TEXT,
  refund_attempt_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'dropped')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  provider_message_id TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  PRIMARY KEY (merchant_id, notification_id)
) STRICT;`;
}


// Webhook subscriptions and their deliveries. Each subscription reads the
// event feed with its own cursor; a delivery row tracks one event's posts.
// After a secret rotation the previous secret also signs posts until it
// expires (schema 72).
const WEBHOOK_SCHEMA = `
CREATE TABLE IF NOT EXISTS webhook_subscription (
  merchant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  url TEXT NOT NULL CHECK (url LIKE 'https://%'),
  topics_json TEXT NOT NULL CHECK (json_valid(topics_json)),
  secret TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'failing')),
  cursor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  previous_secret TEXT,
  previous_secret_expires_at TEXT,
  PRIMARY KEY (merchant_id, subscription_id)
) STRICT;
CREATE TABLE IF NOT EXISTS webhook_delivery (
  merchant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  merchant_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'dead', 'gone')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  first_attempt_at TEXT,
  next_attempt_at TEXT NOT NULL,
  last_status INTEGER,
  delivered_at TEXT,
  PRIMARY KEY (merchant_id, subscription_id, event_id),
  FOREIGN KEY (merchant_id, subscription_id)
    REFERENCES webhook_subscription (merchant_id, subscription_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS webhook_delivery_due
  ON webhook_delivery (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS observation_outbox_feed
  ON observation_outbox (merchant_id, merchant_revision, delivery_id);
CREATE INDEX IF NOT EXISTS command_receipt_delivery
  ON command_receipt (merchant_id, json_extract(receipt_json, '$.deliveryId'));`;

// The archive in R2. A file never changes once written; an entry says where
// one archived record lives in it. Archived records never come back.
const ARCHIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS archive_file (
  merchant_id TEXT NOT NULL,
  file_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('orders', 'events')),
  month TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  records INTEGER NOT NULL CHECK (records > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, file_key),
  UNIQUE (merchant_id, kind, month, sequence)
) STRICT;
CREATE TABLE IF NOT EXISTS archive_entry (
  merchant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('order', 'event')),
  record_id TEXT NOT NULL,
  file_key TEXT NOT NULL,
  offset INTEGER NOT NULL CHECK (offset >= 0),
  length INTEGER NOT NULL CHECK (length > 0),
  sha256 TEXT NOT NULL,
  merchant_revision INTEGER,
  archived_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, kind, record_id),
  FOREIGN KEY (merchant_id, file_key)
    REFERENCES archive_file (merchant_id, file_key) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS archive_entry_events
  ON archive_entry (merchant_id, kind, merchant_revision, record_id);`;



// Admin API credentials (Plan 76 phase 2): API keys that the operator issued
// and app installations, each for this merchant only. Only a SHA-256 of the
// secret is kept.
const API_CREDENTIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS api_credential (
  merchant_id TEXT NOT NULL REFERENCES merchant (merchant_id),
  credential_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('api_key', 'app_installation')),
  app_id TEXT,
  external_reference TEXT,
  label TEXT NOT NULL,
  secret_sha256 TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'revoked', 'expired')),
  revoked_by TEXT,
  expires_at TEXT,
  parent_credential_id TEXT,
  install_nonce TEXT,
  PRIMARY KEY (merchant_id, credential_id),
  CHECK ((kind = 'app_installation') = (app_id IS NOT NULL)),
  CHECK ((kind = 'app_installation') = (external_reference IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS api_credential_children
ON api_credential (merchant_id, parent_credential_id)
WHERE parent_credential_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS merchant_closure (
  merchant_id TEXT PRIMARY KEY REFERENCES merchant (merchant_id),
  closed_at TEXT NOT NULL,
  closure_json TEXT NOT NULL CHECK (json_valid(closure_json))
) STRICT;`;

// Payments that Commerce runs itself (Plan 76 phase 3): each merchant's
// connected Stripe account and its checkout payment binding, the
// PaymentIntent of each payment attempt, and the buyer that a payment's
// order is for, so a provider notification can place the order without the
// buyer's session.
const PAYMENT_PROVIDER_SCHEMA = `
CREATE TABLE IF NOT EXISTS payment_provider_account (
  merchant_id TEXT NOT NULL REFERENCES merchant (merchant_id),
  payment_provider_binding_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('stripe')),
  provider_account_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  country TEXT NOT NULL,
  currency TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('onboarding', 'active', 'restricted')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, payment_provider_binding_id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS payment_provider_account_by_account
ON payment_provider_account (merchant_id, provider, provider_account_id);
CREATE TABLE IF NOT EXISTS stripe_payment_intent (
  merchant_id TEXT NOT NULL REFERENCES merchant (merchant_id),
  payment_attempt_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, payment_attempt_id)
) STRICT;
CREATE TABLE IF NOT EXISTS checkout_payment_settlement (
  merchant_id TEXT NOT NULL REFERENCES merchant (merchant_id),
  payment_attempt_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  buyer_json TEXT NOT NULL CHECK (json_valid(buyer_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, payment_attempt_id)
) STRICT;`;

// Square payments that Commerce runs itself (Plan 77 step 8): each
// merchant's connected Square location with its sealed tokens, the online
// payment of each payment attempt, and the Terminal checkout of each counter
// payment attempt. An online payment keeps the buyer's one-time source token
// until Square answers, so a lost answer is asked for again under the same
// idempotency key.
const SQUARE_PAYMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS square_connection (
  merchant_id TEXT PRIMARY KEY REFERENCES merchant (merchant_id),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  application_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  business_name TEXT,
  country TEXT,
  currency TEXT,
  sealed_access_token TEXT NOT NULL,
  sealed_refresh_token TEXT,
  token_expires_at TEXT,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'connected'
    CHECK (state IN ('connected', 'scope_missing', 'refresh_failed', 'revoked')),
  scopes_json TEXT CHECK (scopes_json IS NULL OR json_valid(scopes_json))
) STRICT;
CREATE TABLE IF NOT EXISTS square_payment_account (
  merchant_id TEXT NOT NULL REFERENCES merchant (merchant_id),
  payment_provider_binding_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  country TEXT NOT NULL,
  currency TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, payment_provider_binding_id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS square_payment_account_by_location
ON square_payment_account (merchant_id, location_id);
CREATE TABLE IF NOT EXISTS square_payment (
  merchant_id TEXT NOT NULL REFERENCES merchant (merchant_id),
  payment_attempt_id TEXT NOT NULL,
  payment_provider_binding_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  source_token TEXT,
  payment_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, payment_attempt_id),
  CHECK ((source_token IS NULL) != (payment_id IS NULL))
) STRICT;
CREATE TABLE IF NOT EXISTS square_terminal_checkout (
  merchant_id TEXT NOT NULL REFERENCES merchant (merchant_id),
  payment_attempt_id TEXT NOT NULL,
  payment_provider_binding_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'card' CHECK (
    payment_method IN ('card', 'felica', 'qr_code')
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, payment_attempt_id)
) STRICT;`;

// Schema 75 as it was made. Migration 75 must keep creating these tables, and
// migration 81 then rebuilds them. A migration that used the current text
// would create the tables of schema 81 first and fail at step 81 on a
// database older than 75.
const SQUARE_PAYMENT_SCHEMA_V75 = `
CREATE TABLE IF NOT EXISTS square_payment_account (
  merchant_id TEXT NOT NULL REFERENCES merchant (merchant_id),
  payment_provider_binding_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  country TEXT NOT NULL,
  currency TEXT NOT NULL,
  sealed_access_token TEXT NOT NULL,
  sealed_refresh_token TEXT,
  token_expires_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, payment_provider_binding_id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS square_payment_account_by_location
ON square_payment_account (merchant_id, location_id);
CREATE TABLE IF NOT EXISTS square_payment (
  merchant_id TEXT NOT NULL REFERENCES merchant (merchant_id),
  payment_attempt_id TEXT NOT NULL,
  payment_provider_binding_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  source_token TEXT,
  payment_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, payment_attempt_id),
  CHECK ((source_token IS NULL) != (payment_id IS NULL))
) STRICT;
CREATE TABLE IF NOT EXISTS square_terminal_checkout (
  merchant_id TEXT NOT NULL REFERENCES merchant (merchant_id),
  payment_attempt_id TEXT NOT NULL,
  payment_provider_binding_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, payment_attempt_id)
) STRICT;`;

// Event feed readers and their cursors (Plan 76 phase 4).
const FEED_CONSUMER_SCHEMA = `
CREATE TABLE IF NOT EXISTS feed_consumer (
  merchant_id TEXT NOT NULL REFERENCES merchant (merchant_id),
  consumer_id TEXT NOT NULL,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, consumer_id)
) STRICT;`;



const NORMALIZED_COMMERCE_SCHEMA = `
CREATE TABLE location (
  merchant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('store', 'warehouse', 'fulfillment_center', 'pickup_point')
  ),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'inactive')),
  lifecycle_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, resource_id),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE sales_channel (
  merchant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('online', 'point_of_sale', 'marketplace', 'agent')),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'inactive')),
  lifecycle_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, resource_id),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE product (
  merchant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  ${PRODUCT_DETAIL_COLUMNS},
  PRIMARY KEY (merchant_id, resource_id),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;
${PRODUCT_HANDLE_INDEX}

CREATE TABLE sellable_variant (
  merchant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  product_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, resource_id),
  UNIQUE (merchant_id, sku),
  FOREIGN KEY (merchant_id, product_id)
    REFERENCES product (merchant_id, resource_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE offer (
  merchant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  variant_id TEXT NOT NULL,
  sales_channel_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL,
  availability_state TEXT NOT NULL CHECK (
    availability_state IN ('available', 'unavailable', 'backordered')
  ),
  availability_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('prepared', 'listed', 'archived')
  ),
  lifecycle_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  ${OFFER_COMPARE_AT_COLUMN},
  PRIMARY KEY (merchant_id, resource_id),
  UNIQUE (merchant_id, variant_id, sales_channel_id),
  FOREIGN KEY (merchant_id, variant_id)
    REFERENCES sellable_variant (merchant_id, resource_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, sales_channel_id)
    REFERENCES sales_channel (merchant_id, resource_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE commerce_order (
  merchant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  sales_channel_id TEXT NOT NULL,
  origin_kind TEXT NOT NULL CHECK (
    origin_kind IN ('online', 'point_of_sale', 'marketplace', 'agent')
  ),
  buyer_kind TEXT NOT NULL CHECK (buyer_kind IN ('guest', 'identified')),
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN (
      'pending_confirmation', 'confirmed', 'fulfillment_pending',
      'partially_fulfilled', 'fulfilled', 'cancelled'
    )
  ),
  order_snapshot_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, resource_id),
  FOREIGN KEY (merchant_id, sales_channel_id)
    REFERENCES sales_channel (merchant_id, resource_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE payment (
  merchant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  order_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN (
      'pending', 'authorized', 'captured', 'failed', 'partially_refunded', 'refunded'
    )
  ),
  payment_snapshot_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, resource_id),
  FOREIGN KEY (merchant_id, order_id)
    REFERENCES commerce_order (merchant_id, resource_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE fulfillment (
  merchant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  order_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  fulfillment_kind TEXT NOT NULL CHECK (
    fulfillment_kind IN (
      'shipping', 'pickup', 'local_delivery', 'immediate_handoff', 'on_premise'
    )
  ),
  lifecycle_state TEXT NOT NULL CHECK (
    (fulfillment_kind = 'shipping' AND lifecycle_state IN (
      'requested', 'preparing', 'blocked', 'handed_to_carrier', 'cancelled'
    )) OR
    (fulfillment_kind = 'pickup' AND lifecycle_state IN (
      'requested', 'preparing', 'blocked', 'ready_for_pickup', 'completed', 'cancelled'
    )) OR
    (fulfillment_kind = 'local_delivery' AND lifecycle_state IN (
      'requested', 'preparing', 'blocked', 'completed', 'cancelled'
    )) OR
    (fulfillment_kind = 'immediate_handoff' AND lifecycle_state IN (
      'requested', 'completed', 'cancelled'
    )) OR
    (fulfillment_kind = 'on_premise' AND lifecycle_state IN (
      'requested', 'preparing', 'blocked', 'completed', 'cancelled'
    ))
  ),
  fulfillment_snapshot_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, resource_id),
  FOREIGN KEY (merchant_id, order_id)
    REFERENCES commerce_order (merchant_id, resource_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, location_id)
    REFERENCES location (merchant_id, resource_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE shipment (
  merchant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  order_id TEXT NOT NULL,
  fulfillment_id TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN (
      'ready', 'label_purchased', 'label_created', 'in_transit',
      'delivery_exception', 'delivered', 'returned'
    )
  ),
  shipment_snapshot_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, resource_id),
  FOREIGN KEY (merchant_id, order_id)
    REFERENCES commerce_order (merchant_id, resource_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, fulfillment_id)
    REFERENCES fulfillment (merchant_id, resource_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE storefront (
  merchant_id TEXT NOT NULL,
  storefront_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL,
  sales_channel_id TEXT NOT NULL,
  fulfillment_kind TEXT NOT NULL CHECK (fulfillment_kind IN ('pickup', 'shipping')),
  fulfillment_json TEXT NOT NULL,
  checkout_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'inactive')),
  lifecycle_json TEXT NOT NULL,
  PRIMARY KEY (merchant_id, storefront_id),
  FOREIGN KEY (merchant_id, sales_channel_id)
    REFERENCES sales_channel (merchant_id, resource_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE inventory_consumption_plan (
  merchant_id TEXT NOT NULL,
  consumption_plan_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('organisation', 'location')),
  scope_location_id TEXT,
  mode_kind TEXT NOT NULL CHECK (mode_kind IN ('untracked', 'direct', 'prepared')),
  direct_commit_on TEXT CHECK (
    direct_commit_on IN ('order_placed', 'fulfillment_started', 'fulfillment_completed')
  ),
  recipe_id TEXT,
  recipe_revision INTEGER CHECK (recipe_revision > 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'inactive')),
  PRIMARY KEY (merchant_id, consumption_plan_id),
  FOREIGN KEY (merchant_id, variant_id)
    REFERENCES sellable_variant (merchant_id, resource_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, scope_location_id)
    REFERENCES location (merchant_id, resource_id) ON DELETE RESTRICT,
  CHECK (
    (scope_kind = 'organisation' AND scope_location_id IS NULL) OR
    (scope_kind = 'location' AND scope_location_id IS NOT NULL)
  ),
  CHECK (
    (mode_kind = 'untracked' AND direct_commit_on IS NULL AND
      recipe_id IS NULL AND recipe_revision IS NULL) OR
    (mode_kind = 'direct' AND direct_commit_on IS NOT NULL AND
      recipe_id IS NULL AND recipe_revision IS NULL) OR
    (mode_kind = 'prepared' AND direct_commit_on IS NULL AND
      recipe_id IS NOT NULL AND recipe_revision IS NOT NULL)
  )
) STRICT;

CREATE TABLE inventory_consumption_requirement (
  merchant_id TEXT NOT NULL,
  consumption_plan_id TEXT NOT NULL,
  inventory_item_id TEXT NOT NULL,
  quantity_amount INTEGER NOT NULL CHECK (quantity_amount > 0),
  quantity_scale INTEGER NOT NULL CHECK (quantity_scale BETWEEN 0 AND 6),
  quantity_unit TEXT NOT NULL CHECK (
    quantity_unit IN ('each', 'gram', 'kilogram', 'milliliter', 'liter')
  ),
  PRIMARY KEY (merchant_id, consumption_plan_id, inventory_item_id),
  FOREIGN KEY (merchant_id, consumption_plan_id)
    REFERENCES inventory_consumption_plan (merchant_id, consumption_plan_id)
    ON DELETE CASCADE,
  FOREIGN KEY (merchant_id, inventory_item_id)
    REFERENCES inventory_item (merchant_id, inventory_item_id) ON DELETE RESTRICT,
  CHECK (quantity_unit != 'each' OR quantity_scale = 0)
) STRICT;

CREATE TABLE buyer_cart (
  merchant_id TEXT NOT NULL,
  cart_id TEXT NOT NULL,
  storefront_id TEXT NOT NULL,
  checkout_profile_id TEXT NOT NULL,
  checkout_profile_revision INTEGER NOT NULL CHECK (checkout_profile_revision > 0),
  buyer_session_digest TEXT NOT NULL CHECK (
    length(buyer_session_digest) = 64 AND
    buyer_session_digest NOT GLOB '*[^0-9a-f]*'
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'submitted')),
  lifecycle_json TEXT NOT NULL,
  PRIMARY KEY (merchant_id, cart_id),
  UNIQUE (merchant_id, cart_id, buyer_session_digest),
  UNIQUE (merchant_id, cart_id, checkout_profile_id, checkout_profile_revision),
  FOREIGN KEY (merchant_id, storefront_id)
    REFERENCES storefront (merchant_id, storefront_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, checkout_profile_id, checkout_profile_revision)
    REFERENCES checkout_profile_revision (merchant_id, checkout_profile_id, revision)
    ON DELETE RESTRICT
) STRICT;

CREATE TABLE buyer_cart_line (
  merchant_id TEXT NOT NULL,
  cart_id TEXT NOT NULL,
  cart_line_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  quantity_amount INTEGER NOT NULL CHECK (quantity_amount > 0),
  quantity_scale INTEGER NOT NULL CHECK (quantity_scale = 0),
  quantity_unit TEXT NOT NULL CHECK (quantity_unit = 'each'),
  PRIMARY KEY (merchant_id, cart_id, cart_line_id),
  FOREIGN KEY (merchant_id, cart_id)
    REFERENCES buyer_cart (merchant_id, cart_id) ON DELETE CASCADE,
  FOREIGN KEY (merchant_id, variant_id)
    REFERENCES sellable_variant (merchant_id, resource_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS buyer_cart_command_receipt (
  merchant_id TEXT NOT NULL,
  buyer_session_digest TEXT NOT NULL CHECK (
    length(buyer_session_digest) = 64 AND
    buyer_session_digest NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create', 'replace')),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND
    request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  cart_id TEXT NOT NULL,
  cart_json TEXT NOT NULL CHECK (json_valid(cart_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, buyer_session_digest, idempotency_key),
  FOREIGN KEY (merchant_id, cart_id, buyer_session_digest)
    REFERENCES buyer_cart (merchant_id, cart_id, buyer_session_digest) ON DELETE CASCADE
) STRICT;

${BUYER_CHECKOUT_SCHEMA}

${POINT_OF_SALE_CONFIGURATION_SCHEMA}

${CHECKOUT_PAYMENT_ATTEMPT_SCHEMA}

CREATE TABLE inventory_allocation (
  merchant_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  inventory_item_id TEXT NOT NULL,
  inventory_position_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  quantity_amount INTEGER NOT NULL CHECK (quantity_amount > 0),
  quantity_scale INTEGER NOT NULL CHECK (quantity_scale BETWEEN 0 AND 6),
  quantity_unit TEXT NOT NULL CHECK (
    quantity_unit IN ('each', 'gram', 'kilogram', 'milliliter', 'liter')
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('held', 'allocated_to_order', 'committed', 'released', 'expired')
  ),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('checkout', 'order')),
  owner_id TEXT NOT NULL,
  owner_line_id TEXT NOT NULL,
  allocation_json TEXT NOT NULL,
  PRIMARY KEY (merchant_id, allocation_id),
  FOREIGN KEY (merchant_id, inventory_item_id)
    REFERENCES inventory_item (merchant_id, inventory_item_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, inventory_position_id)
    REFERENCES inventory_position (merchant_id, inventory_position_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, location_id)
    REFERENCES location (merchant_id, resource_id) ON DELETE RESTRICT,
  CHECK (quantity_unit != 'each' OR quantity_scale = 0)
) STRICT;`;

const AFTER_SALE_SCHEMA = `
CREATE TABLE IF NOT EXISTS refund_attempt (
  merchant_id TEXT NOT NULL,
  refund_attempt_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  idempotency_identity TEXT NOT NULL,
  command_digest TEXT NOT NULL CHECK (
    length(command_digest) = 64 AND
    command_digest NOT GLOB '*[^0-9a-f]*'
  ),
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('requested', 'processing', 'succeeded', 'failed', 'indeterminate')
  ),
  attempt_json TEXT NOT NULL CHECK (json_valid(attempt_json)),
  PRIMARY KEY (merchant_id, refund_attempt_id),
  UNIQUE (merchant_id, idempotency_identity),
  FOREIGN KEY (merchant_id, order_id)
    REFERENCES commerce_order (merchant_id, resource_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, payment_id)
    REFERENCES payment (merchant_id, resource_id) ON DELETE RESTRICT
) STRICT;
`;

const PAYMENT_DISPUTE_SCHEMA = `
CREATE TABLE IF NOT EXISTS payment_dispute (
  merchant_id TEXT NOT NULL,
  dispute_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  provider_dispute_reference TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('action_required', 'under_review', 'won', 'lost')
  ),
  dispute_json TEXT NOT NULL CHECK (json_valid(dispute_json)),
  PRIMARY KEY (merchant_id, dispute_id),
  UNIQUE (merchant_id, provider_dispute_reference),
  FOREIGN KEY (merchant_id, order_id)
    REFERENCES commerce_order (merchant_id, resource_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, payment_id)
    REFERENCES payment (merchant_id, resource_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS payment_dispute_order_lookup
  ON payment_dispute (merchant_id, order_id, dispute_id);
`;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS merchant (
  merchant_id TEXT PRIMARY KEY,
  external_reference TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

${NORMALIZED_COMMERCE_SCHEMA}
${AFTER_SALE_SCHEMA}
${PAYMENT_DISPUTE_SCHEMA}
${CHECKOUT_PROFILE_SCHEMA}
${CHECKOUT_PROFILE_PIN_TRIGGERS}
${NORMALIZED_INVENTORY_SCHEMA}
${SHIPPING_CONFIGURATION_SCHEMA}
CREATE TABLE IF NOT EXISTS command_receipt (
  merchant_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  command_digest TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, idempotency_key),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS observation_outbox (
  delivery_id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL,
  merchant_revision INTEGER NOT NULL CHECK (merchant_revision > 0),
  delivery_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'rejected')),
  created_at TEXT NOT NULL, delivered_at TEXT,
  rejected_at TEXT, rejected_reason TEXT,
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;
`;

const SHIPPING_OPERATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS shipment_label_rate (
  merchant_id TEXT NOT NULL,
  label_rate_id TEXT NOT NULL,
  shipment_id TEXT NOT NULL,
  shipment_revision INTEGER NOT NULL CHECK (shipment_revision > 0),
  idempotency_key TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  rate_json TEXT NOT NULL CHECK (json_valid(rate_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, label_rate_id),
  UNIQUE (merchant_id, idempotency_key),
  FOREIGN KEY (merchant_id, shipment_id)
    REFERENCES shipment (merchant_id, resource_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS shipment_label_attempt (
  merchant_id TEXT NOT NULL,
  label_attempt_id TEXT NOT NULL,
  shipment_id TEXT NOT NULL,
  shipment_revision INTEGER NOT NULL CHECK (shipment_revision > 0),
  label_rate_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  attempt_json TEXT NOT NULL CHECK (json_valid(attempt_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, label_attempt_id),
  UNIQUE (merchant_id, idempotency_key),
  FOREIGN KEY (merchant_id, shipment_id)
    REFERENCES shipment (merchant_id, resource_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, label_rate_id)
    REFERENCES shipment_label_rate (merchant_id, label_rate_id) ON DELETE RESTRICT
) STRICT;
`;

const ADDRESS_VALIDATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS address_validation_attempt (
  merchant_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  buyer_session_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('accepted', 'correction_required', 'unserviceable', 'indeterminate')
  ),
  attempt_json TEXT NOT NULL CHECK (json_valid(attempt_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, attempt_id),
  UNIQUE (merchant_id, buyer_session_digest, idempotency_key),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;
`;

const SHIPPING_QUOTE_ATTEMPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS shipping_quote_attempt (
  merchant_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  checkout_revision INTEGER NOT NULL CHECK (checkout_revision > 0),
  buyer_session_digest TEXT NOT NULL CHECK (
    length(buyer_session_digest) = 64 AND
    buyer_session_digest NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL,
  input_digest TEXT NOT NULL CHECK (
    length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'
  ),
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('pending', 'quoted', 'rejected', 'indeterminate')
  ),
  attempt_json TEXT NOT NULL CHECK (json_valid(attempt_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, attempt_id),
  UNIQUE (merchant_id, buyer_session_digest, idempotency_key),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;
`;

const CHECKOUT_CHARGE_QUOTE_ATTEMPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS checkout_charge_quote_attempt (
  merchant_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  checkout_revision INTEGER NOT NULL CHECK (checkout_revision > 0),
  buyer_session_digest TEXT NOT NULL CHECK (
    length(buyer_session_digest) = 64 AND
    buyer_session_digest NOT GLOB '*[^0-9a-f]*'
  ),
  component_kind TEXT NOT NULL CHECK (component_kind IN ('carrier_rate', 'tax', 'duty')),
  provider_account_reference TEXT NOT NULL,
  input_digest TEXT NOT NULL CHECK (
    length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'
  ),
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('pending', 'quoted', 'unavailable', 'indeterminate')
  ),
  attempt_json TEXT NOT NULL CHECK (json_valid(attempt_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, attempt_id),
  UNIQUE (merchant_id, parent_attempt_id, component_kind),
  FOREIGN KEY (merchant_id, parent_attempt_id)
    REFERENCES shipping_quote_attempt (merchant_id, attempt_id) ON DELETE CASCADE
) STRICT;
`;

const OFFER_PRICE_POLICY_SCHEMA = `
-- The owner-approved allowance that bounds automated price changes on one
-- Offer. Absent means no policy has ever been set; a stored row may still be
-- disabled. Either way an executable price proposal is refused.
CREATE TABLE offer_price_policy (
  merchant_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('disabled', 'enabled')),
  -- Captured by this boundary from the Offer when an owner enabled or reset
  -- the policy. Never supplied by a request body.
  reference_offer_revision INTEGER CHECK (
    reference_offer_revision IS NULL OR reference_offer_revision > 0
  ),
  reference_price_minor INTEGER CHECK (
    reference_price_minor IS NULL OR reference_price_minor > 0
  ),
  currency TEXT,
  max_movement_bps INTEGER CHECK (
    max_movement_bps IS NULL OR (max_movement_bps >= 0 AND max_movement_bps <= 10000)
  ),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, offer_id),
  FOREIGN KEY (merchant_id, offer_id)
    REFERENCES offer (merchant_id, resource_id) ON DELETE CASCADE,
  -- An enabled policy carries every pricing field; a disabled one carries none,
  -- so a disabled row can never be read as a usable allowance.
  CHECK (
    (lifecycle = 'enabled') = (reference_offer_revision IS NOT NULL)
    AND (lifecycle = 'enabled') = (reference_price_minor IS NOT NULL)
    AND (lifecycle = 'enabled') = (currency IS NOT NULL)
    AND (lifecycle = 'enabled') = (max_movement_bps IS NOT NULL)
  )
) STRICT;
`;

// The command that reserved a refund attempt, as its caller sent it.
// Commerce replays it to read a pending refund again, so the receipt is the
// one that the caller's own retry would get (schema 67).
const REFUND_COMMAND_SCHEMA = `
CREATE TABLE IF NOT EXISTS refund_command (
  merchant_id TEXT NOT NULL,
  refund_attempt_id TEXT NOT NULL,
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  PRIMARY KEY (merchant_id, refund_attempt_id),
  FOREIGN KEY (merchant_id, refund_attempt_id)
    REFERENCES refund_attempt (merchant_id, refund_attempt_id) ON DELETE CASCADE
) STRICT;
`;


// Money that staff took outside a payment provider (Plan 77 step 2, schema
// 69; extended with counter cash tendered/change in Plan 90, schema 91): cash,
// or a bank transfer with its reference. Each row is the tender of one
// captured payment; a refund of that payment needs no provider.
const MANUAL_TENDER_SCHEMA_V69 = `
CREATE TABLE IF NOT EXISTS manual_tender (
  merchant_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash', 'bank_transfer')),
  reference TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, payment_id),
  CHECK ((method = 'bank_transfer') = (reference IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS manual_tender_order
  ON manual_tender (merchant_id, order_id);
`;

const MANUAL_TENDER_SCHEMA = `
CREATE TABLE IF NOT EXISTS manual_tender (
  merchant_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash', 'bank_transfer')),
  reference TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  cash_received_minor INTEGER CHECK (
    cash_received_minor IS NULL OR cash_received_minor >= amount_minor
  ),
  change_due_minor INTEGER CHECK (
    change_due_minor IS NULL OR change_due_minor >= 0
  ),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, payment_id),
  CHECK ((method = 'bank_transfer') = (reference IS NOT NULL)),
  CHECK ((cash_received_minor IS NULL) = (change_due_minor IS NULL)),
  CHECK (
    cash_received_minor IS NULL OR
    (method = 'cash' AND cash_received_minor - amount_minor = change_due_minor)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS manual_tender_order
  ON manual_tender (merchant_id, order_id);
CREATE TABLE IF NOT EXISTS manual_cash_refund (
  merchant_id TEXT NOT NULL,
  refund_attempt_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, refund_attempt_id)
) STRICT;
CREATE INDEX IF NOT EXISTS manual_cash_refund_order
  ON manual_cash_refund (merchant_id, order_id);
`;

// A merchant's state of each plugin that it changed (Plan 77 step 3, schema
// 70). A plugin with no row is active at revision 1.
const PLUGIN_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS plugin_state (
  merchant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'removed')),
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, plugin_id)
) STRICT;
`;

// Merchant plugins (Plan 77 step 4, schema 71). A version keeps the
// definition an agent wrote; it never changes. The installation names the
// version that runs, its settings, and the failures in a row that pause it.
// The state and revision live in plugin_state, as for built-in plugins.
const MERCHANT_PLUGIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_plugin_version (
  merchant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, plugin_id, version)
) STRICT;
CREATE TABLE IF NOT EXISTS merchant_plugin_installation (
  merchant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
  failures_in_a_row INTEGER NOT NULL DEFAULT 0 CHECK (failures_in_a_row >= 0),
  installed_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, plugin_id),
  FOREIGN KEY (merchant_id, plugin_id, version)
    REFERENCES merchant_plugin_version (merchant_id, plugin_id, version)
) STRICT;
`;

// A merchant plugin function that failed and was skipped (Plan 77 step 4,
// schema 73), on a checkout or a guarded move (its subject). A system commit
// after it reports it as a plugin.function_failed event and sets reported_at.
const PLUGIN_FAILURE_SCHEMA = `
CREATE TABLE IF NOT EXISTS plugin_failure (
  merchant_id TEXT NOT NULL,
  failure_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  hook_point TEXT NOT NULL,
  function_id TEXT NOT NULL,
  reason TEXT NOT NULL
    CHECK (reason IN (
      'threw', 'budget', 'memory', 'invalid_output', 'unavailable', 'refused'
    )),
  message TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  failures_in_a_row INTEGER NOT NULL CHECK (failures_in_a_row > 0),
  occurred_at TEXT NOT NULL,
  reported_at TEXT,
  PRIMARY KEY (merchant_id, failure_id)
) STRICT;
CREATE INDEX IF NOT EXISTS plugin_failure_unreported
  ON plugin_failure (occurred_at) WHERE reported_at IS NULL;
CREATE INDEX IF NOT EXISTS plugin_failure_plugin
  ON plugin_failure (merchant_id, plugin_id, occurred_at);
`;

// The fields that a merchant plugin adds to products, variants and (schema 78)
// customers, and their values on one record (schema 73). Only the plugin's
// own functions read them.
const PLUGIN_FIELD_SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_plugin_field (
  merchant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('product', 'sellable_variant', 'customer')),
  field_key TEXT NOT NULL,
  value_kind TEXT NOT NULL
    CHECK (value_kind IN ('integer', 'text', 'boolean', 'text_list')),
  description TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (merchant_id, plugin_id, entity_type, field_key)
) STRICT;
CREATE TABLE IF NOT EXISTS merchant_plugin_field_values (
  merchant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('product', 'sellable_variant', 'customer')),
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  values_json TEXT NOT NULL CHECK (json_valid(values_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, plugin_id, entity_type, entity_id)
) STRICT;
`;

// The entity plane types that a merchant plugin added (Plan 77 step 4,
// schema 74). The row stays when the plugin is removed, so the type keeps its
// owner and no other plugin or staff edit takes it over.
const PLUGIN_ENTITY_TYPE_SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_plugin_entity_type (
  merchant_id TEXT NOT NULL,
  entity_type_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  PRIMARY KEY (merchant_id, entity_type_id)
) STRICT;
`;

// The event handlers and actions of a merchant plugin (Plan 77 step 5,
// schema 73). A handler keeps the cursor of the last event that it read; a
// new handler starts after the newest event at its installation.
const PLUGIN_HANDLER_SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_plugin_handler (
  merchant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  handler_id TEXT NOT NULL,
  event_kinds_json TEXT NOT NULL CHECK (json_valid(event_kinds_json)),
  source TEXT NOT NULL,
  cursor TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (merchant_id, plugin_id, handler_id)
) STRICT;
CREATE TABLE IF NOT EXISTS merchant_plugin_action (
  merchant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  title TEXT NOT NULL,
  inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),
  source TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (merchant_id, plugin_id, action_id)
) STRICT;
`;

// The pickup time that a buyer chose for a checkout (schema 73). A refresh
// keeps it; a time that a plugin set is not a choice.
const CHECKOUT_PICKUP_CHOICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS checkout_pickup_choice (
  merchant_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  pickup_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, checkout_id)
) STRICT;
`;

// Schema 72 adds the previous secret of a rotation to existing databases;
// the baseline creates the columns in WEBHOOK_SCHEMA.
const WEBHOOK_SECRET_ROTATION_SCHEMA = `
ALTER TABLE webhook_subscription ADD COLUMN previous_secret TEXT;
ALTER TABLE webhook_subscription ADD COLUMN previous_secret_expires_at TEXT;
`;

type SchemaVersionRow = Readonly<{ version: number | null }>;

/**
 * Creates the current schema on a new merchant database, upgrades a database
 * at schema 66 or later to the current one, and accepts a database that
 * already holds the current schema.
 *
 * Schema 66 is the baseline: every production merchant held it when the
 * earlier upgrade steps were removed (Plan 76 phase 5,
 * docs/evidence/plan-76-phase-5/schema-baseline.json). Each later version adds
 * one step from there. Any other stored version is refused.
 */
export function initializeCommerceSchema(
  database: CommerceDatabase,
  appliedAt: string,
): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(MIGRATION_TABLE);
  const row = database
    .prepare("SELECT MAX(version) AS version FROM schema_migration")
    .get<SchemaVersionRow>();
  if (row?.version === undefined || row.version === null) {
    database.transaction(
      applySchemaBaseline.bind(undefined, database, appliedAt),
    );
  } else if (row.version >= 66 && row.version < SCHEMA_VERSION) {
    const from = row.version;
    if (from < 91) database.exec("PRAGMA foreign_keys = OFF");
    try {
      database.transaction(() => {
        if (from < 67) applySchemaV67(database, appliedAt);
        if (from < 68) applySchemaV68(database, appliedAt);
        if (from < 69) applySchemaV69(database, appliedAt);
        if (from < 70) applySchemaV70(database, appliedAt);
        if (from < 71) applySchemaV71(database, appliedAt);
        if (from < 72) applySchemaV72(database, appliedAt);
        if (from < 73) applySchemaV73(database, appliedAt);
        if (from < 74) applySchemaV74(database, appliedAt);
        if (from < 75) applySchemaV75(database, appliedAt);
        if (from < 76) applySchemaV76(database, appliedAt);
        if (from < 77) applySchemaV77(database, appliedAt);
        if (from < 78) applySchemaV78(database, appliedAt);
        if (from < 79) applySchemaV79(database, appliedAt);
        if (from < 80) applySchemaV80(database, appliedAt);
        if (from < 81) applySchemaV81(database, appliedAt);
        if (from < 82) applySchemaV82(database, appliedAt);
        if (from < 83) applySchemaV83(database, appliedAt);
        if (from < 84) applySchemaV84(database, appliedAt);
        if (from < 85) applySchemaV85(database, appliedAt);
        if (from < 86) applySchemaV86(database, appliedAt);
        if (from < 87) applySchemaV87(database, appliedAt);
        if (from < 88) applySchemaV88(database, appliedAt);
        if (from < 89) applySchemaV89(database, appliedAt);
        if (from < 90) applySchemaV90(database, appliedAt);
        applySchemaV91(database, appliedAt);
      });
    } finally {
      if (from < 91) database.exec("PRAGMA foreign_keys = ON");
    }
  } else if (row.version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported Underclerk schema version: ${row.version}`);
  }
  initializeEntityPlaneSchema(database);
}

export function assertCommerceSchemaReady(
  database: CommerceDatabase,
): void {
  let row: SchemaVersionRow | undefined;
  try {
    row = database
      .prepare("SELECT MAX(version) AS version FROM schema_migration")
      .get<SchemaVersionRow>();
  } catch {
    throw new Error(
      "Underclerk schema must be initialized before constructing runtime services",
    );
  }
  if (row?.version !== SCHEMA_VERSION) {
    throw new Error(
      "Underclerk schema must be initialized before constructing runtime services",
    );
  }
}

function applySchemaBaseline(
  database: CommerceDatabase,
  appliedAt: string,
): void {
  database.exec(
    `${SCHEMA_V1}${FOOD_SERVICE_SCHEMA}\n${SHIPPING_OPERATIONS_SCHEMA}\n${ADDRESS_VALIDATION_SCHEMA}\n${SHIPPING_QUOTE_ATTEMPT_SCHEMA}\n${CHECKOUT_CHARGE_QUOTE_ATTEMPT_SCHEMA}\n${OFFER_PRICE_POLICY_SCHEMA}\n${DRAFT_ORDER_SCHEMA}\n${ORDER_RETURN_SCHEMA}\n${ORDER_CHANGE_SCHEMA}\n${CUSTOMER_SCHEMA}${NOTIFICATION_OUTBOX_SCHEMA}\n${WEBHOOK_SCHEMA}\n${ARCHIVE_SCHEMA}\n${COLLECTION_SCHEMA}\n${DISCOUNT_SCHEMA}\n${MARKET_SCHEMA}\n${MEDIA_SCHEMA}\n${API_CREDENTIAL_SCHEMA}\n${PAYMENT_PROVIDER_SCHEMA}\n${FEED_CONSUMER_SCHEMA}\n${REFUND_COMMAND_SCHEMA}\n${STORED_VALUE_SCHEMA}\n${MANUAL_TENDER_SCHEMA}\n${PLUGIN_STATE_SCHEMA}\n${MERCHANT_PLUGIN_SCHEMA}\n${PLUGIN_FAILURE_SCHEMA}\n${CHECKOUT_PICKUP_CHOICE_SCHEMA}\n${PLUGIN_FIELD_SCHEMA}\n${PLUGIN_HANDLER_SCHEMA}\n${PLUGIN_ENTITY_TYPE_SCHEMA}\n${SQUARE_PAYMENT_SCHEMA}\n${COMPANY_SCHEMA}\n${STOCK_LOT_USABLE_INDEX_V82}\n${FAILED_PAYMENT_INDEXES_V84}\n${BANK_PAYOUT_SCHEMA_V85}\n${CAPTURE_UNPLACED_SCHEMA}\n${STOCK_LOT_EXPIRY_INDEX}`,
  );
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(SCHEMA_VERSION, appliedAt);
}

function applySchemaV82(database: CommerceDatabase, appliedAt: string): void {
  database.exec(STOCK_LOT_USABLE_INDEX_V82);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(82, appliedAt);
}

function applySchemaV86(database: CommerceDatabase, appliedAt: string): void {
  database.exec(WEBHOOK_DELIVERY_GONE_SCHEMA_V86);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(86, appliedAt);
}

function applySchemaV87(database: CommerceDatabase, appliedAt: string): void {
  database.exec(SQUARE_CONNECTION_STATE_V87);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(87, appliedAt);
}

// Schema 91 (Plan 90 Phase 1): cash-enabled counters can open a point_of_sale
// checkout with terminal_assignment_revision IS NULL, and manual_tender records
// cash_received_minor / change_due_minor for counter cash sales. Frozen DDL.
const SCHEMA_V91_MIGRATION = `
ALTER TABLE buyer_checkout RENAME TO buyer_checkout_v90;
DROP INDEX IF EXISTS buyer_checkout_session;
DROP INDEX IF EXISTS buyer_checkout_payment_pending;
DROP TRIGGER IF EXISTS buyer_checkout_profile_insert;
DROP TRIGGER IF EXISTS buyer_checkout_profile_immutable;
CREATE TABLE buyer_checkout (
  merchant_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('online', 'point_of_sale')),
  storefront_id TEXT,
  cart_id TEXT,
  buyer_session_digest TEXT CHECK (
    buyer_session_digest IS NULL OR (
      length(buyer_session_digest) = 64 AND
      buyer_session_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  satyr_location_id TEXT,
  operator_identity TEXT,
  terminal_assignment_revision INTEGER CHECK (
    terminal_assignment_revision IS NULL OR terminal_assignment_revision > 0
  ),
  point_of_sale_buyer_kind TEXT CHECK (
    point_of_sale_buyer_kind IS NULL OR
    point_of_sale_buyer_kind IN ('anonymous', 'identified_customer')
  ),
  point_of_sale_customer_id TEXT,
  checkout_profile_id TEXT,
  checkout_profile_revision INTEGER CHECK (
    checkout_profile_revision IS NULL OR checkout_profile_revision > 0
  ),
  pos_configuration_revision INTEGER CHECK (
    pos_configuration_revision IS NULL OR pos_configuration_revision > 0
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('quoted', 'payment_pending', 'accepted', 'expired')
  ),
  quote_digest TEXT NOT NULL,
  checkout_json TEXT NOT NULL,
  CHECK (
    (source_kind = 'online'
      AND storefront_id IS NOT NULL AND cart_id IS NOT NULL
      AND buyer_session_digest IS NOT NULL
      AND checkout_profile_id IS NOT NULL
      AND checkout_profile_revision IS NOT NULL
      AND pos_configuration_revision IS NULL
      AND satyr_location_id IS NULL AND operator_identity IS NULL
      AND terminal_assignment_revision IS NULL
      AND point_of_sale_buyer_kind IS NULL AND point_of_sale_customer_id IS NULL)
    OR
    (source_kind = 'point_of_sale'
      AND storefront_id IS NULL AND cart_id IS NULL
      AND buyer_session_digest IS NULL
      AND checkout_profile_id IS NULL AND checkout_profile_revision IS NULL
      AND pos_configuration_revision IS NOT NULL
      AND satyr_location_id IS NOT NULL AND operator_identity IS NOT NULL
      AND point_of_sale_buyer_kind IS NOT NULL
      AND (
        (point_of_sale_buyer_kind = 'anonymous' AND point_of_sale_customer_id IS NULL)
        OR
        (point_of_sale_buyer_kind = 'identified_customer'
          AND point_of_sale_customer_id IS NOT NULL)
      ))
  ),
  PRIMARY KEY (merchant_id, checkout_id),
  UNIQUE (merchant_id, cart_id),
  FOREIGN KEY (merchant_id, storefront_id)
    REFERENCES storefront (merchant_id, storefront_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, cart_id)
    REFERENCES buyer_cart (merchant_id, cart_id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, cart_id, buyer_session_digest)
    REFERENCES buyer_cart (merchant_id, cart_id, buyer_session_digest) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, checkout_profile_id, checkout_profile_revision)
    REFERENCES checkout_profile_revision (merchant_id, checkout_profile_id, revision)
    ON DELETE RESTRICT
) STRICT;
INSERT INTO buyer_checkout (
  merchant_id, checkout_id, source_kind, storefront_id, cart_id,
  buyer_session_digest, satyr_location_id, operator_identity,
  terminal_assignment_revision, point_of_sale_buyer_kind,
  point_of_sale_customer_id, checkout_profile_id,
  checkout_profile_revision, pos_configuration_revision, revision,
  lifecycle_state, quote_digest, checkout_json
)
SELECT
  merchant_id, checkout_id, source_kind, storefront_id, cart_id,
  buyer_session_digest, satyr_location_id, operator_identity,
  terminal_assignment_revision, point_of_sale_buyer_kind,
  point_of_sale_customer_id, checkout_profile_id,
  checkout_profile_revision, pos_configuration_revision, revision,
  lifecycle_state, quote_digest, checkout_json
FROM buyer_checkout_v90 ORDER BY rowid;
DROP TABLE buyer_checkout_v90;
CREATE INDEX buyer_checkout_session
  ON buyer_checkout (merchant_id, buyer_session_digest)
  WHERE buyer_session_digest IS NOT NULL;
CREATE INDEX buyer_checkout_payment_pending
  ON buyer_checkout (merchant_id, checkout_id)
  WHERE lifecycle_state = 'payment_pending';
CREATE TRIGGER IF NOT EXISTS buyer_checkout_profile_insert
BEFORE INSERT ON buyer_checkout
WHEN NEW.source_kind = 'online' AND NOT EXISTS (
  SELECT 1 FROM buyer_cart
  WHERE merchant_id = NEW.merchant_id
    AND cart_id = NEW.cart_id
    AND checkout_profile_id = NEW.checkout_profile_id
    AND checkout_profile_revision = NEW.checkout_profile_revision
)
BEGIN
  SELECT RAISE(ABORT, 'checkout profile must match cart');
END;
CREATE TRIGGER IF NOT EXISTS buyer_checkout_profile_immutable
BEFORE UPDATE OF checkout_profile_id, checkout_profile_revision ON buyer_checkout
WHEN OLD.checkout_profile_id IS NOT NEW.checkout_profile_id
  OR OLD.checkout_profile_revision IS NOT NEW.checkout_profile_revision
BEGIN
  SELECT RAISE(ABORT, 'checkout profile cannot change');
END;

ALTER TABLE manual_tender RENAME TO manual_tender_v90;
DROP INDEX IF EXISTS manual_tender_order;
CREATE TABLE manual_tender (
  merchant_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash', 'bank_transfer')),
  reference TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  cash_received_minor INTEGER CHECK (
    cash_received_minor IS NULL OR cash_received_minor >= amount_minor
  ),
  change_due_minor INTEGER CHECK (
    change_due_minor IS NULL OR change_due_minor >= 0
  ),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, payment_id),
  CHECK ((method = 'bank_transfer') = (reference IS NOT NULL)),
  CHECK ((cash_received_minor IS NULL) = (change_due_minor IS NULL)),
  CHECK (
    cash_received_minor IS NULL OR
    (method = 'cash' AND cash_received_minor - amount_minor = change_due_minor)
  )
) STRICT;
INSERT INTO manual_tender (
  merchant_id, payment_id, order_id, method, reference, amount_minor,
  currency, cash_received_minor, change_due_minor, recorded_at
)
SELECT
  merchant_id, payment_id, order_id, method, reference, amount_minor,
  currency, NULL, NULL, recorded_at
FROM manual_tender_v90 ORDER BY rowid;
DROP TABLE manual_tender_v90;
CREATE INDEX manual_tender_order
  ON manual_tender (merchant_id, order_id);

CREATE TABLE IF NOT EXISTS manual_cash_refund (
  merchant_id TEXT NOT NULL,
  refund_attempt_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, refund_attempt_id)
) STRICT;
CREATE INDEX IF NOT EXISTS manual_cash_refund_order
  ON manual_cash_refund (merchant_id, order_id);

ALTER TABLE square_terminal_checkout ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'card' CHECK (
  payment_method IN ('card', 'felica', 'qr_code')
);
`;

function applySchemaV91(database: CommerceDatabase, appliedAt: string): void {
  database.exec(SCHEMA_V91_MIGRATION);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(91, appliedAt);
}

function applySchemaV90(database: CommerceDatabase, appliedAt: string): void {
  database.exec(STOCK_LOT_EXPIRY_INDEX_V90);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(90, appliedAt);
}

function applySchemaV89(database: CommerceDatabase, appliedAt: string): void {
  database.exec(CREDENTIAL_LIFECYCLE_V89);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(89, appliedAt);
}

function applySchemaV88(database: CommerceDatabase, appliedAt: string): void {
  database.exec(CAPTURE_UNPLACED_SCHEMA_V88);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(88, appliedAt);
}

function applySchemaV85(database: CommerceDatabase, appliedAt: string): void {
  database.exec(BANK_PAYOUT_SCHEMA_V85);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(85, appliedAt);
}

function applySchemaV84(database: CommerceDatabase, appliedAt: string): void {
  database.exec(FAILED_PAYMENT_INDEXES_V84);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(84, appliedAt);
}

function applySchemaV83(database: CommerceDatabase, appliedAt: string): void {
  database.exec(MENU_SOLD_OUT_MARK_V83);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(83, appliedAt);
}

function applySchemaV67(database: CommerceDatabase, appliedAt: string): void {
  database.exec(REFUND_COMMAND_SCHEMA);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(67, appliedAt);
}

function applySchemaV68(database: CommerceDatabase, appliedAt: string): void {
  database.exec(STORED_VALUE_SCHEMA);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(68, appliedAt);
}

function applySchemaV69(database: CommerceDatabase, appliedAt: string): void {
  database.exec(MANUAL_TENDER_SCHEMA_V69);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(69, appliedAt);
}

function applySchemaV70(database: CommerceDatabase, appliedAt: string): void {
  database.exec(PLUGIN_STATE_SCHEMA);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(70, appliedAt);
}

function applySchemaV71(database: CommerceDatabase, appliedAt: string): void {
  database.exec(MERCHANT_PLUGIN_SCHEMA);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(71, appliedAt);
}

function applySchemaV72(database: CommerceDatabase, appliedAt: string): void {
  database.exec(WEBHOOK_SECRET_ROTATION_SCHEMA);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(72, appliedAt);
}

function applySchemaV73(database: CommerceDatabase, appliedAt: string): void {
  database.exec(PLUGIN_FAILURE_SCHEMA);
  database.exec(CHECKOUT_PICKUP_CHOICE_SCHEMA);
  database.exec(PLUGIN_FIELD_SCHEMA);
  database.exec(PLUGIN_HANDLER_SCHEMA);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(73, appliedAt);
}

function applySchemaV74(database: CommerceDatabase, appliedAt: string): void {
  database.exec(PLUGIN_ENTITY_TYPE_SCHEMA);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(74, appliedAt);
}

function applySchemaV75(database: CommerceDatabase, appliedAt: string): void {
  database.exec(SQUARE_PAYMENT_SCHEMA_V75);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(75, appliedAt);
}

// One merchant revision can hold several entity plane changes (Plan 77 step
// 4). The table is rebuilt without its rule of one change for each revision;
// it has no child table, so dropping the old one deletes nothing else. A
// database that has no entity plane table yet gets the new one later.
function applySchemaV76(database: CommerceDatabase, appliedAt: string): void {
  const existing = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entity_plane_change'",
    )
    .get<Readonly<{ sql: string }>>();
  if (existing !== undefined) {
    database.exec(`ALTER TABLE entity_plane_change RENAME TO entity_plane_change_v75;
${ENTITY_PLANE_CHANGE_SCHEMA}
INSERT INTO entity_plane_change (
  merchant_id, change_id, merchant_revision, change_kind, resource_id,
  metadata_json, created_at
)
SELECT merchant_id, change_id, merchant_revision, change_kind, resource_id,
       metadata_json, created_at
FROM entity_plane_change_v75 ORDER BY rowid;
DROP TABLE entity_plane_change_v75;`);
  }
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(76, appliedAt);
}

// Schema 77: the B2B companies plugin's tables (Plan 76 phase 8 slice 2).
function applySchemaV77(database: CommerceDatabase, appliedAt: string): void {
  database.exec(COMPANY_SCHEMA);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(77, appliedAt);
}

// Schema 78: plugin fields on customers. SQLite cannot change a CHECK, so
// both field tables are rebuilt with their rows; nothing refers to them.
function applySchemaV78(database: CommerceDatabase, appliedAt: string): void {
  database.exec(`ALTER TABLE merchant_plugin_field RENAME TO merchant_plugin_field_v77;
ALTER TABLE merchant_plugin_field_values RENAME TO merchant_plugin_field_values_v77;
${PLUGIN_FIELD_SCHEMA}
INSERT INTO merchant_plugin_field (
  merchant_id, plugin_id, entity_type, field_key, value_kind, description,
  position
)
SELECT merchant_id, plugin_id, entity_type, field_key, value_kind, description,
       position
FROM merchant_plugin_field_v77 ORDER BY rowid;
INSERT INTO merchant_plugin_field_values (
  merchant_id, plugin_id, entity_type, entity_id, revision, values_json,
  updated_at
)
SELECT merchant_id, plugin_id, entity_type, entity_id, revision, values_json,
       updated_at
FROM merchant_plugin_field_values_v77 ORDER BY rowid;
DROP TABLE merchant_plugin_field_v77;
DROP TABLE merchant_plugin_field_values_v77;`);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(78, appliedAt);
}

// Schema 79: settings of built-in plugins (Plan 77 step 3). The plugin state
// table is rebuilt with its rows, so that it matches a new database.
// Plan 80 step 2: the merchant's owner is an external reference of the
// operator that provisions it, not a Pantry organisation.
// Plan 80 step 4: one Square connection holds a merchant's tokens, and a
// location only names the account it belongs to. Locations linked with
// their own token before are dropped; Platform links them again from the
// connection after it hands its tokens over.
function applySchemaV81(database: CommerceDatabase, appliedAt: string): void {
  database.exec(`DROP INDEX IF EXISTS square_payment_account_by_location;
DROP TABLE square_payment_account;
CREATE TABLE square_connection (
  merchant_id TEXT PRIMARY KEY REFERENCES merchant (merchant_id),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  application_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  business_name TEXT,
  country TEXT,
  currency TEXT,
  sealed_access_token TEXT NOT NULL,
  sealed_refresh_token TEXT,
  token_expires_at TEXT,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE square_payment_account (
  merchant_id TEXT NOT NULL REFERENCES merchant (merchant_id),
  payment_provider_binding_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  country TEXT NOT NULL,
  currency TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, payment_provider_binding_id)
) STRICT;
CREATE UNIQUE INDEX square_payment_account_by_location
ON square_payment_account (merchant_id, location_id);`);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(81, appliedAt);
}

function applySchemaV80(database: CommerceDatabase, appliedAt: string): void {
  database.exec(
    "ALTER TABLE merchant RENAME COLUMN organisation_id TO external_reference",
  );
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(80, appliedAt);
}

function applySchemaV79(database: CommerceDatabase, appliedAt: string): void {
  database.exec(`ALTER TABLE plugin_state RENAME TO plugin_state_v78;
${PLUGIN_STATE_SCHEMA}
INSERT INTO plugin_state (merchant_id, plugin_id, revision, state, updated_at)
SELECT merchant_id, plugin_id, revision, state, updated_at
FROM plugin_state_v78 ORDER BY rowid;
DROP TABLE plugin_state_v78;`);
  database
    .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
    .run(79, appliedAt);
}
