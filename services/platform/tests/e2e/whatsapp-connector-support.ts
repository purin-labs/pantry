import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
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
import { fixtureDatabase } from "./organisation-database";
import {
  installSlackActorFixture,
  ORGANISATION_ID,
} from "./slack-journey-support";

/**
 * One active WhatsApp number with one open Case, a customer message and one
 * agent proposal that waits for approval. The Connector, the integration and
 * the policy come from the same authorities that onboarding uses.
 */

export const PHONE_NUMBER_ID = "510000000000055";
export const CUSTOMER_ID = "819000000055";
export const PROPOSAL_ID = "proposal_p55_whatsapp";
export const REPLY = "Your bakery order is ready for collection.";
export const TOKEN = "fixture-whatsapp-placement-token";
export const MESSAGE_ID = "wamid.P55_DELIVERED";

export type Fixture = {
  readonly connector: DurableObjectStub<ConnectorDO>;
  readonly identity: ConnectorIdentity & { readonly connectorId: ConnectorId };
  readonly integrationAccountId: IntegrationAccountId;
  readonly caseId: string;
  readonly now: number;
  readonly policyVersion: number;
  /** The Organisation's owner, signed in to the Portal. */
  readonly owner: IssuedControlSession;
  /** The customer's message in the open Case. */
  readonly customerText: string;
};

export type FixtureOptions = Readonly<{
  customerText?: string;
  /** The agent's draft that waits for approval. */
  reply?: string;
  /**
   * Select the number and project the draft, as setup and the agent's turn
   * do, so that the Portal Inbox lists the conversation.
   */
  inbox?: boolean;
}>;

export async function installFixture(
  options: FixtureOptions = {},
): Promise<Fixture> {
  const { ownerSession } = await installSlackActorFixture();
  await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const now = Date.now();
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'activation_p55_whatsapp', activated_at = ?, updated_at = ? WHERE organisation_id = ?",
    )
    .bind(now, now, ORGANISATION_ID)
    .run();
  const userId = required(parseUserId(ownerSession.session.userId));
  const handle = required(parseVaultHandle("vault:whatsapp:p55-placement"));
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
    providerSubjectId: "410000000000055",
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef: handle },
    grantedScopes: ["whatsapp_business_messaging"],
    createdByUserId: userId,
    providerAccountId: PHONE_NUMBER_ID,
    accountKind: "phone_number",
    displayName: "Placement bakery",
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
        parseMetaBusinessPortfolioId("310000000000055"),
      ),
      wabaId: required(parseWhatsAppBusinessAccountId("410000000000055")),
      phoneNumberId: required(parseWhatsAppPhoneNumberId(PHONE_NUMBER_ID)),
      displayPhoneNumber: required(parseE164PhoneNumber("+819000000055")),
      verifiedName: "Placement bakery",
      now,
    }),
  );
  if (options.inbox === true)
    await fixtureDatabase()
      .prepare(
        "UPDATE whatsapp_phone_number_account SET selected_at = ? WHERE integration_account_id = ?",
      )
      .bind(now, integrationAccountId)
      .run();
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO agent_definition (agent_definition_id, organisation_id, display_name, role, purpose, lifecycle, current_revision, created_by_user_id, created_at, updated_at) VALUES ('definition_p55_whatsapp', ?, 'Support', 'assistant', 'customer support', 'active', 1, ?, ?, ?)",
      )
      .bind(ORGANISATION_ID, userId, now, now),
    fixtureDatabase()
      .prepare(
        "INSERT INTO agent_definition_revision (agent_definition_id, organisation_id, revision, instructions, requested_capabilities_json, skill_refs_json, content_digest, authored_by_user_id, created_at) VALUES ('definition_p55_whatsapp', ?, 1, 'Answer bakery questions', '[]', '[]', ?, ?, ?)",
      )
      .bind(ORGANISATION_ID, "d".repeat(64), userId, now),
    fixtureDatabase()
      .prepare(
        "INSERT INTO agent_installation (installation_id, organisation_id, agent_definition_id, definition_revision, policy_revision, granted_capabilities_json, lifecycle, created_by_user_id, created_at, updated_at) VALUES ('installation_p55_whatsapp', ?, 'definition_p55_whatsapp', 1, 1, '[]', 'active', ?, ?, ?)",
      )
      .bind(ORGANISATION_ID, userId, now, now),
  ]);
  const binding = required(
    await assignWhatsAppSupportAgent({
      scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
      integrationAccountId,
      supportBindingId: "binding_p55_whatsapp",
      installationId: "installation_p55_whatsapp",
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
    customerText: options.customerText ?? "Is my order ready?",
  };
  const reply = options.reply ?? REPLY;
  await runInDurableObject(connector, seedProposal.bind(null, fixture, reply));
  if (options.inbox === true)
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
  reply: string,
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
    providerMessageId: "wamid.P55_CUSTOMER",
    customerWaId: CUSTOMER_ID,
    providerTimestamp: fixture.now,
    declaredBytes: new TextEncoder().encode(fixture.customerText).byteLength,
    limits: limits(),
    caseIdFor: fixtureCaseId.bind(null, fixture),
    now: fixture.now,
  });
  if (admitted.kind !== "ready") throw new Error(admitted.kind);
  const sealed = await cipher.seal(
    fixture.caseId,
    { kind: "message", providerMessageId: "wamid.P55_CUSTOMER" },
    fixture.customerText,
  );
  commitWhatsAppAdmission(sql, {
    caseId: fixture.caseId,
    providerMessageId: "wamid.P55_CUSTOMER",
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
  await recordAgentDraft(fixture, PROPOSAL_ID, reply, null, state);
}

/**
 * Stores an agent draft for the fixture's Case, as the agent's turn does.
 * Run it in the Connector with `runInDurableObject`. Returns its digest.
 */
export async function recordAgentDraft(
  fixture: Fixture,
  proposalId: string,
  text: string,
  _actor: unknown,
  state: DurableObjectState,
): Promise<string> {
  const cipher = required(
    await createWhatsAppContentCipher({
      root: env.DATA_ENCRYPTION_ROOT,
      organisationId: ORGANISATION_ID,
      integrationAccountId: fixture.integrationAccountId,
    }),
  );
  const bodyDigest = await cipher.digest(text);
  const body = await cipher.seal(
    fixture.caseId,
    { kind: "proposal", proposalId, version: 1 },
    text,
  );
  recordWhatsAppProposal(state.storage.sql, {
    proposalId,
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
  return bodyDigest;
}
function fixtureCaseId(fixture: Fixture): string {
  return fixture.caseId;
}
export function limits(): WhatsAppIngressLimits {
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
export function required<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
