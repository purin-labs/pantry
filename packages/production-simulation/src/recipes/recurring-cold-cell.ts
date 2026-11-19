import { canonicalJson, sha256Hex } from "@purin-labs/std";
import { value } from "../document-values.ts";
import {
  authoredId,
  parseSha256Hex,
  type ResourceId,
  type StorageId,
  type TaskKey,
} from "../identity.ts";
import { normalizeQuantity } from "../quantity.ts";
import {
  DISPATCH_POLICY,
  MAX_EVENT_CAP,
  SCENARIO_SCHEMA_VERSION,
  type CarrierStep,
  type CompiledScenario,
  type PhysicalCellDefinition,
  type TaskDefinition,
  type TaskExecutor,
} from "../scenario.ts";
import {
  ZERO_DURATION,
  ZERO_TIME,
  durationFromSeconds,
  timeFromSeconds,
} from "../time.ts";

/** The six fixed Plan 70C cases. Durations and order counts are not tuning inputs. */
export type ColdCellComparison =
  | Readonly<{ kind: "stress"; bufferSlots: 1 | 2; receivingHold?: never }>
  | Readonly<{ kind: "balanced"; bufferSlots: 1 | 2; receivingHold: boolean }>;

const TRAY = authoredId("carrier-role", "tray");
const LOT = authoredId("lot-key", "cold-item");
const PRODUCT = authoredId("product", "cold-item");
const OUTPUT = authoredId("destination", "completed-items");
const BAKER = authoredId("resource", "baker");
const SOURCE_ARM = authoredId("resource", "source-arm");
const RECEIVING_ARM = authoredId("resource", "receiving-arm");
const STORE = authoredId("storage", "tray-store");
const SOURCE_TABLE = authoredId("storage", "source-table");
const SOURCE_RACK = authoredId("storage", "source-rack");
const BUFFER = authoredId("storage", "intermediate-buffer");
const RECEIVING_TABLE = authoredId("storage", "receiving-table");
const RECEIVING_RACK = authoredId("storage", "receiving-rack");
const UNLOADING = authoredId("storage", "unloading-position");
const ADMIT = authoredId("task-key", "admit");
const SOURCE_TRANSFER = authoredId("task-key", "source-transfer");
const TO_BUFFER = authoredId("task-key", "to-buffer");
const FROM_BUFFER = authoredId("task-key", "from-buffer");
const RECEIVING_TRANSFER = authoredId("task-key", "receiving-transfer");
const TO_UNLOAD = authoredId("task-key", "to-unload");
const UNLOAD = authoredId("task-key", "unload");
const RETURN = authoredId("task-key", "return");
const ONE = value(normalizeQuantity({ amount: 1, scale: 0, unit: "each" }));

function carry(from: StorageId, to: StorageId): CarrierStep {
  return {
    kind: "move",
    role: TRAY,
    from,
    to,
    timing: {
      kind: "declared",
      pickupAfter: value(durationFromSeconds(10)),
      placementAfter: value(durationFromSeconds(30)),
    },
  };
}

function handling(seconds: number): TaskExecutor {
  return {
    kind: "declared",
    duration: value(durationFromSeconds(seconds)),
    evidence: "assumed",
  };
}

function task(
  key: TaskKey,
  prerequisites: readonly TaskKey[],
  resource: ResourceId,
  executor: TaskExecutor,
  carriers: readonly CarrierStep[],
): TaskDefinition {
  return {
    key,
    priority: 0,
    releaseAfter: ZERO_DURATION,
    prerequisites,
    claims: [{ resource, units: 1, configuration: null }],
    executor,
    inputs: [],
    outputs: [],
    releases: [],
    carriers,
  };
}

function transfer(
  key: TaskKey,
  predecessor: TaskKey,
  arm: ResourceId,
  cell: PhysicalCellDefinition,
  from: StorageId,
  to: StorageId,
): TaskDefinition {
  return task(
    key,
    [predecessor],
    arm,
    {
      kind: "native",
      operation: {
        cell: cell.id,
        skill: authoredId("skill", "rack-transfer"),
        parameters: cell.modelHash,
      },
    },
    [{ kind: "move", role: TRAY, from, to, timing: { kind: "native" } }],
  );
}

