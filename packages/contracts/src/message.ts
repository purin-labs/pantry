import {
  codePointCount,
  hasRustControl,
  hasRustWhitespace,
  isRecord,
  rustTrim,
  sha256HexSync,
  utf8ByteLength,
} from "@purin-labs/std";
import { Type, type Static } from "typebox";
import { encodeUserMessageDigest } from "./digest-encoders.ts";
import {
  admitJson,
  messageError,
  parseShape,
  type MessageParseResult,
  type MessageRejection,
} from "./message-shape.ts";

// Plan 78: TypeScript port of message.rs. Each parser checks the serde shape
// first and then runs the Rust constructors in their order, so a refusal has
// the Rust code and the Rust field.

type Brand<Name extends string> = string & { readonly __brand: Name };
function brand<Name extends string>() {
  return Type.Unsafe<Brand<Name>>(Type.String());
}

const nonEmptyTextSchema = brand<"NonEmptyText">();
const httpUrlSchema = brand<"HttpUrl">();
const normalizedMediaTypeSchema = brand<"NormalizedMediaType">();
const normalizedExtensionSchema = brand<"NormalizedExtension">();
const displayFilenameSchema = brand<"DisplayFilename">();
export const attachmentIdSchema = brand<"AttachmentId">();
export const organisationAttachmentObjectKeySchema =
  brand<"OrganisationAttachmentObjectKey">();
const imageMediaTypeSchema = brand<"ImageMediaType">();
const documentMediaTypeSchema = brand<"DocumentMediaType">();
const audioMediaTypeSchema = brand<"AudioMediaType">();
const videoMediaTypeSchema = brand<"VideoMediaType">();
const opaqueMediaTypeSchema = brand<"OpaqueMediaType">();
const slackWorkspaceIdSchema = brand<"SlackWorkspaceId">();
const slackChannelIdSchema = brand<"SlackChannelId">();
const slackMessageTimestampSchema = brand<"SlackMessageTimestamp">();
const slackFileIdSchema = brand<"SlackFileId">();
const slackFileRevisionSchema = brand<"SlackFileRevision">();
const portalUserIdSchema = brand<"PortalUserId">();
const portalConversationIdSchema = brand<"PortalConversationId">();
const octetStreamMediaTypeSchema = Type.Literal("application/octet-stream");

const mediaSignatureMethodSchema = Type.Union([
  Type.Literal("magic_bytes"),
  Type.Literal("container_structure"),
]);
const mediaDeclaringProviderSchema = Type.Union([
  Type.Literal("slack"),
  Type.Literal("portal"),
]);
const attachmentRetentionClassSchema = Type.Literal("session");

function mediaEvidenceSchema<MediaType extends ReturnType<typeof brand>>(
  mediaType: MediaType,
) {
  return Type.Union([
    Type.Object({
      kind: Type.Literal("signature_verified"),
      mediaType,
      method: mediaSignatureMethodSchema,
    }),
    Type.Object({
      kind: Type.Literal("provider_declared"),
      mediaType,
      provider: mediaDeclaringProviderSchema,
    }),
  ]);
}

const opaqueMediaEvidenceSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("signature_verified"),
    mediaType: opaqueMediaTypeSchema,
    method: mediaSignatureMethodSchema,
  }),
  Type.Object({
    kind: Type.Literal("provider_declared"),
    mediaType: opaqueMediaTypeSchema,
    provider: mediaDeclaringProviderSchema,
  }),
  Type.Object({
    kind: Type.Literal("unknown"),
    mediaType: octetStreamMediaTypeSchema,
  }),
]);
const opaqueFormatHintSchema = Type.Object({
  declaredMediaType: normalizedMediaTypeSchema,
});
const fileExtensionHintSchema = Type.Union([
  Type.Object({ kind: Type.Literal("none") }),
  Type.Object({
    kind: Type.Literal("named"),
    value: normalizedExtensionSchema,
  }),
]);
const attachmentDescriptorSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("image"),
    media: mediaEvidenceSchema(imageMediaTypeSchema),
  }),
  Type.Object({
    kind: Type.Literal("document"),
    media: mediaEvidenceSchema(documentMediaTypeSchema),
  }),
  Type.Object({
    kind: Type.Literal("audio"),
    media: mediaEvidenceSchema(audioMediaTypeSchema),
  }),
  Type.Object({
    kind: Type.Literal("video"),
    media: mediaEvidenceSchema(videoMediaTypeSchema),
  }),
  Type.Object({
    kind: Type.Literal("opaque"),
    media: opaqueMediaEvidenceSchema,
    formatHint: opaqueFormatHintSchema,
  }),
]);
const messageAttachmentSourceSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("portal"),
    userId: portalUserIdSchema,
    conversationId: portalConversationIdSchema,
    uploadId: attachmentIdSchema,
  }),
  Type.Object({
    kind: Type.Literal("slack"),
    integrationAccountId: Type.String(),
    workspaceId: slackWorkspaceIdSchema,
    channelId: slackChannelIdSchema,
    messageTs: slackMessageTimestampSchema,
    fileId: slackFileIdSchema,
    revision: slackFileRevisionSchema,
  }),
]);
const storedMessageAttachmentSchema = Type.Object({
  id: attachmentIdSchema,
  displayName: displayFilenameSchema,
  extensionHint: fileExtensionHintSchema,
  descriptor: attachmentDescriptorSchema,
  byteLength: Type.Number(),
  sha256: Type.String(),
  objectKey: organisationAttachmentObjectKeySchema,
  source: messageAttachmentSourceSchema,
  retention: attachmentRetentionClassSchema,
  storedAt: Type.Number(),
});
const messageLinkPresentationSchema = Type.Union([
  Type.Object({ kind: Type.Literal("url") }),
  Type.Object({ kind: Type.Literal("label"), label: nonEmptyTextSchema }),
]);
const messageLinkSchema = Type.Object({
  url: httpUrlSchema,
  presentation: messageLinkPresentationSchema,
});
const userMessagePartSchema = Type.Union([
  Type.Object({ kind: Type.Literal("text"), text: nonEmptyTextSchema }),
  Type.Object({ kind: Type.Literal("link"), link: messageLinkSchema }),
  Type.Object({
    kind: Type.Literal("attachment"),
    attachment: storedMessageAttachmentSchema,
  }),
]);
const userMessageSchema = Type.Object({
  firstPart: userMessagePartSchema,
  remainingParts: Type.Array(userMessagePartSchema),
});
const userMessageViewsSchema = Type.Object({
  modelPrompt: Type.String(),
  casePurpose: Type.String(),
  contextQuery: Type.Union([Type.String(), Type.Null()]),
  contentDigest: Type.String(),
});

