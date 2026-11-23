/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import {
  createCueQueueMessage,
  cueSnapshotKey,
  matchCueSubscriptions,
  parseCueQueueMessage,
  parseCueSnapshot,
  renderCueProposal,
  type CommerceCancellationRefundProposedCueEvent,
  type CommerceDeliveryExceptionCueEvent,
  type CueQueueMessage,
  type CueSnapshot,
  type StripeChargeFailedCueEvent,
  type TierOneCueSubscription,
} from "@purin-labs/agent/cues/engine";
import {
  addIgnoredCueToBatch,
  type IgnoredCueAggregate,
} from "@purin-labs/agent/cues/ignore-aggregate";
import {
  claimCueDelivery,
  completeClaimedCueDelivery,
  createCueDeliverySchema,
  type CueClaimInput,
} from "@purin-labs/agent/actors/cue-delivery";
import {
  parseChannelId,
  parseIntegrationAccountId,
  parseOrganisationId,
  parseThreadKey,
  parseWorkspaceId,
} from "@purin-labs/kernel/ids";
import {
  processCueQueueBatch,
  type CueMutationAuthorization,
  type CueMatchedDelivery,
  type CueSettlement,
} from "@purin-labs/agent/cues/queue-consumer";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { requireRequestId } from "./test-ids";

const CUE_FLOOD_SIZE = 1_000;

