import type { FloorPlanOpening } from "@purin-labs/production-simulation/floor/openings";
import { pickFloorPlanOpening } from "./floor-plan-openings-3d";
import { floorPlanWorkspace } from "../floor-plan-workspace";
import type { StrictUnion, Variant } from "@purin-labs/type-utils";
import type { LogisticsView } from "@purin-labs/production-simulation";
import type { PersistentPhysicsMotion } from "@purin-labs/bakery-model/bakery-physics";
import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import {
  setupBakeryLightingAndPost,
  type BakeryLightingRig,
} from "./scene-lighting";
import { PhysicsModel, disposePhysicsObject } from "./physics-model";
import { loadRobotVisual } from "./physics-robot-visual";
import {
  disposeWorkcellVisualBundle,
  loadWorkcellVisuals,
} from "./physics-workcell-visuals";
import { SceneHost } from "../../production-run/scene-host";
import {
  FactoryStations,
  type FactoryStationSource,
  type FactoryWorker,
} from "./factory-stations";
import { MorningShiftCobotLayer } from "./morning-shift-cobots";
import {
  buildArticulatedHumanWorker,
  poseArticulatedHumanWorker,
  type ArticulatedHumanWorker,
} from "./human-worker-figure";
import { ensureLivingAssetsLoaded } from "./living-asset-loader";
import type {
  SynchronizedApplianceState,
  SynchronizedCobotTransferState,
} from "../../production-run/morning-shift-appliances";
import { type BakeryFloorPlanId } from "@purin-labs/production-simulation/floor/bakery-room";
import {
  moveApplianceWithCollisions,
  rotateApplianceWithCollisions,
  setApplianceRotationWithCollisions,
} from "../bakery-appliance-layout";
import { getApplianceBox } from "@purin-labs/production-simulation/floor/collisions";
import {
  APPLIANCE_FOOTPRINTS,
  STORE_DECOR_IDS,
  isApplianceId,
  type ApplianceId,
} from "@purin-labs/production-simulation/floor/appliance-catalogue";
import { createFloorPlanShell, type FloorPlanShell } from "./floor-plan-shell";
import {
  getStoreInteriorDesign,
  subscribeStoreInteriorDesign,
} from "../store-interior-design";

type RotationGizmo3D = {
  readonly root: THREE.Group;
  readonly yawMat: THREE.MeshBasicMaterial;
  readonly knobMat: THREE.MeshBasicMaterial;
};

function setRotationGizmoActive(gizmo: RotationGizmo3D, active: boolean): void {
  gizmo.yawMat.color.setHex(active ? 0x38bdf8 : 0x60a5fa);
  gizmo.yawMat.opacity = active ? 0.96 : 0.38;
  gizmo.knobMat.color.setHex(active ? 0xe0f2fe : 0xbae6fd);
  gizmo.knobMat.opacity = active ? 1.0 : 0.55;
}

function buildRotationGizmo3D(): RotationGizmo3D {
  const root = new THREE.Group();
  root.visible = false;
  const yawMat = new THREE.MeshBasicMaterial({
    color: 0x60a5fa,
    transparent: true,
    opacity: 0.38,
    depthTest: false,
  });
  const knobMat = new THREE.MeshBasicMaterial({
    color: 0xbae6fd,
    transparent: true,
    opacity: 0.55,
    depthTest: false,
  });
  const hitMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: false,
  });
  const yawRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.0, 0.022, 16, 72),
    yawMat,
  );
  yawRing.rotation.x = Math.PI / 2;
  yawRing.renderOrder = 12;
  yawRing.userData.isRotateGizmo = true;
  root.add(yawRing);
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 0.42, 10).rotateX(Math.PI / 2),
    yawMat,
  );
  stem.position.set(0, 0, 0.79);
  stem.renderOrder = 12;
  stem.userData.isRotateGizmo = true;
  root.add(stem);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.068, 18, 18), knobMat);
  knob.position.set(0, 0, 1.0);
  knob.renderOrder = 13;
  knob.userData.isRotateGizmo = true;
  root.add(knob);
  const knobCore = new THREE.Mesh(
    new THREE.SphereGeometry(0.042, 16, 16),
    yawMat,
  );
  knobCore.position.set(0, 0, 1.0);
  knobCore.renderOrder = 14;
  knobCore.userData.isRotateGizmo = true;
  root.add(knobCore);
  const hitRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.0, 0.14, 12, 48),
    hitMat,
  );
  hitRing.rotation.x = Math.PI / 2;
  hitRing.userData.isRotateGizmo = true;
  root.add(hitRing);
  return { root, yawMat, knobMat };
}

