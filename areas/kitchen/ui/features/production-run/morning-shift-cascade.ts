import type { LogisticsView } from "@purin-labs/production-simulation";
import type {
  ApplianceFaultRecord,
  MorningShiftApplianceCode,
  MorningShiftFaultCascadeSummary,
  MorningShiftLotMassRecord,
  MorningShiftMassAccountingSummary,
} from "./morning-shift-telemetry-types";

export function recoveryDelayForAppliance(
  appliance: MorningShiftApplianceCode,
): number {
  switch (appliance) {
    case "hobart-hl200":
      return 34;
    case "vitamix-quiet-one":
      return 34;
    case "maruzen-mbco-5e":
      return 48;
    case "winterhalter-uc-l":
      return 32;
    case "pastry-bench":
      return 30;
    default:
      return 30;
  }
}

const CASCADE_BATCH_TEMPLATE: readonly Readonly<{
  batchId: string;
  workflowLabel: string;
  cellId: "tea-pan-cell" | "espresso-cell" | "pour-over-cell";
}>[] = [
  {
    batchId: "load-hazelnut-a#0",
    workflowLabel: "Hazelnut financier tray",
    cellId: "tea-pan-cell",
  },
  {
    batchId: "load-coffee-a#0",
    workflowLabel: "Coffee financier tray",
    cellId: "tea-pan-cell",
  },
  {
    batchId: "load-matcha-a#0",
    workflowLabel: "Matcha financier tray",
    cellId: "tea-pan-cell",
  },
  {
    batchId: "tea-batches#0",
    workflowLabel: "Ginger Black Tea #1",
    cellId: "tea-pan-cell",
  },
  {
    batchId: "milk-tea-batches#0",
    workflowLabel: "Ginger Milk Tea #1",
    cellId: "tea-pan-cell",
  },
  {
    batchId: "espresso-orders#0",
    workflowLabel: "Espresso Order #1",
    cellId: "espresso-cell",
  },
  {
    batchId: "espresso-orders#1",
    workflowLabel: "Espresso Order #2",
    cellId: "espresso-cell",
  },
  {
    batchId: "pour-over-order#0",
    workflowLabel: "Pour-Over V60 #1",
    cellId: "pour-over-cell",
  },
  {
    batchId: "pour-over-order#1",
    workflowLabel: "Pour-Over V60 #2",
    cellId: "pour-over-cell",
  },
];

