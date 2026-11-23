import type {
  CustomConnectorSetupAttempt,
  CustomConnectorSetupTarget,
} from "@purin-labs/area-integrations/server/custom-connectors/index";
import { parseIntegrationAccountId } from "@purin-labs/kernel/ids";
import type { VariantBy } from "@purin-labs/type-utils";

type AwaitingCredentialAttempt = VariantBy<
  CustomConnectorSetupAttempt,
  "lifecycle",
  "awaiting_credential"
>;
type CredentialStoredAttempt = VariantBy<
  CustomConnectorSetupAttempt,
  "lifecycle",
  "credential_stored"
>;

declare const awaiting: AwaitingCredentialAttempt;
declare const stored: CredentialStoredAttempt;

const testingWithoutCredential = {
  ...awaiting,
  lifecycle: "testing" as const,
  testStartedAt: 10,
};

// @ts-expect-error A testing attempt must carry candidate generation 1.
const invalidTesting: CustomConnectorSetupAttempt = testingWithoutCredential;

const verifiedWithoutEvidence = {
  ...stored,
  lifecycle: "verified" as const,
  testStartedAt: 20,
};

// @ts-expect-error A verified attempt must carry exact identity evidence.
const invalidVerified: CustomConnectorSetupAttempt = verifiedWithoutEvidence;

const accountId = parseIntegrationAccountId("integration_custom_fixture");
if (!accountId.ok) throw new Error(accountId.error.code);

const newAccount = {
  kind: "new_account",
  environment: "development",
} satisfies CustomConnectorSetupTarget;

const rotation = {
  kind: "rotate_account",
  integrationAccountId: accountId.value,
  expectedBindingRevision: 2,
} satisfies CustomConnectorSetupTarget;

// @ts-expect-error Existing-account targets require the exact binding revision.
const incompleteRotation: CustomConnectorSetupTarget = {
  kind: "rotate_account",
  integrationAccountId: accountId.value,
};

const invalidNewAccount = {
  kind: "new_account",
  environment: "production",
  integrationAccountId: accountId.value,
  // @ts-expect-error New-account targets cannot carry existing-account identity.
} satisfies CustomConnectorSetupTarget;

void newAccount;
void rotation;
void incompleteRotation;
void invalidNewAccount;
void invalidTesting;
void invalidVerified;
