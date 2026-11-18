import type { BakeryProductionPanel } from "@seams/bakery-model/bakery-surface";
import type { PreparedProductionReplacement } from "./production-draft";
import type { PreparedRehearsalReview } from "./rehearsal-edits";
import type { WorkspaceRunReview } from "./workspace-run-review";
import type { CompiledProcedure } from "@seams/bakery-model/bakery-procedure";
import type {
  ProductionAssignment,
  ProductionManualTask,
  ProductionPresentation,
  ProductionScenario,
} from "@seams/bakery-model/bakery-production-scenario";
import type { PhysicsReplay } from "@seams/bakery-model/bakery-physics";
import type { NativeContinuation } from "@seams/production-simulation/recipes/bakery/native-continuation";
import type { PlaybackUpdate } from "@seams/production-simulation/simulator/playback-state";
import type {
  ProductionProcedure,
  ProductionWorkcells,
} from "@seams/production-simulation/recipes/bakery/production-workcells";
import type { RackLayoutReview } from "./rack-layout";
import type { RunSummary } from "@seams/production-simulation/simulator/run-comparison";
import type { Run } from "@seams/production-simulation/recipes/bakery/schedule";
import type { Selection } from "@seams/production-simulation/simulator/selection";

export type ProductionReady = Readonly<{
  kind: "ready";
  plan: ProductionWorkcells;
  run: Run;
}>;

export type ProductionData =
  | ProductionReady
  | Readonly<{
      kind: "loading" | "failed";
      plan?: never;
      run?: never;
    }>;

export type ProductionPending =
  | Readonly<{
      kind: "none";
      operationId?: never;
      fingerprint?: never;
      recording?: never;
      plan?: never;
      procedure?: never;
      review?: never;
    }>
  | Readonly<{
      kind: "recording";
      operationId: string;
      fingerprint: string;
      recording: PhysicsReplay;
      // A native loading or retrieval result carries the state its successor
      // resumes from.
      handoff: NativeContinuation | null;
      plan?: never;
      procedure?: never;
      review?: never;
    }>
  | Readonly<{
      kind: "run";
      review: WorkspaceRunReview;
      plan?: never;
      procedure?: never;
      operationId?: never;
      fingerprint?: never;
      recording?: never;
    }>;

export type ProductionDraftIdentity =
  | Readonly<{ kind: "new" | "uncertain"; id: string; definition?: never }>
  | Readonly<{ kind: "saved"; definition: ProductionScenario; id?: never }>;

// A financier run starts from the procedure's inputs or, as Financier + robot,
// from one batch of one tray on the same applied timings.
export type FinancierPreset = "procedure" | "one-batch";

export type ProductionSession = Readonly<{
  procedure: ProductionProcedure;
  financierPreset: FinancierPreset;
  data: ProductionData;
  // Reasons a converted rehearsal cannot run or change until started anew.
  readOnly: readonly string[];
  cursor: PlaybackUpdate;
  selection: Selection;
  operationId: string | null;
  panel: BakeryProductionPanel;
  draft: readonly ProductionAssignment[];
  manualTasks: readonly ProductionManualTask[];
  manualTaskId: string;
  presentation: ProductionPresentation;
  draftVariant: "normal" | "outage";
  draftName: string;
  draftNote: string;
  identity: ProductionDraftIdentity;
  openingDefinition: boolean;
  sourceProcedure: CompiledProcedure | null;
  savingDefinition: boolean;
  preview: ProductionReady | null;
  pending: ProductionPending;
  // A pinned run the current run is compared against, kept until replaced.
  baseline: RunSummary | null;
  rehearsalReview: PreparedRehearsalReview | null;
  replacement: PreparedProductionReplacement | null;
  // A reviewed rack translation for one rehearsal tray's first request.
  layout: Readonly<{ operationId: string; review: RackLayoutReview }> | null;
  reading: boolean;
  notice: string;
  scene: "loading" | "ready" | "unavailable";
}>;

export function initialProductionSession(
  procedure: ProductionProcedure = "financier",
  financierPreset: FinancierPreset = "procedure",
): ProductionSession {
  return {
    procedure,
    financierPreset,
    data: { kind: "loading" },
    readOnly: [],
    cursor: { time: 0, playback: "paused" },
    selection: { kind: "batch", id: "A" },
    operationId: null,
    panel: "workflow",
    draft: [],
    manualTasks: [],
    manualTaskId: "batch:A:process:stage",
    presentation: {},
    draftVariant: "normal",
    draftName: "",
    draftNote: "Assumed production timings; calibrate with a measured shift.",
    identity: { kind: "new", id: `production-${crypto.randomUUID()}` },
    openingDefinition: false,
    sourceProcedure: null,
    savingDefinition: false,
    preview: null,
    pending: { kind: "none" },
    baseline: null,
    rehearsalReview: null,
    replacement: null,
    layout: null,
    reading: false,
    notice: "Preparing production requests…",
    scene: "loading",
  };
}
