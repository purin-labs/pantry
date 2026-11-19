import { describe, expect, it } from "vitest";

import { MESSAGE_ATTACHMENT_POLICY } from "@purin-labs/control-api";
import { acquireSlackAttachmentBatch } from "../src/slack/attachments";
import {
  parseSlackEnvelope,
  type SlackMessageEvent,
} from "../src/slack/events";
import { requireIntegrationAccountId, requireOrganisationId } from "./test-ids";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n% a small document");
const OPAQUE_BYTES = new Uint8Array([
  0x4d, 0x4d, 0x00, 0x2a, 0x01, 0x02, 0x03, 0x04,
]);

describe("Slack attachment acquisition", function slackAttachmentAcquisitionSuite() {
  it("commits an image once and reuses the committed revision on retry", async function commitsOnce() {
    const bucket = new TestR2Bucket();
    const slack = new SlackFetchFixture(PNG_BYTES, "image/png");
    const input = batchInput(
      bucket,
      slackEvent("image/png", PNG_BYTES.byteLength),
      slack,
    );

    const first = await acquireSlackAttachmentBatch(input);
    const downloadsAfterFirst = slack.requests.length;
    const second = await acquireSlackAttachmentBatch(input);

    expect(first.state).toBe("committed");
    expect(second.state).toBe("committed");

    if (first.state !== "committed" || second.state !== "committed") {
      throw new Error("expected committed batches");
    }

    expect(second.attachments).toEqual(first.attachments);
    // The second acquisition reuses the verified object instead of re-transferring it.
    expect(slack.requests).toHaveLength(downloadsAfterFirst);

    const stored = first.attachments[0];

    if (stored === undefined) {
      throw new Error("expected one committed attachment");
    }

    expect(stored.objectKey).toBe(
      `attachments/organisation_fixture/slack/${stored.sha256}`,
    );
    expect(stored.descriptor.kind).toBe("image");
    expect(stored.retention).toBe("session");
    expect(await bucket.bytes(stored.objectKey)).toEqual(PNG_BYTES);
    // Staging never outlives the batch.
    expect((await bucket.keys()).some((key) => key.includes("/staging/"))).toBe(
      false,
    );
  });

  it("admits a PDF that the image-only gate used to refuse", async function admitsDocuments() {
    const bucket = new TestR2Bucket();
    const slack = new SlackFetchFixture(PDF_BYTES, "application/pdf");
    const result = await acquireSlackAttachmentBatch(
      batchInput(
        bucket,
        slackEvent("application/pdf", PDF_BYTES.byteLength),
        slack,
      ),
    );

    if (result.state !== "committed") {
      throw new Error(
        `expected a committed batch, got ${JSON.stringify(result)}`,
      );
    }

    const stored = result.attachments[0];

    expect(stored?.descriptor.kind).toBe("document");
    expect(stored?.descriptor.media.mediaType).toBe("application/pdf");
    expect(stored?.descriptor.media.kind).toBe("signature_verified");
  });

  it("lets the bytes overrule a provider media type that disagrees", async function bytesWin() {
    const bucket = new TestR2Bucket();
    // Slack claims PNG; the bytes are a PDF. The file is admitted, classified
    // from its bytes, and not refused.
    const slack = new SlackFetchFixture(PDF_BYTES, "image/png");
    const result = await acquireSlackAttachmentBatch(
      batchInput(bucket, slackEvent("image/png", PDF_BYTES.byteLength), slack),
    );

    if (result.state !== "committed") {
      throw new Error(
        `expected a committed batch, got ${JSON.stringify(result)}`,
      );
    }

    expect(result.attachments[0]?.descriptor.kind).toBe("document");
    expect(result.attachments[0]?.descriptor.media.mediaType).toBe(
      "application/pdf",
    );
  });

  it("admits an unfamiliar binary as an opaque file", async function admitsOpaque() {
    const bucket = new TestR2Bucket();
    const slack = new SlackFetchFixture(
      OPAQUE_BYTES,
      "application/x-3ds",
      "turbine.3ds",
    );
    const result = await acquireSlackAttachmentBatch(
      batchInput(
        bucket,
        slackEvent("application/x-3ds", OPAQUE_BYTES.byteLength, "turbine.3ds"),
        slack,
      ),
    );

    if (result.state !== "committed") {
      throw new Error(
        `expected a committed batch, got ${JSON.stringify(result)}`,
      );
    }

    const stored = result.attachments[0];

    expect(stored?.descriptor.kind).toBe("opaque");
    expect(stored?.descriptor.media.kind).toBe("provider_declared");
    expect(stored?.extensionHint).toEqual({ kind: "named", value: "3ds" });
  });

  it("hydrates file metadata omitted from Slack app_mention events", async function hydratesMentionFiles() {
    const bucket = new TestR2Bucket();
    const slack = new SlackFetchFixture(PNG_BYTES, "image/png");
    const result = await acquireSlackAttachmentBatch(
      batchInput(bucket, slackEventWithoutFiles(), slack),
    );

    if (result.state !== "committed") {
      throw new Error(
        `expected a committed batch, got ${JSON.stringify(result)}`,
      );
    }

    expect(result.attachments).toHaveLength(1);
    expect(slack.requests[0]).toContain("/api/conversations.replies");
  });

  it("refuses a batch beyond the file-count limit with the applied rule", async function refusesCount() {
    const bucket = new TestR2Bucket();
    const slack = new SlackFetchFixture(PNG_BYTES, "image/png");
    const files = Array.from(
      { length: MESSAGE_ATTACHMENT_POLICY.maxFilesPerMessage + 1 },
      function hostedFile(_unused, index) {
        return {
          kind: "hosted" as const,
          file: {
            fileId: `F0BGIMAGE${index}`,
            displayName: `diagram-${index}.png`,
            declaredMediaType: "image/png",
            declaredByteLength: PNG_BYTES.byteLength,
            revision: "1780000000",
          },
        };
      },
    );
    const result = await acquireSlackAttachmentBatch(
      batchInput(
        bucket,
        { ...slackEvent("image/png", PNG_BYTES.byteLength), files },
        slack,
      ),
    );

    expect(result).toEqual({
      state: "rejected",
      rejection: {
        code: "file_count_exceeded",
        limit: MESSAGE_ATTACHMENT_POLICY.maxFilesPerMessage,
        observed: MESSAGE_ATTACHMENT_POLICY.maxFilesPerMessage + 1,
      },
    });
    // Nothing is transferred once the batch is already refused.
    expect(slack.requests).toEqual([]);
    expect(await bucket.keys()).toEqual([]);
  });

  it("never admits a partial batch", async function refusesPartialBatch() {
    const bucket = new TestR2Bucket();
    const slack = new SlackFetchFixture(PNG_BYTES, "image/png");
    const event = {
      ...slackEvent("image/png", PNG_BYTES.byteLength),
      files: [
        {
          kind: "hosted" as const,
          file: {
            fileId: "F0BGIMAGE",
            displayName: "diagram.png",
            declaredMediaType: "image/png",
            declaredByteLength: PNG_BYTES.byteLength,
            revision: "1780000000",
          },
        },
        {
          kind: "hosted" as const,
          file: {
            fileId: "F0BGTOOBIG",
            displayName: "huge.png",
            declaredMediaType: "image/png",
            declaredByteLength: MESSAGE_ATTACHMENT_POLICY.maxFileBytes + 1,
            revision: "1780000000",
          },
        },
      ],
    };

    const result = await acquireSlackAttachmentBatch(
      batchInput(bucket, event, slack),
    );

    expect(result.state).toBe("rejected");
    // The good file is not committed on its own.
    expect(await bucket.keys()).toEqual([]);
  });
});

