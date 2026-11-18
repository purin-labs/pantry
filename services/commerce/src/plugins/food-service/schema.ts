// The table of the food-service built-in plugin (Plan 77 step 6): menus,
// modifier groups, recipes, stations, preparation tickets, production
// batches and stock policies, each revision as one JSON row. The core schema
// builds it right after the merchant tables.
export const FOOD_SERVICE_SCHEMA = `CREATE TABLE IF NOT EXISTS food_service_resource (
  merchant_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (
    resource_kind IN (
      'menu', 'modifier_group_revision', 'recipe_revision',
      'preparation_station', 'preparation_ticket', 'production_batch', 'stock_policy'
    )
  ),
  resource_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle_state TEXT NOT NULL,
  resource_json TEXT NOT NULL CHECK (json_valid(resource_json)),
  PRIMARY KEY (merchant_id, resource_kind, resource_id, revision),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS menu_sold_out_mark (
  merchant_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  sold_out_until TEXT,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, location_id, variant_id),
  FOREIGN KEY (merchant_id) REFERENCES merchant (merchant_id) ON DELETE CASCADE
) STRICT;
`;
