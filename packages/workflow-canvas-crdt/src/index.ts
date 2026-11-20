import * as Y from "yjs";
import {
  checkDocumentSize,
  defineSharedEncoding,
  sharedDocFailure as failure,
  sharedDocSuccess as success,
  type SharedDocEncoding,
  type SharedDocError,
  type SharedDocResult,
  type YjsEncodingKind,
} from "@purin-labs/collaboration";
import { hasExactKeys, isRecord } from "@purin-labs/std";

export const WORKFLOW_CANVAS_SCHEMA = "workflow_canvas_crdt.v1";
export const CANVAS_BOUNDS = Object.freeze({
  minX: 10,
  maxX: 570,
  minY: 10,
  maxY: 250,
});
export const CANVAS_OBJECT_LIMIT = 128;
export const CANVAS_ENCODING_LIMITS = Object.freeze({
  state: 128 * 1024,
  update: 64 * 1024,
  stateVector: 16 * 1024,
});

/** The document's own failures, beside the failures of an encoding. */
const FAILURES = ["invalid_layout", "object_conflict"] as const;
export type CanvasFailureCode = SharedDocError<
  (typeof FAILURES)[number]
>["code"];
export type CanvasResult<T> = SharedDocResult<T, CanvasFailureCode>;

/** A validated existing-object destination in canvas coordinates. */
export class CanvasMove {
  readonly #value: Readonly<{ objectId: string; x: number; y: number }>;

  private constructor(objectId: string, x: number, y: number) {
    this.#value = Object.freeze({ objectId, x, y });
  }

  get objectId(): string {
    return this.#value.objectId;
  }
  get x(): number {
    return this.#value.x;
  }
  get y(): number {
    return this.#value.y;
  }

  static parse(raw: unknown): CanvasResult<CanvasMove> {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ["objectId", "x", "y"]) ||
      typeof raw.objectId !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(raw.objectId) ||
      !validCoordinate(raw.x, CANVAS_BOUNDS.minX, CANVAS_BOUNDS.maxX) ||
      !validCoordinate(raw.y, CANVAS_BOUNDS.minY, CANVAS_BOUNDS.maxY)
    )
      return failure("invalid_layout");
    return success(new CanvasMove(raw.objectId, raw.x, raw.y));
  }

  toJSON(): Readonly<{ objectId: string; x: number; y: number }> {
    return this.#value;
  }
}

/** Membership comes from the workflow owner. Position updates cannot change it. */
export class CanvasLayout {
  readonly #objects: readonly CanvasMove[];

  private constructor(objects: CanvasMove[]) {
    this.#objects = Object.freeze(objects.sort(compareObjectId));
  }

  get objects(): readonly CanvasMove[] {
    return this.#objects;
  }

  static parse(raw: unknown): CanvasResult<CanvasLayout> {
    if (
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.length > CANVAS_OBJECT_LIMIT
    )
      return failure("invalid_layout");
    const objects: CanvasMove[] = [];
    const ids = new Set<string>();
    for (const value of raw) {
      const parsed = CanvasMove.parse(value);
      if (!parsed.ok) return parsed;
      if (ids.has(parsed.value.objectId)) return failure("invalid_layout");
      ids.add(parsed.value.objectId);
      objects.push(parsed.value);
    }
    return success(new CanvasLayout(objects));
  }
}

/**
 * The checked encodings of the canvas. The document class below is its own:
 * the membership comes from the workflow owner, so a restore and a check take
 * the expected layout.
 */
export const workflowCanvasEncoding = defineSharedEncoding({
  schema: WORKFLOW_CANVAS_SCHEMA,
  limits: CANVAS_ENCODING_LIMITS,
  failures: FAILURES,
  validateEncoded: (bytes) =>
    hasOnlyPositionStructs(bytes) ? null : "invalid_layout",
});

/** `CanvasEncoding.parse(kind, bytes)` gives a checked encoding. */
export const CanvasEncoding = workflowCanvasEncoding.encoding;
export type CanvasEncoding<K extends YjsEncodingKind> = SharedDocEncoding<
  K,
  typeof WORKFLOW_CANVAS_SCHEMA
>;

/** True when each struct of a state or an update is a point in `positions`. */
function hasOnlyPositionStructs(bytes: Uint8Array): boolean {
  for (const struct of Y.decodeUpdate(bytes).structs) {
    if (!(struct instanceof Y.Item)) continue;
    if (
      (typeof struct.parent === "string" && struct.parent !== "positions") ||
      // Replacement items inherit the map key from their origin item.
      (struct.parentSub === null &&
        struct.origin === null &&
        struct.rightOrigin === null) ||
      !(
        struct.content instanceof Y.ContentAny ||
        struct.content instanceof Y.ContentDeleted
      )
    )
      return false;
    if (
      struct.content instanceof Y.ContentAny &&
      !struct.content.arr.every(validPoint)
    )
      return false;
  }
  return true;
}

