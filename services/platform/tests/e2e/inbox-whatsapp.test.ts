import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runInDurableObject } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { expect, it } from "vitest";
import { parseInboxConversations } from "@seams/control-api";
import type { ConnectorIdentity } from "@seams/contracts";
import {
  requireActiveOrganisationActor,
  resolveActiveConnectorActor,
} from "../../src/actors/actor-router";
import type { ConnectorDO } from "../../src/actors/connector";
import {
  beginWhatsAppAdmission,
  claimDueWhatsAppCase,
  commitWhatsAppAdmission,
  completeWhatsAppProcessing,
  recordWhatsAppProposal,
  type WhatsAppIngressLimits,
} from "../../src/actors/connector-whatsapp";
import { createWhatsAppContentCipher } from "../../src/actors/whatsapp-active-content";
import { parseVaultHandle, storeVaultSecret } from "../../src/credential-vault";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import {
  assignWhatsAppSupportAgent,
  openWhatsAppCaseConversationWindow,
  projectWhatsAppReplyProposal,
  publishWhatsAppIngressPolicy,
  readWhatsAppIngressPolicy,
  registerWhatsAppPhoneNumberAccount,
  whatsappConversationWindowCaseId,
} from "../../src/data/whatsapp";
import {
  parseConnectorId,
  parseUserId,
  type ConnectorId,
  type IntegrationAccountId,
} from "../../src/ids";
import {
  parseE164PhoneNumber,
  parseMetaBusinessPortfolioId,
  parseWhatsAppBusinessAccountId,
  parseWhatsAppCustomerId,
  parseWhatsAppPhoneNumberId,
} from "../../src/whatsapp/identifiers";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { network } from "./network";
import {
  installSlackActorFixture,
  ORGANISATION_ID,
} from "./slack-journey-support";

const PHONE_NUMBER_ID = "510000000000083";
const CUSTOMER_ID = "819000000083";
const PROPOSAL_ID = "proposal_p83_whatsapp";
const CUSTOMER_TEXT = "Can I move my Saturday pickup?";
const REPLY = "Yes, we moved your pickup to 4 pm.";
const PERSON_REPLY = "A person says hello.";
const TOKEN = "fixture-whatsapp-inbox-token";
const BASE = `https://localhost/v1/control/organisations/${ORGANISATION_ID}`;

type Fixture = {
  readonly connector: DurableObjectStub<ConnectorDO>;
  readonly identity: ConnectorIdentity & { readonly connectorId: ConnectorId };
  readonly integrationAccountId: IntegrationAccountId;
  readonly caseId: string;
  readonly now: number;
  readonly policyVersion: number;
  readonly owner: IssuedControlSession;
};

it(
  "lists a WhatsApp conversation only under a grant, sends one approved and one person reply, and refuses a send after the window",
  inboxWhatsAppJourney,
  90_000,
);

