import { env } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  isConversationId,
  newConversationId,
  newProjectId,
  type ConversationId,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import type { CaseTimelineCase } from "@purin-labs/control-api";

import { saveConversation } from "../../src/chat/store";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { answers, cardId, currentRequest } from "./chat-permission-support";
import { finished } from "./chat-journey-support";
import {
  emptyConversation,
  installMemoryFixture,
  post,
  postJson,
  type Member,
} from "./memory-support";
import { readCaseTimeline } from "./case-execution-support";
import { network } from "./network";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatSideCaseFlow?: Record<string, unknown>;
  }
}

/**
 * A side Case keeps the audience of the chat that proposed it.
 *
 * The owner and an admin share the Launch Project, and the owner asks a
 * shared chat there about wholesale volumes. The agent proposes two side
 * Cases. The admin, an editor of the chat, sees both cards and starts one: it
 * becomes the admin's own chat in Launch and runs with the brief. Then the
 * owner moves the source chat to the Kitchen Project, which the admin cannot
 * read. The admin keeps Launch, but the admin's side Case closes for the
 * admin: it does not open and takes no message, because its brief came from a
 * chat that the admin can no longer read. The admin cannot start the other
 * proposal either; the owner, who still reads the source chat, can.
 *
 * The source chat and the briefs share no word, so the side Case's context
 * search finds nothing of the source chat. Only the proposal carries the
 * source chat's audience into the side Case.
 */
it(
  "closes a side Case for a person who loses the chat that proposed it",
  { timeout: 240_000 },
  sideCaseFlowJourney,
);

const QUESTION = "Summarise wholesale volumes.";
const ANSWER = "Volumes rose; two proposals await.";
const PROPOSALS = [
  {
    title: "Confirm the hotel order",
    brief:
      "Harbour Hotel lacks pastry delivery times. Telephone them; record answers.",
  },
  {
    title: "Recount the gift boxes",
    brief: "Gift boxes differ by six. Recount stock carefully.",
  },
] as const;
const SIDE_ANSWERS: Readonly<Record<string, string>> = {
  [PROPOSALS[0].brief]: "Calling Harbour Hotel now.",
  [PROPOSALS[1].brief]: "Counting gift boxes now.",
};

type Recorded = {
  readonly requests: Record<string, unknown>[];
  readonly sideRequests: Record<string, unknown>[];
};

