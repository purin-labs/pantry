import { fixtureDatabase } from "./organisation-database";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { newConversationId, type ConversationId } from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import {
  requireActiveOrganisationActor,
  resolveActiveSessionActor,
} from "../../src/actors/actor-router";
import {
  deriveDirectCaseIdentities,
  processDirectCaseCommand,
} from "../../src/actors/case-direct-processing";
import { createAccessGrant } from "../../src/data/access-grants";
import { writeOrganisationCapabilityPolicy } from "../../src/data/capability-policy";
import {
  readActiveOrganisationMembership,
  readActiveOrganisationMembershipRevision,
} from "@purin-labs/tenancy/data/control-plane";
import { parseRequestId } from "@purin-labs/kernel/ids";
import { deriveUserMessageViews } from "../../src/messages/message-wasm";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { buildControlAuthority } from "../../src/request-authority";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  createConversation,
  installMemoryFixture,
  post,
  storedConversation,
  workKind,
  type Member,
} from "./memory-support";
import { network } from "./network";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
} from "./slack-journey-support";
import { bindLinkFetch, resolvePublicAddress } from "./link-fetch-support";
import { conversationCase } from "./chat-journey-support";

declare module "vitest" {
  interface TaskMeta {
    messageLinkFetchPlacement?: Record<string, unknown>;
  }
}
const DOCUMENTATION = "https://docs.carrier.example.net/reference";
const DOCUMENTATION_PAGE = "https://docs.carrier.example.net/reference/v2";
const PAGE_TEXT = "Carrier API: send the key as a bearer token.";
const ANSWER = "The carrier API takes a bearer token.";
const LINK = "https://supplier.example.net/schedule";
const LINK_TEXT = "Supplier schedule: Friday delivery at 09:00.";
const LINK_STABLE_IDENTITY = "link-fetch-placement:message-with-link";

it(
  "reads a page for a Portal chat and a link of a message through the link-fetch Actor of the organisation's region",
  { timeout: 120_000 },
  linkFetchPlacementJourney,
);

type Addressed = Readonly<{ name: string; locationHint: string | null }>;

/**
 * Stands in for the class binding of one Actor. It records each address that
 * the Actor asks for and answers as the fetch service does: a redirect, then
 * the page.
 */
class RecordingLinkFetch {
  readonly addressed: Addressed[] = [];
  readonly fetched: string[] = [];

  getByName(name: string, options?: { readonly locationHint?: string }): this {
    this.addressed.push({ name, locationHint: options?.locationHint ?? null });
    return this;
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const raw: unknown = await new Request(input, init).json();
    if (!isRecord(raw) || typeof raw.url !== "string")
      throw new Error("The fetch request has no link");
    this.fetched.push(raw.url);
    if (raw.url === DOCUMENTATION)
      return HttpResponse.json({
        status: 302,
        contentType: null,
        location: DOCUMENTATION_PAGE,
        bodyBase64: "",
      });
    return HttpResponse.json({
      status: 200,
      contentType: "text/plain",
      location: null,
      bodyBase64: btoa(raw.url === LINK ? LINK_TEXT : PAGE_TEXT),
    });
  }
}

/**
 * A model for the two turns of the journey. In the Portal chat it asks for
 * the documentation and answers when its request holds the page. In the turn
 * of the message with a link it finds the link tool, reads the link and
 * answers when its request holds that page.
 */
class ReadingModel {
  turn: "portal_chat" | "message_with_link" = "portal_chat";
  readonly sawPage: boolean[] = [];
  readonly sawLinkPage: boolean[] = [];
  private linkReadIssued = false;

  constructor(
    private readonly person: Member,
    private readonly conversationId: ConversationId,
    private readonly linkFetch: RecordingLinkFetch,
  ) {}

  respond(input: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    return this.turn === "portal_chat"
      ? this.readDocumentation(input)
      : this.readLink(input);
  }

