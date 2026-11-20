import { handleRecipes } from "./recipes";
import { handleCosts } from "./costs";
import type { Env } from "../../env";
import { handleInventoryProduction } from "./inventory-production";
import {
  handleInventoryDeliveries,
  handleInventoryReceipt,
} from "./inventory-receipts";
import {
  handleProductCatalogAction,
  type ProductCatalogAction,
} from "./product-catalog";
import {
  handleLibraryImageContent,
  handleProductPhotoAction,
  type ProductPhotoAction,
} from "./product-photos";
import {
  handlePurchasingControlRoute,
  type PurchasingControlAction,
} from "./purchasing";
import {
  handleBakeryControl,
  type BakeryAction,
} from "./bakery";
import {
  handleCheckoutProfileControlRoute,
  matchCheckoutProfileControlRoute,
  type CheckoutProfileControlRoute,
} from "./checkout-profiles";
import {
  handleTerminalOperationsControlRoute,
  matchTerminalOperationsControlRoute,
  type TerminalOperationsControlRoute,
} from "./terminal-operations";
import {
  handleCounterPolicyControlRoute,
  matchCounterPolicyControlRoute,
  type CounterPolicyControlRoute,
} from "./counter-policy";
import {
  handleCommerceApiKeyControlRoute,
  matchCommerceApiKeyControlRoute,
  type CommerceApiKeyControlRoute,
} from "./commerce-api-keys";
import {
  handleCommercePaymentAccountControlRoute,
  matchCommercePaymentAccountControlRoute,
  type CommercePaymentAccountControlRoute,
} from "./commerce-payment-accounts";
import {
  handleCommerceMenuPublicationControlRoute,
  matchCommerceMenuPublicationControlRoute,
  type CommerceMenuPublicationControlRoute,
} from "./commerce-menu-publication";
import {
  handleCounterSaleControlRoute,
  matchCounterSaleControlRoute,
  type CounterSaleControlRoute,
} from "./counter-sale";
import {
  handleFailedPaymentsControlRoute,
  matchFailedPaymentsControlRoute,
  type FailedPaymentsControlRoute,
} from "./failed-payments";
import {
  handleCommercePaymentsControlRoute,
  matchCommercePaymentsControlRoute,
  type CommercePaymentsControlRoute,
} from "./payments";
import {
  handleBankPayoutsControlRoute,
  matchBankPayoutsControlRoute,
  type BankPayoutsControlRoute,
} from "./bank-payouts";
import {
  handleOrderTimesControlRoute,
  matchOrderTimesControlRoute,
  type OrderTimesControlRoute,
} from "./order-times";
import {
  handleOrderQueueControlRoute,
  matchOrderQueueControlRoute,
  type OrderQueueControlRoute,
} from "./order-queue";
import {
  handleSoldOutControlRoute,
  matchSoldOutControlRoute,
  type SoldOutControlRoute,
} from "./sold-out";
import {
  handleSupplierPayoutControlRoute,
  matchSupplierPayoutControlRoute,
  type SupplierPayoutControlRoute,
} from "./supplier-payouts";
import { assertNever } from "@purin-labs/std";
import {
  handleCommerceActionApproval,
  handleCommerceActionExecution,
  handleCommerceActionPluginPreview,
  handleCommerceActionRejection,
  handleCommerceActions,
} from "./commerce/actions";
import {
  handleCommerceCueRefresh,
  handleCommerceInventory,
  handleCommerceOfferPricePolicy,
  handleCommercePricedOffers,
  handleCommercePublishedResources,
  handleCommerceTrackingBatchPreview,
} from "./commerce/catalog";
import {
  handleCommerceBoardPresence,
  handleCommerceExportPreset,
  handleCommerceGraph,
  handleCommerceGraphActivity,
  handleCommerceGraphChanges,
  handleCommerceListEntryPatch,
  handleCommerceSavedViewPresentationPatch,
} from "./commerce/graph";
import {
  handleCommerceCapabilities,
  handleCommerceSystem,
  handleCommerceSystemSync,
  handlePantryCommerceDemo,
} from "./commerce/system";

