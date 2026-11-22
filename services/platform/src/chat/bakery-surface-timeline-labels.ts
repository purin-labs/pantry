// The tool rows and summaries that a chat shows for Kitchen effects.
import {
  isRehearsalChange,
  type BakeryStoreInteriorAction,
} from "@purin-labs/bakery-model/bakery-surface";
import type {
  BakeryProductionEdit,
  BakeryRehearsalEdit,
  BakerySurfaceEditOperation,
} from "@purin-labs/bakery-model/bakery-surface";
import { type BakerySurfaceTimelineEvent } from "@purin-labs/area-kitchen/server/actors/bakery-surface-effect";
import { assertNever } from "@purin-labs/std";
import type { ChatReceiptReference, ChatToolView } from "@purin-labs/control-api";
import {
  pageCommandAction,
  pageCommandDestination,
  pageCommandObject,
  pageCommandSummary,
} from "./page-command-labels";

export function bakerySurfaceTimelineTool(
  event: BakerySurfaceTimelineEvent,
): ChatToolView {
  const base = {
    toolCallId: event.effect.effectId,
    destination: "Kitchen",
    detailsExpandable: true,
  } as const;
  switch (event.effect.command.kind) {
    case "page_command":
      return {
        ...base,
        destination: pageCommandDestination(event.effect.command),
        action: pageCommandAction(event.effect.command),
        object: pageCommandObject(event.effect.command),
        risk: "read",
      };
    case "prepare_context":
      return {
        ...base,
        action: "Load Kitchen",
        object: "Current browser workspace",
        risk: "read",
      };
    case "prepare_layout":
      return {
        ...base,
        action: "Prepare Kitchen rack placement",
        object: `X ${event.effect.command.xMm}, Y ${event.effect.command.yMm} mm`,
        risk: "write",
      };
    case "prepare_workcell":
      return {
        ...base,
        action: "Prepare robot rehearsal",
        object: event.effect.command.preparation.source,
        risk: "write",
      };
    case "edit_rehearsal":
      return {
        ...base,
        action: "Edit Kitchen rehearsal trays",
        object: rehearsalEditObject(event.effect.command.edit),
        risk: "write",
      };
    case "edit_production":
      return {
        ...base,
        action: "Edit Kitchen production draft",
        object: productionEditObject(event.effect.command.edit),
        risk: "write",
      };
    case "preview_production":
      return {
        ...base,
        action: "Preview Kitchen production draft",
        object: "Current draft",
        risk: "write",
      };
    case "apply_production":
      return {
        ...base,
        action: "Apply Kitchen production preview",
        object: "Fresh run with new native requests",
        risk: "write",
      };
    case "stop_simulation":
      return {
        ...base,
        action: "Stop Kitchen browser simulation",
        object: event.effect.command.simulation.operationId,
        risk: "write",
      };
    case "control_workspace_view":
      return {
        ...base,
        action: "Control Kitchen workspace view",
        object: event.effect.command.action.kind,
        risk: "read",
      };
    case "show_production_panel":
      return {
        ...base,
        action: "Open Kitchen production panel",
        object: event.effect.command.panel,
        risk: "read",
      };
    case "control_baseline":
      return {
        ...base,
        action: "Change Kitchen comparison baseline",
        object: event.effect.command.action,
        risk: "write",
      };
    case "control_playback":
      return {
        ...base,
        action: "Control Kitchen playback",
        object: event.effect.command.action.kind,
        risk: "write",
      };
    case "inspect_surface":
      return {
        ...base,
        action: "Inspect Kitchen",
        object: "Current workspace",
        risk: "read",
      };
    case "read_draft":
      return {
        ...base,
        action: "Read Kitchen draft",
        object: "Shift assumptions",
        risk: "read",
      };
    case "query_tasks":
      return {
        ...base,
        action: "Find Kitchen tasks",
        object: event.effect.command.filter.text,
        risk: "read",
      };
    case "set_view": {
      const selection = event.effect.command.view.selection;
      return {
        ...base,
        action: "Navigate Kitchen",
        object: `${selection.kind} ${selection.id}`,
        risk: "write",
      };
    }
    case "prepare_production_control":
      return {
        ...base,
        action: "Prepare production control",
        object: event.effect.command.control.kind,
        risk: "write",
      };
    case "prepare_edit":
      return {
        ...base,
        action: "Prepare Kitchen edit",
        object: "Shift assumptions",
        risk: "write",
      };
    case "run_shift":
      return {
        ...base,
        action: "Run Kitchen shift",
        object: shiftRunObject(event.effect.command.edits),
        risk: "write",
      };
    case "select_item": {
      const selection = event.effect.command.selection;
      return {
        ...base,
        action: "Select in Kitchen",
        object: `${selection.kind} ${selection.id}`,
        risk: "write",
      };
    }
    case "rotate_equipment":
      return {
        ...base,
        action: "Rotate Kitchen equipment",
        object: event.effect.command.applianceId,
        risk: "write",
      };
    case "move_equipment":
      return {
        ...base,
        action: "Move Kitchen equipment",
        object: `${event.effect.command.applianceId} (${event.effect.command.xMm}, ${event.effect.command.zMm}) mm`,
        risk: "write",
      };
    case "toggle_opening":
      return {
        ...base,
        action: event.effect.command.open
          ? "Open Kitchen door or window"
          : "Close Kitchen door or window",
        object: event.effect.command.openingId,
        risk: "write",
      };
    case "select_floor_plan":
      return {
        ...base,
        action: "Switch Kitchen floor plan",
        object: event.effect.command.floorPlan,
        risk: "write",
      };
    case "set_equipment_angle":
      return {
        ...base,
        action: "Angle Kitchen equipment",
        object: `${event.effect.command.applianceId} (${event.effect.command.yawDegrees}°)`,
        risk: "write",
      };
    case "configure_interior":
      return {
        ...base,
        action: "Configure Kitchen interior",
        object: describeInteriorObject(event.effect.command.action),
        risk: "write",
      };
    case "reset_floor_plan":
      return {
        ...base,
        action: "Reset Kitchen floor plan",
        object: event.effect.command.action,
        risk: "write",
      };
    case "start_production":
      return {
        ...base,
        action: "Open Kitchen production",
        object:
          event.effect.command.preset === "one-batch"
            ? "Financier + robot, one batch"
            : "Financier, procedure inputs",
        risk: "write",
      };
    case "compare_shift":
      return {
        ...base,
        action: "Compare Kitchen shifts",
        object:
          event.effect.command.mode === "outage"
            ? "Oven outage"
            : "Normal shift",
        risk: "write",
      };
    case "prepare_run_save":
      return {
        ...base,
        action: "Prepare Kitchen run save",
        object: event.effect.command.name,
        risk: "write",
      };
    case "prepare_scenario_save":
      return {
        ...base,
        action: "Prepare Kitchen scenario save",
        object: event.effect.command.name,
        risk: "write",
      };
    case "file_action":
      return {
        ...base,
        action:
          event.effect.command.action.kind === "import"
            ? "Review attached Kitchen file"
            : "Download Kitchen file",
        object: "Workspace file",
        risk: "read",
      };
    case "inspect_scenario_save":
      return {
        ...base,
        action: "Inspect Kitchen scenario save",
        object: "Scenario copy",
        risk: "read",
      };
    case "inspect_run_save":
      return {
        ...base,
        action: "Inspect Kitchen save outcome",
        object: event.effect.command.runKind,
        risk: "read",
      };
    case "list_saved_runs":
      return {
        ...base,
        action: "List saved Kitchen runs",
        object: event.effect.command.runKind,
        risk: "read",
      };
    case "prepare_run_open":
      return {
        ...base,
        action: "Review saved Kitchen run",
        object: event.effect.command.id,
        risk: "read",
      };
    case "simulate_workcell":
      return {
        ...base,
        action: `Simulate Kitchen ${event.effect.command.mode}`,
        object:
          event.effect.command.schemaVersion === 2
            ? event.effect.command.operationId
            : event.effect.command.attemptId,
        risk: "write",
      };
    case "apply_reviewed_edit":
      return {
        ...base,
        action: "Apply Kitchen edit",
        object: "Shift assumptions",
        risk: "write",
      };
    case "discard_candidate":
      return {
        ...base,
        action: "Discard Kitchen recording candidate",
        object: event.effect.command.candidate.operationId,
        risk: "write",
      };
    case "accept_candidate":
      return {
        ...base,
        action: "Accept Kitchen recording",
        object: event.effect.command.candidate.kind,
        risk: "write",
      };
    default:
      return assertNever(event.effect.command);
  }
}

