import { textLimit } from "@purin-labs/contract-schema";
import type {
  CompiledScenario,
  Sha256Hex,
  TaskDefinition,
  TaskKey,
  WorkflowDefinition,
  WorkflowId,
} from "@purin-labs/production-simulation";
import { readScenario } from "@purin-labs/production-simulation/scenario-document";
import { Type } from "typebox";
import { Value } from "typebox/value";

/**
 * Plan 84: one typed workflow definition for every recipe. A document holds the
 * engine's own task graph with labels, and edges in place of each task's
 * prerequisites. It lowers to `CompiledScenario`, and `admitScenario` stays the
 * only validator of its domain rules.
 */
const WORKFLOW_DOCUMENT_SCHEMA = "bakery_workflow.v1";

/** A task without its key and prerequisites: the node and the edges own those. */
export type StepBody = Omit<TaskDefinition, "key" | "prerequisites">;

type WorkflowNode = Readonly<{
  kind: "step";
  id: TaskKey;
  label: string;
  body: StepBody;
}>;

/** `branch` names the outcome of the inspection at `from` that this edge needs. */
export type WorkflowEdge = Readonly<{
  from: TaskKey;
  to: TaskKey;
  branch: "accept" | "reject" | null;
}>;

type WorkflowGraph = Readonly<{
  id: WorkflowId;
  revision: Sha256Hex;
  demand: WorkflowDefinition["demand"];
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}>;

export type BakeryWorkflowDocument = Readonly<{
  schema: typeof WORKFLOW_DOCUMENT_SCHEMA;
  title: string;
  recipe: string;
  scenario: Pick<
    CompiledScenario,
    "schemaVersion" | "id" | "policy" | "sources"
  >;
  world: Pick<
    CompiledScenario,
    | "products"
    | "destinations"
    | "resources"
    | "storages"
    | "carriers"
    | "cells"
    | "stock"
  >;
  demand: Pick<
    CompiledScenario,
    "limits" | "arrivals" | "dependencies" | "availability"
  >;
  workflows: readonly WorkflowGraph[];
}>;

type Source = Readonly<{
  title: string;
  recipe: string;
  /** A person's label for `workflow/key` or a task key. Others read as words. */
  labels?: Readonly<Record<string, string>>;
}>;

/** Every recipe compiler reaches the canvas through this one importer. */
export function importScenario(
  scenario: CompiledScenario,
  source: Source,
): BakeryWorkflowDocument {
  return {
    schema: WORKFLOW_DOCUMENT_SCHEMA,
    title: source.title,
    recipe: source.recipe,
    scenario: {
      schemaVersion: scenario.schemaVersion,
      id: scenario.id,
      policy: scenario.policy,
      sources: scenario.sources,
    },
    world: {
      products: scenario.products,
      destinations: scenario.destinations,
      resources: scenario.resources,
      storages: scenario.storages,
      carriers: scenario.carriers,
      cells: scenario.cells,
      stock: scenario.stock,
    },
    demand: {
      limits: scenario.limits,
      arrivals: scenario.arrivals,
      dependencies: scenario.dependencies,
      availability: scenario.availability,
    },
    workflows: scenario.workflows.map(importWorkflow.bind(null, source)),
  };
}

function importWorkflow(
  source: Source,
  workflow: WorkflowDefinition,
): WorkflowGraph {
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  for (const task of workflow.tasks) {
    const { key, prerequisites, ...body } = task;
    nodes.push({
      kind: "step",
      id: key,
      label:
        source.labels?.[`${workflow.id}/${key}`] ??
        source.labels?.[key] ??
        labelFromKey(key),
      body,
    });
    for (const from of prerequisites)
      edges.push({ from, to: key, branch: edgeBranch(task, from) });
  }
  return {
    id: workflow.id,
    revision: workflow.revision,
    demand: workflow.demand,
    nodes,
    edges,
  };
}

function edgeBranch(
  task: TaskDefinition,
  from: TaskKey,
): WorkflowEdge["branch"] {
  const executor = task.executor;
  if (executor.kind === "after-inspection" && executor.inspection === from)
    return executor.outcome;
  if (executor.kind === "inspection" && executor.when?.inspection === from)
    return executor.when.outcome;
  return null;
}

