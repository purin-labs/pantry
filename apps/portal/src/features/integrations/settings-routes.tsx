import React from "react";
import {
  useLocation,
  useNavigate,
} from "react-router";
import { ControlApiError } from "../../control-client";
import {
  EmptyState,
  Notice,
  PageSkeleton,
  RecoverableError,
} from "../../page-components";
import {
  workspaceAccessSubviewPath,
  workspacePagePath,
} from "../../route";
import type { WhatsAppPolicyDraft, WhatsAppSurface } from "@purin-labs/control-api/portal/whatsapp";
import type { WhatsAppPanelActions } from "../../pages/whatsapp";
import { MutationLedger } from "../../mutation-state";
import {
  parseIntegrationRouteSelection,
  type IntegrationRouteId,
  type IntegrationRouteSelection,
} from "./model";
import { ConnectConsentDialog } from "./connect-consent-dialog";
import { assertNever } from "@purin-labs/std";
import {
  type GmailIntegrationPanelProps,
  gmailMailboxEntries,
  matchesGmailMailboxEntry,
} from "./gmail";
import {
  IntegrationsPage,
  openIntegrationConnection,
} from "./integrations-page";
import { GmailMailboxDetail } from "./mailbox";
import {
  beginIntegrationsRouteLoad,
  confirmProviderConnection,
  createIntegrationsPageActions,
  createWorkspaceSettingsPageActions,
  readyIntegrationsData,
  requestSettingsConfirm,
  retryIntegrationsRoute,
  settingsConfirmCleanup,
} from "./page-actions";
import {
  beginCodexAuthorizationPolling,
  beginProviderAuthorizationWatch,
  beginProviderCompletionListener,
  emptySettingsCleanup,
  openCodexAttemptId,
  trackProviderAuthorization,
} from "./provider-authorization";
import {
  beginWorkspaceSettingsRouteLoad,
  invalidateSettingsRouteRequest,
  lastIntegrationsRouteContent,
  retryWorkspaceSettingsRoute,
} from "./route-loading";
import { isGmailAccount } from "./settings-support";
import type {
  IntegrationDetailRouteData,
  IntegrationsPageActions,
  IntegrationsRouteData,
  IntegrationsRouteMutationContext,
  IntegrationsRouteProps,
  PendingProviderAuthorization,
  PendingProviderConnection,
  ProviderAuthorizationWatch,
  SelectedIntegrationDetailContent,
  SettingsConfirmTimer,
  SettingsMutationFeedback,
  SettingsRouteContent,
  SetupFeedback,
  WorkspaceSettingsPageActions,
  WorkspaceSettingsRouteData,
  WorkspaceSettingsRouteProps,
} from "./settings-types";
import { providerAttemptDiagnostics } from "./setup";
import { WorkspaceSettingsPage } from "./workspace";
import type { Variant } from "@purin-labs/type-utils";

// The platform tests import these through this JSX module.
export { autoSyncCommerce } from "./commerce-system";
export { IntegrationsPage } from "./integrations-page";
export { executeIntegrationsCommand } from "./page-actions";
export { beginProviderAuthorizationWatch, beginProviderCompletionListener, navigateProviderAuthorizationSurface, openProviderAuthorizationSurface, providerAuthorizationInterruptedMessage, providerAuthorizationOutcome } from "./provider-authorization";
export { integrationsRouteRefreshFailure, readySettingsRouteContent, refreshingSettingsRouteContent, settingsRouteFailureContent } from "./route-loading";
export { providerConnectionState } from "./settings-support";
export type { IntegrationsPageActions, WorkspaceSettingsPageActions } from "./settings-types";

/**
 * The state, loads and mutations of the Integrations route. The Integrations
 * page and the Inbox's mailbox settings page both read it, so a mailbox
 * changes through the same actions in both.
 */
