import { isRecord } from "@seams/std";

import type { ChatEffort } from "./chat.ts";

/**
 * The reasoning effort that an owner or admin chose for Slack answers. `null`
 * is no choice: a Slack answer then uses the inference source's own level. A
 * choice that the source's model does not offer also leaves that level.
 */
export type SlackReasoningEffortView = Readonly<{
  effort: ChatEffort | null;
}>;

export function isChatEffort(raw: unknown): raw is ChatEffort {
  return raw === "low" || raw === "medium" || raw === "high";
}

export function parseSlackReasoningEffortView(
  raw: unknown,
): SlackReasoningEffortView | null {
  if (!isRecord(raw)) return null;
  if (raw.effort === null) return { effort: null };
  return isChatEffort(raw.effort) ? { effort: raw.effort } : null;
}
