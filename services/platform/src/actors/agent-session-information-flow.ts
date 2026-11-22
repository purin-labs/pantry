import {
  memoryObservationRecordId,
  type ContextBundle,
} from "../context/assembly";
import type { Result } from "@purin-labs/kernel/result";
import {
  advanceInformationFlowContext,
  FlowBinding,
  FlowLabel,
  flowBindingForContext,
  InformationFlowContext,
  ObservationEvidence,
} from "../policy";
import { isRecord } from "@purin-labs/std";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type SessionInformationFlowError =
  | Readonly<{
      readonly code: "session_information_flow_invalid";
      readonly field: string;
    }>
  | Readonly<{ readonly code: "session_information_flow_conflict" }>
  | Readonly<{ readonly code: "session_information_flow_stale" }>
  | Readonly<{ readonly code: "session_information_flow_authority_mismatch" }>
  | Readonly<{
      readonly code: "session_information_flow_observation_missing";
      readonly evidenceDigest: string;
    }>;

type SessionInformationFlowLookup = Readonly<{
  readonly organisationId: string;
  readonly sessionId: string;
}>;

type SessionInformationFlowTurnLookup = SessionInformationFlowLookup &
  Readonly<{
    readonly turnId: string;
  }>;

type SessionInformationFlowTurnBinding = Readonly<{
  readonly turnId: string;
  readonly authorityPartitionDigest: string;
  readonly revision: number;
  readonly binding: FlowBinding;
}>;

type SessionInformationFlowState = Readonly<{
  readonly context: InformationFlowContext;
  readonly observations: readonly ObservationEvidence[];
}>;

export type SessionInformationFlowCommit = Readonly<{
  readonly organisationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly authorityPartitionDigest: string;
  readonly context: InformationFlowContext;
  readonly binding: FlowBinding;
  readonly observations: readonly ObservationEvidence[];
  readonly committedAt: number;
}>;

type PrepareSessionInformationFlowInput = Readonly<{
  readonly sql: SqlStorage;
  readonly organisationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly authorityPartitionDigest: string;
  /** A stored bundle, with or without a recorded Memory outcome. */
  readonly contextBundle: Omit<ContextBundle, "memory">;
}>;

type AdmitSessionInformationFlowObservationInput = Readonly<{
  readonly sql: SqlStorage;
  readonly transactionSync: <T>(callback: () => T) => T;
  readonly authorizeCommit: () => void | Promise<void>;
  readonly organisationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly authorityPartitionDigest: string;
  readonly inputLabel: FlowLabel;
  readonly observation: ObservationEvidence;
  readonly observedAt: number;
}>;

type SessionInformationFlowRevisionRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  session_id: string;
  revision: number;
  turn_id: string;
  authority_partition_digest: string;
  context_digest: string;
  context_json: string;
  committed_at: number;
};

type SessionInformationFlowObservationRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  session_id: string;
  evidence_digest: string;
  evidence_json: string;
  recorded_at: number;
};

type SessionInformationFlowTurnBindingRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  session_id: string;
  turn_id: string;
  authority_partition_digest: string;
  revision: number;
  context_digest: string;
  binding_json: string;
  prepared_at: number;
};

type PreparedContextObservation = Readonly<{
  readonly label: FlowLabel;
  readonly evidence: ObservationEvidence;
}>;

