import {
  MailReplyDoc,
  type MailReplyInputRange,
  type MailReplyPresenceSelection,
  type MailReplySelection,
  type MailReplyStateVector,
  type MailReplyUpdate,
} from "@seams/mail-reply-crdt";
import { encodeDraftClientMessage, type DraftFailureCode, type MailReplyRoomMetadata } from "@seams/mail-reply-crdt/protocol";
import type {
  CollaborationAgentActivity,
  TextSelectionDirection,
} from "@seams/collaboration";
import { assertNever } from "@seams/std";
import { TextCollaborationClient, type TextCollaborationClientMessage, type TextCollaborationView, type TextDocumentAdapter, type TextProtocolAdapter } from "../collaboration/text-client";
import type { DraftPresenceView } from "../commerce/description-draft/presence";
import { parseReplyServerMessage } from "@seams/control-api/portal/reply-draft";

/**
 * Plan 40D: the shared draft of one Inbox reply. People and agents edit the
 * same text; a save makes it the next Gmail version.
 */
type BodyField = "body";

type ReplyTextView = TextCollaborationView<BodyField, MailReplyRoomMetadata>;

type ReplyTextClient = TextCollaborationClient<
  BodyField,
  MailReplyDoc,
  MailReplyUpdate,
  MailReplyStateVector,
  MailReplySelection,
  MailReplyPresenceSelection,
  MailReplyRoomMetadata,
  DraftFailureCode
>;

export type ReplyDraftView = Readonly<{
  body: string;
  participants: readonly DraftPresenceView[];
  agents: readonly CollaborationAgentActivity[];
  /** The room's state when this client last synced, or null before that. */
  metadata: MailReplyRoomMetadata | null;
  readOnly: boolean;
}> &
  (
    | Readonly<{ kind: "connecting" | "synced" | "syncing" | "reconnecting" }>
    | Readonly<{ kind: "failed"; message: string; closed: boolean }>
  );

const REPLY_DOCUMENT: TextDocumentAdapter<
  BodyField,
  MailReplyDoc,
  MailReplyUpdate,
  MailReplyStateVector,
  MailReplySelection,
  MailReplyPresenceSelection,
  DraftFailureCode
> = {
  fields: ["body"],
  create: createReplyDocument,
  clone: cloneReplyDocument,
  read: readReply,
  readInputs: readReplyInputs,
  edit: editReply,
  apply: applyReplyUpdate,
  stateVector: readReplyStateVector,
  syncUpdate: createReplySyncUpdate,
  captureLocalSelection: captureReplyLocalSelection,
  resolveLocalSelection: resolveReplyLocalSelection,
  capturePresenceSelection: captureReplyPresenceSelection,
  resolvePresenceSelection: resolveReplyPresenceSelection,
  destroy: destroyReplyDocument,
};

const REPLY_PROTOCOL: TextProtocolAdapter<
  MailReplyUpdate,
  MailReplyStateVector,
  MailReplyPresenceSelection,
  MailReplyRoomMetadata,
  DraftFailureCode
> = {
  parseServer: parseReplyServerMessage,
  encodeClient: encodeReplyClientMessage,
  failureMessage: replyFailureMessage,
  invalidMessageCode: "invalid_message",
};

export class ReplyDraftClient {
  readonly #client: ReplyTextClient;

