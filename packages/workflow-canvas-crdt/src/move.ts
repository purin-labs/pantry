import {
  isCollaborationOperationId,
  isShortProtocolText,
} from "@seams/collaboration";
import { hasExactKeys, isPositiveInteger, isRecord } from "@seams/std";
import { CanvasMove } from "./index";

/** A trusted Session turn, parsed once when it crosses the owning Actor boundary. */
export class CanvasAgentRequest {
  readonly #identity: Readonly<{ sessionId: string; turnId: string }>;

  private constructor(sessionId: string, turnId: string) {
    this.#identity = Object.freeze({ sessionId, turnId });
  }

  static parse(raw: unknown): CanvasAgentRequest | null {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ["sessionId", "turnId"]) ||
      !isShortProtocolText(raw.sessionId) ||
      !isShortProtocolText(raw.turnId)
    )
      return null;
    return new CanvasAgentRequest(raw.sessionId, raw.turnId);
  }

  toJSON(): Readonly<{ sessionId: string; turnId: string }> {
    return this.#identity;
  }
}

export type CanvasMoveOrigin =
  | Readonly<{ kind: "human"; request?: never }>
  | Readonly<{ kind: "agent"; request: CanvasAgentRequest }>;

/** One logical move. Retries retain all fields, including the operation ID. */
export class CanvasMoveRequest {
  readonly #destination: CanvasMove;
  readonly documentId: string;
  readonly operationId: string;
  readonly expectedRevision: number;

  private constructor(
    documentId: string,
    operationId: string,
    expectedRevision: number,
    destination: CanvasMove,
  ) {
    this.documentId = documentId;
    this.operationId = operationId;
    this.expectedRevision = expectedRevision;
    this.#destination = destination;
    Object.freeze(this);
  }

  get destination(): CanvasMove {
    return this.#destination;
  }

  static parse(raw: unknown): CanvasMoveRequest | null {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, [
        "documentId",
        "operationId",
        "expectedRevision",
        "objectId",
        "x",
        "y",
      ]) ||
      !isShortProtocolText(raw.documentId) ||
      !isCollaborationOperationId(raw.operationId) ||
      !isPositiveInteger(raw.expectedRevision)
    )
      return null;
    const destination = CanvasMove.parse({
      objectId: raw.objectId,
      x: raw.x,
      y: raw.y,
    });
    if (!destination.ok) return null;
    return new CanvasMoveRequest(
      raw.documentId,
      raw.operationId,
      raw.expectedRevision,
      destination.value,
    );
  }

  toJSON(): Readonly<{
    documentId: string;
    operationId: string;
    expectedRevision: number;
    objectId: string;
    x: number;
    y: number;
  }> {
    return {
      documentId: this.documentId,
      operationId: this.operationId,
      expectedRevision: this.expectedRevision,
      objectId: this.destination.objectId,
      x: this.destination.x,
      y: this.destination.y,
    };
  }
}

export type CanvasMoveReceipt = Readonly<{
  documentId: string;
  operationId: string;
  objectId: string;
  x: number;
  y: number;
  documentRevision: number;
}>;

export type CanvasMoveOutcome =
  | Readonly<{ kind: "accepted"; receipt: CanvasMoveReceipt; revision?: never }>
  | Readonly<{ kind: "revision_conflict"; revision: number; receipt?: never }>
  | Readonly<{
      kind: "operation_conflict" | "object_conflict" | "human_intervention";
      revision?: never;
      receipt?: never;
    }>;
