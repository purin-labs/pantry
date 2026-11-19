import React from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import DashboardSidebarToggleIcon from "./dashboard-sidebar-toggle-icon";
import { assertNever } from "@purin-labs/std";

const CONSOLE_SIDEBAR_COMPACT_QUERY = "(max-width: 1160px)";

export type ConsoleSidebarState =
  | {
      readonly mode: "rail";
      readonly visibility: "expanded" | "collapsed";
    }
  | {
      readonly mode: "drawer";
      readonly visibility: "open" | "closed";
    };

export type ConsoleSidebarControl = {
  readonly sidebarId: string;
  readonly state: ConsoleSidebarState;
  readonly onToggle: () => void;
};

type ConsoleSidebarToggleProps = ConsoleSidebarControl & {
  readonly placement: "rail" | "topbar";
};

type ConsoleSidebarIconProps = React.SVGProps<SVGSVGElement> & {
  readonly size?: number | string;
  readonly strokeWidth?: number;
};

type ConsoleSidebarIcon = React.ComponentType<ConsoleSidebarIconProps>;

export type ConsoleSidebarNavigationItem = {
  readonly id: string;
  readonly label: string;
  readonly to: string;
  readonly icon: ConsoleSidebarIcon;
  readonly status: "active" | "available" | "disabled";
  /**
   * What waits behind this entry, when something does: the number beside
   * the label, and the words that say what it counts.
   */
  readonly attention?: {
    readonly count: number;
    readonly label: string;
  };
};

export type ConsoleSidebarNavigationGroup = {
  readonly id: string;
  readonly label: string;
  readonly labelVisibility: "visible" | "hidden";
  readonly items: readonly ConsoleSidebarNavigationItem[];
};

export type ConsoleSidebarResolvedLink = {
  readonly href: string;
  readonly onClick: (event: React.MouseEvent<HTMLAnchorElement>) => void;
};

type ConsoleSidebarProps = {
  readonly id: string;
  readonly label: string;
  readonly state: ConsoleSidebarState;
  readonly groups: readonly ConsoleSidebarNavigationGroup[];
  readonly resolveLink: (to: string) => ConsoleSidebarResolvedLink;
  readonly onNavigate: () => void;
  readonly header: React.ReactNode;
  readonly footer: React.ReactNode;
};

type UseConsoleSidebarControllerInput = {
  readonly sidebarId: string;
  readonly railExpanded: boolean;
  readonly onToggleRail: () => void;
};

type UseConsoleSidebarControllerResult = {
  readonly control: ConsoleSidebarControl;
  readonly state: ConsoleSidebarState;
  readonly onNavigate: () => void;
};

function buildConsoleSidebarState(
  compactLayout: boolean,
  railExpanded: boolean,
  drawerOpen: boolean,
): ConsoleSidebarState {
  if (compactLayout) {
    return { mode: "drawer", visibility: drawerOpen ? "open" : "closed" };
  }
  return { mode: "rail", visibility: railExpanded ? "expanded" : "collapsed" };
}

function consoleSidebarExpanded(state: ConsoleSidebarState): boolean {
  switch (state.mode) {
    case "rail":
      return state.visibility === "expanded";
    case "drawer":
      return state.visibility === "open";
    default:
      return assertNever(state, "Unhandled console sidebar state");
  }
}

function consoleSidebarHidden(state: ConsoleSidebarState): boolean {
  switch (state.mode) {
    case "rail":
      return false;
    case "drawer":
      return state.visibility === "closed";
    default:
      return assertNever(state, "Unhandled console sidebar state");
  }
}

/**
 * Whether a click on a link is one the page handles itself. A click that asks
 * for a new tab or window goes to the browser.
 */
export function isPrimaryNavigationClick(
  event: React.MouseEvent<HTMLAnchorElement>,
): boolean {
  return !(
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0
  );
}

