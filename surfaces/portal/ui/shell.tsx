import { AccountAppearanceControl } from "@purin-labs/ui/preferences/appearance-controls";
import { createPortal } from "react-dom";
import React, { useEffect } from "react";
import { voiceControlIsOn } from "@purin-labs/surface-voice/ui/features/voice/setting";
import {
  chatRouteState,
  pageAddress,
  pageNavigation,
} from "@purin-labs/ui/page-address";
import {
  Coffee,
  Croissant,
  LogOut,
  Store,
  type LucideIcon,
} from "lucide-react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { Toaster } from "sonner";

import {
  WORKSPACE_NAVIGATION_GROUPS,
  navigationGroupTitle,
  workspacePageDescriptor,
  workspacePagePath,
  type WorkspaceDetailPage,
  type WorkspaceNavigationGroupName,
  type WorkspaceSystem,
} from "@purin-labs/ui/route";
import { useBrainItemsToReview } from "@purin-labs/area-brain/ui/brain-summary";
import { useRequestsToDecide } from "@purin-labs/area-organisation/ui/features/access/permission-requests-summary";
import type { AccessRouteTransport } from "@purin-labs/control-api/portal/access-models";
import "@purin-labs/area-organisation/ui/features/access/permission-requests-drawer.css";
import "./portal-brand.css";
import "./sidebar-frame.css";
import { workspaceNavigationIcon } from "@purin-labs/ui/page-icons";
import {
  WorkspaceSearchButton,
  WorkspaceSearchDialog,
  useWorkspaceSearch,
} from "./workspace-search";

const VoicePageMark = React.lazy(
  () => import("@purin-labs/surface-voice/ui/features/voice/page-mark"),
);
const PermissionRequestsDrawer = React.lazy(
  () =>
    import("@purin-labs/area-organisation/ui/features/access/permission-requests-drawer"),
);
import { ChatUnderlay, type WorkspaceChat } from "./features/chat/underlay";
import { usePortalTheme } from "@purin-labs/ui/use-portal-theme";
import { useSurfaceOnScreen } from "@purin-labs/ui/features/surface-observation";
import { PageHeader } from "@purin-labs/ui/page-components";
import {
  ConsoleSidebarToggle,
  ConsoleSidebarTooltip,
  useConsoleSidebarController,
  type ConsoleSidebarControl,
  type ConsoleSidebarNavigationGroup,
  type ConsoleSidebarResolvedLink,
  type ConsoleSidebarTab,
} from "@purin-labs/ui/console-sidebar";
import { runLayoutMotion } from "@purin-labs/ui/layout-motion";
import { DashboardNavigation } from "./dashboard-navigation";
import {
  WorkspaceSwitcher,
  type OrganisationChoice,
  type OrganisationShellContext,
  type WorkspaceChoice,
  type WorkspaceShellContext,
} from "@purin-labs/area-organisation/ui/workspace-switcher";

export type { OrganisationChoice, WorkspaceChoice };
import { useConsoleSidebarPreference } from "./use-console-sidebar-preference";
import { assertNever } from "@purin-labs/std";
import { ConsoleToolsProvider } from "@purin-labs/ui/console-tools";
import type { ToolbarItem } from "@purin-labs/ui/overflow-toolbar";
import { HoverLabel } from "@purin-labs/ui/hover-label";
import type { Variant } from "@purin-labs/type-utils";

const DOCS_ORIGIN = (
  import.meta.env.VITE_DOCS_ORIGIN || "http://docs.localhost:3005"
).replace(/\/$/, "");

type PortalFrameIdentity =
  | {
      readonly kind: "ready";
      readonly displayName: string;
      readonly photoUrl?: string;
      readonly usagePercent?: number;
      readonly usageSource?: "Workspace" | "Codex";
      readonly logout: () => Promise<void>;
      /** The workspace's waiting permission requests, in a drawer. */
      readonly permissionRequests?: {
        /** Requests that wait for this person's decision; null for none. */
        readonly count: number | null;
        readonly open: () => void;
      };
    }
  | { readonly kind: "loading" };

type PortalFrameProps =
  | {
      readonly identity: PortalFrameIdentity;
      readonly organisation?: never;
      readonly workspace?: never;
      readonly sidebar?: never;
      readonly chat?: never;
      readonly children: React.ReactNode;
    }
  | {
      readonly identity: PortalFrameIdentity;
      readonly organisation: OrganisationShellContext;
      readonly workspace: WorkspaceShellContext;
      readonly chat?: WorkspaceChat;
      readonly sidebar: {
        readonly activePage: WorkspaceDetailPage | null;
        readonly chatOpen: boolean;
        readonly footer: React.ReactNode;
        /** What waits behind a page, shown on its entry of the navigation. */
        readonly attention?: NavigationAttention;
      };
      readonly children: React.ReactNode;
    };

