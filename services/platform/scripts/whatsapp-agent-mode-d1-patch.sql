-- Regional database patch (Plan 83). Alters whatsapp_ingress_policy_revision.
--
-- Adds the agent setting of a WhatsApp number and the topics that always wait
-- for a person. Existing revisions keep today's behavior: `answer`, no topics.
--
-- Apply it once to each bound regional database, before the release.
ALTER TABLE whatsapp_ingress_policy_revision
  ADD COLUMN agent_mode TEXT NOT NULL DEFAULT 'answer'
  CHECK (agent_mode IN ('off', 'draft', 'answer'));

ALTER TABLE whatsapp_ingress_policy_revision
  ADD COLUMN always_wait_topics TEXT
  CHECK (always_wait_topics IS NULL OR length(always_wait_topics) <= 2000);
