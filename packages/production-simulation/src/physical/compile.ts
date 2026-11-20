import {
  canonicalJson,
  isPositiveInteger,
  sha256HexSync,
} from "@purin-labs/std";
import {
  admitScenario,
  type AdmissionProblem,
  type AdmittedScenario,
} from "../admission.ts";
import { advanceRun, startRun } from "../engine.ts";
import {
  authoredId,
  parseId,
  parseSha256Hex,
  taskId,
  workflowInstanceId,
  type CellId,
  type ResourceId,
  type RunId,
  type Sha256Hex,
  type StorageId,
  type TaskId,
  type TaskKey,
} from "../identity.ts";
import { err, ok, type Result } from "../result.ts";
import {
  DISPATCH_POLICY,
  MAX_EVENT_CAP,
  SCENARIO_SCHEMA_VERSION,
  type AvailabilityInterval,
  type CarrierStep,
  type CompiledScenario,
  type PhysicalCellDefinition,
  type ResourceDefinition,
  type StorageDefinition,
  type TaskDefinition,
  type TaskExecutor,
} from "../scenario.ts";
import {
  durationFromSeconds,
  interval,
  timeFromSeconds,
  ZERO_DURATION,
  ZERO_TIME,
  type LogicalTime,
  type TickDuration,
} from "../time.ts";
import {
  SOURCE_KEY_PATTERN,
  type CobotPlace,
  type CobotStation,
  type CobotTask,
} from "./protocol.ts";

/**
 * One approved bake run as the engine sees it. Two cobots move mould groups
 * from the cold rack into the oven and from the oven to the cooling rack;
 * the oven door is a reserved resource that every such move claims.
 *
 * The run compiles twice. The planning version gives each move as an
 * attended task that either cobot may take, and the engine's assignment and
 * times become the plan. The physical version pins each move to its
 * assigned cobot as a native operation in that cobot's cell, so that only
 * the cobot's receipts move a mould group or pass logical time.
 */

export type MouldGroupInput = Readonly<{
  mouldGroup: number;
  coldRackShelf: number;
  ovenShelf: number;
  coolingRackShelf: number;
}>;

export type BakeRunInput = Readonly<{
  runId: string;
  /** The digest of the approved recipe revision this run bakes. */
  recipeRevision: string;
  mouldGroups: readonly MouldGroupInput[];
  oven: Readonly<{ programSeconds: number; temperatureC: number }>;
  /** The source keys of the two cobots, in the order of the Devices page. */
  cobots: readonly [string, string];
  ovenSource: string;
  /** The nominal seconds of a load (cold rack to oven) and of an unload. */
  moveSeconds: Readonly<{ load: number; unload: number }>;
  /** Spans in which a cobot takes no new move, such as a revoke. */
  unavailable?: readonly Readonly<{
    sourceKey: string;
    fromSeconds: number;
    toSeconds: number;
  }>[];
}>;

export type BakeRunProblem = Readonly<{ field: string; reason: string }>;

export type BakeStepKind = "load" | "bake" | "unload";

/** One protocol task of the run and the engine task that executes it. */
export type BakeStep = Readonly<{
  key: string;
  kind: BakeStepKind;
  mouldGroup: number | null;
  sourceKey: string;
  task: CobotTask;
  /** The engine task in the physical scenario: a native operation. */
  engineTask: TaskId;
}>;

export type PlannedStep = Readonly<{
  key: string;
  kind: BakeStepKind;
  mouldGroup: number | null;
  /** The cobot the engine assigned, or the oven for the bake. */
  sourceKey: string;
  task: CobotTask;
  start: LogicalTime;
  end: LogicalTime;
}>;

export type BakePlan = Readonly<{
  /** The digest of the admitted planning scenario. */
  scenario: Sha256Hex;
  steps: readonly PlannedStep[];
  completedAt: LogicalTime;
}>;

export type CompiledBakeRun = Readonly<{
  input: BakeRunInput;
  runId: RunId;
  plan: BakePlan;
  definition: AdmittedScenario;
  steps: readonly BakeStep[];
  /** Each mould group's starting place, which the input declares. */
  initial: readonly Readonly<{ mouldGroup: number; place: CobotPlace }>[];
  /** The cell of each device and the device of each cell. */
  cells: readonly Readonly<{ cell: CellId; sourceKey: string }>[];
}>;

