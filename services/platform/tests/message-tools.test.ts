import type { StoredMessageAttachment } from "@seams/contracts";
import { describe, expect, it } from "vitest";

import {
  createAttachmentInspectionTool,
  createMessageLinkTool,
  userMessageLinks,
} from "../src/actors/message-tools";
import type { EmbeddedHarnessUserInput } from "../src/actors/embedded-harness";
import type { OrganisationId } from "../src/ids";

const ORGANISATION = "organisation_tools" as OrganisationId;

describe("message tools", function messageToolsSuite() {
  it("refuses an attachment id from outside this message", async function refusesForeignAttachment() {
    const attachment = attachmentFor("foreign.txt", "text/plain");
    let preparations = 0;
    const inspect = createAttachmentInspectionTool({
      attachments: [],
      readPreparation: async function readPreparation() {
        preparations += 1;
        return { ok: true, value: [] };
      },
    });

    const result = await inspect({ attachmentId: String(attachment.id) });

    expect(result).toEqual({
      outcome: "attachment_not_in_message",
      attachmentId: String(attachment.id),
      available: [],
    });
    expect(preparations).toBe(0);
  });

  it("records an observation before exposing prepared content", async function recordsObservation() {
    const attachment = attachmentFor("menu.csv", "text/csv");
    const order: string[] = [];
    const inspect = createAttachmentInspectionTool({
      attachments: [attachment],
      readPreparation: async function readPreparation(source) {
        expect(source).toEqual(attachment);
        order.push("preparation");
        return {
          ok: true,
          value: [documentPart(attachment)],
        };
      },
      recordObservation: async function recordObservation(observation) {
        expect(observation.attachment).toEqual(attachment);
        order.push("observation");
      },
    });

    const result = await inspect({ attachmentId: String(attachment.id) });

    expect(order).toEqual(["preparation", "observation"]);
    expect(result.outcome).toBe("inspected");
    expect(JSON.stringify(result)).toContain("espresso,3.50");
  });

  it("returns prepared document text and its manifest", async function returnsPreparedDocument() {
    const attachment = attachmentFor("menu.csv", "text/csv");
    const inspect = createAttachmentInspectionTool({
      attachments: [attachment],
      readPreparation: async function readPreparation() {
        return { ok: true, value: [documentPart(attachment)] };
      },
    });

    const result = await inspect({ attachmentId: String(attachment.id) });

    expect(result).toEqual({
      outcome: "inspected",
      result: {
        kind: "prepared_attachment",
        parts: [
          {
            kind: "attachment_text",
            attachmentId: String(attachment.id),
            manifest: "[attachment att_menu] menu.csv class=document",
            text: "espresso,3.50",
            truncated: false,
          },
        ],
      },
    });
  });

  it("returns prepared media facts and omits native image bytes", async function returnsPreparedMedia() {
    const attachment = attachmentFor("line.mp4", "video/mp4", "video");
    const image: EmbeddedHarnessUserInput = {
      kind: "image",
      dataUrl: "data:image/jpeg;base64,/9j/",
      detail: "original",
      attachment,
    };
    const inspect = createAttachmentInspectionTool({
      attachments: [attachment],
      readPreparation: async function readPreparation() {
        return {
          ok: true,
          value: [mediaPart(attachment), image],
        };
      },
    });

    const result = await inspect({ attachmentId: String(attachment.id) });
    const serialized = JSON.stringify(result);

    expect(result).toEqual({
      outcome: "inspected",
      result: {
        kind: "prepared_attachment",
        parts: [
          {
            kind: "attachment_media",
            attachmentId: String(attachment.id),
            manifest: "[attachment att_video] line.mp4 class=video",
            summary:
              "container=mp4 video=h264 decodedStills=4 audio=aac channels=2 sampleRateHz=48000",
          },
          {
            kind: "image",
            attachmentId: String(attachment.id),
            mediaType: "image/jpeg",
            detail: "original",
            includedInInitialNativeModelInput: true,
            note: "image already part of initial native model input",
          },
        ],
      },
    });
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain("/9j/");
  });

  it("reports preparation failures", async function reportsPreparationFailure() {
    const failedAttachment = attachmentFor("gone.txt", "text/plain");
    const observed: string[] = [];
    const failed = createAttachmentInspectionTool({
      attachments: [failedAttachment],
      readPreparation: async function readPreparation() {
        return { ok: false, error: { code: "preparation_unavailable" } };
      },
      recordObservation: async function recordObservation(observation) {
        observed.push(String(observation.attachment.id));
      },
    });

    await expect(
      failed({ attachmentId: String(failedAttachment.id) }),
    ).resolves.toEqual({
      outcome: "unavailable",
      reason: "preparation_unavailable",
      attachmentId: String(failedAttachment.id),
      manifest: expect.stringContaining("gone.txt"),
    });
    expect(observed).toEqual([]);
  });

  it("reads only a link the author actually wrote", async function refusesInventedLink() {
    const read = createMessageLinkTool({
      links: ["https://example.com/spec"],
      egress: {
        resolve: async function resolve(_hostname, _deadlineAtUnixMs) {
          return ["93.184.216.34"];
        },
        fetchValidated: async function fetchValidated(
          _url,
          _address,
          _deadlineAtUnixMs,
        ) {
          throw new Error("must not fetch an invented link");
        },
      },
    });

    expect(await read({ url: "https://evil.example.com/exfiltrate" })).toEqual({
      outcome: "link_not_in_message",
      available: ["https://example.com/spec"],
    });
  });

  it("refuses every read while no pinning egress exists", async function failsClosedWithoutEgress() {
    const read = createMessageLinkTool({ links: ["https://example.com/spec"] });
    const result = await read({ url: "https://example.com/spec" });

    expect(result).toEqual({
      outcome: "refused",
      reason: { code: "destination_not_verifiable" },
    });
  });

  it("reads a message link through a pinning egress", async function readsThroughEgress() {
    const pinned: string[] = [];
    const read = createMessageLinkTool({
      links: ["https://example.com/spec"],
      egress: {
        resolve: async function resolve(_hostname, _deadlineAtUnixMs) {
          return ["93.184.216.34"];
        },
        fetchValidated: async function fetchValidated(
          _url,
          address,
          _deadlineAtUnixMs,
        ) {
          pinned.push(address);
          return new Response("the spec text", {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        },
      },
    });

    const result = await read({ url: "https://example.com/spec" });

    expect(result.outcome).toBe("read");
    expect(pinned).toEqual(["93.184.216.34"]);
    expect(JSON.stringify(result)).toContain("the spec text");
  });

  it("collects the links a message carried in canonical order", function collectsLinks() {
    expect(
      userMessageLinks({
        firstPart: { kind: "text", text: "see" },
        remainingParts: [
          {
            kind: "link",
            link: {
              url: "https://a.example.com",
              presentation: { kind: "url" },
            },
          },
          {
            kind: "link",
            link: {
              url: "https://b.example.com",
              presentation: { kind: "url" },
            },
          },
        ],
      } as never),
    ).toEqual(["https://a.example.com", "https://b.example.com"]);
  });
});

function documentPart(
  attachment: StoredMessageAttachment,
): EmbeddedHarnessUserInput {
  return {
    kind: "attachment_text",
    manifest: `[attachment ${String(attachment.id)}] ${String(attachment.displayName)} class=document`,
    text: "espresso,3.50",
    truncated: false,
    attachment,
  };
}

function mediaPart(
  attachment: StoredMessageAttachment,
): EmbeddedHarnessUserInput {
  return {
    kind: "attachment_media",
    manifest: `[attachment ${String(attachment.id)}] ${String(attachment.displayName)} class=video`,
    summary:
      "container=mp4 video=h264 decodedStills=4 audio=aac channels=2 sampleRateHz=48000",
    attachment,
  };
}

function attachmentFor(
  displayName: string,
  mediaType: string,
  kind: "document" | "video" = "document",
): StoredMessageAttachment {
  const attachmentId =
    kind === "video"
      ? "att_video"
      : displayName === "gone.txt"
        ? "att_gone"
        : displayName === "foreign.txt"
          ? "att_foreign"
          : "att_menu";

  return {
    id: attachmentId,
    displayName,
    extensionHint: { kind: "none" },
    descriptor: {
      kind,
      media: { kind: "provider_declared", mediaType, provider: "slack" },
    },
    byteLength: 4,
    sha256: "a".repeat(64),
    objectKey: `attachments/${ORGANISATION}/slack/${attachmentId}`,
    source: {
      kind: "slack",
      integrationAccountId: "account_tools",
      workspaceId: "T1",
      channelId: "C1",
      messageTs: "1700000000.000100",
      fileId: attachmentId,
      revision: "1700000000",
    },
    retention: "session",
    storedAt: 1_700_000_000,
  } as unknown as StoredMessageAttachment;
}
