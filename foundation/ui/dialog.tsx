/**
 * The console's modal primitives, shared by every feature.
 *
 * These wrap the native `<dialog>` element rather than a custom overlay: the
 * platform already gives us the focus trap, the inert background, and Escape.
 * What it does not give us is focus restoration, so the trigger is remembered
 * on open and refocused on close.
 *
 * A dialog whose CSS fades `[data-closing]` out plays that exit before it
 * closes; any other dialog closes at once.
 */
import React from "react";
import { X } from "lucide-react";

const DIALOG_TRIGGERS = new WeakMap<HTMLDialogElement, HTMLElement>();
/** Stops the exit in progress, so a dialog that opens again stays open. */
const DIALOG_EXITS = new WeakMap<HTMLDialogElement, () => void>();
/** A hidden tab can hold a transition; the dialog closes after this anyway. */
const EXIT_LIMIT_MS = 400;

export function DialogHeading(
  props: Readonly<{ id: string; title: string; close: () => void }>,
): React.ReactNode {
  return (
    <div className="access35-dialog-heading">
      <h2 id={props.id}>{props.title}</h2>
      <button
        type="button"
        className="icon-button"
        aria-label={`Close ${props.title.toLowerCase()}`}
        onClick={props.close}
      >
        <X aria-hidden="true" size={18} />
      </button>
    </div>
  );
}

/**
 * Drives the dialog from React state. Runs only inside an effect, so the
 * document access here never reaches a server render. `onClosed` runs when
 * the dialog has closed, after its exit.
 */
export function syncDialog(
  ref: React.RefObject<HTMLDialogElement | null>,
  open: boolean,
  onClosed?: () => void,
): void {
  const dialog = ref.current;
  if (dialog === null) return;
  if (open) showDialog(dialog);
  else closeDialog(dialog, onClosed);
}

/**
 * True from the render that opens a dialog until its exit ends. The render
 * that closes it still keeps its content, so the exit starts from it.
 */
export function useDialogPresent(
  open: boolean,
): [boolean, React.Dispatch<React.SetStateAction<boolean>>] {
  const [present, setPresent] = React.useState(open);
  if (open && !present) setPresent(true);
  return [open || present, setPresent];
}

/** The value from the last render while `open`: what a closing dialog shows. */
export function useHeldWhileClosed<T>(value: T, open: boolean): T {
  const held = React.useRef(value);
  if (open) held.current = value;
  return open ? value : held.current;
}

/**
 * Opens the dialog as a modal. A dialog in its exit stays open instead.
 * `trigger` replaces the focused control as the one that gets focus back,
 * for a dialog that opens again from a toast that `hideDialog` left.
 */
export function showDialog(
  dialog: HTMLDialogElement,
  trigger: HTMLElement | null = null,
): void {
  const exit = DIALOG_EXITS.get(dialog);
  if (exit !== undefined) {
    exit();
    return;
  }
  if (dialog.open) return;
  const focused = trigger ?? document.activeElement;
  if (focused instanceof HTMLElement) DIALOG_TRIGGERS.set(dialog, focused);
  dialog.showModal();
  // showModal focuses the first control, usually the close button, and
  // browsers draw its focus ring. Start on the dialog itself unless a child
  // asks for focus; Tab still reaches the first control.
  if (dialog.querySelector("[autofocus]") === null) {
    dialog.tabIndex = -1;
    dialog.focus({ preventScroll: true });
  }
}

/**
 * Plays the dialog's exit, then closes it and returns focus to the control
 * that opened it. The exit is the opacity transition that `[data-closing]`
 * starts; without one, the dialog closes at once.
 */
