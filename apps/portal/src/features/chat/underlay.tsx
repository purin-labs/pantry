import { DEFAULT_CHAT_PREFERENCES } from "@purin-labs/control-api";
import { useUserPreferences } from "../../preferences/context";
import type { UserPreferenceOwner } from "../../preferences/owner";
import React from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { runLayoutMotion } from "../../layout-motion";
import "./underlay.css";



type ChatDisplay = {
  readonly fullscreen: boolean;
  readonly toggle: () => void;
};
export const ChatDisplayContext = React.createContext<ChatDisplay | null>(null);

export function ChatFullscreenButton(props: {
  /** Runs as the chat enters fullscreen, before it expands. */
  readonly onEnter?: () => void;
}): React.ReactNode {
  const display = React.useContext(ChatDisplayContext);
  if (display === null) return null;
  const label = display.fullscreen ? "Exit fullscreen" : "Expand to fullscreen";
  return (
    <button
      type="button"
      className="chat-underlay-close"
      aria-label={label}
      title={label}
      aria-pressed={display.fullscreen}
      onClick={toggleChatDisplay.bind(null, display, props.onEnter)}
    >
      {display.fullscreen ? (
        <Minimize2 size={18} aria-hidden="true" />
      ) : (
        <Maximize2 size={18} aria-hidden="true" />
      )}
    </button>
  );
}

function toggleChatDisplay(
  display: ChatDisplay,
  onEnter: (() => void) | undefined,
): void {
  if (!display.fullscreen) onEnter?.();
  display.toggle();
}
// Expanding or collapsing swaps the workspace for the chat with a quick fade,
// not a resize. The stage carries the mark until the fade ends.
const DISPLAY_SWITCH_MS = 400;
const displaySwitchTimers = new WeakMap<HTMLElement, number>();
function markDisplaySwitch(element: HTMLElement | null): void {
  if (element === null) return;
  window.clearTimeout(displaySwitchTimers.get(element));
  element.dataset.chatDisplaySwitch = "true";
  displaySwitchTimers.set(
    element,
    window.setTimeout(() => {
      delete element.dataset.chatDisplaySwitch;
    }, DISPLAY_SWITCH_MS),
  );
}
function toggleFullscreen(value: boolean): boolean {
  return !value;
}
function resetFullscreen(
  setFullscreen: React.Dispatch<React.SetStateAction<boolean>>,
  open: boolean,
): void {
  if (!open) setFullscreen(false);
}

export type WorkspaceChat = {
  readonly content: React.ReactNode;
  readonly close: () => void;
} | null;

type ChatUnderlayProps = {
  readonly children: React.ReactNode;
  readonly chat: WorkspaceChat;
  readonly fullscreen: boolean;
  readonly setFullscreen: React.Dispatch<React.SetStateAction<boolean>>;
  /** Keeps the workspace rail beside the chat in full screen. */
  readonly navigation: boolean;
};

