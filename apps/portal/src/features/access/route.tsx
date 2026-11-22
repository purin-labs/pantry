import { CaseScreenObservations } from "./case-screen-observations";
import React from "react";
import { ArrowLeft } from "lucide-react";
import { Link, useLocation } from "react-router";
import {
  readCustomConnectorAccessHandoff,
  type CustomConnectorAccessHandoff,
} from "./custom-operation-picker";

import { PageSkeleton } from "@purin-labs/ui/page-components";
import { AccessCheckPanel } from "./access-check";
import { CapabilityListView } from "./capability-policy";
import {
  DestinationCheckDialog,
  SourcePolicyListView,
  type DataFlowCheck,
} from "./data-flow";
import { ApplyDefaultsDialog } from "./defaults-dialog";
import { ExplanationPanel } from "./decision-explanation";
import type { FileResourcePickerTransport } from "./file-resource-picker";
import {
  GrantAccessDialog,
  RevokeGrantDialog,
  type GrantDraft,
} from "./grant-dialog";
import { AiBudgetSection } from "./ai-budget";
import { RelatedCases } from "./related-cases";
import { SystemAccessView } from "./system-access";
import {
  capabilityBelongsToSystem,
  type AccessSystem,
} from "./system-access-model";
import type {
  AccessControlCapabilityView,
  AccessControlGrantView,
  AccessControlOption,
  AccessControlSourcePolicyView,
  AccessControlView,
  AccessGrantTargetSelection,
  AccessExplainRequest,
  AccessExplainResult,
  AccessError,
  AccessResult,
  AccessMutationCommand,
  AccessOptionsPage,
  AccessRouteContent,
  AccessRouteLoadState,
  AccessRouteTransport,
  AccessSubview,
  FileResourceAccount,
} from "@purin-labs/control-api/portal/access-models";
import { assertNever } from "@purin-labs/std";
import { AgentPermissionRequestPrompt } from "./agent-permission-request";
import { HeldOutputPrompt } from "./held-output-prompt";
import { PermissionRequestQueue } from "./permission-request-queue";
import { refreshPermissionRequests } from "./permission-requests-summary";
import { AiBudgetRaisePrompt } from "./ai-budget-raise";

type AccessRouteProps = Readonly<{
  organisationId: string;
  subview: AccessSubview;
  paths: Readonly<Record<AccessSubview, string>>;
  integrationsPath: string | null;
  refreshKey: string;
  transport: AccessRouteTransport;
}>;

type AccessContent = AccessRouteLoadState;

type MutationState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "complete"; message: string }>
  | Readonly<{ kind: "failed"; message: string }>;

