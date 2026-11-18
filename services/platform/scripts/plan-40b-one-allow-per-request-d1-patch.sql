-- Plan 40B phase 7: one Allow covers the later edits of the same request.
-- Apply once to each REGIONAL database before the release:
--   wrangler d1 execute <regional database> --env production --remote --file services/platform/scripts/plan-40b-one-allow-per-request-d1-patch.sql
-- Alters table held_output_request (adds column consumed_turn_id, the turn
-- that used an effect's pass). Older used passes keep a null turn, so they
-- cover no later edit.
ALTER TABLE held_output_request ADD COLUMN consumed_turn_id TEXT CHECK (
  consumed_turn_id IS NULL OR length(consumed_turn_id) BETWEEN 1 AND 600
);
