import {
  parseCommerceListEntryRef,
  parseCommerceViewPresentation,
  parseSavedCommerceViewId,
  parseSavedCommerceViewRevision,
  parseCommerceSnapshotRevision,
  parseCustomCommerceRelationshipRef,
} from "@purin-labs/commerce-client";
import type {
  CommerceEntityPlaneCommand,
  CommerceEntityPlaneError,
  CommerceGraphQuery,
  CommerceGraphQueryResult,
  CommerceSnapshotRevision,
  CommerceViewPresentation,
  SavedCommerceViewId,
  SavedCommerceViewRevision,
} from "@purin-labs/commerce-contracts";
import type { Result } from "@purin-labs/kernel/result";
import {
  assertCommerceEntityPlaneCommandWithLexicon,
  assertCommerceGraphQueryWithLexicon,
} from "../commerce-wasm";
import type { CommerceActivityReadRequest } from "./activity";
import type { CommerceGraphReader } from "./graph-reader";
import type { CommerceGraphReaderError } from "@purin-labs/area-commerce-contract/server/read-errors";
import type {
  CommerceGraphReadAuthority,
  CommerceGraphReadInput,
} from "@purin-labs/area-commerce-contract/server/graph-reads";
import type { Variant } from "@purin-labs/type-utils";
import { isRecord } from "@purin-labs/std";
import type {
  CommerceActivityResource,
  CommerceBoardDragPreview,
  CommerceBoardPresenceSelection,
} from "@purin-labs/commerce-control-api";

type CommerceGraphRouteError =
  CommerceEntityPlaneError | CommerceGraphReaderError;

type CommerceActivityRouteRequest = CommerceActivityReadRequest;

type CommerceActivityRouteError =
  | CommerceEntityPlaneError
  | Readonly<{
      code: "activity_source_unavailable";
      source: "blotter_history" | "action_ledger";
    }>;

type CommerceGraphChangesRequest = Readonly<{
  after: CommerceSnapshotRevision;
  limit: number;
}>;

export type CommerceListEntryPatchCommand = Variant<
  CommerceEntityPlaneCommand,
  "patch_commerce_list_entry"
>;

export type SavedCommerceViewPresentationPatch = Readonly<{
  viewId: SavedCommerceViewId;
  expectedRevision: SavedCommerceViewRevision;
  presentation: CommerceViewPresentation;
}>;

type CommerceBoardPresenceRouteBody = Readonly<{
  resourceKey: string;
  selection: CommerceBoardPresenceSelection;
  dragPreview: CommerceBoardDragPreview;
}>;

type CommerceGraphRouteInput = Readonly<{
  body: unknown;
  reader: CommerceGraphReader;
  authority: CommerceGraphReadAuthority;
  now: string;
}>;

/** Parses the shared entity-plane query grammar at the Platform boundary. */
export function parseCommerceGraphQuery(
  value: unknown,
): Result<CommerceGraphQuery, CommerceEntityPlaneError> {
  try {
    assertCommerceGraphQueryWithLexicon(value);
    validateQueryBounds(value);
    return { ok: true, value };
  } catch {
    return { ok: false, error: { code: "invalid_query" } };
  }
}

function validateQueryBounds(query: CommerceGraphQuery): void {
  if (
    query.kind === "commerce_context" &&
    query.selection.kind === "entity_seeds" &&
    query.selection.seeds.length === 0
  ) {
    throw new Error("context seeds are required");
  }
}

export function parseCommerceGraphRouteBody(
  value: unknown,
): Result<CommerceGraphQuery, CommerceEntityPlaneError> {
  return parseCommerceGraphQuery(
    isRecord(value) && "query" in value ? value.query : value,
  );
}

