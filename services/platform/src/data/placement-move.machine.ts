import type { MachineDefinition } from "@purin-labs/std/state-machine";

/**
 * One move of an Organisation from one placement epoch to the next
 * (Refactor 15, refactor 5). A relocation copies the Organisation's Actors
 * and regional rows to a new cell; a restore imports Actors from the exports
 * of a retained relocation. Both are the same move: the source freezes, the
 * target is filled, and a publication retires the source and activates the
 * target. An Organisation has one open move at a time, of either kind.
 *
 * A move that cannot finish is abandoned. The abandon never reopens a frozen
 * source epoch: it releases the target and reserves a recovery epoch in the
 * source's cell, and a recovery relocation publishes it. So each state from
 * `frozen` or `quarantined` leads back to an active placement.
 *
 * A relocation uses `copy`, `retain` and `clean`; a restore uses `import` and
 * completes at publication. The operator acts on each open state through the
 * admin routes `/v1/admin/state-object-relocation` and
 * `/v1/admin/state-object-restore`.
 */
const OPERATOR = {
  kind: "person",
  surface: "admin_state_object_move",
} as const;

const PLACEMENT_MOVE_STATES = {
  reserved: {
    kind: "initial",
    meaning:
      "The target epoch is reserved and the source still admits work. A resume freezes the source.",
    exit: OPERATOR,
  },
  frozen: {
    kind: "intermediate",
    meaning:
      "The source admits no new work. The move waits for the source to quiesce, or it is abandoned.",
    exit: OPERATOR,
  },
  copying: {
    kind: "intermediate",
    meaning:
      "A relocation exports the source Actors and copies the regional rows to the target.",
    exit: OPERATOR,
  },
  importing: {
    kind: "intermediate",
    meaning:
      "A restore imports the Actors of its manifest into the target epoch.",
    exit: OPERATOR,
  },
  published: {
    kind: "intermediate",
    meaning:
      "The target is the active placement. The source Actors still wait for their retirement.",
    exit: OPERATOR,
  },
  retained: {
    kind: "intermediate",
    meaning:
      "A relocation keeps the source copy for its retention time, as a recovery point.",
    exit: OPERATOR,
  },
  cleaning: {
    kind: "intermediate",
    meaning:
      "A relocation erases the source copy, its exports and the Actors of its abandoned targets.",
    exit: OPERATOR,
  },
  quarantined: {
    kind: "intermediate",
    meaning:
      "An import failed for good. The source stays frozen until the operator abandons the move.",
    exit: OPERATOR,
  },
  complete: {
    kind: "terminal",
    meaning: "The move ended. A relocation also erased its source copy.",
  },
  abandoned: {
    kind: "terminal",
    meaning:
      "The move ended without publication. Its recovery relocation names the epoch that replaced the source.",
  },
} as const;

const PLACEMENT_MOVE_TRANSITIONS = [
  {
    event: "freeze",
    from: ["reserved"],
    to: "frozen",
    by: ["operator"],
    guards: ["source_active", "target_reserved"],
  },
  {
    event: "release",
    from: ["frozen"],
    to: "reserved",
    by: ["operator"],
    guards: ["regional_freeze_refused", "source_not_quiesced"],
  },
  {
    event: "copy",
    from: ["frozen", "copying"],
    to: "copying",
    by: ["operator"],
    guards: [],
  },
  {
    event: "import",
    from: ["frozen", "importing"],
    to: "importing",
    by: ["operator"],
    guards: [],
  },
  {
    event: "publish",
    from: ["copying", "importing"],
    to: "published",
    by: ["operator"],
    guards: ["target_filled"],
  },
  {
    event: "retain",
    from: ["published"],
    to: "retained",
    by: ["operator"],
    guards: ["sources_retired"],
  },
  {
    event: "clean",
    from: ["retained"],
    to: "cleaning",
    by: ["operator"],
    guards: ["retention_ended", "provider_work_ended", "restores_ended"],
  },
  {
    event: "complete",
    from: ["published", "cleaning"],
    to: "complete",
    by: ["operator"],
    guards: [],
  },
  {
    event: "quarantine",
    from: ["reserved", "frozen", "copying", "importing"],
    to: "quarantined",
    by: ["operator"],
    guards: [],
  },
  {
    event: "abandon",
    from: ["reserved", "frozen", "copying", "importing", "quarantined"],
    to: "abandoned",
    by: ["operator"],
    guards: ["unpublished", "target_reserved"],
  },
] as const;

/** The relocation journal, `state_object_relocation`. */
export const PLACEMENT_MOVE_MACHINE = {
  name: "placement_move",
  owner: "services/platform/src/data/placement-move.ts",
  store: {
    table: "state_object_relocation",
    key: "relocation_id",
    column: "status",
  },
  states: PLACEMENT_MOVE_STATES,
  transitions: PLACEMENT_MOVE_TRANSITIONS,
} as const satisfies MachineDefinition;
