import { parseSettings, type Settings } from "@purin-labs/bakery-model/bakery";
import {
  parsePhysicsReplay,
  type PhysicsRackSequence,
  type PhysicsReplay,
} from "@purin-labs/bakery-model/bakery-physics";
import type {
  BakeryRehearsalExample,
  BakeryRehearsalPreset,
} from "@purin-labs/bakery-model/bakery-surface";
import {
  acceptProductionRecording,
  compileRehearsalWorkcells,
  restoreProductionSuccessor,
  type ProductionWorkcells,
  type ProductionWorkcellsResult,
  type RehearsalTray,
} from "../recipes/bakery/production-workcells.ts";
import {
  compileNativeCycleInput,
  compileWorkcellInput,
} from "../recipes/bakery/workcell-input.ts";
import type { CellId } from "../recipes/bakery/workcell-instances.ts";

// The single-skill examples, recreated as rehearsals on the production
// scheduler. Each opens with its recorded result accepted; clearing a tray's
// results runs it again in browser MuJoCo.
export type RehearsalPreset = BakeryRehearsalPreset;
export type ReadExample = (
  example: BakeryRehearsalExample,
) => Promise<PhysicsReplay>;

export const REHEARSAL_PRESETS: readonly Readonly<{
  id: RehearsalPreset;
  name: string;
}>[] = [
  { id: "two-trays", name: "Two recorded trays" },
  { id: "table-to-rack", name: "Table to rack" },
  { id: "table-to-oven", name: "Table to oven" },
  { id: "oven-cycle", name: "Cold oven cycle" },
  { id: "oven-table-rack", name: "Oven → table → rack" },
];

type RecordedTray = Readonly<{
  tray: RehearsalTray;
  evidence: PhysicsReplay;
}>;

export async function rehearsalPreset(
  preset: RehearsalPreset,
  settings: Settings,
  read: ReadExample,
): Promise<ProductionWorkcellsResult> {
  try {
    switch (preset) {
      case "two-trays": {
        const [cycle, transfer] = await Promise.all([
          read("oven-cycle"),
          read("table-to-rack"),
        ]);
        return await recorded(settings, [
          cycleTray("A", cycle),
          transferTray("B", transfer, "cold-cell-2"),
        ]);
      }
      case "table-to-rack":
      case "table-to-oven":
        return await recorded(settings, [
          transferTray("A", await read(preset), "cold-cell-1"),
        ]);
      case "oven-cycle":
        return await recorded(settings, [
          cycleTray("A", await read("oven-cycle")),
        ]);
      case "oven-table-rack":
        return await rackChain(settings, await read("rack-cycle"));
    }
  } catch (error) {
    return {
      kind: "rejected",
      message:
        error instanceof Error ? error.message : "Unable to open the preset.",
    };
  }
}

// A rehearsal tray is its own batch of one tray.
export function rehearsalSettings(settings: Settings): Settings {
  const parsed = parseSettings({ ...settings, traysPerBatch: 1 });
  if (parsed.kind === "invalid")
    throw new Error(`${parsed.field}: ${parsed.message}`);
  return parsed.settings;
}

// One tray from any recording, with its result accepted: a transfer, a cold
// oven cycle, or loading → retrieval → racking.
export async function rehearsalFromRecording(
  settings: Settings,
  recording: PhysicsReplay,
): Promise<ProductionWorkcellsResult> {
  try {
    switch (recording.kind) {
      case "bakery-physics-recording":
        return await recorded(settings, [
          transferTray("A", recording, "cold-cell-1"),
        ]);
      case "bakery-physics-sequence":
        return await recorded(settings, [cycleTray("A", recording)]);
      case "bakery-physics-rack-sequence":
        return await rackChain(settings, recording);
    }
  } catch (error) {
    return {
      kind: "rejected",
      message:
        error instanceof Error
          ? error.message
          : "Unable to prepare this recording.",
    };
  }
}

export function presetName(preset: RehearsalPreset): string {
  return REHEARSAL_PRESETS.find(hasPresetId.bind(null, preset))?.name ?? "";
}

