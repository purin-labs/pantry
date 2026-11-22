import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Env } from "@purin-labs/kernel/env";
import {
  prepareSlackConversationBaselineGrants,
  slackConversationBaselineGrantId,
} from "../data/capability-policy";
import { parseIntegrationAccountId } from "@purin-labs/kernel/ids";
import type {
  SlackChannelDefault,
  SlackOrganisationRoutingProjection,
} from "./installation-store";
import { readSlackConnectionIntegrationAccountId } from "../data/slack-installation-records";

/** False when the channel's connection or its account cannot be read. */
export async function grantSlackChannelBaseline(
  env: Env,
  scope: OrganisationExecutionScope,
  channelDefault: SlackChannelDefault,
): Promise<boolean> {
  const storedAccountId = await readSlackConnectionIntegrationAccountId(
    env.DB,
    {
      installationId: channelDefault.installationId,
      connectionId: channelDefault.connectionId,
      organisationId: channelDefault.organisationId,
    },
  );
  if (typeof storedAccountId !== "string") return false;
  const integrationAccountId = parseIntegrationAccountId(storedAccountId);
  if (!integrationAccountId.ok) return false;
  const grantId = await slackConversationBaselineGrantId({
    organisationId: scope.organisationId,
    integrationAccountId: integrationAccountId.value,
    channelId: channelDefault.channelId,
  });
  await scope.database.batch([
    ...prepareSlackConversationBaselineGrants({
      source: scope.database,
      admission: { kind: "organisation_execution", scope },
      materializationReceiptId: `slack_channel_${grantId}`,
      now: channelDefault.boundAt,
      grantId,
      integrationAccountId: integrationAccountId.value,
      conversationId: channelDefault.channelId,
    }),
  ]);
  return true;
}

export function findSlackInstallationRouting(
  connections: readonly SlackOrganisationRoutingProjection[],
  installationId: SlackOrganisationRoutingProjection["installationId"],
): SlackOrganisationRoutingProjection | null {
  for (const connection of connections) {
    if (connection.installationId === installationId) return connection;
  }
  return null;
}
