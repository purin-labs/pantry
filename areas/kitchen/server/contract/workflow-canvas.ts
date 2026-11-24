import type { WorkflowCanvasSource } from "@purin-labs/bakery-model/bakery-canvas-source";
import type {
  CANVAS_BOUNDS,
  CanvasMove,
} from "@purin-labs/workflow-canvas-crdt";
import type { CatalogExecutionContext } from "@purin-labs/agent-tools/catalog/execute";
import type { PreparedEffect } from "@purin-labs/agent-tools/tool-effect";

// The read and the move of a workflow canvas, as the Kitchen tool services
// name them. A part of the Kitchen contract.

export type WorkflowCanvasRead = Readonly<{
  documentId: string;
  documentRevision: number;
  bounds: typeof CANVAS_BOUNDS;
  objects: readonly Readonly<{
    objectId: string;
    label: string;
    x: number;
    y: number;
  }>[];
}>;

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
) => Promise<PreparedEffect>;
