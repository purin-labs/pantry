import {
  organisationAccessOfOneRead,
  type AuthorizedConversationScope,
} from "@purin-labs/tenancy/organisation-access/access";
import { parseMemoryCommand } from "@purin-labs/control-api";
import type {
  MemoryApplicability,
  MemoryCommand,
  MemoryCommandErrorCode,
  MemoryCommandReceipt,
  MemoryEvidence,
  MemoryRevisionView,
  MemoryValidity,
  MemoryView,
} from "@purin-labs/control-api";
import type { RequestAuthority } from "@purin-labs/contracts";
import { assertNever, canonicalJson, parseJsonOrNull } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";

import {
  requireActiveOrganisationActorAtPlacement,
  requireActiveOrganisationActorAtScope,
  resolveActiveCaseActorAtPlacement,
  resolveActiveConnectorActorAtPlacement,
  type ActorResolutionError,
} from "../actors/actor-router";
import {
  authorizeCapabilityUse,
  compileTurnAuthority,
  CONTEXT_CASE_READ_CAPABILITY,
} from "../authorization/access-grants/turn-authority";
import { readChatControlAuthority } from "../chat/information-flow";
import type {
  TurnMemoryCandidate,
  TurnMemoryRead,
  TurnMemoryReader,
  TurnMemoryReadRequest,
} from "../context/assembly";
import { gmailConnectorId } from "../mail-inbox/contract/connector-ids";
import type { Env } from "@purin-labs/kernel/env";
import type { CaseActorStub, OrganisationActorStub } from "../actors/actor-stubs";
import {
  parseCaseId,
  parseIntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { readCurrentOrganisationPolicySnapshot } from "../policy-snapshot";
import {
  canonicalFlowLabel,
  createCurrentSourceFlowLabel,
  digestCanonical,
  FlowBinding,
  FlowLabel,
  joinFlowLabels,
} from "../policy/information-flow";
import type { Result } from "@purin-labs/kernel/result";
import { memberMaySee } from "../chat/member-view";
import {
  readNoTurnMemory,
  type ShownMemoryRevision,
} from "./contract/turn-memory";
import {
  entityRefOrNull,
  memoryApplicabilityKey,
  restoreAcceptedMemory,
  restoreSerializedMemory,
  type AcceptedMemoryCursor,
  type Memory,
  type MemoryRevision,
  type SerializedAcceptedMemory,
} from "./store";

export type MemoryAccessError = Readonly<{
  code:
    | MemoryCommandErrorCode
    /** A cited record has no recorded provenance this boundary can verify. */
    | "memory_evidence_unsupported";
}>;

/**
 * A signed-in person whose live authority may read accepted Case context. It
 * says nothing yet about any one Memory: every revision's label and every
 * cited record is still checked against this person. The Evals boundary
 * reviews its records for the same person the same way.
 */
export type MemoryViewer = RecordScope &
  Readonly<{
    scope: AuthorizedConversationScope;
    authority: Variant<RequestAuthority, "control">;
  }>;

/** Where a cited record is read from. */
export type RecordScope = Readonly<{
  env: Env;
  organisationId: OrganisationId;
  execution: OrganisationExecutionScope;
}>;

/**
 * What one turn concerns. A Memory applies only when its scope names one of
 * these exactly: a skill the turn loaded, a commerce resource class it reads,
 * or the commerce entity it is about.
 */
type TurnMemorySubjects = Readonly<{
  applicability: readonly MemoryApplicability[];
}>;

/** One cited record as its owner recorded it. */
type CitedRecord = Readonly<{
  label: FlowLabel;
  contentKind: string;
  authorPersonId: string | null;
}>;

/**
 * Why a cited record did not resolve. `missing` is a known fact about the
 * record: it is gone or no longer has the cited content. `unreadable` is a
 * failed lookup, which establishes nothing about the record.
 */
type CitedRecordError = Readonly<{
  code: "invalid" | "missing" | "unreadable" | "unsupported";
}>;

/** Whether a turn's destination audience may receive content under a label. */
export type TurnMemoryDestination = (
  label: FlowLabel,
) => Promise<"allow" | "deny" | "unavailable">;

/** How many accepted revisions one Actor read returns. */
export const TURN_MEMORY_PAGE = 32;

/**
 * Every Memory this person may inspect in full. A Memory with any revision or
 * cited record hidden from them is absent, so the list's length, order and
 * head revisions reveal nothing about what was withheld.
 */
export async function readMemoryViews(
  env: Env,
  scope: AuthorizedConversationScope,
  execution?: OrganisationExecutionScope,
): Promise<Result<readonly MemoryView[], MemoryAccessError>> {
  const viewer = await resolveMemoryViewer(env, scope, execution);
  if (viewer === null) return failure("memory_unavailable");
  const organisation = await organisationActor(viewer);
  const stored = await organisation.readMemories({
    organisationId: scope.organisationId,
  });
  if (!stored.ok) return failure("memory_unavailable");
  const review = createReviewMemo();
  const views = await reviewTogether(stored.value, async (serialized) => {
    const memory = await restoreSerializedMemory(
      scope.organisationId,
      serialized,
    );
    // A record that fails verification is withheld like a hidden one.
    return memory !== null && (await viewerMayInspect(viewer, memory, review))
      ? memoryView(memory)
      : null;
  });
  return { ok: true, value: views };
}

/**
 * How many Memories wait for this person's decision: those whose newest
 * revision is a candidate and that the person may inspect in full. It is a
 * count over the list that `readMemoryViews` returns for the same person, so
 * it reveals nothing that the list withholds. Null is a failed read, which
 * decides nothing.
 */
export async function countMemoriesToReview(
  viewer: MemoryViewer,
  organisation: OrganisationActorStub,
  review: ReviewMemo,
): Promise<number | null> {
  const stored = await organisation.readMemories({
    organisationId: viewer.scope.organisationId,
  });
  if (!stored.ok) return null;
  const waiting = await reviewTogether(stored.value, async (serialized) => {
    const memory = await restoreSerializedMemory(
      viewer.scope.organisationId,
      serialized,
    );
    return memory !== null &&
      memory.revisions.at(-1)?.kind === "candidate" &&
      (await viewerMayInspect(viewer, memory, review))
      ? memory.memoryId
      : null;
  });
  return waiting.length;
}

/**
 * The answers of one review, each read live one time. A list asks the same
 * question for many records: whether this person may read one label, and
 * what one cited record holds now. An answer lives no longer than the read
 * that asked for it, so it is never carried from one request to another.
 */
export type ReviewMemo = Readonly<{
  labels: Map<string, Promise<boolean>>;
  records: Map<string, ReturnType<typeof citedRecord>>;
  caseActors: Map<string, Promise<Result<CaseActorStub, ActorResolutionError>>>;
}>;

export function createReviewMemo(): ReviewMemo {
  return {
    labels: new Map(),
    records: new Map(),
    caseActors: new Map(),
  };
}

function askOnce<Answer>(
  answers: Map<string, Answer>,
  question: string,
  ask: () => Answer,
): Answer {
  const known = answers.get(question);
  if (known !== undefined) return known;
  const answer = ask();
  answers.set(question, answer);
  return answer;
}

/** How many records of one list are reviewed at the same time. */
const REVIEW_GROUP = 8;

/**
 * Reviews the records of one list in their order, a group at a time, and
 * keeps those that pass. The reviews of one group share their waits.
 */
export async function reviewTogether<Stored, View>(
  stored: readonly Stored[],
  review: (record: Stored) => Promise<View | null>,
): Promise<readonly View[]> {
  const views: View[] = [];
  for (let start = 0; start < stored.length; start += REVIEW_GROUP) {
    const group = await Promise.all(
      stored.slice(start, start + REVIEW_GROUP).map(review),
    );
    for (const view of group) if (view !== null) views.push(view);
  }
  return views;
}

/**
 * The accepted Memory offered to one turn, read through the applicability
 * index. Each Memory contributes at most its accepted revision, and only when
 * that revision applies to the turn, holds today, has every record its
 * validity depends on, and may be received by the turn's destination
 * audience. A candidate or an earlier revision, hidden or not, neither adds
 * nor removes anything here.
 *
 * A known fact excludes a revision: it has expired, a dependency is gone, or
 * the destination is denied. A Memory the destination cannot receive is
 * therefore indistinguishable from one that does not exist. A lookup that
 * fails decides nothing, so the whole read is unavailable. The assembler
 * still admits each revision against the turn's own authority, and the
 * completed turn still passes its delivery check.
 */
export function createTurnMemoryReader(
  input: Readonly<{
    env: Env;
    execution: OrganisationExecutionScope;
    organisationId: OrganisationId;
    subjects: TurnMemorySubjects;
    destinationMayReceive: TurnMemoryDestination;
    now: number;
  }>,
): TurnMemoryReader {
  return { read: readTurnMemory.bind(null, input) };
}

async function readTurnMemory(
  input: Parameters<typeof createTurnMemoryReader>[0],
  request: TurnMemoryReadRequest,
): Promise<TurnMemoryRead> {
  const applicabilityKeys = [
    ...new Set(input.subjects.applicability.map(memoryApplicabilityKey)),
  ];
  if (applicabilityKeys.length === 0) return readNoTurnMemory();
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env: input.env,
    organisationId: input.organisationId,
    placement: input.execution.placement,
    now: Date.now(),
  });
  const candidates: TurnMemoryCandidate[] = [];
  const decided: TurnMemoryDecisions = {
    labels: new Map(),
    records: new Map(),
  };
  let after: AcceptedMemoryCursor | null = null;
  // Every applicable revision is examined. The limit applies only to those
  // this turn may be shown, so a hidden one neither takes a place nor is
  // counted as omitted. The store bounds how many there can be, and the
  // assembler bounds how long this may take.
  for (;;) {
    const page: Awaited<ReturnType<typeof organisation.readAcceptedMemories>> =
      await organisation.readAcceptedMemories({
        organisationId: input.organisationId,
        applicabilityKeys,
        after,
        limit: TURN_MEMORY_PAGE,
      });
    if (!page.ok)
      return page.error.code === "memory_persisted_state_invalid"
        ? { kind: "invalid_state" }
        : { kind: "unavailable" };
    for (const serialized of page.value.accepted) {
      const offered = await offerRevision(input, request, decided, serialized);
      switch (offered.kind) {
        case "excluded":
          continue;
        case "unavailable":
        case "invalid_state":
          return { kind: offered.kind };
        case "offered":
          if (candidates.length >= request.limit)
            return { kind: "read", candidates, more: true };
          candidates.push(offered.candidate);
          continue;
        default:
          return assertNever(offered);
      }
    }
    if (page.value.next === null)
      return { kind: "read", candidates, more: false };
    after = page.value.next;
  }
}