function useIntegrationsRouteState(
  props: IntegrationsRouteProps,
  requestedIntegration: IntegrationRouteSelection,
) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const [content, setContent] = React.useState<
    SettingsRouteContent<IntegrationsRouteData>
  >(lastIntegrationsRouteContent.bind(null, props));
  const [detailContent, setDetailContent] =
    React.useState<SelectedIntegrationDetailContent>({ kind: "idle" });
  const [mutations, setMutations] = React.useState(MutationLedger.empty());
  const [authorization, setAuthorization] =
    React.useState<ProviderAuthorizationWatch | null>(null);
  const [pendingConfirm, setPendingConfirm] = React.useState<string | null>(
    null,
  );
  const [feedback, setFeedback] =
    React.useState<SettingsMutationFeedback>(null);
  const [setupFeedback, setSetupFeedback] = React.useState<SetupFeedback>({
    kind: "idle",
  });
  const [connectConsent, setConnectConsent] =
    React.useState<PendingProviderConnection | null>(null);
  const requestRevision = React.useRef(0);
  const detailRequestRevision = React.useRef(0);
  const confirmTimer = React.useRef<SettingsConfirmTimer>({ current: null });
  const authorizationRef = React.useRef<ProviderAuthorizationWatch | null>(
    null,
  );
  const handledAttemptIds = React.useRef(new Set<string>());
  const codexAttemptId = openCodexAttemptId(content);
  React.useEffect(
    beginIntegrationsRouteLoad.bind(
      null,
      props,
      requestRevision,
      setContent,
      setFeedback,
    ),
    [props.organisationId, props.refreshKey, props.transport],
  );
  const overviewData = readyIntegrationsData(content);
  React.useEffect(
    beginIntegrationDetailLoad.bind(
      null,
      props,
      requestedIntegration,
      overviewData,
      detailRequestRevision,
      setDetailContent,
    ),
    [
      props.organisationId,
      props.transport,
      requestedIntegration.kind,
      requestedIntegration.kind === "detail"
        ? requestedIntegration.integrationId
        : null,
      overviewData,
    ],
  );
  React.useEffect(settingsConfirmCleanup.bind(null, confirmTimer.current), [
    confirmTimer,
  ]);
  React.useEffect(
    beginCodexAuthorizationPolling.bind(
      null,
      codexAttemptId,
      props,
      requestRevision,
      setContent,
    ),
    [codexAttemptId, props.organisationId, props.transport],
  );
  React.useEffect(
    trackProviderAuthorization.bind(null, authorizationRef, authorization),
    [authorization],
  );
  React.useEffect(
    beginProviderAuthorizationWatch.bind(
      null,
      authorization,
      setAuthorization,
      setFeedback,
      props,
      requestRevision,
      setContent,
    ),
    [authorization, props.organisationId, props.transport],
  );
  React.useEffect(
    beginProviderCompletionListener.bind(
      null,
      props,
      requestRevision,
      setContent,
      setFeedback,
      authorizationRef,
      setAuthorization,
      handledAttemptIds.current,
    ),
    [
      props.organisationId,
      props.organisationHandle,
      props.workspaceHandle,
      props.refreshKey,
      props.transport,
    ],
  );
  const mutationContext: IntegrationsRouteMutationContext = {
    props,
    content,
    requestRevision,
    setContent,
    mutations,
    setMutations,
    authorization: authorizationRef,
    setAuthorization,
    setPendingConfirm,
    setFeedback,
    setSetupFeedback,
    setConnectConsent,
    openIntegration: openIntegrationConnection.bind(null, navigate, search),
  };
  const pageActions = createIntegrationsPageActions(mutationContext);
  return {
    content,
    detailContent,
    mutations,
    pendingAuthorization: authorization === null ? null : authorization.pending,
    pendingConfirm,
    setupFeedback,
    feedback,
    connectConsent,
    setConnectConsent,
    mutationContext,
    pageActions,
    requestConfirm: requestSettingsConfirm.bind(
      null,
      setPendingConfirm,
      confirmTimer.current,
    ),
    retry: retryIntegrationsRoute.bind(
      null,
      props,
      requestRevision,
      setContent,
      setFeedback,
    ),
    retryDetail: retryIntegrationDetail.bind(
      null,
      props,
      requestedIntegration,
      overviewData,
      detailRequestRevision,
      setDetailContent,
    ),
  };
}

