import type { ByteLength } from "./ByteLength";
import type { MediaType } from "./MediaType";
import type { ObjectKey } from "./ObjectKey";
import type { Sha256Digest } from "./Sha256Digest";

export type EventBody<T> =
  | { kind: "inline"; value: T }
  | {
      kind: "content_ref";
      objectKey: ObjectKey;
      sha256: Sha256Digest;
      mediaType: MediaType;
      byteLength: ByteLength;
    };
