import React from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { Select } from "../ui";
import { usePortalTheme } from "../use-portal-theme";
import "../styles.css";
import "./appliances-preview.css";
import {
  APPLIANCE_CATALOG,
  type ApplianceEntry,
  type ApplianceStation,
  type JointControlSpec,
} from "./appliances-preview-catalog";

type ViewMode = "lab" | "lineup" | "sheet";
type CameraPreset = "studio" | "front" | "right" | "back" | "top";
type StationFilter = "all" | ApplianceStation;

type MeasuredBoundsMm = Readonly<{
  widthMm: number;
  depthMm: number;
  heightMm: number;
}>;

type ControlledBodyCache = Readonly<{
  object: THREE.Object3D;
  restPos: THREE.Vector3;
  restQuat: THREE.Quaternion;
}>;

type LightboxState = Readonly<{
  applianceTitle: string;
  renders: ApplianceEntry["renders"];
  index: number;
}>;

const STATION_ITEMS: readonly { value: StationFilter; label: string }[] = [
  { value: "all", label: `All Stations (${APPLIANCE_CATALOG.length})` },
  {
    value: "Bakery & Hot Line",
    label: `Bakery & Hot Line (${APPLIANCE_CATALOG.filter((a) => a.station === "Bakery & Hot Line").length})`,
  },
  {
    value: "Espresso & Cold Chain",
    label: `Espresso & Cold Chain (${APPLIANCE_CATALOG.filter((a) => a.station === "Espresso & Cold Chain").length})`,
  },
  {
    value: "Wash & Hygiene Station",
    label: `Wash & Hygiene Station (${APPLIANCE_CATALOG.filter((a) => a.station === "Wash & Hygiene Station").length})`,
  },
  {
    value: "Square Point of Sale",
    label: `Square Point of Sale (${APPLIANCE_CATALOG.filter((a) => a.station === "Square Point of Sale").length})`,
  },
];

const sharedGltfLoader = new GLTFLoader();
const templatePromiseCache = new Map<string, Promise<THREE.Group>>();

function loadTemplateScene(glbUrl: string): Promise<THREE.Group> {
  const existing = templatePromiseCache.get(glbUrl);
  if (existing !== undefined) return existing;
  const pending = sharedGltfLoader.loadAsync(glbUrl).then((gltf) => gltf.scene);
  templatePromiseCache.set(glbUrl, pending);
  return pending;
}

function cloneSceneWithOwnMaterials(template: THREE.Group): {
  root: THREE.Group;
  clonedMaterials: THREE.Material[];
} {
  const root = template.clone(true);
  const clonedMaterials: THREE.Material[] = [];
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (Array.isArray(obj.material)) {
      const next = obj.material.map((mat: THREE.Material) => {
        const c = mat.clone();
        clonedMaterials.push(c);
        return c;
      });
      obj.material = next;
    } else if (obj.material instanceof THREE.Material) {
      const c = obj.material.clone();
      clonedMaterials.push(c);
      obj.material = c;
    }
  });
  return { root, clonedMaterials };
}

function setWireframeOnMaterials(
  materials: readonly THREE.Material[],
  enabled: boolean,
): void {
  for (const mat of materials) {
    if ("wireframe" in mat && typeof mat.wireframe === "boolean") {
      mat.wireframe = enabled;
    }
  }
}

function buildControlledBodies(
  root: THREE.Object3D,
  joints: readonly JointControlSpec[],
): Map<string, ControlledBodyCache> {
  const map = new Map<string, ControlledBodyCache>();
  for (const joint of joints) {
    if (map.has(joint.body)) continue;
    const object = root.getObjectByName(joint.body);
    if (object === undefined) continue;
    map.set(joint.body, {
      object,
      restPos: object.position.clone(),
      restQuat: object.quaternion.clone(),
    });
  }
  return map;
}

function applyJointValuesToModel(
  controlledBodies: ReadonlyMap<string, ControlledBodyCache>,
  joints: readonly JointControlSpec[],
  values: Readonly<Record<string, number>>,
): void {
  for (const entry of controlledBodies.values()) {
    entry.object.position.copy(entry.restPos);
    entry.object.quaternion.copy(entry.restQuat);
  }
  for (const joint of joints) {
    const target = controlledBodies.get(joint.body);
    if (target === undefined) continue;
    const val = values[joint.id] ?? 0;
    if (Math.abs(val) < 1e-9) continue;
    const [vx, vy, vz] = joint.visualAxis;
    const axis = new THREE.Vector3(vx, vz, -vy).normalize();
    if (joint.kind === "slide") {
      target.object.position.addScaledVector(axis, val);
    } else {
      target.object.rotateOnAxis(axis, val);
    }
  }
}

function parseInitialUrlState(): {
  selectedId: string;
  viewMode: ViewMode;
} {
  const params = new URLSearchParams(window.location.search);
  const rawAppliance = params.get("appliance");
  const matched = APPLIANCE_CATALOG.find((a) => a.id === rawAppliance);
  const firstEntry = APPLIANCE_CATALOG[0];
  const selectedId = matched?.id ?? firstEntry?.id ?? "maruzen-mbco-4me";
  const rawView = params.get("view");
  const viewMode: ViewMode =
    rawView === "lineup" || rawView === "sheet" || rawView === "lab"
      ? rawView
      : "lab";
  return { selectedId, viewMode };
}

function syncUrlState(selectedId: string, viewMode: ViewMode): void {
  const url = new URL(window.location.href);
  url.searchParams.set("appliance", selectedId);
  url.searchParams.set("view", viewMode);
  window.history.replaceState(null, "", url.toString());
}

