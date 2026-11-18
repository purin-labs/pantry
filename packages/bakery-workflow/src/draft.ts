import {
  admitScenario,
  durationFromSeconds,
  type AdmissionProblem,
  type CompiledScenario,
  type Sha256Hex,
} from "@seams/production-simulation";
import { canonicalJson, sha256Hex } from "@seams/std";
import {
  DRAFT_BOUNDS,
  draftNodeId,
  type DraftEdge,
  type DraftNode,
  type DraftSnapshot,
} from "@seams/workflow-canvas-crdt/draft-shape";
import {
  lowerWorkflowDocument,
  parseWorkflowDocument,
  type BakeryWorkflowDocument,
  type StepBody,
} from "./index.ts";
import { BAND_GAP, layoutGraph, NODE_ROW, placeGraph } from "./layout.ts";
import type { Variant } from "@seams/type-utils";

/** A document's shared draft starts as this. */
export function draftSeed(document: BakeryWorkflowDocument): DraftSnapshot {
  const nodes: DraftNode[] = [];
  const edges: DraftEdge[] = [];
  for (const workflow of document.workflows) {
    workflow.nodes.forEach((node, order) => {
      nodes.push({
        workflow: workflow.id,
        key: node.id,
        label: node.label,
        order,
        body: node.body,
      });
    });
    workflow.edges.forEach((edge, order) => {
      edges.push({
        workflow: workflow.id,
        from: edge.from,
        to: edge.to,
        order,
        branch: edge.branch,
      });
    });
  }
  return { nodes, edges, positions: seedPositions(document, nodes, edges) };
}

/** Each workflow reads as its own block, so a filter to one of them stays compact. */
function seedPositions(
  document: BakeryWorkflowDocument,
  nodes: readonly DraftNode[],
  edges: readonly DraftEdge[],
): DraftSnapshot["positions"] {
  const positions: Record<string, { x: number; y: number }> = {};
  let top = 0;
  for (const workflow of document.workflows) {
    const ids: string[] = [];
    for (const node of nodes)
      if (node.workflow === workflow.id) ids.push(nodeId(node));
    const links: Readonly<{ from: string; to: string }>[] = [];
    for (const edge of edges)
      if (edge.workflow === workflow.id) links.push(edgeLink(edge));
    let bottom = top;
    for (const place of placeGraph(ids, links)) {
      positions[place.id] = {
        x: Math.min(place.x, DRAFT_BOUNDS.maxX),
        y: Math.min(top + place.y, DRAFT_BOUNDS.maxY),
      };
      bottom = Math.max(bottom, top + place.y + NODE_ROW);
    }
    top = bottom + BAND_GAP;
  }
  return positions;
}

function nodeId(node: DraftNode): string {
  return draftNodeId(node.workflow, node.key);
}

function edgeLink(edge: DraftEdge): Readonly<{ from: string; to: string }> {
  return {
    from: draftNodeId(edge.workflow, edge.from),
    to: draftNodeId(edge.workflow, edge.to),
  };
}

export type DraftProblem = Readonly<{
  /** The step to mark, when the engine names one that the draft holds. */
  node: string | null;
  message: string;
}>;

export type DraftCompilation =
  | Readonly<{
      kind: "ready";
      document: BakeryWorkflowDocument;
      scenario: CompiledScenario;
      digest: Sha256Hex;
    }>
  | Readonly<{ kind: "refused"; problems: readonly DraftProblem[] }>;

