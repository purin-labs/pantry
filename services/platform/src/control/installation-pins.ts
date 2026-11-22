import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { digestCanonical } from "../policy";

export async function readInstallationPins(
  scope: OrganisationExecutionScope,
  installationId: string,
): Promise<{
  readonly grantsDigest: string;
  readonly policyDigest: string;
} | null> {
  const row = await scope.database.prepare(
    `SELECT granted_capabilities_json AS grantedCapabilitiesJson,
            agent_definition_id AS agentDefinitionId,
            definition_revision AS definitionRevision,
            policy_revision AS policyRevision
       FROM agent_installation
       WHERE organisation_id = ? AND installation_id = ? AND lifecycle = 'active'`,
  )
    .bind(scope.organisationId, installationId)
    .first<{
      readonly grantedCapabilitiesJson: string;
      readonly agentDefinitionId: string;
      readonly definitionRevision: number;
      readonly policyRevision: number;
    }>();
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
