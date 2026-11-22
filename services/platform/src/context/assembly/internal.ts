import { nativeChatAudience } from "./native-chat-audience";
import { isAuthorizedContextRead } from "../turn-context";
import type {
  ContextProjectionSearchResult,
  ContextVisibility as ProjectionContextVisibility,
} from "../projection";
import type { Result } from "@purin-labs/kernel/result";
import {
  digestContextBundle,
  materializeContextBundle,
  memoryObservationRecordId,
  normalizeContextQuery,
  type AuthorizedContextRead,
  type CaseContextReplayAuthority,
  type CaseContextTailCandidate,
  type ContextAssemblyError,
  type ContextAssemblyResult,
  type ContextAssemblyScope,
  type ContextReadFields,
  type TurnMemoryRead,
} from "./index";
import {
  decideAutomaticContextAdmission,
  FlowLabel,
  ObservationEvidence,
} from "../../policy";
import type { FlowRecipient } from "../../policy/information-flow/types";
import { assertNever } from "@purin-labs/std";
import type {
  CanonicalContextSourceRef,
  ContextBundle,
  ContextBundleDisposition,
  ContextFreshness,
  ContextItem,
  ContextMemoryOutcome,
  ContextProjectionRevision,
  ContextProjectionProvenance,
  ContextRetrievalEvidence,
  Sha256Digest,
  Timestamp,
} from "./types";
import type { ContextVisibility } from "../../authorization/access-grants/types";

type AssemblyCandidate = {
  readonly organisationId: string;
  readonly source: CanonicalContextSourceRef;
  readonly provenance: ContextProjectionProvenance;
  readonly sourceRevision: ContextProjectionRevision;
  readonly contentDigest: Sha256Digest;
  readonly boundedExcerpt: string;
  readonly inputLabel: FlowLabel;
  readonly observedAt: Timestamp;
  readonly indexedAt: Timestamp;
  readonly retrievalEvidence: ContextRetrievalEvidence;
  readonly fromTail: boolean;
  readonly replayAuthority: CaseContextReplayAuthority | null;
};

/**
 * The two reads of a workspace assembly, started before the permit exists.
 * `fields` names the exact fields they were started with.
 */
export type StartedContextReads = {
  readonly fields: ContextReadFields;
  readonly projection: Promise<readonly ContextProjectionSearchResult[]>;
  readonly tail: Promise<readonly CaseContextTailCandidate[]>;
};

/**
 * Start the projection search and the tail read of a workspace assembly.
 *
 * The gate checks the turn's authority again before it gives a permit, and
 * that check waits for the database. The two reads take only the fields of
 * the read, which the check does not change, so the gate starts them first
 * and they share the wait. The gate gives their results to the assembler only
 * with a permit. A gate that gives no permit drops them.
 */
export function startWorkspaceContextReads(
  fields: ContextReadFields,
): StartedContextReads {
  const projection = searchWorkspaceProjections(fields);
  const tail = readCaseTail(fields);
  // A dropped read must not leave a rejection unhandled.
  projection.catch(ignoreDroppedRead);
  tail.catch(ignoreDroppedRead);
  return { fields, projection, tail };
}

function ignoreDroppedRead(): void {}

type ContextReadRequestFields = Pick<
  ContextReadFields,
  | "organisationId"
  | "caseId"
  | "authorityPartitionDigest"
  | "contextVisibility"
  | "query"
  | "itemLimit"
  | "projectionReader"
  | "tailReader"
>;

function searchWorkspaceProjections(
  fields: ContextReadRequestFields,
): Promise<readonly ContextProjectionSearchResult[]> {
  return fields.projectionReader.search({
    organisationId: fields.organisationId,
    visibility: fields.contextVisibility.map(toProjectionVisibility),
    sourceKind: "all",
    authorityPartitionDigest: fields.authorityPartitionDigest,
    query: fields.query,
    limit: fields.itemLimit,
  });
}

