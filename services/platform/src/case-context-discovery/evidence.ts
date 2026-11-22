import { isRecord, isSha256Hex, parseJsonOrNull } from "@purin-labs/std";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { SchemaTransaction } from "@purin-labs/actor-runtime/actors/schema-migrations";
import { isOrganisationExecutionActive } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { digestCanonical } from "../policy/information-flow/digest";
import { parseFlowRecipient } from "../policy/information-flow/labels";
import type { FlowRecipient } from "../policy/information-flow/types";
import type { Result } from "@purin-labs/kernel/result";
import { identifier, integerIn } from "./policy";
import { readCaseContextDiscoveryPolicy } from "./evaluation-store";
import {
  readCaseContextCollection,
  parseCaseContextCollectionSelection,
  queueCaseContextCollectionInvalidation,
  type CaseContextCollectionSelection,
  type CaseContextCollection,
} from "./relationships";
import type { Variant } from "@purin-labs/type-utils";

export type CaseContextCollectionEvidenceSelection = Readonly<{
  relationshipId: string | null;
  acceptedAtRevision: number;
  source: CaseContextCollectionSelection & Readonly<{ source: "gmail" }>;
}>;

export type CaseContextCollectionEvidenceDependency =
  | Readonly<{
      kind: "source_only";
      caseContextCollectionId?: never;
      caseContextCollectionRevision?: never;
      policyRevision?: never;
      recipient?: never;
      selections?: never;
    }>
  | Readonly<{
      kind: "case_context_collection_evidence";
      caseContextCollectionId: string;
      caseContextCollectionRevision: number;
      policyRevision: number;
      recipient: FlowRecipient;
      selections: readonly CaseContextCollectionEvidenceSelection[];
    }>;
export type CaseContextCollectionEvidence = Variant<
  CaseContextCollectionEvidenceDependency,
  "case_context_collection_evidence"
>;
export type CaseContextCollectionProposalEvidence =
  | Readonly<{
      kind: "source_only";
      dependency?: never;
      flowBindingDigest?: never;
    }>
  | Readonly<{
      kind: "case_context_collection_evidence";
      dependency: Variant<
        import("@purin-labs/contracts").CaseEvidenceDependency,
        "case_context_collection_evidence"
      >;
      flowBindingDigest: string;
    }>;
type CaseContextCollectionEvidenceError = Readonly<{
  code:
    | "case_context_collection_evidence_invalid"
    | "case_context_collection_evidence_stale"
    | "case_context_collection_effect_conflict"
    | "case_context_collection_effect_expired"
    | "organisation_placement_conflict";
}>;

export type CaseContextCollectionEffectAttempt = Readonly<{
  attemptId: string;
  caseId: string;
  proposalId: string;
  proposalVersion: number;
  effect: "draft" | "send";
  targetDigest: string;
  contentDigest: string;
  flowBindingDigest: string;
  dependency: CaseContextCollectionEvidence;
  expiresAt: number;
}>;
export type CaseContextCollectionEffectFence =
  | Readonly<{
      kind: "committed";
      attemptId: string;
      requestDigest: string;
      committedAt: number;
      expiresAt: number;
      reason?: never;
    }>
  | Readonly<{
      kind: "rejected";
      attemptId: string;
      requestDigest: string;
      reason:
        | "case_context_collection_evidence_stale"
        | "case_context_collection_effect_expired";
      committedAt?: never;
      expiresAt?: never;
    }>;

