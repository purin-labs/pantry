import { observationView, type ObservationView } from "./observation-view.ts";
import {
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  sha256Hex,
} from "@seams/std";
import type { ExecutionAdapter } from "./adapters.ts";
import { admitScenario } from "./admission.ts";
import { InvalidDocument } from "./document-values.ts";
import { readScenario } from "./scenario-document.ts";
import type { ControlCommand } from "./commands.ts";
import { submitCommand } from "./engine-commands.ts";
import { continueRun } from "./engine-physics.ts";
import { startRun, type OpenedCell } from "./engine.ts";
import {
  HOST_PROTOCOL_VERSION,
  parseExecutionBundle,
} from "./execution-bundle.ts";
import { driveRun } from "./host.ts";
import { parseId, parseSha256Hex, type Sha256Hex } from "./identity.ts";
import {
  cellAdapter,
  parseNativeCell,
  type CellTransport,
  type NativeCell,
} from "./native/cell-adapter.ts";
import type { ExecutionBundle } from "./physics.ts";
import {
  RECORDING_PACK_TARGET_BYTES,
  RECORDING_PACK_SCHEMA_VERSION,
  packRecordings,
} from "./recording-pack.ts";
import {
  openResumable,
  resumableDocument,
  type ArtifactEntry,
} from "./saved-run.ts";
import type { ExecutionIdentity, RunState } from "./state.ts";
import { logicalTime } from "./time.ts";
import { executionView, type HostView } from "./execution-view.ts";
import { readControlCommand } from "./state-document.ts";
import type { StoredCellRecording } from "./cell-recording.ts";
import {
  cellPhysicsViews,
  type CellPhysicsViews,
  type AcceptedRecording,
} from "./physics-view.ts";

/**
 * Host protocol version 4: how a host drives a retained engine without
 * calling into it. Requests and replies are plain data, so they cross a
 * worker boundary and stay meaningful to a Portal built from later source.
 * The engine behind this boundary owns the run; the caller holds only what a
 * reply hands it.
 */

/** Identities as text. The engine parses them; a caller never brands one. */
export type HostIdentity = Readonly<{
  runId: string;
  executionId: string;
  hostSession: string;
  parent: Readonly<{ snapshot: string; execution: string }> | null;
}>;

export type HostRequest =
  | Readonly<{
      kind: "begin";
      bundle: unknown;
      /** The controller's own cell definitions, one for each cell. */
      cells: readonly unknown[];
      identity: HostIdentity;
      origin:
        | Readonly<{ kind: "scenario"; scenario: unknown }>
        | Readonly<{
            kind: "snapshot";
            document: unknown;
            /** The stored content of each cell checkpoint the save names. */
            checkpoints: readonly Readonly<{
              digest: string;
              content: string;
            }>[];
          }>;
    }>
  /** Performs at most `turns` needs of physics, then hands the run back. */
  | Readonly<{ kind: "drive"; turns: number; until: number }>
  | Readonly<{ kind: "pause" | "resume"; commandId: string }>
  | Readonly<{ kind: "close-arrivals"; commandId: string; source: string }>
  | Readonly<{
      kind: "extend-horizon";
      commandId: string;
      expectedControlRevision: number;
      horizon: number;
    }>
  | Readonly<{
      kind: "withhold-resource";
      commandId: string;
      expectedControlRevision: number;
      resource: string;
      interval: Readonly<{ start: number; end: number }>;
    }>
  | Readonly<{
      kind: "update-worker-travel";
      commandId: string;
      expectedControlRevision?: number;
      resource: string;
      travel: readonly Readonly<{
        from: string;
        to: string;
        duration: number;
        evidence: "model" | "measured" | "assumed";
      }>[];
    }>
  | (Readonly<{
      kind: "recover" | "recover-with-worker";
      commandId: string;
      task: string;
      resource: string;
      storage: string;
      handling: number;
      evidence: "model" | "measured" | "assumed";
      reports: readonly Readonly<{ product: string; destination: string }>[];
    }> &
      (
        | Readonly<{ kind: "recover"; location?: never }>
        | Readonly<{ kind: "recover-with-worker"; location: string }>
      ))
  | Readonly<{
      kind: "inspect";
      commandId: string;
      expectedControlRevision: number;
      task: string;
      definition: string;
      lots: readonly string[];
      outcome: "accept" | "reject";
      note: string;
    }>
  | Readonly<{ kind: "save" }>
  /** Read the next artifact. Acknowledge only after its bytes are stored. */
  | Readonly<{ kind: "artifact"; acknowledged: string | null }>
  | Readonly<{ kind: "observe"; at: number }>
  | Readonly<{ kind: "state" }>
  | Readonly<{ kind: "dispose" }>;

