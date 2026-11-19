import type {
  Blocker,
  CarrierStep,
  CompiledScenario,
  LogisticsView,
  TaskDefinition,
  TaskView,
  WorkflowDefinition,
} from "@purin-labs/production-simulation";
import { assertNever } from "@purin-labs/std";
import {
  carrierNoun,
  clock,
  instanceLabel,
  placeLabel,
  taskLabel,
} from "./factory-places";
import type { Variant } from "@purin-labs/type-utils";

type Logistics = Variant<LogisticsView, "available">;

/**
 * One link of a wait. The first link names what the task lacks, the middle
 * links name who holds it, and the last link is the constraint that holds
 * everything above it.
 */
export type WaitLink = Readonly<{
  role: "missing" | "holder" | "constraint";
  text: string;
  task: string | null;
  /** The store or resource this link finds full or busy. */
  place: string | null;
}>;

/** A carrier role of one admitted instance and the store it is in now. */
type Custody = Readonly<{
  instance: string;
  role: string;
  store: string | null;
  /** The first unfinished task that moves this carrier on. */
  next: string | null;
}>;

const MAX_LINKS = 8;

/**
 * Follows a waiting task to the constraint that holds it. Custody comes from
 * the scenario's carrier steps and the accepted task states; the engine's
 * store occupancy confirms each store it names.
 */
export function explainWait(
  scenario: CompiledScenario,
  view: Logistics,
  task: string,
): readonly WaitLink[] {
  const explanation = new Explanation(scenario, view);
  explanation.follow(task, "missing");
  return explanation.links;
}

/** Who holds each carrier in a store, as "Batch 2 · tray 1". */
export function storeHolders(
  scenario: CompiledScenario,
  view: Logistics,
  store: string,
): readonly string[] {
  const holders: string[] = [];
  for (const entry of new Explanation(scenario, view).custodies())
    if (entry.store === store) holders.push(holderLabel(entry));
  return holders;
}

function holderLabel(entry: Custody): string {
  return `${instanceLabel(entry.instance)} · ${entry.role.replace(/^tray-(\d+)\..*$/u, "tray $1")}`;
}

const PRIMARY: readonly Blocker["kind"][] = [
  "destination",
  "carrier",
  "resource",
  "batch-cycle",
  "configuration",
  "workers",
  "material",
  "cell-slot",
  "cell-state",
  "release",
  "inspection",
  "prerequisite",
];

class Explanation {
  readonly links: WaitLink[] = [];
  private readonly visited = new Set<string>();
  private readonly tasks = new Map<string, TaskView>();
  private readonly workflows = new Map<string, WorkflowDefinition>();
  private custody: readonly Custody[] | null = null;
  constructor(
    private readonly scenario: CompiledScenario,
    private readonly view: Logistics,
  ) {
    for (const task of view.tasks) this.tasks.set(task.id, task);
    for (const workflow of scenario.workflows)
      this.workflows.set(workflow.id, workflow);
  }

  follow(id: string, role: WaitLink["role"]): void {
    if (this.links.length >= MAX_LINKS || this.visited.has(id)) return;
    this.visited.add(id);
    const task = this.tasks.get(id);
    if (task === undefined) return;
    if (task.kind === "executing") {
      const end = this.endOf(task);
      this.add(
        "constraint",
        end === null
          ? `${taskLabel(id)} is running.`
          : `${taskLabel(id)} runs until ${clock(end)}.`,
        id,
      );
      return;
    }
    if (task.kind !== "waiting") return;
    for (const kind of PRIMARY)
      for (const blocker of task.blockers)
        if (blocker.kind === kind) return this.blocked(id, blocker, role);
  }

  private add(
    role: WaitLink["role"],
    text: string,
    task: string | null,
    place: string | null = null,
  ) {
    this.links.push({ role, text, task, place });
  }

