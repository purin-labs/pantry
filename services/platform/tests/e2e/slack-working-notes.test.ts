import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";

import { network } from "./network";
import {
  ANSWER,
  askInSlack,
  caseSnapshot,
} from "./slack-streamed-answer-support";
import {
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  slackSimulator,
} from "./slack-journey-support";
import { PLATFORM_DEFAULT_PI_MODEL } from "../../src/actors/pi-model-transport";

declare module "vitest" {
  interface TaskMeta {
    slackWorkingNotes?: Record<string, unknown>;
  }
}

/**
 * What a Slack thread shows of a turn that uses tools.
 *
 * The agent writes a short note before each tool call, as a model does: "Now
 * propose directly", "Retrying once". The person reads none of them, whether
 * the answer is one short post or a long stream. A model's long text before a
 * tool call is its reply so far, and it stays, because an appended text cannot
 * be taken back.
 */
it(
  "leaves the agent's short notes before tool calls out of a short answer",
  { timeout: 120_000 },
  async function shortAnswer({ task }: TestContext): Promise<void> {
    const shown = await runTurn(
      "EvNotesShort",
      "The cookie box costs 2600 JPY.",
    );
    expect(shown).toEqual(["The cookie box costs 2600 JPY."]);
    task.meta.slackWorkingNotes = { shortAnswer: shown };
  },
);

it(
  "leaves the agent's short notes before tool calls out of a streamed answer",
  { timeout: 120_000 },
  async function longAnswer({ task }: TestContext): Promise<void> {
    const shown = await runTurn("EvNotesLong", ANSWER);
    expect(shown).toEqual([ANSWER]);
    task.meta.slackWorkingNotes = { longAnswerChars: shown[0]?.length };
  },
);

it(
  "keeps a long reply that the agent wrote before a tool call",
  { timeout: 120_000 },
  async function longReply({ task }: TestContext): Promise<void> {
    const reply = `${ANSWER.slice(0, 260)}.`;
    const shown = await runTurn(
      "EvNotesReply",
      "That is the whole plan.",
      reply,
    );
    expect(shown).toEqual([`${reply}\n\nThat is the whole plan.`]);
    task.meta.slackWorkingNotes = { longReply: shown };
  },
);

const FIRST_NOTE = "Now propose directly.";
const SECOND_NOTE = "Retrying once, as the error message said.";

/** Runs one turn with two tool calls, and returns the thread's messages. */
async function runTurn(
  eventId: string,
  answer: string,
  firstText: string = FIRST_NOTE,
): Promise<readonly string[]> {
  const fixture = await installSlackActorFixture();
  const slack = slackSimulator();
  let calls = 0;
  const respond: HttpResponseResolver = function respond(): Response {
    calls += 1;
    switch (calls) {
      case 1:
        return toolCallAfterText(firstText, `${eventId}_one`);
      case 2:
        return toolCallAfterText(SECOND_NOTE, `${eventId}_two`);
      case 3:
        return openRouterText(answer, `${eventId}_answer`);
      default:
        throw new Error("Unexpected model request");
    }
  };
  network.use(
    slack.handler,
    http.post("https://openrouter.ai/api/v1/chat/completions", respond),
  );
  await askInSlack(eventId);
  await expect
    .poll(
      async () => {
        const snapshot = await caseSnapshot(fixture.connectorId);
        return snapshot.outputs.at(-1)?.kind === "settled";
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  return slack.messages.map((message) => message.text ?? "");
}

/** One model response: text, and then a tool call. */
function toolCallAfterText(text: string, callId: string): Response {
  const toolCall = openRouterToolCall(
    "tool_search",
    { query: "commerce_entity_context", limit: 1 },
    callId,
  );
  return prependTextChunk(toolCall, text, callId);
}

function prependTextChunk(
  response: Response,
  text: string,
  callId: string,
): Response {
  const encoder = new TextEncoder();
  const chunk = {
    id: `chatcmpl_${callId}`,
    object: "chat.completion.chunk",
    created: 1_787_500_000,
    model: PLATFORM_DEFAULT_PI_MODEL,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: text },
        finish_reason: null,
      },
    ],
  };
  const body = response.body;
  if (body === null) throw new Error("Model response has no body");
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
  });
  return new Response(stream, {
    status: response.status,
    headers: response.headers,
  });
}
