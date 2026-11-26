import {
  hasExactKeys,
  isNonNegativeInteger,
  isRecord,
  sha256Hex,
} from "@purin-labs/std";
import { normalizeQuantity } from "../quantity.ts";
import type { Variant } from "@purin-labs/type-utils";
import type {
  AdvanceResult,
  ExecutionAdapter,
  ExecutionFailure,
} from "../adapters.ts";
import {
  parseId,
  parseSha256Hex,
  type AttemptId,
  type CellId,
  type Sha256Hex,
} from "../identity.ts";
import type {
  AttemptAddress,
  BoundaryCandidate,
  CarrierDisposition,
  CarrierSlot,
  CheckpointRef,
  ExecutionBundle,
  HoldOffer,
  Measurement,
  NativeEvent,
  Terminal,
} from "../physics.ts";
import { err, ok, type Result } from "../result.ts";
import { stepCount, stepsDuration, type StepCount } from "../time.ts";
import {
  readCellRecording,
  requireDenseOperationRecording,
} from "./cell-recording.ts";
import { parseStationReply } from "./station-replies.ts";

/**
 * The execution adapter over the shared Rust controller's cell protocol. A
 * transport carries one command and returns one reply: a line to a headless
 * process, or a call into the browser's Wasm module. Everything a reply
 * claims is parsed here before the engine sees it.
 */

export type CellTransport = Readonly<{
  send(command: Readonly<Record<string, unknown>>): Promise<unknown>;
}>;

export type GrinderModel =
  | "option-o-lagom-casa"
  | "timemore-bricks-01s"
  | "fellow-opus-2"
  | "miicoffee-df64-gen2";

function parseGrinderModel(raw: unknown): GrinderModel {
  if (
    raw === "option-o-lagom-casa" ||
    raw === "timemore-bricks-01s" ||
    raw === "fellow-opus-2" ||
    raw === "miicoffee-df64-gen2"
  )
    return raw;
  throw new TypeError("Unsupported grinder model");
}

/** The prepared pour-over station a human set out before the robot starts. */
export type PourOverStation = Readonly<{
  kettleWaterG: number;
  kettleWaterC: 93;
  coffeeG: 27;
  drainage: "nominal" | "reduced";
  fault: "none" | "lost-grip";
  grinder?: GrinderModel;
}>;

/** A cell world's definition as the controller pinned it to its own build. */
export type NativeCell = Readonly<{
  cellId: CellId;
  runId: string;
  modelHash: Sha256Hex;
  controllerSourceHash: Sha256Hex;
  controllerHash: Sha256Hex;
  runtimeHash: Sha256Hex;
  /** The controller's own document, returned to it unchanged. */
  definition: unknown;
}> &
  (
    | Readonly<{
        fixture: "persistent-espresso/1";
        appliance: "linea" | "eagle-one";
        grinder?: GrinderModel;
        grinderModelHash?: Sha256Hex;
        station?: never;
      }>
    | Readonly<{
        fixture: "persistent-pour-over/1";
        station: PourOverStation;
        grinderModelHash?: Sha256Hex;
        appliance?: never;
      }>
    | Readonly<{
        fixture:
          | "persistent-rack/1"
          | "persistent-oven-rack/1"
          | "persistent-spanner-oven-rack/1"
          | "persistent-pan-staging/1";
        appliance?: never;
        station?: never;
      }>
  );

/** Whether a cell is an espresso or pour-over station, not a robot cell. */
function isStation(definition: NativeCell): boolean {
  return (
    definition.fixture === "persistent-espresso/1" ||
    definition.fixture === "persistent-pour-over/1"
  );
}

