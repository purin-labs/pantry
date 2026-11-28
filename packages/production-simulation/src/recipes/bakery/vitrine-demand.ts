import {
  readStoredVitrineOrders,
  writeStoredVitrineOrders,
} from "./vitrine-order-storage.ts";
import type {
  CafeBeverageRecipeId,
  CafeBeverageSpec,
  VitrineDemandHistoryEvent,
  VitrineDemandPresetSnapshot,
  VitrineDemandSnapshot,
  VitrineOrderChannel,
  VitrineOrderChannelFilter,
  VitrineOrderOverride,
  VitrineOrderSchedulePayload,
  VitrineOrderTemplate,
  VitrineRefillWave,
  VitrineRushPresetId,
  VitrineRushPresetSpec,
} from "./vitrine-types.ts";

export const VITRINE_ORDER_CHANNELS: readonly Readonly<{
  id: VitrineOrderChannel;
  label: string;
}>[] = [
  { id: "counter", label: "Counter POS" },
  { id: "qr-order", label: "Table QR" },
  { id: "walk-in", label: "Walk-in" },
  { id: "click-collect", label: "Click & Collect" },
  { id: "boutique", label: "Boutique" },
];

export const VITRINE_REFILL_YIELD = {
  openingLoosePieces: 12,
  openingBallotinBoxes: 3,
  looseCapacity: 24,
  ballotinCapacity: 8,
  lowStockThresholdLoose: 5,
  piecesPerBallotinBox: 5,
  loosePiecesPerBatchWave: 5,
  ballotinBoxesPerBatchWave: 2,
  totalPiecesPerBatchWave: 15,
} as const;

export const CAFE_BEVERAGE_ROTATION: readonly CafeBeverageSpec[] = [
  {
    recipe: "espresso",
    shortName: "Double Espresso (61E)",
    label: (c) => `${c}× Double Espresso (${c * 36} g · 61E)`,
    equipment: "Linea Classic S · Group 1",
    brewSecondsPerCup: 55,
  },
  {
    recipe: "black-sesame-milk",
    shortName: "Black Sesame Milk (61B)",
    label: (c) => `${c}× Black Sesame Milk (${c * 220} mL · 61B)`,
    equipment: "Heated Milk Mixer & Bar Jug",
    brewSecondsPerCup: 90,
  },
  {
    recipe: "ginger-black-tea",
    shortName: "Ginger Black Tea (61C)",
    label: (c) => `${c}× Ginger Black Tea (${c * 250} mL · 61C)`,
    equipment: "Bar Induction Hob & Strainer",
    brewSecondsPerCup: 95,
  },
  {
    recipe: "ginger-milk-tea",
    shortName: "Ginger Milk Tea (61D)",
    label: (c) => `${c}× Ginger Milk Tea (${c * 250} mL · 61D)`,
    equipment: "Bar Induction Hob & Pre-warmed Cup",
    brewSecondsPerCup: 110,
  },
  {
    recipe: "siphon-coffee",
    shortName: "Hario Siphon Coffee (61E)",
    label: (c) => `${c}× Hario Siphon Coffee (${c * 240} mL · 61E)`,
    equipment: "Hario ECA-3-B Vacuum Siphon",
    brewSecondsPerCup: 105,
  },
];

export const VITRINE_ORDER_TEMPLATES_BY_PRESET: Readonly<
  Record<VitrineRushPresetId, readonly VitrineOrderTemplate[]>
