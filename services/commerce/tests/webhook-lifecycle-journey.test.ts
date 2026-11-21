// Plan 76A step 4B follow-up: staff restart a failing webhook subscription,
// rotate a signing secret and delete a subscription. Sora's endpoint is down
// for 59 hours: its subscription fails at the first retry after 48 hours of
// failed posts, staff restart it while the endpoint is still down, and after the endpoint recovers it gets every
// order event once, also the events of the hours when it was failing. Rin's
// secret is rotated with one hour of overlap; Rin's endpoint keeps its old
// secret for half an hour and refuses no post. A deleted subscription gets
// no more posts, and a new one with the same id starts after the newest
// event. Set WEBHOOK_LIFECYCLE_ARTIFACT_DIR to keep the run's evidence; the
// file repeats byte for byte for the same commit.
import { createHmac } from "node:crypto";

import {
  parseWebhookEvent,
  webhookTopicMatches,
  type CommerceAdminClient,
  type CommerceEventV1,
  type CommerceMutationResultV1,
  type CommerceWebhookSubscriptionV1,
} from "@purin-labs/commerce-client";
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
  merchantId,
  rejectedWith,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { TransitionMatrix } from "./transition-matrix.ts";

const SORA = "https://hooks.sora.example/commerce";
const RIN = "https://hooks.rin.example/commerce";
const TOPICS = ["order.*"];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Received = Readonly<{
  eventId: string;
  kind: string;
  at: string;
  status: number;
  signatures: number;
}>;

/**
 * Fake endpoints: each checks the signature with the one secret that it
 * holds, and answers 503 while it is down or 401 for a bad signature.
 */
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
    const timestamp = request.headers["x-commerce-timestamp"] ?? "";
    const signatures = (request.headers["x-commerce-signature"] ?? "").split(
      ",",
    );
    const expected = `v1=${createHmac(
      "sha256",
      this.secrets.get(request.url) ?? "",
    )
      .update(`${timestamp}.${request.body}`)
      .digest("hex")}`;
    const status =
      this.#now() < (this.downUntil.get(request.url) ?? 0)
        ? 503
        : signatures.includes(expected)
          ? 200
          : 401;
    const list = this.posts.get(request.url) ?? [];
    list.push({
      eventId: event.eventId,
      kind: event.kind,
      at: timestamp,
      status,
      signatures: signatures.length,
    });
    this.posts.set(request.url, list);
    return { kind: "response", status };
  }

  all(url: string): readonly Received[] {
    return this.posts.get(url) ?? [];
  }

  delivered(url: string): readonly Received[] {
    return this.all(url).filter((post) => post.status === 200);
  }
}

it(
  "restarts a failing webhook, rotates a secret with overlap, and deletes a subscription",
  { timeout: 60_000 },
  manageWebhookSubscriptions,
);

