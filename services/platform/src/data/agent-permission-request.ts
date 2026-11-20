import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "../database-handles";
import type { RequestAuthority } from "@purin-labs/contracts";
import { isNonNegativeInteger, isRecord } from "@purin-labs/std";
import { parseStoredRequestAuthority } from "../request-authority";
import type { Variant } from "@purin-labs/type-utils";
import type { Result } from "../result";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  isRequestableCapability,
  isRequestableEntityTypeRead,
  type RequestableCapability,
  type RequestableEntityTypeRead,
} from "../authorization/requestable-capabilities";

/**
 * What an agent turn asked a person to allow. It holds no model text: only
 * the capabilities, the record-type reads, where it was asked and the
 * requester. An owner or admin decides it in the Portal. An allowed Slack
 * request continues in a new turn of the same thread; an allowed Portal chat
 * request lets the paused chat run its step again.
 */
type AgentPermissionRequestStatus = "pending" | "allowed" | "denied";

export type AgentPermissionRequesterRole =
  | "owner"
  | "admin"
  | "operator"
  | "viewer";

export type AgentPermissionRequest = Readonly<{
  organisationId: string;
  requestId: string;
  caseId: string;
  origin: AgentPermissionOrigin;
  sessionId: string;
  turnId: string;
  requesterPersonId: string;
  requesterUserId: string | null;
  requesterRole: AgentPermissionRequesterRole;
  /** The authority of the asking turn; an allow is checked against it. */
  requestAuthority: RequestAuthority;
  capabilityIds: readonly RequestableCapability[];
  /** Record types that the requester's role must be able to read. */
  entityTypeReads: readonly RequestableEntityTypeRead[];
  status: AgentPermissionRequestStatus;
  decidedByUserId: string | null;
  createdAt: number;
  decidedAt: number | null;
  /** When the decision reached the asking turn; null while it waits. */
  releasedAt: number | null;
}>;

/** Where an agent turn asked. */
type AgentPermissionOrigin =
  | Readonly<{
      kind: "slack_thread";
      connectorId: string;
      slackWorkspaceId: string;
      slackChannelId: string;
      slackThreadTs: string;
    }>
  | Readonly<{ kind: "portal_chat" }>;

/** A request older than this can no longer be decided. */
export const AGENT_PERMISSION_REQUEST_LIFETIME_MS = 7 * 24 * 60 * 60_000;

type StoreError = Readonly<{ code: "agent_permission_store_failed" }>;

const COLUMNS = `organisation_id AS organisationId, request_id AS requestId,
  origin, case_id AS caseId, connector_id AS connectorId,
  session_id AS sessionId,
  turn_id AS turnId, requester_person_id AS requesterPersonId,
  requester_user_id AS requesterUserId, requester_role AS requesterRole,
  request_authority_json AS requestAuthorityJson,
  capability_ids_json AS capabilityIdsJson,
  entity_type_reads_json AS entityTypeReadsJson,
  slack_workspace_id AS slackWorkspaceId, slack_channel_id AS slackChannelId,
  slack_thread_ts AS slackThreadTs, status,
  decided_by_user_id AS decidedByUserId, created_at AS createdAt,
  decided_at AS decidedAt, released_at AS releasedAt`;

const PLACEMENT_FENCE = `EXISTS (SELECT 1 FROM organisation_placement
  WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
    AND fence_token = ? AND status = 'active')`;

function fenceBindings(
  scope: OrganisationExecutionScope,
): readonly (string | number)[] {
  return [
    scope.organisationId,
    scope.placement.placementEpoch,
    scope.placement.placementCellId,
    scope.fenceToken,
  ];
}

type AgentPermissionRequestInsert = Omit<
  AgentPermissionRequest,
  "organisationId" | "status" | "decidedByUserId" | "decidedAt" | "releasedAt"
>;

/**
 * Store a new request. A Case holds one request that waits: another pending
 * request of the same Case answers `case_busy`. The same request again answers
 * with the stored row.
 */