export function parseCommerceGraphChangesRequest(
  searchParams: URLSearchParams,
): Result<CommerceGraphChangesRequest, CommerceEntityPlaneError> {
  const afterNumber = Number(searchParams.get("after") ?? "0");
  const limit = Number(searchParams.get("limit") ?? "100");
  if (
    !Number.isSafeInteger(afterNumber) ||
    afterNumber < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    return { ok: false, error: { code: "invalid_query" } };
  }
  try {
    return {
      ok: true,
      value: { after: parseCommerceSnapshotRevision(afterNumber), limit },
    };
  } catch {
    return { ok: false, error: { code: "invalid_query" } };
  }
}

export function parseCommerceListEntryPatchRouteBody(
  value: unknown,
  entryId: string,
): Result<CommerceListEntryPatchCommand, CommerceEntityPlaneError> {
  if (!isRecord(value) || !hasExactFields(value, ["kind", "command"])) {
    return { ok: false, error: { code: "invalid_query" } };
  }
  try {
    assertCommerceEntityPlaneCommandWithLexicon(value);
    const command = value;
    if (
      command.kind !== "patch_commerce_list_entry" ||
      command.command.target.entry.entryId !== entryId
    ) {
      return { ok: false, error: { code: "invalid_query" } };
    }
    return { ok: true, value: command };
  } catch {
    return { ok: false, error: { code: "invalid_query" } };
  }
}

export function parseSavedCommerceViewPresentationPatchRouteBody(
  value: unknown,
  viewId: string,
): Result<SavedCommerceViewPresentationPatch, CommerceEntityPlaneError> {
  if (
    !isRecord(value) ||
    Object.keys(value).some(isUnsupportedSavedViewPatchField)
  ) {
    return { ok: false, error: { code: "invalid_query" } };
  }
  try {
    const parsedViewId = parseSavedCommerceViewId(viewId);
    return {
      ok: true,
      value: {
        viewId: parsedViewId,
        expectedRevision: parseSavedCommerceViewRevision(
          value.expectedRevision,
        ),
        presentation: parseCommerceViewPresentation(value.presentation),
      },
    };
  } catch {
    return { ok: false, error: { code: "invalid_query" } };
  }
}

function isUnsupportedSavedViewPatchField(field: string): boolean {
  return field !== "expectedRevision" && field !== "presentation";
}

export function parseCommerceBoardPresenceRouteBody(
  value: unknown,
): Result<CommerceBoardPresenceRouteBody, CommerceEntityPlaneError> {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["resourceKey", "selection", "dragPreview"])
  ) {
    return { ok: false, error: { code: "invalid_query" } };
  }
  const resourceKey = boundedRouteText(value.resourceKey, 256);
  const selection = parseCommerceBoardPresenceSelection(value.selection);
  const dragPreview = parseCommerceBoardDragPreview(value.dragPreview);
  return resourceKey === null || selection === null || dragPreview === null
    ? { ok: false, error: { code: "invalid_query" } }
    : { ok: true, value: { resourceKey, selection, dragPreview } };
}

function parseCommerceBoardPresenceSelection(
  value: unknown,
): CommerceBoardPresenceSelection | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "none")
    return hasExactFields(value, ["kind"]) ? { kind: "none" } : null;
  if (
    value.kind !== "list_entry" ||
    !hasExactFields(value, ["kind", "entryId", "listId"])
  )
    return null;
  const entryId = boundedRouteText(value.entryId, 256);
  const listId = boundedRouteText(value.listId, 256);
  return entryId === null || listId === null
    ? null
    : { kind: value.kind, entryId, listId };
}

function parseCommerceBoardDragPreview(
  value: unknown,
): CommerceBoardDragPreview | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "idle")
    return hasExactFields(value, ["kind"]) ? { kind: "idle" } : null;
  if (
    value.kind !== "moving" ||
    !hasExactFields(value, ["kind", "entryId", "desiredStatusId"])
  )
    return null;
  const entryId = boundedRouteText(value.entryId, 256);
  const desiredStatusId =
    value.desiredStatusId === null
      ? null
      : boundedRouteText(value.desiredStatusId, 256);
  return entryId === null ||
    (value.desiredStatusId !== null && desiredStatusId === null)
    ? null
    : { kind: value.kind, entryId, desiredStatusId };
}

