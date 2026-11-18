import React from "react";
import { MousePointer2 } from "lucide-react";
import { POINTER_IDLE_MS, type DraftPointer } from "@seams/product-description-crdt/protocol";
import "./styles.css";

export type DraftPresenceView = Readonly<{
  sessionId: string;
  userId: string;
  displayName: string;
  state: "viewing" | "editing";
  selection: Readonly<{
    start: number;
    end: number;
    direction: "forward" | "backward" | "none";
  }> | null;
  activeAt: number;
  pointer: DraftPointer | null;
  isSelf: boolean;
}>;

type OverlayProps = Readonly<{
  textarea: React.RefObject<HTMLTextAreaElement | null>;
  participants: readonly DraftPresenceView[];
}>;

type CaretMark = Readonly<{ participant: DraftPresenceView; left: number; top: number; height: number }>;
type SelectionMark = Readonly<{ participant: DraftPresenceView; left: number; top: number; width: number; height: number }>;
type OverlayGeometry = Readonly<{ carets: readonly CaretMark[]; selections: readonly SelectionMark[] }>;
type MirrorStyle = Readonly<{ cssText: string; width: number; height: number }>;

const IDLE_AFTER_MS = 5_000;
const EMPTY_GEOMETRY: OverlayGeometry = { carets: [], selections: [] };
const PRESENCE_COLORS = [
  "#b45309",
  "#0f766e",
  "#2563eb",
  "#be185d",
  "#7c3aed",
  "#15803d",
  "#c2410c",
  "#0369a1",
] as const;

export function DraftPresenceOverlay(props: OverlayProps): React.ReactNode {
  const [geometry, setGeometry] = React.useState<OverlayGeometry>(EMPTY_GEOMETRY);
  const [, setNow] = React.useState(Date.now);
  const mirror = React.useRef<HTMLDivElement>(null);
  const frame = React.useRef<number | null>(null);
  const schedule = React.useCallback(
    scheduleMeasurement.bind(null, props.textarea, mirror, props.participants, setGeometry, frame),
    [props.textarea, props.participants],
  );

  React.useLayoutEffect(schedule, [schedule, props.participants]);
  React.useEffect(bindOverlayTracking.bind(null, props.textarea, schedule, frame), [props.textarea, schedule, frame]);
  React.useEffect(setSelfCaretColor.bind(null, props.textarea, props.participants), [props.textarea, props.participants]);
  React.useEffect(bindIdleClock.bind(null, setNow), []);

  return (
    <div className="description-draft-presence-overlay" aria-hidden="true">
      <div ref={mirror} className="description-draft-presence-mirror" />
      <div className="description-draft-presence-marks">
        {geometry.selections.map(renderSelectionMark)}
        {geometry.carets.map(renderCaretMark)}
      </div>
    </div>
  );
}

export function DraftParticipants(props: Readonly<{ participants: readonly DraftPresenceView[] }>): React.ReactNode {
  if (props.participants.length === 0) return null;
  return (
    <div className="description-draft-participants">
      {props.participants.map(renderParticipant.bind(null, props.participants.length))}
    </div>
  );
}

export function DraftMousePointers(props: Readonly<{ participants: readonly DraftPresenceView[] }>): React.ReactNode {
  const [, setNow] = React.useState(Date.now);
  React.useEffect(bindIdleClock.bind(null, setNow), []);
  return <div className="description-draft-mouse-layer" aria-hidden="true">
    {props.participants.map(renderMousePointer)}
  </div>;
}

function renderMousePointer(participant: DraftPresenceView): React.ReactNode {
  const pointer = participant.pointer;
  if (participant.isSelf || pointer === null || Date.now() - pointer.updatedAt >= POINTER_IDLE_MS) return null;
  const { x, y } = pointer.position;
  return <span key={participant.sessionId}
    className={`description-draft-mouse-pointer${x > 0.75 ? " label-left" : ""}${y > 0.85 ? " label-above" : ""}`}
    style={{ ...colorStyle(participant), left: `${x * 100}%`, top: `${y * 100}%` }}>
    <MousePointer2 size={20} fill="currentColor" stroke="white" strokeWidth={1.5} />
    <span className="description-draft-mouse-name">{participant.displayName}</span>
  </span>;
}

