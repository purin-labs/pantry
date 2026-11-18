import type {
  MessageAttachmentPreparationIdentity,
  MessageAttachmentPreparationReceipt,
  MessageAttachmentPreparationState,
} from "@seams/contracts";

import {
  validateMessageAttachmentPreparationReceipt,
  validateMessageAttachmentPreparationState,
} from "../messages/message-wasm";
import type { Result } from "../result";
import type { Variant } from "@seams/type-utils";
import { assertNever, isRecord } from "@seams/std";

type MessagePreparationPending = Variant<
  MessageAttachmentPreparationState,
  "pending"
>;

type MessagePreparationCompleted = Variant<
  MessageAttachmentPreparationState,
  "completed"
>;

export type MessagePreparationStoreError =
  | { readonly code: "message_preparation_input_invalid" }
  | { readonly code: "message_preparation_state_invalid" }
  | { readonly code: "message_preparation_receipt_invalid" }
  | { readonly code: "message_preparation_identity_conflict" }
  | { readonly code: "message_preparation_receipt_conflict" }
  | { readonly code: "message_preparation_not_found" }
  | { readonly code: "message_preparation_storage_failed" };

type MessagePreparationRow = Record<string, SqlStorageValue> & {
  readonly organisation_id: string;
  readonly session_id: string;
  readonly turn_id: string;
  readonly attachment_id: string;
  readonly state_json: string;
};

type StoredMessagePreparation = {
  readonly state: MessageAttachmentPreparationState;
  readonly stateJson: string;
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_IDENTITY_TEXT = 256;

export function createMessagePreparationSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_message_preparation (
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      attachment_id TEXT NOT NULL CHECK (length(attachment_id) > 0),
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      PRIMARY KEY (turn_id, attachment_id)
    )`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS session_message_preparation_organisation_session
     ON session_message_preparation (organisation_id, session_id, turn_id)`,
  );
}

export function readMessagePreparation(
  sql: SqlStorage,
  identity: MessageAttachmentPreparationIdentity,
): Result<
  MessageAttachmentPreparationState | null,
  MessagePreparationStoreError
> {
  const stored = readStoredMessagePreparation(sql, identity);
  return stored.ok ? { ok: true, value: stored.value?.state ?? null } : stored;
}

export function beginMessagePreparation(
  sql: SqlStorage,
  pending: MessagePreparationPending,
): Result<MessageAttachmentPreparationState, MessagePreparationStoreError> {
  const validated = validatePending(pending);
  if (!validated.ok) return validated;

  const identity = validated.value.identity;
  try {
    sql.exec(
      `INSERT INTO session_message_preparation (
         organisation_id, session_id, turn_id, attachment_id, state_json
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (turn_id, attachment_id) DO NOTHING`,
      identity.organisationId,
      identity.sessionId,
      identity.turnId,
      identity.attachmentId,
      JSON.stringify(validated.value),
    );
  } catch {
    const raced = readMessagePreparation(sql, identity);
    if (raced.ok && raced.value !== null)
      return { ok: true, value: raced.value };
    if (!raced.ok) return raced;
    return { ok: false, error: { code: "message_preparation_storage_failed" } };
  }

  const stored = readMessagePreparation(sql, identity);
  if (!stored.ok) return stored;
  if (stored.value === null) {
    return { ok: false, error: { code: "message_preparation_storage_failed" } };
  }
  if (!sameIdentity(stored.value, identity)) return identityConflict();
  if (!sameLimits(stored.value, validated.value)) return receiptConflict();
  return { ok: true, value: stored.value };
}

