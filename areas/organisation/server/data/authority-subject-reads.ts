import type { ConversationSubjectReads } from "@purin-labs/authority/access-control/subject-reads";

// The Slack channels of an Organisation as conversation subjects of an
// access decision (Refactor 17). The Worker registers them
// (`worker-ports.ts`). The texts are SQL parts of the one subject list read
// of authority. The first part of that list names the columns, so these
// texts hold the column names.

export const CONVERSATION_SUBJECT_READS: ConversationSubjectReads = {
  subjectSources: [
    {
      reference: `SELECT 'conversation' AS kind, integration_account_id AS firstId,
             channel_id AS secondId, 1 AS revision
        FROM organisation_slack_channel WHERE organisation_id = ?`,
      option: `SELECT 'conversation' AS kind, channel.integration_account_id AS firstId, channel.channel_id AS secondId,
             1 AS revision, account.display_name || ' · ' || channel.channel_id AS label
        FROM organisation_slack_channel AS channel
        JOIN integration_account AS account ON account.organisation_id = channel.organisation_id
          AND account.integration_account_id = channel.integration_account_id
       WHERE channel.organisation_id = ?`,
    },
  ],
};
