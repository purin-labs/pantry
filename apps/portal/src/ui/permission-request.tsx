import { Select } from "./select";
import React from "react";
import { flushSync } from "react-dom";
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  Info,
  LoaderCircle,
  Minus,
  X,
} from "lucide-react";
import { assertNever } from "@seams/std";
import {
  cancelDialog,
  closeDialog,
  closeDialogNow,
  hideDialog,
  returnToSheet,
  shownSheet,
  showDialog,
  useDialogPresent,
  useHeldWhileClosed,
} from "../dialog";
import {
  holdLayoutMorph,
  prefersReducedMotion,
  type MorphEnd,
} from "./layout-morph";
import {
  dismissPromptToast,
  promptToastCard,
  promptToastControl,
  promptToastElement,
  revealPromptToast,
  showPromptToast,
  type PromptToastView,
} from "./prompt-toast";
import "./permission-request.css";

export type PermissionRequestParty = {
  readonly name: string;
  /** Decorative avatar content; the title names both parties. */
  readonly icon: React.ReactNode;
};

export type PermissionRequestItem = {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly required: boolean;
};

export type PermissionRequestScopeOption = {
  readonly id: string;
  readonly label: string;
  readonly icon?: React.ReactNode;
};

export type PermissionRequestScope = {
  readonly label: string;
  readonly options: readonly PermissionRequestScopeOption[];
  readonly value: string;
  readonly onChange: (id: string) => void;
};

export type PermissionRequestAction = {
  readonly label: string;
  readonly onSelect: () => void;
};

/** The person who decides, shown as a chip under the question. */
export type PermissionRequestAccount = {
  readonly name: string;
  /** Opens an account switcher; null shows the chip without a menu mark. */
  readonly action: PermissionRequestAction | null;
};

export type PermissionRequestDecision =
  | {
      readonly kind: "grant";
      readonly allowLabel?: string;
      readonly denyLabel?: string;
      readonly pending: "allow" | "deny" | null;
      readonly error: string | null;
      /**
       * Receives the selection with every required item included. The
       * dialog minimizes into its toast at once, and the toast shows the
       * loading state until the promise settles: true for success, false
       * when the caller shows an error.
       */
      readonly onAllow: (selectedIds: readonly string[]) => Promise<boolean>;
      readonly onDeny: () => void;
    }
  | {
      readonly kind: "explain";
      /** Who must allow the request, shown in place of Allow and Deny. */
      readonly message: React.ReactNode;
      readonly pending: "primary" | "secondary" | null;
      readonly error: string | null;
      readonly primary: PermissionRequestAction | null;
      readonly secondary: PermissionRequestAction | null;
    }
  | {
      /** The answer after a decision: the dialog resizes to a short card. */
      readonly kind: "result";
      readonly tone: "allowed" | "denied";
      readonly title: string;
      readonly message: React.ReactNode;
      readonly pending: "primary" | "secondary" | null;
      readonly error: string | null;
      readonly primary: PermissionRequestAction;
      readonly secondary: PermissionRequestAction | null;
    };

type ResultDecision = Extract<PermissionRequestDecision, { kind: "result" }>;

export type PermissionRequestCardProps = {
  readonly requester: PermissionRequestParty;
  readonly target: PermissionRequestParty;
  readonly title: string;
  readonly subtitle: React.ReactNode | null;
  readonly scope: PermissionRequestScope | null;
  /** The list header, such as "This will allow Pantry agent to:". */
  readonly listHeading: string;
  readonly items: readonly PermissionRequestItem[];
  /** Required items are always included, whatever this contains. */
  readonly selectedIds: readonly string[];
  readonly onSelectionChange: (ids: readonly string[]) => void;
  readonly decision: PermissionRequestDecision;
  readonly footnote: React.ReactNode | null;
  readonly signedInAs: PermissionRequestAccount | null;
};

/**
 * Both are modal cards over the dimmed page. `compact` is a narrow sheet for a
 * short request; `split` is a wide card with the permissions in their own
 * column.
 */
export type AuthorizationLayout = "compact" | "split";

/** A decided request shows the short result card in either layout. */
type DialogLayout = AuthorizationLayout | "result";

export type PermissionRequestDialogProps = PermissionRequestCardProps & {
  /** By default, three items or fewer without a scope choice are compact. */
  readonly layout?: AuthorizationLayout;
  readonly open: boolean;
  /** Called for Escape and for a click on the backdrop. */
  readonly onClose: () => void;
};

type ContentIds = {
  readonly title: string;
  readonly subtitle: string;
  readonly list: string;
  readonly error: string;
};

/**
 * The consent card alone, for inline use such as a chat timeline. It stacks
 * its parts in one narrow column.
 */
export function PermissionRequestCard(
  props: PermissionRequestCardProps,
): React.ReactNode {
  const ids = useContentIds();
  const decision = props.decision;
  return (
    <section
      className="permission-request"
      data-layout="stacked"
      aria-labelledby={ids.title}
      aria-describedby={
        decision.kind === "result" || props.subtitle !== null
          ? ids.subtitle
          : undefined
      }
    >
      {decision.kind === "result" ? (
        <ResultView ids={ids} heading="h3" decision={decision} />
      ) : (
        <PermissionRequestContent
          {...props}
          ids={ids}
          heading="h3"
          layout="stacked"
        />
      )}
    </section>
  );
}

