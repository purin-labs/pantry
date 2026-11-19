import type {
  AgentSessionLifecycle,
  HarnessBuildId,
  HarnessCheckpointBlobRef,
  HarnessCheckpointFormatVersion,
  HarnessCheckpointRecord,
  HarnessEventCursor,
  HarnessTurnLeaseId,
  RuntimeLease,
  SessionBudgetAccount,
  SessionIdentity,
  Sha256Digest,
  Timestamp,
} from "@purin-labs/contracts";

import {
  validateCanonicalHarnessCheckpointRestore,
  type ActorReducerValidationError,
} from "../actor-wasm";
import {
  sealHarnessCheckpointPayload,
  unsealHarnessCheckpointPayload,
  MAX_CHECKPOINT_PLAINTEXT_BYTES,
  type HarnessCheckpointError,
} from "../harness-checkpoint";
import { newRequestId } from "../ids";
import { traceLog, traceWarn } from "../observability";
import type { Result } from "../result";
import {
  canonicalHarnessCheckpointObjectKey,
  preflightHarnessCheckpoint,
  type ActiveHarnessCheckpointRecord,
  type HarnessAuthorityError,
  type HarnessAuthorityStorage,
  type CommitHarnessCheckpointInput,
  readHarnessCheckpointPublication,
  readRetainedHarnessCheckpointPayload,
  type HarnessCheckpointPublication,
} from "./agent-session-harness-authority";
import {
  sessionBudgetAccountDigest,
  validateCheckpointBudgetGap,
  type SessionBudgetError,
} from "./agent-session-budget";
import type {
  ActiveEmbeddedHarnessBackendId,
  EmbeddedHarnessManifest,
} from "./embedded-harness";
import type { HarnessHistoryCursor } from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";
import { errorMessage, sha256Hex } from "@purin-labs/std";

const CHECKPOINT_METADATA_FORMAT = "satyr-actor-checkpoint-v1";

export type CanonicalHarnessCheckpointError =
  | HarnessAuthorityError
  | HarnessCheckpointError
  | ActorReducerValidationError
  | { code: "harness_checkpoint_object_conflict" }
  | { code: "harness_checkpoint_backend_mismatch" };

export type CheckpointBudgetBindingError =
  | { readonly code: "checkpoint_budget_revision_mismatch" }
  | { readonly code: "checkpoint_budget_usage_mismatch" }
  | { readonly code: "checkpoint_budget_cursor_mismatch" }
  | { readonly code: "checkpoint_budget_account_digest_mismatch" };

export type CanonicalHarnessCheckpointInput = {
  leaseId: HarnessTurnLeaseId;
  backendId: ActiveEmbeddedHarnessBackendId;
  session: SessionIdentity;
  cursor: Variant<HarnessEventCursor, "accepted">;
  historyCursor: HarnessHistoryCursor;
  runtimeLease: RuntimeLease;
  runtimeRevision: string;
  policyVersion: string;
  budgetRevision: string;
  budgetUsage: SessionBudgetAccount["usage"];
  usageCursor: SessionBudgetAccount["usageCursor"];
  budgetAccountDigest: Sha256Digest;
  lastActorEventSequence: number;
  workspaceBaseRevision: string;
  workspaceRevision: string;
  instructionDigest: Sha256Digest;
  toolCatalogDigest: Sha256Digest;
  modelRouteDigest: Sha256Digest;
  formatVersion: HarnessCheckpointFormatVersion;
  harnessBuild: HarnessBuildId;
  checkpoint: ArrayBuffer;
  createdAt: Timestamp;
};

export type PreparedHarnessCheckpoint = {
  readonly commit: CommitHarnessCheckpointInput;
  readonly payload: ArrayBuffer;
};

/** Validates the budget projection before a checkpoint crosses the R2 boundary. */
export async function validateCheckpointBudgetBinding(input: {
  readonly checkpoint: Pick<
    CanonicalHarnessCheckpointInput,
    "budgetRevision" | "budgetUsage" | "usageCursor" | "budgetAccountDigest"
  >;
  readonly account: SessionBudgetAccount;
}): Promise<Result<null, CheckpointBudgetBindingError>> {
  if (input.checkpoint.budgetRevision !== input.account.budget.budgetRevision) {
    return {
      ok: false,
      error: { code: "checkpoint_budget_revision_mismatch" },
    };
  }
  if (!budgetUsageEqual(input.checkpoint.budgetUsage, input.account.usage)) {
    return { ok: false, error: { code: "checkpoint_budget_usage_mismatch" } };
  }
  if (input.checkpoint.usageCursor !== input.account.usageCursor) {
    return { ok: false, error: { code: "checkpoint_budget_cursor_mismatch" } };
  }
  if (
    input.checkpoint.budgetAccountDigest !==
    (await sessionBudgetAccountDigest(input.account))
  ) {
    return {
      ok: false,
      error: { code: "checkpoint_budget_account_digest_mismatch" },
    };
  }
  return { ok: true, value: null };
}