/** The station a pour-over definition prepares, parsed exactly. */
export function parsePourOverStation(raw: unknown): PourOverStation {
  if (
    !isRecord(raw) ||
    (!hasExactKeys(raw, [
      "kettleWaterG",
      "kettleWaterC",
      "coffeeG",
      "drainage",
      "fault",
    ]) &&
      !hasExactKeys(raw, [
        "kettleWaterG",
        "kettleWaterC",
        "coffeeG",
        "drainage",
        "fault",
        "grinder",
      ]))
  )
    throw new TypeError("A pour-over station names its preparation");
  const { kettleWaterG, kettleWaterC, coffeeG, drainage, fault } = raw;
  if (
    !isNonNegativeInteger(kettleWaterG) ||
    kettleWaterG < 420 ||
    kettleWaterG > 700 ||
    kettleWaterC !== 93 ||
    coffeeG !== 27 ||
    (drainage !== "nominal" && drainage !== "reduced") ||
    (fault !== "none" && fault !== "lost-grip")
  )
    throw new TypeError("Unsupported pour-over station");
  const grinder =
    raw.grinder === undefined ? undefined : parseGrinderModel(raw.grinder);
  return {
    kettleWaterG,
    kettleWaterC,
    coffeeG,
    drainage,
    fault,
    ...(grinder === undefined ? {} : { grinder }),
  };
}

function digestAt(record: Record<string, unknown>, key: string): Sha256Hex {
  const parsed = parseSha256Hex(record[key]);
  if (!parsed.ok) throw new TypeError(`Reply has no digest at ${key}`);
  return parsed.value;
}

function recordAt(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new TypeError(`Reply has no object at ${key}`);
  return value;
}

function textAt(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string")
    throw new TypeError(`Reply has no text at ${key}`);
  return value;
}

function stepsAt(record: Record<string, unknown>, key: string): StepCount {
  const value = record[key];
  const steps = typeof value === "number" ? stepCount(value) : null;
  if (steps === null || !steps.ok)
    throw new TypeError(`Reply has no step count at ${key}`);
  return steps.value;
}

export function parseNativeCell(raw: unknown): Result<NativeCell, string> {
  try {
    if (!isRecord(raw)) throw new TypeError("A cell definition is an object");
    const execution = recordAt(raw, "execution");
    const fixture = raw.fixture;
    if (
      fixture !== "persistent-rack/1" &&
      fixture !== "persistent-oven-rack/1" &&
      fixture !== "persistent-spanner-oven-rack/1" &&
      fixture !== "persistent-pan-staging/1" &&
      fixture !== "persistent-espresso/1" &&
      fixture !== "persistent-pour-over/1"
    )
      throw new TypeError("Unsupported persistent fixture");
    const cellId = parseId("cell", raw.cellId);
    if (!cellId.ok)
      throw new TypeError("A cell definition has an invalid identity");
    const common = {
      cellId: cellId.value,
      runId: textAt(raw, "runId"),
      modelHash: digestAt(raw, "modelHash"),
      controllerSourceHash: digestAt(execution, "controllerSourceHash"),
      controllerHash: digestAt(execution, "controllerHash"),
      runtimeHash: digestAt(execution, "runtimeHash"),
      definition: raw,
    };
    if (fixture === "persistent-espresso/1") {
      // Persistence boundary for earlier Linea-only definitions; retain raw bytes.
      const appliance = raw.appliance === undefined ? "linea" : raw.appliance;
      if (appliance !== "linea" && appliance !== "eagle-one")
        throw new TypeError("Unsupported espresso appliance");
      const grinder =
        raw.grinder === undefined ? undefined : parseGrinderModel(raw.grinder);
      if ((grinder !== undefined) !== (raw.grinderModelHash !== undefined))
        throw new TypeError("Espresso grinder requires a matching model hash");
      return ok({
        fixture,
        appliance,
        ...(grinder === undefined
          ? {}
          : {
              grinder,
              grinderModelHash: digestAt(raw, "grinderModelHash"),
            }),
        ...common,
      });
    }
    if (raw.appliance !== undefined)
      throw new TypeError("Robot cell cannot select an espresso appliance");
    if (fixture === "persistent-pour-over/1") {
      if (raw.robot !== "fairino-fr10")
        throw new TypeError("The pour-over station uses the FR10");
      const station = parsePourOverStation(raw.station);
      if (
        (station.grinder !== undefined) !==
        (raw.grinderModelHash !== undefined)
      )
        throw new TypeError("Pour-over grinder requires a matching model hash");
      return ok({
        fixture,
        station,
        ...(station.grinder === undefined
          ? {}
          : { grinderModelHash: digestAt(raw, "grinderModelHash") }),
        ...common,
      });
    }
    if (raw.station !== undefined)
      throw new TypeError("Only a pour-over cell prepares a station");
    return ok({ fixture, ...common });
  } catch (error) {
    return err(error instanceof Error ? error.message : "Invalid definition");
  }
}

