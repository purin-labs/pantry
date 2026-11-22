import { assertNever, sha256Hex } from "@purin-labs/std";
import {
  normalizePlainText,
  type CollaborationAgent,
} from "@purin-labs/collaboration";
import {
  MailReplyDoc,
  MAIL_REPLY_SCHEMA,
  STATE_LIMIT,
  parseMailReplyState,
  type MailReplyCrdtResult,
  type MailReplyPresenceSelection,
  type MailReplyStateVector,
  type MailReplyUpdate,
} from "@purin-labs/mail-reply-crdt";
import {
  encodeDraftServerMessage,
  parseDraftClientMessage,
  FRAME_LIMIT,
  type DraftClientMessage,
  type DraftFailureCode,
  type MailReplyRoomMetadata,
} from "@purin-labs/mail-reply-crdt/protocol";
import type { SessionTurnExecution } from "../chat/turn-access";
import type { AuthorizedOrganisationRequest } from "../control/authorization";
import { controlError } from "../control/http";
import {
  readActiveOrganisationMembershipRevision,
  resolveUser,
} from "@purin-labs/tenancy/data/control-plane";
import { readEmailReplyProposalProjection } from "../data/email-mailbox";
import { gmailConnectorId } from "../mail-inbox/contract/connector-ids";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseIntegrationAccountId,
  type ControlSessionId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { type UserId } from "@purin-labs/control-api/ids";
import { authorizeMailSource } from "../mail-inbox/contract/mail-source-authorization";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { buildControlAuthority } from "../request-authority";
import type { Result } from "@purin-labs/kernel/result";
import { isOrganisationExecutionActive } from "./actor-execution-quiescence";
import { resolveActiveConnectorActorAtPlacement } from "./actor-router";
import {
  CollaborationRoom,
  type CollaborationParticipantAccess,
  type CollaborationParticipantCheck,
  type CollaborationRoomBacking,
  type CollaborationRoomProtocol,
  type CollaborationRoomServerMessage,
  type CollaborationSocketRoom,
} from "./collaboration-room";

/**
 * Plan 40D: a shared draft of one Inbox reply. The Gmail draft stays the
 * reviewed record; the room holds the text that people and agents edit
 * between saves. Each save becomes the next Gmail version through the
 * reviewed edit path, and the room deletes its text when the reply closes.
 */

/** How long one participant's mailbox check stays valid in memory. */
const PARTICIPANT_CHECK_TTL_MS = 30_000;

type MailReplyDraftAgentEditRequest = Readonly<{
  proposalId: string;
  oldText: string;
  newText: string;
}>;
type MailReplyDraftSnapshot = Readonly<{
  proposalId: string;
  integrationAccountId: string;
  body: string;
  savedVersion: number;
  unsaved: boolean;
}>;
export type MailReplyDraftAgentEdit = Readonly<{
  agent: CollaborationAgent;
  execution: SessionTurnExecution;
  organisationId: OrganisationId;
  request: MailReplyDraftAgentEditRequest;
  operationId: string;
  userId: UserId;
  deadlineAt: number;
}>;
/** What a save needs: the room's text and the version that it started from. */
type MailReplyDraftForSave =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "draft";
      body: string;
      savedVersion: number;
      unsaved: boolean;
      /** True when the saver alone wrote every change since the last save. */
      singleAuthor: boolean;
    }>;
type MailReplyDraftError = Readonly<{
  code:
    | DraftFailureCode
    | "passage_conflict"
    | "operation_conflict"
    | "organisation_placement_conflict"
    | "email_reply_draft_unsaved";
}>;

type DraftResult<T> = Result<T, MailReplyDraftError>;
type RoomResult<T> = Result<T, Readonly<{ code: DraftFailureCode }>>;
type StoredDraft = Readonly<{
  document: MailReplyDoc;
  integrationAccountId: string;
  savedVersion: number;
  savedBodyDigest: string;
  expiresAt: number;
}>;
type ReplySource = Readonly<{
  integrationAccountId: IntegrationAccountId;
  version: number;
  body: string;
  expiresAt: number;
}>;
type MailReplyRoom = CollaborationRoom<
  MailReplyUpdate,
  MailReplyStateVector,
  MailReplyPresenceSelection,
  MailReplyRoomMetadata,
  DraftFailureCode,
  MailReplyDoc
>;
type ParticipantCheckEntry = Readonly<{
  access: CollaborationParticipantAccess;
  checkedUntil: number;
}>;

