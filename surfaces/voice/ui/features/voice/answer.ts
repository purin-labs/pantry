import type { Chat } from "@purin-labs/control-api/portal/chat";

import type { ChatStreamState } from "../../../../../apps/portal/src/features/chat/delivery";
import { finishedSentences, spokenAnswer } from "./command";
import type { VoiceSession } from "./session";

/** A spoken command waits for its answer, which is spoken as its sentences arrive. */
export type VoiceAnswerWait = {
  readonly conversationId: Chat["id"];
  readonly requestId: string;
  readonly lastAssistantId: string | null;
  spoken: readonly string[];
};

/**
 * Speaks what is new in the answer to a spoken command. Returns the wait that
 * goes on, or null when the answer is done or the chat shows another
 * conversation.
 */
export function speakVoiceAnswer(
  voice: VoiceSession,
  waiting: VoiceAnswerWait,
  conversation: Chat | null,
  stream: ChatStreamState,
): VoiceAnswerWait | null {
  if (conversation?.id !== waiting.conversationId) {
    voice.releaseAnnouncements();
    return null;
  }
  // After the first sentence, a closing sentence plays after it and does not cut it.
  const finish = (sentence: string): null => {
    if (waiting.spoken.length === 0) voice.speak(sentence);
    else voice.finishSpeech(sentence);
    return null;
  };
  if (conversation.work.kind === "awaiting_permission")
    return finish("This needs your approval on the screen.");
  if (conversation.work.kind === "failed")
    return finish("That failed. Look at the screen.");
  if (
    conversation.work.kind === "ready" &&
    conversation.pendingInputs.length === 0
  ) {
    const answer = lastAssistantEvent(conversation);
    if (answer === null || answer.eventId === waiting.lastAssistantId)
      return waiting;
    return finish(spokenAnswer(answer.text, waiting.spoken));
  }
  // The stream of an earlier turn can still run, so only this command's request counts.
  if (
    (stream.kind !== "active" && stream.kind !== "reconnecting") ||
    stream.requestId !== waiting.requestId
  )
    return waiting;
  const sentences = finishedSentences(stream.text);
  const next = sentences.slice(waiting.spoken.length).join(" ");
  if (next.length > 0 && voice.speakPart(next)) waiting.spoken = sentences;
  return waiting;
}

export function lastAssistantEvent(
  conversation: Chat,
): Readonly<{ eventId: string; text: string }> | null {
  for (let index = conversation.timeline.length - 1; index >= 0; index -= 1) {
    const event = conversation.timeline[index];
    if (event?.kind === "assistant") return event;
  }
  return null;
}
