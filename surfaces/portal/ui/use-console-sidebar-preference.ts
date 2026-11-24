import { moveStoredValue } from "@purin-labs/std";
import React from "react";

const CONSOLE_SIDEBAR_STORAGE_KEY = "pantry:sidebar-expanded";
// The key before the product names changed; its value moves one time.
const RENAMED_CONSOLE_SIDEBAR_STORAGE_KEY = "pantry:cafeos:sidebar-expanded";

type ConsoleSidebarPreference = {
  readonly railExpanded: boolean;
  readonly toggleRail: () => void;
};

function readRailExpanded(): boolean {
  if (typeof window === "undefined") return true;
  try {
    moveStoredValue(
      window.localStorage,
      RENAMED_CONSOLE_SIDEBAR_STORAGE_KEY,
      CONSOLE_SIDEBAR_STORAGE_KEY,
    );
    return window.localStorage.getItem(CONSOLE_SIDEBAR_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeRailExpanded(railExpanded: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CONSOLE_SIDEBAR_STORAGE_KEY,
      String(railExpanded),
    );
  } catch {
    return;
  }
}

function invertBoolean(current: boolean): boolean {
  return !current;
}

export function useConsoleSidebarPreference(): ConsoleSidebarPreference {
  const [railExpanded, setRailExpanded] = React.useState(readRailExpanded);
  React.useEffect(writeRailExpanded.bind(null, railExpanded), [railExpanded]);
  const toggleRail = React.useCallback(
    setRailExpanded.bind(null, invertBoolean),
    [],
  );
  return { railExpanded, toggleRail };
}
