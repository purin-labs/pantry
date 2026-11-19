import {
  admittedCodeModeExecutionRecord,
  encodeCodeModeExecutionRecord,
} from "../code-mode-execution-record";
import { parseFlowSource } from "../../policy/information-flow/oac";
import { parseProjectSnapshot, type ProjectSnapshot } from "@purin-labs/control-api";
import type {
  AcceptedInputRef,
  EventEnvelope,
  SessionTransition,
} from "@purin-labs/contracts";
import type { Result } from "../../result";
import { readCanonicalSessionProjection } from "../agent-session-canonical";
import {
  canonicalFlowLabel,
  FlowLabel,
  ObservationEvidence,
} from "../../policy";
import {
  memoryObservationRecordId,
  type ContextBundle,
} from "../../context/assembly";
import type { VariantBy } from "@purin-labs/type-utils";
import { hasExactKeys, isNonEmptyString, isRecord } from "@purin-labs/std";
import type {
  AcceptedActorCommand,
  AcceptedInputLookup,
  AcceptedInputReadError,
  AcceptedSessionInputCommit,
  ActorInboxRow,
  ActorJournalEnvelopeRow,
  ActorTransitionCommitError,
  ActorTransitionCommitResult,
  ExecutionRequestedSessionCommit,
  HarnessLeaseProjectionRow,
  HistoricalContextBundle,
  JournaledSessionCommit,
  RuntimeActivatedSessionCommit,
  SessionTurnMemoryRendering,
  StoredContextBundle,
} from "../actor-journal";

export function readDuplicateAcceptance(
  sql: SqlStorage,
  input: JournaledSessionCommit,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> | null {
  const row = sql
    .exec<ActorInboxRow>(
      `SELECT organisation_id, operation_id, outcome
       FROM actor_inbox
       WHERE source = ? AND idempotency_key = ?
       LIMIT 1`,
      input.source,
      input.event.idempotencyKey,
    )
    .toArray()[0];

  if (row === undefined) {
    return null;
  }
  if (
    row.organisation_id !== input.event.organisationId ||
    row.operation_id !== input.commandId
  ) {
    return { ok: false, error: { code: "idempotency_conflict" } };
  }

  const outcome = parseAcceptedOutcome(row.outcome);

  if (!outcome.ok) {
    return outcome;
  }

  if (
    outcome.value.eventId !== input.event.eventId ||
    outcome.value.sequence !== input.event.sequence
  ) {
    return { ok: false, error: { code: "idempotency_conflict" } };
  }
  const journal = sql
    .exec<ActorJournalEnvelopeRow>(
      `SELECT envelope FROM actor_journal WHERE event_id = ? LIMIT 1`,
      outcome.value.eventId,
    )
    .toArray()[0];
  if (journal === undefined) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }
  if (journal.envelope !== JSON.stringify(input.event)) {
    return { ok: false, error: { code: "idempotency_conflict" } };
  }
  if (input.source === "capacity_governor") {
    const lease = sql
      .exec<HarnessLeaseProjectionRow>(
        `SELECT lease_projection
       FROM session_harness_lease
       WHERE session_id = ? AND lease_id = ?
       LIMIT 1`,
        input.harnessLease.session.sessionId,
        input.harnessLease.leaseId,
      )
      .toArray()[0];
    if (lease === undefined) {
      const current = readCanonicalSessionProjection(
        sql,
        input.event.organisationId,
        input.event.actorId,
      );
      if (
        current === null ||
        current.state.contract.lastEventSequence <= input.event.sequence
      ) {
        return { ok: false, error: { code: "invalid_persisted_state" } };
      }
      return duplicateOutcome(outcome.value);
    }
    if (lease.lease_projection !== JSON.stringify(input.harnessLease)) {
      return { ok: false, error: { code: "idempotency_conflict" } };
    }
  }

  return duplicateOutcome(outcome.value);
}

