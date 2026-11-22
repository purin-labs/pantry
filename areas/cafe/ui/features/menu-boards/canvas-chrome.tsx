import React from "react";
import { ChevronDown, House, Plus, Search } from "lucide-react";
import type { CanvasChrome } from "@purin-labs/ui/console-tools";
import {
  ActionMenu,
  PantryMark,
  type ActionMenuSection,
} from "@purin-labs/ui/index";
import { OverflowToolbar } from "@purin-labs/ui/overflow-toolbar";
import "./canvas-chrome.css";

/**
 * The board editor's own top row on a wide screen, where the Portal draws no
 * rail and no top bar (a canvas page): a menu at the top left with the way
 * home, and the console's tools (search, appearance, Ask and the account) in
 * their own container at the top right.
 */
export function CanvasMenu(
  props: Readonly<{
    chrome: CanvasChrome;
    /** The open board's name, as the file name in a design tool. */
    title: string | null;
    onNewBoard: () => void;
  }>,
): React.ReactNode {
  const sections: ActionMenuSection[] = [
    {
      id: "workspace",
      items: [
        ...(props.chrome.home === null
          ? []
          : [
              {
                id: "home",
                label: "Back to home",
                icon: <House size={16} aria-hidden="true" />,
                onSelect: props.chrome.home.open,
              },
            ]),
        ...(props.chrome.search === null
          ? []
          : [
              {
                id: "search",
                label: "Search workspace",
                icon: <Search size={16} aria-hidden="true" />,
                shortcut: "⌘ K",
                onSelect: props.chrome.search,
              },
            ]),
      ],
    },
    {
      id: "boards",
      items: [
        {
          id: "new-board",
          label: "New board",
          icon: <Plus size={16} aria-hidden="true" />,
          onSelect: props.onNewBoard,
        },
      ],
    },
  ];
  return (
    <div className="menu-board-float menu-board-canvas-menu">
      <ActionMenu
        label="Menus"
        trigger={
          <button type="button" className="menu-board-canvas-menu-trigger">
            <span className="menu-board-canvas-menu-mark" aria-hidden="true">
              <PantryMark />
            </span>
            <span>Menus</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        }
        sections={sections.filter((section) => section.items.length > 0)}
      />
      {props.title === null ? null : (
        <span className="menu-board-canvas-menu-title" title={props.title}>
          {props.title}
        </span>
      )}
    </div>
  );
}

export function CanvasConsole(
  props: Readonly<{ chrome: CanvasChrome }>,
): React.ReactNode {
  return (
    <div className="menu-board-float menu-board-canvas-console portal-workspace-header">
      <div className="portal-nav">
        <OverflowToolbar
          className="menu-board-canvas-console-tools"
          items={props.chrome.items}
          overflowLabel="More console tools"
        />
      </div>
    </div>
  );
}