export function AccessRoute(props: AccessRouteProps): React.ReactNode {
  const [content, setContent] = React.useState<AccessContent>({
    kind: "loading",
  });
  const [mutation, setMutation] = React.useState<MutationState>({
    kind: "idle",
  });
  const [loadingMore, setLoadingMore] = React.useState<
    "grants" | "sources" | null
  >(null);
  const [grantDialogOpen, setGrantDialogOpen] = React.useState(false);
  const location = useLocation();
  const [initialCustomConnector, setInitialCustomConnector] =
    React.useState<CustomConnectorAccessHandoff | null>(null);
  const openedCustomHandoff = React.useRef("");
  const [initialFileProvider, setInitialFileProvider] = React.useState(
    readBrowserInitialFileProvider,
  );
  const [defaultsDialogOpen, setDefaultsDialogOpen] = React.useState(false);
  const [revokeGrant, setRevokeGrant] =
    React.useState<AccessControlGrantView | null>(null);
  const [destinationDialogOpen, setDestinationDialogOpen] =
    React.useState(false);
  const [destinationSources, setDestinationSources] = React.useState<
    readonly AccessControlSourcePolicyView[]
  >([]);
  const [resourceOptions, setResourceOptions] = React.useState<
    readonly AccessControlOption[]
  >([]);
  const [selectedSources, setSelectedSources] = React.useState<
    ReadonlySet<string>
  >(new Set());
  const [explanation, setExplanation] =
    React.useState<AccessExplainResult | null>(null);
  const [grantSystem, setGrantSystem] = React.useState<AccessSystem | null>(
    null,
  );
  const [checkOpen, setCheckOpen] = React.useState(false);
  const [aiBudgetRaiseClosed, setAiBudgetRaiseClosed] = React.useState(false);
  const [closedPermissionRequest, setClosedPermissionRequest] = React.useState<
    string | null
  >(null);
  // A request opened from the waiting list, not from a link.
  const [reviewedRequest, setReviewedRequest] = React.useState<string | null>(
    null,
  );
  const [closedHeldOutput, setClosedHeldOutput] = React.useState<string | null>(
    null,
  );
  const [reviewedHeldOutput, setReviewedHeldOutput] = React.useState<
    string | null
  >(null);
  const loadRevision = React.useRef(0);
  const grantTrigger = React.useRef<HTMLButtonElement | null>(null);
  const initialFileSetupOpened = React.useRef(false);

  React.useEffect(startLoad.bind(null, props, loadRevision, setContent), [
    props.organisationId,
    props.subview,
    props.refreshKey,
    props.transport,
  ]);
  React.useEffect(
    openInitialFileGrant.bind(
      null,
      content,
      initialFileProvider,
      initialFileSetupOpened,
      setGrantDialogOpen,
      setMutation,
    ),
    [content, initialFileProvider],
  );

  React.useEffect(
    openCustomConnectorGrant.bind(
      null,
      location.search,
      content,
      openedCustomHandoff,
      setInitialCustomConnector,
      setGrantDialogOpen,
    ),
    [location.search, content],
  );

  if (content.kind === "loading")
    return <PageSkeleton label="Loading access and data flow" />;
  if (content.kind === "failed") {
    return (
      <section
        className="portal-band access35-load-failure"
        aria-labelledby="access35-load-failure-title"
      >
        <h2 id="access35-load-failure-title">
          Access controls are unavailable
        </h2>
        <p role="alert">
          {accessProblem(content.error, "Refresh the page and try again.")}
        </p>
        <button
          type="button"
          onClick={beginLoad.bind(null, props, loadRevision, setContent)}
        >
          Try again
        </button>
      </section>
    );
  }
  if (content.kind !== "ready")
    return assertNever(content, "Unhandled access subview");

  const { view, subjects, integrations, cases } = content;
  const linkedRequestId = readPermissionRequestId(location.search);
  const permissionRequestId =
    reviewedRequest ??
    (linkedRequestId !== closedPermissionRequest ? linkedRequestId : null);
  const linkedHeldOutput = readHeldOutputId(location.search);
  const heldOutputId =
    reviewedHeldOutput ??
    (linkedHeldOutput !== closedHeldOutput ? linkedHeldOutput : null);
  const aiBudgetRaise =
    new URLSearchParams(location.search).get("aiBudget") === "raise";
  const emptyMessage = emptySubviewMessage(props.subview, view);
  const busy = mutation.kind === "busy";
  const destinations = destinationOptions(subjects);
  return (
    <div className="access35-page">
      {permissionRequestId !== null ? (
        <AgentPermissionRequestPrompt
          key={permissionRequestId}
          organisationId={props.organisationId}
          requestId={permissionRequestId}
          workspaceName={view.organisation.name}
          access={props.transport}
          onClose={
            reviewedRequest !== null
              ? setReviewedRequest.bind(null, null)
              : setClosedPermissionRequest.bind(null, permissionRequestId)
          }
          onDecided={afterPermissionDecision.bind(
            null,
            props,
            loadRevision,
            setContent,
          )}
        />
      ) : null}
      {heldOutputId !== null ? (
        <HeldOutputPrompt
          key={heldOutputId}
          organisationId={props.organisationId}
          requestId={heldOutputId}
          workspaceName={view.organisation.name}
          onClose={
            reviewedHeldOutput !== null
              ? setReviewedHeldOutput.bind(null, null)
              : setClosedHeldOutput.bind(null, heldOutputId)
          }
          onDecided={() => refreshPermissionRequests(props.organisationId)}
        />
      ) : null}
      {aiBudgetRaise && !aiBudgetRaiseClosed ? (
        <AiBudgetRaisePrompt
          organisationId={props.organisationId}
          workspaceName={view.organisation.name}
          access={props.transport}
          onClose={setAiBudgetRaiseClosed.bind(null, true)}
        />
      ) : null}
      <p
        className="access35-live-status"
        role={mutation.kind === "failed" ? "alert" : "status"}
      >
        {mutationMessage(mutation)}
      </p>
      {props.subview === "access" ? null : (
        <Link className="access35-back-link" to={props.paths.access}>
          <ArrowLeft aria-hidden="true" size={16} />
          Access
        </Link>
      )}
      {props.subview === "access" ? (
        <PermissionRequestQueue
          organisationId={props.organisationId}
          onReview={setReviewedRequest}
          onReviewHeld={setReviewedHeldOutput}
        />
      ) : null}
      {props.subview === "access" ? (
        <SystemAccessView
          view={view}
          capabilitiesPath={props.paths.capabilities}
          integrationsPath={props.integrationsPath}
          checkOpen={checkOpen}
          closeCheck={setCheckOpen.bind(null, false)}
          checkPanel={
            checkOpen ? (
              <>
                <AccessCheckPanel
                  sources={view.sourceFlowPolicies.items}
                  authorities={subjects}
                  destinations={destinations}
                  busy={busy}
                  moreChecksPath={props.paths.data_flow}
                  leave={setCheckOpen.bind(null, false)}
                  submit={checkConversationDelivery.bind(
                    null,
                    props,
                    setMutation,
                    setDestinationDialogOpen,
                    setExplanation,
                  )}
                />
                <div className="access35-check-result">
                  <ExplanationPanel
                    explanation={explanation}
                    close={setExplanation.bind(null, null)}
                  />
                </div>
              </>
            ) : null
          }
          onOpenCheck={setCheckOpen.bind(null, true)}
          onShare={shareSystem.bind(
            null,
            view,
            grantTrigger,
            initialFileSetupOpened,
            setGrantDialogOpen,
            setMutation,
            setInitialFileProvider,
            setGrantSystem,
          )}
          onRevoke={setRevokeGrant}
          onApplyDefaults={setDefaultsDialogOpen.bind(null, true)}
          loadMore={loadMorePage.bind(
            null,
            props,
            setContent,
            setMutation,
            setLoadingMore,
            view,
            "grants",
          )}
          loadingMore={loadingMore === "grants"}
        />
      ) : emptyMessage !== null ? (
        <AccessEmptyState subview={props.subview} message={emptyMessage} />
      ) : props.subview === "capabilities" ? (
        <CapabilityListView
          view={view}
          initialSearch={readActionSearch(location.search)}
          busy={busy}
          integrationsPath={props.integrationsPath}
          changeMode={changeCapabilityMode.bind(
            null,
            props,
            loadRevision,
            setContent,
            setMutation,
            view,
          )}
          applyDefaults={setDefaultsDialogOpen.bind(null, true)}
        />
      ) : (
        <SourcePolicyListView
          view={view}
          accessPath={props.paths.access}
          selectedSourceRefs={selectedSources}
          toggleSource={toggleSource.bind(
            null,
            selectedSources,
            setSelectedSources,
          )}
          checkSource={openSingleSourceCheck.bind(
            null,
            setDestinationSources,
            setDestinationDialogOpen,
          )}
          loadMore={loadMorePage.bind(
            null,
            props,
            setContent,
            setMutation,
            setLoadingMore,
            view,
            "sources",
          )}
          loadingMore={loadingMore === "sources"}
        />
      )}
      {props.subview === "data_flow" && selectedSources.size > 0 ? (
        <div className="access35-combined-check">
          <p>
            {selectedSources.size} protected{" "}
            {selectedSources.size === 1 ? "source" : "sources"} selected.
          </p>
          <button
            type="button"
            onClick={openCombinedSourceCheck.bind(
              null,
              view.sourceFlowPolicies.items,
              selectedSources,
              setDestinationSources,
              setDestinationDialogOpen,
            )}
          >
            Check selected sources
          </button>
        </div>
      ) : null}
      {props.subview === "access" ? null : (
        <ExplanationPanel
          explanation={explanation}
          close={setExplanation.bind(null, null)}
        />
      )}
      {props.subview === "access" ? (
        <AiBudgetSection
          organisationId={props.organisationId}
          transport={props.transport}
        />
      ) : null}
      {props.subview === "data_flow" ? (
        <RelatedCases
          key={`${props.organisationId}:${view.revision}:${props.refreshKey}`}
          organisationId={props.organisationId}
          cases={cases}
          transport={props.transport}
          canReview={
            view.organisation.requesterRole === "owner" ||
            view.organisation.requesterRole === "admin"
          }
        />
      ) : null}
      {props.subview === "data_flow" ? (
        <CaseScreenObservations
          key={`screen:${props.organisationId}:${view.revision}:${props.refreshKey}`}
          organisationId={props.organisationId}
          cases={cases}
          transport={props.transport}
        />
      ) : null}
      <GrantAccessDialog
        organisationId={props.organisationId}
        initialCustomConnector={initialCustomConnector}
        problem={mutation.kind === "failed" ? mutation.message : null}
        open={grantDialogOpen}
        busy={busy}
        initialFileProvider={initialFileProvider}
        initialSubjectRef={preferredFileSubjectRef(subjects)}
        scopeLabel={grantSystem === null ? null : grantSystem.label}
        capabilities={grantCapabilities(view, grantSystem)}
        subjects={subjects}
        integrations={integrations}
        integrationProviders={integrationProviderMap(view)}
        integrationsPath={props.integrationsPath}
        resources={resourceOptions}
        fileAccounts={fileResourceAccounts(view, initialFileProvider)}
        filePicker={bindFileResourcePicker(
          props.transport,
          props.organisationId,
        )}
        close={closeGrantDialog.bind(
          null,
          setGrantDialogOpen,
          grantTrigger,
          setInitialFileProvider,
          setInitialCustomConnector,
          setGrantSystem,
        )}
        chooseCapability={selectCapabilityResources.bind(
          null,
          props,
          setResourceOptions,
          setMutation,
          view,
        )}
        chooseIntegration={loadResourceOptions.bind(
          null,
          props,
          setResourceOptions,
          setMutation,
        )}
        submit={createGrant.bind(
          null,
          props,
          loadRevision,
          setContent,
          setMutation,
          setGrantDialogOpen,
          grantTrigger,
          setInitialFileProvider,
          setInitialCustomConnector,
          setGrantSystem,
          view,
        )}
      />
      <ApplyDefaultsDialog
        open={defaultsDialogOpen}
        busy={busy}
        close={setDefaultsDialogOpen.bind(null, false)}
        apply={applyDefaults.bind(
          null,
          props,
          loadRevision,
          setContent,
          setMutation,
          setDefaultsDialogOpen,
          view,
        )}
      />
      <RevokeGrantDialog
        grant={revokeGrant}
        busy={busy}
        close={setRevokeGrant.bind(null, null)}
        revoke={revokeAccess.bind(
          null,
          props,
          loadRevision,
          setContent,
          setMutation,
          setRevokeGrant,
          view,
        )}
      />
      <DestinationCheckDialog
        open={destinationDialogOpen}
        busy={busy}
        sources={destinationSources}
        authorities={subjects}
        destinations={destinations}
        targetGrants={toolEffectTargetGrants(view)}
        cases={cases}
        close={setDestinationDialogOpen.bind(null, false)}
        submit={checkDataFlow.bind(
          null,
          props,
          setMutation,
          setDestinationDialogOpen,
          setExplanation,
          destinationSources,
        )}
      />
    </div>
  );
}

