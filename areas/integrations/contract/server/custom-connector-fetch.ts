import type { OrganisationId } from "@purin-labs/kernel/ids";

/** The name of the fetch container Actor of one organisation. */
export function customConnectorFetchObjectName(
  organisationId: OrganisationId,
): string {
  return organisationId;
}
