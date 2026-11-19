import { requireConversationId } from "./test-ids";
import { afterEach, expect, it, vi } from "vitest";
import { readChat } from "../../../apps/portal/src/features/chat/api";
import { parseChatStreamRecord } from "@purin-labs/control-api/portal/chat-stream";
import { readChatStream, type ChatStreamRecord } from "../../../apps/portal/src/features/chat/stream";

afterEach(restoreGlobals);

function restoreGlobals(): void {
  vi.unstubAllGlobals();
}

it("reports a non-JSON server interruption as its HTTP status", async function reportsUnreadableResponse() {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response("Your worker was restarted", { status: 503 }),
      ),
  );

  await expect(readChat("organisation_test", null)).rejects.toThrow("HTTP 503");
});

it("reads chunked NDJSON records through a terminal event", async function readsChunkedStream() {
  const chunks = [
    '{"kind":"assistant_text_delta","sequence":1,"te',
    'xt":"Hel"}\n{"kind":"assistant_text_delta","sequence":2,"text":"lo"}\n',
    '{"kind":"complete","sequence":3,"conversationRevision":2}\n',
  ];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(chunkedResponse(chunks)));
  const records: ChatStreamRecord[] = [];
  const terminal = await readChatStream({
    organisationId: "organisation_test",
    conversationId: requireConversationId("conv_7d980f41-a532-5387-9ea1-548f956b6e3e"),
    requestId: "request_test",
    afterSequence: -1,
    signal: new AbortController().signal,
    accept: records.push.bind(records),
  });
  expect(records).toEqual([
    { kind: "assistant_text_delta", sequence: 1, text: "Hel" },
    { kind: "assistant_text_delta", sequence: 2, text: "lo" },
    { kind: "complete", sequence: 3, conversationRevision: 2 },
  ]);
  expect(terminal).toEqual({
    kind: "complete",
    sequence: 3,
    conversationRevision: 2,
  });
});

it("rejects malformed public stream records", function rejectsMalformedRecord() {
  expect(function parseMalformedRecord() {
    parseChatStreamRecord({
      kind: "assistant_delta",
      sequence: 1,
      text: "",
    });
  }).toThrow("invalid event");
});

function chunkedResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
}
