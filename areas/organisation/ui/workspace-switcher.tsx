import React from "react";
import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, LayoutGrid, Search } from "lucide-react";
import { Link } from "react-router";
import { ConsoleSidebarTooltip } from "@purin-labs/ui/console-sidebar";
import { IdentityTile } from "@purin-labs/ui/index";
import { organisationPath, workspacePagePath } from "@purin-labs/ui/route";
import "./workspace-switcher.css";

/** What a tile shows: the logo, or the gradient of the seed. */
type ChoiceTile = {
  readonly seed: string;
  readonly logoUrl: string | null;
};

export type OrganisationChoice = {
  readonly organisationHandle: string;
  readonly name: string;
  readonly tile: ChoiceTile;
  readonly workspaces: readonly WorkspaceChoice[];
};

export type WorkspaceChoice = {
  readonly organisationHandle: string;
  readonly workspaceHandle: string;
  readonly name: string;
  readonly tile: ChoiceTile;
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

type MenuProps = SwitcherProps & { readonly close: () => void };

export function WorkspaceSwitcher(props: SwitcherProps): React.ReactNode {
  const [open, setOpen] = React.useState(false);
  const current = props.workspace.choices.find(
    (choice) =>
      choice.organisationHandle === props.workspace.organisationHandle &&
      choice.workspaceHandle === props.workspace.workspaceHandle,
  );
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
          <IdentityTile
            className="console-switcher-avatar"
            seed={current?.tile.seed ?? props.workspace.workspaceHandle}
            name={props.workspace.name}
            logoUrl={current?.tile.logoUrl ?? null}
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
          sideOffset={6}
          collisionPadding={8}
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

/**
 * One list: the workspaces of the current organisation under its name, then
 * one row for each other organisation. The find field finds a workspace in
 * any organisation, and each result names its organisation.
 */
function WorkspaceSwitcherMenu(props: MenuProps): React.ReactNode {
  const [query, setQuery] = React.useState("");
  const normalisedQuery = query.trim().toLocaleLowerCase();
  return (
    <>
      <label className="workspace-switcher-search">
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          aria-label="Find a workspace"
          placeholder="Find a workspace…"
          value={query}
          onChange={changeQuery.bind(null, setQuery)}
        />
      </label>
      {normalisedQuery === "" ? (
        <OrganisationList {...props} />
      ) : (
        <FoundWorkspaces {...props} query={normalisedQuery} />
      )}
      <div className="workspace-switcher-rule" aria-hidden="true" />
      <Link
        className="workspace-switcher-row workspace-switcher-all"
        to="/portal"
        onClick={props.close}
      >
        <span className="workspace-switcher-row-icon" aria-hidden="true">
          <LayoutGrid size={18} />
        </span>
        <span className="workspace-switcher-row-text">
          <strong>All organisations</strong>
          <small>View and manage organisations</small>
        </span>
      </Link>
    </>
  );
}

function OrganisationList(props: MenuProps): React.ReactNode {
  const headingId = React.useId();
  const current = currentOrganisation(props);
  const others = props.organisation.choices.filter(
    isOtherOrganisation.bind(null, current.organisationHandle),
  );
  return (
    <>
      <div role="group" aria-labelledby={headingId}>
        <p className="workspace-switcher-heading" id={headingId}>
          {current.name}
        </p>
        {current.workspaces.map(
          renderWorkspace.bind(null, props.workspace, props.close, null),
        )}
      </div>
      {others.length === 0 ? null : (
        <>
          <div className="workspace-switcher-rule" aria-hidden="true" />
          {others.map(renderOrganisation.bind(null, props.close))}
        </>
      )}
    </>
  );
}

function FoundWorkspaces(
  props: MenuProps & { readonly query: string },
): React.ReactNode {
  const rows = [...props.organisation.choices]
    .sort(
      currentOrganisationFirst.bind(
        null,
        props.organisation.organisationHandle,
      ),
    )
    .flatMap(foundRows.bind(null, props.query, props.workspace, props.close));
  return rows.length === 0 ? (
    <p className="workspace-switcher-empty" role="status">
      No organisations or workspaces found.
    </p>
  ) : (
    rows
  );
}

/**
 * The rows that one organisation adds to a find. An organisation name that
 * matches brings all its workspaces; an organisation with no workspace is one
 * row that opens the organisation.
 */
function foundRows(
  query: string,
  current: WorkspaceShellContext,
  close: () => void,
  organisation: OrganisationChoice,
): React.ReactNode[] {
  const organisationMatches = organisation.name
    .toLocaleLowerCase()
    .includes(query);
  if (organisation.workspaces.length === 0)
    return organisationMatches ? [renderOrganisation(close, organisation)] : [];
  const workspaces = organisationMatches
    ? organisation.workspaces
    : organisation.workspaces.filter(matchesWorkspace.bind(null, query));
  return workspaces.map(
    renderWorkspace.bind(null, current, close, organisation.name),
  );
}

/** The current organisation, also when the choices do not name it. */
function currentOrganisation(props: MenuProps): OrganisationChoice {
  return (
    props.organisation.choices.find(
      isOrganisation.bind(null, props.organisation.organisationHandle),
    ) ?? {
      organisationHandle: props.organisation.organisationHandle,
      name: props.organisation.name,
      tile: { seed: props.organisation.organisationHandle, logoUrl: null },
      workspaces: props.workspace.choices,
    }
  );
}

function isOrganisation(
  handle: string,
  organisation: OrganisationChoice,
): boolean {
  return organisation.organisationHandle === handle;
}

function isOtherOrganisation(
  handle: string,
  organisation: OrganisationChoice,
): boolean {
  return organisation.organisationHandle !== handle;
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

/**
 * Another organisation is one row: its name, and its workspaces in the hint.
 * The row opens the organisation, and the Portal opens the workspace that the
 * person used last there.
 */
function renderOrganisation(
  close: () => void,
  organisation: OrganisationChoice,
): React.ReactNode {
  const first = organisation.workspaces[0];
  return (
    <Link
      key={organisation.organisationHandle}
      className="workspace-switcher-row"
      to={organisationPath(organisation.organisationHandle)}
      onClick={close}
    >
      <IdentityTile
        className="console-switcher-avatar"
        seed={organisation.tile.seed}
        name={organisation.name}
        logoUrl={organisation.tile.logoUrl}
      />
      <span className="workspace-switcher-row-text">
        <strong>{organisation.name}</strong>
        <small>
          {first === undefined
            ? "Open organisation to create a workspace"
            : organisation.workspaces.map(workspaceName).join(", ")}
        </small>
      </span>
    </Link>
  );
}

function workspaceName(workspace: WorkspaceChoice): string {
  return workspace.name;
}

/** A workspace row. In a find, the hint names its organisation. */
function renderWorkspace(
  current: WorkspaceShellContext,
  close: () => void,
  organisationName: string | null,
  workspace: WorkspaceChoice,
): React.ReactNode {
  const selected =
    workspace.organisationHandle === current.organisationHandle &&
    workspace.workspaceHandle === current.workspaceHandle;
  return (
    <Link
      key={`${workspace.organisationHandle}/${workspace.workspaceHandle}`}
      to={workspacePagePath(
        workspace.organisationHandle,
        workspace.workspaceHandle,
        "overview",
      )}
      onClick={close}
      className="workspace-switcher-row"
      aria-current={selected ? "page" : undefined}
    >
      <IdentityTile
        className="console-switcher-avatar"
        seed={workspace.tile.seed}
        name={workspace.name}
        logoUrl={workspace.tile.logoUrl}
      />
      <span className="workspace-switcher-row-text">
        <span>{workspace.name}</span>
        {organisationName === null ? null : <small>{organisationName}</small>}
      </span>
      {selected ? (
        <Check
          size={16}
          className="workspace-switcher-check"
          aria-hidden="true"
        />
      ) : null}
    </Link>
  );
}
