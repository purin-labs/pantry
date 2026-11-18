/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import {
  acceptConnectorCaseWork,
  claimConnectorCaseWork,
  createConnectorCaseWorkSchema,
  finalizeConnectorCaseWork,
  inspectConnectorCaseWorkEfficiency,
  nextConnectorCaseWorkAlarm,
  renewRunningConnectorCaseWorkLeases,
  type ConnectorCaseWorkRequest,
} from "../src/actors/connector-case-work";
import {
  createSlackCaseCommand,
  parseSlackCaseCommand,
} from "../src/ingress-queue";
import { parsePersonId } from "../src/data/person-authz";
import {
  parseAssignmentId,
  parseCaseId,
  parseConnectorId,
  parseIntegrationAccountId,
  parseRequestId,
  parseOrganisationId,
  parseUserId,
  type UserId,
} from "../src/ids";
import { parseSlackEnvelope } from "../src/slack/events";
import { parseOrganisationPlacement } from "../src/placement";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

describe("Connector-owned interactive Case work", connectorCaseWorkSuite);

function connectorCaseWorkSuite(): void {
  it(
    "deduplicates durable ingress and recovers an expired processing lease",
    recoversExpiredLease,
  );
  it(
    "renews an in-flight lease without invalidating its claim",
    renewsInFlightLease,
  );
  it(
    "keeps an in-flight lease ahead of queued work in alarm scheduling",
    keepsRunningLeaseAsAlarmOwner,
  );
  it(
    "deduplicates Slack retries with fresh request metadata",
    deduplicatesSlackRetry,
  );
  it(
    "deduplicates one threaded Slack message delivered by both subscriptions",
    deduplicatesSlackThreadSubscriptions,
  );
  it(
    "compacts terminal work into an exact durable receipt",
    compactsTerminalWork,
  );
  it(
    "rejects stored Slack authority that disagrees with the event channel",
    rejectsMismatchedAuthority,
  );
}

function rejectsMismatchedAuthority(): void {
  const command = caseWorkRequest().command;
  expect(parseSlackCaseCommand(command)).toEqual({ ok: true, value: command });
  expect(
    parseSlackCaseCommand({
      ...command,
      requestAuthority: {
        ...command.requestAuthority,
        conversationId: "C0OTHER",
      },
    }),
  ).toEqual({
    ok: false,
    error: { code: "invalid_field", field: "requestAuthority" },
  });
}

function deduplicatesSlackRetry(): void {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createConnectorCaseWorkSchema(sql);
  const request = caseWorkRequest();
  const retryRequestId = parseRequestId("request_case_work_retry");
  if (!retryRequestId.ok) throw new Error("retry request ID fixture invalid");
  const retry: ConnectorCaseWorkRequest = {
    identity: request.identity,
    command: {
      ...request.command,
      requestId: retryRequestId.value,
      receivedAt: 2_000,
    },
  };

  expect(acceptConnectorCaseWork(sql, request)).toMatchObject({
    ok: true,
    value: { kind: "accepted" },
  });
  expect(acceptConnectorCaseWork(sql, retry)).toMatchObject({
    ok: true,
    value: { kind: "duplicate", eventId: request.command.event.eventId },
  });
}

function deduplicatesSlackThreadSubscriptions(): void {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createConnectorCaseWorkSchema(sql);
  const message = threadedCaseWorkRequest(
    "message",
    "Ev_case_work_message",
    "request_case_work_message",
    1_000,
  );
  const mention = threadedCaseWorkRequest(
    "app_mention",
    "Ev_case_work_mention",
    "request_case_work_mention",
    1_000,
  );

  expect(acceptConnectorCaseWork(sql, message)).toMatchObject({
    ok: true,
    value: { kind: "accepted", eventId: message.command.event.eventId },
  });
  expect(acceptConnectorCaseWork(sql, mention)).toMatchObject({
    ok: true,
    value: { kind: "duplicate", eventId: mention.command.event.eventId },
  });
  expect(inspectConnectorCaseWorkEfficiency(sql)).toEqual({
    activeRows: 1,
    receiptRows: 0,
  });
}