> = {
  quiet: [
    {
      id: "ORD-101",
      channel: "counter",
      channelLabel: "Counter POS",
      label: "Morning Espresso & 2 Warm Financiers",
      orderedAt: 10 * 60,
      loosePieces: 2,
      ballotinBoxes: 0,
    },
    {
      id: "ORD-102",
      channel: "qr-order",
      channelLabel: "Table QR",
      label: "1 Gold-Ribbon Ballotin + 1 Loose Financier",
      orderedAt: 22 * 60,
      loosePieces: 1,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-103",
      channel: "walk-in",
      channelLabel: "Walk-in",
      label: "Morning Pastry Pair (2 Loose Financiers)",
      orderedAt: 36 * 60,
      loosePieces: 2,
      ballotinBoxes: 0,
    },
    {
      id: "ORD-104",
      channel: "boutique",
      channelLabel: "Boutique",
      label: "1 Ballotin Gift Box + 2 Loose Financiers",
      orderedAt: 52 * 60,
      loosePieces: 2,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-105",
      channel: "counter",
      channelLabel: "Counter POS",
      label: "Late-Morning Café Duo (2 Loose Financiers)",
      orderedAt: 68 * 60,
      loosePieces: 2,
      ballotinBoxes: 0,
    },
  ],
  normal: [
    {
      id: "ORD-101",
      channel: "counter",
      channelLabel: "Counter POS",
      label: "Morning Espresso & 3 Warm Financiers",
      orderedAt: 8 * 60,
      loosePieces: 3,
      ballotinBoxes: 0,
    },
    {
      id: "ORD-102",
      channel: "qr-order",
      channelLabel: "Table QR",
      label: "1 Gold-Ribbon Ballotin + 2 Loose Financiers",
      orderedAt: 16 * 60,
      loosePieces: 2,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-103",
      channel: "walk-in",
      channelLabel: "Walk-in",
      label: "Patisserie Tasting Flight (4 Loose Financiers)",
      orderedAt: 25 * 60,
      loosePieces: 4,
      ballotinBoxes: 0,
    },
    {
      id: "ORD-104",
      channel: "click-collect",
      channelLabel: "Click & Collect",
      label: "2 Ballotin Gift Boxes + 2 Loose Financiers",
      orderedAt: 34 * 60,
      loosePieces: 2,
      ballotinBoxes: 2,
    },
    {
      id: "ORD-105",
      channel: "boutique",
      channelLabel: "Boutique",
      label: "1 Ballotin Gift Box + 3 Loose Financiers",
      orderedAt: 42 * 60,
      loosePieces: 3,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-106",
      channel: "counter",
      channelLabel: "Counter POS",
      label: "Café Gourmand Set (1 Ballotin + 3 Loose)",
      orderedAt: 53 * 60,
      loosePieces: 3,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-107",
      channel: "qr-order",
      channelLabel: "Table QR",
      label: "Office Gift Order (2 Ballotins + 2 Loose)",
      orderedAt: 64 * 60,
      loosePieces: 2,
      ballotinBoxes: 2,
    },
    {
      id: "ORD-108",
      channel: "walk-in",
      channelLabel: "Walk-in",
      label: "Late-Morning Showcase Box (1 Ballotin + 4 Loose)",
      orderedAt: 75 * 60,
      loosePieces: 4,
      ballotinBoxes: 1,
    },
  ],
  "weekend-rush": [
    {
      id: "ORD-101",
      channel: "counter",
      channelLabel: "Counter POS",
      label: "Early Rush Espresso & 4 Warm Financiers",
      orderedAt: 5 * 60,
      loosePieces: 4,
      ballotinBoxes: 0,
    },
    {
      id: "ORD-102",
      channel: "qr-order",
      channelLabel: "Table QR",
      label: "Weekend Brunch Table (1 Ballotin + 3 Loose)",
      orderedAt: 11 * 60,
      loosePieces: 3,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-103",
      channel: "click-collect",
      channelLabel: "Click & Collect",
      label: "VIP Gift Pre-Order (2 Ballotins + 2 Loose)",
      orderedAt: 17 * 60,
      loosePieces: 2,
      ballotinBoxes: 2,
    },
    {
      id: "ORD-104",
      channel: "walk-in",
      channelLabel: "Walk-in",
      label: "Family Tasting Flight (4 Loose Financiers)",
      orderedAt: 23 * 60,
      loosePieces: 4,
      ballotinBoxes: 0,
    },
    {
      id: "ORD-105",
      channel: "boutique",
      channelLabel: "Boutique",
      label: "Hostess Gift Box (1 Ballotin + 3 Loose)",
      orderedAt: 29 * 60,
      loosePieces: 3,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-106",
      channel: "counter",
      channelLabel: "Counter POS",
      label: "Café Counter Flight (3 Loose Financiers)",
      orderedAt: 35 * 60,
      loosePieces: 3,
      ballotinBoxes: 0,
    },
    {
      id: "ORD-107",
      channel: "click-collect",
      channelLabel: "Click & Collect",
      label: "Weekend Celebration Box (2 Ballotins + 2 Loose)",
      orderedAt: 41 * 60,
      loosePieces: 2,
      ballotinBoxes: 2,
    },
    {
      id: "ORD-108",
      channel: "qr-order",
      channelLabel: "Table QR",
      label: "Patio Brunch Table (1 Ballotin + 3 Loose)",
      orderedAt: 48 * 60,
      loosePieces: 3,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-109",
      channel: "walk-in",
      channelLabel: "Walk-in",
      label: "Boutique Showcase Trio (3 Loose Financiers)",
      orderedAt: 55 * 60,
      loosePieces: 3,
      ballotinBoxes: 0,
    },
    {
      id: "ORD-110",
      channel: "boutique",
      channelLabel: "Boutique",
      label: "Gold-Ribbon Gift Pair (2 Ballotins + 2 Loose)",
      orderedAt: 62 * 60,
      loosePieces: 2,
      ballotinBoxes: 2,
    },
    {
      id: "ORD-111",
      channel: "counter",
      channelLabel: "Counter POS",
      label: "Mid-Morning Gourmand Set (1 Ballotin + 3 Loose)",
      orderedAt: 69 * 60,
      loosePieces: 3,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-112",
      channel: "walk-in",
      channelLabel: "Walk-in",
      label: "Late Rush Assortment (1 Ballotin + 4 Loose)",
      orderedAt: 76 * 60,
      loosePieces: 4,
      ballotinBoxes: 1,
    },
  ],
};