async function inboxWhatsAppJourney(): Promise<void> {
  const fixture = await installFixture();
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
  const view = record(
    (await json(await control(session, "GET", "access-control"))).accessControl,
  );
  const capabilities = view.capabilities;
  if (!Array.isArray(capabilities)) throw new Error("Missing capabilities");
  const capability = record(
    capabilities.find(
      (candidate) =>
        record(record(candidate).definition).capabilityId ===
        allowed.capabilityId,
    ),
  );
  if (capability.mode !== "enabled") {
    const changed = await control(
      session,
      "POST",
      `access-control/capabilities/${String(allowed.capabilityId)}`,
      {
        expectedRevision: view.revision,
        capabilityRevision: capability.revision,
        capabilityVersion: allowed.capabilityVersion,
        mode: "enabled",
      },
    );
    expect(changed.status, await changed.clone().text()).toBe(200);
  }
  const next = record(
    (await json(await control(session, "GET", "access-control"))).accessControl,
  );
  const grant = record(allowed.grant);
  const created = await control(session, "POST", "access-control/grants", {
    expectedRevision: next.revision,
    subjectRef: grant.subjectRef,
    target: grant.target,
  });
  expect(created.status, await created.clone().text()).toBe(200);
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
      cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
      "x-satyr-csrf": session.csrfToken,
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

async function installFixture(): Promise<Fixture> {
  const { ownerSession } = await installSlackActorFixture();
  await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const now = Date.now();
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'receipt_p83', activated_at = ?, updated_at = ? WHERE organisation_id = ?",
    )
    .bind(now, now, ORGANISATION_ID)
    .run();
  const userId = required(parseUserId(ownerSession.session.userId));
  const handle = required(parseVaultHandle("vault:whatsapp:p83-inbox"));
  required(
    await storeVaultSecret({
      db: fixtureDatabase(),
      keys: env,
      organisationId: ORGANISATION_ID,
      handle,
      secret: { kind: "bearer", value: TOKEN },
      now,
    }),
  );
  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId: ORGANISATION_ID,
    provider: "whatsapp",
    providerSubjectId: "410000000000083",
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef: handle },
    grantedScopes: ["whatsapp_business_messaging"],
    createdByUserId: userId,
    providerAccountId: PHONE_NUMBER_ID,
    accountKind: "phone_number",
    displayName: "Inbox bakery",
    capabilities: ["whatsapp.support.ingress"],
    audiencePolicy: { kind: "customer", consentRequired: true },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const integrationAccountId = connected.account.integrationAccountId;
  required(
    await registerWhatsAppPhoneNumberAccount({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      integrationAccountId,
      providerConnectionId: connected.connection.providerConnectionId,
      environment: "development",
      businessPortfolioId: required(
        parseMetaBusinessPortfolioId("310000000000083"),
      ),
      wabaId: required(parseWhatsAppBusinessAccountId("410000000000083")),
      phoneNumberId: required(parseWhatsAppPhoneNumberId(PHONE_NUMBER_ID)),
      displayPhoneNumber: required(parseE164PhoneNumber("+819000000083")),
      verifiedName: "Inbox bakery",
      now,
    }),
  );
  await fixtureDatabase()
    .prepare(
      "UPDATE whatsapp_phone_number_account SET selected_at = ? WHERE integration_account_id = ?",
    )
    .bind(now, integrationAccountId)
    .run();
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO agent_definition (agent_definition_id, organisation_id, display_name, role, purpose, lifecycle, current_revision, created_by_user_id, created_at, updated_at) VALUES ('agent_p83', ?, 'Support', 'assistant', 'customer support', 'active', 1, ?, ?, ?)",
      )
      .bind(ORGANISATION_ID, userId, now, now),
    fixtureDatabase()
      .prepare(
        "INSERT INTO agent_definition_revision (agent_definition_id, organisation_id, revision, instructions, requested_capabilities_json, skill_refs_json, content_digest, authored_by_user_id, created_at) VALUES ('agent_p83', ?, 1, 'Answer bakery questions', '[]', '[]', ?, ?, ?)",
      )
      .bind(ORGANISATION_ID, "d".repeat(64), userId, now),
    fixtureDatabase()
      .prepare(
        "INSERT INTO agent_installation (installation_id, organisation_id, agent_definition_id, definition_revision, policy_revision, granted_capabilities_json, lifecycle, created_by_user_id, created_at, updated_at) VALUES ('installation_p83', ?, 'agent_p83', 1, 1, '[]', 'active', ?, ?, ?)",
      )
      .bind(ORGANISATION_ID, userId, now, now),
  ]);
  const binding = required(
    await assignWhatsAppSupportAgent({
      scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
      integrationAccountId,
      supportBindingId: "binding_p83",
      installationId: "installation_p83",
      grantsDigest: "b".repeat(64),
      policyDigest: "c".repeat(64),
      createdBy: userId,
      now,
    }),
  );
  const policy = required(
    await publishWhatsAppIngressPolicy({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      integrationAccountId,
      environment: "development",
      request: {
        kind: "enabled",
        ...limits(),
        relevantMessageTopics: "Bakery orders",
        automaticAcknowledgementText: "Thank you for contacting the bakery.",
        agentMode: "answer",
        alwaysWaitTopics: "",
        overflow: "pause_and_notify",
        notificationDestination: {
          kind: "organisation_communication_destination",
        },
      },
      publishedBy: userId,
      now,
    }),
  );
  if (policy.kind !== "enabled") throw new Error("Missing enabled policy");
  const caseId = required(
    whatsappConversationWindowCaseId(integrationAccountId, CUSTOMER_ID, 1),
  );
  required(
    await openWhatsAppCaseConversationWindow({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      integrationAccountId,
      customerWaId: required(parseWhatsAppCustomerId(CUSTOMER_ID)),
      caseId,
      conversationWindowSequence: 1,
      supportBindingId: binding.supportBindingId,
      bindingRevision: binding.currentRevision,
      policyVersion: policy.policyVersion,
      serviceWindowExpiresAt: now + 86_400_000,
      now,
    }),
  );
  const identity: Fixture["identity"] = {
    organisationId: ORGANISATION_ID,
    connectorId: required(
      parseConnectorId(`connector_whatsapp_${integrationAccountId}`),
    ),
  };
  const connector = required(
    await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId: ORGANISATION_ID,
      connectorId: identity.connectorId,
      now,
    }),
  );
  required(
    await connector.activateWhatsAppProcessing({
      identity,
      integrationAccountId,
      policyVersion: policy.policyVersion,
      limits: limits(),
      supportBindingId: binding.supportBindingId,
      bindingRevision: binding.currentRevision,
      credentialGeneration: 1,
      now,
    }),
  );
  const fixture: Fixture = {
    connector,
    identity,
    integrationAccountId,
    caseId,
    now,
    policyVersion: policy.policyVersion,
    owner: ownerSession,
  };
  await runInDurableObject(connector, seedProposal.bind(null, fixture));
  required(
    await projectWhatsAppReplyProposal({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      integrationAccountId,
      proposalId: PROPOSAL_ID,
      caseId,
      customerWaId: CUSTOMER_ID,
      currentVersion: 1,
      lifecycleKind: "awaiting_approval",
      author: "agent",
      serviceWindowExpiresAt: now + 86_400_000,
      now,
    }),
  );
  return fixture;
}

