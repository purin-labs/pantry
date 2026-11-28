import type {
  CafeBeverageStatus,
  VitrineCustomerOrder,
  VitrineOrderStatus,
  VitrineRefillWave,
  VitrineRefillWaveStatus,
  VitrineRushPresetId,
  VitrineStockSnapshot,
  VitrineStockStatus,
} from "./vitrine-types.ts";
import type { Process, Run } from "./schedule-types.ts";
import {
  CAFE_BEVERAGE_ROTATION,
  VITRINE_ORDER_CHANNELS,
  VITRINE_ORDER_TEMPLATES_BY_PRESET,
  VITRINE_REFILL_YIELD,
  VITRINE_RUSH_PRESETS,
  activeVitrineRushPreset,
  autoScaleVitrineBatches,
  customAddedOrdersByPreset,
  customOrderOverridesByPreset,
  recommendedCapacityForRushPreset,
} from "./vitrine-demand.ts";
import { clock } from "./schedule-queries.ts";

export function vitrineStockAt(
  run: Run,
  time: number,
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): VitrineStockSnapshot {
  const baseTemplates = VITRINE_ORDER_TEMPLATES_BY_PRESET[preset];
  const addedTemplates = customAddedOrdersByPreset[preset];
  const overrides = customOrderOverridesByPreset[preset];
  const resolvedTemplates = [...baseTemplates, ...addedTemplates]
    .map((tpl, templateIdx) => {
      const isCustomOrder = templateIdx >= baseTemplates.length;
      const ov = overrides.get(tpl.id);
      const orderedAt =
        ov?.orderedAtMinutes !== undefined
          ? ov.orderedAtMinutes * 60
          : tpl.orderedAt;
      const orderedAtMinutes = Math.round(orderedAt / 60);
      const defaultOrderedAt = tpl.orderedAt;
      const defaultOrderedAtMinutes = Math.round(defaultOrderedAt / 60);
      const loosePieces = ov?.loosePieces ?? tpl.loosePieces;
      const ballotinBoxes = ov?.ballotinBoxes ?? tpl.ballotinBoxes;
      const channel = ov?.channel ?? tpl.channel;
      const channelLabel =
        VITRINE_ORDER_CHANNELS.find((c) => c.id === channel)?.label ??
        tpl.channelLabel;
      const beverageRecipe = ov?.beverageRecipe ?? tpl.beverageRecipe;
      const beverageCount = ov?.beverageCount ?? tpl.beverageCount;
      const isCustomArrival =
        isCustomOrder ||
        orderedAt !== defaultOrderedAt ||
        channel !== tpl.channel ||
        loosePieces !== tpl.loosePieces ||
        ballotinBoxes !== tpl.ballotinBoxes ||
        ov?.beverageRecipe !== undefined ||
        ov?.beverageCount !== undefined;
      return {
        ...tpl,
        channel,
        channelLabel,
        loosePieces,
        ballotinBoxes,
        ...(beverageRecipe !== undefined ? { beverageRecipe } : {}),
        ...(beverageCount !== undefined ? { beverageCount } : {}),
        templateIdx,
        orderedAt,
        orderedAtMinutes,
        defaultOrderedAt,
        defaultOrderedAtMinutes,
        isCustomArrival,
        isCustomOrder,
      };
    })
    .sort(
      (a, b) => a.orderedAt - b.orderedAt || a.templateIdx - b.templateIdx,
    );
  const presetSpec =
    VITRINE_RUSH_PRESETS.find((p) => p.id === preset) ??
    VITRINE_RUSH_PRESETS[1]!;
  const recCapacity = recommendedCapacityForRushPreset(preset);
  const packProcesses = run.intervals
    .filter(
      (t): t is Process => t.kind === "process" && t.operation === "pack",
    )
    .slice()
    .sort((a, b) => a.start - b.start);

  const packByBatch = new Map<string, Process>();
  for (const task of packProcesses) {
    packByBatch.set(task.batch, task);
  }
  const packDurationSec = Math.max(60, run.settings.pack * 60);
  let lastPackStart =
    packProcesses.length > 0
      ? packProcesses[packProcesses.length - 1]!.arrival
      : 3600;

  const refillWaves: VitrineRefillWave[] = run.batches.map((batch, idx) => {
    const task = packByBatch.get(batch.id);
    const packStart =
      task !== undefined
        ? task.start === 0
          ? 0
          : task.arrival
        : (lastPackStart += 1160);
    const completedAt =
      task !== undefined ? task.end : packStart + packDurationSec;
    const refillStart = Math.round(
      packStart + (completedAt - packStart) * 0.68,
    );
    if (task !== undefined) {
      lastPackStart = packStart;
    }
    let status: VitrineRefillWaveStatus = "pending";
    if (task !== undefined && time >= completedAt) {
      status = "completed";
    } else if (task !== undefined && time >= refillStart) {
      status = "restocking-vitrine";
    } else if (task !== undefined && time >= packStart) {
      status = "packing-ballotins";
    }
    return {
      waveNumber: idx + 1,
      batchId: batch.id,
      workerId: task !== undefined && task.attended ? task.executor : null,
      packStart,
      refillStart,
      completedAt,
      loosePiecesAdded: VITRINE_REFILL_YIELD.loosePiecesPerBatchWave,
      ballotinBoxesAdded: VITRINE_REFILL_YIELD.ballotinBoxesPerBatchWave,
      totalPiecesAdded: VITRINE_REFILL_YIELD.totalPiecesPerBatchWave,
      status,
    };
  });

  // Build chronological timeline of order arrivals and completed refill waves up to `time`
  let loosePieces: number = VITRINE_REFILL_YIELD.openingLoosePieces;
  let ballotinBoxes: number = VITRINE_REFILL_YIELD.openingBallotinBoxes;
  let soldLoosePieces = 0;
  let soldBallotinBoxes = 0;
  let restockedLoosePieces = 0;
  let restockedBallotinBoxes = 0;
  let latestWaveNumber: number | null = null;

  let barAvailableAt = 0;
  const orderStates = resolvedTemplates.map((tpl) => {
    const defaultBevSpec =
      CAFE_BEVERAGE_ROTATION[tpl.templateIdx % CAFE_BEVERAGE_ROTATION.length]!;
    const beverageRecipe = tpl.beverageRecipe ?? defaultBevSpec.recipe;
    const bevSpec =
      CAFE_BEVERAGE_ROTATION.find((b) => b.recipe === beverageRecipe) ??
      defaultBevSpec;
    const beverageCount =
      tpl.beverageCount ??
      (tpl.ballotinBoxes >= 2 ? 3 : tpl.loosePieces >= 3 ? 2 : 1);
    const beverageLabel = tpl.beverageLabel ?? bevSpec.label(beverageCount);
    const beverageEquipment = tpl.beverageEquipment ?? bevSpec.equipment;
    const brewDurationSeconds =
      tpl.brewDurationSeconds ??
      Math.min(280, bevSpec.brewSecondsPerCup * beverageCount);
    const brewStart = Math.max(tpl.orderedAt, barAvailableAt);
    const brewEnd = brewStart + brewDurationSeconds;
    barAvailableAt = brewEnd;
    const beverageWaitSeconds = brewEnd - tpl.orderedAt;
    const beverageStatus: CafeBeverageStatus =
      time < tpl.orderedAt
        ? "upcoming"
        : time < brewStart
          ? "queued-bar"
          : time < brewEnd
            ? "brewing"
            : "served";
    return {
      id: tpl.id,
      channel: tpl.channel,
      channelLabel: tpl.channelLabel,
      label: tpl.label,
      orderedAt: tpl.orderedAt,
      orderedAtMinutes: tpl.orderedAtMinutes,
      defaultOrderedAt: tpl.defaultOrderedAt,
      defaultOrderedAtMinutes: tpl.defaultOrderedAtMinutes,
      isCustomArrival: tpl.isCustomArrival,
      isCustomOrder: tpl.isCustomOrder,
      loosePieces: tpl.loosePieces,
      ballotinBoxes: tpl.ballotinBoxes,
      totalPieces:
        tpl.loosePieces +
        tpl.ballotinBoxes * VITRINE_REFILL_YIELD.piecesPerBallotinBox,
      status: "upcoming" as VitrineOrderStatus,
      fulfilledAt: null as number | null,
      fulfilledByWave: null as number | null,
      beverageRecipe,
      beverageLabel,
      beverageCount,
      beverageEquipment,
      brewDurationSeconds,
      brewStart,
      brewEnd,
      beverageWaitSeconds,
      beverageStatus,
    };
  });

  type EventItem =
    | { readonly kind: "wave"; readonly at: number; readonly wave: VitrineRefillWave }
    | { readonly kind: "order"; readonly at: number; readonly orderIndex: number };

  const events: EventItem[] = [];
  for (const wave of refillWaves) {
    if (wave.status === "completed") {
      events.push({ kind: "wave", at: wave.completedAt, wave });
    }
  }
  orderStates.forEach((ord, idx) => {
    if (ord.orderedAt <= time) {
      events.push({ kind: "order", at: ord.orderedAt, orderIndex: idx });
    }
  });
  events.sort((a, b) =>
    a.at !== b.at ? a.at - b.at : a.kind === "wave" ? -1 : 1,
  );

  const tryFulfillWaiting = (now: number) => {
    for (const ord of orderStates) {
      if (ord.status !== "waiting-refill") continue;
      if (
        loosePieces >= ord.loosePieces &&
        ballotinBoxes >= ord.ballotinBoxes
      ) {
        loosePieces -= ord.loosePieces;
        ballotinBoxes -= ord.ballotinBoxes;
        soldLoosePieces += ord.loosePieces;
        soldBallotinBoxes += ord.ballotinBoxes;
        ord.status = "fulfilled";
        ord.fulfilledAt = now;
        ord.fulfilledByWave = latestWaveNumber;
      }
    }
  };

  for (const ev of events) {
    if (ev.kind === "wave") {
      loosePieces = Math.min(
        VITRINE_REFILL_YIELD.looseCapacity,
        loosePieces + ev.wave.loosePiecesAdded,
      );
      ballotinBoxes = Math.min(
        VITRINE_REFILL_YIELD.ballotinCapacity,
        ballotinBoxes + ev.wave.ballotinBoxesAdded,
      );
      restockedLoosePieces += ev.wave.loosePiecesAdded;
      restockedBallotinBoxes += ev.wave.ballotinBoxesAdded;
      latestWaveNumber = ev.wave.waveNumber;
      tryFulfillWaiting(ev.at);
    } else {
      const ord = orderStates[ev.orderIndex]!;
      const hasEarlierWaiting = orderStates.some(
        (o) => o.status === "waiting-refill",
      );
      if (
        !hasEarlierWaiting &&
        loosePieces >= ord.loosePieces &&
        ballotinBoxes >= ord.ballotinBoxes
      ) {
        loosePieces -= ord.loosePieces;
        ballotinBoxes -= ord.ballotinBoxes;
        soldLoosePieces += ord.loosePieces;
        soldBallotinBoxes += ord.ballotinBoxes;
        ord.status = "fulfilled";
        ord.fulfilledAt = ev.at;
        ord.fulfilledByWave = latestWaveNumber;
      } else {
        ord.status = "waiting-refill";
      }
    }
  }

  const orders: readonly VitrineCustomerOrder[] = orderStates;
  const fulfilledOrders = orders.filter((o) => o.status === "fulfilled");
  const waitingOrders = orders.filter((o) => o.status === "waiting-refill");
  const upcomingOrders = orders.filter((o) => o.status === "upcoming");
  const totalBeverageCups = orders.reduce((sum, o) => sum + o.beverageCount, 0);
  const servedBeverageCups = orders
    .filter((o) => o.beverageStatus === "served")
    .reduce((sum, o) => sum + o.beverageCount, 0);
  const brewingOrder =
    orders.find((o) => o.beverageStatus === "brewing") ?? null;
  const maxBeverageWaitSeconds = orders.reduce(
    (max, o) => Math.max(max, o.beverageWaitSeconds),
    0,
  );
  const barStatusLabel =
    brewingOrder !== null
      ? `Brewing ${brewingOrder.beverageLabel} (${brewingOrder.id} · ${brewingOrder.beverageEquipment})`
      : `${servedBeverageCups} / ${totalBeverageCups} cups served · Peak bar wait ${maxBeverageWaitSeconds} s (< 900 s SLA)`;
  const customArrivalCount = orders.filter((o) => o.isCustomArrival).length;
  const hasCustomArrivals = customArrivalCount > 0;
  const firstOrderAt = orders[0]?.orderedAt ?? 0;
  const lastOrderAt = orders[orders.length - 1]?.orderedAt ?? 0;
  const customArrivalSummary = hasCustomArrivals
    ? `${customArrivalCount} custom arrival${customArrivalCount === 1 ? "" : "s"} edited (${orders.length} orders · ${clock(firstOrderAt)}–${clock(lastOrderAt)})`
    : `Default preset schedule (${orders.length} orders · ${clock(firstOrderAt)}–${clock(lastOrderAt)})`;
  const activeWave =
    refillWaves.find(
      (w) =>
        w.status === "packing-ballotins" || w.status === "restocking-vitrine",
    ) ?? null;
  const nextWave = refillWaves.find((w) => w.status === "pending") ?? null;

  let status: VitrineStockStatus = "stocked";
  let statusLabel = "Vitrine stocked";
  if (activeWave !== null && activeWave.status === "restocking-vitrine") {
    status = "restocking";
    statusLabel = `Restocking vitrine (Wave ${activeWave.waveNumber} · Batch ${activeWave.batchId})`;
  } else if (waitingOrders.length > 0) {
    status = "awaiting-refill";
    const targetWave = activeWave ?? nextWave;
    statusLabel =
      targetWave !== null
        ? `${waitingOrders.length} customer order${waitingOrders.length === 1 ? "" : "s"} awaiting Wave ${targetWave.waveNumber} (Batch ${targetWave.batchId})`
        : `${waitingOrders.length} customer order${waitingOrders.length === 1 ? "" : "s"} awaiting vitrine refill`;
  } else if (
    loosePieces <= VITRINE_REFILL_YIELD.lowStockThresholdLoose ||
    ballotinBoxes === 0
  ) {
    status = "low-stock";
    const targetWave = activeWave ?? nextWave;
    statusLabel =
      targetWave !== null
        ? `Low showcase stock · Wave ${targetWave.waveNumber} (Batch ${targetWave.batchId}) queued`
        : "Low showcase stock";
  }

  const recommendedBatchCount = recCapacity.batchCount;
  const scheduledBatchCount = run.settings.batchCount;
  const batchDeficit = Math.max(0, recommendedBatchCount - scheduledBatchCount);
  const recommendedWorkerCount = recCapacity.workerCount;
  const scheduledWorkerCount = run.settings.workerCount;
  const workerDeficit = Math.max(
    0,
    recommendedWorkerCount - scheduledWorkerCount,
  );
  const recommendedOvenTrays = recCapacity.ovenTrays;
  const scheduledOvenTrays = run.settings.ovenTrays;
  const ovenTrayDeficit = Math.max(
    0,
    recommendedOvenTrays - scheduledOvenTrays,
  );
  const unfinishedWavesAtHorizon = refillWaves.filter(
    (w) => w.completedAt > run.end || !packByBatch.has(w.batchId),
  ).length;
  const capacityRecommendationLabel =
    workerDeficit > 0 || ovenTrayDeficit > 0
      ? `${scheduledWorkerCount} / ${recommendedWorkerCount} workers · ${scheduledOvenTrays} / ${recommendedOvenTrays} oven trays (Recommend ${recommendedWorkerCount} workers & ${recommendedOvenTrays} oven trays for ${recommendedBatchCount} batches)`
      : unfinishedWavesAtHorizon > 0
        ? `${scheduledWorkerCount} / ${recommendedWorkerCount} workers · ${scheduledOvenTrays} / ${recommendedOvenTrays} oven trays (${unfinishedWavesAtHorizon} wave${unfinishedWavesAtHorizon === 1 ? "" : "s"} beyond ${Math.round(run.end / 60)} min horizon)`
        : `${scheduledWorkerCount} / ${recommendedWorkerCount} workers · ${scheduledOvenTrays} / ${recommendedOvenTrays} oven trays (All ${scheduledBatchCount} waves complete in shift)`;

  return {
    rushPreset: preset,
    rushPresetLabel: presetSpec.label,
    recommendedBatchCount,
    scheduledBatchCount,
    batchDeficit,
    recommendedWorkerCount,
    scheduledWorkerCount,
    workerDeficit,
    recommendedOvenTrays,
    scheduledOvenTrays,
    ovenTrayDeficit,
    unfinishedWavesAtHorizon,
    capacityRecommendationLabel,
    autoScaleBatches: autoScaleVitrineBatches,
    openingLoosePieces: VITRINE_REFILL_YIELD.openingLoosePieces,
    openingBallotinBoxes: VITRINE_REFILL_YIELD.openingBallotinBoxes,
    loosePieces,
    looseCapacity: VITRINE_REFILL_YIELD.looseCapacity,
    ballotinBoxes,
    ballotinCapacity: VITRINE_REFILL_YIELD.ballotinCapacity,
    totalAvailablePieces:
      loosePieces +
      ballotinBoxes * VITRINE_REFILL_YIELD.piecesPerBallotinBox,
    lowStockThresholdLoose: VITRINE_REFILL_YIELD.lowStockThresholdLoose,
    status,
    statusLabel,
    soldLoosePieces,
    soldBallotinBoxes,
    restockedLoosePieces,
    restockedBallotinBoxes,
    orders,
    fulfilledOrders,
    waitingOrders,
    upcomingOrders,
    refillWaves,
    activeWave,
    nextWave,
    totalBeverageCups,
    servedBeverageCups,
    brewingOrder,
    maxBeverageWaitSeconds,
    barStatusLabel,
    customArrivalCount,
    hasCustomArrivals,
    customArrivalSummary,
  };
}