export type NonEmptyText = Static<typeof nonEmptyTextSchema>;
export type HttpUrl = Static<typeof httpUrlSchema>;
export type NormalizedMediaType = Static<typeof normalizedMediaTypeSchema>;
export type NormalizedExtension = Static<typeof normalizedExtensionSchema>;
export type DisplayFilename = Static<typeof displayFilenameSchema>;
export type AttachmentId = Static<typeof attachmentIdSchema>;
export type OrganisationAttachmentObjectKey = Static<
  typeof organisationAttachmentObjectKeySchema
>;
export type ImageMediaType = Static<typeof imageMediaTypeSchema>;
export type DocumentMediaType = Static<typeof documentMediaTypeSchema>;
export type AudioMediaType = Static<typeof audioMediaTypeSchema>;
export type VideoMediaType = Static<typeof videoMediaTypeSchema>;
export type OpaqueMediaType = Static<typeof opaqueMediaTypeSchema>;
export type SlackWorkspaceId = Static<typeof slackWorkspaceIdSchema>;
export type SlackChannelId = Static<typeof slackChannelIdSchema>;
export type SlackMessageTimestamp = Static<typeof slackMessageTimestampSchema>;
export type SlackFileId = Static<typeof slackFileIdSchema>;
export type SlackFileRevision = Static<typeof slackFileRevisionSchema>;
type MediaSignatureMethod = Static<typeof mediaSignatureMethodSchema>;
type MediaDeclaringProvider = Static<typeof mediaDeclaringProviderSchema>;
type OpaqueMediaEvidence = Static<typeof opaqueMediaEvidenceSchema>;
export type FileExtensionHint = Static<typeof fileExtensionHintSchema>;
export type AttachmentDescriptor = Static<typeof attachmentDescriptorSchema>;
export type MessageAttachmentSource = Static<
  typeof messageAttachmentSourceSchema
>;
export type StoredMessageAttachment = Static<
  typeof storedMessageAttachmentSchema
>;
export type MessageLink = Static<typeof messageLinkSchema>;
export type UserMessagePart = Static<typeof userMessagePartSchema>;
export type UserMessage = Static<typeof userMessageSchema>;
export type UserMessageViews = Static<typeof userMessageViewsSchema>;

// ---------------------------------------------------------------------------
// Boundary values
// ---------------------------------------------------------------------------

const NON_EMPTY_TEXT_MAX_CHARS = 65_536;
const HTTP_URL_MAX_BYTES = 2_048;
const MEDIA_TYPE_MAX_BYTES = 255;
const EXTENSION_MAX_CHARS = 24;
const DISPLAY_FILENAME_MAX_CHARS = 255;
const OBJECT_KEY_MAX_BYTES = 1_024;
const OBJECT_KEY_ROOT = "attachments/";
const OCTET_STREAM = "application/octet-stream";
const CASE_PURPOSE_MAX_CHARS = 160;
const CONTEXT_QUERY_MAX_CHARS = 512;

type Checked<T> =
  { ok: true; value: T } | { ok: false; error: MessageRejection };

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, lowercaseCharacter);
}
function lowercaseCharacter(character: string): string {
  return character.toLowerCase();
}

function invalid(code: string, field: string): Checked<never> {
  return { ok: false, error: messageError(code, field) };
}

function parseNonEmptyText(value: string): Checked<NonEmptyText> {
  if (
    rustTrim(value).length === 0 ||
    codePointCount(value) > NON_EMPTY_TEXT_MAX_CHARS ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  )
    return invalid("invalid_text", "NonEmptyText");
  return { ok: true, value: value as NonEmptyText };
}