type NavigationAttention = Partial<
  Record<
    WorkspaceDetailPage,
    NonNullable<ConsoleSidebarNavigationGroup["items"][number]["attention"]>
  >
>;

const NO_ATTENTION: NavigationAttention = {};

export function PortalFrame(props: PortalFrameProps): React.ReactNode {
  const location = useLocation();
  const navigate = useNavigate();
  const preference = useConsoleSidebarPreference();
  const shell = React.useRef<HTMLDivElement>(null);
  const [lastSystem, setLastSystem] =
    React.useState<WorkspaceSystem>("commerce");
  const routeSystem = workspaceSystem(props.sidebar?.activePage ?? null);
  const activeSystem = routeSystem ?? lastSystem;
  usePortalTheme(routeSystem === "kitchen" ? "bakeryos" : "appearance");
  useSurfaceOnScreen();
  useEffect(rememberWorkspaceSystem.bind(null, routeSystem, setLastSystem), [
    routeSystem,
  ]);
  const workspacePath = React.useRef<string | null>(null);
  // With the chat open, the page beside it decides the scroll reset.
  const pagePathname = pageAddress(location).pathname;
  useEffect(
    resetWorkspaceScroll.bind(null, shell, workspacePath, pagePathname),
    [pagePathname],
  );
  // A page link keeps the chat open: the new page opens beside it.
  const openPage = (href: string): void => {
    const target = pageNavigation(
      location,
      props.sidebar?.chatOpen ?? false,
      href,
    );
    navigate(
      target.to,
      target.state === undefined ? {} : { state: target.state },
    );
  };
  const [chatFullscreen, setChatFullscreen] = React.useState(false);
  // Full-screen chat starts with the rail collapsed. Expanding it there does
  // not change the stored sidebar preference.
  const [fullscreenRailExpanded, setFullscreenRailExpanded] =
    React.useState(false);
  useEffect(
    collapseFullscreenRail.bind(
      null,
      setFullscreenRailExpanded,
      chatFullscreen,
    ),
    [chatFullscreen],
  );
  const toggleFullscreenRail = React.useCallback(
    setFullscreenRailExpanded.bind(null, invertRailExpanded),
    [],
  );
  const fullscreenChat = chatFullscreen && props.chat != null;
  const toggleRailWithMotion = React.useCallback(
    () =>
      runLayoutMotion(
        fullscreenChat ? toggleFullscreenRail : preference.toggleRail,
      ),
    [fullscreenChat, toggleFullscreenRail, preference.toggleRail],
  );
  const sidebarController = useConsoleSidebarController({
    sidebarId: "portal-workspace-sidebar",
    railExpanded: fullscreenChat
      ? fullscreenRailExpanded
      : preference.railExpanded,
    onToggleRail: toggleRailWithMotion,
  });
  const search = useWorkspaceSearch(props.workspace !== undefined);
  const workspaceShell = props.sidebar !== undefined;
  const railCollapsed =
    sidebarController.state.mode === "rail" &&
    sidebarController.state.visibility === "collapsed";
  // A page that the search opens closes the drawer, as a page link does.
  const openPageFromSearch = (href: string): void => {
    openPage(href);
    sidebarController.onNavigate();
  };
  const navigationGroups =
    props.sidebar !== undefined && props.workspace !== undefined
      ? buildConsoleNavigationGroups({
          activePage: props.sidebar.activePage,
          organisationHandle: props.workspace.organisationHandle,
          workspaceHandle: props.workspace.workspaceHandle,
          system: activeSystem,
          attention: props.sidebar.attention ?? NO_ATTENTION,
          selectSystem: selectWorkspaceSystem.bind(
            null,
            setLastSystem,
            openPage,
            props.workspace,
          ),
        })
      : [];
  const askControl =
    props.workspace === undefined || props.sidebar === undefined ? null : (
      <Link
        className="portal-chat-link"
        aria-label="Ask"
        to={workspacePagePath(
          props.workspace.organisationHandle,
          props.workspace.workspaceHandle,
          "chat",
        )}
        state={chatRouteState(location.pathname, location.search)}
        aria-current={props.sidebar.chatOpen ? "page" : undefined}
        aria-expanded={props.sidebar.chatOpen}
        aria-controls="workspace-chat"
        onClick={
          props.chat
            ? closeChatFromTrigger.bind(null, props.chat.close)
            : undefined
        }
      >
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
        >
          <path
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.563 2.813h-5.25a2.25 2.25 0 0 0-2.25 2.25v6.375a2.25 2.25 0 0 0 2.25 2.25h2.176a.75.75 0 0 1 .482.175l1.548 1.298a.75.75 0 0 0 .96.003l1.575-1.304a.75.75 0 0 1 .478-.172h2.156a2.25 2.25 0 0 0 2.25-2.25v-2.25"
          />
          <path
            fill="currentColor"
            d="m15.18 3.139-.522-1.359a.437.437 0 0 0-.816 0l-.522 1.359a.75.75 0 0 1-.431.43l-1.359.523a.437.437 0 0 0 0 .816l1.359.522a.75.75 0 0 1 .43.431l.523 1.359a.437.437 0 0 0 .816 0l.522-1.359a.75.75 0 0 1 .431-.43l1.359-.523a.437.437 0 0 0 0-.816l-1.359-.522a.75.75 0 0 1-.43-.431"
          />
        </svg>
        <span>Ask</span>
      </Link>
    );
  const identityControl = (
    <PortalIdentity identity={props.identity} placement="topbar" />
  );
  const [dockCount, setDockCount] = React.useState(0);
  const dockConsoleTools = React.useCallback(
    dockConsole.bind(null, setDockCount),
    [],
  );
  // A canvas page (the board editor) draws its own menu and the console
  // tools, so the shell draws neither the rail nor the top bar. Full-screen
  // chat keeps the rail, because the chat stands beside it.
  const [canvasCount, setCanvasCount] = React.useState(0);
  const canvasConsoleTools = React.useCallback(
    dockConsole.bind(null, setCanvasCount),
    [],
  );
  const canvasPage = workspaceShell && canvasCount > 0 && !fullscreenChat;
  const consoleDocked = workspaceShell && (dockCount > 0 || canvasPage);
  const homePath =
    props.workspace === undefined
      ? null
      : workspacePagePath(
          props.workspace.organisationHandle,
          props.workspace.workspaceHandle,
          "overview",
        );
  const consoleTools = {
    dockItems:
      askControl === null ? [] : [{ key: "ask", node: askControl, pinned: true }],
    canvasItems: consoleToolItems(
      props.workspace === undefined ? null : (
        <WorkspaceSearchButton variant="toolbar" onClick={search.openSearch} />
      ),
      askControl,
      identityControl,
    ),
    dock: dockConsoleTools,
    canvas: canvasConsoleTools,
    home:
      homePath === null
        ? null
        : { href: homePath, open: openPage.bind(null, homePath) },
    search: props.workspace === undefined ? null : search.openSearch,
  };
  const frame = (
    <div
      ref={shell}
      className={portalShellClassName(workspaceShell)}
      data-sidebar-mode={
        workspaceShell ? sidebarController.state.mode : undefined
      }
      data-sidebar-state={
        workspaceShell ? sidebarController.state.visibility : undefined
      }
      data-console-docked={consoleDocked ? "" : undefined}
      data-canvas-page={canvasPage ? "" : undefined}
    >
      <a className="skip-link" href="#portal-content">
        Skip to content
      </a>
      {!workspaceShell ? (
        <>
          <nav className="portal-nav" aria-label="Global">
            <div className="portal-nav-lead">
              <PortalBrand className="portal-logo portal-logo-topbar" />
            </div>
            <span className="portal-command-spacer" />
            <div className="portal-nav-actions">
              <HoverLabel label="Appearance">
                <AccountAppearanceControl />
              </HoverLabel>
              {identityControl}
            </div>
          </nav>
          <main className="portal-main" id="portal-content" tabIndex={-1}>
            <div className="portal-main-inner">{props.children}</div>
          </main>
        </>
      ) : (
        <>
          <DashboardNavigation
            topbar={
              consoleDocked
                ? null
                : {
                    brand: (
                      <PortalBrand className="portal-logo portal-logo-topbar" />
                    ),
                    actions: askControl,
                    sidebarControl: sidebarController.control,
                    attention: waitingRequestsText(props.identity) ?? undefined,
                  }
            }
            sidebar={{
              id: sidebarController.control.sidebarId,
              label: "Workspace pages",
              state: sidebarController.state,
              groups: navigationGroups,
              resolveLink: resolveConsoleSidebarLink.bind(null, openPage),
              onNavigate: sidebarController.onNavigate,
              header: (
                <PortalSidebarHeader
                  organisation={props.organisation}
                  workspace={props.workspace}
                  collapsed={railCollapsed}
                  control={sidebarController.control}
                  openSearch={search.openSearch}
                />
              ),
              footer: props.sidebar.footer,
              foot: (
                <PortalSidebarFoot
                  identity={props.identity}
                  collapsed={railCollapsed}
                />
              ),
            }}
          />
          <main
            className="portal-main"
            id="portal-content"
            data-page={props.sidebar.activePage}
            tabIndex={-1}
          >
            <div className="portal-main-inner">{props.children}</div>
          </main>
        </>
      )}
      {search.open && props.workspace !== undefined ? (
        <WorkspaceSearchDialog
          organisationHandle={props.workspace.organisationHandle}
          workspaceHandle={props.workspace.workspaceHandle}
          close={search.close}
          openPage={openPageFromSearch}
        />
      ) : null}
      {createPortal(
        <Toaster
          position="bottom-right"
          offset={16}
          mobileOffset={16}
          gap={10}
          toastOptions={{
            style: {
              borderRadius: "14px",
              border: "0",
              boxShadow: "var(--shadow-card)",
              background: "var(--paper)",
              color: "var(--ink)",
              fontFamily: "inherit",
            },
          }}
        />,
        document.body,
      )}
    </div>
  );
  const framed = (
    <ConsoleToolsProvider value={consoleTools}>{frame}</ConsoleToolsProvider>
  );
  return workspaceShell ? (
    <ChatUnderlay
      chat={props.chat ?? null}
      fullscreen={chatFullscreen}
      setFullscreen={setChatFullscreen}
      navigation={sidebarController.state.mode === "rail"}
    >
      {framed}
    </ChatUnderlay>
  ) : (
    framed
  );
}

