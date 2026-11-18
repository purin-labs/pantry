import { env, exports } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { expect, it, type TestContext } from "vitest";
import { parseHeldOutputView } from "@seams/control-api";
import { isRecord } from "@seams/std";

import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { parseUserId } from "../../src/ids";
import { accessControlPath } from "./access-route-support";
import {
  BASE_ID,
  command,
  connectAirtable,
  pending,
} from "./airtable-exit-support";
import { commerceHeaders } from "./commerce-support";
import { raiseLabel } from "./held-exit-support";
import { network } from "./network";
import { givePortalHandles } from "./permission-request-support";
import {
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    outsideWrittenEffect?: Record<string, unknown>;
  }
}

/**
 * A request that read text of a person outside the Organisation asks before an
 * effect with a consequence (Plan 89).
 *
 * In an owner's Portal request the agent reads the order base and then a text
 * that an outside person wrote, which tells it to add an order. The write goes
 * back to the base that it read, so no reader rule stops it. The writer rule
 * does: Airtable gets no write, and the request shows the exact record. Another
 * member does not see the request and cannot decide it. The owner allows it,
 * and the same step then writes once. Another record asks again, and the same
 * record asks again after its one use. A request that read no outside text
 * writes with no question.
 */
it(
  "asks the person who asked before a request that read outside text changes a record",
  outsideWrittenEffect,
  240_000,
);

const STOPPED = "Seams Pantry stopped this step";
const INJECTED = { records: [{ fields: { Title: "Order 481 is ready" } }] };
const OTHER = { records: [{ fields: { Title: "Refund order 480" } }] };

type Step = (body: Record<string, unknown>) => Response | Promise<Response>;

