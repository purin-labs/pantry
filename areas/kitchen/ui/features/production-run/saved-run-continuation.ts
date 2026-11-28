import {
  readReplayReport,
  type ReplayReport,
} from "@purin-labs/production-simulation";
import { PRODUCTION_EXECUTION_MANIFEST } from "@purin-labs/production-simulation/execution-manifest";
import {
  parsePersistentCell,
  type PersistentCell,
} from "@purin-labs/bakery-model/bakery-physics";
import {
  ovenCheckpointContents,
  type OvenRunSource,
  type OvenSave,
} from "@purin-labs/production-simulation/runs/oven-run-file";
import { isRecord } from "@purin-labs/std";

/**
 * How the Portal continues a saved run (Refactor 16, step 8). The Portal
 * runs one engine: the build that it pins. A save of that build restores
 * its checkpoints. A save of another build gives its inputs to the engine,
 * which runs them again to the place where the save stopped.
 */

/** Whether another engine build made this save. */
function savedByAnotherBuild(save: OvenSave, bundleId: string): boolean {
  return save.document.bundle.id !== bundleId;
}

/** The origin of the `begin` request for a saved run. */
export async function continuationOrigin(save: OvenSave, bundleId: string) {
  return savedByAnotherBuild(save, bundleId)
    ? ({ kind: "replay", document: save.document } as const)
    : ({
        kind: "snapshot",
        document: save.document,
        checkpoints: await ovenCheckpointContents(save),
      } as const);
}

const READY = "Ready for review.";

/** The text of the review page, before a person starts or continues a run. */
export function reviewNotice(source: OvenRunSource): string {
  return source.kind === "snapshot" &&
    savedByAnotherBuild(source.save, PRODUCTION_EXECUTION_MANIFEST.bundle.id)
    ? "An earlier engine made this save. Continue runs its inputs again on the present engine. The results can differ from the saved recording."
    : READY;
}

/**
 * Whether the page shows its notice above the run controls: before a save
 * of another build continues, while its inputs run again, and when the
 * notice says how that run compares with the saved recording.
 */
export function replayAttention(
  source: OvenRunSource,
  replay: ReplayReport | null,
  notice: string,
): boolean {
  if (notice === READY) return false;
  return (
    notice === reviewNotice(source) ||
    (replay !== null && notice === replayNotice(replay))
  );
}

/** The replay report of a host reply, or null for a run with no replay. */
export function replayOf(reply: unknown): ReplayReport | null {
  if (!isRecord(reply)) return null;
  try {
    return readReplayReport(reply.replay);
  } catch {
    throw new Error("The execution returned an invalid replay report.");
  }
}

/**
 * The cells as the engine defines them, when the reply gives them. The
 * engine defines a cell of another build again, and the scenes of the page
 * must show the cell that runs.
 */
export function definedCells(reply: unknown): readonly PersistentCell[] | null {
  if (!isRecord(reply) || !Array.isArray(reply.cells)) return null;
  const cells = [];
  for (const raw of reply.cells) {
    const cell = parsePersistentCell(raw);
    if (cell === null)
      throw new Error("The execution returned an invalid cell definition.");
    cells.push(cell);
  }
  return cells;
}

function seconds(microseconds: number): string {
  return `${(microseconds / 1_000_000).toFixed(1)} s`;
}

const TRANSITION = {
  "task-started": "starts",
  "task-completed": "completes",
  "task-failed": "fails",
} as const;

/** What the page says while the saved inputs run again, and after. */
export function replayNotice(report: ReplayReport): string {
  if (report.state === "replaying")
    return `Running the saved inputs again on the present engine, to ${seconds(report.saved.time)}…`;
  const refused =
    report.refused.length === 0
      ? ""
      : ` ${report.refused.length} saved ${report.refused.length === 1 ? "command" : "commands"} did not apply.`;
  const difference = report.difference;
  if (difference === null)
    return `The saved inputs ran again on the present engine. Each task has the times of the saved recording.${refused}`;
  const now =
    difference.replayed === null
      ? "has no such step now"
      : `${TRANSITION[difference.transition]} at ${seconds(difference.replayed)} now`;
  const before =
    difference.saved === null
      ? "the saved recording has no such step"
      : `the saved recording has ${seconds(difference.saved)}`;
  return `The saved inputs ran again on the present engine. The run differs from the saved recording: ${difference.task} ${now}, and ${before}.${refused}`;
}