export type CommerceControlRoute =
  | CheckoutProfileControlRoute
  | TerminalOperationsControlRoute
  | CounterPolicyControlRoute
  | CommerceApiKeyControlRoute
  | CommercePaymentAccountControlRoute
  | CommerceMenuPublicationControlRoute
  | CounterSaleControlRoute
  | FailedPaymentsControlRoute
  | CommercePaymentsControlRoute
  | BankPayoutsControlRoute
  | OrderTimesControlRoute
  | OrderQueueControlRoute
  | SoldOutControlRoute
  | SupplierPayoutControlRoute
  | Readonly<{ kind: "commerceSystem"; organisationIdRaw: string }>
  | Readonly<{
      kind: "commerceCapabilities";
      organisationIdRaw: string;
      activationIdRaw: string | null;
      action: "activate" | "inactivate" | null;
    }>
  | Readonly<{ kind: "commerceSystemSync"; organisationIdRaw: string }>
  | Readonly<{ kind: "satyrCommerceDemo"; organisationIdRaw: string }>
  | Readonly<{ kind: "commerceCueRefresh"; organisationIdRaw: string }>
  | Readonly<{ kind: "commercePublishedResources"; organisationIdRaw: string }>
  | Readonly<{ kind: "commerceExportPreset"; organisationIdRaw: string }>
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
  | Readonly<{ kind: "commerceGraph"; organisationIdRaw: string }>
  | Readonly<{ kind: "commerceGraphChanges"; organisationIdRaw: string }>
  | Readonly<{ kind: "commerceGraphActivity"; organisationIdRaw: string }>
  | Readonly<{
      kind: "commerceListEntryPatch";
      organisationIdRaw: string;
      entryIdRaw: string;
    }>
  | Readonly<{
      kind: "commerceSavedViewPresentationPatch";
      organisationIdRaw: string;
      viewIdRaw: string;
    }>
  | Readonly<{ kind: "commerceBoardPresence"; organisationIdRaw: string }>
  | Readonly<{ kind: "commerceTrackingBatchPreview"; organisationIdRaw: string }>
  | Readonly<{
      kind: "commerceOfferPricePolicy";
      organisationIdRaw: string;
      offerIdRaw: string;
    }>
  | Readonly<{ kind: "commercePricedOffers"; organisationIdRaw: string }>
  | Readonly<{ kind: "recipes"; organisationIdRaw: string }>
  | Readonly<{ kind: "costs"; organisationIdRaw: string }>
  | Readonly<{ kind: "inventoryStockBalances"; organisationIdRaw: string }>
  | Readonly<{ kind: "inventoryProduction"; organisationIdRaw: string }>
  | Readonly<{
      kind: "inventoryReceipt";
      organisationIdRaw: string;
      operation: "receipt" | "reconciliation";
    }>
  | Readonly<{ kind: "inventoryDeliveries"; organisationIdRaw: string }>
  | Readonly<{
      kind: "productCatalog";
      organisationIdRaw: string;
      action: ProductCatalogAction;
    }>
  | Readonly<{
      kind: "productPhotos";
      organisationIdRaw: string;
      action: ProductPhotoAction;
    }>
  | Readonly<{
      kind: "libraryImage";
      organisationIdRaw: string;
      mediaId: string;
    }>
  | Readonly<{
      kind: "commerceActions";
      organisationIdRaw: string;
      actionNonceRaw: string | null;
    }>
  | Readonly<{
      kind: "commerceActionApproval";
      organisationIdRaw: string;
      actionNonceRaw: string;
    }>
  | Readonly<{
      kind: "commerceActionRejection";
      organisationIdRaw: string;
      actionNonceRaw: string;
    }>
  | Readonly<{
      kind: "commerceActionExecution";
      organisationIdRaw: string;
      actionNonceRaw: string;
    }>
  | Readonly<{
      kind: "commerceActionPluginPreview";
      organisationIdRaw: string;
      actionNonceRaw: string;
    }>;

