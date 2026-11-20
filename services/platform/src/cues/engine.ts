import type { OrganisationDatabase } from "../database-handles";
import type { CueEvent, SurfaceRef } from "@purin-labs/contracts";
import type { CommerceTypeParts } from "../commerce-type-parts";
import { definePort } from "../port";

import {
  parseChannelId,
  parseIntegrationAccountId,
  parseRequestId,
  parseOrganisationId,
  parseThreadKey,
  parseWorkspaceId,
  type ChannelId,
  type IntegrationAccountId,
  type RequestId,
  type OrganisationId,
  type ThreadKey,
  type WorkspaceId,
} from "../ids";
import type { JsonObject } from "../http";
import type { Result } from "../result";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import {
  assertNever,
  canonicalJson,
  isNonEmptyString,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
} from "@purin-labs/std";

type CommerceEntityTypeId = CommerceTypeParts["entityTypeId"];
type CommerceListEntryRef = CommerceTypeParts["listEntryRef"];
type CommerceListId = CommerceTypeParts["listId"];
type CommerceRelationshipRef = CommerceTypeParts["relationshipRef"];
type PublishedCommerceSelector = CommerceTypeParts["publishedSelector"];
type CommerceEntityPlaneObservationV1 =
  CommerceTypeParts["entityPlaneObservation"];

/**
 * The parser of the observation of an entity plane cue. It throws when the
 * value is not one. Commerce owns the observation, and the Worker registers
 * the parser (`worker-ports.ts`).
 */
export const entityPlaneObservationParser = definePort<
  (raw: unknown) => CommerceEntityPlaneObservationV1
>("entity_plane_observation_parser");

type StripeCueEventBase = Omit<
  CueEvent,
  "organisationId" | "integrationAccountId" | "eventType" | "payload"
> & {
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  source: "stripe";
};

export type StripeChargeFailedCueEvent = StripeCueEventBase & {
  eventType: "charge.failed";
  payload: StripeChargeFailedCuePayload;
};

type StripeChargeFailedCuePayload = {
  chargeId: string;
  amountMinor: number;
  currency: string;
  failureCode: string | null;
  failureMessage: string | null;
};

export type StripeInvoicePaymentFailedCueEvent = StripeCueEventBase & {
  eventType: "invoice.payment_failed";
  payload: {
    invoiceId: string;
    customerId: string | null;
    subscriptionId: string | null;
    amountDueMinor: number;
    currency: string;
    attemptCount: number;
    nextPaymentAttemptAt: number | null;
  };
};

export type StripeRefundFailedCueEvent = StripeCueEventBase & {
  eventType: "refund.failed";
  payload: {
    refundId: string;
    chargeId: string | null;
    paymentIntentId: string | null;
    amountMinor: number;
    currency: string;
    failureReason: string | null;
  };
};

export type StripeSubscriptionDeletedCueEvent = StripeCueEventBase & {
  eventType: "customer.subscription.deleted";
  payload: {
    subscriptionId: string;
    customerId: string;
    status: string;
    cancelAtPeriodEnd: boolean;
    canceledAt: number | null;
    endedAt: number | null;
  };
};

export type StripeCueEvent =
  | StripeChargeFailedCueEvent
  | StripeInvoicePaymentFailedCueEvent
  | StripeRefundFailedCueEvent
  | StripeSubscriptionDeletedCueEvent;

export type StripeCueEventType = StripeCueEvent["eventType"];

type ShopifyCueEventBase = Omit<
  CueEvent,
  "organisationId" | "integrationAccountId" | "eventType" | "payload"
> & {
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  source: "shopify";
};

export type ShopifyOrderCreatedCueEvent = ShopifyCueEventBase & {
  eventType: "orders/create";
  payload: {
    orderId: string;
    orderName: string;
    totalPriceMinor: number;
    currency: string;
    financialStatus: string | null;
  };
};

export type ShopifyInventoryLevelUpdatedCueEvent = ShopifyCueEventBase & {
  eventType: "inventory_levels/update";
  payload: {
    inventoryItemId: string;
    locationId: string;
    available: number | null;
    updatedAt: string | null;
  };
};

export type ShopifyCueEvent =
  ShopifyOrderCreatedCueEvent | ShopifyInventoryLevelUpdatedCueEvent;

export type ShopifyCueEventType = ShopifyCueEvent["eventType"];

type CommerceCueEventBase = Omit<
  CueEvent,
  "organisationId" | "integrationAccountId" | "eventType" | "payload"
> & {
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  source: "commerce";
};

type CommercePaymentFailedCueEvent = CommerceCueEventBase & {
  eventType: "payment_failed";
  payload: {
    orderId: string;
    paymentId: string;
    amountMinor: number;
    currency: string;
    reason: string;
  };
};

type CommerceInventoryShortageCueEvent = CommerceCueEventBase & {
  eventType: "inventory_shortage";
  payload: {
    orderId: string;
    sku: string;
    requested: number;
    available: number;
    locationId: string;
  };
};

type CommerceInventoryLowStockCueEvent = CommerceCueEventBase & {
  eventType: "inventory_low_stock";
  payload: {
    stockPolicyId: string;
    stockPolicyRevision: number;
    crossingMovementId: string;
    inventoryPositionId: string;
    inventoryItemId: string;
    merchantCode: string;
    itemName: string;
    available: { amount: number; scale: number; unit: string };
    reorderPoint: { amount: number; scale: number; unit: string };
    locationId: string;
  };
};

type CommerceOrderUnshippedCueEvent = CommerceCueEventBase & {
  eventType: "order_unshipped";
  payload: {
    orderId: string;
    fulfillmentId: string;
    expectedBy: number;
  };
};

type CommerceTrackingStalledCueEvent = CommerceCueEventBase & {
  eventType: "tracking_stalled";
  payload: {
    orderId: string;
    shipmentId: string;
    trackingNumber: string;
    lastEventAt: number;
  };
};

export type CommerceDeliveryExceptionCueEvent = CommerceCueEventBase & {
  eventType: "delivery_exception";
  payload: {
    orderId: string;
    shipmentId: string;
    trackingNumber: string;
    status: string;
    reason: string;
  };
};

export type CommerceCancellationRefundProposedCueEvent =
  CommerceCueEventBase & {
    eventType: "cancellation_refund_proposed";
    payload: {
      orderId: string;
      paymentId: string;
      amountMinor: number;
      currency: string;
      reason: string;
    };
  };

export type CommerceEntityPlaneCueSelector =
  | {
      readonly kind: "entity_type";
      readonly entityTypeId: CommerceEntityTypeId;
    }
  | {
      readonly kind: "relationship";
      readonly relationship: CommerceRelationshipRef;
    }
  | { readonly kind: "commerce_list"; readonly listId: CommerceListId }
  | {
      readonly kind: "commerce_list_entry";
      readonly entry: CommerceListEntryRef;
    }
  | {
      readonly kind: "saved_selector";
      readonly selector: PublishedCommerceSelector;
    };

export type CommerceEntityPlaneCueEvent = CommerceCueEventBase & {
  eventType: "entity_plane_changed";
  payload: {
    deliveryId: string;
    merchantId: string;
    merchantRevision: number;
    observedAt: string;
    observation: CommerceEntityPlaneObservationV1;
    selectors: readonly CommerceEntityPlaneCueSelector[];
  };
};

export type CommerceCueEvent =
  | CommercePaymentFailedCueEvent
  | CommerceInventoryShortageCueEvent
  | CommerceInventoryLowStockCueEvent
  | CommerceOrderUnshippedCueEvent
  | CommerceTrackingStalledCueEvent
  | CommerceDeliveryExceptionCueEvent
  | CommerceCancellationRefundProposedCueEvent
  | CommerceEntityPlaneCueEvent;

export type CommerceCueEventType = CommerceCueEvent["eventType"];
export type NormalizedCueEvent =
  StripeCueEvent | ShopifyCueEvent | CommerceCueEvent;