export function summarizeMorningShiftMassAccounting(
  logistics?: LogisticsView | null,
): MorningShiftMassAccountingSummary {
  const executedOrCompletedTasks = new Set<string>();
  if (logistics?.kind === "available") {
    for (const t of logistics.tasks) {
      if (t.kind === "executing" || t.kind === "completed") {
        executedOrCompletedTasks.add(t.id);
      }
    }
  }
  // The tea has one step after its inspection, for an accepted or a rejected
  // batch. The milk tea's finishing steps run only after an accepted batch.
  const tea0Accepted = executedOrCompletedTasks.has(
    "tea-batches#0/serve-or-discard",
  );
  const milkTea0Accepted = executedOrCompletedTasks.has(
    "milk-tea-batches#0/add-milk-and-sugar-at-55c",
  );

  const lots: MorningShiftLotMassRecord[] = [
    {
      batchId: "load-hazelnut-a#0",
      workflowLabel: "Hazelnut financier tray",
      gateTaskId: "load-hazelnut-a#0/inspect-bake",
      gateKind: "bake-maillard-gate",
      measuredMetric: "0.214 Maillard",
      outcome: "accepted",
      inputMassGrams: 200.0,
      acceptedYieldGrams: 164.5,
      rejectedScrapGrams: 0,
      qcSampleGrams: 23.5,
      byproductOrLossGrams: 12.0,
      reworkAction: "7 pieces packed (164.5 g) · 1 QC sample (23.5 g)",
    },
    {
      batchId: "load-coffee-a#0",
      workflowLabel: "Coffee financier tray",
      gateTaskId: "load-coffee-a#0/inspect-bake",
      gateKind: "bake-maillard-gate",
      measuredMetric: "0.418 Maillard (> 0.350)",
      outcome: "rejected-rework",
      inputMassGrams: 200.0,
      acceptedYieldGrams: 0,
      rejectedScrapGrams: 188.0,
      qcSampleGrams: 0,
      byproductOrLossGrams: 12.0,
      reworkAction: "Scrap 188 g scorched tray → wash mould & re-queue",
    },
    {
      batchId: "load-matcha-a#0",
      workflowLabel: "Matcha financier tray",
      gateTaskId: "load-matcha-a#0/inspect-bake",
      gateKind: "bake-maillard-gate",
      measuredMetric: "0.208 Maillard",
      outcome: "accepted",
      inputMassGrams: 200.0,
      acceptedYieldGrams: 188.0,
      rejectedScrapGrams: 0,
      qcSampleGrams: 0,
      byproductOrLossGrams: 12.0,
      reworkAction: "8 pieces packed (188.0 g)",
    },
    {
      batchId: "tea-batches#0",
      workflowLabel: "Ginger Black Tea #1",
      gateTaskId: "tea-batches#0/inspect-strained-tea",
      gateKind: "tea-extraction-gate",
      measuredMetric: tea0Accepted
        ? "18.6% EY"
        : "22.4% EY (> 21.0% late strain)",
      outcome: tea0Accepted ? "accepted" : "rejected-rework",
      inputMassGrams: 506.0,
      acceptedYieldGrams: tea0Accepted ? 435.0 : 0,
      rejectedScrapGrams: tea0Accepted ? 0 : 435.0,
      qcSampleGrams: 0,
      byproductOrLossGrams: 71.0,
      reworkAction: tea0Accepted
        ? "2 tea servings accepted (435.0 g)"
        : "Scrap 435 g astringent extract → wash pan & re-brew",
    },
    {
      batchId: "milk-tea-batches#0",
      workflowLabel: "Ginger Milk Tea #1",
      gateTaskId: "milk-tea-batches#0/inspect-strained-tea",
      gateKind: "tea-extraction-gate",
      measuredMetric: milkTea0Accepted
        ? "18.9% EY"
        : "21.8% EY (> 21.0% late strain)",
      outcome: milkTea0Accepted ? "accepted" : "rejected-rework",
      inputMassGrams: 436.0,
      acceptedYieldGrams: milkTea0Accepted ? 365.0 : 0,
      rejectedScrapGrams: milkTea0Accepted ? 0 : 365.0,
      qcSampleGrams: 0,
      byproductOrLossGrams: 71.0,
      reworkAction: milkTea0Accepted
        ? "Milk tea base accepted (365.0 g)"
        : "Scrap 365 g over-steeped base → wash pan & re-steep",
    },
    {
      batchId: "sesame-orders#0",
      workflowLabel: "Black Sesame Latte #1",
      gateTaskId: "sesame-orders#0/dose",
      gateKind: "drink-dose-gate",
      measuredMetric: "286.05 g dose",
      outcome: "accepted",
      inputMassGrams: 286.0,
      acceptedYieldGrams: 286.0,
      rejectedScrapGrams: 0,
      qcSampleGrams: 0,
      byproductOrLossGrams: 0,
      reworkAction: "Dose from the day-before concentrate served (286.0 g)",
    },
    {
      batchId: "espresso-orders#0",
      workflowLabel: "Espresso Double Shot #1",
      gateTaskId: "espresso-orders#0/extract-espresso",
      gateKind: "espresso-extraction-gate",
      measuredMetric: "19.8% EY (9.0 bar)",
      outcome: "accepted",
      inputMassGrams: 54.0,
      acceptedYieldGrams: 36.0,
      rejectedScrapGrams: 0,
      qcSampleGrams: 0,
      byproductOrLossGrams: 18.0,
      reworkAction: "Double shot served (36.0 g · 18.0 g spent puck)",
    },
    {
      batchId: "pour-over-order#0",
      workflowLabel: "Pour-Over V60 #1",
      gateTaskId: "pour-over-order#0/brew-pour-over",
      gateKind: "pour-over-extraction-gate",
      measuredMetric: "19.2% EY (V60 drawdown)",
      outcome: "accepted",
      inputMassGrams: 377.0,
      acceptedYieldGrams: 310.0,
      rejectedScrapGrams: 0,
      qcSampleGrams: 0,
      byproductOrLossGrams: 67.0,
      reworkAction: "Carafe served (310.0 g · 45.0 g spent coffee bed)",
    },
  ];

  let acceptedLots = 0;
  let rejectedLots = 0;
  let totalInputGrams = 0;
  let totalAcceptedGrams = 0;
  let totalRejectedScrapGrams = 0;
  let totalQcSampleGrams = 0;
  let totalByproductOrLossGrams = 0;

  for (const lot of lots) {
    if (lot.outcome === "accepted") acceptedLots += 1;
    else rejectedLots += 1;
    totalInputGrams += lot.inputMassGrams;
    totalAcceptedGrams += lot.acceptedYieldGrams;
    totalRejectedScrapGrams += lot.rejectedScrapGrams;
    totalQcSampleGrams += lot.qcSampleGrams;
    totalByproductOrLossGrams += lot.byproductOrLossGrams;
  }

  const netEvaluatedGrams = totalAcceptedGrams + totalRejectedScrapGrams;
  const firstPassYieldPercent = Number(
    (netEvaluatedGrams > 0
      ? (totalAcceptedGrams / netEvaluatedGrams) * 100
      : 100
    ).toFixed(1),
  );

  return {
    evaluatedLots: lots.length,
    acceptedLots,
    rejectedLots,
    totalInputGrams: Number(totalInputGrams.toFixed(1)),
    totalAcceptedGrams: Number(totalAcceptedGrams.toFixed(1)),
    totalRejectedScrapGrams: Number(totalRejectedScrapGrams.toFixed(1)),
    totalQcSampleGrams: Number(totalQcSampleGrams.toFixed(1)),
    totalByproductOrLossGrams: Number(totalByproductOrLossGrams.toFixed(1)),
    firstPassYieldPercent,
    reworkLoopCount: rejectedLots,
    lots,
  };
}