export function createCaseContextCollectionEvidenceSchema(
  sql: SqlStorage,
): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS case_context_collection_effect_fence (
    organisation_id TEXT NOT NULL, attempt_id TEXT NOT NULL, request_digest TEXT NOT NULL,
    case_context_collection_id TEXT NOT NULL, case_context_collection_revision INTEGER NOT NULL,
    receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
    PRIMARY KEY (organisation_id, attempt_id)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS case_context_collection_erased_source (
    organisation_id TEXT NOT NULL, source TEXT NOT NULL, integration_account_id TEXT NOT NULL,
    reference TEXT NOT NULL, erased_at INTEGER NOT NULL,
    PRIMARY KEY (organisation_id, source, integration_account_id, reference)
  )`);
}

export function parseCaseContextCollectionEvidenceDependency(
  raw: unknown,
): CaseContextCollectionEvidenceDependency | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "source_only")
    return Object.keys(raw).length === 1 ? { kind: "source_only" } : null;
  if (
    raw.kind !== "case_context_collection_evidence" ||
    Object.keys(raw).length !== 6 ||
    !identifier(raw.caseContextCollectionId) ||
    !integerIn(raw.caseContextCollectionRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !integerIn(raw.policyRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(raw.selections) ||
    raw.selections.length < 2 ||
    raw.selections.length > 21
  )
    return null;
  const recipient = parseFlowRecipient(raw.recipient);
  if (recipient === null) return null;
  const selections: CaseContextCollectionEvidenceSelection[] = [];
  const seen = new Set<string>();
  for (const selection of raw.selections) {
    if (
      !isRecord(selection) ||
      Object.keys(selection).length !== 3 ||
      !(
        selection.relationshipId === null ||
        identifier(selection.relationshipId)
      ) ||
      !integerIn(
        selection.acceptedAtRevision,
        1,
        raw.caseContextCollectionRevision,
      )
    )
      return null;
    const source = parseCaseContextCollectionSelection(selection.source);
    if (
      source === null ||
      !isGmailCaseContextCollectionSelection(source) ||
      source.integrationAccountId !== recipient.integrationAccountId ||
      source.verificationId !== recipient.verificationId ||
      source.verificationRevision !== recipient.verificationRevision ||
      seen.has(source.reference)
    )
      return null;
    seen.add(source.reference);
    selections.push({
      relationshipId: selection.relationshipId,
      acceptedAtRevision: selection.acceptedAtRevision,
      source,
    });
  }
  if (selections.filter(isAnchor).length !== 1) return null;
  return {
    kind: "case_context_collection_evidence",
    caseContextCollectionId: raw.caseContextCollectionId,
    caseContextCollectionRevision: raw.caseContextCollectionRevision,
    policyRevision: raw.policyRevision,
    recipient,
    selections,
  };
}

export function evidenceForCaseContextCollection(
  caseContextCollection: CaseContextCollection,
  policyRevision: number,
  recipient: FlowRecipient,
  now: number,
): CaseContextCollectionEvidence | null {
  if (
    !isGmailCaseContextCollectionSelection(
      caseContextCollection.anchorSelection,
    )
  )
    return null;
  const selections: CaseContextCollectionEvidenceSelection[] = [
    {
      relationshipId: null,
      acceptedAtRevision: 1,
      source: caseContextCollection.anchorSelection,
    },
  ];
  for (const relationship of caseContextCollection.relationships) {
    if (
      relationship.kind === "attached" &&
      relationship.expiresAt > now &&
      relationship.outcome === "same_issue"
    ) {
      if (!isGmailCaseContextCollectionSelection(relationship.selection))
        return null;
      selections.push({
        relationshipId: relationship.relationshipId,
        acceptedAtRevision: relationship.acceptedAtRevision,
        source: relationship.selection,
      });
    }
  }
  const parsed = parseCaseContextCollectionEvidenceDependency({
    kind: "case_context_collection_evidence",
    caseContextCollectionId: caseContextCollection.caseContextCollectionId,
    caseContextCollectionRevision: caseContextCollection.revision,
    policyRevision,
    recipient,
    selections,
  });
  return parsed?.kind === "case_context_collection_evidence" ? parsed : null;
}

export function validateCaseContextCollectionEvidence(
  input: Readonly<{
    sql: SqlStorage;
    organisationId: OrganisationId;
    dependency: CaseContextCollectionEvidence;
    now: number;
  }>,
): Result<null, CaseContextCollectionEvidenceError> {
  const dependency = input.dependency;
  const policy = readCaseContextDiscoveryPolicy(
    input.sql,
    input.organisationId,
  );
  if (
    policy.revision !== dependency.policyRevision ||
    policy.policy.mode !== "party_context" ||
    dependency.recipient.organisationId !== input.organisationId ||
    !policy.policy.sources.some(matchesSource.bind(null, dependency))
  )
    return stale();
  const caseContextCollection = readCaseContextCollection(
    input.sql,
    input.organisationId,
    dependency.caseContextCollectionId,
  );
  if (
    caseContextCollection === null ||
    caseContextCollection.lifecycle !== "open" ||
    caseContextCollection.revision !==
      dependency.caseContextCollectionRevision ||
    caseContextCollection.scope.merchantId !==
      dependency.recipient.merchantId ||
    caseContextCollection.scope.party.kind !== dependency.recipient.partyKind ||
    caseContextCollection.scope.party.id !== dependency.recipient.partyId
  )
    return stale();
  const current = evidenceForCaseContextCollection(
    caseContextCollection,
    policy.revision,
    dependency.recipient,
    input.now,
  );
  if (
    current === null ||
    JSON.stringify(current) !== JSON.stringify(dependency)
  )
    return stale();
  for (const selection of dependency.selections) {
    if (
      input.sql
        .exec(
          "SELECT 1 FROM case_context_collection_erased_source WHERE organisation_id = ? AND source = ? AND integration_account_id = ? AND reference = ?",
          input.organisationId,
          selection.source.source,
          selection.source.integrationAccountId,
          selection.source.reference,
        )
        .toArray().length > 0
    )
      return stale();
  }
  return { ok: true, value: null };
}

export function parseCaseContextCollectionEffectAttempt(
  raw: unknown,
): CaseContextCollectionEffectAttempt | null {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 10 ||
    !identifier(raw.attemptId) ||
    !identifier(raw.caseId) ||
    !identifier(raw.proposalId) ||
    !integerIn(raw.proposalVersion, 1, Number.MAX_SAFE_INTEGER) ||
    (raw.effect !== "draft" && raw.effect !== "send") ||
    !isSha256Hex(raw.targetDigest) ||
    !isSha256Hex(raw.contentDigest) ||
    !isSha256Hex(raw.flowBindingDigest) ||
    !integerIn(raw.expiresAt, 1, Number.MAX_SAFE_INTEGER)
  )
    return null;
  const dependency = parseCaseContextCollectionEvidenceDependency(
    raw.dependency,
  );
  if (
    dependency?.kind !== "case_context_collection_evidence" ||
    !dependency.selections.some(selectionOwnsCase.bind(null, raw.caseId))
  )
    return null;
  return {
    attemptId: raw.attemptId,
    caseId: raw.caseId,
    proposalId: raw.proposalId,
    proposalVersion: raw.proposalVersion,
    effect: raw.effect,
    targetDigest: raw.targetDigest,
    contentDigest: raw.contentDigest,
    flowBindingDigest: raw.flowBindingDigest,
    dependency,
    expiresAt: raw.expiresAt,
  };
}

export async function commitCaseContextCollectionEffectFence(
  input: Readonly<{
    sql: SqlStorage;
    transaction: SchemaTransaction;
    scope: OrganisationExecutionScope;
    attempt: CaseContextCollectionEffectAttempt;
    now: () => number;
  }>,
): Promise<
  Result<CaseContextCollectionEffectFence, CaseContextCollectionEvidenceError>
> {
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return placementConflict();
  const requestDigest = await digestCanonical(input.attempt);
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return placementConflict();
  return input.transaction(commitFence.bind(null, input, requestDigest));
}

export async function replayCaseContextCollectionEffectFence(
  input: Readonly<{
    sql: SqlStorage;
    scope: OrganisationExecutionScope;
    attempt: CaseContextCollectionEffectAttempt;
    now: () => number;
  }>,
): Promise<
  Result<
    CaseContextCollectionEffectFence | null,
    CaseContextCollectionEvidenceError
  >
> {
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return placementConflict();
  const requestDigest = await digestCanonical(input.attempt);
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return placementConflict();
  return readFence(
    input.sql,
    input.scope.organisationId,
    input.attempt.attemptId,
    requestDigest,
    input.now(),
  );
}

function readFence(
  sql: SqlStorage,
  organisationId: OrganisationId,
  attemptId: string,
  requestDigest: string,
  now: number,
): Result<
  CaseContextCollectionEffectFence | null,
  CaseContextCollectionEvidenceError
> {
  const previous = sql
    .exec<{ request_digest: string; receipt_json: string }>(
      "SELECT request_digest, receipt_json FROM case_context_collection_effect_fence WHERE organisation_id = ? AND attempt_id = ?",
      organisationId,
      attemptId,
    )
    .toArray()[0];
  if (previous === undefined) return { ok: true, value: null };
  if (previous.request_digest !== requestDigest)
    return {
      ok: false,
      error: { code: "case_context_collection_effect_conflict" },
    };
  const receipt = parseFence(parseJsonOrNull(previous.receipt_json));
  if (receipt === null)
    throw new Error("case_context_collection_effect_fence_corrupt");
  if (receipt.kind === "committed" && receipt.expiresAt <= now)
    return {
      ok: false,
      error: { code: "case_context_collection_effect_expired" },
    };
  return { ok: true, value: receipt };
}

function commitFence(
  input: Parameters<typeof commitCaseContextCollectionEffectFence>[0],
  requestDigest: string,
): Result<
  CaseContextCollectionEffectFence,
  CaseContextCollectionEvidenceError
> {
  const now = input.now();
  const previous = readFence(
    input.sql,
    input.scope.organisationId,
    input.attempt.attemptId,
    requestDigest,
    now,
  );
  if (!previous.ok) return previous;
  if (previous.value !== null) return { ok: true, value: previous.value };
  const valid = validateCaseContextCollectionEvidence({
    sql: input.sql,
    organisationId: input.scope.organisationId,
    dependency: input.attempt.dependency,
    now,
  });
  let receipt: CaseContextCollectionEffectFence;
  if (input.attempt.expiresAt <= now) {
    receipt = {
      kind: "rejected",
      attemptId: input.attempt.attemptId,
      requestDigest,
      reason: "case_context_collection_effect_expired",
    };
  } else if (!valid.ok) {
    receipt = {
      kind: "rejected",
      attemptId: input.attempt.attemptId,
      requestDigest,
      reason: "case_context_collection_evidence_stale",
    };
  } else {
    receipt = {
      kind: "committed",
      attemptId: input.attempt.attemptId,
      requestDigest,
      committedAt: now,
      expiresAt: input.attempt.expiresAt,
    };
  }
  input.sql.exec(
    "INSERT INTO case_context_collection_effect_fence (organisation_id, attempt_id, request_digest, case_context_collection_id, case_context_collection_revision, receipt_json) VALUES (?, ?, ?, ?, ?, ?)",
    input.scope.organisationId,
    input.attempt.attemptId,
    requestDigest,
    input.attempt.dependency.caseContextCollectionId,
    input.attempt.dependency.caseContextCollectionRevision,
    JSON.stringify(receipt),
  );
  return { ok: true, value: receipt };
}

function placementConflict(): Result<
  never,
  CaseContextCollectionEvidenceError
> {
  return { ok: false, error: { code: "organisation_placement_conflict" } };
}

export function invalidateCaseContextCollectionVerification(
  input: Readonly<{
    sql: SqlStorage;
    organisationId: OrganisationId;
    verificationId: string;
    revision: number;
  }>,
): void {
  const rows = input.sql
    .exec<{ case_context_collection_id: string; selection_json: string }>(
      "SELECT case_context_collection_id, selection_json FROM case_context_collection_case WHERE organisation_id = ?",
      input.organisationId,
    )
    .toArray();
  const affected = new Set<string>();
  for (const row of rows) {
    const selection = parseCaseContextCollectionSelection(
      parseJsonOrNull(row.selection_json),
    );
    if (
      selection !== null &&
      selection.verificationId === input.verificationId &&
      selection.verificationRevision < input.revision
    )
      affected.add(row.case_context_collection_id);
  }
  for (const caseContextCollectionId of affected) {
    input.sql.exec(
      "UPDATE case_context_collection SET revision = revision + 1, lifecycle = 'resolved' WHERE organisation_id = ? AND case_context_collection_id = ? AND lifecycle = 'open'",
      input.organisationId,
      caseContextCollectionId,
    );
    queueCaseContextCollectionInvalidation(
      input.sql,
      input.organisationId,
      caseContextCollectionId,
    );
  }
}

export function eraseCaseContextCollectionSource(
  input: Readonly<{
    sql: SqlStorage;
    transaction: SchemaTransaction;
    organisationId: OrganisationId;
    selection: CaseContextCollectionSelection;
    now: number;
  }>,
): void {
  input.transaction(eraseSource.bind(null, input));
}
function eraseSource(
  input: Parameters<typeof eraseCaseContextCollectionSource>[0],
): void {
  const inserted = input.sql.exec(
    `INSERT INTO case_context_collection_erased_source VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    input.organisationId,
    input.selection.source,
    input.selection.integrationAccountId,
    input.selection.reference,
    input.now,
  );
  if (inserted.rowsWritten === 0) return;
  const rows = input.sql
    .exec<{ case_context_collection_id: string; selection_json: string }>(
      "SELECT case_context_collection_id, selection_json FROM case_context_collection_case WHERE organisation_id = ?",
      input.organisationId,
    )
    .toArray();
  const affected = new Set<string>();
  for (const row of rows) {
    const source = parseCaseContextCollectionSelection(
      parseJsonOrNull(row.selection_json),
    );
    if (
      source !== null &&
      source.source === input.selection.source &&
      source.integrationAccountId === input.selection.integrationAccountId &&
      source.reference === input.selection.reference
    )
      affected.add(row.case_context_collection_id);
  }
  for (const caseContextCollectionId of affected) {
    input.sql.exec(
      "UPDATE case_context_collection SET revision = revision + 1, lifecycle = 'resolved' WHERE organisation_id = ? AND case_context_collection_id = ?",
      input.organisationId,
      caseContextCollectionId,
    );
    queueCaseContextCollectionInvalidation(
      input.sql,
      input.organisationId,
      caseContextCollectionId,
    );
  }
}

