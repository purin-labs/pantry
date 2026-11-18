import type { MachineDefinition } from "@seams/std/state-machine";

/**
 * One side Case proposal of a Portal chat or a Slack thread (Plan 74,
 * Refactor 15). `status` stores `open`, `starting`, `started` and
 * `dismissed`. Two moves are read-time rules and are not stored: `expire`
 * (an open proposal past `expires_at` reads as `expired`) and `release` (a
 * start whose lease ended reads as `open` again, so a person can start it
 * or dismiss it). The next claim or dismissal writes over a released start.
 */
export const SIDE_CASE_MACHINE = {
  name: "side_case_proposal",
  owner: "services/platform/src/chat/side-case-transition.ts",
  store: { table: "side_case_proposal", key: "proposal_id", column: "status" },
  states: {
    open: {
      kind: "initial",
      meaning:
        "The card shows Start (and Dismiss in the Portal) until the proposal expires.",
      exit: { kind: "person", surface: "side_case_card" },
    },
    starting: {
      kind: "intermediate",
      meaning:
        "A person clicked Start. Only that person continues the start until the start lease ends; then the proposal reads as open again, or as expired.",
      exit: { kind: "person", surface: "side_case_card" },
    },
    started: {
      kind: "terminal",
      meaning: "The new chat or thread holds the brief as its first message.",
    },
    dismissed: {
      kind: "terminal",
      meaning: "A person closed the Portal proposal without a chat.",
    },
    expired: {
      kind: "terminal",
      meaning:
        "Read-time only: nobody started or dismissed the proposal before expires_at.",
    },
  },
  transitions: [
    {
      event: "claim",
      from: ["open"],
      to: "starting",
      by: ["person"],
      guards: [],
    },
    {
      event: "release",
      from: ["starting"],
      to: "open",
      by: ["lease"],
      guards: ["start_lease_ended"],
    },
    {
      event: "start",
      from: ["starting"],
      to: "started",
      by: ["system"],
      guards: [],
    },
    {
      event: "dismiss",
      from: ["open"],
      to: "dismissed",
      by: ["person"],
      guards: [],
    },
    {
      event: "expire",
      from: ["open"],
      to: "expired",
      by: ["clock"],
      guards: ["lifetime_ended"],
    },
  ],
} as const satisfies MachineDefinition;