/** A page docks the console tools; the result undocks them. */
function dockConsole(
  setDockCount: React.Dispatch<React.SetStateAction<number>>,
): () => void {
  setDockCount(addOne);
  return setDockCount.bind(null, takeOne);
}

function addOne(count: number): number {
  return count + 1;
}

function takeOne(count: number): number {
  return count - 1;
}

/**
 * The console tools of a canvas page, which has no rail, in the order that
 * they collapse: search first, the account never.
 */
function consoleToolItems(
  search: React.ReactNode | null,
  ask: React.ReactNode | null,
  identity: React.ReactNode,
): readonly ToolbarItem[] {
  return [
    ...(search === null
      ? []
      : [{ key: "search", node: search, label: "Search workspace" }]),
    {
      key: "appearance",
      node: <AccountAppearanceControl />,
      label: "Appearance",
    },
    ...(ask === null ? [] : [{ key: "ask", node: ask }]),
    { key: "account", node: identity, pinned: true },
  ];
}

export function WorkspaceLayout(props: {
  readonly organisationId: string;
  readonly loadCodexUsage: (organisationId: string) => Promise<number | null>;
  readonly usagePercent?: number;
  readonly displayName: string;
  readonly logout: () => Promise<void>;
  readonly organisation: {
    readonly organisationHandle: string;
    readonly name: string;
    readonly choices: readonly OrganisationChoice[];
  };
  readonly workspace: {
    readonly workspaceHandle: string;
    readonly name: string;
    readonly choices: readonly WorkspaceChoice[];
  };
  readonly activePage: WorkspaceDetailPage;
  readonly chatOpen: boolean;
  readonly chat: WorkspaceChat;
  readonly sidebarFooter: React.ReactNode;
  readonly title: string;
  readonly hideHeader?: boolean;
  readonly description: string | null;
  readonly status: React.ReactNode;
  readonly access: Pick<AccessRouteTransport, "read" | "mutate">;
}): React.ReactNode {
  const [requestsOpen, setRequestsOpen] = React.useState(false);
  const [codexUsage, setCodexUsage] = React.useState<{
    readonly organisationId: string;
    readonly percent: number | null;
  } | null>(null);
  React.useEffect(
    watchCodexUsage.bind(
      null,
      props.organisationId,
      props.loadCodexUsage,
      setCodexUsage,
    ),
    [props.organisationId, props.loadCodexUsage],
  );
  const fallback =
    codexUsage?.organisationId === props.organisationId
      ? codexUsage.percent
      : null;
  const usagePercent = props.usagePercent ?? fallback ?? undefined;
  const brainToReview = useBrainItemsToReview(props.organisationId);
  const requestsToDecide = useRequestsToDecide(props.organisationId);
  const attention = React.useMemo<NavigationAttention>(() => {
    const next: NavigationAttention = {};
    if (brainToReview !== null && brainToReview > 0)
      next.knowledge = {
        count: brainToReview,
        label: `${brainToReview} to review`,
      };
    if (requestsToDecide !== null)
      next.access = {
        count: requestsToDecide,
        label: `${requestsToDecide} permission ${requestsToDecide === 1 ? "request" : "requests"} waiting`,
      };
    return next.knowledge === undefined && next.access === undefined
      ? NO_ATTENTION
      : next;
  }, [brainToReview, requestsToDecide]);
  return (
    <PortalFrame
      chat={props.chat}
      identity={{
        kind: "ready",
        displayName: props.displayName,
        usagePercent,
        usageSource: props.usagePercent === undefined ? "Codex" : "Workspace",
        logout: props.logout,
        permissionRequests: {
          count: requestsToDecide,
          open: setRequestsOpen.bind(null, true),
        },
      }}
      organisation={props.organisation}
      workspace={{
        organisationHandle: props.organisation.organisationHandle,
        workspaceHandle: props.workspace.workspaceHandle,
        name: props.workspace.name,
        choices: props.workspace.choices,
      }}
      sidebar={{
        activePage: props.activePage,
        chatOpen: props.chatOpen,
        footer: props.sidebarFooter,
        attention,
      }}
    >
      {props.activePage === "agents" || props.hideHeader ? null : (
        <PageHeader title={props.title} description={props.description} />
      )}
      {props.status}
      <Outlet />
      {props.chatOpen || voiceControlIsOn(props.organisationId) ? (
        <React.Suspense fallback={null}>
          <VoicePageMark
            organisationId={props.organisationId}
            organisationHandle={props.organisation.organisationHandle}
            workspaceHandle={props.workspace.workspaceHandle}
            chatOpen={props.chatOpen}
          />
        </React.Suspense>
      ) : null}
      {requestsOpen ? (
        <React.Suspense fallback={null}>
          <PermissionRequestsDrawer
            organisationId={props.organisationId}
            workspaceName={props.organisation.name}
            access={props.access}
            onClose={setRequestsOpen.bind(null, false)}
          />
        </React.Suspense>
      ) : null}
    </PortalFrame>
  );
}

