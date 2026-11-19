import type { AccountUserAuthority } from "../src/account-platform/access";
import {
  AccountServiceGrantAcceptance,
  AccountServiceGrantRevocation,
} from "../src/account-platform/service-membership";
import type {
  AccountFundsReservation,
  AccountUsageRequest,
} from "../src/account-platform/types";

declare const reserved: Extract<AccountFundsReservation, { kind: "reserved" }>;
declare const completedUsage: Extract<AccountUsageRequest, { quantity: 1 }>;
declare const nativeSession: Extract<
  AccountUserAuthority,
  { kind: "authenticated_session" }
>;

// @ts-expect-error Only actual shared invitation acceptance can construct this receipt.
export const constructedServiceAcceptance = new AccountServiceGrantAcceptance();

// @ts-expect-error Only actual shared membership revocation can construct this receipt.
export const constructedServiceRevocation = new AccountServiceGrantRevocation();

// @ts-expect-error A reserved hold cannot carry a settled charge through a spread.
export const reservedWithCharge: AccountFundsReservation = {
  ...reserved,
  chargeId: "charge_fixture",
};

// @ts-expect-error A completed outcome always has quantity one.
export const completedWithoutQuantity: AccountUsageRequest = {
  ...completedUsage,
  quantity: 0,
};

// @ts-expect-error A cancellation cannot carry a completed-turn quantity.
export const chargedCancellation: AccountUsageRequest = {
  ...completedUsage,
  evidence: { ...completedUsage.evidence, terminalOutcome: "cancelled" },
};

const mixedNativeOrigin = {
  ...nativeSession,
  provider: "slack" as const,
  nativeEventId: "event_fixture",
  nativeIntegrationAccountId: "integration_fixture",
  nativeWorkspaceId: "workspace_fixture",
  nativeExternalUserId: "external_user_fixture",
};
// @ts-expect-error A native session cannot also claim a provider event.
export const mixedOrigin: AccountUserAuthority = mixedNativeOrigin;

declare const acceptedGrant: AccountServiceGrantAcceptance;
declare const revokedGrant: AccountServiceGrantRevocation;

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
  authorityRevision: acceptedGrant.authorityRevision,
  accessRevision: acceptedGrant.accessRevision,
  receiptId: acceptedGrant.receiptId,
};

// @ts-expect-error A spread cannot reproduce the revoked shared receipt brand.
export const spreadRevocation: AccountServiceGrantRevocation = {
  ...revokedGrant,
};

// @ts-expect-error Public revocation fields cannot replace the private shared receipt.
export const constructedRevocation: AccountServiceGrantRevocation = {
  organisationId: revokedGrant.organisationId,
  nativeUserId: revokedGrant.nativeUserId,
  membershipId: revokedGrant.membershipId,
};

// @ts-expect-error Membership availability accepts only the explicit wire states.
export const invalidMembershipAvailability: import("@purin-labs/control-api").ControlMembershipAvailability =
  "unknown";

// Verify the installed artifact's state constraints, rather than a local copy.
import type {
  OrganizationMembership,
  OrganizationInvitation,
  PlatformUsageReceiptV1,
} from "@seams-internal/console-shared/accountPlatform";
declare const sharedOwner: Extract<
  OrganizationMembership,
  { kind: "active"; role: "OWNER" }
>;
declare const sharedInvitation: Extract<
  OrganizationInvitation,
  { kind: "pending"; role: "ADMIN" }
>;
declare const noCharge: Extract<
  PlatformUsageReceiptV1,
  { kind: "recorded_without_charge" }
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
// @ts-expect-error A no-charge receipt cannot carry financial charge fields.
export const noChargeWithAmount: PlatformUsageReceiptV1 = {
  ...noCharge,
  amountMinor: 1,
  priceVersion: "unsupported-charge",
};
