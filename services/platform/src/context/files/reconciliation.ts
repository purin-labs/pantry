import { runtimeFetch } from "../../runtime-fetch";
import { fetchWithOrganisationPlacement } from "../../organisation-execution-scope";
import type {
  FileContextProvider,
  FileGrantAdmission,
  FileResourceScope,
  ProviderFileCursor,
} from "@seams/contracts";

import { encodeContextVisibility } from "../../authorization/access-grants/visibility";
import { readAccessGrant } from "../../data/access-grants";
import type { Env } from "../../env";
import { parseIntegrationAccountId } from "../../ids";
import { visibilityForGrantSubject } from "../../policy";
import {
  dropboxDeepLink,
  listDropboxFolder,
  readDropboxMetadata,
  type DropboxFileMetadata,
  type DropboxProtocolError,
} from "../../provider-adapters/dropbox";
import {
  googleDriveDeepLink,
  listGoogleDriveChanges,
  readGoogleDriveFileMetadata,
  readGoogleDriveStartPageToken,
  type GoogleDriveChange,
  type GoogleDriveFileMetadata,
  type GoogleDriveProtocolError,
} from "../../provider-adapters/google-drive";
import {
  resolveFileProviderAccess,
  storeFilePlacementCredential,
  type FileProviderAccess,
  type FileProviderAccessError,
} from "../../provider-workflows/file-context-credential";
import type { Result } from "../../result";
import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
} from "../../organisation-execution-scope";
import {
  FILE_GRANT_MAX_FILES,
  createFileProjectionCommand,
  fileResourceScopeKey,
} from "./domain";
import {
  claimFileGrantReconciliation,
  commitFileGrantReconciliation,
  commitFileGrantUnavailable,
  commitFileCursorAndOutbox,
  listDueFileGrantReconciliations,
  listPendingFileProjectionOutboxGlobal,
  markFileProjectionOutboxDelivered,
  readFileGrantSync,
  readFileProviderCursor,
  settleFileGrantCapped,
  settleFileGrantReady,
  settleFileGrantRetry,
  upsertFileResourceSource,
  type FileResourceSourceFact,
} from "./persistence";
import type { Variant } from "@seams/type-utils";

const FILE_RECONCILIATION_INTERVAL_MS = 60 * 60 * 1_000;
const FILE_RECONCILIATION_LEASE_MS = 2 * 60 * 1_000;
const FILE_RECONCILIATION_BATCH = 50;
const FILE_OUTBOX_DELIVERY_BATCH = 100;

type ReconciledFile = Readonly<{
  readonly provider: FileContextProvider;
  readonly providerFileId: string;
  readonly revision:
    DropboxFileMetadata["revision"] | GoogleDriveFileMetadata["revision"];
  readonly displayName: string;
  readonly displayPath: string;
  readonly mediaType: string;
  readonly deepLink: string;
}>;

export type ProviderReconciliation =
  | Readonly<{ readonly kind: "unavailable" }>
  | Readonly<{
      readonly kind: "unchanged";
      readonly cursor: ProviderFileCursor;
    }>
  | Readonly<{
      readonly kind: "snapshot";
      readonly cursor: ProviderFileCursor;
      readonly files: readonly ReconciledFile[];
    }>;

type ReconciliationError = Readonly<{
  readonly code: string;
  readonly retryable: boolean;
}>;

export async function runFileContextReconciliation(
  env: Env,
  now: number,
): Promise<void> {
  for (const database of configuredOrganisationDatabases(env)) {
    const due = await listDueFileGrantReconciliations({
      db: database,
      now,
      limit: FILE_RECONCILIATION_BATCH,
    });
    for (const grant of due) {
      const execution = await OrganisationExecutionScope.resolve(
        env,
        grant.organisationId,
      );
      if (!execution.ok || execution.value.database !== database) continue;
      await reconcileDueFileGrant(env, execution.value, grant.grantId, now);
    }
    const pending = await listPendingFileProjectionOutboxGlobal({
      db: database,
      limit: FILE_OUTBOX_DELIVERY_BATCH,
    });
    for (const entry of pending) {
      const execution = await OrganisationExecutionScope.resolve(
        env,
        entry.organisationId,
      );
      if (
        !execution.ok ||
        execution.value.database !== database ||
        !(await execution.value.isActive())
      )
        continue;
      await env.EVENT_Q.send(entry.command);
      await markFileProjectionOutboxDelivered({
        scope: execution.value,
        outboxId: entry.outboxId,
        deliveredAt: now,
      });
    }
  }
}