/** A draft may hold anything. This decides if it can run or become a revision. */
export async function compileDraft(
  base: BakeryWorkflowDocument,
  snapshot: DraftSnapshot,
): Promise<DraftCompilation> {
  // The engine's reader refuses these before admission can name the step.
  const unassigned: DraftProblem[] = [];
  for (const node of snapshot.nodes)
    if (stepWorkers(node.body)?.length === 0)
      unassigned.push({
        node: nodeId(node),
        message: `${node.key}: it needs at least one worker.`,
      });
  if (unassigned.length > 0) return { kind: "refused", problems: unassigned };
  const lowered = lowerDecisions(base, snapshot);
  if (lowered.problems.length > 0)
    return { kind: "refused", problems: lowered.problems };
  const workflows = [];
  for (const workflow of base.workflows) {
    const nodes = [];
    for (const node of lowered.snapshot.nodes)
      if (node.workflow === workflow.id)
        nodes.push({
          kind: "step",
          id: node.key,
          label: node.label,
          body: node.body,
        });
    const edges = [];
    for (const edge of lowered.snapshot.edges)
      if (edge.workflow === workflow.id)
        edges.push({ from: edge.from, to: edge.to, branch: edge.branch });
    workflows.push({
      id: workflow.id,
      demand: workflow.demand,
      revision: await graphRevision(workflow, nodes, edges),
      nodes,
      edges,
    });
  }
  const parsed = parseWorkflowDocument(
    JSON.parse(JSON.stringify({ ...base, workflows })),
  );
  if (!parsed.ok)
    return {
      kind: "refused",
      problems: [{ node: null, message: parsed.error.message }],
    };
  const scenario = lowerWorkflowDocument(parsed.value);
  const admitted = await admitScenario(scenario);
  if (!admitted.ok)
    return { kind: "refused", problems: admitted.error.map(draftProblem) };
  return {
    kind: "ready",
    document: parsed.value,
    scenario,
    digest: admitted.value.digest,
  };
}

/** An unedited workflow keeps its revision, so its digest stays the compiler's. */
async function graphRevision(
  workflow: BakeryWorkflowDocument["workflows"][number],
  nodes: readonly Readonly<Record<string, unknown>>[],
  edges: readonly Readonly<Record<string, unknown>>[],
): Promise<string> {
  const content = canonicalJson({ nodes, edges });
  return content ===
    canonicalJson({ nodes: workflow.nodes, edges: workflow.edges })
    ? workflow.revision
    : sha256Hex(content);
}

const TASK_LOCATION = /^workflow (\S+) task (\S+)/u;

function draftProblem(problem: AdmissionProblem): DraftProblem {
  if (problem.code === "cyclic_tasks") {
    const first = problem.tasks[0];
    return {
      node: first === undefined ? null : draftNodeId(problem.workflow, first),
      message: `These steps wait for each other: ${problem.tasks.join(", ")}.`,
    };
  }
  const location = TASK_LOCATION.exec(problem.where);
  const workflow = location?.[1];
  const key = location?.[2];
  return {
    node:
      workflow === undefined || key === undefined
        ? null
        : draftNodeId(workflow, key),
    message:
      key === undefined
        ? problemMessage(problem)
        : `${key}: ${problemMessage(problem)}`,
  };
}

function problemMessage(problem: AdmissionProblem): string {
  switch (problem.code) {
    case "invalid_lot":
      switch (problem.reason) {
        case "not_produced_before":
          return `it uses ${problem.lot}, and no earlier step makes it.`;
        case "over_consumed":
          return `it uses more ${problem.lot} than the recipe makes.`;
        case "not_held":
          return `it releases ${problem.lot}, and that lot is not held.`;
        case "released_twice":
          return `${problem.lot} is released twice.`;
        case "holder_rejects_product":
          return `${problem.lot} cannot stay in its holder.`;
      }
      break;
    case "invalid_dependency":
      return problem.reason === "cycle"
        ? "steps in different workflows wait for each other."
        : "a prerequisite across workflows names a step that is gone.";
    case "unknown_reference":
      return `it names ${problem.kind} ${problem.id}, which does not exist.`;
    case "empty_workflow":
      return `the workflow ${problem.workflow} has no steps.`;
    case "empty_worker_selection":
      return "it needs at least one worker.";
    case "invalid_inspection":
      return "its decision is not an earlier step, or it moves a tray or releases a lot.";
    case "invalid_carrier_route":
      return `the tray ${problem.role} has an invalid route (${problem.reason}).`;
    case "claim_exceeds_capacity":
      return `it needs more of ${problem.resource} than exists.`;
    default:
      break;
  }
  return `the engine refuses this step (${problem.code}).`;
}

