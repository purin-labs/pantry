-- Plan 92: removes the policy rows of the capability
-- `workspace.product_folder.update`, which left the catalogue with the
-- file-native product folders. The Access read refuses a policy row whose
-- capability the catalogue does not know, so apply this to each regional
-- database right after the Worker release that removes the capability. The
-- census of 18 November 2026 found two such rows in production, both
-- disabled, and no grant, agent profile, permission request or held output
-- that names the capability.
--
--   wrangler d1 execute <ORGANISATION DATABASE> --env production --remote \
--     --file scripts/plan-92-product-folder-capability-d1-data-patch.sql

DELETE FROM organisation_capability_policy
WHERE capability_id = 'workspace.product_folder.update';
