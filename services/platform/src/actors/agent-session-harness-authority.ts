import {
  deleteSessionSteeringInputs,
  steeringInputAccepts,
} from "./harness-steering";
import { clearPiDurableTables } from "./pi-durable-checkpoint";
import type {
  AcceptedHarnessEventCursor,
  EmbeddedHarnessBackendId,
  HarnessAssistantContent,
  HarnessCheckpointRecord,
  HarnessEventCursor,
  HarnessEventSequence,
  HarnessHistoryContent,
  HarnessTurnLease,
  HarnessTurnLeaseId,
  ProcessingSession,
  Sha256Digest,
  Timestamp,
  TurnIdentity,
} from "@seams/contracts";

import type { Result } from "../result";
import { MAX_CHECKPOINT_PLAINTEXT_BYTES } from "../harness-checkpoint";
import { parseStoredRequestAuthority } from "../request-authority";
import {
  digestHarnessHistoryEntry,
  encodeHarnessHistoryEntry,
  parseHarnessHistoryEntry,
  digestPersistedHarnessHistoryEnvelope,
  type HarnessHistoryAcceptance,
  type HarnessHistoryCursor,
  type HarnessHistoryEntry,
  type HarnessHistoryRead,
} from "./harness-history";
import {
  persistAcceptedHarnessEventProjection,
  prepareAcceptedHarnessEventProjection,
} from "./agent-session-event-stream";
import type { ActiveEmbeddedHarnessBackendId } from "./embedded-harness";
import type { Variant, VariantBy } from "@seams/type-utils";
import {
  assertNever,
  hasExactKeys,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  nonNegativeIntegerOrNull,
} from "@seams/std";

export const MAX_DELIVERY_SEGMENT_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ENCODER = new TextEncoder();
const CHECKPOINT_UPLOAD_CHUNK_BYTES = 1024 * 1024;

// Completed messages occupy one logical row, including their JSON envelope.
export const MAX_HARNESS_HISTORY_ENTRY_BYTES = MAX_DELIVERY_SEGMENT_BYTES;

export const MAX_HARNESS_HISTORY_ENTRIES = 100_000;

export const MAX_HARNESS_HISTORY_BYTES = 256 * 1024 * 1024;

export const MAX_HARNESS_HISTORY_MATERIALIZATION_BYTES = 16 * 1024 * 1024;

export const HARNESS_HISTORY_WARNING_ENTRIES = Math.floor(
  MAX_HARNESS_HISTORY_ENTRIES * 0.8,
);

export const HARNESS_HISTORY_WARNING_BYTES = Math.floor(
  MAX_HARNESS_HISTORY_BYTES * 0.8,
);

export const SESSION_HARNESS_LEASE_COLUMNS = [
  "session_id",
  "organisation_id",
  "lease_id",
  "turn_id",
  "turn_projection",
  "lease_projection",
  "last_sequence",
  "last_event_digest",
  "history_sequence",
  "history_digest",
  "issued_at",
  "expires_at",
  "updated_at",
] as const;

export const SESSION_HARNESS_HISTORY_COLUMNS = [
  "organisation_id",
  "session_id",
  "turn_id",
  "sequence",
  "previous_digest",
  "entry_digest",
  "payload",
  "byte_length",
  "accepted_at",
] as const;

export const SESSION_HARNESS_USAGE_COLUMNS = [
  "session_id",
  "organisation_id",
  "entry_count",
  "inline_byte_count",
  "through_sequence",
] as const;

export const SESSION_HARNESS_CHECKPOINT_COLUMNS = [
  "session_id",
  "turn_id",
  "last_sequence",
  "last_event_digest",
  "checkpoint_projection",
  "committed_at",
  "upload_state",
] as const;

export const TURN_DELIVERY_SEGMENT_COLUMNS = [
  "session_id",
  "turn_id",
  "sequence",
  "event_digest",
  "payload",
  "byte_length",
  "accepted_at",
] as const;

export type HarnessAuthorityStorage = {
  readonly sql: SqlStorage;
  transactionSync<T>(callback: () => T): T;
};

export type HarnessAuthorityError =
  | { code: "invalid_harness_lease" }
  | { code: "harness_lease_conflict" }
  | { code: "harness_lease_missing" }
  | { code: "harness_lease_stale" }
  | { code: "harness_lease_expired" }
  | { code: "harness_event_invalid" }
  | { code: "harness_event_gap" }
  | { code: "harness_event_stale" }
  | { code: "harness_event_divergent_duplicate" }
  | { code: "harness_delivery_segment_too_large" }
  | { code: "harness_history_invalid" }
  | { code: "harness_history_gap" }
  | { code: "harness_history_stale" }
  | { code: "harness_history_divergent_duplicate" }
  | { code: "harness_history_segment_too_large" }
  | {
      code: "harness_history_budget_exceeded";
      limit: "entry_count" | "inline_bytes";
      current: number;
      projected: number;
      maximum: number;
    }
  | { code: "harness_history_order_invalid"; reason: HistoryOrderRejection }
  | { code: "harness_history_cursor_mismatch" }
  | { code: "harness_history_organisation_mismatch" }
  | {
      code: "harness_history_materialization_limit";
      requiredBytes: number;
      allowedBytes: number;
    }
  | { code: "harness_checkpoint_invalid" }
  | { code: "harness_checkpoint_missing" }
  | { code: "harness_checkpoint_cursor_mismatch" }
  | { code: "harness_checkpoint_conflict" };

export type HarnessEventAcceptance =
  | {
      kind: "advanced";
      cursor: Variant<HarnessEventCursor, "accepted">;
    }
  | {
      kind: "duplicate";
      cursor: Variant<HarnessEventCursor, "accepted">;
    };

export type HarnessCheckpointCommit =
  | { kind: "committed"; checkpoint: HarnessCheckpointRecord }
  | { kind: "duplicate"; checkpoint: HarnessCheckpointRecord };

export type HarnessHistoryUsage = {
  readonly entryCount: number;
  readonly inlineBytes: number;
  readonly warning: boolean;
  readonly hardLimit: boolean;
};

export type HarnessHistoryAcceptanceWithUsage = HarnessHistoryAcceptance & {
  readonly usage: HarnessHistoryUsage;
  readonly warningCrossed: boolean;
};

export type HarnessHistoryMaterialization =
  | {
      readonly kind: "empty";
      readonly history: HarnessHistoryRead;
      readonly throughSequence: 0;
      readonly encodedBytes: 0;
    }
  | {
      readonly kind: "bounded_history";
      readonly history: HarnessHistoryRead;
      readonly throughSequence: number;
      readonly encodedBytes: number;
    }
  | {
      readonly kind: "history_materialization_limit";
      readonly requiredBytes: number;
      readonly allowedBytes: number;
    };

export type HarnessHistoryErasure = {
  readonly historyRows: number;
  readonly checkpointRows: number;
  readonly leaseRows: number;
  readonly deliveryRows: number;
  readonly objectKeys: readonly string[];
};

export type StoredHarnessCheckpointInspection =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly checkpoint: HarnessCheckpointRecord }
  | {
      readonly kind: "invalid";
      readonly reason: "malformed_checkpoint";
    };

export type HarnessCheckpointClassification =
  | {
      readonly kind: "compatible";
      readonly checkpoint: HarnessCheckpointRecord;
    }
  | {
      readonly kind: "fresh_lineage_restart";
      readonly reason:
        | "backend_mismatch"
        | "build_mismatch"
        | "format_mismatch"
        | "model_route_digest_mismatch";
    };

export function classifyHarnessCheckpoint(input: {
  readonly checkpoint: HarnessCheckpointRecord;
  readonly backendId: string;
  readonly harnessBuild: string;
  readonly checkpointFormat: string;
  readonly modelRouteDigest: string;
}): HarnessCheckpointClassification {
  if (input.checkpoint.backendId !== input.backendId) {
    return { kind: "fresh_lineage_restart", reason: "backend_mismatch" };
  }
  if (input.checkpoint.blob.harnessBuild !== input.harnessBuild) {
    return { kind: "fresh_lineage_restart", reason: "build_mismatch" };
  }
  if (input.checkpoint.blob.formatVersion !== input.checkpointFormat) {
    return { kind: "fresh_lineage_restart", reason: "format_mismatch" };
  }
  if (input.checkpoint.modelRouteDigest !== input.modelRouteDigest) {
    return {
      kind: "fresh_lineage_restart",
      reason: "model_route_digest_mismatch",
    };
  }
  return { kind: "compatible", checkpoint: input.checkpoint };
}

export type AcceptHarnessEventInput = {
  leaseId: HarnessTurnLeaseId;
  sessionId: string;
  turn: TurnIdentity;
  sequence: HarnessEventSequence;
  eventDigest: Sha256Digest;
  payload: string;
  acceptedAt: Timestamp;
};

export type ActiveHarnessCheckpointRecord = Omit<
  HarnessCheckpointRecord,
  "backendId"
> & {
  readonly backendId: ActiveEmbeddedHarnessBackendId;
};

export type CommitHarnessCheckpointInput = {
  leaseId: HarnessTurnLeaseId;
  checkpoint: ActiveHarnessCheckpointRecord;
  committedAt: Timestamp;
};

export type AppendHarnessHistoryInput = {
  readonly leaseId: HarnessTurnLeaseId;
  readonly sessionId: string;
  readonly turn: TurnIdentity;
  readonly sequence: HarnessEventSequence;
  readonly previousDigest: Sha256Digest | null;
  readonly entry: HarnessHistoryEntry;
  readonly acceptedAt: Timestamp;
};

type HarnessLeaseRow = Record<string, SqlStorageValue> & {
  session_id: string;
  organisation_id: string;
  lease_id: string;
  turn_id: string;
  turn_projection: string;
  lease_projection: string;
  last_sequence: number | null;
  last_event_digest: string | null;
  history_sequence: number | null;
  history_digest: string | null;
  issued_at: number;
  expires_at: number;
  updated_at: number;
};

type DeliverySegmentRow = Record<string, SqlStorageValue> & {
  event_digest: string;
  payload: string;
  byte_length: number;
};

type HistorySegmentRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  session_id: string;
  turn_id: string;
  sequence: number;
  previous_digest: string | null;
  entry_digest: string;
  payload: string;
  byte_length: number;
  accepted_at: number;
};

type HarnessHistoryUsageRow = Record<string, SqlStorageValue> & {
  session_id: string;
  organisation_id: string;
  entry_count: number;
  inline_byte_count: number;
  through_sequence: number;
};

type HistoryMaterializationUsage = {
  readonly entryCount: number;
  readonly inlineBytes: number;
  readonly throughSequence: number;
};

type HarnessCheckpointRow = Record<string, SqlStorageValue> & {
  last_event_digest: string;
  checkpoint_projection: string;
  upload_state: string;
};

export type HarnessCheckpointPublication =
  | {
      readonly kind: "upload_pending";
      readonly checkpoint: HarnessCheckpointRecord;
      readonly payload: ArrayBuffer;
      readonly harnessLease?: never;
    }
  | {
      readonly kind: "published";
      readonly checkpoint: HarnessCheckpointRecord;
      readonly payload?: never;
      readonly harnessLease?: never;
    };

export function createSessionHarnessAuthoritySchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_harness_lease (
      session_id TEXT PRIMARY KEY CHECK (length(session_id) > 0),
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      lease_id TEXT NOT NULL UNIQUE CHECK (length(lease_id) > 0),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      turn_projection TEXT NOT NULL CHECK (json_valid(turn_projection)),
      lease_projection TEXT NOT NULL CHECK (json_valid(lease_projection)),
      last_sequence INTEGER CHECK (last_sequence IS NULL OR last_sequence >= 1),
      last_event_digest TEXT CHECK (
        last_event_digest IS NULL OR
        (length(last_event_digest) = 64 AND last_event_digest NOT GLOB '*[^0-9a-f]*')
      ),
      history_sequence INTEGER CHECK (history_sequence IS NULL OR history_sequence >= 1),
      history_digest TEXT CHECK (
        history_digest IS NULL OR
        (length(history_digest) = 64 AND history_digest NOT GLOB '*[^0-9a-f]*')
      ),
      issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
      expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
      updated_at INTEGER NOT NULL CHECK (updated_at >= issued_at),
      CHECK (
        (last_sequence IS NULL AND last_event_digest IS NULL) OR
        (last_sequence IS NOT NULL AND last_event_digest IS NOT NULL)
      ),
      CHECK (
        (history_sequence IS NULL AND history_digest IS NULL) OR
        (history_sequence IS NOT NULL AND history_digest IS NOT NULL)
      )
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_harness_checkpoint (
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= 1),
      last_event_digest TEXT NOT NULL CHECK (
        length(last_event_digest) = 64 AND last_event_digest NOT GLOB '*[^0-9a-f]*'
      ),
      checkpoint_projection TEXT NOT NULL CHECK (json_valid(checkpoint_projection)),
      committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
      upload_state TEXT NOT NULL DEFAULT 'published' CHECK (upload_state IN ('upload_pending', 'published')),
      PRIMARY KEY (session_id, turn_id, last_sequence)
    )`,
  );
  sql.exec(`CREATE TABLE IF NOT EXISTS session_harness_checkpoint_payload (
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    last_sequence INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    payload BLOB NOT NULL CHECK (length(payload) > 0 AND length(payload) <= 1048576),
    PRIMARY KEY (session_id, turn_id, last_sequence, chunk_index)
  )`);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS turn_delivery_segment (
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      event_digest TEXT NOT NULL CHECK (
        length(event_digest) = 64 AND event_digest NOT GLOB '*[^0-9a-f]*'
      ),
      payload TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (
        byte_length >= 0 AND byte_length <= ${MAX_DELIVERY_SEGMENT_BYTES}
      ),
      accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0),
      PRIMARY KEY (session_id, turn_id, sequence)
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_harness_history (
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      previous_digest TEXT CHECK (
        previous_digest IS NULL OR
        (length(previous_digest) = 64 AND previous_digest NOT GLOB '*[^0-9a-f]*')
      ),
      entry_digest TEXT NOT NULL CHECK (
        length(entry_digest) = 64 AND entry_digest NOT GLOB '*[^0-9a-f]*'
      ),
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      byte_length INTEGER NOT NULL CHECK (
        byte_length >= 0 AND byte_length <= ${MAX_DELIVERY_SEGMENT_BYTES}
      ),
      accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0),
      PRIMARY KEY (session_id, sequence)
    )`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS session_harness_history_turn
     ON session_harness_history (session_id, turn_id, sequence)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_harness_usage (
      session_id TEXT PRIMARY KEY CHECK (length(session_id) > 0),
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      entry_count INTEGER NOT NULL CHECK (entry_count > 0),
      inline_byte_count INTEGER NOT NULL CHECK (inline_byte_count >= 0),
      through_sequence INTEGER NOT NULL CHECK (
        through_sequence > 0 AND through_sequence = entry_count
      )
    )`,
  );
}

export function issueHarnessTurnLease(
  storage: HarnessAuthorityStorage,
  session: ProcessingSession,
  lease: HarnessTurnLease,
  now: Timestamp,
): Result<HarnessTurnLease, HarnessAuthorityError> {
  if (!validHarnessTurnLease(session, lease, now)) {
    return { ok: false, error: { code: "invalid_harness_lease" } };
  }

  return storage.transactionSync(
    issueHarnessTurnLeaseTransaction.bind(null, storage.sql, lease, now),
  );
}

export function issueHarnessTurnLeaseInTransaction(
  sql: SqlStorage,
  session: ProcessingSession,
  lease: HarnessTurnLease,
  now: Timestamp,
): Result<HarnessTurnLease, HarnessAuthorityError> {
  if (!validHarnessTurnLease(session, lease, now)) {
    return { ok: false, error: { code: "invalid_harness_lease" } };
  }
  return issueHarnessTurnLeaseTransaction(sql, lease, now);
}

export function acceptHarnessEvent(
  storage: HarnessAuthorityStorage,
  input: AcceptHarnessEventInput,
): Result<HarnessEventAcceptance, HarnessAuthorityError> {
  if (!validHarnessEventInput(input)) {
    return { ok: false, error: { code: "harness_event_invalid" } };
  }
  const byteLength = ENCODER.encode(input.payload).byteLength;
  if (byteLength > MAX_DELIVERY_SEGMENT_BYTES) {
    return { ok: false, error: { code: "harness_delivery_segment_too_large" } };
  }

  return storage.transactionSync(
    acceptHarnessEventTransaction.bind(null, storage.sql, input, byteLength),
  );
}

export async function appendHarnessHistory(
  storage: HarnessAuthorityStorage,
  input: AppendHarnessHistoryInput,
): Promise<Result<HarnessHistoryAcceptanceWithUsage, HarnessAuthorityError>> {
  if (!validHarnessHistoryInput(input)) {
    return { ok: false, error: { code: "harness_history_invalid" } };
  }
  const payload = encodeHarnessHistoryEntry(input.entry);
  const byteLength = ENCODER.encode(payload).byteLength;
  if (byteLength > MAX_DELIVERY_SEGMENT_BYTES) {
    return { ok: false, error: { code: "harness_history_segment_too_large" } };
  }
  const entryDigest = await digestHarnessHistoryEntry({
    sessionId: input.sessionId,
    sequence: input.sequence,
    previousDigest: input.previousDigest,
    entry: input.entry,
  });
  return storage.transactionSync(
    appendHarnessHistoryTransaction.bind(
      null,
      storage.sql,
      input,
      payload,
      byteLength,
      entryDigest,
    ),
  );
}

export function readHarnessHistoryUsage(
  sql: SqlStorage,
  sessionId: string,
  organisationId: string,
): Result<HarnessHistoryUsage, HarnessAuthorityError> {
  if (!nonEmpty(sessionId) || !nonEmpty(organisationId)) {
    return { ok: false, error: { code: "harness_history_invalid" } };
  }
  return { ok: true, value: readHistoryUsage(sql, sessionId, organisationId) };
}

export async function readHarnessHistory(
  sql: SqlStorage,
  sessionId: string,
  organisationId: string,
  throughSequence?: number,
): Promise<Result<HarnessHistoryMaterialization, HarnessAuthorityError>> {
  if (
    !nonEmpty(sessionId) ||
    !nonEmpty(organisationId) ||
    (throughSequence !== undefined && !isPositiveInteger(throughSequence))
  ) {
    return { ok: false, error: { code: "harness_history_invalid" } };
  }
  const materializationResult = readHistoryMaterializationUsage(
    sql,
    sessionId,
    organisationId,
    throughSequence,
  );
  if (!materializationResult.ok) {
    return materializationResult;
  }
  const materialization = materializationResult.value;
  if (materialization.inlineBytes > MAX_HARNESS_HISTORY_MATERIALIZATION_BYTES) {
    return {
      ok: true,
      value: {
        kind: "history_materialization_limit",
        requiredBytes: materialization.inlineBytes,
        allowedBytes: MAX_HARNESS_HISTORY_MATERIALIZATION_BYTES,
      },
    };
  }
  // Capture the same prefix as the usage counters before asynchronous hashing.
  const rows = sql
    .exec<HistorySegmentRow>(
      `SELECT organisation_id, session_id, turn_id, sequence, previous_digest, entry_digest,
            payload, byte_length, accepted_at
     FROM session_harness_history
     WHERE session_id = ? AND (? IS NULL OR sequence <= ?)
     ORDER BY sequence`,
      sessionId,
      throughSequence ?? null,
      throughSequence ?? null,
    )
    .toArray();
  const entries: HarnessHistoryEntry[] = [];
  let previousDigest: string | null = null;
  let expectedSequence = 1;
  let cursor: HarnessHistoryCursor | null = null;
  let encodedBytes = 0;
  let entryCount = 0;
  for (const row of rows) {
    if (row.session_id !== sessionId || !nonEmpty(row.organisation_id)) {
      return { ok: false, error: { code: "harness_history_cursor_mismatch" } };
    }
    if (row.organisation_id !== organisationId) {
      return {
        ok: false,
        error: { code: "harness_history_organisation_mismatch" },
      };
    }
    if (
      row.sequence !== expectedSequence ||
      row.previous_digest !== previousDigest ||
      !SHA256_PATTERN.test(row.entry_digest)
    ) {
      return { ok: false, error: { code: "harness_history_cursor_mismatch" } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      return { ok: false, error: { code: "harness_history_invalid" } };
    }
    const entry = parseHarnessHistoryEntry(parsed);
    if (
      entry === null ||
      ENCODER.encode(row.payload).byteLength !== row.byte_length
    ) {
      return { ok: false, error: { code: "harness_history_invalid" } };
    }
    entries.push(entry);
    if (entry.turn.turnId !== row.turn_id) {
      return { ok: false, error: { code: "harness_history_cursor_mismatch" } };
    }
    const recomputed = await digestPersistedHarnessHistoryEnvelope({
      sessionId,
      sequence: row.sequence,
      previousDigest,
      envelope: parsed,
    });
    if (recomputed !== row.entry_digest) {
      return { ok: false, error: { code: "harness_history_cursor_mismatch" } };
    }
    previousDigest = row.entry_digest;
    expectedSequence += 1;
    encodedBytes += row.byte_length;
    entryCount += 1;
    cursor = {
      lastSequence: row.sequence,
      lastEntryDigest: row.entry_digest,
    };
  }
  if (
    encodedBytes !== materialization.inlineBytes ||
    entryCount !== materialization.entryCount ||
    (cursor?.lastSequence ?? 0) !== materialization.throughSequence
  ) {
    return { ok: false, error: { code: "harness_history_cursor_mismatch" } };
  }
  if (cursor === null) {
    return {
      ok: true,
      value: {
        kind: "empty",
        history: { cursor: null, entries },
        throughSequence: 0,
        encodedBytes: 0,
      },
    };
  }
  return {
    ok: true,
    value: {
      kind: "bounded_history",
      history: { cursor, entries },
      throughSequence: cursor.lastSequence,
      encodedBytes,
    },
  };
}

/** Returns content-addressed objects held only by accepted private history. */
export function listHarnessHistoryObjectKeys(
  sql: SqlStorage,
): readonly string[] {
  const rows = sql
    .exec<Record<string, SqlStorageValue> & { payload: string }>(
      `SELECT payload
     FROM session_harness_history
     ORDER BY session_id, sequence`,
    )
    .toArray();
  const keys: string[] = [];
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.payload);
    } catch {
      throw new Error("harness_history_payload_invalid");
    }
    const entry = parseHarnessHistoryEntry(raw);
    if (entry === null) {
      throw new Error("harness_history_payload_invalid");
    }
    collectHistoryObjectKeys(entry, keys);
  }
  return keys;
}

/**
 * Removes only Actor-owned private history state. The caller owns the returned
 * object keys and deletes them through the existing reachability inventory.
 */
export function eraseHarnessHistoryForOrganisation(
  storage: HarnessAuthorityStorage,
  organisationId: string,
): Result<HarnessHistoryErasure, HarnessAuthorityError> {
  if (!nonEmpty(organisationId)) {
    return { ok: false, error: { code: "harness_history_invalid" } };
  }
  return storage.transactionSync(() =>
    eraseHarnessHistoryForOrganisationTransaction(storage.sql, organisationId),
  );
}

function eraseHarnessHistoryForOrganisationTransaction(
  sql: SqlStorage,
  organisationId: string,
): Result<HarnessHistoryErasure, HarnessAuthorityError> {
  const objectKeys = dedupeObjectKeys([
    ...listHarnessHistoryObjectKeysForOrganisation(sql, organisationId),
    ...listHarnessCheckpointObjectKeysForOrganisation(sql, organisationId),
  ]);
  const sessions = new Set(
    sql
      .exec<Record<string, SqlStorageValue> & { session_id: string }>(
        `SELECT session_id
     FROM session_harness_history
     WHERE organisation_id = ?
     UNION
     SELECT session_id
     FROM session_harness_lease
     WHERE organisation_id = ?`,
        organisationId,
        organisationId,
      )
      .toArray()
      .map((row) => row.session_id)
      .filter(nonEmpty),
  );
  for (const sessionId of listHarnessCheckpointSessionIdsForOrganisation(
    sql,
    organisationId,
  )) {
    sessions.add(sessionId);
  }
  if (sessions.size > 0) clearPiDurableTables(sql);
  const historyRows = deleteHarnessRows(
    sql,
    `SELECT COUNT(*) AS count FROM session_harness_history WHERE organisation_id = ?`,
    `DELETE FROM session_harness_history WHERE organisation_id = ?`,
    organisationId,
  );
  let checkpointRows = 0;
  for (const sessionId of sessions) {
    sql.exec(
      "DELETE FROM session_harness_checkpoint_payload WHERE session_id = ?",
      sessionId,
    );
    checkpointRows += deleteHarnessRows(
      sql,
      `SELECT COUNT(*) AS count FROM session_harness_checkpoint WHERE session_id = ?`,
      `DELETE FROM session_harness_checkpoint WHERE session_id = ?`,
      sessionId,
    );
    sql.exec(
      `DELETE FROM session_harness_usage WHERE session_id = ?`,
      sessionId,
    );
    deleteSessionSteeringInputs(sql, sessionId);
  }
  const leaseRows = deleteHarnessRows(
    sql,
    `SELECT COUNT(*) AS count FROM session_harness_lease WHERE organisation_id = ?`,
    `DELETE FROM session_harness_lease WHERE organisation_id = ?`,
    organisationId,
  );
  let deliveryRows = 0;
  for (const sessionId of sessions) {
    deliveryRows += deleteHarnessRows(
      sql,
      `SELECT COUNT(*) AS count FROM turn_delivery_segment WHERE session_id = ?`,
      `DELETE FROM turn_delivery_segment WHERE session_id = ?`,
      sessionId,
    );
  }
  return {
    ok: true,
    value: {
      historyRows,
      checkpointRows,
      leaseRows,
      deliveryRows,
      objectKeys,
    },
  };
}

function deleteHarnessRows(
  sql: SqlStorage,
  countQuery: string,
  deleteQuery: string,
  ...args: SqlStorageValue[]
): number {
  const count =
    sql
      .exec<Record<string, SqlStorageValue> & { count: number }>(
        countQuery,
        ...args,
      )
      .toArray()[0]?.count ?? 0;
  sql.exec(deleteQuery, ...args);
  return typeof count === "number" ? count : 0;
}

export function preflightHarnessTurnLease(
  storage: HarnessAuthorityStorage,
  lease: HarnessTurnLease,
  now: Timestamp,
): Result<HarnessTurnLease, HarnessAuthorityError> {
  if (!validPersistedHarnessTurnLease(lease) || !isNonNegativeInteger(now)) {
    return { ok: false, error: { code: "invalid_harness_lease" } };
  }

  return storage.transactionSync(
    preflightHarnessTurnLeaseTransaction.bind(null, storage.sql, lease, now),
  );
}

export function parsePersistedHarnessTurnLease(
  raw: unknown,
): HarnessTurnLease | null {
  if (
    !isRecord(raw) ||
    !isRecord(raw.session) ||
    !isRecord(raw.turn) ||
    !isRecord(raw.runtimeLease) ||
    !isRecord(raw.requestAuthority)
  ) {
    return null;
  }
  if (
    !hasExactKeys(raw, [
      "leaseId",
      "session",
      "turn",
      "runtimeLease",
      "runtimeRevision",
      "requestAuthority",
      "authorityPartitionDigest",
      "issuedAt",
      "expiresAt",
    ]) ||
    !hasExactKeys(raw.session, ["organisationId", "sessionId", "streamId"]) ||
    !hasExactKeys(raw.turn, [
      "turnId",
      "inputId",
      "turnLeaseGeneration",
      "budgetRevision",
    ]) ||
    !hasExactKeys(raw.runtimeLease, ["generation", "leaseId"])
  ) {
    return null;
  }
  const leaseId = stringValue(raw.leaseId);
  const organisationId = stringValue(raw.session.organisationId);
  const sessionId = stringValue(raw.session.sessionId);
  const streamId = stringValue(raw.session.streamId);
  const turnId = stringValue(raw.turn.turnId);
  const inputId = stringValue(raw.turn.inputId);
  const turnLeaseGeneration = nonNegativeIntegerOrNull(
    raw.turn.turnLeaseGeneration,
  );
  const budgetRevision = stringValue(raw.turn.budgetRevision);
  const runtimeGeneration = nonNegativeIntegerOrNull(
    raw.runtimeLease.generation,
  );
  const runtimeLeaseId = stringValue(raw.runtimeLease.leaseId);
  const runtimeRevision = stringValue(raw.runtimeRevision);
  const requestAuthority = parseStoredRequestAuthority(raw.requestAuthority);
  const authorityPartitionDigest = sha256Value(raw.authorityPartitionDigest);
  const issuedAt = nonNegativeIntegerOrNull(raw.issuedAt);
  const expiresAt = nonNegativeIntegerOrNull(raw.expiresAt);
  if (
    leaseId === null ||
    organisationId === null ||
    sessionId === null ||
    streamId === null ||
    turnId === null ||
    inputId === null ||
    turnLeaseGeneration === null ||
    budgetRevision === null ||
    runtimeGeneration === null ||
    runtimeLeaseId === null ||
    runtimeRevision === null ||
    !requestAuthority.ok ||
    authorityPartitionDigest === null ||
    issuedAt === null ||
    expiresAt === null
  ) {
    return null;
  }
  const parsed: HarnessTurnLease = {
    leaseId,
    session: { organisationId, sessionId, streamId },
    turn: { turnId, inputId, turnLeaseGeneration, budgetRevision },
    runtimeLease: { generation: runtimeGeneration, leaseId: runtimeLeaseId },
    runtimeRevision,
    requestAuthority: requestAuthority.value.requestAuthority,
    authorityPartitionDigest,
    issuedAt,
    expiresAt,
  };
  return validPersistedHarnessTurnLease(parsed) ? parsed : null;
}

export function preflightHarnessTurnLeaseInTransaction(
  sql: SqlStorage,
  lease: HarnessTurnLease,
  now: Timestamp,
): Result<HarnessTurnLease, HarnessAuthorityError> {
  if (!validPersistedHarnessTurnLease(lease) || !isNonNegativeInteger(now)) {
    return { ok: false, error: { code: "invalid_harness_lease" } };
  }
  return preflightHarnessTurnLeaseTransaction(sql, lease, now);
}

/**
 * Close the turn of an accepted checkpoint. The checkpoint and its payload
 * are in this Session's storage. Its archive write may still be pending:
 * the Session publishes it after the turn and before the next one.
 */
export function closeCommittedHarnessTurnInTransaction(
  sql: SqlStorage,
  checkpoint: HarnessCheckpointRecord,
): Result<HarnessCheckpointRecord, HarnessAuthorityError> {
  if (!validCheckpointRecord(checkpoint)) {
    return { ok: false, error: { code: "harness_checkpoint_invalid" } };
  }
  const persistedLease = readHarnessLease(sql, checkpoint.session.sessionId);
  if (
    persistedLease !== undefined &&
    !checkpointMatchesLease(checkpoint, persistedLease.lease_projection)
  ) {
    return { ok: false, error: { code: "harness_checkpoint_conflict" } };
  }
  const persistedCheckpoint = readHarnessCheckpoint(
    sql,
    checkpoint.session.sessionId,
    checkpoint.cursor.turn.turnId,
    checkpoint.cursor.lastSequence,
  );
  if (persistedCheckpoint === undefined) {
    return { ok: false, error: { code: "harness_checkpoint_missing" } };
  }
  if (
    persistedCheckpoint.last_event_digest !==
      checkpoint.cursor.lastEventDigest ||
    persistedCheckpoint.checkpoint_projection !== JSON.stringify(checkpoint)
  ) {
    return { ok: false, error: { code: "harness_checkpoint_conflict" } };
  }
  sql.exec(
    `DELETE FROM session_harness_lease
     WHERE session_id = ?`,
    checkpoint.session.sessionId,
  );
  if (readHarnessLease(sql, checkpoint.session.sessionId) !== undefined) {
    throw new Error("harness_lease_close_failed");
  }
  return { ok: true, value: checkpoint };
}

export function fenceHarnessTurnLeaseInTransaction(
  sql: SqlStorage,
  lease: HarnessTurnLease,
): Result<null, HarnessAuthorityError> {
  if (!validPersistedHarnessTurnLease(lease)) {
    return { ok: false, error: { code: "invalid_harness_lease" } };
  }
  const persisted = readHarnessLease(sql, lease.session.sessionId);
  if (persisted === undefined) {
    return { ok: false, error: { code: "harness_lease_missing" } };
  }
  if (!storedLeaseMatches(persisted.lease_projection, lease)) {
    return { ok: false, error: { code: "harness_lease_stale" } };
  }
  sql.exec(
    `DELETE FROM session_harness_lease
     WHERE session_id = ? AND lease_id = ?`,
    lease.session.sessionId,
    lease.leaseId,
  );
  if (readHarnessLease(sql, lease.session.sessionId) !== undefined) {
    throw new Error("harness_lease_fence_failed");
  }
  return { ok: true, value: null };
}

export function commitHarnessCheckpoint(
  storage: HarnessAuthorityStorage,
  input: CommitHarnessCheckpointInput,
): Result<HarnessCheckpointCommit, HarnessAuthorityError> {
  if (!validCheckpointInput(input)) {
    return { ok: false, error: { code: "harness_checkpoint_invalid" } };
  }

  return storage.transactionSync(
    commitHarnessCheckpointTransaction.bind(null, storage.sql, input),
  );
}

export function preflightHarnessCheckpoint(
  storage: HarnessAuthorityStorage,
  input: CommitHarnessCheckpointInput,
): Result<HarnessCheckpointCommit | { kind: "ready" }, HarnessAuthorityError> {
  if (!validCheckpointInput(input)) {
    return { ok: false, error: { code: "harness_checkpoint_invalid" } };
  }

  return storage.transactionSync(
    preflightHarnessCheckpointTransaction.bind(null, storage.sql, input),
  );
}

export function canonicalHarnessCheckpointObjectKey(input: {
  organisationId: string;
  sessionId: string;
  cursor: AcceptedHarnessEventCursor;
  sha256: Sha256Digest;
}): string {
  return [
    "harness-checkpoints",
    encodeURIComponent(input.organisationId),
    encodeURIComponent(input.sessionId),
    encodeURIComponent(input.cursor.turn.turnId),
    `sequence-${input.cursor.lastSequence}`,
    `${input.sha256}.bin`,
  ].join("/");
}

export function listHarnessCheckpointObjectKeys(
  sql: SqlStorage,
): readonly string[] {
  const rows = sql
    .exec<Record<string, SqlStorageValue> & { checkpoint_projection: string }>(
      `SELECT checkpoint_projection
     FROM session_harness_checkpoint
     ORDER BY session_id, turn_id, last_sequence`,
    )
    .toArray();
  const keys: string[] = [];
  for (const row of rows) {
    const objectKey = parseCheckpointObjectKey(row.checkpoint_projection);
    if (!keys.includes(objectKey)) {
      keys.push(objectKey);
    }
  }
  return keys;
}

export function readLatestHarnessCheckpoint(
  sql: SqlStorage,
  sessionId: string,
): Result<HarnessCheckpointRecord, HarnessAuthorityError> {
  const inspected = inspectLatestStoredHarnessCheckpoint(sql, sessionId);
  switch (inspected.kind) {
    case "missing":
      return { ok: false, error: { code: "harness_checkpoint_missing" } };
    case "invalid":
      return { ok: false, error: { code: "harness_checkpoint_invalid" } };
    case "valid":
      return { ok: true, value: inspected.checkpoint };
  }
}

export function readHarnessCheckpointPublication(
  sql: SqlStorage,
  checkpoint: HarnessCheckpointRecord,
): Result<HarnessCheckpointPublication, HarnessAuthorityError> {
  const row = readHarnessCheckpoint(
    sql,
    checkpoint.session.sessionId,
    checkpoint.turn.turnId,
    checkpoint.cursor.lastSequence,
  );
  if (row === undefined)
    return { ok: false, error: { code: "harness_checkpoint_missing" } };
  if (row.checkpoint_projection !== JSON.stringify(checkpoint))
    return { ok: false, error: { code: "harness_checkpoint_conflict" } };
  if (row.upload_state === "published")
    return { ok: true, value: { kind: "published", checkpoint } };
  if (row.upload_state !== "upload_pending")
    return { ok: false, error: { code: "harness_checkpoint_invalid" } };
  const payload = readStoredCheckpointPayload(sql, checkpoint);
  if (payload === null)
    return { ok: false, error: { code: "harness_checkpoint_invalid" } };
  return { ok: true, value: { kind: "upload_pending", checkpoint, payload } };
}

/**
 * The payload the Session keeps for this checkpoint, or null when it keeps
 * none. The Session keeps the payload of its latest checkpoint, so that a turn
 * restores without a read of the archive. The caller compares the bytes with
 * the checkpoint's digest before it uses them.
 */
export function readRetainedHarnessCheckpointPayload(
  sql: SqlStorage,
  checkpoint: HarnessCheckpointRecord,
): ArrayBuffer | null {
  const row = readHarnessCheckpoint(
    sql,
    checkpoint.session.sessionId,
    checkpoint.turn.turnId,
    checkpoint.cursor.lastSequence,
  );
  if (
    row === undefined ||
    row.checkpoint_projection !== JSON.stringify(checkpoint)
  )
    return null;
  return readStoredCheckpointPayload(sql, checkpoint);
}

function readStoredCheckpointPayload(
  sql: SqlStorage,
  checkpoint: HarnessCheckpointRecord,
): ArrayBuffer | null {
  if (checkpoint.blob.byteLength > MAX_CHECKPOINT_PLAINTEXT_BYTES) return null;
  const chunks = sql
    .exec<
      Record<string, SqlStorageValue> & {
        chunk_index: number;
        payload: ArrayBuffer;
      }
    >(
      `SELECT chunk_index, payload FROM session_harness_checkpoint_payload
     WHERE session_id = ? AND turn_id = ? AND last_sequence = ? ORDER BY chunk_index`,
      checkpoint.session.sessionId,
      checkpoint.turn.turnId,
      checkpoint.cursor.lastSequence,
    )
    .toArray();
  const expectedChunks = Math.ceil(
    checkpoint.blob.byteLength / CHECKPOINT_UPLOAD_CHUNK_BYTES,
  );
  if (chunks.length !== expectedChunks) return null;
  const bytes = new Uint8Array(checkpoint.blob.byteLength);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const offset = index * CHECKPOINT_UPLOAD_CHUNK_BYTES;
    const size = Math.min(
      CHECKPOINT_UPLOAD_CHUNK_BYTES,
      bytes.byteLength - offset,
    );
    if (
      chunk === undefined ||
      chunk.chunk_index !== index ||
      !(chunk.payload instanceof ArrayBuffer) ||
      chunk.payload.byteLength !== size
    )
      return null;
    bytes.set(new Uint8Array(chunk.payload), offset);
  }
  return bytes.buffer;
}

/**
 * Delete each payload that the archive holds. A payload that still waits for
 * its archive write stays. The Session calls this when it accepts its next
 * checkpoint, and before an export, which carries no copy of an archive
 * object.
 */
export function dropArchivedHarnessCheckpointPayloads(sql: SqlStorage): void {
  sql.exec(
    `DELETE FROM session_harness_checkpoint_payload
    WHERE NOT EXISTS (
      SELECT 1 FROM session_harness_checkpoint AS pending
      WHERE pending.session_id = session_harness_checkpoint_payload.session_id
        AND pending.turn_id = session_harness_checkpoint_payload.turn_id
        AND pending.last_sequence = session_harness_checkpoint_payload.last_sequence
        AND pending.upload_state = 'upload_pending'
    )`,
  );
}

/**
 * The checkpoint whose payload the archive does not hold yet, with that
 * payload. A Session has one at most: a turn starts only after the last
 * checkpoint is published.
 */
export function readUnpublishedHarnessCheckpoint(
  sql: SqlStorage,
): Result<
  Extract<HarnessCheckpointPublication, { kind: "upload_pending" }> | null,
  HarnessAuthorityError
> {
  const row = sql
    .exec<Record<string, SqlStorageValue> & { checkpoint_projection: string }>(
      `SELECT checkpoint_projection
     FROM session_harness_checkpoint
     WHERE upload_state = 'upload_pending'
     ORDER BY committed_at DESC, last_sequence DESC
     LIMIT 1`,
    )
    .toArray()[0];
  if (row === undefined) return { ok: true, value: null };
  const inspected = parseStoredHarnessCheckpointRecord(
    row.checkpoint_projection,
  );
  if (inspected.kind !== "valid")
    return { ok: false, error: { code: "harness_checkpoint_invalid" } };
  const publication = readHarnessCheckpointPublication(
    sql,
    inspected.checkpoint,
  );
  if (!publication.ok) return publication;
  return {
    ok: true,
    value:
      publication.value.kind === "upload_pending" ? publication.value : null,
  };
}

/** Whether a checkpoint of this Session still waits for its archive write. */
export function hasUnpublishedHarnessCheckpoint(sql: SqlStorage): boolean {
  return (
    sql
      .exec(
        "SELECT 1 FROM session_harness_checkpoint WHERE upload_state = 'upload_pending' LIMIT 1",
      )
      .toArray().length === 1
  );
}

export function retainHarnessCheckpointUploadInTransaction(
  sql: SqlStorage,
  checkpoint: HarnessCheckpointRecord,
  payload: ArrayBuffer,
): Result<null, HarnessAuthorityError> {
  if (
    payload.byteLength !== checkpoint.blob.byteLength ||
    payload.byteLength === 0
  )
    return { ok: false, error: { code: "harness_checkpoint_invalid" } };
  if (payload.byteLength > MAX_CHECKPOINT_PLAINTEXT_BYTES)
    return { ok: false, error: { code: "harness_checkpoint_invalid" } };
  // The Session keeps one payload: that of its latest checkpoint.
  dropArchivedHarnessCheckpointPayloads(sql);
  for (
    let offset = 0;
    offset < payload.byteLength;
    offset += CHECKPOINT_UPLOAD_CHUNK_BYTES
  ) {
    sql.exec(
      `INSERT INTO session_harness_checkpoint_payload
      (session_id, turn_id, last_sequence, chunk_index, payload) VALUES (?, ?, ?, ?, ?)`,
      checkpoint.session.sessionId,
      checkpoint.turn.turnId,
      checkpoint.cursor.lastSequence,
      offset / CHECKPOINT_UPLOAD_CHUNK_BYTES,
      payload.slice(offset, offset + CHECKPOINT_UPLOAD_CHUNK_BYTES),
    );
  }
  sql.exec(
    `UPDATE session_harness_checkpoint SET upload_state = 'upload_pending'
    WHERE session_id = ? AND turn_id = ? AND last_sequence = ? AND checkpoint_projection = ?`,
    checkpoint.session.sessionId,
    checkpoint.turn.turnId,
    checkpoint.cursor.lastSequence,
    JSON.stringify(checkpoint),
  );
  const publication = readHarnessCheckpointPublication(sql, checkpoint);
  return publication.ok && publication.value.kind === "upload_pending"
    ? { ok: true, value: null }
    : { ok: false, error: { code: "harness_checkpoint_conflict" } };
}

export function markHarnessCheckpointPublishedInTransaction(
  sql: SqlStorage,
  publication: Extract<
    HarnessCheckpointPublication,
    { kind: "upload_pending" }
  >,
): Result<HarnessCheckpointRecord, HarnessAuthorityError> {
  const saved = readHarnessCheckpointPublication(sql, publication.checkpoint);
  if (!saved.ok) return saved;
  if (saved.value.kind !== "upload_pending")
    return { ok: true, value: saved.value.checkpoint };
  const checkpoint = publication.checkpoint;
  sql.exec(
    `UPDATE session_harness_checkpoint SET upload_state = 'published'
    WHERE session_id = ? AND turn_id = ? AND last_sequence = ? AND upload_state = 'upload_pending'`,
    checkpoint.session.sessionId,
    checkpoint.turn.turnId,
    checkpoint.cursor.lastSequence,
  );
  // The payload stays: the next turn restores from it.
  const published = readHarnessCheckpointPublication(sql, checkpoint);
  return published.ok && published.value.kind === "published"
    ? { ok: true, value: checkpoint }
    : { ok: false, error: { code: "harness_checkpoint_conflict" } };
}

export function inspectLatestStoredHarnessCheckpoint(
  sql: SqlStorage,
  sessionId: string,
): StoredHarnessCheckpointInspection {
  const row = sql
    .exec<Record<string, SqlStorageValue> & { checkpoint_projection: string }>(
      `SELECT checkpoint_projection
     FROM session_harness_checkpoint
     WHERE session_id = ?
     ORDER BY committed_at DESC, last_sequence DESC
     LIMIT 1`,
      sessionId,
    )
    .toArray()[0];
  if (row === undefined) {
    return { kind: "missing" };
  }
  return parseStoredHarnessCheckpointRecord(row.checkpoint_projection);
}

function issueHarnessTurnLeaseTransaction(
  sql: SqlStorage,
  lease: HarnessTurnLease,
  now: Timestamp,
): Result<HarnessTurnLease, HarnessAuthorityError> {
  const existing = readHarnessLease(sql, lease.session.sessionId);
  const projection = JSON.stringify(lease);
  if (existing !== undefined && existing.expires_at > now) {
    return storedLeaseMatches(existing.lease_projection, lease)
      ? { ok: true, value: lease }
      : { ok: false, error: { code: "harness_lease_conflict" } };
  }

  const historyHead = readHistoryHead(sql, lease.session.sessionId);
  const deliveryHead = sql
    .exec<{ sequence: number; event_digest: string }>(
      `SELECT sequence, event_digest FROM turn_delivery_segment
     WHERE session_id = ? AND turn_id = ? ORDER BY sequence DESC LIMIT 1`,
      lease.session.sessionId,
      lease.turn.turnId,
    )
    .toArray()[0];

  sql.exec(
    `INSERT INTO session_harness_lease (
       session_id, organisation_id, lease_id, turn_id, turn_projection, lease_projection,
       last_sequence, last_event_digest, issued_at, expires_at, updated_at
       , history_sequence, history_digest
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       organisation_id = excluded.organisation_id,
       lease_id = excluded.lease_id,
       turn_id = excluded.turn_id,
       turn_projection = excluded.turn_projection,
       lease_projection = excluded.lease_projection,
       last_sequence = excluded.last_sequence,
       last_event_digest = excluded.last_event_digest,
       history_sequence = excluded.history_sequence,
       history_digest = excluded.history_digest,
       issued_at = excluded.issued_at,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
    lease.session.sessionId,
    lease.session.organisationId,
    lease.leaseId,
    lease.turn.turnId,
    JSON.stringify(lease.turn),
    projection,
    deliveryHead?.sequence ?? null,
    deliveryHead?.event_digest ?? null,
    lease.issuedAt,
    lease.expiresAt,
    now,
    historyHead?.sequence ?? null,
    historyHead?.entry_digest ?? null,
  );
  return { ok: true, value: lease };
}

