import {
  parseWorkflowCanvasSource,
  type WorkflowCanvasSource,
} from "@purin-labs/bakery-model/bakery-canvas-source";
import { CanvasMove } from "@purin-labs/workflow-canvas-crdt";
import type { CanvasMoveOutcome } from "@purin-labs/workflow-canvas-crdt/move";
import { hasExactKeys, isPositiveInteger, isRecord } from "@purin-labs/std";
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
