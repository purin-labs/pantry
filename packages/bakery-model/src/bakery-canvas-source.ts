import { isRunSnapshotId } from "./bakery-run-snapshot.ts";

/** The shared canvas of one saved appliance run. */
export type WorkflowCanvasSource = Readonly<{
  kind: "saved-run";
  snapshotId: string;
}>;

export function workflowCanvasDocumentId(source: WorkflowCanvasSource): string {
  return `run:${source.snapshotId}`;
}

export function parseWorkflowCanvasSource(
  documentId: unknown,
): WorkflowCanvasSource {
  if (typeof documentId === "string" && documentId.startsWith("run:")) {
    const snapshotId = documentId.slice(4);
    if (isRunSnapshotId(snapshotId)) return { kind: "saved-run", snapshotId };
  }
  throw new Error("Invalid saved-run canvas identity.");
}