function readCaseTail(
  fields: ContextReadRequestFields,
): Promise<readonly CaseContextTailCandidate[]> {
  return fields.tailReader.readTail({
    organisationId: fields.organisationId,
    caseId: fields.caseId,
    authorityPartitionDigest: fields.authorityPartitionDigest,
    visibility: fields.contextVisibility,
    limit: fields.itemLimit,
  });
}

/**
 * This module is reachable only by the authorized turn-context gate. The
 * permit contains the current authority and retrieval bounds. `started` holds
 * the reads that the gate started for this permit's own fields.
 */
export async function assembleAuthorizedContext(
  permit: AuthorizedContextRead,
  scope: ContextAssemblyScope,
  started: StartedContextReads | null = null,
): Promise<Result<ContextAssemblyResult, ContextAssemblyError>> {
  if (
    !isAuthorizedContextRead(permit) ||
    permit.contextVisibility.length === 0 ||
    permit.itemLimit <= 0 ||
    permit.tokenLimit <= 0 ||
    permit.timeLimitMs <= 0 ||
    permit.freshnessBoundMs <= 0 ||
    permit.assembledAt < 0
  ) {
    return { ok: false, error: { code: "invalid_candidate" } };
  }

  const startedAt = Date.now();
  let projectionRead: Promise<readonly ContextProjectionSearchResult[]>;
  let tailRead: Promise<readonly CaseContextTailCandidate[]>;
  let memoryReadPromise: Promise<BoundedTurnMemoryRead>;
  switch (scope) {
    case "case":
      projectionRead = Promise.resolve([]);
      tailRead = started === null ? readCaseTail(permit) : started.tail;
      memoryReadPromise = Promise.resolve({
        kind: "read",
        candidates: [],
        more: false,
      });
      break;
    case "workspace":
      projectionRead =
        started === null
          ? searchWorkspaceProjections(permit)
          : started.projection;
      tailRead = started === null ? readCaseTail(permit) : started.tail;
      memoryReadPromise = readTurnMemory(permit);
      break;
    default:
      return assertNever(scope);
  }
  const [projection, tail, memoryRead] = await Promise.allSettled([
    projectionRead,
    tailRead,
    memoryReadPromise,
  ]);
  if (tail.status === "rejected") {
    return { ok: false, error: { code: "tail_unavailable" } };
  }
  // The canonical tail remains authoritative when the projection is unavailable.
  const projectionResults =
    projection.status === "fulfilled" ? projection.value : [];

  const candidates = await collectCandidates(
    permit,
    projectionResults,
    tail.value,
  );
  const ranked = [...candidates].sort(compareCandidates);
  // Memory is selected first and keeps the hard item and token limits. Every
  // revision those limits omit is recorded, never dropped silently.
  const memoryResult =
    memoryRead.status === "fulfilled"
      ? memoryRead.value
      : ({ kind: "unavailable", reason: "read_failed" } as const);
  // Memory that fails verification is a fault. It is not reported as absent
  // or as merely unavailable.
  if (memoryResult.kind === "invalid_state")
    return { ok: false, error: { code: "memory_state_invalid" } };
  const memory = await selectTurnMemory(permit, memoryResult);
  const selected = selectCandidates(permit, ranked, startedAt, memory.usage);
  const admitted = await admitCandidates(selected.items);
  const bundle = buildContextBundle(
    permit,
    memory,
    admitted,
    selected.disposition,
  );
  const bundleDigest = await digestContextBundle(bundle);
  return {
    ok: true,
    value: {
      bundle,
      bundleDigest,
      modelContext: materializeContextBundle(bundle),
    },
  };
}

