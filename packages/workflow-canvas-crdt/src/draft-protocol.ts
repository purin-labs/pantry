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
  DRAFT_ENCODING_LIMITS,
  DraftEncoding,
  type DraftFailureCode,
} from "./draft";

type DraftUpdate = DraftEncoding<"update">;
type DraftStateVector = DraftEncoding<"state_vector">;
export type DraftSelection = Readonly<{ objectId: string }>;
import { assertNever, isPositiveInteger, isRecord } from "@seams/std";

export const DRAFT_PROTOCOL = "workflow_draft_sync.v1";
// A full snapshot and its state vector travel together as base64 in one frame.
export const FRAME_LIMIT =
  4 *
    (Math.ceil(DRAFT_ENCODING_LIMITS.state / 3) +
      Math.ceil(DRAFT_ENCODING_LIMITS.stateVector / 3)) +
  1024;
export const SOCKET_LIMIT = COLLABORATION_SOCKET_LIMIT;
export const PRESENCE_EXPIRY_MS = COLLABORATION_PRESENCE_EXPIRY_MS;
export const POINTER_IDLE_MS = COLLABORATION_POINTER_IDLE_MS;

export type DraftProtocolFailureCode =
  | DraftFailureCode
  | "invalid_message"
  | "access_revoked"
  | "storage_unavailable"
  | "room_full";
export type DraftParticipant = CollaborationParticipant<DraftSelection>;
export type DraftClientMessage =
  | Readonly<{
      kind: "pointer_update";
      position: CollaborationPointerPosition | null;
    }>
  | Readonly<{
      kind: "presence_update";
      state: "viewing" | "editing";
      selection: DraftSelection | null;
    }>
  | Readonly<{ kind: "sync_request"; stateVector: DraftStateVector }>
  | Readonly<{
      kind: "submit_update";
      updateId: string;
      update: DraftUpdate;
    }>;
export type DraftRoomMetadata = Readonly<{ documentRevision: number }>;

export type DraftServerMessage =
  | (Readonly<{
      kind: "sync_response";
      serverStateVector: DraftStateVector;
      missingUpdate: DraftUpdate;
      access: "read" | "edit";
      sessionId: string;
    }> &
      DraftRoomMetadata)
  | Readonly<{
      kind: "update_accepted";
      updateId: string;
    }>
  | Readonly<{
      kind: "update_broadcast";
      update: DraftUpdate;
    }>
  | Readonly<{
      kind: "presence_changed";
      participants: readonly DraftParticipant[];
    }>
  // A person applied a revision. The page reads it through its checked route.
  | Readonly<{ kind: "revision_changed" }>
  | Readonly<{ kind: "failure"; code: DraftProtocolFailureCode }>;

type Parsed<T> =
  | Readonly<{ ok: true; value: T; error?: never }>
  | Readonly<{
      ok: false;
      error: Readonly<{ code: DraftProtocolFailureCode }>;
      value?: never;
    }>;

export function parseDraftClientMessage(
  frame: unknown,
): Parsed<DraftClientMessage> {
  const raw = parseProtocolFrame(frame, DRAFT_PROTOCOL, FRAME_LIMIT);
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
        isDraftSelection(raw.selection)
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
      const stateVector = DraftEncoding.parse("state_vector", bytes);
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
      const update = DraftEncoding.parse("update", bytes);
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

export function parseDraftServerMessage(
  frame: unknown,
): Parsed<DraftServerMessage> {
  const raw = parseProtocolFrame(frame, DRAFT_PROTOCOL, FRAME_LIMIT);
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
        ) ||
        !isPositiveInteger(raw.documentRevision) ||
        !isShortProtocolText(raw.sessionId) ||
        (raw.access !== "read" && raw.access !== "edit")
      )
        return invalid();
      const vectorBytes = decodeProtocolBytes(raw.serverStateVector);
      const updateBytes = decodeProtocolBytes(raw.missingUpdate);
      if (vectorBytes === null || updateBytes === null) return invalid();
      const vector = DraftEncoding.parse("state_vector", vectorBytes);
      const update = DraftEncoding.parse("update", updateBytes);
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
        },
      };
    }
    case "update_accepted":
      return hasExactMessageFields(raw, "updateId") &&
        isCollaborationOperationId(raw.updateId)
        ? {
            ok: true,
            value: {
              kind: "update_accepted",
              updateId: raw.updateId,
            },
          }
        : invalid();
    case "update_broadcast": {
      if (!hasExactMessageFields(raw, "update")) return invalid();
      const bytes = decodeProtocolBytes(raw.update);
      if (bytes === null) return invalid();
      const update = DraftEncoding.parse("update", bytes);
      return update.ok
        ? {
            ok: true,
            value: {
              kind: "update_broadcast",
              update: update.value,
            },
          }
        : update;
    }
    case "presence_changed": {
      if (
        !hasExactMessageFields(raw, "participants") ||
        !Array.isArray(raw.participants) ||
        raw.participants.length > SOCKET_LIMIT
      )
        return invalid();
      const participants: DraftParticipant[] = [];
      for (const participant of raw.participants) {
        if (!isDraftParticipant(participant)) return invalid();
        participants.push(participant);
      }
      return {
        ok: true,
        value: {
          kind: "presence_changed",
          participants,
        },
      };
    }
    case "revision_changed":
      return hasExactMessageFields(raw)
        ? { ok: true, value: { kind: "revision_changed" } }
        : invalid();
    case "failure":
      return hasExactMessageFields(raw, "code") && isFailureCode(raw.code)
        ? { ok: true, value: { kind: "failure", code: raw.code } }
        : invalid();
    default:
      return invalid();
  }
}

export function encodeDraftClientMessage(message: DraftClientMessage): string {
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
      return assertNever(message, "Unexpected workflow draft protocol branch");
  }
}

export function encodeDraftServerMessage(message: DraftServerMessage): string {
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
      });
    case "update_broadcast":
      return envelope({
        kind: message.kind,
        update: encodeProtocolBytes(message.update.encode()),
      });
    case "update_accepted":
    case "presence_changed":
    case "revision_changed":
    case "failure":
      return envelope(message);
    default:
      return assertNever(message, "Unexpected workflow draft protocol branch");
  }
}

function isDraftSelection(value: unknown): value is DraftSelection | null {
  if (value === null) return true;
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.objectId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,255}$/.test(value.objectId)
  );
}

function isDraftParticipant(value: unknown): value is DraftParticipant {
  return (
    isRecord(value) &&
    Object.keys(value).length === 7 &&
    isShortProtocolText(value.sessionId) &&
    isShortProtocolText(value.userId) &&
    isShortProtocolText(value.displayName) &&
    isCollaborationPresenceState(value.state) &&
    isDraftSelection(value.selection) &&
    typeof value.activeAt === "number" &&
    Number.isSafeInteger(value.activeAt) &&
    value.activeAt >= 0 &&
    isCollaborationPointer(value.pointer)
  );
}

function isFailureCode(value: unknown): value is DraftProtocolFailureCode {
  switch (value) {
    case "invalid_state":
    case "invalid_update":
    case "invalid_state_vector":
    case "invalid_draft":
    case "object_limit":
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
  return encodeProtocolFrame(DRAFT_PROTOCOL, value);
}

function invalid(): Parsed<never> {
  return { ok: false, error: { code: "invalid_message" } };
}