function formatJointValue(joint: JointControlSpec, value: number): string {
  if (joint.kind === "slide") {
    return `${(value * 1000).toFixed(1)} mm`;
  }
  const deg = (value * 180) / Math.PI;
  return `${deg.toFixed(1)}° (${value.toFixed(2)} rad)`;
}

function buildOpenPoseValues(
  joints: readonly JointControlSpec[],
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const joint of joints) {
    if (joint.continuousSpinSpeedRadPerSec !== undefined) {
      next[joint.id] = 0.85;
      continue;
    }
    const span = joint.max - joint.min;
    if (joint.min < 0 && joint.max > 0) {
      next[joint.id] = Number((joint.max * 0.65).toFixed(4));
    } else {
      next[joint.id] = Number((joint.min + span * 0.72).toFixed(4));
    }
  }
  return next;
}

type ViewportProps = Readonly<{
  viewMode: "lab" | "lineup";
  theme: "light" | "dark";
  selected: ApplianceEntry;
  jointValues: Readonly<Record<string, number>>;
  onJointValuesFrame?: (next: Record<string, number>) => void;
  demoPlaying: boolean;
  showBounds: boolean;
  showWireframe: boolean;
  showGrid: boolean;
  cameraRequest: Readonly<{ preset: CameraPreset; seq: number }>;
  onMeasuredBounds: (bounds: MeasuredBoundsMm | null) => void;
  onSelectFromLineup: (id: string, openLab: boolean) => void;
}>;

