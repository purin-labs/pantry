import { parseYjsEncoding, type ParsedYjsEncoding } from "@seams/collaboration";
import * as Y from "yjs";
import {
  PLAN_LINE_LIMIT,
  PLAN_STATE_LIMIT,
  PLAN_STATE_VECTOR_LIMIT,
  PLAN_UPDATE_LIMIT,
} from "./limits";
export {
  PLAN_LINE_LIMIT,
  PLAN_STATE_LIMIT,
  PLAN_STATE_VECTOR_LIMIT,
  PLAN_UPDATE_LIMIT,
} from "./limits";

/**
 * Plan 40D: the shared production plan of one location. Each line is a
 * production request's draft quantity, a decimal string. A request without a
 * line keeps its quantity. Two changes of one line keep the later one.
 */
export const PRODUCTION_PLAN_SCHEMA = "production_plan_crdt.v1";

export type ProductionPlanLine = Readonly<{
  requestId: string;
  quantity: string;
}>;
export type ProductionPlanSnapshot = Readonly<{
  lines: readonly ProductionPlanLine[];
}>;
/** The line that a person works on. */
export type ProductionPlanSelection = Readonly<{ requestId: string }>;

export type ProductionPlanCrdtError = Readonly<{
  code:
    | "invalid_state"
    | "invalid_update"
    | "invalid_state_vector"
    | "invalid_document_shape"
    | "collection_limit"
    | "quantity_invalid"
    | "record_conflict"
    | "update_too_large"
    | "state_too_large"
    | "state_vector_too_large";
}>;
export type ProductionPlanCrdtResult<T> =
  | Readonly<{ ok: true; value: T; error?: never }>
  | Readonly<{ ok: false; error: ProductionPlanCrdtError; value?: never }>;

type EncodingKind = "state" | "update" | "state_vector";
const ENCODING_LIMITS = {
  state: PLAN_STATE_LIMIT,
  update: PLAN_UPDATE_LIMIT,
  stateVector: PLAN_STATE_VECTOR_LIMIT,
} as const;

class PlanEncoding<K extends EncodingKind> {
  readonly #encoding: ParsedYjsEncoding<K>;
  readonly kind: K;

  private constructor(encoding: ParsedYjsEncoding<K>) {
    this.#encoding = encoding;
    this.kind = encoding.kind;
  }

  encode(): Uint8Array {
    return this.#encoding.encode();
  }

  static parse<K extends EncodingKind>(
    kind: K,
    bytes: Uint8Array,
  ): ProductionPlanCrdtResult<PlanEncoding<K>> {
    const parsed = parseYjsEncoding(kind, bytes, ENCODING_LIMITS);
    return parsed.ok ? success(new PlanEncoding(parsed.value)) : parsed;
  }
}

export type ProductionPlanState = PlanEncoding<"state">;
export type ProductionPlanUpdate = PlanEncoding<"update">;
export type ProductionPlanStateVector = PlanEncoding<"state_vector">;

export function parseProductionPlanState(
  bytes: Uint8Array,
): ProductionPlanCrdtResult<ProductionPlanState> {
  return PlanEncoding.parse("state", bytes);
}

export function parseProductionPlanUpdate(
  bytes: Uint8Array,
): ProductionPlanCrdtResult<ProductionPlanUpdate> {
  return PlanEncoding.parse("update", bytes);
}

export function parseProductionPlanStateVector(
  bytes: Uint8Array,
): ProductionPlanCrdtResult<ProductionPlanStateVector> {
  return PlanEncoding.parse("state_vector", bytes);
}

export class ProductionPlanDoc {
  #doc: Y.Doc;

  private constructor(doc: Y.Doc) {
    this.#doc = doc;
  }

  static create(): ProductionPlanDoc {
    return new ProductionPlanDoc(createEmptyDocument());
  }

  /** A new document with the same lines and none of their history. */
  static compact(
    snapshot: ProductionPlanSnapshot,
  ): ProductionPlanCrdtResult<ProductionPlanDoc> {
    const doc = createEmptyDocument();
    const lines = doc.getMap("lines");
    doc.transact(setLines.bind(null, lines, snapshot.lines));
    const valid = validateDocument(doc);
    if (!valid.ok) {
      doc.destroy();
      return valid;
    }
    return success(new ProductionPlanDoc(doc));
  }

  static restore(
    state: ProductionPlanState,
  ): ProductionPlanCrdtResult<ProductionPlanDoc> {
    const doc = createEmptyDocument();
    try {
      Y.applyUpdate(doc, state.encode());
      const valid = validateDocument(doc);
      if (!valid.ok) {
        doc.destroy();
        return valid;
      }
      return success(new ProductionPlanDoc(doc));
    } catch {
      doc.destroy();
      return failure("invalid_state");
    }
  }

