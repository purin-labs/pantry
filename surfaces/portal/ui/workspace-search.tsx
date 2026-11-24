import React, { useEffect } from "react";

import {
  WORKSPACE_NAVIGATION_GROUPS,
  navigationGroupTitle,
  workspacePageDescriptor,
  workspacePagePath,
  type WorkspaceDetailPage,
  type WorkspaceNavigationGroup,
} from "@purin-labs/ui/route";
import { workspaceNavigationIcon } from "@purin-labs/ui/page-icons";
import "./workspace-search.css";

/**
 * The workspace search: one modal dialog that finds a page of the navigation.
 * The search button, ⌘K and Ctrl+K open it. Each area name shows one time,
 * as a heading over its pages.
 */

type WorkspaceCommand = {
  readonly page: WorkspaceDetailPage;
  readonly label: string;
  readonly group: string;
  readonly searchText: string;
};

type WorkspaceCommandGroup = {
  readonly title: string;
  readonly commands: readonly WorkspaceCommand[];
};

const WORKSPACE_COMMANDS = WORKSPACE_NAVIGATION_GROUPS.flatMap(
  buildWorkspaceCommands,
);

export type WorkspaceSearch = {
  readonly open: boolean;
  /** Opens the dialog. Focus returns to the control that had it. */
  readonly openSearch: () => void;
  readonly close: () => void;
};

/** The dialog's state, and ⌘K / Ctrl+K while `enabled`. */
export function useWorkspaceSearch(enabled: boolean): WorkspaceSearch {
  const [open, setOpen] = React.useState(false);
  const opener = React.useRef<HTMLElement | null>(null);
  const openSearch = React.useCallback(
    rememberOpenerAndOpen.bind(null, opener, setOpen),
    [],
  );
  const close = React.useCallback(
    closeAndReturnFocus.bind(null, opener, setOpen),
    [],
  );
  useEffect(bindSearchShortcut.bind(null, enabled, openSearch), [
    enabled,
    openSearch,
  ]);
  return React.useMemo(
    () => ({ open, openSearch, close }),
    [open, openSearch, close],
  );
}

function rememberOpenerAndOpen(
  opener: React.RefObject<HTMLElement | null>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  const active = document.activeElement;
  opener.current =
    active instanceof HTMLElement && active !== document.body ? active : null;
  setOpen(true);
}

function closeAndReturnFocus(
  opener: React.RefObject<HTMLElement | null>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  setOpen(false);
  window.requestAnimationFrame(returnSearchFocus.bind(null, opener.current));
}

/**
 * Focus goes back to the control that opened the search. If that control is
 * gone or hidden, such as a menu item, a search button that shows takes it.
 */
function returnSearchFocus(opener: HTMLElement | null): void {
  const buttons = document.querySelectorAll<HTMLElement>(
    "[data-workspace-search]",
  );
  const target = [opener, ...buttons].find(isShownElement);
  target?.focus();
}

function isShownElement(element: HTMLElement | null): element is HTMLElement {
  return (
    element !== null &&
    element.isConnected &&
    element.getClientRects().length > 0
  );
}

function bindSearchShortcut(enabled: boolean, open: () => void): () => void {
  const handler = handleSearchShortcut.bind(null, enabled, open);
  window.addEventListener("keydown", handler);
  return unbindSearchShortcut.bind(null, handler);
}

function unbindSearchShortcut(handler: (event: KeyboardEvent) => void): void {
  window.removeEventListener("keydown", handler);
}

function handleSearchShortcut(
  enabled: boolean,
  open: () => void,
  event: KeyboardEvent,
): void {
  if (
    !enabled ||
    event.key.toLocaleLowerCase() !== "k" ||
    (!event.metaKey && !event.ctrlKey)
  )
    return;
  event.preventDefault();
  open();
}

/**
 * The button that opens the search: in the sidebar with its label and the
 * key, or as an icon in a page's own toolbar.
 */
