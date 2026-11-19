import type { ChannelId } from "./ids";
import {
  containsInternalModelProtocol,
  detectSensitiveEntities,
  isSlackDirectMessage,
  trailingInternalModelProtocolStart,
} from "./redaction";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

/**
 * Screens a streamed answer part by part before it reaches a Slack thread. It
 * releases the longest prefix that cannot become a sensitive value or a marker
 * of the internal model protocol, and it holds the stream for good once one
 * appears. `screenTextForSurface` still screens the whole final text.
 *
 * `pending` is the end of the text that may still become such a value.
 * `context` is the end of the released text: a value can start in text that
 * was already released, for example a token after "Bearer", so the check
 * reads the context with the new text.
 */
export type IncrementalScreenState =
  | { kind: "streaming"; pending: string; context: string }
  | { kind: "held" }
  | { kind: "complete" };

type IncrementalScreenDecision =
  | { action: "release"; text: string; state: IncrementalScreenState }
  | { action: "buffer"; state: IncrementalScreenState }
  | {
      action: "hold";
      state: Variant<IncrementalScreenState, "held">;
    };

const MAX_CANDIDATE_CHARS = 256;
const CONTEXT_CHARS = 256;
const HELD: IncrementalScreenDecision = {
  action: "hold",
  state: { kind: "held" },
};

export function initialIncrementalScreenState(): IncrementalScreenState {
  return { kind: "streaming", pending: "", context: "" };
}

export function screenIncrementalOutput(input: {
  state: IncrementalScreenState;
  chunk: string;
  channelId: ChannelId;
  terminal: boolean;
}): IncrementalScreenDecision {
  switch (input.state.kind) {
    case "held":
      return HELD;
    case "complete":
      return { action: "buffer", state: input.state };
    case "streaming":
      return screenStreamingState(
        input.state,
        input.chunk,
        input.channelId,
        input.terminal,
      );
    default:
      return assertNever(input.state);
  }
}

function screenStreamingState(
  state: Variant<IncrementalScreenState, "streaming">,
  chunk: string,
  channelId: ChannelId,
  terminal: boolean,
): IncrementalScreenDecision {
  const combined = `${state.pending}${chunk}`;
  const internalProtocolStart = trailingInternalModelProtocolStart(combined);
  if (
    containsInternalModelProtocol(combined) ||
    (terminal && internalProtocolStart < combined.length)
  )
    return HELD;
  if (isSlackDirectMessage(channelId))
    return releasePrivateOutput(
      state,
      combined,
      internalProtocolStart,
      terminal,
    );
  const checked = `${state.context}${combined}`;
  for (const entity of detectSensitiveEntities(checked))
    if (entity.end > state.context.length) return HELD;
  if (terminal)
    return combined.length === 0
      ? { action: "buffer", state: { kind: "complete" } }
      : { action: "release", text: combined, state: { kind: "complete" } };
  const candidateStart = Math.min(
    possibleCandidateStart(combined),
    internalProtocolStart,
  );
  const pending = combined.slice(candidateStart);
  if (pending.length > MAX_CANDIDATE_CHARS) return HELD;
  return released(state, combined.slice(0, candidateStart), pending);
}

/** Releases `text` and keeps `pending` back, with the context after it. */
function released(
  state: Variant<IncrementalScreenState, "streaming">,
  text: string,
  pending: string,
): IncrementalScreenDecision {
  const next: Variant<IncrementalScreenState, "streaming"> = {
    kind: "streaming",
    pending,
    context: `${state.context}${text}`.slice(-CONTEXT_CHARS),
  };
  return text.length === 0
    ? { action: "buffer", state: next }
    : { action: "release", text, state: next };
}

/** The start of the last token, or of a payment number that may still grow. */
function possibleCandidateStart(text: string): number {
  return Math.min(
    lastWhitespaceIndex(text) + 1,
    trailingPaymentCandidateStart(text),
  );
}

function lastWhitespaceIndex(text: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const character = text[index];
    if (character !== undefined && /\s/u.test(character)) return index;
  }
  return -1;
}

function trailingPaymentCandidateStart(text: string): number {
  let index = text.length;
  let digits = 0;
  while (index > 0) {
    const character = text[index - 1];
    if (character === undefined || !/[0-9 -]/u.test(character)) break;
    if (/\d/u.test(character)) digits += 1;
    index -= 1;
  }
  return digits === 0 ? text.length : index;
}

function releasePrivateOutput(
  state: Variant<IncrementalScreenState, "streaming">,
  combined: string,
  internalProtocolStart: number,
  terminal: boolean,
): IncrementalScreenDecision {
  if (internalProtocolStart < combined.length)
    return released(
      state,
      combined.slice(0, internalProtocolStart),
      combined.slice(internalProtocolStart),
    );
  if (!terminal) return released(state, combined, "");
  return combined.length === 0
    ? { action: "buffer", state: { kind: "complete" } }
    : { action: "release", text: combined, state: { kind: "complete" } };
}
