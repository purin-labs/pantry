import {
  CostsSheetDoc,
  META_SAVED_AT_CELL_KEY,
  type CostsSheetCellChange,
  type CostsSheetSelection,
  type CostsSheetStateVector,
  type CostsSheetTab,
  type CostsSheetUpdate,
} from "@purin-labs/costs-sheet-crdt";
import {
  encodeCostsSheetClientMessage,
  parseCostsSheetServerMessage,
  type CostsSheetFailureCode,
  type CostsSheetRoomMetadata,
} from "@purin-labs/costs-sheet-crdt/protocol";
import type { CollaborationAgentActivity } from "@purin-labs/collaboration";
import { assertNever } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";
import {
  DocumentClient,
  webSocketUrl,
  type DocumentParticipant,
  type DocumentState,
} from "@purin-labs/collaboration/portal/document-client";

const SYNC_RETRY_LIMIT = 3;

export type CostsSheetPresence = DocumentParticipant<CostsSheetSelection>;

export type CostsSheetView = Readonly<{
  cells: Readonly<Record<string, string>>;
  savedAt: string | null;
  participants: readonly CostsSheetPresence[];
  agents: readonly CollaborationAgentActivity[];
  access: "read" | "edit";
}> &
  StrictUnion<
    | Readonly<{ kind: "connecting" | "syncing" | "synced" | "reconnecting" }>
    | Readonly<{ kind: "failed"; message: string; recovery: "retry" | "none" }>
  >;

export const INITIAL_COSTS_SHEET_VIEW: CostsSheetView = {
  kind: "connecting",
  cells: {},
  savedAt: null,
  participants: [],
  agents: [],
  access: "read",
};

/**
 * Plan 86 Phase 3: multiplayer Yjs + Figma-style presence client for an
 * Organisation's Costs & margins workbook.
 */
export class CostsSheetClient {
  readonly #client: DocumentClient<
    CostsSheetDoc,
    CostsSheetUpdate,
    CostsSheetStateVector,
    CostsSheetSelection,
    CostsSheetFailureCode,
    CostsSheetRoomMetadata
  >;
  readonly #notify: (view: CostsSheetView) => void;
  #selection: CostsSheetSelection | null;

  constructor(
    organisationId: string,
    initialSheet: CostsSheetTab,
    surface: HTMLElement,
    notify: (view: CostsSheetView) => void,
  ) {
    this.#selection = { sheet: initialSheet, cellKey: null };
    this.#notify = notify;
    this.#client = new DocumentClient({
      url: webSocketUrl(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/costs/sheet/socket`,
      ),
      surface,
      create: () => CostsSheetDoc.create(),
      parse: parseCostsSheetServerMessage,
      encode: encodeCostsSheetClientMessage,
      invalidMessage: "invalid_message",
      ignoredEditFailures: [
        "collection_limit",
        "record_conflict",
        "cell_invalid",
      ],
      retry: { limit: SYNC_RETRY_LIMIT, recovery: failureRecovery },
      presence: this.#presence.bind(this),
      generation: (message) => message.generation,
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

  retry(): void {
    this.#client.retry();
  }

  select(sheet: CostsSheetTab, cellKey: string | null): void {
    if (
      this.#selection !== null &&
      this.#selection.sheet === sheet &&
      this.#selection.cellKey === cellKey
    ) {
      return;
    }
    this.#selection = { sheet, cellKey };
    this.#client.sendPresence(this.#presence());
  }

  setCells(changes: readonly CostsSheetCellChange[]): boolean {
    if (changes.length === 0) {
      return true;
    }
    const result = this.#client.replica.setCells(changes);
    if (!result.ok && result.error.code === "cell_invalid") {
      return false;
    }
    this.#client.edit(result);
    return true;
  }

  clearAll(): void {
    this.#client.edit(this.#client.replica.clearAllDraftCells());
  }

  /** Only an editor's selection shows; a reader is viewing. */
  #presence(): CostsSheetSelection | null {
    return this.#client.access === "edit" ? this.#selection : null;
  }

  #emit(
    state: DocumentState<
      CostsSheetDoc,
      CostsSheetSelection,
      CostsSheetFailureCode
    >,
  ): void {
    const cells = state.replica.cellsRecord();
    const base = {
      cells,
      savedAt: cells[META_SAVED_AT_CELL_KEY] ?? null,
      participants: state.participants,
      agents: state.agents,
      access: state.access,
    };
    if (state.status === "failed") {
      this.#notify({
        ...base,
        kind: "failed",
        message: failureMessage(state.code),
        recovery: failureRecovery(state.code),
      });
      return;
    }
    this.#notify({ ...base, kind: state.status });
  }
}

function failureRecovery(code: CostsSheetFailureCode): "retry" | "none" {
  switch (code) {
    case "storage_unavailable":
    case "invalid_state":
    case "invalid_update":
    case "invalid_state_vector":
    case "invalid_document_shape":
    case "invalid_message":
      return "retry";
    case "cell_invalid":
    case "record_conflict":
    case "update_too_large":
    case "state_too_large":
    case "state_vector_too_large":
    case "access_revoked":
    case "collection_limit":
    case "room_full":
      return "none";
    default:
      return assertNever(code, "Unexpected costs sheet failure code");
  }
}

function failureMessage(code: CostsSheetFailureCode): string {
  switch (code) {
    case "access_revoked":
      return "Your access to this workbook has ended.";
    case "collection_limit":
      return "This workbook reached the draft cell limit. Save or reset before editing more cells.";
    case "cell_invalid":
    case "record_conflict":
      return "That cell edit could not be applied. Reload the page and try again.";
    case "room_full":
      return "This workbook already has 20 connected sessions.";
    case "storage_unavailable":
      return "The shared workbook is temporarily unavailable. Your edits remain on this page.";
    case "invalid_state":
    case "invalid_update":
    case "invalid_state_vector":
    case "invalid_document_shape":
    case "invalid_message":
      return "The shared workbook lost sync. Your edits remain on this page.";
    case "update_too_large":
    case "state_too_large":
    case "state_vector_too_large":
      return "The shared workbook state is too large. Save or reset the sheet.";
    default:
      return assertNever(code, "Unexpected costs sheet failure code");
  }
}
