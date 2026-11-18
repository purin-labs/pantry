import { describe, expect, it } from "vitest";
import { MenuDraftDoc } from "../src/index";
import {
  encodeMenuDraftServerMessage,
  FRAME_LIMIT,
  parseMenuDraftServerMessage,
} from "../src/protocol";

describe("MenuDraftDoc", () => {
  it("merges simultaneous edits to separate passages of one description", mergesDescriptionPassages);
  it("round-trips a full-size menu through the reconnect protocol", reconnectsLargeMenu);
  it("converges simultaneous moves of the same item to one placement", () => {
    const base = seededMenu();
    const first = clone(base);
    const second = clone(base);
    const firstMove = requireValue(first.moveItem("item_tea", { sectionId: "section_lunch", order: 0 }));
    const secondMove = requireValue(second.moveItem("item_tea", { sectionId: "section_breakfast", order: 9 }));

    expect(first.apply(secondMove).ok).toBe(true);
    expect(second.apply(firstMove).ok).toBe(true);
    expect(first.read()).toEqual(second.read());
    expect(first.read().items.filter((item) => item.id === "item_tea")).toHaveLength(1);
  });

  it("keeps deletion terminal when it races with a nested edit", () => {
    const base = seededMenu();
    const deleting = clone(base);
    const editing = clone(base);
    const deletion = requireValue(deleting.deleteItem("item_tea"));
    const edit = requireValue(editing.renameItem("item_tea", "Iced tea"));

    expect(deleting.apply(edit).ok).toBe(true);
    expect(editing.apply(deletion).ok).toBe(true);
    expect(deleting.read()).toEqual(editing.read());
    expect(deleting.read().items).toHaveLength(0);
  });

  it("converges edits to separate items", () => {
    const base = seededMenu();
    requireValue(base.addItem({
      id: "item_coffee",
      productId: "product_coffee",
      displayName: "Coffee",
      description: "",
      placement: { sectionId: "section_breakfast", order: 2 },
    }));
    const first = clone(base);
    const second = clone(base);
    const tea = requireValue(first.renameItem("item_tea", "Tea pot"));
    const coffee = requireValue(second.describeItem("item_coffee", "Freshly brewed"));
    expect(first.apply(coffee).ok).toBe(true);
    expect(second.apply(tea).ok).toBe(true);
    expect(first.read()).toEqual(second.read());
  });

  it("preserves concurrent edits to separate fields of one item", () => {
    const base = seededMenu();
    const naming = clone(base);
    const describing = clone(base);
    const name = requireValue(naming.renameItem("item_tea", "Iced tea"));
    const description = requireValue(describing.describeItem("item_tea", "Bright and cold"));

    expect(naming.apply(description).ok).toBe(true);
    expect(describing.apply(name).ok).toBe(true);
    expect(naming.read()).toEqual(describing.read());
    expect(naming.read().items[0]).toMatchObject({
      displayName: "Iced tea",
      description: "Bright and cold",
    });
  });

  it("starts browser replicas without an independent genesis update", () => {
    const authoritative = seededMenu();
    const replica = MenuDraftDoc.createReplica();
    const update = requireValue(authoritative.syncUpdate(requireValue(replica.stateVector())));

    expect(replica.apply(update).ok).toBe(true);
    expect(replica.read()).toEqual(authoritative.read());
    expect(requireValue(replica.syncUpdate(requireValue(authoritative.stateVector()))).encode())
      .toEqual(new Uint8Array([0, 0]));
  });
});

function mergesDescriptionPassages(): void {
  const base = seededMenu();
  const first = clone(base);
  const second = clone(base);
  try {
    const prefix = requireValue(first.describeItem("item_tea", "A fresh warming pot"));
    const suffix = requireValue(second.describeItem("item_tea", "A warming pot with honey"));
    requireValue(first.apply(suffix));
    requireValue(second.apply(prefix));
    expect(first.read()).toEqual(second.read());
    expect(first.read().items[0]?.description).toBe("A fresh warming pot with honey");
  } finally {
    base.destroy();
    first.destroy();
    second.destroy();
  }
}

function reconnectsLargeMenu(): void {
  const document = seededMenu();
  const replica = MenuDraftDoc.createReplica();
  try {
    for (let index = 1; index < 200; index++) {
      requireValue(document.addItem({
        id: `item_${index}`,
        productId: `product_${index}`,
        displayName: "Name ".repeat(200),
        description: "Description ".repeat(83),
        placement: { sectionId: "section_breakfast", order: index },
      }));
    }
    const update = requireValue(document.syncUpdate(requireValue(replica.stateVector())));
    expect(update.encode().byteLength).toBeGreaterThan(384 * 1024);
    const frame = encodeMenuDraftServerMessage({
      kind: "sync_response",
      sessionId: "large-menu-reconnect",
      serverStateVector: requireValue(document.stateVector()),
      missingUpdate: update,
      documentRevision: 200,
      access: "edit",
    });
    expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(FRAME_LIMIT);
    const parsed = requireValue(parseMenuDraftServerMessage(frame));
    if (parsed.kind !== "sync_response") throw new Error("expected sync response");
    requireValue(replica.apply(parsed.missingUpdate));
    expect(replica.read()).toEqual(document.read());
  } finally {
    document.destroy();
    replica.destroy();
  }
}

function seededMenu(): MenuDraftDoc {
  const doc = requireDoc(MenuDraftDoc.create());
  requireValue(doc.addSection({ id: "section_breakfast", title: "Breakfast", order: 0 }));
  requireValue(doc.addSection({ id: "section_lunch", title: "Lunch", order: 1 }));
  requireValue(doc.addItem({
    id: "item_tea",
    productId: "product_tea",
    displayName: "Tea",
    description: "A warming pot",
    placement: { sectionId: "section_breakfast", order: 1 },
  }));
  return doc;
}

function clone(source: MenuDraftDoc): MenuDraftDoc {
  const state = requireValue(source.state());
  return requireDoc(MenuDraftDoc.restore(state));
}

function requireDoc(result: ReturnType<typeof MenuDraftDoc.create> | ReturnType<typeof MenuDraftDoc.restore>): MenuDraftDoc {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function requireValue<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: Readonly<{ code: string }> }>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
