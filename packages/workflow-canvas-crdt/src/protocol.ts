import { isCollaborationAgentActivities, type CollaborationAgentActivity } from "@seams/collaboration";
import {
  COLLABORATION_POINTER_IDLE_MS,
  COLLABORATION_PRESENCE_EXPIRY_MS,
  COLLABORATION_SOCKET_LIMIT,
  decodeProtocolBytes,
  encodeProtocolBytes,
  encodeProtocolFrame,
  hasExactMessageFields,
  isCollaborationOperationId,
  isCollaborationPointer,
  isCollaborationPointerPosition,
  isCollaborationPresenceState,
  isShortProtocolText,
  parseProtocolFrame,
  type CollaborationParticipant,
  type CollaborationPointerPosition,
} from "@seams/collaboration";
import {
  CANVAS_ENCODING_LIMITS,
  CanvasEncoding,
  type CanvasFailureCode,
} from "./index";

type CanvasUpdate = CanvasEncoding<"update">;
type CanvasStateVector = CanvasEncoding<"state_vector">;
export type CanvasSelection = Readonly<{ objectId: string }>;
import { assertNever, isPositiveInteger, isRecord } from "@seams/std";

export const CANVAS_PROTOCOL = "workflow_canvas_sync.v2";
// A full snapshot and its state vector travel together as base64 in one frame.
export const FRAME_LIMIT =
  4 *
    (Math.ceil(CANVAS_ENCODING_LIMITS.state / 3) +
      Math.ceil(CANVAS_ENCODING_LIMITS.stateVector / 3)) +
  1024;
export const SOCKET_LIMIT = COLLABORATION_SOCKET_LIMIT;
export const PRESENCE_EXPIRY_MS = COLLABORATION_PRESENCE_EXPIRY_MS;
export const POINTER_IDLE_MS = COLLABORATION_POINTER_IDLE_MS;

export type CanvasProtocolFailureCode =
  | CanvasFailureCode
  | "invalid_message"
  | "access_revoked"
  | "storage_unavailable"
  | "room_full";
export type CanvasParticipant = CollaborationParticipant<CanvasSelection>;
export type CanvasClientMessage =
  | Readonly<{
      kind: "pointer_update";
      position: CollaborationPointerPosition | null;
    }>
  | Readonly<{
      kind: "presence_update";
      state: "viewing" | "editing";
      selection: CanvasSelection | null;
    }>
  | Readonly<{ kind: "sync_request"; stateVector: CanvasStateVector }>
  | Readonly<{
      kind: "submit_update";
      updateId: string;
      update: CanvasUpdate;
    }>;
export type CanvasRoomMetadata = Readonly<{ documentRevision: number }>;
export type CanvasLastChange = "initial" | "human" | "agent";

export type CanvasServerMessage =
  | (Readonly<{
      kind: "sync_response";
      serverStateVector: CanvasStateVector;
      missingUpdate: CanvasUpdate;
      access: "read" | "edit";
      sessionId: string;
      lastChange: CanvasLastChange;
    }> &
      CanvasRoomMetadata)
  | Readonly<{
      kind: "update_accepted";
      updateId: string;
      lastChange: CanvasLastChange;
    }>
  | Readonly<{
      kind: "update_broadcast";
      update: CanvasUpdate;
      lastChange: CanvasLastChange;
    }>
  | Readonly<{
      kind: "presence_changed";
      participants: readonly CanvasParticipant[];
      agents: readonly CollaborationAgentActivity[];
    }>
  // The canvas's chat changed. The frame carries no content: the page reads
  // the chat through its checked route.
  | Readonly<{ kind: "chat_changed" }>
  | Readonly<{ kind: "failure"; code: CanvasProtocolFailureCode }>;

type Parsed<T> =
  | Readonly<{ ok: true; value: T; error?: never }>
  | Readonly<{
      ok: false;
      error: Readonly<{ code: CanvasProtocolFailureCode }>;
      value?: never;
    }>;

