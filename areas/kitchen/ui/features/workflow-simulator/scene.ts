import type { StrictUnion } from "@purin-labs/type-utils";
import type { FloorPlanOpening } from "@purin-labs/production-simulation/floor/openings";
import { pickFloorPlanOpening } from "./spatial/floor-plan-openings-3d";
import { floorPlanWorkspace } from "./floor-plan-workspace";
import { createBakeryGrid, updateBakeryGrid } from "./spatial/bakery-grid";
import {
  buildArticulatedCustomerVisitor,
  buildArticulatedHumanWorker,
  poseArticulatedHumanWorker,
  type ArticulatedHumanWorker,
} from "./spatial/human-worker-figure";
import { type StationId } from "@purin-labs/bakery-model/bakery";
import * as THREE from "three";
import {
  buildRotationGizmo3D,
  setRotationGizmoActive,
} from "./spatial/rotation-gizmo";
import type { SceneLabelMode } from "./simulator-state";
import { CanvasResize } from "./canvas-resize";
import {
  LAYOUT_MOTION_ATTRIBUTE,
  layoutMotionActive,
  layoutMotionResizing,
} from "@purin-labs/ui/layout-motion";
import { machineAttention, machineSummary } from "@purin-labs/production-simulation/simulator/demo";
import { selectionContext, type Selection } from "@purin-labs/production-simulation/simulator/selection";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import {
  sceneLabel,
  arrangeLabels,
  setLabelContent,
  type LabelSwatch,
} from "./scene-labels";
import { loadBakeryStation, stationFootprintModel } from "./bakery-assets";
import {
  setupBakeryLightingAndPost,
  type BakeryLightingRig,
} from "./spatial/scene-lighting";
import { FloorPlan } from "./spatial/floor-plan";
import { bakeryRoom, type BakeryFloorPlanId } from "@purin-labs/production-simulation/floor/bakery-room";
import {
  getApplianceHandoffPoint,
  getApplianceLocalHandoffPoint,
  getColdStorageStandPoint,
  getStorefrontCustomerPoints,
  getVitrineStandPoint,
  getWashSinkStandPoint,
  getWorkerReadyPoint,
  interpolateRoomWalk,
  moveApplianceWithCollisions,
  resolveMultiWorkerPositions,
  rotateApplianceWithCollisions,
  setApplianceRotationWithCollisions,
} from "./bakery-appliance-layout";
import { getApplianceBox } from "@purin-labs/production-simulation/floor/collisions";
import {
  APPLIANCE_FOOTPRINTS,
  REHEARSAL_APPLIANCE_IDS,
  STORE_DECOR_IDS,
  isApplianceId,
  type ApplianceId,
} from "@purin-labs/production-simulation/floor/appliance-catalogue";
import {
  createFloorPlanShell,
  type FloorPlanShell,
} from "./spatial/floor-plan-shell";
import { buildContactShadowPad } from "./spatial/floor-plan-fixtures";
import {
  getStoreInteriorDesign,
  subscribeStoreInteriorDesign,
} from "./store-interior-design";
import {
  planFootprint,
  type FloorPlanActor,
  type FloorPlanItem,
} from "./spatial/floor-plan-geometry";
import {
  CSS2DObject,
  CSS2DRenderer,
} from "three/addons/renderers/CSS2DRenderer.js";
import {
  bindOvenVisual,
  buildSteamPlumeGroup,
  updateOvenVisual,
  updateSteamPlumeGroup,
  type OvenVisual,
} from "./oven-visual";
import {
  batchAt,
  describe,
  doorAt,
  machineAt,
  plan61ASubstepAt,
  stationLabel,
  stations,
  subscribeVitrineRushPreset,
  type BatchSnapshot,
  type Process,
  type Run,
  type VitrineCustomerOrder,
  vitrineStockAt,
  workName,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { assertNever } from "@purin-labs/std";
export type SceneGesture = StrictUnion<
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
    }
>;

export type SceneFrame = {
  readonly run: Run;
  readonly time: number;
  readonly selection: Selection;
  readonly top: boolean;
  /** Label detail; frames without it use the automatic level. */
  readonly labels?: SceneLabelMode;
  /** Present when the host shell, not the pane, opens the floor plan. */
  readonly floorPlan?: Readonly<{ open: boolean; minimap: boolean }>;
};

/** View changes that start inside the scene but belong to the host shell. */
export type SceneViewChange =
  | Readonly<{ kind: "floorPlan"; open: boolean }>
  | Readonly<{ kind: "minimap"; visible: boolean }>
  | Readonly<{ kind: "overviewRoom"; fits: boolean }>
  | Readonly<{ kind: "camera"; moved: boolean }>;

export type SceneViewListener = (change: SceneViewChange) => void;

const floorPlanPanelId = "workflow-dock-floorPlan";
/** Home views that Recenter and the top-view toggle return to. */
const cameraTarget = new THREE.Vector3(0, 0.9, 0);
const angledCamera = new THREE.Vector3(9.6, 9.6, 11.5);
const topCamera = new THREE.Vector3(0, 17.8, 0.01);
const CAMERA_FOV = 25;
/** Batches closer than this share one label. */
const batchGroupRadius = 0.4;
const colors = [
  "#c99346",
  "#738ca2",
  "#b77c67",
  "#8570a0",
  "#578d80",
  "#9b9860",
] as const;

/** Batches and workers take palette colors in turn, wrapping past the end. */
function paletteColor(index: number): string {
  return colors[index % colors.length] ?? colors[0];
}

export class BakeryScene {
  private readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera = new THREE.PerspectiveCamera(
    CAMERA_FOV,
    1,
    0.25,
    90,
  );
  private readonly controls: OrbitControls;
  private readonly lighting: BakeryLightingRig;
  private readonly observer: ResizeObserver;
  private readonly motionObserver: MutationObserver;
  private readonly themeObserver: MutationObserver;
  private readonly floor: THREE.Mesh<
    THREE.BoxGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly wall: THREE.Mesh<
    THREE.BoxGeometry,
    THREE.MeshStandardMaterial
  >;
  private customFloorShell: FloorPlanShell | null = null;
  private readonly unsubscribeFloorPlan: () => void;
  private readonly unsubscribePlacements: () => void;
  private readonly unsubscribeInterior: () => void;
  private readonly unsubscribeVitrineRush: () => void;
  private readonly unsubscribeOpenings: () => void;
  private readonly dragOutline = new THREE.Box3Helper(
    new THREE.Box3(),
    0x10b981,
  );
  private readonly rotationGizmo = buildRotationGizmo3D();
  private gesture: SceneGesture = { kind: "idle" };
  private readonly grid = createBakeryGrid();
  private readonly floorPlan: FloorPlan<Selection>;
  private readonly stationModels = new Map<StationId, THREE.Group>();
  private readonly stationContactShadows = new Map<StationId, THREE.Group>();
  private oven: OvenVisual | null = null;
  private stagePlanetary: THREE.Object3D | null = null;
  private stageToolAxis: THREE.Object3D | null = null;
  private stageScaleIngredients: THREE.Mesh | null = null;
  private stageButterLiquid: THREE.Mesh | null = null;
  private stageHobGlow: THREE.Mesh | null = null;
  private stageHobLight: THREE.PointLight | null = null;
  private stageButterSteam: ReturnType<typeof buildSteamPlumeGroup> | null =
    null;
  private coolRackSteam: ReturnType<typeof buildSteamPlumeGroup> | null = null;
  private stageMixerBatter: THREE.Mesh | null = null;
  private portionDepositor: THREE.Object3D | null = null;
  private readonly picks = new WeakMap<THREE.Object3D, Selection>();
  private readonly markers: BatchTrayVisual[] = [];
  private readonly labels = new CSS2DRenderer();
  private readonly stationLabels = new Map<StationId, CSS2DObject>();
  private readonly batchLabels: CSS2DObject[] = [];
  private readonly workers: ArticulatedHumanWorker[] = [];
  private readonly workerLabels: CSS2DObject[] = [];
  private readonly customers: ArticulatedHumanWorker[] = [];
  private readonly customerLabels: CSS2DObject[] = [];
  private activeCustomerStates: readonly CustomerRoomState[] = [];
  private readonly loadAbort = new AbortController();
  private readonly reduced = matchMedia("(prefers-reduced-motion: reduce)");
  private life: "active" | "disposed" = "active";
  private size = { width: 0, height: 0 };
  private readonly canvasResize: CanvasResize;
  private frame: SceneFrame;
  private pointer: { x: number; y: number } | null = null;
  private hovered: Selection | null = null;
  private hoverPoint: { x: number; y: number } | null = null;
  private hoverFrame = 0;
  private cameraMoved = false;
  private activeGizmoId: ApplianceId | null = null;
  private stationDeselected = false;
  private readonly onWindowKeyDown: (event: KeyboardEvent) => void;

