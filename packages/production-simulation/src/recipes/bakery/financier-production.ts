import { canonicalJson, isRecord, sha256Hex } from "@seams/std";
import { parsePersistentCell } from "@seams/bakery-model/bakery-physics";
import * as d from "../../document-values.ts";
import {
  authoredId,
  type CarrierId,
  type Sha256Hex,
  type WorkflowId,
} from "../../identity.ts";
import { normalizeQuantity, type MaterialQuantity } from "../../quantity.ts";
import { err, ok, type Result } from "../../result.ts";
import type {
  CarrierStep,
  CompiledScenario,
  LotHolder,
  MaterialInput,
  MaterialOutput,
  TaskDefinition,
  TaskExecutor,
} from "../../scenario.ts";
import {
  ZERO_DURATION,
  ZERO_TIME,
  durationFromSeconds,
  modelTimestep,
  type TickDuration,
} from "../../time.ts";
import {
  compileFinancierPreparation,
  type FinancierPreparationProblem,
} from "./financier-preparation.ts";
import {
  FINANCIER_FLAVOURS,
  financierBatchFormula,
  financierBatterPrepared,
  financierLoadId,
  financierPreparationSource,
  preparedFinancierBatter,
  type FinancierFlavour,
} from "./financier-flavours.ts";
import { addQuantity } from "../../quantity.ts";
import { sharedRecipeRecords } from "./shared-records.ts";

type ColdRackCell = CompiledScenario["cells"][number];
type MouldProfile = "matsunaga-financier-8p";
type Inspection = Readonly<{
  sampleMass: MaterialQuantity;
  samplePieces: MaterialQuantity;
}>;
type Mould = Readonly<{
  id: CarrierId;
  cavities: number;
  profile?: MouldProfile;
}>;
type Cavity = Readonly<{ number: number; mass: MaterialQuantity }>;
type Load = Readonly<{
  id: WorkflowId;
  flavour: FinancierFlavour;
  mould: CarrierId;
  cavities: readonly Cavity[];
  filledMass: MaterialQuantity;
  pieces: MaterialQuantity;
  bakedMass: MaterialQuantity;
  evaporation: MaterialQuantity;
  inspection: Inspection;
}>;
const DURATIONS = [
  "preheat",
  "prepare-mould",
  "fill-cavity",
  "transfer",
  "bake",
  "inspect",
  "cool-in-mould",
  "demould",
  "clean",
  "crumb-wait",
  "crumb-check",
  "pack-ready",
  "pack",
] as const;
type Recipe = Readonly<{
  revision: number;
  moulds: readonly Mould[];
  loads: readonly Load[];
  durations: Readonly<Record<(typeof DURATIONS)[number], TickDuration>>;
  gridSlots: number;
}>;
export type FinancierRecipeProblem =
  | FinancierPreparationProblem
  | Readonly<{
      code: "invalid_recipe" | "bake_mass_balance" | "insufficient_batter";
    }>;

