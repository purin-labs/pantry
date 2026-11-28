import { RunArtifactStore } from "./run-artifact-store";
import {
  HOST_PROTOCOL_VERSION,
  parseExecutionManifest,
  parseSha256Hex,
  resolveExecution,
  type ExecutionManifest,
  type ManifestProblem,
  type ResolveProblem,
} from "@purin-labs/production-simulation";
import { isRecord, sha256Hex } from "@purin-labs/std";
import { PRODUCTION_EXECUTION_MANIFEST } from "@purin-labs/production-simulation/execution-manifest";
import { MAX_ENCODED_ARTIFACT_BYTES } from "@purin-labs/production-simulation/runs/run-artifact-file";
import { MODEL_INDEX_FILE } from "@purin-labs/production-simulation/native/model-packs";

/**
 * The Portal's side of a production execution. The Portal runs one engine:
 * the execution bundle that it pins (Refactor 16, step 8). This module
 * checks the files of that bundle, starts its worker and exchanges
 * host-protocol messages with it. A save or a recipe of another build needs
 * no file of that build: the engine runs its inputs again.
 */

const ROOT = `${import.meta.env.BASE_URL}bakery-physics`;

export type ExecutionWorker = Readonly<{
  manifest: ExecutionManifest;
  artifacts: RunArtifactStore;
  /** Sends one protocol request and resolves with the worker's reply. */
  request(request: Readonly<Record<string, unknown>>): Promise<unknown>;
  /** Ends the worker at once. Every world it holds is lost. */
  terminate(): void;
}>;

type ExecutionWorkerProblem =
  | ResolveProblem
  | ManifestProblem
  | Readonly<{ code: "worker_not_started"; detail: unknown }>
  | Readonly<{ code: "artifact_store_unavailable"; detail: string }>
  | Readonly<{ code: "protocol_unsupported"; protocolVersion: unknown }>;

type Opened =
  | Readonly<{ ok: true; value: ExecutionWorker }>
  | Readonly<{ ok: false; error: ExecutionWorkerProblem }>;

/**
 * Fetches and hashes one file of the bundle. The runtime's bytes are kept,
 * so the worker checks them again and does not fetch them a second time.
 */
async function measure(
  kept: Map<string, ArrayBuffer>,
  manifest: ExecutionManifest,
  file: Readonly<{ file: string; sha256: string; byteLength: number }>,
  part: "engine" | "runtime",
): Promise<Readonly<{ sha256: string; byteLength: number }> | null> {
  // A runtime of model packs (Refactor 16, step 11): its worker fetches and
  // checks the Wasm, the index and each pack once, when a job needs it. The
  // page does not fetch them, so a job loads only the models that it uses.
  if (
    part === "runtime" &&
    manifest.runtime.files.some((named) => named.file === MODEL_INDEX_FILE)
  )
    return { sha256: file.sha256, byteLength: file.byteLength };
  const response = await fetch(
    part === "engine"
      ? `${ROOT}/executions/${manifest.bundle.id}/${file.file}`
      : `${ROOT}/bundles/${manifest.runtime.id}/${file.file}`,
    { credentials: "same-origin" },
  );
  if (!response.ok) return null;
  const buffer = await response.arrayBuffer();
  if (part === "runtime") kept.set(file.file, buffer);
  const bytes = new Uint8Array(buffer);
  return { sha256: await sha256Hex(bytes), byteLength: bytes.byteLength };
}

type Exchange = Readonly<{
  resolve(reply: unknown): void;
  reject(error: Error): void;
}>;

type WorkerLifetime =
  | Readonly<{ kind: "active"; error?: never }>
  | Readonly<{ kind: "closed"; error: Error }>;

/** Serial delivery prevents asynchronous host commands from sharing a turn. */
class WorkerConnection implements ExecutionWorker {
  readonly manifest: ExecutionManifest;
  readonly artifacts: RunArtifactStore;
  private readonly worker: Worker;
  private readonly waiting = new Map<number, Exchange>();
  private lifetime: WorkerLifetime = { kind: "active" };
  private sequence = 0;
  private tail: Promise<void> = Promise.resolve();
  private admission: "empty" | "begun" = "empty";

  constructor(manifest: ExecutionManifest, artifacts: RunArtifactStore) {
    this.manifest = manifest;
    this.artifacts = artifacts;
    this.worker = new Worker(
      `${ROOT}/executions/${manifest.bundle.id}/${manifest.engine.file}`,
      { type: "module" },
    );
    this.worker.onmessage = this.receive.bind(this);
    this.worker.onerror = this.fail.bind(this, "The execution worker failed");
    this.worker.onmessageerror = this.fail.bind(
      this,
      "The execution worker returned an unreadable reply",
    );
  }

