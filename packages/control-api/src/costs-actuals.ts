import {
  calculateBakeryCostsAndMargins,
  defaultCostAssumptions,
  type ActualsWindowDays,
  type CalculatedProductBomLine,
  type CostScenarioAssumptions,
  type CostUnit,
  type CostsActualsWindowSnapshot,
  type CostsOverview,
  type OrganisationCostPlan,
  type ProductActualsObservation,
  type SupplyLotCost,
} from "./costs.ts";

export type PlanVsActualComparisonMode =
  | "orders_and_costs"
  | "costs_and_waste_only";

export type PlanVsActualStatusTone =
  | "leak"
  | "watch"
  | "surplus"
  | "on_plan"
  | "no_activity";

export type PlanVsActualVarianceDriver = Readonly<{
  id: string;
  kind: "lot_invoice" | "product_waste" | "supply_loss" | "volume_mix";
  label: string;
  detail: string;
  profitImpactMinor: number;
  productId: string | null;
  inventoryItemId: string | null;
}>;

export type ProductPlanVsActualRow = Readonly<{
  productId: string;
  productTitle: string;
  productType: string;
  fulfillmentKind: "stocked" | "prepared";
  imageUrl: string | null;
  currency: string;
  recipeId: string | null;
  recipeRevision: number | null;
  batchYield: number;
  grossPriceMinor: number;
  plannedUnits: number;
  actualUnitsSold: number;
  posUnitsSold: number;
  onlineUnitsSold: number;
  volumeDeltaUnits: number;
  plannedGrossSalesMinor: number;
  actualGrossSalesMinor: number;
  actualNetExTaxSalesMinor: number;
  theoreticalUnitCogsMinor: number;
  actualUnitCogsMinor: number;
  unitCogsDeltaMinor: number;
  plannedCogsMinor: number;
  actualCogsMinor: number;
  batchCount: number;
  plannedBatchUnits: number;
  actualBatchUnits: number;
  stockedUnitsProduced: number;
  stockedUnitsWasted: number;
  allocatedSupplyLossMinor: number;
  plannedWastePct: number;
  actualWastePct: number | null;
  plannedWasteMinor: number;
  actualWasteMinor: number;
  plannedMarginPct: number;
  actualMarginPct: number | null;
  plannedContributionMinor: number;
  actualContributionMinor: number;
  profitDeltaMinor: number;
  statusTone: PlanVsActualStatusTone;
  primaryNote: string;
  bomLines: readonly CalculatedProductBomLine[];
}>;

export type PlanVsActualSummary = Readonly<{
  currency: string;
  windowDays: ActualsWindowDays;
  windowStartAt: string | null;
  windowEndAt: string | null;
  comparisonMode: PlanVsActualComparisonMode;
  orderCount: number;
  posOrderCount: number;
  onlineOrderCount: number;
  plannedUnitsSold: number;
  actualUnitsSold: number;
  volumeDeltaUnits: number;
  plannedGrossSalesMinor: number;
  actualGrossSalesMinor: number;
  actualRefundsMinor: number;
  actualNetSalesMinor: number;
  salesDeltaMinor: number;
  salesDeltaPct: number | null;
  plannedCogsMinor: number;
  actualCogsMinor: number;
  cogsDeltaMinor: number;
  plannedCogsPctOfSales: number;
  actualCogsPctOfSales: number | null;
  plannedWasteMinor: number;
  actualWasteMinor: number;
  wasteDeltaMinor: number;
  plannedWastePctOfSales: number;
  actualWastePctOfSales: number | null;
  supplyLossMinor: number;
  plannedChannelFeeMinor: number;
  actualChannelFeeMinor: number;
  plannedFixedCostMinor: number;
  actualFixedCostMinor: number;
  settledPayablesMinor: number;
  openPayablesMinor: number;
  payableCount: number;
  plannedContributionMinor: number;
  actualContributionMinor: number;
  plannedOperatingProfitMinor: number;
  actualOperatingProfitMinor: number;
  operatingProfitDeltaMinor: number;
  plannedOperatingMarginPct: number;
  actualOperatingMarginPct: number | null;
}>;

export type BakeryPlanVsActualsCalculation = Readonly<{
  windowDays: ActualsWindowDays;
  summary: PlanVsActualSummary;
  drivers: readonly PlanVsActualVarianceDriver[];
  products: readonly ProductPlanVsActualRow[];
}>;

