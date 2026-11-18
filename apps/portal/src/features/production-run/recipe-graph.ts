import {
  importScenario,
  type BakeryWorkflowDocument,
  type WorkflowEdge,
} from "@seams/bakery-workflow";
import { stepExecutorKind } from "@seams/bakery-workflow/draft";
import { placeGraph } from "@seams/bakery-workflow/layout";
import type { CompiledScenario } from "@seams/production-simulation";
import type { PersistentCell } from "@seams/bakery-model/bakery-physics";
import {
  draftNodeId,
  type DraftNode,
  type DraftSnapshot,
} from "@seams/workflow-canvas-crdt/draft";
import { err, ok, type Result } from "@seams/production-simulation";
import { blackSesameRecipeInput } from "@seams/production-simulation/recipes/bakery/black-sesame";
import { financierRecipeInput } from "@seams/production-simulation/recipes/bakery/financier";
import { gingerBlackTeaRecipeInput } from "@seams/production-simulation/recipes/bakery/ginger-black-tea";
import { gingerMilkTeaRecipeInput } from "@seams/production-simulation/recipes/bakery/ginger-milk-tea";
import { compileLatte } from "@seams/production-simulation/recipes/bakery/latte";
import {
  compilePieRecipe,
  PIE_PRODUCTS,
  pieRecipeInput,
  type PieType,
} from "@seams/production-simulation/recipes/bakery/pie";
import { compileSiphon } from "@seams/production-simulation/recipes/bakery/siphon";
import { assertNever } from "@seams/std";
import type { StrictUnion } from "@seams/type-utils";
import { prepareNativeRecipe } from "./oven-recipe-file";

/** Which recipe a recipe simulation shows. */
export type RecipeGraphSource = StrictUnion<
  | Readonly<{ kind: "latte"; milkG: number }>
  | Readonly<{
      kind: "siphon";
      waterG: number;
      coffeeG: number;
      steepSeconds: number;
    }>
  | Readonly<{ kind: "black-sesame" }>
  | Readonly<{ kind: "ginger-tea"; mode: "black-tea" | "two-pan-milk-tea" }>
  | Readonly<{ kind: "financier"; part: "batter" | "bake" | "pack" }>
  | Readonly<{ kind: "savoury-pies"; pie: PieType }>
  | Readonly<{
      kind: "cafe-shift";
      appliance: "linea" | "eagle-one";
      financierLoads: number;
      espressoOrders: number;
    }>
  | Readonly<{
      /** A recipe that runs in the engine workspace. It has no fixed animation. */
      kind: "compiled";
      title: string;
      scenario: CompiledScenario;
      cells: readonly PersistentCell[];
    }>
>;

export type RecipeGraphNode = Readonly<{
  id: string;
  workflow: string;
  key: string;
  label: string;
  /** The animation stages of this step. One long step can span several. */
  stages: readonly string[];
  role:
    "work" | "process" | "machine" | "robot" | "check" | "accept" | "reject";
  x: number;
  y: number;
}>;
export type RecipeGraphEdge = Readonly<{
  from: string;
  to: string;
  branch: WorkflowEdge["branch"];
  /** A prerequisite across workflows belongs to the demand, not the draft. */
  crossing: boolean;
}>;
export type RecipeGraph = Readonly<{
  nodes: readonly RecipeGraphNode[];
  edges: readonly RecipeGraphEdge[];
}>;
export type RecipeSource = Readonly<{
  document: BakeryWorkflowDocument;
  /** Null when no fixed animation binds the steps, so every step shows. */
  binding: StageBinding | null;
  /** The prepared cells that a run of this recipe needs. */
  cells: readonly PersistentCell[];
}>;

/** Stage IDs of a simulation, with the recipe's task keys that each one shows. */
export type StageBinding = Readonly<Record<string, readonly string[]>>;

