import { DecisionButtons } from "../../ui";
import React from "react";
import { Notice, StatusChip, formatRelativeTime } from "../../page-components";
import { formatAbsoluteTime } from "../../formatting";
import type { EmailReplyMemory } from "@purin-labs/control-api/portal/agent-mailbox";
import { emailReplyIsOpenable, emailReplyLifecycleStatus } from "../../pages/agent-mailbox";
import type { EmailOperationalPreviewResult, EmailOperationalQueueItem, EmailReplyPreviewResult, EmailReplyQueueItem } from "@purin-labs/control-api/portal/agent-mailbox";
import type { EmailReviewActions } from "./api";
import type { EmailReviewQueue } from "@purin-labs/control-api/portal/email-review";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

export type EmailReviewMutation =
  | Readonly<{
      kind: "reply";
      proposalId: string;
      operation: "approve" | "reject" | "resolve";
    }>
  | Readonly<{
      kind: "operational";
      proposalId: string;
      operation: "approve" | "reject" | "edit" | "attest";
    }>;

type EmailReviewSurfaceProps = Readonly<{
  queue: EmailReviewQueue;
  canManage: boolean;
  context: "workspace" | "conversation";
  actions: EmailReviewActions;
  isBusy?: (mutation: EmailReviewMutation) => boolean;
  feedback?: (mutation: EmailReviewMutation) => string | null;
  onChanged?: () => Promise<void>;
}>;

type PreviewState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "loading";
      readonly proposalId: string;
      readonly proposalKind: "reply" | "operational";
    }
  | {
      readonly kind: "reply";
      readonly proposalId: string;
      readonly result: EmailReplyPreviewResult;
    }
  | {
      readonly kind: "operational";
      readonly proposalId: string;
      readonly result: EmailOperationalPreviewResult;
    }
  | {
      readonly kind: "failed";
      readonly proposalId: string;
      readonly proposalKind: "reply" | "operational";
      readonly message: string;
    };

type LocalMutationState =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly mutation: EmailReviewMutation }
  | {
      readonly kind: "failed";
      readonly mutation: EmailReviewMutation;
      readonly message: string;
    };

export function EmailReviewSurface(
  props: EmailReviewSurfaceProps,
): React.ReactNode {
  const [preview, setPreview] = React.useState<PreviewState>({ kind: "idle" });
  const [localMutation, setLocalMutation] = React.useState<LocalMutationState>({
    kind: "idle",
  });
  const previousPreview = React.useRef<string | null>(null);
  React.useLayoutEffect(focusReplyReview.bind(null, preview, previousPreview), [
    preview,
  ]);
  const replies = props.queue.replies.filter(isVisibleReply);
  const operational = props.queue.operational.filter(isVisibleOperational);
  if (replies.length === 0 && operational.length === 0) {
    return props.context === "workspace" ? (
      <div className="integration-setup">
        <h4>Email approvals</h4>
        <p className="notice-text">
          No email is waiting for review. Inbox keeps the replies that were sent
          or closed.
        </p>
      </div>
    ) : null;
  }
  return (
    <section
      className={
        props.context === "workspace"
          ? "integration-setup"
          : "chat-email-review"
      }
      aria-labelledby={`email-review-${props.context}-title`}
    >
      <div className="setup-heading">
        <div>
          <h3 id={`email-review-${props.context}-title`}>Review email</h3>
          <p>
            Check the exact recipients, subject, and message before Gmail sends
            it.
          </p>
        </div>
      </div>
      {localMutation.kind === "running" ? (
        <p className="notice-text" role="status">
          Updating the email review…
        </p>
      ) : null}
      {replies.map(
        renderReply.bind(
          null,
          props,
          preview,
          setPreview,
          localMutation,
          setLocalMutation,
        ),
      )}
      {operational.map(
        renderOperational.bind(
          null,
          props,
          preview,
          setPreview,
          localMutation,
          setLocalMutation,
        ),
      )}
    </section>
  );
}

/** Only a reply that needs a person is here. Inbox keeps the closed ones. */
function isVisibleReply(reply: EmailReplyQueueItem): boolean {
  return (
    emailReplyIsOpenable(reply.lifecycleKind) ||
    reply.lifecycleKind === "send_indeterminate"
  );
}