export function bakerySurfaceTimelineResult(
  effect: BakerySurfaceTimelineEvent,
): {
  readonly outcome: "succeeded" | "failed";
  readonly summary: string;
  readonly receipt: ChatReceiptReference;
} {
  if (effect.terminal.kind !== "settled")
    {throw new Error("surface_timeline_settlement_missing");}
  const outcome = effect.terminal.receipt.outcome;
  if (outcome.kind === "delivery_failed") {
    return {
      outcome: "failed",
      summary: outcome.message,
      receipt: {
        receiptId: `surface_receipt_${effect.effect.effectId}`,
        state: "failed",
        summary: outcome.message,
      },
    };
  }
  if (outcome.kind === "prepared")
    {return {
      outcome: "succeeded",
      summary: "Kitchen browser readiness confirmed.",
      receipt: {
        receiptId: `surface_receipt_${effect.effect.effectId}`,
        state: "succeeded",
        summary: "View ready",
      },
    };}
  if (outcome.kind === "page_rejected")
    return {
      outcome: "failed",
      summary: outcome.message,
      receipt: {
        receiptId: `surface_receipt_${effect.effect.effectId}`,
        state: "failed",
        summary: outcome.message,
      },
    };
  if (outcome.kind === "completed" && outcome.result.kind === "rejected") {
    return {
      outcome: "failed",
      summary: outcome.result.message,
      receipt: {
        receiptId: `surface_receipt_${effect.effect.effectId}`,
        state: "failed",
        summary: outcome.result.message,
      },
    };
  }
  const summary = bakerySurfaceSuccessSummary(effect);
  return {
    outcome: "succeeded",
    summary,
    receipt: {
      receiptId: `surface_receipt_${effect.effect.effectId}`,
      state: "succeeded",
      summary,
    },
  };
}