function parseFence(raw: unknown): CaseContextCollectionEffectFence | null {
  if (
    !isRecord(raw) ||
    !identifier(raw.attemptId) ||
    !isSha256Hex(raw.requestDigest)
  )
    return null;
  if (
    raw.kind === "committed" &&
    integerIn(raw.committedAt, 0, Number.MAX_SAFE_INTEGER) &&
    integerIn(raw.expiresAt, 1, Number.MAX_SAFE_INTEGER)
  )
    return {
      kind: "committed",
      attemptId: raw.attemptId,
      requestDigest: raw.requestDigest,
      committedAt: raw.committedAt,
      expiresAt: raw.expiresAt,
    };
  if (
    raw.kind === "rejected" &&
    (raw.reason === "case_context_collection_evidence_stale" ||
      raw.reason === "case_context_collection_effect_expired")
  )
    return {
      kind: "rejected",
      attemptId: raw.attemptId,
      requestDigest: raw.requestDigest,
      reason: raw.reason,
    };
  return null;
}
function isAnchor(selection: CaseContextCollectionEvidenceSelection): boolean {
  return selection.relationshipId === null;
}
function isGmailCaseContextCollectionSelection(
  source: CaseContextCollectionSelection,
): source is CaseContextCollectionSelection & Readonly<{ source: "gmail" }> {
  return source.source === "gmail";
}
function selectionOwnsCase(
  caseId: string,
  selection: CaseContextCollectionEvidenceSelection,
): boolean {
  return selection.source.caseId === caseId;
}
function matchesSource(
  dependency: CaseContextCollectionEvidence,
  source: Readonly<{ source: string; integrationAccountId: string }>,
): boolean {
  return (
    source.source === "gmail" &&
    source.integrationAccountId === dependency.recipient.integrationAccountId
  );
}
function stale(): Result<never, CaseContextCollectionEvidenceError> {
  return {
    ok: false,
    error: { code: "case_context_collection_evidence_stale" },
  };
}

