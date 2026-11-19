/**
 * Side Cases (Plan 74). An agent in a Portal chat proposes separate work that
 * it found as a side Case. The proposal shows as a card in the chat, and a
 * person starts it as a new chat or dismisses it. The agent never starts it.
 *
 * The title and the brief are model output of the proposing turn, so the
 * proposal keeps that turn's flow binding. The card is released to each
 * reader of the chat under that binding, and a started side Case admits it
 * as an observation on each turn, so every restriction of the source turn
 * stays with the new chat. A started proposal is the evidence of its side
 * Case and outlives the source chat.
 */
import type { OrganisationDatabase } from "../database-handles";
import {
  isConversationId,
  isSideCaseProposalId,
  isUserId,
  SIDE_CASE_BRIEF_MAX_LENGTH,
  SIDE_CASE_TITLE_MAX_LENGTH,
  type ChatSideCaseSource,
  type ChatSideCaseState,
  type ChatSideCaseView,
  type ConversationId,
  type UserId,
} from "@purin-labs/control-api";
import type { HarnessTurnLease, RequestAuthority } from "@purin-labs/contracts";
import {
  canonicalJson,
  isNonNegativeInteger,
  isString,
  sha256Hex,
} from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";
import type { AccountPlatformAccess } from "../account-platform/access";
import { admitSessionInformationFlowObservation } from "../actors/agent-session-information-flow";
import { deriveDirectCaseIdentities } from "../actors/case-direct-processing";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { FlowBinding, ObservationEvidence } from "../policy/information-flow";
import type { Conversation } from "./conversation";
import { conversationCaseIdentity } from "./conversation-access";
import type { DisclosureDestination } from "./disclosure-evidence";
import { authorizeForkHistoryAccess } from "./forks";
import { decideChatFlowDelivery } from "./information-flow";
import {
  ACTIVE_PLACEMENT,
  placementBindings,
  sideCasePhase,
  writeSideCaseTransition,
} from "./side-case-transition";
import { readConversation, type ConversationScope } from "./store";

/** The most proposals that wait in one chat. */
export const SIDE_CASE_OPEN_LIMIT = 3;
/** A proposal that nobody started or dismissed expires after seven days. */
export const SIDE_CASE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** The most cards that one chat read shows, newest first. */
const SIDE_CASE_CARD_LIMIT = 20;

/** Added to the harness instructions of each turn of a side Case. */
export const SIDE_CASE_HARNESS_INSTRUCTION =
  "This chat started from a side Case proposal in another chat. The first message is that proposal's brief. Do the work that the brief describes. Approvals and effects in the other chat do not authorize actions here.";

export type SideCaseStatus = "open" | "starting" | "started" | "dismissed";

export type SideCaseProposal = Readonly<{
  proposalId: string;
  sourceCaseId: string;
  sourceConversationId: ConversationId;
  sourceSessionId: string;
  sourceTurnId: string;
  requestedByUserId: UserId;
  title: string;
  brief: string;
  contentDigest: string;
  /** The binding of the proposing turn when the agent made the proposal. */
  flowBinding: FlowBinding;
  status: SideCaseStatus;
  destinationConversationId: ConversationId | null;
  destinationCaseId: string | null;
  decidedByUserId: UserId | null;
  createdAt: number;
  decidedAt: number | null;
  expiresAt: number;
}>;

/** A proposal has one identity for one turn and one content. */
export async function sideCaseProposalId(
  input: Readonly<{
    sessionId: string;
    turnId: string;
    title: string;
    brief: string;
  }>,
): Promise<string> {
  return (await sha256Hex(canonicalJson(input))).slice(0, 32);
}

export function sideCaseContentDigest(
  input: Readonly<{ title: string; brief: string }>,
): Promise<string> {
  return sha256Hex(canonicalJson({ title: input.title, brief: input.brief }));
}

export function isValidSideCaseContent(
  input: Readonly<{ title: string; brief: string }>,
): boolean {
  return (
    input.title.length > 0 &&
    input.title.length <= SIDE_CASE_TITLE_MAX_LENGTH &&
    input.brief.length > 0 &&
    input.brief.length <= SIDE_CASE_BRIEF_MAX_LENGTH
  );
}

