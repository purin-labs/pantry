import { sha256Hex } from "@purin-labs/std";
import type * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { enableShadowMeshes } from "./scene-lighting";

const verifiedBytesCache = new Map<string, Promise<ArrayBuffer>>();

function fetchVerifiedBytes(
  url: string,
  fingerprint: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const key = `${url}#${fingerprint}`;
  const cached = verifiedBytesCache.get(key);
  if (cached !== undefined) return cached;
  const promise = (async () => {
    const response = await fetch(url, signal ? { signal } : undefined);
    if (!response.ok) throw new Error("Unable to load workcell visual.");
    const bytes = await response.arrayBuffer();
    if ((await sha256Hex(bytes)) !== fingerprint) {
      throw new Error("Workcell visual fingerprint mismatch.");
    }
    return bytes;
  })().catch((error: unknown) => {
    verifiedBytesCache.delete(key);
    throw error;
  });
  verifiedBytesCache.set(key, promise);
  return promise;
}

export function preloadVisual(url: string, fingerprint: string): void {
  void fetchVerifiedBytes(url, fingerprint).catch(() => {
    /* Surface any load error when the scene mounts. */
  });
}

export async function loadVisual(
  url: string,
  fingerprint: string,
  signal: AbortSignal,
): Promise<THREE.Group> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const bytes = await fetchVerifiedBytes(url, fingerprint);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const gltf = await new GLTFLoader().parseAsync(bytes.slice(0), "");
  enableShadowMeshes(gltf.scene);
  return gltf.scene;
}
