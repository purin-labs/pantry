/**
 * Setup changes and price allowances that the agent staged in this chat
 * (Plan 81 slice 5). Nothing changes until the person who asked selects the
 * action on the card.
 */
import React from "react";
import { SlidersHorizontal } from "lucide-react";
import { assertNever } from "@purin-labs/std";
import { VoiceApprovalLine } from "../voice/approvals";
import type { ChatTimelineInsert } from "./activity";
import type { ConfigurationDraftActions } from "./configuration-drafts";
import type { ConfigurationDraftView } from "@purin-labs/control-api/portal/configuration-drafts";
import "../../ui/draft-message-card.css";
import "./side-case-card.css";

type ConfigurationDraftContext = Readonly<{
  actions: ConfigurationDraftActions;
  canManage: boolean;
  onChanged: () => Promise<void>;
}>;

export function configurationDraftInserts(
  drafts: readonly ConfigurationDraftView[],
  context: ConfigurationDraftContext,
): readonly ChatTimelineInsert[] {
  return drafts.map((draft) => ({
    key: `configuration:${draft.draftId}`,
    createdAt: draft.createdAt,
    node: (
      <ChatConfigurationDraftCard
        key={`configuration:${draft.draftId}`}
        draft={draft}
        context={context}
      />
    ),
  }));
}

function ChatConfigurationDraftCard(
  props: Readonly<{
    draft: ConfigurationDraftView;
    context: ConfigurationDraftContext;
  }>,
): React.ReactNode {
  const { context } = props;
  const titleId = React.useId();
  const [answered, setAnswered] = React.useState<ConfigurationDraftView | null>(
    null,
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const draft = answered ?? props.draft;
  const status = statusOf(draft);
  const mayDecide =
    context.canManage && draft.requestedByViewer && draft.state === "pending";

  /** Returns the error for a spoken confirmation, which has no card to read. */
  async function decide(
    action: (draft: ConfigurationDraftView) => Promise<ConfigurationDraftView>,
  ): Promise<string | null> {
    if (busy) return "That card is busy.";
    setBusy(true);
    setError(null);
    let failure: string | null = null;
    try {
      setAnswered(await action(draft));
    } catch (caught) {
      failure =
        caught instanceof Error && caught.message.length > 0
          ? caught.message
          : "Pantry could not make this change. Nothing changed. Try again.";
      setError(failure);
    }
    setBusy(false);
    await context.onChanged().catch(ignoreRefreshFailure);
    return failure;
  }

  return (
    <article
      className="draft-message side-case-card"
      data-status={status.tone}
      aria-labelledby={titleId}
      aria-busy={busy}
    >
      <header className="draft-message-head">
        <span className="draft-message-icon" aria-hidden="true">
          <SlidersHorizontal size={18} strokeWidth={1.75} />
        </span>
        <h3 id={titleId} className="draft-message-title">
          Setup change
        </h3>
        <span className="draft-message-status" role="status">
          <span className="draft-message-dot" aria-hidden="true" />
          {status.label}
        </span>
      </header>
      <p className="side-case-card-lead">{draft.summary}</p>
      {draft.state === "pending" ? (
        <p className="side-case-card-lead">{draft.consequence}</p>
      ) : null}
      {draft.state === "pending" && !mayDecide ? (
        <p className="side-case-card-lead">
          The person who asked for this change must confirm it, as an owner or
          an admin.
        </p>
      ) : null}
      {mayDecide ? (
        <div className="draft-message-actions">
          <button
            type="button"
            className="draft-message-button"
            data-tone="primary"
            aria-disabled={busy}
            onClick={() => void decide(context.actions.confirm)}
          >
            {draft.actionLabel}
          </button>
          <button
            type="button"
            className="draft-message-button"
            data-tone="secondary"
            aria-disabled={busy}
            onClick={() => void decide(context.actions.cancel)}
          >
            Discard
          </button>
        </div>
      ) : null}
      {mayDecide ? (
        <VoiceApprovalLine
          target={{ kind: "configuration_draft", id: draft.draftId }}
          approve={() => decide(context.actions.confirm)}
        />
      ) : null}
      {error === null ? null : (
        <p className="draft-message-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

function statusOf(
  draft: ConfigurationDraftView,
): Readonly<{ tone: string; label: string }> {
  switch (draft.state) {
    case "pending":
      return {
        tone: "ready",
        label: draft.requestedByViewer
          ? "Waiting for you"
          : "Waiting for the person who asked",
      };
    case "confirmed":
      return { tone: "sending", label: "Saving" };
    case "settled":
      return draft.receiptCode === "accepted"
        ? { tone: "sent", label: "Saved" }
        : { tone: "unavailable", label: "Not changed" };
    case "cancelled":
      return { tone: "discarded", label: "Discarded" };
    case "expired":
      return { tone: "expired", label: "Timed out" };
    default:
      return assertNever(draft.state, "Unknown setup change state");
  }
}

function ignoreRefreshFailure(): void {}
