import type { SessionBudgetDimension } from "@purin-labs/contracts";
import type { Env } from "../env";
import { requirePublicOrigin } from "../public-origin";
import { noticeCardBlocks } from "./notice-card";

/**
 * The card that a Slack thread gets when a request stops at an AI budget
 * limit. Its fixed text holds no model output. Its button holds the Portal
 * link.
 */

const NOTICE_DELIVERY_PREFIX = "delivery_budget_";

export function budgetNoticeDeliveryId(ingressId: string): string {
  return `${NOTICE_DELIVERY_PREFIX}${ingressId}`;
}

export function isBudgetNoticeDelivery(deliveryId: string): boolean {
  return deliveryId.startsWith(NOTICE_DELIVERY_PREFIX);
}

export function budgetCardBlocks(
  text: string,
  portalUrl: string | null,
): readonly Record<string, unknown>[] {
  return noticeCardBlocks(
    text,
    portalUrl === null
      ? null
      : {
          actionId: "ai_budget_raise",
          label: "Raise in Portal",
          url: portalUrl,
        },
  );
}

/** Where an owner or admin raises the AI budget, in a dialog. */
export function aiBudgetPortalUrl(
  env: Env,
  address: Readonly<{ organisationHandle: string; workspaceHandle: string }>,
): string {
  const organisation = encodeURIComponent(address.organisationHandle);
  const workspace = encodeURIComponent(address.workspaceHandle);
  return `${requirePublicOrigin(env.PANTRY_PUBLIC_ORIGIN)}/portal/${organisation}/${workspace}/access?aiBudget=raise`;
}

/**
 * A request at its time limit normally stops at its next step and says so in
 * its own answer, and the thread goes on. These notices are for a thread that
 * cannot go on: a request still running long after its time limit, or a
 * thread that used its tokens or tool calls. A raised budget applies to
 * threads that start after the change.
 */
export function budgetStopNoticeText(
  dimension: SessionBudgetDimension,
): string {
  switch (dimension) {
    case "active_wall_ms":
      return `Sous Chef stopped this request because it ran far past the time limit for one request, so this thread cannot go on. Start a new thread to continue. An owner or admin can raise the limit for new threads in the Portal.`;
    case "tokens":
      return `This thread used its AI token budget, so Sous Chef cannot answer here any more. Start a new thread to continue. An owner or admin can raise the budget for new threads in the Portal.`;
    case "capability_calls":
      return `This thread used its budget of tool calls, so Sous Chef cannot answer here any more. Start a new thread to continue. An owner or admin can raise the budget for new threads in the Portal.`;
  }
}
