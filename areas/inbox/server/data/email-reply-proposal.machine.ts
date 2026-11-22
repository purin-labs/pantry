import type { MachineDefinition } from "@purin-labs/std/state-machine";

/**
 * One version of an email reply proposal (Refactor 15). The Case owns the
 * lifecycle in `case_email_proposal`; the Portal queue's
 * `email_reply_proposal` row is a copy that the projection moves only by a
 * move that this machine allows, and only forward in version order. No move
 * returns to an earlier state, so a stored state orders the writes of one
 * version.
 */
export const EMAIL_REPLY_PROPOSAL_MACHINE = {
  name: "email_reply_proposal",
  owner: "areas/inbox/server/actors/case-inbox/email-proposals.ts",
  store: {
    table: "case_email_proposal",
    key: "proposal_id",
    column: "payload",
    path: "$.lifecycle.kind",
    since: "json_extract(payload, '$.createdAt')",
  },
  states: {
    draft_creation_indeterminate: {
      kind: "initial",
      meaning: "Gmail did not answer if it created the draft.",
      exit: { kind: "due", reconciler: "email_reply_turn", afterMs: 3_600_000 },
    },
    awaiting_approval: {
      kind: "initial",
      meaning: "The draft waits for a person to send, edit or reject it.",
      exit: { kind: "person", surface: "mail_inbox_reply_review" },
    },
    approved: {
      kind: "intermediate",
      meaning: "A person approved this snapshot, and the send follows.",
      exit: { kind: "person", surface: "mail_inbox_reply_review" },
    },
    send_indeterminate: {
      kind: "intermediate",
      meaning:
        "Gmail did not answer if it sent the reply. The Message-ID resolves it, or a person attests it.",
      exit: {
        kind: "due",
        reconciler: "email_maintenance",
        afterMs: 3_600_000,
      },
    },
    sent: { kind: "terminal", meaning: "Gmail sent the reply." },
    operator_attested_present: {
      kind: "terminal",
      meaning: "A person saw the uncertain reply in the sent mail.",
    },
    operator_attested_absent: {
      kind: "terminal",
      meaning: "A person saw that the uncertain reply was not sent.",
    },
    proposal_missing: {
      kind: "terminal",
      meaning: "The Gmail draft is gone.",
    },
    invalidated: {
      kind: "terminal",
      meaning: "The target or the content no longer allows the reply.",
    },
    rejected: { kind: "terminal", meaning: "A person rejected the reply." },
    expired: {
      kind: "terminal",
      meaning: "Nobody sent the reply before it expired.",
    },
    superseded: {
      kind: "terminal",
      meaning: "A later version of the reply replaced this one.",
    },
    revoked: {
      kind: "terminal",
      meaning: "The mailbox access behind the reply ended.",
    },
  },
  transitions: [
    {
      event: "await_approval",
      from: ["draft_creation_indeterminate", "awaiting_approval"],
      to: "awaiting_approval",
      by: ["system"],
      guards: [],
    },
    {
      event: "approve",
      from: ["awaiting_approval", "approved"],
      to: "approved",
      by: ["person"],
      guards: [],
    },
    {
      event: "send",
      from: ["awaiting_approval", "approved", "send_indeterminate"],
      to: "sent",
      by: ["system", "provider"],
      guards: [],
    },
    {
      event: "send_uncertain",
      from: ["awaiting_approval", "approved", "send_indeterminate"],
      to: "send_indeterminate",
      by: ["system", "provider"],
      guards: [],
    },
    {
      event: "attest_present",
      from: ["send_indeterminate"],
      to: "operator_attested_present",
      by: ["person"],
      guards: [],
    },
    {
      event: "attest_absent",
      from: ["send_indeterminate"],
      to: "operator_attested_absent",
      by: ["person"],
      guards: [],
    },
    {
      event: "lose_draft",
      from: ["draft_creation_indeterminate", "awaiting_approval", "approved"],
      to: "proposal_missing",
      by: ["system", "provider"],
      guards: [],
    },
    {
      event: "invalidate",
      from: ["awaiting_approval", "approved"],
      to: "invalidated",
      by: ["system"],
      guards: [],
    },
    {
      event: "reject",
      from: ["awaiting_approval", "approved"],
      to: "rejected",
      by: ["person"],
      guards: [],
    },
    {
      event: "expire",
      from: ["draft_creation_indeterminate", "awaiting_approval", "approved"],
      to: "expired",
      by: ["clock"],
      guards: [],
    },
    {
      event: "supersede",
      from: ["awaiting_approval", "approved"],
      to: "superseded",
      by: ["person"],
      guards: [],
    },
    {
      event: "revoke",
      from: ["draft_creation_indeterminate", "awaiting_approval", "approved"],
      to: "revoked",
      by: ["system"],
      guards: [],
    },
  ],
} as const satisfies MachineDefinition;