export type WorkflowDiff = Readonly<{
  added: ReadonlySet<string>;
  changed: ReadonlySet<string>;
  removed: readonly Readonly<{ id: string; label: string }>[];
  /** Keys of the form `workflow/from>to`. */
  addedEdges: ReadonlySet<string>;
  removedEdges: readonly Readonly<{
    workflow: string;
    from: string;
    to: string;
  }>[];
}>;

/** What a person or an agent changed. No badge comes from anywhere else. */
export function workflowDiff(
  base: DraftSnapshot,
  current: DraftSnapshot,
): WorkflowDiff {
  const baseNodes = new Map<string, DraftNode>();
  for (const node of base.nodes) baseNodes.set(nodeId(node), node);
  const added = new Set<string>();
  const changed = new Set<string>();
  const present = new Set<string>();
  for (const node of current.nodes) {
    const id = nodeId(node);
    present.add(id);
    const before = baseNodes.get(id);
    if (before === undefined) added.add(id);
    else if (
      before.label !== node.label ||
      canonicalJson(before.body) !== canonicalJson(node.body)
    )
      changed.add(id);
  }
  const removed = [];
  for (const [id, node] of baseNodes)
    if (!present.has(id)) removed.push({ id, label: node.label });
  const baseEdges = new Set(base.edges.map(edgeKey));
  const currentEdges = new Set(current.edges.map(edgeKey));
  const addedEdges = new Set<string>();
  for (const key of currentEdges) if (!baseEdges.has(key)) addedEdges.add(key);
  const removedEdges = [];
  for (const edge of base.edges)
    if (!currentEdges.has(edgeKey(edge)))
      removedEdges.push({
        workflow: edge.workflow,
        from: edge.from,
        to: edge.to,
      });
  return { added, changed, removed, addedEdges, removedEdges };
}

export function edgeKey(edge: DraftEdge): string {
  return `${edge.workflow}/${edge.from}>${edge.to}`;
}

export type NewStep = Readonly<{
  workflow: string;
  kind: "work" | "wait" | "decision";
  label: string;
  seconds: number;
}>;

