import type {
  ConnectorDelivery,
  ConnectorDeliveryReceipt,
  ConnectorIdentity,
} from "@purin-labs/contracts";

import { resolveActiveSlackThreadCredential } from "../credential-vault";
import type { Env } from "../env";
import {
  parseChannelId,
  parseConnectorId,
  parseRequestId,
  parseSessionId,
  parseOrganisationId,
  parseWorkspaceId,
  type ChannelId,
} from "../ids";
import { traceLog } from "../observability";
import { parseOrganisationPlacement } from "../placement";
import { screenTextForSurface } from "../redaction";
import {
  initialIncrementalScreenState,
  screenIncrementalOutput,
  type IncrementalScreenState,
} from "../incremental-output-screen";
import {
  SLACK_STREAM_TEXT_LIMIT,
  appendSlackStream,
  startSlackStream,
  stopSlackStream,
  type SlackStreamError,
} from "../slack/stream";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  actorExecutionAdmissionOpen,
  isActorExecutionActive,
} from "./actor-execution-quiescence";
import type { Result } from "../result";
import type { EmbeddedHarnessTurnError } from "./embedded-harness";
import {
  postSlackThreadMessage,
  slackClientMessageId,
  type SlackMessageError,
} from "../slack/messages";
import { CARD_ONLY_REPLY } from "../slack/card-only-reply";
import { resolveConfiguredSlackInstallationIdentity } from "../slack/installation-identity";
import { heldNoticeOfDecision } from "../slack/held-output-notice";
import { permissionDecisionRequestId } from "../slack/permission-request-notice";
import { applyAgentMessageAssemblyEvent } from "./agent-message-assembly";
import type { SessionActor } from "./session/session-actor";
import {
  parseSessionTurnStreamRecord,
  type SessionTurnStreamRecord,
} from "./agent-session-turn-stream";
import { isRegisteredActorName } from "./actor-registry";
import type {
  ConnectorCaseStreamRelease,
  ConnectorCaseTurnStreamError,
  ConnectorCaseTurnStreamInput,
  ConnectorCaseTurnStreamResult,
} from "./case-turn-stream";
import type { StrictUnion, Variant, VariantBy } from "@purin-labs/type-utils";
import {
  assertNever,
  isNonBlankString,
  isNonNegativeInteger,
  isRecord,
  parseJsonOrNull,
} from "@purin-labs/std";

type ConnectorCaseTurnStreamSession = Pick<
  SessionActor,
  "replayStream" | "readSessionTurnFlowBinding"
>;

/**
 * The part of the answer that reached the thread. A turn's flow binding only
 * grows, so text written before a binding version carries at most that
 * version. Each release checks the binding that the Session holds at release
 * time, which covers all text written before it.
 */
type LiveStream = StrictUnion<
  | {
      readonly kind: "open";
      readonly slackTs: string | null;
      readonly releasedChars: number;
      /** The end of a start or append that was sent and has no known result. */
      readonly appendingTo: number | null;
      /** When text was last released, or 0 before the first safe text. */
      readonly releasedAt: number;
      /** No start or append goes out before this time (a Slack retry time). */
      readonly notBefore: number;
    }
  | {
      readonly kind: "closed";
      readonly slackTs: string | null;
      readonly releasedChars: number;
      readonly reason: LiveCloseReason;
    }
>;

type LiveCloseReason =
  | "unsupported"
  | "held"
  | "withheld"
  | "uncertain"
  | "stopped"
  // Slack ended the message: the person stopped it, or Slack did.
  | "ended";

type StreamProgress = {
  /** All text of the turn. The Session's completed answer must match it. */
  readonly canonicalText: string;
  readonly currentMessageText: string;
  /** The answer for the thread: the turn's text without its working notes. */
  readonly answerText: string;
  /** The current model response's text that may still be a working note. */
  readonly heldResponse: string;
  /** This model response is long enough to count as the answer. */
  readonly responseReleased: boolean;
  readonly lastSequence: number;
  readonly screen: IncrementalScreenState;
  /** The prefix of the answer that passed the incremental text screen. */
  readonly safeText: string;
  readonly live: LiveStream;
  /** The binding version that the last release check allowed. */
  readonly checked: { readonly digest: string; readonly at: number } | null;
};

type ConnectorSlackStreamState =
  | { readonly kind: "buffering"; readonly progress: StreamProgress }
  | {
      readonly kind: "prepared";
      readonly finalMessage: string;
      readonly progress: StreamProgress;
    }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly progress: StreamProgress;
    }
  | {
      readonly kind: "completed";
      readonly slackTs: string;
      readonly finalMessage: string;
      readonly canonicalMessage: string;
      readonly completedAt: number;
    }
  /** Part of the answer reached the thread before its binding was denied. */
  | {
      readonly kind: "withheld";
      readonly slackTs: string;
      readonly finalMessage: string;
      readonly progress: StreamProgress;
    };

type ConnectorSlackStreamRow = Record<string, SqlStorageValue> & {
  readonly stream_id: string;
  readonly idempotency_key: string;
  readonly input_json: string;
  readonly state_json: string;
};

type ReplayStreamState = Variant<ConnectorSlackStreamState, "buffering">;

type PreparedDelivery = StrictUnion<
  | { readonly kind: "ready" }
  | { readonly kind: "delivered"; readonly receipt: ConnectorDeliveryReceipt }
  | {
      readonly kind: "retry";
      readonly reason: string;
      readonly retryAt: number;
    }
  | { readonly kind: "rejected"; readonly reason: string }
>;

const OUTPUT_HELD_TEXT = "Message held by the Seams Pantry output guardrail.";
const STREAM_FAILED_TEXT =
  "Sous Chef couldn’t complete this request. Please try again.";
const STREAM_INTERRUPTED_TEXT =
  "Sous Chef lost its connection to the running task, so this request did not finish. Some actions may have completed: check the results before you ask again.";
const STREAM_REPLAY_ATTEMPTS = 20;
const STREAM_REPLAY_RETRY_MS = 25;
/** Text is released at most about once a second, or sooner in a large part. */
const RELEASE_INTERVAL_MS = 1_000;
const RELEASE_CHARS = 400;
/**
 * The first part leaves at about one sentence, so the thread shows the answer
 * early. A shorter answer that ends within the interval is one post.
 */
const FIRST_RELEASE_CHARS = 80;
/**
 * A model response stays out of the thread until it has this many characters
 * or the turn ends. A short response that a tool call follows is a working
 * note, such as "Now propose directly", and an appended text cannot be taken
 * back. The hold moves the first text of a long answer a little later.
 */
const ANSWER_HOLD_CHARS = 200;
/** An allowed binding version is checked again with live authority after this. */
const RELEASE_RECHECK_MS = 10_000;
/** The end of a turn waits at most this long for a Slack retry time. */
const FINAL_RETRY_WAIT_MS = 5_000;
const CLOSE_NOTICES: Readonly<Record<LiveCloseReason, string | null>> = {
  unsupported: null,
  stopped: null,
  ended: null,
  held: "\n\n_Satyr held the rest of this answer._",
  withheld: "\n\n_Satyr cannot share the rest of this answer in this channel._",
  // The final delivery decides whether the full answer follows.
  uncertain: "\n\n_Satyr could not finish this answer here._",
};

/** What one call of the stream needs to release text into the thread. */
type StreamRun = {
  readonly sql: SqlStorage;
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
  readonly input: ConnectorCaseTurnStreamInput;
  readonly session: ConnectorCaseTurnStreamSession;
  readonly release: ConnectorCaseStreamRelease;
  /** The read of the Slack token. Every part of the stream shares it. */
  token: Promise<Result<string, ConnectorCaseTurnStreamError>> | null;
};

