// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";

/**
 * `CommerceCustomerV1["state"]`.
 */
const customerStateSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("erased"),
]);
export type CustomerState = Static<typeof customerStateSchema>;

/**
 * `CommerceDiscountV1["status"]`.
 */
const discountStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("inactive"),
]);
export type DiscountStatus = Static<typeof discountStatusSchema>;

/**
 * `CommerceDraftOrderV1["lifecycle"]["state"]`.
 */
const draftOrderStateSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("invoiced"),
  Type.Literal("cancelled"),
]);
export type DraftOrderState = Static<typeof draftOrderStateSchema>;

/**
 * `CommerceReturnV1["lifecycle"]["state"]`.
 */
const returnStateSchema = Type.Union([
  Type.Literal("requested"),
  Type.Literal("authorized"),
  Type.Literal("rejected"),
  Type.Literal("received"),
  Type.Literal("closed"),
]);
export type ReturnState = Static<typeof returnStateSchema>;

/**
 * `CommerceStoredValueAccountV1["status"]`.
 */
const storedValueAccountStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("disabled"),
]);
export type StoredValueAccountStatus = Static<
  typeof storedValueAccountStatusSchema
>;

/**
 * `CommerceWebhookSubscriptionV1["state"]`.
 */
const webhookSubscriptionStateSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("failing"),
]);
export type WebhookSubscriptionState = Static<
  typeof webhookSubscriptionStateSchema
>;

/**
 * The `status` of a purchase request on the purchasing plugin's
 * `replenishment_queue` list. Staff move it to `requested` and `expected`;
 * receipts and time move it to `partial`, `late` and `received`.
 */
const purchaseRequestStatusSchema = Type.Union([
  Type.Literal("needs_review"),
  Type.Literal("requested"),
  Type.Literal("expected"),
  Type.Literal("partial"),
  Type.Literal("late"),
  Type.Literal("received"),
]);
export type PurchaseRequestStatus = Static<typeof purchaseRequestStatusSchema>;
