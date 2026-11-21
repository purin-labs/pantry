/**
 * Small runtime helpers shared by the Worker, the portal, Commerce and the
 * packages they use. Every function is pure and dependency-free, and runs
 * unchanged in Workers, browsers and Node.
 */

// The runtime globals used below, declared here so the package compiles under
// any consumer's lib: DOM for the portal, Workers types for the Worker, ES only
// for contracts.
declare const crypto: {
  readonly subtle: {
    digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
  };
};
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare function atob(data: string): string;
declare function btoa(data: string): string;
declare function setTimeout(callback: () => void, milliseconds: number): unknown;

// The liveness frames of a socket that an Actor accepts through the
// hibernation API. The Actor's runtime answers the ping without waking the
// Actor, so a client checks its connection without a charge for the Actor's
// time. A socket that is silent for longer than the expiry lost its client.
export const SOCKET_PING = "satyr.ping";
export const SOCKET_PONG = "satyr.pong";
export const SOCKET_PRESENCE_EXPIRY_MS = 90_000;

// Rust-compatible text rules. Validate Unicode scalar values at the boundary.

/** UTF-8 bytes, matching Rust String::len() for valid Unicode text. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Unicode scalar count, matching Rust str::chars().count(). */
export function codePointCount(value: string): number {
  let count = 0;
  for (const _character of value) count++;
  return count;
}

// Unicode White_Space, the set of Rust char::is_whitespace and str::trim. It
// has U+0085 and lacks U+FEFF, unlike JavaScript String.prototype.trim.
const RUST_WHITESPACE =
  "\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const RUST_TRIM = new RegExp(
  `^[${RUST_WHITESPACE}]+|[${RUST_WHITESPACE}]+$`,
  "gu",
);
const RUST_WHITESPACE_CHARACTER = new RegExp(`[${RUST_WHITESPACE}]`, "u");
// General category Cc, the set of Rust char::is_control.
const RUST_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

/** Rust str::trim: removes leading and trailing Unicode White_Space. */
export function rustTrim(value: string): string {
  return value.replace(RUST_TRIM, "");
}

/** True when the text holds a character for which Rust char::is_whitespace is true. */
export function hasRustWhitespace(value: string): boolean {
  return RUST_WHITESPACE_CHARACTER.test(value);
}

/** True when the text holds a character for which Rust char::is_control is true. */
export function hasRustControl(value: string): boolean {
  return RUST_CONTROL_CHARACTER.test(value);
}

/**
 * True when the text has an unpaired surrogate. Rust strings cannot hold one,
 * and serde_json refuses its JSON escape.
 */
export function hasLoneSurrogate(value: string): boolean {
  // With the u flag a surrogate pair is one code point, so only a lone half matches.
  return /[\ud800-\udfff]/u.test(value);
}

/** Lexicographic scalar order, matching Rust strings and BTreeMap string keys. */
export function compareCodePoints(left: string, right: string): number {
  const leftCharacters = left[Symbol.iterator]();
  const rightCharacters = right[Symbol.iterator]();
  while (true) {
    const a = leftCharacters.next();
    const b = rightCharacters.next();
    if (a.done) return b.done ? 0 : -1;
    if (b.done) return 1;
    const difference = a.value.codePointAt(0)! - b.value.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
}

// Value guards

/** Whether `value` is a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Whether `value` is a string with at least one character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Whether `value` is a string with at least one non-whitespace character. */
export function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Whether `value` is a safe integer greater than zero. */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Whether `value` is a safe integer of zero or more. */
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Whether `value` is text with nothing to trim: non-empty, without leading or
 * trailing whitespace, and at most `maxLength` characters.
 */
export function isNormalizedText(
  value: unknown,
  maxLength = Number.POSITIVE_INFINITY,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim()
  );
}

/** `value` when it is a safe integer greater than zero, otherwise null. */
export function positiveIntegerOrNull(value: unknown): number | null {
  return isPositiveInteger(value) ? value : null;
}

/** `value` when it is a safe integer of zero or more, otherwise null. */
export function nonNegativeIntegerOrNull(value: unknown): number | null {
  return isNonNegativeInteger(value) ? value : null;
}

/** Whether `value` has exactly the own keys `keys`: none missing, none extra. */
export function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Whether every own key of `value` is one of `keys`. Keys may be missing. */
export function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/**
 * The message of an `Error`. Anything else becomes `fallback` when one is
 * given, such as text for a person to read, and is stringified otherwise.
 */
export function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  return fallback ?? String(error);
}

// Exhaustiveness

/**
 * A literal list of every member of the union `U`, checked at compile time:
 * `exhaustiveList<Kind>()(["a", "b"])` fails to compile when the list misses a
 * member of `Kind` or names something else, so it cannot drift from `U`.
 */
export function exhaustiveList<U extends string | number>() {
  return function listing<const L extends readonly U[]>(
    list: L &
      ([Exclude<U, L[number]>] extends [never]
        ? unknown
        : { readonly missing: Exclude<U, L[number]> }),
  ): readonly U[] {
    return list;
  };
}

/**
 * Marks a branch the type checker has proven unreachable. Reaching it at
 * runtime means a value arrived that its type does not allow, so the error
 * names the value: `${subject}: ${value}`.
 */
export function assertNever(value: never, subject = "Unhandled value"): never {
  throw new Error(`${subject}: ${describeUnexpected(value)}`);
}

