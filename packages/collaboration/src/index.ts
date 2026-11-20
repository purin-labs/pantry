export {
  parseYjsEncoding,
  type EncodedValue,
  type ParsedYjsEncoding,
  type YjsEncodingFailure,
  type YjsEncodingKind,
  type YjsEncodingResult,
} from "./yjs-encoding.ts";
export {
  checkDocumentSize,
  defineSharedDoc,
  defineSharedEncoding,
  sharedDocFailure,
  sharedDocSuccess,
  type SharedDocEncoding,
  type SharedDocError,
  type SharedDocResult,
} from "./shared-doc.ts";
export {
  definePlainTextDoc,
  hasOnlyPlainTextStructs,
  type PlainTextChange,
  type PlainTextDocError,
} from "./plain-text-doc.ts";
export {
  RelativeTextSelection,
  captureTextPresenceSelection,
  resolveTextPresenceSelection,
  type TextPresenceSelection,
  type TextSelectionDirection,
  type TextSelectionRange,
} from "./text-selection.ts";
export {
  COLLABORATION_FRAME_LIMIT,
  COLLABORATION_PING,
  COLLABORATION_PING_INTERVAL_MS,
  COLLABORATION_POINTER_IDLE_MS,
  COLLABORATION_PONG,
  COLLABORATION_PONG_TIMEOUT_MS,
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
  isTextPresenceSelection,
  parseProtocolFrame,
  snapshotFrameLimit,
  type CollaborationParticipant,
  type CollaborationPointer,
  type CollaborationPointerPosition,
  type CollaborationPresenceState,
} from "./wire.ts";
export {
  hasValidPlainTextShape,
  normalizePlainText,
  splicePlainText,
  type TextInputRange,
} from "./plain-text.ts";
export {
  COLLABORATION_AGENT_DRAFT_TEXT_LIMIT,
  COLLABORATION_AGENT_ACTION_ELEMENTS,
  COLLABORATION_AGENT_COLOR_KEYS,
  isCollaborationAgentAction,
  type CollaborationAgent,
  type CollaborationAgentAction,
  type CollaborationAgentActivity,
  type CollaborationAgentColorKey,
} from "./agent-presence.ts";
export {
  type SyncClientMessage,
  type SyncFailureCode,
  type SyncMessageFields,
  type SyncServerMessage,
} from "./sync-protocol.ts";
