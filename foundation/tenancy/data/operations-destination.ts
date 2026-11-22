import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  parseChannelId,
  parseConnectorId,
  parseIntegrationAccountId,
  parseWorkspaceId,
  type ChannelId,
  type ConnectorId,
  type IntegrationAccountId,
  type OrganisationId,
  type WorkspaceId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";

/**
 * The Organisation's operations channel in Slack: the setup's communication
 * destination. Paid receipts, device alerts, WhatsApp notices and bake
 * proposals post their cards there.
 */
export type OperationsDestination = Readonly<{
  integrationAccountId: IntegrationAccountId;
  connectorId: ConnectorId;
  workspaceId: WorkspaceId;
  channelId: ChannelId;
}>;

export type OperationsDestinationError =
  | "operations_destination_missing"
  | "operations_destination_invalid"
  | "operations_destination_unavailable";

export async function readOperationsDestination(
  database: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<Result<OperationsDestination, OperationsDestinationError>> {
  let row: Record<string, unknown> | null;
  try {
    row = await database
      .prepare(
        `SELECT integration_account_id AS integrationAccountId,
                workspace_id AS workspaceId,
                channel_id AS channelId
         FROM organisation_communication_destination
         WHERE organisation_id = ?`,
      )
      .bind(organisationId)
      .first<Record<string, unknown>>();
  } catch {
    return { ok: false, error: "operations_destination_unavailable" };
  }
  if (row === null)
    return { ok: false, error: "operations_destination_missing" };
  if (
    typeof row.integrationAccountId !== "string" ||
    typeof row.workspaceId !== "string" ||
    typeof row.channelId !== "string"
  )
    return { ok: false, error: "operations_destination_invalid" };
  const integrationAccountId = parseIntegrationAccountId(
    row.integrationAccountId,
  );
  const connectorId = parseConnectorId(
    `connector_slack_${row.integrationAccountId}`,
  );
  const workspaceId = parseWorkspaceId(row.workspaceId);
  const channelId = parseChannelId(row.channelId);
  return integrationAccountId.ok &&
    connectorId.ok &&
    workspaceId.ok &&
    channelId.ok
    ? {
        ok: true,
        value: {
          integrationAccountId: integrationAccountId.value,
          connectorId: connectorId.value,
          workspaceId: workspaceId.value,
          channelId: channelId.value,
        },
      }
    : { ok: false, error: "operations_destination_invalid" };
}
