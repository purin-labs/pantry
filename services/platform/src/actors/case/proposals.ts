import type { CaseContent, CaseLifecycle } from "@seams/contracts";
import { assertNever } from "@seams/std";
import { machineTransition } from "@seams/std/state-machine";
import type { MerchantActionDecision } from "../../approval-authentication";
import type { ActionLedgerEntry } from "../action-ledger";
import { writeActorTransition } from "../lifecycle/state-transition";
import { CASE_APPROVAL_WAIT_MACHINE } from "./approval-wait.machine";
import { authorityPartitionKeyMatchesRequest } from "../../authorization/access-grants/turn-authority";
import { FlowBinding } from "../../policy";
import { sourceReaderForAuthority } from "../../policy/information-flow/source-readers";
import type { Variant } from "@seams/type-utils";
import { commerceApprovalNoticeDeliveryId } from "../../slack/commerce-approval-card";
import {
  bindingMatchesAssignmentTurn,
  journalEntryExists,
  parsePersistedCommerceProposalFlowBinding,
  readAssignmentLifecycle,
  readBindings,
  readCommerceApproval,
  readCommerceProposal,
  readJournal,
  readMeta,
  readOutputLifecycle,
  replayAuthorityForFlowBinding,
} from "./context-source";
import {
  appendJournal,
  buildCaseOutput,
  buildCaseOutputs,
  persistPendingOutput,
  persistProposal,
} from "./outputs";
import {
  equal,
  invalid,
  isOpen,
  parseCaseProposalAcceptanceJson,
  parseLifecycle,
  parseSessionProposalJson,
  proposalDisposition,
} from "./record-parsers";
import {
  commerceOutcomeMatchesAction,
  merchantDecisionMatchesAction,
  parseCommerceCaseProposalJson,
  parseCommerceEntityPlaneCaseProposalJson,
  parseCommerceProposalAcceptance,
} from "./request-parsers";
import type {
  AcceptCommerceEntityPlaneProposalRequest,
  AcceptCommerceProposalRequest,
  AcceptProposalRequest,
  CaseCommerceApprovalRecord,
  CaseResult,
  CommerceCaseProposal,
  JsonRow,
  ProposalRow,
  RawCaseCommerceOutcomeAcceptance,
  RawCaseOutputLifecycle,
  RawCaseProposalAcceptance,
  ResolveCommerceApprovalRequest,
  StoredAcceptCommerceOutcomeRequest,
  WaitForCommerceApprovalRequest,
} from "./types";

