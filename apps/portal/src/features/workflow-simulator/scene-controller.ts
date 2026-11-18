import type { SceneFrame, SceneViewListener } from "./scene";
import type { Selection } from "@seams/production-simulation/simulator/selection";

export type ScenePort = Readonly<{
  load(): Promise<void>;
  update(frame: SceneFrame): void;
  resetView(): void;
  dispose(): void;
}>;

/** `details` is a shell panel that hosts the floor plan's details. */
export type SceneFactory = (
  host: HTMLDivElement,
  frame: SceneFrame,
  select: (selection: Selection, focus: "inspector" | "unchanged") => void,
  view?: SceneViewListener,
  details?: HTMLElement,
) => ScenePort;

export type SceneFactoryLoader = () => Promise<SceneFactory>;

export type SceneStatusListener = (status: "ready" | "unavailable") => void;

export class SceneController {
  private readonly loadFactory: SceneFactoryLoader;
  private scene: ScenePort | null = null;
  private last: SceneFrame | null = null;
  private mounted = false;
  private generation = 0;

  constructor(loadFactory: SceneFactoryLoader = loadSceneFactory) {
    this.loadFactory = loadFactory;
  }

  mount(
    host: HTMLDivElement,
    frame: SceneFrame,
    select: (selection: Selection, focus: "inspector" | "unchanged") => void,
    status: SceneStatusListener,
    view?: SceneViewListener,
    details?: HTMLElement,
  ): void {
    this.dispose();
    this.mounted = true;
    this.last = frame;
    const generation = ++this.generation;
    void this.loadFactory()
      .then(
        this.attach.bind(
          this,
          generation,
          host,
          frame,
          select,
          status,
          view,
          details,
        ),
      )
      .catch(this.failed.bind(this, generation, status));
  }

  /**
   * The live playback time and a React update can send the same frame at a
   * run event; the scene draws it one time.
   */
  update(frame: SceneFrame): void {
    if (this.scene !== null && sameFrame(this.last, frame)) return;
    this.last = frame;
    this.scene?.update(frame);
  }

  resetView(): void {
    this.scene?.resetView();
  }

  dispose(): void {
    this.mounted = false;
    this.generation++;
    this.scene?.dispose();
    this.scene = null;
  }

  private attach(
    generation: number,
    host: HTMLDivElement,
    frame: SceneFrame,
    select: (selection: Selection, focus: "inspector" | "unchanged") => void,
    status: SceneStatusListener,
    view: SceneViewListener | undefined,
    details: HTMLElement | undefined,
    factory: SceneFactory,
  ): void {
    if (!this.active(generation)) {
      return;
    }
    const scene = factory(host, frame, select, view, details);
    this.scene = scene;
    void scene
      .load()
      .then(this.ready.bind(this, generation, status))
      .catch(this.failed.bind(this, generation, status));
  }

  private ready(generation: number, status: SceneStatusListener): void {
    if (this.active(generation)) {
      status("ready");
    }
  }

  private failed(generation: number, status: SceneStatusListener): void {
    if (!this.active(generation)) {
      return;
    }
    this.scene?.dispose();
    this.scene = null;
    status("unavailable");
  }

  private active(generation: number): boolean {
    return this.mounted && generation === this.generation;
  }
}

async function loadSceneFactory(): Promise<SceneFactory> {
  const module = await import("./scene");
  return createBakeryScene.bind(null, module);
}

function createBakeryScene(
  module: typeof import("./scene"),
  host: HTMLDivElement,
  frame: SceneFrame,
  select: (selection: Selection, focus: "inspector" | "unchanged") => void,
  view?: SceneViewListener,
  details?: HTMLElement,
): ScenePort {
  return new module.BakeryScene(host, frame, select, view, details);
}

function sameFrame(a: SceneFrame | null, b: SceneFrame): boolean {
  return (
    a !== null &&
    a.run === b.run &&
    a.time === b.time &&
    a.selection === b.selection &&
    a.top === b.top &&
    a.labels === b.labels &&
    a.floorPlan?.open === b.floorPlan?.open &&
    a.floorPlan?.minimap === b.floorPlan?.minimap
  );
}