type OfferedRevision =
  | Readonly<{ kind: "offered"; candidate: TurnMemoryCandidate }>
  | Readonly<{ kind: "excluded"; candidate?: never }>
  | Readonly<{ kind: "unavailable"; candidate?: never }>
  | Readonly<{ kind: "invalid_state"; candidate?: never }>;

/**
 * What one read has already decided. Many revisions share a label or cite the
 * same record, and each decision holds for the whole read, so it is made once.
 */
type TurnMemoryDecisions = Readonly<{
  labels: Map<string, "offer" | "excluded" | "unavailable">;
  records: Map<string, "resolved" | "excluded" | "unavailable">;
}>;

/**
 * Decides one accepted revision for one turn. A known fact excludes it. A
 * lookup that fails makes the read unavailable, and a stored revision that
 * fails verification makes it invalid. The label is decided before any cited
 * record is read, so a revision this turn may not be shown costs no lookup
 * in another Actor.
 */
async function offerRevision(
  input: Parameters<typeof createTurnMemoryReader>[0],
  request: TurnMemoryReadRequest,
  decided: TurnMemoryDecisions,
  serialized: SerializedAcceptedMemory,
): Promise<OfferedRevision> {
  const accepted = await restoreAcceptedMemory(serialized);
  if (accepted === null || accepted.revision.kind !== "accepted")
    return { kind: "invalid_state" };
  return offerStoredRevision(
    input,
    request,
    decided,
    accepted.memoryId,
    accepted.revision,
    accepted.revision.acceptance.decidedAt,
  );
}