const FILL_MOULD = [
  "prepare-mould",
  "fill-cavity-1",
  "fill-cavity-2",
  "fill-cavity-3",
  "fill-cavity-4",
  "fill-cavity-5",
  "fill-cavity-6",
  "fill-cavity-7",
  "fill-cavity-8",
];
const WEIGH_AND_BROWN = [
  "weigh-butter",
  "weigh-egg-whites",
  "weigh-almond-flour",
  "weigh-wheat-flour",
  "weigh-sugar",
  "weigh-roasted-hazelnut-flour",
  "weigh-chopped-roasted-hazelnut",
  "brown-butter",
  "return-pan",
];

const LATTE: StageBinding = {
  espresso: ["place-cup", "espresso-shot", "transfer-cup"],
  stretch: ["grasp-pitcher", "steam-stretch"],
  whirlpool: ["steam-whirlpool"],
  pour: ["pour-latte"],
  serve: ["return-pitcher"],
};
const SIPHON: StageBinding = {
  "preheat-seal": ["preheat-seal"],
  upflow: ["upflow"],
  "fold-in": ["fold-in"],
  steep: ["steep"],
  whirlpool: ["whirlpool"],
  drawdown: ["drawdown"],
};
const BLACK_SESAME: StageBinding = {
  "grind-sesame": [
    "weigh-sesame",
    "weigh-sugar",
    "weigh-rice-flour",
    "weigh-water",
    "weigh-salt",
    "grind-1",
    "grind-2",
    "grind-3",
    "grind-4",
  ],
  "cook-slurry": ["cook-slurry-continuous-stir", "dissolve-sugar-and-salt"],
  "blend-standardize": ["blend", "scrape-and-weigh", "standardize-mass"],
  "cold-carrier-transfer": [
    "cool-in-bath",
    "assumed-cooling-release",
    "stage-cold-carrier",
    "transfer-cold-carrier",
    "handoff-cold-carrier",
    "wash-and-fill-bottle-a",
    "wash-and-fill-bottle-b",
    "clean-batch-vessels",
    "return-batch-vessels",
  ],
  "heated-mixer-service": [
    "dose",
    "prepare-cup",
    "heat-and-mix",
    "pour-and-serve",
    "wash-jug",
    "return-jug",
  ],
};
const GINGER_BLACK_TEA: StageBinding = {
  "stage-clean-pans": [
    "stage-clean-equipment",
    "stage-pan",
    "handoff-staged-pan",
  ],
  "weigh-and-simmer-ginger": [
    "prepare-ginger-and-water",
    "place-pan-on-hob",
    "heat-to-simmer",
    "simmer-ginger",
  ],
  "extract-tea": [
    "turn-off-heat",
    "add-tea-and-cover",
    "steep",
    "move-pan-off-hob",
  ],
  "strain-and-inspect": ["strain-and-sweeten", "inspect-strained-tea"],
  "finish-and-serve": [
    "serve-or-discard",
    "clear-used-equipment",
    "wash-equipment",
    "return-clean-equipment",
  ],
};
const GINGER_MILK_TEA: StageBinding = {
  "stage-clean-pans": [
    "wash-initial-pan",
    "return-initial-pan",
    "stage-both-pans",
    "stage-pan-b",
    "handoff-staged-pan-b",
  ],
  "weigh-and-simmer-ginger": [
    "prepare-ginger-and-water",
    "place-pan-a-on-hob",
    "heat-to-simmer",
    "simmer-ginger",
  ],
  "extract-tea": ["add-tea", "simmer-tea"],
  "strain-and-inspect": [
    "strain-into-pan-b",
    "clear-dirty-pan-a",
    "wash-pan-a",
    "place-clean-pan-a-on-hob",
    "return-clean-pan-a",
    "place-pan-b-on-hob",
    "inspect-strained-tea",
    "discard-extract",
  ],
  "finish-and-serve": [
    "fill-cup-preheat-water",
    "heat-cup-preheat-water",
    "warm-cups-and-drain-water",
    "add-milk-and-sugar-at-55c",
    "heat-and-stir-to-68c",
    "heat-and-stir-to-78c",
    "serve-milk-tea",
    "clear-pan-b-and-strainer",
    "wash-pan-b-and-strainer",
    "return-clean-pan-b-and-strainer",
  ],
};
/** One recipe `mix` task covers three stages of the batter animation. */
const FINANCIER_BATTER: StageBinding = {
  "brown-butter": WEIGH_AND_BROWN,
  "charge-dry-whites": ["mix"],
  "mix-paste": ["mix"],
  "temper-butter": ["mix"],
  homogenize: ["store-batter", "clean", "put-away"],
};
const FINANCIER_BAKE: StageBinding = {
  "deposit-moulds": FILL_MOULD,
  "load-oven": ["preheat", "load-oven"],
  "convection-bake": ["bake"],
  "unload-cool": [
    "examine-bake",
    "inspect-bake",
    "unload-oven",
    "cool-in-mould",
  ],
};
const FINANCIER_PACK: StageBinding = {
  "cool-demould": ["demould", "clean-mould", "return-mould"],
  "crumb-check": ["crumb-wait", "crumb-check", "pack-ready"],
  "pack-giftbox": [
    "stage-cold-carrier",
    "transfer-cold-carrier",
    "handoff-cold-carrier",
    "release-for-packing",
    "move-to-packing",
  ],
  "seal-release": ["finish-product", "return-grid"],
};
const CAFE_SHIFT: StageBinding = {
  "batter-and-order-1": [
    ...WEIGH_AND_BROWN,
    "mix",
    "store-batter",
    "clean",
    "put-away",
    "prepare-espresso",
  ],
  "deposit-and-order-2": [...FILL_MOULD, "preheat", "prepare-espresso"],
  "bake-and-bar-service": ["load-oven", "bake"],
  "bake-review-and-demould": [
    "examine-bake",
    "inspect-bake",
    "unload-oven",
    "cool-in-mould",
    "demould",
    "clean-mould",
    "return-mould",
  ],
  "crumb-check-and-pack": [
    "crumb-wait",
    "crumb-check",
    "pack-ready",
    "release-for-packing",
    "move-to-packing",
    "finish-product",
    "return-grid",
  ],
};

