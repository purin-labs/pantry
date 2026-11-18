import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const HDRI_SPOTS: ReadonlyArray<
  readonly [
    dir: readonly [number, number, number],
    power: number,
    rgb: readonly [number, number, number],
  ]
> = [
  // Broad warm morning sun window + crisp solar core aligned with key sun (7.8, 8.6, 2.2)
  [[0.6594, 0.727, 0.186], 7, [3.4, 2.75, 1.95]],
  [[0.6594, 0.727, 0.186], 96, [14.5, 11.4, 7.6]],
  // Warm 2800 K pâtisserie pendant softboxes in upper interior hemisphere
  [[-0.46, 0.81, 0.36], 18, [4.2, 2.75, 1.4]],
  [[0.34, 0.85, -0.39], 18, [4.0, 2.65, 1.35]],
  [[-0.4, 0.79, -0.46], 18, [3.8, 2.5, 1.3]],
];

/** Synthesizes a HalfFloat equirectangular warm bakery HDRI light map for PMREM IBL. */
export function createWarmBakeryHdriTexture(): THREE.DataTexture {
  const width = 512;
  const height = 256;
  const data = new Uint16Array(width * height * 4);
  const toHalf = THREE.DataUtils.toHalfFloat;
  let offset = 0;

  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    const phi = (v - 0.5) * Math.PI;
    const cosPhi = Math.cos(phi);
    const dy = Math.sin(phi);

    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const theta = (u - 0.5) * Math.PI * 2;
      const dx = cosPhi * Math.cos(theta);
      const dz = cosPhi * Math.sin(theta);

      let r: number;
      let g: number;
      let b: number;
      if (dy >= 0) {
        const up = Math.pow(dy, 0.55);
        r = THREE.MathUtils.lerp(0.9, 1.12, up);
        g = THREE.MathUtils.lerp(0.78, 0.95, up);
        b = THREE.MathUtils.lerp(0.64, 0.77, up);
      } else {
        const down = Math.pow(-dy, 0.65);
        r = THREE.MathUtils.lerp(0.66, 0.3, down);
        g = THREE.MathUtils.lerp(0.5, 0.22, down);
        b = THREE.MathUtils.lerp(0.35, 0.15, down);
      }

      // Warm timber boiserie & brass horizon band for vertical steel/glass reflections
      const horizon = Math.exp(-dy * dy * 28);
      r += 0.22 * horizon;
      g += 0.16 * horizon;
      b += 0.09 * horizon;

      // Street-front glazing bank (+Z) with subtle mullion bar modulation
      const dotFront = Math.max(0, -0.18 * dx + 0.26 * dy + 0.948 * dz);
      if (dotFront > 0) {
        const mullion = 0.8 + 0.2 * Math.cos(dx * 14);
        const frontGlow = Math.pow(dotFront, 5) * mullion;
        r += 2.35 * frontGlow;
        g += 2.46 * frontGlow;
        b += 2.58 * frontGlow;
      }

      for (const [dir, power, rgb] of HDRI_SPOTS) {
        const dot = dx * dir[0] + dy * dir[1] + dz * dir[2];
        if (dot > 0) {
          const w = Math.pow(dot, power);
          r += rgb[0] * w;
          g += rgb[1] * w;
          b += rgb[2] * w;
        }
      }

      data[offset] = toHalf(r);
      data[offset + 1] = toHalf(g);
      data[offset + 2] = toHalf(b);
      data[offset + 3] = toHalf(1);
      offset += 4;
    }
  }

  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  );
  texture.name = "warm-bakery-hdri";
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function noopRaycast(): void {
  /* Ground shadow planes never intercept pointer selection or drag rays. */
}

