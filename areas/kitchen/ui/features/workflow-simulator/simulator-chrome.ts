import type { SimulatorDock as Dock } from "./simulator-state";

// The simulator's chrome outside React: the remembered dock, the targets of
// keyboard shortcuts and where focus goes when the chrome hides or shows.

export function focusElement(element: HTMLElement | null): void {
  element?.focus();
}

export function readDock(): Dock {
  try {
    const value = localStorage.getItem("bakery-dock");
    switch (value) {
      case "workflow":
      case "inputs":
      case "inspector":
      case "timeline":
      case "scenarios":
      case "comparison":
      case "floorPlan":
        return value;
      default:
        return "closed";
    }
  } catch {
    return "closed";
  }
}

export function undoRedoTarget(target: EventTarget | null): boolean {
  const simulator = document.querySelector(".workflow-simulator");
  if (simulator === null || simulator.closest("[hidden]") !== null)
    return false;
  const isEditable = (el: Element | null): boolean => {
    if (el === null) return false;
    if (el instanceof HTMLElement && el.isContentEditable) return true;
    return (
      el.closest("input, textarea, select, [contenteditable='true']") !== null
    );
  };
  if (target instanceof Element && isEditable(target)) return false;
  if (isEditable(document.activeElement)) return false;
  return true;
}

/**
 * Shortcuts apply inside the simulator or on a container around it (clicking
 * the canvas focuses the page's main region), never while typing.
 */
export function shortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const simulator = document.querySelector(".workflow-simulator");
  if (
    simulator === null ||
    simulator.closest("[hidden]") !== null ||
    !(simulator.contains(target) || target.contains(simulator))
  )
    return false;
  return (
    !target.isContentEditable &&
    target.closest(
      "input, textarea, select, [role='menu'], [role='dialog'], [role='listbox'], [role='combobox']",
    ) === null
  );
}

export function focusChromeRestore(): void {
  const active = document.activeElement;
  if (
    active === null ||
    active === document.body ||
    active.closest(
      ".workflow-topbar, .workflow-stage, .workflow-scene-controls",
    )
  )
    document.getElementById("workflow-chrome-restore")?.focus();
}

export function focusRevealedChrome(): void {
  if (document.activeElement === document.body)
    document.getElementById("workflow-more")?.focus();
}

export function rememberDock(dock: Dock): void {
  try {
    localStorage.setItem("bakery-dock", dock);
  } catch {
    /* The workspace remains usable when storage is unavailable. */
  }
}
