import {
  ProductDescriptionDoc,
  type ProductDescriptionInputRange,
  type ProductDescriptionPresenceSelection,
  type ProductDescriptionSelection,
  type ProductDescriptionStateVector,
  type ProductDescriptionUpdate,
} from "@seams/product-description-crdt";
import { encodeDraftClientMessage, type DraftFailureCode, type ProductDescriptionRoomMetadata } from "@seams/product-description-crdt/protocol";
import type { CollaborationAgentActivity, TextSelectionDirection } from "@seams/collaboration";
import { TextCollaborationClient, type TextCollaborationClientMessage, type TextCollaborationView, type TextDocumentAdapter, type TextProtocolAdapter } from "../../collaboration/text-client";
import type { DraftPresenceView } from "./presence";
import { assertNever } from "@seams/std";
import { parseDescriptionServerMessage } from "@seams/control-api/portal/description-collaboration";

type DescriptionField = "description";

type DescriptionTextView = TextCollaborationView<
  DescriptionField,
  ProductDescriptionRoomMetadata
>;

type DescriptionTextClient = TextCollaborationClient<
  DescriptionField,
  ProductDescriptionDoc,
  ProductDescriptionUpdate,
  ProductDescriptionStateVector,
  ProductDescriptionSelection,
  ProductDescriptionPresenceSelection,
  ProductDescriptionRoomMetadata,
  DraftFailureCode
>;

type Metadata = ProductDescriptionRoomMetadata &
  Readonly<{ access: "read" | "edit" }>;

export type DraftInitialization =
  | Readonly<{ kind: "uninitialized" }>
  | Readonly<{ kind: "initialized"; metadata: Metadata }>;

export type DescriptionDraftView = Readonly<{
  description: string;
  participants: readonly DraftPresenceView[];
  agents: readonly CollaborationAgentActivity[];
  initialization: DraftInitialization;
  readOnly: boolean;
}> & (
  | Readonly<{ kind: "connecting" | "synced" | "syncing" | "reconnecting" }>
  | Readonly<{ kind: "failed"; message: string }>
);

const DESCRIPTION_DOCUMENT: TextDocumentAdapter<
  DescriptionField,
  ProductDescriptionDoc,
  ProductDescriptionUpdate,
  ProductDescriptionStateVector,
  ProductDescriptionSelection,
  ProductDescriptionPresenceSelection,
  DraftFailureCode
> = {
  fields: ["description"],
  create: createDescriptionDocument,
  clone: cloneDescriptionDocument,
  read: readDescription,
  readInputs: readDescriptionInputs,
  edit: editDescription,
  apply: applyDescriptionUpdate,
  stateVector: readDescriptionStateVector,
  syncUpdate: createDescriptionSyncUpdate,
  captureLocalSelection: captureDescriptionLocalSelection,
  resolveLocalSelection: resolveDescriptionLocalSelection,
  capturePresenceSelection: captureDescriptionPresenceSelection,
  resolvePresenceSelection: resolveDescriptionPresenceSelection,
  destroy: destroyDescriptionDocument,
};

const DESCRIPTION_PROTOCOL: TextProtocolAdapter<
  ProductDescriptionUpdate,
  ProductDescriptionStateVector,
  ProductDescriptionPresenceSelection,
  ProductDescriptionRoomMetadata,
  DraftFailureCode
> = {
  parseServer: parseDescriptionServerMessage,
  encodeClient: encodeDescriptionClientMessage,
  failureMessage: draftFailureMessage,
  invalidMessageCode: "invalid_message",
};

export class DescriptionDraftClient {
  readonly #client: DescriptionTextClient;

