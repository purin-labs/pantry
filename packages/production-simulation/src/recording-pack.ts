import {
  decodeCanonicalBase64,
  encodeBase64,
  isNonNegativeInteger,
  isRecord,
  parseJsonOrNull,
} from "@purin-labs/std";
import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import { parseSha256Hex, type Sha256Hex } from "./identity.ts";
import { err, ok, type Result } from "./result.ts";

/** Packs preserve exact native record bytes and their individual digests. */
export const RECORDING_PACK_SCHEMA_VERSION = 2;
/** Uncompressed record bytes per pack, before its bounded index is added. */
export const RECORDING_PACK_TARGET_BYTES = 8 * 1024 * 1024;
/** Bound stored bytes and the decoded allocation before reading a pack. */
export const MAX_RECORDING_PACK_BYTES = 16 * 1024 * 1024;

export type PackedRecord = Readonly<{
  digest: Sha256Hex;
  /** Bytes from the start of the decoded record body. */
  offset: number;
  byteLength: number;
}>;
export type DecodedRecordingPack = Readonly<{
  records: readonly PackedRecord[];
  body: string;
}>;
export type PackProblem =
  | Readonly<{ code: "not_ascii"; digest: Sha256Hex }>
  | Readonly<{ code: "invalid_header" | "invalid_body" | "pack_too_large" }>
  | Readonly<{ code: "unknown_record"; digest: Sha256Hex }>;
const ASCII = /^[\u0000-\u007f]*$/u;

export function packRecordings(
  records: readonly Readonly<{ digest: Sha256Hex; content: string }>[],
): Result<string, PackProblem> {
  const index: PackedRecord[] = [];
  let body = "";
  for (const record of records) {
    if (body.length + record.content.length > MAX_RECORDING_PACK_BYTES)
      return err({ code: "pack_too_large" });
    if (!ASCII.test(record.content))
      return err({ code: "not_ascii", digest: record.digest });
    index.push({
      digest: record.digest,
      offset: body.length,
      byteLength: record.content.length,
    });
    body += record.content;
  }
  // Compress the index too: per-tick digests and offsets otherwise dominate it.
  const decoded = `${JSON.stringify({ records: index })}\n${body}`;
  if (decoded.length > MAX_RECORDING_PACK_BYTES)
    return err({ code: "pack_too_large" });
  const header = JSON.stringify({
    kind: "recording-pack",
    schemaVersion: RECORDING_PACK_SCHEMA_VERSION,
    encoding: "deflate-base64",
    decodedBytes: decoded.length,
  });
  const packed = `${header}\n${encodeBase64(deflateSync(strToU8(decoded), { level: 6 }))}`;
  return packed.length <= MAX_RECORDING_PACK_BYTES
    ? ok(packed)
    : err({ code: "pack_too_large" });
}

function readRecords(
  raw: unknown,
  body: string,
): Result<DecodedRecordingPack, PackProblem> {
  if (!Array.isArray(raw)) return err({ code: "invalid_header" });
  const records: PackedRecord[] = [];
  const digests = new Set<string>();
  let cursor = 0;
  for (const record of raw) {
    const digest = isRecord(record) ? parseSha256Hex(record.digest) : null;
    if (
      !isRecord(record) ||
      digest === null ||
      !digest.ok ||
      !isNonNegativeInteger(record.offset) ||
      !isNonNegativeInteger(record.byteLength) ||
      record.byteLength === 0 ||
      record.offset !== cursor ||
      record.byteLength > body.length - cursor ||
      digests.has(digest.value)
    )
      return err({ code: "invalid_header" });
    records.push({
      digest: digest.value,
      offset: record.offset,
      byteLength: record.byteLength,
    });
    digests.add(digest.value);
    cursor += record.byteLength;
  }
  if (cursor !== body.length || !ASCII.test(body))
    return err({ code: "invalid_body" });
  return ok({ records, body });
}

/** Decode one bounded pack for indexing or adjacent record inspection. */
export function readRecordingPack(
  pack: string,
): Result<DecodedRecordingPack, PackProblem> {
  if (pack.length > MAX_RECORDING_PACK_BYTES)
    return err({ code: "pack_too_large" });
  const end = pack.indexOf("\n");
  const header = end < 0 ? null : parseJsonOrNull(pack.slice(0, end));
  if (!isRecord(header) || header.kind !== "recording-pack")
    return err({ code: "invalid_header" });
  // Import old bytes only at this persistence boundary. Writers emit v2.
  if (header.schemaVersion === 1)
    return readRecords(header.records, pack.slice(end + 1));
  if (
    header.schemaVersion !== RECORDING_PACK_SCHEMA_VERSION ||
    header.encoding !== "deflate-base64" ||
    !isNonNegativeInteger(header.decodedBytes)
  )
    return err({ code: "invalid_header" });
  if (header.decodedBytes > MAX_RECORDING_PACK_BYTES)
    return err({ code: "pack_too_large" });
  const compressed = decodeCanonicalBase64(
    pack.slice(end + 1),
    MAX_RECORDING_PACK_BYTES,
  );
  if (compressed === null) return err({ code: "invalid_body" });
  let decoded: string;
  try {
    // One extra byte detects overflow without an unbounded inflate allocation.
    const bytes = inflateSync(compressed, {
      out: new Uint8Array(header.decodedBytes + 1),
    });
    if (bytes.length !== header.decodedBytes)
      return err({ code: "invalid_body" });
    decoded = strFromU8(bytes, true);
  } catch {
    return err({ code: "invalid_body" });
  }
  const boundary = decoded.indexOf("\n");
  const index =
    boundary < 0 ? null : parseJsonOrNull(decoded.slice(0, boundary));
  if (!isRecord(index)) return err({ code: "invalid_header" });
  return readRecords(index.records, decoded.slice(boundary + 1));
}

/** The records a pack holds, in stored order. Discard the decoded body. */
export function packedRecords(
  pack: string,
): Result<readonly PackedRecord[], PackProblem> {
  const decoded = readRecordingPack(pack);
  return decoded.ok ? ok(decoded.value.records) : decoded;
}

/** One record's exact bytes. The caller verifies its content digest. */
export function readPackedRecording(
  pack: string,
  digest: Sha256Hex,
): Result<string, PackProblem> {
  const decoded = readRecordingPack(pack);
  if (!decoded.ok) return decoded;
  for (const record of decoded.value.records) {
    if (record.digest === digest)
      return ok(
        decoded.value.body.slice(
          record.offset,
          record.offset + record.byteLength,
        ),
      );
  }
  return err({ code: "unknown_record", digest });
}

/** Decode a pack once when inspecting several adjacent records. */
export function unpackRecordings(
  pack: string,
): Result<
  readonly Readonly<{ digest: Sha256Hex; content: string }>[],
  PackProblem
> {
  const decoded = readRecordingPack(pack);
  if (!decoded.ok) return decoded;
  const contents: { digest: Sha256Hex; content: string }[] = [];
  for (const record of decoded.value.records)
    contents.push({
      digest: record.digest,
      content: decoded.value.body.slice(
        record.offset,
        record.offset + record.byteLength,
      ),
    });
  return ok(contents);
}