export function IntegrationsRoute(
  props: IntegrationsRouteProps,
): React.ReactNode {
  const requestedIntegration = useRequestedIntegration();
  const route = useIntegrationsRouteState(props, requestedIntegration);
  return (
    <>
      <ConnectConsentDialog
        provider={
          route.connectConsent === null
            ? null
            : route.connectConsent.mutation.provider
        }
        signedInAs={props.signedInAs ?? null}
        close={route.setConnectConsent.bind(null, null)}
        confirm={confirmProviderConnection.bind(
          null,
          route.mutationContext,
          route.connectConsent,
        )}
      />
      <IntegrationsRouteView
        props={props}
        requestedIntegration={requestedIntegration}
        content={route.content}
        detailContent={route.detailContent}
        mutations={route.mutations}
        pendingAuthorization={route.pendingAuthorization}
        pendingConfirm={route.pendingConfirm}
        setupFeedback={route.setupFeedback}
        feedback={route.feedback}
        requestConfirm={route.requestConfirm}
        retry={route.retry}
        retryDetail={route.retryDetail}
        whatsappActions={createWhatsAppPanelActions(
          props,
          route.retry,
          route.pageActions,
        )}
        actions={route.pageActions}
      />
    </>
  );
}

type MailboxSettingsRouteProps = IntegrationsRouteProps &
  Readonly<{
    /** The Gmail connection whose settings the page shows. */
    accountId: string;
    /** The page that the back link returns to. */
    back: Readonly<{ href: string; label: string }>;
  }>;

/**
 * One mailbox's settings as a page of its own, for the Inbox. It shows the
 * same mailbox view as the Email dialog of the Integrations page, through the
 * same route state, so each change takes the same checks and approvals.
 */
export function MailboxSettingsRoute(
  props: MailboxSettingsRouteProps,
): React.ReactNode {
  const requested: IntegrationRouteSelection = {
    kind: "detail",
    integrationId: "gmail",
    accountId: props.accountId,
    query: "",
  };
  const route = useIntegrationsRouteState(props, requested);
  const back = (
    <a className="mailbox-back" href={props.back.href}>
      <span aria-hidden="true">←</span> {props.back.label}
    </a>
  );
  let body: React.ReactNode;
  switch (route.content.kind) {
    case "loading":
      body = <PageSkeleton label="Loading mailbox settings" />;
      break;
    case "failed":
      body = (
        <RecoverableError
          message={route.content.problem}
          action={
            <button type="button" onClick={route.retry}>
              Try again
            </button>
          }
        />
      );
      break;
    case "unauthorized":
    case "empty":
      body = (
        <EmptyState
          title="Mailbox settings are unavailable"
          detail={route.content.reason}
        />
      );
      break;
    case "ready":
      body = mailboxSettingsBody(props, route, route.content);
      break;
    default:
      return assertNever(route.content, "Unexpected settings state");
  }
  return (
    <>
      <ConnectConsentDialog
        provider={
          route.connectConsent === null
            ? null
            : route.connectConsent.mutation.provider
        }
        signedInAs={props.signedInAs ?? null}
        close={route.setConnectConsent.bind(null, null)}
        confirm={confirmProviderConnection.bind(
          null,
          route.mutationContext,
          route.connectConsent,
        )}
      />
      <section className="mailbox-settings-page" aria-label="Mailbox settings">
        {route.content.kind === "ready" && route.detailContent.kind === "ready"
          ? null
          : back}
        {body}
      </section>
    </>
  );
}

type IntegrationsRouteState = ReturnType<typeof useIntegrationsRouteState>;