export async function caseContextCollectionEvidenceDependency(
  dependency: CaseContextCollectionEvidenceDependency,
): Promise<import("@purin-labs/contracts").CaseEvidenceDependency> {
  if (dependency.kind === "source_only") return { kind: "source_only" };
  return {
    kind: "case_context_collection_evidence",
    caseContextCollectionId: dependency.caseContextCollectionId,
    caseContextCollectionRevision: dependency.caseContextCollectionRevision,
    policyRevision: dependency.policyRevision,
    recipientDigest: await digestCanonical(dependency.recipient),
    dependencyDigest: await digestCanonical(dependency),
    selections: dependency.selections.map(caseEvidenceSelection),
  };
}
function caseEvidenceSelection(
  selection: CaseContextCollectionEvidenceSelection,
): import("@purin-labs/contracts").CaseContextCollectionEvidenceRef {
  return {
    caseId: selection.source.caseId,
    integrationAccountId: selection.source.integrationAccountId,
    reference: selection.source.reference,
    sourceRevision: selection.source.sourceRevision,
    verificationId: selection.source.verificationId,
    verificationRevision: selection.source.verificationRevision,
    relationshipId: selection.relationshipId,
    acceptedAtRevision: selection.acceptedAtRevision,
  };
}

export function parseCaseEvidenceDependency(
  raw: unknown,
): import("@purin-labs/contracts").CaseEvidenceDependency | null {
  if (raw === undefined) return { kind: "source_only" };
  if (!isRecord(raw)) return null;
  if (raw.kind === "source_only" && Object.keys(raw).length === 1)
    return { kind: "source_only" };
  if (
    raw.kind !== "case_context_collection_evidence" ||
    Object.keys(raw).length !== 7 ||
    !identifier(raw.caseContextCollectionId) ||
    !integerIn(raw.caseContextCollectionRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !integerIn(raw.policyRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !isSha256Hex(raw.recipientDigest) ||
    !isSha256Hex(raw.dependencyDigest) ||
    !Array.isArray(raw.selections) ||
    raw.selections.length < 2 ||
    raw.selections.length > 21
  )
    return null;
  const selections: import("@purin-labs/contracts").CaseContextCollectionEvidenceRef[] =
    [];
  const seen = new Set<string>();
  let anchors = 0;
  for (const selection of raw.selections) {
    if (
      !isRecord(selection) ||
      Object.keys(selection).length !== 8 ||
      !(
        selection.relationshipId === null ||
        identifier(selection.relationshipId)
      ) ||
      !integerIn(
        selection.acceptedAtRevision,
        1,
        raw.caseContextCollectionRevision,
      )
    )
      return null;
    const source = parseCaseContextCollectionSelection({
      source: "gmail",
      caseId: selection.caseId,
      integrationAccountId: selection.integrationAccountId,
      reference: selection.reference,
      sourceRevision: selection.sourceRevision,
      verificationId: selection.verificationId,
      verificationRevision: selection.verificationRevision,
    });
    if (
      source === null ||
      !isGmailCaseContextCollectionSelection(source) ||
      seen.has(source.reference)
    )
      return null;
    seen.add(source.reference);
    if (selection.relationshipId === null) anchors++;
    selections.push(
      caseEvidenceSelection({
        relationshipId: selection.relationshipId,
        acceptedAtRevision: selection.acceptedAtRevision,
        source,
      }),
    );
  }
  if (anchors !== 1) return null;
  return {
    kind: "case_context_collection_evidence",
    caseContextCollectionId: raw.caseContextCollectionId,
    caseContextCollectionRevision: raw.caseContextCollectionRevision,
    policyRevision: raw.policyRevision,
    recipientDigest: raw.recipientDigest,
    dependencyDigest: raw.dependencyDigest,
    selections,
  };
}
