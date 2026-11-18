import {
  parseWorkflowCanvasSource,
  type WorkflowCanvasSource,
} from "@seams/bakery-model/bakery-canvas-source";
import { CanvasMove } from "@seams/workflow-canvas-crdt";
import type { CanvasMoveOutcome } from "@seams/workflow-canvas-crdt/move";
import { hasExactKeys, isPositiveInteger, isRecord } from "@seams/std";
import type { WorkflowCanvasRead } from "./workflow-canvas";
import type { CatalogExecutionContext } from "../agent-tools/catalog/execute";

export type WorkflowCanvasReadRequest = Readonly<{
  reference: WorkflowCanvasSource;
}>;
export type WorkflowCanvasMoveRequest = Readonly<{
  reference: WorkflowCanvasSource;
  destination: CanvasMove;
  expectedRevision: number;
}>;
export type WorkflowCanvasReadTool = (
  request: WorkflowCanvasReadRequest,
) => Promise<WorkflowCanvasRead>;
export type WorkflowCanvasMoveTool = (
  request: WorkflowCanvasMoveRequest,
  operationId: string,
  boundary: CatalogExecutionContext,
) => Promise<CanvasMoveOutcome>;

export function parseWorkflowCanvasReadArgs(
  args: readonly unknown[],
): WorkflowCanvasReadRequest {
  const raw = args[0];
  if (args.length !== 1 || !isRecord(raw) || !hasExactKeys(raw, ["documentId"]))
    throw new TypeError("workflow_canvas_read requires one documentId");
  return { reference: parseWorkflowCanvasSource(raw.documentId) };
}

export function parseWorkflowCanvasMoveArgs(
  args: readonly unknown[],
): WorkflowCanvasMoveRequest {
  const raw = args[0];
  if (
    args.length !== 1 ||
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "documentId",
      "objectId",
      "expectedRevision",
      "x",
      "y",
    ]) ||
    !isPositiveInteger(raw.expectedRevision)
  )
    throw new TypeError(
      "move_object requires a document, object, observed revision, and destination",
    );
  const destination = CanvasMove.parse({
    objectId: raw.objectId,
    x: raw.x,
    y: raw.y,
  });
  if (!destination.ok)
    throw new TypeError("move_object destination is invalid");
  return {
    reference: parseWorkflowCanvasSource(raw.documentId),
    expectedRevision: raw.expectedRevision,
    destination: destination.value,
  };
}