function mass(raw: unknown): MaterialQuantity {
  return d.value(
    normalizeQuantity({ amount: d.natural(raw), scale: 3, unit: "gram" }),
  );
}
function pieces(raw: unknown): MaterialQuantity {
  return d.value(
    normalizeQuantity({ amount: d.natural(raw), scale: 0, unit: "each" }),
  );
}
function duration(raw: unknown): TickDuration {
  d.requireValue(typeof raw === "number" && raw > 0);
  return d.value(durationFromSeconds(raw));
}
function mouldId(raw: unknown): CarrierId {
  const id = d.authored("carrier", raw);
  d.requireValue(id.startsWith("mould-"));
  d.authored("storage", `clean-${id}`);
  return id;
}
function readMould(raw: unknown): Mould {
  d.requireValue(isRecord(raw));
  const r =
    "profile" in raw
      ? d.record(raw, ["id", "cavities", "profile"])
      : d.record(raw, ["id", "cavities"]);
  const id = mouldId(r.id);
  const cavities = d.choice(r.cavities, 8);
  if (!("profile" in r)) return { id, cavities };
  return {
    id,
    cavities,
    profile: d.choice(r.profile, "matsunaga-financier-8p"),
  };
}
function readColdCell(rawCell: unknown): ColdRackCell {
  const definition = parsePersistentCell(rawCell);
  d.requireValue(
    definition !== null &&
      definition.fixture === "persistent-rack/1" &&
      definition.ingredients.massKg === 1 &&
      definition.ingredients.forwardMm === 0 &&
      definition.ingredients.lateralMm === 0 &&
      definition.clampForceN === 100,
  );
  return {
    id: authoredId("cell", definition.cellId),
    modelHash: d.digest(definition.modelHash),
    controllerSourceHash: d.digest(definition.execution.controllerSourceHash),
    timestepMicroseconds: d.value(modelTimestep(definition.timestep)),
    carrierSlots: 1,
    holdModel: authoredId("hold-model", "cold-cell-rest.1"),
  };
}
function readCavity(raw: unknown): Cavity {
  const r = d.record(raw, ["number", "massMg"]);
  const quantity = mass(r.massMg);
  d.requireValue(quantity.amount > 0);
  return { number: d.positive(r.number), mass: quantity };
}
function readInspection(raw: unknown): Inspection {
  const r = d.record(raw, ["sampleMassMg", "samplePieces"]);
  const sampleMass = mass(r.sampleMassMg);
  const samplePieces = pieces(r.samplePieces);
  d.requireValue((sampleMass.amount === 0) === (samplePieces.amount === 0));
  return { sampleMass, samplePieces };
}
function readLoad(raw: unknown): Load {
  const r = d.record(raw, [
    "id",
    "flavour",
    "mould",
    "cavities",
    "bakedMassMg",
    "evaporationMg",
    "inspection",
  ]);
  const id = d.authored("workflow", r.id);
  d.requireValue(id.startsWith("load-"));
  const cavities = d.array(r.cavities, readCavity);
  d.requireValue(cavities.length > 0 && cavities.length <= 8);
  let total = 0;
  const positions = new Set<number>();
  for (const cavity of cavities) {
    d.requireValue(!positions.has(cavity.number));
    positions.add(cavity.number);
    total += cavity.mass.amount;
  }
  const bakedMass = mass(r.bakedMassMg);
  d.requireValue(bakedMass.amount > 0);
  const inspection = readInspection(r.inspection);
  d.requireValue(inspection.sampleMass.amount < bakedMass.amount);
  d.requireValue(inspection.samplePieces.amount < cavities.length);
  return {
    id,
    flavour: d.choice(r.flavour, ...FINANCIER_FLAVOURS),
    mould: mouldId(r.mould),
    cavities,
    filledMass: mass(total),
    pieces: pieces(cavities.length),
    bakedMass,
    evaporation: mass(r.evaporationMg),
    inspection,
  };
}
function readRecipe(r: Record<string, unknown>): Recipe {
  d.choice(r.evidence, "assumed");
  const moulds = d.array(r.moulds, readMould);
  const loads = d.array(r.loads, readLoad);
  d.requireValue(
    moulds.length > 0 &&
      moulds.length <= 6 &&
      loads.length > 0 &&
      loads.length <= 12,
  );
  const mouldById = new Map<CarrierId, Mould>();
  for (const mould of moulds) {
    d.requireValue(!mouldById.has(mould.id));
    mouldById.set(mould.id, mould);
  }
  const loadIds = new Set<WorkflowId>();
  for (const load of loads) {
    d.requireValue(!loadIds.has(load.id));
    loadIds.add(load.id);
    const mould = mouldById.get(load.mould);
    d.requireValue(mould !== undefined);
    for (const cavity of load.cavities)
      d.requireValue(cavity.number <= mould.cavities);
  }
  const t = d.record(r.durationsSeconds, DURATIONS);
  const durations = {
    preheat: duration(t.preheat),
    "prepare-mould": duration(t["prepare-mould"]),
    "fill-cavity": duration(t["fill-cavity"]),
    transfer: duration(t.transfer),
    bake: duration(t.bake),
    inspect: duration(t.inspect),
    "cool-in-mould": duration(t["cool-in-mould"]),
    demould: duration(t.demould),
    clean: duration(t.clean),
    "crumb-wait": duration(t["crumb-wait"]),
    "crumb-check": duration(t["crumb-check"]),
    "pack-ready": duration(t["pack-ready"]),
    pack: duration(t.pack),
  };
  d.requireValue(durations.clean >= durations.transfer);
  const gridSlots = d.positive(r.gridSlots);
  d.requireValue(gridSlots <= 6);
  return {
    revision: d.positive(r.revision),
    moulds,
    loads,
    durations,
    gridSlots,
  };
}

