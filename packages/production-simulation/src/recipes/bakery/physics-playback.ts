import type {
  PhysicsEvent,
  PhysicsMotion,
  PhysicsReplay,
  PhysicsOutcome,
  PersistentPhysicsMotion,
} from "@purin-labs/bakery-model/bakery-physics";
import { assertNever } from "@purin-labs/std";
import type { WorkcellTaskId } from "./workcell-input.ts";
import {
  COLD_CELL,
  instanceForFixture,
  resourceInstance,
  type ResourceInstance,
  type ResourceInstanceId,
} from "./workcell-instances.ts";

export type PhysicsSceneReplay = PhysicsReplay | PersistentPhysicsMotion;

export function sceneDuration(replay: PhysicsSceneReplay): number {
  return replay.kind === "persistent-physics-motion"
    ? replay.endStep * replay.request.timestep
    : physicsDuration(replay);
}

export function sceneLegAt(
  replay: PhysicsSceneReplay,
  seconds: number,
): Readonly<{
  recording: PhysicsMotion | PersistentPhysicsMotion;
  time: number;
  label: string;
}> {
  return replay.kind === "persistent-physics-motion"
    ? {
        recording: replay,
        time: Math.max(0, Math.min(sceneDuration(replay), seconds)),
        label: "Accepted operation",
      }
    : physicsLegAt(replay, seconds);
}

export type RecordedTransfer = Readonly<{
  id: WorkcellTaskId;
  name: string;
  start: number;
  end: number;
  recording: PhysicsMotion;
}>;

export function physicsTasks(
  replay: PhysicsReplay,
): readonly [RecordedTransfer, ...RecordedTransfer[]] {
  const first = physicsLegAt(replay, 0).recording;
  const loading: RecordedTransfer = {
    id: `cold-tray:${first.request.runId}:transfer-1`,
    name:
      first.request.bakeryTaskId === "table-to-rack"
        ? "Table to rack"
        : "Load oven",
    start: 0,
    end: physicsDuration(first),
    recording: first,
  };
  if (replay.kind === "bakery-physics-recording") return [loading];
  const unloading: RecordedTransfer = {
    id: `cold-tray:${first.request.runId}:transfer-2`,
    name: "Unload oven",
    start: loading.end,
    end: loading.end + physicsDuration(replay.unloading),
    recording: replay.unloading,
  };
  if (replay.kind === "bakery-physics-sequence") return [loading, unloading];
  return [
    loading,
    unloading,
    {
      id: `cold-tray:${first.request.runId}:transfer-3`,
      name: "Table to rack",
      start: unloading.end,
      end: unloading.end + physicsDuration(replay.racking),
      recording: replay.racking,
    },
  ];
}

export function physicsResources(
  replay: PhysicsReplay,
): readonly ResourceInstance[] {
  const binding = COLD_CELL.skills["table-to-rack"];
  const ids = new Set<ResourceInstanceId>([
    binding.arm,
    binding.tool,
    binding.tray,
    binding.cell,
  ]);
  const recording = physicsLegAt(replay, 0).recording;
  for (const geometry of recording.geometry) {
    const id = instanceForFixture(geometry.body, geometry.name);
    if (id !== null) ids.add(id);
  }
  if (recording.fixture.kind !== "rack")
    ids.add(COLD_CELL.skills["table-to-oven"].destination);
  return [...ids].map(resourceInstance);
}

export function physicsOutcome(replay: PhysicsReplay): PhysicsOutcome {
  switch (replay.kind) {
    case "bakery-physics-recording":
      return replay.outcome;
    case "bakery-physics-sequence":
      return replay.unloading.outcome;
    case "bakery-physics-rack-sequence":
      return replay.racking.outcome;
    default:
      return assertNever(replay, "Unexpected physics recording");
  }
}

export type PhysicsReplayEvent = Readonly<{
  time: number;
  label: string;
  event: PhysicsEvent;
}>;

export function physicsDuration(
  recording: PhysicsMotion | PhysicsReplay,
): number {
  if (recording.kind !== "bakery-physics-recording")
    return (
      physicsDuration(recording.loading) +
      physicsDuration(recording.unloading) +
      (recording.kind === "bakery-physics-rack-sequence"
        ? physicsDuration(recording.racking)
        : 0)
    );
  return recording.outcome.step * recording.request.timestep;
}

export function physicsLegAt(
  replay: PhysicsReplay,
  seconds: number,
): Readonly<{ recording: PhysicsMotion; time: number; label: string }> {
  const time = Math.max(0, Math.min(physicsDuration(replay), seconds));
  if (replay.kind === "bakery-physics-recording")
    return { recording: replay, time, label: "Transfer" };
  const boundary = physicsDuration(replay.loading);
  if (time < boundary)
    return { recording: replay.loading, time, label: "Loading" };
  const rackStart = boundary + physicsDuration(replay.unloading);
  if (replay.kind === "bakery-physics-rack-sequence" && time >= rackStart)
    return {
      recording: replay.racking,
      time: time - rackStart,
      label: "To rack",
    };
  return {
    recording: replay.unloading,
    time: time - boundary,
    label: "Unloading",
  };
}

export function physicsEvents(
  replay: PhysicsReplay,
): readonly PhysicsReplayEvent[] {
  if (replay.kind === "bakery-physics-recording")
    return replay.events.map(
      replayEvent.bind(null, replay.request.timestep, 0, ""),
    );
  return [
    ...replay.loading.events.map(
      replayEvent.bind(null, replay.loading.request.timestep, 0, "Loading · "),
    ),
    ...replay.unloading.events.map(
      replayEvent.bind(
        null,
        replay.unloading.request.timestep,
        physicsDuration(replay.loading),
        "Unloading · ",
      ),
    ),
    ...(replay.kind === "bakery-physics-rack-sequence"
      ? replay.racking.events.map(
          replayEvent.bind(
            null,
            replay.racking.request.timestep,
            physicsDuration(replay.loading) + physicsDuration(replay.unloading),
            "To rack · ",
          ),
        )
      : []),
  ];
}

function replayEvent(
  timestep: number,
  offset: number,
  prefix: string,
  event: PhysicsEvent,
): PhysicsReplayEvent {
  return {
    time: offset + event.step * timestep,
    label: prefix + event.label,
    event,
  };
}
