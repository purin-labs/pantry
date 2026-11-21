import type { OnboardingActivationInput } from "../src/data/activation";
import type { ProviderConnectionAttempt } from "../src/data/provider-attempt";
import {
  parseProviderConnectionAttemptId,
  parseProviderStateId,
  parseOrganisationId,
} from "../src/ids";
import { parseUserId } from "@purin-labs/control-api/ids";

const organisationId = requireParsed(
  parseOrganisationId("organisation_fixture"),
);
const userId = requireParsed(
  parseUserId("user_ae9defbd-6a95-5345-8a5d-951ce3c97a4e"),
);
const attemptId = requireParsed(
  parseProviderConnectionAttemptId("provider_attempt_fixture"),
);
const providerStateId = requireParsed(
  parseProviderStateId("provider_state_fixture"),
);

const authorizing: ProviderConnectionAttempt = {
  kind: "authorizing",
  attemptId,
  organisationId,
  provider: "slack",
  environment: "development",
  userId,
  existingIntegrationAccountId: null,
  purpose: "connect",
  expiresAt: 2,
  createdAt: 1,
  updatedAt: 1,
  providerStateId,
  authorizationStartedAt: 1,
};

// @ts-expect-error Connected attempts require provisioning and connection evidence.
const incompleteConnected: ProviderConnectionAttempt = {
  kind: "connected",
  attemptId,
  organisationId,
  provider: "slack",
  environment: "development",
  userId,
  existingIntegrationAccountId: null,
  purpose: "connect",
  expiresAt: 2,
  createdAt: 1,
  updatedAt: 1,
  providerStateId,
  authorizationStartedAt: 1,
  completedAt: 2,
};

const authorizingWithFailure = {
  ...authorizing,
  // @ts-expect-error Open authorization state cannot carry terminal failure evidence.
  reasonCode: "provider_temporarily_unavailable",
} satisfies ProviderConnectionAttempt;

// @ts-expect-error Activation always carries a fenced mutation identity.
const activationWithoutMutation: OnboardingActivationInput = {
  organisationId,
  readinessVersion: 1,
  readinessHash: "readiness-fixture",
  now: 1,
};

void authorizing;
void incompleteConnected;
void authorizingWithFailure;
void activationWithoutMutation;

function requireParsed<TValue>(
  parsed: { ok: true; value: TValue } | { ok: false },
): TValue {
  if (!parsed.ok) {
    throw new Error("fixture boundary parse failed");
  }
  return parsed.value;
}
