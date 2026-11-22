import { AgentCursors } from "@purin-labs/collaboration/portal/agent-cursors";
import React from "react";
import { useBlocker, type Blocker } from "react-router";
import { DESCRIPTION_LIMIT } from "@purin-labs/product-description-crdt";
import { DescriptionDraftClient, type DescriptionDraftView } from "./client";
import { DraftParticipants, DraftPresenceOverlay, DraftMousePointers } from "@purin-labs/collaboration/portal/draft-presence";
import { cancelDialog, syncDialog } from "@purin-labs/ui/dialog";
import type {
  CommerceActionRecord,
} from "@purin-labs/commerce-control-api/portal/commerce-actions";
import type { VariantBy } from "@purin-labs/type-utils";
import type { PermissionRequired } from "@purin-labs/control-api";
import { PermissionRequiredPrompt, permissionRequiredOf } from "../../access/permission-required-prompt";
import { assertNever } from "@purin-labs/std";

export type ProductDescriptionSnapshot = Readonly<{
  productId: string;
  title: string;
  description: string;
  revision: number;
}>;

export type ProductDescriptionAction = Readonly<{
  kind: "update_product_description";
  productId: string;
  productRevision: number;
  description: string;
}>;

export type ProductDescriptionActionTransport = Readonly<{
  proposeAction: (
    organisationId: string,
    action: ProductDescriptionAction,
    intent: string,
  ) => Promise<CommerceActionRecord>;
}>;

type EditorProps = Readonly<{
  organisationId: string;
  productId: string;
  currentProductRevision: number;
  currentProduct: ProductDescriptionSnapshot | null;
  canPropose: boolean;
  actionBusy: boolean;
  actionTransport: ProductDescriptionActionTransport | undefined;
  onActionProposed: ((action: CommerceActionRecord) => void) | undefined;
  onReviewRefresh: () => void;
}>;

type DescriptionReview = Readonly<{
  productId: string;
  description: string;
  productDescription: string;
  productRevision: number;
}>;

type DescriptionReviewState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "reviewing"; review: DescriptionReview }>
  | Readonly<{ kind: "submitting"; review: DescriptionReview }>
  | Readonly<{ kind: "submitted"; review: DescriptionReview }>
  | Readonly<{ kind: "failed"; review: DescriptionReview; message: string }>
  | Readonly<{ kind: "permission"; review: DescriptionReview; permission: PermissionRequired }>;

const INITIAL_VIEW: DescriptionDraftView = { kind: "connecting", description: "", participants: [], agents: [], initialization: { kind: "uninitialized" }, readOnly: true };

export default function DescriptionEditor(props: EditorProps): React.ReactNode {
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  const client = React.useRef<DescriptionDraftClient | null>(null);
  const [view, setView] = React.useState<DescriptionDraftView>(INITIAL_VIEW);
  const [reviewState, setReview] = React.useState<DescriptionReviewState>({ kind: "idle" });
  const id = React.useId();
  const blocker = useBlocker(hasUnsyncedDraft.bind(null, client));
  React.useEffect(connectEditor.bind(null, props.organisationId, props.productId, textarea, client, setView), [props.organisationId, props.productId]);
  const metadata = view.initialization.kind === "initialized" ? view.initialization.metadata : null;
  const reviewable = view.kind === "synced" && !view.readOnly && props.currentProduct !== null;
  const proposalReady = props.canPropose && props.actionTransport !== undefined && props.onActionProposed !== undefined;
  const reviewedDescriptionChanged = reviewState.kind !== "idle" && reviewState.review.description !== view.description;
  return <div className="stacked-form description-draft-editor">
    <DraftMousePointers participants={view.participants} />
    <div className="description-draft-editor-header">
      <div>
        <label htmlFor={id}>Shared description</label>
        <p className="description-draft-editor-help" id={`${id}-help`}>Changes sync automatically while this page is open.</p>
      </div>
      <div className="description-draft-editor-status">
        <span className="description-draft-sync-status" data-state={view.kind}>{connectionLabel(view)}</span>
        <DraftParticipants participants={view.participants} />
        <span role="status">{view.agents.map(descriptionAgentLabel).join(" · ")}</span>
      </div>
    </div>
    <div className="description-draft-textarea-wrap">
      <textarea ref={textarea} id={id} name="product-description-draft" rows={8} maxLength={DESCRIPTION_LIMIT}
      defaultValue="" readOnly={view.readOnly} aria-invalid={view.kind === "failed"}
      aria-describedby={`${id}-help ${id}-count ${id}-error`} />
      <DraftPresenceOverlay textarea={textarea} participants={view.participants} />
      <AgentCursors activities={view.agents} target="description" action="Edit description" labelLeft={true} />
    </div>
    <div className="description-draft-editor-footer">
      <p id={`${id}-count`}>{view.description.length.toLocaleString()} / {DESCRIPTION_LIMIT.toLocaleString()} characters</p>
    </div>
    <p className="description-draft-error" id={`${id}-error`}>{view.kind === "failed" ? view.message : ""}</p>
    {metadata !== null && Math.max(props.currentProductRevision, metadata.currentProductRevision) !== metadata.initializedFromProductRevision &&
      <p className="description-draft-source-warning">The product description changed after this draft started. This shared draft is preserved.</p>}
    {metadata?.access === "read" && view.kind !== "failed" && <p className="description-draft-source-warning">You can view this draft. To change it, ask an owner or admin to give you an editing role.</p>}
    <DescriptionReviewPanel
      state={reviewState}
      reviewable={reviewable}
      proposalReady={proposalReady}
      busy={props.actionBusy}
      reviewedDescriptionChanged={reviewedDescriptionChanged}
      onReview={beginDescriptionReview.bind(null, view, props.currentProduct, setReview)}
      onSubmit={submitDescriptionReview.bind(null, props.organisationId, props.actionTransport, props.onActionProposed, props.onReviewRefresh, setReview, reviewState)}
      onRetry={retryDescriptionReview.bind(null, props.organisationId, props.actionTransport, props.onActionProposed, props.onReviewRefresh, reviewState, setReview)}
    />
    {reviewState.kind === "permission" && <PermissionRequiredPrompt organisationId={props.organisationId} permission={reviewState.permission}
      action="Send for approval" grantScope="for this product only"
      onAllowed={submitDescriptionReview.bind(null, props.organisationId, props.actionTransport, props.onActionProposed, props.onReviewRefresh, setReview, { kind: "reviewing", review: reviewState.review })}
      onClose={setReview.bind(null, { kind: "failed", review: reviewState.review, message: "Send for approval needs a permission that was not allowed. The shared draft is preserved." })} />}
    {blocker.state === "blocked" && <DescriptionLeaveDialog blocker={blocker} unsynced={hasUnsyncedDraft(client)} />}
  </div>;
}

