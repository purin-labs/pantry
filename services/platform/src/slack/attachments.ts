import { RequestDeadline } from "../request-deadline";
import { runtimeFetch } from "../runtime-fetch";
import type { StoredMessageAttachment } from "@seams/contracts";

import {
  newRequestId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../ids";
import { MESSAGE_ATTACHMENT_POLICY } from "@seams/control-api";
import { buildStoredMessageAttachment } from "../messages/message-wasm";
import { traceLog } from "../observability";
import type { Result } from "../result";
import type { SlackHostedFileMetadata, SlackMessageEvent } from "./events";
import { isRecord, sha256Hex } from "@seams/std";
/**
 * A permanent refusal. Every variant names the rule that was applied and the
 * value that broke it, so the Connector's user-visible notice can say exactly
 * what happened without re-deriving it.
 */
export type AttachmentRejection =
  | {
      readonly code: "file_count_exceeded";
      readonly limit: number;
      readonly observed: number;
    }
  | {
      readonly code: "file_too_large";
      readonly fileId: string;
      readonly limitBytes: number;
      readonly observedBytes: number;
    }
  | {
      readonly code: "batch_too_large";
      readonly limitBytes: number;
      readonly observedBytes: number;
    }
  | { readonly code: "declared_size_invalid"; readonly fileId: string }
  | {
      readonly code: "byte_length_mismatch";
      readonly fileId: string;
      readonly declared: number;
      readonly observed: number;
    }
  | {
      readonly code: "contract_rejected";
      readonly fileId: string;
      readonly reason: string;
    }
  | { readonly code: "download_rejected"; readonly fileId: string };

/** A transient failure. The Connector retries the exact batch. */
export type AttachmentFailure =
  | { readonly code: "provider_unavailable"; readonly fileId: string | null }
  | { readonly code: "storage_unavailable"; readonly fileId: string | null };

/**
 * One message's attachments are atomic for agent admission: either every file
 * is committed, or the agent sees none of them.
 */
export type SlackAttachmentBatch =
  | {
      readonly state: "committed";
      readonly attachments: readonly StoredMessageAttachment[];
    }
  | { readonly state: "retryable_failure"; readonly failure: AttachmentFailure }
  | { readonly state: "rejected"; readonly rejection: AttachmentRejection };

export type SlackAttachmentBatchInput = {
  readonly bucket: R2Bucket;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly event: SlackMessageEvent;
  readonly token: string;
  readonly now: number;
  readonly fetcher?: typeof fetch;
};

type SlackFileDownload = {
  readonly url: URL;
  readonly displayName: string;
  readonly declaredMediaType: string | null;
  readonly byteLength: number;
};

type SlackFileInfoError =
  | { readonly kind: "rejected"; readonly rejection: AttachmentRejection }
  | { readonly kind: "retryable"; readonly failure: AttachmentFailure };

type DownloadedObject = {
  readonly bytes: Uint8Array;
  readonly sha256: string;
};

const SLACK_FILE_INFO_URL = "https://slack.com/api/files.info";
const SLACK_CONVERSATIONS_REPLIES_URL =
  "https://slack.com/api/conversations.replies";
const SLACK_FILE_HOST = "files.slack.com";
/** The declared bytes that one group of files may hold in memory together. */
const CONCURRENT_ACQUISITION_BYTES = 16 * 1024 * 1024;

/**
 * Acquires every hosted file on a message under the batch protocol.
 *
 * Published content objects are content-addressed and may already be
 * referenced by another message, so a failed batch leaves them to reachability
 * cleanup rather than deleting bytes something else owns.
 */
export async function acquireSlackAttachmentBatch(
  input: SlackAttachmentBatchInput,
): Promise<SlackAttachmentBatch> {
  const files = await resolveSlackHostedFiles(input);

  if (!files.ok) {
    return { state: "retryable_failure", failure: files.error };
  }

  const limits = checkDeclaredLimits(files.value);

  if (limits !== null) {
    return { state: "rejected", rejection: limits };
  }

  const attachments: StoredMessageAttachment[] = [];

  // The files of a group are acquired together. The first file, in the order
  // of the message, that is not committed ends the batch, as it did when the
  // files were acquired one after another. Files after it in its group were
  // acquired too: a retry of the batch reuses them.
  for (const group of acquisitionGroups(files.value)) {
    const settled = await Promise.allSettled(
      group.map(acquireSlackAttachment.bind(null, input)),
    );

    for (const acquired of settled) {
      if (acquired.status === "rejected") {
        throw acquired.reason;
      }

      if (acquired.value.state !== "committed") {
        return acquired.value;
      }

      attachments.push(acquired.value.attachment);
    }
  }

  return { state: "committed", attachments };
}

/**
 * The files of a message in groups that are acquired together. A group holds
 * the bytes of all its files in memory at the same time, so its declared
 * bytes are bounded. A larger file is a group of its own.
 */
function acquisitionGroups(
  files: readonly SlackHostedFileMetadata[],
): SlackHostedFileMetadata[][] {
  const groups: SlackHostedFileMetadata[][] = [];
  let group: SlackHostedFileMetadata[] = [];
  let groupBytes = 0;

  for (const file of files) {
    if (
      group.length > 0 &&
      groupBytes + file.declaredByteLength > CONCURRENT_ACQUISITION_BYTES
    ) {
      groups.push(group);
      group = [];
      groupBytes = 0;
    }

    group.push(file);
    groupBytes += file.declaredByteLength;
  }

  if (group.length > 0) {
    groups.push(group);
  }

  return groups;
}

/**
 * Reduces the delivered file candidates to the hosted files this adapter can
 * admit.
 *
 * A `needs_info` placeholder — a Slack Connect delivery, or metadata too
 * incomplete to trust — is completed from the exact addressed message rather
 * than dropped. A `remote_link` is not Slack-hosted, so it never becomes
 * admitted bytes; it survives as a link part on the canonical message.
 */
async function resolveSlackHostedFiles(
  input: SlackAttachmentBatchInput,
): Promise<Result<readonly SlackHostedFileMetadata[], AttachmentFailure>> {
  const hosted: SlackHostedFileMetadata[] = [];
  let placeholders = false;

  for (const candidate of input.event.files) {
    switch (candidate.kind) {
      case "hosted":
        hosted.push(candidate.file);
        break;
      case "needs_info":
        placeholders = true;
        break;
      case "remote_link":
        break;
      default:
        return assertNeverFileCandidate(candidate);
    }
  }

  if (!placeholders && hosted.length > 0) {
    return { ok: true, value: hosted };
  }

  if (!placeholders && input.event.files.length > 0) {
    // Every candidate was a remote link: nothing to admit as bytes.
    return { ok: true, value: [] };
  }

  return hydrateSlackMessageFiles(input);
}

function assertNeverFileCandidate(value: never): never {
  throw new Error(`Unhandled Slack file candidate: ${JSON.stringify(value)}`);
}

function checkDeclaredLimits(
  files: readonly SlackHostedFileMetadata[],
): AttachmentRejection | null {
  if (files.length > MESSAGE_ATTACHMENT_POLICY.maxFilesPerMessage) {
    return {
      code: "file_count_exceeded",
      limit: MESSAGE_ATTACHMENT_POLICY.maxFilesPerMessage,
      observed: files.length,
    };
  }

  let total = 0;

  for (const file of files) {
    if (file.declaredByteLength > MESSAGE_ATTACHMENT_POLICY.maxFileBytes) {
      return {
        code: "file_too_large",
        fileId: file.fileId,
        limitBytes: MESSAGE_ATTACHMENT_POLICY.maxFileBytes,
        observedBytes: file.declaredByteLength,
      };
    }

    total += file.declaredByteLength;
  }

  return total > MESSAGE_ATTACHMENT_POLICY.maxBatchBytes
    ? {
        code: "batch_too_large",
        limitBytes: MESSAGE_ATTACHMENT_POLICY.maxBatchBytes,
        observedBytes: total,
      }
    : null;
}

type SlackAttachmentOutcome =
  | {
      readonly state: "committed";
      readonly attachment: StoredMessageAttachment;
    }
  | { readonly state: "retryable_failure"; readonly failure: AttachmentFailure }
  | { readonly state: "rejected"; readonly rejection: AttachmentRejection };

async function acquireSlackAttachment(
  input: SlackAttachmentBatchInput,
  file: SlackHostedFileMetadata,
): Promise<SlackAttachmentOutcome> {
  const sourceKey = await slackSourceReferenceKey(input, file);
  const startedAt = Date.now();
  const reused = await reuseCommittedRevision(input, file, sourceKey);
  const reuseCheckedAt = Date.now();

  if (reused !== null) {
    return reused;
  }

  const info = await readSlackFileInfo(input, file);
  const infoReadAt = Date.now();

  if (!info.ok) {
    return info.error.kind === "rejected"
      ? { state: "rejected", rejection: info.error.rejection }
      : { state: "retryable_failure", failure: info.error.failure };
  }

  const downloaded = await downloadSlackFile(input, info.value, file);
  const downloadedAt = Date.now();

  if (!downloaded.ok) {
    return downloaded.error.kind === "rejected"
      ? { state: "rejected", rejection: downloaded.error.rejection }
      : { state: "retryable_failure", failure: downloaded.error.failure };
  }

  if (downloaded.value.bytes.byteLength !== info.value.byteLength) {
    return {
      state: "rejected",
      rejection: {
        code: "byte_length_mismatch",
        fileId: file.fileId,
        declared: info.value.byteLength,
        observed: downloaded.value.bytes.byteLength,
      },
    };
  }

  const contentKey = contentObjectKey(
    input.organisationId,
    downloaded.value.sha256,
  );
  const attachment = buildAttachment(
    input,
    file,
    info.value,
    downloaded.value,
    contentKey,
  );

  if (!attachment.ok) {
    return {
      state: "rejected",
      rejection: {
        code: "contract_rejected",
        fileId: file.fileId,
        reason: attachment.error.reason,
      },
    };
  }

  try {
    // The two writes run together. A pointer whose content is missing is not
    // reused: `reuseCommittedRevision` reads the content and acquires the file
    // again when it is absent.
    await Promise.all([
      // Content-addressed: an identical object published by another message
      // is already correct, so publishing is idempotent rather than
      // conditional.
      input.bucket.put(contentKey, downloaded.value.bytes, {
        httpMetadata: {
          contentType: attachment.value.descriptor.media.mediaType,
        },
        customMetadata: contentObjectMetadata(
          input.organisationId,
          attachment.value,
        ),
      }),
      input.bucket.put(sourceKey, new Uint8Array(), {
        customMetadata: {
          organisationId: input.organisationId,
          contentKey,
          sha256: downloaded.value.sha256,
          byteLength: String(downloaded.value.bytes.byteLength),
          displayName: info.value.displayName,
          declaredMediaType: info.value.declaredMediaType ?? "",
          storedAt: String(input.now),
        },
      }),
    ]);
  } catch {
    return {
      state: "retryable_failure",
      failure: { code: "storage_unavailable", fileId: file.fileId },
    };
  }

  traceLog("slack.attachment_acquisition_timing", {
    requestId: newRequestId(),
    organisation_id: input.organisationId,
    byte_length: downloaded.value.bytes.byteLength,
    reuse_check_ms: reuseCheckedAt - startedAt,
    file_info_ms: infoReadAt - reuseCheckedAt,
    download_ms: downloadedAt - infoReadAt,
    archive_write_ms: Date.now() - downloadedAt,
  });

  return { state: "committed", attachment: attachment.value };
}

/**
 * Returns the already committed attachment for this exact source revision.
 *
 * Bytes are not re-transferred, but the object is re-read and re-classified
 * from its own leading bytes, so a reused acquisition is verified rather than
 * trusted from metadata.
 */
async function reuseCommittedRevision(
  input: SlackAttachmentBatchInput,
  file: SlackHostedFileMetadata,
  sourceKey: string,
): Promise<SlackAttachmentOutcome | null> {
  let pointer: R2Object | null;

  try {
    pointer = await input.bucket.head(sourceKey);
  } catch {
    return {
      state: "retryable_failure",
      failure: { code: "storage_unavailable", fileId: file.fileId },
    };
  }

  const metadata = pointer?.customMetadata;

  if (pointer === null || metadata === undefined) {
    return null;
  }

  const contentKey = metadata.contentKey;
  const sha256 = metadata.sha256;
  const byteLength = Number(metadata.byteLength);
  const storedAt = Number(metadata.storedAt);

  if (
    typeof contentKey !== "string" ||
    !contentKey.startsWith(`attachments/${input.organisationId}/`) ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(sha256) ||
    !Number.isSafeInteger(byteLength) ||
    byteLength <= 0 ||
    !Number.isSafeInteger(storedAt)
  ) {
    return null;
  }

  let header: Uint8Array;

  try {
    const object = await input.bucket.get(contentKey, {
      range: {
        offset: 0,
        length: MESSAGE_ATTACHMENT_POLICY.signatureHeaderBytes,
      },
    });

    if (object === null) {
      return null;
    }

    header = new Uint8Array(await object.arrayBuffer());
  } catch {
    return {
      state: "retryable_failure",
      failure: { code: "storage_unavailable", fileId: file.fileId },
    };
  }

  const declaredMediaType = metadata.declaredMediaType;
  const attachment = buildStoredMessageAttachment({
    // Content-addressed, so the same bytes carry the same identity whether they
    // were just transferred or reused from a previous acquisition.
    attachmentId: attachmentIdFromDigest(sha256),
    displayName:
      typeof metadata.displayName === "string"
        ? metadata.displayName
        : file.displayName,
    declaredMediaType:
      typeof declaredMediaType === "string" && declaredMediaType.length > 0
        ? declaredMediaType
        : null,
    byteLength,
    sha256,
    objectKey: contentKey,
    header: Array.from(header),
    storedAt,
    source: provenance(input, file),
  });

  return attachment.ok
    ? { state: "committed", attachment: attachment.value }
    : null;
}

function buildAttachment(
  input: SlackAttachmentBatchInput,
  file: SlackHostedFileMetadata,
  info: SlackFileDownload,
  downloaded: DownloadedObject,
  contentKey: string,
): ReturnType<typeof buildStoredMessageAttachment> {
  return buildStoredMessageAttachment({
    attachmentId: attachmentIdFromDigest(downloaded.sha256),
    displayName: info.displayName,
    declaredMediaType: info.declaredMediaType,
    byteLength: downloaded.bytes.byteLength,
    sha256: downloaded.sha256,
    objectKey: contentKey,
    header: Array.from(
      downloaded.bytes.slice(0, MESSAGE_ATTACHMENT_POLICY.signatureHeaderBytes),
    ),
    storedAt: input.now,
    source: provenance(input, file),
  });
}

function provenance(
  input: SlackAttachmentBatchInput,
  file: SlackHostedFileMetadata,
) {
  return {
    kind: "slack" as const,
    integrationAccountId: input.integrationAccountId,
    workspaceId: input.event.workspaceId,
    channelId: input.event.channelId,
    messageTs: input.event.messageTs,
    fileId: file.fileId,
    revision: file.revision,
  };
}

function contentObjectMetadata(
  organisationId: OrganisationId,
  attachment: StoredMessageAttachment,
): Record<string, string> {
  return {
    organisationId,
    attachmentId: attachment.id,
    mediaClass: attachment.descriptor.kind,
    mediaType: attachment.descriptor.media.mediaType,
    identification: attachment.descriptor.media.kind,
    retention: attachment.retention,
    byteLength: String(attachment.byteLength),
    sha256: attachment.sha256,
    sourceKind: attachment.source.kind,
  };
}

function contentObjectKey(
  organisationId: OrganisationId,
  sha256: string,
): string {
  return `attachments/${organisationId}/slack/${sha256}`;
}

async function slackSourceReferenceKey(
  input: SlackAttachmentBatchInput,
  file: SlackHostedFileMetadata,
): Promise<string> {
  const digest = await sha256Hex(
    new TextEncoder().encode(
      `${input.organisationId}:${input.event.workspaceId}:${file.fileId}:${file.revision}`,
    ),
  );

  return `attachments/${input.organisationId}/slackref/${digest}`;
}

function attachmentIdFromDigest(sha256: string): string {
  return `att_${sha256.slice(0, 32)}`;
}

async function hydrateSlackMessageFiles(
  input: SlackAttachmentBatchInput,
): Promise<Result<readonly SlackHostedFileMetadata[], AttachmentFailure>> {
  const url = new URL(SLACK_CONVERSATIONS_REPLIES_URL);

  url.searchParams.set("channel", input.event.channelId);
  url.searchParams.set("ts", input.event.threadTs);
  url.searchParams.set("oldest", input.event.messageTs);
  url.searchParams.set("latest", input.event.messageTs);
  url.searchParams.set("inclusive", "true");
  url.searchParams.set("limit", "1");

  const deadline = new RequestDeadline(
    MESSAGE_ATTACHMENT_POLICY.downloadTimeoutMs,
  );
  let response: Response;
  let raw: unknown;

  try {
    response = await (input.fetcher ?? runtimeFetch)(url, {
      headers: { authorization: `Bearer ${input.token}` },
      redirect: "manual",
      signal: deadline.signal,
    });
    raw = await response.json().catch(readJsonFailure);
  } catch {
    return { ok: false, error: { code: "provider_unavailable", fileId: null } };
  } finally {
    deadline.end();
  }

  if (
    !response.ok ||
    !isRecord(raw) ||
    raw.ok !== true ||
    !Array.isArray(raw.messages)
  ) {
    return { ok: false, error: { code: "provider_unavailable", fileId: null } };
  }

  const message = findSlackMessageAtTimestamp(
    raw.messages,
    input.event.messageTs,
  );

  if (message === null) {
    return { ok: true, value: [] };
  }

  const hosted: SlackHostedFileMetadata[] = [];
  const rawFiles = message.files;

  if (!Array.isArray(rawFiles)) {
    return { ok: true, value: [] };
  }

  for (const rawFile of rawFiles) {
    const parsed = parseHydratedSlackFile(rawFile, input.event.messageTs);

    if (parsed !== null) {
      hosted.push(parsed);
    }
  }

  return { ok: true, value: hosted };
}

function parseHydratedSlackFile(
  raw: unknown,
  messageTs: string,
): SlackHostedFileMetadata | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0) {
    return null;
  }

  const displayName = raw.name;
  const declaredMediaType = raw.mimetype;
  const declaredByteLength = raw.size;

  if (
    typeof displayName !== "string" ||
    displayName.length === 0 ||
    typeof declaredMediaType !== "string" ||
    declaredMediaType.length === 0 ||
    !Number.isSafeInteger(declaredByteLength) ||
    Number(declaredByteLength) <= 0
  ) {
    return null;
  }

  const timestamp = raw.timestamp;

  return {
    fileId: raw.id,
    displayName,
    declaredMediaType,
    declaredByteLength: Number(declaredByteLength),
    revision:
      typeof timestamp === "number" &&
      Number.isSafeInteger(timestamp) &&
      timestamp > 0
        ? String(timestamp)
        : messageTs,
  };
}