  private blocked(id: string, blocker: Blocker, role: WaitLink["role"]) {
    const subject = taskLabel(id);
    switch (blocker.kind) {
      case "prerequisite":
        // Order inside a recipe is not a constraint; follow the earlier step.
        return this.follow(blocker.task, role);
      case "destination":
        return this.fullStore(id, blocker.storage, role);
      case "carrier":
        return this.noCarrier(id, blocker.store, role);
      case "resource":
      case "batch-cycle":
      case "configuration":
        return this.busy(id, [blocker.resource], role);
      case "workers":
        return this.busy(id, blocker.workers, role);
      case "material": {
        this.add(
          role,
          `${subject} needs ${quantity(blocker.missing.amount, blocker.missing.unit)} more ${placeLabel(blocker.product)}.`,
          id,
        );
        const producer = this.nextProducer(blocker.product);
        if (producer !== null) this.follow(producer, "holder");
        return;
      }
      case "release":
        return this.add(
          "constraint",
          `${subject} is released at ${clock(blocker.at)}.`,
          id,
        );
      case "inspection":
        return this.add(
          "constraint",
          `${subject} waits for the operator review of ${taskLabel(blocker.task)}.`,
          id,
        );
      case "cell-slot":
      case "cell-state":
        return this.add(
          "constraint",
          `${subject} waits for cell ${blocker.cell}.`,
          id,
        );
      default:
        return assertNever(blocker);
    }
  }

  private fullStore(id: string, storage: string, role: WaitLink["role"]) {
    const store = this.store(storage);
    if (store === null) {
      // A material store, such as the batter container: follow its consumer.
      this.add(
        role,
        `${taskLabel(id)} waits: ${placeLabel(storage)} is full.`,
        id,
        storage,
      );
      const consumer = this.nextConsumer(storage);
      if (consumer !== null) this.follow(consumer, "holder");
      return;
    }
    this.add(
      role,
      `${taskLabel(id)} waits: ${placeLabel(storage)} is full, ${store.occupants.length + store.reservations.length} of ${store.capacity} ${carrierNoun(storage, store.capacity)} used.`,
      id,
      storage,
    );
    const inside: Custody[] = [];
    for (const entry of this.custodies())
      if (entry.store === storage) inside.push(entry);
    this.holders(inside, `${placeLabel(storage)} holds`, false);
  }

  private noCarrier(id: string, storage: string, role: WaitLink["role"]) {
    const out: Custody[] = [];
    for (const entry of this.custodies())
      if (this.acquiredFrom(entry) === storage) out.push(entry);
    const capacity = this.store(storage)?.capacity ?? out.length;
    const noun = carrierNoun(storage, 1);
    this.add(
      role,
      `${taskLabel(id)} waits for ${noun === "grid" ? "an empty cooling grid" : `a free ${noun} (${placeLabel(storage)})`}: ${out.length} of ${capacity} ${carrierNoun(storage, capacity)} are in use.`,
      id,
      storage,
    );
    this.holders(out, "In use by", true);
  }

  private holders(custody: readonly Custody[], lead: string, located: boolean) {
    if (custody.length === 0) return;
    const names: string[] = [];
    for (const entry of custody)
      names.push(
        `${holderLabel(entry)}${located && entry.store !== null ? ` at ${placeLabel(entry.store)}` : ""}`,
      );
    this.add("holder", `${lead} ${names.join("; ")}.`, null);
    // Follow the carrier that has gone furthest: the oldest instance.
    let first: Custody | undefined;
    for (const entry of custody)
      if (entry.next !== null && (first === undefined || older(entry, first)))
        first = entry;
    if (first?.next != null) this.follow(first.next, "holder");
  }

  private busy(
    id: string,
    resources: readonly string[],
    role: WaitLink["role"],
  ) {
    const users: string[] = [];
    for (const view of this.view.resources)
      if (resources.includes(view.id))
        for (const allocation of view.allocations) users.push(allocation.task);
    const names =
      resources.length === 1 ? placeLabel(resources[0] ?? "") : "a baker";
    this.add(
      role,
      users.length === 0
        ? `${taskLabel(id)} waits for ${names}.`
        : `${taskLabel(id)} waits for ${names}: in use by ${users.map(taskLabel).join("; ")}.`,
      id,
      resources.length === 1 ? (resources[0] ?? null) : "bakers",
    );
    if (users[0] !== undefined) this.follow(users[0], "holder");
  }

  private endOf(task: Variant<TaskView, "executing">): number | null {
    if (task.completesAt !== null && task.completesAt > 0)
      return task.completesAt;
    const definition = this.definition(task);
    if (definition === null) return null;
    const executor =
      definition.executor.kind === "after-inspection"
        ? definition.executor.work
        : definition.executor;
    return executor.kind === "declared" || executor.kind === "attended"
      ? task.startedAt + executor.duration
      : null;
  }

