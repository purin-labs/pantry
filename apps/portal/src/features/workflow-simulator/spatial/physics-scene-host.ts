import type { PhysicsSceneReplay } from "@seams/production-simulation/recipes/bakery/physics-playback";
import type { BakeryRecordingCameraView } from "@seams/bakery-model/bakery-surface";
import * as THREE from "three";
import type { PhysicsScene } from "./physics-scene";
import type {
  PhysicsFactoryScene,
  FactorySceneSource,
} from "./physics-factory-scene";
import { PhysicsFloorPlan } from "./physics-floor-plan";
import { FloorPlan } from "./floor-plan";
import type { RecordedFitEvent } from "./floor-plan-geometry";
import type { WorkcellSelection } from "@seams/production-simulation/simulator/selection";
import { assertNever } from "@seams/std";
import type { StrictUnion } from "@seams/type-utils";

type Options = Readonly<{
  fallback: "floor-plan" | "message";
  camera: "reset" | "preserve" | "cell";
  select(selection: WorkcellSelection): void;
  changed(status: "empty" | "loading" | "ready" | "unavailable"): void;
  inspectEvent: ((event: RecordedFitEvent) => void) | null;
  pause: (() => void) | null;
  controlCamera?: (camera: BakeryRecordingCameraView["camera"]) => void;
  controlDoorPreview?: (degrees: number | null) => void;
}>;

export type PhysicsSceneLife = StrictUnion<
  | Readonly<{ kind: "empty" | "disposed" }>
  | Readonly<{
      kind: "factory";
      generation: number;
      scene: PhysicsFactoryScene;
    }>
  | Readonly<{ kind: "loading-source"; generation: number }>
  | Readonly<{
      kind: "loading-renderer";
      generation: number;
      source: PhysicsSceneReplay;
    }>
  | Readonly<{
      kind: "loading-assets" | "ready";
      generation: number;
      source: PhysicsSceneReplay;
      scene: PhysicsScene;
    }>
  | Readonly<{
      kind: "fallback";
      generation: number;
      source: PhysicsSceneReplay;
      scene: PhysicsFloorPlan;
    }>
  | Readonly<{
      kind: "unavailable";
      generation: number;
      source: PhysicsSceneReplay | null;
    }>
>;

/** Owns one presentation generation and a persistent floor plan for one mounted view. */
export class PhysicsSceneHost {
  private controls: HTMLDivElement | null = null;
  get layoutControls(): HTMLDivElement {
    this.controls ??= document.createElement("div");
    return this.controls;
  }
  private life: PhysicsSceneLife = { kind: "empty" };
  private generation = 0;
  private plan: FloorPlan<WorkcellSelection> | null = null;
  private element: HTMLElement | null = null;

  constructor(private readonly options: Options) {}

  get webgl(): PhysicsScene | null {
    return this.life.kind === "ready" || this.life.kind === "loading-assets"
      ? this.life.scene
      : null;
  }

  get fallback(): PhysicsFloorPlan | null {
    return this.life.kind === "fallback" ? this.life.scene : null;
  }

  get factory(): PhysicsFactoryScene | null {
    return this.life.kind === "factory" ? this.life.scene : null;
  }

  async loadFactory(
    element: HTMLElement,
    source: FactorySceneSource,
    selectCell: (cell: string) => void,
    view: "floor" | "perspective",
  ): Promise<void> {
    this.clear();
    const generation = ++this.generation;
    this.life = { kind: "loading-source", generation };
    this.options.changed("loading");
    try {
      const { PhysicsFactoryScene } = await import("./physics-factory-scene");
      if (!this.current(generation)) return;
      const scene = new PhysicsFactoryScene(
        element,
        source,
        selectCell,
        this.factoryChanged.bind(this, generation),
        view,
      );
      this.life = { kind: "factory", generation, scene };
      scene.mount();
    } catch {
      if (this.current(generation)) this.unavailable(generation);
    }
  }

  private factoryChanged(
    generation: number,
    status: "ready" | "unavailable",
  ): void {
    if (!this.current(generation)) return;
    if (status === "unavailable") this.unavailable(generation);
    else this.options.changed(status);
  }

  get source(): PhysicsSceneReplay | null {
    switch (this.life.kind) {
      case "empty":
      case "disposed":
      case "factory":
      case "loading-source":
        return null;
      case "loading-renderer":
      case "loading-assets":
      case "ready":
      case "fallback":
      case "unavailable":
        return this.life.source;
      default:
        return assertNever(this.life, "Unknown scene lifecycle");
    }
  }

