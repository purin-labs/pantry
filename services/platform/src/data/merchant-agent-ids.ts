import {
  organisationIdUniquePart,
  type OrganisationId,
} from "@purin-labs/kernel/ids";

/**
 * Sous Chef's record identifiers, one set per organisation.
 *
 * The area, agent, installation and skill tables all key on a bare id rather
 * than on (organisation_id, id), so a fixed constant would let the first organisation's
 * install take the id and every later organisation's fail with a bare conflict.
 * Deriving from the organisation is preferred over a digest: a repeat install for
 * the same organisation then fails closed rather than quietly standing up a second
 * Sous Chef beside the first.
 */
export function merchantAgentSuffix(organisationId: OrganisationId): string {
  return organisationIdUniquePart(organisationId).replaceAll("-", "_");
}

/**
 * The agent definition of Sous Chef, the default agent of an Organisation.
 * The collaboration rooms give it the first colour.
 */
export function merchantAgentAgentId(organisationId: OrganisationId): string {
  return `agent_urk_${merchantAgentSuffix(organisationId)}`;
}