function mailboxSettingsBody(
  props: MailboxSettingsRouteProps,
  route: IntegrationsRouteState,
  content: Variant<SettingsRouteContent<IntegrationsRouteData>, "ready">,
): React.ReactNode {
  const detail = route.detailContent;
  if (detail.kind === "idle" || detail.kind === "loading")
    return <PageSkeleton label="Loading mailbox settings" />;
  if (detail.kind === "failed")
    return (
      <RecoverableError
        message={detail.problem}
        action={
          <button type="button" onClick={route.retryDetail}>
            Try again
          </button>
        }
      />
    );
  const data = content.data;
  const panel: GmailIntegrationPanelProps = {
    accounts: data.accounts.filter(isGmailAccount),
    selectedAccountId: props.accountId,
    accessPath: workspaceAccessSubviewPath(
      props.organisationHandle,
      props.workspaceHandle,
      "capabilities",
    ),
    inboxPath: workspacePagePath(
      props.organisationHandle,
      props.workspaceHandle,
      "inbox",
    ),
    agentsPath: workspacePagePath(
      props.organisationHandle,
      props.workspaceHandle,
      "agents",
    ),
    credentialInventory: detail.data.credentialInventory,
    agentMailboxes: detail.data.agentMailboxes,
    emailReplies: detail.data.emailReplies,
    emailOperational: detail.data.emailOperational,
    installations: detail.data.mailboxInstallations,
    inferenceSelection: data.inferenceSelection,
    canManage: props.canManage && content.freshness.kind === "current",
    mutations: route.mutations,
    pendingAuthorization: route.pendingAuthorization,
    pendingConfirm: route.pendingConfirm,
    requestConfirm: route.requestConfirm,
    lastAttempt: providerAttemptDiagnostics(detail.data.supportDiagnostics, [
      "gmail",
    ]),
    actions: route.pageActions,
    feedback: route.feedback,
  };
  const entry =
    gmailMailboxEntries(panel.accounts, panel.agentMailboxes).find(
      matchesGmailMailboxEntry.bind(null, props.accountId),
    ) ?? null;
  if (entry === null)
    return (
      <EmptyState
        title="This mailbox is not connected"
        detail="Seams Pantry has no Gmail connection for this mailbox now. Connect it again on the Integrations page."
      />
    );
  return (
    <GmailMailboxDetail
      key={entry.integrationAccountId}
      panel={panel}
      entry={entry}
      listHref={props.back.href}
      backLabel={props.back.label}
      page
    />
  );
}

/**
 * Builds the WhatsApp panel's actions from the route transport. Every mutating
 * action reloads the route so an approval, takeover, or policy change is read
 * back from the control plane rather than assumed locally.
 */
function createWhatsAppPanelActions(
  props: IntegrationsRouteProps,
  refresh: () => void,
  pageActions: IntegrationsPageActions,
): WhatsAppPanelActions {
  const transport = props.transport.whatsapp;
  const organisationId = props.organisationId;
  const after = async (work: Promise<unknown>): Promise<void> => {
    await work;
    refresh();
  };
  return {
    connect: pageActions.connectWhatsApp,
    cancelConnection: pageActions.cancelProviderAuthorization,
    select: (integrationAccountId) =>
      after(
        transport.accountAction(
          organisationId,
          integrationAccountId,
          "select",
          {},
        ),
      ),
    bindAgent: (integrationAccountId, installationId) =>
      after(
        transport.accountAction(organisationId, integrationAccountId, "bind", {
          installationId,
        }),
      ),
    publishPolicy: (integrationAccountId, draft: WhatsAppPolicyDraft) =>
      after(
        transport.accountAction(
          organisationId,
          integrationAccountId,
          "policy",
          {
            policy: {
              kind: "enabled",
              ...draft,
              overflow: "pause_and_notify",
              notificationDestination: {
                kind: "organisation_communication_destination",
              },
            },
          },
        ),
      ),
    disable: (integrationAccountId) =>
      after(
        transport.accountAction(
          organisationId,
          integrationAccountId,
          "disable",
          {},
        ),
      ),
    reconnect: (integrationAccountId) =>
      after(
        transport.accountAction(
          organisationId,
          integrationAccountId,
          "reconnect",
          {},
        ),
      ),
    revoke: (integrationAccountId) =>
      after(
        transport.accountAction(
          organisationId,
          integrationAccountId,
          "revoke",
          {
            confirmed: true,
          },
        ),
      ),
    resume: (integrationAccountId) =>
      after(
        transport.accountAction(
          organisationId,
          integrationAccountId,
          "resume",
          {},
        ),
      ),
  };
}

