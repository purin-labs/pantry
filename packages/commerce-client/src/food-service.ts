import type {
  InventoryReplenishmentPolicy,
  InventoryRequirement,
  InventoryRequirementAdjustment,
  Menu,
  MenuScope,
  MenuValidity,
  ModifierGroupRevision,
  PreparationStation,
  PreparationTicket,
  ProductionBatch,
  ProductionBatchDemand,
  RecipeRevision,
  RecipeOutput,
  ShipmentEntityId,
  StockPolicy,
  QuantityUnit,
} from "@seams/commerce-contracts";
import { decodeRecord } from "./entity-plane/record-decoding.ts";
import {
  parseCompleteProductionBatchCommand as parseCompleteProductionBatchCommandRecord,
  parseConfigureStockPolicyCommand as parseConfigureStockPolicyCommandRecord,
  parseCreateModifierGroupRevisionCommand as parseCreateModifierGroupRevisionCommandRecord,
  parseCreatePreparationStationCommand as parseCreatePreparationStationCommandRecord,
  parseCreateRecipeRevisionCommand as parseCreateRecipeRevisionCommandRecord,
  parseFoodServiceMenu as parseMenuRecord,
  parseFoodServicePreparationTicket as parsePreparationTicketRecord,
  parseFoodServiceRecipeRevision as parseRecipeRevisionRecord,
  parseManagePreparationTicketCommand as parseManagePreparationTicketCommandRecord,
  parsePublishMenuCommand as parsePublishMenuCommandRecord,
  type MarkSoldOutCommand as apiMarkSoldOutCommand,
  type CommerceSoldOutMarksV1 as apiCommerceSoldOutMarksV1,
  parseMarkSoldOutCommand as parseMarkSoldOutCommandRecord,
  parseCommerceSoldOutMarksV1 as parseCommerceSoldOutMarksV1Record,
  parseShipmentEntityId as parseShipmentEntityIdRecord,
  parseCommerceFoodServiceObservationV1 as parseCommerceFoodServiceObservationV1Record,
  parseCommerceFoodServiceSnapshotV1 as parseCommerceFoodServiceSnapshotV1Record,
} from "@seams/commerce-contracts/records/api-food-service";
export type CommerceFoodServiceResourcesV1 = Readonly<{
  menus: readonly Menu[];
  modifierGroupRevisions: readonly ModifierGroupRevision[];
  recipeRevisions: readonly RecipeRevision[];
  preparationStations: readonly PreparationStation[];
  preparationTickets: readonly PreparationTicket[];
  productionBatches: readonly ProductionBatch[];
  stockPolicies: readonly StockPolicy[];
}>;

export type CommerceFoodServiceSnapshotV1 = Readonly<{
  schemaVersion: "underclerk.food-service-snapshot.v2";
  merchantId: string;
  merchantRevision: number;
  deliverySigner: Readonly<{
    keyId: string;
    algorithm: "ed25519";
    publicKeyB64: string;
  }>;
  resources: CommerceFoodServiceResourcesV1;
}>;

type CommandBase = Readonly<{
  merchantId: string;
  expectedMerchantRevision: number;
  idempotencyKey: string;
  requestedAt: string;
}>;

export type CreatePreparationStationCommand = CommandBase &
  Readonly<{
    schemaVersion: "underclerk.create-preparation-station.v1";
    station: Readonly<{ stationId: string; locationId: string; name: string }>;
  }>;
export type CreateModifierGroupRevisionCommand = CommandBase &
  Readonly<{
    schemaVersion: "underclerk.create-modifier-group-revision.v1";
    modifierGroupRevision: ModifierGroupRevisionInput;
  }>;
export type CreateRecipeRevisionCommand = CommandBase &
  Readonly<{
    schemaVersion: "underclerk.create-recipe-revision.v1";
    recipeRevision: RecipeRevisionInput;
  }>;
export type ConfigureStockPolicyCommand = CommandBase &
  Readonly<{
    schemaVersion: "underclerk.configure-stock-policy.v1";
    stockPolicy: StockPolicyInput;
  }>;
export type MarkSoldOutCommand = apiMarkSoldOutCommand;
export type CommerceSoldOutMarksV1 = apiCommerceSoldOutMarksV1;

export type PublishMenuCommand = CommandBase &
  Readonly<{
    schemaVersion: "underclerk.publish-menu.v1";
    menu: MenuInput;
    /** The revision a replacement replaces; absent for a first publication. */
    expectedMenuRevision?: number;
  }>;

