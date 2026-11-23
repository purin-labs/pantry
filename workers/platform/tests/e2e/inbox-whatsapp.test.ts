import { exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  parseInboxConversations,
  whatsappConversationTab,
  type WhatsAppConversationState,
} from "@purin-labs/control-api";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import { readWhatsAppIngressPolicy } from "@purin-labs/area-inbox/server/data/whatsapp";
import { createGrant, enableCapability } from "./access-route-support";
import { network } from "./network";
import {
  ORGANISATION_ID,
  openRouterText,
  openRouterToolCall,
  openRouterUsage,
} from "./slack-journey-support";
import { isRecord } from "@purin-labs/std";
import {
  CUSTOMER_ID,
  PHONE_NUMBER_ID,
  PROPOSAL_ID,
  installFixture,
  limits,
  type Fixture,
} from "./whatsapp-connector-support";

declare module "vitest" {
  interface TaskMeta {
    inboxWhatsAppUnanswered?: Record<string, unknown>;
  }
}

const CUSTOMER_TEXT = "Can I move my Saturday pickup?";
const REPLY = "Yes, we moved your pickup to 4 pm.";
const PERSON_REPLY = "A person says hello.";
const SECOND_TEXT = "Can I change my bakery order to Sunday instead?";
const THIRD_TEXT = "And can the bakery order include two more tarts?";
const BASE = `https://localhost/v1/control/organisations/${ORGANISATION_ID}`;

it(
  "lists a WhatsApp conversation only under a grant, sends one approved and one person reply, and refuses a send after the window",
  inboxWhatsAppJourney,
  90_000,
);

async function inboxWhatsAppJourney(): Promise<void> {
  const fixture = await installFixture({
    customerText: CUSTOMER_TEXT,
    reply: REPLY,
    inbox: true,
  });
  const sends: string[] = [];
  network.use(
    http.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      async ({ request }) => {
        const body: unknown = await request.json();
        sends.push(JSON.stringify(body));
        return HttpResponse.json({
          messages: [{ id: `wamid.P83_SENT_${sends.length}` }],
        });
      },
    ),
  );

  // No grant: the list names the number's grant and holds no customer text.
  const refused = await readList(fixture.owner);
  expect(JSON.stringify(refused)).not.toContain(CUSTOMER_TEXT);
  expect(refused.whatsapp).toMatchObject({ kind: "read", conversations: [] });
  const caseRead = await control(
    fixture.owner,
    "GET",
    `whatsapp-cases/${fixture.caseId}`,
  );
  expect(caseRead.status).toBe(403);
  const refusal: unknown = await caseRead.json();
  expect(JSON.stringify(refusal)).not.toContain(CUSTOMER_TEXT);
  expect(refusal).toMatchObject({ error: "whatsapp_read_permission_required" });

  // The prompt's own grant target works through the Access routes.
  const permission =
    refused.whatsapp.kind === "read" ? refused.whatsapp.refused : null;
  expect(permission).toMatchObject({
    capabilityId: "whatsapp.support.read",
    grant: { target: { kind: "provider_resource" } },
  });
  await allow(fixture.owner, permission);

  // With the grant, the row names the customer's question and who must act.
  const listed = await readList(fixture.owner);
  if (listed.whatsapp.kind !== "read") throw new Error(listed.whatsapp.kind);
  expect(listed.whatsapp.refused).toBeNull();
  expect(listed.whatsapp.conversations).toMatchObject([
    {
      caseId: fixture.caseId,
      customerWaId: CUSTOMER_ID,
      preview: CUSTOMER_TEXT,
      proposalId: PROPOSAL_ID,
      state: "reply_waiting",
    },
  ]);

  // Approval sends the exact version once. A stale digest sends nothing.
  const preview = await json(
    await control(fixture.owner, "GET", `whatsapp-replies/${PROPOSAL_ID}`),
  );
  const proposal = record(preview.proposal);
  const stale = await control(
    fixture.owner,
    "POST",
    `whatsapp-replies/${PROPOSAL_ID}/approve`,
    { version: proposal.version, bodyDigest: "0".repeat(64) },
  );
  expect(JSON.stringify(await stale.json())).not.toContain('"kind":"sent"');
  expect(sends).toHaveLength(0);
  const approved = await control(
    fixture.owner,
    "POST",
    `whatsapp-replies/${PROPOSAL_ID}/approve`,
    { version: proposal.version, bodyDigest: proposal.body_digest },
  );
  expect(approved.status, await approved.clone().text()).toBe(200);
  expect(sends).toHaveLength(1);
  expect(sends[0]).toContain(REPLY);
  expect(sends[0]).toContain(CUSTOMER_ID);
  const afterSend = await readList(fixture.owner);
  expect(conversationOf(afterSend)).toMatchObject({
    proposalId: null,
    state: "agent_handled",
  });

  // The person takes over. The composer's reply goes once, under their name.
  const taken = await control(
    fixture.owner,
    "POST",
    `whatsapp-cases/${fixture.caseId}/take-over`,
    {},
  );
  expect(taken.status, await taken.clone().text()).toBe(200);
  expect(conversationOf(await readList(fixture.owner))).toMatchObject({
    ownership: "human_owned",
    state: "person_replied",
  });
  const person = await control(
    fixture.owner,
    "POST",
    `whatsapp-cases/${fixture.caseId}/human-reply`,
    { body: PERSON_REPLY, confirmed: true },
  );
  expect(person.status, await person.clone().text()).toBe(200);
  expect(sends).toHaveLength(2);
  expect(sends[1]).toContain(PERSON_REPLY);

  // The agent setting changes only its own fields, and a bad value is refused.
  const invalid = await control(
    fixture.owner,
    "POST",
    `whatsapp-accounts/${fixture.integrationAccountId}/policy`,
    { agent: { agentMode: "always", alwaysWaitTopics: "" } },
  );
  expect(invalid.status).toBe(422);
  const saved = await control(
    fixture.owner,
    "POST",
    `whatsapp-accounts/${fixture.integrationAccountId}/policy`,
    { agent: { agentMode: "draft", alwaysWaitTopics: "allergy" } },
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
  const policy = await readWhatsAppIngressPolicy({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    integrationAccountId: fixture.integrationAccountId,
    connectedAt: fixture.now,
  });
  expect(policy).toMatchObject({
    kind: "enabled",
    agentMode: "draft",
    alwaysWaitTopics: "allergy",
    maxActiveCases: limits().maxActiveCases,
    relevantMessageTopics: "Bakery orders",
  });

  // After the window, the send is refused and Meta receives nothing.
  await runInDurableObject(fixture.connector, closeWindow.bind(null, fixture));
  await fixtureDatabase()
    .prepare(
      "UPDATE whatsapp_case_conversation_window SET service_window_expires_at = ? WHERE case_id = ?",
    )
    .bind(fixture.now - 1, fixture.caseId)
    .run();
  const late = await control(
    fixture.owner,
    "POST",
    `whatsapp-cases/${fixture.caseId}/human-reply`,
    { body: "Too late.", confirmed: true },
  );
  expect(JSON.stringify(await late.json())).not.toContain('"kind":"sent"');
  expect(sends).toHaveLength(2);

  // A closed window lists without text. Pantry holds none for it.
  const closed = await readList(fixture.owner);
  expect(conversationOf(closed)).toMatchObject({
    preview: null,
    state: "closed",
  });
  expect(JSON.stringify(closed)).not.toContain(CUSTOMER_TEXT);
}

