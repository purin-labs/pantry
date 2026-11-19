import { expect, it, vi, type TestContext } from "vitest";
import { fixtureDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { resolveActiveConnectorActor } from "../../src/actors/actor-router";
import { requireConnectorId } from "../test-ids";
import type { ConnectorDelivery } from "@purin-labs/contracts";
import { isRecord, parseJsonOrNull } from "@purin-labs/std";

import { network } from "./network";
import {
  CHANNEL_ID,
  ROOT_TS,
  ORGANISATION_ID,
  inspectSlackActors,
  installSlackActorFixture,
  modelSimulator,
  receiptIdentity,
  settledReceiptIdentities,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
} from "./slack-journey-support";
it(
  "composes duplicate and follow-up Slack work through one durable Case",
  acceptsSlackActorJourney,
);

async function acceptsSlackActorJourney(context: TestContext): Promise<void> {
  const logs = vi.spyOn(console, "log");
  context.onTestFinished(logs.mockRestore);
  const fixture = await installSlackActorFixture();
  const model = modelSimulator();
  const slack = slackSimulator();
  network.use(model.handler, slack.handler);

  const rootEnvelope = slackEnvelope({
    eventType: "app_mention",
    eventId: "Ev0E2EROOT",
    messageTs: ROOT_TS,
    threadTs: ROOT_TS,
    text: "<@U0PANTRY> acknowledge this case",
  });
  const root = await exports.default.fetch(
    await signedSlackRequest(rootEnvelope),
  );
  expect(root.status).toBe(200);
  await expect(root.json()).resolves.toMatchObject({
    ok: true,
    durableMode: "case_accepted",
  });

  await model.rootStarted.promise;

  const duplicate = await exports.default.fetch(
    await signedSlackRequest(rootEnvelope),
  );
  expect(duplicate.status).toBe(200);
  await expect(duplicate.json()).resolves.toMatchObject({
    ok: true,
    durableMode: "case_accepted",
  });

  // A reply from the requester while the turn runs joins that turn (Plan
  // 71). This journey composes two turns, so the follow-up comes after the
  // root work settles.
  model.releaseRoot.resolve(undefined);
  await expect
    .poll(rootWorkSettled.bind(null, fixture.connectorId), { timeout: 15_000 })
    .toBe(true);
  const followUp = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "message",
        eventId: "Ev0E2EFOLLOWUP",
        messageTs: "1787500000.000002",
        threadTs: ROOT_TS,
        text: "and summarize that in one line",
      }),
    ),
  );
  const duplicateMention = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev0E2EFOLLOWUPMENTION",
        messageTs: "1787500000.000002",
        threadTs: ROOT_TS,
        text: "and summarize that in one line",
      }),
    ),
  );
  expect(followUp.status).toBe(200);
  await expect(followUp.json()).resolves.toMatchObject({
    ok: true,
    durableMode: "case_accepted",
  });
  expect(duplicateMention.status).toBe(200);
  await expect(duplicateMention.json()).resolves.toMatchObject({
    ok: true,
    durableMode: "case_accepted",
  });

  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(2);
  await expect.poll(slack.visibleStatusCount, { timeout: 15_000 }).toBe(4);
  expect(slack.statuses[3]).toEqual({
    channel_id: CHANNEL_ID,
    thread_ts: ROOT_TS,
    status: "is thinking…",
  });

  const replay = await exports.default.fetch(
    await signedSlackRequest(rootEnvelope),
  );
  expect(replay.status).toBe(200);
  await expect(replay.json()).resolves.toMatchObject({
    ok: true,
    durableMode: "case_accepted",
  });

  const actorState = await inspectSlackActors(fixture.connectorId);
  expect(model.requests).toHaveLength(2);
  expect(model.requests[0]).toMatchObject({
    model: "moonshotai/kimi-k3",
    stream: true,
    provider: { sort: "throughput" },
  });
  expect(model.requests[1]).toMatchObject({ provider: { sort: "throughput" } });
  expect(model.sessionIds).toEqual([
    actorState.sessionId,
    actorState.sessionId,
  ]);
  expect(slack.messages).toMatchObject([
    {
      channel: CHANNEL_ID,
      client_msg_id: expect.any(String),
      text: "Case work accepted.",
      thread_ts: ROOT_TS,
    },
    {
      channel: CHANNEL_ID,
      client_msg_id: expect.any(String),
      text: "Follow-up completed.",
      thread_ts: ROOT_TS,
    },
  ]);
  expect(new Set(slack.messages.map(clientMessageId)).size).toBe(2);
  expect(actorState.connector).toMatchObject({
    ok: true,
    value: {
      ingressCount: 2,
      deliveryCount: 2,
      caseWork: { activeRows: 0, receiptRows: 2 },
      receipts: [{}, {}],
    },
  });
  expect(actorState.case).toMatchObject({
    ok: true,
    value: {
      outputs: [
        { kind: "settled", receipt: {} },
        { kind: "settled", receipt: {} },
      ],
    },
  });
  // Admission filed the thread's one Case in the Organisation's default Project.
  await expect(
    fixtureDatabase()
      .prepare(
        `SELECT COUNT(*) AS cases, SUM(cp.project_id = d.project_id) AS inDefaultProject
       FROM case_project cp
       JOIN organisation_default_project d ON d.organisation_id = cp.organisation_id
       WHERE cp.organisation_id = ?`,
      )
      .bind(ORGANISATION_ID)
      .first(),
  ).resolves.toEqual({ cases: 1, inDefaultProject: 1 });
  expect(actorState.session).toMatchObject({
    ok: true,
    value: {
      identity: {
        organisationId: ORGANISATION_ID,
        sessionId: actorState.sessionId,
      },
      lifecycleKind: "sleeping",
      checkpoint: { kind: "current" },
    },
  });
  if (!actorState.connector.ok || !actorState.case.ok) {
    throw new Error("E2E Slack actor inspection failed");
  }
  const caseReceipts = settledReceiptIdentities(actorState.case.value);
  const connectorReceipts =
    actorState.connector.value.receipts.map(receiptIdentity);
  expect(caseReceipts).toEqual(connectorReceipts);
  const connector = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId: ORGANISATION_ID,
    connectorId: requireConnectorId(fixture.connectorId),
    now: Date.now(),
  });
  if (!connector.ok) throw new Error("E2E Connector resolution failed");
  await evictDurableObject(connector.value);
  const delivery = actorState.connector.value.deliveries[0];
  if (delivery === undefined) throw new Error("E2E delivery is missing");
  const retry = await connector.value.deliver({
    identity: actorState.connector.value.identity,
    delivery: { ...delivery, addressedAt: delivery.addressedAt + 60_000 },
    requestedAt: Date.now(),
  });
  expect(retry).toMatchObject({
    ok: true,
    value: { kind: "already_delivered" },
  });
  const changedContent = await connector.value.deliver({
    identity: actorState.connector.value.identity,
    delivery: {
      ...delivery,
      addressedAt: delivery.addressedAt + 60_000,
      content: { kind: "text", text: "Changed receipt must be rejected" },
    },
    requestedAt: Date.now(),
  });
  expect(changedContent).toEqual({
    ok: false,
    error: { code: "connector_delivery_conflict" },
  });
  const changedAddress = await connector.value.deliver({
    identity: actorState.connector.value.identity,
    delivery: {
      ...delivery,
      address: {
        kind: "slack_channel",
        workspaceId: "T0OTHER",
        channelId: "C0OTHER",
      },
    },
    requestedAt: Date.now(),
  });
  expect(changedAddress).toEqual({
    ok: false,
    error: { code: "connector_delivery_conflict" },
  });
  const replayed = await connector.value.inspect();
  expect(replayed).toEqual(actorState.connector);
  expect(slack.messages).toHaveLength(2);
  const rejectedDelivery: ConnectorDelivery = {
    ...delivery,
    deliveryId: "credential-recovery-delivery",
    idempotencyKey: "credential-recovery-idempotency",
    content: { kind: "text", text: "Recovered credential receipt" },
  };
  await runInDurableObject(
    connector.value,
    installCredentialRejectedDelivery.bind(null, rejectedDelivery),
  );
  await evictDurableObject(connector.value);
  const disabledAt = Date.now();
  await env.DB.prepare(
    "UPDATE slack_organisation_connection SET lifecycle = 'disabled', revision = revision + 1, disabled_at = ?, updated_at = ? WHERE organisation_id = ? AND integration_account_id = ?",
  )
    .bind(
      disabledAt,
      disabledAt,
      ORGANISATION_ID,
      fixture.selectedIntegrationAccountId,
    )
    .run();
  const blockedRecovery = await connector.value.deliver({
    identity: actorState.connector.value.identity,
    delivery: {
      ...rejectedDelivery,
      addressedAt: rejectedDelivery.addressedAt + 60_000,
    },
    requestedAt: disabledAt,
  });
  expect(blockedRecovery).toMatchObject({
    ok: true,
    value: { kind: "retry", reason: "connector_credential_unavailable" },
  });
  expect(slack.messages).toHaveLength(2);
  if (!blockedRecovery.ok || blockedRecovery.value.kind !== "retry") {
    throw new Error("E2E inactive connection must fence receipt recovery");
  }
  await env.DB.prepare(
    "UPDATE slack_organisation_connection SET lifecycle = 'active', revision = revision + 1, disabled_at = NULL, updated_at = ? WHERE organisation_id = ? AND integration_account_id = ?",
  )
    .bind(Date.now(), ORGANISATION_ID, fixture.selectedIntegrationAccountId)
    .run();
  await evictDurableObject(connector.value);
  const recovered = await connector.value.deliver({
    identity: actorState.connector.value.identity,
    delivery: {
      ...rejectedDelivery,
      addressedAt: rejectedDelivery.addressedAt + 60_000,
    },
    requestedAt: blockedRecovery.value.retryAt,
  });
  expect(recovered).toMatchObject({ ok: true, value: { kind: "delivered" } });
  const recoveredReplay = await connector.value.deliver({
    identity: actorState.connector.value.identity,
    delivery: {
      ...rejectedDelivery,
      addressedAt: rejectedDelivery.addressedAt + 120_000,
    },
    requestedAt: Date.now(),
  });
  expect(recoveredReplay).toMatchObject({
    ok: true,
    value: { kind: "already_delivered" },
  });
  const recoveredSnapshot = await connector.value.inspect();
  expect(recoveredSnapshot).toMatchObject({
    ok: true,
    value: { deliveryCount: 3 },
  });
  if (!recoveredSnapshot.ok)
    throw new Error("E2E recovered Connector inspection failed");
  expect(recoveredSnapshot.value.deliveries[2]).toEqual(rejectedDelivery);
  expect(slack.messages).toHaveLength(3);
  const preparationTimings = recordedPreparationTimings(logs.mock.calls);
  const rootTurnId = "turn_ingress_slack_Ev0E2EROOT";
  const followUpTurnId = "turn_ingress_slack_Ev0E2EFOLLOWUP";
  // The Session's start call prepares the flow binding and decides the
  // stream sink. The Connector makes no call before it for a first attempt.
  for (const turnId of [rootTurnId, followUpTurnId]) {
    expect(
      countPreparationPhase(
        preparationTimings,
        turnId,
        "start_information_flow",
      ),
    ).toBe(1);
    expect(
      countPreparationPhase(preparationTimings, turnId, "start_stream_sink"),
    ).toBe(1);
    expect(
      countPreparationPhase(preparationTimings, turnId, "start_custom_catalog"),
    ).toBe(1);
    expect(
      countPreparationPhase(
        preparationTimings,
        turnId,
        "harness_custom_catalog",
      ),
    ).toBe(1);
    expect(
      countPreparationPhase(
        preparationTimings,
        turnId,
        "harness_history_restore",
      ),
    ).toBe(1);
    expect(
      countPreparationPhase(
        preparationTimings,
        turnId,
        "recovery_information_flow",
      ),
    ).toBe(0);
    expect(
      countPreparationPhase(
        preparationTimings,
        turnId,
        "recovery_authorization",
      ),
    ).toBe(0);
    expect(
      countPreparationPhase(preparationTimings, turnId, "recovery_inspection"),
    ).toBe(0);
  }
  Object.assign(context.task.meta, {
    acceptance: {
      model: "moonshotai/kimi-k3",
      providerSort: "throughput",
      sessionIds: model.sessionIds,
      modelRequestCount: model.requests.length,
      messages: slack.messages,
      session: actorState.session,
      caseReceipts,
      connectorReceipts,
      preparationTimings,
      deliveryReplay: {
        retry,
        changedContent,
        changedAddress,
        replayed,
        blockedRecovery,
        recovered,
        recoveredReplay,
        recoveredSnapshot,
      },
    },
  });
}