export function matchCommerceControlRoute(
  pathname: string,
): CommerceControlRoute | null {
  const bakerySample = organisation(pathname, "commerce/bakery/sample");
  if (bakerySample !== null)
    return {
      kind: "commerceBakery",
      organisationIdRaw: bakerySample,
      action: "sample",
    };
  const bakeryOperation = organisation(pathname, "commerce/bakery/operation");
  if (bakeryOperation !== null)
    return {
      kind: "commerceBakery",
      organisationIdRaw: bakeryOperation,
      action: "operation",
    };
  const bakeryScenario = organisation(pathname, "commerce/bakery/scenario");
  const bakeryProductionScenario = organisation(
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
  const checkoutProfileRoute = matchCheckoutProfileControlRoute(pathname);
  if (checkoutProfileRoute !== null) return checkoutProfileRoute;
  const terminalOperationsRoute = matchTerminalOperationsControlRoute(pathname);
  if (terminalOperationsRoute !== null) return terminalOperationsRoute;
  const counterPolicyRoute = matchCounterPolicyControlRoute(pathname);
  if (counterPolicyRoute !== null) return counterPolicyRoute;
  const apiKeyRoute = matchCommerceApiKeyControlRoute(pathname);
  if (apiKeyRoute !== null) return apiKeyRoute;
  const paymentAccountRoute = matchCommercePaymentAccountControlRoute(pathname);
  if (paymentAccountRoute !== null) return paymentAccountRoute;
  const menuPublicationRoute = matchCommerceMenuPublicationControlRoute(pathname);
  if (menuPublicationRoute !== null) return menuPublicationRoute;
  const counterSaleRoute = matchCounterSaleControlRoute(pathname);
  if (counterSaleRoute !== null) return counterSaleRoute;
  const failedPaymentsRoute = matchFailedPaymentsControlRoute(pathname);
  if (failedPaymentsRoute !== null) return failedPaymentsRoute;
  const commercePaymentsRoute = matchCommercePaymentsControlRoute(pathname);
  if (commercePaymentsRoute !== null) return commercePaymentsRoute;
  const bankPayoutsRoute = matchBankPayoutsControlRoute(pathname);
  if (bankPayoutsRoute !== null) return bankPayoutsRoute;
  const orderTimesRoute = matchOrderTimesControlRoute(pathname);
  if (orderTimesRoute !== null) return orderTimesRoute;
  const orderQueueRoute = matchOrderQueueControlRoute(pathname);
  if (orderQueueRoute !== null) return orderQueueRoute;
  const soldOutRoute = matchSoldOutControlRoute(pathname);
  if (soldOutRoute !== null) return soldOutRoute;
  const supplierPayoutRoute = matchSupplierPayoutControlRoute(pathname);
  if (supplierPayoutRoute !== null) return supplierPayoutRoute;
  const capabilityAction = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce-capabilities\/([^/]+)\/(activate|inactivate)$/u,
  );
  if (capabilityAction !== null) {
    return {
      kind: "commerceCapabilities",
      organisationIdRaw: decode(capabilityAction[0]),
      activationIdRaw: decode(capabilityAction[1]),
      action: capabilityAction[2] === "activate" ? "activate" : "inactivate",
    };
  }
  const capability = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce-capabilities\/([^/]+)$/u,
  );
  if (capability !== null) {
    return {
      kind: "commerceCapabilities",
      organisationIdRaw: decode(capability[0]),
      activationIdRaw: decode(capability[1]),
      action: null,
    };
  }
  const capabilities = organisation(pathname, "commerce-capabilities");
  if (capabilities !== null) {
    return {
      kind: "commerceCapabilities",
      organisationIdRaw: capabilities,
      activationIdRaw: null,
      action: null,
    };
  }
  const demo = organisation(pathname, "commerce-system/satyr-commerce/demo");
  if (demo !== null) return { kind: "satyrCommerceDemo", organisationIdRaw: demo };
  const sync = organisation(pathname, "commerce-system/sync");
  if (sync !== null) return { kind: "commerceSystemSync", organisationIdRaw: sync };
  const system = organisation(pathname, "commerce-system");
  if (system !== null) return { kind: "commerceSystem", organisationIdRaw: system };
  const cueRefresh = organisation(pathname, "cues/commerce/refresh");
  if (cueRefresh !== null)
    return { kind: "commerceCueRefresh", organisationIdRaw: cueRefresh };
  const publishedResources = organisation(pathname, "commerce/published-resources");
  if (publishedResources !== null)
    return {
      kind: "commercePublishedResources",
      organisationIdRaw: publishedResources,
    };
  const listEntry = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/list-entries\/([^/]+)\/patch$/u,
  );
  if (listEntry !== null) {
    return {
      kind: "commerceListEntryPatch",
      organisationIdRaw: decode(listEntry[0]),
      entryIdRaw: decode(listEntry[1]),
    };
  }
  const savedView = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/saved-views\/([^/]+)\/presentation$/u,
  );
  if (savedView !== null) {
    return {
      kind: "commerceSavedViewPresentationPatch",
      organisationIdRaw: decode(savedView[0]),
      viewIdRaw: decode(savedView[1]),
    };
  }
  const presence = organisation(pathname, "commerce/board-presence");
  if (presence !== null)
    return { kind: "commerceBoardPresence", organisationIdRaw: presence };
  const exportPreset = organisation(pathname, "commerce/export-preset");
  if (exportPreset !== null)
    return { kind: "commerceExportPreset", organisationIdRaw: exportPreset };
  const purchasingActivation = organisation(pathname, "commerce/purchasing/activate");
  if (purchasingActivation !== null)
    return {
      kind: "commercePurchasing",
      organisationIdRaw: purchasingActivation,
      action: "activate",
    };
  const purchasingReconciliation = organisation(
    pathname,
    "commerce/purchasing/reconcile",
  );
  if (purchasingReconciliation !== null)
    return {
      kind: "commercePurchasing",
      organisationIdRaw: purchasingReconciliation,
      action: "reconcile",
    };
  const supplierCreation = organisation(pathname, "commerce/suppliers");
  if (supplierCreation !== null)
    return {
      kind: "commercePurchasing",
      organisationIdRaw: supplierCreation,
      action: "create_supplier",
    };
  const graphChanges = organisation(pathname, "commerce/graph/changes");
  if (graphChanges !== null)
    return { kind: "commerceGraphChanges", organisationIdRaw: graphChanges };
  const graphActivity = organisation(pathname, "commerce/graph/activity");
  if (graphActivity !== null)
    return { kind: "commerceGraphActivity", organisationIdRaw: graphActivity };
  const graph = organisation(pathname, "commerce/graph");
  if (graph !== null) return { kind: "commerceGraph", organisationIdRaw: graph };
  const trackingBatchPreview = organisation(
    pathname,
    "commerce/operations/tracking-batches/preview",
  );
  if (trackingBatchPreview !== null)
    return {
      kind: "commerceTrackingBatchPreview",
      organisationIdRaw: trackingBatchPreview,
    };
  const recipes = organisation(pathname, "commerce/recipes");
  if (recipes !== null) return { kind: "recipes", organisationIdRaw: recipes };
  const costs = organisation(pathname, "commerce/costs");
  if (costs !== null) return { kind: "costs", organisationIdRaw: costs };
  const production = organisation(pathname, "commerce/inventory/production-requests");
  if (production !== null)
    return { kind: "inventoryProduction", organisationIdRaw: production };
  for (const action of ["edit", "status", "delete"] as const) {
    const productCatalog = organisation(pathname, `commerce/products/${action}`);
    if (productCatalog !== null)
      return {
        kind: "productCatalog",
        organisationIdRaw: productCatalog,
        action,
      };
  }
  const libraryImage = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/media\/content\/(media_[0-9a-f]{32})$/u,
  );
  if (libraryImage !== null)
    return {
      kind: "libraryImage",
      organisationIdRaw: decode(libraryImage[0]),
      mediaId: libraryImage[1] ?? "",
    };
  const library = organisation(pathname, "commerce/media");
  if (library !== null)
    return { kind: "productPhotos", organisationIdRaw: library, action: "library" };
  const libraryDelete = organisation(pathname, "commerce/media/delete");
  if (libraryDelete !== null)
    return {
      kind: "productPhotos",
      organisationIdRaw: libraryDelete,
      action: "library_delete",
    };
  const libraryAdd = organisation(pathname, "commerce/media/add");
  if (libraryAdd !== null)
    return {
      kind: "productPhotos",
      organisationIdRaw: libraryAdd,
      action: "library_add",
    };
  for (const action of ["add", "arrange"] as const) {
    const productPhotos = organisation(
      pathname,
      `commerce/products/photos/${action}`,
    );
    if (productPhotos !== null)
      return {
        kind: "productPhotos",
        organisationIdRaw: productPhotos,
        action,
      };
  }
  const inventoryReceipt = organisation(pathname, "commerce/inventory/receipts");
  if (inventoryReceipt !== null)
    return {
      kind: "inventoryReceipt",
      organisationIdRaw: inventoryReceipt,
      operation: "receipt",
    };
  const reconciliation = organisation(pathname, "commerce/inventory/reconciliations");
  if (reconciliation !== null)
    return {
      kind: "inventoryReceipt",
      organisationIdRaw: reconciliation,
      operation: "reconciliation",
    };
  const deliveries = organisation(pathname, "commerce/inventory/deliveries");
  if (deliveries !== null)
    return { kind: "inventoryDeliveries", organisationIdRaw: deliveries };
  const inventory = organisation(pathname, "commerce/inventory");
  if (inventory !== null)
    return { kind: "inventoryStockBalances", organisationIdRaw: inventory };
  const pricedOffers = organisation(pathname, "commerce/priced-offers");
  if (pricedOffers !== null)
    return { kind: "commercePricedOffers", organisationIdRaw: pricedOffers };
  const pricePolicy = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/offers\/([^/]+)\/price-policy$/u,
  );
  if (pricePolicy !== null) {
    return {
      kind: "commerceOfferPricePolicy",
      organisationIdRaw: decode(pricePolicy[0]),
      offerIdRaw: decode(pricePolicy[1]),
    };
  }
  const approval = commerceAction(pathname, "approval");
  if (approval !== null) return { kind: "commerceActionApproval", ...approval };
  const rejection = commerceAction(pathname, "rejection");
  if (rejection !== null)
    return { kind: "commerceActionRejection", ...rejection };
  const execution = commerceAction(pathname, "execute");
  if (execution !== null)
    return { kind: "commerceActionExecution", ...execution };
  const pluginPreview = commerceAction(pathname, "plugin-preview");
  if (pluginPreview !== null)
    return { kind: "commerceActionPluginPreview", ...pluginPreview };
  const action = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/actions\/([^/]+)$/u,
  );
  if (action !== null) {
    return {
      kind: "commerceActions",
      organisationIdRaw: decode(action[0]),
      actionNonceRaw: decode(action[1]),
    };
  }
  const actions = organisation(pathname, "commerce/actions");
  return actions === null
    ? null
    : { kind: "commerceActions", organisationIdRaw: actions, actionNonceRaw: null };
}

