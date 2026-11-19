import { readRecipeRevision } from "./food-service-store.ts";
// The menus of a café (Plan 76 phase 5): a buyer's menu line with its
// modifiers, recipe and preparation, and the menus a buyer sees.
import type {
  CommerceMutationErrorV1,
  CommerceBuyerMenuEntryV1,
  CommerceBuyerMenuV1,
  CommerceBuyerModifierGroupV1,
  CommerceResourcesV1,
  CommerceOfferV1,
} from "@purin-labs/commerce-client";
import type {
  FoodServicePreparation,
  InventoryConsumptionPlan,
  InventoryRequirement,
  Menu,
  ModifierGroupRevision,
  ModifierSelectionSnapshot,
  Quantity,
} from "@purin-labs/commerce-contracts";

import { readConsumptionPlan } from "../../checkout-persistence.ts";
import {
  availableBalanceSatisfies,
  checkoutPlanRejected,
  consumptionPlanAppliesToLocation,
  resolveCheckoutConsumptionPlan,
  safeAdd,
  selectionRejected,
} from "../../commerce-authority/checkout-planning.ts";
import { variantIsSellable } from "../../commerce-authority/checkout-shared.ts";
import {
  readUsableInventoryQuantity,
  scaledAmount,
} from "../../commerce-authority/inventory-planning.ts";
import type { CommerceDatabase } from "../../database.ts";
import type { FoodServiceMenus } from "../built-in-ports.ts";
import { menuScheduleIsOpen } from "./menu-schedule.ts";
import {
  variantIsMarkedSoldOut,
  variantsMarkedSoldOut,
} from "./sold-out-marks.ts";
import { readInventoryPositionForItemLocation } from "../../inventory-persistence.ts";

