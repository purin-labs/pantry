import { sha256Hex } from "@purin-labs/std";
import type { CollaborationAgent } from "@purin-labs/collaboration";
import type { SessionTurnExecution } from "../chat/turn-access";
import {
  ProductDescriptionDoc,
  PRODUCT_DESCRIPTION_SCHEMA,
  parseProductDescriptionState,
  type ProductDescriptionCrdtResult,
  type ProductDescriptionPresenceSelection,
  type ProductDescriptionStateVector,
  type ProductDescriptionUpdate,
} from "@purin-labs/product-description-crdt";
import {
  encodeDraftServerMessage,
  parseDraftClientMessage,
  FRAME_LIMIT,
  type DraftClientMessage,
  type DraftFailureCode,
  type ProductDescriptionRoomMetadata,
} from "@purin-labs/product-description-crdt/protocol";
import { listOrganisationMembers, resolveUser } from "../data/control-plane";
import { resolveOrganisationCommerceSystemAuthority } from "../data/organisation-commerce-system";
import type { AuthorizedOrganisationRequest } from "../control/authorization";
import { controlError } from "../control/http";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  readExactCommerceProjectionReference,
  COMMERCE_PROJECTION_STALE_AFTER_MS,
} from "./commerce-projection";
import { createCommerceClient } from "../commerce/contract/client";
import { commerceCanonicalResourceId } from "../commerce/contract/resource-ids";
import {
  parseCaseId,
  parseIntegrationAccountId,
  type CaseId,
  type IntegrationAccountId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import { readJsonRecord } from "../control/http";
import {
  CollaborationRoom,
  type CollaborationRoomBacking,
  type CollaborationRoomProtocol,
  type CollaborationRoomServerMessage,
  type CollaborationSocketRoom,
} from "./collaboration-room";
import { resolveCollaborationSlackThread } from "./collaboration-slack-thread";
import { assertNever, hasExactKeys } from "@purin-labs/std";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { isOrganisationExecutionActive } from "./actor-execution-quiescence";

export type DraftSharedThread = Readonly<{
  caseId: CaseId;
  integrationAccountId: IntegrationAccountId;
  conversationId: string;
  threadUrl: string;
  approvedBy: UserId;
}>;

type DraftSource = Readonly<{
  productId: string;
  title: string;
  description: string;
  revision: number;
}>;
type ResolvedDraftSource = Readonly<{
  product: DraftSource;
  canonicalProductId: string;
}>;
export type DraftAgentReadRequest = Readonly<{ productId: string }>;
/**
 * The agent's read: a null product reads the draft connected to the turn's
 * Slack thread.
 */
export type DraftAgentReadArgs = Readonly<{ productId: string | null }>;
export type DraftAgentEditRequest = Readonly<{
  productId: string;
  oldText: string;
  newText: string;
}>;
export type DraftAgentSnapshot = Readonly<{
  product: DraftSource;
  draft:
    | Readonly<{ kind: "not_started" }>
    | Readonly<{
        kind: "active";
        description: string;
        initializedFromProductRevision: number;
      }>;
}>;
export type DraftAgentEdit = Readonly<{
  agent: CollaborationAgent;
  execution: SessionTurnExecution;
  organisationId: OrganisationId;
  request: DraftAgentEditRequest;
  operationId: string;
  userId: UserId;
  deadlineAt: number;
}>;
type DraftOperationError = Readonly<{
  code:
    | DraftFailureCode
    | "product_not_found"
    | "passage_conflict"
    | "operation_conflict"
    | "organisation_placement_conflict";
}>;
type DraftAgentResult = Result<DraftAgentSnapshot, DraftOperationError>;
type DraftRoomResult<T> = Result<T, Readonly<{ code: DraftFailureCode }>>;
type DraftStoredState = Readonly<{
  document: ProductDescriptionDoc;
  initializedRevision: number;
}>;
type ProductDescriptionRoom = CollaborationRoom<
  ProductDescriptionUpdate,
  ProductDescriptionStateVector,
  ProductDescriptionPresenceSelection,
  ProductDescriptionRoomMetadata,
  DraftFailureCode,
  ProductDescriptionDoc
>;

export class ProductDescriptionDraftRooms {
  readonly #rooms = new Map<string, ProductDescriptionRoom>();
  readonly #ctx: DurableObjectState;
  readonly #storage: DurableObjectStorage;
  readonly #env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#storage = ctx.storage;
    this.#env = env;
    createProductDescriptionDraftSchema(ctx.storage.sql);
  }

  /** The room of a socket that the Actor accepted, after a wake. */
  socketRoom(
    organisationId: OrganisationId,
    productId: string,
  ): CollaborationSocketRoom {
    return this.#room(organisationId, productId);
  }

  async open(
    authorized: AuthorizedOrganisationRequest,
    productId: string,
    scope: OrganisationExecutionScope,
  ): Promise<Response> {
    const identity = await resolveUser({
      db: this.#env.DB,
      userId: authorized.authenticated.session.userId,
    });
    if (identity === null || identity.displayName.length > 256)
      return controlError("access_revoked", 403);
    return this.#room(authorized.organisationId, productId).open(
      authorized,
      identity.displayName,
      scope,
    );
  }

  async snapshot(
    scope: OrganisationExecutionScope,
    productId: string,
  ): Promise<Response> {
    const result = await this.#read(scope, productId, "authoritative");
    return result.ok
      ? Response.json({ ok: true, ...result.value })
      : controlError(result.error.code, 503);
  }

  /** The products whose drafts are connected to this Case's Slack thread. */
  connectedProducts(caseId: string): readonly string[] {
    return this.#storage.sql
      .exec(
        "SELECT product_id FROM product_description_draft_thread WHERE case_id = ? AND state = 'shared' ORDER BY product_id",
        caseId,
      )
      .toArray()
      .map((row) => String(row.product_id));
  }

  async sharedThread(
    scope: OrganisationExecutionScope,
    productId: string,
    caseId: string,
  ): Promise<DraftSharedThread | null> {
    const rows = this.#storage.sql
      .exec(
        "SELECT * FROM product_description_draft_thread WHERE product_id = ? AND case_id = ? AND state = 'shared'",
        productId,
        caseId,
      )
      .toArray();
    const row = rows[0];
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
    productId: string,
    scope: OrganisationExecutionScope,
  ): Promise<Response> {
    if (request.method === "GET") {
      const rows = this.#storage.sql
        .exec(
          "SELECT case_id FROM product_description_draft_thread WHERE product_id = ? AND state = 'shared'",
          productId,
        )
        .toArray();
      const sharing =
        rows[0] === undefined
          ? null
          : await this.sharedThread(scope, productId, String(rows[0].case_id));
      return Response.json({ ok: true, threadUrl: sharing?.threadUrl ?? null });
    }
    if (request.method === "DELETE") {
      this.#storage.sql.exec(
        "UPDATE product_description_draft_thread SET state = 'revoked', changed_at = ?, approved_by = ? WHERE product_id = ?",
        Date.now(),
        authorized.authenticated.session.userId,
        productId,
      );
      return Response.json({ ok: true, threadUrl: null });
    }
    const body = await readJsonRecord(request);
    if (
      !body.ok ||
      !hasExactKeys(body.value, ["threadUrl"]) ||
      typeof body.value.threadUrl !== "string"
    )
      return controlError("draft_thread_link_invalid", 422);
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
    const source = await readDraftSource(
      this.#storage.sql,
      this.#env,
      scope,
      productId,
      "projection",
    );
    if (!source.ok) return controlError(source.error.code, 409);
    if (!(await isOrganisationExecutionActive(this.#storage.sql, scope)))
      return controlError("organisation_placement_conflict", 409);
    this.#storage.sql.exec(
      `INSERT INTO product_description_draft_thread (product_id, case_id, integration_account_id, conversation_id, thread_url, approved_by, state, changed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'shared', ?) ON CONFLICT(product_id) DO UPDATE SET
      case_id = excluded.case_id, integration_account_id = excluded.integration_account_id, conversation_id = excluded.conversation_id,
      thread_url = excluded.thread_url, approved_by = excluded.approved_by, state = 'shared', changed_at = excluded.changed_at`,
      productId,
      target.value.caseId,
      target.value.integrationAccountId,
      target.value.conversationId,
      target.value.threadUrl,
      authorized.authenticated.session.userId,
      Date.now(),
    );
    return Response.json({ ok: true, threadUrl: target.value.threadUrl });
  }

  async read(
    scope: OrganisationExecutionScope,
    productId: string,
  ): Promise<DraftAgentResult> {
    const result = await this.#read(scope, productId, "projection");
    return result.ok
      ? {
          ok: true,
          value: { product: result.value.product, draft: result.value.draft },
        }
      : result;
  }

  async #read(
    scope: OrganisationExecutionScope,
    productId: string,
    sourceKind: "projection" | "authoritative",
  ): Promise<
    Result<
      DraftAgentSnapshot & Readonly<{ canonicalProductId: string }>,
      DraftOperationError
    >
  > {
    const source = await readDraftSource(
      this.#storage.sql,
      this.#env,
      scope,
      productId,
      sourceKind,
    );
    if (!source.ok) return source;
    if (!(await isOrganisationExecutionActive(this.#storage.sql, scope)))
      return draftPlacementConflict();
    const exists =
      this.#storage.sql
        .exec(
          "SELECT product_id FROM product_description_draft WHERE product_id = ?",
          productId,
        )
        .toArray().length > 0;
    if (!exists)
      return {
        ok: true,
        value: { ...source.value, draft: { kind: "not_started" } },
      };
    const stored = readDraft(this.#storage.sql, productId);
    if (!stored.ok) return stored;
    try {
      return {
        ok: true,
        value: {
          ...source.value,
          draft: {
            kind: "active",
            description: stored.value.document.read(),
            initializedFromProductRevision: stored.value.initializedRevision,
          },
        },
      };
    } finally {
      stored.value.document.destroy();
    }
  }

  async edit(
    input: DraftAgentEdit,
    scope: OrganisationExecutionScope,
  ): Promise<DraftAgentResult> {
    const source = await readDraftSource(
      this.#storage.sql,
      this.#env,
      scope,
      input.request.productId,
      "projection",
    );
    if (!source.ok) return source;
    return this.#room(input.organisationId, input.request.productId).mutate(
      {
        scope,
        origin: { kind: "session_turn", execution: input.execution },
        userId: input.userId,
        deadlineAt: input.deadlineAt,
      },
      editDraftPassage.bind(
        null,
        this.#storage.sql,
        input,
        source.value.product,
      ),
      { agent: input.agent, operationId: await sha256Hex(input.operationId), target: "description" },
    );
  }

  #room(
    organisationId: OrganisationId,
    productId: string,
  ): ProductDescriptionRoom {
    const existing = this.#rooms.get(productId);
    if (existing !== undefined) return existing;
    const room = createProductDescriptionRoom({
      ctx: this.#ctx,
      env: this.#env,
      organisationId,
      productId,
      onEmpty: this.#remove.bind(this, productId),
    });
    this.#rooms.set(productId, room);
    return room;
  }

  #remove(productId: string): void {
    this.#rooms.delete(productId);
  }
}

