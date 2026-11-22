import type { RequestAuthority } from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";
import type { AuthorizedOrganisationRequest } from "../../control/authorization";
import { readActiveOrganisationMembershipRevision } from "@purin-labs/tenancy/data/control-plane";
import { buildControlAuthority } from "@purin-labs/authority/request-authority/index";

/**
 * The control authority of a member request: the person, the role and the
 * current membership revision. Null when the membership is not active.
 */
export async function mailControlAuthority(
  authorized: AuthorizedOrganisationRequest,
): Promise<Variant<RequestAuthority, "control"> | null> {
  const membershipRevision = await readActiveOrganisationMembershipRevision({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
  });
  if (membershipRevision === null) return null;
  return buildControlAuthority({
    organisationId: authorized.organisationId,
    requesterPersonId: authorized.membership.personId,
    userId: authorized.authenticated.session.userId,
    membershipRevision,
    role: authorized.membership.role,
  }).requestAuthority;
}
