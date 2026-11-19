import type { SingleDatabase } from "../../src/database-handles";
import { requireOrganisationBootstrap } from "../organisation-execution-fixture";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "../fixtures/organisation-placement";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { DatabaseSync } from "node:sqlite";

import { storeVaultSecret } from "../../src/credential-vault";
import { upsertUser } from "../../src/data/control-plane";
import {
  createConnectedIntegration,
  finalizeConnectedIntegrationAccount,
} from "../../src/data/integration-account";
import {
  assignWhatsAppSupportAgent,
  openWhatsAppCaseConversationWindow,
  publishWhatsAppIngressPolicy,
  registerWhatsAppPhoneNumberAccount,
  selectWhatsAppPhoneNumberAccount,
  whatsappConversationWindowCaseId,
} from "../../src/data/whatsapp";
import {
  parseIntegrationAccountId,
  type UserId,
  type IntegrationAccountId,
  type ProviderConnectionId,
  type OrganisationId,
} from "../../src/ids";
import { providerCredentialHandle } from "../../src/provider-lifecycle/provisioning";
import {
  parseE164PhoneNumber,
  parseMetaBusinessPortfolioId,
  parseWhatsAppBusinessAccountId,
  parseWhatsAppCustomerId,
  parseWhatsAppPhoneNumberId,
} from "../../src/whatsapp/identifiers";
import { organisationBootstrapMutation } from "../control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "../fixtures/organisation-placement";
import { d1Database } from "../sqlite-d1";
import {
  FIXTURE_CUSTOMER_WA_ID,
  FIXTURE_DISPLAY_PHONE_NUMBER,
  FIXTURE_PHONE_NUMBER_ID,
  FIXTURE_WABA_ID,
} from "./fixtures";
import { singleDatabaseSchema } from "../../scripts/single-database-schema.mjs";

/**
 * A complete development organisation with one connected WhatsApp phone number, an
 * assigned support agent, a published enabled policy, and one open Case
 * conversationWindow. Nothing here uses live Meta credentials or real customer data.
 */

export const WHATSAPP_TEST_NOW = 1_784_016_325_277;

export type WhatsAppTestWorld = {
  readonly db: SingleDatabase;
  readonly sqlite: DatabaseSync;
  readonly organisationId: OrganisationId;
  readonly userId: UserId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly caseId: string;
  readonly customerWaId: string;
  readonly supportBindingId: string;
  readonly bindingRevision: number;
  readonly policyVersion: number;
};

export function testRootSecret(): SecretsStoreSecret {
  return {
    get: async () => Buffer.alloc(32, 7).toString("base64"),
  } as unknown as SecretsStoreSecret;
}

export function whatsappTestEnvBindings(
  db: SingleDatabase,
): Record<string, unknown> {
  return {
    DB: db,
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
    VAULT_ROOT_V1: testRootSecret(),
    WHATSAPP_APP_ID: "1000000000000001",
    WHATSAPP_APP_SECRET: "fixture-app-secret-not-a-real-credential",
    WHATSAPP_VERIFY_TOKEN: "fixture-verify-token-not-a-real-credential",
    WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: "3000000000000003",
  };
}

