import { isRecord } from "@seams/std";
import {
  restoreVitrineDemandSnapshot,
  subscribeVitrineDemandHistory,
} from "@seams/production-simulation/recipes/bakery/schedule";
import {
  BAKERY_FLOOR_PLANS,
  BAKERY_FLOOR_PLAN_ORDER,
  type BakeryFloorPlanId,
} from "@seams/production-simulation/floor/bakery-room";
import {
  APPLIANCE_FOOTPRINTS,
  DEFAULT_ROOM_APPLIANCE_LAYOUTS,
  REHEARSAL_APPLIANCE_IDS,
  isApplianceId,
  type ApplianceId,
  type AppliancePose,
} from "@seams/production-simulation/floor/appliance-catalogue";
import { getApplianceBox, type Box2D } from "@seams/production-simulation/floor/collisions";
import {
  findFloorPlanOpening,
  maxUnobstructedDoorProgress,
  openingId,
  type FloorPlanOpening,
} from "@seams/production-simulation/floor/openings";
import {
  SimulatorHistoryStore,
  useSimulatorHistoryStore,
  type SimulatorHistoryActionFeedback,
  type SimulatorHistoryEntry,
  type SimulatorHistorySnapshot,
  type SimulatorHistoryTimelineEntry,
} from "./simulator-history-store";

export type {
  SimulatorHistoryActionFeedback,
  SimulatorHistoryEntry,
  SimulatorHistorySnapshot,
  SimulatorHistoryTimelineEntry,
};

export const FLOOR_PLAN_WORKSPACE_STORAGE_KEY = "satyr:floor-plan-workspace:v1";

function isFloorPlanId(value: unknown): value is BakeryFloorPlanId {
  for (const id of BAKERY_FLOOR_PLAN_ORDER) {
    if (id === value) return true;
  }
  return false;
}

type OpeningState = {
  opening: FloorPlanOpening;
  target: 0 | 1;
  limit: number;
  progress: number;
};
type Animation =
  | { kind: "idle"; frame?: never; time?: never }
  | { kind: "active"; frame: number; time: number };

/** Owns shared room geometry, appliance placements and door openings for the Portal workspace. */
export class FloorPlanWorkspace {
  private activePlan: BakeryFloorPlanId;
  private readonly planListeners = new Set<
    (planId: BakeryFloorPlanId) => void
  >();
  private readonly openings = new Map<string, OpeningState>();
  private readonly openingListeners = new Set<
    (planId: BakeryFloorPlanId) => void
  >();
  private animation: Animation = { kind: "idle" };
  private readonly placements = new Map<
    BakeryFloorPlanId,
    Map<ApplianceId, AppliancePose>
  >();
  private readonly placementListeners = new Set<() => void>();
  private placementVersion = 0;
  private openingVersion = 0;
  readonly history: SimulatorHistoryStore;

  readonly canUndo: () => boolean;
  readonly canRedo: () => boolean;
  readonly getUndoLabel: () => string | null;
  readonly getRedoLabel: () => string | null;
  readonly getHistoryVersion: () => number;
  readonly getHistorySnapshot: () => SimulatorHistorySnapshot;
  readonly subscribeHistory: (listener: () => void) => () => void;
  readonly recordHistory: (entry: SimulatorHistoryEntry) => void;
  readonly undo: () => boolean;
  readonly redo: () => boolean;
  readonly jumpToHistory: (targetIndex: number) => number;
  readonly clearHistory: () => void;
  readonly resetToInitialLayout: () => void;