async function recorded(
  settings: Settings,
  trays: readonly RecordedTray[],
): Promise<ProductionWorkcellsResult> {
  const compiled = await compileRehearsalWorkcells(settings, trays.map(trayOf));
  if (compiled.kind === "rejected") return compiled;
  let plan = compiled.plan;
  for (const { tray, evidence } of trays) {
    const accepted = acceptProductionRecording(
      plan,
      plan.fingerprint,
      `batch:${tray.batchId}:native:1`,
      evidence,
    );
    if (accepted.kind === "rejected") return accepted;
    plan = accepted.plan;
  }
  return { kind: "ready", plan };
}

// Loading, retrieval and racking replay the recorded native chain. Each
// successor's request derives from its predecessor's result and handoff digest.
async function rackChain(
  settings: Settings,
  recording: PhysicsReplay,
): Promise<ProductionWorkcellsResult> {
  if (recording.kind !== "bakery-physics-rack-sequence")
    throw new Error("The oven, table and rack example is unavailable.");
  const input = compileWorkcellInput(
    recording.loading.request,
    "0",
    "cold-cell-1",
  );
  if (input.kind === "invalid") throw new Error(input.message);
  const compiled = await compileRehearsalWorkcells(settings, [
    {
      batchId: "A",
      workerId: "human-1",
      dependsOn: [],
      earliestStartSeconds: 0,
      input: input.input,
      successors: [
        { skill: { kind: "unload" }, earliestStartSeconds: 0 },
        {
          skill: {
            kind: "rack",
            rackCase:
              recording.racking.request.case === "slip" ? "slip" : "nominal",
          },
          earliestStartSeconds: 0,
        },
      ],
    },
  ]);
  if (compiled.kind === "rejected") return compiled;
  const root = "batch:A:native:1";
  const steps: readonly [string, PhysicsReplay, string | null][] = [
    [root, recording.loading, recording.loadingHandoffDigest],
    [`${root}:2`, retrieval(recording), recording.handoffDigest],
    [`${root}:3`, recording, null],
  ];
  let plan: ProductionWorkcells = compiled.plan;
  for (const [id, evidence, digest] of steps) {
    const accepted = acceptProductionRecording(
      plan,
      plan.fingerprint,
      id,
      evidence,
    );
    if (accepted.kind === "rejected") return accepted;
    plan = accepted.plan;
    if (digest === null) continue;
    const bound = await restoreProductionSuccessor(plan, id, digest);
    if (bound.kind === "rejected") return bound;
    plan = bound.plan;
  }
  return { kind: "ready", plan };
}

function retrieval(recording: PhysicsRackSequence): PhysicsReplay {
  const parsed = parsePhysicsReplay(
    JSON.stringify({
      kind: "bakery-physics-sequence",
      schemaVersion: 2,
      handoffDigest: recording.loadingHandoffDigest,
      loading: recording.loading,
      unloading: recording.unloading,
    }),
  );
  if (parsed.kind === "rejected") throw new Error(parsed.message);
  return parsed.recording;
}

function transferTray(
  batchId: string,
  recording: PhysicsReplay,
  cell: CellId,
): RecordedTray {
  if (recording.kind !== "bakery-physics-recording")
    throw new Error("The transfer example is unavailable.");
  const input = compileWorkcellInput(recording.request, "0", cell);
  if (input.kind === "invalid") throw new Error(input.message);
  return { tray: tray(batchId, input.input), evidence: recording };
}

function cycleTray(batchId: string, recording: PhysicsReplay): RecordedTray {
  if (recording.kind !== "bakery-physics-sequence")
    throw new Error("The cold oven cycle example is unavailable.");
  const input = compileNativeCycleInput(
    recording.loading.request,
    "0",
    "cold-cell-1",
  );
  if (input.kind === "invalid") throw new Error(input.message);
  return { tray: tray(batchId, input.input), evidence: recording };
}

function tray(batchId: string, input: RehearsalTray["input"]): RehearsalTray {
  return {
    batchId,
    workerId: "human-1",
    dependsOn: [],
    earliestStartSeconds: 0,
    input,
    successors: [],
  };
}
function trayOf(recorded: RecordedTray): RehearsalTray {
  return recorded.tray;
}
function hasPresetId(
  id: RehearsalPreset,
  preset: (typeof REHEARSAL_PRESETS)[number],
): boolean {
  return preset.id === id;
}