const FINANCIER_PARTS = {
  batter: FINANCIER_BATTER,
  bake: FINANCIER_BAKE,
  pack: FINANCIER_PACK,
} as const;

const SAVOURY_PIES_BENCH: StageBinding = {
  "flour-bench": ["prepare-pie-tray-a"],
  "sheet-shortcrust": ["line-tins-a"],
  "fill-shells": ["fill-pies-a"],
  "drape-puff-lid": ["lid-pies-a"],
};

function bindingOf(source: RecipeGraphSource): StageBinding | null {
  switch (source.kind) {
    case "latte":
      return LATTE;
    case "siphon":
      return SIPHON;
    case "black-sesame":
      return BLACK_SESAME;
    case "ginger-tea":
      return source.mode === "black-tea" ? GINGER_BLACK_TEA : GINGER_MILK_TEA;
    case "financier":
      return FINANCIER_PARTS[source.part];
    case "savoury-pies":
      return SAVOURY_PIES_BENCH;
    case "cafe-shift":
      return CAFE_SHIFT;
    case "compiled":
      return null;
    default:
      return assertNever(source);
  }
}

async function readDocument(source: RecipeGraphSource): Promise<
  Result<
    Readonly<{
      document: BakeryWorkflowDocument;
      cells: readonly PersistentCell[];
    }>,
    string
  >
