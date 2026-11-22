import { workspacePortalUrl } from "./portal-links";
import {
  permissionLabels,
  type RequestableCapability,
  type RequestableEntityTypeRead,
} from "../authorization/requestable-capabilities";
import type { Env } from "@purin-labs/kernel/env";
import { decisionCardBlocks } from "./decision-card";

/**
 * The one Slack card of a permission request. Its texts hold catalogue labels
 * only, never model output. An owner or admin allows in the Portal's modal,
 * because Allow changes Access for later turns too, and denies from the card.
 * The decision updates the card, so the thread gets no second message for it.
 */

/** The click's action identity; its value is the request id. */
export const SLACK_PERMISSION_DENY_ACTION = "permission_request_deny";

const NOTICE_DELIVERY = /^delivery_permission_card_([0-9a-f]{32})$/u;
const DECISION_DELIVERY =
  /^delivery_permission_card_(?:allowed|denied)_([0-9a-f]{32})$/u;

/** The request of a permission card's notice, or null for other deliveries. */
export function permissionNoticeRequestId(deliveryId: string): string | null {
  return NOTICE_DELIVERY.exec(deliveryId)?.[1] ?? null;
}

/** The request of a decision that updates a card, or null otherwise. */
export function permissionDecisionRequestId(deliveryId: string): string | null {
  return DECISION_DELIVERY.exec(deliveryId)?.[1] ?? null;
}

export function permissionNoticeDeliveryId(requestId: string): string {
  return `delivery_permission_card_${requestId}`;
}

export function permissionDecisionDeliveryId(
  decision: "allowed" | "denied",
  requestId: string,
): string {
  return `delivery_permission_card_${decision}_${requestId}`;
}

/** The blocks of a card that waits for its decision. */
export function permissionCardBlocks(
  text: string,
  requestId: string,
  portalUrl: string | null,
): readonly Record<string, unknown>[] {
  return decisionCardBlocks(text, [
    ...(portalUrl === null
      ? []
      : [
          {
            kind: "link",
            actionId: "permission_request_review",
            label: "Review and allow",
            url: portalUrl,
            primary: true,
          } as const,
        ]),
    {
      kind: "answer",
      actionId: SLACK_PERMISSION_DENY_ACTION,
      label: "Deny",
      value: requestId,
      primary: false,
      confirm: {
        title: "Deny this request?",
        text: "Sous Chef stops this request. Only an owner or admin can deny.",
        confirm: "Deny",
        deny: "Cancel",
      },
    },
  ]);
}

/** The blocks of a card after its decision: the text, with no buttons. */
export function permissionDecidedCardBlocks(
  text: string,
): readonly Record<string, unknown>[] {
  return decisionCardBlocks(text, []);
}

/** Where an owner or admin decides one request. */
export function permissionRequestPortalUrl(
  env: Env,
  address: Readonly<{ organisationHandle: string; workspaceHandle: string }>,
  requestId: string,
): string {
  return workspacePortalUrl(
    env,
    address,
    `access?permissionRequest=${encodeURIComponent(requestId)}`,
  );
}

export function permissionRequestNoticeText(
  capabilityIds: readonly RequestableCapability[],
  entityTypeReads: readonly RequestableEntityTypeRead[],
): string {
  return `Sous Chef needs permission to ${permissionLabels(capabilityIds, entityTypeReads)} to finish this request. An owner or admin decides under Access in the Portal. Sous Chef continues the request in this thread after it is allowed.`;
}

export function permissionDecisionNoticeText(
  decision: "allow" | "deny",
): string {
  return decision === "allow"
    ? "An owner or admin allowed the permission. Sous Chef continues the request now."
    : "An owner or admin denied the permission. Sous Chef stopped this request.";
}
