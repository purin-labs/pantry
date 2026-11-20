import {
  hasExactKeys,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  sameJson,
} from "@purin-labs/std";
import type { CommerceEntityRef } from "@purin-labs/commerce-contracts";

/** One exact Memory revision. Turns, evals and receipts cite this pair. */
export type MemoryRevisionRef = Readonly<{
  memoryId: string;
  revision: number;
}>;

export type MemoryKind = "fact" | "preference" | "lesson";

/**
 * Where a Memory applies.
 *
 * A skill scope admits it only when that skill is loaded, a resource class only
 * when the turn reads that class, and an entity scope only for that exact
 * commerce entity. A Portal chat scope admits it only to a turn that a person
 * started in a Portal conversation. Project placement supplies neither
 * applicability nor access.
 */
export type MemoryApplicability =
  | Readonly<{
      kind: "portal_chat";
      skillId?: never;
      entityType?: never;
      merchantId?: never;
      entity?: never;
    }>
  | Readonly<{
      kind: "skill";
      skillId: string;
      entityType?: never;
      merchantId?: never;
      entity?: never;
    }>
  | Readonly<{
      kind: "commerce_resource_class";
      entityType: string;
      skillId?: never;
      merchantId?: never;
      entity?: never;
    }>
  | Readonly<{
      kind: "commerce_entity";
      merchantId: string;
      entity: CommerceEntityRef;
      skillId?: never;
      entityType?: never;
    }>;

/**
 * One record that justifies a Memory, named by exact identity and revision.
 *
 * A reference grants no access to the record it names, and the platform reads
 * the acting person from its own records, never from this shape.
 */
export type MemoryEvidence =
  | Readonly<{
      kind: "case_context_collection";
      caseContextCollectionId: string;
      revision: number;
      caseId?: never;
      entryId?: never;
      digest?: never;
      integrationAccountId?: never;
      proposalId?: never;
      version?: never;
    }>
  | Readonly<{
      kind: "case_observation" | "operator_instruction";
      caseId: string;
      entryId: string;
      digest: string;
      caseContextCollectionId?: never;
      revision?: never;
      integrationAccountId?: never;
      proposalId?: never;
      version?: never;
    }>
  /**
   * A reviewed edit of a mail reply draft: the mailbox that holds the
   * proposal, the exact version the edit produced, and that version's body
   * digest.
   */
  | Readonly<{
      kind: "proposal_correction";
      caseId: string;
      integrationAccountId: string;
      proposalId: string;
      version: number;
      digest: string;
      caseContextCollectionId?: never;
      revision?: never;
      entryId?: never;
    }>;

/**
 * When a Memory holds, kept apart from where it applies.
 *
 * `dependsOn` names the evidence whose exact revisions its truth rests on. A
 * changed or erased dependency requires renewed review before the Memory is used.
 */
export type MemoryValidity = Readonly<{
  /** IANA zone the effective dates and any time of day in the statement are read in. */
  timezone: string;
  /** First calendar date it holds, as YYYY-MM-DD in `timezone`. */
  effectiveFrom: string;
  /** Last calendar date it holds, or null while no end is known. */
  effectiveUntil: string | null;
  dependsOn: readonly MemoryEvidence[];
}>;

export type MemoryContent = Readonly<{
  memoryKind: MemoryKind;
  /** The reusable fact, preference or lesson, in the author's words. */
  statement: string;
  applicability: MemoryApplicability;
  validity: MemoryValidity;
  evidence: readonly MemoryEvidence[];
  /** The Case the proposal came from, so its origin stays inspectable. */
  sourceCaseId: string;
}>;

/**
 * How a person submitted a revision, which decides who may read their words.
 *
 * `own_input` is a private submission: the revision carries the author's own
 * input label. `shared_review` is an explicit edit of the candidate under
 * review, or a proposed replacement for the accepted revision when no
 * candidate is open. The revision keeps every restriction of the one it
 * inherits from, joins any newly cited record, and is readable by that
 * revision's audience. An accepted revision stays in force until its
 * replacement is accepted.
 */
export type MemorySubmission = "own_input" | "shared_review";

export type MemoryAuthor =
  | Readonly<{
      kind: "agent";
      caseId: string;
      assignmentId: string;
      sessionId: string;
      personId?: never;
      submission?: never;
    }>
  | Readonly<{
      kind: "operator";
      personId: string;
      submission: MemorySubmission;
      caseId?: never;
      assignmentId?: never;
      sessionId?: never;
    }>;