describe("MVP cue engine", function cueEngineSuite() {
  it(
    "rejects queued work without its admission timestamp",
    rejectsLegacyCueQueueMessage,
  );
  it("matches a compiled KV snapshot and renders one failed-payment proposal", function matchesSnapshot() {
    const organisationId = requireOrganisationId();
    const snapshot = parseCueSnapshot({
      organisationId,
      version: 1,
      createdAt: 1_000,
      subscriptions: [subscriptionFixture(organisationId)],
    });
    const event = eventFixture(organisationId, "evt_1");

    if (!snapshot.ok) {
      throw new Error(snapshot.error.code);
    }

    const matched = matchCueSubscriptions(snapshot.value, event);

    const subscription = matched[0];

    if (subscription === undefined) {
      throw new Error("cue subscription did not match");
    }

    expect(matched).toHaveLength(1);
    expect(renderCueProposal(subscription, event)).toContain("ch_failed_1");
  });

  it("renders a cancellation/refund proposal as approval-gated commerce work", function rendersApprovalGate() {
    const organisationId = requireOrganisationId();
    const event = cancellationRefundEventFixture(organisationId);
    const subscription = commerceSubscriptionFixture(organisationId);

    const rendered = renderCueProposal(subscription, event);

    expect(rendered).toContain("order_cancel_fixture");
    expect(rendered).toContain("$425.00");
    expect(rendered).toContain(
      "Approval is required before any provider effect.",
    );
  });

  it(
    "routes one delayed-shipment proposal to its configured Slack destination",
    routesDelayedShipment,
  );

  it("deduplicates delivery and enforces debounce in the organisation single writer", function fencesDelivery() {
    const organisationId = requireOrganisationId();
    const sqlite = emptySqliteFixture();
    const sql = sqlStorage(sqlite.storage);
    createCueDeliverySchema(sql);
    const first = claimCueDelivery(
      sql,
      claimInput(organisationId, "evt_1", 1_000),
    );

    if (!first.ok || first.value.kind !== "claimed") {
      throw new Error("first cue claim failed");
    }

    expect(
      completeClaimedCueDelivery(sql, {
        organisationId,
        cueId: first.value.cueId,
        leaseId: first.value.leaseId,
        outcome: "proposed",
        now: 1_100,
      }),
    ).toEqual({ ok: true, value: null });
    expect(
      claimCueDelivery(sql, claimInput(organisationId, "evt_1", 1_200)),
    ).toEqual({
      ok: true,
      value: { kind: "duplicate", cueId: first.value.cueId },
    });
    expect(
      claimCueDelivery(sql, claimInput(organisationId, "evt_2", 1_300)),
    ).toMatchObject({
      ok: true,
      value: { kind: "suppressed", reason: "debounce" },
    });
  });

  it("aggregates ignored events with bounded samples", function aggregatesIgnoredEvents() {
    const organisationId = requireOrganisationId();
    const batch = new Map<string, IgnoredCueAggregate>();

    addIgnoredCueToBatch(
      batch,
      eventFixture(organisationId, "evt_1"),
      4_000_000,
    );
    addIgnoredCueToBatch(
      batch,
      eventFixture(organisationId, "evt_2"),
      4_000_001,
    );
    addIgnoredCueToBatch(
      batch,
      eventFixture(organisationId, "evt_3"),
      4_000_002,
    );
    addIgnoredCueToBatch(
      batch,
      eventFixture(organisationId, "evt_4"),
      4_000_003,
    );

    const aggregate = batch.values().next().value;

    expect(batch.size).toBe(1);
    expect(aggregate).toMatchObject({ count: 4, updatedAt: 4_000_003 });
    expect(aggregate?.samples).toHaveLength(3);
  });

  it("keeps a non-matching event flood on Queue and KV", async function isolatesIgnoredFlood() {
    const organisationId = requireOrganisationId();
    const snapshot: CueSnapshot = {
      organisationId,
      version: 1,
      subscriptions: [nonMatchingSubscriptionFixture(organisationId)],
      createdAt: 1_000,
    };
    const kv = new CueFloodKv(cueSnapshotKey(organisationId), snapshot);
    const messages: CueFloodMessage[] = [];
    const deliveryContext = { kind: "forbidden" } as const;

    for (let index = 0; index < CUE_FLOOD_SIZE; index += 1) {
      const requestId = requireRequestId(`request_cue_flood_${index}`);
      const event = eventFixture(organisationId, `evt_flood_${index}`);
      messages.push(
        new CueFloodMessage(
          `message_cue_flood_${index}`,
          createCueQueueMessage({ requestId, receivedAt: 1_000, event }),
        ),
      );
    }

    await processCueQueueBatch({
      messages,
      kv,
      deliveryContext,
      authorizeMutation: authorizeCueFloodDelivery,
      deliverMatched: rejectMatchedCueFloodDelivery,
      settle: settleCueFloodDelivery,
      retryDelaySeconds: 30,
      now: cueFloodNow,
    });

    let acknowledged = 0;
    let retried = 0;

    for (const message of messages) {
      acknowledged += message.acknowledged ? 1 : 0;
      retried += message.retried ? 1 : 0;
    }

    expect(acknowledged).toBe(CUE_FLOOD_SIZE);
    expect(retried).toBe(0);
    expect(kv.snapshotReads).toBe(CUE_FLOOD_SIZE);
    expect(kv.aggregateReads).toBe(1);
    expect(kv.puts).toHaveLength(1);
    expect(JSON.parse(kv.requiredPut().value)).toMatchObject({
      organisationId,
      source: "stripe",
      eventType: "charge.failed",
      count: CUE_FLOOD_SIZE,
    });
  });

  it("drops matched queued work before delivery when authority is unavailable", async function dropsUnauthorizedCue() {
    const organisationId = requireOrganisationId();
    const snapshot: CueSnapshot = {
      organisationId,
      version: 1,
      subscriptions: [subscriptionFixture(organisationId)],
      createdAt: 1_000,
    };
    const message = new CueFloodMessage(
      "message_cue_inherited_runtime",
      createCueQueueMessage({
        requestId: requireRequestId("request_cue_inherited_runtime"),
        receivedAt: 1_000,
        event: eventFixture(organisationId, "evt_inherited_runtime"),
      }),
    );

    await processCueQueueBatch({
      messages: [message],
      kv: new CueFloodKv(cueSnapshotKey(organisationId), snapshot),
      deliveryContext: { kind: "forbidden" } as const,
      authorizeMutation: dropMatchedCueAuthorization,
      deliverMatched: rejectMatchedCueFloodDelivery,
      settle: settleCueFloodDelivery,
      retryDelaySeconds: 30,
      now: cueFloodNow,
    });

    expect(message.acknowledged).toBe(true);
    expect(message.retried).toBe(false);
  });

  it("acknowledges malformed cue messages so poison work cannot retry forever", async function acknowledgesMalformedCue() {
    const organisationId = requireOrganisationId();
    const message = new CueFloodMessage("message_invalid_cue", {
      type: "cue.event.v1",
      requestId: "request_invalid_cue",
      receivedAt: 1_000,
      event: {
        source: "commerce",
        eventType: "inventory_low_stock",
        payload: {},
      },
    });

    await processCueQueueBatch({
      messages: [message],
      kv: new CueFloodKv("unused", {
        organisationId,
        version: 1,
        subscriptions: [],
        createdAt: 1_000,
      }),
      deliveryContext: { kind: "forbidden" } as const,
      authorizeMutation: dropMatchedCueAuthorization,
      deliverMatched: rejectMatchedCueFloodDelivery,
      settle: settleCueFloodDelivery,
      retryDelaySeconds: 30,
      now: cueFloodNow,
    });

    expect(message.acknowledged).toBe(true);
    expect(message.retried).toBe(false);
  });

  it("drops ignored queued work before writing its aggregate when authority is unavailable", async function dropsUnauthorizedIgnoredCue() {
    const organisationId = requireOrganisationId();
    const snapshot: CueSnapshot = {
      organisationId,
      version: 1,
      subscriptions: [nonMatchingSubscriptionFixture(organisationId)],
      createdAt: 1_000,
    };
    const kv = new CueFloodKv(cueSnapshotKey(organisationId), snapshot);
    const message = new CueFloodMessage(
      "message_cue_ignored_inherited_runtime",
      createCueQueueMessage({
        requestId: requireRequestId("request_cue_ignored_inherited_runtime"),
        receivedAt: 1_000,
        event: eventFixture(organisationId, "evt_ignored_inherited_runtime"),
      }),
    );

    await processCueQueueBatch({
      messages: [message],
      kv,
      deliveryContext: { kind: "forbidden" } as const,
      authorizeMutation: dropMatchedCueAuthorization,
      deliverMatched: rejectMatchedCueFloodDelivery,
      settle: settleCueFloodDelivery,
      retryDelaySeconds: 30,
      now: cueFloodNow,
    });

    expect(message.acknowledged).toBe(true);
    expect(message.retried).toBe(false);
    expect(kv.puts).toHaveLength(0);
  });
});

