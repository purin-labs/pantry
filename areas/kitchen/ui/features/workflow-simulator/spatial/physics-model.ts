import type { PhysicsSceneReplay } from "@purin-labs/production-simulation/recipes/bakery/physics-playback";
import { ROBOTS } from "@purin-labs/bakery-model/bakery-robots";
import * as THREE from "three";
import type { WorkcellResourceId } from "@purin-labs/production-simulation/recipes/bakery/workcell-input";
import type {
  PhysicsPose,
  PhysicsSample,
  JointAngles,
  PhysicsEvent,
  PhysicsLayout,
  PersistentPhysicsMotion,
} from "@purin-labs/bakery-model/bakery-physics";
import {
  sceneLegAt,
  physicsLegAt,
  sceneDuration,
} from "@purin-labs/production-simulation/recipes/bakery/physics-playback";
import {
  modelBoxes,
  planFootprint,
  type FloorPlanItem,
  type FitFinding,
} from "./floor-plan-geometry.ts";
import type { WorkcellSelection } from "@purin-labs/production-simulation/simulator/selection";
import { workcellResource } from "@purin-labs/production-simulation/recipes/bakery/workcell-input";
import {
  COLD_CELL,
  instanceForFixture,
} from "@purin-labs/production-simulation/recipes/bakery/workcell-instances";
import {
  checkDoorSweep,
  doorSweepBounds,
  type DoorSweep,
} from "./door-sweep.ts";

// The Robot cell's instances, by their role in its two skills.
const RACK = COLD_CELL.skills["table-to-rack"];
const OVEN = COLD_CELL.skills["table-to-oven"];

export type WorkcellVisualBundle = Readonly<{
  fixtures: THREE.Group;
  ur5eTooling: THREE.Group | null;
}>;

export function samplePhysics(
  replay: PhysicsSceneReplay,
  seconds: number,
): PhysicsSample {
  const leg = sceneLegAt(replay, seconds);
  const recording = leg.recording;
  const step = Math.max(
    recording.samples[0].step,
    Math.min(
      recording.kind === "persistent-physics-motion"
        ? recording.endStep
        : recording.outcome.step,
      leg.time / recording.request.timestep,
    ),
  );
  let low = 0;
  let high = recording.samples.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (sampleAt(recording.samples, middle).step <= step) low = middle;
    else high = middle - 1;
  }
  const first = sampleAt(recording.samples, low);
  const next = sampleAt(
    recording.samples,
    Math.min(low + 1, recording.samples.length - 1),
  );
  if (
    first.step * recording.request.timestep === leg.time ||
    first.step === step ||
    next.step === first.step
  )
    return first;
  if (next.step * recording.request.timestep === leg.time) return next;
  const fraction = (step - first.step) / (next.step - first.step);
  return {
    step,
    joints: interpolateJoints(first.joints, next.joints, fraction),
    tool: interpolatePose(first.tool, next.tool, fraction),
    jaw: interpolatePose(first.jaw, next.jaw, fraction),
    tray: interpolatePose(first.tray, next.tray, fraction),
  };
}

/** Every index read by the binary search above is within the recording. */
function sampleAt(
  samples: readonly PhysicsSample[],
  index: number,
): PhysicsSample {
  const sample = samples[index];
  if (sample === undefined) {
    throw new RangeError(`physics sample ${index} is out of range`);
  }
  return sample;
}

function interpolateJoints(
  first: JointAngles,
  next: JointAngles,
  fraction: number,
): JointAngles {
  const lerp = (index: 0 | 1 | 2 | 3 | 4 | 5): number =>
    THREE.MathUtils.lerp(first[index], next[index], fraction);
  return [lerp(0), lerp(1), lerp(2), lerp(3), lerp(4), lerp(5)];
}

function interpolatePose(
  first: PhysicsPose,
  next: PhysicsPose,
  fraction: number,
): PhysicsPose {
  const rotation = new THREE.Quaternion(first[4], first[5], first[6], first[3]);
  rotation.slerp(
    new THREE.Quaternion(next[4], next[5], next[6], next[3]),
    fraction,
  );
  return [
    THREE.MathUtils.lerp(first[0], next[0], fraction),
    THREE.MathUtils.lerp(first[1], next[1], fraction),
    THREE.MathUtils.lerp(first[2], next[2], fraction),
    rotation.w,
    rotation.x,
    rotation.y,
    rotation.z,
  ];
}