  read(): ProductionPlanSnapshot {
    const lines: ProductionPlanLine[] = [];
    for (const [requestId, quantity] of this.#doc.getMap("lines"))
      if (typeof quantity === "string") lines.push({ requestId, quantity });
    lines.sort(compareLines);
    return { lines };
  }

  quantity(requestId: string): string | null {
    const value = this.#doc.getMap("lines").get(requestId);
    return typeof value === "string" ? value : null;
  }

  state(): ProductionPlanCrdtResult<ProductionPlanState> {
    return parseProductionPlanState(Y.encodeStateAsUpdate(this.#doc));
  }

  stateVector(): ProductionPlanCrdtResult<ProductionPlanStateVector> {
    return parseProductionPlanStateVector(Y.encodeStateVector(this.#doc));
  }

  syncUpdate(
    remoteStateVector: ProductionPlanStateVector,
  ): ProductionPlanCrdtResult<ProductionPlanUpdate> {
    try {
      return parseProductionPlanUpdate(
        Y.encodeStateAsUpdate(this.#doc, remoteStateVector.encode()),
      );
    } catch {
      return failure("invalid_state_vector");
    }
  }

  apply(update: ProductionPlanUpdate): ProductionPlanCrdtResult<null> {
    const candidate = cloneDocument(this.#doc);
    try {
      Y.applyUpdate(candidate, update.encode());
      const valid = validateDocument(candidate);
      if (!valid.ok) {
        candidate.destroy();
        return valid;
      }
    } catch {
      candidate.destroy();
      return failure("invalid_update");
    }
    this.#replace(candidate);
    return success(null);
  }

  /** Sets one request's draft quantity. */
  setQuantity(
    requestId: string,
    quantity: string,
  ): ProductionPlanCrdtResult<ProductionPlanUpdate> {
    if (!isPlanRequestId(requestId) || !isPlanQuantity(quantity))
      return failure("quantity_invalid");
    return this.#mutate(setLine.bind(null, requestId, quantity));
  }

  /** Removes lines, such as the lines of accepted requests. */
  clear(
    requestIds: readonly string[],
  ): ProductionPlanCrdtResult<ProductionPlanUpdate> {
    return this.#mutate(clearLines.bind(null, requestIds));
  }

  destroy(): void {
    this.#doc.destroy();
  }

  #mutate(
    operation: (doc: Y.Doc) => ProductionPlanCrdtResult<null>,
  ): ProductionPlanCrdtResult<ProductionPlanUpdate> {
    const candidate = cloneDocument(this.#doc);
    const updates: Uint8Array[] = [];
    const captureUpdate = captureYjsUpdate.bind(null, updates);
    candidate.on("update", captureUpdate);
    const changed = operation(candidate);
    candidate.off("update", captureUpdate);
    if (!changed.ok) {
      candidate.destroy();
      return changed;
    }
    const valid = validateDocument(candidate);
    if (!valid.ok) {
      candidate.destroy();
      return valid;
    }
    if (updates.length === 0) {
      candidate.destroy();
      return failure("record_conflict");
    }
    const update = parseProductionPlanUpdate(Y.mergeUpdates(updates));
    if (!update.ok) {
      candidate.destroy();
      return update;
    }
    this.#replace(candidate);
    return update;
  }

  #replace(candidate: Y.Doc): void {
    this.#doc.destroy();
    this.#doc = candidate;
  }
}

/** A production request id, as Commerce stores list entry ids. */
export function isPlanRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_:.-]{1,200}$/u.test(value);
}

/**
 * A positive decimal with at most nine digits before the point and six after
 * it, the scale that Commerce keeps for a requested quantity.
 */
export function isPlanQuantity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$/u.test(value) &&
    /[1-9]/u.test(value)
  );
}

function createEmptyDocument(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap("lines");
  return doc;
}

function cloneDocument(source: Y.Doc): Y.Doc {
  const candidate = createEmptyDocument();
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(source));
  candidate.clientID = source.clientID;
  return candidate;
}

function setLine(
  requestId: string,
  quantity: string,
  doc: Y.Doc,
): ProductionPlanCrdtResult<null> {
  const lines = doc.getMap("lines");
  if (lines.get(requestId) === quantity) return failure("record_conflict");
  lines.set(requestId, quantity);
  return success(null);
}

function setLines(
  lines: Y.Map<unknown>,
  values: readonly ProductionPlanLine[],
): void {
  for (const line of values) lines.set(line.requestId, line.quantity);
}

function clearLines(
  requestIds: readonly string[],
  doc: Y.Doc,
): ProductionPlanCrdtResult<null> {
  const lines = doc.getMap("lines");
  for (const requestId of requestIds)
    if (lines.has(requestId)) lines.delete(requestId);
  return success(null);
}

function captureYjsUpdate(updates: Uint8Array[], update: Uint8Array): void {
  updates.push(update);
}

function validateDocument(doc: Y.Doc): ProductionPlanCrdtResult<null> {
  if (doc.share.size !== 1 || !(doc.share.get("lines") instanceof Y.Map))
    return failure("invalid_document_shape");
  const lines = doc.getMap("lines");
  if (lines.size > PLAN_LINE_LIMIT) return failure("collection_limit");
  for (const [requestId, quantity] of lines)
    if (!isPlanRequestId(requestId) || !isPlanQuantity(quantity))
      return failure("invalid_document_shape");
  if (Y.encodeStateAsUpdate(doc).byteLength > PLAN_STATE_LIMIT)
    return failure("state_too_large");
  if (Y.encodeStateVector(doc).byteLength > PLAN_STATE_VECTOR_LIMIT)
    return failure("state_vector_too_large");
  return success(null);
}

function compareLines(
  first: ProductionPlanLine,
  second: ProductionPlanLine,
): number {
  return first.requestId.localeCompare(second.requestId);
}

function success<T>(value: T): ProductionPlanCrdtResult<T> {
  return { ok: true, value };
}

function failure(
  code: ProductionPlanCrdtError["code"],
): ProductionPlanCrdtResult<never> {
  return { ok: false, error: { code } };
}
