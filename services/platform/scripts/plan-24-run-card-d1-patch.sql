-- Regional database patch (Plan 24 S6). Alters table bake_proposal (new
-- column card_ts).
--
-- The Slack message of each proposal's card, so that its bake run posts its
-- own card and the over-bake risk in that card's thread. Apply it once to each
-- bound regional database, after plan-24-shadow-mode-d1-patch.sql and before
-- the release.
ALTER TABLE bake_proposal ADD COLUMN card_ts TEXT
  CHECK (card_ts IS NULL OR length(card_ts) BETWEEN 1 AND 32);