export function completeMessagePreparation(
  sql: SqlStorage,
  receipt: MessageAttachmentPreparationReceipt,
): Result<MessagePreparationCompleted, MessagePreparationStoreError> {
  const validated = validateReceipt(receipt);
  if (!validated.ok) return validated;

  const identity = validated.value.identity;
  const storedPreparation = readStoredMessagePreparation(sql, identity);
  if (!storedPreparation.ok) return storedPreparation;
  if (storedPreparation.value === null) {
    return { ok: false, error: { code: "message_preparation_not_found" } };
  }
  const existing = storedPreparation.value.state;

  if (existing.kind === "completed") {
    return sameReceipt(existing.receipt, validated.value)
      ? { ok: true, value: existing }
      : sameIdentity(existing, validated.value)
        ? { ok: false, error: { code: "message_preparation_receipt_conflict" } }
        : identityConflict();
  }

  if (!sameIdentity(existing, validated.value)) return identityConflict();
  if (!sameLimits(existing, validated.value)) return receiptConflict();
  if (validated.value.completedAt < existing.startedAt) return receiptInvalid();
  if (validated.value.completedAt > existing.deadlineAt)
    return receiptInvalid();
  if (
    validated.value.usage.activeWallMs >
    validated.value.completedAt - existing.startedAt
  ) {
    return receiptInvalid();
  }

  const completed: MessagePreparationCompleted = {
    kind: "completed",
    receipt: validated.value,
  };
  const stateValidation = validateMessageAttachmentPreparationState(completed);
  if (!stateValidation.ok || stateValidation.value.kind !== "completed") {
    return persistedStateInvalid();
  }
  const expectedStateJson = storedPreparation.value.stateJson;
  const completedStateJson = JSON.stringify(stateValidation.value);

  try {
    sql.exec(
      `UPDATE session_message_preparation
          SET state_json = ?
        WHERE turn_id = ? AND attachment_id = ?
          AND organisation_id = ? AND session_id = ?
          AND state_json = ?`,
      completedStateJson,
      identity.turnId,
      identity.attachmentId,
      identity.organisationId,
      identity.sessionId,
      expectedStateJson,
    );
  } catch {
    return { ok: false, error: { code: "message_preparation_storage_failed" } };
  }

  const stored = readMessagePreparation(sql, identity);
  if (!stored.ok) return stored;
  if (
    stored.value?.kind === "completed" &&
    sameReceipt(stored.value.receipt, validated.value)
  ) {
    return { ok: true, value: stored.value };
  }
  if (stored.value === null) {
    return { ok: false, error: { code: "message_preparation_storage_failed" } };
  }
  return { ok: false, error: { code: "message_preparation_receipt_conflict" } };
}