/** A reviewer's decision and the command receipt that recorded it. */
export type MemoryDecision = Readonly<{
  reviewerPersonId: string;
  commandId: string;
  decidedAt: number;
}>;

/**
 * A candidate leaves review either declined or replaced by a reviewer's
 * revision, which names the candidate that took its place.
 */
export type MemoryRejection = MemoryDecision &
  (
    | Readonly<{ reason: "declined"; replacementRevision?: never }>
    | Readonly<{ reason: "revised"; replacementRevision: number }>
  );

export type MemorySupersession = Readonly<{
  replacementRevision: number;
  supersededAt: number;
}>;

/**
 * The lifecycle of one revision. Acceptance exists only on a revision a person
 * accepted, and stays on it after supersession or revocation.
 */
export type MemoryRevisionState =
  | Readonly<{
      kind: "candidate";
      acceptance?: never;
      rejection?: never;
      supersession?: never;
      revocation?: never;
    }>
  | Readonly<{
      kind: "accepted";
      acceptance: MemoryDecision;
      rejection?: never;
      supersession?: never;
      revocation?: never;
    }>
  | Readonly<{
      kind: "rejected";
      rejection: MemoryRejection;
      acceptance?: never;
      supersession?: never;
      revocation?: never;
    }>
  | Readonly<{
      kind: "superseded";
      acceptance: MemoryDecision;
      supersession: MemorySupersession;
      rejection?: never;
      revocation?: never;
    }>
  | Readonly<{
      kind: "revoked";
      acceptance: MemoryDecision;
      revocation: MemoryDecision;
      rejection?: never;
      supersession?: never;
    }>;

export type MemoryRevisionView = MemoryContent &
  Readonly<{
    revision: number;
    proposedBy: MemoryAuthor;
    proposedAt: number;
  }> &
  MemoryRevisionState;

export type MemoryView = Readonly<{
  memoryId: string;
  /** The latest revision number. Commands name it as their expected revision. */
  headRevision: number;
  revisions: readonly MemoryRevisionView[];
}>;

/**
 * One idempotent Memory command.
 *
 * `expectedRevision` is the head revision the sender last saw, and 0 for a new
 * Memory. A proposal on an existing Memory adds its next candidate revision.
 */
export type MemoryCommand = Readonly<{
  commandId: string;
  expectedRevision: number;
}> &
  (
    | Readonly<{
        kind: "propose";
        memoryId: string | null;
        submission: MemorySubmission;
        content: MemoryContent;
        revision?: never;
      }>
    | Readonly<{
        kind: "accept" | "reject" | "revoke";
        memoryId: string;
        revision: number;
        submission?: never;
        content?: never;
      }>
  );

export type MemoryCommandReceipt = Readonly<{
  commandId: string;
  memoryId: string;
  /** The revision the command created or decided. */
  revision: number;
  headRevision: number;
  state: MemoryRevisionState["kind"];
}>;

export type MemoryCommandErrorCode =
  | "memory_invalid"
  | "memory_unavailable"
  /** The expected revision or the revision's state no longer matches. */
  | "memory_conflict"
  /** The command identity was already used for a different request. */
  | "memory_command_conflict"
  /** A decision came from a principal that cannot review, such as an agent. */
  | "memory_reviewer_required"
  | "memory_capacity_exceeded";

/** Parses a commerce entity reference, or returns null when it is not one. */
export type MemoryEntityRefParser = (raw: unknown) => CommerceEntityRef | null;

const MAX_STATEMENT_LENGTH = 2_000;
const MAX_EVIDENCE = 20;
const MAX_REVISIONS = 200;
const MAX_MEMORIES = 500;

export function parseMemoryCommand(
  raw: unknown,
  parseEntityRef: MemoryEntityRefParser,
): MemoryCommand | null {
  if (
    !isRecord(raw) ||
    !identifier(raw.commandId) ||
    !isNonNegativeInteger(raw.expectedRevision)
  )
    return null;
  const base = {
    commandId: raw.commandId,
    expectedRevision: raw.expectedRevision,
  };
  if (raw.kind === "propose") {
    if (
      !hasExactKeys(raw, [
        "commandId",
        "expectedRevision",
        "kind",
        "memoryId",
        "submission",
        "content",
      ]) ||
      (raw.memoryId !== null && !identifier(raw.memoryId)) ||
      (raw.memoryId === null) !== (raw.expectedRevision === 0) ||
      !memorySubmission(raw.submission) ||
      // A shared review edits or replaces a revision of an existing Memory.
      (raw.memoryId === null && raw.submission !== "own_input")
    )
      return null;
    const content = parseMemoryContent(raw.content, parseEntityRef);
    return content === null
      ? null
      : {
          ...base,
          kind: "propose",
          memoryId: raw.memoryId,
          submission: raw.submission,
          content,
        };
  }
  if (
    (raw.kind !== "accept" && raw.kind !== "reject" && raw.kind !== "revoke") ||
    !hasExactKeys(raw, [
      "commandId",
      "expectedRevision",
      "kind",
      "memoryId",
      "revision",
    ]) ||
    !identifier(raw.memoryId) ||
    !isPositiveInteger(raw.revision) ||
    raw.revision > raw.expectedRevision
  )
    return null;
  return {
    ...base,
    kind: raw.kind,
    memoryId: raw.memoryId,
    revision: raw.revision,
  };
}