/** One menu line of a checkout, planned against the menu and its recipe. */
function selectMenuLine(
  input: Parameters<FoodServiceMenus["select"]>[0],
): ReturnType<FoodServiceMenus["select"]> {
  const {
    database,
    merchantId,
    selection,
    foodService,
    resources,
    salesChannelId,
    locationId,
    now,
  } = input;
  if (selection.kind !== "menu") return selectionRejected("checkout.menu");
  const menu = foodService.menus.find(
    (candidate) => candidate.menuId === selection.menuId,
  );
  if (
    menu === undefined ||
    menu.lifecycle.state !== "published" ||
    menu.salesChannelId !== salesChannelId ||
    !menuVisibleAtLocation(menu, locationId, now)
  )
    return selectionRejected("checkout.menu");
  const entry = menu.entries.find(
    (candidate) =>
      candidate.menuEntryId === selection.menuEntryId &&
      candidate.lifecycle === "active",
  );
  if (entry === undefined) return checkoutPlanRejected("checkout.menuEntry");
  // A menu entry cites its offer by id. The quote pins the offer revision it
  // priced, so a later price change keeps the entry on sale.
  const offer = resources.offers.find(
    (candidate) =>
      candidate.id === entry.offerId &&
      candidate.salesChannelId === salesChannelId &&
      candidate.lifecycle.state === "listed" &&
      candidate.availability.state === "available",
  );
  if (offer === undefined) return checkoutPlanRejected("checkout.offer");
  const variant = resources.variants.find(
    (candidate) => candidate.id === offer.variantId,
  );
  if (variant === undefined) return checkoutPlanRejected("checkout.variant");
  if (!variantIsSellable(resources.products, variant))
    return checkoutPlanRejected("checkout.variant");
  if (variantIsMarkedSoldOut(database, merchantId, locationId, variant.id, now))
    return checkoutPlanRejected("checkout.soldOut");
  const consumptionPlan = resolveCheckoutConsumptionPlan(
    database,
    merchantId,
    variant.id,
    locationId,
  );
  if (
    consumptionPlan === undefined ||
    consumptionPlan.consumptionPlanId !== entry.consumptionPlanId ||
    consumptionPlan.revision !== entry.consumptionPlanRevision
  ) {
    return checkoutPlanRejected("checkout.consumptionPlan");
  }
  if (consumptionPlan.mode.kind === "untracked") {
    return selectionRejected("checkout.menu.consumptionPlan");
  }
  if (
    consumptionPlan.mode.kind === "direct" &&
    consumptionPlan.mode.commitOn !== "fulfillment_completed"
  ) {
    return selectionRejected("checkout.menu.consumptionPlan.commitOn");
  }
  if (!consumptionPlanAppliesToLocation(consumptionPlan, locationId)) {
    return selectionRejected("checkout.menu.consumptionPlan.scope");
  }
  const modifierResult = resolveMenuModifiers(
    selection.modifierOptionIds,
    entry,
    foodService.modifierGroupRevisions,
  );
  if (modifierResult.kind === "rejected") return modifierResult;
  const baseRequirements = consumptionRequirementsForPlan(
    consumptionPlan,
    database,
    merchantId,
  );
  if (baseRequirements === undefined)
    return checkoutPlanRejected("checkout.recipe");
  const requirements = applyModifierRequirements(
    baseRequirements,
    modifierResult.value.map((item) => item.requirementAdjustments),
  );
  if (requirements === undefined)
    return checkoutPlanRejected("checkout.modifiers.requirements");
  const linePrice = addModifierPrice(offer.price, modifierResult.value);
  if (linePrice === undefined)
    return checkoutPlanRejected("checkout.modifiers.price");
  const preparation = preparationForPlan(consumptionPlan, database, merchantId);
  if (preparation === undefined) return checkoutPlanRejected("checkout.recipe");
  return {
    kind: "planned",
    value: {
      variant,
      offer: { ...offer, price: linePrice },
      consumptionPlan,
      requirements,
      consumeOn:
        consumptionPlan.mode.kind === "prepared"
          ? "preparation_completed"
          : consumptionPlan.mode.commitOn,
      source: {
        kind: "food_service",
        variantId: variant.id,
        variantRevision: variant.revision,
        merchantCode: variant.sku,
        optionValues: [...variant.options],
        menuId: menu.menuId,
        menuRevision: menu.revision,
        menuEntryId: entry.menuEntryId,
        menuEntryRevision: entry.revision,
        offerId: offer.id,
        offerRevision: offer.revision,
        consumptionPlanId: consumptionPlan.consumptionPlanId,
        consumptionPlanRevision: consumptionPlan.revision,
        preparation,
        modifiers: [...modifierResult.value],
        inventory:
          requirements.length === 0
            ? { kind: "untracked" }
            : { kind: "requirements", items: [...requirements] },
      },
    },
  };
}

export const foodServiceMenus: FoodServiceMenus = {
  select: selectMenuLine,
  buyerMenus: (input) =>
    buyerMenus(
      input.foodService.menus,
      input.foodService.modifierGroupRevisions,
      input.resources.offers,
      input.resources.variants,
      input.resources.products,
      input.salesChannelId,
      input.locationId,
      input.database,
      input.merchantId,
      input.now,
    ),
  variantSoldOut: variantIsMarkedSoldOut,
  soldOutVariants: variantsMarkedSoldOut,
};

function preparationForPlan(
  plan: InventoryConsumptionPlan,
  database: CommerceDatabase,
  merchantId: string,
): FoodServicePreparation | undefined {
  const mode = plan.mode;
  if (mode.kind === "prepared") {
    const recipe = readRecipeRevision(
      database,
      merchantId,
      mode.recipeId,
      mode.recipeRevision,
    );
    return recipe === undefined ||
      recipe.lifecycle.state !== "active" ||
      recipe.output.kind !== "immediate"
      ? undefined
      : {
          kind: "immediate_recipe",
          recipeId: mode.recipeId,
          recipeRevision: mode.recipeRevision,
        };
  }
  return { kind: "stocked_inventory" };
}