/**
 * Stores one proposal of the agent. A repeated call of the same turn with the
 * same content returns the first proposal. A chat holds at most three open
 * proposals; a fourth one is not stored.
 */
export async function storeSideCaseProposal(
  execution: OrganisationExecutionScope,
  input: Readonly<{
    sourceCaseId: string;
    sourceConversationId: ConversationId;
    sourceSessionId: string;
    sourceTurnId: string;
    requestedByUserId: UserId;
    title: string;
    brief: string;
    flowBinding: FlowBinding;
    now: number;
  }>,
): Promise<
  | Readonly<{ kind: "proposed"; proposal: SideCaseProposal }>
  | Readonly<{ kind: "limit_reached" }>
> {
  if (!isValidSideCaseContent(input)) throw new Error("side_case_invalid");
  const proposalId = await sideCaseProposalId({
    sessionId: input.sourceSessionId,
    turnId: input.sourceTurnId,
    title: input.title,
    brief: input.brief,
  });
  await execution.database
    .prepare(
      `INSERT OR IGNORE INTO side_case_proposal (organisation_id, proposal_id, source_kind,
        source_case_id, source_conversation_id, source_session_id, source_turn_id,
        requested_by_user_id, title, brief, content_digest, flow_binding_json, status,
        created_at, expires_at)
      SELECT ?, ?, 'portal_chat', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?
      WHERE (SELECT COUNT(*) FROM side_case_proposal WHERE organisation_id = ?
          AND source_conversation_id = ? AND status = 'open' AND expires_at > ?) < ?
        AND ${ACTIVE_PLACEMENT}`,
    )
    .bind(
      execution.organisationId,
      proposalId,
      input.sourceCaseId,
      input.sourceConversationId,
      input.sourceSessionId,
      input.sourceTurnId,
      input.requestedByUserId,
      input.title,
      input.brief,
      await sideCaseContentDigest(input),
      JSON.stringify(input.flowBinding.toJSON()),
      input.now,
      input.now + SIDE_CASE_LIFETIME_MS,
      execution.organisationId,
      input.sourceConversationId,
      input.now,
      SIDE_CASE_OPEN_LIMIT,
      ...placementBindings(execution),
    )
    .run();
  if (!(await execution.isActive()))
    throw new Error("side_case_placement_conflict");
  const stored = await readSideCaseProposal(
    execution.database,
    execution.organisationId,
    proposalId,
  );
  if (stored === null) return { kind: "limit_reached" };
  if (
    stored.sourceConversationId !== input.sourceConversationId ||
    stored.sourceTurnId !== input.sourceTurnId
  )
    throw new Error("side_case_identity_conflict");
  return { kind: "proposed", proposal: stored };
}

export async function readSideCaseProposal(
  db: OrganisationDatabase,
  organisationId: string,
  proposalId: string,
): Promise<SideCaseProposal | null> {
  if (!isSideCaseProposalId(proposalId)) return null;
  const raw = await db
    .prepare(
      "SELECT * FROM side_case_proposal WHERE organisation_id = ? AND proposal_id = ? AND source_kind = 'portal_chat'",
    )
    .bind(organisationId, proposalId)
    .first();
  return raw === null ? null : parseProposalRow(raw);
}

/**
 * The Portal proposal that started this Case, when the Case is a side Case
 * of a Portal chat. A read of the chat checks it.
 */
export async function readSideCaseOriginForCase(
  placement: OrganisationExecutionScope,
  caseId: string,
): Promise<SideCaseProposal | null> {
  const raw = await placement.database
    .prepare(
      "SELECT * FROM side_case_proposal WHERE organisation_id = ? AND destination_case_id = ? AND source_kind = 'portal_chat'",
    )
    .bind(placement.organisationId, caseId)
    .first();
  return raw === null ? null : parseProposalRow(raw);
}

/**
 * Whether a person may receive a side Case's brief in another Case: their
 * Case read capability and the delivery check of the proposing turn. The
 * check is the one that a fork's inherited history passes. It throws
 * `ForkHistoryAccessError` when the person may not.
 */
