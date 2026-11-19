import * as THREE from "three";
import type { MachineState } from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { assertNever } from "@purin-labs/std";
type Readout = {
  readonly material: THREE.MeshStandardMaterial;
  readonly color: THREE.Color;
};

export type OvenVisual = {
  readonly door: THREE.Object3D;
  readonly handle: THREE.Object3D;
  readonly readouts: readonly Readout[];
  readonly lamps: readonly THREE.MeshStandardMaterial[];
  readonly chamberLight: THREE.PointLight;
  readonly steamGroup: THREE.Group;
  readonly steamWisps: readonly THREE.Mesh<
    THREE.SphereGeometry,
    THREE.MeshBasicMaterial
  >[];
};

function noopRaycast(): void {
  /* Vapour wisps never intercept pointer rays. */
}

export function buildSteamPlumeGroup(
  name: string,
  count = 3,
): {
  readonly group: THREE.Group;
  readonly wisps: readonly THREE.Mesh<
    THREE.SphereGeometry,
    THREE.MeshBasicMaterial
  >[];
} {
  const group = new THREE.Group();
  group.name = name;
  group.visible = false;
  const wisps: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] = [];
  for (let i = 0; i < count; i += 1) {
    const geo = new THREE.SphereGeometry(0.055 + i * 0.014, 14, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xfffbf2,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    });
    const wisp = new THREE.Mesh(geo, mat);
    wisp.scale.set(1.15, 0.72, 1.05);
    wisp.position.set((i - 1) * 0.045, i * 0.08, 0);
    wisp.raycast = noopRaycast;
    group.add(wisp);
    wisps.push(wisp);
  }
  return { group, wisps };
}

export function updateSteamPlumeGroup(
  steam: {
    readonly group: THREE.Group;
    readonly wisps: readonly THREE.Mesh<
      THREE.SphereGeometry,
      THREE.MeshBasicMaterial
    >[];
  },
  activeIntensity: number,
  time: number,
  reducedMotion: boolean,
): void {
  if (activeIntensity <= 0.01) {
    steam.group.visible = false;
    return;
  }
  steam.group.visible = true;
  for (let i = 0; i < steam.wisps.length; i += 1) {
    const wisp = steam.wisps[i]!;
    const cycle = reducedMotion ? (i + 1) * 0.3 : (time * 0.55 + i * 0.33) % 1;
    const fade = Math.sin(cycle * Math.PI);
    wisp.position.y = cycle * 0.26;
    wisp.position.x =
      (i - 1) * 0.042 +
      (reducedMotion ? 0 : Math.sin(time * 1.4 + i * 2.1) * 0.022);
    const s = 0.85 + cycle * 0.65;
    wisp.scale.set(s * 1.15, s * 0.75, s * 1.05);
    wisp.material.opacity = activeIntensity * 0.22 * fade;
  }
}

export function bindOvenVisual(root: THREE.Object3D): OvenVisual {
  const door =
    root.getObjectByName("mbco4_door") ?? root.getObjectByName("mbco_door");
  const handle =
    root.getObjectByName("mbco4_handle") ?? root.getObjectByName("mbco_handle");
  if (!door || !handle || handle.parent !== door) {
    throw new Error(
      "The Maruzen asset is missing its articulated door or handle.",
    );
  }
  const readouts: Readout[] = [];
  const lamps: THREE.MeshStandardMaterial[] = [];
  const materials = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  const readoutMaterialNames = new Set([
    "red_readout",
    "green_readout",
    "mbco4_red_display",
    "mbco4_green_display",
  ]);
  const lampMaterialNames = new Set(["chamber_light", "mbco4_chamber_lamp"]);
  for (const node of root.getObjectsByProperty("isMesh", true)) {
    if (!(node instanceof THREE.Mesh)) continue;
    const original = node.material;
    if (!(original instanceof THREE.MeshStandardMaterial)) continue;
    const isLamp = lampMaterialNames.has(original.name);
    const isReadout = readoutMaterialNames.has(original.name);
    if (!isLamp && !isReadout) {
      continue;
    }
    let material = materials.get(original);
    if (!material) {
      material = original.clone();
      materials.set(original, material);
      if (isLamp) lamps.push(material);
      else readouts.push({ material, color: original.color.clone() });
    }
    node.material = material;
  }
  if (readouts.length !== 2 || lamps.length !== 1) {
    throw new Error(
      "The Maruzen asset is missing its display or chamber-light materials.",
    );
  }
  for (const original of materials.keys()) original.dispose();

  const chamberLight = new THREE.PointLight(0xff8c2b, 0, 2.4, 1.7);
  chamberLight.name = "oven-chamber-light";
  chamberLight.position.set(0, 1.22, 0.22);
  root.add(chamberLight);

  const steam = buildSteamPlumeGroup("oven-door-steam", 3);
  steam.group.position.set(0, 1.44, 0.42);
  root.add(steam.group);

  return {
    door,
    handle,
    readouts,
    lamps,
    chamberLight,
    steamGroup: steam.group,
    steamWisps: steam.wisps,
  };
}

export function updateOvenVisual(
  oven: OvenVisual,
  state: MachineState,
  opening: number,
  time = 0,
  reducedMotion = false,
): void {
  oven.door.rotation.y = -opening * THREE.MathUtils.degToRad(100);
  // An illustrative release gesture; latch mechanics are outside scheduler playback.
  oven.handle.rotation.z = 0.35 * Math.sin(opening * Math.PI);
  for (const readout of oven.readouts) {
    readout.material.color.copy(readout.color);
    readout.material.emissive.copy(readout.color);
    switch (state) {
      case "idle":
        readout.material.emissiveIntensity = 0.15;
        break;
      case "running":
        readout.material.emissiveIntensity = 1.5;
        break;
      case "ready":
        readout.material.emissive.set("#59d77e");
        readout.material.emissiveIntensity = 1.2;
        break;
      case "fault":
        readout.material.emissive.set("#ef5350");
        readout.material.emissiveIntensity = 1.5;
        break;
      default:
        assertNever(state);
    }
  }
  for (const material of oven.lamps) {
    material.emissiveIntensity =
      state === "running" || state === "ready" || opening > 0 ? 2 : 0;
  }
  if (state === "fault") {
    oven.chamberLight.color.setHex(0xff5238);
    oven.chamberLight.intensity = 0.65;
  } else if (state === "running") {
    oven.chamberLight.color.setHex(0xff8c2b);
    oven.chamberLight.intensity = 0.88 + opening * 0.55;
  } else if (state === "ready" || opening > 0) {
    oven.chamberLight.color.setHex(0xffa74f);
    oven.chamberLight.intensity = 0.48 + opening * 0.5;
  } else {
    oven.chamberLight.intensity = 0;
  }
  const steamIntensity =
    opening > 0.04 && (state === "running" || state === "ready")
      ? Math.min(1, opening * 1.25)
      : state === "running"
        ? 0.32
        : 0;
  updateSteamPlumeGroup(
    { group: oven.steamGroup, wisps: oven.steamWisps },
    steamIntensity,
    time,
    reducedMotion,
  );
}