export type BakeryPlanVsActualsInput = Readonly<{
  overview: Pick<
    CostsOverview,
    | "currency"
    | "defaultIncludedTaxBps"
    | "recipes"
    | "items"
    | "products"
    | "measuredWaste"
  > & {
    readonly costPlan?: OrganisationCostPlan;
    readonly lots?: readonly SupplyLotCost[];
    readonly actuals?: CostsOverview["actuals"];
  };
  windowDays?: ActualsWindowDays;
  weeklyTargets?: Readonly<Record<string, readonly number[]>>;
  productSpoilagePctOverrides?: Readonly<Record<string, number>>;
  priceOverridesMinor?: Readonly<Record<string, number>>;
  cogsOverridesMinor?: Readonly<Record<string, number | null>>;
  wasteOverridesMinor?: Readonly<Record<string, number | null>>;
  productFormulas?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  dailyLaborMinor?: number;
  dailyRentMinor?: number;
  assumptions?: Partial<CostScenarioAssumptions>;
}>;

export function calculateBakeryPlanVsActuals(
  input: BakeryPlanVsActualsInput,
): BakeryPlanVsActualsCalculation {
  const windowDays: ActualsWindowDays = input.windowDays === 30 ? 30 : 7;
  const weekScale = windowDays / 7;
  const defaults = defaultCostAssumptions(input.overview);
  const baseAssumptions: CostScenarioAssumptions = {
    ...defaults,
    ...input.assumptions,
  };

  const sharedInput = {
    overview: input.overview,
    demandMode: "weekly" as const,
    ...(input.weeklyTargets !== undefined
      ? { weeklyTargets: input.weeklyTargets }
      : {}),
    ...(input.productSpoilagePctOverrides !== undefined
      ? { productSpoilagePctOverrides: input.productSpoilagePctOverrides }
      : {}),
    ...(input.priceOverridesMinor !== undefined
      ? { priceOverridesMinor: input.priceOverridesMinor }
      : {}),
    ...(input.cogsOverridesMinor !== undefined
      ? { cogsOverridesMinor: input.cogsOverridesMinor }
      : {}),
    ...(input.wasteOverridesMinor !== undefined
      ? { wasteOverridesMinor: input.wasteOverridesMinor }
      : {}),
    ...(input.productFormulas !== undefined
      ? { productFormulas: input.productFormulas }
      : {}),
    ...(input.dailyLaborMinor !== undefined
      ? { dailyLaborMinor: input.dailyLaborMinor }
      : {}),
    ...(input.dailyRentMinor !== undefined
      ? { dailyRentMinor: input.dailyRentMinor }
      : {}),
  };

  const standingCalc = calculateBakeryCostsAndMargins({
    ...sharedInput,
    assumptions: {
      ...baseAssumptions,
      lotCostBasis: "standing",
    },
  });

  const realizedLotBasis =
    baseAssumptions.lotCostBasis === "fifo_lot"
      ? "fifo_lot"
      : "weighted_lot";
  const realizedCalc = calculateBakeryCostsAndMargins({
    ...sharedInput,
    assumptions: {
      ...baseAssumptions,
      lotCostBasis: realizedLotBasis,
    },
  });

  const windowObs: CostsActualsWindowSnapshot | null =
    input.overview.actuals?.windows.find((w) => w.windowDays === windowDays) ??
    null;
  const obsByProductId = new Map<string, ProductActualsObservation>(
    (windowObs?.products ?? []).map((entry) => [entry.productId, entry]),
  );

  const standingByProductId = new Map(
    standingCalc.products.map((p) => [p.productId, p]),
  );
  const realizedSupplyById = new Map(
    realizedCalc.supplies.map((s) => [s.inventoryItemId, s]),
  );
  const standingSupplyById = new Map(
    standingCalc.supplies.map((s) => [s.inventoryItemId, s]),
  );

  const orderCount = windowObs?.orderCount ?? 0;
  const posOrderCount = windowObs?.posOrderCount ?? 0;
  const onlineOrderCount = windowObs?.onlineOrderCount ?? 0;
  const comparisonMode: PlanVsActualComparisonMode =
    orderCount > 0 ? "orders_and_costs" : "costs_and_waste_only";

  // Allocate direct ingredient/packaging waste movements across products using that supply.
  const supplyLossByProductId = new Map<string, number>();
  const drivers: PlanVsActualVarianceDriver[] = [];
  let totalSupplyLossMinor = 0;

  for (const loss of windowObs?.supplyLosses ?? []) {
    if (loss.wastedBaseQuantity <= 0) continue;
    const supply =
      realizedSupplyById.get(loss.inventoryItemId) ??
      standingSupplyById.get(loss.inventoryItemId);
    const rate = supply?.effectiveCostPerBaseUnitMinor ?? 0;
    if (rate <= 0 || supply === undefined) continue;
    const lossMinor = loss.wastedBaseQuantity * rate;
    totalSupplyLossMinor += lossMinor;

    drivers.push({
      id: `supply_loss:${loss.inventoryItemId}`,
      kind: "supply_loss",
      label: `${supply.name} supply loss`,
      detail: `${formatCompactQty(loss.wastedBaseQuantity, supply.baseUnit)} wasted across ${loss.movementCount} movement${loss.movementCount === 1 ? "" : "s"}`,
      profitImpactMinor: -Math.round(lossMinor),
      productId: null,
      inventoryItemId: loss.inventoryItemId,
    });

    // Weight by actual units sold * qtyPerUnit if any user product sold > 0, else planned units * qtyPerUnit.
    const consumers: Array<{ productId: string; weight: number }> = [];
    let sumActualWeight = 0;
    let sumPlannedWeight = 0;
    for (const prod of realizedCalc.products) {
      const line = prod.bomLines.find(
        (b) => b.inventoryItemId === loss.inventoryItemId,
      );
      if (line === undefined || line.quantityPerUnit <= 0) continue;
      const actualU = obsByProductId.get(prod.productId)?.unitsSold ?? 0;
      const plannedU =
        prod.weekUnits.reduce((acc, d) => acc + d, 0) * weekScale;
      sumActualWeight += actualU * line.quantityPerUnit;
      sumPlannedWeight += plannedU * line.quantityPerUnit;
      consumers.push({
        productId: prod.productId,
        weight: actualU * line.quantityPerUnit,
      });
    }
    if (consumers.length > 0) {
      for (const c of consumers) {
        const prod = realizedCalc.products.find(
          (p) => p.productId === c.productId,
        );
        const line = prod?.bomLines.find(
          (b) => b.inventoryItemId === loss.inventoryItemId,
        );
        const fallbackWeight =
          prod !== undefined && line !== undefined
            ? prod.weekUnits.reduce((acc, d) => acc + d, 0) *
              weekScale *
              line.quantityPerUnit
            : 0;
        const share =
          sumActualWeight > 0
            ? c.weight / sumActualWeight
            : sumPlannedWeight > 0
              ? fallbackWeight / sumPlannedWeight
              : 1 / consumers.length;
        supplyLossByProductId.set(
          c.productId,
          (supplyLossByProductId.get(c.productId) ?? 0) + lossMinor * share,
        );
      }
    }
  }

  // Track lot-invoice supply rate variance across actual (or planned) usage.
  const supplyInvoiceConsumptionBase = new Map<string, number>();

  const rows: ProductPlanVsActualRow[] = [];
  let sumPlannedUnits = 0;
  let sumActualUnits = 0;
  let sumPlannedGrossSalesMinor = 0;
  let sumActualLineGrossSalesMinor = 0;
  let sumPlannedCogsMinor = 0;
  let sumActualCogsMinor = 0;
  let sumPlannedWasteMinor = 0;
  let sumActualProductWasteMinor = 0;
  let sumPlannedChannelFeeMinor = 0;
  let sumPlannedContributionMinor = 0;
  let sumActualProductContributionMinor = 0;
  let totalVolumeMixImpactMinor = 0;
  let topVolumeSwing: {
    productId: string;
    productTitle: string;
    absImpact: number;
  } | null = null;

  const feeRate = standingCalc.assumptions.channelFeeBps / 10_000;

  for (const realizedProd of realizedCalc.products) {
    const standingProd =
      standingByProductId.get(realizedProd.productId) ?? realizedProd;
    const obs = obsByProductId.get(realizedProd.productId);
    const weekSum = realizedProd.weekUnits.reduce((acc, d) => acc + d, 0);
    const plannedUnits = Math.round(weekSum * weekScale);
    const actualUnitsSold = round2(obs?.unitsSold ?? 0);
    const posUnitsSold = round2(obs?.posUnitsSold ?? 0);
    const onlineUnitsSold = round2(obs?.onlineUnitsSold ?? 0);
    const volumeDeltaUnits = round2(actualUnitsSold - plannedUnits);

    const plannedGrossSalesMinor = plannedUnits * standingProd.grossPriceMinor;
    const plannedIncludedTaxMinor =
      plannedUnits * standingProd.includedTaxMinor;
    const plannedNetExTaxSalesMinor = Math.max(
      0,
      plannedGrossSalesMinor - plannedIncludedTaxMinor,
    );
    const plannedChannelFeeMinor = plannedGrossSalesMinor * feeRate;

    const theoreticalUnitCogsMinor = standingProd.hasCogsOverride
      ? standingProd.effectiveCogsUnitMinor
      : standingProd.bomUnitCostMinor;
    const actualUnitCogsMinor =
      realizedProd.bomLines.length > 0
        ? realizedProd.bomUnitCostMinor
        : realizedProd.effectiveCogsUnitMinor;
    const unitCogsDeltaMinor = round2(
      actualUnitCogsMinor - theoreticalUnitCogsMinor,
    );

    const plannedCogsMinor = plannedUnits * theoreticalUnitCogsMinor;
    const actualCogsMinor = actualUnitsSold * actualUnitCogsMinor;

    const plannedWastePct =
      standingProd.fulfillmentKind === "stocked"
        ? standingProd.effectiveSpoilagePct
        : standingCalc.assumptions.prepRejectPct;
    const plannedWasteMinor =
      plannedUnits * standingProd.wasteAndSurplusUnitMinor;

    const batchCount = obs?.batchCount ?? 0;
    const plannedBatchUnits = round2(obs?.plannedBatchUnits ?? 0);
    const actualBatchUnits = round2(obs?.actualBatchUnits ?? 0);
    const stockedUnitsProduced = round2(obs?.stockedUnitsProduced ?? 0);
    const stockedUnitsWasted = round2(obs?.stockedUnitsWasted ?? 0);
    const batchRejectUnits = Math.max(0, plannedBatchUnits - actualBatchUnits);
    const totalWastedUnits = batchRejectUnits + stockedUnitsWasted;

    const handledUnits = Math.max(
      plannedBatchUnits,
      stockedUnitsProduced,
      actualUnitsSold + totalWastedUnits,
    );
    const allocatedSupplyLossMinor =
      supplyLossByProductId.get(realizedProd.productId) ?? 0;
    const directProductWasteMinor = totalWastedUnits * actualUnitCogsMinor;
    const actualWasteMinor = directProductWasteMinor + allocatedSupplyLossMinor;

    const actualWastePct =
      handledUnits > 0
        ? round2(
            Math.min(
              100,
              ((totalWastedUnits +
                (actualUnitCogsMinor > 0
                  ? allocatedSupplyLossMinor / actualUnitCogsMinor
                  : 0)) /
                handledUnits) *
                100,
            ),
          )
        : null;

    const actualGrossSalesMinor = obs?.grossSalesMinor ?? 0;
    const actualIncludedTaxMinor = obs?.includedTaxMinor ?? 0;
    const actualNetExTaxSalesMinor = Math.max(
      0,
      actualGrossSalesMinor - actualIncludedTaxMinor,
    );
    const actualChannelFeeMinor = actualGrossSalesMinor * feeRate;

    const plannedContributionMinor =
      plannedNetExTaxSalesMinor -
      plannedChannelFeeMinor -
      plannedCogsMinor -
      plannedWasteMinor;
    const plannedMarginPct =
      plannedGrossSalesMinor > 0
        ? round2((plannedContributionMinor / plannedGrossSalesMinor) * 100)
        : 0;

    const actualContributionMinor =
      actualNetExTaxSalesMinor -
      actualChannelFeeMinor -
      actualCogsMinor -
      actualWasteMinor;
    const actualMarginPct =
      actualGrossSalesMinor > 0
        ? round2((actualContributionMinor / actualGrossSalesMinor) * 100)
        : null;

    const costAndWasteVarianceMinor = -(
      actualWasteMinor -
      (orderCount > 0
        ? actualUnitsSold * standingProd.wasteAndSurplusUnitMinor
        : 0) +
      (orderCount > 0 ? actualUnitsSold : plannedUnits) *
        (actualUnitCogsMinor - theoreticalUnitCogsMinor)
    );

    const profitDeltaMinor =
      comparisonMode === "orders_and_costs"
        ? round2(actualContributionMinor - plannedContributionMinor)
        : round2(costAndWasteVarianceMinor);

    // Accumulate supply consumption for lot-invoice attribution.
    const unitsForInvoiceAttribution =
      orderCount > 0 ? actualUnitsSold + totalWastedUnits : plannedUnits;
    if (unitsForInvoiceAttribution > 0) {
      for (const line of realizedProd.bomLines) {
        const supply = realizedSupplyById.get(line.inventoryItemId);
        if (supply === undefined || supply.pricedLotCount <= 0) continue;
        // line.quantityPerUnit is in line.unit; convert via effectiveRate ratio or supply baseUnit
        const basePerUnit =
          line.effectiveRatePerBaseUnitMinor !== null &&
          line.effectiveRatePerBaseUnitMinor > 0
            ? line.costPerUnitMinor / line.effectiveRatePerBaseUnitMinor
            : 0;
        if (basePerUnit > 0) {
          supplyInvoiceConsumptionBase.set(
            line.inventoryItemId,
            (supplyInvoiceConsumptionBase.get(line.inventoryItemId) ?? 0) +
              unitsForInvoiceAttribution * basePerUnit,
          );
        }
      }
    }

    // Product waste variance driver (excluding supplyLoss already tracked in supply_loss driver).
    const expectedDirectWasteAtActualVol =
      orderCount > 0
        ? actualUnitsSold * standingProd.wasteAndSurplusUnitMinor
        : 0;
    const productWasteVarianceMinor = -(
      directProductWasteMinor - expectedDirectWasteAtActualVol
    );
    if (
      totalWastedUnits > 0 &&
      Math.abs(Math.round(productWasteVarianceMinor)) >= 10
    ) {
      const wasteLabelPct =
        actualWastePct !== null ? `${actualWastePct.toFixed(1)}%` : "";
      drivers.push({
        id: `product_waste:${realizedProd.productId}`,
        kind: "product_waste",
        label: `${realizedProd.productTitle} waste ${wasteLabelPct}`.trim(),
        detail: `${round2(totalWastedUnits)} u lost (${round2(batchRejectUnits)} bake reject · ${round2(stockedUnitsWasted)} shelf)`,
        profitImpactMinor: Math.round(productWasteVarianceMinor),
        productId: realizedProd.productId,
        inventoryItemId: null,
      });
    }

    // Accumulate volume & mix variance across the shop when orders exist in window.
    if (orderCount > 0 && actualUnitsSold !== plannedUnits) {
      const unitPlannedContrib =
        plannedUnits > 0
          ? plannedContributionMinor / plannedUnits
          : standingProd.netContributionUnitMinor;
      const volImpact = (actualUnitsSold - plannedUnits) * unitPlannedContrib;
      totalVolumeMixImpactMinor += volImpact;
      if (
        topVolumeSwing === null ||
        Math.abs(volImpact) > topVolumeSwing.absImpact
      ) {
        topVolumeSwing = {
          productId: realizedProd.productId,
          productTitle: realizedProd.productTitle,
          absImpact: Math.abs(volImpact),
        };
      }
    }

    const { statusTone, primaryNote } = classifyRowStatus({
      comparisonMode,
      plannedUnits,
      actualUnitsSold,
      volumeDeltaUnits,
      unitCogsDeltaMinor,
      plannedWastePct,
      actualWastePct,
      totalWastedUnits,
      allocatedSupplyLossMinor,
      profitDeltaMinor,
    });

    sumPlannedUnits += plannedUnits;
    sumActualUnits += actualUnitsSold;
    sumPlannedGrossSalesMinor += plannedGrossSalesMinor;
    sumActualLineGrossSalesMinor += actualGrossSalesMinor;
    sumPlannedCogsMinor += plannedCogsMinor;
    sumActualCogsMinor +=
      orderCount > 0 ? actualCogsMinor : plannedUnits * actualUnitCogsMinor;
    sumPlannedWasteMinor += plannedWasteMinor;
    sumActualProductWasteMinor += directProductWasteMinor;
    sumPlannedChannelFeeMinor += plannedChannelFeeMinor;
    sumPlannedContributionMinor += plannedContributionMinor;
    sumActualProductContributionMinor += actualContributionMinor;

    rows.push({
      productId: realizedProd.productId,
      productTitle: realizedProd.productTitle,
      productType: realizedProd.productType,
      fulfillmentKind: realizedProd.fulfillmentKind,
      imageUrl: realizedProd.imageUrl,
      currency: realizedProd.currency,
      recipeId: realizedProd.recipeId,
      recipeRevision: realizedProd.recipeRevision,
      batchYield: realizedProd.batchYield,
      grossPriceMinor: realizedProd.grossPriceMinor,
      plannedUnits,
      actualUnitsSold,
      posUnitsSold,
      onlineUnitsSold,
      volumeDeltaUnits,
      plannedGrossSalesMinor: round2(plannedGrossSalesMinor),
      actualGrossSalesMinor: round2(actualGrossSalesMinor),
      actualNetExTaxSalesMinor: round2(actualNetExTaxSalesMinor),
      theoreticalUnitCogsMinor: round2(theoreticalUnitCogsMinor),
      actualUnitCogsMinor: round2(actualUnitCogsMinor),
      unitCogsDeltaMinor,
      plannedCogsMinor: round2(plannedCogsMinor),
      actualCogsMinor: round2(actualCogsMinor),
      batchCount,
      plannedBatchUnits,
      actualBatchUnits,
      stockedUnitsProduced,
      stockedUnitsWasted,
      allocatedSupplyLossMinor: round2(allocatedSupplyLossMinor),
      plannedWastePct: round2(plannedWastePct),
      actualWastePct,
      plannedWasteMinor: round2(plannedWasteMinor),
      actualWasteMinor: round2(actualWasteMinor),
      plannedMarginPct,
      actualMarginPct,
      plannedContributionMinor: round2(plannedContributionMinor),
      actualContributionMinor: round2(actualContributionMinor),
      profitDeltaMinor,
      statusTone,
      primaryNote,
      bomLines: realizedProd.bomLines,
    });
  }

  // Lot invoice variance drivers per supply with priced lots.
  for (const [itemId, consumedBase] of supplyInvoiceConsumptionBase) {
    const realizedSup = realizedSupplyById.get(itemId);
    const standingSup = standingSupplyById.get(itemId);
    if (
      realizedSup === undefined ||
      standingSup === undefined ||
      realizedSup.effectiveCostPerBaseUnitMinor === null ||
      standingSup.effectiveCostPerBaseUnitMinor === null
    ) {
      continue;
    }
    const rateDelta =
      realizedSup.effectiveCostPerBaseUnitMinor -
      standingSup.effectiveCostPerBaseUnitMinor;
    const impact = Math.round(-rateDelta * consumedBase);
    if (Math.abs(impact) >= 1) {
      const pct =
        standingSup.effectiveCostPerBaseUnitMinor > 0
          ? (rateDelta / standingSup.effectiveCostPerBaseUnitMinor) * 100
          : 0;
      const pctSign = pct > 0 ? "+" : "−";
      drivers.push({
        id: `lot_invoice:${itemId}`,
        kind: "lot_invoice",
        label: `${realizedSup.name} invoice ${pctSign}${Math.abs(pct).toFixed(1)}%`,
        detail: `${realizedLotBasis === "fifo_lot" ? "FIFO" : "Weighted"} lot invoice vs standing pack across ${formatCompactQty(consumedBase, realizedSup.baseUnit)}`,
        profitImpactMinor: impact,
        productId: null,
        inventoryItemId: itemId,
      });
    }
  }

  if (orderCount > 0 && Math.abs(Math.round(totalVolumeMixImpactMinor)) >= 50) {
    const netUnitsDelta = round2(sumActualUnits - sumPlannedUnits);
    const sign = netUnitsDelta >= 0 ? "+" : "−";
    drivers.push({
      id: "volume_mix:shop",
      kind: "volume_mix",
      label: `Volume & mix (${sign}${Math.abs(netUnitsDelta)} u vs plan)`,
      detail:
        topVolumeSwing !== null
          ? `${sumActualUnits} sold vs ${sumPlannedUnits} planned · largest swing: ${topVolumeSwing.productTitle}`
          : `${sumActualUnits} sold vs ${sumPlannedUnits} planned`,
      profitImpactMinor: Math.round(totalVolumeMixImpactMinor),
      productId: topVolumeSwing?.productId ?? null,
      inventoryItemId: null,
    });
  }

  drivers.sort(
    (left, right) =>
      Math.abs(right.profitImpactMinor) - Math.abs(left.profitImpactMinor) ||
      left.id.localeCompare(right.id),
  );
  const topDrivers = drivers.slice(0, 8);

  const actualGrossSalesMinor =
    windowObs !== null && windowObs.grossSalesMinor > 0
      ? windowObs.grossSalesMinor
      : sumActualLineGrossSalesMinor;
  const actualRefundsMinor = windowObs?.refundsMinor ?? 0;
  const actualNetSalesMinor = Math.max(
    0,
    actualGrossSalesMinor - actualRefundsMinor,
  );
  const salesDeltaMinor = round2(actualNetSalesMinor - sumPlannedGrossSalesMinor);
  const salesDeltaPct =
    orderCount > 0 && sumPlannedGrossSalesMinor > 0
      ? round2((salesDeltaMinor / sumPlannedGrossSalesMinor) * 100)
      : null;

  const totalActualWasteMinor =
    sumActualProductWasteMinor + totalSupplyLossMinor;
  const plannedFixedCostMinor =
    standingCalc.summary.dailyFixedCostMinor * windowDays;
  const actualFixedCostMinor = plannedFixedCostMinor;
  const actualChannelFeeMinor = actualNetSalesMinor * feeRate;

  const plannedOperatingProfitMinor =
    sumPlannedContributionMinor - plannedFixedCostMinor;
  const actualContributionMinor =
    orderCount > 0
      ? sumActualProductContributionMinor - actualRefundsMinor
      : sumPlannedContributionMinor +
        rows.reduce((acc, r) => acc + r.profitDeltaMinor, 0);
  const actualOperatingProfitMinor =
    actualContributionMinor - actualFixedCostMinor;
  const operatingProfitDeltaMinor = round2(
    actualOperatingProfitMinor - plannedOperatingProfitMinor,
  );

  const plannedCogsPctOfSales =
    sumPlannedGrossSalesMinor > 0
      ? round2((sumPlannedCogsMinor / sumPlannedGrossSalesMinor) * 100)
      : 0;
  const actualCogsPctOfSales =
    orderCount > 0 && actualNetSalesMinor > 0
      ? round2((sumActualCogsMinor / actualNetSalesMinor) * 100)
      : null;

  const plannedWastePctOfSales =
    sumPlannedGrossSalesMinor > 0
      ? round2((sumPlannedWasteMinor / sumPlannedGrossSalesMinor) * 100)
      : 0;
  const actualWastePctOfSales =
    orderCount > 0 && actualNetSalesMinor > 0
      ? round2((totalActualWasteMinor / actualNetSalesMinor) * 100)
      : sumPlannedGrossSalesMinor > 0 && totalActualWasteMinor > 0
        ? round2((totalActualWasteMinor / sumPlannedGrossSalesMinor) * 100)
        : null;

  const plannedOperatingMarginPct =
    sumPlannedGrossSalesMinor > 0
      ? round2((plannedOperatingProfitMinor / sumPlannedGrossSalesMinor) * 100)
      : 0;
  const actualOperatingMarginPct =
    orderCount > 0 && actualNetSalesMinor > 0
      ? round2((actualOperatingProfitMinor / actualNetSalesMinor) * 100)
      : null;

  return {
    windowDays,
    summary: {
      currency: input.overview.currency,
      windowDays,
      windowStartAt: windowObs?.windowStartAt ?? null,
      windowEndAt: windowObs?.windowEndAt ?? null,
      comparisonMode,
      orderCount,
      posOrderCount,
      onlineOrderCount,
      plannedUnitsSold: Math.round(sumPlannedUnits),
      actualUnitsSold: round2(sumActualUnits),
      volumeDeltaUnits: round2(sumActualUnits - sumPlannedUnits),
      plannedGrossSalesMinor: round2(sumPlannedGrossSalesMinor),
      actualGrossSalesMinor: round2(actualGrossSalesMinor),
      actualRefundsMinor: round2(actualRefundsMinor),
      actualNetSalesMinor: round2(actualNetSalesMinor),
      salesDeltaMinor,
      salesDeltaPct,
      plannedCogsMinor: round2(sumPlannedCogsMinor),
      actualCogsMinor: round2(sumActualCogsMinor),
      cogsDeltaMinor: round2(sumActualCogsMinor - sumPlannedCogsMinor),
      plannedCogsPctOfSales,
      actualCogsPctOfSales,
      plannedWasteMinor: round2(sumPlannedWasteMinor),
      actualWasteMinor: round2(totalActualWasteMinor),
      wasteDeltaMinor: round2(totalActualWasteMinor - sumPlannedWasteMinor),
      plannedWastePctOfSales,
      actualWastePctOfSales,
      supplyLossMinor: round2(totalSupplyLossMinor),
      plannedChannelFeeMinor: round2(sumPlannedChannelFeeMinor),
      actualChannelFeeMinor: round2(actualChannelFeeMinor),
      plannedFixedCostMinor: round2(plannedFixedCostMinor),
      actualFixedCostMinor: round2(actualFixedCostMinor),
      settledPayablesMinor: round2(windowObs?.settledPayablesMinor ?? 0),
      openPayablesMinor: round2(windowObs?.openPayablesMinor ?? 0),
      payableCount: windowObs?.payableCount ?? 0,
      plannedContributionMinor: round2(sumPlannedContributionMinor),
      actualContributionMinor: round2(actualContributionMinor),
      plannedOperatingProfitMinor: round2(plannedOperatingProfitMinor),
      actualOperatingProfitMinor: round2(actualOperatingProfitMinor),
      operatingProfitDeltaMinor,
      plannedOperatingMarginPct,
      actualOperatingMarginPct,
    },
    drivers: topDrivers,
    products: rows,
  };
}

