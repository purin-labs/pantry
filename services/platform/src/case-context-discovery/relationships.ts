import type {
  CaseContextCollectionRelationshipDecision,
  CaseContextCollectionReviewCommand,
} from "@seams/control-api";
import type { OrganisationId } from "../ids";
import type { SchemaTransaction } from "../actors/schema-migrations";
import type { Result } from "../result";
import type { CaseContextCollectionRelationshipOutcome } from "./jev";
import { identifier, integerIn } from "./policy";
import { assertNever, isRecord, parseJsonOrNull } from "@seams/std";

export type CaseContextCollectionScope = Readonly<{
  organisationId: OrganisationId;
  merchantId: string;
  party: Readonly<{ kind: "customer" | "supplier"; id: string }>;
  issueKind: string;
  issueInstance: string;
}>;

/** Exact source-owned selection. There is deliberately no transcript or excerpt. */
export type CaseContextCollectionSelection = Readonly<{
  caseId: string;
  source: "gmail" | "whatsapp" | "commerce";
  integrationAccountId: string;
  reference: string;
  sourceRevision: number;
  verificationId: string;
  verificationRevision: number;
}>;

export type CaseContextCollectionRelationship = Readonly<{
  relationshipId: string;
  selection: CaseContextCollectionSelection;
  evaluationId: string;
  outcome: CaseContextCollectionRelationshipOutcome;
  confidence: number | null;
  expiresAt: number;
}> &
  (
    | Readonly<{
        kind: "suggested";
        acceptedAtRevision?: never;
        decidedBy?: never;
      }>
    | Readonly<{
        kind: "attached";
        acceptedAtRevision: number;
        decidedBy: string;
      }>
    | Readonly<{
        kind: "rejected" | "detached";
        acceptedAtRevision?: never;
        decidedBy: string;
      }>
  );

export type CaseContextCollection = Readonly<{
  caseContextCollectionId: string;
  scope: CaseContextCollectionScope;
  anchorSelection: CaseContextCollectionSelection;
  revision: number;
  lifecycle: "open" | "resolved";
  relationships: readonly CaseContextCollectionRelationship[];
}>;

export type CaseContextCollectionRelationshipError = Readonly<{
  code:
    | "case_context_collection_relationship_conflict"
    | "case_context_collection_relationship_invalid"
    | "case_context_collection_relationship_unavailable"
    | "case_context_collection_capacity_exceeded";
}>;

type CaseContextCollectionRow = Readonly<{
  case_context_collection_id: string;
  scope_json: string;
  revision: number;
  lifecycle: string;
}>;
type RelationshipRow = Readonly<{
  relationship_id: string;
  selection_json: string;
  evaluation_id: string;
  outcome: string;
  confidence: number | null;
  expires_at: number;
  state: string;
  accepted_at_revision: number | null;
  decided_by: string | null;
}>;
type CaseContextCollectionCaseRow = Readonly<{
  case_id: string;
  role: string;
  selection_json: string;
}>;

const MAX_CASE_CONTEXT_COLLECTIONS = 500;
const MAX_RELATIONSHIPS = 20;
const MAX_RELATIONSHIP_HISTORY = 200;
const MAX_CASE_CONTEXT_COLLECTIONS_PER_CASE = 20;

