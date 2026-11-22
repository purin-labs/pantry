import { workspaceCanvasLabelAllowsReaders } from "./conversation-disclosure";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { decideChatFlowDelivery } from "./information-flow";
import { authorizeConversation } from "./conversation-access";
import type { ConversationId } from "@purin-labs/control-api";
import { applyAgentMessageAssemblyEvent } from "@purin-labs/agent/actors/agent-message-assembly";
import { resolveActiveSessionActorAtPlacement } from "@purin-labs/actor-runtime/actors/actor-router";
import type { SessionActor } from "@purin-labs/agent/actors/session/session-actor";
import {
  parseSessionTurnStreamRecord,
  type SessionTurnStreamRecord,
} from "@purin-labs/agent/actors/agent-session-turn-stream";
import type { Env } from "@purin-labs/kernel/env";
import type { AgentEvent, RequestAuthority } from "@purin-labs/contracts";
import { FlowBinding } from "@purin-labs/authority/policy/information-flow/index";
import { conversationTimeline, type ConversationStream } from "./conversation";
import type { ConversationScope } from "./store";
import {
  readConversation,
  readConversationStatus,
  reconcileRevokedConversationRun,
} from "./store";
import { projectReplyStreamText } from "./reply-stream-projector";

import type { PortalChatStreamRecord } from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";
import {
  assertNever,
  backoffDelay,
  errorMessage,
  parseJsonOrNull,
} from "@purin-labs/std";
import { parseRequestId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import { authorizeSessionTurnOrigin } from "./turn-access";

type StreamInput = {
  readonly env: Env;
  readonly placement: OrganisationExecutionScope;
  readonly scope: ConversationScope;
  readonly conversationId: ConversationId;
  readonly requestId: string;
  readonly afterSequence: number;
  readonly requestAuthority: Variant<RequestAuthority, "control">;
  readonly controlSessionId: string;
};

type Writer = WritableStreamDefaultWriter<Uint8Array>;

const STEP_SEQUENCE_SIZE = 1_000_000;
const ACTIVITY_SEQUENCE_OFFSET = 900_000;
const TERMINAL_SEQUENCE_OFFSET = 999_999;
const TURN_START_ATTEMPTS = 120;
const CONVERSATION_OBSERVATION_MS = 30_000;
const RETRY_DELAY_MS = 25;

export function createPortalChatStreamResponse(
  input: StreamInput,
  execution: Pick<ExecutionContext, "waitUntil">,
): Response {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  execution.waitUntil(runPortalChatStream(input, writer));
  return new Response(stream.readable, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function terminalSequence(afterSequence: number, step: number): number {
  return (
    Math.max(0, step, Math.floor(afterSequence / STEP_SEQUENCE_SIZE)) *
      STEP_SEQUENCE_SIZE +
    TERMINAL_SEQUENCE_OFFSET
  );
}

async function runPortalChatStream(
  input: StreamInput,
  writer: Writer,
): Promise<void> {
  let step = -1;
  const startedAt = Date.now();
  let phase = "conversation_read";
  try {
    for (;;) {
      const current = await input.placement.accountAccess.checkUser({
        userId: input.scope.userId,
        authority: {
          kind: "authenticated_session",
          nativeSessionId: input.controlSessionId,
        },
        action: "replay",
      });
      if (!current.ok) {
        await writeFailure(
          writer,
          input.afterSequence,
          terminalSequence(input.afterSequence, step),
          current.error.code,
        );
        return;
      }
      phase = "conversation_read";
      await reconcileRevokedConversationRun(
        input.placement,
        input.scope.userId,
        input.conversationId,
      );
      const stored = await readConversation(
        input.placement.database,
        input.scope,
        input.conversationId,
      );
      if (stored === null) {
        await writeFailure(
          writer,
          input.afterSequence,
          terminalSequence(input.afterSequence, -1),
          "Conversation unavailable.",
        );
        return;
      }
      const work = stored.conversation.work;
      if (stored.conversation.completedRequests.includes(input.requestId)) {
        const usage = latestRequestUsage(stored.conversation, input.requestId);
        if (usage !== null)
          await writeRecord(writer, input.afterSequence, {
            kind: "usage",
            sequence: terminalSequence(input.afterSequence, step) - 1,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            totalTokens: usage.totalTokens,
          });
        await writeRecord(writer, input.afterSequence, {
          kind: "complete",
          sequence: terminalSequence(input.afterSequence, step),
          conversationRevision: stored.revision,
        });
        return;
      }
      if (work.kind === "ready" || work.requestId !== input.requestId) {
        await writeFailure(
          writer,
          input.afterSequence,
          terminalSequence(input.afterSequence, step),
          "This response is unavailable or has been replaced by a newer request.",
        );
        return;
      }
      if (work.kind === "failed") {
        if (work.recovery?.kind === "projection_capacity") {
          step = work.recovery.stream.step;
          await streamConversationStep(input, writer, work.recovery.stream);
        }
        await writeFailure(
          writer,
          input.afterSequence,
          terminalSequence(input.afterSequence, step),
          work.error,
        );
        return;
      }
      if (work.kind === "awaiting_permission") {
        // The run waits for a person, which can take longer than a stream
        // lives. The Portal resumes it and then follows the new stream.
        await writeRecord(writer, input.afterSequence, {
          kind: "paused",
          sequence: terminalSequence(input.afterSequence, step),
          run: "awaiting_permission",
        });
        return;
      }
      if (work.kind === "cancelling") {
        await writeRecord(writer, input.afterSequence, {
          kind: "run_state",
          sequence:
            Math.max(0, step) * STEP_SEQUENCE_SIZE + ACTIVITY_SEQUENCE_OFFSET,
          run: work.kind,
        });
        phase = "state_change";
        const advanced = await waitForConversationStateChange(input, work.kind);
        if (!advanced) return;
        continue;
      }
      if (work.stream.step === step) {
        phase = "conversation_advance";
        const advanced = await waitForConversationAdvance(input, step);
        if (!advanced) return;
        continue;
      }
      step = work.stream.step;
      if (step > 0)
        await writeRecord(writer, input.afterSequence, {
          kind: "run_state",
          sequence: step * STEP_SEQUENCE_SIZE,
          run: "running",
        });
      phase = "turn_replay";
      const streamed = await streamConversationStep(input, writer, work.stream);
      if (!streamed) return;
      await writeRecord(writer, input.afterSequence, {
        kind: "progress",
        sequence: step * STEP_SEQUENCE_SIZE + ACTIVITY_SEQUENCE_OFFSET,
        label: "Processing the response…",
      });
    }
  } catch (error) {
    const requestId = parseRequestId(input.requestId);
    if (requestId.ok) {
      traceWarn("portal.chat_stream_interrupted", {
        requestId: requestId.value,
        organisation_id: input.scope.organisationId,
        conversation_id: input.conversationId,
        phase,
        step,
        after_sequence: input.afterSequence,
        duration_ms: Date.now() - startedAt,
        error_name: error instanceof Error ? error.name : "UnknownError",
        error_message: errorMessage(error).slice(0, 256),
      });
    }
  } finally {
    await closeWriter(writer);
  }
}

function latestRequestUsage(
  conversation: Parameters<typeof conversationTimeline>[0],
  requestId: string,
): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number | null;
  readonly totalTokens: number;
} | null {
  const event = conversationTimeline(conversation).findLast(
    assistantEventHasRequestId.bind(null, requestId),
  );
  return event?.kind === "assistant" ? event.usage : null;
}

function assistantEventHasRequestId(
  requestId: string,
  event: ReturnType<typeof conversationTimeline>[number],
): event is Variant<
  ReturnType<typeof conversationTimeline>[number],
  "assistant"
> {
  return event.kind === "assistant" && event.requestId === requestId;
}

async function streamConversationStep(
  input: StreamInput,
  writer: Writer,
  stream: ConversationStream,
): Promise<boolean> {
  const replay = await openTurnReplay(input, stream);
  if (replay === null) {
    await writeFailure(
      writer,
      input.afterSequence,
      terminalSequence(input.afterSequence, stream.step),
      "The response could not be resumed. Retry it from the saved conversation.",
    );
    return false;
  }
  return projectAcceptedTurnReplay(input, writer, stream, replay);
}

export async function projectAcceptedTurnReplay(
  input: StreamInput,
  writer: Writer,
  stream: ConversationStream,
  replay: {
    readonly response: Response;
    readonly session: Pick<SessionActor, "readSessionTurnFlowBinding">;
  },
): Promise<boolean> {
  const reader = replay.response.body?.getReader();
  if (reader === undefined) return false;
  void writer.closed.catch(cancelTurnReplayReader.bind(null, reader));
  const decoder = new TextDecoder();
  let buffer = "";
  let assembly = { canonicalText: "", currentMessageText: "" };
  let projectedText = "";
  let replayClosed = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const consumed = await consumeTurnLines({
        input,
        writer,
        stream,
        buffer,
        assembly,
        projectedText,
        session: replay.session,
      });
      buffer = consumed.buffer;
      assembly = consumed.assembly;
      projectedText = consumed.projectedText;
      switch (consumed.kind) {
        case "ended":
          if (!(await reader.read()).done)
            throw new Error("Turn replay continued after its terminal record.");
          replayClosed = true;
          return consumed.success;
        case "stopped":
          return false;
        case "reading":
          break;
        default:
          assertNever(consumed);
      }
      if (chunk.done) {
        replayClosed = true;
        return false;
      }
    }
  } finally {
    if (!replayClosed) {
      await cancelTurnReplayReader(reader);
    }
    reader.releaseLock();
  }
}

