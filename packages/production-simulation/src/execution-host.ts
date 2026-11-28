import { observationView, type ObservationView } from "./observation-view.ts";
import {
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  sha256Hex,
} from "@purin-labs/std";
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
import {
  parseId,
  parseSha256Hex,
  type CellId,
  type Sha256Hex,
} from "./identity.ts";
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
  REPLAY_START,
  afterReplayDrive,
  afterReplayRelease,
  afterReplaySubmit,
  cellConfiguration,
  nextReplayAction,
  reboundDefinition,
  rebindScenario,
  releasePause,
  replayPlan,
  replayReport,
  sameCell,
  type CellBinding,
  type ReplayCursor,
  type ReplayPlan,
  type ReplayReport,
} from "./replay.ts";
import {
  openResumable,
  openSaved,
  resumableDocument,
  type ArtifactEntry,
} from "./saved-run.ts";
import type { CompiledScenario } from "./scenario.ts";
import type { ExecutionIdentity, RunState } from "./state.ts";
import { err, ok, type Result } from "./result.ts";
import { logicalTime, type LogicalTime } from "./time.ts";
import { executionView, type HostView } from "./execution-view.ts";
import { readControlCommand } from "./state-document.ts";
import type { StoredCellRecording } from "./cell-recording.ts";
import {
  cellPhysicsViews,
  type CellPhysicsViews,
  type AcceptedRecording,
} from "./physics-view.ts";