function rejectsLegacyCueQueueMessage(): void {
  const organisationId = requireOrganisationId();

  expect(
    parseCueQueueMessage({
      type: "cue.event.v1",
      requestId: requireRequestId("request_cue_missing_admission"),
      event: eventFixture(organisationId, "evt_missing_admission"),
    }),
  ).toEqual({
    ok: false,
    error: { code: "invalid_field", field: "receivedAt" },
  });
}

class CueFloodMessage implements Message<unknown> {
  readonly timestamp = new Date(1_000);
  readonly attempts = 1;
  acknowledged = false;
  retried = false;

  constructor(
    readonly id: string,
    readonly body: unknown,
  ) {}

  ack(): void {
    this.acknowledged = true;
  }

  retry(_options?: QueueRetryOptions): void {
    this.retried = true;
  }
}

class CueFloodKv {
  readonly puts: { key: string; value: string; expirationTtl: number }[] = [];
  snapshotReads = 0;
  aggregateReads = 0;

  constructor(
    private readonly snapshotKey: string,
    private readonly snapshot: CueSnapshot,
  ) {}

  async get(key: string, type: "json"): Promise<unknown | null> {
    if (type !== "json") {
      throw new Error(`unexpected_kv_type:${type}`);
    }

    if (key === this.snapshotKey) {
      this.snapshotReads += 1;
      return this.snapshot;
    }

    if (key.startsWith("cue-ignore:")) {
      this.aggregateReads += 1;
      return null;
    }

    throw new Error(`unexpected_kv_read:${key}`);
  }

