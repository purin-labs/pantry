import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  ChannelId,
  ConnectorId,
  IntegrationAccountId,
  OrganisationId,
  WorkspaceId,
} from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
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

/**
 * The read of the operations destination. The Organisation area owns its
 * record and gives the read; the Worker registers it (`worker-ports.ts`).
 */
export type OperationsDestinationRead = (
  database: OrganisationDatabase,
  organisationId: OrganisationId,
) => Promise<Result<OperationsDestination, OperationsDestinationError>>;

export const operationsDestinationRead =
  definePort<OperationsDestinationRead>("operations_destination_read");

export async function readOperationsDestination(
  database: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<Result<OperationsDestination, OperationsDestinationError>> {
  return operationsDestinationRead.use()(database, organisationId);
}
