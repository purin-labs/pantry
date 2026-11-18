// What the food service, purchasing and production demand plugins give the
// core (Plan 76 phase 5, Plan 77 step 3). Each plugin implements its part in
// its own directory; the core takes it through the plugin's index.ts. A
// merchant turns a plugin off by pausing it, not by a missing slot.
import type {
  CommerceCommandResult,
  CommerceEntityPlaneError,
  ListEntryAttributeValue,
} from "@seams/commerce-contracts";
import type {
  CompleteProductionBatchCommand,
  ConfigureStockPolicyCommand,
  CreateModifierGroupRevisionCommand,
  CreatePreparationStationCommand,
  CreateRecipeRevisionCommand,
  ManagePreparationTicketCommand,
  ProvisionCommerceDemoV1,
  PublishMenuCommand,
  MarkSoldOutCommand,
  ReceiveCommerceInventoryV3,
  CommerceAggregateObservationV1,
  CommerceBuyerMenuV1,
  CommerceResourcesV1,
  CommerceFoodServiceResourcesV1,
  CommerceFoodServiceSnapshotV1,
  CommercePickupCheckoutSelectionV1,
  CommerceMerchantSnapshotV1,
  CommerceMutationErrorV1,
  CommerceMutationReceiptV1,
  CommerceMutationResultV1,
} from "@seams/commerce-client";
import type { CommerceDatabase } from "../database.ts";
import type { CommerceLists } from "../entity-plane/commerce-lists.ts";
import type { EntityPlanePresetBundle } from "../entity-plane/presets.ts";
import type { EntityPlaneMutationRequest } from "../entity-plane/receipt-outbox-settlement.ts";
import type { CheckoutSelectionResult } from "../commerce-authority/checkout-planning.ts";
import type { ProvisioningAuthorityOptions } from "../commerce-authority/provisioning.ts";

export type PurchasingReconciliationResult =
  | Readonly<{ kind: "inactive" }>
  | Readonly<{
      kind: "reconciled";
      opened: number;
      updated: number;
      received: number;
    }>;

export type PurchasingReplenishmentContext = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  commerceLists: CommerceLists;
  executeMutation: (
    request: EntityPlaneMutationRequest,
  ) => CommerceCommandResult;
}>;

/** Checks the purchase request that an inventory receipt names, if any. */
export type ReceiptPurchaseCheck = (
  database: CommerceDatabase,
  command: ReceiveCommerceInventoryV3,
) => CommerceMutationErrorV1 | undefined;

/**
 * Refuses a list patch that moves a purchase request's status where the
 * purchase request machine, or the receipts that name it, do not allow.
 */
export type PurchaseRequestPatchCheck = (
  database: CommerceDatabase,
  merchantId: string,
  entryId: string,
  revision: number,
  attributes: readonly ListEntryAttributeValue[],
  now: string,
) => CommerceEntityPlaneError | undefined;

/** Supplier purchase requests that follow stock positions. */
export type PurchasingExtension = Readonly<{
  /** Suppliers, purchase requests and the replenishment queue. */
  preset: EntityPlanePresetBundle;
  /** Opens, updates and closes purchase requests from stock positions. */
  replenishment: (context: PurchasingReplenishmentContext) => Readonly<{
    reconcile(merchantId: string): PurchasingReconciliationResult;
  }>;
  checkReceiptPurchase: ReceiptPurchaseCheck;
  checkRequestPatch: PurchaseRequestPatchCheck;
}>;

/** Production requests that a production plan answers. */
export type ProductionDemandExtension = Readonly<{
  preset: EntityPlanePresetBundle;
}>;

/** The merchant row that a command plans against. */
export type ExtensionMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

/**
 * One mutation of an extension. The core signs its delivery and receipt,
 * runs `write` and records both in one transaction, as for a core command.
 */