  async put(
    key: string,
    value: string,
    options: { expirationTtl: number },
  ): Promise<void> {
    if (!key.startsWith("cue-ignore:")) {
      throw new Error(`unexpected_kv_write:${key}`);
    }

    this.puts.push({ key, value, expirationTtl: options.expirationTtl });
  }

  requiredPut(): { key: string; value: string; expirationTtl: number } {
    const put = this.puts[0];

    if (put === undefined) {
      throw new Error("cue_flood_aggregate_missing");
    }

    return put;
  }
}

const rejectMatchedCueFloodDelivery: CueMatchedDelivery<{
  readonly kind: "forbidden";
}> = rejectMatchedCueFlood;

// The flood journeys read no cue source, so settling has nothing to record.
const settleCueFloodDelivery: CueSettlement<{
  readonly kind: "forbidden";
}> = async () => {};

const authorizeCueFloodDelivery: CueMutationAuthorization<{
  readonly kind: "forbidden";
}> = authorizeCueFlood;

const dropMatchedCueAuthorization: CueMutationAuthorization<{
  readonly kind: "forbidden";
}> = dropMatchedCue;

async function authorizeCueFlood(): Promise<{ readonly kind: "authorized" }> {
  return { kind: "authorized" };
}

async function dropMatchedCue(): Promise<{ readonly kind: "drop" }> {
  return { kind: "drop" };
}

async function rejectMatchedCueFlood(
  _context: { readonly kind: "forbidden" },
  _message: CueQueueMessage,
  _subscriptions: readonly TierOneCueSubscription[],
): Promise<never> {
  throw new Error("non_matching_cue_entered_d1_and_durable_object_delivery");
}

function cueFloodNow(): number {
  return 4_000_000;
}

function claimInput(
  organisationId: ReturnType<typeof requireOrganisationId>,
  nativeId: string,
  now: number,
): CueClaimInput {
  return {
    organisationId,
    subscriptionId: "stripe-charge-failed-main",
    source: "stripe",
    nativeId,
    debounceMs: 5_000,
    maxPerHour: 4,
    now,
    leaseDurationMs: 30_000,
  };
}

function subscriptionFixture(
  organisationId: ReturnType<typeof requireOrganisationId>,
): TierOneCueSubscription {
  const workspaceId = parseWorkspaceId("T0BGQSSG45N");
  const channelId = parseChannelId("C0BG0P4JF25");
  const threadKey = parseThreadKey("slack:T0BGQSSG45N:C0BG0P4JF25:channel");

  if (!workspaceId.ok || !channelId.ok || !threadKey.ok) {
    throw new Error("invalid cue surface fixture");
  }

  return {
    subscriptionId: "stripe-charge-failed-main",
    organisationId,
    version: 1,
    surfaceScope: {
      kind: "slack",
      workspaceId: workspaceId.value,
      channelId: channelId.value,
      threadKey: threadKey.value,
    },
    source: "stripe",
    eventType: "charge.failed",
    action: {
      kind: "propose",
      template: "A Stripe charge failed.",
      delivery: { kind: "immediate" },
    },
    tier: 1,
    debounceMs: 5_000,
    maxPerHour: 4,
    enabled: true,
  };
}

function nonMatchingSubscriptionFixture(
  organisationId: ReturnType<typeof requireOrganisationId>,
): TierOneCueSubscription {
  const matching = subscriptionFixture(organisationId);

  return {
    subscriptionId: "stripe-refund-failed-main",
    organisationId: matching.organisationId,
    version: matching.version,
    surfaceScope: matching.surfaceScope,
    source: "stripe",
    eventType: "refund.failed",
    action: matching.action,
    tier: matching.tier,
    debounceMs: matching.debounceMs,
    maxPerHour: matching.maxPerHour,
    enabled: matching.enabled,
  };
}

