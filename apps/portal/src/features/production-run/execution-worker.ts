import {
  HOST_PROTOCOL_VERSION,
  MODEL_INDEX_FILE,
  cachedTransport,
  createExecutionHost,
  mountPack,
  packOf,
  parseExecutionManifest,
  parseModelIndex,
  wasmTextTransport,
  withModelPacks,
  type CellModule,
  type CellTransport,
  type ExecutionHost,
  type ExecutionManifest,
  type ModelIndex,
  type ModelPackEntry,
  type PackFileSystem,
  type PhysicsResultStore,
  type RetainedFile,
} from "@seams/production-simulation/execution-entry";
import { assertNever, isRecord, parseJson, sha256Hex } from "@seams/std";
import createBakeryModule from "bakery-runtime-module";
import {
  parsePersistentCell,
  type PersistentCell,
} from "@seams/bakery-model/bakery-physics";
import { checkpointBody } from "@seams/bakery-model/bakery-checkpoint";
import { workerResultStore } from "./opfs-result-files";
import { EnginePrograms } from "./engine-programs";

/**
 * The browser worker of a retained execution bundle. It is compiled with the
 * engine and the controller's loader into the bundle's one module, so a
 * Portal built from later source starts it and speaks only the host protocol.
 *
 * The module also exports the engine, for a host that is not a worker.
 */
export * from "@seams/production-simulation/execution-entry";

type Runtime = CellModule &
  Readonly<{
    FS: PackFileSystem &
      Readonly<{
        readFile(path: string, options: Readonly<{ encoding: "utf8" }>): string;
        readFile(path: string): Uint8Array;
      }>;
  }>;

type Booted = {
  runtime: Runtime;
  /** The host protocol as text, past the result cache. */
  raw: Readonly<{ exchange(command: string): Promise<string> }>;
  host: ExecutionHost;
  transport: CellTransport;
  results: PhysicsResultStore;
  programs: EnginePrograms;
  /** The checked bytes: a new module starts from them with no fetch. */
  compiled: WebAssembly.Module;
  /** The one data file of a runtime from before model packs. */
  data: ArrayBuffer | null;
  models: Models | null;
  runtimeUrl: string;
  namespace: string;
};

function isRuntime(value: unknown): value is Runtime {
  return (
    isRecord(value) &&
    typeof value._bakery_cell_command === "function" &&
    isRecord(value.FS)
  );
}

function refused(reason: string, detail: unknown) {
  return { kind: "refused", reason, detail } as const;
}

