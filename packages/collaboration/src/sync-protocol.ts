import { assertNever, isPositiveInteger, isRecord } from "@purin-labs/std";
import {
  isCollaborationAgentActivities,
  type CollaborationAgentActivity,
} from "./agent-presence.ts";
import {
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
} from "./wire.ts";

/**
 * The sync protocol of one shared document room: the same nine message kinds
 * for every document that uses it (Refactor 10, step 5). A document package
 * gives its protocol id, its frame limit, its selection check, its document
 * codecs and the metadata of its sync response; the frames stay byte for byte
 * as each package wrote them. A package can add fields to some server
 * messages, and server kinds without fields.
 *
 * A package reaches this file through `syncProtocol` of its shared document
 * (`shared-doc.ts`), which gives the document codecs and each failure code.
 */

/** The room metadata of a sync response when a package names none. */
export type SyncDocumentRevision = Readonly<{ documentRevision: number }>;

/**
 * Fields that a package adds to a message, in this order on the wire, and the
 * check of their values in a received frame.
 */
export type SyncMessageFields = Readonly<{
  fields: readonly string[];
  isValid: (raw: Readonly<Record<string, unknown>>) => boolean;
}>;

/**
 * The room fields of a sync response, between `missingUpdate` and `access`,
 * in this order on the wire.
 */
export type SyncRoomMetadata = SyncMessageFields;

const DOCUMENT_REVISION: SyncRoomMetadata = {
  fields: ["documentRevision"],
  isValid: (raw) => isPositiveInteger(raw.documentRevision),
};

const NO_FIELDS: SyncMessageFields = { fields: [], isValid: () => true };

const AGENTS: SyncMessageFields = {
  fields: ["agents"],
  isValid: (raw) => isCollaborationAgentActivities(raw.agents),
};

/**
 * The types of what a package adds to the server messages. A part without
 * added fields is `unknown`.
 */
export type SyncServerExtension = Readonly<{
  /** Fields after `sessionId` in a sync response. */
  syncResponse: unknown;
  /** Fields after `updateId` in an accepted update. */
  updateAccepted: unknown;
  /** Fields after `update` in a broadcast update. */
  updateBroadcast: unknown;
  /** Fields after `participants` in a presence frame. */
  presence: unknown;
  /** The server kinds without fields. */
  signal: string;
}>;

/** The server messages of a package that adds nothing. */
export type SyncBaseExtension = Readonly<{
  syncResponse: unknown;
  updateAccepted: unknown;
  updateBroadcast: unknown;
  presence: Readonly<{ agents: readonly CollaborationAgentActivity[] }>;
  signal: never;
}>;

type SyncSignal<Kind extends string> = Kind extends string
  ? Readonly<{ kind: Kind }>
  : never;

/** The failures that the room itself adds to a document's own failures. */
export type SyncRoomFailureCode =
  "invalid_message" | "access_revoked" | "storage_unavailable" | "room_full";

export type SyncFailureCode<DocumentCode extends string> =
  DocumentCode | SyncRoomFailureCode;

export type SyncParsed<T, Code extends string> =
  | Readonly<{ ok: true; value: T; error?: never }>
  | Readonly<{ ok: false; error: Readonly<{ code: Code }>; value?: never }>;

/** A document encoding that a frame carries as base64. */
type Encoded = { encode(): Uint8Array };

export type SyncClientMessage<Selection, StateVector, Update> =
  | Readonly<{
      kind: "pointer_update";
      position: CollaborationPointerPosition | null;
    }>
  | Readonly<{
      kind: "presence_update";
      state: "viewing" | "editing";
      selection: Selection | null;
    }>
  | Readonly<{ kind: "sync_request"; stateVector: StateVector }>
  | Readonly<{ kind: "submit_update"; updateId: string; update: Update }>;

export type SyncServerMessage<
  Selection,
  StateVector,
  Update,
  DocumentCode extends string,
  Metadata extends Readonly<Record<string, unknown>> = SyncDocumentRevision,
  Extension extends SyncServerExtension = SyncBaseExtension,
> =
  | (Readonly<{
      kind: "sync_response";
      serverStateVector: StateVector;
      missingUpdate: Update;
      access: "read" | "edit";
      sessionId: string;
    }> &
      Metadata &
      Extension["syncResponse"])
  | (Readonly<{ kind: "update_accepted"; updateId: string }> &
      Extension["updateAccepted"])
  | (Readonly<{ kind: "update_broadcast"; update: Update }> &
      Extension["updateBroadcast"])
  | (Readonly<{
      kind: "presence_changed";
      participants: readonly CollaborationParticipant<Selection>[];
    }> &
      Extension["presence"])
  | SyncSignal<Extension["signal"]>
  | Readonly<{ kind: "failure"; code: SyncFailureCode<DocumentCode> }>;

