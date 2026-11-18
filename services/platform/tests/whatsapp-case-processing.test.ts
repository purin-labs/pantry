import { createMigratedDatabase } from "./sqlite-d1";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { requireOrganisationId } from "./test-ids";
import { createActorExecutionBarrierSchema } from "../src/actors/actor-execution-quiescence";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";

const orchestratorMocks = vi.hoisted(() => ({
  resolveActiveCaseActorAtPlacement: vi.fn(),
  resolveActiveSessionActorAtPlacement: vi.fn(),
  prepareTransientEmailAssignment: vi.fn(),
  settleTransientEmailAssignment: vi.fn(),
  prepareTurnContext: vi.fn(),
  prepareTurnAuthority: vi.fn(),
  resolveOrganisationModelRoute: vi.fn(),
  loadOrganisationPolicyOrDefaultDeny: vi.fn(),
  ensureOrganisationDefaultWorkspace: vi.fn(),
  projectWhatsAppReplyProposal: vi.fn(),
  requestWhatsAppCaseHandoff: vi.fn(),
  readWhatsAppSendAuthority: vi.fn(),
  recordWhatsAppMessageReceipt: vi.fn(),
  resolveWhatsAppOrganisationCredential: vi.fn(),
}));

vi.mock("../src/actors/actor-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/actors/actor-router")>()),
  resolveActiveCaseActorAtPlacement: orchestratorMocks.resolveActiveCaseActorAtPlacement,
  resolveActiveSessionActorAtPlacement: orchestratorMocks.resolveActiveSessionActorAtPlacement,
}));
vi.mock("../src/actors/case-walking-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/actors/case-walking-path")>()),
  prepareTransientEmailAssignment:
    orchestratorMocks.prepareTransientEmailAssignment,
  settleTransientEmailAssignment:
    orchestratorMocks.settleTransientEmailAssignment,
}));
vi.mock("../src/context/turn-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/context/turn-context")>()),
  prepareTurnContext: orchestratorMocks.prepareTurnContext,
  prepareTurnAuthority: orchestratorMocks.prepareTurnAuthority,
}));
vi.mock("../src/models/route", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/models/route")>()),
  resolveOrganisationModelRoute: orchestratorMocks.resolveOrganisationModelRoute,
}));
vi.mock("../src/policy-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/policy-snapshot")>()),
  loadOrganisationPolicyOrDefaultDeny:
    orchestratorMocks.loadOrganisationPolicyOrDefaultDeny,
}));
vi.mock("../src/data/organisation-workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/organisation-workspace")>()),
  ensureOrganisationDefaultWorkspace: orchestratorMocks.ensureOrganisationDefaultWorkspace,
}));
vi.mock("../src/data/whatsapp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/whatsapp")>()),
  projectWhatsAppReplyProposal: orchestratorMocks.projectWhatsAppReplyProposal,
  requestWhatsAppCaseHandoff: orchestratorMocks.requestWhatsAppCaseHandoff,
  readWhatsAppSendAuthority: orchestratorMocks.readWhatsAppSendAuthority,
  recordWhatsAppMessageReceipt: orchestratorMocks.recordWhatsAppMessageReceipt,
}));
vi.mock("../src/whatsapp/credential", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/whatsapp/credential")>()),
  resolveWhatsAppOrganisationCredential:
    orchestratorMocks.resolveWhatsAppOrganisationCredential,
}));

import {
  beginWhatsAppAdmission,
  commitWhatsAppAdmission,
  createConnectorWhatsAppSchema,
  activateWhatsAppRuntime,
  latestWhatsAppProposal,
  readWhatsAppEnvelope,
  readWhatsAppCase,
  readWhatsAppRuntime,
  reserveWhatsAppTokens,
  settleWhatsAppReservation,
  utcDayKey,
  whatsAppTokenWindowTotals,
  type WhatsAppIngressLimits,
} from "../src/actors/connector-whatsapp";
import { dispatchWhatsAppReply } from "../src/actors/connector-whatsapp-proposal";
import { readWhatsAppCasePanel } from "../src/actors/connector-whatsapp-rpc";
import { processWhatsAppCaseTurn } from "../src/actors/whatsapp-case-processing";
import {
  createWhatsAppContentCipher,
  type WhatsAppContentCipher,
} from "../src/actors/whatsapp-active-content";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { testRootSecret } from "./whatsapp/environment";
import { createFakeGraph } from "./whatsapp/fake-graph";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