export type CueSource = NormalizedCueEvent["source"];
export type NormalizedCueEventType = NormalizedCueEvent["eventType"];

type CueDeliveryMode =
  { kind: "immediate" } | { kind: "digest"; windowMs: number };

export type CueQueueMessage = {
  type: "cue.event.v1";
  requestId: RequestId;
  receivedAt: number;
  event: NormalizedCueEvent;
};

type TierOneCueSubscriptionBase = {
  subscriptionId: string;
  organisationId: OrganisationId;
  version: number;
  surfaceScope: {
    kind: "slack";
    workspaceId: WorkspaceId;
    channelId: ChannelId;
    threadKey: ThreadKey;
  };
  action: { kind: "propose"; template: string; delivery: CueDeliveryMode };
  tier: 1;
  debounceMs: number;
  maxPerHour: number;
  enabled: true;
};

export type TierOneCueSubscription = TierOneCueSubscriptionBase &
  (
    | { source: "stripe"; eventType: StripeCueEventType }
    | { source: "shopify"; eventType: ShopifyCueEventType }
    | { source: "commerce"; eventType: CommerceCueEventType }
  );

type CueSubscriptionMatch =
  | { source: "stripe"; eventType: StripeCueEventType }
  | { source: "shopify"; eventType: ShopifyCueEventType }
  | { source: "commerce"; eventType: CommerceCueEventType };

export type CueSnapshot = {
  organisationId: OrganisationId;
  version: number;
  subscriptions: readonly TierOneCueSubscription[];
  createdAt: number;
};

type CueBoundaryError =
  { code: "object_required" } | { code: "invalid_field"; field: string };

type CueSubscriptionRow = {
  subscriptionId: unknown;
  organisationId: unknown;
  version: unknown;
  surfaceScope: unknown;
  source: unknown;
  eventType: unknown;
  action: unknown;
  tier: unknown;
  debounceMs: unknown;
  maxPerHour: unknown;
  enabled: unknown;
};

const CUE_SNAPSHOT_PREFIX = "cue:";

export function cueSnapshotKey(organisationId: OrganisationId): string {
  return `${CUE_SNAPSHOT_PREFIX}${organisationId}:latest`;
}

export function createCueQueueMessage(input: {
  readonly requestId: RequestId;
  readonly receivedAt: number;
  readonly event: NormalizedCueEvent;
}): CueQueueMessage {
  return {
    type: "cue.event.v1",
    requestId: input.requestId,
    receivedAt: input.receivedAt,
    event: input.event,
  };
}

export function createCommerceEntityPlaneCueEvents(input: {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly deliveryId: string;
  readonly merchantId: string;
  readonly merchantRevision: number;
  readonly observedAt: string;
  readonly observations: readonly CommerceEntityPlaneObservationV1[];
  readonly at: number;
}): readonly CommerceEntityPlaneCueEvent[] {
  return input.observations.map((observation) => ({
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    source: "commerce",
    nativeId: `underclerk_entity_plane:${input.deliveryId}:${observation.observationId}`,
    at: input.at,
    eventType: "entity_plane_changed",
    payload: {
      deliveryId: input.deliveryId,
      merchantId: input.merchantId,
      merchantRevision: input.merchantRevision,
      observedAt: input.observedAt,
      observation,
      selectors: commerceEntityPlaneCueSelectors(observation),
    },
  }));
}

export function parseCueQueueMessage(
  raw: unknown,
): Result<CueQueueMessage, CueBoundaryError> {
  if (!isRecord(raw)) {
    return { ok: false, error: { code: "object_required" } };
  }

  if (raw.type !== "cue.event.v1" || typeof raw.requestId !== "string") {
    return invalidCueField("type");
  }

  const requestId = parseRequestId(raw.requestId);

  if (!requestId.ok) {
    return invalidCueField("requestId");
  }

  if (!nonNegativeSafeInteger(raw.receivedAt)) {
    return invalidCueField("receivedAt");
  }

  const event = parseNormalizedCueEvent(raw.event);

  return event.ok
    ? {
        ok: true,
        value: {
          type: raw.type,
          requestId: requestId.value,
          receivedAt: raw.receivedAt,
          event: event.value,
        },
      }
    : event;
}

export function parseCueSnapshot(
  raw: unknown,
): Result<CueSnapshot, CueBoundaryError> {
  if (!isRecord(raw) || !Array.isArray(raw.subscriptions)) {
    return { ok: false, error: { code: "object_required" } };
  }

  const organisationId = readOrganisationId(
    raw.organisationId,
    "organisationId",
  );

  if (!organisationId.ok) {
    return organisationId;
  }

  if (
    typeof raw.version !== "number" ||
    !Number.isSafeInteger(raw.version) ||
    raw.version < 1 ||
    typeof raw.createdAt !== "number" ||
    !Number.isSafeInteger(raw.createdAt) ||
    raw.createdAt < 0
  ) {
    return invalidCueField("version");
  }

  const subscriptions: TierOneCueSubscription[] = [];

  for (const value of raw.subscriptions) {
    const subscription = parseTierOneCueSubscription(value);

    if (!subscription.ok) {
      return subscription;
    }

    if (subscription.value.organisationId !== organisationId.value) {
      return invalidCueField("subscriptions.organisationId");
    }

    subscriptions.push(subscription.value);
  }

  return {
    ok: true,
    value: {
      organisationId: organisationId.value,
      version: raw.version,
      subscriptions,
      createdAt: raw.createdAt,
    },
  };
}

export async function compileAndStoreCueSnapshot(input: {
  db: OrganisationDatabase;
  kv: KVNamespace;
  organisationId: OrganisationId;
  now: number;
}): Promise<CueSnapshot> {
  const snapshot = await compileCueSnapshot(input);
  await input.kv.put(
    cueSnapshotKey(input.organisationId),
    JSON.stringify(snapshot),
  );
  return snapshot;
}

/**
 * The refresh of a scheduled run: it writes the snapshot only when the
 * subscriptions differ from the stored ones. A KV write costs ten times a KV
 * read, and each shop's run repeats every few minutes. A stale read can skip
 * one write; the next run makes it.
 */
async function refreshCueSnapshot(input: {
  db: OrganisationDatabase;
  kv: KVNamespace;
  organisationId: OrganisationId;
  now: number;
}): Promise<CueSnapshot> {
  const snapshot = await compileCueSnapshot(input);
  const key = cueSnapshotKey(input.organisationId);
  const stored = parseCueSnapshot(await input.kv.get(key, "json"));
  if (
    stored.ok &&
    stored.value.version === snapshot.version &&
    canonicalJson(stored.value.subscriptions) ===
      canonicalJson(snapshot.subscriptions)
  )
    return stored.value;
  await input.kv.put(key, JSON.stringify(snapshot));
  return snapshot;
}

async function compileCueSnapshot(input: {
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  now: number;
}): Promise<CueSnapshot> {
  const rows = await input.db
    .prepare(
      `SELECT
         subscription_id AS subscriptionId,
         organisation_id AS organisationId,
         version,
         surface_scope AS surfaceScope,
         source,
         event_type AS eventType,
         action,
         tier,
         debounce_ms AS debounceMs,
         max_per_hour AS maxPerHour,
         enabled
       FROM cue_subscription
       WHERE organisation_id = ? AND enabled = 1
       ORDER BY subscription_id`,
    )
    .bind(input.organisationId)
    .all<CueSubscriptionRow>();
  const subscriptions = rows.results.map(parseCueSubscriptionRow);
  const version = subscriptions.reduce(maxSubscriptionVersion, 0);
  return {
    organisationId: input.organisationId,
    version: Math.max(1, version),
    subscriptions,
    createdAt: input.now,
  };
}

/**
 * Backfills the commerce low-stock subscription for organisations activated before
 * that cue was added, then refreshes the single compiled snapshot.
 */