  async load(
    element: HTMLElement,
    source: PhysicsSceneReplay | Promise<PhysicsSceneReplay>,
  ): Promise<void> {
    const camera =
      this.options.camera === "preserve"
        ? (this.webgl?.cameraView() ?? null)
        : null;
    this.generation++;
    this.releasePresentation();
    this.life = { kind: "empty" };
    this.plan?.update([], [], []);
    if (this.element !== element) {
      this.plan?.dispose();
      this.element = element;
      this.plan = new FloorPlan(
        element,
        new THREE.Scene(),
        this.select.bind(this),
        this.focus.bind(this),
        this.chooseCamera.bind(this, "perspective"),
        [
          {
            label: "Selected task",
            show: this.chooseCamera.bind(this, "task"),
          },
          {
            label: "Top view",
            show: this.chooseCamera.bind(this, "inspectionOverhead"),
          },
          {
            label: "Operator height · 1.6 m",
            show: this.chooseCamera.bind(this, "operator"),
          },
        ],
        {
          layoutControls: this.layoutControls,
          inspectEvent: this.options.inspectEvent ?? undefined,
          closed: this.closeInspection.bind(this),
        },
      );
    }
    const plan = this.plan;
    if (plan === null) return;
    plan.setVisible(true);
    const generation = ++this.generation;
    this.life = { kind: "loading-source", generation };
    this.options.changed("loading");
    try {
      const recording = await source;
      if (!this.current(generation)) return;
      this.life = { kind: "loading-renderer", generation, source: recording };
      const { PhysicsScene } = await import("./physics-scene");
      if (!this.current(generation)) return;
      const scene = new PhysicsScene(
        element,
        recording,
        this.unavailable.bind(this, generation),
        this.selected.bind(this, generation),
        plan,
        {
          inspectEvent: this.options.inspectEvent ?? undefined,
          pause: this.options.pause ?? undefined,
          controlDoorPreview:
            this.options.controlDoorPreview === undefined
              ? undefined
              : this.previewDoor.bind(this, generation),
        },
      );
      this.life = {
        kind: "loading-assets",
        generation,
        source: recording,
        scene,
      };
      await scene.load();
      if (!this.current(generation) || this.life.kind !== "loading-assets")
        return;
      if (camera !== null) scene.restoreCamera(camera);
      else if (this.options.camera === "cell") scene.focusCell();
      this.life = { kind: "ready", generation, source: recording, scene };
      this.options.changed("ready");
    } catch {
      if (this.current(generation)) this.unavailable(generation);
    }
  }

  /** Frames equipment in the floor plan; see FloorPlan.frame. */
  framePlan(ids: readonly string[]): void {
    this.plan?.frame(ids);
  }

  private current(generation: number): boolean {
    return this.life.kind !== "disposed" && generation === this.generation;
  }

  private unavailable(generation: number): void {
    if (!this.current(generation)) return;
    const source = this.source;
    this.releasePresentation();
    const next = ++this.generation;
    if (
      source !== null &&
      this.element !== null &&
      this.plan !== null &&
      this.options.fallback === "floor-plan"
    ) {
      try {
        const scene = new PhysicsFloorPlan(
          this.element,
          source,
          this.selected.bind(this, next),
          this.plan,
          this.options.pause,
          this.options.controlDoorPreview === undefined
            ? null
            : this.previewDoor.bind(this, next),
        );
        this.life = { kind: "fallback", generation: next, source, scene };
      } catch {
        this.life = { kind: "unavailable", generation: next, source };
        this.plan.setVisible(false);
      }
    } else {
      this.life = { kind: "unavailable", generation: next, source };
      this.plan?.setVisible(false);
    }
    this.options.changed("unavailable");
  }

  clear(): void {
    if (this.life.kind === "disposed") return;
    this.generation++;
    this.releasePresentation();
    this.life = { kind: "empty" };
    this.plan?.update([], [], []);
    this.plan?.setVisible(false);
  }

  dispose(): void {
    this.clear();
    this.life = { kind: "disposed" };
    this.plan?.dispose();
    this.plan = null;
    this.element = null;
  }

  private releasePresentation(): void {
    switch (this.life.kind) {
      case "loading-assets":
      case "ready":
      case "fallback":
      case "factory":
        this.life.scene.dispose();
        return;
      case "empty":
      case "disposed":
      case "loading-source":
      case "loading-renderer":
      case "unavailable":
        return;
      default:
        return assertNever(this.life, "Unknown scene lifecycle");
    }
  }

  private selected(generation: number, selection: WorkcellSelection): void {
    if (this.current(generation)) this.options.select(selection);
  }
  private previewDoor(generation: number, degrees: number | null): void {
    if (this.current(generation)) this.options.controlDoorPreview?.(degrees);
  }
  private select(selection: WorkcellSelection): void {
    if (this.webgl !== null) this.webgl.inspectResource(selection);
    else this.fallback?.inspect(selection);
  }
  setSelection(selection: WorkcellSelection | null): void {
    this.webgl?.setSelection(selection);
    this.fallback?.setSelection(selection);
  }
  get doorAvailable(): boolean {
    return (this.webgl ?? this.fallback)?.doorAvailable === true;
  }

  setDoorPreview(degrees: number | null): void {
    this.webgl?.setDoorPreview(degrees);
    this.fallback?.setDoorPreview(degrees);
  }
  cameraAvailable(camera: BakeryRecordingCameraView["camera"]): boolean {
    return (
      this.life.kind === "ready" &&
      (camera !== "selection" ||
        (this.plan !== null && !this.plan.selectionBounds().isEmpty()))
    );
  }

  setCamera(camera: BakeryRecordingCameraView["camera"]): void {
    const scene = this.webgl;
    const plan = this.plan;
    if (scene === null || plan === null) return;
    switch (camera) {
      case "perspective":
      case "overhead":
        scene.setCamera(camera);
        break;
      case "inspectionOverhead":
        scene.topView(plan.selectionBounds());
        break;
      case "cell":
        scene.focusCell();
        break;
      case "task":
        scene.focusTask();
        break;
      case "selection":
        scene.focusBounds(plan.selectionBounds());
        break;
      case "operator":
        scene.operatorView(plan.selectionBounds());
        break;
      default:
        assertNever(camera);
    }
  }

  private focus(bounds: THREE.Box3): void {
    if (this.options.controlCamera !== undefined)
      this.chooseCamera("selection");
    else this.webgl?.focusBounds(bounds);
  }

  private chooseCamera(camera: BakeryRecordingCameraView["camera"]): void {
    if (!this.cameraAvailable(camera)) return;
    if (this.options.controlCamera !== undefined)
      this.options.controlCamera(camera);
    else this.setCamera(camera);
  }
  private closeInspection(): void {
    this.webgl?.closeInspection();
    this.fallback?.closeInspection();
  }
}
