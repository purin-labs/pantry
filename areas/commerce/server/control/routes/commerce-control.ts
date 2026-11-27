import type { DecidePendingDecision } from "@purin-labs/control/worker/decide-pending-decision";
import {
  decodeCapture,
  organisationPath,
  pathCaptures,
} from "@purin-labs/control/worker/path-match";
import type { Env } from "@purin-labs/kernel/env";
import { assertNever } from "@purin-labs/std";
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
  handleCommerceActionExecution,
  handleCommerceActionPluginPreview,
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

/**
 * The Commerce routes of the commerce system, its capabilities, the graph,
 * the catalog, the media library, the stock balances, the offers and the
 * governed actions.
 */
export type CommerceControlRoute =
  | Readonly<{ kind: "commerceSystem"; organisationIdRaw: string }>
  | Readonly<{
      kind: "commerceCapabilities";
      organisationIdRaw: string;
      activationIdRaw: string | null;
      action: "activate" | "inactivate" | null;
    }>
  | Readonly<{ kind: "commerceSystemSync"; organisationIdRaw: string }>
  | Readonly<{ kind: "builtInCommerceDemo"; organisationIdRaw: string }>
  | Readonly<{ kind: "commerceCueRefresh"; organisationIdRaw: string }>
  | Readonly<{ kind: "commercePublishedResources"; organisationIdRaw: string }>
  | Readonly<{ kind: "commerceExportPreset"; organisationIdRaw: string }>
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
  | Readonly<{
      kind: "commerceTrackingBatchPreview";
      organisationIdRaw: string;
    }>
  | Readonly<{
      kind: "commerceOfferPricePolicy";
      organisationIdRaw: string;
      offerIdRaw: string;
    }>
  | Readonly<{ kind: "commercePricedOffers"; organisationIdRaw: string }>
  | Readonly<{ kind: "inventoryStockBalances"; organisationIdRaw: string }>
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
  const capabilityAction = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce-capabilities\/([^/]+)\/(activate|inactivate)$/u,
  );
  if (capabilityAction !== null) {
    return {
      kind: "commerceCapabilities",
      organisationIdRaw: decodeCapture(capabilityAction[0]),
      activationIdRaw: decodeCapture(capabilityAction[1]),
      action: capabilityAction[2] === "activate" ? "activate" : "inactivate",
    };
  }
  const capability = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce-capabilities\/([^/]+)$/u,
  );
  if (capability !== null) {
    return {
      kind: "commerceCapabilities",
      organisationIdRaw: decodeCapture(capability[0]),
      activationIdRaw: decodeCapture(capability[1]),
      action: null,
    };
  }
  const capabilities = organisationPath(pathname, "commerce-capabilities");
  if (capabilities !== null) {
    return {
      kind: "commerceCapabilities",
      organisationIdRaw: capabilities,
      activationIdRaw: null,
      action: null,
    };
  }
  const demo = organisationPath(
    pathname,
    "commerce-system/builtin-commerce/demo",
  );
  if (demo !== null)
    return { kind: "builtInCommerceDemo", organisationIdRaw: demo };
  const sync = organisationPath(pathname, "commerce-system/sync");
  if (sync !== null)
    return { kind: "commerceSystemSync", organisationIdRaw: sync };
  const system = organisationPath(pathname, "commerce-system");
  if (system !== null)
    return { kind: "commerceSystem", organisationIdRaw: system };
  const cueRefresh = organisationPath(pathname, "cues/commerce/refresh");
  if (cueRefresh !== null)
    return { kind: "commerceCueRefresh", organisationIdRaw: cueRefresh };
  const publishedResources = organisationPath(
    pathname,
    "commerce/published-resources",
  );
  if (publishedResources !== null)
    return {
      kind: "commercePublishedResources",
      organisationIdRaw: publishedResources,
    };
  const listEntry = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/list-entries\/([^/]+)\/patch$/u,
  );
  if (listEntry !== null) {
    return {
      kind: "commerceListEntryPatch",
      organisationIdRaw: decodeCapture(listEntry[0]),
      entryIdRaw: decodeCapture(listEntry[1]),
    };
  }
  const savedView = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/saved-views\/([^/]+)\/presentation$/u,
  );
  if (savedView !== null) {
    return {
      kind: "commerceSavedViewPresentationPatch",
      organisationIdRaw: decodeCapture(savedView[0]),
      viewIdRaw: decodeCapture(savedView[1]),
    };
  }
  const presence = organisationPath(pathname, "commerce/board-presence");
  if (presence !== null)
    return { kind: "commerceBoardPresence", organisationIdRaw: presence };
  const exportPreset = organisationPath(pathname, "commerce/export-preset");
  if (exportPreset !== null)
    return { kind: "commerceExportPreset", organisationIdRaw: exportPreset };
  const graphChanges = organisationPath(pathname, "commerce/graph/changes");
  if (graphChanges !== null)
    return { kind: "commerceGraphChanges", organisationIdRaw: graphChanges };
  const graphActivity = organisationPath(pathname, "commerce/graph/activity");
  if (graphActivity !== null)
    return { kind: "commerceGraphActivity", organisationIdRaw: graphActivity };
  const graph = organisationPath(pathname, "commerce/graph");
  if (graph !== null)
    return { kind: "commerceGraph", organisationIdRaw: graph };
  const trackingBatchPreview = organisationPath(
    pathname,
    "commerce/operations/tracking-batches/preview",
  );
  if (trackingBatchPreview !== null)
    return {
      kind: "commerceTrackingBatchPreview",
      organisationIdRaw: trackingBatchPreview,
    };
  for (const action of ["edit", "status", "delete"] as const) {
    const productCatalog = organisationPath(
      pathname,
      `commerce/products/${action}`,
    );
    if (productCatalog !== null)
      return {
        kind: "productCatalog",
        organisationIdRaw: productCatalog,
        action,
      };
  }
  const libraryImage = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/media\/content\/(media_[0-9a-f]{32})$/u,
  );
  if (libraryImage !== null)
    return {
      kind: "libraryImage",
      organisationIdRaw: decodeCapture(libraryImage[0]),
      mediaId: libraryImage[1] ?? "",
    };
  const library = organisationPath(pathname, "commerce/media");
  if (library !== null)
    return {
      kind: "productPhotos",
      organisationIdRaw: library,
      action: "library",
    };
  const libraryDelete = organisationPath(pathname, "commerce/media/delete");
  if (libraryDelete !== null)
    return {
      kind: "productPhotos",
      organisationIdRaw: libraryDelete,
      action: "library_delete",
    };
  const libraryAdd = organisationPath(pathname, "commerce/media/add");
  if (libraryAdd !== null)
    return {
      kind: "productPhotos",
      organisationIdRaw: libraryAdd,
      action: "library_add",
    };
  for (const action of ["add", "arrange"] as const) {
    const productPhotos = organisationPath(
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
  const inventory = organisationPath(pathname, "commerce/inventory");
  if (inventory !== null)
    return { kind: "inventoryStockBalances", organisationIdRaw: inventory };
  const pricedOffers = organisationPath(pathname, "commerce/priced-offers");
  if (pricedOffers !== null)
    return { kind: "commercePricedOffers", organisationIdRaw: pricedOffers };
  const pricePolicy = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/offers\/([^/]+)\/price-policy$/u,
  );
  if (pricePolicy !== null) {
    return {
      kind: "commerceOfferPricePolicy",
      organisationIdRaw: decodeCapture(pricePolicy[0]),
      offerIdRaw: decodeCapture(pricePolicy[1]),
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
  const action = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/actions\/([^/]+)$/u,
  );
  if (action !== null) {
    return {
      kind: "commerceActions",
      organisationIdRaw: decodeCapture(action[0]),
      actionNonceRaw: decodeCapture(action[1]),
    };
  }
  const actions = organisationPath(pathname, "commerce/actions");
  return actions === null
    ? null
    : {
        kind: "commerceActions",
        organisationIdRaw: actions,
        actionNonceRaw: null,
      };
}

function commerceAction(
  pathname: string,
  suffix: "approval" | "rejection" | "execute" | "plugin-preview",
): Readonly<{ organisationIdRaw: string; actionNonceRaw: string }> | null {
  const captures = pathCaptures(
    pathname,
    new RegExp(
      `^/v1/control/organisations/([^/]+)/commerce/actions/([^/]+)/${suffix}$`,
      "u",
    ),
  );
  return captures === null
    ? null
    : {
        organisationIdRaw: decodeCapture(captures[0]),
        actionNonceRaw: decodeCapture(captures[1]),
      };
}

/**
 * Answers one Commerce route. An approval or a rejection of a commerce
 * action goes through the one decide call.
 */
export function handleCommerceControlRoute(
  request: Request,
  env: Env,
  route: CommerceControlRoute,
  decide: DecidePendingDecision,
): Promise<Response> {
  switch (route.kind) {
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
    case "builtInCommerceDemo":
      return handlePantryCommerceDemo(request, env, route.organisationIdRaw);
    case "commerceCueRefresh":
      return handleCommerceCueRefresh(request, env, route.organisationIdRaw);
    case "commercePublishedResources":
      return handleCommercePublishedResources(
        request,
        env,
        route.organisationIdRaw,
      );
    case "commerceExportPreset":
      return handleCommerceExportPreset(request, env, route.organisationIdRaw);
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
    case "inventoryStockBalances":
      return handleCommerceInventory(request, env, route.organisationIdRaw);
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
      return decide(
        { request, organisationIdRaw: route.organisationIdRaw },
        {
          kind: "governed_action",
          surface: "commerce",
          id: route.actionNonceRaw,
          answer: "allow",
        },
      );
    case "commerceActionRejection":
      return decide(
        { request, organisationIdRaw: route.organisationIdRaw },
        {
          kind: "governed_action",
          surface: "commerce",
          id: route.actionNonceRaw,
          answer: "refuse",
        },
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
