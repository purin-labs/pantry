import { AccountAppearanceControl } from "./preferences/appearance-controls";
import { createPortal } from "react-dom";
import React, { useEffect } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { GlideHighlight } from "./ui/glide-highlight";
import { voiceControlIsOn } from "./features/voice/setting";
import { chatRouteState, pageAddress, pageNavigation } from "./page-address";
import {
  Activity,
  BookOpen,
  CakeSlice,
  Calculator,
  ConciergeBell,
  Bot,
  Brain,
  Check,
  ChevronDown,
  Coffee,
  Croissant,
  CreditCard,
  Cpu,
  Factory,
  Landmark,
  FlaskConical,
  House,
  KeyRound,
  KeySquare,
  LayoutDashboard,
  LogOut,
  Mail,
  Package,
  Plug,
  Settings,
  ShoppingCart,
  Sparkles,
  Store,
  Truck,
  Vault,
  Warehouse,
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
  type WorkspaceNavigationGroup,
  type WorkspaceSystem,
} from "./route";
import { useBrainItemsToReview } from "./brain-summary";
import { useRequestsToDecide } from "./features/access/permission-requests-summary";
import type { AccessRouteTransport } from "@purin-labs/control-api/portal/access-models";
import "./features/access/permission-requests-drawer.css";
import "./portal-brand.css";

const VoicePageMark = React.lazy(() => import("./features/voice/page-mark"));
const PermissionRequestsDrawer = React.lazy(
  () => import("./features/access/permission-requests-drawer"),
);
import { ChatUnderlay, type WorkspaceChat } from "./features/chat/underlay";
import { usePortalTheme } from "./use-portal-theme";
import { useSurfaceOnScreen } from "./features/surface-observation";
import { PageHeader } from "./page-components";
import {
  ConsoleSidebarToggle,
  ConsoleSidebarTooltip,
  useConsoleSidebarController,
  type ConsoleSidebarControl,
  type ConsoleSidebarNavigationGroup,
  type ConsoleSidebarResolvedLink,
} from "./console-sidebar";
import { runLayoutMotion } from "./layout-motion";
import { DashboardNavigation } from "./dashboard-navigation";
import {
  WorkspaceSwitcher,
  type OrganisationChoice,
  type OrganisationShellContext,
  type WorkspaceChoice,
  type WorkspaceShellContext,
} from "./workspace-switcher";

export type { OrganisationChoice, WorkspaceChoice };
import { useConsoleSidebarPreference } from "./use-console-sidebar-preference";
import { assertNever } from "@purin-labs/std";
import { ConsoleToolsProvider } from "./console-tools";
import type { ToolbarItem } from "./ui/overflow-toolbar";
import { HoverLabel } from "./ui/hover-label";
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

type WorkspaceCommand = {
  readonly page: WorkspaceDetailPage;
  readonly label: string;
  readonly group: string;
  readonly searchText: string;
};