export function createCaseContextCollectionRelationshipSchema(
  sql: SqlStorage,
): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS case_context_collection_invalidation (
    organisation_id TEXT NOT NULL, case_context_collection_id TEXT NOT NULL, pending INTEGER NOT NULL CHECK (pending IN (0, 1)),
    PRIMARY KEY (organisation_id, case_context_collection_id)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS case_context_collection (
    organisation_id TEXT NOT NULL, case_context_collection_id TEXT NOT NULL, scope_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0), lifecycle TEXT NOT NULL CHECK (lifecycle IN ('open', 'resolved')),
    PRIMARY KEY (organisation_id, case_context_collection_id), UNIQUE (organisation_id, scope_json)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS case_context_collection_relationship (
    organisation_id TEXT NOT NULL, case_context_collection_id TEXT NOT NULL, relationship_id TEXT NOT NULL,
    selection_json TEXT NOT NULL, evaluation_id TEXT NOT NULL, outcome TEXT NOT NULL,
    confidence REAL, expires_at INTEGER NOT NULL, state TEXT NOT NULL,
    accepted_at_revision INTEGER, decided_by TEXT,
    PRIMARY KEY (organisation_id, relationship_id), UNIQUE (organisation_id, case_context_collection_id, selection_json),
    CHECK ((state = 'suggested' AND accepted_at_revision IS NULL AND decided_by IS NULL) OR
      (state = 'attached' AND accepted_at_revision IS NOT NULL AND decided_by IS NOT NULL) OR
      (state IN ('rejected', 'detached') AND accepted_at_revision IS NULL AND decided_by IS NOT NULL))
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS case_context_collection_command (
    organisation_id TEXT NOT NULL, command_id TEXT NOT NULL, request_digest TEXT NOT NULL,
    case_context_collection_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY (organisation_id, command_id)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS case_context_collection_case (
    organisation_id TEXT NOT NULL, case_context_collection_id TEXT NOT NULL, case_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('anchor', 'relationship')),
    selection_json TEXT NOT NULL,
    PRIMARY KEY (organisation_id, case_context_collection_id, case_id)
  )`);
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS case_context_collection_anchor
    ON case_context_collection_case (organisation_id, case_context_collection_id) WHERE role = 'anchor'`);
  sql.exec(`CREATE TABLE IF NOT EXISTS case_context_discovery_pending (
    organisation_id TEXT NOT NULL,
    evaluation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
    decisions_json TEXT NOT NULL CHECK (json_valid(decisions_json)),
    settled_at INTEGER NOT NULL CHECK (settled_at >= 0),
    PRIMARY KEY (organisation_id, evaluation_id)
  )`);
}

export function sameCaseContextCollectionScope(
  left: CaseContextCollectionScope,
  right: CaseContextCollectionScope,
): boolean {
  return scopeKey(left) === scopeKey(right);
}

