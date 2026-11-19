import type { PersistentPhysicsScene } from "@purin-labs/bakery-model/bakery-physics";
import type { OvenLiveFrame } from "@purin-labs/production-simulation/runs/oven-live-physics";
import type { OvenRecordings, RecordingArchive } from "@purin-labs/production-simulation/runs/oven-recordings";
import type { OvenSave } from "@purin-labs/production-simulation/runs/oven-run-file";

declare const idle: Extract<OvenLiveFrame, { purpose: "idle" }>;
declare const idleWithoutContacts: Omit<typeof idle, "contacts">;
// @ts-expect-error Every idle frame declares recorded or unavailable contact coverage.
export const missingIdleContacts: OvenLiveFrame = idleWithoutContacts;
declare const handoff: Extract<
  OvenLiveFrame,
  { purpose: "admission" | "removal" }
>;
// @ts-expect-error Idle poses have no operation identity.
export const idleWithTask: OvenLiveFrame = { ...idle, task: "invented" };
// @ts-expect-error Handoff endpoints cannot become one continuous motion.
export const continuousHandoff: OvenLiveFrame = {
  ...handoff,
  motion: idle.motion,
};
// @ts-expect-error An operation needs a real task and attempt-relative clock.
export const idleAsOperation: OvenLiveFrame = { ...idle, purpose: "operation" };

declare const reader: OvenRecordings;
declare const save: OvenSave;
declare const archive: RecordingArchive;
declare const scene: PersistentPhysicsScene;
declare const rawSave: unknown;
declare const rawScene: unknown;
// @ts-expect-error A recording query requires an admitted saved document.
void reader.latest(rawSave, scene, 0);
// @ts-expect-error Scene identity must pass the retained-scene boundary parser.
void reader.operation(archive, rawScene, "batch-A#0/oven-load");
// @ts-expect-error A recording query cannot omit its committed-time bound.
void reader.latest(archive, scene);

// @ts-expect-error Artifact access is required at the storage boundary.
export const missingArtifactReader: RecordingArchive = {
  document: save.document,
};

declare const espressoCell: import("@purin-labs/bakery-model/bakery-physics").PersistentEspressoCell;
// @ts-expect-error An espresso fixture cannot acquire robot configuration through a spread.
export const espressoWithRobot: import("@purin-labs/bakery-model/bakery-physics").PersistentCell =
  { ...espressoCell, robot: "fairino-fr10" };
