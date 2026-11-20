import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { newConversationId } from "@purin-labs/control-api";
import { parseInventoryProductionPlanResult } from "@purin-labs/kitchen-control-api";
import { isRecord } from "@purin-labs/std";

import {
  answers,
  ask,
  lastCalledTool,
  pausedRequest,
  resumeChat,
} from "./chat-permission-support";
import { connectCommerceFixture } from "./commerce-support";
import { openSocket } from "./hibernatable-socket-support";
import {
  createConversation,
  installMemoryFixture,
  postJson,
  storedConversation,
  workKind,
} from "./memory-support";
import { network } from "./network";
import { fixtureDatabase } from "./organisation-database";
import { allowAsPortal, readRequest } from "./permission-request-support";
import {
  LOCATION,
  PRODUCTION,
  PlanJourney,
  PlanRoomClient,
  planPath,
  readPlan,
} from "./production-plan-support";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    productionPlanAgent?: Record<string, unknown>;
  }
}

/**
 * Plan 40D Phase B2, in the order an owner meets it. The owner asks a new,
 * private chat to plan the café's production. Nobody may read production
 * requests yet, so the agent asks for that read and for the plan edit in one
 * prompt. Every role sees the shared plan, so the prompt asks for the read for
 * each role. While the chat waits, an administrator changes a third line in
 * the shared plan. The owner allows the prompt; the agent reads the plan, and
 * its edit is refused, because the chat is not shared with the plan. A private
 * chat cannot be shared with the plan, so the owner shares the chat in the
 * Base Project and then with the plan, and asks again. The chat's private first
 * turn may not keep it from the plan: the agent changes two lines, and the
 * administrator's page shows the agent's named cursor on each line. The owner
 * then accepts the plan, and Commerce holds every planned quantity.
 */
it(
  "lets a Portal chat agent ask to read production requests, refuses its edit while the chat is private, then plans two lines with its named cursor while a person plans a third, and the owner accepts the result",
  { timeout: 240_000 },
  productionPlanAgentJourney,
);

const MERCHANT_ID = "merchant_bakery_c3_plan_agent";
const QUESTION = `Plan today's production for ${LOCATION}.`;
const AGAIN = "The chat is shared with the plan now. Please plan it again.";
const ASKED = "I asked for permission to plan production.";
const REFUSED = "This chat is not shared with the plan, so I changed nothing.";
const ANSWER = "I planned two lines. Review the plan and accept it.";

type Recorded = {
  readonly requests: Record<string, unknown>[];
  readonly turns: string[][];
  readonly edits: string[];
  readonly editOutputs: string[];
  planRead: string;
};

async function productionPlanAgentJourney({
  task,
}: TestContext): Promise<void> {
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
  const [first, second, third] = await shop.createRequests(3);
  if (first === undefined || second === undefined || third === undefined)
    throw new Error("Production requests missing");
  const opened = await shop.requested();

  // An administrator has the café's plan open.
  const page = new PlanRoomClient(
    await openSocket(
      `https://localhost/v1/control/organisations/${author.organisationId}/commerce/inventory/production-plan/${LOCATION}/socket`,
      reviewer.session,
    ),
  );
  expect(await page.sync()).toMatchObject({ access: "edit" });

  const recorded: Recorded = {
    requests: [],
    turns: [],
    edits: [],
    editOutputs: [],
    planRead: "",
  };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded, [first, second]),
    ),
  );
  const conversationId = newConversationId();
  await createConversation(author, conversationId, route);

  await ask(author, paths.chat, conversationId, route.model, QUESTION, "plan");

  // 1. The private chat asks for the read and the edit in one prompt.
  const pause = await pausedRequest(author, paths.chat, conversationId);
  const request = await readRequest(
    author.organisationId,
    author.session,
    pause.id,
  );
  expect(request).toMatchObject({ status: "pending", origin: "portal_chat" });
  expect(request.items).toEqual(
    expect.arrayContaining([
      ...[
        ["owner", "Owners"],
        ["admin", "Admins"],
        ["operator", "Operators"],
        ["viewer", "Viewers"],
      ].map(([role, subjectLabel]) =>
        expect.objectContaining({
          itemId: `commerce.entity.read:production_requests:${role}`,
          label: "Read production requests",
          granted: false,
          grant: expect.objectContaining({
            subjectLabel,
            target: expect.objectContaining({
              kind: "commerce_list",
              listId: "production_requests",
            }),
          }),
        }),
      ),
      expect.objectContaining({
        capabilityId: "commerce.production_plan.edit",
        granted: false,
      }),
    ]),
  );

  // 2. While the chat waits, the administrator plans the third line.
  await page.submit("person-third", page.set(third, "40"));

  // 3. The owner allows it in place. The private chat reads the plan, but
  //    its edit is refused.
  const allowed = await allowAsPortal(
    author.organisationId,
    author.session,
    pause.id,
  );
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  const resumed = await resumeChat(
    author,
    paths.chat,
    conversationId,
    pause.id,
  );
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  await expect
    .poll(workKind.bind(null, author, conversationId), { timeout: 60_000 })
    .toBe("ready");
  // The agent saw the person's line and the requests' quantities.
  expect(recorded.planRead).toContain(third);
  // Each line names its product, so the agent can match it to orders.
  expect(recorded.planRead).toContain("Sesame cookie");
  expect(recorded.planRead.replaceAll("\\", "")).toContain(
    '"plannedQuantity":"40"',
  );
  expect(recorded.editOutputs[0]).toContain(
    "not shared with this location's plan",
  );
  expect(await page.lines()).toEqual({ [third]: "40" });

  // 4. The owner shares the chat with the plan. A private chat names only
  //    its person, so the plan refuses it until the chat is in a Project.
  //    The owner shares the chat in the workspace's Base Project, whose
  //    readers may read the chat's private first turn.
  const sharePath = `/v1/control/organisations/${author.organisationId}/commerce/inventory/production-plan/${LOCATION}/share`;
  const privateShare = await postJson(author, sharePath, { conversationId });
  expect(privateShare).toMatchObject({
    status: 409,
    body: { error: "production_plan_chat_private" },
  });
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
  const planShared = await postJson(author, sharePath, { conversationId });
  expect(planShared).toMatchObject({
    status: 200,
    body: { sharing: { kind: "portal_chat", conversationId } },
  });

  // 5. The owner asks again in the same chat. The agent changes two lines,
  //    and the administrator's page shows its named cursor on each line.
  await ask(author, paths.chat, conversationId, route.model, AGAIN, "again");
  await expect
    .poll(workKind.bind(null, author, conversationId), { timeout: 60_000 })
    .toBe("ready");
  expect(await answers(author, conversationId)).toEqual([REFUSED, ANSWER]);
  const planned = { [first]: "48", [second]: "36", [third]: "40" };
  await expect
    .poll(() => page.lines(), { message: recorded.editOutputs.join("\n") })
    .toEqual(planned);
  const targets = page.agentFrames.flatMap((frame) =>
    frame.map((activity) => activity.target),
  );
  expect(targets).toEqual(expect.arrayContaining([first, second]));
  await expect
    .poll(() => page.agentFrames.at(-1), { timeout: 15_000 })
    .toEqual([]);

  // 6. The owner accepts the plan that the page shows.
  const accepted = parseInventoryProductionPlanResult(
    await shop.write(planPath("accept"), {
      kind: "accept_plan",
      lines: opened.map((line) => ({
        requestId: line.id,
        requestRevision: line.revision,
        quantity: planned[line.id] ?? String(line.quantity.amount),
      })),
    }),
  );
  expect(accepted.lines.every((line) => line.outcome === "accepted")).toBe(
    true,
  );
  const after = await shop.requestFields([first, second, third]);
  for (const [id, quantity] of Object.entries(planned))
    expect(after.get(id)).toMatchObject({
      status: "accepted",
      quantity: { amount: Number(quantity) },
    });
  await expect.poll(() => page.lines()).toEqual({});
  await page.close();

  task.meta.productionPlanAgent = {
    location: LOCATION,
    requests: { first, second, third },
    privateChatShare: privateShare,
    planShare: planShared.body,
    permissionRequest: request,
    privateEdit: recorded.editOutputs[0],
    toolsAtTurnStart: recorded.turns,
    agentEdits: recorded.edits,
    personLine: { [third]: "40" },
    planBeforeAccept: planned,
    agentCursorTargets: targets,
    accept: accepted,
    underclerkAfter: Object.fromEntries(after),
    answers: await answers(author, conversationId),
  };
}

