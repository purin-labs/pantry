// Product media bytes in R2 (Plan 76A step 1). An upload is kept under its
// SHA-256, so the same image uploaded twice is one object and a media record
// can name its bytes by digest. Only raster images whose first bytes match
// the declared type are kept.
import { createHash } from "node:crypto";

import {
  MEDIA_CONTENT_TYPES,
  MEDIA_MAX_BYTES,
  type CommerceMediaContentType,
  type CommerceMediaUploadV1,
} from "@purin-labs/commerce-client";

export type StoredMedia = Readonly<{
  size: number;
  contentType: string;
  sha256: string;
}>;

export interface MediaStore {
  head(key: string): Promise<StoredMedia | null>;
  put(key: string, body: Uint8Array, media: Omit<StoredMedia, "size">): Promise<void>;
  get(key: string): Promise<(StoredMedia & { body: ReadableStream | Uint8Array<ArrayBuffer> }) | null>;
  delete(key: string): Promise<void>;
}

/** The R2 bucket binding, as far as media uses it. */
export type R2MediaBucket = Readonly<{
  head: (key: string) => Promise<R2MediaObject | null>;
  put: (
    key: string,
    body: Uint8Array,
    options: Readonly<{
      httpMetadata: Readonly<{ contentType: string }>;
      customMetadata: Readonly<Record<string, string>>;
    }>,
  ) => Promise<unknown>;
  get: (key: string) => Promise<(R2MediaObject & { body: ReadableStream }) | null>;
  delete: (key: string) => Promise<void>;
}>;

type R2MediaObject = {
  size: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
};

export class R2MediaStore implements MediaStore {
  readonly #bucket: R2MediaBucket;

  constructor(bucket: R2MediaBucket) {
    this.#bucket = bucket;
  }

  async head(key: string): Promise<StoredMedia | null> {
    return storedMedia(await this.#bucket.head(key));
  }

  async put(key: string, body: Uint8Array, media: Omit<StoredMedia, "size">) {
    await this.#bucket.put(key, body, {
      httpMetadata: { contentType: media.contentType },
      customMetadata: { sha256: media.sha256 },
    });
  }

  async get(key: string) {
    const object = await this.#bucket.get(key);
    const media = storedMedia(object);
    return object === null || media === null ? null : { ...media, body: object.body };
  }

  async delete(key: string): Promise<void> {
    await this.#bucket.delete(key);
  }
}

function storedMedia(object: R2MediaObject | null): StoredMedia | null {
  const contentType = object?.httpMetadata?.contentType;
  const sha256 = object?.customMetadata?.sha256;
  return object === null || contentType === undefined || sha256 === undefined
    ? null
    : { size: object.size, contentType, sha256 };
}

export function mediaObjectKey(merchantId: string, sha256: string): string {
  return `merchants/${merchantId}/media/${sha256}`;
}

type MediaUploadOutcome =
  | Readonly<{ kind: "stored"; upload: CommerceMediaUploadV1 }>
  | Readonly<{ kind: "refused"; status: 413 | 415; message: string }>;

/** Checks and keeps one upload; a repeat of the same bytes writes nothing. */
export async function storeMediaUpload(
  store: MediaStore,
  merchantId: string,
  bytes: Uint8Array,
  declaredType: string,
): Promise<MediaUploadOutcome> {
  const contentType = MEDIA_CONTENT_TYPES.find(
    (type) => type === declaredType.split(";")[0]?.trim().toLowerCase(),
  );
  if (contentType === undefined)
    return { kind: "refused", status: 415, message: "Upload a JPEG, PNG, WebP, AVIF or GIF image" };
  if (bytes.byteLength === 0 || bytes.byteLength > MEDIA_MAX_BYTES)
    return { kind: "refused", status: 413, message: "An image must be 1 byte to 20 MB" };
  if (sniffImageType(bytes) !== contentType)
    return { kind: "refused", status: 415, message: `The bytes are not ${contentType}` };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = mediaObjectKey(merchantId, sha256);
  const existing = await store.head(key);
  if (existing?.sha256 !== sha256 || existing.size !== bytes.byteLength)
    await store.put(key, bytes, { contentType, sha256 });
  return {
    kind: "stored",
    upload: {
      schemaVersion: "underclerk.media-upload.v1",
      sha256,
      contentType,
      byteSize: bytes.byteLength,
    },
  };
}

function sniffImageType(bytes: Uint8Array): CommerceMediaContentType | undefined {
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => bytes[index] === byte,
    )
  )
    return "image/png";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(8, 12))) return "image/avif";
  return undefined;
}