async function manageWebhookSubscriptions(): Promise<void> {
  let clock = Date.parse(NOW);
  const now = () => new Date(clock).toISOString();
  const endpoints = new Endpoints(() => clock);
  const backend = await startBackend({ now, webhooks: endpoints });
  const matrix = new TransitionMatrix(["webhook_subscription"], {
    "webhook_subscription failing fail":
      "only the alarm sends fail, and it skips a subscription that is failing",
  });
  const evidence: Evidence = { clock: NOW, merchantId };
  const tick = async (minutes: number, steps: number) => {
    for (let step = 0; step < steps; step += 1) {
      clock += minutes * MINUTE;
      await backend.dispatchWebhooks();
    }
  };
  try {
    const { admin, buyer } = backend;
    const staff = new HookDesk(admin);
    await staff.createTea();
    endpoints.secrets.set(SORA, await staff.subscribe("sora", SORA));
    endpoints.secrets.set(RIN, await staff.subscribe("rin", RIN));
    const start = (await required(admin.readEvents(merchantId))).nextCursor;
    const order = async (name: string) =>
      (await Buyer.start(buyer, name)).buyLines([
        catalogLine("variant_tea_small_sencha"),
      ]);

    // Sora's endpoint is down for 59 hours. Mio orders at once. The retry
    // delays grow to 12 hours, so the first retry after 48 hours of failed
    // posts comes at hour 56; it makes Sora's subscription fail.
    endpoints.downUntil.set(SORA, clock + 59 * HOUR);
    await order("mio");
    await tick(60, 57);
    expect(await staff.subscription("sora")).toMatchObject({
      state: "failing",
      failedEvents: 1,
    });
    matrix.observed(
      "webhook_subscription",
      "active",
      "fail",
      "applied by the alarm after 48 hours of failed posts",
    );
    // While Sora fails, Kai orders; Sora gets no post.
    const soraPostsWhileFailing = endpoints.all(SORA).length;
    await order("kai");
    await tick(5, 3);
    expect(endpoints.all(SORA)).toHaveLength(soraPostsWhileFailing);

    // Staff can restart only a failing subscription, at its revision.
    matrix.check(
      "webhook_subscription",
      "active",
      "restart",
      await staff.restart("rin", 1),
    );
    const sora = await staff.subscription("sora");
    expect(await staff.restart("sora", sora.revision - 1)).toMatchObject(
      rejectedWith({ code: "stale_resource_revision" }),
    );
    // A failing subscription takes a new secret; with no overlap, posts
    // carry only the new signature.
    const soraRotation = await staff.rotate("sora", sora.revision, 0);
    matrix.check(
      "webhook_subscription",
      "failing",
      "rotate_secret",
      soraRotation.mutation,
    );
    endpoints.secrets.set(SORA, secretOf(soraRotation.secret));
    const restarted = await staff.restart("sora", sora.revision + 1);
    matrix.check("webhook_subscription", "failing", "restart", restarted);
    expect(await staff.restart("sora", sora.revision + 1)).toMatchObject({
      outcome: "replayed",
    });

    // Sora's endpoint is still down for almost two hours. Each event that
    // Sora did not deliver has a new 48-hour window, so the retries do not
    // make it fail again; after the endpoint recovers, Sora gets Mio's
    // events and the events of the hours when it was failing.
    await tick(5, 36);
    const feed = await readAll(admin, start);
    const orderEvents = feed
      .filter((event) =>
        TOPICS.some((topic) => webhookTopicMatches(topic, event.kind)),
      )
      .map((event) => event.eventId);
    expect(await staff.subscription("sora")).toMatchObject({
      state: "active",
      failedEvents: 0,
      pending: 0,
    });
    const soraDelivered = endpoints.delivered(SORA).map((post) => post.eventId);
    expect([...soraDelivered].sort()).toEqual([...orderEvents].sort());
    const afterRestart = endpoints.all(SORA).slice(soraPostsWhileFailing);
    expect(afterRestart.some((post) => post.status === 503)).toBe(true);
    expect(afterRestart.every((post) => post.signatures === 1)).toBe(true);
    expect(endpoints.all(SORA).some((post) => post.status === 401)).toBe(false);

    // Rin's secret is rotated with one hour of overlap. Rin's endpoint
    // keeps the old secret for half an hour, then takes the new one; no
    // post is refused. After the hour, posts carry one signature.
    const rin = await staff.subscription("rin");
    expect(await staff.rotate("rin", rin.revision + 1, 3_600)).toMatchObject({
      mutation: rejectedWith({ code: "stale_resource_revision" }),
      secret: null,
    });
    const rinRotation = await staff.rotate("rin", rin.revision, 3_600);
    matrix.check(
      "webhook_subscription",
      "active",
      "rotate_secret",
      rinRotation.mutation,
    );
    const rinSecret = secretOf(rinRotation.secret);
    expect(rinSecret).not.toBe(endpoints.secrets.get(RIN));
    expect(await staff.rotate("rin", rin.revision, 3_600)).toMatchObject({
      mutation: { outcome: "replayed" },
      secret: null,
    });
    expect(await staff.subscription("rin")).toMatchObject({
      previousSecretExpiresAt: new Date(clock + HOUR).toISOString(),
    });
    const rinBefore = endpoints.all(RIN).length;
    await order("noa");
    await tick(5, 6);
    endpoints.secrets.set(RIN, rinSecret);
    await order("lea");
    await tick(5, 12);
    expect(
      (await staff.subscription("rin")).previousSecretExpiresAt,
    ).toBeNull();
    await order("uma");
    await tick(5, 2);
    const rinPosts = endpoints.all(RIN).slice(rinBefore);
    expect(rinPosts.every((post) => post.status === 200)).toBe(true);
    expect(rinPosts.map((post) => post.signatures)).toContain(2);
    expect(rinPosts.at(-1)?.signatures).toBe(1);
    const rinEvents = (await readAll(admin, start))
      .filter((event) =>
        TOPICS.some((topic) => webhookTopicMatches(topic, event.kind)),
      )
      .map((event) => event.eventId);
    expect(
      endpoints
        .delivered(RIN)
        .map((post) => post.eventId)
        .sort(),
    ).toEqual([...rinEvents].sort());

    // Rin's endpoint goes down and Yui orders. Staff delete Rin's
    // subscription with its pending posts: Rin gets no more posts.
    endpoints.downUntil.set(RIN, Number.MAX_SAFE_INTEGER);
    await order("yui");
    await tick(5, 2);
    const rinNow = await staff.subscription("rin");
    expect(rinNow.pending).toBeGreaterThan(0);
    expect(await staff.remove("rin", rinNow.revision - 1)).toMatchObject(
      rejectedWith({ code: "stale_resource_revision" }),
    );
    expect(await staff.remove("rin", rinNow.revision)).toMatchObject({
      outcome: "applied",
    });
    expect(await staff.remove("rin", rinNow.revision + 1)).toMatchObject(
      rejectedWith({ code: "resource_not_found" }),
    );
    const rinPostsAtDelete = endpoints.all(RIN).length;
    await tick(60, 3);
    expect(endpoints.all(RIN)).toHaveLength(rinPostsAtDelete);
    expect((await staff.list()).map((item) => item.id)).toEqual(["sora"]);

    // A new subscription with the same id gets a new secret and starts
    // after the newest event: Yui's events are in the feed, not posted.
    endpoints.downUntil.delete(RIN);
    endpoints.secrets.set(RIN, await staff.subscribe("rin", RIN, "again"));
    await tick(5, 2);
    expect(endpoints.all(RIN)).toHaveLength(rinPostsAtDelete);
    await order("hana");
    await tick(5, 2);
    const newRin = endpoints.all(RIN).slice(rinPostsAtDelete);
    expect(newRin.length).toBeGreaterThan(0);
    expect(newRin.every((post) => post.status === 200)).toBe(true);

    const subscriptionEvents = (await readAll(admin, null))
      .filter((event) => event.kind.startsWith("webhook_subscription."))
      .map((event) => [
        event.kind,
        event.resources.map((item) => `${item.id}@${item.revision}`),
      ]);
    expect(subscriptionEvents).toEqual([
      ["webhook_subscription.created", ["sora@1"]],
      ["webhook_subscription.created", ["rin@1"]],
      ["webhook_subscription.secret_rotated", ["sora@3"]],
      ["webhook_subscription.restarted", ["sora@4"]],
      ["webhook_subscription.secret_rotated", ["rin@2"]],
      ["webhook_subscription.deleted", ["rin@3"]],
      ["webhook_subscription.created", ["rin@1"]],
    ]);

    const report = matrix.report();
    expect(report.unexplained).toEqual([]);
    expect(report.stalePatterns).toEqual([]);
    Object.assign(evidence, {
      receipts: staff.receipts,
      subscriptionEvents,
      deliveries: Object.fromEntries(
        [SORA, RIN].map((url) => [
          url,
          endpoints
            .all(url)
            .map((post) => [post.kind, post.at, post.status, post.signatures]),
        ]),
      ),
      subscriptions: await staff.list(),
      matrix: report,
    });
  } finally {
    writeEvidence(
      "WEBHOOK_LIFECYCLE_ARTIFACT_DIR",
      "webhook-lifecycle",
      evidence,
    );
    backend.close();
  }
}