function isPerspective(camera: THREE.Camera): boolean {
  return (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
}

function excludedFromAmbientOcclusion(object: THREE.Object3D): boolean {
  if (
    object.userData.excludeFromAo === true ||
    object.userData.isRotateGizmo === true ||
    object instanceof THREE.ArrowHelper ||
    object instanceof THREE.BoxHelper
  ) {
    return true;
  }
  if (!(object instanceof THREE.Mesh)) return false;
  const materials: readonly THREE.Material[] = Array.isArray(object.material)
    ? object.material
    : [object.material];
  return materials.some(
    (mat) => mat.transparent || !mat.depthWrite || mat.opacity < 1,
  );
}

class SceneGTAOPass extends GTAOPass {
  private readonly hiddenForAo: THREE.Object3D[] = [];

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    this.hideTransparentObjects(this.scene);
    try {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      for (const obj of this.hiddenForAo) obj.visible = true;
      this.hiddenForAo.length = 0;
    }
  }

  private hideTransparentObjects(node: THREE.Object3D): void {
    if (!node.visible) return;
    if (excludedFromAmbientOcclusion(node)) {
      node.visible = false;
      this.hiddenForAo.push(node);
      return;
    }
    for (const child of node.children) {
      this.hideTransparentObjects(child);
    }
  }

  override dispose(): void {
    super.dispose();
    this.gtaoMaterial.dispose();
    this.blendMaterial.dispose();
    this.depthTexture.dispose();
  }
}

export type BakeryLightingRig = Readonly<{
  environment: THREE.WebGLRenderTarget;
  sun: THREE.DirectionalLight;
  exteriorShadowPlane: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
  render: (camera?: THREE.Camera) => void;
  setExteriorPlaneY: (y: number) => void;
  setDarkTheme: (dark: boolean) => void;
  dispose: () => void;
}>;

export type BakeryLightingOptions = Readonly<{
  shadowFrustumHalfSize?: number;
  exteriorShadowPlaneY?: number;
}>;

