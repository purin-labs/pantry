import {
  parseFoodServiceObservation,
  parseRecipeRevision,
  parsePreparationTicket,
  type ConfigureStockPolicyCommand,
  type CreateModifierGroupRevisionCommand,
  type CreateRecipeRevisionCommand,
  type PublishMenuCommand,
  type CommerceAggregateObservationV1,
  type CommerceFoodServiceResourcesV1,
  type CommerceMerchantSnapshotV1,
  type CommerceMutationErrorV1,
  type CommercePreparationTicketV1,
} from "@purin-labs/commerce-client";
import type {
  Menu,
  ModifierGroupRevision,
  PreparationStation,
  ProductionBatch,
  Quantity,
  RecipeRevision,
  StockPolicy,
} from "@purin-labs/commerce-contracts";
import type { CommerceDatabase } from "../../database.ts";
import { menuScheduleIsValid } from "./menu-schedule.ts";
import { readConsumptionPlan } from "../../checkout-persistence.ts";
import type { FoodServiceEntityProjectionWriter } from "../../commerce-entity-projection.ts";

export type FoodServiceResourceWrite =
  | Readonly<{ kind: "menu"; resource: Menu }>
  | Readonly<{
      kind: "modifier_group_revision";
      resource: ModifierGroupRevision;
    }>
  | Readonly<{ kind: "recipe_revision"; resource: RecipeRevision }>
  | Readonly<{ kind: "preparation_station"; resource: PreparationStation }>
  | Readonly<{
      kind: "preparation_ticket";
      resource: CommercePreparationTicketV1;
    }>
  | Readonly<{ kind: "production_batch"; resource: ProductionBatch }>
  | Readonly<{ kind: "stock_policy"; resource: StockPolicy }>;

type StoredResourceRow = Readonly<{ resourceJson: string }>;

export function readFoodServiceResources(
  database: CommerceDatabase,
  merchantId: string,
): CommerceFoodServiceResourcesV1 {
  const rows = database
    .prepare(
      `SELECT resource_kind AS resourceKind, resource_id AS resourceId, revision, resource_json AS resourceJson
     FROM food_service_resource
     WHERE merchant_id = ? AND revision = (
       SELECT MAX(candidate.revision) FROM food_service_resource AS candidate
       WHERE candidate.merchant_id = food_service_resource.merchant_id
         AND candidate.resource_kind = food_service_resource.resource_kind
         AND candidate.resource_id = food_service_resource.resource_id
     ) ORDER BY resource_kind, resource_id`,
    )
    .all<
      Readonly<{
        resourceKind: string;
        resourceId: string;
        revision: number;
        resourceJson: string;
      }>
    >(merchantId);
  const menus: Menu[] = [];
  const modifierGroupRevisions: ModifierGroupRevision[] = [];
  const recipeRevisions: RecipeRevision[] = [];
  const preparationStations: PreparationStation[] = [];
  const preparationTickets: CommercePreparationTicketV1[] = [];
  const productionBatches: ProductionBatch[] = [];
  const stockPolicies: StockPolicy[] = [];
  for (const row of rows) {
    const observation = parseFoodServiceObservation({
      kind: row.resourceKind,
      resource: JSON.parse(row.resourceJson),
    });
    switch (observation.kind) {
      case "menu":
        menus.push(observation.resource);
        break;
      case "modifier_group_revision":
        modifierGroupRevisions.push(observation.resource);
        break;
      case "recipe_revision":
        recipeRevisions.push(observation.resource);
        break;
      case "preparation_station":
        preparationStations.push(observation.resource);
        break;
      case "preparation_ticket":
        preparationTickets.push(observation.resource);
        break;
      case "production_batch":
        productionBatches.push(observation.resource);
        break;
      case "stock_policy":
        stockPolicies.push(observation.resource);
        break;
    }
  }
  return {
    menus,
    modifierGroupRevisions,
    recipeRevisions,
    preparationStations,
    preparationTickets,
    productionBatches,
    stockPolicies,
  };
}