export const VITRINE_RUSH_PRESETS: readonly VitrineRushPresetSpec[] = [
  {
    id: "quiet",
    label: "Quiet morning (5 orders · 19 pcs)",
    shortLabel: "Quiet morning",
    description:
      "Light café traffic — opening stock covers early demand (auto-scales to 2 batches · 2 workers · 4 oven trays).",
    orderCount: 5,
    totalRequestedPieces: 19,
    recommendedBatchCount: 2,
    recommendedWorkerCount: 2,
    recommendedOvenTrays: 4,
    recommendedHorizonMinutes: 120,
  },
  {
    id: "normal",
    label: "Normal morning (8 orders · 48 pcs)",
    shortLabel: "Normal morning",
    description:
      "Standard boutique traffic — ORD-105 waits for Wave 1 refill (auto-scales to 3 batches · 2 workers · 4 oven trays).",
    orderCount: 8,
    totalRequestedPieces: 48,
    recommendedBatchCount: 3,
    recommendedWorkerCount: 2,
    recommendedOvenTrays: 4,
    recommendedHorizonMinutes: 120,
  },
  {
    id: "weekend-rush",
    label: "Weekend rush (12 orders · 91 pcs)",
    shortLabel: "Weekend rush",
    description:
      "Heavy Saturday traffic — early stockout queues orders across Waves 1–5 (auto-scales to 5 batches · 3 workers · 6 oven trays).",
    orderCount: 12,
    totalRequestedPieces: 91,
    recommendedBatchCount: 5,
    recommendedWorkerCount: 3,
    recommendedOvenTrays: 6,
    recommendedHorizonMinutes: 150,
  },
] as const;

export let activeVitrineRushPreset: VitrineRushPresetId = "normal";
export let autoScaleVitrineBatches = true;
let forceApplyRecommendedCapacity = false;
let vitrineDemandRevision = 0;
const vitrineRushListeners = new Set<() => void>();

export const customOrderOverridesByPreset: Readonly<
  Record<VitrineRushPresetId, Map<string, VitrineOrderOverride>>
> = {
  quiet: new Map(),
  normal: new Map(),
  "weekend-rush": new Map(),
};

export const customAddedOrdersByPreset: Record<
  VitrineRushPresetId,
  VitrineOrderTemplate[]
> = {
  quiet: [],
  normal: [],
  "weekend-rush": [],
};

function saveCustomVitrineOrdersToStorage(): void {
  try {
    const presets: readonly VitrineRushPresetId[] = [
      "quiet",
      "normal",
      "weekend-rush",
    ];
    let hasAny = false;
    const payload: Record<
      string,
      {
        overrides: [string, VitrineOrderOverride][];
        added: VitrineOrderTemplate[];
      }
    > = {};
    for (const p of presets) {
      const overrides = Array.from(customOrderOverridesByPreset[p].entries());
      const added = customAddedOrdersByPreset[p];
      if (overrides.length > 0 || added.length > 0) {
        hasAny = true;
      }
      payload[p] = { overrides, added };
    }
    writeStoredVitrineOrders(hasAny ? JSON.stringify(payload) : null);
  } catch {
    // Ignore storage quota or access errors in restricted environments
  }
}

function loadCustomVitrineOrdersFromStorage(): void {
  try {
    const raw = readStoredVitrineOrders();
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<
      string,
      {
        overrides?: [string, VitrineOrderOverride][];
        added?: VitrineOrderTemplate[];
      }
    >;
    const presets: readonly VitrineRushPresetId[] = [
      "quiet",
      "normal",
      "weekend-rush",
    ];
    for (const p of presets) {
      const entry = parsed?.[p];
      if (!entry) continue;
      if (Array.isArray(entry.overrides)) {
        for (const [id, ov] of entry.overrides) {
          if (typeof id === "string" && ov && typeof ov === "object") {
            customOrderOverridesByPreset[p].set(id, ov);
          }
        }
      }
      if (Array.isArray(entry.added)) {
        customAddedOrdersByPreset[p].splice(
          0,
          customAddedOrdersByPreset[p].length,
          ...entry.added,
        );
      }
    }
  } catch {
    // Ignore malformed storage entries
  }
}

loadCustomVitrineOrdersFromStorage();

function notifyVitrineDemandListeners(): void {
  saveCustomVitrineOrdersToStorage();
  vitrineDemandRevision += 1;
  for (const listener of vitrineRushListeners) {
    try {
      listener();
    } catch {
      // Keep remaining subscribers and caller execution intact
    }
  }
}

export function getVitrineDemandRevision(): number {
  return vitrineDemandRevision;
}

let activeVitrineChannelFilter: VitrineOrderChannelFilter = "all";
let snapVitrineOrdersToWaves = false;

export function getActiveVitrineChannelFilter(): VitrineOrderChannelFilter {
  return activeVitrineChannelFilter;
}

export function setActiveVitrineChannelFilter(
  channel: VitrineOrderChannelFilter,
): void {
  if (activeVitrineChannelFilter === channel) return;
  activeVitrineChannelFilter = channel;
  notifyVitrineDemandListeners();
}

export function getSnapVitrineOrdersToWaves(): boolean {
  return snapVitrineOrdersToWaves;
}

export function setSnapVitrineOrdersToWaves(enabled: boolean): void {
  if (snapVitrineOrdersToWaves === enabled) return;
  snapVitrineOrdersToWaves = enabled;
  notifyVitrineDemandListeners();
}