export function parseCanvasClientMessage(
  frame: unknown,
): Parsed<CanvasClientMessage> {
  const raw = parseProtocolFrame(frame, CANVAS_PROTOCOL, FRAME_LIMIT);
  if (raw === null) return invalid();
  switch (raw.kind) {
    case "pointer_update":
      return hasExactMessageFields(raw, "position") &&
        isCollaborationPointerPosition(raw.position)
        ? {
            ok: true,
            value: { kind: "pointer_update", position: raw.position },
          }
        : invalid();
    case "presence_update":
      return hasExactMessageFields(raw, "state", "selection") &&
        isCollaborationPresenceState(raw.state) &&
        isCanvasSelection(raw.selection)
        ? {
            ok: true,
            value: {
              kind: "presence_update",
              state: raw.state,
              selection: raw.selection,
            },
          }
        : invalid();
    case "sync_request": {
      if (!hasExactMessageFields(raw, "stateVector")) return invalid();
      const bytes = decodeProtocolBytes(raw.stateVector);
      if (bytes === null) return invalid();
      const stateVector = CanvasEncoding.parse("state_vector", bytes);
      return stateVector.ok
        ? {
            ok: true,
            value: { kind: "sync_request", stateVector: stateVector.value },
          }
        : stateVector;
    }
    case "submit_update": {
      if (
        !hasExactMessageFields(raw, "updateId", "update") ||
        !isCollaborationOperationId(raw.updateId)
      )
        return invalid();
      const bytes = decodeProtocolBytes(raw.update);
      if (bytes === null) return invalid();
      const update = CanvasEncoding.parse("update", bytes);
      return update.ok
        ? {
            ok: true,
            value: {
              kind: "submit_update",
              updateId: raw.updateId,
              update: update.value,
            },
          }
        : update;
    }
    default:
      return invalid();
  }
}

export function parseCanvasServerMessage(
  frame: unknown,
): Parsed<CanvasServerMessage> {
  const raw = parseProtocolFrame(frame, CANVAS_PROTOCOL, FRAME_LIMIT);
  if (raw === null) return invalid();
  switch (raw.kind) {
    case "sync_response": {
      if (
        !hasExactMessageFields(
          raw,
          "serverStateVector",
          "missingUpdate",
          "documentRevision",
          "access",
          "sessionId",
          "lastChange",
        ) ||
        !isCanvasLastChange(raw.lastChange) ||
        !isPositiveInteger(raw.documentRevision) ||
        !isShortProtocolText(raw.sessionId) ||
        (raw.access !== "read" && raw.access !== "edit")
      )
        return invalid();
      const vectorBytes = decodeProtocolBytes(raw.serverStateVector);
      const updateBytes = decodeProtocolBytes(raw.missingUpdate);
      if (vectorBytes === null || updateBytes === null) return invalid();
      const vector = CanvasEncoding.parse("state_vector", vectorBytes);
      const update = CanvasEncoding.parse("update", updateBytes);
      if (!vector.ok) return vector;
      if (!update.ok) return update;
      return {
        ok: true,
        value: {
          kind: "sync_response",
          serverStateVector: vector.value,
          missingUpdate: update.value,
          documentRevision: raw.documentRevision,
          access: raw.access,
          sessionId: raw.sessionId,
          lastChange: raw.lastChange,
        },
      };
    }
    case "update_accepted":
      return hasExactMessageFields(raw, "updateId", "lastChange") &&
        isCanvasLastChange(raw.lastChange) &&
        isCollaborationOperationId(raw.updateId)
        ? {
            ok: true,
            value: {
              kind: "update_accepted",
              updateId: raw.updateId,
              lastChange: raw.lastChange,
            },
          }
        : invalid();
    case "update_broadcast": {
      if (
        !hasExactMessageFields(raw, "update", "lastChange") ||
        !isCanvasLastChange(raw.lastChange)
      )
        return invalid();
      const bytes = decodeProtocolBytes(raw.update);
      if (bytes === null) return invalid();
      const update = CanvasEncoding.parse("update", bytes);
      return update.ok
        ? {
            ok: true,
            value: {
              kind: "update_broadcast",
              update: update.value,
              lastChange: raw.lastChange,
            },
          }
        : update;
    }
    case "presence_changed": {
      if (
        !hasExactMessageFields(raw, "participants", "agents") ||
        !isCollaborationAgentActivities(raw.agents) ||
        !Array.isArray(raw.participants) ||
        raw.participants.length > SOCKET_LIMIT
      )
        return invalid();
      const participants: CanvasParticipant[] = [];
      for (const participant of raw.participants) {
        if (!isCanvasParticipant(participant)) return invalid();
        participants.push(participant);
      }
      return {
        ok: true,
        value: {
          kind: "presence_changed",
          participants,
          agents: raw.agents,
        },
      };
    }
    case "chat_changed":
      return hasExactMessageFields(raw)
        ? { ok: true, value: { kind: "chat_changed" } }
        : invalid();
    case "failure":
      return hasExactMessageFields(raw, "code") && isFailureCode(raw.code)
        ? { ok: true, value: { kind: "failure", code: raw.code } }
        : invalid();
    default:
      return invalid();
  }
}

