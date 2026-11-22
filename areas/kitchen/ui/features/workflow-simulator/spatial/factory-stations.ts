import { floorPlanWorkspace } from "../floor-plan-workspace";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { CarrierStoreView } from "@purin-labs/production-simulation";
import tableUrl from "../../production-run/models/prep-table-steel.glb?url";
import mapleUrl from "../../production-run/models/prep-table-maple.glb?url";
import rackUrl from "../../production-run/models/cooling-rack-16.glb?url";
import bs2SinkUrl from "../../../../../../assets/bakery-mujoco/maruzen-bs2-126n/maruzen-bs2-126n.glb?url";
import sugicoSprayUrl from "../../../../../../assets/bakery-mujoco/sugico-to-600n/sugico-to-600n.glb?url";
import hmhsSinkUrl from "../../../../../../assets/bakery-mujoco/maruzen-hmhs-054/maruzen-hmhs-054.glb?url";
import bps30ShelfUrl from "../../../../../../assets/bakery-mujoco/maruzen-bps30-12b/maruzen-bps30-12b.glb?url";
import ovenUrl from "../../../../../../assets/bakery-mujoco/maruzen-mbco-4me/maruzen-mbco-4me.glb?url";
import hobUrl from "../../../../../../assets/bakery-mujoco/maruzen-mih-02c/maruzen-mih-02c.glb?url";
import vollrathUrl from "../../../../../../assets/bakery-mujoco/vollrath-59500p/vollrath-59500p.glb?url";
import rinnaiUrl from "../../../../../../assets/bakery-mujoco/rinnai-rsb-150pj/rinnai-rsb-150pj.glb?url";
import ohausUrl from "../../../../../../assets/bakery-mujoco/ohaus-ranger-3000/ohaus-r31pe6.glb?url";
import kpl9000sUrl from "../../../../../../assets/bakery-mujoco/aicohsha-kpl9000s/aicohsha-kpl9000s.glb?url";
import waringUrl from "../../../../../../assets/bakery-mujoco/waring-wsg60/waring-wsg60.glb?url";
import vitamixUrl from "../../../../../../assets/bakery-mujoco/vitamix-quiet-one/vitamix-quiet-one.glb?url";
import hitachiUrl from "../../../../../../assets/bakery-mujoco/hitachi-r-hws47xl/hitachi-r-hws47xl.glb?url";
import hoshizakiRtUrl from "../../../../../../assets/bakery-mujoco/hoshizaki-rt-120snj/hoshizaki-rt-120snj.glb?url";
import winterhalterUrl from "../../../../../../assets/bakery-mujoco/winterhalter-uc-l/winterhalter-uc-l.glb?url";
import severinUrl from "../../../../../../assets/bakery-mujoco/severin-sm-3587/severin-sm-3587.glb?url";
import wpmEspressoUrl from "../../../../../../assets/bakery-mujoco/wpm-kd-330x/wpm-kd-330x.glb?url";
import wpmGrinderUrl from "../../../../../../assets/bakery-mujoco/wpm-zd-17od/wpm-zd-17od.glb?url";
import lagomCasaUrl from "../../../../../../assets/bakery-mujoco/option-o-lagom-casa/option-o-lagom-casa.glb?url";
import im25pUrl from "../../../../../../assets/bakery-mujoco/hoshizaki-im-25p/hoshizaki-im-25p.glb?url";
import squareRegisterUrl from "../../../../../../assets/bakery-mujoco/square-register-2g/square-register-2g.glb?url";
import starPrinterUrl from "../../../../../../assets/bakery-mujoco/star-mcp31lb/star-mcp31lb.glb?url";
import starDrawerUrl from "../../../../../../assets/bakery-mujoco/star-mjd36m/star-mjd36m.glb?url";
import pastryBenchUrl from "../../../../../../assets/bakery-mujoco/pastry-bench/pastry-bench.glb?url";
import type { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { assertNever } from "@purin-labs/std";
import {
  computeFacilityUtilityTelemetry,
  type SynchronizedApplianceState,
} from "../../production-run/morning-shift-appliances";
import { type BakeryFloorPlanId } from "@purin-labs/production-simulation/floor/bakery-room";
import {
  getOutfittedFactoryStations,
  interpolateRoomWalk,
  resolveMultiWorkerPositions,
} from "../bakery-appliance-layout";
import {
  APPLIANCE_FOOTPRINTS,
  STORE_DECOR_IDS,
  isApplianceId,
} from "@purin-labs/production-simulation/floor/appliance-catalogue";
import { createPosedHumanWorkerGroup } from "./human-worker-figure";
import { buildContactShadowPad } from "./floor-plan-fixtures";
import { ensureLivingAssetsLoaded } from "./living-asset-loader";
import { disposePhysicsObject } from "./physics-model";
import {
  buildPieCarrierGroup,
  createCanonicalCrimpedPastryFlexMesh,
  createDeformablePastryBufferState,
  isPieCarrierOrStore,
  updateDeformablePastryBufferGeometry,
} from "../../production-run/pastry-bench/pastry-shell-visual";

type FactoryStationModel =
  | "prep-table"
  | "cooling-table"
  | "oven"
  | "hob"
  | "cooling-rack"
  | "wash-sink"
  | "packing-table"
  | "scale-station"
  | "mixer-station"
  | "sesame-prep-station"
  | "dual-hob-station"
  | "chiller-rack-station"
  | "dishwasher-sink-station"
  | "beverage-frother-station";

/** A station of a factory without robot cells: equipment and its stores. */
export type FactoryStationSource = Readonly<{
  id: string;
  label: string;
  model: FactoryStationModel;
  x: number;
  z: number;
  rotY?: number;
  /** Carrier stores drawn on this station, in placement order. */
  stores: readonly string[];
  /** The store whose occupancy the station label shows. */
  primary: string;
  /** Equipment resources whose queues belong to this station. */
  resources: readonly string[];
  /** Worker locations that stand at this station. */
  locations: readonly string[];
}>;

export type FactoryWorker = Readonly<{
  id: string;
  location: string | null;
  destination?: string | null;
  progress?: number;
  carrying?: boolean;
  taskId?: string | null;
}>;

// The countertop equipment stands on a commercial steel table of this height (850 mm JIS standard).
const COUNTER = 0.85;
const TABLE_SCALE = [0.787, 0.942, 0.853] as const;
const OVEN_STAND_SCALE = [0.72, 0.942, 1.12] as const;
const BAR_TABLE_SCALE = [0.886, 0.942, 0.853] as const;

type PartTag =
  | "ohaus-pan"
  | "kpl-planetary"
  | "kpl-whip"
  | "kpl-guard"
  | "waring-cover"
  | "waring-blade"
  | "vitamix-door"
  | "vitamix-blade"
  | "mbco4-door"
  | "mbco4-fan"
  | "winterhalter-door"
  | "winterhalter-rack"
  | "lagom-burr"
  | "severin-stirrer"
  | "pb-roller"
  | "pb-crimper";

const INTERNAL_NODE_TAGS: readonly Readonly<{
  nodeName: string;
  tag: PartTag;
}>[] = [
  { nodeName: "ranger_weighing_pan", tag: "ohaus-pan" },
  { nodeName: "kpl_planetary", tag: "kpl-planetary" },
  { nodeName: "kpl_whip", tag: "kpl-whip" },
  { nodeName: "kpl_finger_guard", tag: "kpl-guard" },
  { nodeName: "wsg_cover", tag: "waring-cover" },
  { nodeName: "wsg_blade", tag: "waring-blade" },
  { nodeName: "tqo_enclosure_door", tag: "vitamix-door" },
  { nodeName: "tqo_blade", tag: "vitamix-blade" },
  { nodeName: "mbco4_door", tag: "mbco4-door" },
  { nodeName: "mbco4_fan", tag: "mbco4-fan" },
  { nodeName: "ucl_door", tag: "winterhalter-door" },
  { nodeName: "ucl_wash_rack", tag: "winterhalter-rack" },
  { nodeName: "casa_burr_cone", tag: "lagom-burr" },
  { nodeName: "sm3587_stirrer", tag: "severin-stirrer" },
  { nodeName: "pb_roller", tag: "pb-roller" },
  { nodeName: "pb_crimper", tag: "pb-crimper" },
];

type PartPlacement = Readonly<{
  url: string;
  dx?: number;
  y?: number;
  dz?: number;
  scaleZ?: number;
  scale?: readonly [number, number, number];
}>;

function parts(model: FactoryStationModel): readonly PartPlacement[] {
  switch (model) {
    case "prep-table":
      return [{ url: tableUrl, scale: TABLE_SCALE }];
    case "packing-table":
      return [
        { url: tableUrl, scale: TABLE_SCALE },
        { url: starDrawerUrl, dx: 0.36, y: COUNTER, dz: 0.04 },
        { url: squareRegisterUrl, dx: 0.36, y: COUNTER + 0.104, dz: 0.03 },
        { url: starPrinterUrl, dx: 0.52, y: COUNTER, dz: -0.14 },
      ];
    case "cooling-table":
      return [{ url: mapleUrl, scale: TABLE_SCALE }];
    case "oven":
      return [
        { url: tableUrl, scale: OVEN_STAND_SCALE },
        { url: ovenUrl, y: COUNTER },
      ];
    case "hob":
      return [
        { url: tableUrl, scale: TABLE_SCALE },
        { url: hobUrl, y: COUNTER, dz: 0.06, scale: [0.82, 0.82, 0.82] },
      ];
    case "cooling-rack":
      return [{ url: rackUrl }];
    case "wash-sink":
      return [
        { url: bs2SinkUrl, dx: -0.14 },
        { url: sugicoSprayUrl, dx: -0.14, y: 0.8, dz: -0.22 },
        { url: bps30ShelfUrl, dx: -0.14, y: 1.42, dz: -0.15 },
        { url: hmhsSinkUrl, dx: 0.72, y: 0.45, dz: -0.06 },
      ];
    case "scale-station":
      return [
        { url: tableUrl, scale: TABLE_SCALE },
        { url: ohausUrl, dx: -0.32, y: COUNTER, dz: 0.06 },
        {
          url: pastryBenchUrl,
          dx: 0.24,
          y: COUNTER,
          dz: 0.02,
          scale: [0.82, 0.82, 0.82],
        },
      ];
    case "mixer-station":
      return [
        { url: tableUrl, scale: TABLE_SCALE },
        { url: kpl9000sUrl, y: COUNTER, dz: 0.02 },
      ];
    case "sesame-prep-station":
      return [
        { url: hoshizakiRtUrl },
        { url: waringUrl, dx: -0.28, y: 0.8, dz: 0.04 },
        { url: vitamixUrl, dx: 0.28, y: 0.8, dz: 0.04 },
      ];
    case "dual-hob-station":
      return [
        { url: tableUrl, scale: TABLE_SCALE },
        {
          url: hobUrl,
          dx: -0.36,
          y: COUNTER,
          dz: 0.06,
          scale: [0.82, 0.82, 0.82],
        },
        { url: vollrathUrl, dx: 0.02, y: COUNTER, dz: 0.02 },
        { url: rinnaiUrl, dx: 0.38, y: COUNTER, dz: 0.04 },
      ];
    case "chiller-rack-station":
      return [
        { url: hitachiUrl, dx: -0.38 },
        { url: rackUrl, dx: 0.38 },
      ];
    case "dishwasher-sink-station":
      return [
        { url: winterhalterUrl, dx: -0.62 },
        { url: bs2SinkUrl, dx: 0.26 },
        { url: sugicoSprayUrl, dx: 0.26, y: 0.8, dz: -0.22 },
        { url: bps30ShelfUrl, dx: 0.26, y: 1.42, dz: -0.15 },
        { url: hmhsSinkUrl, dx: 1.12, y: 0.45, dz: -0.06 },
      ];
    case "beverage-frother-station":
      return [
        { url: mapleUrl, scale: BAR_TABLE_SCALE },
        { url: wpmEspressoUrl, dx: -0.34, y: COUNTER, dz: 0.02 },
        { url: wpmGrinderUrl, dx: -0.04, y: COUNTER, dz: 0.04 },
        { url: lagomCasaUrl, dx: 0.18, y: COUNTER, dz: 0.04 },
        { url: severinUrl, dx: 0.42, y: COUNTER, dz: 0.06 },
        { url: im25pUrl, dx: 0.94, dz: 0.02 },
      ];
    default:
      return assertNever(model);
  }
}

/**
 * Equipment models and the accepted store contents. The models come from the
 * existing bakery asset set; the contents follow the engine's store view.
 */
export class FactoryStations {
  readonly root = new THREE.Group();
  private readonly contents = new THREE.Group();
  private readonly workers = new THREE.Group();
  private readonly applianceStates = new THREE.Group();
  private readonly taggedParts = new Map<
    PartTag,
    Readonly<{
      object: THREE.Object3D;
      basePos: THREE.Vector3;
      baseQuat: THREE.Quaternion;
    }>
  >();
  private stations: readonly FactoryStationSource[];
  private key = "";

  constructor(private readonly baseStations: readonly FactoryStationSource[]) {
    this.stations = getOutfittedFactoryStations(
      floorPlanWorkspace.getActivePlan(),
      baseStations,
    );
    this.contents.name = "station-contents";
    this.workers.name = "station-workers";
    this.applianceStates.name = "station-appliance-states";
    this.root.add(this.contents, this.workers, this.applianceStates);
  }

  currentStations(): readonly FactoryStationSource[] {
    return this.stations;
  }

  syncPlacements(planId: BakeryFloorPlanId): void {
    this.stations = getOutfittedFactoryStations(planId, this.baseStations);
    for (const station of this.stations) {
      const group = this.station(station.id);
      if (group !== null) {
        group.position.set(station.x, 0, station.z);
        group.rotation.y = station.rotY ?? 0;
        group.updateMatrixWorld(true);
      }
    }
    this.key = "";
  }

  async load(signal: AbortSignal): Promise<void> {
    const loaders = await import("three/addons/loaders/GLTFLoader.js");
    const loader = new loaders.GLTFLoader();
    const [loaded] = await Promise.all([
      Promise.all(this.stations.map(this.loadStation.bind(this, loader))),
      ensureLivingAssetsLoaded(signal),
    ]);
    if (signal.aborted) {
      for (const group of loaded) group.traverse(disposePhysicsObject);
      return;
    }
    for (const group of loaded) this.root.add(group);
    this.syncPlacements(floorPlanWorkspace.getActivePlan());
  }

  private async loadStation(
    loader: GLTFLoader,
    station: FactoryStationSource,
  ): Promise<THREE.Group> {
    const group = new THREE.Group();
    group.name = station.id;
    group.position.set(station.x, 0, station.z);
    group.rotation.y = station.rotY ?? 0;
    const placements = parts(station.model);
    for (const part of placements) {
      const model = await loader.loadAsync(part.url);
      const basePos = new THREE.Vector3(
        part.dx ?? 0,
        part.y ?? 0,
        part.dz ?? 0,
      );
      model.scene.position.copy(basePos);
      if (part.scale !== undefined) {
        model.scene.scale.set(part.scale[0], part.scale[1], part.scale[2]);
      } else if (part.scaleZ !== undefined) {
        model.scene.scale.z = part.scaleZ;
      }
      for (const spec of INTERNAL_NODE_TAGS) {
        const internalNode = model.scene.getObjectByName(spec.nodeName);
        if (internalNode !== undefined) {
          this.taggedParts.set(spec.tag, {
            object: internalNode,
            basePos: internalNode.position.clone(),
            baseQuat: internalNode.quaternion.clone(),
          });
        }
      }
      for (const node of model.scene.getObjectsByProperty("isObject3D", true)) {
        if (node instanceof THREE.Mesh) {
          node.castShadow = true;
          node.receiveShadow = true;
        }
      }
      group.add(model.scene);
    }
    const fp = isApplianceId(station.id)
      ? APPLIANCE_FOOTPRINTS[station.id]
      : undefined;
    const padW = fp !== undefined ? fp.halfWidth * 2.08 : 1.05;
    const padD = fp !== undefined ? fp.halfDepth * 2.08 : 0.72;
    group.add(buildContactShadowPad(padW, padD, 0.26));
    return group;
  }

  /** The loaded equipment of one station, for selection. */
  station(id: string): THREE.Object3D | null {
    for (const child of this.root.children)
      if (
        child.name === id &&
        child !== this.contents &&
        child !== this.workers &&
        child !== this.applianceStates
      )
        return child;
    return null;
  }

  /** Where a station's label sits above its equipment. */
  anchor(station: FactoryStationSource): THREE.Vector3 {
    const current = this.stations.find((s) => s.id === station.id) ?? station;
    const isTall =
      current.model === "cooling-rack" ||
      current.model === "chiller-rack-station" ||
      current.model === "oven";
    return new THREE.Vector3(current.x, isTall ? 2.0 : 1.7, current.z);
  }

  update(
    stores: readonly CarrierStoreView[] | null,
    workers: readonly FactoryWorker[],
    appliances: readonly SynchronizedApplianceState[] | null = null,
  ): void {
    const key = JSON.stringify([stores, workers, appliances]);
    if (key === this.key) return;
    this.key = key;
    for (const group of [this.contents, this.workers, this.applianceStates]) {
      group.traverse(disposePhysicsObject);
      group.clear();
    }
    const byAppliance = new Map<string, SynchronizedApplianceState>();
    for (const state of appliances ?? []) {
      byAppliance.set(state.appliance, state);
    }
    const byId = new Map<string, CarrierStoreView>();
    for (const store of stores ?? []) byId.set(store.id, store);
    for (const station of this.stations) {
      let slot = 0;
      for (const id of station.stores) {
        const store = byId.get(id);
        if (store === undefined) continue;
        for (const carrier of store.occupants) {
          const item = carrierItem(carrier, id, byAppliance);
          placeItem(item, station, id, slot);
          this.contents.add(item);
          slot += 1;
        }
      }
    }
    const activePlan = floorPlanWorkspace.getActivePlan();
    const obstacleIds = [
      ...this.stations.map((s) => s.id).filter(isApplianceId),
      ...STORE_DECOR_IDS,
    ];
    if (this.stations.some((s) => s.id === "station-beverage-bar")) {
      obstacleIds.push("pour-over-cell", "espresso-cell");
    }

    type PendingFactoryWorker = Readonly<{
      index: number;
      worker: FactoryWorker;
      fromStation: FactoryStationSource;
      toStation: FactoryStationSource | undefined;
      isWalking: boolean;
      progress: number;
      rawX: number;
      rawZ: number;
      facingTarget: readonly [number, number];
      priority: number;
    }>;

    const pendingWorkers: PendingFactoryWorker[] = [];
    for (const [index, worker] of workers.entries()) {
      const fromStation = this.stations.find(
        standsAt.bind(null, worker.location),
      );
      if (fromStation === undefined) continue;
      const toStation =
        worker.destination !== undefined && worker.destination !== null
          ? this.stations.find(standsAt.bind(null, worker.destination))
          : undefined;
      // Only offset along the counter when multiple workers share the same station
      const peersAtSameStation = workers.filter(
        (w) => w.location === worker.location,
      );
      const peerRank = peersAtSameStation.findIndex((w) => w.id === worker.id);
      const laneOffset =
        peersAtSameStation.length > 1
          ? (peerRank - (peersAtSameStation.length - 1) / 2) * 0.64
          : 0;
      const [fromX, fromZ] = stationWorkerStandPoint(
        activePlan,
        fromStation,
        laneOffset,
      );
      const isWalking =
        toStation !== undefined && toStation.id !== fromStation.id;
      const progress = worker.progress ?? 0;

      if (isWalking && toStation !== undefined) {
        const [toX, toZ] = stationWorkerStandPoint(activePlan, toStation, 0);
        const t = Math.max(0, Math.min(1, progress));
        const pt = interpolateRoomWalk(
          activePlan,
          [fromX, fromZ],
          [toX, toZ],
          t,
          obstacleIds,
        );
        const ahead = interpolateRoomWalk(
          activePlan,
          [fromX, fromZ],
          [toX, toZ],
          Math.min(1, t + 0.08),
          obstacleIds,
        );
        pendingWorkers.push({
          index,
          worker,
          fromStation,
          toStation,
          isWalking: true,
          progress,
          rawX: pt[0],
          rawZ: pt[1],
          facingTarget:
            Math.hypot(ahead[0] - pt[0], ahead[1] - pt[1]) > 1e-3
              ? ahead
              : [toX, toZ],
          priority: 1,
        });
      } else {
        pendingWorkers.push({
          index,
          worker,
          fromStation,
          toStation,
          isWalking: false,
          progress,
          rawX: fromX,
          rawZ: fromZ,
          facingTarget: [fromStation.x, fromStation.z],
          priority: worker.taskId ? 2 : 0,
        });
      }
    }

    const resolvedPositions = resolveMultiWorkerPositions(
      activePlan,
      pendingWorkers.map((pw) => ({
        x: pw.rawX,
        z: pw.rawZ,
        priority: pw.priority,
      })),
      obstacleIds,
      0.62,
      0.28,
    );

    for (const [k, pw] of pendingWorkers.entries()) {
      const pos = resolvedPositions[k] ?? [pw.rawX, pw.rawZ];
      const yaw = Math.atan2(
        pw.facingTarget[0] - pos[0],
        pw.facingTarget[1] - pos[1],
      );
      const marker = workerMarker(pw.index, {
        facingYawRad: pw.isWalking ? 0 : yaw,
        walking: pw.isWalking,
        working: !pw.isWalking && Boolean(pw.worker.taskId),
        carrying: Boolean(pw.worker.carrying),
        progress: pw.progress,
      });
      marker.userData = {
        ...marker.userData,
        workerId: pw.worker.id,
        location: pw.worker.location,
        destination: pw.worker.destination ?? null,
        taskId: pw.worker.taskId ?? null,
        walking: pw.isWalking,
      };
      marker.position.set(pos[0], 0, pos[1]);
      if (pw.isWalking) {
        marker.rotation.y = yaw;
      }
      this.workers.add(marker);
    }
    this.articulateSubparts(appliances);
    for (const state of appliances ?? []) {
      const station = this.stations.find((s) => s.id === state.stationId);
      if (station === undefined) continue;
      const indicator = applianceStateVisual(station, state);
      this.applianceStates.add(indicator);
    }
    if (appliances !== null && appliances.length > 0) {
      this.applianceStates.add(
        canopyExhaustHoodVisual(appliances, this.stations),
      );
    }
  }

  private articulateSubparts(
    appliances: readonly SynchronizedApplianceState[] | null,
  ): void {
    const byAppliance = new Map<string, SynchronizedApplianceState>();
    for (const state of appliances ?? [])
      byAppliance.set(state.appliance, state);

    for (const entry of this.taggedParts.values()) {
      entry.object.position.copy(entry.basePos);
      entry.object.quaternion.copy(entry.baseQuat);
    }

    const ohaus = byAppliance.get("ohaus-ranger-3000");
    const ohausPan = this.taggedParts.get("ohaus-pan");
    if (ohausPan !== undefined && ohaus !== undefined && ohaus.massG > 0) {
      const deflection = Math.min(0.004, (ohaus.massG / 1000) * 0.0025);
      ohausPan.object.position.y = ohausPan.basePos.y - deflection;
    }

    const hobart = byAppliance.get("hobart-hl200");
    const kplPlanetary = this.taggedParts.get("kpl-planetary");
    const kplWhip = this.taggedParts.get("kpl-whip");
    const kplGuard = this.taggedParts.get("kpl-guard");
    if (hobart !== undefined) {
      if (hobart.rpm > 0) {
        if (kplPlanetary !== undefined) {
          kplPlanetary.object.rotation.y = hobart.progress * Math.PI * 12;
        }
        if (kplWhip !== undefined) {
          kplWhip.object.rotation.y = -hobart.progress * Math.PI * 42;
        }
      }
      if (kplGuard !== undefined && hobart.doorOpenRatio > 0) {
        kplGuard.object.rotation.x = hobart.doorOpenRatio * 0.35;
      }
    }

    const waring = byAppliance.get("waring-wsg60");
    if (waring !== undefined) {
      const waringCover = this.taggedParts.get("waring-cover");
      if (waringCover !== undefined && waring.doorOpenRatio > 0) {
        waringCover.object.position.y =
          waringCover.basePos.y + waring.doorOpenRatio * 0.1;
        waringCover.object.rotation.y = waring.doorOpenRatio * 0.31;
      }
      const waringBlade = this.taggedParts.get("waring-blade");
      if (waringBlade !== undefined && waring.rpm > 0) {
        waringBlade.object.rotation.y = waring.progress * Math.PI * 48;
      }
    }

    const vitamix = byAppliance.get("vitamix-quiet-one");
    if (vitamix !== undefined) {
      const vitamixDoor = this.taggedParts.get("vitamix-door");
      if (vitamixDoor !== undefined && vitamix.doorOpenRatio > 0) {
        vitamixDoor.object.rotation.x = -vitamix.doorOpenRatio * 1.45;
      }
      const vitamixBlade = this.taggedParts.get("vitamix-blade");
      if (vitamixBlade !== undefined && vitamix.rpm > 0) {
        vitamixBlade.object.rotation.y = vitamix.progress * Math.PI * 56;
      }
    }

    const oven = byAppliance.get("maruzen-mbco-5e");
    if (oven !== undefined) {
      const ovenDoor = this.taggedParts.get("mbco4-door");
      if (ovenDoor !== undefined && oven.doorOpenRatio > 0) {
        ovenDoor.object.rotation.y = -oven.doorOpenRatio * 1.45;
      }
      const ovenFan = this.taggedParts.get("mbco4-fan");
      if (ovenFan !== undefined && oven.status === "active") {
        ovenFan.object.rotation.z = oven.progress * Math.PI * 36;
      }
    }

    const winterhalter = byAppliance.get("winterhalter-uc-l");
    if (winterhalter !== undefined && winterhalter.doorOpenRatio > 0) {
      const uclDoor = this.taggedParts.get("winterhalter-door");
      if (uclDoor !== undefined) {
        uclDoor.object.rotation.x = winterhalter.doorOpenRatio * 1.52;
      }
      const uclRack = this.taggedParts.get("winterhalter-rack");
      if (uclRack !== undefined) {
        uclRack.object.position.z =
          uclRack.basePos.z + winterhalter.doorOpenRatio * 0.42;
      }
    }

    const linea = byAppliance.get("la-marzocco-linea-classic-s-2g");
    const lagomBurr = this.taggedParts.get("lagom-burr");
    if (lagomBurr !== undefined && linea?.status === "active") {
      lagomBurr.object.rotation.y = linea.progress * Math.PI * 24;
    }

    const severin = byAppliance.get("severin-sm-3587");
    const severinStirrer = this.taggedParts.get("severin-stirrer");
    if (severinStirrer !== undefined && severin !== undefined && severin.rpm > 0) {
      severinStirrer.object.rotation.y = severin.progress * Math.PI * 36;
    }

    const pastryBench = byAppliance.get("pastry-bench");
    if (pastryBench !== undefined && pastryBench.status === "active") {
      const pbRoller = this.taggedParts.get("pb-roller");
      const pbCrimper = this.taggedParts.get("pb-crimper");
      const isLid = Boolean(pastryBench.activeTaskId?.includes("lid-pies"));
      if (!isLid && pbRoller !== undefined) {
        pbRoller.object.position.x =
          pbRoller.basePos.x + Math.sin(pastryBench.progress * Math.PI * 2) * 0.085;
        pbRoller.object.position.y = pbRoller.basePos.y - 0.036;
      }
      if (isLid && pbCrimper !== undefined) {
        pbCrimper.object.position.y =
          pbCrimper.basePos.y - Math.sin(pastryBench.progress * Math.PI) * 0.052;
      }
    }
  }

  dispose(): void {
    this.root.traverse(disposePhysicsObject);
    this.root.clear();
  }
}

function standsAt(
  location: string | null,
  station: FactoryStationSource,
): boolean {
  return location !== null && station.locations.includes(location);
}

function material(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
}

function emissiveMaterial(
  color: number,
  emissive: number,
  emissiveIntensity: number,
  opacity = 1,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity,
    roughness: 0.35,
    transparent: opacity < 1,
    opacity,
    side: THREE.DoubleSide,
  });
}

