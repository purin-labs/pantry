import type {
  FileGrantSyncState,
  FileResourceGrantTarget,
  FileResourceScope,
  ProviderFileRevision,
} from "./index.ts";
import type { CanonicalContextSourceRef } from "./types/CanonicalContextSourceRef";
import type { ContextSourceRevision } from "./types/ContextSourceRevision";

export const dropboxFolderScope = {
  kind: "dropbox_folder",
  providerFolderId: "id:recipes",
  pathDisplay: "/Recipes",
} satisfies FileResourceScope;

export const driveFileScope = {
  kind: "gdrive_file",
  providerFileId: "drive-file-1",
  name: "Recipe",
} satisfies FileResourceScope;

export const fileGrantTarget = {
  kind: "file_resource",
  capabilityId: "file.read",
  capabilityVersion: 1,
  integrationAccountId: "ia_1",
  scope: dropboxFolderScope,
} satisfies FileResourceGrantTarget;

export const fileSegmentSource = {
  kind: "file_segment",
  integrationAccountId: "ia_1",
  provider: "dropbox",
  providerFileId: "id:file",
  segmentIndex: 0,
} satisfies CanonicalContextSourceRef;

export const fileSourceRevision = {
  kind: "file",
  sequence: 1,
  providerRevision: { kind: "dropbox", rev: "015" },
} satisfies ContextSourceRevision;

export const pendingFileGrantSync = {
  kind: "pending",
  nextRunAt: 1,
} satisfies FileGrantSyncState;

export const invalidMixedDropboxScope = {
  kind: "dropbox_folder",
  providerFolderId: "id:recipes",
  pathDisplay: "/Recipes",
  // @ts-expect-error Drive-only fields cannot enter a Dropbox scope.
  name: "Recipes",
} satisfies FileResourceScope;

export const invalidMixedProviderRevision = {
  kind: "dropbox",
  rev: "015",
  // @ts-expect-error Drive revision fields cannot enter a Dropbox revision.
  version: "1",
} satisfies ProviderFileRevision;

export const invalidMixedSource = {
  kind: "case_entry",
  caseId: "case_1",
  entryId: "entry_1",
  // @ts-expect-error File identity cannot enter a Case-entry source.
  providerFileId: "id:file",
} satisfies CanonicalContextSourceRef;

export const invalidReconcilingState = {
  kind: "reconciling",
  leaseId: "lease_1",
  startedAt: 1,
  // @ts-expect-error A reconciling state requires a lease expiry.
} satisfies FileGrantSyncState;

export const invalidFileRevision = {
  kind: "file",
  sequence: 1,
  // @ts-expect-error A file revision requires its provider revision.
} satisfies ContextSourceRevision;
