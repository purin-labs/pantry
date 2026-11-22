import type { Result } from "@purin-labs/kernel/result";

/**
 * Bounded text extraction for the ZIP-backed office formats.
 *
 * DOCX and ODT are ZIP archives holding XML. Both can be read here without a
 * decoder library and without leaving the Worker: the central directory gives
 * exact entry offsets and sizes, and `DecompressionStream` inflates the one
 * entry that holds the document body.
 *
 * Extraction is deliberately conservative. Anything this reader cannot parse
 * with certainty returns a typed refusal so the caller can state a limitation,
 * because a silently partial transcript of a quote or contract is worse than an
 * honest "not read".
 */

export const OFFICE_EXTRACTION_LIMITS = {
  /** Archive bytes accepted for inspection. */
  maxArchiveBytes: 1024 * 1024,
  /** Inflated body bytes accepted from the single document entry. */
  maxEntryBytes: 4 * 1024 * 1024,
  /** Entries scanned before the archive is treated as hostile. */
  maxEntries: 512,
} as const;

type OfficeExtractionFailure =
  | { readonly code: "not_an_archive" }
  | { readonly code: "archive_too_large" }
  | { readonly code: "document_entry_missing" }
  | { readonly code: "entry_too_large" }
  | { readonly code: "unsupported_compression"; readonly method: number }
  | { readonly code: "decompression_failed" };

/** The entry each format keeps its body in. */
const DOCUMENT_ENTRIES: Readonly<Record<string, string>> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "word/document.xml",
  "application/vnd.oasis.opendocument.text": "content.xml",
};

export function supportsOfficeExtraction(mediaType: string): boolean {
  return mediaType in DOCUMENT_ENTRIES;
}

export async function extractOfficeDocumentText(
  bytes: Uint8Array,
  mediaType: string,
): Promise<Result<string, OfficeExtractionFailure>> {
  const entryName = DOCUMENT_ENTRIES[mediaType];

  if (entryName === undefined) {
    return { ok: false, error: { code: "document_entry_missing" } };
  }

  if (bytes.byteLength > OFFICE_EXTRACTION_LIMITS.maxArchiveBytes) {
    return { ok: false, error: { code: "archive_too_large" } };
  }

  const entry = findZipEntry(bytes, entryName);

  if (!entry.ok) {
    return entry;
  }

  const inflated = await readEntryBytes(bytes, entry.value);

  if (!inflated.ok) {
    return inflated;
  }

  return {
    ok: true,
    value: officeXmlToText(new TextDecoder("utf-8").decode(inflated.value)),
  };
}

type ZipEntry = {
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
};

/**
 * Locates one entry through the central directory.
 *
 * The central directory is authoritative: local headers may omit sizes when the
 * writer streams, and a hostile archive can disagree with itself between the
 * two. Reading the directory avoids trusting the stream.
 */
function findZipEntry(
  bytes: Uint8Array,
  entryName: string,
): Result<ZipEntry, OfficeExtractionFailure> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes);

  if (eocd === null) {
    return { ok: false, error: { code: "not_an_archive" } };
  }

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const target = new TextEncoder().encode(entryName);

  for (
    let index = 0;
    index < Math.min(entryCount, OFFICE_EXTRACTION_LIMITS.maxEntries);
    index += 1
  ) {
    if (
      offset + 46 > bytes.byteLength ||
      view.getUint32(offset, true) !== 0x02014b50
    ) {
      return { ok: false, error: { code: "not_an_archive" } };
    }

    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;

    if (nameStart + nameLength > bytes.byteLength) {
      return { ok: false, error: { code: "not_an_archive" } };
    }

    if (matchesName(bytes, nameStart, target)) {
      return {
        ok: true,
        value: {
          compressionMethod: view.getUint16(offset + 10, true),
          compressedSize: view.getUint32(offset + 20, true),
          uncompressedSize: view.getUint32(offset + 24, true),
          localHeaderOffset: view.getUint32(offset + 42, true),
        },
      };
    }

    offset = nameStart + nameLength + extraLength + commentLength;
  }

  return { ok: false, error: { code: "document_entry_missing" } };
}

function matchesName(
  bytes: Uint8Array,
  start: number,
  target: Uint8Array,
): boolean {
  if (start + target.byteLength > bytes.byteLength) {
    return false;
  }

  for (let index = 0; index < target.byteLength; index += 1) {
    if (bytes[start + index] !== target[index]) {
      return false;
    }
  }

  return true;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 22) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The record is last, after a comment of at most 64 KiB.
  const earliest = Math.max(0, bytes.byteLength - 22 - 0xffff);

  for (let offset = bytes.byteLength - 22; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      return offset;
    }
  }

  return null;
}

async function readEntryBytes(
  bytes: Uint8Array,
  entry: ZipEntry,
): Promise<Result<Uint8Array, OfficeExtractionFailure>> {
  if (entry.uncompressedSize > OFFICE_EXTRACTION_LIMITS.maxEntryBytes) {
    return { ok: false, error: { code: "entry_too_large" } };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local = entry.localHeaderOffset;

  if (
    local + 30 > bytes.byteLength ||
    view.getUint32(local, true) !== 0x04034b50
  ) {
    return { ok: false, error: { code: "not_an_archive" } };
  }

  const dataStart =
    local +
    30 +
    view.getUint16(local + 26, true) +
    view.getUint16(local + 28, true);
  const dataEnd = dataStart + entry.compressedSize;

  if (dataEnd > bytes.byteLength) {
    return { ok: false, error: { code: "not_an_archive" } };
  }

  const compressed = bytes.slice(dataStart, dataEnd);

  // 0 is stored, 8 is deflate. Anything else needs a codec this reader does not
  // have, and guessing is not an option.
  if (entry.compressionMethod === 0) {
    return { ok: true, value: compressed };
  }

  if (entry.compressionMethod !== 8) {
    return {
      ok: false,
      error: {
        code: "unsupported_compression",
        method: entry.compressionMethod,
      },
    };
  }

  try {
    const source = new Response(compressed).body;

    if (source === null) {
      return { ok: false, error: { code: "decompression_failed" } };
    }

    const stream = source.pipeThrough(new DecompressionStream("deflate-raw"));
    const inflated = new Uint8Array(await new Response(stream).arrayBuffer());

    // A declared size cannot be trusted to bound the real one.
    return inflated.byteLength > OFFICE_EXTRACTION_LIMITS.maxEntryBytes
      ? { ok: false, error: { code: "entry_too_large" } }
      : { ok: true, value: inflated };
  } catch {
    return { ok: false, error: { code: "decompression_failed" } };
  }
}

/**
 * Reduces the document body to readable prose.
 *
 * Paragraph and line-break elements become newlines so the extracted text keeps
 * the shape a reader would see; every other element is dropped rather than
 * interpreted.
 */
export function officeXmlToText(xml: string): string {
  const withBreaks = xml
    .replace(/<\/(w:p|text:p|text:h)>/gu, "\n")
    .replace(/<(w:br|w:tab|text:line-break|text:tab)\b[^>]*\/?>/gu, " ")
    .replace(/<[^>]+>/gu, "");

  return decodeXmlEntities(withBreaks)
    .replace(/[ \t]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, function decodeDecimal(_match, code: string) {
      return String.fromCodePoint(Number(code));
    })
    .replace(/&amp;/gu, "&");
}
