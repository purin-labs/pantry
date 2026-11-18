import type {
  CommerceAdminClient,
  CommerceClientError,
  CommerceMutationResultV1,
  CommerceShipmentV1,
  CommerceFirstPartyShipmentV1,
} from "@seams/commerce-client";

import { commerceCanonicalResourceId } from "./provider";

export type ShippingOperationRequest =
  | Readonly<{ action: "quote_label_rate" }>
  | Readonly<{
      action: "purchase_label";
      labelRateId: string;
      shipmentRevision: number;
    }>;

type ShippingPackageSummary = Readonly<{
  weightGrams: number;
  lengthMillimeters: number;
  widthMillimeters: number;
  heightMillimeters: number;
}>;

type ShippingOperationsBase = Readonly<{
  schemaVersion: "satyr.shipping-operations.v1";
  merchantRevision: number;
  shipmentId: string;
  shipmentRevision: number;
  package: ShippingPackageSummary;
}>;

type ShippingOperationsView =
  | (ShippingOperationsBase &
      Readonly<{
        state: "ready";
        nextAction: "quote_label_rate";
      }>)
  | (ShippingOperationsBase &
      Readonly<{
        state: "rate_quoted";
        labelRateId: string;
        serviceName: string;
        amount: Readonly<{ amountMinor: number; currency: string }>;
        quotedAt: string;
        expiresAt: string;
        nextAction: "purchase_label";
      }>)
  | (ShippingOperationsBase &
      Readonly<{
        state: "label_purchased";
        trackingNumber: string;
        purchasedAt: string;
        nextAction: "hand_to_carrier";
      }>)
  | (ShippingOperationsBase &
      Readonly<{
        state: "in_transit";
        trackingNumber: string;
        handedOverAt: string;
        latestEvent: Readonly<{
          kind: string;
          occurredAt: string;
          location: string;
        }>;
        nextAction: "await_delivery";
      }>)
  | (ShippingOperationsBase &
      Readonly<{
        state: "delivered";
        trackingNumber: string;
        handedOverAt: string;
        deliveredAt: string;
        latestEvent: Readonly<{
          kind: string;
          occurredAt: string;
          location: string;
        }>;
        nextAction: "complete";
      }>);

export type ShippingOperationError =
  | Readonly<{ code: "underclerk_unavailable"; cause: CommerceClientError }>
  | Readonly<{ code: "shipment_not_found"; shipmentId: string }>
  | Readonly<{
      code: "shipping_operation_unavailable";
      action: ShippingOperationRequest["action"];
    }>
  | Readonly<{
      code: "shipping_operation_rejected";
      result: CommerceMutationResultV1;
    }>;

type ShippingOperationResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: ShippingOperationError }>;

type ShippingOperationsClient = Pick<
  CommerceAdminClient,
  "readSnapshot" | "quoteShipmentLabelRate" | "purchaseShippingLabel"
>;

type ShippingOperationsState = Readonly<{
  view: ShippingOperationsView;
}>;

export async function readShippingOperations(
  client: ShippingOperationsClient,
  merchantId: string,
  shipmentId: string,
): Promise<ShippingOperationResult<ShippingOperationsView>> {
  const state = await readShippingOperationsState(
    client,
    merchantId,
    shipmentId,
  );
  return state.ok ? { ok: true, value: state.value.view } : state;
}

export async function executeShippingOperation(
  input: Readonly<{
    client: ShippingOperationsClient;
    merchantId: string;
    shipmentId: string;
    request: ShippingOperationRequest;
    idempotencyKey: string;
    requestedAt: string;
  }>,
): Promise<ShippingOperationResult<ShippingOperationsView>> {
  const current = await readShippingOperationsState(
    input.client,
    input.merchantId,
    input.shipmentId,
  );
  if (!current.ok) return current;
  if (input.request.action === "quote_label_rate") {
    if (current.value.view.state !== "ready")
      return unavailableAction(input.request.action);
    const quoted = await input.client.quoteShipmentLabelRate({
      merchantId: input.merchantId,
      idempotencyKey: input.idempotencyKey,
      shipmentId: input.shipmentId,
      shipmentRevision: current.value.view.shipmentRevision,
    });
    if (!quoted.ok) return unavailable(quoted.error);
    return {
      ok: true,
      value: {
        ...current.value.view,
        state: "rate_quoted",
        labelRateId: quoted.value.rate.labelRateId,
        serviceName: quoted.value.rate.service.name,
        amount: quoted.value.rate.amount,
        quotedAt: quoted.value.rate.quotedAt,
        expiresAt: quoted.value.rate.expiresAt,
        nextAction: "purchase_label",
      },
    };
  }
  if (
    current.value.view.state !== "ready" ||
    current.value.view.shipmentRevision !== input.request.shipmentRevision
  ) {
    return unavailableAction(input.request.action);
  }
  const purchased = await input.client.purchaseShippingLabel({
    merchantId: input.merchantId,
    expectedMerchantRevision: current.value.view.merchantRevision,
    idempotencyKey: input.idempotencyKey,
    shipmentId: input.shipmentId,
    shipmentRevision: input.request.shipmentRevision,
    labelRateId: input.request.labelRateId,
    labelAttemptId: `label_attempt_${input.idempotencyKey}`,
  });
  if (!purchased.ok) return unavailable(purchased.error);
  if (purchased.value.outcome === "rejected") {
    return {
      ok: false,
      error: { code: "shipping_operation_rejected", result: purchased.value },
    };
  }
  return readShippingOperations(
    input.client,
    input.merchantId,
    input.shipmentId,
  );
}

