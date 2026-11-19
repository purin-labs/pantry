import type { HeldOutputReason } from "../data/held-output-request";
import type { Env } from "../env";
import { requirePublicOrigin } from "../public-origin";
import { noticeCardBlocks } from "./notice-card";

/**
 * The one card that a thread gets about a held answer or a held step. Its
 * texts name no source and no word of the answer. Its button holds the Portal
 * link. The decision updates the card, so no old button stays in the thread.
 */

const HELD_OUTPUT_NOTICE = /^delivery_held_([0-9a-f]{32})$/u;
const HELD_OUTPUT_END = /^delivery_held_end_([0-9a-f]{32})$/u;
const HELD_EFFECT_NOTICE = /^delivery_permission_([0-9a-f]{32})$/u;
const HELD_EFFECT_DECISION =
  /^delivery_permission_(?:allowed|denied)_([0-9a-f]{32})$/u;

/** The request of a held card's notice, or null for other deliveries. */
export function heldNoticeRequestId(deliveryId: string): string | null {
  return (
    HELD_OUTPUT_NOTICE.exec(deliveryId)?.[1] ??
    HELD_EFFECT_NOTICE.exec(deliveryId)?.[1] ??
    null
  );
}

/** The notice that a decision updates, or null for other deliveries. */
export function heldNoticeOfDecision(deliveryId: string): string | null {
  const answer = HELD_OUTPUT_END.exec(deliveryId)?.[1];
  if (answer !== undefined) return `delivery_held_${answer}`;
  const step = HELD_EFFECT_DECISION.exec(deliveryId)?.[1];
  return step === undefined ? null : `delivery_permission_${step}`;
}

/** The blocks of a held card that waits for its decision. */
export function heldCardBlocks(
  text: string,
  portalUrl: string | null,
): readonly Record<string, unknown>[] {
  return noticeCardBlocks(
    text,
    portalUrl === null
      ? null
      : {
          actionId: "held_request_review",
          label: "Review in Portal",
          url: portalUrl,
        },
  );
}

/** Where a person decides one held answer. */
export function heldOutputPortalUrl(
  env: Env,
  address: Readonly<{ organisationHandle: string; workspaceHandle: string }>,
  requestId: string,
): string {
  const organisation = encodeURIComponent(address.organisationHandle);
  const workspace = encodeURIComponent(address.workspaceHandle);
  const request = encodeURIComponent(requestId);
  return `${requirePublicOrigin(env.PANTRY_PUBLIC_ORIGIN)}/portal/${organisation}/${workspace}/access?heldOutput=${request}`;
}

export function heldOutputNoticeText(reason: HeldOutputReason): string {
  const why =
    reason === "private_source"
      ? "This answer uses private content, so it waits for approval from a person who can see that content."
      : "This conversation reaches people outside the Organisation, so this answer waits for approval.";
  return `${why} The request shows under Permission requests in the Portal.`;
}

export function heldEffectNoticeText(reason: HeldOutputReason): string {
  const why =
    reason === "private_source"
      ? "The agent stopped one step, because it uses private content. The step waits for approval from a person who can see that content."
      : reason === "outside_written"
        ? "The agent stopped one step, because this thread read text that a person outside the Organisation wrote. The step waits for the person who asked, who sees the exact step before it runs."
        : "The agent stopped one step, because it would send internal content to someone outside. The step waits for approval.";
  return `${why} The request shows under Permission requests in the Portal.`;
}

export function heldEffectDecisionNoticeText(
  decision: "allow" | "deny" | "expired",
): string {
  switch (decision) {
    case "allow":
      return "A person allowed the step that waited for approval. Sous Chef continues the request now.";
    case "deny":
      return "A person denied the step that waited for approval, so Sous Chef did not do it.";
    case "expired":
      return "Nobody approved the step that waited for approval in seven days, so Sous Chef did not do it.";
  }
}

export function heldOutputEndNoticeText(
  end: "allowed" | "denied" | "expired",
): string {
  switch (end) {
    case "allowed":
      return "A person approved the answer that waited for approval, so Sous Chef sent it in this thread.";
    case "denied":
      return "A person denied the answer that waited for approval, so Sous Chef did not send it.";
    case "expired":
      return "Nobody approved the answer that waited for approval in seven days, so Sous Chef did not send it.";
  }
}