function applianceWorldAnchor(
  station: FactoryStationSource,
  appliance: SynchronizedApplianceState["appliance"],
): THREE.Vector3 {
  switch (appliance) {
    case "ohaus-ranger-3000":
      return new THREE.Vector3(station.x - 0.32, COUNTER + 0.12, station.z + 0.04);
    case "hobart-hl200":
      return new THREE.Vector3(station.x, COUNTER + 0.24, station.z + 0.1);
    case "waring-wsg60":
      return new THREE.Vector3(station.x - 0.28, 0.8 + 0.2, station.z + 0.04);
    case "vitamix-quiet-one":
      return new THREE.Vector3(station.x + 0.28, 0.8 + 0.28, station.z + 0.04);
    case "maruzen-mih-02c":
      return new THREE.Vector3(
        station.model === "hob" ? station.x : station.x - 0.36,
        COUNTER + 0.1,
        station.z + 0.06,
      );
    case "vollrath-59500p":
      return new THREE.Vector3(station.x + 0.02, COUNTER + 0.08, station.z + 0.02);
    case "maruzen-mbco-5e":
      return new THREE.Vector3(station.x, COUNTER + 0.35, station.z + 0.28);
    case "hoshizaki-rt-120snj":
      return new THREE.Vector3(station.x - 0.44, 0.8, station.z + 0.25);
    case "winterhalter-uc-l":
      return new THREE.Vector3(station.x - 0.62, 0.82, station.z + 0.25);
    case "severin-sm-3587":
      return new THREE.Vector3(
        station.x + 0.42,
        COUNTER + 0.16,
        station.z + 0.06,
      );
    case "la-marzocco-linea-classic-s-2g":
      return new THREE.Vector3(
        station.x - 0.34,
        COUNTER + 0.18,
        station.z + 0.08,
      );
    case "pastry-bench":
      return new THREE.Vector3(
        station.x + 0.24,
        COUNTER + 0.08,
        station.z + 0.02,
      );
    default:
      return assertNever(appliance);
  }
}

