import {
  OpenObject,
  parseContract,
  type ContractDecodeResult,
  type ContractRejection,
} from "./schema.ts";
import { Type, type Static } from "typebox";
import type { StrictUnion } from "@purin-labs/type-utils";
import { isRecord } from "@purin-labs/std";
import { Value } from "typebox/value";

import { trimmedIdentityTextSchema } from "./identity-text.ts";
function entityIdentity<Brand extends string>() {
  return Type.Unsafe<string & { readonly __brand: Brand }>(
    trimmedIdentityTextSchema,
  );
}
export const systemCommerceEntityRefSchema = Type.Union([
  OpenObject({
    typeId: Type.Literal("location"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"LocationEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("product"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"ProductEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("sellable_variant"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"SellableVariantEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("offer"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"OfferEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("inventory_item"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"InventoryItemEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("stock_policy"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"StockPolicyEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("menu"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"MenuEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("recipe_revision"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"RecipeRevisionEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("preparation_ticket"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"PreparationTicketEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("production_batch"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"ProductionBatchEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("order"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"OrderEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("payment"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"PaymentEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("fulfillment"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"FulfillmentEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("shipment"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"ShipmentEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("sales_channel"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"SalesChannelEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("inventory_position"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"InventoryPositionEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("inventory_movement"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"InventoryMovementEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("inventory_lot"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"InventoryLotEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("inventory_consumption_plan"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"InventoryConsumptionPlanEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("inventory_consumption_requirement"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"InventoryConsumptionRequirementEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("modifier_group_revision"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"ModifierGroupRevisionEntityId">(),
  }),
  OpenObject({
    typeId: Type.Literal("preparation_station"),
    origin: Type.Literal("system"),
    entityId: entityIdentity<"PreparationStationEntityId">(),
  }),
]);
export const customCommerceEntityRefSchema = OpenObject({
  origin: Type.Literal("custom"),
  typeId: entityIdentity<"CustomCommerceEntityTypeId">(),
  entityId: entityIdentity<"CustomCommerceEntityId">(),
});
export const commerceEntityRefSchema = Type.Union([
  systemCommerceEntityRefSchema,
  customCommerceEntityRefSchema,
]);
export type SystemCommerceEntityRef = StrictUnion<
  Static<typeof systemCommerceEntityRefSchema>
>;
export type CustomCommerceEntityRef = Static<
  typeof customCommerceEntityRefSchema
>;
export type CommerceEntityRef = StrictUnion<
  Static<typeof commerceEntityRefSchema>
>;
const identityFields: Readonly<Record<string, string>> = {
  location: "LocationEntityId",
  product: "ProductEntityId",
  sellable_variant: "SellableVariantEntityId",
  offer: "OfferEntityId",
  inventory_item: "InventoryItemEntityId",
  stock_policy: "StockPolicyEntityId",
  menu: "MenuEntityId",
  recipe_revision: "RecipeRevisionEntityId",
  preparation_ticket: "PreparationTicketEntityId",
  production_batch: "ProductionBatchEntityId",
  order: "OrderEntityId",
  payment: "PaymentEntityId",
  fulfillment: "FulfillmentEntityId",
  shipment: "ShipmentEntityId",
  sales_channel: "SalesChannelEntityId",
  inventory_position: "InventoryPositionEntityId",
  inventory_movement: "InventoryMovementEntityId",
  inventory_lot: "InventoryLotEntityId",
  inventory_consumption_plan: "InventoryConsumptionPlanEntityId",
  inventory_consumption_requirement: "InventoryConsumptionRequirementEntityId",
  modifier_group_revision: "ModifierGroupRevisionEntityId",
  preparation_station: "PreparationStationEntityId",
};
export function parseCommerceEntityRef(
  value: unknown,
): ContractDecodeResult<CommerceEntityRef> {
  const input = isRecord(value)
    ? { origin: value.origin, typeId: value.typeId, entityId: value.entityId }
    : value;
  return parseContract(
    commerceEntityRefSchema,
    input,
    rejectReference.bind(null, input),
  );
}
function rejectReference(input: unknown): ContractRejection {
  if (
    isRecord(input) &&
    typeof input.entityId === "string" &&
    typeof input.typeId === "string"
  ) {
    if (input.origin === "custom") {
      if (!Value.Check(trimmedIdentityTextSchema, input.typeId))
        return invalidIdentity("CustomCommerceEntityTypeId");
      if (!Value.Check(trimmedIdentityTextSchema, input.entityId))
        return invalidIdentity("CustomCommerceEntityId");
    }
    if (
      input.origin === "system" &&
      Object.hasOwn(identityFields, input.typeId) &&
      !Value.Check(trimmedIdentityTextSchema, input.entityId)
    ) {
      return invalidIdentity(identityFields[input.typeId]!);
    }
  }
  return {
    code: "parse",
    reason: "invalid entity reference shape",
    details: null,
  };
}
function invalidIdentity(field: string): ContractRejection {
  return {
    code: "invalid_identity",
    reason: "invalid entity reference identity",
    details: { field },
  };
}
