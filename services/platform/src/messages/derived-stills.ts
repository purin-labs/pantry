import type { StoredMessageAttachment } from "@seams/contracts";

import type { DecodedVideoStill } from "./attachment-inspection";
import type { WorkspaceExecutorDecodedFrame } from "../workspace-executor-container";
import { sha256Hex } from "@seams/std";

/**
 * Decoded stills as durable, content-addressed derived objects.
 *
 * A still is produced once, in the executor, under an allocation the turn
 * paid for. It must not be produced again for the same bytes — not on the next
 * turn, not after a restore, not because a second script asked. So the stills
 * are written beside their source under the organisation's attachment prefix,
 * keyed by the source digest and the sampling policy revision, and every later
 * reader looks there first.
 *
 * The inspection tool delivers verified stills to the active harness as image
 * input. Materializing this attachment again can reuse the stored frames.
 *
 * Derived objects live under `attachments/<organisation>/derived/<sha256>/<policy>/`,
 * so organisation erasure removes them with everything else, and the reachability
 * collector treats them as reachable exactly when their source is.
 */

export const DERIVED_SEGMENT = "derived";

export type DerivedStillsManifest = {
  readonly schemaVersion: "plan37.derived-stills.v1";
  readonly sourceSha256: string;
  readonly policyRevision: string;
  readonly frames: readonly {
    readonly index: number;
    readonly timestampMs: number;
    readonly width: number;
    readonly height: number;
    readonly mediaType: string;
    readonly byteLength: number;
    readonly sha256: string;
  }[];
  readonly derivedAt: number;
};

export function derivedStillsPrefix(
  organisationId: string,
  sourceSha256: string,
  policyRevision: string,
): string {
  return `attachments/${organisationId}/${DERIVED_SEGMENT}/${sourceSha256}/${policyRevision}/`;
}

/** The source digest a derived key belongs to, or null for a source key. */
export function derivedSourceSha256(
  objectKey: string,
  organisationId: string,
): string | null {
  const prefix = `attachments/${organisationId}/${DERIVED_SEGMENT}/`;

  if (!objectKey.startsWith(prefix)) {
    return null;
  }

  const sha256 = objectKey.slice(prefix.length).split("/")[0] ?? "";

  return /^[a-f0-9]{64}$/u.test(sha256) ? sha256 : null;
}

/** Writes decoded frames and their manifest. Idempotent: same bytes, same keys. */
export async function persistDerivedStills(input: {
  readonly archive: R2Bucket;
  readonly organisationId: string;
  readonly attachment: StoredMessageAttachment;
  readonly policyRevision: string;
  readonly frames: readonly WorkspaceExecutorDecodedFrame[];
  readonly now: number;
}): Promise<readonly DecodedVideoStill[]> {
  const sourceSha256 = String(input.attachment.sha256);
  const prefix = derivedStillsPrefix(
    input.organisationId,
    sourceSha256,
    input.policyRevision,
  );
  const stills: DecodedVideoStill[] = [];
  const manifestFrames: DerivedStillsManifest["frames"][number][] = [];

  for (const [index, frame] of input.frames.entries()) {
    const bytes = base64ToBytes(frame.jpegBase64);

    // The executor named a digest; the bytes must still hash to it here, or
    // the frame is not written. A derived object never carries a claim its
    // bytes do not prove.
    if ((await sha256Hex(bytes)) !== frame.sha256) {
      throw new Error("derived_still_integrity_failed");
    }

    await input.archive.put(`${prefix}${index}.jpg`, bytes, {
      httpMetadata: { contentType: frame.mediaType },
      customMetadata: {
        organisationId: input.organisationId,
        sourceSha256,
        policyRevision: input.policyRevision,
        sha256: frame.sha256,
        timestampMs: String(frame.timestampMs),
      },
    });
    manifestFrames.push({
      index,
      timestampMs: frame.timestampMs,
      width: frame.width,
      height: frame.height,
      mediaType: frame.mediaType,
      byteLength: bytes.byteLength,
      sha256: frame.sha256,
    });
    stills.push({
      timestampMs: frame.timestampMs,
      mediaType: frame.mediaType,
      bytes,
      sha256: frame.sha256,
    });
  }

  const manifest: DerivedStillsManifest = {
    schemaVersion: "plan37.derived-stills.v1",
    sourceSha256,
    policyRevision: input.policyRevision,
    frames: manifestFrames,
    derivedAt: input.now,
  };

  await input.archive.put(`${prefix}manifest.json`, JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      organisationId: input.organisationId,
      sourceSha256,
      policyRevision: input.policyRevision,
    },
  });

  return stills;
}

/**
 * Reads previously derived stills, verifying each frame against the manifest.
 * Returns null when there are none, or when any frame fails verification —
 * a partial set is not offered as if it were the whole.
 */
export async function readDerivedStills(input: {
  readonly archive: R2Bucket;
  readonly organisationId: string;
  readonly attachment: StoredMessageAttachment;
  readonly policyRevision: string;
}): Promise<readonly DecodedVideoStill[] | null> {
  const sourceSha256 = String(input.attachment.sha256);
  const prefix = derivedStillsPrefix(
    input.organisationId,
    sourceSha256,
    input.policyRevision,
  );
  let manifest: DerivedStillsManifest;

  try {
    const object = await input.archive.get(`${prefix}manifest.json`);

    if (object === null) {
      return null;
    }

    const parsed: unknown = JSON.parse(await object.text());

    if (
      !isManifest(parsed) ||
      parsed.sourceSha256 !== sourceSha256 ||
      parsed.policyRevision !== input.policyRevision
    ) {
      return null;
    }

    manifest = parsed;
  } catch {
    return null;
  }

  const stills: DecodedVideoStill[] = [];

  for (const frame of manifest.frames) {
    try {
      const object = await input.archive.get(`${prefix}${frame.index}.jpg`);

      if (object === null || object.size !== frame.byteLength) {
        return null;
      }

      const bytes = new Uint8Array(await object.arrayBuffer());

      if ((await sha256Hex(bytes)) !== frame.sha256) {
        return null;
      }

      stills.push({
        timestampMs: frame.timestampMs,
        mediaType: frame.mediaType,
        bytes,
        sha256: frame.sha256,
      });
    } catch {
      return null;
    }
  }

  return stills;
}

function isManifest(value: unknown): value is DerivedStillsManifest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;

  return (
    record.schemaVersion === "plan37.derived-stills.v1" &&
    typeof record.sourceSha256 === "string" &&
    typeof record.policyRevision === "string" &&
    Array.isArray(record.frames) &&
    record.frames.every(function isFrame(frame) {
      return (
        typeof frame === "object" &&
        frame !== null &&
        Number.isSafeInteger((frame as Record<string, unknown>).index) &&
        Number.isSafeInteger((frame as Record<string, unknown>).timestampMs) &&
        Number.isSafeInteger((frame as Record<string, unknown>).byteLength) &&
        typeof (frame as Record<string, unknown>).mediaType === "string" &&
        typeof (frame as Record<string, unknown>).sha256 === "string"
      );
    })
  );
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