/** The checks every revision passes before a turn is offered it. */
async function offerStoredRevision(
  input: Parameters<typeof createTurnMemoryReader>[0],
  request: TurnMemoryReadRequest,
  decided: TurnMemoryDecisions,
  memoryId: string,
  revision: MemoryRevision,
  decidedAt: number,
): Promise<OfferedRevision> {
  if (!validityHolds(revision.validity, input.now)) return { kind: "excluded" };
  let label = decided.labels.get(revision.flowLabel.digest);
  if (label === undefined) {
    const destination = await input.destinationMayReceive(revision.flowLabel);
    label =
      destination === "unavailable"
        ? "unavailable"
        : destination === "allow" && (await request.admits(revision.flowLabel))
          ? "offer"
          : "excluded";
    decided.labels.set(revision.flowLabel.digest, label);
  }
  if (label !== "offer") return { kind: label };
  for (const dependency of revision.validity.dependsOn) {
    const key = canonicalJson(dependency);
    let record = decided.records.get(key);
    if (record === undefined) {
      const cited = await citedRecord(input, dependency);
      record = cited.ok
        ? "resolved"
        : cited.error.code === "unreadable"
          ? "unavailable"
          : "excluded";
      decided.records.set(key, record);
    }
    if (record !== "resolved") return { kind: record };
  }
  return {
    kind: "offered",
    candidate: {
      organisationId: input.organisationId,
      memoryId,
      revision: revision.revision,
      boundedExcerpt: memoryExcerpt(revision.statement, revision.validity),
      contentDigest: await digestCanonical({
        statement: revision.statement,
        applicability: revision.applicability,
        validity: revision.validity,
      }),
      inputLabel: canonicalFlowLabel(revision.flowLabel),
      acceptedAt: decidedAt,
    },
  };
}

/**
 * The Memory reader for one eval task. Without a candidate it reads what an
 * ordinary turn with the same subjects reads. With one, the named Memory
 * contributes that candidate revision in place of its accepted revision,
 * under every check an accepted revision passes. The substitution exists in
 * this read alone: the applicability index, every ordinary reader and every
 * later turn still see the accepted revision.
 */
export function createEvalTurnMemoryReader(
  input: Parameters<typeof createTurnMemoryReader>[0] &
    Readonly<{
      candidate: ShownMemoryRevision | null;
      /**
       * Called when the candidate applies to this turn: `true` when it was
       * offered, `false` when this turn may not be shown it.
       */
      onCandidateDecided?: (offered: boolean) => void;
    }>,
): TurnMemoryReader {
  return { read: readEvalTurnMemory.bind(null, input) };
}

