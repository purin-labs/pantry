import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { fetchWithOrganisationPlacement } from "@purin-labs/tenancy/organisation-execution-scope";
import type { FileResourceAccessGrantTarget } from "@purin-labs/authority/authorization/access-grants/types";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { parseIntegrationAccountId } from "@purin-labs/kernel/ids";
import {
  readDropboxMetadata,
  type DropboxListEntry,
} from "../../provider-adapters/dropbox";
import { readGoogleDriveFileMetadata } from "../../provider-adapters/google-drive";
import {
  resolveFileProviderAccess,
  storeFilePlacementCredential,
} from "../../provider-workflows/file-context-credential";
import type { Result } from "@purin-labs/kernel/result";
import type { FileContextProvider } from "@purin-labs/contracts";

import type { FileGrantValidationError } from "@purin-labs/authority/authorization/access-grants/file-grant-parts";
export type { FileGrantValidationError } from "@purin-labs/authority/authorization/access-grants/file-grant-parts";

export async function validateFileGrantTarget(
  input: Readonly<{
    readonly env: Env;
    readonly scope: OrganisationExecutionScope;
    readonly target: FileResourceAccessGrantTarget;
    readonly now: number;
  }>,
): Promise<Result<FileResourceAccessGrantTarget, FileGrantValidationError>> {
  const fetcher = fetchWithOrganisationPlacement.bind(
    null,
    input.scope,
    runtimeFetch,
  );
  const provider = providerForScope(input.target.scope);
  const integrationAccountId = parseIntegrationAccountId(
    input.target.integrationAccountId,
  );
  if (!integrationAccountId.ok) return identityMismatch();
  const access = await resolveFileProviderAccess({
    env: input.env,
    db: input.scope.database,
    storeCredential: storeFilePlacementCredential.bind(
      null,
      input.env,
      input.scope,
    ),
    organisationId: input.scope.organisationId,
    integrationAccountId: integrationAccountId.value,
    provider,
    fetcher,
    now: input.now,
  });
  if (!access.ok) return inaccessible();
  switch (access.value.kind) {
    case "dropbox": {
      if (provider !== "dropbox") return identityMismatch();
      const providerResourceId = dropboxResourceId(input.target);
      if (providerResourceId === null) return identityMismatch();
      const metadata = await readDropboxMetadata({
        accessToken: access.value.accessToken,
        providerFileId: providerResourceId,
        pathRootNamespaceId: access.value.homeNamespaceId,
        fetcher,
      });
      if (!metadata.ok) return inaccessible();
      return normalizeDropboxTarget(input.target, metadata.value);
    }
    case "google_drive": {
      if (
        provider !== "google_drive" ||
        input.target.scope.kind !== "gdrive_file"
      ) {
        return identityMismatch();
      }
      const metadata = await readGoogleDriveFileMetadata({
        accessToken: access.value.accessToken,
        providerFileId: input.target.scope.providerFileId,
        fetcher,
      });
      if (
        !metadata.ok ||
        metadata.value.trashed ||
        metadata.value.providerFileId !== input.target.scope.providerFileId
      ) {
        return inaccessible();
      }
      return {
        ok: true,
        value: {
          ...input.target,
          scope: {
            kind: "gdrive_file",
            providerFileId: metadata.value.providerFileId,
            name: metadata.value.name,
          },
        },
      };
    }
  }
}

function providerForScope(
  scope: FileResourceAccessGrantTarget["scope"],
): FileContextProvider {
  switch (scope.kind) {
    case "dropbox_folder":
    case "dropbox_file":
      return "dropbox";
    case "gdrive_file":
      return "google_drive";
  }
}

function dropboxResourceId(
  target: FileResourceAccessGrantTarget,
): string | null {
  switch (target.scope.kind) {
    case "dropbox_folder":
      return target.scope.providerFolderId;
    case "dropbox_file":
      return target.scope.providerFileId;
    case "gdrive_file":
      return null;
  }
}

function normalizeDropboxTarget(
  target: FileResourceAccessGrantTarget,
  metadata: DropboxListEntry,
): Result<FileResourceAccessGrantTarget, FileGrantValidationError> {
  switch (target.scope.kind) {
    case "dropbox_folder":
      return metadata.kind === "folder" &&
        metadata.providerFolderId === target.scope.providerFolderId
        ? {
            ok: true,
            value: {
              ...target,
              scope: {
                kind: "dropbox_folder",
                providerFolderId: metadata.providerFolderId,
                pathDisplay: metadata.pathDisplay,
              },
            },
          }
        : identityMismatch();
    case "dropbox_file":
      return metadata.kind === "file" &&
        metadata.providerFileId === target.scope.providerFileId
        ? {
            ok: true,
            value: {
              ...target,
              scope: {
                kind: "dropbox_file",
                providerFileId: metadata.providerFileId,
                pathDisplay: metadata.pathDisplay,
              },
            },
          }
        : identityMismatch();
    case "gdrive_file":
      return identityMismatch();
  }
}

function inaccessible(): Result<never, FileGrantValidationError> {
  return { ok: false, error: { code: "provider_resource_not_accessible" } };
}

function identityMismatch(): Result<never, FileGrantValidationError> {
  return { ok: false, error: { code: "provider_resource_identity_mismatch" } };
}
