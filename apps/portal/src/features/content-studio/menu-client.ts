import {
  MenuDraftDoc,
  type MenuDraftSnapshot,
  type MenuDraftStateVector,
  type MenuDraftUpdate,
  type MenuItem,
  type MenuItemPlacement,
  type MenuPresenceSelection,
  type MenuSection,
} from "@purin-labs/menu-draft-crdt";
import {
  encodeMenuDraftClientMessage,
  parseMenuDraftServerMessage,
  type MenuDraftFailureCode,
  type MenuRoomMetadata,
} from "@purin-labs/menu-draft-crdt/protocol";
import { assertNever } from "@purin-labs/std";
import {
  DocumentClient,
  webSocketUrl,
  type DocumentParticipant,
  type DocumentState,
} from "@purin-labs/collaboration/portal/document-client";

export type MenuDraftView = Readonly<{
  draft: MenuDraftSnapshot;
  participants: readonly MenuDraftPresenceView[];
  access: "read" | "edit";
  documentRevision: number | null;
}> &
  (
    | Readonly<{ kind: "connecting" | "syncing" | "synced" | "reconnecting" }>
    | Readonly<{ kind: "failed"; message: string }>
  );

type MenuDraftPresenceView = DocumentParticipant<MenuPresenceSelection>;

export class MenuDraftClient {
  readonly #client: DocumentClient<
    MenuDraftDoc,
    MenuDraftUpdate,
    MenuDraftStateVector,
    MenuPresenceSelection,
    MenuDraftFailureCode,
    MenuRoomMetadata
  >;
  readonly #notify: (view: MenuDraftView) => void;
  #selection: MenuPresenceSelection | null = null;
  #documentRevision: number | null = null;

  constructor(
    organisationId: string,
    surface: HTMLElement,
    notify: (view: MenuDraftView) => void,
  ) {
    this.#notify = notify;
    this.#client = new DocumentClient({
      url: webSocketUrl(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/collaboration/menu-draft/socket`,
      ),
      surface,
      create: () => MenuDraftDoc.createReplica(),
      parse: parseMenuDraftServerMessage,
      encode: encodeMenuDraftClientMessage,
      invalidMessage: "invalid_message",
      ignoredEditFailures: [
        "collection_limit",
        "record_conflict",
        "text_too_long",
      ],
      presence: () => this.#selection,
      syncResponse: (message) => {
        this.#documentRevision = message.documentRevision;
        return true;
      },
      emit: this.#emit.bind(this),
    });
    this.#client.connect();
  }

  dispose(): void {
    this.#client.dispose();
  }

  hasUnsyncedEdits(): boolean {
    return this.#client.hasUnsyncedEdits();
  }

  select(selection: MenuPresenceSelection | null): void {
    this.#selection = selection;
    this.#client.sendPresence(selection);
  }

  rename(title: string): void {
    this.#client.edit(this.#client.replica.rename(title));
  }

  addSection(section: MenuSection): void {
    this.#client.edit(this.#client.replica.addSection(section));
  }

  addItem(item: MenuItem): void {
    this.#client.edit(this.#client.replica.addItem(item));
  }

  renameItem(itemId: string, displayName: string): void {
    this.#client.edit(this.#client.replica.renameItem(itemId, displayName));
  }

  describeItem(itemId: string, description: string): void {
    this.#client.edit(this.#client.replica.describeItem(itemId, description));
  }

  moveItem(itemId: string, placement: MenuItemPlacement): void {
    this.#client.edit(this.#client.replica.moveItem(itemId, placement));
  }

  deleteItem(itemId: string): void {
    this.#client.edit(this.#client.replica.deleteItem(itemId));
  }

  #emit(
    state: DocumentState<
      MenuDraftDoc,
      MenuPresenceSelection,
      MenuDraftFailureCode
    >,
  ): void {
    const base = {
      draft: state.replica.read(),
      participants: state.participants,
      access: state.access,
      documentRevision: this.#documentRevision,
    };
    if (state.status === "failed") {
      // The code names the refused rule for a support report.
      this.#notify({
        ...base,
        kind: "failed",
        message: `${failureMessage(state.code)} Code: ${state.code}.`,
      });
      return;
    }
    this.#notify({ ...base, kind: state.status });
  }
}

function failureMessage(code: MenuDraftFailureCode): string {
  switch (code) {
    case "access_revoked":
      return "Menu editing access ended.";
    case "collection_limit":
    case "text_too_long":
    case "record_conflict":
      return "That menu change could not be applied. Refresh the current menu and try again.";
    case "room_full":
      return "This menu already has 20 connected sessions.";
    case "storage_unavailable":
      return "The menu room is temporarily unavailable.";
    case "invalid_state":
    case "invalid_update":
    case "invalid_state_vector":
    case "invalid_document_shape":
    case "update_too_large":
    case "state_too_large":
    case "state_vector_too_large":
    case "invalid_message":
      return "The shared menu could not be synchronized. Reload the page.";
    default:
      return assertNever(code, "Unexpected menu client branch");
  }
}