export async function ensureCommerceLowStockCueSnapshot(input: {
  db: OrganisationDatabase;
  kv: KVNamespace;
  organisationId: OrganisationId;
  now: number;
}): Promise<CueSnapshot> {
  const current = await refreshCueSnapshot(input);
  if (
    current.subscriptions.some(
      (subscription) =>
        subscription.source === "commerce" &&
        subscription.eventType === "inventory_low_stock",
    )
  ) {
    return current;
  }

  const inventoryShortage = current.subscriptions.find(
    (subscription) =>
      subscription.source === "commerce" &&
      subscription.eventType === "inventory_shortage",
  );
  if (inventoryShortage?.surfaceScope.kind !== "slack") {
    return current;
  }

  await writeTierOneCommerceSubscription({
    db: input.db,
    organisationId: input.organisationId,
    subscriptionId: "onboarding-commerce-inventory-low-stock",
    workspaceId: inventoryShortage.surfaceScope.workspaceId,
    channelId: inventoryShortage.surfaceScope.channelId,
    threadKey: inventoryShortage.surfaceScope.threadKey,
    eventType: "inventory_low_stock",
    template:
      "Inventory crossed the stock policy reorder point. Review the item and propose replenishment.",
    delivery: { kind: "immediate" },
    debounceMs: 30 * 60 * 1000,
    maxPerHour: 6,
  });
  return compileAndStoreCueSnapshot(input);
}

export async function writeTierOneStripeSubscription(input: {
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  subscriptionId: string;
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  threadKey: ThreadKey;
  eventType: StripeCueEventType;
  template: string;
  delivery: CueDeliveryMode;
  debounceMs: number;
  maxPerHour: number;
}): Promise<void> {
  return writeTierOneCueSubscription({
    db: input.db,
    organisationId: input.organisationId,
    subscriptionId: input.subscriptionId,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    threadKey: input.threadKey,
    source: "stripe",
    eventType: input.eventType,
    template: input.template,
    delivery: input.delivery,
    debounceMs: input.debounceMs,
    maxPerHour: input.maxPerHour,
  });
}

export async function writeTierOneShopifySubscription(input: {
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  subscriptionId: string;
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  threadKey: ThreadKey;
  eventType: ShopifyCueEventType;
  template: string;
  delivery: CueDeliveryMode;
  debounceMs: number;
  maxPerHour: number;
}): Promise<void> {
  return writeTierOneCueSubscription({
    db: input.db,
    organisationId: input.organisationId,
    subscriptionId: input.subscriptionId,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    threadKey: input.threadKey,
    source: "shopify",
    eventType: input.eventType,
    template: input.template,
    delivery: input.delivery,
    debounceMs: input.debounceMs,
    maxPerHour: input.maxPerHour,
  });
}

export async function writeTierOneCommerceSubscription(input: {
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  subscriptionId: string;
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  threadKey: ThreadKey;
  eventType: CommerceCueEventType;
  template: string;
  delivery: CueDeliveryMode;
  debounceMs: number;
  maxPerHour: number;
}): Promise<void> {
  return writeTierOneCueSubscription({
    db: input.db,
    organisationId: input.organisationId,
    subscriptionId: input.subscriptionId,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    threadKey: input.threadKey,
    source: "commerce",
    eventType: input.eventType,
    template: input.template,
    delivery: input.delivery,
    debounceMs: input.debounceMs,
    maxPerHour: input.maxPerHour,
  });
}

type TierOneCueSubscriptionWriteInput = {
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  subscriptionId: string;
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  threadKey: ThreadKey;
  template: string;
  delivery: CueDeliveryMode;
  debounceMs: number;
  maxPerHour: number;
} & CueSubscriptionMatch;

async function writeTierOneCueSubscription(
  input: TierOneCueSubscriptionWriteInput,
): Promise<void> {
  const existing = await input.db
    .prepare(
      `SELECT version FROM cue_subscription
       WHERE organisation_id = ? AND subscription_id = ?`,
    )
    .bind(input.organisationId, input.subscriptionId)
    .first<{ version: number }>();
  const version = (existing?.version ?? 0) + 1;
  const surfaceScope: SurfaceRef = {
    kind: "slack",
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    threadKey: input.threadKey,
  };

  await input.db
    .prepare(
      `INSERT INTO cue_subscription (
         organisation_id, subscription_id, version, surface_scope, source,
         event_type, condition, action, tier, debounce_ms, max_per_hour, enabled
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?, 1)
       ON CONFLICT (organisation_id, subscription_id) DO UPDATE SET
         version = excluded.version,
         surface_scope = excluded.surface_scope,
         source = excluded.source,
         event_type = excluded.event_type,
         condition = NULL,
         action = excluded.action,
         tier = 1,
         debounce_ms = excluded.debounce_ms,
         max_per_hour = excluded.max_per_hour,
         enabled = 1`,
    )
    .bind(
      input.organisationId,
      input.subscriptionId,
      version,
      JSON.stringify(surfaceScope),
      input.source,
      input.eventType,
      JSON.stringify({
        kind: "propose",
        template: input.template,
        delivery: input.delivery,
      }),
      input.debounceMs,
      input.maxPerHour,
    )
    .run();
}

export function matchCueSubscriptions(
  snapshot: CueSnapshot,
  event: NormalizedCueEvent,
): readonly TierOneCueSubscription[] {
  if (snapshot.organisationId !== event.organisationId) {
    return [];
  }

  return snapshot.subscriptions.filter(matchesCueEvent.bind(null, event));
}

export function renderCueProposal(
  subscription: TierOneCueSubscription,
  event: NormalizedCueEvent,
): string {
  switch (event.source) {
    case "stripe":
      return renderStripeCueProposal(subscription, event);
    case "shopify":
      return renderShopifyCueProposal(subscription, event);
    case "commerce":
      return renderCommerceCueProposal(subscription, event);
    default:
      return assertNever(event);
  }
}

function renderStripeCueProposal(
  subscription: TierOneCueSubscription,
  event: StripeCueEvent,
): string {
  switch (event.eventType) {
    case "charge.failed":
      return renderChargeFailedProposal(subscription, event);
    case "invoice.payment_failed":
      return renderInvoicePaymentFailedProposal(subscription, event);
    case "refund.failed":
      return renderRefundFailedProposal(subscription, event);
    case "customer.subscription.deleted":
      return renderSubscriptionDeletedProposal(subscription, event);
    default:
      return assertNever(event);
  }
}

function renderShopifyCueProposal(
  subscription: TierOneCueSubscription,
  event: ShopifyCueEvent,
): string {
  switch (event.eventType) {
    case "orders/create":
      return `${subscription.action.template}\nOrder: ${event.payload.orderName}\nTotal: ${formatMinorAmount(event.payload.totalPriceMinor, event.payload.currency)}\nFinancial status: ${event.payload.financialStatus ?? "Unknown"}`;
    case "inventory_levels/update":
      return `${subscription.action.template}\nInventory item: ${event.payload.inventoryItemId}\nLocation: ${event.payload.locationId}\nAvailable: ${event.payload.available ?? "Unknown"}`;
    default:
      return assertNever(event);
  }
}

