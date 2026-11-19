import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  EmailDraftDoc,
  parseEmailDraftUpdate,
} from "../src/index.ts";

describe("EmailDraftDoc", () => {
  it("converges concurrent edits in separate fields", () => {
    const first = requireDoc(EmailDraftDoc.create());
    const second = clone(first);
    const subject = requireValue(first.edit("subject", "Autumn menu"));
    const body = requireValue(second.edit("body", "Fresh pastries every morning."));

    expect(first.apply(body).ok).toBe(true);
    expect(second.apply(subject).ok).toBe(true);
    expect(first.read()).toEqual(second.read());
    expect(first.read()).toEqual({ subject: "Autumn menu", preview: "", body: "Fresh pastries every morning." });
  });

  it("converges concurrent edits in one field", () => {
    const first = requireDoc(EmailDraftDoc.create({ subject: "", preview: "", body: "Hello cafe" }));
    const second = clone(first);
    const firstUpdate = requireValue(first.edit("body", "Warm Hello cafe", { start: 0, end: 0 }));
    const secondUpdate = requireValue(second.edit("body", "Hello cafe friends", { start: 10, end: 10 }));

    expect(first.apply(secondUpdate).ok).toBe(true);
    expect(second.apply(firstUpdate).ok).toBe(true);
    expect(first.read()).toEqual(second.read());
    expect(first.read().body).toContain("Warm ");
    expect(first.read().body).toContain(" friends");
  });

  it("anchors selections to the named field", () => {
    const doc = requireDoc(EmailDraftDoc.create({ subject: "Subject", preview: "Preview", body: "Body" }));
    const selection = doc.captureSelection("preview", 1, 4, "forward");
    expect(doc.resolveSelection(selection)).toEqual({ start: 1, end: 4, direction: "forward" });
  });

  it("rejects unknown roots and oversized fields", () => {
    const invalid = new Y.Doc();
    invalid.getText("unexpected").insert(0, "bad");
    const parsed = parseEmailDraftUpdate(Y.encodeStateAsUpdate(invalid));
    expect(parsed).toEqual({ ok: false, error: { code: "invalid_document_shape" } });

    const doc = requireDoc(EmailDraftDoc.create());
    expect(doc.edit("subject", "x".repeat(201))).toEqual({ ok: false, error: { code: "field_too_long" } });
  });
});

function clone(source: EmailDraftDoc): EmailDraftDoc {
  const state = requireValue(source.state());
  return requireDoc(EmailDraftDoc.restore(state));
}

function requireDoc(result: ReturnType<typeof EmailDraftDoc.create> | ReturnType<typeof EmailDraftDoc.restore>): EmailDraftDoc {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function requireValue<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: Readonly<{ code: string }> }>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
