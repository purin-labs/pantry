// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { createActorExecutionBarrierSchema } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import type { DurableObjectStorage } from "@cloudflare/workers-types";

import { describe, expect, it, vi } from "vitest";

/**
 * Case-actor admission needs a live CaseDO namespace and workspace archive,
 * which this fixture deliberately does not build: these tests are about
 * Connector admission and the D1 projection. The Case trigger itself is
 * covered by the gateway test and by the contracts type model.
 */
vi.mock("../src/actors/whatsapp-case-admission", () => ({
  admitWhatsAppSupportCase: async () => ({
    ok: true,
    value: { kind: "accepted" },
  }),
}));

import {
  activateWhatsAppRuntime,
  beginWhatsAppAdmission,
  claimDueWhatsAppCase,
  commitWhatsAppAdmission,
  createConnectorWhatsAppSchema,
  disableWhatsAppRuntime,
  latestWhatsAppProposal,
  nextWhatsAppDebounceAt,
  readWhatsAppCase,
  readWhatsAppEnvelope,
  pauseWhatsAppRuntime,
  readWhatsAppRuntime,
  recordWhatsAppProposal,
  requestWhatsAppHandoff,
  updateWhatsAppRuntimePolicy,
  type WhatsAppIngressLimits,
} from "../src/actors/connector-whatsapp";
import {
  acceptWhatsAppEvent,
  closeWhatsAppSupportCase,
  composeWhatsAppHumanReplyFor,
  dispatchWhatsAppReplyFor,
  readWhatsAppCasePanel,
  returnWhatsAppCaseToAgent,
  takeOverWhatsAppCase,
  type WhatsAppRpcDeps,
} from "../src/actors/connector-whatsapp-rpc";
import { dispatchWhatsAppReply } from "../src/actors/connector-whatsapp-proposal";
import { armConnectorAlarm } from "@purin-labs/conversation/actors/connector/alarm";
import { emailAlarmDue } from "../src/actors/connector/email";
import { whatsAppAlarmDue } from "../src/actors/connector-whatsapp";
import {
  createWhatsAppContentCipher,
  type WhatsAppContentCipher,
} from "../src/actors/whatsapp-active-content";
import {
  listWhatsAppPhoneNumberAccounts,
  readWhatsAppCaseConversationWindowByCaseId,
  readWhatsAppSendAuthority,
  readWhatsAppPhoneNumberClaimant,
  registerWhatsAppPhoneNumberAccount,
  requestWhatsAppCaseHandoff,
  revokeWhatsAppConnection,
  routeWhatsAppWebhookAccount,
} from "../src/data/whatsapp";
import { whatsappErasureStatements } from "../src/mail-inbox/contract/account-erasure";
import { reconcileOrganisationOnboarding } from "@purin-labs/area-organisation/server/data/onboarding-reconciliation";
import type { SessionDO } from "../src/actors/agent-session";
import {
  parseE164PhoneNumber,
  parseMetaBusinessPortfolioId,
  parseWhatsAppBusinessAccountId,
  parseWhatsAppPhoneNumberId,
} from "@purin-labs/connections/whatsapp/identifiers";
import { createFakeGraph } from "./whatsapp/fake-graph";
import {
  WHATSAPP_TEST_NOW,
  createWhatsAppWorld,
  testRootSecret,
  whatsappTestEnvBindings,
  type WhatsAppTestWorld,
} from "./whatsapp/environment";
import { FIXTURE_PHONE_NUMBER_ID, FIXTURE_WABA_ID } from "./whatsapp/fixtures";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

/**
 * Revocation, erasure, and the operator surface the portal drives. These are
 * the paths that end a WhatsApp connection, and the evidence that ending it
 * both fences work already in flight and releases the global phone-number
 * claim so the number can be connected again.
 */

const NOW = WHATSAPP_TEST_NOW;

describe("whatsapp lifecycle", whatsappLifecycleSuite);