export type ExtensionMutation<Command> = Readonly<{
  command: Command;
  merchant: ExtensionMerchantRow;
  commandKind: CommerceMutationReceiptV1["commandKind"];
  resource: CommerceMutationReceiptV1["resource"];
  observations: readonly CommerceAggregateObservationV1[];
  /** The extension's own rows, written inside the commit transaction. */
  write: (database: CommerceDatabase) => void;
}>;

export type FoodServiceMutationCommand =
  | CreatePreparationStationCommand
  | CreateModifierGroupRevisionCommand
  | CreateRecipeRevisionCommand
  | ConfigureStockPolicyCommand
  | PublishMenuCommand
  | MarkSoldOutCommand
  | ManagePreparationTicketCommand
  | CompleteProductionBatchCommand;

/** What the core lends the food service commands. */
export type FoodServiceCommandContext = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  readMerchant: (merchantId: string) => ExtensionMerchantRow | undefined;
  readSnapshot: (
    merchantId: string,
  ) => CommerceMerchantSnapshotV1 | undefined;
  readFoodServiceSnapshot: (
    merchantId: string,
  ) => CommerceFoodServiceSnapshotV1 | undefined;
  readReplay: (
    merchantId: string,
    idempotencyKey: string,
    command: FoodServiceMutationCommand,
  ) => CommerceMutationResultV1 | undefined;
  commit: (
    mutation: ExtensionMutation<FoodServiceMutationCommand>,
  ) => CommerceMutationResultV1;
  validateMerchant: (
    merchantId: string,
    merchant: ExtensionMerchantRow | undefined,
  ) => CommerceMutationErrorV1 | undefined;
  rejected: (error: CommerceMutationErrorV1) => CommerceMutationResultV1;
  invalidCommand: (error: unknown) => CommerceMutationErrorV1;
}>;

type RawCommand = (rawCommand: unknown) => CommerceMutationResultV1;

/** The kitchen commands: stations, modifiers, recipes, menus, tickets, batches. */
export type FoodServiceCommands = Readonly<{
  createPreparationStation: RawCommand;
  createModifierGroupRevision: RawCommand;
  createRecipeRevision: RawCommand;
  configureStockPolicy: RawCommand;
  publishMenu: RawCommand;
  markSoldOut: RawCommand;
  managePreparationTicket: RawCommand;
  completeProductionBatch: RawCommand;
}>;

/** What a buyer sees and orders from the menus of one channel and place. */
export type FoodServiceMenus = Readonly<{
  /** Plans one menu line of a checkout: modifiers, recipe and price. */
  select: (
    input: Readonly<{
      database: CommerceDatabase;
      merchantId: string;
      selection: CommercePickupCheckoutSelectionV1;
      foodService: CommerceFoodServiceResourcesV1;
      resources: CommerceResourcesV1;
      salesChannelId: string;
      locationId: string;
      now: string;
    }>,
  ) => CheckoutSelectionResult;
  buyerMenus: (
    input: Readonly<{
      database: CommerceDatabase;
      merchantId: string;
      foodService: CommerceFoodServiceResourcesV1;
      resources: Pick<
        CommerceResourcesV1,
        "offers" | "variants" | "products"
      >;
      salesChannelId: string;
      locationId: string;
      now: string;
    }>,
  ) => readonly CommerceBuyerMenuV1[];
  /** Staff marked this variant sold out at this location, for today. */
  variantSoldOut: (
    database: CommerceDatabase,
    merchantId: string,
    locationId: string,
    variantId: string,
    now: string,
  ) => boolean;
  soldOutVariants: (
    database: CommerceDatabase,
    merchantId: string,
    locationId: string,
    now: string,
  ) => ReadonlySet<string>;
}>;

/** Food service and production of a café or pâtisserie. */
export type FoodServiceExtension = Readonly<{
  commands: (context: FoodServiceCommandContext) => FoodServiceCommands;
  menus: FoodServiceMenus;
  /** Seeds the café demo profile through the core's own commands. */
  provisionCafeDemo: (
    context: ProvisioningAuthorityOptions,
    command: ProvisionCommerceDemoV1,
  ) => CommerceMerchantSnapshotV1;
}>;
