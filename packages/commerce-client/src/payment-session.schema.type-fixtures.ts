// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiPaymentSession from "@seams/commerce-contracts/records/api-payment-session";
import type {
  CreateCommerceBuyerPaymentSessionV1,
  CommercePaymentClientConfirmationV1,
  ReconcileCommerceBuyerPaymentV1,
  CommercePaymentPublicConfigurationV1,
  CommercePaymentPublicSessionV1,
  CommerceBuyerPaymentSessionV1,
  CommercePaymentMoneyV1,
  CommerceInPersonCollectionSessionV1,
  CommerceInPersonCollectionResultV1,
  CommercePaymentRefundResultV1,
  CommercePaymentSessionResultV1,
} from "./payment-session.ts";
export type CreateCommerceBuyerPaymentSessionV1Parity = Assert<
  Equal<
    CreateCommerceBuyerPaymentSessionV1,
    apiPaymentSession.CreateCommerceBuyerPaymentSessionV1
  >
>;
export type CommercePaymentClientConfirmationV1Parity = Assert<
  Equal<
    CommercePaymentClientConfirmationV1,
    apiPaymentSession.CommercePaymentClientConfirmationV1
  >
>;
export type ReconcileCommerceBuyerPaymentV1Parity = Assert<
  Equal<
    ReconcileCommerceBuyerPaymentV1,
    apiPaymentSession.ReconcileCommerceBuyerPaymentV1
  >
>;
export type CommercePaymentPublicConfigurationV1Parity = Assert<
  Equal<
    CommercePaymentPublicConfigurationV1,
    apiPaymentSession.CommercePaymentPublicConfigurationV1
  >
>;
export type CommercePaymentPublicSessionV1Parity = Assert<
  Equal<
    CommercePaymentPublicSessionV1,
    apiPaymentSession.CommercePaymentPublicSessionV1
  >
>;
export type CommerceBuyerPaymentSessionV1Parity = Assert<
  Equal<
    CommerceBuyerPaymentSessionV1,
    apiPaymentSession.CommerceBuyerPaymentSessionV1
  >
>;
export type CommercePaymentMoneyV1Parity = Assert<
  Equal<CommercePaymentMoneyV1, apiPaymentSession.CommercePaymentMoneyV1>
>;
export type CommerceInPersonCollectionSessionV1Parity = Assert<
  Equal<
    CommerceInPersonCollectionSessionV1,
    apiPaymentSession.CommerceInPersonCollectionSessionV1
  >
>;
export type CommerceInPersonCollectionResultV1Parity = Assert<
  Equal<
    CommerceInPersonCollectionResultV1,
    apiPaymentSession.CommerceInPersonCollectionResultV1
  >
>;
export type CommercePaymentRefundResultV1Parity = Assert<
  Equal<
    CommercePaymentRefundResultV1,
    apiPaymentSession.CommercePaymentRefundResultV1
  >
>;
export type CommercePaymentSessionResultV1Parity = Assert<
  Equal<
    CommercePaymentSessionResultV1,
    apiPaymentSession.CommercePaymentSessionResultV1
  >
>;