function manual(
  duration: TickDuration,
  start: string,
  finish: string,
): TaskExecutor {
  return {
    kind: "attended",
    duration,
    evidence: "assumed",
    workers: [authoredId("resource", "baker")],
    start: authoredId("location", start),
    finish: authoredId("location", finish),
  };
}
function passive(duration: TickDuration): TaskExecutor {
  return { kind: "declared", duration, evidence: "assumed" };
}
function step(
  key: string,
  previous: readonly string[],
  executor: TaskExecutor,
  resource: string | null,
  inputs: readonly MaterialInput[],
  outputs: readonly MaterialOutput[],
  carriers: readonly CarrierStep[],
  releases: readonly string[],
): TaskDefinition {
  return {
    key: authoredId("task-key", key),
    priority: 0,
    releaseAfter: ZERO_DURATION,
    prerequisites: previous.map(taskKey),
    executor,
    claims:
      resource === null
        ? []
        : [
            {
              resource: authoredId("resource", resource),
              units: 1,
              configuration: null,
            },
          ],
    inputs,
    outputs,
    carriers,
    releases: releases.map(lotKey),
  };
}
function taskKey(key: string) {
  return authoredId("task-key", key);
}
function lotKey(key: string) {
  return authoredId("lot-key", key);
}
function input(key: string, quantity: MaterialQuantity): MaterialInput {
  return { kind: "lot", lot: lotKey(key), quantity };
}
function carrier(role: "mould" | "grid"): LotHolder {
  return { kind: "carrier", carrier: authoredId("carrier-role", role) };
}
function lot(
  key: string,
  product: string,
  quantity: MaterialQuantity,
  holder: LotHolder,
  disposition: "held" | "released",
  report: string | null,
): MaterialOutput {
  return {
    kind: "lot",
    lot: lotKey(key),
    product: authoredId("product", product),
    quantity,
    holder,
    disposition,
    report: report === null ? null : authoredId("destination", report),
  };
}
function exit(
  product: string,
  quantity: MaterialQuantity,
  destination: string,
): MaterialOutput {
  return {
    kind: "exit",
    product: authoredId("product", product),
    quantity,
    destination: authoredId("destination", destination),
  };
}
function move(
  role: "mould" | "grid",
  from: string,
  to: string,
  duration: TickDuration,
): CarrierStep {
  return {
    kind: "move",
    role: authoredId("carrier-role", role),
    from: authoredId("storage", from),
    to: authoredId("storage", to),
    timing: {
      kind: "declared",
      pickupAfter: ZERO_DURATION,
      placementAfter: duration,
    },
  };
}

function inspectedExit(
  dimension: "mass" | "pieces",
  quantity: MaterialQuantity,
): MaterialOutput {
  return {
    kind: "inspection-exit",
    inspections: [taskKey("inspect-bake"), taskKey("release-for-packing")],
    product: authoredId("product", `packed-${dimension}`),
    quantity,
    destination: authoredId("destination", `packed-${dimension}`),
    rejectedProduct: authoredId("product", `rejected-${dimension}`),
    rejectedDestination: authoredId("destination", `rejected-${dimension}`),
  };
}

