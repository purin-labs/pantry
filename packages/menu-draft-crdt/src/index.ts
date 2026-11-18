import {
  hasValidPlainTextShape,
  normalizePlainText,
  parseYjsEncoding,
  splicePlainText,
  type ParsedYjsEncoding,
} from "@seams/collaboration";
import * as Y from "yjs";

export const MENU_DRAFT_SCHEMA = "menu_draft_crdt.v2";
export const MENU_SECTION_LIMIT = 20;
export const MENU_ITEM_LIMIT = 200;
export const MENU_TEXT_LIMIT = 1_000;
export const MENU_STATE_LIMIT = 768 * 1024;
export const MENU_UPDATE_LIMIT = MENU_STATE_LIMIT;
export const MENU_STATE_VECTOR_LIMIT = 64 * 1024;

export type MenuSection = Readonly<{ id: string; title: string; order: number }>;
export type MenuItemPlacement = Readonly<{ sectionId: string; order: number }>;
export type MenuItem = Readonly<{
  id: string;
  productId: string;
  displayName: string;
  description: string;
  placement: MenuItemPlacement;
}>;
export type MenuDraftSnapshot = Readonly<{
  title: string;
  sections: readonly MenuSection[];
  items: readonly MenuItem[];
}>;
export type MenuPresenceSelection =
  | Readonly<{ kind: "section"; sectionId: string }>
  | Readonly<{ kind: "item"; itemId: string }>;

export type MenuDraftCrdtError = Readonly<{
  code:
    | "invalid_state"
    | "invalid_update"
    | "invalid_state_vector"
    | "invalid_document_shape"
    | "collection_limit"
    | "text_too_long"
    | "record_conflict"
    | "update_too_large"
    | "state_too_large"
    | "state_vector_too_large";
}>;
export type MenuDraftCrdtResult<T> =
  | Readonly<{ ok: true; value: T; error?: never }>
  | Readonly<{ ok: false; error: MenuDraftCrdtError; value?: never }>;

type EncodingKind = "state" | "update" | "state_vector";
const ENCODING_LIMITS = {
  state: MENU_STATE_LIMIT,
  update: MENU_UPDATE_LIMIT,
  stateVector: MENU_STATE_VECTOR_LIMIT,
} as const;

class MenuEncoding<K extends EncodingKind> {
  readonly #encoding: ParsedYjsEncoding<K>;
  readonly kind: K;

  private constructor(encoding: ParsedYjsEncoding<K>) {
    this.#encoding = encoding;
    this.kind = encoding.kind;
  }

  encode(): Uint8Array {
    return this.#encoding.encode();
  }

  static parse<K extends EncodingKind>(kind: K, bytes: Uint8Array): MenuDraftCrdtResult<MenuEncoding<K>> {
    const parsed = parseYjsEncoding(kind, bytes, ENCODING_LIMITS);
    return parsed.ok ? success(new MenuEncoding(parsed.value)) : parsed;
  }
}

export type MenuDraftState = MenuEncoding<"state">;
export type MenuDraftUpdate = MenuEncoding<"update">;
export type MenuDraftStateVector = MenuEncoding<"state_vector">;

export function parseMenuDraftState(bytes: Uint8Array): MenuDraftCrdtResult<MenuDraftState> {
  return MenuEncoding.parse("state", bytes);
}

export function parseMenuDraftUpdate(bytes: Uint8Array): MenuDraftCrdtResult<MenuDraftUpdate> {
  return MenuEncoding.parse("update", bytes);
}

export function parseMenuDraftStateVector(bytes: Uint8Array): MenuDraftCrdtResult<MenuDraftStateVector> {
  return MenuEncoding.parse("state_vector", bytes);
}

export class MenuDraftDoc {
  #doc: Y.Doc;

  private constructor(doc: Y.Doc) {
    this.#doc = doc;
  }

  static create(title = "Café menu"): MenuDraftCrdtResult<MenuDraftDoc> {
    const normalized = normalizePlainText(title);
    if (!validText(normalized)) return failure("text_too_long");
    const doc = createEmptyDocument();
    doc.getMap("menu").set("title", normalized);
    return success(new MenuDraftDoc(doc));
  }

