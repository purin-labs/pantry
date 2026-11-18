import * as THREE from "three";
import { createCroissantGeometry, createCroissantSeams } from "./croissant.mjs";
import { GLTFLoader } from "./vendor/loaders/GLTFLoader.js";
import { EffectComposer } from "./vendor/postprocessing/EffectComposer.js";
import { RenderPass } from "./vendor/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "./vendor/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "./vendor/postprocessing/OutputPass.js";

const host = document.querySelector('[data-rehearsal="maruzen-rehearsal"]');
const root = host.shadowRoot ?? host;
const viewport = root.querySelector("#viewport");
const runButton = root.querySelector("#run");
const buttons = [...root.querySelectorAll("[data-stage]")];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf6f5f0);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
camera.position.set(1.15, 1.35, 2.8);
camera.lookAt(-0.1, 0.32, 0.35);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.LinearToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.setAttribute("role", "img");
viewport.append(renderer.domElement);
const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    samples: 4,
  }),
);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(
  new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.35, 1.25),
);
composer.addPass(new OutputPass());
scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d8cd, 1.1));
const key = new THREE.DirectionalLight(0xfff9ed, 1.35);
key.position.set(-1, 3, 2);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
Object.assign(key.shadow.camera, {
  left: -1.5,
  right: 1.5,
  top: 1.5,
  bottom: -1.5,
  near: 0.1,
  far: 7,
});
key.shadow.normalBias = 0.003;
scene.add(key);

const paper = new THREE.MeshStandardMaterial({
  color: 0xe8e7de,
  roughness: 0.8,
});
const enamel = new THREE.MeshStandardMaterial({
  color: 0xd5d1c2,
  roughness: 0.48,
});
const chamber = new THREE.MeshStandardMaterial({
  color: 0xc8c6b8,
  roughness: 0.58,
  metalness: 0.1,
});
const graphite = new THREE.MeshStandardMaterial({
  color: 0x666b60,
  roughness: 0.8,
});
const markings = new THREE.MeshBasicMaterial({ color: 0x777c70 });
const glass = new THREE.MeshPhysicalMaterial({
  color: 0xffe0a4,
  transparent: true,
  opacity: 0.11,
  depthWrite: false,
  roughness: 0.15,
  clearcoat: 1,
});
const lampMaterial = new THREE.MeshStandardMaterial({
  color: 0xffd994,
  emissive: 0xffb34b,
  emissiveIntensity: 0,
});
const ink = new THREE.LineBasicMaterial({
  color: 0x535b4b,
  transparent: true,
  opacity: 0.48,
});
const guideMaterial = new THREE.MeshBasicMaterial({
  color: new THREE.Color().setRGB(3, 0.8, 0.12),
  transparent: true,
  opacity: 0,
  depthWrite: false,
});
// Separate soft floor patches keep the interior shadow maps inside the appliance.
const ovenShadow = createSoftPatch(1.25, 1.1, 0x625d4f, 0.13);
ovenShadow.position.set(0, 0.001, 0.04);
const lightSpill = createSoftPatch(0.8, 1, 0xffb949, 0);
lightSpill.position.set(-0.1, 0.003, 0.74);
scene.add(ovenShadow, lightSpill);

// Source position follows the lamp lens in the existing GLB, inside the chamber.
const chamberLight = new THREE.PointLight(0xffbd6d, 0, 2, 2);
chamberLight.position.set(-0.282, 0.373, 0.243);
chamberLight.castShadow = true;
chamberLight.shadow.mapSize.set(512, 512);
chamberLight.shadow.camera.near = 0.008;
chamberLight.shadow.bias = -0.0002;
chamberLight.shadow.normalBias = 0.0008;
scene.add(chamberLight);
const spill = new THREE.SpotLight(0xffb852, 0, 2.5, Math.PI / 4, 0.9, 2);
spill.position.set(-0.1, 0.55, 0.1);
spill.target.position.set(-0.1, 0, 1.05);
spill.castShadow = true;
spill.shadow.mapSize.set(512, 512);
spill.shadow.camera.near = 0.01;
spill.shadow.bias = -0.0001;
scene.add(spill, spill.target);

const tray = new THREE.Group();
// Dimensions and rim positions come from maruzen-mbco-5e/tray.xml, mapped to Y-up.
addBox(tray, [0.4, 0.002, 0.6], [0, 0, 0], chamber);
addBox(tray, [0.002, 0.018, 0.6], [-0.199, 0.01, 0], chamber);
addBox(tray, [0.002, 0.018, 0.6], [0.199, 0.01, 0], chamber);
addBox(tray, [0.396, 0.018, 0.002], [0, 0.01, -0.299], chamber);
addBox(tray, [0.396, 0.018, 0.002], [0, 0.01, 0.299], chamber);
const pastryGeometry = createCroissantGeometry();
const seamGeometry = createCroissantSeams();
const pastryMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.83,
});
const seamMaterial = new THREE.LineBasicMaterial({
  color: 0x975e30,
  transparent: true,
  opacity: 0.45,
});
for (const z of [-0.145, 0.145]) {
  for (const x of [-0.125, 0, 0.125]) {
    const pastry = new THREE.Mesh(pastryGeometry, pastryMaterial);
    pastry.position.set(x, 0, z);
    pastry.rotation.y = Math.PI;
    pastry.castShadow = true;
    pastry.receiveShadow = true;
    pastry.add(new THREE.LineSegments(seamGeometry, seamMaterial));
    tray.add(pastry);
  }
}
scene.add(tray);

