import * as THREE from "./vendor/three.module.min.js";

// A small illustrative pastry: tapered crescent, rolled bands, and a flat base.
// Shared geometry keeps all six pastries identical in size and inexpensive to draw.
export function createCroissantGeometry() {
  const positions = [];
  const colors = [];
  const indices = [];
  const rings = 96;
  const sides = 24;
  const golden = new THREE.Color(0xe6af67);
  const toasted = new THREE.Color(0xb8793c);
  const color = new THREE.Color();
  for (let ring = 0; ring <= rings; ring += 1) {
    const t = -1 + (2 * ring) / rings;
    const profile = pastryProfile(t);
    for (let side = 0; side <= sides; side += 1) {
      const angle = (side / sides) * Math.PI * 2;
      positions.push(...surfacePoint(profile, angle));
      const browning =
        0.12 + 0.3 * Math.max(0, Math.sin(angle)) + 0.18 * (1 - profile.ridge);
      color.copy(golden).lerp(toasted, browning);
      colors.push(color.r, color.g, color.b);
      if (ring === rings || side === sides) continue;
      const current = ring * (sides + 1) + side;
      const next = current + sides + 1;
      indices.push(current, next, next + 1, current, next + 1, current + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

export function createCroissantSeams() {
  const positions = [];
  for (let band = 0; band < 6; band += 1) {
    const t = -1 + (2 * band + 1) / 6;
    const profile = pastryProfile(t);
    for (let segment = 0; segment < 20; segment += 1) {
      const start = (segment / 20) * Math.PI;
      const end = ((segment + 1) / 20) * Math.PI;
      positions.push(...surfacePoint(profile, start, 0.00015));
      positions.push(...surfacePoint(profile, end, 0.00015));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  return geometry;
}

function pastryProfile(t) {
  const angle = t * 1.5;
  const tangentX = 0.052 * Math.cos(angle);
  const tangentZ = -0.06 * Math.sin(angle);
  const length = Math.hypot(tangentX, tangentZ);
  const taper = Math.pow(Math.max(0, 1 - t * t), 0.72);
  const ridge = 0.9 + 0.1 * Math.cos((t + 1) * Math.PI * 6);
  return {
    x: 0.052 * Math.sin(angle),
    z: 0.06 * (Math.cos(angle) - 0.55),
    normalX: -tangentZ / length,
    normalZ: tangentX / length,
    width: (0.0006 + 0.024 * taper) * ridge,
    height: (0.0004 + 0.022 * taper) * ridge,
    ridge,
  };
}

function surfacePoint(profile, angle, offset = 0) {
  const spread = (profile.width + offset) * Math.cos(angle);
  return [
    profile.x + profile.normalX * spread,
    0.001 + profile.height * (1 + Math.sin(angle)) + offset,
    profile.z + profile.normalZ * spread,
  ];
}
