import type { ConnectorId } from "./ConnectorId";
import type { OrganisationId } from "@seams/commerce-contracts";

export type ConnectorIdentity = {
  organisationId: OrganisationId;
  connectorId: ConnectorId;
};
