// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import { createActorExecutionBarrierSchema } from "../src/actors/actor-execution-quiescence";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import {
  activateWhatsAppRuntime,
  beginWhatsAppAdmission,
  commitWhatsAppAdmission,
  createConnectorWhatsAppSchema,
  latestWhatsAppProposal,
  readWhatsAppRuntime,
  recordWhatsAppProposal,
  requestWhatsAppHandoff,
  type WhatsAppIngressLimits,
} from "../src/actors/connector-whatsapp";
import {
  dispatchWhatsAppReply,
  disposeWhatsAppProposal,
  editWhatsAppProposal,
  previewWhatsAppProposal,
  resolveWhatsAppIndeterminateSend,
} from "../src/actors/connector-whatsapp-proposal";
import {
  createWhatsAppContentCipher,
  type WhatsAppContentCipher,
} from "../src/actors/whatsapp-active-content";
import { publishWhatsAppIngressPolicy } from "../src/data/whatsapp";
import { createFakeGraph } from "./whatsapp/fake-graph";
import {
  WHATSAPP_TEST_NOW,
  createWhatsAppWorld,
  testRootSecret,
  whatsappTestEnvBindings,
  type WhatsAppTestWorld,
} from "./whatsapp/environment";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const NOW = WHATSAPP_TEST_NOW;
const REPLY = "We are open on Sunday from 8am to 2pm.";

describe("whatsapp send ladder", whatsappSendSuite);

function whatsappSendSuite(): void {
  it("quarantines an ambiguous send without retrying it", indeterminateTest);
  it("treats a 200 without a message id as unprovable", ambiguousBodyTest);
  it("returns a definite provider rejection to the approver", rejectedTest);
  it("refuses to send while a handoff is pending", ownershipTest);
  it("refuses to send over a revoked connection", revokedConnectionTest);
  it("versions an edited proposal and invalidates the previous body", editTest);
  it(
    "resolves a fenced Case only through an explicit operator decision",
    resolutionTest,
  );
  it("reports an already-expired proposal as expired", expiredProposalTest);
  it(
    "refuses a proposal frozen against a rotated application credential",
    generationTest,
  );
  it(
    "refuses a proposal frozen against a superseded agent or policy",
    assignmentTest,
  );
  it("sends once when two approvals race", concurrentApprovalTest);
}

/**
 * A Durable Object is single-threaded but yields at every await, so two
 * approvals arriving together can both clear every gate before either sends.
 * The customer must still receive exactly one message.
 *
 * The provider call stays open until the losing approval settles, so the loser
 * always meets the claim. A loser that arrived after the receipt would replay
 * `sent` and prove nothing about the claim.
 */
async function concurrentApprovalTest(): Promise<void> {
  const fixture = await createSendFixture();
  const proposal = await seedProposal(fixture);
  const graph = createFakeGraph({
    sendOutcomes: [
      { kind: "accepted", whatsappMessageId: "wamid.RACE1" },
      { kind: "accepted", whatsappMessageId: "wamid.RACE2" },
    ],
  });
  const providerCall = Promise.withResolvers<void>();
  let providerCalls = 0;
  const heldFetcher = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    providerCalls += 1;
    // A second provider call is the defect. Release both so the assertions
    // below report it instead of a timeout.
    if (providerCalls > 1) providerCall.resolve();
    await providerCall.promise;
    return graph.fetcher(input, init);
  }) as typeof fetch;
  const approve = (): Promise<unknown> =>
    dispatchWhatsAppReply({
      authorizeExecution: authorizeWhatsAppFixture,
      scope: fixture.scope,
      sql: fixture.sql,
      cipher: fixture.cipher,
      env: fixture.env,
      proposalId: proposal.proposalId,
      approvedVersion: 1,
      approvedBodyDigest: proposal.bodyDigest,
      approvedBy: fixture.world.userId,
      now: NOW + 1_000,
      fetcher: heldFetcher,
    });
  const approvals = [approve(), approve()];
  await Promise.race(approvals);
  providerCall.resolve();
  const [first, second] = await Promise.all(approvals);

  // Exactly one provider call, and exactly one recorded receipt.
  expect(graph.sentBodies()).toHaveLength(1);
  const stored = latestWhatsAppProposal(fixture.sql, proposal.proposalId);
  expect(stored).toMatchObject({ state: "sent", sentMessageId: "wamid.RACE1" });

  const outcomes = [first, second].map(
    (result) =>
      (
        result as {
          readonly ok: boolean;
          readonly value?: { readonly kind: string };
        }
      ).value?.kind,
  );
  expect(outcomes.filter((kind) => kind === "sent")).toHaveLength(1);
  expect(outcomes).toContain("stale_approval");
  const receipts = await fixture.world.db
    .prepare(
      "SELECT COUNT(*) AS total FROM whatsapp_message_receipt WHERE direction = 'outbound'",
    )
    .first<{ readonly total: number }>();
  expect(receipts?.total).toBe(1);
}