/** Resolve the immutable revision pinned by a menu, order or production request. */
export function readRecipeRevision(
  database: CommerceDatabase,
  merchantId: string,
  recipeId: string,
  revision: number,
): RecipeRevision | undefined {
  const row = database
    .prepare(
      `SELECT resource_json AS resourceJson FROM food_service_resource
     WHERE merchant_id = ? AND resource_kind = 'recipe_revision'
       AND resource_id = ? AND revision = ?`,
    )
    .get<StoredResourceRow>(merchantId, recipeId, revision);
  return row === undefined
    ? undefined
    : parseRecipeRevision(JSON.parse(row.resourceJson));
}

export function readPreparationTicket(
  database: CommerceDatabase,
  merchantId: string,
  ticketId: string,
): CommercePreparationTicketV1 | undefined {
  const row = database
    .prepare(
      `SELECT resource_json AS resourceJson
     FROM food_service_resource
     WHERE merchant_id = ? AND resource_kind = 'preparation_ticket' AND resource_id = ?
     ORDER BY revision DESC LIMIT 1`,
    )
    .get<StoredResourceRow>(
      normalizedIdentity(merchantId, "merchantId"),
      normalizedIdentity(ticketId, "ticketId"),
    );
  return row === undefined
    ? undefined
    : parsePreparationTicket(JSON.parse(row.resourceJson));
}

