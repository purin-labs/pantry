// The Worker the Brain browser journey runs against. Every /v1 request uses
// production routing. The /test routes build the fixture and stand in for
// what the journey cannot reach from a browser: a Gmail push, and the records
// an Actor keeps in its own storage.
import gateway, {
  ConnectorDO as ProductionConnectorDO,
  SessionDO as ProductionSessionDO,
} from "../../services/platform/src/integration-gateway";
import {
  requireActiveOrganisationActor,
  resolveActiveConnectorActor,
  resolveActiveSessionActor,
} from "../../services/platform/src/actors/actor-router";
import { readSessionTurnMemoryRecords } from "../../services/platform/src/actors/actor-journal/transactions";
import {
  acceptEmailHint,
  activateEmailRuntime,
  latestEmailDraftOperation,
  readEmailRuntime,
  type EmailIngressLimits,
} from "../../services/platform/src/actors/connector-email";
import { runConnectorEmailEvaluation } from "../../services/platform/src/actors/connector-email-evaluation";
import { emailTurnSessionId } from "../../services/platform/src/actors/email-case-processing";
import { CONTEXT_CASE_READ_CAPABILITY } from "../../services/platform/src/authorization/access-grants/turn-authority";
import { CAPABILITY_KEYS } from "../../services/platform/src/authorization/capability-catalogue";
import { parseVaultHandle } from "../../services/platform/src/credential-vault/domain";
import { storeVaultSecret } from "../../services/platform/src/credential-vault";
import { createAccessGrant } from "../../services/platform/src/data/access-grants";
import {
  applyAgentOperation,
  type AgentOperationCommand,
} from "../../services/platform/src/data/agent-operations";
import { publishContactVerification } from "../../services/platform/src/data/contact-verification";
import {
  assignAgentMailbox,
  publishMailboxIngressPolicy,
  registerEmailMailboxAccount,
} from "../../services/platform/src/data/email-mailbox";
import {
  gmailConnectorId,
} from "../../services/platform/src/mail-inbox/contract/connector-ids";
import { registerOperationalEmailContact } from "../../services/platform/src/data/email-operational";
import { createActiveConnectedIntegration } from "../../services/platform/src/data/integration-account";
import type { Env } from "../../services/platform/src/env";
import { GMAIL_FULL_MAILBOX_SCOPES } from "../../services/platform/src/mail/gmail-authorization";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  parseSessionId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../../services/platform/src/ids";
import { resolveOrganisationModelRoute } from "../../services/platform/src/models/route";
import { OrganisationExecutionScope } from "../../services/platform/src/organisation-execution-scope";
import { defaultDenyPolicy } from "../../services/platform/src/policy-snapshot";
import { fixturePeople } from "./account-authority";

export {
  OrganisationDO,
  CaseDO,
  CodeModePlatformGovernorActor,
} from "../../services/platform/src/integration-gateway";

const CONTROL = "https://brain-fixture.internal";
const names = ["Owner", "Other"] as const;
const { fixtureUser, fixtureOrganisation, login } = fixturePeople(
  "",
  "plan42j-browser",
);
const SUPPLIER = "supplier@example.test";
const LIMITS: EmailIngressLimits = {
  maxActiveCases: 5,
  maxMessagesPerHour: 20,
  dailyTokenBudget: 2_000_000,
  maxMessageBytes: 262_144,
  maxAttachmentBytes: 5_242_880,
  debounce: { kind: "push_triggered", coalesceSeconds: 30 },
};

/**
 * The production Connector, with the two things a browser cannot do: deliver
 * a Gmail push whose coalescing delay has passed, and read the Actor's own
 * mail records.
 */
export class ConnectorDO extends ProductionConnectorDO {
  async fixtureActivate(
    input: Readonly<{
      organisationId: string;
      integrationAccountId: string;
      policyVersion: number;
    }>,
  ) {
    return activateEmailRuntime(this.ctx.storage.sql, {
      ...input,
      limits: LIMITS,
      activationFloor: "100",
      watchExpiresAt: Date.now() + 3_600_000,
      now: Date.now(),
    });
  }