async function collectCandidates(
  permit: AuthorizedContextRead,
  projections: readonly ContextProjectionSearchResult[],
  tails: readonly CaseContextTailCandidate[],
): Promise<readonly AssemblyCandidate[]> {
  // Both readers apply the permit's item limit. Authorize their bounded results
  // independently, then retain source order when resolving duplicate entries.
  const pending: Promise<AssemblyCandidate | null>[] = [];
  for (const result of projections) {
    if (result.projection.organisationId !== permit.organisationId) continue;
    pending.push(admitCandidate(permit, projectionCandidate(result)));
  }
  for (const tail of tails) {
    if (
      tail.organisationId !== permit.organisationId ||
      tail.source.kind !== "case_entry" ||
      tail.source.caseId !== permit.caseId
    )
      continue;
    pending.push(admitCandidate(permit, tailCandidate(permit, tail)));
  }
  const candidates = await Promise.all(pending);
  const byKey = new Map<string, AssemblyCandidate>();
  for (const candidate of candidates) {
    if (candidate === null) continue;
    // Canonical history retains its tail status when a projection duplicates it.
    byKey.set(candidateKey(candidate), candidate);
  }
  return [...byKey.values()];
}

async function admitCandidate(
  permit: AuthorizedContextRead,
  pending: Promise<AssemblyCandidate | null>,
): Promise<AssemblyCandidate | null> {
  const candidate = await pending;
  if (candidate === null || !(await candidateIsAdmitted(permit, candidate)))
    return null;
  return candidate;
}

async function projectionCandidate(
  result: ContextProjectionSearchResult,
): Promise<AssemblyCandidate | null> {
  const projection = result.projection;
  const inputLabel = await FlowLabel.restore(projection.inputLabel);
  if (!inputLabel.ok) return null;
  return {
    organisationId: projection.organisationId,
    source: projection.source,
    provenance: projection.provenance,
    sourceRevision: projection.sourceRevision,
    contentDigest: projection.contentDigest,
    // The model sees the whole message; retrieval scored the authored text.
    boundedExcerpt: projection.modelText,
    inputLabel: inputLabel.value,
    observedAt: projection.indexedAt,
    indexedAt: projection.indexedAt,
    retrievalEvidence: result.retrievalEvidence,
    fromTail: false,
    replayAuthority:
      "replayAuthority" in projection ? projection.replayAuthority : null,
  };
}

async function tailCandidate(
  permit: AuthorizedContextRead,
  tail: CaseContextTailCandidate,
): Promise<AssemblyCandidate | null> {
  const inputLabel = await FlowLabel.restore(tail.inputLabel);
  if (!inputLabel.ok) return null;
  return {
    organisationId: tail.organisationId,
    source: tail.source,
    provenance: { kind: "case_entry" },
    sourceRevision: tail.sourceRevision,
    contentDigest: tail.contentDigest,
    boundedExcerpt: tail.boundedExcerpt,
    inputLabel: inputLabel.value,
    observedAt: tail.observedAt,
    indexedAt: tail.observedAt,
    retrievalEvidence: buildRetrievalEvidence(
      permit.query,
      tail.boundedExcerpt,
      tail.observedAt,
    ),
    fromTail: true,
    replayAuthority: tail.replayAuthority,
  };
}

async function candidateIsAdmitted(
  permit: AuthorizedContextRead,
  candidate: AssemblyCandidate,
): Promise<boolean> {
  if (!candidateReplayAuthorityMatches(permit, candidate)) return false;
  if (!candidateIsTrusted(candidate)) return false;
  return labelIsAdmitted(permit, candidate.inputLabel, null);
}

/**
 * Whether this turn's own authority may be shown content under `label`.
 * `recipient` is the verified recipient the turn's output is bound to, for
 * content that may be bound to one.
 */
async function labelIsAdmitted(
  permit: AuthorizedContextRead,
  inputLabel: FlowLabel,
  recipient: FlowRecipient | null,
): Promise<boolean> {
  const audience =
    permit.requestAuthority.kind === "control"
      ? await nativeChatAudience.use()(
          permit.db,
          permit.turnAuthority.accountAccess,
          permit.requestAuthority,
          inputLabel,
        )
      : null;
  if (permit.requestAuthority.kind === "control" && audience === null)
    return false;
  const subject =
    permit.requestAuthority.kind === "control" && audience !== null
      ? {
          kind: "native_chat" as const,
          requestAuthority: permit.requestAuthority,
          caseId: permit.caseId,
          audience,
        }
      : {
          kind: "authority_derived" as const,
          requestAuthority: permit.requestAuthority,
          caseId: permit.caseId,
        };
  const decision = await decideAutomaticContextAdmission({
    subject,
    inputLabel,
    recipient,
  });
  return decision.kind === "admit";
}