// The worker runs only bytes its manifest names.
async function fetchVerified(
  base: string,
  file: RetainedFile,
): Promise<ArrayBuffer> {
  const response = await fetch(`${base}/${file.file}`, {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`${file.file} is unavailable`);
  const bytes = await response.arrayBuffer();
  if (
    bytes.byteLength !== file.byteLength ||
    (await sha256Hex(new Uint8Array(bytes))) !== file.sha256
  )
    throw new Error(`${file.file} failed its integrity check`);
  return bytes;
}

/** The bytes the page already fetched, checked again, or a verified fetch. */
async function runtimeBytes(
  base: string,
  file: RetainedFile,
  supplied: unknown,
): Promise<ArrayBuffer> {
  const bytes = isRecord(supplied) ? supplied[file.file] : undefined;
  if (!(bytes instanceof ArrayBuffer)) return fetchVerified(base, file);
  if (
    bytes.byteLength !== file.byteLength ||
    (await sha256Hex(new Uint8Array(bytes))) !== file.sha256
  )
    throw new Error(`${file.file} failed its integrity check`);
  return bytes;
}

function runtimeFile(
  manifest: ExecutionManifest,
  suffix: string,
): RetainedFile {
  for (const file of manifest.runtime.files)
    if (file.file.endsWith(suffix)) return file;
  throw new Error(`The runtime names no ${suffix} file`);
}

/**
 * The model packs of a runtime (Refactor 16, step 11). The worker fetches
 * and checks each pack once, when a job first needs one of its files, and
 * keeps the checked bytes. The engine does not hash them again.
 */
class Models {
  private readonly kept = new Map<string, Uint8Array>();
  private readonly mounted = new Set<string>();

  constructor(
    private readonly runtimeUrl: string,
    private readonly index: ModelIndex,
    private readonly files: ReadonlyMap<string, RetainedFile>,
  ) {}

  static async open(
    manifest: ExecutionManifest,
    runtimeUrl: string,
    file: RetainedFile,
  ): Promise<Models> {
    const index = parseModelIndex(
      new TextDecoder().decode(await fetchVerified(runtimeUrl, file)),
    );
    if (index === null) throw new Error("The model index is not readable.");
    const files = new Map<string, RetainedFile>();
    for (const named of manifest.runtime.files) files.set(named.file, named);
    return new Models(runtimeUrl, index, files);
  }

  /** The core pack, which every module mounts when it starts. */
  async start(fs: PackFileSystem): Promise<void> {
    const core = this.index.packs.find((pack) => pack.name === this.index.core);
    if (core === undefined) throw new Error("The model index has no core.");
    await this.mount(fs, core);
  }

  /** Mounts the pack that holds `path`; false if none or if it is there. */
  async mountFor(fs: PackFileSystem, path: string): Promise<boolean> {
    const pack = packOf(this.index, path);
    if (pack === null || this.mounted.has(pack.name)) return false;
    await this.mount(fs, pack);
    return true;
  }

  /** A new module after a fault: the kept packs, with no fetch and no hash. */
  restart(fs: PackFileSystem): void {
    this.mounted.clear();
    for (const [name, bytes] of this.kept) {
      mountPack(fs, bytes);
      this.mounted.add(name);
    }
  }

  private async mount(fs: PackFileSystem, pack: ModelPackEntry) {
    let bytes = this.kept.get(pack.name);
    if (bytes === undefined) {
      const file = this.files.get(pack.file);
      if (file === undefined)
        throw new Error(`The runtime names no ${pack.file}`);
      bytes = new Uint8Array(await fetchVerified(this.runtimeUrl, file));
      this.kept.set(pack.name, bytes);
    }
    mountPack(fs, bytes);
    this.mounted.add(pack.name);
  }
}

async function instantiate(
  compiled: WebAssembly.Module,
  data: ArrayBuffer | null,
  runtimeUrl: string,
): Promise<unknown> {
  return createBakeryModule({
    // Both files are supplied; the loader has nothing left to locate.
    locateFile(path: string): string {
      return `${runtimeUrl}/${path}`;
    },
    instantiateWasm(
      imports: WebAssembly.Imports,
      receive: (
        instance: WebAssembly.Instance,
        module: WebAssembly.Module,
      ) => void,
    ): Record<string, never> {
      void WebAssembly.instantiate(compiled, imports).then((instance) =>
        receive(instance, compiled),
      );
      return {};
    },
    // A copy: a later module must not share a buffer with this one. A
    // runtime of model packs has no data file.
    ...(data === null
      ? {}
      : {
          getPreloadedPackage(): ArrayBuffer {
            return data.slice(0);
          },
        }),
  });
}

/** The module's protocol stack: the result cache, the host and the jobs. */
function connect(
  runtime: Runtime,
  results: PhysicsResultStore,
  namespace: string,
  models: Models | null,
) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const module = wasmTextTransport(runtime, {
    encode: encoder.encode.bind(encoder),
    decode: decoder.decode.bind(decoder),
  });
  const raw =
    models === null
      ? module
      : withModelPacks(module, (path) => models.mountFor(runtime.FS, path));
  // A run after an edit reuses each physics result whose command history is
  // unchanged (Refactor 16, step 4). The key names this engine build.
  const transport = cachedTransport(raw, results, namespace);
  return {
    raw,
    transport,
    host: createExecutionHost(transport),
    programs: new EnginePrograms({
      exchange: raw.exchange.bind(raw),
      readFile: runtime.FS.readFile.bind(runtime.FS),
    }),
  };
}

async function boot(
  manifestInput: unknown,
  runtimeUrl: unknown,
  supplied: unknown,
) {
  const manifest = await parseExecutionManifest(manifestInput);
  if (!manifest.ok) return refused("invalid_manifest", manifest.error);
  if (typeof runtimeUrl !== "string") return refused("invalid_boot", null);
  const index = manifest.value.runtime.files.find(
    (file) => file.file === MODEL_INDEX_FILE,
  );
  const [wasm, data, models] = await Promise.all([
    runtimeBytes(runtimeUrl, runtimeFile(manifest.value, ".wasm"), supplied),
    index === undefined
      ? runtimeBytes(runtimeUrl, runtimeFile(manifest.value, ".data"), supplied)
      : null,
    index === undefined ? null : Models.open(manifest.value, runtimeUrl, index),
  ]);
  const compiled = await WebAssembly.compile(wasm);
  const runtime = await instantiate(compiled, data, runtimeUrl);
  if (!isRuntime(runtime)) return refused("runtime_not_started", null);
  await models?.start(runtime.FS);
  const bundle = manifest.value.bundle;
  const results = await workerResultStore();
  const namespace = `${bundle.controllerHash}:${bundle.runtimeHash}`;
  booted = {
    runtime,
    results,
    compiled,
    data,
    models,
    runtimeUrl,
    namespace,
    ...connect(runtime, results, namespace, models),
  };
  return {
    kind: "booted",
    protocolVersion: HOST_PROTOCOL_VERSION,
    bundle: manifest.value.bundle.id,
  } as const;
}