function whatsappLifecycleSuite(): void {
  it(
    "revokes the grant, every account under it, and provider health",
    revokeTest,
  );
  it(
    "fences an in-flight proposal frozen against the previous grant",
    revokeFencesSendTest,
  );
  it("releases the global phone-number claim on erasure", erasureTest);
  it("records status and unsupported events without a Case", eventRpcTest);
  it(
    "still admits customer messages while the account is paused",
    pausedAdmissionTest,
  );
  it(
    "records the message that trips a limit instead of losing it",
    deferredAdmissionTest,
  );
  it("takes a Case over, returns it, and closes it", ownershipRpcTest);
  it(
    "keeps a valid organisation credential healthy through scheduled reconciliation",
    reconcilerTest,
  );
  it(
    "keeps the connector and D1 agreed on the Case id across a disable",
    conversationWindowAgreementTest,
  );
}

/**
 * Disabling closes the Connector's Cases. If D1 kept its conversationWindow open, the
 * next message would mint Connector conversationWindow 2 while D1 joined conversationWindow 1, and
 * every later reply for that customer would be refused `case_missing` with no
 * operator action able to clear it. D1 follows the Connector's decision, so a
 * stale open conversationWindow is closed rather than joined.
 */
async function conversationWindowAgreementTest(): Promise<void> {
  const fixture = await createLifecycleFixture();
  await admitOne(fixture, "wamid.EP1", "first question");
  const first = await readWhatsAppCaseConversationWindowByCaseId({
    db: fixture.world.db,
    organisationId: fixture.world.organisationId,
    caseId: fixture.world.caseId,
  });
  expect(first?.closedAt).toBeNull();

  // Disable closes the Connector's Case while D1's conversationWindow is still open.
  const disabled = disableWhatsAppRuntime(fixture.sql, { now: NOW + 1_000 });
  expect(disabled.ok).toBe(true);
  activateWhatsAppRuntime(fixture.sql, {
    organisationId: fixture.world.organisationId,
    integrationAccountId: fixture.world.integrationAccountId,
    policyVersion: fixture.world.policyVersion,
    limits: limits(),
    supportBindingId: fixture.world.supportBindingId,
    bindingRevision: fixture.world.bindingRevision,
    credentialGeneration: 1,
    now: NOW + 2_000,
  });

  // The next message from the same customer opens Connector conversationWindow 2.
  const readmitted = await acceptWhatsAppEvent(
    fixture.deps,
    {
      kind: "text_message",
      customerWaId: fixture.world.customerWaId,
      providerMessageId: "wamid.EP2",
      providerTimestamp: NOW + 3_000,
      body: "still waiting",
    },
    NOW + 3_000,
  );
  expect(readmitted.ok && readmitted.value.kind).toBe("admitted");
  if (!readmitted.ok || readmitted.value.kind !== "admitted") return;
  const secondCaseId = readmitted.value.caseId;
  expect(secondCaseId).not.toBe(fixture.world.caseId);

  // D1 followed: the stale conversationWindow is closed and the new Case has its own row.
  const stale = await readWhatsAppCaseConversationWindowByCaseId({
    db: fixture.world.db,
    organisationId: fixture.world.organisationId,
    caseId: fixture.world.caseId,
  });
  expect(stale?.closedAt).not.toBeNull();
  const current = await readWhatsAppCaseConversationWindowByCaseId({
    db: fixture.world.db,
    organisationId: fixture.world.organisationId,
    caseId: secondCaseId,
  });
  expect(current).toMatchObject({ caseId: secondCaseId, closedAt: null });

  // And the send path can therefore still authorize a reply on it.
  const authority = await readWhatsAppSendAuthority({
    db: fixture.world.db,
    organisationId: fixture.world.organisationId,
    integrationAccountId: fixture.world.integrationAccountId,
    caseId: secondCaseId,
  });
  expect(authority.kind).toBe("authorized");
}

