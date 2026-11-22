import { Select } from "@purin-labs/ui/select";
import React from "react";
import { Inbox } from "lucide-react";
import {
  isProjectId,
  type CaseOriginKind,
  type Project,
  type ProjectCaseEntry,
  type ProjectId,
} from "@purin-labs/control-api";
import { assertNever, errorMessage } from "@purin-labs/std";
import { moveCaseToProject, readProjectCases } from "./api";

type Props = Readonly<{
  organisationId: string;
  project: Project;
  projects: readonly Project[];
  defaultProjectId: ProjectId;
  // Changes each time the page reads the directory again. Another member may
  // have moved work since, so the list is read again with it.
  observation: number;
  onChanged: () => Promise<void>;
}>;

type State = Readonly<{
  list:
    | Readonly<{ kind: "loading" }>
    | Readonly<{ kind: "failed"; message: string }>
    | Readonly<{ kind: "ready"; cases: readonly ProjectCaseEntry[] }>;
  movingCaseId: string | null;
  error: string | null;
}>;

// Work from Slack, email and other sources that is filed in this Project. It
// shows where the work came from and when, never its content: that stays with
// the source and its own access rules.
export class ProjectCases extends React.Component<Props, State> {
  state: State = { list: { kind: "loading" }, movingCaseId: null, error: null };
  private requestVersion = 0;

  componentDidMount(): void {
    void this.load("open");
  }
  componentDidUpdate(previous: Props): void {
    if (
      previous.organisationId !== this.props.organisationId ||
      previous.project.id !== this.props.project.id
    )
      void this.load("open");
    else if (
      previous.observation !== this.props.observation &&
      this.state.movingCaseId === null
    )
      void this.load("observe");
  }
  componentWillUnmount(): void {
    this.requestVersion += 1;
  }
  // An observation replaces the list without a loading state. A reader who
  // lost access gets the failure in place of what they could read before.
  private async load(mode: "open" | "observe"): Promise<void> {
    const version = ++this.requestVersion;
    if (mode === "open")
      this.setState({ list: { kind: "loading" }, error: null });
    try {
      const cases = await readProjectCases(
        this.props.organisationId,
        this.props.project.id,
      );
      if (version !== this.requestVersion) return;
      this.setState({
        list: { kind: "ready", cases: cases.filter(fromAnotherSource) },
      });
    } catch (error) {
      if (version !== this.requestVersion) return;
      this.setState({
        list: {
          kind: "failed",
          message: errorMessage(error, "Could not read this project's work."),
        },
      });
    }
  }
  private async move(
    entry: ProjectCaseEntry,
    destination: string | null,
  ): Promise<void> {
    if (destination === null) return;
    if (!isProjectId(destination) || this.state.movingCaseId !== null) return;
    this.setState({ movingCaseId: entry.caseId, error: null });
    try {
      await moveCaseToProject(this.props.organisationId, entry, destination);
      await this.load("observe");
      await this.props.onChanged();
    } catch (error) {
      // The work may have moved in another window: the list is read again so
      // the refused entry does not stay on screen.
      await this.load("observe");
      this.setState({
        error: errorMessage(error, "Could not move this work."),
      });
    } finally {
      this.setState({ movingCaseId: null });
    }
  }
  // A source's work may sit in a shared Project its mover can edit, or in the default.
  private destinations(): readonly Readonly<{ id: ProjectId; name: string }>[] {
    const destinations: { id: ProjectId; name: string }[] = [];
    for (const project of this.props.projects) {
      if (project.id === this.props.project.id) continue;
      if (project.access.kind === "shared" && project.access.role !== "viewer")
        destinations.push({ id: project.id, name: project.name });
    }
    if (
      this.props.defaultProjectId !== this.props.project.id &&
      !destinations.some(hasId.bind(null, this.props.defaultProjectId))
    )
      destinations.push({
        id: this.props.defaultProjectId,
        name: "Default project",
      });
    return destinations;
  }
  private renderCase(entry: ProjectCaseEntry): React.ReactNode {
    const destinations = this.destinations();
    return (
      <li key={entry.caseId}>
        <span className="project-case-source">
          <Inbox size={16} aria-hidden="true" />
          <span>{caseOriginLabel(entry.origin)}</span>
        </span>
        <time dateTime={new Date(entry.filedAt).toISOString()}>
          Filed {new Date(entry.filedAt).toLocaleDateString()}
        </time>
        {destinations.length === 0 ? null : (
          <Select.Root
            items={[
              { value: "", label: "Move to…" },
              ...destinations.map(destinationItem),
            ]}
            value=""
            disabled={this.state.movingCaseId !== null}
            onValueChange={this.move.bind(this, entry)}
          >
            <Select.Trigger
              aria-label={`Move ${caseOriginLabel(entry.origin)} to another project`}
            >
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>
              <Select.Item value="">Move to…</Select.Item>
              {destinations.map(renderDestination)}
            </Select.Popup>
          </Select.Root>
        )}
      </li>
    );
  }
  render(): React.ReactNode {
    const list = this.state.list;
    return (
      <section
        className="project-overview-section"
        aria-label="Work from other sources"
      >
        <h3>Slack, email and other work</h3>
        {this.state.error === null ? null : (
          <p role="alert">{this.state.error}</p>
        )}
        {list.kind === "loading" ? (
          <p className="project-overview-empty" role="status">
            Loading…
          </p>
        ) : list.kind === "failed" ? (
          <p role="alert">{list.message}</p>
        ) : list.cases.length === 0 ? (
          <p className="project-overview-empty">
            No work from Slack, email or other sources is filed here. New work
            from those sources goes to the default project.
          </p>
        ) : (
          <ul className="project-overview-cases">
            {list.cases.map(this.renderCase.bind(this))}
          </ul>
        )}
      </section>
    );
  }
}

function fromAnotherSource(entry: ProjectCaseEntry): boolean {
  return entry.conversationId === null;
}
function hasId(id: ProjectId, candidate: Readonly<{ id: ProjectId }>): boolean {
  return candidate.id === id;
}
function destinationItem(
  destination: Readonly<{ id: ProjectId; name: string }>,
): Readonly<{ value: string; label: string }> {
  return { value: destination.id, label: destination.name };
}
function renderDestination(
  destination: Readonly<{ id: ProjectId; name: string }>,
): React.ReactNode {
  return (
    <Select.Item key={destination.id} value={destination.id}>
      {destination.name}
    </Select.Item>
  );
}
function caseOriginLabel(origin: CaseOriginKind): string {
  switch (origin) {
    case "slack":
      return "Slack thread";
    case "email":
      return "Email thread";
    case "whatsapp":
      return "WhatsApp conversation";
    case "inbox_assistant":
      return "Inbox assistant task";
    case "commerce_approval":
      return "Commerce approval";
    case "direct":
      return "Automation or API task";
    case "portal_chat":
      return "Chat";
    case "canvas_chat":
      return "Canvas chat";
    default:
      return assertNever(origin);
  }
}
