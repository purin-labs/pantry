import {
  RelativeTextSelection,
  captureTextPresenceSelection,
  hasValidPlainTextShape,
  normalizePlainText,
  parseYjsEncoding,
  resolveTextPresenceSelection,
  splicePlainText,
  type ParsedYjsEncoding,
  type TextInputRange,
  type TextPresenceSelection,
  type TextSelectionDirection,
} from "@purin-labs/collaboration";
import * as Y from "yjs";
import { DESCRIPTION_LIMIT, UPDATE_LIMIT, STATE_LIMIT, STATE_VECTOR_LIMIT } from "./limits.ts";
export { DESCRIPTION_LIMIT, UPDATE_LIMIT, STATE_LIMIT, STATE_VECTOR_LIMIT } from "./limits.ts";
export { RelativeTextSelection as ProductDescriptionSelection } from "@purin-labs/collaboration";

export const PRODUCT_DESCRIPTION_SCHEMA = "product_description_crdt.v1";

const ENCODING_LIMITS = {
  state: STATE_LIMIT,
  update: UPDATE_LIMIT,
  stateVector: STATE_VECTOR_LIMIT,
} as const;

export type ProductDescriptionCrdtError = Readonly<{
  code:
    | "invalid_state"
    | "invalid_update"
    | "invalid_state_vector"
    | "invalid_document_shape"
    | "description_too_long"
    | "update_too_large"
    | "state_too_large"
    | "state_vector_too_large";
}>;

export type ProductDescriptionCrdtResult<T> =
  | Readonly<{ ok: true; value: T; error?: never }>
  | Readonly<{ ok: false; error: ProductDescriptionCrdtError; value?: never }>;

type EncodingKind = "state" | "update" | "state_vector";

// Private bytes prevent callers from mutating a parsed value after validation.
class DescriptionEncoding<K extends EncodingKind> {
  readonly #encoding: ParsedYjsEncoding<K>;
  readonly kind: K;

  private constructor(encoding: ParsedYjsEncoding<K>) {
    this.kind = encoding.kind;
    this.#encoding = encoding;
  }

  encode(): Uint8Array {
    return this.#encoding.encode();
  }

  static parse<K extends EncodingKind>(kind: K, bytes: Uint8Array): ProductDescriptionCrdtResult<DescriptionEncoding<K>> {
    const parsed = parseYjsEncoding(kind, bytes, ENCODING_LIMITS);
    if (!parsed.ok) {
      return parsed;
    }

    if (kind !== "state_vector") {
      const decoded = Y.decodeUpdate(parsed.value.encode());
      for (const struct of decoded.structs) {
        if (struct instanceof Y.Item && (
          (typeof struct.parent === "string" && struct.parent !== "description") ||
          struct.parentSub !== null ||
          !(struct.content instanceof Y.ContentString || struct.content instanceof Y.ContentDeleted)
        )) {
          return failure("invalid_document_shape");
        }
      }
    }
    return success(new DescriptionEncoding(parsed.value));
  }
}

export type ProductDescriptionState = DescriptionEncoding<"state">;
export type ProductDescriptionUpdate = DescriptionEncoding<"update">;
export type ProductDescriptionStateVector = DescriptionEncoding<"state_vector">;

export function parseProductDescriptionState(bytes: Uint8Array): ProductDescriptionCrdtResult<ProductDescriptionState> {
  return DescriptionEncoding.parse("state", bytes);
}

export function parseProductDescriptionUpdate(bytes: Uint8Array): ProductDescriptionCrdtResult<ProductDescriptionUpdate> {
  return DescriptionEncoding.parse("update", bytes);
}

export function parseProductDescriptionStateVector(bytes: Uint8Array): ProductDescriptionCrdtResult<ProductDescriptionStateVector> {
  return DescriptionEncoding.parse("state_vector", bytes);
}

export type ProductDescriptionChange =
  | Readonly<{ origin: "local"; description: string; update: ProductDescriptionUpdate }>
  | Readonly<{ origin: "remote"; description: string; update?: never }>;

export type ProductDescriptionListener = (change: ProductDescriptionChange) => void;
export type ProductDescriptionInputRange = TextInputRange;
export type ProductDescriptionPresenceSelection = TextPresenceSelection;

export class ProductDescriptionDoc {
  #doc: Y.Doc;
  readonly #listeners = new Set<ProductDescriptionListener>();

  private constructor(doc: Y.Doc) {
    this.#doc = doc;
  }

  static create(initialDescription: string): ProductDescriptionCrdtResult<ProductDescriptionDoc> {
    const description = normalizePlainText(initialDescription);
    const valid = validateDescription(description);
    if (!valid.ok) return valid;
    const doc = new Y.Doc();
    doc.getText("description").insert(0, description);
    return success(new ProductDescriptionDoc(doc));
  }

  static restore(state: ProductDescriptionState): ProductDescriptionCrdtResult<ProductDescriptionDoc> {
    const doc = new Y.Doc();
    doc.getText("description");
    try {
      Y.applyUpdate(doc, state.encode());
      const valid = validateDocument(doc);
      if (!valid.ok) {
        doc.destroy();
        return valid;
      }
      return success(new ProductDescriptionDoc(doc));
    } catch {
      doc.destroy();
      return failure("invalid_state");
    }
  }

