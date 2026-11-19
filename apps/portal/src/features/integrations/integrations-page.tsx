import {
  useClaudeConnection,
  type ClaudeConnectionState,
} from "./claude-connection";
import React from "react";
import {
  useTypeSafeConnection,
  type TypeSafeConnectionState,
} from "./typesafe-connection";
import {
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router";
import {
  PageSkeleton,
  ProviderTile,
  RecoverableError,
  type ProviderTileName,
  type StatusChipStatus,
} from "../../page-components";
import { workspacePagePath } from "../../route";
import {
  providerLabel,
  providerSearchAliases,
  providerTile,
} from "../../integration-catalogue";
import {
  announceSupportDiagnostics,
  ownSupportDiagnostics,
} from "../../pages/integration-support-toast";
import type {
  ConnectedAppItem,
  IntegrationCatalogItem,
} from "./overview";
import type { IntegrationRouteId } from "./model";
import { CustomConnectorsWorkspace } from "./custom-connectors";
import { assertNever } from "@purin-labs/std";
import {
  useOnePasswordStatus,
  type OnePasswordStatus,
} from "../vault/onepassword-status";
import {
  compareIntegrationAccountUrgency,
  connectionNeedsAttention,
} from "./accounts";
import {
  ActivationBand,
  setupLiveState,
} from "./activation";
import { autoSyncCommerce } from "./commerce-system";
import { buildIntegrationEntries } from "./entries";
import { isSlackAccount } from "./settings-support";
import type { IntegrationAccount, IntegrationAccountLifecycle, OrganisationCodexConnection, OrganisationInferenceSelection, ReadinessAssessment } from "@purin-labs/control-api/portal/settings";
import type { IntegrationsPageProps, SelectedIntegrationDetailContent } from "./settings-types";
import {
  announceConnectionAttention,
  connectionAttentionMessage,
} from "./setup";

export type IntegrationEntry = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly tile: ProviderTileName;
  readonly accounts: readonly IntegrationAccount[];
  readonly connected: boolean;
  readonly status?: IntegrationRailStatus;
  readonly panel: React.ReactNode;
};

