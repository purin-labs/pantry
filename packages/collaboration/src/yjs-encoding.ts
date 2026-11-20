import { exhaustiveList } from "@purin-labs/std";
import * as Y from "yjs";

export type YjsEncodingKind = "state" | "update" | "state_vector";

export type YjsEncodingLimits = Readonly<{
  state: number;
  update: number;
  stateVector: number;
}>;

export type YjsEncodingFailure = Readonly<{
  code:
    | "invalid_state"
    | "invalid_update"
    | "invalid_state_vector"
    | "update_too_large"
    | "state_too_large"
    | "state_vector_too_large";
}>;

/** Each code of an encoding failure, for the failure frame of a room. */
export const YJS_ENCODING_FAILURE_CODES = exhaustiveList<
  YjsEncodingFailure["code"]
>()([
  "invalid_state",
  "invalid_update",
  "invalid_state_vector",
  "update_too_large",
  "state_too_large",
  "state_vector_too_large",
]);

export type YjsEncodingResult<T> =
  | Readonly<{ ok: true; value: T; error?: never }>
  | Readonly<{ ok: false; error: YjsEncodingFailure; value?: never }>;

const EMPTY_STATE_VECTOR = Y.encodeStateVector(new Map<number, number>());

/** A Yjs update, state vector or document state that encodes to bytes. */
export type EncodedValue = Readonly<{ encode(): Uint8Array }>;

export class ParsedYjsEncoding<K extends YjsEncodingKind> {
  readonly #bytes: Uint8Array;
  readonly kind: K;

  private constructor(kind: K, bytes: Uint8Array) {
    this.kind = kind;
    this.#bytes = bytes.slice();
  }

  encode(): Uint8Array {
    return this.#bytes.slice();
  }

  static parse<K extends YjsEncodingKind>(
    kind: K,
    bytes: Uint8Array,
    limits: YjsEncodingLimits,
  ): YjsEncodingResult<ParsedYjsEncoding<K>> {
    const oversized = oversizedFailure(kind, bytes.byteLength, limits);
    if (oversized !== null) {
      return failure(oversized);
    }

    try {
      if (kind === "state_vector") {
        const decoded = Y.decodeStateVector(bytes);
        if (!sameBytes(canonicalStateVector(decoded), bytes)) {
          return failure("invalid_state_vector");
        }
      } else {
        // Yjs decoders leave unknown trailing bytes unread. diffUpdate consumes
        // a complete V1 update while preserving map and collection delete sets.
        if (Y.diffUpdate(bytes, EMPTY_STATE_VECTOR).byteLength !== bytes.byteLength) {
          return failure(kind === "state" ? "invalid_state" : "invalid_update");
        }
        Y.decodeUpdate(bytes);
      }
      return success(new ParsedYjsEncoding(kind, bytes));
    } catch {
      return failure(invalidFailure(kind));
    }
  }
}

export function parseYjsEncoding<K extends YjsEncodingKind>(
  kind: K,
  bytes: Uint8Array,
  limits: YjsEncodingLimits,
): YjsEncodingResult<ParsedYjsEncoding<K>> {
  return ParsedYjsEncoding.parse(kind, bytes, limits);
}

function oversizedFailure(
  kind: YjsEncodingKind,
  size: number,
  limits: YjsEncodingLimits,
): YjsEncodingFailure["code"] | null {
  switch (kind) {
    case "state":
      return size > limits.state ? "state_too_large" : null;
    case "update":
      return size > limits.update ? "update_too_large" : null;
    case "state_vector":
      return size > limits.stateVector ? "state_vector_too_large" : null;
  }
}

function invalidFailure(kind: YjsEncodingKind): YjsEncodingFailure["code"] {
  switch (kind) {
    case "state":
      return "invalid_state";
    case "update":
      return "invalid_update";
    case "state_vector":
      return "invalid_state_vector";
  }
}

function success<T>(value: T): YjsEncodingResult<T> {
  return { ok: true, value };
}

function failure(code: YjsEncodingFailure["code"]): YjsEncodingResult<never> {
  return { ok: false, error: { code } };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function canonicalStateVector(decoded: Map<number, number>): Uint8Array {
  const snapshot = Y.createSnapshot(Y.createDeleteSet(), decoded);
  return Y.encodeSnapshot(snapshot).slice(1);
}
