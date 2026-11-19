import type {
  HarnessTurnLease,
  MessageAttachmentPreparationIdentity,
  MessageAttachmentPreparationLimits,
  MessageAttachmentPreparationReceipt,
  MessageAttachmentPreparationState,
  StoredMessageAttachment,
} from "@purin-labs/contracts";

import { newRequestId } from "../ids";
import { validateMessageAttachmentPreparationReceipt } from "../messages/message-wasm";
import { traceLog } from "../observability";
import { attachmentManifestLine } from "../messages/attachment-inspection";
import type { Result } from "../result";
import { parseStoredAttachment } from "../messages/stored-attachment";
import type { EmbeddedHarnessUserInput } from "./embedded-harness";
import { preflightHarnessTurnLease } from "./agent-session-harness-authority";
import {
  beginMessagePreparation,
  completeMessagePreparation,
  readMessagePreparation,
} from "./message-preparation-store";
import type { Variant } from "@purin-labs/type-utils";
import { isRecord, sha256Hex } from "@purin-labs/std";

const MESSAGE_PREPARATION_HANDLER_REVISION = "message-preparation.v1";
export const MESSAGE_PREPARATION_LIMITS: MessageAttachmentPreparationLimits = {
  maxInputBytes: 25 * 1024 * 1024,
  maxOutputBytes: 36 * 1024 * 1024,
  maxDurationMs: 30_000,
  maxFrames: 12,
};

export type MessagePreparationError = {
  readonly code: "embedded_harness_attachment_preparation_failed";
  readonly attachmentId: string;
  readonly reason: string;
};

type AttachmentInput = Exclude<EmbeddedHarnessUserInput, { kind: "text" }>;
type PendingMessagePreparation = Variant<
  MessageAttachmentPreparationState,
  "pending"
>;
type PreparedAttachment = {
  readonly receipt: MessageAttachmentPreparationReceipt;
  readonly inputs: readonly AttachmentInput[];
};

export type MessagePreparationAttempt =
  { readonly kind: "initial" } | { readonly kind: "recovery" };

type MessagePreparationMaterializer = (
  deadlineAt: number,
  attempt: MessagePreparationAttempt,
) => Promise<readonly AttachmentInput[]>;

type PreparationResult = Result<PreparedAttachment, MessagePreparationError>;
type PreparationFlight = () => Promise<PreparationResult>;

const preparationFlights = new WeakMap<
  DurableObjectStorage,
  Map<string, Promise<PreparationResult>>
>();

export function messagePreparationIdentity(
  lease: HarnessTurnLease,
  attachment: StoredMessageAttachment,
): MessageAttachmentPreparationIdentity {
  return {
    organisationId: lease.session.organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
    attachmentId: attachment.id,
    sourceSha256: attachment.sha256,
    handlerRevision: MESSAGE_PREPARATION_HANDLER_REVISION,
  };
}

export async function messagePreparationId(
  identity: MessageAttachmentPreparationIdentity,
): Promise<string> {
  return `prep-${await sha256Hex(JSON.stringify(identity))}`;
}

