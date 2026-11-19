import { env } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it } from "vitest";
import { isRecord } from "@purin-labs/std";
import {
  RecordingBoundary,
  sdkInput,
  freshForkInput,
  restoredInput,
  runSdkTurn,
} from "./pi-sdk-support";
import { network } from "./network";
import {
  openRouterText,
  openRouterToolCall,
  openRouterStream,
} from "./slack-journey-support";

const LARGE_ACCEPTED_RESPONSE = "Accepted batch evidence. ".repeat(5_000);

it("compacts a large accepted turn and restores store and tool loadout without replaying capabilities", async ({
  task,
}) => {
  const boundary = new RecordingBoundary();
  const provider = new CompactionProvider();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      provider.respond.bind(provider),
    ),
  );
  const firstInput = sdkInput(
    boundary,
    [
      {
        type: "function",
        name: "inventory_read",
        description: "Read the accepted bakery inventory revision.",
        strict: true,
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
    "native",
  );
  const first = await runSdkTurn(
    firstInput,
    "Discover inventory, read it twice in parallel, and retain the batch summary.",
  );
  expect(first.finalMessage).toBe(LARGE_ACCEPTED_RESPONSE.trim());
  expect(boundary.capabilityCalls).toBe(2);
  expect(boundary.settlements).toEqual(["succeeded"]);
  const checkpoint = JSON.parse(new TextDecoder().decode(first.checkpoint));
  expect(provider.summaries).toBe(0);
  expect(first.modelUsage.inputTokens).toBe(245_000 + 77 * provider.summaries);

  const forkPrefix = [...boundary.entries];
  const restored = await runSdkTurn(
    restoredInput(firstInput, first, boundary, "compacted"),
    "Report the retained batch summary without repeating reads. " +
      "Inventory evidence. ".repeat(6_000),
  );
  expect(restored.finalMessage).toBe("SDK_COMPACTION_RESTORED");
  expect(boundary.capabilityCalls).toBe(2);
  expect(provider.calls).toBe(5);
  const recovered = await runSdkTurn(
    restoredInput(firstInput, restored, boundary, "compacted_recovered"),
    "Read the retained batch after compaction.",
  );
  expect(recovered.finalMessage).toBe("SDK_COMPACTION_CHECKPOINT_RESTORED");
  expect(boundary.capabilityCalls).toBe(2);
  const forkBoundary = new RecordingBoundary();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      compactedForkReply,
    ),
  );
  const fork = await runSdkTurn(
    freshForkInput(sdkInput(forkBoundary, [], "direct"), forkPrefix),
    "Continue from the earlier inventory batch, before later source requests.",
  );
  expect(fork.finalMessage).toBe("COMPACTED_SOURCE_FORK_READY");
  expect(forkBoundary.capabilityCalls).toBe(0);
  expect(forkBoundary.entries).toHaveLength(2);
  Object.assign(task.meta, {
    piSdkEvidence: {
      scenario: "compaction-recovery",
      fork: {
        inheritedEntries: forkPrefix.length,
        toolCalls: forkBoundary.capabilityCalls,
        response: fork.finalMessage,
      },
      summaries: provider.summaries,
      capabilityCalls: boundary.capabilityCalls,
      settlements: boundary.settlements,
      usage: first.modelUsage,
      checkpoint,
      recoveredCheckpoint: JSON.parse(
        new TextDecoder().decode(restored.checkpoint),
      ),
      requests: provider.requests,
      restoredMessage: restored.finalMessage,
    },
  });
});

