import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationAccess } from "@purin-labs/tenancy/organisation-access/access";
import { decideChatFlowDelivery } from "./information-flow";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  VISIBLE_CONVERSATIONS_SQL,
  conversationCaseIdentity,
} from "./conversation-access";
import { initialConversationCaseIdentity } from "./conversation-actor-identity";
import { parseConversationId, isConversationId } from "@purin-labs/control-api";
import type { ConversationId } from "@purin-labs/control-api";
import { readCurrentOrganisationPolicySnapshot } from "@purin-labs/authority/policy-snapshot";
import {
  compileTurnAuthority,
  CONTEXT_CASE_READ_CAPABILITY,
} from "@purin-labs/authority/authorization/access-grants/turn-authority";
import { canonicalJson, sha256Hex, isRecord } from "@purin-labs/std";
import type { HarnessTurnLease } from "@purin-labs/contracts";
import {
  resolveActiveSessionActor,
  type ActorResolutionError,
} from "@purin-labs/actor-runtime/actors/actor-router";
import type { Result } from "@purin-labs/kernel/result";
import { deriveDirectCaseIdentities } from "../actors/case-direct-processing";
import { admitSessionInformationFlowObservation } from "@purin-labs/agent/actors/agent-session-information-flow";
import type { Env } from "@purin-labs/kernel/env";
import type { SessionActorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import { parseSessionId, type OrganisationId } from "@purin-labs/kernel/ids";
import { type UserId } from "@purin-labs/control-api/ids";
import {
  FlowBinding,
  ObservationEvidence,
} from "@purin-labs/authority/policy/information-flow/index";
import type { RequestAuthority } from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";
import {
  normalizeConversationTimeline,
  parseConversation,
  type Conversation,
} from "./conversation";
import {
  readConversation,
  reconcileRevokedConversationRun,
  saveConversation,
  type ConversationScope,
} from "./store";
import {
  assertCompletedHistory,
  chatForkAttachments,
  parseChatHistorySnapshot,
  chatForkHistoryDigest,
  parseChatForkHistory,
  type ChatForkHistory,
  type ChatHistoryBinding,
} from "@purin-labs/agent/chat/fork-history";

export type ChatForkCommand = Readonly<{
  operationId: string;
  messageId: string;
}>;

export class ForkHistoryAccessError extends Error {
  constructor(
    readonly reason: "source_policy_denied" | "evidence_unavailable",
    code: string,
  ) {
    super(code);
  }
}
export type ChatForkResult =
  | Readonly<{
      kind: "ready";
      conversationId: ConversationId;
      operationId: string;
      digest: string;
      code?: never;
    }>
  | Readonly<{
      kind: "preparing";
      conversationId: ConversationId;
      operationId: string;
      digest?: never;
      code?: never;
    }>
  | Readonly<{
      kind: "failed";
      conversationId: ConversationId;
      operationId: string;
      code: string;
      digest?: never;
    }>
  | Readonly<{
      kind: "rejected";
      code: string;
      conversationId?: never;
      operationId?: never;
      digest?: never;
    }>;

type ForkIdentity = Readonly<{
  operation_id: string;
  source_conversation_id: string;
  source_message_id: string;
  destination_conversation_id: string;
  destination_case_id: string;
}>;
type ForkRow = ForkIdentity &
  (
    | Readonly<{
        status: "preparing" | "erased";
        history_json: null;
        conversation_json: null;
        digest: null;
        failure_code: null;
      }>
    | Readonly<{
        status: "prepared";
        history_json: string;
        conversation_json: string;
        digest: string;
        failure_code: null;
      }>
    | Readonly<{
        status: "ready";
        history_json: string;
        conversation_json: null;
        digest: string;
        failure_code: null;
      }>
    | Readonly<{
        status: "failed";
        history_json: null;
        conversation_json: null;
        digest: null;
        failure_code: string;
      }>
  );
function parseForkRow(raw: unknown): ForkRow | null {
  if (raw === null) return null;
  if (
    !isRecord(raw) ||
    typeof raw.operation_id !== "string" ||
    !isConversationId(raw.source_conversation_id) ||
    typeof raw.source_message_id !== "string" ||
    !isConversationId(raw.destination_conversation_id) ||
    typeof raw.destination_case_id !== "string"
  )
    throw new Error("chat_fork_receipt_invalid");
  const identity: ForkIdentity = {
    operation_id: raw.operation_id,
    source_conversation_id: raw.source_conversation_id,
    source_message_id: raw.source_message_id,
    destination_conversation_id: raw.destination_conversation_id,
    destination_case_id: raw.destination_case_id,
  };
  switch (raw.status) {
    case "preparing":
    case "erased":
      if (
        raw.history_json !== null ||
        raw.conversation_json !== null ||
        raw.digest !== null ||
        raw.failure_code !== null
      )
        throw new Error("chat_fork_receipt_invalid");
      return {
        ...identity,
        status: raw.status,
        history_json: null,
        conversation_json: null,
        digest: null,
        failure_code: null,
      };
    case "failed":
      if (
        raw.history_json !== null ||
        raw.conversation_json !== null ||
        raw.digest !== null ||
        typeof raw.failure_code !== "string"
      )
        throw new Error("chat_fork_receipt_invalid");
      return {
        ...identity,
        status: "failed",
        history_json: null,
        conversation_json: null,
        digest: null,
        failure_code: raw.failure_code,
      };
    case "prepared":
      if (
        typeof raw.history_json !== "string" ||
        typeof raw.conversation_json !== "string" ||
        typeof raw.digest !== "string" ||
        raw.failure_code !== null
      )
        throw new Error("chat_fork_receipt_invalid");
      return {
        ...identity,
        status: "prepared",
        history_json: raw.history_json,
        conversation_json: raw.conversation_json,
        digest: raw.digest,
        failure_code: null,
      };
    case "ready":
      if (
        typeof raw.history_json !== "string" ||
        raw.conversation_json !== null ||
        typeof raw.digest !== "string" ||
        raw.failure_code !== null
      )
        throw new Error("chat_fork_receipt_invalid");
      return {
        ...identity,
        status: "ready",
        history_json: raw.history_json,
        conversation_json: null,
        digest: raw.digest,
        failure_code: null,
      };
    default:
      throw new Error("chat_fork_receipt_invalid");
  }
}

export async function bindCompletedChatHistory(
  env: Env,
  scope: ConversationScope,
  conversation: Conversation,
  requestId: string,
  sessionIdRaw: string,
  turnId: string,
  finished: boolean,
): Promise<Conversation> {
  const sessionId = parseSessionId(sessionIdRaw);
  if (!sessionId.ok) throw new Error("chat_history_session_invalid");
  const actor = await resolveActiveSessionActor({
    env: env,
    namespace: env.SESSION,
    organisationId: scope.organisationId,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  const accepted = await parseChatHistorySnapshot(
    await actor.value.readCompletedChatHistory({
      organisationId: scope.organisationId,
      sessionId: sessionId.value,
      turnId,
      throughSequence: null,
    }),
  );
  let responseId: string | null = null;
  if (finished)
    for (const event of conversation.timeline)
      if (event.kind === "assistant" && event.requestId === requestId)
        responseId = event.eventId;
  const binding: ChatHistoryBinding = {
    requestId,
    responseId,
    throughSequence: finished
      ? (conversation.timeline.find(
          isSelectedResponse.bind(null, responseId ?? ""),
        )?.sequence ?? conversation.latestSequence)
      : conversation.latestSequence,
    sessionId: sessionId.value,
    turnId,
    cursor: accepted.cursor,
    modelRoute: conversation.modelRoute,
  };
  return {
    ...conversation,
    historyBindings: [...conversation.historyBindings, binding],
  };
}

/** The largest prepared fork: its history and its conversation, in bytes. */
const FORK_HISTORY_BYTES = 1_800_000;

export async function forkChat(
  env: Env,
  placement: OrganisationExecutionScope,
  userId: UserId,
  authority: Variant<RequestAuthority, "control">,
  sourceId: ConversationId,
  command: ChatForkCommand,
): Promise<ChatForkResult> {
  if (
    authority.organisationId !== placement.organisationId ||
    authority.userId !== userId
  )
    return { kind: "rejected", code: "chat_fork_history_forbidden" };
  if (!(await placement.isActive()))
    return { kind: "rejected", code: "chat_fork_conflict" };
  const scope: ConversationScope = {
    organisationId: placement.organisationId,
    userId,
  };
  const db = placement.database;
  await reconcileRevokedConversationRun(placement, scope.userId, sourceId);
  const suffix = await sha256Hex(
    canonicalJson([scope.organisationId, scope.userId, command.operationId]),
  );
  const destination = parseConversationId(
    `conv_${suffix.slice(0, 8)}-${suffix.slice(8, 12)}-${suffix.slice(12, 16)}-${suffix.slice(16, 20)}-${suffix.slice(20, 32)}`,
  );
  if (!destination.ok) throw new Error("chat_fork_id_invalid");
  const destinationId = destination.value;
  const identities = await deriveDirectCaseIdentities(
    initialConversationCaseIdentity(scope, destinationId),
  );
  if (!identities.ok) throw new Error(identities.error.code);
  await db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
    INSERT OR IGNORE INTO portal_chat_fork (organisation_id, user_id, operation_id, source_conversation_id, source_message_id, destination_conversation_id, destination_case_id, status)
    SELECT organisation_id, ?, ?, conversation_id, ?, ?, ?, 'preparing'
    FROM visible_conversation WHERE conversation_id = ? AND ${ACTIVE_FORK_PLACEMENT}`,
    )
    .bind(
      scope.organisationId,
      scope.userId,
      scope.userId,
      command.operationId,
      command.messageId,
      destinationId,
      identities.value.caseId,
      sourceId,
      placement.organisationId,
      placement.placement.placementEpoch,
      placement.placement.placementCellId,
      placement.fenceToken,
    )
    .run();
  if (!(await placement.isActive()))
    return { kind: "rejected", code: "chat_fork_conflict" };
  const row = await readForkOperation(db, scope, command.operationId);
  if (row === null) return { kind: "rejected", code: "chat_not_found" };
  if (
    row.source_conversation_id !== sourceId ||
    row.source_message_id !== command.messageId
  )
    return { kind: "rejected", code: "idempotency_key_conflict" };
  if (row.status === "erased")
    return { kind: "rejected", code: "chat_fork_history_erased" };
  if (row.status === "failed")
    return {
      kind: "failed",
      conversationId: destinationId,
      operationId: command.operationId,
      code: row.failure_code,
    };
  try {
    if (row.status === "preparing") {
      const source = await readConversation(db, scope, sourceId);
      if (source === null) throw new Error("chat_not_found");
      const cutoff = source.conversation.timeline.find(
        isSelectedResponse.bind(null, command.messageId),
      );
      const selected = source.conversation.historyBindings.find(
        isSelectedBinding.bind(null, command.messageId),
      );
      if (
        cutoff === undefined ||
        selected === undefined ||
        !source.conversation.completedRequests.includes(selected.requestId)
      )
        throw new Error("chat_fork_boundary_unavailable");
      const bindings = source.conversation.historyBindings.filter(
        bindingBeforeCutoff.bind(null, cutoff.sequence),
      );
      const timeline = source.conversation.timeline.filter(
        eventBeforeCutoff.bind(null, cutoff.sequence),
      );
      for (const event of timeline)
        if (
          event.kind === "user" &&
          !bindings.some(bindingHasRequest.bind(null, event.requestId))
        )
          throw new Error("chat_fork_history_unavailable");
      const sourceIdentities = await deriveDirectCaseIdentities(
        await conversationCaseIdentity(db, scope, sourceId),
      );
      if (!sourceIdentities.ok) throw new Error(sourceIdentities.error.code);
      const inherited = await readChatForkHistoryForCase(
        env,
        placement,
        sourceIdentities.value.caseId,
      );
      const history = await materializeForkHistory(
        env,
        scope,
        bindings,
        inherited,
      );
      await authorizeForkHistoryAccess(placement, history, authority);
      await verifyForkAttachments(env, scope.organisationId, history);
      const digest = await chatForkHistoryDigest(history);
      const conversation: Conversation = normalizeConversationTimeline({
        id: destinationId,
        title: `Fork of ${source.conversation.title}`.slice(0, 160),
        lineage: {
          kind: "fork",
          sourceConversationId: sourceId,
          sourceMessageId: command.messageId,
          operationId: command.operationId,
          throughSequence: cutoff.sequence,
          digest,
        },
        historyBindings: bindings,
        modelRoute: selected.modelRoute,
        documents: [],
        work: { kind: "ready" },
        completedRequests: [...new Set(bindings.map(bindingRequestId))],
        timeline,
        pendingInputs: [],
        latestSequence: cutoff.sequence,
        lastReadSequence: cutoff.sequence,
        surfaceEventCursor: 0,
        draftText: "",
        draftUpdatedAt: null,
        effort: source.conversation.effort,
      });
      const historyJson = canonicalJson(history);
      const conversationJson = JSON.stringify(conversation);
      if (
        new TextEncoder().encode(historyJson + conversationJson).byteLength >
        FORK_HISTORY_BYTES
      )
        throw new Error("chat_fork_history_capacity");
      await db
        .prepare(
          `${VISIBLE_CONVERSATIONS_SQL}
        UPDATE portal_chat_fork SET status = 'prepared', history_json = ?, conversation_json = ?, digest = ?
        WHERE organisation_id = ? AND user_id = ? AND operation_id = ? AND status = 'preparing'
          AND EXISTS (SELECT 1 FROM visible_conversation WHERE conversation_id = ?)
          AND ${ACTIVE_FORK_PLACEMENT}`,
        )
        .bind(
          scope.organisationId,
          scope.userId,
          historyJson,
          conversationJson,
          digest,
          scope.organisationId,
          scope.userId,
          command.operationId,
          sourceId,
          placement.organisationId,
          placement.placement.placementEpoch,
          placement.placement.placementCellId,
          placement.fenceToken,
        )
        .run();
    }
    if (!(await placement.isActive()))
      return { kind: "rejected", code: "chat_fork_conflict" };
    const prepared = await readForkOperation(db, scope, command.operationId);
    if (prepared?.status !== "prepared" && prepared?.status !== "ready")
      return { kind: "rejected", code: "chat_fork_conflict" };
    const history = await verifiedForkHistory(prepared);
    await authorizeForkHistoryAccess(placement, history, authority);
    await verifyForkAttachments(env, scope.organisationId, history);
    if (prepared.status === "prepared") {
      const conversation = parseConversation(
        JSON.parse(prepared.conversation_json),
      );
      const stored = await readConversation(db, scope, destinationId);
      if (stored === null) {
        const saved = await saveConversation(
          placement,
          scope.userId,
          conversation,
          0,
        );
        if (saved.kind === "capacity")
          throw new Error("chat_fork_history_capacity");
        if (
          saved.kind === "conflict" &&
          (await readConversation(db, scope, destinationId)) === null
        )
          throw new Error("chat_fork_publish_failed");
      }
      await db
        .prepare(
          `${VISIBLE_CONVERSATIONS_SQL}
        UPDATE portal_chat_fork SET status = 'ready', conversation_json = NULL
        WHERE organisation_id = ? AND user_id = ? AND operation_id = ? AND status = 'prepared'
          AND EXISTS (SELECT 1 FROM visible_conversation WHERE conversation_id = source_conversation_id)
          AND EXISTS (SELECT 1 FROM portal_conversation c
            WHERE c.organisation_id = portal_chat_fork.organisation_id AND c.user_id = portal_chat_fork.user_id
              AND c.conversation_id = destination_conversation_id
              AND json_extract(c.state_json, '$.lineage.kind') = 'fork'
              AND json_extract(c.state_json, '$.lineage.operationId') = operation_id
              AND json_extract(c.state_json, '$.lineage.digest') = digest
              AND NOT EXISTS (SELECT 1 FROM portal_chat_deletion d
                WHERE d.organisation_id = c.organisation_id AND d.conversation_id = c.conversation_id))
          AND ${ACTIVE_FORK_PLACEMENT}`,
        )
        .bind(
          scope.organisationId,
          scope.userId,
          scope.organisationId,
          scope.userId,
          command.operationId,
          placement.organisationId,
          placement.placement.placementEpoch,
          placement.placement.placementCellId,
          placement.fenceToken,
        )
        .run();
    }
    if (!(await placement.isActive()))
      return { kind: "rejected", code: "chat_fork_conflict" };
    const settled = await readForkOperation(db, scope, command.operationId);
    if (settled?.status !== "ready")
      return { kind: "rejected", code: "chat_fork_conflict" };
    return {
      kind: "ready",
      conversationId: destinationId,
      operationId: command.operationId,
      digest: settled.digest,
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : "chat_fork_failed";
    // A transport/storage interruption preserves the receipt for the same retry.
    if (!code.startsWith("chat_") && !code.startsWith("attachment_"))
      throw error;
    await db
      .prepare(
        `UPDATE portal_chat_fork SET status = 'failed', failure_code = ?
      WHERE organisation_id = ? AND user_id = ? AND operation_id = ? AND status = 'preparing'
        AND ${ACTIVE_FORK_PLACEMENT}`,
      )
      .bind(
        code,
        scope.organisationId,
        scope.userId,
        command.operationId,
        placement.organisationId,
        placement.placement.placementEpoch,
        placement.placement.placementCellId,
        placement.fenceToken,
      )
      .run();
    if (!(await placement.isActive()))
      return { kind: "rejected", code: "chat_fork_conflict" };
    return {
      kind: "failed",
      conversationId: destinationId,
      operationId: command.operationId,
      code,
    };
  }
}

export async function materializeForkHistory(
  env: Env,
  scope: ConversationScope,
  bindings: readonly ChatHistoryBinding[],
  inherited: ChatForkHistory,
): Promise<ChatForkHistory> {
  // Each finished turn is read together, and the turns of one Session share
  // one Actor resolution, so a long chat waits for one Actor wake.
  const actors = new Map<
    string,
    Promise<Result<SessionActorStub, ActorResolutionError>>
  >();
  const turns = await Promise.all(
    bindings.map(
      materializeBoundTurn.bind(null, env, scope, inherited, actors),
    ),
  );
  const entries = turns.flatMap(turnEntries);
  const flowBindings = turns.flatMap(turnFlowBindings);
  assertCompletedHistory(entries);
  return { entries, bindings: flowBindings };
}

async function materializeBoundTurn(
  env: Env,
  scope: ConversationScope,
  inherited: ChatForkHistory,
  actors: Map<string, Promise<Result<SessionActorStub, ActorResolutionError>>>,
  binding: ChatHistoryBinding,
): Promise<ChatForkHistory> {
  const previous = inherited.entries.filter(
    entryHasTurn.bind(null, binding.turnId),
  );
  const previousFlow = inherited.bindings.find(
    flowHasTurn.bind(null, binding.turnId),
  );
  if (previous.length > 0 && previousFlow !== undefined)
    return { entries: previous, bindings: [previousFlow] };
  const sessionId = parseSessionId(binding.sessionId);
  if (!sessionId.ok) throw new Error("chat_fork_history_invalid");
  const resolving =
    actors.get(sessionId.value) ??
    resolveActiveSessionActor({
      env: env,
      namespace: env.SESSION,
      organisationId: scope.organisationId,
      sessionId: sessionId.value,
      now: Date.now(),
    });
  actors.set(sessionId.value, resolving);
  const actor = await resolving;
  if (!actor.ok) throw new Error("chat_fork_history_unavailable");
  const accepted = await parseChatHistorySnapshot(
    await actor.value.readCompletedChatHistory({
      organisationId: scope.organisationId,
      sessionId: sessionId.value,
      turnId: binding.turnId,
      throughSequence: binding.cursor.lastSequence,
    }),
  );
  if (accepted.cursor?.lastEntryDigest !== binding.cursor.lastEntryDigest)
    throw new Error("chat_fork_history_digest_mismatch");
  return { entries: accepted.entries, bindings: accepted.bindings };
}

function turnEntries(turn: ChatForkHistory): ChatForkHistory["entries"] {
  return turn.entries;
}

function turnFlowBindings(turn: ChatForkHistory): ChatForkHistory["bindings"] {
  return turn.bindings;
}

export async function readChatForkHistoryForCase(
  env: Env,
  placement: OrganisationExecutionScope,
  caseId: string,
): Promise<ChatForkHistory> {
  const organisationId = placement.organisationId;
  const raw = await placement.database
    .prepare(
      "SELECT * FROM portal_chat_fork WHERE organisation_id = ? AND destination_case_id = ?",
    )
    .bind(organisationId, caseId)
    .first();
  const row = parseForkRow(raw);
  if (row === null) return { entries: [], bindings: [] };
  if (
    (row.status !== "ready" && row.status !== "prepared") ||
    row.history_json === null
  )
    throw new Error("chat_fork_history_unavailable");
  const history = await verifiedForkHistory(row);
  await verifyForkAttachments(env, organisationId, history);
  return history;
}

export async function admitChatForkInformationFlow(
  db: OrganisationDatabase,
  accountAccess: OrganisationAccess,
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  history: ChatForkHistory,
  authorizeCommit: () => void | Promise<void>,
): Promise<void> {
  for (const serialized of history.bindings) {
    if (lease.requestAuthority.kind !== "control")
      throw new Error("chat_fork_history_forbidden");
    const binding = await FlowBinding.restore(serialized);
    if (
      !binding.ok ||
      binding.value.organisationId !== lease.session.organisationId
    )
      throw new Error("chat_fork_flow_invalid");
    const decision = await decideChatFlowDelivery(
      db,
      accountAccess,
      binding.value,
      lease.requestAuthority,
    );
    if (decision.kind !== "allow")
      throw new Error("chat_fork_history_forbidden");
    const observedAt = Date.now();
    const evidence = await ObservationEvidence.create({
      source: {
        kind: "organisation_record",
        organisationId: binding.value.organisationId,
        recordId: `chat_fork:${binding.value.sessionId}:${binding.value.turnId}`,
      },
      sourceRevision: Math.max(1, binding.value.contextRevision),
      contentDigest: await chatForkHistoryDigest(history),
      inputLabel: binding.value.flowLabel,
      observedAt,
    });
    if (!evidence.ok) throw new Error("chat_fork_flow_invalid");
    const admitted = await admitSessionInformationFlowObservation({
      authorizeCommit,
      sql: storage.sql,
      transactionSync: storage.transactionSync.bind(storage),
      organisationId: binding.value.organisationId,
      sessionId: lease.session.sessionId,
      turnId: lease.turn.turnId,
      authorityPartitionDigest: lease.authorityPartitionDigest,
      inputLabel: binding.value.flowLabel,
      observation: evidence.value,
      observedAt,
    });
    if (!admitted.ok) throw new Error("chat_fork_flow_invalid");
  }
}

export async function verifyForkAttachments(
  env: Env,
  organisationId: OrganisationId,
  history: ChatForkHistory,
): Promise<void> {
  const checked = new Map<
    string,
    { readonly size: number; readonly sha256: string }
  >();
  for (const attachment of chatForkAttachments(history)) {
    if (!attachment.objectKey.startsWith(`attachments/${organisationId}/`))
      throw new Error("chat_fork_attachment_forbidden");
    let content = checked.get(attachment.objectKey);
    if (content === undefined) {
      const object = await env.ARCHIVE.get(attachment.objectKey);
      if (object === null) throw new Error("chat_fork_attachment_unavailable");
      content = {
        size: object.size,
        sha256: await sha256Hex(new Uint8Array(await object.arrayBuffer())),
      };
      checked.set(attachment.objectKey, content);
    }
    if (
      content.size !== attachment.byteLength ||
      content.sha256 !== attachment.sha256
    )
      throw new Error("chat_fork_attachment_unavailable");
  }
}

async function verifiedForkHistory(row: ForkRow): Promise<ChatForkHistory> {
  if (row.history_json === null || row.digest === null)
    throw new Error("chat_fork_history_unavailable");
  const history = await parseChatForkHistory(JSON.parse(row.history_json));
  if ((await chatForkHistoryDigest(history)) !== row.digest)
    throw new Error("chat_fork_history_digest_mismatch");
  return history;
}

async function readForkOperation(
  db: OrganisationDatabase,
  scope: ConversationScope,
  operationId: string,
): Promise<ForkRow | null> {
  const raw = await db
    .prepare(
      "SELECT * FROM portal_chat_fork WHERE organisation_id = ? AND user_id = ? AND operation_id = ?",
    )
    .bind(scope.organisationId, scope.userId, operationId)
    .first();
  return parseForkRow(raw);
}

const ACTIVE_FORK_PLACEMENT = `EXISTS (SELECT 1 FROM organisation_placement
  WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
    AND fence_token = ? AND status = 'active')`;

function isSelectedResponse(
  id: string,
  event: Conversation["timeline"][number],
): boolean {
  return event.kind === "assistant" && event.eventId === id;
}
function isSelectedBinding(id: string, binding: ChatHistoryBinding): boolean {
  return binding.responseId === id;
}
function bindingBeforeCutoff(
  sequence: number,
  binding: ChatHistoryBinding,
): boolean {
  return binding.throughSequence <= sequence;
}
function eventBeforeCutoff(
  sequence: number,
  event: Conversation["timeline"][number],
): boolean {
  return event.sequence <= sequence;
}
function bindingHasRequest(
  requestId: string,
  binding: ChatHistoryBinding,
): boolean {
  return binding.requestId === requestId;
}
function bindingRequestId(binding: ChatHistoryBinding): string {
  return binding.requestId;
}
function entryHasTurn(
  turnId: string,
  entry: ChatForkHistory["entries"][number],
): boolean {
  return entry.turn.turnId === turnId;
}
function flowHasTurn(
  turnId: string,
  binding: ChatForkHistory["bindings"][number],
): boolean {
  return binding.turnId === turnId;
}

export async function listDerivedChats(
  env: Env,
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  sourceId: ConversationId,
  authority: Variant<RequestAuthority, "control">,
): Promise<readonly import("@purin-labs/control-api").ChatDerivedThread[]> {
  const rows = await placement.database
    .prepare(
      `SELECT c.conversation_id AS id, json_extract(c.state_json, '$.title') AS title, f.source_message_id AS sourceMessageId FROM portal_chat_fork f JOIN portal_conversation c ON c.organisation_id = f.organisation_id AND c.user_id = f.user_id AND c.conversation_id = f.destination_conversation_id WHERE f.organisation_id = ? AND f.user_id = ? AND f.source_conversation_id = ? AND f.status = 'ready' AND NOT EXISTS (SELECT 1 FROM portal_chat_deletion d WHERE d.organisation_id = c.organisation_id AND d.conversation_id = c.conversation_id) ORDER BY c.updated_at DESC LIMIT 50`,
    )
    .bind(scope.organisationId, scope.userId, sourceId)
    .all<{ id: string; title: string; sourceMessageId: string }>();
  const visible: import("@purin-labs/control-api").ChatDerivedThread[] = [];
  for (const row of rows.results) {
    if (!isConversationId(row.id)) throw new Error("chat_fork_storage_invalid");
    const stored = await readConversation(placement.database, scope, row.id);
    if (stored === null) continue;
    try {
      await authorizeChatForkRead(
        env,
        placement,
        scope,
        stored.conversation,
        authority,
      );
      visible.push({
        id: row.id,
        title: row.title,
        sourceMessageId: row.sourceMessageId,
      });
    } catch {
      // A derived title is disclosed only while its inherited history is readable.
    }
  }
  return visible;
}

export async function authorizeForkHistoryAccess(
  placement: OrganisationExecutionScope,
  history: ChatForkHistory,
  authority: Variant<RequestAuthority, "control">,
  destination: import("./disclosure-evidence").DisclosureDestination = {
    kind: "current",
  },
  /**
   * `own_private_chat`: the history is the person's own private chat, with
   * no inherited history, and its turns read only its own Case, so the
   * person reads it with no grant of the Case context read (Plan 90 D9).
   * Each binding still meets the flow check.
   */
  caseRead: "grant" | "own_private_chat" = "grant",
): Promise<readonly string[]> {
  const organisationId = placement.organisationId;
  const policy = await readCurrentOrganisationPolicySnapshot(
    placement.database,
    organisationId,
  );
  if (!policy.ok)
    throw new ForkHistoryAccessError(
      "evidence_unavailable",
      "chat_fork_history_unavailable",
    );
  const compiled = await compileTurnAuthority({
    db: placement.database,
    accountAccess: placement.accountAccess,
    userAuthority: {
      kind: "disclosure_recipient",
      disclosureEvidenceId: await chatForkHistoryDigest(history),
    },
    action: "disclose",
    organisationId,
    requestAuthority: authority,
    policy: policy.value,
  });
  if (
    !compiled.ok ||
    (caseRead === "grant" &&
      !compiled.value.effectiveGrantSet.capabilities.some(isCaseReadCapability))
  )
    throw new ForkHistoryAccessError(
      "source_policy_denied",
      "chat_fork_history_forbidden",
    );
  const decisionDigests: string[] = [];
  for (const serialized of history.bindings) {
    const binding = await FlowBinding.restore(serialized);
    if (!binding.ok)
      throw new ForkHistoryAccessError(
        "evidence_unavailable",
        "chat_fork_flow_invalid",
      );
    const decision = await decideChatFlowDelivery(
      placement.database,
      placement.accountAccess,
      binding.value,
      authority,
      destination,
    );
    if (decision.kind === "unavailable")
      throw new ForkHistoryAccessError(
        "evidence_unavailable",
        "chat_fork_history_unavailable",
      );
    if (decision.kind !== "allow")
      throw new ForkHistoryAccessError(
        "source_policy_denied",
        "chat_fork_history_forbidden",
      );
    decisionDigests.push(decision.decisionDigest);
  }
  return decisionDigests;
}
function isCaseReadCapability(
  capability: import("@purin-labs/authority/authorization/access-grants/compiler").EffectiveCapability,
): boolean {
  return (
    capability.definition.kind === "platform_capability" &&
    capability.definition.capabilityId === CONTEXT_CASE_READ_CAPABILITY
  );
}
export async function authorizeChatForkRead(
  env: Env,
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  conversation: Conversation,
  authority: Variant<RequestAuthority, "control">,
): Promise<void> {
  if (conversation.lineage.kind === "original") return;
  // `authorizeSideCaseChatRead` checks a side Case; this check would pass it.
  if (conversation.lineage.kind === "side_case")
    throw new Error("chat_lineage_unsupported");
  const identity = await deriveDirectCaseIdentities(
    await conversationCaseIdentity(placement.database, scope, conversation.id),
  );
  if (!identity.ok) throw new Error("chat_fork_history_unavailable");
  const history = await readChatForkHistoryForCase(
    env,
    placement,
    identity.value.caseId,
  );
  await authorizeForkHistoryAccess(placement, history, authority);
}
