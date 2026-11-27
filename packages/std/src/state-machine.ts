// One shape for every lifecycle that Pantry and Commerce write down as data
// (Refactor 15, S1). A definition names its states, its events and the guards
// of each move, the store that holds the state, the one module that writes
// that store, and how each state that is not terminal ends.

type MachineStateKind = "initial" | "intermediate" | "terminal" | "external";

/**
 * How a state that is not terminal ends. `due`: the named alarm reconciler
 * moves it after `afterMs` at the latest. `person`: a person sees the state on
 * `surface` and acts on it there.
 */
export type MachineExit =
  | Readonly<{ kind: "due"; reconciler: string; afterMs: number }>
  | Readonly<{ kind: "person"; surface: string }>;

/**
 * Where the state is stored: a column, or a JSON path inside a column.
 * `since` is an SQL expression over `table` for the time in milliseconds
 * when the row entered its state, or the nearest time that the store keeps.
 * The census reads it for the age of each row; it is null for a row that
 * keeps no time.
 */
export type MachineStore = Readonly<{
  table: string;
  key: string;
  column: string;
  path?: string;
  since?: string;
}>;

type MachineStateDefinition = Readonly<{
  kind: MachineStateKind;
  meaning: string;
  exit?: MachineExit;
}>;

type MachineTransitionDefinition<State extends string = string> = Readonly<{
  event: string;
  from: readonly State[];
  to: State;
  by: readonly string[];
  guards: readonly string[];
}>;

export type MachineDefinition<State extends string = string> = Readonly<{
  name: string;
  /** The repository path of the one module that writes `store`. */
  owner?: string;
  store?: MachineStore;
  states: Readonly<Record<State, MachineStateDefinition>>;
  transitions: readonly MachineTransitionDefinition<State>[];
}>;

export type MachineState<Definition extends MachineDefinition> =
  keyof Definition["states"] & string;
export type MachineEvent<Definition extends MachineDefinition> =
  Definition["transitions"][number]["event"];

type TransitionOf<
  Definition extends MachineDefinition,
  Event extends MachineEvent<Definition>,
> = Extract<Definition["transitions"][number], Readonly<{ event: Event }>>;

export type MachineGuard<
  Definition extends MachineDefinition,
  Event extends MachineEvent<Definition>,
> = TransitionOf<Definition, Event>["guards"][number];

/** One check for each guard that the event names. */
export type MachineGuardChecks<
  Definition extends MachineDefinition,
  Event extends MachineEvent<Definition>,
> = Readonly<Record<MachineGuard<Definition, Event>, () => boolean>>;

type MachineRefusal<Definition extends MachineDefinition> =
  | Readonly<{
      code: "invalid_transition";
      machine: Definition["name"];
      state: MachineState<Definition>;
      event: MachineEvent<Definition>;
    }>
  | Readonly<{
      code: "transition_guard_refused";
      machine: Definition["name"];
      state: MachineState<Definition>;
      event: MachineEvent<Definition>;
      guard: string;
    }>;

export type MachineTransitionResult<
  Definition extends MachineDefinition,
  Event extends MachineEvent<Definition>,
> =
  | Readonly<{
      allowed: true;
      from: TransitionOf<Definition, Event>["from"][number];
      to: TransitionOf<Definition, Event>["to"];
    }>
  | Readonly<{ allowed: false; refusal: MachineRefusal<Definition> }>;

/**
 * Checks that `event` may move a record in `state`, and runs the guards of
 * that move. A move that the machine does not allow is an
 * `invalid_transition`; a guard that answers false is a
 * `transition_guard_refused`. The caller writes the move only when it is
 * allowed.
 */
export function machineTransition<
  Definition extends MachineDefinition,
  Event extends MachineEvent<Definition>,
>(
  definition: Definition,
  state: MachineState<Definition>,
  event: Event,
  ...guards: [MachineGuard<Definition, Event>] extends [never]
    ? []
    : [MachineGuardChecks<Definition, Event>]
): MachineTransitionResult<Definition, Event> {
  const checks = guards[0] as
    Readonly<Record<string, () => boolean>> | undefined;
  for (const transition of definition.transitions) {
    if (transition.event !== event || !transition.from.includes(state))
      continue;
    for (const guard of transition.guards)
      if (checks?.[guard]?.() !== true)
        return {
          allowed: false,
          refusal: {
            code: "transition_guard_refused",
            machine: definition.name,
            state,
            event,
            guard,
          },
        };
    return {
      allowed: true,
      from: state as TransitionOf<Definition, Event>["from"][number],
      to: transition.to as TransitionOf<Definition, Event>["to"],
    };
  }
  return {
    allowed: false,
    refusal: {
      code: "invalid_transition",
      machine: definition.name,
      state,
      event,
    },
  };
}

/** True when no event moves a record in `state` to another state. */
export function isTerminalMachineState<Definition extends MachineDefinition>(
  definition: Definition,
  state: MachineState<Definition>,
): boolean {
  return definition.states[state]?.kind === "terminal";
}

/**
 * The problems of one machine: every state that a transition names exists,
 * a terminal state leads only to itself, no transition touches an external
 * state, one state and one event lead to one target, and every state can be
 * reached from an initial state. With `requireExits`, every state that is
 * not terminal or external also names its exit.
 */
export function machineProblems(
  machine: MachineDefinition,
  options: Readonly<{ requireExits: boolean }> = { requireExits: false },
): string[] {
  const found: string[] = [];
  const states = new Map(Object.entries(machine.states));
  const targets = new Map<string, string>();
  for (const transition of machine.transitions) {
    for (const name of [...transition.from, transition.to]) {
      if (!states.has(name))
        found.push(`${machine.name}.${transition.event}: no state ${name}`);
      if (states.get(name)?.kind === "external")
        found.push(`${machine.name}.${transition.event}: ${name} is external`);
    }
    for (const from of transition.from) {
      if (states.get(from)?.kind === "terminal" && from !== transition.to)
        found.push(`${machine.name}.${transition.event}: ${from} is terminal`);
      const key = `${from} ${transition.event}`;
      const target = targets.get(key);
      if (target !== undefined && target !== transition.to)
        found.push(`${machine.name}: ${key} has two targets`);
      targets.set(key, transition.to);
    }
  }
  const reached = new Set<string>();
  for (const [name, state] of states)
    if (state.kind === "initial") reached.add(name);
  if (reached.size === 0) found.push(`${machine.name}: no initial state`);
  for (let grew = true; grew;) {
    grew = false;
    for (const transition of machine.transitions)
      if (
        !reached.has(transition.to) &&
        transition.from.some((from) => reached.has(from))
      ) {
        reached.add(transition.to);
        grew = true;
      }
  }
  for (const [name, state] of states)
    if (state.kind !== "external" && !reached.has(name))
      found.push(`${machine.name}: ${name} cannot be reached`);
  if (options.requireExits) {
    for (const [name, state] of states) {
      if (state.kind === "terminal" || state.kind === "external") continue;
      if (state.exit === undefined)
        found.push(`${machine.name}: ${name} names no exit`);
      else if (!machine.transitions.some((move) => move.from.includes(name)))
        found.push(`${machine.name}: no event leaves ${name}`);
    }
    if (machine.owner === undefined)
      found.push(`${machine.name}: no owner module`);
    if (machine.store === undefined) found.push(`${machine.name}: no store`);
  }
  return found;
}