const guides = new THREE.Group();
for (const x of [-0.305, 0.105]) {
  const guide = new THREE.Mesh(
    new THREE.BoxGeometry(0.009, 0.002, 0.62),
    guideMaterial,
  );
  guide.position.set(x, 0.357, 0.013);
  guides.add(guide);
}
scene.add(guides);

const stages = [
  {
    pose: 2,
    title: "See the work ahead.",
    description:
      "Six croissants, arranged in two rows of three. Review the approach before the tray moves.",
    label:
      "Door open, chamber illuminated, six croissants on the floating tray",
  },
  {
    pose: 3,
    title: "Make the handoff visible.",
    description:
      "The 400 mm tray passes through the 440 mm opening and rests on the middle rails. Pause to review alignment.",
    label: "Door open, tray with six croissants resting on the middle rails",
  },
  {
    pose: 4,
    title: "One routine, ready to review.",
    description:
      "The tray stays on the rails as the door closes. Review the placement with your team before field practice.",
    label: "Door closed, tray with six croissants on the middle rails",
  },
];
let oven;
let door;
let handle;
let position = 0;
let stage = 0;
let motion = { kind: "still" };
let frame = 0;
let inView = true;
const loader = new GLTFLoader();
loader.load(
  new URL("./maruzen-mbco-5e.glb", import.meta.url).href,
  onLoad,
  undefined,
  onError,
);

function addBox(parent, size, location, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...location);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.add(
    new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 35), ink),
  );
  parent.add(mesh);
  return mesh;
}

