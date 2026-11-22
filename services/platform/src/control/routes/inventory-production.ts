import { pantryCommerceAccess } from "@purin-labs/area-commerce/server/contract/client";
import type { CommerceListEntry } from "@purin-labs/commerce-contracts";
import {
  parseInventoryProductionCreation,
  parseInventoryProductionTransition,
  type InventoryProductionCreation,
  type InventoryProductionTransition,
  type InventoryProductionContext,
  type InventoryProductionRequest,
} from "@purin-labs/kitchen-control-api";
import { isNormalizedText, isPositiveInteger } from "@purin-labs/std";
import {
  parseCommerceGraphQuery,
  parseProductionRequestFields,
  productionRequestAttributes,
  parseListEntryReadRequest,
  CommerceEntityPlaneClient,
  type CommerceStockSnapshot,
} from "@purin-labs/commerce-client";
import type { Env } from "@purin-labs/kernel/env";
import {
  commerceListEntryPatchCommand,
  productionRequestCreateCommand,
} from "@purin-labs/area-commerce/server/contract/list-entry-commands";
import {
  controlError,
  controlJson,
  readJsonRecord,
} from "@purin-labs/control/worker/http";
import {
  finishInventoryOperation,
  resolveInventoryAccess,
  resolveInventoryMutation,
  type InventoryControlMutation,
} from "../../kitchen/contract/inventory-control";
import type { Variant } from "@purin-labs/type-utils";

type ProductionAction =
  | Readonly<{ kind: "setup" }>
  | InventoryProductionCreation
  | InventoryProductionTransition
  | Readonly<{
      kind: "link_recipe";
      merchantRevision: number;
      positionId: string;
      positionRevision: number;
      recipeId: string;
      recipeRevision: number;
      requestedAt: string;
    }>;

type DemandResult =
  | Readonly<{
      ok: true;
      value: Exclude<
        InventoryProductionContext["demand"],
        { kind: "unavailable" }
      >;
    }>
  | Readonly<{ ok: false; error: "cursor_stale" | "unavailable" }>;
type DemandSelection = Readonly<{
  itemId: string | null;
  locationId: string | null;
}>;