export function IntegrationsPage(
  props: IntegrationsPageProps,
): React.ReactNode {
  const navigate = useNavigate();
  const location = useLocation();
  const closeConnection = closeIntegrationConnection.bind(
    null,
    navigate,
    location.search,
  );
  const basePath =
    props.integrationBasePath ??
    workspacePagePath(
      props.organisationHandle,
      props.workspaceHandle,
      "integrations",
    );
  const [typesafeState, setTypeSafeState] = useTypeSafeConnection(
    props.organisationId,
    props.canManage,
  );
  const [claudeState, setClaudeState] = useClaudeConnection(
    props.organisationId,
  );
  const onePassword = useOnePasswordStatus(props.organisationId);
  const live = setupLiveState(
    props.commerceSystem,
    props.accounts,
    props.setupDefaults,
    props.inferenceSelection,
    props.codexConnection,
    claudeState,
  );
  const inferenceWasChosen = React.useRef(live.inferenceChosen);
  React.useEffect(
    refreshWhenInferenceReady.bind(
      null,
      inferenceWasChosen,
      live.inferenceChosen,
      readinessHolds(props.readiness, "runtime_admission_unavailable"),
      props.actions.refreshOverview,
    ),
    [live.inferenceChosen],
  );
  const entries = buildIntegrationEntries(
    props,
    claudeState,
    setClaudeState,
    typesafeState,
    setTypeSafeState,
    onePassword,
  );
  const active = requestedIntegrationEntry(entries, props.initialIntegrationId);
  const [query, setQuery] = React.useState(props.initialQuery ?? "");
  React.useEffect(
    syncIntegrationQuery.bind(null, props.initialQuery, setQuery),
    [props.initialQuery],
  );
  const catalog = entries.map(
    buildIntegrationCatalogItem.bind(null, basePath, query),
  );
  const connectedApps = [
    ...buildConnectedAppItems(
      basePath,
      query,
      entries,
      props.accounts,
      props.canManage,
    ),
    ...onePasswordConnectedApp(basePath, query, onePassword, props.canManage),
  ];
  const attentionMessage = connectionAttentionMessage(props.accounts);
  React.useEffect(announceConnectionAttention.bind(null, attentionMessage), [
    attentionMessage,
  ]);
  const diagnostics = ownSupportDiagnostics(props.supportDiagnostics, active);
  React.useEffect(announceSupportDiagnostics.bind(null, diagnostics), [
    diagnostics === null ? null : diagnostics.supportReference,
  ]);
  const autoSyncStarted = React.useRef(false);
  const commerceBehind =
    props.canManage &&
    props.commerceSystem?.kind === "satyr_commerce" &&
    props.commerceSystem.sync.kind === "delayed";
  React.useEffect(
    autoSyncCommerce.bind(
      null,
      autoSyncStarted,
      commerceBehind,
      props.actions.syncCommerceSystemQuietly,
    ),
    [commerceBehind],
  );
  React.useEffect(
    revealRequestedIntegrationAccount.bind(
      null,
      props.initialAccountId ?? null,
    ),
    [props.initialAccountId, props.detailContent],
  );
  React.useEffect(
    focusIntegrationOverviewReturnTarget.bind(
      null,
      active?.id ?? null,
      entries,
      props.accounts,
      props.initialFocusId ?? null,
    ),
    [active?.id, props.initialFocusId],
  );
  return (
    <div onClick={navigateIntegrationLink.bind(null, navigate)}>
      <ActivationBand
        onActivate={props.actions.activate}
        organisationHandle={props.organisationHandle}
        workspaceHandle={props.workspaceHandle}
        organisationIsActive={props.organisationIsActive}
        readiness={props.readiness}
        activation={props.activation}
        firstTask={props.firstTask}
        supportReference={
          diagnostics === null ? null : diagnostics.supportReference
        }
        mutations={props.mutations}
        live={live}
        canManage={props.canManage}
        onOpenIntegration={openSetupIntegration.bind(
          null,
          navigateToIntegration.bind(null, navigate, basePath, query),
          props.actions.connectSlack,
          props.accounts.some(isSlackAccount),
        )}
      />
      <section
        className="portal-band integrations-panel integrations-page"
        aria-labelledby="connections-title"
      >
        <h2 id="connections-title" className="visually-hidden">
          Connected systems
        </h2>
        <CustomConnectorsWorkspace
          organisationId={props.organisationId}
          configurationVersion={props.configurationVersion}
          canManage={props.canManage}
          query={query}
          basePath={basePath}
          accessPath={workspacePagePath(
            props.organisationHandle,
            props.workspaceHandle,
            "access",
          )}
          presentation={{
            kind: "directory",
            title: active?.label ?? null,
            tile:
              active === null ? null : (
                <ProviderTile provider={active.tile} label={active.label} />
              ),
            description: active?.description ?? null,
            close: closeConnection,
            detail:
              active === null ? null : (
                <IntegrationDetail
                  entry={active}
                  detailContent={props.detailContent}
                  retryDetail={props.retryDetail}
                />
              ),
          }}
          directory={{
            apps: catalog
              .filter(isAppCatalogItem)
              .sort(compareIntegrationCatalogItems),
            workspaceSetup: catalog.filter(isWorkspaceSetupCatalogItem),
            connectedApps,
          }}
        />
      </section>
    </div>
  );
}

function navigateIntegrationLink(
  navigate: NavigateFunction,
  event: React.MouseEvent<HTMLDivElement>,
): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest("a");
  if (
    !(link instanceof HTMLAnchorElement) ||
    link.target ||
    link.hasAttribute("download")
  )
    return;
  const url = new URL(link.href);
  if (
    url.origin !== window.location.origin ||
    url.pathname !== window.location.pathname
  )
    return;
  event.preventDefault();
  void navigate(`${url.pathname}${url.search}${url.hash}`, {
    preventScrollReset: true,
  });
}

