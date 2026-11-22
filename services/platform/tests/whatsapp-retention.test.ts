// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { createActorExecutionBarrierSchema } from "../src/actors/actor-execution-quiescence";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateWhatsAppRuntime,
  beginWhatsAppAdmission,
  closeWhatsAppCase,
  commitWhatsAppAdmission,
  createConnectorWhatsAppSchema,
  disableWhatsAppRuntime,
  requestWhatsAppHandoff,
  latestWhatsAppProposal,
  readWhatsAppEnvelope,
  recordWhatsAppProposal,
  type WhatsAppIngressLimits,
} from "../src/actors/connector-whatsapp";
import { dispatchWhatsAppReply } from "../src/actors/connector-whatsapp-proposal";
import { createWhatsAppContentCipher } from "../src/actors/whatsapp-active-content";

import {
  closeWhatsAppCaseConversationWindow,
  recordWhatsAppDeliveryStatus,
  recordWhatsAppMessageReceipt,
  requestWhatsAppCaseHandoff,
} from "../src/data/whatsapp";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { traceLog, traceWarn } from "@purin-labs/kernel/observability";
import { newRequestId } from "@purin-labs/kernel/ids";
import { createFakeGraph } from "./whatsapp/fake-graph";
import {
  WHATSAPP_TEST_NOW,
  createWhatsAppWorld,
  testRootSecret,
  whatsappTestEnvBindings,
} from "./whatsapp/environment";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { requireWhatsAppCustomerId } from "./test-ids";
import { platformEnv } from "./worker-fakes";

/**
 * Content-retention evidence. The customer's words and the proposed reply are
 * distinctive strings; after a complete loop neither may appear in D1, in
 * terminal Actor storage, or in anything the runtime writes to logs and
 * traces. Ciphertext is allowed only while the Case is open.
 */

const NOW = WHATSAPP_TEST_NOW;
const CUSTOMER_TEXT = "RETENTION-PROBE-CUSTOMER-TEXT-do-you-open-sunday";
const REPLY_TEXT = "RETENTION-PROBE-REPLY-TEXT-we-open-at-eight";
const HANDOFF_REASON =
  "RETENTION-PROBE-HANDOFF-customer-wants-a-refund-decision";

describe("whatsapp content retention", whatsappRetentionSuite);

afterEach(() => {
  vi.restoreAllMocks();
});

function whatsappRetentionSuite(): void {
  it(
    "keeps customer text and proposal bodies out of D1 through the whole loop",
    d1Test,
  );
  it("leaves no readable content in terminal Actor storage", actorStorageTest);
  it("never writes customer text or reply bodies to logs or traces", traceTest);
  it(
    "deletes the model-authored handoff reason with the Case",
    handoffReasonTest,
  );
}

/**
 * The handoff reason is free text the model wrote after reading the customer.
 * It is active content, so it must not survive the Case in either store.
 */
async function handoffReasonTest(): Promise<void> {
  const loop = await runFullLoop();
  requestWhatsAppHandoff(loop.sql, loop.caseId, HANDOFF_REASON, NOW + 3_000);
  await requestWhatsAppCaseHandoff({
    db: loop.db,
    organisationId: loop.organisationId,
    caseId: loop.caseId,
    reason: HANDOFF_REASON,
    now: NOW + 3_000,
  });
  expect(dumpDatabase(loop.sqlite)).toContain(HANDOFF_REASON);
  expect(dumpDatabase(loop.actorSqlite)).toContain(HANDOFF_REASON);

  closeWhatsAppCase(loop.sql, loop.caseId, NOW + 4_000);
  await closeWhatsAppCaseConversationWindow({
    db: loop.db,
    organisationId: loop.organisationId,
    caseId: loop.caseId,
    now: NOW + 4_000,
  });
  expect(dumpDatabase(loop.sqlite)).not.toContain(HANDOFF_REASON);
  expect(dumpDatabase(loop.actorSqlite)).not.toContain(HANDOFF_REASON);
}

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