export class MailReplyDraftRooms {
  readonly #rooms = new Map<string, MailReplyRoom>();
  readonly #checks = new Map<string, ParticipantCheckEntry>();
  // Each agent edit of a reply counts up, so a check that was in flight
  // during the edit does not keep its answer.
  readonly #checkGenerations = new Map<string, number>();
  readonly #ctx: DurableObjectState;
  readonly #storage: DurableObjectStorage;
  readonly #env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#storage = ctx.storage;
    this.#env = env;
    createMailReplyDraftSchema(ctx.storage.sql);
    // A reply that nobody opened again after it expired leaves no text.
    deleteExpiredDrafts(ctx.storage.sql, Date.now());
  }

  /** The room of a socket that the Actor accepted, after a wake. */
  socketRoom(
    organisationId: OrganisationId,
    proposalId: string,
  ): CollaborationSocketRoom {
    return this.#room(organisationId, proposalId);
  }

  async open(
    authorized: AuthorizedOrganisationRequest,
    proposalId: string,
    scope: OrganisationExecutionScope,
  ): Promise<Response> {
    const identity = await resolveUser({
      db: this.#env.DB,
      userId: authorized.authenticated.session.userId,
    });
    if (identity === null || identity.displayName.length > 256)
      return controlError("access_revoked", 403);
    return this.#room(authorized.organisationId, proposalId).open(
      authorized,
      identity.displayName,
      scope,
    );
  }

  /** The agent's read. It opens the draft from the current reply when needed. */
  async read(
    scope: OrganisationExecutionScope,
    proposalId: string,
    userId: UserId,
  ): Promise<DraftResult<MailReplyDraftSnapshot>> {
    const ensured = await this.#ensure(scope, proposalId, userId);
    if (!ensured.ok) return ensured;
    const stored = readDraft(this.#storage.sql, proposalId);
    if (!stored.ok) return stored;
    try {
      return { ok: true, value: await snapshotOf(proposalId, stored.value) };
    } finally {
      stored.value.document.destroy();
    }
  }

  async edit(
    input: MailReplyDraftAgentEdit,
    scope: OrganisationExecutionScope,
  ): Promise<DraftResult<MailReplyDraftSnapshot>> {
    const proposalId = input.request.proposalId;
    const ensured = await this.#ensure(scope, proposalId, input.userId);
    if (!ensured.ok) return ensured;
    // The reply's sources may have grown with this edit, so each participant
    // is checked again before the edit reaches them.
    this.#forgetChecks(proposalId);
    const edited = await this.#room(input.organisationId, proposalId).mutate(
      {
        scope,
        origin: { kind: "session_turn", execution: input.execution },
        userId: input.userId,
        deadlineAt: input.deadlineAt,
      },
      editDraftPassage.bind(null, this.#storage.sql, input),
      {
        agent: input.agent,
        operationId: await sha256Hex(input.operationId),
        target: "body",
      },
    );
    if (!edited.ok) return edited;
    const stored = readDraft(this.#storage.sql, proposalId);
    if (!stored.ok) return stored;
    try {
      return {
        ok: true,
        value: {
          ...(await snapshotOf(proposalId, stored.value)),
          body: edited.value,
        },
      };
    } finally {
      stored.value.document.destroy();
    }
  }

  /** The room's text for a save, or `none` when nobody opened the draft. */
  async forSave(
    proposalId: string,
    saver: UserId,
  ): Promise<DraftResult<MailReplyDraftForSave>> {
    if (!draftExists(this.#storage.sql, proposalId))
      return { ok: true, value: { kind: "none" } };
    const stored = readDraft(this.#storage.sql, proposalId);
    if (!stored.ok) return stored;
    try {
      const authors = readAuthors(this.#storage.sql, proposalId);
      const body = stored.value.document.read();
      return {
        ok: true,
        value: {
          kind: "draft",
          body,
          savedVersion: stored.value.savedVersion,
          unsaved: (await digestBody(body)) !== stored.value.savedBodyDigest,
          singleAuthor: authors.every(isAuthor.bind(null, `user:${saver}`)),
        },
      };
    } finally {
      stored.value.document.destroy();
    }
  }

  /**
   * Records that `body` is now Gmail version `version`. Text written after
   * the save read stays unsaved, and its authors stay recorded.
   */
  async markSaved(
    proposalId: string,
    version: number,
    body: string,
  ): Promise<DraftResult<null>> {
    const bodyDigest = await digestBody(body);
    const stored = readDraft(this.#storage.sql, proposalId);
    if (!stored.ok) return stored;
    try {
      const unchanged = stored.value.document.read() === body;
      this.#storage.transactionSync(() => {
        this.#storage.sql.exec(
          "UPDATE mail_reply_draft SET saved_version = ?, saved_body_digest = ?, updated_at = ? WHERE proposal_id = ?",
          version,
          bodyDigest,
          Date.now(),
          proposalId,
        );
        if (unchanged)
          this.#storage.sql.exec(
            "DELETE FROM mail_reply_draft_author WHERE proposal_id = ?",
            proposalId,
          );
      });
      return { ok: true, value: null };
    } finally {
      stored.value.document.destroy();
    }
  }

  /**
   * Whether a send of `version` sends what the room shows: the room must
   * hold no unsaved text, and its last save must be that version.
   */
  async approval(
    proposalId: string,
    version: number,
  ): Promise<DraftResult<null>> {
    if (!draftExists(this.#storage.sql, proposalId))
      return { ok: true, value: null };
    const stored = readDraft(this.#storage.sql, proposalId);
    if (!stored.ok) return stored;
    try {
      const current = await digestBody(stored.value.document.read());
      return stored.value.savedVersion === version &&
        current === stored.value.savedBodyDigest
        ? { ok: true, value: null }
        : { ok: false, error: { code: "email_reply_draft_unsaved" } };
    } finally {
      stored.value.document.destroy();
    }
  }

  /**
   * Starts the draft again from the current Gmail version, which drops the
   * room's unsaved text. A person chooses it after a save found a newer
   * version in Gmail.
   */
  async reload(
    scope: OrganisationExecutionScope,
    organisationId: OrganisationId,
    proposalId: string,
    person: Readonly<{ userId: UserId; controlSessionId: ControlSessionId }>,
  ): Promise<DraftResult<null>> {
    const ensured = await this.#ensure(scope, proposalId, person.userId);
    if (!ensured.ok) return ensured;
    const source = await readReplySource(this.#env, scope, proposalId);
    if (!source.ok) {
      if (source.error.code === "draft_closed")
        await this.close(organisationId, proposalId);
      return source;
    }
    const followed = await followSourceDigest(source.value);
    // The newer text is an edit of the shared document, so open clients
    // receive it, and a client that reconnects later merges with it.
    return this.#room(organisationId, proposalId).mutate(
      {
        scope,
        origin: {
          kind: "control_session",
          controlSessionId: person.controlSessionId,
        },
        userId: person.userId,
        deadlineAt: Date.now() + 30_000,
      },
      followSource.bind(
        null,
        this.#storage.sql,
        proposalId,
        followed,
        `user:${person.userId}`,
      ),
    );
  }

  /** Deletes the draft's text and ends its sockets. A closed reply stays closed. */
  async close(
    organisationId: OrganisationId,
    proposalId: string,
  ): Promise<void> {
    this.#storage.transactionSync(
      closeDraft.bind(null, this.#storage.sql, proposalId, Date.now()),
    );
    await this.#room(organisationId, proposalId).end("draft_closed");
  }

  async #ensure(
    scope: OrganisationExecutionScope,
    proposalId: string,
    userId: UserId,
  ): Promise<DraftResult<null>> {
    return initializeFromReply(
      this.#storage,
      this.#env,
      scope,
      proposalId,
      userId,
    );
  }

  /**
   * The mailbox check of one participant, after the role check. A person who
   * may read the mailbox and review this reply reads the draft; an owner or
   * admin edits it, as with a reviewed edit.
   */
  async participantAccess(
    proposalId: string,
    participant: CollaborationParticipantCheck,
    scope: OrganisationExecutionScope,
  ): Promise<CollaborationParticipantAccess> {
    const key = JSON.stringify([
      proposalId,
      participant.controlSessionId,
      participant.membership.userId,
      participant.membership.role,
    ]);
    const now = Date.now();
    const cached = this.#checks.get(key);
    if (cached !== undefined && cached.checkedUntil > now) return cached.access;
    const generation = this.#checkGenerations.get(proposalId) ?? 0;
    const access = await checkMailboxParticipant(
      this.#env,
      scope,
      proposalId,
      participant,
    );
    if (access === "unavailable") this.#checks.delete(key);
    // An agent edit during the check may have added sources, so an answer
    // from before the edit is not kept.
    else if ((this.#checkGenerations.get(proposalId) ?? 0) === generation)
      this.#checks.set(key, {
        access,
        checkedUntil: now + PARTICIPANT_CHECK_TTL_MS,
      });
    return access;
  }

  #forgetChecks(proposalId: string): void {
    this.#checkGenerations.set(
      proposalId,
      (this.#checkGenerations.get(proposalId) ?? 0) + 1,
    );
    for (const key of this.#checks.keys())
      if (key.startsWith(JSON.stringify([proposalId]).slice(0, -1)))
        this.#checks.delete(key);
  }

  #room(organisationId: OrganisationId, proposalId: string): MailReplyRoom {
    const existing = this.#rooms.get(proposalId);
    if (existing !== undefined) return existing;
    const room: MailReplyRoom = new CollaborationRoom({
      ctx: this.#ctx,
      env: this.#env,
      organisationId,
      protocol: MAIL_REPLY_ROOM_PROTOCOL,
      backing: new MailReplyRoomBacking(this, proposalId),
      route: { kind: "mail_reply_draft", key: proposalId },
      closeReason: "Reply draft disconnected",
      onEmpty: this.#remove.bind(this, proposalId),
    });
    this.#rooms.set(proposalId, room);
    return room;
  }

  #remove(proposalId: string): void {
    this.#rooms.delete(proposalId);
  }

  /** For the room's backing. */
  get storage(): DurableObjectStorage {
    return this.#storage;
  }

  /** For the room's backing. */
  get env(): Env {
    return this.#env;
  }
}

const MAIL_REPLY_ROOM_PROTOCOL: CollaborationRoomProtocol<
  MailReplyUpdate,
  MailReplyStateVector,
  MailReplyPresenceSelection,
  MailReplyRoomMetadata,
  DraftFailureCode
> = {
  frameLimit: FRAME_LIMIT,
  failureCodes: {
    invalidMessage: "invalid_message",
    accessRevoked: "access_revoked",
    storageUnavailable: "storage_unavailable",
    roomFull: "room_full",
  },
  parseClientMessage: parseMailReplyRoomClientMessage,
  encodeServerMessage: encodeMailReplyRoomServerMessage,
};

class MailReplyRoomBacking implements CollaborationRoomBacking<
  MailReplyDoc,
  MailReplyRoomMetadata,
  DraftFailureCode
> {
  readonly #rooms: MailReplyDraftRooms;
  readonly #proposalId: string;

  constructor(rooms: MailReplyDraftRooms, proposalId: string) {
    this.#rooms = rooms;
    this.#proposalId = proposalId;
  }

  async initialize(
    userId: UserId,
    scope: OrganisationExecutionScope,
  ): Promise<RoomResult<null>> {
    const initialized = await initializeFromReply(
      this.#rooms.storage,
      this.#rooms.env,
      scope,
      this.#proposalId,
      userId,
    );
    if (initialized.ok) return initialized;
    switch (initialized.error.code) {
      case "passage_conflict":
      case "operation_conflict":
      case "email_reply_draft_unsaved":
        return { ok: false, error: { code: "invalid_state" } };
      case "organisation_placement_conflict":
        return { ok: false, error: { code: "access_revoked" } };
      default:
        return { ok: false, error: { code: initialized.error.code } };
    }
  }

  readDocument(): RoomResult<MailReplyDoc> {
    const stored = readDraft(this.#rooms.storage.sql, this.#proposalId);
    return stored.ok ? { ok: true, value: stored.value.document } : stored;
  }

  async readForSync(): Promise<
    RoomResult<
      Readonly<{ document: MailReplyDoc; metadata: MailReplyRoomMetadata }>
    >
  > {
    const stored = readDraft(this.#rooms.storage.sql, this.#proposalId);
    if (!stored.ok) return stored;
    if (stored.value.expiresAt <= Date.now()) {
      stored.value.document.destroy();
      this.#rooms.storage.transactionSync(
        closeDraft.bind(
          null,
          this.#rooms.storage.sql,
          this.#proposalId,
          Date.now(),
        ),
      );
      return { ok: false, error: { code: "draft_closed" } };
    }
    const current = await digestBody(stored.value.document.read());
    return {
      ok: true,
      value: {
        document: stored.value.document,
        metadata: {
          savedVersion: stored.value.savedVersion,
          unsaved: current !== stored.value.savedBodyDigest,
        },
      },
    };
  }

  persist(state: Uint8Array, userId: UserId): void {
    persistDraft(
      this.#rooms.storage.sql,
      this.#proposalId,
      state,
      `user:${userId}`,
    );
  }

  participantAccess(
    participant: CollaborationParticipantCheck,
    scope: OrganisationExecutionScope,
  ): Promise<CollaborationParticipantAccess> {
    return this.#rooms.participantAccess(this.#proposalId, participant, scope);
  }
}

function parseMailReplyRoomClientMessage(
  frame: unknown,
): Result<DraftClientMessage, Readonly<{ code: DraftFailureCode }>> {
  return parseDraftClientMessage(frame);
}

function encodeMailReplyRoomServerMessage(
  message: CollaborationRoomServerMessage<
    MailReplyUpdate,
    MailReplyStateVector,
    MailReplyPresenceSelection,
    MailReplyRoomMetadata,
    DraftFailureCode
  >,
): string {
  switch (message.kind) {
    case "sync_response":
      return encodeDraftServerMessage({
        kind: "sync_response",
        serverStateVector: message.serverStateVector,
        missingUpdate: message.missingUpdate,
        savedVersion: message.metadata.savedVersion,
        unsaved: message.metadata.unsaved,
        access: message.access,
        sessionId: message.sessionId,
      });
    case "update_accepted":
      return encodeDraftServerMessage({
        kind: "update_accepted",
        updateId: message.updateId,
      });
    case "update_broadcast":
      return encodeDraftServerMessage({
        kind: "update_broadcast",
        update: message.update,
      });
    case "presence_changed":
      return encodeDraftServerMessage({
        kind: "presence_changed",
        participants: message.participants,
        agents: message.agents,
      });
    case "failure":
      return encodeDraftServerMessage({ kind: "failure", code: message.code });
    default:
      return assertNever(message);
  }
}

/**
 * Opens the draft from the current Gmail version when no row exists. A
 * draft whose reply is no longer current closes. A clean draft follows a
 * newer Gmail version; a draft with unsaved text keeps it, and its next save
 * fails as stale.
 */
async function initializeFromReply(
  storage: DurableObjectStorage,
  env: Env,
  scope: OrganisationExecutionScope,
  proposalId: string,
  userId: UserId,
): Promise<DraftResult<null>> {
  if (isClosed(storage.sql, proposalId))
    return { ok: false, error: { code: "draft_closed" } };
  const source = await readReplySource(env, scope, proposalId);
  if (!(await isOrganisationExecutionActive(storage.sql, scope)))
    return placementConflict();
  if (!source.ok) {
    if (source.error.code === "draft_closed")
      storage.transactionSync(
        closeDraft.bind(null, storage.sql, proposalId, Date.now()),
      );
    return source;
  }
  if (!draftExists(storage.sql, proposalId))
    return createDraftRow(storage, proposalId, source.value, userId);
  const stored = readDraft(storage.sql, proposalId);
  if (!stored.ok) return stored;
  try {
    if (stored.value.savedVersion === source.value.version)
      return { ok: true, value: null };
    const clean =
      (await digestBody(stored.value.document.read())) ===
      stored.value.savedBodyDigest;
    if (!clean) return { ok: true, value: null };
  } finally {
    stored.value.document.destroy();
  }
  // A clean draft follows the newer Gmail version as an edit. Open clients
  // receive it when they sync again.
  const followed = await followSourceDigest(source.value);
  const result = storage.transactionSync(
    followSource.bind(
      null,
      storage.sql,
      proposalId,
      followed,
      `user:${userId}`,
    ),
  );
  return result.ok ? { ok: true, value: null } : result;
}

type FollowedSource = ReplySource & Readonly<{ bodyDigest: string }>;

async function followSourceDigest(
  source: ReplySource,
): Promise<FollowedSource> {
  const body = normalizePlainText(source.body);
  return { ...source, body, bodyDigest: await digestBody(body) };
}

/** Edits the draft to the Gmail version's text and records it as saved. */
function followSource(
  sql: SqlStorage,
  proposalId: string,
  source: FollowedSource,
  author: string,
): Result<
  Readonly<{ value: null; update: MailReplyUpdate | null }>,
  MailReplyDraftError
> {
  const stored = readDraft(sql, proposalId);
  if (!stored.ok) return stored;
  try {
    let update: MailReplyUpdate | null = null;
    if (stored.value.document.read() !== source.body) {
      const edited = stored.value.document.edit(source.body);
      if (!edited.ok) return edited;
      const state = stored.value.document.state();
      if (!state.ok) return state;
      persistDraft(sql, proposalId, state.value.encode(), author);
      update = edited.value;
    }
    sql.exec(
      "UPDATE mail_reply_draft SET saved_version = ?, saved_body_digest = ?, expires_at = ?, updated_at = ? WHERE proposal_id = ?",
      source.version,
      source.bodyDigest,
      source.expiresAt,
      Date.now(),
      proposalId,
    );
    sql.exec(
      "DELETE FROM mail_reply_draft_author WHERE proposal_id = ?",
      proposalId,
    );
    return { ok: true, value: { value: null, update } };
  } finally {
    stored.value.document.destroy();
  }
}

async function createDraftRow(
  storage: DurableObjectStorage,
  proposalId: string,
  source: ReplySource,
  userId: UserId,
): Promise<DraftResult<null>> {
  const document = MailReplyDoc.create(source.body);
  if (!document.ok) return document;
  try {
    const state = document.value.state();
    if (!state.ok) return state;
    const bodyDigest = await digestBody(document.value.read());
    const now = Date.now();
    storage.transactionSync(() => {
      // Two opens at the same time create one document.
      if (draftExists(storage.sql, proposalId)) return;
      storage.sql.exec(
        `INSERT INTO mail_reply_draft
        (proposal_id, integration_account_id, schema_version, encoded_state, saved_version,
         saved_body_digest, expires_at, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        proposalId,
        source.integrationAccountId,
        MAIL_REPLY_SCHEMA,
        state.value.encode(),
        source.version,
        bodyDigest,
        source.expiresAt,
        `user:${userId}`,
        now,
        now,
      );
      storage.sql.exec(
        "DELETE FROM mail_reply_draft_author WHERE proposal_id = ?",
        proposalId,
      );
    });
    return { ok: true, value: null };
  } finally {
    document.value.destroy();
  }
}

/** The reply's current Gmail version, read through its Connector. */
async function readReplySource(
  env: Env,
  scope: OrganisationExecutionScope,
  proposalId: string,
): Promise<DraftResult<ReplySource>> {
  const projection = await readEmailReplyProposalProjection({
    db: scope.database,
    organisationId: scope.organisationId,
    proposalId,
  });
  if (projection === null)
    return { ok: false, error: { code: "draft_closed" } };
  const account = parseIntegrationAccountId(projection.integrationAccountId);
  if (!account.ok) return { ok: false, error: { code: "source_unavailable" } };
  const connectorId = gmailConnectorId(account.value);
  if (!connectorId.ok)
    return { ok: false, error: { code: "source_unavailable" } };
  const now = Date.now();
  const connector = await resolveActiveConnectorActorAtPlacement({
    env,
    namespace: env.CONNECTOR,
    organisationId: scope.organisationId,
    connectorId: connectorId.value,
    placement: scope.placement,
    now,
  });
  if (!connector.ok)
    return { ok: false, error: { code: "source_unavailable" } };
  const preview = await connector.value.previewEmailProposal({
    identity: {
      organisationId: scope.organisationId,
      connectorId: connectorId.value,
    },
    proposalId,
    now,
  });
  if (!preview.ok) return { ok: false, error: { code: "source_unavailable" } };
  if (preview.value.kind !== "current")
    return { ok: false, error: { code: "draft_closed" } };
  return {
    ok: true,
    value: {
      integrationAccountId: account.value,
      version: preview.value.preview.currentVersion,
      body: preview.value.preview.body,
      expiresAt: preview.value.preview.expiresAt,
    },
  };
}

/**
 * The gate of a reply preview: the person may read the mailbox, and the
 * Connector allows this person to review this reply.
 */
async function checkMailboxParticipant(
  env: Env,
  scope: OrganisationExecutionScope,
  proposalId: string,
  participant: CollaborationParticipantCheck,
): Promise<CollaborationParticipantAccess> {
  try {
    const projection = await readEmailReplyProposalProjection({
      db: scope.database,
      organisationId: scope.organisationId,
      proposalId,
    });
    if (projection === null) return "refused";
    const account = parseIntegrationAccountId(projection.integrationAccountId);
    if (!account.ok) return "refused";
    const membershipRevision = await readActiveOrganisationMembershipRevision({
      db: scope.database,
      organisationId: scope.organisationId,
    });
    if (membershipRevision === null) return "unavailable";
    const authority = buildControlAuthority({
      organisationId: scope.organisationId,
      requesterPersonId: participant.membership.personId,
      userId: participant.membership.userId,
      membershipRevision,
      role: participant.membership.role,
    }).requestAuthority;
    if ((await authorizeMailSource(env, authority, account.value)) === null)
      return "refused";
    const connectorId = gmailConnectorId(account.value);
    if (!connectorId.ok) return "refused";
    const connector = await resolveActiveConnectorActorAtPlacement({
      env,
      namespace: env.CONNECTOR,
      organisationId: scope.organisationId,
      connectorId: connectorId.value,
      placement: scope.placement,
      now: Date.now(),
    });
    if (!connector.ok) return "unavailable";
    const delivery = await connector.value.authorizeEmailProposalDelivery({
      identity: {
        organisationId: scope.organisationId,
        connectorId: connectorId.value,
      },
      proposalId,
      authority,
      now: Date.now(),
    });
    if (!delivery.ok)
      return delivery.error.code === "connector_placement_conflict"
        ? "unavailable"
        : "refused";
    return participant.membership.role === "owner" ||
      participant.membership.role === "admin"
      ? "edit"
      : "read";
  } catch {
    return "unavailable";
  }
}

function createMailReplyDraftSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS mail_reply_draft (
    proposal_id TEXT PRIMARY KEY,
    integration_account_id TEXT NOT NULL,
    schema_version TEXT NOT NULL CHECK (schema_version = 'mail_reply_crdt.v1'),
    encoded_state BLOB NOT NULL CHECK (length(encoded_state) <= ${STATE_LIMIT}),
    saved_version INTEGER NOT NULL CHECK (saved_version > 0),
    saved_body_digest TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  // Who changed the text since the last save: "user:<id>" or "agent:<id>".
  sql.exec(`CREATE TABLE IF NOT EXISTS mail_reply_draft_author (
    proposal_id TEXT NOT NULL,
    author TEXT NOT NULL,
    PRIMARY KEY (proposal_id, author)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS mail_reply_draft_operation (
    operation_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    body TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS mail_reply_draft_closed (
    proposal_id TEXT PRIMARY KEY,
    closed_at INTEGER NOT NULL
  )`);
}

function editDraftPassage(
  sql: SqlStorage,
  input: MailReplyDraftAgentEdit,
): Result<
  Readonly<{ value: string; update: MailReplyUpdate | null }>,
  MailReplyDraftError
> {
  const requestJson = JSON.stringify([
    input.request.proposalId,
    input.request.oldText,
    input.request.newText,
    input.userId,
  ]);
  const prior = sql
    .exec(
      "SELECT request_json, body FROM mail_reply_draft_operation WHERE operation_id = ?",
      input.operationId,
    )
    .toArray()[0];
  if (prior !== undefined) {
    if (prior.request_json !== requestJson)
      return { ok: false, error: { code: "operation_conflict" } };
    if (typeof prior.body !== "string")
      return { ok: false, error: { code: "invalid_state" } };
    return { ok: true, value: { value: prior.body, update: null } };
  }
  const stored = readDraft(sql, input.request.proposalId);
  if (!stored.ok) return stored;
  try {
    const before = stored.value.document.read();
    const { oldText, newText } = input.request;
    const start = before.indexOf(oldText);
    if (
      (oldText.length === 0 && before.length !== 0) ||
      start < 0 ||
      (oldText.length > 0 && before.indexOf(oldText, start + 1) !== -1)
    )
      return { ok: false, error: { code: "passage_conflict" } };
    const body =
      before.slice(0, start) + newText + before.slice(start + oldText.length);
    const update = stored.value.document.edit(body, {
      start,
      end: start + oldText.length,
    });
    if (!update.ok) return update;
    const state = stored.value.document.state();
    if (!state.ok) return state;
    persistDraft(
      sql,
      input.request.proposalId,
      state.value.encode(),
      `agent:${input.execution.sessionId}`,
    );
    sql.exec(
      "INSERT INTO mail_reply_draft_operation (operation_id, request_json, proposal_id, body) VALUES (?, ?, ?, ?)",
      input.operationId,
      requestJson,
      input.request.proposalId,
      body,
    );
    return { ok: true, value: { value: body, update: update.value } };
  } finally {
    stored.value.document.destroy();
  }
}

function readDraft(
  sql: SqlStorage,
  proposalId: string,
): MailReplyCrdtResult<StoredDraft> | Result<never, { code: "draft_closed" }> {
  if (isClosed(sql, proposalId))
    return { ok: false, error: { code: "draft_closed" } };
  const row = sql
    .exec(
      `SELECT schema_version, encoded_state, integration_account_id, saved_version,
        saved_body_digest, expires_at FROM mail_reply_draft WHERE proposal_id = ?`,
      proposalId,
    )
    .toArray()[0];
  if (
    row === undefined ||
    row.schema_version !== MAIL_REPLY_SCHEMA ||
    !(row.encoded_state instanceof ArrayBuffer) ||
    typeof row.integration_account_id !== "string" ||
    typeof row.saved_version !== "number" ||
    !Number.isSafeInteger(row.saved_version) ||
    row.saved_version < 1 ||
    typeof row.saved_body_digest !== "string" ||
    typeof row.expires_at !== "number"
  )
    return { ok: false, error: { code: "invalid_state" } };
  const state = parseMailReplyState(new Uint8Array(row.encoded_state));
  if (!state.ok) return state;
  const document = MailReplyDoc.restore(state.value);
  return document.ok
    ? {
        ok: true,
        value: {
          document: document.value,
          integrationAccountId: row.integration_account_id,
          savedVersion: row.saved_version,
          savedBodyDigest: row.saved_body_digest,
          expiresAt: row.expires_at,
        },
      }
    : document;
}

function persistDraft(
  sql: SqlStorage,
  proposalId: string,
  state: Uint8Array,
  author: string,
): void {
  sql.exec(
    "UPDATE mail_reply_draft SET encoded_state = ?, updated_by = ?, updated_at = ? WHERE proposal_id = ?",
    state,
    author,
    Date.now(),
    proposalId,
  );
  sql.exec(
    "INSERT OR IGNORE INTO mail_reply_draft_author (proposal_id, author) VALUES (?, ?)",
    proposalId,
    author,
  );
}

function closeDraft(sql: SqlStorage, proposalId: string, now: number): void {
  sql.exec("DELETE FROM mail_reply_draft WHERE proposal_id = ?", proposalId);
  sql.exec(
    "DELETE FROM mail_reply_draft_author WHERE proposal_id = ?",
    proposalId,
  );
  sql.exec(
    "DELETE FROM mail_reply_draft_operation WHERE proposal_id = ?",
    proposalId,
  );
  sql.exec(
    "INSERT OR IGNORE INTO mail_reply_draft_closed (proposal_id, closed_at) VALUES (?, ?)",
    proposalId,
    now,
  );
}

function deleteExpiredDrafts(sql: SqlStorage, now: number): void {
  const expired = sql
    .exec("SELECT proposal_id FROM mail_reply_draft WHERE expires_at <= ?", now)
    .toArray();
  for (const row of expired)
    if (typeof row.proposal_id === "string")
      closeDraft(sql, row.proposal_id, now);
}

function draftExists(sql: SqlStorage, proposalId: string): boolean {
  return (
    sql
      .exec(
        "SELECT proposal_id FROM mail_reply_draft WHERE proposal_id = ?",
        proposalId,
      )
      .toArray().length > 0
  );
}

function isClosed(sql: SqlStorage, proposalId: string): boolean {
  return (
    sql
      .exec(
        "SELECT proposal_id FROM mail_reply_draft_closed WHERE proposal_id = ?",
        proposalId,
      )
      .toArray().length > 0
  );
}

function readAuthors(sql: SqlStorage, proposalId: string): string[] {
  const authors: string[] = [];
  for (const row of sql
    .exec(
      "SELECT author FROM mail_reply_draft_author WHERE proposal_id = ?",
      proposalId,
    )
    .toArray())
    if (typeof row.author === "string") authors.push(row.author);
  return authors;
}

function isAuthor(expected: string, author: string): boolean {
  return author === expected;
}

async function snapshotOf(
  proposalId: string,
  stored: StoredDraft,
): Promise<MailReplyDraftSnapshot> {
  const body = stored.document.read();
  return {
    proposalId,
    integrationAccountId: stored.integrationAccountId,
    body,
    savedVersion: stored.savedVersion,
    unsaved: (await digestBody(body)) !== stored.savedBodyDigest,
  };
}

function digestBody(body: string): Promise<string> {
  return sha256Hex(body);
}

function placementConflict(): Result<
  never,
  Readonly<{ code: "organisation_placement_conflict" }>
> {
  return { ok: false, error: { code: "organisation_placement_conflict" } };
}
