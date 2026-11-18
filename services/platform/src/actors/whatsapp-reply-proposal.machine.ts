import type { MachineDefinition } from "@seams/std/state-machine";

/**
 * One version of a WhatsApp reply proposal in the Connector (Refactor 15,
 * refactor 13). The Connector's `connector_whatsapp_proposal` row owns the
 * lifecycle; the Portal queue's `whatsapp_reply_proposal` row is a copy.
 *
 * An approval claims the version as `sending` with a new attempt id before
 * the one call to Meta. Only that attempt settles it, by a compare-and-set
 * on the state and the attempt id, so a move that another writer made during
 * the call (a revoke, a purge) stays. An attempt that does not settle in its
 * lease (the Connector stopped during the call) becomes `send_indeterminate`
 * from the alarm, never `expired`: Pantry cannot prove that Meta did not take
 * the message, so the Case is fenced and a person decides.
 */
export const WHATSAPP_REPLY_PROPOSAL_MACHINE = {
  name: "whatsapp_reply_proposal",
  owner: "services/platform/src/actors/whatsapp-reply-proposal-transition.ts",
  store: {
    table: "connector_whatsapp_proposal",
    key: "proposal_id",
    column: "state",
    since: "updated_at",
  },
  states: {
    awaiting_approval: {
      kind: "initial",
      meaning:
        "The body waits for a person to approve, edit or reject it, inside its approval time and the service window.",
      exit: {
        kind: "due",
        reconciler: "whatsapp_sweep",
        afterMs: 4 * 3_600_000,
      },
    },
    sending: {
      kind: "intermediate",
      meaning:
        "One approved attempt calls Meta. Only that attempt records the outcome.",
      exit: { kind: "due", reconciler: "whatsapp_sweep", afterMs: 60_000 },
    },
    send_indeterminate: {
      kind: "intermediate",
      meaning:
        "Satyr cannot prove if Meta took the message. The Case is fenced until a person states the outcome.",
      exit: { kind: "person", surface: "inbox_whatsapp_reply_review" },
    },
    sent: {
      kind: "terminal",
      meaning: "Meta returned a WhatsApp message id, or a person saw it.",
    },
    rejected: { kind: "terminal", meaning: "A person rejected the body." },
    expired: {
      kind: "terminal",
      meaning:
        "The approval time or the service window ended before a send, or Meta refused a send that came too late.",
    },
    superseded: {
      kind: "terminal",
      meaning: "A newer version or a newer proposal replaced this one.",
    },
    taken_over: {
      kind: "terminal",
      meaning: "A person took the Case over before a send.",
    },
    revoked: {
      kind: "terminal",
      meaning:
        "The Case closed, the number was disabled, or a person stated that the uncertain send did not arrive.",
    },
  },
  transitions: [
    {
      event: "claim",
      from: ["awaiting_approval"],
      to: "sending",
      by: ["approver", "automatic_reply"],
      guards: [],
    },
    {
      event: "provider_accepted",
      from: ["sending"],
      to: "sent",
      by: ["send_attempt"],
      guards: [],
    },
    {
      event: "provider_rejected",
      from: ["sending"],
      to: "awaiting_approval",
      by: ["send_attempt"],
      guards: ["deadlines_open"],
    },
    {
      event: "provider_rejected_late",
      from: ["sending"],
      to: "expired",
      by: ["send_attempt"],
      guards: ["deadlines_passed"],
    },
    {
      event: "outcome_unknown",
      from: ["sending"],
      to: "send_indeterminate",
      by: ["send_attempt"],
      guards: [],
    },
    {
      event: "abandon",
      from: ["sending"],
      to: "send_indeterminate",
      by: ["alarm", "approver"],
      guards: ["attempt_lease_ended"],
    },
    {
      event: "supersede",
      from: ["awaiting_approval"],
      to: "superseded",
      by: ["person", "agent"],
      guards: [],
    },
    {
      event: "expire",
      from: ["awaiting_approval"],
      to: "expired",
      by: ["alarm", "approver", "person"],
      guards: [],
    },
    {
      event: "reject",
      from: ["awaiting_approval"],
      to: "rejected",
      by: ["person"],
      guards: [],
    },
    {
      event: "take_over",
      from: ["awaiting_approval"],
      to: "taken_over",
      by: ["person"],
      guards: [],
    },
    {
      event: "revoke",
      from: ["awaiting_approval", "sending"],
      to: "revoked",
      by: ["person", "system"],
      guards: [],
    },
    {
      event: "operator_saw_delivery",
      from: ["send_indeterminate"],
      to: "sent",
      by: ["person"],
      guards: [],
    },
    {
      event: "operator_saw_no_delivery",
      from: ["send_indeterminate"],
      to: "revoked",
      by: ["person"],
      guards: [],
    },
  ],
} as const satisfies MachineDefinition;