function renderCommerceCueProposal(
  subscription: TierOneCueSubscription,
  event: CommerceCueEvent,
): string {
  switch (event.eventType) {
    case "payment_failed":
      return `${subscription.action.template}\nOrder: ${event.payload.orderId}\nPayment: ${event.payload.paymentId}\nAmount: ${formatMinorAmount(event.payload.amountMinor, event.payload.currency)}\nReason: ${event.payload.reason}`;
    case "inventory_shortage":
      return `${subscription.action.template}\nOrder: ${event.payload.orderId}\nSKU: ${event.payload.sku}\nLocation: ${event.payload.locationId}\nRequested: ${event.payload.requested}\nAvailable: ${event.payload.available}`;
    case "inventory_low_stock":
      return `${subscription.action.template}\nInventory item: ${event.payload.itemName}\nCode: ${event.payload.merchantCode}\nLocation: ${event.payload.locationId}\nAvailable: ${formatQuantity(event.payload.available)}\nReorder point: ${formatQuantity(event.payload.reorderPoint)}`;
    case "order_unshipped":
      return `${subscription.action.template}\nOrder: ${event.payload.orderId}\nFulfillment: ${event.payload.fulfillmentId}\nExpected by: ${new Date(event.payload.expectedBy).toISOString()}`;
    case "tracking_stalled":
      return `${subscription.action.template}\nOrder: ${event.payload.orderId}\nShipment: ${event.payload.shipmentId}\nTracking: ${event.payload.trackingNumber}\nLast event: ${new Date(event.payload.lastEventAt).toISOString()}`;
    case "delivery_exception":
      return `${subscription.action.template}\nOrder: ${event.payload.orderId}\nShipment: ${event.payload.shipmentId}\nTracking: ${event.payload.trackingNumber}\nStatus: ${event.payload.status}\nReason: ${event.payload.reason}`;
    case "cancellation_refund_proposed":
      return `${subscription.action.template}\nOrder: ${event.payload.orderId}\nPayment: ${event.payload.paymentId}\nProposed refund: ${formatMinorAmount(event.payload.amountMinor, event.payload.currency)}\nReason: ${event.payload.reason}\nApproval is required before any provider effect.`;
    case "entity_plane_changed":
      return renderCommerceEntityPlaneProposal(subscription, event);
    default:
      return assertNever(event);
  }
}

function renderCommerceEntityPlaneProposal(
  subscription: TierOneCueSubscription,
  event: CommerceEntityPlaneCueEvent,
): string {
  const selectors = event.payload.selectors
    .map(renderCommerceEntityPlaneSelector)
    .join(", ");
  return `${subscription.action.template}\nEntity-plane observation: ${event.payload.observation.observationId}\nSelectors: ${selectors}\nMerchant revision: ${event.payload.merchantRevision}`;
}

function renderCommerceEntityPlaneSelector(
  selector: CommerceEntityPlaneCueSelector,
): string {
  switch (selector.kind) {
    case "entity_type":
      return `entity type ${selector.entityTypeId.origin}:${selector.entityTypeId.typeId}`;
    case "relationship":
      return `relationship ${selector.relationship.origin}:${selector.relationship.relationshipId}`;
    case "commerce_list":
      return `commerce list ${selector.listId}`;
    case "commerce_list_entry":
      return `commerce list entry ${selector.entry.listId}:${selector.entry.entryId}`;
    case "saved_selector":
      return `saved selector ${selector.selector.selectorId}@${selector.selector.revision}`;
    default:
      return assertNever(selector);
  }
}

function renderChargeFailedProposal(
  subscription: TierOneCueSubscription,
  event: StripeChargeFailedCueEvent,
): string {
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: event.payload.currency.toUpperCase(),
  }).format(event.payload.amountMinor / 100);
  const failure =
    event.payload.failureMessage ??
    event.payload.failureCode ??
    "Unknown failure";
  return `${subscription.action.template}\nCharge: ${event.payload.chargeId}\nAmount: ${amount}\nFailure: ${failure}`;
}

function renderInvoicePaymentFailedProposal(
  subscription: TierOneCueSubscription,
  event: StripeInvoicePaymentFailedCueEvent,
): string {
  const amount = formatMinorAmount(
    event.payload.amountDueMinor,
    event.payload.currency,
  );
  const nextAttempt =
    event.payload.nextPaymentAttemptAt === null
      ? "No retry scheduled"
      : new Date(event.payload.nextPaymentAttemptAt).toISOString();
  return `${subscription.action.template}\nInvoice: ${event.payload.invoiceId}\nAmount due: ${amount}\nAttempt: ${event.payload.attemptCount}\nNext attempt: ${nextAttempt}`;
}

function renderRefundFailedProposal(
  subscription: TierOneCueSubscription,
  event: StripeRefundFailedCueEvent,
): string {
  const amount = formatMinorAmount(
    event.payload.amountMinor,
    event.payload.currency,
  );
  const payment =
    event.payload.chargeId ??
    event.payload.paymentIntentId ??
    "Unknown payment";
  const reason = event.payload.failureReason ?? "Unknown failure";
  return `${subscription.action.template}\nRefund: ${event.payload.refundId}\nPayment: ${payment}\nAmount: ${amount}\nFailure: ${reason}`;
}

function renderSubscriptionDeletedProposal(
  subscription: TierOneCueSubscription,
  event: StripeSubscriptionDeletedCueEvent,
): string {
  const endedAt =
    event.payload.endedAt === null
      ? "Unknown"
      : new Date(event.payload.endedAt).toISOString();
  return `${subscription.action.template}\nSubscription: ${event.payload.subscriptionId}\nCustomer: ${event.payload.customerId}\nStatus: ${event.payload.status}\nEnded: ${endedAt}`;
}

function formatMinorAmount(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amountMinor / 100);
}

function formatQuantity(
  quantity: Readonly<{ amount: number; scale: number; unit: string }>,
): string {
  return `${(quantity.amount / 10 ** quantity.scale).toString()} ${quantity.unit}`;
}

function parseNormalizedCueEvent(
  raw: unknown,
): Result<NormalizedCueEvent, CueBoundaryError> {
  if (!isRecord(raw)) {
    return { ok: false, error: { code: "object_required" } };
  }

  switch (raw.source) {
    case "stripe":
      return parseStripeCueEvent(raw);
    case "shopify":
      return parseShopifyCueEvent(raw);
    case "commerce":
      return parseCommerceCueEvent(raw);
    default:
      return invalidCueField("event.source");
  }
}

export function parseCommerceCueEvent(
  raw: unknown,
): Result<CommerceCueEvent, CueBoundaryError> {
  if (!isRecord(raw)) {
    return { ok: false, error: { code: "object_required" } };
  }

  const common = parseCueEventCommon(raw, "commerce");

  if (!common.ok || !isRecord(raw.payload)) {
    return invalidCueField("event.payload");
  }

  switch (raw.eventType) {
    case "payment_failed":
      return parseCommercePaymentFailedCueEvent(raw.payload, common.value);
    case "inventory_shortage":
      return parseCommerceInventoryShortageCueEvent(raw.payload, common.value);
    case "inventory_low_stock":
      return parseCommerceInventoryLowStockCueEvent(raw.payload, common.value);
    case "order_unshipped":
      return parseCommerceOrderUnshippedCueEvent(raw.payload, common.value);
    case "tracking_stalled":
      return parseCommerceTrackingStalledCueEvent(raw.payload, common.value);
    case "delivery_exception":
      return parseCommerceDeliveryExceptionCueEvent(raw.payload, common.value);
    case "cancellation_refund_proposed":
      return parseCommerceCancellationRefundProposedCueEvent(
        raw.payload,
        common.value,
      );
    case "entity_plane_changed":
      return parseCommerceEntityPlaneCueEvent(raw.payload, common.value);
    default:
      return invalidCueField("event.eventType");
  }
}

