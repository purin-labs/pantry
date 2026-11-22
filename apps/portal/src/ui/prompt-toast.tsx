/**
 * The toast that a minimized permission prompt becomes. It shows in the
 * Portal's one toast stack (Sonner, mounted by the shell at the bottom
 * right), so prompts and other notices stack together, and several prompts
 * stack as several toasts.
 *
 * A toast has one of five tones: `waiting` for a prompt that waits for the
 * person, `loading` while Pantry saves the decision, then `success`,
 * `denied` or `failure`. While its prompt exists, the whole toast is a button that opens
 * the prompt again. Sonner's region is a polite live region, so each change
 * of tone is announced. A waiting or loading toast cannot be swiped away,
 * because it is the only way back to its prompt; a settled one closes by
 * itself.
 */
import React from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  KeyRound,
  LoaderCircle,
  Maximize2,
} from "lucide-react";
import { toast } from "sonner";
import { assertNever } from "@purin-labs/std";
import "./prompt-toast.css";

type PromptToastTone = "waiting" | "loading" | "success" | "denied" | "failure";

export type PromptToastView = Readonly<{
  tone: PromptToastTone;
  title: string;
  message: string | null;
}>;

export type PromptToastOptions = Readonly<{
  /** Opens the prompt again; null when the prompt is gone. */
  onOpen: (() => void) | null;
  /** True while a layout morph draws the toast in its place. */
  hidden: boolean;
  /** Gets focus when the toast closes while focus is inside it. */
  returnFocus: HTMLElement | null;
  /** Runs when a settled toast closes by itself or by a swipe. */
  onSettledClose: (() => void) | null;
}>;

/** How long a settled toast stays, as Sonner's default. */
const SETTLED_MS = 5000;

/** Shows the toast, or changes it in place when one with `id` shows. */
export function showPromptToast(
  id: string,
  view: PromptToastView,
  options: PromptToastOptions,
): void {
  const settled =
    view.tone === "success" ||
    view.tone === "denied" ||
    (view.tone === "failure" && options.onOpen === null);
  const closed = (): void => {
    restoreFocus(id, options.returnFocus);
    if (settled) options.onSettledClose?.();
  };
  toast.custom(
    () => (
      <PromptToast
        id={id}
        view={view}
        onOpen={options.onOpen}
        hidden={options.hidden}
      />
    ),
    {
      id,
      duration: settled ? SETTLED_MS : Infinity,
      dismissible: settled,
      className: "prompt-toast-host",
      // The shell styles every toast as a card; this toast draws its own.
      style: HOST_STYLE,
      onDismiss: closed,
      onAutoClose: closed,
    },
  );
}

/** Removes the toast at once, for a prompt that opens in its place. */
export function dismissPromptToast(id: string): void {
  const host = promptToastHost(id);
  // The modal takes the toast's place now, so its exit must not show.
  if (host !== null) host.style.opacity = "0";
  toast.dismiss(id);
}

/** The toast's card once Sonner has laid it out at its place in the stack. */
export async function promptToastCard(id: string): Promise<HTMLElement | null> {
  for (let frame = 0; frame < 30; frame += 1) {
    await nextFrame();
    const host = promptToastHost(id);
    const card = host?.querySelector<HTMLElement>(".prompt-toast") ?? null;
    if (host !== null && card !== null && host.dataset.mounted === "true") {
      // Sonner slides a new toast up from the edge; the morph lands on its
      // final place instead.
      host.dataset.promptPlaced = "";
      return card;
    }
  }
  return null;
}

/** Shows a toast that `hidden` drew invisible, without waiting for React. */
export function revealPromptToast(card: HTMLElement): void {
  delete card.dataset.hidden;
  const host = card.closest<HTMLElement>("[data-sonner-toast]");
  if (host !== null) delete host.dataset.promptPlaced;
}

/** The control that opens the prompt, for focus. */
export function promptToastControl(card: HTMLElement): HTMLElement | null {
  return card.querySelector<HTMLElement>("button.prompt-toast-body");
}

const HOST_STYLE: React.CSSProperties = {
  background: "transparent",
  border: 0,
  boxShadow: "none",
  padding: 0,
};

function PromptToast(
  props: Readonly<{
    id: string;
    view: PromptToastView;
    onOpen: (() => void) | null;
    hidden: boolean;
  }>,
): React.ReactNode {
  const { view } = props;
  const body = (
    <>
      <span
        key={`icon-${view.tone}`}
        className="prompt-toast-icon"
        aria-hidden="true"
      >
        <ToneIcon tone={view.tone} />
      </span>
      <span key={`copy-${view.tone}`} className="prompt-toast-copy">
        <span className="prompt-toast-title">{view.title}</span>
        {view.message === null ? null : (
          <span className="prompt-toast-message">{view.message}</span>
        )}
      </span>
      {props.onOpen === null ? null : (
        <>
          <span className="prompt-toast-open" aria-hidden="true">
            <Maximize2 size={14} />
          </span>
          <span className="visually-hidden"> Open the request.</span>
        </>
      )}
    </>
  );
  return (
    <div
      className="prompt-toast"
      data-prompt-toast={props.id}
      data-tone={view.tone}
      data-hidden={props.hidden ? "" : undefined}
      aria-busy={view.tone === "loading"}
    >
      {props.onOpen === null ? (
        <div className="prompt-toast-body">{body}</div>
      ) : (
        <button
          type="button"
          className="prompt-toast-body"
          onClick={props.onOpen}
        >
          {body}
        </button>
      )}
    </div>
  );
}

function ToneIcon(props: Readonly<{ tone: PromptToastTone }>): React.ReactNode {
  switch (props.tone) {
    case "waiting":
      return <KeyRound size={16} />;
    case "loading":
      return <LoaderCircle size={16} className="prompt-toast-spin" />;
    case "success":
      return <CircleCheck size={16} />;
    case "denied":
      return <CircleX size={16} />;
    case "failure":
      return <CircleAlert size={16} />;
    default:
      return assertNever(props.tone, "Unknown prompt toast tone");
  }
}

/** The toast's card in the stack, never a morph's copy of it. */
export function promptToastElement(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-sonner-toast] [data-prompt-toast="${CSS.escape(id)}"]`,
  );
}

function promptToastHost(id: string): HTMLElement | null {
  return (
    promptToastElement(id)?.closest<HTMLElement>("[data-sonner-toast]") ?? null
  );
}

function restoreFocus(id: string, target: HTMLElement | null): void {
  if (target === null || !target.isConnected) return;
  const active = document.activeElement;
  const inside =
    active === null ||
    active === document.body ||
    promptToastHost(id)?.contains(active) === true;
  if (inside) target.focus({ preventScroll: true });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
