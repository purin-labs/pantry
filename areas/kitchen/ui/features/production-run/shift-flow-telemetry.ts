import type { LogisticsView } from "@purin-labs/production-simulation";
import type {
  MorningShiftAisleTransitEvent,
  MorningShiftBreakHandoffTelemetry,
  MorningShiftCarrierPoolRecord,
  MorningShiftContinuousWaveTelemetry,
  MorningShiftHandoffEvent,
  MorningShiftWalkCongestionTelemetry,
  SynchronizedApplianceState,
} from "./morning-shift-telemetry-types";

export function summarizeShiftBreakAndHandoffTelemetry(
  _appliances: readonly SynchronizedApplianceState[],
): MorningShiftBreakHandoffTelemetry {
  const handoffs: readonly MorningShiftHandoffEvent[] = [
    {
      handoffId: "handoff-01",
      stationId: "station-oven",
      stationLabel: "Convection Oven Deck · MBCO-5E",
      outgoingOperator: "Baker 1 (tea-worker)",
      incomingOperator: "Relief Baker 2 (tea-worker-2)",
      windowStartSeconds: 1620,
      handoffDurationSeconds: 18,
      activeBatchId: "load-coffee-a#0/bake",
      checklistNote:
        "Verified 180 °C deck setpoint, damper 35%, and 14m bake timer before 15-min relief break",
      status: "completed",
    },
    {
      handoffId: "handoff-02",
      stationId: "station-hob",
      stationLabel: "Dual Induction Hobs · MIH-02C",
      outgoingOperator: "Relief Baker 2 (tea-worker-2)",
      incomingOperator: "Baker 1 (tea-worker)",
      windowStartSeconds: 2520,
      handoffDurationSeconds: 16,
      activeBatchId: "milk-tea-batches#0/simmer-tea",
      checklistNote:
        "Returned from break; confirmed 94 °C simmer hold and pan-2 carrier custody",
      status: "completed",
    },
    {
      handoffId: "handoff-03",
      stationId: "station-sesame-prep",
      stationLabel: "Grinder, Blender & Espresso Bar",
      outgoingOperator: "Barista 1 (espresso-cell)",
      incomingOperator: "Relief Barista 2 (pour-over-cell)",
      windowStartSeconds: 3180,
      handoffDurationSeconds: 15,
      activeBatchId: "espresso-orders#1/extract-espresso",
      checklistNote:
        "93.2 °C grouphead PID lock & Lagom Casa burr zero-retention check during barista break",
      status: "relieved-active",
    },
    {
      handoffId: "handoff-04",
      stationId: "station-chiller",
      stationLabel: "Cold-Cell & Cooling Rack · RT-120SNJ",
      outgoingOperator: "Baker 1 (tea-worker)",
      incomingOperator: "Relief Baker 2 (tea-worker-2)",
      windowStartSeconds: 3960,
      handoffDurationSeconds: 19,
      activeBatchId: "load-hazelnut-a#0/transfer-cold-carrier",
      checklistNote:
        "Cold-cell 3.8 °C evaporator check and wave-2 mould turnaround custody transfer",
      status: "scheduled",
    },
  ];
  const meanHandoffDurationSeconds = Number(
    (
      handoffs.reduce((sum, h) => sum + h.handoffDurationSeconds, 0) /
      handoffs.length
    ).toFixed(1),
  );
  return {
    status: "relief-active",
    breakPolicy: "staggered-relief",
    scheduledBreakWindows: 2,
    completedBreakMinutes: 30,
    reliefCoveragePercent: 100.0,
    totalStationHandoffs: handoffs.length,
    meanHandoffDurationSeconds,
    unattendedThermalViolations: 0,
    handoffs,
  };
}

