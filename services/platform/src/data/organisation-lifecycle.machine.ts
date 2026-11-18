import type { MachineDefinition } from "@seams/std/state-machine";

/**
 * The lifecycle of an Organisation (Refactor 15, refactor 5). The state is
 * `organisation_onboarding.lifecycle` in the Organisation's regional
 * database, and `organisation-lifecycle-moves.ts` writes it: each statement
 * names the state that the move leaves (`WHERE lifecycle = ?`) and, except
 * for the readiness refresh, which holds no placement, the placement fence.
 *
 * `archived` has two parts, which `organisation_archive_cleanup.status`
 * holds: `pending_provider_cleanup` until the scheduled cleanup revokes the
 * provider credentials, then `pending_purge` until `purge_after`. The
 * `organisation.status` column copies the end of the lifecycle: `active`
 * while the Organisation is in use, `deleted` while it is archived, and
 * `purged` after the purge.
 */
export const ORGANISATION_LIFECYCLE_MACHINE = {
  name: "organisation_lifecycle",
  owner: "services/platform/src/data/organisation-lifecycle-moves.ts",
  store: {
    table: "organisation_onboarding",
    key: "organisation_id",
    column: "lifecycle",
  },
  states: {
    configuring: {
      kind: "initial",
      meaning:
        "The Organisation is set up: a person connects providers and saves the setup, then starts the activation.",
      exit: { kind: "person", surface: "Portal onboarding" },
    },
    activating: {
      kind: "intermediate",
      meaning:
        "An activation attempt runs under a lease. It ends active, or it fails back to configuring; a person can start it again.",
      exit: { kind: "person", surface: "Portal onboarding" },
    },
    active: {
      kind: "intermediate",
      meaning:
        "The Organisation is in use. An owner can archive it in the Portal.",
      exit: { kind: "person", surface: "Portal Organisation settings" },
    },
    archived: {
      kind: "intermediate",
      meaning:
        "The owner archived the Organisation. Its cleanup revokes the provider credentials (pending_provider_cleanup), and then it waits for its purge (pending_purge). Until purge_after, an owner can restore it.",
      exit: {
        kind: "due",
        reconciler: "archived_organisation",
        afterMs: 30 * 24 * 60 * 60 * 1_000,
      },
    },
    purging: {
      kind: "intermediate",
      meaning:
        "The purge started: no restore is possible. The scheduled run erases the Actors, closes the merchant, moves the Slack credentials and then erases the rows.",
      exit: {
        kind: "due",
        reconciler: "archived_organisation",
        afterMs: 15 * 60_000,
      },
    },
    purged: {
      kind: "terminal",
      meaning:
        "The purge erased every row that the purge catalogue marks erase and pseudonymized the rest. The Organisation's handle, Google accounts and Slack workspaces are free for a new Organisation.",
    },
  },
  transitions: [
    {
      event: "start_activation",
      from: ["configuring", "activating"],
      to: "activating",
      by: ["organisation_actor"],
      guards: [],
    },
    {
      event: "save_setup",
      from: ["configuring", "active"],
      to: "configuring",
      by: ["owner"],
      guards: [],
    },
    {
      event: "assess_readiness",
      from: ["configuring"],
      to: "configuring",
      by: ["readiness"],
      guards: [],
    },
    {
      event: "activate",
      from: ["activating"],
      to: "active",
      by: ["organisation_actor"],
      guards: [],
    },
    {
      event: "fail_activation",
      from: ["activating"],
      to: "configuring",
      by: ["organisation_actor"],
      guards: [],
    },
    {
      event: "archive",
      from: ["configuring", "active"],
      to: "archived",
      by: ["owner", "support_admin"],
      guards: [],
    },
    {
      event: "restore",
      from: ["archived"],
      to: "configuring",
      by: ["owner"],
      guards: ["purge_not_due"],
    },
    {
      event: "start_purge",
      from: ["archived"],
      to: "purging",
      by: ["scheduled_run"],
      guards: ["purge_due"],
    },
    {
      event: "purge",
      from: ["purging"],
      to: "purged",
      by: ["scheduled_run"],
      guards: [],
    },
  ],
} as const satisfies MachineDefinition;