async function reconcileDueFileGrant(
  env: Env,
  scope: OrganisationExecutionScope,
  grantId: string,
  now: number,
): Promise<void> {
  const organisationId = scope.organisationId;
  const previous = await readFileGrantSync({
    db: scope.database,
    organisationId,
    grantId,
  });
  const attempt = previous?.kind === "retry_wait" ? previous.attempt + 1 : 1;
  const leaseId = crypto.randomUUID();
  const claimed = await claimFileGrantReconciliation({
    scope,
    grantId,
    leaseId,
    startedAt: now,
    leaseExpiresAt: now + FILE_RECONCILIATION_LEASE_MS,
  });
  if (!claimed) return;
  const result = await reconcileClaimedFileGrant(env, scope, grantId, now);
  if (!result.ok) {
    await settleFileGrantRetry({
      scope,
      grantId,
      leaseId,
      attempt,
      reason: result.error.code,
      nextRunAt: now + retryDelayMs(attempt),
    });
    return;
  }
  if (result.value.kind === "capped") {
    await settleFileGrantCapped({
      scope,
      grantId,
      leaseId,
      observedFileCount: result.value.observedFileCount,
      cappedAt: now,
    });
    return;
  }
  await settleFileGrantReady({
    scope,
    grantId,
    leaseId,
    reconciledAt: now,
    nextRunAt: now + FILE_RECONCILIATION_INTERVAL_MS,
  });
}

async function reconcileClaimedFileGrant(
  env: Env,
  scope: OrganisationExecutionScope,
  grantId: string,
  now: number,
): Promise<
  Result<
    | Readonly<{ readonly kind: "ready" }>
    | Readonly<{ readonly kind: "capped"; readonly observedFileCount: number }>,
    ReconciliationError
  >
> {
  const organisationId = scope.organisationId;
  const fetcher = fetchWithOrganisationPlacement.bind(
    null,
    scope,
    runtimeFetch,
  );
  const grant = await readAccessGrant({
    db: scope.database,
    organisationId,
    grantId,
  });
  if (
    !grant.ok ||
    grant.value.lifecycle.kind !== "active" ||
    grant.value.target.kind !== "file_resource"
  ) {
    return failure("file_grant_inactive", false);
  }
  const integrationAccountId = parseIntegrationAccountId(
    grant.value.target.integrationAccountId,
  );
  if (!integrationAccountId.ok) {
    return failure("file_grant_integration_account_invalid", false);
  }
  const provider = providerForScope(grant.value.target.scope);
  const access = await resolveFileProviderAccess({
    env,
    db: scope.database,
    storeCredential: storeFilePlacementCredential.bind(null, env, scope),
    organisationId,
    integrationAccountId: integrationAccountId.value,
    provider,
    fetcher,
    now,
  });
  if (!access.ok) return accessFailure(access.error);
  const scopeKey = fileResourceScopeKey(grant.value.target.scope);
  const previousCursor = await readFileProviderCursor({
    db: scope.database,
    organisationId,
    integrationAccountId: integrationAccountId.value,
    scopeKey,
  });
  const observed = await observeFileGrantScope(
    grant.value.target.scope,
    access.value,
    previousCursor,
    fetcher,
  );
  if (!observed.ok) return observed;
  if (observed.value.kind === "unavailable") {
    await commitFileGrantUnavailable({
      scope,
      grantId: grant.value.grantId,
      integrationAccountId: integrationAccountId.value,
      now,
    });
    return failure("provider_resource_not_accessible", true);
  }
  if (observed.value.kind === "unchanged") {
    const committed = await commitFileCursorAndOutbox({
      scope,
      integrationAccountId: integrationAccountId.value,
      scopeKey,
      cursor: observed.value.cursor,
      commands: [],
      now,
    });
    if (!committed)
      return failure("organisation_execution_authority_inactive", true);
    return { ok: true, value: { kind: "ready" } };
  }
  if (observed.value.files.length > FILE_GRANT_MAX_FILES) {
    return {
      ok: true,
      value: { kind: "capped", observedFileCount: observed.value.files.length },
    };
  }
  const visibilityKey = encodeContextVisibility(
    visibilityForGrantSubject(grant.value.subject),
  );
  const facts: FileResourceSourceFact[] = [];
  for (const file of observed.value.files) {
    const fact = await upsertFileResourceSource({
      scope,
      metadata: {
        integrationAccountId: integrationAccountId.value,
        provider: file.provider,
        providerFileId: file.providerFileId,
        providerRevision: file.revision,
        displayName: file.displayName,
        displayPath: file.displayPath,
        mediaType: file.mediaType,
        deepLink: file.deepLink,
        observedAt: now,
      },
      now,
    });
    if (!fact.ok) return failure(fact.error.code, true);
    facts.push(fact.value);
  }
  const admissions = facts.map(
    createAdmission.bind(
      null,
      grant.value.grantId,
      grant.value.lifecycle.revision,
      scopeKey,
    ),
  );
  const commands = facts.map(
    createOutboxCommand.bind(
      null,
      scope,
      grant.value.grantId,
      grant.value.lifecycle.revision,
      visibilityKey,
    ),
  );
  const committed = await commitFileGrantReconciliation({
    scope,
    grantId: grant.value.grantId,
    grantRevision: grant.value.lifecycle.revision,
    integrationAccountId: integrationAccountId.value,
    scopeKey,
    cursor: observed.value.cursor,
    admissions,
    commands,
    now,
  });
  if (!committed)
    return failure("organisation_execution_authority_inactive", true);
  return { ok: true, value: { kind: "ready" } };
}

