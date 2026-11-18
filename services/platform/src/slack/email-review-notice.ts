import type { EmailReviewProjection } from "../data/email-review";
import { assertNever } from "@seams/std";

type SlackEmailReviewNotice = Readonly<{
  deliveryId: string;
  text: string;
}>;

export function buildSlackEmailReviewNotice(
  input: Readonly<{
    review: EmailReviewProjection;
    portalUrl: string;
  }>,
): SlackEmailReviewNotice | null {
  if (input.review.lifecycleKind !== "awaiting_approval") return null;
  const reviewKind = emailReviewKindLabel(input.review.kind);
  const deliveryId = [
    "delivery_email_review",
    input.review.proposalId,
    input.review.version,
  ].join("_");
  return {
    deliveryId,
    text: [
      "*Email review required*",
      `${reviewKind} · Version ${input.review.version} · Awaiting approval`,
      "Sender, recipient, subject, and message content are available only in the authenticated Portal.",
      `<${input.portalUrl}|Review in Portal>`,
    ].join("\n"),
  };
}

function emailReviewKindLabel(kind: EmailReviewProjection["kind"]): string {
  switch (kind) {
    case "gmail_reply":
      return "Gmail reply";
    case "operational_new_message":
      return "Operational email";
    default:
      return assertNever(kind, "Unknown email review kind");
  }
}