export function acceptCaseProposal(
  sql: SqlStorage,
  input: AcceptProposalRequest,
  entryDigests: readonly string[],
): CaseResult<RawCaseProposalAcceptance> {
  const proposal = input.proposal;
  const meta = readMeta(sql);
  if (
    meta === null ||
    meta.case_id !== proposal.caseId ||
    input.requestAuthority.organisationId !== meta.organisation_id
  ) {
    return proposalDisposition("assignment_mismatch");
  }
  const previous =
    sql
      .exec<ProposalRow>(
        "SELECT proposal_id, payload, acceptance_json FROM case_proposal WHERE proposal_id = ?",
        proposal.proposalId,
      )
      .toArray()[0] ?? null;
  if (previous !== null) {
    const persistedProposal = parseSessionProposalJson(previous.payload);
    const acceptance = parseCaseProposalAcceptanceJson(
      previous.acceptance_json,
    );
    if (persistedProposal === null || acceptance === null)
      return invalid("case_storage_corrupt");
    return equal(persistedProposal, proposal)
      ? { ok: true, value: acceptance }
      : invalid("case_proposal_conflict");
  }
  const lifecycle = readAssignmentLifecycle(sql, proposal.assignmentId);
  if (lifecycle === null) return proposalDisposition("assignment_missing");
  const assignment = lifecycle.assignment;
  if (assignment.caseId !== proposal.caseId)
    return proposalDisposition("assignment_mismatch");
  if (assignment.sessionId !== proposal.sessionId)
    return proposalDisposition("session_mismatch");
  if (
    !authorityPartitionKeyMatchesRequest(
      assignment.authorityPartition.key,
      input.requestAuthority,
    )
  ) {
    return proposalDisposition("assignment_mismatch");
  }
  if (lifecycle.kind !== "running")
    return proposalDisposition("assignment_mismatch");
  if (
    !bindingMatchesAssignmentTurn(
      input.flowBinding,
      assignment,
      proposal.turnId,
      meta.organisation_id,
    )
  ) {
    return proposalDisposition("assignment_mismatch");
  }
  const caseLifecycle = parseLifecycle(meta.lifecycle_json);
  if (
    caseLifecycle?.kind === "waiting" &&
    caseLifecycle.wait.kind === "approval"
  ) {
    if (proposal.requestedEffects.length > 0)
      return proposalDisposition("case_not_open");
    for (const entry of proposal.entries) {
      if (entry.kind !== "observation")
        return proposalDisposition("case_not_open");
    }
  } else if (caseLifecycle?.kind !== "open") {
    return proposalDisposition("case_not_open");
  }
  if (proposal.entries.length === 0)
    return proposalDisposition("empty_proposal");
  if (
    new Set(proposal.entries.map((entry) => entry.entryId)).size !==
      proposal.entries.length ||
    proposal.entries.some((entry) => journalEntryExists(sql, entry.entryId))
  )
    return proposalDisposition("invalid_entry");
  if (
    proposal.entries.some((entry) => entry.kind === "shared_change") &&
    (proposal.basedOnRevision !== meta.revision ||
      proposal.entries.some(
        (entry) =>
          entry.kind === "shared_change" &&
          entry.baseRevision !== meta.revision,
      ))
  ) {
    const value: RawCaseProposalAcceptance = {
      disposition: { kind: "rebase_required", revision: meta.revision },
      outputs: [],
    };
    persistProposal(sql, proposal, value, input.acceptedAt);
    return { ok: true, value };
  }
  const next = meta.revision + 1;
  const outputs = buildCaseOutputs(
    sql,
    proposal,
    next,
    input.acceptedAt,
    input.flowBinding,
  );
  if (!outputs.ok) return outputs;
  for (const [index, entry] of proposal.entries.entries()) {
    appendJournal(
      sql,
      entry.entryId,
      entry.content,
      entryDigests[index] ?? "",
      input.requestAuthority,
      sourceReaderForAuthority(input.requestAuthority),
      input.flowBinding.flowLabel,
      replayAuthorityForFlowBinding(input.flowBinding),
      input.acceptedAt,
    );
  }
  sql.exec("UPDATE case_meta SET revision = ? WHERE singleton = 1", next);
  const value: RawCaseProposalAcceptance = {
    disposition: { kind: "accepted", revision: next },
    outputs: outputs.value,
  };
  persistProposal(sql, proposal, value, input.acceptedAt);
  for (const output of outputs.value) persistPendingOutput(sql, output);
  return { ok: true, value };
}

