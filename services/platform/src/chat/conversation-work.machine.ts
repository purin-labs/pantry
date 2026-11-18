import type { MachineDefinition } from "@seams/std/state-machine";

/** How long a chat waits for a person's permission (Refactor 15, decision 5). */
export const PERMISSION_WAIT_MS = 24 * 60 * 60_000;

/**
 * The work of one Portal conversation (Refactor 15, refactor 9). The work
 * is part of the conversation's stored state in D1, and the Case of the
 * conversation holds one wake row while the work can move by itself. A
 * move to a rest state (`ready` with no queued message, `failed` or
 * `awaiting_permission`) ends the wake: the next move comes from a person.
 */
export const CONVERSATION_WORK_MACHINE = {
  name: "conversation_work",
  owner: "services/platform/src/chat/store.ts",
  store: {
    table: "portal_conversation",
    key: "conversation_id",
    column: "state_json",
    path: "$.work.kind",
  },
  states: {
    ready: {
      kind: "initial",
      meaning:
        "No turn runs. Queued messages run in turn; a person sends the next one.",
      exit: { kind: "due", reconciler: "conversation", afterMs: 15_000 },
    },
    running: {
      kind: "intermediate",
      meaning: "A turn runs under a lease.",
      exit: { kind: "due", reconciler: "conversation", afterMs: 15 * 60_000 },
    },
    cancelling: {
      kind: "intermediate",
      meaning: "A person stopped the turn; the Session's interrupt ends it.",
      exit: { kind: "due", reconciler: "conversation", afterMs: 15_000 },
    },
    awaiting_permission: {
      kind: "intermediate",
      meaning:
        "The turn waits for a person to allow or deny one permission. After 24 hours the wait expires as a failure.",
      exit: { kind: "person", surface: "portal_chat_permission_request" },
    },
    failed: {
      kind: "intermediate",
      meaning:
        "The turn stopped, or the queued message could not start, and the person sees why. A retry runs it again.",
      exit: { kind: "person", surface: "portal_chat_retry" },
    },
  },
  transitions: [
    {
      event: "admit",
      from: ["ready", "failed"],
      to: "running",
      by: ["person"],
      guards: [],
    },
    {
      event: "complete",
      from: ["running"],
      to: "ready",
      by: ["system"],
      guards: [],
    },
    {
      event: "cancel",
      from: ["running"],
      to: "cancelling",
      by: ["person"],
      guards: [],
    },
    {
      event: "cancelled",
      from: ["cancelling"],
      to: "ready",
      by: ["system"],
      guards: [],
    },
    {
      event: "ask_permission",
      from: ["running"],
      to: "awaiting_permission",
      by: ["system"],
      guards: [],
    },
    {
      event: "decide_permission",
      from: ["awaiting_permission"],
      to: "running",
      by: ["person"],
      guards: [],
    },
    {
      event: "expire_permission",
      from: ["awaiting_permission"],
      to: "failed",
      by: ["system"],
      guards: ["wait_expired"],
    },
    {
      event: "fail",
      from: ["running", "cancelling"],
      to: "failed",
      by: ["system"],
      guards: [],
    },
    {
      // The model route is unavailable when a queued message is due: the
      // message becomes a failed turn that the person can retry.
      event: "block",
      from: ["ready"],
      to: "failed",
      by: ["system"],
      guards: ["model_route_unavailable"],
    },
  ],
} as const satisfies MachineDefinition;
