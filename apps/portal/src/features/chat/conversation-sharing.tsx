import React from "react";
import { LockKeyhole, Users } from "lucide-react";
import {
  parseChatDisclosureFailure, chatDisclosureMessage,
  parseProjectAccessDetails,
  type Project,
  type ProjectMember,
  type ChatInsertion,
} from "@seams/control-api";
import { errorMessage, isNonNegativeInteger, isRecord } from "@seams/std";
import { controlRead, controlWrite, readCookie, refusedBody } from "../../control-client";
import { DialogHeading, cancelDialog, syncDialog } from "../../dialog";
import { readChat, mutateChatDirectory, UNFINISHED_WORK_MESSAGE } from "./api";
import type { ChatConversationSummary } from "@seams/control-api/portal/chat";
import "./project-sharing.css";

export type ConversationSharingIntent = Readonly<{
  kind: "move" | "share";
  conversation: ChatConversationSummary;
  project: Project;
  insertion: ChatInsertion;
}>;
type Props = Readonly<{
  organisationId: string;
  intent: ConversationSharingIntent | null;
  close: () => void;
  onChanged: () => Promise<void>;
}>;
type Panel =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{
      kind: "ready";
      members: readonly ProjectMember[];
      revision: number;
      accessRevision: number;
      choice: "private" | "shared";
      canShare: boolean;
      busy: boolean;
      error: string | null;
    }>;

export class ConversationSharingDialog extends React.Component<
  Props,
  { panel: Panel }
