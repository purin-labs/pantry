import {
  CanvasEncoding,
  CanvasLayout,
  CanvasMove,
  WorkflowCanvasDoc,
} from "./index";
import {
  CanvasAgentRequest,
  CanvasMoveRequest,
  type CanvasMoveOrigin,
  type CanvasMoveOutcome,
} from "./move";
import type { CanvasServerMessage } from "./protocol";

declare const move: CanvasMove;
declare const update: CanvasEncoding<"update">;
declare const layout: CanvasLayout;
declare const request: CanvasMoveRequest;
declare const agentRequest: CanvasAgentRequest;

// @ts-expect-error Accepted updates require trusted change attribution.
export const missingAttribution: CanvasServerMessage = {
  kind: "update_accepted",
  updateId: "move",
};

export const invalidAttribution: CanvasServerMessage = {
  kind: "update_accepted",
  updateId: "move",
  // @ts-expect-error The wire protocol accepts only the defined change origins.
  lastChange: "unknown",
};

export const rawAgentOrigin: CanvasMoveOrigin = {
  kind: "agent",
  // @ts-expect-error Agent requests require a parsed nominal identity.
  request: { sessionId: "session", turnId: "turn" },
};

// @ts-expect-error A spread cannot retain the private identity.
export const spreadAgentRequest: CanvasAgentRequest = { ...agentRequest };

// @ts-expect-error A human move cannot supply an agent request.
export const humanAgentOrigin: CanvasMoveOrigin = {
  kind: "human",
  request: agentRequest,
};

// @ts-expect-error A raw position must pass the boundary parser.
export const rawMove: CanvasMove = { objectId: "stage", x: 20, y: 30 };

// @ts-expect-error A spread cannot retain the private validation identity.
export const spreadMove: CanvasMove = { ...move };

// @ts-expect-error An update cannot be used as a complete saved state.
export const invalidRestore = WorkflowCanvasDoc.restore(update, layout);

// @ts-expect-error Layout construction requires validated, bounded objects.
export const rawLayout = WorkflowCanvasDoc.create([
  { objectId: "stage", x: 20, y: 30 },
]);

// @ts-expect-error A spread loses the validated request identity.
export const spreadRequest: CanvasMoveRequest = { ...request };

// @ts-expect-error A conflict cannot contain an accepted receipt.
export const conflictingReceipt: CanvasMoveOutcome = {
  kind: "revision_conflict",
  revision: 2,
  receipt: {
    documentId: "procedure",
    operationId: "move",
    objectId: "pack",
    x: 10,
    y: 20,
    documentRevision: 1,
  },
};
