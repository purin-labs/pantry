import { env, exports } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  isConversationId,
  newConversationId,
  newProjectId,
  sideCaseHereRequestId,
  type ConversationId,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import { saveConversation } from "../../src/chat/store";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  answers,
  ask,
  cardId,
  currentRequest,
  lastCalledTool,
} from "./chat-permission-support";
import { finished } from "./chat-journey-support";
import { commerceHeaders } from "./commerce-support";
import {
  emptyConversation,
  installMemoryFixture,
  post,
  postJson,
  storedConversation,
  type Member,
} from "./memory-support";
import { network } from "./network";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatSideCase?: Record<string, unknown>;
  }
}

/**
 * An agent proposes side Cases in a Portal chat, and the owner decides.
 *
 * The owner asks a question in a chat of the Launch Project. While the agent
 * answers, it proposes separate work as a side Case; the chat shows the card
 * and nothing starts. The owner starts it twice, as a double click does: one
 * new chat starts in the Launch Project, under its source chat, and its first
 * model request holds the brief as the person's request and no turn of the
 * source chat. In a second
 * turn the agent proposes four more: the chat keeps three, and the agent
 * learns that the fourth was not kept. The owner dismisses one, which then
 * cannot start. When the owner deletes the source chat, the started side
 * Case stays and its link to the source becomes unavailable, and the
 * proposals that never started are gone.
 */
it(
  "shows an agent's side Case proposals as cards that the owner starts or dismisses",
  { timeout: 240_000 },
  sideCaseJourney,
);

const QUESTION = "Check how many croissant orders came in today.";
const QUESTION_TWO = "Look over this week's pastry deliveries as well.";
const PARENT_ANSWER = "Today has 14 croissant orders. I proposed a side Case.";
const LATER_ANSWER = "The deliveries look complete. I proposed more checks.";
const TITLE = "Fix the almond croissant price";
const BRIEF =
  "The almond croissant shows a price of 0 yen in the shop, but the menu says 520 yen. Find where the price came from and correct it to 520 yen.";
const CHILD_ANSWER = "I will check the almond croissant price record.";
const SIDE_CASE_INSTRUCTION = "side Case proposal in another chat";
const LATER_PROPOSALS = [
  {
    title: "Restock butter",
    brief: "Butter stock is below two days of use. Prepare an order.",
  },
  {
    title: "Check oven two",
    brief: "Oven two reported a low temperature twice. Check its log.",
  },
  {
    title: "Fix a supplier email",
    brief: "The flour supplier email bounces. Find the current address.",
  },
  {
    title: "Review gift box stock",
    brief: "Gift boxes may run out before the weekend. Count them.",
  },
] as const;

type Recorded = {
  readonly requests: Record<string, unknown>[];
  readonly childRequests: Record<string, unknown>[];
  readonly hereRequests: Record<string, unknown>[];
  readonly proposalOutputs: string[];
  firstTurnTools: string[] | null;
};