function buildThermalPlume(
  intensity: number,
  progress: number,
  colorHex = 0xe2e8f0,
): THREE.Group {
  const plume = new THREE.Group();
  plume.name = "thermal-plume";
  const wispCount = 3;
  for (let i = 0; i < wispCount; i++) {
    const phase = (progress * 3 + i / wispCount) % 1;
    const radius = 0.032 + phase * 0.048 * intensity;
    const wisp = new THREE.Mesh(
      new THREE.TorusGeometry(radius, 0.009, 10, 20),
      emissiveMaterial(
        colorHex,
        0xffffff,
        0.35 * intensity,
        Math.max(0.08, (1 - phase) * 0.48 * intensity),
      ),
    );
    wisp.rotation.x = Math.PI / 2;
    wisp.position.set(
      Math.sin((phase + i) * Math.PI * 2) * 0.018,
      0.08 + phase * 0.26,
      Math.cos((phase + i) * Math.PI * 2) * 0.018,
    );
    plume.add(wisp);
  }
  return plume;
}

function canopyExhaustHoodVisual(
  appliances: readonly SynchronizedApplianceState[],
  stations: readonly FactoryStationSource[],
): THREE.Group {
  const utilities = computeFacilityUtilityTelemetry(appliances);
  const hvac = utilities.hvacPsychrometrics;
  const hood = new THREE.Group();
  hood.name = "canopy-exhaust-hood";
  const hob = stations.find((s) => s.id === "station-hob");
  const oven = stations.find((s) => s.id === "station-oven");
  const hoodX = ((hob?.x ?? 1.0) + (oven?.x ?? 3.0)) / 2;
  const hoodZ = ((hob?.z ?? -2.2) + (oven?.z ?? -2.2)) / 2;
  hood.position.set(hoodX, 2.52, hoodZ);
  hood.userData = {
    roomDryBulbC: hvac.roomDryBulbC,
    relativeHumidityPercent: hvac.relativeHumidityPercent,
    dewPointC: hvac.dewPointC,
    canopyHoodExhaustCfm: hvac.canopyHoodExhaustCfm,
    status: hvac.status,
  };

  const canopyShell = new THREE.Mesh(
    new THREE.BoxGeometry(3.5, 0.22, 1.12),
    emissiveMaterial(0x94a3b8, 0x334155, 0.15, 0.72),
  );
  hood.add(canopyShell);

  const baffleBank = new THREE.Mesh(
    new THREE.BoxGeometry(3.2, 0.06, 0.42),
    emissiveMaterial(0x64748b, 0x1e293b, 0.2, 0.85),
  );
  baffleBank.position.set(0, -0.09, -0.22);
  baffleBank.rotation.x = 0.42;
  hood.add(baffleBank);

  const cfmRatio = Math.max(
    0.25,
    Math.min(1, (hvac.canopyHoodExhaustCfm - 400) / 1000),
  );
  const statusColor =
    hvac.status === "humid-plume"
      ? 0x38bdf8
      : hvac.status === "high-sensible-load"
        ? 0xf59e0b
        : 0x10b981;
  const trimStrip = new THREE.Mesh(
    new THREE.BoxGeometry(3.48, 0.025, 0.025),
    emissiveMaterial(statusColor, statusColor, 0.8, 0.92),
  );
  trimStrip.position.set(0, -0.1, 0.55);
  hood.add(trimStrip);

  for (const [idx, dx] of ([-0.95, 0.95] as const).entries()) {
    const riser = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.18, 0.44, 20),
      emissiveMaterial(0x64748b, 0x334155, 0.15, 0.78),
    );
    riser.position.set(dx, 0.32, -0.12);
    hood.add(riser);

    const impeller = new THREE.Group();
    impeller.position.set(dx, -0.08, -0.05);
    for (let b = 0; b < 4; b++) {
      const blade = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.012, 0.045),
        emissiveMaterial(0xe2e8f0, statusColor, 0.45, 0.9),
      );
      blade.rotation.y = (b * Math.PI) / 2;
      impeller.add(blade);
    }
    impeller.rotation.y =
      (hvac.canopyHoodExhaustCfm * 0.04 + idx * 1.1) % (Math.PI * 2);
    hood.add(impeller);

    // Upward convective capture draft ring into the canopy hood
    const draftRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.18 + cfmRatio * 0.08, 0.008, 10, 24),
      emissiveMaterial(statusColor, statusColor, 0.45, 0.32 * cfmRatio),
    );
    draftRing.rotation.x = Math.PI / 2;
    draftRing.position.set(dx, -0.32, 0.05);
    hood.add(draftRing);
  }

  return hood;
}

