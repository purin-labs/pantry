import type { Settings } from "@seams/bakery-model/bakery";
import {
  exportPhysicsRequest,
  parsePhysicsRequest,
} from "@seams/bakery-model/bakery-physics";
import type { CompiledProcedure } from "@seams/bakery-model/bakery-procedure";
import { isRecord } from "@seams/std";
import type {
  ProductionPending,
  ProductionSession,
} from "./production-session.ts";
import {
  acceptProductionRecording,
  editRehearsalWorkcells,
  exportProductionWorkcells,
  exportRehearsalWorkcells,
  parseProductionWorkcells,
  successorSkills,
  type RehearsalTray,
} from "@seams/production-simulation/recipes/bakery/production-workcells";
import { prepareWorkspaceRunReview } from "./workspace-run-review.ts";
import { productionDraftSource } from "./production-draft.ts";
import { openRehearsalDocument } from "@seams/production-simulation/simulator/rehearsal-conversion";
import { rehearsalSettings } from "@seams/production-simulation/simulator/rehearsal-presets";
import { parseNativeContinuation } from "@seams/production-simulation/recipes/bakery/native-continuation";
import { compileWorkcellInput } from "@seams/production-simulation/recipes/bakery/workcell-input";
import { parseRehearsalFile } from "@seams/production-simulation/simulator/rehearsal-file";
import { MAX_EXPERIMENT_BYTES } from "@seams/production-simulation/recipes/bakery/workcell-experiment";
import { verifyProductionSource } from "./workspace-runs-api.ts";
import type { ProductionScenarioRead } from "./production-scenario-api.ts";

type ProductionFileWorkspace =
  | Readonly<{ kind: "local" }>
  | Readonly<{
      kind: "connected";
      organisationId: string;
      readDefinition(
        organisationId: string,
        id: string,
      ): Promise<ProductionScenarioRead>;
    }>;

export async function prepareProductionFile(
  session: ProductionSession,
  settings: Settings,
  text: string,
  workspace: ProductionFileWorkspace,
  rackCase: "nominal" | "slip",
): Promise<Exclude<ProductionPending, { kind: "none" }>> {
  if (session.data.kind !== "ready")
    throw new Error("Prepare a run before importing a file.");
  if (new TextEncoder().encode(text).length > MAX_EXPERIMENT_BYTES)
    throw new Error("Choose a file within the recording size limit.");
  const raw: unknown = JSON.parse(text);
  const kind = isRecord(raw) ? (raw.kind ?? null) : null;
  const from = session.data;
  const plan = from.plan;
  const rehearsal = session.procedure === "rehearsal";
  if (
    (kind === "bakery-rehearsal-run" && !rehearsal) ||
    (kind === "bakery-production-workcells" && rehearsal)
  )
    throw new Error(
      rehearsal
        ? "Open production runs from Multi-batch + robot."
        : "Open rehearsal runs from Multi-tray rehearsal.",
    );
  let imported;
  let procedure: CompiledProcedure | null = null;
  let notes: readonly string[] = [];
  let readOnly: readonly string[] = [];
  if (
    rehearsal &&
    (kind === "bakery-rehearsal-run" ||
      kind === "bakery-orchestration-run" ||
      kind === "bakery-workcell-experiment")
  ) {
    const opened = await openRehearsalDocument(
      text,
      rehearsalSettings(settings),
    );
    if (opened.kind === "rejected") throw new Error(opened.message);
    imported = opened.conversion.plan;
    notes = opened.conversion.notes;
    readOnly = opened.conversion.readOnly;
  } else if (kind === "bakery-production-workcells") {
    const opened = await parseProductionWorkcells(text);
    if (opened.kind === "rejected") throw new Error(opened.message);
    imported = opened.plan;
    if (imported.source.kind === "shared") {
      if (workspace.kind !== "connected")
        throw new Error(
          "Open this shared production file in its workspace to verify its scenario.",
        );
      procedure = await verifyProductionSource(
        imported,
        workspace.organisationId,
        workspace.readDefinition,
      );
    }
  } else if (rehearsal && kind === null) {
    if (session.readOnly.length > 0)
      throw new Error(
        "Start a new rehearsal from this conversion before adding a request.",
      );
    const request = parsePhysicsRequest(text);
    if (request.kind === "rejected") throw new Error(request.message);
    const input = compileWorkcellInput(request.request, "0", "cold-cell-1");
    if (input.kind === "invalid") throw new Error(input.message);
    const successors = successorSkills(input.input).map(
      plannedSkill.bind(null, rackCase),
    );
    const edited = await editRehearsalWorkcells(plan, {
      kind: "add",
      workerId: "human-1",
      input: input.input,
      successors,
    });
    if (edited.kind === "rejected") throw new Error(edited.message);
    imported = edited.plan;
  } else {
    if (session.operationId === null)
      throw new Error("Choose a native operation first.");
    const handoff =
      rehearsal &&
      (kind === "bakery-physics-handoff" ||
        kind === "bakery-native-rack-handoff")
        ? parseNativeContinuation(text)
        : null;
    const parsed =
      handoff === null
        ? parseRehearsalFile(text)
        : { kind: "recording" as const, recording: handoff.predecessor };
    if (parsed.kind !== "recording")
      throw new Error(
        parsed.kind === "rejected"
          ? parsed.message
          : "Choose a native recording for this operation.",
      );
    const match = acceptProductionRecording(
      plan,
      plan.fingerprint,
      session.operationId,
      parsed.recording,
      handoff,
    );
    if (match.kind === "rejected") throw new Error(match.message);
    return {
      kind: "recording",
      operationId: session.operationId,
      fingerprint: plan.fingerprint,
      recording: parsed.recording,
      handoff,
    };
  }
  return {
    kind: "run",
    review: prepareWorkspaceRunReview({
      from,
      draft: productionDraftSource(session),
      preview: session.preview,
      name: session.draftName,
      note: session.draftNote,
      presentation: session.presentation,
      plan: imported,
      procedure,
      notes,
      readOnly,
      savedRun: null,
    }),
  };
}

