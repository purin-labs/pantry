// Plan 87 J7: the Jev relevance suggestion of the composer (section 3A). A
// fake TypeSafe only records each request and answers the next scores; product
// code builds what Jev reads, refuses the requests that the journey asserts,
// picks the band and keeps the page out of a message that the person sent
// without it.
import { runInDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  newProjectId,
  type ConversationId,
  type SurfaceObservationV2,
} from "@seams/control-api";
import { isRecord } from "@seams/std";

import {
  createConversation,
  installMemoryFixture,
  post,
  storedConversation,
  workKind,
  type Member,
  type MemoryFixture,
} from "./memory-support";
import { network } from "./network";
import { openRouterText } from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatScreenRelevance?: Record<string, unknown>;
  }
}

/** Costs & margins with its facts and one table row on screen. */
const COSTS_OBSERVATION: SurfaceObservationV2 = {
  kind: "surface-observation",
  schemaVersion: 2,
  surface: "costs",
  area: "BakeryOS",
  instance: {
    browserInstanceId: "browser-j7",
    surfaceSessionId: "costs-session-j7",
    epoch: 0,
  },
  title: "Costs & margins",
  path: "/portal/nuki/shop/costs",
  record: null,
  capturedAt: 1_793_000_000_000,
  view: [
    {
      title: "Scenario inputs",
      facts: [{ label: "Shelf waste (spoil)", value: "11%" }],
      table: null,
    },
    {
      title: "Product margins table (rows in view)",
      facts: [],
      table: {
        columns: ["Product", "Units per day", "Price", "Net margin"],
        rows: [["Black sesame latte", "28", "¥680", "61.3%"]],
        totalRows: 1,
      },
    },
  ],
  state: null,
  commands: [],
  sources: [],
};

/** Orders with order #1042 open: the page where the chat starts. */
const ORDER_OBSERVATION: SurfaceObservationV2 = {
  ...COSTS_OBSERVATION,
  surface: "orders",
  area: "AgentCommerce",
  title: "Orders",
  path: "/portal/nuki/shop/orders/order_1042",
  record: { kind: "customer_order", id: "order_1042", label: "#1042" },
  view: [],
};

type Scores = Readonly<{ about_screen: number; fits_chat: number }>;

type TypeSafeFake = {
  readonly requests: Record<string, unknown>[];
  readonly answers: Scores[];
};