/**
 * The turn that turns admitted customer text into a reply proposal. It is the
 * one place agent inference touches WhatsApp content, so what it does with the
 * token window, the assignment, and the sealed proposal is the property under
 * test — not the model behind it.
 */

const NOW = 1_784_016_325_277;
const ORGANISATION = "organisation_whatsapp_turn";
const ACCOUNT = "integration_whatsapp_turn";
const CUSTOMER = "15550002222";
const CASE_ID = `case_whatsapp_${CUSTOMER}_1`;
const SERVICE_WINDOW_EXPIRES_AT = NOW + 24 * 3_600_000;
const CUSTOMER_TEXT = "Where is my order 8842?";

describe("whatsapp case turn", whatsAppCaseTurnSuite);

function whatsAppCaseTurnSuite(): void {
  it(
    "routes a relevant customer text through the agent and WhatsApp send boundary",
    successTest,
  );
  it(
    "routes an irrelevant text to an acknowledgement without invoking the support agent",
    irrelevantTest,
  );
  it(
    "fails closed before decrypting a corrupt envelope direction",
    corruptEnvelopeDirectionTest,
  );
  it(
    "charges the reserved allowance and settles failed when model usage is unknown",
    failureTest,
  );
  it("records a handoff instead of a proposal", handoffTest);
  it(
    "holds a reply for a person in the draft setting and for a topic that always waits, and runs no agent with none",
    agentSettingTest,
  );
  it("skips and pauses the account when the daily budget is spent", budgetTest);
  it("refuses to start a turn it could not send the answer of", windowTest);
  it(
    "supersedes an open proposal when a later message produces a turn",
    supersedeTest,
  );
}

function limits(
  overrides: Partial<WhatsAppIngressLimits> = {},
): WhatsAppIngressLimits {
  return {
    maxActiveCases: 3,
    maxMessagesPerHour: 20,
    dailyAgentTokenBudget: 100_000,
    maxMessageBytes: 4_096,
    maxActiveCaseMessages: 20,
    maxActiveCaseBytes: 32_768,
    debounceSeconds: 15,
    ...overrides,
  };
}

type Harness = {
  readonly storage: DurableObjectStorage;
  readonly sql: ReturnType<typeof sqlStorage>;
  readonly cipher: WhatsAppContentCipher;
  readonly env: UnitTestEnv;
  readonly scope: import("../src/organisation-execution-scope").OrganisationExecutionScope;
  readonly caseActor: {
    inspect: ReturnType<typeof vi.fn>;
    beginAssignment: ReturnType<typeof vi.fn>;
  };
  readonly session: {
    inspectCanonicalSessionState: ReturnType<typeof vi.fn>;
    runTransientWhatsAppTurn: ReturnType<typeof vi.fn>;
  };
};

