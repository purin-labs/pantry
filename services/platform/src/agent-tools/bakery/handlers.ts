import type { OrganisationDatabase } from "../../database-handles";
import { SURFACE_EFFECT_SIGNAL } from "@seams/control-api";
import { signalChat } from "../../chat/signals";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { acceptedExecutionAccountAuthority } from "../../account-platform/access";
import { validateLiveRequestAuthority } from "../../request-authority";
import {
  readSavedBakeryRun,
  type SavedBakeryRunQuery,
  type SavedBakeryRunResult,
} from "../../commerce/bakery/saved-runs";
import type { BakeryBrowserContext } from "@seams/bakery-model/bakery-context";
import type {
  BakerySurfaceAttachmentV1,
  BakerySurfaceCommandV1,
} from "@seams/bakery-model/bakery-surface";
import type { HarnessTurnLease } from "@seams/contracts";
import type { Env } from "../../env";
import { parseUserId, type RequestId, type OrganisationId } from "../../ids";
import { traceLog } from "../../observability";
import {
  SessionExecutionAdmission,
  admittedSessionOperation,
} from "../../actors/session-execution-admission";
import { preflightHarnessTurnLease } from "../../actors/agent-session-harness-authority";
import {
  dispatchBakerySurfaceEffect,
  resumeBakerySurfaceEffect,
  SURFACE_EFFECT_TTL_MS,
  scheduleBakerySurfaceEffectRecovery,
  type BakerySurfaceEffectDispatch,
} from "../../actors/bakery-surface-effect";
import { readLatestAgentRunSave } from "../../commerce/bakery/agent-run-save";
import { readLatestAgentScenarioSave } from "../../commerce/bakery/agent-scenario-save";
import type {
  HarnessBakerySurfaceToolRequest,
  HarnessBakerySurfaceToolResult,
} from "../catalog/types";
import { BakeryContextRequestError } from "../catalog/types";
import { admitSessionInformationFlowObservation } from "../../actors/agent-session-information-flow";
import {
  createCurrentSourceFlowLabel,
  ObservationEvidence,
} from "../../policy";
import { digestCanonical } from "../../policy";
import { assertNever } from "@seams/std";
import { requireLiveBakeryReadAuthority } from "../session-support";

// The composer chip was off on the Kitchen page when the person sent the
// request (Plan 87 phase 2).
const KITCHEN_EXCLUDED =
  "The person sent this request with the screen chip off on Kitchen, so Kitchen is not part of it. Ask them to turn the chip on and send again.";

type BakerySurfaceReadiness =
  | Readonly<{ kind: "unprepared"; surface?: never; preparation?: never }>
  | Readonly<{
      kind: "preparing";
      preparation: Promise<BakerySurfaceEffectDispatch>;
      surface?: never;
    }>
  | Readonly<{
      kind: "ready";
      surface: BakerySurfaceAttachmentV1;
      preparation?: never;
    }>;