const TOOL_CELLS = ["cobot-a", "cobot-b"] as const;
const OVEN_CELL = authoredId("cell", "oven");
const DOOR = authoredId("resource", "oven-door");
const OVEN = authoredId("resource", "oven");
const CELL_LOCATION = authoredId("location", "bake-cell");
const INSTANCE_SOURCE = authoredId("arrival-source", "bake-run");
const WORKFLOW = authoredId("workflow", "bake-run");
const HORIZON_SECONDS = 12 * 3_600;
const MAX_SHELF = 12;
const MAX_OVEN_SHELF = 4;
const MAX_GROUP = 32;
const PROTOCOL = "plan-24-cobot/1";

const COBOT_HOLD = authoredId("hold-model", "cobot-idle.1");
const OVEN_HOLD = authoredId("hold-model", "oven-idle.1");

function digestOf(value: unknown): Sha256Hex {
  const parsed = parseSha256Hex(sha256HexSync(canonicalJson(value)));
  if (!parsed.ok) throw new Error("A SHA-256 digest has an invalid form");
  return parsed.value;
}

function seconds(value: number): TickDuration {
  const parsed = durationFromSeconds(value);
  if (!parsed.ok) throw new Error(`Invalid checked duration ${value}`);
  return parsed.value;
}

function at(value: number): LogicalTime {
  const parsed = timeFromSeconds(value);
  if (!parsed.ok) throw new Error(`Invalid checked time ${value}`);
  return parsed.value;
}

function storageOf(place: CobotPlace): StorageId {
  return authoredId("storage", `${place.station}-${place.shelf}`);
}

function role(group: number) {
  return authoredId("carrier-role", `mould-group-${group}`);
}

function onGrid(value: number): boolean {
  return value > 0 && durationFromSeconds(value).ok;
}

function shelves(
  problems: BakeRunProblem[],
  groups: readonly MouldGroupInput[],
  field: "coldRackShelf" | "ovenShelf" | "coolingRackShelf",
  limit: number,
): void {
  const seen = new Set<number>();
  for (const [index, group] of groups.entries()) {
    const shelf = group[field];
    const where = `mouldGroups[${index}].${field}`;
    if (!isPositiveInteger(shelf) || shelf > limit)
      problems.push({ field: where, reason: `a shelf from 1 to ${limit}` });
    else if (seen.has(shelf))
      problems.push({ field: where, reason: "another group uses this shelf" });
    seen.add(shelf);
  }
}

/** Every input value the engine needs, checked before it compiles anything. */
export function checkBakeRunInput(input: BakeRunInput): BakeRunProblem[] {
  const problems: BakeRunProblem[] = [];
  if (!parseId("run", input.runId).ok)
    problems.push({ field: "runId", reason: "an authored identifier" });
  if (!parseSha256Hex(input.recipeRevision).ok)
    problems.push({ field: "recipeRevision", reason: "a SHA-256 digest" });
  const groups = input.mouldGroups;
  if (groups.length === 0 || groups.length > MAX_OVEN_SHELF)
    problems.push({
      field: "mouldGroups",
      reason: `from 1 to ${MAX_OVEN_SHELF} groups, one for each oven shelf`,
    });
  const numbers = new Set<number>();
  for (const [index, group] of groups.entries()) {
    if (!isPositiveInteger(group.mouldGroup) || group.mouldGroup > MAX_GROUP)
      problems.push({
        field: `mouldGroups[${index}].mouldGroup`,
        reason: `a group from 1 to ${MAX_GROUP}`,
      });
    else if (numbers.has(group.mouldGroup))
      problems.push({
        field: `mouldGroups[${index}].mouldGroup`,
        reason: "a repeated group",
      });
    numbers.add(group.mouldGroup);
  }
  shelves(problems, groups, "coldRackShelf", MAX_SHELF);
  shelves(problems, groups, "ovenShelf", MAX_OVEN_SHELF);
  shelves(problems, groups, "coolingRackShelf", MAX_SHELF);
  const { programSeconds, temperatureC } = input.oven;
  if (!isPositiveInteger(programSeconds) || programSeconds > 7_200)
    problems.push({
      field: "oven.programSeconds",
      reason: "whole seconds from 1 to 7200",
    });
  if (
    !Number.isInteger(temperatureC) ||
    temperatureC < 50 ||
    temperatureC > 300
  )
    problems.push({
      field: "oven.temperatureC",
      reason: "whole degrees from 50 to 300",
    });
  const keys = [...input.cobots, input.ovenSource];
  for (const [index, key] of keys.entries())
    if (key.length > 120 || !SOURCE_KEY_PATTERN.test(key))
      problems.push({
        field: index < 2 ? `cobots[${index}]` : "ovenSource",
        reason: "a device source key",
      });
  if (new Set(keys).size !== keys.length)
    problems.push({ field: "cobots", reason: "three different devices" });
  for (const kind of ["load", "unload"] as const)
    if (!onGrid(input.moveSeconds[kind]))
      problems.push({
        field: `moveSeconds.${kind}`,
        reason: "positive seconds on the 2 ms engine tick",
      });
  for (const [index, span] of (input.unavailable ?? []).entries())
    if (
      !input.cobots.includes(span.sourceKey) ||
      !timeFromSeconds(span.fromSeconds).ok ||
      !timeFromSeconds(span.toSeconds).ok ||
      span.toSeconds <= span.fromSeconds
    )
      problems.push({
        field: `unavailable[${index}]`,
        reason: "a cobot and a span on the engine tick",
      });
  return problems;
}

