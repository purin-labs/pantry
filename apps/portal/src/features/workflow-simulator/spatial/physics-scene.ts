import type { PhysicsSceneReplay } from "@purin-labs/production-simulation/recipes/bakery/physics-playback";
import { createBakeryGrid } from "./bakery-grid";
import {
  sceneLegAt,
  physicsLegAt,
} from "@purin-labs/production-simulation/recipes/bakery/physics-playback";
import {
  PhysicsInspection,
  type PhysicsFrame,
  type TrayPresentation,
} from "./physics-inspection";
import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SceneHost } from "../../production-run/scene-host";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { loadRobotVisual } from "./physics-robot-visual";
import {
  disposeWorkcellVisualBundle,
  loadWorkcellVisuals,
} from "./physics-workcell-visuals";
import { PhysicsModel, disposePhysicsObject } from "./physics-model";
import type { WorkcellSelection } from "@purin-labs/production-simulation/simulator/selection";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { RehearsalBakery } from "./rehearsal-bakery";
import { floorPlanWorkspace } from "../floor-plan-workspace";
import {
  setupBakeryLightingAndPost,
  type BakeryLightingRig,
} from "./scene-lighting";
import { sceneLabel, arrangeLabels } from "../scene-labels";
import { robotCellPosition } from "@purin-labs/production-simulation/simulator/rehearsal-spatial";
import { FloorPlan } from "./floor-plan";
import { COLD_CELL } from "@purin-labs/production-simulation/recipes/bakery/workcell-instances";
import type { RecordedFitEvent } from "./floor-plan-geometry";

// The Robot cell's instances, by their role in its two skills.
const RACK = COLD_CELL.skills["table-to-rack"];
const OVEN = COLD_CELL.skills["table-to-oven"];

export type PhysicsCameraView = Readonly<{
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  /** Present for the top view: its visible half-depth in metres and zoom. */
  orthographic?: Readonly<{ halfHeight: number; zoom: number }>;
}>;