function connectEditor(
  organisationId: string,
  productId: string,
  textarea: React.RefObject<HTMLTextAreaElement | null>,
  ref: React.RefObject<DescriptionDraftClient | null>,
  setView: React.Dispatch<React.SetStateAction<DescriptionDraftView>>,
): () => void {
  if (textarea.current === null) return noCleanup;
  const client = new DescriptionDraftClient(organisationId, productId, textarea.current, setView);
  ref.current = client;
  return disconnectEditor.bind(null, ref, client);
}

function disconnectEditor(ref: React.RefObject<DescriptionDraftClient | null>, client: DescriptionDraftClient): void {
  ref.current = null;
  client.dispose();
}

function hasUnsyncedDraft(ref: React.RefObject<DescriptionDraftClient | null>): boolean {
  return ref.current?.hasUnsyncedEdits() ?? false;
}

function DescriptionReviewPanel(props: Readonly<{
  state: DescriptionReviewState;
  reviewable: boolean;
  proposalReady: boolean;
  busy: boolean;
  reviewedDescriptionChanged: boolean;
  onReview: () => void;
  onSubmit: () => void;
  onRetry: () => void;
}>): React.ReactNode {
  const review = props.state.kind === "idle" ? null : props.state.review;
  const submitDisabled = props.busy || props.state.kind === "submitting" || !props.proposalReady;
  return <section className="description-draft-review" aria-labelledby="description-draft-review-title">
    <div className="description-draft-review-heading">
      <div>
        <p className="description-draft-eyebrow">Before it changes</p>
        <h4 id="description-draft-review-title">Review the shared draft</h4>
      </div>
      {props.state.kind === "idle" && <button type="button" className="secondary" disabled={!props.reviewable} onClick={props.onReview}>Review draft</button>}
    </div>
    {props.state.kind === "idle" && <p className="description-draft-muted">Review becomes available after the draft is synced and the current product is loaded.</p>}
    {review !== null && <>
      <div className="description-draft-review-grid">
        <ReviewCopy label="Current product" value={review.productDescription} />
        <ReviewCopy label="Reviewed draft" value={review.description} />
      </div>
      <p className="description-draft-review-revision">Frozen at product revision {review.productRevision}.</p>
      {props.reviewedDescriptionChanged && <p className="description-draft-source-warning">The shared draft changed after this review. Send the frozen version, or review again.</p>}
      {props.state.kind === "failed" && <p className="description-draft-error" role="alert">{props.state.message}</p>}
      {props.state.kind === "submitted" && <p className="description-draft-success" role="status">Proposal ready for approval. The shared draft stays open for further edits.</p>}
      <div className="description-draft-review-actions">
        <button type="button" className="secondary" disabled={props.state.kind === "submitting" || !props.reviewable} onClick={props.onReview}>Review current text again</button>
        {props.state.kind === "failed"
          ? <button type="button" disabled={submitDisabled} onClick={props.onRetry}>Try again</button>
          : props.state.kind === "submitted"
            ? null
            : <button type="button" disabled={submitDisabled} onClick={props.onSubmit}>{props.state.kind === "submitting" ? "Sending…" : "Send for approval"}</button>}
      </div>
      {!props.proposalReady && <p className="description-draft-muted">Approval is available to owners and admins on this workspace.</p>}
    </>}
  </section>;
}