type UsageSubscription = {
  active: boolean;
  readonly organisationId: string;
  readonly load: (organisationId: string) => Promise<number | null>;
  readonly update: (usage: {
    readonly organisationId: string;
    readonly percent: number | null;
  }) => void;
};

async function refreshCodexUsage(
  subscription: UsageSubscription,
): Promise<void> {
  let percent: number | null = null;
  try {
    percent = await subscription.load(subscription.organisationId);
  } catch {
    // Usage is supplementary; unavailable accounts must not block navigation.
  }
  if (subscription.active)
    subscription.update({
      organisationId: subscription.organisationId,
      percent,
    });
}

function stopUsageSubscription(
  subscription: UsageSubscription,
  timer: number,
): void {
  subscription.active = false;
  window.clearInterval(timer);
}

function watchCodexUsage(
  organisationId: string,
  load: UsageSubscription["load"],
  update: UsageSubscription["update"],
): () => void {
  const subscription = { active: true, organisationId, load, update };
  void refreshCodexUsage(subscription);
  const timer = window.setInterval(
    refreshCodexUsage.bind(null, subscription),
    60_000,
  );
  return stopUsageSubscription.bind(null, subscription, timer);
}

/**
 * The account menu. In the top bar its trigger is the avatar; at the foot of
 * the sidebar the name follows the avatar, and the menu opens upward.
 */
