import {
  type CommerceAdminClient,
  type CommerceClientError,
  type CommerceResourcesV1,
  type CommerceFoodServiceResourcesV1,
  type CommerceMutationResultV1,
  type CommerceOrderV1,
  type CommerceQuantityV1,
  type CommercePaymentV1,
  type CommerceFulfillmentV1,
  type CommercePickupFulfillmentV1,
} from "@seams/commerce-client";
import type { Variant } from "@seams/type-utils";

const OUTPUT_EXPIRES_AT = "2036-08-21T00:00:00.000Z";

const CAFE_MENU_ENTRIES = [
  {
    menuEntryId: "menu_entry_sesame_cookie",
    offerId: "offer_sesame_cookie_cafe",
    offerRevision: 1,
    consumptionPlanId: "consumption_plan_sesame_cookie",
  },
  {
    menuEntryId: "menu_entry_sesame_latte",
    offerId: "offer_sesame_latte_cafe",
    offerRevision: 2,
    consumptionPlanId: "consumption_plan_sesame_latte",
    modifierGroupRevisions: [
      { modifierGroupId: "modifier_group_milk", revision: 1 },
    ],
  },
  {
    menuEntryId: "menu_entry_sesame_financier",
    offerId: "offer_sesame_financier_cafe",
    offerRevision: 2,
    consumptionPlanId: "consumption_plan_sesame_financier",
  },
  {
    menuEntryId: "menu_entry_ginger_milk_tea",
    offerId: "offer_ginger_milk_tea_cafe",
    offerRevision: 2,
    consumptionPlanId: "consumption_plan_ginger_milk_tea",
    modifierGroupRevisions: [
      { modifierGroupId: "modifier_group_milk", revision: 1 },
    ],
  },
  {
    menuEntryId: "menu_entry_ginger_cookie",
    offerId: "offer_ginger_cookie_cafe",
    offerRevision: 2,
    consumptionPlanId: "consumption_plan_ginger_cookie",
  },
  {
    menuEntryId: "menu_entry_ginger_financier",
    offerId: "offer_ginger_financier_cafe",
    offerRevision: 2,
    consumptionPlanId: "consumption_plan_ginger_financier",
  },
  {
    menuEntryId: "menu_entry_taro_milk_tea",
    offerId: "offer_taro_milk_tea_cafe",
    offerRevision: 2,
    consumptionPlanId: "consumption_plan_taro_milk_tea",
    modifierGroupRevisions: [
      { modifierGroupId: "modifier_group_milk", revision: 1 },
    ],
  },
  {
    menuEntryId: "menu_entry_taro_cookie",
    offerId: "offer_taro_cookie_cafe",
    offerRevision: 2,
    consumptionPlanId: "consumption_plan_taro_cookie",
  },
  {
    menuEntryId: "menu_entry_taro_financier",
    offerId: "offer_taro_financier_cafe",
    offerRevision: 2,
    consumptionPlanId: "consumption_plan_taro_financier",
  },
  {
    menuEntryId: "menu_entry_matcha_tea",
    offerId: "offer_matcha_tea_cafe",
    offerRevision: 2,
    consumptionPlanId: "consumption_plan_matcha_tea",
  },
  {
    menuEntryId: "menu_entry_matcha_cookie",
    offerId: "offer_matcha_cookie_cafe",
    offerRevision: 2,
    consumptionPlanId: "consumption_plan_matcha_cookie",
  },
  {
    menuEntryId: "menu_entry_matcha_financier",
    offerId: "offer_matcha_financier_cafe",
    offerRevision: 2,
    consumptionPlanId: "consumption_plan_matcha_financier",
  },
] as const;

export type CafeOperationAction =
  | "publish_menu"
  | "complete_production"
  | "create_preparation"
  | "start_preparation"
  | "complete_preparation"
  | "mark_pickup_ready"
  | "complete_pickup";

export type CafeRelatedResource = Readonly<{
  kind:
    | "menu"
    | "production_batch"
    | "customer_order"
    | "preparation_ticket"
    | "pickup_fulfillment"
    | "inventory_item"
    | "recipe_revision";
  id: string;
  label: string;
}>;

export type CafeOrderModifier = Readonly<{
  modifierGroupId: string;
  modifierOptionId: string;
  groupName: string;
  name: string;
}>;

export type CafeOrderItem = Readonly<{
  lineItemId: string;
  sku: string;
  title: string;
  quantity: CommerceQuantityV1;
  fulfilledQuantity: CommerceQuantityV1;
  modifiers: readonly CafeOrderModifier[];
  linkedResources: readonly CafeRelatedResource[];
}>;