/**
 * The consent card as an authorization screen in a modal `<dialog>` over the
 * dimmed page. A short request is a compact sheet. A longer one is a wide
 * split card: the requester, the question and the decision on the left, the
 * permissions on the right. A `result` decision resizes the card to a short
 * answer. Escape and the close button call `onClose`. A click outside the
 * card does not, because a decision on a consent screen is always an
 * explicit button.
 *
 * The person can minimize the prompt into a toast at the bottom right, and
 * Allow minimizes it by itself: the card moves and resizes into the toast
 * with a shared layout morph, so the page stays usable while Pantry saves the
 * decision. The toast shows the loading state, then the success or the
 * failure. A click on the toast grows it back into the modal. With reduced
 * motion the card and the toast fade instead.
 */
export function PermissionRequestDialog(
  props: PermissionRequestDialogProps,
): React.ReactNode {
  const { open, onClose, layout, ...rest } = props;
  const ids = useContentIds();
  const minimizer = useMinimizablePrompt(
    rest.title,
    rest.decision,
    open,
    onClose,
  );
  const card = { ...rest, decision: minimizer.decision };
  const chosen =
    layout ??
    (card.scope === null && card.items.length <= 3 ? "compact" : "split");
  const decision = card.decision;
  return (
    <AuthorizationDialog
      open={open && !minimizer.minimized}
      onClose={onClose}
      ids={ids}
      hasSubtitle={decision.kind === "result" || card.subtitle !== null}
      className={null}
      layout={decision.kind === "result" ? "result" : chosen}
      minimizer={minimizer}
    >
      {decision.kind === "result" ? (
        <ResultView ids={ids} heading="h2" decision={decision} />
      ) : (
        <PermissionRequestContent
          {...card}
          ids={ids}
          heading="h2"
          layout={chosen}
        />
      )}
    </AuthorizationDialog>
  );
}

/** What `AuthorizationDialog` needs from a prompt that can minimize. */
type Minimizer = Readonly<{
  minimized: boolean;
  minimize: () => void;
  dialog: React.RefObject<HTMLDialogElement | null>;
  card: React.RefObject<HTMLDivElement | null>;
  reopenTrigger: React.RefObject<HTMLElement | null>;
  /** The caller's decision, with Allow minimizing the prompt first. */
  decision: PermissionRequestDecision;
}>;

/** What became of the last Allow. */
type AllowOutcome = "idle" | "working" | "succeeded" | "failed";

/** The toast's corner radius, as prompt-toast.css draws it. */
const TOAST_RADIUS = "14px";

function useMinimizablePrompt(
  title: string,
  decision: PermissionRequestDecision,
  open: boolean,
  onClose: () => void,
): Minimizer {
  const toastId = `permission-prompt${React.useId()}`;
  const [minimized, setMinimized] = React.useState(false);
  const [outcome, setOutcome] = React.useState<AllowOutcome>("idle");
  const controller = React.useRef<PromptMinimizer | null>(null);
  controller.current ??= new PromptMinimizer(toastId, setMinimized, setOutcome);
  const prompt = controller.current;
  prompt.title = title;
  prompt.decision = decision;
  prompt.onClose = onClose;
  const view = promptToastViewOf(title, decision, outcome);
  React.useEffect(() => {
    prompt.mounted = true;
    return () => prompt.unmount();
  }, [prompt]);
  React.useEffect(() => {
    if (minimized) prompt.showToast();
  }, [prompt, minimized, outcome, view.tone, view.title, view.message]);
  React.useEffect(() => {
    if (!open) prompt.closedByCaller();
  }, [prompt, open]);
  return {
    minimized,
    minimize: prompt.minimize,
    dialog: prompt.dialog,
    card: prompt.card,
    reopenTrigger: prompt.reopenTrigger,
    decision:
      decision.kind === "grant"
        ? { ...decision, onAllow: prompt.allow.bind(prompt, decision.onAllow) }
        : decision,
  };
}

/**
 * The minimize and maximize of one prompt. It lives as long as the prompt's
 * component and reads the latest props from the fields that each render
 * sets, so the toast's callbacks stay the same.
 */
class PromptMinimizer {
  readonly dialog: React.RefObject<HTMLDialogElement | null> = {
    current: null,
  };
  readonly card: React.RefObject<HTMLDivElement | null> = { current: null };
  readonly reopenTrigger: React.RefObject<HTMLElement | null> = {
    current: null,
  };
  title = "";
  decision: PermissionRequestDecision | null = null;
  onClose: () => void = noop;
  mounted = true;
  minimized = false;
  outcome: AllowOutcome = "idle";
  /** True while a morph or a fade moves between the card and the toast. */
  private moving = false;
  /** True while the morph draws the toast in its place. */
  private hidden = false;
  /** The control that opened the prompt; it gets focus back at the end. */
  private trigger: HTMLElement | null = null;

  constructor(
    readonly toastId: string,
    private readonly setMinimized: (minimized: boolean) => void,
    private readonly setOutcome: (outcome: AllowOutcome) => void,
  ) {}

