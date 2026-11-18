import { expect, it, type TestContext } from "vitest";
import { http, type HttpResponseResolver } from "msw";
import {
  newConversationId,
  newProjectId,
  type ConversationId,
  type MemoryView,
} from "@seams/control-api";
import { isRecord } from "@seams/std";
import {
  conversationCaseId,
  initialConversationCaseIdentity,
} from "../../src/chat/conversation-actor-identity";
import { openNodes, readCaseExecution } from "./case-execution-support";
import {
  brainSummary,
  caseEntry,
  command,
  createConversation,
  installMemoryFixture,
  list,
  post,
  postJson,
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

const PRIVATE_FACT = "The shop closes at 18:00 on Sundays.";
const SHARED_FACT = "Wholesale orders need two days of notice.";
const VIEWER_FACT = "The viewer wants a rule that no one reviewed.";
const QUESTION = "When does the shop close this week?";
const TEACH = "Remember: ";

it(
  "lets a person teach the agent a rule in a Portal chat, and uses it in later chats only where each reader may read it",
  { timeout: 240_000 },
  memoryTeachingJourney,
);

type ModelRequest = Readonly<{
  /** The request that this turn was given, after its history. */
  current: string;
  /** Everything that the model was sent. */
  text: string;
  offered: readonly string[];
  toolOutputs: readonly string[];
}>;

/**
 * A model that teaches when the current request starts with "Remember:". It
 * finds the proposal tool, calls it two times with the same words, and then
 * replies. For any other request it replies at once.
 */
class TeachingModel {
  readonly requests: ModelRequest[] = [];

  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const body: unknown = await request.clone().json();
    if (!isRecord(body) || !Array.isArray(body.messages))
      throw new Error("model request is invalid");
    const text = JSON.stringify(body.messages);
    const from = text.lastIndexOf("Current user request");
    const current = from < 0 ? "" : text.slice(from);
    const offered = offeredToolNames(body);
    const toolOutputs = body.messages.flatMap((message) =>
      isRecord(message) && message.role === "tool"
        ? [JSON.stringify(message.content)]
        : [],
    );
    const calls = body.messages.flatMap((message) =>
      isRecord(message) && Array.isArray(message.tool_calls)
        ? message.tool_calls.flatMap((call) =>
            isRecord(call) &&
            isRecord(call.function) &&
            typeof call.function.name === "string"
              ? [call.function.name]
              : [],
          )
        : [],
    );
    this.requests.push({ current, text, offered, toolOutputs });
    const id = `teaching_${String(this.requests.length)}`;
    const taught = [PRIVATE_FACT, SHARED_FACT, VIEWER_FACT].find((fact) =>
      current.includes(`${TEACH}${fact}`),
    );
    if (taught === undefined)
      return openRouterText(
        JSON.stringify({ kind: "reply", text: "Answered." }),
        id,
      );
    const proposals = calls.filter((name) => name === "propose_memory").length;
    if (proposals >= 2)
      return openRouterText(
        JSON.stringify({ kind: "reply", text: "It waits for your review." }),
        id,
      );
    // The tool is found first when the turn does not offer it at once.
    if (
      proposals === 0 &&
      !offered.includes("propose_memory") &&
      !calls.includes("tool_search")
    )
      return openRouterToolCall(
        "tool_search",
        { query: "propose_memory", limit: 1 },
        id,
      );
    return openRouterToolCall(
      "propose_memory",
      { statement: taught, kind: "fact" },
      id,
    );
  }
}

type Person = Member;