function batchInput(
  bucket: TestR2Bucket,
  event: SlackMessageEvent,
  slack: SlackFetchFixture,
) {
  return {
    bucket: bucket.binding(),
    organisationId: requireOrganisationId("organisation_fixture"),
    integrationAccountId: requireIntegrationAccountId("account_fixture"),
    event,
    token: "xoxb-fixture",
    now: 1_780_000_000_000,
    fetcher: slack.fetch,
  };
}

class SlackFetchFixture {
  readonly requests: string[] = [];
  readonly fetch: typeof fetch;

  constructor(
    private readonly bytesValue: Uint8Array,
    private readonly mediaType: string,
    private readonly displayName = "diagram.png",
  ) {
    this.fetch = this.fetchRequest.bind(this);
  }

  private async fetchRequest(input: RequestInfo | URL): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input.toString());
    this.requests.push(url.toString());

    if (url.pathname === "/api/conversations.replies") {
      return Response.json({
        ok: true,
        messages: [
          {
            ts: "1780000000.000001",
            files: [
              {
                id: "F0BGIMAGE",
                name: this.displayName,
                mimetype: this.mediaType,
                size: this.bytesValue.byteLength,
                timestamp: 1_780_000_000,
              },
            ],
          },
        ],
      });
    }

    if (url.hostname === "slack.com") {
      return Response.json({
        ok: true,
        file: {
          id: "F0BGIMAGE",
          name: this.displayName,
          mimetype: this.mediaType,
          size: this.bytesValue.byteLength,
          url_private_download:
            "https://files.slack.com/files-pri/T0BGHOST-F0BGIMAGE/download",
        },
      });
    }

    if (url.hostname === "files.slack.com") {
      return new Response(this.bytesValue.slice(), {
        status: 200,
        headers: {
          "content-type": this.mediaType,
          "content-length": String(this.bytesValue.byteLength),
        },
      });
    }

    throw new Error(`unexpected fetch target: ${url.toString()}`);
  }
}

