import {
  parseCreatePreparationStationCommand,
  parseCreateModifierGroupRevisionCommand,
  parseCreateRecipeRevisionCommand,
  parseConfigureStockPolicyCommand,
  parsePublishMenuCommand,
  parseMarkSoldOutCommand,
  parseManagePreparationTicketCommand,
  type CreatePreparationStationCommand,
  type CreateModifierGroupRevisionCommand,
  type CreateRecipeRevisionCommand,
  type ConfigureStockPolicyCommand,
  type PublishMenuCommand,
  type MarkSoldOutCommand,
  type ManagePreparationTicketCommand,
  type CommerceFoodServiceSnapshotV1,
  type CommerceMerchantSnapshotV1,
  type CommerceMutationResultV1,
} from "@purin-labs/commerce-client";
import { merchantOwner } from "./merchant-owner.ts";
import type {
  Menu,
  ModifierGroupRevision,
  PreparationStation,
  RecipeRevision,
  StockPolicy,
} from "@purin-labs/commerce-contracts";
import type { CommerceDatabase } from "../../database.ts";
import type { MerchantRow } from "../../commerce-authority/ledger.ts";
import {
  beginMerchantCommand,
  beginSnapshotCommand,
  merchantNotFound,
  type MerchantCommandPorts,
} from "../../commerce-authority/merchant-command.ts";
import {
  foodProvenance,
  readPreparationTicket,
  validateMenuConfiguration,
  validateModifierGroupRevisionInput,
  validateRecipeRevisionInput,
  validateStockPolicyInput,
  type FoodServiceResourceWrite,
} from "./food-service-store.ts";
import {
  listInventoryItems,
  readInventoryItem,
  readInventoryPositionForItemLocation,
} from "../../inventory-persistence.ts";
import {
  planPreparationTicketComplete,
  planPreparationTicketCreate,
  planPreparationTicketStart,
  type PreparationTicketPlan,
} from "./preparation-ticket-planning.ts";
import type { Variant } from "@purin-labs/type-utils";
import { isKnownTimeZone, nextLocalMidnight } from "./menu-schedule.ts";
import {
  readSoldOutMarkRevision,
  type writeSoldOutMark,
} from "./sold-out-marks.ts";

type FoodServiceCommand =
  | CreatePreparationStationCommand
  | CreateModifierGroupRevisionCommand
  | CreateRecipeRevisionCommand
  | ConfigureStockPolicyCommand
  | PublishMenuCommand
  | MarkSoldOutCommand
  | ManagePreparationTicketCommand;

type FoodServiceResourceCommand = Exclude<
  FoodServiceCommand,
  ManagePreparationTicketCommand
>;

type FoodServiceResourceKind = FoodServiceResourceWrite["kind"];

type FoodServiceResourceCommit<
  Command extends FoodServiceResourceCommand,
  Kind extends FoodServiceResourceKind,
  CommandKind extends string,
> = Readonly<{
  kind: "resource";
  command: Command;
  merchant: MerchantRow;
  resource: Variant<FoodServiceResourceWrite, Kind>;
  commandKind: CommandKind;
}>;

export type FoodServiceCommitRequest =
  | FoodServiceResourceCommit<
      CreatePreparationStationCommand,
      "preparation_station",
      "create_preparation_station"
    >
  | FoodServiceResourceCommit<
      CreateModifierGroupRevisionCommand,
      "modifier_group_revision",
      "create_modifier_group_revision"
    >
  | FoodServiceResourceCommit<
      CreateRecipeRevisionCommand,
      "recipe_revision",
      "create_recipe_revision"
    >
  | FoodServiceResourceCommit<
      ConfigureStockPolicyCommand,
      "stock_policy",
      "configure_stock_policy"
    >
  | FoodServiceResourceCommit<PublishMenuCommand, "menu", "publish_menu">
  | Readonly<{
      kind: "sold_out_mark";
      command: MarkSoldOutCommand;
      merchant: MerchantRow;
      mark: Parameters<typeof writeSoldOutMark>[2];
    }>
  | Readonly<{
      kind: "preparation_ticket";
      command: ManagePreparationTicketCommand;
      merchant: MerchantRow;
      plan: PreparationTicketPlan;
    }>;

