export type { FileResourceDiscoveryEntry } from "@purin-labs/control-api";

export {
  FILE_DAILY_SOURCE_BYTE_BUDGET,
  FILE_EXTRACTED_TEXT_MAX_BYTES,
  FILE_GRANT_MAX_FILES,
  FILE_PROJECTION_COMMAND_TYPE,
  FILE_SOURCE_MAX_BYTES,
  createFileProjectionCommand,
  fileResourceScopeKey,
  parseFileGrantSyncState,
  parseFileProjectionCommand,
  parseProviderFileCursor,
  parseProviderFileRevision,
  type FileContextParseError,
  type FileProjectionCommand,
} from "./domain";
export {
  claimFileGrantReconciliation,
  commitFileCursorAndOutbox,
  commitFileGrantReconciliation,
  commitFileGrantUnavailable,
  fileAccountErasureStatements,
  initializeFileGrantSync,
  listPendingFileProjectionOutbox,
  listPendingFileProjectionOutboxGlobal,
  listDueFileGrantReconciliations,
  listFileGrantSyncViews,
  markFileProjectionOutboxDelivered,
  readFileGrantSync,
  readFileProviderCursor,
  replaceFileGrantAdmissions,
  reserveFileExtractionBudget,
  scheduleFileReconciliationHint,
  settleFileGrantCapped,
  settleFileGrantReady,
  settleFileGrantRetry,
  type FileExtractionBudgetReservation,
  type FileGrantSyncView,
  type DueFileGrantReconciliation,
  type FileResourceSourceFact,
  type FileResourceSourceMetadata,
  type PendingFileProjectionOutboxEntry,
  upsertFileResourceSource,
} from "./persistence";
export {
  applyFileProjectionCommand,
  segmentFileText,
  type FileProjectionApplyResult,
  type FileProjectionMetadata,
  type FileProjectionSourceError,
  type FileProjectionSourceReader,
} from "./projection";
export { runFileContextReconciliation } from "./reconciliation";
export { ProviderFileProjectionSourceReader } from "./provider-source";
export {
  validateFileGrantTarget,
  type FileGrantValidationError,
} from "./grant-validation";
export {
  discoverFileResources,
  type FileResourceDiscoveryError,
  type FileResourceDiscoveryPage,
} from "./discovery";
export {
  readGrantedFile,
  searchGrantedFiles,
  type FileReadToolResult,
  type FileSearchToolResult,
  type FileToolObservation,
} from "./tools";