function PortalIdentity(props: {
  readonly identity: PortalFrameIdentity;
  readonly placement: "topbar" | "sidebar";
}): React.ReactNode {
  const menuRef = React.useRef<HTMLDetailsElement>(null);
  useEffect(bindIdentityMenuDismissal.bind(null, menuRef), []);
  switch (props.identity.kind) {
    case "loading":
      return (
        <span className="portal-identity-placeholder" aria-hidden="true" />
      );
    case "ready": {
      const usage = usageText(props.identity);
      return (
        <div className="identity-menu-anchor">
          <details
            ref={menuRef}
            className="identity-menu"
            onKeyDown={closeDetailsOnEscape}
          >
            <summary
              className="identity-usage-trigger"
              aria-label={`Account: ${props.identity.displayName}. ${waitingRequestsLabel(props.identity)}${usage}`}
              title={usage}
            >
              <span className="identity-usage-avatar">
                <svg
                  className="identity-usage-ring"
                  viewBox="0 0 40 40"
                  aria-hidden="true"
                >
                  <circle
                    className="identity-usage-track"
                    cx="20"
                    cy="20"
                    r="17"
                  />
                  {props.identity.usagePercent === undefined ? null : (
                    <circle
                      className="identity-usage-progress"
                      cx="20"
                      cy="20"
                      r="17"
                      pathLength="100"
                      strokeDasharray={`${props.identity.usagePercent} 100`}
                    />
                  )}
                </svg>
                <span className="identity-usage-photo" aria-hidden="true">
                  {props.identity.photoUrl ? (
                    <img
                      src={props.identity.photoUrl}
                      alt=""
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    identityInitial(props.identity.displayName)
                  )}
                </span>
                <span className="identity-usage-value" aria-hidden="true">
                  {props.identity.usagePercent === undefined
                    ? "—"
                    : `${props.identity.usagePercent}%`}
                </span>
                {waitingRequests(props.identity) === null ? null : (
                  <span
                    className="identity-usage-attention"
                    aria-hidden="true"
                  />
                )}
              </span>
              {props.placement === "sidebar" ? (
                <span className="identity-usage-name" aria-hidden="true">
                  {props.identity.displayName}
                </span>
              ) : null}
            </summary>
            <div className="identity-menu-popover">
              <div className="identity-menu-profile">
                <span className="identity-menu-avatar" aria-hidden="true">
                  {identityInitial(props.identity.displayName)}
                </span>
                <span className="identity-menu-profile-copy">
                  <small>Signed in as</small>
                  <strong>{props.identity.displayName}</strong>
                </span>
              </div>
              <div className="identity-menu-divider" aria-hidden="true" />
              {props.identity.permissionRequests === undefined ? null : (
                <button
                  className="identity-menu-action"
                  type="button"
                  onClick={openFromMenu.bind(
                    null,
                    props.identity.permissionRequests.open,
                  )}
                >
                  <span>Permission requests</span>
                  {props.identity.permissionRequests.count === null ? (
                    <span aria-hidden="true">→</span>
                  ) : (
                    <span className="identity-menu-count">
                      {props.identity.permissionRequests.count}
                      <span className="visually-hidden"> waiting</span>
                    </span>
                  )}
                </button>
              )}
              <Link
                className="identity-menu-action"
                to="/portal"
                onClick={closeContainingDetails}
              >
                <span>Switch organisation</span>
                <span aria-hidden="true">→</span>
              </Link>
              <a
                className="identity-menu-action"
                href={DOCS_ORIGIN}
                target="_blank"
                rel="noreferrer"
                onClick={closeContainingDetails}
              >
                <span>Docs and resources</span>
                <span aria-hidden="true">↗</span>
              </a>
              <button
                className="identity-menu-signout"
                type="button"
                onClick={props.identity.logout}
              >
                <LogOut size={16} aria-hidden="true" />
                Sign out
              </button>
            </div>
          </details>
        </div>
      );
    }
    default:
      return assertNever(props.identity, "Unexpected value");
  }
}

