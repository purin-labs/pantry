// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { OpenObject, SafeInteger } from "@purin-labs/contract-schema";
import { moneySchema } from "./money.ts";

const attributeDefinitionIdSchema = Type.Unsafe<
  string & { readonly __brand: "AttributeDefinitionId" }
>(Type.String());
export type AttributeDefinitionId = Static<typeof attributeDefinitionIdSchema>;

export const attributeDefinitionRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "AttributeDefinitionRevision" }
>(SafeInteger);
export type AttributeDefinitionRevision = Static<
  typeof attributeDefinitionRevisionSchema
>;

const commerceCommandIdSchema = Type.Unsafe<
  string & { readonly __brand: "CommerceCommandId" }
>(Type.String());
export type CommerceCommandId = Static<typeof commerceCommandIdSchema>;

export const commerceEntityRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "CommerceEntityRevision" }
>(SafeInteger);
export type CommerceEntityRevision = Static<
  typeof commerceEntityRevisionSchema
>;

export const commerceListEntryIdSchema = Type.Unsafe<
  string & { readonly __brand: "CommerceListEntryId" }
>(Type.String());
export type CommerceListEntryId = Static<typeof commerceListEntryIdSchema>;

export const commerceListEntryRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "CommerceListEntryRevision" }
>(SafeInteger);
export type CommerceListEntryRevision = Static<
  typeof commerceListEntryRevisionSchema
>;

const commerceListIdSchema = Type.Unsafe<
  string & { readonly __brand: "CommerceListId" }
>(Type.String());
export type CommerceListId = Static<typeof commerceListIdSchema>;

export const commerceListRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "CommerceListRevision" }
>(SafeInteger);
export type CommerceListRevision = Static<typeof commerceListRevisionSchema>;

export const commerceMerchantIdSchema = Type.Unsafe<
  string & { readonly __brand: "CommerceMerchantId" }
>(Type.String());
export type CommerceMerchantId = Static<typeof commerceMerchantIdSchema>;

const customCommerceEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "CustomCommerceEntityId" }
>(Type.String());
export type CustomCommerceEntityId = Static<
  typeof customCommerceEntityIdSchema
>;

const customCommerceEntityTypeIdSchema = Type.Unsafe<
  string & { readonly __brand: "CustomCommerceEntityTypeId" }
>(Type.String());
export type CustomCommerceEntityTypeId = Static<
  typeof customCommerceEntityTypeIdSchema
>;

export const customEntityTypeRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "CustomEntityTypeRevision" }
>(SafeInteger);
export type CustomEntityTypeRevision = Static<
  typeof customEntityTypeRevisionSchema
>;

const fulfillmentEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "FulfillmentEntityId" }
>(Type.String());
export type FulfillmentEntityId = Static<typeof fulfillmentEntityIdSchema>;

export { integrationAccountIdSchema } from "@purin-labs/contract-schema";

const inventoryConsumptionPlanEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "InventoryConsumptionPlanEntityId" }
>(Type.String());
export type InventoryConsumptionPlanEntityId = Static<
  typeof inventoryConsumptionPlanEntityIdSchema
>;

const inventoryConsumptionRequirementEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "InventoryConsumptionRequirementEntityId" }
>(Type.String());
export type InventoryConsumptionRequirementEntityId = Static<
  typeof inventoryConsumptionRequirementEntityIdSchema
>;

const inventoryItemEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "InventoryItemEntityId" }
>(Type.String());
export type InventoryItemEntityId = Static<typeof inventoryItemEntityIdSchema>;

const inventoryLotEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "InventoryLotEntityId" }
>(Type.String());
export type InventoryLotEntityId = Static<typeof inventoryLotEntityIdSchema>;

const inventoryMovementEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "InventoryMovementEntityId" }
>(Type.String());
export type InventoryMovementEntityId = Static<
  typeof inventoryMovementEntityIdSchema
>;

const inventoryPositionEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "InventoryPositionEntityId" }
>(Type.String());
export type InventoryPositionEntityId = Static<
  typeof inventoryPositionEntityIdSchema
>;

const locationEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "LocationEntityId" }
>(Type.String());
export type LocationEntityId = Static<typeof locationEntityIdSchema>;

export const menuEntryIdSchema = Type.String();

export const menuIdSchema = Type.String();

export const menuSectionIdSchema = Type.String();

const merchantExtensionSchemaRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "MerchantExtensionSchemaRevision" }
>(SafeInteger);
export type MerchantExtensionSchemaRevision = Static<
  typeof merchantExtensionSchemaRevisionSchema
>;

export const modifierGroupIdSchema = Type.String();

const modifierGroupRevisionEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "ModifierGroupRevisionEntityId" }
>(Type.String());
export type ModifierGroupRevisionEntityId = Static<
  typeof modifierGroupRevisionEntityIdSchema
