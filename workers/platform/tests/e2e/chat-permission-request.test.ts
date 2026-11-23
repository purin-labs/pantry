import { exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { newConversationId, type ConversationId } from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import { commerceHeaders } from "./commerce-support";
import {
  createConversation,
  installMemoryFixture,
  post,
  postJson,
  storedConversation,
  workKind,
  type Member,
} from "./memory-support";
import { network } from "./network";
import { openRouterText } from "./slack-journey-support";
import { bindLinkFetch, resolvePublicAddress } from "./link-fetch-support";
import { conversationCase } from "./chat-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatPermissionRequest?: Record<string, unknown>;
  }
}

const CAPABILITY = "message.link.read";
const DOCUMENTATION = "https://docs.carrier.example.net/reference";
const PAGE_TEXT = "Carrier API: send the key as a bearer token.";
const ANSWER = "The carrier API takes a bearer token.";

it(
  "pauses a Portal chat run on a disabled capability, stops it on a denial, and continues the same request after the capability is allowed",
  { timeout: 180_000 },
  permissionRequestJourney,
);

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
 * Asks for the documentation until its request holds the page, then answers.
 * Each call is one model step, so the count shows what a resume costs.
 */
class ReadingModel {
  readonly calls: { conversationId: ConversationId; sawPage: boolean }[] = [];
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
    const sawPage = sent.includes(PAGE_TEXT);
    this.calls.push({ conversationId, sawPage });
    const id = `chat_permission_${String(this.calls.length)}`;
    return sawPage
      ? openRouterText(JSON.stringify({ kind: "reply", text: ANSWER }), id)
      : openRouterText(
          JSON.stringify({ kind: "read_documentation", url: DOCUMENTATION }),
          id,
        );
  }

  callsFor(conversationId: ConversationId): number {
    return this.calls.filter((call) => call.conversationId === conversationId)
      .length;
  }
}

async function permissionRequestJourney({ task }: TestContext): Promise<void> {
  const { author, route, paths } = await installMemoryFixture();
  const linkFetch = new RecordingLinkFetch();
  const model = new ReadingModel(author, linkFetch);
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
    http.get("https://cloudflare-dns.com/dns-query", resolvePublicAddress),
  );
  await setCapabilityMode(author, "disabled");

  // A denial stops the run. The link is never read.
  const denied = newConversationId();
  model.conversationId = denied;
  const deniedRequest = await pausedRun(author, denied, route, paths.chat);
  const deniedAnswer = await decide(
    author,
    paths.chat,
    denied,
    deniedRequest,
    "deny",
  );
  expect(deniedAnswer.status, JSON.stringify(deniedAnswer.body)).toBe(200);
  const deniedStored = await storedConversation(author, denied);
  expect(deniedStored?.conversation.work.kind).toBe("ready");
  expect(deniedStored?.conversation.timeline.at(-1)).toMatchObject({
    kind: "run_cancelled",
    text: "Permission denied. The response stopped.",
  });
  // The same denial again returns the saved result.
  const deniedAgain = await decide(
    author,
    paths.chat,
    denied,
    deniedRequest,
    "deny",
  );
  expect(deniedAgain.status).toBe(200);
  expect(linkFetch.fetched).toEqual([]);
  expect(model.callsFor(denied)).toBe(1);

  // An allowed request continues the same request under the new policy.
  const allowed = newConversationId();
  model.conversationId = allowed;
  const allowedRequest = await pausedRun(author, allowed, route, paths.chat);

  // A new message waits for the answer to the request.
  const blocked = await postJson(author, paths.chat, {
    kind: "message",
    conversationId: allowed,
    requestId: "request_chat_permission_blocked",
    model: route.model,
    text: "Are you still there?",
    browserContext: { kind: "unavailable" },
  });
  expect(blocked.body).toMatchObject({ error: "chat_permission_pending" });

  // A resume before the capability is on costs no model step.
  const early = await decide(
    author,
    paths.chat,
    allowed,
    allowedRequest,
    "resume",
  );
  expect(early.status).toBe(409);
  expect(early.body).toMatchObject({ error: "chat_permission_missing" });
  expect(model.callsFor(allowed)).toBe(1);

  await setCapabilityMode(author, "enabled");
  const resumed = await decide(
    author,
    paths.chat,
    allowed,
    allowedRequest,
    "resume",
  );
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  try {
    await expect
      .poll(workKind.bind(null, author, allowed), { timeout: 40_000 })
      .toBe("ready");
  } catch {
    const stored = await storedConversation(author, allowed);
    throw new Error(
      JSON.stringify({
        work: stored?.conversation.work,
        lastEvents: stored?.conversation.timeline.slice(-3),
        calls: model.calls,
        fetched: linkFetch.fetched,
      }),
    );
  }
  const allowedStored = await storedConversation(author, allowed);
  const timeline = allowedStored?.conversation.timeline ?? [];
  expect(JSON.stringify(timeline)).toContain(ANSWER);
  expect(timeline.map((event) => event.requestId)).not.toContain(
    "request_chat_permission_blocked",
  );
  expect(linkFetch.fetched).toEqual([DOCUMENTATION]);
  // The denied step ran again, read the page, and the model then answered.
  expect(model.calls.filter((call) => call.conversationId === allowed)).toEqual(
    [
      { conversationId: allowed, sawPage: false },
      { conversationId: allowed, sawPage: false },
      { conversationId: allowed, sawPage: true },
    ],
  );

  task.meta.chatPermissionRequest = {
    capability: CAPABILITY,
    denied: {
      permissionRequestId: deniedRequest,
      modelCalls: model.callsFor(denied),
      finalEvent: deniedStored?.conversation.timeline.at(-1),
    },
    allowed: {
      permissionRequestId: allowedRequest,
      blockedMessage: blocked,
      earlyResume: early,
      modelCalls: model.calls.filter((call) => call.conversationId === allowed),
      linksRead: linkFetch.fetched,
      events: timeline.map((event) => ({
        kind: event.kind,
        id: event.eventId,
      })),
    },
  };
}