function parseCommerceEntityPlaneCueEvent(
  payload: JsonObject,
  common: ParsedCueEventCommon<"commerce">,
): Result<CommerceEntityPlaneCueEvent, CueBoundaryError> {
  if (
    !isNonEmptyString(payload.deliveryId) ||
    !isNonEmptyString(payload.merchantId) ||
    !nonNegativeSafeInteger(payload.merchantRevision) ||
    !isNonEmptyString(payload.observedAt) ||
    !Number.isFinite(Date.parse(payload.observedAt)) ||
    !Array.isArray(payload.selectors)
  ) {
    return invalidCueField("event.payload");
  }
  let observation: CommerceEntityPlaneObservationV1;
  try {
    observation = entityPlaneObservationParser.use()(payload.observation);
  } catch {
    return invalidCueField("event.payload.observation");
  }
  if (
    common.nativeId !==
    `underclerk_entity_plane:${payload.deliveryId}:${observation.observationId}`
  ) {
    return invalidCueField("event.nativeId");
  }
  if (observation.merchantRevision !== payload.merchantRevision) {
    return invalidCueField("event.payload.merchantRevision");
  }
  const selectors = commerceEntityPlaneCueSelectors(observation);
  if (JSON.stringify(payload.selectors) !== JSON.stringify(selectors)) {
    return invalidCueField("event.payload.selectors");
  }
  return {
    ok: true,
    value: {
      organisationId: common.organisationId,
      integrationAccountId: common.integrationAccountId,
      source: common.source,
      nativeId: common.nativeId,
      at: common.at,
      eventType: "entity_plane_changed",
      payload: {
        deliveryId: payload.deliveryId,
        merchantId: payload.merchantId,
        merchantRevision: payload.merchantRevision,
        observedAt: payload.observedAt,
        observation,
        selectors,
      },
    },
  };
}

export function commerceEntityPlaneCueSelectors(
  observation: CommerceEntityPlaneObservationV1,
): readonly CommerceEntityPlaneCueSelector[] {
  switch (observation.kind) {
    case "system_entity_changed":
      return [
        {
          kind: "entity_type",
          entityTypeId: {
            origin: "system",
            typeId: observation.entityRef.typeId,
          },
        },
      ];
    case "custom_entity_changed":
      return [
        {
          kind: "entity_type",
          entityTypeId: {
            origin: "custom",
            typeId: observation.entityRef.typeId,
          },
        },
      ];
    case "relationship_changed":
      return relationshipChangedCueSelectors(observation.relationship);
    case "commerce_list_entry_changed":
      return commerceListEntryCueSelectors(observation);
    default:
      return assertNever(observation);
  }
}

function relationshipChangedCueSelectors(
  relationship: Variant<
    CommerceEntityPlaneObservationV1,
    "relationship_changed"
  >["relationship"],
): readonly CommerceEntityPlaneCueSelector[] {
  switch (relationship.origin) {
    case "system":
      return [
        {
          kind: "relationship",
          relationship: {
            origin: "system",
            relationshipId: relationship.relationshipId,
            definition: relationship.definition,
            revision: relationship.revision,
          },
        },
      ];
    case "custom":
      return [
        {
          kind: "relationship",
          relationship: {
            origin: "custom",
            relationshipId: relationship.relationshipId,
            definition: relationship.definition,
            revision: relationship.revision,
          },
        },
      ];
    default:
      return assertNever(relationship);
  }
}

function commerceListEntryCueSelectors(
  observation: Variant<
    CommerceEntityPlaneObservationV1,
    "commerce_list_entry_changed"
  >,
): readonly CommerceEntityPlaneCueSelector[] {
  const entityTypeSelector =
    observation.entityRef.origin === "system"
      ? {
          kind: "entity_type" as const,
          entityTypeId: {
            origin: "system" as const,
            typeId: observation.entityRef.typeId,
          },
        }
      : {
          kind: "entity_type" as const,
          entityTypeId: {
            origin: "custom" as const,
            typeId: observation.entityRef.typeId,
          },
        };
  return [
    entityTypeSelector,
    { kind: "commerce_list", listId: observation.entry.listId },
    { kind: "commerce_list_entry", entry: observation.entry },
  ];
}

function parseCommercePaymentFailedCueEvent(
  payload: JsonObject,
  common: ParsedCueEventCommon<"commerce">,
): Result<CommercePaymentFailedCueEvent, CueBoundaryError> {
  if (
    !isNonEmptyString(payload.orderId) ||
    !isNonEmptyString(payload.paymentId) ||
    !nonNegativeSafeInteger(payload.amountMinor) ||
    !isNonEmptyString(payload.currency) ||
    !isNonEmptyString(payload.reason)
  ) {
    return invalidCueField("event.payload");
  }

  return {
    ok: true,
    value: {
      organisationId: common.organisationId,
      integrationAccountId: common.integrationAccountId,
      source: common.source,
      nativeId: common.nativeId,
      at: common.at,
      eventType: "payment_failed",
      payload: {
        orderId: payload.orderId,
        paymentId: payload.paymentId,
        amountMinor: payload.amountMinor,
        currency: payload.currency,
        reason: payload.reason,
      },
    },
  };
}

function parseCommerceInventoryShortageCueEvent(
  payload: JsonObject,
  common: ParsedCueEventCommon<"commerce">,
): Result<CommerceInventoryShortageCueEvent, CueBoundaryError> {
  if (
    !isNonEmptyString(payload.orderId) ||
    !isNonEmptyString(payload.sku) ||
    !nonNegativeSafeInteger(payload.requested) ||
    !nonNegativeSafeInteger(payload.available) ||
    !isNonEmptyString(payload.locationId)
  ) {
    return invalidCueField("event.payload");
  }

  return {
    ok: true,
    value: {
      organisationId: common.organisationId,
      integrationAccountId: common.integrationAccountId,
      source: common.source,
      nativeId: common.nativeId,
      at: common.at,
      eventType: "inventory_shortage",
      payload: {
        orderId: payload.orderId,
        sku: payload.sku,
        requested: payload.requested,
        available: payload.available,
        locationId: payload.locationId,
      },
    },
  };
}

function parseCommerceInventoryLowStockCueEvent(
  payload: JsonObject,
  common: ParsedCueEventCommon<"commerce">,
): Result<CommerceInventoryLowStockCueEvent, CueBoundaryError> {
  const available = parseCueQuantity(payload.available);
  const reorderPoint = parseCueQuantity(payload.reorderPoint);
  if (
    !isNonEmptyString(payload.stockPolicyId) ||
    !positiveSafeInteger(payload.stockPolicyRevision) ||
    !isNonEmptyString(payload.crossingMovementId) ||
    !isNonEmptyString(payload.inventoryPositionId) ||
    !isNonEmptyString(payload.inventoryItemId) ||
    !isNonEmptyString(payload.merchantCode) ||
    !isNonEmptyString(payload.itemName) ||
    available === null ||
    reorderPoint === null ||
    available.unit !== reorderPoint.unit ||
    compareCueQuantities(available, reorderPoint) > 0 ||
    !isNonEmptyString(payload.locationId)
  ) {
    return invalidCueField("event.payload");
  }

  return {
    ok: true,
    value: {
      organisationId: common.organisationId,
      integrationAccountId: common.integrationAccountId,
      source: common.source,
      nativeId: common.nativeId,
      at: common.at,
      eventType: "inventory_low_stock",
      payload: {
        stockPolicyId: payload.stockPolicyId,
        stockPolicyRevision: payload.stockPolicyRevision,
        crossingMovementId: payload.crossingMovementId,
        inventoryPositionId: payload.inventoryPositionId,
        inventoryItemId: payload.inventoryItemId,
        merchantCode: payload.merchantCode,
        itemName: payload.itemName,
        available,
        reorderPoint,
        locationId: payload.locationId,
      },
    },
  };
}

function parseCommerceOrderUnshippedCueEvent(
  payload: JsonObject,
  common: ParsedCueEventCommon<"commerce">,
): Result<CommerceOrderUnshippedCueEvent, CueBoundaryError> {
  if (
    !isNonEmptyString(payload.orderId) ||
    !isNonEmptyString(payload.fulfillmentId) ||
    !nonNegativeSafeInteger(payload.expectedBy)
  ) {
    return invalidCueField("event.payload");
  }

  return {
    ok: true,
    value: {
      organisationId: common.organisationId,
      integrationAccountId: common.integrationAccountId,
      source: common.source,
      nativeId: common.nativeId,
      at: common.at,
      eventType: "order_unshipped",
      payload: {
        orderId: payload.orderId,
        fulfillmentId: payload.fulfillmentId,
        expectedBy: payload.expectedBy,
      },
    },
  };
}