function findSlackMessageAtTimestamp(
  messages: readonly unknown[],
  messageTs: string,
): Record<string, unknown> | null {
  for (const message of messages) {
    if (isRecord(message) && message.ts === messageTs) {
      return message;
    }
  }

  return null;
}

async function readSlackFileInfo(
  input: SlackAttachmentBatchInput,
  file: SlackHostedFileMetadata,
): Promise<Result<SlackFileDownload, SlackFileInfoError>> {
  if (
    file.declaredByteLength <= 0 ||
    file.declaredByteLength > MESSAGE_ATTACHMENT_POLICY.maxFileBytes
  ) {
    return {
      ok: false,
      error: {
        kind: "rejected",
        rejection: { code: "declared_size_invalid", fileId: file.fileId },
      },
    };
  }

  const url = new URL(SLACK_FILE_INFO_URL);

  url.searchParams.set("file", file.fileId);

  const deadline = new RequestDeadline(
    MESSAGE_ATTACHMENT_POLICY.downloadTimeoutMs,
  );
  let response: Response;
  let raw: unknown;

  try {
    response = await (input.fetcher ?? runtimeFetch)(url, {
      headers: { authorization: `Bearer ${input.token}` },
      redirect: "manual",
      signal: deadline.signal,
    });
    raw = await response.json().catch(readJsonFailure);
  } catch {
    return providerUnavailable(file);
  } finally {
    deadline.end();
  }

  if (
    !response.ok ||
    !isRecord(raw) ||
    raw.ok !== true ||
    !isRecord(raw.file) ||
    raw.file.id !== file.fileId
  ) {
    return providerUnavailable(file);
  }

  const byteLength = raw.file.size;
  const displayName = raw.file.name;
  const rawUrl =
    typeof raw.file.url_private_download === "string"
      ? raw.file.url_private_download
      : raw.file.url_private;

  if (
    !Number.isSafeInteger(byteLength) ||
    Number(byteLength) <= 0 ||
    Number(byteLength) > MESSAGE_ATTACHMENT_POLICY.maxFileBytes ||
    typeof displayName !== "string" ||
    displayName.length === 0 ||
    typeof rawUrl !== "string"
  ) {
    return {
      ok: false,
      error: {
        kind: "rejected",
        rejection: { code: "declared_size_invalid", fileId: file.fileId },
      },
    };
  }

  const downloadUrl = parseSlackFileUrl(rawUrl);

  if (downloadUrl === null) {
    return {
      ok: false,
      error: {
        kind: "rejected",
        rejection: { code: "download_rejected", fileId: file.fileId },
      },
    };
  }

  return {
    ok: true,
    value: {
      url: downloadUrl,
      displayName,
      // Slack's claim is retained and passed on as a claim. The bytes decide.
      declaredMediaType:
        typeof raw.file.mimetype === "string" ? raw.file.mimetype : null,
      byteLength: Number(byteLength),
    },
  };
}