  /**
   * `details` hosts the floor plan's selection and fit details for the shell.
   * `unavailable` tells the page that the browser took the WebGL context, so
   * the page shows the scene as unavailable and does not keep a stopped view.
   */
  constructor(
    host: HTMLElement,
    frame: SceneFrame,
    private readonly select: (
      selection: Selection,
      focus: "inspector" | "unchanged",
    ) => void,
    private readonly view?: SceneViewListener,
    details?: HTMLElement,
    private readonly unavailable?: () => void,
  ) {
    this.frame = frame;
    this.activeGizmoId =
      frame.selection.kind === "station" ? frame.selection.id : null;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.domElement.classList.add("workflow-scene-canvas");
    this.renderer.domElement.setAttribute(
      "aria-label",
      "3D bakery. Equivalent batch, task, worker and station controls follow this view.",
    );
    this.camera.position.copy(angledCamera);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    this.controls.touches.ONE = THREE.TOUCH.PAN;
    this.controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
    this.controls.screenSpacePanning = true;
    this.renderer.domElement.addEventListener(
      "pointerdown",
      (event: PointerEvent) => {
        const hasModifier = event.ctrlKey || event.metaKey || event.shiftKey;
        if (!hasModifier && !event.altKey && event.button === 0) {
          const gizmoTargetId = this.rotateGizmoHitAt(
            event.clientX,
            event.clientY,
          );
          if (gizmoTargetId !== null) {
            const pose = floorPlanWorkspace.getPose(
              floorPlanWorkspace.getActivePlan(),
              gizmoTargetId,
            );
            const planePoint = this.planePointAt(
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
            setRotationGizmoActive(this.rotationGizmo, true);
            this.controls.enabled = false;
            try {
              this.renderer.domElement.setPointerCapture(event.pointerId);
            } catch {
              /* ignore synthetic events without active pointer id */
            }
            this.render();
            return;
          }
          const draggableId = this.draggableHitAt(event.clientX, event.clientY);
          if (draggableId !== null) {
            this.activeGizmoId = draggableId;
            this.stationDeselected = false;
            this.floorPlan.setGizmoTarget(draggableId);
            const floorPoint = this.floorPointAt(event.clientX, event.clientY);
            const pose = floorPlanWorkspace.getPose(
              floorPlanWorkspace.getActivePlan(),
              draggableId,
            );
            this.gesture = {
              kind: "move",
              id: draggableId,
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              offsetX: floorPoint !== null ? floorPoint.x - pose.x : 0,
              offsetZ: floorPoint !== null ? floorPoint.z - pose.z : 0,
              moved: false,
            };
            this.controls.enabled = false;
            try {
              this.renderer.domElement.setPointerCapture(event.pointerId);
            } catch {
              /* ignore synthetic events without active pointer id */
            }
            return;
          }
        }
        this.controls.enabled = true;
        this.controls.mouseButtons.LEFT =
          !hasModifier && event.altKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
        this.controls.mouseButtons.RIGHT = hasModifier
          ? THREE.MOUSE.PAN
          : THREE.MOUSE.ROTATE;
      },
      { capture: true },
    );
    this.controls.target.copy(cameraTarget);
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 34;
    this.controls.update();
    this.floorPlan = new FloorPlan(
      host,
      this.scene,
      this.selectFloorResource.bind(this),
      this.focusBounds.bind(this),
      this.resetView.bind(this),
      [],
      {
        hover: this.hoverFromPlan.bind(this),
        gizmoChange: this.gizmoFromPlan.bind(this),
        details,
        pane:
          frame.floorPlan === undefined
            ? { trigger: "pane" }
            : {
                trigger: "external",
                panelId: floorPlanPanelId,
                openChange: this.floorPlanChanged.bind(this),
                minimapChange: this.minimapChanged.bind(this),
                overviewRoomChange: this.overviewRoomChanged.bind(this),
              },
      },
    );
    this.floorPlan.setGizmoTarget(this.activeGizmoId);
    this.labels.domElement.className = "workflow-scene-labels";
    this.labels.domElement.setAttribute("aria-hidden", "true");
    this.floorPlan.viewport.append(this.labels.domElement);
    this.render = this.render.bind(this);
    this.resize = this.resize.bind(this);
    this.layoutMotionChanged = this.layoutMotionChanged.bind(this);
    this.canvasResize = new CanvasResize(this.renderer, this.render);
    this.pick = this.pick.bind(this);
    this.pointerDown = this.pointerDown.bind(this);
    this.pointerMove = this.pointerMove.bind(this);
    this.pointerLeave = this.pointerLeave.bind(this);
    this.hoverPick = this.hoverPick.bind(this);
    this.motionChanged = this.motionChanged.bind(this);
    this.themeChanged = this.themeChanged.bind(this);
    this.cameraSettled = this.cameraSettled.bind(this);
    this.controls.addEventListener("change", this.render);
    this.controls.addEventListener("end", this.cameraSettled);
    this.lighting = setupBakeryLightingAndPost(
      this.renderer,
      this.scene,
      this.camera,
    );
    this.floor = this.box(
      [bakeryRoom.width, 0.1, bakeryRoom.depth],
      [0, -0.05, 0],
      "#d4dac9",
    );
    this.wall = this.box(
      [
        bakeryRoom.width,
        bakeryRoom.rearWallHeight,
        bakeryRoom.rearWallThickness,
      ],
      [0, bakeryRoom.rearWallHeight / 2, -bakeryRoom.depth / 2],
      "#f1ecdc",
    );
    for (const item of stations) {
      const label = sceneLabel(item.label);
      label.position.set(item.position[0], 2.1, item.position[2]);
      this.scene.add(label);
      this.stationLabels.set(item.id, label);
    }
    this.dragOutline.visible = false;
    this.scene.add(this.dragOutline);
    this.scene.add(this.rotationGizmo.root);
    this.applyFloorPlan(floorPlanWorkspace.getActivePlan());
    this.unsubscribeFloorPlan = floorPlanWorkspace.subscribePlan((id) => {
      if (this.life === "disposed") return;
      this.applyFloorPlan(id);
      this.update(this.frame);
    });
    this.unsubscribePlacements = floorPlanWorkspace.subscribePlacements(() => {
      if (this.life === "disposed") return;
      this.syncStationPlacements(floorPlanWorkspace.getActivePlan());
      this.update(this.frame);
    });
    this.unsubscribeInterior = subscribeStoreInteriorDesign(() => {
      if (this.life === "disposed") return;
      this.applyFloorPlan(floorPlanWorkspace.getActivePlan());
      this.update(this.frame);
    });
    this.unsubscribeVitrineRush = subscribeVitrineRushPreset(() => {
      if (this.life === "disposed") return;
      this.update(this.frame);
    });
    this.unsubscribeOpenings = floorPlanWorkspace.subscribeOpenings(
      (planId) => {
        if (planId !== this.customFloorShell?.planId) return;
        if (this.life === "disposed") return;
        this.customFloorShell?.syncOpenings();
        this.syncWorkers(this.frame);
        this.render();
      },
    );
    this.scene.add(this.grid);
    for (let i = 0; i < 6; i++) {
      const marker = buildBatchTrayVisual(paletteColor(i));
      this.scene.add(marker.root);
      this.markers.push(marker);
      const batchSelection: Selection = {
        kind: "batch",
        id: String.fromCharCode(65 + i),
      };
      for (const node of marker.root.getObjectsByProperty("isObject3D", true)) {
        this.picks.set(node, batchSelection);
      }
      const label = sceneLabel(`Batch ${String.fromCharCode(65 + i)}`);
      this.scene.add(label);
      this.batchLabels.push(label);
    }
    for (let i = 0; i < 3; i++) {
      const worker = buildArticulatedHumanWorker(i, paletteColor(i + 1));
      this.scene.add(worker.root);
      this.workers.push(worker);
      const label = sceneLabel("");
      this.scene.add(label);
      this.workerLabels.push(label);
    }
    for (let i = 0; i < 2; i++) {
      const customer = buildArticulatedCustomerVisitor(i);
      customer.root.visible = false;
      this.scene.add(customer.root);
      this.customers.push(customer);
      const label = sceneLabel("");
      label.visible = false;
      this.scene.add(label);
      this.customerLabels.push(label);
    }
    this.floorPlan.viewport.append(this.renderer.domElement);
    this.doubleClick = this.doubleClick.bind(this);
    this.onWindowKeyDown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
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
        if (this.activeGizmoId !== null || !this.stationDeselected) {
          this.activeGizmoId = null;
          this.stationDeselected = true;
          this.floorPlan.setGizmoTarget(null);
          this.syncRotationGizmo3D();
          this.updateFloorPlan();
          this.updateLabels();
          this.render();
        }
        return;
      }
      if (event.key !== "r" && event.key !== "R") return;
      this.rotateActiveAppliance();
      event.preventDefault();
    };
    window.addEventListener("keydown", this.onWindowKeyDown);
    this.renderer.domElement.addEventListener("pointerdown", this.pointerDown, {
      capture: true,
    });
    this.renderer.domElement.addEventListener("pointerup", this.pick);
    this.renderer.domElement.addEventListener("pointermove", this.pointerMove);
    this.renderer.domElement.addEventListener(
      "pointerleave",
      this.pointerLeave,
    );
    this.renderer.domElement.addEventListener("dblclick", this.doubleClick);
    this.renderer.domElement.addEventListener(
      "webglcontextlost",
      this.contextLost,
    );
    this.reduced.addEventListener("change", this.motionChanged);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(this.floorPlan.viewport);
    this.motionObserver = new MutationObserver(this.layoutMotionChanged);
    this.motionObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [LAYOUT_MOTION_ATTRIBUTE],
    });
    this.themeObserver = new MutationObserver(this.themeChanged);
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-portal-theme"],
    });
    this.themeChanged();
    this.resize();
    this.update(frame);
  }
  async load(): Promise<void> {
    await Promise.all(stations.map(this.loadStation.bind(this)));
  }
  private async loadStation(item: (typeof stations)[number]): Promise<void> {
    const root = await loadBakeryStation(item);
    if (this.life === "disposed") {
      disposeObjects(root);
      return;
    }
    for (const node of root.getObjectsByProperty("isObject3D", true)) {
      this.picks.set(node, { kind: "station", id: item.id });
      if (!(node instanceof THREE.Mesh)) continue;
      if (node.userData.excludeFromAo !== true) node.castShadow = true;
      node.receiveShadow = true;
    }
    const pose = floorPlanWorkspace.getPose(
      floorPlanWorkspace.getActivePlan(),
      item.id,
    );
    root.position.set(pose.x, 0, pose.z);
    root.rotation.y = pose.rotY;
    root.updateMatrixWorld(true);
    this.scene.add(root);
    this.stationModels.set(item.id, root);
    const fp = APPLIANCE_FOOTPRINTS[item.id];
    const shadowPad = buildContactShadowPad(
      fp.halfWidth * 2.08,
      fp.halfDepth * 2.08,
      0.28,
    );
    shadowPad.name = `station-contact-shadow:${item.id}`;
    shadowPad.position.set(pose.x, 0.0065, pose.z);
    shadowPad.rotation.y = pose.rotY;
    this.scene.add(shadowPad);
    this.stationContactShadows.set(item.id, shadowPad);
    if (item.id === "bake") this.oven = bindOvenVisual(root);
    if (item.id === "stage") {
      this.stagePlanetary = root.getObjectByName("hl_planetary") ?? null;
      this.stageToolAxis = root.getObjectByName("hl_tool_axis") ?? null;
      this.stageScaleIngredients =
        (root.getObjectByName("stage_scale_ingredients") as
          THREE.Mesh | undefined) ?? null;
      this.stageButterLiquid =
        (root.getObjectByName("stage_butter_liquid") as
          THREE.Mesh | undefined) ?? null;
      this.stageHobGlow =
        (root.getObjectByName("stage_hob_glow") as THREE.Mesh | undefined) ??
        null;
      this.stageMixerBatter =
        (root.getObjectByName("stage_mixer_batter") as
          THREE.Mesh | undefined) ?? null;
      const hobPos =
        this.stageHobGlow?.position ?? new THREE.Vector3(0, 0.9, 0);
      const hobLight = new THREE.PointLight(0xff7b24, 0, 1.6, 1.8);
      hobLight.name = "stage-hob-light";
      hobLight.position.set(hobPos.x, hobPos.y + 0.14, hobPos.z);
      root.add(hobLight);
      this.stageHobLight = hobLight;
      const butterSteam = buildSteamPlumeGroup("stage-butter-steam", 3);
      butterSteam.group.position.set(hobPos.x, hobPos.y + 0.12, hobPos.z);
      root.add(butterSteam.group);
      this.stageButterSteam = butterSteam;
    }
    if (item.id === "cool") {
      const coolSteam = buildSteamPlumeGroup("cool-rack-steam", 3);
      coolSteam.group.position.set(0, 1.38, 0);
      root.add(coolSteam.group);
      this.coolRackSteam = coolSteam;
    }
    if (item.id === "portion") {
      this.portionDepositor = root.getObjectByName("portion_depositor") ?? null;
    }
    this.update(this.frame);
  }
  update(frame: SceneFrame): void {
    if (this.life === "disposed") return;
    const turned = this.frame.top !== frame.top;
    if (turned) {
      this.camera.position.copy(frame.top ? topCamera : angledCamera);
      this.controls.target.copy(cameraTarget);
      this.controls.update();
    }
    if (!sameSelection(this.frame.selection, frame.selection)) {
      this.stationDeselected = false;
      this.activeGizmoId =
        frame.selection.kind === "station" ? frame.selection.id : null;
      this.floorPlan.setGizmoTarget(this.activeGizmoId);
    }
    this.frame = frame;
    if (turned) this.cameraSettled();
    const context = selectionContext(frame.run, frame.selection, frame.time);
    if (this.oven) {
      updateOvenVisual(
        this.oven,
        machineAt(frame.run, "bake", frame.time).state,
        doorAt(frame.run, "bake", frame.time, this.reduced.matches),
        frame.time,
        this.reduced.matches,
      );
    }
    const activeStageInterval = frame.run.intervals.find(
      (iv): iv is Process =>
        iv.kind === "process" &&
        iv.operation === "stage" &&
        frame.time >= (iv.start === 0 ? 0 : iv.arrival) &&
        frame.time < iv.end,
    );
    const stageSubstep =
      activeStageInterval !== undefined
        ? plan61ASubstepAt(activeStageInterval, frame.time)
        : null;
    if (this.stageScaleIngredients) {
      const fill =
        stageSubstep === null
          ? 0.65
          : stageSubstep.id === "weigh-ingredients"
            ? 0.25 + 0.75 * stageSubstep.progress
            : stageSubstep.id === "cook-brown-butter"
              ? 1.0
              : Math.max(0.18, 1.0 - 0.82 * stageSubstep.progress);
      this.stageScaleIngredients.scale.set(1, fill, 1);
    }
    if (this.stageHobGlow && this.stageButterLiquid) {
      const glowMat = this.stageHobGlow.material as THREE.MeshStandardMaterial;
      const butterMat = this.stageButterLiquid
        .material as THREE.MeshStandardMaterial;
      if (stageSubstep?.id === "cook-brown-butter") {
        const pulse = this.reduced.matches
          ? 0.8
          : 0.75 + 0.25 * Math.sin(frame.time * 4);
        glowMat.emissiveIntensity = pulse;
        if (this.stageHobLight) {
          this.stageHobLight.intensity = 0.82 * pulse;
        }
        if (this.stageButterSteam) {
          updateSteamPlumeGroup(
            this.stageButterSteam,
            0.35 + 0.65 * stageSubstep.progress,
            frame.time,
            this.reduced.matches,
          );
        }
        butterMat.color.lerpColors(
          new THREE.Color(0xf3d37a),
          new THREE.Color(0xb8681e),
          stageSubstep.progress,
        );
      } else {
        glowMat.emissiveIntensity = 0;
        if (this.stageHobLight) {
          this.stageHobLight.intensity = 0;
        }
        if (this.stageButterSteam) {
          updateSteamPlumeGroup(
            this.stageButterSteam,
            0,
            frame.time,
            this.reduced.matches,
          );
        }
        butterMat.color.setHex(
          stageSubstep?.id === "weigh-ingredients" ? 0xf3d37a : 0xb8681e,
        );
      }
    }
    if (this.coolRackSteam) {
      const coolingActive =
        machineAt(frame.run, "cool", frame.time).state === "running";
      updateSteamPlumeGroup(
        this.coolRackSteam,
        coolingActive ? 0.55 : 0,
        frame.time,
        this.reduced.matches,
      );
    }
    if (this.stagePlanetary && this.stageToolAxis) {
      const mixing = stageSubstep?.id === "mix-batter" && !this.reduced.matches;
      this.stagePlanetary.rotation.y = mixing ? frame.time * 0.95 : 0;
      this.stageToolAxis.rotation.y = mixing ? -frame.time * 2.75 : 0;
    }
    if (this.stageMixerBatter) {
      const batterScale =
        stageSubstep === null
          ? 1
          : stageSubstep.id === "mix-batter"
            ? 0.38 + 0.62 * stageSubstep.progress
            : 0.38;
      this.stageMixerBatter.scale.set(1, batterScale, 1);
    }
    if (this.portionDepositor) {
      const portionRunning =
        machineAt(frame.run, "portion", frame.time).state === "running" &&
        !this.reduced.matches;
      this.portionDepositor.position.set(
        -0.02 + (portionRunning ? Math.sin(frame.time * 0.28) * 0.08 : 0),
        0.85 +
          (portionRunning ? Math.abs(Math.cos(frame.time * 0.56)) * 0.024 : 0),
        0.02,
      );
    }
    for (const [i, marker] of this.markers.entries()) {
      const batch = frame.run.batches[i];
      marker.root.visible = batch !== undefined;
      const label = this.batchLabels[i];
      if (!batch || !label) continue;
      const snapshot = batchAt(frame.run, batch, frame.time);
      marker.root.position.set(
        ...batchPosition(snapshot, i, frame.time, this.reduced.matches),
      );
      marker.root.scale.setScalar(context.batch?.id === batch.id ? 1.18 : 1);
      updateBatchTrayVisual(marker, snapshot, frame.time);
      label.position.copy(marker.root.position);
      label.position.y += 0.3;
    }
    const vitrineStock = vitrineStockAt(frame.run, frame.time);
    this.syncWorkers(frame, vitrineStock.orders);
    this.customFloorShell?.syncVitrineStock(
      vitrineStock.loosePieces,
      vitrineStock.ballotinBoxes,
    );
    this.updateLabels();
    this.syncRotationGizmo3D();
    if (frame.floorPlan !== undefined) {
      this.floorPlan.setOpen(frame.floorPlan.open);
      this.floorPlan.setMinimap(frame.floorPlan.minimap);
    }
    this.updateFloorPlan();
    this.render();
  }
  private syncWorkers(
    frame: SceneFrame,
    orders: readonly VitrineCustomerOrder[] = vitrineStockAt(
      frame.run,
      frame.time,
    ).orders,
  ): void {
    const planId = floorPlanWorkspace.getActivePlan();
    const visibleWorkerIndices: number[] = [];
    const workerStates: WorkerRoomState[] = [];
    for (const [i, worker] of this.workers.entries()) {
      const resource = frame.run.resources[i];
      worker.root.visible = resource !== undefined;
      const label = this.workerLabels[i];
      if (resource === undefined || !label) continue;
      visibleWorkerIndices.push(i);
      workerStates.push(
        workerRoomStateAt(
          frame.run,
          resource,
          i,
          frame.time,
          this.reduced.matches,
          planId,
        ),
      );
    }
    const customerStates = customerRoomStatesAt(
      orders,
      frame.time,
      this.reduced.matches,
      planId,
      this.customers.length,
    );
    this.activeCustomerStates = customerStates;
    const allRequests = [
      ...workerStates.map((s) => ({ x: s.x, z: s.z, priority: s.priority })),
      ...customerStates.map((s) => ({ x: s.x, z: s.z, priority: s.priority })),
    ];
    const resolvedPoints = resolveMultiWorkerPositions(
      planId,
      allRequests,
      SCENE_WORKER_OBSTACLE_IDS,
      0.62,
      0.28,
    );
    const actors: FloorPlanActor[] = [];
    for (const [k, i] of visibleWorkerIndices.entries()) {
      const worker = this.workers[i];
      const resource = frame.run.resources[i];
      const label = this.workerLabels[i];
      const state = workerStates[k];
      const point = resolvedPoints[k];
      if (!worker || !resource || !label || !state || !point) continue;
      worker.root.position.set(point[0], 0, point[1]);
      worker.root.scale.setScalar(1);
      const resourceSelection: Selection = {
        kind: "resource",
        id: resource.id,
      };
      for (const node of worker.root.getObjectsByProperty("isObject3D", true)) {
        this.picks.set(node, resourceSelection);
      }
      updateHumanWorkerPoseInScene(
        worker,
        state,
        point,
        i,
        frame.time,
        this.reduced.matches,
      );
      label.position.set(point[0], 1.72, point[1]);
      const dx = state.facingTarget[0] - point[0];
      const dz = state.facingTarget[1] - point[1];
      actors.push({
        id: resource.id,
        kind: "worker",
        label: resource.name,
        x: point[0],
        z: point[1],
        facingYawRad: Math.hypot(dx, dz) > 1e-3 ? Math.atan2(dx, dz) : Math.PI,
        color: paletteColor(i + 1),
        carrying: state.carrying,
      });
    }
    const workerOffset = visibleWorkerIndices.length;
    for (const [ci, customer] of this.customers.entries()) {
      const state = customerStates[ci];
      const label = this.customerLabels[ci];
      const point = resolvedPoints[workerOffset + ci];
      if (state === undefined || point === undefined) {
        customer.root.visible = false;
        if (label !== undefined) label.visible = false;
        continue;
      }
      customer.root.visible = true;
      customer.root.position.set(point[0], 0, point[1]);
      customer.root.scale.setScalar(1);
      updateHumanWorkerPoseInScene(
        customer,
        state,
        point,
        ci + 4,
        frame.time,
        this.reduced.matches,
      );
      if (label !== undefined) {
        label.position.set(point[0], 1.68, point[1]);
      }
      const dx = state.facingTarget[0] - point[0];
      const dz = state.facingTarget[1] - point[1];
      actors.push({
        id: state.orderId,
        kind: "customer",
        label: `${state.orderId} · ${state.channelLabel}`,
        x: point[0],
        z: point[1],
        facingYawRad: Math.hypot(dx, dz) > 1e-3 ? Math.atan2(dx, dz) : Math.PI,
        color: "#c99346",
        carrying: state.carrying,
      });
    }
    this.floorPlan.setActors(actors);
  }
  /**
   * Labels stay short until something needs attention, the object is
   * selected or hovered, or the viewer asks for every detail.
   */
  private updateLabels(): void {
    const { run, time } = this.frame;
    const mode = this.frame.labels ?? "auto";
    const context = selectionContext(run, this.frame.selection, time);
    const hovered = this.hovered;
    for (const [index, item] of stations.entries()) {
      const label = this.stationLabels.get(item.id);
      if (label === undefined) continue;
      const selected = this.selectedStation(item.id);
      const hover = hovered?.kind === "station" && hovered.id === item.id;
      const full = mode === "all" || selected || hover;
      const attention =
        mode === "auto" ? machineAttention(run, item.id, time) : null;
      label.visible = full || mode === "auto";
      let lines: readonly string[] = [];
      if (full) lines = machineSummary(run, item.id, time).split("\n");
      else if (attention !== null) lines = [attention];
      setLabelContent(label, {
        kind: "station",
        badge: String(index + 1),
        title: item.label,
        swatches: [],
        status: machineAt(run, item.id, time).state,
        lines,
        selected,
        hovered: hover,
        priority: labelPriority(selected, hover, attention !== null, 3),
        required: full || attention !== null,
      });
    }
    const groups: BatchLabelGroup[] = [];
    for (const [i, label] of this.batchLabels.entries()) {
      const marker = this.markers[i],
        batch = run.batches[i];
      label.visible = false;
      if (batch === undefined || !marker?.root.visible) continue;
      const selected = context.batch?.id === batch.id;
      const hover = hovered?.kind === "batch" && hovered.id === batch.id;
      const snapshot = batchAt(run, batch, time);
      const moving =
        snapshot.kind === "transfer" &&
        time >= snapshot.pickup &&
        time < snapshot.loadedEnd;
      const full = mode === "all" || selected || hover;
      if (full || (moving && mode === "auto")) {
        label.visible = true;
        const batchLines = full
          ? snapshot.kind === "process"
            ? [describe(snapshot), plan61ASubstepAt(snapshot, time).shortLabel]
            : [describe(snapshot)]
          : [];
        setLabelContent(label, {
          kind: "batch",
          badge: null,
          title: "",
          swatches: [{ color: paletteColor(i), text: workName(run, batch.id) }],
          status: null,
          lines: batchLines,
          selected,
          hovered: hover,
          priority: labelPriority(selected, hover, false, 4),
          required: full,
        });
        continue;
      }
      if (mode === "off") continue;
      const swatch = { color: paletteColor(i), text: batch.id };
      const group = groups.find(near.bind(null, marker.root.position));
      if (group !== undefined) group.swatches.push(swatch);
      else
        groups.push({
          label,
          x: marker.root.position.x,
          z: marker.root.position.z,
          swatches: [swatch],
        });
    }
    for (const group of groups) {
      group.label.visible = true;
      setLabelContent(group.label, {
        kind: "batch",
        badge: null,
        title: "",
        swatches: group.swatches,
        status: null,
        lines: [],
        selected: false,
        hovered: false,
        priority: 4,
        required: false,
      });
    }
    for (const [i, label] of this.workerLabels.entries()) {
      const resource = run.resources[i];
      if (resource === undefined) {
        label.visible = false;
        continue;
      }
      const selected = context.resource?.id === resource.id;
      const hover = hovered?.kind === "resource" && hovered.id === resource.id;
      const full = mode === "all" || selected || hover;
      label.visible = full || mode === "auto";
      const activeWorkerProcess = full
        ? run.intervals.find(
            (iv): iv is Process =>
              iv.kind === "process" &&
              iv.attended &&
              iv.executor === resource.id &&
              time >= (iv.start === 0 ? 0 : iv.arrival) &&
              time < iv.end,
          )
        : undefined;
      setLabelContent(label, {
        kind: "worker",
        badge: null,
        title: "",
        swatches: [
          {
            color: paletteColor(i + 1),
            text: full ? resource.name : initials(resource.name),
          },
        ],
        status: null,
        lines:
          activeWorkerProcess !== undefined
            ? [plan61ASubstepAt(activeWorkerProcess, time).shortLabel]
            : [],
        selected,
        hovered: hover,
        priority: labelPriority(selected, hover, false, 5),
        required: full,
      });
    }
    for (const [ci, label] of this.customerLabels.entries()) {
      const state = this.activeCustomerStates[ci];
      if (state === undefined || mode === "off") {
        label.visible = false;
        continue;
      }
      const full = mode === "all";
      label.visible = true;
      setLabelContent(label, {
        kind: "worker",
        badge: null,
        title: "",
        swatches: [
          {
            color: "#c99346",
            text: full
              ? `${state.orderId} · ${state.channelLabel}`
              : state.orderId,
          },
        ],
        status: null,
        lines: full ? [state.statusText] : [],
        selected: false,
        hovered: false,
        priority: 6,
        required: full,
      });
    }
  }
  private selectFloorResource(selection: Selection): void {
    this.stationDeselected = false;
    this.activeGizmoId = selection.kind === "station" ? selection.id : null;
    this.floorPlan.setGizmoTarget(this.activeGizmoId);
    this.syncRotationGizmo3D();
    this.select(selection, "unchanged");
  }
  private gizmoFromPlan(id: string | null): void {
    this.activeGizmoId = id !== null && isApplianceId(id) ? id : null;
    this.stationDeselected = id === null;
    this.syncRotationGizmo3D();
    this.updateFloorPlan();
    this.updateLabels();
    this.render();
  }
  private floorPlanChanged(open: boolean): void {
    this.view?.({ kind: "floorPlan", open });
  }
  private minimapChanged(visible: boolean): void {
    this.view?.({ kind: "minimap", visible });
  }
  private overviewRoomChanged(fits: boolean): void {
    this.view?.({ kind: "overviewRoom", fits });
  }
  private hoverFromPlan(selection: Selection | null): void {
    this.setHovered(selection, "plan");
  }
  private setHovered(
    selection: Selection | null,
    source: "plan" | "scene",
  ): void {
    if (sameSelection(this.hovered, selection)) return;
    this.hovered = selection;
    if (source === "scene")
      this.floorPlan.setHovered(
        selection?.kind === "station" ? selection.id : null,
      );
    this.updateLabels();
    this.render();
  }
  private updateFloorPlan(): void {
    const items: FloorPlanItem<Selection>[] = [];
    const selected: string[] = [];
    const planId = floorPlanWorkspace.getActivePlan();
    for (const item of stations) {
      const id = item.id;
      const model = this.stationModels.get(id);
      if (model === undefined) continue;
      const footprintModel = stationFootprintModel(model);
      items.push({
        id,
        label: stationLabel(id),
        bounds: new THREE.Box3().setFromObject(footprintModel),
        footprint: planFootprint([footprintModel]),
        selection: { kind: "station", id },
        number: stations.indexOf(item) + 1,
        state: machineAt(this.frame.run, id, this.frame.time).state,
        geometry: { kind: "visual-only" },
      });
      if (this.selectedStation(id)) selected.push(id);
    }
    if (planId !== "reference" && getStoreInteriorDesign().showFurnishings) {
      for (const [decorIndex, decorId] of STORE_DECOR_IDS.entries()) {
        const pose = floorPlanWorkspace.getPose(planId, decorId);
        const fp = APPLIANCE_FOOTPRINTS[decorId];
        const box = getApplianceBox(decorId, pose.x, pose.z, pose.rotY);
        const bounds = new THREE.Box3(
          new THREE.Vector3(box.x0, 0, box.z0),
          new THREE.Vector3(box.x1, 0.95, box.z1),
        );
        items.push({
          id: decorId,
          label: fp.label,
          bounds,
          footprint: [
            [
              [box.x0, box.z0],
              [box.x1, box.z0],
              [box.x1, box.z1],
              [box.x0, box.z1],
            ],
          ],
          selection: null,
          context: true,
          number: stations.length + decorIndex + 1,
          geometry: { kind: "visual-only" },
        });
        if (this.activeGizmoId === decorId && !this.stationDeselected) {
          selected.push(decorId);
        }
      }
    }
    this.floorPlan.update(items, selected, []);
  }
  private focusBounds(bounds: THREE.Box3): void {
    const center = bounds.getCenter(new THREE.Vector3());
    const offset = this.camera.position
      .clone()
      .sub(this.controls.target)
      .setLength(angledCamera.distanceTo(cameraTarget) * 0.5);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(offset);
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.render();
    this.cameraSettled();
  }
  /** Tells the shell whether the camera still sits at its home view. */
  private cameraSettled(): void {
    const home = this.frame.top ? topCamera : angledCamera;
    const moved =
      Math.abs(this.camera.zoom - 1) > 1e-3 ||
      this.camera.position.distanceTo(home) > 1e-3 ||
      this.controls.target.distanceTo(cameraTarget) > 1e-3;
    if (moved === this.cameraMoved) return;
    this.cameraMoved = moved;
    this.view?.({ kind: "camera", moved });
  }
  private box(
    size: readonly [number, number, number],
    position: readonly [number, number, number],
    color: string,
  ): THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial> {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(...size),
      new THREE.MeshStandardMaterial({ color, roughness: 0.7 }),
    );
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return mesh;
  }
  private motionChanged(): void {
    this.update(this.frame);
  }
  private themeChanged(): void {
    if (this.life === "disposed") return;
    const dark = document.documentElement.dataset.portalTheme === "dark";
    this.floor.material.color.set(dark ? "#343b35" : "#d4dac9");
    this.wall.material.color.set(dark ? "#474a43" : "#f1ecdc");
    this.lighting.setDarkTheme(dark);
    updateBakeryGrid(this.grid, dark);
    this.render();
  }
  private selectedStation(id: StationId): boolean {
    if (this.stationDeselected) return false;
    const { selection, run, time } = this.frame;
    if (selection.kind === "station") return selection.id === id;
    const context = selectionContext(run, selection, time);
    if (context.task !== null) {
      return (
        context.task.station === id ||
        (context.task.kind === "transfer" && context.task.from === id)
      );
    }
    for (const batch of run.batches) {
      if (batch.id !== context.batch?.id) continue;
      const current = batchAt(run, batch, time);
      switch (current.kind) {
        case "process":
        case "handoff":
        case "native":
          return current.station === id;
        case "transfer":
          return current.station === id || current.from === id;
        case "wait":
          return current.location === id;
        case "complete":
        case "unreleased":
        case "unfinished":
          return false;
        default:
          return assertNever(current);
      }
    }
    return false;
  }
  resetView(): void {
    this.camera.zoom = 1;
    this.camera.position.copy(angledCamera);
    this.controls.target.copy(cameraTarget);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.render();
    this.cameraSettled();
  }
  private pointerDown(event: PointerEvent): void {
    this.pointer = { x: event.clientX, y: event.clientY };
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey)
      return;
    if (this.gesture.kind === "rotate") return;
    const draggableId = this.draggableHitAt(event.clientX, event.clientY);
    if (draggableId !== null) {
      this.activeGizmoId = draggableId;
      this.stationDeselected = false;
      this.floorPlan.setGizmoTarget(draggableId);
      const floorPoint = this.floorPointAt(event.clientX, event.clientY);
      const pose = floorPlanWorkspace.getPose(
        floorPlanWorkspace.getActivePlan(),
        draggableId,
      );
      if (floorPoint !== null) {
        this.gesture = {
          kind: "move",
          id: draggableId,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          offsetX: floorPoint.x - pose.x,
          offsetZ: floorPoint.z - pose.z,
          moved: false,
        };
        this.controls.enabled = false;
      }
    }
  }
  private rotateGizmoHitAt(x: number, y: number): ApplianceId | null {
    if (!this.rotationGizmo.root.visible) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((x - rect.left) / rect.width) * 2 - 1,
        (-(y - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    );
    const hits = ray.intersectObject(this.rotationGizmo.root, true);
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
  private planePointAt(
    x: number,
    y: number,
    heightY: number,
  ): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((x - rect.left) / rect.width) * 2 - 1,
        (-(y - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    );
    const target = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -heightY);
    return ray.ray.intersectPlane(plane, target);
  }
  private gizmoTargetId(): ApplianceId | null {
    if (this.activeGizmoId !== null && isApplianceId(this.activeGizmoId)) {
      return this.activeGizmoId;
    }
    return null;
  }
  private syncRotationGizmo3D(): void {
    const targetId = this.gizmoTargetId();
    if (targetId === null) {
      this.rotationGizmo.root.visible = false;
      return;
    }
    const fp = APPLIANCE_FOOTPRINTS[targetId];
    if (fp === undefined) {
      this.rotationGizmo.root.visible = false;
      return;
    }
    const pose = floorPlanWorkspace.getPose(
      floorPlanWorkspace.getActivePlan(),
      targetId,
    );
    const radius = Math.hypot(fp.halfWidth, fp.halfDepth) + 0.16;
    this.rotationGizmo.root.position.set(pose.x, 0.48, pose.z);
    this.rotationGizmo.root.scale.setScalar(radius);
    this.rotationGizmo.root.rotation.y = pose.rotY;
    this.rotationGizmo.root.visible = true;
    this.rotationGizmo.root.updateMatrixWorld(true);
  }
  private readonly contextLost = (event: Event): void => {
    event.preventDefault();
    if (this.life === "disposed") return;
    this.unavailable?.();
  };
  private doubleClick(event: MouseEvent): void {
    const draggableId = this.draggableHitAt(event.clientX, event.clientY);
    if (draggableId === null) return;
    this.activeGizmoId = draggableId;
    this.stationDeselected = false;
    this.floorPlan.setGizmoTarget(draggableId);
    rotateApplianceWithCollisions(
      floorPlanWorkspace.getActivePlan(),
      draggableId,
      REHEARSAL_APPLIANCE_IDS,
    );
  }
  private rotateActiveAppliance(): void {
    const planId = floorPlanWorkspace.getActivePlan();
    if (this.gesture.kind === "move") {
      const id = this.gesture.id;
      this.activeGizmoId = id !== null && isApplianceId(id) ? id : null;
      this.stationDeselected = false;
      this.floorPlan.setGizmoTarget(id);
      const resolved = rotateApplianceWithCollisions(
        planId,
        id,
        REHEARSAL_APPLIANCE_IDS,
      );
      this.gesture.offsetX = 0;
      this.gesture.offsetZ = 0;
      this.floorPlan.showPlacementResult(resolved);
      const box2d = getApplianceBox(
        id,
        resolved.pose.x,
        resolved.pose.z,
        resolved.pose.rotY,
      );
      this.dragOutline.box.set(
        new THREE.Vector3(box2d.x0, 0.02, box2d.z0),
        new THREE.Vector3(box2d.x1, 0.95, box2d.z1),
      );
      this.dragOutline.visible = true;
      this.render();
      return;
    }
    let targetId = this.activeGizmoId;
    if (targetId === null && this.hovered?.kind === "station") {
      targetId = this.hovered.id;
    }
    if (targetId === null) return;
    this.activeGizmoId = targetId;
    this.stationDeselected = false;
    this.floorPlan.setGizmoTarget(targetId);
    rotateApplianceWithCollisions(planId, targetId, REHEARSAL_APPLIANCE_IDS);
  }
  private draggableHitAt(x: number, y: number): ApplianceId | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((x - rect.left) / rect.width) * 2 - 1,
        (-(y - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    );
    for (const hit of ray.intersectObjects(this.scene.children, true)) {
      const selection = this.picks.get(hit.object);
      if (selection?.kind === "station") return selection.id;
      let cur: THREE.Object3D | null = hit.object;
      while (cur !== null) {
        if (
          typeof cur.userData?.decorId === "string" &&
          isApplianceId(cur.userData.decorId)
        ) {
          return cur.userData.decorId;
        }
        cur = cur.parent;
      }
    }
    return null;
  }
  private openingHitAt(x: number, y: number): FloorPlanOpening | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((x - rect.left) / rect.width) * 2 - 1,
        (-(y - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    );
    return pickFloorPlanOpening(ray, this.scene.children);
  }
  private pick(event: PointerEvent): void {
    const rotDrag = this.gesture.kind === "rotate" ? this.gesture : null;
    if (rotDrag !== null && event.pointerId === rotDrag.pointerId) {
      this.gesture = { kind: "idle" };
      setRotationGizmoActive(this.rotationGizmo, false);
      this.dragOutline.visible = false;
      this.controls.enabled = true;
      this.renderer.domElement.style.cursor = "";
      if (!rotDrag.moved) {
        rotateApplianceWithCollisions(
          floorPlanWorkspace.getActivePlan(),
          rotDrag.id,
          REHEARSAL_APPLIANCE_IDS,
        );
      }
      this.pointer = null;
      this.render();
      return;
    }
    const drag = this.gesture.kind === "move" ? this.gesture : null;
    if (drag !== null && event.pointerId === drag.pointerId) {
      this.gesture = { kind: "idle" };
      this.dragOutline.visible = false;
      this.controls.enabled = true;
      this.renderer.domElement.style.cursor = "";
      if (drag.moved) {
        this.pointer = null;
        this.render();
        return;
      }
    }
    const pointer = this.pointer;
    this.pointer = null;
    if (
      !pointer ||
      event.button !== 0 ||
      Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5
    )
      return;
    const draggableId = this.draggableHitAt(event.clientX, event.clientY);
    const selection = this.hitAt(event.clientX, event.clientY);
    const openingId = this.openingHitAt(event.clientX, event.clientY);
    if (
      openingId !== null &&
      ((draggableId === null && selection === null) ||
        openingId.kind === "door")
    ) {
      floorPlanWorkspace.toggleOpening(openingId);
      return;
    }
    if (draggableId !== null) {
      this.activeGizmoId = draggableId;
      this.stationDeselected = false;
      this.floorPlan.setGizmoTarget(draggableId);
      if (selection !== null) {
        this.select(
          selection,
          this.floorPlan.isOpen ? "unchanged" : "inspector",
        );
      }
    } else {
      this.activeGizmoId = null;
      this.stationDeselected = selection === null;
      this.floorPlan.setGizmoTarget(null);
      if (selection !== null) {
        this.select(
          selection,
          this.floorPlan.isOpen ? "unchanged" : "inspector",
        );
      }
    }
    this.syncRotationGizmo3D();
    this.updateFloorPlan();
    this.updateLabels();
    this.render();
  }
  private floorPointAt(x: number, y: number): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((x - rect.left) / rect.width) * 2 - 1,
        (-(y - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    );
    const target = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    return ray.ray.intersectPlane(plane, target);
  }
  private hitAt(x: number, y: number): Selection | null {
    const rect = this.renderer.domElement.getBoundingClientRect(),
      ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((x - rect.left) / rect.width) * 2 - 1,
        (-(y - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    );
    for (const hit of ray.intersectObjects(this.scene.children, true)) {
      const selection = this.picks.get(hit.object);
      if (selection) return selection;
    }
    return null;
  }
  private pointerMove(event: PointerEvent): void {
    const rotDrag = this.gesture.kind === "rotate" ? this.gesture : null;
    if (rotDrag !== null && event.pointerId === rotDrag.pointerId) {
      if (
        !rotDrag.moved &&
        Math.hypot(
          event.clientX - rotDrag.startX,
          event.clientY - rotDrag.startY,
        ) < 3
      ) {
        return;
      }
      rotDrag.moved = true;
      this.renderer.domElement.style.cursor = "grabbing";
      setRotationGizmoActive(this.rotationGizmo, true);
      const planePoint = this.planePointAt(event.clientX, event.clientY, 0.48);
      if (planePoint === null) return;
      const curAngle = Math.atan2(
        planePoint.x - rotDrag.centerX,
        planePoint.z - rotDrag.centerZ,
      );
      const nextRotY = rotDrag.startRotY + (curAngle - rotDrag.startAngle);
      const planId = floorPlanWorkspace.getActivePlan();
      const resolved = setApplianceRotationWithCollisions(
        planId,
        rotDrag.id,
        nextRotY,
        REHEARSAL_APPLIANCE_IDS,
        !event.shiftKey,
        `scene-rot:${rotDrag.id}:${rotDrag.pointerId}:${rotDrag.startX}:${rotDrag.startY}`,
      );
      this.floorPlan.showPlacementResult(resolved);
      const box2d = getApplianceBox(
        rotDrag.id,
        resolved.pose.x,
        resolved.pose.z,
        resolved.pose.rotY,
      );
      this.dragOutline.box.set(
        new THREE.Vector3(box2d.x0, 0.02, box2d.z0),
        new THREE.Vector3(box2d.x1, 0.95, box2d.z1),
      );
      if (this.dragOutline.material instanceof THREE.LineBasicMaterial) {
        this.dragOutline.material.color.setHex(
          resolved.kind === "blocked" || resolved.contactedBoundary
            ? 0xd97706
            : 0x3b82f6,
        );
      }
      this.dragOutline.visible = true;
      this.render();
      return;
    }
    const drag = this.gesture.kind === "move" ? this.gesture : null;
    if (drag !== null && event.pointerId === drag.pointerId) {
      if (
        !drag.moved &&
        Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4
      ) {
        return;
      }
      drag.moved = true;
      this.renderer.domElement.style.cursor = "grabbing";
      const floorPoint = this.floorPointAt(event.clientX, event.clientY);
      if (floorPoint === null) return;
      const planId = floorPlanWorkspace.getActivePlan();
      const resolved = moveApplianceWithCollisions(
        planId,
        drag.id,
        floorPoint.x - drag.offsetX,
        floorPoint.z - drag.offsetZ,
        REHEARSAL_APPLIANCE_IDS,
        `scene-move:${drag.id}:${drag.pointerId}:${drag.startX}:${drag.startY}`,
      );
      this.floorPlan.showPlacementResult(resolved);
      const box2d = getApplianceBox(
        drag.id,
        resolved.pose.x,
        resolved.pose.z,
        resolved.pose.rotY,
      );
      this.dragOutline.box.set(
        new THREE.Vector3(box2d.x0, 0.02, box2d.z0),
        new THREE.Vector3(box2d.x1, 0.95, box2d.z1),
      );
      if (this.dragOutline.material instanceof THREE.LineBasicMaterial) {
        this.dragOutline.material.color.setHex(
          resolved.kind === "blocked" || resolved.contactedBoundary
            ? 0xd97706
            : 0x10b981,
        );
      }
      this.dragOutline.visible = true;
      this.render();
      return;
    }
    // Hover previews follow a resting pointer, not a pan or rotate drag.
    if (event.buttons !== 0 || event.pointerType === "touch") return;
    this.hoverPoint = { x: event.clientX, y: event.clientY };
    if (this.hoverFrame === 0)
      this.hoverFrame = requestAnimationFrame(this.hoverPick);
  }
  private pointerLeave(): void {
    if (this.gesture.kind === "rotate") {
      this.gesture = { kind: "idle" };
      setRotationGizmoActive(this.rotationGizmo, false);
      this.dragOutline.visible = false;
      this.controls.enabled = true;
    }
    if (this.gesture.kind === "move") {
      this.gesture = { kind: "idle" };
      this.dragOutline.visible = false;
      this.controls.enabled = true;
    }
    this.hoverPoint = null;
    cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = 0;
    this.renderer.domElement.style.cursor = "";
    this.setHovered(null, "scene");
  }
  private hoverPick(): void {
    this.hoverFrame = 0;
    const point = this.hoverPoint;
    if (point === null || this.life !== "active") return;
    const gizmoHover = this.rotateGizmoHitAt(point.x, point.y) !== null;
    setRotationGizmoActive(
      this.rotationGizmo,
      gizmoHover || this.gesture.kind === "rotate",
    );
    if (gizmoHover) {
      this.renderer.domElement.style.cursor = "grab";
      this.render();
      return;
    }
    const selection = this.hitAt(point.x, point.y);
    const draggableHover =
      selection === null ? this.draggableHitAt(point.x, point.y) : null;
    const openingHover =
      selection === null && draggableHover === null
        ? this.openingHitAt(point.x, point.y)
        : null;
    this.renderer.domElement.style.cursor =
      selection !== null || draggableHover !== null || openingHover !== null
        ? "pointer"
        : "";
    this.setHovered(selection, "scene");
    this.render();
  }
  private layoutMotionChanged(): void {
    this.resize();
    // The views fade in on this phase: place the labels against the settled
    // layout first, so they do not shift as the fade begins.
    if (document.documentElement.getAttribute(LAYOUT_MOTION_ATTRIBUTE) === "in")
      this.render();
  }
  private resize(): void {
    if (this.life === "disposed") return;
    // The views are hidden while the layout moves; resize once it settles.
    if (layoutMotionActive()) return;
    const width = Math.max(1, this.floorPlan.viewport.clientWidth),
      height = Math.max(1, this.floorPlan.viewport.clientHeight);
    // Animated layouts resize the viewport every frame, often by under a
    // pixel. Resizing the renderer clears its drawing buffer, so only whole-
    // pixel changes pay for a resize and redraw.
    if (width === this.size.width && height === this.size.height) return;
    this.size = { width, height };
    const aspect = width / height;
    this.labels.setSize(width, height);
    this.canvasResize.resize(width, height);
    // Hidden and settled: allocate the final buffer before the fade-in.
    if (layoutMotionResizing()) this.canvasResize.flush();
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.render();
    // Hidden and settled: finish the GPU work now, not during the fade-in.
    if (layoutMotionResizing()) this.renderer.getContext().finish();
  }
  private render(): void {
    if (this.life !== "active") return;
    const labels = [
      ...this.stationLabels.values(),
      ...this.batchLabels,
      ...this.workerLabels,
      ...this.customerLabels,
    ];
    this.lighting.render(this.camera);
    this.labels.render(this.scene, this.camera);
    arrangeLabels(
      labels,
      this.floorPlan.viewport.getBoundingClientRect(),
      this.floorPlan.occluders(),
    );
  }
  private applyFloorPlan(id: BakeryFloorPlanId): void {
    if (this.customFloorShell !== null) {
      this.customFloorShell.dispose();
      this.customFloorShell = null;
    }
    this.lighting.setExteriorPlaneY(id === "reference" ? -0.102 : -0.092);
    if (id === "reference") {
      this.floor.visible = true;
      this.wall.visible = true;
      this.grid.visible = true;
    } else {
      this.floor.visible = false;
      this.wall.visible = false;
      this.grid.visible = false;
      this.customFloorShell = createFloorPlanShell(
        id,
        "bake",
        floorPlanWorkspace,
      );
      this.scene.add(this.customFloorShell.root);
    }
    this.syncStationPlacements(id);
  }
  private syncStationPlacements(planId: BakeryFloorPlanId): void {
    for (const item of stations) {
      const pose = floorPlanWorkspace.getPose(planId, item.id);
      const label = this.stationLabels.get(item.id);
      if (label !== undefined) {
        label.position.set(pose.x, 2.1, pose.z);
      }
      const model = this.stationModels.get(item.id);
      if (model !== undefined) {
        model.position.set(pose.x, 0, pose.z);
        model.rotation.y = pose.rotY;
        model.updateMatrixWorld(true);
      }
      const shadowPad = this.stationContactShadows.get(item.id);
      if (shadowPad !== undefined) {
        shadowPad.position.set(pose.x, 0.0065, pose.z);
        shadowPad.rotation.y = pose.rotY;
      }
    }
    this.customFloorShell?.syncPlacements();
    this.syncRotationGizmo3D();
  }
  dispose(): void {
    if (this.life === "disposed") return;
    this.life = "disposed";
    window.removeEventListener("keydown", this.onWindowKeyDown);
    this.unsubscribeFloorPlan();
    this.unsubscribePlacements();
    this.unsubscribeInterior();
    this.unsubscribeVitrineRush();
    this.unsubscribeOpenings();
    this.loadAbort.abort();
    this.floorPlan.dispose();
    this.observer.disconnect();
    this.motionObserver.disconnect();
    this.canvasResize.dispose();
    this.themeObserver.disconnect();
    this.controls.removeEventListener("end", this.cameraSettled);
    this.controls.dispose();
    this.reduced.removeEventListener("change", this.motionChanged);
    this.renderer.domElement.removeEventListener("dblclick", this.doubleClick);
    this.renderer.domElement.removeEventListener(
      "webglcontextlost",
      this.contextLost,
    );
    this.renderer.domElement.removeEventListener(
      "pointerdown",
      this.pointerDown,
      { capture: true },
    );
    this.renderer.domElement.removeEventListener("pointerup", this.pick);
    this.renderer.domElement.removeEventListener(
      "pointermove",
      this.pointerMove,
    );
    this.renderer.domElement.removeEventListener(
      "pointerleave",
      this.pointerLeave,
    );
    cancelAnimationFrame(this.hoverFrame);
    this.customFloorShell?.dispose();
    this.customFloorShell = null;
    disposeObjects(this.scene);
    this.lighting.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}

type BatchTrayVisual = {
  readonly root: THREE.Group;
  readonly ingotMat: THREE.MeshStandardMaterial;
  readonly bosseMat: THREE.MeshStandardMaterial;
  readonly ingots: readonly THREE.Mesh[];
  readonly bosses: readonly THREE.Mesh[];
};

function buildBatchTrayVisual(accentColor: string): BatchTrayVisual {
  const root = new THREE.Group();
  const carrierMat = new THREE.MeshStandardMaterial({
    color: 0xc2cbd4,
    roughness: 0.3,
    metalness: 0.78,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: accentColor,
    roughness: 0.38,
    metalness: 0.25,
  });
  const mouldMat = new THREE.MeshStandardMaterial({
    color: 0x828c96,
    roughness: 0.36,
    metalness: 0.72,
  });
  const ingotMat = new THREE.MeshStandardMaterial({
    color: 0xe3b561,
    roughness: 0.32,
    metalness: 0.02,
  });
  const bosseMat = new THREE.MeshStandardMaterial({
    color: 0xbc6b21,
    roughness: 0.38,
    metalness: 0.02,
  });

  // 600x400 mm brushed aluminium carrier sheet
  const carrierBase = new THREE.Mesh(
    new RoundedBoxGeometry(0.45, 0.016, 0.3, 3, 0.005),
    carrierMat,
  );
  carrierBase.position.y = 0.008;
  carrierBase.castShadow = true;
  carrierBase.receiveShadow = true;
  root.add(carrierBase);

  // Batch-colored rim rails around the carrier perimeter
  const fbRailGeo = new RoundedBoxGeometry(0.456, 0.028, 0.024, 2, 0.005);
  for (const zSign of [-1, 1] as const) {
    const rail = new THREE.Mesh(fbRailGeo, accentMat);
    rail.position.set(0, 0.018, zSign * 0.142);
    rail.castShadow = true;
    root.add(rail);
  }
  const lrRailGeo = new RoundedBoxGeometry(0.024, 0.028, 0.264, 2, 0.005);
  for (const xSign of [-1, 1] as const) {
    const rail = new THREE.Mesh(lrRailGeo, accentMat);
    rail.position.set(xSign * 0.216, 0.018, 0);
    rail.castShadow = true;
    root.add(rail);
  }

  // Matsunaga 8P silicone-coated silver steel mould plate
  const mouldPlate = new THREE.Mesh(
    new RoundedBoxGeometry(0.36, 0.012, 0.23, 3, 0.004),
    mouldMat,
  );
  mouldPlate.position.y = 0.022;
  mouldPlate.castShadow = true;
  mouldPlate.receiveShadow = true;
  root.add(mouldPlate);

  const ingots: THREE.Mesh[] = [];
  const bosses: THREE.Mesh[] = [];
  const ingotGeo = new RoundedBoxGeometry(0.068, 0.016, 0.078, 2, 0.004);
  const bosseGeo = new THREE.SphereGeometry(
    0.022,
    14,
    10,
    0,
    Math.PI * 2,
    0,
    Math.PI * 0.55,
  );

  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 2; row++) {
      const cx = -0.126 + col * 0.084;
      const cz = row === 0 ? -0.052 : 0.052;
      const ingot = new THREE.Mesh(ingotGeo, ingotMat);
      ingot.position.set(cx, 0.032, cz);
      ingot.castShadow = true;
      root.add(ingot);
      ingots.push(ingot);

      const bosse = new THREE.Mesh(bosseGeo, bosseMat);
      bosse.scale.set(1.25, 0.28, 1.45);
      bosse.position.set(cx, 0.04, cz);
      bosse.visible = false;
      root.add(bosse);
      bosses.push(bosse);
    }
  }

  return { root, ingotMat, bosseMat, ingots, bosses };
}