  constructor(planId: BakeryFloorPlanId, preserveActivePlan = false) {
    this.activePlan = planId;
    this.history = new SimulatorHistoryStore({
      hasCustomLayout: () => this.hasCustomPlacements(),
      clearCustomLayout: () => this.clearActivePlanPlacements(),
    });
    this.canUndo = this.history.canUndo;
    this.canRedo = this.history.canRedo;
    this.getUndoLabel = this.history.getUndoLabel;
    this.getRedoLabel = this.history.getRedoLabel;
    this.getHistoryVersion = this.history.getVersion;
    this.getHistorySnapshot = this.history.getSnapshot;
    this.subscribeHistory = this.history.subscribe;
    this.recordHistory = this.history.record;
    this.undo = this.history.undo;
    this.redo = this.history.redo;
    this.jumpToHistory = this.history.jumpTo;
    this.clearHistory = this.history.clear;
    this.resetToInitialLayout = this.history.resetToInitialLayout;
    this.reloadFromStorage(preserveActivePlan);
    subscribeVitrineDemandHistory((event) => {
      this.recordHistory({
        label: event.label,
        ...(event.coalesceKey !== undefined
          ? { coalesceKey: event.coalesceKey, coalesceWindowMs: 400 }
          : {}),
        undo: () => restoreVitrineDemandSnapshot(event.before),
        redo: () => restoreVitrineDemandSnapshot(event.after),
      });
    });
  }

  private clearActivePlanPlacements(): void {
    if ((this.placements.get(this.activePlan)?.size ?? 0) === 0) return;
    this.placements.delete(this.activePlan);
    this.saveToStorage();
    this.notifyPlacements();
    this.reconcileOpenings(this.activePlan);
  }

  readonly getActivePlan = (): BakeryFloorPlanId => this.activePlan;

  readonly setActivePlan = (id: BakeryFloorPlanId): void => {
    if (this.activePlan === id) return;
    const prevPlan = this.activePlan;
    this.activePlan = id;
    this.saveToStorage();
    for (const listener of this.planListeners) listener(id);
    this.recordHistory({
      label: `Floor plan: ${BAKERY_FLOOR_PLANS[id].shortLabel}`,
      undo: () => this.setActivePlan(prevPlan),
      redo: () => this.setActivePlan(id),
    });
  };

  readonly subscribePlan = (
    listener: (id: BakeryFloorPlanId) => void,
  ): (() => void) => {
    this.planListeners.add(listener);
    return this.unsubscribePlan.bind(this, listener);
  };

  private unsubscribePlan(listener: (id: BakeryFloorPlanId) => void): void {
    this.planListeners.delete(listener);
  }

  getPose(planId: BakeryFloorPlanId, id: ApplianceId): AppliancePose {
    return (
      this.placements.get(planId)?.get(id) ??
      DEFAULT_ROOM_APPLIANCE_LAYOUTS[planId][id]
    );
  }

  hasCustomPlacements(planId: BakeryFloorPlanId = this.activePlan): boolean {
    return (this.placements.get(planId)?.size ?? 0) > 0;
  }

  private applyPlanPlacementsSnapshot(
    planId: BakeryFloorPlanId,
    snapshot: ReadonlyMap<ApplianceId, AppliancePose>,
  ): void {
    if (snapshot.size === 0) {
      this.placements.delete(planId);
    } else {
      this.placements.set(planId, new Map(snapshot));
    }
    this.saveToStorage();
    this.notifyPlacements();
    this.reconcileOpenings(planId);
  }

  setPoses(
    planId: BakeryFloorPlanId,
    poses: readonly AppliancePose[],
    options?: Readonly<{ gestureId?: string; label?: string }>,
  ): void {
    if (poses.length === 0) return;
    const changed = poses.some((pose) => {
      const cur = this.getPose(planId, pose.id);
      return cur.x !== pose.x || cur.z !== pose.z || cur.rotY !== pose.rotY;
    });
    if (!changed) return;
    const before = new Map(this.placements.get(planId));
    const first = poses[0]!;
    const prevFirst = this.getPose(planId, first.id);
    const fpLabel = APPLIANCE_FOOTPRINTS[first.id]?.label ?? first.id;
    const isRotationOnly =
      Math.abs(first.rotY - prevFirst.rotY) > 1e-4 &&
      Math.hypot(first.x - prevFirst.x, first.z - prevFirst.z) < 1e-4;
    const label =
      options?.label ??
      (isRotationOnly ? `Rotate ${fpLabel}` : `Move ${fpLabel}`);
    let placements = this.placements.get(planId);
    if (placements === undefined) {
      placements = new Map();
      this.placements.set(planId, placements);
    }
    for (const pose of poses) placements.set(pose.id, pose);
    const after = new Map(this.placements.get(planId));
    this.saveToStorage();
    this.notifyPlacements();
    this.reconcileOpenings(planId);
    this.recordHistory({
      label,
      ...(options?.gestureId !== undefined
        ? { coalesceKey: options.gestureId }
        : {}),
      undo: () => this.applyPlanPlacementsSnapshot(planId, before),
      redo: () => this.applyPlanPlacementsSnapshot(planId, after),
    });
  }

