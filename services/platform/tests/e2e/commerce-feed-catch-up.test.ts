import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { fixtureDatabase } from "./organisation-database";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { ensureCreatedOrganisationActor } from "@purin-labs/agent/control/organisation-runtime";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  parseRequestId,
} from "@purin-labs/kernel/ids";
import { createCommerceOutboxReconcileQueueMessage } from "@purin-labs/area-commerce/server/contract/queue-messages";
import { reconcileCommerceOutbox } from "@purin-labs/area-commerce/server/outbox-worker";
import {
  commerceClient,
  commerceOrganisationActor,
  commerceSyncStatus,
  commerceWorkspace,
  lastSyncedAt,
  connectCommerceFixture,
} from "./commerce-support";
import { PlanJourney } from "./production-plan-support";

declare module "vitest" {
  interface TaskMeta {
    commerceFeedCatchUp?: Record<string, unknown>;
  }
}

const OPERATOR = "Bearer commerce-e2e-token";

it(
  "catches up from its feed cursor after a stop and a lost cursor move, with no lost and no repeated event",
  { timeout: 180_000 },
  feedCatchUpJourney,
);

/**
 * Plan 76 phase 4. Pantry reads each merchant's event feed after its own
 * cursor. A café is set up while Pantry's reader is stopped. Pantry's first run
 * stops when the cursor move after its fourth event is lost; more changes
 * arrive while it is stopped again. The next run starts from the cursor:
 * every event is applied, the one event read twice is a replay that changes
 * nothing, and a third run finds nothing new. A change with no aggregate
 * observation (a market) is delivered like any other, not refused.
 */