export type CafePickupOrder = Readonly<{
  orderId: string;
  fulfillmentId: string;
  items: readonly CafeOrderItem[];
}>;

export type CafeOperationsView = Readonly<{
  schemaVersion: "satyr.cafe-operations.v1";
  merchantRevision: number;
  menu: "ready_to_publish" | "published";
  production: "ready_to_complete" | "completed";
  preparation:
    | "awaiting_order"
    | "ready_to_create"
    | "queued"
    | "preparing"
    | "completed"
    | "cancelled";
  pickup: "awaiting_order" | "requested" | "ready_for_pickup" | "completed";
  order: CafePickupOrder | null;
  nextAction: CafeOperationAction | null;
  availableActions: readonly CafeOperationAction[];
  relatedResources: readonly CafeRelatedResource[];
}>;

export type CafeOperationError =
  | Readonly<{ code: "underclerk_unavailable"; cause: CommerceClientError }>
  | Readonly<{ code: "cafe_scenario_incomplete"; field: string }>
  | Readonly<{
      code: "cafe_operation_unavailable";
      action: CafeOperationAction;
    }>
  | Readonly<{
      code: "cafe_operation_rejected";
      result: CommerceMutationResultV1;
    }>;

export type CafeOperationResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: CafeOperationError }>;

type CafeOperationsClient = Pick<
  CommerceAdminClient,
  | "readSnapshot"
  | "readFoodServiceSnapshot"
  | "publishMenu"
  | "completeProductionBatch"
  | "managePreparationTicket"
  | "markPickupReady"
  | "completePickup"
>;

type CafeFoodServiceOrderLineSource = Variant<
  CommerceOrderV1["lineItems"][number]["source"],
  "food_service"
>;

type CafeScenarioState = Readonly<{
  merchantId: string;
  merchantRevision: number;
  commerce: CommerceResourcesV1;
  foodService: CommerceFoodServiceResourcesV1;
  order: CommerceOrderV1 | undefined;
  payment: CommercePaymentV1 | undefined;
  fulfillment: CommercePickupFulfillmentV1 | undefined;
  view: CafeOperationsView;
}>;

export async function readCafeOperations(
  client: CafeOperationsClient,
  merchantId: string,
): Promise<CafeOperationResult<CafeOperationsView>> {
  const state = await readCafeScenarioState(client, merchantId);
  return state.ok ? { ok: true, value: state.value.view } : state;
}

export async function executeCafeOperation(
  input: Readonly<{
    client: CafeOperationsClient;
    merchantId: string;
    action: CafeOperationAction;
    idempotencyKey: string;
  }>,
): Promise<
  CafeOperationResult<
    Readonly<{
      receipt: CommerceMutationResultV1;
      view: CafeOperationsView;
    }>
  >
> {
  const state = await readCafeScenarioState(input.client, input.merchantId);
  if (!state.ok) return state;
  if (!state.value.view.availableActions.includes(input.action)) {
    return {
      ok: false,
      error: { code: "cafe_operation_unavailable", action: input.action },
    };
  }
  const applied = await applyCafeOperation(input, state.value);
  if (!applied.ok) return commerceUnavailable(applied.error);
  if (applied.value.outcome === "rejected") {
    return {
      ok: false,
      error: { code: "cafe_operation_rejected", result: applied.value },
    };
  }
  const refreshed = await readCafeScenarioState(input.client, input.merchantId);
  if (!refreshed.ok) return refreshed;
  return {
    ok: true,
    value: { receipt: applied.value, view: refreshed.value.view },
  };
}