  readonly resetPlacements = (planId: BakeryFloorPlanId): void => {
    const before = new Map(this.placements.get(planId));
    if (before.size === 0) return;
    this.placements.delete(planId);
    this.saveToStorage();
    this.notifyPlacements();
    this.reconcileOpenings(planId);
    this.recordHistory({
      label: "Reset appliance layout",
      undo: () => this.applyPlanPlacementsSnapshot(planId, before),
      redo: () => this.applyPlanPlacementsSnapshot(planId, new Map()),
    });
  };

  readonly getPlacementVersion = (): number => this.placementVersion;

  readonly subscribePlacements = (listener: () => void): (() => void) => {
    this.placementListeners.add(listener);
    return this.unsubscribePlacements.bind(this, listener);
  };

  private unsubscribePlacements(listener: () => void): void {
    this.placementListeners.delete(listener);
  }

  private notifyPlacements(): void {
    this.placementVersion += 1;
    for (const listener of this.placementListeners) listener();
  }

  private applianceBoxes(planId: BakeryFloorPlanId): readonly Box2D[] {
    return REHEARSAL_APPLIANCE_IDS.map((id) => {
      const pose = this.getPose(planId, id);
      return getApplianceBox(id, pose.x, pose.z, pose.rotY);
    });
  }

  private reconcileOpenings(planId: BakeryFloorPlanId): void {
    let boxes: readonly Box2D[] | null = null;
    let snapped = false;
    let needsAnimation = false;
    const instant =
      typeof requestAnimationFrame !== "function" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const state of this.openings.values()) {
      if (state.opening.planId !== planId || state.opening.kind !== "door") {
        continue;
      }
      if (state.target === 0 && state.progress === 0 && state.limit === 0) {
        continue;
      }
      boxes ??= this.applianceBoxes(planId);
      const nextLimit =
        state.target === 1
          ? maxUnobstructedDoorProgress(state.opening.door, 0, 1, boxes)
          : maxUnobstructedDoorProgress(
              state.opening.door,
              state.progress,
              0,
              boxes,
            );
      if (nextLimit === state.limit && state.progress === nextLimit) {
        continue;
      }
      state.limit = nextLimit;
      if (instant) {
        if (state.progress !== nextLimit) {
          state.progress = nextLimit;
          snapped = true;
        }
      } else if (state.progress !== nextLimit) {
        needsAnimation = true;
      }
    }
    if (snapped) {
      this.saveToStorage();
      this.notifyOpenings(planId);
    }
    if (needsAnimation && this.animation.kind === "idle") {
      this.animation = {
        kind: "active",
        time: performance.now(),
        frame: requestAnimationFrame(this.step),
      };
    }
  }

  progress(opening: FloorPlanOpening): number {
    return this.openings.get(this.key(opening))?.progress ?? 0;
  }

  readonly getOpeningVersion = (): number => this.openingVersion;

  readonly isAnimating = (): boolean => this.animation.kind === "active";

  setOpeningTarget(opening: FloorPlanOpening, target: 0 | 1): void {
    const key = this.key(opening);
    const previous = this.openings.get(key);
    const prevTarget: 0 | 1 = previous?.target ?? 0;
    const start = target === 1 ? 0 : (previous?.progress ?? 0);
    const limit =
      opening.kind === "door"
        ? maxUnobstructedDoorProgress(
            opening.door,
            start,
            target,
            this.applianceBoxes(opening.planId),
          )
        : target;
    this.openings.set(key, { opening, target, limit, progress: limit });
    this.saveToStorage();
    this.notifyOpenings(opening.planId);
    if (prevTarget !== target) {
      this.recordHistory({
        label: target === 1 ? `Open ${opening.kind}` : `Close ${opening.kind}`,
        undo: () => this.setOpeningTarget(opening, prevTarget),
        redo: () => this.setOpeningTarget(opening, target),
      });
    }
  }

  toggleOpening(opening: FloorPlanOpening): void {
    const key = this.key(opening);
    const previous = this.openings.get(key);
    const prevTarget: 0 | 1 = previous?.target ?? 0;
    const target: 0 | 1 = prevTarget === 1 ? 0 : 1;
    const progress = previous?.progress ?? 0;
    const limit =
      opening.kind === "door"
        ? maxUnobstructedDoorProgress(
            opening.door,
            progress,
            target,
            this.applianceBoxes(opening.planId),
          )
        : target;
    this.openings.set(key, { opening, target, limit, progress });
    this.recordHistory({
      label: target === 1 ? `Open ${opening.kind}` : `Close ${opening.kind}`,
      undo: () => this.setOpeningTarget(opening, prevTarget),
      redo: () => this.setOpeningTarget(opening, target),
    });
    if (
      typeof requestAnimationFrame !== "function" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      this.openings.set(key, { opening, target, limit, progress: limit });
      this.saveToStorage();
      this.notifyOpenings(opening.planId);
      return;
    }
    if (this.animation.kind === "idle") {
      this.animation = {
        kind: "active",
        time: performance.now(),
        frame: requestAnimationFrame(this.step),
      };
    }
  }

  reloadFromStorage(preserveActivePlan = false): void {
    if (typeof window === "undefined") return;
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(FLOOR_PLAN_WORKSPACE_STORAGE_KEY);
    } catch {
      return;
    }
    if (raw === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(parsed) || parsed.version !== 1) return;
    if (!preserveActivePlan && isFloorPlanId(parsed.activePlan)) {
      this.activePlan = parsed.activePlan;
    }
    if (isRecord(parsed.placements)) {
      this.placements.clear();
      for (const planId of BAKERY_FLOOR_PLAN_ORDER) {
        const planPlacements = parsed.placements[planId];
        if (!isRecord(planPlacements)) continue;
        const map = new Map<ApplianceId, AppliancePose>();
        for (const [id, pose] of Object.entries(planPlacements)) {
          if (
            !isApplianceId(id) ||
            !isRecord(pose) ||
            typeof pose.x !== "number" ||
            !Number.isFinite(pose.x) ||
            typeof pose.z !== "number" ||
            !Number.isFinite(pose.z) ||
            typeof pose.rotY !== "number" ||
            !Number.isFinite(pose.rotY)
          ) {
            continue;
          }
          map.set(id, { id, x: pose.x, z: pose.z, rotY: pose.rotY });
        }
        if (map.size > 0) this.placements.set(planId, map);
      }
    }
    if (isRecord(parsed.openings)) {
      this.openings.clear();
      for (const [key, entry] of Object.entries(parsed.openings)) {
        const colon = key.indexOf(":");
        if (colon <= 0) continue;
        const rawPlanId = key.slice(0, colon);
        const rawOpeningId = key.slice(colon + 1);
        if (!isFloorPlanId(rawPlanId) || !isRecord(entry)) continue;
        const opening = findFloorPlanOpening(rawPlanId, rawOpeningId);
        if (
          opening === null ||
          (entry.target !== 0 && entry.target !== 1) ||
          typeof entry.progress !== "number" ||
          !Number.isFinite(entry.progress) ||
          entry.progress < 0 ||
          entry.progress > 1
        ) {
          continue;
        }
        const limit =
          opening.kind === "door"
            ? maxUnobstructedDoorProgress(
                opening.door,
                entry.target === 1 ? 0 : entry.progress,
                entry.target,
                this.applianceBoxes(rawPlanId),
              )
            : entry.target;
        const progress =
          entry.target === 1
            ? Math.min(entry.progress, limit)
            : Math.max(entry.progress, limit);
        this.openings.set(this.key(opening), {
          opening,
          target: entry.target,
          limit,
          progress,
        });
      }
    }
    this.history.refresh();
  }

  private saveToStorage(): void {
    if (typeof window === "undefined") return;
    try {
      const placements: Record<
        string,
        Record<string, { x: number; z: number; rotY: number }>
      > = {};
      for (const [planId, map] of this.placements.entries()) {
        if (map.size === 0) continue;
        const planRecord: Record<
          string,
          { x: number; z: number; rotY: number }
        > = {};
        for (const [id, pose] of map.entries()) {
          planRecord[id] = { x: pose.x, z: pose.z, rotY: pose.rotY };
        }
        placements[planId] = planRecord;
      }
      const openings: Record<string, { target: 0 | 1; progress: number }> = {};
      for (const [key, state] of this.openings.entries()) {
        if (state.target === 0 && state.progress === 0) continue;
        openings[key] = {
          target: state.target,
          progress: Number(state.progress.toFixed(3)),
        };
      }
      window.localStorage.setItem(
        FLOOR_PLAN_WORKSPACE_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          activePlan: this.activePlan,
          placements,
          openings,
        }),
      );
    } catch {
      // Ignore storage quota or restricted-context failures.
    }
  }

  readonly subscribeOpenings = (
    listener: (planId: BakeryFloorPlanId) => void,
  ): (() => void) => {
    this.openingListeners.add(listener);
    return this.unsubscribeOpenings.bind(this, listener);
  };

  private unsubscribeOpenings(
    listener: (planId: BakeryFloorPlanId) => void,
  ): void {
    this.openingListeners.delete(listener);
    if (this.openingListeners.size === 0 && this.animation.kind === "active") {
      cancelAnimationFrame(this.animation.frame);
      this.animation = { kind: "idle" };
      for (const state of this.openings.values()) state.progress = state.limit;
      this.saveToStorage();
    }
  }

  private key(opening: FloorPlanOpening): string {
    return `${opening.planId}:${openingId(opening)}`;
  }

  private notifyOpenings(planId: BakeryFloorPlanId): void {
    this.openingVersion += 1;
    for (const listener of this.openingListeners) listener(planId);
  }

  private readonly step = (now: number): void => {
    if (this.animation.kind === "idle") return;
    const delta = Math.min(0.06, (now - this.animation.time) / 1000) * 4.6;
    const changed = new Set<BakeryFloorPlanId>();
    let active = false;
    for (const state of this.openings.values()) {
      if (state.progress === state.limit) continue;
      const direction = Math.sign(state.limit - state.progress);
      state.progress +=
        direction * Math.min(delta, Math.abs(state.limit - state.progress));
      changed.add(state.opening.planId);
      if (state.progress !== state.limit) active = true;
    }
    this.animation = active
      ? { kind: "active", time: now, frame: requestAnimationFrame(this.step) }
      : { kind: "idle" };
    if (!active) this.saveToStorage();
    for (const planId of changed) this.notifyOpenings(planId);
  };
}