async function sideCaseJourney({ task }: TestContext): Promise<void> {
  const { author: owner, route, paths } = await installMemoryFixture();
  const recorded: Recorded = {
    requests: [],
    childRequests: [],
    hereRequests: [],
    proposalOutputs: [],
    firstTurnTools: null,
  };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded),
    ),
  );
  const launch = newProjectId();
  const created = await postJson(owner, paths.projects, {
    kind: "create_project",
    operationId: "create-launch",
    projectId: launch,
    content: { name: "Launch", brief: "", references: [] },
  });
  expect(created.body).toEqual({
    kind: "accepted",
    projectId: launch,
    revision: 1,
  });
  const parentId = newConversationId();
  expect(
    await saveConversation(
      await requireOrganisationExecutionScope(env, owner.organisationId),
      owner.userId,
      emptyConversation(parentId, route),
      0,
      { projectId: launch },
    ),
  ).toEqual({ kind: "saved" });

  // 1. The agent proposes a side Case while it answers; nothing starts.
  await ask(owner, paths.chat, parentId, route.model, QUESTION, "first");
  await finished(owner, parentId);
  expect(await answers(owner, parentId)).toEqual([PARENT_ANSWER]);
  expect(recorded.proposalOutputs).toHaveLength(1);
  expect(recorded.proposalOutputs[0]).toContain("card");
  expect(recorded.childRequests).toHaveLength(0);
  const proposed = await readChat(owner, paths.chat, parentId);
  expect(proposed.sideCases).toEqual([
    {
      proposalId: expect.stringMatching(/^[0-9a-f]{32}$/u),
      title: TITLE,
      brief: BRIEF,
      createdAt: expect.any(Number),
      state: { kind: "open", expiresAt: expect.any(Number), mayDecide: true },
    },
  ]);
  const proposalId = cardId(proposed.sideCases, TITLE);

  // 2. Two starts, as a double click sends them, make one new chat.
  const startPath = sideCasePath(paths.chat, parentId, proposalId, "start");
  const started = await postJson(owner, startPath, {});
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const again = await postJson(owner, startPath, {});
  expect(again.status, JSON.stringify(again.body)).toBe(200);
  const childId = conversationIdOf(started.body);
  expect(conversationIdOf(again.body)).toBe(childId);
  await finished(owner, childId);
  expect(await answers(owner, childId)).toEqual([CHILD_ANSWER]);
  expect(recorded.childRequests).toHaveLength(1);
  // The side Case holds no turn of its source chat: one system message and
  // the person's request, which is the brief. Organisational context that
  // any new chat reads may still name the source chat's messages.
  const childRequest = recorded.childRequests[0] ?? {};
  expect(messageRoles(childRequest)).toEqual(["system", "user"]);
  expect(currentRequest(childRequest)).toContain(BRIEF);
  expect(JSON.stringify(childRequest)).toContain(SIDE_CASE_INSTRUCTION);

  // 3. The new chat is in the Launch Project, under its source chat.
  const child = await readChat(owner, paths.chat, childId);
  expect(child.conversation).toMatchObject({
    id: childId,
    title: TITLE,
    lineage: {
      kind: "side_case",
      sourceConversationId: parentId,
      proposalId,
    },
    placement: { projectId: launch },
  });
  expect(child.sideCaseSource).toEqual({
    kind: "available",
    conversationId: parentId,
    title: expect.any(String),
  });
  const rows = sidebarRows(child.conversations);
  expect(rows.filter(isChildOf.bind(null, parentId))).toEqual([
    expect.objectContaining({
      id: childId,
      parentConversationId: parentId,
      placement: expect.objectContaining({ projectId: launch }),
    }),
  ]);
  expect(rows.find(hasId.bind(null, parentId))).toMatchObject({
    parentConversationId: null,
  });
  const afterStart = await readChat(owner, paths.chat, parentId);
  expect(stateOf(afterStart.sideCases, TITLE)).toEqual({
    kind: "started",
    conversationId: childId,
  });

  // 4. A chat keeps three proposals that wait; the agent learns of the fourth.
  await ask(owner, paths.chat, parentId, route.model, QUESTION_TWO, "second");
  await finished(owner, parentId);
  expect(await answers(owner, parentId)).toEqual([PARENT_ANSWER, LATER_ANSWER]);
  expect(recorded.proposalOutputs).toHaveLength(5);
  expect(recorded.proposalOutputs.slice(1, 4)).toEqual([
    expect.stringContaining("card"),
    expect.stringContaining("card"),
    expect.stringContaining("card"),
  ]);
  expect(recorded.proposalOutputs[4]).toContain("three side Case proposals");
  const later = await readChat(owner, paths.chat, parentId);
  expect(later.sideCases.map(cardTitle)).toEqual([
    LATER_PROPOSALS[2].title,
    LATER_PROPOSALS[1].title,
    LATER_PROPOSALS[0].title,
    TITLE,
  ]);

  // 5. The browser loses its accepted response before it can dismiss the
  // card. A new reader recovers the message, and a retry executes it once.
  const butter = cardId(later.sideCases, LATER_PROPOSALS[0].title);
  const hereCommand = {
    kind: "message",
    conversationId: parentId,
    requestId: sideCaseHereRequestId(butter),
    model: route.model,
    text: LATER_PROPOSALS[0].brief,
    browserContext: { kind: "unavailable" },
  };
  await post(owner, paths.chat, hereCommand);
  const retried = await postJson(owner, paths.chat, hereCommand);
  expect(retried.status, JSON.stringify(retried.body)).toBe(200);
  await finished(owner, parentId);
  const recovered = await readChat(owner, paths.chat, parentId);
  expect(recovered.conversation.timeline).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "user",
        requestId: hereCommand.requestId,
        text: hereCommand.text,
      }),
      expect.objectContaining({
        kind: "assistant",
        text: "I will prepare the butter order.",
      }),
    ]),
  );
  const afterReload = await postJson(owner, paths.chat, hereCommand);
  expect(afterReload.status).toBe(200);
  expect(recorded.hereRequests).toHaveLength(1);
  const beforeDismiss = await postJson(
    owner,
    sideCasePath(paths.chat, parentId, butter, "start"),
    {},
  );
  expect(beforeDismiss).toEqual({
    status: 409,
    body: expect.objectContaining({ error: "side_case_closed" }),
  });
  const dismissed = await postJson(
    owner,
    sideCasePath(paths.chat, parentId, butter, "dismiss"),
    {},
  );
  expect(dismissed.status).toBe(200);
  const late = await postJson(
    owner,
    sideCasePath(paths.chat, parentId, butter, "start"),
    {},
  );
  expect(late).toEqual({
    status: 409,
    body: expect.objectContaining({ error: "side_case_closed" }),
  });
  const reread = await readChat(owner, paths.chat, parentId);
  expect(stateOf(reread.sideCases, LATER_PROPOSALS[0].title)).toEqual({
    kind: "dismissed",
  });
  expect(recorded.childRequests).toHaveLength(1);

  // 6. The started side Case outlives its source chat.
  const parent = await storedConversation(owner, parentId);
  if (parent === null) throw new Error("Source chat missing");
  const conversationPath = `${paths.chat}/conversations/${parentId}`;
  expect(
    (
      await patch(owner, conversationPath, {
        action: "archive",
        expectedRevision: parent.revision,
      })
    ).status,
  ).toBe(200);
  const deleted = await patch(owner, conversationPath, {
    action: "delete",
    operationId: "delete-source-chat",
    expectedRevision: parent.revision,
  });
  expect(deleted.status, await deleted.clone().text()).toBe(200);
  const orphan = await readChat(owner, paths.chat, childId);
  expect(orphan.conversation).toMatchObject({ id: childId, title: TITLE });
  expect(orphan.sideCaseSource).toEqual({ kind: "unavailable" });
  const kept = await proposalStates(owner);
  expect(kept).toEqual([{ title: TITLE, status: "started" }]);

  task.meta.chatSideCase = {
    modelRequests: recorded.requests.length,
    firstTurnTools: recorded.firstTurnTools,
    proposalOutputs: recorded.proposalOutputs,
    childFirstRequest: recorded.childRequests[0],
    recoveredHere: recovered.conversation,
    hereModelRequests: recorded.hereRequests.length,
    cardsBeforeDeletion: reread.sideCases,
    childChat: orphan.conversation,
    proposalsAfterDeletion: kept,
  };
}