/** Compile the route into the existing engine. All custody and schedules stay there. */
export async function recurringColdCellScenario(
  cells: readonly [PhysicalCellDefinition, PhysicalCellDefinition],
  comparison: ColdCellComparison,
): Promise<CompiledScenario> {
  const source = cells[0];
  const receiving = cells[1];
  const tasks: TaskDefinition[] = [
    {
      ...task(ADMIT, [], BAKER, handling(40), [
        { kind: "acquire", role: TRAY, from: STORE },
        carry(STORE, SOURCE_TABLE),
      ]),
      outputs: [
        {
          kind: "lot",
          lot: LOT,
          product: PRODUCT,
          quantity: ONE,
          holder: { kind: "carrier", carrier: TRAY },
          disposition: "released",
          report: null,
        },
      ],
    },
    transfer(
      SOURCE_TRANSFER,
      ADMIT,
      SOURCE_ARM,
      source,
      SOURCE_TABLE,
      SOURCE_RACK,
    ),
    task(TO_BUFFER, [SOURCE_TRANSFER], BAKER, handling(40), [
      carry(SOURCE_RACK, BUFFER),
    ]),
    task(FROM_BUFFER, [TO_BUFFER], BAKER, handling(40), [
      carry(BUFFER, RECEIVING_TABLE),
    ]),
    transfer(
      RECEIVING_TRANSFER,
      FROM_BUFFER,
      RECEIVING_ARM,
      receiving,
      RECEIVING_TABLE,
      RECEIVING_RACK,
    ),
    task(TO_UNLOAD, [RECEIVING_TRANSFER], BAKER, handling(40), [
      carry(RECEIVING_RACK, UNLOADING),
    ]),
    {
      ...task(UNLOAD, [TO_UNLOAD], BAKER, handling(60), []),
      inputs: [{ kind: "lot", lot: LOT, quantity: ONE }],
      outputs: [
        { kind: "exit", product: PRODUCT, quantity: ONE, destination: OUTPUT },
      ],
    },
    task(RETURN, [UNLOAD], BAKER, handling(40), [
      carry(UNLOADING, STORE),
      { kind: "release", role: TRAY },
    ]),
  ];
  const intervalSeconds = comparison.kind === "stress" ? 90 : 360;
  const hold = comparison.kind === "stress" || comparison.receivingHold;
  const holdEnd = comparison.kind === "stress" ? 900 : 1500;
  const sourceId = authoredId("source", "plan-70-recurring-cold-cell");
  const workflow = authoredId("workflow", "cold-cell-route");
  const revision = value(
    parseSha256Hex(
      await sha256Hex(
        canonicalJson({
          cells,
          comparison,
          tasks,
          orders: 24,
          intervalSeconds,
          holdEnd,
        }),
      ),
    ),
  );
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: authoredId("scenario", "plan-70-recurring-cold-cell"),
    policy: DISPATCH_POLICY,
    sources: [{ id: sourceId, revision: 1, digest: revision }],
    limits: {
      horizon: value(timeFromSeconds(4 * 3600)),
      eventCap: MAX_EVENT_CAP,
    },
    products: [{ id: PRODUCT, unit: "each" }],
    destinations: [{ id: OUTPUT, role: "final-output", product: PRODUCT }],
    resources: [
      { kind: "capacity", id: BAKER, capacity: 1, configuration: null },
      { kind: "capacity", id: SOURCE_ARM, capacity: 1, configuration: null },
      { kind: "capacity", id: RECEIVING_ARM, capacity: 1, configuration: null },
    ],
    storages: [
      { id: STORE, capacity: { kind: "carriers", slots: 4 }, cell: null },
      {
        id: SOURCE_TABLE,
        capacity: { kind: "carriers", slots: 1 },
        cell: source.id,
      },
      {
        id: SOURCE_RACK,
        capacity: { kind: "carriers", slots: 1 },
        cell: source.id,
      },
      {
        id: BUFFER,
        capacity: { kind: "carriers", slots: comparison.bufferSlots },
        cell: null,
      },
      {
        id: RECEIVING_TABLE,
        capacity: { kind: "carriers", slots: 1 },
        cell: receiving.id,
      },
      {
        id: RECEIVING_RACK,
        capacity: { kind: "carriers", slots: 1 },
        cell: receiving.id,
      },
      { id: UNLOADING, capacity: { kind: "carriers", slots: 1 }, cell: null },
    ],
    carriers: [
      { id: authoredId("carrier", "tray-a"), storage: STORE },
      { id: authoredId("carrier", "tray-b"), storage: STORE },
      { id: authoredId("carrier", "tray-c"), storage: STORE },
      { id: authoredId("carrier", "tray-d"), storage: STORE },
    ],
    cells,
    stock: [],
    workflows: [{ id: workflow, revision, demand: "order", tasks }],
    arrivals: [
      {
        id: authoredId("arrival-source", "orders"),
        workflow,
        kind: "periodic",
        first: ZERO_TIME,
        interval: value(durationFromSeconds(intervalSeconds)),
        limit: { kind: "count", count: 24 },
      },
    ],
    availability: hold
      ? [
          {
            id: authoredId("availability", "receiving-hold"),
            resource: RECEIVING_ARM,
            interval: {
              start: value(timeFromSeconds(300)),
              end: value(timeFromSeconds(holdEnd)),
            },
          },
        ]
      : [],
    dependencies: [],
  };
}