  private receive(event: MessageEvent<unknown>): void {
    const message = event.data;
    if (
      !isRecord(message) ||
      !Number.isSafeInteger(message.requestId) ||
      typeof message.requestId !== "number" ||
      !("reply" in message)
    ) {
      this.fail("The execution worker returned an invalid envelope");
      return;
    }
    const exchange = this.waiting.get(message.requestId);
    if (exchange === undefined) {
      this.fail("The execution worker replied to an unknown request");
      return;
    }
    this.waiting.delete(message.requestId);
    exchange.resolve(message.reply);
  }

  private fail(reason: string): void {
    if (this.lifetime.kind === "closed") return;
    const error = new Error(reason);
    this.lifetime = { kind: "closed", error };
    this.worker.terminate();
    for (const exchange of this.waiting.values()) exchange.reject(error);
    this.waiting.clear();
  }

  private send(
    request: Readonly<Record<string, unknown>>,
    resolve: Exchange["resolve"],
    reject: Exchange["reject"],
  ): void {
    if (this.lifetime.kind === "closed") {
      reject(this.lifetime.error);
      return;
    }
    this.sequence += 1;
    this.waiting.set(this.sequence, { resolve, reject });
    try {
      this.worker.postMessage({ requestId: this.sequence, request });
    } catch (error) {
      this.waiting.delete(this.sequence);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private exchange(
    request: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return new Promise(this.send.bind(this, request));
  }

  request(request: Readonly<Record<string, unknown>>): Promise<unknown> {
    const reply = this.tail.then(this.execute.bind(this, request));
    this.tail = reply.then(discardReply, discardReply);
    return reply;
  }

  private async drainArtifacts(): Promise<void> {
    if (this.admission === "empty") return;
    let acknowledged: string | null = null;
    for (;;) {
      const reply = await this.exchange({ kind: "artifact", acknowledged });
      if (!isRecord(reply) || reply.kind !== "artifact")
        throw new Error("The worker could not transfer its retained artifact.");
      if (reply.artifact === null) return;
      const artifact = readArtifactTransfer(reply.artifact);
      await this.artifacts.retain(artifact.digest, artifact.file);
      acknowledged = artifact.digest;
    }
  }

  private async execute(
    request: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    await this.drainArtifacts();
    const reply = await this.exchange(request);
    if (isRecord(reply) && reply.kind === "began") this.admission = "begun";
    if (isRecord(reply) && reply.kind === "disposed") this.admission = "empty";
    if (isRecord(reply) && reply.kind === "refused") return reply;
    await this.drainArtifacts();
    return reply;
  }

  terminate(): void {
    this.fail("The execution worker was terminated");
  }
}

function discardReply(): void {}

function readArtifactTransfer(raw: unknown) {
  if (!isRecord(raw))
    throw new Error("The worker returned an invalid artifact.");
  const digest = parseSha256Hex(raw.digest);
  if (!digest.ok)
    throw new Error("The worker returned an invalid artifact digest.");
  if (!(raw.bytes instanceof ArrayBuffer))
    throw new Error("The worker returned no artifact bytes.");
  const file = new Blob([raw.bytes]);
  if (file.size > MAX_ENCODED_ARTIFACT_BYTES)
    throw new Error("The worker artifact exceeds the transfer limit.");
  return { digest: digest.value, file };
}

/**
 * Starts the worker of the execution bundle that this Portal pins, after a
 * check of each of its files.
 */
export async function openExecutionWorker(): Promise<Opened> {
  const pinned = await parseExecutionManifest(PRODUCTION_EXECUTION_MANIFEST);
  if (!pinned.ok) return pinned;
  const manifest = pinned.value;
  const kept = new Map<string, ArrayBuffer>();
  const resolved = await resolveExecution(
    manifest.bundle,
    "browser",
    [manifest],
    measure.bind(null, kept),
  );
  if (!resolved.ok) return resolved;
  if (manifest.bundle.protocolVersion !== HOST_PROTOCOL_VERSION)
    return {
      ok: false,
      error: {
        code: "protocol_unsupported",
        protocolVersion: manifest.bundle.protocolVersion,
      },
    };
  let artifacts;
  try {
    artifacts = await RunArtifactStore.create();
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "artifact_store_unavailable",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
  const worker = new WorkerConnection(resolved.value, artifacts);
  const booted = await worker.request({
    kind: "boot",
    manifest: resolved.value,
    runtimeUrl: `${ROOT}/bundles/${resolved.value.runtime.id}`,
    files: Object.fromEntries(kept),
  });
  if (!isRecord(booted) || booted.kind !== "booted") {
    worker.terminate();
    return { ok: false, error: { code: "worker_not_started", detail: booted } };
  }
  if (booted.protocolVersion !== manifest.bundle.protocolVersion) {
    worker.terminate();
    return {
      ok: false,
      error: {
        code: "protocol_unsupported",
        protocolVersion: booted.protocolVersion,
      },
    };
  }
  return { ok: true, value: worker };
}