export async function executeBakerySurfaceForHarness(
  authority: {
    readonly db: OrganisationDatabase;
    readonly accountAccess: import("../../account-platform/access").AccountPlatformAccess;
    readonly archive: R2Bucket;
    readonly storage: DurableObjectStorage;
    readonly organisationId: OrganisationId;
    readonly sessionId: string;
    readonly requestId: string;
    readonly lease: HarnessTurnLease;
    readonly browserContext: BakeryBrowserContext;
    /** Tells the user's chat pages that a Kitchen effect waits. */
    readonly announceEffect: () => void;
    surfaceReadiness: BakerySurfaceReadiness;
  },
  request: HarnessBakerySurfaceToolRequest,
  callId: string,
): Promise<HarnessBakerySurfaceToolResult> {
  if (authority.lease.requestAuthority.kind !== "control") {
    throw new Error("embedded_harness_surface_unavailable");
  }
  if (authority.browserContext.kind !== "available") {
    throw new BakeryContextRequestError(
      authority.browserContext.kind === "excluded"
        ? KITCHEN_EXCLUDED
        : "This request has no eligible browser. Open chat in the portal to use BakeryOS browser controls.",
    );
  }
  await requireLiveBakeryAuthority(
    authority.db,
    authority.storage,
    authority.organisationId,
    authority.lease,
    authority.accountAccess,
  );
  await scheduleBakerySurfaceEffectRecovery(
    authority.storage,
    Date.now() + 1_000,
  );
  const resumed = await resumeBakerySurfaceEffect({
    db: authority.db,
    storage: authority.storage,
    organisationId: authority.organisationId,
    sessionId: authority.sessionId,
    requestId: authority.requestId,
    userId: authority.lease.requestAuthority.userId,
    lease: authority.lease,
    callId,
    commandKind: request.kind,
    announce: authority.announceEffect,
  });
  let dispatched: BakerySurfaceEffectDispatch;
  if (resumed.kind === "dispatched") {
    dispatched = resumed.result;
  } else {
    const prepared = await prepareBakerySurfaceForHarness(
      authority,
      request.kind,
      callId,
    );
    if (prepared.kind === "failed") {
      return {
        ...prepared.result,
        saveVerification: { kind: "none" },
        scenarioSaveResult: { kind: "none" },
      };
    }
    await requireLiveBakeryAuthority(
      authority.db,
      authority.storage,
      authority.organisationId,
      authority.lease,
      authority.accountAccess,
    );
    try {
      dispatched = await dispatchBakerySurfaceEffect({
        db: authority.db,
        storage: authority.storage,
        organisationId: authority.organisationId,
        sessionId: authority.sessionId,
        requestId: authority.requestId,
        userId: authority.lease.requestAuthority.userId,
        lease: authority.lease,
        callId,
        command: bakerySurfaceCommand(prepared.surface, request),
        announce: authority.announceEffect,
      });
    } catch (error) {
      authority.surfaceReadiness = { kind: "unprepared" };
      throw error;
    }
  }
  await requireLiveBakeryAuthority(
    authority.db,
    authority.storage,
    authority.organisationId,
    authority.lease,
    authority.accountAccess,
  );
  const outcome = dispatched.receipt.outcome;
  if (outcome.kind !== "completed" || outcome.result.kind !== "succeeded") {
    authority.surfaceReadiness = { kind: "unprepared" };
    return {
      ...dispatched,
      saveVerification: { kind: "none" },
      scenarioSaveResult: { kind: "none" },
    };
  }
  const surface = outcome.result.surface;
  authority.surfaceReadiness = { kind: "ready", surface };
  if (request.kind !== "inspect_surface") {
    return {
      ...dispatched,
      saveVerification: { kind: "none" },
      scenarioSaveResult: { kind: "none" },
    };
  }
  const saveVerification = await readLatestAgentRunSave({
    db: authority.db,
    archive: authority.archive,
    organisationId: authority.organisationId,
    userId: authority.lease.requestAuthority.userId,
    surfaceSessionId: surface.context.surfaceSessionId,
  }).catch(readFailedRunSave);
  const scenarioSaveResult = await readLatestAgentScenarioSave({
    db: authority.db,
    organisationId: authority.organisationId,
    userId: authority.lease.requestAuthority.userId,
    surfaceSessionId: surface.context.surfaceSessionId,
  }).catch(readFailedScenarioSave);
  return { ...dispatched, saveVerification, scenarioSaveResult };
}

async function prepareBakerySurfaceForHarness(
  authority: Parameters<typeof executeBakerySurfaceForHarness>[0],
  requiredCommand: HarnessBakerySurfaceToolRequest["kind"],
  callId: string,
): Promise<
  | Readonly<{ kind: "ready"; surface: BakerySurfaceAttachmentV1 }>
  | Readonly<{ kind: "failed"; result: BakerySurfaceEffectDispatch }>
