import type { OrganisationUserAuthority } from "../src/organisation-access/access";

declare const nativeSession: Extract<
  OrganisationUserAuthority,
  { kind: "authenticated_session" }
>;

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

// @ts-expect-error Membership availability accepts only the explicit wire states.
export const invalidMembershipAvailability: import("@purin-labs/control-api").ControlMembershipAvailability =
  "unknown";
