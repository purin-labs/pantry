import { hasLoneSurrogate, isRecord } from "@purin-labs/std";

/**
 * Plan 78: reads a JSON value with the rules of a serde derive, for ports of
 * Rust code that deserialize before they validate. Any shape error throws
 * `SerdeRejection`; the caller maps it to the Rust error for that boundary.
 * The value is the parsed JSON that Rust read as bytes, so a number is the
 * double that `JSON.stringify` wrote.
 */
export class SerdeRejection extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`serde rejected ${path}`);
    this.path = path;
    this.name = "SerdeRejection";
  }
}

function reject(path: string): never {
  throw new SerdeRejection(path);
}

/** A struct. With `fields`, other keys are refused, as `deny_unknown_fields`. */
export function struct(
  value: unknown,
  path: string,
  fields?: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) reject(path);
  for (const key of Object.keys(value)) {
    if (hasLoneSurrogate(key)) reject(path);
    if (fields !== undefined && !fields.includes(key)) reject(`${path}.${key}`);
  }
  return value;
}

/** A required field. serde refuses a missing one. */
export function required(
  object: Record<string, unknown>,
  key: string,
): unknown {
  if (!Object.hasOwn(object, key)) reject(key);
  return object[key];
}

/** `Option<T>`: missing and `null` are `None`. */
export function optional<T>(
  object: Record<string, unknown>,
  key: string,
  read: (value: unknown, path: string) => T,
): T | null {
  const value = object[key];
  return value === undefined || value === null ? null : read(value, key);
}

export function text(value: unknown, path: string): string {
  if (typeof value !== "string" || hasLoneSurrogate(value)) reject(path);
  return value;
}

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") reject(path);
  return value;
}

/** A JSON integer literal; `JSON.stringify` writes 1e21 and above with an exponent. */
function integer(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    Math.abs(value) >= 1e21
  )
    reject(path);
  return value === 0 ? 0 : value;
}

export function u64(value: unknown, path: string): number {
  const number = integer(value, path);
  if (number < 0 || number >= 18446744073709551616) reject(path);
  return number;
}

export function i64(value: unknown, path: string): number {
  const number = integer(value, path);
  if (number < -9223372036854775808 || number >= 9223372036854775808)
    reject(path);
  return number;
}

export function list<T>(
  value: unknown,
  path: string,
  read: (item: unknown, path: string) => T,
): T[] {
  if (!Array.isArray(value)) reject(path);
  return value.map((item, index) => read(item, `${path}[${index}]`));
}

/** A unit-only enum, written as one of its names. */
export function name<T extends string>(
  value: unknown,
  path: string,
  names: readonly T[],
): T {
  if (typeof value !== "string" || !names.includes(value as T)) reject(path);
  return value as T;
}

/**
 * Where serde reads from. Bytes and a `serde_json::Value` read a variant tag
 * as a name only. Content that serde buffered, such as the variant fields
 * after an internal tag, also accepts the variant's declaration index.
 */
type SerdeSource = "direct" | "buffered";
let source: SerdeSource = "direct";

/** Reads with serde rules for one source. */
export function fromSource<T>(next: SerdeSource, read: () => T): T {
  const previous = source;
  source = next;
  try {
    return read();
  } finally {
    source = previous;
  }
}

/** Reads the fields of a variant after its internal tag, which serde buffers. */
export function buffered<T>(read: () => T): T {
  return fromSource("buffered", read);
}

/**
 * The tag of an internally tagged enum, in the Rust declaration order of
 * `names`. Call `buffered` for the variant fields that follow it.
 */
export function tag<T extends string>(
  object: Record<string, unknown>,
  key: string,
  names: readonly T[],
): T {
  const value = required(object, key);
  if (typeof value === "number" && source === "buffered") {
    const index = u64(value, key);
    if (index >= names.length) reject(key);
    return names[index]!;
  }
  return name(value, key, names);
}

/** The tag of an adjacently tagged enum, which serde reads as a variant name only. */
export function adjacentTag<T extends string>(
  object: Record<string, unknown>,
  key: string,
  names: readonly T[],
): T {
  return name(required(object, key), key, names);
}