async function cancelTurnReplayReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // An interrupted Actor may already have rejected its stream.
  }
}

async function openTurnReplay(
  input: StreamInput,
  stream: ConversationStream,
): Promise<{
  readonly response: Response;
  readonly session: Pick<SessionActor, "readSessionTurnFlowBinding">;
} | null> {
  for (let attempt = 0; attempt < TURN_START_ATTEMPTS; attempt += 1) {
    if (
      !(await authorizeSessionTurnOrigin(
        input.env.DB,
        input.placement.database,
        input.scope.organisationId,
        stream.sessionId,
        stream.turnId,
      ))
    ) {
      await scheduler.wait(RETRY_DELAY_MS);
      continue;
    }
    const session = await resolveActiveSessionActorAtPlacement({
      env: input.env,
      placement: input.placement.placement,
      namespace: input.env.SESSION,
      organisationId: input.scope.organisationId,
      sessionId: stream.sessionId,
      now: Date.now(),
    });
    if (session.ok) {
      const replay = await session.value.replayStream({
        organisationId: input.scope.organisationId,
        turnId: stream.turnId,
        afterSequence: -1,
      });
      if (replay.ok) return { response: replay.value, session: session.value };
      if (
        replay.error.code !== "session_turn_not_found" &&
        replay.error.code !== "session_not_initialized"
      )
        return null;
    }
    await scheduler.wait(RETRY_DELAY_MS);
  }
  return null;
}

