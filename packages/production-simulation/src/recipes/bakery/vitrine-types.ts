import type { HumanId } from "./schedule.ts";

// The types of the vitrine demand of the simulated café: the customer orders
// and their channels, the refill waves, the stock snapshot, the rush presets
// and the saved order overrides. Moved from schedule.ts (file-size ratchet);
// they are types only, so the execution bundle of the Kitchen physics keeps
// its bytes.

export type VitrineOrderChannel =
  "counter" | "qr-order" | "walk-in" | "click-collect" | "boutique";

export type VitrineOrderStatus = "upcoming" | "waiting-refill" | "fulfilled";

export type CafeBeverageRecipeId =
  | "espresso"
  | "siphon-coffee"
  | "black-sesame-milk"
  | "ginger-black-tea"
  | "ginger-milk-tea";

export type CafeBeverageStatus =
  "upcoming" | "queued-bar" | "brewing" | "served";

export type VitrineCustomerOrder = Readonly<{
  id: string;
  channel: VitrineOrderChannel;
  channelLabel: string;
  label: string;
  orderedAt: number;
  orderedAtMinutes: number;
  defaultOrderedAt: number;
  defaultOrderedAtMinutes: number;
  isCustomArrival: boolean;
  isCustomOrder: boolean;
  fulfilledAt: number | null;
  loosePieces: number;
  ballotinBoxes: number;
  totalPieces: number;
  status: VitrineOrderStatus;
  fulfilledByWave: number | null;
  beverageRecipe: CafeBeverageRecipeId;
  beverageLabel: string;
  beverageCount: number;
  beverageEquipment: string;
  brewDurationSeconds: number;
  brewStart: number;
  brewEnd: number;
  beverageWaitSeconds: number;
  beverageStatus: CafeBeverageStatus;
}>;

export type VitrineRefillWaveStatus =
  "pending" | "packing-ballotins" | "restocking-vitrine" | "completed";

export type VitrineRefillWave = Readonly<{
  waveNumber: number;
  batchId: string;
  workerId: HumanId | null;
  packStart: number;
  refillStart: number;
  completedAt: number;
  loosePiecesAdded: number;
  ballotinBoxesAdded: number;
  totalPiecesAdded: number;
  status: VitrineRefillWaveStatus;
}>;

export type VitrineStockStatus =
  "stocked" | "low-stock" | "restocking" | "awaiting-refill";

export type VitrineRushPresetId = "quiet" | "normal" | "weekend-rush";

export type VitrineRushPresetSpec = Readonly<{
  id: VitrineRushPresetId;
  label: string;
  shortLabel: string;
  description: string;
  orderCount: number;
  totalRequestedPieces: number;
  recommendedBatchCount: number;
  recommendedWorkerCount: number;
  recommendedOvenTrays: number;
  recommendedHorizonMinutes: number;
}>;

export type VitrineStockSnapshot = Readonly<{
  rushPreset: VitrineRushPresetId;
  rushPresetLabel: string;
  recommendedBatchCount: number;
  scheduledBatchCount: number;
  batchDeficit: number;
  recommendedWorkerCount: number;
  scheduledWorkerCount: number;
  workerDeficit: number;
  recommendedOvenTrays: number;
  scheduledOvenTrays: number;
  ovenTrayDeficit: number;
  unfinishedWavesAtHorizon: number;
  capacityRecommendationLabel: string;
  autoScaleBatches: boolean;
  openingLoosePieces: number;
  openingBallotinBoxes: number;
  loosePieces: number;
  looseCapacity: number;
  ballotinBoxes: number;
  ballotinCapacity: number;
  totalAvailablePieces: number;
  lowStockThresholdLoose: number;
  status: VitrineStockStatus;
  statusLabel: string;
  soldLoosePieces: number;
  soldBallotinBoxes: number;
  restockedLoosePieces: number;
  restockedBallotinBoxes: number;
  orders: readonly VitrineCustomerOrder[];
  fulfilledOrders: readonly VitrineCustomerOrder[];
  waitingOrders: readonly VitrineCustomerOrder[];
  upcomingOrders: readonly VitrineCustomerOrder[];
  refillWaves: readonly VitrineRefillWave[];
  activeWave: VitrineRefillWave | null;
  nextWave: VitrineRefillWave | null;
  totalBeverageCups: number;
  servedBeverageCups: number;
  brewingOrder: VitrineCustomerOrder | null;
  maxBeverageWaitSeconds: number;
  barStatusLabel: string;
  customArrivalCount: number;
  hasCustomArrivals: boolean;
  customArrivalSummary: string;
}>;

export type VitrineOrderTemplate = Readonly<{
  id: string;
  channel: VitrineOrderChannel;
  channelLabel: string;
  label: string;
  orderedAt: number;
  loosePieces: number;
  ballotinBoxes: number;
  beverageRecipe?: CafeBeverageRecipeId;
  beverageLabel?: string;
  beverageCount?: number;
  beverageEquipment?: string;
  brewDurationSeconds?: number;
}>;

export type CafeBeverageSpec = Readonly<{
  recipe: CafeBeverageRecipeId;
  shortName: string;
  label: (cups: number) => string;
  equipment: string;
  brewSecondsPerCup: number;
}>;

export type VitrineOrderOverride = Readonly<{
  orderedAtMinutes?: number;
  channel?: VitrineOrderChannel;
  loosePieces?: number;
  ballotinBoxes?: number;
  beverageRecipe?: CafeBeverageRecipeId;
  beverageCount?: number;
}>;

export type VitrineOrderChannelFilter = "all" | VitrineOrderChannel;

export type VitrineDemandPresetSnapshot = Readonly<{
  overrides: readonly (readonly [string, VitrineOrderOverride])[];
  added: readonly VitrineOrderTemplate[];
}>;

export type VitrineDemandSnapshot = Readonly<{
  activePreset: VitrineRushPresetId;
  autoScaleBatches: boolean;
  presets: Readonly<Record<VitrineRushPresetId, VitrineDemandPresetSnapshot>>;
}>;

export type VitrineDemandHistoryEvent = Readonly<{
  label: string;
  coalesceKey?: string;
  before: VitrineDemandSnapshot;
  after: VitrineDemandSnapshot;
}>;

export type VitrineOrderSchedulePayload = Readonly<{
  schemaVersion: 1;
  preset: VitrineRushPresetId;
  overrides: Readonly<Record<string, VitrineOrderOverride>>;
  addedOrders: readonly VitrineOrderTemplate[];
}>;