export function ChatUnderlay(props: ChatUnderlayProps): React.ReactNode {
  const open = props.chat !== null;
  const { fullscreen, setFullscreen } = props;
  React.useEffect(resetFullscreen.bind(null, setFullscreen, open), [
    setFullscreen,
    open,
  ]);
  // Opening, closing or expanding the chat resizes the workspace beside it.
  const shown = React.useRef({ open, fullscreen });
  const stage = React.useRef<HTMLDivElement>(null);
  const toggle = React.useCallback(() => {
    // Mark the stage before the state changes, so that the styles of the
    // new state start their transitions with the mark in place.
    markDisplaySwitch(stage.current);
    setFullscreen(toggleFullscreen);
  }, [setFullscreen]);
  React.useLayoutEffect(() => {
    const before = shown.current;
    shown.current = { open, fullscreen };
    if (before.open !== open || before.fullscreen !== fullscreen)
      runLayoutMotion();
  }, [open, fullscreen]);
  const preferences = useUserPreferences("chat");
  const document = preferences?.document("chat");
  const [unsignedWidth, setUnsignedWidth] = React.useState(DEFAULT_CHAT_PREFERENCES.dockedPanelWidthPx);
  const preferredWidth = document?.area === "chat" ? document.values.dockedPanelWidthPx : unsignedWidth;
  const [previewWidth, setPreviewWidth] = React.useState<number | null>(null);
  const width = clampChatWidth(previewWidth ?? preferredWidth);
  const keyboard: KeyboardResize = React.useRef({ timer: null, width: null });
  React.useEffect(keyboardCleanup.bind(null, keyboard), [keyboard]);
  const [maximum, setMaximum] = React.useState(maximumChatWidth);
  const [compact, setCompact] = React.useState(isCompactChatViewport);
  const drag: ChatResizeDrag = React.useRef(null);
  const panel = React.useRef<HTMLElement>(null);
  const resizeHandle = React.useRef<HTMLDivElement>(null);
  React.useEffect(
    observeChatViewport.bind(
      null,
      setMaximum,
      setCompact,
      drag,
      resizeHandle,
      panel,
      setPreviewWidth,
      open,
    ),
    [open],
  );
  React.useLayoutEffect(
    cancelHiddenChatResize.bind(
      null,
      drag,
      resizeHandle,
      setPreviewWidth,
      open,
      fullscreen,
    ),
    [open, fullscreen],
  );

  React.useEffect(focusChatPanel.bind(null, panel, open), [open]);
  return (
    <div
      className="portal-chat-stage"
      ref={stage}
      data-chat-open={open}
      data-chat-fullscreen={open && fullscreen}
      data-chat-navigation={props.navigation}
      style={{ "--chat-underlay-width": `${width}px` } as React.CSSProperties}
    >
      <div
        className="portal-chat-foreground"
        inert={open && (compact || (fullscreen && !props.navigation))}
      >
        {props.children}
      </div>
      <aside
        id="workspace-chat"
        className="chat-underlay"
        aria-label="Chat"
        aria-hidden={!open}
        inert={!open}
        tabIndex={-1}
        ref={panel}
        onKeyDown={closeChatOnEscape.bind(null, props.chat)}
      >
        <ChatDisplayContext.Provider
          value={{
            fullscreen,
            toggle,
          }}
        >
          {props.chat?.content}
        </ChatDisplayContext.Provider>
      </aside>
      <div
        className="chat-underlay-resize"
        data-resize-handle
        ref={resizeHandle}
        aria-hidden={!open}
        inert={!open}
        role="separator"
        aria-label="Resize chat"
        aria-controls="workspace-chat"
        aria-orientation="vertical"
        aria-valuemin={minimumChatWidth()}
        aria-valuemax={maximum}
        aria-valuenow={width}
        aria-valuetext={`${Math.round(width)} pixels wide`}
        tabIndex={0}
        onPointerDown={beginChatResize.bind(
          null,
          drag,
          width,
          flushKeyboardResize.bind(
            null,
            keyboard,
            preferences,
            setUnsignedWidth,
            setPreviewWidth,
          ),
        )}
        onPointerMove={moveChatResize.bind(null, drag, setPreviewWidth)}
        onPointerUp={endChatResize.bind(null, drag, setPreviewWidth, preferences, setUnsignedWidth)}
        onPointerCancel={cancelChatResize.bind(null, drag, setPreviewWidth)}
        onLostPointerCapture={cancelChatResize.bind(null, drag, setPreviewWidth)}
        onKeyDown={resizeChatWithKeyboard.bind(
          null,
          props.chat,
          drag,
          width,
          setPreviewWidth,
          keyboard,
          preferences,
          setUnsignedWidth,
        )}
        onBlur={flushKeyboardResize.bind(null, keyboard, preferences, setUnsignedWidth, setPreviewWidth)}
      />
    </div>
  );
}

function isCompactChatViewport(): boolean {
  return window.innerWidth <= 760;
}

function focusChatPanel(
  panel: React.RefObject<HTMLElement | null>,
  open: boolean,
): (() => void) | undefined {
  if (open) {
    panel.current?.focus({ preventScroll: true });
    return restoreChatTriggerFocus.bind(null, panel);
  }
}

function restoreChatTriggerFocus(
  panel: React.RefObject<HTMLElement | null>,
): void {
  panel.current?.parentElement
    ?.querySelector<HTMLElement>(".portal-chat-link")
    ?.focus({ preventScroll: true });
}