export function WorkspaceSearchButton(
  props: Readonly<{ variant: "sidebar" | "toolbar" }> &
    React.ComponentPropsWithRef<"button">,
): React.ReactNode {
  const { variant, ...button } = props;
  const sidebar = variant === "sidebar";
  return (
    <button
      className={sidebar ? "console-sidebar-search" : "portal-command-trigger"}
      type="button"
      aria-haspopup="dialog"
      aria-label="Search workspace"
      aria-keyshortcuts="Meta+K Control+K"
      data-workspace-search=""
      {...button}
    >
      <CommandSearchIcon />
      <span
        className={
          sidebar ? "console-sidebar-search-label" : "portal-command-label"
        }
      >
        {sidebar ? "Search" : "Search workspace"}
      </span>
      <kbd>⌘ K</kbd>
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

type PaletteTarget = {
  readonly navigate: (href: string) => void;
  readonly organisationHandle: string;
  readonly workspaceHandle: string;
  readonly close: () => void;
};

export function WorkspaceSearchDialog(props: {
  readonly organisationHandle: string;
  readonly workspaceHandle: string;
  readonly close: () => void;
  readonly openPage: (href: string) => void;
}): React.ReactNode {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const groups = React.useMemo(filterWorkspaceCommands.bind(null, query), [
    query,
  ]);
  const commands = React.useMemo(() => groups.flatMap(groupCommands), [groups]);
  const target: PaletteTarget = {
    navigate: props.openPage,
    organisationHandle: props.organisationHandle,
    workspaceHandle: props.workspaceHandle,
    close: props.close,
  };
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
            target,
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
          groups.map(
            renderWorkspaceCommandGroup.bind(
              null,
              commands,
              activeIndex,
              setActiveIndex,
              target,
            ),
          )
        )}
      </div>
    </dialog>
  );
}

function groupCommands(
  group: WorkspaceCommandGroup,
): readonly WorkspaceCommand[] {
  return group.commands;
}

function renderWorkspaceCommandGroup(
  commands: readonly WorkspaceCommand[],
  activeIndex: number,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
  target: PaletteTarget,
  group: WorkspaceCommandGroup,
): React.ReactNode {
  const headingId = `workspace-command-group-${group.title.toLocaleLowerCase().replaceAll(" ", "-")}`;
  return (
    <div
      className="workspace-command-group"
      role="group"
      aria-labelledby={headingId}
      key={group.title}
    >
      <div
        className="workspace-command-group-title"
        id={headingId}
        role="presentation"
      >
        {group.title}
      </div>
      {group.commands.map((command) =>
        renderWorkspaceCommand(
          commands.indexOf(command),
          activeIndex,
          setActiveIndex,
          target,
          command,
        ),
      )}
    </div>
  );
}

function renderWorkspaceCommand(
  index: number,
  activeIndex: number,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
  target: PaletteTarget,
  command: WorkspaceCommand,
): React.ReactNode {
  const active = activeIndex === index;
  const Icon = workspaceNavigationIcon(command.page);
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
      onMouseMove={setActiveIndex.bind(null, index)}
      onClick={selectWorkspaceCommand.bind(null, target, command)}
      key={command.page}
    >
      <Icon strokeWidth={1.75} aria-hidden="true" />
      <span>{command.label}</span>
    </button>
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

/**
 * The pages that match, under their area names. The area of the best match
 * comes first, so an exact label still leads the list.
 */
function filterWorkspaceCommands(
  query: string,
): readonly WorkspaceCommandGroup[] {
  const search = query.trim().toLocaleLowerCase();
  const matches =
    search.length === 0
      ? WORKSPACE_COMMANDS
      : WORKSPACE_COMMANDS.filter(commandMatchesSearch.bind(null, search)).sort(
          compareWorkspaceCommandMatches.bind(null, search),
        );
  const groups = new Map<string, WorkspaceCommand[]>();
  for (const command of matches) {
    const group = groups.get(command.group);
    if (group === undefined) groups.set(command.group, [command]);
    else group.push(command);
  }
  return Array.from(groups, toCommandGroup);
}

function toCommandGroup([title, commands]: [
  string,
  readonly WorkspaceCommand[],
]): WorkspaceCommandGroup {
  return { title, commands };
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
  target: PaletteTarget,
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
      if (command !== undefined) selectWorkspaceCommand(target, command);
      return;
    }
    case "Escape":
      event.preventDefault();
      target.close();
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

function selectWorkspaceCommand(
  target: PaletteTarget,
  command: WorkspaceCommand,
): void {
  target.navigate(
    workspacePagePath(
      target.organisationHandle,
      target.workspaceHandle,
      command.page,
    ),
  );
  target.close();
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
