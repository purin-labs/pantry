import { exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runInDurableObject } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { expect, it } from "vitest";
import { parseInboxConversations } from "@purin-labs/control-api";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import { readWhatsAppIngressPolicy } from "@purin-labs/area-inbox/server/data/whatsapp";
import { createGrant, enableCapability } from "./access-route-support";
import { network } from "./network";
import { ORGANISATION_ID } from "./slack-journey-support";
import {
  CUSTOMER_ID,
  PHONE_NUMBER_ID,
  PROPOSAL_ID,
  installFixture,
  limits,
  type Fixture,
} from "./whatsapp-connector-support";

const CUSTOMER_TEXT = "Can I move my Saturday pickup?";
const REPLY = "Yes, we moved your pickup to 4 pm.";
const PERSON_REPLY = "A person says hello.";
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