async function readCafeScenarioState(
  client: CafeOperationsClient,
  merchantId: string,
): Promise<CafeOperationResult<CafeScenarioState>> {
  const [commerce, foodService] = await Promise.all([
    client.readSnapshot(merchantId),
    client.readFoodServiceSnapshot(merchantId),
  ]);
  if (!commerce.ok) return commerceUnavailable(commerce.error);
  if (!foodService.ok) return commerceUnavailable(foodService.error);
  if (
    commerce.value.merchantId !== merchantId ||
    foodService.value.merchantId !== merchantId ||
    foodService.value.merchantRevision !== commerce.value.merchantRevision
  ) {
    return scenarioIncomplete("snapshot.identity");
  }
  const baseError = validateCafeScenarioBase(
    commerce.value.resources,
    foodService.value.resources,
  );
  if (baseError !== null) return scenarioIncomplete(baseError);
  const orderResult = scenarioOrder(commerce.value.resources.orders);
  if (!orderResult.ok) return orderResult;
  const order = orderResult.value;
  const paymentResult = scenarioPayment(
    commerce.value.resources.payments,
    order,
  );
  if (!paymentResult.ok) return paymentResult;
  const fulfillmentResult = scenarioFulfillment(
    commerce.value.resources.fulfillments,
    order,
  );
  if (!fulfillmentResult.ok) return fulfillmentResult;
  const view = buildCafeOperationsView(
    commerce.value.merchantRevision,
    commerce.value.resources,
    foodService.value.resources,
    order,
    fulfillmentResult.value,
  );
  return {
    ok: true,
    value: {
      merchantId,
      merchantRevision: commerce.value.merchantRevision,
      commerce: commerce.value.resources,
      foodService: foodService.value.resources,
      order,
      payment: paymentResult.value,
      fulfillment: fulfillmentResult.value,
      view,
    },
  };
}

function validateCafeScenarioBase(
  commerce: CommerceResourcesV1,
  foodService: CommerceFoodServiceResourcesV1,
): string | null {
  const commerceIdentities = [
    [commerce.locations, "location_cafe"],
    [commerce.inventoryItems, "inventory_sesame_cookie"],
    [commerce.inventoryItems, "inventory_oat_milk"],
    [commerce.inventoryItems, "inventory_flour"],
    [commerce.inventoryItems, "inventory_butter"],
    [commerce.inventoryItems, "inventory_sugar"],
    [commerce.inventoryItems, "inventory_black_sesame"],
    [commerce.inventoryItems, "inventory_glutinous_rice_flour"],
    [commerce.inventoryItems, "inventory_water"],
    [commerce.inventoryItems, "inventory_salt"],
    [commerce.inventoryItems, "inventory_almond_flour"],
    [commerce.inventoryItems, "inventory_whole_milk"],
    [commerce.offers, "offer_sesame_cookie_cafe"],
    [commerce.offers, "offer_sesame_latte_cafe"],
    [commerce.offers, "offer_sesame_financier_cafe"],
  ] as const;
  for (const [resources, resourceId] of commerceIdentities) {
    if (!resources.some(resourceIdMatches.bind(undefined, resourceId)))
      return resourceId;
  }
  if (
    !foodService.recipeRevisions.some(
      recipeIdMatches.bind(undefined, "recipe_sesame_cookie_stocked"),
    ) ||
    !foodService.recipeRevisions.some(
      recipeIdMatches.bind(undefined, "recipe_sesame_latte"),
    ) ||
    !foodService.recipeRevisions.some(
      recipeIdMatches.bind(undefined, "recipe_sesame_financier"),
    ) ||
    !foodService.preparationStations.some(
      stationIdMatches.bind(undefined, "station_bakery"),
    ) ||
    !foodService.preparationStations.some(
      stationIdMatches.bind(undefined, "station_bar"),
    ) ||
    !foodService.modifierGroupRevisions.some(
      modifierGroupIdMatches.bind(undefined, "modifier_group_milk"),
    ) ||
    !foodService.stockPolicies.some(
      stockPolicyIdMatches.bind(undefined, "stock_policy_oat_milk_cafe"),
    )
  ) {
    return "food_service_setup";
  }
  return null;
}

function resourceIdMatches(
  resourceId: string,
  resource: Readonly<{ id: string }>,
): boolean {
  return resource.id === resourceId;
}

function recipeIdMatches(
  recipeId: string,
  recipe: CommerceFoodServiceResourcesV1["recipeRevisions"][number],
): boolean {
  return recipe.recipeId === recipeId;
}

function stationIdMatches(
  stationId: string,
  station: CommerceFoodServiceResourcesV1["preparationStations"][number],
): boolean {
  return station.stationId === stationId;
}

function modifierGroupIdMatches(
  modifierGroupId: string,
  group: CommerceFoodServiceResourcesV1["modifierGroupRevisions"][number],
): boolean {
  return group.modifierGroupId === modifierGroupId;
}

function stockPolicyIdMatches(
  stockPolicyId: string,
  policy: CommerceFoodServiceResourcesV1["stockPolicies"][number],
): boolean {
  return policy.stockPolicyId === stockPolicyId;
}