/** Read the waiting requests and the Access view again after a decision. */
function afterPermissionDecision(
  props: AccessRouteProps,
  revision: React.MutableRefObject<number>,
  setContent: React.Dispatch<React.SetStateAction<AccessContent>>,
): Promise<boolean> {
  void refreshPermissionRequests(props.organisationId);
  return beginLoad(props, revision, setContent);
}

async function beginLoad(
  props: AccessRouteProps,
  revision: React.MutableRefObject<number>,
  setContent: React.Dispatch<React.SetStateAction<AccessContent>>,
): Promise<boolean> {
  const current = revision.current + 1;
  revision.current = current;
  setContent({ kind: "loading" });
  try {
    const loaded = await loadAccessRouteContent(props);
    if (revision.current !== current) return false;
    if (loaded.ok) {
      setContent({ kind: "ready", ...loaded.value });
      return true;
    } else {
      setContent({ kind: "failed", error: loaded.error });
      return false;
    }
  } catch {
    if (revision.current !== current) return false;
    setContent({ kind: "failed", error: accessFailure() });
    return false;
  }
}

async function loadAccessRouteContent(
  props: Pick<AccessRouteProps, "organisationId" | "subview" | "transport">,
): Promise<AccessResult<AccessRouteContent>> {
  const viewResult = await props.transport.read(
    props.organisationId,
    null,
    null,
  );
  if (!viewResult.ok) return viewResult;
  const view = viewResult.value;
  switch (props.subview) {
    case "capabilities":
      return {
        ok: true,
        value: { view, subjects: [], integrations: [], cases: [] },
      };
    case "access": {
      const [subjects, integrations] = await Promise.all([
        readOptionsOrFallback(
          props.transport,
          props.organisationId,
          "subjects",
          existingConversationSubjectOptions(view),
        ),
        readOptionsOrFallback(
          props.transport,
          props.organisationId,
          "resources",
          [],
        ),
      ]);
      if (!subjects.ok) return subjects;
      if (!integrations.ok) return integrations;
      return {
        ok: true,
        value: {
          view,
          subjects: subjects.value,
          integrations: integrations.value,
          cases: [],
        },
      };
    }
    case "data_flow": {
      const [subjects, cases] = await Promise.all([
        readOptionsOrFallback(
          props.transport,
          props.organisationId,
          "subjects",
          existingConversationSubjectOptions(view),
        ),
        readOptionsOrFallback(
          props.transport,
          props.organisationId,
          "cases",
          [],
        ),
      ]);
      if (!subjects.ok) return subjects;
      if (!cases.ok) return cases;
      return {
        ok: true,
        value: {
          view,
          subjects: subjects.value,
          integrations: [],
          cases: cases.value,
        },
      };
    }
    default:
      return assertNever(props.subview, "Unhandled access subview");
  }
}