> {
  state: { panel: Panel } = { panel: { kind: "loading" } };
  private readonly dialog = React.createRef<HTMLDialogElement>();
  private readonly headingId = `conversation-sharing-${crypto.randomUUID()}`;
  private version = 0;

  componentDidMount(): void {
    if (this.props.intent !== null) void this.load();
  }
  componentDidUpdate(previous: Props): void {
    if (previous.intent !== this.props.intent) {
      this.version += 1;
      if (this.props.intent !== null) void this.load();
    }
    syncDialog(this.dialog, this.props.intent !== null);
  }
  componentWillUnmount(): void {
    this.version += 1;
    syncDialog(this.dialog, false);
  }
  private async load(): Promise<void> {
    const intent = this.props.intent;
    if (intent === null) return;
    const version = ++this.version;
    this.setState({ panel: { kind: "loading" } });
    try {
      const raw = await controlRead(
        `${this.path()}?${new URLSearchParams({ project: intent.project.id })}`,
      );
      if (
        !isRecord(raw) ||
        !isRecord(raw.project) ||
        !isNonNegativeInteger(raw.revision)
      )
        throw new Error("Could not read the destination audience.");
      const details = parseProjectAccessDetails({
        access: raw.project.access,
        members: raw.members,
        candidates: [],
      });
      if (details === null || details.access.kind !== "shared")
        throw new Error("Choose a shared project.");
      if (version !== this.version) return;
      this.setState({
        panel: {
          kind: "ready",
          members: details.members,
          revision: raw.revision,
          accessRevision: details.access.accessRevision,
          choice:
            intent.kind === "share" ||
            intent.conversation.sharing.visibility === "shared"
              ? "shared"
              : "private",
          canShare: details.access.role !== "viewer",
          busy: false,
          error: null,
        },
      });
    } catch (error) {
      if (version === this.version)
        this.setState({
          panel: { kind: "failed", message: errorMessage(error) },
        });
    }
  }
  private path(): string {
    const intent = this.props.intent;
    if (intent === null) throw new Error("Choose a chat first.");
    return `/v1/control/organisations/${encodeURIComponent(this.props.organisationId)}/chat/conversations/${intent.conversation.id}/access`;
  }
  private choose(choice: "private" | "shared"): void {
    const panel = this.state.panel;
    if (panel.kind === "ready" && !panel.busy)
      this.setState({ panel: { ...panel, choice } });
  }
  private async submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const intent = this.props.intent;
    const panel = this.state.panel;
    if (intent === null || panel.kind !== "ready" || panel.busy) return;
    const version = this.version;
    let sharingAccepted = false;
    this.setState({ panel: { ...panel, busy: true, error: null } });
    try {
      if (panel.choice === "shared") {
        const csrf = readCookie("satyr_control_csrf");
        if (csrf === null) throw new Error("Sign in again to share chats.");
        const raw = await controlWrite(this.path(), "POST", {
          kind:
            intent.conversation.sharing.visibility === "shared"
              ? "move_shared_conversation"
              : "share_conversation",
          operationId: crypto.randomUUID(),
          projectId: intent.project.id,
          expectedRevision: panel.revision,
          expectedProjectAccessRevision: panel.accessRevision,
        }).catch(refusedBody);
        if (!isRecord(raw) || raw.kind !== "accepted")
          throw new Error(sharingError(raw));
        sharingAccepted = true;
      }
      if (intent.kind === "move") {
        const current = await readChat(
          this.props.organisationId,
          intent.conversation.id,
        );
        const placement = current.conversation?.placement;
        if (placement === null || placement === undefined)
          throw new Error("This chat is no longer available.");
        await mutateChatDirectory(this.props.organisationId, {
          kind: "move_chat",
          operationId: crypto.randomUUID(),
          expectedDirectoryRevision: current.projectDirectory.revision,
          conversationId: intent.conversation.id,
          expectedMembershipRevision: placement.membershipRevision,
          destination: { projectId: intent.project.id },
          insertion: intent.insertion,
        });
      }
      await this.props.onChanged();
      if (version === this.version) this.props.close();
    } catch (error) {
      if (sharingAccepted) {
        await this.props.onChanged().catch(ignoreRefreshFailure);
        if (version === this.version)
          this.setState({
            panel: {
              kind: "failed",
              message:
                "Sharing was saved. The sidebar could not finish updating. Close this dialog and refresh before moving the chat again.",
            },
          });
      } else if (version === this.version)
        this.setState({
          panel: { ...panel, busy: false, error: errorMessage(error) },
        });
    }
  }
  render(): React.ReactNode {
    const intent = this.props.intent;
    const panel = this.state.panel;
    const alreadyShared = intent?.conversation.sharing.visibility === "shared";
    return (
      <dialog
        ref={this.dialog}
        className="project-dialog project-sharing-dialog"
        aria-labelledby={this.headingId}
        onCancel={cancelDialog.bind(null, this.props.close)}
      >
        <DialogHeading
          id={this.headingId}
          title={alreadyShared ? "Move shared chat" : "Chat visibility"}
          close={this.props.close}
        />
        {panel.kind === "loading" ? (
          <p role="status">Loading project members…</p>
        ) : panel.kind === "failed" ? (
          <p role="alert">{panel.message}</p>
        ) : (
          <form onSubmit={this.submit.bind(this)}>
            <p>
              <strong>{intent?.conversation.title}</strong> →{" "}
              <strong>{intent?.project.name}</strong>
            </p>
            {!alreadyShared && intent?.kind === "move" ? (
              <fieldset className="chat-sharing-choices">
                <legend>Who can see this chat?</legend>
                <label>
                  <input
                    type="radio"
                    name={this.headingId}
                    checked={panel.choice === "private"}
                    disabled={panel.busy}
                    onChange={this.choose.bind(this, "private")}
                  />
                  <LockKeyhole size={17} aria-hidden="true" />
                  <span>
                    <strong>Keep private</strong>
                    <small>Use project context. Only you see this chat.</small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name={this.headingId}
                    checked={panel.choice === "shared"}
                    disabled={panel.busy || !panel.canShare}
                    onChange={this.choose.bind(this, "shared")}
                  />
                  <Users size={17} aria-hidden="true" />
                  <span>
                    <strong>Share with project</strong>
                    <small>
                      Members can see existing history and attachments.
                    </small>
                  </span>
                </label>
              </fieldset>
            ) : (
              <p>
                Existing history and attachments will be available to this
                project’s members.
              </p>
            )}
            <p className="chat-sharing-audience-label">Project members</p>
            <ul className="project-member-list">
              {panel.members.map(renderAudienceMember)}
            </ul>
            <p className="chat-sharing-hint">
              Owners and editors can contribute. Viewers can read. New members
              also receive shared history. Viewed information cannot be
              retracted.
            </p>
            {panel.error === null ? null : <p role="alert">{panel.error}</p>}
            <div className="project-dialog-actions">
              <button
                type="button"
                disabled={panel.busy}
                onClick={this.props.close}
              >
                {!alreadyShared && panel.error !== null ? "Keep private" : "Cancel"}
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={
                  panel.busy || (panel.choice === "shared" && !panel.canShare)
                }
              >
                {panel.busy
                  ? "Saving…"
                  : alreadyShared
                    ? "Move shared chat"
                    : panel.choice === "shared"
                      ? "Share with project"
                      : "Move privately"}
              </button>
            </div>
          </form>
        )}
      </dialog>
    );
  }
}

function renderAudienceMember(member: ProjectMember): React.ReactNode {
  return (
    <li key={member.userId}>
      <span>{member.displayName}</span>
      <small>{member.role}</small>
    </li>
  );
}
function sharingError(raw: unknown): string {
  const failure = parseChatDisclosureFailure(raw);
  if (failure !== null) return chatDisclosureMessage(failure.reason);
  if (!isRecord(raw)) return "Sharing did not finish. Try again.";
  const code = raw.code ?? raw.error;
  if (code === "chat_running")
    return "A turn is running. Share or move this chat after it finishes.";
  if (code === "chat_work_unfinished") return UNFINISHED_WORK_MESSAGE;
  if (code === "chat_history_forbidden" || code === "chat_history_unavailable")
    return "Some history or attachments cannot be shared with this audience. Keep this chat private.";
  if (code === "chat_share_conflict")
    return "The chat or its audience changed. Close this dialog and review the move again.";
  return "This destination is no longer available. Refresh and try again.";
}

function ignoreRefreshFailure(): void {}