function consumptionRequirementsForPlan(
  plan: InventoryConsumptionPlan,
  database: CommerceDatabase,
  merchantId: string,
): readonly InventoryRequirement[] | undefined {
  const mode = plan.mode;
  if (mode.kind === "untracked") return [];
  if (mode.kind === "direct") return mode.components;
  const recipe = readRecipeRevision(
    database,
    merchantId,
    mode.recipeId,
    mode.recipeRevision,
  );
  return recipe?.lifecycle.state === "active" &&
    recipe.output.kind === "immediate"
    ? recipe.inputs
    : undefined;
}

function resolveMenuModifiers(
  selectedOptionIds: readonly string[],
  entry: Menu["entries"][number],
  groups: readonly ModifierGroupRevision[],
):
  | { kind: "planned"; value: readonly ModifierSelectionSnapshot[] }
  | { kind: "rejected"; error: CommerceMutationErrorV1 } {
  if (new Set(selectedOptionIds).size !== selectedOptionIds.length) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "checkout.modifiers.duplicate",
      },
    };
  }
  const selectedGroupByOption = new Map<string, ModifierGroupRevision>();
  const resolvedGroups: ModifierGroupRevision[] = [];
  for (const reference of entry.modifierGroupRevisions) {
    const group = groups.find(
      (candidate) =>
        candidate.modifierGroupId === reference.modifierGroupId &&
        candidate.revision === reference.revision &&
        candidate.lifecycle.state === "active",
    );
    if (group === undefined)
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "checkout.modifiers.group",
        },
      };
    for (const option of group.options) {
      if (selectedGroupByOption.has(option.modifierOptionId)) {
        return {
          kind: "rejected",
          error: {
            code: "resource_relationship_invalid",
            field: "checkout.modifiers.option",
          },
        };
      }
      selectedGroupByOption.set(option.modifierOptionId, group);
    }
    resolvedGroups.push(group);
  }
  for (const optionId of selectedOptionIds) {
    if (!selectedGroupByOption.has(optionId)) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "checkout.modifiers.option",
        },
      };
    }
  }
  const snapshots: ModifierSelectionSnapshot[] = [];
  for (const group of resolvedGroups) {
    const selected = selectedOptionIds
      .filter((optionId) => selectedGroupByOption.get(optionId) === group)
      .map((optionId) =>
        group.options.find((option) => option.modifierOptionId === optionId),
      )
      .filter(
        (option): option is ModifierGroupRevision["options"][number] =>
          option !== undefined,
      );
    if (
      selected.length < group.minimumSelections ||
      selected.length > group.maximumSelections
    ) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "checkout.modifiers.cardinality",
        },
      };
    }
    for (const option of selected)
      snapshots.push({
        modifierGroupId: group.modifierGroupId,
        modifierGroupRevision: group.revision,
        modifierOptionId: option.modifierOptionId,
        name: option.name,
        priceDelta: option.priceDelta,
        requirementAdjustments: option.requirementAdjustments,
      });
  }
  if (snapshots.length !== selectedOptionIds.length) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "checkout.modifiers.option",
      },
    };
  }
  return { kind: "planned", value: snapshots };
}

function applyModifierRequirements(
  base: readonly InventoryRequirement[],
  adjustmentGroups: readonly (readonly Readonly<{
    kind: "add" | "reduce";
    inventoryItemId: string;
    quantity: Quantity;
  }>[])[],
): readonly InventoryRequirement[] | undefined {
  const quantities = new Map<string, Quantity>();
  for (const requirement of base)
    quantities.set(requirement.inventoryItemId, requirement.quantity);
  for (const adjustments of adjustmentGroups) {
    for (const adjustment of adjustments) {
      const current = quantities.get(adjustment.inventoryItemId);
      if (adjustment.kind === "add") {
        const next = addRequirementQuantity(current, adjustment.quantity);
        if (next === undefined) return undefined;
        quantities.set(adjustment.inventoryItemId, next);
      } else {
        if (
          current === undefined ||
          !quantityAtLeast(current, adjustment.quantity)
        )
          return undefined;
        const next = subtractQuantity(current, adjustment.quantity);
        if (next === undefined || next.amount === 0)
          quantities.delete(adjustment.inventoryItemId);
        else quantities.set(adjustment.inventoryItemId, next);
      }
    }
  }
  return [...quantities.entries()].map(([inventoryItemId, quantity]) => ({
    inventoryItemId,
    quantity,
  }));
}