export async function validateActiveRunCheckpointBudgetBinding(input: {
  readonly sql: SqlStorage;
  readonly account: SessionBudgetAccount;
  readonly checkpoint: HarnessCheckpointRecord;
  readonly identity: {
    readonly reservationId: string;
    readonly runId: string;
  };
}): Promise<Result<null, CheckpointBudgetBindingError | SessionBudgetError>> {
  if (
    input.account.kind !== "open" ||
    input.account.reservation.kind !== "active"
  ) {
    return input.account.kind === "exhausted"
      ? {
          ok: false,
          error: {
            code: "budget_exhausted",
            exhaustion: input.account.exhaustion,
          },
        }
      : { ok: false, error: { code: "budget_reservation_conflict" } };
  }
  const reservation = input.account.reservation;
  if (
    reservation.reservation.reservationId !== input.identity.reservationId ||
    reservation.reservation.runId !== input.identity.runId ||
    reservation.acceptedUsage.tokens !== 0 ||
    reservation.acceptedUsage.activeWallMs !== 0 ||
    reservation.acceptedUsage.capabilityCalls !== 0 ||
    input.account.usageCursor <= input.checkpoint.usageCursor ||
    input.account.usage.tokens !== input.checkpoint.budgetUsage.tokens ||
    input.account.usage.capabilityCalls <
      input.checkpoint.budgetUsage.capabilityCalls ||
    input.account.usage.activeWallMs < input.checkpoint.budgetUsage.activeWallMs
  ) {
    return { ok: false, error: { code: "budget_reservation_lease_conflict" } };
  }
  const checkpointAccount: SessionBudgetAccount = {
    kind: "open",
    budget: input.account.budget,
    usage: input.checkpoint.budgetUsage,
    usageCursor: input.checkpoint.usageCursor,
    reservation: { kind: "none" },
  };
  const checkpointBinding = await validateCheckpointBudgetBinding({
    checkpoint: input.checkpoint,
    account: checkpointAccount,
  });
  if (
    !checkpointBinding.ok ||
    input.account.usage.capabilityCalls ===
      input.checkpoint.budgetUsage.capabilityCalls
  ) {
    return checkpointBinding;
  }
  return validateCheckpointBudgetGap(input.sql, {
    organisationId: input.checkpoint.session.organisationId,
    sessionId: input.checkpoint.session.sessionId,
    budgetRevision: input.checkpoint.budgetRevision,
    checkpointUsage: input.checkpoint.budgetUsage,
    checkpointUsageCursor: input.checkpoint.usageCursor,
    account: input.account,
    activeRunId: input.identity.runId,
    activeReservationId: input.identity.reservationId,
  });
}

export async function prepareHarnessCheckpoint(input: {
  storage: HarnessAuthorityStorage;
  checkpoint: CanonicalHarnessCheckpointInput;
  now: () => Timestamp;
}): Promise<
  Result<PreparedHarnessCheckpoint, CanonicalHarnessCheckpointError>
> {
  if (input.checkpoint.checkpoint.byteLength > MAX_CHECKPOINT_PLAINTEXT_BYTES)
    return { ok: false, error: { code: "checkpoint_too_large" } };
  const digest = await sha256Hex(input.checkpoint.checkpoint);
  const checkpointRef = checkpointBlobRef(input.checkpoint, digest);
  const record = checkpointRecord(input.checkpoint, checkpointRef);
  const initialCommit = checkpointCommitInput(
    input.checkpoint,
    record,
    input.now(),
  );
  const preflight = preflightHarnessCheckpoint(input.storage, initialCommit);
  if (!preflight.ok) return preflight;

  return {
    ok: true,
    value: { commit: initialCommit, payload: input.checkpoint.checkpoint },
  };
}