function organisation(pathname: string, suffix: string): string | null {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const captures = match(
    pathname,
    new RegExp(`^/v1/control/organisations/([^/]+)/${escapedSuffix}$`, "u"),
  );
  return captures === null ? null : decode(captures[0]);
}

function commerceAction(
  pathname: string,
  suffix: "approval" | "rejection" | "execute" | "plugin-preview",
): Readonly<{ organisationIdRaw: string; actionNonceRaw: string }> | null {
  const captures = match(
    pathname,
    new RegExp(
      `^/v1/control/organisations/([^/]+)/commerce/actions/([^/]+)/${suffix}$`,
      "u",
    ),
  );
  return captures === null
    ? null
    : { organisationIdRaw: decode(captures[0]), actionNonceRaw: decode(captures[1]) };
}

function match(pathname: string, pattern: RegExp): readonly string[] | null {
  const result = pattern.exec(pathname);
  return result === null ? null : result.slice(1);
}

function decode(value: string | undefined): string {
  if (value === undefined) throw new Error("Control route capture is missing");
  return decodeURIComponent(value);
}

export function handleCommerceControlRoute(
  request: Request,
  env: Env,
  route: CommerceControlRoute,
): Promise<Response> {
  switch (route.kind) {
    case "checkoutProfiles":
    case "checkoutProfileRevision":
    case "checkoutProfileDraft":
    case "checkoutProfilePublication":
    case "checkoutProfileRetirement":
    case "checkoutProfileActivation":
      return handleCheckoutProfileControlRoute(request, env, route);
    case "terminalOperations":
    case "terminalRetirement":
      return handleTerminalOperationsControlRoute(request, env, route);
    case "counterPolicies":
    case "counterPolicy":
      return handleCounterPolicyControlRoute(request, env, route);
    case "commerceApiKeys":
    case "commerceApiKeyRevocation":
      return handleCommerceApiKeyControlRoute(request, env, route);
    case "commercePaymentAccounts":
    case "commerceStripeOnboarding":
      return handleCommercePaymentAccountControlRoute(request, env, route);
    case "commerceMenuPublication":
    case "commerceShopName":
      return handleCommerceMenuPublicationControlRoute(request, env, route);
    case "counterRegister":
    case "counterSales":
    case "counterSale":
    case "counterSaleCash":
    case "counterSaleCollection":
    case "counterSaleCancel":
    case "counterSaleReconciliation":
    case "counterSalePickupReady":
    case "counterSaleHandover":
    case "counterSaleRefund":
    case "counterSaleManualCashRefund":
    case "counterReceipt":
      return handleCounterSaleControlRoute(request, env, route);
    case "failedPayments":
      return handleFailedPaymentsControlRoute(request, env, route);
    case "commercePayments":
      return handleCommercePaymentsControlRoute(request, env, route);
    case "bankPayouts":
      return handleBankPayoutsControlRoute(request, env, route);
    case "orderTimes":
      return handleOrderTimesControlRoute(request, env, route);
    case "orderQueue":
    case "orderQueueAdvance":
      return handleOrderQueueControlRoute(request, env, route);
    case "soldOutItems":
    case "soldOutItem":
      return handleSoldOutControlRoute(request, env, route);
    case "terminalPairings":
    case "terminalPairing":
    case "terminalPairingActivation":
      return handleTerminalOperationsControlRoute(request, env, route);
    case "supplierPayouts":
    case "supplierPayout":
    case "supplierPayoutAudit":
    case "supplierDestinations":
    case "supplierDestinationActivation":
      return handleSupplierPayoutControlRoute(
        request,
        env,
        route,
        new URL(request.url),
      );
    case "commerceSystem":
      return handleCommerceSystem(request, env, route.organisationIdRaw);
    case "commerceCapabilities":
      return handleCommerceCapabilities(
        request,
        env,
        route.organisationIdRaw,
        route.activationIdRaw,
        route.action,
      );
    case "commerceSystemSync":
      return handleCommerceSystemSync(request, env, route.organisationIdRaw);
    case "satyrCommerceDemo":
      return handlePantryCommerceDemo(request, env, route.organisationIdRaw);
    case "commerceCueRefresh":
      return handleCommerceCueRefresh(request, env, route.organisationIdRaw);
    case "commercePublishedResources":
      return handleCommercePublishedResources(request, env, route.organisationIdRaw);
    case "commerceExportPreset":
      return handleCommerceExportPreset(request, env, route.organisationIdRaw);
    case "commercePurchasing":
      return handlePurchasingControlRoute(
        request,
        env,
        route.organisationIdRaw,
        route.action,
      );
    case "commerceBakery":
      return handleBakeryControl(request, env, route.organisationIdRaw, route.action);
    case "commerceGraph":
      return handleCommerceGraph(request, env, route.organisationIdRaw);
    case "commerceGraphChanges":
      return handleCommerceGraphChanges(request, env, route.organisationIdRaw);
    case "commerceGraphActivity":
      return handleCommerceGraphActivity(request, env, route.organisationIdRaw);
    case "commerceListEntryPatch":
      return handleCommerceListEntryPatch(
        request,
        env,
        route.organisationIdRaw,
        route.entryIdRaw,
      );
    case "commerceSavedViewPresentationPatch":
      return handleCommerceSavedViewPresentationPatch(
        request,
        env,
        route.organisationIdRaw,
        route.viewIdRaw,
      );
    case "commerceBoardPresence":
      return handleCommerceBoardPresence(request, env, route.organisationIdRaw);
    case "commerceTrackingBatchPreview":
      return handleCommerceTrackingBatchPreview(
        request,
        env,
        route.organisationIdRaw,
      );
    case "commerceOfferPricePolicy":
      return handleCommerceOfferPricePolicy(
        request,
        env,
        route.organisationIdRaw,
        route.offerIdRaw,
      );
    case "commercePricedOffers":
      return handleCommercePricedOffers(request, env, route.organisationIdRaw);
    case "recipes":
      return handleRecipes(request, env, route.organisationIdRaw);
    case "costs":
      return handleCosts(request, env, route.organisationIdRaw);
    case "inventoryDeliveries":
      return handleInventoryDeliveries(request, env, route.organisationIdRaw);
    case "inventoryStockBalances":
      return handleCommerceInventory(request, env, route.organisationIdRaw);
    case "inventoryProduction":
      return handleInventoryProduction(request, env, route.organisationIdRaw);
    case "inventoryReceipt":
      return handleInventoryReceipt(
        request,
        env,
        route.organisationIdRaw,
        route.operation,
      );
    case "productCatalog":
      return handleProductCatalogAction(
        request,
        env,
        route.organisationIdRaw,
        route.action,
      );
    case "libraryImage":
      return handleLibraryImageContent(
        request,
        env,
        route.organisationIdRaw,
        route.mediaId,
      );
    case "productPhotos":
      return handleProductPhotoAction(
        request,
        env,
        route.organisationIdRaw,
        route.action,
      );
    case "commerceActions":
      return handleCommerceActions(
        request,
        env,
        route.organisationIdRaw,
        route.actionNonceRaw,
      );
    case "commerceActionApproval":
      return handleCommerceActionApproval(
        request,
        env,
        route.organisationIdRaw,
        route.actionNonceRaw,
      );
    case "commerceActionRejection":
      return handleCommerceActionRejection(
        request,
        env,
        route.organisationIdRaw,
        route.actionNonceRaw,
      );
    case "commerceActionExecution":
      return handleCommerceActionExecution(
        request,
        env,
        route.organisationIdRaw,
        route.actionNonceRaw,
      );
    case "commerceActionPluginPreview":
      return handleCommerceActionPluginPreview(
        request,
        env,
        route.organisationIdRaw,
        route.actionNonceRaw,
      );
    default:
      return assertNever(route);
  }
}