function loadTasks(
  recipe: Recipe,
  load: Load,
  cell: ColdRackCell | null,
): TaskDefinition[] {
  const t = recipe.durations;
  const home = `clean-${load.mould}`;
  const tasks: TaskDefinition[] = [
    step(
      "prepare-mould",
      [],
      manual(t["prepare-mould"], "prep", "prep"),
      null,
      [],
      [],
      [
        {
          kind: "acquire",
          role: authoredId("carrier-role", "mould"),
          from: authoredId("storage", home),
        },
        move("mould", home, "filled-moulds", t["prepare-mould"]),
      ],
      [],
    ),
  ];
  let previous = "prepare-mould";
  const bakeInputs: MaterialInput[] = [];
  for (const cavity of load.cavities) {
    const key = `fill-cavity-${cavity.number}`;
    const filledMass = `${key}-mass`;
    const filledCount = `${key}-piece`;
    const one = pieces(1);
    tasks.push(
      step(
        key,
        [previous],
        manual(t["fill-cavity"], "prep", "prep"),
        "scale",
        [
          {
            kind: "pool",
            product: authoredId(
              "product",
              preparedFinancierBatter(load.flavour),
            ),
            quantity: cavity.mass,
          },
        ],
        [
          lot(
            filledMass,
            "filled-mass",
            cavity.mass,
            carrier("mould"),
            "released",
            "filled-mass",
          ),
          lot(
            filledCount,
            "filled-pieces",
            one,
            carrier("mould"),
            "released",
            "filled-pieces",
          ),
        ],
        [],
        [],
      ),
    );
    bakeInputs.push(input(filledMass, cavity.mass), input(filledCount, one));
    previous = key;
  }
  const baked = [
    lot(
      "baked-mass",
      "baked-mass",
      load.bakedMass,
      carrier("mould"),
      "held",
      null,
    ),
    lot(
      "baked-pieces",
      "baked-pieces",
      load.pieces,
      carrier("mould"),
      "held",
      null,
    ),
  ];
  if (load.evaporation.amount > 0)
    baked.push(exit("baking-loss", load.evaporation, "baking-loss"));
  const inspectionKey = "inspect-bake";
  const demoulded: MaterialOutput[] = [];
  const grid: CarrierStep[] = [];
  {
    grid.push(
      {
        kind: "acquire",
        role: authoredId("carrier-role", "grid"),
        from: authoredId("storage", "empty-grids"),
      },
      move("grid", "empty-grids", "loaded-grids", t.demould),
    );
    demoulded.push(
      lot(
        "cooled-mass",
        "cooled-mass",
        load.bakedMass,
        carrier("grid"),
        "released",
        null,
      ),
      lot(
        "cooled-pieces",
        "cooled-pieces",
        load.pieces,
        carrier("grid"),
        "released",
        null,
      ),
    );
  }
  tasks.push(
    step(
      "load-oven",
      [previous],
      manual(t.transfer, "prep", "oven"),
      "oven",
      [],
      [],
      [move("mould", "filled-moulds", "oven-mould", t.transfer)],
      [],
    ),
    step(
      "bake",
      ["load-oven"],
      passive(t.bake),
      "oven",
      bakeInputs,
      baked,
      [],
      [],
    ),
    step(
      "examine-bake",
      ["bake"],
      manual(t.inspect, "oven", "oven"),
      "oven",
      [],
      [],
      [],
      [],
    ),
    step(
      inspectionKey,
      ["examine-bake"],
      { kind: "inspection" },
      null,
      [],
      [],
      [],
      ["baked-mass", "baked-pieces"],
    ),
    step(
      "unload-oven",
      [inspectionKey],
      manual(t.transfer, "oven", "cooling"),
      "oven",
      [],
      [],
      [move("mould", "oven-mould", "cooling-mould", t.transfer)],
      [],
    ),
    step(
      "cool-in-mould",
      ["unload-oven"],
      passive(t["cool-in-mould"]),
      null,
      [],
      [],
      [],
      [],
    ),
    step(
      "demould",
      ["cool-in-mould"],
      manual(t.demould, "cooling", "cooling"),
      null,
      [input("baked-mass", load.bakedMass), input("baked-pieces", load.pieces)],
      demoulded,
      grid,
      [],
    ),
    step(
      "clean-mould",
      ["demould"],
      manual(t.clean, "cooling", "sink"),
      "sink",
      [],
      [],
      [move("mould", "cooling-mould", "mould-sink", t.transfer)],
      [],
    ),
    step(
      "return-mould",
      ["clean-mould"],
      manual(t.transfer, "sink", "prep"),
      null,
      [],
      [],
      [
        move("mould", "mould-sink", home, t.transfer),
        { kind: "release", role: authoredId("carrier-role", "mould") },
      ],
      [],
    ),
  );
  {
    const checkedMass = mass(
      load.bakedMass.amount - load.inspection.sampleMass.amount,
    );
    const checkedPieces = pieces(
      load.pieces.amount - load.inspection.samplePieces.amount,
    );
    const checked = [
      lot(
        "checked-mass",
        "checked-mass",
        checkedMass,
        carrier("grid"),
        "held",
        null,
      ),
      lot(
        "checked-pieces",
        "checked-pieces",
        checkedPieces,
        carrier("grid"),
        "held",
        null,
      ),
    ];
    if (load.inspection.samplePieces.amount > 0) {
      checked.push(
        exit("sample-mass", load.inspection.sampleMass, "sample-mass"),
        exit("sample-pieces", load.inspection.samplePieces, "sample-pieces"),
      );
    }
    tasks.push(
      step(
        "crumb-wait",
        ["demould"],
        passive(t["crumb-wait"]),
        null,
        [],
        [],
        [],
        [],
      ),
      step(
        "crumb-check",
        ["crumb-wait"],
        manual(t["crumb-check"], "cooling", "cooling"),
        null,
        [
          input("cooled-mass", load.bakedMass),
          input("cooled-pieces", load.pieces),
        ],
        checked,
        [],
        [],
      ),
      step(
        "pack-ready",
        ["demould"],
        passive(t["pack-ready"]),
        null,
        [],
        [],
        [],
        [],
      ),
    );
    if (cell !== null) {
      tasks.push(
        step(
          "stage-cold-carrier",
          ["crumb-check", "pack-ready"],
          manual(t.transfer, "cooling", "cooling"),
          null,
          [],
          [],
          [move("grid", "loaded-grids", "cold-staging-table", t.transfer)],
          [],
        ),
        step(
          "transfer-cold-carrier",
          ["stage-cold-carrier"],
          {
            kind: "native",
            operation: {
              cell: cell.id,
              skill: authoredId("skill", "rack-transfer"),
              parameters: cell.modelHash,
            },
          },
          "cold-cell-arm",
          [],
          [],
          [
            {
              kind: "move",
              role: authoredId("carrier-role", "grid"),
              from: authoredId("storage", "cold-staging-table"),
              to: authoredId("storage", "cold-staging-rack"),
              timing: { kind: "native" },
            },
          ],
          [],
        ),
        step(
          "handoff-cold-carrier",
          ["transfer-cold-carrier"],
          manual(t.transfer, "cooling", "cooling"),
          null,
          [],
          [],
          [move("grid", "cold-staging-rack", "staged-grids", t.transfer)],
          [],
        ),
      );
    }
    tasks.push(
      step(
        "release-for-packing",
        cell === null ? ["crumb-check", "pack-ready"] : ["handoff-cold-carrier"],
        { kind: "inspection" },
        null,
        [],
        [],
        [],
        ["checked-mass", "checked-pieces"],
      ),
      step(
        "move-to-packing",
        ["release-for-packing"],
        manual(t.transfer, "cooling", "packing"),
        "packing",
        [],
        [],
        [
          move(
            "grid",
            cell === null ? "loaded-grids" : "staged-grids",
            "packing-grid",
            t.transfer,
          ),
        ],
        [],
      ),
      step(
        "finish-product",
        ["move-to-packing"],
        manual(t.pack, "packing", "packing"),
        "packing",
        [
          input("checked-mass", checkedMass),
          input("checked-pieces", checkedPieces),
        ],
        [
          inspectedExit("mass", checkedMass),
          inspectedExit("pieces", checkedPieces),
        ],
        [],
        [],
      ),
      step(
        "return-grid",
        ["finish-product"],
        manual(t.transfer, "packing", "cooling"),
        null,
        [],
        [],
        [
          move("grid", "packing-grid", "empty-grids", t.transfer),
          { kind: "release", role: authoredId("carrier-role", "grid") },
        ],
        [],
      ),
    );
  }
  return tasks;
}

