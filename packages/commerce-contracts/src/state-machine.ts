// The one way to move a record between the states of its lifecycle (Plan 77
// step 1). The tables in commerce-machines.ts are the source (Plan 78);
// scripts/check-commerce-data.mjs checks them.
import {
  machineProblems,
  type MachineExit,
} from "@purin-labs/std/state-machine";

import { COMMERCE_MACHINES } from "./commerce-machines.ts";

export type CommerceStateKind =
  "initial" | "intermediate" | "terminal" | "external";
export type CommerceTransitionActor = "buyer" | "staff" | "provider" | "system";

/** One generated machine. `State` is the `state` tag of its lifecycle type. */
export type CommerceMachineDefinition<State extends string> = Readonly<{
  name: string;
  lifecycle: string;
  stateType: "tagged" | "plain";
  specSection: number;
  states: Readonly<
    Record<
      State,
      Readonly<{ kind: CommerceStateKind; meaning: string; exit?: MachineExit }>
    >
  >;
  transitions: readonly Readonly<{
    event: string;
    from: readonly State[];
    to: State;
    by: readonly CommerceTransitionActor[];
    guards: readonly string[];
  }>[];
}>;

type Machines = typeof COMMERCE_MACHINES;

export type CommerceMachineName = keyof Machines;
export type CommerceMachineState<Machine extends CommerceMachineName> =
  keyof Machines[Machine]["states"] & string;
export type CommerceMachineEvent<Machine extends CommerceMachineName> =
  Machines[Machine]["transitions"][number]["event"];

/**
 * The refusal of an event that the machine does not allow in a state. With
 * no machine named, it is the union of every machine's refusal.
 */
export type CommerceInvalidTransition<
  Machine extends CommerceMachineName = CommerceMachineName,
> = Machine extends CommerceMachineName
  ? Readonly<{
      code: "invalid_transition";
      machine: Machine;
      state: CommerceMachineState<Machine>;
      event: CommerceMachineEvent<Machine>;
    }>
  : never;

type TransitionsOf<
  Machine extends CommerceMachineName,
  Event extends CommerceMachineEvent<Machine>,
> = Extract<
  Machines[Machine]["transitions"][number],
  Readonly<{ event: Event }>
>;

/** The states in which `event` is allowed. */
export type CommerceTransitionSource<
  Machine extends CommerceMachineName,
  Event extends CommerceMachineEvent<Machine>,
> = TransitionsOf<Machine, Event>["from"][number];

/** The states that `event` can lead to. One for most events. */
export type CommerceTransitionTarget<
  Machine extends CommerceMachineName,
  Event extends CommerceMachineEvent<Machine>,
> = TransitionsOf<Machine, Event>["to"];

export type CommerceTransitionResult<
  Machine extends CommerceMachineName,
  Event extends CommerceMachineEvent<Machine>,
  Lifecycle extends Readonly<{ state: CommerceMachineState<Machine> }>,
> =
  | Readonly<{
      allowed: true;
      /** The record's lifecycle, narrowed to the states that allow `event`. */
      from: Extract<
        Lifecycle,
        Readonly<{ state: CommerceTransitionSource<Machine, Event> }>
      >;
      to: CommerceTransitionTarget<Machine, Event>;
      guards: readonly string[];
    }>
  | Readonly<{ allowed: false; refusal: CommerceInvalidTransition<Machine> }>;

/**
 * Checks that `event` is allowed for a record whose lifecycle is
 * `lifecycle`. It returns the lifecycle narrowed to the allowed states, the
 * state that the event leads to, and the guards that the caller checks
 * before the move. An event that the machine does not allow returns an
 * `invalid_transition` refusal.
 */
export function commerceTransition<
  Machine extends CommerceMachineName,
  Event extends CommerceMachineEvent<Machine>,
  Lifecycle extends Readonly<{ state: CommerceMachineState<Machine> }>,
>(
  machine: Machine,
  lifecycle: Lifecycle,
  event: Event,
): CommerceTransitionResult<Machine, Event, Lifecycle> {
  const definition: CommerceMachineDefinition<string> =
    COMMERCE_MACHINES[machine];
  for (const transition of definition.transitions)
    if (transition.event === event && transition.from.includes(lifecycle.state))
      return {
        allowed: true,
        from: lifecycle as Extract<
          Lifecycle,
          Readonly<{ state: CommerceTransitionSource<Machine, Event> }>
        >,
        to: transition.to as CommerceTransitionTarget<Machine, Event>,
        guards: transition.guards,
      };
  return {
    allowed: false,
    refusal: {
      code: "invalid_transition",
      machine,
      state: lifecycle.state,
      event,
    } as CommerceInvalidTransition<Machine>,
  };
}

/** True when no event moves a record in `state` to another state. */
export function isTerminalCommerceState<Machine extends CommerceMachineName>(
  machine: Machine,
  state: CommerceMachineState<Machine>,
): boolean {
  const definition: CommerceMachineDefinition<string> =
    COMMERCE_MACHINES[machine];
  return definition.states[state]?.kind === "terminal";
}

/**
 * The refusal that these names describe, or undefined when the tables have
 * no such machine, state or event. A client parses a refusal through it.
 */
export function readCommerceInvalidTransition(
  machine: string,
  state: string,
  event: string,
): CommerceInvalidTransition | undefined {
  if (!Object.hasOwn(COMMERCE_MACHINES, machine)) return undefined;
  const definition: CommerceMachineDefinition<string> =
    COMMERCE_MACHINES[machine as CommerceMachineName];
  if (
    !Object.hasOwn(definition.states, state) ||
    !definition.transitions.some((transition) => transition.event === event)
  )
    return undefined;
  return {
    code: "invalid_transition",
    machine,
    state,
    event,
  } as CommerceInvalidTransition;
}

/**
 * The problems of one machine table: every state that a transition names
 * exists, a terminal state leads only to itself, no transition touches an
 * external state, every other state can be reached from an initial state,
 * and one state and one event lead to one target. The rules are the shared
 * ones of `@purin-labs/std/state-machine` (Refactor 15, S1).
 */
export function commerceMachineProblems(
  machine: CommerceMachineDefinition<string>,
): string[] {
  return machineProblems(machine);
}
