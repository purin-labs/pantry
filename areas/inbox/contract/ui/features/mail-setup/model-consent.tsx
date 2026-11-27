import React from "react";
import type {
  MailboxModelReview,
  MailboxSetupPlan,
} from "@purin-labs/control-api";

import { mailboxModelConsent, sameModelReview } from "./model";

/**
 * The checkbox beside Turn on. The person accepts that new emails go to the
 * reviewed model under its data terms. It names the model, who receives the
 * mail and the terms, so the acceptance is exact.
 */
export function MailboxModelConsent(props: {
  readonly review: MailboxModelReview;
  readonly accepted: boolean;
  readonly disabled: boolean;
  readonly onChange: (accepted: boolean) => void;
}): React.ReactNode {
  const { review } = props;
  return (
    <label className="checkbox-label mailbox-model-consent">
      <input
        type="checkbox"
        checked={props.accepted}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span>
        New emails go to {review.name} through {review.recipients}, under their{" "}
        <a href={review.termsUrl} target="_blank" rel="noreferrer">
          data terms
        </a>
        . No one trains a model on them.
      </span>
    </label>
  );
}

type MailboxModelConsentControl = Readonly<{
  /** The review that the setup asks the person to accept, if any. */
  review: MailboxModelReview | null;
  /** The review that the checkbox accepted. Null while it is clear. */
  accepted: MailboxModelReview | null;
  setAccepted: (accepted: boolean) => void;
}>;

/**
 * The checkbox's state for one setup. A new review, or a new model, clears
 * the checkbox: the person accepts only the terms that the page shows.
 */
export function useMailboxModelConsent(
  plan: MailboxSetupPlan | null,
): MailboxModelConsentControl {
  const review = plan === null ? null : mailboxModelConsent(plan);
  const [checked, setChecked] = React.useState<MailboxModelReview | null>(null);
  const accepted =
    review !== null && checked !== null && sameModelReview(review, checked)
      ? review
      : null;
  const setAccepted = React.useCallback(
    (next: boolean) => setChecked(next ? review : null),
    [review],
  );
  return { review, accepted, setAccepted };
}