export function snapOrderMinutesToNearestWave(
  rawMinutes: number,
  waves: readonly VitrineRefillWave[],
  maxMinutes: number,
): Readonly<{ minutes: number; snappedWave: VitrineRefillWave | null }> {
  if (waves.length === 0) {
    return {
      minutes: Math.max(1, Math.min(maxMinutes, rawMinutes)),
      snappedWave: null,
    };
  }
  let nearestWave: VitrineRefillWave = waves[0]!;
  let nearestDistance = Math.abs(
    Math.round(nearestWave.completedAt / 60) - rawMinutes,
  );
  for (const wave of waves) {
    const waveMin = Math.round(wave.completedAt / 60);
    const dist = Math.abs(waveMin - rawMinutes);
    if (dist < nearestDistance) {
      nearestDistance = dist;
      nearestWave = wave;
    }
  }
  return {
    minutes: Math.max(
      1,
      Math.min(maxMinutes, Math.round(nearestWave.completedAt / 60)),
    ),
    snappedWave: nearestWave,
  };
}

function normalizeOrderOverride(
  orderId: string,
  next: VitrineOrderOverride,
  preset: VitrineRushPresetId,
): void {
  const baseIdx = VITRINE_ORDER_TEMPLATES_BY_PRESET[preset].findIndex(
    (t) => t.id === orderId,
  );
  const baseTemplate =
    baseIdx >= 0 ? VITRINE_ORDER_TEMPLATES_BY_PRESET[preset][baseIdx] : undefined;
  const overrides = customOrderOverridesByPreset[preset];
  if (baseTemplate === undefined) {
    overrides.set(orderId, next);
    return;
  }
  const defaultMinutes = Math.round(baseTemplate.orderedAt / 60);
  const defaultBevSpec =
    CAFE_BEVERAGE_ROTATION[baseIdx % CAFE_BEVERAGE_ROTATION.length]!;
  const cleaned: {
    orderedAtMinutes?: number;
    channel?: VitrineOrderChannel;
    loosePieces?: number;
    ballotinBoxes?: number;
    beverageRecipe?: CafeBeverageRecipeId;
    beverageCount?: number;
  } = {};
  if (
    next.orderedAtMinutes !== undefined &&
    next.orderedAtMinutes !== defaultMinutes
  ) {
    cleaned.orderedAtMinutes = next.orderedAtMinutes;
  }
  if (next.channel !== undefined && next.channel !== baseTemplate.channel) {
    cleaned.channel = next.channel;
  }
  if (
    next.loosePieces !== undefined &&
    next.loosePieces !== baseTemplate.loosePieces
  ) {
    cleaned.loosePieces = next.loosePieces;
  }
  if (
    next.ballotinBoxes !== undefined &&
    next.ballotinBoxes !== baseTemplate.ballotinBoxes
  ) {
    cleaned.ballotinBoxes = next.ballotinBoxes;
  }
  if (
    next.beverageRecipe !== undefined &&
    next.beverageRecipe !== (baseTemplate.beverageRecipe ?? defaultBevSpec.recipe)
  ) {
    cleaned.beverageRecipe = next.beverageRecipe;
  }
  const effLoose = cleaned.loosePieces ?? baseTemplate.loosePieces;
  const effBoxes = cleaned.ballotinBoxes ?? baseTemplate.ballotinBoxes;
  const defaultCups =
    baseTemplate.beverageCount ??
    (effBoxes >= 2 ? 3 : effLoose >= 3 ? 2 : 1);
  if (next.beverageCount !== undefined && next.beverageCount !== defaultCups) {
    cleaned.beverageCount = next.beverageCount;
  }
  if (Object.keys(cleaned).length === 0) {
    overrides.delete(orderId);
  } else {
    overrides.set(orderId, cleaned);
  }
}

let isRestoringVitrineDemand = false;
const vitrineDemandHistoryListeners = new Set<
  (event: VitrineDemandHistoryEvent) => void
>();

function captureVitrineDemandSnapshot(): VitrineDemandSnapshot {
  const presets: readonly VitrineRushPresetId[] = [
    "quiet",
    "normal",
    "weekend-rush",
  ];
  const presetMap = {} as Record<
    VitrineRushPresetId,
    VitrineDemandPresetSnapshot
  >;
  for (const p of presets) {
    presetMap[p] = {
      overrides: Array.from(customOrderOverridesByPreset[p].entries()).map(
        ([id, ov]) => [id, { ...ov }] as const,
      ),
      added: customAddedOrdersByPreset[p].map((tpl) => ({ ...tpl })),
    };
  }
  return {
    activePreset: activeVitrineRushPreset,
    autoScaleBatches: autoScaleVitrineBatches,
    presets: presetMap,
  };
}

