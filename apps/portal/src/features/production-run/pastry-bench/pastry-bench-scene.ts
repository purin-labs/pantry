import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  bindOvenVisual,
  updateOvenVisual,
  type OvenVisual,
} from "../../workflow-simulator/oven-visual";
import { disposePhysicsObject } from "../../workflow-simulator/spatial/physics-model";
import {
  applyRecordedAppliancePose,
  enableSceneShadows,
} from "../appliance-sample-three";
import { SceneHost } from "../scene-host";
import type { PastryBenchFrame } from "./pastry-bench-model";
import {
  createDeformablePastryBufferState,
  PastryShellTextureController,
  updateDeformablePastryBufferGeometry,
  type DeformablePastryBufferState,
} from "./pastry-shell-visual";
import maruzenOvenGlbUrl from "../../../../../../assets/bakery-mujoco/maruzen-mbco-4me/maruzen-mbco-4me.glb?url";
import pastryBenchGlbUrl from "../../../../../../assets/bakery-mujoco/pastry-bench/pastry-bench.glb?url";

export type PastryBenchCameraPreset =
  | "bench"
  | "dough-block"
  | "tin-cavity"
  | "roller"
  | "overhead"
  | "oven";

type Vec3 = readonly [number, number, number];

const OVEN_ROOT_POSITION: Vec3 = [0.84, 0.0, -0.04];

const CAMERA_PRESETS: Readonly<
  Record<
    PastryBenchCameraPreset,
    Readonly<{
      position: Vec3;
      target: Vec3;
    }>
  >
> = {
  bench: {
    position: [0.42, 0.44, 0.94],
    target: [0.34, 0.16, 0.0],
  },
  "dough-block": {
    position: [-0.46, 0.24, 0.36],
    target: [-0.264, 0.082, 0.095],
  },
  "tin-cavity": {
    position: [0.13, 0.21, 0.23],
    target: [0.0, 0.076, 0.0],
  },
  roller: {
    position: [-0.26, 0.24, 0.32],
    target: [-0.02, 0.098, 0.0],
  },
  overhead: {
    position: [0.0, 0.56, 0.14],
    target: [0.0, 0.082, 0.0],
  },
  oven: {
    position: [1.08, 0.46, 0.68],
    target: [0.75, 0.265, 0.05],
  },
};

/**
 * Interactive Three.js WebGL view of the MuJoCo 4.0.0 deformable pastry bench
 * connected directly to the articulated Maruzen MBCO-5E/4ME convection oven:
 * - Rigid bench bodies (`pb_bench`, `pb_pie_tray`, `pb_roller`, `pb_crimper`,
 *   `pb_flour_duster`, `pb_dough_carrier`) driven by MuJoCo body poses.
 * - Live 81-vertex / 128-triangle `flexcomp` finite-element shell mesh updated
 *   from `mjData.flexvert_xpos` and `mjModel.flex_elem`, transferred onto the
 *   Maruzen middle chamber rail with laminated puff dome lift and Maillard
 *   egg-wash crust browning.
 */
