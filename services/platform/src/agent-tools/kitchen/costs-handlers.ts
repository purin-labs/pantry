import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  FORECAST_CAPEX_MINOR_CELL_KEY,
  FORECAST_DEMAND_CURVE_CELL_KEY,
  FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY,
  FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY,
  FORECAST_OPENING_CASH_CELL_KEY,
  FORECAST_SUPPLIER_TERMS_CELL_KEY,
  META_SAVED_AT_CELL_KEY,
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
  type CostsSheetCell,
} from "@purin-labs/costs-sheet-crdt";
import type { CaseAssignment, HarnessTurnLease } from "@purin-labs/contracts";
import {
  COST_FORMULA_COLUMNS,
  calculateBakery12WeekForecast,
  calculateBakeryCostsAndMargins,
  calculateBakeryPlanVsActuals,
  defaultCostAssumptions,
  type CostForecastPlan,
  type CostUnit,
} from "@purin-labs/kitchen-control-api";
import { assertNever } from "@purin-labs/std";
import type {
  CommerceAdminClient,
  CommerceEntityPlaneClient,
} from "@purin-labs/commerce-client";
import type { CatalogExecutionContext } from "../catalog/execute";
import type { StaffPageToolReceipt } from "../catalog/types";
import { StaffPageRequestError } from "../errors";
import type {
  CostsPlanSaveRequest,
  CostsPlanSaveTool,
  CostsReadRequest,
  CostsReadTool,
  CostsSheetEditRequest,
  CostsSheetEditResult,
  CostsSheetEditTool,
  CostsToolRead,
  LotCostSaveRequest,
  LotCostSaveTool,
  SupplyCostSaveRequest,
  SupplyCostSaveTool,
} from "./costs";
import {
  collaborationEditDeadline,
  collaborationMember,
  liveDeviceMember,
  type ToolEffect,
} from "../session-support";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { sessionTurnExecution } from "../../chat/turn-access";
import {
  readCostsOverview,
  saveSupplyCostTerms,
  type SupplyCostSaveResult,
} from "../../commerce/cost-commands";
import {
  saveOrganisationCostPlan,
  saveOrganisationLotInvoiceCost,
  type CostPlanSaveResult,
  type LotCostSaveResult,
} from "../../commerce/cost-plan-store";
import { CommerceReadRequestError } from "../../commerce/contract/read-errors";
import type { Env } from "@purin-labs/kernel/env";
import { requireActiveOrganisationActorAtPlacement } from "@purin-labs/actor-runtime/actors/actor-router";
import { preflightHarnessTurnLease } from "../../actors/agent-session-harness-authority";
import { resolveCollaborationAgent } from "../../actors/collaboration-agent";
import {
  requireSessionExecution,
  type SessionExecutionAdmission,
} from "../../actors/session-execution-admission";
import type {
  CommerceToolReads,
  PreparedCommerceRead,
} from "../../commerce/contract/tool-reads";

const SUPPLY_COST_TERMS_SCOPE = "supply-cost-terms:shop";
const LOT_INVOICE_COST_SCOPE = "bakery-lot-invoice-cost:shop";
const BAKERY_COST_PLAN_SCOPE = "bakery-cost-plan:shop";
const COSTS_SHEET_DRAFT_SCOPE = "costs-sheet:shop";

type SessionCostsStaffWork = Readonly<{
  merchantId: string;
  userId: string;
  personId: string;
  client: CommerceAdminClient;
}>;

/**
 * What the costs tools need from commerce for one turn. Commerce gives it,
 * and the Worker passes it, so Kitchen imports no file of commerce here.
 */
export type CostsCommerce = CommerceToolReads &
  Readonly<{
  /** Prepares one commerce read of this turn for the grant that is selected. */
  prepareRead(
    selectGrant: (
      input: Parameters<CommerceToolReads["selectMerchantReportSourceGrant"]>[3],
    ) => ReturnType<CommerceToolReads["selectMerchantReportSourceGrant"]>,
    label: string,
  ): Promise<PreparedCommerceRead>;
  /**
   * The Commerce clients of one person of the Organisation, behind this
   * turn's admission. Null when Commerce is not configured.
   */
  adminClient(actor: string): CommerceAdminClient | null;
  entityPlaneClient(actor: string): CommerceEntityPlaneClient | null;
}>;

