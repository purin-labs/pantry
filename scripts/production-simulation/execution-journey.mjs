// The parts that the Node execution journeys share: a fresh evidence
// directory, the pinned execution engine, a host that begins a run from a
// scenario or a save, the drive to the next boundary, and readings of a run.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/std/src/index.ts";
import { PRODUCTION_EXECUTION_MANIFEST as manifest } from "../../packages/production-simulation/src/execution-manifest.generated.ts";
import { runtimeModule } from "./build-execution-bundle.mjs";
import { collectingExecutionHost } from "./collecting-execution-host.mjs";

/**
 * The evidence directory that process.argv[2] names. It must not exist; the
 * journey makes it. `message` (a text, or a function of the directory) is the
 * error when it exists.
 */
export function evidenceDirectory(message) {
  assert.equal(process.argv.length, 3, "Provide a fresh evidence directory");
  const output = resolve(process.argv[2]);
  assert.equal(
    existsSync(output),
    false,
    typeof message === "function" ? message(output) : message,
  );
  mkdirSync(output, { recursive: true });
  return output;
}

/** `save(name, data)` writes `data` as canonical JSON to `output`/name. */
export function evidenceWriter(output) {
  return function save(name, data) {
    writeFileSync(join(output, name), `${canonicalJson(data)}\n`);
  };
}

/** The value of an ok result; a refused result fails the journey. */
export function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.value;
}

/**
 * The engine of the pinned execution manifest (`E`), its runtime bundle
 * directory and the text codec of its Wasm transport.
 */
export async function pinnedEngine() {
  const engineDirectory = resolve(
    `apps/portal/public/bakery-physics/executions/${manifest.bundle.id}`,
  );
  const runtime = resolve(
    `apps/portal/public/bakery-physics/bundles/${manifest.runtime.id}`,
  );
  const E = await import(
    pathToFileURL(join(engineDirectory, manifest.engine.file)).href
  );
  return { E, runtime, codec: textCodec() };
}

/** The text codec of an engine's Wasm transport. */
export function textCodec() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    encode: encoder.encode.bind(encoder),
    decode: decoder.decode.bind(decoder),
  };
}

/** A fresh host of `engine` that collects the artifacts of each save. */
export async function executionHost({ E, runtime, codec }) {
  return collectingExecutionHost(
    E,
    E.wasmTransport(await runtimeModule(runtime), codec),
  );
}

/**
 * The begin request of a run of `bundle` with `cells`: from `scenario`, or
 * from `saved` (the reply of a save) when it is not null.
 */
export function beginRequest({
  bundle,
  cells,
  runId,
  executionId,
  hostSession,
  scenario,
  saved = null,
}) {
  return {
    kind: "begin",
    bundle,
    cells,
    identity: {
      runId,
      executionId,
      hostSession,
      parent:
        saved === null
          ? null
          : {
              snapshot: saved.document.snapshot,
              execution: saved.document.state.identity.executionId,
            },
    },
    origin:
      saved === null
        ? { kind: "scenario", scenario }
        : {
            kind: "snapshot",
            document: saved.document,
            checkpoints: saved.artifacts,
          },
  };
}

/** A fresh host of `engine` that began the run of `request`. */
export async function beginRun(engine, request) {
  const host = await executionHost(engine);
  const reply = await host.handle(beginRequest(request));
  assert.equal(reply.kind, "began", JSON.stringify(reply));
  return host;
}

/** The statuses at which a drive stops before its time. */
const BOUNDARIES = [
  "completed",
  "blocked",
  "stopped-at-limit",
  "awaiting-inspection",
];

/**
 * Drives the run in calls of 128 turns, in at most `calls` calls, until the
 * time `until` or a status of `stops`. It returns the state's run and the
 * last view. `bound` is the error when the calls run out.
 */
export async function driveRun(
  host,
  { until, calls, bound, stops = BOUNDARIES },
) {
  for (let call = 0; call < calls; call++) {
    const reply = await host.handle({ kind: "drive", turns: 128, until });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    if (reply.view.time >= until || stops.includes(reply.view.status.kind)) {
      const state = await host.handle({ kind: "state" });
      assert.equal(state.kind, "state");
      return { run: state.run, view: reply.view };
    }
  }
  throw new Error(bound);
}

export function pendingInspection(item) {
  return item.kind === "pending";
}

export function sameId(id, item) {
  return item.id === id;
}

/** The amount of the run's quantity reports to `destination`. */
export function reported(run, destination) {
  let amount = 0;
  for (const event of run.events) {
    if (
      event.kind === "quantity-reported" &&
      event.destination === destination
    ) {
      amount += event.quantity.amount;
    }
  }
  return amount;
}

/** The run's events without their order and the host's own events. */
export function processEvents(run) {
  const events = [];
  for (const { sequence, execution, ...event } of run.events) {
    if (!["command-admitted", "pause-settled"].includes(event.kind)) {
      events.push(event);
    }
  }
  return events;
}

/**
 * Records `outcome` for the view's pending inspection with `note`. A repeat
 * of the request returns the same receipt. With `checkRefusals`, the host
 * first refuses the request for a wrong lot.
 */
export async function inspectPending(host, view, outcome, checkRefusals, note) {
  const pending = view.inspections.find(pendingInspection);
  assert.ok(pending);
  const request = {
    kind: "inspect",
    commandId: `inspect-${pending.task.replace(/[^a-z0-9-]/g, "-")}`,
    expectedControlRevision: view.controlRevision,
    task: pending.task,
    definition: pending.definition,
    lots: pending.lots,
    outcome,
    note,
  };
  if (checkRefusals) {
    const wrong = await host.handle({
      ...request,
      commandId: "wrong-tea-lot",
      lots: ["wrong-lot"],
    });
    assert.equal(wrong.receipt.reason, "inspection_binding_mismatch");
  }
  const reply = await host.handle(request);
  assert.equal(reply.kind, "commanded", JSON.stringify(reply));
  assert.equal(reply.receipt.status, "accepted", JSON.stringify(reply));
  const duplicate = await host.handle(request);
  assert.deepEqual(duplicate.receipt, reply.receipt);
}