  /** Allow minimizes the prompt while the caller saves the decision. */
  allow(
    onAllow: (selectedIds: readonly string[]) => Promise<boolean>,
    selectedIds: readonly string[],
  ): Promise<boolean> {
    // The caller runs first, inside the click, for work that needs a user
    // gesture such as starting speech.
    const result = onAllow(selectedIds);
    this.outcome = "working";
    this.setOutcome("working");
    this.minimize();
    void result.then(this.settle.bind(this), this.settle.bind(this, false));
    return result;
  }

  readonly minimize = (): void => {
    void this.minimizeIntoToast();
  };

  readonly maximize = (): void => {
    if (!this.minimized || this.moving || !this.mounted) return;
    const dialog = this.dialog.current;
    if (dialog === null) return;
    const toastCard = promptToastElement(this.toastId);
    const morph =
      toastCard === null || prefersReducedMotion()
        ? null
        : holdLayoutMorph(toastEnd(toastCard), null);
    this.moving = true;
    dismissPromptToast(this.toastId);
    // The card stays invisible while the morph grows into its place.
    if (morph !== null) dialog.dataset.morphing = "";
    this.reopenTrigger.current = this.trigger;
    this.minimized = false;
    // The layout effect of the commit opens the dialog, so the card can be
    // measured right after.
    flushSync(() => this.setMinimized(false));
    const card = this.card.current;
    const settle = (): void => {
      delete dialog.dataset.morphing;
      this.moving = false;
    };
    if (morph === null || card === null || !dialog.open) {
      morph?.cancel();
      settle();
      return;
    }
    void morph
      .play({
        rect: card.getBoundingClientRect(),
        radius: getComputedStyle(card).borderRadius,
        content: card,
        context: "permission-request-dialog",
      })
      .then(settle);
  };

  showToast(): void {
    if (!this.minimized || this.decision === null) return;
    showPromptToast(
      this.toastId,
      promptToastViewOf(this.title, this.decision, this.outcome),
      {
        onOpen: this.mounted ? this.maximize : null,
        hidden: this.hidden,
        returnFocus: this.trigger,
        onSettledClose: this.mounted ? this.closeSettled : null,
      },
    );
  }

  /** The caller closed the prompt while it was a toast. */
  closedByCaller(): void {
    if (!this.minimized) return;
    this.minimized = false;
    this.setMinimized(false);
    if (this.outcome === "working" || this.outcome === "succeeded") return;
    dismissPromptToast(this.toastId);
  }

  unmount(): void {
    this.mounted = false;
    if (!this.minimized) return;
    // A toast whose decision is still saving, or saved, stays to say how it
    // ended; it no longer opens a prompt.
    if (this.outcome === "working" || this.outcome === "succeeded")
      this.showToast();
    else dismissPromptToast(this.toastId);
  }

  private settle(ok: boolean): void {
    this.outcome = ok ? "succeeded" : "failed";
    if (this.mounted) this.setOutcome(this.outcome);
    else this.showToast();
  }

  /** A settled toast closed by itself: the decision is done, so is the prompt. */
  private readonly closeSettled = (): void => {
    if (!this.mounted || !this.minimized) return;
    this.minimized = false;
    this.reopenTrigger.current = this.trigger;
    this.onClose();
    // A caller that keeps the prompt open shows it again as the modal.
    this.setMinimized(false);
  };

  private async minimizeIntoToast(): Promise<void> {
    const dialog = this.dialog.current;
    const card = this.card.current;
    if (this.minimized || this.moving || dialog === null || card === null)
      return;
    if (!dialog.open) return;
    this.moving = true;
    const reduced = prefersReducedMotion();
    // A copy of the card holds its place while the toast mounts.
    const morph = reduced
      ? null
      : holdLayoutMorph(
          {
            rect: card.getBoundingClientRect(),
            radius: getComputedStyle(card).borderRadius,
            content: card,
            context: "permission-request-dialog",
          },
          "out",
        );
    if (reduced) await fadeOut(dialog);
    this.trigger = hideDialog(dialog) ?? this.trigger;
    this.minimized = true;
    this.hidden = morph !== null;
    this.setMinimized(true);
    this.showToast();
    const toastCard = await promptToastCard(this.toastId);
    if (toastCard === null) {
      // No toast stack on this page: the prompt stays a modal.
      morph?.cancel();
      this.hidden = false;
      this.moving = false;
      this.minimized = false;
      this.reopenTrigger.current = this.trigger;
      this.setMinimized(false);
      return;
    }
    promptToastControl(toastCard)?.focus({ preventScroll: true });
    if (morph !== null) await morph.play(toastEnd(toastCard));
    this.hidden = false;
    revealPromptToast(toastCard);
    this.moving = false;
    this.showToast();
  }
}

function toastEnd(card: HTMLElement): MorphEnd {
  return {
    rect: card.getBoundingClientRect(),
    radius: TOAST_RADIUS,
    content: card,
  };
}

/** The plain fade of a prompt that minimizes with reduced motion. */
async function fadeOut(dialog: HTMLDialogElement): Promise<void> {
  const fade = dialog.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 150,
    easing: "ease-out",
    fill: "forwards",
  });
  await Promise.race([
    fade.finished.catch(noop),
    new Promise((resolve) => window.setTimeout(resolve, 300)),
  ]);
  fade.cancel();
}

