import type { TypeSafeEvaluationReceipt } from "../integrations/typesafe/evaluation-ledger";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { isOrganisationExecutionActive } from "../actors/actor-execution-quiescence";
import type { TypeSafeCredential } from "../integrations/typesafe/credential";
import { digestCanonical } from "../policy/information-flow/digest";
import type { Result } from "@purin-labs/kernel/result";
import type { SchemaTransaction } from "../actors/schema-migrations";
import {
  JevRelationshipRequest,
  CASE_CONTEXT_DISCOVERY_JEV_MODEL,
  type JevRelationshipDecision,
} from "./jev";
import type { FlowLabel } from "../policy/information-flow/labels";
import type { RequestAuthority } from "@purin-labs/contracts";
import {
  readCaseContextDiscoveryPolicy,
  fetchCaseContextDiscoveryEvaluation,
  releaseUnissuedCaseContextDiscoveryEvaluation,
  type CaseContextDiscoveryEvaluationDispatch,
  replayCaseContextDiscoveryEvaluation,
  reserveCaseContextDiscoveryEvaluation,
  settleCaseContextDiscoveryEvaluation,
  type CaseContextCollectionStoreError,
} from "./evaluation-store";
import { caseContextDiscoveryReadiness } from "./policy";
import {
  listMemberCaseContextCollectionIdsForCase,
  readCaseContextCollection,
  recordCaseContextCollectionSuggestion,
  type CaseContextCollection,
  type CaseContextCollectionRelationshipError,
  type CaseContextCollectionScope,
  type CaseContextCollectionSelection,
} from "./relationships";
import { isRecord } from "@purin-labs/std";

export type OperationalCaseContextDiscoveryEvidence = Readonly<{
  selection: CaseContextCollectionSelection;
  evidence: string;
}>;

export type OperationalCaseContextDiscoveryRequest = Readonly<{
  scope: CaseContextCollectionScope;
  anchor: OperationalCaseContextDiscoveryEvidence;
  candidates: readonly OperationalCaseContextDiscoveryEvidence[];
}>;

export type OperationalCaseContextDiscoverySourceRequest = Readonly<{
  issueKind: string;
  issueInstance: string;
  anchor: OperationalCaseContextDiscoveryEvidence;
  candidates: readonly OperationalCaseContextDiscoveryEvidence[];
}>;

type OperationalCaseContextDiscoveryResult = Readonly<{
  receipt: TypeSafeEvaluationReceipt;
  decisions: readonly JevRelationshipDecision[];
  recorded: readonly Readonly<{
    caseContextCollectionId: string;
    relationshipId: string;
    revision: number;
  }>[];
}>;

type OperationalCaseContextDiscoveryError =
  | CaseContextCollectionStoreError
  | CaseContextCollectionRelationshipError
  | Readonly<{
      code:
        | "case_context_discovery_evaluation_invalid"
        | "organisation_placement_conflict";
    }>;

type PreparedRelationship = Readonly<{
  selection: CaseContextCollectionSelection;
  relationshipId: string;
  commandId: string;
  requestDigest: string;
  decision: JevRelationshipDecision;
  reverse: Readonly<{
    selection: CaseContextCollectionSelection;
    relationshipId: string;
    commandId: string;
    requestDigest: string;
  }>;
}>;

const DISCOVERY_INPUT_BYTES = 24_576;
const RELATIONSHIP_TTL_MS = 24 * 60 * 60 * 1_000;

export async function evaluateOperationalCaseContextDiscovery(
  input: Readonly<{
    sql: SqlStorage;
    transaction: SchemaTransaction;
    credential: TypeSafeCredential | null;
    scope: OrganisationExecutionScope;
    request: OperationalCaseContextDiscoveryRequest;
    sourceAccess: Readonly<{ authority: RequestAuthority; label: FlowLabel }>;
    signal: AbortSignal;
    fetcher: typeof fetch;
    now: () => number;
  }>,
): Promise<
  Result<
    OperationalCaseContextDiscoveryResult,
    OperationalCaseContextDiscoveryError
  >