function buildCafeOperationsView(
  merchantRevision: number,
  commerce: CommerceResourcesV1,
  foodService: CommerceFoodServiceResourcesV1,
  order: CommerceOrderV1 | undefined,
  fulfillment: CommercePickupFulfillmentV1 | undefined,
): CafeOperationsView {
  const menu = foodService.menus.some(isScenarioMenu)
    ? "published"
    : "ready_to_publish";
  const production = foodService.productionBatches.some(
    isScenarioProductionBatch,
  )
    ? "completed"
    : "ready_to_complete";
  const ticket = foodService.preparationTickets.find(
    isScenarioPreparationTicket.bind(undefined, order, fulfillment),
  );
  const preparation = preparationState(order, ticket);
  const pickup = pickupState(fulfillment);
  const availableActions = availableCafeActions({
    menu,
    production,
    preparation,
    pickup,
  });
  return {
    schemaVersion: "satyr.cafe-operations.v1",
    merchantRevision,
    menu,
    production,
    preparation,
    pickup,
    order: cafePickupOrder(commerce, foodService, order, fulfillment),
    nextAction: cafeNextAction(availableActions),
    availableActions,
    relatedResources: cafeRelatedResources(
      menu,
      production,
      ticket,
      order,
      fulfillment,
    ),
  };
}

function cafePickupOrder(
  commerce: CommerceResourcesV1,
  foodService: CommerceFoodServiceResourcesV1,
  order: CommerceOrderV1 | undefined,
  fulfillment: CommercePickupFulfillmentV1 | undefined,
): CafePickupOrder | null {
  if (order === undefined || fulfillment === undefined) return null;
  return {
    orderId: order.id,
    fulfillmentId: fulfillment.id,
    items: order.lineItems.map(
      buildCafeOrderItem.bind(undefined, commerce, foodService),
    ),
  };
}

function buildCafeOrderItem(
  commerce: CommerceResourcesV1,
  foodService: CommerceFoodServiceResourcesV1,
  line: CommerceOrderV1["lineItems"][number],
): CafeOrderItem {
  const source = line.source;
  const modifiers =
    source.kind === "food_service"
      ? source.modifiers.map(
          buildCafeOrderModifier.bind(undefined, foodService),
        )
      : [];
  return {
    lineItemId: line.id,
    sku: line.sku,
    title: line.title,
    quantity: line.quantity,
    fulfilledQuantity: line.fulfilledQuantity,
    modifiers,
    linkedResources: cafeOrderItemResources(commerce, foodService, source),
  };
}

function buildCafeOrderModifier(
  foodService: CommerceFoodServiceResourcesV1,
  modifier: CafeFoodServiceOrderLineSource["modifiers"][number],
): CafeOrderModifier {
  const group = foodService.modifierGroupRevisions.find(
    modifierGroupRevisionMatches.bind(undefined, modifier),
  );
  return {
    modifierGroupId: modifier.modifierGroupId,
    modifierOptionId: modifier.modifierOptionId,
    groupName: group?.name ?? modifier.modifierGroupId,
    name: modifier.name,
  };
}

function cafeOrderItemResources(
  commerce: CommerceResourcesV1,
  foodService: CommerceFoodServiceResourcesV1,
  source: CommerceOrderV1["lineItems"][number]["source"],
): readonly CafeRelatedResource[] {
  if (source.kind === "source_only") return [];
  const resources: CafeRelatedResource[] = [];
  const requirements =
    source.inventory.kind === "requirements" ? source.inventory.items : [];
  for (const requirement of requirements) {
    const inventory = commerce.inventoryItems.find(
      resourceIdMatches.bind(undefined, requirement.inventoryItemId),
    );
    resources.push({
      kind: "inventory_item",
      id: requirement.inventoryItemId,
      label: inventory?.name ?? requirement.inventoryItemId,
    });
  }
  const recipe = cafeOrderRecipe(foodService, source, requirements);
  if (recipe !== undefined) {
    resources.push({
      kind: "recipe_revision",
      id: recipe.recipeId,
      label: recipe.name,
    });
    for (const input of recipe.inputs) {
      const inventory = commerce.inventoryItems.find(
        resourceIdMatches.bind(undefined, input.inventoryItemId),
      );
      resources.push({
        kind: "inventory_item",
        id: input.inventoryItemId,
        label: inventory?.name ?? input.inventoryItemId,
      });
    }
  }
  return uniqueCafeResources(resources);
}

