import type {
  FrameSamplingOutcome,
  MediaMetadata,
  StoredMessageAttachment,
} from "@purin-labs/contracts";

import { inspectMediaMetadata, sampleVideoFrames } from "./media-inspect";
import {
  extractOfficeDocumentText,
  supportsOfficeExtraction,
} from "./office-document-text";
import { extractPdfText } from "./pdf-document-text";
import type { Result } from "@purin-labs/kernel/result";
import { readDerivedStills } from "./derived-stills";
import type { Variant } from "@purin-labs/type-utils";
import { sha256Hex } from "@purin-labs/std";
import { MESSAGE_ATTACHMENT_POLICY } from "@purin-labs/control-api";
import { attachmentManifestLine } from "@purin-labs/contracts/message";

/**
 * Bounded inspection of one admitted attachment.
 *
 * Every read re-verifies the organisation prefix, the object length, and the stored
 * digest before bytes leave the archive boundary, so a rewritten or
 * cross-organisation object cannot reach the model.
 *
 * The Worker extracts the text of a plain text document, a PDF, a DOCX and an
 * ODT of at most 1 MiB. It reads the container facts of audio and video, and
 * the intra-frame stills of video. A larger plain text document and the
 * keyframes of an H.264 video go to the executor when the caller holds an
 * allocation, because the executor reads nothing else. Each other file returns
 * a model-visible limitation rather than a guess: the agent is told plainly
 * that the file was stored and verified but not read.
 */

const MEDIA_HEADER_BYTES = 64 * 1024;
/** A media file is read whole, so its limit is the file limit of a message. */
const MAX_MEDIA_SOURCE_BYTES = MESSAGE_ATTACHMENT_POLICY.maxFileBytes;
export const MAX_SAMPLED_FRAMES = 12;

export const ATTACHMENT_TEXT_LIMITS = {
  maxSourceBytes: 1024 * 1024,
  maxNormalizedChars: 32_768,
} as const;

type AttachmentInspection =
  | {
      /**
       * Container facts read from the header. No frame was decoded and no
       * audio was transcribed; a field absent here was absent from the bytes.
       */
      readonly kind: "media_metadata";
      readonly attachmentId: string;
      readonly metadata: MediaMetadata;
      /**
       * Present for video. Frames are sampled at deterministic timestamps; a
       * codec that needs a decoder says so by name rather than returning
       * nothing.
       */
      readonly frames: FrameSamplingOutcome | null;
      /**
       * Stills the executor decoded when the Worker could not. Null when the
       * frames above already carry them, when no decoder was supplied, or when
       * the file is not video.
       */
      readonly decodedStills: readonly DecodedVideoStill[] | null;
      readonly manifest: string;
    }
  | {
      readonly kind: "extracted_text";
      readonly attachmentId: string;
      readonly text: string;
      readonly truncated: boolean;
      readonly sha256: string;
    }
  | {
      /**
       * The file is admitted, verified, and retained, but no preparation
       * handler can satisfy the request yet. The reason names what is missing
       * so the agent does not infer that the file is unreadable in principle.
       */
      readonly kind: "preparation_unavailable";
      readonly attachmentId: string;
      readonly mediaClass: string;
      readonly mediaType: string;
      readonly reason: "handler_not_available" | "source_too_large";
      readonly manifest: string;
    };

type AttachmentInspectionError =
  | { readonly code: "attachment_unavailable"; readonly attachmentId: string }
  | {
      readonly code: "attachment_integrity_failed";
      readonly attachmentId: string;
    }
  | {
      readonly code: "attachment_not_in_organisation";
      readonly attachmentId: string;
    };

const TEXTUAL_DOCUMENT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/xml",
  "text/xml",
]);

/**
 * Reads a document too large for the Worker by handing it to the executor.
 *
 * Supplied only where an executor allocation is already held. Without one the
 * oversized case stays a stated limitation rather than silently becoming a
 * second allocation the budget never approved.
 */