async function readOptionsOrFallback(
  transport: AccessRouteTransport,
  organisationId: string,
  kind: "subjects" | "resources" | "cases",
  fallback: readonly AccessControlOption[],
): Promise<AccessResult<readonly AccessControlOption[]>> {
  const result = await readAllOptions(transport, organisationId, kind, null);
  if (result.ok) return { ok: true, value: result.value.items };
  if (result.error.kind === "network") {
    return { ok: true, value: fallback };
  }
  return result;
}

function emptySubviewMessage(
  subview: AccessSubview,
  view: AccessControlView,
): string | null {
  switch (subview) {
    case "access":
      return view.grants.items.length === 0
        ? "No access grants are configured for this workspace yet."
        : null;
    case "capabilities":
      return view.capabilities.length === 0
        ? "No capabilities are available for this workspace yet."
        : null;
    case "data_flow":
      return view.sourceFlowPolicies.items.length === 0
        ? "No protected information sources are configured for this workspace yet."
        : null;
    default:
      return assertNever(subview, "Unhandled access subview");
  }
}

function AccessEmptyState(
  props: Readonly<{
    subview: AccessSubview;
    message: string;
  }>,
): React.ReactNode {
  return (
    <section
      className="portal-band access35-empty-state"
      aria-labelledby="access35-empty-state-title"
    >
      <h2 id="access35-empty-state-title">
        {emptySubviewTitle(props.subview)}
      </h2>
      <p>{props.message}</p>
    </section>
  );
}

function emptySubviewTitle(subview: AccessSubview): string {
  switch (subview) {
    case "access":
      return "No access grants yet";
    case "capabilities":
      return "No capabilities yet";
    case "data_flow":
      return "No protected sources yet";
    default:
      return assertNever(subview, "Unhandled access subview");
  }
}

function accessFailure(): AccessError {
  return {
    kind: "internal",
    message: "Access control request failed. Try again.",
  };
}

function existingConversationSubjectOptions(
  view: AccessControlView,
): readonly AccessControlOption[] {
  const seen = new Set<string>();
  const options: AccessControlOption[] = [];
  for (const grant of view.grants.items) {
    if (
      grant.subject.kind !== "conversation" ||
      seen.has(grant.subject.subjectRefId)
    )
      continue;
    seen.add(grant.subject.subjectRefId);
    options.push({
      kind: "conversation",
      refId: grant.subject.subjectRefId,
      revision: 1,
      label: grant.subject.label,
      detail: "Conversation",
      availability: grant.subject.availability,
    });
  }
  return options;
}

function startLoad(
  props: AccessRouteProps,
  revision: React.MutableRefObject<number>,
  setContent: React.Dispatch<React.SetStateAction<AccessContent>>,
): void {
  void beginLoad(props, revision, setContent);
}

async function refreshAfterMutation(
  props: AccessRouteProps,
  revision: React.MutableRefObject<number>,
  setContent: React.Dispatch<React.SetStateAction<AccessContent>>,
  setMutation: React.Dispatch<React.SetStateAction<MutationState>>,
  message: string,
): Promise<boolean> {
  const refreshed = await beginLoad(props, revision, setContent);
  if (refreshed) setMutation({ kind: "complete", message });
  return refreshed;
}

async function runMutation(
  props: AccessRouteProps,
  revision: React.MutableRefObject<number>,
  setContent: React.Dispatch<React.SetStateAction<AccessContent>>,
  setMutation: React.Dispatch<React.SetStateAction<MutationState>>,
  command: AccessMutationCommand,
  successMessage: string,
): Promise<boolean> {
  setMutation({ kind: "busy" });
  const result = await props.transport.mutate(props.organisationId, command);
  if (!result.ok) {
    setMutation({
      kind: "failed",
      message: accessProblem(
        result.error,
        "Refresh the controls and try again.",
      ),
    });
    return false;
  }
  return refreshAfterMutation(
    props,
    revision,
    setContent,
    setMutation,
    successMessage,
  );
}

async function createGrant(
  props: AccessRouteProps,
  revision: React.MutableRefObject<number>,
  setContent: React.Dispatch<React.SetStateAction<AccessContent>>,
  setMutation: React.Dispatch<React.SetStateAction<MutationState>>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  trigger: React.RefObject<HTMLButtonElement | null>,
  setInitialFileProvider: React.Dispatch<
    React.SetStateAction<FileResourceAccount["provider"] | null>
  >,
  setInitialCustomConnector: React.Dispatch<
    React.SetStateAction<CustomConnectorAccessHandoff | null>
  >,
  setGrantSystem: React.Dispatch<React.SetStateAction<AccessSystem | null>>,
  view: AccessControlView,
  draft: GrantDraft,
): Promise<void> {
  const target = grantTarget(draft);
  if (!target.ok || draft.subject.revision === null) {
    setMutation({
      kind: "failed",
      message: target.ok
        ? "Choose a current subject and try again."
        : target.message,
    });
    return;
  }
  const complete = await runMutation(
    props,
    revision,
    setContent,
    setMutation,
    {
      kind: "create_grant",
      expectedRevision: view.revision,
      subjectRef: {
        subjectRefId: draft.subject.refId,
        revision: draft.subject.revision,
      },
      target: target.value,
    },
    "Access granted.",
  );
  if (complete)
    closeGrantDialog(
      setOpen,
      trigger,
      setInitialFileProvider,
      setInitialCustomConnector,
      setGrantSystem,
    );
}

async function revokeAccess(
  props: AccessRouteProps,
  revision: React.MutableRefObject<number>,
  setContent: React.Dispatch<React.SetStateAction<AccessContent>>,
  setMutation: React.Dispatch<React.SetStateAction<MutationState>>,
  setGrant: React.Dispatch<React.SetStateAction<AccessControlGrantView | null>>,
  view: AccessControlView,
  grant: AccessControlGrantView,
): Promise<void> {
  const complete = await runMutation(
    props,
    revision,
    setContent,
    setMutation,
    {
      kind: "revoke_grant",
      expectedRevision: view.revision,
      grantId: grant.grantId,
      grantRevision: grant.revision,
      reason: "Revoked after operator review.",
    },
    "Access revoked.",
  );
  if (complete) setGrant(null);
}

