import type { EmbeddedHarnessConstructionInput } from "./embedded-harness";

/**
 * The answer text that a turn already wrote as answer deltas, read again
 * after a restart. A harness ends the turn with a completed answer that is
 * the exact join of all its deltas, because every reader assembles the
 * deltas and checks the completed text against them.
 */
export function persistedAnswerDeltas(
  input: EmbeddedHarnessConstructionInput,
): string {
  if (input.source.kind !== "resume_turn" || input.persistence.kind !== "actor")
    return "";
  let text = "";
  for (const row of input.persistence.storage.sql
    .exec<{ text: string | null }>(
      `SELECT json_extract(payload, '$.event.text') AS text FROM turn_delivery_segment
        WHERE session_id = ? AND turn_id = ?
          AND json_extract(payload, '$.event.type') = 'agent_message'
          AND json_extract(payload, '$.event.finalMessage') = 0
        ORDER BY sequence`,
      input.sessionId,
      input.turnLease.turn.turnId,
    )
    .toArray())
    text += row.text ?? "";
  return text;
}
