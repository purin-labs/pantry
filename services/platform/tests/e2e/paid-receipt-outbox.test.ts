import { env, exports } from "cloudflare:workers";
import { parseOrderQueueEntries } from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import { commercePickupCode } from "@purin-labs/commerce-client";
import { expect, it, type TestContext } from "vitest";

import type { IssuedControlSession } from "../../src/data/control-plane";
import {
  parseIntegrationAccountId,
  parseRequestId,
  parseSlackInstallationId,
  parseSlackOrganisationConnectionId,
} from "../../src/ids";
import { createCommerceOutboxReconcileQueueMessage } from "../../src/commerce/contract/queue-messages";
import {
  createSlackOrganisationConnection,
  disableSlackOrganisationConnection,
} from "../../src/slack/installation-store";
import { reconcileCommerceOutbox } from "../../src/commerce/outbox-worker";
import { runScheduledPaidReceiptDelivery } from "../../src/commerce/paid-receipt";
import { placeCafeOrder, publishCafeMenu } from "./cafe-order-support";
import { connectCommerceFixture } from "./commerce-support";
import {
  PUBLIC_ORIGIN,
  controlReadHeaders,
} from "./hibernatable-socket-support";
import { network } from "./network";
import { fixtureDatabase } from "./organisation-database";
import { providerClient } from "./pi-sdk-effect-support";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  installSlackActorFixture,
  slackSimulator,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    paidReceiptOutbox?: Record<string, unknown>;
  }
}

const MERCHANT = "merchant_paid_receipt_outbox";
const OPERATOR = "Bearer commerce-e2e-token";

/**
 * Refactor 15, refactor 12. The café's Slack connection is disabled while two
 * customers pay on the QR order page. Pantry's feed still reads every event of
 * the shop: Commerce counts Pantry as caught up, staff see both orders in the
 * queue, and each Slack receipt waits as `failed` with its reason. When Slack
 * works again, the retry pass of the schedule posts each receipt once; a
 * second pass and a replay of the feed post nothing more. The old feed
 * stopped at the first receipt and left every later event of the shop unread.
 * The queue page reads Commerce itself, so it shows both orders either way.
 */
it(
  "applies two paid orders while Slack is disabled, and sends each held receipt once when Slack works again",
  { timeout: 240_000 },
  paidReceiptOutboxJourney,
);