  /** One push notification, evaluated on a clock past its coalescing delay. */
  async fixtureAdmit(
    hint: Readonly<{
      notificationId: string;
      historyId: string;
      delay: number;
    }>,
  ) {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    acceptEmailHint(sql, { ...hint, now });
    const runtime = readEmailRuntime(sql);
    if (runtime === null) throw new Error("Mail runtime missing");
    const organisationId = parseOrganisationId(runtime.organisationId);
    if (!organisationId.ok) throw new Error(organisationId.error.code);
    const scope = await OrganisationExecutionScope.resolve(
      this.env,
      organisationId.value,
    );
    if (!scope.ok) throw new Error(scope.error.code);
    const outcome = await runConnectorEmailEvaluation({
      scope: scope.value,
      env: this.env,
      storage: this.ctx.storage,
      now: now + hint.delay,
      fetcher: fetch,
    });
    // The admission ran on the later clock. Its turns are due on this one.
    sql.exec(
      "UPDATE connector_email_reply_turn SET available_at = 0 WHERE claimed_by IS NULL",
    );
    await this.ctx.storage.setAlarm(Date.now());
    return outcome;
  }

  async fixtureMailRecords() {
    const sql = this.ctx.storage.sql;
    return {
      replyTurnsOwed: sql
        .exec<{ messageId: string; attempts: number }>(
          "SELECT provider_message_id AS messageId, attempts FROM connector_email_reply_turn ORDER BY provider_message_id",
        )
        .toArray(),
      learningOwed: sql
        .exec<{ proposalId: string; version: number }>(
          "SELECT proposal_id AS proposalId, version FROM connector_email_correction_learning",
        )
        .toArray(),
      proposals: sql
        .exec<{ proposalId: string }>(
          "SELECT DISTINCT proposal_id AS proposalId FROM connector_email_draft ORDER BY proposal_id",
        )
        .toArray()
        .map(({ proposalId }) => {
          const operation = latestEmailDraftOperation(sql, proposalId);
          return {
            proposalId,
            version: operation?.version ?? null,
            state: operation?.state ?? null,
            triggeringMessageId: operation?.triggeringMessageId ?? null,
          };
        }),
    };
  }
}

/** The production Session, with a reader for what a mail turn recorded. */
export class SessionDO extends ProductionSessionDO {
  async fixtureTurnMemory(
    lookup: Readonly<{
      organisationId: string;
      sessionId: string;
      turnId: string;
    }>,
  ) {
    return readSessionTurnMemoryRecords(this.ctx.storage.sql, lookup);
  }
}

export default {
  queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    return gateway.queue(batch, env);
  },
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/test/health")
      return new Response(null, { status: 204 });
    if (url.pathname === "/test/setup" && request.method === "POST")
      return Response.json(await seed(env));
    if (url.pathname === "/test/session" && request.method === "POST")
      return login(env, names, url.searchParams.get("user"));
    if (url.pathname === "/test/mail/arrive" && request.method === "POST")
      return Response.json(await arrive(env, await request.json()));
    if (url.pathname === "/test/mail/state" && request.method === "GET")
      return Response.json(await mailState(env, url.searchParams));
    return gateway.fetch(request, env, context);
  },
};

type Fixture = Readonly<{
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
}>;

async function readFixture(env: Env): Promise<Fixture> {
  const row = await env.DB.prepare(
    "SELECT organisation_id AS organisationId, integration_account_id AS integrationAccountId FROM integration_account WHERE provider = 'gmail' LIMIT 1",
  ).first<{ organisationId: string; integrationAccountId: string }>();
  const organisationId = parseOrganisationId(row?.organisationId ?? "");
  const integrationAccountId = parseIntegrationAccountId(
    row?.integrationAccountId ?? "",
  );
  if (!organisationId.ok || !integrationAccountId.ok)
    throw new Error("Fixture is not set up");
  return {
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
  };
}

async function connectorOf(env: Env, fixture: Fixture) {
  const connectorId = gmailConnectorId(fixture.integrationAccountId);
  if (!connectorId.ok) throw new Error(connectorId.error.code);
  const connector = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId: fixture.organisationId,
    connectorId: connectorId.value,
    now: Date.now(),
  });
  if (!connector.ok) throw new Error(connector.error.code);
  // The namespace's class is the fixture Connector above.
  return connector.value as unknown as DurableObjectStub<ConnectorDO>;
}

/**
 * One organisation with an owner and a second administrator, a Gmail mailbox
 * that only the owner's role may read, an agent assigned to that mailbox, and
 * one supplier contact whose address is verified for it. Each control request
 * and each mailbox turn of the journey passes Pantry's real access check.
 */