export function readCaseContextCollection(
  sql: SqlStorage,
  organisationId: OrganisationId,
  caseContextCollectionId: string,
): CaseContextCollection | null {
  const row = sql
    .exec<CaseContextCollectionRow>(
      "SELECT case_context_collection_id, scope_json, revision, lifecycle FROM case_context_collection WHERE organisation_id = ? AND case_context_collection_id = ?",
      organisationId,
      caseContextCollectionId,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const scope = parseCaseContextCollectionScope(
    parseJsonOrNull(row.scope_json),
    organisationId,
  );
  if (
    scope === null ||
    !integerIn(row.revision, 1, Number.MAX_SAFE_INTEGER) ||
    (row.lifecycle !== "open" && row.lifecycle !== "resolved")
  )
    throw new Error("case_context_collection_relationship_corrupt");
  const rows = sql
    .exec<RelationshipRow>(
      "SELECT * FROM case_context_collection_relationship WHERE organisation_id = ? AND case_context_collection_id = ? ORDER BY relationship_id LIMIT ?",
      organisationId,
      caseContextCollectionId,
      MAX_RELATIONSHIP_HISTORY + 1,
    )
    .toArray();
  if (rows.length > MAX_RELATIONSHIP_HISTORY)
    throw new Error("case_context_collection_relationship_corrupt");
  const anchorRows = sql
    .exec<CaseContextCollectionCaseRow>(
      `SELECT case_id, role, selection_json FROM case_context_collection_case
       WHERE organisation_id = ? AND case_context_collection_id = ? AND role = 'anchor' LIMIT 2`,
      organisationId,
      caseContextCollectionId,
    )
    .toArray();
  const anchorSelection = parseCaseContextCollectionSelection(
    parseJsonOrNull(anchorRows[0]?.selection_json ?? ""),
  );
  if (
    anchorRows.length !== 1 ||
    anchorSelection === null ||
    anchorRows[0]?.case_id !== anchorSelection.caseId
  ) {
    throw new Error("case_context_collection_relationship_corrupt");
  }
  return {
    caseContextCollectionId: row.case_context_collection_id,
    scope,
    anchorSelection,
    revision: row.revision,
    lifecycle: row.lifecycle,
    relationships: rows.map(parseRelationship),
  };
}

export function listCaseContextCollectionIdsForCase(
  sql: SqlStorage,
  organisationId: OrganisationId,
  caseId: string,
  now: number,
): readonly string[] {
  const rows = sql
    .exec<{ case_context_collection_id: string }>(
      `SELECT DISTINCT mapping.case_context_collection_id
       FROM case_context_collection_case AS mapping
       LEFT JOIN case_context_collection_relationship AS relationship
         ON relationship.organisation_id = mapping.organisation_id
        AND relationship.case_context_collection_id = mapping.case_context_collection_id
        AND relationship.selection_json = mapping.selection_json
       WHERE mapping.organisation_id = ? AND mapping.case_id = ?
         AND (mapping.role = 'anchor' OR
           (mapping.role = 'relationship' AND
             (relationship.state = 'attached' OR
               (relationship.state = 'suggested' AND relationship.expires_at > ?))))
       ORDER BY mapping.case_context_collection_id LIMIT ?`,
      organisationId,
      caseId,
      now,
      MAX_CASE_CONTEXT_COLLECTIONS_PER_CASE + 1,
    )
    .toArray();
  if (rows.length > MAX_CASE_CONTEXT_COLLECTIONS_PER_CASE)
    throw new Error("case_context_collection_relationship_corrupt");
  return rows.map(caseContextCollectionIdFromRow);
}

export function listMemberCaseContextCollectionIdsForCase(
  sql: SqlStorage,
  organisationId: OrganisationId,
  caseId: string,
): readonly string[] {
  const rows = sql
    .exec<{ case_context_collection_id: string }>(
      `SELECT DISTINCT mapping.case_context_collection_id
       FROM case_context_collection_case AS mapping
       LEFT JOIN case_context_collection_relationship AS relationship
         ON relationship.organisation_id = mapping.organisation_id
        AND relationship.case_context_collection_id = mapping.case_context_collection_id
        AND relationship.selection_json = mapping.selection_json
       WHERE mapping.organisation_id = ? AND mapping.case_id = ?
         AND (mapping.role = 'anchor' OR
           (mapping.role = 'relationship' AND
             relationship.state = 'attached' AND
             relationship.outcome = 'same_issue'))
       ORDER BY mapping.case_context_collection_id LIMIT ?`,
      organisationId,
      caseId,
      MAX_CASE_CONTEXT_COLLECTIONS_PER_CASE + 1,
    )
    .toArray();
  if (rows.length > MAX_CASE_CONTEXT_COLLECTIONS_PER_CASE) {
    throw new Error("case_context_collection_relationship_corrupt");
  }
  return rows.map(caseContextCollectionIdFromRow);
}

export function recordCaseContextCollectionSuggestion(
  input: Readonly<{
    sql: SqlStorage;
    transaction: SchemaTransaction;
    organisationId: OrganisationId;
    commandId: string;
    requestDigest: string;
    caseContextCollectionId: string;
    relationshipId: string;
    expectedRevision: number;
    scope: CaseContextCollectionScope;
    sourceScope: CaseContextCollectionScope;
    anchorSelection: CaseContextCollectionSelection;
    selection: CaseContextCollectionSelection;
    evaluationId: string;
    outcome: CaseContextCollectionRelationshipOutcome;
    confidence: number | null;
    expiresAt: number;
    now: number;
  }>,
): Result<
  { caseContextCollectionId: string; revision: number },
  CaseContextCollectionRelationshipError
> {
  return input.transaction(recordSuggestion.bind(null, input));
}

function recordSuggestion(
  input: Parameters<typeof recordCaseContextCollectionSuggestion>[0],
): ReturnType<typeof recordCaseContextCollectionSuggestion> {
  if (
    !identifier(input.commandId) ||
    !identifier(input.caseContextCollectionId) ||
    !identifier(input.relationshipId) ||
    !identifier(input.evaluationId) ||
    !/^[a-f0-9]{64}$/.test(input.requestDigest) ||
    !integerIn(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1) ||
    !integerIn(input.now, 0, Number.MAX_SAFE_INTEGER) ||
    !integerIn(input.expiresAt, 1, Number.MAX_SAFE_INTEGER) ||
    (input.confidence !== null &&
      (!Number.isFinite(input.confidence) ||
        input.confidence < 0 ||
        input.confidence > 1)) ||
    parseCaseContextCollectionScope(input.scope, input.organisationId) ===
      null ||
    parseCaseContextCollectionScope(input.sourceScope, input.organisationId) ===
      null ||
    parseCaseContextCollectionSelection(input.anchorSelection) === null ||
    parseCaseContextCollectionSelection(input.selection) === null ||
    input.scope.organisationId !== input.organisationId ||
    !sameCaseContextCollectionScope(input.scope, input.sourceScope) ||
    input.anchorSelection.caseId === input.selection.caseId ||
    input.expiresAt <= input.now ||
    input.expiresAt > input.now + 86_400_000 ||
    (input.outcome !== "same_issue" && input.outcome !== "related_reference")
  )
    return failure("case_context_collection_relationship_invalid");
  const replay = replayCommand(input);
  if (replay !== null) return replay;
  let caseContextCollectionId = input.caseContextCollectionId;
  const existing = input.sql
    .exec<{ case_context_collection_id: string }>(
      "SELECT case_context_collection_id FROM case_context_collection WHERE organisation_id = ? AND scope_json = ?",
      input.organisationId,
      scopeKey(input.scope),
    )
    .toArray()[0];
  if (existing !== undefined)
    caseContextCollectionId = existing.case_context_collection_id;
  const caseContextCollection = readCaseContextCollection(
    input.sql,
    input.organisationId,
    caseContextCollectionId,
  );
  if (
    (caseContextCollection?.revision ?? 0) !== input.expectedRevision ||
    caseContextCollection?.lifecycle === "resolved"
  )
    return failure("case_context_collection_relationship_conflict");
  if (
    caseContextCollection !== null &&
    !sameCaseContextCollectionScope(
      caseContextCollection.scope,
      input.sourceScope,
    )
  )
    return failure("case_context_collection_relationship_invalid");
  if (
    caseContextCollection !== null &&
    selectionKey(caseContextCollection.anchorSelection) !==
      selectionKey(input.anchorSelection)
  ) {
    return failure("case_context_collection_relationship_conflict");
  }
  const anchorCaseContextCollections = listCaseContextCollectionIdsForCase(
    input.sql,
    input.organisationId,
    input.anchorSelection.caseId,
    input.now,
  );
  if (
    caseContextCollection === null &&
    anchorCaseContextCollections.length >= MAX_CASE_CONTEXT_COLLECTIONS_PER_CASE
  ) {
    return failure("case_context_collection_capacity_exceeded");
  }
  const caseContextCollections = listCaseContextCollectionIdsForCase(
    input.sql,
    input.organisationId,
    input.selection.caseId,
    input.now,
  );
  if (
    !caseContextCollections.includes(caseContextCollectionId) &&
    caseContextCollections.length >= MAX_CASE_CONTEXT_COLLECTIONS_PER_CASE
  ) {
    return failure("case_context_collection_capacity_exceeded");
  }
  const duplicate = input.sql
    .exec(
      `SELECT relationship_id FROM case_context_collection_relationship
     WHERE organisation_id = ? AND (relationship_id = ? OR (case_context_collection_id = ? AND selection_json = ?)) LIMIT 1`,
      input.organisationId,
      input.relationshipId,
      caseContextCollectionId,
      selectionKey(input.selection),
    )
    .toArray()[0];
  if (duplicate !== undefined)
    return failure("case_context_collection_relationship_conflict");
  if (
    activeRelationshipCount(caseContextCollection, input.now) >=
    MAX_RELATIONSHIPS
  )
    return failure("case_context_collection_capacity_exceeded");
  if (
    (caseContextCollection?.relationships.length ?? 0) >=
    MAX_RELATIONSHIP_HISTORY
  )
    return failure("case_context_collection_capacity_exceeded");
  if (caseContextCollection === null) {
    const count =
      input.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM case_context_collection WHERE organisation_id = ?",
          input.organisationId,
        )
        .toArray()[0]?.count ?? 0;
    if (count >= MAX_CASE_CONTEXT_COLLECTIONS)
      return failure("case_context_collection_capacity_exceeded");
  }
  const revision = input.expectedRevision + 1;
  if (caseContextCollection === null)
    input.sql.exec(
      "INSERT INTO case_context_collection (organisation_id, case_context_collection_id, scope_json, revision, lifecycle) VALUES (?, ?, ?, ?, 'open')",
      input.organisationId,
      caseContextCollectionId,
      scopeKey(input.scope),
      revision,
    );
  else
    input.sql.exec(
      "UPDATE case_context_collection SET revision = ? WHERE organisation_id = ? AND case_context_collection_id = ?",
      revision,
      input.organisationId,
      caseContextCollectionId,
    );
  if (caseContextCollection === null) {
    input.sql.exec(
      `INSERT INTO case_context_collection_case
       (organisation_id, case_context_collection_id, case_id, role, selection_json)
       VALUES (?, ?, ?, 'anchor', ?)`,
      input.organisationId,
      caseContextCollectionId,
      input.anchorSelection.caseId,
      selectionKey(input.anchorSelection),
    );
  }
  input.sql.exec(
    `INSERT INTO case_context_collection_relationship
    (organisation_id, case_context_collection_id, relationship_id, selection_json, evaluation_id, outcome, confidence, expires_at, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'suggested')`,
    input.organisationId,
    caseContextCollectionId,
    input.relationshipId,
    selectionKey(input.selection),
    input.evaluationId,
    input.outcome,
    input.confidence,
    input.expiresAt,
  );
  input.sql.exec(
    `INSERT INTO case_context_collection_case
     (organisation_id, case_context_collection_id, case_id, role, selection_json)
     VALUES (?, ?, ?, 'relationship', ?)`,
    input.organisationId,
    caseContextCollectionId,
    input.selection.caseId,
    selectionKey(input.selection),
  );
  saveCommand(input, caseContextCollectionId, revision);
  queueCaseContextCollectionInvalidation(
    input.sql,
    input.organisationId,
    caseContextCollectionId,
  );
  return { ok: true, value: { caseContextCollectionId, revision } };
}

