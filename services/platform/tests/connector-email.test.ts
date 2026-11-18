import { describe, expect, it } from "vitest";

import {
  EMAIL_EVALUATION_INTERVAL_MS,
  acceptEmailHint,
  activateEmailRuntime,
  claimDueEmailEvaluation,
  completeEmailEvaluation,
  countEmailAdmissionsSince,
  countOpenEmailCases,
  createConnectorEmailSchema,
  disableEmailRuntime,
  emailMessageDisposition,
  emailTokenWindowTotals,
  nextEmailEvaluationAt,
  openEmailCaseForThread,
  pauseEmailRuntime,
  readEmailRuntime,
  reconnectEmailRuntime,
  recordEmailAdmissions,
  releaseEmailReservation,
  reserveEmailTokens,
  resumeEmailRuntime,
  settleEmailReservation,
  updateEmailRuntimePolicy,
  utcDayEndsAt,
  utcDayKey,
  type EmailIngressLimits,
} from "../src/actors/connector-email";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

const NOW = 1_784_016_325_277;

describe("connector email runtime", connectorEmailSuite);

function connectorEmailSuite(): void {
  it(
    "activates from a committed floor and reconciles immediately",
    activationTest,
  );
  it(
    "coalesces push hints before one evaluation with notification dedupe",
    debounceTest,
  );
  it(
    "keeps the accepted cursor behind unadmitted work and reschedules backlogs",
    cursorTest,
  );
  it(
    "pauses once per transition and resumes through explicit policy actions",
    pauseResumeTest,
  );
  it(
    "stays inert when a stored pause reason does not parse",
    malformedPauseTest,
  );
  it("skips only the exact oversized message named by the pause", skipTest);
  it("reserves daily tokens atomically inside UTC windows", reservationTest);
  it("updates live limits without moving the activation floor", liveUpdateTest);
  it(
    "preserves accepted history and pending hints across ordinary reauthorization",
    reconnectCursorTest,
  );
}

function reconnectCursorTest(): void {
  const sql = setup();
  activate(sql);
  acceptEmailHint(sql, {
    notificationId: "before-outage",
    historyId: "1400",
    now: NOW,
  });
  expect(claimDueEmailEvaluation(sql, NOW).kind).toBe("due");
  completeEmailEvaluation(sql, { acceptedHistoryId: "1400", now: NOW + 1 });
  pauseEmailRuntime(sql, {
    reason: {
      kind: "authorization_expired",
      reasonCode: "expired",
      observedAt: NOW + 2,
    },
    now: NOW + 2,
  });
  acceptEmailHint(sql, {
    notificationId: "during-outage",
    historyId: "1600",
    now: NOW + 3,
  });
  const result = reconnectEmailRuntime(sql, {
    policyVersion: 1,
    limits: limits(),
    watchExpiresAt: NOW + 7 * 86_400_000,
    now: NOW + 4,
  });
  expect(result.ok).toBe(true);
  expect(readEmailRuntime(sql)).toMatchObject({
    activationFloor: "1000",
    acceptedHistoryId: "1400",
    highestObservedHistoryId: "1600",
    processing: { kind: "scheduled", at: NOW + 4 },
  });
  expect(claimDueEmailEvaluation(sql, NOW + 4).kind).toBe("due");
}

function setup(): ReturnType<typeof sqlStorage> {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createConnectorEmailSchema(sql);
  return sql;
}

function limits(
  overrides: Partial<EmailIngressLimits> = {},
): EmailIngressLimits {
  return {
    maxActiveCases: 3,
    maxMessagesPerHour: 20,
    dailyTokenBudget: 100_000,
    maxMessageBytes: 262_144,
    maxAttachmentBytes: 5_242_880,
    debounce: { kind: "push_triggered", coalesceSeconds: 30 },
    ...overrides,
  };
}