function navigationItemClassName(
  status: ConsoleSidebarNavigationItem["status"],
): string {
  switch (status) {
    case "active":
      return "console-nav-item console-nav-item-active";
    case "available":
      return "console-nav-item";
    case "disabled":
      return "console-nav-item console-nav-item-disabled";
    default:
      return assertNever(status, "Unhandled console sidebar state");
  }
}

function handleNavigationClick(
  item: ConsoleSidebarNavigationItem,
  resolved: ConsoleSidebarResolvedLink,
  onNavigate: () => void,
  event: React.MouseEvent<HTMLAnchorElement>,
): void {
  if (item.status === "disabled") {
    event.preventDefault();
    return;
  }
  const closeDrawer = isPrimaryNavigationClick(event);
  resolved.onClick(event);
  if (closeDrawer) onNavigate();
}

function renderNavigationItem(
  state: ConsoleSidebarState,
  resolveLink: ConsoleSidebarProps["resolveLink"],
  onNavigate: () => void,
  item: ConsoleSidebarNavigationItem,
): React.ReactNode {
  const ItemIcon = item.icon;
  const resolved = resolveLink(item.to);
  const disabled = item.status === "disabled";
  const showTooltip = state.mode === "rail" && state.visibility === "collapsed";
  const attention = item.attention;
  return (
    <li key={item.id}>
      <ConsoleSidebarTooltip
        label={
          attention === undefined
            ? item.label
            : `${item.label}, ${attention.label}`
        }
        enabled={showTooltip}
      >
        <a
          className={navigationItemClassName(item.status)}
          href={resolved.href}
          onClick={handleNavigationClick.bind(null, item, resolved, onNavigate)}
          aria-current={item.status === "active" ? "page" : undefined}
          aria-disabled={disabled || undefined}
          aria-label={
            attention === undefined
              ? undefined
              : `${item.label}, ${attention.label}`
          }
          tabIndex={disabled ? -1 : undefined}
        >
          <span
            className="console-nav-icon"
            aria-hidden="true"
            data-attention={attention === undefined ? undefined : "true"}
          >
            <ItemIcon size={20} strokeWidth={1.6} />
          </span>
          <span
            className={
              attention === undefined
                ? "console-nav-label"
                : "console-nav-label console-nav-label-counted"
            }
          >
            {item.label}
            {attention === undefined ? null : (
              <span className="console-nav-count" aria-hidden="true">
                {attention.count}
              </span>
            )}
          </span>
        </a>
      </ConsoleSidebarTooltip>
    </li>
  );
}

function renderNavigationGroup(
  state: ConsoleSidebarState,
  resolveLink: ConsoleSidebarProps["resolveLink"],
  onNavigate: () => void,
  group: ConsoleSidebarNavigationGroup,
): React.ReactNode {
  return (
    <section
      className="console-sidebar-group"
      key={group.id}
      aria-label={group.label}
    >
      {group.labelVisibility === "visible" ? (
        <p className="console-sidebar-group-title">{group.label}</p>
      ) : null}
      <ul className="console-nav-list">
        {group.items.map(
          renderNavigationItem.bind(null, state, resolveLink, onNavigate),
        )}
      </ul>
    </section>
  );
}

// Entering or leaving the compact layout starts with the drawer closed, so the
// switchers and navigation appear only after the operator opens it.
function matchMediaChanged(
  setCompactLayout: React.Dispatch<React.SetStateAction<boolean>>,
  setDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>,
  event: MediaQueryListEvent,
): void {
  setCompactLayout(event.matches);
  setDrawerOpen(false);
}

function readCompactLayout(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(CONSOLE_SIDEBAR_COMPACT_QUERY).matches
  );
}

function subscribeCompactLayout(
  setCompactLayout: React.Dispatch<React.SetStateAction<boolean>>,
  setDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>,
): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return ignoreCleanup;
  const media = window.matchMedia(CONSOLE_SIDEBAR_COMPACT_QUERY);
  const listener = matchMediaChanged.bind(
    null,
    setCompactLayout,
    setDrawerOpen,
  );
  setCompactLayout(media.matches);
  media.addEventListener("change", listener);
  return removeCompactLayoutListener.bind(null, media, listener);
}