function usageText(identity: Variant<PortalFrameIdentity, "ready">): string {
  return identity.usagePercent === undefined
    ? "Usage unavailable"
    : `${identity.usageSource ?? "Workspace"} usage: ${identity.usagePercent}% used`;
}

function waitingRequests(
  identity: Variant<PortalFrameIdentity, "ready">,
): number | null {
  return identity.permissionRequests?.count ?? null;
}

function waitingRequestsLabel(
  identity: Variant<PortalFrameIdentity, "ready">,
): string {
  const count = waitingRequests(identity);
  return count === null
    ? ""
    : `${count} permission ${count === 1 ? "request waits" : "requests wait"}. `;
}

/** What the closed drawer's toggle says waits inside: the account's requests. */
function waitingRequestsText(identity: PortalFrameIdentity): string | null {
  if (identity.kind !== "ready") return null;
  const count = waitingRequests(identity);
  return count === null
    ? null
    : `${count} permission ${count === 1 ? "request" : "requests"} waiting`;
}

function identityInitial(displayName: string): string {
  const initial = Array.from(displayName.trim())[0];
  return initial === undefined ? "P" : initial.toLocaleUpperCase();
}

function bindIdentityMenuDismissal(
  menuRef: React.RefObject<HTMLDetailsElement | null>,
): () => void {
  const listener = closeIdentityMenuOnOutsidePointerDown.bind(null, menuRef);
  document.addEventListener("pointerdown", listener);
  return removeIdentityMenuDismissal.bind(null, listener);
}

function removeIdentityMenuDismissal(
  listener: (event: PointerEvent) => void,
): void {
  document.removeEventListener("pointerdown", listener);
}

function closeIdentityMenuOnOutsidePointerDown(
  menuRef: React.RefObject<HTMLDetailsElement | null>,
  event: PointerEvent,
): void {
  const menu = menuRef.current;
  const target = event.target;
  if (
    menu === null ||
    !menu.open ||
    !(target instanceof Node) ||
    menu.contains(target)
  ) {
    return;
  }
  menu.open = false;
}

function PortalSidebarHeader(props: {
  readonly organisation: OrganisationShellContext;
  readonly workspace: WorkspaceShellContext;
  readonly collapsed: boolean;
  readonly control: ConsoleSidebarControl;
  readonly openSearch: () => void;
}): React.ReactNode {
  return (
    <div className="console-sidebar-head">
      <div
        className={
          props.collapsed
            ? "portal-sidebar-brand-row portal-sidebar-brand-toggle"
            : "portal-sidebar-brand-row"
        }
      >
        {/* One brand element in both states, so the wordmark can collapse
            smoothly; the rail toggle covers it while collapsed. */}
        <PortalBrand className="portal-sidebar-brand" inert={props.collapsed} />
        <ConsoleSidebarTooltip label="Expand sidebar" enabled={props.collapsed}>
          <span className="portal-desktop-sidebar-toggle">
            <ConsoleSidebarToggle {...props.control} placement="rail" />
          </span>
        </ConsoleSidebarTooltip>
      </div>
      <WorkspaceSwitcher
        organisation={props.organisation}
        workspace={props.workspace}
        collapsed={props.collapsed}
      />
      <ConsoleSidebarTooltip label="Search" enabled={props.collapsed}>
        <WorkspaceSearchButton variant="sidebar" onClick={props.openSearch} />
      </ConsoleSidebarTooltip>
    </div>
  );
}

/**
 * The foot of the sidebar: the account and the appearance. It stays in view
 * while the pages scroll.
 */
