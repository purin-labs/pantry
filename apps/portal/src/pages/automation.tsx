import React from "react";
import { toast } from "sonner";

import type {
  AgentOperationCommand,
  AgentOperationFormContext,
  AgentOperationKind,
  AgentOperationsSnapshot,
  ActionLedgerActivity,
} from "@purin-labs/commerce-control-api/portal/agent-operations";
import type { AgentOperationsTransport } from "../agent-operations";
import type {
  AgentDocumentRevision,
  AgentRevisionTarget,
} from "@purin-labs/commerce-control-api/portal/agent-operations";
import { EMPTY_AGENT_OPERATIONS_SNAPSHOT } from "../agent-operations";
import {
  parseAgentOperationsResponse,
  parseAgentRevisionsResponse,
  parseAgentOperationForm as parseOperationForm,
} from "@purin-labs/commerce-control-api/portal/agent-operations";
import { commerceActionTitle, commerceActionStateLabel, formatCommerceActionAmount } from "../features/governed-actions/commerce";
import {
  parseCommerceActionRecordResponse,
} from "@purin-labs/commerce-control-api/portal/commerce-actions";
import {
  parseTrackingBatchPreviewResponse,
} from "@purin-labs/commerce-control-api/portal/commerce-operations";
import type { CommerceOperationsTransport } from "../features/commerce/operations";
import { ControlApiError } from "../control-client";
import {
  PermissionRequiredPrompt,
  permissionRequiredOf,
} from "../features/access/permission-required-prompt";
import type { ControlErrorKind } from "@purin-labs/control-api/portal/errors";
import type { PageContent } from "../page-content";
import {
  EmptyState,
  Notice,
  PageSkeleton,
  RecoverableError,
  WorkQueue,
  type WorkItemData,
  type WorkItemState,
} from "../page-components";
import {
  AgentsPage,
  AgentsPageHeading,
  AgentsTabs,
  agentCaseHref,
  OperationalAreasSection,
  SkillsLibraryPage,
} from "./agent-console";
import { useLocation, useNavigate } from "react-router";
import { pageAddress, pageLink } from "../page-address";
import { AgentSchedulesPanel } from "../features/agent-schedules/route";
import type { BrainTransport } from "../features/brain/api";
import {
  runAsync,
  type AgentOperationMutationState,
  type AgentOperationRunner,
  type AgentOperationStep,
  type AgentOperationSubmitter,
} from "./agent-console-shared";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import type { TrackingBatchPreview } from "@purin-labs/commerce-control-api";
import type {
  MissingTrackingException,
  TrackingActionTarget,
} from "@purin-labs/control-api";
import type { PermissionRequired } from "@purin-labs/control-api";

export type {
  AgentOperationKind,
} from "@purin-labs/commerce-control-api/portal/agent-operations";
export type { AgentOperationsTransport } from "../agent-operations";
export type {
  AgentOperationMutationState,
  AgentOperationRunner,
  AgentOperationStep,
  AgentOperationSubmitter,
} from "./agent-console-shared";
export { humanizeIdentifier, runAsync } from "./agent-console-shared";
export { AgentsPage, SkillsLibraryPage } from "./agent-console";

type AgentOperationsPage =
  | "operations"
  | "agents"
  | "skills"
  /** The operational areas section of Workspace settings. */
  | "areas";

export type AgentOperationsPageContent = PageContent<AgentOperationsSnapshot>;

type RequestRevision = { current: number };
type OperationsContentSetter = React.Dispatch<
  React.SetStateAction<AgentOperationsPageContent>
>;
type OperationMutationSetter = React.Dispatch<
  React.SetStateAction<AgentOperationMutationState>
>;

type AgentOperationsRouteProps = {
  readonly organisationId: string;
  readonly page: AgentOperationsPage;
  readonly canManage: boolean;
  readonly commerceActionBusy: boolean;
  readonly refreshKey: string;
  readonly loadAction: (actionNonce: string) => Promise<void>;
  readonly transport: AgentOperationsTransport;
  readonly commerceOperations: CommerceOperationsTransport;
  /** The Activity tab, which the Agents page links to. */
  readonly activityHref?: string;
  /** The tabs of the Agents page. */
  readonly tabs?: React.ReactNode;
};

export function AgentOperationsRoute(
  props: AgentOperationsRouteProps,
): React.ReactNode {
  const [content, setContent] = React.useState<AgentOperationsPageContent>({
    kind: "loading",
  });
  const [mutation, setMutation] = React.useState<AgentOperationMutationState>({
    kind: "idle",
  });
  const readRevision = React.useRef(0);
  const mutationRevision = React.useRef(0);
  const mutationActive = React.useRef(false);
  React.useEffect(
    beginAgentOperationsLoad.bind(
      null,
      props.organisationId,
      props.transport,
      readRevision,
      mutationRevision,
      mutationActive,
      setContent,
    ),
    [props.organisationId, props.transport, props.refreshKey],
  );
  React.useEffect(
    registerAgentMutationLifetime.bind(
      null,
      mutationRevision,
      mutationActive,
      setMutation,
    ),
    [props.organisationId, props.transport],
  );
  return (
    <AgentOperationsRouteView
      organisationId={props.organisationId}
      page={props.page}
      canManage={props.canManage}
      commerceActionBusy={props.commerceActionBusy}
      refreshKey={props.refreshKey}
      loadAction={props.loadAction}
      transport={props.transport}
      commerceOperations={props.commerceOperations}
      activityHref={props.activityHref}
      tabs={props.tabs}
      content={content}
      mutation={mutation}
      retry={retryAgentOperations.bind(
        null,
        props.organisationId,
        props.transport,
        readRevision,
        mutationRevision,
        mutationActive,
        setContent,
      )}
      submit={submitAgentOperation.bind(
        null,
        props.organisationId,
        props.transport,
        readRevision,
        mutationRevision,
        mutationActive,
        setContent,
        setMutation,
      )}
      run={runAgentOperationSteps.bind(
        null,
        props.organisationId,
        props.transport,
        readRevision,
        mutationRevision,
        mutationActive,
        setContent,
        setMutation,
      )}
      loadRevisions={loadAgentRevisions.bind(
        null,
        props.organisationId,
        props.transport,
      )}
    />
  );
}