function compile(
  preparation: CompiledScenario,
  recipe: Recipe,
  cell: ColdRackCell | null,
  revision: Sha256Hex,
): CompiledScenario {
  const products = [...preparation.products];
  const destinations = [...preparation.destinations];
  for (const [phase, role] of [
    ["filled", "intermediate-stock"],
    ["baked", null],
    ["cooled", null],
    ["checked", null],
    ["sample", "loss"],
    ["rejected", "rejected-output"],
    ["packed", "final-output"],
  ] as const) {
    for (const [dimension, unit] of [
      ["mass", "milligram"],
      ["pieces", "each"],
    ] as const) {
      const id = `${phase}-${dimension}`;
      const product = authoredId("product", id);
      products.push({ id: product, unit });
      if (role !== null)
        destinations.push({ id: authoredId("destination", id), product, role });
    }
  }
  products.push({
    id: authoredId("product", "baking-loss"),
    unit: "milligram",
  });
  destinations.push({
    id: authoredId("destination", "baking-loss"),
    product: authoredId("product", "baking-loss"),
    role: "loss",
  });
  const carriers = [...preparation.carriers];
  const storages = [...preparation.storages];
  for (const mould of recipe.moulds) {
    const id = authoredId("storage", `clean-${mould.id}`);
    carriers.push({ id: mould.id, storage: id });
    storages.push({ id, capacity: { kind: "carriers", slots: 1 }, cell: null });
  }
  for (const [id, slots] of [
    ["filled-moulds", recipe.moulds.length],
    ["oven-mould", 1],
    ["cooling-mould", 1],
    ["mould-sink", 1],
  ] as const)
    storages.push({
      id: authoredId("storage", id),
      capacity: { kind: "carriers", slots },
      cell: null,
    });
  for (let position = 1; position <= recipe.gridSlots; position++)
    carriers.push({
      id: authoredId("carrier", `grid-${position}`),
      storage: authoredId("storage", "empty-grids"),
    });
  for (const [id, slots] of [
    ["empty-grids", recipe.gridSlots],
    ["loaded-grids", recipe.gridSlots],
    ["packing-grid", 1],
  ] as const)
    storages.push({
      id: authoredId("storage", id),
      capacity: { kind: "carriers", slots },
      cell: null,
    });
  if (cell !== null) {
    for (const id of ["cold-staging-table", "cold-staging-rack"])
      storages.push({
        id: authoredId("storage", id),
        capacity: { kind: "carriers", slots: 1 },
        cell: cell.id,
      });
    storages.push({
      id: authoredId("storage", "staged-grids"),
      capacity: { kind: "carriers", slots: recipe.gridSlots },
      cell: null,
    });
  }
  const resources: CompiledScenario["resources"][number][] = [];
  for (const resource of preparation.resources) {
    if (resource.kind !== "worker") {
      resources.push(resource);
      continue;
    }
    const travel = [...resource.travel];
    for (const from of ["prep", "hob", "sink", "oven", "cooling", "packing"])
      for (const to of ["prep", "hob", "sink", "oven", "cooling", "packing"]) {
        if (
          from === to ||
          (["prep", "hob", "sink"].includes(from) &&
            ["prep", "hob", "sink"].includes(to))
        )
          continue;
        travel.push({
          from: authoredId("location", from),
          to: authoredId("location", to),
          duration: recipe.durations.transfer,
          evidence: "assumed",
        });
      }
    resources.push({
      id: resource.id,
      kind: "worker",
      capacity: 1,
      configuration: null,
      initialLocation: resource.initialLocation,
      travel,
    });
  }
  for (const id of cell === null
    ? ["oven", "packing"]
    : ["oven", "packing", "cold-cell-arm"])
    resources.push({
      id: authoredId("resource", id),
      kind: "capacity",
      capacity: 1,
      configuration: null,
    });
  const workflows = [...preparation.workflows];
  const arrivals = [...preparation.arrivals];
  const dependencies = [...preparation.dependencies];
  const preheat = authoredId("workflow", "financier-preheat");
  workflows.push({
    id: preheat,
    revision,
    demand: "production",
    tasks: [
      step(
        "preheat",
        [],
        passive(recipe.durations.preheat),
        "oven",
        [],
        [],
        [],
        [],
      ),
    ],
  });
  arrivals.push({
    id: authoredId("arrival-source", preheat),
    kind: "explicit",
    workflow: preheat,
    arrivals: [{ time: ZERO_TIME, quantity: 1 }],
  });
  for (const load of recipe.loads) {
    const prepSource = authoredId(
      "arrival-source",
      financierPreparationSource(load.flavour),
    );
    const prepEntry = preparation.arrivals.find(
      (entry) => entry.id === prepSource,
    );
    const loadArrivals =
      prepEntry !== undefined && prepEntry.kind === "explicit"
        ? prepEntry.arrivals
        : [{ time: ZERO_TIME, quantity: 1 }];
    workflows.push({
      id: load.id,
      revision,
      demand: "production",
      tasks: loadTasks(recipe, load, cell),
    });
    const source = authoredId("arrival-source", load.id);
    arrivals.push({
      id: source,
      kind: "explicit",
      workflow: load.id,
      arrivals: loadArrivals,
    });
    for (let sequence = 0; sequence < loadArrivals.length; sequence++) {
      dependencies.push({
        task: { source, sequence, key: taskKey("load-oven") },
        prerequisite: {
          source: authoredId("arrival-source", preheat),
          sequence: 0,
          key: taskKey("preheat"),
        },
      });
      // A mould is prepared once its own flavour's batter is stored, so a
      // later flavour never holds a shared mould while it waits for batter.
      dependencies.push({
        task: { source, sequence, key: taskKey("prepare-mould") },
        prerequisite: {
          source: prepSource,
          sequence,
          key: taskKey("store-batter"),
        },
      });
      if (sequence > 0) {
        dependencies.push(
          {
            task: { source, sequence, key: taskKey("demould") },
            prerequisite: {
              source,
              sequence: sequence - 1,
              key: taskKey("return-grid"),
            },
          },
        );
        for (const prevLoad of recipe.loads) {
          if (prevLoad.mould !== load.mould) continue;
          dependencies.push({
            task: { source, sequence, key: taskKey("prepare-mould") },
            prerequisite: {
              source: authoredId("arrival-source", prevLoad.id),
              sequence: sequence - 1,
              key: taskKey("return-mould"),
            },
          });
        }
      }
    }
  }
  return {
    schemaVersion: preparation.schemaVersion,
    id: authoredId("scenario", "financier-recipe"),
    policy: preparation.policy,
    sources: [
      ...preparation.sources,
      {
        id: authoredId("source", "assumed-financier-recipe"),
        revision: recipe.revision,
        digest: revision,
      },
    ],
    limits: preparation.limits,
    products,
    destinations,
    resources,
    storages,
    stock: preparation.stock,
    carriers,
    cells: cell === null ? preparation.cells : [...preparation.cells, cell],
    workflows,
    arrivals,
    dependencies,
    availability: preparation.availability,
  };
}

