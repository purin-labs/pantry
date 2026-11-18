// Plan 87 J4: the Kitchen sends its current view on the v2 screen
// envelope. The view is the observation's state, the server makes the view
// that the model reads, a message keeps one screen part, and a chat stored
// with an old Kitchen part still opens and continues.
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  newProjectId,
  type ConversationId,
  type SurfaceObservationV2,
} from "@seams/control-api";
import type {
  BakerySurfaceAttachmentV1,
  BakerySurfaceContextV1,
} from "@seams/bakery-model/bakery-surface";
import { isRecord } from "@seams/std";
import { env } from "cloudflare:workers";

import { captureBakerySurface } from "../../../../apps/portal/src/features/workflow-simulator/bakery-surface";
import { initialSimulatorState } from "../../../../apps/portal/src/features/workflow-simulator/simulator-state";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { answers } from "./chat-permission-support";
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
    chatKitchenObservation?: Record<string, unknown>;
  }
}

const BROWSER = "browser-j4";

/**
 * Plan 87 J4. A Kitchen message carries one observation whose state is the
 * Kitchen's current view, captured by the Portal's own Kitchen code. The
 * model reads the Kitchen view and a short page summary that the server
 * made from that state. A state that names another surface session is
 * refused. A tab that loaded the Portal before phase 2 still sends its
 * Kitchen view in the old key, and it joins the page's observation. A chat
 * stored with an old Kitchen part opens, names the page, and continues. A
 * chat shared with a Project leaves the Kitchen out, as every page that not
 * every member may open.
 */