function batchBakeProgress(snapshot: BatchSnapshot, time: number): number {
  switch (snapshot.kind) {
    case "unreleased":
    case "unfinished":
      return 0;
    case "complete":
      return 1;
    case "process":
    case "handoff":
    case "native":
      if (snapshot.station === "stage" || snapshot.station === "portion")
        return 0;
      if (snapshot.station === "bake") {
        return THREE.MathUtils.clamp(
          (time - snapshot.start) / Math.max(1, snapshot.end - snapshot.start),
          0,
          1,
        );
      }
      return 1;
    case "wait":
      return snapshot.location === "cool" || snapshot.location === "pack"
        ? 1
        : 0;
    case "transfer":
      return snapshot.from === "bake" || snapshot.from === "cool" ? 1 : 0;
    default:
      return assertNever(snapshot);
  }
}

const rawBatterColor = new THREE.Color(0xe3b561);
const bakedCrustColor = new THREE.Color(0xbc6b21);

function updateBatchTrayVisual(
  tray: BatchTrayVisual,
  snapshot: BatchSnapshot,
  time: number,
): void {
  const progress = batchBakeProgress(snapshot, time);
  tray.ingotMat.color.lerpColors(rawBatterColor, bakedCrustColor, progress);
  const hScale = 1 + progress * 0.32;
  for (const ingot of tray.ingots) {
    ingot.scale.set(1, hScale, 1);
    ingot.position.y = 0.024 + 0.008 * hScale;
  }
  const showBosse = progress > 0.12;
  for (const bosse of tray.bosses) {
    bosse.visible = showBosse;
    if (showBosse) {
      bosse.scale.set(1.25, 0.06 + progress * 0.28, 1.45);
      bosse.position.y = 0.036 + progress * 0.006;
    }
  }
}

