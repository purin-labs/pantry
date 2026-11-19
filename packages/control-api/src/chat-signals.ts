import { isRecord } from "@purin-labs/std";

/** Something that the chat page shows changed. */
export const CHAT_SIGNAL = "chat_changed";

/**
 * The agent published a browser command for the user, such as a Pantry
 * Kitchen effect (Plan 87 phase 3). The page reads its pending commands at
 * once instead of at its next poll.
 */
export const SURFACE_EFFECT_SIGNAL = "surface_effect";

/**
 * A signal on the chat signal socket. It carries no content and names
 * nothing; the page reads the changed state through the checked chat routes.
 */
export type ChatSignal = Readonly<{
  kind: typeof CHAT_SIGNAL | typeof SURFACE_EFFECT_SIGNAL;
}>;

export function parseChatSignal(raw: unknown): ChatSignal | null {
  let value: unknown;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.kind === CHAT_SIGNAL) return { kind: CHAT_SIGNAL };
  if (value.kind === SURFACE_EFFECT_SIGNAL)
    return { kind: SURFACE_EFFECT_SIGNAL };
  return null;
}