async function setup(
  turnOutcome: unknown,
  options: Readonly<{ limits?: WhatsAppIngressLimits }> = {},
): Promise<Harness> {
  vi.clearAllMocks();
  const applied = options.limits ?? limits();
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createConnectorWhatsAppSchema(sql);
  createActorExecutionBarrierSchema(sql);
  const activated = activateWhatsAppRuntime(sql, {
    organisationId: ORGANISATION,
    integrationAccountId: ACCOUNT,
    policyVersion: 1,
    limits: applied,
    supportBindingId: "whatsapp_binding_turn",
    bindingRevision: 2,
    credentialGeneration: 1,
    now: NOW - 3_600_000,
  });
  if (!activated.ok) throw new Error(activated.error.code);
  const created = await createWhatsAppContentCipher({
    root: testRootSecret(),
    organisationId: ORGANISATION,
    integrationAccountId: ACCOUNT,
  });
  if (!created.ok) throw new Error(created.error.code);
  const cipher = created.value;
  await admit(sql, cipher, "wamid.TURN1", CUSTOMER_TEXT, applied);

  const caseActor = {
    inspect: vi.fn(),
    beginAssignment: vi
      .fn()
      .mockResolvedValue({ ok: true, value: { kind: "running" } }),
  };
  const session = {
    inspectCanonicalSessionState: vi.fn(),
    runTransientWhatsAppTurn: vi.fn().mockResolvedValue(turnOutcome),
  };
  orchestratorMocks.resolveActiveCaseActorAtPlacement.mockResolvedValue({
    ok: true,
    value: caseActor,
  });
  orchestratorMocks.resolveActiveSessionActorAtPlacement.mockResolvedValue({
    ok: true,
    value: session,
  });
  orchestratorMocks.resolveOrganisationModelRoute.mockResolvedValue({
    ok: true,
    value: {
      provider: "openai-compatible",
      keySource: "platform",
      model: "test-model",
    },
  });
  orchestratorMocks.loadOrganisationPolicyOrDefaultDeny.mockResolvedValue({
    snapshot: {
      version: 4,
      egress: {},
      authz: {
        maxBudget: { maxTokens: 150_000, maxWallMs: 120_000, maxToolCalls: 20 },
      },
      conversationRisk: {},
    },
  });
  orchestratorMocks.ensureOrganisationDefaultWorkspace.mockResolvedValue({
    ok: true,
    value: { revision: "workspace_rev_1" },
  });
  orchestratorMocks.prepareTurnContext.mockResolvedValue({
    ok: true,
    value: {
      turnAuthority: {
        requestAuthority: {},
        authorityPartition: { digest: "d".repeat(64) },
      },
      context: { bundleDigest: "b".repeat(64) },
    },
  });
  orchestratorMocks.prepareTransientEmailAssignment.mockResolvedValue({
    ok: true,
    value: {
      assignment: {
        caseId: CASE_ID,
        assignmentId: `assignment_${CASE_ID}_1`,
        sessionId: `session_${CASE_ID}_1`,
        caseRevision: 3,
        authority: { authorityPartitionDigest: "d".repeat(64) },
      },
      startId: "start_turn_whatsapp_1",
      budget: {
        budgetRevision: "budget_4",
        maxTokens: 150_000,
        maxWallMs: 120_000,
        maxToolCalls: 20,
      },
    },
  });
  orchestratorMocks.settleTransientEmailAssignment.mockResolvedValue({
    ok: true,
    value: null,
  });
  orchestratorMocks.projectWhatsAppReplyProposal.mockResolvedValue({
    ok: true,
    value: null,
  });
  orchestratorMocks.requestWhatsAppCaseHandoff.mockResolvedValue({
    ok: true,
    value: null,
  });
  orchestratorMocks.readWhatsAppSendAuthority.mockResolvedValue({
    kind: "authorized",
    phoneNumberId: "1382737203652787",
    customerWaId: CUSTOMER,
    policyVersion: 1,
    supportBindingId: "whatsapp_binding_turn",
    bindingRevision: 2,
    credentialGeneration: 1,
    serviceWindowExpiresAt: SERVICE_WINDOW_EXPIRES_AT,
    ownership: { kind: "agent_active" },
    handoffRequestedAt: null,
  });
  orchestratorMocks.recordWhatsAppMessageReceipt.mockResolvedValue({
    kind: "recorded",
  });
  orchestratorMocks.resolveWhatsAppOrganisationCredential.mockResolvedValue({
    ok: true,
    value: {
      accessToken: "fixture-customer-business-token",
      expiresAt: NOW + 60 * 24 * 60 * 60 * 1_000,
      credentialGeneration: 1,
    },
  });
  const env = platformEnv({
    DB: createMigratedDatabase(),
    SATYR_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    DATA_ENCRYPTION_ROOT: testRootSecret(),
    WHATSAPP_APP_ID: "1000000000000001",
    WHATSAPP_APP_SECRET: "fixture-app-secret",
  });
  await env.DB.prepare(
    "INSERT INTO organisation (organisation_id, name, created_at) VALUES (?, 'WhatsApp turn fixture', ?)",
  )
    .bind(ORGANISATION, NOW)
    .run();
  const placement = await ensureInitialOrganisationPlacement({
    db: env.DB,
    organisationId: requireOrganisationId(ORGANISATION),
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  if (!placement.ok) throw new Error(placement.error.code);
  const scope = await requireOrganisationExecutionScope(env, requireOrganisationId(ORGANISATION));
  return {
    scope,
    storage: { sql } as unknown as DurableObjectStorage,
    sql,
    cipher,
    env,
    caseActor,
    session,
  };
}

async function admit(
  sql: ReturnType<typeof sqlStorage>,
  cipher: WhatsAppContentCipher,
  providerMessageId: string,
  body: string,
  applied: WhatsAppIngressLimits,
): Promise<void> {
  const bytes = new TextEncoder().encode(body).byteLength;
  const reserved = beginWhatsAppAdmission(sql, {
    providerMessageId,
    customerWaId: CUSTOMER,
    providerTimestamp: NOW,
    declaredBytes: bytes,
    limits: applied,
    caseIdFor: () => CASE_ID,
    now: NOW,
  });
  if (reserved.kind !== "ready") throw new Error(reserved.kind);
  const sealed = await cipher.seal(
    reserved.caseId,
    { kind: "message", providerMessageId },
    body,
  );
  commitWhatsAppAdmission(sql, {
    caseId: reserved.caseId,
    providerMessageId,
    customerWaId: CUSTOMER,
    providerTimestamp: NOW,
    nonceB64: sealed.nonceB64,
    ciphertextB64: sealed.ciphertextB64,
    bytes,
    limits: applied,
    policyVersion: 1,
    now: NOW,
  });
}

function turnInput(
  harness: Harness,
  overrides: Readonly<{
    limits?: WhatsAppIngressLimits;
    serviceWindowExpiresAt?: number;
    cuePolicy?: {
      readonly relevantMessageTopics: string;
      readonly automaticAcknowledgementText: string;
      readonly agentMode: "off" | "draft" | "answer";
      readonly alwaysWaitTopics: string;
    };
  }> = {},
) {
  return {
    scope: harness.scope,
    connectorSql: harness.sql,
    cipher: harness.cipher,
    organisationId: ORGANISATION,
    integrationAccountId: ACCOUNT,
    caseId: CASE_ID,
    customerWaId: CUSTOMER,
    businessDisplayPhoneNumber: "+15550001111",
    supportBindingId: "whatsapp_binding_turn",
    bindingRevision: 2,
    policyVersion: 1,
    cuePolicy: overrides.cuePolicy ?? {
      relevantMessageTopics:
        "CafeOS, cafe automation, cafe, bakery, order, cancel, and products.",
      automaticAcknowledgementText:
        "Thanks for your message. We’ll get back to you shortly.",
      agentMode: "answer" as const,
      alwaysWaitTopics: "",
    },
    limits: overrides.limits ?? limits(),
    credentialGeneration: 1,
    serviceWindowExpiresAt:
      overrides.serviceWindowExpiresAt ?? SERVICE_WINDOW_EXPIRES_AT,
    now: NOW,
  };
}

async function agentSettingTest(): Promise<void> {
  const policy = (
    agentMode: "off" | "draft" | "answer",
    alwaysWaitTopics: string,
  ) => ({
    relevantMessageTopics: "order",
    automaticAcknowledgementText: "Thanks for your message.",
    agentMode,
    alwaysWaitTopics,
  });
  const offHarness = await setup(proposed("never reached", 30));
  const off = await processWhatsAppCaseTurn(
    offHarness.env,
    turnInput(offHarness, { cuePolicy: policy("off", "") }),
  );
  expect(off).toMatchObject({
    ok: true,
    value: { disposition: "acknowledge_without_agent", hold: false },
  });
  expect(offHarness.session.runTransientWhatsAppTurn).not.toHaveBeenCalled();

  const draftHarness = await setup(proposed("A draft.", 30));
  const draft = await processWhatsAppCaseTurn(
    draftHarness.env,
    turnInput(draftHarness, { cuePolicy: policy("draft", "") }),
  );
  expect(draft).toMatchObject({
    ok: true,
    value: { disposition: "agent_reply_now", hold: true },
  });

  const waitWord = CUSTOMER_TEXT.toLowerCase().split(/\W+/u).at(-2) ?? "";
  const waitsHarness = await setup(proposed("A held reply.", 30));
  const waits = await processWhatsAppCaseTurn(
    waitsHarness.env,
    turnInput(waitsHarness, { cuePolicy: policy("answer", waitWord) }),
  );
  expect(waits).toMatchObject({ ok: true, value: { hold: true } });

  // A word inside another word does not match, so the reply goes as before.
  const partHarness = await setup(proposed("A reply.", 30));
  const part = await processWhatsAppCaseTurn(
    partHarness.env,
    turnInput(partHarness, {
      cuePolicy: policy("answer", waitWord.slice(0, -1) + "zz"),
    }),
  );
  expect(part).toMatchObject({ ok: true, value: { hold: false } });
}

async function irrelevantTest(): Promise<void> {
  const acknowledgement =
    "Thanks for your message. We’ll get back to you shortly.";
  const harness = await setup(proposed("never reached", 30));
  const outcome = await processWhatsAppCaseTurn(
    harness.env,
    turnInput(harness, {
      cuePolicy: {
        relevantMessageTopics:
          "CafeOS, cafe automation, cafe, bakery, and products.",
        automaticAcknowledgementText: acknowledgement,
        agentMode: "answer" as const,
        alwaysWaitTopics: "",
      },
    }),
  );

  expect(outcome).toEqual({
    ok: true,
    value: {
      kind: "proposed",
      proposalId: `proposal_${CASE_ID}_1`,
      version: 1,
      disposition: "acknowledge_without_agent",
      hold: false,
    },
  });
  expect(harness.session.runTransientWhatsAppTurn).not.toHaveBeenCalled();
  expect(whatsAppTokenWindowTotals(harness.sql, utcDayKey(NOW))).toEqual({
    reserved: 0,
    consumed: 0,
  });
  const proposal = latestWhatsAppProposal(harness.sql, `proposal_${CASE_ID}_1`);
  expect(proposal?.author).toBe("agent");
  const opened = await harness.cipher.open(
    CASE_ID,
    { kind: "proposal", proposalId: `proposal_${CASE_ID}_1`, version: 1 },
    {
      nonceB64: proposal?.nonceB64 ?? "",
      ciphertextB64: proposal?.ciphertextB64 ?? "",
    },
  );
  expect(opened.ok && opened.value).toBe(acknowledgement);
  const graph = createFakeGraph({
    sendOutcomes: [{ kind: "accepted", whatsappMessageId: "wamid.ACKOUT1" }],
  });
  const sent = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: harness.scope,
    sql: harness.sql,
    cipher: harness.cipher,
    env: harness.env,
    proposalId: `proposal_${CASE_ID}_1`,
    approvedVersion: 1,
    approvedBodyDigest: proposal?.bodyDigest ?? "",
    approvedBy: "system:whatsapp_cue_engine",
    now: NOW + 1,
    fetcher: graph.fetcher,
  });
  expect(sent.ok && sent.value.kind).toBe("sent");
  expect(JSON.parse(graph.sentBodies()[0] ?? "{}")).toMatchObject({
    text: { body: acknowledgement },
  });
  expect(readEnvelope(harness.sql, CASE_ID).at(-1)?.direction).toBe("outbound");
  const panel = await readWhatsAppCasePanel(
    { storage: harness.storage, env: harness.env, scope: harness.scope },
    CASE_ID,
  );
  expect(panel.ok && panel.value.messages.map(readMessageText)).toEqual([
    CUSTOMER_TEXT,
    acknowledgement,
  ]);
}