class CompactionProvider {
  calls = 0;
  summaries = 0;
  readonly requests: Record<string, unknown>[] = [];

  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    expect(request.headers.get("authorization")).toBe(
      `Bearer ${env.OPENROUTER_API_KEY}`,
    );
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("Invalid model request");
    this.requests.push(body);
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      this.summaries += 1;
      return textWithUsage(
        "Accepted inventory batch. Two governed reads returned the same revision; Code Mode store contains batch={count:2,revision:7}.",
        77,
      );
    }
    this.calls += 1;
    switch (this.calls) {
      case 1:
        // This catalog is small, so the first request offers it whole. The
        // search that follows finds a tool that is enabled and changes nothing.
        expect(toolNames(body)).toEqual(
          expect.arrayContaining(["codemode", "inventory_read", "tool_search"]),
        );
        return openRouterToolCall(
          "tool_search",
          { query: "inventory_read", limit: 1 },
          "compact_discover",
        );
      case 2:
        return openRouterToolCall(
          "codemode",
          {
            code: "const rows = (await Promise.all([tools.inventory_read({}), tools.inventory_read({})])).map((row) => JSON.parse(row)); store('batch', { count: rows.length, revision: rows[0].revision }); text(load('batch'));",
          },
          "compact_batch",
        );
      case 3:
        expect(toolText(body)).toContain('"revision":7');
        return textWithUsage(LARGE_ACCEPTED_RESPONSE, 245_000);
      case 4:
        expect(toolNames(body)).toContain("inventory_read");
        expect(JSON.stringify(body)).toContain("Accepted inventory batch");
        expect(JSON.stringify(body)).not.toContain("compact_batch");
        return openRouterToolCall(
          "codemode",
          { code: "text(load('batch'));" },
          "compact_load",
        );
      case 5:
        expect(toolText(body)).toContain('"count":2');
        expect(toolText(body)).toContain('"revision":7');
        return openRouterText("SDK_COMPACTION_RESTORED", "compact_restored");
      case 6:
        expect(toolNames(body)).toContain("inventory_read");
        return openRouterToolCall(
          "codemode",
          { code: "text(load('batch'));" },
          "compaction_checkpoint_load",
        );
      case 7:
        expect(toolText(body)).toContain('"revision":7');
        return openRouterText(
          "SDK_COMPACTION_CHECKPOINT_RESTORED",
          "compaction_checkpoint_restored",
        );
      default:
        throw new Error("Unexpected compaction model request");
    }
  }
}

function textWithUsage(text: string, inputTokens: number): Response {
  return openRouterStream([
    {
      id: "compaction_usage",
      object: "chat.completion.chunk",
      created: 1_787_500_000,
      model: "moonshotai/kimi-k3",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    },
    {
      id: "compaction_usage",
      object: "chat.completion.chunk",
      created: 1_787_500_000,
      model: "moonshotai/kimi-k3",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: 10,
        total_tokens: inputTokens + 10,
      },
    },
  ]);
}

function toolNames(body: Record<string, unknown>): string[] {
  const names: string[] = [];
  if (!Array.isArray(body.tools)) return names;
  for (const tool of body.tools)
    if (
      isRecord(tool) &&
      isRecord(tool.function) &&
      typeof tool.function.name === "string"
    )
      names.push(tool.function.name);
  return names.sort();
}

function toolText(body: Record<string, unknown>): string {
  if (!Array.isArray(body.messages)) throw new Error("Missing messages");
  for (const message of [...body.messages].reverse())
    if (
      isRecord(message) &&
      message.role === "tool" &&
      typeof message.content === "string"
    )
      return message.content;
  throw new Error("Missing tool output");
}

async function compactedForkReply({
  request,
}: Parameters<HttpResponseResolver>[0]): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid fork provider request");
  const history = JSON.stringify(body.messages);
  expect(history).toContain("croissant");
  expect(history).toContain("financier");
  expect(history).not.toContain("SDK_COMPACTION_RESTORED");
  expect(history).not.toContain("compaction_checkpoint_load");
  expect(body.tools ?? []).toEqual([]);
  if (history.includes("You are a context summarization assistant"))
    return openRouterText(
      "Accepted batch evidence: two inventory reads returned revision 7, croissant and financier. Earlier actions are settled history.",
      "fork_summary",
    );
  return openRouterText("COMPACTED_SOURCE_FORK_READY", "compacted_fork");
}
