import {
  activeWorkerRoutes,
  parseHostView,
  type CompiledScenario,
  type HostView,
  type TravelRoute,
} from "@seams/production-simulation";
import { isRecord } from "@seams/std";
import type { BakeryProductionControl } from "@seams/bakery-model/bakery-surface";
import {
  APPLIANCE_FOOTPRINTS,
  isApplianceId,
} from "@seams/production-simulation/floor/appliance-catalogue";
import {
  moveApplianceWithCollisions,
  rotateApplianceWithCollisions,
} from "../workflow-simulator/bakery-appliance-layout";
import type { BakeryFloorPlanId } from "@seams/production-simulation/floor/bakery-room";
import { floorPlanWorkspace } from "../workflow-simulator/floor-plan-workspace";
import type { ExecutionWorker } from "./execution-client";
import { factoryStationsForScenario } from "./factory-places";
import {
  buildFloorPlanTravelRoutes,
  inferScenarioWalkSpeedPreset,
  sameTravelDurations,
  scenarioPeerApplianceIds,
} from "./floor-plan-shift-travel";
import type { OvenRunSource } from "@seams/production-simulation/runs/oven-run-file";

type FloorPlanTravelSyncHooks = Readonly<{
  isMounted: () => boolean;
  isBeforeStart: () => boolean;
  onDirtyBeforeStart: () => void;
  canFlushSettledNow: () => boolean;
  onFlushSettled: () => void;
}>;

type FloorPlanTravelSyncOptions = Readonly<{
  forceFirstWorker: boolean;
  expectedControlRevision?: number;
  label?: string;
}>;

type FloorPlanTravelSyncResult = Readonly<{
  view: HostView;
  notice: string;
}>;

type EquipmentPlacementControl = Extract<
  BakeryProductionControl,
  { kind: "move-equipment" | "rotate-equipment" }
>;

type EquipmentPlacementOutcome =
  | Readonly<{ kind: "blocked"; notice: string }>
  | Readonly<{ kind: "placed"; label: string }>;

function sourceScenario(source: OvenRunSource): CompiledScenario {
  return source.kind === "snapshot"
    ? source.save.document.state.definition.scenario
    : source.scenario;
}

function readCommandedView(reply: unknown): HostView {
  if (!isRecord(reply) || reply.kind !== "commanded")
    throw new Error(
      isRecord(reply) && typeof reply.reason === "string"
        ? `The execution refused this action: ${reply.reason}.`
        : "The execution returned an invalid reply.",
    );
  const parsed = parseHostView(reply.view);
  if (!parsed.ok) throw new Error("The execution returned an invalid view.");
  return parsed.value;
}

/** Coordinates 3D floor-plan mutations with retained execution worker travel routes. */
export class FloorPlanTravelSync {
  private readonly hooks: FloorPlanTravelSyncHooks;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribePlacements: (() => void) | null = null;
  private unsubscribeFloorPlan: (() => void) | null = null;
  private unsubscribeOpenings: (() => void) | null = null;
  private pendingSync = false;
  private dirtyBeforeStart = false;
  private readonly lastSubmittedWorkerTravel = new Map<
    string,
    readonly TravelRoute[]
  >();

  constructor(hooks: FloorPlanTravelSyncHooks) {
    this.hooks = hooks;
  }

  connect(): void {
    this.unsubscribePlacements = floorPlanWorkspace.subscribePlacements(
      this.handleFloorPlanMutation,
    );
    this.unsubscribeFloorPlan = floorPlanWorkspace.subscribePlan(
      this.handleFloorPlanMutation,
    );
    this.unsubscribeOpenings = floorPlanWorkspace.subscribeOpenings(
      this.handleOpeningMutation,
    );
  }

  dispose(): void {
    this.clearTimer();
    this.unsubscribePlacements?.();
    this.unsubscribePlacements = null;
    this.unsubscribeFloorPlan?.();
    this.unsubscribeFloorPlan = null;
    this.unsubscribeOpenings?.();
    this.unsubscribeOpenings = null;
  }

  hasReadyPendingSync(): boolean {
    return this.pendingSync && this.syncTimer === null;
  }

  consumePendingSync(): void {
    this.pendingSync = false;
    this.clearTimer();
  }

  initializeBaseline(source: OvenRunSource): void {
    this.lastSubmittedWorkerTravel.clear();
    const scenario = sourceScenario(source);
    for (const resource of scenario.resources) {
      if (resource.kind !== "worker") continue;
      const initialRoutes =
        source.kind === "snapshot"
          ? activeWorkerRoutes(source.save.document.state, resource)
          : resource.travel;
      this.lastSubmittedWorkerTravel.set(resource.id, initialRoutes);
    }
  }

  async syncInitialIfDirty(
    source: OvenRunSource,
    worker: ExecutionWorker,
    view: HostView,
  ): Promise<HostView> {
    if (
      source.kind === "snapshot" ||
      (!this.dirtyBeforeStart && !floorPlanWorkspace.hasCustomPlacements())
    ) {
      return view;
    }
    this.dirtyBeforeStart = false;
    this.consumePendingSync();
    const initialSync = await this.syncWorkerTravel(source, worker, view, {
      forceFirstWorker: false,
    });
    return initialSync === null ? view : initialSync.view;
  }

  async syncPendingBeforeDrive(
    source: OvenRunSource,
    worker: ExecutionWorker,
    view: HostView,
  ): Promise<FloorPlanTravelSyncResult | null> {
    if (!this.hasReadyPendingSync()) return null;
    this.pendingSync = false;
    return this.syncWorkerTravel(source, worker, view, {
      forceFirstWorker: false,
    });
  }

