import { workspacePortalUrl } from "./portal-links";
/**
 * The one Slack card of a commerce change that waits for approval (Plan 56).
 *
 * The Case posts a fixed notice in the thread when an agent's commerce change
 * waits for an owner or admin. The Connector adds the buttons to that notice:
 * the notice's delivery identity names the action, so no model text can add a
 * button. The decision then updates this card, from Slack or from the Portal,
 * through the outcome delivery of the same action. The thread gets no second
 * message for it.
 *
 * The card's text is a summary and a status, with one blank line between them.
 * The summary holds typed facts of the change. The status is fixed text.
 */

import type { ActionLedgerEntry } from "@purin-labs/authority/actors/action-ledger";
import {
  parseCommerceActionPath,
  type CommerceActionPath,
  type CommerceActionRequest,
} from "../commerce/action-model";
import {
  menuPriceChangeKind,
  type MenuPriceSide,
} from "../commerce/menu-price-action";
import type { CommerceChangeFacts } from "../commerce/contract/approval-card-texts";
import type { Env } from "@purin-labs/kernel/env";
import { decisionCardBlocks, type DecisionCardButton } from "./decision-card";
import { assertNever } from "@purin-labs/std";

const CARD_PARTS = "\n\n";
/** Slack refuses a section with more text than this. */
const SECTION_TEXT_LIMIT = 3_000;

/** The click's action identity; its value is the action nonce. */
export const SLACK_COMMERCE_APPROVE_ACTION = "commerce_action_approve";
export const SLACK_COMMERCE_DECLINE_ACTION = "commerce_action_decline";

/** Where an owner or admin opens one action's approval card. */
export function commerceActionPortalUrl(
  env: Env,
  address: Readonly<{ organisationHandle: string; workspaceHandle: string }>,
  nonce: string,
): string {
  return workspacePortalUrl(
    env,
    address,
    `operations?commerceAction=${encodeURIComponent(nonce)}`,
  );
}

const NO_FACTS: CommerceChangeFacts = {
  title: null,
  fromPriceMinor: null,
  allowedRange: null,
};

/** The summary of one change: a bold first line, and its detail under it. */
export function commerceChangeSummary(
  change: CommerceActionRequest | CommerceActionPath,
  facts: CommerceChangeFacts,
): string {
  const titled = (label: string, fallback: string): string =>
    facts.title === null ? fallback : `${label}: ${facts.title}`;
  switch (change.kind) {
    case "adjust_offer_price":
      return summaryText(
        titled("Change price", "Change a listed price"),
        priceDetail(change.proposedPriceMinor, change.currency, facts),
      );
    case "publish_catalog_listing":
      return summaryText(
        titled("Publish listing", "Publish a catalog listing"),
        null,
      );
    case "update_product_description":
      return summaryText(
        titled("Update description", "Update a product description"),
        null,
      );
    case "attach_tracking":
      return summaryText("Attach a tracking number", change.trackingNumber);
    case "cancel_order":
      return summaryText("Cancel an order and refund it", null);
    case "install_merchant_plugin":
      return summaryText(
        `Install the "${change.title}" plugin`,
        `Version ${change.version}`,
      );
    case "refund_order":
      return summaryText(
        "Refund an order",
        `Refund: ${formatMoney(change.amountMinor, change.currency)}`,
      );
    case "publish_cafe_menu":
      return summaryText(`Publish the menu "${change.menu.name}"`, null);
    case "change_menu_price":
      return summaryText(
        menuPriceChangeKind(change) === "deal"
          ? `Deal on ${change.itemName}`
          : menuPriceChangeKind(change) === "end_deal"
            ? `End the deal on ${change.itemName}`
            : `Change the price of ${change.itemName}`,
        `${menuPriceText(change.before)} → ${menuPriceText(change.after)}`,
      );
    case "stock_operation":
      return summaryText("Change stock or purchasing", change.reason);
    case "submit_supplier_payout":
      return summaryText("Send a supplier payout", null);
    case "resume_supplier_payout_funding":
      return summaryText("Fund a supplier payout", null);
    default:
      return assertNever(change);
  }
}

/** The summary of an action whose approval notice the thread does not hold. */
export function commerceActionSummary(
  action: Parameters<typeof parseCommerceActionPath>[0],
): string {
  const path = parseCommerceActionPath(action);
  return path.ok
    ? commerceChangeSummary(path.value, NO_FACTS)
    : summaryText("A commerce change", null);
}

function priceDetail(
  priceMinor: number,
  currency: string,
  facts: CommerceChangeFacts,
): string {
  const to = formatMoney(priceMinor, currency);
  const change =
    facts.fromPriceMinor === null
      ? `New price: ${to}`
      : `${formatMoney(facts.fromPriceMinor, currency)} → ${to}`;
  return facts.allowedRange === null
    ? change
    : `${change} (allowed range ${formatMoney(facts.allowedRange.minimumMinor, currency)} to ${formatMoney(facts.allowedRange.maximumMinor, currency)})`;
}

/** "¥600", or "¥500 (was ¥600)" for a deal. */
function menuPriceText(side: MenuPriceSide): string {
  const price = formatMoney(side.price.amountMinor, side.price.currency);
  return side.compareAtPrice === null
    ? price
    : `${price} (was ${formatMoney(side.compareAtPrice.amountMinor, side.compareAtPrice.currency)})`;
}

