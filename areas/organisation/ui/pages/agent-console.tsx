import { Select } from "@purin-labs/ui/select";
import { SideDrawer } from "@purin-labs/ui/index";
import React from "react";
import { Link, useLocation } from "react-router";
import { pageLink } from "@purin-labs/ui/page-address";
import { brainAddress, brainAddressSearch } from "@purin-labs/area-brain-contract/ui/features/brain/address";
import {
  ArrowRight,
  CircleAlert,
  ShieldCheck,
  Zap,
} from "lucide-react";

import type {
  AgentPublishedResourceMetadata,
  AgentDefinition,
  AgentInstallation,
  AgentOperationsSnapshot,
  CueBinding,
  ScheduleBinding,
  OperationalArea,
} from "@purin-labs/commerce-control-api/portal/agent-operations";
import type { Skill } from "@purin-labs/control-api";
import { readPublishedCommerceResources } from "@purin-labs/area-commerce-contract/ui/features/commerce/entity-plane/api";
import {
  EmptyState,
  Notice,
  StatusChip,
  TechnicalDetails,
  type StatusChipStatus,
} from "@purin-labs/ui/page-components";
import { AgentDetail } from "./agent-detail";
import {
  activateAgentSteps,
  activeInstallationsForDefinition,
  areaById,
  agentCueBindings,
  agentScheduleBindings,
  attachedSkillRefs,
  AGENT_CAPABILITIES,
  CapabilityChoices,
  capabilityLabel,
  cueEventLabel,
  definitionById,
  humanizeIdentifier,
  installationsForDefinition,
  lifecycleChip,
  MutationFeedback,
  openProposalsForDefinition,
  readFormList,
  readFormText,
  type AgentOperationMutationState,
  type AgentOperationRunner,
  type AgentOperationStep,
  type AgentOperationSubmitter,
} from "./agent-console-shared";
import { DocumentEditor, type AgentRevisionLoader } from "./agent-documents";
import { AgentModal } from "./agent-modal";
import "./agent-rows.css";
import {
  AGENT_STARTER_TEMPLATES,
  starterTemplateById,
  type AgentStarterTemplate,
} from "./agent-templates";
import { assertNever } from "@purin-labs/std";
import type { AgentSkillRef } from "@purin-labs/control-api";

type AgentsPageProps = {
  readonly organisationId: string;
  readonly snapshot: AgentOperationsSnapshot;
  readonly submit: AgentOperationSubmitter;
  readonly run: AgentOperationRunner;
  readonly mutation: AgentOperationMutationState;
  readonly canConfigure: boolean;
  readonly loadRevisions: AgentRevisionLoader;
  /** The Activity tab, where the whole history of agent work is. */
  readonly activityHref?: string;
  /** The tabs of the page, shown under its heading. */
  readonly tabs?: React.ReactNode;
};

type ConsoleView =
  | { readonly kind: "list" }
  | { readonly kind: "agent"; readonly agentDefinitionId: string };

/** Creation flows render as modals layered over the current view. */
type ConsoleDraft =
  | { readonly kind: "none" }
  | { readonly kind: "agent"; readonly templateId: string | null }
  | { readonly kind: "skill" };

const LIST_VIEW: ConsoleView = { kind: "list" };
const NO_DRAFT: ConsoleDraft = { kind: "none" };

export function AgentsPage(props: AgentsPageProps): React.ReactNode {
  const [view, setView] = React.useState<ConsoleView>(LIST_VIEW);
  const [draft, setDraft] = React.useState<ConsoleDraft>(NO_DRAFT);
  const resolved = resolveConsoleView(view, props.snapshot);
  const viewContent = React.useRef<HTMLDivElement>(null);
  const previousView = React.useRef(resolved);
  React.useEffect(
    focusConsoleView.bind(null, viewContent, previousView, resolved),
    [resolved],
  );
  return (
    <section className="agents-page" aria-labelledby="portal-page-title">
      <AgentsPageHeading>
        {props.canConfigure && props.snapshot.definitions.length > 0 ? (
          <button
            type="button"
            className="agent-console-new"
            onClick={showDraft.bind(null, setDraft, {
              kind: "agent",
              templateId: null,
            })}
          >
            <PlusIcon />
            Create agent
          </button>
        ) : null}
      </AgentsPageHeading>
      {props.tabs}
      {props.canConfigure ? null : (
        <Notice tone="neutral" announcement="none">
          Your role can review agent activity. An owner or admin can change the
          agent setup.
        </Notice>
      )}
      <div ref={viewContent}>
        {renderConsoleView(resolved, setView, setDraft, props)}
      </div>
      {renderConsoleDraft(draft, setDraft, props)}
    </section>
  );
}

/** The heading of the Agents page, with an optional action beside it. */
export function AgentsPageHeading(props: {
  readonly children?: React.ReactNode;
}): React.ReactNode {
  return (
    <header className="agents-page-heading">
      <div>
        <h1 id="portal-page-title" tabIndex={-1}>
          Agents
        </h1>
        <p>Choose when agents run and what needs your approval.</p>
      </div>
      {props.children}
    </header>
  );
}

/**
 * The tabs of the Agents page: the agents, the work they did, and the runs
 * of their schedules.
 */
export function AgentsTabs(props: {
  readonly active: "agents" | "activity" | "schedules";
  readonly agentsHref: string;
  readonly activityHref: string;
  readonly schedulesHref: string;
}): React.ReactNode {
  // With the chat open, a tab changes the page beside the chat.
  const location = useLocation();
  const agents = pageLink(location, props.agentsHref);
  const activity = pageLink(location, props.activityHref);
  const schedules = pageLink(location, props.schedulesHref);
  return (
    <nav className="agent-console-nav" aria-label="Agent views">
      <Link
        className={
          props.active === "agents"
            ? "console-tab console-tab-active"
            : "console-tab"
        }
        to={agents.to}
        state={agents.state}
        aria-current={props.active === "agents" ? "page" : undefined}
      >
        Agents
      </Link>
      <Link
        className={
          props.active === "activity"
            ? "console-tab console-tab-active"
            : "console-tab"
        }
        to={activity.to}
        state={activity.state}
        aria-current={props.active === "activity" ? "page" : undefined}
      >
        Activity
      </Link>
      <Link
        className={
          props.active === "schedules"
            ? "console-tab console-tab-active"
            : "console-tab"
        }
        to={schedules.to}
        state={schedules.state}
        aria-current={props.active === "schedules" ? "page" : undefined}
      >
        Schedules
      </Link>
    </nav>
  );
}