  async syncWorkerTravel(
    source: OvenRunSource,
    worker: ExecutionWorker,
    currentView: HostView,
    options: FloorPlanTravelSyncOptions,
  ): Promise<FloorPlanTravelSyncResult | null> {
    const scenario = sourceScenario(source);
    const stations = factoryStationsForScenario(scenario);
    if (stations === null) return null;
    const planId = floorPlanWorkspace.getActivePlan();
    const speedPreset = inferScenarioWalkSpeedPreset(scenario);
    let latestView: HostView | null = null;
    let expectedRev = options.expectedControlRevision;
    let updatedWorkers = 0;
    let effectiveAtUs: number | null = null;
    let firstWorker = true;
    for (const resource of scenario.resources) {
      if (resource.kind !== "worker") continue;
      const nextRoutes = buildFloorPlanTravelRoutes(
        planId,
        stations,
        resource.travel,
        speedPreset,
      );
      const prevRoutes =
        this.lastSubmittedWorkerTravel.get(resource.id) ?? resource.travel;
      const forceThis = options.forceFirstWorker && firstWorker;
      firstWorker = false;
      if (!forceThis && sameTravelDurations(prevRoutes, nextRoutes)) continue;
      const reply = await worker.request({
        kind: "update-worker-travel",
        commandId: crypto.randomUUID(),
        ...(expectedRev !== undefined
          ? { expectedControlRevision: expectedRev }
          : {}),
        resource: resource.id,
        travel: nextRoutes,
      });
      if (isRecord(reply) && reply.kind === "refused") {
        if (reply.reason === "unknown_request") {
          return {
            view: latestView ?? currentView,
            notice:
              "This saved execution uses an earlier engine bundle that keeps initial walk durations.",
          };
        }
        throw new Error(`Travel route update failed: ${String(reply.reason)}.`);
      }
      const updated = readCommandedView(reply);
      latestView = updated;
      if (!isRecord(reply) || !isRecord(reply.receipt))
        throw new Error("The command returned no receipt.");
      if (reply.receipt.status === "accepted") {
        this.lastSubmittedWorkerTravel.set(resource.id, nextRoutes);
        updatedWorkers += 1;
        if (typeof reply.receipt.effectiveAt === "number") {
          effectiveAtUs = reply.receipt.effectiveAt;
        }
        if (expectedRev !== undefined) {
          expectedRev = updated.controlRevision;
        }
      } else {
        return {
          view: updated,
          notice: `Walk route update refused: ${String(reply.receipt.reason)}.`,
        };
      }
    }
    if (latestView === null) return null;
    const atSec =
      effectiveAtUs !== null
        ? `${(effectiveAtUs / 1_000_000).toFixed(1)} s`
        : "next tick";
    const prefix = options.label !== undefined ? `${options.label} ` : "";
    return {
      view: latestView,
      notice: `${prefix}Updated floor-plan walk routes for ${updatedWorkers} worker${updatedWorkers === 1 ? "" : "s"} (effective at ${atSec}).`,
    };
  }

  applyEquipmentPlacement(
    source: OvenRunSource,
    control: EquipmentPlacementControl,
  ): EquipmentPlacementOutcome {
    if (!isApplianceId(control.applianceId)) {
      return {
        kind: "blocked",
        notice: "The named equipment is not on this floor plan.",
      };
    }
    const planId = floorPlanWorkspace.getActivePlan();
    const peerIds = scenarioPeerApplianceIds(sourceScenario(source));
    const label = APPLIANCE_FOOTPRINTS[control.applianceId].label;
    const placement =
      control.kind === "move-equipment"
        ? moveApplianceWithCollisions(
            planId,
            control.applianceId,
            control.xMm / 1000,
            control.zMm / 1000,
            peerIds,
          )
        : rotateApplianceWithCollisions(planId, control.applianceId, peerIds);
    this.consumePendingSync();
    if (placement.kind === "blocked") {
      return {
        kind: "blocked",
        notice:
          control.kind === "move-equipment"
            ? `There is not enough room to place ${label} there. Its position stays unchanged.`
            : `There is not enough room to rotate ${label}. Its position stays unchanged.`,
      };
    }
    const pose = floorPlanWorkspace.getPose(planId, control.applianceId);
    const actionSummary =
      control.kind === "move-equipment"
        ? `Moved ${label} to (${pose.x.toFixed(2)} m, ${pose.z.toFixed(2)} m).`
        : `Rotated ${label} by 90°.`;
    return { kind: "placed", label: actionSummary };
  }

  private clearTimer(): void {
    if (this.syncTimer !== null) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private readonly handleFloorPlanMutation = (): void => {
    if (!this.hooks.isMounted()) return;
    if (this.hooks.isBeforeStart()) {
      this.dirtyBeforeStart = true;
      this.hooks.onDirtyBeforeStart();
      return;
    }
    this.pendingSync = true;
    this.clearTimer();
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      if (!this.hooks.isMounted() || !this.pendingSync) return;
      if (this.hooks.canFlushSettledNow()) {
        this.hooks.onFlushSettled();
      }
    }, 180);
  };

  private readonly handleOpeningMutation = (planId: BakeryFloorPlanId): void => {
    if (
      planId !== floorPlanWorkspace.getActivePlan() ||
      floorPlanWorkspace.isAnimating()
    )
      return;
    this.handleFloorPlanMutation();
  };
}