function labelFromKey(key: string): string {
  const words = key.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The engine's input. A document from an unedited recipe lowers to the same digest. */
export function lowerWorkflowDocument(
  document: BakeryWorkflowDocument,
): CompiledScenario {
  return {
    ...document.scenario,
    ...document.world,
    ...document.demand,
    workflows: document.workflows.map(lowerWorkflow),
  };
}

function lowerWorkflow(graph: WorkflowGraph): WorkflowDefinition {
  const prerequisites = new Map<TaskKey, TaskKey[]>();
  for (const edge of graph.edges) {
    const list = prerequisites.get(edge.to) ?? [];
    list.push(edge.from);
    prerequisites.set(edge.to, list);
  }
  const tasks: TaskDefinition[] = [];
  for (const node of graph.nodes)
    tasks.push({
      ...node.body,
      key: node.id,
      prerequisites: prerequisites.get(node.id) ?? [],
    });
  return {
    id: graph.id,
    revision: graph.revision,
    demand: graph.demand,
    tasks,
  };
}

const NODE = Type.Object(
  {
    kind: Type.Literal("step"),
    id: Type.String(),
    label: textLimit(Type.String({ minLength: 1, maxLength: 200 })),
    body: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
const EDGE = Type.Object(
  {
    from: Type.String(),
    to: Type.String(),
    branch: Type.Union([
      Type.Literal("accept"),
      Type.Literal("reject"),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
const DOCUMENT = Type.Object(
  {
    schema: Type.Literal(WORKFLOW_DOCUMENT_SCHEMA),
    title: textLimit(Type.String({ minLength: 1, maxLength: 200 })),
    recipe: textLimit(Type.String({ minLength: 1, maxLength: 100 })),
    scenario: Type.Record(Type.String(), Type.Unknown()),
    world: Type.Record(Type.String(), Type.Unknown()),
    demand: Type.Record(Type.String(), Type.Unknown()),
    workflows: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          revision: Type.String(),
          demand: Type.String(),
          nodes: Type.Array(NODE),
          edges: Type.Array(EDGE),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type WorkflowDocumentProblem = Readonly<{
  code: "invalid_workflow_document";
  message: string;
}>;

/**
 * The persistence boundary. The schema checks the document's own shape, and the
 * engine's reader checks everything that lowers into the engine, so one wire
 * shape has one parser. The edges and labels return unchanged, and the reader
 * confirms each node's body.
 */
export function parseWorkflowDocument(
  raw: unknown,
):
  | Readonly<{ ok: true; value: BakeryWorkflowDocument; error?: never }>
  | Readonly<{ ok: false; error: WorkflowDocumentProblem; value?: never }> {
  if (!Value.Check(DOCUMENT, raw))
    return invalid("The workflow document has an invalid shape.");
  const labels: Record<string, string> = {};
  const branches = new Map<string, WorkflowEdge["branch"]>();
  const workflows = [];
  for (const workflow of raw.workflows) {
    const prerequisites = new Map<string, string[]>();
    for (const edge of workflow.edges) {
      const list = prerequisites.get(edge.to) ?? [];
      list.push(edge.from);
      prerequisites.set(edge.to, list);
      branches.set(`${workflow.id} ${edge.from} ${edge.to}`, edge.branch);
    }
    const tasks = [];
    for (const node of workflow.nodes) {
      labels[`${workflow.id}/${node.id}`] = node.label;
      tasks.push({
        ...node.body,
        key: node.id,
        prerequisites: prerequisites.get(node.id) ?? [],
      });
    }
    workflows.push({
      id: workflow.id,
      revision: workflow.revision,
      demand: workflow.demand,
      tasks,
    });
  }
  let scenario: CompiledScenario;
  try {
    scenario = readScenario({
      ...raw.scenario,
      ...raw.world,
      ...raw.demand,
      workflows,
    });
  } catch (error) {
    return invalid(
      error instanceof Error
        ? error.message
        : "The workflow document is invalid.",
    );
  }
  const document = importScenario(scenario, {
    title: raw.title,
    recipe: raw.recipe,
    labels,
  });
  for (const workflow of document.workflows)
    for (const edge of workflow.edges)
      if (
        edge.branch !== branches.get(`${workflow.id} ${edge.from} ${edge.to}`)
      )
        return invalid("A branch edge does not match its task's condition.");
  return { ok: true, value: document };
}

function invalid(message: string): Readonly<{
  ok: false;
  error: WorkflowDocumentProblem;
}> {
  return { ok: false, error: { code: "invalid_workflow_document", message } };
}