function setPhysicsPose(object: THREE.Object3D, pose: PhysicsPose): void {
  object.position.set(pose[0], pose[1], pose[2]);
  object.quaternion.set(pose[4], pose[5], pose[6], pose[3]);
}

/** Only this root converts Z-up physics into Three.js Y-up. */
export class PhysicsModel {
  private replay: PhysicsSceneReplay;
  get recording(): PhysicsSceneReplay {
    return this.replay;
  }
  readonly root = new THREE.Group();
  private readonly contactGeometry = new Map<string, THREE.Mesh>();
  private readonly contactOutlines = new Map<string, THREE.LineSegments>();
  readonly robot = new THREE.Group();
  readonly tool = new THREE.Group();
  readonly jaw = new THREE.Group();
  readonly tray = new THREE.Group();
  readonly oven = new THREE.Group();
  private readonly ovenContacts = new THREE.Group();
  private pivots: Readonly<{ object: THREE.Object3D; axis: THREE.Vector3 }>[] =
    [];
  private readonly resourceByObject = new Map<
    THREE.Object3D,
    WorkcellResourceId
  >();
  private readonly floorGeometry = new Map<WorkcellResourceId, THREE.Mesh[]>();
  private readonly rackPositions = new Map<THREE.Object3D, THREE.Vector3>();
  private readonly rackOffset = new THREE.Vector3();
  private rackGhost: THREE.Box3 | null = null;
  private opening: Readonly<{
    bounds: THREE.Box3;
    findings: readonly FitFinding[];
    clear: number;
    checked: number;
  }> | null = null;
  private fitCheckActive = false;
  private inspectOpening = false;
  private doorPreviewActive = false;
  private outlinedContacts = new Set<string>();
  private door: Readonly<{
    visual: THREE.Object3D;
    recordedAngle: number;
    recordedWorldInverse: THREE.Matrix4;
    solids: readonly Readonly<{
      mesh: THREE.Mesh;
      position: THREE.Vector3;
      rotation: THREE.Quaternion;
      scale: THREE.Vector3;
      world: THREE.Matrix4;
    }>[];
  }> | null = null;

  constructor(replay: PhysicsSceneReplay) {
    this.replay = replay;
    const recording = sceneLegAt(replay, 0).recording;
    this.root.rotation.x = -Math.PI / 2;
    this.root.add(
      this.robot,
      this.tool,
      this.jaw,
      this.tray,
      this.oven,
      this.ovenContacts,
    );
    this.resourceByObject.set(this.root, RACK.cell);
    for (const body of ["robot", "tool", "jaw", "tray"] as const) {
      const instance = instanceForFixture(body, "");
      if (instance !== null) this.resourceByObject.set(this[body], instance);
    }
    setPhysicsPose(this.robot, recording.robotBase);
    if (recording.fixture.kind !== "rack") {
      setPhysicsPose(this.oven, recording.fixture.pose);
      this.resourceByObject.set(this.oven, OVEN.destination);
      this.resourceByObject.set(this.ovenContacts, OVEN.destination);
    }
    for (const item of recording.geometry) {
      let geometry: THREE.BufferGeometry;
      if (item.shape === "box") {
        geometry = new THREE.BoxGeometry(
          item.size[0] * 2,
          item.size[1] * 2,
          item.size[2] * 2,
        );
      } else if (item.shape === "capsule") {
        geometry = new THREE.CapsuleGeometry(
          item.size[0],
          item.size[1] * 2,
          8,
          16,
        );
        geometry.rotateX(Math.PI / 2);
      } else {
        geometry = new THREE.CylinderGeometry(
          item.size[0],
          item.size[0],
          item.size[1] * 2,
          24,
        );
        geometry.rotateX(Math.PI / 2);
      }
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setRGB(
          item.rgba[0],
          item.rgba[1],
          item.rgba[2],
        ),
        roughness: 0.55,
        metalness: 0.1,
        opacity: Math.min(item.rgba[3], 0.36),
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = item.name;
      mesh.userData.isCollisionShape = true;
      mesh.userData.excludeFromAo = true;
      this.contactGeometry.set(item.name, mesh);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.visible = false;
      setPhysicsPose(mesh, item.pose);
      let parent: THREE.Group;
      if (item.body !== "world") parent = this[item.body];
      else if (
        item.name.startsWith("mbco_") &&
        !item.name.startsWith("mbco_tray_")
      )
        parent = this.ovenContacts;
      else parent = this.root;
      parent.add(mesh);
      if (item.body === "world") {
        // World geometry belongs to the instance whose fixture names it.
        const resource = instanceForFixture("world", item.name);
        if (resource === RACK.destination)
          this.rackPositions.set(mesh, mesh.position.clone());
        if (resource !== null) {
          this.resourceByObject.set(mesh, resource);
          this.addFloorGeometry(resource, mesh);
        }
      }
      if (item.body === "tray") this.addFloorGeometry(RACK.tray, mesh);
    }
    this.update(0);
  }

