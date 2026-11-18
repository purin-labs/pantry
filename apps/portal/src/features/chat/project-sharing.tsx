import { Select } from "../../ui/select";
import { parseChatDisclosureFailure, chatDisclosureMessage } from "@seams/control-api";
import React from "react";
import { LockKeyhole, Users } from "lucide-react";
import {
  isProjectRole,
  isUserId,
  parseProjectAccessDetails,
  type Project,
  type ProjectAccessCommand,
  type ProjectAccessDetails,
  type ProjectCandidate,
  type ProjectMember,
  type ProjectRole,
  type UserId,
} from "@seams/control-api";
import { errorMessage, isRecord } from "@seams/std";
import { controlRead, controlWrite, refusedBody } from "../../control-client";
import { DialogHeading, cancelDialog, syncDialog } from "../../dialog";
import { readCookie } from "./api";
import "./project-sharing.css";

const MEMBER_ROLES: ReadonlyArray<{ value: ProjectRole; label: string }> = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
  { value: "owner", label: "Owner" },
];
const SHARE_ROLES: ReadonlyArray<{ value: ProjectRole; label: string }> = [
  { value: "viewer", label: "Viewer — read shared work" },
  { value: "editor", label: "Editor — contribute to shared work" },
  { value: "owner", label: "Owner — manage access and deletion" },
];

type Props = Readonly<{
  organisationId: string;
  project: Project;
  onChanged: () => Promise<void>;
}>;
type LoadState =
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{
      kind: "ready";
      details: ProjectAccessDetails;
      selectedUserId: UserId | null;
      role: ProjectRole;
      busy: boolean;
      error: string | null;
    }>;

export class ProjectSharing extends React.Component<
  Props,
  { panel: LoadState }