it(
  "carries the Satyr Kitchen view on the v2 screen envelope, and reads old Kitchen parts as v2",
  { timeout: 300_000 },
  async ({ task }: TestContext): Promise<void> => {
    const { author, reviewer, route, paths } = await installMemoryFixture();
    const requests: string[] = [];
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        recordAndReply.bind(null, requests),
      ),
    );
    const kitchen = await captureBakerySurface(initialSimulatorState("closed"));
    const context = kitchen.context;

    // A new tab on the Kitchen, with the chip on.
    const privateChat = newConversationId();
    await createConversation(author, privateChat, route);
    const sent = await send(author, paths.chat, privateChat, route.model, {
      label: "kitchen",
      text: "What is selected in the Kitchen?",
      surfaceObservation: kitchenObservation(context, privateChat),
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    await finish(author, privateChat);
    const privateInput = latestUserInput(requests);
    expect(privateInput).toContain(
      "The current request carries Workflow simulator from the operator's screen",
    );
    expect(privateInput).toContain("Kitchen view");
    expect(privateInput).toContain("Open view");
    // The Kitchen block reads the state, with the digest that the server made.
    expect(privateInput).toContain(context.surfaceSessionId);
    expect(privateInput).toContain(kitchen.digest);
    const storedPrivate = await latestUserParts(author, privateChat);
    expect(screenPartKinds(storedPrivate)).toEqual(["surface_observation"]);
    const storedObservation = storedPrivate.find(isObservationPart);
    expect(storedObservation?.observation.state).toEqual(context);
    expect(storedObservation?.observation.view[0]?.title).toBe("Kitchen view");
    // The observation lists what the agent may do on the Kitchen now.
    expect(storedObservation?.observation.commands).toEqual(
      context.supportedCommands,
    );
    const privateRead = await readChat(author, paths.chat, privateChat);
    expect(userScreenParts(privateRead)).toEqual([
      {
        kind: "screen",
        area: "BakeryOS",
        title: "Workflow simulator",
        record: null,
      },
    ]);
    expect(privateRead.conversation.origin).toMatchObject({
      area: "BakeryOS",
      page: "workflow-simulator",
    });

    // A state that names another surface session than the message.
    const mismatched = await send(
      author,
      paths.chat,
      privateChat,
      route.model,
      {
        label: "mismatch",
        text: "And now?",
        surfaceObservation: {
          ...kitchenObservation(context, privateChat),
          instance: {
            browserInstanceId: BROWSER,
            surfaceSessionId: "another-session",
            epoch: context.surfaceEpoch,
          },
        },
      },
    );
    expect(mismatched.status).toBe(422);
    const notKitchen = await send(
      author,
      paths.chat,
      privateChat,
      route.model,
      {
        label: "not-kitchen",
        text: "And now?",
        surfaceObservation: {
          ...kitchenObservation(context, privateChat),
          state: { kind: "bakery-workspace", schemaVersion: 1 },
        },
      },
    );
    expect(notKitchen.status).toBe(422);

    // A tab that loaded the Portal before phase 2.
    const oldTab = await send(author, paths.chat, privateChat, route.model, {
      label: "old-tab",
      text: "Which run is open in the Kitchen?",
      surfaceObservation: {
        ...kitchenObservation(context, privateChat),
        state: null,
      },
      surfaceContext: kitchen,
    });
    expect(oldTab.status, await oldTab.clone().text()).toBe(200);
    await finish(author, privateChat);
    const oldTabInput = latestUserInput(requests);
    expect(oldTabInput).toContain(context.surfaceSessionId);
    expect(oldTabInput).toContain("Kitchen view");
    const oldTabParts = await latestUserParts(author, privateChat);
    expect(screenPartKinds(oldTabParts)).toEqual(["surface_observation"]);
    expect(oldTabParts.find(isObservationPart)?.observation.state).toEqual(
      context,
    );

    // A chat stored before phase 2, with its Kitchen view in its own part.
    const storedChat = newConversationId();
    await createConversation(author, storedChat, route);
    const first = await send(author, paths.chat, storedChat, route.model, {
      label: "stored",
      text: "Look at my Kitchen.",
      surfaceObservation: kitchenObservation(context, storedChat),
    });
    expect(first.status, await first.clone().text()).toBe(200);
    await finish(author, storedChat);
    await storeAsBeforePhaseTwo(author, storedChat, kitchen);
    const reopened = await readChat(author, paths.chat, storedChat);
    expect(userScreenParts(reopened)).toEqual([
      {
        kind: "screen",
        area: "BakeryOS",
        title: "Workflow simulator",
        record: null,
      },
    ]);
    const reopenedParts = await latestUserParts(author, storedChat);
    expect(screenPartKinds(reopenedParts)).toEqual(["surface_observation"]);
    expect(reopenedParts.find(isObservationPart)?.observation.state).toEqual(
      context,
    );
    const continued = await send(author, paths.chat, storedChat, route.model, {
      label: "continued",
      text: "And what comes next?",
    });
    expect(continued.status, await continued.clone().text()).toBe(200);
    await finish(author, storedChat);
    const continuedInput = latestUserInput(requests);
    expect(continuedInput).toContain("And what comes next?");
    expect(continuedInput).toContain(
      "The current request carries no page from the operator's screen",
    );
    expect(await answers(author, storedChat)).toHaveLength(2);

    // A chat shared with a Project: the Kitchen is not on the shared list.
    const shared = await sharedConversation(
      author,
      route,
      paths.projects,
      reviewer,
    );
    const sharedSend = await send(author, paths.chat, shared, route.model, {
      label: "shared",
      text: "What does my Kitchen show?",
      surfaceObservation: kitchenObservation(context, shared),
    });
    expect(sharedSend.status, await sharedSend.clone().text()).toBe(200);
    await finish(author, shared);
    const sharedInput = latestUserInput(requests);
    expect(sharedInput).toContain("What does my Kitchen show?");
    expect(sharedInput).toContain(
      "The current request carries no page from the operator's screen",
    );
    expect(sharedInput).not.toContain(context.surfaceSessionId);
    expect(screenPartKinds(await latestUserParts(author, shared))).toEqual([]);

    task.meta.chatKitchenObservation = {
      kitchenState: context,
      privateChatModelInput: privateInput,
      storedPrivateObservation: storedObservation?.observation ?? null,
      mismatchedSessionStatus: mismatched.status,
      notKitchenStateStatus: notKitchen.status,
      oldTabModelInput: oldTabInput,
      reopenedScreenParts: userScreenParts(reopened),
      continuedModelInput: continuedInput,
      sharedChatModelInput: sharedInput,
    };
  },
);

/** The Kitchen page as a new tab sends it: the state, and no view. */
function kitchenObservation(
  context: BakerySurfaceContextV1,
  conversationId: ConversationId,
): SurfaceObservationV2 {
  return {
    kind: "surface-observation",
    schemaVersion: 2,
    surface: "workflow-simulator",
    area: "BakeryOS",
    instance: {
      browserInstanceId: BROWSER,
      surfaceSessionId: context.surfaceSessionId,
      epoch: context.surfaceEpoch,
    },
    title: "Workflow simulator",
    path: `/portal/nuki/shop/workflow-simulator#${conversationId}`,
    record: null,
    capturedAt: context.capturedAt,
    view: [],
    state: context,
    commands: [],
    sources: [],
  };
}

/**
 * Rewrites the stored chat as a server before phase 2 kept it: the Kitchen
 * view in a `surface` part of its own, and no screen observation.
 */
