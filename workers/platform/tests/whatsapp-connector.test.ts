import { describe, expect, it } from "vitest";

import {
  beginWhatsAppAdmission,
  claimDueWhatsAppCase,
  clearWhatsAppHandoff,
  closeWhatsAppCase,
  commitWhatsAppAdmission,
  completeWhatsAppProcessing,
  countOpenWhatsAppCases,
  createConnectorWhatsAppSchema,
  rearmWhatsAppDebounce,
  settleWhatsAppTurn,
  WHATSAPP_MAX_TURN_ATTEMPTS,
  disableWhatsAppRuntime,
  activateWhatsAppRuntime,
  expireWhatsAppProposals,
  latestWhatsAppProposal,
  nextWhatsAppDebounceAt,
  nextWhatsAppSweepAt,
  pauseWhatsAppRuntime,
  readWhatsAppCase,
  readWhatsAppEnvelope,
  readWhatsAppRuntime,
  recordWhatsAppProposal,
  recordWhatsAppStatus,
  recordWhatsAppUnsupportedMessage,
  requestWhatsAppHandoff,
  reserveWhatsAppTokens,
  resumeWhatsAppRuntime,
  settleWhatsAppReservation,
  sweepWhatsAppDeadlines,
  utcDayKey,
  whatsAppTokenWindowTotals,
  type WhatsAppIngressLimits,
} from "@purin-labs/area-inbox/server/actors/connector-whatsapp";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

/** A controllable clock: every assertion advances time explicitly. */
const NOW = 1_784_016_325_277;
const CUSTOMER = "15550002222";
const SIXTY_FOUR_HEX = "a".repeat(64);

describe("connector whatsapp runtime", connectorWhatsAppSuite);

function connectorWhatsAppSuite(): void {
  it(
    "activates with a committed floor and updates live limits",
    activationTest,
  );
  it("debounces a customer burst into one due Case", debounceTest);
  it("deduplicates the provider message id before any Case work", dedupeTest);
  it("enforces every published limit before admitting work", limitTest);
  it(
    "bounds the active envelope by count, bytes, and the 24-hour window",
    envelopeBoundTest,
  );
  it(
    "rejects a corrupt persisted envelope direction",
    corruptEnvelopeDirectionTest,
  );
  it("rejects a corrupt persisted envelope field", corruptEnvelopeFieldTest);
  it(
    "blocks agent work while a handoff is pending and resumes after it clears",
    handoffTest,
  );
  it("reserves and settles the daily agent token window", reservationTest);
  it(
    "deletes the proposal body when the proposal expires",
    proposalCleanupTest,
  );
  it("deduplicates status events per message and status", statusTest);
  it(
    "deletes all active content when processing is disabled",
    disableCleanupTest,
  );
  it(
    "pauses on an unsupported message type without storing its content",
    unsupportedTest,
  );
  it(
    "wakes for expiry deadlines, not only for the next debounce",
    sweepScheduleTest,
  );
  it("closes and empties a Case whose service window has passed", sweepTest);
  it("recovers a turn claim whose turn never reported back", staleTurnTest);
  it("re-arms a turn that produced no outcome, up to a bound", rearmTest);
  it(
    "refuses to commit into a Case closed while the body was sealing",
    closedDuringSealTest,
  );
}

/**
 * An account that goes quiet still owes work: the 24-hour content bound is
 * enforced by waking for it, not by waiting for the next customer message.
 */
function sweepScheduleTest(): void {
  const sql = setup();
  activate(sql);
  expect(nextWhatsAppSweepAt(sql)).toBeNull();
  admit(sql, { providerMessageId: "wamid.S1", at: NOW });
  // The Case's own service window is a wake-up even after its debounce fires.
  const claimed = claimDueWhatsAppCase(sql, NOW + 20_000);
  expect(claimed.kind).toBe("due");
  completeWhatsAppProcessing(sql);
  expect(nextWhatsAppDebounceAt(sql)).toBeNull();
  expect(nextWhatsAppSweepAt(sql)).toBe(NOW + 24 * 3_600_000);
}

