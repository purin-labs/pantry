import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { ensureCreatedOrganisationActor } from "@purin-labs/agent/control/organisation-runtime";
import { newRequestId } from "@purin-labs/kernel/ids";
import { runScheduledCommerceOutboxReconciliation } from "../../src/commerce/outbox-worker";
import {
  commerceClient,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import { commerceWebhookPosts } from "./commerce-network";
import { PlanJourney } from "./production-plan-support";

declare module "vitest" {
  interface TaskMeta {
    commerceWebhookCatchUp?: Record<string, unknown>;
  }
}

const OPERATOR = "Bearer commerce-e2e-token";

it(
  "catches up through signed webhook posts, refuses a post it cannot verify, and takes a new secret after losing its own",
  { timeout: 180_000 },
  webhookCatchUpJourney,
);

/**
 * Plan 77 step 8. Pantry becomes a webhook subscriber of its merchant, and
 * Commerce has no wake-up call in this runtime. The one-minute run
 * subscribes Pantry. After that, staff change two products in Commerce and
 * Pantry's feed cursor reaches the newest event from the posts alone. A post
 * that a stranger signs is refused. When Pantry loses its secret, the posts
 * it cannot verify start no read; the next one-minute run takes a new
 * secret, and the next change arrives by post again. With the Café
 * acceptance fault armed, the next post fails at its queue step and starts
 * no read; the one-minute read still brings Pantry up to date.
 */
async function webhookCatchUpJourney({ task }: TestContext): Promise<void> {
  const owner = await commerceClient(`webhook-owner-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Webhook café");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_webhook_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  const shop = new PlanJourney(organisationId, merchantId, owner.session);
  const provisioned = await shop.native.provisionDemo({
    schemaVersion: "commerce.provision-demo.v2",
    externalReference: organisationId,
    merchantId,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  expect(provisioned.ok, JSON.stringify(provisioned)).toBe(true);

  // 1. The one-minute run subscribes Pantry and reads the setup.
  await runScheduledCommerceOutboxReconciliation(env, Date.now());
  const subscribed = await subscription(merchantId);
  expect(subscribed).toMatchObject({
    id: "pantry",
    url: `https://localhost/hook/commerce/${organisationId}`,
    topics: ["*"],
    state: "active",
  });
  const afterSetup = await consumer(merchantId);
  expect(await eventsAfter(merchantId, afterSetup)).toEqual([]);

  // 2. Staff change two products; the posts alone bring Pantry up to date.
  for (const slug of ["ginger_cookie", "taro_cookie"])
    await shop.describeProduct(slug);
  const changes = await eventsAfter(merchantId, afterSetup);
  expect(changes).toHaveLength(2);
  await expect
    .poll(() => consumer(merchantId), { timeout: 30_000 })
    .toBe(changes.at(-1));
  // Commerce posted the subscription's own creation and the two changes.
  const posted = await subscription(merchantId);
  expect(posted).toMatchObject({ delivered: 3, pending: 0 });

  // 2b. A burst of five staff changes: the posts that arrive while a read
  //     waits in the queue add no read of their own.
  const deliveredBefore = (await subscription(merchantId)).delivered;
  const postsBefore = commerceWebhookPosts.length;
  await requestCounts(merchantId, "DELETE");
  const beforeBurst = await consumer(merchantId);
  for (let change = 0; change < 5; change += 1)
    await shop.describeProduct(
      change % 2 === 0 ? "ginger_cookie" : "taro_cookie",
    );
  const burst = await eventsAfter(merchantId, beforeBurst);
  expect(burst).toHaveLength(5);
  await expect
    .poll(() => consumer(merchantId), { timeout: 30_000 })
    .toBe(burst.at(-1));
  // Every post is delivered, and the reads it queued have run.
  await expect
    .poll(async () => (await subscription(merchantId)).delivered, {
      timeout: 30_000,
    })
    .toBe(deliveredBefore + burst.length);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  // Commerce posted each event once.
  const burstPosts = commerceWebhookPosts.slice(postsBefore);
  expect(burstPosts).toHaveLength(burst.length);
  expect(new Set(burstPosts).size).toBe(burst.length);
  // The journey's own event read above is one of the counted reads.
  const burstReads =
    ((await requestCounts(merchantId, "GET")).read_events ?? 0) - 1;
  expect(burstReads).toBeGreaterThan(0);
  expect(burstReads).toBeLessThan(burst.length);

  // 3. A post that a stranger signs is refused.
  const forgedBody = JSON.stringify({
    schemaVersion: "commerce.webhook-event.v1",
    eventId: "event_forged",
    kind: "order.created",
    merchantId,
    merchantRevision: 1,
    occurredAt: new Date().toISOString(),
    resources: [],
  });
  const forged = await post(organisationId, forgedBody, "a-stranger-secret");
  expect(forged.status).toBe(401);

  // 4. Pantry loses its secret: the next post starts no read.
  await fixtureDatabase()
    .prepare(
      "UPDATE commerce_webhook_subscription SET sealed_secret = ? WHERE organisation_id = ?",
    )
    .bind("AAAAAAAAAAAAAAAA.AAAA", organisationId)
    .run();
  const beforeLoss = await consumer(merchantId);
  await shop.describeProduct("ginger_cookie");
  await expect
    .poll(async () => (await subscription(merchantId)).pending, {
      timeout: 30_000,
    })
    .toBe(1);
  expect(await consumer(merchantId)).toBe(beforeLoss);

  // 5. The next one-minute run takes a new secret and reads what it missed;
  //    the change after it arrives by post again.
  await runScheduledCommerceOutboxReconciliation(env, Date.now());
  const rotated = await subscription(merchantId);
  expect(rotated.revision).toBe(subscribed.revision + 1);
  const afterRotation = await consumer(merchantId);
  expect(await eventsAfter(merchantId, afterRotation)).toEqual([]);
  await shop.describeProduct("taro_cookie");
  const last = await eventsAfter(merchantId, afterRotation);
  expect(last).toHaveLength(1);
  await expect
    .poll(() => consumer(merchantId), { timeout: 30_000 })
    .toBe(last[0]);

  // 6. The acceptance fault fails the next post's queue step: the post
  //    starts no read, and the one-minute read catches up.
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  await organisation.armCafeCommerceAcceptanceFault({
    requestId: newRequestId(),
    merchantId,
    armedAt: Date.now(),
  });
  const beforeFault = await consumer(merchantId);
  await shop.describeProduct("ginger_cookie");
  await expect
    .poll(
      async () =>
        (await organisation.inspectCafeCommerceAcceptanceFault())
          ?.queueConsumedAt ?? null,
      { timeout: 30_000 },
    )
    .not.toBeNull();
  const faulted = await eventsAfter(merchantId, beforeFault);
  expect(faulted).toHaveLength(1);
  expect(await consumer(merchantId)).toBe(beforeFault);
  await runScheduledCommerceOutboxReconciliation(env, Date.now());
  await expect
    .poll(() => consumer(merchantId), { timeout: 30_000 })
    .toBe(faulted[0]);

  task.meta.commerceWebhookCatchUp = {
    subscription: {
      url: "https://localhost/hook/commerce/:organisationId",
      topics: subscribed.topics,
    },
    changesByPost: changes.length,
    burst: { changes: burst.length, fewerReadsThanPosts: true },
    deliveredAfterChanges: posted.delivered,
    forgedStatus: forged.status,
    lostSecret: { pending: 1, cursorMoved: false },
    rotatedRevisionStep: rotated.revision - subscribed.revision,
    changeAfterRotationByPost: last.length,
    faultedPostCaughtUpByRead: faulted.length,
  };
}