function proposed(body: string, totalTokens: number): unknown {
  return {
    ok: true,
    value: {
      outcome: { kind: "proposal", body },
      modelUsage: {
        modelCalls: 1,
        callsWithUsage: 1,
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0,
        totalTokens,
      },
    },
  };
}

async function successTest(): Promise<void> {
  const harness = await setup(proposed("Your order ships Monday.", 30));
  const outcome = await processWhatsAppCaseTurn(
    harness.env,
    turnInput(harness),
  );
  expect(outcome).toEqual({
    ok: true,
    value: {
      kind: "proposed",
      proposalId: `proposal_${CASE_ID}_1`,
      version: 1,
      disposition: "agent_reply_now",
      hold: false,
    },
  });

  // The reservation settles to actual usage, not the allowance it held.
  expect(whatsAppTokenWindowTotals(harness.sql, utcDayKey(NOW))).toEqual({
    reserved: 0,
    consumed: 30,
  });

  // The proposal is sealed, and its digest is keyed rather than a bare hash of
  // the reply — dispatch recomputes it the same way before sending.
  const proposal = latestWhatsAppProposal(harness.sql, `proposal_${CASE_ID}_1`);
  expect(proposal?.state).toBe("awaiting_approval");
  expect(proposal?.ciphertextB64).not.toBeNull();
  expect(proposal?.bodyDigest).toBe(
    await harness.cipher.digest("Your order ships Monday."),
  );
  const opened = await harness.cipher.open(
    CASE_ID,
    { kind: "proposal", proposalId: `proposal_${CASE_ID}_1`, version: 1 },
    {
      nonceB64: proposal?.nonceB64 ?? "",
      ciphertextB64: proposal?.ciphertextB64 ?? "",
    },
  );
  expect(opened.ok && opened.value).toBe("Your order ships Monday.");

  const graph = createFakeGraph({
    sendOutcomes: [{ kind: "accepted", whatsappMessageId: "wamid.AGENTOUT1" }],
  });
  const sent = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: harness.scope,
    sql: harness.sql,
    cipher: harness.cipher,
    env: harness.env,
    proposalId: `proposal_${CASE_ID}_1`,
    approvedVersion: 1,
    approvedBodyDigest: proposal?.bodyDigest ?? "",
    approvedBy: "system:whatsapp_cue_engine",
    now: NOW + 1,
    fetcher: graph.fetcher,
  });
  expect(sent.ok && sent.value.kind).toBe("sent");
  expect(JSON.parse(graph.sentBodies()[0] ?? "{}")).toMatchObject({
    text: { body: "Your order ships Monday." },
  });
  expect(readEnvelope(harness.sql, CASE_ID).at(-1)?.direction).toBe("outbound");
  const panel = await readWhatsAppCasePanel(
    { storage: harness.storage, env: harness.env, scope: harness.scope },
    CASE_ID,
  );
  expect(panel.ok && panel.value.messages.map(readMessageText)).toEqual([
    CUSTOMER_TEXT,
    "Your order ships Monday.",
  ]);
}