export async function handleInventoryProduction(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST")
    return controlError("method_not_allowed", 405);
  const access = await resolveInventoryAccess(
    request,
    env,
    organisationIdRaw,
    request.method === "GET" ? "viewer" : "operator",
  );
  if (!access.ok) return access.response;
  const plane = productionClient(
    env,
    String(access.value.authorized.organisationId),
  );
  if (plane === null) return controlError("commerce_unavailable", 503);
  if (request.method === "GET") {
    const snapshot = await access.value.client.readStockSnapshot(
      access.value.binding.merchantId,
    );
    if (!snapshot.ok) return controlError("commerce_unavailable", 503);
    if (snapshot.value.commerce.merchantId !== access.value.binding.merchantId)
      return controlError("commerce_scope_mismatch", 502);

    const url = new URL(request.url);
    let positionId: string | null;
    let requestId: string | null;
    let selection: DemandSelection;
    let cursor: string | null;
    try {
      positionId = readTextParameter(url, "position");
      requestId = readTextParameter(url, "request");
      cursor = readTextParameter(url, "cursor");
      selection = {
        itemId: readTextParameter(url, "inventoryItem"),
        locationId: readTextParameter(url, "location"),
      };
    } catch {
      return controlError("production_request_invalid", 422);
    }
    if (positionId !== null) {
      const position =
        snapshot.value.commerce.resources.inventoryPositions.find(
          positionIdentity.bind(null, positionId),
        );
      if (position === undefined)
        return controlError("inventory_position_missing", 404);
      selection = {
        itemId: position.inventoryItemId,
        locationId: position.locationId,
      };
    }
    const read =
      requestId !== null
        ? await readProductionRequest(plane, snapshot.value, requestId)
        : await readProductionDemand(
            plane,
            String(access.value.authorized.organisationId),
            snapshot.value,
            cursor,
            selection,
          );
    if (!read.ok) return demandError(read.error);
    const demand = read.value;
    if (positionId === null)
      return controlJson({
        ok: true,
        demand,
        merchantRevision: snapshot.value.commerce.merchantRevision,
      });
    const context = productionContext(snapshot.value, positionId, demand);
    return context === null
      ? controlError("inventory_position_missing", 404)
      : controlJson({ ok: true, context });
  }
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("production_request_invalid", 422);
  let action: ProductionAction;
  try {
    action = parseProductionAction(body.value);
  } catch {
    return controlError("production_request_invalid", 422);
  }
  if (
    action.kind === "setup" &&
    access.value.authorized.membership.role !== "owner" &&
    access.value.authorized.membership.role !== "admin"
  )
    return controlError("forbidden", 403);
  const mutation = await resolveInventoryMutation(
    request,
    env,
    access.value,
    body.value,
    `inventory.production.${action.kind}`,
  );
  if (!mutation.ok) return mutation.response;
  if (action.kind === "setup") {
    const result = await plane.publishProductionDemandPreset({
      organisationId: mutation.value.authorized.organisationId,
      merchantId: mutation.value.binding.merchantId,
    });
    if (!result.ok) return controlError("commerce_unavailable", 503);
    if (
      result.value.organisationId !==
        mutation.value.authorized.organisationId ||
      result.value.merchantId !== mutation.value.binding.merchantId
    )
      return controlError("commerce_scope_mismatch", 502);
    return finishInventoryOperation(request, env, mutation.value, {
      ok: true,
      publication: result.value,
    });
  }
  if (action.kind === "link_recipe") {
    const snapshot = await access.value.client.readStockSnapshot(
      access.value.binding.merchantId,
    );
    if (!snapshot.ok) return controlError("commerce_unavailable", 503);
    if (snapshot.value.commerce.merchantId !== access.value.binding.merchantId)
      return controlError("commerce_scope_mismatch", 502);
    return linkProductionRecipe(
      request,
      env,
      mutation.value,
      action,
      snapshot.value,
    );
  }
  let command;
  try {
    command = productionCommand(action, mutation.value);
  } catch {
    return controlError("production_request_invalid", 422);
  }
  const result = await plane.command(command);
  if (!result.ok) return controlError("commerce_unavailable", 503);
  if (result.value.status !== "accepted")
    return controlJson(
      { ok: false, error: result.value.error.code, result: result.value },
      409,
    );
  return finishInventoryOperation(request, env, mutation.value, {
    ok: true,
    result: result.value,
  });
}

function parseProductionAction(
  body: Readonly<Record<string, unknown>>,
): ProductionAction {
  if (body.kind === "setup") return { kind: "setup" };
  if (body.kind === "create") return parseInventoryProductionCreation(body);
  if (body.kind === "accept" || body.kind === "schedule")
    return parseInventoryProductionTransition(body);
  const requestedAt = requiredText(body.requestedAt);
  if (!Number.isFinite(Date.parse(requestedAt)))
    throw new Error("Requested time invalid");
  if (!isPositiveInteger(body.merchantRevision))
    throw new Error("Revision missing");
  if (
    body.kind === "link_recipe" &&
    isPositiveInteger(body.positionRevision) &&
    isPositiveInteger(body.recipeRevision)
  )
    return {
      kind: "link_recipe",
      merchantRevision: body.merchantRevision,
      positionId: requiredText(body.positionId),
      positionRevision: body.positionRevision,
      recipeId: requiredText(body.recipeId),
      recipeRevision: body.recipeRevision,
      requestedAt,
    };
  throw new Error("Production action invalid");
}

