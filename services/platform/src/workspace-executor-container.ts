import { Container } from "@cloudflare/containers";

import type {
  WorkspaceExecutorInspectionRequest,
  WorkspaceExecutorDecodedFrame,
  WorkspaceExecutorInspectionOperation,
  WorkspaceExecutorInspectionResponse,
} from "@seams/contracts/workspace-executor";

import type { Env } from "./env";
import type { Result } from "./result";
import { hasExactKeys, isNonNegativeInteger, isRecord } from "@seams/std";

const WORKSPACE_EXECUTOR_PORT = 8080;
const WORKSPACE_EXECUTOR_TIMEOUT_MS = 30_000;
const MAX_EXECUTOR_RESPONSE_BYTES = 1024 * 1024;

export type {
  WorkspaceExecutorInspectionRequest,
  WorkspaceExecutorDecodedFrame,
  WorkspaceExecutorInspectionOperation,
  WorkspaceExecutorInspectionResponse,
} from "@seams/contracts/workspace-executor";

export type WorkspaceExecutorContainerError =
  | { readonly kind: "deadline_exceeded" }
  | { readonly kind: "container_unavailable"; readonly reason: string }
  | { readonly kind: "executor_rejected"; readonly status: number }
  | { readonly kind: "response_too_large" }
  | { readonly kind: "invalid_response"; readonly field: string };

export type WorkspaceExecutorTrustedUsage = {
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly gatewayDurationMs: number;
};

type WorkspaceExecutorTransport = {
  containerFetch(
    input: string,
    init: RequestInit,
    port: number,
  ): Promise<Response>;
};

export type WorkspaceExecutorInspectionInvocation =
  | {
      readonly kind: "succeeded";
      readonly response: WorkspaceExecutorInspectionResponse;
      readonly usage: WorkspaceExecutorTrustedUsage;
    }
  | {
      readonly kind: "failed";
      readonly error: WorkspaceExecutorContainerError;
      readonly usage: WorkspaceExecutorTrustedUsage;
    };

export class WorkspaceExecutorContainer extends Container<Env> {
  defaultPort = WORKSPACE_EXECUTOR_PORT;
  requiredPorts = [WORKSPACE_EXECUTOR_PORT];
  sleepAfter = "30s";
  enableInternet = false;
  pingEndpoint = "/health";

  async inspectAttachment(
    request: WorkspaceExecutorInspectionRequest,
    attachment: Uint8Array,
  ): Promise<WorkspaceExecutorInspectionInvocation> {
    try {
      return await dispatchWorkspaceAttachmentInspection(
        this,
        request,
        attachment,
      );
    } finally {
      await this.destroy();
    }
  }

  override async onActivityExpired(): Promise<void> {
    await this.destroy();
  }
}

/** The envelope's fixed header: an 8-byte big-endian JSON length. */
const ENVELOPE_HEADER_BYTES = 8;

/**
 * Frames a request and its attachment bytes for the executor's binary path.
 *
 * The bytes sit after the JSON rather than inside it. Base64 in a document
 * inflates by a third and forces both ends to hold the whole payload as a
 * string, which the Worker's memory ceiling does not allow for a real file.
 */
export function encodeWorkspaceExecutorEnvelope(
  request: WorkspaceExecutorInspectionRequest,
  attachment: Uint8Array,
): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(request));
  const envelope = new Uint8Array(
    ENVELOPE_HEADER_BYTES + json.byteLength + attachment.byteLength,
  );
  const header = new DataView(envelope.buffer, 0, ENVELOPE_HEADER_BYTES);

  header.setBigUint64(0, BigInt(json.byteLength), false);
  envelope.set(json, ENVELOPE_HEADER_BYTES);
  envelope.set(attachment, ENVELOPE_HEADER_BYTES + json.byteLength);

  return envelope;
}

/**
 * Sends an attachment to the executor's binary path for bounded inspection.
 *
 * The round trip has been exercised against the built image over HTTP; what
 * the local runtime cannot exercise is this call through a Durable Object
 * binding, because those are undefined under workerd in tests.
 */
async function dispatchWorkspaceAttachmentInspection(
  container: WorkspaceExecutorTransport,
  request: WorkspaceExecutorInspectionRequest,
  attachment: Uint8Array,
): Promise<WorkspaceExecutorInspectionInvocation> {
  const envelope = encodeWorkspaceExecutorEnvelope(request, attachment);
  const startedAt = performance.now();
  let response: Response;

  try {
    const remainingMs = Math.max(
      1,
      Math.min(
        WORKSPACE_EXECUTOR_TIMEOUT_MS,
        request.deadlineAtUnixMs - Date.now(),
      ),
    );
    response = await container.containerFetch(
      "http://container/v1/execute-envelope",
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: envelope,
        signal: AbortSignal.timeout(remainingMs),
      },
      WORKSPACE_EXECUTOR_PORT,
    );
  } catch (error) {
    return {
      kind: "failed",
      error: isAbortError(error)
        ? { kind: "deadline_exceeded" }
        : { kind: "container_unavailable", reason: safeErrorMessage(error) },
      usage: trustedUsage(envelope.byteLength, 0, startedAt),
    };
  }

  const body = await readBoundedResponseBody(response);

  if (!body.ok) {
    return {
      kind: "failed",
      error: body.error,
      usage: trustedUsage(envelope.byteLength, body.responseBytes, startedAt),
    };
  }
  if (!response.ok) {
    return {
      kind: "failed",
      error: { kind: "executor_rejected", status: response.status },
      usage: trustedUsage(
        envelope.byteLength,
        body.value.responseBytes,
        startedAt,
      ),
    };
  }

  const parsed = parseWorkspaceExecutorInspectionResponse(
    body.value.body,
    request,
  );

  if (!parsed.ok) {
    return {
      kind: "failed",
      error: parsed.error,
      usage: trustedUsage(
        envelope.byteLength,
        body.value.responseBytes,
        startedAt,
      ),
    };
  }

  return {
    kind: "succeeded",
    response: parsed.value,
    usage: trustedUsage(
      envelope.byteLength,
      body.value.responseBytes,
      startedAt,
    ),
  };
}

