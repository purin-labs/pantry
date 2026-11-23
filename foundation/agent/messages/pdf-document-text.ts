import type { Result } from "@purin-labs/kernel/result";

/**
 * Bounded text extraction for PDF.
 *
 * PDF stores text as byte strings inside content streams, addressed through
 * whatever encoding each font declares. For documents that use the standard
 * encodings — which covers the invoices, quotes, and menus this system actually
 * receives — those bytes are readable directly. For a subset font with a custom
 * CMap they are not, and decoding them without the font's mapping produces
 * plausible-looking nonsense.
 *
 * So extraction ends in a legibility gate. Text that does not read as text is
 * refused, and the caller states a limitation. A silently wrong transcript of a
 * price or a delivery date is worse than an honest "not read", and the agent
 * cannot tell the difference on its own.
 */

export const PDF_EXTRACTION_LIMITS = {
  maxDocumentBytes: 1024 * 1024,
  maxStreams: 256,
  maxDecodedBytes: 4 * 1024 * 1024,
  /** Share of characters that must be ordinary text for a result to be used. */
  minLegibleRatio: 0.85,
  minLegibleChars: 16,
} as const;

type PdfExtractionFailure =
  | { readonly code: "not_a_pdf" }
  | { readonly code: "document_too_large" }
  | { readonly code: "no_extractable_text" }
  | { readonly code: "text_not_legible"; readonly legibleRatio: number };

export async function extractPdfText(
  bytes: Uint8Array,
): Promise<Result<string, PdfExtractionFailure>> {
  if (!startsWith(bytes, "%PDF-")) {
    return { ok: false, error: { code: "not_a_pdf" } };
  }

  if (bytes.byteLength > PDF_EXTRACTION_LIMITS.maxDocumentBytes) {
    return { ok: false, error: { code: "document_too_large" } };
  }

  const decoded = await decodeContentStreams(bytes);
  const text = normalizePdfText(decoded.map(extractTextOperators).join("\n"));

  if (text.length === 0) {
    return { ok: false, error: { code: "no_extractable_text" } };
  }

  const ratio = legibleRatio(text);

  return ratio >= PDF_EXTRACTION_LIMITS.minLegibleRatio
    ? { ok: true, value: text }
    : { ok: false, error: { code: "text_not_legible", legibleRatio: ratio } };
}

/**
 * Inflates every content stream this reader can decode.
 *
 * Streams carrying an image or an encoding filter are skipped rather than
 * decoded incorrectly; a document whose text lives only in such streams ends up
 * with no extractable text, which is the honest outcome.
 */
async function decodeContentStreams(
  bytes: Uint8Array,
): Promise<readonly string[]> {
  const decoder = new TextDecoder("latin1");
  const haystack = decoder.decode(bytes);
  const decoded: string[] = [];
  let searchFrom = 0;
  let decodedBytes = 0;

  for (let index = 0; index < PDF_EXTRACTION_LIMITS.maxStreams; index += 1) {
    const streamAt = haystack.indexOf("stream", searchFrom);

    if (streamAt === -1) {
      break;
    }

    const endAt = haystack.indexOf("endstream", streamAt);

    if (endAt === -1) {
      break;
    }

    searchFrom = endAt + "endstream".length;

    const dictionary = haystack.slice(Math.max(0, streamAt - 512), streamAt);
    const dataStart =
      streamAt + skipStreamEol(haystack, streamAt + "stream".length);
    // The writer puts an EOL between the stream data and `endstream`; a zlib
    // decoder treats those trailing bytes as corruption.
    const raw = bytes.slice(
      dataStart,
      trimTrailingEol(bytes, dataStart, endAt),
    );

    if (raw.byteLength === 0) {
      continue;
    }

    decodedBytes += raw.byteLength;

    if (decodedBytes > PDF_EXTRACTION_LIMITS.maxDecodedBytes) {
      break;
    }

    if (!isDecodableStream(dictionary)) {
      continue;
    }

    if (dictionary.includes("/FlateDecode")) {
      const inflated = await inflate(raw);

      if (inflated !== null) {
        decoded.push(decoder.decode(inflated));
      }

      continue;
    }

    decoded.push(decoder.decode(raw));
  }

  return decoded;
}

function trimTrailingEol(
  bytes: Uint8Array,
  start: number,
  end: number,
): number {
  let cursor = end;

  while (
    cursor > start &&
    (bytes[cursor - 1] === 0x0a || bytes[cursor - 1] === 0x0d)
  ) {
    cursor -= 1;
  }

  return cursor;
}

/** True only when the stream carries no filter or a filter this reader has. */
function isDecodableStream(dictionary: string): boolean {
  if (!dictionary.includes("/Filter")) {
    return true;
  }

  // An image or a font program is not text, and a filter chain this reader
  // does not implement must not be guessed at.
  return (
    dictionary.includes("/FlateDecode") &&
    !dictionary.includes("/DCTDecode") &&
    !dictionary.includes("/JPXDecode") &&
    !dictionary.includes("/CCITTFaxDecode") &&
    !dictionary.includes("/JBIG2Decode") &&
    !dictionary.includes("/LZWDecode") &&
    !dictionary.includes("/RunLengthDecode")
  );
}