export type ModifierGroupRevisionInput = Readonly<{
  modifierGroupId: string;
  name: string;
  minimumSelections: number;
  maximumSelections: number;
  options: readonly ModifierOptionInput[];
}>;
export type ModifierOptionInput = Readonly<{
  modifierOptionId: string;
  name: string;
  priceDelta: Readonly<{ amountMinor: number; currency: string }>;
  requirementAdjustments: readonly InventoryRequirementAdjustment[];
}>;
export type RecipeRevisionInput = Readonly<{
  recipeId: string;
  name: string;
  inputs: readonly InventoryRequirement[];
  output: RecipeOutput;
}>;
export type StockPolicyInput = Readonly<{
  stockPolicyId: string;
  inventoryItemId: string;
  locationId: string;
  replenishment: InventoryReplenishmentPolicy;
}>;
export type MenuInput = Readonly<{
  menuId: string;
  name: string;
  salesChannelId: string;
  scope: MenuScope;
  validity: MenuValidity;
  sections: readonly MenuSectionInput[];
  entries: readonly MenuEntryInput[];
}>;
export type MenuSectionInput = Readonly<{
  sectionId: string;
  name: string;
  position: number;
}>;
export type MenuEntryInput = Readonly<{
  menuEntryId: string;
  sectionId: string;
  offerId: string;
  offerRevision: number;
  consumptionPlanId: string;
  consumptionPlanRevision: number;
  modifierGroupRevisions: readonly Readonly<{
    modifierGroupId: string;
    revision: number;
  }>[];
}>;
export type ManagePreparationTicketCommand = CommandBase &
  Readonly<{
    schemaVersion: "underclerk.manage-preparation-ticket.v1";
    operation:
      | Readonly<{
          kind: "create";
          ticketId: string;
          orderId: string;
          fulfillmentId: string;
          stationId: string;
        }>
      | Readonly<{
          kind: "start" | "complete";
          ticketId: string;
          expectedTicketRevision: number;
        }>;
  }>;
export type CompleteProductionBatchCommand = CommandBase &
  Readonly<{
    schemaVersion: "underclerk.complete-production-batch.v1";
    productionBatchId: string;
    demand: ProductionBatchDemand;
    outputLotId: string;
    outputInventoryPositionId: string;
    recipeId: string;
    recipeRevision: number;
    stationId: string;
    locationId: string;
    plannedYield: QuantityInput;
    actualYield: QuantityInput;
    outputLotCode: string;
    outputExpiresAt: string;
    expectedInputPositionRevisions: readonly Readonly<{
      inventoryPositionId: string;
      revision: number;
    }>[];
    expectedOutputPositionRevision: number;
  }>;
export type QuantityInput = Readonly<{
  amount: number;
  scale: number;
  unit: QuantityUnit;
}>;

export function parseCreatePreparationStationCommand(
  value: unknown,
): CreatePreparationStationCommand {
  return decodeRecord(parseCreatePreparationStationCommandRecord, value);
}
export function parseCreateModifierGroupRevisionCommand(
  value: unknown,
): CreateModifierGroupRevisionCommand {
  return decodeRecord(parseCreateModifierGroupRevisionCommandRecord, value);
}
export function parseCreateRecipeRevisionCommand(
  value: unknown,
): CreateRecipeRevisionCommand {
  return decodeRecord(parseCreateRecipeRevisionCommandRecord, value);
}
export function parseConfigureStockPolicyCommand(
  value: unknown,
): ConfigureStockPolicyCommand {
  return decodeRecord(parseConfigureStockPolicyCommandRecord, value);
}
export function parseSoldOutMarks(value: unknown): CommerceSoldOutMarksV1 {
  return decodeRecord(parseCommerceSoldOutMarksV1Record, value);
}

export function parseMarkSoldOutCommand(value: unknown): MarkSoldOutCommand {
  return decodeRecord(parseMarkSoldOutCommandRecord, value);
}

export function parsePublishMenuCommand(value: unknown): PublishMenuCommand {
  return decodeRecord(parsePublishMenuCommandRecord, value);
}
export function parseManagePreparationTicketCommand(
  value: unknown,
): ManagePreparationTicketCommand {
  return decodeRecord(parseManagePreparationTicketCommandRecord, value);
}
export function parseCompleteProductionBatchCommand(
  value: unknown,
): CompleteProductionBatchCommand {
  return decodeRecord(parseCompleteProductionBatchCommandRecord, value);
}

export function parseShipmentEntityId(
  value: unknown,
  field = "shipmentId",
): ShipmentEntityId {
  return decodeRecord(parseShipmentEntityIdRecord, value);
}

export type CommerceFoodServiceObservationV1 =
  | Readonly<{ kind: "menu"; resource: Menu }>
  | Readonly<{
      kind: "modifier_group_revision";
      resource: ModifierGroupRevision;
    }>
  | Readonly<{ kind: "recipe_revision"; resource: RecipeRevision }>
  | Readonly<{ kind: "preparation_station"; resource: PreparationStation }>
  | Readonly<{ kind: "preparation_ticket"; resource: PreparationTicket }>
  | Readonly<{ kind: "production_batch"; resource: ProductionBatch }>
  | Readonly<{ kind: "stock_policy"; resource: StockPolicy }>;

export function parseFoodServiceSnapshot(
  value: unknown,
): CommerceFoodServiceSnapshotV1 {
  return decodeRecord(parseCommerceFoodServiceSnapshotV1Record, value);
}

export function parseFoodServiceObservation(
  value: unknown,
): CommerceFoodServiceObservationV1 {
  return decodeRecord(parseCommerceFoodServiceObservationV1Record, value);
}

export function parseMenu(value: unknown): Menu {
  return decodeRecord(parseMenuRecord, value);
}

export function parseRecipeRevision(value: unknown): RecipeRevision {
  return decodeRecord(parseRecipeRevisionRecord, value);
}

export function parsePreparationTicket(value: unknown): PreparationTicket {
  return decodeRecord(parsePreparationTicketRecord, value);
}