function removeCompactLayoutListener(
  media: MediaQueryList,
  listener: (event: MediaQueryListEvent) => void,
): void {
  media.removeEventListener("change", listener);
}

function ignoreCleanup(): void {}

function toggleBoolean(current: boolean): boolean {
  return !current;
}

function toggleConsoleSidebar(
  state: ConsoleSidebarState,
  onToggleRail: () => void,
  setDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  switch (state.mode) {
    case "rail":
      onToggleRail();
      return;
    case "drawer":
      setDrawerOpen(toggleBoolean);
      return;
    default:
      assertNever(state, "Unhandled console sidebar state");
  }
}

function closeConsoleSidebarDrawer(
  state: ConsoleSidebarState,
  setDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  if (state.mode === "drawer") setDrawerOpen(false);
}

export function useConsoleSidebarController({
  sidebarId,
  railExpanded,
  onToggleRail,
}: UseConsoleSidebarControllerInput): UseConsoleSidebarControllerResult {
  const [compactLayout, setCompactLayout] = React.useState(readCompactLayout);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  React.useEffect(
    subscribeCompactLayout.bind(null, setCompactLayout, setDrawerOpen),
    [],
  );
  const state = React.useMemo(
    buildConsoleSidebarState.bind(
      null,
      compactLayout,
      railExpanded,
      drawerOpen,
    ),
    [compactLayout, drawerOpen, railExpanded],
  );
  const onToggle = React.useCallback(
    toggleConsoleSidebar.bind(null, state, onToggleRail, setDrawerOpen),
    [onToggleRail, state],
  );
  const onNavigate = React.useCallback(
    closeConsoleSidebarDrawer.bind(null, state, setDrawerOpen),
    [state],
  );
  const control = React.useMemo(
    buildConsoleSidebarControl.bind(null, sidebarId, state, onToggle),
    [onToggle, sidebarId, state],
  );
  return { control, state, onNavigate };
}

function buildConsoleSidebarControl(
  sidebarId: string,
  state: ConsoleSidebarState,
  onToggle: () => void,
): ConsoleSidebarControl {
  return { sidebarId, state, onToggle };
}

export function ConsoleSidebarToggle({
  sidebarId,
  state,
  onToggle,
  placement,
}: ConsoleSidebarToggleProps): React.ReactNode {
  const expanded = consoleSidebarExpanded(state);
  return (
    <button
      type="button"
      className={`dashboard-sidebar-toggle${placement === "rail" ? " dashboard-sidebar-toggle--rail" : ""}`}
      aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
      aria-controls={sidebarId}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <DashboardSidebarToggleIcon expanded={expanded} />
    </button>
  );
}

export function ConsoleSidebar({
  id,
  label,
  state,
  groups,
  resolveLink,
  onNavigate,
  header,
  footer,
}: ConsoleSidebarProps): React.ReactNode {
  return (
    <Tooltip.Provider delay={250}>
      <aside
        id={id}
        className="console-sidebar"
        aria-label={label}
        data-mode={state.mode}
        data-state={state.visibility}
        hidden={consoleSidebarHidden(state)}
      >
        {header}
        <nav className="console-sidebar-navigation" aria-label={label}>
          {groups.map(
            renderNavigationGroup.bind(null, state, resolveLink, onNavigate),
          )}
        </nav>
        {footer}
      </aside>
    </Tooltip.Provider>
  );
}

/** The dark label beside a rail control while the rail is collapsed. */
export function ConsoleSidebarTooltip(props: {
  readonly label: string;
  readonly enabled: boolean;
  readonly children: React.ReactElement;
}): React.ReactNode {
  return (
    <Tooltip.Root disabled={!props.enabled}>
      <Tooltip.Trigger render={props.children} />
      <Tooltip.Portal>
        <Tooltip.Positioner
          side="right"
          align="center"
          sideOffset={12}
          collisionPadding={8}
          className="console-sidebar-tooltip-positioner"
        >
          <Tooltip.Popup className="console-sidebar-tooltip">
            {props.label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