> {
  const organisationId = input.scope.organisationId;
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return placementConflict();
  if (
    !validRequest(input.request, organisationId) ||
    input.request.anchor.selection.source !== "gmail" ||
    input.sourceAccess.authority.kind !== "agent_mailbox" ||
    input.sourceAccess.authority.organisationId !== organisationId ||
    input.sourceAccess.authority.integrationAccountId !==
      input.request.anchor.selection.integrationAccountId
  )
    return invalidEvaluation();
  const head = readCaseContextDiscoveryPolicy(input.sql, organisationId);
  const readiness = caseContextDiscoveryReadiness({
    policy: head.policy,
    credential: input.credential,
    source: input.request.anchor.selection.source,
    integrationAccountId: input.request.anchor.selection.integrationAccountId,
  });
  const requestDigest = await digestCanonical({
    policyRevision: head.revision,
    sourceLabelDigest: input.sourceAccess.label.digest,
    evidence: input.request,
    scope: input.request.scope,
    anchor: input.request.anchor.selection,
    candidates: input.request.candidates.map(selectionFromEvidence),
  });
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return placementConflict();
  const evaluationId = `discovery_${requestDigest.slice(0, 48)}`;
  const replayed = replayCaseContextDiscoveryEvaluation(
    input.sql,
    input.transaction,
    {
      organisationId,
      evaluationId,
      requestDigest,
      now: input.now(),
    },
  );
  if (!replayed.ok) return replayed;
  if (replayed.value !== null) {
    const pending = readPendingOperationalDiscovery(
      input.sql,
      organisationId,
      evaluationId,
      requestDigest,
      input.request.candidates.length,
    );
    if (pending !== null) {
      if (
        replayed.value.kind !== "evaluated" ||
        head.revision !== pending.policyRevision ||
        (head.policy.mode !== "metadata_only" &&
          head.policy.mode !== "party_context")
      ) {
        input.transaction(
          deletePendingOperationalDiscovery.bind(
            null,
            input.sql,
            organisationId,
            evaluationId,
          ),
        );
      } else {
        if (readiness.kind === "inactive")
          return {
            ok: false,
            error: { code: "case_context_collection_inactive" },
          };
        const prepared = await prepareRelationships(
          input.request,
          evaluationId,
          pending.decisions,
        );
        if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
          return placementConflict();
        return recoverPendingOperationalDiscovery({
          sql: input.sql,
          transaction: input.transaction,
          organisationId,
          request: input.request,
          evaluationId,
          requestDigest,
          receipt: replayed.value,
          decisions: pending.decisions,
          prepared,
          settledAt: pending.settledAt,
        });
      }
    }
    return {
      ok: true,
      value: { receipt: replayed.value, decisions: [], recorded: [] },
    };
  }
  if (readiness.kind === "inactive" || input.credential === null) {
    return { ok: false, error: { code: "case_context_collection_inactive" } };
  }
  const preparedRequest = await JevRelationshipRequest.prepare({
    comparison: {
      evidence: input.request.anchor.evidence,
      candidates: input.request.candidates.map(candidateForJev),
    },
    sink: {
      kind: "typesafe_system_one",
      organisationId,
      purpose: "case_context_discovery_relationship",
      funding: input.credential.authority,
      model: CASE_CONTEXT_DISCOVERY_JEV_MODEL,
      processing: {
        kind: "authorized_source",
        authority: input.sourceAccess.authority,
      },
    },
    labels: [input.sourceAccess.label],
  });
  if (!preparedRequest.ok)
    return { ok: false, error: { code: "case_context_collection_inactive" } };
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return placementConflict();
  const reserved = reserveCaseContextDiscoveryEvaluation(
    input.sql,
    input.transaction,
    {
      organisationId,
      evaluationId,
      requestDigest,
      policyRevision: head.revision,
      disclosureDecisionDigest: preparedRequest.value.disclosure.decisionDigest,
      inputBytes: DISCOVERY_INPUT_BYTES,
      now: input.now(),
    },
  );
  if (!reserved.ok) return reserved;
  if (reserved.value.kind === "replayed") {
    return {
      ok: true,
      value: {
        receipt: reserved.value.receipt,
        decisions: [],
        recorded: [],
      },
    };
  }
  const dispatch: { state: CaseContextDiscoveryEvaluationDispatch } = {
    state: { kind: "unissued" },
  };
  const evaluated = await preparedRequest.value.evaluate({
    credential: input.credential,
    timeoutMs: readiness.policy.limits.requestTimeoutMs,
    signal: input.signal,
    fetcher: fetchCaseContextDiscoveryEvaluation.bind(null, input, dispatch),
  });
  const prepared: PreparedRelationship[] = [];
  const settlement = {
    sql: input.sql,
    transaction: input.transaction,
    organisationId,
    request: input.request,
    policyMode: readiness.policy.mode,
    evaluationId,
    requestDigest,
    evaluated,
    prepared,
    settledAt: input.now(),
  };
  try {
    const active = await isOrganisationExecutionActive(input.sql, input.scope);
    if (!active && dispatch.state.kind === "unissued") {
      input.transaction(
        releaseUnissuedCaseContextDiscoveryEvaluation.bind(null, {
          sql: input.sql,
          scope: input.scope,
          evaluationId,
          requestDigest,
          dispatch: dispatch.state,
        }),
      );
      return placementConflict();
    }
    if (active && evaluated.ok)
      prepared.push(
        ...(await prepareRelationships(
          input.request,
          evaluationId,
          evaluated.value.decisions,
        )),
      );
    if (!(await isOrganisationExecutionActive(input.sql, input.scope))) {
      const recovered = recoverOperationalEvaluation(settlement);
      return recovered.ok ? placementConflict() : recovered;
    }
    return input.transaction(
      commitOperationalEvaluation.bind(null, settlement),
    );
  } catch (error) {
    const recovered =
      error instanceof OperationalCaseContextDiscoveryRollback
        ? settleCaseContextDiscoveryEvaluation({
            sql: input.sql,
            transaction: input.transaction,
            organisationId,
            evaluationId,
            requestDigest,
            result: evaluated,
            now: settlement.settledAt,
          })
        : recoverOperationalEvaluation(settlement);
    if (!recovered.ok) return recovered;
    if (error instanceof OperationalCaseContextDiscoveryRollback)
      return error.result;
    throw error;
  }
}

