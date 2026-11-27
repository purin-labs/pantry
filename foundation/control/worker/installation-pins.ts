import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { digestCanonical } from "@purin-labs/authority/policy/index";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";

/** The pinned fields of an active agent installation, as stored. */
type ActiveInstallationPinRecord = Readonly<{
  grantedCapabilitiesJson: string;
  agentDefinitionId: string;
  definitionRevision: number;
  policyRevision: number;
}>;

/**
 * The agent installations that the pins read (Refactor 17). The agent
 * module owns the table, and the Worker registers its read
 * (`worker-ports.ts`).
 */
export type AgentInstallationPinReads = Readonly<{
  /** The pinned fields of an active installation, or null. One D1 read. */
  readActiveInstallationPinRecord(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
    installationId: string,
  ): Promise<ActiveInstallationPinRecord | null>;
}>;

export const agentInstallationPinReads = definePort<AgentInstallationPinReads>(
  "agent_installation_pin_reads",
);

export async function readInstallationPins(
  scope: OrganisationExecutionScope,
  installationId: string,
): Promise<{
  readonly grantsDigest: string;
  readonly policyDigest: string;
} | null> {
  const row = await agentInstallationPinReads
    .use()
    .readActiveInstallationPinRecord(
      scope.database,
      scope.organisationId,
      installationId,
    );
  if (row === null) return null;
  let grantedCapabilities: unknown;
  try {
    grantedCapabilities = JSON.parse(row.grantedCapabilitiesJson);
  } catch {
    return null;
  }
  return {
    grantsDigest: await digestCanonical({ grantedCapabilities }),
    policyDigest: await digestCanonical({
      agentDefinitionId: row.agentDefinitionId,
      definitionRevision: row.definitionRevision,
      policyRevision: row.policyRevision,
    }),
  };
}