async function seedProposal(
  fixture: Fixture,
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  const cipher = required(
    await createWhatsAppContentCipher({
      root: env.DATA_ENCRYPTION_ROOT,
      organisationId: ORGANISATION_ID,
      integrationAccountId: fixture.integrationAccountId,
    }),
  );
  const sql = state.storage.sql;
  const admitted = beginWhatsAppAdmission(sql, {
    providerMessageId: "wamid.P83_CUSTOMER",
    customerWaId: CUSTOMER_ID,
    providerTimestamp: fixture.now,
    declaredBytes: 40,
    limits: limits(),
    caseIdFor: () => fixture.caseId,
    now: fixture.now,
  });
  if (admitted.kind !== "ready") throw new Error(admitted.kind);
  const sealed = await cipher.seal(
    fixture.caseId,
    { kind: "message", providerMessageId: "wamid.P83_CUSTOMER" },
    CUSTOMER_TEXT,
  );
  commitWhatsAppAdmission(sql, {
    caseId: fixture.caseId,
    providerMessageId: "wamid.P83_CUSTOMER",
    customerWaId: CUSTOMER_ID,
    providerTimestamp: fixture.now,
    nonceB64: sealed.nonceB64,
    ciphertextB64: sealed.ciphertextB64,
    bytes: sealed.bytes,
    limits: limits(),
    policyVersion: fixture.policyVersion,
    now: fixture.now,
  });
  claimDueWhatsAppCase(sql, fixture.now + 16_000);
  completeWhatsAppProcessing(sql);
  const bodyDigest = await cipher.digest(REPLY);
  const body = await cipher.seal(
    fixture.caseId,
    { kind: "proposal", proposalId: PROPOSAL_ID, version: 1 },
    REPLY,
  );
  recordWhatsAppProposal(sql, {
    proposalId: PROPOSAL_ID,
    version: 1,
    caseId: fixture.caseId,
    customerWaId: CUSTOMER_ID,
    author: "agent",
    bodyDigest,
    nonceB64: body.nonceB64,
    ciphertextB64: body.ciphertextB64,
    policyVersion: fixture.policyVersion,
    credentialGeneration: 1,
    serviceWindowExpiresAt: fixture.now + 86_400_000,
    expiresAt: fixture.now + 3_600_000,
    now: fixture.now,
  });
}

function limits(): WhatsAppIngressLimits {
  return {
    maxActiveCases: 3,
    maxMessagesPerHour: 20,
    dailyAgentTokenBudget: 100_000,
    maxMessageBytes: 4096,
    maxActiveCaseMessages: 20,
    maxActiveCaseBytes: 32768,
    debounceSeconds: 15,
  };
}

function required<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
