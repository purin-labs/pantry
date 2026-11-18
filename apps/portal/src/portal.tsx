import {
  ControlApiError,
  controlRead,
  forgetControlReads,
  controlMutation,
} from "./control-client";
import {
  AccountInvitationPage,
  readAccountInvitationRoute,
} from "./pages/account-invitation";
import { UserPreferencesProvider } from "./preferences/context";
import { BakeryWorkspaceReveal } from "./features/bakery-workspace-reveal";
import { revealBakeryWorkspace } from "./features/bakery-surface-registry";
import React from "react";
import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Route,
  RouterProvider,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router";
import { toast } from "sonner";
import {
  ChatPage,
  startWorkspacePageCode,
  WorkflowSimulatorRoute,
} from "./page-code";
import {
  readPortalRoute,
  renamedPagePath,
  WORKSPACE_PAGE_ROUTES,
  workspacePageDescriptor,
  workspacePageDocumentTitle,
  workspacePageHeader,
  workspacePagePath,
  workspaceResourcePath,
  type PortalRoute,
  type WorkspaceDetailPage,
  type WorkspacePageDescriptor,
} from "./route";
import {
  focusPortalPage,
  WorkspaceLayout,
  useRoutePageFocus,
} from "./shell";
import { parseChatReturnPath } from "./page-address";
import { PageSkeleton } from "./page-components";
import {
  MutationLedger,
  type OrganisationMutation,
} from "./mutation-state";
import {
  OrganisationsRoute,
  type WorkspaceRouteTarget,
} from "./pages/workspaces";
import type { AccountSetupListing } from "./pages/account-onboarding";
import {
  startShellReads,
  startWorkspacePageReads,
} from "./early-reads";
import { type CommerceActionRecord, parseCommerceActionRecordResponse, parseMerchantPluginPreviewResponse, type MerchantPluginPreview, parseCommerceActionExecutionResponse } from "@seams/control-api/portal/commerce-actions";
import { BakerySurfaceEffectBridge } from "./features/bakery-surface-effect-bridge";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";
import { CommerceActionStatus } from "./features/governed-actions/commerce-action-status";
import { fetchCodexUsagePercent } from "./features/integrations/codex-transport";
import { signInForApproval } from "./approval-sign-in-popup";
import {
  clearPendingCommerceApproval,
  currentPortalPath,
  readPendingCommerceApproval,
  writePendingCommerceApproval,
} from "./portal-commerce-approval";
import {
  commerceEntityPlaneControlMutation,
} from "./portal-mutations";
import {
  canManageOrganisation,
  findMembershipByOrganisationHandle,
  findWorkspaceByHandle,
  isConfigurationConflict,
  needsReadinessEvaluation,
  portalError,
  readLastUsedWorkspaceHandle,
  rememberLastUsedWorkspace,
  selectPreferredWorkspace,
} from "./portal-projection";
import { archiveOwnerlessLegacyOrganisation, currentOrganisationLifecycle, emitOnboardingStageViewed, fetchCommerceSystem, fetchControlSession, fetchOperatorOrganisationCase, fetchOrganisationSnapshotIfChanged, fetchReadiness, fetchShellOrganisationSnapshot, loadOrganisationChoices, loadPortalOrganisation, loadPortalOrganisations, organisationProjectionEtag, projectionStage, toWorkspaceChoice } from "./portal-reads";
import { parseCommerceApprovalResponse } from "@seams/control-api/portal/portal-reads";
import {
  type WorkspaceRouteSelection,
  brainMemoryPath,
  currentWorkspaceRouteSelection,
  isCommercePage,
  mutationKindActive,
  workspaceRouteSelection,
} from "./portal-routing";
import {
  PortalLoadFailure,
  PortalLoading,
  PortalRouteFailure,
  SignIn,
  loadOrganisationListItems,
  organisationSupportTools,
  renderRouteNotFound,
  renderWorkspaceSidebarFooter,
} from "./portal-shell";
import {
  ACCESS_ROUTE_TRANSPORT,
  ORGANISATION_ACTIONS,
} from "./portal-transports";
import type { Membership, OrganisationSnapshot, OrganisationWorkspace } from "@seams/control-api/portal/portal-types";
import type { PortalState, SessionSnapshot } from "./portal-types";
import { PAGES } from "./pages";

// The platform tests import these through this JSX module.
export { executeIntegrationsRoute } from "./features/integrations/settings-transport";
export { selectPreferredWorkspace } from "./portal-projection";

type ActivationProjectionTracking = {
  readonly organisationId: string;
  readonly projectionEtag: string;
  readonly observedActivating: boolean;
  readonly pollDelayMs: number;
};

const CONFLICT_MESSAGE =
  "This workspace was changed in another session. The page has been refreshed. Try again.";

const OrganisationPageRouteContext = React.createContext<React.ReactNode>(null);

type ControlPortalAppProps = {
  readonly navigate: NavigateFunction;
  readonly pathname: string;
  readonly route: PortalRoute;
  readonly chatReturnPath: string | null;
};

// Keep imports DOM-free for shared Portal helpers; create one router at browser bootstrap.
let controlPortalRouter: ReturnType<typeof createBrowserRouter> | null = null;

export function ControlPortalRouter(): React.ReactNode {
  controlPortalRouter ??= createBrowserRouter(
    createRoutesFromElements(
      <Route
        element={<ControlPortalRoute />}
        errorElement={<PortalRouteFailure />}
      >
        <Route index element={<PortalRouteLeaf />} />
        <Route path="sign-in" element={<PortalRouteLeaf />} />
        <Route path="portal" element={<PortalRouteLeaf />} />
        <Route path="portal/:organisationHandle">
          <Route index element={<PortalRouteLeaf />} />
          <Route path=":workspaceHandle">
            <Route index element={<PortalRouteLeaf />} />
            {WORKSPACE_PAGE_ROUTES.map(renderWorkspaceRoute)}
            <Route path="*" element={<PortalRouteLeaf />} />
          </Route>
          <Route path="*" element={<PortalRouteLeaf />} />
        </Route>
        <Route path="*" element={<PortalRouteLeaf />} />
      </Route>,
    ),
  );
  return <RouterProvider router={controlPortalRouter} />;
}

function renderWorkspaceRoute(
  descriptor: WorkspacePageDescriptor,
): React.ReactNode {
  if (descriptor.segment.length === 0) return null;
  return (
    <React.Fragment key={descriptor.page}>
      <Route path={descriptor.segment} element={<PortalRouteLeaf />} />
      {descriptor.resource.kind === "detail" ? (
        <Route
          path={`${descriptor.resource.detailSegment}/:resourceId`}
          element={<PortalRouteLeaf />}
        />
      ) : null}
    </React.Fragment>
  );
}

