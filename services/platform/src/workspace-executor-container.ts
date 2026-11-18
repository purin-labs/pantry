import { parseOrganisationId } from "./ids";
import { parseOrganisationPlacement } from "./placement";
import { parseOrganisationPlacementFenceToken } from "./data/organisation-placement";
import { Container } from "@cloudflare/containers";

import type {
  WorkspaceExecutorRequest,
  WorkspaceExecutorResponse,
  WorkspaceExecutorFileReplacement,
  WorkspaceExecutorInspectionRequest,
  WorkspaceExecutorDecodedFrame,
  WorkspaceExecutorInspectionOperation,
  WorkspaceExecutorInspectionResponse,
} from "@seams/contracts/workspace-executor";

import type { Env } from "./env";
import type { Result } from "./result";
import {
  hasExactKeys,
  isNonNegativeInteger,
  isRecord,
  sha256Hex,
  assertNever,
} from "@seams/std";
import { OrganisationExecutionScope } from "./organisation-execution-scope";
import {
  authorizeSessionTurnExecution,
  type SessionTurnExecution,
} from "./chat/turn-access";

const WORKSPACE_EXECUTOR_PORT = 8080;
const WORKSPACE_EXECUTOR_TIMEOUT_MS = 30_000;
const MAX_EXECUTOR_RESPONSE_BYTES = 1024 * 1024;
const MAX_EXECUTOR_FILE_BYTES = 256 * 1024;

