import { parseIntegrationAccountId } from "@purin-labs/kernel/ids";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import { hasExactKeys, isRecord } from "@purin-labs/std";
import type {
  FileRead,
  FileSearch,
  HarnessFileRead,
  HarnessFileSearch,
  HarnessWorkspaceQuery,
  WorkspaceQuery,
} from "../catalog/types";
import { defineToolFamily, jsonSchema } from "../define-tool";

/** What a turn gives to the file and workspace tools. */
export type FileToolServices = {
  readonly searchFiles: FileSearch;
  readonly readFile: FileRead;
  readonly queryWorkspace: WorkspaceQuery;
};

const defineFileTool = defineToolFamily<FileToolServices>()("files");

export const fileSearch = defineFileTool({
  name: "file_search",
  description:
    "Search bounded text and metadata for files granted to the current Case authority. " +
    "Returns canonical file references and citation links without contacting the provider.",
  input: jsonSchema({
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 256 },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["query", "limit"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseFileSearchArgs([input]),
  effect: "read",
  rerun: { kind: "none" },
  selection: { kind: "capability", capability: CAPABILITY_KEYS.fileRead },
  unavailable: "file search is unavailable",
  handler: ({ searchFiles }) =>
    searchFiles === undefined ? undefined : (request) => searchFiles(request),
});

export const fileRead = defineFileTool({
  name: "file_read",
  description:
    "Read up to eight contiguous segments from one canonical granted file reference. " +
    "Use the returned continuation when more content remains.",
  input: jsonSchema({
    type: "object",
    properties: {
      reference: {
        type: "object",
        properties: {
          integrationAccountId: { type: "string", minLength: 1 },
          provider: { type: "string", enum: ["dropbox", "google_drive"] },
          providerFileId: { type: "string", minLength: 1 },
        },
        required: ["integrationAccountId", "provider", "providerFileId"],
        additionalProperties: false,
      },
      startSegment: { type: "integer", minimum: 0 },
    },
    required: ["reference", "startSegment"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseFileReadArgs([input]),
  effect: "read",
  rerun: { kind: "none" },
  selection: { kind: "capability", capability: CAPABILITY_KEYS.fileRead },
  unavailable: "file read is unavailable",
  handler: ({ readFile }) =>
    readFile === undefined ? undefined : (request) => readFile(request),
});

export const workspaceQuery = defineFileTool({
  name: "workspace_query",
  description:
    "Read one exact file or search text in the current immutable workspace revision. " +
    "For read use { kind: 'read', path, query: null, limit: null }. " +
    "For search use { kind: 'search', path: null, query, limit }.",
  input: jsonSchema({
    type: "object",
    properties: {
      kind: { type: "string", enum: ["read", "search"] },
      path: { type: ["string", "null"], minLength: 1, maxLength: 512 },
      query: { type: ["string", "null"], minLength: 1, maxLength: 128 },
      limit: { type: ["integer", "null"], minimum: 1, maximum: 20 },
    },
    required: ["kind", "path", "query", "limit"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseWorkspaceQueryArgs([input]),
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: { kind: "capability", capability: CAPABILITY_KEYS.workspaceQuery },
  unavailable: "workspace query is unavailable",
  handler: ({ queryWorkspace }) =>
    queryWorkspace === undefined ? undefined : (request) => queryWorkspace(request),
});

function parseFileSearchArgs(args: readonly unknown[]): HarnessFileSearch {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["query", "limit"]) ||
    typeof args[0].query !== "string" ||
    args[0].query.trim().length === 0 ||
    Array.from(args[0].query.normalize("NFKC")).length > 256 ||
    typeof args[0].limit !== "number" ||
    !Number.isSafeInteger(args[0].limit) ||
    args[0].limit < 1 ||
    args[0].limit > 20
  ) {
    throw new TypeError("file_search arguments are invalid");
  }
  return { query: args[0].query, limit: args[0].limit };
}

function parseFileReadArgs(args: readonly unknown[]): HarnessFileRead {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["reference", "startSegment"]) ||
    !isRecord(args[0].reference) ||
    !hasExactKeys(args[0].reference, [
      "integrationAccountId",
      "provider",
      "providerFileId",
    ]) ||
    typeof args[0].reference.integrationAccountId !== "string" ||
    (args[0].reference.provider !== "dropbox" &&
      args[0].reference.provider !== "google_drive") ||
    typeof args[0].reference.providerFileId !== "string" ||
    args[0].reference.providerFileId.trim().length === 0 ||
    typeof args[0].startSegment !== "number" ||
    !Number.isSafeInteger(args[0].startSegment) ||
    args[0].startSegment < 0
  ) {
    throw new TypeError("file_read arguments are invalid");
  }
  const integrationAccountId = parseIntegrationAccountId(
    args[0].reference.integrationAccountId,
  );
  if (!integrationAccountId.ok) {
    throw new TypeError("file_read account is invalid");
  }
  return {
    reference: {
      integrationAccountId: integrationAccountId.value,
      provider: args[0].reference.provider,
      providerFileId: args[0].reference.providerFileId,
    },
    startSegment: args[0].startSegment,
  };
}

function parseWorkspaceQueryArgs(
  args: readonly unknown[],
): HarnessWorkspaceQuery {
  if (args.length !== 1 || !isRecord(args[0])) {
    throw new TypeError("workspace_query requires one object argument");
  }
  const keys = Object.keys(args[0]);
  if (
    keys.length !== 4 ||
    !Object.hasOwn(args[0], "path") ||
    !Object.hasOwn(args[0], "query") ||
    !Object.hasOwn(args[0], "limit")
  ) {
    throw new TypeError(
      "workspace_query accepts only kind, path, query, and limit",
    );
  }
  if (args[0].kind === "read") {
    if (
      typeof args[0].path !== "string" ||
      args[0].path.length === 0 ||
      args[0].path.length > 512 ||
      args[0].query !== null ||
      args[0].limit !== null
    ) {
      throw new TypeError("workspace_query read arguments are invalid");
    }
    return { kind: "read", path: args[0].path };
  }
  if (args[0].kind === "search") {
    if (
      args[0].path !== null ||
      typeof args[0].query !== "string" ||
      args[0].query.length === 0 ||
      args[0].query.length > 128 ||
      typeof args[0].limit !== "number" ||
      !Number.isSafeInteger(args[0].limit) ||
      args[0].limit < 1 ||
      args[0].limit > 20
    ) {
      throw new TypeError("workspace_query search arguments are invalid");
    }
    return {
      kind: "search",
      query: args[0].query,
      limit: args[0].limit,
    };
  }
  throw new TypeError("workspace_query kind is invalid");
}