type OversizedDocumentReader = (
  attachment: StoredMessageAttachment,
  bytes: Uint8Array,
) => Promise<{ readonly text: string; readonly truncated: boolean } | null>;

/** A still the executor decoded, with its bytes rather than a source offset. */
export type DecodedVideoStill = {
  readonly timestampMs: number;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
};

/**
 * Decodes keyframes the Worker cannot, by handing the file to the executor.
 *
 * Supplied only where an executor allocation is already held. Without one the
 * codec limitation stays stated — `decoder_required`, naming the codec —
 * rather than silently taking an allocation the budget never approved.
 */
type VideoFrameDecoder = (
  attachment: StoredMessageAttachment,
  bytes: Uint8Array,
) => Promise<readonly DecodedVideoStill[] | null>;

/** The sampling policy the executor decodes under; derived stills are keyed by it. */
export const FRAME_SAMPLING_POLICY_REVISION = "plan37.frames.v1";

declare const verifiedAttachmentBytes: unique symbol;

/**
 * An attachment's bytes after `readVerifiedAttachment` compared them with the
 * record's length and digest.
 */
export type VerifiedAttachmentBytes = Uint8Array & {
  readonly [verifiedAttachmentBytes]: true;
};

type AttachmentInspectionInput = Readonly<{
  readonly archive: R2Bucket;
  readonly organisationId: string;
  readonly attachment: StoredMessageAttachment;
  /**
   * The attachment's bytes, when the caller has read and verified them. The
   * inspection then reads the object from the archive no second time.
   */
  readonly verified?: VerifiedAttachmentBytes;
  readonly readOversizedDocument?: OversizedDocumentReader;
  readonly decodeVideoFrames?: VideoFrameDecoder;
}>;

/**
 * Whether the inspection of this attachment can call the executor: for the
 * frames of a video, and for a plain text document that is too large to read
 * here. The inspection of every other attachment uses only its own bytes.
 */
export function inspectionMayUseExecutor(
  attachment: StoredMessageAttachment,
): boolean {
  return (
    attachment.descriptor.kind === "video" ||
    (executorReadsDocument(attachment) &&
      attachment.byteLength > ATTACHMENT_TEXT_LIMITS.maxSourceBytes)
  );
}

/**
 * The executor reads plain text only. A larger PDF, DOCX or ODT would take
 * an allocation for a refusal, so it is stated as too large here.
 */
function executorReadsDocument(attachment: StoredMessageAttachment): boolean {
  return (
    attachment.descriptor.kind === "document" &&
    TEXTUAL_DOCUMENT_TYPES.has(String(attachment.descriptor.media.mediaType))
  );
}

/** The executor decodes the keyframes of H.264 only. */
const EXECUTOR_VIDEO_CODECS = new Set(["avc1", "avc3"]);

export async function inspectMessageAttachment(
  input: AttachmentInspectionInput,
): Promise<Result<AttachmentInspection, AttachmentInspectionError>> {
  const { attachment } = input;
  const attachmentId = String(attachment.id);

  if (
    !String(attachment.objectKey).startsWith(
      `attachments/${input.organisationId}/`,
    )
  ) {
    return {
      ok: false,
      error: { code: "attachment_not_in_organisation", attachmentId },
    };
  }

  const mediaClass = attachment.descriptor.kind;

  if (mediaClass === "audio" || mediaClass === "video") {
    return inspectMediaAttachment(input);
  }

  return inspectDocumentAttachment(input);
}