/** What stopping an open Slack message needs. */
type StreamOutlet = Pick<
  StreamRun,
  "sql" | "env" | "scope" | "input" | "token"
>;

export function createConnectorSlackStreamSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_slack_stream (
    stream_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    input_json TEXT NOT NULL CHECK (json_valid(input_json)),
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    updated_at INTEGER NOT NULL
  )`);
}

export function parseConnectorCaseTurnStreamInput(
  value: unknown,
): ConnectorCaseTurnStreamInput | null {
  if (
    !isRecord(value) ||
    !isRecord(value.identity) ||
    !isRecord(value.target) ||
    !isRecord(value.sessionRoute) ||
    !isNonBlankString(value.identity.organisationId) ||
    !isNonBlankString(value.identity.connectorId) ||
    !isNonBlankString(value.requestId) ||
    !isNonBlankString(value.organisationId) ||
    !isNonBlankString(value.sessionId) ||
    !isNonBlankString(value.sessionRoute.physicalObjectName) ||
    !isNonBlankString(value.turnId) ||
    !isNonBlankString(value.streamId) ||
    !isNonBlankString(value.expectedIdempotencyKey) ||
    !isNonBlankString(value.target.workspaceId) ||
    !isNonBlankString(value.target.channelId) ||
    !isNonBlankString(value.target.threadTs) ||
    !isNonBlankString(value.target.recipientUserId) ||
    !isNonNegativeInteger(value.receivedAt)
  )
    return null;
  const requestId = parseRequestId(value.requestId);
  const organisationId = parseOrganisationId(value.organisationId);
  const identityOrganisationId = parseOrganisationId(
    value.identity.organisationId,
  );
  const connectorId = parseConnectorId(value.identity.connectorId);
  const sessionId = parseSessionId(value.sessionId);
  const sessionPlacement = parseOrganisationPlacement(
    value.sessionRoute.placement,
    "sessionRoute.placement",
  );
  const workspaceId = parseWorkspaceId(value.target.workspaceId);
  const channelId = parseChannelId(value.target.channelId);
  if (
    !requestId.ok ||
    !organisationId.ok ||
    !identityOrganisationId.ok ||
    !connectorId.ok ||
    !sessionId.ok ||
    !sessionPlacement.ok ||
    !workspaceId.ok ||
    !channelId.ok ||
    organisationId.value !== identityOrganisationId.value
  )
    return null;
  // A Session has its derived name, or the warm slot it started in.
  if (
    !isRegisteredActorName(
      value.sessionRoute.physicalObjectName,
      {
        objectKind: "session",
        organisationId: organisationId.value,
        logicalObjectId: sessionId.value,
      },
      sessionPlacement.value,
    )
  )
    return null;
  return {
    identity: {
      organisationId: identityOrganisationId.value,
      connectorId: connectorId.value,
    },
    requestId: requestId.value,
    organisationId: organisationId.value,
    sessionId: sessionId.value,
    sessionRoute: {
      physicalObjectName: value.sessionRoute.physicalObjectName,
      placement: sessionPlacement.value,
    },
    turnId: value.turnId,
    streamId: value.streamId,
    expectedIdempotencyKey: value.expectedIdempotencyKey,
    target: {
      workspaceId: workspaceId.value,
      channelId: channelId.value,
      threadTs: value.target.threadTs,
      recipientUserId: value.target.recipientUserId,
    },
    receivedAt: value.receivedAt,
  };
}

/**
 * Follow one Case turn's output from its Session. The answer streams into the
 * thread while each part passes the text screen and the turn's current
 * binding. The caller must have read the placement fence of `scope` as its
 * last wait.
 */
export async function streamConnectorCaseTurn(input: {
  readonly storage: DurableObjectStorage;
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
  readonly session: ConnectorCaseTurnStreamSession;
  readonly stream: ConnectorCaseTurnStreamInput;
  readonly release: ConnectorCaseStreamRelease;
}): Promise<
  Result<ConnectorCaseTurnStreamResult, ConnectorCaseTurnStreamError>
> {
  // The caller admitted the scope: it read the placement fence as its last
  // wait. The stream row is written, and the Session's stream is opened,
  // without a further wait.
  if (!actorExecutionAdmissionOpen(input.storage.sql))
    return failure("connector_placement_conflict");
  const placement = input.stream.sessionRoute.placement;
  if (
    input.stream.organisationId !== input.scope.organisationId ||
    placement.kind !== input.scope.placement.kind ||
    placement.placementEpoch !== input.scope.placement.placementEpoch ||
    placement.placementCellId !== input.scope.placement.placementCellId ||
    placement.locationHint !== input.scope.placement.locationHint ||
    placement.residencyJurisdiction !==
      input.scope.placement.residencyJurisdiction
  )
    return failure("connector_placement_conflict");
  const initialized = ensureStream(input.storage.sql, input.stream);
  if (!initialized.ok) return initialized;
  switch (initialized.value.kind) {
    case "completed":
      return completedResult(initialized.value);
    case "prepared":
    case "withheld":
      return preparedResult(initialized.value);
    case "failed":
      return restoredSessionFailure(initialized.value.reason);
    case "buffering":
      break;
    default:
      return assertNever(initialized.value);
  }
  const run: StreamRun = {
    sql: input.storage.sql,
    env: input.env,
    scope: input.scope,
    input: input.stream,
    session: input.session,
    release: input.release,
    token: null,
  };
  // A start or append whose result was lost may have reached the thread.
  // The stream never sends that text again.
  let state: ReplayStreamState = initialized.value;
  if (
    state.progress.live.kind === "open" &&
    state.progress.live.appendingTo !== null
  ) {
    const closed = await closeLive(run, state.progress, "uncertain");
    if (!closed.ok) return closed;
    state = { kind: "buffering", progress: closed.value };
  }
  const response = await openReplayStream(
    input.storage.sql,
    input.scope,
    input.session,
    input.stream,
    state.progress.lastSequence,
  );
  if (!response.ok) return response;
  // The model works for a while before the first text. The Slack token is
  // read meanwhile. The first part still checks the binding and the live
  // authority when it leaves.
  void streamToken(run).catch(ignoreReadAhead);
  return consumeReplayResponse({
    run,
    initialState: state,
    response: response.value,
  });
}

/**
 * Whether the delivery's prepared stream allows the post. The placement fence
 * is read first, and only this Connector's storage after it, so a caller that
 * posts at once has waited for nothing since the fence read.
 */
export async function checkPreparedConnectorDelivery(input: {
  readonly sql: SqlStorage;
  readonly scope: OrganisationExecutionScope;
  readonly identity: ConnectorIdentity;
  readonly delivery: ConnectorDelivery;
  readonly requestedAt: number;
}): Promise<PreparedDelivery> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return {
      kind: "retry",
      reason: "connector_placement_conflict",
      retryAt: input.requestedAt + 5_000,
    };
  const row = input.sql
    .exec<ConnectorSlackStreamRow>(
      "SELECT stream_id, idempotency_key, input_json, state_json FROM connector_slack_stream WHERE idempotency_key = ?",
      input.delivery.idempotencyKey,
    )
    .toArray()[0];
  if (row === undefined) return { kind: "ready" };
  const stream = parseConnectorCaseTurnStreamInput(
    parseJsonOrNull(row.input_json),
  );
  const state = parseConnectorSlackStreamState(row.state_json);
  if (
    stream === null ||
    state === null ||
    stream.identity.organisationId !== input.identity.organisationId ||
    stream.identity.connectorId !== input.identity.connectorId ||
    input.delivery.content.kind !== "text"
  )
    return { kind: "rejected", reason: "connector_stream_corrupt" };
  switch (state.kind) {
    case "failed":
      return { kind: "rejected", reason: state.reason };
    case "withheld":
      // Part of the answer is in the thread; the rest may not go there.
      return { kind: "rejected", reason: "connector_stream_withheld" };
    case "buffering":
      return {
        kind: "retry",
        reason: "connector_stream_not_prepared",
        retryAt: input.requestedAt + 100,
      };
    case "prepared":
    case "completed":
      if (state.finalMessage !== input.delivery.content.text)
        return {
          kind: "rejected",
          reason: "connector_stream_content_mismatch",
        };
      return state.kind === "prepared"
        ? { kind: "ready" }
        : {
            kind: "delivered",
            receipt: deliveryReceipt(
              input.identity,
              input.delivery,
              state.slackTs,
              state.completedAt,
            ),
          };
    default:
      return assertNever(state);
  }
}

export function completeConnectorSlackDelivery(
  sql: SqlStorage,
  delivery: ConnectorDelivery,
  receipt: ConnectorDeliveryReceipt,
): void {
  const row = sql
    .exec<ConnectorSlackStreamRow>(
      "SELECT stream_id, idempotency_key, input_json, state_json FROM connector_slack_stream WHERE idempotency_key = ?",
      delivery.idempotencyKey,
    )
    .toArray()[0];
  if (row === undefined) return;
  const state = parseConnectorSlackStreamState(row.state_json);
  if (state === null) throw new Error("connector_stream_corrupt");
  if (state.kind === "completed") return;
  if (state.kind !== "prepared")
    throw new Error("connector_stream_not_prepared");
  persistStreamState(
    sql,
    row.stream_id,
    {
      kind: "completed",
      slackTs: receipt.nativeReceiptId,
      finalMessage: state.finalMessage,
      canonicalMessage: state.progress.canonicalText,
      completedAt: receipt.deliveredAt,
    },
    receipt.deliveredAt,
  );
}

/**
 * A person approved a held answer whose stream stopped part way. The delivery
 * posts the full answer in the thread, below the part that it shows.
 */
export function reopenWithheldConnectorSlackDelivery(
  sql: SqlStorage,
  delivery: ConnectorDelivery,
): void {
  const row = sql
    .exec<ConnectorSlackStreamRow>(
      "SELECT stream_id, idempotency_key, input_json, state_json FROM connector_slack_stream WHERE idempotency_key = ?",
      delivery.idempotencyKey,
    )
    .toArray()[0];
  if (row === undefined) return;
  const state = parseConnectorSlackStreamState(row.state_json);
  if (state?.kind !== "withheld") return;
  persistStreamState(
    sql,
    row.stream_id,
    {
      kind: "prepared",
      finalMessage: state.finalMessage,
      progress: state.progress,
    },
    Date.now(),
  );
}

function ensureStream(
  sql: SqlStorage,
  input: ConnectorCaseTurnStreamInput,
): Result<ConnectorSlackStreamState, ConnectorCaseTurnStreamError> {
  const row =
    sql
      .exec<ConnectorSlackStreamRow>(
        "SELECT stream_id, idempotency_key, input_json, state_json FROM connector_slack_stream WHERE stream_id = ? OR idempotency_key = ?",
        input.streamId,
        input.expectedIdempotencyKey,
      )
      .toArray()[0] ?? null;
  if (row !== null) {
    const state = parseConnectorSlackStreamState(row.state_json);
    const stored = parseConnectorCaseTurnStreamInput(
      parseJsonOrNull(row.input_json),
    );
    return stored !== null && sameStreamIntent(stored, input) && state !== null
      ? { ok: true, value: state }
      : failure("connector_stream_conflict");
  }
  const state: ConnectorSlackStreamState = {
    kind: "buffering",
    progress: initialProgress(),
  };
  sql.exec(
    "INSERT INTO connector_slack_stream (stream_id, idempotency_key, input_json, state_json, updated_at) VALUES (?, ?, ?, ?, ?)",
    input.streamId,
    input.expectedIdempotencyKey,
    JSON.stringify(input),
    JSON.stringify(state),
    input.receivedAt,
  );
  return { ok: true, value: state };
}

function sameStreamIntent(
  stored: ConnectorCaseTurnStreamInput,
  incoming: ConnectorCaseTurnStreamInput,
): boolean {
  return (
    stored.identity.organisationId === incoming.identity.organisationId &&
    stored.identity.connectorId === incoming.identity.connectorId &&
    stored.requestId === incoming.requestId &&
    stored.organisationId === incoming.organisationId &&
    stored.sessionId === incoming.sessionId &&
    stored.turnId === incoming.turnId &&
    stored.streamId === incoming.streamId &&
    stored.expectedIdempotencyKey === incoming.expectedIdempotencyKey &&
    stored.target.workspaceId === incoming.target.workspaceId &&
    stored.target.channelId === incoming.target.channelId &&
    stored.target.threadTs === incoming.target.threadTs &&
    stored.target.recipientUserId === incoming.target.recipientUserId &&
    stored.receivedAt === incoming.receivedAt
  );
}

/**
 * Whether the thread already tells why the turn's answer ended: the failure
 * text of a failed stream (stored only after its post), or the notice of a
 * withheld one.
 */
export function connectorSlackStreamPostedFailure(
  sql: SqlStorage,
  streamId: string,
): boolean {
  const row = sql
    .exec<Pick<ConnectorSlackStreamRow, "state_json">>(
      "SELECT state_json FROM connector_slack_stream WHERE stream_id = ?",
      streamId,
    )
    .toArray()[0];
  const kind =
    row === undefined
      ? null
      : parseConnectorSlackStreamState(row.state_json)?.kind;
  return kind === "failed" || kind === "withheld";
}

/**
 * Stops the turn's Slack message if it still streams, with the notice that
 * the answer is not complete. A caller that gives up on the turn uses it, so
 * no message keeps streaming in the thread.
 */
export async function stopOpenConnectorSlackStream(input: {
  readonly sql: SqlStorage;
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
  readonly streamId: string;
}): Promise<void> {
  const row = input.sql
    .exec<ConnectorSlackStreamRow>(
      "SELECT stream_id, idempotency_key, input_json, state_json FROM connector_slack_stream WHERE stream_id = ?",
      input.streamId,
    )
    .toArray()[0];
  if (row === undefined) return;
  const stream = parseConnectorCaseTurnStreamInput(
    parseJsonOrNull(row.input_json),
  );
  const state = parseConnectorSlackStreamState(row.state_json);
  if (stream === null || state?.kind !== "buffering") return;
  if (state.progress.live.kind !== "open") return;
  await closeLive(
    {
      sql: input.sql,
      env: input.env,
      scope: input.scope,
      input: stream,
      token: null,
    },
    state.progress,
    "uncertain",
  );
}

async function openReplayStream(
  sql: SqlStorage,
  scope: OrganisationExecutionScope,
  session: ConnectorCaseTurnStreamSession,
  input: ConnectorCaseTurnStreamInput,
  afterSequence: number,
): Promise<Result<Response, ConnectorCaseTurnStreamError>> {
  for (let attempt = 0; attempt < STREAM_REPLAY_ATTEMPTS; attempt += 1) {
    // The caller has not waited since its fence read. A retry follows a
    // wait, so it reads the fence again.
    if (attempt > 0 && !(await isActorExecutionActive(sql, scope)))
      return failure("connector_placement_conflict");
    const replay = await session.replayStream({
      organisationId: input.organisationId,
      turnId: input.turnId,
      afterSequence,
    });
    if (replay.ok) {
      traceLog("connector.replay_delivery_metrics", {
        requestId: input.requestId,
        organisation_id: input.organisationId,
        session_id: input.sessionId,
        turn_id: input.turnId,
        delivery_retry_count: attempt,
      });
      return replay;
    }
    if (replay.error.code !== "session_turn_not_found")
      return failure(replay.error.code);
    await scheduler.wait(STREAM_REPLAY_RETRY_MS);
  }
  return failure("session_turn_not_found");
}

async function consumeReplayResponse(input: {
  readonly run: StreamRun;
  readonly initialState: ReplayStreamState;
  readonly response: Response;
}): Promise<
  Result<ConnectorCaseTurnStreamResult, ConnectorCaseTurnStreamError>
> {
  const { run } = input;
  const reader = input.response.body?.getReader();
  if (reader === undefined) return failure("session_stream_body_missing");
  const replay: ReplayChunks = { reader, pending: null };
  const decoder = new TextDecoder();
  let buffer = "";
  let state = input.initialState;
  let chunkCount = 0;
  let batchCount = 0;
  let batchArrivedAt = Date.now();
  let previousBatchArrivedAt = batchArrivedAt;
  try {
    for (;;) {
      // Reading the Session's stream changes nothing here. The fence is read
      // once after each batch: the chunks that had arrived when the read
      // started. Their records are then applied without a further wait, and
      // any effect a record causes reads the fence itself.
      const batch = await readArrivedChunks(replay);
      chunkCount += batch.values.length;
      batchCount += 1;
      previousBatchArrivedAt = batchArrivedAt;
      batchArrivedAt = Date.now();
      if (!(await isActorExecutionActive(run.sql, run.scope)))
        return failure("connector_placement_conflict");
      for (const value of batch.values)
        buffer += decoder.decode(value, { stream: true });
      if (batch.done) buffer += decoder.decode();
      const consumed = await consumeReplayLines(run, state, buffer);
      if (!consumed.ok) return consumed;
      state = consumed.value.state;
      buffer = consumed.value.remaining;
      if (consumed.value.result !== null) {
        // The last batch waits for one fence read and the final release. A
        // gap that is as short as that shows a batch that waited behind the
        // batch before it.
        traceLog("connector.slack_stream_chunks", {
          requestId: run.input.requestId,
          organisation_id: run.input.organisationId,
          session_id: run.input.sessionId,
          turn_id: run.input.turnId,
          chunk_count: chunkCount,
          batch_count: batchCount,
          final_chunk_gap_ms: batchArrivedAt - previousBatchArrivedAt,
          final_chunk_fence_ms: Date.now() - batchArrivedAt,
        });
        return { ok: true, value: consumed.value.result };
      }
      if (batch.done) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Preserve the persisted replay outcome if the transport already failed.
    } finally {
      reader.releaseLock();
    }
  }
  return failure("session_stream_incomplete");
}

/** The Session's stream, and a read that has not resolved yet. */
type ReplayChunks = {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  pending: Promise<ReadableStreamReadResult<Uint8Array>> | null;
};

const NOT_ARRIVED = Symbol("not_arrived");
const NOTHING_ARRIVED = Promise.resolve(NOT_ARRIVED);

/**
 * Waits for the next chunk, then takes every chunk that has already arrived
 * behind it. A read that is still waiting stays for the next batch, so each
 * chunk of a batch arrived before the batch's fence read starts.
 */
async function readArrivedChunks(replay: ReplayChunks): Promise<{
  readonly values: readonly Uint8Array[];
  readonly done: boolean;
}> {
  const values: Uint8Array[] = [];
  let next = await (replay.pending ?? replay.reader.read());
  replay.pending = null;
  for (;;) {
    if (next.value !== undefined) values.push(next.value);
    if (next.done) return { values, done: true };
    const read = replay.reader.read();
    const arrived = await Promise.race([read, NOTHING_ARRIVED]);
    if (arrived === NOT_ARRIVED) {
      // The next batch awaits it; a stream that ends first leaves it unread.
      void read.catch(ignoreReadAhead);
      replay.pending = read;
      return { values, done: false };
    }
    next = arrived;
  }
}

/** A read ahead decides nothing; the read that needs it asks again. */
function ignoreReadAhead(): void {}

async function consumeReplayLines(
  run: StreamRun,
  initialState: ReplayStreamState,
  buffer: string,
): Promise<
  Result<
    {
      readonly state: ReplayStreamState;
      readonly remaining: string;
      readonly result: ConnectorCaseTurnStreamResult | null;
    },
    ConnectorCaseTurnStreamError
  >
> {
  let state = initialState;
  let remaining = buffer;
  let applied = false;
  let textEnded = false;
  for (;;) {
    const newline = remaining.indexOf("\n");
    if (newline < 0) {
      // The text of every record that arrived together leaves in one release.
      // An answer whose text and end arrive together keeps one final post.
      if (!applied)
        return { ok: true, value: { state, remaining, result: null } };
      const released = await releaseText(
        run,
        state.progress,
        textEnded ? "text_end" : "part",
      );
      if (!released.ok) return released;
      return {
        ok: true,
        value: {
          state: { kind: "buffering", progress: released.value },
          remaining,
          result: null,
        },
      };
    }
    const line = remaining.slice(0, newline).trim();
    remaining = remaining.slice(newline + 1);
    if (line.length === 0) continue;
    const parsed = parseSessionTurnStreamRecord(parseJsonOrNull(line));
    if (!parsed.ok) return failure(parsed.error.code);
    const record = await applyStreamRecord(run, state, parsed.value);
    if (!record.ok) return record;
    if (record.value.kind === "complete")
      return {
        ok: true,
        value: { state, remaining, result: record.value.result },
      };
    state = record.value.state;
    applied = true;
    // The agent wrote its last text. The turn still completes its checks.
    if (
      parsed.value.kind === "event" &&
      parsed.value.envelope.event.type === "done"
    )
      textEnded = true;
  }
}

async function applyStreamRecord(
  run: StreamRun,
  state: ReplayStreamState,
  record: SessionTurnStreamRecord,
): Promise<
  Result<
    | { readonly kind: "active"; readonly state: ReplayStreamState }
    | {
        readonly kind: "complete";
        readonly result: ConnectorCaseTurnStreamResult;
      },
    ConnectorCaseTurnStreamError
  >
> {
  if (streamRecordTurnId(record) !== run.input.turnId)
    return failure("session_stream_turn_mismatch");
  switch (record.kind) {
    case "upstream_revision":
      return { ok: true, value: { kind: "active", state } };
    case "failed":
      return failActiveStream(run, state, record.detail);
    case "complete":
      return prepareCompletedStream(run, state, record.lastSequence);
    case "event":
      return applyAgentEvent(run, state, record.envelope);
    default:
      return assertNever(record);
  }
}

function streamRecordTurnId(record: SessionTurnStreamRecord): string {
  return record.kind === "event" ? record.envelope.turnId : record.turnId;
}

async function applyAgentEvent(
  run: StreamRun,
  state: ReplayStreamState,
  envelope: Variant<SessionTurnStreamRecord, "event">["envelope"],
): Promise<
  Result<
    { readonly kind: "active"; readonly state: ReplayStreamState },
    ConnectorCaseTurnStreamError
  >
> {
  if (envelope.sequence !== state.progress.lastSequence + 1)
    return failure("session_stream_sequence_invalid");
  let progress = progressWithSequence(state.progress, envelope.sequence);
  switch (envelope.event.type) {
    case "agent_message": {
      const assembled = applyAgentMessageAssemblyEvent(
        progress,
        envelope.event.finalMessage
          ? { kind: "completed", text: envelope.event.text }
          : { kind: "delta", text: envelope.event.text },
      );
      if (!assembled.ok)
        return failActiveStream(run, state, assembled.error.code);
      progress =
        envelope.event.finalMessage &&
        `${progress.heldResponse}${assembled.value.appendedText}`.trim() ===
          CARD_ONLY_REPLY &&
        cardOfThisTurn(run) !== null
          ? { ...progress, ...assembled.value.state, heldResponse: "" }
          : acceptResponseText(
              progress,
              assembled.value.state,
              assembled.value.appendedText,
              run.input.target.channelId,
              envelope.event.finalMessage,
            );
      break;
    }
    case "error":
      return failActiveStream(run, state, envelope.event.error.code);
    case "agent_tool_use":
    case "custom_tool_use":
      // The text that this tool call follows was a working note.
      progress = { ...progress, heldResponse: "", responseReleased: false };
      break;
    case "status":
    case "done":
      break;
    default:
      return assertNever(envelope.event);
  }
  persistStreamState(
    run.sql,
    run.input.streamId,
    { kind: "buffering", progress },
    Date.now(),
  );
  return {
    ok: true,
    value: { kind: "active", state: { kind: "buffering", progress } },
  };
}

async function prepareCompletedStream(
  run: StreamRun,
  state: ReplayStreamState,
  lastSequence: number,
): Promise<
  Result<
    {
      readonly kind: "complete";
      readonly result: ConnectorCaseTurnStreamResult;
    },
    ConnectorCaseTurnStreamError
  >
> {
  if (
    lastSequence !== state.progress.lastSequence ||
    state.progress.currentMessageText !== "" ||
    state.progress.canonicalText.length === 0
  )
    return failure("session_stream_terminal_invalid");
  const canonicalText = state.progress.canonicalText;
  const answerText = state.progress.answerText;
  if (answerText === "") return completeOnCard(run, state.progress);
  const screened = screenTextForSurface({
    text: answerText,
    channelId: run.input.target.channelId,
  });
  const finalMessage =
    screened.action === "hold" ? OUTPUT_HELD_TEXT : answerText;
  const finalized = screenedProgress(
    state.progress,
    state.progress,
    "",
    run.input.target.channelId,
    true,
  );
  persistStreamState(
    run.sql,
    run.input.streamId,
    { kind: "buffering", progress: finalized },
    Date.now(),
  );
  const released = await releaseText(run, finalized, "turn_end");
  if (!released.ok) return released;
  const ended = await endLiveStream(run, released.value, finalMessage);
  if (!ended.ok) return ended;
  persistStreamState(run.sql, run.input.streamId, ended.value, Date.now());
  traceLog("connector.slack_stream_prepared", {
    requestId: run.input.requestId,
    organisation_id: run.input.organisationId,
    session_id: run.input.sessionId,
    turn_id: run.input.turnId,
    stream_id: run.input.streamId,
    elapsed_ms: Date.now() - run.input.receivedAt,
    canonical_chars: canonicalText.length,
    outcome: ended.value.kind,
  });
  return {
    ok: true,
    value: {
      kind: "complete",
      result: { finalMessage, canonicalMessage: canonicalText },
    },
  };
}

/**
 * The agent's card is the whole answer of this turn. The thread gets no text,
 * and the card's message is the receipt of the answer's delivery.
 */
function completeOnCard(
  run: StreamRun,
  progress: StreamProgress,
): Result<
  {
    readonly kind: "complete";
    readonly result: ConnectorCaseTurnStreamResult;
  },
  ConnectorCaseTurnStreamError
> {
  const cardTs = cardOfThisTurn(run);
  if (cardTs === null) return failure("session_stream_terminal_invalid");
  persistStreamState(
    run.sql,
    run.input.streamId,
    completedState(cardTs, CARD_ONLY_REPLY, progress),
    Date.now(),
  );
  return {
    ok: true,
    value: {
      kind: "complete",
      result: {
        finalMessage: CARD_ONLY_REPLY,
        canonicalMessage: progress.canonicalText,
      },
    },
  };
}

/**
 * The message of the last decision card in this turn's thread that was posted
 * after the turn's request. An earlier card does not count, so a later turn
 * that repeats the reply still gets a post.
 */
function cardOfThisTurn(run: StreamRun): string | null {
  const cards = run.sql
    .exec<{ delivery_id: string; ts: string }>(
      `SELECT delivery_id, json_extract(state_json, '$.receipt.nativeReceiptId') AS ts
       FROM connector_delivery
       WHERE (delivery_id GLOB 'delivery_commerce_notice_*' OR delivery_id GLOB 'delivery_permission_*')
         AND json_extract(payload, '$.address.channelId') = ?
         AND json_extract(payload, '$.address.threadTs') = ?
         AND json_extract(state_json, '$.kind') = 'delivered'
         AND json_extract(state_json, '$.receipt.deliveredAt') >= ?
       ORDER BY json_extract(state_json, '$.receipt.deliveredAt') DESC`,
      run.input.target.channelId,
      run.input.target.threadTs,
      run.input.receivedAt,
    )
    .toArray();
  return (
    cards.find(
      (card) =>
        permissionDecisionRequestId(card.delivery_id) === null &&
        heldNoticeOfDecision(card.delivery_id) === null,
    )?.ts ?? null
  );
}

/**
 * The end state of a turn whose output is complete. A stream that released
 * the whole answer stops and is delivered; a stream that lost text leaves the
 * final post to the delivery; a denied stream keeps its partial answer only.
 */
async function endLiveStream(
  run: StreamRun,
  progress: StreamProgress,
  finalMessage: string,
): Promise<Result<ConnectorSlackStreamState, ConnectorCaseTurnStreamError>> {
  const live = progress.live;
  if (live.slackTs === null)
    return { ok: true, value: { kind: "prepared", finalMessage, progress } };
  if (live.kind === "closed") {
    const reason = live.reason;
    switch (reason) {
      case "withheld":
        return {
          ok: true,
          value: {
            kind: "withheld",
            slackTs: live.slackTs,
            finalMessage,
            progress,
          },
        };
      case "ended":
        // The thread keeps what it shows; nothing more is posted.
        return {
          ok: true,
          value: completedState(live.slackTs, finalMessage, progress),
        };
      case "held":
        return finalMessage === OUTPUT_HELD_TEXT
          ? {
              ok: true,
              value: completedState(live.slackTs, finalMessage, progress),
            }
          : { ok: true, value: { kind: "prepared", finalMessage, progress } };
      case "uncertain":
      case "unsupported":
      case "stopped":
        return {
          ok: true,
          value: { kind: "prepared", finalMessage, progress },
        };
      default:
        return assertNever(reason);
    }
  }
  if (
    finalMessage === OUTPUT_HELD_TEXT ||
    live.releasedChars !== progress.answerText.length
  ) {
    // The final screen held the answer, or the last part could not be checked.
    const reason = finalMessage === OUTPUT_HELD_TEXT ? "held" : "uncertain";
    const closed = await closeLive(run, progress, reason);
    if (!closed.ok) return closed;
    return endLiveStream(run, closed.value, finalMessage);
  }
  // The whole answer is in the message. A stop that fails (Slack ended the
  // message, or the result of an earlier stop was lost) changes nothing that
  // the thread shows, so the answer is complete either way.
  const stopped = await stopSlackStreamAtFence(run, live.slackTs, null);
  if (!stopped.ok && isPlacementConflict(stopped.error)) return stopped;
  return {
    ok: true,
    value: completedState(live.slackTs, finalMessage, progress),
  };
}

function isPlacementConflict(error: ConnectorCaseTurnStreamError): boolean {
  return (
    error.kind === "operational" &&
    error.code === "connector_placement_conflict"
  );
}

function completedState(
  slackTs: string,
  finalMessage: string,
  progress: StreamProgress,
): ConnectorSlackStreamState {
  return {
    kind: "completed",
    slackTs,
    finalMessage,
    canonicalMessage: progress.canonicalText,
    completedAt: Date.now(),
  };
}

/**
 * Takes new text of the model's response. Text waits until the response is
 * long enough to be the answer, or until the turn's answer is complete. A turn
 * whose last response has no text keeps the text it wrote, so the thread still
 * gets an answer.
 */
function acceptResponseText(
  progress: StreamProgress,
  assembly: Pick<StreamProgress, "canonicalText" | "currentMessageText">,
  text: string,
  channelId: ChannelId,
  complete: boolean,
): StreamProgress {
  const response = `${progress.heldResponse}${text}`;
  if (
    !complete &&
    !progress.responseReleased &&
    response.trim().length < ANSWER_HOLD_CHARS
  )
    return { ...progress, ...assembly, heldResponse: response };
  // The answer starts at this response, without its separator.
  const first = progress.answerText === "";
  const released = !first
    ? response
    : complete && response.trim() === ""
      ? assembly.canonicalText
      : response.trimStart();
  return {
    ...screenedProgress(progress, assembly, released, channelId, false),
    answerText: `${progress.answerText}${released}`,
    heldResponse: "",
    responseReleased: !complete,
  };
}

/** Feeds new answer text through the incremental screen. */
function screenedProgress(
  progress: StreamProgress,
  assembly: Pick<StreamProgress, "canonicalText" | "currentMessageText">,
  appendedText: string,
  channelId: ChannelId,
  terminal: boolean,
): StreamProgress {
  const decision = screenIncrementalOutput({
    state: progress.screen,
    chunk: appendedText,
    channelId,
    terminal,
  });
  return {
    ...progress,
    canonicalText: assembly.canonicalText,
    currentMessageText: assembly.currentMessageText,
    screen: decision.state,
    safeText:
      decision.action === "release"
        ? `${progress.safeText}${decision.text}`
        : progress.safeText,
  };
}

/**
 * When a release happens: a part of the answer, the end of the agent's text
 * while the turn still completes its checks, or the end of the turn.
 */
type ReleaseMoment = "part" | "text_end" | "turn_end";

/**
 * Releases the screened text that waits, when the interval passed or the part
 * is large, or when the text or the turn ended. The first part is large at
 * about one sentence. Each release first checks the binding that the Session
 * holds now. A short answer that ends before its first release keeps the
 * single final post.
 */
async function releaseText(
  run: StreamRun,
  progress: StreamProgress,
  moment: ReleaseMoment,
): Promise<Result<StreamProgress, ConnectorCaseTurnStreamError>> {
  const live = progress.live;
  if (live.kind !== "open") return { ok: true, value: progress };
  if (progress.screen.kind === "held") return closeLive(run, progress, "held");
  const pending = progress.safeText
    .slice(live.releasedChars)
    .slice(0, SLACK_STREAM_TEXT_LIMIT);
  if (pending.length === 0 || (moment !== "part" && live.slackTs === null))
    return { ok: true, value: progress };
  let now = Date.now();
  if (now < live.notBefore) {
    // The end of the turn waits a short Slack retry time; a longer one
    // leaves the rest to the final post.
    if (moment !== "turn_end" || live.notBefore - now > FINAL_RETRY_WAIT_MS)
      return { ok: true, value: progress };
    await scheduler.wait(live.notBefore - now);
    if (!(await isActorExecutionActive(run.sql, run.scope)))
      return failure("connector_placement_conflict");
    now = Date.now();
  }
  if (live.slackTs === null && live.releasedAt === 0) {
    // The first safe text starts the wait of the first part.
    const waiting = withLive(progress, { ...live, releasedAt: now });
    persistStreamState(
      run.sql,
      run.input.streamId,
      { kind: "buffering", progress: waiting },
      now,
    );
    return releaseText(run, waiting, moment);
  }
  const partChars = live.slackTs === null ? FIRST_RELEASE_CHARS : RELEASE_CHARS;
  if (
    moment === "part" &&
    now - live.releasedAt < RELEASE_INTERVAL_MS &&
    pending.length < partChars
  )
    return { ok: true, value: progress };
  // The token is read beside the check; a denied part sends nothing with it.
  const [checked, token] = await Promise.all([
    checkRelease(run, progress, now),
    streamToken(run),
  ]);
  if (checked.kind === "unavailable") {
    // The next check waits one interval, so an outage is not asked again on
    // every part.
    const waiting = withLive(progress, {
      ...live,
      notBefore: now + RELEASE_INTERVAL_MS,
    });
    persistStreamState(
      run.sql,
      run.input.streamId,
      { kind: "buffering", progress: waiting },
      now,
    );
    return { ok: true, value: waiting };
  }
  if (checked.kind === "deny") return closeLive(run, progress, "withheld");
  const allowed = checked.progress;
  if (!token.ok) return token;
  const target = live.releasedChars + pending.length;
  const sending = withLive(allowed, { ...live, appendingTo: target });
  persistStreamState(
    run.sql,
    run.input.streamId,
    { kind: "buffering", progress: sending },
    now,
  );
  if (!(await isActorExecutionActive(run.sql, run.scope)))
    return failure("connector_placement_conflict");
  let slackTs: string;
  if (live.slackTs === null) {
    const started = await startSlackStream({
      token: token.value,
      target: run.input.target,
      markdownText: pending,
      now,
    });
    if (!started.ok) return releaseFailed(run, sending, started.error);
    slackTs = started.value.slackTs;
  } else {
    const appended = await appendSlackStream({
      token: token.value,
      channelId: run.input.target.channelId,
      slackTs: live.slackTs,
      markdownText: pending,
      now,
    });
    if (!appended.ok) return releaseFailed(run, sending, appended.error);
    slackTs = live.slackTs;
  }
  const releasedAt = Date.now();
  if (live.releasedChars === 0)
    traceLog("connector.slack_stream_first_output", {
      requestId: run.input.requestId,
      stream_id: run.input.streamId,
      elapsed_ms: releasedAt - run.input.receivedAt,
      chars: pending.length,
      // From the start of this release: its checks and the Slack call.
      release_ms: releasedAt - now,
    });
  const released = withLive(allowed, {
    kind: "open",
    slackTs,
    releasedChars: target,
    appendingTo: null,
    releasedAt,
    notBefore: 0,
  });
  persistStreamState(
    run.sql,
    run.input.streamId,
    { kind: "buffering", progress: released },
    releasedAt,
  );
  // A long answer leaves in parts of at most one Slack call each.
  return moment !== "part" && target < released.safeText.length
    ? releaseText(run, released, moment)
    : { ok: true, value: released };
}

/** A start or append that Slack refused, rate-limited or left unknown. */
async function releaseFailed(
  run: StreamRun,
  progress: StreamProgress,
  error: SlackStreamError,
): Promise<Result<StreamProgress, ConnectorCaseTurnStreamError>> {
  const live = progress.live;
  if (live.kind !== "open") return { ok: true, value: progress };
  switch (error.code) {
    case "rate_limited": {
      // Slack applied nothing. The next release waits for the retry time.
      const waiting = withLive(progress, {
        ...live,
        appendingTo: null,
        notBefore: error.retryAt,
      });
      persistStreamState(
        run.sql,
        run.input.streamId,
        { kind: "buffering", progress: waiting },
        Date.now(),
      );
      return { ok: true, value: waiting };
    }
    case "ambiguous":
      return closeLive(run, progress, "uncertain");
    case "ended":
      // Slack applied nothing, and the message keeps what it shows.
      return closeLive(
        run,
        withLive(progress, { ...live, appendingTo: null }),
        "ended",
      );
    case "slack_stream_failed": {
      // A refused start leaves no message; a refused append leaves the text
      // released so far.
      const reason = live.slackTs === null ? "unsupported" : "uncertain";
      return closeLive(
        run,
        withLive(progress, { ...live, appendingTo: null }),
        reason,
      );
    }
    default:
      return assertNever(error);
  }
}

/**
 * Checks the binding that the Session holds now against the thread. An
 * allowed version is reused until its live authority is checked again.
 */
async function checkRelease(
  run: StreamRun,
  progress: StreamProgress,
  now: number,
): Promise<
  StrictUnion<
    | { readonly kind: "allow"; readonly progress: StreamProgress }
    | { readonly kind: "deny" }
    | { readonly kind: "unavailable" }
  >
> {
  const binding = await run.session.readSessionTurnFlowBinding({
    requestingOrganisationId: run.input.organisationId,
    sessionId: run.input.sessionId,
    turnId: run.input.turnId,
  });
  if (!binding.ok) return { kind: "unavailable" };
  const digest = binding.value.informationFlowContextDigest;
  if (
    progress.checked !== null &&
    progress.checked.digest === digest &&
    now - progress.checked.at < RELEASE_RECHECK_MS
  )
    return { kind: "allow", progress };
  const verdict = await run.release(binding.value);
  switch (verdict) {
    case "allow":
      return {
        kind: "allow",
        progress: { ...progress, checked: { digest, at: now } },
      };
    case "deny":
      return { kind: "deny" };
    case "unavailable":
      return { kind: "unavailable" };
    default:
      return assertNever(verdict);
  }
}

/**
 * Releases nothing more. An open Slack message stops with the notice of
 * `reason`, so no stream stays open in the thread.
 */
async function closeLive(
  run: StreamOutlet,
  progress: StreamProgress,
  reason: LiveCloseReason,
): Promise<Result<StreamProgress, ConnectorCaseTurnStreamError>> {
  const live = progress.live;
  if (live.kind === "closed") return { ok: true, value: progress };
  if (live.slackTs !== null && reason !== "ended") {
    const stopped = await stopSlackStreamAtFence(
      run,
      live.slackTs,
      CLOSE_NOTICES[reason],
    );
    // A stream that Slack does not stop now ends by itself; the closed state
    // keeps any further text out of it.
    if (!stopped.ok && isPlacementConflict(stopped.error)) return stopped;
  }
  const closed = withLive(progress, {
    kind: "closed",
    slackTs: live.slackTs,
    releasedChars: live.releasedChars,
    reason,
  });
  persistStreamState(
    run.sql,
    run.input.streamId,
    { kind: "buffering", progress: closed },
    Date.now(),
  );
  return { ok: true, value: closed };
}

async function stopSlackStreamAtFence(
  run: StreamOutlet,
  slackTs: string,
  notice: string | null,
): Promise<Result<null, ConnectorCaseTurnStreamError>> {
  const token = await streamToken(run);
  if (!token.ok) return token;
  if (!(await isActorExecutionActive(run.sql, run.scope)))
    return failure("connector_placement_conflict");
  const stopped = await stopSlackStream({
    token: token.value,
    channelId: run.input.target.channelId,
    slackTs,
    markdownText: notice,
    now: Date.now(),
  });
  return stopped.ok
    ? { ok: true, value: null }
    : failure(slackFailureReason(stopped.error));
}

/** The stream's one token read. A read that failed is made again. */
async function streamToken(
  run: StreamOutlet,
): Promise<Result<string, ConnectorCaseTurnStreamError>> {
  const read = (run.token ??= resolveSlackToken(run.env, run.input));
  try {
    const token = await read;
    if (!token.ok && run.token === read) run.token = null;
    return token;
  } catch (error) {
    if (run.token === read) run.token = null;
    throw error;
  }
}

function withLive(progress: StreamProgress, live: LiveStream): StreamProgress {
  return { ...progress, live };
}

async function resolveSlackToken(
  env: Env,
  input: ConnectorCaseTurnStreamInput,
): Promise<Result<string, ConnectorCaseTurnStreamError>> {
  const installationIdentity = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
    appId: env.SLACK_APP_ID,
  });
  if (!installationIdentity.ok) {
    return failure(installationIdentity.error.code);
  }
  const credential = await resolveActiveSlackThreadCredential({
    env,
    keys: env,
    installationIdentity: installationIdentity.value,
    organisationId: input.organisationId,
    workspaceId: input.target.workspaceId,
    channelId: input.target.channelId,
    rootMessageTs: input.target.threadTs,
  });
  return credential.ok && credential.value.kind === "bearer"
    ? { ok: true, value: credential.value.value }
    : failure("connector_credential_unavailable");
}

async function failActiveStream(
  run: StreamRun,
  state: ReplayStreamState,
  reason: string,
): Promise<Result<never, ConnectorCaseTurnStreamError>> {
  const { sql, scope, input } = run;
  // A failed turn stops its open answer before the failure text follows it.
  const stopped = await closeLive(run, state.progress, "stopped");
  if (!stopped.ok) return stopped;
  // A budget stop gets its own notice with the budget link from the Case
  // processing, not the generic failure text.
  if (reason === "budget_exhausted") {
    persistStreamState(
      sql,
      input.streamId,
      { kind: "failed", reason, progress: stopped.value },
      Date.now(),
    );
    return restoredSessionFailure(reason);
  }
  const token = await streamToken(run);
  if (!token.ok) return token;
  const clientMessageId = await slackClientMessageId(
    `${input.expectedIdempotencyKey}:terminal_failure`,
  );
  if (!(await isActorExecutionActive(sql, scope)))
    return failure("connector_placement_conflict");
  const posted = await postSlackThreadMessage({
    token: token.value,
    channelId: input.target.channelId,
    threadTs: input.target.threadTs,
    text:
      reason === "session_interrupted"
        ? STREAM_INTERRUPTED_TEXT
        : STREAM_FAILED_TEXT,
    clientMessageId,
    now: Date.now(),
  });
  if (!posted.ok) return failure(slackFailureReason(posted.error));
  persistStreamState(
    sql,
    input.streamId,
    { kind: "failed", reason, progress: stopped.value },
    Date.now(),
  );
  return restoredSessionFailure(reason);
}

function initialProgress(): StreamProgress {
  return {
    canonicalText: "",
    currentMessageText: "",
    answerText: "",
    heldResponse: "",
    responseReleased: false,
    lastSequence: -1,
    screen: initialIncrementalScreenState(),
    safeText: "",
    live: {
      kind: "open",
      slackTs: null,
      releasedChars: 0,
      appendingTo: null,
      releasedAt: 0,
      notBefore: 0,
    },
    checked: null,
  };
}

function progressWithSequence(
  progress: StreamProgress,
  sequence: number,
): StreamProgress {
  return { ...progress, lastSequence: sequence };
}

function persistStreamState(
  sql: SqlStorage,
  streamId: string,
  state: ConnectorSlackStreamState,
  now: number,
): void {
  sql.exec(
    "UPDATE connector_slack_stream SET state_json = ?, updated_at = ? WHERE stream_id = ?",
    JSON.stringify(state),
    now,
    streamId,
  );
}

function parseConnectorSlackStreamState(
  value: string,
): ConnectorSlackStreamState | null {
  const raw = parseJsonOrNull(value);
  if (!isRecord(raw) || !isNonBlankString(raw.kind)) return null;
  if (raw.kind === "completed") {
    return isNonBlankString(raw.slackTs) &&
      isNonBlankString(raw.finalMessage) &&
      isNonBlankString(raw.canonicalMessage) &&
      isNonNegativeInteger(raw.completedAt)
      ? {
          kind: "completed",
          slackTs: raw.slackTs,
          finalMessage: raw.finalMessage,
          canonicalMessage: raw.canonicalMessage,
          completedAt: raw.completedAt,
        }
      : null;
  }
  const progress = parseProgress(raw.progress);
  if (progress === null) return null;
  switch (raw.kind) {
    case "buffering":
      return { kind: "buffering", progress };
    case "prepared":
      return isNonBlankString(raw.finalMessage)
        ? { kind: "prepared", finalMessage: raw.finalMessage, progress }
        : null;
    case "withheld":
      return isNonBlankString(raw.slackTs) && isNonBlankString(raw.finalMessage)
        ? {
            kind: "withheld",
            slackTs: raw.slackTs,
            finalMessage: raw.finalMessage,
            progress,
          }
        : null;
    case "failed":
      return isNonBlankString(raw.reason)
        ? { kind: "failed", reason: raw.reason, progress }
        : null;
    default:
      return null;
  }
}

function parseProgress(value: unknown): StreamProgress | null {
  if (
    !isRecord(value) ||
    typeof value.canonicalText !== "string" ||
    typeof value.currentMessageText !== "string" ||
    !signedInteger(value.lastSequence) ||
    typeof value.safeText !== "string"
  )
    return null;
  // A stream that a release interrupted has no notes to leave out.
  const answerText =
    typeof value.answerText === "string"
      ? value.answerText
      : value.canonicalText;
  if (!answerText.startsWith(value.safeText)) return null;
  const screen = parseScreenState(value.screen);
  const live = parseLiveStream(value.live, value.safeText.length);
  const checked = parseChecked(value.checked);
  if (screen === null || live === null || checked === undefined) return null;
  return {
    canonicalText: value.canonicalText,
    currentMessageText: value.currentMessageText,
    answerText,
    heldResponse:
      typeof value.heldResponse === "string" ? value.heldResponse : "",
    responseReleased: value.responseReleased !== false,
    lastSequence: value.lastSequence,
    screen,
    safeText: value.safeText,
    live,
    checked,
  };
}

function parseLiveStream(value: unknown, safeChars: number): LiveStream | null {
  if (
    !isRecord(value) ||
    (value.slackTs !== null && !isNonBlankString(value.slackTs)) ||
    !isNonNegativeInteger(value.releasedChars) ||
    value.releasedChars > safeChars
  )
    return null;
  const slackTs = value.slackTs;
  switch (value.kind) {
    case "open":
      return (value.appendingTo === null ||
        (isNonNegativeInteger(value.appendingTo) &&
          value.appendingTo > value.releasedChars &&
          value.appendingTo <= safeChars)) &&
        isNonNegativeInteger(value.releasedAt) &&
        isNonNegativeInteger(value.notBefore)
        ? {
            kind: "open",
            slackTs,
            releasedChars: value.releasedChars,
            appendingTo: value.appendingTo,
            releasedAt: value.releasedAt,
            notBefore: value.notBefore,
          }
        : null;
    case "closed":
      return isLiveCloseReason(value.reason)
        ? {
            kind: "closed",
            slackTs,
            releasedChars: value.releasedChars,
            reason: value.reason,
          }
        : null;
    default:
      return null;
  }
}

const LIVE_CLOSE_REASONS: ReadonlySet<unknown> = new Set<LiveCloseReason>([
  "unsupported",
  "held",
  "withheld",
  "uncertain",
  "stopped",
  "ended",
]);

function isLiveCloseReason(value: unknown): value is LiveCloseReason {
  return LIVE_CLOSE_REASONS.has(value);
}

/** The checked binding version, `null` before a check, `undefined` if invalid. */
function parseChecked(value: unknown): StreamProgress["checked"] | undefined {
  if (value === null) return null;
  return isRecord(value) &&
    isNonBlankString(value.digest) &&
    isNonNegativeInteger(value.at)
    ? { digest: value.digest, at: value.at }
    : undefined;
}

function parseScreenState(value: unknown): IncrementalScreenState | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "streaming":
      return typeof value.pending === "string" &&
        typeof value.context === "string"
        ? { kind: "streaming", pending: value.pending, context: value.context }
        : null;
    case "held":
      return { kind: "held" };
    case "complete":
      return { kind: "complete" };
    default:
      return null;
  }
}

function preparedResult(
  state: Variant<ConnectorSlackStreamState, "prepared" | "withheld">,
): Result<ConnectorCaseTurnStreamResult, ConnectorCaseTurnStreamError> {
  return {
    ok: true,
    value: {
      finalMessage: state.finalMessage,
      canonicalMessage: state.progress.canonicalText,
    },
  };
}

function completedResult(
  state: Variant<ConnectorSlackStreamState, "completed">,
): Result<ConnectorCaseTurnStreamResult, ConnectorCaseTurnStreamError> {
  return {
    ok: true,
    value: {
      finalMessage: state.finalMessage,
      canonicalMessage: state.canonicalMessage,
    },
  };
}

function deliveryReceipt(
  identity: ConnectorIdentity,
  delivery: ConnectorDelivery,
  slackTs: string,
  deliveredAt: number,
): ConnectorDeliveryReceipt {
  return {
    deliveryId: delivery.deliveryId,
    connectorId: identity.connectorId,
    idempotencyKey: delivery.idempotencyKey,
    nativeReceiptId: slackTs,
    deliveredAt,
  };
}

function slackFailureReason(
  error: SlackMessageError | SlackStreamError,
): string {
  return error.code === "ambiguous"
    ? `connector_stream_ambiguous:${error.operation}`
    : `connector_stream_${error.code}:${error.detail}`;
}

function failure<T>(code: string): Result<T, ConnectorCaseTurnStreamError> {
  return { ok: false, error: { kind: "operational", code } };
}

function restoredSessionFailure(
  code: string,
): Result<never, ConnectorCaseTurnStreamError> {
  // Persisted stream failures are decoded once at this boundary.
  const historyCode: VariantBy<
    EmbeddedHarnessTurnError,
    "code",
    "embedded_harness_history_failed"
  >["code"] = "embedded_harness_history_failed";
  return code === historyCode
    ? { ok: false, error: { kind: "history_corruption", code: historyCode } }
    : failure(code);
}

function signedInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= -1
  );
}