export function decideCaseContextCollectionRelationship(
  input: Readonly<{
    sql: SqlStorage;
    transaction: SchemaTransaction;
    organisationId: OrganisationId;
    commandId: string;
    requestDigest: string;
    caseContextCollectionId: string;
    expectedRevision: number;
    actorId: string;
    now: number;
    decision:
      | Readonly<{
          kind: "resolve";
          relationshipId?: never;
          sourceScope?: never;
        }>
      | Readonly<{
          kind: "confirm";
          relationshipId: string;
          sourceScope: CaseContextCollectionScope;
        }>
      | Readonly<{
          kind: "reject" | "detach";
          relationshipId: string;
          sourceScope?: never;
        }>;
  }>,
): Result<
  { caseContextCollectionId: string; revision: number },
  CaseContextCollectionRelationshipError
> {
  return input.transaction(decideRelationship.bind(null, input));
}

export function replayCaseContextCollectionRelationshipCommand(
  input: Readonly<{
    sql: SqlStorage;
    organisationId: OrganisationId;
    commandId: string;
    requestDigest: string;
  }>,
): Result<
  { caseContextCollectionId: string; revision: number } | null,
  CaseContextCollectionRelationshipError
> {
  if (
    !identifier(input.commandId) ||
    !/^[a-f0-9]{64}$/.test(input.requestDigest)
  ) {
    return failure("case_context_collection_relationship_invalid");
  }
  const replayed = replayCommand(input);
  return replayed === null ? { ok: true, value: null } : replayed;
}

