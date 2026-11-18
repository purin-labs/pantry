import * as Y from "yjs";
import {
  parseYjsEncoding,
  type ParsedYjsEncoding,
  type YjsEncodingFailure,
  type YjsEncodingKind,
} from "@seams/collaboration";
import { hasExactKeys, isRecord } from "@seams/std";

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

export type CanvasFailureCode =
  YjsEncodingFailure["code"] | "invalid_layout" | "object_conflict";
export type CanvasResult<T> =
  | { readonly ok: true; readonly value: T; readonly error?: never }
  | {
      readonly ok: false;
      readonly error: { readonly code: CanvasFailureCode };
      readonly value?: never;
    };

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

export class CanvasEncoding<K extends YjsEncodingKind> {
  readonly #encoding: ParsedYjsEncoding<K>;
  readonly kind: K;

  private constructor(encoding: ParsedYjsEncoding<K>) {
    this.#encoding = encoding;
    this.kind = encoding.kind;
  }

  encode(): Uint8Array {
    return this.#encoding.encode();
  }

  static parse<K extends YjsEncodingKind>(
    kind: K,
    bytes: Uint8Array,
  ): CanvasResult<CanvasEncoding<K>> {
    const parsed = parseYjsEncoding(kind, bytes, CANVAS_ENCODING_LIMITS);
    if (!parsed.ok) return parsed;
    if (kind !== "state_vector") {
      for (const struct of Y.decodeUpdate(parsed.value.encode()).structs) {
        if (!(struct instanceof Y.Item)) continue;
        if (
          (typeof struct.parent === "string" &&
            struct.parent !== "positions") ||
          // Replacement items inherit the map key from their origin item.
          (struct.parentSub === null &&
            struct.origin === null &&
            struct.rightOrigin === null) ||
          !(
            struct.content instanceof Y.ContentAny ||
            struct.content instanceof Y.ContentDeleted
          )
        )
          return failure("invalid_layout");
        if (
          struct.content instanceof Y.ContentAny &&
          !struct.content.arr.every(validPoint)
        )
          return failure("invalid_layout");
      }
    }
    return success(new CanvasEncoding(parsed.value));
  }
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
  if (Y.encodeStateAsUpdate(doc).byteLength > CANVAS_ENCODING_LIMITS.state)
    return failure("state_too_large");
  if (Y.encodeStateVector(doc).byteLength > CANVAS_ENCODING_LIMITS.stateVector)
    return failure("state_vector_too_large");
  return CanvasLayout.parse(values);
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

function success<T>(value: T): CanvasResult<T> {
  return { ok: true, value };
}
function failure(code: CanvasFailureCode): CanvasResult<never> {
  return { ok: false, error: { code } };
}