/**
 * Answers each model request from the conversation so far. The first turn
 * asks for what the turn lacks; after the owner allows it, the agent reads
 * the plan and tries one line. After the owner asks again, the agent reads
 * the plan, changes two lines and answers.
 */
async function replyToModel(
  recorded: Recorded,
  edits: readonly [string, string],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  recorded.requests.push(body);
  const offered = offeredToolNames(body);
  const id = `plan_agent_${String(recorded.requests.length)}`;
  const called = lastCalledTool(body);
  if (called === null) {
    recorded.turns.push(offered);
    if (recorded.turns.length === 1) {
      expect(offered).toContain("request_permission");
      return openRouterToolCall(
        "request_permission",
        {
          capabilityIds: requestableIds(body).filter((capability) =>
            [
              "commerce.entity_plane.context",
              "commerce.production_plan.edit",
            ].includes(capability),
          ),
          entityTypeReads: ["production_requests"],
        },
        `call_${id}`,
      );
    }
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
      expect(output).toContain("Allow prompt");
      return openRouterText(JSON.stringify({ kind: "reply", text: ASKED }), id);
    case "tool_search":
      return readPlan(id);
    case "production_plan_read":
      recorded.planRead = output;
      return editLine(recorded, edits[0], "48", id);
    case "production_plan_edit":
      recorded.editOutputs.push(output);
      if (recorded.editOutputs.length === 1)
        return openRouterText(
          JSON.stringify({ kind: "reply", text: REFUSED }),
          id,
        );
      return recorded.editOutputs.length === 2
        ? editLine(recorded, edits[1], "36", id)
        : openRouterText(JSON.stringify({ kind: "reply", text: ANSWER }), id);
    default:
      throw new Error(`Unexpected tool ${called}: ${output}`);
  }
}

function editLine(
  recorded: Recorded,
  requestId: string,
  quantity: string,
  id: string,
): Promise<Response> | Response {
  recorded.edits.push(requestId);
  return openRouterToolCall(
    "production_plan_edit",
    { locationId: LOCATION, requestId, quantity },
    `call_${id}`,
  );
}

/** The capabilities that the offered permission tool lets the agent name. */
function requestableIds(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const tool of tools) {
    if (!isRecord(tool) || !isRecord(tool.function)) continue;
    if (tool.function.name !== "request_permission") continue;
    const parameters = tool.function.parameters;
    if (
      isRecord(parameters) &&
      isRecord(parameters.properties) &&
      isRecord(parameters.properties.capabilityIds) &&
      isRecord(parameters.properties.capabilityIds.items) &&
      Array.isArray(parameters.properties.capabilityIds.items.enum)
    )
      return parameters.properties.capabilityIds.items.enum.filter(
        (value): value is string => typeof value === "string",
      );
  }
  return [];
}
