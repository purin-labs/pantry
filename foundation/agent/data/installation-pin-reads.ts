import type { AgentInstallationPinReads } from "@purin-labs/control/worker/installation-pins";

// The read of an agent installation that the pins of the control module make
// (Refactor 17). The Worker registers it (`worker-ports.ts`). It is one D1
// read and writes nothing.

export const AGENT_INSTALLATION_PIN_READS: AgentInstallationPinReads = {
  async readActiveInstallationPinRecord(db, organisationId, installationId) {
    return db
      .prepare(
        `SELECT granted_capabilities_json AS grantedCapabilitiesJson,
            agent_definition_id AS agentDefinitionId,
            definition_revision AS definitionRevision,
            policy_revision AS policyRevision
       FROM agent_installation
       WHERE organisation_id = ? AND installation_id = ? AND lifecycle = 'active'`,
      )
      .bind(organisationId, installationId)
      .first<{
        readonly grantedCapabilitiesJson: string;
        readonly agentDefinitionId: string;
        readonly definitionRevision: number;
        readonly policyRevision: number;
      }>();
  },
};
