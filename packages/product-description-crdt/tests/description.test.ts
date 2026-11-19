import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  DESCRIPTION_LIMIT, UPDATE_LIMIT, STATE_LIMIT, STATE_VECTOR_LIMIT,
  ProductDescriptionDoc, parseProductDescriptionState, parseProductDescriptionUpdate,
  parseProductDescriptionStateVector, type ProductDescriptionCrdtResult,
} from "../src/index.ts";

function value<T>(result: ProductDescriptionCrdtResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function replica(source: ProductDescriptionDoc): ProductDescriptionDoc {
  return value(ProductDescriptionDoc.restore(value(source.state())));
}

function synchronize(left: ProductDescriptionDoc, right: ProductDescriptionDoc): void {
  const toLeft = value(right.syncUpdate(value(left.stateVector())));
  const toRight = value(left.syncUpdate(value(right.stateVector())));
  value(left.apply(toLeft));
  value(right.apply(toRight));
}

describe("product-description replicas", () => {
  it("keeps a remote selection anchored when another author inserts before it", () => {
    const left = value(ProductDescriptionDoc.create("Ginger cookie"));
    const right = replica(left);
    const selection = right.capturePresenceSelection(7, 13, "backward");
    value(left.edit("Fresh Ginger cookie", { start: 0, end: 0 }));
    synchronize(left, right);
    expect(left.resolvePresenceSelection(selection)).toEqual({
      start: 13,
      end: 19,
      direction: "backward",
    });
    expect(right.resolvePresenceSelection(selection)).toEqual(left.resolvePresenceSelection(selection));
    left.destroy();
    right.destroy();
  });

  it("retains every explicitly replaced character during concurrent select-all input", () => {
    const left = value(ProductDescriptionDoc.create("Shared pastry description"));
    const right = replica(left);
    const range = { start: 0, end: left.read().length };
    const a = value(left.edit("First author wording.", range));
    const b = value(right.edit("Second author wording.", range));
    value(left.apply(b));
    value(right.apply(a));
    expect(left.read()).toBe(right.read());
    expect(left.read()).toContain("First author wording.");
    expect(left.read()).toContain("Second author wording.");
    expect(left.read().length).toBe("First author wording.Second author wording.".length);
  });

  it("inserts repeated characters at the actual native caret", () => {
    const left = value(ProductDescriptionDoc.create("aaa"));
    const right = replica(left);
    const a = value(left.edit("aaaa", { start: 0, end: 0 }));
    const b = value(right.edit("aXaa", { start: 1, end: 1 }));
    value(left.apply(b));
    value(right.apply(a));
    expect(left.read()).toBe(right.read());
    expect(left.read()).toBe("aaXaa");
  });

  it("converges concurrent edits, duplicate delivery, and durable restore", () => {
    const left = value(ProductDescriptionDoc.create("Coffee"));
    const right = replica(left);
    const a = value(left.edit("Hot Coffee"));
    const b = value(right.edit("Coffee today"));
    value(right.apply(a));
    value(left.apply(b));
    value(left.apply(b));
    expect(left.read()).toBe("Hot Coffee today");
    expect(right.read()).toBe(left.read());
    expect(replica(left).read()).toBe(left.read());
  });

  it("converges insertions at the same position and overlapping delete/insert", () => {
    const left = value(ProductDescriptionDoc.create("abc"));
    const right = replica(left);
    value(left.edit("aLeftbc"));
    value(right.edit("aRightbc"));
    synchronize(left, right);
    expect(left.read()).toBe(right.read());
    expect(left.read()).toContain("Left");
    expect(left.read()).toContain("Right");
    value(left.edit("ac"));
    value(right.edit(right.read().replace("b", "B")));
    synchronize(left, right);
    expect(left.read()).toBe(right.read());
    expect(left.read()).toContain("B");
  });

  it("exchanges deletion-only changes even when state vectors are equal", () => {
    const left = value(ProductDescriptionDoc.create("Coffee today"));
    const right = replica(left);
    value(left.edit("Coffee"));
    expect(value(left.stateVector()).encode()).toEqual(value(right.stateVector()).encode());
    synchronize(left, right);
    expect(right.read()).toBe("Coffee");
  });

  it("persists dependency-pending updates before their prerequisite arrives", () => {
    const left = value(ProductDescriptionDoc.create(""));
    const right = replica(left);
    const a = value(left.edit("a"));
    const b = value(left.edit("ab"));
    value(right.apply(b));
    expect(right.read()).toBe("");
    const restored = replica(right);
    value(restored.apply(a));
    expect(restored.read()).toBe("ab");
    synchronize(left, restored);
    expect(restored.read()).toBe(left.read());
  });

  it("preserves Unicode splice boundaries and normalizes local line endings", () => {
    const doc = value(ProductDescriptionDoc.create("🍰 cake\r\n☕"));
    value(doc.edit("🍮 cake\r☕"));
    expect(replica(doc).read()).toBe("🍮 cake\n☕");
    value(doc.edit("🍮 cake\n☕🍩"));
    expect(replica(doc).read()).toBe("🍮 cake\n☕🍩");
    expect(doc.edit("\ud800")).toEqual({ ok: false, error: { code: "invalid_document_shape" } });
  });

  it("keeps relative selections across multiple separate remote changes", () => {
    const local = value(ProductDescriptionDoc.create("Coffee and cake"));
    const remote = replica(local);
    const selection = local.captureSelection(7, 10, "backward");
    value(remote.edit("Hot Coffee and cake"));
    value(remote.edit("Hot Coffee and fresh cake"));
    value(local.apply(value(remote.syncUpdate(value(local.stateVector())))));
    expect(local.resolveSelection(selection)).toEqual({ start: 11, end: 14, direction: "backward" });
  });

  it("collapses relative selections when a remote deletion removes their contents", () => {
    const local = value(ProductDescriptionDoc.create("Coffee and cake"));
    const remote = replica(local);
    const selection = local.captureSelection(0, 6, "forward");
    value(remote.edit(" and cake"));
    value(local.apply(value(remote.syncUpdate(value(local.stateVector())))));
    expect(local.resolveSelection(selection)).toEqual({ start: 0, end: 0, direction: "forward" });
  });

  it("retains accepted state when concurrent growth exceeds the text limit", () => {
    const left = value(ProductDescriptionDoc.create("x".repeat(DESCRIPTION_LIMIT - 1)));
    const right = replica(left);
    value(left.edit("a" + left.read()));
    const update = value(right.edit(right.read() + "b"));
    const before = value(left.state()).encode();
    expect(left.apply(update)).toEqual({ ok: false, error: { code: "description_too_long" } });
    expect(value(left.state()).encode()).toEqual(before);
  });
});

describe("untrusted update boundary", () => {
  it("rejects alternate roots, attributes, arrays, embeds, and nested shared types", () => {
    for (const build of [extraRoot, formatting, textAttribute, arrayRoot, embeddedObject, nestedText]) {
      const foreign = new Y.Doc();
      build(foreign);
      expect(parseProductDescriptionUpdate(Y.encodeStateAsUpdate(foreign))).toEqual({ ok: false, error: { code: "invalid_document_shape" } });
    }
  });

  it("rejects rich-text operations even while their dependencies are missing", () => {
    const foreign = new Y.Doc();
    foreign.getText("description").insert(0, "abc");
    const vector = Y.encodeStateVector(foreign);
    foreign.getText("description").format(1, 1, { bold: true });
    expect(parseProductDescriptionUpdate(Y.encodeStateAsUpdate(foreign, vector))).toEqual({ ok: false, error: { code: "invalid_document_shape" } });
  });

  it("rejects malformed and oversized bytes with bounded failures", { timeout: 1000 }, () => {
    for (const bytes of [new Uint8Array(), new Uint8Array([255]), new Uint8Array([1, 1, 1])]) {
      expect(parseProductDescriptionUpdate(bytes).ok).toBe(false);
      expect(parseProductDescriptionState(bytes).ok).toBe(false);
    }
    expect(parseProductDescriptionUpdate(new Uint8Array(UPDATE_LIMIT + 1))).toEqual({ ok: false, error: { code: "update_too_large" } });
    expect(parseProductDescriptionState(new Uint8Array(STATE_LIMIT + 1))).toEqual({ ok: false, error: { code: "state_too_large" } });
    expect(parseProductDescriptionStateVector(new Uint8Array(STATE_VECTOR_LIMIT + 1))).toEqual({ ok: false, error: { code: "state_vector_too_large" } });
    expect(parseProductDescriptionStateVector(new Uint8Array())).toEqual({ ok: false, error: { code: "invalid_state_vector" } });
  });

  it("copies parsed bytes so callers cannot change a validated update", () => {
    const source = value(ProductDescriptionDoc.create("Coffee"));
    const encoded = value(source.state()).encode();
    const parsed = value(parseProductDescriptionState(encoded));
    encoded.fill(255);
    parsed.encode().fill(255);
    expect(value(ProductDescriptionDoc.restore(parsed)).read()).toBe("Coffee");
  });

  it("rejects a pending state whose retained history reaches the state cap", () => {
    const target = value(ProductDescriptionDoc.create(""));
    const before = value(target.state()).encode();
    let refused = false;
    for (let index = 0; index < 40; index++) {
      const foreign = new Y.Doc();
      foreign.getText("description").insert(0, "prerequisite");
      const vector = Y.encodeStateVector(foreign);
      foreign.getText("description").insert(12, "x".repeat(8000));
      const result = target.apply(value(parseProductDescriptionUpdate(Y.encodeStateAsUpdate(foreign, vector))));
      if (!result.ok) {
        expect(result.error.code).toBe("state_too_large");
        refused = true;
        break;
      }
    }
    expect(refused).toBe(true);
    expect(target.read()).toBe("");
    expect(value(target.state()).encode().byteLength).toBeLessThanOrEqual(STATE_LIMIT);
    expect(value(target.state()).encode().byteLength).toBeGreaterThan(before.byteLength);
  });
});

function extraRoot(doc: Y.Doc): void { doc.getText("title").insert(0, "title"); }
function formatting(doc: Y.Doc): void { doc.getText("description").insert(0, "bold", { bold: true }); }
function textAttribute(doc: Y.Doc): void { doc.getText("description").setAttribute("role", "admin"); }
function arrayRoot(doc: Y.Doc): void { doc.getArray("description").insert(0, ["text"]); }
function embeddedObject(doc: Y.Doc): void { doc.getText("description").insertEmbed(0, { image: "image" }); }
function nestedText(doc: Y.Doc): void { doc.getText("description").insertEmbed(0, new Y.Text("nested")); }