async function paidReceiptOutboxJourney({ task }: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const owner = fixture.ownerSession;
  await connectCommerceFixture(ORGANISATION_ID, owner.session.userId, MERCHANT);
  const demo = await providerClient().provisionDemo({
    schemaVersion: "commerce.provision-demo.v2",
    externalReference: ORGANISATION_ID,
    merchantId: MERCHANT,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  if (!demo.ok) throw new Error(JSON.stringify(demo.error));
  await publishCafeMenu(MERCHANT);
  expect(await drainFeed(Date.now())).toMatchObject({ kind: "drained" });
  const slack = slackSimulator();
  network.use(slack.handler);
  const integrationAccountId = parseIntegrationAccountId(
    fixture.selectedIntegrationAccountId,
  );
  if (!integrationAccountId.ok) throw new Error("Invalid Slack account");

  // 1. The café's Slack connection is disabled. Two customers pay.
  await disableSlackOrganisationConnection(env.DB, {
    organisationId: ORGANISATION_ID,
    integrationAccountId: integrationAccountId.value,
    now: Date.now(),
  });
  const first = await placeCafeOrder(MERCHANT, ["item_taro"]);
  const second = await placeCafeOrder(MERCHANT, ["item_cookie"]);

  // 2. The feed reads every event of the shop, and staff see both orders.
  const paidAt = Date.now();
  const drained = await drainFeed(paidAt);
  const unread = await eventsAfter((await feedConsumer()).cursor);
  expect(unread).toEqual([]);
  const queue = await readQueueCodes(owner);
  expect(queue).toEqual(
    expect.arrayContaining([
      commercePickupCode(first),
      commercePickupCode(second),
    ]),
  );
  expect(drained, JSON.stringify(drained)).toMatchObject({
    kind: "drained",
    rejected: 0,
  });

  // 3. No receipt reached Slack. Each waits as failed, with its reason.
  expect(slack.messages).toEqual([]);
  const held = await receipts();
  // The receipt names the order by its canonical id, which ends in the
  // order id of the QR order page.
  expect(
    held.map((receipt) => receipt.orderId.split(":").at(-1)).sort(),
  ).toEqual([first, second].sort());
  for (const receipt of held)
    expect(receipt).toMatchObject({
      state: "failed",
      attempts: 1,
      failureReason: expect.stringContaining(
        "connector_credential_unavailable",
      ),
    });

  // 4. Slack works again. The retry pass posts each receipt once.
  await reconnectSlack(integrationAccountId.value);
  const retryAt = paidAt + 2 * 60_000;
  await runScheduledPaidReceiptDelivery(env, retryAt);
  expect(slack.messages).toHaveLength(2);
  for (const orderId of [first, second])
    expect(
      slack.messages.filter(
        (message) =>
          message.channel === CHANNEL_ID &&
          message.text?.includes(`:${orderId}. Total`),
      ),
    ).toHaveLength(1);
  const sent = await receipts();
  expect(sent.map((receipt) => receipt.state)).toEqual(["sent", "sent"]);

  // 5. A second pass and a replay of the feed post nothing more.
  await runScheduledPaidReceiptDelivery(env, retryAt + 20 * 60_000);
  expect(await drainFeed(retryAt + 20 * 60_000)).toMatchObject({
    kind: "drained",
  });
  expect(slack.messages).toHaveLength(2);

  task.meta.paidReceiptOutbox = {
    unreadEventsAfterFailedReceipts: unread.length,
    queueAfterFailedReceipts: queue.length,
    heldReceipts: held.map(({ state, failureReason, attempts }) => ({
      state,
      failureReason,
      attempts,
    })),
    slackMessagesAfterRetry: slack.messages.length,
    finalStates: (await receipts()).map((receipt) => receipt.state),
  };
}

async function drainFeed(now: number): Promise<unknown> {
  const binding = await fixtureDatabase()
    .prepare(
      "SELECT integration_account_id AS integrationAccountId FROM commerce_merchant_binding WHERE merchant_id = ?",
    )
    .bind(MERCHANT)
    .first<{ integrationAccountId: string }>();
  const requestId = parseRequestId(
    `request_receipt_${crypto.randomUUID().replaceAll("-", "")}`,
  );
  const account = parseIntegrationAccountId(
    binding?.integrationAccountId ?? "",
  );
  if (!requestId.ok || !account.ok)
    throw new Error("Invalid reconcile message");
  return reconcileCommerceOutbox({
    env,
    now,
    message: createCommerceOutboxReconcileQueueMessage({
      requestId: requestId.value,
      receivedAt: now,
      organisationId: ORGANISATION_ID,
      integrationAccountId: account.value,
    }),
  });
}

/** Pantry's place in the shop's event feed, as Commerce stores it. */
async function feedConsumer(): Promise<{ cursor: string }> {
  const response = await env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${MERCHANT}/feed-consumers/pantry`,
    { headers: { authorization: OPERATOR } },
  );
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.cursor !== "string")
    throw new Error(`Feed consumer read failed: ${JSON.stringify(body)}`);
  return { cursor: body.cursor };
}

/** The cursors of the shop's events after `after`. */
async function eventsAfter(after: string): Promise<string[]> {
  const response = await env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${MERCHANT}/events?after=${encodeURIComponent(after)}&limit=200`,
    { headers: { authorization: OPERATOR } },
  );
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.events))
    throw new Error(`Feed read failed: ${JSON.stringify(body)}`);
  return body.events.map((event: unknown) =>
    isRecord(event) ? String(event.cursor) : "",
  );
}

async function readQueueCodes(
  owner: IssuedControlSession,
): Promise<readonly string[]> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${ORGANISATION_ID}/commerce/order-queue`,
    { headers: controlReadHeaders(owner) },
  );
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  const entries = parseOrderQueueEntries(isRecord(body) ? body.entries : null);
  if (entries === null) throw new Error(`No queue: ${JSON.stringify(body)}`);
  return entries.map((entry) => entry.code);
}

async function receipts(): Promise<
  readonly Readonly<{
    orderId: string;
    state: string;
    failureReason: string | null;
    attempts: number;
  }>[]
> {
  const rows = await fixtureDatabase()
    .prepare(
      `SELECT order_id AS orderId, state, failure_reason AS failureReason, attempts
       FROM paid_receipt WHERE organisation_id = ?`,
    )
    .bind(ORGANISATION_ID)
    .all<{
      orderId: string;
      state: string;
      failureReason: string | null;
      attempts: number;
    }>();
  return rows.results;
}

async function reconnectSlack(
  integrationAccountId: Parameters<
    typeof disableSlackOrganisationConnection
  >[1]["integrationAccountId"],
): Promise<void> {
  const connectionId = parseSlackOrganisationConnectionId(
    "connection_e2e_slack_org",
  );
  const installationId = parseSlackInstallationId("installation_e2e_slack");
  if (!connectionId.ok || !installationId.ok)
    throw new Error("Invalid Slack connection");
  await createSlackOrganisationConnection(env, {
    connectionId: connectionId.value,
    installationId: installationId.value,
    organisationId: ORGANISATION_ID,
    integrationAccountId,
    connectedAt: Date.now(),
  });
}