function candidateReplayAuthorityMatches(
  permit: AuthorizedContextRead,
  candidate: AssemblyCandidate,
): boolean {
  if (candidate.replayAuthority === null) {
    return candidate.source.kind === "file_segment";
  }
  switch (candidate.replayAuthority.kind) {
    case "partition_independent":
      return true;
    case "authority_partition":
      return (
        candidate.replayAuthority.authorityPartitionDigest ===
        permit.authorityPartitionDigest
      );
  }
}

function candidateIsTrusted(
  candidate: Pick<AssemblyCandidate, "inputLabel" | "organisationId">,
): boolean {
  if (
    !(candidate.inputLabel instanceof FlowLabel) ||
    candidate.inputLabel.policies.length === 0
  ) {
    return false;
  }
  return candidate.inputLabel.policies.every((policy) => {
    switch (policy.owner.kind) {
      case "platform":
        return true;
      case "organisation":
      case "integration_resource":
      // A recipient constraint of this organisation only narrows who the
      // content may reach. Admission still requires that exact recipient.
      case "recipient_constraint":
        return policy.owner.organisationId === candidate.organisationId;
    }
  });
}

type BoundedTurnMemoryRead =
  | Exclude<TurnMemoryRead, { kind: "unavailable" }>
  | Readonly<{ kind: "unavailable"; reason: "deadline" | "read_failed" }>;

/**
 * Reads Memory within its own deadline. A read that fails or runs late is
 * reported as unavailable; its eventual result is discarded.
 */