/**
 * A new module from the kept bytes, after a fault left the old one unusable.
 * Every world of the old module is lost; nothing is fetched again.
 */
async function reset(state: Booted) {
  const runtime = await instantiate(
    state.compiled,
    state.data,
    state.runtimeUrl,
  );
  if (!isRuntime(runtime)) return refused("runtime_not_started", null);
  state.models?.restart(runtime.FS);
  Object.assign(
    state,
    { runtime },
    connect(runtime, state.results, state.namespace, state.models),
  );
  return { kind: "reset" } as const;
}

let booted: Booted | null = null;

/** Reads the geometry packaged with this live cell's exact retained runtime. */
async function scene(state: Booted, cellId: unknown): Promise<unknown> {
  if (typeof cellId !== "string") return refused("invalid_cell", null);
  const exported = await exportCell(state.transport, cellId);
  if (
    !isRecord(exported) ||
    exported.kind !== "exported" ||
    typeof exported.content !== "string"
  )
    return refused("scene_unavailable", null);
  const body = checkpointBody(JSON.parse(exported.content));
  const cell = body === null ? null : parsePersistentCell(body.definition);
  if (cell === null || cell.cellId !== cellId)
    return refused("scene_unavailable", null);
  if (cell.fixture === "persistent-espresso/1")
    return refused("scene_is_appliance", null);
  const stem =
    cell.fixture === "persistent-pour-over/1"
      ? "pour-over-station"
      : `${sceneStem(cell.fixture)}-nominal`;
  const setup: unknown = JSON.parse(
    state.runtime.FS.readFile(
      `/assets/bakery-mujoco/fr10-workcell/native/${cell.robot}/${stem}.json`,
      { encoding: "utf8" },
    ),
  );
  const assets: unknown = JSON.parse(
    state.runtime.FS.readFile(
      "/assets/bakery-mujoco/fr10-workcell/native/assets.json",
      { encoding: "utf8" },
    ),
  );
  if (!isRecord(assets)) return refused("scene_unavailable", null);
  return {
    kind: "scene",
    version: 1,
    cell: cell.cellId,
    modelHash: cell.modelHash,
    robotGlbSha256: assets[`assets/bakery-robots/${cell.robot}/robot.glb`],
    setup,
  };
}

/** A robot cell answers directly; a station answers in its own namespace. */
async function exportCell(
  transport: CellTransport,
  cell: string,
): Promise<unknown> {
  const robot = await transport.send({ op: "export", cell });
  if (isRecord(robot) && robot.kind === "exported") return robot;
  const station = await transport.send({
    op: "pour-over",
    command: { op: "export", cell },
  });
  return isRecord(station) && station.kind === "pour-over"
    ? station.reply
    : station;
}

function sceneStem(
  fixture: Exclude<
    PersistentCell["fixture"],
    "persistent-espresso/1" | "persistent-pour-over/1"
  >,
): string {
  switch (fixture) {
    case "persistent-oven-rack/1":
      return "combined";
    case "persistent-pan-staging/1":
      return "pan-staging";
    case "persistent-rack/1":
      return "table-to-rack";
    default:
      return assertNever(fixture);
  }
}

// A cell definition as this runtime pins it to its own build.
async function define(
  state: Booted,
  request: Readonly<Record<string, unknown>>,
) {
  const cell = request.cell;
  const fixture = request.fixture ?? "rack";
  const robot = request.robot ?? "fairino-fr10";
  if (typeof cell !== "string" || !/^[A-Za-z0-9_-]{1,80}$/u.test(cell))
    return refused("invalid_cell", null);
  if (
    (fixture !== "rack" &&
      fixture !== "oven-rack" &&
      fixture !== "pan-staging" &&
      fixture !== "espresso" &&
      fixture !== "pour-over") ||
    typeof robot !== "string"
  )
    return refused("invalid_cell_configuration", null);
  if (
    fixture === "espresso" &&
    request.appliance !== "linea" &&
    request.appliance !== "eagle-one"
  )
    return refused("invalid_cell_configuration", null);
  const station = request.station;
  if (
    fixture === "pour-over" &&
    (!isRecord(station) ||
      typeof station.kettleWaterG !== "number" ||
      !Number.isInteger(station.kettleWaterG) ||
      (station.drainage !== "nominal" && station.drainage !== "reduced") ||
      (station.fault !== "none" && station.fault !== "lost-grip"))
  )
    return refused("invalid_cell_configuration", null);
  const definition =
    fixture === "pour-over" && isRecord(station)
      ? {
          fixture,
          cell,
          kettleWaterG: station.kettleWaterG,
          drainage: station.drainage,
          fault: station.fault,
        }
      : fixture === "espresso"
        ? { fixture, cell, appliance: request.appliance }
        : { fixture, cell, robot };
  const reply = parseJson(
    await state.raw.exchange(JSON.stringify({ op: "define", definition })),
  );
  if (!isRecord(reply) || reply.kind !== "defined")
    return refused("invalid_cell_configuration", null);
  return { kind: "defined", definition: reply.definition } as const;
}