async function feedCatchUpJourney({ task }: TestContext): Promise<void> {
  const owner = await commerceClient(`feed-owner-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Feed catch-up café");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_feed_catch_up_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  const shop = new PlanJourney(organisationId, merchantId, owner.session);

  // 1. Pantry's reader is stopped while the café is set up.
  const provisioned = await shop.native.provisionDemo({
    schemaVersion: "commerce.provision-demo.v2",
    externalReference: organisationId,
    merchantId,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  expect(provisioned.ok, JSON.stringify(provisioned)).toBe(true);
  const start = await consumer(merchantId);
  const firstBacklog = await eventsAfter(merchantId, start.cursor);
  expect(firstBacklog.length).toBeGreaterThan(4);

  // 2. Pantry starts; the cursor move after its fourth event is lost.
  let moves = 0;
  const losingFourthMove: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.includes("/feed-consumers/") && init?.method === "PUT") {
      moves += 1;
      if (moves === 4)
        return Response.json({ message: "lost" }, { status: 503 });
    }
    return env.COMMERCE.fetch(input, init);
  };
  const interrupted = await reconcile(organisationId, losingFourthMove);
  expect(interrupted).toMatchObject({
    kind: "retry",
    code: "commerce_feed_cursor_http_503",
  });
  const afterInterruption = await consumer(merchantId);
  expect(afterInterruption.cursor).toBe(firstBacklog[2]);

  // 3. More changes arrive while Pantry is stopped again: staff change two
  //    product descriptions and open a market in Commerce directly.
  for (const slug of ["ginger_cookie", "taro_cookie"])
    await shop.describeProduct(slug);
  await openMarket(shop, merchantId);
  const backlog = await eventsAfter(merchantId, afterInterruption.cursor);
  expect(backlog.length).toBeGreaterThan(firstBacklog.length - 3);

  // 4. Pantry starts again from its cursor: the fourth event is read again
  //    and counts as a replay; every later event is applied once.
  const resumed = await reconcile(organisationId, undefined);
  expect(resumed, JSON.stringify(resumed)).toMatchObject({
    kind: "drained",
    rejected: 0,
  });
  const counts = resumed as { acknowledged: number; replayed: number };
  expect(counts.acknowledged + counts.replayed).toBe(backlog.length);
  expect(counts.replayed).toBeLessThanOrEqual(1);
  const caughtUp = await consumer(merchantId);
  expect(caughtUp.cursor).toBe(backlog.at(-1));

  // 5. A third run finds nothing, and Commerce counts every delivery as
  //    delivered. Pantry knows a product from the setup before the loss.
  //    The run rewrites no projection row, and the shop still reads as in
  //    sync at the time of that run.
  const rowsBeforeIdle = await projectionStamps(organisationId);
  const idleAt = Date.now();
  const idle = await reconcile(organisationId, undefined);
  expect(idle).toEqual({
    kind: "drained",
    acknowledged: 0,
    replayed: 0,
    rejected: 0,
  });
  expect(rowsBeforeIdle.length).toBeGreaterThan(0);
  expect(await projectionStamps(organisationId)).toEqual(rowsBeforeIdle);
  const sync = await commerceSyncStatus(organisationId);
  expect(sync).toMatchObject({ ok: true, value: { kind: "ready" } });
  expect(lastSyncedAt(sync)).toBeGreaterThanOrEqual(idleAt);
  const outbox = await fixture(merchantId, { kind: "outbox_status" });
  expect(outbox).toEqual([
    { status: "delivered", reason: null, count: expect.any(Number) },
  ]);
  const known = await sendForApproval(shop, merchantId, "ginger_cookie");
  expect(known.error).not.toBe("commerce_action_projection_missing");

  task.meta.commerceFeedCatchUp = {
    firstBacklog: firstBacklog.length,
    interrupted: { kind: interrupted.kind, cursorAfter: "third event" },
    secondBacklog: backlog.length,
    resumed,
    idle,
    idleRun: {
      projectionRows: rowsBeforeIdle.length,
      rowsRewritten: 0,
      sync: sync.ok ? sync.value.kind : sync,
    },
    outbox,
    productKnown: known.error !== "commerce_action_projection_missing",
  };
}

/** Each projection row with the time its own row was last validated. */
async function projectionStamps(
  organisationId: string,
): Promise<readonly string[]> {
  return runInDurableObject(
    await commerceOrganisationActor(organisationId),
    (_actor: unknown, state: DurableObjectState) =>
      state.storage.sql
        .exec<{ id: string; validatedAt: number | null }>(
          `SELECT projection_kind || ':' || canonical_id AS id,
                  validated_at AS validatedAt
           FROM commerce_projection ORDER BY id`,
        )
        .toArray()
        .map((row) => `${row.id}@${String(row.validatedAt)}`),
  );
}

/** A staff market, straight to Commerce; its event has no observation. */
async function openMarket(
  shop: PlanJourney,
  merchantId: string,
): Promise<void> {
  const snapshot = await shop.native.readSnapshot(merchantId);
  if (!snapshot.ok) throw new Error("Snapshot read failed");
  const key = `feed_market_${crypto.randomUUID()}`;
  const result = await shop.native.createMarket({
    merchantId,
    idempotencyKey: key,
    marketId: "market_sg",
    name: "Singapore",
    countries: ["SG"],
    currency: "SGD",
    storefrontIds: ["storefront_cafe"],
    pricing: {
      kind: "converted",
      rate: {
        value: "0.0090",
        setAt: new Date().toISOString(),
        source: "staff",
      },
      roundingIncrement: 5,
    },
  });
  expect(result.ok && result.value.outcome, JSON.stringify(result)).toBe(
    "applied",
  );
}

async function reconcile(
  organisationId: string,
  fetcher: typeof fetch | undefined,
) {
  const binding = await fixtureDatabase()
    .prepare(
      "SELECT integration_account_id AS integrationAccountId FROM commerce_merchant_binding WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ integrationAccountId: string }>();
  const requestId = parseRequestId(
    `request_feed_${crypto.randomUUID().replaceAll("-", "")}`,
  );
  const organisation = parseOrganisationId(organisationId);
  const account = parseIntegrationAccountId(
    binding?.integrationAccountId ?? "",
  );
  if (!requestId.ok || !organisation.ok || !account.ok)
    throw new Error("Invalid reconcile message");
  return reconcileCommerceOutbox({
    env,
    message: createCommerceOutboxReconcileQueueMessage({
      requestId: requestId.value,
      receivedAt: Date.now(),
      organisationId: organisation.value,
      integrationAccountId: account.value,
    }),
    ...(fetcher === undefined ? {} : { fetcher }),
  });
}

async function consumer(merchantId: string): Promise<{ cursor: string }> {
  const response = await env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${merchantId}/feed-consumers/pantry`,
    { headers: { authorization: OPERATOR } },
  );
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.cursor !== "string")
    throw new Error(`Feed consumer read failed: ${JSON.stringify(body)}`);
  return { cursor: body.cursor };
}

/** The cursors of every event after `after`. */
async function eventsAfter(
  merchantId: string,
  after: string,
): Promise<string[]> {
  const cursors: string[] = [];
  let next = after;
  for (;;) {
    const response = await env.COMMERCE.fetch(
      `http://commerce.test/v1/admin/merchants/${merchantId}/events?after=${encodeURIComponent(next)}&limit=200`,
      { headers: { authorization: OPERATOR } },
    );
    const body = (await response.json()) as {
      events: { cursor: string }[];
      nextCursor: string | null;
    };
    if (!Array.isArray(body.events))
      throw new Error(
        `Feed read failed: ${response.status} ${JSON.stringify(body)}`,
      );
    for (const event of body.events) cursors.push(event.cursor);
    if (body.nextCursor === null || body.events.length < 200) return cursors;
    next = body.nextCursor;
  }
}

async function fixture(merchantId: string, body: unknown): Promise<unknown> {
  const response = await env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${merchantId}/test-fixture`,
    {
      method: "POST",
      headers: { authorization: OPERATOR, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

async function sendForApproval(
  shop: PlanJourney,
  merchantId: string,
  slug: string,
): Promise<Readonly<{ status: number; error: unknown }>> {
  const response = await shop.send("/actions", {
    kind: "update_product_description",
    productId: `commerce:${merchantId}:product_${slug}`,
    productRevision: 1,
    description: "Baked each morning in our café.",
  });
  const body: unknown = await response.json();
  return {
    status: response.status,
    error: isRecord(body) && "error" in body ? body.error : null,
  };
}
