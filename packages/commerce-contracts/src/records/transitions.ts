// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { OpenObject, SafeInteger } from "@purin-labs/contract-schema";
import { resourceIdSchema } from "./identifiers.ts";
import { currencyCodeSchema } from "./money.ts";
import { commerceTimestampSchema } from "./provenance.ts";

const commerceCueFactSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("payment_failed"),
    orderId: resourceIdSchema,
    paymentId: resourceIdSchema,
    amountMinor: SafeInteger,
    currency: currencyCodeSchema,
    reason: Type.String(),
  }),
  OpenObject({
    kind: Type.Literal("inventory_shortage"),
    orderId: resourceIdSchema,
    sku: Type.String(),
    requested: SafeInteger,
    available: SafeInteger,
    locationId: resourceIdSchema,
  }),
  OpenObject({
    kind: Type.Literal("order_unshipped"),
    orderId: resourceIdSchema,
    fulfillmentId: resourceIdSchema,
    expectedBy: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("tracking_stalled"),
    orderId: resourceIdSchema,
    shipmentId: resourceIdSchema,
    trackingNumber: Type.String(),
    lastEventAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("delivery_exception"),
    orderId: resourceIdSchema,
    shipmentId: resourceIdSchema,
    trackingNumber: Type.String(),
    status: Type.String(),
    reason: Type.String(),
  }),
  OpenObject({
    kind: Type.Literal("cancellation_refund_proposed"),
    orderId: resourceIdSchema,
    paymentId: resourceIdSchema,
    amountMinor: SafeInteger,
    currency: currencyCodeSchema,
    reason: Type.String(),
  }),
]);
export type CommerceCueFact = Static<typeof commerceCueFactSchema>;
