// A Portal chat journey with a model that answers from a script. The fake
// model only chooses the tool call of the scripted word; it never writes a
// tool's value. Product code selects the tools, asks for the permission, runs
// the tool and admits its value.
import { http, type HttpResponseResolver } from "msw";
import { expect } from "vitest";
import {
  newConversationId,
  type ConversationId,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import {
  ask,
  lastCalledTool,
  pausedRequest,
  resumeChat,
} from "./chat-permission-support";
import {
  createConversation,
  workKind,
  type Member,
  type MemoryFixture,
} from "./memory-support";
import { network } from "./network";
import { allowAsPortal } from "./permission-request-support";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
} from "./slack-journey-support";

/** The tool call of one scripted word, and the capabilities that it asks for. */
type ScriptedTool = Readonly<{
  tool: string;
  args: Record<string, unknown>;
  ask: readonly string[];
}>;

/** A message that holds the word makes the model call the word's tool. */
export type ScriptedTools = Readonly<Record<string, ScriptedTool>>;

export type ScriptedJourney = {
  readonly scripts: ScriptedTools;
  /** The values that each word's tool gave to the model. */
  readonly outputs: Record<string, string[]>;
  /** Each tool name that a turn offered to the model. */
  readonly offered: Set<string>;
};

export function installScriptedModel(scripts: ScriptedTools): ScriptedJourney {
  const journey: ScriptedJourney = { scripts, outputs: {}, offered: new Set() };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, journey),
    ),
  );
  return journey;
}

export function lastScriptedOutput(
  journey: ScriptedJourney,
  word: string,
): string {
  const output = journey.outputs[word]?.at(-1);
  if (output === undefined) throw new Error(`No output for ${word}`);
  return output;
}

/**
 * One chat message. A turn that pauses on a permission request is allowed by
 * the person in place, and the same step runs again.
 */
export async function scriptedChat(
  fixture: MemoryFixture,
  person: Member,
  word: string,
): Promise<ConversationId> {
  const conversationId = newConversationId();
  await createConversation(person, conversationId, fixture.route);
  await ask(
    person,
    fixture.paths.chat,
    conversationId,
    fixture.route.model,
    `${word} now.`,
    word,
  );
  await expect
    .poll(workKind.bind(null, person, conversationId), { timeout: 60_000 })
    .toMatch(/^(ready|awaiting_permission)$/u);
  if ((await workKind(person, conversationId)) === "awaiting_permission") {
    const pause = await pausedRequest(
      person,
      fixture.paths.chat,
      conversationId,
    );
    const allowed = await allowAsPortal(
      person.organisationId,
      person.session,
      pause.id,
    );
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    const resumed = await resumeChat(
      person,
      fixture.paths.chat,
      conversationId,
      pause.id,
    );
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    await expect
      .poll(workKind.bind(null, person, conversationId), { timeout: 60_000 })
      .toBe("ready");
  }
  return conversationId;
}

function messageWord(
  scripts: ScriptedTools,
  body: Record<string, unknown>,
): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const text = JSON.stringify(message.content);
    const word = Object.keys(scripts).find((candidate) =>
      text.includes(candidate),
    );
    if (word !== undefined) return word;
  }
  throw new Error("The model request has no scripted message");
}

let replies = 0;

/** The fake model chooses the tool call; it never writes a tool's value. */
async function replyToModel(
  journey: ScriptedJourney,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  replies += 1;
  const id = `scripted_${String(replies)}`;
  const reply = (text: string): Response =>
    openRouterText(JSON.stringify({ kind: "reply", text }), id);
  for (const name of offeredToolNames(body)) journey.offered.add(name);
  const word = messageWord(journey.scripts, body);
  const script = journey.scripts[word];
  if (script === undefined) throw new Error(`No script for ${word}`);
  const called = lastCalledTool(body);
  const callTool = (): Response =>
    openRouterToolCall(script.tool, script.args, `call_${id}`);
  if (called === null)
    return offeredToolNames(body).includes(script.tool)
      ? callTool()
      : openRouterToolCall(
          "tool_search",
          { query: script.tool, limit: 1 },
          `call_${id}`,
        );
  const output = requireLastToolOutput(body);
  const finish = (): Response => {
    journey.outputs[word] = [...(journey.outputs[word] ?? []), output];
    return reply(`Finished ${word}.`);
  };
  switch (called) {
    case "tool_search":
      // A script whose tool is the search itself reads what the search found.
      if (script.tool === "tool_search") return finish();
      if (offeredToolNames(body).includes(script.tool)) return callTool();
      return openRouterToolCall(
        "request_permission",
        { capabilityIds: script.ask, entityTypeReads: [] },
        `call_${id}`,
      );
    case "request_permission":
      expect(output).toContain("Allow prompt");
      return reply("I asked for permission.");
    case script.tool:
      if (output.includes("Allow prompt"))
        return reply("I asked for permission.");
      return finish();
    default:
      throw new Error(`Unexpected tool ${called} for ${word}`);
  }
}
