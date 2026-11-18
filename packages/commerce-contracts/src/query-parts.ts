import {
  OpenObject,
  StrictObject,
  contractRefusal,
  parseContract,
  type ContractDecodeResult,
  type ContractRejection,
} from "./schema.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { assertNever, isRecord } from "@seams/std";

import { trimmedIdentityTextSchema } from "./identity-text.ts";
import { systemCommerceEntityRefSchema } from "./entity-reference.ts";
import { type CommerceSort } from "./query-ordering.ts";
import {
  type CommerceTraversalLimits,
  type CommerceFreshnessRequirement,
} from "./query-limits.ts";

export function queryIdentitySchema<Brand extends string>() {
  return Type.Unsafe<string & { readonly __brand: Brand }>(
    trimmedIdentityTextSchema,
  );
}
export const attributeDefinitionIdSchema =
  queryIdentitySchema<"AttributeDefinitionId">();
export const commerceListIdSchema = queryIdentitySchema<"CommerceListId">();
export const savedCommerceViewIdSchema =
  queryIdentitySchema<"SavedCommerceViewId">();
const systemKind = Type.Unsafe<
  Static<typeof systemCommerceEntityRefSchema>["typeId"]
>(Type.Union(systemCommerceEntityRefSchema.anyOf.map(systemKindSchema)));
function systemKindSchema(
  branch: (typeof systemCommerceEntityRefSchema.anyOf)[number],
) {
  return branch.properties.typeId;
}
export const systemEntityTypeIdSchema = OpenObject({
  origin: Type.Literal("system"),
  typeId: systemKind,
});
export const customEntityTypeIdSchema = OpenObject({
  origin: Type.Literal("custom"),
  typeId: queryIdentitySchema<"CustomCommerceEntityTypeId">(),
});
export const commerceEntityTypeIdSchema = Type.Union([
  systemEntityTypeIdSchema,
  customEntityTypeIdSchema,
]);
export type CommerceEntityTypeId = Static<typeof commerceEntityTypeIdSchema>;
export function parseCommerceEntityTypeId(
  input: unknown,
): ContractDecodeResult<CommerceEntityTypeId> {
  const parsed = parseContract(
    commerceEntityTypeIdSchema,
    input,
    invalidEntityType.bind(null, input),
  );
  if (!parsed.ok) return parsed;
  switch (parsed.value.origin) {
    case "system":
      return {
        ok: true,
        value: { origin: "system", typeId: parsed.value.typeId },
      };
    case "custom":
      return {
        ok: true,
        value: { origin: "custom", typeId: parsed.value.typeId },
      };
    default:
      return assertNever(parsed.value);
  }
}
export const traversalWire = OpenObject({
  maxDepth: Type.Integer({ minimum: 0, maximum: 255 }),
  resultLimit: Type.Integer({ minimum: 0, maximum: 65535 }),
});
export function parseTraversal(
  input: unknown,
): ContractDecodeResult<CommerceTraversalLimits> {
  const parsed = parseContract(traversalWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  if (
    parsed.value.maxDepth > 8 ||
    parsed.value.resultLimit === 0 ||
    parsed.value.resultLimit > 500
  )
    return queryRefusal();
  return {
    ok: true,
    value: {
      maxDepth: parsed.value.maxDepth,
      resultLimit: parsed.value.resultLimit,
    },
  };
}
export const sortWire = OpenObject({
  field: Type.Union([
    OpenObject({
      kind: Type.Literal("attribute"),
      attributeId: Type.String(),
    }),
    OpenObject({ kind: Type.Literal("display_name") }),
    OpenObject({ kind: Type.Literal("created_at") }),
    OpenObject({ kind: Type.Literal("updated_at") }),
  ]),
  direction: Type.Enum(["ascending", "descending"]),
});
export function parseSorts(
  input: unknown[],
): ContractDecodeResult<CommerceSort[]> {
  if (input.length > 8) return queryRefusal();
  const sorts: CommerceSort[] = [];
  for (const raw of input) {
    const parsed = parseContract(sortWire, raw, invalidShape);
    if (!parsed.ok) return parsed;
    const field = parsed.value.field;
    switch (field.kind) {
      case "attribute": {
        const id = field.attributeId;
        if (!Value.Check(attributeDefinitionIdSchema, id))
          return identityRefusal("AttributeDefinitionId");
        sorts.push({
          field: { kind: "attribute", attributeId: id },
          direction: parsed.value.direction,
        });
        break;
      }
      case "display_name":
        sorts.push({
          field: { kind: "display_name" },
          direction: parsed.value.direction,
        });
        break;
      case "created_at":
        sorts.push({
          field: { kind: "created_at" },
          direction: parsed.value.direction,
        });
        break;
      case "updated_at":
        sorts.push({
          field: { kind: "updated_at" },
          direction: parsed.value.direction,
        });
        break;
      default:
        return assertNever(field);
    }
  }
  return { ok: true, value: sorts };
}
export const freshnessWire = Type.Union([
  Type.Literal("any"),
  Type.Literal("current_only"),
  StrictObject({
    observed_within_seconds: OpenObject({
      seconds: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    }),
  }),
]);
export function parseFreshnessRequirement(
  input: unknown,
): ContractDecodeResult<CommerceFreshnessRequirement> {
  const parsed = parseContract(freshnessWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  if (typeof parsed.value === "string")
    return { ok: true, value: parsed.value };
  if (parsed.value.observed_within_seconds.seconds === 0) return queryRefusal();
  return {
    ok: true,
    value: {
      observed_within_seconds: {
        seconds: parsed.value.observed_within_seconds.seconds,
      },
    },
  };
}
export function invalidShape(): ContractRejection {
  return {
    code: "parse",
    reason: "invalid commerce query shape",
    details: null,
  };
}

function invalidEntityType(input: unknown): ContractRejection {
  if (
    isRecord(input) &&
    input.origin === "custom" &&
    typeof input.typeId === "string" &&
    !Value.Check(trimmedIdentityTextSchema, input.typeId)
  ) {
    return {
      code: "invalid_identity",
      reason: "invalid custom entity type",
      details: { field: "CustomCommerceEntityTypeId" },
    };
  }
  return invalidShape();
}
export function queryRefusal(): ContractDecodeResult<never> {
  return contractRefusal({
    code: "invalid_query",
    reason: "invalid commerce query",
    details: null,
  });
}
export function identityRefusal(field: string): ContractDecodeResult<never> {
  return contractRefusal({
    code: "invalid_identity",
    reason: "invalid query identity",
    details: { field },
  });
}