function describeUnexpected(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// Time

/** Resolves after `milliseconds`. */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Exponential backoff: `baseMs` for retry 0, doubled for each later retry and
 * capped at `maxMs`. A negative retry counts as retry 0.
 */
export function backoffDelay(
  retry: number,
  baseMs: number,
  maxMs = Number.POSITIVE_INFINITY,
): number {
  return Math.min(baseMs * 2 ** Math.max(0, retry), maxMs);
}

// Encoding

/** Lowercase hexadecimal, two digits per byte. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Standard, padded base64. */
export function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

/** URL-safe base64 without padding. */
export function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/**
 * Decodes standard base64, or returns null when `atob` rejects the input.
 * As lenient as `atob`: callers that need canonical input must check it.
 */
export function decodeBase64(value: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Decodes URL-safe base64 without padding, or returns null when `value` is
 * empty, holds a character outside the URL-safe alphabet (padding included),
 * or is not base64.
 */
export function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  return decodeBase64(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
}

/**
 * Decodes canonical, padded base64 of at most `maxBytes` bytes, or returns
 * null. Canonical means that re-encoding the bytes reproduces `value`, so the
 * whitespace and alternative spellings `atob` tolerates are rejected, and
 * oversized input is refused before it is decoded.
 */
export function decodeCanonicalBase64(
  value: string,
  maxBytes = Number.POSITIVE_INFINITY,
): Uint8Array | null {
  if (value.length % 4 !== 0 || value.length > Math.ceil(maxBytes / 3) * 4) {
    return null;
  }
  const bytes = decodeBase64(value);
  if (bytes === null || bytes.length > maxBytes) return null;
  return encodeBase64(bytes) === value ? bytes : null;
}

// JSON

/** `JSON.parse`, typed as `unknown` so the result must be checked. */
export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/**
 * The parsed value, or null when `text` is not JSON. The literal `null` also
 * parses to null, so use this only where null is not a valid value.
 */
export function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Digests

/** Whether `value` is a SHA-256 digest as 64 lowercase hex digits. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

/** The SHA-256 digest of a UTF-8 string or of bytes, as lowercase hex. */
export async function sha256Hex(
  input: string | Uint8Array | ArrayBuffer,
): Promise<string> {
  const data =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
  );
}

/**
 * The same digest as {@link sha256Hex}, computed in JavaScript. Use it only
 * where a caller must stay synchronous, such as a Durable Object SQL
 * transaction; WebCrypto is faster for large inputs.
 */
export function sha256HexSync(
  input: string | Uint8Array | ArrayBuffer,
): string {
  const data =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
  const length = data.length;
  const blocks = Math.ceil((length + 9) / 64);
  const message = new Uint8Array(blocks * 64);
  message.set(data);
  message[length] = 0x80;
  const view = new DataView(message.buffer);
  view.setUint32(message.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(message.length - 4, (length * 8) >>> 0);
  const state = Uint32Array.of(...SHA256_INITIAL);
  const words = new Uint32Array(64);
  for (let block = 0; block < blocks; block++) {
    for (let index = 0; index < 16; index++)
      words[index] = view.getUint32(block * 64 + index * 4);
    for (let index = 16; index < 64; index++) {
      const early = words[index - 15]!;
      const late = words[index - 2]!;
      const s0 = rotr(early, 7) ^ rotr(early, 18) ^ (early >>> 3);
      const s1 = rotr(late, 17) ^ rotr(late, 19) ^ (late >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;
    for (let index = 0; index < 64; index++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + SHA256_ROUND[index]! + words[index]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    state[0] = state[0]! + a;
    state[1] = state[1]! + b;
    state[2] = state[2]! + c;
    state[3] = state[3]! + d;
    state[4] = state[4]! + e;
    state[5] = state[5]! + f;
    state[6] = state[6]! + g;
    state[7] = state[7]! + h;
  }
  const digest = new Uint8Array(32);
  const output = new DataView(digest.buffer);
  for (let index = 0; index < 8; index++)
    output.setUint32(index * 4, state[index]!);
  return bytesToHex(digest);
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
] as const;

const SHA256_ROUND = Uint32Array.of(
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
);

// Canonical JSON

/**
 * Deterministic JSON for digests and comparisons: object keys are sorted,
 * everything else is written as `JSON.stringify` writes it. Object members
 * that `JSON.stringify` omits (undefined, functions, symbols) are omitted and
 * become `null` inside arrays. A safe-integer bigint is written as a number.
 * Non-finite numbers, unsafe bigints and a top-level value with no JSON form
 * throw, because a digest over them would not mean what it claims.
 */
export function canonicalJson(value: unknown): string {
  return encodeCanonicalRoot(value, compareUtf16);
}

/** Rust serde_json map order. Existing JavaScript digest formats keep canonicalJson. */
export function canonicalJsonByCodePoint(value: unknown): string {
  return encodeCanonicalRoot(value, compareCodePoints);
}

function encodeCanonicalRoot(
  value: unknown,
  compareKeys: (left: string, right: string) => number,
): string {
  const encoded = encodeCanonical(value, compareKeys);
  if (encoded === undefined) {
    throw new TypeError("canonical JSON has no representation for this value");
  }
  return encoded;
}

/** Whether two values have the same canonical JSON. */
export function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function encodeCanonical(
  value: unknown,
  compareKeys: (left: string, right: string) => number,
): string | undefined {
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("canonical JSON numbers must be finite");
      }
      return JSON.stringify(value);
    case "bigint": {
      const integer = Number(value);
      if (!Number.isSafeInteger(integer)) {
        throw new TypeError("canonical JSON integers must be safe integers");
      }
      return JSON.stringify(integer);
    }
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (const item of value)
          items.push(encodeCanonical(item, compareKeys) ?? "null");
        return `[${items.join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const fields: string[] = [];
      for (const key of Object.keys(record).sort(compareKeys)) {
        const encoded = encodeCanonical(record[key], compareKeys);
        if (encoded !== undefined)
          fields.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${fields.join(",")}}`;
    }
    default:
      return undefined;
  }
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