type SendFixture = {
  readonly world: WhatsAppTestWorld;
  readonly scope: import("../src/organisation-execution-scope").OrganisationExecutionScope;
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

async function createSendFixture(): Promise<SendFixture> {
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
  const reserved = beginWhatsAppAdmission(sql, {
    providerMessageId: "wamid.IN0001",
    customerWaId: world.customerWaId,
    providerTimestamp: NOW,
    declaredBytes: 24,
    limits: limits(),
    caseIdFor: () => world.caseId,
    now: NOW,
  });
  if (reserved.kind !== "ready") throw new Error(reserved.kind);
  const cipher = await createWhatsAppContentCipher({
    root: testRootSecret(),
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
  });
  if (!cipher.ok) throw new Error(cipher.error.code);
  const sealed = await cipher.value.seal(
    world.caseId,
    { kind: "message", providerMessageId: "wamid.IN0001" },
    "Are you open on Sunday?",
  );
  commitWhatsAppAdmission(sql, {
    caseId: world.caseId,
    providerMessageId: "wamid.IN0001",
    customerWaId: world.customerWaId,
    providerTimestamp: NOW,
    nonceB64: sealed.nonceB64,
    ciphertextB64: sealed.ciphertextB64,
    bytes: sealed.bytes,
    limits: limits(),
    policyVersion: world.policyVersion,
    now: NOW,
  });
  const env = platformEnv({
    ...whatsappTestEnvBindings(world.db),
    DATA_ENCRYPTION_ROOT: testRootSecret(),
  });
  const scope = await requireOrganisationExecutionScope(
    env,
    world.organisationId,
  );
  return { world, scope, sql, cipher: cipher.value, env };
}

async function seedProposal(
  fixture: SendFixture,
  overrides: Partial<{
    readonly proposalId: string;
    readonly body: string;
    readonly serviceWindowExpiresAt: number;
    readonly expiresAt: number;
    readonly credentialGeneration: number;
    readonly author: "agent" | "human";
  }> = {},
): Promise<{ readonly proposalId: string; readonly bodyDigest: string }> {
  const proposalId = overrides.proposalId ?? "proposal_send_1";
  const body = overrides.body ?? REPLY;
  const bodyDigest = await fixture.cipher.digest(body);
  const sealed = await fixture.cipher.seal(
    fixture.world.caseId,
    { kind: "proposal", proposalId, version: 1 },
    body,
  );
  recordWhatsAppProposal(fixture.sql, {
    proposalId,
    version: 1,
    caseId: fixture.world.caseId,
    customerWaId: fixture.world.customerWaId,
    author: overrides.author ?? "agent",
    bodyDigest,
    nonceB64: sealed.nonceB64,
    ciphertextB64: sealed.ciphertextB64,
    policyVersion: fixture.world.policyVersion,
    credentialGeneration: overrides.credentialGeneration ?? 1,
    serviceWindowExpiresAt:
      overrides.serviceWindowExpiresAt ?? NOW + 24 * 3_600_000,
    expiresAt: overrides.expiresAt ?? NOW + 3_600_000,
    now: NOW,
  });
  return { proposalId, bodyDigest };
}

async function indeterminateTest(): Promise<void> {
  const fixture = await createSendFixture();
  const proposal = await seedProposal(fixture);
  const graph = createFakeGraph({
    sendOutcomes: [{ kind: "server_error", status: 503 }],
  });
  const dispatched = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: fixture.scope,
    sql: fixture.sql,
    cipher: fixture.cipher,
    env: fixture.env,
    proposalId: proposal.proposalId,
    approvedVersion: 1,
    approvedBodyDigest: proposal.bodyDigest,
    approvedBy: fixture.world.userId,
    now: NOW + 1_000,
    fetcher: graph.fetcher,
  });
  expect(dispatched.ok && dispatched.value.kind).toBe("send_indeterminate");
  expect(
    latestWhatsAppProposal(fixture.sql, proposal.proposalId),
  ).toMatchObject({
    state: "send_indeterminate",
    ciphertextB64: null,
  });
  const runtime = readWhatsAppRuntime(fixture.sql);
  expect(runtime?.processing.kind).toBe("paused");
  expect(
    runtime?.processing.kind === "paused" && runtime.processing.reason.kind,
  ).toBe("send_indeterminate");

  // The fenced Case never retries automatically.
  const retried = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: fixture.scope,
    sql: fixture.sql,
    cipher: fixture.cipher,
    env: fixture.env,
    proposalId: proposal.proposalId,
    approvedVersion: 1,
    approvedBodyDigest: proposal.bodyDigest,
    approvedBy: fixture.world.userId,
    now: NOW + 2_000,
    fetcher: graph.fetcher,
  });
  expect(!retried.ok && retried.error.code).toBe(
    "connector_whatsapp_case_fenced",
  );
  expect(graph.sentBodies()).toHaveLength(1);
}