/** A post to Pantry's receiver, signed with `secret`. */
async function post(
  organisationId: string,
  body: string,
  secret: string,
): Promise<Response> {
  const timestamp = new Date().toISOString();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${body}`),
    ),
  );
  return exports.default.fetch(
    new Request(`https://localhost/hook/commerce/${organisationId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-commerce-timestamp": timestamp,
        "x-commerce-signature": `v1=${[...signature]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("")}`,
      },
      body,
    }),
  );
}

type Subscription = Readonly<{
  id: string;
  revision: number;
  url: string;
  topics: string[];
  state: string;
  delivered: number;
  pending: number;
}>;

async function subscription(merchantId: string): Promise<Subscription> {
  const response = await env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${merchantId}/webhook-subscriptions`,
    { headers: { authorization: OPERATOR } },
  );
  const body: unknown = await response.json();
  const list =
    isRecord(body) && Array.isArray(body.subscriptions)
      ? body.subscriptions
      : body;
  if (!Array.isArray(list) || list.length !== 1)
    throw new Error(`Subscription read failed: ${JSON.stringify(body)}`);
  return list[0] as Subscription;
}

async function consumer(merchantId: string): Promise<string> {
  const response = await env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${merchantId}/feed-consumers/pantry`,
    { headers: { authorization: OPERATOR } },
  );
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.cursor !== "string")
    throw new Error(`Feed consumer read failed: ${JSON.stringify(body)}`);
  return body.cursor;
}

/** The cursors of every event after `after`. */
async function eventsAfter(
  merchantId: string,
  after: string,
): Promise<string[]> {
  const response = await env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${merchantId}/events?after=${encodeURIComponent(after)}&limit=200`,
    { headers: { authorization: OPERATOR } },
  );
  const body = (await response.json()) as { events: { cursor: string }[] };
  if (!Array.isArray(body.events))
    throw new Error(`Feed read failed: ${JSON.stringify(body)}`);
  return body.events.map((event) => event.cursor);
}

/** Requests that reached the merchant's object, by route kind. */
async function requestCounts(
  merchantId: string,
  method: "GET" | "DELETE",
): Promise<Record<string, number>> {
  const response = await env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${merchantId}/test-request-counts`,
    { method, headers: { authorization: OPERATOR } },
  );
  return (await response.json()) as Record<string, number>;
}