async function sideCaseFlowJourney({ task }: TestContext): Promise<void> {
  const {
    author: owner,
    reviewer: admin,
    route,
    paths,
  } = await installMemoryFixture();
  const recorded: Recorded = { requests: [], sideRequests: [] };
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
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const projectAccess = `${paths.projects}/${launch}/access`;
  const shared = await postJson(owner, projectAccess, {
    kind: "share_project",
    operationId: "share-launch",
    expectedAccessRevision: 0,
    members: [{ userId: admin.userId, role: "editor" }],
  });
  expect(shared.body).toEqual({ kind: "accepted", accessRevision: 1 });
  const kitchen = newProjectId();
  const kitchenCreated = await postJson(owner, paths.projects, {
    kind: "create_project",
    operationId: "create-kitchen",
    projectId: kitchen,
    content: { name: "Kitchen", brief: "", references: [] },
  });
  expect(kitchenCreated.status, JSON.stringify(kitchenCreated.body)).toBe(200);
  const kitchenShared = await postJson(
    owner,
    `${paths.projects}/${kitchen}/access`,
    {
      kind: "share_project",
      operationId: "share-kitchen",
      expectedAccessRevision: 0,
      members: [],
    },
  );
  expect(kitchenShared.body).toEqual({ kind: "accepted", accessRevision: 1 });
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
  expect(
    await shareChat(owner, paths.chat, parentId, launch, "share_conversation"),
  ).toMatchObject({ status: 200 });
  const asked = await post(owner, paths.chat, {
    kind: "message",
    conversationId: parentId,
    requestId: `request_${parentId}`,
    model: route.model,
    text: QUESTION,
    browserContext: { kind: "unavailable" },
  });
  expect(asked.status, await asked.clone().text()).toBe(200);
  await finished(owner, parentId);
  expect(await answers(owner, parentId)).toEqual([ANSWER]);

  // 1. Allowed: the admin edits the shared chat and starts a side Case.
  const cards = await readCards(admin, paths.chat, parentId);
  expect(cards.map(cardSummary)).toEqual([
    { title: PROPOSALS[1].title, state: "open", mayDecide: true },
    { title: PROPOSALS[0].title, state: "open", mayDecide: true },
  ]);
  const started = await postJson(
    admin,
    startPath(paths.chat, parentId, cardId(cards, PROPOSALS[0].title)),
    {},
  );
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const adminSide = conversationIdOf(started.body);
  await finished(admin, adminSide);
  expect(await answers(admin, adminSide)).toEqual([
    SIDE_ANSWERS[PROPOSALS[0].brief],
  ]);
  const opened = await postJson(
    admin,
    `${paths.chat}?conversation=${adminSide}`,
    null,
  );
  expect(opened.status).toBe(200);
  expect(opened.body).toMatchObject({
    conversation: { placement: { projectId: launch } },
  });
  // The admin's Activity timeline names the side Case and links it to the
  // chat that proposed it.
  const adminSideCase = await startedSideCase(owner, PROPOSALS[0].title);
  const adminBefore = await timelineOf(admin);
  expect(
    adminBefore.find((event) => event.caseId === adminSideCase.caseId),
  ).toMatchObject({
    title: PROPOSALS[0].title,
    sideCaseOf: adminSideCase.sourceCaseId,
  });
  expect(adminBefore.map((event) => event.caseId)).toContain(
    adminSideCase.sourceCaseId,
  );

  // 2. Denied: the source chat moves where the admin cannot read it. The
  // admin still reads Launch, but the admin's side Case closes.
  const moved = await shareChat(
    owner,
    paths.chat,
    parentId,
    kitchen,
    "move_shared_conversation",
  );
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  const launchRead = await postJson(
    admin,
    `${paths.projects}/${launch}/cases`,
    null,
  );
  expect(launchRead.status).toBe(200);
  const closed = await postJson(
    admin,
    `${paths.chat}?conversation=${adminSide}`,
    null,
  );
  expect(closed.status).toBe(403);
  // The timeline closes it too: the admin's side Case keeps no title and no
  // link, and nothing of the proposal shows.
  const adminAfter = await timelineOf(admin);
  const closedEvent = adminAfter.find(
    (event) => event.caseId === adminSideCase.caseId,
  );
  expect({
    title: closedEvent?.title ?? null,
    sideCaseOf: closedEvent?.sideCaseOf ?? null,
  }).toEqual({ title: null, sideCaseOf: null });
  expect(JSON.stringify(adminAfter)).not.toContain(PROPOSALS[0].title);
  expect(adminAfter.map((event) => event.caseId)).not.toContain(
    adminSideCase.sourceCaseId,
  );
  const requestsBefore = recorded.requests.length;
  const message = await post(admin, paths.chat, {
    kind: "message",
    conversationId: adminSide,
    requestId: `request_${adminSide}_after_move`,
    model: route.model,
    text: "Telephone again tomorrow.",
    browserContext: { kind: "unavailable" },
  });
  expect(message.status).toBe(403);
  const otherStart = await postJson(
    admin,
    startPath(paths.chat, parentId, cardId(cards, PROPOSALS[1].title)),
    {},
  );
  expect(otherStart.status).toBe(404);
  expect(recorded.requests).toHaveLength(requestsBefore);

  // 3. Allowed again: the owner still reads the source chat and starts it.
  const ownerStart = await postJson(
    owner,
    startPath(paths.chat, parentId, cardId(cards, PROPOSALS[1].title)),
    {},
  );
  expect(ownerStart.status, JSON.stringify(ownerStart.body)).toBe(200);
  const ownerSide = conversationIdOf(ownerStart.body);
  await finished(owner, ownerSide);
  expect(await answers(owner, ownerSide)).toEqual([
    SIDE_ANSWERS[PROPOSALS[1].brief],
  ]);
  expect(recorded.sideRequests).toHaveLength(2);
  const states = await proposalStates(owner);
  expect(states).toEqual([
    { title: PROPOSALS[0].title, status: "started" },
    { title: PROPOSALS[1].title, status: "started" },
  ]);
  const ownerSideCase = await startedSideCase(owner, PROPOSALS[1].title);
  const ownerEvents = await timelineOf(owner);
  expect(
    ownerEvents.find((event) => event.caseId === ownerSideCase.caseId),
  ).toMatchObject({
    title: PROPOSALS[1].title,
    sideCaseOf: ownerSideCase.sourceCaseId,
  });

  task.meta.chatSideCaseFlow = {
    modelRequests: recorded.requests.length,
    sideCaseFirstRequest: recorded.sideRequests[0],
    adminCards: cards,
    adminSideCaseBeforeMove: opened.status,
    adminLaunchReadAfterMove: launchRead.status,
    adminSideCaseAfterMove: closed,
    adminMessageAfterMove: message.status,
    adminOtherStartAfterMove: otherStart,
    ownerStartAfterMove: ownerStart,
    proposals: states,
    adminTimelineBeforeMove: adminBefore,
    adminTimelineAfterMove: adminAfter,
    ownerTimeline: ownerEvents,
  };
}

/** The day's Activity timeline, as one person reads it. */
async function timelineOf(
  person: Member,
): Promise<readonly CaseTimelineCase[]> {
  const read = await readCaseTimeline(person.organisationId, person.session, {
    from: Date.now() - 3_600_000,
    to: Date.now() + 60_000,
  });
  expect(read.status).toBe(200);
  return read.timeline?.cases ?? [];
}

