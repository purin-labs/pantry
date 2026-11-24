-- Global database patch, data only: no table, index or trigger changes.
-- Touches user_preferences.
--
-- The Kitchen scene preferences of a person are stored under the area
-- `kitchen`, not the old product name `bakeryos`. Each row moves to the new
-- area. If a person already has a `kitchen` row, that row stays and the old
-- row goes.
--
-- Apply to the GLOBAL database just BEFORE the Worker upload. In the moment
-- between the patch and the upload, the Worker before this release shows the
-- default Kitchen scene preferences; it reads and writes `bakeryos` only.
--   wrangler d1 execute <global database> --env production --remote --file workers/platform/scripts/kitchen-preference-area-d1-patch.sql
-- A second run changes nothing.
UPDATE user_preferences
SET area = 'kitchen'
WHERE area = 'bakeryos'
  AND NOT EXISTS (
    SELECT 1 FROM user_preferences AS current
    WHERE current.user_id = user_preferences.user_id
      AND current.area = 'kitchen'
  );

DELETE FROM user_preferences WHERE area = 'bakeryos';