type SessionCostsHost = Readonly<{
  database: OrganisationDatabase;
  organisationId: string;
  commerce: CostsCommerce;
  requireExecution: () => Promise<void>;
  readSheetDraftCells: () => Promise<readonly CostsSheetCell[]>;
  editSheetDraft: (
    request: CostsSheetEditRequest,
    operationId: string,
    boundary: CatalogExecutionContext,
  ) => Promise<ToolEffect<CostsSheetEditResult>>;
  settleSavedCells: (cellKeys: readonly string[], nowMs: number) => Promise<void>;
  prepareCostsReads: (includeActuals?: boolean) => Promise<
    Readonly<{
      merchantId: string;
      personId: string;
      admitObservations: (
        value: CostsToolRead,
        merchantRevision: number,
      ) => Promise<void>;
    }>
  >;
  runStaffEffect: (
    effect: Readonly<{
      label: string;
      scope: string;
      draftName: string;
      operation: string;
      body: unknown;
      operationId: string;
      result: string;
      refreshProjection: boolean;
      run: (
        work: SessionCostsStaffWork,
        idempotencyKey: string,
      ) => Promise<string | null>;
    }>,
  ) => Promise<ToolEffect<StaffPageToolReceipt>>;
}>;

export function embeddedHarnessCostsTools(
  env: Env,
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
  commerce: CostsCommerce,
): Readonly<{
  readCosts: CostsReadTool;
  saveSupplyCost: SupplyCostSaveTool;
  saveLotCost: LotCostSaveTool;
  saveCostsPlan: CostsPlanSaveTool;
  editCostsSheet: CostsSheetEditTool;
}> {
  const organisationId = execution.scope.organisationId;
  return createEmbeddedHarnessCostsTools({
    database: execution.scope.database,
    organisationId: String(organisationId),
    commerce,
    requireExecution: requireSessionExecution.bind(null, execution, lease),
    readSheetDraftCells: async () => {
      try {
        const organisation = await requireActiveOrganisationActorAtPlacement({
          env,
          organisationId,
          placement: execution.scope.placement,
          now: Date.now(),
        });
        const draft = await organisation.readCostsSheetDraft({ organisationId });
        if (!draft.ok) {
          return [];
        }
        return draft.value.cells.filter(
          (cell) => cell.cellKey !== META_SAVED_AT_CELL_KEY,
        );
      } catch {
        return [];
      }
    },
    editSheetDraft: async (request, operationId, boundary) => {
      const deadlineAt = collaborationEditDeadline(
        storage,
        lease,
        boundary,
        Date.now(),
      );
      await requireSessionExecution(execution, lease);
      const member = await collaborationMember(
        execution.scope.database,
        organisationId,
        lease,
        "edit",
      );
      return {
        kind: "shared_draft",
        member,
        unavailable: "costs sheet information-flow authority unavailable",
        draft: {
          shared: "every_member",
          edit: {
            draft: "Costs sheet",
            capabilityId: CAPABILITY_KEYS.commerceSupplyCostSave,
            integrationAccountId: "platform",
            resourceScope: COSTS_SHEET_DRAFT_SCOPE,
          },
        },
        run: async () => {
          const active = preflightHarnessTurnLease(storage, lease, Date.now());
          if (!active.ok) {
            throw new Error(
              `Costs sheet edit authority expired: ${active.error.code}`,
            );
          }
          const organisation = await requireActiveOrganisationActorAtPlacement({
            env,
            organisationId,
            placement: execution.scope.placement,
            now: Date.now(),
          });
          await requireSessionExecution(execution, lease);
          const firstCellKey = request.changes[0]?.cellKey ?? OVERHEAD_LABOR_CELL_KEY;
          const result = await organisation.editCostsSheetDraft({
            agent: await resolveCollaborationAgent(execution.scope, assignment),
            execution: sessionTurnExecution(lease),
            organisationId,
            changes: request.changes,
            targetCellKey: firstCellKey,
            operationId: JSON.stringify([
              lease.session.sessionId,
              lease.turn.turnId,
              operationId,
            ]),
            userId: member.userId,
            deadlineAt,
          });
          if (!result.ok) {
            throw new Error(`Costs sheet edit failed: ${result.error.code}`);
          }
          await requireSessionExecution(execution, lease);
          return {
            documentId: "costs-sheet",
            revision: result.value.revision,
            generation: result.value.generation,
            cells: result.value.cells.filter(
              (cell) => cell.cellKey !== META_SAVED_AT_CELL_KEY,
            ),
          };
        },
      };
    },
    settleSavedCells: async (cellKeys, nowMs) => {
      try {
        const member = await liveDeviceMember(
          execution.scope.database,
          organisationId,
          lease,
        );
        if (member === null) {
          return;
        }
        const organisation = await requireActiveOrganisationActorAtPlacement({
          env,
          organisationId,
          placement: execution.scope.placement,
          now: nowMs,
        });
        await organisation.settleCostsSheetDraft({
          organisationId,
          cellKeys,
          savedAtMs: nowMs,
          userId: member.userId,
          origin: {
            kind: "session_turn",
            execution: sessionTurnExecution(lease),
            agent: await resolveCollaborationAgent(execution.scope, assignment),
            operationId: JSON.stringify([
              lease.session.sessionId,
              lease.turn.turnId,
              "settle",
              ...cellKeys,
            ]),
          },
        });
      } catch {
        // Best-effort live room settlement after committed save.
      }
    },
    prepareCostsReads: async (includeActuals = false) => {
      await requireSessionExecution(execution, lease);
      const member = await liveDeviceMember(
        execution.scope.database,
        organisationId,
        lease,
      );
      if (member === null) {
        throw new StaffPageRequestError(
          "Only a member of this workspace can read its costs and margins. Nothing was read. Tell the person.",
        );
      }
      const requiredReads = includeActuals
        ? ([
            "recipe_revision",
            "offer",
            "inventory_position",
            "order",
          ] as const)
        : ([
            "recipe_revision",
            "offer",
            "inventory_position",
          ] as const);
      const preparedReads: PreparedCommerceRead[] = [];
      const missingReads: (typeof requiredReads)[number][] = [];
      let firstDenied: CommerceReadRequestError | null = null;
      for (const read of requiredReads) {
        try {
          preparedReads.push(
            await commerce.prepareRead(
              commerce.selectMerchantReportSourceGrant.bind(
                null,
                lease,
                read,
                "internal",
              ),
              "costs",
            ),
          );
        } catch (error) {
          if (
            error instanceof CommerceReadRequestError &&
            error.failure.code === "commerce_context_authority_denied"
          ) {
            missingReads.push(read);
            firstDenied ??= error;
            continue;
          }
          throw error;
        }
      }
      if (firstDenied !== null) {
        throw new CommerceReadRequestError(firstDenied.failure, missingReads);
      }
      const primary = preparedReads[0];
      if (primary === undefined) {
        throw new Error("costs read unprepared");
      }
      return {
        merchantId: primary.merchantId,
        personId: String(member.personId),
        admitObservations: async (value, merchantRevision) => {
          for (const prepared of preparedReads) {
            await commerce.admitCommerceReadObservation(
              storage,
              lease,
              prepared,
              value,
              merchantRevision,
              "costs",
            );
          }
        },
      };
    },
    runStaffEffect: async (effect) => {
      const work = await commerce.prepareStaffPageWork(
        env,
        execution,
        lease,
        assignment,
        "recipe_revision",
        effect.label,
      );
      return {
        kind: "staff_page",
        work,
        unavailable: `${effect.label} information-flow authority unavailable`,
        effect: {
          sink: {
            kind: "tool_effect" as const,
            destinationAuthority: lease.requestAuthority,
            capabilityId: CAPABILITY_KEYS.commerceSupplyCostSave,
            integrationAccountId: "platform",
            resourceScope: effect.scope,
            approvalSatisfied: false,
          },
          route: `/v1/control/organisations/${organisationId}/commerce/costs`,
          operation: effect.operation,
          body: effect.body,
          operationId: effect.operationId,
          result: effect.result,
          run: (key) =>
            effect.run(
              {
                merchantId: work.context.merchantId,
                userId: work.member.userId,
                personId: String(work.member.personId),
                client: work.context.client,
              },
              key,
            ),
          settled: effect.refreshProjection
            ? commerce.refreshRecipeProjection.bind(null, env, execution, work)
            : () => Promise.resolve(),
        },
        content: {
          member: work.member,
          edit: {
            draft: effect.draftName,
            capabilityId: CAPABILITY_KEYS.commerceSupplyCostSave,
            integrationAccountId: "platform",
            resourceScope: effect.scope,
          },
        },
      };
    },
  });
}