export function closeDialog(
  dialog: HTMLDialogElement,
  onClosed?: () => void,
): void {
  if (!dialog.open || DIALOG_EXITS.has(dialog)) return;
  dialog.dataset.closing = "";
  const exits = dialog.getAnimations().filter(isFadeTransition);
  if (exits.length === 0) {
    closeDialogNow(dialog, onClosed);
    return;
  }
  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    window.clearTimeout(limit);
    DIALOG_EXITS.delete(dialog);
    closeDialogNow(dialog, onClosed);
  };
  const limit = window.setTimeout(finish, EXIT_LIMIT_MS);
  DIALOG_EXITS.set(dialog, () => {
    settled = true;
    window.clearTimeout(limit);
    DIALOG_EXITS.delete(dialog);
    delete dialog.dataset.closing;
  });
  // A dialog that opens again cancels the transition; that is not a close.
  void Promise.all(exits.map(finishedAnimation)).then(finish, noop);
}

/** Closes the dialog without its exit and returns focus to its trigger. */
export function closeDialogNow(
  dialog: HTMLDialogElement,
  onClosed?: () => void,
): void {
  DIALOG_EXITS.get(dialog)?.();
  delete dialog.dataset.closing;
  if (dialog.open) dialog.close();
  const trigger = DIALOG_TRIGGERS.get(dialog);
  DIALOG_TRIGGERS.delete(dialog);
  if (trigger?.isConnected) trigger.focus();
  onClosed?.();
}

/**
 * Closes the dialog at once and keeps focus where the caller puts it, such as
 * on the toast that the dialog minimizes into. Returns the control that
 * opened the dialog, for `showDialog` when the dialog opens again.
 */
export function hideDialog(dialog: HTMLDialogElement): HTMLElement | null {
  DIALOG_EXITS.get(dialog)?.();
  delete dialog.dataset.closing;
  if (dialog.open) dialog.close();
  const trigger = DIALOG_TRIGGERS.get(dialog) ?? null;
  DIALOG_TRIGGERS.delete(dialog);
  return trigger;
}

function isFadeTransition(animation: Animation): boolean {
  return (
    animation instanceof CSSTransition &&
    animation.transitionProperty === "opacity"
  );
}

function finishedAnimation(animation: Animation): Promise<Animation> {
  return animation.finished;
}

function noop(): void {}

/**
 * Sheets that a sign-in screen can stand in for. A screen that opens over a
 * shown sheet takes its place and grows from its size; when the screen
 * closes, the sheet grows back from the screen's card.
 */
const SHEET_RETURNS = new Map<
  HTMLDialogElement,
  (from: DOMRectReadOnly) => void
>();

/** Registers an open sheet and how it grows back; returns the unregister. */
export function registerSheet(
  dialog: HTMLDialogElement,
  growBack: (from: DOMRectReadOnly) => void,
): () => void {
  SHEET_RETURNS.set(dialog, growBack);
  return (): void => {
    if (SHEET_RETURNS.get(dialog) === growBack) SHEET_RETURNS.delete(dialog);
  };
}

/** The sheet the person sees now, last opened first; null when none shows. */
export function shownSheet(): HTMLDialogElement | null {
  let shown: HTMLDialogElement | null = null;
  for (const dialog of SHEET_RETURNS.keys())
    if (
      dialog.open &&
      dialog.dataset.closing === undefined &&
      getComputedStyle(dialog).visibility === "visible"
    )
      shown = dialog;
  return shown;
}

/** The sheet shows again in place of a closed screen: it grows from `from`. */
export function returnToSheet(
  dialog: HTMLDialogElement,
  from: DOMRectReadOnly,
): void {
  SHEET_RETURNS.get(dialog)?.(from);
}

/** Escape and the backdrop close through React state, not the DOM default. */
export function cancelDialog(
  close: () => void,
  event: React.SyntheticEvent<HTMLDialogElement>,
): void {
  event.preventDefault();
  event.stopPropagation();
  close();
}

/** True when a click on a modal dialog fell on its backdrop, outside its box. */
export function isBackdropClick(
  event: React.MouseEvent<HTMLDialogElement>,
): boolean {
  if (event.target !== event.currentTarget) return false;
  const bounds = event.currentTarget.getBoundingClientRect();
  return (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  );
}