type ConsumeTurnInput = {
  readonly input: StreamInput;
  readonly writer: Writer;
  readonly stream: ConversationStream;
  readonly buffer: string;
  readonly assembly: {
    readonly canonicalText: string;
    readonly currentMessageText: string;
  };
  readonly projectedText: string;
  readonly session: Pick<SessionActor, "readSessionTurnFlowBinding">;
};

type ConsumeTurnResult = {
  readonly buffer: string;
  readonly assembly: ConsumeTurnInput["assembly"];
  readonly projectedText: string;
} & (
  | { readonly kind: "reading" | "stopped"; readonly success?: never }
  | { readonly kind: "ended"; readonly success: boolean }
);

async function consumeTurnLines(
  raw: ConsumeTurnInput,
): Promise<ConsumeTurnResult> {
  let buffer = raw.buffer;
  let assembly = raw.assembly;
  let projectedText = raw.projectedText;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0)
      return {
        buffer,
        assembly,
        projectedText,
        kind: "reading",
      };
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) continue;
    const record = parseSessionTurnStreamRecord(parseJsonOrNull(line));
    if (
      (await authorizeConversation(
        raw.input.placement.database,
        raw.input.scope,
        raw.input.conversationId,
      )) === null
    )
      return { buffer, assembly, projectedText, kind: "stopped" };
    if (!record.ok || turnId(record.value) !== raw.stream.turnId)
      return {
        buffer,
        assembly,
        projectedText,
        kind: "stopped",
      };
    if (record.value.kind === "failed")
      return {
        buffer,
        assembly,
        projectedText,
        kind: "ended",
        success: false,
      };
    if (record.value.kind === "complete")
      return { buffer, assembly, projectedText, kind: "ended", success: true };
    if (record.value.kind !== "event") continue;
    const envelope = record.value.envelope;
    if (envelope.event.type !== "agent_message") {
      const label = agentProgressLabel(envelope.event);
      if (
        label !== null &&
        (await canProjectAgentEvent(raw.input, raw.stream, raw.session))
      ) {
        await writeRecord(raw.writer, raw.input.afterSequence, {
          kind: "progress",
          sequence:
            raw.stream.step * STEP_SEQUENCE_SIZE + envelope.sequence + 1,
          label,
        });
      }
      continue;
    }
    const assembled = applyAgentMessageAssemblyEvent(
      assembly,
      envelope.event.finalMessage
        ? { kind: "completed", text: envelope.event.text }
        : { kind: "delta", text: envelope.event.text },
    );
    if (!assembled.ok)
      return {
        buffer,
        assembly,
        projectedText,
        kind: "stopped",
      };
    assembly = assembled.value.state;
    const projection = projectReplyStreamText(assembly.canonicalText);
    if (!projection.ok)
      return {
        buffer,
        assembly,
        projectedText,
        kind: "stopped",
      };
    if (projection.value.kind !== "reply") continue;
    if (!projection.value.text.startsWith(projectedText))
      return {
        buffer,
        assembly,
        projectedText,
        kind: "stopped",
      };
    const delta = projection.value.text.slice(projectedText.length);
    if (delta.length === 0) continue;
    if (!(await canProjectAgentEvent(raw.input, raw.stream, raw.session)))
      continue;
    projectedText = projection.value.text;
    await writeRecord(raw.writer, raw.input.afterSequence, {
      kind: "assistant_text_delta",
      sequence: raw.stream.step * STEP_SEQUENCE_SIZE + envelope.sequence + 1,
      text: delta,
    });
  }
}

