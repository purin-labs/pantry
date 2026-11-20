import React from "react";

import type { ToolbarItem } from "./ui/overflow-toolbar";

/**
 * The console's own tools: search, appearance, Ask and the account. A page
 * that draws its own top row can dock them into that row. The shell then
 * draws no top bar of its own.
 */
type ConsoleTools = Readonly<{
  items: readonly ToolbarItem[];
  /** Docks the tools in the page. The result undocks them. */
  dock: () => () => void;
  /**
   * Makes the calling page a canvas page: the tools dock in the page, and
   * the rail gives way to the page's own menu. The result undoes both.
   */
  canvas: () => () => void;
  /** The workspace home, for the canvas page's "Back to home". */
  home: CanvasHome | null;
  /** Opens the workspace search; null outside a workspace. */
  search: (() => void) | null;
}>;

type CanvasHome = Readonly<{ href: string; open: () => void }>;

/** What a canvas page draws in place of the rail and the top bar. */
export type CanvasChrome = Readonly<{
  items: readonly ToolbarItem[];
  home: CanvasHome | null;
  search: (() => void) | null;
}>;

const ConsoleToolsContext = React.createContext<ConsoleTools | null>(null);

export const ConsoleToolsProvider = ConsoleToolsContext.Provider;

/** The shell docks its tools only where the workspace rail stands. */
const CONSOLE_DOCK_QUERY = "(min-width: 1161px)";

/**
 * Docks the console's tools in the calling page while the window is wide.
 * Returns the tools to draw, or null when the shell draws them.
 */
export function useConsoleDock(): readonly ToolbarItem[] | null {
  const tools = React.useContext(ConsoleToolsContext);
  const wide = useMediaQuery(CONSOLE_DOCK_QUERY);
  const dock = tools?.dock;
  React.useEffect(dockWhenWide.bind(null, dock ?? null, wide), [dock, wide]);
  return tools !== null && wide ? tools.items : null;
}

/**
 * Makes the calling page a canvas page while the window is wide: the page
 * draws the console's tools and a menu with the way home, and the shell
 * draws neither its top bar nor its rail. Returns null when the shell draws
 * them.
 */
export function useCanvasChrome(): CanvasChrome | null {
  const tools = React.useContext(ConsoleToolsContext);
  const wide = useMediaQuery(CONSOLE_DOCK_QUERY);
  const canvas = tools?.canvas;
  React.useEffect(dockWhenWide.bind(null, canvas ?? null, wide), [
    canvas,
    wide,
  ]);
  return tools !== null && wide
    ? { items: tools.items, home: tools.home, search: tools.search }
    : null;
}

function dockWhenWide(
  dock: (() => () => void) | null,
  wide: boolean,
): (() => void) | undefined {
  if (dock === null || !wide) return undefined;
  return dock();
}

function useMediaQuery(query: string): boolean {
  return React.useSyncExternalStore(
    subscribeMedia.bind(null, query),
    mediaMatches.bind(null, query),
    noMatch,
  );
}

function subscribeMedia(query: string, changed: () => void): () => void {
  if (typeof window.matchMedia !== "function") return noop;
  const media = window.matchMedia(query);
  media.addEventListener("change", changed);
  return media.removeEventListener.bind(media, "change", changed);
}

function mediaMatches(query: string): boolean {
  return (
    typeof window.matchMedia === "function" && window.matchMedia(query).matches
  );
}

function noMatch(): boolean {
  return false;
}

function noop(): void {}