function productionCommand(
  action: Exclude<ProductionAction, { kind: "setup" | "link_recipe" }>,
  mutation: InventoryControlMutation,
) {
  const shared = {
    organisationId: mutation.authorized.organisationId,
    merchantId: mutation.binding.merchantId,
    principalId: mutation.identity.userId,
    commandId: `production:${mutation.boundary.idempotencyKey}`,
    merchantRevision: action.merchantRevision,
    listRevision: action.listRevision,
    fields: {
      status: "requested",
      recipeId: action.recipeId,
      recipeRevision: action.recipeRevision,
      locationId: action.locationId,
      quantity: action.quantity,
      neededBy: action.neededBy,
    },
  } as const;
  if (action.kind === "create")
    return productionRequestCreateCommand({
      ...shared,
      entryId: `production_request_${mutation.boundary.idempotencyKey}`,
      inventoryItemId: action.inventoryItemId,
    });
  return commerceListEntryPatchCommand({
    ...shared,
    listId: "production_requests",
    entryId: action.requestId,
    entryRevision: action.requestRevision,
    attributeValues: productionRequestAttributes({
      ...shared.fields,
      status: action.kind === "accept" ? "accepted" : "scheduled",
    }),
  });
}

function productionContext(
  snapshot: CommerceStockSnapshot,
  positionId: string,
  demand: InventoryProductionContext["demand"],
): InventoryProductionContext | null {
  const position = snapshot.commerce.resources.inventoryPositions.find(
    positionIdentity.bind(null, positionId),
  );
  if (position === undefined) return null;
  const item = snapshot.commerce.resources.inventoryItems.find(
    itemIdentity.bind(null, position.inventoryItemId),
  );
  if (item === undefined || item.category !== "finished_good") return null;
  const recipes = [];
  const linkableRecipes = [];
  for (const recipe of snapshot.foodService.resources.recipeRevisions) {
    if (
      recipe.lifecycle.state !== "active" ||
      recipe.output.kind !== "stocked" ||
      recipe.output.yieldQuantity.unit !== item.baseUnit
    )
      continue;
    const inputs = [];
    for (const input of recipe.inputs) {
      const ingredient = snapshot.commerce.resources.inventoryItems.find(
        itemIdentity.bind(null, input.inventoryItemId),
      );
      const ingredientPosition =
        snapshot.commerce.resources.inventoryPositions.find(
          itemLocationMatches.bind(
            null,
            input.inventoryItemId,
            position.locationId,
          ),
        );
      const usable =
        ingredientPosition === undefined
          ? undefined
          : snapshot.usable.find(
              usableIdentity.bind(null, ingredientPosition.id),
            );
      inputs.push({
        name: ingredient?.name ?? input.inventoryItemId,
        quantity: input.quantity,
        available: usable?.quantity ?? null,
      });
    }
    const option = {
      id: String(recipe.recipeId),
      revision: recipe.revision,
      name: recipe.name,
      yield: recipe.output.yieldQuantity,
      inputs,
    };
    linkableRecipes.push(option);
    if (recipe.output.inventoryItemId === item.id) recipes.push(option);
  }
  return {
    merchantRevision: snapshot.commerce.merchantRevision,
    inventoryItemId: item.id,
    inventoryPositionId: position.id,
    inventoryPositionRevision: position.revision,
    locationId: position.locationId,
    itemName: item.name,
    recipes,
    linkableRecipes,
    demand,
  };
}

async function readProductionDemand(
  client: CommerceEntityPlaneClient,
  organisationId: string,
  snapshot: CommerceStockSnapshot,
  cursor: string | null,
  selection: DemandSelection,
): Promise<DemandResult> {
  const metadata = await client.publishedResourceMetadata({
    kind: "enumerate",
    organisationId,
    merchantId: snapshot.commerce.merchantId,
  });
  if (!metadata.ok || metadata.value.kind !== "enumerated")
    return { ok: false, error: "unavailable" };
  const list = metadata.value.lists.find(productionList);
  if (list === undefined) return { ok: true, value: { kind: "inactive" } };
  const result = await client.query({
    merchantId: snapshot.commerce.merchantId,
    query: productionDemandQuery(selection, cursor),
  });
  if (!result.ok)
    return {
      ok: false,
      error:
        result.error.kind === "cursor_stale" ? "cursor_stale" : "unavailable",
    };
  if (
    Number(result.value.merchantRevision) !== snapshot.commerce.merchantRevision
  )
    return { ok: false, error: "cursor_stale" };
  return {
    ok: true,
    value: {
      kind: "ready",
      listRevision: Number(list.publishedRevision),
      merchantRevision: snapshot.commerce.merchantRevision,
      ...productionEntries(snapshot, result.value.listEntries),
      nextCursor: result.value.nextCursor,
    },
  };
}