function useRequestedIntegration(): IntegrationRouteSelection {
  const { search } = useLocation();
  return parseIntegrationRouteSelection(search);
}

function beginIntegrationDetailLoad(
  props: IntegrationsRouteProps,
  requested: IntegrationRouteSelection,
  overview: IntegrationsRouteData | null,
  requestRevision: { current: number },
  setContent: React.Dispatch<
    React.SetStateAction<SelectedIntegrationDetailContent>
  >,
): () => void {
  if (requested.kind === "overview") {
    requestRevision.current += 1;
    setContent({ kind: "idle" });
    return emptySettingsCleanup;
  }
  if (overview === null) return emptySettingsCleanup;
  void loadIntegrationDetail(
    props,
    requested.integrationId,
    overview,
    requestRevision,
    setContent,
  );
  return invalidateSettingsRouteRequest.bind(null, requestRevision);
}

function retryIntegrationDetail(
  props: IntegrationsRouteProps,
  requested: IntegrationRouteSelection,
  overview: IntegrationsRouteData | null,
  requestRevision: { current: number },
  setContent: React.Dispatch<
    React.SetStateAction<SelectedIntegrationDetailContent>
  >,
): void {
  if (requested.kind !== "detail" || overview === null) return;
  void loadIntegrationDetail(
    props,
    requested.integrationId,
    overview,
    requestRevision,
    setContent,
  );
}

async function loadIntegrationDetail(
  props: IntegrationsRouteProps,
  integrationId: IntegrationRouteId,
  overview: IntegrationsRouteData,
  requestRevision: { current: number },
  setContent: React.Dispatch<
    React.SetStateAction<SelectedIntegrationDetailContent>
  >,
): Promise<void> {
  const revision = ++requestRevision.current;
  setContent({ kind: "loading", integrationId });
  try {
    const data = await props.transport.readDetail(props.organisationId, {
      integrationId: integrationId,
      supportReference: overview.supportReference,
      accounts: overview.accounts,
      organisationIsActive: overview.organisationIsActive,
    });
    if (requestRevision.current !== revision) return;
    setContent({ kind: "ready", integrationId, data });
  } catch (error) {
    if (requestRevision.current !== revision) return;
    setContent({
      kind: "failed",
      integrationId,
      problem: integrationDetailProblem(error),
    });
  }
}

function integrationDetailProblem(error: unknown): string {
  return error instanceof ControlApiError
    ? error.message
    : "This integration's details could not be loaded. Try again.";
}

function readyIntegrationDetailData(
  content: SelectedIntegrationDetailContent,
): IntegrationDetailRouteData {
  return content.kind === "ready" ? content.data : emptyIntegrationDetailData();
}

function emptyIntegrationDetailData(): IntegrationDetailRouteData {
  return {
    destinations: [],
    slackRouting: [],
    supportDiagnostics: null,
    credentialInventory: null,
    agentMailboxes: [],
    emailReplies: [],
    emailOperational: [],
    mailboxInstallations: [],
    whatsapp: emptyWhatsAppSurface(null),
  };
}

function emptyWhatsAppSurface(
  applicationConfigured: boolean | null,
): WhatsAppSurface {
  return {
    applicationConfigured: applicationConfigured === true,
    accounts: [],
    replies: [],
  };
}

