import type {
  ShipmentLabelRateSnapshot,
  ShippingQuoteSnapshot,
  ShippingRouteBinding,
} from "@purin-labs/commerce-contracts";

type ShippingRouteAuthority = Readonly<{
  routeBinding: ShippingRouteBinding;
}>;

export type ShippingLabelPurchaseResult = Readonly<{
  providerLabelReference: string;
  trackingNumber: string;
}>;

export type ShippingTrackingEventInput = ShippingRouteAuthority &
  Readonly<{
    shipmentId: string;
    serviceCode: string;
    state: "in_transit" | "delivered";
    providerEventId: string;
    occurredAt: string;
    location: string;
  }>;

export type ShippingLabelRateRequest = ShippingRouteAuthority &
  Readonly<{
    shipmentId: string;
    shipmentRevision: number;
    acceptedCarrierRate: ShippingQuoteSnapshot["carrierRate"];
    packagePlanDigest: string;
    idempotencyKey: string;
    quotedAt: string;
  }>;

export type ShippingLabelRateResult =
  | Readonly<{ kind: "quoted"; rate: ShipmentLabelRateSnapshot }>
  | Readonly<{ kind: "unavailable_route" }>;

export type ShippingGateway = Readonly<{
  quoteLabelRate: (input: ShippingLabelRateRequest) => ShippingLabelRateResult;
  purchaseLabel: (
    input: ShippingRouteAuthority &
      Readonly<{
        shipmentId: string;
        serviceCode: string;
        labelAttemptId: string;
        rateReference: string;
        purchasedAt: string;
      }>,
  ) => ShippingLabelPurchaseResult;
  verifyTrackingEvent: (
    input: ShippingTrackingEventInput &
      Readonly<{
        signature: string;
      }>,
  ) => boolean;
}>;
