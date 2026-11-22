import React from "react";
import { ChevronDown, LoaderCircle, ShieldCheck } from "lucide-react";
import { assertNever } from "@purin-labs/std";
import "./draft-message-card.css";

export type DraftMessageField = {
  readonly label: string;
  readonly value: React.ReactNode;
};

/** Where the draft stands. Only `ready` offers Send and Discard. */
export type DraftMessageStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "sending" }
  | { readonly kind: "ready" }
  /** Someone else must send it, for example an owner or admin. */
  | { readonly kind: "waiting"; readonly message: string }
  | { readonly kind: "sent" }
  | { readonly kind: "discarded" }
  | { readonly kind: "expired" }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "unconfirmed"; readonly message: string };

type DraftMessageEdit = {
  readonly maxLength: number;
  /**
   * The version of the body on the card. The editor starts from one version;
   * when a newer one arrives before the save, the card saves nothing, so the
   * save cannot replace the newer body.
   */
  readonly revision: number;
  /** Saves the new body. Returns an error message, or null when saved. */
  readonly onSave: (body: string) => Promise<string | null>;
};

type DraftMessageDecision = {
  readonly sendLabel?: string;
  readonly discardLabel?: string;
  readonly onSend: () => Promise<string | null>;
  readonly onDiscard: () => Promise<string | null>;
};

/** The body as a person reviews it, in the editor or on the card. */
type DraftMessageReviewDraft = Readonly<{
  /** The text in the editor while the person edits, else the draft body. */
  body: string;
  editing: boolean;
  /**
   * Opens the editor, if it is closed, with these words selected. Null when
   * the body cannot change.
   */
  select: ((words: string) => void) | null;
}>;

/** What a person checks before they send, such as where each claim comes from. */
export type DraftMessageReview = Readonly<{
  /** The body with its marks, in place of the plain text. */
  renderBody: (body: string) => React.ReactNode;
  /** Shown under the message, also while the person edits. */
  renderPanel: (draft: DraftMessageReviewDraft) => React.ReactNode;
}>;

export type DraftMessageCardProps = {
  /** A decorative provider mark beside the title. */
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly status: DraftMessageStatus;
  readonly fields: readonly DraftMessageField[];
  /** The exact message text. Null while the draft loads or after it is gone. */
  readonly body: string | null;
  /** Null when the body cannot change, for example after it was sent. */
  readonly edit: DraftMessageEdit | null;
  /** Null when this viewer cannot send, or the draft is settled. */
  readonly decision: DraftMessageDecision | null;
  /** A short line under the message, such as why the last send failed. */
  readonly notice?: string | null;
  /** Actions for a state that needs a person, such as an unconfirmed send. */
  readonly footer?: React.ReactNode;
  readonly review?: DraftMessageReview | null;
};

type Pending = "send" | "discard" | "save" | null;

/** Someone saved a new version of the draft while this person edited it. */
async function draftChangedWhileEditing(): Promise<string> {
  return "This draft changed while you edited it. Copy your words, select Cancel, and edit the new version.";
}

/**
 * A message that the agent drafted for another app. Nothing leaves Pantry
 * until a person selects Send on the card; Discard throws the draft away.
 * The card is presentation only: the caller does the work in the callbacks
 * and returns an error message, or null when the step succeeded.
 */