export async function observeFileGrantScope(
  scope: FileResourceScope,
  access: FileProviderAccess,
  previousCursor: ProviderFileCursor | null,
  fetcher: typeof fetch,
): Promise<Result<ProviderReconciliation, ReconciliationError>> {
  switch (scope.kind) {
    case "dropbox_folder":
      return access.kind === "dropbox"
        ? observeDropboxFolder(scope, access, previousCursor, fetcher)
        : failure("file_provider_scope_mismatch", false);
    case "dropbox_file":
      return access.kind === "dropbox"
        ? observeDropboxFile(scope, access, fetcher)
        : failure("file_provider_scope_mismatch", false);
    case "gdrive_file":
      return access.kind === "google_drive"
        ? observeGoogleDriveFile(scope, access, previousCursor, fetcher)
        : failure("file_provider_scope_mismatch", false);
  }
}

async function observeDropboxFolder(
  scope: Variant<FileResourceScope, "dropbox_folder">,
  access: Variant<FileProviderAccess, "dropbox">,
  previousCursor: ProviderFileCursor | null,
  fetcher: typeof fetch,
): Promise<Result<ProviderReconciliation, ReconciliationError>> {
  if (previousCursor?.kind === "dropbox") {
    const change = await readDropboxFolderChange(
      scope,
      access,
      previousCursor.cursor,
      fetcher,
    );
    if (!change.ok) return change;
    if (change.value.kind !== "snapshot") return change;
  }
  return readDropboxFolderSnapshot(scope, access, fetcher);
}

async function readDropboxFolderChange(
  scope: Variant<FileResourceScope, "dropbox_folder">,
  access: Variant<FileProviderAccess, "dropbox">,
  initialCursor: string,
  fetcher: typeof fetch,
): Promise<Result<ProviderReconciliation, ReconciliationError>> {
  let cursor = initialCursor;
  while (true) {
    const page = await listDropboxFolder({
      accessToken: access.accessToken,
      path: scope.providerFolderId,
      cursor,
      recursive: true,
      limit: 1_000,
      pathRootNamespaceId: access.homeNamespaceId,
      fetcher,
    });
    if (!page.ok) {
      return page.error.code === "dropbox_cursor_reset"
        ? {
            ok: true,
            value: {
              kind: "snapshot",
              cursor: { kind: "dropbox", cursor },
              files: [],
            },
          }
        : dropboxResourceUnavailable(page.error)
          ? { ok: true, value: { kind: "unavailable" } }
          : dropboxFailure(page.error);
    }
    cursor = page.value.cursor;
    if (page.value.changeCount > 0) {
      return {
        ok: true,
        value: {
          kind: "snapshot",
          cursor: { kind: "dropbox", cursor },
          files: [],
        },
      };
    }
    if (!page.value.hasMore) {
      return {
        ok: true,
        value: { kind: "unchanged", cursor: { kind: "dropbox", cursor } },
      };
    }
  }
}