type Move = Readonly<{
  key: string;
  kind: "load" | "unload";
  group: MouldGroupInput;
  from: CobotPlace;
  to: CobotPlace;
}>;

function moves(input: BakeRunInput): readonly Move[] {
  const loads: Move[] = [];
  const unloads: Move[] = [];
  for (const group of input.mouldGroups) {
    const cold: CobotPlace = {
      station: "cold_rack",
      shelf: group.coldRackShelf,
    };
    const oven: CobotPlace = { station: "oven", shelf: group.ovenShelf };
    const cool: CobotPlace = {
      station: "cooling_rack",
      shelf: group.coolingRackShelf,
    };
    loads.push({
      key: `load-${group.mouldGroup}`,
      kind: "load",
      group,
      from: cold,
      to: oven,
    });
    unloads.push({
      key: `unload-${group.mouldGroup}`,
      kind: "unload",
      group,
      from: oven,
      to: cool,
    });
  }
  return [...loads, ...unloads];
}

function moveTask(move: Move): CobotTask {
  return {
    kind: "move_mould_group",
    mouldGroup: move.group.mouldGroup,
    from: move.from,
    to: move.to,
  };
}

function bakeTask(input: BakeRunInput): CobotTask {
  return {
    kind: "bake",
    programSeconds: input.oven.programSeconds,
    temperatureC: input.oven.temperatureC,
  };
}

function key(literal: string): TaskKey {
  return authoredId("task-key", literal);
}

function stationStorages(input: BakeRunInput): StorageDefinition[] {
  const storages: StorageDefinition[] = [];
  const places: [CobotStation, keyof MouldGroupInput][] = [
    ["cold_rack", "coldRackShelf"],
    ["oven", "ovenShelf"],
    ["cooling_rack", "coolingRackShelf"],
  ];
  for (const [station, field] of places)
    for (const group of input.mouldGroups)
      storages.push({
        id: storageOf({ station, shelf: group[field] }),
        capacity: { kind: "carriers", slots: 1 },
        cell: null,
      });
  return storages;
}

function workerId(index: number): ResourceId {
  return authoredId("resource", TOOL_CELLS[index] ?? "cobot");
}

/**
 * Both cobots can make every move (D6). The engine takes the first free
 * cobot in each list, so the list order is the policy: a load prefers the
 * first cobot and an unload the second. Every move claims the oven door, so
 * moves never overlap and the other cobot takes a move only when the
 * preferred one is withheld.
 */
function preference(kind: Move["kind"]): readonly [ResourceId, ResourceId] {
  return kind === "load"
    ? [workerId(0), workerId(1)]
    : [workerId(1), workerId(0)];
}

function moveCarriers(
  move: Move,
  from: StorageId,
  to: StorageId,
): CarrierStep[] {
  const steps: CarrierStep[] = [];
  if (move.kind === "load" && from === storageOf(move.from))
    steps.push({ kind: "acquire", role: role(move.group.mouldGroup), from });
  steps.push({
    kind: "move",
    role: role(move.group.mouldGroup),
    from,
    to,
    timing: {
      kind: "declared",
      pickupAfter: ZERO_DURATION,
      placementAfter: ZERO_DURATION,
    },
  });
  if (move.kind === "unload" && to === storageOf(move.to))
    steps.push({ kind: "release", role: role(move.group.mouldGroup) });
  return steps;
}