export function createSessionInformationFlowSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_information_flow_observation (
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      evidence_digest TEXT NOT NULL CHECK (
        length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'
      ),
      evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
      recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
      PRIMARY KEY (session_id, evidence_digest)
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_information_flow_revision (
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      authority_partition_digest TEXT NOT NULL CHECK (
        length(authority_partition_digest) = 64
        AND authority_partition_digest NOT GLOB '*[^0-9a-f]*'
      ),
      context_digest TEXT NOT NULL CHECK (
        length(context_digest) = 64 AND context_digest NOT GLOB '*[^0-9a-f]*'
      ),
      context_json TEXT NOT NULL CHECK (json_valid(context_json)),
      committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
      PRIMARY KEY (session_id, revision),
      UNIQUE (session_id, turn_id)
    )`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS session_information_flow_observation_organisation
     ON session_information_flow_observation (organisation_id, session_id)`,
  );
  // The exact commerce records one admitted observation returned. A proposal
  // may only target a record this session actually read, so naming a plausible
  // identifier is not enough to stage a change against it.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_commerce_observation_entity (
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      evidence_digest TEXT NOT NULL CHECK (
        length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'
      ),
      entity_type TEXT NOT NULL CHECK (length(entity_type) > 0),
      entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
      revision INTEGER NOT NULL CHECK (revision > 0),
      observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
      PRIMARY KEY (session_id, evidence_digest, entity_type, entity_id)
    )`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS session_commerce_observation_entity_lookup
     ON session_commerce_observation_entity (session_id, entity_type, entity_id, revision)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_information_flow_turn_binding (
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      authority_partition_digest TEXT NOT NULL CHECK (
        length(authority_partition_digest) = 64
        AND authority_partition_digest NOT GLOB '*[^0-9a-f]*'
      ),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      context_digest TEXT NOT NULL CHECK (
        length(context_digest) = 64 AND context_digest NOT GLOB '*[^0-9a-f]*'
      ),
      binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
      prepared_at INTEGER NOT NULL CHECK (prepared_at >= 0),
      PRIMARY KEY (session_id, turn_id)
    )`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS session_information_flow_turn_binding_revision
     ON session_information_flow_turn_binding (session_id, revision)`,
  );
}

export async function prepareSessionInformationFlow(
  input: PrepareSessionInformationFlowInput,
): Promise<Result<SessionInformationFlowCommit, SessionInformationFlowError>> {
  const identity = validatePreparationInput(input);
  if (identity !== null) return invalid(identity);
  const existing = await readSessionInformationFlow(input.sql, {
    organisationId: input.organisationId,
    sessionId: input.sessionId,
  });
  if (!existing.ok) return existing;
  if (
    existing.value !== null &&
    existing.value.context.authorityPartitionDigest !==
      input.authorityPartitionDigest
  ) {
    return {
      ok: false,
      error: { code: "session_information_flow_authority_mismatch" },
    };
  }

  const initial =
    existing.value === null
      ? await createInitialContext(input)
      : { ok: true as const, value: existing.value.context };
  if (!initial.ok) return initial;
  const observations = await buildContextObservations(input);
  if (!observations.ok) return observations;
  const next = await advanceContextWithObservations(
    initial.value,
    observations.value,
  );
  if (!next.ok) return next;
  return {
    ok: true,
    value: {
      organisationId: input.organisationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      authorityPartitionDigest: input.authorityPartitionDigest,
      context: next.value,
      binding: flowBindingForContext(next.value, input.turnId),
      observations: observations.value.map(readObservation),
      committedAt: input.contextBundle.assembledAt,
    },
  };
}

/**
 * Admit a trusted runtime observation after PAC has passed it. The same turn
 * binding is advanced with the session context so proposals made later in the
 * turn carry the observation-derived label.
 */
export async function admitSessionInformationFlowObservation(
  input: AdmitSessionInformationFlowObservationInput,
): Promise<Result<SessionInformationFlowCommit, SessionInformationFlowError>> {
  const valid = validateObservationAdmissionInput(input);
  if (valid !== null) return invalid(valid);
  if (
    !FlowLabel.is(input.inputLabel) ||
    !ObservationEvidence.is(input.observation)
  ) {
    return invalid("trusted_observation");
  }
  if (input.observation.flowLabelDigest !== input.inputLabel.digest) {
    return invalid("observation.label");
  }
  // Parallel tool calls of one Session admit their observations at the same
  // time. A write that another admission overtook is refused as stale; the
  // next attempt reads the context with that observation in it.
  for (let attempt = 1; ; attempt += 1) {
    const admitted = await admitObservationOnce(input);
    if (
      admitted.ok ||
      admitted.error.code !== "session_information_flow_stale" ||
      attempt === STALE_OBSERVATION_ATTEMPTS
    )
      return admitted;
  }
}

const STALE_OBSERVATION_ATTEMPTS = 3;

async function admitObservationOnce(
  input: AdmitSessionInformationFlowObservationInput,
): Promise<Result<SessionInformationFlowCommit, SessionInformationFlowError>> {
  const current = await readSessionInformationFlow(input.sql, {
    organisationId: input.organisationId,
    sessionId: input.sessionId,
  });
  if (!current.ok) return current;
  if (current.value === null) return invalid("context_missing");
  if (
    current.value.context.authorityPartitionDigest !==
    input.authorityPartitionDigest
  ) {
    return {
      ok: false,
      error: { code: "session_information_flow_authority_mismatch" },
    };
  }
  const recordedObservation = current.value.observations.find(
    (observation) =>
      observation.evidenceDigest === input.observation.evidenceDigest,
  );
  const observation = recordedObservation ?? input.observation;
  const advanced = await advanceInformationFlowContext({
    context: current.value.context,
    observation,
    inputLabel: input.inputLabel,
  });
  if (!advanced.ok) return invalid(`advance.${advanced.error.code}`);
  const commit: SessionInformationFlowCommit = {
    organisationId: input.organisationId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    authorityPartitionDigest: input.authorityPartitionDigest,
    context: advanced.value.context,
    binding: flowBindingForContext(advanced.value.context, input.turnId),
    observations: [observation],
    committedAt: input.observedAt,
  };
  await input.authorizeCommit();
  const written = input.transactionSync(
    appendInformationFlowCommit.bind(null, {
      sql: input.sql,
      commit,
    }),
  );
  return written.ok ? { ok: true, value: commit } : written;
}

function appendInformationFlowCommit(
  input: Readonly<{
    readonly sql: SqlStorage;
    readonly commit: SessionInformationFlowCommit;
  }>,
): Result<null, SessionInformationFlowError> {
  return appendSessionInformationFlowInTransaction(input.sql, input.commit);
}

export async function readSessionInformationFlow(
  sql: SqlStorage,
  lookup: SessionInformationFlowLookup,
): Promise<
  Result<SessionInformationFlowState | null, SessionInformationFlowError>
> {
  if (lookup.organisationId.length === 0 || lookup.sessionId.length === 0) {
    return invalid("identity");
  }
  const rows = sql
    .exec<SessionInformationFlowRevisionRow>(
      `SELECT organisation_id, session_id, revision, turn_id,
            authority_partition_digest, context_digest, context_json,
            committed_at
       FROM session_information_flow_revision
      WHERE organisation_id = ? AND session_id = ?
      ORDER BY revision DESC
      LIMIT 1`,
      lookup.organisationId,
      lookup.sessionId,
    )
    .toArray();
  if (rows.length === 0) {
    const observations = sql
      .exec<{
        readonly observation_count: number;
        readonly turn_binding_count: number;
      }>(
        `SELECT
         (SELECT COUNT(*)
            FROM session_information_flow_observation
           WHERE organisation_id = ? AND session_id = ?) AS observation_count,
         (SELECT COUNT(*)
            FROM session_information_flow_turn_binding
           WHERE organisation_id = ? AND session_id = ?) AS turn_binding_count`,
        lookup.organisationId,
        lookup.sessionId,
        lookup.organisationId,
        lookup.sessionId,
      )
      .toArray()[0];
    return observations !== undefined &&
      observations.observation_count === 0 &&
      observations.turn_binding_count === 0
      ? { ok: true, value: null }
      : invalid("orphan_observations");
  }
  const row = rows[0];
  if (row === undefined) return invalid("revision");
  const context = await restoreJson(
    row.context_json,
    InformationFlowContext.restore,
  );
  if (!context.ok) return context;
  if (
    row.organisation_id !== context.value.organisationId ||
    row.session_id !== context.value.sessionId ||
    row.revision !== context.value.revision ||
    row.authority_partition_digest !== context.value.authorityPartitionDigest ||
    row.context_digest !== context.value.digest ||
    !SHA256_PATTERN.test(row.authority_partition_digest)
  ) {
    return invalid("revision_metadata");
  }
  const observations = await readPersistedObservations(sql, lookup);
  if (!observations.ok) return observations;
  if (!observationSetMatchesContext(observations.value, context.value)) {
    return invalid("observation_set");
  }
  return {
    ok: true,
    value: { context: context.value, observations: observations.value },
  };
}

export async function readSessionTurnFlowBinding(
  sql: SqlStorage,
  lookup: SessionInformationFlowTurnLookup,
): Promise<
  Result<SessionInformationFlowTurnBinding | null, SessionInformationFlowError>
> {
  if (
    lookup.organisationId.length === 0 ||
    lookup.sessionId.length === 0 ||
    lookup.turnId.length === 0
  ) {
    return invalid("identity");
  }
  const rows = sql
    .exec<SessionInformationFlowTurnBindingRow>(
      `SELECT organisation_id, session_id, turn_id, authority_partition_digest,
            revision, context_digest, binding_json, prepared_at
       FROM session_information_flow_turn_binding
      WHERE organisation_id = ? AND session_id = ? AND turn_id = ?
      LIMIT 1`,
      lookup.organisationId,
      lookup.sessionId,
      lookup.turnId,
    )
    .toArray();
  const row = rows[0];
  if (row === undefined) return { ok: true, value: null };
  if (
    rows.length !== 1 ||
    row.organisation_id !== lookup.organisationId ||
    row.session_id !== lookup.sessionId ||
    row.turn_id !== lookup.turnId ||
    !SHA256_PATTERN.test(row.authority_partition_digest) ||
    !SHA256_PATTERN.test(row.context_digest) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0 ||
    !Number.isSafeInteger(row.prepared_at) ||
    row.prepared_at < 0
  ) {
    return invalid("turn_binding_metadata");
  }
  const binding = await restoreJson(row.binding_json, FlowBinding.restore);
  if (!binding.ok) return binding;
  if (
    binding.value.organisationId !== lookup.organisationId ||
    binding.value.sessionId !== lookup.sessionId ||
    binding.value.turnId !== lookup.turnId ||
    binding.value.authorityPartitionDigest !== row.authority_partition_digest ||
    binding.value.contextRevision !== row.revision ||
    binding.value.informationFlowContextDigest !== row.context_digest
  ) {
    return invalid("turn_binding_metadata");
  }
  const revision = sql
    .exec<SessionInformationFlowRevisionRow>(
      `SELECT organisation_id, session_id, revision, turn_id,
            authority_partition_digest, context_digest, context_json,
            committed_at
       FROM session_information_flow_revision
      WHERE organisation_id = ? AND session_id = ? AND revision = ?
      LIMIT 1`,
      lookup.organisationId,
      lookup.sessionId,
      row.revision,
    )
    .toArray()[0];
  if (
    revision === undefined ||
    revision.authority_partition_digest !== row.authority_partition_digest ||
    revision.context_digest !== row.context_digest
  ) {
    return invalid("turn_binding_revision");
  }
  const context = await restoreJson(
    revision.context_json,
    InformationFlowContext.restore,
  );
  if (!context.ok || !bindingMatchesContext(binding.value, context.value)) {
    return invalid("turn_binding_context");
  }
  return {
    ok: true,
    value: {
      turnId: row.turn_id,
      authorityPartitionDigest: row.authority_partition_digest,
      revision: row.revision,
      binding: binding.value,
    },
  };
}

export function appendSessionInformationFlowInTransaction(
  sql: SqlStorage,
  input: SessionInformationFlowCommit,
): Result<null, SessionInformationFlowError> {
  const valid = validateCommitInput(input);
  if (valid !== null) return invalid(valid);
  if (!bindingMatchesContext(input.binding, input.context))
    return invalid("binding");

  const latest =
    sql
      .exec<SessionInformationFlowRevisionRow>(
        `SELECT organisation_id, session_id, revision, turn_id,
            authority_partition_digest, context_digest, context_json,
            committed_at
       FROM session_information_flow_revision
      WHERE organisation_id = ? AND session_id = ?
      ORDER BY revision DESC
      LIMIT 1`,
        input.organisationId,
        input.sessionId,
      )
      .toArray()[0] ?? null;
  const observationMap = readObservationRows(
    sql,
    input.organisationId,
    input.sessionId,
  );
  if (!observationMap.ok) return observationMap;
  const observations = uniqueObservations(input.observations);
  if (!observations.ok) return observations;
  const bindingJson = JSON.stringify(input.binding.toJSON());
  const existingTurn =
    sql
      .exec<SessionInformationFlowTurnBindingRow>(
        `SELECT organisation_id, session_id, turn_id, authority_partition_digest,
            revision, context_digest, binding_json, prepared_at
       FROM session_information_flow_turn_binding
      WHERE organisation_id = ? AND session_id = ? AND turn_id = ?
      LIMIT 1`,
        input.organisationId,
        input.sessionId,
        input.turnId,
      )
      .toArray()[0] ?? null;
  if (existingTurn !== null) {
    if (
      existingTurn.authority_partition_digest !== input.authorityPartitionDigest
    ) {
      return {
        ok: false,
        error: { code: "session_information_flow_conflict" },
      };
    }
    if (
      existingTurn.revision === input.context.revision &&
      existingTurn.context_digest === input.context.digest &&
      existingTurn.binding_json === bindingJson
    ) {
      return latest === null ||
        latest.context_digest === existingTurn.context_digest
        ? { ok: true, value: null }
        : { ok: false, error: { code: "session_information_flow_stale" } };
    }
    if (
      latest === null ||
      latest.context_digest !== existingTurn.context_digest ||
      existingTurn.revision >= input.context.revision
    ) {
      return { ok: false, error: { code: "session_information_flow_stale" } };
    }
  }
  for (const observation of observations.value) {
    if (
      !input.context.observationDigests.includes(observation.evidenceDigest)
    ) {
      return {
        ok: false,
        error: {
          code: "session_information_flow_observation_missing",
          evidenceDigest: observation.evidenceDigest,
        },
      };
    }
  }

  const contextJson = JSON.stringify(input.context.toJSON());
  if (latest !== null) {
    if (latest.authority_partition_digest !== input.authorityPartitionDigest) {
      return {
        ok: false,
        error: { code: "session_information_flow_authority_mismatch" },
      };
    }
    if (latest.context_digest === input.context.digest) {
      if (latest.context_json !== contextJson) {
        return {
          ok: false,
          error: { code: "session_information_flow_conflict" },
        };
      }
    } else {
      if (input.context.revision <= latest.revision) {
        return { ok: false, error: { code: "session_information_flow_stale" } };
      }
      const previous = parseObservationDigests(latest.context_json);
      if (previous === null) return invalid("previous_context");
      const newEvidence = observationsNotInJournal(
        observations.value,
        observationMap.value,
      );
      const expected = [
        ...new Set([...previous, ...newEvidence.map(readEvidenceDigest)]),
      ].sort();
      if (
        expected.length !== input.context.observationDigests.length ||
        !sameDigests(expected, input.context.observationDigests) ||
        input.context.revision !== latest.revision + newEvidence.length
      ) {
        return { ok: false, error: { code: "session_information_flow_stale" } };
      }
    }
  } else if (
    input.context.revision !== observations.value.length ||
    input.context.observationDigests.length !== observations.value.length
  ) {
    return { ok: false, error: { code: "session_information_flow_conflict" } };
  }

  const written = writeObservationRows(
    sql,
    input,
    observations.value,
    observationMap.value,
  );
  if (!written.ok) return written;
  if (
    latest !== null &&
    latest.turn_id === input.turnId &&
    latest.context_digest !== input.context.digest
  ) {
    sql.exec(
      `UPDATE session_information_flow_revision
          SET revision = ?, context_digest = ?, context_json = ?, committed_at = ?
        WHERE organisation_id = ? AND session_id = ? AND turn_id = ?
          AND revision = ? AND authority_partition_digest = ?`,
      input.context.revision,
      input.context.digest,
      contextJson,
      input.committedAt,
      input.organisationId,
      input.sessionId,
      input.turnId,
      latest.revision,
      input.authorityPartitionDigest,
    );
  } else if (
    latest === null ||
    latest.context_digest !== input.context.digest
  ) {
    sql.exec(
      `INSERT INTO session_information_flow_revision (
         organisation_id, session_id, revision, turn_id, authority_partition_digest,
         context_digest, context_json, committed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.organisationId,
      input.sessionId,
      input.context.revision,
      input.turnId,
      input.authorityPartitionDigest,
      input.context.digest,
      contextJson,
      input.committedAt,
    );
  }
  if (existingTurn === null) {
    sql.exec(
      `INSERT INTO session_information_flow_turn_binding (
         organisation_id, session_id, turn_id, authority_partition_digest,
         revision, context_digest, binding_json, prepared_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.organisationId,
      input.sessionId,
      input.turnId,
      input.authorityPartitionDigest,
      input.context.revision,
      input.context.digest,
      bindingJson,
      input.committedAt,
    );
  } else {
    sql.exec(
      `UPDATE session_information_flow_turn_binding
          SET revision = ?, context_digest = ?, binding_json = ?, prepared_at = ?
        WHERE organisation_id = ? AND session_id = ? AND turn_id = ?
          AND authority_partition_digest = ?`,
      input.context.revision,
      input.context.digest,
      bindingJson,
      input.committedAt,
      input.organisationId,
      input.sessionId,
      input.turnId,
      input.authorityPartitionDigest,
    );
  }
  return { ok: true, value: null };
}

function validatePreparationInput(
  input: PrepareSessionInformationFlowInput,
): string | null {
  if (
    input.organisationId.length === 0 ||
    input.sessionId.length === 0 ||
    input.turnId.length === 0
  ) {
    return "identity";
  }
  if (!SHA256_PATTERN.test(input.authorityPartitionDigest))
    return "authorityPartitionDigest";
  if (
    input.contextBundle.organisationId !== input.organisationId ||
    input.contextBundle.sessionId !== input.sessionId
  ) {
    return "contextBundle.identity";
  }
  return Number.isSafeInteger(input.contextBundle.assembledAt) &&
    input.contextBundle.assembledAt >= 0
    ? null
    : "contextBundle.assembledAt";
}

function validateObservationAdmissionInput(
  input: AdmitSessionInformationFlowObservationInput,
): string | null {
  if (
    input.organisationId.length === 0 ||
    input.sessionId.length === 0 ||
    input.turnId.length === 0
  ) {
    return "identity";
  }
  if (!SHA256_PATTERN.test(input.authorityPartitionDigest))
    return "authorityPartitionDigest";
  return Number.isSafeInteger(input.observedAt) && input.observedAt >= 0
    ? null
    : "observedAt";
}

async function createInitialContext(
  input: PrepareSessionInformationFlowInput,
): Promise<Result<InformationFlowContext, SessionInformationFlowError>> {
  const created = await InformationFlowContext.create({
    organisationId: input.organisationId,
    sessionId: input.sessionId,
    authorityPartitionDigest: input.authorityPartitionDigest,
  });
  return created.ok ? created : invalid(created.error.code);
}

async function buildContextObservations(
  input: PrepareSessionInformationFlowInput,
): Promise<
  Result<readonly PreparedContextObservation[], SessionInformationFlowError>
> {
  const observations: PreparedContextObservation[] = [];
  for (const item of input.contextBundle.items) {
    const observation = observationForContextItem(item);
    if (!observation.ok) return observation;
    observations.push(observation.value);
  }
  observations.sort(comparePreparedObservations);
  return { ok: true, value: observations };
}

function observationForContextItem(
  item: ContextBundle["items"][number],
): Result<PreparedContextObservation, SessionInformationFlowError> {
  if (!contextEvidenceMatchesItem(item.observationEvidence, item)) {
    return invalid("contextBundle.item.observationEvidence");
  }
  return {
    ok: true,
    value: {
      label: item.inputLabel,
      evidence: item.observationEvidence,
    },
  };
}

async function advanceContextWithObservations(
  initial: InformationFlowContext,
  observations: readonly PreparedContextObservation[],
): Promise<Result<InformationFlowContext, SessionInformationFlowError>> {
  let context = initial;
  for (const observation of observations) {
    const advanced = await advanceInformationFlowContext({
      context,
      observation: observation.evidence,
      inputLabel: observation.label,
    });
    if (!advanced.ok) return invalid(`advance.${advanced.error.code}`);
    context = advanced.value.context;
  }
  return { ok: true, value: context };
}

function comparePreparedObservations(
  left: PreparedContextObservation,
  right: PreparedContextObservation,
): number {
  return left.evidence.evidenceDigest.localeCompare(
    right.evidence.evidenceDigest,
  );
}

function readObservation(
  observation: PreparedContextObservation,
): ObservationEvidence {
  return observation.evidence;
}

function readEvidenceDigest(observation: ObservationEvidence): string {
  return observation.evidenceDigest;
}

function contextEvidenceMatchesItem(
  evidence: ObservationEvidence,
  item: ContextBundle["items"][number],
): boolean {
  const sourceMatches = contextEvidenceSourceMatchesItem(evidence.source, item);
  return (
    sourceMatches &&
    item.sourceRevision === evidence.sourceRevision &&
    item.contentDigest === evidence.contentDigest &&
    item.observedAt === evidence.observedAt &&
    item.inputLabel.digest === evidence.flowLabelDigest
  );
}

function contextEvidenceSourceMatchesItem(
  evidence: ObservationEvidence["source"],
  item: ContextBundle["items"][number],
): boolean {
  if (item.source.kind === "project_observation")
    return JSON.stringify(evidence) === JSON.stringify(item.source.source);
  switch (evidence.kind) {
    case "case_context_collection_evidence":
    case "project":
    case "chat_conversation":
      return false;
    // An admitted Memory revision is an observation of the Organisation's
    // record of that Memory. The turn's binding then carries its label.
    case "organisation_record":
      return (
        item.source.kind === "memory" &&
        item.provenance.kind === "memory" &&
        evidence.recordId === memoryObservationRecordId(item.source.memoryId)
      );
    case "case_entry":
      return (
        item.source.kind === "case_entry" &&
        item.provenance.kind === "case_entry" &&
        item.source.caseId === evidence.caseId &&
        item.source.entryId === evidence.entryId
      );
    case "integration_resource":
      return (
        item.source.kind === "file_segment" &&
        item.provenance.kind === "integration_file" &&
        item.provenance.integrationAccountId ===
          evidence.integrationAccountId &&
        item.provenance.resourceScope === evidence.resourceScope &&
        item.observationEvidence.source.kind === "integration_resource" &&
        evidence.organisationId ===
          item.observationEvidence.source.organisationId
      );
  }
}

function bindingMatchesContext(
  binding: FlowBinding,
  context: InformationFlowContext,
): boolean {
  return (
    binding.organisationId === context.organisationId &&
    binding.sessionId === context.sessionId &&
    binding.authorityPartitionDigest === context.authorityPartitionDigest &&
    binding.flowLabel.digest === context.workLabel.digest &&
    binding.informationFlowContextDigest === context.digest &&
    binding.observationSetDigest === context.observationSetDigest &&
    binding.contextRevision === context.revision
  );
}

async function readPersistedObservations(
  sql: SqlStorage,
  lookup: SessionInformationFlowLookup,
): Promise<
  Result<readonly ObservationEvidence[], SessionInformationFlowError>
> {
  const rows = readObservationRows(
    sql,
    lookup.organisationId,
    lookup.sessionId,
  );
  if (!rows.ok) return { ok: false, error: rows.error };
  const observations: ObservationEvidence[] = [];
  for (const [evidenceDigest, evidenceJson] of rows.value.entries()) {
    let raw: unknown;
    try {
      raw = JSON.parse(evidenceJson);
    } catch {
      return invalid("observation_json");
    }
    const restored = await ObservationEvidence.restore(raw);
    if (!restored.ok || restored.value.evidenceDigest !== evidenceDigest) {
      return invalid("observation_digest");
    }
    observations.push(restored.value);
  }
  observations.sort(compareEvidence);
  return { ok: true, value: observations };
}

function compareEvidence(
  left: ObservationEvidence,
  right: ObservationEvidence,
): number {
  return left.evidenceDigest.localeCompare(right.evidenceDigest);
}

function observationSetMatchesContext(
  observations: readonly ObservationEvidence[],
  context: InformationFlowContext,
): boolean {
  const digests = observations.map(readEvidenceDigest).sort();
  return (
    digests.length === context.observationDigests.length &&
    sameDigests(digests, context.observationDigests)
  );
}

function observationsNotInJournal(
  observations: readonly ObservationEvidence[],
  journal: ReadonlyMap<string, string>,
): readonly ObservationEvidence[] {
  const fresh: ObservationEvidence[] = [];
  for (const observation of observations) {
    if (!journal.has(observation.evidenceDigest)) fresh.push(observation);
  }
  return fresh;
}

function sameDigests(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function readObservationRows(
  sql: SqlStorage,
  organisationId: string,
  sessionId: string,
): Result<ReadonlyMap<string, string>, SessionInformationFlowError> {
  const rows = sql
    .exec<SessionInformationFlowObservationRow>(
      `SELECT organisation_id, session_id, evidence_digest, evidence_json, recorded_at
       FROM session_information_flow_observation
      WHERE organisation_id = ? AND session_id = ?`,
      organisationId,
      sessionId,
    )
    .toArray();
  const observations = new Map<string, string>();
  for (const row of rows) {
    if (
      row.organisation_id !== organisationId ||
      row.session_id !== sessionId ||
      !SHA256_PATTERN.test(row.evidence_digest)
    )
      return invalidMap("observation_metadata");
    try {
      JSON.parse(row.evidence_json);
    } catch {
      return invalidMap("observation_json");
    }
    if (observations.has(row.evidence_digest))
      return invalidMap("observation_duplicate");
    observations.set(row.evidence_digest, row.evidence_json);
  }
  return { ok: true, value: observations };
}

function uniqueObservations(
  observations: readonly ObservationEvidence[],
): Result<readonly ObservationEvidence[], SessionInformationFlowError> {
  const byDigest = new Map<string, ObservationEvidence>();
  for (const observation of observations) {
    const existing = byDigest.get(observation.evidenceDigest);
    if (
      existing !== undefined &&
      existing.observedAt <= observation.observedAt
    ) {
      continue;
    }
    byDigest.set(observation.evidenceDigest, observation);
  }
  return { ok: true, value: [...byDigest.values()].sort(compareEvidence) };
}

function writeObservationRows(
  sql: SqlStorage,
  input: SessionInformationFlowCommit,
  observations: readonly ObservationEvidence[],
  existing: ReadonlyMap<string, string>,
): Result<null, SessionInformationFlowError> {
  for (const observation of observations) {
    const payload = JSON.stringify(observation.toJSON());
    const previous = existing.get(observation.evidenceDigest);
    if (previous !== undefined) {
      continue;
    }
    sql.exec(
      `INSERT INTO session_information_flow_observation (
         organisation_id, session_id, evidence_digest, evidence_json, recorded_at
       ) VALUES (?, ?, ?, ?, ?)`,
      input.organisationId,
      input.sessionId,
      observation.evidenceDigest,
      payload,
      input.committedAt,
    );
  }
  return { ok: true, value: null };
}

function parseObservationDigests(
  contextJson: string,
): readonly string[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(contextJson);
  } catch {
    return null;
  }
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.observationDigests) ||
    !raw.observationDigests.every(isDigest)
  )
    return null;
  return raw.observationDigests;
}

function validateCommitInput(
  input: SessionInformationFlowCommit,
): string | null {
  if (
    input.organisationId.length === 0 ||
    input.sessionId.length === 0 ||
    input.turnId.length === 0
  ) {
    return "identity";
  }
  if (
    input.context.organisationId !== input.organisationId ||
    input.context.sessionId !== input.sessionId
  ) {
    return "context.identity";
  }
  if (
    input.context.authorityPartitionDigest !== input.authorityPartitionDigest ||
    !SHA256_PATTERN.test(input.authorityPartitionDigest)
  )
    return "authorityPartitionDigest";
  if (
    input.binding.organisationId !== input.organisationId ||
    input.binding.sessionId !== input.sessionId ||
    input.binding.turnId !== input.turnId ||
    input.binding.authorityPartitionDigest !== input.authorityPartitionDigest ||
    !bindingMatchesContext(input.binding, input.context)
  )
    return "binding.identity";
  return Number.isSafeInteger(input.committedAt) && input.committedAt >= 0
    ? null
    : "committedAt";
}

function invalid(field: string): Result<never, SessionInformationFlowError> {
  return {
    ok: false,
    error: { code: "session_information_flow_invalid", field },
  };
}

function invalidMap(field: string): Result<never, SessionInformationFlowError> {
  return invalid(field);
}

async function restoreJson<T>(
  rawJson: string,
  restore: (raw: unknown) => Promise<Result<T, unknown>>,
): Promise<Result<T, SessionInformationFlowError>> {
  let raw: unknown;
  try {
    raw = JSON.parse(rawJson);
  } catch {
    return invalid("json");
  }
  const restored = await restore(raw);
  return restored.ok ? restored : invalid("restore");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export type CommerceObservationEntity = Readonly<{
  entityType: string;
  entityId: string;
  revision: number;
}>;

/**
 * Records which commerce records one admitted observation returned.
 *
 * Called only after the observation itself is committed, so an entity can
 * never be recorded as observed by a read that was refused.
 */
export function recordCommerceObservationEntities(
  input: Readonly<{
    sql: SqlStorage;
    organisationId: string;
    sessionId: string;
    evidenceDigest: string;
    entities: readonly CommerceObservationEntity[];
    observedAt: number;
  }>,
): void {
  for (const entity of input.entities) {
    if (
      entity.revision <= 0 ||
      entity.entityId.length === 0 ||
      entity.entityType.length === 0
    ) {
      continue;
    }
    input.sql.exec(
      `INSERT OR REPLACE INTO session_commerce_observation_entity (
         session_id, organisation_id, evidence_digest, entity_type, entity_id, revision, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.sessionId,
      input.organisationId,
      input.evidenceDigest,
      entity.entityType,
      entity.entityId,
      entity.revision,
      input.observedAt,
    );
  }
}