function duplicateOutcome(
  outcome: AcceptedActorCommand,
): Result<ActorTransitionCommitResult, ActorTransitionCommitError> {
  return {
    ok: true,
    value: {
      kind: "duplicate",
      eventId: outcome.eventId,
      sequence: outcome.sequence,
    },
  };
}

export function readNextSequence(sql: SqlStorage, streamId: string): number {
  const row = sql
    .exec<{ last_sequence: number }>(
      `SELECT COALESCE(MAX(sequence), -1) AS last_sequence
       FROM actor_journal
       WHERE stream_id = ?`,
      streamId,
    )
    .toArray()[0];
  return (row?.last_sequence ?? -1) + 1;
}

export function writeJournalEvent(
  sql: SqlStorage,
  input: AcceptedSessionInputCommit,
  envelope: string,
): void {
  sql.exec(
    `INSERT INTO actor_journal (organisation_id, stream_id, sequence, event_id, envelope)
     VALUES (?, ?, ?, ?, ?)`,
    input.event.organisationId,
    input.event.streamId,
    input.event.sequence,
    input.event.eventId,
    envelope,
  );
}

export function writeRuntimeActivatedJournalEvent(
  sql: SqlStorage,
  input: RuntimeActivatedSessionCommit,
  envelope: string,
): void {
  sql.exec(
    `INSERT INTO actor_journal (organisation_id, stream_id, sequence, event_id, envelope)
     VALUES (?, ?, ?, ?, ?)`,
    input.event.organisationId,
    input.event.streamId,
    input.event.sequence,
    input.event.eventId,
    envelope,
  );
}

export function writeSessionJournalEvent(
  sql: SqlStorage,
  event: EventEnvelope<SessionTransition>,
  envelope: string,
): void {
  sql.exec(
    `INSERT INTO actor_journal (organisation_id, stream_id, sequence, event_id, envelope)
     VALUES (?, ?, ?, ?, ?)`,
    event.organisationId,
    event.streamId,
    event.sequence,
    event.eventId,
    envelope,
  );
}

export function writeInboxAcceptance(
  sql: SqlStorage,
  input: Pick<JournaledSessionCommit, "event" | "source" | "commandId">,
  outcome: AcceptedActorCommand,
): void {
  sql.exec(
    `INSERT INTO actor_inbox (organisation_id, source, idempotency_key, operation_id, outcome)
     VALUES (?, ?, ?, ?, ?)`,
    input.event.organisationId,
    input.source,
    input.event.idempotencyKey,
    input.commandId,
    JSON.stringify(outcome),
  );
}