>;

export const modifierOptionIdSchema = Type.String();

const offerEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "OfferEntityId" }
>(Type.String());
export type OfferEntityId = Static<typeof offerEntityIdSchema>;

const orderEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "OrderEntityId" }
>(Type.String());
export type OrderEntityId = Static<typeof orderEntityIdSchema>;

export {
  organisationIdSchema,
  type OrganisationId,
} from "@purin-labs/contract-schema";

const paymentEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "PaymentEntityId" }
>(Type.String());
export type PaymentEntityId = Static<typeof paymentEntityIdSchema>;

const preparationStationEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "PreparationStationEntityId" }
>(Type.String());
export type PreparationStationEntityId = Static<
  typeof preparationStationEntityIdSchema
>;

export const preparationStationIdSchema = Type.String();

const preparationTicketEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "PreparationTicketEntityId" }
>(Type.String());
export type PreparationTicketEntityId = Static<
  typeof preparationTicketEntityIdSchema
>;

export const preparationTicketIdSchema = Type.String();

const productEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "ProductEntityId" }
>(Type.String());
export type ProductEntityId = Static<typeof productEntityIdSchema>;

const productionBatchEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "ProductionBatchEntityId" }
>(Type.String());
export type ProductionBatchEntityId = Static<
  typeof productionBatchEntityIdSchema
>;

export const productionBatchIdSchema = Type.String();

export const providerDeliveryIdSchema = Type.String();

const publishedCommerceSelectorIdSchema = Type.Unsafe<
  string & { readonly __brand: "PublishedCommerceSelectorId" }
>(Type.String());
export type PublishedCommerceSelectorId = Static<
  typeof publishedCommerceSelectorIdSchema
>;

const publishedCommerceSelectorRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "PublishedCommerceSelectorRevision" }
>(SafeInteger);
export type PublishedCommerceSelectorRevision = Static<
  typeof publishedCommerceSelectorRevisionSchema
>;

export const recipeIdSchema = Type.String();

const recipeRevisionEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "RecipeRevisionEntityId" }
>(Type.String());
export type RecipeRevisionEntityId = Static<
  typeof recipeRevisionEntityIdSchema
>;

export const resourceIdSchema = Type.String();

export const refundDutyAllocationSchema = OpenObject({
  orderLineId: resourceIdSchema,
  amount: moneySchema,
});

export const refundLineAllocationSchema = OpenObject({
  orderLineId: resourceIdSchema,
  amount: moneySchema,
});

export const refundTaxAllocationSchema = OpenObject({
  orderLineId: resourceIdSchema,
  amount: moneySchema,
});

const relationshipDefinitionIdSchema = Type.Unsafe<
  string & { readonly __brand: "RelationshipDefinitionId" }
>(Type.String());
export type RelationshipDefinitionId = Static<
  typeof relationshipDefinitionIdSchema
>;

const relationshipDefinitionRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "RelationshipDefinitionRevision" }
>(SafeInteger);
export type RelationshipDefinitionRevision = Static<
  typeof relationshipDefinitionRevisionSchema
>;

export const relationshipIdSchema = Type.Unsafe<
  string & { readonly __brand: "RelationshipId" }
>(Type.String());
export type RelationshipId = Static<typeof relationshipIdSchema>;

export const relationshipRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "RelationshipRevision" }
>(SafeInteger);
export type RelationshipRevision = Static<typeof relationshipRevisionSchema>;

const salesChannelEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "SalesChannelEntityId" }
>(Type.String());
export type SalesChannelEntityId = Static<typeof salesChannelEntityIdSchema>;

const savedCommerceViewIdSchema = Type.Unsafe<
  string & { readonly __brand: "SavedCommerceViewId" }
>(Type.String());
export type SavedCommerceViewId = Static<typeof savedCommerceViewIdSchema>;

const savedCommerceViewRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "SavedCommerceViewRevision" }
>(SafeInteger);
export type SavedCommerceViewRevision = Static<
  typeof savedCommerceViewRevisionSchema
>;

const sellableVariantEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "SellableVariantEntityId" }
>(Type.String());
export type SellableVariantEntityId = Static<
  typeof sellableVariantEntityIdSchema
>;

export const shipmentEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "ShipmentEntityId" }
>(Type.String());
export type ShipmentEntityId = Static<typeof shipmentEntityIdSchema>;

const stockPolicyEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "StockPolicyEntityId" }
>(Type.String());
export type StockPolicyEntityId = Static<typeof stockPolicyEntityIdSchema>;

const systemSchemaRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "SystemSchemaRevision" }
>(SafeInteger);
export type SystemSchemaRevision = Static<typeof systemSchemaRevisionSchema>;
