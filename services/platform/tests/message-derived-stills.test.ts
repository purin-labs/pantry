/// <reference types="@cloudflare/workers-types" />

import type { StoredMessageAttachment } from "@purin-labs/contracts";
import { describe, expect, it } from "vitest";

import {
  derivedSourceSha256,
  derivedStillsPrefix,
  persistDerivedStills,
  readDerivedStills,
} from "../src/messages/derived-stills";
import { sha256Hex } from "@purin-labs/std";

const ORGANISATION = "organisation_derived";
const POLICY = "plan37.frames.v1";

describe("derived stills", function derivedStillsSuite() {
  it("writes each still and a manifest under the source digest", async function persists() {
    const bucket = new MemoryBucket();
    const attachment = await videoAttachment();
    const jpeg = new Uint8Array([0xff, 0xd8, 0x01, 0xff, 0xd9]);
    const stills = await persistDerivedStills({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment,
      policyRevision: POLICY,
      frames: [frameOf(jpeg, 120, await sha256Hex(jpeg))],
      now: 1_700_000_000,
    });
    const prefix = derivedStillsPrefix(
      ORGANISATION,
      String(attachment.sha256),
      POLICY,
    );

    expect(stills).toHaveLength(1);
    expect(bucket.keys()).toEqual([`${prefix}0.jpg`, `${prefix}manifest.json`]);
    expect(derivedSourceSha256(`${prefix}0.jpg`, ORGANISATION)).toBe(
      String(attachment.sha256),
    );
    expect(
      derivedSourceSha256(String(attachment.objectKey), ORGANISATION),
    ).toBeNull();
  });

  it("refuses to write a frame whose bytes do not hash to the digest it claims", async function refusesMismatch() {
    const bucket = new MemoryBucket();
    const attachment = await videoAttachment();
    await expect(
      persistDerivedStills({
        archive: bucket.binding(),
        organisationId: ORGANISATION,
        attachment,
        policyRevision: POLICY,
        frames: [frameOf(new Uint8Array([1, 2, 3]), 0, "f".repeat(64))],
        now: 1,
      }),
    ).rejects.toThrow("derived_still_integrity_failed");
    expect(bucket.keys()).toHaveLength(0);
  });

  it("reads back exactly what was written, and nothing when a frame is missing", async function readsBack() {
    const bucket = new MemoryBucket();
    const attachment = await videoAttachment();
    const first = new Uint8Array([0xff, 0xd8, 0xaa, 0xff, 0xd9]);
    const second = new Uint8Array([0xff, 0xd8, 0xbb, 0xff, 0xd9]);

    await persistDerivedStills({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment,
      policyRevision: POLICY,
      frames: [
        frameOf(first, 100, await sha256Hex(first)),
        frameOf(second, 200, await sha256Hex(second)),
      ],
      now: 1,
    });

    const read = await readDerivedStills({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment,
      policyRevision: POLICY,
    });

    expect(
      read?.map(function timestamps(still) {
        return still.timestampMs;
      }),
    ).toEqual([100, 200]);
    expect(read?.[1]?.bytes).toEqual(second);

    // A different policy revision is a different derivation: nothing is found.
    expect(
      await readDerivedStills({
        archive: bucket.binding(),
        organisationId: ORGANISATION,
        attachment,
        policyRevision: "plan37.frames.v2",
      }),
    ).toBeNull();

    // Losing one frame invalidates the set rather than offering a partial one.
    bucket.remove(
      `${derivedStillsPrefix(ORGANISATION, String(attachment.sha256), POLICY)}1.jpg`,
    );
    expect(
      await readDerivedStills({
        archive: bucket.binding(),
        organisationId: ORGANISATION,
        attachment,
        policyRevision: POLICY,
      }),
    ).toBeNull();
  });

  it("rejects a manifest whose frame bytes were altered", async function rejectsTampered() {
    const bucket = new MemoryBucket();
    const attachment = await videoAttachment();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xcc, 0xff, 0xd9]);

    await persistDerivedStills({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment,
      policyRevision: POLICY,
      frames: [frameOf(jpeg, 100, await sha256Hex(jpeg))],
      now: 1,
    });
    await bucket.put(
      `${derivedStillsPrefix(ORGANISATION, String(attachment.sha256), POLICY)}0.jpg`,
      new Uint8Array([0xff, 0xd8, 0xdd, 0xff, 0xd9]),
    );

    expect(
      await readDerivedStills({
        archive: bucket.binding(),
        organisationId: ORGANISATION,
        attachment,
        policyRevision: POLICY,
      }),
    ).toBeNull();
  });
});

function frameOf(bytes: Uint8Array, timestampMs: number, sha256: string) {
  return {
    timestampMs,
    width: 64,
    height: 48,
    mediaType: "image/jpeg",
    jpegBase64: btoa(String.fromCharCode(...bytes)),
    sha256,
  };
}

async function videoAttachment(): Promise<StoredMessageAttachment> {
  const bytes = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
  const sha256 = await sha256Hex(bytes);

  return {
    id: `att_${sha256.slice(0, 32)}`,
    displayName: "clip.mp4",
    extensionHint: { kind: "named", value: "mp4" },
    descriptor: {
      kind: "video",
      media: {
        kind: "signature_verified",
        mediaType: "video/mp4",
        method: "container_structure",
      },
    },
    byteLength: bytes.byteLength,
    sha256,
    objectKey: `attachments/${ORGANISATION}/slack/${sha256}`,
    source: {
      kind: "slack",
      integrationAccountId: "account_derived",
      workspaceId: "T1",
      channelId: "C1",
      messageTs: "1700000000.000100",
      fileId: "F1",
      revision: "1700000000",
    },
    retention: "session",
    storedAt: 1_700_000_000,
  } as unknown as StoredMessageAttachment;
}

class MemoryBucket {
  private readonly objects = new Map<string, Uint8Array>();

  binding(): R2Bucket {
    return this as unknown as R2Bucket;
  }

  keys(): readonly string[] {
    return [...this.objects.keys()].sort();
  }

  remove(key: string): void {
    this.objects.delete(key);
  }

  async put(key: string, value: Uint8Array | string): Promise<void> {
    this.objects.set(
      key,
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    );
  }

  async get(key: string): Promise<unknown> {
    const bytes = this.objects.get(key);

    return bytes === undefined
      ? null
      : {
          size: bytes.byteLength,
          arrayBuffer: async function arrayBuffer(): Promise<ArrayBuffer> {
            return bytes.slice().buffer;
          },
          text: async function text(): Promise<string> {
            return new TextDecoder().decode(bytes);
          },
        };
  }
}
