import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";

import { network } from "./network";
import {
  ROOT_TS,
  ORGANISATION_ID,
  inspectSlackActors,
  installSlackActorFixture,
  openRouterText,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
} from "./slack-journey-support";

/**
 * A provider error answer costs nothing (Refactor 15, refactor 3). The
 * provider answers the first model request with a 503 status, which comes
 * before any body, so it generated no tokens. The turn fails, the thread
 * says so once, and the run budget settles with zero tokens. After the
 * Session is evicted, the next message of the thread gets an answer, and a
 * repeated delivery of the first event changes nothing.
 */
it(
  "counts a provider error answer as zero tokens, so the next message is answered",
  acceptsProviderFailureAndAnsweredRetry,
);

const RETRY_ANSWER = "PROVIDER_RECOVERED_ANSWER";

async function acceptsProviderFailureAndAnsweredRetry(
  context: TestContext,
): Promise<void> {
  const fixture = await installSlackActorFixture();
  const requests: unknown[] = [];
  const slack = slackSimulator();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToProvider.bind(null, requests),
    ),
    slack.handler,
  );
  const envelope = slackEnvelope({
    eventType: "app_mention",
    eventId: "Ev0E2EPROVIDERFAILURE",
    messageTs: ROOT_TS,
    threadTs: ROOT_TS,
    text: "<@U0SATYR> inspect this case",
  });
  const admitted = await exports.default.fetch(
    await signedSlackRequest(envelope),
  );
  expect(admitted.status).toBe(200);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  expect(slack.messages[0]?.text).toContain("couldn’t complete");

  const failed = await inspectSlackActors(fixture.connectorId);
  expect(failed.session).toMatchObject({
    ok: true,
    value: { lifecycleKind: "sleeping", reservation: { kind: "none" } },
  });
  if (!failed.session.ok) throw new Error("Session inspection failed");
  const sessionRow = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS physicalName FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'session' AND logical_object_id = ? AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID, failed.sessionId)
    .first<{ physicalName: string }>();
  if (sessionRow === null) throw new Error("Session registry entry missing");
  const failure = await runInDurableObject(
    env.SESSION.getByName(sessionRow.physicalName),
    readFailedTurn,
  );
  expect(failure).toEqual([
    { errorCode: "embedded_harness_turn_failed_with_usage" },
  ]);
  await evictDurableObject(env.SESSION.getByName(sessionRow.physicalName));

  const duplicate = await exports.default.fetch(
    await signedSlackRequest(envelope),
  );
  expect(duplicate.status).toBe(200);
  const retry = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "message",
        eventId: "Ev0E2EPROVIDERRETRY",
        messageTs: "1787500000.000002",
        threadTs: ROOT_TS,
        text: "try again using current evidence",
      }),
    ),
  );
  expect(retry.status).toBe(200);
  await expect.poll(slack.visibleMessageCount, { timeout: 20_000 }).toBe(2);
  expect(slack.messages[1]?.text).toContain(RETRY_ANSWER);
  expect(requests).toHaveLength(2);
  const connectorRow = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS physicalName FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'connector' AND logical_object_id = ? AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID, fixture.connectorId)
    .first<{ physicalName: string }>();
  if (connectorRow === null)
    throw new Error("Connector registry entry missing");
  // The first event retries read its failed turn again: they ask the
  // provider nothing and post nothing.
  await expect
    .poll(providerWorkReceipts.bind(null, connectorRow.physicalName), {
      timeout: 15_000,
    })
    .toContainEqual({
      eventId: "Ev0E2EPROVIDERRETRY",
      outcome: "completed",
      reason: null,
    });
  expect(requests).toHaveLength(2);
  const answered = await inspectSlackActors(fixture.connectorId);
  expect(answered.session).toMatchObject({
    ok: true,
    value: { lifecycleKind: "sleeping", reservation: { kind: "none" } },
  });
  expect(slack.visibleMessageCount()).toBe(2);
  Object.assign(context.task.meta, {
    acceptance: {
      failure,
      modelRequestCount: requests.length,
      messages: slack.messages,
      session: answered.session,
      workReceipts: await providerWorkReceipts(connectorRow.physicalName),
    },
  });
}

async function respondToProvider(
  requests: unknown[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  requests.push(await request.json());
  if (requests.length === 1) {
    return HttpResponse.json(
      {
        error: {
          message: "Acceptance provider temporarily unavailable",
          code: 503,
        },
      },
      { status: 503 },
    );
  }
  return openRouterText(RETRY_ANSWER, `provider_recovered_${requests.length}`);
}

function readFailedTurn(
  _actor: unknown,
  state: DurableObjectState,
): { errorCode: string }[] {
  return state.storage.sql
    .exec<{ errorCode: string }>(
      "SELECT error_detail AS errorCode FROM session_turn_stream WHERE state = 'failed'",
    )
    .toArray();
}

function providerWorkReceipts(physicalName: string) {
  return runInDurableObject(
    env.CONNECTOR.getByName(physicalName),
    readProviderWorkReceipts,
  );
}

function readProviderWorkReceipts(_actor: unknown, state: DurableObjectState) {
  return state.storage.sql
    .exec<{ eventId: string; outcome: string; reason: string | null }>(
      "SELECT event_id AS eventId, outcome, reason FROM connector_case_work_receipt ORDER BY event_id",
    )
    .toArray();
}