function classifyRowStatus(opts: Readonly<{
  comparisonMode: PlanVsActualComparisonMode;
  plannedUnits: number;
  actualUnitsSold: number;
  volumeDeltaUnits: number;
  unitCogsDeltaMinor: number;
  plannedWastePct: number;
  actualWastePct: number | null;
  totalWastedUnits: number;
  allocatedSupplyLossMinor: number;
  profitDeltaMinor: number;
}>): Readonly<{ statusTone: PlanVsActualStatusTone; primaryNote: string }> {
  const {
    comparisonMode,
    plannedUnits,
    actualUnitsSold,
    volumeDeltaUnits,
    unitCogsDeltaMinor,
    plannedWastePct,
    actualWastePct,
    totalWastedUnits,
    allocatedSupplyLossMinor,
    profitDeltaMinor,
  } = opts;

  if (
    comparisonMode === "costs_and_waste_only" &&
    totalWastedUnits === 0 &&
    allocatedSupplyLossMinor < 1 &&
    Math.abs(unitCogsDeltaMinor) < 0.5
  ) {
    return { statusTone: "no_activity", primaryNote: "On standing rates" };
  }

  if (
    actualWastePct !== null &&
    actualWastePct > plannedWastePct + 3 &&
    totalWastedUnits > 0
  ) {
    return {
      statusTone: profitDeltaMinor < 0 ? "leak" : "watch",
      primaryNote: `Bake & shelf waste ${actualWastePct.toFixed(1)}%`,
    };
  }

  if (allocatedSupplyLossMinor >= 50) {
    return {
      statusTone: profitDeltaMinor < 0 ? "leak" : "watch",
      primaryNote: "Ingredient supply loss",
    };
  }

  if (unitCogsDeltaMinor >= 2) {
    return {
      statusTone: profitDeltaMinor < 0 ? "watch" : "surplus",
      primaryNote: `Lot invoice +${Math.round(unitCogsDeltaMinor)}/u`,
    };
  }

  if (unitCogsDeltaMinor <= -2) {
    return {
      statusTone: profitDeltaMinor >= 0 ? "surplus" : "watch",
      primaryNote: `Lot invoice −${Math.abs(Math.round(unitCogsDeltaMinor))}/u`,
    };
  }

  if (comparisonMode === "orders_and_costs") {
    if (actualUnitsSold === 0 && totalWastedUnits === 0) {
      return { statusTone: "no_activity", primaryNote: "No orders in window" };
    }
    if (volumeDeltaUnits > Math.max(2, plannedUnits * 0.08)) {
      return {
        statusTone: profitDeltaMinor >= 0 ? "surplus" : "watch",
        primaryNote: `Demand surge +${volumeDeltaUnits} u`,
      };
    }
    if (volumeDeltaUnits < -Math.max(2, plannedUnits * 0.1)) {
      return {
        statusTone: "leak",
        primaryNote: `Demand shortfall −${Math.abs(volumeDeltaUnits)} u`,
      };
    }
  }

  if (profitDeltaMinor > 200) {
    return { statusTone: "surplus", primaryNote: "Above plan" };
  }
  if (profitDeltaMinor < -200) {
    return { statusTone: "leak", primaryNote: "Below plan" };
  }
  return { statusTone: "on_plan", primaryNote: "Tracking plan" };
}

function formatCompactQty(amount: number, unit: CostUnit): string {
  if (unit === "gram" && amount >= 1000) {
    return `${(amount / 1000).toFixed(2).replace(/\.?0+$/u, "")} kg`;
  }
  if (unit === "milliliter" && amount >= 1000) {
    return `${(amount / 1000).toFixed(2).replace(/\.?0+$/u, "")} L`;
  }
  const rounded = Math.round(amount * 10) / 10;
  const suffix =
    unit === "gram"
      ? "g"
      : unit === "kilogram"
        ? "kg"
        : unit === "milliliter"
          ? "mL"
          : unit === "liter"
            ? "L"
            : "ea";
  return `${rounded} ${suffix}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