function closeChatOnEscape(
  chat: WorkspaceChat,
  event: React.KeyboardEvent<HTMLElement>,
): void {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (
    event.target instanceof Element &&
    event.target.closest('dialog[open], [role="dialog"], [role="menu"]')
  )
    return;
  event.preventDefault();
  chat?.close();
}

type ChatResizeDrag = React.RefObject<{
  pointerId: number;
  startX: number;
  width: number;
  currentWidth: number;
  moved: boolean;
} | null>;
type KeyboardResize = React.RefObject<{ timer: ReturnType<typeof setTimeout> | null; width: number | null }>;

function maximumChatWidth(): number {
  const viewportWidth = window.innerWidth;
  if (viewportWidth <= 760) return viewportWidth - 24;
  return Math.floor(viewportWidth / 2);
}

function minimumChatWidth(): number {
  return Math.min(340, maximumChatWidth());
}

function clampChatWidth(width: number): number {
  const maximum = maximumChatWidth();
  return Math.min(maximum, Math.max(minimumChatWidth(), width));
}

function updateChatViewport(
  setMaximum: React.Dispatch<React.SetStateAction<number>>,
  setCompact: React.Dispatch<React.SetStateAction<boolean>>,
  drag: ChatResizeDrag,
  resizeHandle: React.RefObject<HTMLDivElement | null>,
  panel: React.RefObject<HTMLElement | null>,
  setPreviewWidth: React.Dispatch<React.SetStateAction<number | null>>,
  open: boolean,
): void {
  resetChatResize(drag, setPreviewWidth, resizeHandle.current);
  const focused = document.activeElement;
  const focusLost =
    focused === document.body || focused === resizeHandle.current;
  const workspaceFocused =
    focused !== null && focused.closest(".portal-chat-foreground") !== null;
  if (open && isCompactChatViewport() && (focusLost || workspaceFocused)) {
    panel.current?.focus({ preventScroll: true });
  }
  setMaximum(maximumChatWidth());
  setCompact(isCompactChatViewport());
}

function observeChatViewport(
  setMaximum: React.Dispatch<React.SetStateAction<number>>,
  setCompact: React.Dispatch<React.SetStateAction<boolean>>,
  drag: ChatResizeDrag,
  resizeHandle: React.RefObject<HTMLDivElement | null>,
  panel: React.RefObject<HTMLElement | null>,
  setPreviewWidth: React.Dispatch<React.SetStateAction<number | null>>,
  open: boolean,
): () => void {
  const listener = updateChatViewport.bind(
    null,
    setMaximum,
    setCompact,
    drag,
    resizeHandle,
    panel,
    setPreviewWidth,
    open,
  );
  window.addEventListener("resize", listener);
  return window.removeEventListener.bind(window, "resize", listener);
}

function beginChatResize(
  drag: ChatResizeDrag,
  width: number,
  finishKeyboardResize: () => void,
  event: React.PointerEvent<HTMLDivElement>,
): void {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  finishKeyboardResize();
  event.currentTarget.focus();
  event.currentTarget.setPointerCapture(event.pointerId);
  drag.current = { pointerId: event.pointerId, startX: event.clientX, width, currentWidth: width, moved: false };
}

function moveChatResize(
  drag: ChatResizeDrag,
  setPreviewWidth: React.Dispatch<React.SetStateAction<number | null>>,
  event: React.PointerEvent<HTMLDivElement>,
): void {
  if (drag.current === null || drag.current.pointerId !== event.pointerId)
    return;
  event.stopPropagation();
  drag.current.currentWidth = clampChatWidth(drag.current.width + drag.current.startX - event.clientX);
  drag.current.moved = true;
  setPreviewWidth(drag.current.currentWidth);
}

function endChatResize(
  drag: ChatResizeDrag,
  setPreviewWidth: React.Dispatch<React.SetStateAction<number | null>>,
  preferences: UserPreferenceOwner | null,
  setUnsignedWidth: React.Dispatch<React.SetStateAction<number>>,
  event: React.PointerEvent<HTMLDivElement>,
): void {
  if (drag.current?.pointerId !== event.pointerId) return;
  const final = drag.current;
  drag.current = null;
  if (final.moved) saveChatWidth(preferences, setUnsignedWidth, final.currentWidth);
  setPreviewWidth(null);
  if (event.currentTarget.hasPointerCapture(event.pointerId))
    event.currentTarget.releasePointerCapture(event.pointerId);
}

