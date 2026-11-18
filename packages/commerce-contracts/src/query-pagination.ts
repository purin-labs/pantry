import {
  OpenObject,
  contractRefusal,
  parseContract,
  type ContractDecodeResult,
  type ContractRejection,
} from "./schema.ts";
import { trimmedIdentityTextSchema } from "./identity-text.ts";
import { Type, type Static } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { isRecord } from "@seams/std";

// Cursor identity validation is separate from decoding its versioned payload.
// Pagination applies the identity rule; the query planner decodes the payload.
export const commerceCursorSchema = Type.Unsafe<
  string & { readonly __brand: "CommerceCursor" }
>(trimmedIdentityTextSchema);
export const commercePaginationSchema = OpenObject({
  limit: Type.Integer({ minimum: 1, maximum: 500 }),
  cursor: Type.Union([commerceCursorSchema, Type.Null()]),
});
const paginationWireSchema = OpenObject({
  limit: Type.Integer({ minimum: 0, maximum: 65535 }),
  cursor: commercePaginationSchema.properties.cursor,
});
export type CommerceCursor = Static<typeof commerceCursorSchema>;
export type CommercePagination = Static<typeof commercePaginationSchema>;

export function parseCommercePagination(
  value: unknown,
): ContractDecodeResult<CommercePagination> {
  const input = isRecord(value)
    ? { limit: value.limit, cursor: value.cursor ?? null }
    : value;
  const parsed = parseContract(paginationWireSchema, input, rejectPagination);
  if (!parsed.ok) return parsed;
  if (parsed.value.limit === 0 || parsed.value.limit > 500)
    return contractRefusal({
      code: "invalid_query",
      reason: "page limit must be between 1 and 500",
      details: null,
    });
  return {
    ok: true,
    value: { limit: parsed.value.limit, cursor: parsed.value.cursor },
  };
}

function rejectPagination(issue: TLocalizedValidationError): ContractRejection {
  if (issue.keyword === "pattern" || issue.keyword === "minLength")
    return {
      code: "invalid_identity",
      reason: "invalid cursor identity",
      details: { field: "CommerceCursor" },
    };
  return { code: "parse", reason: "invalid pagination shape", details: null };
}