function parseHttpUrl(value: string): Checked<HttpUrl> {
  const normalized = normalizeHttpUrl(value);
  return normalized === null
    ? invalid("invalid_url", "HttpUrl")
    : { ok: true, value: normalized as HttpUrl };
}

function normalizeHttpUrl(value: string): string | null {
  if (
    value.length === 0 ||
    utf8ByteLength(value) > HTTP_URL_MAX_BYTES ||
    hasRustControl(value) ||
    hasRustWhitespace(value)
  )
    return null;
  const separator = value.indexOf("://");
  if (separator < 0) return null;
  const scheme = asciiLowercase(value.slice(0, separator));
  if (scheme !== "http" && scheme !== "https") return null;
  const remainder = value.slice(separator + 3);
  const end = remainder.search(/[/?#]/u);
  const authorityEnd = end < 0 ? remainder.length : end;
  const authority = remainder.slice(0, authorityEnd);
  const path = remainder.slice(authorityEnd);
  if (!isValidAuthority(authority)) return null;
  return `${scheme}://${asciiLowercase(authority)}${path}`;
}

function isValidAuthority(authority: string): boolean {
  if (
    authority.length === 0 ||
    utf8ByteLength(authority) > 255 ||
    authority.includes("@")
  )
    return false;
  const [host, port] = splitAuthority(authority);
  if (host.length === 0) return false;
  if (port !== null) {
    const parsed = parseRustUnsigned(port);
    if (parsed === null || parsed < 1 || parsed > 65_535) return false;
  }
  if (host.startsWith("[")) {
    const inner = host.slice(1);
    if (!inner.endsWith("]")) return false;
    const address = inner.slice(0, -1);
    return address.length > 0 && /^[0-9A-Fa-f:.]+$/u.test(address);
  }
  return (
    !host.startsWith(".") &&
    !host.endsWith(".") &&
    !host.includes("..") &&
    /^[A-Za-z0-9.-]+$/u.test(host)
  );
}

function splitAuthority(authority: string): [string, string | null] {
  const closing = authority.lastIndexOf("]");
  if (closing >= 0) {
    const after = authority.slice(closing + 1);
    return after.startsWith(":")
      ? [authority.slice(0, closing + 1), after.slice(1)]
      : [authority, null];
  }
  const colon = authority.lastIndexOf(":");
  return colon < 0
    ? [authority, null]
    : [authority.slice(0, colon), authority.slice(colon + 1)];
}

/** Rust `str::parse::<u32>()`: an optional `+`, then ASCII digits. */
function parseRustUnsigned(value: string): number | null {
  const match = /^\+?([0-9]+)$/u.exec(value);
  if (match === null) return null;
  const parsed = Number(match[1]);
  return parsed > 0xffff_ffff ? null : parsed;
}

function parseNormalizedMediaType(value: string): Checked<NormalizedMediaType> {
  const essence = rustTrim(value.split(";")[0] ?? "");
  const slash = essence.indexOf("/");
  if (
    utf8ByteLength(essence) > MEDIA_TYPE_MAX_BYTES ||
    slash < 0 ||
    !isMediaToken(essence.slice(0, slash)) ||
    !isMediaToken(essence.slice(slash + 1))
  )
    return invalid("invalid_media_type", "NormalizedMediaType");
  return { ok: true, value: asciiLowercase(essence) as NormalizedMediaType };
}

/** RFC 6838 restricted-name token. */
function isMediaToken(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 127 &&
    /^[A-Za-z0-9!#$&^_.+-]+$/u.test(value)
  );
}

function parseNormalizedExtension(value: string): NormalizedExtension | null {
  const trimmed = rustTrim(value).replace(/^\.+/u, "");
  if (
    trimmed.length === 0 ||
    trimmed.length > EXTENSION_MAX_CHARS ||
    !/^[A-Za-z0-9]+$/u.test(trimmed)
  )
    return null;
  return asciiLowercase(trimmed) as NormalizedExtension;
}

function parseDisplayFilename(value: string): Checked<DisplayFilename> {
  const trimmed = rustTrim(value);
  if (
    trimmed.length === 0 ||
    codePointCount(trimmed) > DISPLAY_FILENAME_MAX_CHARS ||
    trimmed === "." ||
    trimmed === ".." ||
    hasRustControl(trimmed) ||
    /[/\\]/u.test(trimmed)
  )
    return invalid("invalid_filename", "DisplayFilename");
  return { ok: true, value: trimmed as DisplayFilename };
}

/** The trailing extension; a leading dot names a hidden file, not an extension. */
function extensionHint(name: DisplayFilename): FileExtensionHint {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { kind: "none" };
  const value = parseNormalizedExtension(name.slice(dot + 1));
  return value === null ? { kind: "none" } : { kind: "named", value };
}

function parseAttachmentId(value: string): Checked<AttachmentId> {
  const body = value.startsWith("att_") ? value.slice(4) : null;
  if (
    body === null ||
    body.length === 0 ||
    body.length > 64 ||
    !/^[0-9a-z]+$/u.test(body)
  )
    return invalid("invalid_identity", "AttachmentId");
  return { ok: true, value: value as AttachmentId };
}

export function parseOrganisationAttachmentObjectKey(
  value: string,
): Checked<OrganisationAttachmentObjectKey> {
  if (
    utf8ByteLength(value) > OBJECT_KEY_MAX_BYTES ||
    !value.startsWith(OBJECT_KEY_ROOT)
  )
    return invalid("invalid_object_key", "OrganisationAttachmentObjectKey");
  const segments = value.split("/");
  if (
    segments.length < 4 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9_.-]+$/u.test(segment),
    )
  )
    return invalid("invalid_object_key", "OrganisationAttachmentObjectKey");
  return { ok: true, value: value as OrganisationAttachmentObjectKey };
}