async function readEvalTurnMemory(
  input: Parameters<typeof createEvalTurnMemoryReader>[0],
  request: TurnMemoryReadRequest,
): Promise<TurnMemoryRead> {
  const accepted = await readTurnMemory(input, request);
  const named = input.candidate;
  if (named === null || accepted.kind !== "read") return accepted;
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env: input.env,
    organisationId: input.organisationId,
    placement: input.execution.placement,
    now: Date.now(),
  });
  const stored = await organisation.readMemory({
    organisationId: input.organisationId,
    memoryId: named.memoryId,
  });
  if (!stored.ok) return { kind: "unavailable" };
  const memory =
    stored.value === null
      ? null
      : await restoreSerializedMemory(input.organisationId, stored.value);
  const revision = memory?.revisions.find(
    (entry) => entry.revision === named.revision,
  );
  // The run names a candidate under review. Once a person has decided it,
  // there is no such configuration left to try.
  if (revision === undefined || revision.kind !== "candidate")
    return { kind: "unavailable" };
  // Under this configuration the Memory says what its candidate says, so
  // its accepted revision is not shown beside it.
  const others = accepted.candidates.filter(
    (entry) => entry.memoryId !== named.memoryId,
  );
  const scope = memoryApplicabilityKey(revision.applicability);
  if (
    !input.subjects.applicability.some(
      (subject) => memoryApplicabilityKey(subject) === scope,
    )
  )
    return { ...accepted, candidates: others };
  const offered = await offerStoredRevision(
    input,
    request,
    { labels: new Map(), records: new Map() },
    named.memoryId,
    revision,
    revision.proposedAt,
  );
  switch (offered.kind) {
    case "excluded":
      // The candidate applies to this turn and may not be shown to it. A
      // turn without it would try some other configuration than the one the
      // task names, so the read does not complete.
      input.onCandidateDecided?.(false);
      return { kind: "unavailable" };
    case "unavailable":
    case "invalid_state":
      return { kind: offered.kind };
    case "offered":
      input.onCandidateDecided?.(true);
      // The candidate comes first, so a size limit omits other Memory
      // before it.
      return { ...accepted, candidates: [offered.candidate, ...others] };
    default:
      return assertNever(offered);
  }
}

/**
 * Whether Memory a turn was shown may still be relied on. Each revision must
 * still be the accepted revision of its Memory, its validity must cover
 * today, and every record it depends on must still stand. One that was
 * revoked or replaced, that has run out, or whose evidence is gone has
 * changed. A lookup that fails is unavailable, which is no finding either
 * way. The label is not decided here: each surface checks it with the flow
 * the turn recorded.
 */
export async function readShownMemoryStanding(
  input: RecordScope &
    Readonly<{ revisions: readonly ShownMemoryRevision[]; now: number }>,
): Promise<"in_force" | "changed" | "unavailable"> {
  if (input.revisions.length === 0) return "in_force";
  let read;
  try {
    const organisation = await requireActiveOrganisationActorAtPlacement({
      env: input.env,
      organisationId: input.organisationId,
      placement: input.execution.placement,
      now: Date.now(),
    });
    read = await organisation.readAcceptedMemoryRevisions({
      organisationId: input.organisationId,
      memoryIds: [...new Set(input.revisions.map((shown) => shown.memoryId))],
    });
  } catch {
    return "unavailable";
  }
  if (!read.ok) return "unavailable";
  const accepted = new Map<string, MemoryRevision>();
  for (const serialized of read.value) {
    const restored = await restoreAcceptedMemory(serialized);
    if (restored === null) return "unavailable";
    accepted.set(restored.memoryId, restored.revision);
  }
  for (const shown of input.revisions) {
    const current = accepted.get(shown.memoryId);
    if (
      current === undefined ||
      current.kind !== "accepted" ||
      current.revision !== shown.revision ||
      !validityHolds(current.validity, input.now)
    )
      return "changed";
    for (const dependency of current.validity.dependsOn) {
      const cited = await citedRecord(input, dependency);
      if (!cited.ok)
        return cited.error.code === "unreadable" ? "unavailable" : "changed";
    }
  }
  return "in_force";
}

/** Whether `now` falls on a calendar date the rule covers, in its own zone. */
function validityHolds(validity: MemoryValidity, now: number): boolean {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: validity.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
  return (
    today >= validity.effectiveFrom &&
    (validity.effectiveUntil === null || today <= validity.effectiveUntil)
  );
}

function memoryExcerpt(statement: string, validity: MemoryValidity): string {
  const until =
    validity.effectiveUntil === null ? "" : ` until ${validity.effectiveUntil}`;
  return `${statement} (holds from ${validity.effectiveFrom}${until}, ${validity.timezone})`;
}

/**
 * Applies one command for the signed-in person. The request supplies only the
 * command: the principal comes from the live session, and a proposal's label
 * is joined here from its submission context and every record it cites.
 */
export async function commandMemoryAsOperator(
  env: Env,
  scope: AuthorizedConversationScope,
  body: unknown,
): Promise<Result<MemoryCommandReceipt, MemoryAccessError>> {
  const command = parseMemoryCommand(body, entityRefOrNull);
  if (command === null) return failure("memory_invalid");
  const viewer = await resolveMemoryViewer(env, scope);
  if (viewer === null) return failure("memory_unavailable");
  const organisation = await organisationActor(viewer);
  // A person changes only a Memory they may inspect in full, so a command
  // cannot confirm that a hidden one exists.
  let memory: Memory | null = null;
  if (command.memoryId !== null) {
    memory = await inspectableMemory(viewer, organisation, command.memoryId);
    if (memory === null) return failure("memory_unavailable");
  }
  let flowLabel: FlowLabel | null = null;
  if (command.kind === "propose") {
    const joined = await proposalLabel(viewer, command, memory);
    if (!joined.ok) return joined;
    flowLabel = joined.value;
  }
  const result = await organisation.commandMemory({
    organisationId: scope.organisationId,
    principal: {
      kind: "operator",
      personId: viewer.authority.requesterPersonId,
    },
    body: command,
    flowLabel: flowLabel === null ? null : canonicalFlowLabel(flowLabel),
  });
  if (result.ok) return result;
  // An Actor placement or initialization failure says nothing about Memory.
  return failure(
    isMemoryCommandErrorCode(result.error.code)
      ? result.error.code
      : "memory_unavailable",
  );
}