export type FactorySceneSource = Readonly<{
  selectedCell: string | null;
  floorPlan?: BakeryFloorPlanId;
  cells: readonly Readonly<{
    id: string;
    motion: PersistentPhysicsMotion | null;
  }>[];
  stores: Variant<LogisticsView, "available">["carrierStores"] | null;
  /** Equipment of a factory without robot cells, or alongside cobot cells. Labels select by station id. */
  stations: readonly FactoryStationSource[] | null;
  workers: readonly FactoryWorker[];
  appliances?: readonly SynchronizedApplianceState[] | null;
  cobotTransfers?: readonly SynchronizedCobotTransferState[] | null;
}>;
type StationLabels = Readonly<{
  layer: FactoryStations;
  labels: Map<string, HTMLButtonElement>;
  cobotLayer: MorningShiftCobotLayer;
  cobotLabels: Map<string, HTMLButtonElement>;
}>;
type SceneCell = Readonly<{
  id: string;
  model: PhysicsModel;
  root: THREE.Group;
  label: HTMLButtonElement;
  humanBaker: ArticulatedHumanWorker | null;
}>;
type Scene = Readonly<{
  host: SceneHost;
  renderer: THREE.WebGLRenderer;
  lighting: BakeryLightingRig;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  selection: THREE.BoxHelper;
  dragOutline: THREE.Box3Helper;
  rotationGizmo: RotationGizmo3D;
  controls: OrbitControls;
  cells: Map<string, SceneCell>;
  stores: THREE.Group;
  roomShell: THREE.Group;
  stations: StationLabels | null;
}>;
type Life = StrictUnion<
  | Readonly<{ kind: "empty" | "unavailable" | "closed" }>
  | Readonly<{ kind: "ready"; scene: Scene }>
>;

/** One renderer displays independent accepted worlds without merging their physics. */
export class PhysicsFactoryScene {
  constructor(
    private readonly element: HTMLElement,
    private source: FactorySceneSource,
    private readonly select: (cell: string) => void,
    private readonly changed: (status: "ready" | "unavailable") => void,
    private readonly view: "floor" | "perspective",
  ) {}
  private readonly abort = new AbortController();
  private life: Life = { kind: "empty" };
  private pointer: Readonly<{ x: number; y: number }> | null = null;
  private activeGizmoId: ApplianceId | null = null;
  private gesture:
    | { kind: "idle" }
    | {
        kind: "move";
        id: ApplianceId;
        pointerId: number;
        startX: number;
        startY: number;
        offsetX: number;
        offsetZ: number;
        moved: boolean;
      }
    | {
        kind: "rotate";
        id: ApplianceId;
        pointerId: number;
        startX: number;
        startY: number;
        centerX: number;
        centerZ: number;
        startAngle: number;
        startRotY: number;
        moved: boolean;
      } = { kind: "idle" };
  private unsubscribePlacements: (() => void) | null = null;
  private unsubscribeInterior: (() => void) | null = null;
  private unsubscribeOpenings: (() => void) | null = null;
  private storesKey = "";
  private roomPlanKey = "";
  private floorShell: FloorPlanShell | null = null;
  private placementSyncKey = "";
  private readonly loadedCells = new Set<string>();
  private stationsLoaded = false;

  private checkReady(): void {
    const stationsReady = this.source.stations === null || this.stationsLoaded;
    const cellsReady = this.loadedCells.size >= this.source.cells.length;
    if (stationsReady && cellsReady) this.changed("ready");
  }

