// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiDraftOrders from "@seams/commerce-contracts/records/api-draft-orders";
import type {
  CancelCommerceDraftOrderV1,
  CommerceDraftOrderLineV1,
  CreateCommerceDraftOrderV1,
  CommerceManualTenderV1,
  MarkCommerceDraftOrderPaidV1,
  SendCommerceDraftInvoiceV1,
  CommerceDraftInvoiceV1,
  CommerceDraftOrderBuyerV1,
  UpdateCommerceDraftOrderV1,
  CommerceDraftOrderCommandV1,
  CommerceDraftOrderLifecycleV1,
  CommerceDraftOrderV1,
  CommerceDraftOrderViewV1,
} from "./draft-orders.ts";
export type CancelCommerceDraftOrderV1Parity = Assert<
  Equal<
    CancelCommerceDraftOrderV1,
    apiDraftOrders.CancelCommerceDraftOrderV1
  >
>;
export type CommerceDraftOrderLineV1Parity = Assert<
  Equal<CommerceDraftOrderLineV1, apiDraftOrders.CommerceDraftOrderLineV1>
>;
export type CreateCommerceDraftOrderV1Parity = Assert<
  Equal<
    CreateCommerceDraftOrderV1,
    apiDraftOrders.CreateCommerceDraftOrderV1
  >
>;
export type CommerceManualTenderV1Parity = Assert<
  Equal<CommerceManualTenderV1, apiDraftOrders.CommerceManualTenderV1>
>;
export type MarkCommerceDraftOrderPaidV1Parity = Assert<
  Equal<
    MarkCommerceDraftOrderPaidV1,
    apiDraftOrders.MarkCommerceDraftOrderPaidV1
  >
>;
export type SendCommerceDraftInvoiceV1Parity = Assert<
  Equal<
    SendCommerceDraftInvoiceV1,
    apiDraftOrders.SendCommerceDraftInvoiceV1
  >
>;
export type CommerceDraftInvoiceV1Parity = Assert<
  Equal<CommerceDraftInvoiceV1, apiDraftOrders.CommerceDraftInvoiceV1>
>;
export type CommerceDraftOrderBuyerV1Parity = Assert<
  Equal<CommerceDraftOrderBuyerV1, apiDraftOrders.CommerceDraftOrderBuyerV1>
>;
export type UpdateCommerceDraftOrderV1Parity = Assert<
  Equal<
    UpdateCommerceDraftOrderV1,
    apiDraftOrders.UpdateCommerceDraftOrderV1
  >
>;
export type CommerceDraftOrderCommandV1Parity = Assert<
  Equal<
    CommerceDraftOrderCommandV1,
    apiDraftOrders.CommerceDraftOrderCommandV1
  >
>;
export type CommerceDraftOrderLifecycleV1Parity = Assert<
  Equal<
    CommerceDraftOrderLifecycleV1,
    apiDraftOrders.CommerceDraftOrderLifecycleV1
  >
>;
export type CommerceDraftOrderV1Parity = Assert<
  Equal<CommerceDraftOrderV1, apiDraftOrders.CommerceDraftOrderV1>
>;
export type CommerceDraftOrderViewV1Parity = Assert<
  Equal<CommerceDraftOrderViewV1, apiDraftOrders.CommerceDraftOrderViewV1>
>;