export function listMessagePreparationObjectKeys(
  sql: SqlStorage,
): readonly string[] {
  let rows: readonly MessagePreparationRow[];
  try {
    rows = sql
      .exec<MessagePreparationRow>(
        `SELECT organisation_id, session_id, turn_id, attachment_id, state_json
         FROM session_message_preparation
        ORDER BY turn_id, attachment_id`,
      )
      .toArray();
  } catch {
    throw new Error("message_preparation_storage_failed");
  }

  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const state = parsePersistedState(row);
    if (!state.ok) throw new Error(state.error.code);
    if (!sameRowIdentity(row, state.value))
      throw new Error("message_preparation_state_invalid");
    if (state.value.kind !== "completed") continue;
    for (const key of state.value.receipt.derivedObjectKeys) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

function readMessagePreparationRow(
  sql: SqlStorage,
  identity: MessageAttachmentPreparationIdentity,
): Result<MessagePreparationRow | null, MessagePreparationStoreError> {
  try {
    const row = sql
      .exec<MessagePreparationRow>(
        `SELECT organisation_id, session_id, turn_id, attachment_id, state_json
         FROM session_message_preparation
        WHERE turn_id = ? AND attachment_id = ?
        LIMIT 1`,
        identity.turnId,
        identity.attachmentId,
      )
      .toArray()[0];
    return { ok: true, value: row ?? null };
  } catch {
    return { ok: false, error: { code: "message_preparation_storage_failed" } };
  }
}

function readStoredMessagePreparation(
  sql: SqlStorage,
  identity: MessageAttachmentPreparationIdentity,
): Result<StoredMessagePreparation | null, MessagePreparationStoreError> {
  if (!validIdentity(identity)) return inputInvalid();

  const row = readMessagePreparationRow(sql, identity);
  if (!row.ok) return row;
  if (row.value === null) return { ok: true, value: null };

  const state = parsePersistedState(row.value);
  if (!state.ok) return state;
  if (!sameRowIdentity(row.value, state.value)) return persistedStateInvalid();
  if (!sameIdentity(state.value, identity)) return identityConflict();
  return {
    ok: true,
    value: { state: state.value, stateJson: row.value.state_json },
  };
}

function parsePersistedState(
  row: MessagePreparationRow,
): Result<MessageAttachmentPreparationState, MessagePreparationStoreError> {
  let raw: unknown;
  try {
    raw = JSON.parse(row.state_json);
  } catch {
    return persistedStateInvalid();
  }
  const parsed = validateMessageAttachmentPreparationState(raw);
  return parsed.ok ? parsed : persistedStateInvalid();
}

function validatePending(
  pending: MessagePreparationPending,
): Result<MessagePreparationPending, MessagePreparationStoreError> {
  const parsed = validateMessageAttachmentPreparationState(pending);
  if (!parsed.ok || parsed.value.kind !== "pending") return inputInvalid();
  return { ok: true, value: parsed.value };
}

function validateReceipt(
  receipt: MessageAttachmentPreparationReceipt,
): Result<MessageAttachmentPreparationReceipt, MessagePreparationStoreError> {
  const parsed = validateMessageAttachmentPreparationReceipt(receipt);
  if (!parsed.ok)
    return {
      ok: false,
      error: { code: "message_preparation_receipt_invalid" },
    };
  return { ok: true, value: parsed.value };
}

function sameRowIdentity(
  row: MessagePreparationRow,
  state: MessageAttachmentPreparationState,
): boolean {
  return (
    stateIdentity(state).organisationId === row.organisation_id &&
    stateIdentity(state).sessionId === row.session_id &&
    stateIdentity(state).turnId === row.turn_id &&
    stateIdentity(state).attachmentId === row.attachment_id
  );
}

function sameIdentity(
  left: MessageAttachmentPreparationState | MessageAttachmentPreparationReceipt,
  right:
    | MessageAttachmentPreparationState
    | MessageAttachmentPreparationReceipt
    | MessageAttachmentPreparationIdentity,
): boolean {
  const a = stateIdentity(left);
  const b = stateIdentity(right);
  return (
    a.organisationId === b.organisationId &&
    a.sessionId === b.sessionId &&
    a.turnId === b.turnId &&
    a.attachmentId === b.attachmentId &&
    a.sourceSha256 === b.sourceSha256 &&
    a.handlerRevision === b.handlerRevision
  );
}

function stateIdentity(
  value:
    | MessageAttachmentPreparationState
    | MessageAttachmentPreparationReceipt
    | MessageAttachmentPreparationIdentity,
): MessageAttachmentPreparationIdentity {
  if ("kind" in value) {
    switch (value.kind) {
      case "pending":
        return value.identity;
      case "completed":
        return value.receipt.identity;
      default:
        return assertNever(value);
    }
  }
  return "identity" in value ? value.identity : value;
}

function sameLimits(
  left: MessageAttachmentPreparationState | MessageAttachmentPreparationReceipt,
  right:
    MessageAttachmentPreparationState | MessageAttachmentPreparationReceipt,
): boolean {
  const a = stateLimits(left);
  const b = stateLimits(right);
  return (
    a.maxInputBytes === b.maxInputBytes &&
    a.maxOutputBytes === b.maxOutputBytes &&
    a.maxDurationMs === b.maxDurationMs &&
    a.maxFrames === b.maxFrames
  );
}

function stateLimits(
  value:
    MessageAttachmentPreparationState | MessageAttachmentPreparationReceipt,
): MessageAttachmentPreparationReceipt["limits"] {
  if ("kind" in value) {
    return value.kind === "pending" ? value.limits : value.receipt.limits;
  }
  return value.limits;
}

function sameReceipt(
  left: MessageAttachmentPreparationReceipt,
  right: MessageAttachmentPreparationReceipt,
): boolean {
  return (
    sameIdentity(left, right) &&
    sameLimits(left, right) &&
    left.resultDigest === right.resultDigest &&
    sameStrings(left.derivedObjectKeys, right.derivedObjectKeys) &&
    left.usage.activeWallMs === right.usage.activeWallMs &&
    left.usage.inputBytes === right.usage.inputBytes &&
    left.usage.outputBytes === right.usage.outputBytes &&
    left.completedAt === right.completedAt &&
    sameOutcome(left.outcome, right.outcome)
  );
}

function sameOutcome(
  left: MessageAttachmentPreparationReceipt["outcome"],
  right: MessageAttachmentPreparationReceipt["outcome"],
): boolean {
  switch (left.kind) {
    case "prepared":
      return (
        right.kind === "prepared" &&
        left.resultObjectKey === right.resultObjectKey
      );
    case "limited":
      return right.kind === "limited" && left.reason === right.reason;
    default:
      return assertNever(left);
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function validIdentity(
  identity: MessageAttachmentPreparationIdentity,
): boolean {
  return (
    isRecord(identity) &&
    validIdentityText(identity.organisationId) &&
    validIdentityText(identity.sessionId) &&
    validIdentityText(identity.turnId) &&
    validIdentityText(identity.attachmentId) &&
    validSha256(identity.sourceSha256) &&
    validIdentityText(identity.handlerRevision)
  );
}

function validIdentityText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTITY_TEXT &&
    value === value.trim() &&
    !/\p{Cc}/u.test(value)
  );
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function inputInvalid(): Result<never, MessagePreparationStoreError> {
  return { ok: false, error: { code: "message_preparation_input_invalid" } };
}

function persistedStateInvalid(): Result<never, MessagePreparationStoreError> {
  return { ok: false, error: { code: "message_preparation_state_invalid" } };
}

function identityConflict(): Result<never, MessagePreparationStoreError> {
  return {
    ok: false,
    error: { code: "message_preparation_identity_conflict" },
  };
}

function receiptConflict(): Result<never, MessagePreparationStoreError> {
  return { ok: false, error: { code: "message_preparation_receipt_conflict" } };
}

function receiptInvalid(): Result<never, MessagePreparationStoreError> {
  return { ok: false, error: { code: "message_preparation_receipt_invalid" } };
}
