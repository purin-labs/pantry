// Plan 88 phase 3, journey J5: the Portal chat agent reads the Jev settings
// and turns a switch off through an approval card, through the person's own
// prompts, role check and receipts. The model answers from a script and only
// chooses the tool call; product code reads the settings, stages the card,
// refuses the lower role and writes the switch.
import { exports } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it } from "vitest";
import {
  parseJevFeaturesView,
  type JevFeaturesView,
} from "@seams/control-api/portal/jev-features";
import { newConversationId, type ConversationId } from "@seams/control-api";
import { isRecord } from "@seams/std";

import {
  ask,
  lastCalledTool,
  pausedRequest,
  resumeChat,
} from "./chat-permission-support";
import { commerceHeaders } from "./commerce-support";
import { PUBLIC_ORIGIN } from "./hibernatable-socket-support";
import {
  createConversation,
  installMemoryFixture,
  postJson,
  workKind,
  type Member,
  type MemoryFixture,
} from "./memory-support";
import { network } from "./network";
import { allowAsPortal } from "./permission-request-support";
import { nativeServiceMemberMutation } from "./shared-account-platform-fixture";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
} from "./slack-journey-support";
import { draftAction, onlyDraft } from "./chat-journey-support";

type Script = Readonly<{
  tool: string;
  args: Record<string, unknown>;
  ask: readonly string[];
}>;

const SCRIPTS: Readonly<Record<string, Script>> = {
  READJEV: {
    tool: "jev_features_read",
    args: {},
    ask: ["jev.features.read"],
  },
  SCREENOFF: {
    tool: "jev_features_manage",
    args: { feature: "screen_relevance", enabled: false, mode: null },
    ask: ["jev.features.manage"],
  },
  SCREENON: {
    tool: "jev_features_manage",
    args: { feature: "screen_relevance", enabled: true, mode: null },
    ask: ["jev.features.manage"],
  },
};

type Journey = {
  readonly outputs: Record<string, string[]>;
  readonly offered: Set<string>;
};

it(
  "J5: the agent reads the Jev settings, turns screen relevance off after the admin approves the card, and a member who is not an admin changes nothing",
  { timeout: 300_000 },
  async (): Promise<void> => {
    const fixture = await installMemoryFixture();
    const { author, reviewer, organisationId } = fixture;
    const journey: Journey = { outputs: {}, offered: new Set() };
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        replyToModel.bind(null, journey),
      ),
    );

    // The owner turns screen relevance on, on Settings › Jev.
    const on = await change(fixture, author, {
      feature: "screen_relevance",
      enabled: true,
    });
    expect(on.screenRelevance.enabled).toBe(true);

    // 1. The read asks first. After the allow, the agent gets the same view
    //    that the page shows.
    await chat(fixture, author, "READJEV");
    const read = toolValue(lastOutput(journey, "READJEV"));
    expect(read).toEqual(await features(fixture, author));
    expect(read).toMatchObject({
      funding: "satyr_platform",
      keyAvailable: true,
      screenRelevance: { enabled: true },
    });

    // 2. A change is a card. Nothing changes until the admin approves it.
    const off = await chat(fixture, author, "SCREENOFF");
    expect(lastOutput(journey, "SCREENOFF")).toContain("configuration_drafted");
    expect((await features(fixture, author)).screenRelevance.enabled).toBe(
      true,
    );
    const offCard = await onlyDraft(fixture, author, off);
    expect(offCard).toMatchObject({
      summary: "Turn off Screen relevance in Settings › Jev.",
      actionLabel: "Turn off Screen relevance",
      state: "pending",
    });
    const approved = await draftAction(
      fixture,
      author,
      off,
      offCard,
      "confirm",
    );
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(await approved.json()).toMatchObject({
      draft: { state: "settled", receiptCode: "accepted" },
    });
    expect((await features(fixture, author)).screenRelevance.enabled).toBe(
      false,
    );

    // 3. A second admin asks to turn it on again, and then loses the admin
    //    role. The card refuses that person, and the switch stays off.
    const onAgain = await chat(fixture, reviewer, "SCREENON");
    const onCard = await onlyDraft(fixture, reviewer, onAgain);
    expect(onCard.summary).toBe("Turn on Screen relevance in Settings › Jev.");
    const demoted = await nativeServiceMemberMutation(
      organisationId,
      author,
      reviewer,
      "PATCH",
      { role: "operator" },
    );
    expect(demoted.status, await demoted.clone().text()).toBe(200);
    const refused = await draftAction(
      fixture,
      reviewer,
      onAgain,
      onCard,
      "confirm",
    );
    expect(refused.status, await refused.clone().text()).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: "organisation_role_insufficient",
    });
    // The page refuses the same change from that person, as every admin route.
    const direct = await controlFetch(fixture, reviewer, "jev-features", {
      feature: "screen_relevance",
      enabled: true,
    });
    expect(direct.status).toBe(404);
    expect((await features(fixture, author)).screenRelevance.enabled).toBe(
      false,
    );
    // A Portal chat is for an owner or an admin, so that person can no longer
    // open the chat and its card.
    const chatRead = await postJson(
      reviewer,
      `${fixture.paths.chat}?${new URLSearchParams({ conversation: onAgain })}`,
      null,
    );
    expect(chatRead.body).toMatchObject({
      error: "organisation_role_insufficient",
    });

    // No tool lets the agent change a switch without a card.
    for (const name of journey.offered)
      expect(name).not.toMatch(/^jev_features_(set|write|enable|disable)/u);
  },
);