  mount(): void {
    const element = this.element;
    try {
      const camera =
        this.view === "floor"
          ? new THREE.OrthographicCamera(-7, 7, 7, -7, 0.01, 100)
          : new THREE.PerspectiveCamera(42, 1, 0.01, 100);
      const host = new SceneHost({
        view: element,
        camera,
        renderer: { antialias: true, alpha: true },
        attach: "none",
        size: { buffer: "settle" },
        resized: this.resized,
        draw: this.drawScene,
        disposeContent: false,
      });
      const renderer = host.renderer;
      const scene = host.scene;
      renderer.domElement.setAttribute(
        "aria-label",
        "Recorded factory cells. Cell buttons and the logistics overview provide equivalent selection.",
      );
      const lighting = setupBakeryLightingAndPost(renderer, scene, camera, {
        shadowFrustumHalfSize: 8.8,
        exteriorShadowPlaneY: -0.092,
      });
      lighting.setDarkTheme(
        document.documentElement.dataset.portalTheme === "dark",
      );
      if (this.view === "floor") {
        camera.position.set(0, 14, 1);
        camera.up.set(0, 0, -1);
      } else camera.position.set(6, 7, 9);
      const controls = host.orbit;
      controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
      controls.touches.ONE = THREE.TOUCH.PAN;
      controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
      controls.screenSpacePanning = true;
      renderer.domElement.addEventListener(
        "pointerdown",
        (event: PointerEvent) => {
          const hasModifier = event.ctrlKey || event.metaKey || event.shiftKey;
          if (!hasModifier && !event.altKey && event.button === 0) {
            const gizmoTargetId = this.rotateGizmoHitAt(
              event.clientX,
              event.clientY,
            );
            if (gizmoTargetId !== null) {
              const planId =
                this.source.floorPlan ?? floorPlanWorkspace.getActivePlan();
              const pose = floorPlanWorkspace.getPose(planId, gizmoTargetId);
              const planePoint = this.floorPointAt(
                event.clientX,
                event.clientY,
                0.48,
              );
              const startAngle =
                planePoint !== null
                  ? Math.atan2(planePoint.x - pose.x, planePoint.z - pose.z)
                  : pose.rotY;
              this.gesture = {
                kind: "rotate",
                id: gizmoTargetId,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                centerX: pose.x,
                centerZ: pose.z,
                startAngle,
                startRotY: pose.rotY,
                moved: false,
              };
              if (this.life.kind === "ready") {
                setRotationGizmoActive(this.life.scene.rotationGizmo, true);
              }
              controls.enabled = false;
              try {
                renderer.domElement.setPointerCapture(event.pointerId);
              } catch {
                /* ignore synthetic events without active pointer id */
              }
              this.renderScene();
              return;
            }
            const hitId = this.hitIdAt(event.clientX, event.clientY);
            if (hitId !== null && isApplianceId(hitId)) {
              this.activeGizmoId = hitId;
              const planId =
                this.source.floorPlan ?? floorPlanWorkspace.getActivePlan();
              const pose = floorPlanWorkspace.getPose(planId, hitId);
              const floorPoint = this.floorPointAt(
                event.clientX,
                event.clientY,
              );
              this.gesture = {
                kind: "move",
                id: hitId,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                offsetX: floorPoint !== null ? floorPoint.x - pose.x : 0,
                offsetZ: floorPoint !== null ? floorPoint.z - pose.z : 0,
                moved: false,
              };
              controls.enabled = false;
              try {
                renderer.domElement.setPointerCapture(event.pointerId);
              } catch {
                /* ignore synthetic events without active pointer id */
              }
              return;
            }
          }
          controls.enabled = true;
          controls.mouseButtons.LEFT =
            !hasModifier && event.altKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
          controls.mouseButtons.RIGHT = hasModifier
            ? THREE.MOUSE.PAN
            : THREE.MOUSE.ROTATE;
        },
        { capture: true, signal: this.abort.signal },
      );
      renderer.domElement.addEventListener(
        "dblclick",
        (event: MouseEvent) => {
          const hitId = this.hitIdAt(event.clientX, event.clientY);
          if (hitId === null || !isApplianceId(hitId)) return;
          this.activeGizmoId = hitId;
          this.select(hitId);
          const planId =
            this.source.floorPlan ?? floorPlanWorkspace.getActivePlan();
          rotateApplianceWithCollisions(planId, hitId, this.activePeerIds());
        },
        { signal: this.abort.signal },
      );
      window.addEventListener(
        "keydown",
        (event: KeyboardEvent) => {
          if (
            event.defaultPrevented ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            this.life.kind !== "ready"
          ) {
            return;
          }
          const active = document.activeElement;
          if (
            active instanceof HTMLInputElement ||
            active instanceof HTMLTextAreaElement ||
            (active instanceof HTMLElement &&
              active.closest("[role=combobox], [role=listbox]") !== null) ||
            (active instanceof HTMLElement && active.isContentEditable)
          ) {
            return;
          }
          if (event.key === "Escape") {
            if (this.activeGizmoId !== null) {
              this.activeGizmoId = null;
              this.syncRotationGizmo3D();
              this.renderScene();
            }
            return;
          }
          if (event.key !== "r" && event.key !== "R") return;
          const targetId = this.gizmoTargetId();
          if (targetId === null) return;
          this.activeGizmoId = targetId;
          const planId =
            this.source.floorPlan ?? floorPlanWorkspace.getActivePlan();
          rotateApplianceWithCollisions(planId, targetId, this.activePeerIds());
          event.preventDefault();
        },
        { signal: this.abort.signal },
      );
      controls.target.set(0, 0.7, 1);
      // A bakery without cells spans two counters; centre on them.
      if (this.source.stations !== null && this.view === "perspective") {
        camera.position.set(2.4, 7.5, 11);
        controls.target.set(-0.3, 0.6, 0);
      }
      controls.enableRotate = this.view === "perspective";
      controls.update();
      scene.add(new THREE.GridHelper(12, 24, 0xaeb8ae, 0xdce0d8));
      const stores = new THREE.Group();
      scene.add(stores);
      const roomShell = new THREE.Group();
      scene.add(roomShell);
      const stations =
        this.source.stations === null
          ? null
          : this.stationLabels(this.source.stations);
      if (stations !== null) {
        scene.add(stations.layer.root);
        scene.add(stations.cobotLayer.root);
      }
      const selection = new THREE.BoxHelper(new THREE.Object3D(), 0x78b6e8);
      selection.visible = false;
      scene.add(selection);
      const dragOutline = new THREE.Box3Helper(new THREE.Box3(), 0x10b981);
      dragOutline.visible = false;
      scene.add(dragOutline);
      const rotationGizmo = buildRotationGizmo3D();
      scene.add(rotationGizmo.root);
      this.life = {
        kind: "ready",
        scene: {
          host,
          renderer,
          lighting,
          scene,
          camera,
          selection,
          dragOutline,
          rotationGizmo,
          controls,
          cells: new Map(),
          stores,
          roomShell,
          stations,
        },
      };
      element.append(renderer.domElement);
      renderer.domElement.addEventListener("pointerdown", this.pointerDown);
      renderer.domElement.addEventListener("pointermove", this.pointerMove);
      renderer.domElement.addEventListener("pointerup", this.pointerUp);
      renderer.domElement.addEventListener("pointercancel", this.pointerCancel);
      renderer.domElement.addEventListener(
        "webglcontextlost",
        this.contextLost,
      );
      this.unsubscribePlacements = floorPlanWorkspace.subscribePlacements(
        () => {
          if (this.life.kind === "ready") this.updateScene();
        },
      );
      this.unsubscribeInterior = subscribeStoreInteriorDesign(() => {
        this.roomPlanKey = "";
        if (this.life.kind === "ready") this.updateScene();
      });
      this.unsubscribeOpenings = floorPlanWorkspace.subscribeOpenings(
        this.updateOpenings.bind(this),
      );
      host.resize();
      this.updateScene();
      if (stations !== null) void this.loadStations(stations);
    } catch {
      this.unavailable();
    }
  }
  private stationLabels(
    stations: readonly FactoryStationSource[],
  ): StationLabels {
    const labels = new Map<string, HTMLButtonElement>();
    for (const station of stations) {
      const label = document.createElement("button");
      label.type = "button";
      label.className = "factory-station-label";
      label.dataset.station = station.id;
      label.addEventListener("click", this.select.bind(null, station.id));
      this.element.append(label);
      labels.set(station.id, label);
    }
    const cobotLayer = new MorningShiftCobotLayer();
    const cobotLabels = new Map<string, HTMLButtonElement>();
    for (const cellId of ["espresso-cell", "pour-over-cell"]) {
      const label = document.createElement("button");
      label.type = "button";
      label.className = "factory-station-label";
      label.dataset.cell = cellId;
      label.textContent = `Barista · ${cellId}`;
      label.title = cellId;
      label.addEventListener("click", this.select.bind(null, cellId));
      this.element.append(label);
      cobotLabels.set(cellId, label);
    }
    return {
      layer: new FactoryStations(stations),
      labels,
      cobotLayer,
      cobotLabels,
    };
  }
  private async loadStations(stations: StationLabels): Promise<void> {
    try {
      await Promise.all([
        stations.layer.load(this.abort.signal),
        stations.cobotLayer.load(this.abort.signal),
      ]);
      if (this.life.kind !== "ready" || this.abort.signal.aborted) return;
      this.stationsLoaded = true;
      this.checkReady();
      this.updateScene();
    } catch {
      if (!this.abort.signal.aborted) this.unavailable();
    }
  }
  update(source: FactorySceneSource): void {
    this.source = source;
    this.updateScene();
  }
  dispose(): void {
    this.abort.abort();
    this.disposeScene();
    this.life = { kind: "closed" };
  }
  private unavailable(): void {
    if (this.life.kind === "closed") return;
    this.abort.abort();
    this.disposeScene();
    this.life = { kind: "unavailable" };
    this.changed("unavailable");
  }
  private contextLost = (event: Event): void => {
    event.preventDefault();
    this.unavailable();
  };
  private disposeScene(): void {
    this.unsubscribePlacements?.();
    this.unsubscribePlacements = null;
    this.unsubscribeInterior?.();
    this.unsubscribeInterior = null;
    this.unsubscribeOpenings?.();
    this.unsubscribeOpenings = null;
    if (this.life.kind !== "ready") return;
    const scene = this.life.scene;
    scene.renderer.domElement.removeEventListener(
      "pointerdown",
      this.pointerDown,
    );
    scene.renderer.domElement.removeEventListener(
      "pointermove",
      this.pointerMove,
    );
    scene.renderer.domElement.removeEventListener("pointerup", this.pointerUp);
    scene.renderer.domElement.removeEventListener(
      "pointercancel",
      this.pointerCancel,
    );
    scene.renderer.domElement.removeEventListener(
      "webglcontextlost",
      this.contextLost,
    );
    this.floorShell?.dispose();
    this.floorShell = null;
    scene.scene.traverse(disposePhysicsObject);
    scene.lighting.dispose();
    for (const cell of scene.cells.values()) cell.label.remove();
    for (const label of scene.stations?.labels.values() ?? []) label.remove();
    for (const label of scene.stations?.cobotLabels.values() ?? [])
      label.remove();
    scene.host.dispose();
  }
  private resized = (width: number, height: number): void => {
    if (this.life.kind !== "ready") return;
    const { renderer, camera } = this.life.scene;
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = width / height;
      camera.zoom = Math.min(1, width / height);
    } else {
      const halfHeight = Math.max(4, 6 / (width / height));
      camera.left = (-halfHeight * width) / height;
      camera.right = (halfHeight * width) / height;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
    }
    camera.updateProjectionMatrix();
    renderer.domElement.style.display = "block";
  };
  /** Asks the host for one frame; changes before it join the same frame. */
  private renderScene = (): void => {
    if (this.life.kind === "ready") this.life.scene.host.requestFrame();
  };
  private drawScene = (): void => {
    if (this.life.kind !== "ready") return;
    const { lighting, camera } = this.life.scene;
    lighting.render(camera);
    for (const cell of this.life.scene.cells.values()) {
      const transfer = (this.source.cobotTransfers ?? []).find(
        (t) => t.cellId === cell.id,
      );
      if (transfer !== undefined && this.source.stations !== null) {
        cell.label.textContent = `Baker · ${cell.id} · ${transfer.label}`;
        cell.label.dataset.cobotStatus = transfer.status;
        if (transfer.cascadeHold !== null) {
          cell.label.dataset.cascadeStatus = transfer.cascadeHold.restored
            ? "recovered"
            : "held";
          cell.label.dataset.cascadeCheckpoint =
            transfer.cascadeHold.checkpointDigest.slice(0, 8);
        } else {
          delete cell.label.dataset.cascadeStatus;
          delete cell.label.dataset.cascadeCheckpoint;
        }
      }
      this.placeLabel(
        cell.label,
        cell.root.position.clone().add(new THREE.Vector3(0, 2, 0)),
        camera,
      );
      cell.label.setAttribute(
        "aria-pressed",
        String(this.source.selectedCell === cell.id),
      );
    }
    const stations = this.life.scene.stations;
    if (stations !== null) {
      for (const [cellId, label] of stations.cobotLabels.entries()) {
        const transfer = (this.source.cobotTransfers ?? []).find(
          (t) => t.cellId === cellId,
        );
        label.hidden = transfer === undefined;
        if (transfer === undefined) continue;
        label.textContent = `Barista · ${cellId} · ${transfer.label}`;
        label.dataset.cobotStatus = transfer.status;
        if (transfer.cascadeHold !== null) {
          label.dataset.cascadeStatus = transfer.cascadeHold.restored
            ? "recovered"
            : "held";
          label.dataset.cascadeCheckpoint =
            transfer.cascadeHold.checkpointDigest.slice(0, 8);
        } else {
          delete label.dataset.cascadeStatus;
          delete label.dataset.cascadeCheckpoint;
        }
        const anchor = stations.cobotLayer.anchor(cellId);
        if (anchor !== null) {
          this.placeLabel(
            label,
            anchor,
            camera,
            this.view === "floor" ? 28 : 0,
          );
        }
        label.setAttribute(
          "aria-pressed",
          String(this.source.selectedCell === cellId),
        );
      }
    }
    for (const [index, station] of (this.source.stations ?? []).entries()) {
      const label = stations?.labels.get(station.id);
      if (label === undefined || stations === null) continue;
      label.textContent = stationText(
        station,
        this.source.stores,
        this.source.appliances ?? null,
      );
      const faultedAppliance = (this.source.appliances ?? []).find(
        (a) => a.stationId === station.id && a.status === "fault",
      );
      const activeAppliance = (this.source.appliances ?? []).find(
        (a) => a.stationId === station.id && a.status === "active",
      );
      label.dataset.applianceStatus =
        faultedAppliance !== undefined
          ? "fault"
          : activeAppliance !== undefined
            ? "active"
            : "idle";
      // From above, neighbouring labels alternate rows so they do not cover each other.
      this.placeLabel(
        label,
        stations.layer.anchor(station),
        camera,
        this.view === "floor" && index % 2 === 1 ? 30 : 0,
      );
      label.setAttribute(
        "aria-pressed",
        String(this.source.selectedCell === station.id),
      );
    }
  };
  private placeLabel(
    label: HTMLElement,
    position: THREE.Vector3,
    camera: THREE.Camera,
    offset = 0,
  ): void {
    const point = position.project(camera);
    const half = label.offsetWidth / 2 + 8;
    label.style.left = `${Math.max(half, Math.min(this.element.clientWidth - half, ((point.x + 1) * this.element.clientWidth) / 2))}px`;
    label.style.setProperty(
      "--factory-label-top",
      `${Math.min(this.element.clientHeight - 80, ((1 - point.y) * this.element.clientHeight) / 2 + offset)}px`,
    );
  }
  private updateOpenings(planId: BakeryFloorPlanId): void {
    if (this.life.kind !== "ready" || this.floorShell?.planId !== planId)
      return;
    this.floorShell.syncOpenings();
    this.life.scene.stations?.layer.update(
      this.source.stores,
      this.source.workers,
      this.source.appliances ?? null,
    );
    this.renderScene();
  }

  private updateScene(): void {
    if (this.life.kind !== "ready") return;
    const scene = this.life.scene;
    const nextPlan =
      this.source.floorPlan ?? floorPlanWorkspace.getActivePlan();
    const nextRoomKey = `${nextPlan}:${JSON.stringify(getStoreInteriorDesign())}`;
    if (this.roomPlanKey !== nextRoomKey) {
      this.roomPlanKey = nextRoomKey;
      this.floorShell?.dispose();
      this.floorShell = null;
      scene.lighting.setExteriorPlaneY(
        nextPlan === "reference" ? -0.002 : -0.092,
      );
      if (nextPlan !== "reference") {
        this.floorShell = createFloorPlanShell(
          nextPlan,
          "station-oven",
          floorPlanWorkspace,
        );
        scene.roomShell.add(this.floorShell.root);
      }
      this.element.dataset.floorPlan = nextPlan;
    }
    const syncKey = `${nextPlan}:${floorPlanWorkspace.getPlacementVersion()}`;
    if (this.placementSyncKey !== syncKey) {
      this.placementSyncKey = syncKey;
      scene.stations?.layer.syncPlacements(nextPlan);
      scene.stations?.cobotLayer.syncPlacements(nextPlan);
      this.floorShell?.syncPlacements();
    }
    for (const [index, cell] of this.source.cells.entries()) {
      const motion = cell.motion;
      if (motion === null) continue;
      // The first factory composition contains independent cold rack cells.
      if (motion.fixture.kind !== "rack") {
        this.unavailable();
        return;
      }
      let displayed = scene.cells.get(cell.id);
      if (displayed === undefined) {
        const model = new PhysicsModel(motion);
        const root = new THREE.Group();
        root.add(model.root);
        let humanBaker: ArticulatedHumanWorker | null = null;
        if (this.source.stations !== null) {
          model.robot.visible = false;
          model.tool.visible = false;
          model.jaw.visible = false;
          for (const child of model.root.children) {
            if (child.name.startsWith("pedestal_")) {
              child.visible = false;
            }
          }
          humanBaker = buildArticulatedHumanWorker(0xc2410c, 10 + index);
          humanBaker.root.position.set(0.42, 0, 0);
          humanBaker.root.rotation.y = Math.PI / 2;
          root.add(humanBaker.root);
        }
        scene.scene.add(root);
        const label = document.createElement("button");
        label.type = "button";
        label.className = "factory-station-label";
        label.dataset.cell = cell.id;
        label.textContent =
          this.source.stations !== null
            ? `Baker · ${cell.id}`
            : `Cell ${index + 1}`;
        label.title = cell.id;
        label.addEventListener("click", this.select.bind(null, cell.id));
        this.element.append(label);
        displayed = { id: cell.id, model, root, label, humanBaker };
        scene.cells.set(displayed.id, displayed);
        void this.loadCellAssets(
          displayed,
          motion.request.robot,
          this.source.stations !== null,
        );
      } else displayed.model.setPersistentMotion(motion);
      const cellPose = isApplianceId(cell.id)
        ? floorPlanWorkspace.getPose(nextPlan, cell.id)
        : null;
      if (cellPose !== null) {
        displayed.root.position.set(cellPose.x, 0, cellPose.z);
        displayed.root.rotation.y = cellPose.rotY;
      } else if (this.source.stations !== null) {
        displayed.root.position.set(
          (index - (this.source.cells.length - 1) / 2) * 2.2,
          0,
          0.4,
        );
      } else {
        displayed.root.position.set(
          (index - (this.source.cells.length - 1) / 2) * 2.4,
          0,
          0,
        );
      }
      const sample = motion.samples[motion.samples.length - 1];
      if (sample !== undefined) displayed.model.update(sample.step * 0.002);
      if (displayed.humanBaker !== null) {
        const transfer = (this.source.cobotTransfers ?? []).find(
          (t) => t.cellId === cell.id,
        );
        const trayY = sample !== undefined ? sample.tray[1] : 0;
        const turnAngle = Math.max(-0.55, Math.min(0.55, -trayY * 0.95));
        const active =
          transfer !== undefined &&
          (transfer.status === "executing" || transfer.status === "handoff");
        poseArticulatedHumanWorker(displayed.humanBaker, {
          facingYawRad: Math.PI / 2 + turnAngle,
          walking: false,
          working: true,
          carrying: active,
          phase:
            (sample?.step ?? 0) * 0.02 +
            (transfer?.progress ?? 0) * Math.PI * 2,
        });
      }
    }
    if (scene.stations === null) this.updateStores();
    else {
      scene.stations.layer.update(
        this.source.stores,
        this.source.workers,
        this.source.appliances ?? null,
      );
      scene.stations.cobotLayer.update(this.source.cobotTransfers ?? null);
    }
    const id = this.source.selectedCell;
    if (id !== null && isApplianceId(id)) {
      this.activeGizmoId = id;
    }
    const selected =
      id === null
        ? null
        : (scene.cells.get(id)?.root ??
          scene.stations?.cobotLayer.cellRoot(id) ??
          scene.stations?.layer.station(id) ??
          null);
    scene.selection.visible = selected !== null;
    if (selected !== null) scene.selection.setFromObject(selected);
    this.syncRotationGizmo3D();
    this.renderScene();
  }
  private gizmoTargetId(): ApplianceId | null {
    if (this.activeGizmoId !== null) return this.activeGizmoId;
    if (
      this.source.selectedCell !== null &&
      isApplianceId(this.source.selectedCell)
    ) {
      return this.source.selectedCell;
    }
    return null;
  }
  private syncRotationGizmo3D(): void {
    if (this.life.kind !== "ready") return;
    const { rotationGizmo } = this.life.scene;
    const targetId = this.gizmoTargetId();
    if (targetId === null) {
      rotationGizmo.root.visible = false;
      return;
    }
    const fp = APPLIANCE_FOOTPRINTS[targetId];
    const planId = this.source.floorPlan ?? floorPlanWorkspace.getActivePlan();
    const pose = floorPlanWorkspace.getPose(planId, targetId);
    const radius = Math.hypot(fp.halfWidth, fp.halfDepth) + 0.16;
    rotationGizmo.root.position.set(pose.x, 0.48, pose.z);
    rotationGizmo.root.scale.setScalar(radius);
    rotationGizmo.root.rotation.y = pose.rotY;
    rotationGizmo.root.visible = true;
    rotationGizmo.root.updateMatrixWorld(true);
  }
  private rotateGizmoHitAt(
    clientX: number,
    clientY: number,
  ): ApplianceId | null {
    if (this.life.kind !== "ready") return null;
    const { renderer, camera, rotationGizmo } = this.life.scene;
    if (!rotationGizmo.root.visible) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        (-(clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    const hits = ray.intersectObject(rotationGizmo.root, true);
    for (const hit of hits) {
      let cur: THREE.Object3D | null = hit.object;
      while (cur !== null) {
        if (cur.userData?.isRotateGizmo === true) {
          return this.gizmoTargetId();
        }
        cur = cur.parent;
      }
    }
    return null;
  }
  private async loadCellAssets(
    cell: SceneCell,
    robot: Parameters<typeof loadRobotVisual>[0],
    humanBakerOnly: boolean,
  ): Promise<void> {
    try {
      const [robotVisual, workcellVisuals] = await Promise.all([
        humanBakerOnly
          ? Promise.resolve(null)
          : loadRobotVisual(robot, this.abort.signal),
        loadWorkcellVisuals(
          {
            ur5eTooling: !humanBakerOnly && cell.model.usesUr5eTooling(),
          },
          this.abort.signal,
        ),
        ensureLivingAssetsLoaded(this.abort.signal),
      ]);
      if (this.life.kind !== "ready") {
        robotVisual?.traverse(disposePhysicsObject);
        disposeWorkcellVisualBundle(workcellVisuals);
        return;
      }
      if (robotVisual !== null) cell.model.attachRobot(robotVisual);
      cell.model.attachWorkcellVisuals(workcellVisuals);
      this.loadedCells.add(cell.id);
      this.checkReady();
      this.updateScene();
    } catch {
      if (!this.abort.signal.aborted) this.unavailable();
    }
  }
  private updateStores(): void {
    if (this.life.kind !== "ready" || this.source.stores === null) return;
    const stores = this.source.stores;
    const key = JSON.stringify(stores);
    if (this.storesKey === key) return;
    this.storesKey = key;
    const group = this.life.scene.stores;
    group.traverse(disposePhysicsObject);
    group.clear();
    for (const [index, store] of stores.entries()) {
      const station = new THREE.Group();
      station.position.set((index - (stores.length - 1) / 2) * 1.5, 0, 2.5);
      const base = new THREE.Mesh(
        new RoundedBoxGeometry(1.1, 0.1, 0.65, 3, 0.014),
        new THREE.MeshStandardMaterial({
          color:
            store.occupants.length === store.capacity ? 0xc08959 : 0x9daaa1,
          roughness: 0.46,
          metalness: 0.12,
        }),
      );
      base.position.y = 0.4;
      base.castShadow = true;
      base.receiveShadow = true;
      station.add(base);
      for (let slot = 0; slot < store.occupants.length; slot++) {
        const tray = new THREE.Mesh(
          new RoundedBoxGeometry(0.6, 0.035, 0.4, 3, 0.007),
          new THREE.MeshStandardMaterial({
            color: 0xd0d5d6,
            roughness: 0.34,
            metalness: 0.62,
          }),
        );
        tray.position.y = 0.48 + slot * 0.08;
        tray.castShadow = true;
        tray.receiveShadow = true;
        station.add(tray);
      }
      group.add(station);
    }
  }
  private activePeerIds(): readonly ApplianceId[] {
    const ids: string[] = [...STORE_DECOR_IDS];
    for (const station of this.source.stations ?? []) ids.push(station.id);
    for (const transfer of this.source.cobotTransfers ?? [])
      ids.push(transfer.cellId);
    for (const cell of this.source.cells) ids.push(cell.id);
    return ids.filter(isApplianceId);
  }
  private floorPointAt(
    clientX: number,
    clientY: number,
    heightY = 0,
  ): THREE.Vector3 | null {
    if (this.life.kind !== "ready") return null;
    const { renderer, camera } = this.life.scene;
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        (-(clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    const target = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -heightY);
    return ray.ray.intersectPlane(plane, target);
  }
  private hitIdAt(clientX: number, clientY: number): string | null {
    if (this.life.kind !== "ready") return null;
    const { renderer, camera, cells, stations } = this.life.scene;
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        (-(clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    const roots: THREE.Object3D[] = [];
    for (const cell of cells.values()) roots.push(cell.root);
    for (const cellId of ["espresso-cell", "pour-over-cell"]) {
      const object = stations?.cobotLayer.cellRoot(cellId);
      if (object != null && object.visible) roots.push(object);
    }
    for (const station of this.source.stations ?? []) {
      const object = stations?.layer.station(station.id);
      if (object != null) roots.push(object);
    }
    roots.push(this.life.scene.roomShell);
    const hit = ray.intersectObjects(roots, true)[0];
    if (hit === undefined) return null;
    let object: THREE.Object3D | null = hit.object;
    while (object !== null) {
      if (typeof object.userData?.decorId === "string") {
        return object.userData.decorId;
      }
      for (const cell of cells.values())
        if (cell.root === object) return cell.id;
      for (const cellId of ["espresso-cell", "pour-over-cell"])
        if (stations?.cobotLayer.cellRoot(cellId) === object) return cellId;
      for (const station of this.source.stations ?? [])
        if (stations?.layer.station(station.id) === object) return station.id;
      object = object.parent;
    }
    return null;
  }
  private pointerDown = (event: PointerEvent): void => {
    this.pointer = { x: event.clientX, y: event.clientY };
  };
  private pointerMove = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (
      gesture.kind === "idle" ||
      event.pointerId !== gesture.pointerId ||
      this.life.kind !== "ready"
    )
      return;
    if (
      !gesture.moved &&
      Math.hypot(
        event.clientX - gesture.startX,
        event.clientY - gesture.startY,
      ) < 4
    ) {
      return;
    }
    gesture.moved = true;
    const { renderer, dragOutline } = this.life.scene;
    renderer.domElement.style.cursor = "grabbing";
    const planId = this.source.floorPlan ?? floorPlanWorkspace.getActivePlan();
    if (gesture.kind === "rotate") {
      const planePoint = this.floorPointAt(event.clientX, event.clientY, 0.48);
      if (planePoint === null) return;
      const curAngle = Math.atan2(
        planePoint.x - gesture.centerX,
        planePoint.z - gesture.centerZ,
      );
      const nextRotY = gesture.startRotY + (curAngle - gesture.startAngle);
      const resolved = setApplianceRotationWithCollisions(
        planId,
        gesture.id,
        nextRotY,
        this.activePeerIds(),
        true,
        `phys-rot:${gesture.id}:${gesture.pointerId}:${gesture.startX}:${gesture.startY}`,
      );
      const box2d = getApplianceBox(
        gesture.id,
        resolved.pose.x,
        resolved.pose.z,
        resolved.pose.rotY,
      );
      dragOutline.box.set(
        new THREE.Vector3(box2d.x0, 0.02, box2d.z0),
        new THREE.Vector3(box2d.x1, 0.95, box2d.z1),
      );
      dragOutline.visible = true;
      this.select(gesture.id);
      this.updateScene();
      return;
    }
    const floorPoint = this.floorPointAt(event.clientX, event.clientY);
    if (floorPoint === null) return;
    const resolved = moveApplianceWithCollisions(
      planId,
      gesture.id,
      floorPoint.x - gesture.offsetX,
      floorPoint.z - gesture.offsetZ,
      this.activePeerIds(),
      `phys-move:${gesture.id}:${gesture.pointerId}:${gesture.startX}:${gesture.startY}`,
    );
    const box2d = getApplianceBox(
      gesture.id,
      resolved.pose.x,
      resolved.pose.z,
      resolved.pose.rotY,
    );
    dragOutline.box.set(
      new THREE.Vector3(box2d.x0, 0.02, box2d.z0),
      new THREE.Vector3(box2d.x1, 0.95, box2d.z1),
    );
    if (dragOutline.material instanceof THREE.LineBasicMaterial) {
      dragOutline.material.color.setHex(
        resolved.kind === "blocked" || resolved.contactedBoundary
          ? 0xd97706
          : 0x10b981,
      );
    }
    dragOutline.visible = true;
    this.select(gesture.id);
    this.updateScene();
  };
  private pointerCancel = (event: PointerEvent): void => {
    if (
      this.gesture.kind !== "idle" &&
      event.pointerId === this.gesture.pointerId
    ) {
      this.gesture = { kind: "idle" };
      if (this.life.kind === "ready") {
        setRotationGizmoActive(this.life.scene.rotationGizmo, false);
        this.life.scene.dragOutline.visible = false;
        this.life.scene.controls.enabled = true;
        this.life.scene.renderer.domElement.style.cursor = "";
        this.renderScene();
      }
    }
  };
  private pointerUp = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (gesture.kind !== "idle" && event.pointerId === gesture.pointerId) {
      this.gesture = { kind: "idle" };
      if (this.life.kind === "ready") {
        setRotationGizmoActive(this.life.scene.rotationGizmo, false);
        this.life.scene.dragOutline.visible = false;
        this.life.scene.controls.enabled = true;
        this.life.scene.renderer.domElement.style.cursor = "";
      }
      if (gesture.kind === "rotate" && !gesture.moved) {
        const planId =
          this.source.floorPlan ?? floorPlanWorkspace.getActivePlan();
        rotateApplianceWithCollisions(planId, gesture.id, this.activePeerIds());
        this.pointer = null;
        return;
      }
      if (gesture.moved) {
        this.pointer = null;
        this.renderScene();
        return;
      }
    }
    const pointer = this.pointer;
    this.pointer = null;
    if (
      pointer === null ||
      Math.hypot(pointer.x - event.clientX, pointer.y - event.clientY) > 5 ||
      this.life.kind !== "ready"
    )
      return;
    const hitId = this.hitIdAt(event.clientX, event.clientY);
    if (hitId !== null) {
      if (isApplianceId(hitId)) this.activeGizmoId = hitId;
      this.select(hitId);
      return;
    }
    const openingId = this.openingHitAt(event.clientX, event.clientY);
    if (openingId !== null) {
      floorPlanWorkspace.toggleOpening(openingId);
      return;
    }
    this.activeGizmoId = null;
    this.syncRotationGizmo3D();
    this.renderScene();
  };
  private openingHitAt(
    clientX: number,
    clientY: number,
  ): FloorPlanOpening | null {
    if (this.life.kind !== "ready") return null;
    const { renderer, camera, roomShell } = this.life.scene;
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(pointer, camera);
    return pickFloorPlanOpening(ray, roomShell.children);
  }
}

/** The station name, how full its main store is, and any active appliance telemetry. */
function stationText(
  station: FactoryStationSource,
  stores: FactorySceneSource["stores"],
  appliances: readonly SynchronizedApplianceState[] | null = null,
): string {
  let base = station.label;
  for (const store of stores ?? [])
    if (store.id === station.primary) {
      base = `${station.label} ${store.occupants.length}/${store.capacity}`;
      break;
    }
  const faulted = (appliances ?? []).find(
    (a) => a.stationId === station.id && a.status === "fault",
  );
  if (faulted !== undefined) {
    return `${base} · FAULT (${faulted.fault?.code ?? "PAUSED"})`;
  }
  const active = (appliances ?? []).find(
    (a) => a.stationId === station.id && a.status === "active",
  );
  if (active !== undefined) {
    if (active.rpm > 0) return `${base} · ${active.rpm.toLocaleString()} RPM`;
    if (active.category === "weigh" && active.massG > 0)
      return `${base} · ${active.massG} g`;
    return `${base} · ${active.temperatureC.toFixed(0)} °C`;
  }
  return base;
}