/**
 * The Agents page. Its tabs are the agents, the Activity of their work and
 * the runs of their schedules. The address names the tab: "?view=activity"
 * opens Activity and "?view=schedules" opens Schedules.
 */
export function AgentsRoute(
  props: Omit<AgentOperationsRouteProps, "page" | "tabs"> & {
    readonly agentsHref: string;
    readonly activityHref: string;
    readonly schedulesHref: string;
    /** The Activity view. It reads its own records. */
    readonly activity: React.ReactNode;
    /** The reads of the schedule runs and their Cases. */
    readonly runs: BrainTransport;
  },
): React.ReactNode {
  const location = useLocation();
  const navigate = useNavigate();
  // With the chat open, the address of the page beside it names the tab.
  const view = new URLSearchParams(pageAddress(location).search).get("view");
  const active =
    view === "activity"
      ? "activity"
      : view === "schedules"
        ? "schedules"
        : "agents";
  const tabs = (
    <AgentsTabs
      active={active}
      agentsHref={props.agentsHref}
      activityHref={props.activityHref}
      schedulesHref={props.schedulesHref}
    />
  );
  if (active === "schedules") {
    return (
      <section className="agents-page" aria-labelledby="portal-page-title">
        <AgentsPageHeading />
        {tabs}
        <AgentSchedulesPanel
          organisationId={props.organisationId}
          operations={props.transport}
          transport={props.runs}
          onOpenCase={(caseId) => {
            const link = pageLink(
              location,
              agentCaseHref(props.activityHref, caseId),
            );
            void navigate(link.to, { state: link.state });
          }}
        />
      </section>
    );
  }
  if (active === "activity") {
    return (
      <section className="agents-page" aria-labelledby="portal-page-title">
        <AgentsPageHeading />
        {tabs}
        {props.activity}
      </section>
    );
  }
  return <AgentOperationsRoute {...props} page="agents" tabs={tabs} />;
}

export function AgentOperationsRouteView(
  props: AgentOperationsRouteProps & {
    readonly content: AgentOperationsPageContent;
    readonly mutation: AgentOperationMutationState;
    readonly retry: () => void;
    readonly submit: AgentOperationSubmitter;
    readonly run: AgentOperationRunner;
    readonly loadRevisions: (
      target: AgentRevisionTarget,
    ) => Promise<readonly AgentDocumentRevision[]>;
  },
): React.ReactNode {
  switch (props.content.kind) {
    case "loading":
      return <PageSkeleton label="Loading automation work" />;
    case "ready":
      return (
        <>
          {props.content.updating ? (
            <Notice tone="neutral" announcement="polite">
              Refreshing automation work…
            </Notice>
          ) : null}
          {props.page === "operations" ? (
            <OperationsPage
              snapshot={props.content.data}
              loadAction={props.loadAction}
              canDecide={props.canManage}
              busy={props.commerceActionBusy}
              organisationId={props.organisationId}
              commerceOperations={props.commerceOperations}
              refresh={props.retry}
            />
          ) : props.page === "areas" ? (
            <OperationalAreasSection
              organisationId={props.organisationId}
              snapshot={props.content.data}
              submit={props.submit}
              mutation={props.mutation}
              canConfigure={props.canManage}
            />
          ) : props.page === "skills" ? (
            <SkillsLibraryPage
              organisationId={props.organisationId}
              snapshot={props.content.data}
              submit={props.submit}
              run={props.run}
              mutation={props.mutation}
              canConfigure={props.canManage}
              loadRevisions={props.loadRevisions}
            />
          ) : (
            <AgentsPage
              organisationId={props.organisationId}
              snapshot={props.content.data}
              submit={props.submit}
              run={props.run}
              mutation={props.mutation}
              canConfigure={props.canManage}
              loadRevisions={props.loadRevisions}
              activityHref={props.activityHref}
              tabs={props.tabs}
            />
          )}
        </>
      );
    case "failed":
      return (
        <RecoverableAutomationError
          problem={props.content.problem}
          retry={props.retry}
        />
      );
    case "unauthorized":
      return (
        <EmptyState
          title="Automation is unavailable"
          detail={props.content.reason}
          action={null}
        />
      );
    case "empty":
      return (
        <EmptyState
          title="No automation records"
          detail={props.content.reason}
          action={null}
        />
      );
    default:
      return assertNever(props.content, "Unhandled automation value");
  }
}