export function openIntegrationConnection(
  navigate: NavigateFunction,
  search: string,
  integrationId: IntegrationRouteId,
): void {
  const parameters = new URLSearchParams(search);
  if (parameters.get("integration") === integrationId) return;
  for (const key of ["account", "focus"]) parameters.delete(key);
  parameters.set("integration", integrationId);
  void navigate(
    { search: parameters.toString(), hash: "" },
    { preventScrollReset: true },
  );
}

function closeIntegrationConnection(
  navigate: NavigateFunction,
  search: string,
): void {
  const parameters = new URLSearchParams(search);
  for (const key of [
    "integration",
    "account",
    "customConnector",
    "setupAttempt",
    "customAction",
    "focus",
  ]) {
    parameters.delete(key);
  }
  void navigate(
    { search: parameters.toString(), hash: "" },
    { replace: true, preventScrollReset: true },
  );
}

function requestedIntegrationEntry(
  entries: readonly IntegrationEntry[],
  integrationId: string | undefined,
): IntegrationEntry | null {
  if (integrationId === undefined) return null;
  return (
    entries.find(matchesIntegrationEntryId.bind(null, integrationId)) ?? null
  );
}

function matchesIntegrationEntryId(
  integrationId: string,
  entry: IntegrationEntry,
): boolean {
  return entry.id === integrationId;
}

export function matchesRequestedIntegrationAccountId(
  accountId: string,
  account: IntegrationAccount,
): boolean {
  return account.integrationAccountId === accountId;
}

function syncIntegrationQuery(
  initialQuery: string | undefined,
  setQuery: React.Dispatch<React.SetStateAction<string>>,
): void {
  setQuery(initialQuery ?? "");
}

/**
 * The read that sees a ChatGPT sign-in finish runs beside the read of the
 * organisation, whose readiness the server assessed a moment earlier, and a
 * Claude sign-in reads no organisation at all. When the page sees the AI
 * source become ready while the readiness still says it is not, it reads the
 * overview once more, so the setup checklist does not stay behind.
 */
function refreshWhenInferenceReady(
  wasReady: React.MutableRefObject<boolean>,
  ready: boolean,
  readinessLags: boolean,
  refresh: () => void,
): void {
  const became = ready && !wasReady.current;
  wasReady.current = ready;
  if (became && readinessLags) refresh();
}

function readinessHolds(
  readiness: ReadinessAssessment | null,
  code: string,
): boolean {
  return (
    readiness?.kind === "blocked" &&
    readiness.blockers.some(readinessBlockerHasCode.bind(null, code))
  );
}

function readinessBlockerHasCode(
  code: string,
  blocker: { readonly code: string },
): boolean {
  return blocker.code === code;
}

/**
 * A setup step opens the panel of its integration. Without a Slack account
 * that panel holds only a Connect button, so the step starts the connection
 * at once and the consent dialog is the one dialog on screen. Continue then
 * opens the Slack panel, which waits for the Slack window.
 */
function openSetupIntegration(
  open: (integrationId: string) => void,
  connectSlack: () => Promise<void>,
  hasSlack: boolean,
  integrationId: string,
): void {
  if (integrationId === "slack" && !hasSlack) void connectSlack();
  else open(integrationId);
}

function navigateToIntegration(
  navigate: NavigateFunction,
  basePath: string,
  query: string,
  integrationId: string,
): void {
  void navigate(integrationDetailPath(basePath, integrationId, null, query), {
    preventScrollReset: true,
  });
}

function integrationDetailPath(
  basePath: string,
  integrationId: string,
  accountId: string | null,
  query: string,
): string {
  const parameters = new URLSearchParams({ integration: integrationId });
  if (accountId !== null) parameters.set("account", accountId);
  if (query.length > 0) parameters.set("q", query);
  return appendIntegrationParameters(basePath, parameters);
}

function appendIntegrationParameters(
  basePath: string,
  parameters: URLSearchParams,
): string {
  const separator = basePath.includes("?") ? "&" : "?";
  return `${basePath}${separator}${parameters.toString()}`;
}