function readMessageText(message: { readonly text: string }): string {
  return message.text;
}

function readEnvelope(
  sql: Parameters<typeof readWhatsAppEnvelope>[0],
  caseId: string,
) {
  const envelope = readWhatsAppEnvelope(sql, caseId);
  if (!envelope.ok) throw new Error(envelope.error.code);
  return envelope.value;
}

async function corruptEnvelopeDirectionTest(): Promise<void> {
  const harness = await setup(proposed("must not run", 30));
  harness.sql.exec("PRAGMA ignore_check_constraints = ON");
  try {
    harness.sql.exec(
      "UPDATE connector_whatsapp_envelope SET direction = ? WHERE case_id = ?",
      "unknown",
      CASE_ID,
    );
    const open = vi.spyOn(harness.cipher, "open");

    const outcome = await processWhatsAppCaseTurn(
      harness.env,
      turnInput(harness),
    );

    expect(outcome).toEqual({
      ok: false,
      error: { code: "connector_whatsapp_storage_corrupt" },
    });
    expect(open).not.toHaveBeenCalled();
  } finally {
    harness.sql.exec("PRAGMA ignore_check_constraints = OFF");
  }
}

async function failureTest(): Promise<void> {
  const harness = await setup({
    ok: false,
    error: { code: "transient_whatsapp_turn_failed", modelUsage: null },
  });
  const outcome = await processWhatsAppCaseTurn(
    harness.env,
    turnInput(harness),
  );
  expect(outcome).toEqual({
    ok: false,
    error: { code: "transient_whatsapp_turn_failed" },
  });

  // Missing usage retains the conservative charge for the dispatched attempt.
  expect(whatsAppTokenWindowTotals(harness.sql, utcDayKey(NOW))).toEqual({
    reserved: 0,
    consumed: 60000,
  });
  expect(
    latestWhatsAppProposal(harness.sql, `proposal_${CASE_ID}_1`),
  ).toBeNull();
}

