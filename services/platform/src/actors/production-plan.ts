import {
  isPlanRequestId,
  parseProductionPlanState,
  PRODUCTION_PLAN_SCHEMA,
  ProductionPlanDoc,
  type ProductionPlanSelection,
  type ProductionPlanStateVector,
  type ProductionPlanUpdate,
} from "@seams/production-plan-crdt";
import {
  encodePlanServerMessage,
  FRAME_LIMIT,
  parsePlanClientMessage,
  type PlanClientMessage,
  type PlanFailureCode,
  type PlanRoomMetadata,
} from "@seams/production-plan-crdt/protocol";
import type { CollaborationAgent } from "@seams/collaboration";
import { assertNever, sha256Hex } from "@seams/std";
import type { SessionTurnExecution } from "../chat/turn-access";
import type { AuthorizedOrganisationRequest } from "../control/authorization";
import { controlError } from "../control/http";
import { listOrganisationMembers, resolveUser } from "../data/control-plane";
import { isConversationId } from "@seams/control-api";
import { hasExactKeys } from "@seams/std";
import {
  authorizeConversation,
  readConversationCaseId,
} from "../chat/conversation-access";
import { readJsonRecord } from "../control/http";
import { parseUserId } from "../ids";
import { resolveCollaborationSlackThread } from "./collaboration-slack-thread";
import type { Env } from "../env";
import type { ControlSessionId, OrganisationId, UserId } from "../ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Result } from "../result";
import { isOrganisationExecutionActive } from "./actor-execution-quiescence";
import {
  CollaborationRoom,
  openRoomSockets,
  type CollaborationRoomBacking,
  type CollaborationRoomProtocol,
  type CollaborationRoomServerMessage,
  type CollaborationSocketRoom,
} from "./collaboration-room";

/**
 * Plan 40D: the shared production plan of each location. The plan holds draft
 * quantities only; the production requests stay in Commerce, and "Accept
 * plan" applies the quantities through the validated request commands.
 */
type PlanRoom = CollaborationRoom<
  ProductionPlanUpdate,
  ProductionPlanStateVector,
  ProductionPlanSelection,
  PlanRoomMetadata,
  PlanFailureCode,
  ProductionPlanDoc
>;
type StoredPlan = Readonly<{
  document: ProductionPlanDoc;
  revision: number;
  generation: number;
}>;
type PlanResult<T> = Result<T, Readonly<{ code: PlanFailureCode }>>;

type ProductionPlanRead = Readonly<{
  locationId: string;
  /** 0 before anyone opened or edited the plan. */
  revision: number;
  lines: readonly Readonly<{ requestId: string; quantity: string }>[];
}>;
/**
 * The Slack thread or Portal chat that an owner or admin shared with a
 * location's plan. An agent edit from it may reach every role (Plan 40D).
 */
type ProductionPlanShare =
  | Readonly<{
      kind: "slack_thread";
      caseId: string;
      integrationAccountId: string;
      conversationId: string;
      threadUrl: string;
    }>
  | Readonly<{
      kind: "portal_chat";
      caseId: string;
      conversationId: string;
      /** The Project that the chat was shared in when it was shared. */
      projectId: string;
    }>;

/**
 * A live share, with the person of the owner or admin who made it. An agent
 * edit may carry into the plan what only that person may read, because that
 * person shared the conversation with every role that reads the plan.
 */
type ProductionPlanSharedTarget = ProductionPlanShare &
  Readonly<{ approverPersonId: string }>;

export type ProductionPlanAgentEdit = Readonly<{
  agent: CollaborationAgent;
  execution: SessionTurnExecution;
  organisationId: OrganisationId;
  locationId: string;
  requestId: string;
  quantity: string;
  operationId: string;
  userId: UserId;
  deadlineAt: number;
}>;

/** A location's plans stay a small set; an unknown location id cannot fill storage. */
const PLAN_LOCATION_LIMIT = 64;
// A plan with no open socket is rewritten without its history past these sizes.
const COMPACT_STATE_BYTES = 32 * 1024;
const COMPACT_VECTOR_BYTES = 4 * 1024;

