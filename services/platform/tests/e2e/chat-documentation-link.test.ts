import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { newConversationId, type ConversationId } from "@seams/control-api";
import { isRecord } from "@seams/std";
import { resolveActiveCaseActor } from "../../src/actors/actor-router";
import {
  conversationCaseId,
  initialConversationCaseIdentity,
} from "../../src/chat/conversation-actor-identity";
import {
  createConversation,
  installMemoryFixture,
  post,
  storedConversation,
  workKind,
  type Member,
} from "./memory-support";
import { network } from "./network";
import { openRouterText } from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatDocumentationLink?: Record<string, unknown>;
  }
}

/**
 * A Portal chat reads documentation only from a link that a person wrote.
 *
 * A person asks the chat to set up a carrier API and pastes the link of its
 * reference. The model first names another URL, whose path carries text from
 * the chat to a host that nobody named. Pantry fetches nothing for it and tells
 * the next model step which links it may read. The model then reads the
 * person's link and answers from the page.
 */
it(
  "reads documentation only from a link that a person wrote in the Portal chat",
  { timeout: 180_000 },
  documentationLinkJourney,
);

const DOCUMENTATION = "https://docs.carrier.example.net/reference";
const COMPOSED = "https://collector.example.org/carrier/bearer-token-from-chat";
const PAGE_TEXT = "Carrier API: send the key as a bearer token.";
const ANSWER = "The carrier API takes a bearer token.";
const REFUSAL = "Read documentation only from a link that a person wrote";

/** Stands in for the link-fetch Actor and records each link it reads. */
class RecordingLinkFetch {
  readonly fetched: string[] = [];

  getByName(): this {
    return this;
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const raw: unknown = await new Request(input, init).json();
    if (!isRecord(raw) || typeof raw.url !== "string")
      throw new Error("The fetch request has no link");
    this.fetched.push(raw.url);
    return HttpResponse.json({
      status: 200,
      contentType: "text/plain",
      location: null,
      bodyBase64: btoa(PAGE_TEXT),
    });
  }
}

/**
 * Names a composed URL first. After a refusal it reads the person's link, and
 * after the page it answers. Each call is one model step.
 */
class ComposingModel {
  readonly calls: { refusalSeen: boolean; pageSeen: boolean }[] = [];
  conversationId: ConversationId | null = null;

  constructor(
    private readonly person: Member,
    private readonly linkFetch: RecordingLinkFetch,
  ) {}

  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const conversationId = this.conversationId;
    if (conversationId === null) throw new Error("No conversation is active");
    const sent = await request.clone().text();
    // The Case Actor of the conversation reads the documentation.
    await runInDurableObject(
      await conversationCase(this.person, conversationId),
      bindLinkFetch.bind(null, this.linkFetch),
    );
    const call = {
      refusalSeen: sent.includes(REFUSAL) && sent.includes(DOCUMENTATION),
      pageSeen: sent.includes(PAGE_TEXT),
    };
    this.calls.push(call);
    const id = `chat_documentation_link_${String(this.calls.length)}`;
    if (call.pageSeen)
      return openRouterText(
        JSON.stringify({ kind: "reply", text: ANSWER }),
        id,
      );
    return openRouterText(
      JSON.stringify({
        kind: "read_documentation",
        url: call.refusalSeen ? DOCUMENTATION : COMPOSED,
      }),
      id,
    );
  }
}

async function documentationLinkJourney({ task }: TestContext): Promise<void> {
  const { author, route, paths } = await installMemoryFixture();
  const linkFetch = new RecordingLinkFetch();
  const model = new ComposingModel(author, linkFetch);
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
    http.get("https://cloudflare-dns.com/dns-query", resolvePublicAddress),
  );

  const conversationId = newConversationId();
  model.conversationId = conversationId;
  await createConversation(author, conversationId, route);
  const started = await post(author, paths.chat, {
    kind: "message",
    conversationId,
    requestId: "request_chat_documentation_link",
    model: route.model,
    text: `Set up the carrier API. Its reference is ${DOCUMENTATION}.`,
    surfaceContext: null,
    browserContext: { kind: "unavailable" },
  });
  expect(started.status, await started.clone().text()).toBe(200);
  try {
    await expect
      .poll(workKind.bind(null, author, conversationId), { timeout: 40_000 })
      .toBe("ready");
  } catch {
    const stored = await storedConversation(author, conversationId);
    throw new Error(
      JSON.stringify({
        work: stored?.conversation.work,
        lastEvents: stored?.conversation.timeline.slice(-3),
        calls: model.calls,
        fetched: linkFetch.fetched,
      }),
    );
  }

  // The composed URL was never fetched; the person's link was, one time.
  expect(linkFetch.fetched).toEqual([DOCUMENTATION]);
  // The refusal reached the next step, which read the person's link.
  expect(model.calls).toEqual([
    { refusalSeen: false, pageSeen: false },
    { refusalSeen: true, pageSeen: false },
    { refusalSeen: true, pageSeen: true },
  ]);
  const stored = await storedConversation(author, conversationId);
  const timeline = stored?.conversation.timeline ?? [];
  expect(JSON.stringify(timeline)).toContain(ANSWER);
  expect(JSON.stringify(timeline)).not.toContain(`Read ${COMPOSED}`);

  task.meta.chatDocumentationLink = {
    personLink: DOCUMENTATION,
    composedLink: COMPOSED,
    linksRead: linkFetch.fetched,
    modelCalls: model.calls,
    events: timeline.map((event) => ({
      kind: event.kind,
      id: event.eventId,
    })),
  };
}

function resolvePublicAddress({
  request,
}: Parameters<HttpResponseResolver>[0]): Response {
  return HttpResponse.json({
    Status: 0,
    Answer:
      new URL(request.url).searchParams.get("type") === "A"
        ? [{ type: 1, data: "93.184.216.34" }]
        : [],
  });
}

async function conversationCase(
  person: Member,
  conversationId: ConversationId,
) {
  const caseId = await conversationCaseId(
    initialConversationCaseIdentity(
      { organisationId: person.organisationId, userId: person.userId },
      conversationId,
    ),
  );
  const actor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: person.organisationId,
    caseId,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  return actor.value;
}

function bindLinkFetch(linkFetch: object, actor: object): void {
  const bindings = Reflect.get(actor, "env");
  if (!isRecord(bindings)) throw new Error("The Actor has no environment");
  Object.defineProperty(bindings, "MESSAGE_LINK_FETCH", {
    configurable: true,
    value: linkFetch,
  });
}