  /** Live samples may change. Scene mappings remain those parsed at startup. */
  setPersistentMotion(motion: PersistentPhysicsMotion): void {
    const previous = this.replay;
    if (
      previous.kind !== "persistent-physics-motion" ||
      previous.geometry !== motion.geometry ||
      previous.fixture !== motion.fixture ||
      previous.robotBase !== motion.robotBase ||
      previous.request.robot !== motion.request.robot
    )
      throw new Error("Live samples require the same validated cell scene.");
    this.replay = motion;
  }

  usesUr5eTooling(): boolean {
    return this.contactGeometry.has("clamp_mount_spacer");
  }

  setFitCheckActive(active: boolean): boolean {
    if (this.fitCheckActive === active) return false;
    this.fitCheckActive = active;
    this.syncContactVisibility();
    return true;
  }

  get isShowingCollisionShapes(): boolean {
    return (
      this.fitCheckActive ||
      this.inspectOpening ||
      this.doorPreviewActive ||
      this.outlinedContacts.size > 0
    );
  }

  private syncContactVisibility(): void {
    const showAll =
      this.fitCheckActive || this.inspectOpening || this.doorPreviewActive;
    for (const [name, mesh] of this.contactGeometry) {
      mesh.visible = showAll || this.outlinedContacts.has(name);
    }
  }

  attachRobot(scene: THREE.Group): void {
    const pivots = [];
    const robot = sceneLegAt(this.recording, 0).recording.request.robot;
    for (const joint of ROBOTS[robot].joints) {
      const object = scene.getObjectByName(joint.node);
      if (object === undefined)
        throw new Error("Robot visual has an incompatible joint hierarchy.");
      pivots.push({ object, axis: new THREE.Vector3(...joint.axis) });
    }
    enableModelShadows(scene);
    // The GLB already uses Y-up, so undo that conversion inside the physics root.
    scene.rotation.x = Math.PI / 2;
    this.robot.add(scene);
    this.pivots = pivots;
  }