export class WorkflowCanvasDoc {
  #doc: Y.Doc;
  #layout: CanvasLayout;

  private constructor(doc: Y.Doc, layout: CanvasLayout) {
    this.#doc = doc;
    this.#layout = layout;
  }

  static create(layout: CanvasLayout): WorkflowCanvasDoc {
    const doc = emptyDocument();
    for (const object of layout.objects) setPosition(doc, object);
    return new WorkflowCanvasDoc(doc, layout);
  }

  static restore(
    state: CanvasEncoding<"state">,
    expected: CanvasLayout,
  ): CanvasResult<WorkflowCanvasDoc> {
    const doc = emptyDocument();
    try {
      Y.applyUpdate(doc, state.encode());
    } catch {
      doc.destroy();
      return failure("invalid_state");
    }
    const layout = validateDocument(doc, expected);
    if (!layout.ok) {
      doc.destroy();
      return layout;
    }
    return success(new WorkflowCanvasDoc(doc, layout.value));
  }

  snapshot(): CanvasLayout {
    return this.#layout;
  }

  state(): CanvasResult<CanvasEncoding<"state">> {
    return CanvasEncoding.parse("state", Y.encodeStateAsUpdate(this.#doc));
  }

  stateVector(): CanvasResult<CanvasEncoding<"state_vector">> {
    return CanvasEncoding.parse("state_vector", Y.encodeStateVector(this.#doc));
  }

  syncUpdate(
    vector: CanvasEncoding<"state_vector">,
  ): CanvasResult<CanvasEncoding<"update">> {
    return CanvasEncoding.parse(
      "update",
      Y.encodeStateAsUpdate(this.#doc, vector.encode()),
    );
  }

  move(destination: CanvasMove): CanvasResult<CanvasEncoding<"update">> {
    if (!this.#doc.getMap("positions").has(destination.objectId))
      return failure("object_conflict");
    const candidate = cloneDocument(this.#doc);
    const vector = Y.encodeStateVector(candidate);
    setPosition(candidate, destination);
    const update = CanvasEncoding.parse(
      "update",
      Y.encodeStateAsUpdate(candidate, vector),
    );
    if (!update.ok) {
      candidate.destroy();
      return update;
    }
    const accepted = this.#accept(candidate);
    return accepted.ok ? update : accepted;
  }

  apply(update: CanvasEncoding<"update">): CanvasResult<null> {
    const candidate = cloneDocument(this.#doc);
    try {
      Y.applyUpdate(candidate, update.encode());
    } catch {
      candidate.destroy();
      return failure("invalid_update");
    }
    return this.#accept(candidate);
  }

  destroy(): void {
    this.#doc.destroy();
  }

  #accept(candidate: Y.Doc): CanvasResult<null> {
    const layout = validateDocument(candidate, this.#layout);
    if (!layout.ok) {
      candidate.destroy();
      return layout;
    }
    this.#doc.destroy();
    this.#doc = candidate;
    this.#layout = layout.value;
    return success(null);
  }
}

function emptyDocument(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap("positions");
  return doc;
}

function cloneDocument(source: Y.Doc): Y.Doc {
  const doc = emptyDocument();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  doc.clientID = source.clientID;
  return doc;
}

function setPosition(doc: Y.Doc, destination: CanvasMove): void {
  doc
    .getMap("positions")
    .set(destination.objectId, { x: destination.x, y: destination.y });
}

function validateDocument(
  doc: Y.Doc,
  expected: CanvasLayout,
): CanvasResult<CanvasLayout> {
  if (doc.share.size !== 1 || !(doc.share.get("positions") instanceof Y.Map))
    return failure("invalid_layout");
  const positions = doc.getMap("positions");
  if (positions.size !== expected.objects.length)
    return failure("object_conflict");
  const values = [];
  for (const object of expected.objects) {
    const point = positions.get(object.objectId);
    if (!isRecord(point) || !hasExactKeys(point, ["x", "y"]))
      return failure("invalid_layout");
    values.push({ objectId: object.objectId, x: point.x, y: point.y });
  }
  const size = checkDocumentSize(doc, CANVAS_ENCODING_LIMITS);
  return size.ok ? CanvasLayout.parse(values) : size;
}

function validCoordinate(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

function validPoint(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    hasExactKeys(raw, ["x", "y"]) &&
    validCoordinate(raw.x, CANVAS_BOUNDS.minX, CANVAS_BOUNDS.maxX) &&
    validCoordinate(raw.y, CANVAS_BOUNDS.minY, CANVAS_BOUNDS.maxY)
  );
}

function compareObjectId(left: CanvasMove, right: CanvasMove): number {
  return left.objectId.localeCompare(right.objectId);
}