function createEmbeddedHarnessCostsTools(
  host: SessionCostsHost,
): Readonly<{
  readCosts: CostsReadTool;
  saveSupplyCost: SupplyCostSaveTool;
  saveLotCost: LotCostSaveTool;
  saveCostsPlan: CostsPlanSaveTool;
  editCostsSheet: CostsSheetEditTool;
}> {
  return {
    readCosts: (request) => readCostsForSession(host, request),
    saveSupplyCost: (request, operationId) =>
      saveSupplyCostForSession(host, request, operationId),
    saveLotCost: (request, operationId) =>
      saveLotCostForSession(host, request, operationId),
    saveCostsPlan: (request, operationId) =>
      saveCostsPlanForSession(host, request, operationId),
    editCostsSheet: (request, operationId, boundary) =>
      host.editSheetDraft(request, operationId, boundary),
  };
}

async function readCostsForSession(
  host: SessionCostsHost,
  request: CostsReadRequest,
): Promise<CostsToolRead> {
  const actualsWindowDays =
    request.actualsWindowDays === 7 || request.actualsWindowDays === 30
      ? request.actualsWindowDays
      : null;
  const prepared = await host.prepareCostsReads(actualsWindowDays !== null);
  const adminClient = host.commerce.adminClient(prepared.personId);
  const entityPlaneClient = host.commerce.entityPlaneClient(prepared.personId);
  if (adminClient === null || entityPlaneClient === null) {
    throw new Error("costs Commerce unavailable");
  }

  const [overview, draftCells] = await Promise.all([
    readCostsOverview({
      adminClient,
      entityPlaneClient,
      organisationId: host.organisationId,
      merchantId: prepared.merchantId,
      nowMs: Date.now(),
      db: host.database,
    }),
    host.readSheetDraftCells(),
  ]);
  await host.requireExecution();
  if (!overview.ok) {
    throw new Error("costs overview unavailable");
  }

  const defaults = defaultCostAssumptions(overview.value);
  const dailyTargets: Record<string, number> = {};
  if (request.dailyTargets !== null) {
    for (const target of request.dailyTargets) {
      dailyTargets[target.targetId] = target.unitsPerDay;
    }
  }
  const hasExplicitDailyTargets = request.dailyTargets !== null;
  const calculation = calculateBakeryCostsAndMargins({
    overview: overview.value,
    ...(hasExplicitDailyTargets ? { dailyTargets } : {}),
    assumptions: {
      bakeShelfWastePct:
        request.bakeShelfWastePct ?? defaults.bakeShelfWastePct,
      prepRejectPct: request.prepRejectPct ?? defaults.prepRejectPct,
      channelFeeBps: request.channelFeeBps ?? defaults.channelFeeBps,
      includedTaxBps: request.includedTaxBps ?? defaults.includedTaxBps,
      applyBulkTiers: request.applyBulkTiers ?? defaults.applyBulkTiers,
      lotCostBasis: request.lotCostBasis ?? defaults.lotCostBasis,
    },
  });

  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const usageByItemId = new Map(
    calculation.supplies.map((usage) => [usage.inventoryItemId, usage]),
  );
  const reorderSupplyCount = calculation.supplies.filter(
    (usage) => usage.reorderSuggested,
  ).length;
  const includeTargetedBom =
    request.dailyTargets !== null &&
    request.dailyTargets.length > 0 &&
    request.dailyTargets.length <= 8;
  const isTargetedProduct = (
    product: (typeof calculation.products)[number],
  ): boolean =>
    Object.hasOwn(dailyTargets, product.productId) ||
    (product.recipeId !== null && Object.hasOwn(dailyTargets, product.recipeId));
  const summary: CostsToolRead["summary"] = {
    ...calculation.summary,
    ...(reorderSupplyCount > 0 ? { reorderSupplyCount } : {}),
    dailyIngredientSpendMinor: round2(
      calculation.summary.dailyIngredientSpendMinor,
    ),
    dailyPackagingSpendMinor: round2(
      calculation.summary.dailyPackagingSpendMinor,
    ),
    dailyWasteSpendMinor: round2(calculation.summary.dailyWasteSpendMinor),
    dailyChannelFeeMinor: round2(calculation.summary.dailyChannelFeeMinor),
    dailyTierSavingsMinor: round2(calculation.summary.dailyTierSavingsMinor),
    dailyNetContributionMinor: round2(
      calculation.summary.dailyNetContributionMinor,
    ),
    netMarginPct: round2(calculation.summary.netMarginPct),
    netMarginExTaxPct: round2(calculation.summary.netMarginExTaxPct),
    dailyOperatingProfitMinor: round2(
      calculation.summary.dailyOperatingProfitMinor,
    ),
    operatingMarginPct: round2(calculation.summary.operatingMarginPct),
    monthlyGrossRevenueMinor: round2(
      calculation.summary.monthlyGrossRevenueMinor,
    ),
    monthlyNetContributionMinor: round2(
      calculation.summary.monthlyNetContributionMinor,
    ),
    monthlyOperatingProfitMinor: round2(
      calculation.summary.monthlyOperatingProfitMinor,
    ),
  };

  const linkedRecipeIds = new Set(
    calculation.products
      .map((product) => product.recipeId)
      .filter((id): id is string => id !== null),
  );

  const allLots = overview.value.lots ?? [];
  const itemsWithPricedLots = new Set(
    allLots
      .filter((lot) => lot.invoiceCost !== null)
      .map((lot) => lot.inventoryItemId),
  );
  const lots = allLots
    .filter(
      (lot) =>
        lot.invoiceCost !== null || itemsWithPricedLots.has(lot.inventoryItemId),
    )
    .map((lot) => ({
      id: lot.id,
      inventoryItemId: lot.inventoryItemId,
      lotCode: lot.lotCode,
      receivedAt: lot.receivedAt,
      remainingQuantity: round2(lot.remainingQuantity),
      baseUnit: lot.baseUnit,
      lifecycle: lot.lifecycle,
      invoiceCost:
        lot.invoiceCost === null
          ? null
          : {
              revision: lot.invoiceCost.revision,
              currency: lot.invoiceCost.currency,
              invoicedQuantity: lot.invoiceCost.invoicedQuantity,
              invoicedUnit: lot.invoiceCost.invoicedUnit,
              invoiceTotalMinor: lot.invoiceCost.invoiceTotalMinor,
              invoiceReference: lot.invoiceCost.invoiceReference,
              supplierId: lot.invoiceCost.supplierId,
            },
    }));
  const actualsResult =
    actualsWindowDays !== null
      ? calculateBakeryPlanVsActuals({
          overview: overview.value,
          windowDays: actualsWindowDays,
          assumptions: calculation.assumptions,
        })
      : null;
  const actualsProducts =
    actualsResult !== null
      ? [...actualsResult.products]
          .filter(
            (row) =>
              row.actualUnitsSold > 0 ||
              row.stockedUnitsWasted > 0 ||
              row.batchCount > 0 ||
              Math.abs(row.profitDeltaMinor) >= 1,
          )
          .sort(
            (left, right) =>
              Math.abs(right.profitDeltaMinor) -
                Math.abs(left.profitDeltaMinor) ||
              left.productId.localeCompare(right.productId),
          )
          .slice(0, 16)
      : [];
  const selectedActualsProducts =
    actualsResult !== null
      ? (actualsProducts.length > 0
          ? actualsProducts
          : actualsResult.products.slice(0, 12)
        ).map((row) => ({
          productId: row.productId,
          title: row.productTitle,
          plannedUnits: row.plannedUnits,
          actualUnitsSold: row.actualUnitsSold,
          volumeDeltaUnits: row.volumeDeltaUnits,
          theoreticalUnitCogsMinor: row.theoreticalUnitCogsMinor,
          actualUnitCogsMinor: row.actualUnitCogsMinor,
          plannedWastePct: row.plannedWastePct,
          actualWastePct: row.actualWastePct,
          plannedMarginPct: row.plannedMarginPct,
          actualMarginPct: row.actualMarginPct,
          profitDeltaMinor: row.profitDeltaMinor,
          statusTone: row.statusTone,
          primaryNote: row.primaryNote,
        }))
      : [];

  const forecastScenario = request.forecast ?? null;
  let forecastOverrides: Partial<CostForecastPlan> | undefined;
  if (forecastScenario !== null) {
    forecastOverrides = {
      ...(forecastScenario.openingCashMinor != null
        ? { openingCashMinor: forecastScenario.openingCashMinor }
        : {}),
      ...(forecastScenario.demandCurve != null
        ? { demandCurve: forecastScenario.demandCurve }
        : {}),
      ...(forecastScenario.supplierTerms != null
        ? { supplierTerms: forecastScenario.supplierTerms }
        : {}),
      ...(forecastScenario.extraShiftThresholdPct != null
        ? { extraShiftThresholdPct: forecastScenario.extraShiftThresholdPct }
        : {}),
      ...(forecastScenario.extraShiftWeeklyMinor != null
        ? { extraShiftWeeklyMinor: forecastScenario.extraShiftWeeklyMinor }
        : {}),
      ...(forecastScenario.capexMinor != null
        ? { capexMinor: forecastScenario.capexMinor }
        : {}),
    };
  }
  const forecastResult =
    forecastScenario !== null
      ? calculateBakery12WeekForecast({
          overview: {
            ...overview.value,
            ...(actualsWindowDays === null ? { actuals: undefined } : {}),
          },
          ...(forecastOverrides !== undefined
            ? { forecastPlan: forecastOverrides }
            : {}),
          assumptions: calculation.assumptions,
        })
      : null;

  const value: CostsToolRead = {
    currency: overview.value.currency,
    merchantRevision: overview.value.merchantRevision,
    defaultIncludedTaxBps: overview.value.defaultIncludedTaxBps,
    includedTaxSource: overview.value.includedTaxSource,
    measuredWaste: overview.value.measuredWaste,
    costPlan: overview.value.costPlan,
    assumptions: calculation.assumptions,
    summary,
    supplies: overview.value.items
      .filter((item) => item.category !== "finished_good")
      .map((item) => {
        const usage = usageByItemId.get(item.id);
        return {
          id: item.id,
          name: item.name,
          category: item.category,
          baseUnit: item.baseUnit,
          expectedEntryRevision: item.costTerms?.entryRevision ?? null,
          ...(item.costTerms !== null
            ? {
                packQty: item.costTerms.packQuantity,
                packUnit: item.costTerms.packUnit,
                packPriceMinor: item.costTerms.packPriceMinor,
              }
            : {}),
          ...(item.costTerms?.bulkTier !== null &&
          item.costTerms?.bulkTier !== undefined
            ? { bulkTier: item.costTerms.bulkTier }
            : {}),
          dailyQty: round2(usage?.dailyBaseUsage ?? 0),
          sevenDayQty: round2(usage?.sevenDayBaseUsage ?? 0),
          dailyCostMinor: Math.round(usage?.dailySpendMinor ?? 0),
          ...(includeTargetedBom && usage?.daysOfSupply != null
            ? { daysOfSupply: Math.round(usage.daysOfSupply * 10) / 10 }
            : {}),
          ...(includeTargetedBom && usage?.reorderSuggested === true
            ? { reorderSuggested: true as const }
            : {}),
          ...(includeTargetedBom &&
          (usage?.usedInProductCount ?? 0) > 0 &&
          usage !== undefined
            ? { usedInProductCount: usage.usedInProductCount }
            : {}),
          ...(usage?.bulkUnlocked === true ? { bulkUnlocked: true as const } : {}),
          ...(usage !== undefined && usage.pricedLotCount > 0
            ? {
                costSource: usage.costSource,
                activeLotCount: usage.activeLotCount,
                pricedLotCount: usage.pricedLotCount,
                fifoEquivalentPackPriceMinor:
                  usage.fifoEquivalentPackPriceMinor === null
                    ? null
                    : round2(usage.fifoEquivalentPackPriceMinor),
                weightedEquivalentPackPriceMinor:
                  usage.weightedEquivalentPackPriceMinor === null
                    ? null
                    : round2(usage.weightedEquivalentPackPriceMinor),
                lotCostVariancePct:
                  usage.lotCostVariancePct === null
                    ? null
                    : round2(usage.lotCostVariancePct),
                ...(usage.weeklyLotVarianceImpactMinor !== null &&
                Math.round(usage.weeklyLotVarianceImpactMinor) !== 0
                  ? {
                      weeklyLotVarianceImpactMinor: Math.round(
                        usage.weeklyLotVarianceImpactMinor,
                      ),
                    }
                  : {}),
              }
            : {}),
        };
      }),
    ...(lots.length > 0 ? { lots } : {}),
    products: ((actualsResult !== null || forecastResult !== null) &&
    !hasExplicitDailyTargets
      ? []
      : includeTargetedBom
        ? calculation.products.filter(isTargetedProduct)
        : calculation.products
    ).map((product) => ({
      productId: product.productId,
      title: product.productTitle,
      kind: product.fulfillmentKind,
      ...(product.fulfillmentKind === "stocked"
        ? {
            batchYield: round2(product.batchYield),
            spoilPct: round2(product.effectiveSpoilagePct),
          }
        : {}),
      weekUnits: product.weekUnits,
      targetUnits: product.dailyTargetUnits,
      ...(product.fulfillmentKind === "stocked"
        ? { batchesPerDay: product.batchesPerDay }
        : {}),
      producedUnits: round2(product.producedUnits),
      priceMinor: product.grossPriceMinor,
      ...(includeTargetedBom
        ? { bomUnitCostMinor: round2(product.bomUnitCostMinor) }
        : {}),
      unitCostMinor: round2(product.allInUnitCostMinor),
      marginPct: round2(product.netMarginPct),
      dailyMarginMinor: Math.round(product.dailyNetContributionMinor),
      ...(includeTargetedBom && product.bomLines.length > 0
        ? {
            bomLines: product.bomLines.map((line) => ({
              itemId: line.inventoryItemId,
              qtyPerUnit: round2(line.quantityPerUnit),
              unit: line.unit,
              unitCostMinor: round2(line.costPerUnitMinor),
            })),
          }
        : {}),
      ...(product.missingCostItemIds.length > 0
        ? { missingCosts: product.missingCostItemIds }
        : {}),
    })),
    unlinkedRecipes: calculation.recipes
      .filter((recipe) => !linkedRecipeIds.has(recipe.recipeId))
      .map((recipe) => ({
        recipeId: recipe.recipeId,
        name: recipe.name,
        outputKind: recipe.outputKind,
        batchYield: round2(recipe.batchYield),
        totalBatchCostMinor: round2(recipe.totalBatchCostMinor),
        rawUnitCostMinor: round2(recipe.rawUnitCostMinor),
      })),
    ...(actualsResult !== null
      ? {
          actuals: {
            windowDays: actualsResult.windowDays,
            summary: actualsResult.summary,
            drivers: actualsResult.drivers,
            products: selectedActualsProducts,
          },
        }
      : {}),
    ...(forecastResult !== null
      ? {
          forecast: {
            summary: forecastResult.summary,
            weeks: forecastResult.weeks.map((w) => ({
              weekCode: w.weekCode,
              demandIndexPct: w.demandIndexPct,
              grossSalesMinor: w.grossSalesMinor,
              cogsMinor: w.cogsMinor,
              laborMinor: w.laborMinor,
              ...(w.extraShiftActive ? { extraShiftActive: true as const } : {}),
              ...(w.extraBulkTiersUnlocked > 0
                ? { extraBulkTiersUnlocked: w.extraBulkTiersUnlocked }
                : {}),
              operatingProfitMinor: w.operatingProfitMinor,
              lumpOutflowMinor: w.lumpOutflowMinor,
              endingCashMinor: w.endingCashMinor,
            })),
          },
        }
      : {}),
    ...(draftCells.length > 0 ? { draftCells } : {}),
  };

  await prepared.admitObservations(value, overview.value.merchantRevision);
  return value;
}