async function reconcilerTest(): Promise<void> {
  const world = await createWhatsAppWorld();
  const generations = await world.db
    .prepare(
      "SELECT COUNT(*) AS total FROM provider_credential_generation WHERE organisation_id = ?",
    )
    .bind(world.organisationId)
    .first<{ readonly total: number }>();
  expect(generations?.total).toBe(1);

  const reconciled = await reconcileOrganisationOnboarding({
    env: {
      DB: world.db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    db: world.db,
    organisationNamespace: {} as DurableObjectNamespace<
      import("../src/actors/organisation").OrganisationDO
    >,
    archive: {} as unknown as R2Bucket,
    sessionNamespace: {} as unknown as DurableObjectNamespace<SessionDO>,
    connectorNamespace: {} as unknown as DurableObjectNamespace<
      import("../src/actors/connector").ConnectorDO
    >,
    organisationId: world.organisationId,
    now: WHATSAPP_TEST_NOW + 15 * 60_000,
  });
  expect(reconciled.ok).toBe(true);

  const account = await world.db
    .prepare(
      `SELECT lifecycle, lifecycle_reason_code AS reasonCode
       FROM integration_account WHERE integration_account_id = ?`,
    )
    .bind(world.integrationAccountId)
    .first<{
      readonly lifecycle: string;
      readonly reasonCode: string | null;
    }>();
  expect(account).toEqual({ lifecycle: "active", reasonCode: null });

  // Ingress still routes after the reconciler has run.
  const routed = await routeWhatsAppWebhookAccount({
    db: world.db,
    wabaId: FIXTURE_WABA_ID,
    phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
  });
  expect(routed?.organisationId).toBe(world.organisationId);
}

type LifecycleFixture = {
  readonly world: WhatsAppTestWorld;
  readonly deps: WhatsAppRpcDeps & {
    readonly origin: { readonly kind: "operator" };
    readonly scope: import("@purin-labs/tenancy/organisation-execution-scope").OrganisationExecutionScope;
    readonly armAlarm: () => Promise<unknown>;
  };
  readonly sql: ReturnType<typeof sqlStorage>;
  readonly cipher: WhatsAppContentCipher;
  readonly env: UnitTestEnv;
};

function limits(): WhatsAppIngressLimits {
  return {
    maxActiveCases: 3,
    maxMessagesPerHour: 20,
    dailyAgentTokenBudget: 100_000,
    maxMessageBytes: 4_096,
    maxActiveCaseMessages: 20,
    maxActiveCaseBytes: 32_768,
    debounceSeconds: 15,
  };
}

/** The Durable Object storage surface these call paths actually use. */
function testStorage(sql: ReturnType<typeof sqlStorage>): DurableObjectStorage {
  return {
    sql,
    transactionSync: <T>(closure: () => T): T => closure(),
  } as unknown as DurableObjectStorage;
}

async function createLifecycleFixture(): Promise<LifecycleFixture> {
  const world = await createWhatsAppWorld();
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createConnectorWhatsAppSchema(sql);
  createActorExecutionBarrierSchema(sql);
  const activated = activateWhatsAppRuntime(sql, {
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    policyVersion: world.policyVersion,
    limits: limits(),
    supportBindingId: world.supportBindingId,
    bindingRevision: world.bindingRevision,
    credentialGeneration: 1,
    now: NOW,
  });
  if (!activated.ok) throw new Error(activated.error.code);
  const cipher = await createWhatsAppContentCipher({
    root: testRootSecret(),
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
  });
  if (!cipher.ok) throw new Error(cipher.error.code);
  const env = platformEnv({
    ...whatsappTestEnvBindings(world.db),
    DATA_ENCRYPTION_ROOT: testRootSecret(),
  });
  return {
    world,
    deps: {
      origin: { kind: "operator" },
      storage: testStorage(sql),
      env,
      scope: await requireOrganisationExecutionScope(env, world.organisationId),
      // The Connector arms its alarm with the due work of each channel.
      armAlarm: armConnectorAlarm.bind(null, testStorage(sql), [
        emailAlarmDue,
        whatsAppAlarmDue,
      ]),
    },
    sql,
    cipher: cipher.value,
    env,
  };
}

async function admitOne(
  fixture: LifecycleFixture,
  providerMessageId: string,
  text: string,
  at: number = NOW,
): Promise<void> {
  const reserved = beginWhatsAppAdmission(fixture.sql, {
    providerMessageId,
    customerWaId: fixture.world.customerWaId,
    providerTimestamp: at,
    declaredBytes: text.length,
    limits: limits(),
    caseIdFor: () => fixture.world.caseId,
    now: at,
  });
  if (reserved.kind !== "ready") throw new Error(reserved.kind);
  const sealed = await fixture.cipher.seal(
    fixture.world.caseId,
    { kind: "message", providerMessageId },
    text,
  );
  commitWhatsAppAdmission(fixture.sql, {
    caseId: fixture.world.caseId,
    providerMessageId,
    customerWaId: fixture.world.customerWaId,
    providerTimestamp: at,
    nonceB64: sealed.nonceB64,
    ciphertextB64: sealed.ciphertextB64,
    bytes: sealed.bytes,
    limits: limits(),
    policyVersion: fixture.world.policyVersion,
    now: at,
  });
}

async function revokeTest(): Promise<void> {
  const world = await createWhatsAppWorld();
  const connectionId = world.providerConnectionId;
  const revoked = await revokeWhatsAppConnection({
    db: world.db,
    organisationId: world.organisationId,
    providerConnectionId: connectionId,
    now: NOW + 1_000,
  });
  expect(revoked.ok).toBe(true);
  if (!revoked.ok) return;
  expect(revoked.value.credentialGeneration).toBe(1);
  expect(revoked.value.accounts).toHaveLength(1);

  const after = await listWhatsAppPhoneNumberAccounts({
    db: world.db,
    organisationId: world.organisationId,
  });
  expect(after[0]?.providerHealth).toEqual({ kind: "revoked" });
  const account = await world.db
    .prepare(
      "SELECT lifecycle, is_default_for_provider AS isDefault FROM integration_account WHERE integration_account_id = ?",
    )
    .bind(world.integrationAccountId)
    .first<{ readonly lifecycle: string; readonly isDefault: number }>();
  expect(account).toEqual({ lifecycle: "revoked", isDefault: 0 });
  const connection = await world.db
    .prepare(
      "SELECT lifecycle, credential_generation AS generation, credential_ref AS credentialRef FROM provider_connection WHERE provider_connection_id = ?",
    )
    .bind(connectionId)
    .first<Record<string, unknown>>();
  expect(connection).toMatchObject({
    lifecycle: "revoked",
    generation: 1,
  });

  // A revoked connection can no longer route inbound traffic.
  expect(
    await routeWhatsAppWebhookAccount({
      db: world.db,
      wabaId: FIXTURE_WABA_ID,
      phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
    }),
  ).toBeNull();

  // Revoking twice converges on the same credential generation.
  const repeat = await revokeWhatsAppConnection({
    db: world.db,
    organisationId: world.organisationId,
    providerConnectionId: connectionId,
    now: NOW + 2_000,
  });
  expect(repeat.ok).toBe(true);
  expect(repeat.ok && repeat.value.credentialGeneration).toBe(
    revoked.ok ? revoked.value.credentialGeneration : -1,
  );
  const stored = await world.db
    .prepare(
      `SELECT credential_generation AS generation FROM provider_connection
      WHERE provider_connection_id = ?`,
    )
    .bind(connectionId)
    .first<{ readonly generation: number }>();
  expect(stored?.generation).toBe(
    repeat.ok ? repeat.value.credentialGeneration : -1,
  );
}

async function revokeFencesSendTest(): Promise<void> {
  const fixture = await createLifecycleFixture();
  const body = "We open at 8am.";
  const bodyDigest = await fixture.cipher.digest(body);
  const sealed = await fixture.cipher.seal(
    fixture.world.caseId,
    { kind: "proposal", proposalId: "proposal_revoke", version: 1 },
    body,
  );
  recordWhatsAppProposal(fixture.sql, {
    proposalId: "proposal_revoke",
    version: 1,
    caseId: fixture.world.caseId,
    customerWaId: fixture.world.customerWaId,
    author: "agent",
    bodyDigest,
    nonceB64: sealed.nonceB64,
    ciphertextB64: sealed.ciphertextB64,
    policyVersion: fixture.world.policyVersion,
    credentialGeneration: 1,
    serviceWindowExpiresAt: NOW + 24 * 3_600_000,
    expiresAt: NOW + 3_600_000,
    now: NOW,
  });
  await revokeWhatsAppConnection({
    db: fixture.world.db,
    organisationId: fixture.world.organisationId,
    providerConnectionId: fixture.world.providerConnectionId,
    now: NOW + 500,
  });

  const graph = createFakeGraph();
  const dispatched = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: fixture.deps.scope,
    sql: fixture.sql,
    cipher: fixture.cipher,
    env: fixture.env,
    proposalId: "proposal_revoke",
    approvedVersion: 1,
    approvedBodyDigest: bodyDigest,
    approvedBy: fixture.world.userId,
    now: NOW + 1_000,
    fetcher: graph.fetcher,
  });
  // Revocation revokes the accounts with the grant, so the account check is
  // the first gate the send ladder fails; either way nothing reaches Meta.
  expect(dispatched.ok && dispatched.value).toEqual({
    kind: "refused",
    reason: "account_inactive",
  });
  expect(graph.sentBodies()).toHaveLength(0);
}