function placementConflict(): Result<
  never,
  OperationalCaseContextDiscoveryError
> {
  return { ok: false, error: { code: "organisation_placement_conflict" } };
}

class OperationalCaseContextDiscoveryRollback extends Error {
  constructor(
    readonly result: Result<
      OperationalCaseContextDiscoveryResult,
      OperationalCaseContextDiscoveryError
    >,
  ) {
    super("operational context collection transaction rolled back");
  }
}

function commitOperationalEvaluation(
  input: Parameters<typeof settleOperationalEvaluation>[0],
): Result<
  OperationalCaseContextDiscoveryResult,
  OperationalCaseContextDiscoveryError
> {
  const result = settleOperationalEvaluation(input);
  if (!result.ok) throw new OperationalCaseContextDiscoveryRollback(result);
  return result;
}

function candidateForJev(
  candidate: OperationalCaseContextDiscoveryEvidence,
  index: number,
): Readonly<{ candidateId: string; evidence: string }> {
  return { candidateId: `candidate_${index}`, evidence: candidate.evidence };
}

async function prepareRelationships(
  request: OperationalCaseContextDiscoveryRequest,
  evaluationId: string,
  decisions: readonly JevRelationshipDecision[],
): Promise<readonly PreparedRelationship[]> {
  const prepared: PreparedRelationship[] = [];
  for (const [index, decision] of decisions.entries()) {
    if (
      decision.outcome !== "same_issue" &&
      decision.outcome !== "related_reference"
    ) {
      continue;
    }
    const candidate = request.candidates[index];
    if (candidate === undefined) continue;
    const digest = await digestCanonical({
      evaluationId,
      anchor: request.anchor.selection,
      candidate: candidate.selection,
      decision,
    });
    const reverseDigest = await digestCanonical({
      evaluationId,
      anchor: candidate.selection,
      candidate: request.anchor.selection,
      decision,
    });
    prepared.push({
      selection: candidate.selection,
      relationshipId: `relationship_${digest.slice(0, 48)}`,
      commandId: `suggest_${digest.slice(0, 48)}`,
      requestDigest: digest,
      decision,
      reverse: {
        selection: request.anchor.selection,
        relationshipId: `relationship_${reverseDigest.slice(0, 48)}`,
        commandId: `suggest_${reverseDigest.slice(0, 48)}`,
        requestDigest: reverseDigest,
      },
    });
  }
  return prepared;
}

