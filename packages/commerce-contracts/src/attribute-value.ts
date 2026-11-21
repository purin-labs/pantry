import {
  OpenObject,
  contractRefusal,
  parseContract,
  type ContractDecodeResult,
  type ContractRejection,
  SafeInteger as signed,
} from "@purin-labs/contract-schema";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";
import { decodeChecked } from "@purin-labs/contract-schema/sorted-unions";
import { assertNever, isRecord, isString } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";

import {
  commerceIntegerSchema,
  parseCommerceOrderingValue,
  validTimestamp,
} from "./cursor-values.ts";
import {
  trimmedIdentityTextSchema,
  nonBlankTextSchema,
} from "./identity-text.ts";
const option = Type.Unsafe<string & { readonly __brand: "AttributeOptionId" }>(
  trimmedIdentityTextSchema,
);
const principal = Type.Unsafe<
  string & { readonly __brand: "CommercePrincipalId" }
>(trimmedIdentityTextSchema);

export const attributeValueSchema = Type.Union([
  OpenObject({ kind: Type.Literal("short_text"), value: Type.String() }),
  OpenObject({ kind: Type.Literal("long_text"), value: Type.String() }),
  OpenObject({ kind: Type.Literal("integer"), value: commerceIntegerSchema }),
  OpenObject({
    kind: Type.Literal("decimal"),
    value: OpenObject({
      unscaled: signed,
      scale: Type.Integer({ minimum: 0, maximum: 255 }),
    }),
  }),
  OpenObject({ kind: Type.Literal("boolean"), value: Type.Boolean() }),
  OpenObject({ kind: Type.Literal("date"), value: Type.String() }),
  OpenObject({ kind: Type.Literal("timestamp"), value: Type.String() }),
  OpenObject({ kind: Type.Literal("status"), value: option }),
  OpenObject({ kind: Type.Literal("choice"), values: Type.Array(option) }),
  OpenObject({
    kind: Type.Literal("money"),
    value: OpenObject({ amountMinor: signed, currency: Type.String() }),
  }),
  OpenObject({
    kind: Type.Literal("merchant_operator_reference"),
    value: OpenObject({ principalId: principal, displayName: Type.String() }),
  }),
  OpenObject({
    kind: Type.Literal("external_resource_reference"),
    value: OpenObject({
      source: Type.Enum(["shopify", "stripe", "lab", "commerce"]),
      resourceId: Type.String(),
      label: Type.Union([Type.String(), Type.Null()]),
    }),
  }),
]);
export type AttributeValue = StrictUnion<
  StaticDecode<typeof attributeValueSchema>
>;
const schemasByKind = new Map<
  string,
  (typeof attributeValueSchema.anyOf)[number]
>();
for (const schema of attributeValueSchema.anyOf)
  schemasByKind.set(schema.properties.kind.const, schema);

