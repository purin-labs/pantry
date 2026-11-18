import { describe, expect, it } from "vitest";
import { conversationPrompt } from "../src/chat/prompt";
import { parseConversation, type Conversation } from "../src/chat/conversation";

describe("portal chat prompt", function portalChatPromptSuite() {
  it("bounds dynamic context below the harness history entry limit", function boundsDynamicContext() {
    const conversation: Conversation = parseConversation({
      id: "conv_ef6d3122-f88a-5064-a9f0-b3b7b1f64f09",
      title: "Connect a shipping app",
      modelRoute: {
        keySource: "platform",
        provider: "openai-compatible",
        model: "test-model",
      },
      messages: Array.from({ length: 12 }, function userMessage(_, index) {
        return {
          kind: "user" as const,
          id: `message_prompt_${index}`,
          text: `${index}:${"request ".repeat(1_000)}`,
          surfaceContext: null,
        };
      }),
      documents: [
        {
          url: "https://docs.example.com/api",
          sha256: "a".repeat(64),
          text: '日本語 "quoted" documentation\n'.repeat(5_000),
          truncated: false,
        },
      ],
      completedRequests: [],
      work: { kind: "ready" },
      surfaceEventCursor: 0,
      pendingInputs: [],
      latestSequence: 0,
      lastReadSequence: 0,
      draftText: "",
      draftUpdatedAt: null,
      effort: null,
    });
    const connectorStatus = Array.from(
      { length: 200 },
      function connector(_, index) {
        return { connectorId: `connector_${index}`, state: "connected" };
      },
    );
    const prompt = conversationPrompt(conversation, connectorStatus);
    const encodedPromptBytes = new TextEncoder().encode(
      JSON.stringify(prompt),
    ).byteLength;
    expect(encodedPromptBytes).toBeLessThan(13_000);
    expect(prompt).toContain("https://docs.example.com/api");
    expect(prompt).toContain('"truncated":true');
    expect(prompt).toContain("11:request");
  });
});