function addModifierPrice(
  base: Readonly<{ amountMinor: number; currency: string }>,
  modifiers: readonly ModifierSelectionSnapshot[],
): Readonly<{ amountMinor: number; currency: string }> | undefined {
  let amount = base.amountMinor;
  for (const modifier of modifiers) {
    if (modifier.priceDelta.currency !== base.currency) return undefined;
    amount = safeAdd(amount, modifier.priceDelta.amountMinor) ?? -1;
    if (amount < 0) return undefined;
  }
  return { amountMinor: amount, currency: base.currency };
}

function addRequirementQuantity(
  current: Quantity | undefined,
  next: Quantity,
): Quantity | undefined {
  if (current === undefined) return next;
  if (current.unit !== next.unit) return undefined;
  const scale = Math.max(current.scale, next.scale);
  const amount = scaledAmount(current, scale) + scaledAmount(next, scale);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return { amount: Number(amount), scale, unit: current.unit };
}

function subtractQuantity(
  current: Quantity,
  next: Quantity,
): Quantity | undefined {
  if (current.unit !== next.unit) return undefined;
  const scale = Math.max(current.scale, next.scale);
  const amount = scaledAmount(current, scale) - scaledAmount(next, scale);
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return { amount: Number(amount), scale, unit: current.unit };
}

function quantityAtLeast(current: Quantity, next: Quantity): boolean {
  if (current.unit !== next.unit) return false;
  const scale = Math.max(current.scale, next.scale);
  return scaledAmount(current, scale) >= scaledAmount(next, scale);
}