async function erasureTest(): Promise<void> {
  const world = await createWhatsAppWorld();
  await requestWhatsAppCaseHandoff({
    db: world.db,
    organisationId: world.organisationId,
    caseId: world.caseId,
    reason: "needs a human",
    now: NOW,
  });
  const session = world.db.withSession("first-primary");
  await session.batch([
    ...whatsappErasureStatements(session, {
      kind: "account",
      integrationAccountId: world.integrationAccountId,
    }),
  ]);
  expect(
    await listWhatsAppPhoneNumberAccounts({
      db: world.db,
      organisationId: world.organisationId,
    }),
  ).toEqual([]);
  expect(
    await readWhatsAppCaseConversationWindowByCaseId({
      db: world.db,
      organisationId: world.organisationId,
      caseId: world.caseId,
    }),
  ).toBeNull();

  // The global claim is released, so the number can be connected again.
  expect(
    await readWhatsAppPhoneNumberClaimant({
      db: world.db,
      phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
    }),
  ).toBeNull();
  const reclaimed = await registerWhatsAppPhoneNumberAccount({
    db: world.db,
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    providerConnectionId: world.providerConnectionId,
    environment: "development",
    businessPortfolioId: requireParsed(
      parseMetaBusinessPortfolioId("310000000000009"),
    ),
    wabaId: requireParsed(parseWhatsAppBusinessAccountId("102290129340399")),
    phoneNumberId: requireParsed(
      parseWhatsAppPhoneNumberId(FIXTURE_PHONE_NUMBER_ID),
    ),
    displayPhoneNumber: requireParsed(parseE164PhoneNumber("+15550001111")),
    verifiedName: "Reconnected",
    now: NOW + 1_000,
  });
  expect(reclaimed.ok).toBe(true);
}