/** True when the key lies under `attachments/<organisationId>/`. */
export function objectKeyBelongsTo(
  key: OrganisationAttachmentObjectKey,
  organisationId: string,
): boolean {
  return key.startsWith(`${OBJECT_KEY_ROOT}${organisationId}/`);
}

/** A bounded provider identifier retained as provenance. */
function parseProvenanceIdentity<Name extends string>(
  value: string,
  field: Name,
): Checked<Brand<Name>> {
  if (
    value.length === 0 ||
    utf8ByteLength(value) > 256 ||
    value !== rustTrim(value) ||
    hasRustControl(value)
  )
    return invalid("invalid_identity", field);
  return { ok: true, value: value as Brand<Name> };
}

/** Rust `Sha256Digest::parse`: 64 ASCII hex digits, stored lowercase. */
export function parseSha256Digest(value: string): string | null {
  return value.length === 64 && /^[0-9A-Fa-f]+$/u.test(value)
    ? asciiLowercase(value)
    : null;
}

/** Commerce `IntegrationAccountId::new`: not blank and already trimmed. */
function isTrimmedIdentity(value: string): boolean {
  return rustTrim(value).length > 0 && value === rustTrim(value);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

type Established =
  | Readonly<{ kind: "signature"; method: MediaSignatureMethod }>
  | Readonly<{ kind: "declaration"; provider: MediaDeclaringProvider }>;

function isDocumentContainer(value: string): boolean {
  return (
    value === "application/pdf" ||
    value === "application/json" ||
    value === "application/xml" ||
    value ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    value === "application/vnd.oasis.opendocument.text"
  );
}

function isZipBackedDocument(value: string): boolean {
  return (
    value ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    value === "application/vnd.oasis.opendocument.text"
  );
}

function evidence<MediaType extends string>(
  mediaType: MediaType,
  established: Established,
) {
  return established.kind === "signature"
    ? {
        kind: "signature_verified" as const,
        mediaType,
        method: established.method,
      }
    : {
        kind: "provider_declared" as const,
        mediaType,
        provider: established.provider,
      };
}

/** Rust `AttachmentDescriptor::classify`. */
function classify(
  mediaType: NormalizedMediaType,
  established: Established,
  declaredMediaType: NormalizedMediaType,
): AttachmentDescriptor {
  if (mediaType.startsWith("image/"))
    return {
      kind: "image",
      media: evidence(mediaType as string as ImageMediaType, established),
    };
  if (mediaType.startsWith("text/") || isDocumentContainer(mediaType))
    return {
      kind: "document",
      media: evidence(mediaType as string as DocumentMediaType, established),
    };
  if (mediaType.startsWith("audio/"))
    return {
      kind: "audio",
      media: evidence(mediaType as string as AudioMediaType, established),
    };
  if (mediaType.startsWith("video/"))
    return {
      kind: "video",
      media: evidence(mediaType as string as VideoMediaType, established),
    };
  return {
    kind: "opaque",
    media: evidence(mediaType as string as OpaqueMediaType, established),
    formatHint: { declaredMediaType },
  };
}

const OCTET: NormalizedMediaType = OCTET_STREAM as NormalizedMediaType;

function unidentified(): AttachmentDescriptor {
  return {
    kind: "opaque",
    media: { kind: "unknown", mediaType: OCTET_STREAM },
    formatHint: { declaredMediaType: OCTET },
  };
}

function startsWith(
  header: readonly number[],
  bytes: readonly number[],
): boolean {
  if (header.length < bytes.length) return false;
  for (let index = 0; index < bytes.length; index++)
    if (header[index] !== bytes[index]) return false;
  return true;
}

function ascii(value: string): number[] {
  return Array.from(value, (character) => character.charCodeAt(0));
}

function sameBytes(
  header: readonly number[],
  start: number,
  value: string,
): boolean {
  for (let index = 0; index < value.length; index++)
    if (header[start + index] !== value.charCodeAt(index)) return false;
  return true;
}

/** Rust `identify_media_signature`: the only trusted identification input. */
function identifyMediaSignature(
  header: readonly number[],
): readonly [NormalizedMediaType, MediaSignatureMethod] | null {
  const magic = (value: string, method: MediaSignatureMethod) =>
    [value as NormalizedMediaType, method] as const;
  if (startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return magic("image/png", "magic_bytes");
  if (startsWith(header, [0xff, 0xd8, 0xff]))
    return magic("image/jpeg", "magic_bytes");
  if (
    startsWith(header, ascii("GIF87a")) ||
    startsWith(header, ascii("GIF89a"))
  )
    return magic("image/gif", "magic_bytes");
  if (startsWith(header, ascii("%PDF-")))
    return magic("application/pdf", "magic_bytes");
  if (startsWith(header, ascii("OggS")))
    return magic("audio/ogg", "magic_bytes");
  if (startsWith(header, ascii("fLaC")))
    return magic("audio/flac", "magic_bytes");
  if (
    startsWith(header, ascii("ID3")) ||
    (header.length >= 2 && header[0] === 0xff && (header[1]! & 0xe0) === 0xe0)
  )
    return magic("audio/mpeg", "magic_bytes");
  if (startsWith(header, [0x1a, 0x45, 0xdf, 0xa3]))
    return magic("video/webm", "container_structure");
  if (startsWith(header, [0x1f, 0x8b]))
    return magic("application/gzip", "magic_bytes");
  if (startsWith(header, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))
    return magic("application/x-7z-compressed", "magic_bytes");
  if (startsWith(header, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]))
    return magic("application/vnd.rar", "magic_bytes");
  // RIFF containers name their form in bytes 8..12.
  if (header.length >= 12 && startsWith(header, ascii("RIFF"))) {
    if (sameBytes(header, 8, "WEBP"))
      return magic("image/webp", "container_structure");
    if (sameBytes(header, 8, "WAVE"))
      return magic("audio/wav", "container_structure");
    if (sameBytes(header, 8, "AVI "))
      return magic("video/x-msvideo", "container_structure");
    return null;
  }
  // ISO base media files carry their brand after the box length.
  if (header.length >= 12 && sameBytes(header, 4, "ftyp")) {
    if (sameBytes(header, 8, "qt  "))
      return magic("video/quicktime", "container_structure");
    if (sameBytes(header, 8, "M4A "))
      return magic("audio/mp4", "container_structure");
    return magic("video/mp4", "container_structure");
  }
  if (startsWith(header, [0x50, 0x4b, 0x03, 0x04]))
    return magic("application/zip", "container_structure");
  return null;
}

/** Rust `classify_attachment`: signature, then declaration, then opaque. */
function classifyAttachment(
  header: readonly number[],
  declared: NormalizedMediaType | null,
  provider: MediaDeclaringProvider,
): AttachmentDescriptor {
  const signature = identifyMediaSignature(header);
  if (signature !== null) {
    const [signatureType, method] = signature;
    if (
      signatureType === "application/zip" &&
      declared !== null &&
      isZipBackedDocument(declared)
    )
      return classify(declared, { kind: "declaration", provider }, declared);
    return classify(
      signatureType,
      { kind: "signature", method },
      declared ?? OCTET,
    );
  }
  return declared === null
    ? unidentified()
    : classify(declared, { kind: "declaration", provider }, declared);
}

// ---------------------------------------------------------------------------
// Serde shapes of the boundary records
// ---------------------------------------------------------------------------

const unsigned = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const attachmentSourceCandidateSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("portal"),
      userId: Type.String(),
      conversationId: Type.String(),
      uploadId: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("slack"),
      integrationAccountId: Type.String(),
      workspaceId: Type.String(),
      channelId: Type.String(),
      messageTs: Type.String(),
      fileId: Type.String(),
      revision: Type.String(),
    },
    { additionalProperties: false },
  ),
]);
const storedMessageAttachmentCandidateSchema = Type.Object(
  {
    attachmentId: Type.String(),
    displayName: Type.String(),
    declaredMediaType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    byteLength: unsigned,
    sha256: Type.String(),
    objectKey: Type.String(),
    header: Type.Array(Type.Integer({ minimum: 0, maximum: 255 })),
    storedAt: unsigned,
    source: attachmentSourceCandidateSchema,
  },
  { additionalProperties: false },
);
const storedMessageAttachmentRecordSchema = Type.Object(
  {
    id: Type.String(),
    displayName: Type.String(),
    extensionHint: Type.Unknown(),
    descriptor: Type.Unknown(),
    byteLength: unsigned,
    sha256: Type.String(),
    objectKey: Type.String(),
    source: attachmentSourceCandidateSchema,
    retention: Type.String(),
    storedAt: unsigned,
  },
  { additionalProperties: false },
);
const userMessageRecordSchema = Type.Object(
  {
    firstPart: Type.Unknown(),
    remainingParts: Type.Array(Type.Unknown()),
  },
  { additionalProperties: false },
);
type AttachmentSourceCandidate = Static<typeof attachmentSourceCandidateSchema>;
type StoredMessageAttachmentRecord = Static<
  typeof storedMessageAttachmentRecordSchema