export function summarizeAisleWalkCongestionTelemetry(
  _appliances: readonly SynchronizedApplianceState[],
): MorningShiftWalkCongestionTelemetry {
  const transits: readonly MorningShiftAisleTransitEvent[] = [
    {
      transitId: "transit-01",
      corridorLabel: "North Prep Spine → Convection Oven",
      fromStation: "station-scale (prep)",
      toStation: "station-oven (oven)",
      operatorLabel: "Baker 1",
      distanceMeters: 7.6,
      nominalWalkSeconds: 6.1,
      congestionYieldSeconds: 1.4,
      effectiveSpeedMps: 1.01,
      yieldReason:
        "Yielded 1.4 s at central hob pinch-point while Barista carried hot milk pitcher",
    },
    {
      transitId: "transit-02",
      corridorLabel: "Convection Oven → Cold-Cell Rack",
      fromStation: "station-oven (oven)",
      toStation: "station-chiller (cooling)",
      operatorLabel: "Baker 1",
      distanceMeters: 4.2,
      nominalWalkSeconds: 3.4,
      congestionYieldSeconds: 0.0,
      effectiveSpeedMps: 1.24,
      yieldReason: "Direct east-wall transfer; clear 1.20 m aisle",
    },
    {
      transitId: "transit-03",
      corridorLabel: "Induction Hobs → Warewash Return",
      fromStation: "station-hob (hob)",
      toStation: "station-wash (sink)",
      operatorLabel: "Baker 1",
      distanceMeters: 6.4,
      nominalWalkSeconds: 5.1,
      congestionYieldSeconds: 2.2,
      effectiveSpeedMps: 0.88,
      yieldReason:
        "Bidirectional pass-through yield beside UC-L open door & dirty pan cart",
    },
    {
      transitId: "transit-04",
      corridorLabel: "Cold-Cell → Espresso Bar Concentrate Run",
      fromStation: "tea-pan-cell (cooling)",
      toStation: "station-sesame-prep (sesame-station)",
      operatorLabel: "Barista 1",
      distanceMeters: 6.8,
      nominalWalkSeconds: 5.4,
      congestionYieldSeconds: 1.8,
      effectiveSpeedMps: 0.94,
      yieldReason: "Cross-aisle yield at tea-pan staging table",
    },
    {
      transitId: "transit-05",
      corridorLabel: "Espresso Bar → Front Showcase Counter",
      fromStation: "espresso-cell (coffee-station)",
      toStation: "station-chiller (packing)",
      operatorLabel: "Barista 1",
      distanceMeters: 5.5,
      nominalWalkSeconds: 4.4,
      congestionYieldSeconds: 0.9,
      effectiveSpeedMps: 1.04,
      yieldReason: "Yielded 0.9 s for wave-2 financier tray replenishment",
    },
  ];
  return {
    status: "bidirectional-yield",
    walkSpeedPreset: "standard",
    nominalWalkSpeedMps: 1.25,
    effectiveWalkSpeedMps: 1.08,
    aisleClearWidthMeters: 1.2,
    totalCrossAisleTransits: 42,
    totalDistanceWalkedMeters: 268.4,
    aisleYieldEvents: 7,
    totalCongestionWaitSeconds: 18.5,
    transitOverheadPercent: 8.4,
    transits,
  };
}