/**
 * The controller accepts letters, digits, `-` and `_` in an identity. Every
 * other character is written as `_` and its code, so distinct identities
 * stay distinct and the original can be read back.
 */
export function nativeIdentity(id: string): string {
  let encoded = "";
  for (const character of id)
    encoded += /^[A-Za-z0-9-]$/u.test(character)
      ? character
      : `_${character.codePointAt(0)?.toString(16).padStart(2, "0")}`;
  return encoded;
}

function checkpointAt(
  record: Record<string, unknown>,
  key: string,
): CheckpointRef {
  const reference = recordAt(record, key);
  const byteLength = reference.byteLength;
  if (!isNonNegativeInteger(byteLength) || byteLength === 0)
    throw new TypeError("A checkpoint has a positive length");
  return {
    digest: digestAt(reference, "digest"),
    byteLength,
    step: stepsAt(reference, "step"),
  };
}

type ActiveSlot = Variant<CarrierSlot, "active">;

function slotAt(
  record: Record<string, unknown>,
  carriers: ReadonlyMap<string, ActiveSlot>,
): CarrierSlot {
  const slot = recordAt(record, "slot");
  const generation = slot.generation;
  if (!isNonNegativeInteger(generation))
    throw new TypeError("A slot has a generation");
  if (slot.kind === "inactive") return { kind: "inactive", generation };
  const active = carriers.get(textAt(slot, "carrier"));
  if (slot.kind !== "active" || active === undefined)
    throw new TypeError("The slot holds a carrier this host did not admit");
  if (active.generation !== generation)
    throw new TypeError("The slot's generation differs from its admission");
  return active;
}

function holdAt(record: Record<string, unknown>): HoldOffer | null {
  if (record.hold === null || record.hold === undefined) return null;
  const hold = recordAt(record, "hold");
  const model = parseId("hold-model", hold.model);
  if (!model.ok) throw new TypeError("A hold names its model");
  return {
    model: model.value,
    support: textAt(hold, "support"),
    qualified: stepsDuration(stepsAt(hold, "qualifiedSteps")),
  };
}

const DISPOSITIONS: Readonly<Record<string, CarrierDisposition>> = {
  source: "source",
  gripped: "tool",
  destination: "destination",
  unknown: "unknown",
};

function nativeTask(
  skill: string,
  fixture: NativeCell["fixture"],
): string | null {
  switch (skill) {
    case "espresso-cycle":
      return fixture === "persistent-espresso/1" ? "espresso-cycle" : null;
    case "pour-over-brew":
      return fixture === "persistent-pour-over/1" ? "pour-over-brew" : null;
    case "rack-transfer":
      return "table-to-rack";
    case "oven-loading":
      return fixture === "persistent-oven-rack/1" ||
        fixture === "persistent-spanner-oven-rack/1"
        ? "table-to-oven"
        : null;
    case "oven-retrieval":
      return fixture === "persistent-oven-rack/1" ||
        fixture === "persistent-spanner-oven-rack/1"
        ? "oven-to-table"
        : null;
    default:
      return null;
  }
}

