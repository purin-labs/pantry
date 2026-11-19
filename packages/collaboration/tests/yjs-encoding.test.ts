import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { parseYjsEncoding, type YjsEncodingResult } from "../src/index.ts";

const LIMITS = { state: 128, update: 64, stateVector: 32 } as const;

function value<T>(result: YjsEncodingResult<T>): T {
  if (!result.ok) {
    throw new Error(result.error.code);
  }
  return result.value;
}

describe("bounded Yjs encodings", () => {
  it("parses canonical states, updates, and state vectors without exposing mutable bytes", () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "Coffee");
    const stateBytes = Y.encodeStateAsUpdate(doc);
    const state = value(parseYjsEncoding("state", stateBytes, LIMITS));
    const vector = value(parseYjsEncoding("state_vector", Y.encodeStateVector(doc), LIMITS));
    const update = value(parseYjsEncoding("update", Y.encodeStateAsUpdate(doc, new Uint8Array([0])), LIMITS));

    stateBytes.fill(255);
    state.encode().fill(255);

    expect(Y.decodeUpdate(state.encode()).structs.length).toBeGreaterThan(0);
    expect(vector.kind).toBe("state_vector");
    expect(update.kind).toBe("update");
  });

  it("rejects trailing, malformed, and oversized encodings", () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "Coffee");
    const update = Y.encodeStateAsUpdate(doc);
    expect(parseYjsEncoding("update", new Uint8Array([...update, 255]), LIMITS)).toEqual({
      ok: false,
      error: { code: "invalid_update" },
    });
    expect(parseYjsEncoding("state_vector", new Uint8Array(), LIMITS)).toEqual({
      ok: false,
      error: { code: "invalid_state_vector" },
    });
    expect(parseYjsEncoding("update", new Uint8Array(LIMITS.update + 1), LIMITS)).toEqual({
      ok: false,
      error: { code: "update_too_large" },
    });
  });
});