function focusConsoleView(
  content: React.RefObject<HTMLDivElement | null>,
  previous: React.RefObject<ConsoleView>,
  view: ConsoleView,
): void {
  if (previous.current === view) return;
  previous.current = view;
  const heading = content.current?.querySelector<HTMLElement>("h2");
  if (heading === null || heading === undefined) return;
  heading.tabIndex = -1;
  heading.focus();
}

function renderConsoleDraft(
  draft: ConsoleDraft,
  setDraft: React.Dispatch<React.SetStateAction<ConsoleDraft>>,
  props: AgentsPageProps,
): React.ReactNode {
  switch (draft.kind) {
    case "none":
      return null;
    case "agent":
      return (
        <NewAgentModal
          {...props}
          templateId={draft.templateId}
          setDraft={setDraft}
        />
      );
    case "skill":
      return <NewSkillModal {...props} setDraft={setDraft} />;
    default:
      return assertNever(draft, "Unhandled agent console view");
  }
}

function showDraft(
  setDraft: React.Dispatch<React.SetStateAction<ConsoleDraft>>,
  draft: ConsoleDraft,
): void {
  setDraft(draft);
}

function resolveConsoleView(
  view: ConsoleView,
  snapshot: AgentOperationsSnapshot,
): ConsoleView {
  if (
    view.kind === "agent" &&
    definitionById(snapshot, view.agentDefinitionId) === null
  ) {
    return LIST_VIEW;
  }
  return view;
}

function renderConsoleView(
  view: ConsoleView,
  setView: React.Dispatch<React.SetStateAction<ConsoleView>>,
  setDraft: React.Dispatch<React.SetStateAction<ConsoleDraft>>,
  props: AgentsPageProps,
): React.ReactNode {
  switch (view.kind) {
    case "list":
      return <AgentListView {...props} setView={setView} setDraft={setDraft} />;
    case "agent": {
      const definition = definitionById(props.snapshot, view.agentDefinitionId);
      if (definition === null) return null;
      return (
        <AgentDetail
          snapshot={props.snapshot}
          definition={definition}
          submit={props.submit}
          run={props.run}
          mutation={props.mutation}
          canConfigure={props.canConfigure}
          loadRevisions={props.loadRevisions}
          onBack={showView.bind(null, setView, LIST_VIEW)}
        />
      );
    }
    default:
      return assertNever(view, "Unhandled agent console view");
  }
}

function showView(
  setView: React.Dispatch<React.SetStateAction<ConsoleView>>,
  view: ConsoleView,
): void {
  setView(view);
}

type ConsoleViewProps = AgentsPageProps & {
  readonly setView: React.Dispatch<React.SetStateAction<ConsoleView>>;
  readonly setDraft: React.Dispatch<React.SetStateAction<ConsoleDraft>>;
};