function formatMoney(minor: number, currency: string): string {
  const digits =
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 0;
  const amount = (minor / 10 ** digits).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${amount} ${currency}`;
}

function summaryText(headline: string, detail: string | null): string {
  const first = `*${slackLine(headline)}*`;
  return detail === null ? first : `${first}\n${slackLine(detail)}`;
}

/** One line of Slack text: a merchant's title cannot mention or link. */
function slackLine(text: string): string {
  return text
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

/** The summary part of a card's text. */
export function commerceCardSummary(cardText: string): string {
  return cardText.split(CARD_PARTS, 1)[0] ?? cardText;
}

/** The text of a card that waits for a decision. */
export function commerceWaitingCardText(
  summary: string,
  slackMayApprove: boolean,
): string {
  return `${summary}${CARD_PARTS}${
    slackMayApprove
      ? "Nothing changes until an owner or admin approves it."
      : "Nothing changes until an owner or admin approves it under Operations in the Portal."
  }`;
}

/** The text of a card with the current state of its action. */
export function commerceActionCardText(
  summary: string,
  entry: ActionLedgerEntry,
): string {
  return `${summary}${CARD_PARTS}${commerceActionStatus(entry)}`;
}

function commerceActionStatus(entry: ActionLedgerEntry): string {
  switch (entry.state) {
    case "proposed":
    case "approval_requested":
      return "Nothing changes until an owner or admin approves it.";
    case "signed":
    case "executing":
    case "indeterminate":
      return `${approvedBy(entry)}. The provider has not confirmed the change yet. If this stays, click Check again.`;
    case "confirmed":
      return `${approvedBy(entry)}. Purin Pantry made the change.`;
    case "failed":
      return `${approvedBy(entry)}, but the change failed. Nothing changed. See Operations in the Portal.`;
    case "rejected":
      return `${declinedBy(entry)}. Nothing changed.`;
    case "expired":
      return "This approval expired. Nothing changed.";
    default:
      return assertNever(entry);
  }
}

function approvedBy(
  entry: Pick<ActionLedgerEntry, "updatedAt"> &
    Readonly<{
      approval: Extract<ActionLedgerEntry, { state: "signed" }>["approval"];
    }>,
): string {
  const { approval } = entry;
  return approval.kind === "app_user" &&
    approval.authentication.kind === "slack_verified_link"
    ? `Approved by <@${approval.authentication.slackUserId}>, ${slackTime(entry.updatedAt)}`
    : `Approved in the Portal, ${slackTime(entry.updatedAt)}`;
}

function declinedBy(
  entry: Extract<ActionLedgerEntry, { state: "rejected" }>,
): string {
  const { authentication } = entry.rejection;
  return authentication.kind === "slack_verified_link"
    ? `Declined by <@${authentication.slackUserId}>, ${slackTime(entry.updatedAt)}`
    : `Declined in the Portal, ${slackTime(entry.updatedAt)}`;
}

/** A time that each reader sees in their own time zone. */
function slackTime(at: number): string {
  return `<!date^${Math.floor(at / 1_000)}^{time}|${new Date(at).toISOString()}>`;
}

/** The controls under a card's text. */
type CommerceCardControls =
  | Readonly<{ kind: "decide"; nonce: string; portalUrl: string | null }>
  | Readonly<{ kind: "check_again"; nonce: string; portalUrl: string | null }>
  | Readonly<{ kind: "details"; label: string; portalUrl: string | null }>;

/** The controls that an action's state gives its card. */
export function commerceCardControlsAfterDecision(
  entry: ActionLedgerEntry,
  portalUrl: string | null,
): CommerceCardControls {
  return entry.state === "signed" ||
    entry.state === "indeterminate" ||
    entry.state === "executing"
    ? { kind: "check_again", nonce: entry.action.nonce.value, portalUrl }
    : { kind: "details", label: "Details", portalUrl };
}

export function commerceCardBlocks(
  text: string,
  controls: CommerceCardControls,
): readonly Record<string, unknown>[] {
  return decisionCardBlocks(text.slice(0, SECTION_TEXT_LIMIT), [
    ...decisionButtons(controls),
    ...(controls.portalUrl === null
      ? []
      : [
          {
            kind: "link",
            actionId: "commerce_action_details",
            label: controls.kind === "details" ? controls.label : "Details",
            url: controls.portalUrl,
            primary: false,
          } as const,
        ]),
  ]);
}

function decisionButtons(
  controls: CommerceCardControls,
): readonly DecisionCardButton[] {
  switch (controls.kind) {
    case "decide":
      return [
        {
          kind: "answer",
          actionId: SLACK_COMMERCE_APPROVE_ACTION,
          label: "Approve",
          value: controls.nonce,
          primary: true,
          confirm: {
            title: "Approve this change?",
            text: "Purin Pantry makes the change at once. Only an owner or admin can approve.",
            confirm: "Approve",
            deny: "Cancel",
          },
        },
        {
          kind: "answer",
          actionId: SLACK_COMMERCE_DECLINE_ACTION,
          label: "Decline",
          value: controls.nonce,
          primary: false,
          confirm: {
            title: "Decline this change?",
            text: "Purin Pantry does not make the change. Only an owner or admin can decline.",
            confirm: "Decline",
            deny: "Cancel",
          },
        },
      ];
    case "check_again":
      return [
        {
          kind: "answer",
          actionId: SLACK_COMMERCE_APPROVE_ACTION,
          label: "Check again",
          value: controls.nonce,
          primary: false,
          confirm: null,
        },
      ];
    case "details":
      return [];
    default:
      return assertNever(controls);
  }
}