async function handoffTest(): Promise<void> {
  const harness = await setup({
    ok: true,
    value: {
      outcome: {
        kind: "handoff",
        reason: "Customer is asking for a refund decision.",
      },
      modelUsage: {
        modelCalls: 1,
        callsWithUsage: 1,
        inputTokens: 5,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
        totalTokens: 10,
      },
    },
  });
  const outcome = await processWhatsAppCaseTurn(
    harness.env,
    turnInput(harness),
  );
  expect(outcome).toEqual({
    ok: true,
    value: {
      kind: "handoff",
      reason: "Customer is asking for a refund decision.",
    },
  });
  expect(whatsAppTokenWindowTotals(harness.sql, utcDayKey(NOW))).toEqual({
    reserved: 0,
    consumed: 10,
  });
  expect(
    latestWhatsAppProposal(harness.sql, `proposal_${CASE_ID}_1`),
  ).toBeNull();
  expect(readWhatsAppCase(harness.sql, CASE_ID)?.handoffRequestedAt).toBe(NOW);
}

async function budgetTest(): Promise<void> {
  const harness = await setup(proposed("never reached", 30), {
    limits: limits({ dailyAgentTokenBudget: 1 }),
  });
  // Spend the window before the turn is attempted.
  const spent = reserveWhatsAppTokens(harness.sql, {
    reservationId: "turn_prior",
    utcDay: utcDayKey(NOW),
    tokens: 1,
    limit: 1,
    now: NOW - 1_000,
  });
  expect(spent.kind).toBe("reserved");
  settleWhatsAppReservation(harness.sql, {
    reservationId: "turn_prior",
    actualTokens: 1,
  });
  const outcome = await processWhatsAppCaseTurn(
    harness.env,
    turnInput(harness, { limits: limits({ dailyAgentTokenBudget: 1 }) }),
  );
  expect(outcome.ok && outcome.value.kind).toBe("skipped");
  expect(
    outcome.ok && outcome.value.kind === "skipped" && outcome.value.reason,
  ).toBe("daily_token_budget_exhausted");

  // No inference ran, and the account stopped taking agent work.
  expect(harness.session.runTransientWhatsAppTurn).not.toHaveBeenCalled();
  const runtime = readWhatsAppRuntime(harness.sql);
  expect(runtime?.processing.kind).toBe("paused");
  if (runtime?.processing.kind === "paused") {
    expect(runtime.processing.reason.kind).toBe("daily_token_budget");
  }
  // A pause an operator must be told about carries a notice to deliver.
  expect(
    outcome.ok &&
      outcome.value.kind === "skipped" &&
      outcome.value.pendingNoticeKey,
  ).not.toBeNull();
}

