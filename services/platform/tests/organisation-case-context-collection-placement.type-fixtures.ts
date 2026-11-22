import {
  commitCaseContextCollectionEffectFence,
  replayCaseContextCollectionEffectFence,
} from "@purin-labs/agent/case-context-discovery/evidence";
import {
  resolveTypeSafeConnectionKey as resolveTypeSafeConnection,
  mutateTypeSafeConnection,
} from "@purin-labs/agent/integrations/typesafe/connection";
import { evaluateOperationalCaseContextDiscovery } from "@purin-labs/agent/case-context-discovery/operational-evaluation";
import { bindEmailMessageReceiptContact } from "../src/data/email-mailbox";
import { storeOrganisationExecutionVaultSecret } from "@purin-labs/authority/credential-vault/service";
import {
  fetchCaseContextDiscoveryEvaluation,
  releaseUnissuedCaseContextDiscoveryEvaluation,
} from "@purin-labs/agent/case-context-discovery/evaluation-store";

declare const transport: Parameters<
  typeof fetchCaseContextDiscoveryEvaluation
>[0];
const { scope: transportScope, ...unscopedTransport } = transport;
void transportScope;
void fetchCaseContextDiscoveryEvaluation(
  // @ts-expect-error Actual dispatch also requires its captured placement.
  unscopedTransport,
  { state: { kind: "unissued" } },
  "https://example.test",
  {},
);
declare const release: Parameters<
  typeof releaseUnissuedCaseContextDiscoveryEvaluation
>[0];
void releaseUnissuedCaseContextDiscoveryEvaluation({
  ...release,
  // @ts-expect-error An issued request cannot release its usage reservation.
  dispatch: { kind: "issued" },
});

declare const commit: Parameters<
  typeof commitCaseContextCollectionEffectFence
>[0];
const { scope, ...unscopedCommit } = commit;
void scope;
// @ts-expect-error An CaseContextCollection effect must retain its admitted Organisation placement.
void commitCaseContextCollectionEffectFence(unscopedCommit);
// @ts-expect-error Replaying a receipt also requires its originating placement.
void replayCaseContextCollectionEffectFence(unscopedCommit);

declare const connection: Parameters<typeof resolveTypeSafeConnection>[0];
const { db, ...unroutedConnection } = connection;
void db;
// @ts-expect-error Vault resolution must use an explicitly selected database.
void resolveTypeSafeConnection(unroutedConnection);

declare const evaluation: Parameters<
  typeof evaluateOperationalCaseContextDiscovery
>[0];
const { scope: evaluationScope, ...unscopedEvaluation } = evaluation;
void evaluationScope;
// @ts-expect-error Operational discovery must retain its admitted placement.
void evaluateOperationalCaseContextDiscovery(unscopedEvaluation);

declare const binding: Parameters<typeof bindEmailMessageReceiptContact>[0];
const { scope: bindingScope, ...unscopedBinding } = binding;
void bindingScope;
// @ts-expect-error Receipt binding must atomically fence the admitted placement.
void bindEmailMessageReceiptContact(unscopedBinding);

declare const mutation: Parameters<typeof mutateTypeSafeConnection>[0];
const { scope: mutationScope, ...unscopedMutation } = mutation;
void mutationScope;
// @ts-expect-error Connection mutations must retain their admitted placement.
void mutateTypeSafeConnection(unscopedMutation);
declare const secret: Parameters<
  typeof storeOrganisationExecutionVaultSecret
>[0];
const { scope: secretScope, ...unscopedSecret } = secret;
void secretScope;
// @ts-expect-error Operational secret publication requires the captured placement.
void storeOrganisationExecutionVaultSecret(unscopedSecret);
