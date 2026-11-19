import {
  MAX_ARTIFACTS,
  MAX_DOCUMENT_BYTES,
  MAX_REFERENCED_BYTES,
} from "../index.ts";
import { parseJsonOrNull } from "@purin-labs/std";
import {
  MAX_ENCODED_ARTIFACT_BYTES,
  RunArtifactFile,
} from "./run-artifact-file.ts";

const CHUNK_BYTES = 256 * 1024;

/** Scan JSON framing in bounded byte chunks. JSON.parse validates each bounded value. */
class JsonFileReader {
  private buffer = new Uint8Array();
  private start = 0;
  private position = 0;
  constructor(private readonly file: Blob) {}

  private async ready(): Promise<boolean> {
    if (this.position < this.start + this.buffer.length) return true;
    this.start = this.position;
    this.buffer = new Uint8Array(
      await this.file.slice(this.start, this.start + CHUNK_BYTES).arrayBuffer(),
    );
    return this.buffer.length > 0;
  }

  async next(): Promise<number> {
    while (await this.ready()) {
      const byte = this.buffer[this.position - this.start];
      if (byte !== 32 && byte !== 9 && byte !== 10 && byte !== 13)
        return byte ?? -1;
      this.position++;
    }
    return -1;
  }

  async expect(byte: number): Promise<void> {
    if ((await this.next()) !== byte)
      throw new Error("The run file has invalid JSON framing.");
    this.position++;
  }

  async value(limit: number): Promise<Blob> {
    const first = await this.next();
    const start = this.position;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    const compound = first === 123 || first === 91;
    const string = first === 34;
    while (await this.ready()) {
      while (this.position < this.start + this.buffer.length) {
        const byte = this.buffer[this.position - this.start];
        if (
          !compound &&
          !string &&
          this.position > start &&
          (byte === 44 ||
            byte === 125 ||
            byte === 93 ||
            byte === 32 ||
            byte === 9 ||
            byte === 10 ||
            byte === 13)
        )
          return this.file.slice(start, this.position);
        this.position++;
        if (this.position - start > limit)
          throw new Error("A run file value exceeds its size limit.");
        if (quoted) {
          if (escaped) escaped = false;
          else if (byte === 92) escaped = true;
          else if (byte === 34) {
            quoted = false;
            if (string && depth === 0)
              return this.file.slice(start, this.position);
          }
        } else if (byte === 34) quoted = true;
        else if (byte === 123 || byte === 91) depth++;
        else if (byte === 125 || byte === 93) {
          depth--;
          if (compound && depth === 0)
            return this.file.slice(start, this.position);
        }
      }
    }
    if (quoted || depth !== 0 || this.position === start)
      throw new Error("The run file ended inside a JSON value.");
    return this.file.slice(start, this.position);
  }
}

/** Existing JSON saves stay portable, including those above V8's string limit. */
export async function readSavedRunFile(file: Blob): Promise<
  Readonly<{
    raw: unknown;
    artifacts: ReadonlyMap<string, RunArtifactFile>;
  }>
> {
  if (file.size > MAX_DOCUMENT_BYTES + MAX_REFERENCED_BYTES * 2)
    throw new Error("This run file exceeds the import size limit.");
  const reader = new JsonFileReader(file);
  const fields = new Set<string>();
  const artifacts = new Map<string, RunArtifactFile>();
  let kind: unknown = null;
  let document: unknown = null;
  let bytes = 0;
  await reader.expect(123);
  for (;;) {
    const key = parseJsonOrNull(await (await reader.value(64)).text());
    if (typeof key !== "string" || fields.has(key))
      throw new Error("The run file has an invalid or duplicate field.");
    fields.add(key);
    await reader.expect(58);
    switch (key) {
      case "kind":
        kind = parseJsonOrNull(await (await reader.value(64)).text());
        break;
      case "document":
        document = parseJsonOrNull(
          await (await reader.value(MAX_DOCUMENT_BYTES)).text(),
        );
        break;
      case "artifacts":
        await reader.expect(91);
        if ((await reader.next()) !== 93) {
          for (;;) {
            if (artifacts.size >= MAX_ARTIFACTS)
              throw new Error("The run has too many artifacts.");
            const artifact = await RunArtifactFile.open(
              await reader.value(MAX_ENCODED_ARTIFACT_BYTES),
            );
            if (artifacts.has(artifact.digest))
              throw new Error("The run repeats an artifact.");
            bytes += artifact.byteLength;
            if (bytes > MAX_REFERENCED_BYTES)
              throw new Error("The run exceeds the referenced artifact limit.");
            artifacts.set(artifact.digest, artifact);
            if ((await reader.next()) === 93) break;
            await reader.expect(44);
          }
        }
        await reader.expect(93);
        break;
      default:
        throw new Error("The saved run has an unknown field.");
    }
    if ((await reader.next()) === 125) break;
    await reader.expect(44);
  }
  await reader.expect(125);
  if ((await reader.next()) !== -1 || kind !== "saved" || fields.size !== 3)
    throw new Error("Choose a complete saved production run.");
  return { raw: { kind, document, artifacts: [] }, artifacts };
}