// A person rejects the agent's draft, and the customer writes again in the
// same conversation. The new message joins the Case, and the Inbox shows it.
it(
  "admits a customer's new message into an open Case and lists it in the Inbox",
  newMessageJourney,
  120_000,
);

async function newMessageJourney({ task }: TestContext): Promise<void> {
  const fixture = await customerWritesAgain();
  const listed = await readList(fixture.owner);
  // The agent's turn is due, so the conversation is the agent's.
  expect(conversationOf(listed)).toMatchObject({
    caseId: fixture.caseId,
    preview: SECOND_TEXT,
    proposalId: null,
    state: "agent_handled",
  });
  task.meta.inboxWhatsAppUnanswered = { listed: conversationOf(listed) };
}

// The model provider fails, so the agent cannot answer the customer's new
// message. After the bounded turn attempts the operator is told what
// happened, in the operations channel, and the Inbox lists the customer
// under "Waiting for you", not under "The agent answered".
it(
  "tells the operator that the agent could not answer when its turn attempts run out, and lists the customer as waiting",
  unansweredJourney,
  120_000,
);

async function unansweredJourney({ task }: TestContext): Promise<void> {
  const notices: string[] = [];
  let modelCalls = 0;
  network.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", () => {
      modelCalls += 1;
      return HttpResponse.json(
        { error: { message: "provider unavailable", code: 400 } },
        { status: 400 },
      );
    }),
    http.post("https://slack.com/api/chat.postMessage", async ({ request }) => {
      const body: unknown = await request.json();
      notices.push(String(record(body).text));
      return HttpResponse.json({ ok: true, channel: "C0E2EACTOR", ts: "1" });
    }),
  );
  const fixture = await customerWritesAgain();

  // Each turn fails; the Case waits for its next attempt.
  for (let attempt = 1; attempt <= 3; attempt += 1) await runDueTurn(fixture);
  expect(modelCalls).toBeGreaterThanOrEqual(3);

  // One notice tells the operator that the agent could not answer, not that
  // a draft passed the 24-hour window. It quotes no customer text.
  expect(notices).toHaveLength(1);
  const notice = notices[0] ?? "";
  expect(notice).toContain("could not answer");
  expect(notice).not.toContain("24-hour service window");
  expect(notice).not.toContain(SECOND_TEXT);

  // No agent reply comes, so a person must answer the customer.
  const listed = await readList(fixture.owner);
  expect(conversationOf(listed)).toMatchObject({
    caseId: fixture.caseId,
    preview: SECOND_TEXT,
    state: "no_reply_yet",
  });
  expect(
    whatsappConversationTab(
      record(conversationOf(listed)).state as WhatsAppConversationState,
    ),
  ).toBe("needs");

  task.meta.inboxWhatsAppUnanswered = {
    modelCalls,
    notice,
    state: record(conversationOf(listed)).state,
  };
}