/** The tool's value, which the model receives as JSON inside JSON. */
function toolValue(raw: string): JevFeaturesView {
  const message = JSON.parse(JSON.parse(raw) as string) as { output: string };
  return parseJevFeaturesView(JSON.parse(message.output));
}

function lastOutput(journey: Journey, word: string): string {
  const output = journey.outputs[word]?.at(-1);
  if (output === undefined) throw new Error(`No output for ${word}`);
  return output;
}

/**
 * One chat message. A turn that pauses on a permission request is allowed by
 * the person in place, and the same step runs again.
 */
async function chat(
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

async function features(
  fixture: MemoryFixture,
  person: Member,
): Promise<JevFeaturesView> {
  const response = await controlFetch(fixture, person, "jev-features", null);
  const raw: unknown = await response.json();
  expect(response.status, JSON.stringify(raw)).toBe(200);
  if (!isRecord(raw)) throw new Error("Invalid Jev settings answer");
  return parseJevFeaturesView(raw.value);
}

async function change(
  fixture: MemoryFixture,
  person: Member,
  body: unknown,
): Promise<JevFeaturesView> {
  const response = await controlFetch(fixture, person, "jev-features", body);
  const raw: unknown = await response.json();
  expect(response.status, JSON.stringify(raw)).toBe(200);
  if (!isRecord(raw)) throw new Error("Invalid Jev settings answer");
  return parseJevFeaturesView(raw.value);
}

function controlFetch(
  fixture: MemoryFixture,
  person: Member,
  path: string,
  body: unknown,
): Promise<Response> {
  const headers = commerceHeaders(person.session);
  headers.set("idempotency-key", crypto.randomUUID());
  return exports.default.fetch(
    `${PUBLIC_ORIGIN}${fixture.paths.organisation}/${path}`,
    {
      method: body === null ? "GET" : "POST",
      headers,
      body: body === null ? null : JSON.stringify(body),
    },
  );
}

function messageWord(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const text = JSON.stringify(message.content);
    const word = Object.keys(SCRIPTS).find((candidate) =>
      text.includes(candidate),
    );
    if (word !== undefined) return word;
  }
  throw new Error("The model request has no scripted message");
}

let replies = 0;

/** The fake model chooses the tool call; it never writes a tool's value. */
async function replyToModel(
  journey: Journey,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  replies += 1;
  const id = `jev_${String(replies)}`;
  const reply = (text: string): Response =>
    openRouterText(JSON.stringify({ kind: "reply", text }), id);
  for (const name of offeredToolNames(body)) journey.offered.add(name);
  const word = messageWord(body);
  const script = SCRIPTS[word];
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
  switch (called) {
    case "tool_search":
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
      journey.outputs[word] = [...(journey.outputs[word] ?? []), output];
      return reply(`Finished ${word}.`);
    default:
      throw new Error(`Unexpected tool ${called} for ${word}`);
  }
}
