// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { OpenObject, SafeInteger, recordParser } from "../schema.ts";
import { moneySchema } from "./money.ts";

export const attributeDefinitionIdSchema = Type.Unsafe<
  string & { readonly __brand: "AttributeDefinitionId" }
>(Type.String());
export type AttributeDefinitionId = Static<typeof attributeDefinitionIdSchema>;

export const attributeDefinitionRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "AttributeDefinitionRevision" }
>(SafeInteger);
export type AttributeDefinitionRevision = Static<
  typeof attributeDefinitionRevisionSchema
>;

export const commerceCommandIdSchema = Type.Unsafe<
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

export const commerceListIdSchema = Type.Unsafe<
  string & { readonly __brand: "CommerceListId" }
>(Type.String());
export type CommerceListId = Static<typeof commerceListIdSchema>;

export const commerceListNameSchema = Type.Unsafe<
  string & { readonly __brand: "CommerceListName" }
>(Type.String());
export type CommerceListName = Static<typeof commerceListNameSchema>;

export const commerceListRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "CommerceListRevision" }
>(SafeInteger);
export type CommerceListRevision = Static<typeof commerceListRevisionSchema>;

export const commerceMerchantIdSchema = Type.Unsafe<
  string & { readonly __brand: "CommerceMerchantId" }
>(Type.String());
export type CommerceMerchantId = Static<typeof commerceMerchantIdSchema>;

export const commerceViewNameSchema = Type.Unsafe<
  string & { readonly __brand: "CommerceViewName" }
>(Type.String());
export type CommerceViewName = Static<typeof commerceViewNameSchema>;

export const customCommerceEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "CustomCommerceEntityId" }
>(Type.String());
export type CustomCommerceEntityId = Static<
  typeof customCommerceEntityIdSchema
>;

export const customCommerceEntityTypeIdSchema = Type.Unsafe<
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

export const fulfillmentEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "FulfillmentEntityId" }
>(Type.String());
export type FulfillmentEntityId = Static<typeof fulfillmentEntityIdSchema>;

export const integrationAccountIdSchema = Type.String();
export type IntegrationAccountId = Static<typeof integrationAccountIdSchema>;

export const inventoryConsumptionPlanEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "InventoryConsumptionPlanEntityId" }
>(Type.String());
export type InventoryConsumptionPlanEntityId = Static<
  typeof inventoryConsumptionPlanEntityIdSchema
>;

export const inventoryConsumptionRequirementEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "InventoryConsumptionRequirementEntityId" }
>(Type.String());
export type InventoryConsumptionRequirementEntityId = Static<
  typeof inventoryConsumptionRequirementEntityIdSchema
>;

export const inventoryItemEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "InventoryItemEntityId" }
>(Type.String());
export type InventoryItemEntityId = Static<typeof inventoryItemEntityIdSchema>;

export const inventoryLotEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "InventoryLotEntityId" }
>(Type.String());
export type InventoryLotEntityId = Static<typeof inventoryLotEntityIdSchema>;

export const inventoryMovementEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "InventoryMovementEntityId" }
>(Type.String());
export type InventoryMovementEntityId = Static<
  typeof inventoryMovementEntityIdSchema
>;

export const inventoryPositionEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "InventoryPositionEntityId" }
>(Type.String());
export type InventoryPositionEntityId = Static<
  typeof inventoryPositionEntityIdSchema
>;

export const locationEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "LocationEntityId" }
>(Type.String());
export type LocationEntityId = Static<typeof locationEntityIdSchema>;

export const menuEntryIdSchema = Type.String();
export type MenuEntryId = Static<typeof menuEntryIdSchema>;

export const menuIdSchema = Type.String();
export type MenuId = Static<typeof menuIdSchema>;

export const menuSectionIdSchema = Type.String();
export type MenuSectionId = Static<typeof menuSectionIdSchema>;

export const merchantExtensionSchemaRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "MerchantExtensionSchemaRevision" }
>(SafeInteger);
export type MerchantExtensionSchemaRevision = Static<
  typeof merchantExtensionSchemaRevisionSchema
>;

export const modifierGroupIdSchema = Type.String();
export type ModifierGroupId = Static<typeof modifierGroupIdSchema>;

export const modifierGroupRevisionEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "ModifierGroupRevisionEntityId" }
>(Type.String());
export type ModifierGroupRevisionEntityId = Static<
  typeof modifierGroupRevisionEntityIdSchema
>;

export const modifierOptionIdSchema = Type.String();
export type ModifierOptionId = Static<typeof modifierOptionIdSchema>;

export const offerEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "OfferEntityId" }
>(Type.String());
export type OfferEntityId = Static<typeof offerEntityIdSchema>;

