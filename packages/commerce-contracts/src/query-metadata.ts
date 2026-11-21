import {
  NonNegativeInteger,
  OpenObject,
  parseContract,
  type ContractDecodeResult,
  type ContractRejection,
} from "@purin-labs/contract-schema";
import { Type, type Static } from "typebox";
import type { StrictUnion } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import type { TLocalizedValidationError } from "typebox/error";

export const commerceSnapshotRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "CommerceSnapshotRevision" }
>(NonNegativeInteger);
export const commerceQueryFingerprintSchema = Type.Unsafe<
  string & { readonly __brand: "CommerceQueryFingerprint" }
>(Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-fA-F]{64}$" }));
export const commerceQuerySemanticsVersionSchema = Type.Literal("v1");
export const commerceOrderingVersionSchema = Type.Literal("v1");
const commerceReadWatermarkKindSchema = Type.Enum([
  "commerce_native",
  "provider_backed",
]);
export const commerceReadWatermarkSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("commerce_native"),
    merchantRevision: commerceSnapshotRevisionSchema,
  }),
  OpenObject({
    kind: Type.Literal("provider_backed"),
    blotterAcceptedProjectionSequence: commerceSnapshotRevisionSchema,
    commerceExtensionMerchantRevision: commerceSnapshotRevisionSchema,
  }),
]);

export type CommerceSnapshotRevision = Static<
  typeof commerceSnapshotRevisionSchema
>;
export type CommerceQueryFingerprint = Static<
  typeof commerceQueryFingerprintSchema
>;
export type CommerceQuerySemanticsVersion = Static<
  typeof commerceQuerySemanticsVersionSchema
>;
export type CommerceOrderingVersion = Static<
  typeof commerceOrderingVersionSchema
>;
export type CommerceReadWatermarkKind = Static<
  typeof commerceReadWatermarkKindSchema
>;
export type CommerceReadWatermark = StrictUnion<
  Static<typeof commerceReadWatermarkSchema>
>;

export function parseCommerceReadWatermark(
  value: unknown,
): ContractDecodeResult<CommerceReadWatermark> {
  const parsed = parseContract(
    commerceReadWatermarkSchema,
    value,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const watermark = parsed.value;
  switch (watermark.kind) {
    case "commerce_native":
      return {
        ok: true,
        value: {
          kind: watermark.kind,
          merchantRevision: watermark.merchantRevision,
        },
      };
    case "provider_backed":
      return {
        ok: true,
        value: {
          kind: watermark.kind,
          blotterAcceptedProjectionSequence:
            watermark.blotterAcceptedProjectionSequence,
          commerceExtensionMerchantRevision:
            watermark.commerceExtensionMerchantRevision,
        },
      };
    default:
      return assertNever(watermark);
  }
}

// Deserialization validates the fingerprint without rewriting its case.
// Newly computed fingerprints already use lowercase hexadecimal.
export function parseCommerceQueryFingerprint(
  value: unknown,
): ContractDecodeResult<CommerceQueryFingerprint> {
  return parseContract(
    commerceQueryFingerprintSchema,
    value,
    invalidFingerprint,
  );
}

function invalidShape(): ContractRejection {
  return { code: "parse", reason: "invalid commerce watermark", details: null };
}

function invalidFingerprint(
  issue: TLocalizedValidationError,
): ContractRejection {
  if (issue.keyword === "type")
    return { code: "parse", reason: "fingerprint must be text", details: null };
  return {
    code: "invalid_identity",
    reason: "invalid commerce query fingerprint",
    details: { field: "commerce_query_fingerprint" },
  };
}