function urlFloorPlan(): BakeryFloorPlanId | null {
  if (typeof window !== "undefined") {
    const value = new URLSearchParams(window.location.search).get("floorPlan");
    if (isFloorPlanId(value)) return value;
  }
  return null;
}

const initialUrlPlan = urlFloorPlan();

export const floorPlanWorkspace = new FloorPlanWorkspace(
  initialUrlPlan ?? "asakusabashi-t101940",
  initialUrlPlan !== null,
);

export const canUndo = floorPlanWorkspace.canUndo;
export const canRedo = floorPlanWorkspace.canRedo;
export const undo = floorPlanWorkspace.undo;
export const redo = floorPlanWorkspace.redo;
export const jumpToSimulatorHistory = floorPlanWorkspace.jumpToHistory;
export const clearSimulatorHistory = floorPlanWorkspace.clearHistory;
export const resetSimulatorToInitialLayout =
  floorPlanWorkspace.resetToInitialLayout;
export const subscribeSimulatorHistory = floorPlanWorkspace.subscribeHistory;

export function useSimulatorHistory(): SimulatorHistorySnapshot &
  Readonly<{
    undo: () => boolean;
    redo: () => boolean;
    jumpTo: (targetIndex: number) => number;
    clear: () => void;
    resetLayout: () => void;
  }> {
  return useSimulatorHistoryStore(floorPlanWorkspace.history);
}
