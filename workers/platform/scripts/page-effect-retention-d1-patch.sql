-- Page effect retention: the daily pass of each Organisation deletes the page
-- effects that ended more than 30 days ago, with their timeline events,
-- unless a saved run or a saved scenario names the effect. This index keeps
-- the delete a range scan of one Organisation that writes nothing when no
-- effect is old enough.
--
-- Each regional database (pantry-organisation-apac). Apply before the Worker
-- upload that carries the delete:
--   wrangler d1 execute pantry-organisation-apac --env production --remote --file workers/platform/scripts/page-effect-retention-d1-patch.sql
-- Index: idx_bakery_surface_effect_delivery_age. No table or trigger changes.
-- A second run changes nothing.

CREATE INDEX IF NOT EXISTS idx_bakery_surface_effect_delivery_age
  ON bakery_surface_effect_delivery (organisation_id, updated_at);