async function changeCapabilityMode(
  props: AccessRouteProps,
  revision: React.MutableRefObject<number>,
  setContent: React.Dispatch<React.SetStateAction<AccessContent>>,
  setMutation: React.Dispatch<React.SetStateAction<MutationState>>,
  view: AccessControlView,
  capability: AccessControlCapabilityView,
  mode: AccessControlCapabilityView["mode"],
): Promise<void> {
  if (!confirmCapabilityModeChange(capability, mode)) return;
  await runMutation(
    props,
    revision,
    setContent,
    setMutation,
    {
      kind: "change_capability_mode",
      expectedRevision: view.revision,
      capabilityId: capability.definition.capabilityId,
      capabilityVersion: capability.definition.capabilityVersion,
      capabilityRevision: capability.revision,
      mode,
    },
    `${capability.definition.label} is now ${mode.replaceAll("_", " ")}.`,
  );
}

function confirmCapabilityModeChange(
  capability: AccessControlCapabilityView,
  mode: AccessControlCapabilityView["mode"],
): boolean {
  if (mode !== "disabled" || capability.activeGrantCount === 0) return true;
  return window.confirm(
    `Turn off ${capability.definition.label}? It stops at once for everyone it is shared with. The shares stay listed.`,
  );
}

async function applyDefaults(
  props: AccessRouteProps,
  revision: React.MutableRefObject<number>,
  setContent: React.Dispatch<React.SetStateAction<AccessContent>>,
  setMutation: React.Dispatch<React.SetStateAction<MutationState>>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  view: AccessControlView,
): Promise<void> {
  const complete = await runMutation(
    props,
    revision,
    setContent,
    setMutation,
    {
      kind: "apply_defaults",
      expectedRevision: view.revision,
    },
    "Recommended access applied.",
  );
  if (complete) setOpen(false);
}

function integrationProviderMap(
  view: AccessControlView,
): ReadonlyMap<string, string> {
  const providers = new Map<string, string>();
  for (const integration of view.integrationResources) {
    providers.set(
      `integration:${integration.integrationAccountId}`,
      integration.provider,
    );
  }
  return providers;
}

async function loadResourceOptions(
  props: AccessRouteProps,
  setResources: React.Dispatch<
    React.SetStateAction<readonly AccessControlOption[]>
  >,
  setMutation: React.Dispatch<React.SetStateAction<MutationState>>,
  integration: AccessControlOption | null,
): Promise<void> {
  setResources([]);
  if (integration === null) return;
  const result = await readAllOptions(
    props.transport,
    props.organisationId,
    "resources",
    integration.refId,
  );
  if (result.ok) {
    setResources(readOptionItems(result.value));
  } else {
    setMutation({
      kind: "failed",
      message: accessProblem(
        result.error,
        "Reconnect the account or choose another resource.",
      ),
    });
  }
}

async function readAllOptions(
  transport: AccessRouteTransport,
  organisationId: string,
  kind: "subjects" | "resources" | "cases" | "commerce_targets",
  integrationRef: string | null,
): Promise<AccessResult<AccessOptionsPage>> {
  const items: AccessControlOption[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const result = await transport.readOptions(
      organisationId,
      kind,
      "",
      cursor,
      integrationRef,
    );
    if (!result.ok) return result;
    items.push(...result.value.items);
    cursor = result.value.nextCursor;
    pages += 1;
    if (pages > 20) {
      return {
        ok: false,
        error: {
          kind: "internal",
          message: "The access option list is too large to load safely.",
        },
      };
    }
  } while (cursor !== null);
  return { ok: true, value: { items, nextCursor: null } };
}

function readOptionItems(
  page: Readonly<{ items: readonly AccessControlOption[] }>,
): readonly AccessControlOption[] {
  return page.items;
}

async function loadMorePage(
  props: AccessRouteProps,
  setContent: React.Dispatch<React.SetStateAction<AccessContent>>,
  setMutation: React.Dispatch<React.SetStateAction<MutationState>>,
  setLoading: React.Dispatch<React.SetStateAction<"grants" | "sources" | null>>,
  view: AccessControlView,
  kind: "grants" | "sources",
): Promise<void> {
  const cursor =
    kind === "grants"
      ? view.grants.nextCursor
      : view.sourceFlowPolicies.nextCursor;
  if (cursor === null) return;
  setLoading(kind);
  try {
    const result = await props.transport.read(
      props.organisationId,
      kind === "grants" ? cursor : null,
      kind === "sources" ? cursor : null,
    );
    if (result.ok) {
      setContent(mergeMorePage.bind(null, kind, result.value));
    } else {
      setMutation({
        kind: "failed",
        message: accessProblem(result.error, "Refresh the page and try again."),
      });
    }
  } finally {
    setLoading(null);
  }
}

function mergeMorePage(
  kind: "grants" | "sources",
  next: AccessControlView,
  current: AccessContent,
): AccessContent {
  switch (current.kind) {
    case "loading":
    case "failed":
      return current;
    case "ready":
      return { kind: "ready", ...mergeLoadedPage(kind, next, current) };
    default:
      return assertNever(current, "Unhandled access subview");
  }
}

function mergeLoadedPage(
  kind: "grants" | "sources",
  next: AccessControlView,
  current: AccessRouteContent,
): AccessRouteContent {
  if (current.view.revision !== next.revision) return current;
  const view =
    kind === "grants"
      ? {
          ...current.view,
          grants: {
            items: [...current.view.grants.items, ...next.grants.items],
            nextCursor: next.grants.nextCursor,
          },
        }
      : {
          ...current.view,
          sourceFlowPolicies: {
            items: [
              ...current.view.sourceFlowPolicies.items,
              ...next.sourceFlowPolicies.items,
            ],
            nextCursor: next.sourceFlowPolicies.nextCursor,
          },
        };
  return {
    view,
    subjects: current.subjects,
    integrations: current.integrations,
    cases: current.cases,
  };
}

async function checkDataFlow(
  props: AccessRouteProps,
  setMutation: React.Dispatch<React.SetStateAction<MutationState>>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  setExplanation: React.Dispatch<
    React.SetStateAction<AccessExplainResult | null>
  >,
  sources: readonly AccessControlSourcePolicyView[],
  check: DataFlowCheck,
): Promise<void> {
  const question = dataFlowQuestion(sources, check);
  if (question === null) {
    setMutation({
      kind: "failed",
      message: "Choose current sources, subjects, and targets, then try again.",
    });
    return;
  }
  setMutation({ kind: "busy" });
  const result = await props.transport.explain(props.organisationId, question);
  if (!result.ok) {
    setMutation({
      kind: "failed",
      message: accessProblem(
        result.error,
        "Choose current sources and try again.",
      ),
    });
    return;
  }
  setExplanation(result.value);
  setOpen(false);
  setMutation({ kind: "complete", message: "Data-flow check complete." });
}