async function outsideWrittenEffect({ task }: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const owner = fixture.ownerSession;
  const accountId = await connectAirtable(
    owner,
    fixture.selectedIntegrationAccountId,
  );
  await givePortalHandles(ORGANISATION_ID);
  const otherMember = await memberSession();

  const steps: Step[] = [];
  const toolOutputs: string[] = [];
  const writes: string[] = [];
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      async ({ request }) => {
        const body: unknown = await request.json();
        if (!isRecord(body)) throw new Error("Invalid model request");
        const step = steps.shift();
        if (step === undefined) throw new Error("Unexpected model request");
        return step(body);
      },
    ),
    http.get(`https://api.airtable.com/v0/${BASE_ID}/Orders`, () =>
      HttpResponse.json({
        records: [{ id: "recExit", fields: { Title: "Order 480 is late" } }],
      }),
    ),
    http.post(
      `https://api.airtable.com/v0/${BASE_ID}/Orders`,
      async ({ request }) => {
        writes.push(await request.text());
        return HttpResponse.json({ records: [{ id: "recNew" }] });
      },
    ),
  );
  const request = (method: "GET" | "POST", body: unknown): string =>
    JSON.stringify({
      kind: "request",
      integrationAccountId: accountId,
      method,
      path: `/v0/${BASE_ID}/Orders`,
      body,
    });
  const search =
    (id: string): Step =>
    () =>
      openRouterToolCall(
        "tool_search",
        { query: "airtable_api_read airtable_api_write", limit: 8 },
        `search_${id}`,
      );
  const read =
    (id: string): Step =>
    () =>
      openRouterToolCall(
        "airtable_api_read",
        { requestJson: request("GET", null) },
        `read_${id}`,
      );
  const write =
    (id: string, record: unknown): Step =>
    () =>
      openRouterToolCall(
        "airtable_api_write",
        { requestJson: request("POST", record) },
        `write_${id}`,
      );
  /** The turn reads a text of an outside person, then does the next step. */
  const afterOutsideText =
    (step: Step): Step =>
    async (body) => {
      await raiseLabel(
        {
          owner: {
            kind: "integration_resource",
            organisationId: ORGANISATION_ID,
            integrationAccountId: accountId,
            resourceScope: `base:${BASE_ID}`,
          },
          readers: [{ kind: "organisation_role", role: "owner" }],
        },
        "outside",
      );
      return step(body);
    };
  const reply =
    (id: string): Step =>
    (body) => {
      toolOutputs.push(
        JSON.stringify(body.input ?? body.messages).slice(-2_500),
      );
      return openRouterText(
        JSON.stringify({ kind: "reply", text: "Done." }),
        `answer_${id}`,
      );
    };
  /** One Portal request: read the base, read outside text or not, then write. */
  const ask = async (
    id: string,
    record: unknown,
    outsideText: boolean,
  ): Promise<string> => {
    const writing = write(id, record);
    steps.push(
      search(id),
      read(id),
      outsideText ? afterOutsideText(writing) : writing,
      reply(id),
    );
    const response = await command(owner, `outside_written_${id}`);
    expect(response.status).toBe(200);
    expect(steps).toHaveLength(0);
    const output = toolOutputs.at(-1);
    if (output === undefined) throw new Error("The request made no step");
    return output;
  };
  const waiting = async (session: IssuedControlSession) =>
    (await pending(session)).filter(
      (item) => item.reason === "outside_written",
    );

  // 1. The request reads outside text and then writes. Nothing reaches Airtable.
  const stopped = await ask("first", INJECTED, true);
  expect(stopped).toContain(STOPPED);
  expect(stopped).toContain("outside the Organisation");
  expect(writes).toEqual([]);

  // 2. The owner sees the request with the exact record. Another member does
  //    not see it and cannot decide it.
  const held = await waiting(owner);
  expect(held).toHaveLength(1);
  const requestId = held[0]?.requestId;
  if (typeof requestId !== "string") throw new Error("The request is missing");
  const viewed = await exports.default.fetch(
    `${accessControlPath(ORGANISATION_ID)}/held-outputs/${requestId}`,
    { headers: commerceHeaders(owner) },
  );
  expect(viewed.status).toBe(200);
  const view = parseHeldOutputView(await viewed.json());
  expect(view?.action?.operation).toBe("airtable.write");
  expect(JSON.stringify(view?.action?.details)).toContain("Order 481 is ready");
  expect(await waiting(otherMember)).toEqual([]);
  expect((await decide(otherMember, requestId)).status).toBe(404);
  expect(writes).toEqual([]);

  // 3. The owner allows it. The same step then writes that record once.
  expect((await decide(owner, requestId)).status).toBe(200);
  expect(await ask("allowed", INJECTED, true)).not.toContain(STOPPED);
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0] as string)).toEqual(INJECTED);

  // 4. Another record is another action, and the Allow was for one use.
  expect(await ask("other", OTHER, true)).toContain(STOPPED);
  expect(await ask("again", INJECTED, true)).toContain(STOPPED);
  expect(writes).toHaveLength(1);
  expect(await waiting(owner)).toHaveLength(2);

  // 5. A request that read no outside text writes with no question.
  expect(await ask("plain", OTHER, false)).not.toContain(STOPPED);
  expect(writes).toHaveLength(2);
  expect(JSON.parse(writes[1] as string)).toEqual(OTHER);

  task.meta.outsideWrittenEffect = { writes, action: view?.action };
}

/** The Portal session of a member who did not ask. */
async function memberSession(): Promise<IssuedControlSession> {
  const userId = parseUserId(SLACK_ACTOR_USER_ID);
  if (!userId.ok) throw new Error("Invalid member");
  return issueControlSession({
    db: env.DB,
    userId: userId.value,
    now: Date.now(),
    ttlMs: 1_800_000,
  });
}

function decide(
  session: IssuedControlSession,
  requestId: string,
): Promise<Response> {
  return exports.default.fetch(
    `${accessControlPath(ORGANISATION_ID)}/held-outputs/${requestId}/decision`,
    {
      method: "POST",
      headers: commerceHeaders(session),
      body: JSON.stringify({ decision: "allow" }),
    },
  );
}