  constructor(
    organisationId: string,
    proposalId: string,
    textarea: HTMLTextAreaElement,
    notify: (view: ReplyDraftView) => void,
  ) {
    const surface = textarea.closest<HTMLElement>(".mail-reply-draft");
    if (surface === null) throw new Error("Reply draft surface is missing");
    const url = new URL(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/email-replies/${encodeURIComponent(proposalId)}/draft/socket`,
      window.location.origin,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.#client = new TextCollaborationClient({
      url: url.href,
      surface,
      textareas: { body: textarea },
      document: REPLY_DOCUMENT,
      protocol: REPLY_PROTOCOL,
      notify: notifyReplyView.bind(null, notify),
    });
  }

  dispose(): void {
    this.#client.dispose();
  }

  hasUnsyncedEdits(): boolean {
    return this.#client.hasUnsyncedEdits();
  }
}

function createReplyDocument() {
  return MailReplyDoc.create("");
}

function cloneReplyDocument(document: MailReplyDoc) {
  const state = document.state();
  return state.ok ? MailReplyDoc.restore(state.value) : state;
}

function readReply(document: MailReplyDoc): string {
  return document.read();
}

function readReplyInputs(
  textareas: Readonly<Record<BodyField, HTMLTextAreaElement>>,
): Readonly<Record<BodyField, string>> {
  return { body: textareas.body.value };
}

function editReply(
  document: MailReplyDoc,
  _field: BodyField,
  next: string,
  range?: MailReplyInputRange,
) {
  return document.edit(next, range);
}

function applyReplyUpdate(document: MailReplyDoc, update: MailReplyUpdate) {
  return document.apply(update);
}

function readReplyStateVector(document: MailReplyDoc) {
  return document.stateVector();
}

function createReplySyncUpdate(
  document: MailReplyDoc,
  vector: MailReplyStateVector,
) {
  return document.syncUpdate(vector);
}

function captureReplyLocalSelection(
  document: MailReplyDoc,
  _field: BodyField,
  start: number,
  end: number,
  direction: TextSelectionDirection,
): MailReplySelection {
  return document.captureSelection(start, end, direction);
}

function resolveReplyLocalSelection(
  document: MailReplyDoc,
  selection: MailReplySelection,
) {
  return document.resolveSelection(selection);
}

function captureReplyPresenceSelection(
  document: MailReplyDoc,
  _field: BodyField,
  start: number,
  end: number,
  direction: TextSelectionDirection,
): MailReplyPresenceSelection {
  return document.capturePresenceSelection(start, end, direction);
}

function resolveReplyPresenceSelection(
  document: MailReplyDoc,
  selection: MailReplyPresenceSelection,
) {
  const range = document.resolvePresenceSelection(selection);
  return range === null ? null : { field: "body" as const, range };
}

function destroyReplyDocument(document: MailReplyDoc): void {
  document.destroy();
}

function encodeReplyClientMessage(
  message: TextCollaborationClientMessage<
    MailReplyUpdate,
    MailReplyStateVector,
    MailReplyPresenceSelection
  >,
): string {
  return encodeDraftClientMessage(message);
}

function notifyReplyView(
  notify: (view: ReplyDraftView) => void,
  view: ReplyTextView,
): void {
  const base = {
    body: view.values.body,
    participants: view.participants.map(replyParticipant),
    agents: view.agents,
    metadata: view.metadata,
    readOnly: view.readOnly,
  };
  notify(
    view.kind === "failed"
      ? {
          ...base,
          kind: "failed",
          message: view.message,
          closed: view.message === replyFailureMessage("draft_closed"),
        }
      : { ...base, kind: view.kind },
  );
}

function replyParticipant(
  participant: ReplyTextView["participants"][number],
): DraftPresenceView {
  return {
    sessionId: participant.sessionId,
    userId: participant.userId,
    displayName: participant.displayName,
    state: participant.state,
    selection: participant.selection?.range ?? null,
    activeAt: participant.activeAt,
    pointer: participant.pointer,
    isSelf: participant.isSelf,
  };
}

function replyFailureMessage(code: DraftFailureCode): string {
  switch (code) {
    case "draft_closed":
      return "This reply closed. It was sent, rejected or replaced, or the shared changes were reloaded from Gmail.";
    case "access_revoked":
      return "Your access to this reply has ended. Copy any unsaved text before leaving.";
    case "body_too_long":
      return "The reply exceeds 20,000 characters. Shorten it before you save.";
    case "state_too_large":
    case "update_too_large":
    case "state_vector_too_large":
      return "This reply draft has reached its collaboration limit. Your text remains available to copy.";
    case "source_unavailable":
      return "Gmail could not be read for this reply. Try again in a moment.";
    case "room_full":
      return "This reply already has 20 connected sessions. Try again after a session closes.";
    case "storage_unavailable":
      return "The reply draft could not sync. Copy any unsaved text before you reload.";
    case "invalid_state":
    case "invalid_update":
    case "invalid_state_vector":
    case "invalid_document_shape":
    case "invalid_message":
      return "This reply draft could not be synchronized safely. Copy any unsaved text before you open it again.";
    default:
      return assertNever(code, "Unexpected reply draft branch");
  }
}
