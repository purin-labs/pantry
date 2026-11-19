import type {
  CanonicalCommerceDelivery,
  CommerceProjection,
  ConnectorDelivery,
} from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";

import type { ChannelId, WorkspaceId } from "../ids";

/** One online order that a feed delivery placed and paid in one commit. */
type PaidPlacement = Readonly<{
  order: CommerceOrderProjection;
  payment: PaymentProjection;
  fulfillment: FulfillmentProjection;
}>;

type CommerceOrderProjection = Variant<
  CommerceProjection,
  "commerce_order"
>["projection"];
type PaymentProjection = Variant<CommerceProjection, "payment">["projection"];
type FulfillmentProjection = Variant<
  CommerceProjection,
  "fulfillment"
>["projection"];
type ShipmentProjection = Variant<CommerceProjection, "shipment">["projection"];

/**
 * The Slack receipt of one paid placement. Its identity comes from the feed
 * delivery and the order, so a replayed delivery gives the same receipt and
 * the Connector posts it once.
 */
export function paidPlacementConnectorDelivery(
  input: Readonly<{
    destination: Readonly<{ workspaceId: WorkspaceId; channelId: ChannelId }>;
    placement: PaidPlacement;
    providerDeliveryId: string;
    addressedAt: number;
  }>,
): ConnectorDelivery {
  const orderId = input.placement.order.provenance.resourceId;
  const identity = `${input.providerDeliveryId}:${orderId}`;
  return {
    deliveryId: `underclerk_paid_placement_${identity}`,
    bindingId: `underclerk_paid_placement_binding_${identity}`,
    address: {
      kind: "slack_channel",
      workspaceId: input.destination.workspaceId,
      channelId: input.destination.channelId,
    },
    caseId: `underclerk_paid_placement_case_${identity}`,
    caseRevision: 1,
    content: { kind: "text", text: paidPlacementReceiptText(input.placement) },
    idempotencyKey: `underclerk_paid_placement:${identity}`,
    addressedAt: input.addressedAt,
  };
}

export function paidPlacements(
  delivery: CanonicalCommerceDelivery,
): readonly PaidPlacement[] {
  const orders: CommerceOrderProjection[] = [];
  const payments: PaymentProjection[] = [];
  const fulfillments: FulfillmentProjection[] = [];
  const shipments: ShipmentProjection[] = [];
  for (const observation of delivery.observations) {
    if (observation.kind !== "upsert") return [];
    switch (observation.projection.kind) {
      case "commerce_order":
        orders.push(observation.projection.projection);
        break;
      case "payment":
        payments.push(observation.projection.projection);
        break;
      case "fulfillment":
        fulfillments.push(observation.projection.projection);
        break;
      case "shipment":
        shipments.push(observation.projection.projection);
        break;
      default:
        return [];
    }
  }
  if (
    orders.length !== 1 ||
    payments.length !== 1 ||
    fulfillments.length !== 1 ||
    shipments.length > 1
  ) {
    return [];
  }
  const placements: PaidPlacement[] = [];
  for (const order of orders) {
    if (
      order.provenance.revision !== 1 ||
      order.origin.kind !== "online" ||
      order.origin.configuration.kind !== "checkout_profile" ||
      order.lifecycle.state !== "fulfillment_pending"
    )
      continue;
    const orderId = order.provenance.resourceId;
    const matchingPayments = matchingCapturedPayments(payments, orderId);
    const matchingFulfillments = matchingRequestedFulfillments(
      fulfillments,
      orderId,
    );
    const payment = matchingPayments[0];
    const fulfillment = matchingFulfillments[0];
    if (
      matchingPayments.length === 1 &&
      matchingFulfillments.length === 1 &&
      payment !== undefined &&
      fulfillment !== undefined
    ) {
      const shipment = shipments[0];
      if (
        shipment !== undefined &&
        (shipment.provenance.revision !== 1 ||
          shipment.orderId !== orderId ||
          shipment.fulfillmentId !== fulfillment.provenance.resourceId)
      )
        continue;
      placements.push({ order, payment, fulfillment });
    }
  }
  return placements.length === 1 ? placements : [];
}

function paidPlacementReceiptText(placement: PaidPlacement): string {
  const lines = placement.order.lineItems.map(formatReceiptLine).join(", ");
  return `Payment captured (${placement.payment.provenance.resourceId}) for order ${placement.order.provenance.resourceId}. Total ${formatMoney(placement.order.totals.total)}. Line items: ${lines}. Fulfillment ${placement.fulfillment.kind}, expected by ${placement.fulfillment.expectedBy}.`;
}

function matchingCapturedPayments(
  payments: readonly PaymentProjection[],
  orderId: string,
): readonly PaymentProjection[] {
  const matching: PaymentProjection[] = [];
  for (const payment of payments) {
    if (
      payment.provenance.revision === 1 &&
      payment.orderId === orderId &&
      payment.lifecycle.state === "captured"
    ) {
      matching.push(payment);
    }
  }
  return matching;
}

function matchingRequestedFulfillments(
  fulfillments: readonly FulfillmentProjection[],
  orderId: string,
): readonly FulfillmentProjection[] {
  const matching: FulfillmentProjection[] = [];
  for (const fulfillment of fulfillments) {
    if (
      fulfillment.provenance.revision === 1 &&
      fulfillment.orderId === orderId &&
      fulfillment.lifecycle.state === "requested"
    ) {
      matching.push(fulfillment);
    }
  }
  return matching;
}

function formatReceiptLine(
  lineItem: CommerceOrderProjection["lineItems"][number],
): string {
  return `${lineItem.title} (${lineItem.sku}) x ${formatQuantity(lineItem.quantity)}`;
}

function formatMoney(
  money: Readonly<{ amountMinor: number; currency: string }>,
): string {
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: money.currency,
    currencyDisplay: "code",
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(money.amountMinor / 10 ** fractionDigits);
}

function formatQuantity(
  quantity: Readonly<{ amount: number; scale: number; unit: string }>,
): string {
  if (quantity.scale === 0) return `${quantity.amount} ${quantity.unit}`;
  const digits = String(quantity.amount).padStart(quantity.scale + 1, "0");
  const splitAt = digits.length - quantity.scale;
  return `${digits.slice(0, splitAt)}.${digits.slice(splitAt)} ${quantity.unit}`;
}