export function parseMemoryContent(
  raw: unknown,
  parseEntityRef: MemoryEntityRefParser,
): MemoryContent | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "memoryKind",
      "statement",
      "applicability",
      "validity",
      "evidence",
      "sourceCaseId",
    ]) ||
    (raw.memoryKind !== "fact" &&
      raw.memoryKind !== "preference" &&
      raw.memoryKind !== "lesson") ||
    typeof raw.statement !== "string" ||
    raw.statement.trim().length === 0 ||
    raw.statement.length > MAX_STATEMENT_LENGTH ||
    !identifier(raw.sourceCaseId)
  )
    return null;
  const applicability = parseApplicability(raw.applicability, parseEntityRef);
  const evidence = parseEvidenceList(raw.evidence);
  if (applicability === null || evidence === null || evidence.length === 0)
    return null;
  const validity = parseValidity(raw.validity, evidence);
  return validity === null
    ? null
    : {
        memoryKind: raw.memoryKind,
        statement: raw.statement,
        applicability,
        validity,
        evidence,
        sourceCaseId: raw.sourceCaseId,
      };
}

export function parseMemoryRevisionState(
  raw: unknown,
): MemoryRevisionState | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "candidate":
      return hasExactKeys(raw, ["kind"]) ? { kind: "candidate" } : null;
    case "accepted": {
      const acceptance = parseDecision(raw.acceptance);
      return hasExactKeys(raw, ["kind", "acceptance"]) && acceptance !== null
        ? { kind: "accepted", acceptance }
        : null;
    }
    case "rejected": {
      const rejection = parseRejection(raw.rejection);
      return hasExactKeys(raw, ["kind", "rejection"]) && rejection !== null
        ? { kind: "rejected", rejection }
        : null;
    }
    case "superseded": {
      const acceptance = parseDecision(raw.acceptance);
      const supersession = raw.supersession;
      return hasExactKeys(raw, ["kind", "acceptance", "supersession"]) &&
        acceptance !== null &&
        isRecord(supersession) &&
        hasExactKeys(supersession, ["replacementRevision", "supersededAt"]) &&
        isPositiveInteger(supersession.replacementRevision) &&
        isNonNegativeInteger(supersession.supersededAt)
        ? {
            kind: "superseded",
            acceptance,
            supersession: {
              replacementRevision: supersession.replacementRevision,
              supersededAt: supersession.supersededAt,
            },
          }
        : null;
    }
    case "revoked": {
      const acceptance = parseDecision(raw.acceptance);
      const revocation = parseDecision(raw.revocation);
      return hasExactKeys(raw, ["kind", "acceptance", "revocation"]) &&
        acceptance !== null &&
        revocation !== null
        ? { kind: "revoked", acceptance, revocation }
        : null;
    }
    default:
      return null;
  }
}

export function parseMemoryAuthor(raw: unknown): MemoryAuthor | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "operator")
    return hasExactKeys(raw, ["kind", "personId", "submission"]) &&
      identifier(raw.personId) &&
      memorySubmission(raw.submission)
      ? {
          kind: "operator",
          personId: raw.personId,
          submission: raw.submission,
        }
      : null;
  return raw.kind === "agent" &&
    hasExactKeys(raw, ["kind", "caseId", "assignmentId", "sessionId"]) &&
    identifier(raw.caseId) &&
    identifier(raw.assignmentId) &&
    identifier(raw.sessionId)
    ? {
        kind: "agent",
        caseId: raw.caseId,
        assignmentId: raw.assignmentId,
        sessionId: raw.sessionId,
      }
    : null;
}

