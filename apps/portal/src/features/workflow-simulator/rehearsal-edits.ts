import type {
  BakeryRehearsalChange,
  BakeryRehearsalReview,
} from "@seams/bakery-model/bakery-surface";
import { rehearsalPreset, presetName } from "@seams/production-simulation/simulator/rehearsal-presets";
import {
  parsePhysicsRequest,
  workcellModelHash,
} from "@seams/bakery-model/bakery-physics";
import { readBundledExample } from "./bundled-example.ts";
import {
  editRehearsalWorkcells,
  type ProductionWorkcells,
  type RehearsalEdit,
} from "@seams/production-simulation/recipes/bakery/production-workcells";
import type { ReadExample } from "@seams/production-simulation/simulator/rehearsal-presets";
import { compileWorkcellInput } from "@seams/production-simulation/recipes/bakery/workcell-input";

// Tray edits of a multi-tray rehearsal. Edit trays and chat both prepare an
// edit here from the plan in view; the workspace's rehearsalEdited action then
// commits it only while that plan is still current.

export type PreparedRehearsalEdit = Readonly<{
  from: ProductionWorkcells;
  plan: ProductionWorkcells;
  notice: string;
}>;

type RehearsalEditResult =
  | Readonly<{ kind: "ready"; edit: PreparedRehearsalEdit }>
  | Readonly<{ kind: "rejected"; message: string }>;

export async function prepareRehearsalEdit(
  from: ProductionWorkcells,
  edit: RehearsalEdit,
  notice: string = trayEditNotice(edit),
): Promise<RehearsalEditResult> {
  const result = await editRehearsalWorkcells(from, edit);
  if (result.kind === "rejected") return result;
  return {
    kind: "ready",
    edit: {
      from,
      plan: result.plan,
      notice:
        result.plan === from
          ? "Ingredient load unchanged. Accepted results are kept."
          : notice,
    },
  };
}

function trayEditNotice(edit: RehearsalEdit): string {
  switch (edit.kind) {
    case "add":
      return "Loading, retrieval and racking are planned. Run in browser executes each step and carries its state forward.";
    case "human-transfer":
      return "Human transfer added: cell 1 rack → one-slot buffer → cell 2 source. Timing and placement are assumed; native evidence remains local to each cell.";
    case "ingredients":
      return `Tray ${edit.batchId} ingredient load changed. Its results were cleared; run the tray again.`;
    case "cell":
      return `Tray ${edit.batchId} assigned to ${edit.cellId}. Its results were cleared; run the tray again.`;
    case "worker":
      return `Tray ${edit.batchId} baker changed. Accepted results are kept.`;
    case "start":
      return "Start constraint changed. Accepted results are kept.";
    case "prerequisites":
      return `Tray ${edit.batchId} prerequisites changed. Accepted results are kept.`;
    case "reset":
      return `Tray ${edit.batchId} results cleared. Run in browser executes it again.`;
    case "remove":
      return `Tray ${edit.batchId} removed with its results.`;
    case "faults":
      return "Fault assumptions changed.";
    case "layout":
      return `Rack placement applied to tray ${edit.batchId}. Its results were cleared; run it in the browser to simulate the new placement.`;
  }
}

/** A browser tray chain: loading, retrieval and racking in the combined cell. */
export async function trayChainEdit(
  rackCase: "nominal" | "slip",
  read: ReadExample = readBundledExample,
): Promise<RehearsalEdit> {
  const template = await read("rack-cycle");
  if (template.kind !== "bakery-physics-rack-sequence")
    throw new Error("The combined cell template is unavailable.");
  const identity = crypto.randomUUID();
  const request = parsePhysicsRequest(
    JSON.stringify({
      ...template.loading.request,
      runId: `rehearsal-${identity}`,
      attemptId: `attempt-${identity}`,
      // A recording keeps the model it ran on. A new request names the pinned one.
      modelHash: await workcellModelHash(
        template.loading.request.robot,
        "combined",
      ),
    }),
  );
  if (request.kind === "rejected") throw new Error(request.message);
  const input = compileWorkcellInput(request.request, "0", "cold-cell-1");
  if (input.kind === "invalid") throw new Error(input.message);
  return {
    kind: "add",
    workerId: "human-1",
    input: input.input,
    successors: [
      { skill: { kind: "unload" }, earliestStartSeconds: 0 },
      { skill: { kind: "rack", rackCase }, earliestStartSeconds: 0 },
    ],
  };
}

export type PreparedRehearsalReview = Readonly<{
  edit: PreparedRehearsalEdit;
  summary: BakeryRehearsalReview;
}>;

export async function prepareRehearsalReview(
  from: ProductionWorkcells,
  change: BakeryRehearsalChange,
): Promise<
  | Readonly<{ kind: "ready"; review: PreparedRehearsalReview }>
  | Readonly<{ kind: "rejected"; message: string }>
> {
  let prepared: RehearsalEditResult;
  switch (change.kind) {
    case "replace_preset": {
      const result = await rehearsalPreset(
        change.preset,
        from.settings,
        readBundledExample,
      );
      if (result.kind === "rejected") return result;
      prepared = {
        kind: "ready",
        edit: {
          from,
          plan: result.plan,
          notice:
            change.preset === "two-trays"
              ? "Rehearsal prepared with two recorded trays. Use Edit trays to add a browser chain."
              : `${presetName(change.preset)} opened from its recorded result. Clear its results to run it in browser MuJoCo.`,
        },
      };
      break;
    }
    case "add_human_transfer":
      prepared = await prepareRehearsalEdit(from, {
        kind: "human-transfer",
        batchId: change.batchId,
      });
      break;
    case "set_ingredients":
      prepared = await prepareRehearsalEdit(from, {
        kind: "ingredients",
        batchId: change.batchId,
        ingredients: change.ingredients,
      });
      break;
    case "set_cell":
      prepared = await prepareRehearsalEdit(from, {
        kind: "cell",
        batchId: change.batchId,
        cellId: change.cellId,
      });
      break;
    case "clear_results":
      prepared = await prepareRehearsalEdit(from, {
        kind: "reset",
        batchId: change.batchId,
      });
      break;
    case "remove_tray":
      prepared = await prepareRehearsalEdit(from, {
        kind: "remove",
        batchId: change.batchId,
      });
      break;
  }
  if (prepared.kind === "rejected") return prepared;
  return {
    kind: "ready",
    review: {
      edit: prepared.edit,
      summary: {
        change,
        sourceFingerprint: from.fingerprint,
        proposedFingerprint: prepared.edit.plan.fingerprint,
        currentResults: from.operations.filter(hasAcceptedResult).length,
        proposedResults:
          prepared.edit.plan.operations.filter(hasAcceptedResult).length,
      },
    },
  };
}

function hasAcceptedResult(
  operation: ProductionWorkcells["operations"][number],
): boolean {
  return operation.attempt.kind !== "awaiting-evidence";
}