function sweepTest(): void {
  const sql = setup();
  activate(sql);
  admit(sql, { providerMessageId: "wamid.S1", at: NOW });
  const caseId = `case_whatsapp_${CUSTOMER}_1`;
  recordWhatsAppProposal(sql, {
    proposalId: "proposal_sweep",
    version: 1,
    caseId,
    customerWaId: CUSTOMER,
    author: "agent",
    bodyDigest: SIXTY_FOUR_HEX,
    nonceB64: "bm9uY2U=",
    ciphertextB64: btoa("draft reply"),
    policyVersion: 1,
    credentialGeneration: 1,
    serviceWindowExpiresAt: NOW + 24 * 3_600_000,
    expiresAt: NOW + 24 * 3_600_000,
    now: NOW,
  });
  expect(readEnvelope(sql, caseId)).toHaveLength(1);

  const swept = sweepWhatsAppDeadlines(sql, NOW + 24 * 3_600_000 + 1);
  expect(swept.closedCaseIds).toEqual([caseId]);
  expect(readEnvelope(sql, caseId)).toEqual([]);
  expect(readWhatsAppCase(sql, caseId)?.closedAt).not.toBeNull();
  expect(latestWhatsAppProposal(sql, "proposal_sweep")).toMatchObject({
    state: "expired",
    ciphertextB64: null,
    nonceB64: null,
  });
}

function staleTurnTest(): void {
  const sql = setup();
  activate(sql);
  admit(sql, { providerMessageId: "wamid.S1", at: NOW });
  const claimed = claimDueWhatsAppCase(sql, NOW + 20_000);
  expect(claimed.kind).toBe("due");
  expect(readWhatsAppRuntime(sql)?.processing.kind).toBe("processing");

  // Well inside the lease the claim stands: a slow turn is not a dead one.
  expect(sweepWhatsAppDeadlines(sql, NOW + 21_000).recoveredProcessing).toBe(
    false,
  );
  expect(claimDueWhatsAppCase(sql, NOW + 21_000).kind).toBe("idle");

  const recovered = sweepWhatsAppDeadlines(sql, NOW + 20_000 + 11 * 60_000);
  expect(recovered.recoveredProcessing).toBe(true);
  expect(readWhatsAppRuntime(sql)?.processing.kind).toBe("scheduled");
  expect(claimDueWhatsAppCase(sql, NOW + 20_000 + 11 * 60_000).kind).toBe(
    "due",
  );
}

function setup(): ReturnType<typeof sqlStorage> {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createConnectorWhatsAppSchema(sql);
  return sql;
}

function readEnvelope(
  sql: Parameters<typeof readWhatsAppEnvelope>[0],
  caseId: string,
) {
  const envelope = readWhatsAppEnvelope(sql, caseId);
  if (!envelope.ok) throw new Error(envelope.error.code);
  return envelope.value;
}

