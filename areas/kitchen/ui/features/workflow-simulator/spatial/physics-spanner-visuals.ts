import * as THREE from "three";
import type { PhysicsGeometry } from "@purin-labs/bakery-model/bakery-physics";

type PoseSetter = (
  object: THREE.Object3D,
  pose: PhysicsGeometry["pose"],
) => void;

const MATERIAL_STYLE: Readonly<
  Record<
    string,
    Readonly<{ color: number; metalness: number; roughness: number }>
  >
> = {
  clamp_spanner_flange_col: {
    color: 0xb4bcc2,
    metalness: 0.78,
    roughness: 0.32,
  },
  clamp_spanner_beam_col: { color: 0x2b313a, metalness: 0.55, roughness: 0.38 },
  clamp_spanner_jaw_rear_stem_col: {
    color: 0xbcc3c8,
    metalness: 0.82,
    roughness: 0.28,
  },
  clamp_spanner_jaw_front_stem_col: {
    color: 0xbcc3c8,
    metalness: 0.82,
    roughness: 0.28,
  },
  clamp_spanner_jaw_rear_pad_col: {
    color: 0x23717b,
    metalness: 0.05,
    roughness: 0.82,
  },
  clamp_spanner_jaw_front_pad_col: {
    color: 0x23717b,
    metalness: 0.05,
    roughness: 0.82,
  },
  cold_contents: { color: 0xd69238, metalness: 0.02, roughness: 0.78 },
  table_top: { color: 0xb8c0c6, metalness: 0.72, roughness: 0.34 },
  oven_stand: { color: 0x9aa4ac, metalness: 0.68, roughness: 0.38 },
  pedestal_column: { color: 0x8f9aa2, metalness: 0.65, roughness: 0.4 },
  pedestal_plate: { color: 0xadb6bc, metalness: 0.72, roughness: 0.34 },
};

function styleFor(name: string): Readonly<{
  color: number;
  metalness: number;
  roughness: number;
}> {
  const exact = MATERIAL_STYLE[name];
  if (exact !== undefined) return exact;
  if (name.startsWith("mbco4_tray_"))
    return { color: 0xc8cfd4, metalness: 0.75, roughness: 0.34 };
  if (name.startsWith("table_leg_") || name.startsWith("rack_post_"))
    return { color: 0x9aa4ac, metalness: 0.68, roughness: 0.38 };
  if (name.startsWith("rack_rail_"))
    return { color: 0xb8c0c6, metalness: 0.76, roughness: 0.3 };
  return { color: 0x9ca5ac, metalness: 0.5, roughness: 0.45 };
}

function geometryFor(item: PhysicsGeometry): THREE.BufferGeometry {
  if (item.shape === "box") {
    return new THREE.BoxGeometry(
      item.size[0] * 2,
      item.size[1] * 2,
      item.size[2] * 2,
    );
  }
  if (item.shape === "capsule") {
    const capsule = new THREE.CapsuleGeometry(
      item.size[0],
      item.size[1] * 2,
      8,
      16,
    );
    capsule.rotateX(Math.PI / 2);
    return capsule;
  }
  const cylinder = new THREE.CylinderGeometry(
    item.size[0],
    item.size[0],
    item.size[1] * 2,
    24,
  );
  cylinder.rotateX(Math.PI / 2);
  return cylinder;
}

function buildMesh(item: PhysicsGeometry, setPose: PoseSetter): THREE.Mesh {
  const style = styleFor(item.name);
  const mesh = new THREE.Mesh(
    geometryFor(item),
    new THREE.MeshStandardMaterial({
      color: style.color,
      metalness: style.metalness,
      roughness: style.roughness,
    }),
  );
  mesh.name = `${item.name}_visual`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  setPose(mesh, item.pose);
  return mesh;
}

export function buildSpannerGroup(
  items: readonly PhysicsGeometry[],
  predicate: (item: PhysicsGeometry) => boolean,
  name: string,
  setPose: PoseSetter,
): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  for (const item of items) {
    if (predicate(item)) group.add(buildMesh(item, setPose));
  }
  return group;
}
