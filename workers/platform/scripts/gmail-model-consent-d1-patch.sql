-- Gmail model consent: the owner or admin who accepted a reviewed model's
-- data terms with the checkbox beside Turn on. Apply to each regional D1
-- database before the Platform release that carries the consent.
--
-- Table: gmail_inference_eligibility (adds the column consented_by_user_id).
-- No index or trigger changes. A row from before the release keeps NULL: an
-- operator wrote it by hand.

ALTER TABLE gmail_inference_eligibility
  ADD COLUMN consented_by_user_id TEXT CHECK (length(trim(consented_by_user_id)) > 0);