function activate(sql: ReturnType<typeof setup>, at: number = NOW): void {
  const activated = activateEmailRuntime(sql, {
    organisationId: "organisation_email_runtime",
    integrationAccountId: "integration_gmail_runtime",
    policyVersion: 1,
    limits: limits(),
    activationFloor: "1000",
    watchExpiresAt: at + 7 * 86_400_000,
    now: at,
  });
  if (!activated.ok) throw new Error(activated.error.code);
}

function activationTest(): void {
  const sql = setup();
  expect(readEmailRuntime(sql)).toBeNull();
  activate(sql);
  const runtime = readEmailRuntime(sql);
  expect(runtime).toMatchObject({
    activationFloor: "1000",
    acceptedHistoryId: "1000",
    policyVersion: 1,
    processing: { kind: "scheduled", at: NOW },
  });
  expect(nextEmailEvaluationAt(sql)).toBe(NOW);
  const idempotent = activateEmailRuntime(sql, {
    organisationId: "organisation_email_runtime",
    integrationAccountId: "integration_gmail_runtime",
    policyVersion: 1,
    limits: limits(),
    activationFloor: "9999",
    watchExpiresAt: NOW,
    now: NOW + 5,
  });
  expect(idempotent.ok && idempotent.value.activationFloor === "1000").toBe(
    true,
  );
}

function debounceTest(): void {
  const sql = setup();
  activate(sql);
  const claimed = claimDueEmailEvaluation(sql, NOW);
  expect(claimed.kind).toBe("due");
  completeEmailEvaluation(sql, { acceptedHistoryId: "1000", now: NOW });
  expect(readEmailRuntime(sql)?.processing).toEqual({ kind: "waiting" });

  const first = acceptEmailHint(sql, {
    notificationId: "n1",
    historyId: "1100",
    now: NOW + 1_000,
  });
  expect(first).toEqual({ kind: "scheduled", at: NOW + 31_000 });
  const duplicate = acceptEmailHint(sql, {
    notificationId: "n1",
    historyId: "1100",
    now: NOW + 2_000,
  });
  expect(duplicate).toEqual({ kind: "duplicate" });
  const later = acceptEmailHint(sql, {
    notificationId: "n2",
    historyId: "1200",
    now: NOW + 20_000,
  });
  expect(later).toEqual({ kind: "scheduled", at: NOW + 31_000 });
  expect(readEmailRuntime(sql)?.highestObservedHistoryId).toBe("1200");

  expect(claimDueEmailEvaluation(sql, NOW + 30_000).kind).toBe("idle");
  const due = claimDueEmailEvaluation(sql, NOW + 31_000);
  expect(due.kind).toBe("due");

  completeEmailEvaluation(sql, {
    acceptedHistoryId: "1200",
    now: NOW + 31_000,
  });
  const idleHint = acceptEmailHint(sql, {
    notificationId: "n3",
    historyId: "1300",
    now: NOW + 3 * EMAIL_EVALUATION_INTERVAL_MS,
  });
  expect(idleHint).toEqual({
    kind: "scheduled",
    at: NOW + 4 * EMAIL_EVALUATION_INTERVAL_MS,
  });
}

function cursorTest(): void {
  const sql = setup();
  activate(sql);
  acceptEmailHint(sql, {
    notificationId: "n1",
    historyId: "1500",
    now: NOW + 1,
  });
  const claim = claimDueEmailEvaluation(sql, NOW + 1);
  expect(claim.kind).toBe("due");
  recordEmailAdmissions(sql, {
    admitted: [
      { providerMessageId: "m1", threadId: "t1", caseId: "case_gmail_a_t1" },
      { providerMessageId: "m2", threadId: "t1", caseId: "case_gmail_a_t1" },
    ],
    policyVersion: 1,
    now: NOW + 1,
  });
  completeEmailEvaluation(sql, { acceptedHistoryId: "1400", now: NOW + 1 });
  const runtime = readEmailRuntime(sql);
  expect(runtime?.acceptedHistoryId).toBe("1400");
  expect(runtime?.processing).toEqual({
    kind: "scheduled",
    at: NOW + 1 + EMAIL_EVALUATION_INTERVAL_MS,
  });
  expect(emailMessageDisposition(sql, "m1")).toBe("admitted");
  expect(countEmailAdmissionsSince(sql, NOW - 1)).toBe(2);
  expect(countOpenEmailCases(sql)).toBe(1);
  expect(openEmailCaseForThread(sql, "t1")).toBe("case_gmail_a_t1");
}