function isMemoryCommandErrorCode(
  code: string,
): code is MemoryCommandErrorCode {
  return (
    code === "memory_invalid" ||
    code === "memory_unavailable" ||
    code === "memory_conflict" ||
    code === "memory_command_conflict" ||
    code === "memory_reviewer_required" ||
    code === "memory_capacity_exceeded"
  );
}

/**
 * `execution` is the scope the request already resolved for this
 * Organisation. Without one, the scope is resolved here.
 */
export async function resolveMemoryViewer(
  env: Env,
  scope: AuthorizedConversationScope,
  execution?: OrganisationExecutionScope,
): Promise<MemoryViewer | null> {
  const resolved =
    execution === undefined || execution.organisationId !== scope.organisationId
      ? await OrganisationExecutionScope.resolve(env, scope.organisationId)
      : ({ ok: true, value: execution } as const);
  if (!resolved.ok) return null;
  const db = resolved.value.database;
  // The live authority and the current policy do not depend on each other.
  const [authority, policy] = await Promise.all([
    readChatControlAuthority(db, scope),
    readCurrentOrganisationPolicySnapshot(db, scope.organisationId),
  ]);
  if (authority === null || !policy.ok) return null;
  // The gate of the request, the turn authority and the capability ask the
  // account the same question. This read asks it one time.
  const accountAccess = organisationAccessOfOneRead(resolved.value.accountAccess);
  const compiled = await compileTurnAuthority({
    db,
    accountAccess,
    userAuthority: scope.accountAuthority,
    action: "disclose",
    organisationId: scope.organisationId,
    requestAuthority: authority,
    policy: policy.value,
  });
  if (!compiled.ok) return null;
  const capability = await authorizeCapabilityUse({
    db,
    accountAccess,
    userAuthority: scope.accountAuthority,
    action: "disclose",
    organisationId: scope.organisationId,
    authority,
    authorityPartition: compiled.value.authorityPartition,
    request: {
      capabilities: [
        {
          kind: "platform_capability",
          capabilityId: CONTEXT_CASE_READ_CAPABILITY,
          capabilityVersion: 1,
        },
      ],
    },
  });
  return capability.ok
    ? {
        env,
        organisationId: scope.organisationId,
        scope,
        execution: resolved.value,
        authority,
      }
    : null;
}

/**
 * A viewer holds the scope of its own request, so the Actor is reserved under
 * that scope and the directory is not read again.
 */
export function organisationActor(
  viewer: MemoryViewer,
): Promise<OrganisationActorStub> {
  return requireActiveOrganisationActorAtScope({
    env: viewer.env,
    scope: viewer.execution,
    now: Date.now(),
  });
}

/**
 * The Memory this person may inspect in full, or null. Null covers a Memory
 * that does not exist and one with anything hidden from them.
 */
export async function inspectableMemory(
  viewer: MemoryViewer,
  organisation: OrganisationActorStub,
  memoryId: string,
): Promise<Memory | null> {
  const stored = await organisation.readMemories({
    organisationId: viewer.scope.organisationId,
  });
  if (!stored.ok) return null;
  const serialized = stored.value.find(
    (candidate) => candidate.memoryId === memoryId,
  );
  if (serialized === undefined) return null;
  const memory = await restoreSerializedMemory(
    viewer.scope.organisationId,
    serialized,
  );
  return memory !== null && (await viewerMayInspect(viewer, memory))
    ? memory
    : null;
}

function viewerMayInspect(
  viewer: MemoryViewer,
  memory: Memory,
  review?: ReviewMemo,
): Promise<boolean> {
  return viewerMayInspectRevisions(
    viewer,
    memory.revisions.map((revision) => ({
      flowLabel: revision.flowLabel,
      evidence: revision.evidence,
      dependsOn: revision.validity.dependsOn,
    })),
    review,
  );
}

/** What one reviewed revision carries that decides who may inspect it. */
type ReviewedRevision = Readonly<{
  flowLabel: FlowLabel;
  evidence: readonly MemoryEvidence[];
  dependsOn: readonly MemoryEvidence[];
}>;

/**
 * Whether this person may inspect every one of `revisions` now: each stored
 * label, and each cited record as it stands today.
 */
export async function viewerMayInspectRevisions(
  viewer: MemoryViewer,
  revisions: readonly ReviewedRevision[],
  memo: ReviewMemo = createReviewMemo(),
): Promise<boolean> {
  // Every check must pass, and none depends on another, so they share their
  // waits. The stored label was joined when the revision was proposed. Each
  // cited record must also still exist and still be readable by this person.
  const checks = await Promise.all(
    revisions.flatMap((revision) => [
      mayReadOnce(viewer, memo, revision.flowLabel),
      ...revision.evidence.map(citedRecordIsReadable.bind(null, viewer, memo)),
    ]),
  );
  return checks.every(Boolean);
}

async function citedRecordIsReadable(
  viewer: MemoryViewer,
  memo: ReviewMemo,
  evidence: MemoryEvidence,
): Promise<boolean> {
  const cited = await askOnce(
    memo.records,
    canonicalJson(evidence),
    citedRecord.bind(null, viewer, evidence, memo.caseActors),
  );
  return cited.ok && mayReadOnce(viewer, memo, cited.value.label);
}