export type SyncProtocolSpec<
  Selection,
  StateVector extends Encoded,
  Update extends Encoded,
  DocumentCode extends string,
  Extension extends SyncServerExtension = SyncBaseExtension,
> = Readonly<{
  protocol: string;
  frameLimit: number;
  /** The name in the message of an encode branch that cannot happen. */
  label: string;
  isSelection: (value: unknown) => value is Selection | null;
  parseStateVector: (
    bytes: Uint8Array,
  ) => SyncParsed<StateVector, DocumentCode>;
  parseUpdate: (bytes: Uint8Array) => SyncParsed<Update, DocumentCode>;
  /**
   * Every code of the document's own failures, and any room failure that the
   * package adds, for the failure frame.
   */
  documentFailureCodes: readonly DocumentCode[];
  /** The room fields of the sync response. Default: `documentRevision`. */
  roomMetadata?: SyncRoomMetadata;
  /** Fields after `sessionId` in a sync response. Default: none. */
  syncResponseFields?: SyncMessageFields;
  /** Fields after `updateId` in an accepted update. Default: none. */
  updateAcceptedFields?: SyncMessageFields;
  /** Fields after `update` in a broadcast update. Default: none. */
  updateBroadcastFields?: SyncMessageFields;
  /** Fields after `participants` in a presence frame. Default: `agents`. */
  presenceFields?: SyncMessageFields;
  /** The server kinds without fields. Default: none. */
  signals?: readonly Extension["signal"][];
}>;

const ROOM_FAILURE_CODES: readonly SyncRoomFailureCode[] = [
  "invalid_message",
  "access_revoked",
  "storage_unavailable",
  "room_full",
];

export function createSyncProtocol<
  Selection,
  StateVector extends Encoded,
  Update extends Encoded,
  DocumentCode extends string,
  Metadata extends Readonly<Record<string, unknown>> = SyncDocumentRevision,
  Extension extends SyncServerExtension = SyncBaseExtension,