function agentProgressLabel(
  event: Exclude<AgentEvent, { type: "agent_message" }>,
): string | null {
  switch (event.type) {
    case "agent_tool_use":
    case "custom_tool_use":
      return `Using ${event.tool}.`;
    case "status":
      switch (event.state) {
        case "starting":
          return "Starting…";
        case "running":
          return "Working…";
        case "waiting_input":
          return "Waiting for input.";
        case "waiting_approval":
          return "Waiting for approval.";
        default:
          return assertNever(event.state);
      }
    case "done":
    case "error":
      return null;
    default:
      return assertNever(event);
  }
}

export async function canProjectAgentEvent(
  input: Pick<
    StreamInput,
    | "env"
    | "placement"
    | "scope"
    | "conversationId"
    | "requestAuthority"
    | "controlSessionId"
  >,
  stream: Pick<ConversationStream, "sessionId" | "turnId">,
  session: Pick<SessionActor, "readSessionTurnFlowBinding">,
): Promise<boolean> {
  const account = await input.placement.accountAccess.checkUser({
    userId: input.scope.userId,
    authority: {
      kind: "authenticated_session",
      nativeSessionId: input.controlSessionId,
    },
    action: "replay",
  });
  if (!account.ok) return false;
  if (
    !(await authorizeSessionTurnOrigin(
      input.env.DB,
      input.placement.database,
      input.scope.organisationId,
      stream.sessionId,
      stream.turnId,
    ))
  )
    return false;
  if (
    (await authorizeConversation(
      input.placement.database,
      input.scope,
      input.conversationId,
    )) === null
  )
    return false;
  const persisted = await session.readSessionTurnFlowBinding({
    requestingOrganisationId: input.scope.organisationId,
    sessionId: stream.sessionId,
    turnId: stream.turnId,
  });
  if (!persisted.ok) return false;
  const binding = await FlowBinding.restore(persisted.value);
  if (!binding.ok) return false;
  const access = await authorizeConversation(
    input.placement.database,
    input.scope,
    input.conversationId,
  );
  if (
    access === null ||
    (access.access.kind === "workspace_canvas" &&
      !workspaceCanvasLabelAllowsReaders(binding.value.flowLabel))
  )
    return false;
  const decision = await decideChatFlowDelivery(
    input.placement.database,
    input.placement.accountAccess,
    binding.value,
    input.requestAuthority,
  );
  return (
    decision.kind === "allow" &&
    (await authorizeSessionTurnOrigin(
      input.env.DB,
      input.placement.database,
      input.scope.organisationId,
      stream.sessionId,
      stream.turnId,
    ))
  );
}