async function ambiguousBodyTest(): Promise<void> {
  const fixture = await createSendFixture();
  const proposal = await seedProposal(fixture);
  const graph = createFakeGraph({ sendOutcomes: [{ kind: "ambiguous_body" }] });
  const dispatched = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: fixture.scope,
    sql: fixture.sql,
    cipher: fixture.cipher,
    env: fixture.env,
    proposalId: proposal.proposalId,
    approvedVersion: 1,
    approvedBodyDigest: proposal.bodyDigest,
    approvedBy: fixture.world.userId,
    now: NOW + 1_000,
    fetcher: graph.fetcher,
  });
  expect(dispatched.ok && dispatched.value).toEqual({
    kind: "send_indeterminate",
    reason: "whatsapp_send_message_id_missing",
  });
}

async function rejectedTest(): Promise<void> {
  const fixture = await createSendFixture();
  const proposal = await seedProposal(fixture);
  const graph = createFakeGraph({
    sendOutcomes: [{ kind: "rejected", status: 400, providerCode: 131_047 }],
  });
  const dispatched = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: fixture.scope,
    sql: fixture.sql,
    cipher: fixture.cipher,
    env: fixture.env,
    proposalId: proposal.proposalId,
    approvedVersion: 1,
    approvedBodyDigest: proposal.bodyDigest,
    approvedBy: fixture.world.userId,
    now: NOW + 1_000,
    fetcher: graph.fetcher,
  });
  expect(dispatched.ok && dispatched.value).toEqual({
    kind: "rejected",
    providerCode: "131047",
  });
  // The proposal is still approvable: nothing was delivered.
  expect(latestWhatsAppProposal(fixture.sql, proposal.proposalId)?.state).toBe(
    "awaiting_approval",
  );
}

