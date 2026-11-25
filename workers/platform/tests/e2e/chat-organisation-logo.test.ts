// The Portal chat agent sets and removes the organisation's logo from an
// image that the owner attaches, through the owner's own check (Portal round
// 9). An admin who asks the agent is refused, as the Logos dialog refuses an
// admin. Only the model answers from a script.
import { exports } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  type ConversationId,
} from "@purin-labs/control-api";
import { isRecord, sha256Hex } from "@purin-labs/std";

import {
  lastCalledTool,
  pausedRequest,
  resumeChat,
} from "./chat-permission-support";
import { finished, messageWord } from "./chat-journey-support";
import { commerceHeaders } from "./commerce-support";
import {
  createConversation,
  installMemoryFixture,
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

declare module "vitest" {
  interface TaskMeta {
    chatOrganisationLogo?: Record<string, unknown>;
  }
}

const TOOL = "organisation_logo_change";

type Journey = {
  readonly outputs: Record<string, string[]>;
};

it(
  "sets and removes the logo from the owner's chat image, and refuses an admin",
  { timeout: 300_000 },
  async (context: TestContext): Promise<void> => {
    const fixture = await installMemoryFixture();
    const { author: owner, reviewer: admin, organisationId } = fixture;
    const journey: Journey = { outputs: {} };
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        replyToModel.bind(null, journey),
      ),
    );
    const image = png(7);
    const digest = await sha256Hex(image);

    // 1. The owner attaches an image and asks. The tool is not in the
    //    agent's catalogue: a prompt asks first, and after the allow the
    //    logo is the attached image.
    await chatThrough(fixture, owner, "SETLOGO", image);
    expect(lastOutput(journey, "SETLOGO")).toContain("The logo is set");
    expect(await organisationLogo(owner, organisationId)).toBe(digest);
    const served = await exports.default.fetch(
      `https://localhost/v1/control/organisations/${organisationId}/logo?v=${digest}`,
      { headers: commerceHeaders(admin.session) },
    );
    expect(served.status).toBe(200);
    expect(await sha256Hex(new Uint8Array(await served.arrayBuffer()))).toBe(
      digest,
    );

    // 2. Refused: an admin asks the agent with another image. The tool runs
    //    through the admin's own check, and the logo stays.
    await chatThrough(fixture, admin, "ADMINLOGO", png(8));
    expect(lastOutput(journey, "ADMINLOGO")).toContain(
      "Only the owner changes a logo",
    );
    expect(await organisationLogo(owner, organisationId)).toBe(digest);

    // 3. The owner asks to remove it: no new prompt, and the gradient tile
    //    comes back.
    const removal = await startChat(fixture, owner, "REMOVELOGO", null);
    await finished(owner, removal);
    expect(lastOutput(journey, "REMOVELOGO")).toContain("The logo is gone");
    expect(await organisationLogo(owner, organisationId)).toBeNull();

    context.task.meta.chatOrganisationLogo = {
      ownerSet: lastOutput(journey, "SETLOGO"),
      logoAfterSet: digest,
      adminRefusal: lastOutput(journey, "ADMINLOGO"),
      ownerRemove: lastOutput(journey, "REMOVELOGO"),
      logoAfterRemove: null,
    };
  },
);

/** A small, valid PNG whose last byte after IEND is `seed`. */
function png(seed: number): Uint8Array {
  const bytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    ),
    (character) => character.charCodeAt(0),
  );
  return Uint8Array.from([...bytes, seed]);
}

/** Starts a chat with one message, with the image attached when given. */
async function startChat(
  fixture: MemoryFixture,
  person: Member,
  word: string,
  image: Uint8Array | null,
): Promise<ConversationId> {
  const conversationId = newConversationId();
  await createConversation(person, conversationId, fixture.route);
  const command = {
    kind: "message",
    conversationId,
    requestId: `request_${conversationId}_${word}`,
    model: fixture.route.model,
    text: `${word} now.`,
    browserContext: { kind: "unavailable" },
  };
  const headers = commerceHeaders(person.session);
  let body: BodyInit = JSON.stringify(command);
  if (image !== null) {
    const form = new FormData();
    form.set("command", JSON.stringify(command));
    form.append("files", new File([image], "logo.png", { type: "image/png" }));
    headers.delete("content-type");
    body = form;
  }
  const started = await exports.default.fetch(
    `https://localhost${fixture.paths.chat}`,
    { method: "POST", headers, body },
  );
  expect(started.status, await started.clone().text()).toBe(200);
  return conversationId;
}

async function chatThrough(
  fixture: MemoryFixture,
  person: Member,
  word: string,
  image: Uint8Array,
): Promise<void> {
  const conversationId = await startChat(fixture, person, word, image);
  const pause = await pausedRequest(person, fixture.paths.chat, conversationId);
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
  await finished(person, conversationId);
}

/** The organisation's logo digest in the person's session. */
async function organisationLogo(
  person: Member,
  organisationId: string,
): Promise<string | null> {
  const response = await exports.default.fetch(
    "https://localhost/v1/control/session",
    { headers: commerceHeaders(person.session) },
  );
  const body: unknown = await response.json();
  const memberships =
    isRecord(body) && Array.isArray(body.memberships) ? body.memberships : [];
  const membership = memberships.find(
    (item): item is Record<string, unknown> =>
      isRecord(item) && item.organisationId === organisationId,
  );
  if (membership === undefined) throw new Error("No membership");
  return typeof membership.organisationLogo === "string"
    ? membership.organisationLogo
    : null;
}

function lastOutput(journey: Journey, word: string): string {
  const output = journey.outputs[word]?.at(-1);
  if (output === undefined) throw new Error(`No output for ${word}`);
  return output;
}

let replies = 0;

async function replyToModel(
  journey: Journey,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  replies += 1;
  const id = `logo_${String(replies)}`;
  const reply = (text: string): Response =>
    openRouterText(JSON.stringify({ kind: "reply", text }), id);
  const word = messageWord(body, ["SETLOGO", "ADMINLOGO", "REMOVELOGO"]);
  const callTool = (): Response =>
    openRouterToolCall(
      TOOL,
      {
        subject: "organisation",
        workspaceId: null,
        logo: word === "REMOVELOGO" ? "remove" : "attached_image",
      },
      `call_${id}`,
    );
  const called = lastCalledTool(body);
  if (called === null)
    return offeredToolNames(body).includes(TOOL)
      ? callTool()
      : openRouterToolCall(
          "tool_search",
          { query: TOOL, limit: 1 },
          `call_${id}`,
        );
  const output = requireLastToolOutput(body);
  switch (called) {
    case "tool_search":
      if (offeredToolNames(body).includes(TOOL)) return callTool();
      return openRouterToolCall(
        "request_permission",
        { capabilityIds: ["organisation.logo.change"], entityTypeReads: [] },
        `call_${id}`,
      );
    case "request_permission":
      expect(output).toContain("Allow prompt");
      return reply("I asked for permission.");
    case TOOL:
      if (output.includes("Allow prompt"))
        return reply("I asked for permission.");
      journey.outputs[word] = [...(journey.outputs[word] ?? []), output];
      return reply(`Finished ${word}.`);
    default:
      throw new Error(`Unexpected tool ${called} for ${word}`);
  }
}