function beginAgentOperationsLoad(
  organisationId: string,
  transport: AgentOperationsTransport,
  readRevision: RequestRevision,
  mutationRevision: RequestRevision,
  mutationActive: { current: boolean },
  setContent: OperationsContentSetter,
): () => void {
  void loadAgentOperations(
    organisationId,
    transport,
    readRevision,
    mutationRevision,
    mutationActive,
    setContent,
  );
  return invalidateRequest.bind(null, readRevision);
}

function retryAgentOperations(
  organisationId: string,
  transport: AgentOperationsTransport,
  readRevision: RequestRevision,
  mutationRevision: RequestRevision,
  mutationActive: { current: boolean },
  setContent: OperationsContentSetter,
): void {
  void loadAgentOperations(
    organisationId,
    transport,
    readRevision,
    mutationRevision,
    mutationActive,
    setContent,
  );
}

async function loadAgentOperations(
  organisationId: string,
  transport: AgentOperationsTransport,
  readRevision: RequestRevision,
  mutationRevision: RequestRevision,
  mutationActive: { current: boolean },
  setContent: OperationsContentSetter,
): Promise<void> {
  const revision = ++readRevision.current;
  const operationRevision = mutationRevision.current;
  setContent(refreshingAgentOperationsContent);
  try {
    const snapshot = parseAgentOperationsResponse(
      await transport.read(organisationId),
    );
    if (
      readRevision.current !== revision ||
      mutationRevision.current !== operationRevision ||
      mutationActive.current
    )
      return;
    setContent(readyAgentOperationsContent(snapshot));
  } catch (error) {
    if (
      readRevision.current !== revision ||
      mutationRevision.current !== operationRevision ||
      mutationActive.current
    )
      return;
    setContent(agentOperationsFailureContent(controlErrorKind(error)));
  }
}

function loadAgentRevisions(
  organisationId: string,
  transport: AgentOperationsTransport,
  target: AgentRevisionTarget,
): Promise<readonly AgentDocumentRevision[]> {
  return transport
    .readRevisions(organisationId, target)
    .then(parseAgentRevisionsResponse.bind(null, target));
}

async function submitAgentOperation(
  organisationId: string,
  transport: AgentOperationsTransport,
  readRevision: RequestRevision,
  mutationRevision: RequestRevision,
  mutationActive: { current: boolean },
  setContent: OperationsContentSetter,
  setMutation: OperationMutationSetter,
  formKey: string,
  operationKind: AgentOperationKind,
  event: React.FormEvent<HTMLFormElement>,
  context?: AgentOperationFormContext,
): Promise<boolean> {
  event.preventDefault();
  const form = event.currentTarget;
  const result = parseOperationForm(operationKind, new FormData(form), context);
  if (!result.ok) {
    setMutation({
      kind: "failed",
      formKey,
      operation: operationKind,
      message: result.message,
      conflict: false,
    });
    return false;
  }
  return runAgentOperationSteps(
    organisationId,
    transport,
    readRevision,
    mutationRevision,
    mutationActive,
    setContent,
    setMutation,
    formKey,
    agentOperationSuccessMessage(operationKind),
    EMPTY_AGENT_OPERATIONS_SNAPSHOT,
    [{ kind: operationKind, build: () => result.command }],
    form,
  );
}

async function runAgentOperationSteps(
  organisationId: string,
  transport: AgentOperationsTransport,
  readRevision: RequestRevision,
  mutationRevision: RequestRevision,
  mutationActive: { current: boolean },
  setContent: OperationsContentSetter,
  setMutation: OperationMutationSetter,
  formKey: string,
  successMessage: string,
  snapshot: AgentOperationsSnapshot,
  steps: readonly AgentOperationStep[],
  form: HTMLFormElement | null,
): Promise<boolean> {
  const firstStep = steps[0];
  if (firstStep === undefined) return false;
  const revision = ++mutationRevision.current;
  mutationActive.current = true;
  let current = snapshot;
  let activeKind = firstStep.kind;
  setMutation({ kind: "submitting", formKey, operation: activeKind });
  try {
    for (const step of steps) {
      const command = step.build(current, snapshot);
      if (command === null) continue;
      activeKind = step.kind;
      setMutation({ kind: "submitting", formKey, operation: activeKind });
      current = parseAgentOperationsResponse(
        await transport.mutate(
          organisationId,
          command,
          agentOperationIntent(command),
        ),
      );
      if (mutationRevision.current !== revision) return false;
    }
    mutationActive.current = false;
    mutationRevision.current += 1;
    form?.reset();
    setContent(readyAgentOperationsContent(current));
    setMutation({ kind: "succeeded", formKey, message: successMessage });
    return true;
  } catch (error) {
    if (mutationRevision.current !== revision) return false;
    mutationActive.current = false;
    mutationRevision.current += 1;
    const conflict = controlErrorKind(error) === "configuration_conflict";
    setMutation({
      kind: "failed",
      formKey,
      operation: activeKind,
      message: agentOperationFailureMessage(error),
      conflict,
    });
    if (conflict) {
      void loadAgentOperations(
        organisationId,
        transport,
        readRevision,
        mutationRevision,
        mutationActive,
        setContent,
      );
    }
    return false;
  }
}

