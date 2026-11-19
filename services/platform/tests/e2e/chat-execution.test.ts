import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { http, type HttpResponseResolver } from "msw";
import {
  newConversationId,
  parseCaseExecutionPage,
  parseCaseExecutionNodeDetail,
  type CaseExecutionNode,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import { parseSessionId } from "../../src/ids";
import { resolveActiveSessionActor } from "../../src/actors/actor-router";
import {
  createConversation,
  installMemoryFixture,
  instruct,
  postJson,
} from "./memory-support";
import { openRouterText, openRouterToolCall } from "./slack-journey-support";
import { network } from "./network";

it(
  "reads durable tool inputs and outputs through a chat and refuses another member's private read",
  { timeout: 120_000 },
  chatExecutionJourney,
);

class ExecutionModel {
  private calls = 0;
  async respond(
    _input: Parameters<HttpResponseResolver>[0],
  ): Promise<Response> {
    this.calls += 1;
    if (this.calls === 1)
      return openRouterToolCall(
        "tool_search",
        { query: "recipe", limit: 2 },
        "trace_recipe_search",
      );
    return openRouterText(
      JSON.stringify({
        kind: "reply",
        text: "I checked the available recipe tools.",
      }),
      "trace_recipe_reply",
    );
  }
}

async function chatExecutionJourney({ task }: TestContext): Promise<void> {
  const fixture = await installMemoryFixture();
  const model = new ExecutionModel();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
  );
  const conversationId = newConversationId();
  await createConversation(fixture.author, conversationId, fixture.route);
  await instruct(fixture.author, conversationId, "trace_recipe_request");
  const base = `${fixture.paths.chat}/${conversationId}/execution`;
  const nodes: CaseExecutionNode[] = [];
  let cursor: string | null = null;
  let caseId: string | null = null;
  let pages = 0;
  do {
    const read = await postJson(
      fixture.author,
      `${base}?limit=2${cursor === null ? "" : `&after=${encodeURIComponent(cursor)}`}`,
      null,
    );
    expect(read.status).toBe(200);
    const page = isRecord(read.body)
      ? parseCaseExecutionPage(read.body.page)
      : null;
    if (page === null) throw new Error("Invalid chat execution page");
    caseId = page.caseId;
    nodes.push(...page.nodes);
    cursor = page.nextCursor;
    pages += 1;
    if (pages > 30) throw new Error("Chat execution did not finish pagination");
  } while (cursor !== null);
  const tool = nodes.find(isSearchOperation);
  if (
    tool === undefined ||
    tool.access !== "open" ||
    tool.kind !== "tool_operation" ||
    caseId === null
  )
    throw new Error("The accepted tool call is absent from chat activity");
  expect(tool.state).toBe("succeeded");
  const detailPath = `${fixture.paths.organisation}/cases/${caseId}/execution/nodes/${tool.nodeId}`;
  const content = await postJson(fixture.author, detailPath, null);
  expect(content.status).toBe(200);
  const detail = isRecord(content.body)
    ? parseCaseExecutionNodeDetail(content.body.detail)
    : null;
  if (detail === null) throw new Error("Invalid tool detail");
  expect(detail.content.some(hasRecipeArguments)).toBe(true);
  expect(detail.content.some(hasToolResult)).toBe(true);
  const sessionId = parseSessionId(tool.sessionId);
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  const actor = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: fixture.organisationId,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  await evictDurableObject(actor.value);
  const restored = await postJson(fixture.author, detailPath, null);
  expect(restored.status).toBe(200);
  expect(restored.body).toEqual(content.body);
  const deniedPage = await postJson(fixture.reviewer, base, null);
  const deniedDetail = await postJson(fixture.reviewer, detailPath, null);
  expect(deniedPage.status).toBe(404);
  expect(deniedDetail.status).toBe(404);
  expect(JSON.stringify(deniedDetail.body)).not.toContain("recipe");
  Object.assign(task.meta, {
    chatExecution: {
      pages,
      caseId,
      tool: tool.tool,
      content: detail.content,
      restored: restored.status,
      deniedPage: deniedPage.status,
      deniedDetail: deniedDetail.status,
    },
  });
}

function isSearchOperation(node: CaseExecutionNode): boolean {
  return (
    node.access === "open" &&
    node.kind === "tool_operation" &&
    node.tool === "tool_search"
  );
}
function hasRecipeArguments(content: {
  readonly role: string;
  readonly text: string;
}): boolean {
  return content.role === "arguments" && content.text.includes("recipe");
}
function hasToolResult(content: {
  readonly role: string;
  readonly text: string;
}): boolean {
  return content.role === "result" && content.text.length > 0;
}
