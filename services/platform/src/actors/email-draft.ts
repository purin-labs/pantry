import { sha256Hex } from "@purin-labs/std";
import type { CollaborationAgent } from "@purin-labs/collaboration";
import type { SessionTurnExecution } from "../chat/turn-access";
import {
  EMAIL_DRAFT_SCHEMA,
  EmailDraftDoc,
  parseEmailDraftState,
  type EmailDraftCrdtResult,
  type EmailDraftField,
  type EmailDraftSelection,
  type EmailDraftSnapshot,
  type EmailDraftStateVector,
  type EmailDraftUpdate,
} from "@purin-labs/email-draft-crdt";
import {
  encodeEmailDraftServerMessage,
  FRAME_LIMIT,
  parseEmailDraftClientMessage,
  type EmailDraftClientMessage,
  type EmailDraftFailureCode,
  type EmailDraftRoomMetadata,
} from "@purin-labs/email-draft-crdt/protocol";
import type { AuthorizedOrganisationRequest } from "../control/authorization";
import { controlError, readJsonRecord } from "../control/http";
import { listOrganisationMembers, resolveUser } from "../data/control-plane";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseCaseId,
  parseIntegrationAccountId,
  type CaseId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  CollaborationRoom,
  type CollaborationRoomBacking,
  type CollaborationRoomProtocol,
  type CollaborationRoomServerMessage,
  type CollaborationSocketRoom,
} from "./collaboration-room";
import { resolveCollaborationSlackThread } from "./collaboration-slack-thread";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, hasExactKeys, isRecord } from "@purin-labs/std";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { isOrganisationExecutionActive } from "./actor-execution-quiescence";

const EMAIL_DRAFT_ID = "active";

export type EmailDraftEditRequest = Readonly<{
  field: EmailDraftField;
  oldText: string;
  newText: string;
  expectedRevision: number;
}>;
export type EmailDraftAgentEdit = Readonly<{
  agent: CollaborationAgent;
  execution: SessionTurnExecution;
  organisationId: OrganisationId;
  request: EmailDraftEditRequest;
  operationId: string;
  userId: UserId;
  deadlineAt: number;
}>;
export type EmailDraftRead =
  | Readonly<{
      kind: "not_started";
      documentId: typeof EMAIL_DRAFT_ID;
      revision: 0;
      observedAt: number;
    }>
  | Readonly<{
      kind: "active";
      documentId: typeof EMAIL_DRAFT_ID;
      revision: number;
      observedAt: number;
      draft: EmailDraftSnapshot;
    }>;
type EmailDraftReview = Readonly<{
  reviewId: string;
  documentId: typeof EMAIL_DRAFT_ID;
  documentRevision: number;
  reviewedAt: number;
  draft: EmailDraftSnapshot;
}>;
type EmailDraftSharedThread = Readonly<{
  caseId: CaseId;
  integrationAccountId: IntegrationAccountId;
  conversationId: string;
  threadUrl: string;
  approvedBy: UserId;
}>;

type EmailDraftOperationError = Readonly<{
  code:
    | EmailDraftFailureCode
    | "passage_conflict"
    | "operation_conflict"
    | "revision_conflict"
    | "organisation_placement_conflict";
}>;
type EmailDraftRoom = CollaborationRoom<
  EmailDraftUpdate,
  EmailDraftStateVector,
  EmailDraftSelection,
  EmailDraftRoomMetadata,
  EmailDraftFailureCode,
  EmailDraftDoc
>;
type StoredEmailDraft = Readonly<{ document: EmailDraftDoc; revision: number }>;