export const orderEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "OrderEntityId" }
>(Type.String());
export type OrderEntityId = Static<typeof orderEntityIdSchema>;

export const organisationIdSchema = Type.String();
export type OrganisationId = Static<typeof organisationIdSchema>;

export const paymentEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "PaymentEntityId" }
>(Type.String());
export type PaymentEntityId = Static<typeof paymentEntityIdSchema>;

export const preparationStationEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "PreparationStationEntityId" }
>(Type.String());
export type PreparationStationEntityId = Static<
  typeof preparationStationEntityIdSchema
>;

export const preparationStationIdSchema = Type.String();
export type PreparationStationId = Static<typeof preparationStationIdSchema>;

export const preparationTicketEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "PreparationTicketEntityId" }
>(Type.String());
export type PreparationTicketEntityId = Static<
  typeof preparationTicketEntityIdSchema
>;

export const preparationTicketIdSchema = Type.String();
export type PreparationTicketId = Static<typeof preparationTicketIdSchema>;

export const productEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "ProductEntityId" }
>(Type.String());
export type ProductEntityId = Static<typeof productEntityIdSchema>;

export const productionBatchEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "ProductionBatchEntityId" }
>(Type.String());
export type ProductionBatchEntityId = Static<
  typeof productionBatchEntityIdSchema
>;

export const productionBatchIdSchema = Type.String();
export type ProductionBatchId = Static<typeof productionBatchIdSchema>;

export const providerDeliveryIdSchema = Type.String();
export type ProviderDeliveryId = Static<typeof providerDeliveryIdSchema>;

export const publishedCommerceSelectorIdSchema = Type.Unsafe<
  string & { readonly __brand: "PublishedCommerceSelectorId" }
>(Type.String());
export type PublishedCommerceSelectorId = Static<
  typeof publishedCommerceSelectorIdSchema
>;

export const publishedCommerceSelectorRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "PublishedCommerceSelectorRevision" }
>(SafeInteger);
export type PublishedCommerceSelectorRevision = Static<
  typeof publishedCommerceSelectorRevisionSchema
>;

export const recipeIdSchema = Type.String();
export type RecipeId = Static<typeof recipeIdSchema>;

export const recipeRevisionEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "RecipeRevisionEntityId" }
>(Type.String());
export type RecipeRevisionEntityId = Static<
  typeof recipeRevisionEntityIdSchema
>;

export const resourceIdSchema = Type.String();
export type ResourceId = Static<typeof resourceIdSchema>;

export const refundDutyAllocationSchema = OpenObject({
  orderLineId: resourceIdSchema,
  amount: moneySchema,
});
export type RefundDutyAllocation = Static<typeof refundDutyAllocationSchema>;

export const refundLineAllocationSchema = OpenObject({
  orderLineId: resourceIdSchema,
  amount: moneySchema,
});
export type RefundLineAllocation = Static<typeof refundLineAllocationSchema>;

export const refundTaxAllocationSchema = OpenObject({
  orderLineId: resourceIdSchema,
  amount: moneySchema,
});
export type RefundTaxAllocation = Static<typeof refundTaxAllocationSchema>;

export const relationshipDefinitionIdSchema = Type.Unsafe<
  string & { readonly __brand: "RelationshipDefinitionId" }
>(Type.String());
export type RelationshipDefinitionId = Static<
  typeof relationshipDefinitionIdSchema
>;

export const relationshipDefinitionRevisionSchema = Type.Unsafe<
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

export const salesChannelEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "SalesChannelEntityId" }
>(Type.String());
export type SalesChannelEntityId = Static<typeof salesChannelEntityIdSchema>;

export const savedCommerceViewIdSchema = Type.Unsafe<
  string & { readonly __brand: "SavedCommerceViewId" }
>(Type.String());
export type SavedCommerceViewId = Static<typeof savedCommerceViewIdSchema>;

export const savedCommerceViewRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "SavedCommerceViewRevision" }
>(SafeInteger);
export type SavedCommerceViewRevision = Static<
  typeof savedCommerceViewRevisionSchema
>;

export const sellableVariantEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "SellableVariantEntityId" }
>(Type.String());
export type SellableVariantEntityId = Static<
  typeof sellableVariantEntityIdSchema
>;

export const shipmentEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "ShipmentEntityId" }
>(Type.String());
export type ShipmentEntityId = Static<typeof shipmentEntityIdSchema>;

export const stockPolicyEntityIdSchema = Type.Unsafe<
  string & { readonly __brand: "StockPolicyEntityId" }
>(Type.String());
export type StockPolicyEntityId = Static<typeof stockPolicyEntityIdSchema>;

export const systemSchemaRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "SystemSchemaRevision" }
>(SafeInteger);
export type SystemSchemaRevision = Static<typeof systemSchemaRevisionSchema>;

