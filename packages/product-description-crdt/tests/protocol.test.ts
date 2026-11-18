import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  FRAME_LIMIT,
  encodeDraftClientMessage,
  encodeDraftServerMessage,
  parseDraftClientMessage,
  parseDraftServerMessage,
} from "../src/protocol";
import {
  ProductDescriptionDoc,
  parseProductDescriptionState,
  parseProductDescriptionStateVector,
  parseProductDescriptionUpdate,
  type ProductDescriptionCrdtResult,
  type ProductDescriptionStateVector,
  type ProductDescriptionUpdate,
} from "../src/index";

function value<T>(result: ProductDescriptionCrdtResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function parseUpdate(doc: Y.Doc, stateVector: Uint8Array): ProductDescriptionUpdate {
  return value(parseProductDescriptionUpdate(Y.encodeStateAsUpdate(doc, stateVector)));
}

function parseStateVector(doc: Y.Doc): ProductDescriptionStateVector {
  return value(parseProductDescriptionStateVector(Y.encodeStateVector(doc)));
}

function frameWithTrailingSpaces(frame: string, totalBytes: number): string {
  const bytes = new TextEncoder().encode(frame);
  return frame + " ".repeat(totalBytes - bytes.byteLength);
}

describe("description draft protocol", () => {
  it("rejects mouse coordinates outside the workspace and unknown pointer fields", () => {
    for (const position of [{ x: -0.1, y: 0 }, { x: 0, y: 1.1 }, { x: "0", y: 0 }, { x: 0, y: 0, extra: true }]) {
      const frame = JSON.stringify({ protocolVersion: "product_description_sync.v2", kind: "pointer_update", position });
      expect(parseDraftClientMessage(frame)).toEqual({ ok: false, error: { code: "invalid_message" } });
    }
  });
  it("round-trips each client and server branch with exact fields", () => {
    const source = new Y.Doc();
    source.getText("description").insert(0, "Coffee");
    const stateVector = parseStateVector(source);
    const update = parseUpdate(source, new Uint8Array([0]));
    const clientMessages = [
      { kind: "sync_request", stateVector } as const,
      { kind: "submit_update", updateId: "update_1", update } as const,
      { kind: "presence_update", state: "editing", selection: null } as const,
      { kind: "pointer_update", position: { x: 0.25, y: 0.75 } } as const,
      { kind: "pointer_update", position: null } as const,
    ];
    for (const message of clientMessages) {
      const parsed = parseDraftClientMessage(encodeDraftClientMessage(message));
      expect(parsed).toEqual({ ok: true, value: message });
    }

    const serverMessages = [
      { kind: "sync_response", serverStateVector: stateVector, missingUpdate: update,
        initializedFromProductRevision: 1, currentProductRevision: 2, access: "edit", sessionId: "session_1" } as const,
      { kind: "update_accepted", updateId: "update_1" } as const,
      { kind: "update_broadcast", update } as const,
      { kind: "presence_changed", agents: [], participants: [{ sessionId: "session_1", userId: "identity", displayName: "Ada", state: "editing", selection: null, activeAt: 0, pointer: { position: { x: 0.25, y: 0.75 }, updatedAt: 1 } }] } as const,
      { kind: "failure", code: "access_revoked" } as const,
    ];
    for (const message of serverMessages) {
      const parsed = parseDraftServerMessage(encodeDraftServerMessage(message));
      expect(parsed).toEqual({ ok: true, value: message });
    }
  });

  it("rejects unknown, missing, and extra protocol fields", () => {
    const frames = [
      JSON.stringify({ protocolVersion: "product_description_sync.v2", kind: "presence_update" }),
      JSON.stringify({ protocolVersion: "product_description_sync.v2", kind: "presence_update", state: "editing", extra: true }),
      JSON.stringify({ protocolVersion: "product_description_sync.v2", kind: "unknown", state: "editing" }),
      JSON.stringify({ protocolVersion: "product_description_sync.v2", kind: "update_accepted", updateId: "ok", extra: null }),
    ];
    for (const frame of frames) {
      expect(parseDraftClientMessage(frame)).toEqual({ ok: false, error: { code: "invalid_message" } });
      expect(parseDraftServerMessage(frame)).toEqual({ ok: false, error: { code: "invalid_message" } });
    }
  });

  it("rejects malformed base64url and invalid update or state-vector bytes", () => {
    const malformed = ["=", "A", "AA=", "AA+", "AA/", "AA ", "AA\n"];
    for (const encoded of malformed) {
      const update = JSON.stringify({ protocolVersion: "product_description_sync.v2", kind: "submit_update", updateId: "u", update: encoded });
      const request = JSON.stringify({ protocolVersion: "product_description_sync.v2", kind: "sync_request", stateVector: encoded });
      expect(parseDraftClientMessage(update)).toEqual({ ok: false, error: { code: "invalid_message" } });
      expect(parseDraftClientMessage(request)).toEqual({ ok: false, error: { code: "invalid_message" } });
    }
  });

  it("accepts a frame exactly at the UTF-8 limit and rejects the next byte", () => {
    const base = encodeDraftClientMessage({ kind: "presence_update", state: "viewing", selection: null });
    const exact = frameWithTrailingSpaces(base, FRAME_LIMIT);
    expect(new TextEncoder().encode(exact).byteLength).toBe(FRAME_LIMIT);
    expect(parseDraftClientMessage(exact)).toEqual({ ok: true, value: { kind: "presence_update", state: "viewing", selection: null } });
    expect(parseDraftClientMessage(`${exact} `)).toEqual({ ok: false, error: { code: "invalid_message" } });
  });

  it("rejects trailing bytes in V1 updates while retaining deletion-only updates", () => {
    const source = value(ProductDescriptionDoc.create("Coffee"));
    const update = value(source.edit("Cafe"));
    const bytes = update.encode();
    expect(parseProductDescriptionUpdate(new Uint8Array([...bytes, 255]))).toEqual({ ok: false, error: { code: "invalid_update" } });
    const stateVector = value(source.stateVector()).encode();
    expect(parseProductDescriptionStateVector(new Uint8Array([...stateVector, 255]))).toEqual({ ok: false, error: { code: "invalid_state_vector" } });

    const deletionSource = new Y.Doc();
    const text = deletionSource.getText("description");
    text.insert(0, "Coffee");
    const deletionState = Y.encodeStateAsUpdate(deletionSource);
    const deletionVector = Y.encodeStateVector(deletionSource);
    text.delete(0, 1);
    const deletion = value(parseProductDescriptionUpdate(Y.encodeStateAsUpdate(deletionSource, deletionVector)));
    expect(deletion.encode().byteLength).toBeGreaterThan(0);
    expect(value(parseProductDescriptionUpdate(deletion.encode())).encode()).toEqual(deletion.encode());
    expect(value(parseProductDescriptionState(deletionState)).encode()).toEqual(deletionState);
  });
});