function decideRelationship(
  input: Parameters<typeof decideCaseContextCollectionRelationship>[0],
): ReturnType<typeof decideCaseContextCollectionRelationship> {
  if (!validDecisionInput(input))
    return failure("case_context_collection_relationship_invalid");
  const replay = replayCommand(input);
  if (replay !== null) return replay;
  const caseContextCollection = readCaseContextCollection(
    input.sql,
    input.organisationId,
    input.caseContextCollectionId,
  );
  if (caseContextCollection === null)
    return failure("case_context_collection_relationship_unavailable");
  if (caseContextCollection.revision !== input.expectedRevision)
    return failure("case_context_collection_relationship_conflict");
  const revision = caseContextCollection.revision + 1;
  const decision = input.decision;
  if (decision.kind === "resolve") {
    if (caseContextCollection.lifecycle !== "open")
      return failure("case_context_collection_relationship_conflict");
    input.sql.exec(
      "UPDATE case_context_collection SET lifecycle = 'resolved' WHERE organisation_id = ? AND case_context_collection_id = ?",
      input.organisationId,
      input.caseContextCollectionId,
    );
  } else {
    const relationship = caseContextCollection.relationships.find(
      matchesRelationship.bind(null, decision.relationshipId),
    );
    if (relationship === undefined)
      return failure("case_context_collection_relationship_unavailable");
    if (
      decision.kind === "confirm" &&
      (caseContextCollection.lifecycle !== "open" ||
        relationship.kind !== "suggested" ||
        relationship.expiresAt <= input.now ||
        relationship.outcome !== "same_issue" ||
        !sameCaseContextCollectionScope(
          caseContextCollection.scope,
          decision.sourceScope,
        ))
    ) {
      return failure("case_context_collection_relationship_invalid");
    }
    if (
      (decision.kind === "reject" && relationship.kind !== "suggested") ||
      (decision.kind === "detach" && relationship.kind !== "attached")
    )
      return failure("case_context_collection_relationship_conflict");
    const state = stateForDecision(decision.kind);
    input.sql.exec(
      `UPDATE case_context_collection_relationship SET state = ?, decided_by = ?, accepted_at_revision = ?
      WHERE organisation_id = ? AND case_context_collection_id = ? AND relationship_id = ?`,
      state,
      input.actorId,
      state === "attached" ? revision : null,
      input.organisationId,
      input.caseContextCollectionId,
      decision.relationshipId,
    );
  }
  input.sql.exec(
    "UPDATE case_context_collection SET revision = ? WHERE organisation_id = ? AND case_context_collection_id = ?",
    revision,
    input.organisationId,
    input.caseContextCollectionId,
  );
  saveCommand(input, input.caseContextCollectionId, revision);
  queueCaseContextCollectionInvalidation(
    input.sql,
    input.organisationId,
    input.caseContextCollectionId,
  );
  return {
    ok: true,
    value: { caseContextCollectionId: input.caseContextCollectionId, revision },
  };
}