async function readDropboxFolderSnapshot(
  scope: Variant<FileResourceScope, "dropbox_folder">,
  access: Variant<FileProviderAccess, "dropbox">,
  fetcher: typeof fetch,
): Promise<Result<ProviderReconciliation, ReconciliationError>> {
  const files: ReconciledFile[] = [];
  let cursor: string | null = null;
  while (true) {
    const page = await listDropboxFolder({
      accessToken: access.accessToken,
      path: scope.providerFolderId,
      cursor,
      recursive: true,
      limit: 1_000,
      pathRootNamespaceId: access.homeNamespaceId,
      fetcher,
    });
    if (!page.ok) {
      return dropboxResourceUnavailable(page.error)
        ? { ok: true, value: { kind: "unavailable" } }
        : dropboxFailure(page.error);
    }
    for (const entry of page.value.entries) {
      if (entry.kind === "file") files.push(dropboxFile(entry));
    }
    cursor = page.value.cursor;
    if (files.length > FILE_GRANT_MAX_FILES || !page.value.hasMore) break;
  }
  if (cursor === null) return failure("dropbox_cursor_missing", false);
  return {
    ok: true,
    value: { kind: "snapshot", cursor: { kind: "dropbox", cursor }, files },
  };
}

async function observeDropboxFile(
  scope: Variant<FileResourceScope, "dropbox_file">,
  access: Variant<FileProviderAccess, "dropbox">,
  fetcher: typeof fetch,
): Promise<Result<ProviderReconciliation, ReconciliationError>> {
  const metadata = await readDropboxMetadata({
    accessToken: access.accessToken,
    providerFileId: scope.providerFileId,
    pathRootNamespaceId: access.homeNamespaceId,
    fetcher,
  });
  if (!metadata.ok) {
    return dropboxResourceMissing(metadata.error)
      ? { ok: true, value: emptyDropboxObservation("missing") }
      : dropboxFailure(metadata.error);
  }
  if (metadata.value.kind !== "file") {
    return failure("dropbox_granted_resource_not_file", false);
  }
  return {
    ok: true,
    value: {
      kind: "snapshot",
      cursor: {
        kind: "dropbox",
        cursor: `metadata:${metadata.value.revision.rev}`,
      },
      files: [dropboxFile(metadata.value)],
    },
  };
}

async function observeGoogleDriveFile(
  scope: Variant<FileResourceScope, "gdrive_file">,
  access: Variant<FileProviderAccess, "google_drive">,
  previousCursor: ProviderFileCursor | null,
  fetcher: typeof fetch,
): Promise<Result<ProviderReconciliation, ReconciliationError>> {
  let pageToken: string;
  if (previousCursor?.kind === "gdrive") {
    const change = await readGoogleDriveFileChange(
      scope.providerFileId,
      access,
      previousCursor.pageToken,
      fetcher,
    );
    if (!change.ok) return change;
    if (change.value.kind === "unavailable") return change;
    pageToken =
      change.value.cursor.kind === "gdrive"
        ? change.value.cursor.pageToken
        : previousCursor.pageToken;
  } else {
    const start = await readGoogleDriveStartPageToken({
      accessToken: access.accessToken,
      fetcher,
    });
    if (!start.ok) return googleDriveFailure(start.error);
    pageToken = start.value;
  }
  const metadata = await readGoogleDriveFileMetadata({
    accessToken: access.accessToken,
    providerFileId: scope.providerFileId,
    fetcher,
  });
  if (!metadata.ok) {
    return googleDriveResourceMissing(metadata.error)
      ? {
          ok: true,
          value: {
            kind: "snapshot",
            cursor: { kind: "gdrive", pageToken },
            files: [],
          },
        }
      : googleDriveFailure(metadata.error);
  }
  return {
    ok: true,
    value: {
      kind: "snapshot",
      cursor: { kind: "gdrive", pageToken },
      files: metadata.value.trashed ? [] : [googleDriveFile(metadata.value)],
    },
  };
}

async function readGoogleDriveFileChange(
  providerFileId: string,
  access: Variant<FileProviderAccess, "google_drive">,
  initialPageToken: string,
  fetcher: typeof fetch,
): Promise<Result<ProviderReconciliation, ReconciliationError>> {
  let pageToken = initialPageToken;
  let relevantChange = false;
  while (true) {
    const page = await listGoogleDriveChanges({
      accessToken: access.accessToken,
      pageToken,
      fetcher,
    });
    if (!page.ok) {
      if (
        page.error.code === "gdrive_http_rejected" &&
        page.error.status === 410
      ) {
        const reset = await readGoogleDriveStartPageToken({
          accessToken: access.accessToken,
          fetcher,
        });
        if (!reset.ok) return googleDriveFailure(reset.error);
        return {
          ok: true,
          value: {
            kind: "snapshot",
            cursor: { kind: "gdrive", pageToken: reset.value },
            files: [],
          },
        };
      }
      return googleDriveFailure(page.error);
    }
    relevantChange ||= page.value.changes.some(
      changeMatchesFile.bind(null, providerFileId),
    );
    if (page.value.nextPageToken !== null) {
      pageToken = page.value.nextPageToken;
      continue;
    }
    if (page.value.newStartPageToken === null) {
      return failure("gdrive_change_cursor_missing", false);
    }
    const cursor = {
      kind: "gdrive" as const,
      pageToken: page.value.newStartPageToken,
    };
    return {
      ok: true,
      value: relevantChange
        ? { kind: "snapshot", cursor, files: [] }
        : { kind: "unchanged", cursor },
    };
  }
}