// Parsers of the records above (Plan 78 step 2).
export const parseAttributeDefinitionId = recordParser(
  attributeDefinitionIdSchema,
);
export const parseAttributeDefinitionRevision = recordParser(
  attributeDefinitionRevisionSchema,
);
export const parseCommerceCommandId = recordParser(commerceCommandIdSchema);
export const parseCommerceEntityRevision = recordParser(
  commerceEntityRevisionSchema,
);
export const parseCommerceListEntryId = recordParser(commerceListEntryIdSchema);
export const parseCommerceListEntryRevision = recordParser(
  commerceListEntryRevisionSchema,
);
export const parseCommerceListId = recordParser(commerceListIdSchema);
export const parseCommerceListName = recordParser(commerceListNameSchema);
export const parseCommerceListRevision = recordParser(
  commerceListRevisionSchema,
);
export const parseCommerceMerchantId = recordParser(commerceMerchantIdSchema);
export const parseCommerceViewName = recordParser(commerceViewNameSchema);
export const parseCustomCommerceEntityId = recordParser(
  customCommerceEntityIdSchema,
);
export const parseCustomCommerceEntityTypeId = recordParser(
  customCommerceEntityTypeIdSchema,
);
export const parseCustomEntityTypeRevision = recordParser(
  customEntityTypeRevisionSchema,
);
export const parseFulfillmentEntityId = recordParser(fulfillmentEntityIdSchema);
export const parseInventoryConsumptionPlanEntityId = recordParser(
  inventoryConsumptionPlanEntityIdSchema,
);
export const parseInventoryConsumptionRequirementEntityId = recordParser(
  inventoryConsumptionRequirementEntityIdSchema,
);
export const parseInventoryItemEntityId = recordParser(
  inventoryItemEntityIdSchema,
);
export const parseInventoryLotEntityId = recordParser(
  inventoryLotEntityIdSchema,
);
export const parseInventoryMovementEntityId = recordParser(
  inventoryMovementEntityIdSchema,
);
export const parseInventoryPositionEntityId = recordParser(
  inventoryPositionEntityIdSchema,
);
export const parseLocationEntityId = recordParser(locationEntityIdSchema);
export const parseMerchantExtensionSchemaRevision = recordParser(
  merchantExtensionSchemaRevisionSchema,
);
export const parseModifierGroupRevisionEntityId = recordParser(
  modifierGroupRevisionEntityIdSchema,
);
export const parseOfferEntityId = recordParser(offerEntityIdSchema);
export const parseOrderEntityId = recordParser(orderEntityIdSchema);
export const parsePaymentEntityId = recordParser(paymentEntityIdSchema);
export const parsePreparationStationEntityId = recordParser(
  preparationStationEntityIdSchema,
);
export const parsePreparationTicketEntityId = recordParser(
  preparationTicketEntityIdSchema,
);
export const parseProductEntityId = recordParser(productEntityIdSchema);
export const parseProductionBatchEntityId = recordParser(
  productionBatchEntityIdSchema,
);
export const parsePublishedCommerceSelectorId = recordParser(
  publishedCommerceSelectorIdSchema,
);
export const parsePublishedCommerceSelectorRevision = recordParser(
  publishedCommerceSelectorRevisionSchema,
);
export const parseRecipeRevisionEntityId = recordParser(
  recipeRevisionEntityIdSchema,
);
export const parseRefundDutyAllocation = recordParser(
  refundDutyAllocationSchema,
);
export const parseRefundLineAllocation = recordParser(
  refundLineAllocationSchema,
);
export const parseRefundTaxAllocation = recordParser(refundTaxAllocationSchema);
export const parseRelationshipDefinitionId = recordParser(
  relationshipDefinitionIdSchema,
);
export const parseRelationshipDefinitionRevision = recordParser(
  relationshipDefinitionRevisionSchema,
);
export const parseRelationshipId = recordParser(relationshipIdSchema);
export const parseRelationshipRevision = recordParser(
  relationshipRevisionSchema,
);
export const parseSalesChannelEntityId = recordParser(
  salesChannelEntityIdSchema,
);
export const parseSavedCommerceViewId = recordParser(savedCommerceViewIdSchema);
export const parseSavedCommerceViewRevision = recordParser(
  savedCommerceViewRevisionSchema,
);
export const parseSellableVariantEntityId = recordParser(
  sellableVariantEntityIdSchema,
);
export const parseShipmentEntityId = recordParser(shipmentEntityIdSchema);
export const parseStockPolicyEntityId = recordParser(stockPolicyEntityIdSchema);
export const parseSystemSchemaRevision = recordParser(
  systemSchemaRevisionSchema,
);
