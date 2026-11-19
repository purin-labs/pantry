import {
  SafeInteger,
  OpenObject,
  contractRefusal,
  parseContract,
  type ContractDecodeResult,
  type ContractRejection,
} from "./schema.ts";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";
import { decodeChecked } from "./sorted-unions.ts";
import { assertNever } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";

import { validTimestamp } from "./commerce-timestamp.ts";
export { validTimestamp } from "./commerce-timestamp.ts";
import { trimmedIdentityTextSchema } from "./identity-text.ts";

export const commerceIntegerSchema = Type.Decode(SafeInteger, toBigInt);
export const commerceOrderingValueSchema = Type.Union([
  OpenObject({ kind: Type.Literal("null") }),
  OpenObject({ kind: Type.Literal("text"), value: Type.String() }),
  OpenObject({ kind: Type.Literal("integer"), value: commerceIntegerSchema }),
  OpenObject({
    kind: Type.Literal("decimal"),
    value: OpenObject({
      unscaled: SafeInteger,
      scale: Type.Integer({ minimum: 0, maximum: 255 }),
    }),
  }),
  OpenObject({ kind: Type.Literal("boolean"), value: Type.Boolean() }),
  OpenObject({ kind: Type.Literal("date"), value: Type.String() }),
  OpenObject({ kind: Type.Literal("timestamp"), value: Type.String() }),
]);
export type CommerceOrderingValue = StrictUnion<
  StaticDecode<typeof commerceOrderingValueSchema>
>;
function toBigInt(value: number): bigint {
  return BigInt(value);
}
function invalidShape(): ContractRejection {
  return { code: "parse", reason: "invalid cursor value shape", details: null };
}
export function cursorRefusal(
  code: string,
  details: unknown = null,
): ContractDecodeResult<never> {
  return contractRefusal({ code, reason: "invalid commerce cursor", details });
}
export function parseCommerceOrderingValue(
  input: unknown,
): ContractDecodeResult<CommerceOrderingValue> {
  const parsed = parseContract(
    commerceOrderingValueSchema,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const item = decodeChecked(commerceOrderingValueSchema, parsed.value);
  switch (item.kind) {
    case "null":
      return { ok: true, value: { kind: "null" } };
    case "text":
      if (
        item.value !== "" &&
        !Value.Check(trimmedIdentityTextSchema, item.value)
      )
        return cursorRefusal("invalid_text", {
          field: "cursor.ordering_value",
        });
      return { ok: true, value: { kind: "text", value: item.value } };
    case "integer":
      return { ok: true, value: { kind: "integer", value: item.value } };
    case "boolean":
      return { ok: true, value: { kind: "boolean", value: item.value } };
    case "decimal":
      if (item.value.scale > 6)
        return cursorRefusal("invalid_attribute_value", {
          attributeId: "decimal.scale",
        });
      return {
        ok: true,
        value: {
          kind: "decimal",
          value: { unscaled: item.value.unscaled, scale: item.value.scale },
        },
      };
    case "date":
      // The existing CommerceDate permits day 1–31 independently of month.
      if (
        !/^(?:[0-9]{4}|\+[0-9]{3})-(?:0[1-9]|1[0-2]|\+[1-9])-(?:0[1-9]|[12][0-9]|3[01]|\+[1-9])$/.test(
          item.value,
        )
      )
        return cursorRefusal("invalid_date");
      return { ok: true, value: { kind: "date", value: item.value } };
    case "timestamp":
      if (!validTimestamp(item.value)) return cursorRefusal("invalid_date");
      return { ok: true, value: { kind: "timestamp", value: item.value } };
    default:
      return assertNever(item);
  }
}