function settleOperationalEvaluation(
  input: Readonly<{
    sql: SqlStorage;
    transaction: SchemaTransaction;
    organisationId: OrganisationId;
    request: OperationalCaseContextDiscoveryRequest;
    policyMode: "shadow" | "metadata_only" | "party_context";
    evaluationId: string;
    requestDigest: string;
    evaluated: Awaited<ReturnType<JevRelationshipRequest["evaluate"]>>;
    prepared: readonly PreparedRelationship[];
    settledAt: number;
  }>,
): Result<
  OperationalCaseContextDiscoveryResult,
  OperationalCaseContextDiscoveryError
> {
  const receipt = settleCaseContextDiscoveryEvaluation({
    sql: input.sql,
    transaction: directTransaction,
    organisationId: input.organisationId,
    evaluationId: input.evaluationId,
    requestDigest: input.requestDigest,
    result: input.evaluated,
    now: input.settledAt,
  });
  if (!receipt.ok) return receipt;
  const decisions =
    receipt.value.kind === "evaluated" && input.evaluated.ok
      ? input.evaluated.value.decisions
      : [];
  return recordOperationalRelationships({
    sql: input.sql,
    organisationId: input.organisationId,
    request: input.request,
    policyMode: input.policyMode,
    evaluationId: input.evaluationId,
    receipt: receipt.value,
    decisions,
    prepared: input.prepared,
    settledAt: input.settledAt,
  });
}

function recordOperationalRelationships(
  input: Readonly<{
    sql: SqlStorage;
    organisationId: OrganisationId;
    request: OperationalCaseContextDiscoveryRequest;
    policyMode: "shadow" | "metadata_only" | "party_context";
    evaluationId: string;
    receipt: TypeSafeEvaluationReceipt;
    decisions: readonly JevRelationshipDecision[];
    prepared: readonly PreparedRelationship[];
    settledAt: number;
  }>,
): Result<
  OperationalCaseContextDiscoveryResult,
  OperationalCaseContextDiscoveryError
> {
  if (
    (input.policyMode !== "metadata_only" &&
      input.policyMode !== "party_context") ||
    input.receipt.kind !== "evaluated" ||
    input.prepared.length === 0
  ) {
    return {
      ok: true,
      value: {
        receipt: input.receipt,
        decisions: input.decisions,
        recorded: [],
      },
    };
  }
  const target = relationshipTarget(input);
  if (!target.ok) return target;
  const relationships = relationshipsForTarget(input, target.value);
  let revision = target.value.revision;
  const recorded: {
    caseContextCollectionId: string;
    relationshipId: string;
    revision: number;
  }[] = [];
  for (const relationship of relationships) {
    const result = recordCaseContextCollectionSuggestion({
      sql: input.sql,
      transaction: directTransaction,
      organisationId: input.organisationId,
      commandId: relationship.commandId,
      requestDigest: relationship.requestDigest,
      caseContextCollectionId: target.value.caseContextCollectionId,
      relationshipId: relationship.relationshipId,
      expectedRevision: revision,
      scope: target.value.scope,
      sourceScope: target.value.scope,
      anchorSelection: target.value.anchorSelection,
      selection: relationship.selection,
      evaluationId: input.evaluationId,
      outcome: relationship.decision.outcome,
      confidence: relationship.decision.confidence,
      expiresAt: input.settledAt + RELATIONSHIP_TTL_MS,
      now: input.settledAt,
    });
    if (!result.ok) return result;
    revision = result.value.revision;
    recorded.push({
      caseContextCollectionId: result.value.caseContextCollectionId,
      relationshipId: relationship.relationshipId,
      revision,
    });
  }
  return {
    ok: true,
    value: { receipt: input.receipt, decisions: input.decisions, recorded },
  };
}

type PendingOperationalDiscovery = Readonly<{
  policyRevision: number;
  decisions: readonly JevRelationshipDecision[];
  settledAt: number;
}>;

function recoverOperationalEvaluation(
  input: Parameters<typeof settleOperationalEvaluation>[0],
): ReturnType<typeof settleCaseContextDiscoveryEvaluation> {
  return input.transaction(
    recoverOperationalEvaluationTransaction.bind(null, input),
  );
}