function PortalRouteLeaf(): React.ReactNode {
  return React.useContext(OrganisationPageRouteContext);
}

function ControlPortalRoute(): React.ReactNode {
  const location = useLocation();
  const navigate = useNavigate();
  const route = readPortalRoute(location.pathname);
  const chatOpen = isPortalChatRoute(route);
  useRoutePageFocus(location.pathname, !chatOpen);
  const renamedPath = renamedPagePath(location.pathname);
  if (renamedPath !== null) {
    return <Navigate replace to={`${renamedPath}${location.search}`} />;
  }
  return (
    <ControlPortalApp
      navigate={navigate}
      pathname={location.pathname}
      route={route}
      chatReturnPath={parseChatReturnPath(location.state)}
    />
  );
}

function isPortalChatRoute(route: PortalRoute): boolean {
  return (
    route.kind === "workspace" &&
    route.destination.kind === "page" &&
    route.destination.page === "chat"
  );
}

function chatReturnPathForWorkspace(
  path: string | null,
  organisationHandle: string,
  workspaceHandle: string,
): string | null {
  if (path === null) return null;
  const url = new URL(path, window.location.origin);
  const route = readPortalRoute(url.pathname);
  if (
    route.kind !== "workspace" ||
    route.organisationHandle !== organisationHandle ||
    route.workspaceHandle !== workspaceHandle ||
    (route.destination.kind === "page" && route.destination.page === "chat")
  )
    return null;
  return `${url.pathname}${url.search}`;
}

export class ControlPortalApp extends React.Component<
  ControlPortalAppProps,
  PortalState