function PortalSidebarFoot(props: {
  readonly identity: PortalFrameIdentity;
  readonly collapsed: boolean;
}): React.ReactNode {
  return (
    <>
      <PortalIdentity identity={props.identity} placement="sidebar" />
      <ConsoleSidebarTooltip label="Appearance" enabled={true}>
        <span className="console-sidebar-appearance">
          <AccountAppearanceControl side={props.collapsed ? "right" : "top"} />
        </span>
      </ConsoleSidebarTooltip>
    </>
  );
}

function PortalBrand(props: {
  readonly className: string;
  readonly inert?: boolean;
}): React.ReactNode {
  return (
    <Link
      to="/portal"
      className={props.className}
      aria-label="Purin Pantry organisations"
      inert={props.inert}
    >
      <img
        className="portal-brand-mark"
        src="/brand/pantry-mark-dark-32.png"
        alt=""
      />
      <span className="portal-brand-copy">
        Purin Pantry
      </span>
    </Link>
  );
}

const WORKSPACE_SYSTEMS: Readonly<
  Record<
    WorkspaceSystem,
    {
      readonly name: WorkspaceSystem;
      readonly label: string;
      readonly page: WorkspaceDetailPage;
      readonly icon: LucideIcon;
    }
  >
> = {
  commerce: {
    name: "commerce",
    label: navigationGroupTitle("commerce"),
    page: "orders",
    icon: Store,
  },
  // Café opens on Home: its first page, Menus, is a full-screen canvas.
  cafe: {
    name: "cafe",
    label: navigationGroupTitle("cafe"),
    page: "overview",
    icon: Coffee,
  },
  kitchen: {
    name: "kitchen",
    label: navigationGroupTitle("kitchen"),
    page: "workflow-simulator",
    icon: Croissant,
  },
};

/** A product tab opens the product's first page, as the old menu did. */
function selectWorkspaceSystem(
  setLastSystem: React.Dispatch<React.SetStateAction<WorkspaceSystem>>,
  openPage: (href: string) => void,
  workspace: WorkspaceShellContext,
  system: WorkspaceSystem,
): void {
  setLastSystem(system);
  openPage(
    workspacePagePath(
      workspace.organisationHandle,
      workspace.workspaceHandle,
      WORKSPACE_SYSTEMS[system].page,
    ),
  );
}

function workspaceSystem(
  page: WorkspaceDetailPage | null,
): WorkspaceSystem | null {
  if (page === null) return null;
  const group = workspacePageDescriptor(page).group;
  switch (group) {
    case "commerce":
    case "cafe":
    case "kitchen":
      return group;
    case "Workspace":
    case "Agents":
    case "Settings":
      return null;
    default:
      return assertNever(group, "Unexpected value");
  }
}

function rememberWorkspaceSystem(
  system: WorkspaceSystem | null,
  setSystem: React.Dispatch<React.SetStateAction<WorkspaceSystem>>,
): void {
  if (system !== null) setSystem(system);
}

function collapseFullscreenRail(
  setRailExpanded: React.Dispatch<React.SetStateAction<boolean>>,
  chatFullscreen: boolean,
): void {
  if (!chatFullscreen) setRailExpanded(false);
}

function invertRailExpanded(railExpanded: boolean): boolean {
  return !railExpanded;
}

function resetWorkspaceScroll(
  shell: React.RefObject<HTMLDivElement | null>,
  workspacePath: React.RefObject<string | null>,
  pathname: string,
): void {
  if (workspacePath.current === pathname) return;
  workspacePath.current = pathname;
  const main = shell.current?.querySelector<HTMLElement>(".portal-main");
  if (main) main.scrollTop = 0;
}

type NavigationGroupsInput = {
  readonly activePage: WorkspaceDetailPage | null;
  readonly organisationHandle: string;
  readonly workspaceHandle: string;
  readonly system: WorkspaceSystem;
  readonly attention: NavigationAttention;
  readonly selectSystem: (system: WorkspaceSystem) => void;
};

/**
 * Three groups: the workspace pages (Home, Inbox, Agents, Knowledge) with no
 * title; the pages of one product under the product tabs; Settings.
 */
function buildConsoleNavigationGroups(
  input: NavigationGroupsInput,
): readonly ConsoleSidebarNavigationGroup[] {
  const items = navigationItems.bind(null, input);
  return [
    {
      id: "workspace",
      label: navigationGroupTitle("Workspace"),
      heading: { kind: "none" },
      items: [...items("Workspace"), ...items("Agents")],
    },
    {
      id: "products",
      label: "Products",
      heading: {
        kind: "tabs",
        tabs: Object.values(WORKSPACE_SYSTEMS).map(
          buildSystemTab.bind(null, input),
        ),
      },
      items: items(input.system),
    },
    {
      id: "settings",
      label: navigationGroupTitle("Settings"),
      heading: { kind: "label" },
      items: items("Settings"),
    },
  ];
}

