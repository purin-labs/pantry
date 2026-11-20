import {
  FORECAST_CAPEX_MINOR_CELL_KEY,
  FORECAST_DEMAND_CURVE_CELL_KEY,
  FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY,
  FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY,
  FORECAST_OPENING_CASH_CELL_KEY,
  FORECAST_SUPPLIER_TERMS_CELL_KEY,
  OVERHEAD_LABOR_CELL_KEY,
  OVERHEAD_RENT_CELL_KEY,
  SCENARIO_PRESET_CELL_KEY,
  forecastWeekIndexCellKey,
  lotInvoiceFieldCellKey,
  productCogsCellKey,
  productDailyCellKey,
  productDayCellKey,
  productFormulaCellKey,
  productSpoilCellKey,
  productWasteCellKey,
  supplyFieldCellKey,
} from "@purin-labs/costs-sheet-crdt";
import {
  COST_FORMULA_COLUMNS,
  parseCostsSheetWrite,
  parseLotCostWrite,
  parseSupplyCostWrite,
  type CostUnit,
  type CostsSheetWrite,
  type CostsSheetWriteResult,
} from "@purin-labs/kitchen-control-api";
import type { CommerceStockSnapshot } from "@purin-labs/commerce-client";
import { requireActiveOrganisationActor } from "../../actors/actor-router";
import {
  readCostsOverview,
  saveSupplyCostTerms,
} from "../../commerce/cost-commands";
import {
  readOrganisationCostPlan,
  saveOfferPriceWrites,
  saveOrganisationCostPlan,
  saveOrganisationLotInvoiceCost,
} from "../../commerce/cost-plan-store";
import type { Env } from "../../env";
import { newRequestId } from "../../ids";
import { traceWarn } from "../../observability";
import { createCommerceEntityPlaneClient } from "../../commerce/contract/client";
import { controlError, controlJson, readJsonRecord } from "../http";
import {
  finishInventoryOperation,
  resolveInventoryAccess,
  resolveInventoryMutation,
  type InventoryControlMutation,
} from "./inventory-control";

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
    return controlError("underclerk_unavailable", 503);
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
      underclerkBaseUrl: env.UNDERCLERK_BASE_URL,
    });
    if (!overview.ok) {
      return overview.error.code === "underclerk_scope_mismatch"
        ? controlError("underclerk_scope_mismatch", 502)
        : controlError("underclerk_unavailable", 503);
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
      return controlJson(
        {
          ok: false,
          error: "cost_sheet_invalid",
          detail:
            error instanceof Error
              ? error.message
              : "The cost sheet changes are invalid.",
        },
        422,
      );
    }

    if (sheet.priceWrites.length > 0 && !canEditPrices) {
      return controlError("insufficient_role", 403);
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

    const orgId = String(mutation.value.authorized.organisationId);
    const merchantId = mutation.value.binding.merchantId;
    const nowMs = Date.now();

    const lotWrites = sheet.lotWrites ?? [];
    let knownProductIds: ReadonlySet<string> | undefined;
    let knownLotsById:
      | ReadonlyMap<string, Readonly<{ inventoryItemId: string; baseUnit: CostUnit }>>
      | undefined;
    if (sheet.planWrite !== null || lotWrites.length > 0) {
      if (sheet.planWrite !== null) {
        const currentPlan = await readOrganisationCostPlan(regionalDb, orgId);
        const expected = sheet.planWrite.expectedPlanRevision;
        if (
          (expected === null && currentPlan.revision !== null) ||
          (expected !== null && currentPlan.revision !== expected)
        ) {
          return controlError("stale_resource_revision", 409);
        }
      }
      const snapshot = await mutation.value.client.readStockSnapshot(merchantId);
      if (!snapshot.ok) {
        return controlError("underclerk_unavailable", 503);
      }
      if (snapshot.value.commerce.merchantId !== merchantId) {
        return controlError("underclerk_scope_mismatch", 502);
      }
      if (sheet.planWrite !== null) {
        knownProductIds = new Set(
          snapshot.value.commerce.resources.products
            .filter((product) => product.status === "active")
            .map((product) => product.id),
        );
        for (const entry of sheet.planWrite.products) {
          if (!knownProductIds.has(entry.productId)) {
            return controlJson(
              {
                ok: false,
                error: "cost_plan_invalid",
                detail: `Product ${entry.productId} is not an active product.`,
              },
              422,
            );
          }
        }
      }
      if (lotWrites.length > 0) {
        knownLotsById = buildKnownLotsById(snapshot.value);
      }
    }

    let latestMerchantRevision = sheet.merchantRevision;

    if (sheet.priceWrites.length > 0) {
      const priceSaved = await saveOfferPriceWrites({
        adminClient: mutation.value.client,
        merchantId,
        idempotencyKey: mutation.value.boundary.idempotencyKey,
        writes: sheet.priceWrites,
      });
      if (!priceSaved.ok) {
        switch (priceSaved.code) {
          case "underclerk_unavailable":
            return controlError("underclerk_unavailable", 503);
          case "underclerk_scope_mismatch":
            return controlError("underclerk_scope_mismatch", 502);
          case "offer_price_changed":
            return controlError("stale_resource_revision", 409);
          case "offer_price_invalid":
            return controlJson(
              {
                ok: false,
                error: priceSaved.code,
                detail: priceSaved.detail,
              },
              422,
            );
        }
      }
      if (priceSaved.merchantRevision !== null) {
        latestMerchantRevision = priceSaved.merchantRevision;
      }
    }

    for (let idx = 0; idx < sheet.supplyWrites.length; idx += 1) {
      const supplyLine = sheet.supplyWrites[idx];
      if (supplyLine === undefined) {
        continue;
      }
      const savedSupply = await saveSupplyCostTerms({
        adminClient: mutation.value.client,
        entityPlaneClient,
        organisationId: orgId,
        merchantId,
        principalId: mutation.value.identity.userId,
        idempotencyKey: `${mutation.value.boundary.idempotencyKey.slice(0, 72)}:supply:${idx}`,
        write: {
          merchantRevision: latestMerchantRevision,
          requestedAt: sheet.requestedAt,
          ...supplyLine,
        },
        nowMs,
      });
      if (!savedSupply.ok) {
        switch (savedSupply.code) {
          case "underclerk_unavailable":
          case "supply_cost_busy":
            return controlError(savedSupply.code, 503);
          case "underclerk_scope_mismatch":
            return controlError(savedSupply.code, 502);
          case "supply_cost_changed":
            return controlError("stale_resource_revision", 409);
          case "supply_cost_invalid":
          case "supply_cost_unit_mismatch":
            return controlJson(
              {
                ok: false,
                error: savedSupply.code,
                detail: savedSupply.detail,
              },
              422,
            );
        }
      }
      latestMerchantRevision = savedSupply.merchantRevision;
    }

    for (const lotWrite of lotWrites) {
      const savedLot = await saveOrganisationLotInvoiceCost({
        db: regionalDb,
        organisationId: orgId,
        updatedBy: mutation.value.identity.userId,
        nowMs,
        write: lotWrite,
        ...(knownLotsById === undefined ? {} : { knownLotsById }),
      });
      if (!savedLot.ok) {
        if (savedLot.code === "lot_cost_changed") {
          return controlError("stale_resource_revision", 409);
        }
        return controlJson(
          { ok: false, error: savedLot.code, detail: savedLot.detail },
          422,
        );
      }
    }

    let planRevision: number | null = null;
    if (sheet.planWrite !== null) {
      const savedPlan = await saveOrganisationCostPlan({
        db: regionalDb,
        organisationId: orgId,
        updatedBy: mutation.value.identity.userId,
        nowMs,
        expectedPlanRevision: sheet.planWrite.expectedPlanRevision,
        dailyLaborMinor: sheet.planWrite.dailyLaborMinor,
        dailyRentMinor: sheet.planWrite.dailyRentMinor,
        products: sheet.planWrite.products,
        ...(sheet.planWrite.forecast !== undefined
          ? { forecast: sheet.planWrite.forecast }
          : {}),
        replaceAllProducts: true,
        ...(knownProductIds === undefined ? {} : { knownProductIds }),
      });
      if (!savedPlan.ok) {
        if (savedPlan.code === "cost_plan_changed") {
          return controlError("stale_resource_revision", 409);
        }
        return controlJson(
          { ok: false, error: savedPlan.code, detail: savedPlan.detail },
          422,
        );
      }
      planRevision = savedPlan.revision;
    } else {
      const existingPlan = await readOrganisationCostPlan(regionalDb, orgId);
      planRevision = existingPlan.revision;
    }

    await settleCostsSheetAfterSave(
      env,
      mutation.value,
      collectSavedSheetCellKeys(sheet),
      sheet.priceWrites.length > 0,
      nowMs,
    );

    const result: CostsSheetWriteResult = {
      ok: true,
      merchantRevision: latestMerchantRevision,
      planRevision,
      updatedOfferCount: sheet.priceWrites.length,
      updatedSupplyCount: sheet.supplyWrites.length,
      updatedLotCount: lotWrites.length,
    };
    return finishInventoryOperation(request, env, mutation.value, result);
  }

  if (body.value.kind === "save_lot_cost") {
    let lotWrite;
    try {
      lotWrite = parseLotCostWrite(body.value);
    } catch (error) {
      return controlJson(
        {
          ok: false,
          error: "lot_cost_invalid",
          detail:
            error instanceof Error
              ? error.message
              : "The lot invoice cost payload is invalid.",
        },
        422,
      );
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

    const merchantId = mutation.value.binding.merchantId;
    const snapshot = await mutation.value.client.readStockSnapshot(merchantId);
    if (!snapshot.ok) {
      return controlError("underclerk_unavailable", 503);
    }
    if (snapshot.value.commerce.merchantId !== merchantId) {
      return controlError("underclerk_scope_mismatch", 502);
    }

    const savedNowMs = Date.now();
    const savedLot = await saveOrganisationLotInvoiceCost({
      db: regionalDb,
      organisationId: String(mutation.value.authorized.organisationId),
      updatedBy: mutation.value.identity.userId,
      nowMs: savedNowMs,
      write: lotWrite,
      knownLotsById: buildKnownLotsById(snapshot.value),
    });

    if (!savedLot.ok) {
      if (savedLot.code === "lot_cost_changed") {
        return controlError("stale_resource_revision", 409);
      }
      return controlJson(
        { ok: false, error: savedLot.code, detail: savedLot.detail },
        422,
      );
    }

    await settleCostsSheetAfterSave(
      env,
      mutation.value,
      lotInvoiceCellKeys(lotWrite.lotId),
      false,
      savedNowMs,
    );

    return finishInventoryOperation(request, env, mutation.value, {
      ok: true,
      lotId: lotWrite.lotId,
      revision: savedLot.revision,
      invoiceCost: savedLot.invoiceCost,
      merchantRevision: Number(snapshot.value.commerce.merchantRevision),
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

  const savedNowMs = Date.now();
  const saved = await saveSupplyCostTerms({
    adminClient: mutation.value.client,
    entityPlaneClient,
    organisationId: String(mutation.value.authorized.organisationId),
    merchantId: mutation.value.binding.merchantId,
    principalId: mutation.value.identity.userId,
    idempotencyKey: mutation.value.boundary.idempotencyKey,
    write,
    nowMs: savedNowMs,
  });

  if (!saved.ok) {
    switch (saved.code) {
      case "underclerk_unavailable":
      case "supply_cost_busy":
        return controlError(saved.code, 503);
      case "underclerk_scope_mismatch":
        return controlError(saved.code, 502);
      case "supply_cost_changed":
        return controlError("stale_resource_revision", 409);
      case "supply_cost_invalid":
      case "supply_cost_unit_mismatch":
        return controlJson(
          { ok: false, error: saved.code, detail: saved.detail },
          422,
        );
    }
  }

  await settleCostsSheetAfterSave(
    env,
    mutation.value,
    supplyItemCellKeys(write.inventoryItemId),
    false,
    savedNowMs,
  );

  return finishInventoryOperation(request, env, mutation.value, {
    ok: true,
    entryId: saved.entryId,
    entryRevision: saved.entryRevision,
    merchantRevision: saved.merchantRevision,
  });
}

function supplyItemCellKeys(inventoryItemId: string): string[] {
  return [
    supplyFieldCellKey(inventoryItemId, "packQuantity"),
    supplyFieldCellKey(inventoryItemId, "packUnit"),
    supplyFieldCellKey(inventoryItemId, "packPriceMajor"),
    supplyFieldCellKey(inventoryItemId, "bulkMin7dQuantity"),
    supplyFieldCellKey(inventoryItemId, "bulkPackQuantity"),
    supplyFieldCellKey(inventoryItemId, "bulkPackPriceMajor"),
  ];
}

function lotInvoiceCellKeys(lotId: string): string[] {
  return [
    lotInvoiceFieldCellKey(lotId, "invoiceReference"),
    lotInvoiceFieldCellKey(lotId, "invoiceTotalMajor"),
  ];
}

function buildKnownLotsById(
  snapshot: CommerceStockSnapshot,
): ReadonlyMap<string, Readonly<{ inventoryItemId: string; baseUnit: CostUnit }>> {
  const itemsById = new Map(
    snapshot.commerce.resources.inventoryItems.map((item) => [item.id, item]),
  );
  const out = new Map<
    string,
    Readonly<{ inventoryItemId: string; baseUnit: CostUnit }>
  >();
  for (const lot of snapshot.lots) {
    const item = itemsById.get(lot.inventoryItemId);
    if (item === undefined || item.category === "finished_good") {
      continue;
    }
    out.set(lot.id, {
      inventoryItemId: lot.inventoryItemId,
      baseUnit: item.baseUnit,
    });
  }
  return out;
}

function collectSavedSheetCellKeys(sheet: CostsSheetWrite): string[] {
  const keys: string[] = [];
  if (sheet.planWrite !== null) {
    keys.push(
      OVERHEAD_LABOR_CELL_KEY,
      OVERHEAD_RENT_CELL_KEY,
      SCENARIO_PRESET_CELL_KEY,
    );
    if (sheet.planWrite.forecast !== undefined) {
      keys.push(
        FORECAST_OPENING_CASH_CELL_KEY,
        FORECAST_DEMAND_CURVE_CELL_KEY,
        FORECAST_SUPPLIER_TERMS_CELL_KEY,
        FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY,
        FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY,
        FORECAST_CAPEX_MINOR_CELL_KEY,
      );
      for (let w = 0; w < 12; w += 1) {
        keys.push(forecastWeekIndexCellKey(w));
      }
    }
    for (const entry of sheet.planWrite.products) {
      keys.push(
        productDailyCellKey(entry.productId),
        productSpoilCellKey(entry.productId),
        productCogsCellKey(entry.productId),
        productWasteCellKey(entry.productId),
      );
      for (const col of COST_FORMULA_COLUMNS) {
        keys.push(productFormulaCellKey(entry.productId, col));
      }
      for (let day = 0; day < 7; day += 1) {
        keys.push(productDayCellKey(entry.productId, day));
      }
    }
  }
  for (const supply of sheet.supplyWrites) {
    keys.push(...supplyItemCellKeys(supply.inventoryItemId));
  }
  for (const lot of sheet.lotWrites ?? []) {
    keys.push(...lotInvoiceCellKeys(lot.lotId));
  }
  return keys;
}

async function settleCostsSheetAfterSave(
  env: Env,
  mutation: InventoryControlMutation,
  cellKeys: readonly string[],
  clearPriceCells: boolean,
  savedAtMs: number,
): Promise<void> {
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: mutation.authorized.organisationId,
      now: savedAtMs,
    });
    const settled = await organisation.settleCostsSheetDraft({
      organisationId: mutation.authorized.organisationId,
      cellKeys,
      clearPriceCells,
      savedAtMs,
      userId: mutation.authorized.authenticated.session.userId,
      origin: {
        kind: "control_session",
        controlSessionId:
          mutation.authorized.authenticated.session.controlSessionId,
      },
    });
    if (!settled.ok) {
      traceWarn("commerce.costs_sheet_settle_deferred", {
        requestId: newRequestId(),
        organisationId: mutation.authorized.organisationId,
        code: settled.error.code,
      });
    }
  } catch (error) {
    traceWarn("commerce.costs_sheet_settle_deferred", {
      requestId: newRequestId(),
      organisationId: mutation.authorized.organisationId,
      detail: error instanceof Error ? error.message : "actor_unavailable",
    });
  }
}