export function writeFoodServiceResource(
  database: CommerceDatabase,
  merchantId: string,
  input: FoodServiceResourceWrite,
  projectEntity: FoodServiceEntityProjectionWriter,
): void {
  database
    .prepare(
      `INSERT INTO food_service_resource (
       merchant_id, resource_kind, resource_id, revision, lifecycle_state, resource_json
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      input.kind,
      foodServiceResourceId(input),
      foodServiceResourceRevision(input),
      foodServiceLifecycleState(input),
      JSON.stringify(input.resource),
    );
  projectEntity(database, merchantId, {
    entityOrigin: "system",
    entityType: input.kind,
    entityId: foodServiceResourceId(input),
    revision: foodServiceResourceRevision(input),
    updatedAt: input.resource.provenance.occurredAt,
    displayName: foodServiceDisplayName(input),
  });
}

export function foodProvenance(
  organisationId: string,
  integrationAccountId: string,
  resourceType:
    | "menu"
    | "modifier_group_revision"
    | "recipe_revision"
    | "preparation_station"
    | "preparation_ticket"
    | "production_batch"
    | "stock_policy",
  resourceId: string,
  revision: number,
  occurredAt: string,
): Readonly<{
  organisationId: string;
  integrationAccountId: string;
  source: "underclerk";
  resourceType: typeof resourceType;
  resourceId: string;
  revision: number;
  occurredAt: string;
  observedAt: string;
}> {
  return {
    organisationId,
    integrationAccountId,
    source: "underclerk",
    resourceType,
    resourceId,
    revision,
    occurredAt,
    observedAt: occurredAt,
  };
}

export function foodServiceObservation(
  input: FoodServiceResourceWrite,
): CommerceAggregateObservationV1 {
  switch (input.kind) {
    case "menu":
      return { kind: input.kind, resource: input.resource };
    case "modifier_group_revision":
      return { kind: input.kind, resource: input.resource };
    case "recipe_revision":
      return { kind: input.kind, resource: input.resource };
    case "preparation_station":
      return { kind: input.kind, resource: input.resource };
    case "preparation_ticket":
      return { kind: input.kind, resource: input.resource };
    case "production_batch":
      return { kind: input.kind, resource: input.resource };
    case "stock_policy":
      return { kind: input.kind, resource: input.resource };
  }
}

export function foodServiceResourceId(input: FoodServiceResourceWrite): string {
  switch (input.kind) {
    case "menu":
      return input.resource.menuId;
    case "modifier_group_revision":
      return input.resource.modifierGroupId;
    case "recipe_revision":
      return input.resource.recipeId;
    case "preparation_station":
      return input.resource.stationId;
    case "preparation_ticket":
      return input.resource.ticketId;
    case "production_batch":
      return input.resource.productionBatchId;
    case "stock_policy":
      return input.resource.stockPolicyId;
  }
}

export function foodServiceResourceRevision(
  input: FoodServiceResourceWrite,
): number {
  switch (input.kind) {
    case "menu":
      return input.resource.revision;
    case "modifier_group_revision":
      return input.resource.revision;
    case "recipe_revision":
      return input.resource.revision;
    case "preparation_station":
      return input.resource.revision;
    case "preparation_ticket":
      return input.resource.revision;
    case "production_batch":
      return input.resource.revision;
    case "stock_policy":
      return input.resource.revision;
  }
}

function foodServiceDisplayName(
  input: FoodServiceResourceWrite,
): string {
  switch (input.kind) {
    case "menu":
      return input.resource.name;
    case "modifier_group_revision":
      return input.resource.name;
    case "recipe_revision":
      return input.resource.name;
    case "preparation_station":
      return input.resource.name;
    case "preparation_ticket":
      return input.resource.ticketId;
    case "production_batch":
      return input.resource.productionBatchId;
    case "stock_policy":
      return input.resource.stockPolicyId;
  }
}

function foodServiceLifecycleState(
  input: FoodServiceResourceWrite,
): string {
  switch (input.kind) {
    case "menu":
      return input.resource.lifecycle.state;
    case "modifier_group_revision":
      return input.resource.lifecycle.state;
    case "recipe_revision":
      return input.resource.lifecycle.state;
    case "preparation_station":
      return input.resource.lifecycle;
    case "preparation_ticket":
      return input.resource.lifecycle.state;
    case "production_batch":
      return "completed";
    case "stock_policy":
      return input.resource.lifecycle;
  }
}

export function validateModifierGroupRevisionInput(
  input: CreateModifierGroupRevisionCommand["modifierGroupRevision"],
): string | undefined {
  if (input.options.length === 0) return "modifierGroupRevision.options";
  if (input.minimumSelections > input.maximumSelections)
    return "modifierGroupRevision.cardinality";
  if (input.maximumSelections > input.options.length)
    return "modifierGroupRevision.cardinality";
  const optionIds = new Set<string>();
  for (const option of input.options) {
    if (optionIds.has(option.modifierOptionId))
      return "modifierGroupRevision.options.modifierOptionId";
    optionIds.add(option.modifierOptionId);
    const adjustmentIds = new Set<string>();
    for (const adjustment of option.requirementAdjustments) {
      if (adjustmentIds.has(adjustment.inventoryItemId)) {
        return "modifierGroupRevision.options.requirementAdjustments.inventoryItemId";
      }
      adjustmentIds.add(adjustment.inventoryItemId);
    }
  }
  return undefined;
}

export function validateRecipeRevisionInput(
  input: CreateRecipeRevisionCommand["recipeRevision"],
): string | undefined {
  if (input.inputs.length === 0) return "recipeRevision.inputs";
  const inputIds = new Set<string>();
  for (const requirement of input.inputs) {
    if (inputIds.has(requirement.inventoryItemId))
      return "recipeRevision.inputs.inventoryItemId";
    inputIds.add(requirement.inventoryItemId);
  }
  return undefined;
}

export function validateStockPolicyInput(
  input: ConfigureStockPolicyCommand["stockPolicy"],
  inventoryItemBaseUnit: string,
): string | undefined {
  if (input.replenishment.kind !== "threshold") return undefined;
  if (
    input.replenishment.reorderPoint.unit !== inventoryItemBaseUnit ||
    input.replenishment.targetQuantity.unit !== inventoryItemBaseUnit
  ) {
    return "stockPolicy.replenishment.quantity.unit";
  }
  if (
    !quantityLessThan(
      input.replenishment.reorderPoint,
      input.replenishment.targetQuantity,
    )
  ) {
    return "stockPolicy.replenishment.threshold";
  }
  return undefined;
}

function quantityLessThan(left: Quantity, right: Quantity): boolean {
  if (left.unit !== right.unit) return false;
  const scale = Math.max(left.scale, right.scale);
  const leftAmount = left.amount * 10 ** (scale - left.scale);
  const rightAmount = right.amount * 10 ** (scale - right.scale);
  return (
    Number.isSafeInteger(leftAmount) &&
    Number.isSafeInteger(rightAmount) &&
    leftAmount < rightAmount
  );
}

export function validateMenuConfiguration(
  database: CommerceDatabase,
  input: PublishMenuCommand["menu"],
  commerce: CommerceMerchantSnapshotV1,
  foodService: CommerceFoodServiceResourcesV1,
): CommerceMutationErrorV1 | undefined {
  if (input.sections.length === 0)
    return { code: "resource_relationship_invalid", field: "menu.sections" };
  if (input.entries.length === 0)
    return { code: "resource_relationship_invalid", field: "menu.entries" };
  const sectionIds = new Set<string>();
  for (const section of input.sections) {
    if (sectionIds.has(section.sectionId))
      return {
        code: "resource_relationship_invalid",
        field: "menu.sections.sectionId",
      };
    sectionIds.add(section.sectionId);
  }
  const entryIds = new Set<string>();
  for (const entry of input.entries) {
    if (entryIds.has(entry.menuEntryId))
      return {
        code: "resource_relationship_invalid",
        field: "menu.entries.menuEntryId",
      };
    entryIds.add(entry.menuEntryId);
    if (!sectionIds.has(entry.sectionId))
      return {
        code: "resource_relationship_invalid",
        field: "menu.entries.sectionId",
      };
  }
  if (
    input.validity.kind === "window" &&
    input.validity.startsAt >= input.validity.endsAt
  ) {
    return { code: "resource_relationship_invalid", field: "menu.validity" };
  }
  if (input.validity.kind === "schedule" && !menuScheduleIsValid(input.validity))
    return { code: "resource_relationship_invalid", field: "menu.validity" };
  const locations = new Map(
    commerce.resources.locations.map((location) => [location.id, location]),
  );
  if (input.scope.kind === "location") {
    const location = locations.get(input.scope.locationId);
    if (location === undefined)
      return {
        code: "resource_not_found",
        kind: "location",
        id: input.scope.locationId,
      };
    if (location.lifecycle.state !== "active")
      return {
        code: "resource_relationship_invalid",
        field: "menu.scope.locationId",
      };
  } else {
    if (
      input.scope.locationIds.length === 0 ||
      new Set(input.scope.locationIds).size !== input.scope.locationIds.length
    ) {
      return {
        code: "resource_relationship_invalid",
        field: "menu.scope.locationIds",
      };
    }
    for (const locationId of input.scope.locationIds) {
      const location = locations.get(locationId);
      if (location === undefined)
        return { code: "resource_not_found", kind: "location", id: locationId };
      if (location.lifecycle.state !== "active")
        return {
          code: "resource_relationship_invalid",
          field: "menu.scope.locationIds",
        };
    }
  }
  for (const entry of input.entries) {
    const offer = commerce.resources.offers.find(
      (candidate) => candidate.id === entry.offerId,
    );
    if (offer === undefined)
      return { code: "resource_not_found", kind: "offer", id: entry.offerId };
    if (
      offer.revision !== entry.offerRevision ||
      offer.salesChannelId !== input.salesChannelId ||
      offer.lifecycle.state !== "listed"
    ) {
      return {
        code: "resource_relationship_invalid",
        field: "menu.entries.offer",
      };
    }
    const plan = readConsumptionPlan(
      database,
      commerce.merchantId,
      entry.consumptionPlanId,
    );
    if (plan === undefined)
      return {
        code: "resource_not_found",
        kind: "consumption_plan",
        id: entry.consumptionPlanId,
      };
    if (
      plan.revision !== entry.consumptionPlanRevision ||
      plan.variantId !== offer.variantId ||
      plan.lifecycle !== "active"
    ) {
      return {
        code: "resource_relationship_invalid",
        field: "menu.entries.consumptionPlan",
      };
    }
    if (
      plan.scope.kind === "location" &&
      (input.scope.kind === "location"
        ? plan.scope.locationId !== input.scope.locationId
        : !input.scope.locationIds.includes(plan.scope.locationId))
    ) {
      return {
        code: "resource_relationship_invalid",
        field: "menu.entries.consumptionPlan.scope",
      };
    }
    if (plan.mode.kind === "prepared") {
      const preparedPlan = plan.mode;
      const recipe = readRecipeRevision(
        database,
        commerce.merchantId,
        preparedPlan.recipeId,
        preparedPlan.recipeRevision,
      );
      if (recipe === undefined)
        return {
          code: "resource_not_found",
          kind: "recipe_revision",
          id: preparedPlan.recipeId,
        };
      if (
        recipe.revision !== preparedPlan.recipeRevision ||
        recipe.lifecycle.state !== "active" ||
        recipe.output.kind !== "immediate"
      ) {
        return {
          code: "resource_relationship_invalid",
          field: "menu.entries.consumptionPlan.recipe",
        };
      }
    } else if (
      plan.mode.kind === "direct" &&
      plan.mode.commitOn !== "fulfillment_completed"
    ) {
      return {
        code: "resource_relationship_invalid",
        field: "menu.entries.consumptionPlan.commitOn",
      };
    }
    const modifierRefs = new Set<string>();
    for (const reference of entry.modifierGroupRevisions) {
      const identity = `${reference.modifierGroupId}:${reference.revision}`;
      if (modifierRefs.has(identity))
        return {
          code: "resource_relationship_invalid",
          field: "menu.entries.modifierGroupRevisions",
        };
      modifierRefs.add(identity);
      const modifier = foodService.modifierGroupRevisions.find(
        (candidate) => candidate.modifierGroupId === reference.modifierGroupId,
      );
      if (modifier === undefined)
        return {
          code: "resource_not_found",
          kind: "modifier_group_revision",
          id: reference.modifierGroupId,
        };
      if (
        modifier.revision !== reference.revision ||
        modifier.lifecycle.state !== "active"
      ) {
        return {
          code: "resource_relationship_invalid",
          field: "menu.entries.modifierGroupRevisions",
        };
      }
    }
  }
  return undefined;
}

function normalizedIdentity(value: string, field: string): string {
  if (value.length === 0 || value !== value.trim())
    throw new Error(`${field} must be normalized text`);
  return value;
}

type FoodServiceKind = FoodServiceResourceWrite["kind"];

/** The newest revision of each resource of a kind, as JSON, by id. */
export function readLatestFoodServiceJson(
  database: CommerceDatabase,
  merchantId: string,
  kind: FoodServiceKind,
): readonly string[] {
  return database
    .prepare(
      `SELECT resource_json AS resourceJson
         FROM food_service_resource AS resource
        WHERE merchant_id = ? AND resource_kind = ?
          AND revision = (
            SELECT MAX(latest.revision)
              FROM food_service_resource AS latest
             WHERE latest.merchant_id = resource.merchant_id
               AND latest.resource_kind = resource.resource_kind
               AND latest.resource_id = resource.resource_id
          )
        ORDER BY resource_id`,
    )
    .all<Readonly<{ resourceJson: string }>>(merchantId, kind)
    .map((row) => row.resourceJson);
}

/** One revision of a resource as JSON, or undefined. */
export function readFoodServiceRevisionJson(
  database: CommerceDatabase,
  merchantId: string,
  kind: FoodServiceKind,
  resourceId: string,
  revision: number,
): string | undefined {
  return database
    .prepare(
      `SELECT resource_json AS resourceJson FROM food_service_resource
        WHERE merchant_id = ? AND resource_kind = ? AND resource_id = ?
          AND revision = ?`,
    )
    .get<Readonly<{ resourceJson: string }>>(
      merchantId,
      kind,
      resourceId,
      revision,
    )?.resourceJson;
}
