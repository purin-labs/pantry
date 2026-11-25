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
const HISTORY_LIMIT = 100;

type HistoryEntry = Readonly<{
  /** Cell overrides that restore the replica to the state before this step. */
  inverse: readonly CostsSheetCellChange[];
  /** Keystroke edits inside one focused cell share a key and join one step. */
  mergeKey: string | null;
}>;

export type CostsSheetPresence = DocumentParticipant<CostsSheetSelection>;

export type CostsSheetView = Readonly<{
  cells: Readonly<Record<string, string>>;
  savedAt: string | null;
  participants: readonly CostsSheetPresence[];
  agents: readonly CollaborationAgentActivity[];
  access: "read" | "edit";
  canUndo: boolean;
  canRedo: boolean;
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
  canUndo: false,
  canRedo: false,
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
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];
  #hasSynced = false;
  #lastGeneration: number | null = null;
  #lastSavedAt: string | null = null;

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
      synced: (message) => {
        if (
          this.#lastGeneration !== null &&
          this.#lastGeneration !== message.generation
        ) {
          this.#undo = [];
          this.#redo = [];
        }
        this.#lastGeneration = message.generation;
        this.#observeRemoteSavedAt();
        this.#hasSynced = true;
      },
      updated: () => {
        this.#observeRemoteSavedAt();
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

  setCells(
    changes: readonly CostsSheetCellChange[],
    options?: Readonly<{ mergeKey?: string | null }>,
  ): boolean {
    if (changes.length === 0) {
      return true;
    }
    const before = this.#client.replica.cellsRecord();
    const result = this.#client.replica.setCells(changes);
    if (!result.ok && result.error.code === "cell_invalid") {
      return false;
    }
    if (result.ok && result.value !== null) {
      const after = this.#client.replica.cellsRecord();
      const inverse = diffInverse(
        before,
        after,
        changes.map((change) => change.cellKey),
      );
      this.#record(inverse, after, options?.mergeKey ?? null);
    }
    this.#client.edit(result);
    return true;
  }

  clearAll(): void {
    const before = this.#client.replica.cellsRecord();
    const result = this.#client.replica.clearAllDraftCells();
    if (result.ok && result.value !== null) {
      const after = this.#client.replica.cellsRecord();
      const inverse = diffInverse(before, after);
      this.#record(inverse, after, null);
    }
    this.#client.edit(result);
  }

  undo(): boolean {
    return this.#travel(this.#undo, this.#redo);
  }

  redo(): boolean {
    return this.#travel(this.#redo, this.#undo);
  }

  clearHistory(): void {
    if (this.#undo.length === 0 && this.#redo.length === 0) {
      return;
    }
    this.#undo = [];
    this.#redo = [];
    this.#client.emit();
  }

  /** Only an editor's selection shows; a reader is viewing. */
  #presence(): CostsSheetSelection | null {
    return this.#client.access === "edit" ? this.#selection : null;
  }

  #observeRemoteSavedAt(): void {
    const savedAt = this.#client.replica.cell(META_SAVED_AT_CELL_KEY);
    if (this.#hasSynced && savedAt !== null && savedAt !== this.#lastSavedAt) {
      this.#undo = [];
      this.#redo = [];
    }
    if (savedAt !== null) {
      this.#lastSavedAt = savedAt;
    }
  }

  #record(
    inverse: readonly CostsSheetCellChange[],
    after: Readonly<Record<string, string>>,
    mergeKey: string | null,
  ): void {
    if (inverse.length === 0) {
      return;
    }
    this.#redo = [];
    const last = this.#undo.at(-1);
    if (mergeKey !== null && last?.mergeKey === mergeKey) {
      const merged = mergeInverse(last.inverse, inverse);
      if (!isEffectiveInverse(after, merged)) {
        this.#undo.pop();
        return;
      }
      this.#undo[this.#undo.length - 1] = {
        inverse: merged,
        mergeKey,
      };
      return;
    }
    this.#undo.push({ inverse, mergeKey });
    if (this.#undo.length > HISTORY_LIMIT) {
      this.#undo.shift();
    }
  }

  #travel(from: HistoryEntry[], to: HistoryEntry[]): boolean {
    const connection = this.#client.connection;
    if (
      (connection === "connected" || connection === "syncing") &&
      this.#client.access !== "edit"
    ) {
      return false;
    }
    while (from.length > 0) {
      const entry = from.pop();
      if (entry === undefined) {
        break;
      }
      const before = this.#client.replica.cellsRecord();
      const result = this.#client.replica.setCells(entry.inverse);
      if (!result.ok) {
        if (result.error.code === "cell_invalid") {
          continue;
        }
        this.#client.edit(result);
        return false;
      }
      if (result.value === null) {
        continue;
      }
      const after = this.#client.replica.cellsRecord();
      const inverse = diffInverse(
        before,
        after,
        entry.inverse.map((change) => change.cellKey),
      );
      if (inverse.length > 0) {
        to.push({ inverse, mergeKey: null });
        if (to.length > HISTORY_LIMIT) {
          to.shift();
        }
      }
      this.#client.edit(result);
      return true;
    }
    this.#client.emit();
    return false;
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
      canUndo: hasEffectiveHistory(cells, this.#undo),
      canRedo: hasEffectiveHistory(cells, this.#redo),
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

function diffInverse(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  touchedKeys?: readonly string[],
): CostsSheetCellChange[] {
  const keys =
    touchedKeys !== undefined
      ? new Set(touchedKeys)
      : new Set([...Object.keys(before), ...Object.keys(after)]);
  const inverse: CostsSheetCellChange[] = [];
  for (const cellKey of keys) {
    if (cellKey === META_SAVED_AT_CELL_KEY) {
      continue;
    }
    const prev = before[cellKey] ?? null;
    const next = after[cellKey] ?? null;
    if (prev !== next) {
      inverse.push({ cellKey, value: prev });
    }
  }
  return inverse;
}

function mergeInverse(
  previous: readonly CostsSheetCellChange[],
  next: readonly CostsSheetCellChange[],
): readonly CostsSheetCellChange[] {
  const seen = new Set(previous.map((change) => change.cellKey));
  const merged = [...previous];
  for (const change of next) {
    if (!seen.has(change.cellKey)) {
      seen.add(change.cellKey);
      merged.push(change);
    }
  }
  return merged;
}

function isEffectiveInverse(
  cells: Readonly<Record<string, string>>,
  inverse: readonly CostsSheetCellChange[],
): boolean {
  return inverse.some(
    (change) => (cells[change.cellKey] ?? null) !== change.value,
  );
}

function hasEffectiveHistory(
  cells: Readonly<Record<string, string>>,
  entries: readonly HistoryEntry[],
): boolean {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry !== undefined && isEffectiveInverse(cells, entry.inverse)) {
      return true;
    }
  }
  return false;
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
