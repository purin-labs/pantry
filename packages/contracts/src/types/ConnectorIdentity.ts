import type { ConnectorId } from "./ConnectorId";
import type { OrganisationId } from "@purin-labs/contract-schema";

export type ConnectorIdentity = {
  organisationId: OrganisationId;
  connectorId: ConnectorId;
};