  attachOven(scene: THREE.Group): void {
    const fixture = sceneLegAt(this.recording, 0).recording.fixture;
    if (fixture.kind === "rack")
      throw new Error("Recording has no oven fixture.");
    const door = scene.getObjectByName("mbco_door");
    if (!door) throw new Error("Maruzen visual is missing its door pivot.");
    enableModelShadows(scene);
    scene.rotation.x = Math.PI / 2;
    door.rotation.y = -fixture.doorAngle;
    this.oven.add(scene);
    this.root.updateMatrixWorld(true);
    const solids = [];
    for (const mesh of this.floorGeometry.get(OVEN.destination) ?? []) {
      if (mesh.name.startsWith("mbco_door_"))
        solids.push({
          mesh,
          position: mesh.position.clone(),
          rotation: mesh.quaternion.clone(),
          scale: mesh.scale.clone(),
          world: mesh.matrixWorld.clone(),
        });
    }
    this.door = {
      visual: door,
      recordedAngle: fixture.doorAngle,
      recordedWorldInverse: door.matrixWorld.clone().invert(),
      solids,
    };
    const sweep: DoorSweep = {
      pivot: door.getWorldPosition(new THREE.Vector3()),
      axis: new THREE.Vector3(0, -1, 0).transformDirection(door.matrixWorld),
      recordedAngle: fixture.doorAngle,
      boxes: modelBoxes(solids.map(doorSolidMesh)),
    };
    const findings: FitFinding[] = [];
    let clear = 0;
    let checked = 0;
    for (const [id, meshes] of this.floorGeometry) {
      if (id === OVEN.destination || id === RACK.tray) continue;
      const boxes = modelBoxes(meshes);
      const sweepResult = checkDoorSweep(sweep, boxes);
      const result =
        sweepResult.kind === "clear" &&
        (boxes.length !== meshes.length || sweep.boxes.length !== solids.length)
          ? { kind: "unchecked" as const }
          : sweepResult;
      checked++;
      if (result.kind === "clear") clear++;
      else
        findings.push({
          source: "geometry",
          rule: "door-sweep",
          kind: result.kind,
          first: OVEN.destination,
          second: id,
          message:
            result.kind === "blocked"
              ? `Oven opening blocked: door overlaps ${workcellResource(id).name} at ${((result.angle * 180) / Math.PI).toFixed(1)}° within the modeled 0–110° opening.`
              : `Oven opening near ${workcellResource(id).name} remains unchecked: the sweep envelope could not exclude contact.`,
        });
    }
    this.opening = { bounds: doorSweepBounds(sweep), findings, clear, checked };
  }

  attachWorkcellVisuals(bundle: WorkcellVisualBundle): void {
    const recording = sceneLegAt(this.recording, 0).recording;
    if (this.usesUr5eTooling()) {
      if (bundle.ur5eTooling === null)
        throw new Error("UR5e recording is missing its tooling visual.");
      const jaw = bundle.ur5eTooling.getObjectByName("cell_upper_jaw");
      const gripper = bundle.ur5eTooling.getObjectByName("cell_gripper");
      if (!gripper || !jaw)
        throw new Error("UR5e tooling visual has an incompatible hierarchy.");
      jaw.removeFromParent();
      gripper.removeFromParent();
      mountVisualNode(this.tool, gripper);
      mountVisualNode(this.jaw, jaw);
    } else if (this.contactGeometry.has("clamp_palm")) {
      mountVisualNode(
        this.tool,
        takeRequiredNode(bundle.fixtures, "standard_gripper"),
      );
      mountVisualNode(
        this.jaw,
        takeRequiredNode(bundle.fixtures, "standard_upper_jaw"),
      );
    }

    if (this.contactGeometry.has("mbco_tray_bottom")) {
      mountVisualNode(
        this.tray,
        takeRequiredNode(bundle.fixtures, "tray_mbco"),
      );
    }
    if (this.contactGeometry.has("receiving_pan_base")) {
      mountVisualNode(
        this.tray,
        takeRequiredNode(bundle.fixtures, "tray_receiving_pan"),
      );
    } else if (this.contactGeometry.has("cold_contents")) {
      mountVisualNode(
        this.tray,
        takeRequiredNode(bundle.fixtures, "tray_cold_contents"),
      );
    }

    const pedestalCol = this.contactGeometry.get("pedestal_column");
    if (pedestalCol !== undefined) {
      const group = new THREE.Group();
      group.name = "pedestal_visual";
      group.visible = this.robot.visible;
      group.position.set(pedestalCol.position.x, pedestalCol.position.y, 0);
      mountVisualNode(group, takeRequiredNode(bundle.fixtures, "pedestal"));
      this.resourceByObject.set(group, RACK.arm);
      this.root.add(group);
    }

    const tableTop = this.contactGeometry.get("table_top");
    if (tableTop !== undefined) {
      const group = new THREE.Group();
      group.name = "source_table_visual";
      group.position.set(tableTop.position.x, tableTop.position.y, 0);
      mountVisualNode(group, takeRequiredNode(bundle.fixtures, "source_table"));
      this.resourceByObject.set(group, RACK.source);
      this.root.add(group);
    }

    const leftRail = this.contactGeometry.get("rack_rail_left");
    const rightRail = this.contactGeometry.get("rack_rail_right");
    if (leftRail !== undefined && rightRail !== undefined) {
      const leftBase = this.rackPositions.get(leftRail) ?? leftRail.position;
      const rightBase = this.rackPositions.get(rightRail) ?? rightRail.position;
      const variant = this.contactGeometry.has("rack_upper_left")
        ? "rack_full"
        : leftBase.z > 0.69
          ? "rack_combined"
          : "rack_ur5e";
      const group = new THREE.Group();
      group.name = "rack_visual";
      const basePos = new THREE.Vector3(
        leftBase.x,
        (leftBase.y + rightBase.y) / 2,
        0,
      );
      this.rackPositions.set(group, basePos.clone());
      group.position.copy(basePos).add(this.rackOffset);
      mountVisualNode(group, takeRequiredNode(bundle.fixtures, variant));
      this.resourceByObject.set(group, RACK.destination);
      this.root.add(group);
    }

    const stand = this.contactGeometry.get("oven_stand");
    if (stand !== undefined) {
      const group = new THREE.Group();
      group.name = "oven_stand_visual";
      group.position.set(stand.position.x, stand.position.y, 0);
      mountVisualNode(group, takeRequiredNode(bundle.fixtures, "oven_stand"));
      this.resourceByObject.set(group, OVEN.destination);
      this.root.add(group);
    }

    const obstruction = recording.geometry.find(
      (item) => item.name === "destination_obstruction",
    );
    if (obstruction !== undefined) {
      const variant =
        obstruction.size[0] < 0.22
          ? "obstruction_oven_pan"
          : obstruction.size[2] < 0.07
            ? "obstruction_rack_low"
            : "obstruction_rack_tall";
      const group = new THREE.Group();
      group.name = "destination_obstruction_visual";
      setPhysicsPose(group, obstruction.pose);
      mountVisualNode(group, takeRequiredNode(bundle.fixtures, variant));
      this.resourceByObject.set(group, RACK.cell);
      this.root.add(group);
    }

    this.root.updateMatrixWorld(true);
    disposeUnusedVisualNodes(this.root, [bundle.fixtures, bundle.ur5eTooling]);
  }