function buildDoorOrInterlockOverlay(
  state: SynchronizedApplianceState,
): THREE.Group | null {
  if (state.doorOpenRatio <= 0.02) return null;
  const overlay = new THREE.Group();
  overlay.name = `door-interlock:${state.appliance}`;
  const r = state.doorOpenRatio;
  switch (state.appliance) {
    case "hobart-hl200": {
      // Swung-open planetary safety wire cage arc
      const guard = new THREE.Mesh(
        new THREE.CylinderGeometry(
          0.145,
          0.145,
          0.14,
          18,
          1,
          true,
          0,
          Math.PI * 1.15,
        ),
        emissiveMaterial(0xf59e0b, 0xd9483b, 0.75, 0.65),
      );
      guard.position.set(0.08 * r, 0.09, 0.05 * r);
      guard.rotation.y = -r * 1.25;
      overlay.add(guard);
      return overlay;
    }
    case "vitamix-quiet-one": {
      // Tilted polycarbonate sound enclosure hood
      const hood = new THREE.Mesh(
        new THREE.BoxGeometry(0.19, 0.24, 0.19),
        emissiveMaterial(0x94a3b8, 0xd9483b, 0.55, 0.42),
      );
      hood.position.set(0, 0.14 + r * 0.06, -0.04 * r);
      hood.rotation.x = -r * 0.68;
      overlay.add(hood);
      return overlay;
    }
    case "maruzen-mbco-5e": {
      // Hinged convection oven door swung open on left hinge
      const pivot = new THREE.Group();
      pivot.position.set(-0.21, 0.04, 0.12);
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, 0.28, 0.026),
        emissiveMaterial(0x64748b, 0xf97316, 0.45, 0.78),
      );
      panel.position.set(0.21, 0, 0);
      pivot.add(panel);
      pivot.rotation.y = -r * 1.22;
      overlay.add(pivot);
      return overlay;
    }
    case "winterhalter-uc-l": {
      // Drop-down undercounter dishwasher door hinged at bottom
      const pivot = new THREE.Group();
      pivot.position.set(0, -0.14, 0.14);
      const door = new THREE.Mesh(
        new THREE.BoxGeometry(0.46, 0.34, 0.024),
        emissiveMaterial(0x64748b, 0x38bdf8, 0.45, 0.8),
      );
      door.position.set(0, 0.17, 0);
      pivot.add(door);
      pivot.rotation.x = r * 1.35;
      overlay.add(pivot);
      return overlay;
    }
    default:
      return null;
  }
}

