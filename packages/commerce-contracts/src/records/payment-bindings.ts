import { Type, type Static } from "typebox";
import { OpenObject, PositiveInteger, SafeInteger, StrictObject } from "../schema.ts";
import { identityTextSchema } from "./commerce-fields.ts";
import { countryCodeTextSchema, currencyCodeTextSchema } from "./fields.ts";
import { integrationAccountIdSchema } from "./identifiers.ts";
import { currencyCodeSchema } from "./money.ts";

const countryCodeSchema = Type.String();

export const paymentEnvironmentSchema = Type.Union([
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
export const paymentAccountRecordSchema = StrictObject({
  integrationAccountId: identityTextSchema,
  providerAccountId: identityTextSchema,
  environment: paymentEnvironmentSchema,
  capabilityRevision: PositiveInteger,
  country: countryCodeTextSchema,
  currency: currencyCodeTextSchema,
});

export const stripeOnlineCollectionSchema = Type.Union([
  Type.Literal("embedded_tokenization"),
  Type.Literal("hosted_redirect"),
]);
export type StripeOnlineCollection = Static<
  typeof stripeOnlineCollectionSchema
>;

export const gmoPgOnlineCollectionSchema = Type.Union([
  Type.Literal("embedded_tokenization"),
  Type.Literal("hosted_redirect"),
]);
export type GmoPgOnlineCollection = Static<typeof gmoPgOnlineCollectionSchema>;

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
 * Square Terminal connected mode. Plan 33C ships server-controlled
 * collection only; a POS-app handoff is a different ceremony and would need
 * its own measured slice.
 */
export const squareTerminalTransportSchema = Type.Literal("server_terminal");
export type SquareTerminalTransport = Static<
  typeof squareTerminalTransportSchema
>;

export const gmoSteraTransportSchema = Type.Literal("lan_gateway");
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
    transport: squareTerminalTransportSchema,
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