> {
  const readiness = authority.surfaceReadiness;
  switch (readiness.kind) {
    case "ready":
      if (
        Date.now() <
        readiness.surface.context.capturedAt + SURFACE_EFFECT_TTL_MS
      ) {
        requireSupportedBakeryCommand(readiness.surface, requiredCommand);
        return { kind: "ready", surface: readiness.surface };
      }
      break;
    case "preparing":
    case "unprepared":
      break;
    default:
      return assertNever(readiness);
  }
  const preparation =
    readiness.kind === "preparing"
      ? readiness.preparation
      : dispatchBakeryContextPreparation(authority, requiredCommand, callId);
  authority.surfaceReadiness = { kind: "preparing", preparation };
  let prepared: BakerySurfaceEffectDispatch;
  try {
    prepared = await preparation;
  } catch (error) {
    authority.surfaceReadiness = { kind: "unprepared" };
    throw error;
  }
  if (prepared.receipt.outcome.kind !== "prepared") {
    authority.surfaceReadiness = { kind: "unprepared" };
    return { kind: "failed", result: prepared };
  }
  const surface = prepared.receipt.outcome.surface;
  authority.surfaceReadiness = { kind: "ready", surface };
  requireSupportedBakeryCommand(surface, requiredCommand);
  return { kind: "ready", surface };
}

function requireSupportedBakeryCommand(
  surface: BakerySurfaceAttachmentV1,
  requiredCommand: HarnessBakerySurfaceToolRequest["kind"],
): void {
  if (!surface.context.supportedCommands.includes(requiredCommand)) {
    throw new BakeryContextRequestError(
      "The current BakeryOS view does not support this operation. Inspect its current context and select a supported operation.",
    );
  }
}

function readFailedRunSave(): import("../../commerce/bakery/agent-run-save").AgentRunSaveVerification {
  return { kind: "read_failed" };
}

function readFailedScenarioSave(): import("../../commerce/bakery/agent-scenario-save").AgentScenarioSaveResult {
  return { kind: "read_failed" };
}