function dataFlowQuestion(
  sources: readonly AccessControlSourcePolicyView[],
  check: DataFlowCheck,
): AccessExplainRequest | null {
  if (check.authority.revision === null || sources.length === 0) return null;
  const authoritySubjectRef = {
    subjectRefId: check.authority.refId,
    revision: check.authority.revision,
  };
  switch (check.kind) {
    case "conversation_delivery": {
      if (check.destination.revision === null) return null;
      if (check.destination.kind === "conversation") {
        return {
          kind: check.kind,
          authoritySubjectRef,
          sourceRefs: sourceReferences(sources),
          destination: {
            kind: "conversation",
            conversationRefId: check.destination.refId,
            revision: check.destination.revision,
          },
        };
      }
      return check.destination.kind === "workflow"
        ? {
            kind: check.kind,
            authoritySubjectRef,
            sourceRefs: sourceReferences(sources),
            destination: {
              kind: "workflow",
              workflowRefId: check.destination.refId,
              revision: check.destination.revision,
            },
          }
        : null;
    }
    case "tool_effect":
      return {
        kind: check.kind,
        authoritySubjectRef,
        sourceRefs: sourceReferences(sources),
        capabilityRef: {
          capabilityId: check.targetGrant.capability.capabilityId,
          capabilityVersion: check.targetGrant.capability.capabilityVersion,
        },
        targetRef: {
          targetRefId: check.targetGrant.resource.targetRefId,
          revision: check.targetGrant.resource.revision,
        },
        approvalState: { kind: "not_required" },
      };
    case "context_read":
      const [sourceRef] = sourceReferences(sources);
      return sources.length === 1 &&
        sourceRef !== undefined &&
        check.caseOption.revision !== null
        ? {
            kind: check.kind,
            authoritySubjectRef,
            caseRef: {
              caseRefId: check.caseOption.refId,
              revision: check.caseOption.revision,
            },
            sourceRef,
          }
        : null;
  }
}

function grantTarget(
  draft: GrantDraft,
):
  | Readonly<{ ok: true; value: AccessGrantTargetSelection }>
  | Readonly<{ ok: false; message: string }> {
  const definition = draft.capability.definition;
  const capabilityRef = {
    capabilityId: definition.capabilityId,
    capabilityVersion: definition.capabilityVersion,
  };
  switch (draft.kind) {
    case "custom_connector_operation":
      if (
        definition.target !== draft.kind ||
        definition.capabilityId !== draft.selection.capabilityId
      )
        return grantTargetMismatch();
      return {
        ok: true,
        value: {
          kind: "custom_connector_operation",
          capabilityRef,
          integrationRef: `integration:${draft.selection.integrationAccountId}`,
          connectorId: draft.selection.connectorId,
          definitionRevision: draft.selection.definitionRevision,
          definitionDigest: draft.selection.definitionDigest,
          operationId: draft.selection.operationId,
        },
      };
    case "commerce_entity_type":
      return definition.target === "commerce_read"
        ? {
            ok: true,
            value: {
              kind: draft.kind,
              capabilityRef,
              entityTypeId: draft.entityTypeId,
            },
          }
        : grantTargetMismatch();
    case "platform":
      return definition.target === "platform"
        ? { ok: true, value: { kind: draft.kind, capabilityRef } }
        : grantTargetMismatch();
    case "provider_resource":
      return definition.target === draft.kind &&
        draft.integration.refId.startsWith("integration:") &&
        draft.resource.refId.startsWith("provider_resource:")
        ? {
            ok: true,
            value: {
              kind: draft.kind,
              capabilityRef,
              integrationRef: draft.integration.refId,
              resourceRef: draft.resource.refId,
            },
          }
        : grantTargetMismatch();
    case "file_resource":
      return definition.target === draft.kind &&
        draft.selection.integrationRef.startsWith("integration:")
        ? {
            ok: true,
            value: {
              kind: draft.kind,
              capabilityRef,
              integrationRef: draft.selection.integrationRef,
              scope: draft.selection.scope,
            },
          }
        : grantTargetMismatch();
    case "existing_target":
      return !isPublishedCommerceListEntryPatch(draft.capability) &&
        definition.target !== "platform" &&
        definition.target !== "provider_resource" &&
        definition.target !== "file_resource" &&
        draft.resource.kind === "access_target" &&
        draft.resource.revision !== null
        ? {
            ok: true,
            value: {
              kind: draft.kind,
              capabilityRef,
              targetRef: {
                targetRefId: draft.resource.refId,
                revision: draft.resource.revision,
              },
            },
          }
        : grantTargetMismatch();
    case "published_commerce_target":
      return isPublishedCommerceTargetCapability(draft.capability) &&
        ((definition.target === "commerce_command" &&
          isPublishedCommerceListEntryPatch(draft.capability)) ||
          (definition.target === "provider_resource" &&
            isCommerceActionPropose(draft.capability))) &&
        draft.resource.kind === "commerce_target" &&
        draft.resource.revision !== null
        ? {
            ok: true,
            value: {
              kind: draft.kind,
              capabilityRef,
              targetRef: {
                targetRefId: draft.resource.refId,
                revision: draft.resource.revision,
              },
            },
          }
        : grantTargetMismatch();
  }
}

function grantTargetMismatch(): Readonly<{ ok: false; message: string }> {
  return {
    ok: false,
    message: "Refresh the exact resource scopes and choose again.",
  };
}