function applianceHaloColor(state: SynchronizedApplianceState): number {
  if (state.status === "fault") return 0xd9483b;
  if (state.status === "completed") return 0x22c55e;
  if (state.status === "idle") return 0x64748b;
  switch (state.category) {
    case "hob":
    case "oven":
    case "milk-frother":
    case "espresso":
      return 0xf59e0b;
    case "chiller":
    case "dishwasher":
      return 0x38bdf8;
    case "weigh":
    case "mixer":
    case "grinder":
    case "blender":
    case "pastry-bench":
      return 0x10b981;
    default:
      return assertNever(state.category);
  }
}

function applianceStateVisual(
  station: FactoryStationSource,
  state: SynchronizedApplianceState,
): THREE.Group {
  const group = new THREE.Group();
  group.name = `appliance-state:${state.appliance}`;
  group.userData = {
    appliance: state.appliance,
    status: state.status,
    temperatureC: state.temperatureC,
    rpm: state.rpm,
    massG: state.massG,
    powerWatts: state.powerWatts,
    pressureBar: state.pressureBar,
    torqueNm: state.torqueNm,
    viscosityPas: state.viscosityPas,
    acousticNoiseDba: state.acousticNoiseDba,
    vibrationMmPerSecRms: state.vibrationMmPerSecRms,
    doorOpenRatio: state.doorOpenRatio,
    thermalPlumeIntensity: state.thermalPlumeIntensity,
    activeTaskId: state.activeTaskId,
  };
  const anchor = applianceWorldAnchor(station, state.appliance);
  group.position.copy(anchor);

  if (
    state.isRotary &&
    (state.vibrationMmPerSecRms >= 0.4 || state.status === "fault")
  ) {
    const waveRing = new THREE.Mesh(
      new THREE.TorusGeometry(
        0.24 + Math.min(0.08, state.vibrationMmPerSecRms * 0.015),
        0.005,
        8,
        28,
      ),
      emissiveMaterial(
        state.status === "fault" ? 0xd9483b : 0x38bdf8,
        state.status === "fault" ? 0xff5a4f : 0x38bdf8,
        0.65,
        0.48,
      ),
    );
    waveRing.rotation.x = Math.PI / 2;
    waveRing.position.y = -0.02;
    group.add(waveRing);
  }

  const doorOverlay = buildDoorOrInterlockOverlay(state);
  if (doorOverlay !== null) {
    group.add(doorOverlay);
  }
  if (state.thermalPlumeIntensity > 0.05) {
    group.add(
      buildThermalPlume(
        state.thermalPlumeIntensity,
        state.progress,
        state.category === "oven" ? 0xfed7aa : 0xe2e8f0,
      ),
    );
  }

  const haloColor = applianceHaloColor(state);
  const isHighlighted = state.status === "active" || state.status === "fault";
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.16, 0.22, 32),
    emissiveMaterial(
      haloColor,
      haloColor,
      isHighlighted ? 0.95 : state.status === "completed" ? 0.45 : 0.15,
      isHighlighted ? 0.94 : state.status === "completed" ? 0.65 : 0.32,
    ),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -0.06;
  group.add(ring);

  if (isHighlighted) {
    const light = new THREE.PointLight(
      haloColor,
      state.status === "fault" ? 1.8 : 1.35,
      1.85,
    );
    light.position.set(0, 0.18, 0.08);
    group.add(light);
  }
  if (state.status === "fault") {
    const beacon = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.065, 0),
      emissiveMaterial(0xd9483b, 0xff5a4f, 1.1, 0.92),
    );
    beacon.position.set(0, 0.28, 0.06);
    group.add(beacon);
  }

  if (state.status === "active" || state.massG > 0) {
    switch (state.appliance) {
      case "maruzen-mih-02c":
      case "vollrath-59500p": {
        const pan = new THREE.Mesh(
          new THREE.CylinderGeometry(0.13, 0.115, 0.075, 24),
          material(0x475569),
        );
        pan.position.y = 0.035;
        const liquid = new THREE.Mesh(
          new THREE.CylinderGeometry(0.118, 0.112, 0.042, 24),
          emissiveMaterial(
            state.liquidColorHex,
            state.liquidColorHex,
            state.status === "active" ? 0.35 : 0.1,
          ),
        );
        liquid.position.y = 0.05;
        group.add(pan, liquid);
        break;
      }
      case "ohaus-ranger-3000": {
        const bowl = new THREE.Mesh(
          new THREE.CylinderGeometry(0.11, 0.08, 0.06, 24),
          material(0xdbe2e8),
        );
        bowl.position.y = 0.03;
        const charge = new THREE.Mesh(
          new THREE.CylinderGeometry(0.095, 0.075, 0.035, 24),
          material(state.liquidColorHex),
        );
        charge.position.y = 0.042;
        group.add(bowl, charge);
        break;
      }
      case "hobart-hl200":
      case "waring-wsg60":
      case "vitamix-quiet-one":
      case "severin-sm-3587": {
        const radius =
          state.appliance === "hobart-hl200"
            ? 0.13
            : state.appliance === "vitamix-quiet-one"
              ? 0.085
              : 0.075;
        const contents = new THREE.Mesh(
          new THREE.CylinderGeometry(radius, radius * 0.85, 0.06, 24),
          emissiveMaterial(
            state.liquidColorHex,
            state.liquidColorHex,
            state.status === "active" ? 0.3 : 0.1,
          ),
        );
        contents.position.y = 0.02;
        group.add(contents);
        if (state.rpm > 0) {
          const blade = new THREE.Mesh(
            new THREE.BoxGeometry(radius * 1.6, 0.014, 0.022),
            emissiveMaterial(0x38bdf8, 0x38bdf8, 0.8),
          );
          blade.position.y = 0.058;
          blade.rotation.y = state.progress * Math.PI * 10;
          group.add(blade);
        }
        break;
      }
      case "maruzen-mbco-5e": {
        const chamberGlow = new THREE.Mesh(
          new THREE.BoxGeometry(0.38, 0.22, 0.04),
          emissiveMaterial(
            state.liquidColorHex,
            0xff6b00,
            state.status === "active" ? 0.85 : 0.25,
            0.85,
          ),
        );
        chamberGlow.position.set(0, 0.04, 0.08);
        group.add(chamberGlow);
        break;
      }
      case "hoshizaki-rt-120snj": {
        const isDefrost = state.programSummary.includes("Defrost");
        const badge = new THREE.Mesh(
          new THREE.BoxGeometry(0.32, 0.06, 0.04),
          emissiveMaterial(
            isDefrost ? 0xf59e0b : 0x38bdf8,
            isDefrost ? 0xf97316 : 0x38bdf8,
            state.status === "active" || isDefrost ? 0.85 : 0.35,
          ),
        );
        badge.position.set(0, 0.05, 0.08);
        const evaporatorCoilBar = new THREE.Mesh(
          new THREE.BoxGeometry(0.28, 0.025, 0.03),
          emissiveMaterial(
            isDefrost ? 0xfb923c : 0xe0f2fe,
            isDefrost ? 0xf97316 : 0x7dd3fc,
            isDefrost ? 0.9 : 0.55,
          ),
        );
        evaporatorCoilBar.position.set(0, 0.11, -0.02);
        group.add(badge, evaporatorCoilBar);
        break;
      }
      case "winterhalter-uc-l": {
        const badge = new THREE.Mesh(
          new THREE.BoxGeometry(0.32, 0.06, 0.04),
          emissiveMaterial(
            0x38bdf8,
            0x38bdf8,
            state.status === "active" ? 0.85 : 0.3,
          ),
        );
        badge.position.set(0, 0.05, 0.08);
        group.add(badge);
        break;
      }
      case "la-marzocco-linea-classic-s-2g": {
        const cup = new THREE.Mesh(
          new THREE.CylinderGeometry(0.036, 0.028, 0.045, 20),
          emissiveMaterial(
            state.liquidColorHex,
            0xf59e0b,
            state.status === "active" ? 0.75 : 0.2,
          ),
        );
        cup.position.set(-0.08, 0.03, 0.06);
        group.add(cup);
        break;
      }
      case "pastry-bench": {
        const slab = new THREE.Mesh(
          new THREE.BoxGeometry(0.28, 0.024, 0.22),
          material(0xe2ded5),
        );
        slab.position.set(0, 0.012, 0);
        const shellGeo = new THREE.BufferGeometry();
        updateDeformablePastryBufferGeometry(
          shellGeo,
          createDeformablePastryBufferState(),
          createCanonicalCrimpedPastryFlexMesh(),
          state.status === "active" ? 1.4 : 0.4,
        );
        const sheet = new THREE.Mesh(
          shellGeo,
          emissiveMaterial(
            state.liquidColorHex,
            0xf59e0b,
            state.status === "active" ? 0.5 : 0.15,
          ),
        );
        sheet.position.set(0, 0.02, 0);
        group.add(slab, sheet);
        break;
      }
      default:
        assertNever(state.appliance);
    }
  }
  return group;
}