  private async readDocumentation({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const sent = await request.clone().text();
    // The Case Actor of the conversation reads the documentation.
    await runInDurableObject(
      await conversationCase(this.person, this.conversationId),
      bindLinkFetch.bind(null, this.linkFetch),
    );
    this.sawPage.push(sent.includes(PAGE_TEXT));
    const id = `link_fetch_placement_chat_${String(this.sawPage.length)}`;
    return sent.includes(PAGE_TEXT)
      ? openRouterText(JSON.stringify({ kind: "reply", text: ANSWER }), id)
      : openRouterText(
          JSON.stringify({ kind: "read_documentation", url: DOCUMENTATION }),
          id,
        );
  }

  private async readLink({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const body: unknown = await request.clone().json();
    if (!isRecord(body)) throw new Error("The model request is invalid");
    const sent = JSON.stringify(body);
    this.sawLinkPage.push(sent.includes(LINK_TEXT));
    const id = `link_fetch_placement_link_${String(this.sawLinkPage.length)}`;
    if (sent.includes(LINK_TEXT))
      return openRouterText(
        JSON.stringify({ kind: "reply", text: "Delivery is on Friday." }),
        id,
      );
    if (this.linkReadIssued) throw new Error("The link read gave no page");
    if (!offeredToolNames(body).includes("read_message_link")) {
      if (this.sawLinkPage.length > 8)
        throw new Error("The link tool was not found");
      return openRouterToolCall(
        "tool_search",
        { query: "read_message_link", limit: 1 },
        id,
      );
    }
    this.linkReadIssued = true;
    return openRouterToolCall("read_message_link", { url: LINK }, id);
  }
}

async function linkFetchPlacementJourney({ task }: TestContext): Promise<void> {
  const { organisationId, author, route, paths } = await installMemoryFixture();
  // The region of the Organisation, as its placement row holds it.
  const placement = (
    await requireOrganisationExecutionScope(env, organisationId)
  ).placement;
  const linkFetch = new RecordingLinkFetch();
  const classBinding = env.MESSAGE_LINK_FETCH;
  const conversationId = newConversationId();
  const model = new ReadingModel(author, conversationId, linkFetch);
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
    http.get("https://cloudflare-dns.com/dns-query", resolvePublicAddress),
  );

  await createConversation(author, conversationId, route);
  const started = await post(author, paths.chat, {
    kind: "message",
    conversationId,
    requestId: "request_link_fetch_placement",
    model: route.model,
    text: `Set up the carrier API. Read its reference first: ${DOCUMENTATION}.`,
    browserContext: { kind: "unavailable" },
  });
  expect(started.status, await started.clone().text()).toBe(200);
  try {
    await expect
      .poll(workKind.bind(null, author, conversationId), { timeout: 40_000 })
      .toBe("ready");
  } catch {
    const failed = await storedConversation(author, conversationId);
    throw new Error(
      JSON.stringify({
        work: failed?.conversation.work,
        lastEvent: failed?.conversation.timeline.at(-1),
        addressed: linkFetch.addressed,
        fetched: linkFetch.fetched,
        sawPage: model.sawPage,
      }),
    );
  } finally {
    // The operator route below needs the class itself again.
    await runInDurableObject(
      await conversationCase(author, conversationId),
      bindLinkFetch.bind(null, classBinding),
    );
  }

  // The page reached the model, and its answer reached the conversation.
  const stored = await storedConversation(author, conversationId);
  expect(JSON.stringify(stored?.conversation.timeline)).toContain(ANSWER);
  expect(model.sawPage.at(-1)).toBe(true);
  expect(linkFetch.fetched).toEqual([DOCUMENTATION, DOCUMENTATION_PAGE]);
  const documentationRead = [...linkFetch.addressed];

  // A message with a link, as a Slack turn carries it. Its Session reads the
  // link with the link tool.
  await allowLinkReads(author);
  model.turn = "message_with_link";
  // The Session Actor of the turn reads the link. It takes its class binding
  // when the turn starts.
  await runInDurableObject(
    await linkSession(author),
    bindLinkFetch.bind(null, linkFetch),
  );
  let linkTurn;
  try {
    linkTurn = await sendMessageWithLink(author);
  } finally {
    await runInDurableObject(
      await linkSession(author),
      bindLinkFetch.bind(null, classBinding),
    );
  }
  expect(linkTurn.ok, JSON.stringify(linkTurn)).toBe(true);
  expect(model.sawLinkPage.at(-1)).toBe(true);
  expect(linkFetch.fetched.slice(2)).toEqual([LINK]);
  const linkRead = linkFetch.addressed.slice(documentationRead.length);

  // Each request went to one Actor: the one of the Organisation's region,
  // asked for in that region.
  const names = [...new Set(linkFetch.addressed.map(addressedName))];
  expect(documentationRead).toHaveLength(2);
  expect(linkRead).toHaveLength(1);
  expect(names).toHaveLength(1);
  const name = names[0];
  if (name === undefined) throw new Error("No Actor was addressed");
  expect(name).toContain(placement.locationHint);
  expect([...new Set(linkFetch.addressed.map(addressedHint))]).toEqual([
    placement.locationHint,
  ]);

  task.meta.messageLinkFetchPlacement = {
    organisationLocationHint: placement.locationHint,
    portalChatDocumentationRead: {
      addressed: documentationRead,
      modelSawPage: model.sawPage,
    },
    messageLinkRead: {
      addressed: linkRead,
      modelSawPage: model.sawLinkPage,
    },
  };
}

/** Gives the person the link capability and turns it on for the Organisation. */
async function allowLinkReads(person: Member): Promise<void> {
  const organisationId = person.organisationId;
  const now = Date.now();
  for (const capabilityId of ["context.case.read", "message.link.read"]) {
    const grant = await createAccessGrant({
      db: fixtureDatabase(),
      organisationId,
      grantId: `grant_link_fetch_placement_${capabilityId}`,
      subject: { kind: "person", personId: person.personId },
      target: {
        kind: "platform_capability",
        capabilityId,
        capabilityVersion: 1,
      },
      provenance: {
        kind: "baseline",
        profile: "read_and_propose",
        profileVersion: 1,
        materializationReceiptId: `receipt_link_fetch_${capabilityId}`,
      },
      now,
    });
    if (!grant.ok) throw new Error(grant.error.code);
  }
  const enabled = await writeOrganisationCapabilityPolicy({
    scope: await requireOrganisationExecutionScope(env, organisationId),
    write: {
      kind: "change",
      capabilityId: "message.link.read",
      expectedRevision: 1,
      mode: "enabled",
      provenance: {
        kind: "operator",
        userId: person.userId,
        mutationReceiptId: "receipt_link_fetch_placement",
      },
      now,
    },
  });
  if (!enabled.ok) throw new Error(enabled.error.code);
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId,
    organisation: await requireActiveOrganisationActor({
      env,
      organisationId,
      now,
    }),
    now,
  });
  if (!published.ok) throw new Error(published.error.code);
}

