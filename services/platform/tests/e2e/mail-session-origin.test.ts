import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
  OrganisationStatement,
} from "../../src/database-handles";
import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, vi, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { network } from "./network";
import {
  installSlackActorFixture,
  createRequiredGrant,
  openRouterToolCall,
  openRouterText,
  ORGANISATION_ID,
} from "./slack-journey-support";
import {
  parseUserId,
  parseSessionId,
  type IntegrationAccountId,
} from "../../src/ids";
import { parseVaultHandle, storeVaultSecret } from "../../src/credential-vault";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import {
  registerEmailMailboxAccount,
  assignAgentMailbox,
  publishMailboxIngressPolicy,
  gmailConnectorId,
} from "../../src/data/email-mailbox";
import {
  registerEmailSenderAccount,
  registerOperationalEmailContact,
} from "../../src/data/email-operational";
import {
  activateEmailRuntime,
  claimDueEmailEvaluation,
  completeEmailEvaluation,
} from "../../src/actors/connector-email";
import {
  integrationAccountReference,
  type IntegrationAccountReference,
} from "../../src/access-control/integration-discovery";
import { GMAIL_FULL_MAILBOX_SCOPES } from "../../src/mail/gmail-authorization";
import { writeOrganisationCapabilityPolicy } from "../../src/data/capability-policy";
import {
  applyAgentOperation,
  type AgentOperationCommand,
} from "../../src/data/agent-operations";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import {
  requireActiveOrganisationActor,
  resolveActiveSessionActor,
  resolveActiveConnectorActor,
} from "../../src/actors/actor-router";
import {
  CAPABILITY_KEYS,
  EMAIL_MAILBOX_RESOURCE_SCOPE,
  EMAIL_OPERATIONAL_RESOURCE_SCOPE,
} from "../../src/authorization/capability-catalogue";
import {
  EMAIL_SELF_TEST_SUBJECT,
  EMAIL_SELF_TEST_BODY,
  resolveEmailProposalRecipient,
} from "../../src/data/email-self-test";
import { selfTestCount } from "./gmail-mailbox-support";

const TOKEN = "mail-session-origin-fixture-token";
const PROVIDER_TEXT = "P55 private supplier mail";
const BODY = "Please confirm the Friday delivery.";
const SENDER = "bakery@example.com";
const TARGET = {
  kind: "supplier_contact",
  supplierId: "supplier_origin",
  contactId: "contact_origin",
  contactRevision: 1,
} as const;
const LIMITS = {
  maxActiveCases: 5,
  maxMessagesPerHour: 20,
  dailyTokenBudget: 100000,
  maxMessageBytes: 262144,
  maxAttachmentBytes: 5242880,
  debounce: { kind: "push_triggered", coalesceSeconds: 30 },
} as const;
type Boundary =
  "search_response" | "reply_response" | "compose_commit" | "self_test_freeze";
type Journey = {
  readonly boundary: Boundary;
  readonly accountId: IntegrationAccountId;
  readonly accountRef: IntegrationAccountReference;
  readonly encrypt: SubtleCrypto["encrypt"];
  phase: "armed" | "paused" | "released";
  modelRequests: number;
  providerReads: number;
  providerDrafts: number;
  toolIssued: boolean;
  discoveryRequests: number;
};
let activeJourney: Journey | null = null;

it.for([
  "search_response",
  "reply_response",
  "compose_commit",
  "self_test_freeze",
] as const)(
  "fences mail %s, retains issued drafts and recovers without repeated provider effects",
  { timeout: 45_000 },
  mailOriginJourney,
);

