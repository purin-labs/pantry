-- Plan 95 step 4: Pantry no longer binds the old Console. Drops its records.
-- Apply after the production gate of step 5, never before: until this patch,
-- the previous satyr-edge version can still run against the old Console.
--
-- Regional database (satyr-organisation-apac): the tables
-- account_service_invitation_role and account_service_access_revision, with
-- their triggers, and the service_role_grant columns platform_membership_id,
-- account_access_revision and account_acceptance_receipt_id.
DROP TRIGGER IF EXISTS account_service_invitation_role_immutable;
DROP TRIGGER IF EXISTS account_service_access_revision_monotonic;
DROP TABLE IF EXISTS account_service_invitation_role;
DROP TABLE IF EXISTS account_service_access_revision;
ALTER TABLE service_role_grant DROP COLUMN platform_membership_id;
ALTER TABLE service_role_grant DROP COLUMN account_access_revision;
ALTER TABLE service_role_grant DROP COLUMN account_acceptance_receipt_id;