const WORKSPACE_COMMANDS = WORKSPACE_NAVIGATION_GROUPS.flatMap(
  buildWorkspaceCommands,
);

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
  const [commandPaletteOpen, setCommandPaletteOpen] = React.useState(false);
  const commandTrigger = React.useRef<HTMLButtonElement>(null);
  useEffect(
    bindCommandPaletteShortcut.bind(
      null,
      props.workspace !== undefined,
      setCommandPaletteOpen,
    ),
    [props.workspace !== undefined],
  );
  const workspaceShell = props.sidebar !== undefined;
  const railCollapsed =
    sidebarController.state.mode === "rail" &&
    sidebarController.state.visibility === "collapsed";
  const closeCommands = closeCommandPalette.bind(
    null,
    setCommandPaletteOpen,
    commandTrigger,
  );
  const navigationGroups =
    props.sidebar !== undefined && props.workspace !== undefined
      ? buildConsoleNavigationGroups(
          props.sidebar.activePage,
          props.workspace.organisationHandle,
          props.workspace.workspaceHandle,
          activeSystem,
          props.sidebar.attention ?? NO_ATTENTION,
        )
      : [];
  const searchControl =
    props.workspace === undefined ? (
      <span className="portal-command-spacer" />
    ) : (
      <button
        className="portal-command-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-label="Search workspace"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={openCommandPalette.bind(null, setCommandPaletteOpen)}
        ref={commandTrigger}
      >
        <CommandSearchIcon />
        <span className="portal-command-label">Search workspace</span>
        <kbd>⌘ K</kbd>
      </button>
    );
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
  const identityControl = <PortalIdentity identity={props.identity} />;
  const topbarActions = (
    <>
      <HoverLabel label="Appearance">
        <AccountAppearanceControl />
      </HoverLabel>
      {askControl}
      {identityControl}
    </>
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
    items: consoleToolItems(
      props.workspace === undefined ? null : searchControl,
      askControl,
      identityControl,
    ),
    dock: dockConsoleTools,
    canvas: canvasConsoleTools,
    home:
      homePath === null
        ? null
        : { href: homePath, open: openPage.bind(null, homePath) },
    search:
      props.workspace === undefined
        ? null
        : openCommandPalette.bind(null, setCommandPaletteOpen),
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
            {searchControl}
            <div className="portal-nav-actions">{topbarActions}</div>
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
                    search: searchControl,
                    actions: topbarActions,
                    sidebarControl: sidebarController.control,
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
                  activeSystem={activeSystem}
                  collapsed={railCollapsed}
                  control={sidebarController.control}
                  onNavigate={sidebarController.onNavigate}
                  onSelectSystem={setLastSystem}
                />
              ),
              footer: props.sidebar.footer,
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
      {commandPaletteOpen && props.workspace !== undefined ? (
        <WorkspaceCommandPalette
          organisationHandle={props.workspace.organisationHandle}
          workspaceHandle={props.workspace.workspaceHandle}
          close={closeCommands}
          openPage={openPage}
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
 * The console tools in the order that they collapse: search first, the
 * account never.
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
  readonly description: string;
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

function PortalIdentity(props: {
  readonly identity: PortalFrameIdentity;
}): React.ReactNode {
  const menuRef = React.useRef<HTMLDetailsElement>(null);
  useEffect(bindIdentityMenuDismissal.bind(null, menuRef), []);
  switch (props.identity.kind) {
    case "loading":
      return (
        <span className="portal-identity-placeholder" aria-hidden="true" />
      );
    case "ready":
      return (
        <div>
          <details
            ref={menuRef}
            className="identity-menu"
            onKeyDown={closeDetailsOnEscape}
          >
            <summary
              className="identity-usage-trigger"
              aria-label={`Account: ${props.identity.displayName}. ${waitingRequestsLabel(props.identity)}${props.identity.usagePercent === undefined ? "Usage unavailable" : `${props.identity.usageSource ?? "Workspace"} usage: ${props.identity.usagePercent}% used`}`}
              title={
                props.identity.usagePercent === undefined
                  ? "Usage unavailable"
                  : `${props.identity.usageSource ?? "Workspace"} usage: ${props.identity.usagePercent}% used`
              }
            >
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
                <span className="identity-usage-attention" aria-hidden="true" />
              )}
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
    default:
      return assertNever(props.identity, "Unexpected value");
  }
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

function WorkspaceCommandPalette(props: {
  readonly organisationHandle: string;
  readonly workspaceHandle: string;
  readonly close: () => void;
  readonly openPage: (href: string) => void;
}): React.ReactNode {
  const navigate = props.openPage;
  const dialog = React.useRef<HTMLDialogElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const commands = filterWorkspaceCommands(query);
  useEffect(openCommandDialog.bind(null, dialog, input), []);
  useEffect(scrollActiveCommandIntoView.bind(null, commands, activeIndex), [
    commands,
    activeIndex,
  ]);
  return (
    <dialog
      className="workspace-command-dialog"
      aria-label="Search workspace pages"
      onCancel={handleCommandDialogCancel.bind(null, props.close)}
      onClick={closeCommandDialogFromBackdrop.bind(null, props.close)}
      ref={dialog}
    >
      <div className="workspace-command-search">
        <CommandSearchIcon />
        <input
          type="search"
          value={query}
          placeholder="Search pages…"
          aria-label="Search workspace pages"
          role="combobox"
          aria-expanded="true"
          aria-controls="workspace-command-results"
          aria-activedescendant={activeCommandId(commands, activeIndex)}
          autoComplete="off"
          onChange={handleCommandQueryChange.bind(
            null,
            setQuery,
            setActiveIndex,
          )}
          onKeyDown={handleCommandInputKeyDown.bind(
            null,
            commands,
            activeIndex,
            setActiveIndex,
            navigate,
            props.organisationHandle,
            props.workspaceHandle,
            props.close,
          )}
          ref={input}
        />
        <button
          type="button"
          className="workspace-command-close"
          onClick={props.close}
          aria-label="Close search"
        >
          Esc
        </button>
      </div>
      <div
        className="workspace-command-results"
        id="workspace-command-results"
        role="listbox"
        aria-label="Workspace page results"
      >
        {commands.length === 0 ? (
          <p className="workspace-command-empty" role="status">
            No matching pages. Try another page name.
          </p>
        ) : (
          commands.map(
            renderWorkspaceCommand.bind(
              null,
              activeIndex,
              setActiveIndex,
              navigate,
              props.organisationHandle,
              props.workspaceHandle,
              props.close,
            ),
          )
        )}
      </div>
      <footer className="workspace-command-footer">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Navigate
        </span>
        <span>
          <kbd>↵</kbd> Open
        </span>
        <span>
          <kbd>Esc</kbd> Close
        </span>
      </footer>
    </dialog>
  );
}

function renderWorkspaceCommand(
  activeIndex: number,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
  navigate: (href: string) => void,
  organisationHandle: string,
  workspaceHandle: string,
  close: () => void,
  command: WorkspaceCommand,
  index: number,
): React.ReactNode {
  const active = activeIndex === index;
  return (
    <button
      type="button"
      className={
        active
          ? "workspace-command workspace-command-active"
          : "workspace-command"
      }
      id={workspaceCommandId(command)}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onMouseMove={setCommandActiveIndex.bind(null, index, setActiveIndex)}
      onClick={selectWorkspaceCommand.bind(
        null,
        navigate,
        organisationHandle,
        workspaceHandle,
        close,
        command,
      )}
      key={command.page}
    >
      <WorkspaceNavigationIcon page={command.page} />
      <span>{command.label}</span>
      <small>{command.group}</small>
    </button>
  );
}

function CommandSearchIcon(): React.ReactNode {
  return (
    <svg className="command-search-icon" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="m13 13 4 4" />
    </svg>
  );
}

function buildWorkspaceCommands(
  group: WorkspaceNavigationGroup,
): readonly WorkspaceCommand[] {
  return group.pages.map(
    buildWorkspaceCommand.bind(null, navigationGroupTitle(group.label)),
  );
}

function buildWorkspaceCommand(
  group: string,
  page: WorkspaceDetailPage,
): WorkspaceCommand {
  const descriptor = workspacePageDescriptor(page);
  return {
    page,
    label: descriptor.navigationLabel,
    group,
    searchText:
      `${descriptor.navigationLabel} ${descriptor.title} ${descriptor.segment} ${descriptor.description} ${group}`.toLocaleLowerCase(),
  };
}

function filterWorkspaceCommands(query: string): readonly WorkspaceCommand[] {
  const search = query.trim().toLocaleLowerCase();
  return search.length === 0
    ? WORKSPACE_COMMANDS
    : WORKSPACE_COMMANDS.filter(commandMatchesSearch.bind(null, search)).sort(
        compareWorkspaceCommandMatches.bind(null, search),
      );
}

function compareWorkspaceCommandMatches(
  query: string,
  left: WorkspaceCommand,
  right: WorkspaceCommand,
): number {
  return (
    workspaceCommandMatchRank(query, left) -
    workspaceCommandMatchRank(query, right)
  );
}

function workspaceCommandMatchRank(
  query: string,
  command: WorkspaceCommand,
): number {
  const label = command.label.toLocaleLowerCase();
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  return 2;
}

function commandMatchesSearch(
  search: string,
  command: WorkspaceCommand,
): boolean {
  return command.searchText.includes(search);
}

function workspaceCommandId(command: WorkspaceCommand): string {
  return `workspace-command-${command.page}`;
}

function activeCommandId(
  commands: readonly WorkspaceCommand[],
  activeIndex: number,
): string | undefined {
  const command = commands[activeIndex];
  return command === undefined ? undefined : workspaceCommandId(command);
}

function openCommandDialog(
  dialog: React.RefObject<HTMLDialogElement | null>,
  input: React.RefObject<HTMLInputElement | null>,
): () => void {
  dialog.current?.showModal();
  input.current?.focus();
  return closeCommandDialog.bind(null, dialog);
}

function closeCommandDialog(
  dialog: React.RefObject<HTMLDialogElement | null>,
): void {
  if (dialog.current?.open === true) dialog.current.close();
}

function openCommandPalette(
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  setOpen(true);
}

function closeCommandPalette(
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  trigger: React.RefObject<HTMLButtonElement | null>,
): void {
  setOpen(false);
  window.requestAnimationFrame(focusCommandTrigger.bind(null, trigger));
}

function focusCommandTrigger(
  trigger: React.RefObject<HTMLButtonElement | null>,
): void {
  trigger.current?.focus();
}

function bindCommandPaletteShortcut(
  enabled: boolean,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): () => void {
  const handler = handleCommandPaletteShortcut.bind(null, enabled, setOpen);
  window.addEventListener("keydown", handler);
  return unbindCommandPaletteShortcut.bind(null, handler);
}

function unbindCommandPaletteShortcut(
  handler: (event: KeyboardEvent) => void,
): void {
  window.removeEventListener("keydown", handler);
}

function handleCommandPaletteShortcut(
  enabled: boolean,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  event: KeyboardEvent,
): void {
  if (
    !enabled ||
    event.key.toLocaleLowerCase() !== "k" ||
    (!event.metaKey && !event.ctrlKey)
  )
    return;
  event.preventDefault();
  setOpen(true);
}

function handleCommandDialogCancel(
  close: () => void,
  event: React.SyntheticEvent<HTMLDialogElement>,
): void {
  event.preventDefault();
  close();
}

function closeCommandDialogFromBackdrop(
  close: () => void,
  event: React.MouseEvent<HTMLDialogElement>,
): void {
  if (event.target === event.currentTarget) close();
}

function handleCommandQueryChange(
  setQuery: React.Dispatch<React.SetStateAction<string>>,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  setQuery(event.currentTarget.value);
  setActiveIndex(0);
}

function handleCommandInputKeyDown(
  commands: readonly WorkspaceCommand[],
  activeIndex: number,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
  navigate: (href: string) => void,
  organisationHandle: string,
  workspaceHandle: string,
  close: () => void,
  event: React.KeyboardEvent<HTMLInputElement>,
): void {
  if (event.nativeEvent.isComposing) return;
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      setActiveIndex(nextCommandIndex(commands.length, activeIndex, 1));
      return;
    case "ArrowUp":
      event.preventDefault();
      setActiveIndex(nextCommandIndex(commands.length, activeIndex, -1));
      return;
    case "Home":
      event.preventDefault();
      setActiveIndex(0);
      return;
    case "End":
      event.preventDefault();
      setActiveIndex(Math.max(0, commands.length - 1));
      return;
    case "Enter": {
      event.preventDefault();
      const command = commands[activeIndex];
      if (command !== undefined) {
        selectWorkspaceCommand(
          navigate,
          organisationHandle,
          workspaceHandle,
          close,
          command,
        );
      }
      return;
    }
    case "Escape":
      event.preventDefault();
      close();
      return;
    default:
      return;
  }
}

function nextCommandIndex(
  length: number,
  current: number,
  step: -1 | 1,
): number {
  if (length === 0) return 0;
  return (current + step + length) % length;
}

function setCommandActiveIndex(
  index: number,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
): void {
  setActiveIndex(index);
}

function selectWorkspaceCommand(
  navigate: (href: string) => void,
  organisationHandle: string,
  workspaceHandle: string,
  close: () => void,
  command: WorkspaceCommand,
): void {
  navigate(
    workspacePagePath(organisationHandle, workspaceHandle, command.page),
  );
  close();
}

function scrollActiveCommandIntoView(
  commands: readonly WorkspaceCommand[],
  activeIndex: number,
): void {
  const command = commands[activeIndex];
  if (command === undefined) return;
  document
    .getElementById(workspaceCommandId(command))
    ?.scrollIntoView({ block: "nearest" });
}

function PortalSidebarHeader(props: {
  readonly organisation: OrganisationShellContext;
  readonly workspace: WorkspaceShellContext;
  readonly activeSystem: WorkspaceSystem;
  readonly collapsed: boolean;
  readonly control: ConsoleSidebarControl;
  readonly onNavigate: () => void;
  readonly onSelectSystem: (system: WorkspaceSystem) => void;
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
      <WorkspaceSystemSwitcher
        workspace={props.workspace}
        activeSystem={props.activeSystem}
        collapsed={props.collapsed}
        onNavigate={props.onNavigate}
        onSelectSystem={props.onSelectSystem}
      />
    </div>
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
      aria-label="Seams Pantry organisations"
      inert={props.inert}
    >
      <img
        className="portal-brand-mark"
        src="/brand/pantry-mark-dark-32.png"
        alt=""
      />
      <span className="portal-brand-copy">
        Seams Pantry
        <span className="portal-brand-subtitle">Bakery operating system</span>
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

function WorkspaceSystemSwitcher(props: {
  readonly workspace: WorkspaceShellContext;
  readonly activeSystem: WorkspaceSystem;
  readonly collapsed: boolean;
  readonly onNavigate: () => void;
  readonly onSelectSystem: (system: WorkspaceSystem) => void;
}): React.ReactNode {
  const Icon = WORKSPACE_SYSTEMS[props.activeSystem].icon;
  return (
    <DropdownMenu.Root>
      <div className="console-switcher portal-system-switcher">
        <ConsoleSidebarTooltip
          label={WORKSPACE_SYSTEMS[props.activeSystem].label}
          enabled={props.collapsed}
        >
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="console-switcher-trigger"
              aria-label={`Switch product: ${WORKSPACE_SYSTEMS[props.activeSystem].label}`}
            >
              <span className="portal-system-icon">
                <Icon aria-hidden="true" size={20} strokeWidth={1.7} />
              </span>
              <span className="console-switcher-label">
                {WORKSPACE_SYSTEMS[props.activeSystem].label}
              </span>
              <ChevronDown
                className="console-switcher-caret"
                aria-hidden="true"
              />
            </button>
          </DropdownMenu.Trigger>
        </ConsoleSidebarTooltip>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="console-switcher-menu portal-system-menu"
            aria-label="Products"
            side={props.collapsed ? "right" : "bottom"}
            align="start"
            sideOffset={8}
            collisionPadding={12}
          >
            <GlideHighlight target="[data-highlighted]" />
            <DropdownMenu.Item asChild onSelect={props.onNavigate}>
              <Link className="console-switcher-menu-item" to="/portal">
                <span className="portal-system-icon">
                  <House aria-hidden="true" size={20} strokeWidth={1.7} />
                </span>
                <span className="console-switcher-menu-copy">
                  <strong>Home</strong>
                </span>
              </Link>
            </DropdownMenu.Item>
            {Object.values(WORKSPACE_SYSTEMS).map(
              renderWorkspaceSystem.bind(null, props),
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </div>
    </DropdownMenu.Root>
  );
}

function renderWorkspaceSystem(
  props: {
    readonly workspace: WorkspaceShellContext;
    readonly activeSystem: WorkspaceSystem;
    readonly onNavigate: () => void;
    readonly onSelectSystem: (system: WorkspaceSystem) => void;
  },
  system: (typeof WORKSPACE_SYSTEMS)[WorkspaceSystem],
): React.ReactNode {
  const Icon = system.icon;
  // A start page outside the system (Home) keeps the chosen system's pages.
  const select = (): void => {
    props.onSelectSystem(system.name);
    props.onNavigate();
  };
  return (
    <DropdownMenu.Item key={system.name} asChild onSelect={select}>
      <Link
        className="console-switcher-menu-item"
        to={workspacePagePath(
          props.workspace.organisationHandle,
          props.workspace.workspaceHandle,
          system.page,
        )}
        aria-current={props.activeSystem === system.name ? "true" : undefined}
      >
        <span className="portal-system-icon">
          <Icon aria-hidden="true" size={20} strokeWidth={1.7} />
        </span>
        <span className="console-switcher-menu-copy">
          <strong>{system.label}</strong>
        </span>
        {props.activeSystem === system.name ? (
          <Check size={18} aria-hidden="true" />
        ) : null}
      </Link>
    </DropdownMenu.Item>
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

function isVisibleNavigationGroup(
  system: WorkspaceSystem,
  group: WorkspaceNavigationGroup,
): boolean {
  return (
    group.label === system ||
    group.label === "Workspace" ||
    group.label === "Agents" ||
    group.label === "Settings"
  );
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

function buildConsoleNavigationGroups(
  activePage: WorkspaceDetailPage | null,
  organisationHandle: string,
  workspaceHandle: string,
  system: WorkspaceSystem,
  attention: NavigationAttention,
): readonly ConsoleSidebarNavigationGroup[] {
  return WORKSPACE_NAVIGATION_GROUPS.filter(
    isVisibleNavigationGroup.bind(null, system),
  ).map(
    buildConsoleNavigationGroup.bind(
      null,
      activePage,
      organisationHandle,
      workspaceHandle,
      attention,
    ),
  );
}

function buildConsoleNavigationGroup(
  activePage: WorkspaceDetailPage | null,
  organisationHandle: string,
  workspaceHandle: string,
  attention: NavigationAttention,
  group: WorkspaceNavigationGroup,
): ConsoleSidebarNavigationGroup {
  return {
    id: group.label.toLocaleLowerCase().replaceAll(" ", "-"),
    label: navigationGroupTitle(group.label),
    labelVisibility: "visible",
    items: group.pages.map(
      buildConsoleNavigationItem.bind(
        null,
        activePage,
        organisationHandle,
        workspaceHandle,
        attention,
      ),
    ),
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

function WorkspaceNavigationIcon(props: {
  readonly page: WorkspaceDetailPage;
}): React.ReactNode {
  const Icon = workspaceNavigationIcon(props.page);
  return (
    <Icon
      className="organisation-nav-icon"
      strokeWidth={1.75}
      aria-hidden="true"
    />
  );
}

function workspaceNavigationIcon(page: WorkspaceDetailPage): LucideIcon {
  switch (page) {
    case "overview":
      return LayoutDashboard;
    case "inbox":
      return Mail;
    case "checkout":
    case "terminals":
      return CreditCard;
    case "products":
      return Package;
    case "menus":
    case "recipes":
      return BookOpen;
    case "costs":
      return Calculator;
    case "order-queue":
      return ConciergeBell;
    case "register":
      return CreditCard;
    case "inventory":
      return Warehouse;
    case "orders":
      return ShoppingCart;
    case "payments":
      return CreditCard;
    case "payouts":
      return Landmark;
    case "suppliers":
      return Truck;
    case "workflow-simulator":
    case "production-requests":
      return Factory;
    case "devices":
      return Cpu;
    case "bakes":
      return CakeSlice;
    case "chat":
    case "agents":
      return Bot;
    case "brain":
    case "knowledge":
      return Brain;
    case "activity":
      return Activity;
    case "tests":
      return FlaskConical;
    case "integrations":
      return Plug;
    case "vault":
      return Vault;
    case "api-keys":
      return KeySquare;
    case "jev":
      return Sparkles;
    case "billing":
      return CreditCard;
    case "access":
      return KeyRound;
    case "settings":
      return Settings;
    default:
      return assertNever(page, "Unexpected value");
  }
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
