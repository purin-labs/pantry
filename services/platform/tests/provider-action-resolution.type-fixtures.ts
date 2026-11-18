import type {
  AuthorizedProviderAction,
  ProviderActionResolution,
  VaultHandle,
} from "../src/credential-vault";
import type { ActionLedgerEntry } from "../src/actors/action-ledger";
// @ts-expect-error Generic plaintext resolution is private to the Vault module.
import { resolveVaultHandle } from "../src/credential-vault";
import type { VariantBy } from "@seams/type-utils";

declare const authorizedAction: AuthorizedProviderAction;
declare const proposedLedgerAction: VariantBy<
  ActionLedgerEntry,
  "state",
  "proposed"
>;
declare const signedLedgerAction: VariantBy<
  ActionLedgerEntry,
  "state",
  "signed"
>;
declare const vaultHandle: VaultHandle;

// @ts-expect-error Proposed actions have no approval proof and cannot authorize decryption.
const proposedAction: AuthorizedProviderAction = proposedLedgerAction;

// @ts-expect-error Signed actions must enter authoritative executing state before decryption.
const signedAction: AuthorizedProviderAction = signedLedgerAction;

// @ts-expect-error Permitted resolution state is opaque and must come from authorization.
const directResolution: ProviderActionResolution = {
  kind: "provider_action",
  organisationId: authorizedAction.action.organisationId,
  sessionId: authorizedAction.action.sessionId,
  integrationAccountId: authorizedAction.action.integrationAccountId,
  provider: "stripe",
  environment: "development",
  credentialGeneration: 1,
  handle: vaultHandle,
  providerAccountId: "acct_fixture",
  actionNonce: authorizedAction.action.nonce.value,
};

const broadResolution = {
  kind: "provider_action" as const,
  organisationId: authorizedAction.action.organisationId,
  sessionId: authorizedAction.action.sessionId,
  integrationAccountId: authorizedAction.action.integrationAccountId,
  provider: "stripe" as const,
  environment: "development" as const,
  credentialGeneration: 1,
  handle: vaultHandle,
  providerAccountId: "acct_fixture",
  actionNonce: authorizedAction.action.nonce.value,
};

// @ts-expect-error Broad spreads cannot create opaque permitted resolution state.
const spreadResolution: ProviderActionResolution = { ...broadResolution };

void proposedAction;
void signedAction;
void directResolution;
void spreadResolution;
void resolveVaultHandle;

declare const mutationExecution: import("../src/actors/action-mutation-execution").ActionMutationExecution;
declare const actionOrganisation: import("../src/actors/organisation").OrganisationDO;
declare const actionProposal: import("../src/actors/action-ledger").ProposeActionInput;
// @ts-expect-error An Organisation proposal RPC requires captured execution authority.
void actionOrganisation.proposeAction(actionProposal);
const { fenceToken: actionFence, ...unfencedExecution } = mutationExecution;
void actionFence;
// @ts-expect-error Spreads cannot discard the original placement fence.
const invalidActionExecution: typeof mutationExecution = unfencedExecution;
void invalidActionExecution;
declare const controlActionExecution: Extract<
  typeof mutationExecution,
  { kind: "control_session" }
>;
declare const sessionActionExecution: Extract<
  typeof mutationExecution,
  { kind: "session_turn" }
>;
// @ts-expect-error A control-session branch cannot carry a second Session origin.
const mixedActionExecution: typeof mutationExecution = {
  ...controlActionExecution,
  execution: sessionActionExecution.execution,
};
void mixedActionExecution;