export async function prepareAcceptedMessageAttachment(input: {
  readonly storage: DurableObjectStorage;
  readonly archive: R2Bucket;
  readonly lease: HarnessTurnLease;
  readonly attachment: StoredMessageAttachment;
  readonly deadlineAt: number;
  readonly materialize: MessagePreparationMaterializer;
}): Promise<PreparationResult> {
  const identity = messagePreparationIdentity(input.lease, input.attachment);
  const preparationId = await messagePreparationId(identity);
  const objectKey = `attachments/${identity.organisationId}/derived/${identity.sourceSha256}/preparation/${preparationId}.json`;
  const now = Date.now();
  const authorized = preflightHarnessTurnLease(input.storage, input.lease, now);
  if (!authorized.ok) return failed(identity, authorized.error.code);
  const active = readPreparationFlight(input.storage, preparationId);
  if (active !== undefined) return active;
  const existing = readMessagePreparation(input.storage.sql, identity);
  if (!existing.ok) return failed(identity, existing.error.code);

  if (existing.value?.kind === "completed") {
    return acceptSavedPreparation({
      storage: input.storage,
      archive: input.archive,
      lease: input.lease,
      identity,
      attachment: input.attachment,
      objectKey,
      missingReason: "preparation_result_missing",
    });
  }

  if (existing.value?.kind === "pending") {
    const saved = await readPreparedAttachment(
      input.archive,
      objectKey,
      input.attachment,
    );
    if (!saved.ok) return failed(identity, saved.error);
    if (saved.value !== null) {
      return completeSavedPreparation(input.storage, input.lease, saved.value);
    }
    const recovery = validatePendingRecovery(
      existing.value,
      input.lease,
      input.deadlineAt,
      Date.now(),
    );
    if (!recovery.ok) return failed(identity, recovery.error);
    return runPreparationFlight(
      input.storage,
      preparationId,
      prepareAndPersist.bind(null, {
        storage: input.storage,
        archive: input.archive,
        lease: input.lease,
        attachment: input.attachment,
        identity,
        objectKey,
        pending: existing.value,
        materialize: input.materialize,
        attempt: recovery.value,
      }),
    );
  }

  const startedAt = now;
  const deadlineAt = Math.min(
    input.deadlineAt,
    input.lease.expiresAt,
    startedAt + MESSAGE_PREPARATION_LIMITS.maxDurationMs,
  );
  if (deadlineAt <= startedAt)
    return failed(identity, "preparation_deadline_exceeded");
  const pending: PendingMessagePreparation = {
    kind: "pending",
    identity,
    limits: MESSAGE_PREPARATION_LIMITS,
    startedAt,
    deadlineAt,
  };
  const begun = input.storage.transactionSync(
    beginMessagePreparation.bind(null, input.storage.sql, pending),
  );
  if (!begun.ok) return failed(identity, begun.error.code);

  if (begun.value.kind === "completed") {
    return acceptSavedPreparation({
      storage: input.storage,
      archive: input.archive,
      lease: input.lease,
      identity,
      attachment: input.attachment,
      objectKey,
      missingReason: "preparation_result_missing",
    });
  }

  const attempt = preparationAttemptForBegunState(
    begun.value,
    pending,
    input.lease,
    input.deadlineAt,
    now,
  );
  if (!attempt.ok) return failed(identity, attempt.error);
  return runPreparationFlight(
    input.storage,
    preparationId,
    prepareAndPersist.bind(null, {
      storage: input.storage,
      archive: input.archive,
      lease: input.lease,
      attachment: input.attachment,
      identity,
      objectKey,
      pending: begun.value,
      materialize: input.materialize,
      attempt: attempt.value,
    }),
  );
}

export async function readAcceptedMessageAttachment(input: {
  readonly authorizeExecution: () => Promise<void>;
  readonly storage: DurableObjectStorage;
  readonly archive: R2Bucket;
  readonly lease: HarnessTurnLease;
  readonly attachment: StoredMessageAttachment;
}): Promise<
  Result<readonly EmbeddedHarnessUserInput[], MessagePreparationError>
> {
  await input.authorizeExecution();
  const identity = messagePreparationIdentity(input.lease, input.attachment);
  const authorized = preflightHarnessTurnLease(
    input.storage,
    input.lease,
    Date.now(),
  );
  if (!authorized.ok) return failed(identity, authorized.error.code);
  const current = readMessagePreparation(input.storage.sql, identity);
  if (!current.ok) return failed(identity, current.error.code);
  if (
    current.value?.kind !== "completed" ||
    current.value.receipt.outcome.kind !== "prepared"
  ) {
    return failed(identity, "preparation_not_completed");
  }
  const saved = await readPreparedAttachment(
    input.archive,
    current.value.receipt.outcome.resultObjectKey,
    input.attachment,
  );
  await input.authorizeExecution();
  if (!saved.ok) return failed(identity, saved.error);
  if (saved.value === null)
    return failed(identity, "preparation_result_missing");
  const verified = input.storage.transactionSync(
    completeAuthorizedPreparation.bind(
      null,
      input.storage,
      input.lease,
      saved.value.receipt,
    ),
  );
  return verified.ok
    ? { ok: true, value: saved.value.inputs }
    : failed(identity, verified.error.code);
}