export async function insertAgentPermissionRequest(
  scope: OrganisationExecutionScope,
  request: AgentPermissionRequestInsert,
): Promise<
  Result<
    Readonly<{ kind: "stored" | "case_busy"; request: AgentPermissionRequest }>,
    StoreError
  >
> {
  try {
    const db = scope.database.withSession("first-primary");
    const waiting = await db
      .prepare(
        `SELECT ${COLUMNS} FROM agent_permission_request
         WHERE organisation_id = ? AND case_id = ? AND status = 'pending'
           AND request_id <> ? AND created_at > ?
         ORDER BY created_at LIMIT 1`,
      )
      .bind(
        scope.organisationId,
        request.caseId,
        request.requestId,
        request.createdAt - AGENT_PERMISSION_REQUEST_LIFETIME_MS,
      )
      .first();
    const other = parseAgentPermissionRequest(waiting);
    if (other !== null)
      return { ok: true, value: { kind: "case_busy", request: other } };
    await db
      .prepare(
        `INSERT INTO agent_permission_request (
           organisation_id, request_id, origin, case_id, connector_id,
           session_id, turn_id, requester_person_id, requester_user_id,
           requester_role, request_authority_json, capability_ids_json,
           entity_type_reads_json, slack_workspace_id, slack_channel_id,
           slack_thread_ts, status, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?
         WHERE ${PLACEMENT_FENCE}
         ON CONFLICT (organisation_id, request_id) DO NOTHING`,
      )
      .bind(
        scope.organisationId,
        request.requestId,
        request.origin.kind,
        request.caseId,
        slackField(request.origin, "connectorId"),
        request.sessionId,
        request.turnId,
        request.requesterPersonId,
        request.requesterUserId,
        request.requesterRole,
        JSON.stringify(request.requestAuthority),
        JSON.stringify(request.capabilityIds),
        JSON.stringify(request.entityTypeReads),
        slackField(request.origin, "slackWorkspaceId"),
        slackField(request.origin, "slackChannelId"),
        slackField(request.origin, "slackThreadTs"),
        request.createdAt,
        ...fenceBindings(scope),
      )
      .run();
    const stored = await readAgentPermissionRequest(
      db,
      scope.organisationId,
      request.requestId,
    );
    return stored === null
      ? { ok: false, error: { code: "agent_permission_store_failed" } }
      : { ok: true, value: { kind: "stored", request: stored } };
  } catch {
    return { ok: false, error: { code: "agent_permission_store_failed" } };
  }
}

/** The request that one Session's turns made and that waits for a person. */
export async function readPendingSessionPermissionRequest(
  db: OrganisationDatabase | OrganisationDatabaseSession,
  organisationId: string,
  sessionId: string,
): Promise<AgentPermissionRequest | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM agent_permission_request
       WHERE organisation_id = ? AND session_id = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(organisationId, sessionId)
    .first();
  return parseAgentPermissionRequest(row);
}