function cafeOrderRecipe(
  foodService: CommerceFoodServiceResourcesV1,
  source: Variant<
    CommerceOrderV1["lineItems"][number]["source"],
    "catalog" | "food_service"
  >,
  requirements: readonly Readonly<{ inventoryItemId: string }>[],
): CommerceFoodServiceResourcesV1["recipeRevisions"][number] | undefined {
  if (source.kind === "food_service") {
    const preparation = source.preparation;
    if (preparation.kind === "immediate_recipe") {
      return foodService.recipeRevisions.find(
        recipeRevisionMatches.bind(
          undefined,
          preparation.recipeId,
          preparation.recipeRevision,
        ),
      );
    }
  }
  return foodService.recipeRevisions.find(
    recipeOutputMatches.bind(undefined, requirements),
  );
}

function modifierGroupRevisionMatches(
  modifier: CafeFoodServiceOrderLineSource["modifiers"][number],
  candidate: CommerceFoodServiceResourcesV1["modifierGroupRevisions"][number],
): boolean {
  return (
    candidate.modifierGroupId === modifier.modifierGroupId &&
    candidate.revision === modifier.modifierGroupRevision
  );
}

function recipeRevisionMatches(
  recipeId: string,
  revision: number,
  candidate: CommerceFoodServiceResourcesV1["recipeRevisions"][number],
): boolean {
  return candidate.recipeId === recipeId && candidate.revision === revision;
}

function recipeOutputMatches(
  requirements: readonly Readonly<{ inventoryItemId: string }>[],
  candidate: CommerceFoodServiceResourcesV1["recipeRevisions"][number],
): boolean {
  return (
    candidate.output.kind === "stocked" &&
    requirements.some(
      requirementInventoryItemMatches.bind(
        undefined,
        candidate.output.inventoryItemId,
      ),
    )
  );
}

function requirementInventoryItemMatches(
  inventoryItemId: string,
  requirement: Readonly<{ inventoryItemId: string }>,
): boolean {
  return requirement.inventoryItemId === inventoryItemId;
}