async function ownershipTest(): Promise<void> {
  const fixture = await createSendFixture();
  const proposal = await seedProposal(fixture);
  requestWhatsAppHandoff(
    fixture.sql,
    fixture.world.caseId,
    "needs a human",
    NOW + 10,
  );
  await fixture.world.db
    .prepare(
      `UPDATE whatsapp_case_conversation_window SET handoff_requested_at = ?, handoff_reason = ?
      WHERE case_id = ?`,
    )
    .bind(NOW + 10, "needs a human", fixture.world.caseId)
    .run();
  const graph = createFakeGraph();
  const dispatched = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: fixture.scope,
    sql: fixture.sql,
    cipher: fixture.cipher,
    env: fixture.env,
    proposalId: proposal.proposalId,
    approvedVersion: 1,
    approvedBodyDigest: proposal.bodyDigest,
    approvedBy: fixture.world.userId,
    now: NOW + 1_000,
    fetcher: graph.fetcher,
  });
  expect(dispatched.ok && dispatched.value).toEqual({
    kind: "refused",
    reason: "ownership_conflict",
  });
  expect(graph.sentBodies()).toHaveLength(0);
}

async function revokedConnectionTest(): Promise<void> {
  const fixture = await createSendFixture();
  const proposal = await seedProposal(fixture);
  const graph = createFakeGraph();
  await fixture.world.db
    .prepare(
      `UPDATE provider_connection SET lifecycle = 'revoked', revoked_at = ? WHERE organisation_id = ?`,
    )
    .bind(NOW, fixture.world.organisationId)
    .run();
  const dispatched = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: fixture.scope,
    sql: fixture.sql,
    cipher: fixture.cipher,
    env: fixture.env,
    proposalId: proposal.proposalId,
    approvedVersion: 1,
    approvedBodyDigest: proposal.bodyDigest,
    approvedBy: fixture.world.userId,
    now: NOW + 1_000,
    fetcher: graph.fetcher,
  });
  expect(dispatched.ok && dispatched.value).toEqual({
    kind: "refused",
    reason: "connection_inactive",
  });
  expect(graph.sentBodies()).toHaveLength(0);
}

async function editTest(): Promise<void> {
  const fixture = await createSendFixture();
  const proposal = await seedProposal(fixture);
  const edited = await editWhatsAppProposal({
    authorizeExecution: authorizeWhatsAppFixture,
    sql: fixture.sql,
    cipher: fixture.cipher,
    proposalId: proposal.proposalId,
    body: "We open at 9am on Sunday.",
    maxReplyChars: 4_000,
    now: NOW + 500,
  });
  expect(edited.ok && edited.value.kind).toBe("versioned");
  if (!edited.ok || edited.value.kind !== "versioned") return;
  expect(edited.value.version).toBe(2);

  const graph = createFakeGraph();
  const stale = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: fixture.scope,
    sql: fixture.sql,
    cipher: fixture.cipher,
    env: fixture.env,
    proposalId: proposal.proposalId,
    approvedVersion: 1,
    approvedBodyDigest: proposal.bodyDigest,
    approvedBy: fixture.world.userId,
    now: NOW + 1_000,
    fetcher: graph.fetcher,
  });
  expect(stale.ok && stale.value.kind).toBe("stale_approval");

  const preview = await previewWhatsAppProposal({
    scope: fixture.scope,
    sql: fixture.sql,
    cipher: fixture.cipher,
    proposalId: proposal.proposalId,
    now: NOW + 1_000,
  });
  expect(
    preview.ok &&
      preview.value.kind === "current" &&
      preview.value.preview.body,
  ).toBe("We open at 9am on Sunday.");

  const sent = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: fixture.scope,
    sql: fixture.sql,
    cipher: fixture.cipher,
    env: fixture.env,
    proposalId: proposal.proposalId,
    approvedVersion: 2,
    approvedBodyDigest: edited.value.bodyDigest,
    approvedBy: fixture.world.userId,
    now: NOW + 1_500,
    fetcher: graph.fetcher,
  });
  expect(sent.ok && sent.value.kind).toBe("sent");
  expect(JSON.parse(graph.sentBodies()[0] ?? "{}").text.body).toBe(
    "We open at 9am on Sunday.",
  );
}