function appendHarnessHistoryTransaction(
  sql: SqlStorage,
  input: AppendHarnessHistoryInput,
  payload: string,
  byteLength: number,
  entryDigest: Sha256Digest,
): Result<HarnessHistoryAcceptanceWithUsage, HarnessAuthorityError> {
  const lease = readHarnessLease(sql, input.sessionId);
  const leaseError = validateCurrentLease(
    lease,
    input.leaseId,
    input.acceptedAt,
  );
  if (leaseError !== null) {
    return { ok: false, error: leaseError };
  }
  if (
    lease === undefined ||
    lease.turn_projection !== JSON.stringify(input.turn)
  ) {
    return { ok: false, error: { code: "harness_lease_stale" } };
  }
  const current = lease.history_sequence;
  const usageState = readHistoryUsageState(
    sql,
    input.sessionId,
    lease.organisation_id,
  );
  if (usageState.throughSequence !== (current ?? 0)) {
    throw new Error("harness_history_usage_cursor_mismatch");
  }
  if (current !== null && input.sequence === current) {
    const existing = readHistorySegment(sql, input.sessionId, input.sequence);
    return existing !== undefined &&
      existing.entry_digest === entryDigest &&
      existing.previous_digest === input.previousDigest &&
      existing.payload === payload
      ? existing.byte_length === byteLength
        ? {
            ok: true,
            value: {
              kind: "duplicate",
              cursor: historyCursor(input.sequence, entryDigest),
              usage: historyUsage(usageState),
              warningCrossed: false,
            },
          }
        : { ok: false, error: { code: "harness_history_divergent_duplicate" } }
      : { ok: false, error: { code: "harness_history_divergent_duplicate" } };
  }
  const expected = current === null ? 1 : current + 1;
  if (input.sequence < expected) {
    return { ok: false, error: { code: "harness_history_stale" } };
  }
  if (
    input.sequence > expected ||
    input.previousDigest !== (lease.history_digest ?? null)
  ) {
    return { ok: false, error: { code: "harness_history_gap" } };
  }
  const orderRejection = historySemanticOrderRejection(
    sql,
    input.sessionId,
    input.entry,
  );
  if (orderRejection !== null) {
    return {
      ok: false,
      error: { code: "harness_history_order_invalid", reason: orderRejection },
    };
  }
  const usage = historyUsage(usageState);
  const projectedUsage = {
    entryCount: usage.entryCount + 1,
    inlineBytes: usage.inlineBytes + byteLength,
  };
  const budget = historyBudgetViolation(usage, projectedUsage);
  if (budget !== null) {
    return { ok: false, error: budget };
  }
  sql.exec(
    `INSERT INTO session_harness_history (
       organisation_id, session_id, turn_id, sequence, previous_digest, entry_digest,
       payload, byte_length, accepted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    lease.organisation_id,
    input.sessionId,
    input.turn.turnId,
    input.sequence,
    input.previousDigest,
    entryDigest,
    payload,
    byteLength,
    input.acceptedAt,
  );
  sql.exec(
    `INSERT INTO session_harness_usage (
       session_id, organisation_id, entry_count, inline_byte_count, through_sequence
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       entry_count = excluded.entry_count,
       inline_byte_count = excluded.inline_byte_count,
       through_sequence = excluded.through_sequence
     WHERE session_harness_usage.organisation_id = excluded.organisation_id
       AND session_harness_usage.through_sequence = ?`,
    input.sessionId,
    lease.organisation_id,
    projectedUsage.entryCount,
    projectedUsage.inlineBytes,
    input.sequence,
    usageState.throughSequence,
  );
  sql.exec(
    `UPDATE session_harness_lease
     SET history_sequence = ?, history_digest = ?, updated_at = ?
     WHERE session_id = ? AND lease_id = ?`,
    input.sequence,
    entryDigest,
    input.acceptedAt,
    input.sessionId,
    input.leaseId,
  );
  return {
    ok: true,
    value: {
      kind: "advanced",
      cursor: historyCursor(input.sequence, entryDigest),
      usage: {
        ...projectedUsage,
        warning: historyUsageWarning(projectedUsage),
        hardLimit: historyUsageAtHardLimit(projectedUsage),
      },
      warningCrossed: !usage.warning && historyUsageWarning(projectedUsage),
    },
  };
}

function preflightHarnessTurnLeaseTransaction(
  sql: SqlStorage,
  lease: HarnessTurnLease,
  now: Timestamp,
): Result<HarnessTurnLease, HarnessAuthorityError> {
  const persisted = readHarnessLease(sql, lease.session.sessionId);
  const leaseError = validateCurrentLease(persisted, lease.leaseId, now);
  if (leaseError !== null) {
    return { ok: false, error: leaseError };
  }
  return persisted !== undefined &&
    storedLeaseMatches(persisted.lease_projection, lease)
    ? { ok: true, value: lease }
    : { ok: false, error: { code: "harness_lease_stale" } };
}

function storedLeaseMatches(
  projection: string,
  lease: HarnessTurnLease,
): boolean {
  try {
    const stored = parsePersistedHarnessTurnLease(JSON.parse(projection));
    const expected = parsePersistedHarnessTurnLease(lease);
    return stored !== null && expected !== null && sameValue(stored, expected);
  } catch {
    return false;
  }
}

function commitHarnessCheckpointTransaction(
  sql: SqlStorage,
  input: CommitHarnessCheckpointInput,
): Result<HarnessCheckpointCommit, HarnessAuthorityError> {
  const preflight = preflightHarnessCheckpointTransaction(sql, input);
  if (!preflight.ok) {
    return preflight;
  }
  if (preflight.value.kind === "duplicate") {
    return { ok: true, value: preflight.value };
  }

  const checkpoint = input.checkpoint;
  const projection = JSON.stringify(checkpoint);
  sql.exec(
    `INSERT INTO session_harness_checkpoint (
       session_id, turn_id, last_sequence, last_event_digest,
       checkpoint_projection, committed_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    checkpoint.session.sessionId,
    checkpoint.cursor.turn.turnId,
    checkpoint.cursor.lastSequence,
    checkpoint.cursor.lastEventDigest,
    projection,
    input.committedAt,
  );
  return {
    ok: true,
    value: { kind: "committed", checkpoint: input.checkpoint },
  };
}

function preflightHarnessCheckpointTransaction(
  sql: SqlStorage,
  input: CommitHarnessCheckpointInput,
): Result<HarnessCheckpointCommit | { kind: "ready" }, HarnessAuthorityError> {
  const checkpoint = input.checkpoint;
  const lease = readHarnessLease(sql, checkpoint.session.sessionId);
  const leaseError = validateCurrentLease(
    lease,
    input.leaseId,
    input.committedAt,
  );
  if (leaseError !== null) {
    return { ok: false, error: leaseError };
  }
  if (
    lease === undefined ||
    lease.organisation_id !== checkpoint.session.organisationId ||
    lease.turn_projection !== JSON.stringify(checkpoint.cursor.turn) ||
    !checkpointMatchesLease(checkpoint, lease.lease_projection) ||
    lease.last_sequence !== checkpoint.cursor.lastSequence ||
    lease.last_event_digest !== checkpoint.cursor.lastEventDigest ||
    lease.history_sequence !== checkpoint.historyCursor.lastSequence ||
    lease.history_digest !== checkpoint.historyCursor.lastEntryDigest
  ) {
    return { ok: false, error: { code: "harness_checkpoint_cursor_mismatch" } };
  }

  const existing = readHarnessCheckpoint(
    sql,
    checkpoint.session.sessionId,
    checkpoint.cursor.turn.turnId,
    checkpoint.cursor.lastSequence,
  );
  const projection = JSON.stringify(checkpoint);
  if (existing !== undefined) {
    return existing.last_event_digest === checkpoint.cursor.lastEventDigest &&
      existing.checkpoint_projection === projection
      ? { ok: true, value: { kind: "duplicate", checkpoint: input.checkpoint } }
      : { ok: false, error: { code: "harness_checkpoint_conflict" } };
  }
  return { ok: true, value: { kind: "ready" } };
}

function acceptHarnessEventTransaction(
  sql: SqlStorage,
  input: AcceptHarnessEventInput,
  byteLength: number,
): Result<HarnessEventAcceptance, HarnessAuthorityError> {
  const lease = readHarnessLease(sql, input.sessionId);
  const leaseError = validateCurrentLease(
    lease,
    input.leaseId,
    input.acceptedAt,
  );
  if (leaseError !== null) {
    return { ok: false, error: leaseError };
  }
  if (
    lease === undefined ||
    lease.turn_projection !== JSON.stringify(input.turn)
  ) {
    return { ok: false, error: { code: "harness_lease_stale" } };
  }

  const currentSequence = lease.last_sequence;
  if (currentSequence !== null && input.sequence === currentSequence) {
    if (lease.last_event_digest !== input.eventDigest) {
      return {
        ok: false,
        error: { code: "harness_event_divergent_duplicate" },
      };
    }
    const existing = readDeliverySegment(
      sql,
      input.sessionId,
      input.turn.turnId,
      input.sequence,
    );
    if (
      existing === undefined ||
      existing.event_digest !== input.eventDigest ||
      existing.payload !== input.payload ||
      existing.byte_length !== byteLength
    ) {
      return {
        ok: false,
        error: { code: "harness_event_divergent_duplicate" },
      };
    }
    return {
      ok: true,
      value: { kind: "duplicate", cursor: acceptedCursor(input) },
    };
  }

  const expectedSequence = currentSequence === null ? 1 : currentSequence + 1;
  if (input.sequence < expectedSequence) {
    return { ok: false, error: { code: "harness_event_stale" } };
  }
  if (input.sequence > expectedSequence) {
    return { ok: false, error: { code: "harness_event_gap" } };
  }

  const projection = prepareAcceptedHarnessEventProjection(sql, {
    organisationId: lease.organisation_id,
    turnId: input.turn.turnId,
    harnessSequence: input.sequence,
    payload: input.payload,
  });
  if (!projection.ok) {
    return { ok: false, error: { code: "harness_event_invalid" } };
  }

  sql.exec(
    `INSERT INTO turn_delivery_segment (
       session_id, turn_id, sequence, event_digest, payload, byte_length, accepted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.sessionId,
    input.turn.turnId,
    input.sequence,
    input.eventDigest,
    input.payload,
    byteLength,
    input.acceptedAt,
  );
  sql.exec(
    `UPDATE session_harness_lease
     SET last_sequence = ?, last_event_digest = ?, updated_at = ?
     WHERE session_id = ? AND lease_id = ?`,
    input.sequence,
    input.eventDigest,
    input.acceptedAt,
    input.sessionId,
    input.leaseId,
  );
  const persisted = readHarnessLease(sql, input.sessionId);
  if (
    persisted?.last_sequence !== input.sequence ||
    persisted.last_event_digest !== input.eventDigest
  ) {
    throw new Error("harness_cursor_write_failed");
  }
  const projected = persistAcceptedHarnessEventProjection(
    sql,
    projection.value,
  );
  if (!projected.ok) {
    throw new Error(`harness_event_projection_failed:${projected.error.code}`);
  }
  return {
    ok: true,
    value: { kind: "advanced", cursor: acceptedCursor(input) },
  };
}

function validHarnessTurnLease(
  session: ProcessingSession,
  lease: HarnessTurnLease,
  now: Timestamp,
): boolean {
  const activeTurn = session.activeTurn.state.identity;
  return (
    nonEmpty(lease.leaseId) &&
    sameValue(session.identity, lease.session) &&
    sameValue(activeTurn, lease.turn) &&
    sameValue(session.runtimeLease, lease.runtimeLease) &&
    session.contract.runtimeRevision === lease.runtimeRevision &&
    session.contract.budgetRevision === lease.turn.budgetRevision &&
    parseStoredRequestAuthority(lease.requestAuthority).ok &&
    SHA256_PATTERN.test(lease.authorityPartitionDigest) &&
    isPositiveInteger(lease.runtimeLease.generation) &&
    isNonNegativeInteger(lease.issuedAt) &&
    isNonNegativeInteger(now) &&
    lease.issuedAt <= now &&
    lease.expiresAt > now
  );
}

function validPersistedHarnessTurnLease(lease: HarnessTurnLease): boolean {
  return (
    nonEmpty(lease.leaseId) &&
    nonEmpty(lease.session.organisationId) &&
    nonEmpty(lease.session.sessionId) &&
    nonEmpty(lease.session.streamId) &&
    validTurnIdentity(lease.turn) &&
    isPositiveInteger(lease.runtimeLease.generation) &&
    nonEmpty(lease.runtimeLease.leaseId) &&
    nonEmpty(lease.runtimeRevision) &&
    parseStoredRequestAuthority(lease.requestAuthority).ok &&
    SHA256_PATTERN.test(lease.authorityPartitionDigest) &&
    isNonNegativeInteger(lease.issuedAt) &&
    lease.expiresAt > lease.issuedAt
  );
}

function validHarnessEventInput(input: AcceptHarnessEventInput): boolean {
  return (
    nonEmpty(input.leaseId) &&
    nonEmpty(input.sessionId) &&
    validTurnIdentity(input.turn) &&
    isPositiveInteger(input.sequence) &&
    SHA256_PATTERN.test(input.eventDigest) &&
    isNonNegativeInteger(input.acceptedAt)
  );
}

function validHarnessHistoryInput(input: AppendHarnessHistoryInput): boolean {
  return (
    nonEmpty(input.leaseId) &&
    nonEmpty(input.sessionId) &&
    validTurnIdentity(input.turn) &&
    isPositiveInteger(input.sequence) &&
    (input.previousDigest === null ||
      SHA256_PATTERN.test(input.previousDigest)) &&
    (input.entry.kind !== "user_input" || input.entry.input.kind === "case") &&
    parseHarnessHistoryEntry(
      JSON.parse(encodeHarnessHistoryEntry(input.entry)),
    ) !== null &&
    sameValue(input.entry.turn, input.turn) &&
    isNonNegativeInteger(input.acceptedAt)
  );
}

type HistoryOrderRejection =
  | "invalid_prior_history"
  | "initial_input_required"
  | "input_inside_turn"
  | "tool_result_without_call"
  | "tool_result_name_mismatch"
  | "duplicate_tool_result"
  | "duplicate_tool_call"
  | "tool_use_without_calls"
  | "unexpected_tool_calls"
  | "assistant_finished_with_pending_tools";

function historySemanticOrderRejection(
  sql: SqlStorage,
  sessionId: string,
  entry: HarnessHistoryEntry,
): HistoryOrderRejection | null {
  const loaded = readPriorHarnessTurnHistory(sql, sessionId, entry.turn);

  if (!loaded.ok) {
    return loaded.error;
  }

  const prior = loaded.value;
  if (prior.length === 0) {
    return initialHistoryOrderRejection(entry);
  }

  const calls = acceptedToolCalls(prior);
  const results = acceptedToolResults(prior);

  switch (entry.kind) {
    case "user_input":
      return steeringInputOrderRejection(sql, sessionId, calls, results, entry);
    case "tool_result":
      return toolResultOrderRejection(calls, results, entry);
    case "assistant_message":
      return assistantMessageOrderRejection(calls, results, entry);
    default:
      return assertNever(entry);
  }
}

function readPriorHarnessTurnHistory(
  sql: SqlStorage,
  sessionId: string,
  turn: HarnessHistoryEntry["turn"],
): Result<readonly HarnessHistoryEntry[], HistoryOrderRejection> {
  const rows = sql
    .exec<HistorySegmentRow>(
      `SELECT organisation_id, session_id, turn_id, sequence, previous_digest, entry_digest,
            payload, byte_length, accepted_at
     FROM session_harness_history
     WHERE session_id = ? AND turn_id = ?
     ORDER BY sequence`,
      sessionId,
      turn.turnId,
    )
    .toArray();
  const prior: HarnessHistoryEntry[] = [];

  for (const row of rows) {
    if (!nonEmpty(row.organisation_id)) {
      return { ok: false, error: "invalid_prior_history" };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(row.payload);
    } catch {
      return { ok: false, error: "invalid_prior_history" };
    }

    const parsed = parseHarnessHistoryEntry(raw);
    if (parsed === null || !sameValue(parsed.turn, turn)) {
      return { ok: false, error: "invalid_prior_history" };
    }

    prior.push(parsed);
  }

  return { ok: true, value: prior };
}

function initialHistoryOrderRejection(
  entry: HarnessHistoryEntry,
): HistoryOrderRejection | null {
  if (
    entry.kind === "user_input" &&
    entry.input.inputId === entry.turn.inputId
  ) {
    return null;
  }

  return "initial_input_required";
}

/**
 * A turn starts with its own input. A later input is a steering input that
 * the Session admitted for this turn (Plan 71): the harness queued or placed
 * it, its content is the admitted content, and no tool call of the turn is
 * open, because the harness places it between model requests.
 */
function steeringInputOrderRejection(
  sql: SqlStorage,
  sessionId: string,
  calls: ReadonlyMap<string, string>,
  results: ReadonlySet<string>,
  entry: Variant<HarnessHistoryEntry, "user_input">,
): HistoryOrderRejection | null {
  return entry.input.inputId !== entry.turn.inputId &&
    unresolvedToolCallCount(calls, results) === 0 &&
    steeringInputAccepts(sql, {
      sessionId,
      turnId: entry.turn.turnId,
      inputId: entry.input.inputId,
      content: entry.content,
    })
    ? null
    : "input_inside_turn";
}

function toolResultOrderRejection(
  calls: ReadonlyMap<string, string>,
  results: ReadonlySet<string>,
  entry: Variant<HarnessHistoryEntry, "tool_result">,
): HistoryOrderRejection | null {
  const callTool = calls.get(entry.callId);
  if (callTool === undefined) {
    return "tool_result_without_call";
  }
  if (callTool !== entry.tool) {
    return "tool_result_name_mismatch";
  }

  return results.has(entry.callId) ? "duplicate_tool_result" : null;
}

function assistantMessageOrderRejection(
  calls: ReadonlyMap<string, string>,
  results: ReadonlySet<string>,
  entry: Variant<HarnessHistoryEntry, "assistant_message">,
): HistoryOrderRejection | null {
  const toolCalls = entry.content.filter(isToolCallContent);
  if (entry.stopReason === "tool_use") {
    if (toolCalls.length === 0) {
      return "tool_use_without_calls";
    }
    if (hasDuplicateCallIds(toolCalls)) {
      return "duplicate_tool_call";
    }

    for (const call of toolCalls) {
      if (calls.has(call.callId) || results.has(call.callId)) {
        return "duplicate_tool_call";
      }
    }

    return null;
  }

  if (toolCalls.length > 0) {
    return "unexpected_tool_calls";
  }

  return unresolvedToolCallCount(calls, results) === 0
    ? null
    : "assistant_finished_with_pending_tools";
}

function acceptedToolCalls(
  entries: readonly HarnessHistoryEntry[],
): Map<string, string> {
  const calls = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== "assistant_message") {
      continue;
    }
    for (const content of entry.content) {
      if (content.kind === "tool_call") {
        calls.set(content.callId, content.tool);
      }
    }
  }
  return calls;
}

function acceptedToolResults(
  entries: readonly HarnessHistoryEntry[],
): Set<string> {
  const results = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "tool_result") {
      results.add(entry.callId);
    }
  }
  return results;
}

function isToolCallContent(
  content: HarnessAssistantContent,
): content is Variant<HarnessAssistantContent, "tool_call"> {
  return content.kind === "tool_call";
}

function hasDuplicateCallIds(
  calls: readonly Variant<HarnessAssistantContent, "tool_call">[],
): boolean {
  return (
    new Set(
      calls.map(function callId(call) {
        return call.callId;
      }),
    ).size !== calls.length
  );
}

function unresolvedToolCallCount(
  calls: ReadonlyMap<string, string>,
  results: ReadonlySet<string>,
): number {
  let unresolved = 0;
  for (const callId of calls.keys()) {
    if (!results.has(callId)) {
      unresolved += 1;
    }
  }
  return unresolved;
}

function validCheckpointInput(input: CommitHarnessCheckpointInput): boolean {
  return (
    activeEmbeddedHarnessBackendIdValue(input.checkpoint.backendId) !== null &&
    validCheckpointFields(input.leaseId, input.checkpoint, input.committedAt)
  );
}

function validCheckpointFields(
  leaseId: HarnessTurnLeaseId,
  checkpoint: HarnessCheckpointRecord,
  committedAt: Timestamp,
): boolean {
  const cursor = checkpoint.cursor;
  const historyCursor = checkpoint.historyCursor;
  return (
    nonEmpty(leaseId) &&
    nonEmpty(checkpoint.session.organisationId) &&
    nonEmpty(checkpoint.session.sessionId) &&
    nonEmpty(checkpoint.session.streamId) &&
    sameValue(checkpoint.turn, cursor.turn) &&
    validTurnIdentity(cursor.turn) &&
    isPositiveInteger(cursor.lastSequence) &&
    SHA256_PATTERN.test(cursor.lastEventDigest) &&
    isPositiveInteger(historyCursor.lastSequence) &&
    SHA256_PATTERN.test(historyCursor.lastEntryDigest) &&
    checkpoint.blob.objectKey ===
      canonicalHarnessCheckpointObjectKey({
        organisationId: checkpoint.session.organisationId,
        sessionId: checkpoint.session.sessionId,
        cursor,
        sha256: checkpoint.blob.sha256,
      }) &&
    SHA256_PATTERN.test(checkpoint.blob.sha256) &&
    isPositiveInteger(checkpoint.blob.byteLength) &&
    nonEmpty(checkpoint.blob.formatVersion) &&
    nonEmpty(checkpoint.blob.harnessBuild) &&
    isNonNegativeInteger(checkpoint.blob.createdAt) &&
    checkpoint.blob.createdAt <= committedAt &&
    isPositiveInteger(checkpoint.runtimeLease.generation) &&
    nonEmpty(checkpoint.runtimeLease.leaseId) &&
    nonEmpty(checkpoint.runtimeRevision) &&
    nonEmpty(checkpoint.policyVersion) &&
    isNonNegativeInteger(checkpoint.lastActorEventSequence) &&
    nonEmpty(checkpoint.workspaceBaseRevision) &&
    nonEmpty(checkpoint.workspaceRevision) &&
    SHA256_PATTERN.test(checkpoint.instructionDigest) &&
    SHA256_PATTERN.test(checkpoint.toolCatalogDigest) &&
    SHA256_PATTERN.test(checkpoint.modelRouteDigest) &&
    isNonNegativeInteger(committedAt)
  );
}

function validCheckpointRecord(checkpoint: HarnessCheckpointRecord): boolean {
  return (
    embeddedHarnessBackendIdValue(checkpoint.backendId) !== null &&
    validCheckpointFields(
      "checkpoint_record_validation",
      checkpoint,
      checkpoint.blob.createdAt,
    )
  );
}

function checkpointMatchesLease(
  checkpoint: HarnessCheckpointRecord,
  projection: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(projection);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) {
    return false;
  }
  return (
    parsed.leaseId !== undefined &&
    sameValue(parsed.session, checkpoint.session) &&
    sameValue(parsed.turn, checkpoint.turn) &&
    sameValue(parsed.runtimeLease, checkpoint.runtimeLease) &&
    parsed.runtimeRevision === checkpoint.runtimeRevision
  );
}

function validateCurrentLease(
  lease: HarnessLeaseRow | undefined,
  leaseId: HarnessTurnLeaseId,
  now: Timestamp,
): HarnessAuthorityError | null {
  if (lease === undefined) {
    return { code: "harness_lease_missing" };
  }
  if (lease.lease_id !== leaseId) {
    return { code: "harness_lease_stale" };
  }
  return now < lease.expires_at ? null : { code: "harness_lease_expired" };
}

function acceptedCursor(
  input: Pick<AcceptHarnessEventInput, "turn" | "sequence" | "eventDigest">,
): Variant<HarnessEventCursor, "accepted"> {
  return {
    kind: "accepted",
    turn: input.turn,
    lastSequence: input.sequence,
    lastEventDigest: input.eventDigest,
  };
}

function historyCursor(
  sequence: HarnessEventSequence,
  entryDigest: Sha256Digest,
): HarnessHistoryCursor {
  return {
    lastSequence: sequence,
    lastEntryDigest: entryDigest,
  };
}

function readHarnessLease(
  sql: SqlStorage,
  sessionId: string,
): HarnessLeaseRow | undefined {
  const rows = sql
    .exec<HarnessLeaseRow>(
      `SELECT session_id, organisation_id, lease_id, turn_id, turn_projection, lease_projection,
            last_sequence, last_event_digest, history_sequence, history_digest,
            issued_at, expires_at, updated_at
     FROM session_harness_lease
     WHERE session_id = ?
     LIMIT 2`,
      sessionId,
    )
    .toArray();
  if (rows.length > 1) {
    throw new Error("harness_lease_cardinality_invalid");
  }
  return rows[0];
}

function readHistorySegment(
  sql: SqlStorage,
  sessionId: string,
  sequence: number,
): HistorySegmentRow | undefined {
  return sql
    .exec<HistorySegmentRow>(
      `SELECT organisation_id, session_id, turn_id, sequence, previous_digest, entry_digest,
            payload, byte_length, accepted_at
     FROM session_harness_history
     WHERE session_id = ? AND sequence = ?
     LIMIT 2`,
      sessionId,
      sequence,
    )
    .toArray()[0];
}

function readHistoryHead(
  sql: SqlStorage,
  sessionId: string,
): HistorySegmentRow | undefined {
  return sql
    .exec<HistorySegmentRow>(
      `SELECT organisation_id, session_id, turn_id, sequence, previous_digest, entry_digest,
            payload, byte_length, accepted_at
     FROM session_harness_history
     WHERE session_id = ?
     ORDER BY sequence DESC
     LIMIT 1`,
      sessionId,
    )
    .toArray()[0];
}

function readHistoryUsage(
  sql: SqlStorage,
  sessionId: string,
  organisationId: string,
): HarnessHistoryUsage {
  return historyUsage(readHistoryUsageState(sql, sessionId, organisationId));
}

function readHistoryMaterializationUsage(
  sql: SqlStorage,
  sessionId: string,
  organisationId: string,
  throughSequence: number | undefined,
): Result<HistoryMaterializationUsage, HarnessAuthorityError> {
  if (throughSequence === undefined) {
    const rows = sql
      .exec<HarnessHistoryUsageRow>(
        `SELECT session_id, organisation_id, entry_count, inline_byte_count, through_sequence
       FROM session_harness_usage
       WHERE session_id = ?
       LIMIT 2`,
        sessionId,
      )
      .toArray();
    if (rows.length > 1) {
      return { ok: false, error: { code: "harness_history_cursor_mismatch" } };
    }
    const row = rows[0];
    if (row === undefined) {
      return {
        ok: true,
        value: { entryCount: 0, inlineBytes: 0, throughSequence: 0 },
      };
    }
    if (row.organisation_id !== organisationId) {
      return {
        ok: false,
        error: { code: "harness_history_organisation_mismatch" },
      };
    }
    return {
      ok: true,
      value: {
        entryCount: row.entry_count,
        inlineBytes: row.inline_byte_count,
        throughSequence: row.through_sequence,
      },
    };
  }

  const rows = sql
    .exec<
      Record<string, SqlStorageValue> & {
        organisation_id: string;
        entry_count: number;
        inline_byte_count: number;
        through_sequence: number;
      }
    >(
      `SELECT organisation_id, COUNT(*) AS entry_count,
            COALESCE(SUM(byte_length), 0) AS inline_byte_count,
            MAX(sequence) AS through_sequence
     FROM session_harness_history
     WHERE session_id = ? AND sequence <= ?
     GROUP BY organisation_id`,
      sessionId,
      throughSequence,
    )
    .toArray();
  if (rows.length > 1) {
    return { ok: false, error: { code: "harness_history_cursor_mismatch" } };
  }
  const row = rows[0];
  if (row === undefined) {
    return {
      ok: true,
      value: { entryCount: 0, inlineBytes: 0, throughSequence: 0 },
    };
  }
  if (row.organisation_id !== organisationId) {
    return {
      ok: false,
      error: { code: "harness_history_organisation_mismatch" },
    };
  }
  return {
    ok: true,
    value: {
      entryCount: row.entry_count,
      inlineBytes: row.inline_byte_count,
      throughSequence: row.through_sequence,
    },
  };
}

function readHistoryUsageState(
  sql: SqlStorage,
  sessionId: string,
  organisationId: string,
): HarnessHistoryUsage & { readonly throughSequence: number } {
  const rows = sql
    .exec<HarnessHistoryUsageRow>(
      `SELECT session_id, organisation_id, entry_count, inline_byte_count, through_sequence
     FROM session_harness_usage
     WHERE session_id = ?
     LIMIT 2`,
      sessionId,
    )
    .toArray();
  if (rows.length > 1) {
    throw new Error("harness_history_usage_cardinality_invalid");
  }
  const row = rows[0];
  if (row === undefined) {
    return {
      entryCount: 0,
      inlineBytes: 0,
      throughSequence: 0,
      warning: false,
      hardLimit: false,
    };
  }
  if (row.organisation_id !== organisationId) {
    throw new Error("harness_history_usage_organisation_mismatch");
  }
  return {
    entryCount: row.entry_count,
    inlineBytes: row.inline_byte_count,
    throughSequence: row.through_sequence,
    warning: historyUsageWarning({
      entryCount: row.entry_count,
      inlineBytes: row.inline_byte_count,
    }),
    hardLimit: historyUsageAtHardLimit({
      entryCount: row.entry_count,
      inlineBytes: row.inline_byte_count,
    }),
  };
}

function historyUsage(
  usage: Pick<HarnessHistoryUsage, "entryCount" | "inlineBytes">,
): HarnessHistoryUsage {
  const entryCount = usage.entryCount;
  const inlineBytes = usage.inlineBytes;
  return {
    entryCount,
    inlineBytes,
    warning: historyUsageWarning({ entryCount, inlineBytes }),
    hardLimit: historyUsageAtHardLimit({ entryCount, inlineBytes }),
  };
}

function listHarnessHistoryObjectKeysForOrganisation(
  sql: SqlStorage,
  organisationId: string,
): readonly string[] {
  const rows = sql
    .exec<Record<string, SqlStorageValue> & { payload: string }>(
      `SELECT payload
     FROM session_harness_history
     WHERE organisation_id = ?
     ORDER BY session_id, sequence`,
      organisationId,
    )
    .toArray();
  const keys: string[] = [];
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.payload);
    } catch {
      throw new Error("harness_history_payload_invalid");
    }
    const entry = parseHarnessHistoryEntry(raw);
    if (entry === null) {
      throw new Error("harness_history_payload_invalid");
    }
    collectHistoryObjectKeys(entry, keys);
  }
  return keys;
}

function listHarnessCheckpointObjectKeysForOrganisation(
  sql: SqlStorage,
  organisationId: string,
): readonly string[] {
  const rows = sql
    .exec<Record<string, SqlStorageValue> & { checkpoint_projection: string }>(
      `SELECT checkpoint_projection
     FROM session_harness_checkpoint
     ORDER BY session_id, turn_id, last_sequence`,
    )
    .toArray();
  const keys: string[] = [];
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.checkpoint_projection);
    } catch {
      throw new Error("harness_checkpoint_projection_invalid");
    }
    if (
      !isRecord(raw) ||
      !isRecord(raw.session) ||
      raw.session.organisationId !== organisationId
    ) {
      continue;
    }
    const objectKey = parseCheckpointObjectKey(row.checkpoint_projection);
    if (!keys.includes(objectKey)) {
      keys.push(objectKey);
    }
  }
  return keys;
}

function listHarnessCheckpointSessionIdsForOrganisation(
  sql: SqlStorage,
  organisationId: string,
): readonly string[] {
  const rows = sql
    .exec<Record<string, SqlStorageValue> & { checkpoint_projection: string }>(
      `SELECT checkpoint_projection
     FROM session_harness_checkpoint
     ORDER BY session_id, turn_id, last_sequence`,
    )
    .toArray();
  const sessionIds: string[] = [];
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.checkpoint_projection);
    } catch {
      throw new Error("harness_checkpoint_projection_invalid");
    }
    if (
      !isRecord(raw) ||
      !isRecord(raw.session) ||
      raw.session.organisationId !== organisationId
    ) {
      continue;
    }
    const sessionId = stringValue(raw.session.sessionId);
    if (sessionId === null) {
      throw new Error("harness_checkpoint_projection_invalid");
    }
    if (!sessionIds.includes(sessionId)) {
      sessionIds.push(sessionId);
    }
  }
  return sessionIds;
}

function collectHistoryObjectKeys(
  entry: HarnessHistoryEntry,
  keys: string[],
): void {
  if (entry.kind === "user_input") {
    collectHistoryContentObjectKeys(entry.content, keys);
    return;
  }
  if (entry.kind === "tool_result") {
    const output = entry.outcome.output;
    if (output.kind === "inline") {
      collectHistoryContentObjectKeys(output.content, keys);
    } else {
      const objectKey = objectKeyFromArtifactUrl(output.artifact.url);
      if (objectKey !== null && !keys.includes(objectKey)) {
        keys.push(objectKey);
      }
    }
  }
}

function collectHistoryContentObjectKeys(
  content: readonly HarnessHistoryContent[],
  keys: string[],
): void {
  for (const item of content) {
    if (item.kind !== "attachment") {
      continue;
    }
    if (!keys.includes(item.attachment.objectKey)) {
      keys.push(item.attachment.objectKey);
    }
  }
}

function objectKeyFromArtifactUrl(url: string | null): string | null {
  if (url === null || url.length === 0 || url.includes("://")) {
    return null;
  }
  const key = url.startsWith("/") ? url.slice(1) : url;
  return key.startsWith("harness-artifacts/") || key.startsWith("artifacts/")
    ? key
    : null;
}

function dedupeObjectKeys(keys: readonly string[]): readonly string[] {
  const deduped: string[] = [];
  for (const key of keys) {
    if (!deduped.includes(key)) {
      deduped.push(key);
    }
  }
  return deduped;
}

function historyUsageWarning(
  usage: Pick<HarnessHistoryUsage, "entryCount" | "inlineBytes">,
): boolean {
  return (
    usage.entryCount >= HARNESS_HISTORY_WARNING_ENTRIES ||
    usage.inlineBytes >= HARNESS_HISTORY_WARNING_BYTES
  );
}

function historyUsageAtHardLimit(
  usage: Pick<HarnessHistoryUsage, "entryCount" | "inlineBytes">,
): boolean {
  return (
    usage.entryCount >= MAX_HARNESS_HISTORY_ENTRIES ||
    usage.inlineBytes >= MAX_HARNESS_HISTORY_BYTES
  );
}

function historyBudgetViolation(
  current: Pick<HarnessHistoryUsage, "entryCount" | "inlineBytes">,
  projected: Pick<HarnessHistoryUsage, "entryCount" | "inlineBytes">,
): VariantBy<
  HarnessAuthorityError,
  "code",
  "harness_history_budget_exceeded"
> | null {
  if (projected.entryCount > MAX_HARNESS_HISTORY_ENTRIES) {
    return {
      code: "harness_history_budget_exceeded",
      limit: "entry_count",
      current: current.entryCount,
      projected: projected.entryCount,
      maximum: MAX_HARNESS_HISTORY_ENTRIES,
    };
  }
  if (projected.inlineBytes > MAX_HARNESS_HISTORY_BYTES) {
    return {
      code: "harness_history_budget_exceeded",
      limit: "inline_bytes",
      current: current.inlineBytes,
      projected: projected.inlineBytes,
      maximum: MAX_HARNESS_HISTORY_BYTES,
    };
  }
  return null;
}

function readDeliverySegment(
  sql: SqlStorage,
  sessionId: string,
  turnId: string,
  sequence: number,
): DeliverySegmentRow | undefined {
  return sql
    .exec<DeliverySegmentRow>(
      `SELECT event_digest, payload, byte_length
     FROM turn_delivery_segment
     WHERE session_id = ? AND turn_id = ? AND sequence = ?
     LIMIT 1`,
      sessionId,
      turnId,
      sequence,
    )
    .toArray()[0];
}

function readHarnessCheckpoint(
  sql: SqlStorage,
  sessionId: string,
  turnId: string,
  sequence: number,
): HarnessCheckpointRow | undefined {
  return sql
    .exec<HarnessCheckpointRow>(
      `SELECT last_event_digest, checkpoint_projection, upload_state
     FROM session_harness_checkpoint
     WHERE session_id = ? AND turn_id = ? AND last_sequence = ?
     LIMIT 1`,
      sessionId,
      turnId,
      sequence,
    )
    .toArray()[0];
}

function sameValue(left: unknown, right: object): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validTurnIdentity(turn: TurnIdentity): boolean {
  return (
    nonEmpty(turn.turnId) &&
    nonEmpty(turn.inputId) &&
    isPositiveInteger(turn.turnLeaseGeneration) &&
    nonEmpty(turn.budgetRevision)
  );
}

function nonEmpty(value: string): boolean {
  return value.length > 0;
}

function parseCheckpointObjectKey(projection: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(projection);
  } catch {
    throw new Error("harness_checkpoint_projection_invalid");
  }
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.blob) ||
    typeof parsed.blob.objectKey !== "string" ||
    parsed.blob.objectKey.length === 0
  ) {
    throw new Error("harness_checkpoint_projection_invalid");
  }
  return parsed.blob.objectKey;
}

function parseStoredHarnessCheckpointRecord(
  projection: string,
): Exclude<StoredHarnessCheckpointInspection, { readonly kind: "missing" }> {
  let raw: unknown;
  try {
    raw = JSON.parse(projection);
  } catch {
    return { kind: "invalid", reason: "malformed_checkpoint" };
  }
  if (
    !isRecord(raw) ||
    !isRecord(raw.blob) ||
    !isRecord(raw.session) ||
    !isRecord(raw.turn) ||
    !isRecord(raw.runtimeLease) ||
    !isRecord(raw.cursor)
  ) {
    return { kind: "invalid", reason: "malformed_checkpoint" };
  }
  const objectKey = stringValue(raw.blob.objectKey);
  const backendId = embeddedHarnessBackendIdValue(raw.backendId);
  const blobSha256 = sha256Value(raw.blob.sha256);
  const byteLength = positiveIntegerValue(raw.blob.byteLength);
  const formatVersion = stringValue(raw.blob.formatVersion);
  const harnessBuild = stringValue(raw.blob.harnessBuild);
  const createdAt = nonNegativeIntegerOrNull(raw.blob.createdAt);
  const organisationId = stringValue(raw.session.organisationId);
  const sessionId = stringValue(raw.session.sessionId);
  const streamId = stringValue(raw.session.streamId);
  const turn = parseTurnIdentity(raw.turn);
  const runtimeGeneration = positiveIntegerValue(raw.runtimeLease.generation);
  const runtimeLeaseId = stringValue(raw.runtimeLease.leaseId);
  const runtimeRevision = stringValue(raw.runtimeRevision);
  const policyVersion = stringValue(raw.policyVersion);
  const budgetRevision = stringValue(raw.budgetRevision);
  const budgetUsage = parseSessionBudgetUsage(raw.budgetUsage);
  const usageCursor = nonNegativeIntegerOrNull(raw.usageCursor);
  const budgetAccountDigest = sha256Value(raw.budgetAccountDigest);
  const cursorTurn = parseTurnIdentity(raw.cursor.turn);
  const lastSequence = positiveIntegerValue(raw.cursor.lastSequence);
  const lastEventDigest = sha256Value(raw.cursor.lastEventDigest);
  const lastActorEventSequence = nonNegativeIntegerOrNull(
    raw.lastActorEventSequence,
  );
  const workspaceBaseRevision = stringValue(raw.workspaceBaseRevision);
  const workspaceRevision = stringValue(raw.workspaceRevision);
  const instructionDigest = sha256Value(raw.instructionDigest);
  const toolCatalogDigest = sha256Value(raw.toolCatalogDigest);
  const modelRouteDigest = sha256Value(raw.modelRouteDigest);
  const historyCursor = isRecord(raw.historyCursor)
    ? {
        lastSequence: positiveIntegerValue(raw.historyCursor.lastSequence),
        lastEntryDigest: sha256Value(raw.historyCursor.lastEntryDigest),
      }
    : null;
  if (
    objectKey === null ||
    backendId === null ||
    blobSha256 === null ||
    byteLength === null ||
    formatVersion === null ||
    harnessBuild === null ||
    createdAt === null ||
    organisationId === null ||
    sessionId === null ||
    streamId === null ||
    turn === null ||
    runtimeGeneration === null ||
    runtimeLeaseId === null ||
    runtimeRevision === null ||
    policyVersion === null ||
    budgetRevision === null ||
    budgetUsage === null ||
    usageCursor === null ||
    budgetAccountDigest === null ||
    cursorTurn === null ||
    lastSequence === null ||
    lastEventDigest === null ||
    lastActorEventSequence === null ||
    workspaceBaseRevision === null ||
    workspaceRevision === null ||
    instructionDigest === null ||
    toolCatalogDigest === null ||
    modelRouteDigest === null ||
    historyCursor === null ||
    historyCursor.lastSequence === null ||
    historyCursor.lastEntryDigest === null ||
    JSON.stringify(turn) !== JSON.stringify(cursorTurn)
  ) {
    return { kind: "invalid", reason: "malformed_checkpoint" };
  }
  return {
    kind: "valid",
    checkpoint: {
      backendId,
      blob: {
        objectKey,
        sha256: blobSha256,
        byteLength,
        formatVersion,
        harnessBuild,
        createdAt,
      },
      session: { organisationId, sessionId, streamId },
      turn,
      runtimeLease: { generation: runtimeGeneration, leaseId: runtimeLeaseId },
      runtimeRevision,
      policyVersion,
      budgetRevision,
      budgetUsage,
      usageCursor,
      budgetAccountDigest,
      cursor: { turn: cursorTurn, lastSequence, lastEventDigest },
      historyCursor: {
        lastSequence: historyCursor.lastSequence,
        lastEntryDigest: historyCursor.lastEntryDigest,
      },
      lastActorEventSequence,
      workspaceBaseRevision,
      workspaceRevision,
      instructionDigest,
      toolCatalogDigest,
      modelRouteDigest,
    },
  };
}

function parseSessionBudgetUsage(
  raw: unknown,
): HarnessCheckpointRecord["budgetUsage"] | null {
  if (!isRecord(raw)) {
    return null;
  }
  const tokens = nonNegativeIntegerOrNull(raw.tokens);
  const activeWallMs = nonNegativeIntegerOrNull(raw.activeWallMs);
  const capabilityCalls = nonNegativeIntegerOrNull(raw.capabilityCalls);
  return tokens === null || activeWallMs === null || capabilityCalls === null
    ? null
    : { tokens, activeWallMs, capabilityCalls };
}

function embeddedHarnessBackendIdValue(
  value: unknown,
): EmbeddedHarnessBackendId | null {
  return value === "picocodex" || value === "pi" || value === "codex"
    ? value
    : null;
}

function activeEmbeddedHarnessBackendIdValue(
  value: unknown,
): ActiveEmbeddedHarnessBackendId | null {
  return value === "pi" ? value : null;
}

function parseTurnIdentity(raw: unknown): TurnIdentity | null {
  if (!isRecord(raw)) {
    return null;
  }
  const turnId = stringValue(raw.turnId);
  const inputId = stringValue(raw.inputId);
  const turnLeaseGeneration = positiveIntegerValue(raw.turnLeaseGeneration);
  const budgetRevision = stringValue(raw.budgetRevision);
  return turnId === null ||
    inputId === null ||
    turnLeaseGeneration === null ||
    budgetRevision === null
    ? null
    : { turnId, inputId, turnLeaseGeneration, budgetRevision };
}

function sha256Value(value: unknown): string | null {
  return typeof value === "string" && SHA256_PATTERN.test(value) ? value : null;
}

function positiveIntegerValue(value: unknown): number | null {
  return typeof value === "number" && isPositiveInteger(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