export type HostArtifact = ArtifactEntry & Readonly<{ content: string }>;

export type HostReply =
  | Readonly<{ kind: "began"; view: HostView }>
  | Readonly<{
      kind: "drove";
      view: HostView;
      /** Events accepted since the previous reply that carried events. */
      events: RunState["events"];
      physics: CellPhysicsViews;
    }>
  | Readonly<{
      kind: "commanded";
      view: HostView;
      receipt: unknown;
      events: RunState["events"];
      physics: CellPhysicsViews;
    }>
  | Readonly<{
      kind: "saved";
      document: unknown;
      /** Bytes are transferred and acknowledged through the artifact command. */
      artifacts: readonly [];
    }>
  | Readonly<{ kind: "observed"; observation: ObservationView }>
  | Readonly<{ kind: "state"; view: HostView; run: unknown }>
  | Readonly<{ kind: "artifact"; artifact: HostArtifact | null }>
  | Readonly<{ kind: "disposed" }>
  | Readonly<{ kind: "refused"; reason: string; detail: unknown }>;

export type ExecutionHost = Readonly<{
  protocolVersion: typeof HOST_PROTOCOL_VERSION;
  handle(request: unknown): Promise<HostReply>;
}>;

function refused(reason: string, detail: unknown): HostReply {
  return { kind: "refused", reason, detail };
}

// Every accepted event reaches the caller once, in order.
function unreported(state: Live): RunState["events"] {
  const events = state.run.events.slice(state.reported);
  state.reported = state.run.events.length;
  return events;
}

function parseIdentity(
  raw: unknown,
  bundle: Sha256Hex,
): ExecutionIdentity | null {
  if (!isRecord(raw)) return null;
  const runId = parseId("run", raw.runId);
  const executionId = parseId("execution", raw.executionId);
  const hostSession = parseId("host-session", raw.hostSession);
  if (!runId.ok || !executionId.ok || !hostSession.ok) return null;
  const head = {
    runId: runId.value,
    executionId: executionId.value,
    hostSession: hostSession.value,
    bundle,
  };
  if (raw.parent === null) return { ...head, parent: null };
  if (!isRecord(raw.parent)) return null;
  const snapshot = parseId("snapshot", raw.parent.snapshot);
  const execution = parseId("execution", raw.parent.execution);
  return snapshot.ok && execution.ok
    ? {
        ...head,
        parent: { snapshot: snapshot.value, execution: execution.value },
      }
    : null;
}

type Live = {
  bundle: ExecutionBundle;
  adapter: ExecutionAdapter;
  run: RunState;
  /** Events already handed to the caller. */
  reported: number;
  /** Recordings accepted since the last pack was closed. */
  open: { digest: Sha256Hex; content: string }[];
  openBytes: number;
  /** Every pack and checkpoint a save must index. */
  index: ArtifactEntry[];
  /** Stored artifacts not yet handed to the caller. */
  pending: HostArtifact[];
  acknowledged: Sha256Hex | null;
  /** One latest observation per cell, independent of durable recording retention. */
  physics: Map<string, AcceptedRecording>;
};

async function retainCellRecording(
  state: Live,
  recording: StoredCellRecording,
): Promise<void> {
  await retainRecording(state, recording);
  state.physics.set(recording.document.cellId, { kind: "cell", recording });
}

