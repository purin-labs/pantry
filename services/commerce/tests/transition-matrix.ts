// The transition matrix of the state machine conformance journeys (Plan 77
// step 1). A journey names the machines that it covers and the cells that it
// does not reach, as `machine state event` patterns (`*` matches any state or
// event) with the reason. Every cell that the journey does not probe must
// match one pattern, and every pattern must match a cell that it does not
// probe.
import type { CommerceMutationResultV1 } from "@purin-labs/commerce-client";
import {
  COMMERCE_MACHINES,
  type CommerceMachineName,
} from "@purin-labs/commerce-contracts";
import { expect } from "vitest";

export type MachineAnswer = Readonly<{
  machine: string;
  state: string;
  event: string;
}>;

export class TransitionMatrix {
  readonly #cells = new Map<string, string>();
  readonly #machines: readonly CommerceMachineName[];
  readonly #notReached: Readonly<Record<string, string>>;

  constructor(
    machines: readonly CommerceMachineName[],
    notReached: Readonly<Record<string, string>>,
  ) {
    this.#machines = machines;
    this.#notReached = notReached;
  }

  allowed(machine: CommerceMachineName, state: string, event: string): boolean {
    return COMMERCE_MACHINES[machine].transitions.some(
      (transition) =>
        transition.event === event &&
        (transition.from as readonly string[]).includes(state),
    );
  }

  /**
   * Checks one answer: an allowed move is never `invalid_transition`; a
   * forbidden move is, from the machine named by `answer` (the cell's own by
   * default).
   */
  check(
    machine: CommerceMachineName,
    state: string,
    event: string,
    result: CommerceMutationResultV1,
    answer: MachineAnswer = { machine, state, event },
  ): void {
    if (this.allowed(machine, state, event)) {
      expect(result).not.toMatchObject({
        outcome: "rejected",
        error: { code: "invalid_transition" },
      });
      this.observed(
        machine,
        state,
        event,
        result.outcome === "rejected"
          ? `guard ${"field" in result.error ? result.error.field : result.error.code}`
          : "applied",
      );
      return;
    }
    expect(result).toEqual({
      outcome: "rejected",
      error: { code: "invalid_transition", ...answer },
    });
    this.observed(
      machine,
      state,
      event,
      answer.machine === machine && answer.state === state
        ? "refused"
        : `refused by ${answer.machine} in ${answer.state}`,
    );
  }

  /**
   * Checks a forbidden move on a buyer route that does not show the state: a
   * buyer learns only that a code does not apply.
   */
  hidden(
    machine: CommerceMachineName,
    state: string,
    event: string,
    result: CommerceMutationResultV1,
    field: string,
  ): void {
    expect(this.allowed(machine, state, event)).toBe(false);
    expect(result).toMatchObject({ outcome: "rejected", error: { field } });
    this.observed(machine, state, event, `refused; the buyer sees ${field}`);
  }

  observed(
    machine: string,
    state: string,
    event: string,
    outcome: string,
  ): void {
    this.#cells.set(`${machine} ${state} ${event}`, outcome);
  }

  report() {
    const all: string[] = [];
    for (const name of this.#machines) {
      const definition = COMMERCE_MACHINES[name];
      const events = [
        ...new Set(definition.transitions.map((item) => item.event)),
      ];
      for (const [state, info] of Object.entries(definition.states)) {
        if (info.kind === "external") continue;
        for (const event of events) all.push(`${name} ${state} ${event}`);
      }
    }
    const unprobed = all.filter((cell) => !this.#cells.has(cell));
    const matches = (pattern: string, cell: string) => {
      const [machine, state, event] = pattern.split(" ");
      const [cellMachine, cellState, cellEvent] = cell.split(" ");
      return (
        machine === cellMachine &&
        (state === "*" || state === cellState) &&
        (event === "*" || event === cellEvent)
      );
    };
    const patterns = Object.entries(this.#notReached);
    return {
      cells: [...this.#cells.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([cell, outcome]) => ({ cell, outcome })),
      notReached: Object.fromEntries(
        unprobed.flatMap((cell) => {
          const reason = patterns.find(([pattern]) =>
            matches(pattern, cell),
          )?.[1];
          return reason === undefined ? [] : [[cell, reason] as const];
        }),
      ),
      unexplained: unprobed.filter(
        (cell) => !patterns.some(([pattern]) => matches(pattern, cell)),
      ),
      stalePatterns: patterns
        .map(([pattern]) => pattern)
        .filter((pattern) => !unprobed.some((cell) => matches(pattern, cell))),
    };
  }
}