function renderParticipant(total: number, participant: DraftPresenceView): React.ReactNode {
  return (
    <span key={participant.sessionId} className="description-draft-participant" style={colorStyle(participant)}>
      <span className="description-draft-participant-dot" />
      <span>{participant.displayName}</span>
      {total < 4 && (
        <span className="description-draft-participant-state">
          {participant.state === "editing" ? "editing" : "viewing"}
        </span>
      )}
    </span>
  );
}

function renderSelectionMark(mark: SelectionMark): React.ReactNode {
  return (
    <span
      key={`${mark.participant.sessionId}-selection-${mark.left}-${mark.top}`}
      className="description-draft-presence-selection"
      style={{ ...colorStyle(mark.participant), left: mark.left, top: mark.top, width: mark.width, height: mark.height }}
    />
  );
}

function renderCaretMark(mark: CaretMark): React.ReactNode {
  const idle = Date.now() - mark.participant.activeAt >= IDLE_AFTER_MS;
  const labelPlacement = mark.top < 24 ? " is-below" : "";
  return (
    <span
      key={`${mark.participant.sessionId}-caret-${mark.left}-${mark.top}`}
      className={`description-draft-presence-caret${idle ? " is-idle" : ""}${labelPlacement}`}
      style={{ ...colorStyle(mark.participant), left: mark.left, top: mark.top, height: mark.height }}
    >
      <span className="description-draft-presence-label">{mark.participant.displayName}</span>
    </span>
  );
}

function colorStyle(participant: DraftPresenceView): React.CSSProperties {
  const color = participantColor(participant);
  return { ["--presence-color" as string]: color, ["--presence-tint" as string]: `${color}2e` };
}

function participantColor(participant: DraftPresenceView): string {
  let hash = 2166136261;
  for (const character of participant.userId) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return (
    PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length] ??
    PRESENCE_COLORS[0]
  );
}

function bindOverlayTracking(
  textarea: React.RefObject<HTMLTextAreaElement | null>,
  schedule: () => void,
  frame: React.MutableRefObject<number | null>,
): () => void {
  const element = textarea.current;
  if (element === null) return noCleanup;
  element.addEventListener("input", schedule);
  element.addEventListener("select", schedule);
  element.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  const resizeObserver = new ResizeObserver(schedule);
  resizeObserver.observe(element);
  void document.fonts?.ready.then(schedule);
  return unbindOverlayTracking.bind(null, element, schedule, resizeObserver, frame);
}

function unbindOverlayTracking(
  element: HTMLTextAreaElement,
  schedule: () => void,
  resizeObserver: ResizeObserver,
  frame: React.MutableRefObject<number | null>,
): void {
  element.removeEventListener("input", schedule);
  element.removeEventListener("select", schedule);
  element.removeEventListener("scroll", schedule);
  window.removeEventListener("resize", schedule);
  resizeObserver.disconnect();
  if (frame.current !== null) cancelAnimationFrame(frame.current);
  frame.current = null;
}

function scheduleMeasurement(
  textarea: React.RefObject<HTMLTextAreaElement | null>,
  mirror: React.RefObject<HTMLDivElement | null>,
  participants: readonly DraftPresenceView[],
  setGeometry: React.Dispatch<React.SetStateAction<OverlayGeometry>>,
  frame: React.MutableRefObject<number | null>,
): void {
  if (frame.current !== null) cancelAnimationFrame(frame.current);
  frame.current = requestAnimationFrame(measurePresence.bind(null, textarea, mirror, participants, setGeometry, frame));
}

function measurePresence(
  textarea: React.RefObject<HTMLTextAreaElement | null>,
  mirror: React.RefObject<HTMLDivElement | null>,
  participants: readonly DraftPresenceView[],
  setGeometry: React.Dispatch<React.SetStateAction<OverlayGeometry>>,
  frame: React.MutableRefObject<number | null>,
): void {
  frame.current = null;
  const element = textarea.current;
  const mirrorElement = mirror.current;
  if (element === null || mirrorElement === null) return;
  const style = mirrorStyle(element);
  mirrorElement.style.cssText = style.cssText;
  mirrorElement.style.width = `${style.width}px`;
  mirrorElement.style.height = `${style.height}px`;
  mirrorElement.style.marginLeft = `${-element.scrollLeft}px`;
  mirrorElement.style.marginTop = `${-element.scrollTop}px`;
  mirrorElement.textContent = `${element.value}\u200b`;
  const textNode = mirrorElement.firstChild;
  if (textNode === null) return;
  const textareaRect = element.getBoundingClientRect();
  const marks = participants
    .filter(isRemoteWithSelection)
    .flatMap(measureParticipant.bind(null, textNode, textareaRect));
  setGeometry({ carets: marks.filter(isCaretMark), selections: marks.filter(isSelectionMark) });
}