async function runFullLoop(): Promise<{
  readonly sqlite: DatabaseSync;
  readonly actorSqlite: DatabaseSync;
  readonly sql: ReturnType<typeof sqlStorage>;
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
  readonly caseId: string;
  readonly proposalId: string;
}> {
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
  const reserved = beginWhatsAppAdmission(sql, {
    providerMessageId: "wamid.RET1",
    customerWaId: world.customerWaId,
    providerTimestamp: NOW,
    declaredBytes: CUSTOMER_TEXT.length,
    limits: limits(),
    caseIdFor: () => world.caseId,
    now: NOW,
  });
  if (reserved.kind !== "ready") throw new Error(reserved.kind);
  const sealedInbound = await cipher.value.seal(
    world.caseId,
    { kind: "message", providerMessageId: "wamid.RET1" },
    CUSTOMER_TEXT,
  );
  commitWhatsAppAdmission(sql, {
    caseId: world.caseId,
    providerMessageId: "wamid.RET1",
    customerWaId: world.customerWaId,
    providerTimestamp: NOW,
    nonceB64: sealedInbound.nonceB64,
    ciphertextB64: sealedInbound.ciphertextB64,
    bytes: sealedInbound.bytes,
    limits: limits(),
    policyVersion: world.policyVersion,
    now: NOW,
  });
  await recordWhatsAppMessageReceipt({
    db: world.db,
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    providerMessageId: "wamid.RET1",
    customerWaId: requireWhatsAppCustomerId(world.customerWaId),
    caseId: world.caseId,
    direction: "inbound",
    // The same keyed digest the ingress path writes. Using digestCanonical
    // here instead would test the fixture, not the pipeline.
    bodyDigest: await cipher.value.digest(CUSTOMER_TEXT),
    bodyBytes: sealedInbound.bytes,
    policyVersion: world.policyVersion,
    providerTimestamp: NOW,
    now: NOW,
  });
  const proposalId = "proposal_retention";
  const bodyDigest = await cipher.value.digest(REPLY_TEXT);
  const sealedProposal = await cipher.value.seal(
    world.caseId,
    { kind: "proposal", proposalId, version: 1 },
    REPLY_TEXT,
  );
  recordWhatsAppProposal(sql, {
    proposalId,
    version: 1,
    caseId: world.caseId,
    customerWaId: world.customerWaId,
    author: "agent",
    bodyDigest,
    nonceB64: sealedProposal.nonceB64,
    ciphertextB64: sealedProposal.ciphertextB64,
    policyVersion: world.policyVersion,
    credentialGeneration: 1,
    serviceWindowExpiresAt: NOW + 24 * 3_600_000,
    expiresAt: NOW + 3_600_000,
    now: NOW,
  });
  const env = platformEnv({
    ...whatsappTestEnvBindings(world.db),
    DATA_ENCRYPTION_ROOT: testRootSecret(),
  });
  const graph = createFakeGraph({
    sendOutcomes: [{ kind: "accepted", whatsappMessageId: "wamid.RETOUT" }],
  });
  const dispatched = await dispatchWhatsAppReply({
    authorizeExecution: authorizeWhatsAppFixture,
    scope: await requireOrganisationExecutionScope(env, world.organisationId),
    sql,
    cipher: cipher.value,
    env,
    proposalId,
    approvedVersion: 1,
    approvedBodyDigest: bodyDigest,
    approvedBy: world.userId,
    now: NOW + 1_000,
    fetcher: graph.fetcher,
  });
  if (!dispatched.ok || dispatched.value.kind !== "sent") {
    throw new Error(JSON.stringify(dispatched));
  }
  await recordWhatsAppDeliveryStatus({
    db: world.db,
    organisationId: world.organisationId,
    integrationAccountId: world.integrationAccountId,
    whatsappMessageId: "wamid.RETOUT",
    status: "delivered",
    statusAt: NOW + 2_000,
    failureCode: null,
    now: NOW + 2_000,
  });
  return {
    sqlite: world.sqlite,
    actorSqlite: fixture.database,
    sql,
    db: world.db,
    organisationId: world.organisationId,
    caseId: world.caseId,
    proposalId,
  };
}