async function rootWorkSettled(connectorId: string): Promise<boolean> {
  const state = await inspectSlackActors(connectorId);
  return (
    state.connector.ok &&
    state.connector.value.caseWork.activeRows === 0 &&
    state.connector.value.caseWork.receiptRows === 1
  );
}

function installCredentialRejectedDelivery(
  delivery: ConnectorDelivery,
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec(
    "INSERT INTO connector_delivery (delivery_id, idempotency_key, payload, state_json) VALUES (?, ?, ?, ?)",
    delivery.deliveryId,
    delivery.idempotencyKey,
    JSON.stringify(delivery),
    JSON.stringify({
      kind: "rejected",
      reason: "connector_credential_unavailable",
    }),
  );
}

function clientMessageId(message: Record<string, string>): string | undefined {
  return message.client_msg_id;
}

function recordedPreparationTimings(
  calls: readonly (readonly unknown[])[],
): readonly Record<string, unknown>[] {
  const timings: Record<string, unknown>[] = [];
  for (const [logged] of calls) {
    if (typeof logged !== "string") continue;
    const row = parseJsonOrNull(logged);
    if (!isRecord(row)) continue;
    switch (row.event) {
      case "slack.case_turn_prepared":
      case "slack.case_agent_setup_timing":
      case "case.session_preparation_timing":
      case "session.harness_preparation_timing":
      case "session.pi_initialized":
      case "session.pi_model_call_started":
      case "session.pi_model_call_completed":
        timings.push(row);
        break;
    }
  }
  return timings;
}

function countPreparationPhase(
  timings: readonly Record<string, unknown>[],
  turnId: string,
  phase: string,
): number {
  let count = 0;
  for (const row of timings) {
    if (row.turn_id === turnId && row.phase === phase) count += 1;
  }
  return count;
}
