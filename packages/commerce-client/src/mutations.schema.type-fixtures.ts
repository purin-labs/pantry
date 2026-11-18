// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiMutations from "@seams/commerce-contracts/records/api-mutations";
import type {
  AcknowledgeCommerceDeliveryV1,
  CommerceAggregateObservationV1,
  CommerceMutationErrorV1,
  CommerceClientError,
  CommerceObservationV1,
  CommerceDeliveryV1,
  CommerceDeliveryAcknowledgementV1,
  CommerceMigrationInventoryV2,
  CommerceMutationPrincipalV1,
  CommerceMutationReceiptV1,
  CommerceMutationResultV1,
  CommerceReceivedDeliveryV1,
} from "./mutations.ts";
export type AcknowledgeCommerceDeliveryV1Parity = Assert<
  Equal<
    AcknowledgeCommerceDeliveryV1,
    apiMutations.AcknowledgeCommerceDeliveryV1
  >
>;
export type CommerceAggregateObservationV1Parity = Assert<
  Equal<
    CommerceAggregateObservationV1,
    apiMutations.CommerceAggregateObservationV1
  >
>;
export type CommerceMutationErrorV1Parity = Assert<
  Equal<CommerceMutationErrorV1, apiMutations.CommerceMutationErrorV1>
>;
export type CommerceClientErrorParity = Assert<
  Equal<CommerceClientError, apiMutations.CommerceClientError>
>;
export type CommerceObservationV1Parity = Assert<
  Equal<
    CommerceObservationV1,
    apiMutations.CommerceObservationV1
  >
>;
export type CommerceDeliveryV1Parity = Assert<
  Equal<CommerceDeliveryV1, apiMutations.CommerceDeliveryV1>
>;
export type CommerceDeliveryAcknowledgementV1Parity = Assert<
  Equal<
    CommerceDeliveryAcknowledgementV1,
    apiMutations.CommerceDeliveryAcknowledgementV1
  >
>;
export type CommerceMigrationInventoryV2Parity = Assert<
  Equal<
    CommerceMigrationInventoryV2,
    apiMutations.CommerceMigrationInventoryV2
  >
>;
export type CommerceMutationPrincipalV1Parity = Assert<
  Equal<
    CommerceMutationPrincipalV1,
    apiMutations.CommerceMutationPrincipalV1
  >
>;
export type CommerceMutationReceiptV1Parity = Assert<
  Equal<CommerceMutationReceiptV1, apiMutations.CommerceMutationReceiptV1>
>;
export type CommerceMutationResultV1Parity = Assert<
  Equal<CommerceMutationResultV1, apiMutations.CommerceMutationResultV1>
>;
export type CommerceReceivedDeliveryV1Parity = Assert<
  Equal<CommerceReceivedDeliveryV1, apiMutations.CommerceReceivedDeliveryV1>
>;