function bakerySurfaceCommand(
  surface: BakerySurfaceAttachmentV1,
  request: HarnessBakerySurfaceToolRequest,
): BakerySurfaceCommandV1 {
  const target = {
    surfaceSessionId: surface.context.surfaceSessionId,
    surfaceEpoch: surface.context.surfaceEpoch,
  };
  switch (request.kind) {
    case "inspect_surface":
      return { schemaVersion: 1, kind: "inspect_surface", target };
    case "stop_simulation":
      if (surface.context.simulation === null) {
        throw new TypeError(
          "The attached workspace has no running simulation.",
        );
      }
      return {
        schemaVersion: 1,
        kind: "stop_simulation",
        target,
        simulation: surface.context.simulation,
      };
    case "control_workspace_view":
      return {
        schemaVersion: 1,
        kind: "control_workspace_view",
        target,
        action: request.action,
      };
    case "show_production_panel":
      return {
        schemaVersion: 1,
        kind: "show_production_panel",
        target,
        panel: request.panel,
      };
    case "control_baseline":
      if (surface.context.comparison === null) {
        throw new TypeError("Open a run before controlling its baseline.");
      }
      return {
        schemaVersion: 1,
        kind: "control_baseline",
        target,
        comparison: surface.context.comparison,
        action: request.action,
      };
    case "control_playback":
      return {
        schemaVersion: 1,
        kind: "control_playback",
        target,
        action: request.action,
      };
    case "prepare_workcell":
      return {
        schemaVersion: 1,
        kind: "prepare_workcell",
        target,
        preparation: request.preparation,
      };
    case "read_draft":
      return { schemaVersion: 1, kind: "read_draft", target };
    case "query_tasks":
      return {
        schemaVersion: 1,
        kind: "query_tasks",
        target,
        filter: { text: request.text, limit: request.limit },
      };
    case "set_view":
      return {
        schemaVersion: 1,
        kind: "set_view",
        target,
        view: {
          selection: request.selection,
          cursorSeconds: request.cursorSeconds,
          playback: "paused",
        },
      };
    case "select_item":
      return {
        schemaVersion: 1,
        kind: "select_item",
        target,
        selection: request.selection,
      };
    case "rotate_equipment": {
      const active = surface.context.active;
      const equipment =
        active.kind === "shift"
          ? active.layout?.equipment.find(
              (item) => item.id === request.applianceId,
            )
          : undefined;
      if (equipment === undefined) {
        throw new TypeError(
          "That appliance is not on the attached floor plan. Use an id from layout.equipment.",
        );
      }
      return {
        schemaVersion: 1,
        kind: "rotate_equipment",
        target,
        applianceId: equipment.id,
        rotationDegrees: equipment.rotationDegrees,
      };
    }
    case "move_equipment": {
      const active = surface.context.active;
      const equipment =
        active.kind === "shift"
          ? active.layout?.equipment.find(
              (item) => item.id === request.applianceId,
            )
          : undefined;
      if (equipment === undefined) {
        throw new TypeError(
          "That appliance is not on the attached floor plan. Use an id from layout.equipment.",
        );
      }
      return {
        schemaVersion: 1,
        kind: "move_equipment",
        target,
        applianceId: equipment.id,
        xMm: request.xMm,
        zMm: request.zMm,
      };
    }
    case "toggle_opening": {
      const active = surface.context.active;
      const opening =
        active.kind === "shift"
          ? active.layout?.openings?.find(
              (item) => item.id === request.openingId,
            )
          : undefined;
      if (opening === undefined) {
        throw new TypeError(
          "That door or window is not on the attached floor plan. Use an id from layout.openings.",
        );
      }
      return {
        schemaVersion: 1,
        kind: "toggle_opening",
        target,
        openingId: opening.id,
        open: request.open,
      };
    }
    case "select_floor_plan":
      return {
        schemaVersion: 1,
        kind: "select_floor_plan",
        target,
        floorPlan: request.floorPlan,
      };
    case "set_equipment_angle": {
      const active = surface.context.active;
      const equipment =
        active.kind === "shift"
          ? active.layout?.equipment.find(
              (item) => item.id === request.applianceId,
            )
          : undefined;
      if (equipment === undefined) {
        throw new TypeError(
          "That appliance is not on the attached floor plan. Use an id from layout.equipment.",
        );
      }
      return {
        schemaVersion: 1,
        kind: "set_equipment_angle",
        target,
        applianceId: equipment.id,
        yawDegrees: request.yawDegrees,
      };
    }
    case "configure_interior": {
      const active = surface.context.active;
      if (active.kind !== "shift" || active.layout === undefined) {
        throw new TypeError(
          "The attached Kitchen page has no open floor plan.",
        );
      }
      return {
        schemaVersion: 1,
        kind: "configure_interior",
        target,
        action: request.action,
      };
    }
    case "reset_floor_plan": {
      const active = surface.context.active;
      if (active.kind !== "shift" || active.layout === undefined) {
        throw new TypeError(
          "The attached Kitchen page has no open floor plan.",
        );
      }
      const history = active.layout.history;
      if (history !== undefined) {
        if (request.action === "undo" && !history.canUndo) {
          throw new TypeError("There is no floor plan action to undo.");
        }
        if (request.action === "redo" && !history.canRedo) {
          throw new TypeError("There is no floor plan action to redo.");
        }
        if (request.action === "reset_appliances" && !history.hasCustomLayout) {
          throw new TypeError(
            "Appliance placements are already at their room defaults.",
          );
        }
        if (
          request.action === "reset_initial" &&
          !history.canUndo &&
          !history.canRedo &&
          !history.hasCustomLayout
        ) {
          throw new TypeError(
            "The floor plan is already at its initial layout.",
          );
        }
      }
      return {
        schemaVersion: 1,
        kind: "reset_floor_plan",
        target,
        action: request.action,
      };
    }
    case "start_production":
      return {
        schemaVersion: 1,
        kind: "start_production",
        target,
        preset: request.preset,
      };
    case "compare_shift":
      return {
        schemaVersion: 1,
        kind: "compare_shift",
        target,
        mode: request.mode,
      };
    case "prepare_layout": {
      const active = surface.context.active;
      if (active.kind === "rehearsal" && active.rehearsalKind === "scheduled") {
        if (active.rackLayout === null) {
          throw new Error("embedded_harness_surface_layout_unavailable");
        }
        return {
          schemaVersion: 2,
          kind: "prepare_layout",
          target,
          operationId: active.rackLayout.operationId,
          baseModelHash: request.baseModelHash,
          xMm: request.xMm,
          yMm: request.yMm,
        };
      }
      return {
        schemaVersion: 1,
        kind: "prepare_layout",
        target,
        baseModelHash: request.baseModelHash,
        xMm: request.xMm,
        yMm: request.yMm,
      };
    }
    case "prepare_production_control": {
      const active = surface.context.active;
      if (active.kind !== "persistent") {
        throw new TypeError(
          "Open a live persistent production execution first.",
        );
      }
      return {
        schemaVersion: 1,
        kind: "prepare_production_control",
        target,
        production: active.target,
        control: request.control,
      };
    }
    case "prepare_edit":
    case "run_shift":
      return {
        schemaVersion: 1,
        kind: request.kind,
        target,
        baseDraft: request.baseDraft,
        edits: request.edits,
      };
    case "prepare_run_save":
      return {
        schemaVersion: 1,
        kind: "prepare_run_save",
        target,
        name: request.name,
      };
    case "file_action":
      return {
        schemaVersion: 1,
        kind: "file_action",
        target,
        action: request.action,
      };
    case "inspect_scenario_save":
      return { schemaVersion: 1, kind: "inspect_scenario_save", target };
    case "inspect_run_save":
      return {
        schemaVersion: 1,
        kind: "inspect_run_save",
        target,
        runKind: request.runKind,
      };
    case "list_saved_runs":
      return {
        schemaVersion: 1,
        kind: "list_saved_runs",
        target,
        runKind: request.runKind,
        cursor: request.cursor,
      };
    case "prepare_run_open":
      return {
        schemaVersion: 1,
        kind: "prepare_run_open",
        target,
        runKind: request.runKind,
        id: request.id,
      };
    case "prepare_scenario_save":
      return {
        schemaVersion: 1,
        kind: "prepare_scenario_save",
        target,
        name: request.name,
        note: request.note,
      };
    case "simulate_workcell": {
      const active = surface.context.active;
      if (
        (active.kind === "production" && active.readiness === "ready") ||
        (active.kind === "rehearsal" && active.rehearsalKind === "scheduled")
      ) {
        if (
          active.pendingOperation === null ||
          active.planFingerprint === null
        ) {
          throw new Error("embedded_harness_surface_simulation_unavailable");
        }
        return {
          schemaVersion: 2,
          kind: "simulate_workcell",
          target,
          operationId: active.pendingOperation.operationId,
          planFingerprint: active.planFingerprint,
          mode: request.mode,
        };
      }
      if (
        active.kind !== "rehearsal" ||
        active.rehearsalKind !== "standalone" ||
        active.attemptId === null
      ) {
        throw new Error("embedded_harness_surface_simulation_unavailable");
      }
      return {
        schemaVersion: 1,
        kind: "simulate_workcell",
        target,
        attemptId: active.attemptId,
        mode: request.mode,
      };
    }
    case "edit_rehearsal": {
      const active = surface.context.active;
      if (
        active.kind !== "rehearsal" ||
        active.rehearsalKind !== "scheduled" ||
        active.planFingerprint === null
      ) {
        throw new Error("embedded_harness_surface_rehearsal_unavailable");
      }
      return {
        schemaVersion: 1,
        kind: "edit_rehearsal",
        target,
        planFingerprint: active.planFingerprint,
        edit: request.edit,
      };
    }
    case "edit_production":
    case "preview_production":
    case "apply_production": {
      const active = surface.context.active;
      if (active.kind !== "production" || active.draft === null) {
        throw new Error("embedded_harness_surface_production_unavailable");
      }
      const draftDigest = active.draft.digest;
      if (request.kind === "edit_production") {
        return {
          schemaVersion: 1,
          kind: "edit_production",
          target,
          draftDigest,
          edit: request.edit,
        };
      }
      if (request.kind === "preview_production") {
        return {
          schemaVersion: 1,
          kind: "preview_production",
          target,
          draftDigest,
        };
      }
      if (active.draft.preview === null) {
        throw new Error("embedded_harness_surface_production_unavailable");
      }
      return {
        schemaVersion: 1,
        kind: "apply_production",
        target,
        draftDigest,
        planFingerprint: active.draft.preview.planFingerprint,
      };
    }
    case "discard_candidate": {
      const active = surface.context.active;
      const candidate =
        active.kind === "shift" ||
        active.kind === "persistent" ||
        active.kind === "persistent-snapshot"
          ? null
          : active.candidate;
      if (candidate?.kind !== "production") {
        throw new Error("embedded_harness_surface_stale_candidate");
      }
      return { schemaVersion: 1, kind: "discard_candidate", target, candidate };
    }
    case "accept_candidate":
      if (
        request.candidate.surfaceSessionId !== target.surfaceSessionId ||
        request.candidate.surfaceEpoch !== target.surfaceEpoch
      ) {
        throw new Error("embedded_harness_surface_stale_candidate");
      }
      return {
        schemaVersion: 1,
        kind: "accept_candidate",
        target,
        candidate: request.candidate,
      };
    default:
      return assertNever(request);
  }
}