/**
 * Merges the flavours' preparations into one fragment. Each flavour keeps its
 * own workflow and batter; the scale, hob, sink, pan, bowl and the base
 * ingredient stock are shared. One batch at a time uses the pan and bowl, in
 * the order given, and the bowl is cleaned before the next flavour.
 */
function mergePreparations(
  fragments: readonly CompiledScenario[],
  flavours: readonly FinancierFlavour[],
): CompiledScenario {
  const first = fragments[0];
  if (first === undefined) throw new d.InvalidDocument("No preparation");
  let products: CompiledScenario["products"][number][] = [];
  let destinations: CompiledScenario["destinations"][number][] = [];
  let resources: CompiledScenario["resources"][number][] = [];
  let carriers: CompiledScenario["carriers"][number][] = [];
  const stock = new Map<string, CompiledScenario["stock"][number]>();
  const storages = new Map<string, CompiledScenario["storages"][number]>();
  const sources: CompiledScenario["sources"][number][] = [];
  const workflows: CompiledScenario["workflows"][number][] = [];
  const arrivals: CompiledScenario["arrivals"][number][] = [];
  let horizon = first.limits.horizon;
  for (const fragment of fragments) {
    products = sharedRecipeRecords(products, fragment.products);
    destinations = sharedRecipeRecords(destinations, fragment.destinations);
    resources = sharedRecipeRecords(resources, fragment.resources);
    carriers = sharedRecipeRecords(carriers, fragment.carriers);
    for (const entry of fragment.stock) {
      const previous = stock.get(entry.id);
      stock.set(
        entry.id,
        previous === undefined
          ? entry
          : {
              ...entry,
              quantity: d.value(addQuantity(previous.quantity, entry.quantity)),
            },
      );
    }
    for (const entry of fragment.storages) storages.set(entry.id, entry);
    sources.push(...fragment.sources);
    workflows.push(...fragment.workflows);
    arrivals.push(...fragment.arrivals);
    if (fragment.limits.horizon > horizon) horizon = fragment.limits.horizon;
  }
  for (const entry of stock.values())
    storages.set(entry.storage, {
      id: entry.storage,
      capacity: {
        kind: "material",
        product: entry.product,
        quantity: entry.quantity,
      },
      cell: null,
    });
  // Batches run wave by wave, flavour by flavour. Each starts after the
  // previous batch puts the cleaned pan and bowl away.
  const order: { source: ReturnType<typeof authoredId<"arrival-source">>; sequence: number }[] = [];
  let waves = 0;
  for (const arrival of arrivals)
    if (arrival.kind === "explicit")
      waves = Math.max(waves, arrival.arrivals.length);
  for (let sequence = 0; sequence < waves; sequence++)
    for (const flavour of flavours) {
      const source = authoredId(
        "arrival-source",
        financierPreparationSource(flavour),
      );
      const entry = arrivals.find((arrival) => arrival.id === source);
      if (
        entry !== undefined &&
        entry.kind === "explicit" &&
        sequence < entry.arrivals.length
      )
        order.push({ source, sequence });
    }
  const dependencies: CompiledScenario["dependencies"][number][] = [];
  for (let index = 1; index < order.length; index++) {
    const batch = order[index];
    const previous = order[index - 1];
    if (batch === undefined || previous === undefined) continue;
    dependencies.push({
      task: { ...batch, key: taskKey("weigh-butter") },
      prerequisite: { ...previous, key: taskKey("put-away") },
    });
  }
  return {
    ...first,
    sources,
    limits: { horizon, eventCap: first.limits.eventCap },
    products,
    destinations,
    resources,
    storages: [...storages.values()],
    stock: [...stock.values()],
    carriers,
    workflows,
    arrivals,
    dependencies,
  };
}