  inspectDoorOpening(active: boolean): string {
    this.inspectOpening = active;
    this.syncContactVisibility();
    if (this.opening === null) return "Door opening geometry unavailable.";
    return `Full 0–110° opening: ${this.opening.clear} of ${this.opening.checked} fixed-equipment checks clear. See fit findings for blocked or unresolved checks. Moving robot, tool, tray and required service space remain unchecked.`;
  }

  recordedDoorAngle(): number | null {
    return this.door?.recordedAngle ?? null;
  }

  showRackLayout(applied: PhysicsLayout, draft: PhysicsLayout | null): void {
    const source = sceneLegAt(this.recording, 0).recording.request.layout;
    const sourceX = source.kind === "fixed" ? 0 : source.xMm;
    const sourceY = source.kind === "fixed" ? 0 : source.yMm;
    const appliedX = applied.kind === "fixed" ? 0 : applied.xMm;
    const appliedY = applied.kind === "fixed" ? 0 : applied.yMm;
    const appliedDelta = new THREE.Vector3(
      (appliedX - sourceX) / 1000,
      (appliedY - sourceY) / 1000,
      0,
    );
    for (const [object, position] of this.rackPositions) {
      object.position.copy(position).add(appliedDelta);
    }
    this.rackOffset.copy(appliedDelta);
    this.root.updateMatrixWorld(true);
    this.rackGhost =
      draft === null ? null : this.resourceBounds(RACK.destination);
    if (draft !== null) {
      const x = draft.kind === "fixed" ? 0 : draft.xMm;
      const y = draft.kind === "fixed" ? 0 : draft.yMm;
      const draftDelta = new THREE.Vector3(
        (x - sourceX) / 1000,
        (y - sourceY) / 1000,
        0,
      );
      for (const [object, position] of this.rackPositions) {
        object.position.copy(position).add(draftDelta);
      }
      this.rackOffset.copy(draftDelta);
      this.root.updateMatrixWorld(true);
    }
  }

