import type { TransientModelTurnError } from "./types";

/** The usage of an attempt that ended before any provider request. */
export const KNOWN_ZERO_MODEL_USAGE = {
  modelCalls: 0,
  callsWithUsage: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
} as const;

export function transientModelAdmissionError(
  error: unknown,
): TransientModelTurnError {
  return {
    code: error instanceof Error ? error.message : "goal_admission_unavailable",
    // Admission precedes provider dispatch, so this attempt has known zero usage.
    modelUsage: KNOWN_ZERO_MODEL_USAGE,
  };
}

export function projectItemForSnapshot(
  digest: string,
  item: import("../../context/assembly").ContextBundle["items"][number],
): boolean {
  return (
    item.source.kind === "project_observation" &&
    item.source.snapshotDigest === digest
  );
}