async function selectCapabilityResources(
  props: AccessRouteProps,
  setResources: React.Dispatch<
    React.SetStateAction<readonly AccessControlOption[]>
  >,
  setMutation: React.Dispatch<React.SetStateAction<MutationState>>,
  view: AccessControlView,
  capability: AccessControlCapabilityView | null,
): Promise<void> {
  setResources([]);
  if (capability === null || capability.definition.target === "file_resource")
    return;
  if (isPublishedCommerceTargetCapability(capability)) {
    const result = await readAllOptions(
      props.transport,
      props.organisationId,
      "commerce_targets",
      null,
    );
    if (result.ok) {
      setResources(readOptionItems(result.value));
    } else {
      setMutation({
        kind: "failed",
        message: accessProblem(
          result.error,
          "Refresh the published commerce resources and try again.",
        ),
      });
    }
    return;
  }
  if (capability.definition.target === "provider_resource") return;
  setResources(existingTargetOptions(view, capability));
}

function isPublishedCommerceListEntryPatch(
  capability: AccessControlCapabilityView,
): boolean {
  return (
    capability.definition.capabilityId === "commerce.list_entry.patch" &&
    capability.definition.capabilityVersion === 1
  );
}

function isPublishedCommerceTargetCapability(
  capability: AccessControlCapabilityView,
): boolean {
  return (
    isPublishedCommerceListEntryPatch(capability) ||
    isCommerceActionPropose(capability)
  );
}

function isCommerceActionPropose(
  capability: AccessControlCapabilityView,
): boolean {
  return (
    capability.definition.capabilityId === "commerce.action.propose" &&
    capability.definition.capabilityVersion === 1
  );
}

function fileResourceAccounts(
  view: AccessControlView,
  provider: FileResourceAccount["provider"] | null,
): readonly FileResourceAccount[] {
  const accounts: FileResourceAccount[] = [];
  for (const integration of view.integrationResources) {
    if (integration.availability !== "available") continue;
    if (
      integration.provider === "dropbox" ||
      integration.provider === "google_drive"
    ) {
      if (provider !== null && integration.provider !== provider) continue;
      accounts.push({
        integrationAccountId: integration.integrationAccountId,
        provider: integration.provider,
        displayName: integration.displayName,
      });
    }
  }
  return accounts;
}

function bindFileResourcePicker(
  transport: AccessRouteTransport,
  organisationId: string,
): FileResourcePickerTransport {
  return {
    discoverDropbox: transport.discoverDropbox.bind(null, organisationId),
    pickGoogleDrive: transport.pickGoogleDrive.bind(null, organisationId),
  };
}

function existingTargetOptions(
  view: AccessControlView,
  capability: AccessControlCapabilityView,
): readonly AccessControlOption[] {
  const options: AccessControlOption[] = [];
  const seen = new Set<string>();
  for (const grant of view.grants.items) {
    if (
      grant.capability.capabilityId !== capability.definition.capabilityId ||
      grant.capability.capabilityVersion !==
        capability.definition.capabilityVersion ||
      seen.has(grant.resource.targetRefId)
    )
      continue;
    seen.add(grant.resource.targetRefId);
    options.push({
      kind: "access_target",
      refId: grant.resource.targetRefId,
      revision: grant.resource.revision,
      label: grant.resource.label,
      detail: "Existing exact access scope",
      availability:
        grant.lifecycle.kind === "active" ? "available" : "unavailable",
    });
  }
  return options;
}

function sourceReferences(sources: readonly AccessControlSourcePolicyView[]) {
  const refs: { sourceRefId: string; revision: number }[] = [];
  for (const source of sources)
    refs.push({ sourceRefId: source.sourceRefId, revision: source.revision });
  return refs;
}

function destinationOptions(
  options: readonly AccessControlOption[],
): readonly AccessControlOption[] {
  const destinations: AccessControlOption[] = [];
  for (const option of options) {
    if (option.kind === "conversation" || option.kind === "workflow")
      destinations.push(option);
  }
  return destinations;
}

function toolEffectTargetGrants(
  view: AccessControlView,
): readonly AccessControlGrantView[] {
  const grants: AccessControlGrantView[] = [];
  const targets = new Set<string>();
  for (const grant of view.grants.items) {
    const capability = findCapabilityView(
      view.capabilities,
      grant.capability.capabilityId,
    );
    const key = `${grant.capability.capabilityId}:${grant.resource.targetRefId}:${grant.resource.revision}`;
    if (
      grant.lifecycle.kind !== "active" ||
      capability?.definition.target === "commerce_read" ||
      targets.has(key)
    )
      continue;
    targets.add(key);
    grants.push(grant);
  }
  return grants;
}

function findCapabilityView(
  capabilities: readonly AccessControlCapabilityView[],
  capabilityId: string,
): AccessControlCapabilityView | null {
  for (const capability of capabilities) {
    if (capability.definition.capabilityId === capabilityId) return capability;
  }
  return null;
}

/**
 * Opens the grant dialog for one system, or for any system when none is
 * given. A file account starts in the focused read-only file setup.
 */
function shareSystem(
  view: AccessControlView,
  trigger: React.MutableRefObject<HTMLButtonElement | null>,
  fileSetupOpened: React.MutableRefObject<boolean>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  setMutation: React.Dispatch<React.SetStateAction<MutationState>>,
  setInitialFileProvider: React.Dispatch<
    React.SetStateAction<FileResourceAccount["provider"] | null>
  >,
  setGrantSystem: React.Dispatch<React.SetStateAction<AccessSystem | null>>,
  system: AccessSystem | null,
  event: React.MouseEvent<HTMLButtonElement>,
): void {
  const fileProvider = fileSetupProvider(view, system);
  if (fileProvider !== null) {
    fileSetupOpened.current = true;
    setInitialFileProvider(fileProvider);
    setGrantSystem(null);
  } else {
    setGrantSystem(system);
  }
  openGrantDialog(trigger, setOpen, setMutation, event);
}

function fileSetupProvider(
  view: AccessControlView,
  system: AccessSystem | null,
): FileResourceAccount["provider"] | null {
  if (
    system === null ||
    (system.provider !== "dropbox" && system.provider !== "google_drive")
  )
    return null;
  const capability = findCapabilityView(view.capabilities, "file.read");
  return capability?.availability === "available" &&
    fileResourceAccounts(view, system.provider).length > 0
    ? system.provider
    : null;
}

/** The dialog offers one system's actions when it opens from that system. */
function grantCapabilities(
  view: AccessControlView,
  system: AccessSystem | null,
): readonly AccessControlCapabilityView[] {
  if (system === null) return view.capabilities;
  const scoped = view.capabilities.filter(
    capabilityBelongsToSystem.bind(null, system),
  );
  return scoped.length === 0 ? view.capabilities : scoped;
}