export function IntegrationsRouteView(props: {
  readonly props: IntegrationsRouteProps;
  readonly requestedIntegration: IntegrationRouteSelection;
  readonly content: SettingsRouteContent<IntegrationsRouteData>;
  readonly detailContent: SelectedIntegrationDetailContent;
  readonly mutations: MutationLedger;
  readonly pendingAuthorization: PendingProviderAuthorization | null;
  readonly pendingConfirm: string | null;
  readonly setupFeedback: SetupFeedback;
  readonly feedback: SettingsMutationFeedback;
  readonly requestConfirm: (key: string) => void;
  readonly actions: IntegrationsPageActions;
  readonly whatsappActions: WhatsAppPanelActions;
  readonly retry: () => void;
  readonly retryDetail: () => void;
}): React.ReactNode {
  switch (props.content.kind) {
    case "loading":
      return <SettingsRouteLoading title="Connected systems" />;
    case "ready": {
      const detailData = readyIntegrationDetailData(props.detailContent);
      const routeIsCurrent = props.content.freshness.kind === "current";
      return (
        <>
          {props.content.updating ? (
            <Notice tone="neutral" announcement="polite">
              Refreshing connected systems…
            </Notice>
          ) : null}
          {props.content.freshness.kind === "delayed" ? (
            <RecoverableError
              message={props.content.freshness.explanation}
              action={
                <button type="button" onClick={props.retry}>
                  Refresh connected systems
                </button>
              }
            />
          ) : null}
          <IntegrationsPage
            organisationId={props.props.organisationId}
            stripeSetup={props.props.transport.stripeSetup}
            initialIntegrationId={
              props.requestedIntegration.kind === "detail"
                ? props.requestedIntegration.integrationId
                : undefined
            }
            initialAccountId={
              props.requestedIntegration.kind === "detail"
                ? (props.requestedIntegration.accountId ?? undefined)
                : undefined
            }
            initialQuery={props.requestedIntegration.query}
            initialFocusId={
              props.requestedIntegration.kind === "overview"
                ? (props.requestedIntegration.focusId ?? undefined)
                : undefined
            }
            integrationBasePath={props.props.integrationBasePath}
            organisationHandle={props.props.organisationHandle}
            workspaceHandle={props.props.workspaceHandle}
            commerceSystem={props.content.data.commerceSystem}
            commerceSyncProblem={props.content.data.commerceSyncProblem}
            codexConnection={props.content.data.codexConnection}
            inferenceSelection={props.content.data.inferenceSelection}
            accounts={props.content.data.accounts}
            destinations={detailData.destinations}
            slackRouting={detailData.slackRouting}
            supportDiagnostics={detailData.supportDiagnostics}
            whatsapp={
              props.detailContent.kind === "ready"
                ? detailData.whatsapp
                : emptyWhatsAppSurface(
                    props.content.data.whatsappApplicationConfigured,
                  )
            }
            whatsappConfigurationKnown={
              props.detailContent.kind === "ready" ||
              props.content.data.whatsappApplicationConfigured !== null
            }
            whatsappActions={props.whatsappActions}
            agentMailboxes={detailData.agentMailboxes}
            emailReplies={detailData.emailReplies}
            emailOperational={detailData.emailOperational}
            mailboxInstallations={detailData.mailboxInstallations}
            credentialInventory={detailData.credentialInventory}
            setupDefaults={props.content.data.setupDefaults}
            setupFeedback={props.setupFeedback}
            readiness={props.content.data.readiness}
            activation={props.content.data.activation}
            firstTask={props.content.data.firstTask}
            organisationIsActive={props.content.data.organisationIsActive}
            configurationVersion={props.content.data.configurationVersion}
            canManage={props.props.canManage && routeIsCurrent}
            canConnectCodex={props.props.canConnectCodex && routeIsCurrent}
            mutations={props.mutations}
            pendingAuthorization={props.pendingAuthorization}
            pendingConfirm={props.pendingConfirm}
            requestConfirm={props.requestConfirm}
            actions={props.actions}
            feedback={props.feedback}
            detailContent={props.detailContent}
            retryDetail={props.retryDetail}
          />
        </>
      );
    }
    case "failed":
      return (
        <SettingsRouteError
          problem={props.content.problem}
          retry={props.retry}
        />
      );
    case "unauthorized":
      return (
        <EmptyState
          title="Connected systems are unavailable"
          detail={props.content.reason}
        />
      );
    case "empty":
      return (
        <EmptyState
          title="No connected systems"
          detail={props.content.reason}
        />
      );
    default:
      return assertNever(props.content, "Unexpected settings state");
  }
}

