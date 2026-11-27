import React from "react";
import { SpringValue, type Spring } from "./spring";
import "./glide-highlight.css";

type GlideHighlightProps = {
  /** Selector for the item to cover, matched inside the parent element. */
  readonly target: string;
};

// The leading edge rides a stiffer spring than the trailing edge, so the
// highlight stretches toward the next item and settles back to its height.
const leadingEdge: Spring = { duration: 90, bounce: 0 };
const trailingEdge: Spring = { duration: 100, bounce: 0 };
// A highlight that left this recently glides back instead of fading in place.
const reentryWindow = 150;
const menuItem =
  '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

type Box = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

/**
 * One highlight shared by every item in its parent element. Render it as the
 * first child of a menu or list; it follows whichever item matches `target`.
 */
export class GlideHighlight extends React.Component<GlideHighlightProps> {
  private readonly highlight = React.createRef<HTMLSpanElement>();
  private readonly top = new SpringValue(0);
  private readonly bottom = new SpringValue(0);
  private container: HTMLElement | null = null;
  private item: HTMLElement | null = null;
  private hiddenAt = -Infinity;
  private frame = 0;
  private mutations: MutationObserver | null = null;
  private resizes: ResizeObserver | null = null;
  private readonly chooseClick = this.choose.bind(this);
  private chosen: HTMLElement | null = null;

  componentDidMount(): void {
    const container = this.highlight.current?.parentElement ?? null;
    if (container === null) return;
    this.container = container;
    container.dataset.glideHighlight = "true";
    this.mutations = new MutationObserver(this.schedule.bind(this));
    this.mutations.observe(container, {
      subtree: true,
      childList: true,
      attributeFilter: [
        "data-highlighted",
        "data-state",
        "aria-current",
        "class",
      ],
    });
    this.resizes = new ResizeObserver(this.measure.bind(this));
    this.resizes.observe(container);
    container.addEventListener("click", this.chooseClick, true);
    this.update(performance.now());
  }

  componentWillUnmount(): void {
    cancelAnimationFrame(this.frame);
    this.container?.removeEventListener("click", this.chooseClick, true);
    this.mutations?.disconnect();
    this.resizes?.disconnect();
    if (this.container) delete this.container.dataset.glideHighlight;
  }

  // Resize callbacks run after layout, so follow a resizing item this frame.
  private measure(): void {
    cancelAnimationFrame(this.frame);
    this.update(performance.now());
  }

  private schedule(): void {
    if (this.frame === 0)
      this.frame = requestAnimationFrame(this.update.bind(this));
  }

  private update(now: number): void {
    this.frame = 0;
    const container = this.container;
    const highlight = this.highlight.current;
    if (container === null || highlight === null) return;
    // The chosen item keeps the highlight only while its menu is closing.
    if (this.chosen !== null && container.dataset.state !== "closed") {
      this.chosen = null;
      delete highlight.dataset.blink;
    }
    const item =
      this.chosen ?? container.querySelector<HTMLElement>(this.props.target);
    const box = item === null ? null : offsetBox(item, container);
    if (item === null || box === null) {
      if (this.item !== null) {
        this.hiddenAt = now;
        this.resizes?.unobserve(this.item);
      }
      this.item = null;
      highlight.dataset.visible = "false";
      return;
    }
    this.retarget(item, box, now);
    if (item !== this.item) {
      if (this.item !== null) this.resizes?.unobserve(this.item);
      this.resizes?.observe(item);
    }
    this.item = item;
    highlight.dataset.visible = "true";
    highlight.style.width = `${box.width}px`;
    const top = this.top.value(now);
    const bottom = this.bottom.value(now);
    highlight.style.height = `${Math.max(0, bottom - top)}px`;
    highlight.style.translate = `${box.left}px ${top}px`;
    const topMoving = this.top.settle(now);
    const bottomMoving = this.bottom.settle(now);
    if (topMoving || bottomMoving) this.schedule();
  }

  // Marks the clicked menu item so the closing menu blinks its highlight, as
  // macOS menus do, to confirm where the click landed. The click itself runs
  // untouched; a second click on a menu that is already closing is dropped.
  private choose(event: MouseEvent): void {
    const container = this.container;
    const highlight = this.highlight.current;
    const item =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(menuItem)
        : null;
    if (container === null || highlight === null || item === null) return;
    if (container.dataset.state === "closed") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (item.matches("[data-disabled], [aria-disabled='true']")) return;
    this.chosen = item;
    highlight.dataset.blink = "true";
    this.schedule();
  }

  private retarget(item: HTMLElement, box: Box, now: number): void {
    const bottom = box.top + box.height;
    if (box.top === this.top.target && bottom === this.bottom.target) return;
    const container = this.container;
    const reduced =
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      container?.closest('[data-agent-preview-motion="reduced"]') != null;
    const returning =
      this.item !== null || now - this.hiddenAt < reentryWindow;
    // A new item glides; the same item moved by layout follows it directly.
    if (reduced || !returning || item === this.item) {
      this.top.jump(box.top);
      this.bottom.jump(bottom);
      return;
    }
    const factor = motionFactor();
    const lead = slowed(leadingEdge, factor);
    const trail = slowed(trailingEdge, factor);
    const down = box.top > this.top.target;
    this.top.set(box.top, now, down ? trail : lead);
    this.bottom.set(bottom, now, down ? lead : trail);
  }

  render(): React.ReactNode {
    return (
      <span
        ref={this.highlight}
        className="glide-highlight"
        data-visible="false"
        aria-hidden="true"
      />
    );
  }
}

// Layout offsets ignore transforms, so an opening menu that scales in still
// measures in the coordinates the highlight is positioned in.
function offsetBox(item: HTMLElement, container: HTMLElement): Box | null {
  let left = 0;
  let top = 0;
  let node: Element | null = item;
  while (node instanceof HTMLElement && node !== container) {
    left += node.offsetLeft;
    top += node.offsetTop;
    node = node.offsetParent;
  }
  if (node !== container) return null;
  return { left, top, width: item.offsetWidth, height: item.offsetHeight };
}

function motionFactor(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(
    "--agent-motion-factor",
  );
  const factor = Number.parseFloat(value);
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

function slowed(spring: Spring, factor: number): Spring {
  return { duration: spring.duration * factor, bounce: spring.bounce };
}
