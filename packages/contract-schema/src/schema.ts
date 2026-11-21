import {
  Type,
  type Static,
  type TSchema,
  type TProperties,
  type TObjectOptions,
} from "typebox";
import { HasCodec, Value } from "typebox/value";
import type { TLocalizedValidationError } from "typebox/error";
import { canonicalJsonByCodePoint, sha256Hex } from "@purin-labs/std";
import {
  cleanCheckedRecord,
  fillRecordDefaults,
  recordHoldsDefault,
} from "./record-values.ts";
import { decodeValue } from "./sorted-unions.ts";

export {
  integrationAccountIdSchema,
  organisationIdSchema,
  type IntegrationAccountId,
  type OrganisationId,
} from "./ids.ts";

export const SafeInteger = Type.Integer({
  minimum: Number.MIN_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER,
});
export const NonNegativeInteger = Type.Integer({ ...SafeInteger, minimum: 0 });
export const PositiveInteger = Type.Integer({ ...SafeInteger, minimum: 1 });

/** A record whose index signature is readonly, as `Readonly<Record<K, V>>`. */
export function ReadonlyRecord<Key extends TSchema, Value extends TSchema>(
  key: Key,
  value: Value,
) {
  return Type.Unsafe<
    Readonly<Record<Static<Key> & PropertyKey, Static<Value>>>
  >(Type.Record(key, value));
}

/** Rust types with deny_unknown_fields refuse additional properties. */
export function StrictObject<Properties extends TProperties>(
  properties: Properties,
  options: Omit<TObjectOptions, "additionalProperties"> & {
    additionalProperties?: never;
  } = {},
) {
  return Type.Object(properties, { additionalProperties: false, ...options });
}

/** Rust types without deny_unknown_fields accept additional properties. */
export function OpenObject<Properties extends TProperties>(
  properties: Properties,
  options: Omit<TObjectOptions, "additionalProperties"> & {
    additionalProperties?: never;
  } = {},
) {
  return Type.Object(properties, options);
}

export type ContractDecodeError =
  | Readonly<{
      kind: "validation_rejected";
      code: string;
      reason: string;
      details: unknown;
    }>
  | Readonly<{
      kind: "input_invalid";
      code: "invalid_json" | "invalid_json_integer";
      reason: string;
      details: null;
    }>;

export type ContractDecodeResult<T> =
  | Readonly<{ ok: true; value: T; error?: never }>
  | Readonly<{ ok: false; error: ContractDecodeError; value?: never }>;

/**
 * A schema refusal at a boundary that throws. It carries the same `code` and
 * `details` as the Wasm validators' `LexiconValidationError`.
 */
export class ContractRefusalError extends TypeError {
  readonly code: string;
  readonly details: unknown;

  constructor(error: ContractDecodeError) {
    super(`${error.code}: ${error.reason}`);
    this.name = "ContractRefusalError";
    this.code = error.code;
    this.details = error.details;
  }
}

/** The value of a record schema parser; a refusal throws its contract error. */
export function decodeRecord<T>(
  parser: (input: unknown) => ContractDecodeResult<T>,
  input: unknown,
): T {
  const parsed = parser(input);
  if (parsed.ok) return parsed.value;
  throw new ContractRefusalError(parsed.error);
}

export type ContractRejection = Readonly<{
  code: string;
  reason: string;
  details: unknown;
}>;

export function contractRefusal(
  rejection: ContractRejection,
): ContractDecodeResult<never> {
  return { ok: false, error: { kind: "validation_rejected", ...rejection } };
}

/** Parse a validated array and preserve its first refusal. */
export function parseContractArray<T>(
  values: readonly unknown[],
  parser: (value: unknown) => ContractDecodeResult<T>,
): ContractDecodeResult<T[]> {
  const parsed: T[] = [];
  for (const value of values) {
    const result = parser(value);
    if (!result.ok) return result;
    parsed.push(result.value);
  }
  return { ok: true, value: parsed };
}

/**
 * The refusal of {@link jsonSafeInteger}: an integer that JSON cannot carry
 * without a loss.
 */
export class UnsafeJsonIntegerError extends TypeError {}

/** Normalize JSON values once, with the integer rules of the Wasm boundary. */
export function normalizeContractInput(
  value: unknown,
): ContractDecodeResult<unknown> {
  try {
    const serialized = JSON.stringify(value, jsonSafeInteger);
    if (serialized === undefined)
      return invalidJson("value is not JSON serializable");
    const parsed: unknown = JSON.parse(serialized);
    if (!withinJsonNestingLimit(parsed))
      return invalidJson(
        "contract JSON nesting exceeds the Rust boundary limit",
      );
    return { ok: true, value: parsed };
  } catch (error) {
    if (error instanceof UnsafeJsonIntegerError) {
      return invalidInteger(
        "contract integer exceeds the JavaScript safe range",
      );
    }
    return invalidJson("value is not JSON serializable");
  }
}

// serde_json refuses the 128th nested object or array before domain validation.
function withinJsonNestingLimit(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    if (next.value === null || typeof next.value !== "object") continue;
    const depth = next.depth + 1;
    if (depth >= 128) return false;
    for (const child of Object.values(next.value))
      pending.push({ value: child, depth });
  }
  return true;
}

