import {
  contractRefusal,
  type ContractDecodeResult,
} from "@purin-labs/contract-schema";
import { utf8ByteLength } from "@purin-labs/std";

import type { CommerceCursor } from "./query-pagination.ts";

const MAX_COMMERCE_CURSOR_LENGTH = 16 * 1024;

/** Decode the transport only. The owning payload parser must admit the bytes. */
export function decodeCommerceCursorBytes(
  cursor: CommerceCursor,
): ContractDecodeResult<Uint8Array> {
  if (utf8ByteLength(cursor) > MAX_COMMERCE_CURSOR_LENGTH) {
    return refused("invalid_query", "commerce cursor exceeds its byte limit");
  }
  if (!cursor.startsWith("v1_")) {
    return refused("parse", "unsupported commerce cursor version");
  }
  const encoded = cursor.slice(3);
  if (
    encoded.length === 0 ||
    encoded.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(encoded)
  ) {
    return refused("parse", "invalid commerce cursor encoding");
  }
  const bytes = new Uint8Array(encoded.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(encoded.slice(index * 2, index * 2 + 2), 16);
  }
  return { ok: true, value: bytes };
}

function refused(
  code: "parse" | "invalid_query",
  reason: string,
): ContractDecodeResult<never> {
  return contractRefusal({ code, reason, details: null });
}
