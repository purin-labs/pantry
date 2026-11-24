import {
  parseCostsSheetWrite,
  parseLotCostWrite,
  parseSupplyCostWrite,
  type CostsSheetSaved,
} from "@purin-labs/kitchen-control-api";
import { readCostsOverview } from "../../cost-commands";
import {
  saveCostsSheet,
  saveLotCost,
  saveSupplyCost,
  type CostsSaveRefusal,
} from "../../costs-sheet-save";
import { controlSessionCostsSheetSettlement } from "../../costs-sheet-settlement";
import type { Env } from "@purin-labs/kernel/env";
import { createCommerceEntityPlaneClient } from "@purin-labs/area-commerce-contract/server/client";
import { controlError, controlJson, readJsonRecord } from "@purin-labs/control/worker/http";
import {
  finishInventoryOperation,
  resolveInventoryAccess,
  resolveInventoryMutation,
  type InventoryControlMutation,
} from "@purin-labs/area-kitchen-contract/server/inventory-control";

export async function handleCosts(
  request: Request,
  env: Env,
  organisationId: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const access = await resolveInventoryAccess(
    request,
    env,
    organisationId,
    request.method === "GET" ? "viewer" : "operator",
  );
  if (!access.ok) {
    return access.response;
  }

  const role = access.value.authorized.membership.role;
  const canEditPrices = role === "owner" || role === "admin";
  const regionalDb = access.value.authorized.executionScope.database;

  const entityPlaneClient = createCommerceEntityPlaneClient(env, undefined, {
    kind: "organisation",
    organisationId: String(access.value.authorized.organisationId),
    actor: String(access.value.authorized.membership.personId),
  });
  if (entityPlaneClient === null) {
    return controlError("commerce_unavailable", 503);
  }

  if (request.method === "GET") {
    const overview = await readCostsOverview({
      adminClient: access.value.client,
      entityPlaneClient,
      organisationId: String(access.value.authorized.organisationId),
      merchantId: access.value.binding.merchantId,
      nowMs: Date.now(),
      db: regionalDb,
      canEditPrices,
      commerceBaseUrl: env.COMMERCE_BASE_URL,
    });
    if (!overview.ok) {
      return overview.error.code === "commerce_scope_mismatch"
        ? controlError("commerce_scope_mismatch", 502)
        : controlError("commerce_unavailable", 503);
    }
    return controlJson(overview.value);
  }

  const body = await readJsonRecord(request);
  if (!body.ok) {
    return controlError("supply_cost_invalid", 422);
  }

  if (body.value.kind === "save_sheet") {
    let sheet;
    try {
      sheet = parseCostsSheetWrite(body.value);
    } catch (error) {
      return invalidBody("cost_sheet_invalid", error, "The cost sheet changes are invalid.");
    }
    const mutation = await resolveInventoryMutation(
      request,
      env,
      access.value,
      body.value,
      "costs.sheet.save",
    );
    if (!mutation.ok) {
      return mutation.response;
    }
    const saved = await saveCostsSheet({
      ...saveContext(env, mutation.value, entityPlaneClient),
      sheet,
      canEditPrices,
    });
    if (!saved.ok) {
      return refusalResponse(saved.error);
    }
    return finishInventoryOperation(request, env, mutation.value, saved.value);
  }

  if (body.value.kind === "save_lot_cost") {
    let lotWrite;
    try {
      lotWrite = parseLotCostWrite(body.value);
    } catch (error) {
      return invalidBody("lot_cost_invalid", error, "The lot invoice cost payload is invalid.");
    }
    const mutation = await resolveInventoryMutation(
      request,
      env,
      access.value,
      body.value,
      "lot_cost.save",
    );
    if (!mutation.ok) {
      return mutation.response;
    }
    const saved = await saveLotCost({
      ...saveContext(env, mutation.value, entityPlaneClient),
      write: lotWrite,
    });
    if (!saved.ok) {
      return refusalResponse(saved.error);
    }
    return finishInventoryOperation(request, env, mutation.value, {
      ok: true,
      ...saved.value,
    });
  }

  let write;
  try {
    write = parseSupplyCostWrite(body.value);
  } catch {
    return controlError("supply_cost_invalid", 422);
  }
  const mutation = await resolveInventoryMutation(
    request,
    env,
    access.value,
    body.value,
    "supply_cost.save",
  );
  if (!mutation.ok) {
    return mutation.response;
  }
  const saved = await saveSupplyCost({
    ...saveContext(env, mutation.value, entityPlaneClient),
    write,
  });
  if (!saved.ok) {
    return refusalResponse(saved.error);
  }
  return finishInventoryOperation(request, env, mutation.value, {
    ok: true,
    ...saved.value,
  });
}

function saveContext(
  env: Env,
  mutation: InventoryControlMutation,
  entityPlaneClient: NonNullable<
    ReturnType<typeof createCommerceEntityPlaneClient>
  >,
) {
  return {
    adminClient: mutation.client,
    entityPlaneClient,
    db: mutation.authorized.executionScope.database,
    organisationId: String(mutation.authorized.organisationId),
    merchantId: mutation.binding.merchantId,
    userId: mutation.identity.userId,
    idempotencyKey: mutation.boundary.idempotencyKey,
    nowMs: Date.now(),
    settle: controlSessionCostsSheetSettlement(env, mutation.authorized),
  };
}

function invalidBody(code: string, error: unknown, fallback: string): Response {
  return controlJson(
    {
      ok: false,
      error: code,
      detail: error instanceof Error ? error.message : fallback,
    },
    422,
  );
}

/** A refused save; a sheet refusal names the records that saved before it. */
function refusalResponse(
  refusal: CostsSaveRefusal & Partial<Readonly<{ saved: CostsSheetSaved }>>,
): Response {
  const saved =
    refusal.saved !== undefined &&
    (refusal.saved.offerIds.length > 0 ||
      refusal.saved.inventoryItemIds.length > 0)
      ? { saved: refusal.saved }
      : {};
  return controlJson(
    {
      ok: false,
      error: refusal.code,
      ...("detail" in refusal ? { detail: refusal.detail } : {}),
      ...saved,
    },
    refusalStatus(refusal.code),
  );
}

function refusalStatus(code: CostsSaveRefusal["code"]): number {
  switch (code) {
    case "insufficient_role":
      return 403;
    case "stale_resource_revision":
      return 409;
    case "commerce_scope_mismatch":
      return 502;
    case "commerce_unavailable":
    case "supply_cost_busy":
    case "cost_sheet_write_failed":
      return 503;
    case "cost_plan_invalid":
    case "lot_cost_invalid":
    case "lot_cost_unit_mismatch":
    case "offer_price_invalid":
    case "supply_cost_invalid":
    case "supply_cost_unit_mismatch":
      return 422;
  }
}