/** Validates the preparation identity and bounded operation result. */
export function parseWorkspaceExecutorInspectionResponse(
  rawBody: string,
  request: WorkspaceExecutorInspectionRequest,
): Result<
  WorkspaceExecutorInspectionResponse,
  WorkspaceExecutorContainerError
> {
  let raw: unknown;

  try {
    raw = JSON.parse(rawBody);
  } catch {
    return invalidResponse("json");
  }
  if (!isRecord(raw) || !hasExactKeys(raw, INSPECTION_RESPONSE_KEYS)) {
    return invalidResponse("response");
  }
  if (raw.schemaVersion !== "workspace_executor_response.v1") {
    return invalidResponse("schemaVersion");
  }
  if (raw.preparationId !== request.preparationId) {
    return invalidResponse("preparationId");
  }
  if (
    !isRecord(raw.identity) ||
    !hasExactKeys(raw.identity, PREPARATION_IDENTITY_KEYS)
  ) {
    return invalidResponse("identity");
  }
  if (!jsonValuesEqual(raw.identity, request.identity)) {
    return invalidResponse("identity");
  }
  if (
    !isNonNegativeInteger(raw.inputBytes) ||
    !isNonNegativeInteger(raw.outputBytes) ||
    !isNonNegativeInteger(raw.durationMs)
  ) {
    return invalidResponse("usage");
  }
  if (raw.inputBytes > request.limits.maxInputBytes) {
    return invalidResponse("inputBytes");
  }
  if (raw.outputBytes > request.limits.maxOutputBytes) {
    return invalidResponse("outputBytes");
  }
  if (raw.durationMs > request.limits.maxDurationMs) {
    return invalidResponse("durationMs");
  }

  const operation = parseInspectionOperation(raw.operation, request);

  if (!operation.ok) {
    return operation;
  }

  return {
    ok: true,
    value: {
      schemaVersion: "workspace_executor_response.v1",
      preparationId: request.preparationId,
      identity: request.identity,
      operation: operation.value,
      inputBytes: raw.inputBytes,
      outputBytes: raw.outputBytes,
      durationMs: raw.durationMs,
    },
  };
}

const SHA256_HEX = /^[a-f0-9]{64}$/u;

function parseInspectionOperation(
  raw: unknown,
  request: WorkspaceExecutorInspectionRequest,
): Result<
  WorkspaceExecutorInspectionOperation,
  WorkspaceExecutorContainerError