function buyerMenus(
  menus: readonly Menu[],
  modifierGroups: readonly ModifierGroupRevision[],
  offers: readonly CommerceOfferV1[],
  variants: readonly CommerceResourcesV1["variants"][number][],
  products: readonly CommerceResourcesV1["products"][number][],
  salesChannelId: string,
  locationId: string,
  database: CommerceDatabase,
  merchantId: string,
  now: string,
): readonly CommerceBuyerMenuV1[] {
  const visible: CommerceBuyerMenuV1[] = [];
  const soldOut = variantsMarkedSoldOut(database, merchantId, locationId, now);
  for (const menu of menus) {
    if (
      menu.lifecycle.state !== "published" ||
      menu.salesChannelId !== salesChannelId ||
      !menuVisibleAtLocation(menu, locationId, now)
    )
      continue;
    const entries: CommerceBuyerMenuEntryV1[] = [];
    for (const entry of menu.entries) {
      if (entry.lifecycle !== "active") continue;
      const offer = offers.find(
        (candidate) =>
          candidate.id === entry.offerId &&
          candidate.salesChannelId === salesChannelId,
      );
      if (offer === undefined || offer.lifecycle.state !== "listed") continue;
      const variant = variants.find(
        (candidate) => candidate.id === offer.variantId,
      );
      if (variant === undefined || !variantIsSellable(products, variant))
        continue;
      const groups: CommerceBuyerModifierGroupV1[] = [];
      let groupsValid = true;
      for (const reference of entry.modifierGroupRevisions) {
        const group = modifierGroups.find(
          (candidate) =>
            candidate.modifierGroupId === reference.modifierGroupId &&
            candidate.revision === reference.revision,
        );
        if (group === undefined || group.lifecycle.state !== "active") {
          groupsValid = false;
          break;
        }
        groups.push({
          modifierGroupId: group.modifierGroupId,
          revision: group.revision,
          name: group.name,
          minimumSelections: group.minimumSelections,
          maximumSelections: group.maximumSelections,
          options: group.options.map((option) => ({
            modifierOptionId: option.modifierOptionId,
            name: option.name,
            priceDelta: option.priceDelta,
          })),
        });
      }
      if (!groupsValid) continue;
      const plan = readConsumptionPlan(
        database,
        merchantId,
        entry.consumptionPlanId,
      );
      if (
        plan === undefined ||
        plan.revision !== entry.consumptionPlanRevision ||
        plan.variantId !== variant.id ||
        plan.lifecycle !== "active" ||
        !consumptionPlanAppliesToLocation(plan, locationId) ||
        plan.mode.kind === "untracked" ||
        (plan.mode.kind === "direct" &&
          plan.mode.commitOn !== "fulfillment_completed")
      )
        continue;
      const available = menuEntryIsAvailable(
        database,
        merchantId,
        locationId,
        variant.id,
        offer.availability.state === "available" &&
          !soldOut.has(variant.id),
        plan,
        now,
      );
      entries.push({
        menuEntryId: entry.menuEntryId,
        sectionId: entry.sectionId,
        revision: entry.revision,
        variantId: variant.id,
        variantRevision: variant.revision,
        offerId: offer.id,
        offerRevision: offer.revision,
        price: offer.price,
        compareAtPrice: offer.compareAtPrice ?? null,
        availability: available ? "available" : "unavailable",
        consumptionPlanId: plan.consumptionPlanId,
        consumptionPlanRevision: plan.revision,
        modifierGroups: groups,
      });
    }
    if (entries.length === 0) continue;
    visible.push({
      menuId: menu.menuId,
      revision: menu.revision,
      name: menu.name,
      sections: menu.sections.map((section) => ({
        sectionId: section.sectionId,
        name: section.name,
        position: section.position,
      })),
      entries,
    });
  }
  return visible;
}

function menuVisibleAtLocation(
  menu: Menu,
  locationId: string,
  now: string,
): boolean {
  if (menu.scope.kind === "location" && menu.scope.locationId !== locationId)
    return false;
  if (
    menu.scope.kind === "location_group" &&
    !menu.scope.locationIds.includes(locationId)
  )
    return false;
  if (menu.validity.kind === "window") {
    const nowMilliseconds = Date.parse(now);
    return (
      nowMilliseconds >= Date.parse(menu.validity.startsAt) &&
      nowMilliseconds < Date.parse(menu.validity.endsAt)
    );
  }
  if (menu.validity.kind === "schedule")
    return menuScheduleIsOpen(menu.validity, Date.parse(now));
  return true;
}

function menuEntryIsAvailable(
  database: CommerceDatabase,
  merchantId: string,
  locationId: string,
  variantId: string,
  offerAvailable: boolean,
  plan: NonNullable<ReturnType<typeof readConsumptionPlan>>,
  now: string,
): boolean {
  if (!offerAvailable) return false;
  let requirements: readonly InventoryRequirement[] | undefined;
  if (plan.mode.kind === "direct") {
    if (plan.mode.commitOn !== "fulfillment_completed") return false;
    requirements = plan.mode.components;
  } else if (plan.mode.kind === "prepared") {
    requirements = consumptionRequirementsForPlan(plan, database, merchantId);
  }
  if (requirements === undefined) return false;
  for (const requirement of requirements) {
    const position = readInventoryPositionForItemLocation(
      database,
      merchantId,
      requirement.inventoryItemId,
      locationId,
    );
    if (
      position === undefined ||
      position.balance.kind !== "accounted" ||
      !availableBalanceSatisfies(
        readUsableInventoryQuantity(database, merchantId, position, now),
        requirement.quantity,
      )
    ) {
      return false;
    }
  }
  return true;
}