async function windowTest(): Promise<void> {
  const harness = await setup(proposed("never reached", 30));
  // Inside the window, but with less than the safety margin left: an approver
  // could not read and approve in time, so starting the turn would only spend
  // budget on a reply that can never be sent.
  const outcome = await processWhatsAppCaseTurn(
    harness.env,
    turnInput(harness, { serviceWindowExpiresAt: NOW + 60_000 }),
  );
  expect(outcome).toEqual({
    ok: true,
    value: {
      kind: "skipped",
      reason: "service_window_closing",
      pendingNoticeKey: null,
    },
  });
  expect(harness.session.runTransientWhatsAppTurn).not.toHaveBeenCalled();
  expect(whatsAppTokenWindowTotals(harness.sql, utcDayKey(NOW))).toEqual({
    reserved: 0,
    consumed: 0,
  });
}

async function supersedeTest(): Promise<void> {
  const harness = await setup(proposed("Your order ships Monday.", 30));
  const first = await processWhatsAppCaseTurn(harness.env, turnInput(harness));
  expect(first.ok && first.value.kind).toBe("proposed");

  // The customer says something else. The second turn's proposal must retire
  // the first: approving a reply to a superseded question would send the wrong
  // answer, and the stale body would stay readable.
  await admit(
    harness.sql,
    harness.cipher,
    "wamid.TURN2",
    "Actually, cancel it.",
    limits(),
  );
  harness.session.runTransientWhatsAppTurn.mockResolvedValue(
    proposed("Your order is cancelled.", 20),
  );
  const second = await processWhatsAppCaseTurn(harness.env, turnInput(harness));
  expect(second).toEqual({
    ok: true,
    value: {
      kind: "proposed",
      proposalId: `proposal_${CASE_ID}_2`,
      version: 1,
      disposition: "agent_reply_now",
      hold: false,
    },
  });

  const superseded = latestWhatsAppProposal(
    harness.sql,
    `proposal_${CASE_ID}_1`,
  );
  expect(superseded?.state).toBe("superseded");
  expect(superseded?.ciphertextB64).toBeNull();
  expect(
    latestWhatsAppProposal(harness.sql, `proposal_${CASE_ID}_2`)?.state,
  ).toBe("awaiting_approval");
}

function authorizeWhatsAppFixture(): Promise<boolean> {
  return Promise.resolve(true);
}