function skipStreamEol(haystack: string, offset: number): number {
  const consumed = haystack.startsWith("\r\n", offset)
    ? 2
    : haystack.startsWith("\n", offset) || haystack.startsWith("\r", offset)
      ? 1
      : 0;

  return "stream".length + consumed;
}

async function inflate(raw: Uint8Array): Promise<Uint8Array | null> {
  for (const format of ["deflate", "deflate-raw"] as const) {
    try {
      const source = new Response(raw).body;

      if (source === null) {
        continue;
      }

      const stream = source.pipeThrough(new DecompressionStream(format));

      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // A stream that will not inflate as one format may inflate as the other;
      // one that inflates as neither is skipped.
    }
  }

  return null;
}

/**
 * Reads the text-showing operators from one content stream.
 *
 * Only the operators that place text are honoured. Positioning operators become
 * whitespace so the extraction keeps the reading order a person would follow.
 */
export function extractTextOperators(content: string): string {
  const output: string[] = [];
  const pending: string[] = [];
  let index = 0;

  while (index < content.length) {
    const character = content[index];

    if (character === "(") {
      const literal = readLiteralString(content, index);

      pending.push(literal.value);
      index = literal.next;
      continue;
    }

    if (character === "<" && content[index + 1] !== "<") {
      const hex = readHexString(content, index);

      pending.push(hex.value);
      index = hex.next;
      continue;
    }

    if (character === "%") {
      while (index < content.length && content[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    const operator = readOperator(content, index);

    if (operator === null) {
      index += 1;
      continue;
    }

    switch (operator.name) {
      case "Tj":
      case "TJ":
      case "'":
      case '"':
        output.push(pending.join(""));
        pending.length = 0;
        break;
      case "Td":
      case "TD":
      case "T*":
      case "ET":
        output.push("\n");
        pending.length = 0;
        break;
      default:
        break;
    }

    index = operator.next;
  }

  return output.join("");
}

function readOperator(
  content: string,
  index: number,
): { name: string; next: number } | null {
  const character = content[index];

  if (character === undefined) {
    return null;
  }

  if (character === "'" || character === '"') {
    return { name: character, next: index + 1 };
  }

  if (!/[A-Za-z*]/u.test(character)) {
    return null;
  }

  let end = index;

  while (end < content.length && /[A-Za-z*\d]/u.test(content[end] ?? "")) {
    end += 1;
  }

  return { name: content.slice(index, end), next: end };
}

function readLiteralString(
  content: string,
  start: number,
): { value: string; next: number } {
  const characters: string[] = [];
  let depth = 1;
  let index = start + 1;

  while (index < content.length && depth > 0) {
    const character = content[index] ?? "";

    if (character === "\\") {
      const escaped = content[index + 1] ?? "";
      const simple: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        "(": "(",
        ")": ")",
        "\\": "\\",
      };

      if (escaped in simple) {
        characters.push(simple[escaped] ?? "");
        index += 2;
        continue;
      }

      if (/\d/u.test(escaped)) {
        const octal =
          content.slice(index + 1, index + 4).match(/^[0-7]{1,3}/u)?.[0] ?? "";

        characters.push(String.fromCharCode(Number.parseInt(octal, 8)));
        index += 1 + octal.length;
        continue;
      }

      index += 2;
      continue;
    }

    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;

      if (depth === 0) {
        index += 1;
        break;
      }
    }

    characters.push(character);
    index += 1;
  }

  return { value: characters.join(""), next: index };
}

function readHexString(
  content: string,
  start: number,
): { value: string; next: number } {
  const end = content.indexOf(">", start);

  if (end === -1) {
    return { value: "", next: content.length };
  }

  const digits = content.slice(start + 1, end).replace(/[^0-9a-fA-F]/gu, "");
  const characters: string[] = [];

  for (let index = 0; index + 1 < digits.length; index += 2) {
    characters.push(
      String.fromCharCode(Number.parseInt(digits.slice(index, index + 2), 16)),
    );
  }

  return { value: characters.join(""), next: end + 1 };
}

function normalizePdfText(value: string): string {
  return value
    .replace(/\u0000/gu, "")
    .replace(/[ \t]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * The share of characters that read as ordinary text.
 *
 * A subset font with a custom CMap yields byte values that decode to control
 * characters and unassigned code points; this is what separates a real
 * extraction from a confident-looking one.
 */
export function legibleRatio(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  let legible = 0;

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const printableAscii = code >= 0x20 && code <= 0x7e;
    const whitespace = character === "\n" || character === "\t";
    const latin = code >= 0xa0 && code <= 0x24f;

    if (printableAscii || whitespace || latin) {
      legible += 1;
    }
  }

  return legible / text.length;
}

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.byteLength < prefix.length) {
    return false;
  }

  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix.charCodeAt(index)) {
      return false;
    }
  }

  return true;
}