export class PastryBenchScene {
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.01, 16);
  private readonly host: SceneHost;
  private readonly scene: THREE.Scene;
  private readonly orbit: OrbitControls;
  private readonly model = new THREE.Group();
  private readonly ovenRoot = new THREE.Group();

  private readonly pastryTextureController = new PastryShellTextureController();
  private readonly rawDoughTextureController = new PastryShellTextureController(
    0,
    0,
  );
  private readonly flexGeometry = new THREE.BufferGeometry();
  private readonly bufferState: DeformablePastryBufferState =
    createDeformablePastryBufferState();
  private readonly doughBlockGeometry = new THREE.BufferGeometry();
  private readonly doughBlockBufferState: DeformablePastryBufferState =
    createDeformablePastryBufferState();
  private readonly flexMaterial: THREE.MeshPhysicalMaterial;
  private readonly flexMeshObject: THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshPhysicalMaterial
  >;
  private readonly flexWireframeMaterial: THREE.MeshBasicMaterial;
  private readonly flexWireframeObject: THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshBasicMaterial
  >;
  private readonly doughBlockMaterial: THREE.MeshPhysicalMaterial;
  private readonly doughBlockMeshObject: THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshPhysicalMaterial
  >;
  private readonly doughBlockWireframeObject: THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshBasicMaterial
  >;
  private readonly doughBlockFlourDisc: THREE.Mesh<
    THREE.CircleGeometry,
    THREE.MeshBasicMaterial
  >;
  private readonly sidePieMeshes: readonly [
    THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>,
    THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>,
  ];
  private readonly flourDustingDisc: THREE.Mesh<
    THREE.RingGeometry,
    THREE.MeshBasicMaterial
  >;
  private readonly fillingDisc: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;

  private pieTrayNode: THREE.Object3D | null = null;
  private ovenVisual: OvenVisual | null = null;
  private showWireframe = true;

  private currentFrame: PastryBenchFrame | null = null;
  private lifecycle: "loading" | "ready" | "disposed" = "loading";

  constructor(view: HTMLElement) {
    this.host = new SceneHost({
      view,
      camera: this.camera,
      renderer: { antialias: true, powerPreference: "high-performance" },
      look: {
        exposure: 0.96,
        background: 0xdedad2,
        environmentIntensity: 0.52,
      },
      size: { minHeight: 520 },
      step: this.step.bind(this),
    });
    this.scene = this.host.scene;
    this.orbit = this.host.orbit;

    this.camera.position.set(...CAMERA_PRESETS.bench.position);
    this.orbit.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    this.orbit.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    this.orbit.touches.ONE = THREE.TOUCH.ROTATE;
    this.orbit.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    this.orbit.screenSpacePanning = true;
    this.orbit.target.set(...CAMERA_PRESETS.bench.target);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.maxPolarAngle = Math.PI * 0.49;
    this.orbit.minDistance = 0.14;
    this.orbit.maxDistance = 3.2;
    this.orbit.update();

    const hemi = new THREE.HemisphereLight(0xfffdf7, 0x6b6359, 1.3);
    const keyLight = new THREE.DirectionalLight(0xfff7eb, 1.95);
    keyLight.position.set(1.15, 1.75, 1.35);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 0.2;
    keyLight.shadow.camera.far = 5.2;
    keyLight.shadow.camera.left = -0.75;
    keyLight.shadow.camera.right = 1.45;
    keyLight.shadow.camera.top = 0.95;
    keyLight.shadow.camera.bottom = -0.75;
    keyLight.shadow.bias = -0.0003;
    const rimLight = new THREE.DirectionalLight(0xdce8f5, 0.72);
    rimLight.position.set(-1.1, 1.2, -0.9);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(4.6, 3.6).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0xd4cfc5,
        roughness: 0.88,
        metalness: 0.02,
      }),
    );
    floor.position.set(0.4, -0.028, 0);
    floor.receiveShadow = true;

    // Brushed JIS stainless patisserie counter supporting both the marble slab and Maruzen oven
    const counterDeck = new THREE.Mesh(
      new THREE.BoxGeometry(1.88, 0.026, 0.86),
      new THREE.MeshStandardMaterial({
        color: 0xd2d9df,
        roughness: 0.28,
        metalness: 0.76,
      }),
    );
    counterDeck.position.set(0.42, -0.0135, -0.02);
    counterDeck.castShadow = true;
    counterDeck.receiveShadow = true;

    this.ovenRoot.name = "maruzen_mbco_oven_root";
    this.ovenRoot.position.set(...OVEN_ROOT_POSITION);

    this.flexMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xf4e4be,
      map: this.pastryTextureController.texture,
      roughness: 0.58,
      metalness: 0.0,
      clearcoat: 0.14,
      clearcoatRoughness: 0.5,
      sheen: 0.32,
      sheenRoughness: 0.7,
      sheenColor: new THREE.Color(0xfffaf0),
      side: THREE.DoubleSide,
    });
    this.flexMeshObject = new THREE.Mesh(this.flexGeometry, this.flexMaterial);
    this.flexMeshObject.name = "pastry_sheet_flexcomp";
    this.flexMeshObject.castShadow = true;
    this.flexMeshObject.receiveShadow = true;
    this.flexMeshObject.visible = false;

    this.flexWireframeMaterial = new THREE.MeshBasicMaterial({
      color: 0x7c4a15,
      wireframe: true,
      transparent: true,
      opacity: 0.34,
      depthTest: true,
    });
    this.flexWireframeObject = new THREE.Mesh(
      this.flexGeometry,
      this.flexWireframeMaterial,
    );
    this.flexWireframeObject.name = "pastry_sheet_flexcomp_wireframe";
    this.flexWireframeObject.visible = false;

    const leftSidePie = new THREE.Mesh(this.flexGeometry, this.flexMaterial);
    leftSidePie.name = "pastry_sheet_flexcomp_left";
    leftSidePie.castShadow = true;
    leftSidePie.receiveShadow = true;
    leftSidePie.visible = false;
    const rightSidePie = new THREE.Mesh(this.flexGeometry, this.flexMaterial);
    rightSidePie.name = "pastry_sheet_flexcomp_right";
    rightSidePie.castShadow = true;
    rightSidePie.receiveShadow = true;
    rightSidePie.visible = false;
    this.sidePieMeshes = [leftSidePie, rightSidePie];

    this.doughBlockMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xf3e1b6,
      map: this.rawDoughTextureController.texture,
      roughness: 0.62,
      metalness: 0.0,
      clearcoat: 0.1,
      clearcoatRoughness: 0.56,
      sheen: 0.34,
      sheenRoughness: 0.72,
      sheenColor: new THREE.Color(0xfffaf0),
      side: THREE.DoubleSide,
    });
    this.doughBlockMeshObject = new THREE.Mesh(
      this.doughBlockGeometry,
      this.doughBlockMaterial,
    );
    this.doughBlockMeshObject.name = "dough_block_flexcomp";
    this.doughBlockMeshObject.castShadow = true;
    this.doughBlockMeshObject.receiveShadow = true;
    this.doughBlockMeshObject.visible = false;

    this.doughBlockWireframeObject = new THREE.Mesh(
      this.doughBlockGeometry,
      this.flexWireframeMaterial,
    );
    this.doughBlockWireframeObject.name = "dough_block_flexcomp_wireframe";
    this.doughBlockWireframeObject.visible = false;

    this.doughBlockFlourDisc = new THREE.Mesh(
      new THREE.CircleGeometry(0.056, 36).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0xfbf9f4,
        transparent: true,
        opacity: 0.0,
        depthWrite: false,
      }),
    );
    this.doughBlockFlourDisc.position.set(-0.264, 0.0626, 0.095);

    // Fine T55 bench flour dusting halo around the 12 cm pie tin rim on the marble slab
    this.flourDustingDisc = new THREE.Mesh(
      new THREE.RingGeometry(0.063, 0.135, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0xfbf9f4,
        transparent: true,
        opacity: 0.0,
        depthWrite: false,
      }),
    );
    this.flourDustingDisc.position.set(0, 0.0886, 0);

    // Chilled rich braised beef & pepper / bourguignon filling inside the lined 12 cm tin
    this.fillingDisc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.049, 0.044, 0.012, 36),
      new THREE.MeshStandardMaterial({
        color: 0x4b2313,
        roughness: 0.36,
        metalness: 0.04,
      }),
    );
    this.fillingDisc.position.set(0, 0.068, 0);
    this.fillingDisc.visible = false;

    this.scene.add(
      hemi,
      keyLight,
      rimLight,
      floor,
      counterDeck,
      this.model,
      this.ovenRoot,
      this.flourDustingDisc,
      this.doughBlockFlourDisc,
      this.fillingDisc,
      this.flexMeshObject,
      this.flexWireframeObject,
      this.doughBlockMeshObject,
      this.doughBlockWireframeObject,
      leftSidePie,
      rightSidePie,
    );
    this.host.requestFrame();
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    const [benchGltf, ovenGltf] = await Promise.all([
      loader.loadAsync(pastryBenchGlbUrl),
      loader.loadAsync(maruzenOvenGlbUrl),
    ]);
    if (this.lifecycle === "disposed") {
      benchGltf.scene.traverse(disposePhysicsObject);
      ovenGltf.scene.traverse(disposePhysicsObject);
      return;
    }
    enableSceneShadows(benchGltf.scene);
    enableSceneShadows(ovenGltf.scene);
    this.model.add(benchGltf.scene);
    this.pieTrayNode = benchGltf.scene.getObjectByName("pb_pie_tray") ?? null;

    this.ovenRoot.add(ovenGltf.scene);
    this.ovenVisual = bindOvenVisual(this.ovenRoot);
    // Align chamber halogen glow and doorway steam plume to countertop (`y = 0`) coordinates
    this.ovenVisual.chamberLight.position.set(-0.1, 0.33, 0.02);
    this.ovenVisual.steamGroup.position.set(-0.1, 0.56, 0.36);

    this.lifecycle = "ready";
    if (this.currentFrame !== null) {
      this.applyFrame(this.currentFrame);
    }
    this.host.requestFrame();
  }

  setCameraPreset(preset: PastryBenchCameraPreset): void {
    const next = CAMERA_PRESETS[preset];
    this.host.moveCamera(
      new THREE.Vector3(...next.position),
      new THREE.Vector3(...next.target),
    );
  }

  setWireframeVisible(visible: boolean): void {
    this.showWireframe = visible;
    this.flexWireframeObject.visible = visible && this.flexMeshObject.visible;
    this.doughBlockWireframeObject.visible =
      visible && this.doughBlockMeshObject.visible;
    this.host.requestFrame();
  }

  setFrame(frame: PastryBenchFrame): void {
    if (frame === this.currentFrame) return;
    this.currentFrame = frame;
    this.applyFrame(frame);
    this.host.requestFrame();
  }

  get meshDiagnostics(): Readonly<{
    vertexCount: number;
    triangleCount: number;
    wireframe: boolean;
  }> {
    return {
      vertexCount: this.bufferState.vertexCount,
      triangleCount: this.bufferState.triangleCount,
      wireframe: this.showWireframe,
    };
  }

  private applyFrame(frame: PastryBenchFrame): void {
    this.scene.updateMatrixWorld(true);
    this.model.traverse(
      applyRecordedAppliancePose.bind(null, frame.benchSample),
    );

    const [dx, dy, dz] = frame.carrierOffset;
    if (this.pieTrayNode !== null) {
      this.pieTrayNode.position.x += dx;
      this.pieTrayNode.position.y += dy;
      this.pieTrayNode.position.z += dz;
      this.pieTrayNode.updateMatrixWorld(true);
    }

    // Bench flour visual
    this.flourDustingDisc.material.opacity = frame.benchFloured ? 0.44 : 0.0;
    this.doughBlockFlourDisc.material.opacity = frame.benchFloured ? 0.42 : 0.0;

    // Show chilled braised filling inside the 12 cm lined tin while draping the puff lid
    this.fillingDisc.visible =
      frame.phase === "puff-lid" && frame.sealCoveragePct < 85;
    this.fillingDisc.position.set(dx, 0.068 + dy, dz);

    // Update procedural pastry crust browning + egg-wash glaze
    const glaze =
      frame.phase === "puff-lid" || frame.phase === "oven-bake" ? 1.0 : 0.0;
    this.pastryTextureController.update(frame.crustBrowning, glaze);

    if (frame.phase === "oven-bake") {
      this.flexMaterial.color.setHex(0xffffff);
      this.flexMaterial.clearcoat = 0.26 + frame.crustBrowning * 0.16;
      this.flexMaterial.roughness = 0.56 - frame.crustBrowning * 0.18;
      this.flexMaterial.emissive.setHex(0xb45309);
      this.flexMaterial.emissiveIntensity =
        frame.ovenDoorOpenRatio < 0.25 ? 0.14 * frame.crustBrowning : 0.04;
      this.flexWireframeMaterial.opacity = 0.24;
    } else if (frame.phase === "puff-lid") {
      this.flexMaterial.color.setHex(0xfaf0d7);
      this.flexMaterial.clearcoat = 0.26;
      this.flexMaterial.roughness = 0.56;
      this.flexMaterial.emissiveIntensity = 0.0;
      this.flexWireframeMaterial.opacity = 0.34;
    } else if (frame.phase === "rejected-unfloured") {
      this.flexMaterial.color.setHex(0xe7cfa0);
      this.flexMaterial.clearcoat = 0.06;
      this.flexMaterial.roughness = 0.68;
      this.flexMaterial.emissiveIntensity = 0.0;
      this.flexWireframeMaterial.opacity = 0.34;
    } else {
      this.flexMaterial.color.setHex(0xf3e1b6);
      this.flexMaterial.clearcoat = 0.14;
      this.flexMaterial.roughness = 0.62;
      this.flexMaterial.emissiveIntensity = 0.0;
      this.flexWireframeMaterial.opacity = 0.34;
    }

    if (this.ovenVisual !== null) {
      updateOvenVisual(
        this.ovenVisual,
        frame.ovenState,
        frame.ovenDoorOpenRatio,
        frame.timeS,
        false,
      );
    }

    if (frame.doughBlockMesh !== null) {
      updateDeformablePastryBufferGeometry(
        this.doughBlockGeometry,
        this.doughBlockBufferState,
        frame.doughBlockMesh,
        0,
      );
      this.doughBlockMeshObject.visible = true;
      this.doughBlockWireframeObject.visible = this.showWireframe;
    } else {
      this.doughBlockMeshObject.visible = false;
      this.doughBlockWireframeObject.visible = false;
    }

    if (frame.flexMesh !== null && frame.phase !== "dough-press") {
      updateDeformablePastryBufferGeometry(
        this.flexGeometry,
        this.bufferState,
        frame.flexMesh,
        frame.puffLiftMm,
      );
      this.flexMeshObject.position.set(dx, dy, dz);
      this.flexWireframeObject.position.set(dx, dy, dz);
      this.flexMeshObject.visible = true;
      this.flexWireframeObject.visible = this.showWireframe;
      const showFullTrayPies = frame.phase === "oven-bake";
      this.sidePieMeshes[0].position.set(dx - 0.136, dy, dz);
      this.sidePieMeshes[1].position.set(dx + 0.136, dy, dz);
      this.sidePieMeshes[0].visible = showFullTrayPies;
      this.sidePieMeshes[1].visible = showFullTrayPies;
    } else {
      this.flexMeshObject.visible = false;
      this.flexWireframeObject.visible = false;
      this.sidePieMeshes[0].visible = false;
      this.sidePieMeshes[1].visible = false;
    }
  }

  /** The oven glow follows the wall clock in each drawn frame. */
  private step(now: number): boolean {
    if (this.ovenVisual !== null && this.currentFrame !== null) {
      updateOvenVisual(
        this.ovenVisual,
        this.currentFrame.ovenState,
        this.currentFrame.ovenDoorOpenRatio,
        now / 1000,
        false,
      );
    }
    return false;
  }

  dispose(): void {
    this.lifecycle = "disposed";
    this.pastryTextureController.dispose();
    this.rawDoughTextureController.dispose();
    this.flexGeometry.dispose();
    this.doughBlockGeometry.dispose();
    this.flexMaterial.dispose();
    this.doughBlockMaterial.dispose();
    this.flexWireframeMaterial.dispose();
    this.host.dispose();
  }
}