function recoversExpiredLease(): void {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createConnectorCaseWorkSchema(sql);
  const request = caseWorkRequest();
  expect(acceptConnectorCaseWork(sql, request)).toMatchObject({
    ok: true,
    value: { kind: "accepted" },
  });
  expect(acceptConnectorCaseWork(sql, request)).toMatchObject({
    ok: true,
    value: { kind: "duplicate" },
  });
  const first = claimConnectorCaseWork(sql, 1_000);
  expect(first).toMatchObject({
    ok: true,
    value: { result: { attempt: 1 }, rowsRead: 1 },
  });
  if (!first.ok || first.value.result === null)
    throw new Error("first work claim missing");
  expect(claimConnectorCaseWork(sql, 120_999)).toEqual({
    ok: true,
    value: { result: null, rowsRead: 0 },
  });
  expect(nextConnectorCaseWorkAlarm(sql)).toMatchObject({ result: 121_000 });
  const recovered = claimConnectorCaseWork(sql, 121_000);
  expect(recovered).toMatchObject({
    ok: true,
    value: { result: { attempt: 2 }, rowsRead: 1 },
  });
  if (!recovered.ok || recovered.value.result === null)
    throw new Error("recovered work claim missing");
  expect(
    finalizeConnectorCaseWork(sql, recovered.value.result, {
      kind: "retry",
      reason: "provider_busy",
      retryAt: 125_000,
    }),
  ).toEqual({ ok: true, value: null });
  expect(nextConnectorCaseWorkAlarm(sql)).toMatchObject({ result: 125_000 });
  const final = claimConnectorCaseWork(sql, 125_000);
  if (!final.ok || final.value.result === null)
    throw new Error("final work claim missing");
  expect(final.value.result.attempt).toBe(3);
  expect(
    finalizeConnectorCaseWork(sql, final.value.result, {
      kind: "completed",
      completedAt: 125_500,
    }),
  ).toEqual({ ok: true, value: null });
  expect(nextConnectorCaseWorkAlarm(sql)).toMatchObject({ result: null });
  expect(inspectConnectorCaseWorkEfficiency(sql)).toEqual({
    activeRows: 0,
    receiptRows: 1,
  });
}

function renewsInFlightLease(): void {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createConnectorCaseWorkSchema(sql);
  const request = caseWorkRequest();
  expect(acceptConnectorCaseWork(sql, request)).toMatchObject({ ok: true });
  const claimed = claimConnectorCaseWork(sql, request.command.receivedAt);
  if (!claimed.ok || claimed.value.result === null)
    throw new Error("case work was not claimed");

  const leaseExpiredAt = request.command.receivedAt + 120_000;
  renewRunningConnectorCaseWorkLeases(sql, leaseExpiredAt);
  expect(nextConnectorCaseWorkAlarm(sql).result).toBe(leaseExpiredAt + 120_000);
  expect(
    finalizeConnectorCaseWork(sql, claimed.value.result, {
      kind: "completed",
      completedAt: leaseExpiredAt + 1,
    }),
  ).toEqual({ ok: true, value: null });
  expect(inspectConnectorCaseWorkEfficiency(sql)).toEqual({
    activeRows: 0,
    receiptRows: 1,
  });
}

function keepsRunningLeaseAsAlarmOwner(): void {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createConnectorCaseWorkSchema(sql);
  const first = caseWorkRequest();
  const second = threadedCaseWorkRequest(
    "app_mention",
    "Ev_case_work_queued",
    "request_case_work_queued",
    1_001,
  );
  expect(acceptConnectorCaseWork(sql, first).ok).toBe(true);
  expect(acceptConnectorCaseWork(sql, second).ok).toBe(true);

  const claimed = claimConnectorCaseWork(sql, first.command.receivedAt);
  if (!claimed.ok || claimed.value.result === null)
    throw new Error("case work was not claimed");

  expect(nextConnectorCaseWorkAlarm(sql).result).toBe(
    first.command.receivedAt + 120_000,
  );
  expect(
    finalizeConnectorCaseWork(sql, claimed.value.result, {
      kind: "completed",
      completedAt: first.command.receivedAt + 1,
    }),
  ).toEqual({ ok: true, value: null });
  expect(nextConnectorCaseWorkAlarm(sql).result).toBe(
    second.command.receivedAt,
  );
}

function compactsTerminalWork(): void {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createConnectorCaseWorkSchema(sql);
  const request = caseWorkRequest();
  expect(acceptConnectorCaseWork(sql, request).ok).toBe(true);
  const claim = claimConnectorCaseWork(sql, 1_000);
  if (!claim.ok || claim.value.result === null)
    throw new Error("work claim missing");
  expect(
    finalizeConnectorCaseWork(sql, claim.value.result, {
      kind: "completed",
      completedAt: 2_000,
    }),
  ).toEqual({ ok: true, value: null });
  expect(inspectConnectorCaseWorkEfficiency(sql)).toEqual({
    activeRows: 0,
    receiptRows: 1,
  });
  expect(acceptConnectorCaseWork(sql, request)).toMatchObject({
    ok: true,
    value: { kind: "duplicate" },
  });
  expect(acceptConnectorCaseWork(sql, changedCaseWorkRequest(request))).toEqual(
    {
      ok: false,
      error: { code: "connector_case_work_conflict" },
    },
  );
}