function navigationItems(
  input: NavigationGroupsInput,
  name: WorkspaceNavigationGroupName,
): ConsoleSidebarNavigationGroup["items"] {
  const group = WORKSPACE_NAVIGATION_GROUPS.find(
    (candidate) => candidate.label === name,
  );
  return (group?.pages ?? []).map(
    buildConsoleNavigationItem.bind(
      null,
      input.activePage,
      input.organisationHandle,
      input.workspaceHandle,
      input.attention,
    ),
  );
}

function buildSystemTab(
  input: NavigationGroupsInput,
  system: (typeof WORKSPACE_SYSTEMS)[WorkspaceSystem],
): ConsoleSidebarTab {
  return {
    id: system.name,
    label: system.label,
    icon: system.icon,
    selected: input.system === system.name,
    onSelect: input.selectSystem.bind(null, system.name),
  };
}

function buildConsoleNavigationItem(
  activePage: WorkspaceDetailPage | null,
  organisationHandle: string,
  workspaceHandle: string,
  attention: NavigationAttention,
  page: WorkspaceDetailPage,
): ConsoleSidebarNavigationGroup["items"][number] {
  const descriptor = workspacePageDescriptor(page);
  return {
    id: page,
    label: descriptor.navigationLabel,
    to: workspacePagePath(organisationHandle, workspaceHandle, page),
    icon: workspaceNavigationIcon(page),
    status: activePage === page ? "active" : "available",
    attention: attention[page],
  };
}

function resolveConsoleSidebarLink(
  openPage: (href: string) => void,
  to: string,
): ConsoleSidebarResolvedLink {
  return {
    href: to,
    onClick: navigateConsoleSidebarLink.bind(null, openPage, to),
  };
}

function navigateConsoleSidebarLink(
  openPage: (href: string) => void,
  to: string,
  event: React.MouseEvent<HTMLAnchorElement>,
): void {
  if (
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0
  )
    return;
  event.preventDefault();
  openPage(to);
}

function portalShellClassName(workspaceShell: boolean): string {
  if (!workspaceShell) return "portal-shell";
  return "portal-shell portal-shell-workspace";
}

export function useRoutePageFocus(pathname: string, enabled: boolean): void {
  const focusedPath = React.useRef<string | null>(null);
  useEffect(
    schedulePortalFocusWhenEnabled.bind(null, enabled, pathname, focusedPath),
    [pathname, enabled],
  );
}

function schedulePortalFocusWhenEnabled(
  enabled: boolean,
  pathname: string,
  focusedPath: React.RefObject<string | null>,
): () => void {
  if (!enabled || focusedPath.current === pathname) return ignoreFocusCleanup;
  focusedPath.current = pathname;
  return schedulePortalFocus();
}

function ignoreFocusCleanup(): void {}

export function focusPortalPage(): void {
  const main = document.getElementById("portal-content");
  const heading = main?.querySelector<HTMLElement>("h1");
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  (heading ?? main)?.focus({ preventScroll: true });
}

function schedulePortalFocus(): () => void {
  const observer = new MutationObserver(focusPortalHeadingAfterMutation);
  observer.observe(document.body, { childList: true, subtree: true });
  const frame = window.requestAnimationFrame(focusPortalPage);
  return cancelScheduledPortalFocus.bind(null, frame, observer);
}

function focusPortalHeadingAfterMutation(
  _records: readonly MutationRecord[],
  observer: MutationObserver,
): void {
  const main = document.getElementById("portal-content");
  const heading = main?.querySelector<HTMLElement>("h1") ?? null;
  const active = document.activeElement;
  if (heading === null) return;
  if (active === heading) {
    observer.disconnect();
    return;
  }
  if (active !== document.body && active !== main) return;
  observer.disconnect();
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  heading.focus({ preventScroll: true });
}

function cancelScheduledPortalFocus(
  frame: number,
  observer: MutationObserver,
): void {
  window.cancelAnimationFrame(frame);
  observer.disconnect();
}

function closeDetailsOnEscape(
  event: React.KeyboardEvent<HTMLDetailsElement>,
): void {
  if (event.key !== "Escape" || !event.currentTarget.open) return;
  event.preventDefault();
  const summary = event.currentTarget.querySelector<HTMLElement>("summary");
  event.currentTarget.open = false;
  summary?.focus();
}

/** Close the account menu, then open what its entry names. */
function openFromMenu(
  open: () => void,
  event: React.MouseEvent<HTMLButtonElement>,
): void {
  const disclosure = event.currentTarget.closest<HTMLDetailsElement>("details");
  if (disclosure !== null) disclosure.open = false;
  open();
}

function closeContainingDetails(
  event: React.MouseEvent<HTMLAnchorElement>,
): void {
  const disclosure = event.currentTarget.closest<HTMLDetailsElement>("details");
  if (disclosure !== null) disclosure.open = false;
}

function closeChatFromTrigger(
  close: () => void,
  event: React.MouseEvent<HTMLAnchorElement>,
): void {
  event.preventDefault();
  close();
}
