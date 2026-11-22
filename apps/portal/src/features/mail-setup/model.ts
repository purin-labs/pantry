import type {
  MailboxModelReview,
  MailboxSetupPlan,
} from "@purin-labs/control-api";

/** What the page knows of a mailbox's setup. */
export type MailboxSetupState =
  /** The person cannot change the mailbox, so the page reads no setup. */
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "ready"; plan: MailboxSetupPlan }>;

/**
 * The review whose terms the person must accept before new mail goes to the
 * model, or null when no acceptance is asked.
 */
export function mailboxModelConsent(
  plan: MailboxSetupPlan,
): MailboxModelReview | null {
  return plan.model.kind === "consent_needed" ? plan.model.review : null;
}

/**
 * Turn on makes every change that the setup names and turns the mailbox on,
 * in one press. Only the AI model can hold it back: Purin must have reviewed
 * it for email, and the person accepts its data terms with the checkbox.
 * `accepted` is the review that the checkbox accepted, if any.
 */
export function mailboxCanTurnOn(
  plan: MailboxSetupPlan,
  accepted: MailboxModelReview | null,
): boolean {
  switch (plan.model.kind) {
    case "approved":
      return true;
    case "consent_needed":
      return accepted !== null && sameModelReview(plan.model.review, accepted);
    case "not_reviewed":
    case "unavailable":
      return false;
  }
}

/** The checkbox accepted this review, and not an earlier one. */
export function sameModelReview(
  left: MailboxModelReview,
  right: MailboxModelReview,
): boolean {
  return (
    left.keySource === right.keySource &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.termsUrl === right.termsUrl &&
    left.reviewExpiresAt === right.reviewExpiresAt
  );
}

/** The sentence under Turn on: what a press does, or what holds it back. */
export function turnOnHint(plan: MailboxSetupPlan): string {
  switch (plan.model.kind) {
    case "approved":
    case "consent_needed":
      return `${plan.agent.name} sends routine replies and keeps sensitive ones as drafts for your approval in Inbox. Owners and admins can also read this mailbox in Pantry.`;
    case "not_reviewed":
      return `Purin has not reviewed ${plan.model.name} for email yet.`;
    case "unavailable":
      return "Connect an AI model under AI account first.";
  }
}
