// A Node host for the same retained Wasm engine used by the Portal worker.
// Files outlive the process. The engine owns simulation state and scheduling.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseExecutionManifest,
  resolveExecution,
} from "../../packages/production-simulation/src/execution-bundle.ts";
import { parseSha256Hex } from "../../packages/production-simulation/src/identity.ts";
import { checkpointBody } from "../../packages/bakery-model/src/bakery-checkpoint.ts";
import { runtimeModule } from "./build-execution-bundle.mjs";

function value(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

async function measure(path) {
  const hash = createHash("sha256");
  let byteLength = 0;
  try {
    for await (const bytes of createReadStream(path)) {
      hash.update(bytes);
      byteLength += bytes.length;
    }
    return { sha256: hash.digest("hex"), byteLength };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function measureRetained(paths, manifest, file, part) {
  const directory =
    part === "engine"
      ? join(paths.executions, manifest.bundle.id)
      : join(paths.runtimes, manifest.runtime.id);
  return measure(join(directory, file.file));
}

async function verifyFile(path, entry) {
  const found = await measure(path);
  if (
    found === null ||
    found.sha256 !== entry.digest ||
    found.byteLength !== entry.byteLength
  )
    throw new Error(`Artifact ${entry.digest} is missing or altered.`);
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(directory, name, content) {
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.pending`);
  const handle = await open(temporary, "wx");
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(directory, name));
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Opens the execution bundle of this release: the one build that the host
 * runs. It resolves and verifies all its files before it imports executable
 * code. A save of another build needs no file of that build (Refactor 16,
 * step 8).
 */
export async function openFileExecution(paths, bundleId, artifacts) {
  const id = value(parseSha256Hex(bundleId));
  const manifest = value(
    await parseExecutionManifest(
      JSON.parse(
        await readFile(join(paths.executions, id, "execution.json"), "utf8"),
      ),
    ),
  );
  value(
    await resolveExecution(
      manifest.bundle,
      "browser",
      [manifest],
      measureRetained.bind(null, paths),
    ),
  );
  // Version 2 added the acknowledged artifact transfer, which this host uses.
  if (manifest.bundle.protocolVersion < 2)
    throw new Error("This host requires the acknowledged artifact protocol.");
  const engine = await import(
    pathToFileURL(join(paths.executions, id, manifest.engine.file)).href
  );
  const runtime = join(paths.runtimes, manifest.runtime.id);
  if (!manifest.runtime.files.some(isLoader))
    throw new Error("The runtime loader is missing.");
  // The bundle's own loader; a bundle of packs gets its packs mounted.
  const module = await runtimeModule(runtime);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const transport = engine.wasmTransport(module, {
    encode: encoder.encode.bind(encoder),
    decode: decoder.decode.bind(decoder),
  });
  const advances = { buckets: new Uint32Array(1001), count: 0, maxMs: 0 };
  const host = engine.createExecutionHost({
    send: measuredSend.bind(null, transport, advances),
  });
  if (host.protocolVersion !== manifest.bundle.protocolVersion)
    throw new Error("The retained module reports a different host protocol.");
  return new FileExecutionHost(
    host,
    engine,
    manifest,
    module,
    artifacts,
    advances,
  );
}

// Fixed-size latency counters do not retain a sample for every physics step.
async function measuredSend(transport, advances, command) {
  const started = performance.now();
  const reply = await transport.send(command);
  if (command.op === "advance") {
    const elapsed = performance.now() - started;
    advances.count += 1;
    advances.maxMs = Math.max(advances.maxMs, elapsed);
    advances.buckets[Math.min(1000, Math.floor(elapsed * 20))] += 1;
  }
  return reply;
}

function percentileUpperBound(advances, fraction) {
  if (advances.count === 0) return null;
  const threshold = Math.ceil(advances.count * fraction);
  let seen = 0;
  for (let index = 0; index < advances.buckets.length; index += 1) {
    seen += advances.buckets[index];
    if (seen >= threshold)
      return index === 1000 ? advances.maxMs : (index + 1) / 20;
  }
  throw new Error("Advance latency counters are inconsistent.");
}

function isLoader(file) {
  return file.file === "bakery-native.js";
}

class FileExecutionHost {
  #host;
  #engine;
  #module;
  #artifacts;
  #began = false;
  #busy = false;
  #advances;
  manifest;
  writtenBytes = 0;
  peakArtifactBytes = 0;

  constructor(host, engine, manifest, module, artifacts, advances) {
    this.#host = host;
    this.#engine = engine;
    this.#module = module;
    this.#artifacts = artifacts;
    this.manifest = manifest;
    this.#advances = advances;
  }

  get advanceMetrics() {
    return {
      calls: this.#advances.count,
      p95UpperBoundMs: percentileUpperBound(this.#advances, 0.95),
      p99UpperBoundMs: percentileUpperBound(this.#advances, 0.99),
      maxMs: this.#advances.maxMs,
      histogramResolutionMs: 0.05,
    };
  }

  get wasmBytes() {
    return this.#module.HEAPU8.byteLength;
  }

  /**
   * The origin of a continued run, and the definition of each saved cell. A
   * save of this build restores its checkpoints. A save of another build, or
   * `replay`, gives its inputs to this build, which runs them again.
   */
  async readSave(raw, replay) {
    const document = value(await this.#engine.openSaved(raw));
    const exact = !replay && document.bundle.id === this.manifest.bundle.id;
    if (exact)
      value(
        await this.#engine.openResumable(raw, "browser", [
          this.manifest.bundle,
        ]),
      );
    const checkpoints = [];
    const cells = [];
    for (const entry of document.artifacts) {
      // A replay reads only the checkpoints: each one holds its cell.
      if (!exact && entry.role !== "cell-checkpoint") continue;
      const path = join(this.#artifacts, entry.digest);
      await verifyFile(path, entry);
      if (entry.role !== "cell-checkpoint") continue;
      const content = await readFile(path, "utf8");
      checkpoints.push({ digest: entry.digest, content });
      // A checkpoint since Refactor 16 step 6 is an envelope; the shared
      // reader takes both shapes, as the Portal does.
      const body = checkpointBody(JSON.parse(content));
      if (body === null) throw new Error("A checkpoint has no definition.");
      cells.push(body.definition);
    }
    return {
      cells,
      document,
      origin: exact
        ? { kind: "snapshot", document, checkpoints }
        : { kind: "replay", document },
    };
  }

  async #drain() {
    let acknowledged = null;
    for (;;) {
      const reply = await this.#host.handle({ kind: "artifact", acknowledged });
      if (reply.kind !== "artifact") throw new Error(JSON.stringify(reply));
      const artifact = reply.artifact;
      if (artifact === null) return;
      if (
        !/^[a-f0-9]{64}$/u.test(artifact.digest) ||
        Buffer.byteLength(artifact.content) !== artifact.byteLength ||
        createHash("sha256").update(artifact.content).digest("hex") !==
          artifact.digest
      )
        throw new Error("The engine offered an invalid artifact.");
      this.peakArtifactBytes = Math.max(
        this.peakArtifactBytes,
        artifact.byteLength,
      );
      const path = join(this.#artifacts, artifact.digest);
      const existing = await measure(path);
      if (existing === null) {
        await atomicWrite(this.#artifacts, artifact.digest, artifact.content);
        this.writtenBytes += artifact.byteLength;
      }
      await verifyFile(path, artifact);
      acknowledged = artifact.digest;
    }
  }

  /** Calls are serial. A failed write leaves the offered artifact unacknowledged. */
  async handle(request) {
    if (this.#busy)
      throw new Error("An execution request is already in progress.");
    this.#busy = true;
    try {
      if (this.#began && request.kind !== "dispose") await this.#drain();
      const reply = await this.#host.handle(request);
      if (reply.kind === "disposed") {
        this.#began = false;
        return reply;
      }
      if (reply.kind === "began") this.#began = true;
      if (this.#began) await this.#drain();
      return reply;
    } finally {
      this.#busy = false;
    }
  }

  /** Publish only after every referenced file can be read and verified. */
  async publish(document, directory) {
    const checked = value(
      await this.#engine.openResumable(document, "browser", [
        this.manifest.bundle,
      ]),
    );
    for (const entry of checked.artifacts)
      await verifyFile(join(this.#artifacts, entry.digest), entry);
    await atomicWrite(
      directory,
      `${checked.snapshot}.json`,
      `${JSON.stringify(checked)}\n`,
    );
    return join(directory, `${checked.snapshot}.json`);
  }
}