> {
  state: { panel: LoadState } = { panel: { kind: "closed" } };
  private readonly dialog = React.createRef<HTMLDialogElement>();
  private requestVersion = 0;
  private readonly headingId = `project-sharing-${crypto.randomUUID()}`;

  componentDidUpdate(previous: Props): void {
    if (
      previous.organisationId !== this.props.organisationId ||
      previous.project.id !== this.props.project.id
    )
      this.close();
    syncDialog(this.dialog, this.state.panel.kind !== "closed");
  }
  componentWillUnmount(): void {
    this.requestVersion += 1;
    syncDialog(this.dialog, false);
  }
  private close(): void {
    this.requestVersion += 1;
    this.setState({ panel: { kind: "closed" } });
  }
  private async open(): Promise<void> {
    const version = ++this.requestVersion;
    this.setState({ panel: { kind: "loading" } });
    try {
      const raw = await controlRead(this.path());
      const details = parseProjectAccessDetails(raw);
      if (details === null) throw new Error("Could not read project access.");
      if (version !== this.requestVersion) return;
      this.setState({
        panel: {
          kind: "ready",
          details,
          selectedUserId: null,
          role: "editor",
          busy: false,
          error: null,
        },
      });
    } catch (error) {
      if (version !== this.requestVersion) return;
      this.setState({
        panel: { kind: "failed", message: errorMessage(error) },
      });
    }
  }
  private path(): string {
    return `/v1/control/organisations/${encodeURIComponent(this.props.organisationId)}/projects/${encodeURIComponent(this.props.project.id)}/access`;
  }
  private selectUser(value: string | null): void {
    const panel = this.state.panel;
    if (panel.kind !== "ready") return;
    const raw = value ?? "";
    this.setState({
      panel: { ...panel, selectedUserId: isUserId(raw) ? raw : null },
    });
  }
  private selectRole(role: string | null): void {
    const panel = this.state.panel;
    if (panel.kind !== "ready" || role === null || !isProjectRole(role)) return;
    this.setState({ panel: { ...panel, role } });
  }
  private async addMember(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const panel = this.state.panel;
    if (panel.kind !== "ready" || panel.busy) return;
    if (panel.selectedUserId === null) {
      this.setState({
        panel: {
          ...panel,
          error: "Choose a person to share this project with.",
        },
      });
      return;
    }
    const command: ProjectAccessCommand =
      panel.details.access.kind === "personal"
        ? {
            kind: "share_project",
            operationId: crypto.randomUUID(),
            expectedAccessRevision: panel.details.access.accessRevision,
            members: [{ userId: panel.selectedUserId, role: panel.role }],
          }
        : {
            kind: "set_project_member",
            operationId: crypto.randomUUID(),
            expectedAccessRevision: panel.details.access.accessRevision,
            userId: panel.selectedUserId,
            role: panel.role,
          };
    await this.mutate(command);
  }
  private async changeRole(
    member: ProjectMember,
    role: string | null,
  ): Promise<void> {
    const panel = this.state.panel;
    if (panel.kind !== "ready" || role === null || !isProjectRole(role)) return;
    await this.mutate({
      kind: "set_project_member",
      operationId: crypto.randomUUID(),
      expectedAccessRevision: panel.details.access.accessRevision,
      userId: member.userId,
      role,
    });
  }
  private async removeMember(member: ProjectMember): Promise<void> {
    const panel = this.state.panel;
    if (panel.kind !== "ready") return;
    await this.mutate({
      kind: "remove_project_member",
      operationId: crypto.randomUUID(),
      expectedAccessRevision: panel.details.access.accessRevision,
      userId: member.userId,
    });
  }
  private async mutate(command: ProjectAccessCommand): Promise<void> {
    const panel = this.state.panel;
    if (panel.kind !== "ready" || panel.busy) return;
    const version = ++this.requestVersion;
    this.setState({ panel: { ...panel, busy: true, error: null } });
    try {
      const csrf = readCookie("satyr_control_csrf");
      if (csrf === null)
        throw new Error("Sign in again to manage project access.");
      const result = await controlWrite(this.path(), "POST", command).catch(
        refusedBody,
      );
      if (!isRecord(result) || result.kind !== "accepted") {
        throw new Error(projectAccessProblem(result));
      }
      if (version !== this.requestVersion) return;
      await this.props.onChanged();
      if (version !== this.requestVersion) return;
      await this.open();
    } catch (error) {
      if (version !== this.requestVersion) return;
      this.setState({
        panel: { ...panel, busy: false, error: errorMessage(error) },
      });
    }
  }
  private renderMember(member: ProjectMember): React.ReactNode {
    const panel = this.state.panel;
    if (panel.kind !== "ready") return null;
    const owner =
      panel.details.access.kind === "personal" ||
      panel.details.access.role === "owner";
    return (
      <li key={member.userId}>
        <span>{member.displayName}</span>
        {owner ? (
          <>
            <Select.Root
              items={MEMBER_ROLES}
              value={member.role}
              disabled={panel.busy}
              onValueChange={this.changeRole.bind(this, member)}
            >
              <Select.Trigger aria-label={`Role for ${member.displayName}`}>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{MEMBER_ROLES.map(renderRole)}</Select.Popup>
            </Select.Root>
            <button
              type="button"
              disabled={panel.busy}
              onClick={this.removeMember.bind(this, member)}
              aria-label={`Remove ${member.displayName}`}
            >
              Remove
            </button>
          </>
        ) : (
          <span className="muted">{member.role}</span>
        )}
      </li>
    );
  }
  render(): React.ReactNode {
    const panel = this.state.panel;
    const shared = this.props.project.access.kind === "shared";
    const owner =
      panel.kind === "ready" &&
      (panel.details.access.kind === "personal" ||
        panel.details.access.role === "owner");
    return (
      <>
        <button
          type="button"
          className="project-sharing-button"
          aria-label={`Manage access to ${this.props.project.name}`}
          title={shared ? "Shared project" : "Share project"}
          onClick={this.open.bind(this)}
        >
          {shared ? (
            <Users size={15} aria-hidden="true" />
          ) : (
            <LockKeyhole size={15} aria-hidden="true" />
          )}
        </button>
        <dialog
          ref={this.dialog}
          className="project-dialog project-sharing-dialog"
          aria-labelledby={this.headingId}
          onCancel={cancelDialog.bind(null, this.close.bind(this))}
        >
          <DialogHeading
            id={this.headingId}
            title="Project access"
            close={this.close.bind(this)}
          />
          <p className="project-sharing-name">{this.props.project.name}</p>
          <p>
            Share the project brief and references. Existing private chats stay
            private.
          </p>
          {panel.kind === "loading" ? (
            <p role="status">Loading members…</p>
          ) : null}
          {panel.kind === "failed" ? (
            <>
              <p role="alert">{panel.message}</p>
              <button type="button" onClick={this.open.bind(this)}>
                Retry
              </button>
            </>
          ) : null}
          {panel.kind === "ready" ? (
            <>
              <ul className="project-members">
                {panel.details.members.map(this.renderMember.bind(this))}
              </ul>
              {owner ? (
                <form onSubmit={this.addMember.bind(this)}>
                  <label>
                    Person
                    <Select.Root
                      required
                      items={panel.details.candidates.map(candidateItem)}
                      value={panel.selectedUserId}
                      disabled={panel.busy}
                      onValueChange={this.selectUser.bind(this)}
                    >
                      <Select.Trigger>
                        <Select.Value placeholder="Choose a team member" />
                      </Select.Trigger>
                      <Select.Popup>
                        {panel.details.candidates.map(renderCandidate)}
                      </Select.Popup>
                    </Select.Root>
                  </label>
                  <label>
                    Access
                    <Select.Root
                      items={SHARE_ROLES}
                      value={panel.role}
                      disabled={panel.busy}
                      onValueChange={this.selectRole.bind(this)}
                    >
                      <Select.Trigger>
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Popup>
                        {SHARE_ROLES.map(renderRole)}
                      </Select.Popup>
                    </Select.Root>
                  </label>
                  <p className="muted">
                    Members can read the project’s shared history. New chats
                    remain private until explicitly shared.
                  </p>
                  {panel.error === null ? null : (
                    <p role="alert">{panel.error}</p>
                  )}
                  <div className="project-dialog-actions">
                    <button type="button" onClick={this.close.bind(this)}>
                      Done
                    </button>
                    <button
                      type="submit"
                      className="primary-button"
                      disabled={panel.busy}
                    >
                      {panel.busy
                        ? "Saving…"
                        : panel.details.access.kind === "personal"
                          ? "Share project"
                          : "Add member"}
                    </button>
                  </div>
                </form>
              ) : (
                <button type="button" onClick={this.close.bind(this)}>
                  Done
                </button>
              )}
            </>
          ) : null}
        </dialog>
      </>
    );
  }
}

function candidateItem(
  candidate: ProjectCandidate,
): Readonly<{ value: string; label: string }> {
  return { value: candidate.userId, label: candidate.displayName };
}

function renderCandidate(candidate: ProjectCandidate): React.ReactNode {
  return (
    <Select.Item key={candidate.userId} value={candidate.userId}>
      {candidate.displayName}
    </Select.Item>
  );
}

function renderRole(
  role: Readonly<{ value: ProjectRole; label: string }>,
): React.ReactNode {
  return (
    <Select.Item key={role.value} value={role.value}>
      {role.label}
    </Select.Item>
  );
}

function projectAccessProblem(raw: unknown): string {
  const failure = parseChatDisclosureFailure(raw);
  if (failure !== null) return chatDisclosureMessage(failure.reason);
  if (!isRecord(raw)) return "Could not update project access. Try again.";
  switch (raw.code) {
    case "project_last_owner":
      return "Assign another owner before removing or changing the last owner.";
    case "project_reference_unavailable":
      return "Some project references cannot be shared with this person. Keep this project private.";
    case "project_unavailable":
      return "You no longer have permission to manage this project.";
    default:
      return "Project access changed. Close and reopen this panel, then try again.";
  }
}