/** The source turn proposes two side Cases; each side Case answers its brief. */
async function replyToModel(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  recorded.requests.push(body);
  const id = `side_case_flow_${String(recorded.requests.length)}`;
  const current = currentRequest(body);
  for (const proposal of PROPOSALS)
    if (current.includes(proposal.brief)) {
      recorded.sideRequests.push(body);
      return reply(SIDE_ANSWERS[proposal.brief] ?? "", id);
    }
  if (!current.includes(QUESTION)) throw new Error("Unexpected model request");
  const calls = toolCalls(body);
  const next = PROPOSALS[calls.filter(isProposal).length];
  if (next === undefined) return reply(ANSWER, id);
  // A large catalogue offers the tool after a search, as a real model sees it.
  if (
    !offeredToolNames(body).includes("propose_side_case") &&
    calls.at(-1) !== "tool_search"
  )
    return openRouterToolCall(
      "tool_search",
      { query: "propose_side_case" },
      `call_${id}`,
    );
  return openRouterToolCall("propose_side_case", next, `call_${id}`);
}

function isProposal(name: string): boolean {
  return name === "propose_side_case";
}

function reply(text: string, id: string): Response {
  return openRouterText(JSON.stringify({ kind: "reply", text }), id);
}

/** The tools that this turn called, in order. */
function toolCalls(body: Record<string, unknown>): string[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const names: string[] = [];
  for (const message of messages)
    if (isRecord(message) && Array.isArray(message.tool_calls))
      for (const call of message.tool_calls)
        if (
          isRecord(call) &&
          isRecord(call.function) &&
          typeof call.function.name === "string"
        )
          names.push(call.function.name);
  return names;
}

async function readCards(
  person: Member,
  chatPath: string,
  conversationId: ConversationId,
): Promise<readonly Record<string, unknown>[]> {
  const read = await postJson(
    person,
    `${chatPath}?conversation=${conversationId}`,
    null,
  );
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  if (!isRecord(read.body) || !Array.isArray(read.body.sideCases))
    throw new Error("Chat read invalid");
  return read.body.sideCases.filter(isRecord);
}

function cardSummary(card: Record<string, unknown>): Record<string, unknown> {
  const state = isRecord(card.state) ? card.state : {};
  return { title: card.title, state: state.kind, mayDecide: state.mayDecide };
}

function startPath(
  chatPath: string,
  conversationId: ConversationId,
  proposalId: string,
): string {
  return `${chatPath}/conversations/${conversationId}/side-cases/${proposalId}/start`;
}

function conversationIdOf(body: unknown): ConversationId {
  if (!isRecord(body) || !isConversationId(body.conversationId))
    throw new Error("Start answer invalid");
  return body.conversationId;
}

/**
 * Shares a private chat into a shared Project, or moves a shared chat to
 * another one, as the Portal dialog does.
 */
async function shareChat(
  person: Member,
  chatPath: string,
  conversationId: ConversationId,
  projectId: string,
  kind: "share_conversation" | "move_shared_conversation",
): Promise<Readonly<{ status: number; body: unknown }>> {
  const accessPath = `${chatPath}/conversations/${conversationId}/access`;
  const details = await postJson(
    person,
    `${accessPath}?${new URLSearchParams({ project: projectId })}`,
    null,
  );
  if (
    !isRecord(details.body) ||
    typeof details.body.revision !== "number" ||
    !isRecord(details.body.project) ||
    !isRecord(details.body.project.access) ||
    typeof details.body.project.access.accessRevision !== "number"
  )
    throw new Error(`Chat access invalid: ${JSON.stringify(details.body)}`);
  return postJson(person, accessPath, {
    kind,
    operationId: crypto.randomUUID(),
    projectId,
    expectedRevision: details.body.revision,
    expectedProjectAccessRevision: details.body.project.access.accessRevision,
  });
}

async function proposalStates(
  person: Member,
): Promise<readonly Readonly<{ title: string; status: string }>[]> {
  const scope = await requireOrganisationExecutionScope(
    env,
    person.organisationId,
  );
  const rows = await scope.database
    .prepare(
      "SELECT title, status FROM side_case_proposal WHERE organisation_id = ? ORDER BY created_at, title",
    )
    .bind(person.organisationId)
    .all<{ title: string; status: string }>();
  return rows.results;
}

/** A started side Case and the Case that proposed it, as the store records them. */
async function startedSideCase(
  person: Member,
  title: string,
): Promise<Readonly<{ caseId: string; sourceCaseId: string }>> {
  const scope = await requireOrganisationExecutionScope(
    env,
    person.organisationId,
  );
  const row = await scope.database
    .prepare(
      "SELECT destination_case_id, source_case_id FROM side_case_proposal WHERE organisation_id = ? AND title = ? AND destination_case_id IS NOT NULL",
    )
    .bind(person.organisationId, title)
    .first<{ destination_case_id: string; source_case_id: string }>();
  if (row === null) throw new Error(`Side Case missing: ${title}`);
  return { caseId: row.destination_case_id, sourceCaseId: row.source_case_id };
}