type Outcome =
  | Readonly<{ kind: "completed"; measurements: readonly Measurement[] }>
  | Readonly<{
      kind: "failed";
      disposition: CarrierDisposition;
      reason: string;
    }>;

/** The station material a pour-over completion measures, by native name. */
const POUR_OVER_MEASUREMENTS = [
  ["beverageMg", "beverage"],
  ["spentBedMg", "spent-bed"],
  ["kettleMg", "kettle-water"],
  ["spillMg", "spill"],
  ["evaporatedMg", "evaporation"],
] as const;

function pourOverOutcomeAt(record: Record<string, unknown>): Outcome {
  const outcome = recordAt(record, "outcome");
  switch (outcome.kind) {
    case "completed": {
      const native = recordAt(outcome, "measurements");
      if (!hasExactKeys(native, POUR_OVER_MEASUREMENTS.map(nativeName)))
        throw new TypeError("A pour-over completion measures every material");
      const measurements: Measurement[] = [];
      for (const [name, id] of POUR_OVER_MEASUREMENTS) {
        const amount = native[name];
        const measurement = parseId("measurement", id);
        if (!isNonNegativeInteger(amount) || !measurement.ok)
          throw new TypeError("Invalid pour-over measurement");
        const quantity = normalizeQuantity({
          amount,
          scale: 3,
          unit: "gram",
        });
        if (!quantity.ok) throw new TypeError("Invalid pour-over quantity");
        measurements.push({
          measurement: measurement.value,
          quantity: quantity.value,
        });
      }
      return { kind: "completed", measurements };
    }
    case "failed": {
      const disposition = DISPOSITIONS[textAt(outcome, "disposition")];
      if (disposition === undefined)
        throw new TypeError("Unknown kettle disposition");
      return { kind: "failed", disposition, reason: textAt(outcome, "reason") };
    }
    default:
      throw new TypeError("Unknown pour-over outcome");
  }
}

function nativeName(entry: (typeof POUR_OVER_MEASUREMENTS)[number]): string {
  return entry[0];
}

function outcomeAt(record: Record<string, unknown>): Outcome {
  const outcome = recordAt(record, "outcome");
  switch (outcome.kind) {
    case "completed":
    case "recovered":
      return { kind: "completed", measurements: [] };
    case "failed": {
      const disposition = DISPOSITIONS[textAt(outcome, "trayDisposition")];
      if (disposition === undefined)
        throw new TypeError("Unknown carrier disposition");
      return {
        kind: "failed",
        disposition,
        reason: textAt(outcome, "reason"),
      };
    }
    // The controller could not finish a step: where the carrier is, is unknown.
    case "execution-error":
      return {
        kind: "failed",
        disposition: "unknown",
        reason: "execution-error",
      };
    default:
      throw new TypeError("Unknown outcome");
  }
}

type Live = {
  definition: NativeCell;
  /** The attempt the cell executes, by its engine and controller identities. */
  attempt: { id: AttemptId; native: string; segments: number[] } | null;
  /** Carriers this host prepared to admit, by their controller identity. */
  carriers: Map<string, ActiveSlot>;
};

function failure(
  code: ExecutionFailure["code"],
  detail: string,
): Result<never, ExecutionFailure> {
  return err({ code, detail });
}

/**
 * Builds the adapter for the cells in `definitions`. `bundle` is the build
 * the transport's controller belongs to; a definition pinned to another
 * build is refused when its cell is opened.
 */