function rehearsalEditObject(edit: BakeryRehearsalEdit): string {
  switch (edit.kind) {
    case "add_human_transfer":
      return `Review human transfer of tray ${edit.batchId} from cell 1 to cell 2`;
    case "set_ingredients":
      return `Review tray ${edit.batchId} ingredients: ${edit.ingredients.massKg} kg, forward ${edit.ingredients.forwardMm} mm, lateral ${edit.ingredients.lateralMm} mm`;
    case "set_cell":
      return `Review assigning tray ${edit.batchId} to ${edit.cellId}`;
    case "replace_preset":
      return `Review replacement with ${edit.preset}`;
    case "clear_results":
      return `Review clearing tray ${edit.batchId} results`;
    case "remove_tray":
      return `Review removing tray ${edit.batchId}`;
    case "set_faults":
      return "Rehearsal outage, injected failure and assumed recovery";
    case "add_tray_chain":
      return `New tray chain, ${edit.rackCase} racking`;
    case "set_baker":
      return `Tray ${edit.batchId}, baker ${edit.baker}`;
    case "set_start":
      return `${edit.operationId} from ${edit.earliestStartSeconds} s`;
    case "set_prerequisites":
      return `Tray ${edit.batchId}, ${edit.dependsOn.length} prerequisites`;
  }
}