function resizeChatWithKeyboard(
  chat: WorkspaceChat,
  drag: ChatResizeDrag,
  width: number,
  setPreviewWidth: React.Dispatch<React.SetStateAction<number | null>>,
  keyboard: KeyboardResize,
  preferences: UserPreferenceOwner | null,
  setUnsignedWidth: React.Dispatch<React.SetStateAction<number>>,
  event: React.KeyboardEvent<HTMLDivElement>,
): void {
  let next: number;
  switch (event.key) {
    case "Escape":
      resetChatResize(drag, setPreviewWidth, event.currentTarget);
      closeChatOnEscape(chat, event);
      return;
    case "ArrowLeft":
      next = width + 50;
      break;
    case "ArrowRight":
      next = width - 50;
      break;
    case "Home":
      next = minimumChatWidth();
      break;
    case "End":
      next = maximumChatWidth();
      break;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
  resetChatResize(drag, setPreviewWidth, event.currentTarget);
  const value = clampChatWidth(next);
  setPreviewWidth(value);
  keyboard.current.width = value;
  if (keyboard.current.timer !== null) clearTimeout(keyboard.current.timer);
  keyboard.current.timer = setTimeout(flushKeyboardResize.bind(null, keyboard, preferences, setUnsignedWidth, setPreviewWidth), 250);
}

function cancelChatResize(
  drag: ChatResizeDrag,
  setPreviewWidth: React.Dispatch<React.SetStateAction<number | null>>,
  event: React.PointerEvent<HTMLDivElement>,
): void {
  if (drag.current?.pointerId !== event.pointerId) return;
  resetChatResize(drag, setPreviewWidth, event.currentTarget);
}
function resetChatResize(
  drag: ChatResizeDrag,
  setPreviewWidth: React.Dispatch<React.SetStateAction<number | null>>,
  handle: HTMLDivElement | null,
): void {
  const resize = drag.current;
  if (resize === null) return;
  drag.current = null;
  setPreviewWidth(null);
  if (handle?.hasPointerCapture(resize.pointerId)) {
    handle.releasePointerCapture(resize.pointerId);
  }
}
function cancelHiddenChatResize(
  drag: ChatResizeDrag,
  resizeHandle: React.RefObject<HTMLDivElement | null>,
  setPreviewWidth: React.Dispatch<React.SetStateAction<number | null>>,
  open: boolean,
  fullscreen: boolean,
): void {
  if (!open || fullscreen) {
    resetChatResize(drag, setPreviewWidth, resizeHandle.current);
  }
}
function saveChatWidth(preferences: UserPreferenceOwner | null, setUnsignedWidth: React.Dispatch<React.SetStateAction<number>>, width: number): void {
  const widthPx = Math.max(340, Math.round(width));
  if (preferences === null) setUnsignedWidth(widthPx);
  else preferences.edit({ area: "chat", command: { kind: "set_docked_chat_width", widthPx } });
}
function flushKeyboardResize(keyboard: KeyboardResize, preferences: UserPreferenceOwner | null, setUnsignedWidth: React.Dispatch<React.SetStateAction<number>>, setPreviewWidth: React.Dispatch<React.SetStateAction<number | null>>): void {
  if (keyboard.current.timer !== null) clearTimeout(keyboard.current.timer);
  keyboard.current.timer = null;
  if (keyboard.current.width === null) return;
  const width = keyboard.current.width;
  keyboard.current.width = null;
  saveChatWidth(preferences, setUnsignedWidth, width);
  setPreviewWidth(null);
}

function keyboardCleanup(keyboard: KeyboardResize): () => void {
  return cancelKeyboardResize.bind(null, keyboard);
}
function cancelKeyboardResize(keyboard: KeyboardResize): void {
  if (keyboard.current.timer !== null) clearTimeout(keyboard.current.timer);
  keyboard.current = { timer: null, width: null };
}