function IntegrationDetail(props: {
  readonly entry: IntegrationEntry;
  readonly detailContent: SelectedIntegrationDetailContent | undefined;
  readonly retryDetail: (() => void) | undefined;
}): React.ReactNode {
  return (
    <div
      className="integration-detail"
      id={`integration-panel-${props.entry.id}`}
      aria-label={props.entry.label}
    >
      {renderSelectedIntegrationDetail(
        props.entry,
        props.detailContent,
        props.retryDetail,
      )}
    </div>
  );
}

function renderSelectedIntegrationDetail(
  entry: IntegrationEntry,
  content: SelectedIntegrationDetailContent | undefined,
  retry: (() => void) | undefined,
): React.ReactNode {
  if (content === undefined) return entry.panel;
  switch (content.kind) {
    case "idle":
      return <PageSkeleton label={`Loading ${entry.label}`} />;
    case "loading":
      return <PageSkeleton label={`Loading ${entry.label}`} />;
    case "ready":
      return content.integrationId === entry.id ? entry.panel : null;
    case "failed":
      return content.integrationId === entry.id ? (
        <RecoverableError
          message={content.problem}
          action={
            retry === undefined ? null : (
              <button type="button" onClick={retry}>
                Try again
              </button>
            )
          }
        />
      ) : null;
    default:
      return assertNever(content, "Unexpected settings state");
  }
}

function revealRequestedIntegrationAccount(
  accountId: string | null,
): (() => void) | undefined {
  if (accountId === null) return;
  const frame = requestAnimationFrame(
    revealIntegrationAccountElement.bind(null, accountId),
  );
  return cancelAnimationFrame.bind(null, frame);
}

function revealIntegrationAccountElement(accountId: string): void {
  const target = document.getElementById(`integration-account-${accountId}`);
  if (target === null || target.closest("dialog[open]") === null) return;
  target.scrollIntoView({ block: "nearest" });
}

function focusIntegrationOverviewReturnTarget(
  activeId: string | null,
  entries: readonly IntegrationEntry[],
  accounts: readonly IntegrationAccount[],
  focusId: string | null,
): void {
  if (activeId !== null || focusId === null) return;
  const targetId = resolveIntegrationOverviewFocusId(
    entries,
    accounts,
    focusId,
  );
  requestAnimationFrame(focusIntegrationOverviewElement.bind(null, targetId));
}

function resolveIntegrationOverviewFocusId(
  entries: readonly IntegrationEntry[],
  accounts: readonly IntegrationAccount[],
  focusId: string,
): string {
  if (focusId.startsWith("account:")) {
    const accountId = focusId.slice("account:".length);
    const account = accounts.find(
      matchesRequestedIntegrationAccountId.bind(null, accountId),
    );
    if (account !== undefined) {
      return `integration-overview-account-${account.integrationAccountId}`;
    }
  }
  if (focusId.startsWith("integration:")) {
    const integrationId = focusId.slice("integration:".length);
    const entry = entries.find(
      matchesIntegrationEntryId.bind(null, integrationId),
    );
    if (entry !== undefined) return `integration-overview-app-${entry.id}`;
  }
  return "browse-apps-title";
}

function focusIntegrationOverviewElement(targetId: string): void {
  const target = document.getElementById(targetId);
  if (target !== null) {
    target.focus();
    return;
  }
  document.getElementById("browse-apps-title")?.focus();
}

function buildIntegrationCatalogItem(
  basePath: string,
  query: string,
  entry: IntegrationEntry,
): IntegrationCatalogItem {
  return {
    kind: integrationCatalogKind(entry.id),
    id: entry.id,
    label: entry.label,
    description: entry.description,
    searchAliases: integrationSearchAliases(entry.id),
    tile: entry.tile,
    status: integrationEntryStatus(entry),
    connectedAccountCount: entry.accounts.filter(isNotRevoked).length,
    href: integrationDetailPath(basePath, entry.id, null, query),
  };
}

function isNotRevoked(account: IntegrationAccount): boolean {
  return account.lifecycle.kind !== "revoked";
}