async function readShippingOperationsState(
  client: ShippingOperationsClient,
  merchantId: string,
  shipmentId: string,
): Promise<ShippingOperationResult<ShippingOperationsState>> {
  const snapshot = await client.readSnapshot(merchantId);
  if (!snapshot.ok) return unavailable(snapshot.error);
  const shipment = uniqueFirstPartyShipment(
    snapshot.value.resources.shipments,
    shipmentId,
  );
  return shipment === undefined
    ? { ok: false, error: { code: "shipment_not_found", shipmentId } }
    : {
        ok: true,
        value: {
          view: shipmentView(
            snapshot.value.merchantRevision,
            merchantId,
            shipment,
          ),
        },
      };
}

function uniqueFirstPartyShipment(
  shipments: readonly CommerceShipmentV1[],
  shipmentId: string,
): CommerceFirstPartyShipmentV1 | undefined {
  let match: CommerceFirstPartyShipmentV1 | undefined;
  for (const shipment of shipments) {
    if (shipment.id !== shipmentId || shipment.kind !== "first_party") continue;
    if (match !== undefined) return undefined;
    match = shipment;
  }
  return match;
}

function shipmentView(
  merchantRevision: number,
  merchantId: string,
  shipment: CommerceFirstPartyShipmentV1,
): ShippingOperationsView {
  const base: ShippingOperationsBase = {
    schemaVersion: "satyr.shipping-operations.v1",
    merchantRevision,
    shipmentId: commerceCanonicalResourceId(merchantId, shipment.id),
    shipmentRevision: shipment.revision,
    package: {
      weightGrams: shipment.package.weight.grams,
      lengthMillimeters: shipment.package.dimensions.lengthMillimeters,
      widthMillimeters: shipment.package.dimensions.widthMillimeters,
      heightMillimeters: shipment.package.dimensions.heightMillimeters,
    },
  };
  switch (shipment.lifecycle.state) {
    case "ready":
      return { ...base, state: "ready", nextAction: "quote_label_rate" };
    case "label_purchased":
      return {
        ...base,
        state: "label_purchased",
        trackingNumber: shipment.lifecycle.trackingNumber,
        purchasedAt: shipment.lifecycle.purchasedAt,
        nextAction: "hand_to_carrier",
      };
    case "in_transit":
      return {
        ...base,
        state: "in_transit",
        trackingNumber: shipment.lifecycle.trackingNumber,
        handedOverAt: shipment.lifecycle.handedOverAt,
        latestEvent: latestTrackingEvent(shipment),
        nextAction: "await_delivery",
      };
    case "delivered":
      return {
        ...base,
        state: "delivered",
        trackingNumber: shipment.lifecycle.trackingNumber,
        handedOverAt: shipment.lifecycle.handedOverAt,
        deliveredAt: shipment.lifecycle.deliveredAt,
        latestEvent: latestTrackingEvent(shipment),
        nextAction: "complete",
      };
  }
}

function latestTrackingEvent(
  shipment: CommerceFirstPartyShipmentV1,
): Readonly<{ kind: string; occurredAt: string; location: string }> {
  const event = shipment.events[shipment.events.length - 1];
  if (event === undefined)
    throw new Error("Shipment lifecycle has no tracking event");
  return {
    kind: event.kind.kind,
    occurredAt: event.occurredAt,
    location: event.location,
  };
}

function unavailable(
  error: CommerceClientError,
): ShippingOperationResult<never> {
  return { ok: false, error: { code: "underclerk_unavailable", cause: error } };
}

function unavailableAction(
  action: ShippingOperationRequest["action"],
): ShippingOperationResult<never> {
  return {
    ok: false,
    error: { code: "shipping_operation_unavailable", action },
  };
}
