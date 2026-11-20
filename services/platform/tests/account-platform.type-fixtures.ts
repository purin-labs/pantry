import type { OrganisationUserAuthority } from "../src/organisation-access/access";
import { AccountServiceGrantAcceptance } from "../src/account-platform/service-membership";

declare const nativeSession: Extract<
  OrganisationUserAuthority,
  { kind: "authenticated_session" }
>;

// @ts-expect-error Only actual shared invitation acceptance can construct this receipt.
export const constructedServiceAcceptance = new AccountServiceGrantAcceptance();

const mixedNativeOrigin = {
  ...nativeSession,
  provider: "slack" as const,
  nativeEventId: "event_fixture",
  nativeIntegrationAccountId: "integration_fixture",
  nativeWorkspaceId: "workspace_fixture",
  nativeExternalUserId: "external_user_fixture",
};
// @ts-expect-error A native session cannot also claim a provider event.
export const mixedOrigin: OrganisationUserAuthority = mixedNativeOrigin;

declare const acceptedGrant: AccountServiceGrantAcceptance;

// @ts-expect-error A spread cannot reproduce the accepted shared receipt brand.
export const spreadAcceptance: AccountServiceGrantAcceptance = {
  ...acceptedGrant,
};

// @ts-expect-error Public acceptance fields cannot replace the private shared receipt.
export const constructedAcceptance: AccountServiceGrantAcceptance = {
  binding: acceptedGrant.binding,
  nativeUserId: acceptedGrant.nativeUserId,
  invitationId: acceptedGrant.invitationId,
  membership: acceptedGrant.membership,
  receiptId: acceptedGrant.receiptId,
};

// @ts-expect-error Membership availability accepts only the explicit wire states.
export const invalidMembershipAvailability: import("@purin-labs/control-api").ControlMembershipAvailability =
  "unknown";

// Verify the installed artifact's state constraints, rather than a local copy.
import type {
  OrganizationMembership,
  OrganizationInvitation,
} from "@seams-internal/console-shared/accountPlatform";
declare const sharedOwner: Extract<
  OrganizationMembership,
  { kind: "active"; role: "OWNER" }
>;
declare const sharedInvitation: Extract<
  OrganizationInvitation,
  { kind: "pending"; role: "ADMIN" }
>;

// @ts-expect-error An owner cannot enter the suspended membership branch through a spread.
export const suspendedOwner: OrganizationMembership = {
  ...sharedOwner,
  kind: "suspended",
  suspendedAt: "2026-10-16T00:00:00.000Z",
};
// @ts-expect-error A pending invitation cannot also carry accepted lifecycle fields.
export const pendingAndAccepted: OrganizationInvitation = {
  ...sharedInvitation,
  membershipId: "member",
  acceptedAt: "2026-10-16T00:00:00.000Z",
};
