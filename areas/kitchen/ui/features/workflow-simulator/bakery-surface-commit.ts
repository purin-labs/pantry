import { applyPlaybackAction } from "./playback-actions.ts";
import { applyWorkcellPreparation } from "./workcell-preparation.ts";
import { layoutTray, selectedTray } from "./scheduled-rehearsal.ts";
import { exportRehearsalWorkcells } from "@purin-labs/production-simulation/recipes/bakery/production-workcells";
import { editProductionDraft } from "./production-draft.ts";
import {
  activeRun,
  applySimulatorExperimentAction,
  applySimulatorViewAction,
  applySimulatorBrowserStop,
  applySimulatorReplayAction,
  applyBakeryWorkspaceAction,
  type SimulatorState,
} from "./simulator-state.ts";
import { canOpenWorkspaceRun } from "./simulator-state.ts";
import type { Variant } from "@purin-labs/type-utils";
import type {
  BakerySurfaceCommandOrigin,
  BakerySurfaceCommandTransition,
  PreparedBakerySurfaceCommand,
} from "./bakery-surface-command-types.ts";
import {
  equipmentAngleRejected,
  equipmentMoveRejected,
  equipmentRotationRejected,
  floorPlanResetRejected,
  matchingProposal,
  openingToggleRejected,
  scenarioSaveSourceKey,
  staleSurface,
} from "./bakery-surface-prepare.ts";
import {
  applicablePreview,
  authorableProduction,
  bakerySurfaceDraftMaterial,
  productionDraftMaterial,
  rehearsalEditable,
  rehearsalSaveSource,
  rejectedCommand,
  scheduledSession,
  shiftLayout,
  shiftSelection,
  simulationMatches,
} from "./bakery-surface-reads.ts";