export async function uploadHarnessCheckpoint(input: {
  readonly storage: HarnessAuthorityStorage;
  readonly bucket: R2Bucket;
  readonly root: SecretsStoreSecret;
  readonly publication: Variant<HarnessCheckpointPublication, "upload_pending">;
  /**
   * "first" when the caller accepted this checkpoint in the same call, so no
   * earlier attempt can have stored it. "resumed" when an earlier attempt may
   * have: the archive is then read before anything is sealed or written.
   */
  readonly attempt: "first" | "resumed";
}): Promise<Result<HarnessCheckpointRecord, CanonicalHarnessCheckpointError>> {
  const saved = readHarnessCheckpointPublication(
    input.storage.sql,
    input.publication.checkpoint,
  );
  if (!saved.ok) return saved;
  if (saved.value.kind === "published")
    return { ok: true, value: saved.value.checkpoint };
  const record = saved.value.checkpoint;
  if ((await sha256Hex(saved.value.payload)) !== record.blob.sha256)
    return { ok: false, error: { code: "checkpoint_corrupt" } };
  const stored = await ensureImmutableCheckpointObject({
    bucket: input.bucket,
    root: input.root,
    record,
    checkpoint: saved.value.payload,
    attempt: input.attempt,
  });
  if (!stored.ok) return stored;
  return { ok: true, value: record };
}

/**
 * A checkpoint's payload, read and compared with the checkpoint's digest.
 * Reading it judges nothing: whether the Session may restore the checkpoint is
 * decided by `loadCanonicalHarnessCheckpoint`. It never rejects.
 */
export type CanonicalHarnessCheckpointPayload = Promise<
  Result<ArrayBuffer, CanonicalHarnessCheckpointError>
>;

/**
 * Start reading a checkpoint's payload. A Session calls this as soon as it
 * knows which checkpoint its turn restores, beside the reads that decide
 * whether the turn may start. The payload is used only through
 * `loadCanonicalHarnessCheckpoint`, after those decisions.
 *
 * The Session keeps the payload of its latest checkpoint, so the read is
 * local. The archive is read when the Session keeps no copy: after a
 * relocation, or for a checkpoint that was published before the Session kept
 * one.
 */
export async function readCheckpointPayloadForRestore(input: {
  sql: SqlStorage;
  bucket: R2Bucket;
  root: SecretsStoreSecret;
  checkpoint: HarnessCheckpointRecord;
}): CanonicalHarnessCheckpointPayload {
  const startedAt = Date.now();
  const retained = await readRetainedCheckpointPayload(input);
  const payload: Result<ArrayBuffer, CanonicalHarnessCheckpointError> =
    retained === null
      ? await readArchivedCheckpointPayload(input)
      : { ok: true, value: retained };
  traceLog("session.checkpoint_payload_read", {
    requestId: newRequestId(),
    organisation_id: input.checkpoint.session.organisationId,
    turn_id: input.checkpoint.turn.turnId,
    source: retained === null ? "archive" : "session",
    read_ms: Date.now() - startedAt,
    outcome: payload.ok ? "read" : payload.error.code,
  });
  return payload;
}

/**
 * The Session's own copy of a checkpoint's payload, or null when the Session
 * keeps none that matches the checkpoint's digest. The SQL read runs before
 * the first wait, so it runs when the caller starts the read.
 */
async function readRetainedCheckpointPayload(input: {
  sql: SqlStorage;
  checkpoint: HarnessCheckpointRecord;
}): Promise<ArrayBuffer | null> {
  let rejection: string;
  try {
    const retained = readRetainedHarnessCheckpointPayload(
      input.sql,
      input.checkpoint,
    );
    if (retained === null) return null;
    if ((await sha256Hex(retained)) === input.checkpoint.blob.sha256)
      return retained;
    rejection = "digest_mismatch";
  } catch (error) {
    rejection = errorMessage(error);
  }
  // The archive holds a sealed copy with the same digest.
  traceWarn("session.checkpoint_retained_payload_rejected", {
    requestId: newRequestId(),
    organisation_id: input.checkpoint.session.organisationId,
    turn_id: input.checkpoint.turn.turnId,
    rejection,
  });
  return null;
}

/** The payload of a checkpoint, read from its archive object and opened. */
async function readArchivedCheckpointPayload(input: {
  bucket: R2Bucket;
  root: SecretsStoreSecret;
  checkpoint: HarnessCheckpointRecord;
}): CanonicalHarnessCheckpointPayload {
  try {
    const binding = checkpointBinding(input.checkpoint);
    const bindingDigest = await sha256Hex(binding);
    const object = await input.bucket.get(input.checkpoint.blob.objectKey);
    if (object === null)
      return { ok: false, error: { code: "checkpoint_missing" } };
    const metadata = validateStoredCheckpoint(
      object,
      input.checkpoint,
      bindingDigest,
    );
    if (!metadata.ok) return metadata;
    return await unsealHarnessCheckpointPayload({
      root: input.root,
      organisationId: input.checkpoint.session.organisationId,
      derivationInfo: bindingDigest,
      additionalData: binding,
      expectedSha256: input.checkpoint.blob.sha256,
      body: await object.arrayBuffer(),
    });
  } catch (error) {
    return {
      ok: false,
      error: { code: "checkpoint_read_failed", detail: errorMessage(error) },
    };
  }
}