/** Compile assumed process inputs with run-bound operator inspection gates. */
export async function compileFinancierRecipe(
  raw: unknown,
  rawCell?: unknown,
): Promise<Result<CompiledScenario, FinancierRecipeProblem>> {
  try {
    const r = d.record(raw, [
      "revision",
      "evidence",
      "preparations",
      "moulds",
      "loads",
      "durationsSeconds",
      "gridSlots",
    ]);
    d.requireValue(Array.isArray(r.preparations));
    const rawPreparations: readonly unknown[] = r.preparations;
    d.requireValue(
      rawPreparations.length > 0 &&
        rawPreparations.length <= FINANCIER_FLAVOURS.length,
    );
    const fragments: CompiledScenario[] = [];
    const flavours: FinancierFlavour[] = [];
    for (const rawPreparation of rawPreparations) {
      d.requireValue(isRecord(rawPreparation));
      const flavour = d.choice(rawPreparation.flavour, ...FINANCIER_FLAVOURS);
      d.requireValue(!flavours.includes(flavour));
      flavours.push(flavour);
      const prepared = await compileFinancierPreparation(rawPreparation);
      if (!prepared.ok) return prepared;
      fragments.push(prepared.value);
    }
    const preparation = mergePreparations(fragments, flavours);
    const recipe = readRecipe(r);
    const cell = rawCell === undefined ? null : readColdCell(rawCell);
    for (const flavour of flavours) {
      let needed = 0;
      for (const load of recipe.loads) {
        if (
          load.filledMass.amount !==
          load.bakedMass.amount + load.evaporation.amount
        )
          return err({ code: "bake_mass_balance" });
        if (load.flavour === flavour) needed += load.filledMass.amount;
      }
      // Each batch of a flavour fills that flavour's loads once.
      let available = 0;
      for (const workflow of preparation.workflows)
        for (const task of workflow.tasks)
          for (const output of task.outputs)
            if (
              output.kind === "lot" &&
              output.report === financierBatterPrepared(flavour)
            )
              available += output.quantity.amount;
      if (!Number.isSafeInteger(needed) || needed > available)
        return err({ code: "insufficient_batter" });
    }
    for (const load of recipe.loads)
      if (!flavours.includes(load.flavour))
        return err({ code: "insufficient_batter" });
    const revision = d.digest(
      await sha256Hex(
        canonicalJson(
          cell === null
            ? { preparation: preparation.sources, recipe }
            : { preparation: preparation.sources, recipe, cell },
        ),
      ),
    );
    return ok(compile(preparation, recipe, cell, revision));
  } catch (error) {
    if (error instanceof d.InvalidDocument)
      return err({ code: "invalid_recipe" });
    throw error;
  }
}

