import {
  isNonNegativeInteger,
  isRecord,
  parseJsonOrNull,
  sha256Hex,
} from "@purin-labs/std";
import { strFromU8, strToU8 } from "fflate";
import type { PhysicsResult, PhysicsResultStore } from "./result-cache.ts";

/**
 * The persistent level of the physics result cache: append-only packs of
 * results in a directory. The browser gives it an OPFS directory; a Node host
 * gives it a directory on disk. Each pack has an index file, written after
 * the pack, so a pack without an index is never read. Each entry is stored
 * compressed (raw deflate of the reply and its export), and it carries the
 * SHA-256 of its stored bytes; an entry that does not match is a miss. When
 * the packs pass the limit, the oldest pack goes first. The limit counts
 * stored bytes.
 */

/** The files of one directory, as the store uses them. */
export type ResultFiles = Readonly<{
  list(): Promise<readonly string[]>;
  /** The bytes of `name` from `start` to `end`. */
  read(name: string, start: number, end: number): Promise<Uint8Array>;
  readAll(name: string): Promise<Uint8Array>;
  write(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  remove(name: string): Promise<void>;
}>;

/** Version 2 stores each entry compressed. A pack of another version is removed. */
const INDEX_SCHEMA_VERSION = 2;
const PACK = ".pack";
const INDEX = ".index";
/** A pack with no index after this long belongs to no writer. */
const ORPHAN_MS = 60 * 60 * 1000;

type Located = Readonly<{
  pack: string;
  offset: number;
  /** The compressed bytes in the pack. */
  storedLength: number;
  replyLength: number;
  /** -1 when the result has no export. */
  exportedLength: number;
  sha256: string;
}>;

type Pack = { name: string; bytes: number; keys: string[] };

function packName(): string {
  const random = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `${Date.now().toString().padStart(15, "0")}-${random}`;
}

function packTime(name: string): number {
  return Number(name.slice(0, 15));
}

/** A raw deflate stream of the platform's native codec (browser and Node). */
type CodecStream = Readonly<{
  writable: Readonly<{
    getWriter(): Readonly<{
      write(chunk: Uint8Array): Promise<void>;
      close(): Promise<void>;
    }>;
  }>;
  readable: Readonly<{
    getReader(): Readonly<{
      read(): Promise<
        | Readonly<{ done: true; value?: undefined }>
        | Readonly<{ done: false; value: Uint8Array }>
      >;
    }>;
  }>;
}>;
type Codec = new (format: "deflate-raw") => CodecStream;
const codecs = globalThis as unknown as Readonly<{
  CompressionStream: Codec;
  DecompressionStream: Codec;
}>;

async function transform(
  bytes: Uint8Array,
  stream: CodecStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const writer = stream.writable.getWriter();
  const written = writer.write(bytes).then(() => writer.close());
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(chunk.value);
    length += chunk.value.length;
  }
  await written;
  const joined = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined;
}

function compress(bytes: Uint8Array) {
  return transform(bytes, new codecs.CompressionStream("deflate-raw"));
}

function decompress(bytes: Uint8Array) {
  return transform(bytes, new codecs.DecompressionStream("deflate-raw"));
}

type Index =
  | Readonly<{ kind: "read"; entries: [string, Located][] }>
  | Readonly<{ kind: "other-version" }>
  | Readonly<{ kind: "invalid" }>;

function readIndex(name: string, bytes: Uint8Array): Index {
  const raw = parseJsonOrNull(strFromU8(bytes));
  if (!isRecord(raw) || !Array.isArray(raw.entries)) return { kind: "invalid" };
  if (raw.schemaVersion !== INDEX_SCHEMA_VERSION)
    return { kind: "other-version" };
  const entries: [string, Located][] = [];
  for (const entry of raw.entries) {
    if (!Array.isArray(entry) || entry.length !== 6) return { kind: "invalid" };
    const [key, offset, storedLength, replyLength, exportedLength, sha256] =
      entry;
    if (
      typeof key !== "string" ||
      !isNonNegativeInteger(offset) ||
      !isNonNegativeInteger(storedLength) ||
      !isNonNegativeInteger(replyLength) ||
      typeof exportedLength !== "number" ||
      !Number.isInteger(exportedLength) ||
      exportedLength < -1 ||
      typeof sha256 !== "string"
    )
      return { kind: "invalid" };
    entries.push([
      key,
      { pack: name, offset, storedLength, replyLength, exportedLength, sha256 },
    ]);
  }
  return { kind: "read", entries };
}