function malformedPauseTest(): void {
  const sql = setup();
  activate(sql);
  sql.exec(
    "UPDATE connector_email_runtime SET processing_json = ? WHERE singleton = 1",
    JSON.stringify({
      kind: "paused",
      reason: {
        kind: "message_too_large",
        observedBytes: 300_000,
        limitBytes: 262_144,
      },
      pausedAt: NOW + 10,
      policyVersion: 1,
    }),
  );
  expect(readEmailRuntime(sql)).toBeNull();
  expect(
    acceptEmailHint(sql, {
      notificationId: "n1",
      historyId: "2000",
      now: NOW + 20,
    }),
  ).toEqual({ kind: "inactive" });
  expect(claimDueEmailEvaluation(sql, NOW + 20).kind).toBe("idle");
}

function pauseResumeTest(): void {
  const sql = setup();
  activate(sql);
  claimDueEmailEvaluation(sql, NOW);
  const paused = pauseEmailRuntime(sql, {
    reason: { kind: "active_case_limit", observed: 3, limit: 3 },
    now: NOW + 10,
  });
  expect(paused.ok && paused.value.firstPause).toBe(true);
  const again = pauseEmailRuntime(sql, {
    reason: { kind: "active_case_limit", observed: 3, limit: 3 },
    now: NOW + 20,
  });
  expect(again.ok && !again.value.firstPause).toBe(true);
  expect(readEmailRuntime(sql)?.processing.kind).toBe("paused");

  const observed = acceptEmailHint(sql, {
    notificationId: "n1",
    historyId: "2000",
    now: NOW + 30,
  });
  expect(observed).toEqual({ kind: "observed" });
  expect(readEmailRuntime(sql)?.highestObservedHistoryId).toBe("2000");
  expect(nextEmailEvaluationAt(sql)).toBeNull();

  const resumed = resumeEmailRuntime(sql, {
    policyVersion: 2,
    limits: limits({ maxActiveCases: 5 }),
    skipProviderMessageId: null,
    now: NOW + 40,
  });
  expect(resumed.ok).toBe(true);
  if (resumed.ok) {
    expect(resumed.value.policyVersion).toBe(2);
    expect(resumed.value.processing).toEqual({
      kind: "scheduled",
      at: NOW + 40,
    });
    expect(resumed.value.acceptedHistoryId).toBe("1000");
  }
  const notPaused = resumeEmailRuntime(sql, {
    policyVersion: 2,
    limits: limits(),
    skipProviderMessageId: null,
    now: NOW + 50,
  });
  expect(
    !notPaused.ok && notPaused.error.code === "connector_email_not_paused",
  ).toBe(true);
}

function skipTest(): void {
  const sql = setup();
  activate(sql);
  claimDueEmailEvaluation(sql, NOW);
  pauseEmailRuntime(sql, {
    reason: {
      kind: "message_too_large",
      providerMessageId: "m-oversized",
      observedBytes: 400_000,
      limitBytes: 262_144,
    },
    now: NOW + 10,
  });
  const wrongTarget = resumeEmailRuntime(sql, {
    policyVersion: 1,
    limits: limits(),
    skipProviderMessageId: "m-other",
    now: NOW + 20,
  });
  expect(
    !wrongTarget.ok &&
      wrongTarget.error.code === "connector_email_skip_target_invalid",
  ).toBe(true);
  const skipped = resumeEmailRuntime(sql, {
    policyVersion: 1,
    limits: limits(),
    skipProviderMessageId: "m-oversized",
    now: NOW + 30,
  });
  expect(skipped.ok).toBe(true);
  expect(emailMessageDisposition(sql, "m-oversized")).toBe("skipped");
  expect(countEmailAdmissionsSince(sql, 0)).toBe(0);
}

