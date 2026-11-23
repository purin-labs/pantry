-- Regional database patch, data only: no table, index or trigger changes.
-- Touches email_sender_account and email_mailbox_account.
--
-- The purge of an archived Organisation erased its integration accounts but kept
-- the Google subject and address in these two tables. The unique index on
-- (environment, google_subject) then refused that Google account for every other
-- Organisation with provider_account_already_claimed. The purge now erases both
-- values; this patch does the same for Organisations that were purged before.
--
-- Apply it to each bound regional database. A second run changes no row.
UPDATE email_sender_account
SET google_subject = 'archived:' || integration_account_id,
    observed_address = integration_account_id || '@archived.invalid'
WHERE google_subject NOT LIKE 'archived:%'
  AND organisation_id IN (
    SELECT organisation_id FROM organisation_archive_cleanup WHERE status = 'purged'
  );

UPDATE email_mailbox_account
SET google_subject = 'archived:' || integration_account_id,
    observed_address = integration_account_id || '@archived.invalid'
WHERE google_subject NOT LIKE 'archived:%'
  AND organisation_id IN (
    SELECT organisation_id FROM organisation_archive_cleanup WHERE status = 'purged'
  );
