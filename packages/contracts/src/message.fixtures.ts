// Type-level fixtures for the Plan 37 message contract.
//
// The positive fixtures pin the shapes a boundary parser must be able to build.
// The negative fixtures pin what the compiler must refuse: an empty message, a
// cross-class media type, an unvalidated string standing in for a brand, and a
// descriptor branch wearing another branch's fields.
//
// Brands are unforgeable on purpose — only a boundary parser mints one. The
// `mint*` helpers below stand in for those parsers with one narrow cast each,
// so a fixture never launders a raw string into a domain value implicitly.

import type {
  AttachmentDescriptor,
  AttachmentId,
  AudioMediaType,
  DisplayFilename,
  DocumentMediaType,
  FileExtensionHint,
  HttpUrl,
  ImageMediaType,
  IntegrationAccountId,
  MessageAttachmentSource,
  MessageLink,
  NonEmptyText,
  NormalizedExtension,
  NormalizedMediaType,
  OpaqueMediaType,
  SlackChannelId,
  SlackFileId,
  SlackFileRevision,
  SlackMessageTimestamp,
  SlackWorkspaceId,
  StoredMessageAttachment,
  OrganisationAttachmentObjectKey,
  UserMessage,
  UserMessagePart,
  VideoMediaType,
} from "./index.ts";

const mintText = (value: string) => value as NonEmptyText;
const mintUrl = (value: string) => value as HttpUrl;
const mintImageType = (value: string) => value as ImageMediaType;
const mintDocumentType = (value: string) => value as DocumentMediaType;
const mintAudioType = (value: string) => value as AudioMediaType;
const mintVideoType = (value: string) => value as VideoMediaType;
const mintOpaqueType = (value: string) => value as OpaqueMediaType;
const mintMediaType = (value: string) => value as NormalizedMediaType;

const slackSource = {
  kind: "slack",
  integrationAccountId: "account_1" as IntegrationAccountId,
  workspaceId: "T1" as SlackWorkspaceId,
  channelId: "C1" as SlackChannelId,
  messageTs: "1700000000.000100" as SlackMessageTimestamp,
  fileId: "F1" as SlackFileId,
  revision: "1700000000" as SlackFileRevision,
} satisfies MessageAttachmentSource;

const pdfExtension = {
  kind: "named",
  value: "pdf" as NormalizedExtension,
} satisfies FileExtensionHint;

function storedAttachment(
  displayName: string,
  extensionHint: FileExtensionHint,
  descriptor: AttachmentDescriptor,
): StoredMessageAttachment {
  return {
    id: "att_0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f" as AttachmentId,
    displayName: displayName as DisplayFilename,
    extensionHint,
    descriptor,
    byteLength: 1024,
    sha256: "a".repeat(64),
    objectKey:
      `attachments/organisation_1/slack/${"a".repeat(64)}` as OrganisationAttachmentObjectKey,
    source: slackSource,
    retention: "session",
    storedAt: 1_700_000_000,
  };
}

// --- Positive: every media class has one valid representation ---------------

export const verifiedImage = {
  kind: "image",
  media: {
    kind: "signature_verified",
    mediaType: mintImageType("image/png"),
    method: "magic_bytes",
  },
} satisfies AttachmentDescriptor;

export const declaredDocument = {
  kind: "document",
  media: {
    kind: "provider_declared",
    mediaType: mintDocumentType("application/pdf"),
    provider: "slack",
  },
} satisfies AttachmentDescriptor;

export const verifiedAudio = {
  kind: "audio",
  media: {
    kind: "signature_verified",
    mediaType: mintAudioType("audio/mpeg"),
    method: "container_structure",
  },
} satisfies AttachmentDescriptor;

export const verifiedVideo = {
  kind: "video",
  media: {
    kind: "signature_verified",
    mediaType: mintVideoType("video/mp4"),
    method: "container_structure",
  },
} satisfies AttachmentDescriptor;