function integrationSearchAliases(integrationId: string): readonly string[] {
  if (integrationId === "typesafe")
    return [
      "jev",
      "context collections",
      "context discovery",
      "context",
      "typesafe",
      "ai",
      "api key",
    ];
  if (integrationId === "codex") return ["ai", "openai", "chatgpt", "model"];
  if (integrationId === "onepassword")
    return ["1password", "password", "passwords", "vault", "logins", "secrets"];
  if (integrationId === "commerce") {
    return ["commerce", "products", "inventory", "orders"];
  }
  return providerSearchAliases(integrationId);
}

function integrationCatalogKind(
  integrationId: string,
): IntegrationCatalogItem["kind"] {
  return integrationId === "codex" ||
    integrationId === "commerce" ||
    integrationId === "typesafe"
    ? "workspace_setup"
    : "app";
}

function isAppCatalogItem(item: IntegrationCatalogItem): boolean {
  return item.kind === "app";
}

function isWorkspaceSetupCatalogItem(item: IntegrationCatalogItem): boolean {
  return item.kind === "workspace_setup";
}

function compareIntegrationCatalogItems(
  left: IntegrationCatalogItem,
  right: IntegrationCatalogItem,
): number {
  const priority = catalogPriority(left.id) - catalogPriority(right.id);
  return priority === 0 ? left.label.localeCompare(right.label) : priority;
}

function catalogPriority(id: string): number {
  if (id === "google_drive") return 0;
  if (id === "slack") return 1;
  return 2;
}

function buildConnectedAppItems(
  basePath: string,
  query: string,
  entries: readonly IntegrationEntry[],
  accounts: readonly IntegrationAccount[],
  canManage: boolean,
): readonly ConnectedAppItem[] {
  const ordered = [...accounts].sort(compareIntegrationAccountUrgency);
  const items: ConnectedAppItem[] = [];
  for (const account of ordered) {
    // A revoked account is disconnected for good; it is not a connected app.
    if (!isNotRevoked(account)) continue;
    const entry = entries.find(
      matchesIntegrationEntryId.bind(null, account.provider),
    );
    if (entry === undefined) continue;
    items.push(
      buildConnectedAppItem(basePath, query, entry.id, canManage, account),
    );
  }
  return items;
}

export async function loadOnePasswordIntegrationPanel() {
  const module = await import("../vault/onepassword-integration");
  return { default: module.OnePasswordIntegrationPanel };
}

/** A connected 1Password vault is a connected app without a provider account. */
function onePasswordConnectedApp(
  basePath: string,
  query: string,
  onePassword: OnePasswordStatus,
  canManage: boolean,
): readonly ConnectedAppItem[] {
  if (onePassword.state.kind !== "ready") return [];
  const { store } = onePassword.state;
  if (store.kind !== "onepassword") return [];
  return [
    {
      integrationAccountId: "onepassword",
      providerLabel: "1Password",
      displayName: store.vaultTitle,
      tile: "onepassword",
      status: { kind: "success", label: "Connected" },
      actionLabel: canManage ? "Manage" : "View",
      isDefaultForProvider: false,
      searchText: `1Password ${store.vaultTitle} vault`,
      href: integrationDetailPath(basePath, "onepassword", null, query),
    },
  ];
}

function buildConnectedAppItem(
  basePath: string,
  query: string,
  integrationId: string,
  canManage: boolean,
  account: IntegrationAccount,
): ConnectedAppItem {
  return {
    integrationAccountId: account.integrationAccountId,
    providerLabel: providerLabel(account.provider),
    displayName: account.displayName,
    tile: providerTile(account.provider),
    status: integrationOverviewAccountStatus(account.lifecycle),
    actionLabel: integrationOverviewAccountAction(account, canManage),
    isDefaultForProvider: account.isDefaultForProvider,
    searchText: `${providerLabel(account.provider)} ${account.displayName}`,
    href: integrationDetailPath(
      basePath,
      integrationId,
      account.integrationAccountId,
      query,
    ),
  };
}