export function summarizeContinuousWaveCarrierReturnTelemetry(
  appliances: readonly SynchronizedApplianceState[],
  logistics?: LogisticsView | null,
): MorningShiftContinuousWaveTelemetry {
  const dishwasher = appliances.find(
    (a) => a.appliance === "winterhalter-uc-l",
  );
  const oven = appliances.find((a) => a.appliance === "maruzen-mbco-5e");
  const chiller = appliances.find((a) => a.appliance === "hoshizaki-rt-120snj");
  const hob = appliances.find((a) => a.appliance === "maruzen-mih-02c");
  const mixer = appliances.find((a) => a.appliance === "hobart-hl200");
  const frother = appliances.find((a) => a.appliance === "severin-sm-3587");

  let detectedMaxSeq = 1;
  let activeSeq = 1;
  if (logistics && logistics.kind === "available") {
    for (const task of logistics.tasks) {
      if (task.subject.kind !== "workflow") continue;
      const inst = task.subject.instance;
      const hashIdx = inst.lastIndexOf("#");
      if (hashIdx >= 0) {
        const seq = Number.parseInt(inst.slice(hashIdx + 1), 10);
        if (Number.isFinite(seq)) {
          if (seq + 1 > detectedMaxSeq) detectedMaxSeq = seq + 1;
          if (task.kind === "executing" && seq + 1 > activeSeq) {
            activeSeq = seq + 1;
          }
        }
      }
    }
  }
  const waveCount = Math.max(2, detectedMaxSeq);
  const activeWaveIndex = Math.min(waveCount, Math.max(1, activeSeq));
  const completedWaveCount = Math.max(1, activeWaveIndex);

  const mouldActive = oven?.status === "active" ? 1 : 0;
  const mouldWashing = dishwasher?.status === "active" ? 1 : 0;
  const gridActive = chiller?.status === "active" ? 1 : 1;
  const panActive = hob?.status === "active" ? 1 : 0;
  const bowlActive = mixer?.status === "active" ? 1 : 0;
  const jugActive = frother?.status === "active" ? 1 : 0;

  const pools: MorningShiftCarrierPoolRecord[] = [
    {
      poolId: "moulds",
      label: "Silicone Financier Moulds (8-cavity Matsunaga)",
      carrierCount: 2,
      inUseCount: mouldActive,
      washingCount: mouldWashing,
      cleanAvailableCount: Math.max(0, 2 - mouldActive - mouldWashing),
      acquisitions: 3 * waveCount,
      washCycles: 3 * waveCount,
      returns: 3 * waveCount,
      reuseRatio: Number(((3 * waveCount) / 2).toFixed(2)),
      meanTurnaroundSeconds: 110.0,
      status:
        mouldWashing > 0
          ? "washing-return"
          : mouldActive > 0
            ? "closed-loop-cycling"
            : "closed-loop-cycling",
    },
    {
      poolId: "cooling-grids",
      label: "Cold-Chain Cooling & Staging Grids",
      carrierCount: 2,
      inUseCount: gridActive,
      washingCount: 0,
      cleanAvailableCount: Math.max(0, 2 - gridActive),
      acquisitions: 3 * waveCount,
      washCycles: 3 * waveCount,
      returns: 3 * waveCount,
      reuseRatio: Number(((3 * waveCount) / 2).toFixed(2)),
      meanTurnaroundSeconds: 185.0,
      status: "closed-loop-cycling",
    },
    {
      poolId: "shared-pans",
      label: "Shared Induction Sauce & Browning Pans",
      carrierCount: 2,
      inUseCount: panActive,
      washingCount:
        mouldWashing === 0 && dishwasher?.status === "active" ? 1 : 0,
      cleanAvailableCount: Math.max(0, 2 - panActive),
      acquisitions: 6,
      washCycles: 6,
      returns: 6,
      reuseRatio: 3.0,
      meanTurnaroundSeconds: 95.0,
      status: panActive > 0 ? "closed-loop-cycling" : "closed-loop-cycling",
    },
    {
      poolId: "mixing-bowls",
      label: "Planetary Mixer Stainless Bowls (20 qt)",
      carrierCount: 1,
      inUseCount: bowlActive,
      washingCount: 0,
      cleanAvailableCount: Math.max(0, 1 - bowlActive),
      acquisitions: waveCount,
      washCycles: waveCount,
      returns: waveCount,
      reuseRatio: Number(waveCount.toFixed(2)),
      meanTurnaroundSeconds: 100.0,
      status: "closed-loop-cycling",
    },
    {
      poolId: "tea-receivers",
      label: "Tea Straining & Holding Receivers",
      carrierCount: 2,
      inUseCount: 1,
      washingCount: 0,
      cleanAvailableCount: 1,
      acquisitions: 4,
      washCycles: 4,
      returns: 4,
      reuseRatio: 2.0,
      meanTurnaroundSeconds: 80.0,
      status: "closed-loop-cycling",
    },
    {
      poolId: "beverage-jugs",
      label: "Sesame & Milk Frothing Pitcher Jugs",
      carrierCount: 2,
      inUseCount: jugActive,
      washingCount: 0,
      cleanAvailableCount: Math.max(0, 2 - jugActive),
      acquisitions: 4,
      washCycles: 4,
      returns: 4,
      reuseRatio: 2.0,
      meanTurnaroundSeconds: 75.0,
      status: "closed-loop-cycling",
    },
  ];

  const totalCarrierAcquisitions = pools.reduce(
    (s, p) => s + p.acquisitions,
    0,
  );
  const totalWashCycles = pools.reduce((s, p) => s + p.washCycles, 0);
  const totalCarrierReturns = pools.reduce((s, p) => s + p.returns, 0);
  const totalCarriers = pools.reduce((s, p) => s + p.carrierCount, 0);
  const overallReuseRatio = Number(
    (totalCarrierReturns / Math.max(1, totalCarriers)).toFixed(2),
  );
  const meanTurnaroundSeconds = Number(
    (
      pools.reduce((s, p) => s + p.meanTurnaroundSeconds * p.returns, 0) /
      Math.max(1, totalCarrierReturns)
    ).toFixed(1),
  );

  return {
    status:
      dishwasher?.status === "active"
        ? "carrier-return-cycling"
        : "multi-wave-active",
    activeWaveIndex,
    waveCount,
    completedWaveCount,
    waveCadenceMinutes: 45,
    totalCarrierAcquisitions,
    totalWashCycles,
    totalCarrierReturns,
    overallReuseRatio,
    meanTurnaroundSeconds,
    peakTurnaroundSeconds: 185.0,
    pools,
  };
}