export function restoreVitrineDemandSnapshot(
  snapshot: VitrineDemandSnapshot,
): void {
  isRestoringVitrineDemand = true;
  try {
    activeVitrineRushPreset = snapshot.activePreset;
    autoScaleVitrineBatches = snapshot.autoScaleBatches;
    const presets: readonly VitrineRushPresetId[] = [
      "quiet",
      "normal",
      "weekend-rush",
    ];
    for (const p of presets) {
      const entry = snapshot.presets[p];
      customOrderOverridesByPreset[p].clear();
      for (const [id, ov] of entry.overrides) {
        customOrderOverridesByPreset[p].set(id, { ...ov });
      }
      customAddedOrdersByPreset[p].splice(
        0,
        customAddedOrdersByPreset[p].length,
        ...entry.added.map((tpl) => ({ ...tpl })),
      );
    }
    notifyVitrineDemandListeners();
  } finally {
    isRestoringVitrineDemand = false;
  }
}

export function subscribeVitrineDemandHistory(
  listener: (event: VitrineDemandHistoryEvent) => void,
): () => void {
  vitrineDemandHistoryListeners.add(listener);
  return () => {
    vitrineDemandHistoryListeners.delete(listener);
  };
}

function emitVitrineDemandHistory(
  label: string,
  before: VitrineDemandSnapshot,
  coalesceKey?: string,
): void {
  if (isRestoringVitrineDemand) return;
  const after = captureVitrineDemandSnapshot();
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const event: VitrineDemandHistoryEvent = {
    label,
    ...(coalesceKey !== undefined ? { coalesceKey } : {}),
    before,
    after,
  };
  for (const listener of vitrineDemandHistoryListeners) {
    try {
      listener(event);
    } catch {
      // Keep remaining listeners intact
    }
  }
}

export function setVitrineOrderArrivalMinutes(
  orderId: string,
  minutesFromStart: number,
  preset: VitrineRushPresetId = activeVitrineRushPreset,
  coalesce = true,
): void {
  const before = captureVitrineDemandSnapshot();
  const clamped = Math.max(1, Math.min(180, Math.round(minutesFromStart)));
  const existing = customOrderOverridesByPreset[preset].get(orderId) ?? {};
  normalizeOrderOverride(
    orderId,
    { ...existing, orderedAtMinutes: clamped },
    preset,
  );
  notifyVitrineDemandListeners();
  emitVitrineDemandHistory(
    `Edit order ${orderId} arrival`,
    before,
    coalesce ? `vitrine-arrival:${preset}:${orderId}` : undefined,
  );
}

export function setVitrineOrderItems(
  orderId: string,
  patch: Readonly<{
    channel?: VitrineOrderChannel;
    loosePieces?: number;
    ballotinBoxes?: number;
    beverageRecipe?: CafeBeverageRecipeId;
    beverageCount?: number;
  }>,
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): void {
  const before = captureVitrineDemandSnapshot();
  const existing = customOrderOverridesByPreset[preset].get(orderId) ?? {};
  const next: VitrineOrderOverride = {
    ...existing,
    ...(patch.channel !== undefined ? { channel: patch.channel } : {}),
    ...(patch.loosePieces !== undefined
      ? { loosePieces: Math.max(0, Math.min(24, Math.round(patch.loosePieces))) }
      : {}),
    ...(patch.ballotinBoxes !== undefined
      ? {
          ballotinBoxes: Math.max(
            0,
            Math.min(8, Math.round(patch.ballotinBoxes)),
          ),
        }
      : {}),
    ...(patch.beverageRecipe !== undefined
      ? { beverageRecipe: patch.beverageRecipe }
      : {}),
    ...(patch.beverageCount !== undefined
      ? {
          beverageCount: Math.max(
            1,
            Math.min(6, Math.round(patch.beverageCount)),
          ),
        }
      : {}),
  };
  normalizeOrderOverride(orderId, next, preset);
  notifyVitrineDemandListeners();
  emitVitrineDemandHistory(`Edit order ${orderId}`, before);
}

export function nudgeVitrineOrderArrivalMinutes(
  orderId: string,
  deltaMinutes: number,
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): void {
  const allTemplates = [
    ...VITRINE_ORDER_TEMPLATES_BY_PRESET[preset],
    ...customAddedOrdersByPreset[preset],
  ];
  const tpl = allTemplates.find((t) => t.id === orderId);
  if (tpl === undefined) return;
  const currentMinutes =
    customOrderOverridesByPreset[preset].get(orderId)?.orderedAtMinutes ??
    Math.round(tpl.orderedAt / 60);
  setVitrineOrderArrivalMinutes(
    orderId,
    currentMinutes + deltaMinutes,
    preset,
    false,
  );
}

export function shiftAllVitrineOrderArrivals(
  deltaMinutes: number,
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): void {
  const before = captureVitrineDemandSnapshot();
  const allTemplates = [
    ...VITRINE_ORDER_TEMPLATES_BY_PRESET[preset],
    ...customAddedOrdersByPreset[preset],
  ];
  const overrides = customOrderOverridesByPreset[preset];
  for (const tpl of allTemplates) {
    const existing = overrides.get(tpl.id) ?? {};
    const currentMinutes =
      existing.orderedAtMinutes ?? Math.round(tpl.orderedAt / 60);
    const nextMinutes = Math.max(
      1,
      Math.min(180, Math.round(currentMinutes + deltaMinutes)),
    );
    normalizeOrderOverride(
      tpl.id,
      { ...existing, orderedAtMinutes: nextMinutes },
      preset,
    );
  }
  notifyVitrineDemandListeners();
  emitVitrineDemandHistory("Shift all order arrivals", before);
}