export async function readAgentPermissionRequest(
  db: OrganisationDatabase | OrganisationDatabaseSession,
  organisationId: string,
  requestId: string,
): Promise<AgentPermissionRequest | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM agent_permission_request
       WHERE organisation_id = ? AND request_id = ?`,
    )
    .bind(organisationId, requestId)
    .first();
  return parseAgentPermissionRequest(row);
}

/**
 * The requests that wait and may still be decided, newest first, with the
 * requester's display name. A requester filter keeps one person's requests.
 */
export async function listPendingAgentPermissionRequests(
  db: OrganisationDatabase | OrganisationDatabaseSession,
  input: Readonly<{
    organisationId: string;
    requesterPersonId: string | null;
    now: number;
  }>,
): Promise<
  readonly Readonly<{
    request: AgentPermissionRequest;
    requesterName: string | null;
  }>[]
> {
  const rows = await db
    .prepare(
      `SELECT ${COLUMNS},
         (SELECT display_name FROM person
          WHERE person.organisation_id = agent_permission_request.organisation_id
            AND person.person_id = agent_permission_request.requester_person_id)
           AS requesterName
       FROM agent_permission_request
       WHERE organisation_id = ? AND status = 'pending' AND created_at > ?
         AND (? IS NULL OR requester_person_id = ?)
       ORDER BY created_at DESC LIMIT 50`,
    )
    .bind(
      input.organisationId,
      input.now - AGENT_PERMISSION_REQUEST_LIFETIME_MS,
      input.requesterPersonId,
      input.requesterPersonId,
    )
    .all();
  const pending: {
    request: AgentPermissionRequest;
    requesterName: string | null;
  }[] = [];
  for (const row of rows.results ?? []) {
    const request = parseAgentPermissionRequest(row);
    if (request === null || !isRecord(row)) continue;
    pending.push({
      request,
      requesterName:
        typeof row.requesterName === "string" && row.requesterName.length > 0
          ? row.requesterName
          : null,
    });
  }
  return pending;
}

/**
 * Record a person's decision. Only a pending request changes; the stored row
 * is returned either way, so the caller sees the first decision.
 */
export async function decideAgentPermissionRequest(
  scope: OrganisationExecutionScope,
  input: Readonly<{
    requestId: string;
    status: "allowed" | "denied";
    userId: string;
    now: number;
  }>,
): Promise<Result<AgentPermissionRequest, StoreError>> {
  try {
    const db = scope.database.withSession("first-primary");
    await db
      .prepare(
        `UPDATE agent_permission_request
         SET status = ?, decided_by_user_id = ?, decided_at = ?
         WHERE organisation_id = ? AND request_id = ? AND status = 'pending'
           AND ${PLACEMENT_FENCE}`,
      )
      .bind(
        input.status,
        input.userId,
        input.now,
        scope.organisationId,
        input.requestId,
        ...fenceBindings(scope),
      )
      .run();
    const stored = await readAgentPermissionRequest(
      db,
      scope.organisationId,
      input.requestId,
    );
    return stored === null
      ? { ok: false, error: { code: "agent_permission_store_failed" } }
      : { ok: true, value: stored };
  } catch {
    return { ok: false, error: { code: "agent_permission_store_failed" } };
  }
}

/** Record that a decision reached the asking turn. */
export async function markAgentPermissionRequestReleased(
  scope: OrganisationExecutionScope,
  requestId: string,
  now: number,
): Promise<void> {
  await scope.database
    .prepare(
      `UPDATE agent_permission_request SET released_at = ?
       WHERE organisation_id = ? AND request_id = ? AND status != 'pending'
         AND released_at IS NULL AND ${PLACEMENT_FENCE}`,
    )
    .bind(now, scope.organisationId, requestId, ...fenceBindings(scope))
    .run();
}

/**
 * Slack decisions that did not reach their thread yet, oldest first. Only
 * requests that may still be decided are kept.
 */
export async function listHeldAgentPermissionDecisions(
  db: OrganisationDatabase,
  organisationId: string,
  now: number,
): Promise<readonly AgentPermissionRequest[]> {
  const rows = await db
    .prepare(
      `SELECT ${COLUMNS} FROM agent_permission_request
       WHERE organisation_id = ? AND origin = 'slack_thread'
         AND status != 'pending' AND released_at IS NULL AND created_at >= ?
       ORDER BY decided_at LIMIT 20`,
    )
    .bind(organisationId, now - AGENT_PERMISSION_REQUEST_LIFETIME_MS)
    .all();
  const held: AgentPermissionRequest[] = [];
  for (const row of rows.results ?? []) {
    const parsed = parseAgentPermissionRequest(row);
    if (parsed !== null) held.push(parsed);
  }
  return held;
}

function parseAgentPermissionRequest(
  row: unknown,
): AgentPermissionRequest | null {
  if (
    !isRecord(row) ||
    typeof row.organisationId !== "string" ||
    typeof row.requestId !== "string" ||
    typeof row.caseId !== "string" ||
    typeof row.sessionId !== "string" ||
    typeof row.turnId !== "string" ||
    typeof row.requesterPersonId !== "string" ||
    (row.requesterUserId !== null && typeof row.requesterUserId !== "string") ||
    !isRequesterRole(row.requesterRole) ||
    typeof row.requestAuthorityJson !== "string" ||
    typeof row.capabilityIdsJson !== "string" ||
    typeof row.entityTypeReadsJson !== "string" ||
    !isRequestStatus(row.status) ||
    (row.decidedByUserId !== null && typeof row.decidedByUserId !== "string") ||
    !isNonNegativeInteger(row.createdAt) ||
    (row.decidedAt !== null && !isNonNegativeInteger(row.decidedAt)) ||
    (row.releasedAt !== null && !isNonNegativeInteger(row.releasedAt))
  )
    return null;
  const capabilityIds = parseList(
    row.capabilityIdsJson,
    isRequestableCapability,
  );
  const entityTypeReads = parseList(
    row.entityTypeReadsJson,
    isRequestableEntityTypeRead,
  );
  if (
    capabilityIds === null ||
    entityTypeReads === null ||
    capabilityIds.length + entityTypeReads.length === 0
  )
    return null;
  const requestAuthority = parseRequestAuthorityJson(row.requestAuthorityJson);
  if (requestAuthority === null) return null;
  const origin = parseOrigin(row);
  if (origin === null) return null;
  return {
    organisationId: row.organisationId,
    requestId: row.requestId,
    origin,
    caseId: row.caseId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    requesterPersonId: row.requesterPersonId,
    requesterUserId: row.requesterUserId,
    requesterRole: row.requesterRole,
    requestAuthority,
    capabilityIds,
    entityTypeReads,
    status: row.status,
    decidedByUserId: row.decidedByUserId,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    releasedAt: row.releasedAt,
  };
}

function parseOrigin(
  row: Readonly<Record<string, unknown>>,
): AgentPermissionOrigin | null {
  if (
    row.origin === "portal_chat" &&
    row.connectorId === null &&
    row.slackWorkspaceId === null &&
    row.slackChannelId === null &&
    row.slackThreadTs === null
  )
    return { kind: "portal_chat" };
  if (
    row.origin === "slack_thread" &&
    typeof row.connectorId === "string" &&
    typeof row.slackWorkspaceId === "string" &&
    typeof row.slackChannelId === "string" &&
    typeof row.slackThreadTs === "string"
  )
    return {
      kind: "slack_thread",
      connectorId: row.connectorId,
      slackWorkspaceId: row.slackWorkspaceId,
      slackChannelId: row.slackChannelId,
      slackThreadTs: row.slackThreadTs,
    };
  return null;
}

function slackField(
  origin: AgentPermissionOrigin,
  field: Exclude<keyof Variant<AgentPermissionOrigin, "slack_thread">, "kind">,
): string | null {
  return origin.kind === "slack_thread" ? origin[field] : null;
}

function parseList<T>(
  json: string,
  isItem: (value: unknown) => value is T,
): readonly T[] | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    if (!isItem(item)) return null;
    items.push(item);
  }
  return items;
}

function parseRequestAuthorityJson(json: string): RequestAuthority | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = parseStoredRequestAuthority(value);
  return parsed.ok ? parsed.value.requestAuthority : null;
}

export function isRequesterRole(
  value: unknown,
): value is AgentPermissionRequesterRole {
  return (
    value === "owner" ||
    value === "admin" ||
    value === "operator" ||
    value === "viewer"
  );
}

function isRequestStatus(
  value: unknown,
): value is AgentPermissionRequestStatus {
  return value === "pending" || value === "allowed" || value === "denied";
}