function providerUnavailable(
  file: SlackHostedFileMetadata,
): Result<never, SlackFileInfoError> {
  return {
    ok: false,
    error: {
      kind: "retryable",
      failure: { code: "provider_unavailable", fileId: file.fileId },
    },
  };
}

async function downloadSlackFile(
  input: SlackAttachmentBatchInput,
  info: SlackFileDownload,
  file: SlackHostedFileMetadata,
): Promise<Result<DownloadedObject, SlackFileInfoError>> {
  // One deadline covers the redirects and the body, and ends with them.
  const deadline = new RequestDeadline(
    MESSAGE_ATTACHMENT_POLICY.downloadTimeoutMs,
  );
  try {
    return await downloadSlackFileWithin(input, info, file, deadline.signal);
  } finally {
    deadline.end();
  }
}

async function downloadSlackFileWithin(
  input: SlackAttachmentBatchInput,
  info: SlackFileDownload,
  file: SlackHostedFileMetadata,
  signal: AbortSignal,
): Promise<Result<DownloadedObject, SlackFileInfoError>> {
  let response: Response;

  try {
    response = await fetchSlackFile(
      input.fetcher ?? runtimeFetch,
      input.token,
      info.url,
      MESSAGE_ATTACHMENT_POLICY.maxRedirects,
      signal,
    );
  } catch {
    return {
      ok: false,
      error: {
        kind: "rejected",
        rejection: { code: "download_rejected", fileId: file.fileId },
      },
    };
  }

  const declaredLength = parseContentLength(
    response.headers.get("content-length"),
  );

  if (
    declaredLength !== null &&
    declaredLength > MESSAGE_ATTACHMENT_POLICY.maxFileBytes
  ) {
    return {
      ok: false,
      error: {
        kind: "rejected",
        rejection: {
          code: "file_too_large",
          fileId: file.fileId,
          limitBytes: MESSAGE_ATTACHMENT_POLICY.maxFileBytes,
          observedBytes: declaredLength,
        },
      },
    };
  }

  if (!response.ok || response.body === null) {
    return providerUnavailable(file);
  }

  let bytes: Uint8Array;

  try {
    const bounded = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>(
        new BoundedByteTransformer(MESSAGE_ATTACHMENT_POLICY.maxFileBytes),
      ),
    );

    bytes = new Uint8Array(await new Response(bounded).arrayBuffer());
  } catch (error) {
    return error instanceof DownloadLimitError
      ? {
          ok: false,
          error: {
            kind: "rejected",
            rejection: {
              code: "file_too_large",
              fileId: file.fileId,
              limitBytes: MESSAGE_ATTACHMENT_POLICY.maxFileBytes,
              observedBytes: MESSAGE_ATTACHMENT_POLICY.maxFileBytes + 1,
            },
          },
        }
      : providerUnavailable(file);
  }

  return { ok: true, value: { bytes, sha256: await sha256Hex(bytes) } };
}