/** Configures renderer shadow maps, tone mapping, lowered fill lights, exterior shadow plane, and GTAOPass. */
export function setupBakeryLightingAndPost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  initialCamera: THREE.Camera,
  options: BakeryLightingOptions = {},
): BakeryLightingRig {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const hdri = createWarmBakeryHdriTexture();
  const environment = pmrem.fromEquirectangular(hdri);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.54;
  hdri.dispose();
  pmrem.dispose();

  const hemisphere = new THREE.HemisphereLight(0xfff8ed, 0x5c6854, 0.52);
  hemisphere.name = "hemisphere-fill-light";
  scene.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xfff2d2, 2.85);
  sun.name = "key-sun-light";
  sun.position.set(7.8, 8.6, 2.2);
  sun.castShadow = true;
  const half = options.shadowFrustumHalfSize ?? 8.2;
  sun.shadow.camera.left = -half;
  sun.shadow.camera.right = half;
  sun.shadow.camera.top = half;
  sun.shadow.camera.bottom = -half;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 26;
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.014;
  sun.shadow.radius = 2.4;
  scene.add(sun);

  const skyFill = new THREE.DirectionalLight(0xd6e8ff, 0.24);
  skyFill.name = "sky-rim-fill-light";
  skyFill.position.set(-5.6, 6.2, -3.4);
  scene.add(skyFill);

  const shadowPlaneGeo = new THREE.PlaneGeometry(36, 36);
  shadowPlaneGeo.rotateX(-Math.PI * 0.5);
  const shadowPlaneMat = new THREE.ShadowMaterial({
    color: 0x000000,
    opacity: 0.25,
    depthWrite: false,
  });
  const exteriorShadowPlane = new THREE.Mesh(shadowPlaneGeo, shadowPlaneMat);
  exteriorShadowPlane.name = "exterior-shadow-plane";
  exteriorShadowPlane.position.y = options.exteriorShadowPlaneY ?? -0.092;
  exteriorShadowPlane.receiveShadow = true;
  exteriorShadowPlane.userData.excludeFromAo = true;
  exteriorShadowPlane.raycast = noopRaycast;
  scene.add(exteriorShadowPlane);

  const supportsFloatRt =
    renderer.capabilities.isWebGL2 &&
    (renderer.extensions.has("EXT_color_buffer_float") ||
      renderer.extensions.has("EXT_color_buffer_half_float"));
  const samples = supportsFloatRt
    ? Math.min(4, renderer.capabilities.maxSamples)
    : 0;
  const composerTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: supportsFloatRt ? THREE.HalfFloatType : THREE.UnsignedByteType,
    samples,
  });

  const composer = new EffectComposer(renderer, composerTarget);
  const renderPass = new RenderPass(scene, initialCamera);
  renderPass.clearColor = new THREE.Color(0x000000);
  renderPass.clearAlpha = 0;

  const gtaoPass = new SceneGTAOPass(scene, initialCamera, 1, 1);
  gtaoPass.gtaoMaterial.fragmentShader =
    gtaoPass.gtaoMaterial.fragmentShader.replace(
      "vec3 viewDir = normalize(-viewPos.xyz);",
      "#if PERSPECTIVE_CAMERA == 1\n\t\t\t\tvec3 viewDir = normalize(-viewPos.xyz);\n\t\t\t\t#else\n\t\t\t\tvec3 viewDir = vec3(0.0, 0.0, 1.0);\n\t\t\t\t#endif",
    );
  gtaoPass.gtaoMaterial.needsUpdate = true;
  gtaoPass.blendIntensity = 0.85;
  gtaoPass.updateGtaoMaterial({
    radius: 0.38,
    distanceExponent: 1.4,
    thickness: 0.45,
    scale: 1.15,
    samples: 16,
    distanceFallOff: 1.0,
    screenSpaceRadius: false,
  });
  gtaoPass.updatePdMaterial({
    lumaPhi: 10,
    depthPhi: 2,
    normalPhi: 3,
    radius: 6,
    radiusExponent: 2,
    rings: 2,
    samples: 16,
  });

  const outputPass = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(gtaoPass);
  composer.addPass(outputPass);

  const sizeVec = new THREE.Vector2();
  let syncedWidth = 0;
  let syncedHeight = 0;
  let syncedPixelRatio = 0;
  let activeCamera: THREE.Camera = initialCamera;

  const syncCamera = (camera: THREE.Camera): void => {
    if (camera === activeCamera) return;
    activeCamera = camera;
    renderPass.camera = camera;
    gtaoPass.camera = camera;
    const nextPersp = isPerspective(camera) ? 1 : 0;
    if (gtaoPass.gtaoMaterial.defines.PERSPECTIVE_CAMERA !== nextPersp) {
      gtaoPass.gtaoMaterial.defines.PERSPECTIVE_CAMERA = nextPersp;
      gtaoPass.depthRenderMaterial.defines.PERSPECTIVE_CAMERA = nextPersp;
      gtaoPass.gtaoMaterial.needsUpdate = true;
      gtaoPass.depthRenderMaterial.needsUpdate = true;
    }
  };

  const render = (camera: THREE.Camera = activeCamera): void => {
    syncCamera(camera);
    renderer.getSize(sizeVec);
    const pr = renderer.getPixelRatio();
    const w = Math.max(1, Math.round(sizeVec.x));
    const h = Math.max(1, Math.round(sizeVec.y));
    if (w !== syncedWidth || h !== syncedHeight || pr !== syncedPixelRatio) {
      syncedWidth = w;
      syncedHeight = h;
      syncedPixelRatio = pr;
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
    }
    composer.render();
  };

  return {
    environment,
    sun,
    exteriorShadowPlane,
    render,
    setExteriorPlaneY(y: number): void {
      exteriorShadowPlane.position.y = y;
    },
    setDarkTheme(dark: boolean): void {
      shadowPlaneMat.opacity = dark ? 0.38 : 0.25;
      hemisphere.intensity = dark ? 0.42 : 0.52;
      scene.environmentIntensity = dark ? 0.38 : 0.54;
    },
    dispose(): void {
      gtaoPass.dispose();
      outputPass.dispose();
      composer.dispose();
      environment.dispose();
      shadowPlaneGeo.dispose();
      shadowPlaneMat.dispose();
    },
  };
}

const FLOOR_SURFACE_NAMES = new Set([
  "storefront-sidewalk-apron",
  "storefront-street-gutter",
]);

/** Enables shadow casting and receiving on all opaque meshes under `root`. */
export function enableShadowMeshes(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    if (node.userData.excludeFromAo === true) return;
    const materials: readonly THREE.Material[] = Array.isArray(node.material)
      ? node.material
      : [node.material];
    const isTransparent = materials.some(
      (mat) => mat.transparent && mat.opacity < 0.85,
    );
    const isFloorSurface =
      node.name.startsWith("zone:") || FLOOR_SURFACE_NAMES.has(node.name);
    if (!isTransparent && !isFloorSurface) {
      node.castShadow = true;
    }
    node.receiveShadow = true;
  });
}