const SCENE_WORKER_OBSTACLE_IDS: readonly ApplianceId[] = [
  "stage",
  "portion",
  "bake",
  "cool",
  "pack",
  "decor-bench",
  "decor-vitrine",
  "decor-planter",
];

type WorkerRoomState = Readonly<{
  x: number;
  z: number;
  priority: number;
  walking: boolean;
  working: boolean;
  carrying: boolean;
  facingTarget: readonly [number, number];
}>;

type CustomerRoomState = WorkerRoomState &
  Readonly<{
    orderId: string;
    channelLabel: string;
    statusText: string;
  }>;

function customerRoomStatesAt(
  orders: readonly VitrineCustomerOrder[],
  time: number,
  reduced: boolean,
  planId: BakeryFloorPlanId,
  maxVisitors: number,
): readonly CustomerRoomState[] {
  const pts = getStorefrontCustomerPoints(planId);
  const results: CustomerRoomState[] = [];

  for (const ord of orders) {
    if (results.length >= maxVisitors) break;
    const enterStart = Math.max(0, ord.orderedAt - 90);
    const serviceEnd =
      ord.fulfilledAt !== null
        ? ord.fulfilledAt > ord.orderedAt
          ? ord.fulfilledAt + 60
          : Math.max(ord.orderedAt + 210, ord.brewEnd + 60)
        : Infinity;
    const leaveEnd = serviceEnd + 90;
    const maxWaitEnd = ord.orderedAt + 900;
    if (
      time < enterStart ||
      (Number.isFinite(leaveEnd) ? time > leaveEnd : time > maxWaitEnd)
    ) {
      continue;
    }

    if (time < ord.orderedAt) {
      const u = reduced
        ? 1
        : THREE.MathUtils.clamp(
            (time - enterStart) / Math.max(1, ord.orderedAt - enterStart),
            0,
            1,
          );
      const pt = interpolateRoomWalk(
        planId,
        pts.doorThreshold,
        pts.vitrineStand.point,
        u,
        SCENE_WORKER_OBSTACLE_IDS,
      );
      const ahead = interpolateRoomWalk(
        planId,
        pts.doorThreshold,
        pts.vitrineStand.point,
        Math.min(1, u + 0.08),
        SCENE_WORKER_OBSTACLE_IDS,
      );
      results.push({
        x: pt[0],
        z: pt[1],
        priority: 1,
        walking: !reduced && u > 0 && u < 1,
        working: false,
        carrying: false,
        facingTarget:
          Math.hypot(ahead[0] - pt[0], ahead[1] - pt[1]) > 1e-3
            ? ahead
            : pts.vitrineStand.facingTarget,
        orderId: ord.id,
        channelLabel: ord.channelLabel,
        statusText: `Arriving · ${ord.channelLabel}`,
      });
      continue;
    }

    const waitedForRefill =
      ord.status === "waiting-refill" ||
      (ord.fulfilledAt !== null && ord.fulfilledAt > ord.orderedAt);
    if (waitedForRefill) {
      if (ord.fulfilledAt === null || time < ord.fulfilledAt) {
        if (time < ord.orderedAt + 45) {
          results.push({
            x: pts.vitrineStand.point[0],
            z: pts.vitrineStand.point[1],
            priority: 1,
            walking: false,
            working: !reduced,
            carrying: false,
            facingTarget: pts.vitrineStand.facingTarget,
            orderId: ord.id,
            channelLabel: ord.channelLabel,
            statusText: "Placing order at vitrine",
          });
          continue;
        }
        if (time < ord.orderedAt + 90) {
          const u = reduced ? 1 : (time - (ord.orderedAt + 45)) / 45;
          const pt = interpolateRoomWalk(
            planId,
            pts.vitrineStand.point,
            pts.benchStand.point,
            u,
            SCENE_WORKER_OBSTACLE_IDS,
          );
          results.push({
            x: pt[0],
            z: pt[1],
            priority: 1,
            walking: !reduced,
            working: false,
            carrying: false,
            facingTarget: pts.benchStand.point,
            orderId: ord.id,
            channelLabel: ord.channelLabel,
            statusText: "Walking to café bench",
          });
          continue;
        }
        results.push({
          x: pts.benchStand.point[0],
          z: pts.benchStand.point[1],
          priority: 1,
          walking: false,
          working: false,
          carrying: false,
          facingTarget: pts.benchStand.facingTarget,
          orderId: ord.id,
          channelLabel: ord.channelLabel,
          statusText: "Waiting at café bench for fresh batch",
        });
        continue;
      }
      if (time < ord.fulfilledAt + 30) {
        const u = reduced ? 1 : (time - ord.fulfilledAt) / 30;
        const pt = interpolateRoomWalk(
          planId,
          pts.benchStand.point,
          pts.vitrineStand.point,
          u,
          SCENE_WORKER_OBSTACLE_IDS,
        );
        results.push({
          x: pt[0],
          z: pt[1],
          priority: 1,
          walking: !reduced,
          working: false,
          carrying: false,
          facingTarget: pts.vitrineStand.point,
          orderId: ord.id,
          channelLabel: ord.channelLabel,
          statusText: "Returning to vitrine for pickup",
        });
        continue;
      }
      if (time < serviceEnd) {
        results.push({
          x: pts.vitrineStand.point[0],
          z: pts.vitrineStand.point[1],
          priority: 1,
          walking: false,
          working: !reduced,
          carrying: true,
          facingTarget: pts.vitrineStand.facingTarget,
          orderId: ord.id,
          channelLabel: ord.channelLabel,
          statusText: "Receiving ballotin box",
        });
        continue;
      }
    } else if (time < serviceEnd) {
      if (
        ord.channel === "qr-order" &&
        time >= ord.orderedAt + 45 &&
        time < serviceEnd - 45
      ) {
        const toBenchEnd = ord.orderedAt + 80;
        if (time < toBenchEnd) {
          const u = reduced ? 1 : (time - (ord.orderedAt + 45)) / 35;
          const pt = interpolateRoomWalk(
            planId,
            pts.vitrineStand.point,
            pts.benchStand.point,
            u,
            SCENE_WORKER_OBSTACLE_IDS,
          );
          results.push({
            x: pt[0],
            z: pt[1],
            priority: 1,
            walking: !reduced,
            working: false,
            carrying: false,
            facingTarget: pts.benchStand.point,
            orderId: ord.id,
            channelLabel: ord.channelLabel,
            statusText: "Seated at café bench",
          });
          continue;
        }
        results.push({
          x: pts.benchStand.point[0],
          z: pts.benchStand.point[1],
          priority: 1,
          walking: false,
          working: false,
          carrying: time >= ord.brewEnd,
          facingTarget: pts.benchStand.facingTarget,
          orderId: ord.id,
          channelLabel: ord.channelLabel,
          statusText:
            time < ord.brewEnd
              ? `Brewing ${ord.beverageLabel}`
              : `Enjoying ${ord.beverageLabel}`,
        });
        continue;
      }
      results.push({
        x: pts.vitrineStand.point[0],
        z: pts.vitrineStand.point[1],
        priority: 1,
        walking: false,
        working: !reduced && time < ord.orderedAt + 90,
        carrying: time >= ord.orderedAt + 90,
        facingTarget: pts.vitrineStand.facingTarget,
        orderId: ord.id,
        channelLabel: ord.channelLabel,
        statusText:
          time < ord.brewEnd
            ? `Brewing ${ord.beverageLabel}`
            : "Receiving ballotin box",
      });
      continue;
    }

    const leaveU = reduced
      ? 1
      : THREE.MathUtils.clamp(
          (time - serviceEnd) / Math.max(1, leaveEnd - serviceEnd),
          0,
          1,
        );
    const pt = interpolateRoomWalk(
      planId,
      pts.vitrineStand.point,
      pts.doorThreshold,
      leaveU,
      SCENE_WORKER_OBSTACLE_IDS,
    );
    const ahead = interpolateRoomWalk(
      planId,
      pts.vitrineStand.point,
      pts.doorThreshold,
      Math.min(1, leaveU + 0.08),
      SCENE_WORKER_OBSTACLE_IDS,
    );
    results.push({
      x: pt[0],
      z: pt[1],
      priority: 1,
      walking: !reduced && leaveU < 1,
      working: false,
      carrying: true,
      facingTarget:
        leaveU < 0.92 && Math.hypot(ahead[0] - pt[0], ahead[1] - pt[1]) > 1e-3
          ? ahead
          : pts.doorFacing,
      orderId: ord.id,
      channelLabel: ord.channelLabel,
      statusText: "Departing with ballotin",
    });
  }

  return results;
}