export function authorizeSideCaseAccess(
  placement: OrganisationExecutionScope,
  proposal: SideCaseProposal,
  authority: Variant<RequestAuthority, "control">,
  destination: DisclosureDestination = { kind: "current" },
): Promise<readonly string[]> {
  return authorizeForkHistoryAccess(
    placement,
    { entries: [], bindings: [proposal.flowBinding.toJSON()] },
    authority,
    destination,
  );
}

/**
 * Whether this reader may open a side Case chat now. Each read checks the
 * proposal as a fork's read checks its inherited history, so a revoked
 * source closes the side Case too. It throws when the reader may not.
 */
export async function authorizeSideCaseChatRead(
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  conversation: Conversation,
  authority: Variant<RequestAuthority, "control">,
): Promise<void> {
  if (conversation.lineage.kind !== "side_case")
    throw new Error("side_case_lineage_invalid");
  const identity = await deriveDirectCaseIdentities(
    await conversationCaseIdentity(placement.database, scope, conversation.id),
  );
  if (!identity.ok) throw new Error("side_case_unavailable");
  const proposal = await readSideCaseOriginForCase(
    placement,
    identity.value.caseId,
  );
  if (proposal?.proposalId !== conversation.lineage.proposalId)
    throw new Error("side_case_unavailable");
  await authorizeSideCaseAccess(placement, proposal, authority);
}

/**
 * The chat that proposed a side Case, as this reader may open it. The title
 * shows only to a person who can open that chat.
 */
export async function readSideCaseSource(
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  conversation: Conversation,
): Promise<ChatSideCaseSource | null> {
  if (conversation.lineage.kind !== "side_case") return null;
  const source = await readConversation(
    placement.database,
    scope,
    conversation.lineage.sourceConversationId,
  );
  return source === null
    ? { kind: "unavailable" }
    : {
        kind: "available",
        conversationId: source.conversation.id,
        title: source.conversation.title,
      };
}

/**
 * Joins the proposing turn's label into this turn's context before
 * inference, so that every output of the side Case carries it.
 */
export async function admitSideCaseInformationFlow(
  db: OrganisationDatabase,
  accountAccess: AccountPlatformAccess,
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  proposal: SideCaseProposal,
  authorizeCommit: () => void | Promise<void>,
): Promise<void> {
  if (lease.requestAuthority.kind !== "control")
    throw new Error("side_case_forbidden");
  const binding = proposal.flowBinding;
  if (binding.organisationId !== lease.session.organisationId)
    throw new Error("side_case_flow_invalid");
  const decision = await decideChatFlowDelivery(
    db,
    accountAccess,
    binding,
    lease.requestAuthority,
  );
  if (decision.kind !== "allow") throw new Error("side_case_forbidden");
  await admitSideCaseObservation(storage, lease, proposal, authorizeCommit);
}

/**
 * Admits a side Case's proposal into this turn as an observation, with the
 * label of the proposing turn. The caller has checked that the turn's
 * authority may receive it. A Portal chat and a Slack thread share it.
 */
export async function admitSideCaseObservation(
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  proposal: Readonly<{
    proposalId: string;
    contentDigest: string;
    flowBinding: FlowBinding;
  }>,
  authorizeCommit: () => void | Promise<void>,
): Promise<void> {
  const binding = proposal.flowBinding;
  if (binding.organisationId !== lease.session.organisationId)
    throw new Error("side_case_flow_invalid");
  const observedAt = Date.now();
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "organisation_record",
      organisationId: binding.organisationId,
      recordId: `side_case:${proposal.proposalId}`,
    },
    sourceRevision: 1,
    contentDigest: proposal.contentDigest,
    inputLabel: binding.flowLabel,
    observedAt,
  });
  if (!evidence.ok) throw new Error("side_case_flow_invalid");
  const admitted = await admitSessionInformationFlowObservation({
    authorizeCommit,
    sql: storage.sql,
    transactionSync: storage.transactionSync.bind(storage),
    organisationId: binding.organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
    authorityPartitionDigest: lease.authorityPartitionDigest,
    inputLabel: binding.flowLabel,
    observation: evidence.value,
    observedAt,
  });
  if (!admitted.ok) throw new Error("side_case_flow_invalid");
}