  previewDoor(angle: number | null): void {
    this.doorPreviewActive = angle !== null;
    this.syncContactVisibility();
    const door = this.door;
    if (door === null) return;
    door.visual.rotation.y = -(angle ?? door.recordedAngle);
    this.root.updateMatrixWorld(true);
    const delta = new THREE.Matrix4().multiplyMatrices(
      door.visual.matrixWorld,
      door.recordedWorldInverse,
    );
    for (const solid of door.solids) {
      if (angle === null) {
        solid.mesh.position.copy(solid.position);
        solid.mesh.quaternion.copy(solid.rotation);
        solid.mesh.scale.copy(solid.scale);
      } else if (solid.mesh.parent !== null) {
        const matrix = solid.mesh.parent.matrixWorld
          .clone()
          .invert()
          .multiply(delta)
          .multiply(solid.world);
        matrix.decompose(
          solid.mesh.position,
          solid.mesh.quaternion,
          solid.mesh.scale,
        );
      }
    }
    this.root.updateMatrixWorld(true);
  }

  update(seconds: number): void {
    const sample = samplePhysics(this.recording, seconds);
    for (const [index, pivot] of this.pivots.entries()) {
      const angle = sample.joints[index];
      if (angle === undefined) continue;
      pivot.object.quaternion.setFromAxisAngle(pivot.axis, angle);
    }
    setPhysicsPose(this.tool, sample.tool);
    setPhysicsPose(this.jaw, sample.jaw);
    setPhysicsPose(this.tray, sample.tray);
    this.root.updateMatrixWorld(true);
  }

  /** Outline the recorded geometry. Contact points and force directions are absent. */
  showContactShapes(names: ReadonlySet<string>): number {
    for (const outline of this.contactOutlines.values())
      outline.visible = false;
    const active = new Set<string>();
    let mapped = 0;
    for (const name of names) {
      const mesh = this.contactGeometry.get(name);
      if (mesh === undefined) continue;
      active.add(name);
      let outline = this.contactOutlines.get(name);
      if (outline === undefined) {
        outline = new THREE.LineSegments(
          new THREE.EdgesGeometry(mesh.geometry),
          new THREE.LineBasicMaterial({
            color: 0xd65a26,
            depthTest: false,
            transparent: true,
            opacity: 0.95,
          }),
        );
        outline.renderOrder = 10;
        mesh.add(outline);
        this.contactOutlines.set(name, outline);
      }
      outline.visible = true;
      mapped++;
    }
    this.outlinedContacts = active;
    this.syncContactVisibility();
    return mapped;
  }

  resourceForObject(object: THREE.Object3D): WorkcellResourceId | null {
    let current: THREE.Object3D | null = object;
    while (current !== null) {
      const resource = this.resourceByObject.get(current);
      if (resource !== undefined) return resource;
      current = current.parent;
    }
    return null;
  }

  resourceBounds(resource: WorkcellResourceId): THREE.Box3 {
    const bounds = new THREE.Box3();
    for (const [object, id] of this.resourceByObject) {
      if (id === resource) bounds.union(new THREE.Box3().setFromObject(object));
    }
    return bounds;
  }

  private addFloorGeometry(
    resource: WorkcellResourceId,
    mesh: THREE.Mesh,
  ): void {
    const meshes = this.floorGeometry.get(resource) ?? [];
    meshes.push(mesh);
    this.floorGeometry.set(resource, meshes);
  }

  floorPlanItems(): readonly FloorPlanItem<WorkcellSelection>[] {
    const items: FloorPlanItem<WorkcellSelection>[] = [];
    for (const [id, meshes] of this.floorGeometry) {
      const bounds = new THREE.Box3();
      for (const mesh of meshes)
        bounds.union(new THREE.Box3().setFromObject(mesh));
      let label: string = workcellResource(id).name;
      if (id === RACK.cell) label = "Destination obstruction";
      if (id === RACK.arm) label = "Robot base";
      items.push({
        id,
        label,
        bounds,
        footprint: planFootprint(meshes),
        ...(id === OVEN.destination &&
        this.inspectOpening &&
        this.opening !== null
          ? { sweepEnvelope: this.opening.bounds }
          : {}),
        ...(id === RACK.destination && this.rackGhost !== null
          ? { originalBounds: this.rackGhost }
          : {}),
        selection: { kind: "resource", id },
        geometry:
          id === RACK.tray && this.rackGhost !== null
            ? { kind: "visual-only" }
            : { kind: "model-boxes", boxes: modelBoxes(meshes) },
      });
    }
    return items;
  }