async function seed(env: Env) {
  const now = Date.now();
  const owner = await fixtureUser(env, "Owner");
  const other = await fixtureUser(env, "Other");
  const organisationId = await fixtureOrganisation(
    env,
    owner,
    "Brain acceptance",
  );
  const otherPersonId = `person_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'plan42j-browser', activated_at = ?, updated_at = ? WHERE organisation_id = ?",
    ).bind(now, now, organisationId),
    env.DB.prepare(
      "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, 'Other')",
    ).bind(organisationId, otherPersonId),
    env.DB.prepare(
      "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)",
    ).bind(organisationId, other.userId, otherPersonId, now),
    env.DB.prepare(
      "INSERT INTO organisation_inference_selection (organisation_id, selection_kind, selected_by_user_id, selected_at) VALUES (?, 'pantry_platform', ?, ?)",
    ).bind(organisationId, owner.userId, now),
  ]);
  const policy = defaultDenyPolicy({ now });
  policy.version = 1;
  policy.authz.allowedTools = [
    CAPABILITY_KEYS.emailMailboxRead,
    CONTEXT_CASE_READ_CAPABILITY,
  ];
  policy.authz.maxBudget = {
    maxTokens: 5000,
    maxWallMs: 30000,
    maxToolCalls: 5,
  };
  await env.DB.prepare(
    "INSERT INTO policy_snapshot (organisation_id, version, body, created_at, created_by) VALUES (?, 1, ?, ?, 'plan42j-browser')",
  )
    .bind(organisationId, JSON.stringify(policy), now)
    .run();
  await env.POLICY_KV.put(
    `policy:${organisationId}:latest`,
    JSON.stringify(policy),
  );
  await env.POLICY_KV.put(
    `policy:${organisationId}:v1`,
    JSON.stringify(policy),
  );

  // The mailbox. Only the owner's role holds its read grant.
  const handle = parseVaultHandle(
    `vault:${organisationId.toLowerCase()}:gmail:brain:oauth:g1`,
  );
  if (!handle.ok) throw new Error("Vault handle invalid");
  const stored = await storeVaultSecret({
    db: env.DB,
    keys: env,
    organisationId,
    handle: handle.value,
    now,
    secret: {
      kind: "oauth_tokens",
      accessToken: "plan42j-browser-token",
      refreshToken: "plan42j-browser-refresh",
      expiry: { kind: "expires", expiresAt: now + 3_600_000 },
    },
  });
  if (!stored.ok) throw new Error(stored.error.code);
  const connected = await createActiveConnectedIntegration(env.DB, {
    organisationId,
    provider: "gmail",
    authorizationProduct: "full_mailbox_pilot",
    providerSubjectId: "brain",
    environment: "development",
    authMode: "shared_pantry_app",
    authority: { kind: "connection_credential", credentialRef: handle.value },
    grantedScopes: GMAIL_FULL_MAILBOX_SCOPES,
    createdByUserId: owner.userId,
    providerAccountId: "brain",
    accountKind: "mailbox",
    displayName: "brain",
    capabilities: [CAPABILITY_KEYS.emailMailboxRead],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const account = parseIntegrationAccountId(
    connected.account.integrationAccountId,
  );
  if (!account.ok) throw new Error(account.error.code);
  const grants = [
    await createAccessGrant({
      db: env.DB,
      organisationId,
      grantId: "grant_mail_brain",
      subject: { kind: "organisation_role", role: "owner" },
      target: {
        kind: "provider_resource",
        capabilityId: CAPABILITY_KEYS.emailMailboxRead,
        capabilityVersion: 1,
        integrationAccountId: account.value,
        resourceScope: "mailbox",
      },
      provenance: {
        kind: "baseline",
        profile: "read_and_propose",
        profileVersion: 1,
        materializationReceiptId: "plan42j-browser",
      },
      now,
    }),
    await createAccessGrant({
      db: env.DB,
      organisationId,
      grantId: "grant_brain_agent_context",
      now,
      subject: {
        kind: "agent_mailbox",
        integrationAccountId: account.value,
        mailboxBindingId: "binding_work",
        bindingRevision: 1,
      },
      target: {
        kind: "platform_capability",
        capabilityId: CONTEXT_CASE_READ_CAPABILITY,
        capabilityVersion: 1,
      },
      provenance: {
        kind: "baseline",
        profile: "read_and_propose",
        profileVersion: 1,
        materializationReceiptId: "plan42j-browser",
      },
    }),
  ];
  for (const granted of grants)
    if (!granted.ok) throw new Error(granted.error.code);
  const registered = await registerEmailMailboxAccount({
    db: env.DB,
    organisationId,
    integrationAccountId: account.value,
    environment: "development",
    googleSubject: "brain",
    observedAddress: "shop@example.test",
    now,
  });
  if (!registered.ok) throw new Error(registered.error.code);

  // The agent that answers the mailbox.
  const commands: AgentOperationCommand[] = [
    {
      kind: "create_area",
      operationId: "area_work",
      actorUserId: owner.userId,
      now,
      name: "Purchasing",
      purpose: "Supplier mail",
    },
    {
      kind: "create_agent_definition",
      operationId: "agent_work",
      actorUserId: owner.userId,
      now,
      displayName: "Supplier agent",
      role: "research",
      purpose: "Supplier mail",
      instructions: "Answer supplier messages about orders.",
      requestedCapabilities: [],
      skillRefs: [],
    },
    {
      kind: "install_agent",
      operationId: "installation_work",
      actorUserId: owner.userId,
      now,
      agentDefinitionId: "agent_work",
      definitionRevision: 1,
      areaId: "area_work",
      responsibility: "Purchasing",
      scopeIds: [],
      policyRevision: 1,
      grantedCapabilities: [],
    },
  ];
  for (const command of commands) {
    const applied = await applyAgentOperation(env.DB, organisationId, command);
    if (!applied.ok) throw new Error(applied.error.code);
  }
  const assigned = await assignAgentMailbox({
    db: env.DB,
    organisationId,
    integrationAccountId: account.value,
    mailboxBindingId: "binding_work",
    installationId: "installation_work",
    grantsDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    createdBy: owner.userId,
    now,
  });
  if (!assigned.ok) throw new Error(assigned.error.code);

  // The merchant the supplier belongs to, and the supplier's verified address.
  const merchantId = `merchant_brain_${crypto.randomUUID()}`;
  const connectionId = `provider_connection_${crypto.randomUUID()}`;
  const merchantAccountId = `integration_${crypto.randomUUID()}`;
  const bindingId = `commerce_binding_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO provider_connection (provider_connection_id, organisation_id, provider, auth_mode, authority_kind, credential_generation, credential_ref, provider_application, application_credential_generation, asset_grant_revision, lifecycle, granted_scopes, created_by_user_id, created_at, updated_at, disabled_at, revoked_at, environment, provider_subject_id) VALUES (?, ?, 'commerce', 'api_key', 'connection_credential', 1, 'vault:brain:purchasing:browser', NULL, NULL, NULL, 'active', '[]', ?, ?, ?, NULL, NULL, 'development', '')`,
    ).bind(connectionId, organisationId, owner.userId, now, now),
    env.DB.prepare(
      `INSERT INTO integration_account (integration_account_id, organisation_id, provider_connection_id, provider, provider_account_id, account_kind, display_name, lifecycle, lifecycle_reason_code, capability_set, audience_policy, retention_policy, created_at, updated_at, disabled_by_user_id, disabled_at, revoked_at, environment, is_default_for_provider) VALUES (?, ?, ?, 'commerce', ?, 'merchant', 'Brain acceptance', 'active', NULL, '[]', '{}', '{}', ?, ?, NULL, NULL, NULL, 'development', 0)`,
    ).bind(
      merchantAccountId,
      organisationId,
      connectionId,
      merchantId,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO commerce_merchant_binding (binding_id, organisation_id, integration_account_id, merchant_id, environment, delivery_signing_key_id, delivery_signing_public_key_b64, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 'development', 'key_brain_browser', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1, ?, ?)`,
    ).bind(bindingId, organisationId, merchantAccountId, merchantId, now, now),
    env.DB.prepare(
      `INSERT INTO organisation_commerce_system (organisation_id, system_kind, commerce_binding_id, shopify_integration_account_id, revision, selected_at, selected_by_user_id) VALUES (?, 'builtin_commerce', ?, NULL, 1, ?, ?)`,
    ).bind(organisationId, bindingId, now, owner.userId),
  ]);
  const target = {
    kind: "supplier_contact" as const,
    supplierId: "supplier_flour",
    contactId: "contact_flour",
    contactRevision: 1,
  };
  const contact = await registerOperationalEmailContact({
    db: env.DB,
    organisationId,
    target,
    address: SUPPLIER,
    displayName: "Flour supplier",
    state: "active",
    relationshipState: "active",
    now,
  });
  if (!contact.ok) throw new Error(contact.error.code);
  const verified = await publishContactVerification({
    db: env.DB,
    organisationId,
    actorId: owner.userId,
    now,
    command: {
      kind: "verify",
      commandId: "verify_flour",
      verificationId: "verification_flour",
      expectedRevision: 0,
      integrationAccountId: account.value,
      target,
      endpoint: { channel: "gmail", address: SUPPLIER },
      evidenceRef: "synthetic:verified-supplier",
    },
  });
  if (!verified.ok) throw new Error(verified.error.code);

  // Mail processing for the mailbox, and leave to send its mail to the model.
  const published = await publishMailboxIngressPolicy({
    db: env.DB,
    organisationId,
    integrationAccountId: account.value,
    environment: "development",
    publishedBy: owner.userId,
    now,
    request: { kind: "enabled", ...LIMITS, overflow: "pause_and_notify" },
  });
  if (!published.ok || published.value.kind !== "enabled")
    throw new Error("Mailbox ingress policy missing");
  const route = await resolveOrganisationModelRoute({
    env,
    organisationId,
    now,
  });
  if (!route.ok) throw new Error(route.error.code);
  await env.DB.prepare(
    "INSERT INTO gmail_inference_eligibility (organisation_id, key_source, provider, model, evidence_reference, evidence_owner, disclosed_recipients, permitted_purpose, consent_reference, reviewed_at, review_expires_at, consented_at, revoked_at) VALUES (?, ?, ?, ?, 'synthetic-plan42j-browser', 'synthetic-reviewer', 'openrouter', 'email_processing', 'synthetic-consent', ?, ?, ?, NULL)",
  )
    .bind(
      organisationId,
      route.value.keySource,
      route.value.provider,
      route.value.model,
      now,
      now + 3_600_000,
      now,
    )
    .run();
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now,
  });
  await organisation.ensureOrganisation({
    organisationId,
    name: "Brain acceptance",
    plan: "beta",
    status: "active",
    createdAt: now,
  });
  const fixture = { organisationId, integrationAccountId: account.value };
  const activated = await (
    await connectorOf(env, fixture)
  ).fixtureActivate({
    organisationId,
    integrationAccountId: account.value,
    policyVersion: published.value.policyVersion,
  });
  if (!activated.ok) throw new Error(activated.error.code);
  return {
    organisationId,
    integrationAccountId: account.value,
    merchantId,
    supplierId: target.supplierId,
    supplierAddress: SUPPLIER,
    users: { Owner: owner.userId, Other: other.userId },
  };
}