export async function createWhatsAppWorld(
  options: {
    readonly now?: number;
    readonly openConversationWindow?: boolean;
    /**
     * Leave the account with no published policy. Plan 32 starts every number
     * disabled, and a world that always publishes one means nothing ever
     * exercises that state.
     */
    readonly publishPolicy?: boolean;
  } = {},
): Promise<WhatsAppTestWorld> {
  const now = options.now ?? WHATSAPP_TEST_NOW;
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(singleDatabaseSchema());
  const db = d1Database(sqlite);
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "whatsapp-owner",
      email: "owner@example.test",
      displayName: "WhatsApp owner",
      emailVerified: true,
    },
    now,
  });
  const userId = owner.userId;
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "WhatsApp Development Organisation",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, now),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now,
  });
  const organisationId = organisation.organisationId;
  await db
    .prepare(
      `UPDATE organisation_onboarding
        SET lifecycle = 'active', activation_receipt_id = 'activation_whatsapp_fixture',
            activated_at = ?, updated_at = ?
      WHERE organisation_id = ?`,
    )
    .bind(now, now, organisationId)
    .run();
  const credentialRef = providerCredentialHandle(
    organisationId,
    "whatsapp",
    FIXTURE_WABA_ID,
    now,
  );
  const storedCredential = await storeVaultSecret({
    db,
    keys: {
      PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
      VAULT_ROOT_V1: testRootSecret(),
    },
    organisationId,
    handle: credentialRef,
    secret: {
      kind: "expiring_bearer",
      value: "fixture-customer-business-token",
      expiresAt: now + 60 * 24 * 60 * 60 * 1_000,
    },
    now,
  });
  if (!storedCredential.ok) throw new Error(storedCredential.error.code);
  const connected = await createConnectedIntegration(db, {
    organisationId,
    provider: "whatsapp",
    providerSubjectId: FIXTURE_WABA_ID,
    environment: "development",
    authMode: "shared_satyr_app",
    authority: {
      kind: "connection_credential",
      credentialRef,
    },
    grantedScopes: [
      "whatsapp_business_management",
      "whatsapp_business_messaging",
      "business_management",
    ],
    createdByUserId: userId,
    providerAccountId: FIXTURE_PHONE_NUMBER_ID,
    accountKind: "phone_number",
    displayName: "Synthetic Bakery",
    capabilities: ["whatsapp.support.ingress"],
    audiencePolicy: { kind: "customer", consentRequired: true },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const integrationAccountId = connected.account.integrationAccountId;
  const registered = await registerWhatsAppPhoneNumberAccount({
    db,
    organisationId,
    integrationAccountId,
    providerConnectionId: connected.connection.providerConnectionId,
    environment: "development",
    businessPortfolioId: require_(
      parseMetaBusinessPortfolioId("310000000000001"),
    ),
    wabaId: require_(parseWhatsAppBusinessAccountId(FIXTURE_WABA_ID)),
    phoneNumberId: require_(
      parseWhatsAppPhoneNumberId(FIXTURE_PHONE_NUMBER_ID),
    ),
    displayPhoneNumber: require_(
      parseE164PhoneNumber(FIXTURE_DISPLAY_PHONE_NUMBER),
    ),
    verifiedName: "Synthetic Bakery",
    now,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  // Discovery alone claims nothing. The world models a number its owner has
  // already selected, which is what every downstream test needs.
  const selected = await selectWhatsAppPhoneNumberAccount({
    db,
    organisationId,
    integrationAccountId,
    now,
  });
  if (!selected.ok) throw new Error(selected.error.code);
  const finalized = await finalizeConnectedIntegrationAccount({
    db,
    organisationId,
    integrationAccountId,
    now,
  });
  if (!finalized.ok) throw new Error(finalized.error.code);
  const installationId = await seedInstallation(
    db,
    organisationId,
    userId,
    now,
  );
  const binding = await assignWhatsAppSupportAgent({
    scope: await requireOrganisationExecutionScope(
      {
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      organisationId,
    ),

    integrationAccountId,
    supportBindingId: "whatsapp_binding_dev",
    installationId,
    grantsDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    createdBy: userId,
    now,
  });
  if (!binding.ok) throw new Error(binding.error.code);
  const policy =
    options.publishPolicy === false
      ? null
      : await publishWhatsAppIngressPolicy({
          db,
          organisationId,
          integrationAccountId,
          environment: "development",
          request: {
            kind: "enabled",
            maxActiveCases: 3,
            maxMessagesPerHour: 20,
            dailyAgentTokenBudget: 100_000,
            maxMessageBytes: 4_096,
            maxActiveCaseMessages: 20,
            maxActiveCaseBytes: 32_768,
            debounceSeconds: 15,
            relevantMessageTopics:
              "CafeOS, cafe automation, cafe, and bakery topics.",
            automaticAcknowledgementText:
              "Thanks for your message. We’ll get back to you shortly.",
            agentMode: "answer",
            alwaysWaitTopics: "",
            overflow: "pause_and_notify",
            notificationDestination: {
              kind: "organisation_communication_destination",
            },
          },
          publishedBy: userId,
          now,
        });
  if (policy !== null && !policy.ok) throw new Error(policy.error.code);
  const policyVersion =
    policy !== null && policy.ok && policy.value.kind === "enabled"
      ? policy.value.policyVersion
      : 0;
  let caseId = "";
  if (options.openConversationWindow !== false) {
    const seededCaseId = require_(
      whatsappConversationWindowCaseId(
        integrationAccountId,
        FIXTURE_CUSTOMER_WA_ID,
        1,
      ),
    );
    const conversationWindow = await openWhatsAppCaseConversationWindow({
      db,
      organisationId,
      integrationAccountId,
      customerWaId: require_(parseWhatsAppCustomerId(FIXTURE_CUSTOMER_WA_ID)),
      caseId: seededCaseId,
      conversationWindowSequence: 1,
      supportBindingId: binding.value.supportBindingId,
      bindingRevision: binding.value.currentRevision,
      policyVersion,
      serviceWindowExpiresAt: now + 24 * 3_600_000,
      now,
    });
    if (!conversationWindow.ok) throw new Error(conversationWindow.error.code);
    caseId = conversationWindow.value.conversationWindow.caseId;
  }
  return {
    db,
    sqlite,
    organisationId,
    userId,
    integrationAccountId,
    providerConnectionId: connected.connection.providerConnectionId,
    caseId,
    customerWaId: FIXTURE_CUSTOMER_WA_ID,
    supportBindingId: binding.value.supportBindingId,
    bindingRevision: binding.value.currentRevision,
    policyVersion,
  };
}

async function seedInstallation(
  db: SingleDatabase,
  organisationId: OrganisationId,
  userId: UserId,
  now: number,
): Promise<string> {
  const definitionId = "agent_definition_whatsapp";
  await db
    .prepare(
      `INSERT INTO agent_definition (
       agent_definition_id, organisation_id, display_name, role, purpose, lifecycle,
       current_revision, created_by_user_id, created_at, updated_at
     ) VALUES (?, ?, 'WhatsApp Support', 'assistant', 'customer support', 'active', 1, ?, ?, ?)`,
    )
    .bind(definitionId, organisationId, userId, now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO agent_definition_revision (
       agent_definition_id, organisation_id, revision, instructions,
       requested_capabilities_json, skill_refs_json, content_digest,
       authored_by_user_id, created_at
     ) VALUES (?, ?, 1, 'reply politely', '[]', '[]', ?, ?, ?)`,
    )
    .bind(definitionId, organisationId, "d".repeat(64), userId, now)
    .run();
  const installationId = "installation_whatsapp";
  await db
    .prepare(
      `INSERT INTO agent_installation (
       installation_id, organisation_id, agent_definition_id, definition_revision,
       policy_revision, granted_capabilities_json, lifecycle,
       created_by_user_id, created_at, updated_at
     ) VALUES (?, ?, ?, 1, 1, '[]', 'active', ?, ?, ?)`,
    )
    .bind(installationId, organisationId, definitionId, userId, now, now)
    .run();
  return installationId;
}

export function requireIntegrationAccountId(raw: string): IntegrationAccountId {
  return require_(parseIntegrationAccountId(raw));
}

function require_<T>(
  parsed:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}