async function mailOriginJourney(
  boundary: Boundary,
  { task }: TestContext,
): Promise<void> {
  const { accountId, session, fresh, connector } = await fixture();
  const journey: Journey = {
    boundary,
    accountId,
    accountRef: await integrationAccountReference(
      ORGANISATION_ID,
      accountId,
      "integration_account",
    ),
    encrypt: crypto.subtle.encrypt,
    phase: "armed",
    modelRequests: 0,
    providerReads: 0,
    providerDrafts: 0,
    toolIssued: false,
    discoveryRequests: 0,
  };
  activeJourney = journey;
  crypto.subtle.encrypt = pauseComposeCommit;
  const withSession = fixtureDatabase().withSession.bind(fixtureDatabase());
  const sessionSpy = vi
    .spyOn(fixtureDatabase(), "withSession")
    .mockImplementation(
      interceptSelfTestSession.bind(null, journey, withSession),
    );
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToModel.bind(null, journey),
    ),
    http.all(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      respondToProvider.bind(null, journey),
    ),
  );
  const pending = dispatch(session, `p55_mail_${boundary}`);
  try {
    await expect
      .poll(currentPhase.bind(null, journey), { timeout: 15_000 })
      .toBe("paused");
    const origin = await fixtureDatabase()
      .prepare(
        "SELECT session_id, turn_id FROM session_turn_access WHERE organisation_id = ? AND control_session_id = ?",
      )
      .bind(ORGANISATION_ID, session.session.controlSessionId)
      .first<{ session_id: string; turn_id: string }>();
    if (origin === null) throw new Error("Missing admitted mail origin");
    const sessionId = parseSessionId(origin.session_id);
    if (!sessionId.ok) throw new Error(sessionId.error.code);
    const actor = required(
      await resolveActiveSessionActor({
        env,
        namespace: env.SESSION,
        organisationId: ORGANISATION_ID,
        sessionId: sessionId.value,
        now: Date.now(),
      }),
    );
    const admittedRequests = journey.modelRequests;
    const issuedReads = journey.providerReads;
    const issuedDrafts = journey.providerDrafts;
    if (boundary === "self_test_freeze") {
      for (const database of [env.DB, fixtureDatabase()])
        await database
          .prepare(
            "UPDATE organisation_placement SET status = 'frozen', frozen_at = ? WHERE organisation_id = ? AND status = 'active'",
          )
          .bind(Date.now(), ORGANISATION_ID)
          .run();
    } else {
      await env.DB.prepare(
        "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
      )
        .bind(Date.now(), session.session.controlSessionId)
        .run();
    }
    journey.phase = "released";
    const denied = await pending;
    expect(denied.status).toBe(503);
    expect(await denied.text()).not.toContain(PROVIDER_TEXT);
    expect(journey.modelRequests).toBe(admittedRequests);
    expect(journey.providerReads).toBe(issuedReads);
    expect(journey.providerDrafts).toBe(issuedDrafts);
    const retained = await runInDurableObject(
      actor,
      readSessionState.bind(null, accountId),
    );
    expect(retained.history).not.toContain(PROVIDER_TEXT);
    expect(retained.providerObservations).toBe(0);
    expect(await proposalProjectionCount()).toBe(0);
    expect(await selfTestCount(ORGANISATION_ID)).toBe(0);
    const receipts = await runInDurableObject(connector, readConnectorState);
    expect(receipts.drafts).toBe(boundary === "reply_response" ? 1 : 0);
    expect(receipts.operational).toBe(0);
    await evictDurableObject(actor);
    await evictDurableObject(connector);
    expect(
      await runInDurableObject(actor, readSessionState.bind(null, accountId)),
    ).toEqual(retained);
    expect(await runInDurableObject(connector, readConnectorState)).toEqual(
      receipts,
    );
    if (boundary === "self_test_freeze")
      for (const database of [env.DB, fixtureDatabase()])
        await database
          .prepare(
            "UPDATE organisation_placement SET status = 'active', frozen_at = NULL WHERE organisation_id = ? AND status = 'frozen'",
          )
          .bind(ORGANISATION_ID)
          .run();
    expect((await dispatch(fresh, `p55_mail_${boundary}`)).status).toBe(503);
    expect(journey.providerReads).toBe(issuedReads);
    expect(journey.providerDrafts).toBe(issuedDrafts);
    journey.toolIssued = false;
    const allowed = await dispatch(fresh, `p55_mail_${boundary}_fresh`);
    expect(allowed.status).toBe(200);
    await allowed.arrayBuffer();
    if (boundary.startsWith("reply")) {
      expect(journey.providerDrafts).toBe(issuedDrafts + 1);
      expect(await proposalProjectionCount()).toBe(1);
    } else if (
      boundary === "compose_commit" ||
      boundary.startsWith("self_test")
    ) {
      expect(
        (await runInDurableObject(connector, readConnectorState)).operational,
      ).toBe(1);
      expect(await proposalProjectionCount()).toBe(1);
      expect(journey.providerReads + journey.providerDrafts).toBe(0);
      expect(await selfTestCount(ORGANISATION_ID)).toBe(
        boundary.startsWith("self_test") ? 1 : 0,
      );
      if (boundary.startsWith("self_test")) {
        const recipient = await fixtureDatabase()
          .prepare(
            "SELECT self_test_id AS selfTestId, case_id AS caseId, expires_at AS expiresAt FROM email_self_test WHERE organisation_id = ?",
          )
          .bind(ORGANISATION_ID)
          .first<{ selfTestId: string; caseId: string; expiresAt: number }>();
        if (recipient === null)
          throw new Error("Missing authorized self-test recipient");
        const recipientInput = {
          db: fixtureDatabase(),
          organisationId: ORGANISATION_ID,
          integrationAccountId: accountId,
          proposalId: recipient.selfTestId,
          caseId: recipient.caseId,
          now: Date.now(),
          target: {
            kind: "self_test" as const,
            selfTestId: recipient.selfTestId,
          },
        };
        expect(
          await resolveEmailProposalRecipient(recipientInput),
        ).toMatchObject({ ok: true, value: { address: SENDER } });
        expect(
          (
            await resolveEmailProposalRecipient({
              ...recipientInput,
              caseId: "case_other_recipient",
            })
          ).ok,
        ).toBe(false);
        expect(
          (
            await resolveEmailProposalRecipient({
              ...recipientInput,
              now: recipient.expiresAt,
            })
          ).ok,
        ).toBe(false);
      }
    } else {
      expect(journey.providerReads).toBe(issuedReads + 2);
      const freshOrigin = await fixtureDatabase()
        .prepare(
          "SELECT session_id FROM session_turn_access WHERE organisation_id = ? AND control_session_id = ?",
        )
        .bind(ORGANISATION_ID, fresh.session.controlSessionId)
        .first<{ session_id: string }>();
      if (freshOrigin === null) throw new Error("Missing fresh mail origin");
      const freshActor = required(
        await resolveActiveSessionActor({
          env,
          namespace: env.SESSION,
          organisationId: ORGANISATION_ID,
          sessionId: required(parseSessionId(freshOrigin.session_id)),
          now: Date.now(),
        }),
      );
      const observed = await runInDurableObject(
        freshActor,
        readSessionState.bind(null, accountId),
      );
      expect(observed.providerObservations).toBe(1);
      expect(observed.history).toContain(PROVIDER_TEXT);
    }
    Object.assign(task.meta, {
      mailOriginAcceptance: {
        boundary,
        issuedReads,
        issuedDrafts,
        requestsAfterRevocation: 0,
        protectedObservationsAfterRevocation: retained.providerObservations,
        revokedProposalProjections: 0,
        retainedDraftReceipts: receipts.drafts,
        evictedStateRetained: true,
        duplicateProviderEffects: 0,
        authorizedFreshCommandCompleted: true,
        selfTestRegistrationsAfterRevocation: 0,
      },
    });
  } finally {
    journey.phase = "released";
    crypto.subtle.encrypt = journey.encrypt;
    sessionSpy.mockRestore();
    activeJourney = null;
    await pending;
  }
}