function parseCommerceTrackingStalledCueEvent(
  payload: JsonObject,
  common: ParsedCueEventCommon<"commerce">,
): Result<CommerceTrackingStalledCueEvent, CueBoundaryError> {
  if (
    !isNonEmptyString(payload.orderId) ||
    !isNonEmptyString(payload.shipmentId) ||
    !isNonEmptyString(payload.trackingNumber) ||
    !nonNegativeSafeInteger(payload.lastEventAt)
  ) {
    return invalidCueField("event.payload");
  }

  return {
    ok: true,
    value: {
      organisationId: common.organisationId,
      integrationAccountId: common.integrationAccountId,
      source: common.source,
      nativeId: common.nativeId,
      at: common.at,
      eventType: "tracking_stalled",
      payload: {
        orderId: payload.orderId,
        shipmentId: payload.shipmentId,
        trackingNumber: payload.trackingNumber,
        lastEventAt: payload.lastEventAt,
      },
    },
  };
}

function parseCommerceDeliveryExceptionCueEvent(
  payload: JsonObject,
  common: ParsedCueEventCommon<"commerce">,
): Result<CommerceDeliveryExceptionCueEvent, CueBoundaryError> {
  if (
    !isNonEmptyString(payload.orderId) ||
    !isNonEmptyString(payload.shipmentId) ||
    !isNonEmptyString(payload.trackingNumber) ||
    !isNonEmptyString(payload.status) ||
    !isNonEmptyString(payload.reason)
  ) {
    return invalidCueField("event.payload");
  }

  return {
    ok: true,
    value: {
      organisationId: common.organisationId,
      integrationAccountId: common.integrationAccountId,
      source: common.source,
      nativeId: common.nativeId,
      at: common.at,
      eventType: "delivery_exception",
      payload: {
        orderId: payload.orderId,
        shipmentId: payload.shipmentId,
        trackingNumber: payload.trackingNumber,
        status: payload.status,
        reason: payload.reason,
      },
    },
  };
}

function parseCommerceCancellationRefundProposedCueEvent(
  payload: JsonObject,
  common: ParsedCueEventCommon<"commerce">,
): Result<CommerceCancellationRefundProposedCueEvent, CueBoundaryError> {
  if (
    !isNonEmptyString(payload.orderId) ||
    !isNonEmptyString(payload.paymentId) ||
    !nonNegativeSafeInteger(payload.amountMinor) ||
    !isNonEmptyString(payload.currency) ||
    !isNonEmptyString(payload.reason)
  ) {
    return invalidCueField("event.payload");
  }

  return {
    ok: true,
    value: {
      organisationId: common.organisationId,
      integrationAccountId: common.integrationAccountId,
      source: common.source,
      nativeId: common.nativeId,
      at: common.at,
      eventType: "cancellation_refund_proposed",
      payload: {
        orderId: payload.orderId,
        paymentId: payload.paymentId,
        amountMinor: payload.amountMinor,
        currency: payload.currency,
        reason: payload.reason,
      },
    },
  };
}

function parseStripeCueEvent(
  raw: unknown,
): Result<StripeCueEvent, CueBoundaryError> {
  if (!isRecord(raw) || !isRecord(raw.payload)) {
    return { ok: false, error: { code: "object_required" } };
  }

  const common = parseCueEventCommon(raw, "stripe");

  if (!common.ok) {
    return common;
  }

  switch (raw.eventType) {
    case "charge.failed":
      return parseChargeFailedCueEvent(raw.payload, common.value);
    case "invoice.payment_failed":
      return parseInvoicePaymentFailedCueEvent(raw.payload, common.value);
    case "refund.failed":
      return parseRefundFailedCueEvent(raw.payload, common.value);
    case "customer.subscription.deleted":
      return parseSubscriptionDeletedCueEvent(raw.payload, common.value);
    default:
      return invalidCueField("event.eventType");
  }
}

function parseShopifyCueEvent(
  raw: JsonObject,
): Result<ShopifyCueEvent, CueBoundaryError> {
  const common = parseCueEventCommon(raw, "shopify");

  if (!common.ok) {
    return common;
  }

  switch (raw.eventType) {
    case "orders/create":
      return parseShopifyOrderCreatedCueEvent(raw.payload, common.value);
    case "inventory_levels/update":
      return parseShopifyInventoryLevelUpdatedCueEvent(
        raw.payload,
        common.value,
      );
    default:
      return invalidCueField("event.eventType");
  }
}

type ParsedCueEventCommon<Source extends CueSource> = {
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  source: Source;
  nativeId: string;
  at: number;
};

function parseCueEventCommon<Source extends CueSource>(
  raw: JsonObject,
  expectedSource: Source,
): Result<ParsedCueEventCommon<Source>, CueBoundaryError> {
  const organisationId = readOrganisationId(
    raw.organisationId,
    "event.organisationId",
  );
  const integrationAccountId = readIntegrationAccountId(
    raw.integrationAccountId,
    "event.integrationAccountId",
  );

  if (!organisationId.ok || !integrationAccountId.ok) {
    return invalidCueField("event.identity");
  }

  if (
    raw.source !== expectedSource ||
    typeof raw.nativeId !== "string" ||
    raw.nativeId.length === 0 ||
    !nonNegativeSafeInteger(raw.at)
  ) {
    return invalidCueField("event");
  }

  return {
    ok: true,
    value: {
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      source: expectedSource,
      nativeId: raw.nativeId,
      at: raw.at,
    },
  };
}

function parseShopifyOrderCreatedCueEvent(
  raw: unknown,
  common: ParsedCueEventCommon<"shopify">,
): Result<ShopifyOrderCreatedCueEvent, CueBoundaryError> {
  if (
    !isRecord(raw) ||
    typeof raw.orderId !== "string" ||
    typeof raw.orderName !== "string" ||
    !nonNegativeSafeInteger(raw.totalPriceMinor) ||
    typeof raw.currency !== "string" ||
    !nullableString(raw.financialStatus)
  ) {
    return invalidCueField("event.payload");
  }

  return {
    ok: true,
    value: {
      organisationId: common.organisationId,
      integrationAccountId: common.integrationAccountId,
      source: common.source,
      nativeId: common.nativeId,
      eventType: "orders/create",
      payload: {
        orderId: raw.orderId,
        orderName: raw.orderName,
        totalPriceMinor: raw.totalPriceMinor,
        currency: raw.currency,
        financialStatus: raw.financialStatus,
      },
      at: common.at,
    },
  };
}

function parseShopifyInventoryLevelUpdatedCueEvent(
  raw: unknown,
  common: ParsedCueEventCommon<"shopify">,
): Result<ShopifyInventoryLevelUpdatedCueEvent, CueBoundaryError> {
  if (
    !isRecord(raw) ||
    typeof raw.inventoryItemId !== "string" ||
    typeof raw.locationId !== "string" ||
    !nullableSafeInteger(raw.available) ||
    !nullableString(raw.updatedAt)
  ) {
    return invalidCueField("event.payload");
  }

  return {
    ok: true,
    value: {
      organisationId: common.organisationId,
      integrationAccountId: common.integrationAccountId,
      source: common.source,
      nativeId: common.nativeId,
      eventType: "inventory_levels/update",
      payload: {
        inventoryItemId: raw.inventoryItemId,
        locationId: raw.locationId,
        available: raw.available,
        updatedAt: raw.updatedAt,
      },
      at: common.at,
    },
  };
}