/** What the toast says for the prompt's state. */
function promptToastViewOf(
  title: string,
  decision: PermissionRequestDecision,
  outcome: AllowOutcome,
): PromptToastView {
  if (outcome === "working")
    return { tone: "loading", title: "Saving your decision…", message: title };
  if (outcome === "failed")
    return {
      tone: "failure",
      title: "Your decision was not saved",
      message: decision.error ?? "Open the request to try again.",
    };
  if (decision.kind === "result")
    return {
      tone: decision.tone === "allowed" ? "success" : "denied",
      title: decision.title,
      message: textOf(decision.message),
    };
  if (outcome === "succeeded")
    return {
      tone: "success",
      title: "Request allowed",
      message:
        decision.kind === "explain"
          ? (textOf(decision.message) ?? title)
          : title,
    };
  return {
    tone: "waiting",
    title: "Waiting for your decision",
    message: title,
  };
}

function textOf(node: React.ReactNode): string | null {
  return typeof node === "string" && node.length > 0 ? node : null;
}

function noop(): void {}

export type AuthorizationScreenProps = {
  readonly open: boolean;
  /** Called for Escape. */
  readonly onClose: () => void;
  /** An extra class on the `<dialog>`, for a caller that styles or finds it. */
  readonly className?: string;
  readonly requester: PermissionRequestParty;
  readonly target: PermissionRequestParty;
  readonly title: string;
  readonly subtitle: React.ReactNode | null;
  /** The list heading, such as "What happens next". A compact sheet keeps it for screen readers only. */
  readonly asideHeading: string;
  /** The list content, such as a `<ul>` of consent points. */
  readonly aside: React.ReactNode;
  /** The one action, such as Continue. */
  readonly confirm: PermissionRequestAction;
  /** The split screen's button beside `confirm`; it calls `onClose`. */
  readonly cancelLabel: string;
  readonly footnote: React.ReactNode | null;
  /** The signed-in person, when the caller knows them. */
  readonly account?: PermissionRequestAccount | null;
  /** Compact by default. */
  readonly layout?: AuthorizationLayout;
};

/**
 * The authorization screen for a consent that has no choices, such as a
 * provider sign-in. It has the layouts of `PermissionRequestDialog` with the
 * caller's own list and one action. Both close with the close button; the
 * split card also has a cancel button beside the action.
 */
export function AuthorizationScreen(
  props: AuthorizationScreenProps,
): React.ReactNode {
  const ids = useContentIds();
  const layout = props.layout ?? "compact";
  return (
    <AuthorizationDialog
      open={props.open}
      onClose={props.onClose}
      ids={ids}
      hasSubtitle={props.subtitle !== null}
      className={props.className ?? null}
      layout={layout}
      standIn
    >
      <AuthorizationFrame
        ids={ids}
        heading="h2"
        layout={layout}
        requester={props.requester}
        target={props.target}
        title={props.title}
        subtitle={props.subtitle}
        scope={null}
        aside={
          <AsideList id={ids.list} heading={props.asideHeading}>
            {props.aside}
          </AsideList>
        }
        decision={
          <>
            {props.footnote !== null && (
              <p className="permission-request-footnote">{props.footnote}</p>
            )}
            <div className="permission-request-actions">
              {layout === "split" ? (
                <ActionButton
                  tone="secondary"
                  label={props.cancelLabel}
                  busy={false}
                  blocked={false}
                  describedBy={undefined}
                  onSelect={props.onClose}
                />
              ) : null}
              <ActionButton
                tone="primary"
                label={props.confirm.label}
                busy={false}
                blocked={false}
                describedBy={undefined}
                onSelect={props.confirm.onSelect}
              />
            </div>
          </>
        }
        account={props.account ?? null}
      />
    </AuthorizationDialog>
  );
}

