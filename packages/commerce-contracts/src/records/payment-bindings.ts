import { Type, type Static } from "typebox";
import { OpenObject, PositiveInteger, SafeInteger, StrictObject } from "@purin-labs/contract-schema";
import { identityTextSchema } from "./commerce-fields.ts";
import { countryCodeTextSchema, currencyCodeTextSchema } from "./fields.ts";
import { integrationAccountIdSchema } from "./identifiers.ts";
import { currencyCodeSchema } from "./money.ts";

const countryCodeSchema = Type.String();

const paymentEnvironmentSchema = Type.Union([
  Type.Literal("development"),
  Type.Literal("production"),
]);
export type PaymentEnvironment = Static<typeof paymentEnvironmentSchema>;

export const paymentProviderAccountBindingSchema = OpenObject({
  integrationAccountId: integrationAccountIdSchema,
  providerAccountId: Type.String(),
  environment: paymentEnvironmentSchema,
  capabilityRevision: SafeInteger,
  country: countryCodeSchema,
  currency: currencyCodeSchema,
});
export type PaymentProviderAccountBinding = Static<
  typeof paymentProviderAccountBindingSchema
>;

/** The provider account of a checkout payment (`parsePaymentProviderAccountBinding`). */
const paymentAccountRecordSchema = StrictObject({
  integrationAccountId: identityTextSchema,
  providerAccountId: identityTextSchema,
  environment: paymentEnvironmentSchema,
  capabilityRevision: PositiveInteger,
  country: countryCodeTextSchema,
  currency: currencyCodeTextSchema,
});

const stripeOnlineCollectionSchema = Type.Union([
  Type.Literal("embedded_tokenization"),
  Type.Literal("hosted_redirect"),
]);

const gmoPgOnlineCollectionSchema = Type.Union([
  Type.Literal("embedded_tokenization"),
  Type.Literal("hosted_redirect"),
]);

export const onlinePaymentBindingSchema = Type.Union([
  StrictObject({
    provider: Type.Literal("stripe_online"),
    account: paymentAccountRecordSchema,
    collection: stripeOnlineCollectionSchema,
  }),
  StrictObject({
    provider: Type.Literal("gmo_pg_online"),
    account: paymentAccountRecordSchema,
    collection: gmoPgOnlineCollectionSchema,
  }),
  StrictObject({
    provider: Type.Literal("square_online"),
    account: paymentAccountRecordSchema,
    applicationId: identityTextSchema,
    locationId: identityTextSchema,
  }),
]);
export type OnlinePaymentBinding = Static<typeof onlinePaymentBindingSchema>;

/**
 * How a Square counter payment is collected. `server_terminal` sends the
 * payment to a paired Square Terminal (Plan 33C). `client_app_handoff` hands
 * the payment to the Square Point of Sale app on the same iPad, which takes it
 * on a Square Reader (Plan 90 Phase 3B). Both stay the `square_terminal`
 * provider, so a stored payment attempt keeps its provider value.
 */
const squareServerTerminalTransportSchema =
  Type.Literal("server_terminal");
const squarePosAppTransportSchema = Type.Literal("client_app_handoff");
const squareTerminalTransportSchema = Type.Union([
  squareServerTerminalTransportSchema,
  squarePosAppTransportSchema,
]);
export type SquareTerminalTransport = Static<
  typeof squareTerminalTransportSchema
>;

const gmoSteraTransportSchema = Type.Literal("lan_gateway");
export type GmoSteraTransport = Static<typeof gmoSteraTransportSchema>;

export const inPersonTerminalTransportSchema = Type.Union([
  squareTerminalTransportSchema,
  gmoSteraTransportSchema,
]);
export type InPersonTerminalTransport = Static<
  typeof inPersonTerminalTransportSchema
>;

export const inPersonPaymentBindingSchema = Type.Union([
  StrictObject({
    provider: Type.Literal("square_terminal"),
    account: paymentAccountRecordSchema,
    locationId: identityTextSchema,
    deviceId: identityTextSchema,
    transport: squareServerTerminalTransportSchema,
  }),
  StrictObject({
    provider: Type.Literal("square_terminal"),
    account: paymentAccountRecordSchema,
    locationId: identityTextSchema,
    transport: squarePosAppTransportSchema,
  }),
  StrictObject({
    provider: Type.Literal("gmo_stera"),
    account: paymentAccountRecordSchema,
    locationId: identityTextSchema,
    gatewayId: identityTextSchema,
    deviceSourceKey: identityTextSchema,
    transport: gmoSteraTransportSchema,
  }),
]);
export type InPersonPaymentBinding = Static<
  typeof inPersonPaymentBindingSchema
>;

export const checkoutPaymentProviderBindingSchema = Type.Union([
  onlinePaymentBindingSchema,
  inPersonPaymentBindingSchema,
]);
export type CheckoutPaymentProviderBinding = Static<
  typeof checkoutPaymentProviderBindingSchema
>;

export const inPersonPaymentMethodSchema = Type.Union([
  Type.Literal("card"),
  Type.Literal("felica"),
  Type.Literal("qr_code"),
]);
export type InPersonPaymentMethod = Static<typeof inPersonPaymentMethodSchema>;