// The agent answers until the number's daily token budget is gone. The
// next customer message pauses the number, the operator is told once, and
// the customer waits for a person. When the UTC day ends the pause ends by
// itself, and the agent answers that customer with no operator step.
it(
  "pauses the agent when the daily budget runs out, and answers the waiting customer when the UTC day ends",
  budgetJourney,
  120_000,
);

async function budgetJourney({ task }: TestContext): Promise<void> {
  const sends: string[] = [];
  const notices: string[] = [];
  let modelCalls = 0;
  network.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", () => {
      modelCalls += 1;
      // Each turn proposes one reply, then ends: 50 tokens a turn.
      return modelCalls % 2 === 1
        ? openRouterToolCall(
            "whatsapp_reply_propose",
            { body: `Agent reply ${String((modelCalls + 1) / 2)}` },
            `wa_budget_${String(modelCalls)}`,
            openRouterUsage(20, 0, 5),
          )
        : openRouterText(
            "Done",
            `wa_budget_${String(modelCalls)}`,
            openRouterUsage(20, 0, 5),
          );
    }),
    http.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      async ({ request }) => {
        sends.push(JSON.stringify(await request.json()));
        return HttpResponse.json({
          messages: [{ id: `wamid.P83_BUDGET_${String(sends.length)}` }],
        });
      },
    ),
    http.post("https://slack.com/api/chat.postMessage", async ({ request }) => {
      const body: unknown = await request.json();
      notices.push(String(record(body).text));
      return HttpResponse.json({ ok: true, channel: "C0E2EACTOR", ts: "1" });
    }),
  );
  const fixture = await customerWritesAgain({ dailyAgentTokenBudget: 50 });

  // The agent answers the second message. That turn uses the day's budget.
  await runDueTurn(fixture);
  expect(sends).toHaveLength(1);
  expect(sends[0]).toContain("Agent reply 1");

  // The third message finds no budget: the number pauses and tells the
  // operator once, and the customer waits for a person.
  await customerWrites(fixture, "wamid.P83_THIRD", THIRD_TEXT);
  await runDueTurn(fixture);
  expect(sends).toHaveLength(1);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("daily agent token budget");
  expect(notices[0]).not.toContain(THIRD_TEXT);
  expect(conversationOf(await readList(fixture.owner))).toMatchObject({
    preview: THIRD_TEXT,
    state: "no_reply_yet",
  });

  // The UTC day ends. The pause ends with it, and the agent answers the
  // waiting customer. No operator resumed the number.
  await runInDurableObject(fixture.connector, endBudgetDay);
  await runDurableObjectAlarm(fixture.connector);
  expect(sends).toHaveLength(2);
  expect(sends[1]).toContain("Agent reply 2");
  expect(notices).toHaveLength(1);
  expect(conversationOf(await readList(fixture.owner))).toMatchObject({
    state: "agent_handled",
  });

  task.meta.inboxWhatsAppUnanswered = {
    budget: { replies: sends.length, notices, modelCalls },
  };
}

/** Runs the Case's due agent turn now, in the Connector's alarm. */
async function runDueTurn(fixture: Fixture): Promise<void> {
  await runInDurableObject(
    fixture.connector,
    makeTurnDue.bind(null, fixture.caseId),
  );
  await runDurableObjectAlarm(fixture.connector);
}

/**
 * What the end of the UTC day changes for the Connector: today's token use
 * becomes yesterday's, and each time that falls due by the end of the day
 * is due now.
 */
