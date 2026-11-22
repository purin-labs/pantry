import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { Env } from "@purin-labs/kernel/env";
import {
  downloadDropboxFile,
  dropboxDeepLink,
  exportDropboxFile,
  readDropboxMetadata,
  type DropboxFileMetadata,
  type DropboxProtocolError,
} from "../../provider-adapters/dropbox";
import {
  downloadGoogleDriveFile,
  exportGoogleDriveFile,
  googleDriveExportMediaType,
  readGoogleDriveFileMetadata,
  type GoogleDriveFileMetadata,
  type GoogleDriveProtocolError,
} from "../../provider-adapters/google-drive";
import {
  resolveFileProviderAccess,
  type FileProviderAccess,
  type FileProviderAccessError,
  type FileProviderCredentialStore,
} from "../../provider-workflows/file-context-credential";
import type { Result } from "@purin-labs/kernel/result";
import { FILE_SOURCE_MAX_BYTES, type FileProjectionCommand } from "./domain";
import type {
  FileProjectionMetadata,
  FileProjectionSourceError,
  FileProjectionSourceReader,
} from "./projection";
import type { Variant } from "@purin-labs/type-utils";

export class ProviderFileProjectionSourceReader implements FileProjectionSourceReader {
  readonly #env: Env;
  readonly #db: OrganisationDatabase;
  readonly #storeCredential: FileProviderCredentialStore;
  readonly #command: FileProjectionCommand;
  readonly #fetcher: typeof fetch;
  readonly #now: number;
  #access: Promise<Result<FileProviderAccess, FileProviderAccessError>> | null =
    null;

  constructor(
    input: Readonly<{
      readonly env: Env;
      readonly db: OrganisationDatabase;
      readonly storeCredential: FileProviderCredentialStore;
      readonly command: FileProjectionCommand;
      readonly fetcher: typeof fetch;
      readonly now: number;
    }>,
  ) {
    this.#env = input.env;
    this.#db = input.db;
    this.#storeCredential = input.storeCredential;
    this.#command = input.command;
    this.#fetcher = input.fetcher;
    this.#now = input.now;
  }

  async readMetadata(
    command: FileProjectionCommand,
  ): Promise<Result<FileProjectionMetadata, FileProjectionSourceError>> {
    if (!sameCommandIdentity(this.#command, command)) {
      return sourceFailure("file_projection_command_identity_mismatch", false);
    }
    const access = await this.resolveAccess();
    if (!access.ok) return accessFailure(access.error);
    switch (access.value.kind) {
      case "dropbox":
        return command.provider === "dropbox"
          ? this.readDropboxProjectionMetadata(command, access.value)
          : sourceFailure("file_provider_scope_mismatch", false);
      case "google_drive":
        return command.provider === "google_drive"
          ? this.readGoogleDriveProjectionMetadata(command, access.value)
          : sourceFailure("file_provider_scope_mismatch", false);
    }
  }

  async readTextContent(
    input: Readonly<{
      readonly command: FileProjectionCommand;
      readonly metadata: FileProjectionMetadata &
        Readonly<{
          readonly extraction: Readonly<{ readonly kind: "text" }>;
        }>;
      readonly maximumBytes: number;
    }>,
  ): Promise<Result<Uint8Array, FileProjectionSourceError>> {
    if (!sameCommandIdentity(this.#command, input.command)) {
      return sourceFailure("file_projection_command_identity_mismatch", false);
    }
    const access = await this.resolveAccess();
    if (!access.ok) return accessFailure(access.error);
    switch (access.value.kind) {
      case "dropbox":
        return input.command.provider === "dropbox"
          ? this.readDropboxText(input, access.value)
          : sourceFailure("file_provider_scope_mismatch", false);
      case "google_drive":
        return input.command.provider === "google_drive"
          ? this.readGoogleDriveText(input, access.value)
          : sourceFailure("file_provider_scope_mismatch", false);
    }
  }

  async readDropboxFolderPath(
    providerFolderId: string,
  ): Promise<Result<string, FileProjectionSourceError>> {
    if (this.#command.provider !== "dropbox") {
      return sourceFailure("file_provider_scope_mismatch", false);
    }
    const access = await this.resolveAccess();
    if (!access.ok) return accessFailure(access.error);
    if (access.value.kind !== "dropbox") {
      return sourceFailure("file_provider_scope_mismatch", false);
    }
    const metadata = await readDropboxMetadata({
      accessToken: access.value.accessToken,
      providerFileId: providerFolderId,
      pathRootNamespaceId: access.value.homeNamespaceId,
      fetcher: this.#fetcher,
    });
    if (!metadata.ok) return dropboxFailure(metadata.error);
    return metadata.value.kind === "folder"
      ? { ok: true, value: metadata.value.pathDisplay }
      : sourceFailure("dropbox_granted_resource_not_folder", false);
  }

  private resolveAccess(): Promise<
    Result<FileProviderAccess, FileProviderAccessError>
  > {
    this.#access ??= resolveFileProviderAccess({
      env: this.#env,
      db: this.#db,
      storeCredential: this.#storeCredential,
      organisationId: this.#command.organisationId,
      integrationAccountId: this.#command.integrationAccountId,
      provider: this.#command.provider,
      fetcher: this.#fetcher,
      now: this.#now,
    });
    return this.#access;
  }