function isVisibleOperational(proposal: EmailOperationalQueueItem): boolean {
  return (
    proposal.lifecycleKind === "awaiting_approval" ||
    proposal.lifecycleKind === "send_indeterminate"
  );
}

function focusReplyReview(
  preview: PreviewState,
  previous: React.RefObject<string | null>,
): void {
  if (
    preview.kind === "reply" ||
    (preview.kind === "failed" && preview.proposalKind === "reply")
  ) {
    previous.current = preview.proposalId;
    const card = document.getElementById(`email-review-${preview.proposalId}`);
    const heading = card?.querySelector<HTMLElement>(
      "[data-email-preview-heading]",
    );
    (heading ?? card)?.focus();
  } else if (preview.kind === "idle" && previous.current !== null) {
    document
      .getElementById(`email-review-${previous.current}`)
      ?.querySelector<HTMLButtonElement>("[data-email-review-open]")
      ?.focus();
    previous.current = null;
  }
}

function renderReply(
  props: EmailReviewSurfaceProps,
  preview: PreviewState,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  localMutation: LocalMutationState,
  setLocalMutation: React.Dispatch<React.SetStateAction<LocalMutationState>>,
  reply: EmailReplyQueueItem,
): React.ReactNode {
  const open =
    preview.kind !== "idle" && preview.proposalId === reply.proposalId;
  const resolveMutation: EmailReviewMutation = {
    kind: "reply",
    proposalId: reply.proposalId,
    operation: "resolve",
  };
  return (
    <article
      key={reply.proposalId}
      className="connection-card email-review-card"
      id={`email-review-${reply.proposalId}`}
      tabIndex={-1}
    >
      <div className="connection-head">
        <div>
          <h4>
            {reply.headline === null
              ? "Reply draft"
              : reply.headline.subject || "No subject"}
          </h4>
          <p>
            {reply.headline === null
              ? null
              : `From ${reply.headline.senderName} · `}
            Updated {formatRelativeTime(reply.updatedAt)}
          </p>
        </div>
        <StatusChip status={emailReplyLifecycleStatus(reply.lifecycleKind)} />
      </div>
      {open
        ? renderReplyPreview(
            props,
            preview,
            setPreview,
            localMutation,
            setLocalMutation,
            reply,
          )
        : null}
      {emailReplyIsOpenable(reply.lifecycleKind) && !open ? (
        <div className="connection-actions">
          <button
            type="button"
            data-proposal-id={reply.proposalId}
            data-email-review-open
            onClick={openReplyPreview.bind(null, props.actions, setPreview)}
            disabled={localMutation.kind === "running"}
          >
            Review reply
          </button>
        </div>
      ) : null}
      {reply.lifecycleKind === "send_indeterminate" && props.canManage ? (
        <div className="connection-actions">
          <p className="notice-text">
            Gmail did not confirm this send. Seams Pantry will not retry it.
            Check the exact message in Gmail before reconciling.
          </p>
          <button
            type="button"
            onClick={resolveReply.bind(
              null,
              props,
              setPreview,
              setLocalMutation,
              reply,
              resolveMutation,
            )}
            disabled={reviewMutationBusy(props, localMutation, resolveMutation)}
          >
            Check send state in Gmail
          </button>
        </div>
      ) : null}
      {renderProposalFeedback(props, localMutation, "reply", reply.proposalId)}
    </article>
  );
}

async function openReplyPreview(
  actions: EmailReviewActions,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  const proposalId = event.currentTarget.dataset.proposalId;
  if (proposalId === undefined) return;
  await loadReplyPreview(actions, setPreview, proposalId);
}

async function loadReplyPreview(
  actions: EmailReviewActions,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  proposalId: string,
): Promise<void> {
  setPreview({ kind: "loading", proposalId, proposalKind: "reply" });
  let loaded: PreviewState;
  try {
    const result = await actions.loadEmailReply(proposalId);
    loaded = { kind: "reply", proposalId, result };
  } catch (error) {
    loaded = {
      kind: "failed",
      proposalId,
      proposalKind: "reply",
      message: reviewProblem(error),
    };
  }
  setPreview(settleReplyLoad.bind(null, loaded, proposalId));
}