function uniqueCafeResources(
  resources: readonly CafeRelatedResource[],
): readonly CafeRelatedResource[] {
  const seen = new Set<string>();
  const unique: CafeRelatedResource[] = [];
  for (const resource of resources) {
    const key = `${resource.kind}:${resource.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(resource);
  }
  return unique;
}

function cafeRelatedResources(
  menu: CafeOperationsView["menu"],
  production: CafeOperationsView["production"],
  ticket:
    CommerceFoodServiceResourcesV1["preparationTickets"][number] | undefined,
  order: CommerceOrderV1 | undefined,
  fulfillment: CommercePickupFulfillmentV1 | undefined,
): readonly CafeRelatedResource[] {
  const resources: CafeRelatedResource[] = [];
  if (menu === "published")
    resources.push({ kind: "menu", id: "menu_cafe_main", label: "Café menu" });
  if (production === "completed")
    resources.push({
      kind: "production_batch",
      id: "production_batch_sesame_cookie_20260814_a",
      label: "Sesame Cookie production batch",
    });
  if (order !== undefined)
    resources.push({
      kind: "customer_order",
      id: order.id,
      label: "Customer order",
    });
  if (ticket !== undefined)
    resources.push({
      kind: "preparation_ticket",
      id: ticket.ticketId,
      label: "Pickup preparation ticket",
    });
  if (fulfillment !== undefined)
    resources.push({
      kind: "pickup_fulfillment",
      id: fulfillment.id,
      label: "Pickup fulfillment",
    });
  return resources;
}

function availableCafeActions(
  input: Readonly<{
    menu: CafeOperationsView["menu"];
    production: CafeOperationsView["production"];
    preparation: CafeOperationsView["preparation"];
    pickup: CafeOperationsView["pickup"];
  }>,
): readonly CafeOperationAction[] {
  const actions: CafeOperationAction[] = [];
  if (input.menu === "ready_to_publish") actions.push("publish_menu");
  if (input.production === "ready_to_complete")
    actions.push("complete_production");
  switch (input.preparation) {
    case "awaiting_order":
      break;
    case "ready_to_create":
      actions.push("create_preparation");
      break;
    case "queued":
      actions.push("start_preparation");
      break;
    case "preparing":
      actions.push("complete_preparation");
      break;
    case "completed":
      if (input.pickup === "requested") actions.push("mark_pickup_ready");
      break;
    // Staff cancelled the order before its preparation ended.
    case "cancelled":
      break;
  }
  if (input.pickup === "ready_for_pickup") actions.push("complete_pickup");
  return actions;
}

function cafeNextAction(
  availableActions: readonly CafeOperationAction[],
): CafeOperationAction | null {
  const priority: readonly CafeOperationAction[] = [
    "publish_menu",
    "complete_production",
    "create_preparation",
    "start_preparation",
    "complete_preparation",
    "mark_pickup_ready",
    "complete_pickup",
  ];
  return (
    priority.find(actionIsAvailable.bind(undefined, availableActions)) ?? null
  );
}

function actionIsAvailable(
  availableActions: readonly CafeOperationAction[],
  action: CafeOperationAction,
): boolean {
  return availableActions.includes(action);
}

async function applyCafeOperation(
  input: Readonly<{
    client: CafeOperationsClient;
    merchantId: string;
    action: CafeOperationAction;
    idempotencyKey: string;
  }>,
  state: CafeScenarioState,
) {
  switch (input.action) {
    case "publish_menu":
      return input.client.publishMenu(
        publishMenuCommand(state, input.idempotencyKey),
      );
    case "complete_production":
      return input.client.completeProductionBatch(
        productionCommand(state, input.idempotencyKey),
      );
    case "create_preparation":
      return input.client.managePreparationTicket(
        createPreparationCommand(state, input.idempotencyKey),
      );
    case "start_preparation":
    case "complete_preparation":
      return input.client.managePreparationTicket(
        transitionPreparationCommand(state, input.action, input.idempotencyKey),
      );
    case "mark_pickup_ready":
      return input.client.markPickupReady(
        markPickupReadyCommand(state, input.idempotencyKey),
      );
    case "complete_pickup":
      return input.client.completePickup(
        completePickupCommand(state, input.idempotencyKey),
      );
  }
}

function publishMenuCommand(state: CafeScenarioState, idempotencyKey: string) {
  return {
    ...commandBase(state, idempotencyKey),
    menu: {
      menuId: "menu_cafe_main",
      name: "Cafe main menu",
      salesChannelId: "sales_channel_cafe",
      scope: { kind: "location" as const, locationId: "location_cafe" },
      validity: { kind: "always" as const },
      sections: [{ sectionId: "section_cafe", name: "Cafe", position: 0 }],
      entries: CAFE_MENU_ENTRIES.map(buildCafeMenuEntry),
    },
  };
}

function buildCafeMenuEntry(entry: (typeof CAFE_MENU_ENTRIES)[number]) {
  return {
    menuEntryId: entry.menuEntryId,
    sectionId: "section_cafe" as const,
    offerId: entry.offerId,
    offerRevision: entry.offerRevision,
    consumptionPlanId: entry.consumptionPlanId,
    consumptionPlanRevision: 1,
    modifierGroupRevisions:
      "modifierGroupRevisions" in entry ? entry.modifierGroupRevisions : [],
  };
}

function productionCommand(state: CafeScenarioState, idempotencyKey: string) {
  const output = requiredPosition(state.commerce, "inventory_sesame_cookie");
  const inputs = [
    "inventory_flour",
    "inventory_butter",
    "inventory_sugar",
    "inventory_black_sesame",
  ].map(requiredPosition.bind(undefined, state.commerce));
  return {
    ...commandBase(state, idempotencyKey),
    productionBatchId: "production_batch_sesame_cookie_20260814_a",
    demand: { kind: "stock" as const },
    outputLotId: "lot_sesame_cookie_20260814_a",
    outputInventoryPositionId: output.id,
    recipeId: "recipe_sesame_cookie_stocked",
    recipeRevision: 1,
    stationId: "station_bakery",
    locationId: "location_cafe",
    plannedYield: { amount: 24, scale: 0, unit: "each" as const },
    actualYield: { amount: 22, scale: 0, unit: "each" as const },
    outputLotCode: "SESAME-COOKIE-20260814-A",
    outputExpiresAt: OUTPUT_EXPIRES_AT,
    expectedInputPositionRevisions: inputs.map(positionRevision),
    expectedOutputPositionRevision: output.revision,
  };
}

function createPreparationCommand(
  state: CafeScenarioState,
  idempotencyKey: string,
) {
  const order = requireScenarioOrder(state);
  const fulfillment = requireScenarioFulfillment(state);
  return {
    ...commandBase(state, idempotencyKey),
    operation: {
      kind: "create" as const,
      ticketId: requireScenarioPreparationTicketId(order, fulfillment),
      orderId: order.id,
      fulfillmentId: fulfillment.id,
      stationId: "station_bar",
    },
  };
}

function transitionPreparationCommand(
  state: CafeScenarioState,
  action: "start_preparation" | "complete_preparation",
  idempotencyKey: string,
) {
  const ticket = state.foodService.preparationTickets.find(
    isScenarioPreparationTicket.bind(undefined, state.order, state.fulfillment),
  );
  if (ticket === undefined)
    throw new Error("Preparation transition lacks the scenario ticket");
  return {
    ...commandBase(state, idempotencyKey),
    operation: {
      kind:
        action === "start_preparation"
          ? ("start" as const)
          : ("complete" as const),
      ticketId: ticket.ticketId,
      expectedTicketRevision: ticket.revision,
    },
  };
}

function markPickupReadyCommand(
  state: CafeScenarioState,
  idempotencyKey: string,
) {
  const order = requireScenarioOrder(state);
  const fulfillment = requireScenarioFulfillment(state);
  return {
    ...commandBase(state, idempotencyKey),
    orderId: order.id,
    orderRevision: order.revision,
    fulfillmentId: fulfillment.id,
    fulfillmentRevision: fulfillment.revision,
  };
}

function completePickupCommand(
  state: CafeScenarioState,
  idempotencyKey: string,
) {
  const order = requireScenarioOrder(state);
  const payment = state.payment;
  const fulfillment = requireScenarioFulfillment(state);
  if (payment === undefined)
    throw new Error("Pickup completion lacks the scenario payment");
  return {
    ...commandBase(state, idempotencyKey),
    orderId: order.id,
    orderRevision: order.revision,
    paymentId: payment.id,
    paymentRevision: payment.revision,
    fulfillmentId: fulfillment.id,
    fulfillmentRevision: fulfillment.revision,
  };
}

function commandBase(state: CafeScenarioState, idempotencyKey: string) {
  return {
    merchantId: state.merchantId,
    expectedMerchantRevision: state.merchantRevision,
    idempotencyKey,
  };
}

function scenarioOrder(
  orders: readonly CommerceOrderV1[],
): CafeOperationResult<CommerceOrderV1 | undefined> {
  const candidates = orders.filter(isScenarioOrder);
  if (candidates.length > 1) return scenarioIncomplete("order.ambiguous");
  return { ok: true, value: candidates[0] };
}

function scenarioPayment(
  payments: readonly CommercePaymentV1[],
  order: CommerceOrderV1 | undefined,
): CafeOperationResult<CommercePaymentV1 | undefined> {
  if (order === undefined) return { ok: true, value: undefined };
  const candidates = payments.filter(paymentForOrder.bind(undefined, order.id));
  if (
    candidates.length !== 1 ||
    candidates[0]?.lifecycle.state !== "captured"
  ) {
    return scenarioIncomplete("payment");
  }
  return { ok: true, value: candidates[0] };
}

function scenarioFulfillment(
  fulfillments: readonly CommerceFulfillmentV1[],
  order: CommerceOrderV1 | undefined,
): CafeOperationResult<CommercePickupFulfillmentV1 | undefined> {
  if (order === undefined) return { ok: true, value: undefined };
  const candidates = fulfillments.filter(
    fulfillmentForOrder.bind(undefined, order.id),
  );
  if (candidates.length !== 1 || candidates[0]?.kind !== "pickup") {
    return scenarioIncomplete("fulfillment");
  }
  return { ok: true, value: candidates[0] };
}

function isScenarioOrder(order: CommerceOrderV1): boolean {
  return order.lineItems.some(isScenarioCafeFoodServiceLine);
}

function isScenarioCafeFoodServiceLine(
  line: CommerceOrderV1["lineItems"][number],
): boolean {
  return (
    line.source.kind === "food_service" &&
    line.source.menuId === "menu_cafe_main"
  );
}

function paymentForOrder(
  orderId: string,
  payment: CommercePaymentV1,
): boolean {
  return payment.orderId === orderId;
}

function fulfillmentForOrder(
  orderId: string,
  fulfillment: CommerceFulfillmentV1,
): boolean {
  return fulfillment.orderId === orderId;
}

function preparationState(
  order: CommerceOrderV1 | undefined,
  ticket:
    CommerceFoodServiceResourcesV1["preparationTickets"][number] | undefined,
): CafeOperationsView["preparation"] {
  if (ticket === undefined) {
    return order === undefined
      ? "awaiting_order"
      : orderNeedsCafePreparation(order)
        ? "ready_to_create"
        : "completed";
  }
  return ticket.lifecycle.state;
}

function pickupState(
  fulfillment: CommercePickupFulfillmentV1 | undefined,
): CafeOperationsView["pickup"] {
  if (fulfillment === undefined) return "awaiting_order";
  switch (fulfillment.lifecycle.state) {
    case "requested":
    case "preparing":
    case "blocked":
      return "requested";
    case "ready_for_pickup":
      return "ready_for_pickup";
    case "completed":
      return "completed";
    case "cancelled":
      throw new Error("Scenario pickup was cancelled");
  }
}

function isScenarioMenu(
  menu: CommerceFoodServiceResourcesV1["menus"][number],
): boolean {
  return (
    menu.menuId === "menu_cafe_main" && menu.lifecycle.state === "published"
  );
}

function isScenarioProductionBatch(
  batch: CommerceFoodServiceResourcesV1["productionBatches"][number],
): boolean {
  return (
    batch.productionBatchId === "production_batch_sesame_cookie_20260814_a"
  );
}

function isScenarioPreparationTicket(
  order: CommerceOrderV1 | undefined,
  fulfillment: CommercePickupFulfillmentV1 | undefined,
  ticket: CommerceFoodServiceResourcesV1["preparationTickets"][number],
): boolean {
  const ticketId = scenarioPreparationTicketId(order, fulfillment);
  return (
    ticketId !== undefined &&
    ticket.ticketId === ticketId &&
    ticket.orderId === order?.id &&
    ticket.fulfillmentId === fulfillment?.id
  );
}

function scenarioPreparationTicketId(
  order: CommerceOrderV1 | undefined,
  fulfillment: CommercePickupFulfillmentV1 | undefined,
): string | undefined {
  if (
    order === undefined ||
    fulfillment === undefined ||
    fulfillment.orderId !== order.id
  )
    return undefined;
  return `preparation_ticket_${order.id}_${fulfillment.id}`;
}

function requireScenarioPreparationTicketId(
  order: CommerceOrderV1,
  fulfillment: CommercePickupFulfillmentV1,
): string {
  const ticketId = scenarioPreparationTicketId(order, fulfillment);
  if (ticketId === undefined)
    throw new Error("Scenario preparation ticket lacks the order relationship");
  return ticketId;
}

function orderNeedsCafePreparation(order: CommerceOrderV1): boolean {
  return order.lineItems.some(cafeLineNeedsPreparation);
}

function cafeLineNeedsPreparation(
  line: CommerceOrderV1["lineItems"][number],
): boolean {
  return (
    line.source.kind === "food_service" &&
    line.source.preparation.kind === "immediate_recipe"
  );
}

function requiredPosition(
  resources: CommerceResourcesV1,
  inventoryItemId: string,
) {
  const candidates = resources.inventoryPositions.filter(
    positionForItem.bind(undefined, inventoryItemId),
  );
  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new Error(`Scenario position is missing for ${inventoryItemId}`);
  }
  return candidates[0];
}

function positionForItem(
  inventoryItemId: string,
  position: CommerceResourcesV1["inventoryPositions"][number],
): boolean {
  return (
    position.inventoryItemId === inventoryItemId &&
    position.locationId === "location_cafe"
  );
}

function positionRevision(
  position: CommerceResourcesV1["inventoryPositions"][number],
): Readonly<{ inventoryPositionId: string; revision: number }> {
  return { inventoryPositionId: position.id, revision: position.revision };
}

function requireScenarioOrder(state: CafeScenarioState): CommerceOrderV1 {
  if (state.order === undefined)
    throw new Error("Scenario order is unavailable");
  return state.order;
}

function requireScenarioFulfillment(
  state: CafeScenarioState,
): CommercePickupFulfillmentV1 {
  if (state.fulfillment === undefined)
    throw new Error("Scenario fulfillment is unavailable");
  return state.fulfillment;
}

function commerceUnavailable<T>(
  cause: CommerceClientError,
): CafeOperationResult<T> {
  return { ok: false, error: { code: "underclerk_unavailable", cause } };
}

function scenarioIncomplete<T>(field: string): CafeOperationResult<T> {
  return { ok: false, error: { code: "cafe_scenario_incomplete", field } };
}

export function parseCafeOperationAction(
  value: unknown,
): CafeOperationAction | null {
  switch (value) {
    case "publish_menu":
    case "complete_production":
    case "create_preparation":
    case "start_preparation":
    case "complete_preparation":
    case "mark_pickup_ready":
    case "complete_pickup":
      return value;
    default:
      return null;
  }
}