function parseChargeFailedCueEvent(
  payload: JsonObject,
  common: ParsedCueEventCommon<"stripe">,
): Result<StripeChargeFailedCueEvent, CueBoundaryError> {
  if (
    typeof payload.chargeId !== "string" ||
    !safeInteger(payload.amountMinor) ||
    typeof payload.currency !== "string" ||
    !nullableString(payload.failureCode) ||
    !nullableString(payload.failureMessage)
  ) {
    return invalidCueField("event.payload");
  }

  return {
    ok: true,
    value: {
      organisationId: common.organisationId,
      integrationAccountId: common.integrationAccountId,
      source: common.source,
      nativeId: common.nativeId,
      eventType: "charge.failed",
      payload: {
        chargeId: payload.chargeId,
        amountMinor: payload.amountMinor,
        currency: payload.currency,
        failureCode: payload.failureCode,
        failureMessage: payload.failureMessage,
      },
      at: common.at,
    },
  };
}

function parseInvoicePaymentFailedCueEvent(
  payload: JsonObject,
  common: ParsedCueEventCommon<"stripe">,
): Result<StripeInvoicePaymentFailedCueEvent, CueBoundaryError> {
  if (
    typeof payload.invoiceId !== "string" ||
    !nullableString(payload.customerId) ||
    !nullableString(payload.subscriptionId) ||
    !safeInteger(payload.amountDueMinor) ||
    typeof payload.currency !== "string" ||
    !nonNegativeSafeInteger(payload.attemptCount) ||
    !nullableSafeInteger(payload.nextPaymentAttemptAt)
  ) {
    return invalidCueField("event.payload");
  }

  return {
    ok: true,
    value: {
      organisationId: common.organisationId,
      integrationAccountId: common.integrationAccountId,
      source: common.source,
      nativeId: common.nativeId,
      eventType: "invoice.payment_failed",
      payload: {
        invoiceId: payload.invoiceId,
        customerId: payload.customerId,
        subscriptionId: payload.subscriptionId,
        amountDueMinor: payload.amountDueMinor,
        currency: payload.currency,
        attemptCount: payload.attemptCount,
        nextPaymentAttemptAt: payload.nextPaymentAttemptAt,
      },
      at: common.at,
    },
  };
}

function parseRefundFailedCueEvent(
  payload: JsonObject,
  common: ParsedCueEventCommon<"stripe">,
): Result<StripeRefundFailedCueEvent, CueBoundaryError> {
  if (
    typeof payload.refundId !== "string" ||
    !nullableString(payload.chargeId) ||
    !nullableString(payload.paymentIntentId) ||
    !safeInteger(payload.amountMinor) ||
    typeof payload.currency !== "string" ||
    !nullableString(payload.failureReason)
  ) {
    return invalidCueField("event.payload");
  }

  return {
    ok: true,
    value: {
      organisationId: common.organisationId,
      integrationAccountId: common.integrationAccountId,
      source: common.source,
      nativeId: common.nativeId,
      eventType: "refund.failed",
      payload: {
        refundId: payload.refundId,
        chargeId: payload.chargeId,
        paymentIntentId: payload.paymentIntentId,
        amountMinor: payload.amountMinor,
        currency: payload.currency,
        failureReason: payload.failureReason,
      },
      at: common.at,
    },
  };
}

function parseSubscriptionDeletedCueEvent(
  payload: JsonObject,
  common: ParsedCueEventCommon<"stripe">,
): Result<StripeSubscriptionDeletedCueEvent, CueBoundaryError> {
  if (
    typeof payload.subscriptionId !== "string" ||
    typeof payload.customerId !== "string" ||
    typeof payload.status !== "string" ||
    typeof payload.cancelAtPeriodEnd !== "boolean" ||
    !nullableSafeInteger(payload.canceledAt) ||
    !nullableSafeInteger(payload.endedAt)
  ) {
    return invalidCueField("event.payload");
  }

  return {
    ok: true,
    value: {
      organisationId: common.organisationId,
      integrationAccountId: common.integrationAccountId,
      source: common.source,
      nativeId: common.nativeId,
      eventType: "customer.subscription.deleted",
      payload: {
        subscriptionId: payload.subscriptionId,
        customerId: payload.customerId,
        status: payload.status,
        cancelAtPeriodEnd: payload.cancelAtPeriodEnd,
        canceledAt: payload.canceledAt,
        endedAt: payload.endedAt,
      },
      at: common.at,
    },
  };
}

function parseCueSubscriptionRow(
  row: CueSubscriptionRow,
): TierOneCueSubscription {
  const parsed = parseTierOneCueSubscription({
    subscriptionId: row.subscriptionId,
    organisationId: row.organisationId,
    version: row.version,
    surfaceScope: parseJsonField(row.surfaceScope, "surfaceScope"),
    source: row.source,
    eventType: row.eventType,
    action: parseJsonField(row.action, "action"),
    tier: row.tier,
    debounceMs: row.debounceMs,
    maxPerHour: row.maxPerHour,
    enabled: row.enabled === 1,
  });

  if (!parsed.ok) {
    const field =
      parsed.error.code === "invalid_field" ? parsed.error.field : "object";
    throw new Error(`Invalid cue subscription: ${field}`);
  }

  return parsed.value;
}

function parseTierOneCueSubscription(
  raw: unknown,
): Result<TierOneCueSubscription, CueBoundaryError> {
  if (
    !isRecord(raw) ||
    !isRecord(raw.surfaceScope) ||
    !isRecord(raw.action) ||
    !isRecord(raw.action.delivery)
  ) {
    return { ok: false, error: { code: "object_required" } };
  }

  const organisationId = readOrganisationId(
    raw.organisationId,
    "subscription.organisationId",
  );
  const workspaceId = readWorkspaceId(raw.surfaceScope.workspaceId);
  const channelId = readChannelId(raw.surfaceScope.channelId);
  const threadKey = readThreadKey(raw.surfaceScope.threadKey);

  if (!organisationId.ok || !workspaceId.ok || !channelId.ok || !threadKey.ok) {
    return invalidCueField("subscription.surfaceScope");
  }

  const match = parseCueSubscriptionMatch(raw.source, raw.eventType);
  const delivery = parseCueDeliveryMode(raw.action.delivery);

  if (!match.ok) {
    return match;
  }

  if (!delivery.ok) {
    return delivery;
  }

  if (
    typeof raw.subscriptionId !== "string" ||
    typeof raw.version !== "number" ||
    !Number.isSafeInteger(raw.version) ||
    raw.version < 1 ||
    raw.surfaceScope.kind !== "slack" ||
    raw.action.kind !== "propose" ||
    typeof raw.action.template !== "string" ||
    raw.tier !== 1 ||
    typeof raw.debounceMs !== "number" ||
    !isNonNegativeInteger(raw.debounceMs) ||
    typeof raw.maxPerHour !== "number" ||
    !isPositiveInteger(raw.maxPerHour) ||
    raw.enabled !== true
  ) {
    return invalidCueField("subscription");
  }

  return {
    ok: true,
    value: createTierOneCueSubscription({
      subscriptionId: raw.subscriptionId,
      organisationId: organisationId.value,
      version: raw.version,
      workspaceId: workspaceId.value,
      channelId: channelId.value,
      threadKey: threadKey.value,
      match: match.value,
      template: raw.action.template,
      delivery: delivery.value,
      debounceMs: raw.debounceMs,
      maxPerHour: raw.maxPerHour,
    }),
  };
}

type ParsedTierOneSubscriptionInput = {
  subscriptionId: string;
  organisationId: OrganisationId;
  version: number;
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  threadKey: ThreadKey;
  match: CueSubscriptionMatch;
  template: string;
  delivery: CueDeliveryMode;
  debounceMs: number;
  maxPerHour: number;
};

function createTierOneCueSubscription(
  input: ParsedTierOneSubscriptionInput,
): TierOneCueSubscription {
  switch (input.match.source) {
    case "stripe":
      return createStripeTierOneCueSubscription(input, input.match);
    case "shopify":
      return createShopifyTierOneCueSubscription(input, input.match);
    case "commerce":
      return createCommerceTierOneCueSubscription(input, input.match);
    default:
      return assertNever(input.match);
  }
}