export function acceptCommerceProposal(
  sql: SqlStorage,
  input: AcceptCommerceProposalRequest,
  proposalDigest: string,
): CaseResult<{
  readonly kind: "accepted" | "already_accepted";
  readonly revision: number;
}> {
  const proposal = input.proposal;
  const meta = readMeta(sql);
  if (
    meta === null ||
    meta.case_id !== proposal.caseId ||
    proposal.requestAuthority.organisationId !== meta.organisation_id
  ) {
    return invalid("case_identity_mismatch");
  }
  const existing =
    sql
      .exec<JsonRow & { acceptance_json: string }>(
        "SELECT payload, acceptance_json FROM case_commerce_proposal WHERE proposal_id = ?",
        proposal.proposalId,
      )
      .toArray()[0] ?? null;
  if (existing !== null) {
    const stored = parseCommerceCaseProposalJson(existing.payload);
    const acceptance = parseCommerceProposalAcceptance(
      existing.acceptance_json,
    );
    if (stored === null || acceptance === null)
      return invalid("case_storage_corrupt");
    return sameCommerceProposal(stored, proposal)
      ? { ok: true, value: acceptance }
      : invalid("case_commerce_proposal_conflict");
  }
  if (!isOpen(meta.lifecycle_json)) return invalid("case_not_open");
  if (proposal.origin.kind === "agent_session") {
    const lifecycle = readAssignmentLifecycle(
      sql,
      proposal.origin.assignmentId,
    );
    if (
      lifecycle === null ||
      lifecycle.kind !== "running" ||
      lifecycle.assignment.caseId !== proposal.caseId ||
      lifecycle.assignment.sessionId !== proposal.origin.sessionId ||
      !authorityPartitionKeyMatchesRequest(
        lifecycle.assignment.authorityPartition.key,
        proposal.requestAuthority,
      ) ||
      !bindingMatchesAssignmentTurn(
        input.flowBinding,
        lifecycle.assignment,
        input.turnId ?? lifecycle.start.startId.slice("start_".length),
        meta.organisation_id,
      )
    ) {
      return invalid("case_commerce_proposal_assignment_invalid");
    }
  } else if (
    input.flowBinding.organisationId !== meta.organisation_id ||
    input.flowBinding.sessionId !== proposal.origin.controlSessionId ||
    input.flowBinding.turnId !== `merchant:${proposal.proposalId}`
  ) {
    return invalid("case_commerce_proposal_assignment_invalid");
  }
  if (proposal.basedOnRevision !== meta.revision) {
    return invalid("case_commerce_proposal_rebase_required");
  }
  const next = meta.revision + 1;
  appendJournal(
    sql,
    `commerce_proposal:${proposal.proposalId}`,
    proposal.provenance === null
      ? { kind: "text", text: JSON.stringify(proposal.action) }
      : { kind: "commerce_reference", provenance: proposal.provenance },
    proposalDigest,
    proposal.requestAuthority,
    sourceReaderForAuthority(proposal.requestAuthority),
    input.flowBinding.flowLabel,
    replayAuthorityForFlowBinding(input.flowBinding),
    input.acceptedAt,
  );
  sql.exec("UPDATE case_meta SET revision = ? WHERE singleton = 1", next);
  const acceptance = { kind: "accepted" as const, revision: next };
  sql.exec(
    "INSERT INTO case_commerce_proposal (proposal_id, payload, acceptance_json) VALUES (?, ?, ?)",
    proposal.proposalId,
    JSON.stringify(proposal),
    // The acceptance names the tool call that made the proposal. The
    // proposal itself does not: its identity and its replay check stay as
    // they were.
    JSON.stringify({
      ...acceptance,
      acceptedAt: input.acceptedAt,
      flowBinding: input.flowBinding.toJSON(),
      ...(input.toolCallId === undefined
        ? {}
        : { toolCallId: input.toolCallId }),
    }),
  );
  return { ok: true, value: acceptance };
}

