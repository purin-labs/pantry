// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import type { UnitTestEnv } from "./worker-fakes";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import { storeVaultSecret } from "../src/credential-vault";
import { upsertUser } from "../src/data/control-plane";
import { createConnectedIntegration } from "../src/data/integration-account";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import type {
  IntegrationAccountId,
  ProviderConnectionId,
  OrganisationId,
} from "../src/ids";
import {
  closeWhatsAppCaseConversationWindow,
  listWhatsAppPhoneNumberAccounts,
  openWhatsAppCaseConversationWindow,
  parseWhatsAppIngressPolicyPublishRequest,
  publishWhatsAppIngressPolicy,
  readOpenWhatsAppCaseConversationWindow,
  readWhatsAppIngressPolicy,
  readWhatsAppPhoneNumberClaimant,
  readWhatsAppSendAuthority,
  recordWhatsAppMessageReceipt,
  registerWhatsAppPhoneNumberAccount,
  requestWhatsAppCaseHandoff,
  routeWhatsAppWebhookAccount,
  selectWhatsAppPhoneNumberAccount,
  setWhatsAppCaseOwnership,
  setWhatsAppProviderHealth,
  whatsappConnectorIdValue,
  whatsappConversationWindowCaseId,
} from "../src/data/whatsapp";
import { setIntegrationAccountLifecycle } from "../src/data/integration-account";
import { providerCredentialHandle } from "../src/integrations/contract/provisioning";
import {
  validateNativeRequestAuthority,
  buildWhatsAppSupportAuthority,
} from "../src/request-authority";
import { resolveWhatsAppOrganisationCredential } from "../src/whatsapp/credential";
import {
  parseE164PhoneNumber,
  parseMetaBusinessPortfolioId,
  parseWhatsAppBusinessAccountId,
} from "../src/whatsapp/identifiers";
import {
  WHATSAPP_TEST_NOW,
  createWhatsAppWorld,
  testRootSecret,
  whatsappTestEnvBindings,
  type WhatsAppTestWorld,
} from "./whatsapp/environment";
import { FIXTURE_PHONE_NUMBER_ID, FIXTURE_WABA_ID } from "./whatsapp/fixtures";
import {
  requireWhatsAppCustomerId,
  requireWhatsAppPhoneNumberId,
} from "./test-ids";

const NOW = WHATSAPP_TEST_NOW;

describe("whatsapp persistence", whatsappPersistenceSuite);

function whatsappPersistenceSuite(): void {
  it(
    "resolves the active organisation business token from Vault",
    organisationCredentialTest,
  );
  it(
    "claims one phone-number asset globally, and only on selection",
    phoneNumberClaimTest,
  );
  it(
    "routes a webhook only to an active account under an active connection",
    routingTest,
  );
  it(
    "resolves missing policy to disabled and appends published revisions",
    policyTest,
  );
  it(
    "rejects invalid ingress policy publish requests at the boundary",
    policyBoundaryTest,
  );
  it(
    "keeps one open conversationWindow per customer and starts a new Case after the window",
    conversationWindowTest,
  );
  it("isolates conversationWindows by customer wa_id", isolationTest);
  it("deduplicates provider message receipts per account", receiptTest);
  it("revalidates every send precondition in one read", sendAuthorityTest);
  it(
    "validates live whatsapp_support authority against current revisions",
    liveAuthorityTest,
  );
  it(
    "grants the current whatsapp_support binding access to its Case context",
    supportContextGrantTest,
  );
}

async function organisationCredentialTest(): Promise<void> {
  const world = await createWhatsAppWorld();
  const env = whatsappTestEnvBindings(world.db) as unknown as UnitTestEnv;
  const resolved = await resolveWhatsAppOrganisationCredential({
    env,
    scope: await requireOrganisationExecutionScope(env, world.organisationId),
    integrationAccountId: world.integrationAccountId,
    now: NOW + 1_000,
  });
  if (!resolved.ok) throw new Error(resolved.error.code);
  expect(resolved).toMatchObject({
    ok: true,
    value: { credentialGeneration: 1 },
  });
  const expired = await resolveWhatsAppOrganisationCredential({
    env,
    scope: await requireOrganisationExecutionScope(env, world.organisationId),
    integrationAccountId: world.integrationAccountId,
    now: NOW + 61 * 24 * 60 * 60 * 1_000,
  });
  expect(expired).toEqual({
    ok: false,
    error: { code: "whatsapp_credential_expired" },
  });
}

