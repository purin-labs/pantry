import type { Env } from "@purin-labs/kernel/env";
import type { BakeProposal } from "@purin-labs/area-kitchen-contract/server/bake-proposals";
import { cardDeliveryIds } from "./card-delivery-ids";
import {
  workspacePortalUrl,
  type PortalWorkspaceAddress,
} from "./portal-links";

/**
 * One Slack card for one bake proposal (Plan 24 S1). The card opens the
 * proposal's thread, and that thread resolves to the proposal's Case. An open
 * proposal shows Approve, Reject and a field for the reason of a rejection; a
 * decision or the end of the bake run updates the same card. The text names
 * only what an admin set and what a person confirmed on the Devices page.
 */

export const BAKE_PROPOSAL_CARD = cardDeliveryIds("bake_proposal");
export const SLACK_BAKE_APPROVE_ACTION = "bake_proposal_approve";
export const SLACK_BAKE_REJECT_ACTION = "bake_proposal_reject";
export const SLACK_BAKE_REASON_BLOCK = "bake_proposal_reason";
export const SLACK_BAKE_REASON_ACTION = "bake_proposal_reason_text";

const SECTION_TEXT_LIMIT = 3_000;

export function bakesPortalUrl(
  env: Env,
  address: PortalWorkspaceAddress,
): string {
  return workspacePortalUrl(env, address, "bakes");
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function decisionLine(proposal: BakeProposal): string {
  const decision = proposal.decision;
  if (decision === null) return "";
  const where = decision.via === "slack" ? "in Slack" : "in the Portal";
  return decision.reason !== null
    ? `Rejected ${where} by a member with the ${decision.role} role. Reason: ${decision.reason ?? ""}`
    : `Approved ${where} by a member with the ${decision.role} role.`;
}

export function bakeProposalCardText(proposal: BakeProposal): string {
  const lines = [
    `Bake proposal: ${plural(proposal.quantityPieces, "piece", "pieces")} of ${proposal.productName}, in ${plural(proposal.mouldGroups, "mould group", "mould groups")} of ${proposal.piecesPerGroup}.`,
    proposal.origin === "stock"
      ? `The counter stock fell to ${proposal.stockAvailable}, below its level of ${proposal.stockLevel}.`
      : `The Portal chat agent proposed it for a person. The counter stock was ${proposal.stockAvailable}, and its level is ${proposal.stockLevel}.`,
    `Recipe: ${proposal.workflowId}, revision ${proposal.workflowRevision}.`,
    proposal.oven === null
      ? `Oven: none. No active oven with the bake capability is enrolled at ${proposal.kitchenLocation}, so this bake cannot be approved.`
      : `Oven: ${proposal.oven.name} at ${proposal.kitchenLocation}.`,
  ];
  switch (proposal.state) {
    case "waiting":
    case "open":
      lines.push(
        "An operator, an admin or the owner approves or rejects it. To reject it, type the reason first.",
      );
      break;
    case "approved":
    case "rejected":
      lines.push(decisionLine(proposal));
      break;
    case "ended":
      // The end names what happened: the check, the stop or the shadow run.
      lines.push(
        decisionLine(proposal),
        proposal.endReason ?? "The bake run ended.",
      );
      break;
  }
  return lines.join("\n");
}

export function bakeProposalCardBlocks(
  text: string,
  proposalId: string | null,
  portalUrl: string | null,
): readonly Record<string, unknown>[] {
  const link =
    portalUrl === null
      ? []
      : [
          {
            type: "button",
            action_id: "bake_proposal_open",
            text: { type: "plain_text", text: "Open Bakes" },
            url: portalUrl,
          },
        ];
  const section = {
    type: "section",
    text: {
      type: "plain_text",
      text: text.slice(0, SECTION_TEXT_LIMIT),
      emoji: false,
    },
  };
  if (proposalId === null)
    return [
      section,
      ...(link.length === 0 ? [] : [{ type: "actions", elements: link }]),
    ];
  return [
    section,
    {
      type: "input",
      block_id: SLACK_BAKE_REASON_BLOCK,
      optional: true,
      label: { type: "plain_text", text: "Reason for a rejection" },
      element: {
        type: "plain_text_input",
        action_id: SLACK_BAKE_REASON_ACTION,
        max_length: 500,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SLACK_BAKE_APPROVE_ACTION,
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          value: proposalId,
          confirm: {
            title: { type: "plain_text", text: "Approve this bake?" },
            text: {
              type: "plain_text",
              text: "One approval covers the bake run, its load and its unload.",
            },
            confirm: { type: "plain_text", text: "Approve" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
        {
          type: "button",
          action_id: SLACK_BAKE_REJECT_ACTION,
          text: { type: "plain_text", text: "Reject" },
          value: proposalId,
        },
        ...link,
      ],
    },
  ];
}

/** The proposal of an open card's notice, or null for every other delivery. */
export function bakeProposalOfNotice(deliveryId: string): string | null {
  return BAKE_PROPOSAL_CARD.isCard(deliveryId) &&
    BAKE_PROPOSAL_CARD.noticeOfUpdate(deliveryId) === null
    ? deliveryId.slice(BAKE_PROPOSAL_CARD.notice("").length)
    : null;
}
