import React from "react";
import { X } from "lucide-react";
import {
  cancelDialog,
  closeDialog,
  closeDialogNow,
  isBackdropClick,
  registerSheet,
  showDialog,
  useDialogPresent,
  useHeldWhileClosed,
} from "@purin-labs/ui/dialog";

type ConnectionDialogProps = Readonly<{
  open: boolean;
  title: string;
  /** The provider mark above the title; null for a dialog with none. */
  tile?: React.ReactNode;
  /** One sentence under the title that says what the connection is for. */
  description?: string | null;
  /** A class beside `connection-dialog`, for a sheet that opens from
   * another one. */
  className?: string;
  close: () => void;
  children: React.ReactNode;
}>;

/**
 * The sheet of one connection, built like the consent sheet: compact, as
 * tall as its content, with the provider and its purpose centred above the
 * controls.
 *
 * The sheet moves calmly: it enters once, at its size; it grows or shrinks
 * when its content changes; it fades out when it closes. A sheet that opens
 * inside another sheet takes that sheet's place and grows from its size,
 * and the outer sheet grows back from the inner one when it closes.
 */
export function ConnectionDialog(
  props: ConnectionDialogProps,
): React.ReactNode {
  const ref = React.useRef<HTMLDialogElement>(null);
  const body = React.useRef<HTMLDivElement>(null);
  // A sheet can open from another sheet, so the ids are unique to each one.
  const titleId = React.useId();
  const summaryId = React.useId();
  const [present, setPresent] = useDialogPresent(props.open);
  React.useLayoutEffect(
    syncSheet.bind(null, ref, body, props.open, setPresent),
    [props.open],
  );
  // A closing sheet keeps what it showed until its exit ends.
  const shown = useHeldWhileClosed(props, props.open);
  const description = shown.description ?? null;
  return (
    <dialog
      ref={ref}
      className={
        shown.className === undefined
          ? "connection-dialog"
          : `connection-dialog ${shown.className}`
      }
      aria-labelledby={titleId}
      aria-describedby={description === null ? undefined : summaryId}
      onCancel={cancelDialog.bind(null, props.close)}
      onClick={closeConnectionBackdrop.bind(null, props.close)}
    >
      <button
        type="button"
        className="icon-button connection-dialog-close"
        aria-label={`Close ${shown.title.toLowerCase()}`}
        onClick={props.close}
      >
        <X aria-hidden="true" size={18} />
      </button>
      <div className="connection-dialog-content">
        <div ref={body} className="connection-dialog-body">
          <header className="connection-dialog-head">
            {shown.tile ?? null}
            <h2 id={titleId}>{shown.title}</h2>
            {description === null ? null : <p id={summaryId}>{description}</p>}
          </header>
          {present ? shown.children : null}
        </div>
      </div>
    </dialog>
  );
}

/** How long the sheet keeps one size before it shows. */
const SETTLE_QUIET_MS = 80;
/** A sheet whose content still loads after this shows anyway. */
const SETTLE_LIMIT_MS = 600;
/** The motion of each shown sheet, for the sheet that takes its place. */
const SHEETS = new WeakMap<HTMLDialogElement, SheetMotion>();

function syncSheet(
  ref: React.RefObject<HTMLDialogElement | null>,
  body: React.RefObject<HTMLDivElement | null>,
  open: boolean,
  setPresent: React.Dispatch<React.SetStateAction<boolean>>,
): (() => void) | undefined {
  const dialog = ref.current;
  const content = body.current;
  if (dialog === null || content === null) return;
  if (open) return openSheet(dialog, content);
  if (dialog.open) closeSheet(dialog, setPresent.bind(null, false));
  else setPresent(false);
  return;
}

/**
 * A sheet opens before its panel has its final content: a detail read or a
 * setup read can still change its height. A new sheet stays unseen until its
 * size holds still for a moment, then enters at that size. A sheet that opens
 * inside a shown sheet takes its place at once and grows from its size, so
 * the person sees one sheet change instead of one sheet leave and another
 * arrive.
 */
function openSheet(dialog: HTMLDialogElement, body: HTMLElement): () => void {
  // A sheet that opens again during its exit is still on screen.
  const returning = dialog.open;
  const outer = returning ? null : outerSheet(dialog);
  if (!returning) {
    dialog.dataset.phase = outer === null ? "settling" : "shown";
    if (outer !== null) dialog.dataset.handoff = "";
  }
  showDialog(dialog);
  const motion = new SheetMotion(dialog, body);
  SHEETS.set(dialog, motion);
  const unregister = registerSheet(dialog, motion.returnFrom);
  if (outer !== null) motion.takePlaceOf(outer);
  else if (!returning) motion.settle();
  return (): void => {
    unregister();
    motion.stop();
  };
}