function changeMatchesFile(
  providerFileId: string,
  change: GoogleDriveChange,
): boolean {
  return change.kind === "removed"
    ? change.providerFileId === providerFileId
    : change.file.providerFileId === providerFileId;
}

function createAdmission(
  grantId: string,
  grantRevision: number,
  scopeKey: string,
  fact: FileResourceSourceFact,
): FileGrantAdmission {
  return {
    grantId,
    grantRevision,
    integrationAccountId: fact.integrationAccountId,
    provider: fact.provider,
    providerFileId: fact.providerFileId,
    containingScopeKey: scopeKey,
    providerRevision: fact.providerRevision,
  };
}

function createOutboxCommand(
  scope: OrganisationExecutionScope,
  grantId: string,
  grantRevision: number,
  visibilityKey: string,
  fact: FileResourceSourceFact,
): Readonly<{
  readonly outboxId: string;
  readonly command: ReturnType<typeof createFileProjectionCommand>;
}> {
  const command = createFileProjectionCommand({
    organisationId: scope.organisationId,
    grantId,
    grantRevision,
    integrationAccountId: fact.integrationAccountId,
    provider: fact.provider,
    providerFileId: fact.providerFileId,
    sourceSequence: fact.sourceSequence,
    providerRevision: fact.providerRevision,
    visibilityKey,
  });
  return {
    outboxId: `${grantId}:${fact.providerFileId}:${fact.sourceSequence}:${visibilityKey}`,
    command,
  };
}

function dropboxFile(metadata: DropboxFileMetadata): ReconciledFile {
  return {
    provider: "dropbox",
    providerFileId: metadata.providerFileId,
    revision: metadata.revision,
    displayName: metadata.name,
    displayPath: metadata.pathDisplay,
    mediaType: metadata.mediaType,
    deepLink: dropboxDeepLink(metadata.pathDisplay),
  };
}

function googleDriveFile(metadata: GoogleDriveFileMetadata): ReconciledFile {
  return {
    provider: "google_drive",
    providerFileId: metadata.providerFileId,
    revision: metadata.revision,
    displayName: metadata.name,
    displayPath: metadata.name,
    mediaType: metadata.mediaType,
    deepLink:
      metadata.webViewLink || googleDriveDeepLink(metadata.providerFileId),
  };
}

function emptyDropboxObservation(reason: string): ProviderReconciliation {
  return {
    kind: "snapshot",
    cursor: { kind: "dropbox", cursor: `metadata:${reason}` },
    files: [],
  };
}

function providerForScope(scope: FileResourceScope): FileContextProvider {
  switch (scope.kind) {
    case "dropbox_folder":
    case "dropbox_file":
      return "dropbox";
    case "gdrive_file":
      return "google_drive";
  }
}

function retryDelayMs(attempt: number): number {
  return Math.min(
    60 * 60 * 1_000,
    5 * 60 * 1_000 * 2 ** Math.min(attempt - 1, 3),
  );
}

function dropboxResourceMissing(error: DropboxProtocolError): boolean {
  return dropboxResourceUnavailable(error);
}

function dropboxResourceUnavailable(error: DropboxProtocolError): boolean {
  return (
    error.code === "dropbox_http_rejected" &&
    (error.status === 401 ||
      error.status === 403 ||
      error.status === 404 ||
      error.status === 409)
  );
}

function googleDriveResourceMissing(error: GoogleDriveProtocolError): boolean {
  return (
    error.code === "gdrive_http_rejected" &&
    (error.status === 403 || error.status === 404)
  );
}

function dropboxFailure(
  error: DropboxProtocolError,
): Result<never, ReconciliationError> {
  return failure(error.code, error.retryable);
}

function googleDriveFailure(
  error: GoogleDriveProtocolError,
): Result<never, ReconciliationError> {
  return failure(error.code, error.retryable);
}

function accessFailure(
  error: FileProviderAccessError,
): Result<never, ReconciliationError> {
  return failure(error.code, error.retryable);
}

function failure(
  code: string,
  retryable: boolean,
): Result<never, ReconciliationError> {
  return { ok: false, error: { code, retryable } };
}
