import React from "react";
import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, LayoutGrid, Search } from "lucide-react";
import { Link } from "react-router";
import { ConsoleSidebarTooltip } from "./console-sidebar";
import { organisationPath, workspacePagePath } from "./route";
import "./workspace-switcher.css";

export type OrganisationChoice = {
  readonly organisationHandle: string;
  readonly name: string;
  readonly workspaces: readonly WorkspaceChoice[];
};

export type WorkspaceChoice = {
  readonly organisationHandle: string;
  readonly workspaceHandle: string;
  readonly name: string;
};

export type OrganisationShellContext = {
  readonly organisationHandle: string;
  readonly name: string;
  readonly choices: readonly OrganisationChoice[];
};

export type WorkspaceShellContext = {
  readonly organisationHandle: string;
  readonly workspaceHandle: string;
  readonly name: string;
  readonly choices: readonly WorkspaceChoice[];
};

type SwitcherProps = {
  readonly organisation: OrganisationShellContext;
  readonly workspace: WorkspaceShellContext;
  readonly collapsed: boolean;
};

export function WorkspaceSwitcher(props: SwitcherProps): React.ReactNode {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <ConsoleSidebarTooltip
        label={props.workspace.name}
        enabled={props.collapsed && !open}
      >
        <Popover.Trigger
          className="console-switcher-trigger workspace-switcher-trigger"
          aria-label={`Switch workspace: ${props.organisation.name}, ${props.workspace.name}`}
        >
          <span
            className="console-switcher-avatar console-switcher-workspace-avatar"
            aria-hidden="true"
          />
          <span className="console-switcher-label workspace-switcher-label">
            <small>{props.organisation.name}</small>
            <strong>{props.workspace.name}</strong>
          </span>
          <ChevronDown className="console-switcher-caret" aria-hidden="true" />
        </Popover.Trigger>
      </ConsoleSidebarTooltip>
      <Popover.Portal>
        <Popover.Positioner
          side={props.collapsed ? "right" : "bottom"}
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="workspace-switcher-positioner"
        >
          <Popover.Popup
            className="workspace-switcher-popup"
            aria-label="Organisations and workspaces"
          >
            <WorkspaceSwitcherMenu
              {...props}
              close={setOpen.bind(null, false)}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function WorkspaceSwitcherMenu(
  props: SwitcherProps & { readonly close: () => void },
): React.ReactNode {
  const [query, setQuery] = React.useState("");
  const normalisedQuery = query.trim().toLocaleLowerCase();
  const choices = props.organisation.choices
    .filter(matchesOrganisation.bind(null, normalisedQuery))
    .sort(
      currentOrganisationFirst.bind(
        null,
        props.organisation.organisationHandle,
      ),
    );
  return (
    <>
      <label className="workspace-switcher-search">
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          aria-label="Find a workspace"
          placeholder="Find a workspace…"
          value={query}
          onChange={changeQuery.bind(null, setQuery)}
        />
      </label>
      <div className="workspace-switcher-groups">
        {choices.map(renderOrganisation.bind(null, props, normalisedQuery))}
        {choices.length === 0 ? (
          <p className="workspace-switcher-empty" role="status">
            No organisations or workspaces found.
          </p>
        ) : null}
      </div>
      <Link
        className="workspace-switcher-footer"
        to="/portal"
        onClick={props.close}
      >
        <LayoutGrid size={20} aria-hidden="true" />
        <span>
          <strong>All organisations</strong>
          <small>View and manage organisations</small>
        </span>
      </Link>
    </>
  );
}

function changeQuery(
  setQuery: React.Dispatch<React.SetStateAction<string>>,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  setQuery(event.currentTarget.value);
}

function matchesWorkspace(query: string, workspace: WorkspaceChoice): boolean {
  return workspace.name.toLocaleLowerCase().includes(query);
}

function currentOrganisationFirst(
  current: string,
  left: OrganisationChoice,
  right: OrganisationChoice,
): number {
  return (
    Number(right.organisationHandle === current) -
    Number(left.organisationHandle === current)
  );
}

function matchesOrganisation(
  query: string,
  organisation: OrganisationChoice,
): boolean {
  return (
    organisation.name.toLocaleLowerCase().includes(query) ||
    organisation.workspaces.some(matchesWorkspace.bind(null, query))
  );
}

function renderOrganisation(
  props: SwitcherProps & { readonly close: () => void },
  query: string,
  organisation: OrganisationChoice,
): React.ReactNode {
  return (
    <OrganisationGroup
      key={`${organisation.organisationHandle}:${query}`}
      organisation={organisation}
      current={props.workspace}
      query={query}
      close={props.close}
    />
  );
}

function OrganisationGroup(props: {
  readonly organisation: OrganisationChoice;
  readonly current: WorkspaceShellContext;
  readonly query: string;
  readonly close: () => void;
}): React.ReactNode {
  const isCurrent =
    props.organisation.organisationHandle === props.current.organisationHandle;
  const workspaces = props.organisation.name
    .toLocaleLowerCase()
    .includes(props.query)
    ? props.organisation.workspaces
    : props.organisation.workspaces.filter(
        matchesWorkspace.bind(null, props.query),
      );
  return (
    <details
      className="workspace-switcher-group"
      open={isCurrent || props.query.length > 0}
    >
      <summary>
        <span
          className="console-switcher-avatar console-switcher-organisation-avatar"
          aria-hidden="true"
        />
        <span>
          <strong>{props.organisation.name}</strong>
          {isCurrent ? <small>Current organisation</small> : null}
        </span>
        <ChevronDown
          size={16}
          className="workspace-switcher-chevron"
          aria-hidden="true"
        />
      </summary>
      <div className="workspace-switcher-workspaces">
        {workspaces.map(renderWorkspace.bind(null, props.current, props.close))}
        {props.organisation.workspaces.length === 0 ? (
          <Link
            to={organisationPath(props.organisation.organisationHandle)}
            onClick={props.close}
          >
            Open organisation to create a workspace
          </Link>
        ) : null}
      </div>
    </details>
  );
}

function renderWorkspace(
  current: WorkspaceShellContext,
  close: () => void,
  workspace: WorkspaceChoice,
): React.ReactNode {
  const selected =
    workspace.organisationHandle === current.organisationHandle &&
    workspace.workspaceHandle === current.workspaceHandle;
  return (
    <Link
      key={workspace.workspaceHandle}
      to={workspacePagePath(
        workspace.organisationHandle,
        workspace.workspaceHandle,
        "overview",
      )}
      onClick={close}
      className="workspace-switcher-workspace"
      aria-current={selected ? "page" : undefined}
    >
      <span
        className="console-switcher-avatar console-switcher-workspace-avatar"
        aria-hidden="true"
      />
      <span>{workspace.name}</span>
      {selected ? <Check size={18} aria-hidden="true" /> : null}
    </Link>
  );
}