class DownloadLimitError extends Error {}

class BoundedByteTransformer implements Transformer<Uint8Array, Uint8Array> {
  private byteLength = 0;

  constructor(private readonly maximum: number) {}

  transform(
    chunk: Uint8Array,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    this.byteLength += chunk.byteLength;

    if (this.byteLength > this.maximum) {
      throw new DownloadLimitError(
        "Slack attachment exceeds the download limit",
      );
    }

    controller.enqueue(chunk);
  }
}

async function fetchSlackFile(
  fetcher: typeof fetch,
  token: string,
  url: URL,
  redirectsRemaining: number,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetcher(url, {
    headers: { authorization: `Bearer ${token}` },
    redirect: "manual",
    signal,
  });

  if (!isRedirectStatus(response.status)) {
    return response;
  }

  const location = response.headers.get("location");

  if (redirectsRemaining <= 0 || location === null) {
    throw new Error("Slack attachment redirect limit exceeded");
  }

  const redirected = parseSlackFileUrl(new URL(location, url).toString());

  if (redirected === null) {
    throw new Error("Slack attachment redirected outside the trusted host");
  }

  return fetchSlackFile(
    fetcher,
    token,
    redirected,
    redirectsRemaining - 1,
    signal,
  );
}

/** The bearer token reaches Slack API and Slack file hosts, and nowhere else. */
function parseSlackFileUrl(raw: string): URL | null {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  return url.protocol === "https:" && url.hostname === SLACK_FILE_HOST
    ? url
    : null;
}

function parseContentLength(raw: string | null): number | null {
  if (raw === null || !/^\d+$/u.test(raw)) {
    return null;
  }

  const value = Number(raw);

  return Number.isSafeInteger(value) ? value : null;
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function readJsonFailure(): null {
  return null;
}
