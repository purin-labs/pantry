import React from "react";

import type { ReviewAction } from "./model";
import { assertNever } from "@purin-labs/std";

export function ReviewPanel(props: {
  readonly review: ReviewAction;
  readonly busy: boolean;
  readonly onClose: React.MouseEventHandler<HTMLButtonElement>;
  readonly onConfirm: React.MouseEventHandler<HTMLButtonElement>;
}): React.ReactNode {
  const heading = React.useRef<HTMLHeadingElement>(null);
  React.useLayoutEffect(focusReview.bind(null, heading), [
    props.review.kind,
    props.review.profile.profile.checkoutProfileId,
    props.review.profile.profile.revision,
  ]);
  return (
    <section
      className="checkout-profile-review"
      role="region"
      aria-labelledby="checkout-profile-review-title"
    >
      <div>
        <h3 id="checkout-profile-review-title" ref={heading} tabIndex={-1}>
          {reviewTitle(props.review)}
        </h3>
        <p>{reviewDescription(props.review)}</p>
      </div>
      <dl>
        <div>
          <dt>Profile</dt>
          <dd>{props.review.profile.profile.name}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>{props.review.profile.profile.revision}</dd>
        </div>
        {props.review.kind === "activate" ? (
          <div>
            <dt>Storefront</dt>
            <dd>{props.review.storefrontId}</dd>
          </div>
        ) : null}
      </dl>
      <div className="checkout-profile-review-actions">
        <button type="button" onClick={props.onClose} disabled={props.busy}>
          Cancel
        </button>
        <button
          type="button"
          className={
            props.review.kind === "retire"
              ? "checkout-profile-danger"
              : undefined
          }
          onClick={props.onConfirm}
          disabled={props.busy}
        >
          {reviewButtonLabel(props.review)}
        </button>
      </div>
    </section>
  );
}

function focusReview(
  heading: React.RefObject<HTMLHeadingElement | null>,
): () => void {
  const trigger = document.activeElement;
  heading.current?.focus({ preventScroll: true });
  heading.current
    ?.closest("section")
    ?.scrollIntoView({ block: "start", behavior: "auto" });
  return restoreReviewFocus.bind(null, trigger);
}

function restoreReviewFocus(trigger: Element | null): void {
  if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
}

function reviewTitle(review: ReviewAction): string {
  switch (review.kind) {
    case "publish":
      return "Publish this profile?";
    case "activate":
      return "Activate this revision?";
    case "retire":
      return "Retire this profile?";
    default:
      return assertNever(review, "Unexpected checkout profile review");
  }
}

function reviewDescription(review: ReviewAction): string {
  switch (review.kind) {
    case "publish":
      return "Publishing locks this revision. Then a storefront can use it.";
    case "activate":
      return "New checkouts use this revision. Open carts and checkouts keep their revision.";
    case "retire":
      return "A retired profile cannot be activated again. Open checkouts stay valid.";
    default:
      return assertNever(review, "Unexpected checkout profile review");
  }
}

function reviewButtonLabel(review: ReviewAction): string {
  switch (review.kind) {
    case "publish":
      return "Publish revision";
    case "activate":
      return "Activate revision";
    case "retire":
      return "Retire profile";
    default:
      return assertNever(review, "Unexpected checkout profile review");
  }
}
