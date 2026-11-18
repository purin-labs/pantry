// Plan 76A step 4B: three endpoints subscribe to order events. One is
// healthy, one fails for an hour and then recovers, one never recovers. The
// healthy and the recovered endpoints each get every matching event once,
// with valid signatures; the feed returns the same events to any cursor; the
// endpoint that fails for 48 hours becomes `failing` and gets no more posts.
// A fourth endpoint gets each captured payment, naming its payment attempt.
// Set WEBHOOK_ARTIFACT_DIR to keep the run's evidence; the file repeats byte
// for byte for the same commit.
import { createHmac } from "node:crypto";

import {
  parseWebhookEvent,
  webhookTopicMatches,
  type CommerceAdminClient,
  type CommerceEventV1,
  type CommerceMutationResultV1,
} from "@seams/commerce-client";
import { expect, it } from "vitest";

import type {
  WebhookPost,
  WebhookPostResult,
  WebhookSender,
} from "../src/webhooks.ts";
import {
  Buyer,
  NOW,
  StaffDesk,
  catalogLine,
  jpy,
  merchantId,
  rejectedWith,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const ALPHA = "https://hooks.alpha.example/underclerk";
const BETA = "https://hooks.beta.example/underclerk";
const GAMMA = "https://hooks.gamma.example/underclerk";
const DELTA = "https://hooks.delta.example/underclerk";
const ORDER_TOPICS = ["order.*", "refund.*"];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Received = Readonly<{
  eventId: string;
  kind: string;
  at: string;
  status: number;
  signed: boolean;
  resources: readonly string[];
}>;

/** Fake endpoints: they only record posts and answer with a status. */
class Endpoints implements WebhookSender {
  readonly posts = new Map<string, Received[]>();
  readonly secrets = new Map<string, string>();
  readonly downUntil = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  async post(request: WebhookPost): Promise<WebhookPostResult> {
    const event = parseWebhookEvent(JSON.parse(request.body));
    const timestamp = request.headers["x-underclerk-timestamp"] ?? "";
    const secret = this.secrets.get(request.url) ?? "";
    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.${request.body}`)
      .digest("hex");
    const status = this.#now() < (this.downUntil.get(request.url) ?? 0) ? 503 : 200;
    const list = this.posts.get(request.url) ?? [];
    list.push({
      eventId: event.eventId,
      kind: event.kind,
      at: timestamp,
      status,
      signed: request.headers["x-underclerk-signature"] === `v1=${expected}`,
      resources: event.resources.map((item) => `${item.kind}:${item.id}`),
    });
    this.posts.set(request.url, list);
    return { kind: "response", status };
  }

  delivered(url: string): readonly Received[] {
    return (this.posts.get(url) ?? []).filter((post) => post.status === 200);
  }
}

it(
  "delivers order events to webhooks with retries, and stops for a failing endpoint",
  { timeout: 60_000 },
  deliverOrderWebhooks,
);

async function deliverOrderWebhooks(): Promise<void> {
  let clock = Date.parse(NOW);
  const now = () => new Date(clock).toISOString();
  const endpoints = new Endpoints(() => clock);
  const backend = await startBackend({ now, webhooks: endpoints });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new HookStaff(admin);
    await staff.createTea();

    // A webhook may only post to a public HTTPS address.
    for (const url of ["https://10.0.0.5/hook", "https://localhost/hook"])
      expect(await staff.subscribe(`private_${url.length}`, url, ORDER_TOPICS))
        .toMatchObject(rejectedWith({ field: "webhookSubscription.url" }));
    for (const [id, url, topics] of [
      ["alpha", ALPHA, ORDER_TOPICS],
      ["beta", BETA, ORDER_TOPICS],
      ["gamma", GAMMA, ["order.created"]],
      ["delta", DELTA, ["payment.captured"]],
    ] as const) {
      const secret = await staff.subscribeWithSecret(id, url, topics);
      endpoints.secrets.set(url, secret);
    }
    const start = (await required(admin.readEvents(merchantId))).nextCursor;
    // Beta is down for the first hour; gamma never comes back.
    endpoints.downUntil.set(BETA, clock + HOUR);
    endpoints.downUntil.set(GAMMA, Number.MAX_SAFE_INTEGER);

    // In that hour: Mio orders and staff edit the order; Kai orders three
    // tins, keeps one, and staff refund the difference.
    const mio = await Buyer.start(buyer, "mio");
    const mioOrder = await mio.buyLines([catalogLine("variant_tea_small_sencha")]);
    clock += 10 * MINUTE;
    await staff.editOrder("mio_more", mioOrder, {
      lineChanges: [],
      additions: [{ variantId: "variant_tea_small_hojicha", quantity: 1 }],
    });
    clock += 10 * MINUTE;
    const kai = await Buyer.start(buyer, "kai");
    const kaiOrder = await kai.buyLines([
      { ...catalogLine("variant_tea_small_sencha"), quantity: 3 },
    ]);
    clock += 10 * MINUTE;
    const kaiLine = await staff.lineId(kaiOrder);
    await staff.editOrder("kai_fewer", kaiOrder, {
      lineChanges: [{ orderLineId: kaiLine, quantity: 1 }],
      additions: [],
    });
    expect(await staff.refund(kaiOrder, kaiLine, 2_400, 240)).toMatchObject({
      outcome: "applied",
    });

    // The alarm runs every five minutes for three hours.
    for (let step = 0; step < 36; step += 1) {
      clock += 5 * MINUTE;
      await backend.dispatchWebhooks();
    }

    const feed = await readAll(admin, start, 3);
    const orderEvents = feed.filter((event) =>
      ORDER_TOPICS.some((topic) => webhookTopicMatches(topic, event.kind)),
    );
    expect(orderEvents.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "order.created",
        "order.edited",
        "refund.succeeded",
      ]),
    );
    // Any page size returns the same events in the same order.
    expect((await readAll(admin, start, 50)).map((event) => event.eventId)).toEqual(
      feed.map((event) => event.eventId),
    );
    const expected = orderEvents.map((event) => event.eventId);
    for (const url of [ALPHA, BETA]) {
      const delivered = endpoints.delivered(url);
      expect(delivered.map((post) => post.eventId).sort()).toEqual(
        [...expected].sort(),
      );
      expect(delivered.every((post) => post.signed)).toBe(true);
    }
    // Delta got each captured payment once, naming its payment attempt.
    const captured = feed.filter((event) => event.kind === "payment.captured");
    expect(captured).toHaveLength(2);
    expect(
      endpoints.delivered(DELTA).map((post) => [post.eventId, post.resources]),
    ).toEqual(
      captured.map((event) => [
        event.eventId,
        [expect.stringMatching(/^checkout_payment_attempt:/)],
      ]),
    );
    expect(endpoints.delivered(DELTA).every((post) => post.signed)).toBe(true);
    // Beta was refused at first and got everything once it recovered.
    const betaFailures = (endpoints.posts.get(BETA) ?? []).filter(
      (post) => post.status === 503,
    );
    expect(betaFailures.length).toBeGreaterThan(0);
    expect(
      endpoints
        .delivered(BETA)
        .every((post) => Date.parse(post.at) >= Date.parse(NOW) + HOUR),
    ).toBe(true);

    // Gamma keeps failing; after 48 hours it is `failing` and gets no posts.
    for (let hour = 0; hour < 49; hour += 1) {
      clock += HOUR;
      await backend.dispatchWebhooks();
    }
    const gammaPosts = endpoints.posts.get(GAMMA)?.length ?? 0;
    const noa = await Buyer.start(buyer, "noa");
    await noa.buyLines([catalogLine("variant_tea_small_sencha")]);
    clock += HOUR;
    await backend.dispatchWebhooks();
    expect(endpoints.posts.get(GAMMA)?.length ?? 0).toBe(gammaPosts);
    expect(endpoints.delivered(ALPHA).length).toBe(expected.length + 1);
    const subscriptions = await required(admin.listWebhookSubscriptions(merchantId));
    expect(
      subscriptions.map((item) => [item.id, item.state, item.pending > 0]),
    ).toEqual([
      ["alpha", "active", false],
      ["beta", "active", false],
      ["delta", "active", false],
      ["gamma", "failing", true],
    ]);
    expect(subscriptions.find((item) => item.id === "gamma")?.failedEvents).toBe(1);

    Object.assign(evidence, {
      receipts: staff.receipts,
      orderEvents: orderEvents.map((event) => [event.kind, event.merchantRevision]),
      deliveries: Object.fromEntries(
        [ALPHA, BETA, GAMMA, DELTA].map((url) => [
          url,
          (endpoints.posts.get(url) ?? []).map((post) => [
            post.kind,
            post.at,
            post.status,
          ]),
        ]),
      ),
      subscriptions,
    });
  } finally {
    writeEvidence("WEBHOOK_ARTIFACT_DIR", "webhooks", evidence);
    backend.close();
  }
}

async function readAll(
  admin: CommerceAdminClient,
  after: string | null,
  limit: number,
): Promise<readonly CommerceEventV1[]> {
  const events: CommerceEventV1[] = [];
  let cursor = after ?? undefined;
  for (;;) {
    const page = await required(
      admin.readEvents(merchantId, {
        ...(cursor === undefined ? {} : { after: cursor }),
        limit,
      }),
    );
    events.push(...page.events);
    if (page.nextCursor === null || page.events.length < limit) return events;
    cursor = page.nextCursor;
  }
}

class HookStaff extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "hook");
  }

  async subscribe(
    subscriptionId: string,
    url: string,
    topics: readonly string[],
  ): Promise<CommerceMutationResultV1> {
    return (await this.#create(subscriptionId, url, topics)).mutation;
  }

  async subscribeWithSecret(
    subscriptionId: string,
    url: string,
    topics: readonly string[],
  ): Promise<string> {
    const created = await this.#create(subscriptionId, url, topics);
    if (created.secret === null) throw new Error(`${subscriptionId} has no secret`);
    return created.secret;
  }

  async #create(subscriptionId: string, url: string, topics: readonly string[]) {
    const created = await required(
      this.admin.createWebhookSubscription({
        ...this.editBase(`subscribe_${subscriptionId}`),
        subscriptionId,
        url,
        topics,
      }),
    );
    this.receipts.push(
      created.mutation.outcome === "rejected"
        ? { outcome: "rejected", code: created.mutation.error.code }
        : {
            outcome: created.mutation.outcome,
            commandKind: created.mutation.receipt.commandKind,
          },
    );
    return created;
  }

  async lineId(orderId: string): Promise<string> {
    const order = (await this.snapshot()).orders.find((item) => item.id === orderId);
    const line = order?.lineItems[0];
    if (line === undefined) throw new Error(`${orderId} has no line`);
    return line.id;
  }

  async editOrder(
    editId: string,
    orderId: string,
    change: Readonly<{
      lineChanges: readonly Readonly<{ orderLineId: string; quantity: number }>[];
      additions: readonly Readonly<{ variantId: string; quantity: number }>[];
    }>,
  ): Promise<void> {
    const order = (await this.snapshot()).orders.find((item) => item.id === orderId);
    if (order === undefined) throw new Error(`${orderId} is missing`);
    await this.apply(
      this.admin.editOrder({
        ...this.editBase(`edit_${editId}`),
        editId,
        orderId,
        expectedOrderRevision: order.revision,
        ...change,
        reason: "Buyer asked by phone",
      }),
    );
  }

  async refund(
    orderId: string,
    orderLineId: string,
    lineMinor: number,
    taxMinor: number,
  ): Promise<CommerceMutationResultV1> {
    const resources = await this.snapshot();
    const order = resources.orders.find((item) => item.id === orderId);
    const payment = resources.payments.find((item) => item.orderId === orderId);
    if (order === undefined || payment === undefined)
      throw new Error(`${orderId} is incomplete`);
    return this.edit(
      this.admin.refundOrder({
        ...(await this.base("refund")),
        orderId,
        orderRevision: order.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId: "refund_webhook_kai",
        refundPolicyId: "refund_policy_standard",
        amount: jpy(lineMinor + taxMinor),
        allocation: {
          lineAllocations: [{ orderLineId, amount: jpy(lineMinor) }],
          taxAllocations: [{ orderLineId, amount: jpy(taxMinor) }],
          dutyAllocations: [],
          shippingAllocation: jpy(0),
        },
        reason: "Two tins removed",
      }),
    );
  }
}
