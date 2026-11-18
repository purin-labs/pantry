// Product media (Plan 76A step 1). Staff upload image bytes, which Commerce
// keeps in R2 under their SHA-256, then create a media record with alt text
// and set each product's ordered media, for all its variants or some of
// them. The buyer catalog lists the media of the products it shows.
import type { CommerceEngineTimestamp } from "./commerce-resources.ts";
import { parseCreateCommerceMediaV1 as parseCreateCommerceMediaV1Record, parseDeleteCommerceMediaV1 as parseDeleteCommerceMediaV1Record, parseSetCommerceProductMediaV1 as parseSetCommerceProductMediaV1Record, parseCommerceMediaLibraryV1 as parseCommerceMediaLibraryV1Record, parseCommerceMediaUploadV1 as parseCommerceMediaUploadV1Record, parseCommerceMediaV1 as parseCommerceMediaV1Record, parseCommerceProductMediaV1 as parseCommerceProductMediaV1Record, parseUpdateCommerceMediaV1 as parseUpdateCommerceMediaV1Record } from "@seams/commerce-contracts/records/api-media";
import { decodeRecord } from "./entity-plane/record-decoding.ts";

/** The image types Commerce keeps; SVG is refused because it can carry script. */
export const MEDIA_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
] as const;
export type CommerceMediaContentType = (typeof MEDIA_CONTENT_TYPES)[number];

/** The largest upload, as in Shopify. */
export const MEDIA_MAX_BYTES = 20 * 1024 * 1024;

/** One library image's bytes, as the merchant's own app reads them. */
export type CommerceMediaContent = Readonly<{
  bytes: Uint8Array;
  contentType: CommerceMediaContentType;
  etag: string | null;
}>;

/** What an upload stored: the same bytes always give the same answer. */
export type CommerceMediaUploadV1 = Readonly<{
  schemaVersion: "underclerk.media-upload.v1";
  sha256: string;
  contentType: CommerceMediaContentType;
  byteSize: number;
}>;

export type CommerceMediaV1 = Readonly<{
  id: string;
  revision: number;
  sha256: string;
  contentType: CommerceMediaContentType;
  byteSize: number;
  altText: string;
  occurredAt: CommerceEngineTimestamp;
}>;

/** One image of a product; no variant ids means every variant. */
export type CommerceProductMediaItemV1 = Readonly<{
  mediaId: string;
  variantIds: readonly string[];
}>;

export type CommerceProductMediaV1 = Readonly<{
  productId: string;
  revision: number;
  media: readonly CommerceProductMediaItemV1[];
}>;

export type CommerceMediaLibraryV1 = Readonly<{
  schemaVersion: "underclerk.media.v1";
  media: readonly CommerceMediaV1[];
  products: readonly CommerceProductMediaV1[];
}>;

type MediaCommandBase = Readonly<{
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
}>;

export type CreateCommerceMediaV1 = MediaCommandBase &
  Readonly<{
    schemaVersion: "underclerk.create-media.v1";
    mediaId: string;
    sha256: string;
    altText: string;
  }>;

export type UpdateCommerceMediaV1 = MediaCommandBase &
  Readonly<{
    schemaVersion: "underclerk.update-media.v1";
    mediaId: string;
    expectedRevision: number;
    altText: string;
  }>;

export type DeleteCommerceMediaV1 = MediaCommandBase &
  Readonly<{
    schemaVersion: "underclerk.delete-media.v1";
    mediaId: string;
    expectedRevision: number;
  }>;

export type SetCommerceProductMediaV1 = MediaCommandBase &
  Readonly<{
    schemaVersion: "underclerk.set-product-media.v1";
    productId: string;
    /** The product's current media revision; 0 when it has none yet. */
    expectedRevision: number;
    media: readonly CommerceProductMediaItemV1[];
  }>;

export type CommerceMediaCommandV1 =
  | CreateCommerceMediaV1
  | UpdateCommerceMediaV1
  | DeleteCommerceMediaV1
  | SetCommerceProductMediaV1;

export function parseCreateMediaCommand(value: unknown): CreateCommerceMediaV1 {
  return decodeRecord(parseCreateCommerceMediaV1Record, value);
}

export function parseUpdateMediaCommand(value: unknown): UpdateCommerceMediaV1 {
  return decodeRecord(parseUpdateCommerceMediaV1Record, value);
}

export function parseDeleteMediaCommand(value: unknown): DeleteCommerceMediaV1 {
  return decodeRecord(parseDeleteCommerceMediaV1Record, value);
}

export function parseSetProductMediaCommand(value: unknown): SetCommerceProductMediaV1 {
  return decodeRecord(parseSetCommerceProductMediaV1Record, value);
}

export function parseMediaUpload(value: unknown): CommerceMediaUploadV1 {
  return decodeRecord(parseCommerceMediaUploadV1Record, value);
}

export function parseMedia(value: unknown): CommerceMediaV1 {
  return decodeRecord(parseCommerceMediaV1Record, value);
}

export function parseProductMedia(value: unknown): CommerceProductMediaV1 {
  return decodeRecord(parseCommerceProductMediaV1Record, value);
}

export function parseMediaLibrary(value: unknown): CommerceMediaLibraryV1 {
  return decodeRecord(parseCommerceMediaLibraryV1Record, value);
}
