import type { MachineDefinition } from "@purin-labs/std/state-machine";

/**
 * The Case's wait for a person's decision on a commerce action (Refactor 15,
 * refactor 1). The action ledger in OrganisationActor owns the decision; the
 * Case derives this state from the ledger entry and never decides by itself.
 */
export const CASE_APPROVAL_WAIT_MACHINE = {
  name: "case_approval_wait",
  owner: "foundation/conversation/actors/case/proposals.ts",
  store: {
    table: "case_commerce_approval",
    key: "action_nonce",
    column: "payload",
    path: "$.kind",
    since: "json_extract(payload, '$.request.requestedAt')",
  },
  states: {
    waiting: {
      kind: "initial",
      meaning: "The Case waits for a person to approve or reject the action.",
      exit: {
        kind: "due",
        reconciler: "commerce_approval_wait",
        afterMs: 15 * 60_000,
      },
    },
    decided: {
      kind: "terminal",
      meaning: "A person approved or rejected the action in the ledger.",
    },
    lapsed: {
      kind: "terminal",
      meaning: "The action expired in the ledger before it ran.",
    },
  },
  transitions: [
    {
      event: "decide",
      from: ["waiting"],
      to: "decided",
      by: ["system"],
      guards: [],
    },
    {
      event: "lapse",
      from: ["waiting"],
      to: "lapsed",
      by: ["system"],
      guards: [],
    },
  ],
} as const satisfies MachineDefinition;
