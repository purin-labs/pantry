// Plan 87 J4: the Kitchen sends its current view on the v2 screen
// envelope. The view is the observation's state, the server makes the view
// that the model reads, and a message keeps one screen part.
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  newProjectId,
  type ConversationId,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import { kitchenObservation } from "../kitchen-observation-fixture";
import { captureBakerySurface } from "@purin-labs/area-kitchen/ui/features/workflow-simulator/bakery-surface";
import { initialSimulatorState } from "@purin-labs/area-kitchen/ui/features/workflow-simulator/simulator-state";
import {
  createConversation,
  installMemoryFixture,
  post,
  storedConversation,
  type Member,
} from "./memory-support";
import { network } from "./network";
import { openRouterText } from "./slack-journey-support";
import {
  finished,
  latestUserInput,
  userScreenParts,
} from "./chat-journey-support";

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
 * refused. A chat shared with a Project leaves the Kitchen out, as every
 * page that not every member may open.
 */
it(
  "carries the Kitchen view on the v2 screen envelope",
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
      surfaceObservation: kitchenObservation(context, BROWSER, privateChat),
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    await finished(author, privateChat);
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
        area: "kitchen",
        title: "Workflow simulator",
        record: null,
      },
    ]);
    expect(privateRead.conversation.origin).toMatchObject({
      area: "kitchen",
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
          ...kitchenObservation(context, BROWSER, privateChat),
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
          ...kitchenObservation(context, BROWSER, privateChat),
          state: { kind: "bakery-workspace", schemaVersion: 1 },
        },
      },
    );
    expect(notKitchen.status).toBe(422);

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
      surfaceObservation: kitchenObservation(context, BROWSER, shared),
    });
    expect(sharedSend.status, await sharedSend.clone().text()).toBe(200);
    await finished(author, shared);
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
      sharedChatModelInput: sharedInput,
    };
  },
);

/** The Kitchen page as a new tab sends it: the state, and no view. */
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
  });
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
