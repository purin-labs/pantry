// Plan 76A step 5: a merchant sells one order a month for fourteen months.
// The archive moves the finished orders older than 180 days and the
// acknowledged events older than 90 days to files that never change. Orders
// read the same from the archive; the event feed is unchanged; a run that
// stops after the upload writes no new file when it runs again. A webhook
// delivery that died before the archive moved its event ends `gone` when
// staff restart the subscription: it is not posted and not due again. Set
// ARCHIVE_ARTIFACT_DIR to keep the run's evidence; the file repeats byte for
// byte for the same commit.
import { clientInput } from "./command-input.ts";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import type {
  CommerceAdminClient,
  CommerceEventV1,
  CommerceOrderRecordV1,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import type { ArchiveStore } from "../src/archive.ts";
import type { WebhookPost, WebhookPostResult } from "../src/webhooks.ts";
import {
  Buyer,
  StaffDesk,
  catalogLine,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const START = Date.parse("2025-06-02T01:00:00.000Z");
const MONTH = 30 * 24 * 60 * 60 * 1_000;

/** An in-memory R2: it only stores bytes and counts writes. */
class MemoryArchive implements ArchiveStore {
  readonly objects = new Map<string, Readonly<{ body: Uint8Array; sha256: string }>>();
  readonly writes = new Map<string, number>();
  /** The next write of a matching key stores the bytes, then fails. */
  loseResponseFor: RegExp | undefined;

  async head(key: string) {
    const object = this.objects.get(key);
    return object === undefined
      ? null
      : { sha256: object.sha256, size: object.body.length };
  }

  async put(key: string, body: Uint8Array, sha256: string): Promise<void> {
    this.objects.set(key, { body: new Uint8Array(body), sha256 });
    this.writes.set(key, (this.writes.get(key) ?? 0) + 1);
    if (this.loseResponseFor?.test(key) === true) {
      this.loseResponseFor = undefined;
      throw new Error("connection lost after the write");
    }
  }

  async read(key: string, offset: number, length: number) {
    return this.objects.get(key)?.body.slice(offset, offset + length) ?? null;
  }
}

it(
  "archives finished orders and old events, and reads them back unchanged",
  { timeout: 120_000 },
  archiveOldRecords,
);

async function archiveOldRecords(): Promise<void> {
  let clock = START;
  const now = () => new Date(clock).toISOString();
  const archive = new MemoryArchive();
  const backend = await startBackend({ now, archive });
  const evidence: Evidence = { start: now(), merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new ArchiveStaff(admin, now);
    await staff.createTea();

    // One order a month. Months 2 and 9 are cancelled; the last stays open.
    const orderIds: string[] = [];
    for (let month = 0; month < 14; month += 1) {
      clock = START + month * MONTH;
      const order = await (await Buyer.start(buyer, `buyer_${month}`)).buyLines([
        catalogLine("variant_tea_small_sencha"),
      ]);
      orderIds.push(order);
      if (month === 2 || month === 9) await staff.cancel(order);
      else if (month !== 13) await staff.collect(order);
    }
    clock = START + 14 * MONTH;
    // Platform acknowledges what it has read; only acknowledged events move.
    await staff.acknowledgeDeliveries();

    const before = new Map<string, CommerceOrderRecordV1>();
    for (const orderId of orderIds)
      before.set(orderId, await required(admin.readOrderRecord(merchantId, orderId)));
    const feedBefore = await readFeed(admin);
    const liveBefore = (await required(admin.readSnapshot(merchantId))).resources
      .orders.length;

    // The first run stops after an upload and before its commit.
    archive.loseResponseFor = /\/orders\/.*\.ndjson\.gz$/;
    expect((await admin.runArchive(merchantId)).ok).toBe(false);
    const firstFile = [...archive.writes.keys()][0];
    const run = await required(admin.runArchive(merchantId));
    // The interrupted file is found in R2 and reused, not written again.
    expect(archive.writes.get(firstFile ?? "")).toBe(1);
    expect(run.files.find((file) => file.fileKey === firstFile)?.written).toBe(false);
    expect(run.orders).toBeGreaterThan(0);
    expect(run.events).toBeGreaterThan(0);

    // Orders whose last change is older than 180 days left the DO.
    const live = (await required(admin.readSnapshot(merchantId))).resources.orders;
    expect(live.length).toBe(liveBefore - run.orders);
    const archivedIds = orderIds.filter(
      (orderId) => !live.some((order) => order.id === orderId),
    );
    expect(archivedIds.length).toBe(run.orders);
    expect(archivedIds).toContain(orderIds[0]);
    expect(archivedIds).toContain(orderIds[2]);
    // A recent finished order and the open order stay live.
    expect(archivedIds).not.toContain(orderIds[12]);
    expect(archivedIds).not.toContain(orderIds[13]);
    // Each order reads the same, now from the archive.
    for (const orderId of orderIds) {
      const after = await required(admin.readOrderRecord(merchantId, orderId));
      const archived = archivedIds.includes(orderId);
      expect(after.source).toBe(archived ? "archived" : "live");
      expect({ ...after, source: "live", archive: null }).toEqual(before.get(orderId));
    }
    // The feed returns the same events in the same order.
    const feedAfter = await readFeed(admin);
    expect(feedAfter).toEqual(feedBefore);
    // Every file is complete: its index digests match its gzip members.
    for (const file of run.files) {
      const body = archive.objects.get(file.fileKey)?.body;
      const index = archive.objects.get(`${file.fileKey}.index.json`)?.body;
      if (body === undefined || index === undefined)
        throw new Error(`${file.fileKey} is missing`);
      expect(sha256(body)).toBe(file.sha256);
      const entries = JSON.parse(Buffer.from(index).toString("utf8")) as {
        offset: number;
        length: number;
        sha256: string;
      }[];
      expect(entries.length).toBe(file.records);
      for (const entry of entries) {
        const member = body.slice(entry.offset, entry.offset + entry.length);
        expect(sha256(member)).toBe(entry.sha256);
        JSON.parse(gunzipSync(member).toString("utf8"));
      }
    }
    // A later run with nothing new writes no file.
    const writes = archive.writes.size;
    expect((await required(admin.runArchive(merchantId))).files).toEqual([]);
    expect(archive.writes.size).toBe(writes);

    Object.assign(evidence, {
      run,
      archivedOrders: archivedIds.map((orderId) => orderIds.indexOf(orderId)),
      events: feedAfter.length,
      files: [...archive.objects.entries()].map(([key, object]) => [
        key,
        object.sha256,
      ]),
    });
  } finally {
    writeEvidence("ARCHIVE_ARTIFACT_DIR", "archive", evidence);
    backend.close();
  }
}

it(
  "ends a dead webhook delivery whose event was archived as gone",
  { timeout: 120_000 },
  restartAfterArchive,
);

/** An endpoint that is down: it counts the posts and answers 503. */
class DownEndpoint {
  readonly posts: string[] = [];

  async post(request: WebhookPost): Promise<WebhookPostResult> {
    this.posts.push(request.headers["x-underclerk-event-id"] ?? "");
    return { kind: "response", status: 503 };
  }
}

async function restartAfterArchive(): Promise<void> {
  let clock = START;
  const now = () => new Date(clock).toISOString();
  const endpoint = new DownEndpoint();
  const backend = await startBackend({
    now,
    archive: new MemoryArchive(),
    webhooks: endpoint,
  });
  const evidence: Evidence = { start: now(), merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new ArchiveStaff(admin, now);
    await staff.createTea();
    await staff.subscribe("sora");
    const order = await (await Buyer.start(buyer, "buyer_hook")).buyLines([
      catalogLine("variant_tea_small_sencha"),
    ]);
    await staff.collect(order);

    // The endpoint stays down; after 48 hours of failed posts the events
    // are dead and the subscription fails.
    for (let hour = 0; hour < 60; hour += 1) {
      clock += 60 * 60 * 1_000;
      await backend.dispatchWebhooks();
    }
    const failing = await staff.subscription("sora");
    expect(failing).toMatchObject({ state: "failing", pending: 0 });
    expect(failing.failedEvents).toBeGreaterThan(0);

    // Four months later the archive moves the acknowledged events, the dead
    // ones too. Staff restart the subscription: each delivery whose event is
    // gone ends, so nothing is posted and nothing stays due.
    clock = START + 4 * MONTH;
    await staff.acknowledgeDeliveries();
    const run = await required(admin.runArchive(merchantId));
    expect(run.events).toBeGreaterThan(0);
    expect(await staff.restart("sora", failing.revision)).toMatchObject({
      outcome: "applied",
    });
    const posts = endpoint.posts.length;
    const nextAttemptAt = await backend.dispatchWebhooks();
    clock += 60 * 60 * 1_000;
    await backend.dispatchWebhooks();
    const restarted = await staff.subscription("sora");
    expect({ nextAttemptAt, posted: endpoint.posts.length - posts }).toEqual({
      nextAttemptAt: null,
      posted: 0,
    });
    expect(restarted).toMatchObject({
      state: "active",
      pending: 0,
      failedEvents: failing.failedEvents,
    });
    Object.assign(evidence, {
      archivedEvents: run.events,
      failing: { ...failing, occurredAt: null },
      restarted: { ...restarted, occurredAt: null },
    });
  } finally {
    writeEvidence("ARCHIVE_ARTIFACT_DIR", "archive-webhook-gone", evidence);
    backend.close();
  }
}

async function readFeed(admin: CommerceAdminClient) {
  const events: CommerceEventV1[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await required(
      admin.readEvents(merchantId, {
        ...(after === undefined ? {} : { after }),
        limit: 50,
      }),
    );
    events.push(...page.events);
    if (page.nextCursor === null || page.events.length < 50) return events;
    after = page.nextCursor;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class ArchiveStaff extends StaffDesk {
  readonly #now: () => string;

  constructor(admin: CommerceAdminClient, now: () => string) {
    super(admin, "archive");
    this.#now = now;
  }

  async #at(name: string) {
    return { ...(await this.base(name)), requestedAt: this.#now() };
  }

  async #target(orderId: string, name: string) {
    const resources = await this.snapshot();
    const order = resources.orders.find((item) => item.id === orderId);
    const fulfillment = resources.fulfillments.find((item) => item.orderId === orderId);
    const payment = resources.payments.find((item) => item.orderId === orderId);
    if (order === undefined || fulfillment === undefined || payment === undefined)
      throw new Error(`${orderId} is incomplete`);
    return {
      base: {
        ...(await this.#at(name)),
        orderId,
        orderRevision: order.revision,
        fulfillmentId: fulfillment.id,
        fulfillmentRevision: fulfillment.revision,
      },
      payment,
    };
  }

  async collect(orderId: string): Promise<void> {
    const ready = await this.#target(orderId, "ready");
    await this.apply(
      this.admin.markPickupReady({
        ...clientInput(ready.base),
      }),
    );
    const complete = await this.#target(orderId, "complete");
    await this.apply(
      this.admin.completePickup({
        ...clientInput(complete.base),
        paymentId: complete.payment.id,
        paymentRevision: complete.payment.revision,
      }),
    );
  }

  async cancel(orderId: string): Promise<void> {
    const target = await this.#target(orderId, "cancel");
    await this.apply(
      this.admin.cancelOrder({
        ...clientInput(target.base),
        paymentId: target.payment.id,
        paymentRevision: target.payment.revision,
        refundAttemptId: `refund_cancel_${orderId.slice(-8)}`,
        reason: "Buyer cancelled",
      }),
    );
  }

  async subscribe(subscriptionId: string): Promise<void> {
    const created = await required(
      this.admin.createWebhookSubscription({
        ...this.editBase(`subscribe_${subscriptionId}`),
        subscriptionId,
        url: "https://hooks.sora.example/underclerk",
        topics: ["order.*"],
      }),
    );
    if (created.mutation.outcome !== "applied")
      throw new Error(`The subscription did not apply: ${created.mutation.outcome}`);
  }

  restart(subscriptionId: string, expectedRevision: number) {
    return this.edit(
      this.admin.restartWebhookSubscription({
        ...this.editBase(`restart_${subscriptionId}_${expectedRevision}`),
        subscriptionId,
        expectedRevision,
      }),
    );
  }

  async subscription(subscriptionId: string) {
    const found = (
      await required(this.admin.listWebhookSubscriptions(merchantId))
    ).find((item) => item.id === subscriptionId);
    if (found === undefined) throw new Error(`${subscriptionId} is missing`);
    return found;
  }

  /** A feed reader applies every event and moves its cursor past them. */
  async acknowledgeDeliveries(): Promise<void> {
    const reader = "archive-journey";
    let cursor = (
      await required(this.admin.readFeedConsumer(merchantId, reader))
    ).cursor;
    for (;;) {
      const page = await required(
        this.admin.readEvents(merchantId, { after: cursor, limit: 100 }),
      );
      const last = page.events.at(-1);
      if (last === undefined) break;
      cursor = last.cursor;
    }
    await required(this.admin.advanceFeedConsumer(merchantId, reader, cursor));
  }
}