function isRemoteWithSelection(participant: DraftPresenceView): boolean {
  return !participant.isSelf && participant.selection !== null;
}

function measureParticipant(
  textNode: Node,
  textareaRect: DOMRect,
  participant: DraftPresenceView,
): readonly (CaretMark | SelectionMark)[] {
  const selection = participant.selection;
  if (selection === null) return [];
  const rangeStart = Math.max(0, Math.min(selection.start, selection.end));
  const rangeEnd = Math.max(rangeStart, Math.max(selection.start, selection.end));
  const caretIndex = selection.direction === "backward" ? rangeStart : rangeEnd;
  const textLength = textNode.textContent?.length ?? 0;
  const start = clampOffset(rangeStart, textLength);
  const end = clampOffset(rangeEnd, textLength);
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const rects = Array.from(range.getClientRects());
  const marks: Array<CaretMark | SelectionMark> = [];
  if (start !== end) {
    for (const rect of rects) {
      marks.push({
        participant,
        left: rect.left - textareaRect.left,
        top: rect.top - textareaRect.top,
        width: rect.width,
        height: rect.height,
      });
    }
  }
  const caretRange = document.createRange();
  const caretOffset = clampOffset(caretIndex, textLength);
  caretRange.setStart(textNode, caretOffset);
  caretRange.setEnd(textNode, caretOffset);
  const caretRect = caretRange.getBoundingClientRect();
  marks.push({
    participant,
    left: caretRect.left - textareaRect.left,
    top: caretRect.top - textareaRect.top,
    height: caretRect.height || parseFloat(getComputedStyle(document.body).lineHeight) || 20,
  });
  return marks;
}

function clampOffset(offset: number, textLength: number): number {
  return Math.min(Math.max(offset, 0), textLength);
}

function isCaretMark(mark: CaretMark | SelectionMark): mark is CaretMark {
  return "height" in mark && !("width" in mark);
}

function isSelectionMark(mark: CaretMark | SelectionMark): mark is SelectionMark {
  return "width" in mark;
}

function mirrorStyle(textarea: HTMLTextAreaElement): MirrorStyle {
  const computed = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const mirroredProperties = [
    "font", "font-family", "font-size", "font-weight", "font-style", "letter-spacing",
    "line-height", "text-align", "text-indent", "text-transform", "word-spacing",
    "white-space", "word-wrap", "overflow-wrap", "padding", "border", "box-sizing",
  ];
  for (const property of mirroredProperties) {
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  }
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  const rect = textarea.getBoundingClientRect();
  const width = textarea.clientWidth + parseFloat(computed.borderLeftWidth) + parseFloat(computed.borderRightWidth);
  mirror.style.width = `${width}px`;
  mirror.style.height = `${rect.height}px`;
  return { cssText: mirror.style.cssText, width, height: rect.height };
}

function findSelfParticipant(participants: readonly DraftPresenceView[]): DraftPresenceView | undefined {
  for (const participant of participants) {
    if (participant.isSelf) return participant;
  }
  return undefined;
}

function setSelfCaretColor(textarea: React.RefObject<HTMLTextAreaElement | null>, participants: readonly DraftPresenceView[]): () => void {
  const element = textarea.current;
  const self = findSelfParticipant(participants);
  if (element === null || self === undefined) return noCleanup;
  const previous = element.style.caretColor;
  element.style.caretColor = participantColor(self);
  return restoreCaretColor.bind(null, element, previous);
}

function restoreCaretColor(element: HTMLTextAreaElement, previous: string): void {
  element.style.caretColor = previous;
}

function bindIdleClock(setNow: React.Dispatch<React.SetStateAction<number>>): () => void {
  const timer = window.setInterval(refreshClock.bind(null, setNow), 1_000);
  return window.clearInterval.bind(window, timer);
}

function refreshClock(setNow: React.Dispatch<React.SetStateAction<number>>): void {
  setNow(Date.now());
}

function noCleanup(): void {
  // The textarea may not be mounted when the effect first runs.
}