export function queueCaseContextCollectionInvalidation(
  sql: SqlStorage,
  organisationId: OrganisationId,
  caseContextCollectionId: string,
): void {
  sql.exec(
    "INSERT INTO case_context_collection_invalidation VALUES (?, ?, 1) ON CONFLICT (organisation_id, case_context_collection_id) DO UPDATE SET pending = 1",
    organisationId,
    caseContextCollectionId,
  );
}

export function queueAllCaseContextCollectionInvalidations(
  sql: SqlStorage,
  organisationId: OrganisationId,
): void {
  if (
    sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'case_context_collection'",
      )
      .toArray().length === 0
  )
    return;
  sql.exec(
    "INSERT INTO case_context_collection_invalidation SELECT organisation_id, case_context_collection_id, 1 FROM case_context_collection WHERE organisation_id = ? ON CONFLICT (organisation_id, case_context_collection_id) DO UPDATE SET pending = 1",
    organisationId,
  );
}

function validDecisionInput(
  input: Parameters<typeof decideCaseContextCollectionRelationship>[0],
): boolean {
  if (
    !identifier(input.commandId) ||
    !identifier(input.caseContextCollectionId) ||
    !identifier(input.actorId) ||
    !/^[a-f0-9]{64}$/.test(input.requestDigest) ||
    !integerIn(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1) ||
    !integerIn(input.now, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return false;
  }
  switch (input.decision.kind) {
    case "resolve":
      return true;
    case "reject":
    case "detach":
      return identifier(input.decision.relationshipId);
    case "confirm":
      return (
        identifier(input.decision.relationshipId) &&
        parseCaseContextCollectionScope(
          input.decision.sourceScope,
          input.organisationId,
        ) !== null
      );
    default:
      return assertNever(input.decision);
  }
}

function stateForDecision(
  kind: CaseContextCollectionRelationshipDecision["kind"],
): "attached" | "rejected" | "detached" {
  switch (kind) {
    case "confirm":
      return "attached";
    case "reject":
      return "rejected";
    case "detach":
      return "detached";
    default:
      return assertNever(kind);
  }
}

type CommandInput = Readonly<{
  sql: SqlStorage;
  organisationId: OrganisationId;
  commandId: string;
  requestDigest: string;
}>;

function replayCommand(
  input: CommandInput,
): Result<
  { caseContextCollectionId: string; revision: number },
  CaseContextCollectionRelationshipError
> | null {
  const row = input.sql
    .exec<{
      case_context_collection_id: string;
      revision: number;
      request_digest: string;
    }>(
      "SELECT case_context_collection_id, revision, request_digest FROM case_context_collection_command WHERE organisation_id = ? AND command_id = ?",
      input.organisationId,
      input.commandId,
    )
    .toArray()[0];
  if (row === undefined) return null;
  return row.request_digest === input.requestDigest
    ? {
        ok: true,
        value: {
          caseContextCollectionId: row.case_context_collection_id,
          revision: row.revision,
        },
      }
    : failure("case_context_collection_relationship_conflict");
}

function saveCommand(
  input: CommandInput,
  caseContextCollectionId: string,
  revision: number,
): void {
  input.sql.exec(
    "INSERT INTO case_context_collection_command VALUES (?, ?, ?, ?, ?)",
    input.organisationId,
    input.commandId,
    input.requestDigest,
    caseContextCollectionId,
    revision,
  );
}

export function parseCaseContextCollectionSelection(
  raw: unknown,
): CaseContextCollectionSelection | null {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 7 ||
    !identifier(raw.caseId) ||
    (raw.source !== "gmail" &&
      raw.source !== "whatsapp" &&
      raw.source !== "commerce") ||
    !identifier(raw.integrationAccountId) ||
    !identifier(raw.reference) ||
    !identifier(raw.verificationId) ||
    !integerIn(raw.sourceRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !integerIn(raw.verificationRevision, 1, Number.MAX_SAFE_INTEGER)
  )
    return null;
  return {
    caseId: raw.caseId,
    source: raw.source,
    integrationAccountId: raw.integrationAccountId,
    reference: raw.reference,
    sourceRevision: raw.sourceRevision,
    verificationId: raw.verificationId,
    verificationRevision: raw.verificationRevision,
  };
}

export function parseCaseContextCollectionReviewCommand(
  raw: unknown,
): CaseContextCollectionReviewCommand | null {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 3 ||
    !identifier(raw.commandId) ||
    !integerIn(raw.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1) ||
    !isRecord(raw.decision)
  ) {
    return null;
  }
  if (
    raw.decision.kind === "resolve" &&
    Object.keys(raw.decision).length === 1
  ) {
    return {
      commandId: raw.commandId,
      expectedRevision: raw.expectedRevision,
      decision: { kind: "resolve" },
    };
  }
  if (
    (raw.decision.kind === "confirm" ||
      raw.decision.kind === "reject" ||
      raw.decision.kind === "detach") &&
    Object.keys(raw.decision).length === 2 &&
    identifier(raw.decision.relationshipId)
  ) {
    return {
      commandId: raw.commandId,
      expectedRevision: raw.expectedRevision,
      decision: {
        kind: raw.decision.kind,
        relationshipId: raw.decision.relationshipId,
      },
    };
  }
  return null;
}