export function writeExecutionRequest(
  sql: SqlStorage,
  input: ExecutionRequestedSessionCommit,
): void {
  const effectId = input.event.body.request.effectId;
  // The record keeps the runtime generation of the lease and the deadline of
  // this first admission. A later generation rebinds the lease, not the deadline.
  const requestEnvelope = encodeCodeModeExecutionRecord(
    admittedCodeModeExecutionRecord(input.reserve),
  );
  const stateProjection = JSON.stringify({
    kind: "pending",
    capabilityCalls: 0,
    inputBytes: 0,
    outputBytes: 0,
  });
  sql.exec(
    `INSERT INTO actor_outbox (
       effect_id, organisation_id, originating_event_id, request_envelope,
       state_kind, state_projection, updated_at
     ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    effectId,
    input.event.organisationId,
    input.event.eventId,
    requestEnvelope,
    stateProjection,
    input.event.acceptedAt,
  );
}

function parseAcceptedOutcome(
  raw: string,
): Result<
  AcceptedActorCommand,
  VariantBy<ActorTransitionCommitError, "code", "invalid_persisted_state">
> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }

  if (
    !isRecord(parsed) ||
    parsed.kind !== "accepted" ||
    typeof parsed.eventId !== "string" ||
    parsed.eventId.length === 0 ||
    typeof parsed.sequence !== "number" ||
    !Number.isSafeInteger(parsed.sequence) ||
    parsed.sequence < 0
  ) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }

  return {
    ok: true,
    value: {
      kind: "accepted",
      eventId: parsed.eventId,
      sequence: parsed.sequence,
    },
  };
}

export function parseAcceptedInputEnvelope(
  raw: string,
  lookup: AcceptedInputLookup,
): Result<AcceptedInputRef, AcceptedInputReadError> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }
  if (
    !isRecord(envelope) ||
    envelope.organisationId !== lookup.organisationId ||
    envelope.actorId !== lookup.sessionId ||
    envelope.streamId !== lookup.streamId ||
    !isRecord(envelope.body) ||
    envelope.body.kind !== "input_accepted" ||
    !isRecord(envelope.body.input) ||
    !isRecord(envelope.body.state) ||
    envelope.body.state.turnId !== lookup.turnId ||
    envelope.body.state.inputId !== lookup.inputId
  ) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }
  const input = envelope.body.input;
  if (input.inputId !== lookup.inputId) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }
  if (
    typeof input.contextBundleDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.contextBundleDigest)
  ) {
    return { ok: false, error: { code: "invalid_persisted_state" } };
  }
  if (input.kind === "case") {
    if (
      !hasExactKeys(input, [
        "kind",
        "inputId",
        "caseId",
        "assignmentId",
        "caseRevision",
        "contentDigest",
        "workspaceRevision",
        "contextBundleDigest",
      ]) ||
      !isNonEmptyString(input.caseId) ||
      !isNonEmptyString(input.assignmentId) ||
      !Number.isSafeInteger(input.caseRevision) ||
      Number(input.caseRevision) < 0 ||
      typeof input.contentDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(input.contentDigest) ||
      !isNonEmptyString(input.workspaceRevision)
    )
      return { ok: false, error: { code: "invalid_persisted_state" } };
    return {
      ok: true,
      value: {
        kind: "case",
        inputId: lookup.inputId,
        caseId: input.caseId,
        assignmentId: input.assignmentId,
        caseRevision: Number(input.caseRevision),
        contentDigest: input.contentDigest,
        workspaceRevision: input.workspaceRevision,
        contextBundleDigest: input.contextBundleDigest,
      },
    };
  }
  return { ok: false, error: { code: "invalid_persisted_state" } };
}

export function serializeContextBundle(bundle: StoredContextBundle): unknown {
  return {
    organisationId: bundle.organisationId,
    caseId: bundle.caseId,
    assignmentId: bundle.assignmentId,
    sessionId: bundle.sessionId,
    policyVersion: bundle.policyVersion,
    assemblyStrategyVersion: bundle.assemblyStrategyVersion,
    assembledAt: bundle.assembledAt,
    items: bundle.items.map(canonicalContextItem),
    usage: bundle.usage,
    disposition: bundle.disposition,
    ...(bundle.memory === undefined ? {} : { memory: bundle.memory }),
  };
}

function canonicalContextItem(item: ContextBundle["items"][number]): unknown {
  return {
    source: canonicalContextSource(item.source),
    provenance: item.provenance,
    sourceRevision: item.sourceRevision,
    contentDigest: item.contentDigest,
    boundedExcerpt: item.boundedExcerpt,
    inputLabel: canonicalFlowLabel(item.inputLabel),
    observationEvidence: item.observationEvidence.toJSON(),
    observedAt: item.observedAt,
    freshness:
      item.freshness.kind === "fresh"
        ? { kind: "fresh" }
        : {
            kind: "stale",
            ageMs: item.freshness.ageMs,
            reason: item.freshness.reason,
          },
    retrievalEvidence: {
      exactPhraseMatch: item.retrievalEvidence.exactPhraseMatch,
      tokenOverlapMillionths: item.retrievalEvidence.tokenOverlapMillionths,
      recencyRank: item.retrievalEvidence.recencyRank,
    },
  };
}

function canonicalContextSource(
  source: ContextBundle["items"][number]["source"],
): unknown {
  switch (source.kind) {
    case "project_observation":
      return source;
    case "memory":
      return {
        kind: source.kind,
        memoryId: source.memoryId,
        revision: source.revision,
      };
    case "case_entry":
      return {
        kind: source.kind,
        caseId: source.caseId,
        entryId: source.entryId,
      };
    case "file_segment":
      return {
        kind: source.kind,
        integrationAccountId: source.integrationAccountId,
        provider: source.provider,
        providerFileId: source.providerFileId,
        segmentIndex: source.segmentIndex,
      };
  }
}

export async function parseContextBundle(
  value: unknown,
): Promise<StoredContextBundle | null> {
  const bundleKeys = [
    "organisationId",
    "caseId",
    "assignmentId",
    "sessionId",
    "policyVersion",
    "assemblyStrategyVersion",
    "assembledAt",
    "items",
    "usage",
    "disposition",
  ];
  if (
    !isRecord(value) ||
    // A bundle accepted before Memory admission has no Memory outcome.
    !(
      hasExactKeys(value, bundleKeys) ||
      hasExactKeys(value, [...bundleKeys, "memory"])
    ) ||
    !isNonEmptyString(value.organisationId) ||
    !isNonEmptyString(value.caseId) ||
    !isNonEmptyString(value.assignmentId) ||
    !isNonEmptyString(value.sessionId) ||
    !isNonEmptyString(value.policyVersion) ||
    value.assemblyStrategyVersion !== "context_assembly_v1" ||
    !Number.isSafeInteger(value.assembledAt) ||
    Number(value.assembledAt) < 0 ||
    !Array.isArray(value.items) ||
    !isRecord(value.usage) ||
    !hasExactKeys(value.usage, ["items", "estimatedTokens"]) ||
    !Number.isSafeInteger(value.usage.items) ||
    Number(value.usage.items) < 0 ||
    !Number.isSafeInteger(value.usage.estimatedTokens) ||
    Number(value.usage.estimatedTokens) < 0
  ) {
    return null;
  }
  const items: ContextBundle["items"][number][] = [];
  for (const rawItem of value.items) {
    const item = await parseContextItem(rawItem);
    if (item === null) return null;
    items.push(item);
  }
  const disposition = parseContextDisposition(value.disposition);
  if (disposition === null || Number(value.usage.items) !== items.length)
    return null;
  const historical: HistoricalContextBundle = {
    organisationId: value.organisationId,
    caseId: value.caseId,
    assignmentId: value.assignmentId,
    sessionId: value.sessionId,
    policyVersion: value.policyVersion,
    assemblyStrategyVersion: value.assemblyStrategyVersion,
    assembledAt: Number(value.assembledAt),
    items,
    usage: {
      items: Number(value.usage.items),
      estimatedTokens: Number(value.usage.estimatedTokens),
    },
    disposition,
  };
  if (value.memory === undefined)
    // No Memory outcome, so no Memory item either.
    return items.some(isMemoryItem) ? null : historical;
  const memory = parseContextMemoryOutcome(value.memory, items);
  return memory === null ? null : { ...historical, memory };
}

function isMemoryItem(item: ContextBundle["items"][number]): boolean {
  return item.source.kind === "memory";
}

/**
 * The recorded Memory outcome. Its revisions must be exactly the bundle's
 * Memory items, so neither can be changed without the other.
 */
function parseContextMemoryOutcome(
  value: unknown,
  items: readonly ContextBundle["items"][number][],
): ContextBundle["memory"] | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  const admitted: { memoryId: string; revision: number }[] = [];
  for (const item of items)
    if (item.source.kind === "memory")
      admitted.push({
        memoryId: item.source.memoryId,
        revision: item.source.revision,
      });
  const revisions = Array.isArray(value.revisions) ? value.revisions : null;
  const recordsItems =
    revisions !== null &&
    JSON.stringify(revisions) === JSON.stringify(admitted);
  switch (value.kind) {
    case "none":
      return hasExactKeys(value, ["kind"]) && admitted.length === 0
        ? { kind: "none" }
        : null;
    case "admitted":
      return hasExactKeys(value, ["kind", "revisions"]) &&
        recordsItems &&
        admitted.length > 0
        ? { kind: "admitted", revisions: admitted }
        : null;
    case "limited":
      return hasExactKeys(value, ["kind", "revisions", "reason"]) &&
        recordsItems &&
        (value.reason === "items" || value.reason === "tokens")
        ? { kind: "limited", revisions: admitted, reason: value.reason }
        : null;
    case "unavailable":
      return hasExactKeys(value, ["kind", "reason"]) &&
        admitted.length === 0 &&
        (value.reason === "deadline" || value.reason === "read_failed")
        ? { kind: "unavailable", reason: value.reason }
        : null;
    default:
      return null;
  }
}

async function parseContextItem(
  value: unknown,
): Promise<ContextBundle["items"][number] | null> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "source",
      "provenance",
      "sourceRevision",
      "contentDigest",
      "boundedExcerpt",
      "inputLabel",
      "observationEvidence",
      "observedAt",
      "freshness",
      "retrievalEvidence",
    ]) ||
    !Number.isSafeInteger(value.sourceRevision) ||
    Number(value.sourceRevision) <= 0 ||
    typeof value.contentDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.contentDigest) ||
    typeof value.boundedExcerpt !== "string" ||
    !Number.isSafeInteger(value.observedAt) ||
    Number(value.observedAt) < 0
  )
    return null;
  const source = parseContextSource(value.source);
  const provenance = parseContextProvenance(value.provenance, source);
  if (source === null || provenance === null) return null;
  const inputLabel = await FlowLabel.restore(value.inputLabel);
  const observationEvidence = await ObservationEvidence.restore(
    value.observationEvidence,
  );
  const freshness = parseContextFreshness(value.freshness);
  const retrievalEvidence = parseContextRetrievalEvidence(
    value.retrievalEvidence,
  );
  if (
    !inputLabel.ok ||
    !observationEvidence.ok ||
    freshness === null ||
    retrievalEvidence === null ||
    !observationSourceMatchesContextSource(
      observationEvidence.value.source,
      source,
      provenance,
    ) ||
    observationEvidence.value.sourceRevision !== Number(value.sourceRevision) ||
    observationEvidence.value.contentDigest !== value.contentDigest ||
    observationEvidence.value.observedAt !== Number(value.observedAt) ||
    observationEvidence.value.flowLabelDigest !== inputLabel.value.digest
  )
    return null;
  return {
    source,
    provenance,
    sourceRevision: Number(value.sourceRevision),
    contentDigest: value.contentDigest,
    boundedExcerpt: value.boundedExcerpt,
    inputLabel: inputLabel.value,
    observationEvidence: observationEvidence.value,
    observedAt: Number(value.observedAt),
    freshness,
    retrievalEvidence,
  };
}

function parseContextProvenance(
  value: unknown,
  source: ContextBundle["items"][number]["source"] | null,
): ContextBundle["items"][number]["provenance"] | null {
  if (source === null || !isRecord(value) || typeof value.kind !== "string")
    return null;
  if (source.kind === "project_observation")
    return (value.kind === "project_context" ||
      value.kind === "native_chat_input") &&
      hasExactKeys(value, ["kind"])
      ? { kind: value.kind }
      : null;
  if (source.kind === "case_entry") {
    return value.kind === "case_entry" && hasExactKeys(value, ["kind"])
      ? { kind: "case_entry" }
      : null;
  }
  if (source.kind === "memory")
    return value.kind === "memory" && hasExactKeys(value, ["kind"])
      ? { kind: "memory" }
      : null;
  return value.kind === "integration_file" &&
    hasExactKeys(value, [
      "kind",
      "integrationAccountId",
      "provider",
      "resourceScope",
      "displayName",
      "displayPath",
      "deepLink",
      "mediaType",
      "metadataOnlyReason",
    ]) &&
    value.integrationAccountId === source.integrationAccountId &&
    value.provider === source.provider &&
    isNonEmptyString(value.resourceScope) &&
    isNonEmptyString(value.displayName) &&
    isNonEmptyString(value.displayPath) &&
    isNonEmptyString(value.deepLink) &&
    isNonEmptyString(value.mediaType) &&
    (value.metadataOnlyReason === null ||
      isNonEmptyString(value.metadataOnlyReason))
    ? {
        kind: "integration_file",
        integrationAccountId: source.integrationAccountId,
        provider: source.provider,
        resourceScope: value.resourceScope,
        displayName: value.displayName,
        displayPath: value.displayPath,
        deepLink: value.deepLink,
        mediaType: value.mediaType,
        metadataOnlyReason: value.metadataOnlyReason,
      }
    : null;
}

function parseContextSource(
  value: unknown,
): ContextBundle["items"][number]["source"] | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  switch (value.kind) {
    case "project_observation": {
      const source = parseFlowSource(value.source);
      return source !== null &&
        isNonEmptyString(value.snapshotDigest) &&
        hasExactKeys(value, ["kind", "source", "snapshotDigest"])
        ? {
            kind: "project_observation",
            source,
            snapshotDigest: value.snapshotDigest,
          }
        : null;
    }
    case "case_entry":
      return hasExactKeys(value, ["kind", "caseId", "entryId"]) &&
        isNonEmptyString(value.caseId) &&
        isNonEmptyString(value.entryId)
        ? { kind: "case_entry", caseId: value.caseId, entryId: value.entryId }
        : null;
    case "memory":
      return hasExactKeys(value, ["kind", "memoryId", "revision"]) &&
        isNonEmptyString(value.memoryId) &&
        typeof value.revision === "number" &&
        Number.isSafeInteger(value.revision) &&
        value.revision > 0
        ? { kind: "memory", memoryId: value.memoryId, revision: value.revision }
        : null;
    case "file_segment":
      return hasExactKeys(value, [
        "kind",
        "integrationAccountId",
        "provider",
        "providerFileId",
        "segmentIndex",
      ]) &&
        isNonEmptyString(value.integrationAccountId) &&
        (value.provider === "dropbox" || value.provider === "google_drive") &&
        isNonEmptyString(value.providerFileId) &&
        Number.isSafeInteger(value.segmentIndex) &&
        Number(value.segmentIndex) >= 0
        ? {
            kind: "file_segment",
            integrationAccountId: value.integrationAccountId,
            provider: value.provider,
            providerFileId: value.providerFileId,
            segmentIndex: Number(value.segmentIndex),
          }
        : null;
    default:
      return null;
  }
}

function observationSourceMatchesContextSource(
  observationSource: ObservationEvidence["source"],
  contextSource: ContextBundle["items"][number]["source"],
  provenance: ContextBundle["items"][number]["provenance"],
): boolean {
  if (contextSource.kind === "project_observation")
    return (
      JSON.stringify(observationSource) === JSON.stringify(contextSource.source)
    );
  switch (observationSource.kind) {
    case "case_context_collection_evidence":
    case "project":
    case "chat_conversation":
      return false;
    case "organisation_record":
      return (
        contextSource.kind === "memory" &&
        observationSource.recordId ===
          memoryObservationRecordId(contextSource.memoryId)
      );
    case "case_entry":
      return (
        contextSource.kind === "case_entry" &&
        contextSource.caseId === observationSource.caseId &&
        contextSource.entryId === observationSource.entryId
      );
    case "integration_resource":
      return (
        contextSource.kind === "file_segment" &&
        provenance.kind === "integration_file" &&
        observationSource.integrationAccountId ===
          provenance.integrationAccountId &&
        observationSource.resourceScope === provenance.resourceScope
      );
  }
}

function parseContextFreshness(
  value: unknown,
): ContextBundle["items"][number]["freshness"] | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "fresh") {
    return hasExactKeys(value, ["kind"]) ? { kind: "fresh" } : null;
  }
  return value.kind === "stale" &&
    hasExactKeys(value, ["kind", "ageMs", "reason"]) &&
    Number.isSafeInteger(value.ageMs) &&
    Number(value.ageMs) >= 0 &&
    isNonEmptyString(value.reason)
    ? { kind: "stale", ageMs: Number(value.ageMs), reason: value.reason }
    : null;
}

function parseContextRetrievalEvidence(
  value: unknown,
): ContextBundle["items"][number]["retrievalEvidence"] | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "exactPhraseMatch",
      "tokenOverlapMillionths",
      "recencyRank",
    ]) ||
    typeof value.exactPhraseMatch !== "boolean" ||
    !Number.isSafeInteger(value.tokenOverlapMillionths) ||
    Number(value.tokenOverlapMillionths) < 0 ||
    Number(value.tokenOverlapMillionths) > 1_000_000 ||
    !Number.isSafeInteger(value.recencyRank) ||
    Number(value.recencyRank) < 0
  )
    return null;
  return {
    exactPhraseMatch: value.exactPhraseMatch,
    tokenOverlapMillionths: Number(value.tokenOverlapMillionths),
    recencyRank: Number(value.recencyRank),
  };
}

function parseContextDisposition(
  value: unknown,
): ContextBundle["disposition"] | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "complete") {
    return hasExactKeys(value, ["kind"]) ? { kind: "complete" } : null;
  }
  return value.kind === "truncated" &&
    hasExactKeys(value, ["kind", "limitingDimension"]) &&
    (value.limitingDimension === "items" ||
      value.limitingDimension === "tokens" ||
      value.limitingDimension === "time")
    ? { kind: "truncated", limitingDimension: value.limitingDimension }
    : null;
}

export function parseStoredTurnContext(raw: unknown): {
  bundle: unknown;
  projectContext: ProjectSnapshot | null;
  memoryRendering: SessionTurnMemoryRendering | null;
} | null {
  if (
    isRecord(raw) &&
    hasExactKeys(raw, ["bundle", "projectContext", "memoryRendering"])
  ) {
    const memoryRendering = parseMemoryRendering(raw.memoryRendering);
    // A transient turn records its rendering and inherits no project.
    return memoryRendering === null || raw.projectContext !== null
      ? null
      : { bundle: raw.bundle, projectContext: null, memoryRendering };
  }
  if (isRecord(raw) && hasExactKeys(raw, ["bundle", "projectContext"])) {
    if (raw.projectContext === null)
      return {
        bundle: raw.bundle,
        projectContext: null,
        memoryRendering: null,
      };
    const projectContext = parseProjectSnapshot(raw.projectContext);
    return projectContext === null
      ? null
      : { bundle: raw.bundle, projectContext, memoryRendering: null };
  }
  // Normalize turn-context records written before project inheritance at the storage boundary.
  return { bundle: raw, projectContext: null, memoryRendering: null };
}

function parseMemoryRendering(raw: unknown): SessionTurnMemoryRendering | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["revisions", "omittedForBytes"]) ||
    !Array.isArray(raw.revisions) ||
    typeof raw.omittedForBytes !== "boolean"
  )
    return null;
  const revisions: { memoryId: string; revision: number }[] = [];
  for (const entry of raw.revisions) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["memoryId", "revision"]) ||
      !isNonEmptyString(entry.memoryId) ||
      typeof entry.revision !== "number" ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 1
    )
      return null;
    revisions.push({ memoryId: entry.memoryId, revision: entry.revision });
  }
  return { revisions, omittedForBytes: raw.omittedForBytes };
}

export function normalizedStoredTurnContext(raw: string): string | null {
  try {
    const parsed = parseStoredTurnContext(JSON.parse(raw));
    return parsed === null
      ? null
      : JSON.stringify({
          bundle: parsed.bundle,
          projectContext: parsed.projectContext,
        });
  } catch {
    return null;
  }
}
