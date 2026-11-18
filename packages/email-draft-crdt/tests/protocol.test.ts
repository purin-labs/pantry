import { describe, expect, it } from "vitest";
import { EmailDraftDoc } from "../src/index";
import {
  encodeEmailDraftClientMessage,
  encodeEmailDraftServerMessage,
  parseEmailDraftClientMessage,
  parseEmailDraftServerMessage,
} from "../src/protocol";

describe("email draft protocol", () => {
  it("round trips sync and field-aware presence", () => {
    const doc = requireDoc(EmailDraftDoc.create());
    const vector = requireValue(doc.stateVector());
    const update = requireValue(doc.syncUpdate(vector));
    const request = parseEmailDraftClientMessage(encodeEmailDraftClientMessage({ kind: "sync_request", stateVector: vector }));
    expect(request.ok && request.value.kind).toBe("sync_request");

    const presence = doc.captureSelection("body", 0, 0, "none");
    const parsedPresence = parseEmailDraftClientMessage(encodeEmailDraftClientMessage({
      kind: "presence_update",
      state: "editing",
      selection: presence,
    }));
    expect(parsedPresence.ok && parsedPresence.value.kind === "presence_update" && parsedPresence.value.selection?.field).toBe("body");

    const response = parseEmailDraftServerMessage(encodeEmailDraftServerMessage({
      kind: "sync_response",
      serverStateVector: vector,
      missingUpdate: update,
      documentRevision: 1,
      access: "edit",
      sessionId: "session-1",
    }));
    expect(response.ok && response.value.kind === "sync_response" && response.value.documentRevision).toBe(1);
  });

  it("rejects a presence selection without a valid field", () => {
    expect(parseEmailDraftClientMessage(JSON.stringify({
      protocolVersion: "email_draft_sync.v2",
      kind: "presence_update",
      state: "editing",
      selection: { field: "recipients", anchor: { start: [1], end: [1], direction: "none" } },
    })).ok).toBe(false);
  });
});

function requireDoc(result: ReturnType<typeof EmailDraftDoc.create>): EmailDraftDoc {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function requireValue<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: Readonly<{ code: string }> }>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
