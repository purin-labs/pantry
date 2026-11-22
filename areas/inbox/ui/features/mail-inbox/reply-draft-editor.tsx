import React from "react";
import type { CollaborationAgentActivity } from "@purin-labs/collaboration";
import { assertNever } from "@purin-labs/std";
import { BODY_LIMIT } from "@purin-labs/mail-reply-crdt";
import { AgentCursors } from "@purin-labs/collaboration/portal/agent-cursors";
import {
  DraftParticipants,
  DraftPresenceOverlay,
} from "@purin-labs/collaboration/portal/draft-presence";
import { ReplyDraftClient, type ReplyDraftView } from "./reply-draft-client";

type Props = Readonly<{
  organisationId: string;
  proposalId: string;
  disabled: boolean;
  /** The draft closed: the reply was sent, rejected, replaced or reloaded. */
  onClosed: () => void;
  /** The shared text changed, by this person or another. */
  onBody?: (body: string) => void;
}>;
type State = Readonly<{ view: ReplyDraftView }>;

const INITIAL_VIEW: ReplyDraftView = {
  kind: "connecting",
  body: "",
  participants: [],
  agents: [],
  metadata: null,
  readOnly: true,
};

/**
 * Plan 40D: the shared draft of one Inbox reply. Changes sync while it is
 * open, and an agent that edits the draft shows its named cursor. Saving
 * makes the text the next Gmail version; the bar holds that action.
 */
export class ReplyDraftEditor extends React.Component<Props, State> {
  state: State = { view: INITIAL_VIEW };
  private textarea = React.createRef<HTMLTextAreaElement>();
  private client: ReplyDraftClient | null = null;
  private closedReported = false;
  /** Words to select when the shared text holds them. */
  private pendingSelection: string | null = null;

  componentDidMount(): void {
    const textarea = this.textarea.current;
    if (textarea === null) return;
    this.client = new ReplyDraftClient(
      this.props.organisationId,
      this.props.proposalId,
      textarea,
      this.viewChanged,
    );
    textarea.focus();
  }

  componentWillUnmount(): void {
    this.client?.dispose();
    this.client = null;
  }

  /** True while an edit of this person has not reached the shared draft. */
  hasUnsyncedEdits(): boolean {
    return this.client?.hasUnsyncedEdits() ?? false;
  }

  focus(): void {
    this.textarea.current?.focus();
  }

  /**
   * Selects the words in the text, so that the person can change them. Words
   * that the text does not hold yet are selected when it does.
   */
  selectText(words: string): void {
    this.pendingSelection = words;
    this.applySelection();
  }

  private applySelection(): void {
    const textarea = this.textarea.current;
    const words = this.pendingSelection;
    if (textarea === null || words === null) return;
    const start = textarea.value.indexOf(words);
    if (start < 0) return;
    this.pendingSelection = null;
    textarea.focus();
    textarea.setSelectionRange(start, start + words.length);
  }

  private viewChanged = (view: ReplyDraftView): void => {
    const changed = view.body !== this.state.view.body;
    this.setState({ view });
    if (changed) {
      this.props.onBody?.(view.body);
      this.applySelection();
    }
    if (view.kind === "failed" && view.closed && !this.closedReported) {
      this.closedReported = true;
      this.props.onClosed();
    }
  };

  render(): React.ReactNode {
    const { view } = this.state;
    const id = `mail-reply-draft-${this.props.proposalId}`;
    return (
      <div className="mail-reply-draft">
        <div className="mail-reply-draft-status">
          <span data-state={view.kind}>{connectionLabel(view)}</span>
          <DraftParticipants participants={view.participants} />
          <span role="status">{view.agents.map(agentLabel).join(" · ")}</span>
        </div>
        <div className="mail-reply-draft-wrap">
          <textarea
            ref={this.textarea}
            id={id}
            name="body"
            aria-label="Reply message"
            aria-describedby={`${id}-hint ${id}-error`}
            defaultValue=""
            rows={8}
            maxLength={BODY_LIMIT}
            readOnly={view.readOnly || this.props.disabled}
            aria-invalid={view.kind === "failed"}
          />
          <DraftPresenceOverlay
            textarea={this.textarea}
            participants={view.participants}
          />
          <AgentCursors
            activities={view.agents}
            target="body"
            action="Edit reply"
            labelLeft={true}
          />
        </div>
        <p className="mail-inbox-note" id={`${id}-hint`}>
          {savedNote(view)}
        </p>
        <p className="mail-reply-draft-error" id={`${id}-error`} role="alert">
          {view.kind === "failed" ? view.message : ""}
        </p>
      </div>
    );
  }
}

function connectionLabel(view: ReplyDraftView): string {
  switch (view.kind) {
    case "connecting":
      return "Opening the shared draft…";
    case "syncing":
      return "Syncing…";
    case "synced":
      return view.readOnly ? "Shared draft, read only" : "Shared draft";
    case "reconnecting":
      return "Reconnecting…";
    case "failed":
      return "Not connected";
    default:
      return assertNever(view);
  }
}

function savedNote(view: ReplyDraftView): string {
  return view.metadata?.unsaved === true
    ? "This draft has changes that are not saved to Gmail. The recipient and the subject stay fixed."
    : "Changes sync to everyone who has this reply open. Save writes them to the Gmail draft. The recipient and the subject stay fixed.";
}

function agentLabel(activity: CollaborationAgentActivity): string {
  return `${activity.agent.displayName} is editing`;
}