/** A task key that the workflow does not hold yet, from a person's label. */
function freshKey(
  snapshot: DraftSnapshot,
  workflow: string,
  label: string,
): string {
  const stem =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 60) || "step";
  const taken = new Set<string>();
  for (const node of snapshot.nodes)
    if (node.workflow === workflow) taken.add(node.key);
  if (!taken.has(stem)) return stem;
  for (let index = 2; ; index++) {
    const candidate = `${stem}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The first worker of the world does a new step, in that worker's place. */
export function newStepNode(
  document: BakeryWorkflowDocument,
  snapshot: DraftSnapshot,
  step: NewStep,
): DraftNode | null {
  const duration = durationFromSeconds(step.seconds);
  if (!duration.ok) return null;
  let order = 0;
  for (const node of snapshot.nodes)
    if (node.workflow === step.workflow)
      order = Math.max(order, node.order + 1);
  const common = {
    priority: 0,
    releaseAfter: 0,
    claims: [],
    inputs: [],
    outputs: [],
    releases: [],
    carriers: [],
  };
  let executor: Readonly<Record<string, unknown>>;
  if (step.kind === "decision") executor = { kind: "inspection" };
  else if (step.kind === "wait")
    executor = {
      kind: "declared",
      duration: duration.value,
      evidence: "assumed",
    };
  else {
    const worker = document.world.resources.find(isWorker);
    if (worker === undefined) return null;
    executor = {
      kind: "attended",
      duration: duration.value,
      evidence: "assumed",
      workers: [worker.id],
      start: worker.initialLocation,
      finish: worker.initialLocation,
    };
  }
  return {
    workflow: step.workflow,
    key: freshKey(snapshot, step.workflow, step.label),
    label: step.label,
    order,
    body: { ...common, executor },
  };
}

function isWorker(
  resource: CompiledScenario["resources"][number],
): resource is Variant<CompiledScenario["resources"][number], "worker"> {
  return resource.kind === "worker";
}

/** Seconds of a step that declares them. A native step's time is evidence. */
export function stepSeconds(body: DraftNode["body"]): number | null {
  const executor = executorRecord(body);
  const work =
    executor?.kind === "after-inspection"
      ? (executor.work as Readonly<Record<string, unknown>>)
      : executor;
  return work !== undefined &&
    work !== null &&
    (work.kind === "declared" || work.kind === "attended") &&
    typeof work.duration === "number"
    ? work.duration / 1_000_000
    : null;
}

export function withStepSeconds(
  body: DraftNode["body"],
  seconds: number,
): DraftNode["body"] | null {
  const duration = durationFromSeconds(seconds);
  const executor = executorRecord(body);
  if (!duration.ok || executor === null) return null;
  if (executor.kind === "after-inspection") {
    const work = executor.work as Readonly<Record<string, unknown>>;
    return {
      ...body,
      executor: { ...executor, work: { ...work, duration: duration.value } },
    };
  }
  return executor.kind === "declared" || executor.kind === "attended"
    ? { ...body, executor: { ...executor, duration: duration.value } }
    : null;
}

export function stepWorkers(body: DraftNode["body"]): readonly string[] | null {
  const executor = executorRecord(body);
  const work =
    executor?.kind === "after-inspection"
      ? (executor.work as Readonly<Record<string, unknown>>)
      : executor;
  return work?.kind === "attended" && Array.isArray(work.workers)
    ? (work.workers as readonly string[])
    : null;
}

export function withStepWorkers(
  body: DraftNode["body"],
  workers: readonly string[],
): DraftNode["body"] | null {
  const executor = executorRecord(body);
  if (executor === null) return null;
  if (executor.kind === "after-inspection") {
    const work = executor.work as Readonly<Record<string, unknown>>;
    return work.kind === "attended"
      ? { ...body, executor: { ...executor, work: { ...work, workers } } }
      : null;
  }
  return executor.kind === "attended"
    ? { ...body, executor: { ...executor, workers } }
    : null;
}

/** The order among waiting steps, and the earliest start in seconds. */
export function stepOrdering(
  body: DraftNode["body"],
): Readonly<{ priority: number; earliestSeconds: number }> {
  return {
    priority: typeof body.priority === "number" ? body.priority : 0,
    earliestSeconds:
      typeof body.releaseAfter === "number" ? body.releaseAfter / 1_000_000 : 0,
  };
}

export function withStepOrdering(
  body: DraftNode["body"],
  ordering: Readonly<{ priority: number; earliestSeconds: number }>,
): DraftNode["body"] | null {
  if (!Number.isInteger(ordering.priority) || ordering.earliestSeconds < 0)
    return null;
  return {
    ...body,
    priority: ordering.priority,
    releaseAfter: Math.round(ordering.earliestSeconds * 1_000_000),
  };
}

function attendedWork(
  body: DraftNode["body"],
): Readonly<Record<string, unknown>> | null {
  const executor = executorRecord(body);
  const work =
    executor?.kind === "after-inspection"
      ? (executor.work as Readonly<Record<string, unknown>>)
      : executor;
  return work?.kind === "attended" ? work : null;
}

/** Where a worker starts and finishes a manual step. */
export function stepPlaces(
  body: DraftNode["body"],
): Readonly<{ start: string; finish: string }> | null {
  const work = attendedWork(body);
  return typeof work?.start === "string" && typeof work.finish === "string"
    ? { start: work.start, finish: work.finish }
    : null;
}

export function withStepPlaces(
  body: DraftNode["body"],
  places: Readonly<{ start: string; finish: string }>,
): DraftNode["body"] | null {
  const executor = executorRecord(body);
  if (executor === null) return null;
  if (executor.kind === "after-inspection") {
    const work = executor.work as Readonly<Record<string, unknown>>;
    return work.kind === "attended"
      ? { ...body, executor: { ...executor, work: { ...work, ...places } } }
      : null;
  }
  return executor.kind === "attended"
    ? { ...body, executor: { ...executor, ...places } }
    : null;
}

/** Each place that a worker can be: a start, a finish or a route's end. */
export function knownPlaces(
  document: BakeryWorkflowDocument,
  snapshot: DraftSnapshot,
): readonly string[] {
  const places = new Set<string>();
  for (const resource of document.world.resources)
    if (isWorker(resource)) {
      places.add(String(resource.initialLocation));
      for (const route of resource.travel) {
        places.add(String(route.from));
        places.add(String(route.to));
      }
    }
  for (const node of snapshot.nodes) {
    const shown = stepPlaces(node.body);
    if (shown === null) continue;
    places.add(shown.start);
    places.add(shown.finish);
  }
  return [...places].sort();
}

/** The machine program of a batch step, and the programs that its machine declares. */
export function stepProgram(
  document: BakeryWorkflowDocument,
  body: DraftNode["body"],
): Readonly<{ program: string; programs: readonly string[] }> | null {
  const executor = executorRecord(body);
  if (executor?.kind !== "batch" || typeof executor.program !== "string")
    return null;
  const programs: string[] = [];
  for (const resource of document.world.resources)
    if (resource.kind === "batch" && String(resource.id) === executor.resource)
      for (const program of resource.programs)
        programs.push(String(program.id));
  return { program: executor.program, programs };
}

export function withStepProgram(
  body: DraftNode["body"],
  program: string,
): DraftNode["body"] | null {
  const executor = executorRecord(body);
  return executor?.kind === "batch"
    ? { ...body, executor: { ...executor, program } }
    : null;
}

type NativeChoice = Readonly<{
  cell: string;
  skill: string;
  parameters: string;
}>;

function nativeOperation(body: DraftNode["body"]): NativeChoice | null {
  const executor = executorRecord(body);
  return executor?.kind === "native"
    ? (executor.operation as NativeChoice)
    : null;
}

/** A skill needs its own parameters, so the choices are what this recipe's cell runs. */
export function stepSkill(
  snapshot: DraftSnapshot,
  body: DraftNode["body"],
): Readonly<{ skill: string; skills: readonly string[] }> | null {
  const operation = nativeOperation(body);
  if (operation === null) return null;
  const skills = new Set<string>();
  for (const node of snapshot.nodes) {
    const other = nativeOperation(node.body);
    if (other?.cell === operation.cell) skills.add(other.skill);
  }
  return { skill: operation.skill, skills: [...skills].sort() };
}

export function withStepSkill(
  snapshot: DraftSnapshot,
  body: DraftNode["body"],
  skill: string,
): DraftNode["body"] | null {
  const operation = nativeOperation(body);
  if (operation === null) return null;
  for (const node of snapshot.nodes) {
    const other = nativeOperation(node.body);
    if (other?.cell === operation.cell && other.skill === skill)
      return {
        ...body,
        executor: { ...executorRecord(body), operation: other },
      };
  }
  return null;
}

export function stepExecutorKind(body: DraftNode["body"]): string {
  const kind = executorRecord(body)?.kind;
  return typeof kind === "string" ? kind : "unknown";
}

function executorRecord(
  body: DraftNode["body"],
): Readonly<Record<string, unknown>> | null {
  const executor = body.executor;
  return typeof executor === "object" && executor !== null
    ? (executor as Readonly<Record<string, unknown>>)
    : null;
}

/** The outcome that an edge from an inspection to its conditional task needs. */
export function branchOfEdge(
  from: string,
  body: StepBody | DraftNode["body"],
): DraftEdge["branch"] {
  const executor = executorRecord(body as DraftNode["body"]);
  const guard =
    executor?.kind === "inspection"
      ? (executor.when as Readonly<Record<string, unknown>> | undefined)
      : executor;
  const decision =
    executor?.kind === "inspection" ? guard?.inspection : guard?.inspection;
  return (executor?.kind === "after-inspection" ||
    executor?.kind === "inspection") &&
    decision === from &&
    (guard?.outcome === "accept" || guard?.outcome === "reject")
    ? guard.outcome
    : null;
}

/** A step's body without the decision that the compile or an import gave it. */
export function withoutDecision(body: DraftNode["body"]): DraftNode["body"] {
  const executor = executorRecord(body);
  if (executor?.kind === "after-inspection")
    return { ...body, executor: executor.work };
  if (executor?.kind === "inspection" && executor.when !== undefined) {
    const { when: _when, ...rest } = executor;
    return { ...body, executor: rest };
  }
  return body;
}

export type DecisionRuleInput =
  | Readonly<{ kind: "person" }>
  | Readonly<{
      kind: "scripted";
      outcomes: readonly ("accept" | "reject")[];
    }>
  | Readonly<{
      kind: "measurement";
      lot: string;
      minimum: number;
      maximum: number;
    }>;

export function decisionRuleOf(body: DraftNode["body"]): DecisionRuleInput {
  const rule = executorRecord(body)?.rule as DecisionRuleInput | undefined;
  return rule ?? { kind: "person" };
}

export function withDecisionRule(
  body: DraftNode["body"],
  rule: DecisionRuleInput,
): DraftNode["body"] {
  const executor = executorRecord(body);
  if (executor?.kind !== "inspection") return body;
  const { rule: _old, ...rest } = executor;
  return {
    ...body,
    executor: rule.kind === "person" ? rest : { ...rest, rule },
  };
}

/** Lots that an earlier step measured, which a measurement rule can read. */
export function measuredLots(
  snapshot: DraftSnapshot,
  workflow: string,
): readonly string[] {
  const lots: string[] = [];
  for (const node of snapshot.nodes) {
    if (node.workflow !== workflow || !Array.isArray(node.body.outputs))
      continue;
    for (const output of node.body.outputs as readonly Readonly<
      Record<string, unknown>
    >[])
      if (output.kind === "measured-lot" && typeof output.lot === "string")
        lots.push(output.lot);
  }
  return lots;
}

type Guarded = Readonly<{
  inspection: string;
  outcome: "accept" | "reject";
}>;

function reachable(
  roots: readonly string[],
  edges: readonly DraftEdge[],
  blocked: ReadonlySet<DraftEdge>,
): ReadonlySet<string> {
  const seen = new Set(roots);
  const queue = [...roots];
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index];
    for (const edge of edges) {
      if (edge.from !== node || blocked.has(edge) || seen.has(edge.to))
        continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return seen;
}

/**
 * The arm rule. If every path to a step passes one branch arrow of a decision, the
 * step is inside that arm. A step that both arms reach is a join, and it runs. A
 * person draws arrows only. An imported or applied recipe keeps the conditions that
 * it has, so only a branch arrow that the draft added changes a step.
 */
function lowerDecisions(
  base: BakeryWorkflowDocument,
  snapshot: DraftSnapshot,
): Readonly<{ snapshot: DraftSnapshot; problems: readonly DraftProblem[] }> {
  const known = new Set<string>();
  for (const workflow of base.workflows)
    for (const edge of workflow.edges)
      if (edge.branch !== null)
        known.add(`${workflow.id}/${edge.from}>${edge.to}=${edge.branch}`);
  const problems: DraftProblem[] = [];
  const nodes = new Map<string, DraftNode>();
  for (const node of snapshot.nodes) nodes.set(nodeId(node), node);
  const edgesOut: DraftEdge[] = [];
  for (const workflow of base.workflows) {
    const edges = snapshot.edges.filter(edgeIn.bind(null, workflow.id));
    const fresh = edges.filter(
      (edge) =>
        edge.branch !== null &&
        !known.has(`${workflow.id}/${edge.from}>${edge.to}=${edge.branch}`),
    );
    if (fresh.length === 0) {
      edgesOut.push(...edges);
      continue;
    }
    const keys: string[] = [];
    for (const node of snapshot.nodes)
      if (node.workflow === workflow.id) keys.push(node.key);
    const targets = new Set(edges.map(edgeTarget));
    const roots = keys.filter((key) => !targets.has(key));
    const all = reachable(roots, edges, new Set());
    // A later decision is deeper, so its guard replaces an earlier one's.
    const order = ranksOf(keys, edges);
    const guards = new Map<string, Guarded>();
    const decisions = [...new Set(fresh.map(edgeSource))].sort(
      (left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0),
    );
    for (const decision of decisions)
      for (const outcome of ["accept", "reject"] as const) {
        const arm = new Set(
          fresh.filter(
            (edge) => edge.from === decision && edge.branch === outcome,
          ),
        );
        if (arm.size === 0) continue;
        const without = reachable(roots, edges, arm);
        for (const key of all)
          if (!without.has(key))
            guards.set(key, { inspection: decision, outcome });
      }
    for (const edge of edges) {
      const guard = guards.get(edge.to);
      const expected = guard?.inspection === edge.from ? guard.outcome : null;
      if (
        edge.branch !== null &&
        fresh.includes(edge) &&
        expected !== edge.branch
      )
        problems.push({
          node: draftNodeId(workflow.id, edge.to),
          message: `${edge.to}: a branch arrow reaches it, and so does a path outside that branch.`,
        });
      edgesOut.push(
        fresh.includes(edge) || guard?.inspection === edge.from
          ? { ...edge, branch: expected }
          : edge,
      );
    }
    for (const [key, guard] of guards) {
      const id = draftNodeId(workflow.id, key);
      const node = nodes.get(id);
      if (node === undefined) continue;
      const lowered = guardedBody(node, guard);
      if (lowered === null)
        problems.push({
          node: id,
          message: `${key}: a step inside a branch can only be work, a wait or a decision. It cannot move a tray, release a lot, or run a robot or machine.`,
        });
      else nodes.set(id, { ...node, body: lowered });
    }
  }
  return {
    snapshot: {
      ...snapshot,
      nodes: snapshot.nodes.map((node) => nodes.get(nodeId(node)) ?? node),
      edges: edgesOut,
    },
    problems,
  };
}

function edgeIn(workflow: string, edge: DraftEdge): boolean {
  return edge.workflow === workflow;
}

function edgeTarget(edge: DraftEdge): string {
  return edge.to;
}

function edgeSource(edge: DraftEdge): string {
  return edge.from;
}

function ranksOf(
  keys: readonly string[],
  edges: readonly DraftEdge[],
): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  for (const placed of layoutGraph(keys, edges))
    ranks.set(placed.id, placed.rank);
  return ranks;
}

function guardedBody(
  node: DraftNode,
  guard: Guarded,
): DraftNode["body"] | null {
  const plain = withoutDecision(node.body);
  const executor = executorRecord(plain);
  if (executor === null) return null;
  if (executor.kind === "inspection")
    return { ...plain, executor: { ...executor, when: guard } };
  const moves = Array.isArray(plain.carriers) && plain.carriers.length > 0;
  const releases = Array.isArray(plain.releases) && plain.releases.length > 0;
  if (
    (executor.kind !== "declared" && executor.kind !== "attended") ||
    moves ||
    releases
  )
    return null;
  return {
    ...plain,
    executor: { kind: "after-inspection", ...guard, work: executor },
  };
}