export function commitBakerySurfaceCommand(
  state: SimulatorState,
  prepared: Exclude<
    PreparedBakerySurfaceCommand,
    {
      kind: "read" | "saved_runs" | "save_inspection" | "scenario_inspection";
    }
  >,
  origin: BakerySurfaceCommandOrigin,
): BakerySurfaceCommandTransition {
  const stale = staleSurface(state, prepared.command);
  if (stale !== null) return stale;
  if (prepared.kind === "simulation_stop")
    return simulationMatches(state, prepared.command)
      ? {
          kind: "applied",
          state: applySimulatorBrowserStop(true, state),
        }
      : rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The running simulation changed before Stop committed.",
        );
  if (prepared.kind === "workcell_preparation") {
    const next = applyWorkcellPreparation(state, prepared.prepared);
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The workcell changed before preparation could be applied.",
        )
      : { kind: "applied", state: next };
  }
  if (prepared.kind === "run_open") {
    const next = applyBakeryWorkspaceAction(
      { kind: "workspaceRunOpenPrepared", review: prepared.review },
      state,
    );
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The run or its draft changed while the saved copy was being read.",
        )
      : { kind: "applied", state: next };
  }
  if (prepared.kind === "baseline") {
    const next = applyBakeryWorkspaceAction(
      {
        kind: "productionBaselineChanged",
        action: prepared.command.action,
        source: prepared.source,
        baseline: prepared.baseline,
      },
      state,
    );
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The displayed run or its baseline changed before the command committed.",
        )
      : { kind: "applied", state: next };
  }
  if (prepared.kind === "playback") {
    const result = applyPlaybackAction(prepared.command.action, state);
    return result.kind === "unavailable"
      ? rejectedCommand(
          prepared.command.kind,
          "unsupported_command",
          result.message,
        )
      : result;
  }
  if (prepared.kind === "workspace_view")
    return {
      kind: "applied",
      state: applySimulatorViewAction(prepared.command.action, state),
    };
  if (prepared.kind === "production_panel") {
    const next = applyBakeryWorkspaceAction(
      {
        kind: "productionPanelShown",
        from: prepared.from,
        panel: prepared.command.panel,
      },
      state,
    );
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The run changed before its panel could open.",
        )
      : { kind: "applied", state: next };
  }
  if (prepared.kind === "production_view") {
    const next = applyBakeryWorkspaceAction(
      { kind: "productionNavigated", navigation: prepared.navigation },
      state,
    );
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The applied run changed before navigation committed.",
        )
      : { kind: "applied", state: next };
  }
  if (prepared.kind === "recording_view") {
    const next = applySimulatorReplayAction(
      { kind: "recordingNavigated", navigation: prepared.navigation },
      state,
    );
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The recording changed before navigation committed.",
        )
      : { kind: "applied", state: next };
  }
  if (prepared.kind === "rehearsal_review") {
    const next = applyBakeryWorkspaceAction(
      { kind: "rehearsalReviewPrepared", review: prepared.review },
      state,
    );
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The rehearsal changed before its review could be prepared.",
        )
      : { kind: "applied", state: next };
  }
  if (prepared.kind === "file") {
    if (
      state.workspace.production !== prepared.source ||
      !canOpenWorkspaceRun(state)
    )
      return rejectedCommand(
        prepared.command.kind,
        "stale_surface",
        "The run changed while preparing its file. Try again.",
      );
    return {
      kind: "applied",
      state:
        prepared.prepared.kind === "export"
          ? state
          : applyBakeryWorkspaceAction(
              {
                kind: "productionSessionChanged",
                patch: {
                  pending: prepared.prepared.pending,
                  cursor: {
                    time: prepared.source.cursor.time,
                    playback: "paused",
                  },
                  panel: "files",
                  notice: "Attached file checked. Review it before applying.",
                },
              },
              state,
            ),
    };
  }
  if (prepared.kind === "rehearsal_edit") {
    const session = scheduledSession(state);
    const next =
      session === null || !rehearsalEditable(state, session)
        ? state
        : applyBakeryWorkspaceAction(
            { kind: "rehearsalEdited", edit: prepared.edit },
            state,
          );
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The rehearsal changed before the edit could be applied.",
        )
      : { kind: "applied", state: next };
  }
  if (
    prepared.kind === "production_replacement" ||
    prepared.kind === "production_draft" ||
    prepared.kind === "production_preview" ||
    prepared.kind === "production_apply"
  )
    return commitProductionCommand(state, prepared);
  if (prepared.kind === "tray_layout") {
    const session = scheduledSession(state);
    const tray =
      session === null
        ? null
        : layoutTray(session.data.plan, selectedTray(session));
    if (
      session === null ||
      session.layout !== prepared.baseLayout ||
      tray?.id !== prepared.operationId ||
      tray.attempt !== prepared.proposal.previous
    )
      return rejectedCommand(
        prepared.command.kind,
        "stale_surface",
        "The rehearsal changed during layout review.",
      );
    return {
      kind: "applied",
      state: applyBakeryWorkspaceAction(
        {
          kind: "productionSessionChanged",
          patch: {
            layout: {
              operationId: prepared.operationId,
              review: { kind: "prepared", proposal: prepared.proposal },
            },
            panel: "author",
          },
        },
        state,
      ),
    };
  }
  if (prepared.kind === "discard") {
    const next = applyBakeryWorkspaceAction(
      {
        kind: "productionCandidateDiscarded",
        candidate: prepared.target.candidate,
      },
      state,
    );
    return next === state
      ? rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The candidate changed before discard.",
        )
      : { kind: "applied", state: next };
  }
  if (prepared.kind === "accept") {
    const accepted = applyBakeryWorkspaceAction(
      { kind: "acceptRecording", target: prepared.target },
      state,
    );
    if (!candidateWasAccepted(state, accepted))
      return rejectedCommand(
        prepared.command.kind,
        "stale_surface",
        "The recording candidate changed before acceptance.",
      );
    return { kind: "applied", state: accepted };
  }
  if (prepared.kind === "run_save") {
    if (origin.kind !== "agent_effect")
      return rejectedCommand(
        prepared.command.kind,
        "unsupported_command",
        "A run-save proposal requires an agent effect.",
      );
    const source = rehearsalSaveSource(state);
    const status = state.workspace.runSaves.rehearsal;
    if (
      source === null ||
      exportRehearsalWorkcells(source) !== prepared.sourceFile ||
      status.kind === "saving" ||
      status.kind === "outcome-unknown" ||
      status.kind === "saved-readback-failed" ||
      (status.kind === "not-found" &&
        (status.id !== prepared.prepared.id ||
          status.name !== prepared.prepared.snapshot.name))
    )
      return rejectedCommand(
        prepared.command.kind,
        "stale_surface",
        "The rehearsal or save recovery state changed before review was prepared.",
      );
    return {
      kind: "applied",
      state: applyBakeryWorkspaceAction(
        {
          kind: "workspaceRunSaveProposed",
          prepared: prepared.prepared,
          effectId: origin.effectId,
        },
        state,
      ),
    };
  }
  if (prepared.kind === "scenario_save") {
    if (origin.kind !== "agent_effect")
      return rejectedCommand(
        prepared.command.kind,
        "unsupported_command",
        "A scenario-save proposal requires an agent effect.",
      );
    if (
      state.workspace.scenarioSaveProposal.kind !== "none" ||
      scenarioSaveSourceKey(state) !== prepared.sourceKey
    )
      return rejectedCommand(
        prepared.command.kind,
        "stale_surface",
        "The scenario changed while its save was being prepared.",
      );
    return {
      kind: "applied",
      state: applyBakeryWorkspaceAction(
        {
          kind: "scenarioSaveProposed",
          payload: prepared.payload,
          manifest: prepared.manifest,
          effectId: origin.effectId,
        },
        state,
      ),
    };
  }
  if (prepared.kind === "production_start") {
    const opened = applyBakeryWorkspaceAction(
      {
        kind: "openProduction",
        procedure: "financier",
        ...(prepared.command.preset === "one-batch"
          ? { financierPreset: "one-batch" as const }
          : {}),
      },
      applyBakeryWorkspaceAction(
        { kind: "openRehearsal" },
        applySimulatorReplayAction({ kind: "openRecording" }, state),
      ),
    );
    return opened.workspace.kind === "production"
      ? { kind: "applied", state: opened }
      : rejectedCommand(
          prepared.command.kind,
          "stale_surface",
          "The workspace changed before production could open.",
        );
  }
  if (prepared.kind === "shift_view") {
    const command = prepared.command;
    if (command.kind === "select_item") {
      const next =
        prepared.selection === null
          ? state
          : applySimulatorViewAction(
              { kind: "select", selection: prepared.selection },
              state,
            );
      return next === state
        ? rejectedCommand(
            command.kind,
            "target_not_found",
            "The selection is no longer in the displayed run.",
          )
        : { kind: "applied", state: next };
    }
    const compared = applySimulatorReplayAction(
      command.mode === "outage"
        ? { kind: "compareOutage" }
        : { kind: "chooseVariant", variant: "normal" },
      state,
    );
    return {
      kind: "applied",
      state: applySimulatorViewAction(
        { kind: "openDock", dock: "comparison" },
        compared,
      ),
    };
  }
  if (prepared.kind === "equipment_rotation") {
    const layout = shiftLayout();
    const rejected =
      layout?.floorPlan === prepared.floorPlan
        ? equipmentRotationRejected(prepared.command, layout)
        : rejectedCommand(
            prepared.command.kind,
            "stale_surface",
            "The floor plan changed before the equipment could turn.",
          );
    return rejected ?? { kind: "applied", state };
  }
  if (prepared.kind === "equipment_move") {
    const layout = shiftLayout();
    const rejected =
      layout?.floorPlan === prepared.floorPlan
        ? equipmentMoveRejected(prepared.command, layout)
        : rejectedCommand(
            prepared.command.kind,
            "stale_surface",
            "The floor plan changed before the equipment could move.",
          );
    return rejected ?? { kind: "applied", state };
  }
  if (prepared.kind === "opening_toggle") {
    const layout = shiftLayout();
    const rejected =
      layout?.floorPlan === prepared.floorPlan
        ? openingToggleRejected(prepared.command, layout)
        : rejectedCommand(
            prepared.command.kind,
            "stale_surface",
            "The floor plan changed before the opening could toggle.",
          );
    return rejected ?? { kind: "applied", state };
  }
  if (prepared.kind === "floor_plan_select") {
    return shiftLayout() === null
      ? rejectedCommand(
          prepared.command.kind,
          "unsupported_command",
          "The floor plan is not open.",
        )
      : { kind: "applied", state };
  }
  if (prepared.kind === "equipment_angle") {
    const layout = shiftLayout();
    const rejected =
      layout?.floorPlan === prepared.floorPlan
        ? equipmentAngleRejected(prepared.command, layout)
        : rejectedCommand(
            prepared.command.kind,
            "stale_surface",
            "The floor plan changed before the equipment angle could be set.",
          );
    return rejected ?? { kind: "applied", state };
  }
  if (prepared.kind === "interior_configure") {
    return shiftLayout() === null
      ? rejectedCommand(
          prepared.command.kind,
          "unsupported_command",
          "The floor plan is not open.",
        )
      : { kind: "applied", state };
  }
  if (prepared.kind === "floor_plan_reset") {
    const layout = shiftLayout();
    const rejected =
      layout?.floorPlan === prepared.floorPlan
        ? floorPlanResetRejected(prepared.command, layout)
        : rejectedCommand(
            prepared.command.kind,
            "stale_surface",
            "The floor plan changed before the reset could run.",
          );
    return rejected ?? { kind: "applied", state };
  }
  if (prepared.kind === "shift_run") {
    if (
      state.workspace.kind !== "shift" ||
      state.procedureLoad.kind === "loading" ||
      prepared.draftMaterial !== bakerySurfaceDraftMaterial(state) ||
      state.scenario.draftRevision !== prepared.command.baseDraft.revision
    )
      return rejectedCommand(
        prepared.command.kind,
        "stale_draft",
        "The Kitchen inputs changed before the shift could run.",
      );
    return {
      kind: "applied",
      state: applySimulatorExperimentAction(
        {
          kind: "experimentApplied",
          shift: prepared.shift,
          copyId: prepared.copyId,
          notice: prepared.notice,
        },
        state,
      ),
    };
  }
  const command = prepared.command;
  if (command.kind === "prepare_production_control")
    return rejectedCommand(
      command.kind,
      "unsupported_command",
      "Open a persistent production execution for this control.",
    );
  if (state.workspace.kind !== "shift")
    return rejectedCommand(
      command.kind,
      "unsupported_command",
      "This Kitchen workspace does not support that command yet.",
    );
  if (command.kind === "prepare_edit") {
    if (
      prepared.proposal === null ||
      prepared.draftMaterial !== bakerySurfaceDraftMaterial(state) ||
      state.scenario.draftRevision !== command.baseDraft.revision
    )
      return rejectedCommand(
        command.kind,
        "stale_draft",
        "The Kitchen draft changed while this edit was being prepared.",
      );
    return {
      kind: "applied",
      state: applySimulatorExperimentAction(
        { kind: "surfaceEditPrepared", proposal: prepared.proposal },
        state,
      ),
    };
  }
  if (command.kind === "apply_reviewed_edit") {
    const proposal = matchingProposal(state, command);
    if (
      proposal === null ||
      prepared.proposal === null ||
      prepared.proposal.proposalDigest !== proposal.proposalDigest ||
      prepared.draftMaterial !== bakerySurfaceDraftMaterial(state) ||
      state.scenario.draftRevision !== command.baseDraft.revision
    )
      return rejectedCommand(
        command.kind,
        "stale_draft",
        "The Kitchen draft or reviewed proposal changed before it was applied.",
      );
    return {
      kind: "applied",
      state: applySimulatorExperimentAction(
        { kind: "surfaceEditApplied", proposal },
        state,
      ),
    };
  }
  const run = activeRun(state);
  const selection = shiftSelection(run, command.view.selection);
  if (selection === null)
    return rejectedCommand(
      command.kind,
      "target_not_found",
      "The requested Kitchen selection or playback time is unavailable.",
    );
  const navigated = applySimulatorViewAction(
    {
      kind: "navigate",
      selection,
      time: command.view.cursorSeconds,
      focus: "inspector",
    },
    state,
  );
  if (navigated === state)
    return rejectedCommand(
      command.kind,
      "target_not_found",
      "The requested Kitchen selection or playback time is unavailable.",
    );
  return {
    kind: "applied",
    state: navigated,
  };
}