/**
 * The cards of a chat for one reader, newest first. A card is source-derived
 * content, so it shows only to a reader who may receive the proposing turn's
 * output now. A withheld card answers as a missing one.
 */
export async function listConversationSideCases(
  placement: OrganisationExecutionScope,
  conversationId: ConversationId,
  reader: Readonly<{
    authority: Variant<RequestAuthority, "control">;
    /** True when the reader may send messages in this chat. */
    mayDecide: boolean;
  }>,
  now: number,
): Promise<readonly ChatSideCaseView[]> {
  const rows = await placement.database
    .prepare(
      `SELECT p.*, (d.conversation_id IS NOT NULL) AS destination_deleted
      FROM side_case_proposal p
      LEFT JOIN portal_chat_deletion d ON d.organisation_id = p.organisation_id
        AND d.conversation_id = p.destination_conversation_id
      WHERE p.organisation_id = ? AND p.source_conversation_id = ?
      ORDER BY p.created_at DESC, p.proposal_id ASC LIMIT ?`,
    )
    .bind(placement.organisationId, conversationId, SIDE_CASE_CARD_LIMIT)
    .all();
  const views: ChatSideCaseView[] = [];
  for (const raw of rows.results) {
    const proposal = await parseProposalRow(raw);
    const decision = await decideChatFlowDelivery(
      placement.database,
      placement.accountAccess,
      proposal.flowBinding,
      reader.authority,
    );
    if (decision.kind !== "allow") continue;
    views.push(
      sideCaseView(proposal, {
        userId: reader.authority.userId,
        mayDecide: reader.mayDecide,
        destinationDeleted: raw.destination_deleted === 1,
        now,
      }),
    );
  }
  return views;
}

export function sideCaseView(
  proposal: SideCaseProposal,
  reader: Readonly<{
    userId: string;
    mayDecide: boolean;
    destinationDeleted: boolean;
    now: number;
  }>,
): ChatSideCaseView {
  return {
    proposalId: proposal.proposalId,
    title: proposal.title,
    brief: proposal.brief,
    createdAt: proposal.createdAt,
    state: sideCaseState(proposal, reader),
  };
}

function sideCaseState(
  proposal: SideCaseProposal,
  reader: Readonly<{
    userId: string;
    mayDecide: boolean;
    destinationDeleted: boolean;
    now: number;
  }>,
): ChatSideCaseState {
  switch (sideCasePhase(proposal, reader.now)) {
    case "expired":
      return { kind: "expired" };
    case "open":
      // A start whose lease ended shows as open again.
      return {
        kind: "open",
        expiresAt: proposal.expiresAt,
        mayDecide: reader.mayDecide,
      };
    case "starting":
      return {
        kind: "starting",
        mayRetry: proposal.decidedByUserId === reader.userId,
      };
    case "started":
      // The new chat is private to the person who started it.
      return {
        kind: "started",
        conversationId:
          proposal.decidedByUserId === reader.userId &&
          !reader.destinationDeleted
            ? proposal.destinationConversationId
            : null,
      };
    case "dismissed":
      return { kind: "dismissed" };
  }
}

/**
 * Closes an open proposal, or a start whose lease ended, without a chat.
 * Dismissing a dismissed proposal again answers with the same proposal.
 */
export async function dismissSideCaseProposal(
  execution: OrganisationExecutionScope,
  proposal: SideCaseProposal,
  userId: UserId,
  now: number,
): Promise<
  | Readonly<{ ok: true; proposal: SideCaseProposal }>
  | Readonly<{ ok: false; code: "side_case_closed" | "side_case_expired" }>
> {
  switch (sideCasePhase(proposal, now)) {
    case "dismissed":
      return { ok: true, proposal };
    case "expired":
      return { ok: false, code: "side_case_expired" };
    case "open":
      break;
    case "starting":
    case "started":
      return { ok: false, code: "side_case_closed" };
  }
  const moved = await writeSideCaseTransition(
    execution,
    "portal_chat",
    proposal,
    { event: "dismiss", userId },
    now,
  );
  if (!moved.ok && moved.error === "side_case_placement_conflict")
    throw new Error("side_case_placement_conflict");
  const settled = await readSideCaseProposal(
    execution.database,
    execution.organisationId,
    proposal.proposalId,
  );
  return settled?.status === "dismissed"
    ? { ok: true, proposal: settled }
    : { ok: false, code: "side_case_closed" };
}