function ReviewCopy(props: Readonly<{ label: string; value: string }>): React.ReactNode {
  return <div className="description-draft-review-copy">
    <p>{props.label}</p>
    <div>{props.value || "No description"}</div>
  </div>;
}

function beginDescriptionReview(
  view: DescriptionDraftView,
  product: ProductDescriptionSnapshot | null,
  setReview: React.Dispatch<React.SetStateAction<DescriptionReviewState>>,
): void {
  if (view.kind !== "synced" || view.readOnly || product === null) return;
  setReview({ kind: "reviewing", review: {
    productId: product.productId,
    description: view.description,
    productDescription: product.description,
    productRevision: product.revision,
  } });
}

function submitDescriptionReview(
  organisationId: string,
  transport: ProductDescriptionActionTransport | undefined,
  onActionProposed: ((action: CommerceActionRecord) => void) | undefined,
  onReviewRefresh: () => void,
  setReview: React.Dispatch<React.SetStateAction<DescriptionReviewState>>,
  reviewState: DescriptionReviewState,
): void {
  if (reviewState.kind !== "reviewing" && reviewState.kind !== "failed" && reviewState.kind !== "permission") return;
  if (transport === undefined || onActionProposed === undefined) return;
  const review = reviewState.review;
  setReview({ kind: "submitting", review });
  void proposeDescriptionReview(organisationId, transport, onActionProposed, onReviewRefresh, review, setReview);
}

function retryDescriptionReview(
  organisationId: string,
  transport: ProductDescriptionActionTransport | undefined,
  onActionProposed: ((action: CommerceActionRecord) => void) | undefined,
  onReviewRefresh: () => void,
  reviewState: DescriptionReviewState,
  setReview: React.Dispatch<React.SetStateAction<DescriptionReviewState>>,
): void {
  submitDescriptionReview(organisationId, transport, onActionProposed, onReviewRefresh, setReview, reviewState);
}

async function proposeDescriptionReview(
  organisationId: string,
  transport: ProductDescriptionActionTransport,
  onActionProposed: (action: CommerceActionRecord) => void,
  onReviewRefresh: () => void,
  review: DescriptionReview,
  setReview: React.Dispatch<React.SetStateAction<DescriptionReviewState>>,
): Promise<void> {
  try {
    const action = await transport.proposeAction(organisationId, {
      kind: "update_product_description",
      productId: review.productId,
      productRevision: review.productRevision,
      description: review.description,
    }, `commerce-product-description:${review.productId}:${review.productRevision}`);
    onActionProposed(action);
    setReview({ kind: "submitted", review });
  } catch (caught) {
    const permission = permissionRequiredOf(caught);
    if (permission !== null) {
      setReview({ kind: "permission", review, permission });
      return;
    }
    onReviewRefresh();
    setReview({ kind: "failed", review, message: "Approval submission failed. Your shared draft is preserved, and the current product is unchanged. Review the latest product before retrying." });
  }
}

function DescriptionLeaveDialog(
  props: Readonly<{
    blocker: VariantBy<Blocker, "state", "blocked">;
    unsynced: boolean;
  }>,
): React.ReactNode {
  const ref = React.useRef<HTMLDialogElement>(null);
  const id = React.useId();
  React.useLayoutEffect(openLeaveDialog.bind(null, ref), []);
  return <dialog ref={ref} className="access35-dialog" aria-labelledby={id} aria-describedby={`${id}-detail`}
    onCancel={cancelDialog.bind(null, props.blocker.reset)}>
    <form method="dialog">
      <h2 id={id}>Leave this product?</h2>
      <p id={`${id}-detail`}>{props.unsynced
        ? "Some edits have not been confirmed by the server. If you leave now, unsynced text may be lost."
        : "All edits are now synced. You can leave this product safely."}</p>
      <div className="access35-dialog-actions">
        <button type="button" autoFocus onClick={props.blocker.reset}>Keep editing</button>
        <button type="button" onClick={props.blocker.proceed}>{props.unsynced ? "Leave without waiting" : "Leave product"}</button>
      </div>
    </form>
  </dialog>;
}

function openLeaveDialog(ref: React.RefObject<HTMLDialogElement | null>): () => void {
  syncDialog(ref, true);
  return syncDialog.bind(null, ref, false);
}

function noCleanup(): void {}

function connectionLabel(view: DescriptionDraftView): string {
  switch (view.kind) {
    case "connecting": return "Connecting…";
    case "synced": return "Synced";
    case "syncing": return "Syncing…";
    case "reconnecting": return "Reconnecting… Unsynced edits are held only on this page.";
    case "failed": return "Sync stopped";
    default: return assertNever(view, "Unexpected editor state");
  }
}

function descriptionAgentLabel(activity: DescriptionDraftView["agents"][number]): string {
  return `${activity.agent.displayName} edits description`;
}