export type {
  WorkspaceExecutorProductFiles,
  WorkspaceExecutorRequest,
  WorkspaceExecutorResponse,
  WorkspaceExecutorFileReplacement,
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

export type WorkspaceExecutorInvocation =
  | {
      readonly kind: "succeeded";
      readonly response: WorkspaceExecutorResponse;
      readonly usage: WorkspaceExecutorTrustedUsage;
    }
  | {
      readonly kind: "failed";
      readonly error: WorkspaceExecutorContainerError;
      readonly usage: WorkspaceExecutorTrustedUsage;
    };

export type WorkspaceExecutorTransport = {
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

  async executeWorkspaceOperation(
    request: WorkspaceExecutorRequest,
    authority: WorkspaceExecutorDispatchAuthority,
  ): Promise<WorkspaceExecutorOperationResult> {
    return executeRecordedWorkspaceOperation(
      this.ctx.storage.sql,
      request,
      authorizeWorkspaceExecutorDispatch.bind(
        null,
        this.env,
        authority,
        request,
      ),
      dispatchWorkspaceExecution.bind(null, this, request),
      this.destroy.bind(this),
    );
  }

  async recoverWorkspaceOperation(
    request: WorkspaceExecutorRequest,
  ): Promise<WorkspaceExecutorOperationResult> {
    return recoverRecordedWorkspaceOperation(
      this.ctx.storage.sql,
      request,
      this.destroy.bind(this),
    );
  }

  async releaseWorkspaceOperation(
    request: WorkspaceExecutorRequest,
  ): Promise<void> {
    await releaseRecordedWorkspaceOperation(
      this.ctx.storage.sql,
      request,
      this.destroy.bind(this),
    );
  }

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
  request: WorkspaceExecutorRequest | WorkspaceExecutorInspectionRequest,
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
export async function dispatchWorkspaceAttachmentInspection(
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

export async function dispatchWorkspaceExecution(
  container: WorkspaceExecutorTransport,
  request: WorkspaceExecutorRequest,
): Promise<WorkspaceExecutorInvocation> {
  const requestBody = JSON.stringify(request);
  const requestBytes = new TextEncoder().encode(requestBody).byteLength;
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
      "http://container/v1/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
        signal: AbortSignal.timeout(remainingMs),
      },
      WORKSPACE_EXECUTOR_PORT,
    );
  } catch (error) {
    if (isAbortError(error)) {
      return failedInvocation(
        { kind: "deadline_exceeded" },
        requestBytes,
        0,
        startedAt,
      );
    }
    return failedInvocation(
      { kind: "container_unavailable", reason: safeErrorMessage(error) },
      requestBytes,
      0,
      startedAt,
    );
  }

  const body = await readBoundedResponseBody(response);

  if (!body.ok) {
    return failedInvocation(
      body.error,
      requestBytes,
      body.responseBytes,
      startedAt,
    );
  }
  if (!response.ok) {
    return failedInvocation(
      { kind: "executor_rejected", status: response.status },
      requestBytes,
      body.value.responseBytes,
      startedAt,
    );
  }

  const parsed = parseWorkspaceExecutorResponse(body.value.body, request);
  if (!parsed.ok) {
    return failedInvocation(
      parsed.error,
      requestBytes,
      body.value.responseBytes,
      startedAt,
    );
  }
  return {
    kind: "succeeded",
    response: parsed.value,
    usage: trustedUsage(requestBytes, body.value.responseBytes, startedAt),
  };
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

function failedInvocation(
  error: WorkspaceExecutorContainerError,
  requestBytes: number,
  responseBytes: number,
  startedAt: number,
): WorkspaceExecutorInvocation {
  return {
    kind: "failed",
    error,
    usage: trustedUsage(requestBytes, responseBytes, startedAt),
  };
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

export function parseWorkspaceExecutorResponse(
  rawBody: string,
  request: WorkspaceExecutorRequest,
): Result<WorkspaceExecutorResponse, WorkspaceExecutorContainerError> {
  let raw: unknown;

  try {
    raw = JSON.parse(rawBody);
  } catch {
    return invalidResponse("json");
  }
  if (!isRecord(raw) || !hasExactKeys(raw, PRODUCT_RESPONSE_KEYS)) {
    return invalidResponse("response");
  }
  if (raw.schemaVersion !== "workspace_executor_response.v1") {
    return invalidResponse("schemaVersion");
  }
  if (raw.executionId !== request.executionId) {
    return invalidResponse("executionId");
  }
  if (raw.executionReceiptId !== request.executionReceiptId) {
    return invalidResponse("executionReceiptId");
  }
  if (raw.baseRevision !== request.baseRevision) {
    return invalidResponse("baseRevision");
  }
  if (raw.baseCanonicalHead !== request.baseCanonicalHead) {
    return invalidResponse("baseCanonicalHead");
  }
  if (raw.baseManifestDigest !== request.baseManifestDigest) {
    return invalidResponse("baseManifestDigest");
  }
  if (!isNonNegativeInteger(raw.inputBytes)) {
    return invalidResponse("inputBytes");
  }
  if (!isNonNegativeInteger(raw.outputBytes)) {
    return invalidResponse("outputBytes");
  }
  if (!isNonNegativeInteger(raw.durationMs)) {
    return invalidResponse("durationMs");
  }

  const operation = parseOperation(raw.operation, request);

  if (!operation.ok) {
    return operation;
  }

  return {
    ok: true,
    value: {
      schemaVersion: "workspace_executor_response.v1",
      executionId: request.executionId,
      executionReceiptId: request.executionReceiptId,
      baseRevision: request.baseRevision,
      baseCanonicalHead: request.baseCanonicalHead,
      baseManifestDigest: request.baseManifestDigest,
      operation: operation.value,
      inputBytes: raw.inputBytes,
      outputBytes: raw.outputBytes,
      durationMs: raw.durationMs,
    },
  };
}

function parseOperation(
  raw: unknown,
  request: WorkspaceExecutorRequest,
): Result<
  WorkspaceExecutorResponse["operation"],
  WorkspaceExecutorContainerError
> {
  if (!isRecord(raw) || !hasExactKeys(raw, OPERATION_KEYS)) {
    return invalidResponse("operation");
  }
  if (raw.kind !== "validated_product_folder_changeset") {
    return invalidResponse("operation.kind");
  }
  if (raw.productRoot !== request.operation.productRoot) {
    return invalidResponse("operation.productRoot");
  }
  if (
    !jsonValuesEqual(raw.validatedChangeset, request.operation.claimedChangeset)
  ) {
    return invalidResponse("operation.validatedChangeset");
  }

  const overlay = parseReplacementOverlay(
    raw.replacementOverlay,
    request.operation.productRoot,
  );

  if (!overlay.ok) {
    return overlay;
  }

  return {
    ok: true,
    value: {
      kind: "validated_product_folder_changeset",
      productRoot: request.operation.productRoot,
      replacementOverlay: overlay.value,
      validatedChangeset: request.operation.claimedChangeset,
    },
  };
}

function parseReplacementOverlay(
  raw: unknown,
  productRoot: string,
): Result<
  WorkspaceExecutorResponse["operation"]["replacementOverlay"],
  WorkspaceExecutorContainerError
> {
  if (!isRecord(raw) || !hasExactKeys(raw, REPLACEMENT_OVERLAY_KEYS)) {
    return invalidResponse("operation.replacementOverlay");
  }

  const productMarkdown = parseFileReplacement(
    raw.productMarkdown,
    `${productRoot}/product.md`,
    "operation.replacementOverlay.productMarkdown",
  );

  if (!productMarkdown.ok) {
    return productMarkdown;
  }

  const variantsYaml = parseFileReplacement(
    raw.variantsYaml,
    `${productRoot}/variants.yaml`,
    "operation.replacementOverlay.variantsYaml",
  );

  if (!variantsYaml.ok) {
    return variantsYaml;
  }

  return {
    ok: true,
    value: {
      productMarkdown: productMarkdown.value,
      variantsYaml: variantsYaml.value,
    },
  };
}

function parseFileReplacement(
  raw: unknown,
  expectedPath: string,
  field: string,
): Result<WorkspaceExecutorFileReplacement, WorkspaceExecutorContainerError> {
  if (!isRecord(raw) || !hasExactKeys(raw, FILE_REPLACEMENT_KEYS)) {
    return invalidResponse(field);
  }
  if (raw.path !== expectedPath) {
    return invalidResponse(`${field}.path`);
  }
  if (
    typeof raw.utf8 !== "string" ||
    byteLength(raw.utf8) > MAX_EXECUTOR_FILE_BYTES
  ) {
    return invalidResponse(`${field}.utf8`);
  }
  return { ok: true, value: { path: expectedPath, utf8: raw.utf8 } };
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

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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
const PRODUCT_RESPONSE_KEYS = [
  "schemaVersion",
  "executionId",
  "executionReceiptId",
  "baseRevision",
  "baseCanonicalHead",
  "baseManifestDigest",
  "operation",
  "inputBytes",
  "outputBytes",
  "durationMs",
] as const;
const OPERATION_KEYS = [
  "kind",
  "productRoot",
  "replacementOverlay",
  "validatedChangeset",
] as const;
const REPLACEMENT_OVERLAY_KEYS = ["productMarkdown", "variantsYaml"] as const;
const FILE_REPLACEMENT_KEYS = ["path", "utf8"] as const;

export type WorkspaceExecutorPlacement = Pick<
  OrganisationExecutionScope,
  "organisationId" | "placement" | "fenceToken"
>;

export type WorkspaceExecutorDispatchAuthority = Readonly<{
  placement: WorkspaceExecutorPlacement;
  execution: SessionTurnExecution;
  expiresAt: number;
}>;

export type WorkspaceExecutorOperationResult = Result<
  | Readonly<{ kind: "completed"; invocation: WorkspaceExecutorInvocation }>
  | Readonly<{ kind: "cancelled" }>,
  Readonly<{
    code:
      | "workspace_operation_conflict"
      | "workspace_operation_pending"
      | "workspace_operation_released"
      | "workspace_operation_authority_inactive";
  }>
>;

type WorkspaceOperationRecord =
  | Readonly<{ kind: "missing" | "conflict" }>
  | Readonly<{ kind: "running"; startedAt: number }>
  | Readonly<{ kind: "completed"; invocation: WorkspaceExecutorInvocation }>
  | Readonly<{ kind: "cancelled" | "released" }>;

export async function authorizeWorkspaceExecutorDispatch(
  env: Env,
  authority: WorkspaceExecutorDispatchAuthority,
  request: WorkspaceExecutorRequest,
): Promise<boolean> {
  if (
    Date.now() >= authority.expiresAt ||
    Date.now() >= request.deadlineAtUnixMs ||
    request.operation.claimedChangeset.organisationId !==
      authority.placement.organisationId
  )
    return false;
  const scope = await OrganisationExecutionScope.resolve(
    env,
    authority.placement.organisationId,
  );
  if (
    !scope.ok ||
    scope.value.fenceToken !== authority.placement.fenceToken ||
    scope.value.placement.placementEpoch !==
      authority.placement.placement.placementEpoch ||
    scope.value.placement.placementCellId !==
      authority.placement.placement.placementCellId
  )
    return false;
  if (
    !(await authorizeSessionTurnExecution(
      env.DB,
      scope.value.database,
      scope.value.organisationId,
      authority.execution,
      scope.value.accountAccess,
    ))
  )
    return false;
  return (
    (await scope.value.isActive()) &&
    Date.now() < authority.expiresAt &&
    Date.now() < request.deadlineAtUnixMs
  );
}

export async function executeRecordedWorkspaceOperation(
  sql: SqlStorage,
  request: WorkspaceExecutorRequest,
  authorize: () => Promise<boolean>,
  dispatch: () => Promise<WorkspaceExecutorInvocation>,
  stop: () => Promise<void>,
): Promise<WorkspaceExecutorOperationResult> {
  const digest = await sha256Hex(JSON.stringify(request));
  let record = readWorkspaceOperation(sql, request, digest);
  if (record.kind !== "missing") {
    if (record.kind === "completed") await stop();
    return workspaceOperationResult(record);
  }
  if (!(await authorize()))
    return {
      ok: false,
      error: { code: "workspace_operation_authority_inactive" },
    };
  // Another request can claim or cancel this allocation while authorization waits.
  record = readWorkspaceOperation(sql, request, digest);
  if (record.kind !== "missing") {
    if (record.kind === "completed") await stop();
    return workspaceOperationResult(record);
  }
  sql.exec(
    "INSERT INTO workspace_executor_operation (singleton, request_digest, state, started_at, invocation) VALUES (1, ?, 'running', ?, NULL)",
    digest,
    Date.now(),
  );
  try {
    const invocation = await dispatch();
    sql.exec(
      "UPDATE workspace_executor_operation SET state = 'completed', invocation = ? WHERE singleton = 1 AND request_digest = ? AND state = 'running'",
      JSON.stringify(invocation),
      digest,
    );
  } finally {
    await stop();
  }
  return workspaceOperationResult(readWorkspaceOperation(sql, request, digest));
}

export async function recoverRecordedWorkspaceOperation(
  sql: SqlStorage,
  request: WorkspaceExecutorRequest,
  stop: () => Promise<void>,
): Promise<WorkspaceExecutorOperationResult> {
  const digest = await sha256Hex(JSON.stringify(request));
  let record = readWorkspaceOperation(sql, request, digest);
  if (record.kind === "conflict") return workspaceOperationResult(record);
  if (record.kind === "missing") {
    // Seal admission before cancellation so a delayed original RPC cannot start.
    sql.exec(
      "INSERT INTO workspace_executor_operation (singleton, request_digest, state, started_at, invocation) VALUES (1, ?, 'cancelled', NULL, NULL)",
      digest,
    );
  }
  await stop();
  record = readWorkspaceOperation(sql, request, digest);
  if (record.kind === "running") {
    const invocation: WorkspaceExecutorInvocation = {
      kind: "failed",
      error: {
        kind: "container_unavailable",
        reason: "workspace_operation_interrupted",
      },
      usage: {
        requestBytes: new TextEncoder().encode(JSON.stringify(request))
          .byteLength,
        responseBytes: 0,
        gatewayDurationMs: Math.max(0, Date.now() - record.startedAt),
      },
    };
    sql.exec(
      "UPDATE workspace_executor_operation SET state = 'completed', invocation = ? WHERE singleton = 1 AND request_digest = ? AND state = 'running'",
      JSON.stringify(invocation),
      digest,
    );
  }
  return workspaceOperationResult(readWorkspaceOperation(sql, request, digest));
}

export async function releaseRecordedWorkspaceOperation(
  sql: SqlStorage,
  request: WorkspaceExecutorRequest,
  stop: () => Promise<void>,
): Promise<void> {
  const digest = await sha256Hex(JSON.stringify(request));
  const record = readWorkspaceOperation(sql, request, digest);
  if (record.kind !== "completed" && record.kind !== "released")
    throw new Error("workspace_operation_release_conflict");
  await stop();
  sql.exec(
    "UPDATE workspace_executor_operation SET state = 'released', invocation = NULL WHERE singleton = 1 AND request_digest = ? AND state = 'completed'",
    digest,
  );
}

function readWorkspaceOperation(
  sql: SqlStorage,
  request: WorkspaceExecutorRequest,
  digest: string,
): WorkspaceOperationRecord {
  sql.exec(`CREATE TABLE IF NOT EXISTS workspace_executor_operation (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    request_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'cancelled', 'released')),
    started_at INTEGER,
    invocation TEXT,
    CHECK ((state = 'cancelled' AND started_at IS NULL AND invocation IS NULL)
      OR (state IN ('running', 'released') AND started_at IS NOT NULL AND invocation IS NULL)
      OR (state = 'completed' AND started_at IS NOT NULL AND invocation IS NOT NULL))
  )`);
  const row = sql
    .exec<{
      request_digest: string;
      state: string;
      started_at: number | null;
      invocation: string | null;
    }>(
      "SELECT request_digest, state, started_at, invocation FROM workspace_executor_operation WHERE singleton = 1",
    )
    .toArray()[0];
  if (row === undefined) return { kind: "missing" };
  if (row.request_digest !== digest) return { kind: "conflict" };
  switch (row.state) {
    case "running":
      if (row.started_at === null)
        throw new Error("workspace_operation_corrupt");
      return { kind: "running", startedAt: row.started_at };
    case "completed": {
      const invocation =
        row.invocation === null
          ? null
          : parseWorkspaceInvocation(JSON.parse(row.invocation), request);
      if (invocation === null) throw new Error("workspace_operation_corrupt");
      return { kind: "completed", invocation };
    }
    case "cancelled":
      return { kind: "cancelled" };
    case "released":
      return { kind: "released" };
    default:
      throw new Error("workspace_operation_corrupt");
  }
}

function workspaceOperationResult(
  record: WorkspaceOperationRecord,
): WorkspaceExecutorOperationResult {
  switch (record.kind) {
    case "completed":
      return {
        ok: true,
        value: { kind: "completed", invocation: record.invocation },
      };
    case "cancelled":
      return { ok: true, value: { kind: "cancelled" } };
    case "running":
      return { ok: false, error: { code: "workspace_operation_pending" } };
    case "released":
      return { ok: false, error: { code: "workspace_operation_released" } };
    case "conflict":
      return { ok: false, error: { code: "workspace_operation_conflict" } };
    case "missing":
      throw new Error("workspace_operation_missing");
    default:
      return assertNever(record);
  }
}

export function parseWorkspaceInvocation(
  raw: unknown,
  request: WorkspaceExecutorRequest,
): WorkspaceExecutorInvocation | null {
  if (!isRecord(raw)) return null;
  const usage = parseTrustedUsage(raw.usage);
  if (usage === null) return null;
  if (raw.kind === "succeeded") {
    const response = parseWorkspaceExecutorResponse(
      JSON.stringify(raw.response),
      request,
    );
    return response.ok
      ? { kind: "succeeded", response: response.value, usage }
      : null;
  }
  if (raw.kind === "failed") {
    const error = parseWorkspaceExecutorError(raw.error);
    return error === null ? null : { kind: "failed", error, usage };
  }
  return null;
}

function parseTrustedUsage(raw: unknown): WorkspaceExecutorTrustedUsage | null {
  return isRecord(raw) &&
    isNonNegativeInteger(raw.requestBytes) &&
    isNonNegativeInteger(raw.responseBytes) &&
    isNonNegativeInteger(raw.gatewayDurationMs)
    ? {
        requestBytes: raw.requestBytes,
        responseBytes: raw.responseBytes,
        gatewayDurationMs: raw.gatewayDurationMs,
      }
    : null;
}

function parseWorkspaceExecutorError(
  raw: unknown,
): WorkspaceExecutorContainerError | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "deadline_exceeded":
    case "response_too_large":
      return { kind: raw.kind };
    case "container_unavailable":
      return typeof raw.reason === "string"
        ? { kind: "container_unavailable", reason: raw.reason }
        : null;
    case "executor_rejected":
      return isNonNegativeInteger(raw.status)
        ? { kind: "executor_rejected", status: raw.status }
        : null;
    case "invalid_response":
      return typeof raw.field === "string"
        ? { kind: "invalid_response", field: raw.field }
        : null;
    default:
      return null;
  }
}

export function parseWorkspaceExecutorPlacement(
  raw: unknown,
): WorkspaceExecutorPlacement | null {
  if (!isRecord(raw) || typeof raw.organisationId !== "string") return null;
  const organisationId = parseOrganisationId(raw.organisationId);
  const placement = parseOrganisationPlacement(raw.placement);
  const fenceToken = parseOrganisationPlacementFenceToken(raw.fenceToken);
  if (!organisationId.ok || !placement.ok || !fenceToken.ok) return null;
  return {
    organisationId: organisationId.value,
    placement: placement.value,
    fenceToken: fenceToken.value,
  };
}