export class EmailDraftRooms {
  readonly #rooms = new Map<OrganisationId, EmailDraftRoom>();
  readonly #ctx: DurableObjectState;
  readonly #storage: DurableObjectStorage;
  readonly #env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#storage = ctx.storage;
    this.#env = env;
    createEmailDraftSchema(ctx.storage.sql);
  }

  /** The room of a socket that the Actor accepted, after a wake. */
  socketRoom(
    organisationId: OrganisationId,
    key: string,
  ): CollaborationSocketRoom | null {
    return key === organisationId ? this.#room(organisationId) : null;
  }

  async open(
    authorized: AuthorizedOrganisationRequest,
    scope: OrganisationExecutionScope,
  ): Promise<Response> {
    const identity = await resolveUser({
      db: this.#env.DB,
      userId: authorized.authenticated.session.userId,
    });
    if (identity === null || identity.displayName.length > 256) {
      return controlError("access_revoked", 403);
    }
    return this.#room(authorized.organisationId).open(
      authorized,
      identity.displayName,
      scope,
    );
  }

  snapshot(): Response {
    const result = readEmailDraftSnapshot(this.#storage.sql);
    return result.ok
      ? Response.json({ ok: true, value: result.value })
      : controlError(result.error.code, 503);
  }

  async review(authorized: AuthorizedOrganisationRequest): Promise<Response> {
    const stored = readEmailDraft(this.#storage.sql);
    if (!stored.ok) {
      return stored.error.code === "invalid_state"
        ? controlError("email_draft_not_started", 409)
        : controlError(stored.error.code, 503);
    }
    try {
      const review: EmailDraftReview = {
        reviewId: crypto.randomUUID(),
        documentId: EMAIL_DRAFT_ID,
        documentRevision: stored.value.revision,
        reviewedAt: Date.now(),
        draft: stored.value.document.read(),
      };
      this.#storage.sql.exec(
        `INSERT INTO email_draft_review
          (review_id, document_revision, snapshot_json, reviewed_by_app_user, reviewed_at)
         VALUES (?, ?, ?, ?, ?)`,
        review.reviewId,
        review.documentRevision,
        JSON.stringify(review.draft),
        authorized.authenticated.session.userId,
        review.reviewedAt,
      );
      return Response.json({ ok: true, value: review });
    } finally {
      stored.value.document.destroy();
    }
  }

  async sharedThread(
    scope: OrganisationExecutionScope,
    caseId: string,
  ): Promise<EmailDraftSharedThread | null> {
    const row = this.#storage.sql
      .exec(
        "SELECT * FROM email_draft_thread WHERE singleton_id = ? AND case_id = ? AND state = 'shared'",
        EMAIL_DRAFT_ID,
        caseId,
      )
      .toArray()[0];
    if (row === undefined) return null;
    const parsedCase = parseCaseId(String(row.case_id));
    const account = parseIntegrationAccountId(
      String(row.integration_account_id),
    );
    const approver = parseUserId(String(row.approved_by));
    if (
      !parsedCase.ok ||
      !account.ok ||
      !approver.ok ||
      typeof row.conversation_id !== "string" ||
      typeof row.thread_url !== "string"
    )
      return null;
    const members = await listOrganisationMembers({
      db: scope.database,
      organisationId: scope.organisationId,
    });
    if (!(await isOrganisationExecutionActive(this.#storage.sql, scope)))
      return null;
    for (const member of members) {
      if (
        member.userId === approver.value &&
        (member.role === "owner" || member.role === "admin")
      ) {
        return {
          caseId: parsedCase.value,
          integrationAccountId: account.value,
          conversationId: row.conversation_id,
          threadUrl: row.thread_url,
          approvedBy: approver.value,
        };
      }
    }
    return null;
  }

  async shareThread(
    request: Request,
    authorized: AuthorizedOrganisationRequest,
    scope: OrganisationExecutionScope,
  ): Promise<Response> {
    if (request.method === "GET") {
      const row = this.#storage.sql
        .exec(
          "SELECT case_id FROM email_draft_thread WHERE singleton_id = ? AND state = 'shared'",
          EMAIL_DRAFT_ID,
        )
        .toArray()[0];
      const sharing =
        row === undefined
          ? null
          : await this.sharedThread(scope, String(row.case_id));
      return Response.json({ ok: true, threadUrl: sharing?.threadUrl ?? null });
    }
    if (request.method === "DELETE") {
      this.#storage.sql.exec(
        "UPDATE email_draft_thread SET state = 'revoked', changed_at = ?, approved_by = ? WHERE singleton_id = ?",
        Date.now(),
        authorized.authenticated.session.userId,
        EMAIL_DRAFT_ID,
      );
      return Response.json({ ok: true, threadUrl: null });
    }
    const body = await readJsonRecord(request);
    if (
      !body.ok ||
      !hasExactKeys(body.value, ["threadUrl"]) ||
      typeof body.value.threadUrl !== "string"
    ) {
      return controlError("draft_thread_link_invalid", 422);
    }
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
    if (!(await isOrganisationExecutionActive(this.#storage.sql, scope)))
      return controlError("organisation_placement_conflict", 409);
    this.#storage.sql.exec(
      "INSERT INTO email_draft_thread " +
        "(singleton_id, case_id, integration_account_id, conversation_id, thread_url, approved_by, state, changed_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'shared', ?) " +
        "ON CONFLICT(singleton_id) DO UPDATE SET case_id = excluded.case_id, " +
        "integration_account_id = excluded.integration_account_id, conversation_id = excluded.conversation_id, " +
        "thread_url = excluded.thread_url, approved_by = excluded.approved_by, state = 'shared', changed_at = excluded.changed_at",
      EMAIL_DRAFT_ID,
      target.value.caseId,
      target.value.integrationAccountId,
      target.value.conversationId,
      target.value.threadUrl,
      authorized.authenticated.session.userId,
      Date.now(),
    );
    return Response.json({ ok: true, threadUrl: target.value.threadUrl });
  }

  read(): Result<EmailDraftRead, EmailDraftOperationError> {
    return readEmailDraftSnapshot(this.#storage.sql);
  }

  async edit(
    input: EmailDraftAgentEdit,
    scope: OrganisationExecutionScope,
  ): Promise<Result<EmailDraftRead, EmailDraftOperationError>> {
    return this.#room(input.organisationId).mutate(
      {
        scope,
        origin: { kind: "session_turn", execution: input.execution },
        userId: input.userId,
        deadlineAt: input.deadlineAt,
      },
      editEmailDraftPassage.bind(null, this.#storage.sql, input),
      { agent: input.agent, operationId: await sha256Hex(input.operationId), target: input.request.field },
    );
  }

  #room(organisationId: OrganisationId): EmailDraftRoom {
    const existing = this.#rooms.get(organisationId);
    if (existing !== undefined) return existing;
    const room = new CollaborationRoom({
      ctx: this.#ctx,
      env: this.#env,
      organisationId,
      protocol: EMAIL_ROOM_PROTOCOL,
      backing: new EmailDraftBacking(this.#storage),
      route: { kind: "email_draft", key: organisationId },
      closeReason: "Email draft disconnected",
      onEmpty: this.#remove.bind(this, organisationId),
    });
    this.#rooms.set(organisationId, room);
    return room;
  }

  #remove(organisationId: OrganisationId): void {
    this.#rooms.delete(organisationId);
  }
}

const EMAIL_ROOM_PROTOCOL: CollaborationRoomProtocol<
  EmailDraftUpdate,
  EmailDraftStateVector,
  EmailDraftSelection,
  EmailDraftRoomMetadata,
  EmailDraftFailureCode
> = {
  frameLimit: FRAME_LIMIT,
  failureCodes: {
    invalidMessage: "invalid_message",
    accessRevoked: "access_revoked",
    storageUnavailable: "storage_unavailable",
    roomFull: "room_full",
  },
  parseClientMessage: parseEmailRoomClientMessage,
  encodeServerMessage: encodeEmailRoomServerMessage,
};

class EmailDraftBacking implements CollaborationRoomBacking<
  EmailDraftDoc,
  EmailDraftRoomMetadata,
  EmailDraftFailureCode
> {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  async initialize(
    userId: UserId,
    scope: OrganisationExecutionScope,
  ): Promise<Result<null, Readonly<{ code: EmailDraftFailureCode }>>> {
    if (!(await isOrganisationExecutionActive(this.#storage.sql, scope)))
      return { ok: false, error: { code: "access_revoked" } };
    const initialized = this.#storage.transactionSync(
      initializeEmailDraft.bind(null, this.#storage.sql, userId),
    );
    if (initialized.ok) initialized.value.document.destroy();
    return initialized.ok ? { ok: true, value: null } : initialized;
  }

  readDocument(): EmailDraftCrdtResult<EmailDraftDoc> {
    const stored = readEmailDraft(this.#storage.sql);
    return stored.ok ? { ok: true, value: stored.value.document } : stored;
  }

  readForSync(): Promise<
    Result<
      Readonly<{
        document: EmailDraftDoc;
        metadata: EmailDraftRoomMetadata;
      }>,
      Readonly<{ code: EmailDraftFailureCode }>
    >
  > {
    const stored = readEmailDraft(this.#storage.sql);
    return Promise.resolve(
      stored.ok
        ? {
            ok: true,
            value: {
              document: stored.value.document,
              metadata: { documentRevision: stored.value.revision },
            },
          }
        : stored,
    );
  }

  persist(state: Uint8Array, userId: UserId): void {
    persistEmailDraft(this.#storage.sql, state, userId);
  }
}

function parseEmailRoomClientMessage(
  frame: unknown,
): Result<EmailDraftClientMessage, Readonly<{ code: EmailDraftFailureCode }>> {
  return parseEmailDraftClientMessage(frame);
}

function encodeEmailRoomServerMessage(
  message: CollaborationRoomServerMessage<
    EmailDraftUpdate,
    EmailDraftStateVector,
    EmailDraftSelection,
    EmailDraftRoomMetadata,
    EmailDraftFailureCode
  >,
): string {
  switch (message.kind) {
    case "sync_response":
      return encodeEmailDraftServerMessage({
        kind: "sync_response",
        serverStateVector: message.serverStateVector,
        missingUpdate: message.missingUpdate,
        documentRevision: message.metadata.documentRevision,
        access: message.access,
        sessionId: message.sessionId,
      });
    case "update_accepted":
      return encodeEmailDraftServerMessage(message);
    case "update_broadcast":
      return encodeEmailDraftServerMessage(message);
    case "presence_changed":
      return encodeEmailDraftServerMessage(message);
    case "failure":
      return encodeEmailDraftServerMessage(message);
    default:
      return assertNever(message);
  }
}

function createEmailDraftSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS email_draft (
    singleton_id TEXT PRIMARY KEY CHECK (singleton_id = 'active'),
    schema_version TEXT NOT NULL CHECK (schema_version = 'email_draft_crdt.v1'),
    encoded_state BLOB NOT NULL CHECK (length(encoded_state) <= 524288),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_by_app_user TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS email_draft_operation (
    operation_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    revision INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS email_draft_review (
    review_id TEXT PRIMARY KEY,
    document_revision INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    reviewed_by_app_user TEXT NOT NULL,
    reviewed_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS email_draft_thread (
    singleton_id TEXT PRIMARY KEY CHECK (singleton_id = 'active'),
    case_id TEXT NOT NULL,
    integration_account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    thread_url TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('shared', 'revoked')),
    changed_at INTEGER NOT NULL
  )`);
}

function initializeEmailDraft(
  sql: SqlStorage,
  userId: UserId,
): EmailDraftCrdtResult<StoredEmailDraft> {
  const exists =
    sql
      .exec(
        "SELECT singleton_id FROM email_draft WHERE singleton_id = ?",
        EMAIL_DRAFT_ID,
      )
      .toArray().length > 0;
  if (exists) return readEmailDraft(sql);
  const document = EmailDraftDoc.create();
  if (!document.ok) return document;
  try {
    const state = document.value.state();
    if (!state.ok) return state;
    const now = Date.now();
    sql.exec(
      `INSERT INTO email_draft
        (singleton_id, schema_version, encoded_state, revision, updated_by_app_user, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
      EMAIL_DRAFT_ID,
      EMAIL_DRAFT_SCHEMA,
      state.value.encode(),
      userId,
      now,
      now,
    );
  } finally {
    document.value.destroy();
  }
  return readEmailDraft(sql);
}

function readEmailDraft(
  sql: SqlStorage,
): EmailDraftCrdtResult<StoredEmailDraft> {
  const row = sql
    .exec(
      "SELECT schema_version, encoded_state, revision FROM email_draft WHERE singleton_id = ?",
      EMAIL_DRAFT_ID,
    )
    .toArray()[0];
  if (
    row === undefined ||
    row.schema_version !== EMAIL_DRAFT_SCHEMA ||
    !(row.encoded_state instanceof ArrayBuffer) ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1
  )
    return { ok: false, error: { code: "invalid_state" } };
  const state = parseEmailDraftState(new Uint8Array(row.encoded_state));
  if (!state.ok) return state;
  const document = EmailDraftDoc.restore(state.value);
  return document.ok
    ? { ok: true, value: { document: document.value, revision: row.revision } }
    : document;
}

function persistEmailDraft(
  sql: SqlStorage,
  state: Uint8Array,
  userId: UserId,
): void {
  sql.exec(
    `UPDATE email_draft
     SET encoded_state = ?, revision = revision + 1, updated_by_app_user = ?, updated_at = ?
     WHERE singleton_id = ?`,
    state,
    userId,
    Date.now(),
    EMAIL_DRAFT_ID,
  );
}

function readEmailDraftSnapshot(
  sql: SqlStorage,
): EmailDraftCrdtResult<EmailDraftRead> {
  const exists =
    sql
      .exec(
        "SELECT singleton_id FROM email_draft WHERE singleton_id = ?",
        EMAIL_DRAFT_ID,
      )
      .toArray().length > 0;
  if (!exists) {
    return {
      ok: true,
      value: {
        kind: "not_started",
        documentId: EMAIL_DRAFT_ID,
        revision: 0,
        observedAt: Date.now(),
      },
    };
  }
  const stored = readEmailDraft(sql);
  if (!stored.ok) return stored;
  try {
    return {
      ok: true,
      value: {
        kind: "active",
        documentId: EMAIL_DRAFT_ID,
        revision: stored.value.revision,
        observedAt: Date.now(),
        draft: stored.value.document.read(),
      },
    };
  } finally {
    stored.value.document.destroy();
  }
}

function editEmailDraftPassage(
  sql: SqlStorage,
  input: EmailDraftAgentEdit,
): Result<
  Readonly<{ value: EmailDraftRead; update: EmailDraftUpdate | null }>,
  EmailDraftOperationError
> {
  const requestJson = JSON.stringify([
    input.request.field,
    input.request.oldText,
    input.request.newText,
    input.request.expectedRevision,
    input.userId,
  ]);
  const prior = sql
    .exec(
      "SELECT request_json, revision, snapshot_json FROM email_draft_operation WHERE operation_id = ?",
      input.operationId,
    )
    .toArray()[0];
  if (prior !== undefined) return replayEmailOperation(prior, requestJson);
  const beforeExists =
    sql
      .exec(
        "SELECT singleton_id FROM email_draft WHERE singleton_id = ?",
        EMAIL_DRAFT_ID,
      )
      .toArray().length > 0;
  if (!beforeExists && input.request.expectedRevision !== 0) {
    return { ok: false, error: { code: "revision_conflict" } };
  }
  const stored = initializeEmailDraft(sql, input.userId);
  if (!stored.ok) return stored;
  try {
    const expectedRevision = beforeExists ? stored.value.revision : 0;
    if (input.request.expectedRevision !== expectedRevision) {
      return { ok: false, error: { code: "revision_conflict" } };
    }
    const before = stored.value.document.readField(input.request.field);
    const start = before.indexOf(input.request.oldText);
    if (
      (input.request.oldText.length === 0 && before.length !== 0) ||
      start < 0 ||
      (input.request.oldText.length > 0 &&
        before.indexOf(input.request.oldText, start + 1) !== -1)
    )
      return { ok: false, error: { code: "passage_conflict" } };
    const next =
      before.slice(0, start) +
      input.request.newText +
      before.slice(start + input.request.oldText.length);
    const update = stored.value.document.edit(input.request.field, next, {
      start,
      end: start + input.request.oldText.length,
    });
    if (!update.ok) return update;
    const state = stored.value.document.state();
    if (!state.ok) return state;
    persistEmailDraft(sql, state.value.encode(), input.userId);
    const value: EmailDraftRead = {
      kind: "active",
      documentId: EMAIL_DRAFT_ID,
      revision: stored.value.revision + 1,
      observedAt: Date.now(),
      draft: stored.value.document.read(),
    };
    sql.exec(
      "INSERT INTO email_draft_operation (operation_id, request_json, revision, snapshot_json) VALUES (?, ?, ?, ?)",
      input.operationId,
      requestJson,
      value.revision,
      JSON.stringify(value),
    );
    return { ok: true, value: { value, update: update.value } };
  } finally {
    stored.value.document.destroy();
  }
}

function replayEmailOperation(
  row: Record<string, SqlStorageValue>,
  requestJson: string,
): Result<
  Readonly<{ value: EmailDraftRead; update: null }>,
  EmailDraftOperationError
> {
  if (row.request_json !== requestJson)
    return { ok: false, error: { code: "operation_conflict" } };
  if (typeof row.snapshot_json !== "string")
    return { ok: false, error: { code: "invalid_state" } };
  try {
    const parsed: unknown = JSON.parse(row.snapshot_json);
    const value = parseStoredEmailRead(parsed);
    return value === null
      ? { ok: false, error: { code: "invalid_state" } }
      : { ok: true, value: { value, update: null } };
  } catch {
    return { ok: false, error: { code: "invalid_state" } };
  }
}

function parseStoredEmailRead(
  value: unknown,
): Variant<EmailDraftRead, "active"> | null {
  if (!isRecord(value)) return null;
  const raw = value;
  if (
    !hasExactKeys(raw, [
      "kind",
      "documentId",
      "revision",
      "observedAt",
      "draft",
    ]) ||
    raw.kind !== "active" ||
    raw.documentId !== EMAIL_DRAFT_ID ||
    typeof raw.revision !== "number" ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 1 ||
    typeof raw.observedAt !== "number" ||
    !isRecord(raw.draft)
  )
    return null;
  const draft = raw.draft;
  if (
    !hasExactKeys(draft, ["subject", "preview", "body"]) ||
    typeof draft.subject !== "string" ||
    typeof draft.preview !== "string" ||
    typeof draft.body !== "string"
  )
    return null;
  return {
    kind: "active",
    documentId: EMAIL_DRAFT_ID,
    revision: raw.revision,
    observedAt: raw.observedAt,
    draft: { subject: draft.subject, preview: draft.preview, body: draft.body },
  };
}