function createSoftPatch(width, depth, color, opacity) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(color) },
      opacity: { value: opacity },
    },
    vertexShader: `varying vec2 patchUv;
      void main() {
        patchUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `varying vec2 patchUv;
      uniform vec3 color;
      uniform float opacity;
      void main() {
        vec2 p = (patchUv - 0.5) * 2.0;
        float fade = 1.0 - smoothstep(0.05, 1.0, dot(p, p));
        gl_FragColor = vec4(color, opacity * fade * fade);
      }`,
    transparent: true,
    depthWrite: false,
  });
  const patch = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), material);
  patch.rotation.x = -Math.PI / 2;
  return patch;
}

function styleMesh(mesh) {
  if (!mesh.isMesh) return;
  const material = mesh.material.name;
  switch (material) {
    case "chamber_light":
      mesh.material = lampMaterial;
      break;
    case "chamber_stainless":
      mesh.material = chamber;
      break;
    case "ruby_enamel":
      mesh.material = enamel;
      break;
    case "smoked_glass":
      mesh.material = glass;
      break;
    case "rubber_and_grip":
    case "ceramic_black":
      mesh.material = graphite;
      break;
    case "panel_ink":
    case "blue_badge":
      mesh.material = markings;
      break;
    case "red_readout":
    case "green_readout":
      mesh.visible = false;
      return;
    default:
      mesh.material = paper;
  }
  mesh.castShadow = material !== "smoked_glass" && material !== "chamber_light";
  mesh.receiveShadow = material !== "smoked_glass";
  if (material === "panel_ink" || material === "chamber_light") return;
  mesh.add(
    new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 40), ink),
  );
}

function onLoad(gltf) {
  oven = gltf.scene;
  door = oven.getObjectByName("mbco_door");
  handle = oven.getObjectByName("mbco_handle");
  if (!door || !handle) {
    onError(new Error("The oven asset is missing its articulated parts."));
    return;
  }
  oven.traverse(styleMesh);
  scene.add(oven);
  root.querySelector("#loading").remove();
  viewport.setAttribute("aria-busy", "false");
  runButton.disabled = false;
  buttons.forEach(enableButton);
  resize();
  describeStage(0);
  pose(stages[0].pose);
  renderer.domElement.setAttribute(
    "aria-label",
    "Maruzen oven with its door open, six croissants on the floating tray",
  );
}

function enableButton(button) {
  button.disabled = false;
  button.addEventListener("click", selectStage);
}

function onError(error) {
  root.querySelector("#loading").textContent =
    "The oven could not load. Reload to try again.";
  viewport.setAttribute("aria-busy", "false");
  console.error(error);
}

// Solve the established cubic-bezier(.77, 0, .175, 1) for choreography segments.
function ease(value) {
  const x = THREE.MathUtils.clamp(value, 0, 1);
  let low = 0;
  let high = 1;
  let t = x;
  for (let step = 0; step < 16; step += 1) {
    t = (low + high) / 2;
    const curveX =
      3 * (1 - t) ** 2 * t * 0.77 + 3 * (1 - t) * t ** 2 * 0.175 + t ** 3;
    if (curveX < x) low = t;
    else high = t;
  }
  return 3 * (1 - t) * t ** 2 + t ** 3;
}

function pose(value) {
  position = value;
  const illumination = ease(value);
  const opening = ease(value - 1) * (1 - ease(value - 3));
  const insertion = ease(value - 2);
  door.rotation.y = -THREE.MathUtils.degToRad(100) * opening;
  handle.rotation.z = 0.35 * Math.sin(opening * Math.PI);
  // The 2 mm tray base rests on the middle supports at y = 356 mm.
  tray.position.set(-0.1, 0.357, THREE.MathUtils.lerp(0.92, 0.013, insertion));
  lampMaterial.emissiveIntensity = illumination * 3;
  chamberLight.intensity = illumination * 0.085;
  spill.intensity = illumination * opening * 0.35;
  lightSpill.scale.x = 0.15 + opening * 0.85;
  lightSpill.material.uniforms.opacity.value = illumination * opening * 0.22;
  guideMaterial.opacity = 0.3 * opening * (1 - insertion);
  composer.render();
}

function describeStage(nextStage) {
  stage = nextStage;
  buttons.forEach(updateButton);
  root.querySelector("#stage-title").textContent = stages[stage].title;
  root.querySelector("#stage-description").textContent =
    stages[stage].description;
  root.querySelector(".figure-number").textContent = `0${stage + 1}`;
  renderer.domElement.setAttribute(
    "aria-label",
    `Maruzen MBCO-5E: ${stages[stage].label}`,
  );
}

function updateButton(button) {
  button.setAttribute(
    "aria-pressed",
    String(Number(button.dataset.stage) === stage),
  );
}

function stop() {
  cancelAnimationFrame(frame);
  motion = { kind: "still" };
  runButton.querySelector("span").textContent = "Run rehearsal";
}

function selectStage(event) {
  stop();
  describeStage(Number(event.currentTarget.dataset.stage));
  const target = stages[stage].pose;
  if (reducedMotion.matches || event.detail === 0) {
    pose(target);
    return;
  }
  motion = {
    kind: "transition",
    from: position,
    to: target,
    start: performance.now(),
    duration: Math.max(0.35, Math.abs(target - position)) * 900,
  };
  frame = requestAnimationFrame(tick);
}

function run(event) {
  if (motion.kind === "rehearsal") {
    stop();
    return;
  }
  stop();
  if (reducedMotion.matches || event.detail === 0) {
    describeStage((stage + 1) % stages.length);
    pose(stages[stage].pose);
    return;
  }
  pose(0);
  describeStage(0);
  motion = { kind: "rehearsal", start: performance.now() };
  runButton.querySelector("span").textContent = "Pause rehearsal";
  frame = requestAnimationFrame(tick);
}

function tick(now) {
  if (motion.kind === "rehearsal") {
    const elapsed = (now - motion.start) / 1000;
    let value;
    if (elapsed < 0.8) value = elapsed / 0.8;
    else if (elapsed < 1.6) value = 1;
    else if (elapsed < 2.8) value = 1 + (elapsed - 1.6) / 1.2;
    else if (elapsed < 3.7) value = 2;
    else if (elapsed < 5.7) value = 2 + (elapsed - 3.7) / 2;
    else if (elapsed < 7.5) value = 3;
    else if (elapsed < 8.7) value = 3 + (elapsed - 7.5) / 1.2;
    else {
      pose(4);
      describeStage(2);
      stop();
      return;
    }
    pose(value);
    let nextStage = 0;
    if (value > 3) nextStage = 2;
    else if (value >= 2.1) nextStage = 1;
    if (nextStage !== stage) describeStage(nextStage);
  } else if (motion.kind === "transition") {
    const progress = Math.min((now - motion.start) / motion.duration, 1);
    pose(THREE.MathUtils.lerp(motion.from, motion.to, progress));
    if (progress === 1) {
      stop();
      return;
    }
  } else return;
  frame = requestAnimationFrame(tick);
}

function resize() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const aspect = width / height;
  const span = Math.max(1.85, 2.1 / aspect);
  camera.left = (-span * aspect) / 2;
  camera.right = (span * aspect) / 2;
  camera.top = span / 2;
  camera.bottom = -span / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  composer.setSize(width, height);
  if (oven && door) pose(position);
}

function visibilityChanged() {
  if (document.hidden || !inView) stop();
}

function viewportChanged(entries) {
  inView = entries[0].isIntersecting;
  visibilityChanged();
}

function motionPreferenceChanged() {
  stop();
  if (oven && door) pose(stages[stage].pose);
}

runButton.addEventListener("click", run);
document.addEventListener("visibilitychange", visibilityChanged);
reducedMotion.addEventListener("change", motionPreferenceChanged);
new ResizeObserver(resize).observe(viewport);
new IntersectionObserver(viewportChanged).observe(viewport);