async function eventRpcTest(): Promise<void> {
  const fixture = await createLifecycleFixture();
  const status = await acceptWhatsAppEvent(
    fixture.deps,
    {
      kind: "status",
      whatsappMessageId: "wamid.OUT1",
      status: "failed",
      statusAt: NOW + 1_000,
      failureCode: "131047",
    },
    NOW + 1_000,
  );
  expect(status.ok && status.value).toEqual({
    kind: "status_recorded",
    status: "failed",
  });
  const duplicate = await acceptWhatsAppEvent(
    fixture.deps,
    {
      kind: "status",
      whatsappMessageId: "wamid.OUT1",
      status: "failed",
      statusAt: NOW + 2_000,
      failureCode: "131047",
    },
    NOW + 2_000,
  );
  expect(duplicate.ok && duplicate.value.kind).toBe("status_duplicate");
  const stored = await fixture.world.db
    .prepare(
      "SELECT failure_code AS failureCode FROM whatsapp_delivery_status WHERE whatsapp_message_id = ?",
    )
    .bind("wamid.OUT1")
    .first<{ readonly failureCode: string }>();
  expect(stored?.failureCode).toBe("131047");

  const unsupported = await acceptWhatsAppEvent(
    fixture.deps,
    {
      kind: "unsupported_message",
      customerWaId: fixture.world.customerWaId,
      providerMessageId: "wamid.IMG1",
      messageType: "image",
    },
    NOW + 3_000,
  );
  expect(unsupported.ok && unsupported.value).toEqual({
    kind: "unsupported",
    messageType: "image",
  });
  // Plan 32 pauses that ITEM, not the number: one photo must not stop text
  // support for every other customer on this phone number.
  expect(readWhatsAppRuntime(fixture.sql)?.processing.kind).not.toBe("paused");
  const skipped = fixture.sql
    .exec<Record<string, SqlStorageValue>>(
      "SELECT disposition FROM connector_whatsapp_message WHERE provider_message_id = ?",
      "wamid.IMG1",
    )
    .toArray()[0];
  expect(skipped?.disposition).toBe("skipped");

  // Text from the same customer is still admitted afterwards.
  const stillWorks = await acceptWhatsAppEvent(
    fixture.deps,
    {
      kind: "text_message",
      customerWaId: fixture.world.customerWaId,
      providerMessageId: "wamid.AFTERIMAGE",
      providerTimestamp: NOW + 4_000,
      body: "sorry, here it is in text",
    },
    NOW + 4_000,
  );
  expect(stillWorks.ok && stillWorks.value.kind).toBe("admitted");
}

