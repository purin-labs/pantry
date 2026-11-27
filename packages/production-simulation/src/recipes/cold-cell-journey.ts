import { canonicalJson, sha256Hex } from "@purin-labs/std";
import type { RecipeAdapter, ValueProblem } from "../adapters.ts";
import { authoredId, parseId, parseSha256Hex } from "../identity.ts";
import { normalizeQuantity } from "../quantity.ts";
import { err, ok } from "../result.ts";
import {
  DISPATCH_POLICY,
  MAX_EVENT_CAP,
  SCENARIO_SCHEMA_VERSION,
  type CompiledScenario,
} from "../scenario.ts";
import {
  ZERO_DURATION,
  ZERO_TIME,
  durationFromSeconds,
  modelTimestep,
  timeFromSeconds,
  type LogicalTime,
  type TickDuration,
} from "../time.ts";

/**
 * The Plan 70 single-cell journey: orders that each put one tray through one
 * cold cell. A baker carries a tray from the store to the cell's table, the
 * arm transfers it to the rack, and the baker carries it out. The cell holds
 * one tray, so each order waits for the tray before it to leave.
 */

/** Every value the journey declares. Handling times are assumptions. */
type ColdCellJourneyValues = Readonly<{
  horizonSeconds: number;
  orders: number;
  trays: readonly string[];
  cell: Readonly<{
    id: string;
    modelHash: string;
    controllerSourceHash: string;
    timestepSeconds: number;
    /** The settled hold the cell may take while idle, or none. */
    holdModel: string | null;
  }>;
  /** The baker's carry from the tray store to the cell's table. */
  load: Readonly<{
    pickupSeconds: number;
    placementSeconds: number;
    durationSeconds: number;
  }>;
  /** The baker's carry from the cell's rack to the outbound shelf. */
  unload: Readonly<{
    pickupSeconds: number;
    placementSeconds: number;
    durationSeconds: number;
  }>;
}>;

/** The declared values with the revision and content digest they were read at. */
type ColdCellJourneySnapshot = Readonly<{
  source: Readonly<{ revision: number; digest: string }>;
  values: ColdCellJourneyValues;
}>;

export async function coldCellJourneySnapshot(
  values: ColdCellJourneyValues,
  revision: number,
): Promise<ColdCellJourneySnapshot> {
  return {
    source: { revision, digest: await sha256Hex(canonicalJson(values)) },
    values,
  };
}

const SCENARIO = authoredId("scenario", "plan-70-cold-cell-journey");
const SOURCE = authoredId("source", "plan-70-cold-cell-journey");
const BAKER = authoredId("resource", "baker");
const ARM = authoredId("resource", "transfer-arm");
const BATCH = authoredId("product", "portioned-tray");
const RACKED = authoredId("destination", "trays-racked");
const TRAY_STORE = authoredId("storage", "tray-store");
const SOURCE_TABLE = authoredId("storage", "source-table");
const RACK = authoredId("storage", "rack");
const OUTBOUND = authoredId("storage", "outbound-shelf");
const WORKFLOW = authoredId("workflow", "rack-one-tray");
const ORDERS = authoredId("arrival-source", "tray-orders");
const TRAY = authoredId("carrier-role", "tray");
const LOAD = authoredId("task-key", "load");
const TRANSFER = authoredId("task-key", "transfer");
const UNLOAD = authoredId("task-key", "unload");
const LOT = authoredId("lot-key", "tray-load");
const RACK_TRANSFER = authoredId("skill", "rack-transfer");

function span(
  value: number,
  where: string,
  problems: ValueProblem[],
): TickDuration {
  const parsed = durationFromSeconds(value);
  if (parsed.ok) return parsed.value;
  problems.push({ where, error: parsed.error });
  return ZERO_DURATION;
}

function moment(
  value: number,
  where: string,
  problems: ValueProblem[],
): LogicalTime {
  const parsed = timeFromSeconds(value);
  if (parsed.ok) return parsed.value;
  problems.push({ where, error: parsed.error });
  return ZERO_TIME;
}

