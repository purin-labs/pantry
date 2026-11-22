import { exports } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { accessControlPath } from "./access-route-support";
import {
  BASE_ID,
  command,
  connectAirtable,
  pending,
  SUPPLIER_BASE_ID,
} from "./airtable-exit-support";
import { commerceHeaders } from "./commerce-support";
import { network } from "./network";
import { givePortalHandles } from "./permission-request-support";
import {
  CHANNEL_ID,
  discoverSlackChannel,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  ORGANISATION_ID,
  readSlackMessageText,
  ROOT_TS,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    airtableExitApproval?: Record<string, unknown>;
  }
}

/**
 * An Airtable write reaches another company's service, so internal content asks
 * a person (Plan 27C).
 *
 * In a Slack thread the agent reads the supplier base and writes to the order
 * base. The write stops, and the provider gets no write. An owner allows it, and
 * a new turn writes once. In a Portal request of the owner, whose own role may
 * read both bases, the write stops in the same way, because that role is not a
 * reader at Airtable. Content of the order base alone goes back to the order base
 * with no question, and so does a write that follows only the person's own words.
 */
it("asks a person before internal content reaches Airtable", airtableExit, 240_000);

const STOPPED = "Purin Pantry stopped this step";
const NEW_ORDER = { records: [{ fields: { Title: "Order 481 is ready" } }] };

type Step = (body: Record<string, unknown>) => Response;

async function airtableExit({ task }: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const accountId = await connectAirtable(fixture.ownerSession, fixture.selectedIntegrationAccountId);
  await givePortalHandles(ORGANISATION_ID);
  await discoverSlackChannel("public_channel", Date.now() - 60_000);

  const steps: Step[] = [];
  const toolOutputs: string[] = [];
  const writes: string[] = [];
  const slack = slackSimulator();
  network.use(
    slack.handler,
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
    http.get(`https://api.airtable.com/v0/${SUPPLIER_BASE_ID}/Orders`, () =>
      HttpResponse.json({
        records: [{ id: "recPrice", fields: { Title: "Flour costs more" } }],
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
  const shown = (): string[] => slack.messages.map(readSlackMessageText);
  const call = (
    name: "airtable_api_read" | "airtable_api_write",
    id: string,
    baseId: string = BASE_ID,
  ): Step =>
    () =>
      openRouterToolCall(
        name,
        {
          requestJson: JSON.stringify({
            kind: "request",
            integrationAccountId: accountId,
            method: name === "airtable_api_read" ? "GET" : "POST",
            path: `/v0/${baseId}/Orders`,
            body: name === "airtable_api_read" ? null : NEW_ORDER,
          }),
        },
        `${name}_${id}`,
      );
  const search = (id: string): Step => () =>
    openRouterToolCall(
      "tool_search",
      { query: "airtable_api_read airtable_api_write", limit: 8 },
      `search_${id}`,
    );
  const finish = (id: string, text: string): Step => (body) => {
    toolOutputs.push(JSON.stringify(body.input ?? body.messages).slice(-2_000));
    return openRouterText(text, `answer_${id}`);
  };
  const reply = (id: string, text: string): Step => (body) => {
    toolOutputs.push(JSON.stringify(body.input ?? body.messages).slice(-2_000));
    return openRouterText(JSON.stringify({ kind: "reply", text }), `answer_${id}`);
  };

  // 1. A thread reads one base and writes to another. Nothing reaches Airtable.
  steps.push(search("thread"), call("airtable_api_read", "thread", SUPPLIER_BASE_ID), call("airtable_api_write", "thread"), finish("thread", "I asked."));
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "EvAIRTABLE_EXIT",
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: "<@U0PANTRY> add order 481 to the order base",
      }),
    ),
  );
  expect(response.status).toBe(200);
  await expect.poll(() => shown().length, { timeout: 40_000 }).toBeGreaterThanOrEqual(2);
  expect(toolOutputs.at(-1)).toContain(STOPPED);
  expect(writes).toEqual([]);
  const notice = slack.messages.find((message) =>
    message.text?.includes("one step"),
  );
  expect(notice?.text).not.toContain("https:");
  const requestId = /heldOutput=([0-9a-f]{32})/u.exec(notice?.blocks ?? "")?.[1];
  if (requestId === undefined) throw new Error("Held request link missing");
  const listed = await pending(fixture.ownerSession);
  expect(listed.find((held) => held.requestId === requestId)).toMatchObject({
    reason: "outside_organisation",
  });

  // 2. The owner allows it, and a new turn writes once.
  steps.push(call("airtable_api_write", "pass"), finish("pass", "The order is in the base."));
  const decided = await exports.default.fetch(
    `${accessControlPath(ORGANISATION_ID)}/held-outputs/${requestId}/decision`,
    {
      method: "POST",
      headers: commerceHeaders(fixture.ownerSession),
      body: JSON.stringify({ decision: "allow" }),
    },
  );
  expect(decided.status).toBe(200);
  await expect.poll(() => writes.length, { timeout: 40_000 }).toBe(1);
  await expect.poll(() => steps.length, { timeout: 40_000 }).toBe(0);
  expect(JSON.parse(writes[0] as string)).toEqual(NEW_ORDER);
  expect(notice?.text).toContain("allowed the step");

  // 3. In the owner's Portal request the role may read both bases, and one of
  // them is the destination. The other base's content still asks.
  steps.push(search("portal"), call("airtable_api_read", "portal"), call("airtable_api_read", "portal_other", SUPPLIER_BASE_ID), call("airtable_api_write", "portal"), reply("portal", "I asked."));
  expect((await command(fixture.ownerSession, "portal_read_write")).status).toBe(200);
  expect(toolOutputs.at(-1)).toContain(STOPPED);
  expect(writes).toHaveLength(1);

  // 4. A write from the owner's own words alone does not ask.
  steps.push(search("words"), call("airtable_api_write", "words"), reply("words", "Done."));
  expect((await command(fixture.ownerSession, "portal_words")).status).toBe(200);
  expect(toolOutputs.at(-1)).not.toContain(STOPPED);
  expect(writes).toHaveLength(2);

  // 5. The order base's own content goes back to it with no question.
  steps.push(search("same"), call("airtable_api_read", "same"), call("airtable_api_write", "same"), reply("same", "Done."));
  expect((await command(fixture.ownerSession, "portal_same_base")).status).toBe(200);
  expect(toolOutputs.at(-1)).not.toContain(STOPPED);
  expect(writes).toHaveLength(3);

  task.meta.airtableExitApproval = {
    channel: CHANNEL_ID,
    writes: writes.length,
    shown: shown(),
  };
}