export function acceptCommerceEntityPlaneProposal(
  sql: SqlStorage,
  input: AcceptCommerceEntityPlaneProposalRequest,
  proposalDigest: string,
  journalDigest: string,
): CaseResult<{
  readonly kind: "accepted" | "already_accepted";
  readonly revision: number;
}> {
  const proposal = input.proposal;
  const meta = readMeta(sql);
  if (
    meta === null ||
    meta.case_id !== proposal.caseId ||
    proposal.requestAuthority.organisationId !== meta.organisation_id
  ) {
    return invalid("case_identity_mismatch");
  }
  const existing =
    sql
      .exec<JsonRow & { acceptance_json: string }>(
        "SELECT payload, acceptance_json FROM case_commerce_proposal WHERE proposal_id = ?",
        proposal.proposalId,
      )
      .toArray()[0] ?? null;
  if (existing !== null) {
    const stored = parseCommerceEntityPlaneCaseProposalJson(existing.payload);
    const acceptance = parseCommerceProposalAcceptance(
      existing.acceptance_json,
    );
    const storedFlowBinding = parsePersistedCommerceProposalFlowBinding(
      existing.acceptance_json,
    );
    if (stored === null || acceptance === null || storedFlowBinding === null) {
      return invalid("case_storage_corrupt");
    }
    if (!equal(storedFlowBinding, input.flowBinding.toJSON())) {
      return invalid("case_entity_plane_proposal_conflict");
    }
    return equal(stored, proposal)
      ? { ok: true, value: acceptance }
      : invalid("case_entity_plane_proposal_conflict");
  }
  if (!isOpen(meta.lifecycle_json)) return invalid("case_not_open");
  if (proposal.origin.kind === "agent_session") {
    const lifecycle = readAssignmentLifecycle(
      sql,
      proposal.origin.assignmentId,
    );
    if (
      lifecycle === null ||
      lifecycle.kind !== "running" ||
      lifecycle.assignment.caseId !== proposal.caseId ||
      lifecycle.assignment.sessionId !== proposal.origin.sessionId ||
      !authorityPartitionKeyMatchesRequest(
        lifecycle.assignment.authorityPartition.key,
        proposal.requestAuthority,
      ) ||
      !bindingMatchesAssignmentTurn(
        input.flowBinding,
        lifecycle.assignment,
        lifecycle.start.startId.slice("start_".length),
        meta.organisation_id,
      )
    ) {
      return invalid("case_entity_plane_proposal_assignment_invalid");
    }
  } else if (
    input.flowBinding.organisationId !== meta.organisation_id ||
    input.flowBinding.sessionId !== proposal.origin.controlSessionId ||
    input.flowBinding.turnId !== `merchant:${proposal.proposalId}`
  ) {
    return invalid("case_entity_plane_proposal_assignment_invalid");
  }
  if (proposal.basedOnRevision !== meta.revision) {
    return invalid("case_entity_plane_proposal_rebase_required");
  }
  const next = meta.revision + 1;
  const journalContent: CaseContent = {
    kind: "entity_plane_proposal",
    proposal: proposal.proposal,
  };
  appendJournal(
    sql,
    `commerce_proposal:${proposal.proposalId}`,
    journalContent,
    journalDigest,
    proposal.requestAuthority,
    sourceReaderForAuthority(proposal.requestAuthority),
    input.flowBinding.flowLabel,
    replayAuthorityForFlowBinding(input.flowBinding),
    input.acceptedAt,
  );
  sql.exec("UPDATE case_meta SET revision = ? WHERE singleton = 1", next);
  const acceptance = { kind: "accepted" as const, revision: next };
  sql.exec(
    "INSERT INTO case_commerce_proposal (proposal_id, payload, acceptance_json) VALUES (?, ?, ?)",
    proposal.proposalId,
    JSON.stringify(proposal),
    JSON.stringify({
      ...acceptance,
      acceptedAt: input.acceptedAt,
      flowBinding: input.flowBinding.toJSON(),
      proposalDigest,
    }),
  );
  return { ok: true, value: acceptance };
}

/** The notice that a proposal waits for approval, ready for the journal. */
export type CommerceApprovalNotice = Readonly<{
  content: Variant<CaseContent, "text">;
  digest: string;
  flowBinding: FlowBinding;
}>;

