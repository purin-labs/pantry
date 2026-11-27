import type { OrganisationSlackChannels } from "@purin-labs/collaboration/worker/collaboration-slack-thread";

// The read of the Slack channels of the Organisation that a draft thread link
// of the collaboration module makes (Refactor 17). The Worker registers it
// (`worker-ports.ts`). It is one D1 read and writes nothing.

export const ORGANISATION_SLACK_CHANNELS: OrganisationSlackChannels = {
  async listChannelAccounts(db, organisationId, channelId) {
    const channels = await db
      .prepare(
        "SELECT workspace_id, integration_account_id FROM organisation_slack_channel WHERE organisation_id = ? AND channel_id = ?",
      )
      .bind(organisationId, channelId)
      .all<{
        workspace_id: string;
        integration_account_id: string;
      }>();
    return channels.results.map((channel) => ({
      workspaceId: channel.workspace_id,
      integrationAccountId: channel.integration_account_id,
    }));
  },
};