export type FinancierRecipeWaveOptions = Readonly<{
  waves?: number;
  waveIntervalSeconds?: number;
  mouldCount?: number;
  /**
   * Flavours to make, in batch order. Each flavour is its own batter batch
   * sized for its loads. The default is the hazelnut financier.
   */
  flavours?: readonly FinancierFlavour[];
}>;

/**
 * Working formula with visibly assumed process values for operator rehearsal.
 * `loadCount` is the number of 8-cavity loads for each flavour.
 */
export function financierRecipeInput(
  loadCount: number,
  gridSlots: number,
  bakeSeconds: number,
  options: FinancierRecipeWaveOptions = {},
) {
  const waves = options.waves ?? 1;
  const waveIntervalSeconds = options.waveIntervalSeconds ?? 2_700;
  const mouldCount = options.mouldCount ?? 2;
  const flavours = options.flavours ?? ["hazelnut"];
  const moulds = [];
  for (let index = 0; index < mouldCount; index++) {
    moulds.push({
      id: `mould-${String.fromCharCode(97 + index)}`,
      cavities: 8,
    });
  }
  const arrivalsSeconds = [];
  for (let wave = 0; wave < waves; wave++) {
    arrivalsSeconds.push(wave * waveIntervalSeconds);
  }
  const loads = [];
  const preparations = [];
  let position = 0;
  for (const flavour of flavours) {
    const formula = financierBatchFormula(flavour, loadCount);
    preparations.push({
      revision: 1,
      evidence: "assumed",
      flavour,
      ingredientsMg: formula.ingredientsMg,
      brownedButterMg: formula.brownedButterMg,
      batterMg: formula.batterMg,
      evaporationMg: formula.evaporationMg,
      residueMg: formula.residueMg,
      spillMg: 0,
      measurementDifferenceMg: 0,
      holdingCapacityMg: formula.batterMg * waves,
      durationsSeconds: {
        weigh: 10,
        "brown-butter": 360,
        "return-pan": 10,
        mix: 120,
        "store-batter": 30,
        clean: 90,
        "put-away": 10,
      },
      travelSeconds: 5,
      arrivalsSeconds,
      horizonSeconds: Math.max(21_600, waves * 10_800),
    });
    for (let index = 0; index < loadCount; index++) {
      const cavities = [];
      for (let number = 1; number <= 8; number++)
        cavities.push({ number, massMg: 25_000 });
      loads.push({
        id: financierLoadId(flavour, index),
        flavour,
        mould: `mould-${String.fromCharCode(97 + (position % mouldCount))}`,
        cavities,
        bakedMassMg: 188_000,
        evaporationMg: 12_000,
        inspection: {
          sampleMassMg: position === 0 ? 23_500 : 0,
          samplePieces: position === 0 ? 1 : 0,
        },
      });
      position += 1;
    }
  }
  return {
    revision: 1,
    evidence: "assumed",
    preparations,
    moulds,
    loads,
    durationsSeconds: {
      preheat: 900,
      "prepare-mould": 20,
      "fill-cavity": 10,
      transfer: 10,
      bake: bakeSeconds,
      inspect: 30,
      "cool-in-mould": 150,
      demould: 30,
      clean: 90,
      "crumb-wait": 600,
      "crumb-check": 20,
      "pack-ready": 3600,
      pack: 60,
    },
    gridSlots,
  };
}
