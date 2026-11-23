export { prepareReplacedSurfaceTokenRevocation } from "./secret-revocation";
export {
  parseVaultHandle,
  type VaultHandle,
  type VaultOAuthTokens,
  type VaultResolveError,
  type VaultSecret,
  type VaultStoredSecret,
} from "./domain";
export {
  activateCredentialRevocationPolicy,
  recordCredentialRestrictionDeliveryProgress,
  revokeCredential,
  revokeVaultSecret,
  storeVaultSecret,
  verifyStoredVaultSecret,
  type CredentialRevocationCommit,
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
  type VaultRootRotationId,
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
} from "./webhook-resolution";
export {
  resolveActiveProviderConnectionCredential,
  resolveProviderManifestCredential,
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
} from "./surface-installation-resolution";
export { resolveAccountRemovalCredential } from "./account-removal-resolution";
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
  type ExternalVaultRead,
  type ExternalVaultReadError,
  type ExternalVaultSource,
} from "./external-import";
export { createOnePasswordAdapter } from "./onepassword";
export {
  exportVaultBackup,
  importVaultBackup,
  verifyRestoredVaultBackup,
  type VaultBackupEnvelope,
} from "./backup";
export { commandVaultItem, createVaultItem, listVaultItems } from "./items";
export {
  commandVaultStoreItem,
  connectOnePassword,
  createVaultStoreItem,
  disconnectOnePassword,
  listVaultEvents,
  listVaultStoreItems,
  moveVaultItems,
  readVaultStoreSummary,
  type VaultItemStoreError,
} from "./stores";
