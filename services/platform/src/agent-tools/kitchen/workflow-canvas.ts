import {
  parseWorkflowCanvasMoveArgs,
  parseWorkflowCanvasReadArgs,
} from "../../actors/workflow-canvas-tools";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import { CANVAS_BOUNDS } from "@purin-labs/workflow-canvas-crdt";
import { jsonSchema } from "../define-tool";
import { defineKitchenTool } from "./services";

export const workflowCanvasRead = defineKitchenTool({
  name: "workflow_canvas_read",
  description:
    "Read shared workflow object IDs, step labels, positions, bounds, and the current document revision. Match named steps by label. documentId is run:<saved-run snapshot ID> from bakery_saved_run_read. Read again after a position conflict.",
  input: jsonSchema({
    type: "object",
    properties: { documentId: { type: "string", maxLength: 256 } },
    required: ["documentId"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseWorkflowCanvasReadArgs([input]),
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceEntityPlaneContext,
  },
  unavailable: "workflow canvas read is unavailable",
  handler: ({ readWorkflowCanvas }) =>
    readWorkflowCanvas === undefined ? undefined : (request) => readWorkflowCanvas(request),
});

export const workflowCanvasMove = defineKitchenTool({
  name: "move_object",
  description:
    "Move one existing workflow object to an absolute canvas position. Use the revision from workflow_canvas_read. If a human changes an object, leave that object unchanged for the rest of this request. A position change preserves operational settings and relationships.",
  input: jsonSchema({
    type: "object",
    properties: {
      documentId: { type: "string", maxLength: 256 },
      objectId: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,99}$" },
      expectedRevision: { type: "integer", minimum: 1 },
      x: {
        type: "number",
        minimum: CANVAS_BOUNDS.minX,
        maximum: CANVAS_BOUNDS.maxX,
      },
      y: {
        type: "number",
        minimum: CANVAS_BOUNDS.minY,
        maximum: CANVAS_BOUNDS.maxY,
      },
    },
    required: ["documentId", "objectId", "expectedRevision", "x", "y"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseWorkflowCanvasMoveArgs([input]),
  effect: "draft",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceWorkflowCanvasMove,
  },
  unavailable: "move object is unavailable",
  handler: ({ moveWorkflowCanvasObject }) =>
    moveWorkflowCanvasObject === undefined
      ? undefined
      : (request, call) =>
          moveWorkflowCanvasObject(request, call.operationId, call.execution),
});