export function addCustomVitrineOrder(
  options?: Readonly<{
    orderedAtMinutes?: number;
    loosePieces?: number;
    ballotinBoxes?: number;
    channel?: VitrineOrderChannel;
    beverageRecipe?: CafeBeverageRecipeId;
    beverageCount?: number;
  }>,
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): string {
  const before = captureVitrineDemandSnapshot();
  const baseTemplates = VITRINE_ORDER_TEMPLATES_BY_PRESET[preset];
  const added = customAddedOrdersByPreset[preset];
  const allTemplates = [...baseTemplates, ...added];
  const overrides = customOrderOverridesByPreset[preset];
  const nextIndex = allTemplates.length + 1;
  const id = `ORD-${100 + nextIndex}`;
  const maxExistingMinutes = allTemplates.reduce((max, tpl) => {
    const mins =
      overrides.get(tpl.id)?.orderedAtMinutes ?? Math.round(tpl.orderedAt / 60);
    return Math.max(max, mins);
  }, 10);
  const orderedAtMinutes = Math.max(
    1,
    Math.min(
      180,
      Math.round(options?.orderedAtMinutes ?? maxExistingMinutes + 8),
    ),
  );
  const loosePieces = Math.max(0, Math.round(options?.loosePieces ?? 3));
  const ballotinBoxes = Math.max(0, Math.round(options?.ballotinBoxes ?? 1));
  const channel: VitrineOrderChannel = options?.channel ?? "counter";
  const channelLabel =
    channel === "counter"
      ? "Counter POS"
      : channel === "qr-order"
        ? "Table QR"
        : channel === "click-collect"
          ? "Click & Collect"
          : channel === "boutique"
            ? "Boutique"
            : "Walk-in";
  added.push({
    id,
    channel,
    channelLabel,
    label: `Custom Café Order (${ballotinBoxes} Ballotin + ${loosePieces} Loose)`,
    orderedAt: orderedAtMinutes * 60,
    loosePieces,
    ballotinBoxes,
    ...(options?.beverageRecipe !== undefined
      ? { beverageRecipe: options.beverageRecipe }
      : {}),
    ...(options?.beverageCount !== undefined
      ? { beverageCount: options.beverageCount }
      : {}),
  });
  notifyVitrineDemandListeners();
  emitVitrineDemandHistory(`Add customer order ${id}`, before);
  return id;
}

export function removeCustomVitrineOrder(
  orderId: string,
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): void {
  const before = captureVitrineDemandSnapshot();
  const added = customAddedOrdersByPreset[preset];
  const idx = added.findIndex((o) => o.id === orderId);
  const hadOverride = customOrderOverridesByPreset[preset].delete(orderId);
  if (idx >= 0) {
    added.splice(idx, 1);
  }
  if (idx >= 0 || hadOverride) {
    notifyVitrineDemandListeners();
    emitVitrineDemandHistory(`Remove customer order ${orderId}`, before);
  }
}

export function resetCustomVitrineOrders(
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): void {
  const overrides = customOrderOverridesByPreset[preset];
  const added = customAddedOrdersByPreset[preset];
  if (overrides.size === 0 && added.length === 0) return;
  const before = captureVitrineDemandSnapshot();
  overrides.clear();
  added.length = 0;
  notifyVitrineDemandListeners();
  emitVitrineDemandHistory("Reset customer orders", before);
}

export function exportCustomVitrineOrdersJson(
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): string {
  const overridesObj: Record<string, VitrineOrderOverride> = {};
  for (const [id, ov] of customOrderOverridesByPreset[preset].entries()) {
    overridesObj[id] = ov;
  }
  const payload: VitrineOrderSchedulePayload = {
    schemaVersion: 1,
    preset,
    overrides: overridesObj,
    addedOrders: [...customAddedOrdersByPreset[preset]],
  };
  return JSON.stringify(payload, null, 2);
}