function task(
  literal: string,
  priority: number,
  prerequisites: readonly string[],
  executor: TaskExecutor,
  claims: TaskDefinition["claims"],
  carriers: readonly CarrierStep[],
): TaskDefinition {
  return {
    key: key(literal),
    priority,
    releaseAfter: ZERO_DURATION,
    prerequisites: prerequisites.map(key),
    claims,
    executor,
    inputs: [],
    outputs: [],
    releases: [],
    carriers,
  };
}

function prerequisitesOf(move: Move): string[] {
  return move.kind === "unload" ? ["bake"] : [];
}

function bakePrerequisites(
  input: BakeRunInput,
  suffix: "" | "-place",
): string[] {
  return input.mouldGroups.map((group) => `load-${group.mouldGroup}${suffix}`);
}

function scenarioOf(
  input: BakeRunInput,
  variant: "planning" | "physical",
  resources: readonly ResourceDefinition[],
  storages: readonly StorageDefinition[],
  cells: readonly PhysicalCellDefinition[],
  tasks: readonly TaskDefinition[],
): CompiledScenario {
  const availability: AvailabilityInterval[] = [];
  if (variant === "planning")
    for (const [index, span] of (input.unavailable ?? []).entries()) {
      const window = interval(at(span.fromSeconds), at(span.toSeconds));
      if (!window.ok) throw new Error("A checked span is empty");
      availability.push({
        id: authoredId("availability", `unavailable-${index}`),
        resource: workerId(input.cobots.indexOf(span.sourceKey)),
        interval: window.value,
      });
    }
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: authoredId("scenario", `plan-24-bake-run-${variant}`),
    policy: DISPATCH_POLICY,
    sources: [
      {
        id: authoredId("source", "recipe-revision"),
        revision: 1,
        digest: digestOf({ recipe: input.recipeRevision }),
      },
    ],
    limits: { horizon: at(HORIZON_SECONDS), eventCap: MAX_EVENT_CAP },
    products: [],
    destinations: [],
    resources: [
      { kind: "capacity", id: DOOR, capacity: 1, configuration: null },
      { kind: "capacity", id: OVEN, capacity: 1, configuration: null },
      ...resources,
    ],
    storages: [...stationStorages(input), ...storages],
    carriers: input.mouldGroups.map((group) => ({
      id: authoredId("carrier", `mould-group-${group.mouldGroup}`),
      storage: storageOf({ station: "cold_rack", shelf: group.coldRackShelf }),
    })),
    cells,
    stock: [],
    workflows: [
      { id: WORKFLOW, revision: digestOf(input), demand: "order", tasks },
    ],
    arrivals: [
      {
        id: INSTANCE_SOURCE,
        workflow: WORKFLOW,
        kind: "explicit",
        arrivals: [{ time: ZERO_TIME, quantity: 1 }],
      },
    ],
    dependencies: [],
    availability,
  };
}

const DOOR_CLAIM = [{ resource: DOOR, units: 1, configuration: null }];
const OVEN_CLAIM = [{ resource: OVEN, units: 1, configuration: null }];

function planningScenario(input: BakeRunInput): CompiledScenario {
  const tasks: TaskDefinition[] = [];
  for (const [priority, move] of moves(input).entries())
    tasks.push(
      task(
        move.key,
        priority,
        prerequisitesOf(move),
        {
          kind: "attended",
          duration: seconds(input.moveSeconds[move.kind]),
          evidence: "assumed",
          workers: preference(move.kind),
          start: CELL_LOCATION,
          finish: CELL_LOCATION,
        },
        DOOR_CLAIM,
        moveCarriers(move, storageOf(move.from), storageOf(move.to)),
      ),
    );
  tasks.push(
    task(
      "bake",
      input.mouldGroups.length,
      bakePrerequisites(input, ""),
      {
        kind: "declared",
        duration: seconds(input.oven.programSeconds),
        evidence: "assumed",
      },
      OVEN_CLAIM,
      [],
    ),
  );
  const workers: ResourceDefinition[] = TOOL_CELLS.map((_, index) => ({
    kind: "worker",
    id: workerId(index),
    capacity: 1,
    configuration: null,
    initialLocation: CELL_LOCATION,
    travel: [],
  }));
  return scenarioOf(input, "planning", workers, [], [], tasks);
}