  floorPlanFindings(seconds: number): readonly FitFinding[] {
    return [
      ...(this.inspectOpening ? (this.opening?.findings ?? []) : []),
      ...this.recordedFindings(seconds),
    ];
  }

  private recordedFindings(seconds: number): readonly FitFinding[] {
    if (this.recording.kind === "persistent-physics-motion") return [];
    if (this.rackGhost !== null)
      return [
        {
          source: "geometry",
          rule: "recorded-pose",
          kind: "unchecked",
          first: RACK.destination,
          second: RACK.tray,
          message:
            "The tray pose belongs to the previous layout. Tray motion and support for this proposal require a new simulation.",
        },
      ];
    const leg = physicsLegAt(this.recording, seconds);
    const { request, outcome } = leg.recording;
    if (
      outcome.kind !== "failed" ||
      outcome.reason !== "destination-blocked" ||
      !this.floorGeometry.has(RACK.cell)
    )
      return [];
    const destinations = {
      "table-to-rack": RACK.destination,
      "table-to-oven": OVEN.destination,
      "oven-to-table": OVEN.source,
    } as const;
    const destination = destinations[request.bakeryTaskId];
    if (!this.floorGeometry.has(destination)) return [];
    const eventIndex = leg.recording.events.findIndex(
      isFailureAt.bind(null, outcome.step),
    );
    if (eventIndex < 0) return [];
    const offset =
      Math.max(0, Math.min(sceneDuration(this.recording), seconds)) - leg.time;
    return [
      {
        source: "recording",
        rule: "recorded-pose",
        event: {
          recording: this.recording,
          request,
          eventIndex,
          time: offset + outcome.step * request.timestep,
        },
        kind: "blocked",
        first: destination,
        second: RACK.cell,
        message: `Recorded fit failure: ${workcellResource(destination).name} is blocked by the destination obstruction.`,
      },
    ];
  }

  dispose(): void {
    this.root.traverse(disposePhysicsObject);
  }
}

function doorSolidMesh(solid: Readonly<{ mesh: THREE.Mesh }>): THREE.Mesh {
  return solid.mesh;
}

function isFailureAt(step: number, event: PhysicsEvent): boolean {
  return event.kind === "failure" && event.step === step;
}

function enableModelShadows(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.userData.isCollisionShape !== true) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });
}

function takeRequiredNode(root: THREE.Object3D, name: string): THREE.Object3D {
  const node = root.getObjectByName(name);
  if (node === undefined)
    throw new Error(`Workcell visuals GLB is missing node "${name}".`);
  node.removeFromParent();
  return node;
}

function mountVisualNode(
  parent: THREE.Group,
  node: THREE.Object3D,
): THREE.Object3D {
  node.position.set(0, 0, 0);
  node.quaternion.identity();
  node.scale.set(1, 1, 1);
  node.rotation.x = Math.PI / 2;
  enableModelShadows(node);
  parent.add(node);
  return node;
}

function disposeUnusedVisualNodes(
  liveRoot: THREE.Object3D,
  leftovers: readonly (THREE.Object3D | null)[],
): void {
  const liveGeometries = new Set<THREE.BufferGeometry>();
  const liveMaterials = new Set<THREE.Material>();
  liveRoot.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) && !(obj instanceof THREE.LineSegments))
      return;
    liveGeometries.add(obj.geometry);
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) liveMaterials.add(mat);
  });
  for (const root of leftovers) {
    if (root === null) continue;
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) && !(obj instanceof THREE.LineSegments))
        return;
      if (!liveGeometries.has(obj.geometry)) obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!liveMaterials.has(mat)) mat.dispose();
      }
    });
  }
}

export function disposePhysicsObject(object: THREE.Object3D): void {
  if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
  if (
    !(object instanceof THREE.Mesh) &&
    !(object instanceof THREE.LineSegments)
  )
    return;
  object.geometry.dispose();
  const materials = Array.isArray(object.material)
    ? object.material
    : [object.material];
  for (const material of materials) material.dispose();
}