async function readTurnMemory(
  permit: AuthorizedContextRead,
): Promise<BoundedTurnMemoryRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<BoundedTurnMemoryRead>((resolve) => {
    timer = setTimeout(resolve, permit.memoryDeadlineMs, {
      kind: "unavailable",
      reason: "deadline",
    } as const);
  });
  const unavailable = { kind: "unavailable", reason: "read_failed" } as const;
  try {
    return await Promise.race([
      permit.memoryReader
        .read({
          limit: permit.itemLimit,
          admits: memoryLabelIsAdmitted.bind(null, permit),
        })
        .then(
          (read): BoundedTurnMemoryRead =>
            read.kind === "unavailable" ? unavailable : read,
          (): BoundedTurnMemoryRead => unavailable,
        ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether this turn's own authority may be shown Memory under `label`. */
async function memoryLabelIsAdmitted(
  permit: AuthorizedContextRead,
  inputLabel: FlowLabel,
): Promise<boolean> {
  return (
    candidateIsTrusted({ inputLabel, organisationId: permit.organisationId }) &&
    (await labelIsAdmitted(permit, inputLabel, permit.replyRecipient))
  );
}

type SelectedTurnMemory = Readonly<{
  items: readonly ContextItem[];
  outcome: ContextMemoryOutcome;
  usage: Readonly<{ items: number; estimatedTokens: number }>;
}>;

const NO_TURN_MEMORY_USAGE = { items: 0, estimatedTokens: 0 } as const;

/**
 * Admits each offered revision against this turn's authority, then selects
 * within the item and token limits. A revision this turn may not be shown is
 * treated as absent. One a limit omits makes the outcome `limited`.
 */
async function selectTurnMemory(
  permit: AuthorizedContextRead,
  read: Exclude<BoundedTurnMemoryRead, { kind: "invalid_state" }>,
): Promise<SelectedTurnMemory> {
  if (read.kind !== "read")
    return { items: [], outcome: read, usage: NO_TURN_MEMORY_USAGE };
  const items: ContextItem[] = [];
  let estimatedTokens = 0;
  // The reader found a further revision this turn may be shown.
  let limit: "items" | "tokens" | null = read.more ? "items" : null;
  let budgetExhausted = false;
  const seen = new Set<string>();
  for (const candidate of read.candidates) {
    if (
      candidate.organisationId !== permit.organisationId ||
      seen.has(candidate.memoryId)
    )
      continue;
    const inputLabel = await FlowLabel.restore(candidate.inputLabel);
    // The reader asked the same question before it counted this revision.
    // The assembler asks again because it, not the reader, is the gate.
    if (
      !inputLabel.ok ||
      !(await memoryLabelIsAdmitted(permit, inputLabel.value))
    )
      continue;
    seen.add(candidate.memoryId);
    if (budgetExhausted) continue;
    if (items.length >= permit.itemLimit) {
      limit = "items";
      budgetExhausted = true;
      continue;
    }
    const tokens = estimateTokens(candidate.boundedExcerpt);
    if (estimatedTokens + tokens > permit.tokenLimit) {
      limit = "tokens";
      budgetExhausted = true;
      continue;
    }
    const evidence = await ObservationEvidence.create({
      source: {
        kind: "organisation_record",
        organisationId: candidate.organisationId,
        recordId: memoryObservationRecordId(candidate.memoryId),
      },
      sourceRevision: candidate.revision,
      contentDigest: candidate.contentDigest,
      inputLabel: inputLabel.value,
      observedAt: candidate.acceptedAt,
    });
    // A revision that cannot be recorded as an observation is not shown.
    if (!evidence.ok)
      return {
        items: [],
        outcome: { kind: "unavailable", reason: "read_failed" },
        usage: NO_TURN_MEMORY_USAGE,
      };
    items.push({
      source: {
        kind: "memory",
        memoryId: candidate.memoryId,
        revision: candidate.revision,
      },
      provenance: { kind: "memory" },
      sourceRevision: candidate.revision,
      contentDigest: candidate.contentDigest,
      boundedExcerpt: candidate.boundedExcerpt,
      inputLabel: inputLabel.value,
      observationEvidence: evidence.value,
      observedAt: candidate.acceptedAt,
      freshness: { kind: "fresh" },
      retrievalEvidence: buildRetrievalEvidence(
        permit.query,
        candidate.boundedExcerpt,
        candidate.acceptedAt,
      ),
    });
    estimatedTokens += tokens;
  }
  const revisions = items.map(memoryItemRef);
  const usage = { items: items.length, estimatedTokens };
  if (limit !== null)
    return {
      items,
      outcome: { kind: "limited", revisions, reason: limit },
      usage,
    };
  return {
    items,
    outcome:
      revisions.length === 0
        ? { kind: "none" }
        : { kind: "admitted", revisions },
    usage,
  };
}

function memoryItemRef(item: ContextItem): {
  memoryId: string;
  revision: number;
} {
  if (item.source.kind !== "memory")
    throw new Error("memory item does not have a memory source");
  return { memoryId: item.source.memoryId, revision: item.source.revision };
}

async function admitCandidates(
  candidates: readonly AssemblyCandidate[],
): Promise<readonly AdmittedCandidate[]> {
  const admitted: AdmittedCandidate[] = [];
  for (const candidate of candidates) {
    const evidenceSource = observationSource(candidate);
    const evidence = await ObservationEvidence.create({
      source: evidenceSource,
      sourceRevision: candidate.sourceRevision,
      contentDigest: candidate.contentDigest,
      inputLabel: candidate.inputLabel,
      observedAt: candidate.observedAt,
    });
    if (!evidence.ok) continue;
    admitted.push({ candidate, observationEvidence: evidence.value });
  }
  return admitted;
}

function observationSource(
  candidate: AssemblyCandidate,
): ObservationEvidence["source"] {
  switch (candidate.provenance.kind) {
    case "case_entry":
      if (candidate.source.kind !== "case_entry") {
        throw new Error("case context provenance does not match its source");
      }
      return candidate.source;
    case "integration_file":
      if (
        candidate.source.kind !== "file_segment" ||
        candidate.source.integrationAccountId !==
          candidate.provenance.integrationAccountId ||
        candidate.source.provider !== candidate.provenance.provider
      ) {
        throw new Error("file context provenance does not match its source");
      }
      return {
        kind: "integration_resource",
        organisationId: candidate.organisationId,
        integrationAccountId: candidate.provenance.integrationAccountId,
        resourceScope: candidate.provenance.resourceScope,
      };
  }
}

type AdmittedCandidate = {
  readonly candidate: AssemblyCandidate;
  readonly observationEvidence: ObservationEvidence;
};

function selectCandidates(
  permit: AuthorizedContextRead,
  candidates: readonly AssemblyCandidate[],
  startedAt: number,
  used: Readonly<{ items: number; estimatedTokens: number }>,
): {
  readonly items: readonly AssemblyCandidate[];
  readonly disposition: ContextBundleDisposition;
} {
  const items: AssemblyCandidate[] = [];
  const caseExcerpts = new Set<string>();
  let estimatedTokens = used.estimatedTokens;
  let disposition: ContextBundleDisposition = { kind: "complete" };
  for (const candidate of candidates) {
    if (
      candidate.source.kind === "case_entry" &&
      caseExcerpts.has(candidate.boundedExcerpt)
    )
      continue;
    // Retrieval latency must not erase already-authorized canonical history.
    if (!candidate.fromTail && Date.now() - startedAt >= permit.timeLimitMs) {
      disposition = { kind: "truncated", limitingDimension: "time" };
      continue;
    }
    if (used.items + items.length >= permit.itemLimit) {
      return {
        items,
        disposition: { kind: "truncated", limitingDimension: "items" },
      };
    }
    const candidateTokens = estimateTokens(candidate.boundedExcerpt);
    if (estimatedTokens + candidateTokens > permit.tokenLimit) {
      return {
        items,
        disposition: { kind: "truncated", limitingDimension: "tokens" },
      };
    }
    items.push(candidate);
    if (candidate.source.kind === "case_entry")
      caseExcerpts.add(candidate.boundedExcerpt);
    estimatedTokens += candidateTokens;
  }
  return { items, disposition };
}

function buildContextBundle(
  permit: AuthorizedContextRead,
  memory: SelectedTurnMemory,
  candidates: readonly AdmittedCandidate[],
  disposition: ContextBundleDisposition,
): ContextBundle {
  const items: ContextItem[] = [...memory.items];
  let estimatedTokens = memory.usage.estimatedTokens;
  for (const admitted of candidates) {
    const candidate = admitted.candidate;
    items.push({
      source: candidate.source,
      provenance: candidate.provenance,
      sourceRevision: candidate.sourceRevision,
      contentDigest: candidate.contentDigest,
      boundedExcerpt: candidate.boundedExcerpt,
      inputLabel: candidate.inputLabel,
      observationEvidence: admitted.observationEvidence,
      observedAt: candidate.observedAt,
      freshness: buildFreshness(permit, candidate),
      retrievalEvidence: candidate.retrievalEvidence,
    });
    estimatedTokens += estimateTokens(candidate.boundedExcerpt);
  }
  return {
    organisationId: permit.organisationId,
    caseId: permit.caseId,
    assignmentId: permit.assignmentId,
    sessionId: permit.sessionId,
    policyVersion: permit.policyVersion,
    assemblyStrategyVersion: permit.assemblyStrategyVersion,
    assembledAt: permit.assembledAt,
    items,
    usage: { items: items.length, estimatedTokens },
    disposition,
    memory: memory.outcome,
  };
}

function buildFreshness(
  permit: AuthorizedContextRead,
  candidate: AssemblyCandidate,
): ContextFreshness {
  const ageMs = Math.max(0, permit.assembledAt - candidate.indexedAt);
  if (ageMs <= permit.freshnessBoundMs) return { kind: "fresh" };
  return {
    kind: "stale",
    ageMs,
    reason: candidate.fromTail
      ? "tail_age_exceeded"
      : "projection_age_exceeded",
  };
}

function buildRetrievalEvidence(
  query: string,
  excerpt: string,
  observedAt: Timestamp,
): ContextRetrievalEvidence {
  const normalizedQuery = normalizeContextQuery(query);
  const normalizedExcerpt = normalizeContextQuery(excerpt);
  const queryTokens =
    normalizedQuery.length === 0 ? [] : normalizedQuery.split(" ");
  const excerptTokens = new Set(
    normalizedExcerpt.length === 0 ? [] : normalizedExcerpt.split(" "),
  );
  let overlap = 0;
  for (const token of queryTokens) if (excerptTokens.has(token)) overlap += 1;
  const tokenOverlapMillionths =
    queryTokens.length === 0
      ? 0
      : Math.floor((overlap * 1_000_000) / queryTokens.length);
  return {
    exactPhraseMatch:
      normalizedQuery.length > 0 && normalizedExcerpt.includes(normalizedQuery),
    tokenOverlapMillionths,
    recencyRank: observedAt,
  };
}

function compareCandidates(
  left: AssemblyCandidate,
  right: AssemblyCandidate,
): number {
  const exact =
    Number(right.retrievalEvidence.exactPhraseMatch) -
    Number(left.retrievalEvidence.exactPhraseMatch);
  if (exact !== 0) return exact;
  const overlap =
    right.retrievalEvidence.tokenOverlapMillionths -
    left.retrievalEvidence.tokenOverlapMillionths;
  if (overlap !== 0) return overlap;
  const recency =
    right.retrievalEvidence.recencyRank - left.retrievalEvidence.recencyRank;
  if (recency !== 0) return recency;
  const identity = candidateKey(left).localeCompare(candidateKey(right));
  if (identity !== 0) return identity;
  return Number(left.fromTail) - Number(right.fromTail);
}

function candidateKey(
  candidate: Pick<
    AssemblyCandidate,
    "source" | "sourceRevision" | "contentDigest"
  >,
): string {
  switch (candidate.source.kind) {
    case "case_entry":
      return `case_entry:${candidate.source.caseId}:${candidate.source.entryId}:${candidate.sourceRevision}`;
    case "file_segment":
      return (
        `file_segment:${candidate.source.integrationAccountId}:${candidate.source.provider}:` +
        `${candidate.source.providerFileId}:${candidate.source.segmentIndex}:${candidate.sourceRevision}`
      );
  }
}

function estimateTokens(text: string): number {
  // UTF-8 bytes retain the cost of IDs, JSON punctuation and non-Latin text.
  return Math.ceil(new TextEncoder().encode(text).byteLength / 3);
}

function toProjectionVisibility(
  visibility: ContextVisibility,
): ProjectionContextVisibility {
  switch (visibility.kind) {
    case "organisation_role":
      return { kind: "organisation_role", role: visibility.role };
    case "person":
      return { kind: "person", personId: visibility.personId };
    case "conversation":
      return {
        kind: "conversation",
        integrationAccountId: visibility.integrationAccountId,
        conversationId: visibility.conversationId,
      };
    case "case":
      return { kind: "case", caseId: visibility.caseId };
    case "workflow":
      return {
        kind: "workflow",
        workflowKind: "cue_subscription",
        workflowId: visibility.workflowId,
        workflowRevision: visibility.workflowRevision,
      };
    case "agent_mailbox":
      return {
        kind: "agent_mailbox",
        integrationAccountId: visibility.integrationAccountId,
        mailboxBindingId: visibility.mailboxBindingId,
        bindingRevision: visibility.bindingRevision,
      };
    case "whatsapp_support":
      return {
        kind: "whatsapp_support",
        integrationAccountId: visibility.integrationAccountId,
        supportBindingId: visibility.supportBindingId,
        bindingRevision: visibility.bindingRevision,
      };
  }
}