function agentOperationSuccessMessage(kind: AgentOperationKind): string {
  switch (kind) {
    case "create_area":
      return "Area created.";
    case "publish_responsibility_scope":
      return "Responsibility scope published.";
    case "create_skill":
      return "Skill created.";
    case "publish_skill_revision":
      return "Skill updated.";
    case "create_agent_definition":
      return "Agent created.";
    case "publish_agent_definition_revision":
      // Publication records a version; it does not change what a running
      // agent uses, so the receipt must not claim otherwise.
      return "Version published. Activate it to put it into use.";
    case "install_agent":
      return "Agent assigned.";
    case "bind_skill":
      return "Area skill attached.";
    case "activate_agent_definition_revision":
      return "Update activated. New work uses this version.";
    case "configure_cue_binding":
      return "Signal trigger saved.";
    case "configure_schedule_binding":
      return "Schedule saved.";
    case "update_cue_binding":
    case "update_schedule_binding":
      return "Trigger updated.";
    case "configure_installation_governance":
      return "Session budget saved.";
    case "configure_escalation_policy":
      return "Escalation saved.";
    case "accept_configuration_proposal":
      return "Suggestion accepted and published.";
    case "dismiss_configuration_proposal":
      return "Suggestion dismissed.";
    case "dispatch_manual_run":
      return "Run started. It will appear under Activity.";
    default:
      return assertNever(kind, "Unhandled automation value");
  }
}

function registerAgentMutationLifetime(
  mutationRevision: RequestRevision,
  mutationActive: { current: boolean },
  setMutation: OperationMutationSetter,
): () => void {
  setMutation({ kind: "idle" });
  return invalidateMutationRequest.bind(null, mutationRevision, mutationActive);
}

function invalidateMutationRequest(
  mutationRevision: RequestRevision,
  mutationActive: { current: boolean },
): void {
  mutationActive.current = false;
  invalidateRequest(mutationRevision);
}

function invalidateRequest(requestRevision: RequestRevision): void {
  requestRevision.current += 1;
}

function refreshingAgentOperationsContent(
  content: AgentOperationsPageContent,
): AgentOperationsPageContent {
  return content.kind === "ready"
    ? { ...content, updating: true }
    : { kind: "loading" };
}

function readyAgentOperationsContent(
  snapshot: AgentOperationsSnapshot,
): Variant<AgentOperationsPageContent, "ready"> {
  return {
    kind: "ready",
    data: snapshot,
    freshness: { kind: "current" },
    updating: false,
  };
}

function agentOperationsFailureContent(
  errorKind: ControlErrorKind | null,
): Variant<AgentOperationsPageContent, "failed" | "unauthorized"> {
  if (errorKind === "forbidden") {
    return {
      kind: "unauthorized",
      reason: "Your role cannot access automation configuration.",
    };
  }
  return {
    kind: "failed",
    problem: "Automation work could not be loaded.",
    recovery: { label: "Try again" },
  };
}

function RecoverableAutomationError(props: {
  readonly problem: string;
  readonly retry: () => void;
}): React.ReactNode {
  return (
    <RecoverableError
      message={props.problem}
      action={
        <button type="button" onClick={props.retry}>
          Try again
        </button>
      }
    />
  );
}

function controlErrorKind(error: unknown): ControlErrorKind | null {
  return error instanceof ControlApiError ? error.kind : null;
}

function agentOperationFailureMessage(error: unknown): string {
  const kind = controlErrorKind(error);
  if (kind === "forbidden")
    return "Your role can no longer change agent configuration.";
  if (kind === "configuration_conflict")
    return "This changed in another session. The latest version has been loaded.";
  return "Agent configuration could not be saved. Try again.";
}

function agentOperationIntent(command: AgentOperationCommand): string {
  return `agent-operation:${command.kind}:${JSON.stringify(command)}`;
}

type OperationsPageProps = {
  readonly organisationId: string;
  readonly snapshot: AgentOperationsSnapshot;
  readonly loadAction: (actionNonce: string) => Promise<void>;
  readonly canDecide: boolean;
  readonly busy: boolean;
  readonly commerceOperations: CommerceOperationsTransport;
  readonly refresh: () => void;
};

function OperationsPage(props: OperationsPageProps): React.ReactNode {
  return (
    <section
      className="portal-band commerce-panel"
      aria-labelledby="operations-title"
    >
      <div className="section-heading">
        <div>
          <h2 id="operations-title">Approvals and activity</h2>
          <p>
            Shipments to fix, approvals to decide, and what happened recently.
          </p>
        </div>
      </div>
      <CommerceExceptionWorkbench
        organisationId={props.organisationId}
        inbox={props.snapshot.commerceExceptions}
        transport={props.commerceOperations}
        canResolve={props.canDecide}
        refresh={props.refresh}
      />
      <OperationsQueue
        actionLedger={props.snapshot.actionLedger}
        loadAction={props.loadAction}
        canDecide={props.canDecide}
        busy={props.busy}
      />
    </section>
  );
}

type TrackingResolverState =
  | Readonly<{ kind: "selecting"; selected: readonly string[] }>
  | Readonly<{ kind: "previewing"; selected: readonly string[] }>
  | Readonly<{ kind: "preview"; preview: TrackingBatchPreview }>
  | Readonly<{ kind: "submitting"; preview: TrackingBatchPreview }>
  | Readonly<{
      kind: "complete";
      preview: TrackingBatchPreview;
      proposed: number;
      failed: readonly string[];
      /** The permission that refused the batch; the prompt offers it. */
      permission: PermissionRequired | null;
    }>
  | Readonly<{ kind: "failed"; selected: readonly string[]; message: string }>;