export function cellAdapter(
  transport: CellTransport,
  bundle: ExecutionBundle,
  definitions: readonly NativeCell[],
): ExecutionAdapter {
  const cells = new Map<CellId, Live>();

  // One exchange: a reply of the expected kind, or the controller's refusal.
  async function exchange(
    command: Readonly<Record<string, unknown>>,
    kind: string,
    refused: ExecutionFailure["code"],
  ): Promise<Result<Record<string, unknown>, ExecutionFailure>> {
    let reply: unknown;
    try {
      const definition = definitions.find(matchesCell.bind(null, command.cell));
      const namespace = commandNamespace(definition);
      if (namespace !== null) {
        const envelope = await transport.send({ op: namespace, command });
        if (isRecord(envelope) && envelope.kind === namespace) {
          const parsed = parseStationReply(namespace, envelope.reply);
          if (!parsed.ok) return failure("unresponsive", parsed.error);
          reply = parsed.value;
        } else reply = envelope;
      } else reply = await transport.send(command);
    } catch (error) {
      return failure(
        "unresponsive",
        error instanceof Error ? error.message : "The transport failed",
      );
    }
    if (!isRecord(reply)) return failure("unresponsive", "Reply is no object");
    if (reply.kind === "failed") return failure(refused, String(reply.message));
    if (
      reply.kind !== kind &&
      !(kind === "started" && reply.kind === "refused")
    )
      return failure("unresponsive", `Unexpected reply ${String(reply.kind)}`);
    return ok(reply);
  }

  function live(cell: CellId): Result<Live, ExecutionFailure> {
    const found = cells.get(cell);
    return found === undefined
      ? failure("unknown_cell", `Cell ${cell} is not open`)
      : ok(found);
  }

  function terminalOf(
    address: AttemptAddress,
    segments: readonly number[],
    steps: StepCount,
    outcome: Outcome,
    checkpoint: CheckpointRef,
  ): Terminal {
    const head = {
      runId: address.runId,
      executionId: address.executionId,
      cellId: address.cellId,
      attemptId: address.attemptId,
      kind: "terminal" as const,
      sequence: segments.length,
      steps,
      segments,
    };
    return outcome.kind === "completed"
      ? {
          ...head,
          outcome: "completed",
          checkpoint,
          measurements: outcome.measurements,
        }
      : {
          ...head,
          outcome: "failed",
          disposition: outcome.disposition,
          checkpoint,
        };
  }

  return {
    bundle,

    async open(cell, start) {
      let definition: NativeCell | null = null;
      for (const candidate of definitions)
        if (candidate.cellId === cell) definition = candidate;
      if (definition === null)
        return failure("unknown_cell", `No definition for cell ${cell}`);
      if (
        definition.controllerSourceHash !== bundle.controllerSourceHash ||
        definition.controllerHash !== bundle.controllerHash ||
        definition.runtimeHash !== bundle.runtimeHash
      )
        return failure(
          "unsupported_bundle",
          "The cell is pinned to another build",
        );
      if (start.kind === "create" && start.modelHash !== definition.modelHash)
        return failure("incompatible_start", "The cell's model differs");
      const opened = await exchange(
        {
          op: "open",
          cell,
          opening:
            start.kind === "create"
              ? { kind: "create", definition: definition.definition }
              : {
                  kind: "restore",
                  content: start.content,
                  digest: start.checkpoint.digest,
                  sequence: start.operation?.sequence ?? 0,
                },
        },
        "opened",
        start.kind === "create" ? "incompatible_start" : "invalid_checkpoint",
      );
      if (!opened.ok) return opened;
      try {
        const checkpoint = checkpointAt(opened.value, "checkpoint");
        const operation = opened.value.operation;
        const state: Live = { definition, attempt: null, carriers: new Map() };
        if (start.kind === "restore") {
          if (checkpoint.digest !== start.checkpoint.digest)
            throw new TypeError("The restored checkpoint differs");
          const expected = start.operation;
          if ((operation === null) !== (expected === null))
            throw new TypeError("The checkpoint's operation differs");
          if (expected !== null && isRecord(operation)) {
            const native = nativeIdentity(expected.attempt);
            if (textAt(operation, "attemptId") !== native)
              throw new TypeError("The checkpoint belongs to another attempt");
            const segments: number[] = [];
            for (let index = 0; index < expected.sequence; index += 1)
              segments.push(index);
            state.attempt = { id: expected.attempt, native, segments };
          }
        }
        cells.set(cell, state);
        return ok(checkpoint);
      } catch (error) {
        await exchange({ op: "dispose", cell }, "disposed", "unresponsive");
        return failure(
          "invalid_checkpoint",
          error instanceof Error ? error.message : "Invalid reply",
        );
      }
    },

    async start(dispatch) {
      const state = live(dispatch.cellId);
      if (!state.ok) return state;
      const task = nativeTask(
        dispatch.operation.skill,
        state.value.definition.fixture,
      );
      if (
        dispatch.purpose.kind === "workflow" &&
        (task === null ||
          dispatch.operation.parameters !== state.value.definition.modelHash)
      )
        return failure(
          "incompatible_start",
          "The operation does not match this cell's fixture and model",
        );
      const native = nativeIdentity(dispatch.attemptId);
      if (dispatch.origin.kind === "continuation") {
        // The restored world already executes the saved attempt.
        return state.value.attempt?.native === native
          ? ok({ kind: "started" })
          : failure("incompatible_start", "No saved attempt to continue");
      }
      if (state.value.attempt !== null)
        return failure("incompatible_start", "The cell is executing");
      const started = await exchange(
        dispatch.purpose.kind === "recovery"
          ? {
              op: "recover",
              cell: dispatch.cellId,
              attemptId: native,
              carrier: nativeIdentity(dispatch.purpose.carrier),
              handlingSteps: dispatch.purpose.handling / 2000,
              predecessor: dispatch.startingCheckpoint,
            }
          : { op: "start", cell: dispatch.cellId, attemptId: native, task },
        "started",
        "incompatible_start",
      );
      if (!started.ok) return started;
      if (started.value.kind === "started") {
        state.value.attempt = { id: dispatch.attemptId, native, segments: [] };
        return ok({ kind: "started" });
      }
      // The plan failed before any step: the cell is where it was.
      const exported = await exchange(
        { op: "export", cell: dispatch.cellId },
        "exported",
        "unresponsive",
      );
      if (!exported.ok) return exported;
      try {
        const zero = stepCount(0);
        if (!zero.ok) throw new TypeError("Zero is a step count");
        return ok({
          kind: "refused",
          terminal: terminalOf(
            dispatch,
            [],
            zero.value,
            outcomeAt(started.value),
            checkpointAt(exported.value, "checkpoint"),
          ),
        });
      } catch (error) {
        return failure(
          "unresponsive",
          error instanceof Error ? error.message : "Invalid reply",
        );
      }
    },

    async advance(attempt, steps) {
      const state = live(attempt.cellId);
      if (!state.ok) return state;
      const executing = state.value.attempt;
      if (executing === null || executing.id !== attempt.attemptId)
        return failure("incompatible_start", "The cell runs another attempt");
      const advanced = await exchange(
        { op: "advance", cell: attempt.cellId, steps },
        "advanced",
        "unresponsive",
      );
      if (!advanced.ok) return advanced;
      try {
        const raw = recordAt(advanced.value, "segment");
        requireDenseOperationRecording(raw, state.value.definition.fixture);
        const checkpoint = checkpointAt(advanced.value, "checkpoint");
        if (textAt(raw, "attemptId") !== executing.native)
          throw new TypeError("The segment belongs to another attempt");
        if (digestAt(raw, "checkpoint") !== checkpoint.digest)
          throw new TypeError("The segment ends at another checkpoint");
        const sequence = raw.sequence;
        if (!isNonNegativeInteger(sequence))
          throw new TypeError("A segment has a sequence");
        const end = stepsAt(raw, "endStep");
        const stop = textAt(advanced.value, "stop");
        const outcome =
          stop !== "terminal"
            ? null
            : state.value.definition.fixture === "persistent-pour-over/1"
              ? pourOverOutcomeAt(advanced.value)
              : outcomeAt(advanced.value);
        const events: NativeEvent[] = [];
        const rawEvents = raw.events;
        if (!Array.isArray(rawEvents))
          throw new TypeError("A segment lists its events");
        for (const event of rawEvents) {
          if (!isRecord(event)) throw new TypeError("An event is an object");
          // A phase change is controller progress, not a domain event.
          if (event.kind === "phase" || event.kind === "recovery-completed")
            continue;
          const head = {
            step: stepsAt(event, "step"),
            controllerSequence: events.length,
          };
          if (event.kind === "pickup") events.push({ ...head, kind: "pickup" });
          else if (event.kind === "carrier-removed")
            events.push({ ...head, kind: "carrier-removed" });
          else if (event.kind === "placement")
            events.push({ ...head, kind: "placement" });
          else if (event.kind === "failure" && outcome?.kind === "failed")
            events.push({
              ...head,
              kind: "failure",
              disposition: outcome.disposition,
              reason: outcome.reason,
            });
          else throw new TypeError("Unknown controller event");
        }
        const recording = JSON.stringify(raw);
        const segment = {
          runId: attempt.runId,
          executionId: attempt.executionId,
          cellId: attempt.cellId,
          attemptId: attempt.attemptId,
          kind: "segment" as const,
          sequence,
          predecessor: digestAt(raw, "predecessor"),
          steps: { start: stepsAt(raw, "startStep"), end },
          bundle: bundle.id,
          modelHash: digestAt(raw, "modelHash"),
          events,
          recording: {
            digest: (await sha256Hex(recording)) as Sha256Hex,
            // Controller recordings are ASCII: one byte for each character.
            byteLength: recording.length,
          },
          checkpoint,
        };
        const result = { segment, digest: digestAt(raw, "digest"), recording };
        executing.segments.push(sequence);
        if (stop === "allowance" || stop === "event")
          return ok<AdvanceResult>({ ...result, stop });
        if (outcome === null) throw new TypeError(`Unexpected stop ${stop}`);
        state.value.attempt = null;
        return ok<AdvanceResult>({
          ...result,
          stop: outcome.kind === "completed" ? "completed" : "failure",
          terminal: terminalOf(
            attempt,
            executing.segments,
            end,
            outcome,
            checkpoint,
          ),
        });
      } catch (error) {
        return failure(
          "unresponsive",
          error instanceof Error ? error.message : "Invalid reply",
        );
      }
    },

    async rest(cell, predecessor, steps, stopAtHold) {
      const state = live(cell);
      if (!state.ok) return state;
      if (state.value.attempt !== null)
        return failure("incompatible_start", "The cell is executing");
      // A station cell offers no hold, and its host refuses the field.
      const advanced = await exchange(
        isStation(state.value.definition)
          ? { op: "advance", cell, steps }
          : { op: "advance", cell, steps, stopAtHold },
        "advanced",
        "unresponsive",
      );
      if (!advanced.ok) return advanced;
      try {
        if (advanced.value.stop !== "idle")
          throw new TypeError("An idle cell reported an operation");
        const checkpoint = checkpointAt(advanced.value, "checkpoint");
        const recording = readCellRecording(
          advanced.value.recording,
          state.value.definition,
          predecessor,
          checkpoint,
          { kind: "idle" },
        );
        if (recording.kind !== "idle")
          throw new TypeError("An idle cell has no idle recording");
        return ok({
          cellId: cell,
          predecessor,
          checkpoint,
          recording,
          settled: holdAt(advanced.value),
        });
      } catch (error) {
        return failure(
          "unresponsive",
          error instanceof Error ? error.message : "Invalid reply",
        );
      }
    },

    async prepareBoundary(request) {
      const state = live(request.cellId);
      if (!state.ok) return state;
      const carrier = nativeIdentity(request.operation.carrier);
      if (request.slot.kind === "inactive")
        state.value.carriers.set(carrier, {
          kind: "active",
          generation: request.slot.generation + 1,
          carrier: request.operation.carrier,
        });
      const prepared = await exchange(
        {
          op: "prepare",
          cell: request.cellId,
          boundary: request.boundary,
          change: { kind: request.operation.kind, carrier },
        },
        "prepared",
        "boundary_rejected",
      );
      if (!prepared.ok) return prepared;
      try {
        const checkpoint = checkpointAt(prepared.value, "checkpoint");
        const slot = slotAt(prepared.value, state.value.carriers);
        const recording = readCellRecording(
          prepared.value.recording,
          state.value.definition,
          request.predecessor,
          checkpoint,
          {
            kind: request.operation.kind,
            before: request.slot,
            after: slot,
            nativeCarrier: carrier,
          },
        );
        if (recording.kind === "idle")
          throw new TypeError("A handoff has no boundary recording");
        const candidate = {
          boundary: request.boundary,
          cellId: request.cellId,
          predecessor: digestAt(prepared.value, "predecessor"),
          checkpoint,
          slot,
          recording,
        };
        if (candidate.predecessor !== request.predecessor)
          throw new TypeError("The cell is not in the state the request names");
        const digest = parseSha256Hex(
          await sha256Hex(JSON.stringify(candidate)),
        );
        if (!digest.ok) throw new TypeError("Invalid candidate digest");
        return ok<BoundaryCandidate>({
          ...candidate,
          digest: digest.value,
        });
      } catch (error) {
        await transport.send({
          op: "discard",
          cell: request.cellId,
          boundary: request.boundary,
        });
        return failure(
          "boundary_rejected",
          error instanceof Error ? error.message : "Invalid reply",
        );
      }
    },

    async commitBoundary(candidate) {
      const committed = await exchange(
        { op: "commit", cell: candidate.cellId, boundary: candidate.boundary },
        "committed",
        "boundary_rejected",
      );
      if (!committed.ok) return committed;
      try {
        return ok(checkpointAt(committed.value, "checkpoint"));
      } catch (error) {
        return failure(
          "unresponsive",
          error instanceof Error ? error.message : "Invalid reply",
        );
      }
    },

    async discardBoundary(candidate) {
      const discarded = await exchange(
        { op: "discard", cell: candidate.cellId, boundary: candidate.boundary },
        "discarded",
        "boundary_rejected",
      );
      if (!discarded.ok) return discarded;
      try {
        return ok(checkpointAt(discarded.value, "checkpoint"));
      } catch (error) {
        return failure(
          "unresponsive",
          error instanceof Error ? error.message : "Invalid reply",
        );
      }
    },

    async exportCheckpoint(cell) {
      const exported = await exchange(
        { op: "export", cell },
        "exported",
        "unresponsive",
      );
      if (!exported.ok) return exported;
      try {
        const checkpoint = checkpointAt(exported.value, "checkpoint");
        const content = textAt(exported.value, "content");
        if (
          content.length !== checkpoint.byteLength ||
          (await sha256Hex(content)) !== checkpoint.digest
        )
          throw new TypeError("The content is not what its digest names");
        return ok({ checkpoint, content });
      } catch (error) {
        return failure(
          "invalid_checkpoint",
          error instanceof Error ? error.message : "Invalid reply",
        );
      }
    },

    async dispose(cell) {
      if (!cells.delete(cell)) return;
      await exchange({ op: "dispose", cell }, "disposed", "unresponsive");
    },
  };
}

function matchesCell(id: unknown, cell: NativeCell): boolean {
  return cell.cellId === id;
}

/** Fixed fixtures answer through their own command namespace. */
function commandNamespace(
  cell: NativeCell | undefined,
): "espresso" | "pour-over" | null {
  switch (cell?.fixture) {
    case "persistent-espresso/1":
      return "espresso";
    case "persistent-pour-over/1":
      return "pour-over";
    default:
      return null;
  }
}