async function expiredProposalTest(): Promise<void> {
  const fixture = await createSendFixture();
  const proposal = await seedProposal(fixture);
  disposeWhatsAppProposal({
    sql: fixture.sql,
    proposalId: proposal.proposalId,
    state: "expired",
    now: NOW + 500,
  });

  const preview = await previewWhatsAppProposal({
    scope: fixture.scope,
    sql: fixture.sql,
    cipher: fixture.cipher,
    proposalId: proposal.proposalId,
    now: NOW + 1_000,
  });
  expect(preview.ok && preview.value).toEqual({ kind: "expired" });

  const graph = createFakeGraph();
  const dispatched = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: fixture.scope,
    sql: fixture.sql,
    cipher: fixture.cipher,
    env: fixture.env,
    proposalId: proposal.proposalId,
    approvedVersion: 1,
    approvedBodyDigest: proposal.bodyDigest,
    approvedBy: fixture.world.userId,
    now: NOW + 1_000,
    fetcher: graph.fetcher,
  });
  expect(dispatched.ok && dispatched.value).toEqual({ kind: "expired" });
  expect(graph.sentBodies()).toHaveLength(0);
}

/** A proposal frozen against the previous organisation credential must be re-approved. */
async function generationTest(): Promise<void> {
  const fixture = await createSendFixture();
  const proposal = await seedProposal(fixture, { credentialGeneration: 1 });
  const graph = createFakeGraph();

  // The organisation reconnected and rotated to generation 2 while approval waited.
  await fixture.world.db
    .prepare(
      `UPDATE provider_credential_generation SET lifecycle = 'superseded', superseded_at = ?
      WHERE organisation_id = ? AND credential_generation = 1`,
    )
    .bind(NOW + 500, fixture.world.organisationId)
    .run();
  await fixture.world.db
    .prepare(
      `INSERT INTO provider_credential_generation (
       provider_connection_id, credential_generation, organisation_id, provider,
       environment, credential_ref, lifecycle, created_at, activated_at
     )
     SELECT provider_connection_id, 2, organisation_id, provider, environment,
            credential_ref, 'active', ?, ?
       FROM provider_connection WHERE organisation_id = ?`,
    )
    .bind(NOW + 500, NOW + 500, fixture.world.organisationId)
    .run();
  await fixture.world.db
    .prepare(
      `UPDATE provider_connection SET credential_generation = 2 WHERE organisation_id = ?`,
    )
    .bind(fixture.world.organisationId)
    .run();
  const dispatched = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: fixture.scope,
    sql: fixture.sql,
    cipher: fixture.cipher,
    env: fixture.env,
    proposalId: proposal.proposalId,
    approvedVersion: 1,
    approvedBodyDigest: proposal.bodyDigest,
    approvedBy: fixture.world.userId,
    now: NOW + 1_000,
    fetcher: graph.fetcher,
  });
  expect(dispatched.ok && dispatched.value).toEqual({
    kind: "refused",
    reason: "authority_moved",
  });
  expect(graph.sentBodies()).toHaveLength(0);
}

/**
 * Reassigning the agent or republishing the ingress policy supersedes the
 * authority a waiting proposal was produced under.
 */
