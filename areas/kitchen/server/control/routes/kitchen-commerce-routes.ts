import { organisationPath } from "@purin-labs/control/worker/path-match";
import type { Env } from "@purin-labs/kernel/env";
import { assertNever } from "@purin-labs/std";
import { handleBakeryControl, type BakeryAction } from "./bakery";
import { handleCosts } from "./costs";
import { handleInventoryProduction } from "./inventory-production";
import {
  handleInventoryDeliveries,
  handleInventoryReceipt,
} from "./inventory-receipts";
import {
  handlePurchasingControlRoute,
  type PurchasingControlAction,
} from "./purchasing";
import { handleRecipes } from "./recipes";

/**
 * The Kitchen routes under `commerce/`: the bakery sample and scenarios,
 * purchasing, recipes, costs and the stock that the Kitchen receives.
 */
export type KitchenCommerceRoute =
  | Readonly<{
      kind: "commercePurchasing";
      organisationIdRaw: string;
      action: PurchasingControlAction;
    }>
  | Readonly<{
      kind: "commerceBakery";
      organisationIdRaw: string;
      action: BakeryAction;
    }>
  | Readonly<{ kind: "recipes"; organisationIdRaw: string }>
  | Readonly<{ kind: "costs"; organisationIdRaw: string }>
  | Readonly<{ kind: "inventoryProduction"; organisationIdRaw: string }>
  | Readonly<{
      kind: "inventoryReceipt";
      organisationIdRaw: string;
      operation: "receipt" | "reconciliation";
    }>
  | Readonly<{ kind: "inventoryDeliveries"; organisationIdRaw: string }>;

export function matchKitchenCommerceRoute(
  pathname: string,
): KitchenCommerceRoute | null {
  const bakerySample = organisationPath(pathname, "commerce/bakery/sample");
  if (bakerySample !== null)
    return {
      kind: "commerceBakery",
      organisationIdRaw: bakerySample,
      action: "sample",
    };
  const bakeryOperation = organisationPath(
    pathname,
    "commerce/bakery/operation",
  );
  if (bakeryOperation !== null)
    return {
      kind: "commerceBakery",
      organisationIdRaw: bakeryOperation,
      action: "operation",
    };
  const bakeryScenario = organisationPath(pathname, "commerce/bakery/scenario");
  const bakeryProductionScenario = organisationPath(
    pathname,
    "commerce/bakery/production-scenario",
  );
  if (bakeryProductionScenario !== null)
    return {
      kind: "commerceBakery",
      organisationIdRaw: bakeryProductionScenario,
      action: "production-scenario",
    };
  if (bakeryScenario !== null)
    return {
      kind: "commerceBakery",
      organisationIdRaw: bakeryScenario,
      action: "scenario",
    };
  const purchasingActivation = organisationPath(
    pathname,
    "commerce/purchasing/activate",
  );
  if (purchasingActivation !== null)
    return {
      kind: "commercePurchasing",
      organisationIdRaw: purchasingActivation,
      action: "activate",
    };
  const purchasingReconciliation = organisationPath(
    pathname,
    "commerce/purchasing/reconcile",
  );
  if (purchasingReconciliation !== null)
    return {
      kind: "commercePurchasing",
      organisationIdRaw: purchasingReconciliation,
      action: "reconcile",
    };
  const supplierCreation = organisationPath(pathname, "commerce/suppliers");
  if (supplierCreation !== null)
    return {
      kind: "commercePurchasing",
      organisationIdRaw: supplierCreation,
      action: "create_supplier",
    };
  const recipes = organisationPath(pathname, "commerce/recipes");
  if (recipes !== null) return { kind: "recipes", organisationIdRaw: recipes };
  const costs = organisationPath(pathname, "commerce/costs");
  if (costs !== null) return { kind: "costs", organisationIdRaw: costs };
  const production = organisationPath(
    pathname,
    "commerce/inventory/production-requests",
  );
  if (production !== null)
    return { kind: "inventoryProduction", organisationIdRaw: production };
  const inventoryReceipt = organisationPath(
    pathname,
    "commerce/inventory/receipts",
  );
  if (inventoryReceipt !== null)
    return {
      kind: "inventoryReceipt",
      organisationIdRaw: inventoryReceipt,
      operation: "receipt",
    };
  const reconciliation = organisationPath(
    pathname,
    "commerce/inventory/reconciliations",
  );
  if (reconciliation !== null)
    return {
      kind: "inventoryReceipt",
      organisationIdRaw: reconciliation,
      operation: "reconciliation",
    };
  const deliveries = organisationPath(
    pathname,
    "commerce/inventory/deliveries",
  );
  return deliveries === null
    ? null
    : { kind: "inventoryDeliveries", organisationIdRaw: deliveries };
}

export function handleKitchenCommerceRoute(
  request: Request,
  env: Env,
  route: KitchenCommerceRoute,
): Promise<Response> {
  switch (route.kind) {
    case "commercePurchasing":
      return handlePurchasingControlRoute(
        request,
        env,
        route.organisationIdRaw,
        route.action,
      );
    case "commerceBakery":
      return handleBakeryControl(
        request,
        env,
        route.organisationIdRaw,
        route.action,
      );
    case "recipes":
      return handleRecipes(request, env, route.organisationIdRaw);
    case "costs":
      return handleCosts(request, env, route.organisationIdRaw);
    case "inventoryDeliveries":
      return handleInventoryDeliveries(request, env, route.organisationIdRaw);
    case "inventoryProduction":
      return handleInventoryProduction(request, env, route.organisationIdRaw);
    case "inventoryReceipt":
      return handleInventoryReceipt(
        request,
        env,
        route.organisationIdRaw,
        route.operation,
      );
    default:
      return assertNever(route);
  }
}
