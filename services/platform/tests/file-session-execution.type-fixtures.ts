import { readGrantedFile } from "@purin-labs/agent/context/files/tools";
import { applyFileProjectionCommand } from "@purin-labs/agent/context/files/projection";
import {
  commitFileGrantReconciliation,
  markFileProjectionOutboxDelivered,
  reserveFileExtractionBudget,
  scheduleFileReconciliationHint,
  type FileExtractionBudgetReservation,
} from "@purin-labs/agent/context/files/persistence";
import { ProviderFileProjectionSourceReader } from "@purin-labs/agent/context/files/provider-source";
import { resolveFileProviderAccess } from "@purin-labs/agent/provider-workflows/file-context-credential";
import { storeSessionExecutionVaultSecret } from "@purin-labs/authority/credential-vault/service";
import { readAcceptedMessageAttachment } from "@purin-labs/agent/actors/message-preparation";

declare const fileRead: Parameters<typeof readGrantedFile>[0];
const { scope: fileScope, ...unscopedFileRead } = fileRead;
void fileScope;
// @ts-expect-error File reads require captured placement and its operational database.
void readGrantedFile(unscopedFileRead);

declare const projection: Parameters<typeof applyFileProjectionCommand>[0];
const { scope: projectionScope, ...unscopedProjection } = projection;
void projectionScope;
// @ts-expect-error A queued projection requires captured placement for every commit.
void applyFileProjectionCommand(unscopedProjection);
declare const extractionBudget: Parameters<
  typeof reserveFileExtractionBudget
>[0];
const { scope: budgetScope, ...unscopedBudget } = extractionBudget;
void budgetScope;
// @ts-expect-error Budget reservation cannot accept an unbound database.
void reserveFileExtractionBudget(unscopedBudget);
const admittedBudgetCounter = { admittedSourceBytes: 1 };
// @ts-expect-error An inactive admission cannot carry a counter through a broad spread.
const inactiveBudget: FileExtractionBudgetReservation = {
  kind: "inactive",
  ...admittedBudgetCounter,
};
void inactiveBudget;
declare const reconciliation: Parameters<
  typeof scheduleFileReconciliationHint
>[0];
const { scope: reconciliationScope, ...unscopedReconciliation } =
  reconciliation;
void reconciliationScope;
// @ts-expect-error Reconciliation scheduling cannot drop its placement fence through a spread.
void scheduleFileReconciliationHint(unscopedReconciliation);
const { authorizeExecution: fileAuthorization, ...unguardedFileRead } =
  fileRead;
void fileAuthorization;
// @ts-expect-error A spread cannot drop continuation authorization.
void readGrantedFile(unguardedFileRead);
const { storeCredential: fileCredentialWriter, ...unboundFileRead } = fileRead;
void fileCredentialWriter;
// @ts-expect-error Credential refresh must use the originating writer.
void readGrantedFile(unboundFileRead);

declare const providerRead: ConstructorParameters<
  typeof ProviderFileProjectionSourceReader
>[0];
const { db: providerDatabase, ...unscopedProviderRead } = providerRead;
void providerDatabase;
// @ts-expect-error Provider readers cannot infer the operational database from Env.
void new ProviderFileProjectionSourceReader(unscopedProviderRead);
declare const providerAccess: Parameters<typeof resolveFileProviderAccess>[0];
const { storeCredential: providerWriter, ...unboundProviderAccess } =
  providerAccess;
void providerWriter;
// @ts-expect-error Provider access requires a credential writer at construction.
void resolveFileProviderAccess(unboundProviderAccess);

declare const credentialWrite: Parameters<
  typeof storeSessionExecutionVaultSecret
>[0];
const { admission: credentialAdmission, ...unboundCredentialWrite } =
  credentialWrite;
void credentialAdmission;
// @ts-expect-error Session credential writes require captured admission after encryption.
void storeSessionExecutionVaultSecret(unboundCredentialWrite);

declare const attachmentRead: Parameters<
  typeof readAcceptedMessageAttachment
>[0];
const {
  authorizeExecution: attachmentAuthorization,
  ...unguardedAttachmentRead
} = attachmentRead;
void attachmentAuthorization;
// @ts-expect-error Prepared attachment reads require live continuation authorization.
void readAcceptedMessageAttachment(unguardedAttachmentRead);

import { admitSessionInformationFlowObservation } from "@purin-labs/agent/actors/agent-session-information-flow";
declare const observation: Parameters<
  typeof admitSessionInformationFlowObservation
>[0];
const { authorizeCommit: observationAuthorization, ...unguardedObservation } =
  observation;
void observationAuthorization;
// @ts-expect-error Observation hashing must finish before the required commit authorization.
void admitSessionInformationFlowObservation(unguardedObservation);

declare const reconciliationCommit: Parameters<
  typeof commitFileGrantReconciliation
>[0];
const { scope: commitScope, ...unscopedCommit } = reconciliationCommit;
void commitScope;
// @ts-expect-error Reconciliation cannot commit through an unbound database.
void commitFileGrantReconciliation(unscopedCommit);
declare const outboxReceipt: Parameters<
  typeof markFileProjectionOutboxDelivered
>[0];
const { scope: receiptScope, ...unscopedReceipt } = outboxReceipt;
void receiptScope;
// @ts-expect-error A queue receipt retains its original placement after dispatch.
void markFileProjectionOutboxDelivered(unscopedReceipt);