export async function loadCanonicalHarnessCheckpoint(input: {
  bucket: R2Bucket;
  root: SecretsStoreSecret;
  state: AgentSessionLifecycle;
  checkpoint: HarnessCheckpointRecord;
  manifest: EmbeddedHarnessManifest;
  sql: SqlStorage;
  /** A read of this checkpoint's payload that was started earlier. */
  payload?: CanonicalHarnessCheckpointPayload;
}): Promise<Result<ArrayBuffer, CanonicalHarnessCheckpointError>> {
  if (
    input.checkpoint.backendId !== input.manifest.backendId ||
    input.checkpoint.blob.harnessBuild !== input.manifest.harnessBuild ||
    input.checkpoint.blob.formatVersion !== input.manifest.checkpointFormat
  ) {
    return {
      ok: false,
      error: { code: "harness_checkpoint_backend_mismatch" },
    };
  }
  const validated = validateCanonicalHarnessCheckpointRestore({
    state: input.state,
    checkpoint: input.checkpoint,
  });
  if (!validated.ok) return validated;
  return (
    input.payload ??
    readCheckpointPayloadForRestore({
      sql: input.sql,
      bucket: input.bucket,
      root: input.root,
      checkpoint: input.checkpoint,
    })
  );
}

function checkpointBlobRef(
  input: CanonicalHarnessCheckpointInput,
  sha256: string,
): HarnessCheckpointBlobRef {
  const objectKey = canonicalHarnessCheckpointObjectKey({
    organisationId: input.session.organisationId,
    sessionId: input.session.sessionId,
    cursor: {
      turn: input.cursor.turn,
      lastSequence: input.cursor.lastSequence,
      lastEventDigest: input.cursor.lastEventDigest,
    },
    sha256,
  });
  return {
    objectKey,
    sha256,
    byteLength: input.checkpoint.byteLength,
    formatVersion: input.formatVersion,
    harnessBuild: input.harnessBuild,
    createdAt: input.createdAt,
  };
}

function checkpointRecord(
  input: CanonicalHarnessCheckpointInput,
  blob: HarnessCheckpointBlobRef,
): ActiveHarnessCheckpointRecord {
  return {
    backendId: input.backendId,
    blob,
    session: input.session,
    turn: input.cursor.turn,
    runtimeLease: input.runtimeLease,
    runtimeRevision: input.runtimeRevision,
    policyVersion: input.policyVersion,
    budgetRevision: input.budgetRevision,
    budgetUsage: input.budgetUsage,
    usageCursor: input.usageCursor,
    budgetAccountDigest: input.budgetAccountDigest,
    cursor: {
      turn: input.cursor.turn,
      lastSequence: input.cursor.lastSequence,
      lastEventDigest: input.cursor.lastEventDigest,
    },
    historyCursor: input.historyCursor,
    lastActorEventSequence: input.lastActorEventSequence,
    workspaceBaseRevision: input.workspaceBaseRevision,
    workspaceRevision: input.workspaceRevision,
    instructionDigest: input.instructionDigest,
    toolCatalogDigest: input.toolCatalogDigest,
    modelRouteDigest: input.modelRouteDigest,
  };
}

function checkpointCommitInput(
  input: CanonicalHarnessCheckpointInput,
  checkpoint: ActiveHarnessCheckpointRecord,
  committedAt: Timestamp,
) {
  return {
    leaseId: input.leaseId,
    checkpoint,
    committedAt,
  };
}