function deviceCell(
  id: CellId,
  sourceKey: string,
  capability: string,
  carrierSlots: 0 | 1,
): PhysicalCellDefinition {
  return {
    id,
    modelHash: digestOf({ protocol: PROTOCOL, sourceKey, capability }),
    controllerSourceHash: digestOf({ protocol: PROTOCOL, capability }),
    timestepMicroseconds: 2000,
    carrierSlots,
    holdModel: carrierSlots === 0 ? OVEN_HOLD : COBOT_HOLD,
  };
}

function cellStorage(cell: CellId, end: "source" | "destination"): StorageId {
  return authoredId("storage", `${cell}-${end}`);
}

/**
 * The physical version. A cobot cell holds one mould group at a time. A move
 * is three engine tasks: the group enters the assigned cobot's cell at its
 * source, the cobot moves it as a native operation that only receipts can
 * advance, and the group leaves the cell at its destination. Entry and exit
 * take no time and need no device evidence; they are the cell's custody.
 */
function physicalScenario(
  input: BakeRunInput,
  assigned: ReadonlyMap<string, number>,
): CompiledScenario {
  const cellIds = TOOL_CELLS.map((cell) => authoredId("cell", cell));
  const tasks: TaskDefinition[] = [];
  for (const [index, move] of moves(input).entries()) {
    const cobot = assigned.get(move.key);
    const cell = cobot === undefined ? undefined : cellIds[cobot];
    if (cell === undefined) throw new Error(`Move ${move.key} has no cobot`);
    const priority = index * 3;
    const source = cellStorage(cell, "source");
    const destination = cellStorage(cell, "destination");
    tasks.push(
      task(
        `${move.key}-stage`,
        priority,
        prerequisitesOf(move),
        { kind: "declared", duration: ZERO_DURATION, evidence: "model" },
        [],
        moveCarriers(move, storageOf(move.from), source),
      ),
      task(
        move.key,
        priority + 1,
        [`${move.key}-stage`],
        {
          kind: "native",
          operation: {
            cell,
            skill: authoredId("skill", "move-mould-group"),
            parameters: digestOf(moveTask(move)),
          },
        },
        DOOR_CLAIM,
        [
          {
            kind: "move",
            role: role(move.group.mouldGroup),
            from: source,
            to: destination,
            timing: { kind: "native" },
          },
        ],
      ),
      task(
        `${move.key}-place`,
        priority + 2,
        [move.key],
        { kind: "declared", duration: ZERO_DURATION, evidence: "model" },
        [],
        moveCarriers(move, destination, storageOf(move.to)),
      ),
    );
  }
  tasks.push(
    task(
      "bake",
      input.mouldGroups.length * 3,
      bakePrerequisites(input, "-place"),
      {
        kind: "native",
        operation: {
          cell: OVEN_CELL,
          skill: authoredId("skill", "bake"),
          parameters: digestOf(bakeTask(input)),
        },
      },
      OVEN_CLAIM,
      [],
    ),
  );
  const storages: StorageDefinition[] = [];
  for (const cell of cellIds)
    for (const end of ["source", "destination"] as const)
      storages.push({
        id: cellStorage(cell, end),
        capacity: { kind: "carriers", slots: 1 },
        cell,
      });
  const cells = [
    ...cellIds.map((cell, index) =>
      deviceCell(cell, input.cobots[index] ?? "", "move_mould_group", 1),
    ),
    deviceCell(OVEN_CELL, input.ovenSource, "bake", 0),
  ];
  return scenarioOf(input, "physical", [], storages, cells, tasks);
}

function problemsOf(
  problems: readonly AdmissionProblem[],
): readonly BakeRunProblem[] {
  return problems.map((problem) => ({
    field: problem.where,
    reason: canonicalJson(problem),
  }));
}

function plannedTimes(
  run: ReturnType<typeof advanceRun>,
): ReadonlyMap<
  string,
  Readonly<{ start: LogicalTime; end: LogicalTime; worker: ResourceId | null }>