function commerceSubscriptionFixture(
  organisationId: ReturnType<typeof requireOrganisationId>,
): TierOneCueSubscription {
  const matching = subscriptionFixture(organisationId);

  return {
    subscriptionId: "commerce-cancellation-refund-main",
    organisationId: matching.organisationId,
    version: matching.version,
    surfaceScope: matching.surfaceScope,
    source: "commerce",
    eventType: "cancellation_refund_proposed",
    action: {
      kind: "propose",
      template: "A cancellation and refund is proposed.",
      delivery: { kind: "immediate" },
    },
    tier: matching.tier,
    debounceMs: matching.debounceMs,
    maxPerHour: matching.maxPerHour,
    enabled: matching.enabled,
  };
}

function routesDelayedShipment(): void {
  const organisationId = requireOrganisationId();
  const event = deliveryExceptionEventFixture(organisationId);
  const subscription = deliveryExceptionSubscriptionFixture(organisationId);
  const snapshot = parseCueSnapshot({
    organisationId,
    version: 1,
    createdAt: 1_000,
    subscriptions: [subscription],
  });

  if (!snapshot.ok) {
    throw new Error(snapshot.error.code);
  }

  const matched = matchCueSubscriptions(snapshot.value, event);

  expect(matched).toEqual([subscription]);
}

function deliveryExceptionSubscriptionFixture(
  organisationId: ReturnType<typeof requireOrganisationId>,
): TierOneCueSubscription {
  const matching = subscriptionFixture(organisationId);

  return {
    subscriptionId: "commerce-delivery-exception-main",
    organisationId: matching.organisationId,
    version: matching.version,
    surfaceScope: matching.surfaceScope,
    source: "commerce",
    eventType: "delivery_exception",
    action: {
      kind: "propose",
      template: "A shipment needs operator attention.",
      delivery: { kind: "immediate" },
    },
    tier: matching.tier,
    debounceMs: matching.debounceMs,
    maxPerHour: matching.maxPerHour,
    enabled: matching.enabled,
  };
}

function deliveryExceptionEventFixture(
  organisationId: ReturnType<typeof requireOrganisationId>,
): CommerceDeliveryExceptionCueEvent {
  return {
    organisationId,
    integrationAccountId: requireIntegrationAccountId(),
    source: "commerce",
    nativeId: "commerce:event_delayed_fixture:delivery_exception:1",
    eventType: "delivery_exception",
    payload: {
      orderId: "order_delayed_fixture",
      shipmentId: "shipment_delayed_fixture",
      trackingNumber: "PANTRY-LAB-DELAYED-001",
      status: "delivery_exception",
      reason: "weather_delay",
    },
    at: 1_000,
  };
}

function cancellationRefundEventFixture(
  organisationId: ReturnType<typeof requireOrganisationId>,
): CommerceCancellationRefundProposedCueEvent {
  return {
    organisationId,
    integrationAccountId: requireIntegrationAccountId(),
    source: "commerce",
    nativeId: "commerce:event_cancel_fixture:cancellation_refund_proposed:1",
    eventType: "cancellation_refund_proposed",
    payload: {
      orderId: "order_cancel_fixture",
      paymentId: "payment_cancel_fixture",
      amountMinor: 42_500,
      currency: "USD",
      reason: "customer_requested",
    },
    at: 1_000,
  };
}

function eventFixture(
  organisationId: ReturnType<typeof requireOrganisationId>,
  nativeId: string,
): StripeChargeFailedCueEvent {
  return {
    organisationId,
    integrationAccountId: requireIntegrationAccountId(),
    source: "stripe",
    nativeId,
    eventType: "charge.failed",
    payload: {
      chargeId: "ch_failed_1",
      amountMinor: 1_000,
      currency: "usd",
      failureCode: "card_declined",
      failureMessage: "The card was declined.",
    },
    at: 1_000,
  };
}

function requireOrganisationId() {
  const parsed = parseOrganisationId("organisation_cue_engine");

  if (!parsed.ok) {
    throw new Error("invalid organisation fixture");
  }

  return parsed.value;
}
function requireIntegrationAccountId() {
  const parsed = parseIntegrationAccountId("integration_stripe_cue");

  if (!parsed.ok) {
    throw new Error("invalid cue integration account fixture");
  }

  return parsed.value;
}
