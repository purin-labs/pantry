// Plan 78 step 2: the media records that packages/commerce-client
// reads in src/media.ts. Each schema follows its hand-written reader: exact
// keys, SHA-256 digests, image types without SVG, and alt text of at most 512
// characters, which may be empty.
import { Type, type Static } from "typebox";
import { NonNegativeInteger, PositiveInteger } from "@purin-labs/contract-schema";
import {
  boundedTextSchema,
  normalizedTextSchema,
  sha256HexSchema,
  utcTimestampSchema,
} from "./fields.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;
const exactKeys = { unevaluatedProperties: false } as const;

/** `parseAltText`: any text of at most 512 characters. */
const altTextSchema = Type.Refine(Type.String(), isAltText, altTextError);

function isAltText(value: string): boolean {
  return value.length <= 512;
}

function altTextError(): string {
  return "is too long";
}

export const commerceMediaContentTypeSchema = Type.Union([
  Type.Literal("image/jpeg"),
  Type.Literal("image/png"),
  Type.Literal("image/webp"),
  Type.Literal("image/avif"),
  Type.Literal("image/gif"),
]);
export type CommerceMediaContentType = Static<
  typeof commerceMediaContentTypeSchema
>;

export const mediaCommandBaseSchema = ReadonlyOpenObject({
  merchantId: text,
  idempotencyKey: text,
  requestedAt: utcTimestampSchema,
});
export type MediaCommandBase = Static<typeof mediaCommandBaseSchema>;

function hasUniqueIds(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length;
}

function duplicateError(): string {
  return "names an item twice";
}

export const commerceProductMediaItemV1Schema = ReadonlyStrictObject({
  mediaId: text,
  variantIds: Type.Refine(ImmutableArray(text), hasUniqueIds, duplicateError),
});
export type CommerceProductMediaItemV1 = Static<
  typeof commerceProductMediaItemV1Schema
>;

export const createCommerceMediaV1Schema = Type.Intersect(
  [
    mediaCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.create-media.v1"),
      mediaId: boundedTextSchema(120),
      sha256: sha256HexSchema,
      altText: altTextSchema,
    }),
  ],
  exactKeys,
);
export type CreateCommerceMediaV1 = Static<
  typeof createCommerceMediaV1Schema
>;

export const updateCommerceMediaV1Schema = Type.Intersect(
  [
    mediaCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.update-media.v1"),
      mediaId: text,
      expectedRevision: PositiveInteger,
      altText: altTextSchema,
    }),
  ],
  exactKeys,
);
export type UpdateCommerceMediaV1 = Static<
  typeof updateCommerceMediaV1Schema
>;

export const deleteCommerceMediaV1Schema = Type.Intersect(
  [
    mediaCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.delete-media.v1"),
      mediaId: text,
      expectedRevision: PositiveInteger,
    }),
  ],
  exactKeys,
);
export type DeleteCommerceMediaV1 = Static<
  typeof deleteCommerceMediaV1Schema
>;

function hasUniqueMedia(
  items: readonly Readonly<{ mediaId: string }>[],
): boolean {
  return new Set(items.map(mediaIdOf)).size === items.length;
}

function mediaIdOf(item: Readonly<{ mediaId: string }>): string {
  return item.mediaId;
}

export const setCommerceProductMediaV1Schema = Type.Intersect(
  [
    mediaCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.set-product-media.v1"),
      productId: text,
      expectedRevision: NonNegativeInteger,
      media: Type.Refine(
        ImmutableArray(commerceProductMediaItemV1Schema, { maxItems: 250 }),
        hasUniqueMedia,
        duplicateError,
      ),
    }),
  ],
  exactKeys,
);
export type SetCommerceProductMediaV1 = Static<
  typeof setCommerceProductMediaV1Schema
>;

export const commerceMediaCommandV1Schema = Type.Union([
  createCommerceMediaV1Schema,
  updateCommerceMediaV1Schema,
  deleteCommerceMediaV1Schema,
  setCommerceProductMediaV1Schema,
]);
export type CommerceMediaCommandV1 = Static<
  typeof commerceMediaCommandV1Schema
>;

export const commerceMediaV1Schema = ReadonlyStrictObject({
  id: text,
  revision: PositiveInteger,
  sha256: sha256HexSchema,
  contentType: commerceMediaContentTypeSchema,
  byteSize: PositiveInteger,
  altText: altTextSchema,
  occurredAt: utcTimestampSchema,
});
export type CommerceMediaV1 = Static<typeof commerceMediaV1Schema>;

export const commerceProductMediaV1Schema = ReadonlyStrictObject({
  productId: text,
  revision: PositiveInteger,
  media: ImmutableArray(commerceProductMediaItemV1Schema),
});
export type CommerceProductMediaV1 = Static<
  typeof commerceProductMediaV1Schema
>;

export const commerceMediaLibraryV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.media.v1"),
  media: ImmutableArray(commerceMediaV1Schema),
  products: ImmutableArray(commerceProductMediaV1Schema),
});
export type CommerceMediaLibraryV1 = Static<
  typeof commerceMediaLibraryV1Schema
>;

export const commerceMediaUploadV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.media-upload.v1"),
  sha256: sha256HexSchema,
  contentType: commerceMediaContentTypeSchema,
  byteSize: PositiveInteger,
});
export type CommerceMediaUploadV1 = Static<
  typeof commerceMediaUploadV1Schema
>;

// Parsers of the client API types (Plan 78 step 2).
export const parseCreateCommerceMediaV1 = wireRecordParser(
  createCommerceMediaV1Schema,
);
export const parseDeleteCommerceMediaV1 = wireRecordParser(
  deleteCommerceMediaV1Schema,
);
export const parseSetCommerceProductMediaV1 = wireRecordParser(
  setCommerceProductMediaV1Schema,
);
export const parseCommerceMediaLibraryV1 = wireRecordParser(
  commerceMediaLibraryV1Schema,
);
export const parseCommerceMediaUploadV1 = wireRecordParser(
  commerceMediaUploadV1Schema,
);
export const parseCommerceMediaV1 = wireRecordParser(commerceMediaV1Schema);
export const parseCommerceProductMediaV1 = wireRecordParser(
  commerceProductMediaV1Schema,
);
export const parseUpdateCommerceMediaV1 = wireRecordParser(
  updateCommerceMediaV1Schema,
);
