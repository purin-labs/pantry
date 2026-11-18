import { http, type HttpResponseResolver } from "msw";
import { fixtureDatabase } from "./organisation-database";
import { expect, it, type TestContext } from "vitest";
import { newConversationId, type ConversationId } from "@seams/control-api";
import { isRecord } from "@seams/std";

import { connectCommerceFixture } from "./commerce-support";
import { openSocket } from "./hibernatable-socket-support";
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
import { allowAsPortal } from "./permission-request-support";
import {
  LOCATION,
  PRODUCTION,
  PlanJourney,
  PlanRoomClient,
} from "./production-plan-support";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    productionPlanSharedLater?: Record<string, unknown>;
  }
}

/**
 * Plan 40D Phase B2, in the order an owner meets it. The owner asks a new,
 * private chat to plan the café. The agent asks for the read and the plan
 * edit, the owner allows them, and the agent reads the plan; its edit is
 * refused, because the chat is not shared with the plan. The owner then
 * shares the chat in a Project and with the plan, and asks again in the same
 * chat. The edit must now land with the agent's named cursor: the chat's
 * private first turn may not keep it from editing the plan.
 */
it(
  "lets the agent edit the plan in a chat that was private for its first turn and was shared with the plan afterwards",
  { timeout: 240_000 },
  sharedLaterJourney,
);

const MERCHANT_ID = "merchant_bakery_c3_plan_later";
const FIRST = `Set the first production request at ${LOCATION} to 48.`;
const AGAIN = "The chat is shared with the plan now. Please try again.";

type Recorded = {
  readonly turns: string[][];
  readonly editOutputs: string[];
  readonly answers: string[];
};

async function sharedLaterJourney({ task }: TestContext): Promise<void> {
  const { author, reviewer, route, paths } = await installMemoryFixture();
  await connectCommerceFixture(
    author.organisationId,
    author.userId,
    MERCHANT_ID,
  );
  const shop = new PlanJourney(
    author.organisationId,
    MERCHANT_ID,
    author.session,
  );
  const provisioned = await shop.native.provisionDemo({
    schemaVersion: "underclerk.provision-demo.v2",
    externalReference: author.organisationId,
    merchantId: MERCHANT_ID,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  expect(provisioned.ok, JSON.stringify(provisioned)).toBe(true);
  await shop.write(PRODUCTION, { kind: "setup" });
  const [first] = await shop.createRequests(1);
  if (first === undefined) throw new Error("Production request missing");
  const page = new PlanRoomClient(
    await openSocket(
      `https://localhost/v1/control/organisations/${author.organisationId}/commerce/inventory/production-plan/${LOCATION}/socket`,
      reviewer.session,
    ),
  );
  expect(await page.sync()).toMatchObject({ access: "edit" });

  const recorded: Recorded = { turns: [], editOutputs: [], answers: [] };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded, first),
    ),
  );
  const conversationId = newConversationId();
  await createConversation(author, conversationId, route);

  // 1. The private chat asks; the owner allows the read and the edit.
  await ask(author, paths.chat, conversationId, route.model, FIRST, "first");
  const pause = await pausedRequest(author, paths.chat, conversationId);
  const allowed = await allowAsPortal(
    author.organisationId,
    author.session,
    pause,
  );
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  const resumed = await postJson(
    author,
    `${paths.chat}/conversations/${conversationId}/permission`,
    { permissionRequestId: pause, decision: "resume" },
  );
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  await expect
    .poll(workKind.bind(null, author, conversationId), { timeout: 60_000 })
    .toBe("ready");
  // The private chat may read the plan but not change it.
  expect(recorded.editOutputs[0]).toContain(
    "not shared with this location's plan",
  );
  expect(await page.lines()).toEqual({});

  // 2. The owner shares the chat in the workspace's Base Project and with
  //    the plan.
  const base = await fixtureDatabase()
    .prepare(
      `SELECT project.project_id AS projectId, project.access_revision AS accessRevision
       FROM organisation_default_project AS d
       JOIN project ON project.organisation_id = d.organisation_id
        AND project.project_id = d.project_id
      WHERE d.organisation_id = ?`,
    )
    .bind(author.organisationId)
    .first<{ projectId: string; accessRevision: number }>();
  if (base === null) throw new Error("Base Project missing");
  const stored = await storedConversation(author, conversationId);
  const chatShared = await postJson(
    author,
    `${paths.chat}/conversations/${conversationId}/access`,
    {
      kind: "share_conversation",
      operationId: crypto.randomUUID(),
      expectedRevision: stored?.revision,
      projectId: base.projectId,
      expectedProjectAccessRevision: base.accessRevision,
    },
  );
  expect(chatShared.body, JSON.stringify(chatShared.body)).toMatchObject({
    kind: "accepted",
  });
  const sharePath = `/v1/control/organisations/${author.organisationId}/commerce/inventory/production-plan/${LOCATION}/share`;
  const planShared = await postJson(author, sharePath, { conversationId });
  expect(planShared).toMatchObject({
    status: 200,
    body: { sharing: { kind: "portal_chat", conversationId } },
  });

  // 3. The owner asks again in the same chat; the edit lands.
  await ask(author, paths.chat, conversationId, route.model, AGAIN, "again");
  await expect
    .poll(workKind.bind(null, author, conversationId), { timeout: 60_000 })
    .toBe("ready");
  await expect
    .poll(() => page.lines(), { message: recorded.editOutputs.join("\n") })
    .toEqual({ [first]: "48" });
  const targets = page.agentFrames.flatMap((frame) =>
    frame.map((activity) => activity.target),
  );
  expect(targets).toContain(first);
  await page.close();

  task.meta.productionPlanSharedLater = {
    location: LOCATION,
    request: first,
    editWhilePrivate: recorded.editOutputs[0],
    planShare: planShared.body,
    editAfterSharing: recorded.editOutputs[1],
    planAfter: { [first]: "48" },
    agentCursorTargets: targets,
  };
}