export function waitForCommerceApproval(
  sql: SqlStorage,
  input: WaitForCommerceApprovalRequest,
  notice: CommerceApprovalNotice | undefined,
): CaseResult<{
  readonly kind: "waiting" | "already_waiting" | "already_resolved";
  readonly revision: number;
  readonly notice: RawCaseOutputLifecycle | null;
}> {
  const meta = readMeta(sql);
  if (meta === null || meta.case_id !== input.caseId)
    return invalid("case_identity_mismatch");
  const proposal = readCommerceProposal(sql, input.proposalId);
  if (proposal === null || proposal.caseId !== input.caseId) {
    return invalid("case_commerce_proposal_missing");
  }
  const noticeOutputId = `output_commerce_notice_${input.actionNonce}`;
  const existing = readCommerceApproval(sql, input.actionNonce);
  if (existing !== null) {
    if (!sameCommerceApprovalRequest(existing.request, input)) {
      return invalid("case_commerce_approval_conflict");
    }
    const stored = readOutputLifecycle(sql, noticeOutputId);
    // A lapsed wait has ended too: a retry does not put the Case back.
    return existing.kind !== "waiting"
      ? {
          ok: true,
          value: {
            kind: "already_resolved",
            revision: meta.revision,
            notice: stored,
          },
        }
      : {
          ok: true,
          value: {
            kind: "already_waiting",
            revision: meta.revision,
            notice: stored,
          },
        };
  }
  if (meta.revision !== input.expectedCaseRevision)
    return invalid("case_commerce_approval_rebase_required");
  if (!isOpen(meta.lifecycle_json)) return invalid("case_not_open");
  const next = meta.revision + 1;
  const lifecycle: CaseLifecycle = {
    kind: "waiting",
    wait: { kind: "approval", approvalRequestId: input.actionNonce },
  };
  const record: CaseCommerceApprovalRecord = {
    kind: "waiting",
    request: input,
  };
  // The thread's notice joins the wait in the same revision, so a turn that
  // goes on after its proposal finds the Case where it left it. Only a
  // Slack thread gets one; a Portal chat shows the approval card itself.
  const entryId = `commerce_approval_notice:${input.actionNonce}`;
  const bound = readBindings(sql);
  const slackThread =
    bound?.length === 1 &&
    (bound[0]?.address.kind === "slack" ||
      bound[0]?.address.kind === "slack_channel");
  const output =
    notice === undefined || !slackThread
      ? { ok: true as const, value: null }
      : buildCaseOutput(sql, {
          outputId: noticeOutputId,
          source: {
            kind: "commerce_approval_notice",
            proposalId: input.proposalId,
            actionNonce: input.actionNonce,
          },
          entryId,
          caseId: input.caseId,
          content: notice.content,
          revision: next,
          addressedAt: input.requestedAt,
          deliveryId: commerceApprovalNoticeDeliveryId(input.actionNonce),
          idempotencyKey: `case_commerce_approval_notice_${input.actionNonce}`,
          flowBinding: notice.flowBinding.toJSON(),
        });
  if (!output.ok) return output;
  sql.exec(
    "INSERT INTO case_commerce_approval (action_nonce, proposal_id, payload) VALUES (?, ?, ?)",
    input.actionNonce,
    input.proposalId,
    JSON.stringify(record),
  );
  sql.exec(
    "UPDATE case_meta SET revision = ?, lifecycle_json = ? WHERE singleton = 1",
    next,
    JSON.stringify(lifecycle),
  );
  if (notice !== undefined && output.value !== null)
    appendJournal(
      sql,
      entryId,
      notice.content,
      notice.digest,
      proposal.requestAuthority,
      sourceReaderForAuthority(proposal.requestAuthority),
      notice.flowBinding.flowLabel,
      replayAuthorityForFlowBinding(notice.flowBinding),
      input.requestedAt,
    );
  if (output.value !== null) persistPendingOutput(sql, output.value);
  return {
    ok: true,
    value: {
      kind: "waiting",
      revision: next,
      notice:
        output.value === null
          ? null
          : { kind: "pending", output: output.value },
    },
  };
}