> {
  switch (source.kind) {
    case "compiled":
      return ok({
        document: importScenario(source.scenario, {
          title: source.title,
          recipe: source.scenario.id,
        }),
        cells: source.cells,
      });
    case "latte":
      return ok({
        document: importScenario(
          await compileLatte({ revision: 1, milkG: source.milkG }),
          { title: "Latte", recipe: "latte" },
        ),
        cells: [],
      });
    case "siphon":
      return ok({
        document: importScenario(
          await compileSiphon({
            revision: 1,
            waterG: source.waterG,
            coffeeG: source.coffeeG,
            steepSeconds: source.steepSeconds,
          }),
          { title: "Siphon coffee", recipe: "siphon" },
        ),
        cells: [],
      });
    case "black-sesame":
      return nativeDocument("Black sesame milk", {
        kind: "black-sesame",
        input: blackSesameRecipeInput(),
      });
    case "ginger-tea":
      return source.mode === "black-tea"
        ? nativeDocument("Ginger black tea", {
            kind: "ginger-black-tea",
            input: gingerBlackTeaRecipeInput(),
          })
        : nativeDocument("Ginger milk tea", {
            kind: "ginger-milk-tea",
            input: gingerMilkTeaRecipeInput(),
          });
    case "financier":
      return nativeDocument("Hazelnut financier", {
        kind: "financier",
        input: financierRecipeInput(1, 2, 900),
      });
    case "savoury-pies": {
      const compiled = await compilePieRecipe(
        pieRecipeInput({
          pies: [source.pie],
          piesPerType: 3,
          stage: "assembly",
        }),
      );
      if (!compiled.ok)
        return err(`Cannot compile pie recipe: ${compiled.error.code}.`);
      return ok({
        document: importScenario(compiled.value, {
          title: PIE_PRODUCTS[source.pie].title,
          recipe: "pies",
        }),
        cells: [],
      });
    }
    case "cafe-shift":
      return nativeDocument("Café shift", {
        kind: "cafe-shift",
        input: {
          espresso: {
            revision: 1,
            orders: source.espressoOrders,
            appliance: source.appliance,
          },
          financierLoads: source.financierLoads,
        },
      });
    default:
      return assertNever(source);
  }
}

async function nativeDocument(
  title: string,
  recipe: Parameters<typeof prepareNativeRecipe>[0],
): Promise<
  Result<
    Readonly<{
      document: BakeryWorkflowDocument;
      cells: readonly PersistentCell[];
    }>,
    string
  >
> {
  const prepared = await prepareNativeRecipe(recipe);
  return prepared.ok
    ? ok({
        document: importScenario(prepared.value.scenario, {
          title,
          recipe: recipe.kind,
        }),
        cells: [prepared.value.cell],
      })
    : prepared;
}

/** A recipe and its stage binding. A bound key that the recipe lacks refuses it. */
export async function loadRecipeSource(
  source: RecipeGraphSource,
): Promise<Result<RecipeSource, string>> {
  try {
    const read = await readDocument(source);
    if (!read.ok) return read;
    const binding = bindingOf(source);
    const present = new Set<string>();
    for (const workflow of read.value.document.workflows)
      for (const node of workflow.nodes) present.add(node.id);
    for (const keys of Object.values(binding ?? {}))
      for (const key of keys)
        if (!present.has(key))
          return err(`The recipe has no step named ${key}.`);
    return ok({ ...read.value, binding });
  } catch (error) {
    return err(
      error instanceof Error ? error.message : "The recipe is invalid.",
    );
  }
}

function roleOf(
  kind: string,
  body: DraftNode["body"],
): RecipeGraphNode["role"] {
  switch (kind) {
    case "attended":
      return "work";
    case "batch":
      return "machine";
    case "native":
      return "robot";
    case "inspection":
      return "check";
    case "after-inspection": {
      const executor = body.executor as Readonly<{ outcome?: unknown }>;
      return executor.outcome === "reject" ? "reject" : "accept";
    }
    default:
      return "process";
  }
}

/**
 * What a view shows of a draft. A financier view shows one part of its recipe, so
 * a step shows when its view binds it, or when a person added it to the recipe.
 */