/** Opens the packs in `files`. Packs above `limitBytes` are removed, oldest first. */
export async function packedResultStore(
  files: ResultFiles,
  limitBytes: number,
  packBytes = 8 * 1024 * 1024,
): Promise<PhysicsResultStore & Readonly<{ bytes(): number }>> {
  const located = new Map<string, Located>();
  const packs: Pack[] = [];
  let total = 0;
  let pending: [string, PhysicsResult][] = [];
  const pendingKeys = new Map<string, PhysicsResult>();
  let pendingBytes = 0;
  let writing: Promise<void> = Promise.resolve();

  const names = [...(await files.list())].sort();
  const indexed = new Set<string>();
  for (const file of names) {
    if (!file.endsWith(INDEX)) continue;
    const name = file.slice(0, -INDEX.length);
    let index: Index = { kind: "invalid" };
    try {
      index = readIndex(name, await files.readAll(file));
    } catch {
      // Another writer removed it.
    }
    if (index.kind === "other-version") {
      // This version cannot read the pack, and it counts against the limit.
      await files.remove(file).catch(() => undefined);
      await files.remove(`${name}${PACK}`).catch(() => undefined);
      continue;
    }
    if (index.kind === "invalid") continue;
    indexed.add(name);
    const pack: Pack = { name, bytes: 0, keys: [] };
    for (const [key, entry] of index.entries) {
      located.set(key, entry);
      pack.keys.push(key);
      pack.bytes += entry.storedLength;
    }
    packs.push(pack);
    total += pack.bytes;
  }
  for (const file of names)
    if (
      file.endsWith(PACK) &&
      !indexed.has(file.slice(0, -PACK.length)) &&
      Date.now() - packTime(file) > ORPHAN_MS
    )
      await files.remove(file).catch(() => undefined);

  async function evict(): Promise<void> {
    while (total > limitBytes && packs.length > 0) {
      const oldest = packs.shift();
      if (oldest === undefined) break;
      total -= oldest.bytes;
      for (const key of oldest.keys)
        if (located.get(key)?.pack === oldest.name) located.delete(key);
      // The index goes first, so no reader finds a pack without its bytes.
      await files.remove(`${oldest.name}${INDEX}`).catch(() => undefined);
      await files.remove(`${oldest.name}${PACK}`).catch(() => undefined);
    }
  }

  async function write(entries: [string, PhysicsResult][]): Promise<void> {
    const parts: Uint8Array[] = [];
    const index: (string | number)[][] = [];
    const name = packName();
    const pack: Pack = { name, bytes: 0, keys: [] };
    let offset = 0;
    for (const [key, result] of entries) {
      const reply = strToU8(result.reply);
      const exported =
        result.exported === null ? null : strToU8(result.exported);
      const frame = new Uint8Array(reply.length + (exported?.length ?? 0));
      frame.set(reply);
      if (exported !== null) frame.set(exported, reply.length);
      const stored = await compress(frame);
      index.push([
        key,
        offset,
        stored.length,
        reply.length,
        exported === null ? -1 : exported.length,
        await sha256Hex(stored),
      ]);
      parts.push(stored);
      offset += stored.length;
      pack.keys.push(key);
    }
    const body = new Uint8Array(offset);
    let at = 0;
    for (const part of parts) {
      body.set(part, at);
      at += part.length;
    }
    await files.write(`${name}${PACK}`, body);
    await files.write(
      `${name}${INDEX}`,
      new Uint8Array(
        strToU8(
          JSON.stringify({
            schemaVersion: INDEX_SCHEMA_VERSION,
            entries: index,
          }),
        ),
      ),
    );
    for (const entry of index) {
      const [
        key,
        entryOffset,
        storedLength,
        replyLength,
        exportedLength,
        sha256,
      ] = entry as [string, number, number, number, number, string];
      located.set(key, {
        pack: name,
        offset: entryOffset,
        storedLength,
        replyLength,
        exportedLength,
        sha256,
      });
    }
    pack.bytes = offset;
    packs.push(pack);
    total += offset;
    await evict();
  }

  function flush(): Promise<void> {
    if (pending.length > 0) {
      const entries = pending;
      pending = [];
      pendingBytes = 0;
      writing = writing.then(() =>
        write(entries)
          .catch(() => undefined)
          .finally(() => {
            for (const [key] of entries) pendingKeys.delete(key);
          }),
      );
    }
    return writing;
  }

  return {
    async get(key) {
      const held = pendingKeys.get(key);
      if (held !== undefined) return held;
      const entry = located.get(key);
      if (entry === undefined) return null;
      const length = entry.replyLength + Math.max(0, entry.exportedLength);
      try {
        const stored = new Uint8Array(
          await files.read(
            `${entry.pack}${PACK}`,
            entry.offset,
            entry.offset + entry.storedLength,
          ),
        );
        if (
          stored.length !== entry.storedLength ||
          (await sha256Hex(stored)) !== entry.sha256
        ) {
          located.delete(key);
          return null;
        }
        const frame = await decompress(stored);
        if (frame.length !== length) {
          located.delete(key);
          return null;
        }
        return {
          reply: strFromU8(frame.subarray(0, entry.replyLength)),
          exported:
            entry.exportedLength < 0
              ? null
              : strFromU8(frame.subarray(entry.replyLength)),
        };
      } catch {
        // Another writer removed the pack.
        located.delete(key);
        return null;
      }
    },
    put(key, result) {
      if (located.has(key) || pendingKeys.has(key)) return;
      pending.push([key, result]);
      pendingKeys.set(key, result);
      pendingBytes += result.reply.length + (result.exported?.length ?? 0);
      if (pendingBytes >= packBytes) void flush();
    },
    flush,
    bytes: () => total,
  };
}