export function DraftMessageCard(
  props: DraftMessageCardProps,
): React.ReactNode {
  const titleId = React.useId();
  const errorId = React.useId();
  const [pending, setPending] = React.useState<Pending>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);
  // The revision that the open editor started from.
  const editBase = React.useRef<number | null>(null);
  const startEditing = (): void => {
    editBase.current = props.edit?.revision ?? null;
    setEditing(props.body);
  };
  const editButton = React.useRef<HTMLButtonElement>(null);
  const editor = React.useRef<HTMLTextAreaElement>(null);
  // Words to select once the editor holds them.
  const selection = React.useRef<string | null>(null);
  const card = React.useRef<HTMLElement>(null);
  const errorNotice = React.useRef<HTMLParagraphElement>(null);
  React.useEffect(focusDraftError.bind(null, errorNotice, error), [error]);
  const wasEditing = React.useRef(false);
  React.useEffect(
    restoreDraftEditFocus.bind(null, editButton, wasEditing, editing !== null),
    [editing !== null],
  );
  React.useEffect(applyDraftSelection.bind(null, editor, selection), [editing]);
  const ready = props.status.kind === "ready";
  const decision = ready ? props.decision : null;
  const notice =
    props.status.kind === "unavailable" ||
    props.status.kind === "unconfirmed" ||
    props.status.kind === "waiting"
      ? props.status.message
      : (props.notice ?? null);
  const busy = pending !== null;
  const review = props.review ?? null;
  const reviewed = editing ?? props.body;
  const edit = props.edit;
  const select =
    edit === null || props.body === null
      ? null
      : (words: string): void => {
          if (busy) return;
          selection.current = words;
          if (editing === null) startEditing();
          else applyDraftSelection(editor, selection);
        };

  async function run(
    step: Exclude<Pending, null>,
    action: () => Promise<string | null>,
  ): Promise<void> {
    if (busy) return;
    setPending(step);
    setError(null);
    try {
      const problem = await action();
      setError(problem);
      if (problem === null && step === "save") {
        wasEditing.current = false;
        setEditing(null);
        card.current?.focus();
      }
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message.length > 0
          ? caught.message
          : "This step did not finish. Try again.",
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <article
      ref={card}
      tabIndex={-1}
      className="draft-message"
      data-status={props.status.kind}
      aria-labelledby={titleId}
      aria-busy={
        props.status.kind === "loading" ||
        props.status.kind === "sending" ||
        busy
      }
    >
      <header className="draft-message-head">
        <span className="draft-message-icon" aria-hidden="true">
          {props.icon}
        </span>
        <h3 id={titleId} className="draft-message-title">
          {props.title}
        </h3>
        <span className="draft-message-status" role="status">
          <span className="draft-message-dot" aria-hidden="true" />
          {statusLabel(props.status, pending)}
        </span>
      </header>
      <div className="draft-message-sheet">
        {props.fields.length === 0 ? null : (
          <dl className="draft-message-fields">
            {props.fields.map(renderField)}
          </dl>
        )}
        {editing !== null && props.edit !== null ? (
          <form
            className="draft-message-edit"
            onSubmit={(event) => {
              event.preventDefault();
              const edit = props.edit;
              if (edit !== null && editing.trim().length > 0)
                void run(
                  "save",
                  edit.revision === editBase.current
                    ? edit.onSave.bind(null, editing)
                    : draftChangedWhileEditing,
                );
            }}
          >
            <label className="visually-hidden" htmlFor={`${titleId}-body`}>
              Message
            </label>
            <textarea
              ref={editor}
              autoFocus
              id={`${titleId}-body`}
              value={editing}
              maxLength={props.edit.maxLength}
              rows={Math.min(14, Math.max(4, editing.split("\n").length + 1))}
              disabled={busy}
              aria-describedby={error === null ? undefined : errorId}
              onChange={(event) => setEditing(event.currentTarget.value)}
            />
            <div className="draft-message-edit-actions">
              <button
                type="button"
                className="draft-message-button"
                data-tone="quiet"
                disabled={busy}
                onClick={() => {
                  setEditing(null);
                  setError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="draft-message-button"
                data-tone="secondary"
                aria-disabled={busy || editing.trim().length === 0}
              >
                {pending === "save" ? (
                  <LoaderCircle
                    className="draft-message-spin"
                    size={14}
                    aria-hidden="true"
                  />
                ) : null}
                Save changes
              </button>
            </div>
          </form>
        ) : (
          <DraftBody
            body={props.body}
            loading={props.status.kind === "loading"}
            render={review?.renderBody}
          />
        )}
      </div>
      {review === null || reviewed === null ? null : (
        <div className="draft-message-review">
          {review.renderPanel({
            body: reviewed,
            editing: editing !== null,
            select,
          })}
        </div>
      )}
      {notice === null ? null : (
        <p className="draft-message-notice" role="status">
          {notice}
        </p>
      )}
      {error === null ? null : (
        <p
          id={errorId}
          className="draft-message-error"
          role="alert"
          ref={errorNotice}
          tabIndex={-1}
        >
          {error}
        </p>
      )}
      {props.footer ?? null}
      {decision === null || editing !== null ? null : (
        <div className="draft-message-actions">
          <button
            type="button"
            className="draft-message-button"
            data-tone="primary"
            aria-disabled={busy}
            aria-describedby={error === null ? undefined : errorId}
            onClick={() => void run("send", decision.onSend)}
          >
            {pending === "send" ? (
              <LoaderCircle
                className="draft-message-spin"
                size={14}
                aria-hidden="true"
              />
            ) : null}
            {decision.sendLabel ?? "Send"}
          </button>
          {props.edit !== null && props.body !== null ? (
            <button
              type="button"
              ref={editButton}
              className="draft-message-button"
              data-tone="quiet"
              aria-disabled={busy}
              onClick={() => {
                if (!busy) startEditing();
              }}
            >
              Edit
            </button>
          ) : null}
          <button
            type="button"
            className="draft-message-button"
            data-tone="secondary"
            aria-disabled={busy}
            onClick={() => void run("discard", decision.onDiscard)}
          >
            {pending === "discard" ? (
              <LoaderCircle
                className="draft-message-spin"
                size={14}
                aria-hidden="true"
              />
            ) : null}
            {decision.discardLabel ?? "Discard"}
          </button>
          <span className="draft-message-approval">
            <ShieldCheck size={14} aria-hidden="true" />
            Needs your approval
          </span>
        </div>
      )}
    </article>
  );
}

function renderField(field: DraftMessageField): React.ReactNode {
  return (
    <div key={field.label} className="draft-message-field">
      <dt>{field.label}</dt>
      <dd>{field.value}</dd>
    </div>
  );
}

function restoreDraftEditFocus(
  button: React.RefObject<HTMLButtonElement | null>,
  previous: React.RefObject<boolean>,
  editing: boolean,
): void {
  if (previous.current && !editing) button.current?.focus();
  previous.current = editing;
}

function applyDraftSelection(
  editor: React.RefObject<HTMLTextAreaElement | null>,
  selection: React.RefObject<string | null>,
): void {
  const words = selection.current;
  const element = editor.current;
  if (words === null || element === null) return;
  const start = element.value.indexOf(words);
  if (start < 0) return;
  selection.current = null;
  element.focus();
  element.setSelectionRange(start, start + words.length);
}

function focusDraftError(
  ref: React.RefObject<HTMLParagraphElement | null>,
  error: string | null,
): void {
  if (error !== null) ref.current?.focus();
}

/** Long messages fold to a few lines, with a control to show the rest. */
function DraftBody(
  props: Readonly<{
    body: string | null;
    loading: boolean;
    render?: ((body: string) => React.ReactNode) | undefined;
  }>,
): React.ReactNode {
  const ref = React.useRef<HTMLDivElement>(null);
  const bodyId = React.useId();
  const [expanded, setExpanded] = React.useState(false);
  const [overflows, setOverflows] = React.useState(false);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || expanded) return;
    const measure = (): void =>
      setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.body, expanded]);
  if (props.body === null) {
    return props.loading ? (
      <p className="draft-message-body" data-placeholder="">
        Loading the draft…
      </p>
    ) : null;
  }
  return (
    <>
      <div
        ref={ref}
        id={bodyId}
        className="draft-message-body"
        data-folded={!expanded && overflows ? "" : undefined}
        data-expanded={expanded ? "" : undefined}
      >
        {props.render === undefined ? props.body : props.render(props.body)}
      </div>
      {overflows || expanded ? (
        <button
          type="button"
          className="draft-message-more"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show more"}
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      ) : null}
    </>
  );
}

function statusLabel(status: DraftMessageStatus, pending: Pending): string {
  if (pending === "send") return "Sending";
  if (pending === "discard") return "Discarding";
  switch (status.kind) {
    case "loading":
      return "Preparing";
    case "sending":
      return "Sending";
    case "ready":
      return "Ready to send";
    case "waiting":
      return "Waiting for approval";
    case "sent":
      return "Sent";
    case "discarded":
      return "Discarded";
    case "expired":
      return "Expired";
    case "unavailable":
      return "Unavailable";
    case "unconfirmed":
      return "Not confirmed";
    default:
      return assertNever(status, "Unknown draft status");
  }
}