function createStripeTierOneCueSubscription(
  input: ParsedTierOneSubscriptionInput,
  match: VariantBy<CueSubscriptionMatch, "source", "stripe">,
): TierOneCueSubscription {
  return {
    subscriptionId: input.subscriptionId,
    organisationId: input.organisationId,
    version: input.version,
    surfaceScope: {
      kind: "slack",
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      threadKey: input.threadKey,
    },
    source: match.source,
    eventType: match.eventType,
    action: {
      kind: "propose",
      template: input.template,
      delivery: input.delivery,
    },
    tier: 1,
    debounceMs: input.debounceMs,
    maxPerHour: input.maxPerHour,
    enabled: true,
  };
}

function createShopifyTierOneCueSubscription(
  input: ParsedTierOneSubscriptionInput,
  match: VariantBy<CueSubscriptionMatch, "source", "shopify">,
): TierOneCueSubscription {
  return {
    subscriptionId: input.subscriptionId,
    organisationId: input.organisationId,
    version: input.version,
    surfaceScope: {
      kind: "slack",
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      threadKey: input.threadKey,
    },
    source: match.source,
    eventType: match.eventType,
    action: {
      kind: "propose",
      template: input.template,
      delivery: input.delivery,
    },
    tier: 1,
    debounceMs: input.debounceMs,
    maxPerHour: input.maxPerHour,
    enabled: true,
  };
}

function createCommerceTierOneCueSubscription(
  input: ParsedTierOneSubscriptionInput,
  match: VariantBy<CueSubscriptionMatch, "source", "commerce">,
): TierOneCueSubscription {
  return {
    subscriptionId: input.subscriptionId,
    organisationId: input.organisationId,
    version: input.version,
    surfaceScope: {
      kind: "slack",
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      threadKey: input.threadKey,
    },
    source: match.source,
    eventType: match.eventType,
    action: {
      kind: "propose",
      template: input.template,
      delivery: input.delivery,
    },
    tier: 1,
    debounceMs: input.debounceMs,
    maxPerHour: input.maxPerHour,
    enabled: true,
  };
}

function readOrganisationId(
  raw: unknown,
  field: string,
): Result<OrganisationId, CueBoundaryError> {
  if (typeof raw !== "string") {
    return invalidCueField(field);
  }

  const parsed = parseOrganisationId(raw);
  return parsed.ok ? parsed : invalidCueField(field);
}

function readIntegrationAccountId(
  raw: unknown,
  field: string,
): Result<IntegrationAccountId, CueBoundaryError> {
  if (typeof raw !== "string") {
    return invalidCueField(field);
  }

  const parsed = parseIntegrationAccountId(raw);
  return parsed.ok ? parsed : invalidCueField(field);
}

function readWorkspaceId(raw: unknown): Result<WorkspaceId, CueBoundaryError> {
  if (typeof raw !== "string") {
    return invalidCueField("surfaceScope.workspaceId");
  }

  const parsed = parseWorkspaceId(raw);
  return parsed.ok ? parsed : invalidCueField("surfaceScope.workspaceId");
}

function readChannelId(raw: unknown): Result<ChannelId, CueBoundaryError> {
  if (typeof raw !== "string") {
    return invalidCueField("surfaceScope.channelId");
  }

  const parsed = parseChannelId(raw);
  return parsed.ok ? parsed : invalidCueField("surfaceScope.channelId");
}

function readThreadKey(raw: unknown): Result<ThreadKey, CueBoundaryError> {
  if (typeof raw !== "string") {
    return invalidCueField("surfaceScope.threadKey");
  }

  const parsed = parseThreadKey(raw);
  return parsed.ok ? parsed : invalidCueField("surfaceScope.threadKey");
}

function parseJsonField(raw: unknown, field: string): unknown {
  if (typeof raw !== "string") {
    throw new Error(`Invalid cue subscription ${field}`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid cue subscription ${field}`);
  }
}

function maxSubscriptionVersion(
  current: number,
  subscription: TierOneCueSubscription,
): number {
  return Math.max(current, subscription.version);
}

function matchesCueEvent(
  event: NormalizedCueEvent,
  subscription: TierOneCueSubscription,
): boolean {
  return (
    subscription.enabled &&
    subscription.source === event.source &&
    subscription.eventType === event.eventType
  );
}

function parseCueSubscriptionMatch(
  source: unknown,
  eventType: unknown,
): Result<CueSubscriptionMatch, CueBoundaryError> {
  switch (source) {
    case "stripe":
      return isStripeCueEventType(eventType)
        ? { ok: true, value: { source, eventType } }
        : invalidCueField("subscription.eventType");
    case "shopify":
      return isShopifyCueEventType(eventType)
        ? { ok: true, value: { source, eventType } }
        : invalidCueField("subscription.eventType");
    case "commerce":
      return isCommerceCueEventType(eventType)
        ? { ok: true, value: { source, eventType } }
        : invalidCueField("subscription.eventType");
    default:
      return invalidCueField("subscription.source");
  }
}

function parseStripeCueEventType(
  raw: unknown,
): Result<StripeCueEventType, CueBoundaryError> {
  switch (raw) {
    case "charge.failed":
    case "invoice.payment_failed":
    case "refund.failed":
    case "customer.subscription.deleted":
      return { ok: true, value: raw };
    default:
      return invalidCueField("subscription.eventType");
  }
}

function isStripeCueEventType(raw: unknown): raw is StripeCueEventType {
  return parseStripeCueEventType(raw).ok;
}

function isShopifyCueEventType(raw: unknown): raw is ShopifyCueEventType {
  return raw === "orders/create" || raw === "inventory_levels/update";
}

function isCommerceCueEventType(raw: unknown): raw is CommerceCueEventType {
  switch (raw) {
    case "payment_failed":
    case "inventory_shortage":
    case "inventory_low_stock":
    case "order_unshipped":
    case "tracking_stalled":
    case "delivery_exception":
    case "cancellation_refund_proposed":
    case "entity_plane_changed":
      return true;
    default:
      return false;
  }
}

function parseCueDeliveryMode(
  raw: JsonObject,
): Result<CueDeliveryMode, CueBoundaryError> {
  if (raw.kind === "immediate") {
    return { ok: true, value: { kind: "immediate" } };
  }

  if (
    raw.kind === "digest" &&
    typeof raw.windowMs === "number" &&
    Number.isSafeInteger(raw.windowMs) &&
    raw.windowMs >= 60_000 &&
    raw.windowMs <= 24 * 60 * 60 * 1000
  ) {
    return { ok: true, value: { kind: "digest", windowMs: raw.windowMs } };
  }

  return invalidCueField("subscription.action.delivery");
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return safeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return safeInteger(value) && value > 0;
}

type CueQuantity = Readonly<{ amount: number; scale: number; unit: string }>;

function parseCueQuantity(value: unknown): CueQuantity | null {
  if (
    !isRecord(value) ||
    !nonNegativeSafeInteger(value.amount) ||
    !nonNegativeSafeInteger(value.scale) ||
    value.scale > 6 ||
    !isNonEmptyString(value.unit)
  )
    return null;
  return { amount: value.amount, scale: value.scale, unit: value.unit };
}

function compareCueQuantities(left: CueQuantity, right: CueQuantity): number {
  if (left.unit !== right.unit) return Number.NaN;
  const scale = Math.max(left.scale, right.scale);
  const leftAmount = BigInt(left.amount) * 10n ** BigInt(scale - left.scale);
  const rightAmount = BigInt(right.amount) * 10n ** BigInt(scale - right.scale);
  return leftAmount < rightAmount ? -1 : leftAmount > rightAmount ? 1 : 0;
}

function nullableSafeInteger(value: unknown): value is number | null {
  return value === null || safeInteger(value);
}

function invalidCueField(field: string): Result<never, CueBoundaryError> {
  return { ok: false, error: { code: "invalid_field", field } };
}

declare module "../env" {
  interface Env {
    CUE_Q: Queue<CueQueueMessage>;
  }
}