  private async readDropboxProjectionMetadata(
    command: FileProjectionCommand,
    access: Variant<FileProviderAccess, "dropbox">,
  ): Promise<Result<FileProjectionMetadata, FileProjectionSourceError>> {
    const metadata = await readDropboxMetadata({
      accessToken: access.accessToken,
      providerFileId: command.providerFileId,
      pathRootNamespaceId: access.homeNamespaceId,
      fetcher: this.#fetcher,
    });
    if (!metadata.ok) return dropboxFailure(metadata.error);
    if (metadata.value.kind !== "file") {
      return sourceFailure("dropbox_projection_source_not_file", false);
    }
    return {
      ok: true,
      value: projectionMetadataFromDropbox(metadata.value),
    };
  }

  private async readGoogleDriveProjectionMetadata(
    command: FileProjectionCommand,
    access: Variant<FileProviderAccess, "google_drive">,
  ): Promise<Result<FileProjectionMetadata, FileProjectionSourceError>> {
    const metadata = await readGoogleDriveFileMetadata({
      accessToken: access.accessToken,
      providerFileId: command.providerFileId,
      fetcher: this.#fetcher,
    });
    if (!metadata.ok) return googleDriveFailure(metadata.error);
    if (metadata.value.trashed) {
      return sourceFailure("gdrive_file_unavailable", false);
    }
    return {
      ok: true,
      value: projectionMetadataFromGoogleDrive(metadata.value),
    };
  }

  private async readDropboxText(
    input: Readonly<{
      readonly command: FileProjectionCommand;
      readonly metadata: FileProjectionMetadata;
      readonly maximumBytes: number;
    }>,
    access: Variant<FileProviderAccess, "dropbox">,
  ): Promise<Result<Uint8Array, FileProjectionSourceError>> {
    if (input.command.providerRevision.kind !== "dropbox") {
      return sourceFailure("dropbox_projection_revision_mismatch", false);
    }
    const current = await readDropboxMetadata({
      accessToken: access.accessToken,
      providerFileId: input.command.providerFileId,
      pathRootNamespaceId: access.homeNamespaceId,
      fetcher: this.#fetcher,
    });
    if (!current.ok) return dropboxFailure(current.error);
    if (current.value.kind !== "file") {
      return sourceFailure("dropbox_projection_source_not_file", false);
    }
    const content = current.value.downloadable
      ? await downloadDropboxFile({
          accessToken: access.accessToken,
          providerFileId: input.command.providerFileId,
          expectedRevision: input.command.providerRevision.rev,
          pathRootNamespaceId: access.homeNamespaceId,
          maximumBytes: input.maximumBytes,
          fetcher: this.#fetcher,
        })
      : await exportDropboxFile({
          accessToken: access.accessToken,
          providerFileId: input.command.providerFileId,
          exportFormat: "txt",
          pathRootNamespaceId: access.homeNamespaceId,
          maximumBytes: input.maximumBytes,
          fetcher: this.#fetcher,
        });
    if (!content.ok) return dropboxFailure(content.error);
    return content.value.metadata.revision.rev ===
      input.command.providerRevision.rev
      ? { ok: true, value: content.value.bytes }
      : sourceFailure("dropbox_revision_changed", true);
  }