function completeAuthorizedPreparation(
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  receipt: MessageAttachmentPreparationReceipt,
) {
  const authorized = preflightHarnessTurnLease(storage, lease, Date.now());
  return authorized.ok
    ? completeMessagePreparation(storage.sql, receipt)
    : authorized;
}

async function acceptSavedPreparation(input: {
  readonly storage: DurableObjectStorage;
  readonly archive: R2Bucket;
  readonly lease: HarnessTurnLease;
  readonly identity: MessageAttachmentPreparationIdentity;
  readonly attachment: StoredMessageAttachment;
  readonly objectKey: string;
  readonly missingReason:
    "preparation_interrupted" | "preparation_result_missing";
}): Promise<PreparationResult> {
  const saved = await readPreparedAttachment(
    input.archive,
    input.objectKey,
    input.attachment,
  );
  if (!saved.ok) return failed(input.identity, saved.error);
  if (saved.value === null) return failed(input.identity, input.missingReason);
  return completeSavedPreparation(input.storage, input.lease, saved.value);
}

function completeSavedPreparation(
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  saved: PreparedAttachment,
): PreparationResult {
  const completed = storage.transactionSync(
    completeAuthorizedPreparation.bind(null, storage, lease, saved.receipt),
  );
  return completed.ok
    ? { ok: true, value: saved }
    : failed(saved.receipt.identity, completed.error.code);
}

async function prepareAndPersist(input: {
  readonly storage: DurableObjectStorage;
  readonly archive: R2Bucket;
  readonly lease: HarnessTurnLease;
  readonly attachment: StoredMessageAttachment;
  readonly identity: MessageAttachmentPreparationIdentity;
  readonly objectKey: string;
  readonly pending: PendingMessagePreparation;
  readonly materialize: MessagePreparationMaterializer;
  readonly attempt: MessagePreparationAttempt;
}): Promise<PreparationResult> {
  const { identity, pending } = input;
  try {
    const oversized =
      input.attachment.byteLength > pending.limits.maxInputBytes;
    let inputs: readonly AttachmentInput[];
    if (oversized) {
      inputs = [
        {
          kind: "attachment_manifest",
          attachment: input.attachment,
          manifest: `${attachmentManifestLine(input.attachment)}; preparation=source_too_large; content unread`,
        },
      ];
    } else {
      const materializationStartedAt = Date.now();
      if (
        materializationStartedAt >= pending.deadlineAt ||
        materializationStartedAt >= input.lease.expiresAt
      ) {
        return failed(identity, "preparation_deadline_exceeded");
      }
      const authorized = preflightHarnessTurnLease(
        input.storage,
        input.lease,
        materializationStartedAt,
      );
      if (!authorized.ok) return failed(identity, authorized.error.code);
      inputs = await input.materialize(pending.deadlineAt, input.attempt);
    }
    if (inputs.filter(isImageInput).length > pending.limits.maxFrames) {
      return failed(identity, "too_many_prepared_images");
    }
    const resultJson = JSON.stringify(inputs);
    const outputBytes = new TextEncoder().encode(resultJson).byteLength;
    if (outputBytes > pending.limits.maxOutputBytes)
      return failed(identity, "output_too_large");
    const completedAt = Date.now();
    if (completedAt > pending.deadlineAt)
      return failed(identity, "preparation_deadline_exceeded");
    const stillAuthorized = preflightHarnessTurnLease(
      input.storage,
      input.lease,
      completedAt,
    );
    if (!stillAuthorized.ok)
      return failed(identity, stillAuthorized.error.code);
    const validated = validateMessageAttachmentPreparationReceipt({
      identity,
      limits: pending.limits,
      resultDigest: await sha256Hex(resultJson),
      derivedObjectKeys: [input.objectKey],
      usage: {
        activeWallMs: completedAt - pending.startedAt,
        inputBytes: oversized ? 0 : input.attachment.byteLength,
        outputBytes,
      },
      completedAt,
      outcome: { kind: "prepared", resultObjectKey: input.objectKey },
    });
    if (!validated.ok) return failed(identity, validated.error.code);
    const prepared: PreparedAttachment = { receipt: validated.value, inputs };
    // Write the result before accepting its receipt. A restart can finish this
    // acceptance without repeating the parser or reserving another allocation.
    const writeStartedAt = Date.now();
    await input.archive.put(input.objectKey, JSON.stringify(prepared), {
      httpMetadata: { contentType: "application/json" },
    });
    traceLog("session.attachment_preparation_timing", {
      requestId: newRequestId(),
      organisation_id: identity.organisationId,
      turn_id: identity.turnId,
      output_bytes: outputBytes,
      materialize_ms: completedAt - pending.startedAt,
      result_write_ms: Date.now() - writeStartedAt,
    });
    const completed = input.storage.transactionSync(
      completeAuthorizedPreparation.bind(
        null,
        input.storage,
        input.lease,
        prepared.receipt,
      ),
    );
    return completed.ok
      ? { ok: true, value: prepared }
      : failed(identity, completed.error.code);
  } catch (error) {
    return failed(
      identity,
      error instanceof Error ? error.message : "preparation_failed",
    );
  }
}

