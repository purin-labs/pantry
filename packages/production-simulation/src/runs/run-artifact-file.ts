import {
  MAX_ARTIFACT_BYTES,
  parseSha256Hex,
  type Sha256Hex,
} from "../index.ts";
import { isRecord, parseJsonOrNull, sha256Hex } from "@purin-labs/std";

/** JSON framing is bounded separately from the artifact's decoded UTF-8 bytes. */
export const MAX_ENCODED_ARTIFACT_BYTES = MAX_ARTIFACT_BYTES * 2 + 1024;

/** A verified artifact backed by a file, never a retained content string. */
export class RunArtifactFile {
  private constructor(
    readonly digest: Sha256Hex,
    readonly byteLength: number,
    private readonly source: Blob,
  ) {}

  get file(): Blob {
    return this.source;
  }

  static async open(file: Blob): Promise<RunArtifactFile> {
    if (file.size > MAX_ENCODED_ARTIFACT_BYTES)
      throw new Error("The encoded artifact exceeds the file limit.");
    const record = decodeArtifact(await file.text());
    const bytes = new TextEncoder().encode(record.content);
    if (
      bytes.byteLength > MAX_ARTIFACT_BYTES ||
      (await sha256Hex(bytes)) !== record.digest
    )
      throw new Error("An artifact failed its integrity check.");
    return new RunArtifactFile(record.digest, bytes.byteLength, file);
  }

  /** A JSON response is already decoded. Check it before creating its file. */
  static async fromContent(
    digest: string,
    content: string,
  ): Promise<RunArtifactFile> {
    const parsed = parseSha256Hex(digest);
    if (!parsed.ok)
      throw new Error("The run contains an invalid artifact digest.");
    const bytes = new TextEncoder().encode(content);
    if (
      bytes.byteLength > MAX_ARTIFACT_BYTES ||
      (await sha256Hex(bytes)) !== parsed.value
    )
      throw new Error("An artifact failed its integrity check.");
    return new RunArtifactFile(
      parsed.value,
      bytes.byteLength,
      new Blob([JSON.stringify({ digest, content })], {
        type: "application/json",
      }),
    );
  }

  async read(): Promise<string> {
    return decodeArtifact(await this.file.text()).content;
  }
}

function decodeArtifact(
  text: string,
): Readonly<{ digest: Sha256Hex; content: string }> {
  const raw = parseJsonOrNull(text);
  if (!isRecord(raw) || typeof raw.content !== "string")
    throw new Error("The run contains an invalid artifact.");
  const digest = parseSha256Hex(raw.digest);
  if (!digest.ok)
    throw new Error("The run contains an invalid artifact digest.");
  return { digest: digest.value, content: raw.content };
}
