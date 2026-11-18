import { isRecord, sha256Hex } from "@seams/std";
import {
  exchangeNow,
  type CellModule,
} from "@seams/production-simulation/native/wasm-transport";
import {
  mountPack,
  type PackFileSystem,
} from "@seams/production-simulation/native/model-packs";
import type {
  ApplianceRuntimeBundle,
  RuntimeFile,
} from "@seams/production-simulation/simulator/appliance-runtime";

/**
 * One appliance request on a retained older runtime bundle (Plan 70B): a
 * saved Linea or Eagle state continues only on the bundle that saved it.
 * A bundle from before Refactor 16 step 11 has no host appliance command, so
 * this worker imports the bundle's own verified loader and runs its command
 * line. A bundle of model packs (descriptor schema 2) has no command line:
 * the worker mounts its packs and sends the host's `appliance` command. The
 * present engine runs appliance requests in the engine worker
 * (engine-jobs.ts).
 */

type Legacy = Readonly<{
  callMain(args: string[]): number;
  FS: Readonly<{
    readFile(path: string, options: { encoding: "utf8" }): string;
    writeFile(path: string, contents: string): void;
  }>;
}>;

type Packed = CellModule & Readonly<{ FS: PackFileSystem }>;

const LIMIT = 25 * 1024 * 1024;

function known(bundle: ApplianceRuntimeBundle, path: string): boolean {
  return Object.values(bundle.files).some((file) => file.file === path);
}

function locate(bundle: ApplianceRuntimeBundle, path: string): string {
  if (!known(bundle, path))
    throw new Error("The retained runtime requested an unknown bundle asset.");
  return `/bakery-physics/bundles/${bundle.id}/${path}`;
}

async function fetchVerified(
  bundle: ApplianceRuntimeBundle,
  asset: RuntimeFile,
): Promise<ArrayBuffer> {
  const response = await fetch(locate(bundle, asset.file), {
    credentials: "same-origin",
  });
  if (!response.ok)
    throw new Error("The retained runtime asset is unavailable.");
  const bytes = await response.arrayBuffer();
  if (
    bytes.byteLength > LIMIT ||
    bytes.byteLength !== asset.byteLength ||
    (await sha256Hex(new Uint8Array(bytes))) !== asset.sha256
  )
    throw new Error("The retained runtime asset failed its integrity check.");
  return bytes;
}

async function start(
  bundle: ApplianceRuntimeBundle,
  options: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const module = await fetchVerified(bundle, bundle.files.module);
  // Import exactly the verified bytes; public files bypass Vite's module graph.
  const url = URL.createObjectURL(
    new Blob([module], { type: "text/javascript" }),
  );
  try {
    const namespace: unknown = await import(/* @vite-ignore */ url);
    if (!isRecord(namespace) || typeof namespace.default !== "function")
      throw new Error("Invalid retained runtime module.");
    const runtime: unknown = await namespace.default({
      locateFile: locate.bind(null, bundle),
      ...options,
    });
    if (!isRecord(runtime) || !isRecord(runtime.FS))
      throw new Error("The retained runtime did not initialize.");
    return runtime;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function runLegacy(
  bundle: ApplianceRuntimeBundle,
  data: RuntimeFile,
  file: string,
) {
  const [wasm, bytes] = await Promise.all([
    fetchVerified(bundle, bundle.files.wasm),
    fetchVerified(bundle, data),
  ]);
  const runtime = await start(bundle, {
    wasmBinary: new Uint8Array(wasm),
    getPreloadedPackage: () => bytes,
  });
  if (typeof runtime.callMain !== "function")
    throw new Error("The retained runtime did not initialize.");
  const started = runtime as unknown as Legacy;
  started.FS.writeFile("/appliance-request.json", file);
  const code = started.callMain([
    "--root",
    "/",
    "--output",
    "/appliance-result.json",
    "appliance",
    "/appliance-request.json",
  ]);
  if (code !== 0) throw new Error("The retained appliance run failed.");
  return started.FS.readFile("/appliance-result.json", { encoding: "utf8" });
}

async function runPacked(bundle: ApplianceRuntimeBundle, file: string) {
  const packs = Object.entries(bundle.files)
    .filter(([key]) => key.startsWith("pack:"))
    .map(([, pack]) => pack);
  const [wasm, ...bytes] = await Promise.all([
    fetchVerified(bundle, bundle.files.wasm),
    ...packs.map((pack) => fetchVerified(bundle, pack)),
  ]);
  const runtime = await start(bundle, { wasmBinary: new Uint8Array(wasm) });
  if (typeof runtime._bakery_cell_command !== "function")
    throw new Error("The retained runtime did not initialize.");
  const started = runtime as unknown as Packed;
  // An appliance request may name any model; a rare old save loads them all.
  for (const pack of bytes) mountPack(started.FS, new Uint8Array(pack));
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reply: unknown = JSON.parse(
    exchangeNow(
      started,
      {
        encode: encoder.encode.bind(encoder),
        decode: decoder.decode.bind(decoder),
      },
      JSON.stringify({ op: "appliance", request: JSON.parse(file) }),
    ),
  );
  if (
    !isRecord(reply) ||
    reply.kind !== "appliance" ||
    typeof reply.file !== "string"
  )
    throw new Error("The retained appliance run failed.");
  return reply.file;
}

function run(bundle: ApplianceRuntimeBundle, file: string) {
  const data = bundle.files.data;
  return data === undefined
    ? runPacked(bundle, file)
    : runLegacy(bundle, data, file);
}

self.onmessage = async (event: MessageEvent<unknown>) => {
  const input = event.data;
  try {
    if (
      !isRecord(input) ||
      !isRecord(input.bundle) ||
      typeof input.file !== "string"
    )
      throw new Error("Invalid retained appliance job.");
    const file = await run(
      input.bundle as unknown as ApplianceRuntimeBundle,
      input.file,
    );
    postMessage({ kind: "appliance-result", file });
  } catch (error) {
    postMessage({
      kind: "failed",
      message:
        error instanceof Error ? error.message : "The appliance job failed.",
    });
  }
};