function candidateWasAccepted(
  previous: SimulatorState,
  next: SimulatorState,
): boolean {
  return (
    next !== previous &&
    next.workspace.kind === "production" &&
    next.workspace.production.pending.kind === "none" &&
    next.workspace.production.data.kind === "ready" &&
    next.workspace.production.data.plan !==
      (previous.workspace.kind === "production" &&
      previous.workspace.production.data.kind === "ready"
        ? previous.workspace.production.data.plan
        : null)
  );
}

// Commits through the workspace's own actions while the draft is unchanged.
function commitProductionCommand(
  state: SimulatorState,
  prepared: Variant<
    PreparedBakerySurfaceCommand,
    | "production_replacement"
    | "production_draft"
    | "production_preview"
    | "production_apply"
  >,
): BakerySurfaceCommandTransition {
  const session = authorableProduction(state);
  if (
    session === null ||
    productionDraftMaterial(session) !== prepared.material
  )
    return rejectedCommand(
      prepared.command.kind,
      "stale_draft",
      "The production draft changed before the command could be applied.",
    );
  let next: SimulatorState;
  switch (prepared.kind) {
    case "production_replacement":
      next = applyBakeryWorkspaceAction(
        { kind: "productionReplacementPrepared", review: prepared.review },
        state,
      );
      break;
    case "production_draft": {
      const result = editProductionDraft(session, prepared.edit);
      if (result.kind === "rejected")
        return rejectedCommand(
          prepared.command.kind,
          "invalid_edit",
          result.message,
        );
      next = applyBakeryWorkspaceAction(
        { kind: "productionDraftEdited", edit: prepared.edit },
        state,
      );
      break;
    }
    case "production_preview":
      next = applyBakeryWorkspaceAction(
        { kind: "productionPreviewed", preview: prepared.preview },
        state,
      );
      break;
    case "production_apply":
      next =
        applicablePreview(state) === prepared.preview
          ? applyBakeryWorkspaceAction(
              {
                kind: "productionPreviewApplied",
                preview: prepared.preview,
              },
              state,
            )
          : state;
      break;
  }
  return next === state
    ? rejectedCommand(
        prepared.command.kind,
        "stale_surface",
        "The production run changed before the command could be applied.",
      )
    : { kind: "applied", state: next };
}