export function recipeGraph(
  source: RecipeSource,
  snapshot: DraftSnapshot,
  /** One workflow of a large recipe, or null for all of them. */
  workflow: string | null = null,
): RecipeGraph {
  const stagesOfKey = new Map<string, string[]>();
  for (const [stage, keys] of Object.entries(source.binding ?? {}))
    for (const key of keys) {
      const stages = stagesOfKey.get(key) ?? [];
      stages.push(stage);
      stagesOfKey.set(key, stages);
    }
  const original = new Set<string>();
  for (const workflow of source.document.workflows)
    for (const node of workflow.nodes)
      original.add(draftNodeId(workflow.id, node.id));
  const branches = new Map<string, "accept" | "reject">();
  for (const edge of snapshot.edges)
    if (edge.branch !== null)
      branches.set(draftNodeId(edge.workflow, edge.to), edge.branch);
  const raw: RecipeGraphNode[] = [];
  const ids = new Set<string>();
  for (const node of snapshot.nodes) {
    const id = draftNodeId(node.workflow, node.key);
    const stages = stagesOfKey.get(node.key);
    if (workflow !== null && node.workflow !== workflow) continue;
    if (stages === undefined && original.has(id) && source.binding !== null)
      continue;
    const position = snapshot.positions[id];
    ids.add(id);
    raw.push({
      id,
      workflow: node.workflow,
      key: node.key,
      label: node.label,
      stages: stages ?? [],
      role:
        stepExecutorKind(node.body) === "inspection"
          ? "check"
          : (branches.get(id) ??
            roleOf(stepExecutorKind(node.body), node.body)),
      x: position?.x ?? 0,
      y: position?.y ?? 0,
    });
  }
  const edges: RecipeGraphEdge[] = [];
  for (const edge of snapshot.edges) {
    const from = draftNodeId(edge.workflow, edge.from);
    const to = draftNodeId(edge.workflow, edge.to);
    if (ids.has(from) && ids.has(to))
      edges.push({ from, to, branch: edge.branch, crossing: false });
  }
  const workflowOfArrival = new Map<string, string>();
  for (const arrival of source.document.demand.arrivals)
    workflowOfArrival.set(arrival.id, arrival.workflow);
  const crossing = new Set<string>();
  for (const dependency of source.document.demand.dependencies) {
    const from = `${workflowOfArrival.get(dependency.prerequisite.source)}/${dependency.prerequisite.key}`;
    const to = `${workflowOfArrival.get(dependency.task.source)}/${dependency.task.key}`;
    const key = `${from} ${to}`;
    if (crossing.has(key) || !ids.has(from) || !ids.has(to)) continue;
    crossing.add(key);
    edges.push({ from, to, branch: null, crossing: true });
  }
  // A view shows from its own first step, wherever the recipe's layout placed it.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const node of raw) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
  }
  const nodes: RecipeGraphNode[] = [];
  for (const node of raw)
    nodes.push({ ...node, x: node.x - minX, y: node.y - minY });
  return { nodes, edges };
}

export type RecipeOverviewNode = Readonly<{
  id: string;
  label: string;
  steps: number;
  changed: number;
  x: number;
  y: number;
}>;

type RecipeOverview = Readonly<{
  nodes: readonly RecipeOverviewNode[];
  edges: readonly Readonly<{ from: string; to: string }>[];
}>;

/** A large recipe at a glance: one node for each workflow, and what links them. */
export function recipeOverview(
  document: RecipeSource["document"],
  snapshot: DraftSnapshot,
  changed: ReadonlySet<string>,
): RecipeOverview {
  const workflowOfArrival = new Map<string, string>();
  for (const arrival of document.demand.arrivals)
    workflowOfArrival.set(arrival.id, arrival.workflow);
  const seen = new Set<string>();
  const edges: { from: string; to: string }[] = [];
  for (const dependency of document.demand.dependencies) {
    const from = workflowOfArrival.get(dependency.prerequisite.source);
    const to = workflowOfArrival.get(dependency.task.source);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from} ${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to });
  }
  const ids = document.workflows.map(workflowIdOf);
  const places = new Map<string, Readonly<{ x: number; y: number }>>();
  for (const place of placeGraph(ids, edges)) places.set(place.id, place);
  const nodes: RecipeOverviewNode[] = [];
  for (const id of ids) {
    let steps = 0;
    let touched = 0;
    for (const node of snapshot.nodes)
      if (node.workflow === id) {
        steps++;
        if (changed.has(draftNodeId(id, node.key))) touched++;
      }
    const place = places.get(id);
    nodes.push({
      id,
      label: id.replaceAll("-", " "),
      steps,
      changed: touched,
      x: place?.x ?? 0,
      y: place?.y ?? 0,
    });
  }
  return { nodes, edges };
}

function workflowIdOf(workflow: Readonly<{ id: string }>): string {
  return workflow.id;
}