/**
 * Overflow is the account-scoped pause. Plan 32 requires durable admission
 * before Meta is told the delivery succeeded, and there is no inbox to refetch
 * from, so a message that arrives while an account is paused — and the message
 * that trips the limit — must still be recorded rather than dropped.
 */
async function pausedAdmissionTest(): Promise<void> {
  const fixture = await createLifecycleFixture();
  pauseWhatsAppRuntime(fixture.sql, {
    reason: {
      kind: "hourly_message_limit",
      observed: 20,
      limit: 20,
      windowEndsAt: NOW + 3_600_000,
    },
    now: NOW,
  });
  expect(readWhatsAppRuntime(fixture.sql)?.processing.kind).toBe("paused");

  const admitted = await acceptWhatsAppEvent(
    fixture.deps,
    {
      kind: "text_message",
      customerWaId: fixture.world.customerWaId,
      providerMessageId: "wamid.WHILEPAUSED",
      providerTimestamp: NOW + 1_000,
      body: "my order never arrived",
    },
    NOW + 1_000,
  );
  expect(admitted.ok && admitted.value.kind).toBe("admitted");

  // The message is durable and its text is in the encrypted envelope.
  const stored = fixture.sql
    .exec<Record<string, SqlStorageValue>>(
      "SELECT disposition FROM connector_whatsapp_message WHERE provider_message_id = ?",
      "wamid.WHILEPAUSED",
    )
    .toArray()[0];
  expect(stored?.disposition).toBe("admitted");
  expect(
    requireParsed(readWhatsAppEnvelope(fixture.sql, fixture.world.caseId)),
  ).toHaveLength(1);

  // The account is still paused: admission is storage, not agent work.
  expect(readWhatsAppRuntime(fixture.sql)?.processing.kind).toBe("paused");
  expect(claimDueWhatsAppCase(fixture.sql, NOW + 60_000).kind).toBe("idle");
}

/**
 * The message that trips a published limit is recorded `deferred` rather than
 * lost: Meta has already been told the delivery succeeded.
 */
async function deferredAdmissionTest(): Promise<void> {
  const fixture = await createLifecycleFixture();
  const runtime = readWhatsAppRuntime(fixture.sql);
  if (runtime === null) throw new Error("expected an activated runtime");
  updateWhatsAppRuntimePolicy(fixture.sql, {
    policyVersion: runtime.policyVersion,
    limits: { ...runtime.limits, maxMessageBytes: 4 },
    supportBindingId: runtime.supportBindingId,
    bindingRevision: runtime.bindingRevision,
    credentialGeneration: runtime.credentialGeneration,
  });
  const rejected = await acceptWhatsAppEvent(
    fixture.deps,
    {
      kind: "text_message",
      customerWaId: fixture.world.customerWaId,
      providerMessageId: "wamid.TOOBIG",
      providerTimestamp: NOW + 1_000,
      body: "this message is far longer than the published limit",
    },
    NOW + 1_000,
  );
  expect(rejected.ok && rejected.value).toEqual({
    kind: "paused",
    reason: "message_too_large",
  });
  const stored = fixture.sql
    .exec<Record<string, SqlStorageValue>>(
      "SELECT disposition, case_id AS caseId FROM connector_whatsapp_message WHERE provider_message_id = ?",
      "wamid.TOOBIG",
    )
    .toArray()[0];
  expect(stored?.disposition).toBe("deferred");
  // Deferred means recorded, not readable: no envelope entry holds its text.
  expect(
    requireParsed(readWhatsAppEnvelope(fixture.sql, fixture.world.caseId)),
  ).toEqual([]);
}