export function sameCommerceApprovalRequest(
  left: WaitForCommerceApprovalRequest,
  right: WaitForCommerceApprovalRequest,
): boolean {
  return (
    left.caseId === right.caseId &&
    left.proposalId === right.proposalId &&
    left.actionNonce === right.actionNonce &&
    left.expectedCaseRevision === right.expectedCaseRevision
  );
}

export function resolveCommerceApproval(
  sql: SqlStorage,
  input: ResolveCommerceApprovalRequest,
): CaseResult<{
  readonly kind: "resolved" | "already_resolved";
  readonly revision: number;
}> {
  const meta = readMeta(sql);
  if (meta === null || meta.case_id !== input.caseId)
    return invalid("case_identity_mismatch");
  const current = readCommerceApproval(sql, input.actionNonce);
  if (
    current === null ||
    current.request.proposalId !== input.proposalId ||
    current.request.caseId !== input.caseId ||
    !merchantDecisionMatchesAction(
      input.decision,
      meta.organisation_id,
      input.actionNonce,
    )
  ) {
    return invalid("case_commerce_approval_mismatch");
  }
  if (current.kind === "lapsed")
    return invalid("case_commerce_approval_lapsed");
  if (current.kind === "decided") {
    // The ledger's decision may reach the Case twice: once from the route
    // that decided it and once from the Case's own read of the ledger. The
    // two carry the same evidence, and their times can differ.
    return sameDecision(current.decision, input.decision)
      ? {
          ok: true,
          value: { kind: "already_resolved", revision: meta.revision },
        }
      : invalid("case_commerce_approval_conflict");
  }
  const ended = endCommerceApprovalWait(sql, meta, current, {
    event: "decide",
    record: {
      kind: "decided",
      request: current.request,
      decision: input.decision,
    },
    openedAt: input.decision.decidedAt,
  });
  if (!ended.ok) return ended;
  return { ok: true, value: { kind: "resolved", revision: ended.value } };
}

/**
 * Ends the Case's wait for an approval whose action expired in the ledger
 * before it ran. Nobody can approve or reject an expired action, so without
 * this the Case stays waiting and refuses every later trigger.
 */
export function lapseCommerceApproval(
  sql: SqlStorage,
  input: Readonly<{ caseId: string; actionNonce: string; lapsedAt: number }>,
): CaseResult<{ readonly kind: "lapsed" | "not_waiting" }> {
  const meta = readMeta(sql);
  if (meta === null || meta.case_id !== input.caseId)
    return invalid("case_identity_mismatch");
  const current = readCommerceApproval(sql, input.actionNonce);
  if (current?.kind !== "waiting")
    return { ok: true, value: { kind: "not_waiting" } };
  const ended = endCommerceApprovalWait(sql, meta, current, {
    event: "lapse",
    record: {
      kind: "lapsed",
      request: current.request,
      lapsedAt: input.lapsedAt,
    },
    openedAt: input.lapsedAt,
  });
  if (!ended.ok)
    return ended.error.code === "case_commerce_approval_not_waiting"
      ? { ok: true, value: { kind: "not_waiting" } }
      : ended;
  return { ok: true, value: { kind: "lapsed" } };
}

/**
 * Moves the Case's wait to the state that the ledger entry of its action
 * shows (Refactor 15, refactor 1). The ledger owns the decision: a route that
 * decided an action, the Case alarm and the Case's admission all call this,
 * and the first call that sees a decided or expired entry ends the wait. An
 * entry that still waits for a person changes nothing.
 */