async function ask(
  person: Member,
  chatPath: string,
  conversationId: ConversationId,
  model: string,
  text: string,
  step: string,
): Promise<void> {
  const started = await post(person, chatPath, {
    kind: "message",
    conversationId,
    requestId: `request_${conversationId}_${step}`,
    model,
    text,
    surfaceContext: null,
    browserContext: { kind: "unavailable" },
  });
  expect(started.status, await started.clone().text()).toBe(200);
}

/**
 * The first turn asks for what it lacks. After the owner allows it, and on
 * the second turn, the agent reads the plan, changes the first line and
 * answers.
 */
async function replyToModel(
  recorded: Recorded,
  requestId: string,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  const offered = offeredToolNames(body);
  const id = `plan_later_${String(Math.random()).slice(2, 10)}`;
  const called = lastCalledTool(body);
  if (called === null) {
    recorded.turns.push(offered);
    if (recorded.turns.length === 1)
      return openRouterToolCall(
        "request_permission",
        {
          capabilityIds: ["commerce.production_plan.edit"],
          entityTypeReads: ["production_requests"],
        },
        `call_${id}`,
      );
    return offered.includes("production_plan_read")
      ? readPlan(id)
      : openRouterToolCall(
          "tool_search",
          { query: "production_plan_read production_plan_edit" },
          `call_${id}`,
        );
  }
  const output = requireLastToolOutput(body);
  switch (called) {
    case "request_permission":
      return openRouterText(
        JSON.stringify({ kind: "reply", text: "I asked for permission." }),
        id,
      );
    case "tool_search":
      return readPlan(id);
    case "production_plan_read":
      return openRouterToolCall(
        "production_plan_edit",
        { locationId: LOCATION, requestId, quantity: "48" },
        `call_${id}`,
      );
    case "production_plan_edit":
      recorded.editOutputs.push(output);
      return openRouterText(
        JSON.stringify({ kind: "reply", text: "Done." }),
        id,
      );
    default:
      throw new Error(`Unexpected tool ${called}: ${output}`);
  }
}

function readPlan(id: string): Response | Promise<Response> {
  return openRouterToolCall(
    "production_plan_read",
    { locationId: LOCATION },
    `call_${id}`,
  );
}

/** The tool of the latest call, when the latest message is its output. */
function lastCalledTool(body: Record<string, unknown>): string | null {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last: unknown = messages.at(-1);
  if (!isRecord(last) || last.role !== "tool") return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (
      isRecord(message) &&
      message.role === "assistant" &&
      Array.isArray(message.tool_calls)
    ) {
      const call: unknown = message.tool_calls.at(-1);
      return isRecord(call) &&
        isRecord(call.function) &&
        typeof call.function.name === "string"
        ? call.function.name
        : null;
    }
  }
  return null;
}

async function pausedRequest(
  person: Member,
  chatPath: string,
  conversationId: ConversationId,
): Promise<string> {
  const read = async (): Promise<string> => {
    const query = new URLSearchParams({
      conversation: conversationId,
      view: "state",
    });
    const state = await postJson(person, `${chatPath}?${query}`, null);
    const work = isRecord(state.body) ? state.body.work : null;
    return isRecord(work) &&
      work.kind === "awaiting_permission" &&
      isRecord(work.permission) &&
      typeof work.permission.permissionRequestId === "string"
      ? work.permission.permissionRequestId
      : "";
  };
  await expect.poll(read, { timeout: 60_000 }).not.toBe("");
  return read();
}