function isStationOccupiedByPeerAt(
  run: Run,
  stationId: StationId,
  selfId: Run["resources"][number]["id"],
  time: number,
): boolean {
  for (const task of run.intervals) {
    if (
      task.kind === "wait" ||
      !task.attended ||
      task.executor === selfId ||
      task.start > time ||
      task.end <= time
    ) {
      continue;
    }
    if (task.station === stationId) return true;
    if (task.kind === "transfer" && task.from === stationId) return true;
  }
  return false;
}

function workerRoomStateAt(
  run: Run,
  resource: Run["resources"][number],
  workerIndex: number,
  time: number,
  reduced: boolean,
  planId: BakeryFloorPlanId,
): WorkerRoomState {
  const readyPt = getWorkerReadyPoint(planId, workerIndex);
  let lastStationId: StationId | null = null;
  let lastEnd = 0;

  for (const task of run.intervals) {
    if (
      task.kind === "wait" ||
      !task.attended ||
      task.executor !== resource.id ||
      task.start > time
    ) {
      continue;
    }
    if (task.end <= time) {
      lastStationId = task.station;
      lastEnd = task.end;
      continue;
    }

    const prevPt =
      lastStationId !== null
        ? getApplianceHandoffPoint(planId, lastStationId)
        : readyPt;

    if (task.kind === "transfer") {
      const fromPt = getApplianceHandoffPoint(planId, task.from);
      const toPt = getApplianceHandoffPoint(planId, task.station);
      if (reduced) {
        const stId = time < task.pickup ? task.from : task.station;
        const pt = getApplianceHandoffPoint(planId, stId);
        const stPose = floorPlanWorkspace.getPose(planId, stId);
        return {
          x: pt[0],
          z: pt[1],
          priority: 2,
          walking: false,
          working: false,
          carrying: false,
          facingTarget: [stPose.x, stPose.z],
        };
      }
      if (time < task.pickupStart) {
        const u = THREE.MathUtils.clamp(
          (time - task.start) / Math.max(1, task.pickupStart - task.start),
          0,
          1,
        );
        const pt = interpolateRoomWalk(
          planId,
          prevPt,
          fromPt,
          u,
          SCENE_WORKER_OBSTACLE_IDS,
        );
        const ahead = interpolateRoomWalk(
          planId,
          prevPt,
          fromPt,
          Math.min(1, u + 0.08),
          SCENE_WORKER_OBSTACLE_IDS,
        );
        return {
          x: pt[0],
          z: pt[1],
          priority: 1,
          walking: true,
          working: false,
          carrying: false,
          facingTarget:
            Math.hypot(ahead[0] - pt[0], ahead[1] - pt[1]) > 1e-3
              ? ahead
              : fromPt,
        };
      }
      if (time < task.pickup) {
        const stPose = floorPlanWorkspace.getPose(planId, task.from);
        return {
          x: fromPt[0],
          z: fromPt[1],
          priority: 2,
          walking: false,
          working: true,
          carrying: true,
          facingTarget: [stPose.x, stPose.z],
        };
      }
      if (time < task.loadedEnd) {
        const u = THREE.MathUtils.clamp(
          (time - task.pickup) / Math.max(1, task.loadedEnd - task.pickup),
          0,
          1,
        );
        const pt = interpolateRoomWalk(
          planId,
          fromPt,
          toPt,
          u,
          SCENE_WORKER_OBSTACLE_IDS,
        );
        const ahead = interpolateRoomWalk(
          planId,
          fromPt,
          toPt,
          Math.min(1, u + 0.08),
          SCENE_WORKER_OBSTACLE_IDS,
        );
        return {
          x: pt[0],
          z: pt[1],
          priority: 1,
          walking: true,
          working: false,
          carrying: true,
          facingTarget:
            Math.hypot(ahead[0] - pt[0], ahead[1] - pt[1]) > 1e-3
              ? ahead
              : toPt,
        };
      }
      const stPose = floorPlanWorkspace.getPose(planId, task.station);
      return {
        x: toPt[0],
        z: toPt[1],
        priority: 2,
        walking: false,
        working: true,
        carrying: true,
        facingTarget: [stPose.x, stPose.z],
      };
    }

    const targetPt =
      task.kind === "process" && task.operation === "stage"
        ? getApplianceLocalHandoffPoint(planId, "stage", -0.38).point
        : task.kind === "process" && task.operation === "portion"
          ? getApplianceLocalHandoffPoint(planId, "portion", -0.34).point
          : getApplianceHandoffPoint(planId, task.station);
    const stPose = floorPlanWorkspace.getPose(planId, task.station);
    if (reduced || task.start === 0 || time >= task.arrival) {
      if (reduced || task.kind !== "process") {
        return {
          x: targetPt[0],
          z: targetPt[1],
          priority: 2,
          walking: false,
          working: !reduced,
          carrying: false,
          facingTarget: [stPose.x, stPose.z],
        };
      }
      const sub = plan61ASubstepAt(task, time);
      if (task.operation === "stage") {
        const scaleStand = getApplianceLocalHandoffPoint(
          planId,
          "stage",
          -0.38,
        );
        if (sub.id === "pull-cold-ingredients") {
          const coldStand = getColdStorageStandPoint(planId);
          if (sub.progress < 0.35) {
            const walkU = sub.progress / 0.35;
            const pt = interpolateRoomWalk(
              planId,
              scaleStand.point,
              coldStand.point,
              walkU,
              SCENE_WORKER_OBSTACLE_IDS,
            );
            return {
              x: pt[0],
              z: pt[1],
              priority: 2,
              walking: true,
              working: false,
              carrying: false,
              facingTarget: coldStand.point,
            };
          }
          if (sub.progress < 0.65) {
            return {
              x: coldStand.point[0],
              z: coldStand.point[1],
              priority: 2,
              walking: false,
              working: true,
              carrying: true,
              facingTarget: coldStand.facingTarget,
            };
          }
          const walkU = (sub.progress - 0.65) / 0.35;
          const pt = interpolateRoomWalk(
            planId,
            coldStand.point,
            scaleStand.point,
            walkU,
            SCENE_WORKER_OBSTACLE_IDS,
          );
          return {
            x: pt[0],
            z: pt[1],
            priority: 2,
            walking: true,
            working: false,
            carrying: true,
            facingTarget: scaleStand.point,
          };
        }
        const subStand =
          sub.id === "weigh-ingredients"
            ? scaleStand
            : sub.id === "cook-brown-butter"
              ? getApplianceLocalHandoffPoint(planId, "stage", -0.04)
              : getApplianceLocalHandoffPoint(planId, "stage", 0.34);
        return {
          x: subStand.point[0],
          z: subStand.point[1],
          priority: 2,
          walking: false,
          working: true,
          carrying: false,
          facingTarget: subStand.facingTarget,
        };
      }
      if (task.operation === "portion") {
        const subStand =
          sub.id === "butter-moulds"
            ? getApplianceLocalHandoffPoint(planId, "portion", -0.34)
            : getApplianceLocalHandoffPoint(planId, "portion", 0.04);
        return {
          x: subStand.point[0],
          z: subStand.point[1],
          priority: 2,
          walking: false,
          working: true,
          carrying: false,
          facingTarget: subStand.facingTarget,
        };
      }
      if (task.operation === "demould") {
        const coolPt = getApplianceHandoffPoint(planId, "cool");
        const sinkStand = getWashSinkStandPoint(planId);
        if (sub.id === "wash-moulds") {
          if (sub.progress < 0.28) {
            const walkU = sub.progress / 0.28;
            const pt = interpolateRoomWalk(
              planId,
              coolPt,
              sinkStand.point,
              walkU,
              SCENE_WORKER_OBSTACLE_IDS,
            );
            return {
              x: pt[0],
              z: pt[1],
              priority: 2,
              walking: true,
              working: false,
              carrying: true,
              facingTarget: sinkStand.point,
            };
          }
          return {
            x: sinkStand.point[0],
            z: sinkStand.point[1],
            priority: 2,
            walking: false,
            working: true,
            carrying: false,
            facingTarget: sinkStand.facingTarget,
          };
        }
        if (sub.id === "return-clean-moulds") {
          const pt = interpolateRoomWalk(
            planId,
            sinkStand.point,
            coolPt,
            sub.progress,
            SCENE_WORKER_OBSTACLE_IDS,
          );
          return {
            x: pt[0],
            z: pt[1],
            priority: 2,
            walking: true,
            working: false,
            carrying: true,
            facingTarget: coolPt,
          };
        }
      }
      if (task.operation === "pack" && sub.id === "refill-vitrine") {
        const packPt = getApplianceHandoffPoint(planId, "pack");
        const vitrineStand = getVitrineStandPoint(planId);
        if (sub.progress < 0.35) {
          const walkU = sub.progress / 0.35;
          const pt = interpolateRoomWalk(
            planId,
            packPt,
            vitrineStand.point,
            walkU,
            SCENE_WORKER_OBSTACLE_IDS,
          );
          return {
            x: pt[0],
            z: pt[1],
            priority: 2,
            walking: true,
            working: false,
            carrying: true,
            facingTarget: vitrineStand.point,
          };
        }
        return {
          x: vitrineStand.point[0],
          z: vitrineStand.point[1],
          priority: 2,
          walking: false,
          working: true,
          carrying: false,
          facingTarget: vitrineStand.facingTarget,
        };
      }
      return {
        x: targetPt[0],
        z: targetPt[1],
        priority: 2,
        walking: false,
        working: true,
        carrying: false,
        facingTarget: [stPose.x, stPose.z],
      };
    }

    const u = THREE.MathUtils.clamp(
      (time - task.start) / Math.max(1, task.arrival - task.start),
      0,
      1,
    );
    const pt = interpolateRoomWalk(
      planId,
      prevPt,
      targetPt,
      u,
      SCENE_WORKER_OBSTACLE_IDS,
    );
    const ahead = interpolateRoomWalk(
      planId,
      prevPt,
      targetPt,
      Math.min(1, u + 0.08),
      SCENE_WORKER_OBSTACLE_IDS,
    );
    return {
      x: pt[0],
      z: pt[1],
      priority: 1,
      walking: true,
      working: false,
      carrying: false,
      facingTarget:
        Math.hypot(ahead[0] - pt[0], ahead[1] - pt[1]) > 1e-3
          ? ahead
          : targetPt,
    };
  }

  if (lastStationId === null) {
    const stagePose = floorPlanWorkspace.getPose(planId, "stage");
    return {
      x: readyPt[0],
      z: readyPt[1],
      priority: 0,
      walking: false,
      working: false,
      carrying: false,
      facingTarget: [stagePose.x, stagePose.z],
    };
  }

  const lastPt = getApplianceHandoffPoint(planId, lastStationId);
  const lastPose = floorPlanWorkspace.getPose(planId, lastStationId);
  const peerNeedsStation = isStationOccupiedByPeerAt(
    run,
    lastStationId,
    resource.id,
    time,
  );
  if (peerNeedsStation || time - lastEnd > 4) {
    const idleElapsed = peerNeedsStation ? time - lastEnd : time - lastEnd - 4;
    const retreatU = reduced
      ? 1
      : THREE.MathUtils.clamp(idleElapsed / 2.2, 0, 1);
    const pt = interpolateRoomWalk(
      planId,
      lastPt,
      readyPt,
      retreatU,
      SCENE_WORKER_OBSTACLE_IDS,
    );
    return {
      x: pt[0],
      z: pt[1],
      priority: 0,
      walking: !reduced && retreatU > 0 && retreatU < 1,
      working: false,
      carrying: false,
      facingTarget: retreatU < 1 ? readyPt : [lastPose.x, lastPose.z],
    };
  }

  return {
    x: lastPt[0],
    z: lastPt[1],
    priority: 0,
    walking: false,
    working: false,
    carrying: false,
    facingTarget: [lastPose.x, lastPose.z],
  };
}