export function parseMemoryCommandReceipt(
  raw: unknown,
): MemoryCommandReceipt | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "commandId",
      "memoryId",
      "revision",
      "headRevision",
      "state",
    ]) ||
    !identifier(raw.commandId) ||
    !identifier(raw.memoryId) ||
    !isPositiveInteger(raw.revision) ||
    !isPositiveInteger(raw.headRevision) ||
    raw.revision > raw.headRevision ||
    !revisionStateKind(raw.state)
  )
    return null;
  return {
    commandId: raw.commandId,
    memoryId: raw.memoryId,
    revision: raw.revision,
    headRevision: raw.headRevision,
    state: raw.state,
  };
}

export function parseMemoryListResponse(
  raw: unknown,
  parseEntityRef: MemoryEntityRefParser,
): readonly MemoryView[] {
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    !Array.isArray(raw.memories) ||
    raw.memories.length > MAX_MEMORIES
  )
    throw new Error("Memory is unavailable.");
  const memories: MemoryView[] = [];
  for (const entry of raw.memories) {
    const memory = parseMemoryView(entry, parseEntityRef);
    if (memory === null) throw new Error("Memory is invalid.");
    memories.push(memory);
  }
  return memories;
}

export function parseMemoryView(
  raw: unknown,
  parseEntityRef: MemoryEntityRefParser,
): MemoryView | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["memoryId", "headRevision", "revisions"]) ||
    !identifier(raw.memoryId) ||
    !isPositiveInteger(raw.headRevision) ||
    !Array.isArray(raw.revisions) ||
    raw.revisions.length === 0 ||
    raw.revisions.length > MAX_REVISIONS
  )
    return null;
  const revisions: MemoryRevisionView[] = [];
  for (const entry of raw.revisions) {
    const revision = parseMemoryRevisionView(entry, parseEntityRef);
    if (revision === null || revision.revision > raw.headRevision) return null;
    revisions.push(revision);
  }
  return {
    memoryId: raw.memoryId,
    headRevision: raw.headRevision,
    revisions,
  };
}

export function parseMemoryRevisionView(
  raw: unknown,
  parseEntityRef: MemoryEntityRefParser,
): MemoryRevisionView | null {
  if (
    !isRecord(raw) ||
    !isPositiveInteger(raw.revision) ||
    !isNonNegativeInteger(raw.proposedAt)
  )
    return null;
  const {
    revision,
    proposedBy: rawAuthor,
    proposedAt,
    memoryKind,
    statement,
    applicability,
    validity,
    evidence,
    sourceCaseId,
    ...rawState
  } = raw;
  const content = parseMemoryContent(
    { memoryKind, statement, applicability, validity, evidence, sourceCaseId },
    parseEntityRef,
  );
  const proposedBy = parseMemoryAuthor(rawAuthor);
  const state = parseMemoryRevisionState(rawState);
  return content === null || proposedBy === null || state === null
    ? null
    : { ...content, revision, proposedBy, proposedAt, ...state };
}

function parseApplicability(
  raw: unknown,
  parseEntityRef: MemoryEntityRefParser,
): MemoryApplicability | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "portal_chat":
      return hasExactKeys(raw, ["kind"]) ? { kind: "portal_chat" } : null;
    case "skill":
      return hasExactKeys(raw, ["kind", "skillId"]) && identifier(raw.skillId)
        ? { kind: "skill", skillId: raw.skillId }
        : null;
    case "commerce_resource_class":
      return hasExactKeys(raw, ["kind", "entityType"]) &&
        identifier(raw.entityType)
        ? { kind: "commerce_resource_class", entityType: raw.entityType }
        : null;
    case "commerce_entity": {
      if (
        !hasExactKeys(raw, ["kind", "merchantId", "entity"]) ||
        !identifier(raw.merchantId)
      )
        return null;
      const entity = parseEntityRef(raw.entity);
      return entity === null
        ? null
        : { kind: "commerce_entity", merchantId: raw.merchantId, entity };
    }
    default:
      return null;
  }
}

function parseValidity(
  raw: unknown,
  evidence: readonly MemoryEvidence[],
): MemoryValidity | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "timezone",
      "effectiveFrom",
      "effectiveUntil",
      "dependsOn",
    ]) ||
    !timezone(raw.timezone) ||
    !calendarDate(raw.effectiveFrom) ||
    (raw.effectiveUntil !== null &&
      (!calendarDate(raw.effectiveUntil) ||
        raw.effectiveUntil < raw.effectiveFrom))
  )
    return null;
  const dependsOn = parseEvidenceList(raw.dependsOn);
  // A dependency is one of the cited records, so its restrictions are already joined.
  if (dependsOn === null || !dependsOn.every(citedIn.bind(null, evidence)))
    return null;
  return {
    timezone: raw.timezone,
    effectiveFrom: raw.effectiveFrom,
    effectiveUntil: raw.effectiveUntil,
    dependsOn,
  };
}