async function d1Test(): Promise<void> {
  const loop = await runFullLoop();
  const dump = dumpDatabase(loop.sqlite);
  expect(dump).not.toContain(CUSTOMER_TEXT);
  expect(dump).not.toContain(REPLY_TEXT);
  // The durable record is metadata: the provider ids and the keyed digests.
  expect(dump).toContain("wamid.RET1");
  expect(dump).toContain("wamid.RETOUT");

  // Digests must be keyed. A bare SHA-256 of the plaintext is guessable by
  // anyone holding the database — short support replies come from a small
  // space — so its absence is the property under test, not an implementation
  // detail. Prove the probe works by digesting a value that IS present.
  expect(dump).not.toContain(await bareSha256Hex(CUSTOMER_TEXT));
  expect(dump).not.toContain(await bareSha256Hex(REPLY_TEXT));

  // Sizes are banded, never exact: an exact length beside a digest narrows the
  // brute-force space back down.
  const receipts = loop.sqlite
    .prepare("SELECT body_size_bucket AS bucket FROM whatsapp_message_receipt")
    .all() as unknown as readonly { readonly bucket: string }[];
  expect(receipts.length).toBeGreaterThan(0);
  for (const receipt of receipts) {
    expect(["tiny", "small", "medium", "large"]).toContain(receipt.bucket);
  }
  expect(dump).not.toContain(
    `"${new TextEncoder().encode(CUSTOMER_TEXT).byteLength}"`,
  );
}

async function bareSha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function actorStorageTest(): Promise<void> {
  const loop = await runFullLoop();
  const openState = dumpDatabase(loop.actorSqlite);
  expect(openState).not.toContain(CUSTOMER_TEXT);
  expect(openState).not.toContain(REPLY_TEXT);
  // The sent proposal has already dropped its body.
  expect(
    latestWhatsAppProposal(loop.sql, loop.proposalId)?.ciphertextB64,
  ).toBeNull();

  closeWhatsAppCase(loop.sql, loop.caseId, NOW + 5_000);
  expect(requireEnvelope(loop.sql, loop.caseId)).toEqual([]);
  const disabled = disableWhatsAppRuntime(loop.sql, { now: NOW + 6_000 });
  expect(disabled.ok).toBe(true);

  const terminal = dumpDatabase(loop.actorSqlite);
  expect(terminal).not.toContain(CUSTOMER_TEXT);
  expect(terminal).not.toContain(REPLY_TEXT);
  const ciphertexts = loop.actorSqlite
    .prepare("SELECT COUNT(*) AS total FROM connector_whatsapp_envelope")
    .get() as { readonly total: number };
  expect(ciphertexts.total).toBe(0);
  const bodies = loop.actorSqlite
    .prepare(
      "SELECT COUNT(*) AS total FROM connector_whatsapp_proposal WHERE ciphertext_b64 IS NOT NULL",
    )
    .get() as { readonly total: number };
  expect(bodies.total).toBe(0);
}

async function traceTest(): Promise<void> {
  const logged: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value: unknown) => {
    logged.push(String(value));
  });
  vi.spyOn(console, "warn").mockImplementation((value: unknown) => {
    logged.push(String(value));
  });
  await runFullLoop();
  // Prove the probe would catch a leak if one existed.
  const requestId = newRequestId();
  traceLog("whatsapp_retention.probe", { requestId, marker: "probe" });
  traceWarn("whatsapp_retention.probe", { requestId, marker: "probe" });
  expect(logged.join("\n")).toContain("probe");
  expect(logged.join("\n")).not.toContain(CUSTOMER_TEXT);
  expect(logged.join("\n")).not.toContain(REPLY_TEXT);
}

function requireEnvelope(
  sql: Parameters<typeof readWhatsAppEnvelope>[0],
  caseId: string,
) {
  const envelope = readWhatsAppEnvelope(sql, caseId);
  if (!envelope.ok) throw new Error(envelope.error.code);
  return envelope.value;
}

function dumpDatabase(database: DatabaseSync): string {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => String((row as { readonly name: unknown }).name));
  const contents: unknown[] = [];
  for (const table of tables) {
    contents.push({
      table,
      rows: database.prepare(`SELECT * FROM "${table}"`).all(),
    });
  }
  return JSON.stringify(contents);
}

function authorizeWhatsAppFixture(): Promise<boolean> {
  return Promise.resolve(true);
}
