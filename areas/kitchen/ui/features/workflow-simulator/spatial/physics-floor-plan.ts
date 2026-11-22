import type { PhysicsSceneReplay } from "@purin-labs/production-simulation/recipes/bakery/physics-playback";
import { PhysicsInspection, type PhysicsFrame } from "./physics-inspection";
import * as THREE from "three";
import type { PhysicsModel } from "./physics-model";
import type { FloorPlan } from "./floor-plan";
import type { WorkcellSelection } from "@purin-labs/production-simulation/simulator/selection";
import { RehearsalBakery } from "./rehearsal-bakery";

/** CPU geometry remains inspectable when WebGL cannot initialize or is lost. */
export class PhysicsFloorPlan {
  private readonly inspection: PhysicsInspection;
  private get model(): PhysicsModel {
    return this.inspection.model;
  }
  private get guide() {
    return this.inspection.guide;
  }
  /** The same assumed stations the 3D view shows, loaded without WebGL. */
  private readonly bakery = new RehearsalBakery();
  private selection: WorkcellSelection | null = null;
  private seconds = 0;
  private disposed = false;

  constructor(
    private readonly host: HTMLElement,
    recording: PhysicsSceneReplay,
    private readonly select: (selection: WorkcellSelection) => void,
    private readonly plan: FloorPlan<WorkcellSelection>,
    pause: (() => void) | null,
    controlDoorPreview: ((degrees: number | null) => void) | null,
  ) {
    host.classList.add("physics-floor-plan-only");
    this.inspection = new PhysicsInspection(
      recording,
      plan,
      this.inspect.bind(this),
      pause,
      this.refresh.bind(this),
      controlDoorPreview,
    );
    const scene = new THREE.Scene();
    scene.add(this.model.root);
    plan.bindScene(scene);
    plan.setOpen(true);
    this.update({
      seconds: 0,
      workcell: { kind: "empty" },
      layout: null,
      trays: null,
    });
    void this.inspection.loadFallback();
    void this.bakery.load().then(this.contextLoaded.bind(this), ignoreContext);
  }

  closeInspection(): void {
    this.inspection.closeDoor();
  }

  get doorAvailable(): boolean {
    return this.inspection.doorAvailable;
  }

  setDoorPreview(degrees: number | null): void {
    if (this.inspection.setDoorPreview(degrees)) this.refresh();
  }

  inspect(selection: WorkcellSelection): void {
    this.setSelection(selection);
    this.select(selection);
  }

  setSelection(selection: WorkcellSelection | null): void {
    if (selection === this.selection) return;
    this.selection = selection;
    this.refresh();
  }

  get layoutControls(): HTMLElement {
    return this.plan.layoutControls;
  }

  update(frame: PhysicsFrame): void {
    if (frame.motion !== undefined)
      this.model.setPersistentMotion(frame.motion);
    const { seconds, workcell, layout } = frame;
    if (this.seconds !== seconds) this.inspection.resetDoor();
    this.seconds = seconds;
    if (workcell.kind === "active") this.selection = workcell.selection;
    this.model.update(seconds);
    this.inspection.setPlacement(layout);
    this.guide.update(workcell);
    this.refresh();
  }

  private contextLoaded(): void {
    if (!this.disposed) this.refresh();
  }

  private refresh(): void {
    this.guide.refreshAnchors();
    this.plan.update(
      [...this.model.floorPlanItems(), ...this.bakery.floorPlanItems()],
      this.selection?.kind === "resource" ? [this.selection.id] : [],
      this.inspection.findings(this.seconds),
    );
  }

  dispose(): void {
    this.disposed = true;
    this.bakery.dispose();
    this.inspection.dispose();
    this.host.classList.remove("physics-floor-plan-only");
  }
}

/** Context is optional orientation; the workcell plan stands without it. */
function ignoreContext(): void {}
