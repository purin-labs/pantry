import type { MachineDefinition } from "@purin-labs/std/state-machine";

/**
 * The Slack receipt of one paid online order (Refactor 15). The shop's feed
 * records the receipt as `pending` and goes on to the next event, so a Slack
 * connection that is missing, disabled or refused never holds the order
 * queue or the stock. The feed tries the receipt once at once; the
 * `paid_receipts` pass of the every-minute schedule tries each due receipt
 * again. The Connector delivery keeps one Slack message for each receipt.
 */
export const PAID_RECEIPT_MACHINE = {
  name: "paid_receipt",
  owner: "services/platform/src/commerce/paid-receipt.ts",
  store: { table: "paid_receipt", key: "receipt_id", column: "state" },
  states: {
    pending: {
      kind: "initial",
      meaning:
        "The feed recorded the receipt and no attempt has an outcome yet.",
      exit: { kind: "due", reconciler: "paid_receipts", afterMs: 60_000 },
    },
    failed: {
      kind: "intermediate",
      meaning:
        "The last attempt did not reach Slack, for the stored reason. The next attempt waits from one minute, doubled to 15 minutes.",
      exit: { kind: "due", reconciler: "paid_receipts", afterMs: 15 * 60_000 },
    },
    sent: {
      kind: "terminal",
      meaning: "Slack has the receipt: the Connector delivered it once.",
    },
    abandoned: {
      kind: "terminal",
      meaning:
        "The Connector refused the receipt for good, or it was not sent within a day. Staff see the order in the queue.",
    },
  },
  transitions: [
    {
      event: "send",
      from: ["pending", "failed"],
      to: "sent",
      by: ["feed", "retry_pass"],
      guards: [],
    },
    {
      event: "fail",
      from: ["pending", "failed"],
      to: "failed",
      by: ["feed", "retry_pass"],
      guards: [],
    },
    {
      event: "refuse",
      from: ["pending", "failed"],
      to: "abandoned",
      by: ["feed", "retry_pass"],
      guards: [],
    },
    {
      event: "expire",
      from: ["pending", "failed"],
      to: "abandoned",
      by: ["retry_pass"],
      guards: ["lifetime_ended"],
    },
  ],
} as const satisfies MachineDefinition;