it(
  "J7: Jev suggests the page on screen, only the person's choice attaches it, and no draft goes to Jev for a page that the chat's readers may not receive or with the switch off",
  { timeout: 300_000 },
  async ({ task }: TestContext): Promise<void> => {
    const fixture = await installMemoryFixture();
    const { author, reviewer, route, paths } = fixture;
    const modelRequests: string[] = [];
    const typeSafe: TypeSafeFake = { requests: [], answers: [] };
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        recordModel.bind(null, modelRequests),
      ),
      http.post(
        "https://api.typesafe.ai/v1/systemone",
        recordTypeSafe.bind(null, typeSafe),
      ),
    );

    // A chat that started on Orders, with one answer.
    const conversationId = newConversationId();
    await createConversation(author, conversationId, route);
    const first = await send(author, paths.chat, conversationId, route.model, {
      label: "origin",
      text: "Why is order #1042 held?",
      observation: ORDER_OBSERVATION,
    });
    expect(first.status, await first.clone().text()).toBe(200);
    await finish(author, conversationId);

    // The switch is off: the check sends nothing to Jev.
    const switchedOff = await check(
      author,
      paths.chat,
      conversationId,
      "Why is the latte margin so low?",
      COSTS_OBSERVATION,
    );
    expect(switchedOff).toEqual({ kind: "unavailable" });
    expect(typeSafe.requests).toHaveLength(0);

    await turnScreenRelevance(author, paths.organisation, true);

    // On Costs, a question about the page: Jev reads the draft, the origin,
    // the last answer and the section titles, and no fact value or row.
    typeSafe.answers.push({ about_screen: 0.92, fits_chat: 0.55 });
    const asked = await check(
      author,
      paths.chat,
      conversationId,
      "Why is the latte margin so low?",
      COSTS_OBSERVATION,
    );
    expect(asked).toMatchObject({ kind: "ask", offerNewChat: false });
    expect(typeSafe.requests).toHaveLength(1);
    const jevRequest = JSON.stringify(typeSafe.requests[0]);
    expect(jevRequest).toContain("Why is the latte margin so low?");
    expect(jevRequest).toContain("Commerce › Orders › #1042");
    expect(jevRequest).toContain("Your screen shows the plan.");
    expect(jevRequest).toContain("Scenario inputs");
    expect(jevRequest).toContain("Product margins table (rows in view)");
    expect(jevRequest).toContain("Kitchen");
    for (const value of [
      "Black sesame latte",
      "61.3%",
      "¥680",
      "11%",
      "Shelf waste",
    ])
      expect(jevRequest).not.toContain(value);
    expect(jevRequest).toContain("untrusted data");

    // "Send without": the message carries no page, so the model gets no view.
    await choose(author, paths.chat, conversationId, asked, "sent_without");
    const without = await send(
      author,
      paths.chat,
      conversationId,
      route.model,
      {
        label: "without",
        text: "Why is the latte margin so low?",
      },
    );
    expect(without.status, await without.clone().text()).toBe(200);
    await finish(author, conversationId);
    const withoutInput = latestUserInput(modelRequests);
    expect(withoutInput).toContain(
      "The current request carries no page from the operator's screen",
    );
    expect(withoutInput).not.toContain("Black sesame latte");

    // A draft near the page gets the hint band and no question.
    typeSafe.answers.push({ about_screen: 0.6, fits_chat: 0.5 });
    const hinted = await check(
      author,
      paths.chat,
      conversationId,
      "Should we look at the latte price too?",
      COSTS_OBSERVATION,
    );
    expect(hinted).toMatchObject({ kind: "hint", offerNewChat: false });

    // A page off the chat's topic also offers a new chat. The person picks
    // "Send with this page", and the model gets the Costs view.
    typeSafe.answers.push({ about_screen: 0.88, fits_chat: 0.1 });
    const offTopic = await check(
      author,
      paths.chat,
      conversationId,
      "What is the net margin of the latte on screen?",
      COSTS_OBSERVATION,
    );
    expect(offTopic).toMatchObject({ kind: "ask", offerNewChat: true });
    await choose(author, paths.chat, conversationId, offTopic, "attached");
    const attached = await send(
      author,
      paths.chat,
      conversationId,
      route.model,
      {
        label: "with",
        text: "What is the net margin of the latte on screen?",
        observation: COSTS_OBSERVATION,
      },
    );
    expect(attached.status, await attached.clone().text()).toBe(200);
    await finish(author, conversationId);
    const attachedInput = latestUserInput(modelRequests);
    expect(attachedInput).toContain("Black sesame latte");
    expect(attachedInput).toContain("Shelf waste (spoil)");

    // Quiet: a draft about the chat's own topic.
    typeSafe.answers.push({ about_screen: 0.1, fits_chat: 0.8 });
    const quiet = await check(
      author,
      paths.chat,
      conversationId,
      "Did the customer of #1042 reply yet?",
      COSTS_OBSERVATION,
    );
    expect(quiet).toEqual({
      kind: "quiet",
      offerNewChat: false,
      checkId: null,
    });
    const jevCallsBeforeShared = typeSafe.requests.length;

    // A chat shared with a Project: Orders may not go to its readers, so the
    // draft goes nowhere.
    const shared = await sharedConversation(
      author,
      route,
      paths.projects,
      reviewer,
    );
    const sharedCheck = await check(
      author,
      paths.chat,
      shared,
      "Why is this order held for so long?",
      ORDER_OBSERVATION,
    );
    expect(sharedCheck).toEqual({ kind: "refused", reason: "page_not_shared" });
    expect(typeSafe.requests).toHaveLength(jevCallsBeforeShared);

    // The switch off again: no request goes to Jev.
    await turnScreenRelevance(author, paths.organisation, false);
    const offAgain = await check(
      author,
      paths.chat,
      conversationId,
      "What is the net margin of the latte now?",
      COSTS_OBSERVATION,
    );
    expect(offAgain).toEqual({ kind: "unavailable" });
    expect(typeSafe.requests).toHaveLength(jevCallsBeforeShared);

    // Each hint and question is a record with its scores and choice, and no
    // draft text or page content.
    const records = await relevanceRecords(fixture);
    expect(records).toEqual([
      expect.objectContaining({
        band: "ask",
        choice: "attached",
        about_screen: 0.88,
        fits_chat: 0.1,
        offer_new_chat: 1,
        model: "jev-1.13.0",
      }),
      expect.objectContaining({
        band: "hint",
        choice: "no_action",
        about_screen: 0.6,
      }),
      expect.objectContaining({
        band: "ask",
        choice: "sent_without",
        about_screen: 0.92,
        offer_new_chat: 0,
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("latte");
    const ledger = await relevanceLedger(fixture);
    expect(ledger).toEqual({ evaluated: 4, funding: "satyr_platform" });

    task.meta.chatScreenRelevance = {
      jevRequest: typeSafe.requests[0],
      bands: { asked, hinted, offTopic, quiet },
      sendWithoutModelInput: withoutInput,
      sendWithModelInput: attachedInput,
      sharedChatOrders: sharedCheck,
      switchOff: [switchedOff, offAgain],
      typeSafeRequests: typeSafe.requests.length,
      records,
      ledger,
    };
  },
);

async function check(
  author: Member,
  chatPath: string,
  conversationId: ConversationId,
  draft: string,
  observation: SurfaceObservationV2,
): Promise<unknown> {
  const response = await post(
    author,
    `${chatPath}/conversations/${conversationId}/screen-relevance`,
    { draft, observation },
  );
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}

async function choose(
  author: Member,
  chatPath: string,
  conversationId: ConversationId,
  view: unknown,
  choice: string,
): Promise<void> {
  if (!isRecord(view) || typeof view.checkId !== "string")
    throw new Error("The check has no record");
  const response = await post(
    author,
    `${chatPath}/conversations/${conversationId}/screen-relevance/${view.checkId}/choice`,
    { choice },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

async function turnScreenRelevance(
  author: Member,
  organisationPath: string,
  enabled: boolean,
): Promise<void> {
  const response = await post(author, `${organisationPath}/jev-features`, {
    feature: "screen_relevance",
    enabled,
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function relevanceRecords(
  fixture: MemoryFixture,
): Promise<readonly Record<string, unknown>[]> {
  return runInDurableObject(fixture.organisation, (_instance, state) =>
    state.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT about_screen, fits_chat, band, offer_new_chat, model, choice, surface
        FROM jev_screen_relevance_record WHERE organisation_id = ? ORDER BY created_at DESC`,
        fixture.organisationId,
      )
      .toArray(),
  );
}

async function relevanceLedger(
  fixture: MemoryFixture,
): Promise<Readonly<{ evaluated: number; funding: unknown }>> {
  return runInDurableObject(fixture.organisation, (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ state: string; funding: string }>(
        "SELECT state, funding FROM typesafe_evaluation WHERE organisation_id = ? AND purpose = 'screen_relevance'",
        fixture.organisationId,
      )
      .toArray();
    return {
      evaluated: rows.filter((row) => row.state === "evaluated").length,
      funding: rows[0]?.funding,
    };
  });
}

/** A new chat of the owner, shared with a Project that has a viewer. */
async function sharedConversation(
  author: Member,
  route: Parameters<typeof createConversation>[2],
  projectsPath: string,
  viewer: Member,
): Promise<ConversationId> {
  const projectId = newProjectId();
  const created = await post(author, projectsPath, {
    kind: "create_project",
    operationId: crypto.randomUUID(),
    projectId,
    content: { name: "Orders review", brief: "", references: [] },
  });
  expect(created.status, await created.clone().text()).toBe(200);
  const access = await post(author, `${projectsPath}/${projectId}/access`, {
    kind: "share_project",
    operationId: crypto.randomUUID(),
    expectedAccessRevision: 0,
    members: [{ userId: viewer.userId, role: "viewer" }],
  });
  expect(access.status, await access.clone().text()).toBe(200);
  const conversationId = newConversationId();
  await createConversation(author, conversationId, route);
  const stored = await storedConversation(author, conversationId);
  if (stored === null) throw new Error("The new chat is missing");
  const sharing = await post(
    author,
    `${projectsPath.replace(/projects$/u, "chat")}/conversations/${conversationId}/access`,
    {
      kind: "share_conversation",
      operationId: crypto.randomUUID(),
      expectedRevision: stored.revision,
      projectId,
      expectedProjectAccessRevision: 1,
    },
  );
  expect(await sharing.json()).toMatchObject({ kind: "accepted" });
  return conversationId;
}

async function finish(
  author: Member,
  conversationId: ConversationId,
): Promise<void> {
  await expect
    .poll(workKind.bind(null, author, conversationId), { timeout: 60_000 })
    .toBe("ready");
}

function send(
  author: Member,
  chatPath: string,
  conversationId: ConversationId,
  model: string,
  message: Readonly<{
    label: string;
    text: string;
    observation?: SurfaceObservationV2;
  }>,
): Promise<Response> {
  return post(author, chatPath, {
    kind: "message",
    conversationId,
    requestId: `request_${conversationId}_${message.label}`,
    model,
    text: message.text,
    surfaceContext: null,
    browserContext: { kind: "unavailable" },
    ...(message.observation === undefined
      ? {}
      : { surfaceObservation: message.observation }),
  });
}

async function recordModel(
  requests: string[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  requests.push(JSON.stringify(body));
  return openRouterText(
    "Your screen shows the plan.",
    `screen_relevance_${String(requests.length)}`,
  );
}

async function recordTypeSafe(
  fake: TypeSafeFake,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid TypeSafe request");
  fake.requests.push(body);
  const scores = fake.answers.shift();
  if (scores === undefined) throw new Error("The fake TypeSafe has no answer");
  return HttpResponse.json({
    model: "jev-1.13.0",
    answers: {
      about_screen: { type: "noul", noul: scores.about_screen },
      fits_chat: { type: "noul", noul: scores.fits_chat },
    },
    usage: { input_tokens: 480, output_tokens: 2 },
  });
}

/** The newest user message of the newest model request. */
function latestUserInput(requests: readonly string[]): string {
  const latest = requests.at(-1);
  if (latest === undefined) throw new Error("The model received no request");
  const body: unknown = JSON.parse(latest);
  const messages =
    isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (isRecord(message) && message.role === "user")
      return JSON.stringify(message.content);
  }
  throw new Error("The model request has no user message");
}