const PRODUCT_DESCRIPTION_ROOM_PROTOCOL: CollaborationRoomProtocol<
  ProductDescriptionUpdate,
  ProductDescriptionStateVector,
  ProductDescriptionPresenceSelection,
  ProductDescriptionRoomMetadata,
  DraftFailureCode
> = {
  frameLimit: FRAME_LIMIT,
  failureCodes: {
    invalidMessage: "invalid_message",
    accessRevoked: "access_revoked",
    storageUnavailable: "storage_unavailable",
    roomFull: "room_full",
  },
  parseClientMessage: parseProductDescriptionRoomClientMessage,
  encodeServerMessage: encodeProductDescriptionRoomServerMessage,
};

class ProductDescriptionRoomBacking implements CollaborationRoomBacking<
  ProductDescriptionDoc,
  ProductDescriptionRoomMetadata,
  DraftFailureCode
> {
  readonly #storage: DurableObjectStorage;
  readonly #env: Env;
  readonly #productId: string;

  constructor(storage: DurableObjectStorage, env: Env, productId: string) {
    this.#storage = storage;
    this.#env = env;
    this.#productId = productId;
  }

  async initialize(
    userId: UserId,
    scope: OrganisationExecutionScope,
  ): Promise<DraftRoomResult<null>> {
    const source = await readDraftSource(
      this.#storage.sql,
      this.#env,
      scope,
      this.#productId,
      "projection",
    );
    if (!source.ok) return sourceUnavailable();
    if (!(await isOrganisationExecutionActive(this.#storage.sql, scope)))
      return { ok: false, error: { code: "access_revoked" } };
    const stored = this.#storage.transactionSync(
      initializeDraft.bind(
        null,
        this.#storage.sql,
        source.value.product,
        userId,
      ),
    );
    if (!stored.ok) return stored;
    stored.value.document.destroy();
    return { ok: true, value: null };
  }

  readDocument(): DraftRoomResult<ProductDescriptionDoc> {
    const stored = readDraft(this.#storage.sql, this.#productId);
    return stored.ok ? { ok: true, value: stored.value.document } : stored;
  }

  async readForSync(scope: OrganisationExecutionScope): Promise<
    DraftRoomResult<
      Readonly<{
        document: ProductDescriptionDoc;
        metadata: ProductDescriptionRoomMetadata;
      }>
    >
  > {
    const source = await readDraftSource(
      this.#storage.sql,
      this.#env,
      scope,
      this.#productId,
      "projection",
    );
    if (!source.ok) return sourceUnavailable();
    const stored = readDraft(this.#storage.sql, this.#productId);
    if (!stored.ok) return stored;
    return {
      ok: true,
      value: {
        document: stored.value.document,
        metadata: {
          initializedFromProductRevision: stored.value.initializedRevision,
          currentProductRevision: source.value.product.revision,
        },
      },
    };
  }

  persist(state: Uint8Array, userId: UserId): void {
    persistDraft(this.#storage.sql, this.#productId, state, userId);
  }
}

function createProductDescriptionRoom(
  input: Readonly<{
    ctx: DurableObjectState;
    env: Env;
    organisationId: OrganisationId;
    productId: string;
    onEmpty: () => void;
  }>,
): ProductDescriptionRoom {
  return new CollaborationRoom({
    ctx: input.ctx,
    env: input.env,
    organisationId: input.organisationId,
    protocol: PRODUCT_DESCRIPTION_ROOM_PROTOCOL,
    backing: new ProductDescriptionRoomBacking(
      input.ctx.storage,
      input.env,
      input.productId,
    ),
    route: { kind: "product_description", key: input.productId },
    closeReason: "Description draft disconnected",
    onEmpty: input.onEmpty,
  });
}

function parseProductDescriptionRoomClientMessage(
  frame: unknown,
): Result<DraftClientMessage, Readonly<{ code: DraftFailureCode }>> {
  return parseDraftClientMessage(frame);
}

function encodeProductDescriptionRoomServerMessage(
  message: CollaborationRoomServerMessage<
    ProductDescriptionUpdate,
    ProductDescriptionStateVector,
    ProductDescriptionPresenceSelection,
    ProductDescriptionRoomMetadata,
    DraftFailureCode
  >,
): string {
  switch (message.kind) {
    case "sync_response":
      return encodeDraftServerMessage({
        kind: "sync_response",
        serverStateVector: message.serverStateVector,
        missingUpdate: message.missingUpdate,
        initializedFromProductRevision:
          message.metadata.initializedFromProductRevision,
        currentProductRevision: message.metadata.currentProductRevision,
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

async function readDraftSource(
  sql: SqlStorage,
  env: Env,
  scope: OrganisationExecutionScope,
  productId: string,
  sourceKind: "projection" | "authoritative",
): Promise<
  Result<ResolvedDraftSource, { code: "source_unavailable" | "product_not_found" }>
> {
  const organisationId = scope.organisationId;
  if (!(await isOrganisationExecutionActive(sql, scope)))
    return sourceUnavailable();
  const authority = await resolveOrganisationCommerceSystemAuthority({
    db: scope.database,
    organisationId,
  });
  if (!(await isOrganisationExecutionActive(sql, scope)))
    return sourceUnavailable();
  if (
    !authority.ok ||
    authority.value.provider !== "commerce" ||
    authority.value.commerceSystem.kind !== "builtin_commerce"
  )
    return sourceUnavailable();
  const merchantId = authority.value.commerceSystem.merchantId;
  const canonicalProductId = commerceCanonicalResourceId(
    merchantId,
    productId,
  );
  if (sourceKind === "projection") {
    const record = readExactCommerceProjectionReference(sql, {
      organisationId,
      integrationAccountId: authority.value.integrationAccountId,
      kind: "product",
      canonicalId: canonicalProductId,
    });
    if (
      record.ok &&
      record.value !== null &&
      record.value.kind === "product" &&
      record.value.projection.projection.provenance.source === "commerce" &&
      Date.now() - record.value.validatedAt <=
        COMMERCE_PROJECTION_STALE_AFTER_MS
    ) {
      return {
        ok: true,
        value: {
          canonicalProductId,
          product: {
            productId,
            title: record.value.projection.projection.title,
            description: record.value.projection.projection.description,
            revision: record.value.revision,
          },
        },
      };
    }
  }
  const client = createCommerceClient(
    env,
    fetchDraftSource.bind(null, sql, env, scope),
    {
      kind: "organisation",
      organisationId: String(organisationId),
    },
  );
  if (client === null) return sourceUnavailable();
  const snapshot = await client.readSnapshot(merchantId);
  if (!(await isOrganisationExecutionActive(sql, scope)))
    return sourceUnavailable();
  if (!snapshot.ok || snapshot.value.merchantId !== merchantId)
    return sourceUnavailable();
  for (const product of snapshot.value.resources.products) {
    if (product.id === productId)
      return {
        ok: true,
        value: {
          canonicalProductId,
          product: {
            productId,
            title: product.title,
            description: product.description,
            revision: product.revision,
          },
        },
      };
  }
  // The shop answered and has no product with this id.
  return { ok: false, error: { code: "product_not_found" } };
}

function sourceUnavailable(): Result<never, { code: "source_unavailable" }> {
  return { ok: false, error: { code: "source_unavailable" } };
}

async function fetchDraftSource(
  sql: SqlStorage,
  env: Env,
  scope: OrganisationExecutionScope,
  request: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<Response> {
  if (!(await isOrganisationExecutionActive(sql, scope)))
    throw new Error("organisation_placement_conflict");
  return env.COMMERCE.fetch(request, init);
}

function draftPlacementConflict(): Result<
  never,
  Readonly<{ code: "organisation_placement_conflict" }>
> {
  return { ok: false, error: { code: "organisation_placement_conflict" } };
}

function createProductDescriptionDraftSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS product_description_draft_thread (
    product_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, integration_account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL, thread_url TEXT NOT NULL, approved_by TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('shared', 'revoked')), changed_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS product_description_draft (
    product_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = 'product_description_crdt.v1'),
    encoded_state BLOB NOT NULL CHECK (length(encoded_state) <= 262144),
    initialized_from_product_revision INTEGER NOT NULL CHECK (initialized_from_product_revision > 0),
    updated_by_app_user TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS product_description_draft_operation (
    operation_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    product_id TEXT NOT NULL,
    product_title TEXT NOT NULL,
    product_description TEXT NOT NULL,
    product_revision INTEGER NOT NULL,
    draft_description TEXT NOT NULL,
    initialized_revision INTEGER NOT NULL
  )`);
}

function editDraftPassage(
  sql: SqlStorage,
  input: DraftAgentEdit,
  source: DraftSource,
): Result<
  Readonly<{
    value: DraftAgentSnapshot;
    update: ProductDescriptionUpdate | null;
  }>,
  DraftOperationError
> {
  const requestJson = JSON.stringify([
    input.request.productId,
    input.request.oldText,
    input.request.newText,
    input.userId,
  ]);
  const prior = sql
    .exec(
      "SELECT * FROM product_description_draft_operation WHERE operation_id = ?",
      input.operationId,
    )
    .toArray()[0];
  if (prior !== undefined) {
    if (prior.request_json !== requestJson)
      return { ok: false, error: { code: "operation_conflict" } };
    if (
      typeof prior.product_id !== "string" ||
      typeof prior.product_title !== "string" ||
      typeof prior.product_description !== "string" ||
      typeof prior.product_revision !== "number" ||
      typeof prior.draft_description !== "string" ||
      typeof prior.initialized_revision !== "number"
    ) {
      return { ok: false, error: { code: "invalid_state" } };
    }
    return {
      ok: true,
      value: {
        update: null,
        value: {
          product: {
            productId: prior.product_id,
            title: prior.product_title,
            description: prior.product_description,
            revision: prior.product_revision,
          },
          draft: {
            kind: "active",
            description: prior.draft_description,
            initializedFromProductRevision: prior.initialized_revision,
          },
        },
      },
    };
  }
  const stored = initializeDraft(sql, source, input.userId);
  if (!stored.ok) return stored;
  try {
    const before = stored.value.document.read();
    const { oldText, newText } = input.request;
    const start = before.indexOf(oldText);
    if (
      (oldText.length === 0 && before.length !== 0) ||
      start < 0 ||
      (oldText.length > 0 && before.indexOf(oldText, start + 1) !== -1)
    ) {
      return { ok: false, error: { code: "passage_conflict" } };
    }
    const description =
      before.slice(0, start) + newText + before.slice(start + oldText.length);
    const update = stored.value.document.edit(description, {
      start,
      end: start + oldText.length,
    });
    if (!update.ok) return update;
    const state = stored.value.document.state();
    if (!state.ok) return state;
    persistDraft(sql, source.productId, state.value.encode(), input.userId);
    sql.exec(
      `INSERT INTO product_description_draft_operation
      (operation_id, request_json, product_id, product_title, product_description, product_revision, draft_description, initialized_revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.operationId,
      requestJson,
      source.productId,
      source.title,
      source.description,
      source.revision,
      description,
      stored.value.initializedRevision,
    );
    return {
      ok: true,
      value: {
        update: update.value,
        value: {
          product: source,
          draft: {
            kind: "active",
            description,
            initializedFromProductRevision: stored.value.initializedRevision,
          },
        },
      },
    };
  } finally {
    stored.value.document.destroy();
  }
}

function initializeDraft(
  sql: SqlStorage,
  source: DraftSource,
  identity: UserId,
): ProductDescriptionCrdtResult<DraftStoredState> {
  const exists =
    sql
      .exec(
        "SELECT product_id FROM product_description_draft WHERE product_id = ?",
        source.productId,
      )
      .toArray().length > 0;
  if (exists) return readDraft(sql, source.productId);
  const document = ProductDescriptionDoc.create(source.description);
  if (!document.ok) return document;
  try {
    const state = document.value.state();
    if (!state.ok) return state;
    const now = Date.now();
    sql.exec(
      `INSERT INTO product_description_draft
      (product_id, schema_version, encoded_state, initialized_from_product_revision, updated_by_app_user, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      source.productId,
      PRODUCT_DESCRIPTION_SCHEMA,
      state.value.encode(),
      source.revision,
      identity,
      now,
      now,
    );
  } finally {
    document.value.destroy();
  }
  return readDraft(sql, source.productId);
}

function readDraft(
  sql: SqlStorage,
  productId: string,
): ProductDescriptionCrdtResult<DraftStoredState> {
  const row = sql
    .exec(
      "SELECT schema_version, encoded_state, initialized_from_product_revision FROM product_description_draft WHERE product_id = ?",
      productId,
    )
    .toArray()[0];
  if (
    row === undefined ||
    row.schema_version !== PRODUCT_DESCRIPTION_SCHEMA ||
    !(row.encoded_state instanceof ArrayBuffer) ||
    typeof row.initialized_from_product_revision !== "number" ||
    !Number.isSafeInteger(row.initialized_from_product_revision) ||
    row.initialized_from_product_revision < 1
  ) {
    return { ok: false, error: { code: "invalid_state" } };
  }
  const state = parseProductDescriptionState(new Uint8Array(row.encoded_state));
  if (!state.ok) return state;
  const doc = ProductDescriptionDoc.restore(state.value);
  return doc.ok
    ? {
        ok: true,
        value: {
          document: doc.value,
          initializedRevision: row.initialized_from_product_revision,
        },
      }
    : doc;
}

function persistDraft(
  sql: SqlStorage,
  productId: string,
  state: Uint8Array,
  identity: UserId,
): void {
  sql.exec(
    "UPDATE product_description_draft SET encoded_state = ?, updated_by_app_user = ?, updated_at = ? WHERE product_id = ?",
    state,
    identity,
    Date.now(),
    productId,
  );
}