async function supportContextGrantTest(): Promise<void> {
  const world = await createWhatsAppWorld();
  const row = await world.db
    .prepare(
      `SELECT subject_json AS subjectJson, target_json AS targetJson,
            provenance_json AS provenanceJson, lifecycle
       FROM access_grant
      WHERE organisation_id = ?
        AND json_extract(subject_json, '$.kind') = 'whatsapp_support'`,
    )
    .bind(world.organisationId)
    .first<{
      readonly subjectJson: string;
      readonly targetJson: string;
      readonly provenanceJson: string;
      readonly lifecycle: string;
    }>();

  expect(row).not.toBeNull();
  expect(row?.lifecycle).toBe("active");
  expect(JSON.parse(row?.subjectJson ?? "{}")).toEqual({
    kind: "whatsapp_support",
    integrationAccountId: world.integrationAccountId,
    supportBindingId: world.supportBindingId,
    bindingRevision: world.bindingRevision,
  });
  expect(JSON.parse(row?.targetJson ?? "{}")).toEqual({
    kind: "platform_capability",
    capabilityId: "context.case.read",
    capabilityVersion: 1,
  });
  expect(JSON.parse(row?.provenanceJson ?? "{}")).toMatchObject({
    kind: "integration_setup",
    integrationAccountId: world.integrationAccountId,
    setupRevision: world.bindingRevision,
  });
}

/**
 * The phone-number asset is claimed globally, not per organisation: two organisations in
 * one deployment cannot both answer for the same number, and the claim is not
 * silently moved when a second organisation asks for it. Discovery is separate —
 * Embedded Signup enumerates a WABA's numbers, and enumerating one must not
 * take a claim the owner never asked for.
 */
async function phoneNumberClaimTest(): Promise<void> {
  const world = await createWhatsAppWorld();
  const attacker = await seedSecondOrganisation(world);
  const stolen = await registerWhatsAppPhoneNumberAccount({
    db: world.db,
    organisationId: attacker.organisationId,
    integrationAccountId: attacker.integrationAccountId,
    providerConnectionId: attacker.providerConnectionId,
    environment: "development",
    businessPortfolioId: requireParsed(
      parseMetaBusinessPortfolioId("310000000000002"),
    ),
    wabaId: requireParsed(parseWhatsAppBusinessAccountId("102290129340399")),
    phoneNumberId: requireWhatsAppPhoneNumberId(FIXTURE_PHONE_NUMBER_ID),
    displayPhoneNumber: requireParsed(parseE164PhoneNumber("+15550009999")),
    verifiedName: "Attacker",
    now: NOW + 10,
  });
  // Discovery is not a claim: the second organisation may record the same number as
  // a candidate. Meta can move a number between WABAs, and a stale Pantry row
  // must not make the new owner's connection impossible.
  expect(stolen.ok).toBe(true);

  // Selecting it is where the claim is taken, and this one is already taken.
  const claimed = await selectWhatsAppPhoneNumberAccount({
    db: world.db,
    organisationId: attacker.organisationId,
    integrationAccountId: attacker.integrationAccountId,
    now: NOW + 15,
  });
  expect(claimed.ok).toBe(false);
  if (!claimed.ok)
    expect(claimed.error.code).toBe("whatsapp_phone_number_claimed");

  // The claim did not move, and routing still answers for the original organisation.
  const claimant = await readWhatsAppPhoneNumberClaimant({
    db: world.db,
    phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
  });
  expect(claimant).toEqual({
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
  });
  const routed = await routeWhatsAppWebhookAccount({
    db: world.db,
    wabaId: FIXTURE_WABA_ID,
    phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
  });
  expect(routed?.organisationId).toBe(world.organisationId);

  // The owner may re-register its own number: reconnect keeps the claim.
  const reconnected = await registerWhatsAppPhoneNumberAccount({
    db: world.db,
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    providerConnectionId: world.providerConnectionId,
    environment: "development",
    businessPortfolioId: requireParsed(
      parseMetaBusinessPortfolioId("310000000000001"),
    ),
    wabaId: requireParsed(parseWhatsAppBusinessAccountId(FIXTURE_WABA_ID)),
    phoneNumberId: requireWhatsAppPhoneNumberId(FIXTURE_PHONE_NUMBER_ID),
    displayPhoneNumber: requireParsed(parseE164PhoneNumber("+15550001111")),
    verifiedName: "Renamed Bakery",
    now: NOW + 20,
  });
  expect(reconnected.ok && reconnected.value.verifiedName).toBe(
    "Renamed Bakery",
  );
  expect(reconnected.ok && reconnected.value.selectedAt).toBe(NOW);
  const accounts = await listWhatsAppPhoneNumberAccounts({
    db: world.db,
    organisationId: world.organisationId,
  });
  expect(accounts).toHaveLength(1);

  // The unselected candidate is inert: it routes nothing.
  const stillOriginal = await routeWhatsAppWebhookAccount({
    db: world.db,
    wabaId: "102290129340399",
    phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
  });
  expect(stillOriginal).toBeNull();
}