>;

// serde `Value` fields are present when the JSON key is present, even as null.
function hasRequiredValueFields(input: unknown, fields: readonly string[]) {
  return (
    isRecord(input) && fields.every((field) => Object.hasOwn(input, field))
  );
}

// ---------------------------------------------------------------------------
// Construction and revalidation
// ---------------------------------------------------------------------------

function parseAttachmentSource(
  candidate: AttachmentSourceCandidate,
): Checked<MessageAttachmentSource> {
  if (candidate.kind === "portal") {
    const userId = parseProvenanceIdentity(candidate.userId, "PortalUserId");
    if (!userId.ok) return userId;
    const conversationId = parseProvenanceIdentity(
      candidate.conversationId,
      "PortalConversationId",
    );
    if (!conversationId.ok) return conversationId;
    const uploadId = parseAttachmentId(candidate.uploadId);
    if (!uploadId.ok) return uploadId;
    return {
      ok: true,
      value: {
        kind: "portal",
        userId: userId.value,
        conversationId: conversationId.value,
        uploadId: uploadId.value,
      },
    };
  }
  if (!isTrimmedIdentity(candidate.integrationAccountId))
    return invalid("invalid_identity", "IntegrationAccountId");
  const workspaceId = parseProvenanceIdentity(
    candidate.workspaceId,
    "SlackWorkspaceId",
  );
  if (!workspaceId.ok) return workspaceId;
  const channelId = parseProvenanceIdentity(
    candidate.channelId,
    "SlackChannelId",
  );
  if (!channelId.ok) return channelId;
  const messageTs = parseProvenanceIdentity(
    candidate.messageTs,
    "SlackMessageTimestamp",
  );
  if (!messageTs.ok) return messageTs;
  const fileId = parseProvenanceIdentity(candidate.fileId, "SlackFileId");
  if (!fileId.ok) return fileId;
  const revision = parseProvenanceIdentity(
    candidate.revision,
    "SlackFileRevision",
  );
  if (!revision.ok) return revision;
  return {
    ok: true,
    value: {
      kind: "slack",
      integrationAccountId: candidate.integrationAccountId,
      workspaceId: workspaceId.value,
      channelId: channelId.value,
      messageTs: messageTs.value,
      fileId: fileId.value,
      revision: revision.value,
    },
  };
}