/**
 * Deletes the proposals of a deleted chat that never became a side Case. A
 * started proposal stays: it is the evidence of its side Case.
 */
export function prepareSourceSideCaseErasure(
  execution: OrganisationExecutionScope,
  conversationId: ConversationId,
): D1PreparedStatement {
  return execution.database
    .prepare(
      `DELETE FROM side_case_proposal WHERE organisation_id = ? AND source_conversation_id = ?
        AND status IN ('open', 'dismissed') AND ${ACTIVE_PLACEMENT}`,
    )
    .bind(
      execution.organisationId,
      conversationId,
      ...placementBindings(execution),
    );
}

/** A stored Portal proposal. A row of a Slack proposal is refused. */
export async function parseProposalRow(
  raw: Record<string, unknown>,
): Promise<SideCaseProposal> {
  if (raw.source_kind !== "portal_chat")
    throw new Error("side_case_storage_invalid");
  const {
    proposal_id: proposalId,
    source_case_id: sourceCaseId,
    source_conversation_id: sourceConversationId,
    source_session_id: sourceSessionId,
    source_turn_id: sourceTurnId,
    requested_by_user_id: requestedByUserId,
    title,
    brief,
    content_digest: contentDigest,
    flow_binding_json: flowBindingJson,
    status,
    destination_conversation_id: destinationConversationId,
    destination_case_id: destinationCaseId,
    decided_by_user_id: decidedByUserId,
    created_at: createdAt,
    decided_at: decidedAt,
    expires_at: expiresAt,
  } = raw;
  if (
    !isSideCaseProposalId(proposalId) ||
    typeof sourceCaseId !== "string" ||
    !isConversationId(sourceConversationId) ||
    typeof sourceSessionId !== "string" ||
    typeof sourceTurnId !== "string" ||
    !isUserId(requestedByUserId) ||
    typeof title !== "string" ||
    typeof brief !== "string" ||
    typeof contentDigest !== "string" ||
    typeof flowBindingJson !== "string" ||
    !isSideCaseStatus(status) ||
    !isNonNegativeInteger(createdAt) ||
    !isNonNegativeInteger(expiresAt)
  )
    throw new Error("side_case_storage_invalid");
  const destination = nullable(destinationConversationId, isConversationId);
  const destinationCase = nullable(destinationCaseId, isString);
  const decidedBy = nullable(decidedByUserId, isUserId);
  const decided = nullable(decidedAt, isNonNegativeInteger);
  if (
    destination === undefined ||
    destinationCase === undefined ||
    decidedBy === undefined ||
    decided === undefined
  )
    throw new Error("side_case_storage_invalid");
  const binding = await FlowBinding.restore(JSON.parse(flowBindingJson));
  if (
    !binding.ok ||
    (await sideCaseContentDigest({ title, brief })) !== contentDigest
  )
    throw new Error("side_case_storage_invalid");
  return {
    proposalId,
    sourceCaseId,
    sourceConversationId,
    sourceSessionId,
    sourceTurnId,
    requestedByUserId,
    title,
    brief,
    contentDigest,
    flowBinding: binding.value,
    status,
    destinationConversationId: destination,
    destinationCaseId: destinationCase,
    decidedByUserId: decidedBy,
    createdAt,
    decidedAt: decided,
    expiresAt,
  };
}

const SIDE_CASE_STATUSES: Readonly<Record<SideCaseStatus, true>> = {
  open: true,
  starting: true,
  started: true,
  dismissed: true,
};

function isSideCaseStatus(value: unknown): value is SideCaseStatus {
  return typeof value === "string" && Object.hasOwn(SIDE_CASE_STATUSES, value);
}

/** The value, null for a stored NULL, or undefined for an invalid value. */
function nullable<T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
): T | null | undefined {
  if (value === null) return null;
  return guard(value) ? value : undefined;
}

export { ACTIVE_PLACEMENT, placementBindings };