async function saveSupplyCostForSession(
  host: SessionCostsHost,
  request: SupplyCostSaveRequest,
  operationId: string,
): Promise<ToolEffect<StaffPageToolReceipt>> {
  return host.runStaffEffect({
    label: "supply cost",
    scope: SUPPLY_COST_TERMS_SCOPE,
    draftName: "Supply cost",
    operation: "supply_cost.save",
    body: request,
    operationId,
    result:
      "The supplier pack price is saved. Stock counts and live menu prices did not change. Call costs_read to see the updated costs and margins.",
    refreshProjection: true,
    run: async (work, key) => {
      const entityPlaneClient = host.commerce.entityPlaneClient(work.personId);
      if (entityPlaneClient === null) {
        throw new Error("supply cost Commerce unavailable");
      }
      const nowMs = Date.now();
      const saved = await saveSupplyCostTerms({
        adminClient: work.client,
        entityPlaneClient,
        organisationId: host.organisationId,
        merchantId: work.merchantId,
        principalId: work.userId,
        idempotencyKey: key,
        write: {
          merchantRevision: 0,
          requestedAt: new Date(nowMs).toISOString(),
          inventoryItemId: request.inventoryItemId,
          expectedEntryRevision: request.expectedEntryRevision,
          currency: request.currency,
          packQuantity: request.packQuantity,
          packUnit: request.packUnit,
          packPriceMinor: request.packPriceMinor,
          supplierId: request.supplierId,
          bulkTier: request.bulkTier,
          notes: request.notes,
        },
        nowMs,
      });
      const refusal = supplyCostSaveRefusal(saved);
      if (refusal === null) {
        await host.settleSavedCells(
          [
            supplyFieldCellKey(request.inventoryItemId, "packQuantity"),
            supplyFieldCellKey(request.inventoryItemId, "packUnit"),
            supplyFieldCellKey(request.inventoryItemId, "packPriceMajor"),
            supplyFieldCellKey(request.inventoryItemId, "bulkMin7dQuantity"),
            supplyFieldCellKey(request.inventoryItemId, "bulkPackQuantity"),
            supplyFieldCellKey(request.inventoryItemId, "bulkPackPriceMajor"),
          ],
          nowMs,
        );
      }
      return refusal;
    },
  });
}