export function reconcileCommerceApprovalWait(
  sql: SqlStorage,
  input: Readonly<{ caseId: string; entry: ActionLedgerEntry }>,
): CaseResult<{
  readonly kind: "waiting" | "decided" | "lapsed" | "not_waiting";
}> {
  const meta = readMeta(sql);
  if (meta === null || meta.case_id !== input.caseId)
    return invalid("case_identity_mismatch");
  if (input.entry.caseId !== input.caseId)
    return invalid("case_commerce_approval_mismatch");
  const actionNonce = input.entry.action.nonce.value;
  const current = readCommerceApproval(sql, actionNonce);
  if (current === null) return invalid("case_commerce_approval_mismatch");
  if (current.request.proposalId !== input.entry.proposalId)
    return invalid("case_commerce_approval_mismatch");
  if (current.kind !== "waiting")
    return { ok: true, value: { kind: "not_waiting" } };
  const outcome = ledgerApprovalOutcome(input.entry);
  switch (outcome.kind) {
    case "waiting":
      return { ok: true, value: { kind: "waiting" } };
    case "lapsed": {
      const lapsed = lapseCommerceApproval(sql, {
        caseId: input.caseId,
        actionNonce,
        lapsedAt: outcome.lapsedAt,
      });
      if (!lapsed.ok) return lapsed;
      return {
        ok: true,
        value: {
          kind: lapsed.value.kind === "lapsed" ? "lapsed" : "not_waiting",
        },
      };
    }
    case "decided": {
      const resolved = resolveCommerceApproval(sql, {
        caseId: input.caseId,
        proposalId: input.entry.proposalId,
        actionNonce,
        decision: outcome.decision,
      });
      if (!resolved.ok) return resolved;
      return { ok: true, value: { kind: "decided" } };
    }
    default:
      return assertNever(outcome);
  }
}

/**
 * The one writer of the wait's end. It checks the move against
 * CASE_APPROVAL_WAIT_MACHINE, writes the record only while it still waits,
 * and opens the Case when the Case still waits for this action.
 */
function endCommerceApprovalWait(
  sql: SqlStorage,
  meta: NonNullable<ReturnType<typeof readMeta>>,
  current: CaseCommerceApprovalRecord,
  move: Readonly<{
    event: "decide" | "lapse";
    record: CaseCommerceApprovalRecord;
    openedAt: number;
  }>,
): CaseResult<number> {
  const allowed = machineTransition(
    CASE_APPROVAL_WAIT_MACHINE,
    current.kind,
    move.event,
  );
  if (!allowed.allowed) return invalid("case_commerce_approval_not_waiting");
  const lifecycle = parseLifecycle(meta.lifecycle_json);
  const actionNonce = current.request.actionNonce;
  const caseWaits =
    lifecycle?.kind === "waiting" &&
    lifecycle.wait.kind === "approval" &&
    lifecycle.wait.approvalRequestId === actionNonce;
  if (
    !writeActorTransition(sql, CASE_APPROVAL_WAIT_MACHINE.store, {
      key: actionNonce,
      from: allowed.from,
      value: JSON.stringify(move.record),
    })
  )
    return invalid("case_commerce_approval_not_waiting");
  const next = meta.revision + 1;
  // A Case that moved on (for example to archived) keeps its lifecycle; only
  // the wait for this action opens it.
  if (caseWaits) {
    const open: CaseLifecycle = { kind: "open", openedAt: move.openedAt };
    sql.exec(
      "UPDATE case_meta SET revision = ?, lifecycle_json = ? WHERE singleton = 1",
      next,
      JSON.stringify(open),
    );
  } else {
    sql.exec("UPDATE case_meta SET revision = ? WHERE singleton = 1", next);
  }
  return { ok: true, value: next };
}

/** The Case state that a ledger entry shows for the wait on its action. */
export function ledgerApprovalOutcome(
  entry: ActionLedgerEntry,
):
  | Readonly<{ kind: "waiting" }>
  | Readonly<{ kind: "decided"; decision: MerchantActionDecision }>
  | Readonly<{ kind: "lapsed"; lapsedAt: number }> {
  switch (entry.state) {
    case "proposed":
    case "approval_requested":
      return { kind: "waiting" };
    case "signed":
    case "executing":
    case "indeterminate":
    case "confirmed":
    case "failed":
      return {
        kind: "decided",
        decision: {
          kind: "approved",
          decidedAt: entry.updatedAt,
          evidence: entry.approval,
        },
      };
    case "rejected":
      return {
        kind: "decided",
        decision: {
          kind: "rejected",
          decidedAt: entry.updatedAt,
          evidence: entry.rejection,
        },
      };
    case "expired":
      return { kind: "lapsed", lapsedAt: entry.updatedAt };
    default:
      return assertNever(entry);
  }
}