/** Rust `build_stored_message_attachment`: every untrusted claim, in order. */
export function buildStoredMessageAttachment(
  input: unknown,
): MessageParseResult<StoredMessageAttachment> {
  const admitted = admitJson(input);
  if (!admitted.ok) return admitted;
  const shape = parseShape(storedMessageAttachmentCandidateSchema, input);
  if (!shape.ok) return shape;
  const candidate = shape.value;
  const displayName = parseDisplayFilename(candidate.displayName);
  if (!displayName.ok) return displayName;
  // An unparseable provider claim is dropped, not fatal.
  const declared =
    typeof candidate.declaredMediaType === "string"
      ? parseNormalizedMediaType(candidate.declaredMediaType)
      : null;
  const declaredMediaType = declared?.ok === true ? declared.value : null;
  const source = parseAttachmentSource(candidate.source);
  if (!source.ok) return source;
  const id = parseAttachmentId(candidate.attachmentId);
  if (!id.ok) return id;
  const descriptor = classifyAttachment(
    candidate.header,
    declaredMediaType,
    source.value.kind,
  );
  const sha256 = parseSha256Digest(candidate.sha256);
  if (sha256 === null) return invalid("invalid_identity", "Sha256Digest");
  const objectKey = parseOrganisationAttachmentObjectKey(candidate.objectKey);
  if (!objectKey.ok) return objectKey;
  return {
    ok: true,
    value: {
      id: id.value,
      displayName: displayName.value,
      extensionHint: extensionHint(displayName.value),
      descriptor,
      byteLength: candidate.byteLength,
      sha256,
      objectKey: objectKey.value,
      source: source.value,
      retention: "session",
      storedAt: candidate.storedAt,
    },
  };
}

/** Rust `validate_stored_message_attachment_wasm`: a persisted row re-enters. */
export function parseStoredMessageAttachment(
  input: unknown,
): MessageParseResult<StoredMessageAttachment> {
  const admitted = admitJson(input);
  if (!admitted.ok) return admitted;
  const shape = parseShape(storedMessageAttachmentRecordSchema, input);
  if (!shape.ok) return shape;
  if (!hasRequiredValueFields(input, ["extensionHint", "descriptor"]))
    return messageShapeError();
  return storedAttachmentFromRecord(shape.value);
}

function messageShapeError(): MessageParseResult<never> {
  return { ok: false, error: messageError("invalid_request", "missing field") };
}

function storedAttachmentFromRecord(
  record: StoredMessageAttachmentRecord,
): Checked<StoredMessageAttachment> {
  if (record.retention !== "session")
    return invalid("invalid_identity", "AttachmentRetentionClass");
  const displayName = parseDisplayFilename(record.displayName);
  if (!displayName.ok) return displayName;
  const source = parseAttachmentSource(record.source);
  if (!source.ok) return source;
  const id = parseAttachmentId(record.id);
  if (!id.ok) return id;
  const descriptor = parseAttachmentDescriptor(record.descriptor);
  if (!descriptor.ok) return descriptor;
  const sha256 = parseSha256Digest(record.sha256);
  if (sha256 === null) return invalid("invalid_identity", "Sha256Digest");
  const objectKey = parseOrganisationAttachmentObjectKey(record.objectKey);
  if (!objectKey.ok) return objectKey;
  return {
    ok: true,
    value: {
      id: id.value,
      displayName: displayName.value,
      extensionHint: extensionHint(displayName.value),
      descriptor: descriptor.value,
      byteLength: record.byteLength,
      sha256,
      objectKey: objectKey.value,
      source: source.value,
      retention: "session",
      storedAt: record.storedAt,
    },
  };
}