function corruptEnvelopeDirectionTest(): void {
  const sql = setup();
  sql.exec("PRAGMA ignore_check_constraints = ON");
  try {
    sql.exec(
      `INSERT INTO connector_whatsapp_envelope (
         case_id, sequence, direction, provider_message_id, nonce_b64, ciphertext_b64,
         bytes, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "case_corrupt",
      1,
      "inbound",
      "wamid.OK",
      "bm9uY2U=",
      "Y2lwaGVydGV4dA==",
      1,
      NOW,
    );
    sql.exec(
      `INSERT INTO connector_whatsapp_envelope (
         case_id, sequence, direction, provider_message_id, nonce_b64, ciphertext_b64,
         bytes, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "case_corrupt",
      2,
      "unknown",
      "wamid.CORRUPT",
      "bm9uY2U=",
      "Y2lwaGVydGV4dA==",
      1,
      NOW + 1,
    );

    expect(readWhatsAppEnvelope(sql, "case_corrupt")).toEqual({
      ok: false,
      error: { code: "connector_whatsapp_storage_corrupt" },
    });
  } finally {
    sql.exec("PRAGMA ignore_check_constraints = OFF");
  }
}

function corruptEnvelopeFieldTest(): void {
  const sql = setup();
  sql.exec("PRAGMA ignore_check_constraints = ON");
  try {
    sql.exec(
      `INSERT INTO connector_whatsapp_envelope (
         case_id, sequence, direction, provider_message_id, nonce_b64, ciphertext_b64,
         bytes, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "case_corrupt_field",
      1,
      "inbound",
      "wamid.CORRUPT_FIELD",
      "bm9uY2U=",
      "Y2lwaGVydGV4dA==",
      -1,
      NOW,
    );

    expect(readWhatsAppEnvelope(sql, "case_corrupt_field")).toEqual({
      ok: false,
      error: { code: "connector_whatsapp_storage_corrupt" },
    });
  } finally {
    sql.exec("PRAGMA ignore_check_constraints = OFF");
  }
}

function limits(
  overrides: Partial<WhatsAppIngressLimits> = {},
): WhatsAppIngressLimits {
  return {
    maxActiveCases: 3,
    maxMessagesPerHour: 20,
    dailyAgentTokenBudget: 100_000,
    maxMessageBytes: 4_096,
    maxActiveCaseMessages: 4,
    maxActiveCaseBytes: 2_048,
    debounceSeconds: 15,
    ...overrides,
  };
}

function activate(
  sql: ReturnType<typeof setup>,
  at: number = NOW,
  overrides: Partial<WhatsAppIngressLimits> = {},
): void {
  const activated = activateWhatsAppRuntime(sql, {
    organisationId: "organisation_whatsapp",
    integrationAccountId: "integration_account_whatsapp",
    policyVersion: 1,
    limits: limits(overrides),
    supportBindingId: "whatsapp_binding_1",
    bindingRevision: 1,
    credentialGeneration: 1,
    now: at,
  });
  if (!activated.ok) throw new Error(activated.error.code);
}

function admit(
  sql: ReturnType<typeof setup>,
  input: Readonly<{
    providerMessageId: string;
    body?: string;
    at?: number;
    customerWaId?: string;
    limits?: WhatsAppIngressLimits;
  }>,
): ReturnType<typeof beginWhatsAppAdmission> {
  const at = input.at ?? NOW;
  const applied = input.limits ?? limits();
  const body = input.body ?? "hello";
  const reserved = beginWhatsAppAdmission(sql, {
    providerMessageId: input.providerMessageId,
    customerWaId: input.customerWaId ?? CUSTOMER,
    providerTimestamp: at,
    declaredBytes: new TextEncoder().encode(body).byteLength,
    limits: applied,
    caseIdFor: (sequence) =>
      `case_whatsapp_${input.customerWaId ?? CUSTOMER}_${sequence}`,
    now: at,
  });
  if (reserved.kind === "ready") {
    commitWhatsAppAdmission(sql, {
      caseId: reserved.caseId,
      providerMessageId: input.providerMessageId,
      customerWaId: input.customerWaId ?? CUSTOMER,
      providerTimestamp: at,
      nonceB64: "bm9uY2U=",
      ciphertextB64: btoa(body),
      bytes: new TextEncoder().encode(body).byteLength,
      limits: applied,
      policyVersion: 1,
      now: at,
    });
  }
  return reserved;
}

function activationTest(): void {
  const sql = setup();
  expect(readWhatsAppRuntime(sql)).toBeNull();
  activate(sql);
  const runtime = readWhatsAppRuntime(sql);
  expect(runtime).toMatchObject({
    policyVersion: 1,
    activationFloor: NOW,
    processing: { kind: "waiting" },
    disabledAt: null,
  });
  activate(sql, NOW + 60_000, { maxActiveCases: 9 });
  const updated = readWhatsAppRuntime(sql);
  expect(updated?.limits.maxActiveCases).toBe(9);
  expect(updated?.activationFloor).toBe(NOW);
}

function debounceTest(): void {
  const sql = setup();
  activate(sql);
  admit(sql, { providerMessageId: "wamid.A", at: NOW });
  expect(nextWhatsAppDebounceAt(sql)).toBe(NOW + 15_000);
  admit(sql, { providerMessageId: "wamid.B", at: NOW + 5_000 });
  expect(nextWhatsAppDebounceAt(sql)).toBe(NOW + 20_000);

  expect(claimDueWhatsAppCase(sql, NOW + 19_999).kind).toBe("idle");
  const due = claimDueWhatsAppCase(sql, NOW + 20_000);
  expect(due.kind).toBe("due");
  if (due.kind !== "due") return;
  expect(readEnvelope(sql, due.caseId)).toHaveLength(2);
  expect(claimDueWhatsAppCase(sql, NOW + 30_000).kind).toBe("idle");
  completeWhatsAppProcessing(sql);
  expect(readWhatsAppRuntime(sql)?.processing).toEqual({ kind: "waiting" });
}

function dedupeTest(): void {
  const sql = setup();
  activate(sql);
  const first = admit(sql, { providerMessageId: "wamid.A" });
  expect(first.kind).toBe("ready");
  const replay = admit(sql, { providerMessageId: "wamid.A" });
  expect(replay.kind).toBe("duplicate");
  if (first.kind !== "ready") return;
  expect(readEnvelope(sql, first.caseId)).toHaveLength(1);

  const lateCommit = commitWhatsAppAdmission(sql, {
    caseId: first.caseId,
    providerMessageId: "wamid.A",
    customerWaId: CUSTOMER,
    providerTimestamp: NOW,
    nonceB64: "bm9uY2U=",
    ciphertextB64: btoa("hello"),
    bytes: 5,
    limits: limits(),
    policyVersion: 1,
    now: NOW,
  });
  expect(lateCommit.kind).toBe("duplicate");
  expect(readEnvelope(sql, first.caseId)).toHaveLength(1);
}

function limitTest(): void {
  const sql = setup();
  activate(sql);
  const tooLarge = admit(sql, {
    providerMessageId: "wamid.BIG",
    body: "x".repeat(20),
    limits: limits({ maxMessageBytes: 5 }),
  });
  expect(tooLarge.kind === "rejected" && tooLarge.reason.kind).toBe(
    "message_too_large",
  );

  const hourly = admit(sql, {
    providerMessageId: "wamid.H",
    limits: limits({ maxMessagesPerHour: 1 }),
  });
  expect(hourly.kind).toBe("ready");
  const overHourly = admit(sql, {
    providerMessageId: "wamid.H2",
    limits: limits({ maxMessagesPerHour: 1 }),
  });
  expect(overHourly.kind === "rejected" && overHourly.reason.kind).toBe(
    "hourly_message_limit",
  );

  const another = admit(sql, {
    providerMessageId: "wamid.C1",
    customerWaId: "15550003333",
    limits: limits({ maxActiveCases: 1 }),
  });
  expect(another.kind === "rejected" && another.reason.kind).toBe(
    "active_case_limit",
  );
}

function envelopeBoundTest(): void {
  const sql = setup();
  activate(sql);
  const applied = limits({ maxActiveCaseMessages: 3, maxActiveCaseBytes: 40 });
  for (let index = 0; index < 5; index += 1) {
    admit(sql, {
      providerMessageId: `wamid.E${index}`,
      body: `message-${index}`,
      at: NOW + index * 1_000,
      limits: applied,
    });
  }
  const supportCase = readWhatsAppCase(sql, `case_whatsapp_${CUSTOMER}_1`);
  expect(supportCase?.messageCount).toBeLessThanOrEqual(3);
  const envelope = readEnvelope(sql, `case_whatsapp_${CUSTOMER}_1`);
  expect(envelope.length).toBeLessThanOrEqual(3);
  expect(envelope.map((entry) => entry.providerMessageId)).toContain(
    "wamid.E4",
  );

  // Two messages 23 hours apart stay in one conversationWindow; a third 23 hours later
  // keeps the conversationWindow open but ages the first entry out of the 24-hour bound.
  admit(sql, {
    providerMessageId: "wamid.MID",
    body: "mid",
    at: NOW + 23 * 3_600_000,
    limits: applied,
  });
  admit(sql, {
    providerMessageId: "wamid.LATE",
    body: "late",
    at: NOW + 46 * 3_600_000,
    limits: applied,
  });
  const aged = readEnvelope(sql, `case_whatsapp_${CUSTOMER}_1`);
  expect(aged.map((entry) => entry.providerMessageId)).toEqual([
    "wamid.MID",
    "wamid.LATE",
  ]);

  // A message after the window closes opens the next conversationWindow with a new Case.
  admit(sql, {
    providerMessageId: "wamid.NEXT",
    body: "next",
    at: NOW + 200 * 3_600_000,
    limits: applied,
  });
  expect(readEnvelope(sql, `case_whatsapp_${CUSTOMER}_2`)).toHaveLength(1);
}

function handoffTest(): void {
  const sql = setup();
  activate(sql);
  admit(sql, { providerMessageId: "wamid.A" });
  const caseId = `case_whatsapp_${CUSTOMER}_1`;
  expect(
    requestWhatsAppHandoff(sql, caseId, "needs a human", NOW + 1).kind,
  ).toBe("requested");
  expect(claimDueWhatsAppCase(sql, NOW + 60_000).kind).toBe("idle");
  expect(readWhatsAppCase(sql, caseId)?.handoffReason).toBe("needs a human");

  clearWhatsAppHandoff(sql, caseId);
  admit(sql, { providerMessageId: "wamid.B", at: NOW + 2_000 });
  expect(claimDueWhatsAppCase(sql, NOW + 60_000).kind).toBe("due");
}

function reservationTest(): void {
  const sql = setup();
  activate(sql);
  const day = utcDayKey(NOW);
  expect(
    reserveWhatsAppTokens(sql, {
      reservationId: "turn_1",
      utcDay: day,
      tokens: 60_000,
      limit: 100_000,
      now: NOW,
    }).kind,
  ).toBe("reserved");
  expect(
    reserveWhatsAppTokens(sql, {
      reservationId: "turn_2",
      utcDay: day,
      tokens: 60_000,
      limit: 100_000,
      now: NOW,
    }).kind,
  ).toBe("exhausted");
  settleWhatsAppReservation(sql, {
    reservationId: "turn_1",
    actualTokens: 1_000,
  });
  expect(whatsAppTokenWindowTotals(sql, day)).toEqual({
    reserved: 0,
    consumed: 1_000,
  });
  expect(
    reserveWhatsAppTokens(sql, {
      reservationId: "turn_1",
      utcDay: day,
      tokens: 10,
      limit: 100_000,
      now: NOW,
    }).kind,
  ).toBe("duplicate");
}

function proposalCleanupTest(): void {
  const sql = setup();
  activate(sql);
  admit(sql, { providerMessageId: "wamid.A" });
  const caseId = `case_whatsapp_${CUSTOMER}_1`;
  recordWhatsAppProposal(sql, {
    proposalId: "proposal_expiring",
    version: 1,
    caseId,
    customerWaId: CUSTOMER,
    author: "agent",
    bodyDigest: SIXTY_FOUR_HEX,
    nonceB64: "bm9uY2U=",
    ciphertextB64: btoa("draft reply"),
    policyVersion: 1,
    credentialGeneration: 1,
    serviceWindowExpiresAt: NOW + 24 * 3_600_000,
    expiresAt: NOW + 1_000,
    now: NOW,
  });
  const expired = expireWhatsAppProposals(sql, NOW + 2_000);
  expect(expired.map((entry) => entry.proposalId)).toContain(
    "proposal_expiring",
  );
  // Expiry raises an operator notice without pausing the account.
  expect(expired.every((entry) => entry.noticeKey !== null)).toBe(true);
  expect(readWhatsAppRuntime(sql)?.processing.kind).not.toBe("paused");
  expect(
    latestWhatsAppProposal(sql, "proposal_expiring")?.ciphertextB64,
  ).toBeNull();
}

function statusTest(): void {
  const sql = setup();
  activate(sql);
  expect(
    recordWhatsAppStatus(sql, {
      whatsappMessageId: "wamid.OUT",
      status: "sent",
      statusAt: NOW,
      failureCode: null,
      now: NOW,
    }).kind,
  ).toBe("recorded");
  expect(
    recordWhatsAppStatus(sql, {
      whatsappMessageId: "wamid.OUT",
      status: "sent",
      statusAt: NOW + 5,
      failureCode: null,
      now: NOW + 5,
    }).kind,
  ).toBe("duplicate");
  expect(
    recordWhatsAppStatus(sql, {
      whatsappMessageId: "wamid.OUT",
      status: "delivered",
      statusAt: NOW + 10,
      failureCode: null,
      now: NOW + 10,
    }).kind,
  ).toBe("recorded");
}

function disableCleanupTest(): void {
  const sql = setup();
  activate(sql);
  admit(sql, { providerMessageId: "wamid.A" });
  const caseId = `case_whatsapp_${CUSTOMER}_1`;
  recordWhatsAppProposal(sql, {
    proposalId: "proposal_open",
    version: 1,
    caseId,
    customerWaId: CUSTOMER,
    author: "agent",
    bodyDigest: SIXTY_FOUR_HEX,
    nonceB64: "bm9uY2U=",
    ciphertextB64: btoa("draft reply"),
    policyVersion: 1,
    credentialGeneration: 1,
    serviceWindowExpiresAt: NOW + 24 * 3_600_000,
    expiresAt: NOW + 3_600_000,
    now: NOW,
  });
  const disabled = disableWhatsAppRuntime(sql, { now: NOW + 1_000 });
  expect(disabled.ok).toBe(true);
  expect(readEnvelope(sql, caseId)).toEqual([]);
  expect(latestWhatsAppProposal(sql, "proposal_open")).toMatchObject({
    state: "revoked",
    ciphertextB64: null,
    nonceB64: null,
  });
  expect(countOpenWhatsAppCases(sql, NOW + 1_000)).toBe(0);
  expect(readWhatsAppRuntime(sql)?.disabledAt).toBe(NOW + 1_000);
}

function unsupportedTest(): void {
  const sql = setup();
  activate(sql);
  expect(
    recordWhatsAppUnsupportedMessage(sql, {
      providerMessageId: "wamid.IMG",
      customerWaId: CUSTOMER,
      policyVersion: 1,
      now: NOW,
    }).kind,
  ).toBe("recorded");
  expect(
    recordWhatsAppUnsupportedMessage(sql, {
      providerMessageId: "wamid.IMG",
      customerWaId: CUSTOMER,
      policyVersion: 1,
      now: NOW,
    }).kind,
  ).toBe("duplicate");
  pauseWhatsAppRuntime(sql, {
    reason: {
      kind: "unsupported_message_type",
      providerMessageId: "wamid.IMG",
      messageType: "image",
    },
    now: NOW,
  });
  const paused = readWhatsAppRuntime(sql);
  expect(paused?.processing.kind).toBe("paused");
  expect(claimDueWhatsAppCase(sql, NOW + 60_000).kind).toBe("idle");

  const resumed = resumeWhatsAppRuntime(sql, {
    policyVersion: 1,
    limits: limits(),
    supportBindingId: "whatsapp_binding_1",
    bindingRevision: 1,
    credentialGeneration: 1,
    skipProviderMessageId: null,
    now: NOW + 60_000,
  });
  expect(resumed.ok && resumed.value.processing.kind).toBe("waiting");

  const caseId = `case_whatsapp_${CUSTOMER}_1`;
  closeWhatsAppCase(sql, caseId, NOW + 61_000);
  expect(readEnvelope(sql, caseId)).toEqual([]);
}

/**
 * A turn that produces no outcome — a transient provider failure, a throw
 * mid-turn — must put the Case back on the clock. Without this the admitted
 * message waits for the customer to send another one. The retries are bounded
 * so a permanently failing Case escalates instead of spinning.
 */
function rearmTest(): void {
  const sql = setup();
  activate(sql);
  const admitted = admit(sql, { providerMessageId: "wamid.REARM" });
  if (admitted.kind !== "ready") throw new Error(admitted.kind);
  const caseId = admitted.caseId;

  const claimed = claimDueWhatsAppCase(sql, NOW + 60_000);
  expect(claimed.kind).toBe("due");
  // Claiming clears the debounce: nothing would run this Case again.
  expect(nextWhatsAppDebounceAt(sql)).toBeNull();

  const first = rearmWhatsAppDebounce(sql, { caseId, retryAt: NOW + 120_000 });
  expect(first).toEqual({ kind: "rearmed", attempts: 1, dueAt: NOW + 120_000 });
  expect(nextWhatsAppDebounceAt(sql)).toBe(NOW + 120_000);

  const second = rearmWhatsAppDebounce(sql, { caseId, retryAt: NOW + 180_000 });
  expect(second.kind).toBe("rearmed");

  // Third strike: no further debounce, so the Case stops consuming turns.
  const third = rearmWhatsAppDebounce(sql, { caseId, retryAt: NOW + 240_000 });
  expect(third).toEqual({
    kind: "exhausted",
    attempts: WHATSAPP_MAX_TURN_ATTEMPTS,
  });
  expect(nextWhatsAppDebounceAt(sql)).toBeNull();

  // A fresh customer message is fresh work, even while the Case remains open.
  admit(sql, { providerMessageId: "wamid.FRESH", at: NOW + 250_000 });
  expect(readWhatsAppCase(sql, caseId)?.turnAttempts).toBe(0);
  expect(nextWhatsAppDebounceAt(sql)).toBe(NOW + 265_000);

  // A turn that does settle resets the budget for the next burst.
  settleWhatsAppTurn(sql, caseId);
  expect(
    rearmWhatsAppDebounce(sql, { caseId, retryAt: NOW + 300_000 }),
  ).toEqual({ kind: "rearmed", attempts: 1, dueAt: NOW + 300_000 });

  // A closed Case is never re-armed.
  closeWhatsAppCase(sql, caseId, NOW + 310_000);
  expect(
    rearmWhatsAppDebounce(sql, { caseId, retryAt: NOW + 360_000 }),
  ).toEqual({ kind: "unavailable" });
}

/**
 * Sealing the body yields. If the Case is closed in that gap, committing would
 * append content to a Case whose close already emptied its envelope — text
 * nothing deletes again. The commit refuses instead, so Meta redelivers into a
 * fresh Case.
 */
function closedDuringSealTest(): void {
  const sql = setup();
  activate(sql);
  const reserved = beginWhatsAppAdmission(sql, {
    providerMessageId: "wamid.RACE",
    customerWaId: CUSTOMER,
    providerTimestamp: NOW,
    declaredBytes: 5,
    limits: limits(),
    caseIdFor: (sequence) => `case_whatsapp_${CUSTOMER}_${sequence}`,
    now: NOW,
  });
  if (reserved.kind !== "ready") throw new Error(reserved.kind);

  // The operator closes the Case while the seal is in flight.
  closeWhatsAppCase(sql, reserved.caseId, NOW + 1);

  const committed = commitWhatsAppAdmission(sql, {
    caseId: reserved.caseId,
    providerMessageId: "wamid.RACE",
    customerWaId: CUSTOMER,
    providerTimestamp: NOW,
    nonceB64: "bm9uY2U=",
    ciphertextB64: btoa("hello"),
    bytes: 5,
    limits: limits(),
    policyVersion: 1,
    now: NOW + 2,
  });
  expect(committed).toEqual({ kind: "case_closed" });
  expect(readEnvelope(sql, reserved.caseId)).toEqual([]);

  // Nothing was recorded, so the redelivery is admitted rather than deduped.
  const redelivered = admit(sql, {
    providerMessageId: "wamid.RACE",
    at: NOW + 3,
  });
  expect(redelivered.kind).toBe("ready");
  if (redelivered.kind === "ready") {
    expect(redelivered.caseId).not.toBe(reserved.caseId);
  }
}