function changedCaseWorkRequest(
  request: ConnectorCaseWorkRequest,
): ConnectorCaseWorkRequest {
  return {
    identity: request.identity,
    command: {
      ...request.command,
      event: {
        ...request.command.event,
        authored: [{ kind: "text", text: "different work" }],
      },
    },
  };
}

function threadedCaseWorkRequest(
  eventType: "app_mention" | "message",
  eventId: string,
  requestIdValue: string,
  receivedAt: number,
): ConnectorCaseWorkRequest {
  const base = caseWorkRequest();
  const requestId = parseRequestId(requestIdValue);
  const envelope = parseSlackEnvelope(
    JSON.stringify({
      type: "event_callback",
      api_app_id: "A_TEST",
      event_id: eventId,
      team_id: "T0CASEWORK",
      event: {
        type: eventType,
        channel: "C0CASEWORK",
        user: "U0CASEWORK",
        ts: "1785700000.000002",
        thread_ts: "1785700000.000001",
        event_ts: "1785700000.000002",
        text: "work",
      },
    }),
  );
  if (!requestId.ok || !envelope.ok || envelope.value.kind !== "message") {
    throw new Error("threaded Case work fixture invalid");
  }
  return {
    identity: base.identity,
    command: createSlackCaseCommand({
      requestId: requestId.value,
      receivedAt,
      organisationId: base.command.organisationId,
      integrationAccountId: base.command.integrationAccountId,
      principalId: base.command.principalId,
      userId: base.command.userId,
      requestAuthority: base.command.requestAuthority,
      event: envelope.value.event,
      target: {
        ...base.command.target,
        sessionId: envelope.value.event.sessionId,
      },
    }),
  };
}

function caseWorkRequest(): ConnectorCaseWorkRequest {
  const organisationId = parseOrganisationId("organisation_case_work");
  const caseId = parseCaseId("case_case_work");
  const connectorId = parseConnectorId("connector_case_work");
  const assignmentId = parseAssignmentId("assignment_case_work");
  const requestId = parseRequestId("request_case_work");
  const integrationAccountId = parseIntegrationAccountId(
    "integration_case_work",
  );
  const principalId = parsePersonId("person_case-work");
  const placement = parseOrganisationPlacement(
    {
      kind: "affinity",
      placementEpoch: 1,
      placementCellId: "test",
      locationHint: "wnam",
    },
    "test.placement",
  );
  const envelope = parseSlackEnvelope(
    JSON.stringify({
      type: "event_callback",
      api_app_id: "A_TEST",
      event_id: "Ev_case_work",
      team_id: "T0CASEWORK",
      event: {
        type: "app_mention",
        channel: "C0CASEWORK",
        user: "U0CASEWORK",
        ts: "1785700000.000001",
        event_ts: "1785700000.000001",
        text: "work",
      },
    }),
  );
  if (
    !organisationId.ok ||
    !caseId.ok ||
    !connectorId.ok ||
    !assignmentId.ok ||
    !requestId.ok ||
    !integrationAccountId.ok ||
    principalId === null ||
    !placement.ok ||
    !envelope.ok ||
    envelope.value.kind !== "message"
  )
    throw new Error("case work fixture invalid");
  return {
    identity: {
      organisationId: organisationId.value,
      connectorId: "connector_case_work",
    },
    command: createSlackCaseCommand({
      requestId: requestId.value,
      receivedAt: 1_000,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      principalId,
      userId: fixtureUserId(),
      requestAuthority: {
        kind: "shared_conversation",
        organisationId: organisationId.value,
        requesterPersonId: principalId,
        membershipRevision: 1,
        role: "operator",
        connectorId: connectorId.value,
        integrationAccountId: integrationAccountId.value,
        conversationId: envelope.value.event.channelId,
      },
      event: envelope.value.event,
      target: {
        caseId: caseId.value,
        connectorId: connectorId.value,
        sessionId: envelope.value.event.sessionId,
        assignmentId: assignmentId.value,
        placement: placement.value,
      },
    }),
  };
}

/** The control identity a verified Slack account resolves to in these tests. */
function fixtureUserId(): UserId {
  const parsed = parseUserId("user_ddf5f192-f221-54a1-a39b-cbffe520d2e5");
  if (!parsed.ok) throw new Error("fixture control identity is invalid");
  return parsed.value;
}