async function inspectMediaAttachment(
  input: AttachmentInspectionInput,
): Promise<Result<AttachmentInspection, AttachmentInspectionError>> {
  const { attachment } = input;

  // A ranged read cannot prove the stored digest, so media inspection verifies
  // the complete object before reading its header or sampling frames.
  if (attachment.byteLength > MAX_MEDIA_SOURCE_BYTES) {
    return preparationUnavailable(attachment, "source_too_large");
  }

  const verified = await verifiedObject(input);

  if (!verified.ok) {
    return verified;
  }

  let frames: FrameSamplingOutcome | null = null;

  if (attachment.descriptor.kind === "video") {
    frames = sampleVideoFrames(verified.value, MAX_SAMPLED_FRAMES);
  }

  let decodedStills: readonly DecodedVideoStill[] | null = null;

  if (frames !== null) {
    decodedStills = await decodeIfRequired({
      archive: input.archive,
      organisationId: input.organisationId,
      attachment,
      bytes: verified.value,
      sampled: frames,
      decode: input.decodeVideoFrames,
    });
  }

  return {
    ok: true,
    value: {
      kind: "media_metadata",
      attachmentId: String(attachment.id),
      metadata: inspectMediaMetadata(
        verified.value.slice(0, MEDIA_HEADER_BYTES),
      ),
      frames,
      decodedStills,
      manifest: attachmentManifestLine(attachment),
    },
  };
}

async function inspectDocumentAttachment(
  input: AttachmentInspectionInput,
): Promise<Result<AttachmentInspection, AttachmentInspectionError>> {
  const { attachment } = input;
  const attachmentId = String(attachment.id);
  const mediaType = String(attachment.descriptor.media.mediaType);

  if (!canExtractHere(attachment)) {
    return preparationUnavailable(attachment, "handler_not_available");
  }

  if (attachment.byteLength > ATTACHMENT_TEXT_LIMITS.maxSourceBytes) {
    // Too large to read here. The executor can read it when the caller already
    // holds an allocation; otherwise the limit is stated rather than guessed at.
    const delegated =
      input.readOversizedDocument === undefined ||
      !executorReadsDocument(attachment)
        ? null
        : await readForExecutor(input, input.readOversizedDocument);

    if (delegated !== null) {
      return {
        ok: true,
        value: {
          kind: "extracted_text",
          attachmentId,
          text: delegated.text,
          truncated: delegated.truncated,
          sha256: String(attachment.sha256),
        },
      };
    }

    return preparationUnavailable(attachment, "source_too_large");
  }

  const verifiedDocument = await verifiedObject(input);

  if (!verifiedDocument.ok) {
    return verifiedDocument;
  }

  const extracted = await extractDocumentText(
    verifiedDocument.value,
    mediaType,
  );

  if (!extracted.ok) {
    return preparationUnavailable(attachment, "handler_not_available");
  }

  const normalized = extracted.value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .trim();
  const truncated =
    normalized.length > ATTACHMENT_TEXT_LIMITS.maxNormalizedChars;

  return {
    ok: true,
    value: {
      kind: "extracted_text",
      attachmentId,
      text: truncated
        ? normalized.slice(0, ATTACHMENT_TEXT_LIMITS.maxNormalizedChars)
        : normalized,
      truncated,
      // Extracted text carries its source digest, so a quotation can always be
      // traced back to the exact bytes it came from.
      sha256: String(attachment.sha256),
    },
  };
}

async function extractDocumentText(
  bytes: Uint8Array,
  mediaType: string,
): Promise<Result<string, null>> {
  if (supportsOfficeExtraction(mediaType)) {
    const extracted = await extractOfficeDocumentText(bytes, mediaType);
    return extracted.ok ? extracted : { ok: false, error: null };
  }

  if (mediaType === "application/pdf") {
    const extracted = await extractPdfText(bytes);
    return extracted.ok ? extracted : { ok: false, error: null };
  }

  return { ok: true, value: new TextDecoder("utf-8").decode(bytes) };
}

function preparationUnavailable(
  attachment: StoredMessageAttachment,
  reason: Variant<AttachmentInspection, "preparation_unavailable">["reason"],
): Result<AttachmentInspection, AttachmentInspectionError> {
  return {
    ok: true,
    value: {
      kind: "preparation_unavailable",
      attachmentId: String(attachment.id),
      mediaClass: attachment.descriptor.kind,
      mediaType: String(attachment.descriptor.media.mediaType),
      reason,
      manifest: attachmentManifestLine(attachment),
    },
  };
}