/** An apply that opened the operator's replacement review. */
function productionReplacementReviewed(
  effect: BakerySurfaceTimelineEvent,
): boolean {
  if (effect.terminal.kind !== "settled") {return false;}
  const outcome = effect.terminal.receipt.outcome;
  if (outcome.kind !== "completed" || outcome.result.kind !== "succeeded")
    {return false;}
  const active = outcome.result.surface.context.active;
  return (
    active.kind === "production" &&
    active.draft !== null &&
    active.draft.replacement !== null
  );
}

function shiftRunObject(edits: readonly BakerySurfaceEditOperation[]): string {
  return edits.length === 0
    ? "Applied shift inputs"
    : edits.map(shiftRunInput).join(", ");
}

function shiftRunInput(edit: BakerySurfaceEditOperation): string {
  return `${edit.field} ${edit.value}`;
}

function productionEditObject(edit: BakeryProductionEdit): string {
  switch (edit.kind) {
    case "prepare_replacement":
      return `Review production replacement: ${edit.source}`;
    case "assign_tray":
      return `Batch ${edit.batchId} tray ${edit.tray}, FR10 transfer`;
    case "unassign_tray":
      return `Batch ${edit.batchId} tray ${edit.tray}, no FR10 transfer`;
    case "set_baker":
      return `Batch ${edit.batchId} tray ${edit.tray}, baker ${edit.baker}`;
    case "set_prerequisites":
      return `Batch ${edit.batchId} tray ${edit.tray}, ${edit.dependsOn.length} prerequisites`;
    case "set_start":
      return `Batch ${edit.batchId} tray ${edit.tray} from ${edit.earliestStartSeconds} s`;
    case "set_manual_task":
      return edit.bakeryTaskId;
    case "set_variant":
      return edit.variant === "outage" ? "Assumed oven outage" : "Normal oven";
    case "discard_draft":
      return "Discard draft changes";
  }
}