export class PhysicsScene {
  private readonly host: SceneHost;
  private readonly scene: THREE.Scene;
  private readonly perspective = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  /** Top view only, so camera height never changes apparent floor scale. */
  private readonly orthographic = new THREE.OrthographicCamera(
    -1,
    1,
    1,
    -1,
    0.01,
    100,
  );
  private get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.host.camera;
  }
  private orthographicHalfHeight = 1;
  private readonly lighting: BakeryLightingRig;
  private readonly controls: OrbitControls;
  private readonly abort = new AbortController();
  private readonly inspectionModel: PhysicsInspection;
  private get model(): PhysicsModel {
    return this.inspectionModel.model;
  }
  private get taskGuide() {
    return this.inspectionModel.guide;
  }
  private inspectedSelection: WorkcellSelection | null = null;
  private readonly bakery = new RehearsalBakery(() => {
    if (!this.disposed) {
      this.updateFloorPlan();
      this.render();
    }
  });
  private readonly labels = new CSS2DRenderer();
  private readonly cellLabel = sceneLabel("Robot cell · Recorded motion");
  private readonly trays = new THREE.Group();
  private readonly trayMarkers = new Map<
    string,
    Readonly<{ mesh: THREE.Mesh; label: ReturnType<typeof sceneLabel> }>
  >();
  private selectTray: ((id: string) => void) | null = null;
  private disposed = false;
  private frame: PhysicsFrame = {
    seconds: 0,
    workcell: { kind: "empty" },
    layout: null,
    trays: null,
  };
  private get time() {
    return this.frame.seconds;
  }
  private get workcell() {
    return this.frame.workcell;
  }
  private readonly highlight = new THREE.Box3Helper(new THREE.Box3(), 0x26362e);
  private pointer: Readonly<{ id: number; x: number; y: number }> | null = null;

  showContactShapes(names: ReadonlySet<string>): number {
    const count = this.model.showContactShapes(names);
    this.render();
    return count;
  }

  constructor(
    host: HTMLElement,
    recording: PhysicsSceneReplay,
    private readonly unavailable: () => void,
    private readonly select: (selection: WorkcellSelection) => void,
    private readonly floorPlan: FloorPlan<WorkcellSelection>,
    inspection: Readonly<{
      inspectEvent?: (event: RecordedFitEvent) => void;
      pause?: () => void;
      controlDoorPreview?: (degrees: number | null) => void;
    }> = {},
  ) {
    this.host = new SceneHost({
      view: this.floorPlan.viewport,
      camera: this.perspective,
      renderer: { antialias: true, alpha: true },
      attach: "none",
      pointer: "pan",
      size: { buffer: "settle" },
      resized: this.resized.bind(this),
      draw: this.draw.bind(this),
      disposeContent: false,
    });
    this.scene = this.host.scene;
    this.controls = this.host.orbit;
    this.floorPlan.bindScene(this.scene);
    this.floorPlan.onFitInspectionChange(this.fitInspectionChanged.bind(this));
    this.inspectionModel = new PhysicsInspection(
      recording,
      floorPlan,
      this.inspectResource.bind(this),
      inspection.pause ?? null,
      this.doorChanged.bind(this),
      inspection.controlDoorPreview ?? null,
    );
    this.scene.add(
      this.model.root,
      this.bakery.root,
      this.cellLabel,
      this.trays,
    );
    this.cellLabel.position.set(
      robotCellPosition[0],
      2.2,
      robotCellPosition[2],
    );
    this.labels.domElement.className = "workflow-scene-labels";
    this.labels.domElement.setAttribute("aria-hidden", "true");
    this.highlight.visible = false;
    this.scene.add(this.highlight);
    this.lighting = setupBakeryLightingAndPost(
      this.host.renderer,
      this.scene,
      this.camera,
      {
        exteriorShadowPlaneY:
          floorPlanWorkspace.getActivePlan() === "reference" ? -0.112 : -0.092,
      },
    );
    this.lighting.setDarkTheme(
      document.documentElement.dataset.portalTheme === "dark",
    );
    this.host.canvas.setAttribute(
      "aria-label",
      "Bakery and recorded robot cell. Workflow, Timeline and Details provide equivalent task and resource controls.",
    );
    const grid = createBakeryGrid();
    this.scene.add(grid);
    this.floorPlan.viewport.append(this.host.canvas, this.labels.domElement);
    this.scene.add(this.taskGuide.root);
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 50;
    this.controls.minZoom = 0.25;
    this.controls.maxZoom = 40;
    this.render = this.render.bind(this);
    this.contextLost = this.contextLost.bind(this);
    this.pointerDown = this.pointerDown.bind(this);
    this.pointerUp = this.pointerUp.bind(this);
    this.pointerCancel = this.pointerCancel.bind(this);
    const canvas = this.host.canvas;
    const signal = this.abort.signal;
    canvas.addEventListener("pointerdown", this.pointerDown, { signal });
    canvas.addEventListener("pointerup", this.pointerUp, { signal });
    canvas.addEventListener("pointercancel", this.pointerCancel, { signal });
    canvas.addEventListener("webglcontextlost", this.contextLost, { signal });
    this.resetView();
    this.host.resize();
  }

  async load(): Promise<void> {
    await Promise.all([this.loadCell(), this.bakery.load()]);
    if (this.disposed) return;
    this.update(this.frame);
    this.resetView();
  }

  private async loadCell(): Promise<void> {
    const selected = sceneLegAt(this.model.recording, 0).recording.request
      .robot;
    const [robot, visuals] = await Promise.all([
      loadRobotVisual(selected, this.abort.signal),
      loadWorkcellVisuals(
        { ur5eTooling: this.model.usesUr5eTooling() },
        this.abort.signal,
      ),
    ]);
    if (this.disposed) {
      robot.traverse(disposePhysicsObject);
      disposeWorkcellVisualBundle(visuals);
      return;
    }
    try {
      this.model.attachRobot(robot);
    } catch (error) {
      robot.traverse(disposePhysicsObject);
      disposeWorkcellVisualBundle(visuals);
      throw error;
    }
    try {
      this.model.attachWorkcellVisuals(visuals);
    } catch (error) {
      disposeWorkcellVisualBundle(visuals);
      throw error;
    }
    await this.inspectionModel.loadOven();
  }

  update(frame: PhysicsFrame): void {
    if (frame.motion !== undefined)
      this.model.setPersistentMotion(frame.motion);
    const { seconds, workcell, layout, trays } = frame;
    if (seconds !== this.time) this.inspectionModel.resetDoor();
    if (
      workcell.kind === "active" &&
      (this.workcell.kind !== "active" ||
        this.workcell.selection !== workcell.selection)
    ) {
      this.inspectedSelection = workcell.selection;
    }
    this.frame = frame;
    if (this.disposed) return;
    this.model.update(seconds);
    this.inspectionModel.setPlacement(layout);
    this.taskGuide.update(workcell);
    this.cellLabel.element.textContent =
      placementLabel(layout) ??
      (workcell.kind === "active"
        ? "Robot cell · Native simulation"
        : "Recording preview · Bakery context");
    if (trays !== null) this.updateTrays(trays);
    this.updateFloorPlan();
    this.render();
  }

  get layoutControls(): HTMLElement {
    return this.floorPlan.layoutControls;
  }

  get planOpen(): boolean {
    return this.floorPlan.isOpen;
  }

  openPlan(): void {
    this.floorPlan.setOpen(true);
  }

  inspectResource(selection: WorkcellSelection): void {
    this.setSelection(selection);
    this.select(selection);
  }

  setSelection(selection: WorkcellSelection | null): void {
    if (selection === this.inspectedSelection) return;
    this.inspectedSelection = selection;
    this.updateFloorPlan();
    this.render();
  }

  private doorChanged(): void {
    this.updateFloorPlan();
    this.render();
  }

  closeInspection(): void {
    this.inspectionModel.closeDoor();
  }

  get doorAvailable(): boolean {
    return this.inspectionModel.doorAvailable;
  }

  setDoorPreview(degrees: number | null): void {
    if (this.inspectionModel.setDoorPreview(degrees)) this.doorChanged();
  }

  private fitInspectionChanged(): void {
    if (!this.disposed && this.syncFitCheckMode()) this.render();
  }

  private syncFitCheckMode(): boolean {
    return this.model.setFitCheckActive(
      isLayoutFitCheck(this.frame.layout) || this.floorPlan.isInspectingFit,
    );
  }

  private updateFloorPlan(): void {
    this.lighting.setExteriorPlaneY(
      floorPlanWorkspace.getActivePlan() === "reference" ? -0.112 : -0.092,
    );
    this.taskGuide.refreshAnchors();
    const selection = this.inspectedSelection;
    if (selection === null) this.highlight.visible = false;
    else {
      const resource =
        selection.kind === "resource" ? selection.id : COLD_CELL.id;
      this.highlight.box.copy(this.model.resourceBounds(resource));
      this.highlight.visible = !this.highlight.box.isEmpty();
    }
    this.floorPlan.update(
      [...this.model.floorPlanItems(), ...this.bakery.floorPlanItems()],
      selection?.kind === "resource" ? [selection.id] : [],
      this.inspectionModel.findings(this.time),
    );
    this.syncFitCheckMode();
  }

  private updateTrays(presentation: TrayPresentation): void {
    const { markers, select, recordedTray, selectedTrayId } = presentation;
    this.selectTray = select;
    this.model.tray.visible = recordedTray;
    for (const marker of this.trayMarkers.values()) marker.mesh.visible = false;
    for (const [index, tray] of markers.entries()) {
      let marker = this.trayMarkers.get(tray.id);
      if (marker === undefined) {
        const mesh = new THREE.Mesh(
          new RoundedBoxGeometry(0.4, 0.08, 0.3, 3, 0.012),
          new THREE.MeshStandardMaterial({
            color: 0xd6b76d,
            roughness: 0.42,
            metalness: 0.18,
          }),
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const label = sceneLabel(tray.label);
        label.position.y = 0.2;
        mesh.add(label);
        this.trays.add(mesh);
        marker = { mesh, label };
        this.trayMarkers.set(tray.id, marker);
      }
      marker.mesh.visible = !tray.active || !recordedTray;
      marker.mesh.userData.trayOperation = tray.operationId;
      marker.mesh.position.set(
        tray.holding ? -0.8 : -3.2,
        0.12,
        2.5 + index * 0.45,
      );
      if (tray.active && !recordedTray) {
        this.model.resourceBounds(RACK.source).getCenter(marker.mesh.position);
        marker.mesh.position.y += 0.3;
      }
      marker.label.element.textContent = tray.label;
      if (tray.id === selectedTrayId && marker.mesh.visible) {
        this.highlight.box.setFromObject(marker.mesh);
        this.highlight.visible = true;
      }
    }
  }

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary || this.disposed) return;
    this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  private pointerCancel(): void {
    this.pointer = null;
  }

  private pointerUp(event: PointerEvent): void {
    const start = this.pointer;
    this.pointer = null;
    if (
      this.disposed ||
      start === null ||
      start.id !== event.pointerId ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5
    )
      return;
    const bounds = this.host.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      1 - ((event.clientY - bounds.top) / bounds.height) * 2,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(pointer, this.camera);
    for (const hit of ray.intersectObjects(
      [this.model.root, this.bakery.root, this.trays],
      true,
    )) {
      if (typeof hit.object.userData.trayOperation === "string") {
        this.selectTray?.(hit.object.userData.trayOperation);
        return;
      }
      const resource = this.model.resourceForObject(hit.object);
      if (resource !== null) {
        this.inspectResource({ kind: "resource", id: resource });
        return;
      }
    }
  }

  setCamera(camera: "perspective" | "overhead"): void {
    if (camera === "perspective") this.resetView();
    else this.topView(this.sceneBounds());
  }

  private sceneBounds(): THREE.Box3 {
    const bounds = new THREE.Box3().setFromObject(this.bakery.root);
    bounds.union(new THREE.Box3().setFromObject(this.model.root));
    bounds.union(new THREE.Box3().setFromObject(this.trays));
    return bounds;
  }

  resetView(): void {
    const bounds = this.sceneBounds();
    for (const label of this.bakery.labels.values()) label.visible = true;
    this.frameBounds(bounds);
  }

  cameraView(): PhysicsCameraView {
    const position = this.camera.position;
    const target = this.controls.target;
    return {
      position: [position.x, position.y, position.z],
      target: [target.x, target.y, target.z],
      ...(this.camera === this.orthographic
        ? {
            orthographic: {
              halfHeight: this.orthographicHalfHeight,
              zoom: this.orthographic.zoom,
            },
          }
        : {}),
    };
  }

  restoreCamera(view: PhysicsCameraView): void {
    if (view.orthographic === undefined) this.useCamera(this.perspective);
    else {
      this.orthographicHalfHeight = view.orthographic.halfHeight;
      this.orthographic.zoom = view.orthographic.zoom;
      this.useCamera(this.orthographic);
      this.updateOrthographic();
    }
    this.camera.position.set(...view.position);
    this.controls.target.set(...view.target);
    this.controls.update();
  }

  private useCamera(
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  ): void {
    this.host.useCamera(camera);
  }

  private updateOrthographic(): void {
    const aspect = this.perspective.aspect;
    const half = this.orthographicHalfHeight;
    this.orthographic.left = -half * aspect;
    this.orthographic.right = half * aspect;
    this.orthographic.top = half;
    this.orthographic.bottom = -half;
    this.orthographic.updateProjectionMatrix();
  }

  focusCell(): void {
    for (const label of this.bakery.labels.values()) label.visible = false;
    if (this.model.recording.kind !== "persistent-physics-motion") {
      this.frameBounds(new THREE.Box3().setFromObject(this.model.root));
      return;
    }
    const bounds = this.model.resourceBounds(RACK.arm);
    for (const resource of [
      RACK.source,
      RACK.destination,
      OVEN.destination,
      RACK.tool,
    ])
      bounds.union(this.model.resourceBounds(resource));
    this.frameBounds(bounds);
  }

  focusBounds(bounds: THREE.Box3): void {
    for (const label of this.bakery.labels.values()) label.visible = false;
    this.frameBounds(bounds, 1.8);
  }

  focusTask(): void {
    if (this.model.recording.kind === "persistent-physics-motion") {
      this.focusCell();
      return;
    }
    const view = this.workcell;
    let task = physicsLegAt(this.model.recording, this.time).recording.request
      .bakeryTaskId;
    if (view.kind === "active" && view.selection.kind === "task") {
      const input = view.attempt.input;
      if (
        input.kind === "rack-cycle" &&
        view.selection.id === input.rackTaskInstanceId
      )
        task = "table-to-rack";
      else if (
        input.kind !== "transfer" &&
        view.selection.id === input.returnTaskInstanceId
      )
        task = "oven-to-table";
      else if (view.selection.id === input.taskInstanceId)
        task = input.request.bakeryTaskId;
    }
    const bounds = this.model.resourceBounds(RACK.source);
    bounds.union(
      this.model.resourceBounds(
        task === "table-to-rack" ? RACK.destination : OVEN.destination,
      ),
    );
    bounds.union(this.model.resourceBounds(RACK.arm));
    bounds.union(this.model.resourceBounds(RACK.tool));
    bounds.union(this.model.resourceBounds(RACK.tray));
    if (!bounds.isEmpty()) this.focusBounds(bounds);
  }

  private inspectionBounds(selection: THREE.Box3): THREE.Box3 {
    return selection.isEmpty()
      ? new THREE.Box3().setFromObject(this.model.root)
      : selection;
  }

  /** Orthographic, like the floor plan: one scale for every height. */
  topView(selection: THREE.Box3): void {
    for (const label of this.bakery.labels.values()) label.visible = false;
    const bounds = this.inspectionBounds(selection);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    this.orthographicHalfHeight =
      Math.max(size.z / 2, size.x / 2 / this.perspective.aspect, 0.25) * 1.2;
    this.orthographic.zoom = 1;
    this.useCamera(this.orthographic);
    this.updateOrthographic();
    // Height only sets clipping; the rear wall stays at the top, as in the plan.
    this.orthographic.position.set(
      center.x,
      bounds.max.y + 10,
      center.z + 0.001,
    );
    this.orthographic.far = bounds.max.y - bounds.min.y + 20;
    this.orthographic.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
  }

  operatorView(selection: THREE.Box3): void {
    for (const label of this.bakery.labels.values()) label.visible = false;
    const bounds = this.inspectionBounds(selection);
    const center = bounds.getCenter(new THREE.Vector3());
    this.frameBounds(bounds, 1.2);
    const distance = this.camera.position.distanceTo(this.controls.target);
    // The operator viewpoint is an inspection assumption above the scene floor.
    this.camera.position.set(center.x, 1.6, center.z + distance);
    const highestTarget =
      1.6 - distance / Math.tan(this.controls.maxPolarAngle) - 0.001;
    this.controls.target.set(
      center.x,
      Math.min(center.y, highestTarget),
      center.z,
    );
    this.controls.update();
  }

  private frameBounds(bounds: THREE.Box3, padding = 1): void {
    this.useCamera(this.perspective);
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
    const halfFov = THREE.MathUtils.degToRad(this.perspective.fov / 2);
    const angle = Math.min(
      halfFov,
      Math.atan(Math.tan(halfFov) * this.perspective.aspect),
    );
    const distance = (radius / Math.sin(angle)) * padding;
    this.controls.target.copy(center);
    this.camera.position
      .copy(center)
      .addScaledVector(
        new THREE.Vector3(padding > 1 ? 2.5 : -2.5, 2, 3).normalize(),
        distance,
      );
    this.controls.update();
  }

  private resized(width: number, height: number): void {
    this.perspective.aspect = width / height;
    this.perspective.updateProjectionMatrix();
    this.updateOrthographic();
    this.labels.setSize(width, height);
  }

  /** Asks the host for one frame; changes before it join the same frame. */
  private render(): void {
    this.host.requestFrame();
  }

  private draw(): void {
    this.lighting.render(this.camera);
    this.labels.render(this.scene, this.camera);
    arrangeLabels(
      [...this.bakery.labels.values(), this.cellLabel, ...this.taskGuide.pins],
      this.floorPlan.viewport.getBoundingClientRect(),
      this.floorPlan.occluders(),
    );
  }

  private contextLost(event: Event): void {
    event.preventDefault();
    this.unavailable();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.floorPlan.onFitInspectionChange(null);
    this.inspectionModel.dispose();
    this.abort.abort();
    this.bakery.dispose();
    this.cellLabel.element.remove();
    for (const marker of this.trayMarkers.values())
      marker.label.element.remove();
    this.trays.traverse(disposePhysicsObject);
    this.labels.domElement.remove();
    this.highlight.geometry.dispose();
    const highlightMaterials = Array.isArray(this.highlight.material)
      ? this.highlight.material
      : [this.highlight.material];
    for (const material of highlightMaterials) material.dispose();
    for (const child of this.scene.children) {
      if (child instanceof THREE.GridHelper) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        for (const material of materials) material.dispose();
      }
    }
    this.lighting.dispose();
    this.host.dispose();
  }
}

function isLayoutFitCheck(layout: PhysicsFrame["layout"]): boolean {
  return (
    layout !== null &&
    (layout.setup || layout.draft !== null || layout.checks.length > 0)
  );
}

function placementLabel(layout: PhysicsFrame["layout"]): string | null {
  if (layout === null) return null;
  if (layout.draft !== null) return "Rack proposal · Unapplied";
  if (layout.setup) return "Layout setup · Simulation required";
  return null;
}