function validatePendingRecovery(
  pending: PendingMessagePreparation,
  lease: HarnessTurnLease,
  requestedDeadlineAt: number,
  now: number,
): Result<MessagePreparationAttempt, string> {
  if (
    now >= pending.deadlineAt ||
    pending.deadlineAt > requestedDeadlineAt ||
    pending.deadlineAt > lease.expiresAt
  ) {
    return { ok: false, error: "preparation_deadline_exceeded" };
  }
  return lease.issuedAt > pending.startedAt
    ? { ok: true, value: { kind: "recovery" } }
    : { ok: false, error: "preparation_interrupted" };
}

function preparationAttemptForBegunState(
  begun: PendingMessagePreparation,
  requested: PendingMessagePreparation,
  lease: HarnessTurnLease,
  requestedDeadlineAt: number,
  now: number,
): Result<MessagePreparationAttempt, string> {
  return begun.startedAt === requested.startedAt &&
    begun.deadlineAt === requested.deadlineAt
    ? { ok: true, value: { kind: "initial" } }
    : validatePendingRecovery(begun, lease, requestedDeadlineAt, now);
}

async function runPreparationFlight(
  storage: DurableObjectStorage,
  preparationId: string,
  operation: PreparationFlight,
): Promise<PreparationResult> {
  let flights = preparationFlights.get(storage);
  if (flights === undefined) {
    flights = new Map();
    preparationFlights.set(storage, flights);
  }
  const active = flights.get(preparationId);
  if (active !== undefined) return active;
  const current = finishPreparationFlight(preparationId, flights, operation);
  flights.set(preparationId, current);
  return current;
}

function readPreparationFlight(
  storage: DurableObjectStorage,
  preparationId: string,
): Promise<PreparationResult> | undefined {
  return preparationFlights.get(storage)?.get(preparationId);
}

async function finishPreparationFlight(
  preparationId: string,
  flights: Map<string, Promise<PreparationResult>>,
  operation: PreparationFlight,
): Promise<PreparationResult> {
  try {
    return await operation();
  } finally {
    flights.delete(preparationId);
  }
}