/**
 * The model of this journey. Each request belongs to the first or second
 * turn of the source chat, or to the side Case, by the person's message
 * that it answers.
 */
async function replyToModel(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  recorded.requests.push(body);
  const id = `side_case_${String(recorded.requests.length)}`;
  const current = currentRequest(body);
  if (current.includes(LATER_PROPOSALS[0].brief)) {
    recorded.hereRequests.push(body);
    return reply("I will prepare the butter order.", id);
  }
  const called = lastCalledTool(body);
  if (called === "propose_side_case")
    recorded.proposalOutputs.push(requireLastToolOutput(body));
  if (current.includes(QUESTION_TWO)) return laterTurn(body, called, id);
  if (current.includes(QUESTION)) {
    if (called === null) recorded.firstTurnTools = offeredToolNames(body);
    if (called === "propose_side_case") return reply(PARENT_ANSWER, id);
    return proposeOrSearch(body, called, { title: TITLE, brief: BRIEF }, id);
  }
  if (current.includes(BRIEF)) {
    recorded.childRequests.push(body);
    return reply(CHILD_ANSWER, id);
  }
  throw new Error("Unexpected model request");
}

/** The second turn proposes four side Cases, one call after another. */
function laterTurn(
  body: Record<string, unknown>,
  called: string | null,
  id: string,
): Response {
  const made = proposalCallsAfter(body, QUESTION_TWO);
  const next = LATER_PROPOSALS[made];
  if (next === undefined) return reply(LATER_ANSWER, id);
  return proposeOrSearch(body, called, next, id);
}