function parseCaseContextCollectionScope(
  raw: unknown,
  organisationId: OrganisationId,
): CaseContextCollectionScope | null {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 5 ||
    raw.organisationId !== organisationId ||
    !identifier(raw.merchantId) ||
    !isRecord(raw.party) ||
    Object.keys(raw.party).length !== 2 ||
    (raw.party.kind !== "customer" && raw.party.kind !== "supplier") ||
    !identifier(raw.party.id) ||
    !identifier(raw.issueKind) ||
    !identifier(raw.issueInstance)
  )
    return null;
  return {
    organisationId,
    merchantId: raw.merchantId,
    party: { kind: raw.party.kind, id: raw.party.id },
    issueKind: raw.issueKind,
    issueInstance: raw.issueInstance,
  };
}

function parseRelationship(
  row: RelationshipRow,
): CaseContextCollectionRelationship {
  const selection = parseCaseContextCollectionSelection(
    parseJsonOrNull(row.selection_json),
  );
  if (
    selection === null ||
    (row.outcome !== "same_issue" &&
      row.outcome !== "related_reference" &&
      row.outcome !== "different_issue" &&
      row.outcome !== "uncertain")
  )
    throw new Error("case_context_collection_relationship_corrupt");
  if (
    !identifier(row.relationship_id) ||
    !identifier(row.evaluation_id) ||
    !integerIn(row.expires_at, 1, Number.MAX_SAFE_INTEGER) ||
    (row.confidence !== null &&
      (!Number.isFinite(row.confidence) ||
        row.confidence < 0 ||
        row.confidence > 1))
  )
    throw new Error("case_context_collection_relationship_corrupt");
  switch (row.state) {
    case "suggested":
      if (row.accepted_at_revision !== null || row.decided_by !== null) break;
      return {
        kind: "suggested",
        relationshipId: row.relationship_id,
        selection,
        evaluationId: row.evaluation_id,
        outcome: row.outcome,
        confidence: row.confidence,
        expiresAt: row.expires_at,
      };
    case "attached":
      if (
        !integerIn(row.accepted_at_revision, 1, Number.MAX_SAFE_INTEGER) ||
        !identifier(row.decided_by)
      )
        break;
      return {
        kind: "attached",
        relationshipId: row.relationship_id,
        selection,
        evaluationId: row.evaluation_id,
        outcome: row.outcome,
        confidence: row.confidence,
        expiresAt: row.expires_at,
        acceptedAtRevision: row.accepted_at_revision,
        decidedBy: row.decided_by,
      };
    case "rejected":
    case "detached":
      if (row.accepted_at_revision !== null || !identifier(row.decided_by))
        break;
      return {
        kind: row.state,
        relationshipId: row.relationship_id,
        selection,
        evaluationId: row.evaluation_id,
        outcome: row.outcome,
        confidence: row.confidence,
        expiresAt: row.expires_at,
        decidedBy: row.decided_by,
      };
  }
  throw new Error("case_context_collection_relationship_corrupt");
}

