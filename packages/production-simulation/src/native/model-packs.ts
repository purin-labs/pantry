import { isRecord, parseJsonOrNull } from "@purin-labs/std";
import type { TextCellTransport } from "./wasm-transport.ts";

/**
 * Model packs (Refactor 16, step 11). A runtime bundle carries its model
 * files in packs: one for each robot, one for each appliance with meshes,
 * and one core pack for the rest. Its index (`models.json`) names the files
 * of each pack. A host mounts the core pack when the module starts, and
 * another pack when the engine first refuses a command for one of its files
 * (`withModelPacks`), so a job fetches only the models that it uses.
 *
 * The bundle descriptor names each pack and the index by SHA-256, and the
 * host checks those once, before it mounts a pack. The engine does not hash
 * the files again.
 */

export const MODEL_INDEX_FILE = "models.json";
export const MODEL_INDEX_FORMAT = "bakery-model-index/1";
const PACK_FORMAT = "bakery-model-pack/1";

export type ModelPackEntry = Readonly<{
  name: string;
  /** The pack's file in the bundle directory. */
  file: string;
  /** The files of the pack, below the engine's asset root. */
  paths: readonly string[];
}>;

export type ModelIndex = Readonly<{
  format: typeof MODEL_INDEX_FORMAT;
  /** The pack that a host mounts when the module starts. */
  core: string;
  packs: readonly ModelPackEntry[];
}>;

export type ModelFile = Readonly<{ path: string; bytes: Uint8Array }>;

/** The part of the module's file system that a pack needs. */
export type PackFileSystem = Readonly<{
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
}>;

const NAME = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
// A model file is a relative path with no empty, "." or ".." part.
const PATH =
  /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)*$/u;

function isStrings(value: unknown, pattern: RegExp): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && pattern.test(item))
  );
}

/** Reads a model index, or null when it is not one. */
export function parseModelIndex(text: string): ModelIndex | null {
  const raw = parseJsonOrNull(text);
  if (
    !isRecord(raw) ||
    raw.format !== MODEL_INDEX_FORMAT ||
    typeof raw.core !== "string" ||
    !Array.isArray(raw.packs)
  )
    return null;
  const packs: ModelPackEntry[] = [];
  const seen = new Set<string>();
  for (const pack of raw.packs) {
    if (
      !isRecord(pack) ||
      typeof pack.name !== "string" ||
      !NAME.test(pack.name) ||
      typeof pack.file !== "string" ||
      !FILE.test(pack.file) ||
      !isStrings(pack.paths, PATH)
    )
      return null;
    for (const path of pack.paths) {
      // A file belongs to one pack.
      if (seen.has(path)) return null;
      seen.add(path);
    }
    packs.push({ name: pack.name, file: pack.file, paths: pack.paths });
  }
  return packs.some((pack) => pack.name === raw.core)
    ? { format: MODEL_INDEX_FORMAT, core: raw.core, packs }
    : null;
}

/** The pack that holds `path`, or null when no pack holds it. */
export function packOf(index: ModelIndex, path: string): ModelPackEntry | null {
  return index.packs.find((pack) => pack.paths.includes(path)) ?? null;
}

/**
 * One pack: a JSON line that names each file and its length, then the
 * bytes of the files in that order.
 */
export function writePack(files: readonly ModelFile[]): Uint8Array {
  for (const { path } of files)
    if (!PATH.test(path)) throw new Error(`A pack cannot hold ${path}.`);
  const header = asciiBytes(
    `${JSON.stringify({
      format: PACK_FORMAT,
      files: files.map(({ path, bytes }) => ({
        path,
        byteLength: bytes.byteLength,
      })),
    })}\n`,
  );
  const total = files.reduce(
    (sum, file) => sum + file.bytes.byteLength,
    header.byteLength,
  );
  const pack = new Uint8Array(total);
  pack.set(header, 0);
  let offset = header.byteLength;
  for (const { bytes } of files) {
    pack.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return pack;
}

/** The files of a pack, or null when the bytes are not one pack. */
export function readPack(pack: Uint8Array): ModelFile[] | null {
  const end = pack.indexOf(0x0a);
  if (end < 0) return null;
  const text = asciiText(pack.subarray(0, end));
  const header = text === null ? null : parseJsonOrNull(text);
  if (
    !isRecord(header) ||
    header.format !== PACK_FORMAT ||
    !Array.isArray(header.files)
  )
    return null;
  const files: ModelFile[] = [];
  let offset = end + 1;
  for (const file of header.files) {
    if (
      !isRecord(file) ||
      typeof file.path !== "string" ||
      !PATH.test(file.path) ||
      typeof file.byteLength !== "number" ||
      !Number.isSafeInteger(file.byteLength) ||
      file.byteLength < 0 ||
      offset + file.byteLength > pack.byteLength
    )
      return null;
    files.push({
      path: file.path,
      bytes: pack.subarray(offset, offset + file.byteLength),
    });
    offset += file.byteLength;
  }
  return offset === pack.byteLength ? files : null;
}

// A pack header is ASCII: its paths match PATH, and the rest is the format
// name and numbers.
function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code > 0x7f) throw new Error("A pack header is ASCII.");
    bytes[index] = code;
  }
  return bytes;
}

function asciiText(bytes: Uint8Array): string | null {
  let text = "";
  for (const byte of bytes) {
    if (byte > 0x7f) return null;
    text += String.fromCharCode(byte);
  }
  return text;
}

/** Writes the files of a checked pack below the module's root. */
export function mountPack(fs: PackFileSystem, pack: Uint8Array): void {
  const files = readPack(pack);
  if (files === null) throw new Error("A model pack is not readable.");
  for (const { path, bytes } of files) {
    const directory = path.slice(0, path.lastIndexOf("/"));
    if (directory !== "") fs.mkdirTree(`/${directory}`);
    fs.writeFile(`/${path}`, bytes);
  }
}

/** The model file that a refused host command names, if one is missing. */
function missingFile(reply: string): string | null {
  // A missing file is a short refusal; other replies are not parsed.
  if (!reply.startsWith('{"kind":"failed"') || reply.length > 4096) return null;
  const raw = parseJsonOrNull(reply);
  return isRecord(raw) && typeof raw.missing === "string" ? raw.missing : null;
}

/**
 * The host protocol with packs mounted on demand. When the engine refuses
 * a command for a missing model file, `mount` loads the pack that holds it,
 * and the command goes again. A refused command changed nothing. `mount`
 * answers false when no pack holds the file or the pack is already there;
 * the refusal then stays the reply.
 */
export function withModelPacks(
  transport: TextCellTransport,
  mount: (path: string) => Promise<boolean>,
): TextCellTransport {
  return {
    async exchange(command) {
      let reply = await transport.exchange(command);
      for (;;) {
        const missing = missingFile(reply);
        if (missing === null || !(await mount(missing))) return reply;
        reply = await transport.exchange(command);
      }
    },
  };
}
