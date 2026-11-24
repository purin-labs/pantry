import React from "react";

import {
  ConsoleSidebar,
  ConsoleSidebarToggle,
  type ConsoleSidebarControl,
  type ConsoleSidebarNavigationGroup,
  type ConsoleSidebarResolvedLink,
  type ConsoleSidebarState,
} from "@purin-labs/ui/console-sidebar";

type DashboardNavigationProps = {
  /** Null when the page draws the console tools in its own top row. */
  readonly topbar: {
    readonly brand: React.ReactNode;
    readonly actions: React.ReactNode;
    readonly sidebarControl: ConsoleSidebarControl;
    /** What waits inside the closed drawer, said on its toggle. */
    readonly attention?: string;
  } | null;
  readonly sidebar: {
    readonly id: string;
    readonly label: string;
    readonly state: ConsoleSidebarState;
    readonly groups: readonly ConsoleSidebarNavigationGroup[];
    readonly resolveLink: (to: string) => ConsoleSidebarResolvedLink;
    readonly onNavigate: () => void;
    readonly header: React.ReactNode;
    readonly footer: React.ReactNode;
    readonly foot: React.ReactNode;
  };
};

/**
 * Shared dashboard chrome: the top bar with Ask, and the workspace sidebar
 * with the search, the pages and the account.
 */
export function DashboardNavigation({
  topbar,
  sidebar,
}: DashboardNavigationProps): React.ReactNode {
  const showTopbarToggle = topbar?.sidebarControl.state.mode === "drawer";
  return (
    <>
      {topbar === null ? null : (
        <header className="portal-workspace-header">
          <div className="portal-nav">
            <div className="portal-nav-lead">
              {topbar.brand}
              {showTopbarToggle ? (
                <ConsoleSidebarToggle
                  {...topbar.sidebarControl}
                  placement="topbar"
                  attention={topbar.attention}
                />
              ) : null}
            </div>
            <div className="portal-nav-actions">{topbar.actions}</div>
          </div>
        </header>
      )}
      <ConsoleSidebar
        id={sidebar.id}
        label={sidebar.label}
        state={sidebar.state}
        groups={sidebar.groups}
        resolveLink={sidebar.resolveLink}
        onNavigate={sidebar.onNavigate}
        header={sidebar.header}
        footer={sidebar.footer}
        foot={sidebar.foot}
      />
    </>
  );
}
