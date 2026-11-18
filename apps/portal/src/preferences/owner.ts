import {
  applyPreferenceEdit,
  defaultPreferenceDocument,
  type PreferenceArea,
  type UserId,
  type UserPreferenceDocument,
  type UserPreferenceEdit,
} from "@seams/control-api";
import { isRecord } from "@seams/std";
import { ControlApiError, controlRead, controlWrite } from "../control-client";
import { readCookie } from "../features/chat/api";
import { parsePreferenceResponse } from "@seams/control-api/portal/preferences";

export type PendingEdit = Readonly<{
  edit: UserPreferenceEdit;
  sequence: number;
}>;

export type SaveState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "saving" }>
  | Readonly<{ kind: "failed"; message: string }>;

export type PreferenceEntry = {
  accepted: UserPreferenceDocument | null;
  loaded: boolean;
  read: Promise<void> | null;
  pending: Map<string, PendingEdit>;
  save: SaveState;
};

export class UserPreferenceOwner {
  private active = true;
  private sequence = 0;
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private readonly entries = new Map<PreferenceArea, PreferenceEntry>();
  private abort = new AbortController();
  private generation = 0;

  constructor(readonly userId: UserId) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return this.unsubscribe.bind(this, listener);
  }
  private unsubscribe(listener: () => void): void {
    this.listeners.delete(listener);
  }
  getVersion(): number {
    return this.version;
  }
  start(): void {
    if (!this.active) {
      this.active = true;
      this.abort = new AbortController();
    }
    for (const area of this.entries.keys()) void this.load(area);
    void this.load("appearance");
  }
  dispose(): void {
    this.generation++;
    this.active = false;
    this.abort.abort();
    this.entries.clear();
    this.listeners.clear();
  }
  private emit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }
  private entry(area: PreferenceArea): PreferenceEntry {
    const found = this.entries.get(area);
    if (found !== undefined) return found;
    const entry: PreferenceEntry = {
      accepted: readPreferenceCache(this.userId, area),
      loaded: false,
      read: null,
      pending: new Map(),
      save: { kind: "idle" },
    };
    this.entries.set(area, entry);
    return entry;
  }
  document(area: PreferenceArea): UserPreferenceDocument {
    const entry = this.entry(area);
    let document =
      entry.accepted ?? defaultPreferenceDocument(this.userId, area, 0);
    for (const pending of entry.pending.values())
      document = applyPreferenceEdit(document, pending.edit);
    return document;
  }
  failure(area: PreferenceArea): string | null {
    const state = this.entries.get(area)?.save;
    return state?.kind === "failed" ? state.message : null;
  }
  load(area: PreferenceArea): Promise<void> {
    const entry = this.entry(area);
    if (!this.active || entry.loaded) return Promise.resolve();
    if (entry.read !== null) return entry.read;
    entry.read = this.read(area, entry);
    return entry.read;
  }
  private async read(
    area: PreferenceArea,
    entry: PreferenceEntry,
  ): Promise<void> {
    const generation = this.generation;
    try {
      const document = parsePreferenceResponse(
        await controlRead(preferencePath(area)),
        this.userId,
        area,
      );
      if (!this.active || generation !== this.generation) return;
      entry.accepted = document;
      entry.loaded = true;
      entry.save = { kind: "idle" };
      writePreferenceCache(document);
      this.emit();
      void this.drain(area, entry);
    } catch {
      if (!this.active || generation !== this.generation) return;
      entry.save = {
        kind: "failed",
        message:
          "Your preferences have not synced. Your choices remain available in this session.",
      };
      this.emit();
    } finally {
      entry.read = null;
    }
  }
  edit(edit: UserPreferenceEdit): void {
    if (!this.active) return;
    const entry = this.entry(edit.area);
    if (edit.command.kind === "reset") entry.pending.clear();
    const key = edit.command.kind;
    entry.pending.set(key, { edit, sequence: ++this.sequence });
    if (entry.save.kind === "failed") entry.save = { kind: "idle" };
    this.emit();
    if (!entry.loaded) void this.load(edit.area);
    else void this.drain(edit.area, entry);
  }
  retry(area: PreferenceArea): void {
    if (!this.active) return;
    const entry = this.entry(area);
    if (entry.save.kind !== "failed") return;
    entry.save = { kind: "idle" };
    this.emit();
    if (!entry.loaded) void this.load(area);
    else void this.drain(area, entry);
  }
  private async drain(
    area: PreferenceArea,
    entry: PreferenceEntry,
  ): Promise<void> {
    if (
      !this.active ||
      !entry.loaded ||
      entry.accepted === null ||
      entry.save.kind !== "idle"
    )
      return;
    entry.save = { kind: "saving" };
    const generation = this.generation;
    try {
      while (this.active && entry.pending.size > 0) {
        const next = entry.pending.entries().next().value;
        if (next === undefined) break;
        const [key, original] = next;
        let pending = original;
        let retries = 0;
        while (this.active) {
          const response = await this.save(entry.accepted, pending.edit);
          if (!this.active || generation !== this.generation) return;
          entry.accepted = response.document;
          writePreferenceCache(response.document);
          if (response.kind === "saved") {
            if (entry.pending.get(key)?.sequence === pending.sequence)
              entry.pending.delete(key);
            this.emit();
            break;
          }
          // A queued reset must precede choices made after it.
          if (entry.pending.keys().next().value !== key) break;
          if (retries === 1) throw new Error("conflict");
          const latest = entry.pending.get(key);
          if (latest === undefined) break;
          pending = latest;
          retries++;
          this.emit();
        }
      }
      entry.save = { kind: "idle" };
    } catch {
      if (!this.active || generation !== this.generation) return;
      entry.save = {
        kind: "failed",
        message:
          "Your preferences have not synced. Your choices remain available in this session.",
      };
    }
    if (this.active) this.emit();
  }
  private async save(
    document: UserPreferenceDocument,
    edit: UserPreferenceEdit,
  ): Promise<
    Readonly<{ kind: "saved" | "conflict"; document: UserPreferenceDocument }>
  > {
    const csrf = readCookie("satyr_control_csrf");
    if (csrf === null)
      throw new Error("Sign in again to save your preferences.");
    let raw: unknown;
    let conflict = false;
    try {
      raw = await controlWrite(
        preferencePath(edit.area),
        "PATCH",
        {
          expectedUserId: this.userId,
          expectedRevision: document.revision,
          command: edit.command,
        },
        this.abort.signal,
      );
    } catch (error) {
      if (!(error instanceof ControlApiError) || error.status === null)
        throw error;
      if (error.status !== 409) throw new Error("preferences_save_failed");
      // A conflict answers with the document that won.
      raw = error.details;
      conflict = true;
    }
    if (
      !isRecord(raw) ||
      (raw.kind !== "saved" && raw.kind !== "conflict") ||
      conflict !== (raw.kind === "conflict")
    )
      throw new Error("preferences_response_invalid");
    return {
      kind: raw.kind,
      document: parsePreferenceResponse(raw.document, this.userId, edit.area),
    };
  }
}

export function preferencePath(area: PreferenceArea): string {
  return `/v1/control/user/preferences/${area}`;
}

export function cacheKey(userId: UserId, area: PreferenceArea): string {
  return `satyr:preferences:${userId}:${area}`;
}

export function readPreferenceCache(
  userId: UserId,
  area: PreferenceArea,
): UserPreferenceDocument | null {
  try {
    const raw = localStorage.getItem(cacheKey(userId, area));
    return raw === null
      ? null
      : parsePreferenceResponse(JSON.parse(raw), userId, area);
  } catch {
    return null;
  }
}

export function writePreferenceCache(document: UserPreferenceDocument): void {
  try {
    localStorage.setItem(
      cacheKey(document.userId, document.area),
      JSON.stringify(document),
    );
  } catch {
    return;
  }
}
