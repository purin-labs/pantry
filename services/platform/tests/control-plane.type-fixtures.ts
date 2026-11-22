import type {
  ActiveControlSession,
  ActiveOrganisationMembership,
  AssignableControlRole,
  OrganisationInvitationEmail,
  OrganisationOnboardingLifecycle,
} from "../src/data/control-plane";
import {
  parseControlSessionId,
  parsePersonId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";

const organisationId = requireParsed(
  parseOrganisationId("organisation_fixture"),
);
const userId = requireParsed(
  parseUserId("user_ae9defbd-6a95-5345-8a5d-951ce3c97a4e"),
);
const controlSessionId = requireParsed(
  parseControlSessionId("control_session_fixture"),
);
const personId = requireParsed(parsePersonId("person_fixture"));

const activeSession: ActiveControlSession = {
  kind: "active",
  controlSessionId,
  userId,
  rotationGeneration: 1,
  createdAt: 1,
  rotatedAt: 1,
  expiresAt: 2,
};

const membership: ActiveOrganisationMembership = {
  kind: "active",
  organisationId,
  userId,
  personId,
  role: "owner",
  createdAt: 1,
};

const configuring: OrganisationOnboardingLifecycle = {
  kind: "configuring",
  organisationId,
  configurationVersion: 1,
  environment: "development",
};

// @ts-expect-error Organisation ownership is established by bootstrap, never by invitation.
const invitedOwner: AssignableControlRole = "owner";

// @ts-expect-error Invitation repositories accept only boundary-parsed email values.
const rawInvitationEmail: OrganisationInvitationEmail = "operator@example.com";

// @ts-expect-error Active sessions always carry an expiry.
const missingExpiry: ActiveControlSession = {
  kind: "active",
  controlSessionId,
  userId,
  rotationGeneration: 1,
  createdAt: 1,
  rotatedAt: 1,
};

// @ts-expect-error A membership cannot omit its organisation scope.
const missingOrganisation: ActiveOrganisationMembership = {
  kind: "active",
  userId,
  personId,
  role: "owner",
  createdAt: 1,
};

const configuringWithReadiness: OrganisationOnboardingLifecycle = {
  kind: "configuring",
  organisationId,
  configurationVersion: 1,
  environment: "development",
  // @ts-expect-error Configuring organisations cannot carry stale readiness evidence.
  readinessVersion: 1,
};

// @ts-expect-error Activating lifecycle requires its durable attempt identity.
const incompleteActivation: OrganisationOnboardingLifecycle = {
  kind: "activating",
  organisationId,
  readinessVersion: 1,
  environment: "development",
};

void activeSession;
void membership;
void configuring;
void invitedOwner;
void rawInvitationEmail;
void missingExpiry;
void missingOrganisation;
void configuringWithReadiness;
void incompleteActivation;

function requireParsed<TValue>(
  parsed: { ok: true; value: TValue } | { ok: false },
): TValue {
  if (!parsed.ok) {
    throw new Error("fixture id invariant failed");
  }
  return parsed.value;
}

// Control admission must retain its captured placement through continuations.
function rejectMissingExecutionScope(
  admitted: import("../src/control/authorization").AuthorizedOrganisationRequest,
) {
  const { executionScope, ...missingScope } = admitted;
  // @ts-expect-error A spread cannot omit the captured execution scope.
  const invalid: import("../src/control/authorization").AuthorizedOrganisationRequest =
    missingScope;
  void executionScope;
  void invalid;
}
void rejectMissingExecutionScope;