async function waitForConversationAdvance(
  input: StreamInput,
  step: number,
): Promise<boolean> {
  const deadline = Date.now() + CONVERSATION_OBSERVATION_MS;
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    const stored = await readConversationStatus(
      input.placement.database,
      input.scope,
      input.conversationId,
    );
    if (
      stored === null ||
      stored.work.kind !== "running" ||
      stored.work.requestId !== input.requestId ||
      stored.work.stream.step !== step
    )
      return true;
    await scheduler.wait(
      backoffDelay(
        Math.min(attempt, 3),
        250,
        Math.max(0, deadline - Date.now()),
      ),
    );
  }
  return false;
}

async function waitForConversationStateChange(
  input: StreamInput,
  state: "cancelling",
): Promise<boolean> {
  const deadline = Date.now() + CONVERSATION_OBSERVATION_MS;
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    const stored = await readConversationStatus(
      input.placement.database,
      input.scope,
      input.conversationId,
    );
    if (
      stored === null ||
      stored.work.kind !== state ||
      stored.work.requestId !== input.requestId
    )
      return true;
    await scheduler.wait(
      backoffDelay(
        Math.min(attempt, 3),
        250,
        Math.max(0, deadline - Date.now()),
      ),
    );
  }
  return false;
}

function turnId(record: SessionTurnStreamRecord): string {
  return record.kind === "event" ? record.envelope.turnId : record.turnId;
}

async function writeFailure(
  writer: Writer,
  afterSequence: number,
  sequence: number,
  message: string,
): Promise<void> {
  await writeRecord(writer, afterSequence, {
    kind: "failed",
    sequence,
    message,
  });
}

async function writeRecord(
  writer: Writer,
  afterSequence: number,
  record: PortalChatStreamRecord,
): Promise<void> {
  if (record.sequence <= afterSequence) return;
  await writer.write(new TextEncoder().encode(`${JSON.stringify(record)}\n`));
}

async function closeWriter(writer: Writer): Promise<void> {
  try {
    await writer.close();
  } catch {
    // The browser may close a stream after navigation or reconnection.
  }
}
