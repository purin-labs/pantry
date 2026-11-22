import type {
  ConnectedIntegrationSeed,
  IntegrationAccountLifecycle,
} from "@purin-labs/connections/data/integration-account";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import { parseVaultHandle } from "@purin-labs/authority/credential-vault/index";

const organisationId = requireParsed(
  parseOrganisationId("organisation_fixture"),
);
const userId = requireParsed(
  parseUserId("user_ae9defbd-6a95-5345-8a5d-951ce3c97a4e"),
);
const credentialRef = requireParsed(
  parseVaultHandle("vault:organisation:stripe:acct_1:oauth:g1"),
);

const seed: ConnectedIntegrationSeed = {
  organisationId,
  provider: "stripe",
  providerSubjectId: "acct_1",
  environment: "development",
  authMode: "shared_pantry_app",
  authority: { kind: "connection_credential", credentialRef },
  grantedScopes: ["read_write"],
  createdByUserId: userId,
  providerAccountId: "acct_1",
  accountKind: "merchant_account",
  displayName: "Stripe account",
  capabilities: ["payments.read"],
  audiencePolicy: { kind: "operator" },
  retentionPolicy: { kind: "organisation_default" },
  now: 1,
};

// @ts-expect-error Provider account identity is required for every connected account.
const missingProviderAccount: ConnectedIntegrationSeed = {
  organisationId,
  provider: "stripe",
  providerSubjectId: "acct_1",
  environment: "development",
  authMode: "shared_pantry_app",
  authority: { kind: "connection_credential", credentialRef },
  grantedScopes: ["read_write"],
  createdByUserId: userId,
  accountKind: "merchant_account",
  displayName: "Stripe account",
  capabilities: ["payments.read"],
  audiencePolicy: { kind: "operator" },
  retentionPolicy: { kind: "organisation_default" },
  now: 1,
};

// @ts-expect-error Disabled lifecycle state requires the actor and timestamp that fenced it.
const incompleteDisabled: IntegrationAccountLifecycle = {
  kind: "disabled",
  disabledAt: 1,
};

const customerAudienceRequiresConsent: ConnectedIntegrationSeed = {
  ...seed,
  audiencePolicy: {
    kind: "customer",
    // @ts-expect-error Customer conversations require explicit consent enforcement.
    consentRequired: false,
  },
};

void seed;
void missingProviderAccount;
void incompleteDisabled;
void customerAudienceRequiresConsent;

function requireParsed<TValue>(
  parsed: { ok: true; value: TValue } | { ok: false },
): TValue {
  if (!parsed.ok) {
    throw new Error("fixture boundary parse failed");
  }
  return parsed.value;
}