async function storeAsBeforePhaseTwo(
  author: Member,
  conversationId: ConversationId,
  kitchen: BakerySurfaceAttachmentV1,
): Promise<void> {
  const scope = await requireOrganisationExecutionScope(
    env,
    author.organisationId,
  );
  const row = await scope.database
    .prepare(
      "SELECT state_json FROM portal_conversation WHERE organisation_id = ? AND user_id = ? AND conversation_id = ?",
    )
    .bind(author.organisationId, author.userId, conversationId)
    .first<{ state_json: string }>();
  if (row === null) throw new Error("The stored chat is missing");
  const state: unknown = JSON.parse(row.state_json);
  if (!isRecord(state) || !Array.isArray(state.timeline))
    throw new Error("The stored chat has no timeline");
  const timeline = state.timeline.map(function oldParts(event: unknown) {
    if (
      !isRecord(event) ||
      event.kind !== "user" ||
      !Array.isArray(event.parts)
    )
      return event;
    return {
      ...event,
      parts: event.parts.flatMap((part: unknown) =>
        isRecord(part) && part.kind === "surface_observation"
          ? [{ kind: "surface", surface: kitchen }]
          : [part],
      ),
    };
  });
  await scope.database
    .prepare(
      "UPDATE portal_conversation SET state_json = ? WHERE organisation_id = ? AND user_id = ? AND conversation_id = ?",
    )
    .bind(
      JSON.stringify({ ...state, timeline }),
      author.organisationId,
      author.userId,
      conversationId,
    )
    .run();
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
    content: { name: "Kitchen review", brief: "", references: [] },
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

function send(
  author: Member,
  chatPath: string,
  conversationId: ConversationId,
  model: string,
  message: Readonly<{
    label: string;
    text: string;
    surfaceObservation?: unknown;
    surfaceContext?: BakerySurfaceAttachmentV1;
  }>,
): Promise<Response> {
  return post(author, chatPath, {
    kind: "message",
    conversationId,
    requestId: `request_${conversationId}_${message.label}`,
    model,
    text: message.text,
    browserContext: {
      kind: "available",
      binding: { browserInstanceId: BROWSER, conversationId },
    },
    ...(message.surfaceObservation === undefined
      ? {}
      : { surfaceObservation: message.surfaceObservation }),
    ...(message.surfaceContext === undefined
      ? {}
      : { surfaceContext: message.surfaceContext }),
  });
}

async function finish(
  author: Member,
  conversationId: ConversationId,
): Promise<void> {
  await expect
    .poll(workKind.bind(null, author, conversationId), { timeout: 60_000 })
    .toBe("ready");
}

type StoredParts = NonNullable<Awaited<ReturnType<typeof latestUserParts>>>;
type ObservationPart = Extract<
  StoredParts[number],
  { readonly kind: "surface_observation" }
>;

async function latestUserParts(author: Member, conversationId: ConversationId) {
  const stored = await storedConversation(author, conversationId);
  const message = stored?.conversation.timeline.findLast(
    (event) => event.kind === "user",
  );
  return message?.kind === "user" ? message.parts : [];
}

/** The kinds of the parts that hold a page or a Kitchen view. */
function screenPartKinds(parts: StoredParts): readonly string[] {
  return parts
    .map((part) => part.kind as string)
    .filter((kind) => kind === "surface" || kind === "surface_observation");
}

function isObservationPart(part: StoredParts[number]): part is ObservationPart {
  return part.kind === "surface_observation";
}

type ChatRead = Readonly<{ conversation: Record<string, unknown> }>;

async function readChat(
  member: Member,
  chatPath: string,
  conversationId: ConversationId,
): Promise<ChatRead> {
  const response = await post(
    member,
    `${chatPath}?conversation=${conversationId}`,
    null,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body) || !isRecord(body.conversation))
    throw new Error("The chat read has no conversation");
  return { conversation: body.conversation };
}

function userScreenParts(read: ChatRead): readonly unknown[] {
  const timeline = Array.isArray(read.conversation.timeline)
    ? read.conversation.timeline
    : [];
  return timeline.flatMap((event: unknown) =>
    isRecord(event) && event.kind === "user" && Array.isArray(event.parts)
      ? event.parts.filter(
          (part: unknown) => isRecord(part) && part.kind === "screen",
        )
      : [],
  );
}

async function recordAndReply(
  requests: string[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  requests.push(JSON.stringify(body));
  return openRouterText(
    "Your Kitchen shows the shift.",
    `kitchen_${String(requests.length)}`,
  );
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
