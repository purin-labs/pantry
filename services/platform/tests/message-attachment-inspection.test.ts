/// <reference types="@cloudflare/workers-types" />

import type { StoredMessageAttachment } from "@seams/contracts";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeUrl } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_TEXT_LIMITS,
  FRAME_SAMPLING_POLICY_REVISION,
  inspectMessageAttachment,
} from "../src/messages/attachment-inspection";
import { persistDerivedStills } from "../src/messages/derived-stills";
import { h264Fixture, waveHeader } from "./media-fixtures";
import { sha256Hex } from "@seams/std";

const ORGANISATION = "organisation_fixture";

describe("message attachment inspection", function attachmentInspectionSuite() {
  it("extracts bounded text from a textual document", async function extractsText() {
    const bytes = new TextEncoder().encode("name,price\r\nespresso,3.50\r\n");
    const bucket = await bucketWith(bytes);
    const result = await inspectMessageAttachment({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment: await attachmentFor(
        bytes,
        "text/csv",
        "document",
        "menu.csv",
      ),
    });

    if (!result.ok || result.value.kind !== "extracted_text") {
      throw new Error(`expected extracted text, got ${JSON.stringify(result)}`);
    }

    expect(result.value.text).toBe("name,price\nespresso,3.50");
    expect(result.value.truncated).toBe(false);
    // The extraction carries its source digest so a quote can be traced back.
    expect(result.value.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("extracts text from a PDF content stream", async function extractsPdf() {
    const bytes = new TextEncoder().encode(
      "%PDF-1.7\n1 0 obj\n<< /Length 44 >>\nstream\n" +
        "BT (Quote for 200 units) Tj ET\nendstream\nendobj\n%%EOF\n",
    );
    const bucket = await bucketWith(bytes);
    const result = await inspectMessageAttachment({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment: await attachmentFor(
        bytes,
        "application/pdf",
        "document",
        "quote.pdf",
      ),
    });

    if (!result.ok || result.value.kind !== "extracted_text") {
      throw new Error(`expected extracted text, got ${JSON.stringify(result)}`);
    }

    expect(result.value.text).toBe("Quote for 200 units");
  });

  it("states a limitation for a PDF whose text cannot be read", async function refusesScannedPdf() {
    // A scanned page: the content is an image, so there is no text to extract
    // and none is invented.
    const bytes = new TextEncoder().encode(
      "%PDF-1.7\n1 0 obj\n<< /Filter /DCTDecode /Length 6 >>\nstream\njpegs\nendstream\nendobj\n",
    );
    const bucket = await bucketWith(bytes);
    const result = await inspectMessageAttachment({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment: await attachmentFor(
        bytes,
        "application/pdf",
        "document",
        "scan.pdf",
      ),
    });

    if (!result.ok || result.value.kind !== "preparation_unavailable") {
      throw new Error("expected an explicit limitation");
    }

    expect(result.value.reason).toBe("handler_not_available");
    // The agent still learns exactly what the file is.
    expect(result.value.manifest).toContain("scan.pdf");
    expect(result.value.manifest).toContain("class=document");
  });

  it("states a limitation for every non-document class", async function refusesOtherClasses() {
    const bytes = new TextEncoder().encode("payload");
    const bucket = await bucketWith(bytes);

    for (const [mediaType, kind] of [
      ["image/png", "image"],
      ["application/x-3ds", "opaque"],
    ] as const) {
      const result = await inspectMessageAttachment({
        archive: bucket.binding(),
        organisationId: ORGANISATION,
        attachment: await attachmentFor(bytes, mediaType, kind, `file.${kind}`),
      });

      if (!result.ok || result.value.kind !== "preparation_unavailable") {
        throw new Error(`expected a limitation for ${kind}`);
      }

      expect(result.value.mediaClass).toBe(kind);
    }
  });

  it("reads container facts from an audio header without decoding it", async function readsAudioMetadata() {
    // A WAVE header: 2 channels at 44.1 kHz, two seconds of PCM.
    const wave = waveHeader();
    const bucket = await bucketWith(wave);
    const result = await inspectMessageAttachment({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment: await attachmentFor(wave, "audio/wav", "audio", "note.wav"),
    });

    if (!result.ok || result.value.kind !== "media_metadata") {
      throw new Error(`expected media metadata, got ${JSON.stringify(result)}`);
    }

    expect(result.value.metadata.container).toBe("riff");
    expect(result.value.metadata.audio).toEqual({
      codec: "pcm",
      channels: 2,
      sampleRateHz: 44_100,
    });
    expect(result.value.metadata.durationMs).toBe(2_000);
    // No transcription, no speech claim: the video track is simply absent.
    expect(result.value.metadata.video).toBeNull();
  });

  it("names the decoder a compressed video needs rather than returning nothing", async function namesDecoder() {
    // An H.264 track: frames are inter-frame deltas, so a still cannot be
    // parsed out of the container.
    const mp4 = h264Fixture();
    const bucket = await bucketWith(mp4);
    const result = await inspectMessageAttachment({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment: await attachmentFor(mp4, "video/mp4", "video", "clip.mp4"),
    });

    if (!result.ok || result.value.kind !== "media_metadata") {
      throw new Error(`expected media metadata, got ${JSON.stringify(result)}`);
    }

    expect(result.value.frames).toEqual({
      kind: "decoder_required",
      codec: "avc1",
    });
    expect(result.value.metadata.container).toBe("iso_base_media");
  });

  it("names a container it cannot fully read rather than guessing", async function reportsIncompleteHeader() {
    // Matroska is identifiable from its magic, but its tracks need a full walk.
    const webm = new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04,
    ]);
    const bucket = await bucketWith(webm);
    const result = await inspectMessageAttachment({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment: await attachmentFor(webm, "video/webm", "video", "clip.webm"),
    });

    if (!result.ok || result.value.kind !== "media_metadata") {
      throw new Error("expected media metadata");
    }

    expect(result.value.metadata.container).toBe("matroska");
    expect(result.value.metadata.headerIncomplete).toBe(true);
    expect(result.value.metadata.video).toBeNull();
  });

  it("states a limitation when an office archive cannot be read", async function refusesBrokenDocx() {
    // Admitted and verified as a document, but not a readable archive.
    const bytes = new TextEncoder().encode("PK\u0003\u0004 truncated");
    const bucket = await bucketWith(bytes);
    const result = await inspectMessageAttachment({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment: await attachmentFor(
        bytes,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "document",
        "broken.docx",
      ),
    });

    if (!result.ok || result.value.kind !== "preparation_unavailable") {
      throw new Error("expected an explicit limitation");
    }

    expect(result.value.reason).toBe("handler_not_available");
  });

  it("refuses tampered media bytes before parsing them", async function refusesTamperedMedia() {
    // Same length, different bytes: a ranged header read would have missed
    // this, so media inspection verifies the whole object first.
    const wave = waveHeader();
    const attachment = await attachmentFor(
      wave,
      "audio/wav",
      "audio",
      "note.wav",
    );
    const bucket = new TestR2Bucket();
    const tampered = wave.slice();

    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    await bucket.put(String(attachment.objectKey), tampered);

    expect(
      await inspectMessageAttachment({
        archive: bucket.binding(),
        organisationId: ORGANISATION,
        attachment,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "attachment_integrity_failed",
        attachmentId: String(attachment.id),
      },
    });
  });

  it("refuses an object outside the calling organisation", async function refusesCrossOrganisation() {
    const bytes = new TextEncoder().encode("secret");
    const bucket = await bucketWith(bytes);
    const attachment = await attachmentFor(
      bytes,
      "text/plain",
      "document",
      "notes.txt",
    );
    const foreign = {
      ...attachment,
      objectKey: `attachments/organisation_other/slack/${"b".repeat(64)}`,
    } as StoredMessageAttachment;

    const result = await inspectMessageAttachment({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment: foreign,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "attachment_not_in_organisation",
        attachmentId: String(attachment.id),
      },
    });
  });

  it("refuses bytes that no longer match the stored digest", async function refusesTampered() {
    const bytes = new TextEncoder().encode("original");
    const attachment = await attachmentFor(
      bytes,
      "text/plain",
      "document",
      "notes.txt",
    );
    const bucket = new TestR2Bucket();

    // Same length, different bytes: only the digest catches this.
    await bucket.put(
      String(attachment.objectKey),
      new TextEncoder().encode("tampered"),
    );

    const result = await inspectMessageAttachment({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "attachment_integrity_failed",
        attachmentId: String(attachment.id),
      },
    });
  });

  it("refuses an object whose length disagrees with the record", async function refusesLengthDrift() {
    const bytes = new TextEncoder().encode("original");
    const attachment = await attachmentFor(
      bytes,
      "text/plain",
      "document",
      "notes.txt",
    );
    const bucket = new TestR2Bucket();

    await bucket.put(
      String(attachment.objectKey),
      new TextEncoder().encode("longer than before"),
    );

    const result = await inspectMessageAttachment({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "attachment_unavailable",
        attachmentId: String(attachment.id),
      },
    });
  });

  it("declines to read a source beyond the extraction limit", async function refusesOversizedSource() {
    const bytes = new Uint8Array(ATTACHMENT_TEXT_LIMITS.maxSourceBytes + 1);
    const bucket = await bucketWith(bytes);
    const result = await inspectMessageAttachment({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment: await attachmentFor(
        bytes,
        "text/plain",
        "document",
        "huge.txt",
      ),
    });

    if (!result.ok || result.value.kind !== "preparation_unavailable") {
      throw new Error("expected a limitation");
    }

    expect(result.value.reason).toBe("source_too_large");
  });

  it("truncates extracted text at the result limit", async function truncatesText() {
    const bytes = new TextEncoder().encode(
      "a".repeat(ATTACHMENT_TEXT_LIMITS.maxNormalizedChars + 50),
    );
    const bucket = await bucketWith(bytes);
    const result = await inspectMessageAttachment({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment: await attachmentFor(
        bytes,
        "text/plain",
        "document",
        "long.txt",
      ),
    });

    if (!result.ok || result.value.kind !== "extracted_text") {
      throw new Error("expected extracted text");
    }

    expect(result.value.text).toHaveLength(
      ATTACHMENT_TEXT_LIMITS.maxNormalizedChars,
    );
    expect(result.value.truncated).toBe(true);
  });
});