function reservationTest(): void {
  const sql = setup();
  const day = utcDayKey(NOW);
  const first = reserveEmailTokens(sql, {
    reservationId: "r1",
    utcDay: day,
    tokens: 60_000,
    limit: 100_000,
    now: NOW,
  });
  expect(first.kind).toBe("reserved");
  const duplicate = reserveEmailTokens(sql, {
    reservationId: "r1",
    utcDay: day,
    tokens: 60_000,
    limit: 100_000,
    now: NOW,
  });
  expect(duplicate.kind).toBe("duplicate");
  const oversubscribed = reserveEmailTokens(sql, {
    reservationId: "r2",
    utcDay: day,
    tokens: 60_000,
    limit: 100_000,
    now: NOW,
  });
  expect(oversubscribed).toMatchObject({
    kind: "exhausted",
    reserved: 60_000,
    consumed: 0,
  });

  expect(
    settleEmailReservation(sql, { reservationId: "r1", actualTokens: 30_000 }),
  ).toBe(true);
  expect(
    settleEmailReservation(sql, { reservationId: "r1", actualTokens: 30_000 }),
  ).toBe(false);
  expect(emailTokenWindowTotals(sql, day)).toEqual({
    reserved: 0,
    consumed: 30_000,
  });

  const afterSettle = reserveEmailTokens(sql, {
    reservationId: "r3",
    utcDay: day,
    tokens: 60_000,
    limit: 100_000,
    now: NOW + 1,
  });
  expect(afterSettle.kind).toBe("reserved");
  expect(releaseEmailReservation(sql, "r3")).toBe(true);
  expect(emailTokenWindowTotals(sql, day)).toEqual({
    reserved: 0,
    consumed: 30_000,
  });

  const nextDay = utcDayKey(utcDayEndsAt(NOW) + 1);
  expect(nextDay).not.toBe(day);
  const rollover = reserveEmailTokens(sql, {
    reservationId: "r4",
    utcDay: nextDay,
    tokens: 100_000,
    limit: 100_000,
    now: utcDayEndsAt(NOW) + 1,
  });
  expect(rollover.kind).toBe("reserved");
}

function liveUpdateTest(): void {
  const sql = setup();
  activate(sql);
  claimDueEmailEvaluation(sql, NOW);
  completeEmailEvaluation(sql, { acceptedHistoryId: "1234", now: NOW });
  const updated = updateEmailRuntimePolicy(sql, {
    policyVersion: 2,
    limits: limits({ maxMessagesPerHour: 50 }),
  });
  expect(updated.ok).toBe(true);
  if (updated.ok) {
    expect(updated.value.policyVersion).toBe(2);
    expect(updated.value.limits.maxMessagesPerHour).toBe(50);
    expect(updated.value.activationFloor).toBe("1000");
    expect(updated.value.acceptedHistoryId).toBe("1234");
  }
  disableEmailRuntime(sql, { now: NOW + 10 });
  expect(readEmailRuntime(sql)?.disabledAt).toBe(NOW + 10);
  expect(nextEmailEvaluationAt(sql)).toBeNull();
  expect(
    acceptEmailHint(sql, {
      notificationId: "nx",
      historyId: "2000",
      now: NOW + 20,
    }),
  ).toEqual({ kind: "inactive" });
  const reactivated = activateEmailRuntime(sql, {
    organisationId: "organisation_email_runtime",
    integrationAccountId: "integration_gmail_runtime",
    policyVersion: 3,
    limits: limits(),
    activationFloor: "5000",
    watchExpiresAt: NOW + 86_400_000,
    now: NOW + 30,
  });
  expect(reactivated.ok).toBe(true);
  if (reactivated.ok) {
    expect(reactivated.value.activationFloor).toBe("5000");
    expect(reactivated.value.acceptedHistoryId).toBe("5000");
    expect(reactivated.value.disabledAt).toBeNull();
  }
}