function citedIn(
  evidence: readonly MemoryEvidence[],
  dependency: MemoryEvidence,
): boolean {
  return evidence.some((cited) => sameJson(cited, dependency));
}

function parseEvidenceList(raw: unknown): readonly MemoryEvidence[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_EVIDENCE) return null;
  const evidence: MemoryEvidence[] = [];
  for (const entry of raw) {
    const parsed = parseEvidence(entry);
    if (parsed === null || citedIn(evidence, parsed)) return null;
    evidence.push(parsed);
  }
  return evidence;
}

function parseEvidence(raw: unknown): MemoryEvidence | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "case_context_collection":
      return hasExactKeys(raw, [
        "kind",
        "caseContextCollectionId",
        "revision",
      ]) &&
        identifier(raw.caseContextCollectionId) &&
        isPositiveInteger(raw.revision)
        ? {
            kind: "case_context_collection",
            caseContextCollectionId: raw.caseContextCollectionId,
            revision: raw.revision,
          }
        : null;
    case "case_observation":
    case "operator_instruction":
      return hasExactKeys(raw, ["kind", "caseId", "entryId", "digest"]) &&
        identifier(raw.caseId) &&
        identifier(raw.entryId) &&
        typeof raw.digest === "string" &&
        /^[0-9a-f]{64}$/u.test(raw.digest)
        ? {
            kind: raw.kind,
            caseId: raw.caseId,
            entryId: raw.entryId,
            digest: raw.digest,
          }
        : null;
    case "proposal_correction":
      return hasExactKeys(raw, [
        "kind",
        "caseId",
        "integrationAccountId",
        "proposalId",
        "version",
        "digest",
      ]) &&
        identifier(raw.caseId) &&
        identifier(raw.integrationAccountId) &&
        identifier(raw.proposalId) &&
        isPositiveInteger(raw.version) &&
        typeof raw.digest === "string" &&
        /^[a-f0-9]{64}$/u.test(raw.digest)
        ? {
            kind: "proposal_correction",
            caseId: raw.caseId,
            integrationAccountId: raw.integrationAccountId,
            proposalId: raw.proposalId,
            version: raw.version,
            digest: raw.digest,
          }
        : null;
    default:
      return null;
  }
}

function parseDecision(raw: unknown): MemoryDecision | null {
  return isRecord(raw) &&
    hasExactKeys(raw, ["reviewerPersonId", "commandId", "decidedAt"]) &&
    identifier(raw.reviewerPersonId) &&
    identifier(raw.commandId) &&
    isNonNegativeInteger(raw.decidedAt)
    ? {
        reviewerPersonId: raw.reviewerPersonId,
        commandId: raw.commandId,
        decidedAt: raw.decidedAt,
      }
    : null;
}

function parseRejection(raw: unknown): MemoryRejection | null {
  if (!isRecord(raw)) return null;
  const { reason, replacementRevision, ...rawDecision } = raw;
  const decision = parseDecision(rawDecision);
  if (decision === null) return null;
  if (reason === "declined")
    return replacementRevision === undefined
      ? { ...decision, reason: "declined" }
      : null;
  return reason === "revised" && isPositiveInteger(replacementRevision)
    ? { ...decision, reason: "revised", replacementRevision }
    : null;
}

function memorySubmission(raw: unknown): raw is MemorySubmission {
  return raw === "own_input" || raw === "shared_review";
}

function revisionStateKind(raw: unknown): raw is MemoryRevisionState["kind"] {
  return (
    raw === "candidate" ||
    raw === "accepted" ||
    raw === "rejected" ||
    raw === "superseded" ||
    raw === "revoked"
  );
}

function identifier(raw: unknown): raw is string {
  return (
    typeof raw === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:_./-]{0,199}$/u.test(raw)
  );
}

function timezone(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64)
    return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return true;
  } catch {
    return false;
  }
}

function calendarDate(raw: unknown): raw is string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(raw))
    return false;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw
  );
}

/**
 * The identifier, time zone and evidence forms Memory accepts, for records
 * that are reviewed the same way.
 */
export {
  identifier as isReviewedRecordId,
  timezone as isIanaTimezone,
  parseEvidenceList as parseMemoryEvidenceList,
};