async function saveCostsPlanForSession(
  host: SessionCostsHost,
  request: CostsPlanSaveRequest,
  operationId: string,
): Promise<ToolEffect<StaffPageToolReceipt>> {
  return host.runStaffEffect({
    label: "cost plan",
    scope: BAKERY_COST_PLAN_SCOPE,
    draftName: "Bakery cost plan",
    operation: "costs.plan.save",
    body: request,
    operationId,
    result:
      "The bakery cost plan is saved. Live stock and buyer-facing menu prices did not change. Call costs_read to see the updated daily profit and break-even units.",
    refreshProjection: false,
    run: async (work) => {
      const snapshot = await work.client.readStockSnapshot(work.merchantId);
      if (!snapshot.ok) {
        throw new Error("cost plan Commerce unavailable");
      }
      if (snapshot.value.commerce.merchantId !== work.merchantId) {
        throw new Error("cost plan Commerce scope mismatch");
      }
      const knownProductIds = new Set(
        snapshot.value.commerce.resources.products
          .filter((product) => product.status === "active")
          .map((product) => product.id),
      );
      const nowMs = Date.now();
      const saved = await saveOrganisationCostPlan({
        db: host.database,
        organisationId: host.organisationId,
        updatedBy: work.userId,
        nowMs,
        expectedPlanRevision: request.expectedPlanRevision,
        dailyLaborMinor: request.dailyLaborMinor,
        dailyRentMinor: request.dailyRentMinor,
        products: request.products ?? [],
        ...(request.forecast !== undefined ? { forecast: request.forecast } : {}),
        replaceAllProducts: false,
        knownProductIds,
      });
      const refusal = costPlanSaveRefusal(saved);
      if (refusal === null) {
        const keys: string[] = [SCENARIO_PRESET_CELL_KEY];
        if (request.dailyLaborMinor !== null) {
          keys.push(OVERHEAD_LABOR_CELL_KEY);
        }
        if (request.dailyRentMinor !== null) {
          keys.push(OVERHEAD_RENT_CELL_KEY);
        }
        if (request.forecast !== undefined) {
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
        for (const entry of request.products ?? []) {
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
        await host.settleSavedCells(keys, nowMs);
      }
      return refusal;
    },
  });
}

function supplyCostSaveRefusal(saved: SupplyCostSaveResult): string | null {
  if (saved.ok) {
    return null;
  }
  switch (saved.code) {
    case "commerce_unavailable":
    case "commerce_scope_mismatch":
      throw new Error("supply costs unavailable");
    case "supply_cost_changed":
      return "That item's supplier pack price changed after you read it, so this save would lose the other change. Nothing changed. Call costs_read, and tell the person what you see before you save again.";
    case "supply_cost_invalid":
    case "supply_cost_unit_mismatch":
      return `${saved.detail} Nothing changed. Check the item's baseUnit in costs_read, and correct the unit or ask the person.`;
    case "supply_cost_busy":
      return "The shop is too busy to take this save now. Try again in a moment.";
    default:
      return assertNever(saved);
  }
}

function costPlanSaveRefusal(saved: CostPlanSaveResult): string | null {
  if (saved.ok) {
    return null;
  }
  switch (saved.code) {
    case "cost_plan_changed":
      return "The shop's cost plan changed after you read it, so this save would overwrite another member's update. Nothing changed. Call costs_read to inspect the latest costPlan.revision before saving again.";
    case "cost_plan_invalid":
      return `${saved.detail} Nothing changed. Check the active productId values in costs_read before saving again.`;
    default:
      return assertNever(saved);
  }
}

async function saveLotCostForSession(
  host: SessionCostsHost,
  request: LotCostSaveRequest,
  operationId: string,
): Promise<ToolEffect<StaffPageToolReceipt>> {
  return host.runStaffEffect({
    label: "lot invoice cost",
    scope: LOT_INVOICE_COST_SCOPE,
    draftName: "Lot invoice cost",
    operation: "lot_cost.save",
    body: request,
    operationId,
    result:
      "The received lot's purchase invoice cost is saved. Stock counts and live menu prices did not change. Call costs_read with lotCostBasis 'fifo_lot' or 'weighted_lot' to see the updated costs and margins.",
    refreshProjection: false,
    run: async (work) => {
      const snapshot = await work.client.readStockSnapshot(work.merchantId);
      if (!snapshot.ok) {
        throw new Error("lot cost Commerce unavailable");
      }
      if (snapshot.value.commerce.merchantId !== work.merchantId) {
        throw new Error("lot cost Commerce scope mismatch");
      }
      const itemsById = new Map(
        snapshot.value.commerce.resources.inventoryItems.map((item) => [
          item.id,
          item,
        ]),
      );
      const knownLotsById = new Map<
        string,
        Readonly<{ inventoryItemId: string; baseUnit: CostUnit }>
      >();
      for (const lot of snapshot.value.lots) {
        const item = itemsById.get(lot.inventoryItemId);
        if (item === undefined || item.category === "finished_good") {
          continue;
        }
        knownLotsById.set(lot.id, {
          inventoryItemId: lot.inventoryItemId,
          baseUnit: item.baseUnit,
        });
      }
      const nowMs = Date.now();
      const saved = await saveOrganisationLotInvoiceCost({
        db: host.database,
        organisationId: host.organisationId,
        updatedBy: work.userId,
        nowMs,
        write: request,
        knownLotsById,
      });
      const refusal = lotCostSaveRefusal(saved);
      if (refusal === null) {
        await host.settleSavedCells(
          [
            lotInvoiceFieldCellKey(request.lotId, "invoiceReference"),
            lotInvoiceFieldCellKey(request.lotId, "invoiceTotalMajor"),
          ],
          nowMs,
        );
      }
      return refusal;
    },
  });
}

function lotCostSaveRefusal(saved: LotCostSaveResult): string | null {
  if (saved.ok) {
    return null;
  }
  switch (saved.code) {
    case "lot_cost_changed":
      return "That lot's purchase invoice cost changed after you read it, so this save would overwrite another member's update. Nothing changed. Call costs_read to inspect the latest lot invoice revision before saving again.";
    case "lot_cost_invalid":
    case "lot_cost_unit_mismatch":
      return `${saved.detail} Nothing changed. Check costs_read.lots and the item's baseUnit before saving again.`;
    default:
      return assertNever(saved);
  }
}