export function parseAttributeValue(
  input: unknown,
): ContractDecodeResult<AttributeValue> {
  const raw = normalizeNullableLabel(input);
  const schema =
    isRecord(raw) && typeof raw.kind === "string"
      ? schemasByKind.get(raw.kind)
      : undefined;
  const parsed = parseContract(
    schema ?? attributeValueSchema,
    raw,
    rejectAttribute.bind(null, raw),
  );
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  switch (value.kind) {
    case "short_text":
    case "long_text":
      if (!Value.Check(nonBlankTextSchema, value.value))
        return invalid("invalid_attribute_value", { attributeId: "text" });
      return { ok: true, value: { kind: value.kind, value: value.value } };
    case "integer":
      return {
        ok: true,
        value: {
          kind: "integer",
          value: decodeChecked(commerceIntegerSchema, value.value),
        },
      };
    case "boolean":
      return { ok: true, value: { kind: "boolean", value: value.value } };
    case "date": {
      const checked = parseCommerceOrderingValue(value);
      if (!checked.ok) return checked;
      return { ok: true, value: { kind: "date", value: value.value } };
    }
    case "timestamp":
      if (!validTimestamp(value.value))
        return invalid("invalid_attribute_value", { attributeId: "timestamp" });
      return { ok: true, value: { kind: "timestamp", value: value.value } };
    case "decimal":
      if (value.value.scale > 6)
        return invalid("invalid_attribute_value", {
          attributeId: "decimal.scale",
        });
      return {
        ok: true,
        value: {
          kind: "decimal",
          value: { unscaled: value.value.unscaled, scale: value.value.scale },
        },
      };
    case "status":
      return { ok: true, value: { kind: "status", value: value.value } };
    case "choice":
      if (value.values.length === 0)
        return invalid("invalid_attribute_value", { attributeId: "choice" });
      return { ok: true, value: { kind: "choice", values: value.values } };
    case "money":
      if (!/^[A-Z]{3}$/.test(value.value.currency))
        return invalid("invalid_attribute_value", { attributeId: "money" });
      return {
        ok: true,
        value: {
          kind: "money",
          value: {
            amountMinor: value.value.amountMinor,
            currency: value.value.currency,
          },
        },
      };
    case "merchant_operator_reference":
      if (!Value.Check(trimmedIdentityTextSchema, value.value.displayName))
        return invalid("invalid_text", {
          field: "merchant_operator_reference.display_name",
        });
      return {
        ok: true,
        value: {
          kind: "merchant_operator_reference",
          value: {
            principalId: value.value.principalId,
            displayName: value.value.displayName,
          },
        },
      };
    case "external_resource_reference":
      if (!Value.Check(trimmedIdentityTextSchema, value.value.resourceId))
        return invalid("invalid_identity", {
          field: "external_resource_reference.resource_id",
        });
      if (
        value.value.label !== null &&
        !Value.Check(trimmedIdentityTextSchema, value.value.label)
      )
        return invalid("invalid_text", {
          field: "external_resource_reference.label",
        });
      return {
        ok: true,
        value: {
          kind: "external_resource_reference",
          value: {
            source: value.value.source,
            resourceId: value.value.resourceId,
            label: value.value.label,
          },
        },
      };
    default:
      return assertNever(value);
  }
}
function normalizeNullableLabel(input: unknown): unknown {
  if (
    !isRecord(input) ||
    input.kind !== "external_resource_reference" ||
    !isRecord(input.value)
  )
    return input;
  return {
    kind: input.kind,
    value: {
      source: input.value.source,
      resourceId: input.value.resourceId,
      label: input.value.label ?? null,
    },
  };
}
function invalid(code: string, details: unknown): ContractDecodeResult<never> {
  return contractRefusal({ code, reason: "invalid attribute value", details });
}
function rejectAttribute(input: unknown): ContractRejection {
  if (isRecord(input) && invalidIdentityInput(input)) {
    const field =
      input.kind === "merchant_operator_reference"
        ? "CommercePrincipalId"
        : "attribute_option_id";
    return {
      code: "invalid_identity",
      reason: "invalid attribute identity",
      details: { field },
    };
  }
  return {
    code: "parse",
    reason: "invalid attribute value shape",
    details: null,
  };
}

function invalidIdentityInput(input: Record<string, unknown>): boolean {
  switch (input.kind) {
    case "status":
      return typeof input.value === "string" && invalidOptionText(input.value);
    case "choice":
      return (
        Array.isArray(input.values) &&
        input.values.every(isString) &&
        input.values.some(invalidOptionText)
      );
    case "merchant_operator_reference":
      return (
        isRecord(input.value) &&
        typeof input.value.principalId === "string" &&
        typeof input.value.displayName === "string" &&
        invalidOptionText(input.value.principalId)
      );
    default:
      return false;
  }
}

function invalidOptionText(value: string): boolean {
  return !Value.Check(trimmedIdentityTextSchema, value);
}
