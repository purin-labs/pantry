import {
  createBakerySurfaceAttachment,
  type BakerySurfaceAttachmentV1,
  type BakerySurfaceCommandResultV1,
  type RejectedBakerySurfaceCommandResultV1,
} from "@purin-labs/bakery-model/bakery-surface";
import type { SimulatorState } from "./simulator-state.ts";
import type { Variant } from "@purin-labs/type-utils";
import type { PreparedBakerySurfaceCommand } from "./bakery-surface-command-types.ts";
import { staleSurface } from "./bakery-surface-prepare.ts";
import {
  bakerySurfaceContext,
  bakerySurfaceDraftMaterial,
  rejectedCommand,
  runSaveManifest,
} from "./bakery-surface-reads.ts";
export { commitBakerySurfaceCommand } from "./bakery-surface-commit.ts";
export { prepareBakerySurfaceCommand } from "./bakery-surface-prepare.ts";
export { provideShiftFloorPlan } from "./bakery-surface-reads.ts";
export type {
  BakerySurfaceCommandOrigin,
  BakerySurfaceCommandTransition,
  PreparedBakerySurfaceCommand,
} from "./bakery-surface-command-types.ts";

export function validatePreparedBakerySurfaceRead(
  state: SimulatorState,
  prepared: Variant<
    PreparedBakerySurfaceCommand,
    "read" | "saved_runs" | "save_inspection" | "scenario_inspection"
  >,
): RejectedBakerySurfaceCommandResultV1 | null {
  const stale = staleSurface(state, prepared.command);
  if (stale !== null) return stale;
  if (
    prepared.kind === "scenario_inspection" &&
    state.workspace.scenarioSaveProposal !== prepared.source
  )
    return rejectedCommand(
      prepared.command.kind,
      "stale_surface",
      "The scenario save changed during inspection. Inspect its current status again.",
    );
  if (
    prepared.kind === "save_inspection" &&
    state.workspace.runSaves[prepared.command.runKind] !== prepared.source
  )
    return rejectedCommand(
      prepared.command.kind,
      "stale_surface",
      "The save attempt changed during inspection. Inspect its current status again.",
    );
  if (
    prepared.kind === "read" &&
    prepared.command.kind === "read_draft" &&
    (prepared.draft === null ||
      prepared.draftMaterial !== bakerySurfaceDraftMaterial(state) ||
      prepared.draft.reference.revision !== state.scenario.draftRevision)
  )
    return rejectedCommand(
      "read_draft",
      "stale_draft",
      "The Kitchen draft changed while its exact values were being read.",
    );
  return null;
}

export async function captureBakerySurface(
  state: SimulatorState,
): Promise<BakerySurfaceAttachmentV1> {
  return createBakerySurfaceAttachment(await bakerySurfaceContext(state));
}

export async function bakerySurfaceCommandSucceeded(
  state: SimulatorState,
  prepared: PreparedBakerySurfaceCommand,
): Promise<Variant<BakerySurfaceCommandResultV1, "succeeded">> {
  const surface = await captureBakerySurface(state);
  if (prepared.kind === "file")
    return {
      kind: "succeeded",
      command: "file_action",
      surface,
      output: {
        kind: "file",
        action: prepared.prepared.kind,
        manifest: prepared.manifest,
      },
    };
  if (prepared.kind === "scenario_inspection")
    return {
      kind: "succeeded",
      command: "inspect_scenario_save",
      surface,
      output: {
        kind: "scenario_save_inspection",
        save: prepared.inspection,
      },
    };
  if (prepared.kind === "save_inspection")
    return {
      kind: "succeeded",
      command: "inspect_run_save",
      surface,
      output: {
        kind: "run_save_inspection",
        runKind: prepared.command.runKind,
        save: prepared.inspection,
      },
    };
  if (prepared.kind === "saved_runs")
    return {
      kind: "succeeded",
      command: "list_saved_runs",
      surface,
      output: {
        kind: "saved_runs",
        runKind: prepared.command.runKind,
        cursor: prepared.command.cursor,
        page: prepared.page,
      },
    };
  if (prepared.command.kind === "read_draft") {
    if (prepared.kind !== "read" || prepared.draft === null)
      throw new Error("bakery_surface_draft_result_invalid");
    return {
      kind: "succeeded",
      command: "read_draft",
      surface,
      output: { kind: "draft", draft: prepared.draft },
    };
  }
  if (prepared.command.kind === "query_tasks") {
    if (prepared.kind !== "read" || prepared.tasks === null)
      throw new Error("bakery_surface_task_query_result_invalid");
    return {
      kind: "succeeded",
      command: "query_tasks",
      surface,
      output: { kind: "task_query", tasks: prepared.tasks },
    };
  }
  if (prepared.kind === "run_save") {
    return {
      kind: "succeeded",
      command: "prepare_run_save",
      surface,
      output: {
        kind: "run_save_proposal",
        manifest: runSaveManifest(prepared.prepared),
      },
    };
  }
  if (prepared.kind === "scenario_save")
    return {
      kind: "succeeded",
      command: "prepare_scenario_save",
      surface,
      output: {
        kind: "scenario_save_proposal",
        manifest: prepared.manifest,
      },
    };
  return {
    kind: "succeeded",
    command: prepared.command.kind,
    surface,
    output: { kind: "surface" },
  };
}