async function attachmentFor(
  bytes: Uint8Array,
  mediaType: string,
  kind: string,
  displayName: string,
): Promise<StoredMessageAttachment> {
  const sha256 = await sha256Hex(bytes);

  return {
    id: `att_${sha256.slice(0, 32)}`,
    displayName,
    extensionHint: { kind: "none" },
    descriptor: {
      kind,
      media: { kind: "provider_declared", mediaType, provider: "slack" },
    },
    byteLength: bytes.byteLength,
    sha256,
    objectKey: `attachments/${ORGANISATION}/slack/${sha256}`,
    source: {
      kind: "slack",
      integrationAccountId: "account_fixture",
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

/** One ISO base media file with a single H.264 video track. */

async function bucketWith(bytes: Uint8Array): Promise<TestR2Bucket> {
  const bucket = new TestR2Bucket();
  const sha256 = await sha256Hex(bytes);

  await bucket.put(`attachments/${ORGANISATION}/slack/${sha256}`, bytes);

  return bucket;
}

class TestR2Bucket {
  private readonly objects = new Map<string, Uint8Array>();

  binding(): R2Bucket {
    return this as unknown as R2Bucket;
  }

  async put(key: string, value: Uint8Array | string): Promise<void> {
    this.objects.set(
      key,
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    );
  }

  keys(): readonly string[] {
    return [...this.objects.keys()].sort();
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    const bytes = this.objects.get(key);

    if (bytes === undefined) {
      return null;
    }

    const range = options?.range;
    const slice =
      range !== undefined && "offset" in range && range.offset !== undefined
        ? bytes.slice(
            range.offset,
            range.offset +
              ("length" in range && range.length !== undefined
                ? range.length
                : bytes.byteLength),
          )
        : bytes.slice();

    return {
      size: bytes.byteLength,
      arrayBuffer: async function arrayBuffer(): Promise<ArrayBuffer> {
        return slice.buffer;
      },
      text: async function text(): Promise<string> {
        return new TextDecoder().decode(slice);
      },
    } as unknown as R2ObjectBody;
  }
}

describe("oversized document delegation", function oversizedSuite() {
  it("reads an oversized document through the executor when one is available", async function delegates() {
    const bytes = new TextEncoder().encode(
      "x".repeat(ATTACHMENT_TEXT_LIMITS.maxSourceBytes + 16),
    );
    const attachment = await attachmentFor(
      bytes,
      "text/plain",
      "document",
      "big.txt",
    );
    const bucket = new TestR2Bucket();
    const seen: number[] = [];

    await bucket.put(String(attachment.objectKey), bytes);

    const inspected = await inspectMessageAttachment({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment,
      readOversizedDocument: async function read(_attachment, delivered) {
        // The executor receives verified bytes, not a promise of them.
        seen.push(delivered.byteLength);
        return { text: "read by the executor", truncated: true };
      },
    });

    expect(inspected).toMatchObject({
      ok: true,
      value: {
        kind: "extracted_text",
        text: "read by the executor",
        truncated: true,
      },
    });
    expect(seen).toEqual([bytes.byteLength]);
  });

  it("states the limit when no executor is available", async function statesLimit() {
    const bytes = new TextEncoder().encode(
      "x".repeat(ATTACHMENT_TEXT_LIMITS.maxSourceBytes + 16),
    );
    const attachment = await attachmentFor(
      bytes,
      "text/plain",
      "document",
      "big.txt",
    );
    const bucket = new TestR2Bucket();

    await bucket.put(String(attachment.objectKey), bytes);

    // No allocation, so the file is described rather than quietly read.
    expect(
      await inspectMessageAttachment({
        archive: bucket.binding(),
        organisationId: ORGANISATION,
        attachment,
      }),
    ).toMatchObject({
      ok: true,
      value: { kind: "preparation_unavailable", reason: "source_too_large" },
    });
  });
});

describe("video decode delegation", function videoDecodeSuite() {
  const keyframes = new Uint8Array(
    readFileSync(
      fileURLToPath(
        new NodeUrl("./fixtures/keyframes-h264.mp4", import.meta.url),
      ),
    ),
  );

  it("hands an inter-frame codec to the executor when a decoder is held", async function delegatesH264() {
    const attachment = await attachmentFor(
      keyframes,
      "video/mp4",
      "video",
      "line.mp4",
    );
    const bucket = new TestR2Bucket();
    const handed: number[] = [];

    await bucket.put(String(attachment.objectKey), keyframes);

    const inspected = await inspectMessageAttachment({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment,
      decodeVideoFrames: async function decode(_attachment, bytes) {
        // The decoder receives the verified file, not a promise of one.
        handed.push(bytes.byteLength);
        return [
          {
            timestampMs: 250,
            mediaType: "image/jpeg",
            bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
            sha256: "a".repeat(64),
          },
        ];
      },
    });

    if (!inspected.ok || inspected.value.kind !== "media_metadata") {
      throw new Error(
        `expected media metadata, got ${JSON.stringify(inspected)}`,
      );
    }

    // The Worker's own sampling still states its limit; the decoded stills sit
    // beside it rather than pretending the Worker produced them.
    expect(inspected.value.frames).toMatchObject({
      kind: "decoder_required",
      codec: "avc1",
    });
    expect(inspected.value.decodedStills).toHaveLength(1);
    expect(handed).toEqual([keyframes.byteLength]);
  });

  it("states the codec limit when no decoder is held", async function statesLimit() {
    const attachment = await attachmentFor(
      keyframes,
      "video/mp4",
      "video",
      "line.mp4",
    );
    const bucket = new TestR2Bucket();

    await bucket.put(String(attachment.objectKey), keyframes);

    const inspected = await inspectMessageAttachment({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment,
    });

    if (!inspected.ok || inspected.value.kind !== "media_metadata") {
      throw new Error("expected media metadata");
    }

    // No allocation, so no second allocation is taken behind the budget's back.
    expect(inspected.value.frames).toMatchObject({ kind: "decoder_required" });
    expect(inspected.value.decodedStills).toBeNull();
  });

  it("shows stills decoded on an earlier turn without holding a decoder", async function reusesDerived() {
    const attachment = await attachmentFor(
      keyframes,
      "video/mp4",
      "video",
      "line.mp4",
    );
    const bucket = new TestR2Bucket();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

    await bucket.put(String(attachment.objectKey), keyframes);
    // What a previous turn's executor allocation produced and wrote down.
    await persistDerivedStills({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment,
      policyRevision: FRAME_SAMPLING_POLICY_REVISION,
      frames: [
        {
          timestampMs: 250,
          width: 64,
          height: 48,
          mediaType: "image/jpeg",
          jpegBase64: btoa(String.fromCharCode(...jpeg)),
          sha256: await sha256Hex(jpeg),
        },
      ],
      now: 1_700_000_000,
    });

    let decoded = false;
    const inspected = await inspectMessageAttachment({
      archive: bucket.binding(),
      organisationId: ORGANISATION,
      attachment,
      decodeVideoFrames: async function decode() {
        decoded = true;
        return [];
      },
    });

    if (!inspected.ok || inspected.value.kind !== "media_metadata") {
      throw new Error("expected media metadata");
    }

    // Materialization has no lease and no decoder; restore has neither. Both
    // still see the stills, and neither pays for a second decode.
    expect(inspected.value.decodedStills).toMatchObject([
      { timestampMs: 250, mediaType: "image/jpeg" },
    ]);
    expect(decoded).toBe(false);
  });
});