> {
  const times = new Map<
    string,
    { start: LogicalTime; end: LogicalTime; worker: ResourceId | null }
  >();
  for (const event of run.events) {
    if (
      event.kind !== "task-started" &&
      event.kind !== "task-completed" &&
      event.kind !== "worker-assigned"
    )
      continue;
    const literal = event.task.slice(event.task.lastIndexOf("/") + 1);
    const entry = times.get(literal) ?? {
      start: event.time,
      end: event.time,
      worker: null,
    };
    if (event.kind === "task-started") entry.start = event.time;
    if (event.kind === "task-completed") entry.end = event.time;
    if (event.kind === "worker-assigned") entry.worker = event.worker;
    times.set(literal, entry);
  }
  return times;
}

/**
 * Runs the engine once on the planning version and returns which cobot it
 * assigned to each move and the planned start and end of every task (D6).
 */
export async function planBakeRun(
  input: BakeRunInput,
): Promise<Result<BakePlan, readonly BakeRunProblem[]>> {
  const problems = checkBakeRunInput(input);
  if (problems.length > 0) return err(problems);
  const admitted = await admitScenario(planningScenario(input));
  if (!admitted.ok) return err(problemsOf(admitted.error));
  const runId = parseId("run", input.runId);
  if (!runId.ok) return err([{ field: "runId", reason: "invalid" }]);
  const started = startRun(
    admitted.value,
    {
      runId: runId.value,
      executionId: authoredId("execution", "plan"),
      hostSession: authoredId("host-session", "plan"),
      bundle: null,
      parent: null,
    },
    [],
  );
  if (!started.ok)
    return err([{ field: "scenario", reason: canonicalJson(started.error) }]);
  const run = advanceRun(started.value, admitted.value.scenario.limits.horizon);
  if (run.status.kind !== "completed")
    return err([
      { field: "plan", reason: `the planning run ${run.status.kind}` },
    ]);
  const times = plannedTimes(run);
  const steps: PlannedStep[] = [];
  const all: (Move | null)[] = [...moves(input)];
  all.splice(input.mouldGroups.length, 0, null);
  for (const move of all) {
    const literal = move === null ? "bake" : move.key;
    const time = times.get(literal);
    if (time === undefined)
      return err([{ field: literal, reason: "the plan never ran it" }]);
    const worker =
      time.worker === null
        ? -1
        : TOOL_CELLS.indexOf(time.worker as (typeof TOOL_CELLS)[number]);
    steps.push({
      key: literal,
      kind: move === null ? "bake" : move.kind,
      mouldGroup: move === null ? null : move.group.mouldGroup,
      sourceKey:
        move === null ? input.ovenSource : (input.cobots[worker] ?? ""),
      task: move === null ? bakeTask(input) : moveTask(move),
      start: time.start,
      end: time.end,
    });
  }
  return ok({
    scenario: admitted.value.digest,
    steps,
    completedAt: run.status.completedAt,
  });
}

/**
 * Plans the run, then compiles its physical version with each move pinned
 * to the cobot the plan assigned. Each engine task maps to one protocol task.
 */
export async function compileBakeRun(
  input: BakeRunInput,
): Promise<Result<CompiledBakeRun, readonly BakeRunProblem[]>> {
  const plan = await planBakeRun(input);
  if (!plan.ok) return plan;
  const assigned = new Map<string, number>();
  for (const step of plan.value.steps)
    if (step.kind !== "bake")
      assigned.set(step.key, input.cobots.indexOf(step.sourceKey));
  const admitted = await admitScenario(physicalScenario(input, assigned));
  if (!admitted.ok) return err(problemsOf(admitted.error));
  const runId = parseId("run", input.runId);
  if (!runId.ok) return err([{ field: "runId", reason: "invalid" }]);
  const instance = workflowInstanceId(INSTANCE_SOURCE, 0);
  const steps: BakeStep[] = plan.value.steps.map((step) => ({
    key: step.key,
    kind: step.kind,
    mouldGroup: step.mouldGroup,
    sourceKey: step.sourceKey,
    task: step.task,
    engineTask: taskId(instance, key(step.key)),
  }));
  return ok({
    input,
    runId: runId.value,
    plan: plan.value,
    definition: admitted.value,
    steps,
    initial: input.mouldGroups.map((group) => ({
      mouldGroup: group.mouldGroup,
      place: { station: "cold_rack", shelf: group.coldRackShelf },
    })),
    cells: [
      ...TOOL_CELLS.map((cell, index) => ({
        cell: authoredId("cell", cell),
        sourceKey: input.cobots[index] ?? "",
      })),
      { cell: OVEN_CELL, sourceKey: input.ovenSource },
    ],
  });
}