function bakerySurfaceSuccessSummary(
  effect: BakerySurfaceTimelineEvent,
): string {
  switch (effect.effect.command.kind) {
    case "page_command":
      return pageCommandSummary(effect.effect.command);
    case "prepare_context":
      return "Kitchen browser readiness confirmed.";
    case "prepare_layout":
      return "Prepared a bounded rack placement for operator review.";
    case "prepare_workcell":
      return "Prepared the robot rehearsal. Simulation and recording acceptance are separate actions.";
    case "edit_rehearsal":
      return isRehearsalChange(effect.effect.command.edit)
        ? "Prepared a rehearsal change for operator review. The run is unchanged."
        : "Edited the rehearsal trays. Accepted results are kept.";
    case "edit_production":
      return effect.effect.command.edit.kind === "prepare_replacement"
        ? "Prepared a production replacement for operator confirmation. The run is unchanged."
        : "Edited the production draft. The applied run is unchanged.";
    case "preview_production":
      return "Compiled the production draft for review.";
    case "apply_production":
      return productionReplacementReviewed(effect)
        ? "The run holds accepted results, so the replacement waits for the operator's review in Edit scenario. The run is unchanged."
        : "Applied the reviewed preview as a fresh production run.";
    case "start_production":
      return "Opened the financier production run. Nothing was saved.";
    case "stop_simulation":
      return "Stopped the browser simulation. Completed tasks and accepted evidence are preserved.";
    case "control_workspace_view":
      return `Applied workspace view action: ${effect.effect.command.action.kind}.`;
    case "show_production_panel":
      return `Opened the production ${effect.effect.command.panel} panel.`;
    case "control_baseline":
      return effect.effect.command.action === "pin"
        ? "Pinned the displayed run as the comparison baseline."
        : "Cleared the comparison baseline.";
    case "control_playback":
      return `Applied playback action: ${effect.effect.command.action.kind}.`;
    case "inspect_surface":
      return "Inspected the Kitchen workspace.";
    case "read_draft":
      return "Read the exact Kitchen shift draft.";
    case "query_tasks":
      return "Found matching Kitchen tasks.";
    case "set_view": {
      const view = effect.effect.command.view;
      return `Opened ${view.selection.kind} ${view.selection.id} at ${view.cursorSeconds} seconds.`;
    }
    case "prepare_production_control":
      return "Prepared a persistent production control for operator confirmation. Execution is unchanged.";
    case "prepare_edit":
      return "Prepared a Kitchen edit for operator review.";
    case "run_shift":
      return "Ran the Kitchen shift from 06:00 with playback reset. Nothing was saved.";
    case "select_item": {
      const selection = effect.effect.command.selection;
      return `Selected ${selection.kind} ${selection.id} in Details. Playback is unchanged.`;
    }
    case "rotate_equipment":
      return `Rotated ${effect.effect.command.applianceId} 90 degrees and recalculated the shift from the new layout. Nothing was saved.`;
    case "move_equipment":
      return `Moved ${effect.effect.command.applianceId} to (${effect.effect.command.xMm}, ${effect.effect.command.zMm}) mm and recalculated the shift from the new layout. Nothing was saved.`;
    case "toggle_opening":
      return `${effect.effect.command.open ? "Opened" : "Closed"} ${effect.effect.command.openingId} and recalculated the shift from the updated room state. Nothing was saved.`;
    case "select_floor_plan":
      return `Switched the Kitchen floor plan to ${effect.effect.command.floorPlan} and recalculated the shift. Nothing was saved.`;
    case "set_equipment_angle":
      return `Rotated ${effect.effect.command.applianceId} to ${effect.effect.command.yawDegrees}° and recalculated the shift from the new layout. Nothing was saved.`;
    case "configure_interior":
      return `Configured the Kitchen store interior (${describeInteriorObject(effect.effect.command.action)}). Nothing was saved.`;
    case "reset_floor_plan":
      return `Applied ${effect.effect.command.action} on the Kitchen floor plan and recalculated the shift. Nothing was saved.`;
    case "compare_shift":
      return effect.effect.command.mode === "outage"
        ? "Showed the oven-outage run against the normal run from 06:00."
        : "Showed the normal shift from 06:00.";
    case "prepare_run_save":
      return "Prepared a frozen Kitchen rehearsal copy for operator review.";
    case "file_action":
      return effect.effect.command.action.kind === "import"
        ? "Prepared the attached file for operator review."
        : "Prepared the Kitchen download in this browser.";
    case "inspect_scenario_save":
    case "inspect_run_save":
      return "Inspected the Kitchen save status. No save or approval was performed.";
    case "list_saved_runs":
      return "Read one page of saved Kitchen runs. The current run is unchanged.";
    case "prepare_run_open":
      return "Read the exact saved Kitchen run and prepared replacement review. The operator must confirm before the current run changes.";
    case "prepare_scenario_save":
      return "Prepared a frozen Kitchen scenario copy for operator review.";
    case "simulate_workcell":
      return `Simulated the ${effect.effect.command.mode} in the browser and opened its recording for review.`;
    case "apply_reviewed_edit":
      return "Applied the reviewed Kitchen edit to the local draft.";
    case "discard_candidate":
      return "Discarded the unaccepted recording. Accepted results are preserved.";
    case "accept_candidate":
      return "Accepted the exact Kitchen recording candidate.";
    default:
      return assertNever(effect.effect.command);
  }
}

function describeInteriorObject(action: BakeryStoreInteriorAction): string {
  switch (action.kind) {
    case "apply_preset":
      return `preset ${action.preset}`;
    case "set_floor_material":
      return `floor ${action.floorMaterial}`;
    case "set_wall_material":
      return `walls ${action.wallMaterial}`;
    case "set_fixture_finish":
      return `fixtures ${action.fixtureFinish}`;
    case "set_lighting_style":
      return `lighting ${action.lightingStyle}`;
    case "set_wall_height":
      return `wall height ${action.wallHeightMode}`;
    case "set_furnishings":
      return action.showFurnishings
        ? "café furnishings shown"
        : "café furnishings hidden";
    default:
      return assertNever(action);
  }
}
