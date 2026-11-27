/**
 * A shared layout morph: two elements that show one thing, such as a modal
 * card and the toast that it minimizes into, become one surface that moves
 * and resizes from the first box to the second. This is the FLIP technique
 * (First, Last, Invert, Play): the caller lays out both ends, and the morph
 * plays the change between them.
 *
 * Neither element moves. A surface in the top layer, above a modal dialog,
 * takes the first box and animates its position, size and corner radius to
 * the second. A copy of the old content fades out with a 4px blur while a
 * copy of the new content fades in from one, and both copies scale with the
 * surface, so the change reads as one card. The caller hides both ends while
 * the surface plays and shows the second end when the promise settles. The
 * surface takes no pointer or focus, and screen readers skip it.
 *
 * The dimmed page behind a modal can fade out or in with the move. With
 * reduced motion the caller does not morph; `prefersReducedMotion` tells it
 * to fade instead.
 */
import "./layout-morph.css";

export type MorphEnd = Readonly<{
  rect: DOMRectReadOnly;
  /** The end's corner radius, such as "24px". */
  radius: string;
  /** The element whose look the surface shows at this end; it is copied. */
  content: HTMLElement;
  /** Classes for the copy's wrapper, for content styled by its ancestor. */
  context?: string;
}>;

/** A hidden tab can hold the animations; the morph ends after this anyway. */
const SETTLE_MARGIN_MS = 250;

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A morph that shows its first end and waits for `play`. */
type LayoutMorph = Readonly<{
  /** Moves to `to`, then removes the surface. */
  play: (to: MorphEnd) => Promise<void>;
  /** Removes the surface at once. */
  cancel: () => void;
}>;

/**
 * Shows a copy of the first end in the top layer at once, so that the caller
 * can hide that end and lay out the second end with no empty frame between.
 */
export function holdLayoutMorph(
  from: MorphEnd,
  backdropFade: "in" | "out" | null,
): LayoutMorph {
  const root = document.createElement("div");
  root.className = "layout-morph";
  root.setAttribute("aria-hidden", "true");
  root.inert = true;
  const topLayer = typeof root.showPopover === "function";
  if (topLayer) root.setAttribute("popover", "manual");
  let backdrop: HTMLDivElement | null = null;
  if (backdropFade !== null) {
    backdrop = document.createElement("div");
    backdrop.className = "layout-morph-backdrop";
    if (backdropFade === "in") backdrop.style.opacity = "0";
    root.append(backdrop);
  }
  const surface = document.createElement("div");
  surface.className = "layout-morph-surface";
  Object.assign(surface.style, boxStyle(from));
  const outgoing = layer(from);
  surface.append(outgoing);
  root.append(surface);
  document.body.append(root);
  if (topLayer) root.showPopover();

  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    if (topLayer && root.matches(":popover-open")) root.hidePopover();
    root.remove();
  };
  const play = (to: MorphEnd): Promise<void> => {
    if (removed) return Promise.resolve();
    // A modal that opened after the surface sits above it; show the
    // surface again to put it on top.
    if (topLayer) {
      root.hidePopover();
      root.showPopover();
    }
    const timing = morphTiming();
    const incoming = layer(to);
    surface.append(incoming);
    const move = { duration: timing.duration, easing: timing.easing };
    const animations: Animation[] = [
      surface.animate([boxStyle(from), boxStyle(to)], {
        ...move,
        fill: "both",
      }),
      // Each copy keeps its own width and scales with the surface, so its
      // text does not wrap again on each frame.
      outgoing.animate(
        [
          { transform: "scale(1)" },
          { transform: `scale(${to.rect.width / from.rect.width})` },
        ],
        { ...move, fill: "both" },
      ),
      incoming.animate(
        [
          { transform: `scale(${from.rect.width / to.rect.width})` },
          { transform: "scale(1)" },
        ],
        { ...move, fill: "both" },
      ),
      outgoing.animate(
        [
          { opacity: 1, filter: "blur(0px)" },
          { opacity: 0, filter: "blur(4px)" },
        ],
        { duration: timing.duration * 0.55, easing: "ease-out", fill: "both" },
      ),
      incoming.animate(
        [
          { opacity: 0, filter: "blur(4px)" },
          { opacity: 1, filter: "blur(0px)" },
        ],
        {
          duration: timing.duration * 0.6,
          delay: timing.duration * 0.3,
          easing: "ease-out",
          fill: "both",
        },
      ),
    ];
    if (backdrop !== null)
      animations.push(
        backdrop.animate(
          backdropFade === "in"
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [{ opacity: 1 }, { opacity: 0 }],
          { duration: timing.duration * 0.8, easing: "ease-out", fill: "both" },
        ),
      );
    return new Promise((resolve) => {
      const finish = (): void => {
        window.clearTimeout(limit);
        remove();
        resolve();
      };
      const limit = window.setTimeout(
        finish,
        timing.duration + SETTLE_MARGIN_MS,
      );
      void Promise.all(animations.map(finished)).then(finish, finish);
    });
  };
  return { play, cancel: remove };
}

function boxStyle(end: MorphEnd): Keyframe & Partial<CSSStyleDeclaration> {
  return {
    left: `${end.rect.left}px`,
    top: `${end.rect.top}px`,
    width: `${end.rect.width}px`,
    height: `${end.rect.height}px`,
    borderRadius: end.radius,
  };
}

/** A copy of one end's content at that end's width, anchored top left. */
function layer(end: MorphEnd): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className =
    end.context === undefined
      ? "layout-morph-layer"
      : `layout-morph-layer ${end.context}`;
  wrapper.style.width = `${end.rect.width}px`;
  const copy = end.content.cloneNode(true) as HTMLElement;
  // The copy must not take the ids that labels and descriptions point to.
  copy.removeAttribute("id");
  for (const element of copy.querySelectorAll("[id]"))
    element.removeAttribute("id");
  copy.style.width = `${end.rect.width}px`;
  wrapper.append(copy);
  return wrapper;
}

/** The glide spring of the Portal theme, as CSS publishes it. */
function morphTiming(): Readonly<{ duration: number; easing: string }> {
  const style = getComputedStyle(document.documentElement);
  const duration = Number.parseFloat(
    style.getPropertyValue("--pantry-spring-glide-duration"),
  );
  const easing = style.getPropertyValue("--pantry-spring-glide-ease").trim();
  return {
    duration: duration > 0 ? duration : 390,
    easing: easing.length > 0 ? easing : "cubic-bezier(0.2, 0.9, 0.3, 1)",
  };
}

function finished(animation: Animation): Promise<Animation> {
  return animation.finished;
}