export function isProductionPlanLocationId(value: string): boolean {
  return isPlanRequestId(value);
}

export class ProductionPlanRooms {
  readonly #rooms = new Map<string, PlanRoom>();
  readonly #ctx: DurableObjectState;
  readonly #storage: DurableObjectStorage;
  readonly #env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#storage = ctx.storage;
    this.#env = env;
    ctx.storage.transactionSync(createPlanSchema.bind(null, ctx.storage.sql));
  }

  /** The room of a socket that the Actor accepted, after a wake. */
  socketRoom(
    organisationId: OrganisationId,
    key: string,
  ): CollaborationSocketRoom | null {
    return isProductionPlanLocationId(key)
      ? this.#room(organisationId, key)
      : null;
  }

  async open(
    authorized: AuthorizedOrganisationRequest,
    locationId: string,
    scope: OrganisationExecutionScope,
  ): Promise<Response> {
    const identity = await resolveUser({
      db: this.#env.DB,
      userId: authorized.authenticated.session.userId,
    });
    if (identity === null || identity.displayName.length > 256)
      return controlError("access_revoked", 403);
    return this.#room(authorized.organisationId, locationId).open(
      authorized,
      identity.displayName,
      scope,
    );
  }

  /**
   * Removes the lines of requests that left `requested`, such as accepted
   * ones. Open pages receive the change.
   */
  clear(
    scope: OrganisationExecutionScope,
    organisationId: OrganisationId,
    locationId: string,
    requestIds: readonly string[],
    person: Readonly<{ userId: UserId; controlSessionId: ControlSessionId }>,
  ) {
    return this.#room(organisationId, locationId).mutate(
      {
        scope,
        origin: {
          kind: "control_session",
          controlSessionId: person.controlSessionId,
        },
        userId: person.userId,
        deadlineAt: Date.now() + 30_000,
      },
      clearPlanLines.bind(
        null,
        this.#storage.sql,
        locationId,
        requestIds,
        person.userId,
      ),
    );
  }

  /** The plan's draft quantities, for an agent read. */
  read(locationId: string): PlanResult<ProductionPlanRead> {
    const stored = readStoredPlanIfAny(this.#storage.sql, locationId);
    if (!stored.ok) return stored;
    if (stored.value === null)
      return { ok: true, value: { locationId, revision: 0, lines: [] } };
    try {
      return {
        ok: true,
        value: {
          locationId,
          revision: stored.value.revision,
          lines: stored.value.document.read().lines,
        },
      };
    } finally {
      stored.value.document.destroy();
    }
  }

  /**
   * An agent's change of one line. Open pages show the agent's named cursor
   * on that line while the change runs.
   */
  async edit(
    input: ProductionPlanAgentEdit,
    scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      ProductionPlanRead,
      Readonly<{
        code:
          | PlanFailureCode
          | "organisation_placement_conflict"
          | "access_revoked"
          | "room_full";
      }>
    >
  > {
    const created = this.#storage.transactionSync(
      initializePlan.bind(
        null,
        this.#storage.sql,
        input.locationId,
        input.userId,
        false,
      ),
    );
    if (!created.ok) return created;
    const edited = await this.#room(
      input.organisationId,
      input.locationId,
    ).mutate(
      {
        scope,
        origin: { kind: "session_turn", execution: input.execution },
        userId: input.userId,
        deadlineAt: input.deadlineAt,
      },
      setPlanLine.bind(null, this.#storage.sql, input),
      {
        agent: input.agent,
        operationId: await sha256Hex(input.operationId),
        target: input.requestId,
      },
    );
    if (!edited.ok) return edited;
    return this.read(input.locationId);
  }

  /** The plan's share, while an owner or admin who made it still is one. */
  async sharedTarget(
    scope: OrganisationExecutionScope,
    locationId: string,
  ): Promise<ProductionPlanSharedTarget | null> {
    const row = this.#storage.sql
      .exec(
        "SELECT * FROM production_plan_share WHERE location_id = ? AND state = 'shared'",
        locationId,
      )
      .toArray()[0];
    if (row === undefined) return null;
    const approver = parseUserId(String(row.approved_by));
    if (
      !approver.ok ||
      typeof row.case_id !== "string" ||
      typeof row.conversation_id !== "string"
    )
      return null;
    const members = await listOrganisationMembers({
      db: scope.database,
      organisationId: scope.organisationId,
    });
    if (!(await isOrganisationExecutionActive(this.#storage.sql, scope)))
      return null;
    const approving = members.find(
      (member) =>
        member.userId === approver.value &&
        (member.role === "owner" || member.role === "admin"),
    );
    if (approving === undefined) return null;
    const approverPersonId = approving.personId;
    if (row.kind === "portal_chat")
      return typeof row.project_id === "string"
        ? {
            kind: "portal_chat",
            caseId: row.case_id,
            conversationId: row.conversation_id,
            projectId: row.project_id,
            approverPersonId,
          }
        : null;
    return row.kind === "slack_thread" &&
      typeof row.integration_account_id === "string" &&
      typeof row.thread_url === "string"
      ? {
          kind: "slack_thread",
          caseId: row.case_id,
          integrationAccountId: row.integration_account_id,
          conversationId: row.conversation_id,
          threadUrl: row.thread_url,
          approverPersonId,
        }
      : null;
  }

  /**
   * Reads, sets or ends the plan's share. An owner or admin shares a Slack
   * thread by its link, or a Portal chat that is shared in a Project; a
   * private chat's label names only its person, so it cannot be shared.
   */
  async share(
    request: Request,
    authorized: AuthorizedOrganisationRequest,
    locationId: string,
    scope: OrganisationExecutionScope,
  ): Promise<Response> {
    if (request.method === "GET")
      return Response.json({
        ok: true,
        sharing: shareView(await this.sharedTarget(scope, locationId)),
      });
    if (request.method === "DELETE") {
      this.#storage.sql.exec(
        "UPDATE production_plan_share SET state = 'revoked', approved_by = ?, changed_at = ? WHERE location_id = ?",
        authorized.authenticated.session.userId,
        Date.now(),
        locationId,
      );
      return Response.json({ ok: true, sharing: null });
    }
    const body = await readJsonRecord(request);
    if (!body.ok) return controlError("production_plan_share_invalid", 422);
    let share: ProductionPlanShare;
    if (
      hasExactKeys(body.value, ["threadUrl"]) &&
      typeof body.value.threadUrl === "string"
    ) {
      const target = await resolveCollaborationSlackThread(
        this.#env,
        scope,
        body.value.threadUrl,
      );
      if (!target.ok)
        return controlError(
          target.error.code,
          target.error.code === "draft_thread_link_invalid" ? 422 : 409,
        );
      share = {
        kind: "slack_thread",
        caseId: target.value.caseId,
        integrationAccountId: target.value.integrationAccountId,
        conversationId: target.value.conversationId,
        threadUrl: target.value.threadUrl,
      };
    } else if (
      hasExactKeys(body.value, ["conversationId"]) &&
      isConversationId(body.value.conversationId)
    ) {
      const chatScope = {
        organisationId: authorized.organisationId,
        userId: authorized.authenticated.session.userId,
      };
      const conversationId = body.value.conversationId;
      const [access, caseId] = await Promise.all([
        authorizeConversation(scope.database, chatScope, conversationId),
        readConversationCaseId(scope.database, chatScope, conversationId),
      ]);
      if (access === null || caseId === null)
        return controlError("production_plan_chat_missing", 404);
      if (access.access.kind !== "shared")
        return controlError("production_plan_chat_private", 409);
      share = {
        kind: "portal_chat",
        caseId,
        conversationId,
        projectId: access.access.sharedProjectId,
      };
    } else return controlError("production_plan_share_invalid", 422);
    if (!(await isOrganisationExecutionActive(this.#storage.sql, scope)))
      return controlError("organisation_placement_conflict", 409);
    this.#storage.sql.exec(
      `INSERT INTO production_plan_share
        (location_id, kind, case_id, integration_account_id, conversation_id, project_id, thread_url, approved_by, state, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'shared', ?)
       ON CONFLICT(location_id) DO UPDATE SET kind = excluded.kind, case_id = excluded.case_id,
         integration_account_id = excluded.integration_account_id, conversation_id = excluded.conversation_id,
         project_id = excluded.project_id,
         thread_url = excluded.thread_url, approved_by = excluded.approved_by, state = 'shared',
         changed_at = excluded.changed_at`,
      locationId,
      share.kind,
      share.caseId,
      share.kind === "slack_thread" ? share.integrationAccountId : null,
      share.conversationId,
      share.kind === "portal_chat" ? share.projectId : null,
      share.kind === "slack_thread" ? share.threadUrl : null,
      authorized.authenticated.session.userId,
      Date.now(),
    );
    return Response.json({ ok: true, sharing: shareView(share) });
  }

  #room(organisationId: OrganisationId, locationId: string): PlanRoom {
    const existing = this.#rooms.get(locationId);
    if (existing !== undefined) return existing;
    const room = new CollaborationRoom({
      ctx: this.#ctx,
      env: this.#env,
      organisationId,
      protocol: PLAN_ROOM_PROTOCOL,
      backing: new PlanBacking(this.#ctx, locationId),
      route: { kind: "production_plan", key: locationId },
      closeReason: "Production plan disconnected",
      onEmpty: this.#remove.bind(this, locationId),
    });
    this.#rooms.set(locationId, room);
    return room;
  }

  #remove(locationId: string): void {
    this.#rooms.delete(locationId);
  }
}

const PLAN_ROOM_PROTOCOL: CollaborationRoomProtocol<
  ProductionPlanUpdate,
  ProductionPlanStateVector,
  ProductionPlanSelection,
  PlanRoomMetadata,
  PlanFailureCode
> = {
  frameLimit: FRAME_LIMIT,
  failureCodes: {
    invalidMessage: "invalid_message",
    accessRevoked: "access_revoked",
    storageUnavailable: "storage_unavailable",
    roomFull: "room_full",
  },
  parseClientMessage: parsePlanRoomClientMessage,
  encodeServerMessage: encodePlanRoomServerMessage,
};

class PlanBacking implements CollaborationRoomBacking<
  ProductionPlanDoc,
  PlanRoomMetadata,
  PlanFailureCode
> {
  readonly #ctx: DurableObjectState;
  readonly #locationId: string;

  constructor(ctx: DurableObjectState, locationId: string) {
    this.#ctx = ctx;
    this.#locationId = locationId;
  }

  async initialize(
    userId: UserId,
    scope: OrganisationExecutionScope,
  ): Promise<PlanResult<null>> {
    const sql = this.#ctx.storage.sql;
    if (!(await isOrganisationExecutionActive(sql, scope)))
      return { ok: false, error: { code: "access_revoked" } };
    // The room serializes opens and edits, so no other socket joins meanwhile.
    const idle = !openRoomSockets(this.#ctx, "production_plan").some(
      socketOfLocation.bind(null, this.#locationId),
    );
    return this.#ctx.storage.transactionSync(
      initializePlan.bind(null, sql, this.#locationId, userId, idle),
    );
  }

  readDocument(): PlanResult<ProductionPlanDoc> {
    const stored = readPlan(this.#ctx.storage.sql, this.#locationId);
    return stored.ok ? { ok: true, value: stored.value.document } : stored;
  }

  readForSync(): Promise<
    PlanResult<
      Readonly<{ document: ProductionPlanDoc; metadata: PlanRoomMetadata }>
    >
  > {
    const stored = readPlan(this.#ctx.storage.sql, this.#locationId);
    return Promise.resolve(
      stored.ok
        ? {
            ok: true,
            value: {
              document: stored.value.document,
              metadata: {
                documentRevision: stored.value.revision,
                generation: stored.value.generation,
              },
            },
          }
        : stored,
    );
  }

  persist(state: Uint8Array, userId: UserId): void {
    persistPlan(this.#ctx.storage.sql, this.#locationId, state, userId);
  }
}

function socketOfLocation(
  locationId: string,
  socket: Readonly<{ key: string }>,
): boolean {
  return socket.key === locationId;
}

function parsePlanRoomClientMessage(
  frame: unknown,
): Result<PlanClientMessage, Readonly<{ code: PlanFailureCode }>> {
  return parsePlanClientMessage(frame);
}

function encodePlanRoomServerMessage(
  message: CollaborationRoomServerMessage<
    ProductionPlanUpdate,
    ProductionPlanStateVector,
    ProductionPlanSelection,
    PlanRoomMetadata,
    PlanFailureCode
  >,
): string {
  switch (message.kind) {
    case "sync_response":
      return encodePlanServerMessage({
        kind: "sync_response",
        serverStateVector: message.serverStateVector,
        missingUpdate: message.missingUpdate,
        documentRevision: message.metadata.documentRevision,
        generation: message.metadata.generation,
        access: message.access,
        sessionId: message.sessionId,
      });
    case "update_accepted":
    case "update_broadcast":
    case "presence_changed":
    case "failure":
      return encodePlanServerMessage(message);
    default:
      return assertNever(message);
  }
}

/** What a person sees of a share: never the Case. */
function shareView(share: ProductionPlanShare | null) {
  if (share === null) return null;
  return share.kind === "slack_thread"
    ? { kind: share.kind, threadUrl: share.threadUrl }
    : { kind: share.kind, conversationId: share.conversationId };
}

function createPlanSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS production_plan_share (
    location_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('slack_thread', 'portal_chat')),
    case_id TEXT NOT NULL,
    integration_account_id TEXT,
    conversation_id TEXT NOT NULL,
    project_id TEXT,
    thread_url TEXT,
    approved_by TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('shared', 'revoked')),
    changed_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS production_plan (
    location_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = 'production_plan_crdt.v1'),
    encoded_state BLOB NOT NULL CHECK (length(encoded_state) <= 131072),
    generation INTEGER NOT NULL CHECK (generation > 0),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_by_app_user TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

function initializePlan(
  sql: SqlStorage,
  locationId: string,
  userId: UserId,
  idle: boolean,
): PlanResult<null> {
  const row = sql
    .exec(
      "SELECT length(encoded_state) AS bytes FROM production_plan WHERE location_id = ?",
      locationId,
    )
    .toArray()[0];
  if (row === undefined) {
    const count = sql
      .exec("SELECT COUNT(*) AS plans FROM production_plan")
      .one().plans;
    if (typeof count !== "number" || count >= PLAN_LOCATION_LIMIT)
      return { ok: false, error: { code: "collection_limit" } };
    const document = ProductionPlanDoc.create();
    try {
      const state = document.state();
      if (!state.ok) return state;
      const now = Date.now();
      sql.exec(
        `INSERT INTO production_plan
          (location_id, schema_version, encoded_state, generation, revision, updated_by_app_user, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1, ?, ?, ?)`,
        locationId,
        PRODUCTION_PLAN_SCHEMA,
        state.value.encode(),
        userId,
        now,
        now,
      );
      return { ok: true, value: null };
    } finally {
      document.destroy();
    }
  }
  return idle
    ? compactPlan(sql, locationId, userId)
    : { ok: true, value: null };
}

/**
 * Each editing session adds a replica to the document's history. When no
 * page has the plan open and the history grew, the room writes the same
 * lines into a new document of the next generation.
 */
function compactPlan(
  sql: SqlStorage,
  locationId: string,
  userId: UserId,
): PlanResult<null> {
  const stored = readPlan(sql, locationId);
  if (!stored.ok) return stored;
  try {
    const state = stored.value.document.state();
    const vector = stored.value.document.stateVector();
    if (!state.ok) return state;
    if (!vector.ok) return vector;
    if (
      state.value.encode().byteLength <= COMPACT_STATE_BYTES &&
      vector.value.encode().byteLength <= COMPACT_VECTOR_BYTES
    )
      return { ok: true, value: null };
    const compact = ProductionPlanDoc.compact(stored.value.document.read());
    if (!compact.ok) return compact;
    try {
      const next = compact.value.state();
      if (!next.ok) return next;
      sql.exec(
        `UPDATE production_plan
         SET encoded_state = ?, generation = generation + 1, revision = revision + 1,
             updated_by_app_user = ?, updated_at = ?
         WHERE location_id = ?`,
        next.value.encode(),
        userId,
        Date.now(),
        locationId,
      );
      return { ok: true, value: null };
    } finally {
      compact.value.destroy();
    }
  } finally {
    stored.value.document.destroy();
  }
}

function clearPlanLines(
  sql: SqlStorage,
  locationId: string,
  requestIds: readonly string[],
  userId: UserId,
): Result<
  Readonly<{ value: null; update: ProductionPlanUpdate | null }>,
  Readonly<{ code: PlanFailureCode }>
> {
  const stored = readStoredPlanIfAny(sql, locationId);
  if (!stored.ok) return stored;
  if (stored.value === null)
    return { ok: true, value: { value: null, update: null } };
  const document = stored.value.document;
  try {
    const cleared = document.clear(requestIds);
    if (!cleared.ok)
      return cleared.error.code === "record_conflict"
        ? { ok: true, value: { value: null, update: null } }
        : cleared;
    const state = document.state();
    if (!state.ok) return state;
    persistPlan(sql, locationId, state.value.encode(), userId);
    return { ok: true, value: { value: null, update: cleared.value } };
  } finally {
    document.destroy();
  }
}

function setPlanLine(
  sql: SqlStorage,
  input: ProductionPlanAgentEdit,
): Result<
  Readonly<{ value: null; update: ProductionPlanUpdate | null }>,
  Readonly<{ code: PlanFailureCode }>
> {
  const stored = readPlan(sql, input.locationId);
  if (!stored.ok) return stored;
  const document = stored.value.document;
  try {
    const set = document.setQuantity(input.requestId, input.quantity);
    if (!set.ok)
      return set.error.code === "record_conflict"
        ? { ok: true, value: { value: null, update: null } }
        : set;
    const state = document.state();
    if (!state.ok) return state;
    persistPlan(sql, input.locationId, state.value.encode(), input.userId);
    return { ok: true, value: { value: null, update: set.value } };
  } finally {
    document.destroy();
  }
}

function persistPlan(
  sql: SqlStorage,
  locationId: string,
  state: Uint8Array,
  userId: UserId,
): void {
  sql.exec(
    `UPDATE production_plan
     SET encoded_state = ?, revision = revision + 1, updated_by_app_user = ?, updated_at = ?
     WHERE location_id = ?`,
    state,
    userId,
    Date.now(),
    locationId,
  );
}

function readStoredPlanIfAny(
  sql: SqlStorage,
  locationId: string,
): PlanResult<StoredPlan | null> {
  const exists =
    sql
      .exec(
        "SELECT location_id FROM production_plan WHERE location_id = ?",
        locationId,
      )
      .toArray().length > 0;
  return exists ? readPlan(sql, locationId) : { ok: true, value: null };
}

function readPlan(sql: SqlStorage, locationId: string): PlanResult<StoredPlan> {
  const row = sql
    .exec(
      "SELECT schema_version, encoded_state, generation, revision FROM production_plan WHERE location_id = ?",
      locationId,
    )
    .toArray()[0];
  if (
    row === undefined ||
    row.schema_version !== PRODUCTION_PLAN_SCHEMA ||
    !(row.encoded_state instanceof ArrayBuffer) ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    typeof row.generation !== "number" ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1
  )
    return { ok: false, error: { code: "invalid_state" } };
  const state = parseProductionPlanState(new Uint8Array(row.encoded_state));
  if (!state.ok) return state;
  const document = ProductionPlanDoc.restore(state.value);
  return document.ok
    ? {
        ok: true,
        value: {
          document: document.value,
          revision: row.revision,
          generation: row.generation,
        },
      }
    : document;
}