/** serde_json `Value::get(key).and_then(Value::as_str)`. */
function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const member = value[key];
  return typeof member === "string" ? member : null;
}
function memberField(value: unknown, key: string): unknown {
  return isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function parseSignatureMethod(media: unknown): Checked<MediaSignatureMethod> {
  const method = stringField(media, "method");
  return method === "magic_bytes" || method === "container_structure"
    ? { ok: true, value: method }
    : invalid("invalid_media_type", "MediaSignatureMethod");
}

function parseDeclaringProvider(
  media: unknown,
): Checked<MediaDeclaringProvider> {
  const provider = stringField(media, "provider");
  return provider === "slack" || provider === "portal"
    ? { ok: true, value: provider }
    : invalid("invalid_identity", "MediaDeclaringProvider");
}

function parseAttachmentDescriptor(
  value: unknown,
): Checked<AttachmentDescriptor> {
  const malformed = () => invalid("invalid_media_type", "AttachmentDescriptor");
  const kind = stringField(value, "kind");
  if (kind === null) return malformed();
  const media = memberField(value, "media");
  if (media === undefined) return malformed();
  const mediaKind = stringField(media, "kind");
  if (mediaKind === null) return malformed();
  const mediaType = stringField(media, "mediaType");
  if (mediaType === null) return malformed();
  if (kind === "opaque") {
    const hint = stringField(
      memberField(value, "formatHint"),
      "declaredMediaType",
    );
    if (hint === null) return malformed();
    let opaque: OpaqueMediaEvidence;
    if (mediaKind === "unknown" && mediaType === OCTET_STREAM) {
      opaque = { kind: "unknown", mediaType: OCTET_STREAM };
    } else if (mediaKind === "signature_verified") {
      const parsed = parseNormalizedMediaType(mediaType);
      if (!parsed.ok) return parsed;
      const method = parseSignatureMethod(media);
      if (!method.ok) return method;
      opaque = {
        kind: "signature_verified",
        mediaType: parsed.value as string as OpaqueMediaType,
        method: method.value,
      };
    } else if (mediaKind === "provider_declared") {
      const parsed = parseNormalizedMediaType(mediaType);
      if (!parsed.ok) return parsed;
      const provider = parseDeclaringProvider(media);
      if (!provider.ok) return provider;
      opaque = {
        kind: "provider_declared",
        mediaType: parsed.value as string as OpaqueMediaType,
        provider: provider.value,
      };
    } else return malformed();
    const declared = parseNormalizedMediaType(hint);
    if (!declared.ok) return declared;
    return {
      ok: true,
      value: {
        kind: "opaque",
        media: opaque,
        formatHint: { declaredMediaType: declared.value },
      },
    };
  }
  let established: Established;
  if (mediaKind === "signature_verified") {
    const method = parseSignatureMethod(media);
    if (!method.ok) return method;
    established = { kind: "signature", method: method.value };
  } else if (mediaKind === "provider_declared") {
    const provider = parseDeclaringProvider(media);
    if (!provider.ok) return provider;
    established = { kind: "declaration", provider: provider.value };
  } else return malformed();
  const normalized = parseNormalizedMediaType(mediaType);
  if (!normalized.ok) return normalized;
  // The opaque hint is unused on a classified branch.
  const descriptor = classify(normalized.value, established, OCTET);
  if (
    kind !== "image" &&
    kind !== "document" &&
    kind !== "audio" &&
    kind !== "video"
  )
    return invalid("invalid_media_type", "AttachmentMediaClass");
  // Reclassification must land on the branch the record claims.
  if (descriptor.kind !== kind) return malformed();
  return { ok: true, value: descriptor };
}

function parseUserMessagePart(value: unknown): Checked<UserMessagePart> {
  const malformed = () => invalid("invalid_text", "UserMessagePart");
  switch (stringField(value, "kind")) {
    case "text": {
      const text = stringField(value, "text");
      if (text === null) return malformed();
      const parsed = parseNonEmptyText(text);
      return parsed.ok
        ? { ok: true, value: { kind: "text", text: parsed.value } }
        : parsed;
    }
    case "link": {
      const link = memberField(value, "link");
      if (link === undefined) return malformed();
      const rawUrl = stringField(link, "url");
      if (rawUrl === null) return malformed();
      const url = parseHttpUrl(rawUrl);
      if (!url.ok) return url;
      const presentation = memberField(link, "presentation");
      if (presentation === undefined) return malformed();
      switch (stringField(presentation, "kind")) {
        case "url":
          return {
            ok: true,
            value: {
              kind: "link",
              link: { url: url.value, presentation: { kind: "url" } },
            },
          };
        case "label": {
          const label = stringField(presentation, "label");
          if (label === null) return malformed();
          const parsed = parseNonEmptyText(label);
          if (!parsed.ok) return parsed;
          return {
            ok: true,
            value: {
              kind: "link",
              link: {
                url: url.value,
                presentation: { kind: "label", label: parsed.value },
              },
            },
          };
        }
        default:
          return malformed();
      }
    }
    case "attachment": {
      const attachment = memberField(value, "attachment");
      if (attachment === undefined) return malformed();
      const shape = parseShape(storedMessageAttachmentRecordSchema, attachment);
      if (
        !shape.ok ||
        !hasRequiredValueFields(attachment, ["extensionHint", "descriptor"])
      )
        return malformed();
      const parsed = storedAttachmentFromRecord(shape.value);
      return parsed.ok
        ? { ok: true, value: { kind: "attachment", attachment: parsed.value } }
        : parsed;
    }
    default:
      return malformed();
  }
}

/** Rust `parse_user_message`: a persisted message re-enters part by part. */
function parseUserMessage(input: unknown): MessageParseResult<UserMessage> {
  const admitted = admitJson(input);
  if (!admitted.ok) return admitted;
  const shape = parseShape(userMessageRecordSchema, input);
  if (!shape.ok) return shape;
  if (!hasRequiredValueFields(input, ["firstPart"])) return messageShapeError();
  const firstPart = parseUserMessagePart(shape.value.firstPart);
  if (!firstPart.ok) return firstPart;
  const remainingParts: UserMessagePart[] = [];
  for (const raw of shape.value.remainingParts) {
    const part = parseUserMessagePart(raw);
    if (!part.ok) return part;
    remainingParts.push(part.value);
  }
  return { ok: true, value: { firstPart: firstPart.value, remainingParts } };
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

type DerivedUserMessage = Readonly<{
  message: UserMessage;
  views: UserMessageViews;
}>;

/** Rust `derive_user_message_views_wasm`: one traversal for every view. */
export function deriveUserMessageViews(
  input: unknown,
): MessageParseResult<DerivedUserMessage> {
  const message = parseUserMessage(input);
  if (!message.ok) return message;
  return {
    ok: true,
    value: { message: message.value, views: userMessageViews(message.value) },
  };
}

function userMessageViews(message: UserMessage): UserMessageViews {
  return {
    modelPrompt: renderMessageForModel(message),
    casePurpose: deriveCasePurpose(message),
    contextQuery: deriveContextQuery(message),
    contentDigest: sha256HexSync(encodeUserMessageDigest(message as never)),
  };
}

function parts(message: UserMessage): UserMessagePart[] {
  return [message.firstPart, ...message.remainingParts];
}

function renderMessageForModel(message: UserMessage): string {
  return parts(message).map(renderPart).join("\n");
}

function renderPart(part: UserMessagePart): string {
  switch (part.kind) {
    case "text":
      return part.text;
    case "link":
      return part.link.presentation.kind === "label"
        ? `[link] ${part.link.presentation.label} (${part.link.url})`
        : `[link] ${part.link.url}`;
    case "attachment":
      // The view describes the message, not a read of the file: a turn that
      // reads the file gives its content beside this line.
      return attachmentManifestLine(part.attachment);
  }
}

/**
 * The one line that names a file of a message for the model: its id, name,
 * class, media type and how that type was found, size and digest. The line
 * says nothing about the content, so each caller states if it was read.
 */
export function attachmentManifestLine(
  attachment: StoredMessageAttachment,
): string {
  const media = attachment.descriptor.media;
  const identification =
    media.kind === "signature_verified"
      ? "verified from bytes"
      : media.kind === "provider_declared"
        ? "provider-declared"
        : "unidentified";
  return [
    `[attachment ${attachment.id}] ${attachment.displayName}`,
    `class=${attachment.descriptor.kind}`,
    `mediaType=${media.mediaType} (${identification})`,
    `bytes=${attachment.byteLength}`,
    `sha256=${attachment.sha256}`,
  ].join(" ");
}

function attachmentNames(message: UserMessage): string[] {
  const names: string[] = [];
  for (const part of parts(message))
    if (part.kind === "attachment") names.push(part.attachment.displayName);
  return names;
}

function deriveCasePurpose(message: UserMessage): string {
  for (const part of parts(message)) {
    if (part.kind === "text") return bounded(part.text, CASE_PURPOSE_MAX_CHARS);
    if (part.kind === "link" && part.link.presentation.kind === "label")
      return bounded(part.link.presentation.label, CASE_PURPOSE_MAX_CHARS);
  }
  const names = attachmentNames(message);
  if (names.length > 0)
    return bounded(
      `Review attached file: ${names.join(", ")}`,
      CASE_PURPOSE_MAX_CHARS,
    );
  for (const part of parts(message))
    if (part.kind === "link")
      return bounded(`Review link: ${part.link.url}`, CASE_PURPOSE_MAX_CHARS);
  return "Review this message";
}

function deriveContextQuery(message: UserMessage): string | null {
  const terms: string[] = [];
  for (const part of parts(message)) {
    if (part.kind === "text") terms.push(part.text);
    else if (part.kind === "link") {
      if (part.link.presentation.kind === "label")
        terms.push(part.link.presentation.label);
    } else terms.push(part.attachment.displayName);
  }
  if (terms.length === 0) return null;
  const query = bounded(terms.join(" "), CONTEXT_QUERY_MAX_CHARS);
  return rustTrim(query).length === 0 ? null : query;
}

/** Rust `bounded`: trim, then keep at most `maximum` code points. */
function bounded(value: string, maximum: number): string {
  const trimmed = rustTrim(value);
  if (codePointCount(trimmed) <= maximum) return trimmed;
  return Array.from(trimmed).slice(0, maximum).join("");
}