async function readAll(
  admin: CommerceAdminClient,
  after: string | null,
): Promise<readonly CommerceEventV1[]> {
  const events: CommerceEventV1[] = [];
  let cursor = after ?? undefined;
  for (;;) {
    const page = await required(
      admin.readEvents(merchantId, {
        ...(cursor === undefined ? {} : { after: cursor }),
        limit: 100,
      }),
    );
    events.push(...page.events);
    if (page.nextCursor === null || page.events.length < 100) return events;
    cursor = page.nextCursor;
  }
}

function secretOf(secret: string | null): string {
  if (secret === null) throw new Error("The answer has no secret");
  return secret;
}

class HookDesk extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "hook");
  }

  async subscribe(
    subscriptionId: string,
    url: string,
    attempt = "first",
  ): Promise<string> {
    const created = await required(
      this.admin.createWebhookSubscription({
        ...this.#base(`subscribe_${subscriptionId}_${attempt}`),
        subscriptionId,
        url,
        topics: TOPICS,
      }),
    );
    this.#record(created.mutation);
    return secretOf(created.secret);
  }

  async restart(
    subscriptionId: string,
    expectedRevision: number,
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.restartWebhookSubscription({
        ...this.#base(`restart_${subscriptionId}_${expectedRevision}`),
        subscriptionId,
        expectedRevision,
      }),
    );
  }

  async rotate(
    subscriptionId: string,
    expectedRevision: number,
    keepPreviousSecretSeconds: number,
  ) {
    const rotated = await required(
      this.admin.rotateWebhookSecret({
        ...this.#base(`rotate_${subscriptionId}_${expectedRevision}`),
        subscriptionId,
        expectedRevision,
        keepPreviousSecretSeconds,
      }),
    );
    this.#record(rotated.mutation);
    return rotated;
  }

  async remove(
    subscriptionId: string,
    expectedRevision: number,
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.deleteWebhookSubscription({
        ...this.#base(`delete_${subscriptionId}_${expectedRevision}`),
        subscriptionId,
        expectedRevision,
      }),
    );
  }

  async list(): Promise<readonly CommerceWebhookSubscriptionV1[]> {
    return required(this.admin.listWebhookSubscriptions(merchantId));
  }

  async subscription(id: string): Promise<CommerceWebhookSubscriptionV1> {
    const found = (await this.list()).find((item) => item.id === id);
    if (found === undefined) throw new Error(`${id} is missing`);
    return found;
  }

  #base(key: string) {
    return this.editBase(key);
  }

  #record(mutation: CommerceMutationResultV1): void {
    this.receipts.push(
      mutation.outcome === "rejected"
        ? { outcome: "rejected", code: mutation.error.code }
        : {
            outcome: mutation.outcome,
            commandKind: mutation.receipt.commandKind,
          },
    );
  }
}