/**
 * Delegates to the executor only when the Worker's own sampling could not
 * produce stills — an inter-frame codec — and only when a decoder was supplied.
 * Motion JPEG never leaves the Worker; a decoder for it would be wasted work.
 */
async function decodeIfRequired(input: {
  readonly archive: R2Bucket;
  readonly organisationId: string;
  readonly attachment: StoredMessageAttachment;
  readonly bytes: Uint8Array;
  readonly sampled: FrameSamplingOutcome;
  readonly decode: VideoFrameDecoder | undefined;
}): Promise<readonly DecodedVideoStill[] | null> {
  if (
    input.sampled.kind !== "decoder_required" ||
    !EXECUTOR_VIDEO_CODECS.has(input.sampled.codec)
  ) {
    return null;
  }

  // Stills decoded on an earlier turn are durable and content-addressed.
  // Reading them needs no allocation, so they are the first place to look —
  // and the only place materialization can look, having no lease.
  const derived = await readDerivedStills({
    archive: input.archive,
    organisationId: input.organisationId,
    attachment: input.attachment,
    policyRevision: FRAME_SAMPLING_POLICY_REVISION,
  });

  if (derived !== null) {
    return derived;
  }

  return input.decode === undefined
    ? null
    : input.decode(input.attachment, input.bytes);
}

/**
 * Verifies the object, then hands it to the executor reader.
 *
 * The digest is checked here as well as in the container. The container proves
 * the bytes it received match the request; this proves the request described
 * the bytes that were stored.
 */
async function readForExecutor(
  input: AttachmentInspectionInput,
  read: OversizedDocumentReader,
): Promise<{ readonly text: string; readonly truncated: boolean } | null> {
  const verified = await verifiedObject(input);

  return verified.ok ? read(input.attachment, verified.value) : null;
}

/** The caller's verified bytes, or the object read and verified here. */
async function verifiedObject(
  input: AttachmentInspectionInput,
): Promise<Result<VerifiedAttachmentBytes, AttachmentInspectionError>> {
  return input.verified === undefined
    ? readVerifiedAttachment(input.archive, input.attachment)
    : { ok: true, value: input.verified };
}

/**
 * Reads an object's bytes after proving they are the bytes the record names.
 *
 * Organisation prefix, object length, and stored digest are all checked before any
 * byte is interpreted, so a rewritten, truncated, or cross-organisation object cannot
 * reach a parser.
 */
export async function readVerifiedAttachment(
  archive: R2Bucket,
  attachment: StoredMessageAttachment,
): Promise<Result<VerifiedAttachmentBytes, AttachmentInspectionError>> {
  const attachmentId = String(attachment.id);
  let bytes: Uint8Array;

  try {
    const object = await archive.get(String(attachment.objectKey));

    if (object === null || object.size !== attachment.byteLength) {
      return {
        ok: false,
        error: { code: "attachment_unavailable", attachmentId },
      };
    }

    bytes = new Uint8Array(await object.arrayBuffer());
  } catch {
    return {
      ok: false,
      error: { code: "attachment_unavailable", attachmentId },
    };
  }

  if (
    bytes.byteLength !== attachment.byteLength ||
    (await sha256Hex(bytes)) !== String(attachment.sha256)
  ) {
    return {
      ok: false,
      error: { code: "attachment_integrity_failed", attachmentId },
    };
  }

  return { ok: true, value: bytes as VerifiedAttachmentBytes };
}

/** True only for formats whose bytes are already text. */
function canExtractHere(attachment: StoredMessageAttachment): boolean {
  if (attachment.descriptor.kind !== "document") {
    return false;
  }

  const mediaType = String(attachment.descriptor.media.mediaType);

  return (
    TEXTUAL_DOCUMENT_TYPES.has(mediaType) ||
    supportsOfficeExtraction(mediaType) ||
    mediaType === "application/pdf"
  );
}