> {
  if (!isRecord(raw)) {
    return invalidResponse("operation");
  }
  const expectedOperationKeys = operationKeys(raw.kind);
  if (expectedOperationKeys === null) {
    return invalidResponse("operation.kind");
  }
  if (!hasExactKeys(raw, expectedOperationKeys)) {
    return invalidResponse("operation");
  }
  // Every branch must name the attachment and the bytes it came from; a reply
  // about some other file is refused, not reinterpreted.
  if (raw.attachmentId !== request.identity.attachmentId) {
    return invalidResponse("operation.attachmentId");
  }
  if (raw.sourceSha256 !== request.identity.sourceSha256) {
    return invalidResponse("operation.sourceSha256");
  }
  const sourceSha256 = request.identity.sourceSha256;
  const attachmentId = request.identity.attachmentId;

  switch (raw.kind) {
    case "attachment_text":
      return typeof raw.text === "string" &&
        typeof raw.truncated === "boolean" &&
        [...raw.text].length <= request.operation.maxTextChars
        ? {
            ok: true,
            value: {
              kind: "attachment_text",
              attachmentId,
              text: raw.text,
              truncated: raw.truncated,
              sourceSha256,
            },
          }
        : invalidResponse("operation.text");
    case "attachment_video_frames": {
      if (
        typeof raw.policyRevision !== "string" ||
        raw.policyRevision.length === 0 ||
        !Array.isArray(raw.selectedTimestampsMs) ||
        !raw.selectedTimestampsMs.every(isNonNegativeInteger) ||
        !Array.isArray(raw.frames) ||
        !isNonNegativeInteger(raw.omittedFrames) ||
        raw.frames.length > request.limits.maxFrames ||
        raw.selectedTimestampsMs.length > request.limits.maxFrames ||
        raw.frames.length + raw.omittedFrames > request.limits.maxFrames
      ) {
        return invalidResponse("operation.frames");
      }
      const frames: WorkspaceExecutorDecodedFrame[] = [];

      for (const frame of raw.frames) {
        if (
          !isRecord(frame) ||
          !isNonNegativeInteger(frame.timestampMs) ||
          !isNonNegativeInteger(frame.width) ||
          !isNonNegativeInteger(frame.height) ||
          typeof frame.mediaType !== "string" ||
          typeof frame.jpegBase64 !== "string" ||
          typeof frame.sha256 !== "string" ||
          !SHA256_HEX.test(frame.sha256)
        ) {
          return invalidResponse("operation.frames");
        }
        frames.push({
          timestampMs: frame.timestampMs,
          width: frame.width,
          height: frame.height,
          mediaType: frame.mediaType,
          jpegBase64: frame.jpegBase64,
          sha256: frame.sha256,
        });
      }
      return {
        ok: true,
        value: {
          kind: "attachment_video_frames",
          attachmentId,
          policyRevision: raw.policyRevision,
          selectedTimestampsMs: raw.selectedTimestampsMs,
          frames,
          omittedFrames: raw.omittedFrames,
          sourceSha256,
        },
      };
    }
    case "attachment_not_inspectable":
      return raw.reason === "handler_unavailable" ||
        raw.reason === "format_unreadable" ||
        raw.reason === "codec_unsupported" ||
        raw.reason === "picture_too_large"
        ? {
            ok: true,
            value: {
              kind: "attachment_not_inspectable",
              attachmentId,
              reason: raw.reason,
              sourceSha256,
            },
          }
        : invalidResponse("operation.reason");
    default:
      return invalidResponse("operation.kind");
  }
}

async function readBoundedResponseBody(response: Response): Promise<
  | {
      readonly ok: true;
      readonly value: { readonly body: string; readonly responseBytes: number };
    }
  | {
      readonly ok: false;
      readonly error: WorkspaceExecutorContainerError;
      readonly responseBytes: number;
    }
> {
  const reader = response.body?.getReader();

  if (reader === undefined) {
    return {
      ok: false,
      error: { kind: "invalid_response", field: "body" },
      responseBytes: 0,
    };
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: "container_unavailable",
          reason: safeErrorMessage(error),
        },
        responseBytes: byteLength,
      };
    }

    if (chunk.done) {
      break;
    }
    byteLength += chunk.value.byteLength;
    if (byteLength > MAX_EXECUTOR_RESPONSE_BYTES) {
      await reader.cancel();
      return {
        ok: false,
        error: { kind: "response_too_large" },
        responseBytes: byteLength,
      };
    }
    chunks.push(chunk.value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      ok: true,
      value: {
        body: new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(bytes),
        responseBytes: byteLength,
      },
    };
  } catch {
    return {
      ok: false,
      error: { kind: "invalid_response", field: "bodyEncoding" },
      responseBytes: byteLength,
    };
  }
}

function trustedUsage(
  requestBytes: number,
  responseBytes: number,
  startedAt: number,
): WorkspaceExecutorTrustedUsage {
  return {
    requestBytes,
    responseBytes,
    gatewayDurationMs: Math.max(0, Math.ceil(performance.now() - startedAt)),
  };
}

function invalidResponse<TValue>(
  field: string,
): Result<TValue, WorkspaceExecutorContainerError> {
  return { ok: false, error: { kind: "invalid_response", field } };
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!jsonValuesEqual(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }
  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];

    if (key === undefined || key !== rightKeys[index]) {
      return false;
    }
    if (!jsonValuesEqual(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "workspace executor unavailable";
}

function operationKeys(kind: unknown): readonly string[] | null {
  switch (kind) {
    case "attachment_text":
      return ATTACHMENT_TEXT_KEYS;
    case "attachment_video_frames":
      return ATTACHMENT_VIDEO_FRAMES_KEYS;
    case "attachment_not_inspectable":
      return ATTACHMENT_NOT_INSPECTABLE_KEYS;
    default:
      return null;
  }
}

const INSPECTION_RESPONSE_KEYS = [
  "schemaVersion",
  "preparationId",
  "identity",
  "operation",
  "inputBytes",
  "outputBytes",
  "durationMs",
] as const;
const PREPARATION_IDENTITY_KEYS = [
  "organisationId",
  "sessionId",
  "turnId",
  "attachmentId",
  "sourceSha256",
  "handlerRevision",
] as const;
const ATTACHMENT_TEXT_KEYS = [
  "kind",
  "attachmentId",
  "text",
  "truncated",
  "sourceSha256",
] as const;
const ATTACHMENT_VIDEO_FRAMES_KEYS = [
  "kind",
  "attachmentId",
  "policyRevision",
  "selectedTimestampsMs",
  "frames",
  "omittedFrames",
  "sourceSha256",
] as const;
const ATTACHMENT_NOT_INSPECTABLE_KEYS = [
  "kind",
  "attachmentId",
  "reason",
  "sourceSha256",
] as const;