export function importCustomVitrineOrdersJson(
  jsonText: string,
  targetPreset?: VitrineRushPresetId,
): Readonly<
  | {
      ok: true;
      preset: VitrineRushPresetId;
      orderCount: number;
      customCount: number;
    }
  | { ok: false; error: string }
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: "Invalid customer order schedule JSON." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: "Customer order schedule JSON must be an object.",
    };
  }
  const record = parsed as Record<string, unknown>;
  const validPresets: readonly VitrineRushPresetId[] = [
    "quiet",
    "normal",
    "weekend-rush",
  ];
  const resolvedPreset: VitrineRushPresetId =
    targetPreset ??
    (typeof record.preset === "string" &&
    (validPresets as readonly string[]).includes(record.preset)
      ? (record.preset as VitrineRushPresetId)
      : activeVitrineRushPreset);

  const validChannels = new Set<string>(VITRINE_ORDER_CHANNELS.map((c) => c.id));
  const validBeverages = new Set<string>(
    CAFE_BEVERAGE_ROTATION.map((b) => b.recipe),
  );

  const rawOverrides = record.overrides;
  const overrideEntries: [string, unknown][] = Array.isArray(rawOverrides)
    ? rawOverrides.filter(
        (item): item is [string, unknown] =>
          Array.isArray(item) &&
          item.length === 2 &&
          typeof item[0] === "string",
      )
    : rawOverrides !== null && typeof rawOverrides === "object"
      ? Object.entries(rawOverrides as Record<string, unknown>)
      : [];

  const rawAdded = Array.isArray(record.addedOrders)
    ? record.addedOrders
    : Array.isArray(record.added)
      ? record.added
      : [];

  const nextAdded: VitrineOrderTemplate[] = [];
  for (const item of rawAdded) {
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id =
      typeof obj.id === "string" && obj.id.trim().length > 0
        ? obj.id.trim()
        : `ORD-${100 + VITRINE_ORDER_TEMPLATES_BY_PRESET[resolvedPreset].length + nextAdded.length + 1}`;
    const orderedAtMinutes =
      typeof obj.orderedAtMinutes === "number" &&
      Number.isFinite(obj.orderedAtMinutes)
        ? Math.max(1, Math.min(180, Math.round(obj.orderedAtMinutes)))
        : typeof obj.orderedAt === "number" && Number.isFinite(obj.orderedAt)
          ? Math.max(1, Math.min(180, Math.round(obj.orderedAt / 60)))
          : 90;
    const loosePieces =
      typeof obj.loosePieces === "number" && Number.isFinite(obj.loosePieces)
        ? Math.max(0, Math.min(24, Math.round(obj.loosePieces)))
        : 3;
    const ballotinBoxes =
      typeof obj.ballotinBoxes === "number" &&
      Number.isFinite(obj.ballotinBoxes)
        ? Math.max(0, Math.min(8, Math.round(obj.ballotinBoxes)))
        : 1;
    const channel: VitrineOrderChannel =
      typeof obj.channel === "string" && validChannels.has(obj.channel)
        ? (obj.channel as VitrineOrderChannel)
        : "counter";
    const channelLabel =
      VITRINE_ORDER_CHANNELS.find((c) => c.id === channel)?.label ??
      "Counter POS";
    const beverageRecipe =
      typeof obj.beverageRecipe === "string" &&
      validBeverages.has(obj.beverageRecipe)
        ? (obj.beverageRecipe as CafeBeverageRecipeId)
        : undefined;
    const beverageCount =
      typeof obj.beverageCount === "number" &&
      Number.isFinite(obj.beverageCount)
        ? Math.max(1, Math.min(6, Math.round(obj.beverageCount)))
        : undefined;
    nextAdded.push({
      id,
      channel,
      channelLabel,
      label:
        typeof obj.label === "string" && obj.label.trim().length > 0
          ? obj.label
          : `Custom Café Order (${ballotinBoxes} Ballotin + ${loosePieces} Loose)`,
      orderedAt: orderedAtMinutes * 60,
      loosePieces,
      ballotinBoxes,
      ...(beverageRecipe !== undefined ? { beverageRecipe } : {}),
      ...(beverageCount !== undefined ? { beverageCount } : {}),
    });
  }

  const before = captureVitrineDemandSnapshot();
  customOrderOverridesByPreset[resolvedPreset].clear();
  customAddedOrdersByPreset[resolvedPreset].splice(
    0,
    customAddedOrdersByPreset[resolvedPreset].length,
    ...nextAdded,
  );

  for (const [id, rawOv] of overrideEntries) {
    if (rawOv === null || typeof rawOv !== "object") continue;
    const ov = rawOv as Record<string, unknown>;
    const patch: {
      orderedAtMinutes?: number;
      channel?: VitrineOrderChannel;
      loosePieces?: number;
      ballotinBoxes?: number;
      beverageRecipe?: CafeBeverageRecipeId;
      beverageCount?: number;
    } = {};
    if (
      typeof ov.orderedAtMinutes === "number" &&
      Number.isFinite(ov.orderedAtMinutes)
    ) {
      patch.orderedAtMinutes = Math.max(
        1,
        Math.min(180, Math.round(ov.orderedAtMinutes)),
      );
    }
    if (typeof ov.channel === "string" && validChannels.has(ov.channel)) {
      patch.channel = ov.channel as VitrineOrderChannel;
    }
    if (typeof ov.loosePieces === "number" && Number.isFinite(ov.loosePieces)) {
      patch.loosePieces = Math.max(
        0,
        Math.min(24, Math.round(ov.loosePieces)),
      );
    }
    if (
      typeof ov.ballotinBoxes === "number" &&
      Number.isFinite(ov.ballotinBoxes)
    ) {
      patch.ballotinBoxes = Math.max(
        0,
        Math.min(8, Math.round(ov.ballotinBoxes)),
      );
    }
    if (
      typeof ov.beverageRecipe === "string" &&
      validBeverages.has(ov.beverageRecipe)
    ) {
      patch.beverageRecipe = ov.beverageRecipe as CafeBeverageRecipeId;
    }
    if (
      typeof ov.beverageCount === "number" &&
      Number.isFinite(ov.beverageCount)
    ) {
      patch.beverageCount = Math.max(
        1,
        Math.min(6, Math.round(ov.beverageCount)),
      );
    }
    normalizeOrderOverride(id, patch, resolvedPreset);
  }

  activeVitrineRushPreset = resolvedPreset;
  notifyVitrineDemandListeners();
  emitVitrineDemandHistory("Import customer order schedule", before);
  const totalOrderCount =
    VITRINE_ORDER_TEMPLATES_BY_PRESET[resolvedPreset].length +
    customAddedOrdersByPreset[resolvedPreset].length;
  const customCount =
    customOrderOverridesByPreset[resolvedPreset].size +
    customAddedOrdersByPreset[resolvedPreset].length;
  return {
    ok: true,
    preset: resolvedPreset,
    orderCount: totalOrderCount,
    customCount,
  };
}