function compile({ source, values }: ColdCellJourneySnapshot) {
  const problems: ValueProblem[] = [];
  const digest = parseSha256Hex(source.digest);
  const modelHash = parseSha256Hex(values.cell.modelHash);
  const controllerSourceHash = parseSha256Hex(values.cell.controllerSourceHash);
  const cell = parseId("cell", values.cell.id);
  const timestep = modelTimestep(values.cell.timestepSeconds);
  const holdModel =
    values.cell.holdModel === null
      ? null
      : parseId("hold-model", values.cell.holdModel);
  if (holdModel !== null && !holdModel.ok)
    problems.push({ where: "cell.holdModel", error: holdModel.error });
  // Each order's tray carries one counted load.
  const one = normalizeQuantity({ amount: 1, scale: 0, unit: "each" });
  for (const [where, parsed] of [
    ["tray load", one],
    ["source.digest", digest],
    ["cell.modelHash", modelHash],
    ["cell.controllerSourceHash", controllerSourceHash],
    ["cell.id", cell],
    ["cell.timestepSeconds", timestep],
  ] as const)
    if (!parsed.ok) problems.push({ where, error: parsed.error });
  const carriers: CompiledScenario["carriers"][number][] = [];
  for (const [index, tray] of values.trays.entries()) {
    const id = parseId("carrier", tray);
    if (id.ok) carriers.push({ id: id.value, storage: TRAY_STORE });
    else problems.push({ where: `trays[${index}]`, error: id.error });
  }
  const horizon = moment(values.horizonSeconds, "horizonSeconds", problems);
  const load = {
    pickup: span(values.load.pickupSeconds, "load.pickupSeconds", problems),
    placement: span(
      values.load.placementSeconds,
      "load.placementSeconds",
      problems,
    ),
    duration: span(
      values.load.durationSeconds,
      "load.durationSeconds",
      problems,
    ),
  };
  const unload = {
    pickup: span(values.unload.pickupSeconds, "unload.pickupSeconds", problems),
    placement: span(
      values.unload.placementSeconds,
      "unload.placementSeconds",
      problems,
    ),
    duration: span(
      values.unload.durationSeconds,
      "unload.durationSeconds",
      problems,
    ),
  };
  if (
    !digest.ok ||
    !modelHash.ok ||
    !controllerSourceHash.ok ||
    !cell.ok ||
    !timestep.ok ||
    !one.ok ||
    problems.length > 0
  )
    return err(problems);

  const scenario: CompiledScenario = {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: SCENARIO,
    policy: DISPATCH_POLICY,
    sources: [{ id: SOURCE, revision: source.revision, digest: digest.value }],
    limits: { horizon, eventCap: MAX_EVENT_CAP },
    products: [{ id: BATCH, unit: "each" }],
    destinations: [{ id: RACKED, role: "final-output", product: BATCH }],
    resources: [
      { kind: "capacity", id: BAKER, capacity: 1, configuration: null },
      { kind: "capacity", id: ARM, capacity: 1, configuration: null },
    ],
    storages: [
      {
        id: TRAY_STORE,
        capacity: { kind: "carriers", slots: values.trays.length },
        cell: null,
      },
      {
        id: SOURCE_TABLE,
        capacity: { kind: "carriers", slots: 1 },
        cell: cell.value,
      },
      { id: RACK, capacity: { kind: "carriers", slots: 1 }, cell: cell.value },
      {
        id: OUTBOUND,
        capacity: { kind: "carriers", slots: values.trays.length },
        cell: null,
      },
    ],
    carriers,
    cells: [
      {
        id: cell.value,
        modelHash: modelHash.value,
        controllerSourceHash: controllerSourceHash.value,
        timestepMicroseconds: timestep.value,
        carrierSlots: 1,
        holdModel: holdModel !== null && holdModel.ok ? holdModel.value : null,
      },
    ],
    stock: [],
    workflows: [
      {
        id: WORKFLOW,
        revision: digest.value,
        demand: "order",
        tasks: [
          {
            key: LOAD,
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [],
            claims: [{ resource: BAKER, units: 1, configuration: null }],
            executor: {
              kind: "declared",
              duration: load.duration,
              evidence: "assumed",
            },
            inputs: [],
            outputs: [
              {
                kind: "lot",
                lot: LOT,
                product: BATCH,
                quantity: one.value,
                holder: { kind: "carrier", carrier: TRAY },
                disposition: "released",
                report: null,
              },
            ],
            releases: [],
            carriers: [
              { kind: "acquire", role: TRAY, from: TRAY_STORE },
              {
                kind: "move",
                role: TRAY,
                from: TRAY_STORE,
                to: SOURCE_TABLE,
                timing: {
                  kind: "declared",
                  pickupAfter: load.pickup,
                  placementAfter: load.placement,
                },
              },
            ],
          },
          {
            key: TRANSFER,
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [LOAD],
            claims: [{ resource: ARM, units: 1, configuration: null }],
            executor: {
              kind: "native",
              operation: {
                cell: cell.value,
                skill: RACK_TRANSFER,
                // The cell's pinned model is the whole request of this skill.
                parameters: modelHash.value,
              },
            },
            inputs: [],
            outputs: [],
            releases: [],
            carriers: [
              {
                kind: "move",
                role: TRAY,
                from: SOURCE_TABLE,
                to: RACK,
                timing: { kind: "native" },
              },
            ],
          },
          {
            key: UNLOAD,
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [TRANSFER],
            claims: [{ resource: BAKER, units: 1, configuration: null }],
            executor: {
              kind: "declared",
              duration: unload.duration,
              evidence: "assumed",
            },
            inputs: [{ kind: "lot", lot: LOT, quantity: one.value }],
            outputs: [
              {
                kind: "exit",
                product: BATCH,
                quantity: one.value,
                destination: RACKED,
              },
            ],
            releases: [],
            carriers: [
              {
                kind: "move",
                role: TRAY,
                from: RACK,
                to: OUTBOUND,
                timing: {
                  kind: "declared",
                  pickupAfter: unload.pickup,
                  placementAfter: unload.placement,
                },
              },
              { kind: "release", role: TRAY },
            ],
          },
        ],
      },
    ],
    arrivals: [
      {
        id: ORDERS,
        workflow: WORKFLOW,
        kind: "explicit",
        arrivals: [{ time: ZERO_TIME, quantity: values.orders }],
      },
    ],
    availability: [],
    dependencies: [],
  };
  return ok(scenario);
}

export const coldCellJourneyAdapter: RecipeAdapter<
  ColdCellJourneySnapshot,
  ValueProblem
> = Object.freeze({ compile });