function required<Value>(
  result: { ok: true; value: Value } | { ok: false; error: unknown },
): Value {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
function currentPhase(journey: Journey) {
  return journey.phase;
}
function interceptSelfTestSession(
  journey: Journey,
  withSession: OrganisationDatabase["withSession"],
  constraint?: D1SessionBookmark | D1SessionConstraint,
): OrganisationDatabaseSession {
  const session = withSession(constraint);
  if (journey.boundary.startsWith("self_test") && journey.phase === "armed") {
    const prepare = session.prepare.bind(session);
    vi.spyOn(session, "prepare").mockImplementation(
      interceptSelfTestStatement.bind(null, journey, prepare),
    );
  }
  return session;
}
function interceptSelfTestStatement(
  journey: Journey,
  prepare: OrganisationDatabaseSession["prepare"],
  query: string,
): OrganisationStatement {
  const statement = prepare(query);
  if (
    query.includes("DELETE FROM email_self_test") &&
    query.includes("expires_at <=")
  ) {
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation(
      interceptSelfTestBinding.bind(null, journey, bind),
    );
  }
  return statement;
}
function interceptSelfTestBinding(
  journey: Journey,
  bind: D1PreparedStatement["bind"],
  ...values: unknown[]
): D1PreparedStatement {
  const statement = bind(...values);
  const run = statement.run.bind(statement);
  vi.spyOn(statement, "run").mockImplementation(
    pauseSelfTestCleanup.bind(null, journey, run),
  );
  return statement;
}
async function pauseSelfTestCleanup<T>(
  journey: Journey,
  run: D1PreparedStatement["run"],
): Promise<D1Result<T>> {
  const result = await run<T>();
  if (journey.phase === "armed") await pause(journey);
  return result;
}
async function pause(journey: Journey): Promise<void> {
  journey.phase = "paused";
  while (journey.phase === "paused") await scheduler.wait(5);
}
async function pauseComposeCommit(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["encrypt"]>[0],
  key: Parameters<SubtleCrypto["encrypt"]>[1],
  data: Parameters<SubtleCrypto["encrypt"]>[2],
): Promise<ArrayBuffer> {
  const journey = activeJourney;
  if (journey === null) throw new Error("Missing mail compose pause");
  const sealed = await journey.encrypt.call(this, algorithm, key, data);
  let content: unknown;
  try {
    content = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return sealed;
  }
  if (
    journey.phase === "armed" &&
    journey.boundary === "compose_commit" &&
    isRecord(content) &&
    Object.keys(content).length === 2 &&
    content.subject === "Friday delivery" &&
    content.body === BODY
  )
    await pause(journey);
  return sealed;
}
function toolHasName(name: string, tool: unknown): boolean {
  return (
    isRecord(tool) && isRecord(tool.function) && tool.function.name === name
  );
}
async function respondToModel(
  journey: Journey,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  journey.modelRequests++;
  const body: unknown = await request.json();
  if (!isRecord(body) || !Array.isArray(body.tools))
    throw new Error("Missing mail tools");
  if (journey.toolIssued)
    return openRouterText(
      JSON.stringify({ kind: "reply", text: "Mail request completed." }),
      "mail_done",
    );
  const name = journey.boundary.startsWith("search")
    ? "email_mailbox_search"
    : journey.boundary.startsWith("reply")
      ? "email_reply_propose"
      : "email_operational_propose";
  if (!body.tools.some(toolHasName.bind(null, name))) {
    if (++journey.discoveryRequests > 8)
      throw new Error("Mail discovery did not complete");
    return openRouterToolCall(
      "tool_search",
      { query: name, limit: 1 },
      `mail_discover_${journey.discoveryRequests}`,
    );
  }
  journey.toolIssued = true;
  switch (name) {
    case "email_mailbox_search":
      return openRouterToolCall(
        name,
        {
          integrationAccountId: journey.accountId,
          query: "from:supplier@example.com",
          limit: 1,
        },
        "mail_search",
      );
    case "email_reply_propose":
      return openRouterToolCall(
        name,
        {
          integrationAccountId: journey.accountId,
          messageId: "m1",
          threadId: "t1",
          body: BODY,
          sources: null,
        },
        "mail_propose",
      );
    case "email_operational_propose":
      return openRouterToolCall(
        name,
        {
          accountRef: journey.accountRef,
          target: journey.boundary.startsWith("self_test")
            ? { kind: "self_test", address: SENDER }
            : { ...TARGET, customerId: null },
          subject: journey.boundary.startsWith("self_test")
            ? EMAIL_SELF_TEST_SUBJECT
            : "Friday delivery",
          body: journey.boundary.startsWith("self_test")
            ? EMAIL_SELF_TEST_BODY
            : BODY,
        },
        "mail_compose",
      );
  }
}
async function respondToProvider(
  journey: Journey,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path.endsWith("/drafts")) {
    journey.providerDrafts++;
    await request.arrayBuffer();
    if (journey.phase === "armed" && journey.boundary === "reply_response")
      await pause(journey);
    return HttpResponse.json({
      id: `draft_${journey.providerDrafts}`,
      message: {
        id: `draft_message_${journey.providerDrafts}`,
        threadId: "t1",
      },
    });
  }
  expect(request.method).toBe("GET");
  journey.providerReads++;
  if (path.endsWith("/messages"))
    return HttpResponse.json({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
  expect(path.endsWith("/messages/m1")).toBe(true);
  if (journey.phase === "armed" && journey.boundary === "search_response")
    await pause(journey);
  return HttpResponse.json({
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX"],
    internalDate: String(Date.now()),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Supplier <supplier@example.com>" },
        { name: "To", value: SENDER },
        { name: "Subject", value: "Friday delivery" },
        { name: "Message-ID", value: "<m1@supplier.example.com>" },
      ],
      body: {
        data: btoa(PROVIDER_TEXT)
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/g, ""),
        size: PROVIDER_TEXT.length,
      },
    },
  });
}
function readSessionState(
  accountId: IntegrationAccountId,
  _actor: unknown,
  state: DurableObjectState,
) {
  return {
    history: JSON.stringify(
      state.storage.sql.exec("SELECT * FROM session_harness_history").toArray(),
    ),
    providerObservations: state.storage.sql
      .exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM session_information_flow_observation WHERE json_extract(evidence_json, '$.source.kind') = 'integration_resource' AND json_extract(evidence_json, '$.source.integrationAccountId') = ?",
        accountId,
      )
      .one().total,
  };
}
function readConnectorState(_actor: unknown, state: DurableObjectState) {
  return state.storage.sql
    .exec<{ drafts: number; operational: number }>(
      "SELECT (SELECT COUNT(*) FROM connector_email_draft) AS drafts, (SELECT COUNT(*) FROM connector_email_operational_proposal) AS operational",
    )
    .one();
}
async function proposalProjectionCount(): Promise<number> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT (SELECT COUNT(*) FROM email_reply_proposal WHERE organisation_id = ?) + (SELECT COUNT(*) FROM email_operational_proposal_projection WHERE organisation_id = ?) AS total",
    )
    .bind(ORGANISATION_ID, ORGANISATION_ID)
    .first<{ total: number }>();
  return row?.total ?? 0;
}
function dispatch(
  session: IssuedControlSession,
  key: string,
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/cases/commands`,
    {
      method: "POST",
      headers: {
        origin: "https://localhost",
        "content-type": "application/json",
        "idempotency-key": key,
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        "x-satyr-csrf": session.csrfToken,
      },
      body: JSON.stringify({
        instruction:
          "Review the supplier's Friday mail and prepare the requested draft.",
      }),
    },
  );
}
function seedMailbox(
  accountId: IntegrationAccountId,
  now: number,
  _actor: unknown,
  state: DurableObjectState,
): void {
  required(
    activateEmailRuntime(state.storage.sql, {
      organisationId: ORGANISATION_ID,
      integrationAccountId: accountId,
      policyVersion: 1,
      limits: LIMITS,
      activationFloor: "10",
      watchExpiresAt: now + 86400000,
      now,
    }),
  );
  // Start with a caught-up mailbox so only the Session issues provider requests.
  expect(claimDueEmailEvaluation(state.storage.sql, now).kind).toBe("due");
  completeEmailEvaluation(state.storage.sql, { acceptedHistoryId: "10", now });
}
async function fixture() {
  await installSlackActorFixture();
  const now = Date.now();
  const userId = required(
    parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab"),
  );
  // Only the actor becomes an administrator: the fixture's owner must stay,
  // because an Organisation keeps at least one owner.
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "UPDATE service_role_grant SET role = 'admin' WHERE organisation_id = ? AND user_id = ?",
      )
      .bind(ORGANISATION_ID, userId),
    fixtureDatabase()
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'receipt_mail_origin', activated_at = ? WHERE organisation_id = ?",
      )
      .bind(now, ORGANISATION_ID),
    fixtureDatabase()
      .prepare(
        "UPDATE workspace_ai_budget SET max_tokens = 128000, previous_limits_json = json_set(previous_limits_json, '$.maxTokens', 128000) WHERE organisation_id = ?",
      )
      .bind(ORGANISATION_ID),
  ]);
  const handle = required(parseVaultHandle("vault:gmail:p55-session-origin"));
  required(
    await storeVaultSecret({
      db: fixtureDatabase(),
      keys: env,
      organisationId: ORGANISATION_ID,
      handle,
      secret: {
        kind: "oauth_tokens",
        accessToken: TOKEN,
        refreshToken: "fixture-refresh",
        expiry: { kind: "expires", expiresAt: now + 3600000 },
      },
      now,
    }),
  );
  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId: ORGANISATION_ID,
    provider: "gmail",
    authorizationProduct: "full_mailbox_pilot",
    providerSubjectId: "google_mail_origin",
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef: handle },
    grantedScopes: GMAIL_FULL_MAILBOX_SCOPES,
    createdByUserId: userId,
    providerAccountId: "gmail_mail_origin",
    accountKind: "mailbox",
    displayName: "Bakery mailbox",
    capabilities: [
      CAPABILITY_KEYS.emailMailboxRead,
      CAPABILITY_KEYS.emailReplyPropose,
      CAPABILITY_KEYS.emailOperationalPropose,
    ],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const accountId = connected.account.integrationAccountId;
  const commands: readonly AgentOperationCommand[] = [
    {
      kind: "create_area",
      operationId: "area_mail_origin",
      actorUserId: userId,
      now,
      name: "Purchasing",
      purpose: "Supplier mail",
    },
    {
      kind: "create_agent_definition",
      operationId: "agent_mail_origin",
      actorUserId: userId,
      now,
      displayName: "Supplier agent",
      role: "research",
      purpose: "Supplier mail",
      instructions: "Review supplier delivery mail",
      requestedCapabilities: [],
      skillRefs: [],
    },
    {
      kind: "install_agent",
      operationId: "installation_mail_origin",
      actorUserId: userId,
      now,
      agentDefinitionId: "agent_mail_origin",
      definitionRevision: 1,
      areaId: "area_mail_origin",
      responsibility: "Purchasing",
      scopeIds: [],
      policyRevision: 1,
      grantedCapabilities: [],
    },
  ];
  for (const command of commands)
    required(
      await applyAgentOperation(fixtureDatabase(), ORGANISATION_ID, command),
    );
  required(
    await registerEmailMailboxAccount({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      integrationAccountId: accountId,
      environment: "development",
      googleSubject: "google_mail_origin",
      observedAddress: SENDER,
      now,
    }),
  );
  required(
    await assignAgentMailbox({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      integrationAccountId: accountId,
      mailboxBindingId: "binding_mail_origin",
      installationId: "installation_mail_origin",
      grantsDigest: "b".repeat(64),
      policyDigest: "c".repeat(64),
      createdBy: userId,
      now,
    }),
  );
  required(
    await publishMailboxIngressPolicy({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      integrationAccountId: accountId,
      environment: "development",
      request: { kind: "enabled", ...LIMITS, overflow: "pause_and_notify" },
      publishedBy: userId,
      now,
    }),
  );
  required(
    await registerEmailSenderAccount({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      integrationAccountId: accountId,
      environment: "development",
      googleSubject: "google_mail_origin",
      observedAddress: SENDER,
      now,
    }),
  );
  required(
    await registerOperationalEmailContact({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      target: TARGET,
      address: "supplier@example.com",
      displayName: "Supplier",
      state: "active",
      relationshipState: "active",
      now,
    }),
  );
  await createRequiredGrant({
    grantId: "grant_mail_context",
    subject: { kind: "organisation_role", role: "admin" },
    target: {
      kind: "platform_capability",
      capabilityId: CAPABILITY_KEYS.contextCaseRead,
      capabilityVersion: 1,
    },
    now,
  });
  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  for (const capabilityId of [
    CAPABILITY_KEYS.emailMailboxRead,
    CAPABILITY_KEYS.emailReplyPropose,
    CAPABILITY_KEYS.emailOperationalPropose,
  ]) {
    await createRequiredGrant({
      grantId: `grant_mail_${capabilityId}`,
      subject: { kind: "organisation_role", role: "admin" },
      target: {
        kind: "provider_resource",
        capabilityId,
        capabilityVersion: 1,
        integrationAccountId: accountId,
        resourceScope:
          capabilityId === CAPABILITY_KEYS.emailOperationalPropose
            ? EMAIL_OPERATIONAL_RESOURCE_SCOPE
            : EMAIL_MAILBOX_RESOURCE_SCOPE,
      },
      now,
    });
    required(
      await writeOrganisationCapabilityPolicy({
        scope,
        write: {
          kind: "change",
          capabilityId,
          expectedRevision: 1,
          mode: "enabled",
          provenance: {
            kind: "operator",
            userId,
            mutationReceiptId: `receipt_mail_${capabilityId}`,
          },
          now,
        },
      }),
    );
  }
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now,
  });
  required(
    await compilePublishAndActivateOrganisationPolicy({
      bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
      organisationId: ORGANISATION_ID,
      organisation,
      now,
    }),
  );
  const connector = required(
    await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId: ORGANISATION_ID,
      connectorId: required(gmailConnectorId(accountId)),
      now,
    }),
  );
  await runInDurableObject(connector, seedMailbox.bind(null, accountId, now));
  return {
    accountId,
    connector,
    session: await issueControlSession({
      db: env.DB,
      userId,
      now,
      ttlMs: 1_800_000,
    }),
    fresh: await issueControlSession({
      db: env.DB,
      userId,
      now,
      ttlMs: 1_800_000,
    }),
  };
}