/** A load that the reader left for another proposal changes nothing. */
function settleReplyLoad(
  loaded: PreviewState,
  proposalId: string,
  current: PreviewState,
): PreviewState {
  return current.kind === "loading" && current.proposalId === proposalId
    ? loaded
    : current;
}

function renderReplyPreview(
  props: EmailReviewSurfaceProps,
  preview: PreviewState,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  localMutation: LocalMutationState,
  setLocalMutation: React.Dispatch<React.SetStateAction<LocalMutationState>>,
  reply: EmailReplyQueueItem,
): React.ReactNode {
  if (preview.kind === "loading" && preview.proposalKind === "reply") {
    return <p role="status">Fetching the current draft from Gmail…</p>;
  }
  if (preview.kind === "failed" && preview.proposalKind === "reply") {
    return (
      <div className="email-reply-preview">
        <p className="error-text" role="alert">
          {preview.message}
        </p>
        <button type="button" onClick={closePreview.bind(null, setPreview)}>
          Close
        </button>
      </div>
    );
  }
  if (preview.kind !== "reply") return null;
  return renderLoadedReply(
    props,
    preview.result,
    setPreview,
    localMutation,
    setLocalMutation,
    reply,
  );
}

function renderLoadedReply(
  props: EmailReviewSurfaceProps,
  result: EmailReplyPreviewResult,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  localMutation: LocalMutationState,
  setLocalMutation: React.Dispatch<React.SetStateAction<LocalMutationState>>,
  reply: EmailReplyQueueItem,
): React.ReactNode {
  switch (result.kind) {
    case "proposal_missing":
      return renderUnavailablePreview(
        "The Gmail draft is gone, so there is nothing to approve.",
        setPreview,
      );
    case "invalidated":
      return renderUnavailablePreview(
        result.reason === "unsupported_content"
          ? "The Gmail draft gained an attachment or rich content, which cancelled this proposal."
          : "A recipient, subject, or thread changed in Gmail, which cancelled this proposal.",
        setPreview,
      );
    case "expired":
      return renderUnavailablePreview(
        "This proposal expired before approval.",
        setPreview,
      );
    case "current": {
      const approveMutation: EmailReviewMutation = {
        kind: "reply",
        proposalId: reply.proposalId,
        operation: "approve",
      };
      const rejectMutation: EmailReviewMutation = {
        kind: "reply",
        proposalId: reply.proposalId,
        operation: "reject",
      };
      const busy =
        reviewMutationBusy(props, localMutation, approveMutation) ||
        reviewMutationBusy(props, localMutation, rejectMutation);
      return (
        <div className="email-reply-preview">
          <h5 data-email-preview-heading tabIndex={-1}>
            Reply preview
          </h5>
          <dl className="integration-account-details">
            <div>
              <dt>To</dt>
              <dd>{result.proposal.to}</dd>
            </div>
            <div>
              <dt>Subject</dt>
              <dd>{result.proposal.subject}</dd>
            </div>
            <div>
              <dt>Thread</dt>
              <dd>{result.proposal.gmailThreadId}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>
                {result.proposal.version}
                {result.proposal.bodyEdited
                  ? " (body changed since the saved version)"
                  : ""}
              </dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{formatAbsoluteTime(result.proposal.expiresAt)}</dd>
            </div>
          </dl>
          {result.proposal.bodyEdited ? (
            <Notice tone="warning" announcement="none">
              The draft body changed after the saved version. Approval sends the
              exact text shown here.
            </Notice>
          ) : null}
          <pre className="email-reply-body">{result.proposal.body}</pre>
          <EmailReplyMemoryList memory={result.memory} />
          <p className="notice-text">
            Changing a recipient, subject, or thread in Gmail cancels this
            proposal.
          </p>
          <div className="connection-actions">
            {props.canManage ? (
              <>
                <DecisionButtons
                  disabled={busy}
                  allow={{
                    label: "Approve and send",
                    className: "connection-primary-action",
                    onSelect: approveReply.bind(
                      null,
                      props,
                      setPreview,
                      setLocalMutation,
                      result,
                      approveMutation,
                    ),
                  }}
                  refuse={{
                    label: "Reject",
                    onSelect: rejectReply.bind(
                      null,
                      props,
                      setPreview,
                      setLocalMutation,
                      reply,
                      rejectMutation,
                    ),
                  }}
                />
              </>
            ) : null}
            <a
              href={`https://mail.google.com/mail/#all/${encodeURIComponent(result.proposal.gmailThreadId)}`}
              target="_blank"
              rel="noreferrer"
            >
              Open in Gmail
            </a>
            <button type="button" onClick={closePreview.bind(null, setPreview)}>
              Close
            </button>
          </div>
        </div>
      );
    }
    default:
      return assertNever(result, "Unexpected email review state");
  }
}

