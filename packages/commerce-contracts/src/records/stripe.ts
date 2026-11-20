// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import {
  OpenObject,
  SafeInteger,
  recordParser,
} from "@purin-labs/contract-schema";
import { commerceBoundaryContextSchema } from "./lab.ts";

export const stripePaymentStateV20260225Schema = Type.Union([
  OpenObject({ kind: Type.Literal("pending") }),
  OpenObject({ kind: Type.Literal("authorized") }),
  OpenObject({ kind: Type.Literal("captured") }),
  OpenObject({ kind: Type.Literal("failed"), reason: Type.String() }),
  OpenObject({
    kind: Type.Literal("partially_refunded"),
    amountMinor: SafeInteger,
  }),
  OpenObject({ kind: Type.Literal("refunded") }),
]);
export type StripePaymentStateV20260225 = Static<
  typeof stripePaymentStateV20260225Schema
>;

export const stripePaymentV20260225Schema = OpenObject({
  id: Type.String(),
  orderId: Type.String(),
  amountMinor: SafeInteger,
  currency: Type.String(),
  state: stripePaymentStateV20260225Schema,
});
export type StripePaymentV20260225 = Static<
  typeof stripePaymentV20260225Schema
>;

export const stripePaymentEnvelopeV20260225Schema = OpenObject({
  apiVersion: Type.String(),
  livemode: Type.Boolean(),
  context: commerceBoundaryContextSchema,
  payment: stripePaymentV20260225Schema,
});
export type StripePaymentEnvelopeV20260225 = Static<
  typeof stripePaymentEnvelopeV20260225Schema
>;

// Parsers of the records above (Plan 78 step 2).
export const parseStripePaymentStateV20260225 = recordParser(
  stripePaymentStateV20260225Schema,
);
export const parseStripePaymentV20260225 = recordParser(
  stripePaymentV20260225Schema,
);
export const parseStripePaymentEnvelopeV20260225 = recordParser(
  stripePaymentEnvelopeV20260225Schema,
);