function mayReadOnce(
  viewer: MemoryViewer,
  memo: ReviewMemo,
  label: FlowLabel,
): Promise<boolean> {
  return askOnce(
    memo.labels,
    canonicalJson(canonicalFlowLabel(label)),
    viewerMayRead.bind(null, viewer, label),
  );
}

/**
 * Whether `label` may be shown to this person now: the Portal rule of
 * Plan 27C, which `memberMaySee` holds.
 */
export async function viewerMayRead(
  viewer: MemoryViewer,
  label: FlowLabel,
): Promise<boolean> {
  return memberMaySee(viewer, label);
}

async function proposalLabel(
  viewer: MemoryViewer,
  command: Variant<MemoryCommand, "propose">,
  memory: Memory | null,
): Promise<Result<FlowLabel, MemoryAccessError>> {
  let joined: FlowLabel;
  switch (command.submission) {
    case "own_input": {
      // A private submission carries the person's own live ingress label,
      // whatever the Memory it revises.
      const author = await createCurrentSourceFlowLabel({
        kind: "ingress",
        db: viewer.execution.database,
        authority: viewer.authority,
      });
      if (!author.ok) return failure("memory_unavailable");
      joined = author.value;
      break;
    }
    case "shared_review": {
      // The person chose to edit the candidate under review, or to propose a
      // replacement for the accepted revision. Their words go to that
      // revision's audience, and every restriction it carries stays.
      const head = memory?.revisions.at(-1);
      if (head === undefined) return failure("memory_invalid");
      const inherited =
        head.kind === "candidate"
          ? head
          : memory?.revisions.find((revision) => revision.kind === "accepted");
      if (inherited === undefined) return failure("memory_conflict");
      joined = inherited.flowLabel;
      break;
    }
    default:
      return assertNever(command.submission);
  }
  return joinCitedEvidence(viewer, joined, command.content.evidence);
}

/**
 * Joins the label of every record a person cites onto `base`. Each record
 * must exist and be readable by that person now.
 */
export async function joinCitedEvidence(
  viewer: MemoryViewer,
  base: FlowLabel,
  cites: readonly MemoryEvidence[],
): Promise<Result<FlowLabel, MemoryAccessError>> {
  let joined = base;
  for (const evidence of cites) {
    const cited = await citedRecord(viewer, evidence);
    if (!cited.ok) return failure(citedRecordFailure(cited.error));
    // Citing a record the author cannot read would launder its restrictions.
    if (!(await viewerMayRead(viewer, cited.value.label)))
      return failure("memory_unavailable");
    // Only a readable record's kind is disclosed by this refusal.
    if (
      evidence.kind === "operator_instruction" &&
      (cited.value.contentKind !== "user_message" ||
        cited.value.authorPersonId === null)
    )
      return failure("memory_invalid");
    const next = await joinFlowLabels(joined, cited.value.label);
    if (!next.ok) return failure("memory_invalid");
    joined = next.value;
  }
  return { ok: true, value: joined };
}

/**
 * One cited record, read from the record's owner with its recorded label.
 * A record whose complete provenance this boundary cannot establish is
 * refused instead of being given a reconstructed label.
 */
/**
 * `caseActors` holds the Case Actors that one review already resolved, so
 * records of one Case share its resolution.
 */
export async function citedRecord(
  scope: RecordScope,
  evidence: MemoryEvidence,
  caseActors: ReviewMemo["caseActors"] = new Map(),
): Promise<Result<CitedRecord, CitedRecordError>> {
  switch (evidence.kind) {
    case "case_observation":
    case "operator_instruction": {
      const caseId = parseCaseId(evidence.caseId);
      if (!caseId.ok) return citedFailure("invalid");
      const actor = await askOnce(caseActors, caseId.value, () =>
        resolveActiveCaseActorAtPlacement({
          env: scope.env,
          namespace: scope.env.CASE,
          organisationId: scope.organisationId,
          caseId: caseId.value,
          placement: scope.execution.placement,
          now: Date.now(),
        }),
      );
      if (!actor.ok) return citedFailure("unreadable");
      const source = await actor.value.readMetadata({
        organisationId: scope.organisationId,
        caseId: caseId.value,
        entryId: evidence.entryId,
      });
      if (!source.ok)
        return citedFailure(
          source.error.code === "source_missing" ? "missing" : "unreadable",
        );
      // A rewritten entry no longer supports what was cited.
      if (source.value.contentDigest !== evidence.digest)
        return citedFailure("missing");
      const label = await FlowLabel.restore(source.value.inputLabel);
      return label.ok
        ? {
            ok: true,
            value: {
              label: label.value,
              contentKind: source.value.contentKind,
              authorPersonId: source.value.authorPersonId,
            },
          }
        : citedFailure("unreadable");
    }
    case "proposal_correction":
      return citedCorrection(scope, evidence);
    case "case_context_collection":
      return citedFailure("unsupported");
    default:
      return assertNever(evidence);
  }
}

/**
 * The agent's candidate from one reviewed reply correction.
 *
 * The label joins what the learning turn observed with the correction's own
 * label, so the candidate carries every source the corrected draft drew on.
 * The command identity is derived from the exact correction, so a repeated
 * run proposes nothing new: the same statement returns the first receipt,
 * and a different one is refused and the first candidate stands. An agent
 * cannot decide a candidate.
 */