function recoverOperationalEvaluationTransaction(
  input: Parameters<typeof settleOperationalEvaluation>[0],
): ReturnType<typeof settleCaseContextDiscoveryEvaluation> {
  const receipt = settleCaseContextDiscoveryEvaluation({
    sql: input.sql,
    transaction: directTransaction,
    organisationId: input.organisationId,
    evaluationId: input.evaluationId,
    requestDigest: input.requestDigest,
    result: input.evaluated,
    now: input.settledAt,
  });
  if (
    receipt.ok &&
    receipt.value.kind === "evaluated" &&
    (input.policyMode === "metadata_only" ||
      input.policyMode === "party_context") &&
    input.evaluated.ok &&
    input.evaluated.value.decisions.some(recordsRelationship)
  ) {
    input.sql.exec(
      `INSERT INTO case_context_discovery_pending (
         organisation_id, evaluation_id, request_digest, policy_revision,
         decisions_json, settled_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      input.organisationId,
      input.evaluationId,
      input.requestDigest,
      receipt.value.policyRevision,
      JSON.stringify(input.evaluated.value.decisions),
      input.settledAt,
    );
  }
  return receipt;
}

function recordsRelationship(decision: JevRelationshipDecision): boolean {
  return (
    decision.outcome === "same_issue" ||
    decision.outcome === "related_reference"
  );
}

function recoverPendingOperationalDiscovery(
  input: Readonly<{
    sql: SqlStorage;
    transaction: SchemaTransaction;
    organisationId: OrganisationId;
    request: OperationalCaseContextDiscoveryRequest;
    evaluationId: string;
    requestDigest: string;
    receipt: TypeSafeEvaluationReceipt;
    decisions: readonly JevRelationshipDecision[];
    prepared: readonly PreparedRelationship[];
    settledAt: number;
  }>,
): Result<
  OperationalCaseContextDiscoveryResult,
  OperationalCaseContextDiscoveryError
> {
  try {
    return input.transaction(
      commitPendingOperationalDiscovery.bind(null, input),
    );
  } catch (error) {
    if (!(error instanceof OperationalCaseContextDiscoveryRollback))
      throw error;
    input.transaction(
      deletePendingOperationalDiscovery.bind(
        null,
        input.sql,
        input.organisationId,
        input.evaluationId,
      ),
    );
    return error.result;
  }
}

function commitPendingOperationalDiscovery(
  input: Parameters<typeof recoverPendingOperationalDiscovery>[0],
): Result<
  OperationalCaseContextDiscoveryResult,
  OperationalCaseContextDiscoveryError
> {
  // Preparation awaits hashing; recheck live dependencies inside the commit transaction.
  const current = replayCaseContextDiscoveryEvaluation(
    input.sql,
    directTransaction,
    {
      organisationId: input.organisationId,
      evaluationId: input.evaluationId,
      requestDigest: input.requestDigest,
      now: input.settledAt,
    },
  );
  if (!current.ok) throw new OperationalCaseContextDiscoveryRollback(current);
  if (current.value === null)
    throw new Error("case_context_discovery_pending_evaluation_missing");
  if (current.value.kind !== "evaluated") {
    deletePendingOperationalDiscovery(
      input.sql,
      input.organisationId,
      input.evaluationId,
    );
    return {
      ok: true,
      value: { receipt: current.value, decisions: [], recorded: [] },
    };
  }
  const result = recordOperationalRelationships({
    sql: input.sql,
    organisationId: input.organisationId,
    request: input.request,
    policyMode: "metadata_only",
    evaluationId: input.evaluationId,
    receipt: input.receipt,
    decisions: input.decisions,
    prepared: input.prepared,
    settledAt: input.settledAt,
  });
  if (!result.ok) throw new OperationalCaseContextDiscoveryRollback(result);
  deletePendingOperationalDiscovery(
    input.sql,
    input.organisationId,
    input.evaluationId,
  );
  return result;
}

function readPendingOperationalDiscovery(
  sql: SqlStorage,
  organisationId: OrganisationId,
  evaluationId: string,
  requestDigest: string,
  candidateCount: number,
): PendingOperationalDiscovery | null {
  const row = sql
    .exec<{
      request_digest: string;
      policy_revision: number;
      decisions_json: string;
      settled_at: number;
    }>(
      `SELECT request_digest, policy_revision, decisions_json, settled_at
       FROM case_context_discovery_pending
       WHERE organisation_id = ? AND evaluation_id = ?`,
      organisationId,
      evaluationId,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const decisions = parsePendingOperationalDecisions(
    row.decisions_json,
    candidateCount,
  );
  if (
    row.request_digest !== requestDigest ||
    !Number.isSafeInteger(row.policy_revision) ||
    row.policy_revision < 1 ||
    !Number.isSafeInteger(row.settled_at) ||
    row.settled_at < 0 ||
    decisions === null
  ) {
    throw new Error("case_context_discovery_pending_discovery_corrupt");
  }
  return {
    policyRevision: row.policy_revision,
    decisions,
    settledAt: row.settled_at,
  };
}

function parsePendingOperationalDecisions(
  raw: string,
  candidateCount: number,
): readonly JevRelationshipDecision[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== candidateCount) return null;
  const decisions: JevRelationshipDecision[] = [];
  for (const [index, decision] of value.entries()) {
    if (
      !isRecord(decision) ||
      Object.keys(decision).length !== 3 ||
      decision.candidateId !== `candidate_${index}` ||
      !relationshipOutcome(decision.outcome) ||
      (decision.confidence !== null &&
        (typeof decision.confidence !== "number" ||
          !Number.isFinite(decision.confidence) ||
          decision.confidence < 0 ||
          decision.confidence > 1))
    ) {
      return null;
    }
    decisions.push({
      candidateId: decision.candidateId,
      outcome: decision.outcome,
      confidence: decision.confidence,
    });
  }
  return decisions;
}

function relationshipOutcome(
  value: unknown,
): value is JevRelationshipDecision["outcome"] {
  return (
    value === "same_issue" ||
    value === "related_reference" ||
    value === "different_issue" ||
    value === "uncertain"
  );
}

function deletePendingOperationalDiscovery(
  sql: SqlStorage,
  organisationId: OrganisationId,
  evaluationId: string,
): void {
  sql.exec(
    `DELETE FROM case_context_discovery_pending
     WHERE organisation_id = ? AND evaluation_id = ?`,
    organisationId,
    evaluationId,
  );
}

function relationshipTarget(
  input: Readonly<{
    sql: SqlStorage;
    organisationId: OrganisationId;
    request: OperationalCaseContextDiscoveryRequest;
    evaluationId: string;
    prepared: readonly PreparedRelationship[];
  }>,
): Result<
  Readonly<{
    caseContextCollectionId: string;
    revision: number;
    scope: CaseContextCollectionScope;
    anchorSelection: CaseContextCollectionSelection;
    existing: CaseContextCollection | null;
  }>,
  CaseContextCollectionRelationshipError
> {
  const caseContextCollectionIds = new Set<string>();
  const memberSelections = [
    input.request.anchor.selection,
    ...input.prepared
      .filter(isSameIssueRelationship)
      .map(selectionFromPreparedRelationship),
  ];
  for (const selection of memberSelections) {
    for (const caseContextCollectionId of listMemberCaseContextCollectionIdsForCase(
      input.sql,
      input.organisationId,
      selection.caseId,
    )) {
      caseContextCollectionIds.add(caseContextCollectionId);
    }
  }
  if (caseContextCollectionIds.size > 1) {
    return {
      ok: false,
      error: { code: "case_context_collection_relationship_conflict" },
    };
  }
  let existingId: string | undefined;
  for (const caseContextCollectionId of caseContextCollectionIds) {
    existingId = caseContextCollectionId;
  }
  if (existingId === undefined) {
    return {
      ok: true,
      value: {
        caseContextCollectionId: `case_context_collection_${input.evaluationId.slice(-48)}`,
        revision: 0,
        scope: input.request.scope,
        anchorSelection: input.request.anchor.selection,
        existing: null,
      },
    };
  }
  const existing = readCaseContextCollection(
    input.sql,
    input.organisationId,
    existingId,
  );
  if (
    existing === null ||
    existing.lifecycle !== "open" ||
    !compatibleCaseContextCollectionScope(existing.scope, input.request.scope)
  ) {
    return {
      ok: false,
      error: { code: "case_context_collection_relationship_conflict" },
    };
  }
  return {
    ok: true,
    value: {
      caseContextCollectionId: existing.caseContextCollectionId,
      revision: existing.revision,
      scope: existing.scope,
      anchorSelection: existing.anchorSelection,
      existing,
    },
  };
}

function relationshipsForTarget(
  input: Readonly<{
    sql: SqlStorage;
    organisationId: OrganisationId;
    request: OperationalCaseContextDiscoveryRequest;
    prepared: readonly PreparedRelationship[];
  }>,
  target: Readonly<{
    caseContextCollectionId: string;
    existing: CaseContextCollection | null;
  }>,
): readonly PreparedRelationship[] {
  if (target.existing === null) return input.prepared;
  const existingCases = new Set<string>([
    target.existing.anchorSelection.caseId,
    ...target.existing.relationships.map(caseIdFromRelationship),
  ]);
  const relationships: PreparedRelationship[] = [];
  if (!existingCases.has(input.request.anchor.selection.caseId)) {
    const support = input.prepared.find(
      supportsExistingCaseContextCollection.bind(
        null,
        input,
        target.caseContextCollectionId,
      ),
    );
    if (support !== undefined) relationships.push(reverseRelationship(support));
  }
  for (const relationship of input.prepared) {
    if (!existingCases.has(relationship.selection.caseId)) {
      relationships.push(relationship);
    }
  }
  return relationships;
}

function supportsExistingCaseContextCollection(
  input: Readonly<{ sql: SqlStorage; organisationId: OrganisationId }>,
  caseContextCollectionId: string,
  relationship: PreparedRelationship,
): boolean {
  return (
    relationship.decision.outcome === "same_issue" &&
    listMemberCaseContextCollectionIdsForCase(
      input.sql,
      input.organisationId,
      relationship.selection.caseId,
    ).includes(caseContextCollectionId)
  );
}

function reverseRelationship(
  relationship: PreparedRelationship,
): PreparedRelationship {
  return {
    selection: relationship.reverse.selection,
    relationshipId: relationship.reverse.relationshipId,
    commandId: relationship.reverse.commandId,
    requestDigest: relationship.reverse.requestDigest,
    decision: relationship.decision,
    reverse: relationship.reverse,
  };
}

function caseIdFromRelationship(
  relationship: CaseContextCollection["relationships"][number],
): string {
  return relationship.selection.caseId;
}

function isSameIssueRelationship(relationship: PreparedRelationship): boolean {
  return relationship.decision.outcome === "same_issue";
}

function compatibleCaseContextCollectionScope(
  existing: CaseContextCollectionScope,
  incoming: CaseContextCollectionScope,
): boolean {
  return (
    existing.organisationId === incoming.organisationId &&
    existing.merchantId === incoming.merchantId &&
    existing.party.kind === incoming.party.kind &&
    existing.party.id === incoming.party.id &&
    existing.issueKind === incoming.issueKind
  );
}

function selectionFromPreparedRelationship(
  relationship: PreparedRelationship,
): CaseContextCollectionSelection {
  return relationship.selection;
}

function selectionFromEvidence(
  evidence: OperationalCaseContextDiscoveryEvidence,
): CaseContextCollectionSelection {
  return evidence.selection;
}

function validRequest(
  request: OperationalCaseContextDiscoveryRequest,
  organisationId: OrganisationId,
): boolean {
  if (
    request.scope.organisationId !== organisationId ||
    request.candidates.length === 0 ||
    request.candidates.length > 5 ||
    !validEvidence(request.anchor.evidence)
  ) {
    return false;
  }
  const cases = new Set<string>([request.anchor.selection.caseId]);
  for (const candidate of request.candidates) {
    if (
      !validEvidence(candidate.evidence) ||
      candidate.selection.source !== request.anchor.selection.source ||
      candidate.selection.integrationAccountId !==
        request.anchor.selection.integrationAccountId ||
      cases.has(candidate.selection.caseId)
    ) {
      return false;
    }
    cases.add(candidate.selection.caseId);
  }
  return true;
}

function validEvidence(value: string): boolean {
  return value.trim().length > 0 && value.length <= 8_192;
}

function directTransaction<T>(closure: () => T): T {
  return closure();
}

function invalidEvaluation(): Result<
  never,
  OperationalCaseContextDiscoveryError
> {
  return {
    ok: false,
    error: { code: "case_context_discovery_evaluation_invalid" },
  };
}