  constructor(
    organisationId: string,
    productId: string,
    textarea: HTMLTextAreaElement,
    notify: (view: DescriptionDraftView) => void,
  ) {
    const surface = textarea.closest<HTMLElement>(".description-draft-workspace");
    if (surface === null) throw new Error("Draft workspace is missing");
    const url = new URL(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/products/${encodeURIComponent(productId)}/description-draft/socket`,
      window.location.origin,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.#client = new TextCollaborationClient({
      url: url.href,
      surface,
      textareas: { description: textarea },
      document: DESCRIPTION_DOCUMENT,
      protocol: DESCRIPTION_PROTOCOL,
      notify: notifyDescriptionView.bind(null, notify),
    });
  }

  dispose(): void {
    this.#client.dispose();
  }

  hasUnsyncedEdits(): boolean {
    return this.#client.hasUnsyncedEdits();
  }
}

function createDescriptionDocument() {
  return ProductDescriptionDoc.create("");
}

function cloneDescriptionDocument(document: ProductDescriptionDoc) {
  const state = document.state();
  return state.ok ? ProductDescriptionDoc.restore(state.value) : state;
}

function readDescription(document: ProductDescriptionDoc): string {
  return document.read();
}

function readDescriptionInputs(
  textareas: Readonly<Record<DescriptionField, HTMLTextAreaElement>>,
): Readonly<Record<DescriptionField, string>> {
  return { description: textareas.description.value };
}

function editDescription(
  document: ProductDescriptionDoc,
  _field: DescriptionField,
  next: string,
  range?: ProductDescriptionInputRange,
) {
  return document.edit(next, range);
}

function applyDescriptionUpdate(document: ProductDescriptionDoc, update: ProductDescriptionUpdate) {
  return document.apply(update);
}

function readDescriptionStateVector(document: ProductDescriptionDoc) {
  return document.stateVector();
}

function createDescriptionSyncUpdate(document: ProductDescriptionDoc, vector: ProductDescriptionStateVector) {
  return document.syncUpdate(vector);
}

function captureDescriptionLocalSelection(
  document: ProductDescriptionDoc,
  _field: DescriptionField,
  start: number,
  end: number,
  direction: TextSelectionDirection,
): ProductDescriptionSelection {
  return document.captureSelection(start, end, direction);
}

function resolveDescriptionLocalSelection(document: ProductDescriptionDoc, selection: ProductDescriptionSelection) {
  return document.resolveSelection(selection);
}

function captureDescriptionPresenceSelection(
  document: ProductDescriptionDoc,
  _field: DescriptionField,
  start: number,
  end: number,
  direction: TextSelectionDirection,
): ProductDescriptionPresenceSelection {
  return document.capturePresenceSelection(start, end, direction);
}

function resolveDescriptionPresenceSelection(
  document: ProductDescriptionDoc,
  selection: ProductDescriptionPresenceSelection,
) {
  const range = document.resolvePresenceSelection(selection);
  return range === null ? null : { field: "description" as const, range };
}

function destroyDescriptionDocument(document: ProductDescriptionDoc): void {
  document.destroy();
}

function encodeDescriptionClientMessage(
  message: TextCollaborationClientMessage<
    ProductDescriptionUpdate,
    ProductDescriptionStateVector,
    ProductDescriptionPresenceSelection
  >,
): string {
  return encodeDraftClientMessage(message);
}

function notifyDescriptionView(notify: (view: DescriptionDraftView) => void, view: DescriptionTextView): void {
  const initialization: DraftInitialization = view.metadata === null
    ? { kind: "uninitialized" }
    : {
        kind: "initialized",
        metadata: { ...view.metadata, access: view.readOnly ? "read" : "edit" },
      };
  const participants = view.participants.map(descriptionParticipant);
  const base = {
    description: view.values.description,
    participants,
    agents: view.agents,
    initialization,
    readOnly: view.readOnly,
  };
  notify(view.kind === "failed"
    ? { ...base, kind: "failed", message: view.message }
    : { ...base, kind: view.kind });
}

function descriptionParticipant(participant: DescriptionTextView["participants"][number]): DraftPresenceView {
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

function draftFailureMessage(code: DraftFailureCode): string {
  switch (code) {
    case "access_revoked":
      return "Editing access has ended. Copy any unsynced text before leaving this page.";
    case "description_too_long":
      return "The shared description exceeds 10,000 characters. Copy your text before reopening the accepted draft.";
    case "state_too_large":
    case "update_too_large":
    case "state_vector_too_large":
      return "This draft has reached its collaboration limit. Your text remains available to copy.";
    case "source_unavailable":
      return "The product’s source cannot be verified. Copy any unsynced text, then refresh the product.";
    case "room_full":
      return "This draft already has 20 connected sessions. Try again after a session closes.";
    case "storage_unavailable":
      return "The draft could not sync. Copy any unsynced text before reloading or checking your sign-in.";
    case "invalid_state":
    case "invalid_update":
    case "invalid_state_vector":
    case "invalid_document_shape":
    case "invalid_message":
      return "This draft could not be synchronized safely. Copy any unsynced text before reopening it.";
    default:
      return assertNever(code, "Unexpected description collaboration branch");
  }
}
