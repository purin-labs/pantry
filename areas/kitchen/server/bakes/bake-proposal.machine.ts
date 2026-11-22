import type { MachineDefinition } from "@purin-labs/std/state-machine";

/**
 * One proposed bake run of one product (Plan 24 S1). A product has at most one
 * active proposal (open or approved); a fall of its stock while one is active
 * makes one proposal that waits. A person with the operator role or a higher
 * one approves or rejects an open proposal, in the Portal or in Slack. One
 * approval covers the run, its load and its unload (decision D1). The run of
 * an approved proposal ends it (Plan 24 S4), and the end of an active
 * proposal opens the one that waits.
 */
export const BAKE_PROPOSAL_MACHINE = {
  name: "bake_proposal",
  owner: "areas/kitchen/server/bakes/records.ts",
  store: {
    table: "bake_proposal",
    key: "proposal_id",
    column: "state",
    since: "COALESCE(ended_at, decided_at, opened_at, proposed_at)",
  },
  states: {
    waiting: {
      kind: "initial",
      meaning:
        "The stock fell below its level while another proposal of the product was active. It opens when that one ends.",
      exit: { kind: "person", surface: "portal_bakes" },
    },
    open: {
      kind: "initial",
      meaning:
        "The proposal waits for a person to approve or reject it, on the Bakes page or on its Slack card.",
      exit: { kind: "person", surface: "portal_bakes" },
    },
    approved: {
      kind: "intermediate",
      meaning:
        "A person approved the bake run. Its run ends it; until then no other proposal of the product opens.",
      exit: { kind: "person", surface: "portal_bakes" },
    },
    rejected: {
      kind: "terminal",
      meaning: "A person rejected the proposal, with the stored reason.",
    },
    ended: {
      kind: "terminal",
      meaning: "The approved bake run ended.",
    },
  },
  transitions: [
    {
      // The active proposal of the product ended.
      event: "open",
      from: ["waiting"],
      to: "open",
      by: ["platform"],
      guards: [],
    },
    {
      event: "approve",
      from: ["open"],
      to: "approved",
      by: ["person"],
      guards: ["decider_may_operate", "oven_named"],
    },
    {
      event: "reject",
      from: ["open"],
      to: "rejected",
      by: ["person"],
      guards: ["decider_may_operate", "reason_given"],
    },
    {
      event: "end",
      from: ["approved"],
      to: "ended",
      by: ["platform"],
      guards: [],
    },
  ],
} as const satisfies MachineDefinition;