>(
  spec: SyncProtocolSpec<
    Selection,
    StateVector,
    Update,
    DocumentCode,
    Extension
  >,
) {
  type Code = SyncFailureCode<DocumentCode>;
  type Client = SyncClientMessage<Selection, StateVector, Update>;
  type Server = SyncServerMessage<
    Selection,
    StateVector,
    Update,
    DocumentCode,
    Metadata,
    Extension
  >;
  type Message<Kind> = Extract<Server, { kind: Kind }>;
  type Signal = SyncSignal<Extension["signal"]>;
  type Participant = CollaborationParticipant<Selection>;
  const metadata = spec.roomMetadata ?? DOCUMENT_REVISION;
  const syncTail = spec.syncResponseFields ?? NO_FIELDS;
  const accepted = spec.updateAcceptedFields ?? NO_FIELDS;
  const broadcast = spec.updateBroadcastFields ?? NO_FIELDS;
  const presence = spec.presenceFields ?? AGENTS;
  const signals: ReadonlySet<unknown> = new Set(spec.signals);

  function pick(
    part: SyncMessageFields,
    source: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      part.fields.map((field) => [field, source[field]]),
    );
  }

  function isSignalKind(kind: unknown): kind is Extension["signal"] {
    return signals.has(kind);
  }

  function isSignal(message: Server): message is Signal {
    return signals.has(message.kind);
  }

  const failureCodes: ReadonlySet<string> = new Set<string>([
    ...spec.documentFailureCodes,
    ...ROOM_FAILURE_CODES,
  ]);

  function invalid(): SyncParsed<never, Code> {
    return { ok: false, error: { code: "invalid_message" } };
  }

  function envelope(value: Readonly<Record<string, unknown>>): string {
    return encodeProtocolFrame(spec.protocol, value);
  }

  function isParticipant(value: unknown): value is Participant {
    return (
      isRecord(value) &&
      Object.keys(value).length === 7 &&
      isShortProtocolText(value.sessionId) &&
      isShortProtocolText(value.userId) &&
      isShortProtocolText(value.displayName) &&
      isCollaborationPresenceState(value.state) &&
      spec.isSelection(value.selection) &&
      typeof value.activeAt === "number" &&
      Number.isSafeInteger(value.activeAt) &&
      value.activeAt >= 0 &&
      isCollaborationPointer(value.pointer)
    );
  }

  function isFailureCode(value: unknown): value is Code {
    return typeof value === "string" && failureCodes.has(value);
  }

  function parseClientMessage(frame: unknown): SyncParsed<Client, Code> {
    const raw = parseProtocolFrame(frame, spec.protocol, spec.frameLimit);
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
          spec.isSelection(raw.selection)
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
        const stateVector = spec.parseStateVector(bytes);
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
        const update = spec.parseUpdate(bytes);
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

  function parseServerMessage(frame: unknown): SyncParsed<Server, Code> {
    const raw = parseProtocolFrame(frame, spec.protocol, spec.frameLimit);
    if (raw === null) return invalid();
    switch (raw.kind) {
      case "sync_response": {
        if (
          !hasExactMessageFields(
            raw,
            "serverStateVector",
            "missingUpdate",
            ...metadata.fields,
            "access",
            "sessionId",
            ...syncTail.fields,
          ) ||
          !metadata.isValid(raw) ||
          !syncTail.isValid(raw) ||
          !isShortProtocolText(raw.sessionId) ||
          (raw.access !== "read" && raw.access !== "edit")
        )
          return invalid();
        const vectorBytes = decodeProtocolBytes(raw.serverStateVector);
        const updateBytes = decodeProtocolBytes(raw.missingUpdate);
        if (vectorBytes === null || updateBytes === null) return invalid();
        const vector = spec.parseStateVector(vectorBytes);
        const update = spec.parseUpdate(updateBytes);
        if (!vector.ok) return vector;
        if (!update.ok) return update;
        return {
          ok: true,
          value: {
            kind: "sync_response",
            serverStateVector: vector.value,
            missingUpdate: update.value,
            ...pick(metadata, raw),
            access: raw.access,
            sessionId: raw.sessionId,
            ...pick(syncTail, raw),
          } as Message<"sync_response">,
        };
      }
      case "update_accepted":
        return hasExactMessageFields(raw, "updateId", ...accepted.fields) &&
          accepted.isValid(raw) &&
          isCollaborationOperationId(raw.updateId)
          ? {
              ok: true,
              value: {
                kind: "update_accepted",
                updateId: raw.updateId,
                ...pick(accepted, raw),
              } as Message<"update_accepted">,
            }
          : invalid();
      case "update_broadcast": {
        if (
          !hasExactMessageFields(raw, "update", ...broadcast.fields) ||
          !broadcast.isValid(raw)
        )
          return invalid();
        const bytes = decodeProtocolBytes(raw.update);
        if (bytes === null) return invalid();
        const update = spec.parseUpdate(bytes);
        return update.ok
          ? {
              ok: true,
              value: {
                kind: "update_broadcast",
                update: update.value,
                ...pick(broadcast, raw),
              } as Message<"update_broadcast">,
            }
          : update;
      }
      case "presence_changed": {
        if (
          !hasExactMessageFields(raw, "participants", ...presence.fields) ||
          !presence.isValid(raw) ||
          !Array.isArray(raw.participants) ||
          raw.participants.length > COLLABORATION_SOCKET_LIMIT
        )
          return invalid();
        const participants: Participant[] = [];
        for (const item of raw.participants) {
          if (!isParticipant(item)) return invalid();
          // A copy in the field order of the wire, whatever order arrived.
          participants.push({
            sessionId: item.sessionId,
            userId: item.userId,
            displayName: item.displayName,
            state: item.state,
            selection: item.selection,
            activeAt: item.activeAt,
            pointer: item.pointer,
          });
        }
        return {
          ok: true,
          value: {
            kind: "presence_changed",
            participants,
            ...pick(presence, raw),
          } as Message<"presence_changed">,
        };
      }
      case "failure":
        return hasExactMessageFields(raw, "code") && isFailureCode(raw.code)
          ? { ok: true, value: { kind: "failure", code: raw.code } }
          : invalid();
      default:
        return isSignalKind(raw.kind) && hasExactMessageFields(raw)
          ? { ok: true, value: { kind: raw.kind } as Signal }
          : invalid();
    }
  }

  function encodeClientMessage(message: Client): string {
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
        return assertNever(message, `Unexpected ${spec.label} protocol branch`);
    }
  }

  function encodeServerMessage(message: Server): string {
    if (isSignal(message)) return envelope(message);
    switch (message.kind) {
      case "sync_response":
        return envelope({
          kind: message.kind,
          serverStateVector: encodeProtocolBytes(
            message.serverStateVector.encode(),
          ),
          missingUpdate: encodeProtocolBytes(message.missingUpdate.encode()),
          ...pick(metadata, message),
          access: message.access,
          sessionId: message.sessionId,
          ...pick(syncTail, message),
        });
      case "update_broadcast":
        return envelope({
          kind: message.kind,
          update: encodeProtocolBytes(message.update.encode()),
          ...pick(broadcast, message),
        });
      case "update_accepted":
      case "presence_changed":
      case "failure":
        return envelope(message);
      default:
        return assertNever(message, `Unexpected ${spec.label} protocol branch`);
    }
  }

  return {
    parseClientMessage,
    parseServerMessage,
    encodeClientMessage,
    encodeServerMessage,
  };
}