async function readProductionRequest(
  client: CommerceEntityPlaneClient,
  snapshot: CommerceStockSnapshot,
  requestId: string,
): Promise<DemandResult> {
  const result = await client.readListEntry(
    parseListEntryReadRequest({
      merchantId: snapshot.commerce.merchantId,
      listId: "production_requests",
      entryId: requestId,
    }),
  );
  if (!result.ok) return { ok: false, error: "unavailable" };
  if (result.value.kind === "missing")
    return { ok: true, value: { kind: "inactive" } };
  if (
    Number(result.value.merchantRevision) !== snapshot.commerce.merchantRevision
  )
    return { ok: false, error: "cursor_stale" };
  return {
    ok: true,
    value: {
      kind: "ready",
      listRevision: Number(result.value.listRevision),
      merchantRevision: snapshot.commerce.merchantRevision,
      ...productionEntries(snapshot, [result.value.entry]),
      nextCursor: null,
    },
  };
}
function readTextParameter(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  return value === null ? null : requiredText(value);
}

function productionDemandQuery(
  selection: DemandSelection,
  cursor: string | null,
) {
  return parseCommerceGraphQuery({
    kind: "commerce_list_page",
    listId: "production_requests",
    filter:
      selection.itemId === null && selection.locationId === null
        ? { kind: "all" }
        : {
            kind: "not",
            filter: {
              kind: "any",
              filters: [
                ...(selection.itemId === null
                  ? []
                  : [
                      {
                        kind: "not",
                        filter: {
                          kind: "entity",
                          reference: {
                            origin: "system",
                            typeId: "inventory_item",
                            entityId: selection.itemId,
                          },
                        },
                      },
                    ]),
                ...(selection.locationId === null
                  ? []
                  : [
                      {
                        kind: "not",
                        filter: {
                          kind: "attribute",
                          filter: {
                            operator: "equals",
                            attributeId: "location_id",
                            value: {
                              kind: "short_text",
                              value: selection.locationId,
                            },
                          },
                        },
                      },
                    ]),
              ],
            },
          },
    sorts: [],
    pagination: { limit: 100, cursor },
  });
}
function demandError(error: "cursor_stale" | "unavailable"): Response {
  return error === "cursor_stale"
    ? controlError("production_cursor_stale", 409)
    : controlError("production_requests_unavailable", 503);
}

function productionEntries(
  snapshot: CommerceStockSnapshot,
  entries: readonly CommerceListEntry[],
): Pick<
  Variant<InventoryProductionContext["demand"], "ready">,
  "requests" | "invalidRequests"
> {
  const requests: InventoryProductionRequest[] = [];
  const invalidRequests: { id: string; message: string }[] = [];
  for (const entry of entries) {
    try {
      requests.push(requestFromEntry(snapshot, entry));
    } catch {
      invalidRequests.push({
        id: String(entry.entryId),
        message:
          "This stored request has invalid production details. Correct or archive it before continuing.",
      });
    }
  }
  return { requests, invalidRequests };
}

