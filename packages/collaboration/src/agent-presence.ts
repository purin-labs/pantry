import { hasExactKeys, isRecord } from "@seams/std";
import { isShortProtocolText, COLLABORATION_SOCKET_LIMIT } from "./wire";

/**
 * The colours of agents on a canvas (Plan 40B phase 7). They are apart from
 * the colours of people, so that an agent never looks like a person. The
 * default agent of an Organisation has the first key.
 */
export const COLLABORATION_AGENT_COLOR_KEYS = [
  "violet",
  "teal",
  "gold",
] as const;
export type CollaborationAgentColorKey =
  (typeof COLLABORATION_AGENT_COLOR_KEYS)[number];

export type CollaborationAgent = Readonly<{
  sessionId: string;
  displayName: string;
  /** Only a room that draws agents on a canvas sends the agent's colour. */
  colorKey?: CollaborationAgentColorKey;
}>;

/**
 * What an agent does on a canvas, at its real target (Plan 40B phase 7,
 * slice 1). The room sends it while the edit runs (`pending`) and for the
 * hold after an accepted edit (`applied`). It names no pointer travel: a
 * cursor shows only at the rect or the elements of a real edit.
 */
export type CollaborationAgentActionKind =
  | "create"
  | "move"
  | "resize"
  | "text"
  | "style"
  | "remove"
  | "comment"
  | "history";

export type CollaborationAgentRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type CollaborationAgentAction = Readonly<{
  kind: CollaborationAgentActionKind;
  /** The elements that the edit names; the first is its main target. */
  elementIds: readonly string[];
  /** The rect that the edit proposes, in board units; null for none. */
  rect: CollaborationAgentRect | null;
  /** The text field that the edit changes; null for none. */
  field: string | null;
  state: "pending" | "applied";
  /**
   * The text so far, while the model writes the arguments of a text edit
   * (slice 4). Only a draft preview sends it; the room never stores it.
   */
  text?: string;
}>;

export type CollaborationAgentActivity = Readonly<{
  agent: CollaborationAgent;
  operationId: string;
  target: string;
  /** Only a room that draws agents on a canvas sends an action. */
  action?: CollaborationAgentAction;
}>;

/** At most this many elements, as a person's drag presence. */
export const COLLABORATION_AGENT_ACTION_ELEMENTS = 12;
/** An action fits in the same space as a person's drag presence. */
export const COLLABORATION_AGENT_ACTION_BYTES = 900;
/** A draft text is at most as long as a board text prop. */
export const COLLABORATION_AGENT_DRAFT_TEXT_LIMIT = 280;
const ACTION_KINDS: ReadonlySet<string> = new Set<CollaborationAgentActionKind>(
  ["create", "move", "resize", "text", "style", "remove", "comment", "history"],
);
const COLOR_KEYS: ReadonlySet<string> = new Set(COLLABORATION_AGENT_COLOR_KEYS);
const RECT_LIMIT = 100_000;

export function isCollaborationAgentActivities(
  value: unknown,
): value is readonly CollaborationAgentActivity[] {
  if (!Array.isArray(value) || value.length > COLLABORATION_SOCKET_LIMIT)
    return false;
  const keys = new Set<string>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      !(
        hasExactKeys(item, ["agent", "operationId", "target"]) ||
        (hasExactKeys(item, ["agent", "operationId", "target", "action"]) &&
          isCollaborationAgentAction(item.action))
      ) ||
      !isCollaborationAgent(item.agent) ||
      !isShortProtocolText(item.operationId) ||
      !isShortProtocolText(item.target)
    )
      return false;
    const key = JSON.stringify([item.agent.sessionId, item.operationId]);
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function isCollaborationAgent(value: unknown): value is CollaborationAgent {
  return (
    isRecord(value) &&
    (hasExactKeys(value, ["sessionId", "displayName"]) ||
      (hasExactKeys(value, ["sessionId", "displayName", "colorKey"]) &&
        typeof value.colorKey === "string" &&
        COLOR_KEYS.has(value.colorKey))) &&
    isShortProtocolText(value.sessionId) &&
    isShortProtocolText(value.displayName)
  );
}

export function isCollaborationAgentAction(
  value: unknown,
): value is CollaborationAgentAction {
  if (!isRecord(value)) return false;
  const keys = ["kind", "elementIds", "rect", "field", "state"];
  const withText = Object.hasOwn(value, "text");
  if (!hasExactKeys(value, withText ? [...keys, "text"] : keys)) return false;
  // The draft text has its own limit, so the rest of the action keeps the
  // size of a drag presence.
  const { text, ...rest } = value;
  return (
    typeof value.kind === "string" &&
    ACTION_KINDS.has(value.kind) &&
    Array.isArray(value.elementIds) &&
    value.elementIds.length <= COLLABORATION_AGENT_ACTION_ELEMENTS &&
    value.elementIds.every(isShortProtocolText) &&
    new Set(value.elementIds).size === value.elementIds.length &&
    (value.rect === null || isAgentRect(value.rect)) &&
    (value.field === null || isShortProtocolText(value.field)) &&
    (value.state === "pending" || value.state === "applied") &&
    (!withText ||
      (typeof text === "string" &&
        [...text].length <= COLLABORATION_AGENT_DRAFT_TEXT_LIMIT)) &&
    new TextEncoder().encode(JSON.stringify(rest)).byteLength <=
      COLLABORATION_AGENT_ACTION_BYTES
  );
}

function isAgentRect(value: unknown): value is CollaborationAgentRect {
  if (!isRecord(value) || !hasExactKeys(value, ["x", "y", "width", "height"]))
    return false;
  return [value.x, value.y, value.width, value.height].every(
    (part) =>
      typeof part === "number" &&
      Number.isFinite(part) &&
      Math.abs(part) <= RECT_LIMIT,
  );
}