export function encodeCanvasClientMessage(
  message: CanvasClientMessage,
): string {
  switch (message.kind) {
    case "sync_request":
      return envelope({
        kind: message.kind,
        stateVector: encodeProtocolBytes(message.stateVector.encode()),
      });
    case "submit_update":
      return envelope({
        kind: message.kind,
        updateId: message.updateId,
        update: encodeProtocolBytes(message.update.encode()),
      });
    case "presence_update":
    case "pointer_update":
      return envelope(message);
    default:
      return assertNever(message, "Unexpected workflow canvas protocol branch");
  }
}

export function encodeCanvasServerMessage(
  message: CanvasServerMessage,
): string {
  switch (message.kind) {
    case "sync_response":
      return envelope({
        kind: message.kind,
        serverStateVector: encodeProtocolBytes(
          message.serverStateVector.encode(),
        ),
        missingUpdate: encodeProtocolBytes(message.missingUpdate.encode()),
        documentRevision: message.documentRevision,
        access: message.access,
        sessionId: message.sessionId,
        lastChange: message.lastChange,
      });
    case "update_broadcast":
      return envelope({
        kind: message.kind,
        update: encodeProtocolBytes(message.update.encode()),
        lastChange: message.lastChange,
      });
    case "update_accepted":
    case "presence_changed":
    case "chat_changed":
    case "failure":
      return envelope(message);
    default:
      return assertNever(message, "Unexpected workflow canvas protocol branch");
  }
}

export function isCanvasLastChange(value: unknown): value is CanvasLastChange {
  return value === "initial" || value === "human" || value === "agent";
}

function isCanvasSelection(value: unknown): value is CanvasSelection | null {
  if (value === null) return true;
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.objectId === "string" &&
    /^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(value.objectId)
  );
}

function isCanvasParticipant(value: unknown): value is CanvasParticipant {
  return (
    isRecord(value) &&
    Object.keys(value).length === 7 &&
    isShortProtocolText(value.sessionId) &&
    isShortProtocolText(value.userId) &&
    isShortProtocolText(value.displayName) &&
    isCollaborationPresenceState(value.state) &&
    isCanvasSelection(value.selection) &&
    typeof value.activeAt === "number" &&
    Number.isSafeInteger(value.activeAt) &&
    value.activeAt >= 0 &&
    isCollaborationPointer(value.pointer)
  );
}

function isFailureCode(value: unknown): value is CanvasProtocolFailureCode {
  switch (value) {
    case "invalid_state":
    case "invalid_update":
    case "invalid_state_vector":
    case "invalid_layout":
    case "object_conflict":
    case "update_too_large":
    case "state_too_large":
    case "state_vector_too_large":
    case "invalid_message":
    case "access_revoked":
    case "storage_unavailable":
    case "room_full":
      return true;
    default:
      return false;
  }
}

function envelope(value: Readonly<Record<string, unknown>>): string {
  return encodeProtocolFrame(CANVAS_PROTOCOL, value);
}

function invalid(): Parsed<never> {
  return { ok: false, error: { code: "invalid_message" } };
}
