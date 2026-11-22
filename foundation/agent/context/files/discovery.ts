import type { DropboxListEntry } from "../../provider-adapters/dropbox";
import { listDropboxFolder } from "../../provider-adapters/dropbox";
import type { Result } from "@purin-labs/kernel/result";
import type { FileProviderAccess } from "../../provider-workflows/file-context-credential";
import type { FileResourceDiscoveryEntry } from "@purin-labs/control-api";

const FILE_DISCOVERY_PAGE_SIZE = 100;
const FILE_DISCOVERY_QUERY_MAX_CHARS = 256;
const FILE_DISCOVERY_PATH_MAX_CHARS = 2_048;
const FILE_DISCOVERY_CURSOR_MAX_CHARS = 8_192;

export type FileResourceDiscoveryPage = Readonly<{
  readonly provider: "dropbox";
  readonly entries: readonly FileResourceDiscoveryEntry[];
  readonly nextCursor: string | null;
}>;

export type FileResourceDiscoveryError = Readonly<{
  readonly code:
    | "file_resource_discovery_invalid"
    | "file_resource_picker_required"
    | "file_resource_discovery_failed";
}>;

export async function discoverFileResources(
  input: Readonly<{
    readonly access: FileProviderAccess;
    readonly path: string;
    readonly query: string;
    readonly cursor: string | null;
    readonly fetcher: typeof fetch;
  }>,
): Promise<Result<FileResourceDiscoveryPage, FileResourceDiscoveryError>> {
  const request = parseDiscoveryRequest(input.path, input.query, input.cursor);
  if (request === null)
    return discoveryError("file_resource_discovery_invalid");
  switch (input.access.kind) {
    case "dropbox": {
      const page = await listDropboxFolder({
        accessToken: input.access.accessToken,
        path: request.path,
        cursor: request.cursor,
        recursive: false,
        limit: FILE_DISCOVERY_PAGE_SIZE,
        pathRootNamespaceId: input.access.homeNamespaceId,
        fetcher: input.fetcher,
      });
      if (!page.ok) return discoveryError("file_resource_discovery_failed");
      return {
        ok: true,
        value: {
          provider: "dropbox",
          entries: page.value.entries
            .filter(matchesQuery.bind(null, request.query))
            .map(discoveryEntry),
          nextCursor: page.value.hasMore ? page.value.cursor : null,
        },
      };
    }
    case "google_drive":
      return discoveryError("file_resource_picker_required");
  }
}

function parseDiscoveryRequest(
  path: string,
  query: string,
  cursor: string | null,
): Readonly<{
  readonly path: string;
  readonly query: string;
  readonly cursor: string | null;
}> | null {
  const normalizedPath = path.trim();
  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  if (
    normalizedPath.length > FILE_DISCOVERY_PATH_MAX_CHARS ||
    normalizedQuery.length > FILE_DISCOVERY_QUERY_MAX_CHARS ||
    (cursor !== null &&
      (cursor.length === 0 || cursor.length > FILE_DISCOVERY_CURSOR_MAX_CHARS))
  ) {
    return null;
  }
  return { path: normalizedPath, query: normalizedQuery, cursor };
}

function matchesQuery(query: string, entry: DropboxListEntry): boolean {
  return (
    query.length === 0 ||
    entry.name.toLocaleLowerCase("en-US").includes(query) ||
    entry.pathDisplay.toLocaleLowerCase("en-US").includes(query)
  );
}

function discoveryEntry(entry: DropboxListEntry): FileResourceDiscoveryEntry {
  switch (entry.kind) {
    case "folder":
      return {
        kind: "dropbox_folder",
        providerFolderId: entry.providerFolderId,
        name: entry.name,
        pathDisplay: entry.pathDisplay,
      };
    case "file":
      return {
        kind: "dropbox_file",
        providerFileId: entry.providerFileId,
        name: entry.name,
        pathDisplay: entry.pathDisplay,
      };
  }
}

function discoveryError(
  code: FileResourceDiscoveryError["code"],
): Result<never, FileResourceDiscoveryError> {
  return { ok: false, error: { code } };
}