async function dispatchBakeryContextPreparation(
  authority: Parameters<typeof executeBakerySurfaceForHarness>[0],
  requiredCommand: import("@seams/bakery-model/bakery-surface").BakerySurfaceToolCommandName,
  callId: string,
): Promise<
  import("../../actors/bakery-surface-effect").BakerySurfaceEffectDispatch
> {
  if (authority.lease.requestAuthority.kind !== "control") {
    throw new Error("BakeryOS requires control authority");
  }
  if (authority.browserContext.kind !== "available") {
    throw new BakeryContextRequestError(
      authority.browserContext.kind === "excluded"
        ? KITCHEN_EXCLUDED
        : "This request has no eligible browser. Open chat in the portal to use BakeryOS browser controls.",
    );
  }
  return dispatchBakerySurfaceEffect({
    db: authority.db,
    storage: authority.storage,
    organisationId: authority.organisationId,
    sessionId: authority.sessionId,
    requestId: authority.requestId,
    userId: authority.lease.requestAuthority.userId,
    lease: authority.lease,
    callId: `${callId}:context`,
    command: {
      schemaVersion: 1,
      kind: "prepare_context",
      binding: authority.browserContext.binding,
      requiredCommand,
    },
    announce: authority.announceEffect,
  });
}

/**
 * Tells the requester's open chat pages that a Kitchen effect waits
 * for their browser (Plan 87 phase 3). The signal names nothing; the page
 * reads its pending effects through the checked route.
 */
