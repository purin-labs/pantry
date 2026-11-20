// Field rules that many client wire records share (Plan 78 step 2). Each one
// is a hand-written reader of packages/commerce-client, written as
// a schema: the same values pass and the same values are refused.
import { Type, type TSchema } from "typebox";
import { PositiveInteger } from "@purin-labs/contract-schema";
import { currencyCodeTextSchema } from "./fields.ts";
import { ReadonlyOpenObject } from "./wire-objects.ts";

/** `value === null ? null : read(value)`. */
export function Nullable<T extends TSchema>(schema: T) {
  return Type.Union([schema, Type.Null()]);
}

/** `parseMoney`; the resource readers share it. */
export { wireMoneySchema } from "./api-common.ts";

/** `parseMoney` with an amount above zero. */
export const positiveWireMoneySchema = ReadonlyOpenObject({
  amountMinor: PositiveInteger,
  currency: currencyCodeTextSchema,
});

type ParseResult<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>;

/**
 * A field that a contracts parser reads, such as a payment binding: the
 * parser decides what passes, and its value is the field's value.
 */
export function ParsedBy<T>(parse: (value: unknown) => ParseResult<T>) {
  return Type.Unsafe<T>(
    Type.Codec(Type.Refine(Type.Unknown(), parses.bind(null, parse), notParsed))
      .Decode(parsedValue.bind(null, parse))
      .Encode(encodedValue),
  );
}

function parses<T>(
  parse: (value: unknown) => ParseResult<T>,
  value: unknown,
): boolean {
  return parse(value).ok;
}

function notParsed(): string {
  return "is invalid";
}

function parsedValue<T>(
  parse: (value: unknown) => ParseResult<T>,
  value: unknown,
): T {
  const parsed = parse(value);
  if (!parsed.ok) throw new TypeError(notParsed());
  return parsed.value;
}

function encodedValue(value: unknown): unknown {
  return value;
}