export async function proposeMemoryFromCorrection(
  input: Readonly<{
    env: Env;
    execution: OrganisationExecutionScope;
    organisationId: OrganisationId;
    agent: Readonly<{
      caseId: string;
      assignmentId: string;
      sessionId: string;
    }>;
    correction: Variant<MemoryEvidence, "proposal_correction">;
    turnLabel: FlowLabel;
    statement: string;
    applicability: MemoryApplicability;
    now: number;
  }>,
): Promise<
  Result<
    Readonly<{
      kind: "proposed" | "already_proposed";
      memoryId: string;
      revision: number;
    }>,
    Readonly<{ code: "memory_evidence_unavailable" | "memory_unavailable" }>
  >
> {
  const cited = await citedRecord(input, input.correction);
  if (!cited.ok)
    return {
      ok: false,
      error: {
        code:
          cited.error.code === "unreadable"
            ? "memory_unavailable"
            : "memory_evidence_unavailable",
      },
    };
  const label = await joinFlowLabels(input.turnLabel, cited.value.label);
  if (!label.ok) return { ok: false, error: { code: "memory_unavailable" } };
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env: input.env,
    organisationId: input.organisationId,
    placement: input.execution.placement,
    now: Date.now(),
  });
  const commandId = `memory_correction_${await digestCanonical({
    integrationAccountId: input.correction.integrationAccountId,
    proposalId: input.correction.proposalId,
    version: input.correction.version,
    digest: input.correction.digest,
  })}`;
  const proposed = await organisation.commandMemory({
    organisationId: input.organisationId,
    principal: { kind: "agent", ...input.agent },
    body: {
      commandId,
      expectedRevision: 0,
      kind: "propose",
      memoryId: null,
      submission: "own_input",
      content: {
        memoryKind: "lesson",
        statement: input.statement,
        applicability: input.applicability,
        validity: {
          // The agent knows no local calendar. The reviewer sets the zone and
          // dates when they edit or replace the candidate.
          timezone: "UTC",
          effectiveFrom: new Date(input.now).toISOString().slice(0, 10),
          effectiveUntil: null,
          dependsOn: [input.correction],
        },
        evidence: [input.correction],
        sourceCaseId: input.correction.caseId,
      },
    } satisfies MemoryCommand,
    flowLabel: canonicalFlowLabel(label.value),
  });
  if (proposed.ok)
    return {
      ok: true,
      value: {
        kind: "proposed",
        memoryId: proposed.value.memoryId,
        revision: proposed.value.revision,
      },
    };
  if (proposed.error.code !== "memory_command_conflict")
    return { ok: false, error: { code: "memory_unavailable" } };
  // An earlier run proposed another wording. That candidate stands.
  const first = await organisation.readMemoryCommandReceipt({
    organisationId: input.organisationId,
    commandId,
  });
  return first.ok && first.value !== null
    ? {
        ok: true,
        value: {
          kind: "already_proposed",
          memoryId: first.value.memoryId,
          revision: first.value.revision,
        },
      }
    : { ok: false, error: { code: "memory_unavailable" } };
}

/** The Case entry that holds a person's message, as a Memory cites it. */
type InstructionEvidence = Readonly<{
  kind: "operator_instruction";
  caseId: string;
  entryId: string;
  digest: string;
}>;

/**
 * The agent's candidate from one instruction that a person gave in a Portal
 * conversation.
 *
 * The candidate cites the Case entry that holds the person's message, and it
 * applies to Portal chats. The entry must be a message that a person's
 * authority admitted: the agent cannot cite its own words or a record. The
 * label joins what the turn observed with the label recorded with that
 * entry, so the candidate reaches no one who could not read the message, and
 * a turn is offered it only where that label may go. The validity depends on
 * the entry, so a message that is erased or rewritten ends what it supports.
 *
 * The command identity is derived from the entry and the statement. A
 * repeated tool call with the same words returns the first candidate, and one
 * message can support several statements. An agent cannot decide a candidate.
 */
export async function proposeMemoryFromInstruction(
  input: Readonly<{
    env: Env;
    execution: OrganisationExecutionScope;
    organisationId: OrganisationId;
    agent: Readonly<{
      caseId: string;
      assignmentId: string;
      sessionId: string;
    }>;
    instruction: InstructionEvidence;
    turnLabel: FlowLabel;
    memoryKind: "fact" | "preference";
    statement: string;
    now: number;
  }>,
): Promise<
  Result<
    Readonly<{
      kind: "proposed" | "already_proposed";
      memoryId: string;
      revision: number;
    }>,
    Readonly<{
      code:
        | "memory_evidence_unavailable"
        | "memory_evidence_invalid"
        | "memory_invalid"
        | "memory_capacity_exceeded"
        | "memory_unavailable";
    }>
  >