/** A financier tray, a 3-tin deformed-shell pie tray, a cooling grid or a preparation vessel. */
function carrierItem(
  carrier: string,
  store: string,
  byAppliance: ReadonlyMap<string, SynchronizedApplianceState>,
): THREE.Group {
  if (isPieCarrierOrStore(carrier, store)) {
    const bench = byAppliance.get("pastry-bench");
    const scale = byAppliance.get("ohaus-ranger-3000");
    const oven = byAppliance.get("maruzen-mbco-5e");
    return buildPieCarrierGroup(
      carrier,
      store,
      byAppliance.size > 0
        ? {
            benchTaskId: bench?.activeTaskId ?? bench?.lastTaskId ?? null,
            benchProgress: bench?.progress ?? 1,
            scaleTaskId: scale?.activeTaskId ?? null,
            ovenTaskId: oven?.activeTaskId ?? oven?.lastTaskId ?? null,
            ovenProgress: oven?.progress ?? 0.85,
            ovenCompleted: oven?.status === "completed",
          }
        : null,
    );
  }
  const item = new THREE.Group();
  item.name = carrier;
  const isPan =
    carrier.startsWith("pan") || carrier.startsWith("braise-pan");
  if (
    isPan ||
    carrier.startsWith("bowl") ||
    carrier.startsWith("jug") ||
    carrier.startsWith("receiver") ||
    carrier.startsWith("concentrate")
  ) {
    const vessel = new THREE.Mesh(
      isPan
        ? new THREE.CylinderGeometry(0.13, 0.12, 0.06, 24)
        : new THREE.CylinderGeometry(0.12, 0.09, 0.1, 24),
      material(
        isPan
          ? 0x3d3f42
          : carrier.startsWith("concentrate")
            ? 0x28272d
            : 0xc9cdd1,
      ),
    );
    vessel.position.y = 0.05;
    item.add(vessel);
    return item;
  }
  const grid = carrier.startsWith("grid");
  const base = new THREE.Mesh(
    new RoundedBoxGeometry(
      0.46,
      grid ? 0.012 : 0.035,
      0.32,
      3,
      grid ? 0.004 : 0.007,
    ),
    material(grid ? 0xd6d9dc : store === "clean-trays" ? 0x9ea4a8 : 0x55595d),
  );
  base.position.y = grid ? 0.006 : 0.018;
  base.castShadow = true;
  base.receiveShadow = true;
  item.add(base);
  // Filled trays and loaded grids carry eight financiers.
  if (store !== "clean-trays" && store !== "empty-grids") {
    for (let cavity = 0; cavity < 8; cavity++) {
      const piece = new THREE.Mesh(
        new RoundedBoxGeometry(0.08, 0.025, 0.045, 2, 0.004),
        material(store === "filled-moulds" ? 0xe7d3a2 : 0xc28a45),
      );
      piece.position.set(
        -0.165 + (cavity % 4) * 0.11,
        (grid ? 0.012 : 0.035) + 0.012,
        cavity < 4 ? -0.07 : 0.07,
      );
      piece.castShadow = true;
      item.add(piece);
    }
  }
  return item;
}