/**
 * Sends the message, waits for the pause, and checks the request in the
 * public state that the Portal reads. Returns the request ID.
 */
async function pausedRun(
  person: Member,
  conversationId: ConversationId,
  route: Awaited<ReturnType<typeof installMemoryFixture>>["route"],
  chatPath: string,
): Promise<string> {
  await createConversation(person, conversationId, route);
  const started = await post(person, chatPath, {
    kind: "message",
    conversationId,
    requestId: `request_${conversationId}`,
    model: route.model,
    text: `Set up the carrier API. Read its reference first: ${DOCUMENTATION}.`,
    browserContext: { kind: "unavailable" },
  });
  expect(started.status, await started.clone().text()).toBe(200);
  try {
    await expect
      .poll(workKind.bind(null, person, conversationId), { timeout: 40_000 })
      .toBe("awaiting_permission");
  } catch {
    const stored = await storedConversation(person, conversationId);
    throw new Error(
      JSON.stringify({
        work: stored?.conversation.work,
        lastEvent: stored?.conversation.timeline.at(-1),
      }),
    );
  }
  const query = new URLSearchParams({
    conversation: conversationId,
    view: "state",
  });
  const state = await postJson(person, `${chatPath}?${query}`, null);
  expect(state.status).toBe(200);
  const work = isRecord(state.body) ? state.body.work : null;
  expect(work).toMatchObject({
    kind: "awaiting_permission",
    requestId: `request_${conversationId}`,
    permission: {
      action: "Read a public link",
      object: DOCUMENTATION,
      items: [{ kind: "capability", capabilityId: CAPABILITY }],
    },
  });
  if (
    !isRecord(work) ||
    !isRecord(work.permission) ||
    typeof work.permission.permissionRequestId !== "string"
  )
    throw new Error("The paused run has no permission request");
  return work.permission.permissionRequestId;
}

function decide(
  person: Member,
  chatPath: string,
  conversationId: ConversationId,
  permissionRequestId: string,
  decision: "resume" | "deny",
): Promise<Readonly<{ status: number; body: unknown }>> {
  return postJson(
    person,
    `${chatPath}/conversations/${conversationId}/permission`,
    { permissionRequestId, decision },
  );
}

/** Changes the capability through the Access route, as the Portal does. */
async function setCapabilityMode(
  person: Member,
  mode: "enabled" | "disabled",
): Promise<void> {
  const base = `/v1/control/organisations/${person.organisationId}/access-control`;
  const read = await postJson(person, base, null);
  const view =
    isRecord(read.body) && isRecord(read.body.accessControl)
      ? read.body.accessControl
      : null;
  const capability = Array.isArray(view?.capabilities)
    ? view.capabilities.find(
        (candidate: unknown) =>
          isRecord(candidate) &&
          isRecord(candidate.definition) &&
          candidate.definition.capabilityId === CAPABILITY,
      )
    : undefined;
  if (
    view === null ||
    !isRecord(capability) ||
    !isRecord(capability.definition)
  )
    throw new Error(`The Access view has no ${CAPABILITY}`);
  const headers = commerceHeaders(person.session);
  headers.set("idempotency-key", `chat-permission-${mode}`);
  const changed = await exports.default.fetch(
    `https://localhost${base}/capabilities/${CAPABILITY}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedRevision: view.revision,
        capabilityRevision: capability.revision,
        capabilityVersion: capability.definition.capabilityVersion,
        mode,
      }),
    },
  );
  expect(changed.status, await changed.clone().text()).toBe(200);
}