function activeRelationshipCount(
  caseContextCollection: CaseContextCollection | null,
  now: number,
): number {
  if (caseContextCollection === null) return 0;
  let count = 0;
  for (const relationship of caseContextCollection.relationships) {
    if (
      relationship.kind === "attached" ||
      (relationship.kind === "suggested" && relationship.expiresAt > now)
    ) {
      count += 1;
    }
  }
  return count;
}

function scopeKey(scope: CaseContextCollectionScope): string {
  return JSON.stringify({
    organisationId: scope.organisationId,
    merchantId: scope.merchantId,
    party: { kind: scope.party.kind, id: scope.party.id },
    issueKind: scope.issueKind,
    issueInstance: scope.issueInstance,
  });
}
function selectionKey(selection: CaseContextCollectionSelection): string {
  return JSON.stringify({
    caseId: selection.caseId,
    source: selection.source,
    integrationAccountId: selection.integrationAccountId,
    reference: selection.reference,
    sourceRevision: selection.sourceRevision,
    verificationId: selection.verificationId,
    verificationRevision: selection.verificationRevision,
  });
}
function caseContextCollectionIdFromRow(row: {
  case_context_collection_id: string;
}): string {
  return row.case_context_collection_id;
}
function matchesRelationship(
  id: string,
  relationship: CaseContextCollectionRelationship,
): boolean {
  return relationship.relationshipId === id;
}
function failure(
  code: CaseContextCollectionRelationshipError["code"],
): Result<never, CaseContextCollectionRelationshipError> {
  return { ok: false, error: { code } };
}