type FoodServiceCommandAuthorityOptions =
  MerchantCommandPorts<FoodServiceCommand> &
    Readonly<{
      database: CommerceDatabase;
      now: () => string;
      readSnapshot: (
        merchantId: string,
      ) => CommerceMerchantSnapshotV1 | undefined;
      readFoodServiceSnapshot: (
        merchantId: string,
      ) => CommerceFoodServiceSnapshotV1 | undefined;
      commit: (request: FoodServiceCommitRequest) => CommerceMutationResultV1;
    }>;

export class FoodServiceCommandAuthority {
  readonly #options: FoodServiceCommandAuthorityOptions;

  constructor(options: FoodServiceCommandAuthorityOptions) {
    this.#options = options;
  }

  createPreparationStation(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parseCreatePreparationStationCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot: commerce } = start;
    const location = commerce.resources.locations.find(
      (candidate) => candidate.id === command.station.locationId,
    );
    if (location === undefined)
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "location",
        id: command.station.locationId,
      });
    if (location.lifecycle.state !== "active")
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "preparationStation.locationId",
      });
    const existing = this.#options.database
      .prepare(
        `SELECT 1 AS present FROM food_service_resource
       WHERE merchant_id = ? AND resource_kind = 'preparation_station' AND resource_id = ?
       LIMIT 1`,
      )
      .get(command.merchantId, command.station.stationId);
    if (existing !== undefined)
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "preparation_station",
        id: command.station.stationId,
      });
    const committedAt = this.#options.now();
    const station: PreparationStation = {
      provenance: {
        organisationId: merchantOwner(
          this.#options.database,
          command.merchantId,
        ),
        integrationAccountId: command.merchantId,
        source: "underclerk",
        resourceType: "preparation_station",
        resourceId: command.station.stationId,
        revision: 1,
        occurredAt: committedAt,
        observedAt: committedAt,
      },
      stationId: command.station.stationId,
      locationId: command.station.locationId,
      revision: 1,
      name: command.station.name,
      lifecycle: "active",
    };
    return this.#options.commit({
      kind: "resource",
      command,
      merchant,
      resource: { kind: "preparation_station", resource: station },
      commandKind: "create_preparation_station",
    });
  }

  createModifierGroupRevision(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginMerchantCommand(
      this.#options,
      rawCommand,
      parseCreateModifierGroupRevisionCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant } = start;
    if (
      command.modifierGroupRevision.minimumSelections >
        command.modifierGroupRevision.maximumSelections ||
      command.modifierGroupRevision.options.length === 0
    ) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "modifierGroupRevision.cardinality",
      });
    }
    const existing = this.#options.database
      .prepare(
        `SELECT 1 AS present FROM food_service_resource
       WHERE merchant_id = ? AND resource_kind = 'modifier_group_revision' AND resource_id = ? LIMIT 1`,
      )
      .get(command.merchantId, command.modifierGroupRevision.modifierGroupId);
    if (existing !== undefined)
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "modifier_group_revision",
        id: command.modifierGroupRevision.modifierGroupId,
      });
    const inventoryItems = listInventoryItems(
      this.#options.database,
      command.merchantId,
    );
    for (const option of command.modifierGroupRevision.options) {
      for (const adjustment of option.requirementAdjustments) {
        const item = inventoryItems.find(
          (candidate) => candidate.id === adjustment.inventoryItemId,
        );
        if (item === undefined)
          return this.#options.rejected({
            code: "resource_not_found",
            kind: "inventory_item",
            id: adjustment.inventoryItemId,
          });
        if (item.lifecycle !== "active")
          return this.#options.rejected({
            code: "resource_relationship_invalid",
            field:
              "modifierGroupRevision.options.requirementAdjustments.inventoryItemId",
          });
        if (item.baseUnit !== adjustment.quantity.unit)
          return this.#options.rejected({
            code: "resource_relationship_invalid",
            field:
              "modifierGroupRevision.options.requirementAdjustments.quantity.unit",
          });
      }
    }
    const modifierInputError = validateModifierGroupRevisionInput(
      command.modifierGroupRevision,
    );
    if (modifierInputError !== undefined) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: modifierInputError,
      });
    }
    const committedAt = this.#options.now();
    const resource: ModifierGroupRevision = {
      provenance: foodProvenance(
        merchantOwner(this.#options.database, command.merchantId),
        command.merchantId,
        "modifier_group_revision",
        command.modifierGroupRevision.modifierGroupId,
        1,
        committedAt,
      ),
      modifierGroupId: command.modifierGroupRevision.modifierGroupId,
      revision: 1,
      name: command.modifierGroupRevision.name,
      minimumSelections: command.modifierGroupRevision.minimumSelections,
      maximumSelections: command.modifierGroupRevision.maximumSelections,
      options: command.modifierGroupRevision.options.map((option) => ({
        ...option,
        requirementAdjustments: [...option.requirementAdjustments],
      })),
      lifecycle: { state: "active", activeAt: committedAt },
    };
    return this.#options.commit({
      kind: "resource",
      command,
      merchant,
      resource: { kind: "modifier_group_revision", resource },
      commandKind: "create_modifier_group_revision",
    });
  }

  createRecipeRevision(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginMerchantCommand(
      this.#options,
      rawCommand,
      parseCreateRecipeRevisionCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant } = start;
    const latest = this.#options.database
      .prepare(
        `SELECT revision FROM food_service_resource
         WHERE merchant_id = ? AND resource_kind = 'recipe_revision' AND resource_id = ?
         ORDER BY revision DESC LIMIT 1`,
      )
      .get<{ revision: number }>(
        command.merchantId,
        command.recipeRevision.recipeId,
      );
    const revision = (latest?.revision ?? 0) + 1;
    const inventoryItems = listInventoryItems(
      this.#options.database,
      command.merchantId,
    );
    for (const input of command.recipeRevision.inputs) {
      const item = inventoryItems.find(
        (candidate) => candidate.id === input.inventoryItemId,
      );
      if (item === undefined)
        return this.#options.rejected({
          code: "resource_not_found",
          kind: "inventory_item",
          id: input.inventoryItemId,
        });
      if (item.lifecycle !== "active")
        return this.#options.rejected({
          code: "resource_relationship_invalid",
          field: "recipeRevision.inputs.inventoryItemId",
        });
      if (item.baseUnit !== input.quantity.unit)
        return this.#options.rejected({
          code: "resource_relationship_invalid",
          field: "recipeRevision.inputs.quantity.unit",
        });
    }
    if (command.recipeRevision.output.kind === "stocked") {
      const outputItem = inventoryItems.find(
        (candidate) =>
          candidate.id === command.recipeRevision.output.inventoryItemId,
      );
      if (outputItem === undefined)
        return this.#options.rejected({
          code: "resource_not_found",
          kind: "inventory_item",
          id: command.recipeRevision.output.inventoryItemId,
        });
      if (outputItem.lifecycle !== "active")
        return this.#options.rejected({
          code: "resource_relationship_invalid",
          field: "recipeRevision.output.inventoryItemId",
        });
      if (
        outputItem.baseUnit !== command.recipeRevision.output.yieldQuantity.unit
      )
        return this.#options.rejected({
          code: "resource_relationship_invalid",
          field: "recipeRevision.output.yieldQuantity.unit",
        });
    }
    const recipeInputError = validateRecipeRevisionInput(
      command.recipeRevision,
    );
    if (recipeInputError !== undefined) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: recipeInputError,
      });
    }
    const committedAt = this.#options.now();
    const resource: RecipeRevision = {
      provenance: foodProvenance(
        merchantOwner(this.#options.database, command.merchantId),
        command.merchantId,
        "recipe_revision",
        command.recipeRevision.recipeId,
        revision,
        committedAt,
      ),
      recipeId: command.recipeRevision.recipeId,
      revision,
      name: command.recipeRevision.name,
      inputs: [...command.recipeRevision.inputs],
      output: command.recipeRevision.output,
      lifecycle: { state: "active", activeAt: committedAt },
    };
    return this.#options.commit({
      kind: "resource",
      command,
      merchant,
      resource: { kind: "recipe_revision", resource },
      commandKind: "create_recipe_revision",
    });
  }

  configureStockPolicy(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginMerchantCommand(
      this.#options,
      rawCommand,
      parseConfigureStockPolicyCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant } = start;
    const inventoryItem = readInventoryItem(
      this.#options.database,
      command.merchantId,
      command.stockPolicy.inventoryItemId,
    );
    if (inventoryItem === undefined)
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "inventory_item",
        id: command.stockPolicy.inventoryItemId,
      });
    if (inventoryItem.lifecycle !== "active")
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "stockPolicy.inventoryItemId",
      });
    const location = this.#options
      .readSnapshot(command.merchantId)
      ?.resources.locations.find(
        (candidate) => candidate.id === command.stockPolicy.locationId,
      );
    if (location === undefined)
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "location",
        id: command.stockPolicy.locationId,
      });
    if (location.lifecycle.state !== "active")
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "stockPolicy.locationId",
      });
    const position = readInventoryPositionForItemLocation(
      this.#options.database,
      command.merchantId,
      command.stockPolicy.inventoryItemId,
      command.stockPolicy.locationId,
    );
    if (position === undefined)
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "stockPolicy.inventoryPosition",
      });
    const stockPolicyInputError = validateStockPolicyInput(
      command.stockPolicy,
      inventoryItem.baseUnit,
    );
    if (stockPolicyInputError !== undefined) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: stockPolicyInputError,
      });
    }
    const existing = this.#options.database
      .prepare(
        `SELECT 1 AS present FROM food_service_resource
       WHERE merchant_id = ? AND resource_kind = 'stock_policy' AND resource_id = ? LIMIT 1`,
      )
      .get(command.merchantId, command.stockPolicy.stockPolicyId);
    if (existing !== undefined)
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "stock_policy",
        id: command.stockPolicy.stockPolicyId,
      });
    const committedAt = this.#options.now();
    const resource: StockPolicy = {
      provenance: foodProvenance(
        merchantOwner(this.#options.database, command.merchantId),
        command.merchantId,
        "stock_policy",
        command.stockPolicy.stockPolicyId,
        1,
        committedAt,
      ),
      stockPolicyId: command.stockPolicy.stockPolicyId,
      inventoryItemId: command.stockPolicy.inventoryItemId,
      locationId: command.stockPolicy.locationId,
      revision: 1,
      replenishment: command.stockPolicy.replenishment,
      lifecycle: "active",
    };
    return this.#options.commit({
      kind: "resource",
      command,
      merchant,
      resource: { kind: "stock_policy", resource },
      commandKind: "configure_stock_policy",
    });
  }

  publishMenu(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parsePublishMenuCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot } = start;
    const salesChannel = snapshot.resources.salesChannels.find(
      (channel) => channel.id === command.menu.salesChannelId,
    );
    if (salesChannel === undefined)
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "sales_channel",
        id: command.menu.salesChannelId,
      });
    if (salesChannel.lifecycle.state !== "active")
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "menu.salesChannelId",
      });
    const current = this.#options.database
      .prepare(
        `SELECT MAX(revision) AS revision FROM food_service_resource WHERE merchant_id = ? AND resource_kind = 'menu' AND resource_id = ?`,
      )
      .get<Readonly<{ revision: number | null }>>(
        command.merchantId,
        command.menu.menuId,
      )?.revision;
    // A first publication names no revision; a replacement names the one it
    // replaces, so two editors cannot overwrite each other's menu.
    if (command.expectedMenuRevision === undefined) {
      if (current !== null && current !== undefined)
        return this.#options.rejected({
          code: "resource_already_exists",
          kind: "menu",
          id: command.menu.menuId,
        });
    } else if (current !== command.expectedMenuRevision)
      return this.#options.rejected({
        code: "stale_resource_revision",
        kind: "menu",
        id: command.menu.menuId,
        expected: command.expectedMenuRevision,
        actual: current ?? 0,
      });
    const revision = (current ?? 0) + 1;
    const foodSnapshot = this.#options.readFoodServiceSnapshot(
      command.merchantId,
    );
    if (foodSnapshot === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    const menuValidationError = validateMenuConfiguration(
      this.#options.database,
      command.menu,
      snapshot,
      foodSnapshot.resources,
    );
    if (menuValidationError !== undefined)
      return this.#options.rejected(menuValidationError);
    const committedAt = this.#options.now();
    const resource: Menu = {
      provenance: foodProvenance(
        merchantOwner(this.#options.database, command.merchantId),
        command.merchantId,
        "menu",
        command.menu.menuId,
        revision,
        committedAt,
      ),
      menuId: command.menu.menuId,
      revision,
      name: command.menu.name,
      salesChannelId: command.menu.salesChannelId,
      scope: command.menu.scope,
      validity: command.menu.validity,
      sections: command.menu.sections.map((section) => ({
        ...section,
        menuId: command.menu.menuId,
        revision,
      })),
      entries: command.menu.entries.map((entry) => ({
        ...entry,
        revision,
        modifierGroupRevisions: [...entry.modifierGroupRevisions],
        lifecycle: "active",
      })),
      lifecycle: { state: "published", publishedAt: committedAt },
    };
    return this.#options.commit({
      kind: "resource",
      command,
      merchant,
      resource: { kind: "menu", resource },
      commandKind: "publish_menu",
    });
  }

  markSoldOut(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parseMarkSoldOutCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot } = start;
    const location = snapshot.resources.locations.find(
      (candidate) => candidate.id === command.locationId,
    );
    if (location === undefined)
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "location",
        id: command.locationId,
      });
    if (
      !snapshot.resources.variants.some(
        (candidate) => candidate.id === command.variantId,
      )
    )
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "variant",
        id: command.variantId,
      });
    if (
      command.mark.kind === "today" &&
      !isKnownTimeZone(command.mark.timeZone)
    )
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "mark.timeZone",
      });
    const markedAt = this.#options.now();
    return this.#options.commit({
      kind: "sold_out_mark",
      command,
      merchant,
      mark: {
        locationId: command.locationId,
        variantId: command.variantId,
        revision:
          (readSoldOutMarkRevision(
            this.#options.database,
            command.merchantId,
            command.locationId,
            command.variantId,
          ) ?? 0) + 1,
        soldOutUntil:
          command.mark.kind === "today"
            ? new Date(
                nextLocalMidnight(Date.parse(markedAt), command.mark.timeZone),
              ).toISOString()
            : null,
        markedAt,
      },
    });
  }

  managePreparationTicket(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parseManagePreparationTicketCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot: commerce } = start;
    const foodService = this.#options.readFoodServiceSnapshot(
      command.merchantId,
    );
    if (foodService === undefined) {
      return this.#options.rejected(merchantNotFound(command.merchantId));
    }
    const ticket = readPreparationTicket(
      this.#options.database,
      command.merchantId,
      command.operation.ticketId,
    );
    if (command.operation.kind === "create" && ticket !== undefined) {
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "preparation_ticket",
        id: command.operation.ticketId,
      });
    }
    if (command.operation.kind !== "create" && ticket === undefined) {
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "preparation_ticket",
        id: command.operation.ticketId,
      });
    }
    const plan =
      command.operation.kind === "create"
        ? planPreparationTicketCreate(
            this.#options.database,
            command,
            commerce.resources,
            foodService.resources,
          )
        : command.operation.kind === "start"
          ? planPreparationTicketStart(command, ticket!)
          : planPreparationTicketComplete(
              this.#options.database,
              command,
              ticket!,
              commerce.resources,
            );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "preparation_ticket",
      command,
      merchant,
      plan: plan.value,
    });
  }
}