function placeItem(
  item: THREE.Group,
  station: FactoryStationSource,
  store: string,
  slot: number,
): void {
  switch (station.model) {
    case "cooling-rack": {
      // Loaded grids fill shelves from the top; empty grids wait at the bottom.
      const shelf =
        store === "empty-grids" ? 0.12 + slot * 0.1 : 1.62 - slot * 0.1;
      item.position.set(station.x, shelf, station.z);
      return;
    }
    case "chiller-rack-station": {
      if (
        store === "loaded-grids" ||
        store === "empty-grids" ||
        store === "pan-staging-rack" ||
        store === "pie-cooling-rack"
      ) {
        const shelf =
          store === "empty-grids" ? 0.12 + slot * 0.1 : 1.52 - slot * 0.1;
        item.position.set(station.x + 0.45, shelf, station.z);
      } else {
        item.position.set(
          station.x - 0.55 + (slot % 2) * 0.28,
          0.88,
          station.z + 0.1,
        );
      }
      return;
    }
    case "oven":
      // Stack multiple trays cleanly across the Maruzen convection chamber rails.
      item.position.set(
        station.x,
        COUNTER + 0.24 + slot * 0.085,
        station.z + 0.36,
      );
      return;
    case "hob":
      item.position.set(station.x, COUNTER + 0.12, station.z);
      return;
    case "dual-hob-station":
      item.position.set(
        station.x - 0.34 + (slot % 2) * 0.68,
        COUNTER + 0.12,
        station.z + (slot >= 2 ? 0.22 : 0),
      );
      return;
    case "wash-sink":
      item.position.set(station.x - 0.25 + slot * 0.25, 0.92, station.z);
      return;
    case "dishwasher-sink-station":
      item.position.set(
        station.x - 0.35 + (slot % 4) * 0.28,
        0.92,
        station.z + (slot >= 4 ? 0.16 : -0.06),
      );
      return;
    case "prep-table":
    case "cooling-table":
    case "packing-table":
    case "scale-station":
    case "mixer-station":
    case "sesame-prep-station":
    case "beverage-frother-station":
      item.position.set(
        station.x - 0.55 + (slot % 3) * 0.55,
        COUNTER + Math.floor(slot / 3) * 0.06,
        station.z + (slot % 2 === 0 ? -0.12 : 0.22),
      );
      return;
    default:
      return assertNever(station.model);
  }
}

