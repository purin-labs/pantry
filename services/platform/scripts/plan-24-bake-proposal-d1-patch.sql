-- Regional database patch (Plan 24 S1). Adds tables bake_stock_level and
-- bake_proposal, and indexes bake_proposal_one_active,
-- bake_proposal_one_waiting and bake_proposal_recent.
--
-- The counter stock level of each fresh product, and the bake proposals that a
-- fall of the counter stock below its level opens. The two partial unique
-- indexes hold one active and one waiting proposal for each product.
--
-- Apply it once to each bound regional database, before the release.
-- Plan 24 S1: the counter stock level of each fresh product, for the whole
-- day. An admin sets it. A fall of the counter stock below it opens a bake
-- proposal. The level names the recipe workflow of the bake and the Devices
-- location of the kitchen that bakes it.
CREATE TABLE IF NOT EXISTS bake_stock_level (
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  inventory_item_id TEXT NOT NULL CHECK (length(inventory_item_id) BETWEEN 1 AND 255),
  product_name TEXT NOT NULL CHECK (length(product_name) BETWEEN 1 AND 120),
  level_pieces INTEGER NOT NULL CHECK (level_pieces BETWEEN 1 AND 10000),
  pieces_per_group INTEGER NOT NULL CHECK (pieces_per_group BETWEEN 1 AND 1000),
  workflow_id TEXT NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 128),
  kitchen_location TEXT NOT NULL CHECK (length(kitchen_location) BETWEEN 1 AND 64),
  revision INTEGER NOT NULL CHECK (revision > 0),
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL CHECK (set_at >= 0),
  PRIMARY KEY (organisation_id, inventory_item_id)
);

-- Plan 24 S1: one proposed bake run of one product. A product has at most one
-- active proposal (open or approved) and at most one that waits for it; the
-- two partial unique indexes hold that rule. An approved proposal ends when
-- its bake run ends (Plan 24 S4).
CREATE TABLE IF NOT EXISTS bake_proposal (
  proposal_id TEXT PRIMARY KEY CHECK (length(proposal_id) BETWEEN 1 AND 64),
  organisation_id TEXT NOT NULL REFERENCES organisation (organisation_id),
  inventory_item_id TEXT NOT NULL CHECK (length(inventory_item_id) BETWEEN 1 AND 255),
  product_name TEXT NOT NULL CHECK (length(product_name) BETWEEN 1 AND 120),
  state TEXT NOT NULL CHECK (state IN ('waiting', 'open', 'approved', 'rejected', 'ended')),
  origin TEXT NOT NULL CHECK (origin IN ('stock', 'agent')),
  case_id TEXT NOT NULL CHECK (length(case_id) BETWEEN 1 AND 128),
  workflow_id TEXT NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 128),
  workflow_revision INTEGER NOT NULL CHECK (workflow_revision > 0),
  workflow_digest TEXT NOT NULL CHECK (length(workflow_digest) = 64),
  quantity_pieces INTEGER NOT NULL CHECK (quantity_pieces > 0),
  mould_groups INTEGER NOT NULL CHECK (mould_groups > 0),
  pieces_per_group INTEGER NOT NULL CHECK (pieces_per_group > 0),
  kitchen_location TEXT NOT NULL CHECK (length(kitchen_location) BETWEEN 1 AND 64),
  oven_device_id TEXT,
  oven_name TEXT,
  stock_location_id TEXT,
  stock_available INTEGER NOT NULL CHECK (stock_available >= 0),
  stock_level INTEGER NOT NULL CHECK (stock_level > 0),
  proposed_by TEXT NOT NULL CHECK (length(proposed_by) BETWEEN 1 AND 128),
  proposed_at INTEGER NOT NULL CHECK (proposed_at >= 0),
  opened_at INTEGER,
  announced_at INTEGER,
  decided_by TEXT,
  decided_role TEXT CHECK (decided_role IS NULL OR decided_role IN ('owner', 'admin', 'operator')),
  decided_via TEXT CHECK (decided_via IS NULL OR decided_via IN ('portal', 'slack')),
  decided_at INTEGER,
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  ended_at INTEGER,
  end_reason TEXT CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 200),
  CHECK ((oven_device_id IS NULL) = (oven_name IS NULL)),
  CHECK ((state = 'waiting') = (opened_at IS NULL)),
  CHECK ((state IN ('approved', 'rejected', 'ended')) = (decided_at IS NOT NULL)),
  CHECK ((state = 'rejected') = (reason IS NOT NULL)),
  CHECK ((state = 'ended') = (ended_at IS NOT NULL)),
  CHECK (decided_at IS NULL OR (decided_by IS NOT NULL AND decided_role IS NOT NULL AND decided_via IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS bake_proposal_one_active
  ON bake_proposal (organisation_id, inventory_item_id)
  WHERE state IN ('open', 'approved');
CREATE UNIQUE INDEX IF NOT EXISTS bake_proposal_one_waiting
  ON bake_proposal (organisation_id, inventory_item_id)
  WHERE state = 'waiting';
CREATE INDEX IF NOT EXISTS bake_proposal_recent
  ON bake_proposal (organisation_id, proposed_at DESC);
