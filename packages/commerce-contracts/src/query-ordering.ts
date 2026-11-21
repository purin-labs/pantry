import {
  OpenObject,
  contractRefusal,
  parseContract,
  type ContractDecodeResult,
  type ContractRejection,
} from "@purin-labs/contract-schema";
import { trimmedIdentityTextSchema } from "./identity-text.ts";
import { Type, type Static } from "typebox";
import type { StrictUnion } from "@purin-labs/type-utils";
import type { AttributeDefinitionId } from "./records/identifiers.ts";
import { assertNever } from "@purin-labs/std";

import type { TLocalizedValidationError } from "typebox/error";

// Rust str::trim uses Unicode White_Space. JavaScript's \s differs at U+0085
// and U+FEFF, so the boundary spells out the Rust character set.
const attributeId = Type.Unsafe<AttributeDefinitionId>(
  trimmedIdentityTextSchema,
);

const commerceSortDirectionSchema = Type.Enum(["ascending", "descending"]);
const commerceNullPlacementSchema = Type.Literal("last");
const commerceSortFieldSchema = Type.Union([
  OpenObject({ kind: Type.Literal("attribute"), attributeId }),
  OpenObject({ kind: Type.Literal("display_name") }),
  OpenObject({ kind: Type.Literal("created_at") }),
  OpenObject({ kind: Type.Literal("updated_at") }),
]);
export const commerceSortSchema = OpenObject({
  field: commerceSortFieldSchema,
  direction: commerceSortDirectionSchema,
});
const commerceOrderingLeadingFieldSchema = commerceSortFieldSchema;
const commerceOrderingLeadingKeySchema = OpenObject({
  field: commerceOrderingLeadingFieldSchema,
  direction: commerceSortDirectionSchema,
  nulls: commerceNullPlacementSchema,
});
const commerceEntityIdTieBreakerSchema = OpenObject({
  kind: Type.Literal("entity_id_ascending"),
});
export const commerceEffectiveOrderingSchema = OpenObject({
  leadingKeys: Type.Array(commerceOrderingLeadingKeySchema, { maxItems: 8 }),
  tieBreaker: commerceEntityIdTieBreakerSchema,
});

export type CommerceSortDirection = Static<typeof commerceSortDirectionSchema>;
export type CommerceNullPlacement = Static<typeof commerceNullPlacementSchema>;
export type CommerceSortField = StrictUnion<
  Static<typeof commerceSortFieldSchema>
>;
export type CommerceSort = Static<typeof commerceSortSchema>;
export type CommerceOrderingLeadingField = StrictUnion<
  Static<typeof commerceOrderingLeadingFieldSchema>
>;
export type CommerceOrderingLeadingKey = Static<
  typeof commerceOrderingLeadingKeySchema
>;
export type CommerceEntityIdTieBreaker = Static<
  typeof commerceEntityIdTieBreakerSchema
>;
export type CommerceEffectiveOrdering = Static<
  typeof commerceEffectiveOrderingSchema
>;

export function parseCommerceEffectiveOrdering(
  value: unknown,
): ContractDecodeResult<CommerceEffectiveOrdering> {
  const parsed = parseContract(
    commerceEffectiveOrderingSchema,
    value,
    rejectOrdering,
  );
  if (!parsed.ok) return parsed;
  const fields = new Set<string>();
  const leadingKeys: CommerceOrderingLeadingKey[] = [];
  for (const key of parsed.value.leadingKeys) {
    const name =
      key.field.kind === "attribute"
        ? `attribute:${key.field.attributeId}`
        : key.field.kind;
    if (fields.has(name))
      return contractRefusal({
        code: "invalid_query",
        reason: "ordering fields must be unique",
        details: null,
      });
    fields.add(name);
    leadingKeys.push({
      field: normalizeField(key.field),
      direction: key.direction,
      nulls: key.nulls,
    });
  }
  return {
    ok: true,
    value: { leadingKeys, tieBreaker: { kind: "entity_id_ascending" } },
  };
}

function normalizeField(field: CommerceSortField): CommerceSortField {
  switch (field.kind) {
    case "attribute":
      return { kind: "attribute", attributeId: field.attributeId };
    case "display_name":
      return { kind: "display_name" };
    case "created_at":
      return { kind: "created_at" };
    case "updated_at":
      return { kind: "updated_at" };
    default:
      return assertNever(field);
  }
}

function rejectOrdering(issue: TLocalizedValidationError): ContractRejection {
  if (issue.keyword === "pattern" || issue.keyword === "minLength") {
    return {
      code: "invalid_identity",
      reason: "invalid attribute identity",
      details: { field: "AttributeDefinitionId" },
    };
  }
  if (issue.keyword === "maxItems")
    return {
      code: "invalid_query",
      reason: "too many ordering fields",
      details: null,
    };
  return { code: "parse", reason: "invalid ordering shape", details: null };
}
