// The owner pastes the link of a supplier's page into a Portal chat and asks
// the agent what it says. The agent reads the page through the link read, as
// in a Slack channel: the link is a part of the owner's own message, and the
// Organisation's baseline gives the owner the read. The agent then tries a
// link that the owner did not write. The link read refuses it, and the fake
// page gets no request for it.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  type ConversationId,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import { answers, ask } from "./chat-permission-support";
import { registeredActors } from "./held-exit-support";
import {
  bindLinkFetch,
  PublicPage,
  resolvePublicAddress,
} from "./link-fetch-support";
import {
  createConversation,
  installMemoryFixture,
  workKind,
  type Member,
} from "./memory-support";
import { network } from "./network";
import { openRouterText, openRouterToolCall } from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatAgentMessageLink?: Record<string, unknown>;
  }
}

const LINK = "https://supplier.example.net/notes/flour?week=48";
const OTHER = "https://supplier.example.net/notes/butter";
const PAGE_TEXT = "Flour deliveries move to Thursday mornings from week 48.";
const OPENED = "Send me the page.";
const ANSWER = "The supplier moves flour deliveries to Thursday mornings.";

type Step = (body: Record<string, unknown>) => Response | Promise<Response>;

it(
  "reads a link that the person pasted into a Portal chat, and refuses a link that the person did not write",
  { timeout: 240_000 },
  async ({ task }: TestContext): Promise<void> => {
    const { author, route, paths } = await installMemoryFixture();
    const page = new PublicPage(PAGE_TEXT);
    const steps: Step[] = [];
    const outputs: string[] = [];
    network.use(
      http.get("https://cloudflare-dns.com/dns-query", resolvePublicAddress),
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        nextStep.bind(null, steps),
      ),
    );
    const read =
      (url: string, id: string): Step =>
      (body) => {
        outputs.push(lastToolText(body));
        return openRouterToolCall("read_message_link", { url }, id);
      };
    const chat = newConversationId();
    await createConversation(author, chat, route);
    const send = async (text: string, label: string): Promise<void> => {
      await ask(author, paths.chat, chat, route.model, text, label);
      await settled(author, chat, steps);
    };

    // 1. The owner opens the chat. From now on its Session reads links
    //    through the fake page.
    steps.push(async () => {
      for (const name of await registeredActors(
        "session",
        author.organisationId,
      ))
        await runInDurableObject(
          env.SESSION.getByName(name),
          bindLinkFetch.bind(null, page),
        );
      return openRouterText(OPENED, "answer_open");
    });
    await send("I have a supplier page for you.", "open");

    // 2. The owner pastes the link. The agent reads it, and then tries a
    //    link that the owner did not write.
    steps.push(
      () =>
        openRouterToolCall(
          "tool_search",
          { query: "read_message_link", limit: 1 },
          "search_link",
        ),
      read(LINK, "read_pasted"),
      read(OTHER, "read_other"),
      (body) => {
        outputs.push(lastToolText(body));
        return openRouterText(ANSWER, "answer_link");
      },
    );
    await send(`What does the supplier say here? ${LINK}.`, "link");

    // The pasted link is read, and its page text reaches the agent.
    const [, pasted, other] = outputs;
    expect(pasted).toContain('\\"outcome\\":\\"read\\"');
    expect(pasted).toContain(PAGE_TEXT);
    // The link that the owner did not write is refused, and never fetched.
    expect(other).toContain("link_not_in_message");
    expect(other).not.toContain(PAGE_TEXT);
    expect(page.fetched).toEqual([LINK]);
    expect(await answers(author, chat)).toEqual([OPENED, ANSWER]);

    task.meta.chatAgentMessageLink = {
      fetched: page.fetched,
      pasted,
      other,
    };
  },
);

/** Each step of the model ran, and the chat is ready again. */
async function settled(
  person: Member,
  chat: ConversationId,
  steps: readonly Step[],
): Promise<void> {
  await expect.poll(() => steps.length, { timeout: 60_000 }).toBe(0);
  await expect
    .poll(workKind.bind(null, person, chat), { timeout: 60_000 })
    .toBe("ready");
}

async function nextStep(
  steps: Step[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  const step = steps.shift();
  if (step === undefined) throw new Error("Unexpected model request");
  return step(body);
}

/** The latest tool message that the model got, as JSON text. */
function lastToolText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const results = messages.filter(
    (message) => isRecord(message) && message.role === "tool",
  );
  return JSON.stringify(results.at(-1) ?? null);
}
