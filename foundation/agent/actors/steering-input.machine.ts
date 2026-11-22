import type { MachineDefinition } from "@purin-labs/std/state-machine";

/**
 * One steering input of a Session's turn (Plan 71; Refactor 15, refactor 3).
 * An input that is not placed ends as `withdrawn` when its turn ends, by any
 * path: the live runtime's close, or the Session's read for a surface once
 * the turn holds no harness lease (`settledSteeringInput`). The Connector
 * reads each parked reply when its running Case work ends, within one lease
 * of the Case work.
 */
export const STEERING_INPUT_MACHINE = {
  name: "steering_input",
  owner: "foundation/agent/actors/harness-steering.ts",
  store: {
    table: "session_turn_steering_input",
    key: "input_id",
    column: "state",
    since: "admitted_at",
  },
  states: {
    admitted: {
      kind: "initial",
      meaning: "The Session recorded the input; the harness has not seen it.",
      exit: { kind: "due", reconciler: "case_work", afterMs: 120_000 },
    },
    queued: {
      kind: "intermediate",
      meaning: "The harness holds the input for the turn's next boundary.",
      exit: { kind: "due", reconciler: "case_work", afterMs: 120_000 },
    },
    placed: {
      kind: "terminal",
      meaning: "The turn read the input; the Case journals it.",
    },
    withdrawn: {
      kind: "terminal",
      meaning: "The turn ended first; the surface runs the input next.",
    },
  },
  transitions: [
    {
      event: "queue",
      from: ["admitted"],
      to: "queued",
      by: ["harness"],
      guards: [],
    },
    {
      event: "place",
      from: ["queued"],
      to: "placed",
      by: ["harness"],
      guards: ["turn_is_running"],
    },
    {
      event: "withdraw",
      from: ["admitted", "queued"],
      to: "withdrawn",
      by: ["system", "harness"],
      guards: [],
    },
  ],
} as const satisfies MachineDefinition;