function PlusIcon(): React.ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M7 2.5v9M2.5 7h9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AgentListView(props: ConsoleViewProps): React.ReactNode {
  return (
    <div className="agent-console">
      <AgentAttention {...props} />
      {props.snapshot.definitions.length === 0 ? (
        <AgentBlankState {...props} />
      ) : (
        <section className="agent-roster" aria-labelledby="agent-roster-title">
          <h2 id="agent-roster-title">Your agents</h2>
          <ul className="agent-rows">
            {props.snapshot.definitions.map(renderAgentRow.bind(null, props))}
          </ul>
        </section>
      )}
      <div className="agent-recent-work">
        <AgentActivity
          cases={props.snapshot.activeCases.slice(0, 3)}
          title="Recent work"
          activityHref={props.activityHref}
        />
        {props.snapshot.activeCases.length > 0 &&
        props.activityHref !== undefined ? (
          <Link className="agent-text-action" to={props.activityHref}>
            View all work <ArrowRight size={16} aria-hidden="true" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function AgentBlankState(props: ConsoleViewProps): React.ReactNode {
  if (!props.canConfigure) {
    return (
      <EmptyState
        title="No agents yet"
        detail="An owner or admin can create the first agent."
        action={null}
      />
    );
  }
  return (
    <div className="agent-blank-state">
      <AgentBlankIcon />
      <h2>Create your first agent</h2>
      <p className="agent-blank-lede">
        Agents watch your workspace and prepare work for review. Start from a
        template you can adjust, or write one from scratch.
      </p>
      <button
        type="button"
        className="agent-console-new"
        onClick={showDraft.bind(null, props.setDraft, {
          kind: "agent",
          templateId: null,
        })}
      >
        <PlusIcon />
        Create agent
      </button>
      <div className="template-row">
        {AGENT_STARTER_TEMPLATES.map(renderTemplateCard.bind(null, props))}
      </div>
    </div>
  );
}

function AgentBlankIcon(): React.ReactNode {
  return (
    <div className="agent-blank-icon" aria-hidden="true">
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="4" y="8" width="16" height="12" rx="3" />
        <path d="M12 4v4M9 14h.01M15 14h.01" />
      </svg>
    </div>
  );
}

function renderTemplateCard(
  props: ConsoleViewProps,
  template: AgentStarterTemplate,
): React.ReactNode {
  return (
    <button
      type="button"
      className="template-card"
      aria-label={`Use ${template.name} template`}
      key={template.templateId}
      onClick={showDraft.bind(null, props.setDraft, {
        kind: "agent",
        templateId: template.templateId,
      })}
    >
      <h3>{template.name}</h3>
      <p>{template.tagline}</p>
    </button>
  );
}

/** One agent: its job, when it runs, and which tools it has. */
function renderAgentRow(
  props: ConsoleViewProps,
  definition: AgentDefinition,
): React.ReactNode {
  const installations = activeInstallationsForDefinition(
    props.snapshot,
    definition.agentDefinitionId,
  );
  const cues = agentCueBindings(
    props.snapshot,
    definition.agentDefinitionId,
  ).filter(bindingCanRun.bind(null, props.snapshot, installations));
  const schedules = agentScheduleBindings(
    props.snapshot,
    definition.agentDefinitionId,
  ).filter(bindingCanRun.bind(null, props.snapshot, installations));
  const triggers = [
    ...cues.map(cueTriggerLabel),
    ...schedules.map(scheduleTriggerLabel),
  ];
  const capabilities = Array.from(
    new Set(installations.flatMap(installationCapabilities)),
  );
  const status = agentCardStatus(
    props.snapshot,
    definition,
    installations,
    cues.length + schedules.length,
  );
  return (
    <li className="agent-row" key={definition.agentDefinitionId}>
      <div className="agent-row-main">
        <h3>
          {definition.displayName}
          {/* The triggers of a running agent say that it runs. */}
          {status.kind === "success" ? null : <StatusChip status={status} />}
        </h3>
        <p>{definition.purpose}</p>
        <p className="agent-row-facts">
          <span title={agentAssignmentSummary(props.snapshot, installations)}>
            <Zap size={15} aria-hidden="true" />
            {triggers.length === 0
              ? "No automatic triggers"
              : triggers.join(" · ")}
          </span>
          <span>
            <ShieldCheck size={15} aria-hidden="true" />
            {capabilities.length === 0
              ? "No commerce tools"
              : capabilities.map(capabilityLabel).join(" · ")}
          </span>
        </p>
      </div>
      <span className="agent-card-actions">
          {props.canConfigure &&
          definition.lifecycle === "active" &&
          !installations.some(hasActiveArea.bind(null, props.snapshot)) &&
          !installationsForDefinition(
            props.snapshot,
            definition.agentDefinitionId,
          ).some(installationIsSuspended) ? (
            <button
              type="button"
              className="agent-text-action"
              disabled={props.mutation.kind === "submitting"}
              onClick={activateAgent.bind(null, props, definition)}
            >
              Activate
              <span className="visually-hidden"> {definition.displayName}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="agent-text-action"
            onClick={showView.bind(null, props.setView, {
              kind: "agent",
              agentDefinitionId: definition.agentDefinitionId,
            })}
          >
            {props.canConfigure ? "Configure" : "View agent"}
            <span className="visually-hidden"> {definition.displayName}</span>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
      </span>
    </li>
  );
}

function bindingCanRun(
  snapshot: AgentOperationsSnapshot,
  installations: readonly AgentInstallation[],
  binding: CueBinding | ScheduleBinding,
): boolean {
  if (
    !binding.enabled ||
    areaById(snapshot, binding.areaId)?.lifecycle !== "active"
  )
    return false;
  const installation = installations.find(
    installationHasId.bind(null, binding.installationId),
  );
  return (
    installation?.areaAssignments.some(
      assignmentHasArea.bind(null, binding.areaId),
    ) ?? false
  );
}

function installationHasId(
  id: string,
  installation: AgentInstallation,
): boolean {
  return installation.installationId === id;
}

function assignmentHasArea(
  areaId: string,
  assignment: AgentInstallation["areaAssignments"][number],
): boolean {
  return assignment.areaId === areaId;
}

function installationCapabilities(
  installation: AgentInstallation,
): readonly string[] {
  return installation.grantedCapabilities;
}

function installationIsSuspended(installation: AgentInstallation): boolean {
  return installation.lifecycle === "suspended";
}

function cueTriggerLabel(binding: CueBinding): string {
  return `On ${cueEventLabel(binding.cueEventType).toLowerCase()}`;
}

export function scheduleTriggerLabel(binding: ScheduleBinding): string {
  switch (binding.spec.cadence) {
    case "hourly":
      return `Hourly at :${String(binding.spec.minuteOfHour).padStart(2, "0")}`;
    case "daily":
      return `Daily at ${binding.spec.timeOfDay} (${binding.spec.timezone})`;
    case "weekly":
      return `${humanizeIdentifier(binding.spec.weekday)} at ${binding.spec.timeOfDay} (${binding.spec.timezone})`;
    default:
      return assertNever(binding.spec, "Unhandled agent console view");
  }
}

function agentAssignmentSummary(
  snapshot: AgentOperationsSnapshot,
  installations: readonly AgentInstallation[],
): string {
  const names = new Set<string>();
  for (const installation of installations) {
    for (const assignment of installation.areaAssignments) {
      const area = areaById(snapshot, assignment.areaId);
      if (area?.lifecycle === "active") names.add(area.name);
    }
  }
  return names.size === 0
    ? "Not active yet."
    : `Active in ${Array.from(names).join(", ")}`;
}

function hasActiveArea(
  snapshot: AgentOperationsSnapshot,
  installation: AgentInstallation,
): boolean {
  for (const assignment of installation.areaAssignments) {
    if (areaById(snapshot, assignment.areaId)?.lifecycle === "active")
      return true;
  }
  return false;
}

function agentCardStatus(
  snapshot: AgentOperationsSnapshot,
  definition: AgentDefinition,
  installations: readonly AgentInstallation[],
  triggerCount: number,
): StatusChipStatus {
  if (definition.lifecycle === "archived")
    return lifecycleChip(definition.lifecycle);
  if (
    installations.length === 0 &&
    installationsForDefinition(snapshot, definition.agentDefinitionId).some(
      installationIsSuspended,
    )
  ) {
    return { kind: "warning", label: "Suspended" };
  }
  if (!installations.some(hasActiveArea.bind(null, snapshot)))
    return { kind: "warning", label: "Not active" };
  if (triggerCount === 0) return { kind: "neutral", label: "Manual only" };
  return { kind: "success", label: "Triggers enabled" };
}

function AgentAttention(props: ConsoleViewProps): React.ReactNode {
  for (const definition of props.snapshot.definitions) {
    const proposals = openProposalsForDefinition(props.snapshot, definition);
    if (proposals.length > 0) {
      return (
        <div className="agent-attention">
          <CircleAlert size={20} aria-hidden="true" />
          <div>
            <h2>{definition.displayName} has suggested changes</h2>
            <p>
              {proposals.length}{" "}
              {proposals.length === 1
                ? "instruction or skill update is"
                : "instruction or skill updates are"}{" "}
              ready for review.
            </p>
          </div>
          <button
            type="button"
            className="agent-attention-action"
            onClick={showView.bind(null, props.setView, {
              kind: "agent",
              agentDefinitionId: definition.agentDefinitionId,
            })}
          >
            Review changes
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      );
    }
  }
  if (!props.canConfigure) return null;
  for (const definition of props.snapshot.definitions) {
    if (definition.lifecycle !== "active") continue;
    const installations = activeInstallationsForDefinition(
      props.snapshot,
      definition.agentDefinitionId,
    );
    if (
      installations.length === 0 &&
      installationsForDefinition(
        props.snapshot,
        definition.agentDefinitionId,
      ).some(installationIsSuspended)
    )
      continue;
    const assigned = installations.some(
      hasActiveArea.bind(null, props.snapshot),
    );
    const enabled = [
      ...agentCueBindings(props.snapshot, definition.agentDefinitionId),
      ...agentScheduleBindings(props.snapshot, definition.agentDefinitionId),
    ].some(bindingCanRun.bind(null, props.snapshot, installations));
    if (assigned && enabled) continue;
    if (!assigned) {
      // One press makes the agent active. Its area and tools can be changed
      // on its own page.
      const formKey = activateFormKey(definition.agentDefinitionId);
      return (
        <>
          <div className="agent-attention">
            <CircleAlert size={20} aria-hidden="true" />
            <div>
              <h2>{definition.displayName} is not active yet</h2>
              <p>
                Activate it to let it work. You can change what it reads and
                does later.
              </p>
            </div>
            <button
              type="button"
              className="agent-attention-action"
              disabled={props.mutation.kind === "submitting"}
              onClick={activateAgent.bind(null, props, definition)}
            >
              Activate {definition.displayName}
            </button>
          </div>
          <MutationFeedback mutation={props.mutation} formKey={formKey} />
        </>
      );
    }
    return (
      <div className="agent-attention">
        <CircleAlert size={20} aria-hidden="true" />
        <div>
          <h2>Choose when {definition.displayName} runs automatically</h2>
          <p>
            You can run it manually now. Add an event or schedule to automate
            its work.
          </p>
        </div>
        <button
          type="button"
          className="agent-attention-action"
          onClick={showView.bind(null, props.setView, {
            kind: "agent",
            agentDefinitionId: definition.agentDefinitionId,
          })}
        >
          Choose triggers
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>
    );
  }
  return null;
}

function activateFormKey(agentDefinitionId: string): string {
  return `activate:${agentDefinitionId}`;
}

function activateAgent(
  props: Pick<AgentsPageProps, "run" | "snapshot">,
  definition: AgentDefinition,
): void {
  void props.run(
    activateFormKey(definition.agentDefinitionId),
    `${definition.displayName} is active.`,
    props.snapshot,
    activateAgentSteps(() => definition),
    null,
  );
}

function AgentActivity(props: {
  readonly cases: readonly AgentOperationsSnapshot["activeCases"][number][];
  readonly title: "Recent work" | "Work history";
  /** The Activity tab. Each row opens its Case there. */
  readonly activityHref?: string;
}): React.ReactNode {
  return (
    <section className="agent-work" aria-labelledby="agent-activity-title">
      <h2 id="agent-activity-title">{props.title}</h2>
      {props.cases.length === 0 ? (
        <p className="empty-state">
          Agent work will appear here with its progress and delivered results.
        </p>
      ) : (
        <div className="agent-work-list">
          {props.cases.map(renderAgentCase.bind(null, props.activityHref))}
        </div>
      )}
    </section>
  );
}

function renderAgentCase(
  activityHref: string | undefined,
  agentCase: AgentOperationsSnapshot["activeCases"][number],
): React.ReactNode {
  const content = (
    <>
      <span className="agent-work-copy">
        <span className="agent-work-title">
          {agentCase.purpose.replace(/<@[A-Z0-9]+>/g, "").trim() ||
            "Agent request"}
        </span>
        <span className="agent-work-result">{caseResultLabel(agentCase)}</span>
      </span>
      <StatusChip status={caseStatus(agentCase.lifecycle)} />
    </>
  );
  if (activityHref === undefined) {
    return (
      <div className="agent-work-row" key={agentCase.caseId}>
        {content}
      </div>
    );
  }
  return (
    <AgentCaseLink
      key={agentCase.caseId}
      href={agentCaseHref(activityHref, agentCase.caseId)}
    >
      {content}
    </AgentCaseLink>
  );
}

function AgentCaseLink(props: {
  readonly href: string;
  readonly children: React.ReactNode;
}): React.ReactNode {
  // With the chat open, a row changes the page beside the chat.
  const link = pageLink(useLocation(), props.href);
  return (
    <Link className="agent-work-row" to={link.to} state={link.state}>
      {props.children}
      <ArrowRight className="agent-work-open" size={16} aria-hidden="true" />
    </Link>
  );
}

/** The Case in the Activity tab, where its Timeline shows the work. */
export function agentCaseHref(activityHref: string, caseId: string): string {
  const query = activityHref.indexOf("?");
  const path = query === -1 ? activityHref : activityHref.slice(0, query);
  const search = query === -1 ? "" : activityHref.slice(query);
  return `${path}${brainAddressSearch(brainAddress("activity", { caseId }), search)}`;
}

function caseStatus(
  lifecycle: AgentOperationsSnapshot["activeCases"][number]["lifecycle"],
): StatusChipStatus {
  switch (lifecycle) {
    case "open":
      return { kind: "neutral", label: "Open" };
    case "waiting":
      return { kind: "warning", label: "Waiting" };
    case "completing":
      return { kind: "neutral", label: "Finishing" };
    case "completed":
      return { kind: "success", label: "Completed" };
    case "quarantined":
      return { kind: "warning", label: "Needs attention" };
    case "archived":
      return { kind: "neutral", label: "Archived" };
    default:
      return assertNever(lifecycle, "Unhandled agent console view");
  }
}

function caseResultLabel(
  agentCase: AgentOperationsSnapshot["activeCases"][number],
): string {
  if (agentCase.outputs.pending > 0)
    return `${agentCase.outputs.pending} ${agentCase.outputs.pending === 1 ? "result" : "results"} awaiting delivery`;
  if (agentCase.outputs.settled > 0)
    return `${agentCase.outputs.settled} ${agentCase.outputs.settled === 1 ? "result" : "results"} delivered`;
  return "No results delivered yet";
}

type OperationalAreasProps = Pick<
  AgentsPageProps,
  "organisationId" | "snapshot" | "submit" | "mutation" | "canConfigure"
>;

type AreasDrawer = "none" | "area" | "scope";

const AREA_CREATE_FORM_KEY = "area-create";
const SCOPE_PUBLISH_FORM_KEY = "responsibility-scope-publish";

/**
 * The operational areas of the workspace, each with the responsibility
 * scopes that it holds. Workspace settings shows it to an owner or admin.
 */
export function OperationalAreasSection(
  props: OperationalAreasProps,
): React.ReactNode {
  const busy = props.mutation.kind === "submitting";
  const [drawer, setDrawer] = React.useState<AreasDrawer>("none");
  const [metadata, setMetadata] =
    React.useState<PublishedResourceMetadataState>({ kind: "loading" });
  React.useEffect(
    loadPublishedResourceMetadata.bind(
      null,
      props.organisationId,
      props.canConfigure,
      setMetadata,
    ),
    [props.organisationId, props.canConfigure],
  );
  const close = (): void => setDrawer("none");
  const activeArea = props.snapshot.areas.some(
    (area) => area.lifecycle === "active",
  );
  return (
    <section className="portal-band" aria-labelledby="operational-areas-title">
      <div className="section-heading">
        <div>
          <h2 id="operational-areas-title">Operational areas</h2>
          <p>Each area groups agent work and the records it covers.</p>
        </div>
        {props.canConfigure ? (
          <div className="operational-areas-actions">
            <button
              type="button"
              disabled={!activeArea}
              onClick={() => setDrawer("scope")}
            >
              Publish scope
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => setDrawer("area")}
            >
              Create area
            </button>
          </div>
        ) : null}
      </div>
      {drawer === "none" ? (
        <>
          <MutationFeedback
            mutation={props.mutation}
            formKey={AREA_CREATE_FORM_KEY}
          />
          <MutationFeedback
            mutation={props.mutation}
            formKey={SCOPE_PUBLISH_FORM_KEY}
          />
        </>
      ) : null}
      {props.snapshot.areas.length === 0 ? (
        <p className="empty-state">No operational areas yet.</p>
      ) : (
        <ul className="agent-rows">
          {props.snapshot.areas.map(
            renderArea.bind(null, props.snapshot.responsibilityScopes),
          )}
        </ul>
      )}
      <SideDrawer
        open={props.canConfigure && drawer === "area"}
        title="Create area"
        close={close}
        footer={
          <>
            <MutationFeedback
              mutation={props.mutation}
              formKey={AREA_CREATE_FORM_KEY}
            />
            <button
              type="submit"
              form={AREA_CREATE_FORM_KEY}
              className="primary-button"
              disabled={busy}
            >
              Create area
            </button>
          </>
        }
      >
        <form
          id={AREA_CREATE_FORM_KEY}
          className="side-drawer-body stacked-form"
          onSubmit={submitArea.bind(null, props.submit, close)}
        >
          <label>
            <span>Name</span>
            <input name="name" required minLength={2} />
          </label>
          <label>
            <span>Purpose</span>
            <input name="purpose" required minLength={2} />
          </label>
        </form>
      </SideDrawer>
      <SideDrawer
        open={props.canConfigure && drawer === "scope"}
        title="Publish a responsibility scope"
        close={close}
        footer={
          <>
            <MutationFeedback
              mutation={props.mutation}
              formKey={SCOPE_PUBLISH_FORM_KEY}
            />
            <button
              type="submit"
              form={SCOPE_PUBLISH_FORM_KEY}
              className="primary-button"
              disabled={
                busy ||
                metadata.kind !== "ready" ||
                !hasAuthorablePublishedResource(metadata.metadata)
              }
            >
              Publish scope
            </button>
          </>
        }
      >
        {renderResponsibilityScopePublication(props, metadata, close)}
      </SideDrawer>
    </section>
  );
}

function submitArea(
  submit: AgentOperationSubmitter,
  close: () => void,
  event: React.FormEvent<HTMLFormElement>,
): void {
  void submit(AREA_CREATE_FORM_KEY, "create_area", event).then(
    closeWhenCreated.bind(null, close),
  );
}

type PublishedResourceMetadataState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; metadata: AgentPublishedResourceMetadata }>
  | Readonly<{ kind: "failed" }>;

function loadPublishedResourceMetadata(
  organisationId: string,
  canConfigure: boolean,
  setMetadata: React.Dispatch<
    React.SetStateAction<PublishedResourceMetadataState>
  >,
): () => void {
  let cancelled = false;
  if (!canConfigure) return stopPublishedResourceMetadataLoad;
  void readPublishedCommerceResources(organisationId)
    .then((metadata) => {
      if (!cancelled) setMetadata({ kind: "ready", metadata });
    })
    .catch(() => {
      if (!cancelled) setMetadata({ kind: "failed" });
    });
  return () => {
    cancelled = true;
  };
}

function stopPublishedResourceMetadataLoad(): void {}

function renderResponsibilityScopePublication(
  props: OperationalAreasProps,
  state: PublishedResourceMetadataState,
  close: () => void,
): React.ReactNode {
  if (!props.canConfigure) return null;
  switch (state.kind) {
    case "loading":
      return (
        <div className="side-drawer-body">
          <Notice tone="neutral" announcement="polite">
            Loading published commerce resources…
          </Notice>
        </div>
      );
    case "failed":
      return (
        <div className="side-drawer-body">
          <Notice tone="warning" announcement="polite">
            Responsibility publication is unavailable until current commerce
            metadata can be verified.
          </Notice>
        </div>
      );
    case "ready":
      return (
        <ResponsibilityScopePublicationForm
          metadata={state.metadata}
          areas={props.snapshot.areas}
          submit={props.submit}
          close={close}
        />
      );
    default:
      return assertNever(state, "Unhandled agent console view");
  }
}

function ResponsibilityScopePublicationForm(props: {
  readonly metadata: AgentPublishedResourceMetadata;
  readonly areas: readonly OperationalArea[];
  readonly submit: AgentOperationSubmitter;
  readonly close: () => void;
}): React.ReactNode {
  const areas = props.areas
    .filter((area) => area.lifecycle === "active")
    .map((area) => ({ value: area.areaId, label: area.name }));
  const entityTypes = props.metadata.entityTypes.map(entityTypeItem);
  const lists = props.metadata.lists.map(commerceListItem);
  const views = props.metadata.views.map(savedViewItem);
  return (
    <form
      id={SCOPE_PUBLISH_FORM_KEY}
      className="side-drawer-body stacked-form"
      onSubmit={submitResponsibilityScope.bind(
        null,
        props.submit,
        props.close,
        props.metadata,
      )}
    >
      <p>
        Choose a resource from the current published Commerce metadata.
        Relationships and list entries remain read-only until they are already
        published.
      </p>
      <label>
        <span>Operational area</span>
        <Select.Root
          name="areaId"
          required
          items={areas}
          defaultValue={areas[0]?.value ?? null}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{areas.map(renderChoiceItem)}</Select.Popup>
        </Select.Root>
      </label>
      <label>
        <span>Published resource</span>
        <Select.Root
          name="resourceKey"
          required
          items={[...entityTypes, ...lists, ...views]}
          defaultValue={null}
        >
          <Select.Trigger>
            <Select.Value placeholder="Select a published resource" />
          </Select.Trigger>
          <Select.Popup>
            <Select.Group>
              <Select.GroupLabel>Entity types</Select.GroupLabel>
              {entityTypes.map(renderChoiceItem)}
            </Select.Group>
            <Select.Group>
              <Select.GroupLabel>Commerce Lists</Select.GroupLabel>
              {lists.map(renderChoiceItem)}
            </Select.Group>
            <Select.Group>
              <Select.GroupLabel>Saved views</Select.GroupLabel>
              {views.map(renderChoiceItem)}
            </Select.Group>
          </Select.Popup>
        </Select.Root>
      </label>
    </form>
  );
}

function submitResponsibilityScope(
  submit: AgentOperationSubmitter,
  close: () => void,
  metadata: AgentPublishedResourceMetadata,
  event: React.FormEvent<HTMLFormElement>,
): void {
  void submit(SCOPE_PUBLISH_FORM_KEY, "publish_responsibility_scope", event, {
    publishedResources: metadata,
  }).then(closeWhenCreated.bind(null, close));
}

type ChoiceItem = Readonly<{ value: string; label: string }>;

function entityTypeItem(
  entityType: AgentPublishedResourceMetadata["entityTypes"][number],
): ChoiceItem {
  const prefix = `entity_type:${entityType.origin}:${String(entityType.typeId)}`;
  return {
    value: prefix,
    label: `${entityType.origin} · ${String(entityType.typeId)}`,
  };
}

function commerceListItem(
  list: AgentPublishedResourceMetadata["lists"][number],
): ChoiceItem {
  return { value: `commerce_list:${String(list.listId)}`, label: list.name };
}

function savedViewItem(
  view: AgentPublishedResourceMetadata["views"][number],
): ChoiceItem {
  return { value: `saved_selector:${String(view.viewId)}`, label: view.name };
}

function renderChoiceItem(item: ChoiceItem): React.ReactNode {
  return (
    <Select.Item key={item.value} value={item.value}>
      {item.label}
    </Select.Item>
  );
}

function hasAuthorablePublishedResource(
  metadata: AgentPublishedResourceMetadata,
): boolean {
  return (
    metadata.entityTypes.length > 0 ||
    metadata.lists.length > 0 ||
    metadata.views.length > 0
  );
}

/** A published scope is its label; an archived one says so. */
function responsibilityScopeText(
  record: AgentOperationsSnapshot["responsibilityScopes"][number],
): string {
  const label = responsibilityScopeLabel(record.scope);
  return record.lifecycle === "published" ? label : `${label} (archived)`;
}

function responsibilityScopeLabel(
  scope: AgentOperationsSnapshot["responsibilityScopes"][number]["scope"],
): string {
  switch (scope.kind) {
    case "entity_type":
      return `Entity type · ${scope.entityTypeId.origin}:${String(scope.entityTypeId.typeId)}`;
    case "relationship":
      return `Relationship · ${String(scope.relationship.relationshipId)}`;
    case "commerce_list":
      return `Commerce List · ${scope.listId}`;
    case "commerce_list_entry":
      return `Commerce List entry · ${scope.entry.listId}:${scope.entry.entryId}`;
    case "saved_selector":
      return `Saved view · ${String(scope.selector.selectorId)}@${Number(scope.selector.revision)}`;
    default:
      return assertNever(scope, "Unhandled agent console view");
  }
}

/** An area is one row: its name, its purpose and its scopes. */
function renderArea(
  scopes: AgentOperationsSnapshot["responsibilityScopes"],
  area: OperationalArea,
): React.ReactNode {
  const areaScopes = scopes.filter((record) => record.areaId === area.areaId);
  const facts = [
    area.purpose,
    areaScopes.length === 0
      ? "No scopes"
      : areaScopes.map(responsibilityScopeText).join(", "),
  ];
  if (area.lifecycle !== "active") facts.push(humanizeIdentifier(area.lifecycle));
  return (
    <li className="agent-row" key={area.areaId}>
      <div className="agent-row-main">
        <h3>{area.name}</h3>
        <p>{facts.join(" · ")}</p>
      </div>
    </li>
  );
}

function NewAgentModal(
  props: AgentsPageProps & {
    readonly templateId: string | null;
    readonly setDraft: React.Dispatch<React.SetStateAction<ConsoleDraft>>;
  },
): React.ReactNode {
  const template = starterTemplateById(props.templateId);
  const busy = props.mutation.kind === "submitting";
  const close = showDraft.bind(null, props.setDraft, NO_DRAFT);
  return (
    <AgentModal
      title="Create agent"
      description="The agent starts at once, with the access that you choose."
      close={close}
      footer={
        <>
          <MutationFeedback
            mutation={props.mutation}
            formKey={NEW_AGENT_FORM_KEY}
          />
          <button
            type="button"
            className="modal-secondary-button"
            onClick={close}
          >
            Cancel
          </button>
          <button
            type="submit"
            form={NEW_AGENT_FORM_KEY}
            className="modal-primary-button"
            disabled={busy}
          >
            Create agent
          </button>
        </>
      }
    >
      <div
        className="template-chip-row"
        role="group"
        aria-label="Start from a template"
      >
        <span>Start from</span>
        {AGENT_STARTER_TEMPLATES.map(renderTemplateChip.bind(null, props))}
        <button
          type="button"
          className={
            template === null ? "console-tab console-tab-active" : "console-tab"
          }
          onClick={showDraft.bind(null, props.setDraft, {
            kind: "agent",
            templateId: null,
          })}
        >
          Blank
        </button>
      </div>
      <NewAgentForm
        key={template?.templateId ?? "blank"}
        template={template}
        busy={busy}
        snapshot={props.snapshot}
        run={props.run}
        mutation={props.mutation}
        onCreated={close}
      />
    </AgentModal>
  );
}

function renderTemplateChip(
  props: {
    readonly templateId: string | null;
    readonly setDraft: React.Dispatch<React.SetStateAction<ConsoleDraft>>;
  },
  template: AgentStarterTemplate,
): React.ReactNode {
  return (
    <button
      type="button"
      key={template.templateId}
      className={
        props.templateId === template.templateId
          ? "console-tab console-tab-active"
          : "console-tab"
      }
      onClick={showDraft.bind(null, props.setDraft, {
        kind: "agent",
        templateId: template.templateId,
      })}
    >
      {template.name}
    </button>
  );
}

const NEW_SKILL_FORM_KEY = "skill-create";
const SENSITIVITIES = [
  { value: "ordinary", label: "Ordinary" },
  { value: "sensitive", label: "Sensitive" },
];

function NewSkillModal(
  props: AgentsPageProps & {
    readonly setDraft: React.Dispatch<React.SetStateAction<ConsoleDraft>>;
  },
): React.ReactNode {
  const busy = props.mutation.kind === "submitting";
  const close = showDraft.bind(null, props.setDraft, NO_DRAFT);
  return (
    <AgentModal
      title="Create skill"
      description={null}
      close={close}
      footer={
        <>
          <MutationFeedback
            mutation={props.mutation}
            formKey={NEW_SKILL_FORM_KEY}
          />
          <button
            type="button"
            className="modal-secondary-button"
            onClick={close}
          >
            Cancel
          </button>
          <button
            type="submit"
            form={NEW_SKILL_FORM_KEY}
            className="modal-primary-button"
            disabled={busy}
          >
            Create skill
          </button>
        </>
      }
    >
      <form
        id={NEW_SKILL_FORM_KEY}
        className="stacked-form"
        onSubmit={submitNewSkill.bind(null, props.submit, close)}
      >
        <div className="form-grid">
          <label>
            <span>Title</span>
            <input name="title" required minLength={2} />
          </label>
          <label>
            <span>Sensitivity</span>
            <Select.Root
              name="sensitivity"
              items={SENSITIVITIES}
              defaultValue="ordinary"
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                {SENSITIVITIES.map(renderChoiceItem)}
              </Select.Popup>
            </Select.Root>
          </label>
        </div>
        <label>
          <span>Instructions</span>
          <textarea name="markdownBody" required minLength={1} rows={8} />
        </label>
      </form>
    </AgentModal>
  );
}

function submitNewSkill(
  submit: AgentOperationSubmitter,
  close: () => void,
  event: React.FormEvent<HTMLFormElement>,
): void {
  void submit(NEW_SKILL_FORM_KEY, "create_skill", event).then(
    closeWhenCreated.bind(null, close),
  );
}

function closeWhenCreated(close: () => void, created: boolean): void {
  if (created) close();
}

const NEW_AGENT_FORM_KEY = "new-agent";

function NewAgentForm(props: {
  readonly template: AgentStarterTemplate | null;
  readonly busy: boolean;
  readonly snapshot: AgentOperationsSnapshot;
  readonly run: AgentOperationRunner;
  readonly mutation: AgentOperationMutationState;
  readonly onCreated: () => void;
}): React.ReactNode {
  return (
    <form
      id={NEW_AGENT_FORM_KEY}
      className="stacked-form"
      onSubmit={submitNewAgent.bind(null, props)}
    >
      <div className="form-grid">
        <label>
          <span>Name</span>
          <input
            name="displayName"
            required
            minLength={2}
            defaultValue={props.template?.agent.displayName ?? ""}
          />
        </label>
        <label>
          <span>Role</span>
          <input
            name="role"
            required
            minLength={2}
            defaultValue={props.template?.agent.role ?? ""}
          />
        </label>
      </div>
      <label>
        <span>Purpose</span>
        <input
          name="purpose"
          required
          minLength={2}
          defaultValue={props.template?.agent.purpose ?? ""}
        />
      </label>
      <label>
        <span>Instructions</span>
        <textarea
          name="instructions"
          required
          rows={9}
          defaultValue={props.template?.agent.instructions ?? ""}
        />
      </label>
      <CapabilityChoices
        name="requestedCapabilities"
        capabilities={AGENT_CAPABILITIES}
        selected={props.template?.requestedCapabilities ?? []}
        disabled={props.busy}
      />
      {props.template?.skill === undefined ||
      props.template.skill === null ? null : (
        <fieldset className="agent-starter-skill">
          <legend>Starter skill</legend>
          <label className="agent-starter-skill-toggle">
            <input
              type="checkbox"
              name="includeSkill"
              defaultChecked
              disabled={props.busy}
            />
            <span>Also create this skill and attach it</span>
          </label>
          <label>
            <span>Skill title</span>
            <input
              name="skillTitle"
              defaultValue={props.template.skill.title}
            />
          </label>
          <label>
            <span>Skill instructions</span>
            <textarea
              name="skillBody"
              rows={6}
              defaultValue={props.template.skill.markdownBody}
            />
          </label>
        </fieldset>
      )}
    </form>
  );
}

function submitNewAgent(
  props: {
    readonly snapshot: AgentOperationsSnapshot;
    readonly run: AgentOperationRunner;
    readonly onCreated: () => void;
  },
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  const displayName = readFormText(values, "displayName");
  const role = readFormText(values, "role");
  const purpose = readFormText(values, "purpose");
  const instructions = readFormText(values, "instructions");
  if (
    displayName === null ||
    role === null ||
    purpose === null ||
    instructions === null
  )
    return;
  const requestedCapabilities = readFormList(values, "requestedCapabilities");
  const skillTitle = readFormText(values, "skillTitle");
  const skillBody = readFormText(values, "skillBody");
  const includeSkill =
    values.get("includeSkill") === "on" &&
    skillTitle !== null &&
    skillBody !== null;
  const steps: AgentOperationStep[] = [];
  if (includeSkill) {
    steps.push({
      kind: "create_skill",
      build: () => ({
        kind: "create_skill",
        title: skillTitle,
        sensitivity: "ordinary",
        markdownBody: skillBody,
      }),
    });
  }
  steps.push({
    kind: "create_agent_definition",
    build: (current, initial) => ({
      kind: "create_agent_definition",
      displayName,
      role,
      purpose,
      instructions,
      requestedCapabilities,
      skillRefs: includeSkill ? newSkillRefs(current, initial) : [],
    }),
  });
  // A new agent is active at once, with the tools the person chose for it.
  steps.push(...activateAgentSteps(newDefinition));
  void props
    .run(
      NEW_AGENT_FORM_KEY,
      "Agent created.",
      props.snapshot,
      steps,
      event.currentTarget,
    )
    .then(navigateWhenCreated.bind(null, props.onCreated));
}

function navigateWhenCreated(onCreated: () => void, created: boolean): void {
  if (created) onCreated();
}

/** The agent that the run created: the one the first snapshot did not have. */
function newDefinition(
  current: AgentOperationsSnapshot,
  initial: AgentOperationsSnapshot,
): AgentDefinition | null {
  const known = new Set(
    initial.definitions.map((definition) => definition.agentDefinitionId),
  );
  return (
    current.definitions.find(
      (definition) => !known.has(definition.agentDefinitionId),
    ) ?? null
  );
}

function newSkillRefs(
  current: AgentOperationsSnapshot,
  initial: AgentOperationsSnapshot,
): readonly AgentSkillRef[] {
  const known = new Set(initial.skills.map((skill) => skill.skillId));
  return current.skills
    .filter((skill) => !known.has(skill.skillId))
    .map((skill) => ({
      skillId: skill.skillId,
      revision: skill.currentRevision.revision,
    }));
}

/**
 * The skills that agents follow. The Knowledge page shows it as its Skills
 * view, so it has no page heading of its own.
 */
export function SkillsLibraryPage(props: AgentsPageProps): React.ReactNode {
  const [draft, setDraft] = React.useState<ConsoleDraft>(NO_DRAFT);
  return (
    <>
      <SkillsLibraryView {...props} setDraft={setDraft} />
      {renderConsoleDraft(draft, setDraft, props)}
    </>
  );
}

function SkillsLibraryView(
  props: AgentsPageProps & {
    readonly setDraft: React.Dispatch<React.SetStateAction<ConsoleDraft>>;
  },
): React.ReactNode {
  const busy = props.mutation.kind === "submitting";
  // The skill whose editor is open in the drawer.
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const editing = props.canConfigure
    ? (props.snapshot.skills.find((skill) => skill.skillId === editingId) ??
      null)
    : null;
  const closeEditor = (): void => setEditingId(null);
  return (
    <div className="agent-console">
      {/* The Skills tab names the view: the heading is for a screen reader. */}
      <h2 className="visually-hidden">Skills</h2>
      <div className="agent-library-heading">
        {props.canConfigure ? (
          <button
            type="button"
            className="agent-attention-action"
            onClick={showDraft.bind(null, props.setDraft, { kind: "skill" })}
          >
            <PlusIcon />
            Create skill
          </button>
        ) : null}
      </div>
      {props.snapshot.skills.length === 0 ? (
        <EmptyState
          title="No skills yet"
          detail="Skills are reusable instructions any agent can follow."
          action={null}
        />
      ) : (
        <ul className="agent-rows">
          {props.snapshot.skills.map(
            renderSkill.bind(null, props, editing, setEditingId),
          )}
        </ul>
      )}
      <SideDrawer
        open={editing !== null}
        title={editing === null ? "" : `Edit ${editing.title}`}
        close={closeEditor}
        footer={
          editing === null ? undefined : (
            <button
              type="submit"
              form={skillFormId(editing)}
              className="primary-button"
              disabled={busy}
            >
              Publish skill update
            </button>
          )
        }
      >
        {editing === null ? null : (
          <div className="side-drawer-body">
            <DocumentEditor
              key={editing.skillId}
              formKey={skillFormKey(editing)}
              formId={skillFormId(editing)}
              operation="publish_skill_revision"
              hidden={[
                { name: "skillId", value: editing.skillId },
                {
                  name: "expectedRevision",
                  value: String(editing.currentRevision.revision),
                },
              ]}
              fieldName="markdownBody"
              label="Instructions"
              submitLabel="Publish skill update"
              currentBody={editing.currentRevision.markdownBody}
              currentRevision={editing.currentRevision.revision}
              rows={14}
              submit={props.submit}
              mutation={props.mutation}
              busy={busy}
              history={{
                target: { kind: "skill", id: editing.skillId },
                load: props.loadRevisions,
              }}
              onPublished={closeEditor}
            />
          </div>
        )}
      </SideDrawer>
    </div>
  );
}

function skillFormKey(skill: Skill): string {
  return `skill:${skill.skillId}`;
}

function skillFormId(skill: Skill): string {
  return `skill-edit-${skill.skillId}`;
}

function renderSkill(
  props: AgentsPageProps,
  editing: Skill | null,
  setEditingId: React.Dispatch<React.SetStateAction<string | null>>,
  skill: Skill,
): React.ReactNode {
  const usedBy = props.snapshot.definitions
    .filter((definition) =>
      attachedSkillRefs(definition).some(
        (ref) => ref.skillId === skill.skillId,
      ),
    )
    .map((definition) => definition.displayName);
  return (
    <li className="agent-row" key={skill.skillId}>
      <div className="agent-row-main">
        <h3>
          {skill.title}
          {/* A published skill is the normal state: only another one is marked. */}
          {skill.lifecycle === "published" ? null : (
            <StatusChip status={lifecycleChip(skill.lifecycle)} />
          )}
        </h3>
        <p>
          {humanizeIdentifier(skill.sensitivity)}
          {usedBy.length === 0
            ? " · not attached to any agent"
            : ` · used by ${usedBy.join(", ")}`}
          {` · version ${skill.currentRevision.revision}`}
        </p>
        {props.canConfigure ? null : (
          <TechnicalDetails summary="Show contents">
            <pre className="agent-document-preview">
              {skill.currentRevision.markdownBody}
            </pre>
          </TechnicalDetails>
        )}
      </div>
      {props.canConfigure ? (
        <span className="agent-card-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => setEditingId(skill.skillId)}
          >
            Edit
            <span className="visually-hidden"> {skill.title}</span>
          </button>
          {editing?.skillId === skill.skillId ? null : (
            <MutationFeedback
              mutation={props.mutation}
              formKey={skillFormKey(skill)}
            />
          )}
        </span>
      ) : null}
    </li>
  );
}