async function approveReply(
  props: EmailReviewSurfaceProps,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  setLocalMutation: React.Dispatch<React.SetStateAction<LocalMutationState>>,
  result: Variant<EmailReplyPreviewResult, "current">,
  mutation: EmailReviewMutation,
): Promise<void> {
  await performMutation(
    props,
    setPreview,
    setLocalMutation,
    mutation,
    props.actions.approveEmailReply.bind(null, result.proposal.proposalId, {
      version: result.proposal.version,
      snapshotDigest: result.proposal.snapshotDigest,
      challenge: result.challenge,
    }),
  );
}

async function rejectReply(
  props: EmailReviewSurfaceProps,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  setLocalMutation: React.Dispatch<React.SetStateAction<LocalMutationState>>,
  reply: EmailReplyQueueItem,
  mutation: EmailReviewMutation,
): Promise<void> {
  await performMutation(
    props,
    setPreview,
    setLocalMutation,
    mutation,
    props.actions.rejectEmailReply.bind(null, reply.proposalId),
  );
}

async function resolveReply(
  props: EmailReviewSurfaceProps,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  setLocalMutation: React.Dispatch<React.SetStateAction<LocalMutationState>>,
  reply: EmailReplyQueueItem,
  mutation: EmailReviewMutation,
): Promise<void> {
  await performMutation(
    props,
    setPreview,
    setLocalMutation,
    mutation,
    props.actions.resolveEmailReply.bind(null, reply.proposalId, reply.version),
  );
}

