import type { PhysicsSceneReplay } from "@seams/production-simulation/recipes/bakery/physics-playback";
import type { FitFinding } from "./floor-plan-geometry";
import type { WorkcellView } from "@seams/production-simulation/simulator/workcell-view";
import type {
  PhysicsLayout,
  PersistentPhysicsMotion,
} from "@seams/bakery-model/bakery-physics";
import { PhysicsModel, disposePhysicsObject } from "./physics-model";
import { TaskSpatialGuide } from "./task-spatial-guide";
import { DoorInspection } from "./door-inspection";
import type { FloorPlan } from "./floor-plan";
import type { WorkcellSelection } from "@seams/production-simulation/simulator/selection";
import { robotCellPosition } from "@seams/production-simulation/simulator/rehearsal-spatial";
import { sceneLegAt } from "@seams/production-simulation/recipes/bakery/physics-playback";
import { COLD_CELL } from "@seams/production-simulation/recipes/bakery/workcell-instances";
import ovenUrl from "../../../../../../assets/bakery-mujoco/maruzen-mbco-5e/maruzen-mbco-5e.glb?url";

export type RackLayoutPresentation = Readonly<{
  applied: PhysicsLayout;
  draft: PhysicsLayout | null;
  move: ((xMm: number, yMm: number) => void) | null;
  setup: boolean;
  checks: readonly FitFinding[];
}>;

export type TrayMarker = Readonly<{
  id: string;
  operationId: string;
  label: string;
  holding: boolean;
  active: boolean;
}>;
export type TrayPresentation = Readonly<{
  markers: readonly TrayMarker[];
  select(id: string): void;
  recordedTray: boolean;
  selectedTrayId: string | null;
}>;

export type PhysicsFrame = Readonly<{
  seconds: number;
  workcell: WorkcellView;
  layout: RackLayoutPresentation | null;
  trays: TrayPresentation | null;
  /** Disposable live samples with the same validated scene mappings. */
  motion?: PersistentPhysicsMotion;
}>;

/** Model and inspection controls shared by WebGL and CPU presentations. */
export class PhysicsInspection {
  readonly model: PhysicsModel;
  readonly guide: TaskSpatialGuide;
  private readonly abort = new AbortController();
  private door: DoorInspection | null = null;
  private unavailable: HTMLElement | null = null;
  private placement: RackLayoutPresentation | null = null;

  constructor(
    recording: PhysicsSceneReplay,
    private readonly plan: FloorPlan<WorkcellSelection>,
    select: (selection: WorkcellSelection) => void,
    private readonly pause: (() => void) | null,
    private readonly changed: () => void,
    private readonly controlDoorPreview:
      ((degrees: number | null) => void) | null,
  ) {
    this.model = new PhysicsModel(recording);
    this.model.root.position.set(...robotCellPosition);
    this.guide = new TaskSpatialGuide(this.model, select);
    plan.addInspectionControl(this.guide.element);
  }

  async loadOven(): Promise<void> {
    const fixture = sceneLegAt(this.model.recording, 0).recording.fixture;
    if (fixture.kind === "rack") return;
    const { loadVisual } = await import("./physics-asset-loader");
    if (this.abort.signal.aborted) return;
    const visual = await loadVisual(
      ovenUrl,
      fixture.glbSha256,
      this.abort.signal,
    );
    if (this.abort.signal.aborted) {
      visual.traverse(disposePhysicsObject);
      return;
    }
    try {
      this.model.attachOven(visual);
    } catch (error) {
      visual.traverse(disposePhysicsObject);
      throw error;
    }
    if (this.pause !== null) {
      this.door = new DoorInspection(
        this.model,
        this.pause,
        this.changed,
        this.controlDoorPreview,
      );
      this.plan.addInspectionControl(this.door.element);
    }
  }

  async loadFallback(): Promise<void> {
    try {
      await this.loadOven();
    } catch {
      if (this.abort.signal.aborted) return;
      this.unavailable = document.createElement("p");
      this.unavailable.textContent =
        "Door opening unchecked: verified hinge geometry could not be loaded.";
      this.plan.addInspectionControl(this.unavailable);
    }
    if (!this.abort.signal.aborted) this.changed();
  }

  setPlacement(layout: RackLayoutPresentation | null): void {
    const previous = this.placement;
    if (
      layout !== null &&
      (previous === null ||
        previous.applied !== layout.applied ||
        previous.draft !== layout.draft)
    ) {
      this.model.showRackLayout(layout.applied, layout.draft);
    } else if (layout === null && previous !== null) {
      this.model.showRackLayout(
        sceneLegAt(this.model.recording, 0).recording.request.layout,
        null,
      );
    }
    this.placement = layout;
    const move = layout?.move ?? null;
    this.plan.setPlacement(
      move === null
        ? null
        : { id: COLD_CELL.skills["table-to-rack"].destination, move },
    );
  }

  findings(seconds: number): readonly FitFinding[] {
    return [
      ...this.model.floorPlanFindings(seconds),
      ...(this.placement?.checks ?? []),
    ];
  }

  resetDoor(): boolean {
    return this.door?.reset() ?? false;
  }

  get doorAvailable(): boolean {
    return this.door !== null;
  }

  setDoorPreview(degrees: number | null): boolean {
    return this.door?.setPreview(degrees) ?? false;
  }

  closeDoor(): void {
    this.door?.close();
  }

  dispose(): void {
    this.abort.abort();
    this.guide.dispose();
    this.door?.element.remove();
    this.unavailable?.remove();
    this.model.dispose();
  }
}
