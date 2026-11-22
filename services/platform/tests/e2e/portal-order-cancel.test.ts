// An owner cancels a paid order from the Portal's Orders page. The page reads
// the order from Commerce and sends that order's own id, as a person's click
// does. No money moves before the approval.
import { fixtureDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { advanceOrderQueueEntry } from "../../src/cafe/contract/order-queue-commands";
import { googleConfig } from "@purin-labs/control/worker/google-oidc-config";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import { parseIntegrationAccountId, parseRequestId } from "@purin-labs/kernel/ids";
import { createCommerceOutboxReconcileQueueMessage } from "../../src/commerce/contract/queue-messages";
import { reconcileCommerceOutbox } from "../../src/commerce/outbox-worker";
import {
  placeCafeOrder,
  publishCafeMenu,
  required,
} from "./cafe-order-support";
import { completeCommerceApprovalFixture } from "./commerce-approval-fixture";
import { commerceHeaders } from "./commerce-support";
import { network } from "./network";
import {
  MERCHANT,
  OWNER,
  installEffectAuthority,
  postControl,
  providerClient,
} from "./pi-sdk-effect-support";
import {
  ORGANISATION_ID,
  installSlackActorFixture,
  slackSimulator,
} from "./slack-journey-support";
import { trustShopDeliveries } from "./commerce-journey-support";

declare module "vitest" {
  interface TaskMeta {
    portalOrderCancel?: Record<string, unknown>;
  }
}

const BASE = `https://localhost/v1/control/organisations/${ORGANISATION_ID}/commerce`;

it(
  "cancels a paid order from the Orders page only after an owner approves it",
  { timeout: 180_000 },
  async ({ task }: TestContext): Promise<void> => {
    const session = await openShop();
    const orderId = await placeCafeOrder(MERCHANT, ["item_cookie"]);
    await drainFeed();

    // 1. The Orders page proposes with the id that it read from Commerce.
    const { nonce, earlyExecute } = await proposeAndApprove(session, orderId);

    const executed = await postControl(
      session,
      `/${nonce}/execute`,
      {},
      "order-cancel-execute",
    );
    expect(executed.status, await executed.clone().text()).toBe(200);

    const order = (await snapshot()).resources.orders.find(
      (candidate) => candidate.id === orderId,
    );
    expect(order?.lifecycle.state).toBe("cancelled");
    expect((await paymentOf(orderId)).lifecycle.state).toBe("refunded");

    task.meta.portalOrderCancel = {
      orderId,
      earlyExecute,
      order: order?.lifecycle.state,
    };
  },
);

it(
  "refuses to cancel an order whose drink staff already made, and moves no money",
  { timeout: 180_000 },
  async (): Promise<void> => {
    const session = await openShop();
    const orderId = await placeCafeOrder(MERCHANT, ["item_taro", "item_cookie"]);
    await drainFeed();
    // An order can be cancelled until its preparation ends. Staff make the
    // drink, so its stock is used.
    await makeDrink(orderId);
    const { nonce } = await proposeAndApprove(session, orderId);
    const executed = await postControl(
      session,
      `/${nonce}/execute`,
      {},
      "order-cancel-prepared",
    );
    expect(executed.status).toBe(409);
    expect(await executed.json()).toMatchObject({
      error: "commerce_action_order_has_prepared_lines",
    });

    const order = (await snapshot()).resources.orders.find(
      (candidate) => candidate.id === orderId,
    );
    expect(order?.lifecycle.state).toBe("fulfillment_pending");
    expect((await paymentOf(orderId)).lifecycle.state).toBe("captured");
  },
);

async function openShop(): Promise<IssuedControlSession> {
  const fixture = await installSlackActorFixture();
  network.use(slackSimulator().handler);
  const session = await installEffectAuthority(
    fixture.selectedIntegrationAccountId,
    "plugin",
  );
  const provisioned = await providerClient().provisionDemo({
    schemaVersion: "commerce.provision-demo.v2",
    externalReference: ORGANISATION_ID,
    merchantId: MERCHANT,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  if (!provisioned.ok) throw new Error(JSON.stringify(provisioned.error));
  await trustShopDeliveries(MERCHANT);
  await publishCafeMenu(MERCHANT);
  return session;
}

/** Staff start the order's drink from the queue, then complete its ticket. */
async function makeDrink(orderId: string): Promise<void> {
  const client = providerClient();
  const fulfillmentId = (await queueEntry(orderId)).fulfillmentId;
  const started = await advanceOrderQueueEntry(
    { client, merchantId: MERCHANT },
    fulfillmentId,
    "start",
    "order-cancel-start",
  );
  expect(started).toEqual({ ok: true });
  const queue = await required(client.readPickupQueue(MERCHANT));
  const preparation = queue.entries.find(
    (candidate) => candidate.orderId === orderId,
  )?.preparation;
  if (preparation?.state !== "preparing")
    throw new Error(`The drink did not start: ${preparation?.state}`);
  const completed = await required(
    client.managePreparationTicket({
      merchantId: MERCHANT,
      expectedMerchantRevision: queue.merchantRevision,
      idempotencyKey: "order-cancel-complete",
      operation: {
        kind: "complete",
        ticketId: preparation.ticketId,
        expectedTicketRevision: preparation.ticketRevision,
      },
    }),
  );
  expect(completed.outcome, JSON.stringify(completed)).toBe("applied");
  expect((await queueEntry(orderId)).preparation.state).toBe("completed");
}

async function queueEntry(orderId: string) {
  const queue = await required(providerClient().readPickupQueue(MERCHANT));
  const entry = queue.entries.find(
    (candidate) => candidate.orderId === orderId,
  );
  if (entry === undefined) throw new Error("The order is not in the queue");
  return entry;
}

async function proposeAndApprove(
  session: IssuedControlSession,
  orderId: string,
): Promise<Readonly<{ nonce: string; earlyExecute: number }>> {
  const provenance = await orderProvenance(session, orderId);
  expect(provenance.resourceId).toBe(orderId);
  const proposed = await postControl(
    session,
    "",
    {
      kind: "cancel_order",
      resourceId: provenance.resourceId,
      expectedRevision: provenance.revision,
      reason: "inventory_unavailable",
      refund: "full",
      restock: true,
      notifyCustomer: false,
      note: null,
    },
    "order-cancel-propose",
  );
  expect(proposed.status, await proposed.clone().text()).toBe(200);
  const nonce = actionNonce(await proposed.json());

  // 2. No money moves before the approval.
  const early = await postControl(
    session,
    `/${nonce}/execute`,
    {},
    "order-cancel-early",
  );
  expect(early.status).toBe(409);
  expect((await paymentOf(orderId)).lifecycle.state).toBe("captured");

  // 3. The owner approves: the order is cancelled and its money comes back.
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const action = await organisation.getAction({
    organisationId: ORGANISATION_ID,
    nonce,
    now: Date.now(),
  });
  if (!action.ok) throw new Error(action.error.code);
  const config = googleConfig(env);
  if (config === null) throw new Error("Missing approval configuration");
  const grant = await completeCommerceApprovalFixture({
    db: env.DB,
    config,
    action: action.value.action,
    userId: OWNER,
    subject: "e2e-slack-actor",
    email: "e2e-slack-actor@example.invalid",
    stepUpId: "order-cancel-step-up",
  });
  const approved = await postControl(
    session,
    `/${nonce}/approval`,
    {},
    "order-cancel-approve",
    grant,
  );
  expect(approved.status, await approved.clone().text()).toBe(200);
  return { nonce, earlyExecute: early.status };
}

function snapshot() {
  return required(providerClient().readSnapshot(MERCHANT));
}

async function paymentOf(orderId: string) {
  const payment = (await snapshot()).resources.payments.find(
    (candidate) => candidate.orderId === orderId,
  );
  if (payment === undefined) throw new Error("No payment");
  return payment;
}

function actionNonce(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.action))
    throw new Error("No action in the proposal");
  const nonce = value.action.nonce;
  const text = isRecord(nonce) ? nonce.value : nonce;
  if (typeof text !== "string") throw new Error("No action nonce");
  return text;
}

async function orderProvenance(
  session: IssuedControlSession,
  orderId: string,
): Promise<Readonly<{ resourceId: string; revision: number }>> {
  const headers = commerceHeaders(session);
  headers.set("idempotency-key", crypto.randomUUID());
  const response = await exports.default.fetch(`${BASE}/graph`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: {
        kind: "entity_type_page",
        entityTypeId: { origin: "system", typeId: "order" },
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 10, cursor: null },
        traversal: { maxDepth: 0, resultLimit: 10 },
      },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body: unknown = await response.json();
  const entities =
    isRecord(body) &&
    isRecord(body.result) &&
    Array.isArray(body.result.entities)
      ? body.result.entities
      : [];
  for (const entity of entities) {
    if (
      isRecord(entity) &&
      isRecord(entity.reference) &&
      entity.reference.entityId === orderId &&
      isRecord(entity.provenance) &&
      typeof entity.provenance.resourceId === "string" &&
      typeof entity.provenance.revision === "number"
    )
      return {
        resourceId: entity.provenance.resourceId,
        revision: entity.provenance.revision,
      };
  }
  throw new Error("The order is not in the graph");
}

async function drainFeed(): Promise<void> {
  const binding = await fixtureDatabase().prepare(
    "SELECT integration_account_id AS integrationAccountId FROM commerce_merchant_binding WHERE merchant_id = ?",
  )
    .bind(MERCHANT)
    .first<{ integrationAccountId: string }>();
  const requestId = parseRequestId(
    `request_cancel_${crypto.randomUUID().replaceAll("-", "")}`,
  );
  const account = parseIntegrationAccountId(
    binding?.integrationAccountId ?? "",
  );
  if (!requestId.ok || !account.ok)
    throw new Error("Invalid reconcile message");
  const drained = await reconcileCommerceOutbox({
    env,
    message: createCommerceOutboxReconcileQueueMessage({
      requestId: requestId.value,
      receivedAt: Date.now(),
      organisationId: ORGANISATION_ID,
      integrationAccountId: account.value,
    }),
  });
  expect(drained, JSON.stringify(drained)).toMatchObject({
    kind: "drained",
    rejected: 0,
  });
}
