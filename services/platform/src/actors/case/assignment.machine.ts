import type { MachineDefinition } from "@seams/std/state-machine";

/** An assignment that nothing has moved for this long may be abandoned. */
export const ASSIGNMENT_ABANDON_AFTER_MS = 30 * 60_000;

/**
 * One assignment of a Case to a Session (Refactor 15, refactor 9). An
 * assignment that no live turn will finish, because its process stopped, is
 * abandoned: the Session must first prove that it runs no turn. The next
 * delivery of the same work abandons it at once; the Case alarm abandons one
 * that no delivery comes back to.
 */
export const CASE_ASSIGNMENT_MACHINE = {
  name: "case_assignment",
  owner: "services/platform/src/actors/case/lifecycle.ts",
  store: {
    table: "case_assignment",
    key: "assignment_id",
    column: "lifecycle_json",
    path: "$.kind",
    since:
      "COALESCE(json_extract(lifecycle_json, '$.start.acceptedAt'), assigned_at)",
  },
  states: {
    assigned: {
      kind: "initial",
      meaning: "The Case named the Session; no turn has begun.",
      exit: {
        kind: "due",
        reconciler: "abandoned_assignments",
        afterMs: ASSIGNMENT_ABANDON_AFTER_MS,
      },
    },
    running: {
      kind: "intermediate",
      meaning: "A turn of the Session works on the assignment.",
      exit: {
        kind: "due",
        reconciler: "abandoned_assignments",
        afterMs: ASSIGNMENT_ABANDON_AFTER_MS,
      },
    },
    settled: {
      kind: "terminal",
      meaning:
        "The assignment ended: completed, cancelled, failed, out of budget or abandoned.",
    },
  },
  transitions: [
    {
      event: "begin",
      from: ["assigned"],
      to: "running",
      by: ["system"],
      guards: [],
    },
    {
      event: "settle",
      from: ["running"],
      to: "settled",
      by: ["system"],
      guards: [],
    },
    {
      event: "abandon",
      from: ["assigned", "running"],
      to: "settled",
      by: ["system"],
      guards: ["session_quiescent"],
    },
  ],
} as const satisfies MachineDefinition;
