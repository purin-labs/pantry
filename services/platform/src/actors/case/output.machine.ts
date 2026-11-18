import type { MachineDefinition } from "@seams/std/state-machine";

/**
 * One answer of a Case on its way to the conversation (Refactor 15,
 * refactor 2). A resume path sends only a `pending` output: an output that
 * waits for a person's decision is `held`, and only that decision moves it.
 */
export const CASE_OUTPUT_MACHINE = {
  name: "case_output",
  owner: "services/platform/src/actors/case/outputs.ts",
  store: {
    table: "case_output",
    key: "output_id",
    column: "lifecycle_json",
    path: "$.kind",
    // A pending answer is as old as its journal entry, the time that the
    // undelivered-output step reads; a held answer keeps its hold time.
    since: `COALESCE(json_extract(lifecycle_json, '$.heldAt'), (SELECT accepted_at FROM case_journal WHERE entry_id = json_extract(case_output.lifecycle_json, '$.output.entryId')))`,
  },
  states: {
    pending: {
      kind: "initial",
      meaning:
        "The answer waits for its delivery. The Connector's Case work retries it; after a day the Case alarm drops it as undelivered.",
      exit: {
        kind: "due",
        reconciler: "undelivered_outputs",
        afterMs: 24 * 60 * 60_000,
      },
    },
    held: {
      kind: "intermediate",
      meaning:
        "The exit check stopped the answer, and a person decides if it goes out.",
      exit: { kind: "person", surface: "slack_held_output_card" },
    },
    settled: {
      kind: "terminal",
      meaning: "The conversation received the answer.",
    },
    dropped: {
      kind: "terminal",
      meaning:
        "A person denied the answer, nobody decided in time, or nothing delivered it within a day.",
    },
    rejected: {
      kind: "terminal",
      meaning: "The provider refused the delivery for good.",
    },
  },
  transitions: [
    {
      event: "hold",
      from: ["pending"],
      to: "held",
      by: ["system"],
      guards: [],
    },
    {
      event: "settle",
      from: ["pending", "held"],
      to: "settled",
      by: ["system"],
      guards: [],
    },
    {
      // A pending output can be dropped too: an output that was held before
      // the `held` state existed is stored as pending.
      event: "drop",
      from: ["pending", "held"],
      to: "dropped",
      by: ["system"],
      guards: [],
    },
    {
      event: "reject",
      from: ["pending", "held"],
      to: "rejected",
      by: ["provider"],
      guards: [],
    },
  ],
} as const satisfies MachineDefinition;