export function recommendedCapacityForRushPreset(
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): Readonly<{
  batchCount: number;
  workerCount: number;
  ovenTrays: number;
  horizonMinutes: number;
}> {
  const spec =
    VITRINE_RUSH_PRESETS.find((p) => p.id === preset) ??
    VITRINE_RUSH_PRESETS[1]!;
  const added = customAddedOrdersByPreset[preset];
  const overrides = customOrderOverridesByPreset[preset];
  const hasItemOverrides = Array.from(overrides.values()).some(
    (ov) => ov.loosePieces !== undefined || ov.ballotinBoxes !== undefined,
  );
  if (added.length === 0 && !hasItemOverrides) {
    return {
      batchCount: spec.recommendedBatchCount,
      workerCount: spec.recommendedWorkerCount,
      ovenTrays: spec.recommendedOvenTrays,
      horizonMinutes: spec.recommendedHorizonMinutes,
    };
  }
  const allTemplates = [...VITRINE_ORDER_TEMPLATES_BY_PRESET[preset], ...added];
  const totalLoose = allTemplates.reduce(
    (sum, o) => sum + (overrides.get(o.id)?.loosePieces ?? o.loosePieces),
    0,
  );
  const totalBallotins = allTemplates.reduce(
    (sum, o) => sum + (overrides.get(o.id)?.ballotinBoxes ?? o.ballotinBoxes),
    0,
  );
  const batchesForLoose = Math.ceil(
    Math.max(0, totalLoose - VITRINE_REFILL_YIELD.openingLoosePieces) /
      VITRINE_REFILL_YIELD.loosePiecesPerBatchWave,
  );
  const batchesForBallotins = Math.ceil(
    Math.max(0, totalBallotins - VITRINE_REFILL_YIELD.openingBallotinBoxes) /
      VITRINE_REFILL_YIELD.ballotinBoxesPerBatchWave,
  );
  const batchCount = Math.min(
    6,
    Math.max(spec.recommendedBatchCount, batchesForLoose, batchesForBallotins),
  );
  const workerCount = Math.max(
    spec.recommendedWorkerCount,
    batchCount >= 5 ? 3 : 2,
  );
  const ovenTrays = Math.max(
    spec.recommendedOvenTrays,
    batchCount >= 5 ? 6 : 4,
  );
  const horizonMinutes = Math.max(
    spec.recommendedHorizonMinutes,
    batchCount >= 5 ? 150 : 120,
  );
  return {
    batchCount,
    workerCount,
    ovenTrays,
    horizonMinutes,
  };
}

export function shouldApplyVitrineCapacity(): boolean {
  return autoScaleVitrineBatches || forceApplyRecommendedCapacity;
}

export function applyRecommendedVitrineCapacity(): void {
  forceApplyRecommendedCapacity = true;
  try {
    notifyVitrineDemandListeners();
  } finally {
    forceApplyRecommendedCapacity = false;
  }
}

export function getAutoScaleVitrineBatches(): boolean {
  return autoScaleVitrineBatches;
}

export function setAutoScaleVitrineBatches(enabled: boolean): void {
  if (autoScaleVitrineBatches === enabled) return;
  const before = captureVitrineDemandSnapshot();
  autoScaleVitrineBatches = enabled;
  notifyVitrineDemandListeners();
  emitVitrineDemandHistory(
    enabled ? "Enable batch auto-scaling" : "Disable batch auto-scaling",
    before,
  );
}

export function getActiveVitrineRushPreset(): VitrineRushPresetId {
  return activeVitrineRushPreset;
}

export function setActiveVitrineRushPreset(preset: VitrineRushPresetId): void {
  if (activeVitrineRushPreset === preset) return;
  const before = captureVitrineDemandSnapshot();
  activeVitrineRushPreset = preset;
  notifyVitrineDemandListeners();
  const presetSpec = VITRINE_RUSH_PRESETS.find((p) => p.id === preset);
  emitVitrineDemandHistory(
    `Rush preset: ${presetSpec?.shortLabel ?? preset}`,
    before,
  );
}

export function subscribeVitrineRushPreset(listener: () => void): () => void {
  vitrineRushListeners.add(listener);
  return () => {
    vitrineRushListeners.delete(listener);
  };
}
