// A rail collapse or expand resizes every 3D view in the page. Resizing a
// WebGL view while the layout moves drops frames, so the 3D views fade out
// first, hold still while the layout moves, and fade in once it has settled.
// Every other element moves with the layout as usual. The phase is an
// attribute on the root element: "out" (fading out), "moving" (hidden while
// the layout moves), "ready" (hidden, layout settled: the views resize now) and
// "in" (fading back in over a finished resize). The attribute is absent at rest.
export const LAYOUT_MOTION_ATTRIBUTE = "data-layout-motion";
export const LAYOUT_MOTION_FADE_MS = 50;
const LAYOUT_MOTION_SETTLE_MS = 230;
const LAYOUT_MOTION_RESIZE_MS = 40;
const LAYOUT_MOTION_FADE_IN_MS = 90;

let timers: number[] = [];

export function layoutMotionActive(): boolean {
  const phase = document.documentElement.getAttribute(LAYOUT_MOTION_ATTRIBUTE);
  return phase === "out" || phase === "moving";
}

export function layoutMotionResizing(): boolean {
  return (
    document.documentElement.getAttribute(LAYOUT_MOTION_ATTRIBUTE) === "ready"
  );
}

function setPhase(phase: "out" | "moving" | "ready" | "in" | null): void {
  const root = document.documentElement;
  if (phase === null) root.removeAttribute(LAYOUT_MOTION_ATTRIBUTE);
  else root.setAttribute(LAYOUT_MOTION_ATTRIBUTE, phase);
}

// `change` runs once the views have faded out. A layout that another part of
// the page already moves passes no change; its views then fade out as it starts.
export function runLayoutMotion(change?: () => void): void {
  if (
    typeof window === "undefined" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    change?.();
    return;
  }
  for (const timer of timers) window.clearTimeout(timer);
  setPhase("out");
  timers = [
    window.setTimeout(() => {
      setPhase("moving");
      change?.();
    }, LAYOUT_MOTION_FADE_MS),
    window.setTimeout(
      setPhase.bind(null, "ready"),
      LAYOUT_MOTION_FADE_MS + LAYOUT_MOTION_SETTLE_MS,
    ),
    window.setTimeout(
      setPhase.bind(null, "in"),
      LAYOUT_MOTION_FADE_MS + LAYOUT_MOTION_SETTLE_MS + LAYOUT_MOTION_RESIZE_MS,
    ),
    window.setTimeout(
      setPhase.bind(null, null),
      LAYOUT_MOTION_FADE_MS +
        LAYOUT_MOTION_SETTLE_MS +
        LAYOUT_MOTION_RESIZE_MS +
        LAYOUT_MOTION_FADE_IN_MS,
    ),
  ];
}