class TestR2Bucket {
  private readonly objects = new Map<string, TestR2Value>();

  binding(): R2Bucket {
    return this as unknown as R2Bucket;
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    const bytes = await readR2Input(value);
    const httpMetadata = normalizeHttpMetadata(options?.httpMetadata);
    this.objects.set(key, {
      bytes,
      httpMetadata,
      customMetadata: options?.customMetadata,
    });
    return testR2Object(key, bytes, httpMetadata, options?.customMetadata);
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    const value = this.objects.get(key);

    if (value === undefined) {
      return null;
    }

    const range = options?.range;

    if (
      range !== undefined &&
      "offset" in range &&
      range.offset !== undefined
    ) {
      const offset = range.offset;
      const length =
        "length" in range && range.length !== undefined
          ? range.length
          : value.bytes.byteLength - offset;
      return testR2ObjectBody(key, {
        ...value,
        bytes: value.bytes.slice(offset, offset + length),
      });
    }

    return testR2ObjectBody(key, value);
  }

  async head(key: string): Promise<R2Object | null> {
    const value = this.objects.get(key);
    return value === undefined
      ? null
      : testR2Object(
          key,
          value.bytes,
          value.httpMetadata,
          value.customMetadata,
        );
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async bytes(key: string): Promise<Uint8Array> {
    const value = this.objects.get(key);

    if (value === undefined) {
      throw new Error(`missing test R2 object: ${key}`);
    }

    return value.bytes.slice();
  }

  async keys(): Promise<string[]> {
    return [...this.objects.keys()].sort();
  }
}

type TestR2Value = {
  bytes: Uint8Array;
  httpMetadata: R2HTTPMetadata | undefined;
  customMetadata: Record<string, string> | undefined;
};

function testR2Object(
  key: string,
  bytes: Uint8Array,
  httpMetadata: R2HTTPMetadata | undefined,
  customMetadata: Record<string, string> | undefined,
): R2Object {
  return {
    key,
    version: "version-fixture",
    size: bytes.byteLength,
    etag: "etag-fixture",
    httpEtag: '"etag-fixture"',
    uploaded: new Date(0),
    checksums: { toJSON: emptyChecksums },
    httpMetadata,
    customMetadata,
    range: undefined,
    storageClass: "Standard",
    writeHttpMetadata,
  };
}

function testR2ObjectBody(key: string, value: TestR2Value): R2ObjectBody {
  const object = testR2Object(
    key,
    value.bytes,
    value.httpMetadata,
    value.customMetadata,
  );

  return {
    ...object,
    body: new Response(value.bytes.slice()).body,
    bodyUsed: false,
    arrayBuffer: readTestArrayBuffer.bind(null, value.bytes),
    text: readTestText.bind(null, value.bytes),
    json: readTestJson.bind(null, value.bytes),
    blob: readTestBlob.bind(null, value.bytes),
  } as R2ObjectBody;
}

async function readR2Input(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string,
): Promise<Uint8Array> {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }

  if (value instanceof ReadableStream) {
    return new Uint8Array(await new Response(value).arrayBuffer());
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }

  return new Uint8Array(
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
  );
}

function normalizeHttpMetadata(
  metadata: R2HTTPMetadata | Headers | undefined,
): R2HTTPMetadata | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  if (metadata instanceof Headers) {
    return {
      contentType: metadata.get("content-type") ?? undefined,
      contentLanguage: metadata.get("content-language") ?? undefined,
      contentDisposition: metadata.get("content-disposition") ?? undefined,
      contentEncoding: metadata.get("content-encoding") ?? undefined,
      cacheControl: metadata.get("cache-control") ?? undefined,
      cacheExpiry: undefined,
    };
  }

  return metadata;
}

function emptyChecksums(): Record<string, string> {
  return {};
}

function writeHttpMetadata(_headers: Headers): void {}

async function readTestArrayBuffer(bytes: Uint8Array): Promise<ArrayBuffer> {
  return bytes.slice().buffer;
}

async function readTestText(bytes: Uint8Array): Promise<string> {
  return new TextDecoder().decode(bytes);
}

async function readTestJson<T>(bytes: Uint8Array): Promise<T> {
  return JSON.parse(await readTestText(bytes)) as T;
}

async function readTestBlob(bytes: Uint8Array): Promise<Blob> {
  return new Blob([bytes.slice()]);
}

function slackEvent(
  mediaType: string,
  byteLength: number,
  displayName = "diagram.png",
): SlackMessageEvent {
  const parsed = parseSlackEnvelope(
    JSON.stringify({
      type: "event_callback",
      api_app_id: "A_TEST",
      event_id: "Ev0BGIMAGE",
      team_id: "T0BGHOST",
      event: {
        type: "app_mention",
        channel: "C0BGCHANNEL",
        user: "U0BGUSER",
        text: "<@U0BGPANTRY> inspect this",
        ts: "1780000000.000001",
        event_ts: "1780000000.000001",
        files: [
          {
            id: "F0BGIMAGE",
            name: displayName,
            mimetype: mediaType,
            size: byteLength,
            timestamp: 1_780_000_000,
          },
        ],
      },
    }),
  );

  if (!parsed.ok || parsed.value.kind !== "message") {
    throw new Error("invalid Slack event fixture");
  }

  return parsed.value.event;
}

function slackEventWithoutFiles(): SlackMessageEvent {
  const parsed = parseSlackEnvelope(
    JSON.stringify({
      type: "event_callback",
      api_app_id: "A_TEST",
      event_id: "Ev0BGIMAGE",
      team_id: "T0BGHOST",
      event: {
        type: "app_mention",
        channel: "C0BGCHANNEL",
        user: "U0BGUSER",
        text: "<@U0BGPANTRY> inspect this",
        ts: "1780000000.000001",
        event_ts: "1780000000.000001",
      },
    }),
  );

  if (!parsed.ok || parsed.value.kind !== "message") {
    throw new Error("invalid Slack event fixture");
  }

  return parsed.value.event;
}