function integrationOverviewAccountStatus(
  lifecycle: IntegrationAccountLifecycle,
): StatusChipStatus {
  switch (lifecycle.kind) {
    case "active":
      return { kind: "success", label: "Connected" };
    case "connecting":
      return { kind: "info", label: "Connecting" };
    case "pending_activation":
      return { kind: "info", label: "Finish setup" };
    case "reauth_required":
      return { kind: "warning", label: "Reconnect needed" };
    case "degraded":
      return { kind: "warning", label: "Needs attention" };
    case "disabled":
      return { kind: "neutral", label: "Disabled" };
    case "revoked":
      return { kind: "danger", label: "Disconnected" };
    default:
      return assertNever(lifecycle, "Unexpected settings state");
  }
}

function integrationOverviewAccountAction(
  account: IntegrationAccount,
  canManage: boolean,
): string {
  if (!canManage) return "View details";
  switch (account.lifecycle.kind) {
    case "connecting":
    case "pending_activation":
      return "Finish setup";
    case "reauth_required":
      return "Reconnect";
    case "degraded":
      return "Review";
    case "active":
      return (account.provider === "dropbox" ||
        account.provider === "google_drive") &&
        account.selectedResources.length === 0
        ? "Choose files"
        : "Manage";
    case "disabled":
    case "revoked":
      return "Manage";
    default:
      return assertNever(account.lifecycle, "Unexpected settings state");
  }
}

function integrationEntryStatus(
  entry: IntegrationEntry,
): IntegrationRailStatus {
  return entry.status ?? integrationStatus(entry.accounts, entry.connected);
}

export function typesafeConnectionStatus(
  state: TypeSafeConnectionState,
  canManage: boolean,
): IntegrationRailStatus {
  if (!canManage) return { kind: "idle", label: "Admins only" };
  if (state.kind === "loading") return { kind: "idle", label: "Loading" };
  if (state.kind === "failed")
    return { kind: "attention", label: "Unavailable" };
  if (state.configuration.connection.kind === "disconnected")
    return { kind: "idle", label: "Not connected" };
  return state.configuration.credentialConfigured
    ? { kind: "connected", label: "Connected" }
    : { kind: "attention", label: "Needs attention" };
}

export type IntegrationRailStatus = {
  readonly kind: "attention" | "connected" | "idle";
  readonly label: string;
};

function integrationStatus(
  accounts: readonly IntegrationAccount[],
  connected: boolean,
): IntegrationRailStatus {
  if (accounts.some(connectionNeedsAttention))
    return { kind: "attention", label: "Needs attention" };
  if (connected) return { kind: "connected", label: "Connected" };
  return { kind: "idle", label: "Not connected" };
}

function codexIntegrationStatus(
  connection: OrganisationCodexConnection,
): IntegrationRailStatus {
  switch (connection.kind) {
    case "disconnected":
      return { kind: "idle", label: "Not connected" };
    case "authorizing":
      return { kind: "attention", label: "Finish sign-in" };
    case "connected":
      return { kind: "connected", label: "Connected" };
    case "action_required":
      return { kind: "attention", label: "Needs attention" };
    default:
      return assertNever(connection, "Unexpected settings state");
  }
}

export function inferenceIntegrationStatus(
  selection: OrganisationInferenceSelection,
  connection: OrganisationCodexConnection,
  claudeState: ClaudeConnectionState,
): IntegrationRailStatus {
  switch (selection.kind) {
    case "claude_oauth":
      if (claudeState.kind === "loading")
        return { kind: "attention", label: "Check Claude connection" };
      if (claudeState.kind === "failed")
        return { kind: "attention", label: "Connection unavailable" };
      return claudeState.view.connection.kind === "connected"
        ? { kind: "connected", label: "Claude connected" }
        : { kind: "attention", label: "Claude sign-in required" };
    case "codex_subscription":
      return codexIntegrationStatus(connection);
    case "satyr_platform":
      return { kind: "connected", label: "Provided by Seams" };
    case "organisation_openai_api_key":
      return { kind: "connected", label: "OpenAI key" };
    case "organisation_anthropic_api_key":
      return { kind: "connected", label: "Anthropic key" };
    default:
      return assertNever(selection, "Unexpected settings state");
  }
}