function proposeOrSearch(
  body: Record<string, unknown>,
  called: string | null,
  proposal: Readonly<{ title: string; brief: string }>,
  id: string,
): Response {
  // A large catalogue offers the tool after a search, as a real model sees it.
  if (
    !offeredToolNames(body).includes("propose_side_case") &&
    called !== "tool_search"
  )
    return openRouterToolCall(
      "tool_search",
      { query: "propose_side_case" },
      `call_${id}`,
    );
  return openRouterToolCall("propose_side_case", proposal, `call_${id}`);
}

function reply(text: string, id: string): Response {
  return openRouterText(JSON.stringify({ kind: "reply", text }), id);
}

/** The side Case calls after the person's message that holds `marker`. */
function proposalCallsAfter(
  body: Record<string, unknown>,
  marker: string,
): number {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let start = -1;
  messages.forEach(function findMarker(message: unknown, index: number) {
    if (
      isRecord(message) &&
      message.role === "user" &&
      JSON.stringify(message.content).includes(marker)
    )
      start = index;
  });
  let calls = 0;
  for (const message of messages.slice(start + 1))
    if (isRecord(message) && Array.isArray(message.tool_calls))
      for (const call of message.tool_calls)
        if (
          isRecord(call) &&
          isRecord(call.function) &&
          call.function.name === "propose_side_case"
        )
          calls += 1;
  return calls;
}

function messageRoles(body: Record<string, unknown>): unknown[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.map((message: unknown) =>
    isRecord(message) ? message.role : null,
  );
}

type ChatRead = Readonly<{
  conversation: Record<string, unknown>;
  conversations: unknown;
  sideCases: readonly Record<string, unknown>[];
  sideCaseSource: unknown;
}>;

/** The chat as the Portal reads it. */
async function readChat(
  person: Member,
  chatPath: string,
  conversationId: ConversationId,
): Promise<ChatRead> {
  const read = await postJson(
    person,
    `${chatPath}?conversation=${conversationId}`,
    null,
  );
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  const body = read.body;
  if (
    !isRecord(body) ||
    !isRecord(body.conversation) ||
    !Array.isArray(body.sideCases)
  )
    throw new Error("Chat read invalid");
  return {
    conversation: body.conversation,
    conversations: body.conversations,
    sideCases: body.sideCases.filter(isRecord),
    sideCaseSource: body.sideCaseSource,
  };
}

function sidebarRows(raw: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(raw)) throw new Error("Chat list invalid");
  return raw.filter(isRecord);
}

function isChildOf(
  parentId: ConversationId,
  row: Record<string, unknown>,
): boolean {
  return row.parentConversationId === parentId;
}

function hasId(id: string, row: Record<string, unknown>): boolean {
  return row.id === id;
}

function cardTitle(card: Record<string, unknown>): unknown {
  return card.title;
}

function stateOf(
  cards: readonly Record<string, unknown>[],
  title: string,
): unknown {
  return cards.find((candidate) => candidate.title === title)?.state;
}

function conversationIdOf(body: unknown): ConversationId {
  if (!isRecord(body) || !isConversationId(body.conversationId))
    throw new Error("Start answer invalid");
  return body.conversationId;
}

function sideCasePath(
  chatPath: string,
  conversationId: ConversationId,
  proposalId: string,
  action: "start" | "dismiss",
): string {
  return `${chatPath}/conversations/${conversationId}/side-cases/${proposalId}/${action}`;
}

function patch(person: Member, path: string, body: unknown): Promise<Response> {
  return exports.default.fetch(`https://localhost${path}`, {
    method: "PATCH",
    headers: commerceHeaders(person.session),
    body: JSON.stringify(body),
  });
}

/** Which proposals of the Organisation remain, by title. */
async function proposalStates(
  person: Member,
): Promise<readonly Readonly<{ title: string; status: string }>[]> {
  const scope = await requireOrganisationExecutionScope(
    env,
    person.organisationId,
  );
  const rows = await scope.database
    .prepare(
      "SELECT title, status FROM side_case_proposal WHERE organisation_id = ? ORDER BY created_at",
    )
    .bind(person.organisationId)
    .all<{ title: string; status: string }>();
  return rows.results;
}