/**
 * The sheet leaves with its exit. An inner sheet that stood in for an outer
 * one leaves at once instead, and the outer sheet grows back from its size.
 * With reduced motion the two cross-fade.
 */
function closeSheet(dialog: HTMLDialogElement, onClosed: () => void): void {
  delete dialog.dataset.handoff;
  const outer = outerSheet(dialog);
  if (outer !== null && !reducedMotion()) {
    const box = dialog.getBoundingClientRect();
    closeDialogNow(dialog, onClosed);
    SHEETS.get(outer)?.returnFrom(box);
    return;
  }
  // A sheet shown inside this one leaves with it.
  for (const inner of dialog.querySelectorAll<HTMLDialogElement>(
    "dialog.connection-dialog[open]",
  ))
    inner.dataset.closing = "";
  closeDialog(dialog, onClosed);
}

/** The shown sheet around this one, which this sheet takes the place of. */
function outerSheet(dialog: HTMLDialogElement): HTMLDialogElement | null {
  const outer = dialog.parentElement?.closest<HTMLDialogElement>(
    "dialog.connection-dialog[open]",
  );
  if (outer === null || outer === undefined) return null;
  return outer.dataset.phase === "shown" && outer.dataset.closing === undefined
    ? outer
    : null;
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type SheetSize = Readonly<{ width: number | null; height: number }>;

/**
 * One open sheet: when it shows, and how it changes height. The height
 * follows the sheet's content through a ResizeObserver, so a change inside
 * any child component resizes the sheet, not only a render of the dialog.
 * The observer runs after layout and before paint, so the new height never
 * shows first. Each resize starts from the height on screen, so a change
 * during a resize turns it smoothly.
 */
class SheetMotion {
  private readonly dialog: HTMLDialogElement;
  private readonly body: HTMLElement;
  private readonly observer: ResizeObserver;
  /** The size the shown sheet last rested at. */
  private height: number | null = null;
  private width: number | null = null;
  private resize: Animation | null = null;
  private quiet = 0;
  private limit = 0;
  private handoff = 0;

  constructor(dialog: HTMLDialogElement, body: HTMLElement) {
    this.dialog = dialog;
    this.body = body;
    this.observer = new ResizeObserver(this.follow);
    this.observer.observe(dialog);
    this.observer.observe(body);
  }

  settle(): void {
    this.quiet = window.setTimeout(this.reveal, SETTLE_QUIET_MS);
    this.limit = window.setTimeout(this.reveal, SETTLE_LIMIT_MS);
  }

  /** Shows the sheet in the place of `outer`, growing from its height. */
  takePlaceOf(outer: HTMLDialogElement): void {
    const height =
      SHEETS.get(outer)?.heightOnScreen() ??
      outer.getBoundingClientRect().height;
    this.dialog.dataset.phase = "shown";
    this.dialog.dataset.handoff = "";
    this.resizeFrom({ width: null, height });
    // The flag only holds back the entrance; the sheet is already in place.
    this.handoff = window.setTimeout(this.endHandoff, 400);
  }

  /**
   * The sheet or screen that stood in for this one has closed: grow back
   * from its box and fade the content in.
   */
  readonly returnFrom = (from: DOMRectReadOnly): void => {
    if (this.dialog.dataset.closing !== undefined) return;
    this.dialog.dataset.returning = "";
    this.resizeFrom({ width: from.width, height: from.height });
    // Lay out the hidden content first, so its return is a transition.
    void this.body.offsetHeight;
    delete this.dialog.dataset.returning;
  };

  /**
   * The height the person sees. New content can already have changed the
   * layout before this sheet's observer starts its resize.
   */
  heightOnScreen(): number {
    return this.resize === null && this.height !== null
      ? this.height
      : this.dialog.getBoundingClientRect().height;
  }

  readonly stop = (): void => {
    this.observer.disconnect();
    window.clearTimeout(this.quiet);
    window.clearTimeout(this.limit);
    window.clearTimeout(this.handoff);
    this.resize?.cancel();
    SHEETS.delete(this.dialog);
  };

  private readonly reveal = (): void => {
    // A sheet that opens inside this one shows first and takes its place,
    // so this sheet does not flash between them.
    if (
      this.dialog.querySelector(
        'dialog.connection-dialog[open][data-phase="settling"]',
      ) !== null
    ) {
      window.clearTimeout(this.quiet);
      this.quiet = window.setTimeout(this.reveal, SETTLE_QUIET_MS);
      return;
    }
    window.clearTimeout(this.quiet);
    window.clearTimeout(this.limit);
    const outer = outerSheet(this.dialog);
    if (outer !== null) {
      this.takePlaceOf(outer);
      return;
    }
    this.dialog.dataset.phase = "shown";
    const box = this.dialog.getBoundingClientRect();
    this.height = box.height;
    this.width = box.width;
  };

  private readonly endHandoff = (): void => {
    delete this.dialog.dataset.handoff;
  };

  private readonly follow = (entries: ResizeObserverEntry[]): void => {
    if (this.dialog.dataset.phase === "settling") {
      window.clearTimeout(this.quiet);
      this.quiet = window.setTimeout(this.reveal, SETTLE_QUIET_MS);
      return;
    }
    if (this.dialog.dataset.closing !== undefined) return;
    if (!entries.some(this.isBody)) {
      // A smaller window, not new content: remember the size, do not move.
      if (this.resize === null) {
        const box = this.dialog.getBoundingClientRect();
        this.height = box.height;
        this.width = box.width;
      }
      return;
    }
    if (this.resize !== null) {
      // A resize already heads for this height, for example when its own
      // overflow change moves a scroll bar or it holds the content's width.
      if (Math.abs(this.naturalHeight() - (this.height ?? 0)) < 1) return;
      const box = this.dialog.getBoundingClientRect();
      this.resizeFrom({ width: box.width, height: box.height });
      return;
    }
    if (this.height === null) {
      this.height = this.naturalHeight();
      this.width = this.dialog.getBoundingClientRect().width;
    } else this.resizeFrom({ width: this.width, height: this.height });
  };

  private readonly isBody = (entry: ResizeObserverEntry): boolean =>
    entry.target === this.body;

  /** The height the sheet takes for its content, within its max-height. */
  private naturalHeight(): number {
    const content = this.body.parentElement;
    const sheet = getComputedStyle(this.dialog);
    const padding =
      content === null
        ? 0
        : Number.parseFloat(getComputedStyle(content).paddingTop) +
          Number.parseFloat(getComputedStyle(content).paddingBottom);
    const height =
      this.body.getBoundingClientRect().height +
      padding +
      Number.parseFloat(sheet.borderTopWidth) +
      Number.parseFloat(sheet.borderBottomWidth);
    const max = Number.parseFloat(sheet.maxHeight);
    return Number.isFinite(max) ? Math.min(height, max) : height;
  }

  /**
   * Grows or shrinks from `from` to the height of the content, and to the
   * sheet's own width when `from` has another width. While the width
   * changes, the content keeps its final width, so its lines do not wrap
   * again on each frame.
   */
  private resizeFrom(from: SheetSize): void {
    this.resize?.cancel();
    this.resize = null;
    this.body.style.removeProperty("width");
    const width = this.dialog.getBoundingClientRect().width;
    const to = this.naturalHeight();
    this.height = to;
    this.width = width;
    const style = getComputedStyle(this.dialog);
    const duration = Number.parseFloat(
      style.getPropertyValue("--pantry-spring-smooth-duration"),
    );
    const widen = from.width !== null && Math.abs(from.width - width) >= 1;
    // Reduced motion sets the duration to zero: the size changes at once and
    // the content fades.
    if ((Math.abs(from.height - to) < 1 && !widen) || !(duration > 0)) {
      delete this.dialog.dataset.resizing;
      return;
    }
    if (widen)
      this.body.style.width = `${this.body.getBoundingClientRect().width}px`;
    const animation = this.dialog.animate(
      widen
        ? [
            { width: `${from.width}px`, height: `${from.height}px` },
            { width: `${width}px`, height: `${to}px` },
          ]
        : [{ height: `${from.height}px` }, { height: `${to}px` }],
      {
        duration,
        easing:
          style.getPropertyValue("--pantry-spring-smooth-ease").trim() ||
          "ease-out",
      },
    );
    this.resize = animation;
    this.dialog.dataset.resizing = "";
    const end = this.endResize.bind(this, animation);
    animation.addEventListener("finish", end);
    animation.addEventListener("cancel", end);
  }

  private endResize(animation: Animation): void {
    if (this.resize !== animation) return;
    this.resize = null;
    this.body.style.removeProperty("width");
    delete this.dialog.dataset.resizing;
  }
}

function closeConnectionBackdrop(
  close: () => void,
  event: React.MouseEvent<HTMLDialogElement>,
): void {
  if (isBackdropClick(event)) close();
}
