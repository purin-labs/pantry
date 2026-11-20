export { prepareReplacedSurfaceTokenRevocation } from "./secret-revocation";
export {
  parseVaultHandle,
  type VaultHandle,
  type VaultOAuthTokens,
  type VaultResolveError,
  type VaultSecret,
  type VaultStoredSecret,
  type VaultStoreError,
} from "./domain";
export {
  activateCredentialRevocationPolicy,
  recordCredentialRestrictionDeliveryProgress,
  revokeCredential,
  revokeVaultSecret,
  storeVaultSecret,
  verifyRevokedVaultSecret,
  verifyStoredVaultSecret,
  type CredentialRevocationCommit,
  type CredentialRevocationPolicyActivation,
  type CredentialRevocationReceipt,
} from "./service";
export {
  parseVaultRootRotationId,
  parseVaultRotationBatchLimit,
  pauseVaultRootRotation,
  readVaultRootRotation,
  resumeVaultRootRotation,
  runVaultRootRotationStep,
  startVaultRootRotation,
  vaultRootVersionRemovalStatus,
  type VaultRootRotationError,
  type VaultRootRotationFailureCode,
  type VaultRootRotationId,
  type VaultRootRotationJob,
  type VaultRotationBatchLimit,
} from "./root-rotation";
export {
  authorizeProviderActionResolution,
  resolveProviderActionCredential,
  type AuthorizedProviderAction,
  type ProviderActionResolution,
  type ProviderActionResolutionError,
} from "./provider-action-resolution";
export {
  resolveDiscordInteractionVerificationCredential,
  resolveProviderWebhookCredential,
  type ProviderWebhookResolutionError,
} from "./webhook-resolution";
export {
  resolveActiveProviderConnectionCredential,
  resolveProviderManifestCredential,
  type ProviderConnectionResolutionError,
  type ProviderManifestResolutionError,
} from "./provider-connection-resolution";
export {
  resolveSurfaceInstallationCredential,
  resolveActiveSlackOrganisationCredential,
  resolveActiveSlackPhysicalInstallationCredential,
  resolveSlackHealthCheckCredential,
  readSlackThreadCredentialRoute,
  resolveActiveSlackThreadCredential,
  resolveRoutedSlackThreadCredential,
  slackThreadCredentialIsAtScope,
  type SlackThreadCredentialResolutionError,
  type SurfaceInstallationResolutionError,
} from "./surface-installation-resolution";
export {
  resolveAccountRemovalCredential,
  type AccountRemovalResolutionError,
} from "./account-removal-resolution";
export {
  parseModelApiKey,
  resolveCurrentOrganisationModelCredential,
  resolveOrganisationModelCredentialForRoute,
  storeOrganisationModelCredential,
  type ModelApiKey,
  type ModelKeyProvider,
} from "./organisation-model-resolution";
export {
  importExternalVaultSecret,
  type ExternalVaultAdapter,
  type ExternalVaultImportError,
  type ExternalVaultImportReceipt,
  type ExternalVaultRead,
  type ExternalVaultReadError,
  type ExternalVaultSource,
  type ExternalVaultValidationError,
} from "./external-import";
export {
  createOnePasswordAdapter,
  type OnePasswordAdapterConfig,
  type OnePasswordItemLocator,
} from "./onepassword";
export {
  exportVaultBackup,
  importVaultBackup,
  verifyRestoredVaultBackup,
  VAULT_BACKUP_SCHEMA_VERSION,
  type VaultBackupCredentialRefRow,
  type VaultBackupEnvelope,
  type VaultBackupError,
  type VaultBackupRevocationOperationRow,
  type VaultBackupRotationJobRow,
  type VaultBackupScope,
  type VaultBackupTableName,
  type VaultBackupTables,
  type VaultBackupVaultSecretRow,
  type VaultRestoreError,
  type VaultRestoreReceipt,
} from "./backup";
export {
  RESTRICTION_LATENCY_ALERT_MS,
  RESTRICTION_LATENCY_TARGET_MS,
  recordCredentialAccessDenial,
  sweepVaultAlertSignals,
  type CredentialAccessPurpose,
  type VaultAlertSweep,
} from "./alerts";
export {
  commandVaultItem,
  createVaultItem,
  listVaultItems,
  type VaultItemCommandOutcome,
  type VaultItemError,
} from "./items";
export {
  commandVaultStoreItem,
  connectOnePassword,
  createVaultStoreItem,
  disconnectOnePassword,
  isOnePasswordItemId,
  listVaultEvents,
  listVaultStoreItems,
  moveVaultItems,
  readVaultStoreSummary,
  type VaultItemStoreError,
} from "./stores";