/** Gmail receives mail and pushes a notification. The Connector admits it. */
async function arrive(env: Env, raw: unknown) {
  const body = raw as {
    historyId: number;
    notificationId: string;
    delay: number;
    messages: readonly { id: string; threadId: string; from: string }[];
  };
  const delivered = await fetch(`${CONTROL}/arrive`, {
    method: "POST",
    body: JSON.stringify({
      historyId: body.historyId,
      messages: body.messages.map((message) => ({
        ...message,
        body: "Can we still change tomorrow's order?",
      })),
    }),
  });
  if (!delivered.ok) throw new Error("Provider refused the mail");
  const fixture = await readFixture(env);
  const outcome = await (
    await connectorOf(env, fixture)
  ).fixtureAdmit({
    notificationId: body.notificationId,
    historyId: String(body.historyId + 1),
    delay: body.delay,
  });
  await fetch(`${CONTROL}/settled`, { method: "POST" });
  return outcome;
}

/**
 * What the Connector and the providers hold, and, for one named turn, what
 * its Session recorded about Memory before it asked the model.
 */
async function mailState(env: Env, query: URLSearchParams) {
  const fixture = await readFixture(env);
  const connector = await connectorOf(env, fixture);
  const provider = await (await fetch(`${CONTROL}/state`)).json();
  const threadId = query.get("thread");
  const messageId = query.get("message");
  let turnMemory: unknown = null;
  if (threadId !== null && messageId !== null) {
    const caseId = `case_gmail_${fixture.integrationAccountId}_${threadId}`;
    const sessionId = parseSessionId(emailTurnSessionId(caseId, messageId));
    if (!sessionId.ok) throw new Error(sessionId.error.code);
    const session = await resolveActiveSessionActor({
      env,
      namespace: env.SESSION,
      organisationId: fixture.organisationId,
      sessionId: sessionId.value,
      now: Date.now(),
    });
    turnMemory = session.ok
      ? await (
          session.value as unknown as DurableObjectStub<SessionDO>
        ).fixtureTurnMemory({
          organisationId: fixture.organisationId,
          sessionId: sessionId.value,
          turnId: `turn_email_${messageId}`,
        })
      : { ok: false, error: session.error };
  }
  return {
    connector: await connector.fixtureMailRecords(),
    provider,
    turnMemory,
  };
}