export function announceSurfaceEffect(
  scope: OrganisationExecutionScope,
  authority: HarnessTurnLease["requestAuthority"],
): void {
  if (authority.kind !== "control") return;
  const userId = parseUserId(authority.userId);
  if (!userId.ok) return;
  signalChat(
    scope,
    { kind: "user", userId: userId.value },
    SURFACE_EFFECT_SIGNAL,
  );
}

export async function requireLiveBakeryAuthority(
  db: OrganisationDatabase,
  storage: DurableObjectStorage,
  organisationId: OrganisationId,
  lease: HarnessTurnLease,
  accountAccess: import("../../account-platform/access").AccountPlatformAccess,
  options?: Readonly<{ allowOperator?: boolean }>,
): Promise<void> {
  const current = preflightHarnessTurnLease(storage, lease, Date.now());
  const roleAllowed =
    lease.requestAuthority.kind === "control" &&
    (lease.requestAuthority.role === "admin" ||
      lease.requestAuthority.role === "owner" ||
      (options?.allowOperator === true &&
        lease.requestAuthority.role === "operator"));
  if (
    !current.ok ||
    lease.requestAuthority.organisationId !== organisationId ||
    !roleAllowed
  ) {
    throw new Error("BakeryOS authority is unavailable");
  }
  const live = await validateLiveRequestAuthority({
    db,
    accountAccess,
    userAuthority: acceptedExecutionAccountAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    action: "execute",
    authority: lease.requestAuthority,
  });
  if (!live.ok) {
    throw new Error("BakeryOS authority has changed");
  }
}