function CommerceExceptionWorkbench(
  props: Readonly<{
    organisationId: string;
    inbox: AgentOperationsSnapshot["commerceExceptions"];
    transport: CommerceOperationsTransport;
    canResolve: boolean;
    refresh: () => void;
  }>,
): React.ReactNode {
  const [state, setState] = React.useState<TrackingResolverState>({
    kind: "selecting",
    selected: [],
  });
  const workbench = React.useRef<HTMLElement>(null);
  React.useEffect(focusTrackingResult.bind(null, workbench, state.kind), [
    state.kind,
  ]);
  if (props.inbox.kind === "unavailable") {
    return (
      <section
        className="commerce-exception-workbench"
        aria-labelledby="commerce-exceptions-title"
      >
        <div className="action-section-heading">
          <h3 id="commerce-exceptions-title">Commerce exceptions</h3>
        </div>
        <p className="empty-state">
          {commerceExceptionUnavailableMessage(props.inbox.reason)}
        </p>
      </section>
    );
  }
  return (
    <section
      className="commerce-exception-workbench"
      ref={workbench}
      aria-labelledby="commerce-exceptions-title"
    >
      <div className="action-section-heading">
        <h3 id="commerce-exceptions-title">Commerce exceptions</h3>
        <span>{props.inbox.items.length}</span>
      </div>
      {props.inbox.items.length === 0 ? (
        <p className="quiet-success">No shipments need attention.</p>
      ) : (
        renderTrackingResolver({
          ...props,
          items: props.inbox.items,
          state,
          setState,
        })
      )}
    </section>
  );
}

function renderTrackingResolver(
  props: Readonly<{
    organisationId: string;
    items: readonly MissingTrackingException[];
    transport: CommerceOperationsTransport;
    canResolve: boolean;
    refresh: () => void;
    state: TrackingResolverState;
    setState: React.Dispatch<React.SetStateAction<TrackingResolverState>>;
  }>,
): React.ReactNode {
  switch (props.state.kind) {
    case "selecting":
    case "previewing":
    case "failed": {
      const selected = props.state.selected;
      const busy = props.state.kind === "previewing";
      let reviewLabel = `Review ${countLabel(selected.length, "shipment")}`;
      if (busy) reviewLabel = "Checking shipments…";
      else if (props.state.kind === "failed") reviewLabel = "Try review again";
      return (
        <>
          {props.state.kind === "failed" ? (
            <p className="notice notice-warning" role="alert">
              {props.state.message}
            </p>
          ) : null}
          <fieldset
            className="commerce-exception-selector"
            disabled={!props.canResolve || busy}
          >
            <legend>Select missing-tracking items</legend>
            <p className="field-hint">
              Choose the shipments to fix. Their exact records are frozen when
              you review.
            </p>
            <ul className="commerce-exception-list">
              {props.items.map(
                renderTrackingExceptionChoice.bind(
                  null,
                  selected,
                  props.setState,
                ),
              )}
            </ul>
          </fieldset>
          <div className="commerce-exception-actions">
            <button
              type="button"
              disabled={!props.canResolve || busy || selected.length === 0}
              onClick={beginTrackingBatchPreview.bind(
                null,
                props.organisationId,
                props.transport,
                selected,
                props.setState,
              )}
            >
              {reviewLabel}
            </button>
          </div>
        </>
      );
    }
    case "preview":
    case "submitting":
    case "complete":
      return renderTrackingBatchPreview({ ...props, state: props.state });
    default:
      return assertNever(props.state, "Unhandled automation value");
  }
}

function focusTrackingResult(
  ref: React.RefObject<HTMLElement | null>,
  kind: TrackingResolverState["kind"],
): void {
  let selector: string;
  switch (kind) {
    case "failed":
      selector = '[role="alert"]';
      break;
    case "preview":
      selector = ".commerce-batch-summary";
      break;
    case "complete":
      selector = ".commerce-batch-preview > .notice";
      break;
    default:
      return;
  }
  const result = ref.current?.querySelector<HTMLElement>(selector);
  if (result === null || result === undefined) return;
  result.tabIndex = -1;
  result.focus();
}

function renderTrackingExceptionChoice(
  selected: readonly string[],
  setState: React.Dispatch<React.SetStateAction<TrackingResolverState>>,
  item: MissingTrackingException,
): React.ReactNode {
  const checked = selected.includes(item.exceptionId);
  return (
    <li key={item.exceptionId} className="commerce-exception-item">
      <label className="commerce-exception-choice">
        <input
          type="checkbox"
          checked={checked}
          onChange={updateTrackingSelection.bind(
            null,
            item.exceptionId,
            setState,
          )}
        />
        <span>
          <strong>{trackingTargetTitle(item.target)}</strong>
          <span>{item.reason}</span>
        </span>
      </label>
      <dl className="commerce-exception-facts">
        <div>
          <dt>Next step</dt>
          <dd>{item.recommendedAction.label}</dd>
        </div>
        <div>
          <dt>Due</dt>
          <dd>
            <time dateTime={item.dueAt}>
              {formatOperationsDate(item.dueAt)}
            </time>
          </dd>
        </div>
        <div>
          <dt>Fulfillment</dt>
          <dd>
            <code>{item.target.fulfillmentId}</code>
          </dd>
        </div>
        <div>
          <dt>Tracking</dt>
          <dd>
            <code>{item.target.trackingNumber}</code>
          </dd>
        </div>
      </dl>
    </li>
  );
}