function plannedSkill(
  rackCase: "nominal" | "slip",
  kind: ReturnType<typeof successorSkills>[number],
): RehearsalTray["successors"][number] {
  return {
    skill: kind === "rack" ? { kind: "rack", rackCase } : { kind: "unload" },
    earliestStartSeconds: 0,
  };
}

export type BakeryExportKind = "run" | "request" | "recording" | "handoff";
export type BakeryExportFile = Readonly<{ name: string; text: string }>;

export function exportProductionFile(
  session: ProductionSession,
  kind: BakeryExportKind,
): BakeryExportFile {
  if (session.data.kind !== "ready")
    throw new Error("Prepare a run before exporting.");
  const plan = session.data.plan;
  if (kind === "run") {
    if (session.readOnly.length > 0)
      throw new Error(
        "Start a new rehearsal from this conversion before saving it in the current format.",
      );
    return plan.procedure === "rehearsal"
      ? {
          name: "bakery-rehearsal-run.json",
          text: exportRehearsalWorkcells(plan),
        }
      : {
          name: "bakery-production-workcells.json",
          text: exportProductionWorkcells(plan),
        };
  }
  const operation = plan.operations.find(
    operationWithId.bind(null, session.operationId),
  );
  if (operation === undefined)
    throw new Error("Choose a native operation first.");
  const prefix = operation.id.replaceAll(":", "-");
  if (kind === "request")
    return {
      name: `${prefix}-request.json`,
      text: exportPhysicsRequest(operation.attempt.input.request),
    };
  if (kind === "handoff" && operation.start.kind === "continuation")
    return {
      name: `${prefix}-handoff.json`,
      text: operation.start.handoff.file,
    };
  if (
    kind === "recording" &&
    (operation.attempt.kind === "completed" ||
      operation.attempt.kind === "recovery-required")
  )
    return {
      name: `${prefix}-recording.json`,
      text: JSON.stringify(operation.attempt.recording, null, 2),
    };
  throw new Error("The selected operation has no accepted file of that kind.");
}

function operationWithId(
  id: string | null,
  operation: { id: string },
): boolean {
  return operation.id === id;
}