async function sendMessageWithLink(person: Member) {
  const organisationId = person.organisationId;
  const revision = await readActiveOrganisationMembershipRevision({
    db: fixtureDatabase(),
    organisationId,
  });
  const membership = await readActiveOrganisationMembership(
    fixtureDatabase(),
    organisationId,
    person.userId,
  );
  if (revision === null || membership === null)
    throw new Error("The person is no member");
  const requestId = parseRequestId("request_link_fetch_placement_link");
  if (!requestId.ok) throw new Error(requestId.error.code);
  const message = deriveUserMessageViews({
    firstPart: { kind: "text", text: "Inspect this supplier page." },
    remainingParts: [
      { kind: "link", link: { url: LINK, presentation: { kind: "url" } } },
    ],
  });
  if (!message.ok) throw new Error(message.error.code);
  return processDirectCaseCommand(env, {
    scope: await requireOrganisationExecutionScope(env, organisationId),
    projectContext: null,
    organisationId,
    requestId: requestId.value,
    stableIdentity: `${organisationId}:${LINK_STABLE_IDENTITY}`,
    operatorOrigin: {
      kind: "control_session",
      controlSessionId: person.session.session.controlSessionId,
    },
    triggerSource: { kind: "api", commandId: "command_link_fetch_placement" },
    content: { kind: "user_message", message: message.value.message },
    purpose: "Inspect the supplier page.",
    principal: { kind: "human", principalId: person.personId },
    requestAuthority: buildControlAuthority({
      organisationId,
      userId: person.userId,
      requesterPersonId: person.personId,
      membershipRevision: revision,
      role: membership.role,
    }).requestAuthority,
    receivedAt: Date.now(),
    role: "coordinator",
    objective: "Inspect the supplier page.",
    delivery: { kind: "none" },
    browserContext: { kind: "unavailable" },
    surfaceContext: null,
  });
}

/** The Session Actor of the message with a link. */
async function linkSession(person: Member) {
  const organisationId = person.organisationId;
  const identities = await deriveDirectCaseIdentities(
    `${organisationId}:${LINK_STABLE_IDENTITY}`,
  );
  if (!identities.ok) throw new Error(identities.error.code);
  const actor = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId,
    sessionId: identities.value.sessionId,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  return actor.value;
}

function addressedName(address: Addressed): string {
  return address.name;
}

function addressedHint(address: Addressed): string | null {
  return address.locationHint;
}
