import type { SlackMessageTrigger } from "./events";

/**
 * Recognising a request to see supplier payouts in Slack.
 *
 * Only reads are recognised. There is deliberately no phrasing that approves,
 * sends, or cancels a payout: a chat message is not an approval surface, and a
 * command that moved money on a text match would make "pay supplier 3" a
 * sentence someone could say by accident.
 */
export type SupplierPayoutQuery =
  /** Everything whose outcome Pantry does not yet know. */
  | Readonly<{ kind: "outstanding" }>
  /** One supplier's history. */
  | Readonly<{ kind: "supplier"; supplierId: string }>;

type SlackPayoutCommandCandidate = Readonly<{
  trigger: SlackMessageTrigger;
  text: string;
}>;

const SLACK_MENTION = String.raw`(?:<@[A-Z0-9]+(?:\|[^>\r\n]+)?>|@[A-Za-z0-9._-]+)`;
const LEAD = String.raw`^(?:${SLACK_MENTION}[ \t]+)?(?:(?:please|pls)[ \t]+)?`;

/**
 * "what do we owe suppliers", "show outstanding payouts", "supplier payouts".
 *
 * Kept narrow on purpose. A loose pattern that fired on any sentence containing
 * "payout" would answer questions nobody asked, in a channel that may have
 * people in it who should not see what a merchant pays its suppliers.
 */
const OUTSTANDING_PATTERN = new RegExp(
  [
    LEAD,
    String.raw`(?:(?:can|could|would|will)[ \t]+you[ \t]+)?`,
    String.raw`(?:show|list|what(?:'s| is| are)?)[ \t]+`,
    String.raw`(?:the[ \t]+)?`,
    String.raw`(?:outstanding[ \t]+|pending[ \t]+|open[ \t]+)?`,
    String.raw`supplier[ \t]+payouts?`,
    String.raw`[.!?]*$`,
  ].join(""),
  "i",
);

const SUPPLIER_PATTERN = new RegExp(
  [
    LEAD,
    String.raw`(?:(?:can|could|would|will)[ \t]+you[ \t]+)?`,
    String.raw`(?:show|list)[ \t]+`,
    String.raw`(?:the[ \t]+)?payouts?[ \t]+(?:for|to)[ \t]+`,
    String.raw`(supplier_[A-Za-z0-9_-]{1,120})`,
    String.raw`[.!?]*$`,
  ].join(""),
  "i",
);

/**
 * What a Slack message is asking about supplier payouts, if anything.
 *
 * An edit is never a command, for the same reason it is never a stop: acting on
 * an edited message means acting on something whose original a person may have
 * already seen and responded to.
 */
export function parseSupplierPayoutQuery(
  message: SlackPayoutCommandCandidate,
): SupplierPayoutQuery | null {
  if (message.trigger === "edit") return null;
  const text = message.text.trim();
  const supplier = SUPPLIER_PATTERN.exec(text);
  if (supplier !== null && supplier[1] !== undefined) {
    return { kind: "supplier", supplierId: supplier[1] };
  }
  return OUTSTANDING_PATTERN.test(text) ? { kind: "outstanding" } : null;
}