/** A domain mapper supplies the existing refusal text and its field path. */
export function parseContract<T extends TSchema>(
  schema: T,
  value: unknown,
  reject: (issue: TLocalizedValidationError) => ContractRejection,
): ContractDecodeResult<Static<T>> {
  const input = normalizeContractInput(value);
  if (!input.ok) return input;
  return checkContract(schema, input.value, reject);
}

/** Validate an SDK boundary value without the Rust JSON bridge's conversions. */
export function checkContract<T extends TSchema>(
  schema: T,
  value: unknown,
  reject: (issue: TLocalizedValidationError) => ContractRejection,
): ContractDecodeResult<Static<T>> {
  if (Value.Check(schema, value)) return { ok: true, value };
  const issues = Value.Errors(schema, value);
  if (issues.some(isIntegerFailure.bind(null, value))) {
    return invalidInteger("contract number is not a JSON integer");
  }
  return contractRefusal(reject(issues[0]!));
}

function isIntegerFailure(
  input: unknown,
  issue: TLocalizedValidationError,
): boolean {
  return (
    issue.keyword === "type" &&
    issue.params.type === "integer" &&
    typeof Value.Pointer.Get(input, issue.instancePath) === "number"
  );
}

/**
 * The parser of a record schema (Plan 78 step 2). A refusal has the code
 * `invalid_record` and names the JSON pointer of the first field that fails.
 * With a `name`, the reason also names that field as the hand-written
 * readers did, for example `checkout.source.buyerContact.emailDigest`.
 */
export function recordParser<T extends TSchema>(
  schema: T,
  name?: string,
): (input: unknown) => ContractDecodeResult<Static<T>> {
  const parse: (
    schema: T,
    name: string | undefined,
    fillsDefaults: boolean,
    input: unknown,
  ) => ContractDecodeResult<Static<T>> = parseRecord;
  return parse.bind(null, schema, name, recordHoldsDefault(schema));
}

function parseRecord<T extends TSchema>(
  schema: T,
  name: string | undefined,
  fillsDefaults: boolean,
  input: unknown,
): ContractDecodeResult<Static<T>> {
  // As in the hand-written readers, a missing field that has a default gets
  // it before the check.
  const filled = fillsDefaults
    ? fillRecordDefaults(schema, Value.Clone(input))
    : input;
  const copied = copyRecordInput(filled);
  if (!copied.ok) return copied;
  // The hand-written readers keep a number above 2^53 in free JSON; a schema
  // integer still refuses it where the reader expects a safe integer.
  const parsed = checkContract(
    schema,
    copied.value,
    recordRefusal.bind(null, name),
  );
  if (!parsed.ok) return parsed;
  // The parsed value is a fresh copy. As in the hand-written readers, an open
  // record keeps only its own fields, and a codec rewrites a checked value as
  // its reader does, such as a timestamp in ISO 8601 form.
  const cleaned = cleanCheckedRecord(schema, parsed.value);
  const value = HasCodec(schema) ? decodeValue(schema, cleaned) : cleaned;
  return { ok: true, value: value as Static<T> };
}

/** A fresh JSON copy of a record input; a safe bigint becomes a number. */
function copyRecordInput(value: unknown): ContractDecodeResult<unknown> {
  try {
    const serialized = JSON.stringify(value, recordNumber);
    if (serialized === undefined)
      return invalidJson("value is not JSON serializable");
    return { ok: true, value: JSON.parse(serialized) };
  } catch {
    return invalidJson("value is not JSON serializable");
  }
}

function recordNumber(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

function recordRefusal(
  name: string | undefined,
  issue: TLocalizedValidationError,
): ContractRejection {
  return {
    code: "invalid_record",
    reason:
      name === undefined
        ? issue.message
        : `${recordFieldName(name, issue.instancePath)} ${issue.message}`,
    details: { field: issue.instancePath === "" ? "/" : issue.instancePath },
  };
}

/** `checkout` and `/source/buyerContact` name `checkout.source.buyerContact`. */
function recordFieldName(name: string, pointer: string): string {
  const segments = pointer.split("/").slice(1).map(unescapePointerSegment);
  return [name, ...segments].join(".");
}

function unescapePointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Use only when the Rust area hashes canonical JSON. Other digest formats stay explicit. */
export function canonicalContractDigest(value: unknown): Promise<string> {
  return sha256Hex(canonicalJsonByCodePoint(value));
}

/**
 * The `JSON.stringify` replacer of the integer rules of the Wasm boundary: a
 * safe bigint becomes a number, and an unsafe bigint or integer throws
 * {@link UnsafeJsonIntegerError}.
 */
export function jsonSafeInteger(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || BigInt(number) !== value)
      throw new UnsafeJsonIntegerError();
    return number;
  }
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value)
  ) {
    throw new UnsafeJsonIntegerError();
  }
  return value;
}

function invalidJson(reason: string): ContractDecodeResult<never> {
  return {
    ok: false,
    error: {
      kind: "input_invalid",
      code: "invalid_json",
      reason,
      details: null,
    },
  };
}

function invalidInteger(reason: string): ContractDecodeResult<never> {
  return {
    ok: false,
    error: {
      kind: "input_invalid",
      code: "invalid_json_integer",
      reason,
      details: null,
    },
  };
}
