import React from "react";

import {
  ConsoleSidebar,
  ConsoleSidebarToggle,
  type ConsoleSidebarControl,
  type ConsoleSidebarNavigationGroup,
  type ConsoleSidebarResolvedLink,
  type ConsoleSidebarState,
} from "./console-sidebar";

type DashboardNavigationProps = {
  /** Null when the page draws the console tools in its own top row. */
  readonly topbar: {
    readonly brand: React.ReactNode;
    readonly search: React.ReactNode;
    readonly actions: React.ReactNode;
    readonly sidebarControl: ConsoleSidebarControl;
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
  };
};

/** Shared dashboard chrome for the persistent topbar and workspace rail. */
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
                />
              ) : null}
            </div>
            <div className="portal-nav-actions">
              {topbar.search}
              {topbar.actions}
            </div>
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
      />
    </>
  );
}