async function ensureImmutableCheckpointObject(input: {
  bucket: R2Bucket;
  root: SecretsStoreSecret;
  checkpoint: ArrayBuffer;
  record: HarnessCheckpointRecord;
  attempt: "first" | "resumed";
}): Promise<Result<null, CanonicalHarnessCheckpointError>> {
  const binding = checkpointBinding(input.record);
  const bindingDigest = await sha256Hex(binding);
  // A resumed attempt reads the archive first, so that it neither seals nor
  // sends a payload the archive already holds. On a first attempt that read
  // decides nothing. The write is conditional on the object's absence, so it
  // still finds an object where none was expected.
  if (input.attempt === "resumed") {
    const existing = await headCheckpoint(
      input.bucket,
      input.record.blob.objectKey,
    );
    if (!existing.ok) return existing;
    if (existing.value !== null) {
      return validateStoredCheckpoint(
        existing.value,
        input.record,
        bindingDigest,
      );
    }
  }

  const sealStartedAt = Date.now();
  const sealed = await sealHarnessCheckpointPayload({
    root: input.root,
    organisationId: input.record.session.organisationId,
    derivationInfo: bindingDigest,
    additionalData: binding,
    checkpoint: input.checkpoint,
  });
  if (!sealed.ok) return sealed;

  const writeStartedAt = Date.now();
  try {
    const written = await input.bucket.put(
      input.record.blob.objectKey,
      sealed.value.body,
      {
        onlyIf: { etagDoesNotMatch: "*" },
        customMetadata: checkpointMetadata(input.record, bindingDigest),
      },
    );
    traceLog("session.checkpoint_upload_timing", {
      requestId: newRequestId(),
      organisation_id: input.record.session.organisationId,
      turn_id: input.record.turn.turnId,
      seal_ms: writeStartedAt - sealStartedAt,
      write_ms: Date.now() - writeStartedAt,
      outcome: written === null ? "exists" : "written",
    });
    if (written !== null) return { ok: true, value: null };
  } catch (error) {
    return {
      ok: false,
      error: { code: "checkpoint_write_failed", detail: errorMessage(error) },
    };
  }

  const raced = await headCheckpoint(input.bucket, input.record.blob.objectKey);
  if (!raced.ok) return raced;
  return raced.value === null
    ? { ok: false, error: { code: "checkpoint_missing" } }
    : validateStoredCheckpoint(raced.value, input.record, bindingDigest);
}

async function headCheckpoint(
  bucket: R2Bucket,
  objectKey: string,
): Promise<Result<R2Object | null, HarnessCheckpointError>> {
  try {
    return { ok: true, value: await bucket.head(objectKey) };
  } catch (error) {
    return {
      ok: false,
      error: { code: "checkpoint_read_failed", detail: errorMessage(error) },
    };
  }
}

function validateStoredCheckpoint(
  object: R2Object,
  checkpoint: HarnessCheckpointRecord,
  bindingDigest: string,
): Result<null, CanonicalHarnessCheckpointError> {
  const metadata = object.customMetadata;
  return metadata?.format === CHECKPOINT_METADATA_FORMAT &&
    metadata.sha256 === checkpoint.blob.sha256 &&
    metadata.byteLength === String(checkpoint.blob.byteLength) &&
    metadata.formatVersion === checkpoint.blob.formatVersion &&
    metadata.harnessBuild === checkpoint.blob.harnessBuild &&
    metadata.backendId === checkpoint.backendId &&
    metadata.semanticBinding === bindingDigest
    ? { ok: true, value: null }
    : { ok: false, error: { code: "harness_checkpoint_object_conflict" } };
}

function checkpointMetadata(
  checkpoint: HarnessCheckpointRecord,
  bindingDigest: string,
): Record<string, string> {
  return {
    format: CHECKPOINT_METADATA_FORMAT,
    sha256: checkpoint.blob.sha256,
    byteLength: String(checkpoint.blob.byteLength),
    formatVersion: checkpoint.blob.formatVersion,
    harnessBuild: checkpoint.blob.harnessBuild,
    backendId: checkpoint.backendId,
    semanticBinding: bindingDigest,
  };
}

function checkpointBinding(checkpoint: HarnessCheckpointRecord): string {
  return JSON.stringify([
    CHECKPOINT_METADATA_FORMAT,
    checkpoint.backendId,
    checkpoint.session,
    checkpoint.turn,
    checkpoint.runtimeLease,
    checkpoint.runtimeRevision,
    checkpoint.policyVersion,
    checkpoint.budgetRevision,
    checkpoint.budgetUsage,
    checkpoint.usageCursor,
    checkpoint.budgetAccountDigest,
    checkpoint.cursor,
    checkpoint.historyCursor,
    checkpoint.lastActorEventSequence,
    checkpoint.workspaceBaseRevision,
    checkpoint.workspaceRevision,
    checkpoint.instructionDigest,
    checkpoint.toolCatalogDigest,
    checkpoint.modelRouteDigest,
    checkpoint.blob,
  ]);
}

function budgetUsageEqual(
  left: SessionBudgetAccount["usage"],
  right: SessionBudgetAccount["usage"],
): boolean {
  return (
    left.tokens === right.tokens &&
    left.activeWallMs === right.activeWallMs &&
    left.capabilityCalls === right.capabilityCalls
  );
}