function updateHumanWorkerPoseInScene(
  worker: ArticulatedHumanWorker,
  state: WorkerRoomState,
  point: readonly [number, number],
  workerIndex: number,
  time: number,
  reduced: boolean,
): void {
  const wx = point[0];
  const wz = point[1];
  const dx = state.facingTarget[0] - wx;
  const dz = state.facingTarget[1] - wz;
  const facingYawRad = Math.hypot(dx, dz) > 1e-3 ? Math.atan2(dx, dz) : Math.PI;

  const phase = reduced ? 0 : time * 0.24 + workerIndex * 1.7;
  poseArticulatedHumanWorker(worker, {
    facingYawRad,
    walking: state.walking,
    working: state.working,
    carrying: state.carrying,
    phase,
  });
}

type BatchLabelGroup = {
  readonly label: CSS2DObject;
  readonly x: number;
  readonly z: number;
  readonly swatches: LabelSwatch[];
};
/** Batches sitting together share one label instead of stacking. */
function near(position: THREE.Vector3, group: BatchLabelGroup): boolean {
  return (
    Math.hypot(group.x - position.x, group.z - position.z) < batchGroupRadius
  );
}
function labelPriority(
  selected: boolean,
  hovered: boolean,
  attention: boolean,
  base: number,
): number {
  if (selected) return 0;
  if (hovered) return 1;
  return attention ? 2 : base;
}
/** "Baker 2" becomes "B2"; numbers stay whole so workers stay distinct. */
function initials(name: string): string {
  let result = "";
  for (const word of name.trim().split(/\s+/)) {
    if (/^\d+$/.test(word)) result += word;
    else result += word.charAt(0).toUpperCase();
  }
  return result.slice(0, 4) || name.slice(0, 2);
}
function sameSelection(a: Selection | null, b: Selection | null): boolean {
  return (
    a === b || (a !== null && b !== null && a.kind === b.kind && a.id === b.id)
  );
}
function stagingTraySlot(
  index: number,
  completed: boolean,
): readonly [number, number, number] {
  const planId = floorPlanWorkspace.getActivePlan();
  const targetId: StationId = completed ? "pack" : "stage";
  const pose = floorPlanWorkspace.getPose(planId, targetId);
  const offset = (index - 2.5) * 0.16;
  return [
    pose.x + offset * Math.cos(pose.rotY),
    0.26 + index * 0.025,
    pose.z - offset * Math.sin(pose.rotY),
  ];
}
function batchPosition(
  current: BatchSnapshot,
  index: number,
  time: number,
  reduced: boolean,
): readonly [number, number, number] {
  const planId = floorPlanWorkspace.getActivePlan();
  switch (current.kind) {
    case "process":
    case "handoff":
    case "native":
      return atStation(current.station, index);
    case "wait":
      return current.location === null
        ? stagingTraySlot(index, false)
        : atStation(current.location, index);
    case "transfer": {
      if (time < current.pickup) return atStation(current.from, index);
      if (time >= current.loadedEnd) return atStation(current.station, index);
      const fromPt = getApplianceHandoffPoint(planId, current.from);
      const toPt = getApplianceHandoffPoint(planId, current.station);
      const u = reduced
        ? 0
        : (time - current.pickup) /
          Math.max(1, current.loadedEnd - current.pickup);
      const point = interpolateRoomWalk(
        planId,
        fromPt,
        toPt,
        u,
        SCENE_WORKER_OBSTACLE_IDS,
      );
      return [point[0], 0.85, point[1]];
    }
    case "complete":
      return stagingTraySlot(index, true);
    case "unreleased":
    case "unfinished":
      return stagingTraySlot(index, false);
    default:
      return assertNever(current);
  }
}
function atStation(
  id: StationId,
  index: number,
): readonly [number, number, number] {
  const pose = floorPlanWorkspace.getPose(
    floorPlanWorkspace.getActivePlan(),
    id,
  );
  return [
    pose.x + 0.1 * Math.sin(pose.rotY),
    id === "cool"
      ? 0.45 + index * 0.15
      : id === "bake"
        ? 1.031 + (index % 5) * 0.088
        : 0.978,
    pose.z + 0.1 * Math.cos(pose.rotY),
  ];
}
function disposeObjects(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>(),
    textures = new Set<THREE.Texture>();
  for (const node of root.getObjectsByProperty("isObject3D", true)) {
    if (node instanceof THREE.SkinnedMesh) node.skeleton.dispose();
    if (!(node instanceof THREE.Mesh || node instanceof THREE.LineSegments))
      continue;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material)
      ? node.material
      : [node.material]) {
      materials.add(material);
      for (const value of Object.values(material))
        if (value instanceof THREE.Texture) textures.add(value);
    }
  }
  for (const item of [...geometries, ...materials, ...textures]) item.dispose();
}