> {
  // The agent proposes from the Case that it works in, and from no other.
  if (input.instruction.caseId !== input.agent.caseId)
    return { ok: false, error: { code: "memory_evidence_invalid" } };
  const cited = await citedRecord(input, input.instruction);
  if (!cited.ok)
    return {
      ok: false,
      error: {
        code:
          cited.error.code === "unreadable"
            ? "memory_unavailable"
            : "memory_evidence_unavailable",
      },
    };
  if (
    cited.value.contentKind !== "user_message" ||
    cited.value.authorPersonId === null
  )
    return { ok: false, error: { code: "memory_evidence_invalid" } };
  const label = await joinFlowLabels(input.turnLabel, cited.value.label);
  if (!label.ok) return { ok: false, error: { code: "memory_unavailable" } };
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env: input.env,
    organisationId: input.organisationId,
    placement: input.execution.placement,
    now: Date.now(),
  });
  const commandId = `memory_instruction_${await digestCanonical({
    caseId: input.instruction.caseId,
    entryId: input.instruction.entryId,
    digest: input.instruction.digest,
    statement: input.statement,
  })}`;
  const proposed = await organisation.commandMemory({
    organisationId: input.organisationId,
    principal: { kind: "agent", ...input.agent },
    body: {
      commandId,
      expectedRevision: 0,
      kind: "propose",
      memoryId: null,
      submission: "own_input",
      content: {
        memoryKind: input.memoryKind,
        statement: input.statement,
        applicability: { kind: "portal_chat" },
        validity: {
          // The agent knows no local calendar. The reviewer sets the zone and
          // dates when they edit or replace the candidate.
          timezone: "UTC",
          effectiveFrom: new Date(input.now).toISOString().slice(0, 10),
          effectiveUntil: null,
          dependsOn: [input.instruction],
        },
        evidence: [input.instruction],
        sourceCaseId: input.instruction.caseId,
      },
    } satisfies MemoryCommand,
    flowLabel: canonicalFlowLabel(label.value),
  });
  if (proposed.ok)
    return {
      ok: true,
      value: {
        kind: "proposed",
        memoryId: proposed.value.memoryId,
        revision: proposed.value.revision,
      },
    };
  switch (proposed.error.code) {
    case "memory_invalid":
    case "memory_capacity_exceeded":
      return { ok: false, error: { code: proposed.error.code } };
    case "memory_command_conflict": {
      // The same words were proposed on an earlier day. That candidate stands.
      const first = await organisation.readMemoryCommandReceipt({
        organisationId: input.organisationId,
        commandId,
      });
      return first.ok && first.value !== null
        ? {
            ok: true,
            value: {
              kind: "already_proposed",
              memoryId: first.value.memoryId,
              revision: first.value.revision,
            },
          }
        : { ok: false, error: { code: "memory_unavailable" } };
    }
    default:
      return { ok: false, error: { code: "memory_unavailable" } };
  }
}

/**
 * A reviewed edit of a mail reply draft, as its Connector recorded it. The
 * Connector keeps a record only for an edit whose whole history it holds, so
 * an edit made in Gmail, or built on one, is not there to cite. The label is
 * the proposal's own binding: every source the draft drew on.
 */
async function citedCorrection(
  scope: RecordScope,
  evidence: Variant<MemoryEvidence, "proposal_correction">,
): Promise<Result<CitedRecord, CitedRecordError>> {
  const account = parseIntegrationAccountId(evidence.integrationAccountId);
  const connectorId = account.ok ? gmailConnectorId(account.value) : account;
  if (!connectorId.ok) return citedFailure("invalid");
  const connector = await resolveActiveConnectorActorAtPlacement({
    env: scope.env,
    namespace: scope.env.CONNECTOR,
    organisationId: scope.organisationId,
    connectorId: connectorId.value,
    placement: scope.execution.placement,
    now: Date.now(),
  });
  if (!connector.ok) return citedFailure("unreadable");
  const correction = await connector.value.readEmailReplyCorrection({
    identity: {
      organisationId: scope.organisationId,
      connectorId: connectorId.value,
    },
    proposalId: evidence.proposalId,
    version: evidence.version,
    now: Date.now(),
  });
  if (!correction.ok) return citedFailure("unreadable");
  if (
    correction.value === null ||
    correction.value.caseId !== evidence.caseId ||
    correction.value.bodyDigest !== evidence.digest
  )
    return citedFailure("missing");
  const binding = await FlowBinding.restore(
    parseJsonOrNull(correction.value.flowBindingJson),
  );
  return binding.ok && binding.value.organisationId === scope.organisationId
    ? {
        ok: true,
        value: {
          label: binding.value.flowLabel,
          contentKind: evidence.kind,
          authorPersonId: correction.value.editorPersonId,
        },
      }
    : citedFailure("unreadable");
}

function citedFailure(
  code: CitedRecordError["code"],
): Result<never, CitedRecordError> {
  return { ok: false, error: { code } };
}

// A person learns only that a record they cited is not available to them.
function citedRecordFailure(
  error: CitedRecordError,
): MemoryAccessError["code"] {
  switch (error.code) {
    case "invalid":
      return "memory_invalid";
    case "missing":
    case "unreadable":
      return "memory_unavailable";
    case "unsupported":
      return "memory_evidence_unsupported";
    default:
      return assertNever(error.code);
  }
}

function memoryView(memory: Memory): MemoryView {
  return {
    memoryId: memory.memoryId,
    headRevision: memory.headRevision,
    revisions: memory.revisions.map(revisionView),
  };
}

// Labels stay on the server; a viewer receives the reviewed content only.
function revisionView(revision: MemoryRevision): MemoryRevisionView {
  const { flowLabel: _flowLabel, ...view } = revision;
  return view;
}

function failure(
  code: MemoryAccessError["code"],
): Result<never, MemoryAccessError> {
  return { ok: false, error: { code } };
}
