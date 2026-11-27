import { parseNativeContinuation } from "../recipes/bakery/native-continuation.ts";
import {
  parsePhysicsReplay,
  isCompletedLoading,
  type PhysicsSequence,
  type PhysicsReplay,
} from "@purin-labs/bakery-model/bakery-physics";
import { MAX_RUN_FILE_BYTES } from "@purin-labs/bakery-model/bakery-run-snapshot";

// Saved rehearsal runs, including earlier single and multi-tray formats, open
// in Multi-tray rehearsal, which converts earlier formats.
export const SAVED_RUN_MESSAGE =
  "This is a saved rehearsal run. Open it from Multi-tray rehearsal → Files, which also converts earlier formats.";

type RehearsalFile =
  | Readonly<{ kind: "saved-run" }>
  | Readonly<{ kind: "loading-handoff"; recording: PhysicsSequence["loading"] }>
  | Readonly<{ kind: "recording"; recording: PhysicsReplay }>
  | Readonly<{ kind: "rejected"; message: string }>;

export function parseRehearsalFile(text: string): RehearsalFile {
  if (new TextEncoder().encode(text).length > MAX_RUN_FILE_BYTES) {
    return {
      kind: "rejected",
      message: "Choose a file smaller than 16 MiB plus 64 KiB.",
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      kind: "rejected",
      message: "Choose a recording JSON file.",
    };
  }
  if (typeof raw !== "object" || raw === null || !("kind" in raw)) {
    return {
      kind: "rejected",
      message: "Choose a recording downloaded with Save recording only.",
    };
  }
  if (raw.kind === "bakery-native-rack-handoff") {
    try {
      const handoff = parseNativeContinuation(text);
      return { kind: "recording", recording: handoff.predecessor };
    } catch (error) {
      return {
        kind: "rejected",
        message:
          error instanceof Error ? error.message : "Invalid retrieval handoff.",
      };
    }
  }
  if (raw.kind === "bakery-physics-handoff") {
    if (
      !("schemaVersion" in raw) ||
      (raw.schemaVersion !== 1 &&
        raw.schemaVersion !== 2 &&
        raw.schemaVersion !== 3) ||
      !("recording" in raw)
    )
      return {
        kind: "rejected",
        message: "Choose a completed loading handoff from bakery-native load.",
      };
    // Only the recording is projected here. MuJoCo validates the native state when resuming the original file.
    const result = parsePhysicsReplay(JSON.stringify(raw.recording));
    if (result.kind === "rejected") return result;
    if (
      result.recording.kind !== "bakery-physics-recording" ||
      !isCompletedLoading(result.recording)
    )
      return {
        kind: "rejected",
        message: "A loading handoff requires completed nominal oven loading.",
      };
    return { kind: "loading-handoff", recording: result.recording };
  }
  if (
    raw.kind === "bakery-rehearsal-run" ||
    raw.kind === "bakery-orchestration-run" ||
    raw.kind === "bakery-workcell-experiment"
  )
    return { kind: "saved-run" };
  if (
    raw.kind !== "bakery-physics-recording" &&
    raw.kind !== "bakery-physics-sequence" &&
    raw.kind !== "bakery-physics-rack-sequence"
  ) {
    return {
      kind: "rejected",
      message:
        "Choose a motion recording or a completed loading handoff. Simulator requests and in-progress checkpoints cannot be opened here.",
    };
  }
  const result = parsePhysicsReplay(text);
  if (result.kind === "rejected") return result;
  return { kind: "recording", recording: result.recording };
}