async function closePack(state: Live): Promise<HostReply | null> {
  if (state.open.length === 0) return null;
  const packed = packRecordings(state.open);
  if (!packed.ok) return refused("recording_not_packed", packed.error);
  let queuedBytes = packed.value.length;
  for (const pending of state.pending)
    if (pending.role === "recording-segment") queuedBytes += pending.byteLength;
  if (queuedBytes > 4 * 1024 * 1024)
    return refused("recording_queue_limit", queuedBytes);
  // A pack is ASCII, so its text digest is its byte digest.
  const digest = parseSha256Hex(await sha256Hex(packed.value));
  if (!digest.ok) return refused("recording_not_packed", digest.error);
  const entry: ArtifactEntry = {
    role: "recording-segment",
    digest: digest.value,
    byteLength: packed.value.length,
    schemaVersion: RECORDING_PACK_SCHEMA_VERSION,
    binding: null,
  };
  state.index.push(entry);
  state.pending.push({ ...entry, content: packed.value });
  state.open = [];
  state.openBytes = 0;
  return null;
}

async function retainRecording(
  state: Live,
  recording: Readonly<{ digest: Sha256Hex; content: string }>,
): Promise<void> {
  state.open.push(recording);
  state.openBytes += recording.content.length;
  if (state.openBytes >= RECORDING_PACK_TARGET_BYTES) {
    const problem = await closePack(state);
    if (problem !== null) throw new Error("The recording could not be packed.");
  }
}

/**
 * Builds the host behind protocol version 2 over one controller transport.
 * It holds one run. A request it cannot honour is refused with its reason
 * and changes nothing; a physics fault ends the host, and its caller
 * continues from the last save in a fresh one.
 */