> {
  private readonly accountInvitationRoute = readAccountInvitationRoute(
    new URL(window.location.href),
    window.sessionStorage,
  );
  state: PortalState = { kind: "loading" };
  private activationProjection: ActivationProjectionTracking | null = null;
  private activationPollTimer: number | null = null;
  private stageViewedKey: string | null = null;
  private routeRevision = 0;

  constructor(props: ControlPortalAppProps) {
    super(props);
    this.openWorkspace = this.openWorkspace.bind(this);
    this.inspectLegacyOrganisation = this.inspectLegacyOrganisation.bind(this);
    this.archiveLegacyOrganisation = this.archiveLegacyOrganisation.bind(this);
    this.logout = this.logout.bind(this);
    this.activate = this.activate.bind(this);
    this.maybeAdvanceOnboarding = this.maybeAdvanceOnboarding.bind(this);
    this.retryLoad = this.retryLoad.bind(this);
    this.completeAccountSetup = this.completeAccountSetup.bind(this);
    this.pollActivationProjection = this.pollActivationProjection.bind(this);
    this.loadCommerceAction = this.loadCommerceAction.bind(this);
    this.approveCurrentCommerceAction =
      this.approveCurrentCommerceAction.bind(this);
    this.rejectCurrentCommerceAction =
      this.rejectCurrentCommerceAction.bind(this);
    this.executeCommerceAction = this.executeCommerceAction.bind(this);
    this.readCommerceActionPluginPreview =
      this.readCommerceActionPluginPreview.bind(this);
    this.backCommercePage = this.backCommercePage.bind(this);
    this.loadCurrentWorkspaceRoute = this.loadCurrentWorkspaceRoute.bind(this);
    this.completeWorkspaceRouteChange =
      this.completeWorkspaceRouteChange.bind(this);
    this.closeChatUnderlay = this.closeChatUnderlay.bind(this);
  }

  componentDidMount(): void {
    void this.load();
  }

  componentDidUpdate(previousProps: ControlPortalAppProps): void {
    // With the chat open, a page link keeps the chat route and changes only
    // the page beside the chat.
    if (
      previousProps.pathname !== this.props.pathname ||
      previousProps.chatReturnPath !== this.props.chatReturnPath
    ) {
      this.applyRoute();
    }
  }

  /** The page on screen: with the chat open, the page beside the chat. */
  pageSelection(selection: WorkspaceRouteSelection): WorkspaceRouteSelection {
    if (selection.page !== "chat" || this.props.route.kind !== "workspace")
      return selection;
    const returnPath = chatReturnPathForWorkspace(
      this.props.chatReturnPath,
      this.props.route.organisationHandle,
      this.props.route.workspaceHandle,
    );
    if (returnPath === null) return selection;
    const background = readPortalRoute(
      new URL(returnPath, window.location.origin).pathname,
    );
    return background.kind === "workspace"
      ? workspaceRouteSelection(background, selection.organisationId)
      : selection;
  }

  componentWillUnmount(): void {
    this.clearActivationPollTimer();
  }

  applyRoute(): void {
    this.routeRevision += 1;
    const route = this.props.route;
    if (route.kind === "workspace" && this.state.kind === "workspace_detail") {
      const selection = workspaceRouteSelection(
        route,
        this.state.organisation.organisation.organisationId,
      );
      if (
        route.organisationHandle ===
          this.state.organisation.membership.organisationHandle &&
        route.workspaceHandle === this.state.workspace.workspaceHandle
      ) {
        this.applyWorkspaceRoute(selection);
        return;
      }
    }
    // The list would stay on screen until the workspace had loaded, which
    // reads as the link having done nothing.
    if (
      this.state.kind === "organisation_list" &&
      (route.kind === "workspace" || route.kind === "organisation")
    ) {
      this.setState({ kind: "loading" });
    }
    void this.load();
  }

  async load(): Promise<void> {
    const routeRevision = this.routeRevision;
    try {
      const session = await fetchControlSession();
      if (routeRevision !== this.routeRevision) return;
      if (session === null) {
        forgetControlReads();
        document.title = "Sign in · Seams Pantry";
        this.setState({ kind: "signed_out" }, focusPortalPage);
        return;
      }
      const route = this.props.route;
      if (route.kind === "not_found") {
        await this.loadRouteNotFound(
          session,
          route.organisationHandle,
          route.workspaceHandle,
          routeRevision,
        );
        return;
      }
      if (route.kind === "organisation") {
        const membership = session.memberships.find(
          findMembershipByOrganisationHandle(route.organisationHandle),
        );
        if (membership === undefined) {
          document.title = "Organisation unavailable · Seams Pantry";
          this.setState(
            {
              kind: "route_not_found",
              reason: "organisation",
              identity: session.identity,
              organisation: null,
              workspace: null,
            },
            focusPortalPage,
          );
          return;
        }
        const workspace = selectPreferredWorkspace(
          membership.workspaces,
          readLastUsedWorkspaceHandle(membership.organisationHandle),
        );
        this.props.navigate(
          workspacePagePath(
            membership.organisationHandle,
            workspace.workspaceHandle,
            "overview",
          ),
          { replace: true },
        );
        return;
      }
      if (route.kind === "workspace") {
        const membership = session.memberships.find(
          findMembershipByOrganisationHandle(route.organisationHandle),
        );
        const workspace = membership?.workspaces.find(
          findWorkspaceByHandle(route.workspaceHandle),
        );
        if (membership === undefined || workspace === undefined) {
          const organisation =
            membership === undefined
              ? null
              : await loadPortalOrganisation(membership);
          if (routeRevision !== this.routeRevision) return;
          document.title = "Workspace unavailable · Seams Pantry";
          this.setState(
            {
              kind: "route_not_found",
              reason: membership === undefined ? "organisation" : "workspace",
              identity: session.identity,
              organisation,
              workspace: null,
            },
            focusPortalPage,
          );
          return;
        }
        let selection = workspaceRouteSelection(
          route,
          membership.organisationId,
        );
        if (selection.page === "chat") {
          const returnPath = chatReturnPathForWorkspace(
            this.props.chatReturnPath,
            route.organisationHandle,
            route.workspaceHandle,
          );
          if (returnPath !== null) {
            const backgroundRoute = readPortalRoute(
              new URL(returnPath, window.location.origin).pathname,
            );
            if (backgroundRoute.kind === "workspace")
              selection = workspaceRouteSelection(
                backgroundRoute,
                membership.organisationId,
              );
          }
        }
        await this.loadWorkspaceDetail(
          session,
          membership,
          workspace,
          selection.page === "chat" ? "overview" : selection.page,
          selection.resourceId,
          routeRevision,
        );
        return;
      }
      document.title = "Organisations · Seams Pantry";
      this.setState(
        {
          kind: "organisation_list",
          identity: session.identity,
          memberships: session.memberships,
          membershipAvailability: session.membershipAvailability,
          supportRole: session.supportRole,
          operatorCase: null,
          busy: false,
          error: null,
        },
        focusPortalPage,
      );
    } catch (error) {
      if (routeRevision !== this.routeRevision) return;
      document.title = "Seams Pantry";
      this.setState({ kind: "load_failed", message: portalError(error) });
    }
  }

  retryLoad(): void {
    forgetControlReads();
    this.setState({ kind: "loading" });
    void this.load();
  }

  /**
   * The setup dialog stays open while the session is read again, so this
   * read keeps the organisation list on screen in place of the loading page.
   */
  async completeAccountSetup(
    nativeOrganizationId: string,
  ): Promise<AccountSetupListing> {
    const listed = this.accountSetupListing(nativeOrganizationId);
    if (listed !== null) {
      return listed;
    }
    forgetControlReads();
    await this.load();
    // `this.state` holds the new session only after React renders it.
    await new Promise<void>(this.forceUpdate.bind(this));
    return (
      this.accountSetupListing(nativeOrganizationId) ?? { kind: "missing" }
    );
  }

  accountSetupListing(
    nativeOrganizationId: string,
  ): AccountSetupListing | null {
    if (this.state.kind !== "organisation_list") {
      return null;
    }
    for (const membership of this.state.memberships) {
      if (membership.organisationId === nativeOrganizationId) {
        return {
          kind: "listed",
          organisationHandle: membership.organisationHandle,
          workspaceHandle: membership.workspaces[0]?.workspaceHandle ?? null,
        };
      }
    }
    return null;
  }

  async loadRouteNotFound(
    session: SessionSnapshot,
    organisationHandle: string | null,
    workspaceHandle: string | null,
    routeRevision: number,
  ): Promise<void> {
    const membership =
      organisationHandle === null
        ? undefined
        : session.memberships.find(
            findMembershipByOrganisationHandle(organisationHandle),
          );
    const organisations =
      membership === undefined
        ? []
        : await loadPortalOrganisations([membership]);
    if (routeRevision !== this.routeRevision) return;
    const organisation = organisations[0] ?? null;
    const workspaceExists =
      workspaceHandle === null ||
      membership?.workspaces.some(findWorkspaceByHandle(workspaceHandle)) ===
        true;
    document.title = `Page not found · ${organisation?.organisation.name ?? "Seams Pantry"}`;
    this.setState(
      {
        kind: "route_not_found",
        reason:
          membership === undefined && organisationHandle !== null
            ? "organisation"
            : workspaceExists
              ? "page"
              : "workspace",
        identity: session.identity,
        organisation,
        workspace:
          workspaceHandle === null || membership === undefined
            ? null
            : (membership.workspaces.find(
                findWorkspaceByHandle(workspaceHandle),
              ) ?? null),
      },
      focusPortalPage,
    );
  }

  async loadWorkspaceDetail(
    session: SessionSnapshot,
    membership: Membership,
    workspace: OrganisationWorkspace,
    page: WorkspaceDetailPage = this.state.kind === "workspace_detail"
      ? this.state.page
      : "overview",
    commerceResourceId: string | null = null,
    routeRevision = this.routeRevision,
  ): Promise<void> {
    // The page's own reads and its code do not wait for the shell's reads.
    startShellReads(membership.organisationId);
    startWorkspacePageReads(page, membership.organisationId);
    startWorkspacePageCode(page);
    const snapshotRead = fetchShellOrganisationSnapshot(
      membership.organisationId,
    );
    const [snapshot, organisationChoices] = await Promise.all([
      snapshotRead,
      loadOrganisationChoices(session.memberships, {
        organisationId: membership.organisationId,
        snapshot: snapshotRead,
      }),
    ]);
    if (routeRevision !== this.routeRevision) return;
    rememberLastUsedWorkspace(
      membership.organisationHandle,
      workspace.workspaceHandle,
    );
    document.title = workspacePageDocumentTitle(
      workspacePageDescriptor(page),
      workspace.name,
      commerceResourceId,
    );
    this.setState(
      {
        kind: "workspace_detail",
        identity: session.identity,
        organisation: {
          membership,
          organisation: snapshot.organisation,
          configurationVersion: snapshot.configurationVersion,
        },
        workspace,
        organisationChoices,
        steps: snapshot.steps,
        setupSelection: snapshot.setupSelection,
        accounts: snapshot.accounts,
        commerceSystem: null,
        commerceSyncProblem: null,
        readiness: snapshot.readiness,
        activation: snapshot.activation,
        nextAction: snapshot.nextAction,
        firstTask: snapshot.firstTask,
        projectionRevision: snapshot.projectionRevision,
        configurationVersion: snapshot.configurationVersion,
        supportReference: snapshot.supportReference,
        page,
        commerceAction: null,
        mutations: MutationLedger.empty(),
        error: null,
      },
      () => {
        focusPortalPage();
        this.recordStageViewed(snapshot);
        this.maybeAdvanceOnboarding();
        this.loadCurrentWorkspaceRoute();
        void this.resumePendingCommerceApproval(membership.organisationId);
        this.openLinkedCommerceAction();
      },
    );
  }

  applyWorkspaceRoute(selection: WorkspaceRouteSelection): void {
    if (
      this.state.kind !== "workspace_detail" ||
      this.state.organisation.organisation.organisationId !==
        selection.organisationId
    ) {
      void this.load();
      return;
    }
    if (selection.page === "chat") {
      document.title = workspacePageDocumentTitle(
        workspacePageDescriptor("chat"),
        this.state.workspace.name,
        null,
      );
      const besideChat = this.pageSelection(selection);
      if (besideChat.page === "chat" || besideChat.page === this.state.page)
        return;
      // The chat stays open and the page beside it changes.
      startWorkspacePageReads(besideChat.page, besideChat.organisationId);
      this.setState(
        { ...this.state, page: besideChat.page, commerceAction: null, error: null },
        this.loadCurrentWorkspaceRoute,
      );
      return;
    }
    const page = selection.page;
    // The next page's reads start now, before its code and its first render.
    startWorkspacePageReads(page, selection.organisationId);
    this.setState(
      {
        ...this.state,
        page,
        commerceAction: null,
        error: null,
      },
      this.completeWorkspaceRouteChange,
    );
  }

  completeWorkspaceRouteChange(): void {
    this.loadCurrentWorkspaceRoute();
    focusPortalPage();
  }

  loadCurrentWorkspaceRoute(): void {
    if (
      this.state.kind !== "workspace_detail" ||
      this.props.route.kind !== "workspace"
    ) {
      return;
    }
    const selection = workspaceRouteSelection(
      this.props.route,
      this.state.organisation.organisation.organisationId,
    );
    if (selection.page === "chat") {
      document.title = workspacePageDocumentTitle(
        workspacePageDescriptor("chat"),
        this.state.workspace.name,
        null,
      );
      const besideChat = this.pageSelection(selection);
      if (
        besideChat.page === this.state.page &&
        isCommercePage(besideChat.page)
      )
        void this.loadCommerceSystemRoute(besideChat.organisationId);
      return;
    }
    if (
      selection.organisationId !==
        this.state.organisation.organisation.organisationId ||
      selection.page !== this.state.page
    ) {
      return;
    }
    document.title = workspacePageDocumentTitle(
      workspacePageDescriptor(selection.page),
      this.state.workspace.name,
      selection.resourceId,
    );
    if (selection.page === "overview") {
      return;
    }
    if (isCommercePage(selection.page)) {
      void this.loadCommerceSystemRoute(selection.organisationId);
      return;
    }
  }

  async loadCommerceSystemRoute(
    organisationId: string,
    routeRevision = this.routeRevision,
  ): Promise<void> {
    try {
      const commerceSystem = await fetchCommerceSystem(organisationId);
      if (
        routeRevision !== this.routeRevision ||
        this.state.kind !== "workspace_detail" ||
        this.state.organisation.organisation.organisationId !==
          organisationId ||
        !isCommercePage(this.state.page)
      )
        return;
      this.setState({
        ...this.state,
        commerceSystem,
        commerceSyncProblem: null,
      });
    } catch {
      // Commerce resource pages remain usable when source context is temporarily unavailable.
    }
  }

  maybeAdvanceOnboarding(): void {
    if (this.state.kind !== "workspace_detail") {
      return;
    }
    if (
      this.state.organisation.organisation.lifecycle === "configuring" &&
      this.state.readiness?.kind === "ready" &&
      this.state.activation.kind === "idle"
    ) {
      void this.activate();
      return;
    }
    if (
      !needsReadinessEvaluation(this.state.readiness) ||
      this.state.organisation.organisation.lifecycle === "archived"
    ) {
      return;
    }
    void this.evaluateReadiness();
  }

  openWorkspace(target: WorkspaceRouteTarget): void {
    this.props.navigate(
      workspacePagePath(
        target.organisationHandle,
        target.workspaceHandle,
        "overview",
      ),
    );
  }

  async inspectLegacyOrganisation(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (
      this.state.kind !== "organisation_list" ||
      this.state.supportRole !== "support_admin" ||
      this.state.busy
    ) {
      return;
    }
    const organisationId = new FormData(event.currentTarget).get(
      "operatorOrganisationId",
    );
    if (
      typeof organisationId !== "string" ||
      organisationId.trim().length === 0
    ) {
      this.setState({ ...this.state, error: "Enter the full workspace ID." });
      return;
    }
    this.setState({
      ...this.state,
      busy: true,
      error: null,
      operatorCase: null,
    });
    try {
      const operatorCase = await fetchOperatorOrganisationCase(
        organisationId.trim(),
      );
      this.setState({ ...this.state, busy: false, error: null, operatorCase });
    } catch (error) {
      this.setState({
        ...this.state,
        busy: false,
        error: portalError(error),
        operatorCase: null,
      });
    }
  }

  async archiveLegacyOrganisation(): Promise<void> {
    if (
      this.state.kind !== "organisation_list" ||
      this.state.supportRole !== "support_admin" ||
      this.state.operatorCase === null ||
      this.state.busy
    ) {
      return;
    }
    const operatorCase = this.state.operatorCase;
    this.setState({ ...this.state, busy: true, error: null });
    try {
      await archiveOwnerlessLegacyOrganisation(operatorCase);
      const refreshed = await fetchOperatorOrganisationCase(
        operatorCase.organisationId,
      );
      this.setState({
        ...this.state,
        busy: false,
        error: null,
        operatorCase: refreshed,
      });
      toast.success("Older workspace archived.");
    } catch (error) {
      this.setState({ ...this.state, busy: false, error: portalError(error) });
    }
  }

  async logout(): Promise<void> {
    try {
      await controlMutation("/v1/control/logout", "POST", {});
    } finally {
      forgetControlReads();
      this.props.navigate("/sign-in");
    }
  }

  startActivationProjectionPolling(
    organisationId: string,
    projectionRevision: number,
  ): void {
    this.activationProjection = {
      organisationId,
      projectionEtag: organisationProjectionEtag(
        organisationId,
        projectionRevision,
      ),
      observedActivating: false,
      pollDelayMs: 500,
    };
    this.clearActivationPollTimer();
    this.activationPollTimer = window.setTimeout(
      this.pollActivationProjection,
      500,
    );
  }

  async pollActivationProjection(): Promise<void> {
    const tracked = this.activationProjection;
    if (tracked === null) {
      return;
    }
    try {
      const projection = await fetchOrganisationSnapshotIfChanged(
        tracked.organisationId,
        tracked.projectionEtag,
      );
      const lifecycle =
        projection.kind === "changed"
          ? projection.snapshot.organisation.lifecycle
          : currentOrganisationLifecycle(this.state, tracked.organisationId);
      const observedActivating =
        tracked.observedActivating || lifecycle === "activating";
      if (projection.kind === "changed") {
        this.applyOrganisationSnapshot(projection.snapshot);
      }
      if (observedActivating && lifecycle !== "activating") {
        this.stopActivationProjectionPolling();
        return;
      }
      const next: ActivationProjectionTracking = {
        organisationId: tracked.organisationId,
        projectionEtag: projection.etag,
        observedActivating,
        pollDelayMs: Math.min(Math.ceil(tracked.pollDelayMs * 1.5), 3_000),
      };
      this.activationProjection = next;
      this.activationPollTimer = window.setTimeout(
        this.pollActivationProjection,
        next.pollDelayMs,
      );
    } catch {
      this.stopActivationProjectionPolling();
    }
  }

  stopActivationProjectionPolling(): void {
    this.activationProjection = null;
    this.clearActivationPollTimer();
  }

  clearActivationPollTimer(): void {
    if (this.activationPollTimer !== null) {
      window.clearTimeout(this.activationPollTimer);
      this.activationPollTimer = null;
    }
  }

  applyOrganisationSnapshot(
    snapshot: OrganisationSnapshot,
    completedMutation?: OrganisationMutation,
  ): void {
    if (
      this.state.kind !== "workspace_detail" ||
      this.state.organisation.organisation.organisationId !==
        snapshot.organisation.organisationId
    ) {
      return;
    }
    this.setState(
      {
        ...this.state,
        organisation: {
          membership: this.state.organisation.membership,
          organisation: snapshot.organisation,
          configurationVersion: snapshot.configurationVersion,
        },
        steps: snapshot.steps,
        setupSelection: snapshot.setupSelection,
        accounts: snapshot.accounts,
        readiness: snapshot.readiness,
        activation: snapshot.activation,
        nextAction: snapshot.nextAction,
        firstTask: snapshot.firstTask,
        projectionRevision: snapshot.projectionRevision,
        configurationVersion: snapshot.configurationVersion,
        supportReference: snapshot.supportReference,
        mutations:
          completedMutation === undefined
            ? this.state.mutations
            : this.state.mutations.remove(completedMutation),
        error: completedMutation === undefined ? this.state.error : null,
      },
      this.maybeAdvanceOnboarding,
    );
    this.recordStageViewed(snapshot);
  }

  recordStageViewed(snapshot: OrganisationSnapshot): void {
    const stage = projectionStage(snapshot.steps, snapshot.nextAction);
    const stageKey = `${snapshot.organisation.organisationId}:${stage}`;
    if (this.stageViewedKey === stageKey) {
      return;
    }
    this.stageViewedKey = stageKey;
    void emitOnboardingStageViewed(snapshot.organisation.organisationId, stage);
  }

  async refreshOrganisationAfterProviderFlow(): Promise<void> {
    const organisationId = this.currentOrganisationId();
    if (organisationId === null || this.state.kind !== "workspace_detail") {
      return;
    }
    try {
      const snapshot = await fetchShellOrganisationSnapshot(organisationId);
      this.applyOrganisationSnapshot(snapshot);
      this.loadCurrentWorkspaceRoute();
    } catch (error) {
      this.setOrganisationError(portalError(error), { kind: "readiness" });
    }
  }

  async evaluateReadiness(): Promise<void> {
    const organisationId = this.currentOrganisationId();
    const mutation: OrganisationMutation = { kind: "readiness" };
    if (
      organisationId === null ||
      this.state.kind !== "workspace_detail" ||
      !this.setOrganisationBusy(mutation)
    )
      return;
    try {
      await fetchReadiness(organisationId);
      const snapshot = await fetchShellOrganisationSnapshot(organisationId);
      this.applyOrganisationSnapshot(snapshot, { kind: "readiness" });
    } catch (error) {
      this.setOrganisationError(portalError(error), { kind: "readiness" });
    }
  }

  async activate(): Promise<void> {
    if (
      this.state.kind !== "workspace_detail" ||
      this.state.readiness?.kind !== "ready"
    ) {
      return;
    }
    const readiness = this.state.readiness;
    const organisationId = this.state.organisation.organisation.organisationId;
    const configurationVersion = this.state.configurationVersion;
    if (!this.setOrganisationBusy({ kind: "activation" })) return;
    this.startActivationProjectionPolling(
      organisationId,
      this.state.projectionRevision,
    );
    try {
      await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/activate`,
        "POST",
        {
          readinessVersion: readiness.readinessVersion,
          readinessHash: readiness.readinessHash,
        },
        configurationVersion,
      );
      await this.refreshOrganisation("Workspace activated.", {
        kind: "activation",
      });
    } catch (error) {
      await this.handleOrganisationMutationError(error, { kind: "activation" });
    } finally {
      this.stopActivationProjectionPolling();
    }
  }

  currentOrganisationId(): string | null {
    return this.state.kind === "workspace_detail"
      ? this.state.organisation.organisation.organisationId
      : null;
  }

  currentWorkspaceHandle(): string | null {
    return this.state.kind === "workspace_detail"
      ? this.state.workspace.workspaceHandle
      : null;
  }

  currentOrganisationHandle(): string | null {
    return this.state.kind === "workspace_detail"
      ? this.state.organisation.membership.organisationHandle
      : null;
  }

  setOrganisationBusy(action: OrganisationMutation): boolean {
    if (this.state.kind !== "workspace_detail") return false;
    const result = this.state.mutations.add(action);
    if (result.kind !== "added") return false;
    this.setState({
      ...this.state,
      mutations: result.ledger,
      error: null,
    });
    return true;
  }

  setOrganisationError(
    message: string,
    completedMutation?: OrganisationMutation,
  ): void {
    if (this.state.kind !== "workspace_detail") return;
    this.setState({
      ...this.state,
      mutations:
        completedMutation === undefined
          ? this.state.mutations
          : this.state.mutations.remove(completedMutation),
      error: {
        page: this.state.page,
        message,
        mutation: completedMutation ?? null,
      },
    });
  }

  async handleOrganisationMutationError(
    error: unknown,
    mutation: OrganisationMutation,
  ): Promise<void> {
    if (!isConfigurationConflict(error)) {
      this.setOrganisationError(portalError(error), mutation);
      return;
    }
    await this.refreshOrganisationAfterProviderFlow();
    this.setOrganisationError(CONFLICT_MESSAGE, mutation);
  }

  completeOrganisationMutation(mutation: OrganisationMutation): void {
    if (this.state.kind !== "workspace_detail") return;
    this.setState({
      ...this.state,
      mutations: this.state.mutations.remove(mutation),
    });
  }

  async refreshOrganisation(
    notice: string,
    mutation: OrganisationMutation,
  ): Promise<void> {
    const organisationId = this.currentOrganisationId();
    if (organisationId === null || this.state.kind !== "workspace_detail") {
      return;
    }
    const snapshot = await fetchShellOrganisationSnapshot(organisationId);
    this.applyOrganisationSnapshot(snapshot, mutation);
    this.loadCurrentWorkspaceRoute();
    toast.success(notice);
  }

  render(): React.ReactNode {
    if (
      this.accountInvitationRoute.kind !== "none" &&
      (this.state.kind === "organisation_list" ||
        this.state.kind === "workspace_detail" ||
        this.state.kind === "route_not_found")
    ) {
      return (
        <AccountInvitationPage
          route={this.accountInvitationRoute}
          displayName={this.state.identity.displayName}
          logout={this.logout}
        />
      );
    }
    switch (this.state.kind) {
      case "loading":
        return <PortalLoading route={this.props.route} />;
      case "signed_out":
        return <SignIn />;
      case "load_failed":
        return (
          <PortalLoadFailure
            message={this.state.message}
            retry={this.retryLoad}
          />
        );
      case "route_not_found":
        return (
          <UserPreferencesProvider
            key={this.state.identity.userId}
            userId={this.state.identity.userId}
          >
            {renderRouteNotFound(this.state, this.logout)}
          </UserPreferencesProvider>
        );
      case "organisation_list":
        return (
          <UserPreferencesProvider
            key={this.state.identity.userId}
            userId={this.state.identity.userId}
          >
            {this.renderOrganisationList(this.state)}
          </UserPreferencesProvider>
        );
      case "workspace_detail":
        return (
          <UserPreferencesProvider
            key={this.state.identity.userId}
            userId={this.state.identity.userId}
          >
            {this.renderWorkspaceDetail(this.state)}
          </UserPreferencesProvider>
        );
      default:
        return assertNever(this.state, "Unexpected portal state");
    }
  }

  renderOrganisationList(
    state: Variant<PortalState, "organisation_list">,
  ): React.ReactNode {
    return (
      <OrganisationsRoute
        displayName={state.identity.displayName}
        logout={this.logout}
        membershipAvailability={state.membershipAvailability}
        retryMemberships={this.retryLoad}
        loadOrganisations={loadOrganisationListItems.bind(
          null,
          state.memberships,
        )}
        userId={state.identity.userId}
        onSetupComplete={this.completeAccountSetup}
        organisationActions={ORGANISATION_ACTIONS}
        openWorkspace={this.openWorkspace}
        supportTools={organisationSupportTools(
          state,
          this.inspectLegacyOrganisation,
          this.archiveLegacyOrganisation,
        )}
      />
    );
  }

  renderWorkspaceDetail(
    state: Variant<PortalState, "workspace_detail">,
  ): React.ReactNode {
    const canManage = canManageOrganisation(state.organisation.membership.role);
    const chatOpen = isPortalChatRoute(this.props.route);
    const integrationsPage = state.page === "integrations";
    const accessPage = state.page === "access";
    const settingsPage = state.page === "settings";
    const pageDescriptor = workspacePageDescriptor(state.page);
    const routeSelection = currentWorkspaceRouteSelection(
      this.props.route,
      state.organisation.organisation.organisationId,
      state.organisation.membership.organisationHandle,
      state.workspace.workspaceHandle,
      state.page,
    );
    const pageHeader = workspacePageHeader(
      pageDescriptor,
      routeSelection.resourceId,
    );
    // These pages open on the record's own heading, not the page title.
    const commerceRecordPage =
      (state.page === "products" || state.page === "orders") &&
      routeSelection.resourceId !== null;
    const workspacePageContent =
      PAGES[state.page].render({
      state,
      canManage,
      routeSelection,
      app: this,
    });
    return (
      <OrganisationPageRouteContext.Provider
        value={
          <BakeryWorkspaceReveal
            key={`${state.organisation.organisation.organisationId}:${state.workspace.workspaceHandle}`}
            organisationId={state.organisation.organisation.organisationId}
            currentPageIsBakery={state.page === "workflow-simulator"}
            chatOpen={chatOpen}
            bakery={
              <React.Suspense
                fallback={<PageSkeleton label="Loading workflow simulator" />}
              >
                <WorkflowSimulatorRoute
                  key={`${state.organisation.organisation.organisationId}:${state.workspace.workspaceHandle}`}
                  connection={{
                    kind: "workspace",
                    organisationId:
                      state.organisation.organisation.organisationId,
                    canManage,
                    mutate: commerceEntityPlaneControlMutation,
                    chatPath: workspacePagePath(
                      state.organisation.membership.organisationHandle,
                      state.workspace.workspaceHandle,
                      "chat",
                    ),
                  }}
                />
              </React.Suspense>
            }
          >
            <React.Suspense
              fallback={<PageSkeleton label={`Loading ${pageHeader.title}`} />}
            >
              {workspacePageContent}
            </React.Suspense>
          </BakeryWorkspaceReveal>
        }
      >
        <BakerySurfaceEffectBridge
          key={`${state.organisation.organisation.organisationId}:${state.workspace.workspaceHandle}`}
          organisationId={state.organisation.organisation.organisationId}
          active={chatOpen}
          reveal={revealBakeryWorkspace.bind(
            null,
            state.organisation.organisation.organisationId,
          )}
        />
        <WorkspaceLayout
          organisationId={state.organisation.organisation.organisationId}
          access={ACCESS_ROUTE_TRANSPORT}
          loadCodexUsage={fetchCodexUsagePercent}
          displayName={state.identity.displayName}
          logout={this.logout}
          organisation={{
            organisationHandle:
              state.organisation.membership.organisationHandle,
            name: state.organisation.organisation.name,
            choices: state.organisationChoices,
          }}
          workspace={{
            workspaceHandle: state.workspace.workspaceHandle,
            name: state.workspace.name,
            choices: state.organisation.membership.workspaces.map(
              toWorkspaceChoice.bind(
                null,
                state.organisation.membership.organisationHandle,
              ),
            ),
          }}
          activePage={state.page}
          chatOpen={chatOpen}
          chat={
            chatOpen
              ? {
                  close: this.closeChatUnderlay,
                  content: (
                    <React.Suspense
                      fallback={<PageSkeleton label="Loading chat" />}
                    >
                      <ChatPage
                        context={{
                          organisation: state.organisation.organisation.name,
                          workspace: state.workspace.name,
                          area: pageDescriptor.group,
                          view: pageDescriptor.navigationLabel,
                        }}
                        close={this.closeChatUnderlay}
                        key={state.organisation.organisation.organisationId}
                        organisationId={
                          state.organisation.organisation.organisationId
                        }
                        canManage={canManage}
                        basePath={workspacePagePath(
                          state.organisation.membership.organisationHandle,
                          state.workspace.workspaceHandle,
                          "chat",
                        )}
                        integrationsPath={workspacePagePath(
                          state.organisation.membership.organisationHandle,
                          state.workspace.workspaceHandle,
                          "integrations",
                        )}
                        accessPath={workspacePagePath(
                          state.organisation.membership.organisationHandle,
                          state.workspace.workspaceHandle,
                          "access",
                        )}
                        sourceLinks={{
                          supplierHref: workspaceResourcePath.bind(
                            null,
                            state.organisation.membership.organisationHandle,
                            state.workspace.workspaceHandle,
                            "supplier",
                          ),
                          orderHref: workspaceResourcePath.bind(
                            null,
                            state.organisation.membership.organisationHandle,
                            state.workspace.workspaceHandle,
                            "customer_order",
                          ),
                          memoryHref: brainMemoryPath.bind(
                            null,
                            workspacePagePath(
                              state.organisation.membership.organisationHandle,
                              state.workspace.workspaceHandle,
                              "knowledge",
                            ),
                          ),
                        }}
                        access={ACCESS_ROUTE_TRANSPORT}
                        signedInAs={state.identity.displayName}
                      />
                    </React.Suspense>
                  ),
                }
              : null
          }
          sidebarFooter={renderWorkspaceSidebarFooter(state)}
          title={pageHeader.title}
          // The Inbox heads itself with what needs the person.
          hideHeader={commerceRecordPage || state.page === "inbox"}
          description={pageHeader.description}
          status={
            <>
              {state.error === null ||
              state.error.page !== state.page ||
              ((integrationsPage || accessPage || settingsPage) &&
                state.error.mutation !== null) ? null : (
                <p className="error-text portal-error" role="alert">
                  {state.error.message}
                </p>
              )}
              {state.commerceAction === null ? null : (
                <CommerceActionStatus
                  action={state.commerceAction}
                  approve={this.approveCurrentCommerceAction}
                  reject={this.rejectCurrentCommerceAction}
                  execute={this.executeCommerceAction}
                  readPluginPreview={this.readCommerceActionPluginPreview}
                  canAct={canManage}
                  disabled={mutationKindActive(
                    state.mutations,
                    "commerce_action",
                  )}
                />
              )}
            </>
          }
        />
      </OrganisationPageRouteContext.Provider>
    );
  }

  closeChatUnderlay(): void {
    if (this.state.kind !== "workspace_detail") return;
    const organisationHandle =
      this.state.organisation.membership.organisationHandle;
    const workspaceHandle = this.state.workspace.workspaceHandle;
    const returnPath = chatReturnPathForWorkspace(
      this.props.chatReturnPath,
      organisationHandle,
      workspaceHandle,
    );
    this.props.navigate(
      returnPath ??
        workspacePagePath(organisationHandle, workspaceHandle, this.state.page),
      { replace: true },
    );
  }
  /** The open plugin action's run over recent checkouts, read now. */
  async readCommerceActionPluginPreview(): Promise<MerchantPluginPreview> {
    const organisationId = this.currentOrganisationId();
    const action =
      this.state.kind === "workspace_detail" ? this.state.commerceAction : null;
    if (organisationId === null || action === null)
      throw new Error("No plugin action is open.");
    return parseMerchantPluginPreviewResponse(
      await controlRead(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/actions/${encodeURIComponent(action.nonce)}/plugin-preview`,
      ),
    );
  }

  async approveCurrentCommerceAction(): Promise<void> {
    const organisationId = this.currentOrganisationId();
    if (
      organisationId === null ||
      this.state.kind !== "workspace_detail" ||
      this.state.commerceAction === null ||
      !this.setOrganisationBusy({
        kind: "commerce_action",
        operation: "approve",
      })
    )
      return;
    const nonce = this.state.commerceAction.nonce;
    const stepUp = (error: unknown): boolean =>
      error instanceof ControlApiError && error.kind === "approval_step_up_required";
    try {
      try {
        await this.approveCommerceAction(organisationId, nonce);
      } catch (first) {
        // The sign-in opens in a small window; a blocked window falls back
        // to the sign-in on this page.
        if (!stepUp(first)) throw first;
        const signIn = await signInForApproval(organisationId, nonce);
        if (signIn === "blocked") throw first;
        try {
          await this.approveCommerceAction(organisationId, nonce);
        } catch (second) {
          if (!stepUp(second)) throw second;
          this.setOrganisationError(
            portalError(new Error("The sign-in did not finish, so nothing changed. Try again.")),
            { kind: "commerce_action", operation: "approve" },
          );
          return;
        }
      }
      toast.success("Action approved with your Seams identity.");
      // One click approves and applies (the owner, 2026-11-07).
      await this.executeCommerceAction();
    } catch (error) {
      if (stepUp(error)) {
        this.beginCommerceApprovalStepUp(organisationId, nonce);
        return;
      }
      this.setOrganisationError(portalError(error), {
        kind: "commerce_action",
        operation: "approve",
      });
    }
  }

  async loadCommerceAction(actionNonce: string): Promise<void> {
    const organisationId = this.currentOrganisationId();
    if (
      organisationId === null ||
      this.state.kind !== "workspace_detail" ||
      !this.setOrganisationBusy({ kind: "commerce_action", operation: "load" })
    )
      return;
    try {
      const status = parseCommerceActionRecordResponse(
        await controlRead(
          `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/actions/${encodeURIComponent(actionNonce)}`,
        ),
      );
      this.setState((current) =>
        current.kind === "workspace_detail"
          ? {
              ...current,
              commerceAction: status,
              mutations: current.mutations.remove({
                kind: "commerce_action",
                operation: "load",
              }),
              error: null,
            }
          : current,
      );
    } catch (error) {
      this.setOrganisationError(portalError(error), {
        kind: "commerce_action",
        operation: "load",
      });
    }
  }

  async rejectCurrentCommerceAction(): Promise<void> {
    const organisationId = this.currentOrganisationId();
    if (
      organisationId === null ||
      this.state.kind !== "workspace_detail" ||
      this.state.commerceAction === null ||
      !this.setOrganisationBusy({
        kind: "commerce_action",
        operation: "reject",
      })
    )
      return;
    const nonce = this.state.commerceAction.nonce;
    try {
      const raw = await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/actions/${encodeURIComponent(nonce)}/rejection`,
        "POST",
        { reason: "merchant_declined" },
        undefined,
        `commerce-action-rejection:${nonce}`,
      );
      const status = parseCommerceActionRecordResponse(raw);
      this.refreshOperationsAfterAction(status, {
        kind: "commerce_action",
        operation: "reject",
      });
      toast.info("Action rejected. No provider change was made.");
    } catch (error) {
      this.setOrganisationError(portalError(error), {
        kind: "commerce_action",
        operation: "reject",
      });
    }
  }

  async approveCommerceAction(
    organisationId: string,
    actionNonce: string,
  ): Promise<void> {
    const approval = await controlMutation(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/actions/${encodeURIComponent(actionNonce)}/approval`,
      "POST",
      {},
      undefined,
      `commerce-action-approval:${actionNonce}`,
    );
    parseCommerceApprovalResponse(approval);
    const status = parseCommerceActionRecordResponse(
      await controlRead(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/actions/${encodeURIComponent(actionNonce)}`,
      ),
    );
    this.refreshOperationsAfterAction(status, {
      kind: "commerce_action",
      operation: "approve",
    });
  }

  beginCommerceApprovalStepUp(
    organisationId: string,
    actionNonce: string,
  ): void {
    const returnPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    writePendingCommerceApproval({
      organisationId,
      actionNonce,
      returnPath,
      createdAt: Date.now(),
    });
    const query = new URLSearchParams({
      purpose: "approval",
      organisation: organisationId,
      action: actionNonce,
      returnTo: returnPath,
    });
    window.location.assign(`/v1/control/auth/google/start?${query.toString()}`);
  }

  /** Opens the action that a link names, such as an approval link in Slack. */
  openLinkedCommerceAction(): void {
    const nonce = new URL(window.location.href).searchParams.get(
      "commerceAction",
    );
    if (nonce !== null && nonce.length > 0 && nonce.length <= 128)
      void this.loadCommerceAction(nonce);
  }

  async resumePendingCommerceApproval(organisationId: string): Promise<void> {
    const pending = readPendingCommerceApproval();
    if (
      pending === null ||
      pending.organisationId !== organisationId ||
      pending.returnPath !== currentPortalPath()
    ) {
      return;
    }
    if (
      !this.setOrganisationBusy({
        kind: "commerce_action",
        operation: "approve",
      })
    )
      return;
    try {
      await this.approveCommerceAction(organisationId, pending.actionNonce);
      clearPendingCommerceApproval(pending);
      toast.success("Action approved with your Seams identity.");
      // On the Operations page the approved change applies at once; a chat
      // card applies its own change.
      if (this.state.kind === "workspace_detail" && this.state.commerceAction?.nonce === pending.actionNonce)
        await this.executeCommerceAction();
    } catch (error) {
      if (
        error instanceof ControlApiError &&
        error.kind === "approval_step_up_required"
      ) {
        this.beginCommerceApprovalStepUp(organisationId, pending.actionNonce);
        return;
      }
      clearPendingCommerceApproval(pending);
      this.setOrganisationError(portalError(error), {
        kind: "commerce_action",
        operation: "approve",
      });
    }
  }

  async executeCommerceAction(): Promise<void> {
    const organisationId = this.currentOrganisationId();
    if (
      organisationId === null ||
      this.state.kind !== "workspace_detail" ||
      this.state.commerceAction === null ||
      !this.setOrganisationBusy({
        kind: "commerce_action",
        operation: "execute",
      })
    )
      return;
    const nonce = this.state.commerceAction.nonce;
    const reconciling = this.state.commerceAction.state === "indeterminate";
    try {
      const raw = await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/actions/${encodeURIComponent(nonce)}/execute`,
        "POST",
        {},
        undefined,
        reconciling
          ? `commerce-action-reconcile:${nonce}`
          : `commerce-action-execute:${nonce}`,
      );
      const status = parseCommerceActionExecutionResponse(raw);
      this.refreshOperationsAfterAction(status, {
        kind: "commerce_action",
        operation: "execute",
      });
      if (status.state === "indeterminate")
        toast.info(
          "The provider outcome is still unknown. Check this action again later.",
        );
      else if (status.state === "failed")
        toast.error("The commerce action failed. Review the recorded outcome.");
      else
        toast.success(
          status.state === "confirmed"
            ? "Commerce action accepted."
            : `Commerce action is ${status.state}.`,
        );
    } catch (error) {
      this.setOrganisationError(portalError(error), {
        kind: "commerce_action",
        operation: "execute",
      });
    }
  }

  refreshOperationsAfterAction(
    commerceAction: CommerceActionRecord,
    mutation: OrganisationMutation,
  ): void {
    this.setState((current) =>
      current.kind === "workspace_detail"
        ? {
            ...current,
            commerceAction,
            mutations: current.mutations.remove(mutation),
            error: null,
          }
        : current,
    );
  }

  setProposedCommerceAction(commerceAction: CommerceActionRecord): void {
    this.setState((current) =>
      current.kind === "workspace_detail"
        ? { ...current, commerceAction, error: null }
        : current,
    );
  }

  backCommercePage(page: "products" | "orders" | "suppliers"): void {
    const organisationHandle = this.currentOrganisationHandle();
    const workspaceHandle = this.currentWorkspaceHandle();
    if (organisationHandle === null || workspaceHandle === null) return;
    this.props.navigate(
      workspacePagePath(organisationHandle, workspaceHandle, page),
    );
  }
}