function AuthorizationDialog(
  props: Readonly<{
    open: boolean;
    onClose: () => void;
    ids: ContentIds;
    hasSubtitle: boolean;
    className: string | null;
    layout: DialogLayout;
    /** A sign-in screen takes the place of the sheet that opened it. */
    standIn?: boolean;
    /** A permission prompt that can minimize into a toast. */
    minimizer?: Minimizer;
    children: React.ReactNode;
  }>,
): React.ReactNode {
  const ownDialog = React.useRef<HTMLDialogElement>(null);
  const ownCard = React.useRef<HTMLDivElement>(null);
  const dialog = props.minimizer?.dialog ?? ownDialog;
  const card = props.minimizer?.card ?? ownCard;
  const size = useLastSize(card);
  const standingFor = React.useRef<HTMLDialogElement | null>(null);
  const [present, setPresent] = useDialogPresent(props.open);
  React.useLayoutEffect(
    syncAuthorizationDialog.bind(
      null,
      {
        dialog,
        card,
        size,
        standingFor,
        reopenTrigger: props.minimizer?.reopenTrigger ?? null,
      },
      props.open,
      props.standIn === true,
      setPresent,
    ),
    [props.open],
  );
  // A closing card keeps its view until its exit ends.
  const held = useHeldWhileClosed(
    { layout: props.layout, children: props.children },
    props.open,
  );
  const view = present
    ? held
    : { layout: props.layout, children: props.children };
  React.useLayoutEffect(resizeFrom.bind(null, card, size), [view.layout]);
  return (
    <dialog
      ref={dialog}
      className={
        props.className === null
          ? "permission-request-dialog"
          : `permission-request-dialog ${props.className}`
      }
      data-layout={view.layout}
      aria-labelledby={props.ids.title}
      aria-describedby={props.hasSubtitle ? props.ids.subtitle : undefined}
      onCancel={cancelDialog.bind(null, props.onClose)}
    >
      <div ref={card} className="permission-request" data-layout={view.layout}>
        {props.minimizer === undefined ? null : (
          <button
            type="button"
            className="permission-request-minimize"
            aria-label="Minimize"
            title="Minimize"
            onClick={props.minimizer.minimize}
          >
            <Minus size={18} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="permission-request-close"
          aria-label="Close"
          onClick={props.onClose}
        >
          <X size={18} aria-hidden="true" />
        </button>
        {view.children}
      </div>
    </dialog>
  );
}

type AuthorizationDialogParts = Readonly<{
  dialog: React.RefObject<HTMLDialogElement | null>;
  card: React.RefObject<HTMLDivElement | null>;
  size: React.RefObject<Size | null>;
  standingFor: React.RefObject<HTMLDialogElement | null>;
  /** The control that opened a prompt before it minimized into a toast. */
  reopenTrigger: React.RefObject<HTMLElement | null> | null;
}>;

/**
 * Opens and closes the screen. A sign-in screen that opens over a shown sheet
 * stands in for it: the sheet hides and keeps its backdrop, and the card
 * grows from the sheet's size while its content fades in. When the screen
 * closes, the sheet grows back from the card. With reduced motion the screen
 * and the sheet cross-fade instead.
 */
function syncAuthorizationDialog(
  parts: AuthorizationDialogParts,
  open: boolean,
  standIn: boolean,
  setPresent: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  const dialog = parts.dialog.current;
  const card = parts.card.current;
  if (dialog === null || card === null) return;
  if (open) {
    const sheet = standIn && !dialog.open ? shownSheet() : null;
    const from = sheet?.getBoundingClientRect() ?? null;
    parts.standingFor.current = sheet;
    if (sheet !== null) dialog.dataset.standsIn = "";
    const trigger = parts.reopenTrigger?.current ?? null;
    if (parts.reopenTrigger !== null) parts.reopenTrigger.current = null;
    showDialog(dialog, trigger);
    if (from !== null && !reducedMotion()) growFromSheet(parts, from);
    return;
  }
  if (!dialog.open) {
    setPresent(false);
    return;
  }
  const sheet = parts.standingFor.current;
  parts.standingFor.current = null;
  const closed = (): void => {
    delete dialog.dataset.standsIn;
    setPresent(false);
  };
  if (sheet === null || reducedMotion()) {
    closeDialog(dialog, closed);
    return;
  }
  const box = card.getBoundingClientRect();
  closeDialogNow(dialog, closed);
  returnToSheet(sheet, box);
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The card takes the sheet's size, then resizes to its own. */
function growFromSheet(
  parts: AuthorizationDialogParts,
  from: DOMRectReadOnly,
): void {
  const card = parts.card.current;
  if (card === null) return;
  parts.size.current = { width: from.width, height: from.height };
  resizeFrom(parts.card, parts.size);
  const style = getComputedStyle(card);
  const duration = Number.parseFloat(
    style.getPropertyValue("--pantry-spring-smooth-duration"),
  );
  if (!(duration > 0)) return;
  for (const child of card.children)
    child.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration,
      easing:
        style.getPropertyValue("--pantry-spring-smooth-ease").trim() ||
        "ease-out",
      fill: "backwards",
    });
}

type Size = Readonly<{ width: number; height: number }>;

/**
 * The card's border-box size as the browser last laid it out. A layout
 * effect still reads the size from before the render, because the observer
 * reports the new size only after the effect.
 */
function useLastSize(
  card: React.RefObject<HTMLDivElement | null>,
): React.RefObject<Size | null> {
  const size = React.useRef<Size | null>(null);
  React.useLayoutEffect(() => {
    const element = card.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.borderBoxSize[0];
      if (box !== undefined)
        size.current = { width: box.inlineSize, height: box.blockSize };
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [card]);
  return size;
}

/**
 * When the card changes its view, such as from the question to the result,
 * it grows or shrinks from its old size to the new one. The new content
 * keeps its final width while the card moves, so its text does not wrap
 * again on each frame.
 */
function resizeFrom(
  card: React.RefObject<HTMLDivElement | null>,
  size: React.RefObject<Size | null>,
): (() => void) | undefined {
  const element = card.current;
  const from = size.current;
  if (element === null || from === null || from.width === 0) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const to = { width: element.offsetWidth, height: element.offsetHeight };
  if (to.width === from.width && to.height === from.height) return;
  element.style.setProperty(
    "--permission-request-final-width",
    `${to.width}px`,
  );
  element.style.width = `${from.width}px`;
  element.style.height = `${from.height}px`;
  // Lay out the old size first, so the change below is a transition.
  void element.offsetWidth;
  element.dataset.resizing = "";
  element.style.width = `${to.width}px`;
  element.style.height = `${to.height}px`;
  const settle = (): void => {
    window.clearTimeout(fallback);
    element.removeEventListener("transitionend", onEnd);
    delete element.dataset.resizing;
    element.style.removeProperty("width");
    element.style.removeProperty("height");
    element.style.removeProperty("--permission-request-final-width");
  };
  const onEnd = (event: TransitionEvent): void => {
    if (event.target === element && event.propertyName === "height") settle();
  };
  // A hidden tab can skip the transition events.
  const fallback = window.setTimeout(settle, 1000);
  element.addEventListener("transitionend", onEnd);
  return settle;
}

function useContentIds(): ContentIds {
  const base = React.useId();
  return {
    title: `${base}-title`,
    subtitle: `${base}-subtitle`,
    list: `${base}-list`,
    error: `${base}-error`,
  };
}

/**
 * The three parts of the card as siblings: the head with the parties, the
 * question and the account, the right-hand list, and the decision. The layout
 * attribute of the parent places them in one column or in two.
 */
function AuthorizationFrame(
  props: Readonly<{
    ids: ContentIds;
    heading: "h2" | "h3";
    /** A compact sheet shows only the app it asks for, as one large icon. */
    layout: AuthorizationLayout | "stacked";
    requester: PermissionRequestParty;
    target: PermissionRequestParty;
    title: string;
    subtitle: React.ReactNode | null;
    scope: React.ReactNode;
    aside: React.ReactNode;
    decision: React.ReactNode;
    account: PermissionRequestAccount | null;
  }>,
): React.ReactNode {
  const Heading = props.heading;
  return (
    <>
      <div className="permission-request-head">
        <div className="permission-request-parties" aria-hidden="true">
          {props.layout === "compact" ? null : (
            <>
              <span className="permission-request-avatar">
                {props.requester.icon}
              </span>
              <span className="permission-request-connector">
                <ArrowLeftRight size={18} />
              </span>
            </>
          )}
          <span className="permission-request-avatar">{props.target.icon}</span>
        </div>
        <Heading id={props.ids.title} className="permission-request-title">
          {props.title}
        </Heading>
        {props.account === null ? null : (
          <AccountChip account={props.account} />
        )}
        {props.subtitle !== null && (
          <p id={props.ids.subtitle} className="permission-request-subtitle">
            {props.subtitle}
          </p>
        )}
        {props.scope}
      </div>
      <CollapsibleAside>{props.aside}</CollapsibleAside>
      <div className="permission-request-decision">{props.decision}</div>
    </>
  );
}

/**
 * The person who decides, as on a provider's consent page. With an action the
 * chip is a button that opens the account switcher.
 */
function AccountChip(
  props: Readonly<{ account: PermissionRequestAccount }>,
): React.ReactNode {
  const { account } = props;
  const content = (
    <>
      <span className="permission-request-chip-avatar" aria-hidden="true">
        {initialOf(account.name)}
      </span>
      <span className="permission-request-chip-name">{account.name}</span>
      {account.action === null ? null : (
        <ChevronDown size={14} aria-hidden="true" />
      )}
    </>
  );
  return account.action === null ? (
    <p className="permission-request-chip">
      <span className="visually-hidden">Signed in as </span>
      {content}
    </p>
  ) : (
    <button
      type="button"
      className="permission-request-chip"
      aria-label={`Signed in as ${account.name}. ${account.action.label}`}
      onClick={account.action.onSelect}
    >
      {content}
    </button>
  );
}

function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

/**
 * The right-hand list keeps the height of the question beside it. When the
 * list is longer, its end fades out under a "View all" button that shows the
 * rest; nothing scrolls inside the card. A keyboard user who tabs to a hidden
 * row opens the list too.
 */
function CollapsibleAside(
  props: Readonly<{ children: React.ReactNode }>,
): React.ReactNode {
  const viewport = React.useRef<HTMLDivElement>(null);
  const viewportId = React.useId();
  const [expanded, setExpanded] = React.useState(false);
  const [overflows, setOverflows] = React.useState(false);
  React.useLayoutEffect(() => {
    const element = viewport.current;
    if (element === null || expanded) return;
    const measure = (): void =>
      setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [expanded]);
  const folded = overflows && !expanded;
  return (
    <div
      className="permission-request-aside"
      data-expanded={expanded ? "" : undefined}
      data-folded={folded ? "" : undefined}
    >
      <div
        ref={viewport}
        id={viewportId}
        className="permission-request-aside-viewport"
        onFocus={revealFocused.bind(null, viewport, folded, setExpanded)}
      >
        {props.children}
      </div>
      {overflows || expanded ? (
        <button
          type="button"
          className="permission-request-more"
          aria-expanded={expanded}
          aria-controls={viewportId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "View all"}
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function revealFocused(
  viewport: React.RefObject<HTMLDivElement | null>,
  folded: boolean,
  setExpanded: (expanded: boolean) => void,
  event: React.FocusEvent<HTMLDivElement>,
): void {
  const element = viewport.current;
  if (!folded || element === null) return;
  // The browser has already scrolled the folded list to the focused row.
  // Its place in the unscrolled list decides, and the faded band at the end
  // counts as hidden.
  const target = event.target.getBoundingClientRect();
  const top = element.getBoundingClientRect().top;
  const bottom = target.bottom - top + element.scrollTop;
  if (bottom > element.clientHeight - 48) setExpanded(true);
  element.scrollTop = 0;
}

function AsideList(
  props: Readonly<{
    id: string;
    heading: string;
    children: React.ReactNode;
  }>,
): React.ReactNode {
  return (
    <div
      className="permission-request-list"
      role="group"
      aria-labelledby={props.id}
    >
      <p id={props.id} className="permission-request-list-heading">
        {props.heading}
      </p>
      {props.children}
    </div>
  );
}

function PermissionRequestContent(
  props: PermissionRequestCardProps & {
    readonly ids: ContentIds;
    readonly heading: "h2" | "h3";
    readonly layout: AuthorizationLayout | "stacked";
  },
): React.ReactNode {
  const decision = props.decision;
  const pending = decision.pending !== null;
  const readOnly = decision.kind !== "grant" || pending;
  const selected = withRequired(props.items, props.selectedIds);
  return (
    <AuthorizationFrame
      ids={props.ids}
      heading={props.heading}
      layout={props.layout}
      requester={props.requester}
      target={props.target}
      title={props.title}
      subtitle={props.subtitle}
      scope={
        props.scope === null ? null : (
          <ScopeSelect scope={props.scope} disabled={pending} />
        )
      }
      aside={
        <AsideList id={props.ids.list} heading={props.listHeading}>
          <ul>
            {props.items.map(
              renderItem.bind(null, {
                items: props.items,
                mixed:
                  props.items.some(isRequired) &&
                  !props.items.every(isRequired),
                selected,
                readOnly,
                onSelectionChange: props.onSelectionChange,
              }),
            )}
          </ul>
        </AsideList>
      }
      decision={
        <>
          {decision.kind === "explain" && (
            <div className="permission-request-explain">
              <Info size={16} aria-hidden="true" />
              <div>{decision.message}</div>
            </div>
          )}
          {decision.error !== null && (
            <p
              id={props.ids.error}
              className="permission-request-error"
              role="alert"
            >
              {decision.error}
            </p>
          )}
          {props.footnote !== null && (
            <p className="permission-request-footnote">{props.footnote}</p>
          )}
          <DecisionActions
            decision={decision}
            selected={selected}
            errorId={decision.error === null ? undefined : props.ids.error}
          />
        </>
      }
      account={props.signedInAs}
    />
  );
}

/**
 * The short card after a decision: a mark, what happened, what comes next,
 * and the caller's actions. Focus moves to the first action when the card
 * replaces the question, because the button that had focus is gone.
 */
function ResultView(
  props: Readonly<{
    ids: ContentIds;
    heading: "h2" | "h3";
    decision: ResultDecision;
  }>,
): React.ReactNode {
  const { decision, ids } = props;
  const Heading = props.heading;
  const root = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const element = root.current;
    if (element === null || element.contains(document.activeElement)) return;
    const dialog = element.closest("dialog");
    if (dialog === null || !dialog.open) return;
    element
      .querySelector<HTMLButtonElement>(
        '.permission-request-button[data-tone="primary"]',
      )
      ?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={root}
      className="permission-request-result"
      data-tone={decision.tone}
    >
      <span className="permission-request-result-mark" aria-hidden="true">
        {decision.tone === "allowed" ? (
          <Check size={30} strokeWidth={2.5} />
        ) : (
          <X size={30} strokeWidth={2.5} />
        )}
      </span>
      <Heading id={ids.title} className="permission-request-title">
        {decision.title}
      </Heading>
      <div id={ids.subtitle} className="permission-request-subtitle">
        {decision.message}
      </div>
      {decision.error !== null && (
        <p id={ids.error} className="permission-request-error" role="alert">
          {decision.error}
        </p>
      )}
      <DecisionActions
        decision={decision}
        selected={new Set()}
        errorId={decision.error === null ? undefined : ids.error}
      />
    </div>
  );
}

function ScopeSelect(
  props: Readonly<{ scope: PermissionRequestScope; disabled: boolean }>,
): React.ReactNode {
  const id = React.useId();
  const scope = props.scope;
  const current = scope.options.find(matchesScope.bind(null, scope.value));
  return (
    <div className="permission-request-scope">
      <label htmlFor={id}>{scope.label}</label>
      <span
        className="permission-request-select"
        data-icon={current?.icon !== undefined}
      >
        {current?.icon !== undefined && (
          <span className="permission-request-select-icon" aria-hidden="true">
            {current.icon}
          </span>
        )}
        <Select.Root
          items={scope.options.map(scopeItem)}
          value={scope.value}
          disabled={props.disabled}
          onValueChange={changeScope.bind(null, scope.onChange)}
        >
          <Select.Trigger id={id}>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{scope.options.map(renderScopeOption)}</Select.Popup>
        </Select.Root>
      </span>
    </div>
  );
}

function scopeItem(
  option: PermissionRequestScopeOption,
): Readonly<{ value: string; label: string }> {
  return { value: option.id, label: option.label };
}

function renderScopeOption(
  option: PermissionRequestScopeOption,
): React.ReactNode {
  return (
    <Select.Item key={option.id} value={option.id}>
      {option.label}
    </Select.Item>
  );
}

type ItemContext = {
  readonly items: readonly PermissionRequestItem[];
  /** True when the list has both required items and choices. */
  readonly mixed: boolean;
  readonly selected: ReadonlySet<string>;
  readonly readOnly: boolean;
  readonly onSelectionChange: (ids: readonly string[]) => void;
};

function renderItem(
  context: ItemContext,
  item: PermissionRequestItem,
): React.ReactNode {
  return <PermissionRow key={item.id} context={context} item={item} />;
}

function PermissionRow(
  props: Readonly<{ context: ItemContext; item: PermissionRequestItem }>,
): React.ReactNode {
  const base = React.useId();
  const { context, item } = props;
  const labelId = `${base}-label`;
  const descriptionId = `${base}-description`;
  const copy = (
    <span className="permission-request-item-copy">
      <span id={labelId} className="permission-request-item-label">
        {item.label}
      </span>
      {item.description !== null && (
        <span
          id={descriptionId}
          className="permission-request-item-description"
        >
          {item.description}
        </span>
      )}
    </span>
  );
  // A required item is not a choice, so it shows as a granted line, as on a
  // provider's consent page. The "Required" mark tells it apart only in a
  // list that also has choices.
  if (item.required)
    return (
      <li>
        <div className="permission-request-item" data-required="true">
          <span className="permission-request-mark" aria-hidden="true">
            <Check size={14} strokeWidth={2.5} />
          </span>
          {copy}
          {context.mixed && (
            <span className="permission-request-pill">Required</span>
          )}
        </div>
      </li>
    );
  return (
    <li>
      <label
        className="permission-request-item"
        data-required={item.required}
        data-readonly={context.readOnly}
      >
        <span className="permission-request-check">
          <input
            type="checkbox"
            checked={context.selected.has(item.id)}
            disabled={context.readOnly}
            aria-labelledby={labelId}
            aria-describedby={
              item.description === null ? undefined : descriptionId
            }
            onChange={toggleItem.bind(null, context, item.id)}
          />
          <Check size={12} strokeWidth={3} aria-hidden="true" />
        </span>
        {copy}
      </label>
    </li>
  );
}

function DecisionActions(
  props: Readonly<{
    decision: PermissionRequestDecision;
    selected: ReadonlySet<string>;
    errorId: string | undefined;
  }>,
): React.ReactNode {
  const decision = props.decision;
  switch (decision.kind) {
    case "grant":
      return (
        <div className="permission-request-actions">
          <ActionButton
            tone="secondary"
            label={decision.denyLabel ?? "Deny"}
            busy={decision.pending === "deny"}
            blocked={decision.pending !== null}
            describedBy={props.errorId}
            onSelect={decision.onDeny}
          />
          <ActionButton
            tone="primary"
            label={decision.allowLabel ?? "Allow"}
            busy={decision.pending === "allow"}
            blocked={decision.pending !== null}
            describedBy={props.errorId}
            onSelect={allow.bind(null, decision.onAllow, props.selected)}
          />
        </div>
      );
    case "explain":
    case "result":
      if (decision.primary === null && decision.secondary === null) return null;
      return (
        <div className="permission-request-actions">
          {decision.secondary !== null && (
            <ActionButton
              tone="secondary"
              label={decision.secondary.label}
              busy={decision.pending === "secondary"}
              blocked={decision.pending !== null}
              describedBy={props.errorId}
              onSelect={decision.secondary.onSelect}
            />
          )}
          {decision.primary !== null && (
            <ActionButton
              tone="primary"
              label={decision.primary.label}
              busy={decision.pending === "primary"}
              blocked={decision.pending !== null}
              describedBy={props.errorId}
              onSelect={decision.primary.onSelect}
            />
          )}
        </div>
      );
    default:
      return assertNever(decision, "Unknown permission decision");
  }
}

/**
 * A pending request blocks both buttons with aria-disabled instead of the
 * disabled attribute, so the focused button keeps focus while it waits.
 */
function ActionButton(
  props: Readonly<{
    tone: "primary" | "secondary";
    label: string;
    busy: boolean;
    blocked: boolean;
    describedBy: string | undefined;
    onSelect: () => void;
  }>,
): React.ReactNode {
  return (
    <button
      type="button"
      className="permission-request-button"
      data-tone={props.tone}
      aria-busy={props.busy}
      aria-disabled={props.blocked}
      aria-describedby={props.describedBy}
      onClick={props.blocked ? undefined : props.onSelect}
    >
      {props.busy && (
        <LoaderCircle
          className="permission-request-spin"
          size={16}
          aria-hidden="true"
        />
      )}
      {props.label}
    </button>
  );
}

function isRequired(item: PermissionRequestItem): boolean {
  return item.required;
}

function withRequired(
  items: readonly PermissionRequestItem[],
  selectedIds: readonly string[],
): ReadonlySet<string> {
  const requested = new Set(selectedIds);
  const selected = new Set<string>();
  for (const item of items)
    if (item.required || requested.has(item.id)) selected.add(item.id);
  return selected;
}

function toggleItem(
  context: ItemContext,
  id: string,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  const checked = event.currentTarget.checked;
  const next: string[] = [];
  for (const item of context.items) {
    const include =
      item.required ||
      (item.id === id ? checked : context.selected.has(item.id));
    if (include) next.push(item.id);
  }
  context.onSelectionChange(next);
}

function allow(
  onAllow: (selectedIds: readonly string[]) => void,
  selected: ReadonlySet<string>,
): void {
  onAllow([...selected]);
}

function matchesScope(
  value: string,
  option: PermissionRequestScopeOption,
): boolean {
  return option.id === value;
}

function changeScope(
  onChange: (id: string) => void,
  value: string | null,
): void {
  if (value !== null) onChange(value);
}
