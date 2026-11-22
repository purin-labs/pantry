import type { MachineDefinition } from "@purin-labs/std/state-machine";

/**
 * One Cue of one subscription in the Organisation (Refactor 15). A consumer
 * claims it for a lease; the consumer completes it, or, when its lease ended
 * long ago, the Organisation's alarm ends it as a failed delivery. A Cue that
 * its limits suppress is stored as delivered at once.
 */
export const CUE_DELIVERY_MACHINE = {
  name: "cue_delivery",
  owner: "foundation/agent/actors/cue-delivery.ts",
  store: {
    table: "cue_delivery",
    key: "cue_id",
    column: "state",
    since: "claimed_at",
  },
  states: {
    claimed: {
      kind: "initial",
      meaning:
        "A queue consumer holds the Cue for its lease. After the lease, a retry of the message may claim it again.",
      exit: { kind: "due", reconciler: "cue_claims", afterMs: 15 * 60_000 },
    },
    delivered: {
      kind: "terminal",
      meaning:
        "The Cue has its outcome: proposed, failed, or suppressed by its limits.",
    },
  },
  transitions: [
    {
      event: "reclaim",
      from: ["claimed"],
      to: "claimed",
      by: ["queue"],
      guards: ["lease_ended"],
    },
    {
      event: "complete",
      from: ["claimed"],
      to: "delivered",
      by: ["queue"],
      guards: ["same_lease"],
    },
    {
      event: "abandon",
      from: ["claimed"],
      to: "delivered",
      by: ["alarm"],
      guards: ["claim_abandoned"],
    },
  ],
} as const satisfies MachineDefinition;