function boundedRouteText(value: unknown, maximum: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim()
    ? value
    : null;
}

function hasExactFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): boolean {
  const keys = Object.keys(value);
  if (keys.length !== fields.length) return false;
  for (const key of keys) {
    if (!fields.includes(key)) return false;
  }
  return true;
}

export function parseCommerceActivityRouteBody(
  value: unknown,
): Result<CommerceActivityRouteRequest, CommerceEntityPlaneError> {
  if (!isRecord(value)) return { ok: false, error: { code: "invalid_query" } };
  const resource = parseActivityResource(value.resource);
  if (resource === null) return { ok: false, error: { code: "invalid_query" } };
  const limit =
    value.limit === undefined ? 50 : parseActivityLimit(value.limit);
  return limit === null
    ? { ok: false, error: { code: "invalid_query" } }
    : { ok: true, value: { resource, limit } };
}

function parseActivityResource(
  value: unknown,
): CommerceActivityResource | null {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !isRecord(value.reference)
  )
    return null;
  if (value.kind === "entity") {
    try {
      const query: unknown = {
        kind: "entity_by_ref",
        reference: value.reference,
        traversal: { maxDepth: 1, resultLimit: 1 },
        filter: null,
      };
      assertCommerceGraphQueryWithLexicon(query);
      return query.kind === "entity_by_ref"
        ? { kind: "entity", reference: query.reference }
        : null;
    } catch {
      return null;
    }
  }
  if (value.kind === "relationship") {
    try {
      return {
        kind: "relationship",
        reference: parseCustomCommerceRelationshipRef(value.reference),
      };
    } catch {
      return null;
    }
  }
  if (value.kind !== "list_entry") return null;
  try {
    return {
      kind: "list_entry",
      reference: parseCommerceListEntryRef(value.reference),
    };
  } catch {
    return null;
  }
}

function parseActivityLimit(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 100
    ? value
    : null;
}

export function handleCommerceGraphRoute(
  input: CommerceGraphRouteInput,
): Promise<Result<CommerceGraphQueryResult, CommerceGraphRouteError>> {
  const query = parseCommerceGraphRouteBody(input.body);
  if (!query.ok) return Promise.resolve(query);
  const read: CommerceGraphReadInput = {
    query: query.value,
    authority: input.authority,
    now: input.now,
  };
  return input.reader.query(read);
}

export function commerceGraphErrorStatus(
  error: CommerceGraphRouteError,
): number {
  switch (error.code) {
    case "invalid_query":
    case "invalid_identity":
    case "invalid_revision":
    case "invalid_date":
    case "invalid_text":
    case "invalid_attribute_value":
    case "attribute_definition_mismatch":
    case "invalid_relationship_endpoint":
    case "relationship_definition_mismatch":
    case "system_relationship_immutable":
    case "invalid_list_entry_entity_type":
    case "invalid_view_source":
    case "invalid_view_presentation":
    case "parse":
    case "commerce_query_surface_unsupported":
    case "commerce_query_unsupported":
      return 422;
    case "commerce_cursor_mismatch":
    case "commerce_cursor_stale":
      return 409;
    case "authority_expired":
      return 401;
    case "authority_out_of_scope":
    case "sensitivity_denied":
      return 403;
    case "not_found":
    case "commerce_system_not_found":
      return 404;
    case "blotter_source_missing":
    case "source_unavailable":
    case "source_invalid":
      return 503;
    default:
      return 422;
  }
}

export function commerceActivityErrorStatus(
  error: CommerceActivityRouteError,
): number {
  switch (error.code) {
    case "invalid_query":
      return 422;
    case "activity_source_unavailable":
      return 503;
    default:
      return 422;
  }
}

export function commerceGraphResponseBody(
  result: CommerceGraphQueryResult,
): Readonly<{
  ok: true;
  result: unknown;
}> {
  return { ok: true, result: jsonSafe(result) };
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value))
    result[key] = jsonSafe(child);
  return result;
}
