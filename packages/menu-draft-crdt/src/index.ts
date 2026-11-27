import {
  checkDocumentSize,
  defineSharedDoc,
  hasValidPlainTextShape,
  normalizePlainText,
  sharedDocFailure as failure,
  sharedDocSuccess as success,
  splicePlainText,
  type SharedDocEncoding,
  type SharedDocError,
  type SharedDocResult,
} from "@purin-labs/collaboration";
import * as Y from "yjs";

export const MENU_DRAFT_SCHEMA = "menu_draft_crdt.v2";
export const MENU_SECTION_LIMIT = 20;
export const MENU_ITEM_LIMIT = 200;
export const MENU_TEXT_LIMIT = 1_000;
const MENU_STATE_LIMIT = 768 * 1024;
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

/** The document's own failures, beside the failures of an encoding. */
const FAILURES = [
  "invalid_document_shape",
  "collection_limit",
  "text_too_long",
  "record_conflict",
] as const;
export type MenuDraftCrdtError = SharedDocError<(typeof FAILURES)[number]>;
export type MenuDraftCrdtResult<T> = SharedDocResult<T, MenuDraftCrdtError["code"]>;

const ENCODING_LIMITS = {
  state: MENU_STATE_LIMIT,
  update: MENU_UPDATE_LIMIT,
  stateVector: MENU_STATE_VECTOR_LIMIT,
} as const;

export const menuDraftDocument = defineSharedDoc({
  schema: MENU_DRAFT_SCHEMA,
  limits: ENCODING_LIMITS,
  failures: FAILURES,
  roots: { menu: "map", sections: "map", items: "map" },
  shapeFailure: "invalid_document_shape",
  validate: validateDocument,
  unchangedFailure: "record_conflict",
});

type Schema = typeof MENU_DRAFT_SCHEMA;
type MenuDraftState = SharedDocEncoding<"state", Schema>;
export type MenuDraftUpdate = SharedDocEncoding<"update", Schema>;
export type MenuDraftStateVector = SharedDocEncoding<"state_vector", Schema>;

export const parseMenuDraftState = menuDraftDocument.parseState;

export class MenuDraftDoc extends menuDraftDocument.Doc {
  static create(title = "Café menu"): MenuDraftCrdtResult<MenuDraftDoc> {
    const normalized = normalizePlainText(title);
    if (!validText(normalized)) return failure("text_too_long");
    const doc = menuDraftDocument.emptyDocument();
    doc.getMap("menu").set("title", normalized);
    return success(new MenuDraftDoc(doc));
  }

  static createReplica(): MenuDraftDoc {
    return new MenuDraftDoc(menuDraftDocument.emptyDocument());
  }

  static restore(state: MenuDraftState): MenuDraftCrdtResult<MenuDraftDoc> {
    const doc = menuDraftDocument.restore(state);
    return doc.ok ? success(new MenuDraftDoc(doc.value)) : doc;
  }

  read(): MenuDraftSnapshot {
    const sections: MenuSection[] = [];
    for (const [id, raw] of this.doc.getMap("sections")) {
      if (raw instanceof Y.Map) sections.push(readSection(id, raw));
    }
    const items: MenuItem[] = [];
    for (const [id, raw] of this.doc.getMap("items")) {
      if (raw instanceof Y.Map) items.push(readItem(id, raw));
    }
    sections.sort(compareOrderedRecord);
    items.sort(compareMenuItems);
    return {
      title: String(this.doc.getMap("menu").get("title") ?? "Café menu"),
      sections,
      items,
    };
  }

  rename(title: string): MenuDraftCrdtResult<MenuDraftUpdate> {
    const normalized = normalizePlainText(title);
    if (!validText(normalized)) return failure("text_too_long");
    return this.mutate(setMenuTitle.bind(null, normalized));
  }

  addSection(section: MenuSection): MenuDraftCrdtResult<MenuDraftUpdate> {
    return this.mutate(addMenuSection.bind(null, section));
  }

  addItem(item: MenuItem): MenuDraftCrdtResult<MenuDraftUpdate> {
    return this.mutate(addMenuItem.bind(null, item));
  }

  renameItem(itemId: string, displayName: string): MenuDraftCrdtResult<MenuDraftUpdate> {
    return this.mutate(editMenuItemText.bind(null, itemId, "displayName", displayName));
  }

  describeItem(itemId: string, description: string): MenuDraftCrdtResult<MenuDraftUpdate> {
    return this.mutate(editMenuItemText.bind(null, itemId, "description", description));
  }

  moveItem(itemId: string, placement: MenuItemPlacement): MenuDraftCrdtResult<MenuDraftUpdate> {
    return this.mutate(moveMenuItem.bind(null, itemId, placement));
  }

  deleteItem(itemId: string): MenuDraftCrdtResult<MenuDraftUpdate> {
    return this.mutate(deleteMenuItem.bind(null, itemId));
  }
}

function setMenuTitle(title: string, doc: Y.Doc): MenuDraftCrdtResult<null> {
  doc.getMap("menu").set("title", title);
  return success(null);
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

/** The check of the content. The shared document checks the roots first. */
function validateDocument(doc: Y.Doc): MenuDraftCrdtResult<null> {
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
  return checkDocumentSize(doc, ENCODING_LIMITS);
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