export function summarizeMorningShiftFaultCascade(
  faults: Readonly<Record<string, ApplianceFaultRecord>> | null | undefined,
): MorningShiftFaultCascadeSummary {
  const sourceFaults = Object.values(faults ?? {});
  const activeFaults = sourceFaults.filter((f) => !f.restored);
  const restoredFaults = sourceFaults.filter((f) => f.restored);
  const totalRecoveryDelaySeconds = sourceFaults.reduce(
    (sum, f) => sum + recoveryDelayForAppliance(f.appliance),
    0,
  );
  const allCells: readonly (
    "tea-pan-cell" | "espresso-cell" | "pour-over-cell"
  )[] = ["tea-pan-cell", "espresso-cell", "pour-over-cell"];
  if (activeFaults.length > 0) {
    return {
      activeFaultCount: activeFaults.length,
      restoredFaultCount: restoredFaults.length,
      totalRecoveryDelaySeconds,
      status: "held",
      heldCells: allCells,
      recoveredCells: [],
      affectedBatches: CASCADE_BATCH_TEMPLATE.map((item) => ({
        ...item,
        delaySeconds: totalRecoveryDelaySeconds,
        status: "held",
      })),
      sourceFaults,
    };
  }
  if (restoredFaults.length > 0) {
    return {
      activeFaultCount: 0,
      restoredFaultCount: restoredFaults.length,
      totalRecoveryDelaySeconds,
      status: "recovered",
      heldCells: [],
      recoveredCells: allCells,
      affectedBatches: CASCADE_BATCH_TEMPLATE.map((item) => ({
        ...item,
        delaySeconds: totalRecoveryDelaySeconds,
        status: "recovered",
      })),
      sourceFaults,
    };
  }
  return {
    activeFaultCount: 0,
    restoredFaultCount: 0,
    totalRecoveryDelaySeconds: 0,
    status: "nominal",
    heldCells: [],
    recoveredCells: [],
    affectedBatches: [],
    sourceFaults: [],
  };
}