function sameDecision(
  left: MerchantActionDecision,
  right: MerchantActionDecision,
): boolean {
  return left.kind === right.kind && equal(left.evidence, right.evidence);
}

export function acceptCommerceOutcome(
  sql: SqlStorage,
  input: StoredAcceptCommerceOutcomeRequest,
  outcomeDigest: string,
): CaseResult<RawCaseCommerceOutcomeAcceptance> {
  const meta = readMeta(sql);
  if (meta === null || meta.case_id !== input.caseId)
    return invalid("case_identity_mismatch");
  if (
    !commerceOutcomeMatchesAction(
      input.outcome,
      meta.organisation_id,
      input.actionNonce,
    )
  ) {
    return invalid("case_commerce_outcome_action_mismatch");
  }
  const proposalRow =
    sql
      .exec<JsonRow>(
        "SELECT payload FROM case_commerce_proposal WHERE proposal_id = ?",
        input.proposalId,
      )
      .toArray()[0] ?? null;
  const proposal =
    proposalRow === null
      ? null
      : parseCommerceCaseProposalJson(proposalRow.payload);
  if (proposal === null || proposal.caseId !== input.caseId)
    return invalid("case_commerce_proposal_missing");

  const entryId = `commerce_outcome:${input.actionNonce}`;
  const outputId = `output_commerce_${input.actionNonce}`;
  const existing = readJournal(sql, entryId);
  if (existing !== null) {
    if (existing.digest !== outcomeDigest)
      return invalid("case_commerce_outcome_conflict");
    const output = readOutputLifecycle(sql, outputId);
    return {
      ok: true,
      value: { kind: "already_accepted", revision: meta.revision, output },
    };
  }
  if (!isOpen(meta.lifecycle_json)) return invalid("case_not_open");

  const next = meta.revision + 1;
  const output = buildCaseOutput(sql, {
    outputId,
    source: {
      kind: "commerce_outcome",
      proposalId: input.proposalId,
      actionNonce: input.actionNonce,
    },
    entryId,
    caseId: input.caseId,
    content: input.content,
    revision: next,
    addressedAt: input.acceptedAt,
    deliveryId: `delivery_commerce_${input.actionNonce}`,
    idempotencyKey: `case_commerce_outcome_${input.actionNonce}`,
    flowBinding: input.flowBinding.toJSON(),
  });
  if (!output.ok) return output;
  appendJournal(
    sql,
    entryId,
    input.content,
    outcomeDigest,
    proposal.requestAuthority,
    sourceReaderForAuthority(proposal.requestAuthority),
    input.flowBinding.flowLabel,
    replayAuthorityForFlowBinding(input.flowBinding),
    input.acceptedAt,
  );
  sql.exec("UPDATE case_meta SET revision = ? WHERE singleton = 1", next);
  if (output.value !== null) persistPendingOutput(sql, output.value);
  return {
    ok: true,
    value: {
      kind: "accepted",
      revision: next,
      output:
        output.value === null
          ? null
          : { kind: "pending", output: output.value },
    },
  };
}

export function sameCommerceProposal(
  left: CommerceCaseProposal,
  right: CommerceCaseProposal,
): boolean {
  return (
    left.proposalId === right.proposalId &&
    left.caseId === right.caseId &&
    equal(left.requestAuthority, right.requestAuthority) &&
    equal(left.action, right.action) &&
    equal(left.authority, right.authority) &&
    equal(left.provenance, right.provenance) &&
    equal(left.origin, right.origin)
  );
}