/**
 * Whether this session read the exact record and revision a proposal targets.
 *
 * A revision the session never saw fails even when it is the current one: the
 * agent must have observed the record it proposes to change.
 */
export function sessionObservedCommerceEntity(
  input: Readonly<{
    sql: SqlStorage;
    organisationId: string;
    sessionId: string;
    entityType: string;
    entityId: string;
    revision: number;
  }>,
): boolean {
  const rows = input.sql
    .exec<{ readonly observed: number }>(
      `SELECT COUNT(*) AS observed
       FROM session_commerce_observation_entity
      WHERE session_id = ? AND organisation_id = ? AND entity_type = ?
        AND entity_id = ? AND revision = ?`,
      input.sessionId,
      input.organisationId,
      input.entityType,
      input.entityId,
      input.revision,
    )
    .toArray();
  const observed = rows[0]?.observed ?? 0;
  return observed > 0;
}

/**
 * The canonical id of the record this session read under the id the read
 * showed. A graph read shows the agent Commerce's provider id, and the
 * session records the canonical id; the agent proposes with what it saw.
 * Null when the session read no such record at that revision, or more than one.
 */
export function sessionObservedCommerceEntityId(
  input: Readonly<{
    sql: SqlStorage;
    organisationId: string;
    sessionId: string;
    entityType: string;
    entityId: string;
    revision: number;
  }>,
): string | null {
  const rows = input.sql
    .exec<{ readonly entity_id: string }>(
      `SELECT DISTINCT entity_id
       FROM session_commerce_observation_entity
      WHERE session_id = ? AND organisation_id = ? AND entity_type = ?
        AND revision = ?
        AND (entity_id = ?
          OR (entity_id LIKE 'commerce:%'
            AND substr(entity_id, length(entity_id) - length(?)) = ':' || ?))`,
      input.sessionId,
      input.organisationId,
      input.entityType,
      input.revision,
      input.entityId,
      input.entityId,
      input.entityId,
    )
    .toArray();
  return rows.length === 1 ? rows[0]!.entity_id : null;
}