function requestFromEntry(
  snapshot: CommerceStockSnapshot,
  entry: CommerceListEntry,
): InventoryProductionRequest {
  const fields = parseProductionRequestFields(entry.attributeValues);
  const id = String(entry.entryId);
  const batches = [];
  for (const batch of snapshot.foodService.resources.productionBatches)
    if (batch.demand.kind === "request" && batch.demand.requestId === id)
      batches.push({
        id: String(batch.productionBatchId),
        actualYield: batch.actualYield,
      });
  return {
    id,
    revision: Number(entry.revision),
    itemId: String(entry.entityRef.entityId),
    name:
      snapshot.commerce.resources.inventoryItems.find(
        itemIdentity.bind(null, String(entry.entityRef.entityId)),
      )?.name ?? String(entry.entityRef.entityId),
    locationId: fields.locationId,
    recipeId: fields.recipeId,
    recipeRevision: fields.recipeRevision,
    quantity: fields.quantity,
    neededBy: fields.neededBy,
    status: fields.status,
    batches,
  };
}
export function productionClient(
  env: Env,
  organisationId: string,
): CommerceEntityPlaneClient | null {
  return env.COMMERCE_BASE_URL === undefined ||
    env.COMMERCE_SERVICE_TOKEN === undefined
    ? null
    : new CommerceEntityPlaneClient({
        baseUrl: env.COMMERCE_BASE_URL,
        ...pantryCommerceAccess(
          env.COMMERCE_SERVICE_TOKEN,
          organisationId,
          env.COMMERCE.fetch.bind(env.COMMERCE),
        ),
      });
}
function requiredText(value: unknown): string {
  if (!isNormalizedText(value))
    throw new Error("Required production field missing");
  return value;
}
function productionList(list: { listId: string }): boolean {
  return list.listId === "production_requests";
}
function positionIdentity(
  id: string,
  position: CommerceStockSnapshot["commerce"]["resources"]["inventoryPositions"][number],
): boolean {
  return position.id === id;
}
function itemIdentity(
  id: string,
  item: CommerceStockSnapshot["commerce"]["resources"]["inventoryItems"][number],
): boolean {
  return item.id === id;
}
function itemLocationMatches(
  itemId: string,
  locationId: string,
  position: CommerceStockSnapshot["commerce"]["resources"]["inventoryPositions"][number],
): boolean {
  return (
    position.inventoryItemId === itemId && position.locationId === locationId
  );
}
function usableIdentity(
  id: string,
  usable: CommerceStockSnapshot["usable"][number],
): boolean {
  return usable.positionId === id;
}

async function linkProductionRecipe(
  request: Request,
  env: Env,
  mutation: InventoryControlMutation,
  action: Variant<ProductionAction, "link_recipe">,
  snapshot: CommerceStockSnapshot,
): Promise<Response> {
  const details = productionContext(snapshot, action.positionId, {
    kind: "inactive",
  });
  if (
    details === null ||
    details.inventoryPositionRevision !== action.positionRevision
  )
    return controlError("stale_resource_revision", 409);
  const source = snapshot.foodService.resources.recipeRevisions.find(
    sourceRecipeIdentity.bind(null, action.recipeId, action.recipeRevision),
  );
  const item = snapshot.commerce.resources.inventoryItems.find(
    itemIdentity.bind(null, details.inventoryItemId),
  );
  if (
    source === undefined ||
    item === undefined ||
    source.lifecycle.state !== "active" ||
    source.output.kind !== "stocked" ||
    source.output.yieldQuantity.unit !== item.baseUnit
  )
    return controlError("production_request_invalid", 422);
  const result = await mutation.client.createRecipeRevision({
    merchantId: mutation.binding.merchantId,
    expectedMerchantRevision: action.merchantRevision,
    idempotencyKey: mutation.boundary.idempotencyKey,
    recipeRevision: {
      recipeId: `recipe_link_${mutation.boundary.idempotencyKey}`,
      name: `${source.name} · ${item.name}`,
      inputs: source.inputs,
      output: {
        kind: "stocked",
        inventoryItemId: item.id,
        yieldQuantity: source.output.yieldQuantity,
      },
    },
  });
  if (!result.ok) return controlError("commerce_unavailable", 503);
  if (result.value.outcome === "rejected")
    return controlJson(
      { ok: false, error: result.value.error.code, result: result.value },
      409,
    );
  return finishInventoryOperation(request, env, mutation, {
    ok: true,
    result: result.value,
  });
}
function sourceRecipeIdentity(
  id: string,
  revision: number,
  recipe: CommerceStockSnapshot["foodService"]["resources"]["recipeRevisions"][number],
): boolean {
  return String(recipe.recipeId) === id && recipe.revision === revision;
}