export function createExecutionHost(transport: CellTransport): ExecutionHost {
  let live: Live | null = null;
  let faulted = false;

  async function begin(
    request: Readonly<Record<string, unknown>>,
  ): Promise<HostReply> {
    if (live !== null) return refused("already_begun", null);
    const bundle = parseExecutionBundle(request.bundle);
    if (bundle === null) return refused("invalid_bundle", null);
    const identity = parseIdentity(request.identity, bundle.id);
    if (identity === null) return refused("invalid_identity", null);
    const cells: NativeCell[] = [];
    if (!Array.isArray(request.cells)) return refused("invalid_cells", null);
    for (const raw of request.cells) {
      const cell = parseNativeCell(raw);
      if (!cell.ok) return refused("invalid_cells", cell.error);
      cells.push(cell.value);
    }
    const adapter = cellAdapter(transport, bundle, cells);
    const origin = request.origin;
    if (!isRecord(origin)) return refused("invalid_origin", null);
    const state = {
      bundle,
      adapter,
      reported: 0,
      open: [],
      openBytes: 0,
      index: [],
      pending: [],
      acknowledged: null,
      physics: new Map(),
    } satisfies Omit<Live, "run">;

    if (origin.kind === "scenario") {
      // The scenario is admitted here, by the engine that will run it.
      let scenario;
      try {
        scenario = readScenario(origin.scenario);
      } catch (error) {
        if (error instanceof InvalidDocument)
          return refused("invalid_scenario", null);
        throw error;
      }
      const admitted = await admitScenario(scenario);
      if (!admitted.ok) return refused("scenario_not_admitted", admitted.error);
      const opened: OpenedCell[] = [];
      for (const cell of admitted.value.scenario.cells) {
        const checkpoint = await adapter.open(cell.id, {
          kind: "create",
          modelHash: cell.modelHash,
        });
        if (!checkpoint.ok) return refused("cell_not_opened", checkpoint.error);
        opened.push({ cell: cell.id, checkpoint: checkpoint.value });
      }
      const started = startRun(admitted.value, identity, opened);
      if (!started.ok) return refused("run_not_started", started.error);
      live = { ...state, run: started.value };
      return { kind: "began", view: executionView(started.value) };
    }

    if (origin.kind !== "snapshot" || !Array.isArray(origin.checkpoints))
      return refused("invalid_origin", null);
    const document = await openResumable(origin.document, bundle.backend, [
      bundle,
    ]);
    if (!document.ok) return refused("save_not_opened", document.error);
    const contents = new Map<string, string>();
    for (const checkpoint of origin.checkpoints)
      if (
        isRecord(checkpoint) &&
        typeof checkpoint.digest === "string" &&
        typeof checkpoint.content === "string"
      )
        contents.set(checkpoint.digest, checkpoint.content);
    const saved = document.value.state;
    for (const cell of saved.cells) {
      const content = contents.get(cell.committed.checkpoint.digest);
      if (content === undefined)
        return refused("checkpoint_missing", cell.committed.checkpoint.digest);
      const restored = await adapter.open(cell.id, {
        kind: "restore",
        checkpoint: cell.committed.checkpoint,
        content,
        operation:
          cell.attempt === null || cell.attempt.lifecycle.kind !== "running"
            ? null
            : {
                attempt: cell.attempt.id,
                sequence: cell.attempt.segments.length,
              },
      });
      if (!restored.ok) return refused("cell_not_restored", restored.error);
    }
    const continued = continueRun(saved, identity);
    if (!continued.ok) return refused("run_not_continued", continued.error);
    const index: ArtifactEntry[] = [];
    // Earlier recordings stay indexed; this host holds none of their bytes.
    for (const entry of document.value.artifacts)
      if (entry.role === "recording-segment") index.push(entry);
    live = {
      ...state,
      index,
      run: continued.value,
      reported: continued.value.events.length,
    };
    return { kind: "began", view: executionView(continued.value) };
  }

  async function drive(
    state: Live,
    request: Readonly<Record<string, unknown>>,
  ): Promise<HostReply> {
    if (state.pending.length > 0) return refused("artifact_pending", null);
    const until =
      typeof request.until === "number" ? logicalTime(request.until) : null;
    if (until === null || !until.ok || !isPositiveInteger(request.turns))
      return refused("invalid_drive", null);
    let offered = 0;
    const turns = request.turns;
    let stopped;
    try {
      stopped = await driveRun(state.run, state.adapter, until.value, {
        async segment(segment, recording) {
          state.physics.set(segment.cellId, {
            kind: "operation",
            segment,
            content: recording,
          });
          await retainRecording(state, {
            digest: segment.recording.digest,
            content: recording,
          });
        },
        cellRecording: retainCellRecording.bind(null, state),
        yield() {
          offered += 1;
          return state.pending.length > 0 || offered > turns;
        },
      });
    } catch (error) {
      faulted = true;
      return refused(
        "physics_fault",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!stopped.ok) {
      faulted = true;
      return refused("physics_fault", stopped.error);
    }
    state.run = stopped.value.run;
    return {
      kind: "drove",
      view: executionView(state.run),
      events: unreported(state),
      physics: cellPhysicsViews(state.run, state.physics),
    };
  }

  // A save is taken where every cell has real state at the run's time.
  async function save(state: Live): Promise<HostReply> {
    if (state.pending.length > 0) return refused("artifact_pending", null);
    const status = state.run.status.kind;
    if (
      status !== "paused" &&
      status !== "completed" &&
      status !== "blocked" &&
      status !== "awaiting-inspection" &&
      status !== "stopped-at-limit"
    )
      return refused("not_settled", status);
    const closed = await closePack(state);
    if (closed !== null) return closed;
    const index = [...state.index];
    for (const cell of state.run.cells) {
      const exported = await state.adapter.exportCheckpoint(cell.id);
      if (!exported.ok)
        return refused("checkpoint_not_exported", exported.error);
      if (exported.value.checkpoint.digest !== cell.committed.checkpoint.digest)
        return refused("checkpoint_differs", cell.id);
      const entry: ArtifactEntry = {
        role: "cell-checkpoint",
        digest: exported.value.checkpoint.digest,
        byteLength: exported.value.checkpoint.byteLength,
        schemaVersion: state.bundle.checkpointSchemaVersion,
        binding: { cell: cell.id, attempt: cell.attempt?.id ?? null },
      };
      index.push(entry);
      state.pending.push({ ...entry, content: exported.value.content });
    }
    const document = await resumableDocument(state.run, state.bundle, index);
    return { kind: "saved", document, artifacts: [] };
  }

  return {
    protocolVersion: HOST_PROTOCOL_VERSION,
    async handle(request) {
      if (!isRecord(request) || typeof request.kind !== "string")
        return refused("invalid_request", null);
      if (faulted) return refused("host_faulted", null);
      if (request.kind === "begin") return begin(request);
      if (live === null) return refused("not_begun", null);
      switch (request.kind) {
        case "artifact":
          return artifact(live, request.acknowledged);
        case "drive":
          return drive(live, request);
        case "inspect":
        case "close-arrivals":
        case "extend-horizon":
        case "withhold-resource":
        case "update-worker-travel":
        case "pause":
        case "resume":
        case "recover":
        case "recover-with-worker":
          return command(live, request);
        case "save":
          return save(live);
        case "observe": {
          if (typeof request.at !== "number")
            return refused("invalid_observation_time", null);
          const at = logicalTime(request.at);
          if (!at.ok || at.value > live.run.position.time)
            return refused("invalid_observation_time", null);
          return {
            kind: "observed",
            observation: observationView(live.run, at.value),
          };
        }
        case "state":
          return {
            kind: "state",
            view: executionView(live.run),
            run: live.run,
          };
        case "dispose": {
          for (const cell of live.run.cells)
            await live.adapter.dispose(cell.id);
          live = null;
          return { kind: "disposed" };
        }
        default:
          return refused("unknown_request", request.kind);
      }
    },
  };
}

function artifact(state: Live, acknowledged: unknown): HostReply {
  if (acknowledged !== null) {
    const digest = parseSha256Hex(acknowledged);
    if (!digest.ok) return refused("invalid_artifact_acknowledgement", null);
    if (state.pending[0]?.digest === digest.value) {
      state.pending.shift();
      state.acknowledged = digest.value;
    } else if (state.acknowledged !== digest.value) {
      return refused("artifact_acknowledgement_differs", null);
    }
  }
  return { kind: "artifact", artifact: state.pending[0] ?? null };
}

function command(
  state: Live,
  raw: Readonly<Record<string, unknown>>,
): HostReply {
  let expectedControlRevision =
    raw.expectedControlRevision !== undefined
      ? raw.expectedControlRevision
      : state.run.position.controlRevision;
  for (const entry of state.run.commands)
    if (
      raw.expectedControlRevision === undefined &&
      entry.command.commandId === raw.commandId
    )
      expectedControlRevision = entry.command.expectedControlRevision;
  let control: ControlCommand;
  try {
    control = readControlCommand({
      ...recoveryHostCommand(raw),
      runId: state.run.identity.runId,
      executionId: state.run.identity.executionId,
      hostSession: state.run.identity.hostSession,
      expectedControlRevision,
    });
  } catch (error) {
    if (error instanceof InvalidDocument)
      return refused("invalid_command", null);
    throw error;
  }
  const result = submitCommand(state.run, control);
  state.run = result.run;
  return {
    kind: "commanded",
    view: executionView(state.run),
    receipt: result.receipt,
    events: unreported(state),
    physics: cellPhysicsViews(state.run, state.physics),
  };
}

/** Protocol 1 keeps its stationary command and adds a worker recovery command. */
function recoveryHostCommand(raw: Readonly<Record<string, unknown>>) {
  if (raw.kind === "recover")
    return { ...raw, attendance: { kind: "in-place" } };
  if (raw.kind === "recover-with-worker") {
    const { location, ...fields } = raw;
    return {
      ...fields,
      kind: "recover",
      attendance: { kind: "worker", location },
    };
  }
  return raw;
}

/** A reply's count fields are plain numbers a later caller can rely on. */
export function isHostView(raw: unknown): raw is HostView {
  return (
    isRecord(raw) &&
    isNonNegativeInteger(raw.time) &&
    isNonNegativeInteger(raw.events) &&
    isRecord(raw.status) &&
    typeof raw.status.kind === "string" &&
    Array.isArray(raw.cells)
  );
}
