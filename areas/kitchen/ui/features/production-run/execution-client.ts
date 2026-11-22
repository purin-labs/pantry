import { RunArtifactStore } from "./run-artifact-store";
import {
  HOST_PROTOCOL_VERSION,
  parseExecutionManifest,
  parseSha256Hex,
  resolveExecution,
  type ExecutionBundle,
  type ExecutionManifest,
  type ManifestProblem,
  type ResolveProblem,
} from "@purin-labs/production-simulation";
import { isRecord, parseJsonOrNull, sha256Hex } from "@purin-labs/std";
import { PRODUCTION_EXECUTION_MANIFEST } from "@purin-labs/production-simulation/execution-manifest";
import type { PersistentCell } from "@purin-labs/bakery-model/bakery-physics";
import { MAX_ENCODED_ARTIFACT_BYTES } from "@purin-labs/production-simulation/runs/run-artifact-file";
import { MODEL_INDEX_FILE } from "@purin-labs/production-simulation/native/model-packs";

/**
 * The Portal's side of a production execution. It finds the retained bundle
 * a run needs, checks its files, starts that bundle's worker and exchanges
 * host-protocol messages with it. It runs no engine code of its own.
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
  | Readonly<{ code: "fixture_bundle_mismatch" }>
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
    if (
      this.admission === "empty" ||
      this.manifest.bundle.protocolVersion === 1
    )
      return;
    let acknowledged: string | null = null;
    for (;;) {
      const reply = await this.exchange({ kind: "artifact", acknowledged });
      if (!isRecord(reply) || reply.kind !== "artifact")
        throw new Error("The worker could not transfer its retained artifact.");
      if (reply.artifact === null) return;
      const artifact = readArtifactTransfer(reply.artifact, 2);
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
    // Protocol 1 hands all new bytes over at Save. Normalize that retained build here.
    if (
      this.manifest.bundle.protocolVersion === 1 &&
      isRecord(reply) &&
      reply.kind === "saved"
    ) {
      if (!Array.isArray(reply.artifacts))
        throw new Error("The saved reply has no artifacts.");
      for (const raw of reply.artifacts) {
        const artifact = readArtifactTransfer(raw, 1);
        await this.artifacts.retain(artifact.digest, artifact.file);
      }
      return { kind: "saved", document: reply.document, artifacts: [] };
    }
    await this.drainArtifacts();
    return reply;
  }

  terminate(): void {
    this.fail("The execution worker was terminated");
  }
}

function discardReply(): void {}

/** Normalize retained protocol 1 only at the worker response boundary. */
function readArtifactTransfer(raw: unknown, protocol: 1 | 2) {
  if (!isRecord(raw))
    throw new Error("The worker returned an invalid artifact.");
  const digest = parseSha256Hex(raw.digest);
  if (!digest.ok)
    throw new Error("The worker returned an invalid artifact digest.");
  let file: Blob;
  if (protocol === 1) {
    if (
      typeof raw.content !== "string" ||
      raw.content.length > MAX_ENCODED_ARTIFACT_BYTES
    )
      throw new Error("The retained worker returned an invalid artifact.");
    file = new Blob([
      JSON.stringify({ digest: digest.value, content: raw.content }),
    ]);
  } else {
    if (!(raw.bytes instanceof ArrayBuffer))
      throw new Error("The worker returned no artifact bytes.");
    file = new Blob([raw.bytes]);
  }
  if (file.size > MAX_ENCODED_ARTIFACT_BYTES)
    throw new Error("The worker artifact exceeds the transfer limit.");
  return { digest: digest.value, file };
}

/**
 * Starts the worker of the bundle `claim` names, or of the bundle this
 * Portal was built with when a new run begins. Only the exact retained
 * bundle starts: this Portal's own engine never continues another's save.
 */
export async function openExecutionWorker(
  claim: ExecutionBundle | null,
): Promise<Opened> {
  const manifest =
    claim === null
      ? await parseExecutionManifest(PRODUCTION_EXECUTION_MANIFEST)
      : await readExecutionManifest(claim.id);
  if (!manifest.ok) return manifest;
  return startExecutionWorker(manifest.value, claim ?? manifest.value.bundle);
}

/** Start exactly the retained build selected when this recipe was authored. */
export async function openAuthoredCellWorker(
  definition: Readonly<{ cell: PersistentCell; executionBundleId: string }>,
): Promise<Opened> {
  const manifest = await readExecutionManifest(definition.executionBundleId);
  if (!manifest.ok) return manifest;
  const bundle = manifest.value.bundle;
  const cell = definition.cell.execution;
  if (
    bundle.id !== definition.executionBundleId ||
    bundle.backend !== cell.backend ||
    bundle.controllerHash !== cell.controllerHash ||
    bundle.controllerSourceHash !== cell.controllerSourceHash ||
    bundle.runtimeHash !== cell.runtimeHash
  )
    return { ok: false, error: { code: "fixture_bundle_mismatch" } };
  return startExecutionWorker(manifest.value, bundle);
}

async function readExecutionManifest(id: string) {
  const response = await fetch(`${ROOT}/executions/${id}/execution.json`, {
    credentials: "same-origin",
  });
  // A host that serves a page for every unknown path has no manifest either.
  const raw = response.ok ? parseJsonOrNull(await response.text()) : null;
  if (!isRecord(raw))
    return {
      ok: false,
      error: { code: "inspection_only", reason: "bundle_unavailable" },
    } as const;
  return parseExecutionManifest(raw);
}

async function startExecutionWorker(
  manifest: ExecutionManifest,
  claim: ExecutionBundle,
): Promise<Opened> {
  const kept = new Map<string, ArrayBuffer>();
  const resolved = await resolveExecution(
    claim,
    "browser",
    [manifest],
    measure.bind(null, kept),
  );
  if (!resolved.ok) return resolved;
  if (
    manifest.bundle.protocolVersion !== 1 &&
    manifest.bundle.protocolVersion !== 2 &&
    manifest.bundle.protocolVersion !== 3 &&
    manifest.bundle.protocolVersion !== 4 &&
    manifest.bundle.protocolVersion !== HOST_PROTOCOL_VERSION
  )
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
    // An older bundle's worker ignores these and fetches its files itself.
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
