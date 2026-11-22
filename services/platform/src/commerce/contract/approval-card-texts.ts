import type { ActionLedgerEntry } from "../../actors/action-ledger";
import type { Env } from "@purin-labs/kernel/env";
import { definePort } from "@purin-labs/kernel/port";
import type {
  CommerceActionPath,
  CommerceActionRequest,
  parseCommerceActionPath,
} from "../action-model";

/** What a proposal knows about the record that it changes. */
export type CommerceChangeFacts = Readonly<{
  /** The product's title, when this Session read that product. */
  title: string | null;
  fromPriceMinor: number | null;
  allowedRange: Readonly<{ minimumMinor: number; maximumMinor: number }> | null;
}>;

/**
 * The texts of the one Slack card of a commerce change that waits for
 * approval (Plan 56). Commerce gives the typed facts of the change, and the
 * Slack surface writes the text. The Worker registers the implementation
 * (`worker-ports.ts`).
 */
export type CommerceApprovalCardTexts = Readonly<{
  /** Where an owner or admin opens one action's approval card. */
  portalUrl(
    env: Env,
    address: Readonly<{ organisationHandle: string; workspaceHandle: string }>,
    nonce: string,
  ): string;
  /** The summary of one change: a bold first line, and its detail under it. */
  changeSummary(
    change: CommerceActionRequest | CommerceActionPath,
    facts: CommerceChangeFacts,
  ): string;
  /** The summary of an action whose approval notice the thread does not hold. */
  actionSummary(action: Parameters<typeof parseCommerceActionPath>[0]): string;
  /** The summary part of a card's text. */
  cardSummary(cardText: string): string;
  /** The text of a card that waits for a decision. */
  waitingCardText(summary: string, slackMayApprove: boolean): string;
  /** The text of a card with the current state of its action. */
  actionCardText(summary: string, entry: ActionLedgerEntry): string;
}>;

export const commerceApprovalCardTexts = definePort<CommerceApprovalCardTexts>(
  "commerce_approval_card_texts",
);