function endBudgetDay(_actor: unknown, state: DurableObjectState): void {
  const sql = state.storage.sql;
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
  const dayEnd = Date.parse(`${today}T23:59:59.999Z`) + 1;
  sql.exec(
    "UPDATE connector_whatsapp_reservation SET utc_day = ? WHERE utc_day = ?",
    yesterday,
    today,
  );
  sql.exec(
    "UPDATE connector_whatsapp_case SET debounce_due_at = ? WHERE debounce_due_at IS NOT NULL AND debounce_due_at <= ?",
    now - 1,
    dayEnd,
  );
  const row = sql
    .exec<{ processing_json: string }>(
      "SELECT processing_json FROM connector_whatsapp_runtime",
    )
    .one();
  const processing: unknown = JSON.parse(row.processing_json);
  if (
    isRecord(processing) &&
    isRecord(processing.reason) &&
    typeof processing.reason.windowEndsAt === "number" &&
    processing.reason.windowEndsAt <= dayEnd
  )
    sql.exec(
      "UPDATE connector_whatsapp_runtime SET processing_json = ?",
      JSON.stringify({
        ...processing,
        reason: { ...processing.reason, windowEndsAt: now - 1 },
      }),
    );
}

async function customerWrites(
  fixture: Fixture,
  providerMessageId: string,
  body: string,
): Promise<void> {
  const accepted = await fixture.connector.acceptWhatsAppEvent({
    identity: fixture.identity,
    event: {
      kind: "text_message",
      customerWaId: CUSTOMER_ID,
      providerMessageId,
      providerTimestamp: Date.now(),
      body,
    },
    now: Date.now(),
  });
  expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true });
}

/**
 * The fixture's conversation after its owner can read the number, rejects
 * the agent's draft, and the customer sends a second message.
 */
async function customerWritesAgain(
  options: Readonly<{ dailyAgentTokenBudget?: number }> = {},
): Promise<Fixture> {
  const fixture = await installFixture({
    customerText: CUSTOMER_TEXT,
    reply: REPLY,
    inbox: true,
    ...options,
  });
  const refused = await readList(fixture.owner);
  await allow(
    fixture.owner,
    refused.whatsapp.kind === "read" ? refused.whatsapp.refused : null,
  );
  const rejected = await control(
    fixture.owner,
    "POST",
    `whatsapp-replies/${PROPOSAL_ID}/reject`,
    {},
  );
  expect(rejected.status, await rejected.clone().text()).toBe(200);
  await customerWrites(fixture, "wamid.P83_SECOND", SECOND_TEXT);
  return fixture;
}

/** Moves the Case's next agent turn to now, as its wait would. */
function makeTurnDue(
  caseId: string,
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec(
    "UPDATE connector_whatsapp_case SET debounce_due_at = ? WHERE case_id = ? AND debounce_due_at IS NOT NULL",
    Date.now() - 1,
    caseId,
  );
}

async function closeWindow(
  fixture: Fixture,
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  state.storage.sql.exec(
    "UPDATE connector_whatsapp_case SET service_window_expires_at = ? WHERE case_id = ?",
    fixture.now - 1,
    fixture.caseId,
  );
}

/** What the permission prompt does when a person allows the read. */
async function allow(
  session: IssuedControlSession,
  permission: unknown,
): Promise<void> {
  const allowed = record(permission);
  await enableCapability(
    ORGANISATION_ID,
    session,
    String(allowed.capabilityId),
  );
  await createGrant(ORGANISATION_ID, session, record(allowed.grant));
}

function conversationOf(
  list: NonNullable<ReturnType<typeof parseInboxConversations>>,
): unknown {
  if (list.whatsapp.kind !== "read") throw new Error(list.whatsapp.kind);
  return list.whatsapp.conversations[0];
}

async function readList(
  session: IssuedControlSession,
): Promise<NonNullable<ReturnType<typeof parseInboxConversations>>> {
  const response = await control(session, "GET", "inbox-conversations");
  const raw: unknown = await response.json();
  expect(response.status, JSON.stringify(raw)).toBe(200);
  const parsed = parseInboxConversations(raw);
  if (parsed === null) throw new Error(JSON.stringify(raw));
  return parsed;
}

function control(
  session: IssuedControlSession,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return exports.default.fetch(`${BASE}/${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: "https://localhost",
      cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
      "x-pantry-csrf": session.csrfToken,
      ...(method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const raw: unknown = await response.json();
  expect(response.status, JSON.stringify(raw)).toBe(200);
  return record(raw);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Expected a record: ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}