function stationWorkerStandPoint(
  planId: BakeryFloorPlanId,
  station: FactoryStationSource,
  laneOffset: number,
): readonly [number, number] {
  if (!isApplianceId(station.id))
    return [station.x + laneOffset, station.z + 0.78];
  const pose = floorPlanWorkspace.getPose(planId, station.id);
  const fp = APPLIANCE_FOOTPRINTS[station.id];
  const [ox, oz] = fp?.handoffOffset ?? [0, 0.78];
  const lateral = ox + laneOffset;
  const cos = Math.cos(pose.rotY);
  const sin = Math.sin(pose.rotY);
  return [pose.x + lateral * cos + oz * sin, pose.z - lateral * sin + oz * cos];
}

const WORKER_COLORS = [0x3f72af, 0xb5543c, 0x4f8a4b] as const;
function workerMarker(
  index: number,
  options: Readonly<{
    facingYawRad: number;
    walking: boolean;
    working: boolean;
    carrying: boolean;
    progress: number;
  }>,
): THREE.Group {
  const color = WORKER_COLORS[index % WORKER_COLORS.length] ?? 0x3f72af;
  const phase = options.walking
    ? options.progress * Math.PI * 10
    : options.progress * Math.PI * 6 + index * 1.4;
  return createPosedHumanWorkerGroup(
    index,
    {
      facingYawRad: options.facingYawRad,
      walking: options.walking,
      working: options.working,
      carrying: options.carrying,
      phase,
    },
    color,
  );
}
