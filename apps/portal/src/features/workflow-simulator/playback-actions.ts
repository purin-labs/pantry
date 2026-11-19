import type { BakeryPlaybackAction } from "@purin-labs/bakery-model/bakery-surface";
import {
  activeRun,
  applySimulatorReplayAction,
  simulatorPlaybackSnapshot,
  type SimulatorState,
} from "./simulator-state.ts";
import { recordingReplayView, recordingReplayStart } from "@purin-labs/production-simulation/simulator/playback-state";
import { physicsEvents } from "@purin-labs/production-simulation/recipes/bakery/physics-playback";
import { assertNever } from "@purin-labs/std";
type PlaybackActionResult =
  | Readonly<{ kind: "applied"; state: SimulatorState }>
  | Readonly<{ kind: "unavailable"; message: string }>;

export function playbackAvailable(state: SimulatorState): boolean {
  return simulatorPlaybackSnapshot(state).end > 0;
}

export function applyPlaybackAction(
  action: BakeryPlaybackAction,
  state: SimulatorState,
): PlaybackActionResult {
  if (
    !playbackAvailable(state) &&
    action.kind !== "pause" &&
    action.kind !== "speed"
  )
    return {
      kind: "unavailable",
      message: "Open a playable shift, rehearsal or production run first.",
    };
  const snapshot = simulatorPlaybackSnapshot(state);
  switch (action.kind) {
    case "play":
      return {
        kind: "applied",
        state: applySimulatorReplayAction(
          {
            kind: "frameUpdated",
            time: snapshot.time >= snapshot.end ? 0 : snapshot.time,
            playback: "playing",
          },
          state,
        ),
      };
    case "pause":
      return {
        kind: "applied",
        state: applySimulatorReplayAction(
          { kind: "frameUpdated", time: snapshot.time, playback: "paused" },
          state,
        ),
      };
    case "restart":
      return {
        kind: "applied",
        state: applySimulatorReplayAction({ kind: "goTo", time: 0 }, state),
      };
    case "seek":
      if (action.seconds > snapshot.end)
        return {
          kind: "unavailable",
          message: "The requested time is outside the current run.",
        };
      return {
        kind: "applied",
        state: applySimulatorReplayAction(
          { kind: "goTo", time: action.seconds },
          state,
        ),
      };
    case "speed": {
      const next = applySimulatorReplayAction(
        { kind: "chooseSpeed", speed: action.speed },
        state,
      );
      if (simulatorPlaybackSnapshot(next).speed !== action.speed)
        return {
          kind: "unavailable",
          message: "That speed is unavailable for this playback mode.",
        };
      return { kind: "applied", state: next };
    }
    case "next_event":
      return {
        kind: "applied",
        state: applySimulatorReplayAction(
          { kind: "goTo", time: nextPlaybackEvent(state) },
          state,
        ),
      };
    default:
      return assertNever(action);
  }
}

function nextPlaybackEvent(state: SimulatorState): number {
  const snapshot = simulatorPlaybackSnapshot(state);
  if (state.workspace.kind === "production") {
    const data = state.workspace.production.data;
    if (data.kind !== "ready") return snapshot.end;
    for (const time of data.run.events)
      if (time > snapshot.time + 0.001) return time;
    return snapshot.end;
  }
  if (state.replay.kind === "workflow") {
    for (const time of activeRun(state).events)
      if (time > snapshot.time + 0.001) return time;
    return snapshot.end;
  }
  const replay = recordingReplayView(state.replay);
  const document = replay.document;
  if (document.kind !== "ready") return snapshot.end;
  const start = recordingReplayStart(document);
  if (snapshot.time < start) return start;
  for (const event of physicsEvents(document.recording))
    if (start + event.time > snapshot.time + 1e-6) return start + event.time;
  return snapshot.end;
}