async function assignmentTest(): Promise<void> {
  const reassigned = await createSendFixture();
  const first = await seedProposal(reassigned);
  await reassigned.world.db
    .prepare(
      "UPDATE whatsapp_support_binding SET current_revision = 2 WHERE organisation_id = ?",
    )
    .bind(reassigned.world.organisationId)
    .run();
  const graph = createFakeGraph();
  const staleBinding = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: reassigned.scope,
    sql: reassigned.sql,
    cipher: reassigned.cipher,
    env: reassigned.env,
    proposalId: first.proposalId,
    approvedVersion: 1,
    approvedBodyDigest: first.bodyDigest,
    approvedBy: reassigned.world.userId,
    now: NOW + 1_000,
    fetcher: graph.fetcher,
  });
  expect(staleBinding.ok && staleBinding.value).toEqual({
    kind: "refused",
    reason: "authority_moved",
  });

  const republished = await createSendFixture();
  const second = await seedProposal(republished);
  const policy = await publishWhatsAppIngressPolicy({
    db: republished.world.db,
    organisationId: republished.world.organisationId,
    integrationAccountId: republished.world.integrationAccountId,
    environment: "development",
    request: {
      kind: "enabled",
      maxActiveCases: 9,
      maxMessagesPerHour: 90,
      dailyAgentTokenBudget: 300_000,
      maxMessageBytes: 4_096,
      maxActiveCaseMessages: 20,
      maxActiveCaseBytes: 32_768,
      debounceSeconds: 20,
      relevantMessageTopics:
        "Café, cafe automation, cafe, and bakery topics.",
      automaticAcknowledgementText:
        "Thanks for your message. We’ll get back to you shortly.",
      agentMode: "answer",
      alwaysWaitTopics: "",
      overflow: "pause_and_notify",
      notificationDestination: {
        kind: "organisation_communication_destination",
      },
    },
    publishedBy: republished.world.userId,
    now: NOW + 500,
  });
  expect(policy.ok).toBe(true);
  const stalePolicy = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: republished.scope,
    sql: republished.sql,
    cipher: republished.cipher,
    env: republished.env,
    proposalId: second.proposalId,
    approvedVersion: 1,
    approvedBodyDigest: second.bodyDigest,
    approvedBy: republished.world.userId,
    now: NOW + 1_000,
    fetcher: graph.fetcher,
  });
  expect(stalePolicy.ok && stalePolicy.value).toEqual({
    kind: "refused",
    reason: "authority_moved",
  });
  expect(graph.sentBodies()).toHaveLength(0);
}

async function resolutionTest(): Promise<void> {
  const fixture = await createSendFixture();
  const proposal = await seedProposal(fixture);
  const graph = createFakeGraph({
    sendOutcomes: [{ kind: "network_failure" }],
  });
  const dispatched = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: fixture.scope,
    sql: fixture.sql,
    cipher: fixture.cipher,
    env: fixture.env,
    proposalId: proposal.proposalId,
    approvedVersion: 1,
    approvedBodyDigest: proposal.bodyDigest,
    approvedBy: fixture.world.userId,
    now: NOW + 1_000,
    fetcher: graph.fetcher,
  });
  expect(dispatched.ok && dispatched.value).toEqual({
    kind: "send_indeterminate",
    reason: "whatsapp_send_transport_failed",
  });

  const notDelivered = resolveWhatsAppIndeterminateSend({
    sql: fixture.sql,
    proposalId: proposal.proposalId,
    resolution: { kind: "not_delivered" },
    now: NOW + 2_000,
  });
  expect(notDelivered.ok && notDelivered.value.state).toBe("revoked");

  const second = await createSendFixture();
  const secondProposal = await seedProposal(second);
  const secondGraph = createFakeGraph({
    sendOutcomes: [{ kind: "network_failure" }],
  });
  await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: second.scope,
    sql: second.sql,
    cipher: second.cipher,
    env: second.env,
    proposalId: secondProposal.proposalId,
    approvedVersion: 1,
    approvedBodyDigest: secondProposal.bodyDigest,
    approvedBy: second.world.userId,
    now: NOW + 1_000,
    fetcher: secondGraph.fetcher,
  });
  const delivered = resolveWhatsAppIndeterminateSend({
    sql: second.sql,
    proposalId: secondProposal.proposalId,
    resolution: { kind: "delivered", whatsappMessageId: "wamid.OBSERVED" },
    now: NOW + 2_000,
  });
  expect(delivered.ok && delivered.value.state).toBe("sent");
  expect(
    latestWhatsAppProposal(second.sql, secondProposal.proposalId)
      ?.sentMessageId,
  ).toBe("wamid.OBSERVED");
}

function authorizeWhatsAppFixture(): Promise<boolean> {
  return Promise.resolve(true);
}
