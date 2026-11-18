import {
  OpenObject,
  StrictObject,
  parseContract,
  type ContractDecodeResult,
  type ContractRejection,
} from "./schema.ts";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";

import { trimmedIdentityTextSchema } from "./identity-text.ts";
import {
  commerceEntityRefSchema,
  parseCommerceEntityRef,
} from "./entity-reference.ts";
import {
  commerceEffectiveOrderingSchema,
  type CommerceEffectiveOrdering,
  parseCommerceEffectiveOrdering,
} from "./query-ordering.ts";
import {
  commerceQueryFingerprintSchema,
  commerceQuerySemanticsVersionSchema,
  commerceOrderingVersionSchema,
  commerceReadWatermarkSchema,
  parseCommerceQueryFingerprint,
  parseCommerceReadWatermark,
} from "./query-metadata.ts";
import {
  commerceOrderingValueSchema,
  parseCommerceOrderingValue,
  cursorRefusal,
  type CommerceOrderingValue,
} from "./cursor-values.ts";
import { decodeCommerceCursorBytes } from "./cursor-encoding.ts";
import type { CommerceCursor } from "./query-pagination.ts";

declare const TextDecoder: new (
  label: string,
  options: { fatal: boolean; ignoreBOM: boolean },
) => { decode(bytes: Uint8Array): string };
const merchantSchema = Type.Unsafe<
  string & { readonly __brand: "CommerceMerchantId" }
>(trimmedIdentityTextSchema);
export const commerceCursorBoundarySchema = OpenObject({
  orderingValues: Type.Array(commerceOrderingValueSchema, { maxItems: 8 }),
  entityRef: commerceEntityRefSchema,
});
export const commerceCursorPayloadSchema = StrictObject({
  organisationId: trimmedIdentityTextSchema,
  merchantId: merchantSchema,
  queryFingerprint: commerceQueryFingerprintSchema,
  semanticsVersion: commerceQuerySemanticsVersionSchema,
  orderingVersion: commerceOrderingVersionSchema,
  effectiveOrdering: commerceEffectiveOrderingSchema,
  boundary: commerceCursorBoundarySchema,
  watermark: commerceReadWatermarkSchema,
});
export type CommerceCursorBoundary = StaticDecode<
  typeof commerceCursorBoundarySchema
>;
export type CommerceCursorPayload = StaticDecode<
  typeof commerceCursorPayloadSchema
>;
const wireSchema = StrictObject({
  organisationId: Type.String(),
  merchantId: Type.String(),
  queryFingerprint: Type.Unknown(),
  semanticsVersion: commerceQuerySemanticsVersionSchema,
  orderingVersion: commerceOrderingVersionSchema,
  effectiveOrdering: Type.Unknown(),
  boundary: OpenObject({
    orderingValues: Type.Array(Type.Unknown()),
    entityRef: Type.Unknown(),
  }),
  watermark: Type.Unknown(),
});
function invalidShape(): ContractRejection {
  return {
    code: "parse",
    reason: "invalid cursor payload shape",
    details: null,
  };
}
export function parseCommerceCursorPayload(
  value: unknown,
): ContractDecodeResult<CommerceCursorPayload> {
  const parsed = parseContract(wireSchema, value, invalidShape);
  if (!parsed.ok) return parsed;
  const input = parsed.value;
  if (!Value.Check(trimmedIdentityTextSchema, input.organisationId))
    return cursorRefusal("invalid_identity", {
      field: "cursor.organisation_id",
    });
  if (!Value.Check(merchantSchema, input.merchantId))
    return cursorRefusal("invalid_identity", { field: "CommerceMerchantId" });
  const fingerprint = parseCommerceQueryFingerprint(input.queryFingerprint);
  if (!fingerprint.ok) return fingerprint;
  const ordering = parseCommerceEffectiveOrdering(input.effectiveOrdering);
  if (!ordering.ok) return ordering;
  const boundary = parseCommerceCursorBoundary(input.boundary, ordering.value);
  if (!boundary.ok) return boundary;
  const watermark = parseCommerceReadWatermark(input.watermark);
  if (!watermark.ok) return watermark;
  return {
    ok: true,
    value: {
      organisationId: input.organisationId,
      merchantId: input.merchantId,
      queryFingerprint: fingerprint.value,
      semanticsVersion: input.semanticsVersion,
      orderingVersion: input.orderingVersion,
      effectiveOrdering: ordering.value,
      boundary: boundary.value,
      watermark: watermark.value,
    },
  };
}
export function parseCommerceCursorBoundary(
  input: unknown,
  ordering: CommerceEffectiveOrdering,
): ContractDecodeResult<CommerceCursorBoundary> {
  const parsed = parseContract(
    wireSchema.properties.boundary,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  if (parsed.value.orderingValues.length > 8)
    return cursorRefusal("invalid_query");
  const values: CommerceOrderingValue[] = [];
  for (const raw of parsed.value.orderingValues) {
    const item = parseCommerceOrderingValue(raw);
    if (!item.ok) return item;
    values.push(item.value);
  }
  const reference = parseCommerceEntityRef(parsed.value.entityRef);
  if (!reference.ok) return reference;
  if (values.length !== ordering.leadingKeys.length)
    return cursorRefusal("invalid_query");
  return {
    ok: true,
    value: { orderingValues: values, entityRef: reference.value },
  };
}

export function decodeCommerceCursor(
  cursor: CommerceCursor,
): ContractDecodeResult<CommerceCursorPayload> {
  const bytes = decodeCommerceCursorBytes(cursor);
  if (!bytes.ok) return bytes;
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.value,
      ),
    );
  } catch {
    return cursorRefusal("parse");
  }
  return parseCommerceCursorPayload(value);
}