async function memoryTeachingJourney({ task }: TestContext): Promise<void> {
  // The owner, a second administrator and a viewer of an Organisation that
  // the shared account authority knows. Each control request passes the real
  // account check.
  const { organisationId, author, reviewer, viewer, route, paths } =
    await installMemoryFixture();
  const { chat: CHAT, projects: PROJECTS } = paths;
  const model = new TeachingModel();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
  );

  const message = (
    person: Person,
    conversationId: ConversationId,
    requestId: string,
    text: string,
    modelName: string = route.model,
  ): Promise<Response> =>
    post(person, CHAT, {
      kind: "message",
      conversationId,
      requestId,
      model: modelName,
      text,
      surfaceContext: null,
      browserContext: { kind: "unavailable" },
    });
  /** Sends one message and returns what the model was sent for that turn. */
  const say = async (
    person: Person,
    conversationId: ConversationId,
    requestId: string,
    text: string,
  ): Promise<readonly ModelRequest[]> => {
    const before = model.requests.length;
    const started = await message(person, conversationId, requestId, text);
    expect(started.status, await started.clone().text()).toBe(200);
    try {
      await expect
        .poll(workKind.bind(null, person, conversationId), {
          timeout: 30_000,
        })
        .toBe("ready");
    } catch {
      const failed = await storedConversation(person, conversationId);
      throw new Error(
        JSON.stringify({
          requestId,
          work: failed?.conversation.work,
          lastEvent: failed?.conversation.timeline.at(-1),
          requests: model.requests.slice(before).map((entry) => ({
            offered: entry.offered,
            toolOutputs: entry.toolOutputs,
          })),
        }),
      );
    }
    return model.requests.slice(before);
  };
  const open = async (person: Person): Promise<ConversationId> => {
    const conversationId = newConversationId();
    await createConversation(person, conversationId, route);
    return conversationId;
  };
  const caseIdOf = (person: Person, conversationId: ConversationId) =>
    conversationCaseId(
      initialConversationCaseIdentity(
        { organisationId, userId: person.userId },
        conversationId,
      ),
    );
  /** The Case entry that holds one message, as a Memory cites it. */
  const instructionEntry = async (
    person: Person,
    conversationId: ConversationId,
    text: string,
  ) =>
    (await caseEntry(person, conversationId, text, "operator_instruction"))
      .evidence;
  /** The Memory result that each turn of one conversation recorded. */
  const turnMemory = async (person: Person, conversationId: ConversationId) => {
    const execution = await readCaseExecution(
      organisationId,
      person.session,
      await caseIdOf(person, conversationId),
      100,
    );
    return openNodes(execution, "turn").map((turn) => turn.memory);
  };
  /**
   * Asks one question and returns what the turn was sent and its Memory
   * result. The Memory read of a chat turn stops at 250 ms. On a slow
   * machine a turn can end with no answer from that read. Such a turn says
   * so, and the question is asked again.
   */
  const ask = async (
    person: Person,
    requestId: string,
    chat: ConversationId | null = null,
  ) => {
    for (let attempt = 0; ; attempt += 1) {
      const conversationId = chat ?? (await open(person));
      const requests = await say(
        person,
        conversationId,
        `${requestId}_${String(attempt)}`,
        QUESTION,
      );
      const memory = (await turnMemory(person, conversationId)).at(-1);
      if (memory === undefined) throw new Error("the turn has no record");
      if (memory.kind !== "unavailable" || attempt === 3)
        return { conversationId, requests, memory };
    }
  };
  const proposalOutputs = (requests: readonly ModelRequest[]) =>
    requests
      .at(-1)
      ?.toolOutputs.filter((output) => output.includes("memory_")) ?? [];
  const only = (memories: readonly MemoryView[]): MemoryView => {
    const [first] = memories;
    if (first === undefined || memories.length !== 1)
      throw new Error(`expected one memory: ${JSON.stringify(memories)}`);
    return first;
  };

  // 1. The author teaches a rule in a private chat. The agent proposes one
  // Memory. The second call with the same words makes no second Memory.
  const emptySummary = (await brainSummary(author)).text;
  const taught = await open(author);
  const teaching = await say(
    author,
    taught,
    "teach_private",
    `${TEACH}${PRIVATE_FACT}`,
  );
  expect(proposalOutputs(teaching)).toHaveLength(2);
  for (const output of proposalOutputs(teaching)) {
    expect(output).toContain("memory_proposed");
    expect(output).toContain("waiting_for_review");
  }
  const candidate = only(await list(author));
  const instruction = await instructionEntry(author, taught, PRIVATE_FACT);
  expect(candidate.headRevision).toBe(1);
  expect(candidate.revisions[0]).toMatchObject({
    kind: "candidate",
    memoryKind: "fact",
    statement: PRIVATE_FACT,
    applicability: { kind: "portal_chat" },
    proposedBy: { kind: "agent", caseId: instruction.caseId },
    // The platform cites the message that started the turn. The agent
    // named no evidence.
    evidence: [instruction],
    validity: { dependsOn: [instruction] },
    sourceCaseId: instruction.caseId,
  });
  expect(instruction.entryId.startsWith("trigger:")).toBe(true);
  expect((await brainSummary(author)).summary.memoriesToReview).toBe(1);

  // Denied: another administrator does not read the private chat. They see
  // no Memory, and their summary is that of an organisation with none.
  expect(await list(reviewer)).toHaveLength(0);
  expect((await brainSummary(reviewer)).text).toBe(emptySummary);
  const stolen = await command(reviewer, {
    commandId: "memory_teaching_other_accept",
    expectedRevision: 1,
    kind: "accept",
    memoryId: candidate.memoryId,
    revision: 1,
  });
  expect(stolen.status).not.toBe(200);

  // 2. A candidate is not in use: a later chat of the author is not shown it.
  const early = await ask(author, "ask_before");
  expect(
    early.requests.some((entry) => entry.text.includes(PRIVATE_FACT)),
  ).toBe(false);
  expect(early.memory).toEqual({ kind: "none" });

  // 3. The author accepts it.
  expect(
    await command(author, {
      commandId: "memory_teaching_accept",
      expectedRevision: 1,
      kind: "accept",
      memoryId: candidate.memoryId,
      revision: 1,
    }),
  ).toMatchObject({ status: 200 });

  // 4. Allowed: a new private chat of the author is shown the rule, and the
  // turn records one revision.
  const later = await ask(author, "ask_after");
  expect(
    later.requests.every((entry) => entry.text.includes(PRIVATE_FACT)),
  ).toBe(true);
  expect(later.memory).toEqual({ kind: "admitted", revisions: 1 });

  // 5. Denied: the reviewer's own chat is not shown the author's rule.
  const reviewerOwn = await ask(reviewer, "ask_reviewer");
  expect(
    reviewerOwn.requests.some((entry) => entry.text.includes(PRIVATE_FACT)),
  ).toBe(false);
  expect(reviewerOwn.memory).toEqual({ kind: "none" });

  // 6. Denied: a chat that the author shares with the reviewer is not shown
  // the rule, because its reply reaches a person who may not read it.
  const projectId = newProjectId();
  expect(
    await postJson(author, PROJECTS, {
      kind: "create_project",
      operationId: crypto.randomUUID(),
      projectId,
      content: {
        name: "Wholesale",
        brief: "Notes on wholesale orders.",
        references: [],
      },
    }),
  ).toMatchObject({ status: 200 });
  expect(
    await postJson(author, `${PROJECTS}/${projectId}/access`, {
      kind: "share_project",
      operationId: crypto.randomUUID(),
      expectedAccessRevision: 0,
      members: [{ userId: reviewer.userId, role: "editor" }],
    }),
  ).toMatchObject({ status: 200 });
  const shared = await open(author);
  const unshared = await storedConversation(author, shared);
  if (unshared === null) throw new Error("conversation missing");
  expect(
    await postJson(author, `${CHAT}/conversations/${shared}/access`, {
      kind: "share_conversation",
      operationId: crypto.randomUUID(),
      expectedRevision: unshared.revision,
      projectId,
      expectedProjectAccessRevision: 1,
    }),
  ).toMatchObject({ status: 200, body: { kind: "accepted" } });
  const sharedAsk = await ask(author, "ask_shared", shared);
  expect(
    sharedAsk.requests.some((entry) => entry.text.includes(PRIVATE_FACT)),
  ).toBe(false);
  expect(sharedAsk.memory).toEqual({ kind: "none" });

  // 7. The author teaches a second rule in the shared chat. Both people may
  // review it. The reviewer accepts it.
  const sharedTeaching = await say(
    author,
    shared,
    "teach_shared",
    `${TEACH}${SHARED_FACT}`,
  );
  expect(proposalOutputs(sharedTeaching)).toHaveLength(2);
  const forReviewer = only(await list(reviewer));
  expect(forReviewer.revisions[0]).toMatchObject({
    kind: "candidate",
    statement: SHARED_FACT,
    applicability: { kind: "portal_chat" },
  });
  expect(await list(author)).toHaveLength(2);
  expect((await brainSummary(reviewer)).summary.memoriesToReview).toBe(1);
  expect(
    await command(reviewer, {
      commandId: "memory_teaching_shared_accept",
      expectedRevision: 1,
      kind: "accept",
      memoryId: forReviewer.memoryId,
      revision: 1,
    }),
  ).toMatchObject({ status: 200 });

  // Allowed: the reviewer's own chat is now shown the shared rule only.
  const reviewerLater = await ask(reviewer, "ask_reviewer_after");
  expect(
    reviewerLater.requests.every((entry) => entry.text.includes(SHARED_FACT)),
  ).toBe(true);
  expect(
    reviewerLater.requests.some((entry) => entry.text.includes(PRIVATE_FACT)),
  ).toBe(false);
  expect(reviewerLater.memory).toEqual({ kind: "admitted", revisions: 1 });
  // Allowed: a private chat of the author is shown both rules.
  const authorLater = await ask(author, "ask_author_after");
  expect(
    authorLater.requests.every(
      (entry) =>
        entry.text.includes(PRIVATE_FACT) && entry.text.includes(SHARED_FACT),
    ),
  ).toBe(true);
  expect(authorLater.memory).toEqual({ kind: "admitted", revisions: 2 });

  // 8. Denied: a person below the admin role has no Portal chat, so no turn
  // of theirs can propose a Memory. The route answers as for a missing page.
  const viewerChat = await open(viewer);
  const refused = await message(
    viewer,
    viewerChat,
    "teach_viewer",
    `${TEACH}${VIEWER_FACT}`,
  );
  expect(refused.status).toBe(404);
  expect(model.requests.some((entry) => entry.text.includes(VIEWER_FACT))).toBe(
    false,
  );
  expect(await list(author)).toHaveLength(2);
  expect(await list(reviewer)).toHaveLength(1);

  Object.assign(task.meta, {
    memoryTeaching: {
      privateMemory: {
        memoryId: candidate.memoryId,
        evidence: instruction,
        proposalOutputs: proposalOutputs(teaching),
      },
      sharedMemory: { memoryId: forReviewer.memoryId },
      offeredAtFirstRequest: teaching[0]?.offered,
      turnMemory: {
        authorBeforeAcceptance: early.memory,
        authorAfterAcceptance: later.memory,
        reviewerOwnChat: reviewerOwn.memory,
        sharedChat: sharedAsk.memory,
        reviewerAfterSharedRule: reviewerLater.memory,
        authorWithBothRules: authorLater.memory,
      },
      viewerChatStatus: refused.status,
    },
  });
}