  private async readGoogleDriveText(
    input: Readonly<{
      readonly command: FileProjectionCommand;
      readonly metadata: FileProjectionMetadata;
      readonly maximumBytes: number;
    }>,
    access: Variant<FileProviderAccess, "google_drive">,
  ): Promise<Result<Uint8Array, FileProjectionSourceError>> {
    if (input.command.providerRevision.kind !== "gdrive") {
      return sourceFailure("gdrive_projection_revision_mismatch", false);
    }
    const exportMediaType = googleDriveExportMediaType(
      input.metadata.mediaType,
    );
    const content =
      exportMediaType === null
        ? await downloadGoogleDriveFile({
            accessToken: access.accessToken,
            providerFileId: input.command.providerFileId,
            expectedRevision: input.command.providerRevision,
            maximumBytes: input.maximumBytes,
            fetcher: this.#fetcher,
          })
        : await exportGoogleDriveFile({
            accessToken: access.accessToken,
            providerFileId: input.command.providerFileId,
            expectedRevision: input.command.providerRevision,
            exportMediaType,
            maximumBytes: input.maximumBytes,
            fetcher: this.#fetcher,
          });
    return content.ok
      ? { ok: true, value: content.value.bytes }
      : googleDriveFailure(content.error);
  }
}

function projectionMetadataFromDropbox(
  metadata: DropboxFileMetadata,
): FileProjectionMetadata {
  return {
    displayName: metadata.name,
    displayPath: metadata.pathDisplay,
    mediaType: metadata.mediaType,
    deepLink: dropboxDeepLink(metadata.pathDisplay),
    sourceBytes: metadata.byteLength,
    providerRevision: metadata.revision,
    extraction: fileExtraction(
      metadata.mediaType,
      metadata.byteLength,
      !metadata.downloadable,
    ),
  };
}

function projectionMetadataFromGoogleDrive(
  metadata: GoogleDriveFileMetadata,
): FileProjectionMetadata {
  const sourceBytes = metadata.byteLength ?? FILE_SOURCE_MAX_BYTES;
  return {
    displayName: metadata.name,
    displayPath: metadata.name,
    mediaType: metadata.mediaType,
    deepLink: metadata.webViewLink,
    sourceBytes,
    providerRevision: metadata.revision,
    extraction: fileExtraction(
      metadata.mediaType,
      sourceBytes,
      googleDriveExportMediaType(metadata.mediaType) !== null,
    ),
  };
}

function fileExtraction(
  mediaType: string,
  sourceBytes: number,
  providerExportable: boolean,
): FileProjectionMetadata["extraction"] {
  if (sourceBytes > FILE_SOURCE_MAX_BYTES) {
    return { kind: "metadata_only", reason: "file_source_too_large" };
  }
  return providerExportable ||
    mediaType === "text/plain" ||
    mediaType === "text/markdown" ||
    mediaType === "text/csv"
    ? { kind: "text" }
    : { kind: "metadata_only", reason: "unsupported_media_type" };
}

function sameCommandIdentity(
  expected: FileProjectionCommand,
  actual: FileProjectionCommand,
): boolean {
  return (
    expected.organisationId === actual.organisationId &&
    expected.grantId === actual.grantId &&
    expected.grantRevision === actual.grantRevision &&
    expected.integrationAccountId === actual.integrationAccountId &&
    expected.provider === actual.provider &&
    expected.providerFileId === actual.providerFileId &&
    expected.sourceSequence === actual.sourceSequence &&
    expected.visibilityKey === actual.visibilityKey
  );
}

function dropboxFailure(
  error: DropboxProtocolError,
): Result<never, FileProjectionSourceError> {
  return sourceFailure(error.code, error.retryable);
}

function googleDriveFailure(
  error: GoogleDriveProtocolError,
): Result<never, FileProjectionSourceError> {
  return sourceFailure(error.code, error.retryable);
}

function accessFailure(
  error: FileProviderAccessError,
): Result<never, FileProjectionSourceError> {
  return sourceFailure(error.code, error.retryable);
}

function sourceFailure(
  code: string,
  retryable: boolean,
): Result<never, FileProjectionSourceError> {
  return { ok: false, error: { code, retryable } };
}