function isImageInput(input: AttachmentInput): boolean {
  return input.kind === "image";
}

async function readPreparedAttachment(
  archive: R2Bucket,
  key: string,
  attachment: StoredMessageAttachment,
): Promise<Result<PreparedAttachment | null, string>> {
  try {
    const object = await archive.get(key);
    if (object === null) return { ok: true, value: null };
    if (object.size > MESSAGE_PREPARATION_LIMITS.maxOutputBytes + 16_384) {
      return { ok: false, error: "preparation_result_too_large" };
    }
    const raw: unknown = JSON.parse(await object.text());
    if (!isRecord(raw) || !Array.isArray(raw.inputs))
      return { ok: false, error: "preparation_result_invalid" };
    const receipt = validateMessageAttachmentPreparationReceipt(raw.receipt);
    if (
      !receipt.ok ||
      receipt.value.outcome.kind !== "prepared" ||
      receipt.value.outcome.resultObjectKey !== key ||
      receipt.value.identity.sourceSha256 !== attachment.sha256 ||
      receipt.value.identity.attachmentId !== attachment.id ||
      receipt.value.usage.inputBytes !==
        (attachment.byteLength > receipt.value.limits.maxInputBytes
          ? 0
          : attachment.byteLength) ||
      receipt.value.usage.outputBytes !==
        new TextEncoder().encode(JSON.stringify(raw.inputs)).byteLength ||
      (await sha256Hex(JSON.stringify(raw.inputs))) !==
        receipt.value.resultDigest
    ) {
      return { ok: false, error: "preparation_receipt_mismatch" };
    }
    const inputs: AttachmentInput[] = [];
    for (const value of raw.inputs) {
      const parsed = parseAttachmentInput(value, attachment);
      if (parsed === null)
        return { ok: false, error: "preparation_input_invalid" };
      inputs.push(parsed);
    }
    return inputs.length > 0 &&
      inputs.filter(isImageInput).length <= receipt.value.limits.maxFrames
      ? { ok: true, value: { receipt: receipt.value, inputs } }
      : { ok: false, error: "preparation_input_empty" };
  } catch {
    return { ok: false, error: "preparation_result_unavailable" };
  }
}

function parseAttachmentInput(
  value: unknown,
  attachment: StoredMessageAttachment,
): AttachmentInput | null {
  if (!isRecord(value)) return null;
  const stored = parseStoredAttachment(value.attachment);
  if (
    !stored.ok ||
    stored.value.id !== attachment.id ||
    stored.value.sha256 !== attachment.sha256 ||
    stored.value.objectKey !== attachment.objectKey
  )
    return null;
  switch (value.kind) {
    case "image":
      return typeof value.dataUrl === "string" &&
        /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/u.test(
          value.dataUrl,
        ) &&
        value.detail === "original"
        ? {
            kind: "image",
            dataUrl: value.dataUrl,
            detail: "original",
            attachment,
          }
        : null;
    case "attachment_manifest":
      return typeof value.manifest === "string"
        ? { kind: "attachment_manifest", manifest: value.manifest, attachment }
        : null;
    case "attachment_text":
      return typeof value.manifest === "string" &&
        typeof value.text === "string" &&
        typeof value.truncated === "boolean"
        ? {
            kind: "attachment_text",
            manifest: value.manifest,
            text: value.text,
            truncated: value.truncated,
            attachment,
          }
        : null;
    case "attachment_media":
      return typeof value.manifest === "string" &&
        typeof value.summary === "string"
        ? {
            kind: "attachment_media",
            manifest: value.manifest,
            summary: value.summary,
            attachment,
          }
        : null;
    default:
      return null;
  }
}

function failed(
  identity: MessageAttachmentPreparationIdentity,
  reason: string,
): Result<never, MessagePreparationError> {
  return {
    ok: false,
    error: {
      code: "embedded_harness_attachment_preparation_failed",
      attachmentId: identity.attachmentId,
      reason,
    },
  };
}