export async function readSavedBakeryRunForHarness(
  requestId: RequestId,
  env: Env,
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  browserContext: BakeryBrowserContext,
  query: SavedBakeryRunQuery,
): Promise<SavedBakeryRunResult> {
  const organisationId = execution.scope.organisationId;
  const startedAt = Date.now();
  if (browserContext.kind === "excluded") {
    throw new BakeryContextRequestError(KITCHEN_EXCLUDED);
  }
  await requireLiveBakeryReadAuthority(execution, lease);
  const sourceStartedAt = Date.now();
  const result = await readSavedBakeryRun(
    {
      list: admittedSessionOperation(
        execution,
        lease,
        env.ARCHIVE.list.bind(env.ARCHIVE),
      ),
      get: admittedSessionOperation(
        execution,
        lease,
        env.ARCHIVE.get.bind(env.ARCHIVE),
      ),
    },
    organisationId,
    query,
  );
  traceLog("session.saved_bakery_source_timing", {
    requestId,
    organisation_id: organisationId,
    turn_id: lease.turn.turnId,
    query_kind: query.kind,
    outcome: result.kind,
    source_duration_ms: Date.now() - sourceStartedAt,
    authority_duration_ms: sourceStartedAt - startedAt,
    source_bytes: result.kind === "saved_bakery_run" ? result.source.bytes : 0,
  });
  await requireLiveBakeryReadAuthority(execution, lease);
  if (result.kind === "unavailable") {
    return result;
  }
  const label = await createCurrentSourceFlowLabel({
    kind: "saved_bakery_run",
    db: execution.scope.database,
    authority: lease.requestAuthority,
  });
  if (!label.ok) {
    throw new Error("Saved bakery source label is unavailable");
  }
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "organisation_record",
      organisationId,
      recordId:
        result.kind === "saved_bakery_run"
          ? `bakery-run:${result.source.id}`
          : "bakery-runs:catalogue",
    },
    sourceRevision:
      result.kind === "saved_bakery_run"
        ? Date.parse(result.source.savedAt)
        : result.observedAt,
    contentDigest:
      result.kind === "saved_bakery_run"
        ? result.revision
        : await digestCanonical(result),
    inputLabel: label.value,
    observedAt: result.observedAt,
  });
  if (!evidence.ok) {
    throw new Error("Saved bakery observation is invalid");
  }
  const admitted = await admitSessionInformationFlowObservation({
    authorizeCommit: requireLiveBakeryReadAuthority.bind(
      null,
      execution,
      lease,
    ),
    sql: storage.sql,
    transactionSync: storage.transactionSync.bind(storage),
    organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
    authorityPartitionDigest: lease.authorityPartitionDigest,
    inputLabel: label.value,
    observation: evidence.value,
    observedAt: result.observedAt,
  });
  if (!admitted.ok) {
    throw new Error("Saved bakery information-flow admission failed");
  }
  await requireLiveBakeryReadAuthority(execution, lease);
  traceLog("session.saved_bakery_read_timing", {
    requestId,
    organisation_id: organisationId,
    turn_id: lease.turn.turnId,
    query_kind: query.kind,
    outcome: result.kind,
    duration_ms: Date.now() - startedAt,
  });
  return result;
}