  static createReplica(): MenuDraftDoc {
    return new MenuDraftDoc(createEmptyDocument());
  }

  static restore(state: MenuDraftState): MenuDraftCrdtResult<MenuDraftDoc> {
    const doc = createEmptyDocument();
    try {
      Y.applyUpdate(doc, state.encode());
      const valid = validateDocument(doc);
      if (!valid.ok) {
        doc.destroy();
        return valid;
      }
      return success(new MenuDraftDoc(doc));
    } catch {
      doc.destroy();
      return failure("invalid_state");
    }
  }

  read(): MenuDraftSnapshot {
    const sections: MenuSection[] = [];
    for (const [id, raw] of this.#doc.getMap("sections")) {
      if (raw instanceof Y.Map) sections.push(readSection(id, raw));
    }
    const items: MenuItem[] = [];
    for (const [id, raw] of this.#doc.getMap("items")) {
      if (raw instanceof Y.Map) items.push(readItem(id, raw));
    }
    sections.sort(compareOrderedRecord);
    items.sort(compareMenuItems);
    return {
      title: String(this.#doc.getMap("menu").get("title") ?? "Café menu"),
      sections,
      items,
    };
  }

  state(): MenuDraftCrdtResult<MenuDraftState> {
    return parseMenuDraftState(Y.encodeStateAsUpdate(this.#doc));
  }

  stateVector(): MenuDraftCrdtResult<MenuDraftStateVector> {
    return parseMenuDraftStateVector(Y.encodeStateVector(this.#doc));
  }

  syncUpdate(remoteStateVector: MenuDraftStateVector): MenuDraftCrdtResult<MenuDraftUpdate> {
    try {
      return parseMenuDraftUpdate(Y.encodeStateAsUpdate(this.#doc, remoteStateVector.encode()));
    } catch {
      return failure("invalid_state_vector");
    }
  }

  apply(update: MenuDraftUpdate): MenuDraftCrdtResult<null> {
    const candidate = cloneDocument(this.#doc);
    try {
      Y.applyUpdate(candidate, update.encode());
      const valid = validateDocument(candidate);
      if (!valid.ok) {
        candidate.destroy();
        return valid;
      }
    } catch {
      candidate.destroy();
      return failure("invalid_update");
    }
    this.#replace(candidate);
    return success(null);
  }

  rename(title: string): MenuDraftCrdtResult<MenuDraftUpdate> {
    const normalized = normalizePlainText(title);
    if (!validText(normalized)) return failure("text_too_long");
    return this.#mutate(setMenuTitle.bind(null, normalized));
  }

  addSection(section: MenuSection): MenuDraftCrdtResult<MenuDraftUpdate> {
    return this.#mutate(addMenuSection.bind(null, section));
  }

  addItem(item: MenuItem): MenuDraftCrdtResult<MenuDraftUpdate> {
    return this.#mutate(addMenuItem.bind(null, item));
  }

  renameItem(itemId: string, displayName: string): MenuDraftCrdtResult<MenuDraftUpdate> {
    return this.#mutate(editMenuItemText.bind(null, itemId, "displayName", displayName));
  }

  describeItem(itemId: string, description: string): MenuDraftCrdtResult<MenuDraftUpdate> {
    return this.#mutate(editMenuItemText.bind(null, itemId, "description", description));
  }

  moveItem(itemId: string, placement: MenuItemPlacement): MenuDraftCrdtResult<MenuDraftUpdate> {
    return this.#mutate(moveMenuItem.bind(null, itemId, placement));
  }

  deleteItem(itemId: string): MenuDraftCrdtResult<MenuDraftUpdate> {
    return this.#mutate(deleteMenuItem.bind(null, itemId));
  }

  destroy(): void {
    this.#doc.destroy();
  }

  #mutate(operation: (doc: Y.Doc) => MenuDraftCrdtResult<null>): MenuDraftCrdtResult<MenuDraftUpdate> {
    const candidate = cloneDocument(this.#doc);
    const updates: Uint8Array[] = [];
    const captureUpdate = captureYjsUpdate.bind(null, updates);
    candidate.on("update", captureUpdate);
    const changed = operation(candidate);
    candidate.off("update", captureUpdate);
    if (!changed.ok) {
      candidate.destroy();
      return changed;
    }
    const valid = validateDocument(candidate);
    if (!valid.ok) {
      candidate.destroy();
      return valid;
    }
    if (updates.length === 0) {
      candidate.destroy();
      return failure("record_conflict");
    }
    const update = parseMenuDraftUpdate(Y.mergeUpdates(updates));
    if (!update.ok) {
      candidate.destroy();
      return update;
    }
    this.#replace(candidate);
    return update;
  }

  #replace(candidate: Y.Doc): void {
    this.#doc.destroy();
    this.#doc = candidate;
  }
}

function createEmptyDocument(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap("menu");
  doc.getMap("sections");
  doc.getMap("items");
  return doc;
}

function cloneDocument(source: Y.Doc): Y.Doc {
  const candidate = createEmptyDocument();
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(source));
  candidate.clientID = source.clientID;
  return candidate;
}

function setMenuTitle(title: string, doc: Y.Doc): MenuDraftCrdtResult<null> {
  doc.getMap("menu").set("title", title);
  return success(null);
}

function captureYjsUpdate(updates: Uint8Array[], update: Uint8Array): void {
  updates.push(update);
}

function addMenuSection(section: MenuSection, doc: Y.Doc): MenuDraftCrdtResult<null> {
  if (!validId(section.id) || !validText(section.title) || !validOrder(section.order)) {
    return failure("invalid_document_shape");
  }
  const sections = doc.getMap("sections");
  if (sections.has(section.id)) return failure("record_conflict");
  const value = new Y.Map<unknown>();
  value.set("title", normalizePlainText(section.title));
  value.set("order", section.order);
  sections.set(section.id, value);
  return success(null);
}

function addMenuItem(item: MenuItem, doc: Y.Doc): MenuDraftCrdtResult<null> {
  if (!validItem(item) || !doc.getMap("sections").has(item.placement.sectionId)) {
    return failure("invalid_document_shape");
  }
  const items = doc.getMap("items");
  if (items.has(item.id)) return failure("record_conflict");
  const value = new Y.Map<unknown>();
  value.set("productId", item.productId);
  value.set("displayName", new Y.Text(normalizePlainText(item.displayName)));
  value.set("description", new Y.Text(normalizePlainText(item.description)));
  value.set("placement", encodePlacement(item.placement));
  items.set(item.id, value);
  return success(null);
}

function editMenuItemText(
  itemId: string,
  field: "displayName" | "description",
  value: string,
  doc: Y.Doc,
): MenuDraftCrdtResult<null> {
  const item = doc.getMap("items").get(itemId);
  if (!(item instanceof Y.Map)) return failure("record_conflict");
  const text = item.get(field);
  if (!(text instanceof Y.Text)) return failure("invalid_document_shape");
  const next = normalizePlainText(value);
  if (!validText(next)) return failure("text_too_long");
  doc.transact(splicePlainText.bind(null, text, text.toString(), next, undefined));
  return success(null);
}

function moveMenuItem(itemId: string, placement: MenuItemPlacement, doc: Y.Doc): MenuDraftCrdtResult<null> {
  const item = doc.getMap("items").get(itemId);
  if (!(item instanceof Y.Map) || !doc.getMap("sections").has(placement.sectionId) || !validOrder(placement.order)) {
    return failure("record_conflict");
  }
  setItemPlacement(item, placement);
  return success(null);
}

function setItemPlacement(item: Y.Map<unknown>, placement: MenuItemPlacement): void {
  item.set("placement", encodePlacement(placement));
}

function deleteMenuItem(itemId: string, doc: Y.Doc): MenuDraftCrdtResult<null> {
  const items = doc.getMap("items");
  if (!items.has(itemId)) return failure("record_conflict");
  items.delete(itemId);
  return success(null);
}

function validateDocument(doc: Y.Doc): MenuDraftCrdtResult<null> {
  if (doc.share.size !== 3 || !(doc.share.get("menu") instanceof Y.Map) ||
    !(doc.share.get("sections") instanceof Y.Map) || !(doc.share.get("items") instanceof Y.Map)) {
    return failure("invalid_document_shape");
  }
  const menu = doc.getMap("menu");
  if (menu.size !== 1 || !validText(menu.get("title"))) return failure("invalid_document_shape");
  const sections = doc.getMap("sections");
  const items = doc.getMap("items");
  if (sections.size > MENU_SECTION_LIMIT || items.size > MENU_ITEM_LIMIT) return failure("collection_limit");
  for (const [id, section] of sections) {
    if (!(section instanceof Y.Map) || !validSectionMap(id, section)) return failure("invalid_document_shape");
  }
  for (const [id, item] of items) {
    if (!(item instanceof Y.Map) || !validItemMap(id, item, sections)) return failure("invalid_document_shape");
  }
  if (Y.encodeStateAsUpdate(doc).byteLength > MENU_STATE_LIMIT) return failure("state_too_large");
  if (Y.encodeStateVector(doc).byteLength > MENU_STATE_VECTOR_LIMIT) return failure("state_vector_too_large");
  return success(null);
}

function validSectionMap(id: string, section: Y.Map<unknown>): boolean {
  return validId(id) && section.size === 2 && validText(section.get("title")) && validOrder(section.get("order"));
}

function validItemMap(id: string, item: Y.Map<unknown>, sections: Y.Map<unknown>): boolean {
  const placement = parsePlacement(item.get("placement"));
  return validId(id) && item.size === 4 && validId(item.get("productId")) &&
    validSharedText(item.get("displayName")) && validSharedText(item.get("description")) &&
    placement !== null && sections.has(placement.sectionId);
}

function validItem(item: MenuItem): boolean {
  return validId(item.id) && validId(item.productId) && validText(item.displayName) &&
    validText(item.description) && validId(item.placement.sectionId) && validOrder(item.placement.order);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_:-]{1,128}$/u.test(value);
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MENU_TEXT_LIMIT && hasValidPlainTextShape(value);
}

function validSharedText(value: unknown): value is Y.Text {
  if (!(value instanceof Y.Text) || !validText(value.toString())) return false;
  for (const part of value.toDelta()) {
    if (typeof part.insert !== "string" || part.attributes !== undefined) return false;
  }
  return true;
}

function validOrder(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}

function readSection(id: string, section: Y.Map<unknown>): MenuSection {
  return { id, title: String(section.get("title")), order: Number(section.get("order")) };
}

function readItem(id: string, item: Y.Map<unknown>): MenuItem {
  const placement = parsePlacement(item.get("placement"));
  if (placement === null) throw new Error("invalid menu item placement");
  return {
    id,
    productId: String(item.get("productId")),
    displayName: String(item.get("displayName")),
    description: String(item.get("description")),
    placement,
  };
}

function parsePlacement(value: unknown): MenuItemPlacement | null {
  if (typeof value !== "string") return null;
  const separator = value.lastIndexOf("@");
  if (separator < 1) return null;
  const sectionId = value.slice(0, separator);
  const order = Number(value.slice(separator + 1));
  return validId(sectionId) && validOrder(order) ? { sectionId, order } : null;
}

function encodePlacement(placement: MenuItemPlacement): string {
  return `${placement.sectionId}@${placement.order}`;
}

function compareOrderedRecord(first: MenuSection, second: MenuSection): number {
  return first.order - second.order || first.id.localeCompare(second.id);
}

function compareMenuItems(first: MenuItem, second: MenuItem): number {
  return first.placement.sectionId.localeCompare(second.placement.sectionId) ||
    first.placement.order - second.placement.order || first.id.localeCompare(second.id);
}

function success<T>(value: T): MenuDraftCrdtResult<T> {
  return { ok: true, value };
}

function failure(code: MenuDraftCrdtError["code"]): MenuDraftCrdtResult<never> {
  return { ok: false, error: { code } };
}