async function ownershipRpcTest(): Promise<void> {
  const fixture = await createLifecycleFixture();
  await admitOne(fixture, "wamid.OWN1", "Are you open?");
  requestWhatsAppHandoff(
    fixture.sql,
    fixture.world.caseId,
    "needs a human",
    NOW + 10,
  );
  await requestWhatsAppCaseHandoff({
    db: fixture.world.db,
    organisationId: fixture.world.organisationId,
    caseId: fixture.world.caseId,
    reason: "needs a human",
    now: NOW + 10,
  });

  const taken = await takeOverWhatsAppCase(fixture.deps, {
    caseId: fixture.world.caseId,
    operatorUserId: fixture.world.userId,
    now: NOW + 20,
  });
  expect(taken.ok && taken.value.invalidatedProposalId).toBeNull();
  expect(
    readWhatsAppCase(fixture.sql, fixture.world.caseId)?.handoffRequestedAt,
  ).toBeNull();
  const owned = await readWhatsAppSendAuthority({
    db: fixture.world.db,
    organisationId: fixture.world.organisationId,
    integrationAccountId: fixture.world.integrationAccountId,
    caseId: fixture.world.caseId,
  });
  // Taking over after an agent handoff records why the human owns the Case.
  expect(owned.kind === "authorized" && owned.ownership).toEqual({
    kind: "human_owned",
    ownerId: fixture.world.userId,
    startedAt: NOW + 20,
    reason: "agent_handoff",
  });

  const composed = await composeWhatsAppHumanReplyFor(fixture.deps, {
    caseId: fixture.world.caseId,
    proposalId: "proposal_human_lifecycle",
    body: "This is Ana - we open at 8am.",
    maxReplyChars: 4_000,
    expiresAt: NOW + 3_600_000,
    now: NOW + 30,
  });
  expect(composed.ok).toBe(true);
  if (!composed.ok) return;
  // A human reply the operator confirmed must actually leave: composing alone
  // would leave a draft they were told had been sent.
  const humanGraph = createFakeGraph({
    sendOutcomes: [{ kind: "accepted", whatsappMessageId: "wamid.HUMANOUT" }],
  });
  const sent = await dispatchWhatsAppReplyFor(fixture.deps, {
    proposalId: composed.value.proposalId,
    approvedVersion: composed.value.version,
    approvedBodyDigest: composed.value.bodyDigest,
    approvedBy: fixture.world.userId,
    now: NOW + 31,
    fetcher: humanGraph.fetcher,
  });
  expect(sent.ok && sent.value.kind).toBe("sent");
  expect(humanGraph.sentBodies()).toHaveLength(1);
  const projected = await fixture.world.db
    .prepare(
      "SELECT author, lifecycle_kind AS lifecycleKind FROM whatsapp_reply_proposal WHERE proposal_id = ?",
    )
    .bind("proposal_human_lifecycle")
    .first<Record<string, unknown>>();
  expect(projected).toEqual({ author: "human", lifecycleKind: "sent" });

  const returned = await returnWhatsAppCaseToAgent(fixture.deps, {
    caseId: fixture.world.caseId,
    now: NOW + 40,
  });
  expect(returned.ok && returned.value.kind).toBe("returned");
  const backToAgent = await readWhatsAppSendAuthority({
    db: fixture.world.db,
    organisationId: fixture.world.organisationId,
    integrationAccountId: fixture.world.integrationAccountId,
    caseId: fixture.world.caseId,
  });
  expect(backToAgent.kind === "authorized" && backToAgent.ownership).toEqual({
    kind: "agent_active",
  });
  expect(nextWhatsAppDebounceAt(fixture.sql)).toBe(NOW + 40);

  const closed = await closeWhatsAppSupportCase(fixture.deps, {
    caseId: fixture.world.caseId,
    now: NOW + 50,
  });
  expect(closed.ok).toBe(true);
  expect(
    requireParsed(readWhatsAppEnvelope(fixture.sql, fixture.world.caseId)),
  ).toEqual([]);
  // A reply that was actually sent stays sent through the close; only its
  // stored body goes.
  expect(
    latestWhatsAppProposal(fixture.sql, "proposal_human_lifecycle"),
  ).toMatchObject({ state: "sent", ciphertextB64: null, nonceB64: null });
  expect(
    await readWhatsAppCaseConversationWindowByCaseId({
      db: fixture.world.db,
      organisationId: fixture.world.organisationId,
      caseId: fixture.world.caseId,
    }),
  ).toMatchObject({ closedAt: NOW + 50 });
  const terminalPanel = await readWhatsAppCasePanel(
    fixture.deps,
    fixture.world.caseId,
  );
  expect(terminalPanel).toEqual({
    ok: false,
    error: { code: "connector_whatsapp_case_missing" },
  });
}

function requireParsed<T>(
  parsed:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

function authorizeWhatsAppFixture(): Promise<boolean> {
  return Promise.resolve(true);
}
