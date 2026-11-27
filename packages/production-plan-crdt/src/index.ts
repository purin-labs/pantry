import {
  checkDocumentSize,
  defineSharedDoc,
  sharedDocFailure as failure,
  sharedDocSuccess as success,
  type SharedDocEncoding,
  type SharedDocError,
  type SharedDocResult,
} from "@purin-labs/collaboration";
import * as Y from "yjs";
import {
  PLAN_LINE_LIMIT,
  PLAN_STATE_LIMIT,
  PLAN_STATE_VECTOR_LIMIT,
  PLAN_UPDATE_LIMIT,
} from "./limits.ts";
export { PLAN_STATE_VECTOR_LIMIT, PLAN_UPDATE_LIMIT } from "./limits.ts";

/**
 * Plan 40D: the shared production plan of one location. Each line is a
 * production request's draft quantity, a decimal string. A request without a
 * line keeps its quantity. Two changes of one line keep the later one.
 */
export const PRODUCTION_PLAN_SCHEMA = "production_plan_crdt.v1";

type ProductionPlanLine = Readonly<{
  requestId: string;
  quantity: string;
}>;
type ProductionPlanSnapshot = Readonly<{
  lines: readonly ProductionPlanLine[];
}>;
/** The line that a person works on. */
export type ProductionPlanSelection = Readonly<{ requestId: string }>;

/** The document's own failures, beside the failures of an encoding. */
const FAILURES = [
  "invalid_document_shape",
  "collection_limit",
  "quantity_invalid",
  "record_conflict",
] as const;
export type ProductionPlanCrdtError = SharedDocError<(typeof FAILURES)[number]>;
type ProductionPlanCrdtResult<T> = SharedDocResult<
  T,
  ProductionPlanCrdtError["code"]
>;

const ENCODING_LIMITS = {
  state: PLAN_STATE_LIMIT,
  update: PLAN_UPDATE_LIMIT,
  stateVector: PLAN_STATE_VECTOR_LIMIT,
} as const;

export const productionPlanDocument = defineSharedDoc({
  schema: PRODUCTION_PLAN_SCHEMA,
  limits: ENCODING_LIMITS,
  failures: FAILURES,
  roots: { lines: "map" },
  shapeFailure: "invalid_document_shape",
  validate: validateDocument,
  unchangedFailure: "record_conflict",
});

type Schema = typeof PRODUCTION_PLAN_SCHEMA;
type ProductionPlanState = SharedDocEncoding<"state", Schema>;
export type ProductionPlanUpdate = SharedDocEncoding<"update", Schema>;
export type ProductionPlanStateVector = SharedDocEncoding<
  "state_vector",
  Schema
>;

export const parseProductionPlanState = productionPlanDocument.parseState;

export class ProductionPlanDoc extends productionPlanDocument.Doc {
  static create(): ProductionPlanDoc {
    return new ProductionPlanDoc(productionPlanDocument.emptyDocument());
  }

  /** A new document with the same lines and none of their history. */
  static compact(
    snapshot: ProductionPlanSnapshot,
  ): ProductionPlanCrdtResult<ProductionPlanDoc> {
    const doc = productionPlanDocument.emptyDocument();
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
    const doc = productionPlanDocument.restore(state);
    return doc.ok ? success(new ProductionPlanDoc(doc.value)) : doc;
  }

  read(): ProductionPlanSnapshot {
    const lines: ProductionPlanLine[] = [];
    for (const [requestId, quantity] of this.doc.getMap("lines"))
      if (typeof quantity === "string") lines.push({ requestId, quantity });
    lines.sort(compareLines);
    return { lines };
  }

  quantity(requestId: string): string | null {
    const value = this.doc.getMap("lines").get(requestId);
    return typeof value === "string" ? value : null;
  }

  /** Sets one request's draft quantity. */
  setQuantity(
    requestId: string,
    quantity: string,
  ): ProductionPlanCrdtResult<ProductionPlanUpdate> {
    if (!isPlanRequestId(requestId) || !isPlanQuantity(quantity))
      return failure("quantity_invalid");
    return this.mutate(setLine.bind(null, requestId, quantity));
  }

  /** Removes lines, such as the lines of accepted requests. */
  clear(
    requestIds: readonly string[],
  ): ProductionPlanCrdtResult<ProductionPlanUpdate> {
    return this.mutate(clearLines.bind(null, requestIds));
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

/** The check of the content. The shared document checks the root first. */
function validateDocument(doc: Y.Doc): ProductionPlanCrdtResult<null> {
  const lines = doc.getMap("lines");
  if (lines.size > PLAN_LINE_LIMIT) return failure("collection_limit");
  for (const [requestId, quantity] of lines)
    if (!isPlanRequestId(requestId) || !isPlanQuantity(quantity))
      return failure("invalid_document_shape");
  return checkDocumentSize(doc, ENCODING_LIMITS);
}

function compareLines(
  first: ProductionPlanLine,
  second: ProductionPlanLine,
): number {
  return first.requestId.localeCompare(second.requestId);
}