  private definition(task: TaskView): TaskDefinition | null {
    if (task.subject.kind !== "workflow") return null;
    const workflow = this.workflowOf(task.subject.instance);
    for (const definition of workflow?.tasks ?? [])
      if (definition.key === task.subject.key) return definition;
    return null;
  }

  private workflowOf(instance: string): WorkflowDefinition | null {
    const source = instance.slice(0, instance.lastIndexOf("#"));
    for (const arrival of this.scenario.arrivals)
      if (arrival.id === source)
        return this.workflows.get(arrival.workflow) ?? null;
    return null;
  }

  private instances(): string[] {
    const instances: string[] = [];
    for (const task of this.view.tasks)
      if (
        task.subject.kind === "workflow" &&
        !instances.includes(task.subject.instance)
      )
        instances.push(task.subject.instance);
    return instances;
  }

  /** Where each bound carrier is, from the completed carrier steps. */
  custodies(): readonly Custody[] {
    if (this.custody !== null) return this.custody;
    const custody: Custody[] = [];
    for (const instance of this.instances()) {
      const workflow = this.workflowOf(instance);
      if (workflow === null) continue;
      const stores = new Map<string, string | null>();
      const moving = new Set<string>();
      for (const definition of workflow.tasks) {
        const state = this.tasks.get(`${instance}/${definition.key}`);
        if (state?.kind === "executing")
          for (const step of definition.carriers) moving.add(step.role);
        if (state?.kind !== "completed") continue;
        for (const step of definition.carriers) apply(stores, step);
      }
      for (const [role, store] of stores) {
        if (store === null || moving.has(role)) continue;
        custody.push({
          instance,
          role,
          store,
          next: this.nextMove(instance, workflow, role, store),
        });
      }
    }
    this.custody = custody;
    return custody;
  }

  private nextMove(
    instance: string,
    workflow: WorkflowDefinition,
    role: string,
    store: string,
  ): string | null {
    for (const definition of workflow.tasks) {
      const id = `${instance}/${definition.key}`;
      if (this.tasks.get(id)?.kind === "completed") continue;
      for (const step of definition.carriers)
        if (step.role === role && step.kind === "move" && step.from === store)
          return id;
    }
    return null;
  }

  private acquiredFrom(custody: Custody): string | null {
    const workflow = this.workflowOf(custody.instance);
    for (const definition of workflow?.tasks ?? [])
      for (const step of definition.carriers)
        if (step.role === custody.role && step.kind === "acquire")
          return step.from;
    return null;
  }

  private store(id: string): Logistics["carrierStores"][number] | null {
    for (const store of this.view.carrierStores)
      if (store.id === id) return store;
    return null;
  }

  /** The oldest unfinished task that draws a material store's product. */
  private nextConsumer(storage: string): string | null {
    let product: string | null = null;
    for (const store of this.scenario.storages)
      if (store.id === storage && store.capacity.kind === "material")
        product = store.capacity.product;
    if (product === null) return null;
    for (const task of this.unfinished()) {
      const definition = this.definition(task);
      for (const input of definition?.inputs ?? [])
        if (input.kind === "pool" && input.product === product) return task.id;
    }
    return null;
  }

  private nextProducer(product: string): string | null {
    for (const task of this.unfinished()) {
      const definition = this.definition(task);
      for (const output of definition?.outputs ?? [])
        if (
          (output.kind === "lot" || output.kind === "measured-lot") &&
          output.product === product
        )
          return task.id;
    }
    return null;
  }

  private unfinished(): TaskView[] {
    const tasks: TaskView[] = [];
    for (const task of this.view.tasks)
      if (task.kind === "waiting" || task.kind === "executing")
        tasks.push(task);
    return tasks;
  }
}

function apply(stores: Map<string, string | null>, step: CarrierStep): void {
  switch (step.kind) {
    case "acquire":
      stores.set(step.role, step.from);
      return;
    case "move":
      stores.set(step.role, step.to);
      return;
    case "release":
      stores.set(step.role, null);
      return;
    default:
      return assertNever(step);
  }
}

function older(left: Custody, right: Custody): boolean {
  return sequence(left.instance) < sequence(right.instance);
}
function sequence(instance: string): number {
  return Number(instance.slice(instance.lastIndexOf("#") + 1));
}

function quantity(amount: number, unit: string): string {
  if (unit === "milligram") return `${Math.round(amount / 1000)} g`;
  if (unit === "each") return `${amount}`;
  return `${amount} ${unit}`;
}