// An unfamiliar CAD format is admitted, not rejected. The provider's claim
// survives as a diagnostic hint; the established type stays octet-stream.
export const unidentifiedCad = {
  kind: "opaque",
  media: { kind: "unknown", mediaType: "application/octet-stream" },
  formatHint: { declaredMediaType: mintMediaType("application/x-3ds") },
} satisfies AttachmentDescriptor;

export const declaredArchive = {
  kind: "opaque",
  media: {
    kind: "provider_declared",
    mediaType: mintOpaqueType("application/zip"),
    provider: "slack",
  },
  formatHint: { declaredMediaType: mintMediaType("application/zip") },
} satisfies AttachmentDescriptor;

// --- Positive: message shapes ----------------------------------------------

export const textOnlyMessage = {
  firstPart: { kind: "text", text: mintText("price this for export") },
  remainingParts: [],
} satisfies UserMessage;

export const fileOnlyMessage = {
  firstPart: {
    kind: "attachment",
    attachment: storedAttachment("turbine.3ds", pdfExtension, unidentifiedCad),
  },
  remainingParts: [],
} satisfies UserMessage;

export const linkOnlyMessage = {
  firstPart: {
    kind: "link",
    link: {
      url: mintUrl("https://example.com/spec"),
      presentation: { kind: "url" },
    },
  },
  remainingParts: [],
} satisfies UserMessage;

export const labelledLink = {
  url: mintUrl("https://example.com/spec"),
  presentation: { kind: "label", label: mintText("the spec") },
} satisfies MessageLink;

export const mixedMessage = {
  firstPart: { kind: "text", text: mintText("quote against this drawing") },
  remainingParts: [
    { kind: "link", link: labelledLink },
    {
      kind: "attachment",
      attachment: storedAttachment("quote.pdf", pdfExtension, declaredDocument),
    },
    {
      kind: "attachment",
      attachment: storedAttachment(
        "walkthrough.mp4",
        { kind: "none" },
        verifiedVideo,
      ),
    },
  ],
} satisfies UserMessage;

// --- Negative: the compiler must refuse these -------------------------------

// @ts-expect-error A message cannot be empty: the first part is required.
export const emptyMessage: UserMessage = { remainingParts: [] };

// @ts-expect-error A video media type cannot enter an image descriptor.
export const crossClassDescriptor: AttachmentDescriptor = {
  kind: "image",
  media: {
    kind: "signature_verified",
    mediaType: mintVideoType("video/mp4"),
    method: "magic_bytes",
  },
};

export const rawStringMediaType: AttachmentDescriptor = {
  kind: "image",
  media: {
    kind: "signature_verified",
    // @ts-expect-error An unvalidated string is not an established media type.
    mediaType: "image/png",
    method: "magic_bytes",
  },
};

export const declaredAsVerified: AttachmentDescriptor = {
  kind: "document",
  media: {
    kind: "signature_verified",
    mediaType: mintDocumentType("application/pdf"),
    // @ts-expect-error A provider declaration is not a signature method.
    method: "provider_declared",
  },
};

export const opaqueUnknownWithPreciseType: AttachmentDescriptor = {
  kind: "opaque",
  media: {
    kind: "unknown",
    // @ts-expect-error Unknown identification pins application/octet-stream.
    mediaType: "application/x-3ds",
  },
  formatHint: { declaredMediaType: mintMediaType("application/x-3ds") },
};

export const imageWithFormatHint: AttachmentDescriptor = {
  kind: "image",
  media: {
    kind: "signature_verified",
    mediaType: mintImageType("image/png"),
    method: "magic_bytes",
  },
  // @ts-expect-error Only the opaque branch carries a diagnostic format hint.
  formatHint: { declaredMediaType: mintMediaType("image/png") },
};

export const rawStringLink: MessageLink = {
  // @ts-expect-error An unvalidated string is not a normalized HTTP(S) URL.
  url: "https://example.com",
  presentation: { kind: "url" },
};

export const broadPartSpread: Record<string, unknown> = {
  kind: "text",
  text: "loose",
};
// @ts-expect-error A broad record cannot become a message part through a spread.
export const spreadPart: UserMessagePart = { ...broadPartSpread };