function ApplianceWebGLViewport({
  viewMode,
  theme,
  selected,
  jointValues,
  onJointValuesFrame,
  demoPlaying,
  showBounds,
  showWireframe,
  showGrid,
  cameraRequest,
  onMeasuredBounds,
  onSelectFromLineup,
}: ViewportProps): React.ReactElement {
  const mountRef = React.useRef<HTMLDivElement | null>(null);
  const [loadStatus, setLoadStatus] = React.useState<string>("Loading 3D…");

  const jointValuesRef = React.useRef<Readonly<Record<string, number>>>(
    jointValues,
  );
  jointValuesRef.current = jointValues;

  const demoPlayingRef = React.useRef<boolean>(demoPlaying);
  demoPlayingRef.current = demoPlaying;

  const onJointValuesFrameRef = React.useRef(onJointValuesFrame);
  onJointValuesFrameRef.current = onJointValuesFrame;

  const onSelectFromLineupRef = React.useRef(onSelectFromLineup);
  onSelectFromLineupRef.current = onSelectFromLineup;

  const selectedIdRef = React.useRef<string>(selected.id);
  selectedIdRef.current = selected.id;

  const sceneHandlesRef = React.useRef<{
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    gridGroup: THREE.Group;
    boundsGroup: THREE.Group;
    materials: THREE.Material[];
    focusRadius: number;
    focusCenter: THREE.Vector3;
    lineupWrappers: Map<string, THREE.Object3D>;
    selectionRing: THREE.Mesh;
  } | null>(null);

  const applyCameraPreset = React.useCallback(
    (
      camera: THREE.PerspectiveCamera,
      controls: OrbitControls,
      preset: CameraPreset,
      center: THREE.Vector3,
      radius: number,
    ) => {
      const dist = Math.max(radius * 2.35, 0.36);
      controls.target.copy(center);
      if (preset === "front") {
        camera.position.set(center.x, center.y + dist * 0.14, center.z + dist);
      } else if (preset === "right") {
        camera.position.set(center.x + dist, center.y + dist * 0.14, center.z);
      } else if (preset === "back") {
        camera.position.set(center.x, center.y + dist * 0.16, center.z - dist);
      } else if (preset === "top") {
        camera.position.set(
          center.x,
          center.y + dist * 1.25,
          center.z + Math.max(dist * 0.04, 0.01),
        );
      } else {
        camera.position.set(
          center.x + dist * 0.68,
          center.y + dist * 0.48,
          center.z + dist * 0.82,
        );
      }
      camera.near = Math.max(radius * 0.01, 0.004);
      camera.far = Math.max(dist * 25, 40);
      camera.updateProjectionMatrix();
      controls.update();
    },
    [],
  );

  // Core WebGL setup & model loading per (viewMode, selected.id in lab mode)
  const activeLoadKey =
    viewMode === "lineup"
      ? `lineup-all-${APPLIANCE_CATALOG.length}`
      : selected.id;

  React.useEffect(() => {
    const container = mountRef.current;
    if (container === null) return undefined;

    let disposed = false;
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;

    const initW = Math.max(container.clientWidth, 320);
    const initH = Math.max(container.clientHeight, 480);
    renderer.setSize(initW, initH, false);
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envTarget = pmrem.fromScene(roomEnv, 0.04);
    scene.environment = envTarget.texture;
    roomEnv.dispose();

    const keyLight = new THREE.DirectionalLight(0xfffaf2, 1.45);
    keyLight.position.set(2.8, 4.2, 3.4);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xeef4ff, 0.72);
    fillLight.position.set(-3.1, 2.4, 2.2);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffffff, 0.55);
    rimLight.position.set(0.4, 2.8, -3.5);
    scene.add(rimLight);

    const camera = new THREE.PerspectiveCamera(38, initW / initH, 0.005, 80);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.52;

    const gridGroup = new THREE.Group();
    const gridSize = viewMode === "lineup" ? 9.0 : 2.0;
    const gridDivisions = viewMode === "lineup" ? 90 : 20;
    const minorGrid = new THREE.GridHelper(
      gridSize,
      gridDivisions,
      0x7c8594,
      0x9aa3b2,
    );
    if (minorGrid.material instanceof THREE.Material) {
      minorGrid.material.transparent = true;
      minorGrid.material.opacity = 0.24;
    }
    gridGroup.add(minorGrid);
    gridGroup.visible = showGrid;
    scene.add(gridGroup);

    const contentGroup = new THREE.Group();
    scene.add(contentGroup);

    const boundsGroup = new THREE.Group();
    boundsGroup.visible = showBounds;
    scene.add(boundsGroup);

    const ringGeom = new THREE.RingGeometry(0.28, 0.315, 48);
    ringGeom.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x16a34a,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
    });
    const selectionRing = new THREE.Mesh(ringGeom, ringMat);
    selectionRing.position.y = 0.002;
    selectionRing.visible = false;
    scene.add(selectionRing);

    const handles = {
      camera,
      controls,
      gridGroup,
      boundsGroup,
      materials: [] as THREE.Material[],
      focusRadius: viewMode === "lineup" ? 2.8 : 0.45,
      focusCenter: new THREE.Vector3(0, 0.3, 0),
      lineupWrappers: new Map<string, THREE.Object3D>(),
      selectionRing,
    };
    sceneHandlesRef.current = handles;

    let labControlledBodies = new Map<string, ControlledBodyCache>();
    let labWrapper: THREE.Group | null = null;
    let labBoxHelper: THREE.Box3Helper | null = null;
    const labLiveBox = new THREE.Box3();

    if (viewMode === "lab") {
      setLoadStatus(`Loading ${selected.sku}…`);
      onMeasuredBounds(null);
      void loadTemplateScene(selected.glbUrl)
        .then((template) => {
          if (disposed) return;
          const { root, clonedMaterials } =
            cloneSceneWithOwnMaterials(template);
          handles.materials.push(...clonedMaterials);
          setWireframeOnMaterials(clonedMaterials, showWireframe);

          root.updateMatrixWorld(true);
          const restBox = new THREE.Box3().setFromObject(root);
          const restSize = restBox.getSize(new THREE.Vector3());
          const restCenter = restBox.getCenter(new THREE.Vector3());

          onMeasuredBounds({
            widthMm: Math.round(restSize.x * 1000),
            depthMm: Math.round(restSize.z * 1000),
            heightMm: Math.round(restSize.y * 1000),
          });

          const wrapper = new THREE.Group();
          root.position.set(-restCenter.x, -restBox.min.y, -restCenter.z);
          wrapper.add(root);
          contentGroup.add(wrapper);
          labWrapper = wrapper;

          labControlledBodies = buildControlledBodies(root, selected.joints);
          applyJointValuesToModel(
            labControlledBodies,
            selected.joints,
            jointValuesRef.current,
          );

          wrapper.updateMatrixWorld(true);
          labLiveBox.setFromObject(wrapper);
          labBoxHelper = new THREE.Box3Helper(
            labLiveBox,
            new THREE.Color(0x0ea5e9),
          );
          boundsGroup.add(labBoxHelper);

          const sphere = restBox.getBoundingSphere(new THREE.Sphere());
          handles.focusRadius = Math.max(sphere.radius, 0.14);
          handles.focusCenter.set(0, restSize.y * 0.48, 0);
          applyCameraPreset(
            camera,
            controls,
            "studio",
            handles.focusCenter,
            handles.focusRadius,
          );
          setLoadStatus("Ready");
        })
        .catch((err: unknown) => {
          if (disposed) return;
          setLoadStatus(
            `Load error: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } else {
      onMeasuredBounds(null);
      let loadedCount = 0;
      setLoadStatus(`Loading 0 / ${APPLIANCE_CATALOG.length} appliances…`);
      handles.focusRadius = 4.35;
      handles.focusCenter.set(-0.15, 0.42, 0.0);
      applyCameraPreset(
        camera,
        controls,
        "studio",
        handles.focusCenter,
        handles.focusRadius,
      );

      for (const entry of APPLIANCE_CATALOG) {
        void loadTemplateScene(entry.glbUrl)
          .then((template) => {
            if (disposed) return;
            const { root, clonedMaterials } =
              cloneSceneWithOwnMaterials(template);
            handles.materials.push(...clonedMaterials);
            setWireframeOnMaterials(clonedMaterials, showWireframe);

            root.updateMatrixWorld(true);
            const restBox = new THREE.Box3().setFromObject(root);
            const restCenter = restBox.getCenter(new THREE.Vector3());
            const restSize = restBox.getSize(new THREE.Vector3());

            const wrapper = new THREE.Group();
            wrapper.userData = {
              applianceId: entry.id,
              footprintRadius: Math.max(restSize.x, restSize.z) * 0.58 + 0.06,
            };
            root.position.set(-restCenter.x, -restBox.min.y, -restCenter.z);
            wrapper.position.set(
              entry.lineupPositionM[0],
              0,
              entry.lineupPositionM[1],
            );
            wrapper.add(root);
            contentGroup.add(wrapper);
            handles.lineupWrappers.set(entry.id, wrapper);

            wrapper.updateMatrixWorld(true);
            const worldBox = new THREE.Box3().setFromObject(wrapper);
            const helper = new THREE.Box3Helper(
              worldBox,
              new THREE.Color(0x0ea5e9),
            );
            boundsGroup.add(helper);

            if (entry.id === selectedIdRef.current) {
              const r =
                typeof wrapper.userData.footprintRadius === "number"
                  ? wrapper.userData.footprintRadius
                  : 0.35;
              selectionRing.position.set(
                wrapper.position.x,
                0.003,
                wrapper.position.z,
              );
              selectionRing.scale.setScalar(r / 0.3);
              selectionRing.visible = true;
            }

            loadedCount += 1;
            setLoadStatus(
              loadedCount === APPLIANCE_CATALOG.length
                ? `All ${APPLIANCE_CATALOG.length} appliances at 1:1 scale`
                : `Loading ${loadedCount} / ${APPLIANCE_CATALOG.length} appliances…`,
            );
          })
          .catch(() => {
            // Keep remaining lineup appliances visible on individual load failure.
          });
      }
    }

    // Raycast click & double-click selection in 1:1 Scale Lineup mode
    const raycaster = new THREE.Raycaster();
    const pointerDownPos = new THREE.Vector2();

    function pickLineupAppliance(clientX: number, clientY: number): string | null {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(contentGroup.children, true);
      for (const hit of hits) {
        let cur: THREE.Object3D | null = hit.object;
        while (cur !== null) {
          const id: unknown = cur.userData?.applianceId;
          if (typeof id === "string") return id;
          cur = cur.parent;
        }
      }
      return null;
    }

    const onPointerDown = (ev: PointerEvent): void => {
      pointerDownPos.set(ev.clientX, ev.clientY);
    };

    const onPointerUp = (ev: PointerEvent): void => {
      if (viewMode !== "lineup") return;
      if (
        Math.hypot(
          ev.clientX - pointerDownPos.x,
          ev.clientY - pointerDownPos.y,
        ) > 5
      ) {
        return;
      }
      const hitId = pickLineupAppliance(ev.clientX, ev.clientY);
      if (hitId !== null) {
        onSelectFromLineupRef.current(hitId, false);
      }
    };

    const onDoubleClick = (ev: MouseEvent): void => {
      if (viewMode !== "lineup") return;
      const hitId = pickLineupAppliance(ev.clientX, ev.clientY);
      if (hitId !== null) {
        onSelectFromLineupRef.current(hitId, true);
      }
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("dblclick", onDoubleClick);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const w = Math.max(Math.floor(entry.contentRect.width), 1);
      const h = Math.max(Math.floor(entry.contentRect.height), 1);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    });
    resizeObserver.observe(container);

    let rafId = 0;
    const startClock = performance.now();
    let lastSliderSyncMs = 0;

    const animate = (nowMs: number): void => {
      if (disposed) return;
      rafId = window.requestAnimationFrame(animate);

      if (viewMode === "lab" && labControlledBodies.size > 0) {
        if (demoPlayingRef.current) {
          const t = (nowMs - startClock) * 0.001;
          const animated: Record<string, number> = {};
          selected.joints.forEach((joint, idx) => {
            if (joint.continuousSpinSpeedRadPerSec !== undefined) {
              const raw = (t * joint.continuousSpinSpeedRadPerSec) % (Math.PI * 2);
              const wrapped = raw > Math.PI ? raw - Math.PI * 2 : raw;
              animated[joint.id] = Number(wrapped.toFixed(4));
            } else {
              const wave = 0.5 - 0.5 * Math.cos(t * 1.45 + idx * 0.7);
              const val = joint.min + (joint.max - joint.min) * wave;
              animated[joint.id] = Number(val.toFixed(4));
            }
          });
          applyJointValuesToModel(
            labControlledBodies,
            selected.joints,
            animated,
          );
          if (nowMs - lastSliderSyncMs > 65) {
            lastSliderSyncMs = nowMs;
            onJointValuesFrameRef.current?.(animated);
          }
        } else {
          applyJointValuesToModel(
            labControlledBodies,
            selected.joints,
            jointValuesRef.current,
          );
        }

        if (labWrapper !== null && labBoxHelper !== null && boundsGroup.visible) {
          labWrapper.updateMatrixWorld(true);
          labLiveBox.setFromObject(labWrapper);
        }
      }

      controls.update();
      renderer.render(scene, camera);
    };
    rafId = window.requestAnimationFrame(animate);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("dblclick", onDoubleClick);
      controls.dispose();
      ringGeom.dispose();
      ringMat.dispose();
      minorGrid.geometry.dispose();
      if (minorGrid.material instanceof THREE.Material) {
        minorGrid.material.dispose();
      }
      for (const mat of handles.materials) {
        mat.dispose();
      }
      envTarget.dispose();
      pmrem.dispose();
      renderer.dispose();
      sceneHandlesRef.current = null;
    };
  }, [activeLoadKey, viewMode, applyCameraPreset, onMeasuredBounds]);

  // Sync visual toggles, lineup selection ring, and camera preset clicks
  React.useEffect(() => {
    const handles = sceneHandlesRef.current;
    if (handles === null) return;
    handles.gridGroup.visible = showGrid;
    handles.boundsGroup.visible = showBounds;
    setWireframeOnMaterials(handles.materials, showWireframe);
  }, [activeLoadKey, showGrid, showBounds, showWireframe, theme]);

  React.useEffect(() => {
    const handles = sceneHandlesRef.current;
    if (handles === null || viewMode !== "lineup") return;
    const wrapper = handles.lineupWrappers.get(selected.id);
    if (wrapper !== undefined) {
      const r =
        typeof wrapper.userData.footprintRadius === "number"
          ? wrapper.userData.footprintRadius
          : 0.35;
      handles.selectionRing.position.set(
        wrapper.position.x,
        0.003,
        wrapper.position.z,
      );
      handles.selectionRing.scale.setScalar(r / 0.3);
      handles.selectionRing.visible = true;
    }
  }, [selected.id, viewMode]);

  React.useEffect(() => {
    if (cameraRequest.seq === 0) return;
    const handles = sceneHandlesRef.current;
    if (handles === null) return;
    applyCameraPreset(
      handles.camera,
      handles.controls,
      cameraRequest.preset,
      handles.focusCenter,
      handles.focusRadius,
    );
  }, [cameraRequest, applyCameraPreset]);

  return (
    <div className="appliances-canvas-mount" ref={mountRef} data-status={loadStatus} />
  );
}

function StudioSheetCard({
  entry,
  onInspectIn3D,
  onOpenLightbox,
}: Readonly<{
  entry: ApplianceEntry;
  onInspectIn3D: (id: string) => void;
  onOpenLightbox: (entry: ApplianceEntry, index: number) => void;
}>): React.ReactElement {
  const [angleIdx, setAngleIdx] = React.useState<number>(0);
  const activeRender = entry.renders[angleIdx] ?? entry.renders[0];

  return (
    <article className="appliances-sheet-card">
      <div className="appliances-sheet-media">
        {activeRender !== undefined ? (
          <img
            className="appliances-sheet-img"
            src={activeRender.url}
            alt={`${entry.title} — ${activeRender.label}`}
            loading="lazy"
            onClick={() => onOpenLightbox(entry, angleIdx)}
          />
        ) : null}
        <div className="appliances-sheet-angles">
          {entry.renders.map((render, idx) => (
            <button
              key={render.label}
              type="button"
              className="appliances-angle-chip"
              data-active={idx === angleIdx}
              onClick={() => setAngleIdx(idx)}
            >
              {render.label}
            </button>
          ))}
        </div>
      </div>

      <div className="appliances-sheet-body">
        <div className="appliances-sheet-head">
          <div>
            <h2 className="appliances-sheet-title">{entry.title}</h2>
            <div className="appliances-sheet-sub">
              {entry.manufacturer} · {entry.sku} · {entry.station}
            </div>
          </div>
          <span
            className={
              entry.isNewPackage
                ? "appliances-badge"
                : "appliances-badge appliances-badge-neutral"
            }
          >
            {entry.isNewPackage ? "New" : "Ref"}
          </span>
        </div>

        <div className="appliances-sheet-metrics">
          <span className="appliances-sheet-metric">
            {entry.envelopeMm[0]} × {entry.envelopeMm[1]} × {entry.envelopeMm[2]} mm
          </span>
          <span className="appliances-sheet-metric">{entry.massKg} kg</span>
          <span className="appliances-sheet-metric">
            {entry.joints.length} controls
          </span>
          <span className="appliances-sheet-metric">
            Δpos ≤ {entry.maxPosErrNm} nm
          </span>
        </div>

        <div className="appliances-sheet-sub">{entry.utilitySummary}</div>

        <div className="appliances-sheet-footer">
          <span className="appliances-rail-dims">
            {entry.r2Documents.length} R2 spec{" "}
            {entry.r2Documents.length === 1 ? "file" : "files"}
          </span>
          <button
            type="button"
            className="appliances-btn appliances-btn-primary"
            onClick={() => onInspectIn3D(entry.id)}
          >
            Inspect in 3D Lab
          </button>
        </div>
      </div>
    </article>
  );
}

function AppliancesPreviewApp(): React.ReactElement {
  const { theme, toggleTheme } = usePortalTheme();
  const initial = React.useMemo(parseInitialUrlState, []);

  const [viewMode, setViewMode] = React.useState<ViewMode>(initial.viewMode);
  const [stationFilter, setStationFilter] =
    React.useState<StationFilter>("all");
  const [selectedId, setSelectedId] = React.useState<string>(
    initial.selectedId,
  );
  const [jointValues, setJointValues] = React.useState<Record<string, number>>(
    {},
  );
  const [demoPlaying, setDemoPlaying] = React.useState<boolean>(false);
  const [showBounds, setShowBounds] = React.useState<boolean>(false);
  const [showWireframe, setShowWireframe] = React.useState<boolean>(false);
  const [showGrid, setShowGrid] = React.useState<boolean>(true);
  const [cameraRequest, setCameraRequest] = React.useState<{
    preset: CameraPreset;
    seq: number;
  }>({ preset: "studio", seq: 0 });
  const [measuredBounds, setMeasuredBounds] =
    React.useState<MeasuredBoundsMm | null>(null);
  const [lightbox, setLightbox] = React.useState<LightboxState | null>(null);

  const filteredCatalog = React.useMemo(
    () =>
      stationFilter === "all"
        ? APPLIANCE_CATALOG
        : APPLIANCE_CATALOG.filter((a) => a.station === stationFilter),
    [stationFilter],
  );

  const selected = React.useMemo<ApplianceEntry>(() => {
    const found = APPLIANCE_CATALOG.find((a) => a.id === selectedId);
    if (found !== undefined) return found;
    return APPLIANCE_CATALOG[0]!;
  }, [selectedId]);

  const modelSelectItems = React.useMemo(
    () =>
      filteredCatalog.map((entry) => ({
        value: entry.id,
        label: `${entry.sku} — ${entry.title}`,
      })),
    [filteredCatalog],
  );

  const selectAppliance = React.useCallback((id: string) => {
    setSelectedId(id);
    setJointValues({});
    setDemoPlaying(false);
  }, []);

  React.useEffect(() => {
    syncUrlState(selected.id, viewMode);
  }, [selected.id, viewMode]);

  // Lightbox keyboard navigation
  React.useEffect(() => {
    if (lightbox === null) return undefined;
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") {
        setLightbox(null);
      } else if (ev.key === "ArrowRight") {
        setLightbox((prev) =>
          prev === null
            ? null
            : { ...prev, index: (prev.index + 1) % prev.renders.length },
        );
      } else if (ev.key === "ArrowLeft") {
        setLightbox((prev) =>
          prev === null
            ? null
            : {
                ...prev,
                index:
                  (prev.index - 1 + prev.renders.length) % prev.renders.length,
              },
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightbox]);

  const requestCamera = (preset: CameraPreset): void => {
    setCameraRequest((prev) => ({ preset, seq: prev.seq + 1 }));
  };

  const handleStationChange = (next: StationFilter | null): void => {
    const resolved: StationFilter = next ?? "all";
    setStationFilter(resolved);
    if (resolved !== "all" && selected.station !== resolved) {
      const firstInStation = APPLIANCE_CATALOG.find(
        (a) => a.station === resolved,
      );
      if (firstInStation !== undefined) {
        selectAppliance(firstInStation.id);
      }
    }
  };

  const activeLightboxRender =
    lightbox !== null ? lightbox.renders[lightbox.index] : undefined;

  return (
    <div
      className="appliances-shell"
      data-locked-viewport={viewMode !== "sheet"}
    >
      <header className="appliances-topbar">
        <div className="appliances-brand">
          <span className="appliances-brand-mark" aria-hidden="true">
            SK
          </span>
          <div className="appliances-brand-text">
            <h1 className="appliances-title">
              Kitchen — {APPLIANCE_CATALOG.length} Appliances Inspector
            </h1>
            <span className="appliances-subtitle">
              Complete Kitchen fleet · Blender 5.2 PBR + MuJoCo 3.13
              physics parity
            </span>
          </div>
        </div>

        <nav className="appliances-mode-tabs" aria-label="Inspection view mode">
          <button
            type="button"
            className="appliances-mode-tab"
            data-active={viewMode === "lab"}
            onClick={() => setViewMode("lab")}
          >
            Single 3D Lab
          </button>
          <button
            type="button"
            className="appliances-mode-tab"
            data-active={viewMode === "lineup"}
            onClick={() => {
              setDemoPlaying(false);
              setViewMode("lineup");
            }}
          >
            All {APPLIANCE_CATALOG.length} Scale Lineup (3D)
          </button>
          <button
            type="button"
            className="appliances-mode-tab"
            data-active={viewMode === "sheet"}
            onClick={() => {
              setDemoPlaying(false);
              setViewMode("sheet");
            }}
          >
            All {APPLIANCE_CATALOG.length} Studio Sheet
          </button>
        </nav>

        <div className="appliances-toolbar-right">
          <Select.Root
            name="station-filter"
            items={STATION_ITEMS}
            value={stationFilter}
            onValueChange={handleStationChange}
          >
            <Select.Trigger
              size="sm"
              aria-label="Filter by station"
              className="appliances-select-station"
            >
              <Select.Value placeholder="All Stations" />
            </Select.Trigger>
            <Select.Popup alignItemWithTrigger={false} align="end">
              {STATION_ITEMS.map((item) => (
                <Select.Item key={item.value} value={item.value}>
                  {item.label}
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Root>

          <Select.Root
            name="appliance-picker"
            items={modelSelectItems}
            value={selected.id}
            onValueChange={(val) => {
              if (typeof val === "string") selectAppliance(val);
            }}
          >
            <Select.Trigger
              size="sm"
              aria-label="Choose appliance"
              className="appliances-select-model"
            >
              <Select.Value placeholder="Choose appliance" />
            </Select.Trigger>
            <Select.Popup alignItemWithTrigger={false} align="end">
              {modelSelectItems.map((item) => (
                <Select.Item key={item.value} value={item.value}>
                  {item.label}
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Root>

          <button
            type="button"
            className="appliances-btn"
            onClick={toggleTheme}
            aria-label="Toggle color theme"
          >
            {theme === "dark" ? "Light Theme" : "Dark Theme"}
          </button>
        </div>
      </header>

      {viewMode === "sheet" ? (
        <main className="appliances-sheet-wrap">
          <div className="appliances-sheet-summary">
            <div>
              <h2 className="appliances-stage-heading">
                Cycles Studio Render Contact Sheet ({filteredCatalog.length}{" "}
                {filteredCatalog.length === 1 ? "appliance" : "appliances"})
              </h2>
              <span className="appliances-stage-sub">
                Switch camera angles on any card, click an image for full-res zoom,
                or open any unit in the interactive 3D Lab.
              </span>
            </div>
            <button
              type="button"
              className="appliances-btn appliances-btn-primary"
              onClick={() => setViewMode("lineup")}
            >
              View All {APPLIANCE_CATALOG.length} in 1:1 3D Scale Lineup
            </button>
          </div>

          <div className="appliances-sheet-grid">
            {filteredCatalog.map((entry) => (
              <StudioSheetCard
                key={entry.id}
                entry={entry}
                onInspectIn3D={(id) => {
                  selectAppliance(id);
                  setViewMode("lab");
                }}
                onOpenLightbox={(target, index) =>
                  setLightbox({
                    applianceTitle: target.title,
                    renders: target.renders,
                    index,
                  })
                }
              />
            ))}
          </div>
        </main>
      ) : (
        <main className="appliances-workspace">
          <aside className="appliances-rail" aria-label="Appliance list">
            <div className="appliances-rail-header">
              <span>Appliances ({filteredCatalog.length})</span>
              <span>W × D × H</span>
            </div>
            <div className="appliances-rail-list">
              {filteredCatalog.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="appliances-rail-item"
                  data-selected={entry.id === selected.id}
                  onClick={() => selectAppliance(entry.id)}
                >
                  <img
                    className="appliances-rail-thumb"
                    src={entry.heroRenderUrl}
                    alt={entry.title}
                    loading="lazy"
                  />
                  <div className="appliances-rail-meta">
                    <div className="appliances-rail-row">
                      <span className="appliances-rail-sku">{entry.sku}</span>
                      <span
                        className={
                          entry.isNewPackage
                            ? "appliances-badge"
                            : "appliances-badge appliances-badge-neutral"
                        }
                      >
                        {entry.isNewPackage ? "New" : "Ref"}
                      </span>
                    </div>
                    <span className="appliances-rail-title">{entry.title}</span>
                    <span className="appliances-rail-dims">
                      {entry.envelopeMm[0]}×{entry.envelopeMm[1]}×
                      {entry.envelopeMm[2]} mm · {entry.massKg} kg
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <section className="appliances-stage-column" aria-label="3D WebGL viewport">
            <div className="appliances-stage-top-hud">
              <div className="appliances-stage-card">
                <div className="appliances-stage-kicker">
                  <span>{selected.station}</span>
                  <span>·</span>
                  <span>{selected.manufacturer}</span>
                  <span>·</span>
                  <span>{selected.sku}</span>
                </div>
                <h2 className="appliances-stage-heading">
                  {viewMode === "lineup"
                    ? `1:1 Scale Floor Lineup — Selected: ${selected.title}`
                    : selected.title}
                </h2>
                <div className="appliances-stage-sub">
                  {viewMode === "lineup"
                    ? "Click any appliance on the 100 mm metric floor to select · Double-click to open Single 3D Lab"
                    : `Spec envelope: ${selected.envelopeMm[0]} × ${selected.envelopeMm[1]} × ${selected.envelopeMm[2]} mm · Dry mass: ${selected.massKg} kg`}
                </div>
              </div>

              <div className="appliances-telemetry-pills">
                {viewMode === "lab" && measuredBounds !== null ? (
                  <span className="appliances-pill">
                    GLB rest box: {measuredBounds.widthMm} ×{" "}
                    {measuredBounds.depthMm} × {measuredBounds.heightMm} mm
                  </span>
                ) : null}
                <span className="appliances-pill appliances-pill-ok">
                  MuJoCo↔glTF ≤ {selected.maxPosErrNm} nm /{" "}
                  {selected.maxRotErrUrad} µrad
                </span>
              </div>
            </div>

            <ApplianceWebGLViewport
              viewMode={viewMode}
              theme={theme}
              selected={selected}
              jointValues={jointValues}
              onJointValuesFrame={setJointValues}
              demoPlaying={demoPlaying}
              showBounds={showBounds}
              showWireframe={showWireframe}
              showGrid={showGrid}
              cameraRequest={cameraRequest}
              onMeasuredBounds={setMeasuredBounds}
              onSelectFromLineup={(id, openLab) => {
                selectAppliance(id);
                if (openLab) setViewMode("lab");
              }}
            />

            <div className="appliances-stage-bottom-hud">
              <div className="appliances-hud-group" role="group" aria-label="Camera views">
                <button
                  type="button"
                  className="appliances-hud-btn"
                  onClick={() => requestCamera("studio")}
                >
                  3/4 Studio
                </button>
                <button
                  type="button"
                  className="appliances-hud-btn"
                  onClick={() => requestCamera("front")}
                >
                  Front
                </button>
                <button
                  type="button"
                  className="appliances-hud-btn"
                  onClick={() => requestCamera("right")}
                >
                  Right
                </button>
                <button
                  type="button"
                  className="appliances-hud-btn"
                  onClick={() => requestCamera("back")}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="appliances-hud-btn"
                  onClick={() => requestCamera("top")}
                >
                  Top
                </button>
                <span className="appliances-hud-divider" />
                <button
                  type="button"
                  className="appliances-hud-btn"
                  data-active={showGrid}
                  onClick={() => setShowGrid((v) => !v)}
                >
                  Grid
                </button>
                <button
                  type="button"
                  className="appliances-hud-btn"
                  data-active={showBounds}
                  onClick={() => setShowBounds((v) => !v)}
                >
                  Bounds
                </button>
                <button
                  type="button"
                  className="appliances-hud-btn"
                  data-active={showWireframe}
                  onClick={() => setShowWireframe((v) => !v)}
                >
                  Wireframe
                </button>
              </div>

              <div className="appliances-hud-group">
                {viewMode === "lab" ? (
                  <>
                    <button
                      type="button"
                      className="appliances-hud-btn"
                      data-active={demoPlaying}
                      onClick={() => setDemoPlaying((v) => !v)}
                    >
                      {demoPlaying ? "Pause Active Demo" : "Play Active Demo"}
                    </button>
                    <button
                      type="button"
                      className="appliances-hud-btn"
                      onClick={() => {
                        setDemoPlaying(false);
                        setJointValues({});
                      }}
                    >
                      Reset Pose
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="appliances-hud-btn"
                    data-active="true"
                    onClick={() => setViewMode("lab")}
                  >
                    Open {selected.sku} in Single 3D Lab
                  </button>
                )}
              </div>
            </div>
          </section>

          <aside className="appliances-inspector" aria-label="Appliance details and controls">
            <section className="appliances-section">
              <div className="appliances-section-header">
                <h3 className="appliances-section-title">
                  Articulated Controls ({selected.joints.length})
                </h3>
                <div className="appliances-section-actions">
                  {viewMode === "lineup" ? (
                    <button
                      type="button"
                      className="appliances-mini-btn"
                      onClick={() => setViewMode("lab")}
                    >
                      Switch to 3D Lab to Articulate
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="appliances-mini-btn"
                        onClick={() => {
                          setDemoPlaying(false);
                          setJointValues(buildOpenPoseValues(selected.joints));
                        }}
                      >
                        Open Pose
                      </button>
                      <button
                        type="button"
                        className="appliances-mini-btn"
                        onClick={() => {
                          setDemoPlaying(false);
                          setJointValues({});
                        }}
                      >
                        Zero All
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="appliances-joint-list">
                {selected.joints.map((joint) => {
                  const currentVal = jointValues[joint.id] ?? 0;
                  const step = Math.max((joint.max - joint.min) / 240, 0.0001);
                  return (
                    <div key={joint.id} className="appliances-joint-card">
                      <div className="appliances-joint-top">
                        <span className="appliances-joint-label">
                          {joint.label}
                        </span>
                        <span className="appliances-joint-readout">
                          {formatJointValue(joint, currentVal)}
                        </span>
                      </div>
                      <div className="appliances-joint-sub">
                        <span>
                          {joint.id} → {joint.body}
                        </span>
                        <span>
                          {joint.isDetachableAccessory
                            ? "6-DOF prop"
                            : joint.continuousSpinSpeedRadPerSec !== undefined
                              ? "rotor"
                              : joint.kind}
                        </span>
                      </div>
                      <input
                        type="range"
                        className="appliances-slider"
                        aria-label={joint.label}
                        min={joint.min}
                        max={joint.max}
                        step={step}
                        value={currentVal}
                        onChange={(ev) => {
                          const parsed = Number(ev.currentTarget.value);
                          if (viewMode !== "lab") setViewMode("lab");
                          setDemoPlaying(false);
                          setJointValues((prev) => ({
                            ...prev,
                            [joint.id]: parsed,
                          }));
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="appliances-section">
              <div className="appliances-section-header">
                <h3 className="appliances-section-title">
                  Blender Cycles Studio Renders ({selected.renders.length})
                </h3>
                <span className="appliances-rail-dims">Click to zoom</span>
              </div>
              <div className="appliances-render-grid">
                {selected.renders.map((render, idx) => (
                  <button
                    key={render.label}
                    type="button"
                    className="appliances-render-thumb-btn"
                    onClick={() =>
                      setLightbox({
                        applianceTitle: selected.title,
                        renders: selected.renders,
                        index: idx,
                      })
                    }
                  >
                    <img
                      className="appliances-render-thumb-img"
                      src={render.url}
                      alt={`${selected.title} — ${render.label}`}
                      loading="lazy"
                    />
                    <span className="appliances-render-thumb-caption">
                      {render.label}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section className="appliances-section">
              <div className="appliances-section-header">
                <h3 className="appliances-section-title">
                  Specifications &amp; Physics Parity
                </h3>
              </div>
              <dl className="appliances-spec-dl">
                <dt className="appliances-spec-dt">Envelope</dt>
                <dd className="appliances-spec-dd">
                  {selected.envelopeMm[0]} × {selected.envelopeMm[1]} ×{" "}
                  {selected.envelopeMm[2]} mm (W × D × H)
                </dd>

                <dt className="appliances-spec-dt">Dry mass</dt>
                <dd className="appliances-spec-dd">
                  {selected.massKg} kg
                  {selected.accessoryNote !== undefined
                    ? ` (${selected.accessoryNote})`
                    : ""}
                </dd>

                <dt className="appliances-spec-dt">Utilities</dt>
                <dd className="appliances-spec-dd">{selected.utilitySummary}</dd>

                {selected.keySpecs.map((spec) => (
                  <React.Fragment key={spec.label}>
                    <dt className="appliances-spec-dt">{spec.label}</dt>
                    <dd className="appliances-spec-dd">{spec.value}</dd>
                  </React.Fragment>
                ))}

                <dt className="appliances-spec-dt">MuJoCo parity</dt>
                <dd className="appliances-spec-dd">
                  1:1 native.xml · pos ≤ {selected.maxPosErrNm} nm · rot ≤{" "}
                  {selected.maxRotErrUrad} µrad · dt 1ms/2ms PASS
                </dd>

                <dt className="appliances-spec-dt">Asset path</dt>
                <dd className="appliances-spec-dd">
                  assets/bakery-mujoco/{selected.id}/
                </dd>
              </dl>

              <ul className="appliances-doc-list" aria-label="R2 vendor documents">
                {selected.r2Documents.map((doc) => (
                  <li key={doc} className="appliances-doc-item">
                    R2 · docs/equipment/{selected.id}/specifications/{doc}
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </main>
      )}

      {lightbox !== null && activeLightboxRender !== undefined ? (
        <div
          className="appliances-lightbox-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`${lightbox.applianceTitle} Cycles render`}
          onClick={() => setLightbox(null)}
        >
          <div
            className="appliances-lightbox-dialog"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="appliances-lightbox-bar">
              <div>
                <strong>{lightbox.applianceTitle}</strong> —{" "}
                {activeLightboxRender.label} ({lightbox.index + 1} /{" "}
                {lightbox.renders.length})
              </div>
              <div className="appliances-section-actions">
                <button
                  type="button"
                  className="appliances-btn"
                  onClick={() =>
                    setLightbox((prev) =>
                      prev === null
                        ? null
                        : {
                            ...prev,
                            index:
                              (prev.index - 1 + prev.renders.length) %
                              prev.renders.length,
                          },
                    )
                  }
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="appliances-btn"
                  onClick={() =>
                    setLightbox((prev) =>
                      prev === null
                        ? null
                        : {
                            ...prev,
                            index: (prev.index + 1) % prev.renders.length,
                          },
                    )
                  }
                >
                  Next
                </button>
                <button
                  type="button"
                  className="appliances-btn appliances-btn-primary"
                  onClick={() => setLightbox(null)}
                >
                  Close (Esc)
                </button>
              </div>
            </div>
            <img
              className="appliances-lightbox-img"
              src={activeLightboxRender.url}
              alt={`${lightbox.applianceTitle} — ${activeLightboxRender.label}`}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

const rootElement = document.getElementById("root");
if (rootElement !== null) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <AppliancesPreviewApp />
    </React.StrictMode>,
  );
}