function readActionSearch(search: string): string {
  return new URLSearchParams(search).get("actions") ?? "";
}

async function checkConversationDelivery(
  props: AccessRouteProps,
  setMutation: React.Dispatch<React.SetStateAction<MutationState>>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  setExplanation: React.Dispatch<
    React.SetStateAction<AccessExplainResult | null>
  >,
  source: AccessControlSourcePolicyView,
  authority: AccessControlOption,
  destination: AccessControlOption,
): Promise<void> {
  await checkDataFlow(props, setMutation, setOpen, setExplanation, [source], {
    kind: "conversation_delivery",
    authority,
    destination,
  });
}

function openGrantDialog(
  trigger: React.MutableRefObject<HTMLButtonElement | null>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  setMutation: React.Dispatch<React.SetStateAction<MutationState>>,
  event?: React.MouseEvent<HTMLButtonElement>,
): void {
  setMutation({ kind: "idle" });
  trigger.current =
    event?.currentTarget ??
    (document.activeElement instanceof HTMLButtonElement
      ? document.activeElement
      : null);
  setOpen(true);
}

function closeGrantDialog(
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  trigger: React.RefObject<HTMLButtonElement | null>,
  setInitialFileProvider: React.Dispatch<
    React.SetStateAction<FileResourceAccount["provider"] | null>
  >,
  setInitialCustomConnector: React.Dispatch<
    React.SetStateAction<CustomConnectorAccessHandoff | null>
  >,
  setGrantSystem: React.Dispatch<React.SetStateAction<AccessSystem | null>>,
): void {
  setOpen(false);
  setInitialFileProvider(null);
  setInitialCustomConnector(null);
  setGrantSystem(null);
  window.requestAnimationFrame(focusElement.bind(null, trigger.current));
}

function readInitialFileAccessProvider(
  search: string,
): FileResourceAccount["provider"] | null {
  const query = new URLSearchParams(search);
  if (query.get("setup") !== "files") return null;
  const provider = query.get("provider");
  return provider === "dropbox" || provider === "google_drive"
    ? provider
    : null;
}

function readBrowserInitialFileProvider():
  FileResourceAccount["provider"] | null {
  return typeof window === "undefined"
    ? null
    : readInitialFileAccessProvider(window.location.search);
}

function openInitialFileGrant(
  content: AccessContent,
  provider: FileResourceAccount["provider"] | null,
  opened: React.MutableRefObject<boolean>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  setMutation: React.Dispatch<React.SetStateAction<MutationState>>,
): void {
  if (provider === null || opened.current || content.kind !== "ready") return;
  opened.current = true;
  removeInitialFileSetupQuery();
  const { view } = content;
  const capability = findCapabilityView(view.capabilities, "file.read");
  const accountAvailable = fileResourceAccounts(view, provider).length > 0;
  if (
    view.organisation.actions.kind !== "manage" ||
    capability?.availability !== "available" ||
    !accountAvailable
  ) {
    setMutation({
      kind: "failed",
      message:
        "The account connected, but file access setup is not ready yet. Refresh this page and try Grant access.",
    });
    return;
  }
  setOpen(true);
}

function removeInitialFileSetupQuery(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("setup");
  url.searchParams.delete("provider");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function preferredFileSubjectRef(
  subjects: readonly AccessControlOption[],
): string {
  for (const subject of subjects) {
    if (subject.kind === "conversation" && subject.availability === "available")
      return subject.refId;
  }
  return "";
}

function focusElement(element: HTMLElement | null): void {
  element?.focus();
}

function toggleSource(
  selected: ReadonlySet<string>,
  setSelected: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
  source: AccessControlSourcePolicyView,
): void {
  const next = new Set(selected);
  if (next.has(source.sourceRefId)) next.delete(source.sourceRefId);
  else next.add(source.sourceRefId);
  setSelected(next);
}

function openSingleSourceCheck(
  setSources: React.Dispatch<
    React.SetStateAction<readonly AccessControlSourcePolicyView[]>
  >,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  source: AccessControlSourcePolicyView,
): void {
  setSources([source]);
  setOpen(true);
}

function openCombinedSourceCheck(
  sources: readonly AccessControlSourcePolicyView[],
  selected: ReadonlySet<string>,
  setSources: React.Dispatch<
    React.SetStateAction<readonly AccessControlSourcePolicyView[]>
  >,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  const combined: AccessControlSourcePolicyView[] = [];
  for (const source of sources) {
    if (selected.has(source.sourceRefId)) combined.push(source);
  }
  setSources(combined);
  setOpen(combined.length > 0);
}

function accessProblem(error: AccessError, remediation: string): string {
  switch (error.kind) {
    case "decode":
      return `The server returned an invalid ${error.boundary} response (${error.code}: ${error.reason}). ${remediation}`;
    case "control":
    case "network":
    case "internal":
      return `${error.message} ${remediation}`;
    default:
      return assertNever(error, "Unhandled access subview");
  }
}

function mutationMessage(state: MutationState): string {
  switch (state.kind) {
    case "idle":
      return "";
    case "busy":
      return "Updating access…";
    case "complete":
      return state.message;
    case "failed":
      return state.message;
  }
}

/** The held answer that a Slack notice links to, if any. */
function readHeldOutputId(search: string): string | null {
  const value = new URLSearchParams(search).get("heldOutput");
  return value !== null && /^[0-9a-f]{32}$/u.test(value) ? value : null;
}

/** The request that a Slack permission notice links to, if any. */
function readPermissionRequestId(search: string): string | null {
  const value = new URLSearchParams(search).get("permissionRequest");
  return value !== null && /^[0-9a-f]{32}$/u.test(value) ? value : null;
}

function openCustomConnectorGrant(
  search: string,
  content: AccessContent,
  opened: React.MutableRefObject<string>,
  setHandoff: React.Dispatch<
    React.SetStateAction<CustomConnectorAccessHandoff | null>
  >,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  if (content.kind !== "ready" || opened.current === search) return;
  const handoff = readCustomConnectorAccessHandoff(search);
  if (handoff === null || content.view.organisation.actions.kind !== "manage")
    return;
  opened.current = search;
  setHandoff(handoff);
  setOpen(true);
}
