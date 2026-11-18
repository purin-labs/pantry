import { readExample } from "./rehearsal-examples.ts";
import type { PhysicsReplay } from "@seams/bakery-model/bakery-physics";
import type { BakeryWorkcellPreparation } from "@seams/bakery-model/bakery-surface";
import {
  activeRun,
  applyBakeryWorkspaceAction,
  applySimulatorReplayAction,
  type SimulatorState,
} from "./simulator-state.ts";
import { recordingReplayView } from "@seams/production-simulation/simulator/playback-state";
import { parseRehearsalFile } from "@seams/production-simulation/simulator/rehearsal-file";
import {
  editRehearsalWorkcells,
  type ProductionWorkcells,
} from "@seams/production-simulation/recipes/bakery/production-workcells";
import {
  rehearsalFromRecording,
  rehearsalSettings,
} from "@seams/production-simulation/simulator/rehearsal-presets";

// Chat preparation opens a one-tray rehearsal on the production scheduler.
// The tray keeps its request but starts without results, so simulate_workcell
// has a step to run; the dispatch time becomes its earliest staging time.
export type PreparedWorkcell = Readonly<{
  plan: ProductionWorkcells;
  notice: string;
}>;
export type WorkcellPreparationResult =
  | Readonly<{ kind: "ready"; prepared: PreparedWorkcell }>
  | Readonly<{ kind: "invalid"; message: string }>;

export function canPrepareWorkcell(state: SimulatorState): boolean {
  const save = state.workspace.runSaves.rehearsal;
  return (
    state.workspace.kind !== "production" &&
    state.browserJob.kind !== "running" &&
    state.browserJob.kind !== "loading" &&
    state.workspace.runSaveProposal.kind === "none" &&
    save.kind !== "saving" &&
    save.kind !== "outcome-unknown" &&
    save.kind !== "saved-readback-failed"
  );
}

export async function prepareWorkcell(
  state: SimulatorState,
  preparation: BakeryWorkcellPreparation,
): Promise<WorkcellPreparationResult> {
  if (!canPrepareWorkcell(state))
    return {
      kind: "invalid",
      message:
        "Finish or preserve the current run and its save outcome before preparing another rehearsal.",
    };
  let recording: PhysicsReplay;
  let source: string;
  switch (preparation.source) {
    case "recording": {
      const document = recordingReplayView(state.replay).document;
      if (document.kind !== "ready")
        return {
          kind: "invalid",
          message: "Open a recording before preparing it as a rehearsal.",
        };
      recording = document.recording;
      source = "the open recording";
      break;
    }
    case "example": {
      const parsed = parseRehearsalFile(await readExample(preparation.example));
      if (parsed.kind !== "recording")
        return {
          kind: "invalid",
          message: "The selected example is not a recording.",
        };
      recording = parsed.recording;
      source = `the ${preparation.example} example`;
      break;
    }
  }
  const recorded = await rehearsalFromRecording(
    rehearsalSettings(activeRun(state).settings),
    recording,
  );
  if (recorded.kind === "rejected")
    return { kind: "invalid", message: recorded.message };
  const cleared = await editRehearsalWorkcells(recorded.plan, {
    kind: "reset",
    batchId: "A",
  });
  if (cleared.kind === "rejected")
    return { kind: "invalid", message: cleared.message };
  const started =
    preparation.dispatchSeconds === 0
      ? cleared
      : await editRehearsalWorkcells(cleared.plan, {
          kind: "start",
          operationId: "batch:A:native:1",
          earliestStartSeconds: preparation.dispatchSeconds,
        });
  if (started.kind === "rejected")
    return { kind: "invalid", message: started.message };
  return {
    kind: "ready",
    prepared: {
      plan: started.plan,
      notice: `Tray A prepared from ${source}. Its steps have no results yet; simulate each step, then review and accept it.`,
    },
  };
}

// Preparation is one atomic step even when it opens the workspace too.
export function applyWorkcellPreparation(
  state: SimulatorState,
  prepared: PreparedWorkcell,
): SimulatorState {
  if (!canPrepareWorkcell(state)) return state;
  let next =
    state.workspace.kind === "rehearsal"
      ? state
      : applyBakeryWorkspaceAction({ kind: "openRehearsal" }, state);
  next = applySimulatorReplayAction({ kind: "openRecording" }, next);
  next = applyBakeryWorkspaceAction(
    {
      kind: "openRehearsalRun",
      plan: prepared.plan,
      notice: prepared.notice,
    },
    next,
  );
  if (
    next.workspace.kind !== "production" ||
    next.workspace.production.data.kind !== "ready" ||
    next.workspace.production.data.plan !== prepared.plan
  )
    return state;
  return {
    ...next,
    workspace: {
      ...next.workspace,
      surfaceEpoch: state.workspace.surfaceEpoch + 1,
    },
  };
}
