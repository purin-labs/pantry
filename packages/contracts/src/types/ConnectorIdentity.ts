import type { ConnectorId } from "./ConnectorId";
import type { OrganisationId } from "@purin-labs/commerce-contracts";

export type ConnectorIdentity = {
  organisationId: OrganisationId;
  connectorId: ConnectorId;
};