  read(): string {
    return this.#doc.getText("description").toString();
  }

  state(): ProductDescriptionCrdtResult<ProductDescriptionState> {
    return parseProductDescriptionState(Y.encodeStateAsUpdate(this.#doc));
  }

  stateVector(): ProductDescriptionCrdtResult<ProductDescriptionStateVector> {
    return parseProductDescriptionStateVector(Y.encodeStateVector(this.#doc));
  }

  syncUpdate(remoteStateVector: ProductDescriptionStateVector): ProductDescriptionCrdtResult<ProductDescriptionUpdate> {
    try {
      return parseProductDescriptionUpdate(Y.encodeStateAsUpdate(this.#doc, remoteStateVector.encode()));
    } catch {
      return failure("invalid_state_vector");
    }
  }

  apply(update: ProductDescriptionUpdate): ProductDescriptionCrdtResult<null> {
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
    this.#notify({ origin: "remote", description: this.read() });
    return success(null);
  }

  edit(nextValue: string, inputRange?: ProductDescriptionInputRange): ProductDescriptionCrdtResult<ProductDescriptionUpdate> {
    const next = normalizePlainText(nextValue);
    const validText = validateDescription(next);
    if (!validText.ok) return validText;
    const candidate = cloneDocument(this.#doc);
    let update: ProductDescriptionUpdate;
    try {
      candidate.transact(splicePlainText.bind(null, candidate.getText("description"), this.read(), next, inputRange));
      const valid = validateDocument(candidate);
      if (!valid.ok) {
        candidate.destroy();
        return valid;
      }
      const encoded = parseProductDescriptionUpdate(Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(this.#doc)));
      if (!encoded.ok) {
        candidate.destroy();
        return encoded;
      }
      update = encoded.value;
    } catch {
      candidate.destroy();
      return failure("invalid_update");
    }
    this.#replace(candidate);
    this.#notify({ origin: "local", description: next, update });
    return success(update);
  }

  captureSelection(start: number, end: number, direction: TextSelectionDirection): RelativeTextSelection {
    return RelativeTextSelection.capture(this.#doc.getText("description"), start, end, direction);
  }

  resolveSelection(selection: RelativeTextSelection): Readonly<{ start: number; end: number; direction: TextSelectionDirection }> {
    return selection.resolve(this.#doc);
  }

  capturePresenceSelection(start: number, end: number, direction: TextSelectionDirection): ProductDescriptionPresenceSelection {
    return captureTextPresenceSelection(this.#doc.getText("description"), start, end, direction);
  }

  resolvePresenceSelection(selection: ProductDescriptionPresenceSelection): Readonly<{ start: number; end: number; direction: TextSelectionDirection }> | null {
    const text = this.#doc.getText("description");
    return resolveTextPresenceSelection(this.#doc, text, selection);
  }

  subscribe(listener: ProductDescriptionListener): void {
    this.#listeners.add(listener);
  }

  unsubscribe(listener: ProductDescriptionListener): void {
    this.#listeners.delete(listener);
  }

  destroy(): void {
    this.#listeners.clear();
    this.#doc.destroy();
  }

  #replace(candidate: Y.Doc): void {
    this.#doc.destroy();
    this.#doc = candidate;
  }

  #notify(change: ProductDescriptionChange): void {
    for (const listener of this.#listeners) listener(change);
  }
}

function cloneDocument(source: Y.Doc): Y.Doc {
  const candidate = new Y.Doc();
  candidate.getText("description");
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(source));
  // Keep this replica's identity while staging an edit; reject by discarding the clone.
  candidate.clientID = source.clientID;
  return candidate;
}

function validateDescription(value: string): ProductDescriptionCrdtResult<null> {
  if (value.length > DESCRIPTION_LIMIT) return failure("description_too_long");
  if (!hasValidPlainTextShape(value)) {
    return failure("invalid_document_shape");
  }
  return success(null);
}

function validateDocument(doc: Y.Doc): ProductDescriptionCrdtResult<null> {
  if (doc.share.size !== 1 || !doc.share.has("description")) return failure("invalid_document_shape");
  const text = doc.getText("description");
  if (Object.keys(text.getAttributes()).length !== 0) return failure("invalid_document_shape");
  for (const part of text.toDelta()) {
    if (typeof part.insert !== "string" || (part.attributes && Object.keys(part.attributes).length !== 0)) return failure("invalid_document_shape");
  }
  const validText = validateDescription(text.toString());
  if (!validText.ok) return validText;
  if (Y.encodeStateVector(doc).byteLength > STATE_VECTOR_LIMIT) return failure("state_vector_too_large");
  const state = parseProductDescriptionState(Y.encodeStateAsUpdate(doc));
  return state.ok ? success(null) : state;
}

function success<T>(value: T): ProductDescriptionCrdtResult<T> {
  return { ok: true, value };
}

function failure(code: ProductDescriptionCrdtError["code"]): ProductDescriptionCrdtResult<never> {
  return { ok: false, error: { code } };
}