/** Workspace membership, invitations, and their mutations stay inside this route. */
export function WorkspaceSettingsRoute(
  props: WorkspaceSettingsRouteProps,
): React.ReactNode {
  const [content, setContent] = React.useState<
    SettingsRouteContent<WorkspaceSettingsRouteData>
  >({ kind: "loading" });
  const [mutations, setMutations] = React.useState(MutationLedger.empty());
  const [pendingConfirm, setPendingConfirm] = React.useState<string | null>(
    null,
  );
  const [feedback, setFeedback] =
    React.useState<SettingsMutationFeedback>(null);
  const requestRevision = React.useRef(0);
  const confirmTimer = React.useRef<SettingsConfirmTimer>({ current: null });
  React.useEffect(
    beginWorkspaceSettingsRouteLoad.bind(
      null,
      props,
      requestRevision,
      setContent,
      setFeedback,
    ),
    [props.organisationId, props.refreshKey, props.transport],
  );
  React.useEffect(settingsConfirmCleanup.bind(null, confirmTimer.current), [
    confirmTimer,
  ]);
  return (
    <WorkspaceSettingsRouteView
      props={props}
      content={content}
      mutations={mutations}
      pendingConfirm={pendingConfirm}
      feedback={feedback}
      requestConfirm={requestSettingsConfirm.bind(
        null,
        setPendingConfirm,
        confirmTimer.current,
      )}
      retry={retryWorkspaceSettingsRoute.bind(
        null,
        props,
        requestRevision,
        setContent,
        setFeedback,
      )}
      actions={createWorkspaceSettingsPageActions({
        props,
        content,
        requestRevision,
        setContent,
        mutations,
        setMutations,
        setPendingConfirm,
        setFeedback,
      })}
    />
  );
}

export function WorkspaceSettingsRouteView(props: {
  readonly props: WorkspaceSettingsRouteProps;
  readonly content: SettingsRouteContent<WorkspaceSettingsRouteData>;
  readonly mutations: MutationLedger;
  readonly pendingConfirm: string | null;
  readonly feedback: SettingsMutationFeedback;
  readonly requestConfirm: (key: string) => void;
  readonly actions: WorkspaceSettingsPageActions;
  readonly retry: () => void;
}): React.ReactNode {
  switch (props.content.kind) {
    case "loading":
      return <SettingsRouteLoading title="Workspace settings" />;
    case "ready":
      return (
        <>
          {props.content.updating ? (
            <Notice tone="neutral" announcement="polite">
              Refreshing workspace settings…
            </Notice>
          ) : null}
          <WorkspaceSettingsPage
            organisation={{
              ...props.props.organisation,
              lifecycle: props.content.data.lifecycle,
            }}
            members={props.content.data.members}
            invitations={props.content.data.invitations}
            canManage={props.props.canManage}
            mutations={props.mutations}
            pendingConfirm={props.pendingConfirm}
            requestConfirm={props.requestConfirm}
            actions={props.actions}
            feedback={props.feedback}
            operationalAreas={props.props.operationalAreas}
          />
        </>
      );
    case "failed":
      return (
        <SettingsRouteError
          problem={props.content.problem}
          retry={props.retry}
        />
      );
    case "unauthorized":
      return (
        <EmptyState
          title="Workspace settings are unavailable"
          detail={props.content.reason}
        />
      );
    case "empty":
      return (
        <EmptyState
          title="No workspace members"
          detail={props.content.reason}
        />
      );
    default:
      return assertNever(props.content, "Unexpected settings state");
  }
}

function SettingsRouteLoading(props: {
  readonly title: string;
}): React.ReactNode {
  return <PageSkeleton label={`Loading ${props.title.toLowerCase()}`} />;
}

function SettingsRouteError(props: {
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
