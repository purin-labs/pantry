import * as THREE from "three";
import { clone as cloneSkinnedObject } from "three/addons/utils/SkeletonUtils.js";
import { loadVisual, preloadVisual } from "./physics-asset-loader";
import humanPatissierUrl from "../../../../../../assets/bakery-living/human-patissier.glb?url";
import botanicalPlantersUrl from "../../../../../../assets/bakery-living/botanical-planters.glb?url";

export const HUMAN_PATISSIER_GLB_SHA256 =
  "ae7bdcdb270932b4dd430b9a53640275691f77ae55fbc6873038abf06e50d9ae";
export const BOTANICAL_PLANTERS_GLB_SHA256 =
  "4d3aeea2326cb10f2f21badd9aba9174e0798c341061840b79dd65b4838c7ddf";

export type LivingAssetTemplates = Readonly<{
  humanScene: THREE.Group;
  plantersScene: THREE.Group;
}>;

let cachedTemplates: LivingAssetTemplates | null = null;
let loadingPromise: Promise<LivingAssetTemplates> | null = null;
const readyListeners = new Set<() => void>();

export function getCachedLivingAssets(): LivingAssetTemplates | null {
  return cachedTemplates;
}

export function onLivingAssetsReady(listener: () => void): () => void {
  if (cachedTemplates !== null) {
    listener();
    return () => {};
  }
  readyListeners.add(listener);
  return () => {
    readyListeners.delete(listener);
  };
}

export function ensureLivingAssetsLoaded(
  signal?: AbortSignal,
): Promise<LivingAssetTemplates> {
  if (cachedTemplates !== null) return Promise.resolve(cachedTemplates);
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  if (loadingPromise === null) {
    const internalAbort = new AbortController();
    loadingPromise = Promise.all([
      loadVisual(
        humanPatissierUrl,
        HUMAN_PATISSIER_GLB_SHA256,
        internalAbort.signal,
      ),
      loadVisual(
        botanicalPlantersUrl,
        BOTANICAL_PLANTERS_GLB_SHA256,
        internalAbort.signal,
      ),
    ])
      .then(([humanScene, plantersScene]) => {
        humanScene.updateMatrixWorld(true);
        plantersScene.updateMatrixWorld(true);
        const templates: LivingAssetTemplates = { humanScene, plantersScene };
        cachedTemplates = templates;
        for (const fn of readyListeners) fn();
        readyListeners.clear();
        return templates;
      })
      .catch((error: unknown) => {
        loadingPromise = null;
        throw error;
      });
  }
  if (!signal) return loadingPromise;
  return new Promise<LivingAssetTemplates>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    loadingPromise!
      .then((res) => {
        signal.removeEventListener("abort", onAbort);
        resolve(res);
      })
      .catch((err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      });
  });
}

export function withLivingAssets(
  apply: (templates: LivingAssetTemplates) => void,
): void {
  if (cachedTemplates !== null) {
    apply(cachedTemplates);
    return;
  }
  if (typeof fetch !== "function" || typeof crypto === "undefined") return;
  void ensureLivingAssetsLoaded()
    .then(apply)
    .catch(() => {
      /* Handled by scene load boundaries. */
    });
}

function cloneCachedMaterial(
  mat: THREE.Material,
  materialMap: Map<THREE.Material, THREE.Material>,
): THREE.Material {
  const existing = materialMap.get(mat);
  if (existing !== undefined) return existing;
  const cloned = mat.clone();
  materialMap.set(mat, cloned);
  return cloned;
}

/**
 * Clones a rigged or static glTF subtree with owned geometries and materials
 * so per-instance material tinting and disposal never mutate shared templates.
 */
export function cloneOwnedLivingSubtree(
  source: THREE.Object3D,
): THREE.Object3D {
  const cloned = cloneSkinnedObject(source);
  const materialMap = new Map<THREE.Material, THREE.Material>();
  cloned.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.geometry = node.geometry.clone();
      if (Array.isArray(node.material)) {
        node.material = node.material.map((m) =>
          cloneCachedMaterial(m, materialMap),
        );
      } else {
        node.material = cloneCachedMaterial(node.material, materialMap);
      }
      node.castShadow = true;
      node.receiveShadow = true;
    }
    if (node instanceof THREE.SkinnedMesh) {
      node.frustumCulled = false;
    }
  });
  return cloned;
}

if (typeof fetch === "function" && typeof crypto !== "undefined") {
  preloadVisual(humanPatissierUrl, HUMAN_PATISSIER_GLB_SHA256);
  preloadVisual(botanicalPlantersUrl, BOTANICAL_PLANTERS_GLB_SHA256);
  void ensureLivingAssetsLoaded().catch(() => {});
}