/**
 * A second organisation in the same database, connected to a different WABA. It
 * exists so the claim test exercises the real global index rather than two
 * isolated databases that could never collide.
 */
async function seedSecondOrganisation(world: WhatsAppTestWorld): Promise<{
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly providerConnectionId: ProviderConnectionId;
}> {
  const owner = await upsertUser({
    db: world.db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "whatsapp-second-owner",
      email: "second@example.test",
      displayName: "Second owner",
      emailVerified: true,
    },
    now: NOW,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: world.db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "Second WhatsApp Organisation",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  const credentialRef = providerCredentialHandle(
    organisation.organisationId,
    "whatsapp",
    "102290129340399",
    NOW,
  );
  const storedCredential = await storeVaultSecret({
    db: world.db,
    keys: {
      PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
      VAULT_ROOT_V1: testRootSecret(),
    },
    organisationId: organisation.organisationId,
    handle: credentialRef,
    secret: {
      kind: "expiring_bearer",
      value: "fixture-second-customer-business-token",
      expiresAt: NOW + 60 * 24 * 60 * 60 * 1_000,
    },
    now: NOW,
  });
  if (!storedCredential.ok) throw new Error(storedCredential.error.code);
  const connected = await createConnectedIntegration(world.db, {
    organisationId: organisation.organisationId,
    provider: "whatsapp",
    providerSubjectId: "102290129340399",
    environment: "development",
    authMode: "shared_pantry_app",
    authority: {
      kind: "connection_credential",
      credentialRef,
    },
    grantedScopes: [
      "whatsapp_business_management",
      "whatsapp_business_messaging",
      "business_management",
    ],
    createdByUserId: owner.userId,
    providerAccountId: "106540352242999",
    accountKind: "phone_number",
    displayName: "Second organisation",
    capabilities: ["whatsapp.support.ingress"],
    audiencePolicy: { kind: "customer", consentRequired: true },
    retentionPolicy: { kind: "organisation_default" },
    now: NOW,
  });
  return {
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    providerConnectionId: connected.connection.providerConnectionId,
  };
}

async function routingTest(): Promise<void> {
  const world = await createWhatsAppWorld();
  const routed = await routeWhatsAppWebhookAccount({
    db: world.db,
    wabaId: FIXTURE_WABA_ID,
    phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
  });
  expect(routed).toEqual({
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    credentialGeneration: 1,
  });

  expect(
    await routeWhatsAppWebhookAccount({
      db: world.db,
      wabaId: "102290129340399",
      phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
    }),
  ).toBeNull();
  expect(
    await routeWhatsAppWebhookAccount({
      db: world.db,
      wabaId: FIXTURE_WABA_ID,
      phoneNumberId: "999999999999999",
    }),
  ).toBeNull();

  await setIntegrationAccountLifecycle({
    db: world.db,
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    lifecycle: { kind: "revoked", revokedAt: NOW },
    now: NOW,
  });
  expect(
    await routeWhatsAppWebhookAccount({
      db: world.db,
      wabaId: FIXTURE_WABA_ID,
      phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
    }),
  ).toBeNull();
}

async function policyTest(): Promise<void> {
  // Plan 32 starts every number disabled. A connected account that has never
  // published a policy must read as disabled_by_default — not as an absence
  // some caller might treat permissively.
  const fresh = await createWhatsAppWorld({
    openConversationWindow: false,
    publishPolicy: false,
  });
  const initial = await readWhatsAppIngressPolicy({
    db: fresh.db,
    organisationId: fresh.organisationId,
    integrationAccountId: fresh.integrationAccountId,
    connectedAt: NOW,
  });
  expect(initial).toEqual({ kind: "disabled_by_default", connectedAt: NOW });
  const noRevisions = await fresh.db
    .prepare(
      "SELECT COUNT(*) AS total FROM whatsapp_ingress_policy_revision WHERE integration_account_id = ?",
    )
    .bind(fresh.integrationAccountId)
    .first<{ readonly total: number }>();
  expect(noRevisions?.total).toBe(0);

  const world = await createWhatsAppWorld({ openConversationWindow: false });
  const current = await readWhatsAppIngressPolicy({
    db: world.db,
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    connectedAt: NOW,
  });
  expect(current).toMatchObject({
    kind: "enabled",
    relevantMessageTopics: "Café, cafe automation, cafe, and bakery topics.",
    automaticAcknowledgementText:
      "Thanks for your message. We’ll get back to you shortly.",
  });

  const disabled = await publishWhatsAppIngressPolicy({
    db: world.db,
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    environment: "development",
    request: { kind: "disabled_by_operator" },
    publishedBy: world.userId,
    now: NOW + 100,
  });
  expect(disabled.ok && disabled.value.kind).toBe("disabled_by_operator");
  const revisions = await world.db
    .prepare(
      "SELECT COUNT(*) AS total FROM whatsapp_ingress_policy_revision WHERE integration_account_id = ?",
    )
    .bind(world.integrationAccountId)
    .first<{ readonly total: number }>();
  expect(revisions?.total).toBe(2);
  const health = await setWhatsAppProviderHealth({
    db: world.db,
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    health: { kind: "degraded", reasonCode: "whatsapp_subscription_failed" },
    now: NOW + 200,
  });
  expect(health.ok).toBe(true);
  const accounts = await listWhatsAppPhoneNumberAccounts({
    db: world.db,
    organisationId: world.organisationId,
  });
  expect(accounts[0]?.providerHealth).toEqual({
    kind: "degraded",
    reasonCode: "whatsapp_subscription_failed",
  });
}

function policyBoundaryTest(): void {
  const enabled = {
    kind: "enabled",
    maxActiveCases: 3,
    maxMessagesPerHour: 20,
    dailyAgentTokenBudget: 100_000,
    maxMessageBytes: 4_096,
    maxActiveCaseMessages: 20,
    maxActiveCaseBytes: 32_768,
    debounceSeconds: 15,
    relevantMessageTopics:
      "Café, cafe automation, cafe, bakery, and products.",
    automaticAcknowledgementText:
      "Thanks for your message. We’ll get back to you shortly.",
    overflow: "pause_and_notify",
    notificationDestination: { kind: "organisation_communication_destination" },
  } as const;
  expect(parseWhatsAppIngressPolicyPublishRequest(enabled).ok).toBe(true);
  expect(
    parseWhatsAppIngressPolicyPublishRequest({ kind: "disabled_by_operator" })
      .ok,
  ).toBe(true);

  const invalid: readonly unknown[] = [
    null,
    { kind: "enabled" },
    { kind: "enabled_by_default" },
    { kind: "disabled_by_operator", maxActiveCases: 1 },
    { ...enabled, maxActiveCases: 0 },
    { ...enabled, maxMessagesPerHour: -1 },
    { ...enabled, dailyAgentTokenBudget: 1.5 },
    { ...enabled, maxMessageBytes: "4096" },
    { ...enabled, debounceSeconds: 9 },
    { ...enabled, debounceSeconds: 31 },
    { ...enabled, relevantMessageTopics: "" },
    { ...enabled, automaticAcknowledgementText: "" },
    { ...enabled, overflow: "drop_oldest" },
    { ...enabled, notificationDestination: { kind: "slack_channel" } },
    { ...enabled, notificationDestination: null },
  ];
  for (const raw of invalid) {
    expect(parseWhatsAppIngressPolicyPublishRequest(raw).ok).toBe(false);
  }
}

async function conversationWindowTest(): Promise<void> {
  const world = await createWhatsAppWorld({ openConversationWindow: false });
  const first = await openConversationWindow(world, NOW);
  expect(first.kind).toBe("opened");
  const joined = await openConversationWindow(world, NOW + 60_000);
  expect(joined.kind).toBe("joined");
  expect(joined.conversationWindow.caseId).toBe(
    first.conversationWindow.caseId,
  );
  expect(joined.conversationWindow.serviceWindowExpiresAt).toBe(
    NOW + 60_000 + 24 * 3_600_000,
  );

  const next = await openConversationWindow(
    world,
    NOW + 60_000 + 25 * 3_600_000,
    undefined,
    2,
  );
  expect(next.kind).toBe("opened");
  expect(next.conversationWindow.caseId).not.toBe(
    first.conversationWindow.caseId,
  );
  expect(next.conversationWindow.conversationWindowSequence).toBe(2);

  await closeWhatsAppCaseConversationWindow({
    db: world.db,
    organisationId: world.organisationId,
    caseId: next.conversationWindow.caseId,
    now: NOW + 60_000 + 26 * 3_600_000,
  });
  expect(
    await readOpenWhatsAppCaseConversationWindow({
      db: world.db,
      organisationId: world.organisationId,
      integrationAccountId: world.integrationAccountId,
      customerWaId: requireWhatsAppCustomerId(world.customerWaId),
      now: NOW + 60_000 + 26 * 3_600_000,
    }),
  ).toBeNull();
}

async function isolationTest(): Promise<void> {
  const world = await createWhatsAppWorld({ openConversationWindow: false });
  const first = await openConversationWindow(world, NOW);
  const second = await openConversationWindow(world, NOW, "15550004444");
  expect(second.conversationWindow.caseId).not.toBe(
    first.conversationWindow.caseId,
  );
  const expected = whatsappConversationWindowCaseId(
    world.integrationAccountId,
    "15550004444",
    1,
  );
  expect(expected.ok && second.conversationWindow.caseId).toBe(
    expected.ok ? expected.value : "",
  );
  expect(whatsappConnectorIdValue(world.integrationAccountId)).toBe(
    `connector_whatsapp_${world.integrationAccountId}`,
  );
}

async function receiptTest(): Promise<void> {
  const world = await createWhatsAppWorld();
  const record = async (digest: string): Promise<void> => {
    await recordWhatsAppMessageReceipt({
      db: world.db,
      organisationId: world.organisationId,
      integrationAccountId: world.integrationAccountId,
      providerMessageId: "wamid.DUP",
      customerWaId: requireWhatsAppCustomerId(world.customerWaId),
      caseId: world.caseId,
      direction: "inbound",
      bodyDigest: digest,
      bodyBytes: 10,
      policyVersion: world.policyVersion,
      providerTimestamp: NOW,
      now: NOW,
    });
  };
  await record("a".repeat(64));
  await record("b".repeat(64));
  const rows = await world.db
    .prepare(
      "SELECT body_digest AS bodyDigest FROM whatsapp_message_receipt WHERE provider_message_id = ?",
    )
    .bind("wamid.DUP")
    .all<{ readonly bodyDigest: string }>();
  expect(rows.results).toEqual([{ bodyDigest: "a".repeat(64) }]);
}

async function sendAuthorityTest(): Promise<void> {
  const world = await createWhatsAppWorld();
  const authorized = await readWhatsAppSendAuthority({
    db: world.db,
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    caseId: world.caseId,
  });
  expect(authorized.kind).toBe("authorized");
  if (authorized.kind !== "authorized") return;
  expect(authorized.ownership).toEqual({ kind: "agent_active" });
  expect(authorized.handoffRequestedAt).toBeNull();

  await requestWhatsAppCaseHandoff({
    db: world.db,
    organisationId: world.organisationId,
    caseId: world.caseId,
    reason: "needs a human",
    now: NOW + 10,
  });
  const pending = await readWhatsAppSendAuthority({
    db: world.db,
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    caseId: world.caseId,
  });
  expect(pending.kind === "authorized" && pending.handoffRequestedAt).toBe(
    NOW + 10,
  );

  await setWhatsAppCaseOwnership({
    db: world.db,
    organisationId: world.organisationId,
    caseId: world.caseId,
    ownership: {
      kind: "human_owned",
      ownerId: world.userId,
      startedAt: NOW + 20,
      reason: "agent_handoff",
    },
  });
  const owned = await readWhatsAppSendAuthority({
    db: world.db,
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    caseId: world.caseId,
  });
  expect(owned.kind === "authorized" && owned.ownership.kind).toBe(
    "human_owned",
  );

  await publishWhatsAppIngressPolicy({
    db: world.db,
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    environment: "development",
    request: { kind: "disabled_by_operator" },
    publishedBy: world.userId,
    now: NOW + 30,
  });
  const disabled = await readWhatsAppSendAuthority({
    db: world.db,
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    caseId: world.caseId,
  });
  expect(disabled).toEqual({ kind: "unauthorized", reason: "policy_disabled" });
}

async function liveAuthorityTest(): Promise<void> {
  const world = await createWhatsAppWorld();
  const authority = buildWhatsAppSupportAuthority({
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    supportBindingId: world.supportBindingId,
    bindingRevision: world.bindingRevision,
    ingressPolicyVersion: world.policyVersion,
  }).requestAuthority;
  expect(
    (await validateNativeRequestAuthority({ db: world.db, authority })).ok,
  ).toBe(true);

  const staleRevision = buildWhatsAppSupportAuthority({
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    supportBindingId: world.supportBindingId,
    bindingRevision: world.bindingRevision + 1,
    ingressPolicyVersion: world.policyVersion,
  }).requestAuthority;
  expect(
    (
      await validateNativeRequestAuthority({
        db: world.db,
        authority: staleRevision,
      })
    ).ok,
  ).toBe(false);

  await publishWhatsAppIngressPolicy({
    db: world.db,
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    environment: "development",
    request: { kind: "disabled_by_operator" },
    publishedBy: world.userId,
    now: NOW + 50,
  });
  expect(
    (await validateNativeRequestAuthority({ db: world.db, authority })).ok,
  ).toBe(false);
}

/**
 * Mirrors what the Connector does: it decides the conversationWindow sequence and Case
 * id, and D1 records that decision. The helper keeps its own counter per
 * customer so a test can express "the window closed, so this is conversationWindow 2".
 */
async function openConversationWindow(
  world: WhatsAppTestWorld,
  now: number,
  customerWaId?: string,
  conversationWindowSequence: number = 1,
): Promise<{
  readonly kind: "opened" | "joined";
  readonly conversationWindow: {
    readonly caseId: string;
    readonly conversationWindowSequence: number;
    readonly serviceWindowExpiresAt: number;
  };
}> {
  const waId = customerWaId ?? world.customerWaId;
  const caseId = whatsappConversationWindowCaseId(
    world.integrationAccountId,
    waId,
    conversationWindowSequence,
  );
  if (!caseId.ok) throw new Error(caseId.error.code);
  const opened = await openWhatsAppCaseConversationWindow({
    db: world.db,
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    customerWaId: requireWhatsAppCustomerId(waId),
    caseId: caseId.value,
    conversationWindowSequence,
    supportBindingId: world.supportBindingId,
    bindingRevision: world.bindingRevision,
    policyVersion: world.policyVersion,
    serviceWindowExpiresAt: now + 24 * 3_600_000,
    now,
  });
  if (!opened.ok) throw new Error(opened.error.code);
  return opened.value;
}

function requireParsed<T>(
  parsed:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}