/**
 * The host protocol (`HOST_PROTOCOL_VERSION`): how a host drives an engine
 * without calling into it. Requests and replies are plain data, so they
 * cross a worker boundary. The engine behind this boundary owns the run; the
 * caller holds only what a reply hands it.
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
      /**
       * A controller's own cell definitions, one for each cell. A snapshot
       * needs the definitions of this build. A scenario or a replay also
       * takes the definitions of another build, and this controller then
       * defines the same cells again.
       */
      cells: readonly unknown[];
      identity: HostIdentity;
      origin:
        | Readonly<{ kind: "scenario"; scenario: unknown }>
        /** A save of another build: its inputs run again on this build. */
        | Readonly<{ kind: "replay"; document: unknown }>
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
  | Readonly<{
      kind: "began";
      view: HostView;
      /** Present when the execution plays the inputs of a save again. */
      replay?: ReplayReport;
      /**
       * Present when the caller sent a cell of another build: each cell as
       * this build defines it, in the order of the request.
       */
      cells?: readonly unknown[];
    }>
  | Readonly<{
      kind: "drove";
      view: HostView;
      /** Events accepted since the previous reply that carried events. */
      events: RunState["events"];
      physics: CellPhysicsViews;
      replay?: ReplayReport;
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
  /** The inputs of a save of another build, while and after they run again. */
  replay: {
    plan: ReplayPlan;
    cursor: ReplayCursor;
    /** Set when the replay ends. From then on the run takes commands. */
    report: ReplayReport | null;
  } | null;
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

function sameBuild(cell: NativeCell, bundle: ExecutionBundle): boolean {
  return (
    cell.controllerSourceHash === bundle.controllerSourceHash &&
    cell.controllerHash === bundle.controllerHash &&
    cell.runtimeHash === bundle.runtimeHash
  );
}

/**
 * The cells as this build defines them. A definition names the build and the
 * model of the controller that made it. For a definition of another build,
 * this controller defines the same cell again from its configuration, and
 * the binding gives the scenario the model of the new definition.
 */
async function presentCells(
  transport: CellTransport,
  bundle: ExecutionBundle,
  cells: readonly NativeCell[],
): Promise<
  Result<
    Readonly<{ cells: NativeCell[]; bindings: Map<CellId, CellBinding> }>,
    HostReply
  >
> {
  const present: NativeCell[] = [];
  const bindings = new Map<CellId, CellBinding>();
  for (const cell of cells) {
    if (sameBuild(cell, bundle)) {
      present.push(cell);
      continue;
    }
    const configuration = cellConfiguration(cell.definition);
    if (!configuration.ok)
      return err(refused("cell_not_defined", configuration.error));
    let reply: unknown;
    try {
      reply = await transport.send({
        op: "define",
        definition: configuration.value,
      });
    } catch (error) {
      return err(
        refused(
          "cell_not_defined",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    const defined =
      isRecord(reply) && reply.kind === "defined"
        ? parseNativeCell(reboundDefinition(cell.definition, reply.definition))
        : null;
    if (
      defined === null ||
      !defined.ok ||
      !sameBuild(defined.value, bundle) ||
      !sameCell(cell.definition, defined.value.definition)
    )
      return err(refused("cell_not_defined", cell.cellId));
    present.push(defined.value);
    bindings.set(cell.cellId, {
      modelHash: defined.value.modelHash,
      controllerSourceHash: defined.value.controllerSourceHash,
    });
  }
  return ok({ cells: present, bindings });
}

/** The definitions for the caller, when this build defined a cell again. */
function presentDefinitions(
  cells: readonly NativeCell[],
  bindings: ReadonlyMap<CellId, CellBinding>,
): Readonly<{ cells?: readonly unknown[] }> {
  if (bindings.size === 0) return {};
  const definitions = [];
  for (const cell of cells) definitions.push(cell.definition);
  return { cells: definitions };
}

/** Admits a scenario, creates the world of each cell and starts the run. */
async function start(
  adapter: ExecutionAdapter,
  scenario: CompiledScenario,
  identity: ExecutionIdentity,
): Promise<Result<RunState, HostReply>> {
  const admitted = await admitScenario(scenario);
  if (!admitted.ok)
    return err(refused("scenario_not_admitted", admitted.error));
  const opened: OpenedCell[] = [];
  for (const cell of admitted.value.scenario.cells) {
    const checkpoint = await adapter.open(cell.id, {
      kind: "create",
      modelHash: cell.modelHash,
    });
    if (!checkpoint.ok)
      return err(refused("cell_not_opened", checkpoint.error));
    opened.push({ cell: cell.id, checkpoint: checkpoint.value });
  }
  const started = startRun(admitted.value, identity, opened);
  return started.ok ? started : err(refused("run_not_started", started.error));
}

/**
 * Builds the host behind the host protocol over one controller transport.
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
    let cells: NativeCell[] = [];
    if (!Array.isArray(request.cells)) return refused("invalid_cells", null);
    for (const raw of request.cells) {
      const cell = parseNativeCell(raw);
      if (!cell.ok) return refused("invalid_cells", cell.error);
      cells.push(cell.value);
    }
    const origin = request.origin;
    if (!isRecord(origin)) return refused("invalid_origin", null);
    // A new run takes the cells of any build: this controller defines them
    // again. A snapshot restores checkpoints, which only their build reads.
    let bindings: ReadonlyMap<CellId, CellBinding> = new Map();
    if (origin.kind === "scenario" || origin.kind === "replay") {
      const present = await presentCells(transport, bundle, cells);
      if (!present.ok) return present.error;
      cells = present.value.cells;
      bindings = present.value.bindings;
    }
    const adapter = cellAdapter(transport, bundle, cells);
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
      replay: null,
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
      const started = await start(
        adapter,
        rebindScenario(scenario, bindings),
        identity,
      );
      if (!started.ok) return started.error;
      live = { ...state, run: started.value };
      return {
        kind: "began",
        view: executionView(started.value),
        ...presentDefinitions(cells, bindings),
      };
    }

    if (origin.kind === "replay") {
      const saved = await openSaved(origin.document);
      if (!saved.ok) return refused("save_not_opened", saved.error);
      const inputs = saved.value.state;
      if (identity.runId !== inputs.identity.runId)
        return refused("run_not_continued", "run_differs");
      if (
        identity.parent === null ||
        identity.parent.snapshot !== saved.value.snapshot ||
        identity.parent.execution !== inputs.identity.executionId
      )
        return refused("run_not_continued", "parent_differs");
      const started = await start(
        adapter,
        rebindScenario(inputs.definition.scenario, bindings),
        identity,
      );
      if (!started.ok) return started.error;
      const plan = replayPlan(inputs, saved.value.snapshot);
      live = {
        ...state,
        run: started.value,
        replay: { plan, cursor: REPLAY_START, report: null },
      };
      return {
        kind: "began",
        view: executionView(started.value),
        replay: replayReport(plan, REPLAY_START, started.value, false),
        ...presentDefinitions(cells, bindings),
      };
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
    // The inputs of the save go first. The caller's time applies after them.
    let remaining = request.turns;
    const replay = state.replay;
    const replaying = replay !== null && replay.report === null;
    while (replay !== null && replay.report === null) {
      const action = nextReplayAction(replay.plan, replay.cursor, state.run);
      if (action.kind === "done") {
        replay.report = replayReport(
          replay.plan,
          replay.cursor,
          state.run,
          true,
        );
        break;
      }
      if (action.kind === "release") {
        state.run = releasePause(state.run);
        replay.cursor = afterReplayRelease(replay.cursor);
        continue;
      }
      if (action.kind === "submit") {
        const result = submitCommand(state.run, action.command);
        state.run = result.run;
        replay.cursor = afterReplaySubmit(
          replay.plan,
          replay.cursor,
          state.run,
          result.receipt.status === "accepted" ? null : result.receipt.reason,
        );
        continue;
      }
      if (remaining <= 0 || state.pending.length > 0) break;
      const before = state.run;
      const turned = await turn(
        state,
        action.until,
        action.turns === "one" ? 1 : remaining,
      );
      if (!turned.ok) return turned.error;
      remaining -= turned.value.performed;
      replay.cursor = afterReplayDrive(replay.plan, replay.cursor, {
        yielded: turned.value.yielded,
        moved:
          turned.value.performed > 0 ||
          state.run.position.time !== before.position.time ||
          state.run.events.length !== before.events.length ||
          state.run.status.kind !== before.status.kind,
      });
    }
    // The reply that ends a replay shows the run where the save stopped.
    if (!replaying) {
      const turned = await turn(state, until.value, remaining);
      if (!turned.ok) return turned.error;
    }
    return {
      kind: "drove",
      view: executionView(state.run),
      events: unreported(state),
      physics: cellPhysicsViews(state.run, state.physics),
      ...(replay === null
        ? {}
        : {
            replay:
              replay.report ??
              replayReport(replay.plan, replay.cursor, state.run, false),
          }),
    };
  }

  /** Drives the run to `until`, for at most `turns` needs of physics. */
  async function turn(
    state: Live,
    until: LogicalTime,
    turns: number,
  ): Promise<
    Result<Readonly<{ yielded: boolean; performed: number }>, HostReply>
  > {
    let offered = 0;
    let stopped;
    try {
      stopped = await driveRun(state.run, state.adapter, until, {
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
      return err(
        refused(
          "physics_fault",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    if (!stopped.ok) {
      faulted = true;
      return err(refused("physics_fault", stopped.error));
    }
    state.run = stopped.value.run;
    // The need at which the host took the run back was not performed.
    return ok({
      yielded: stopped.value.yielded,
      performed: stopped.value.yielded ? offered - 1 : offered,
    });
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
      // The inputs of the save run first. A command of the caller would
      // change them, and a save would hold a part of them.
      if (
        live.replay !== null &&
        live.replay.report === null &&
        request.kind !== "artifact" &&
        request.kind !== "drive" &&
        request.kind !== "observe" &&
        request.kind !== "state" &&
        request.kind !== "dispose"
      )
        return refused("replaying", null);
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