function renderOperational(
  props: EmailReviewSurfaceProps,
  preview: PreviewState,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  localMutation: LocalMutationState,
  setLocalMutation: React.Dispatch<React.SetStateAction<LocalMutationState>>,
  proposal: EmailOperationalQueueItem,
): React.ReactNode {
  const open =
    preview.kind !== "idle" && preview.proposalId === proposal.proposalId;
  const attestMutation: EmailReviewMutation = {
    kind: "operational",
    proposalId: proposal.proposalId,
    operation: "attest",
  };
  return (
    <article
      className="email-reply-approval email-review-card"
      id={`email-review-${proposal.proposalId}`}
      key={proposal.proposalId}
      tabIndex={-1}
    >
      <dl className="integration-account-details">
        <div>
          <dt>Target</dt>
          <dd>{operationalTargetLabel(proposal)}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{proposal.version}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            {proposal.lifecycleKind === "send_indeterminate"
              ? "Gmail acceptance indeterminate"
              : "Awaiting approval"}
          </dd>
        </div>
      </dl>
      {proposal.lifecycleKind === "send_indeterminate" ? (
        <>
          <p className="notice-text">
            Gmail did not confirm this send. Seams Pantry will not retry it.
            Check Sent Mail for Message-ID{" "}
            {proposal.indeterminateRfcMessageId ?? "(unavailable)"}.
          </p>
          {props.canManage ? (
            <div className="connection-actions">
              <button
                type="button"
                onClick={attestOperational.bind(
                  null,
                  props,
                  setPreview,
                  setLocalMutation,
                  proposal.proposalId,
                  "present",
                  attestMutation,
                )}
                disabled={reviewMutationBusy(
                  props,
                  localMutation,
                  attestMutation,
                )}
              >
                Found in Sent Mail
              </button>
              <button
                type="button"
                onClick={attestOperational.bind(
                  null,
                  props,
                  setPreview,
                  setLocalMutation,
                  proposal.proposalId,
                  "absent",
                  attestMutation,
                )}
                disabled={reviewMutationBusy(
                  props,
                  localMutation,
                  attestMutation,
                )}
              >
                Not in Sent Mail
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      {proposal.lifecycleKind === "awaiting_approval" && !open ? (
        <div className="connection-actions">
          <button
            type="button"
            data-proposal-id={proposal.proposalId}
            onClick={openOperationalPreview.bind(
              null,
              props.actions,
              setPreview,
            )}
          >
            Review message
          </button>
        </div>
      ) : null}
      {open
        ? renderOperationalPreview(
            props,
            preview,
            setPreview,
            localMutation,
            setLocalMutation,
            proposal,
          )
        : null}
      {renderProposalFeedback(
        props,
        localMutation,
        "operational",
        proposal.proposalId,
      )}
    </article>
  );
}

function operationalTargetLabel(proposal: EmailOperationalQueueItem): string {
  if (proposal.target.kind === "self_test")
    return "Self-test · ownership confirmation required";
  return proposal.target.kind === "customer_contact"
    ? `Customer ${proposal.target.customerId} · contact ${proposal.target.contactId}`
    : `Supplier ${proposal.target.supplierId} · contact ${proposal.target.contactId}`;
}

async function openOperationalPreview(
  actions: EmailReviewActions,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  const proposalId = event.currentTarget.dataset.proposalId;
  if (proposalId === undefined) return;
  setPreview({ kind: "loading", proposalId, proposalKind: "operational" });
  try {
    const result = await actions.loadEmailOperational(proposalId);
    setPreview({ kind: "operational", proposalId, result });
  } catch (error) {
    setPreview({
      kind: "failed",
      proposalId,
      proposalKind: "operational",
      message: reviewProblem(error),
    });
  }
}

function renderOperationalPreview(
  props: EmailReviewSurfaceProps,
  preview: PreviewState,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  localMutation: LocalMutationState,
  setLocalMutation: React.Dispatch<React.SetStateAction<LocalMutationState>>,
  proposal: EmailOperationalQueueItem,
): React.ReactNode {
  if (preview.kind === "loading" && preview.proposalKind === "operational") {
    return <p role="status">Fetching the current proposal…</p>;
  }
  if (preview.kind === "failed" && preview.proposalKind === "operational") {
    return (
      <div className="email-reply-preview">
        <p className="error-text" role="alert">
          {preview.message}
        </p>
        <button type="button" onClick={closePreview.bind(null, setPreview)}>
          Close
        </button>
      </div>
    );
  }
  if (preview.kind !== "operational") return null;
  return renderLoadedOperational(
    props,
    preview.result,
    setPreview,
    localMutation,
    setLocalMutation,
    proposal,
  );
}

function renderLoadedOperational(
  props: EmailReviewSurfaceProps,
  result: EmailOperationalPreviewResult,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  localMutation: LocalMutationState,
  setLocalMutation: React.Dispatch<React.SetStateAction<LocalMutationState>>,
  proposal: EmailOperationalQueueItem,
): React.ReactNode {
  switch (result.kind) {
    case "proposal_missing":
      return renderUnavailablePreview(
        "This proposal is no longer available.",
        setPreview,
      );
    case "expired":
      return renderUnavailablePreview(
        "This proposal expired before approval.",
        setPreview,
      );
    case "target_changed":
      return renderUnavailablePreview(
        "The contact changed or is no longer permitted.",
        setPreview,
      );
    case "content_unavailable":
      return renderUnavailablePreview(
        "The proposal content is no longer available.",
        setPreview,
      );
    case "current": {
      const approveMutation: EmailReviewMutation = {
        kind: "operational",
        proposalId: proposal.proposalId,
        operation: "approve",
      };
      const rejectMutation: EmailReviewMutation = {
        kind: "operational",
        proposalId: proposal.proposalId,
        operation: "reject",
      };
      const editMutation: EmailReviewMutation = {
        kind: "operational",
        proposalId: proposal.proposalId,
        operation: "edit",
      };
      const busy =
        reviewMutationBusy(props, localMutation, approveMutation) ||
        reviewMutationBusy(props, localMutation, rejectMutation) ||
        reviewMutationBusy(props, localMutation, editMutation);
      return (
        <div className="email-reply-preview">
          <dl className="integration-account-details">
            <div>
              <dt>From</dt>
              <dd>{result.proposal.from}</dd>
            </div>
            <div>
              <dt>To</dt>
              <dd>
                {result.proposal.to}
                {result.proposal.recipientDisplayName
                  ? ` (${result.proposal.recipientDisplayName})`
                  : ""}
              </dd>
            </div>
            <div>
              <dt>Subject</dt>
              <dd>{result.proposal.subject}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{result.proposal.version}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{formatAbsoluteTime(result.proposal.expiresAt)}</dd>
            </div>
          </dl>
          <pre className="email-reply-body">{result.proposal.body}</pre>
          {props.canManage ? (
            <form
              className="email-review-edit"
              onSubmit={editOperational.bind(
                null,
                props,
                setPreview,
                setLocalMutation,
                proposal.proposalId,
                editMutation,
              )}
            >
              <label>
                <span>Subject</span>
                <input
                  name="subject"
                  defaultValue={result.proposal.subject}
                  readOnly={result.proposal.target.kind === "self_test"}
                  maxLength={998}
                  required
                />
              </label>
              <label>
                <span>Message</span>
                <textarea
                  name="body"
                  defaultValue={result.proposal.body}
                  readOnly={result.proposal.target.kind === "self_test"}
                  maxLength={20_000}
                  rows={6}
                  required
                />
              </label>
              <div className="connection-actions">
                <button
                  type="submit"
                  disabled={busy || result.proposal.target.kind === "self_test"}
                >
                  Save changes
                </button>
                <DecisionButtons
                  disabled={busy}
                  allow={{
                    label:
                      result.proposal.target.kind === "self_test"
                        ? "Confirm this is my address and send self-test"
                        : "Approve and send",
                    className: "connection-primary-action",
                    onSelect: approveOperational.bind(
                      null,
                      props,
                      setPreview,
                      setLocalMutation,
                      result,
                      approveMutation,
                    ),
                  }}
                  refuse={{
                    label: "Reject",
                    onSelect: rejectOperational.bind(
                      null,
                      props,
                      setPreview,
                      setLocalMutation,
                      proposal.proposalId,
                      rejectMutation,
                    ),
                  }}
                />
              </div>
            </form>
          ) : null}
          <button type="button" onClick={closePreview.bind(null, setPreview)}>
            Close
          </button>
        </div>
      );
    }
    default:
      return assertNever(result, "Unexpected email review state");
  }
}

async function editOperational(
  props: EmailReviewSurfaceProps,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  setLocalMutation: React.Dispatch<React.SetStateAction<LocalMutationState>>,
  proposalId: string,
  mutation: EmailReviewMutation,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const subject = form.get("subject");
  const body = form.get("body");
  if (typeof subject !== "string" || typeof body !== "string") return;
  await performMutation(
    props,
    setPreview,
    setLocalMutation,
    mutation,
    props.actions.editEmailOperational.bind(null, proposalId, subject, body),
  );
}

async function approveOperational(
  props: EmailReviewSurfaceProps,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  setLocalMutation: React.Dispatch<React.SetStateAction<LocalMutationState>>,
  result: Variant<EmailOperationalPreviewResult, "current">,
  mutation: EmailReviewMutation,
): Promise<void> {
  await performMutation(
    props,
    setPreview,
    setLocalMutation,
    mutation,
    props.actions.approveEmailOperational.bind(
      null,
      result.proposal.proposalId,
      {
        version: result.proposal.version,
        snapshotDigest: result.proposal.snapshotDigest,
        challenge: result.challenge,
        ...(result.proposal.target.kind === "self_test"
          ? { selfTestOwnershipConfirmed: true as const }
          : {}),
      },
    ),
  );
}

async function rejectOperational(
  props: EmailReviewSurfaceProps,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  setLocalMutation: React.Dispatch<React.SetStateAction<LocalMutationState>>,
  proposalId: string,
  mutation: EmailReviewMutation,
): Promise<void> {
  await performMutation(
    props,
    setPreview,
    setLocalMutation,
    mutation,
    props.actions.rejectEmailOperational.bind(null, proposalId),
  );
}

async function attestOperational(
  props: EmailReviewSurfaceProps,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  setLocalMutation: React.Dispatch<React.SetStateAction<LocalMutationState>>,
  proposalId: string,
  attestation: "present" | "absent",
  mutation: EmailReviewMutation,
): Promise<void> {
  await performMutation(
    props,
    setPreview,
    setLocalMutation,
    mutation,
    props.actions.attestEmailOperational.bind(null, proposalId, attestation),
  );
}

async function performMutation(
  props: EmailReviewSurfaceProps,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
  setLocalMutation: React.Dispatch<React.SetStateAction<LocalMutationState>>,
  mutation: EmailReviewMutation,
  action: () => Promise<void>,
): Promise<void> {
  setLocalMutation({ kind: "running", mutation });
  try {
    await action();
    setPreview({ kind: "idle" });
    setLocalMutation({ kind: "idle" });
    if (props.onChanged !== undefined) await props.onChanged();
  } catch (error) {
    setPreview({ kind: "idle" });
    setLocalMutation({
      kind: "failed",
      mutation,
      message: reviewProblem(error),
    });
  }
}

function closePreview(
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
): void {
  setPreview({ kind: "idle" });
}

function renderUnavailablePreview(
  message: string,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
): React.ReactNode {
  return (
    <div className="email-reply-preview">
      <p className="notice-text">{message}</p>
      <button type="button" onClick={closePreview.bind(null, setPreview)}>
        Close
      </button>
    </div>
  );
}

function reviewMutationBusy(
  props: EmailReviewSurfaceProps,
  local: LocalMutationState,
  mutation: EmailReviewMutation,
): boolean {
  if (local.kind === "running" && sameMutation(local.mutation, mutation)) {
    return true;
  }
  return props.isBusy?.(mutation) ?? false;
}

function renderProposalFeedback(
  props: EmailReviewSurfaceProps,
  local: LocalMutationState,
  kind: "reply" | "operational",
  proposalId: string,
): React.ReactNode {
  const mutations: readonly EmailReviewMutation[] =
    kind === "reply"
      ? [
          { kind, proposalId, operation: "approve" },
          { kind, proposalId, operation: "reject" },
          { kind, proposalId, operation: "resolve" },
        ]
      : [
          { kind, proposalId, operation: "approve" },
          { kind, proposalId, operation: "reject" },
          { kind, proposalId, operation: "edit" },
          { kind, proposalId, operation: "attest" },
        ];
  for (const mutation of mutations) {
    const localMessage =
      local.kind === "failed" && sameMutation(local.mutation, mutation)
        ? local.message
        : null;
    const message = localMessage ?? props.feedback?.(mutation) ?? null;
    if (message !== null) {
      return (
        <p className="error-text" role="alert">
          {message}
        </p>
      );
    }
  }
  return null;
}

function sameMutation(
  left: EmailReviewMutation,
  right: EmailReviewMutation,
): boolean {
  return (
    left.kind === right.kind &&
    left.proposalId === right.proposalId &&
    left.operation === right.operation
  );
}

function reviewProblem(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The email review action could not be completed. Try again.";
}

/**
 * The accepted memories the agent was shown when it wrote this draft. The
 * list holds only what this person may inspect, and it is absent when the
 * draft used none of them.
 */
function EmailReplyMemoryList(props: {
  readonly memory: readonly EmailReplyMemory[];
}) {
  if (props.memory.length === 0) return null;
  return (
    <section
      className="email-reply-memory"
      aria-label="Memory used for this draft"
    >
      <h6>Memory used for this draft</h6>
      <ul>
        {props.memory.map((memory) => (
          <li key={`${memory.memoryId}:${memory.revision}`}>
            {memory.statement}
          </li>
        ))}
      </ul>
      <p className="notice-text">
        The agent was shown these accepted memories when it wrote the draft.
        Review them on the Brain page.
      </p>
    </section>
  );
}