async function runAppliance(
  state: Booted,
  request: Readonly<Record<string, unknown>>,
) {
  if (
    typeof request.file !== "string" ||
    request.file.length < 2 ||
    request.file.length > 16 * 1024 * 1024
  )
    return refused("invalid_appliance_request", null);
  const input = parseJson(request.file);
  if (!isRecord(input)) return refused("invalid_appliance_request", null);
  const reply = parseJson(
    await state.raw.exchange(
      JSON.stringify({ op: "appliance", request: input }),
    ),
  );
  if (
    !isRecord(reply) ||
    reply.kind !== "appliance" ||
    typeof reply.file !== "string"
  )
    return refused(
      "appliance_execution_failed",
      isRecord(reply) ? reply.message : null,
    );
  return { kind: "appliance-result", file: reply.file } as const;
}

/** A one-shot job: open, start, advance and close (engine-programs.ts). */
function job(state: Booted, request: Readonly<Record<string, unknown>>) {
  const id = request.job;
  if (typeof id !== "string" || !/^[a-z0-9-]{1,80}$/u.test(id))
    return Promise.resolve(refused("invalid_job", null));
  switch (request.kind) {
    case "job-open":
      return state.programs.open(id, request.task);
    case "job-start":
      return state.programs.start(id);
    case "job-advance":
      return typeof request.steps === "number" &&
        Number.isSafeInteger(request.steps) &&
        request.steps >= 1 &&
        request.steps <= 100_000
        ? state.programs.advance(id, request.steps)
        : Promise.resolve(refused("invalid_job", null));
    default:
      return state.programs.close(id);
  }
}

async function answer(request: unknown): Promise<unknown> {
  if (!isRecord(request)) return refused("invalid_request", null);
  if (request.kind === "boot") {
    if (booted !== null) return refused("already_booted", null);
    return boot(request.manifest, request.runtimeUrl, request.files);
  }
  if (booted === null) return refused("not_booted", null);
  if (request.kind === "define") return define(booted, request);
  if (request.kind === "scene") return scene(booted, request.cell);
  if (request.kind === "appliance-run") return runAppliance(booted, request);
  if (request.kind === "reset") return reset(booted);
  if (
    request.kind === "job-open" ||
    request.kind === "job-start" ||
    request.kind === "job-advance" ||
    request.kind === "job-close"
  )
    return job(booted, request);
  if (request.kind === "pour-over-observation") {
    if (typeof request.cell !== "string") return refused("invalid_cell", null);
    const reply = await booted.transport.send({
      op: "pour-over",
      command: { op: "observe", cell: request.cell },
    });
    return isRecord(reply) && reply.kind === "pour-over" ? reply.reply : reply;
  }
  if (request.kind === "appliance-observation") {
    if (typeof request.cell !== "string") return refused("invalid_cell", null);
    const reply = await booted.transport.send({
      op: "espresso",
      command: { op: "observe", cell: request.cell },
    });
    return isRecord(reply) && reply.kind === "espresso" ? reply.reply : reply;
  }
  const reply = await booted.host.handle(request);
  // Other workers and later pages read the results after a run ends.
  if (
    reply.kind === "disposed" ||
    (reply.kind === "drove" && ended(reply.view))
  )
    void booted.results.flush();
  return reply;
}

function ended(
  view: Readonly<{ status: Readonly<{ kind: string }> }>,
): boolean {
  return (
    view.status.kind === "completed" ||
    view.status.kind === "blocked" ||
    view.status.kind === "stopped-at-limit"
  );
}

async function handleMessage(event: MessageEvent<unknown>): Promise<void> {
  const message = event.data;
  if (!isRecord(message) || typeof message.requestId !== "number") return;
  let reply: unknown;
  try {
    reply = await answer(message.request);
  } catch (error) {
    reply = refused(
      "worker_fault",
      error instanceof Error ? error.message : "The worker failed",
    );
  }
  if (
    isRecord(reply) &&
    reply.kind === "artifact" &&
    isRecord(reply.artifact)
  ) {
    const artifact = reply.artifact;
    const bytes = new TextEncoder().encode(
      JSON.stringify({ digest: artifact.digest, content: artifact.content }),
    );
    postMessage(
      {
        requestId: message.requestId,
        reply: {
          kind: "artifact",
          artifact: { digest: artifact.digest, bytes: bytes.buffer },
        },
      },
      { transfer: [bytes.buffer] },
    );
    return;
  }
  postMessage({ requestId: message.requestId, reply });
}

if ("WorkerGlobalScope" in globalThis) self.onmessage = handleMessage;
