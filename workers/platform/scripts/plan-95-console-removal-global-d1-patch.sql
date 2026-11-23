-- Plan 95 step 4: Pantry no longer binds the old Console. Drops its records.
-- Apply after the production gate of step 5, never before: until this patch,
-- the previous satyr-edge version can still run against the old Console.
--
-- Global database (satyr-global-tokyo): the tables account_service_binding,
-- account_provision_receipt, account_identity_link and account_automation_link,
-- with their triggers.
DROP TRIGGER IF EXISTS account_service_binding_immutable;
DROP TRIGGER IF EXISTS account_service_binding_retained;
DROP TRIGGER IF EXISTS account_provision_receipt_immutable;
DROP TRIGGER IF EXISTS account_provision_receipt_retained;
DROP TRIGGER IF EXISTS account_identity_link_immutable;
DROP TRIGGER IF EXISTS account_identity_link_retained;
DROP TRIGGER IF EXISTS account_automation_link_immutable;
DROP TABLE IF EXISTS account_provision_receipt;
DROP TABLE IF EXISTS account_service_binding;
DROP TABLE IF EXISTS account_identity_link;
DROP TABLE IF EXISTS account_automation_link;