/**
 * Every missing-tracking exception recommends the same action, so the action
 * cannot name the row. The order and shipment can: they are the two things a
 * merchant already recognises, and they differ per row.
 */
function trackingTargetTitle(target: TrackingActionTarget): string {
  return `Order ${withoutIdentifierPrefix(target.orderId, "order")} · Shipment ${withoutIdentifierPrefix(target.shipmentId, "shipment")}`;
}

/**
 * Canonical identifiers repeat their own type (`order_1042`), which reads as
 * "Order order_1042" once the noun is already in the title.
 */
function withoutIdentifierPrefix(identifier: string, prefix: string): string {
  return identifier.startsWith(`${prefix}_`)
    ? identifier.slice(prefix.length + 1)
    : identifier;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function updateTrackingSelection(
  exceptionId: string,
  setState: React.Dispatch<React.SetStateAction<TrackingResolverState>>,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  setState(
    updateTrackingSelectionState.bind(
      null,
      exceptionId,
      event.currentTarget.checked,
    ),
  );
}

function updateTrackingSelectionState(
  exceptionId: string,
  checked: boolean,
  current: TrackingResolverState,
): TrackingResolverState {
  const selected =
    current.kind === "selecting" ||
    current.kind === "previewing" ||
    current.kind === "failed"
      ? current.selected
      : [];
  const withoutItem = selected.filter(
    isDifferentExceptionId.bind(null, exceptionId),
  );
  return {
    kind: "selecting",
    selected: checked ? [...withoutItem, exceptionId] : withoutItem,
  };
}

function isDifferentExceptionId(
  exceptionId: string,
  candidate: string,
): boolean {
  return candidate !== exceptionId;
}

function beginTrackingBatchPreview(
  organisationId: string,
  transport: CommerceOperationsTransport,
  selected: readonly string[],
  setState: React.Dispatch<React.SetStateAction<TrackingResolverState>>,
): void {
  setState({ kind: "previewing", selected });
  void transport
    .previewTrackingBatch(organisationId, selected)
    .then(parseTrackingBatchPreviewResponse)
    .then(setTrackingBatchPreview.bind(null, setState))
    .catch(setTrackingBatchFailure.bind(null, selected, setState));
}

function setTrackingBatchPreview(
  setState: React.Dispatch<React.SetStateAction<TrackingResolverState>>,
  preview: TrackingBatchPreview,
): void {
  setState({ kind: "preview", preview });
}

/**
 * A preview failure is a parser or transport fault, and its text names wire
 * fields no merchant can act on. The console keeps the raw fault for a bug
 * report; the page states what failed and the one step that recovers it.
 */
function setTrackingBatchFailure(
  selected: readonly string[],
  setState: React.Dispatch<React.SetStateAction<TrackingResolverState>>,
  error: unknown,
): void {
  console.error("[commerce-operations] Tracking batch preview failed", error);
  setState({
    kind: "failed",
    selected,
    message:
      "The shipments could not be prepared for review. Try review again. Your selection is preserved.",
  });
}

function renderTrackingBatchPreview(
  props: Readonly<{
    organisationId: string;
    items: readonly MissingTrackingException[];
    transport: CommerceOperationsTransport;
    canResolve: boolean;
    refresh: () => void;
    state: Variant<
      TrackingResolverState,
      "preview" | "submitting" | "complete"
    >;
    setState: React.Dispatch<React.SetStateAction<TrackingResolverState>>;
  }>,
): React.ReactNode {
  const valid = props.state.preview.items.filter(isValidTrackingPreviewItem);
  const busy = props.state.kind === "submitting";
  return (
    <div className="commerce-batch-preview">
      <div className="commerce-batch-summary" aria-live="polite">
        <strong>{countLabel(valid.length, "shipment")} ready to fix</strong>
        <span>
          Checked {formatOperationsDate(props.state.preview.frozenAt)}
        </span>
      </div>
      <ul className="commerce-exception-list">
        {props.state.preview.items.map(
          renderTrackingPreviewItem.bind(null, props.items),
        )}
      </ul>
      {props.state.kind === "complete" ? (
        <Notice
          tone={props.state.failed.length === 0 ? "success" : "warning"}
          announcement="polite"
        >
          {trackingBatchOutcomeMessage(
            props.state.proposed,
            props.state.failed.length,
          )}
        </Notice>
      ) : null}
      {props.state.kind === "complete" && props.state.permission !== null ? (
        <PermissionRequiredPrompt
          organisationId={props.organisationId}
          permission={props.state.permission}
          action="Create approvals"
          grantScope="for these shipments only"
          onAllowed={submitTrackingBatch.bind(
            null,
            props.organisationId,
            props.transport,
            failedTrackingBatch(props.state),
            props.refresh,
            props.setState,
          )}
          onClose={props.setState.bind(null, {
            ...props.state,
            permission: null,
          })}
        />
      ) : null}
      <div className="commerce-exception-actions">
        {props.state.kind === "complete" ? (
          <button
            type="button"
            onClick={props.setState.bind(null, {
              kind: "selecting",
              selected: props.state.failed,
            })}
          >
            {props.state.failed.length > 0
              ? "Review failed shipments"
              : "Fix more shipments"}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={returnToTrackingSelection.bind(
                null,
                props.setState,
                props.state.preview,
              )}
            >
              Back
            </button>
            <button
              type="button"
              disabled={!props.canResolve || busy || valid.length === 0}
              onClick={submitTrackingBatch.bind(
                null,
                props.organisationId,
                props.transport,
                props.state.preview,
                props.refresh,
                props.setState,
              )}
            >
              {busy
                ? "Creating approvals…"
                : `Create ${countLabel(valid.length, "approval")}`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function renderTrackingPreviewItem(
  exceptions: readonly MissingTrackingException[],
  item: TrackingBatchPreview["items"][number],
): React.ReactNode {
  const exception = exceptions.find(
    hasExceptionId.bind(null, item.exceptionId),
  );
  return (
    <li key={item.exceptionId} className="commerce-exception-item">
      <strong>{trackingPreviewTitle(exception, item)}</strong>
      {item.validation.kind === "valid" && item.action !== null ? (
        <span>Ready to attach tracking {item.action.trackingNumber}.</span>
      ) : (
        <span className="error-text">
          This shipment changed while you were reviewing it, so it was left out.
        </span>
      )}
    </li>
  );
}

/**
 * The frozen batch and the inbox can disagree once a shipment closes mid-review,
 * so the row falls back through the action's own target before it resorts to
 * saying the shipment can no longer be named.
 */
function trackingPreviewTitle(
  exception: MissingTrackingException | undefined,
  item: TrackingBatchPreview["items"][number],
): string {
  if (exception !== undefined) return trackingTargetTitle(exception.target);
  if (item.action !== null) return trackingTargetTitle(item.action);
  return "Shipment no longer in the inbox";
}

function trackingBatchOutcomeMessage(proposed: number, failed: number): string {
  const created = `${countLabel(proposed, "approval")} created.`;
  if (failed === 0) return created;
  return `${created} ${countLabel(failed, "shipment")} still ${failed === 1 ? "needs" : "need"} attention.`;
}

function isValidTrackingPreviewItem(
  item: TrackingBatchPreview["items"][number],
): boolean {
  return item.validation.kind === "valid";
}

function hasExceptionId(
  exceptionId: string,
  candidate: MissingTrackingException,
): boolean {
  return candidate.exceptionId === exceptionId;
}

async function submitTrackingBatch(
  organisationId: string,
  transport: CommerceOperationsTransport,
  preview: TrackingBatchPreview,
  refresh: () => void,
  setState: React.Dispatch<React.SetStateAction<TrackingResolverState>>,
): Promise<void> {
  setState({ kind: "submitting", preview });
  let proposed = 0;
  const failed: string[] = [];
  // One missing permission refuses every shipment, so the batch stops at the
  // first such refusal and offers the permission.
  let permission: PermissionRequired | null = null;
  for (const item of preview.items) {
    if (item.validation.kind !== "valid" || item.action === null) continue;
    if (permission !== null) {
      failed.push(item.exceptionId);
      continue;
    }
    try {
      const response = await transport.proposeAction(
        organisationId,
        item.action,
        `tracking-batch:${preview.batchId}:${item.exceptionId}`,
      );
      parseCommerceActionRecordResponse(response);
      proposed += 1;
    } catch (error) {
      permission = permissionRequiredOf(error);
      failed.push(item.exceptionId);
    }
  }
  setState({ kind: "complete", preview, proposed, failed, permission });
  // The outcome stays on the page, where a merchant can read what was left out.
  // The toast only carries the glance, so a partial batch never announces twice.
  if (proposed > 0)
    toast.success(`${countLabel(proposed, "approval")} created.`);
  refresh();
}

/** The shipments of a finished batch that were not proposed. */
function failedTrackingBatch(
  state: Variant<TrackingResolverState, "complete">,
): TrackingBatchPreview {
  return {
    ...state.preview,
    items: state.preview.items.filter(isFailedItem.bind(null, state.failed)),
  };
}

function isFailedItem(
  failed: readonly string[],
  item: TrackingBatchPreview["items"][number],
): boolean {
  return failed.includes(item.exceptionId);
}

function returnToTrackingSelection(
  setState: React.Dispatch<React.SetStateAction<TrackingResolverState>>,
  preview: TrackingBatchPreview,
): void {
  setState({
    kind: "selecting",
    selected: preview.items.map(trackingPreviewExceptionId),
  });
}

function trackingPreviewExceptionId(
  item: TrackingBatchPreview["items"][number],
): string {
  return item.exceptionId;
}

function commerceExceptionUnavailableMessage(
  reason: Variant<
    AgentOperationsSnapshot["commerceExceptions"],
    "unavailable"
  >["reason"],
): string {
  switch (reason) {
    case "commerce_system_unavailable":
      return "Connect a commerce system to load actionable exceptions.";
    case "resolution_unsupported":
      return "This commerce system does not support governed tracking attachment yet.";
    case "entity_plane_unavailable":
      return "Commerce exceptions could not be refreshed. Try again.";
    default:
      return assertNever(reason, "Unhandled automation value");
  }
}

function formatOperationsDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function OperationsQueue(props: {
  readonly actionLedger: readonly ActionLedgerActivity[];
  readonly loadAction: (actionNonce: string) => Promise<void>;
  readonly canDecide: boolean;
  readonly busy: boolean;
}): React.ReactNode {
  if (props.actionLedger.length === 0) {
    return (
      <EmptyState
        title="Nothing to approve yet"
        detail="Changes that need your approval appear here, with the recent activity behind them."
      />
    );
  }
  const attention = props.actionLedger.filter(actionLedgerNeedsAttention);
  const recent = props.actionLedger.filter(actionLedgerIsRecent).slice(0, 8);
  const expired = props.actionLedger.filter(actionLedgerIsExpired);
  return (
    <div className="action-inbox">
      <section aria-labelledby="operations-approvals-title">
        <div className="action-section-heading">
          <h3 id="operations-approvals-title">Approvals</h3>
          <span>{attention.length}</span>
        </div>
        <WorkQueue
          label="Approvals needing a decision"
          items={attention.map(
            buildActionLedgerItem.bind(
              null,
              props.loadAction,
              props.canDecide,
              props.busy,
            ),
          )}
          empty={<p className="quiet-success">You’re all caught up.</p>}
        />
      </section>
      <section aria-labelledby="operations-recent-title">
        <div className="action-section-heading">
          <h3 id="operations-recent-title">Recent activity</h3>
        </div>
        <WorkQueue
          label="Recent operations"
          items={recent.map(
            buildActionLedgerItem.bind(
              null,
              props.loadAction,
              props.canDecide,
              props.busy,
            ),
          )}
          empty={<p className="empty-state">No completed actions yet.</p>}
        />
      </section>
      {expired.length === 0 ? null : (
        <details className="past-actions">
          <summary>
            Expired proposals <span>{expired.length}</span>
          </summary>
          <WorkQueue
            label="Expired proposals"
            items={expired.map(
              buildActionLedgerItem.bind(
                null,
                props.loadAction,
                props.canDecide,
                props.busy,
              ),
            )}
            empty={<p className="empty-state">No expired proposals.</p>}
          />
        </details>
      )}
    </div>
  );
}

function buildActionLedgerItem(
  loadAction: (actionNonce: string) => Promise<void>,
  canDecide: boolean,
  busy: boolean,
  item: ActionLedgerActivity,
): WorkItemData {
  const requiresReview = actionLedgerNeedsAttention(item);
  return {
    id: item.action.nonce.value,
    title: commerceActionTitle(item.action.verb),
    summary: (
      <>
        <span>{commerceActionSummary(item.action.verb)}</span>
        {renderActionLedgerOutcome(item)}
        {item.action.verb === "commerce.order.cancel" ? (
          <p>
            Refund amount:{" "}
            <strong>{formatCommerceActionAmount(item.action.amount)}</strong>
          </p>
        ) : null}
      </>
    ),
    state: actionLedgerItemState(item),
    due: {
      kind: "scheduled",
      label: new Date(item.updatedAt).toLocaleString(),
      dateTime: new Date(item.updatedAt).toISOString(),
    },
    facts: [],
    target: { kind: "static" },
    action: {
      kind: "button",
      label:
        requiresReview && canDecide
          ? "Review change"
          : requiresReview
            ? "Inspect change"
            : "Inspect outcome",
      onActivate: runAsync.bind(
        null,
        loadAction.bind(null, item.action.nonce.value),
      ),
      disabled: busy,
    },
  };
}

function actionLedgerItemState(item: ActionLedgerActivity): WorkItemState {
  switch (item.state) {
    case "proposed":
    case "approval_requested":
    case "failed":
    case "indeterminate":
      return { kind: "blocked", label: commerceActionStateLabel(item.state) };
    case "signed":
    case "executing":
      return {
        kind: "in_progress",
        label: commerceActionStateLabel(item.state),
      };
    case "confirmed":
    case "rejected":
    case "expired":
      return { kind: "complete", label: commerceActionStateLabel(item.state) };
    default:
      return assertNever(item.state, "Unhandled automation value");
  }
}

function renderActionLedgerOutcome(
  item: ActionLedgerActivity,
): React.ReactNode {
  const receipt = item.commerceEffect?.receipt ?? null;
  if (receipt !== null)
    return <p>The commerce engine recorded the {receipt.outcome} mutation.</p>;
  return item.providerResult === null ? null : (
    <p>The provider result is recorded for review.</p>
  );
}

function actionLedgerNeedsAttention(item: ActionLedgerActivity): boolean {
  return (
    item.state === "proposed" ||
    item.state === "approval_requested" ||
    item.state === "signed" ||
    item.state === "failed" ||
    item.state === "indeterminate"
  );
}

function actionLedgerIsRecent(item: ActionLedgerActivity): boolean {
  return !actionLedgerNeedsAttention(item) && item.state !== "expired";
}

function actionLedgerIsExpired(item: ActionLedgerActivity): boolean {
  return item.state === "expired";
}

function commerceActionSummary(verb: string): string {
  switch (verb) {
    case "commerce.catalog.publish":
      return "Publish this catalog listing to its sales channel.";
    case "commerce.order.cancel":
      return "Cancel this customer order.";
    case "commerce.fulfillment.attach_tracking":
      return "Attach the approved tracking reference and hand this fulfillment to the carrier.";
    default:
      return "Apply this commerce change after approval.";
  }
}
