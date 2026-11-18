import type { OrganisationDatabase } from "../../database-handles";
import type { ActionMutationExecution } from "../action-mutation-execution";
import { parseSourceProvenance } from "../../commerce/source-provenance";
import type { RequestAuthority } from "@seams/contracts";
import type { SourceProvenance } from "@seams/contracts";
import { parseIntegrationAccountId } from "../../ids";
import { parseEmailReplyProposalLifecycle } from "../../data/email-mailbox";
import { parseEmailProposalTarget } from "../../data/email-operational";
import { parseCommerceSystemRevision } from "../../data/organisation-commerce-system";
import { parseCommerceProviderReceipt } from "../../commerce/action-model";
import {
  isCurrentAuthorityPartition,
  parseStoredAuthorityPartition,
} from "../../authorization/access-grants/turn-authority";
import {
  parseMerchantActionRejectionEvidence,
  parseMerchantActionDecision,
  type MerchantActionDecision,
} from "../../approval-authentication";
import { parseStoredRequestAuthority } from "../../request-authority";
import {
  advanceInformationFlowContext,
  FlowBinding,
  flowBindingForContext,
  InformationFlowContext,
  ObservationEvidence,
} from "../../policy";
import { parseCommerceEntityPlaneProposal } from "../../commerce/entity-plane/proposals";
import type { Variant } from "@seams/type-utils";
import { checked } from "@seams/contracts/connector-rpc";
import {
  abandonAssignmentRequestSchema,
  acceptCommerceOutcomeRequestSchema,
  acceptDeliveryReceiptRequestSchema,
  beginAssignmentRequestSchema,
  caseEnsureRequestSchema,
  commerceApprovalRecordSchema,
  commerceCaseOutcomeSchema,
  commerceCaseProposalSchema,
  commerceEntityPlaneCaseProposalSchema,
  commerceProposalAcceptanceSchema,
  commerceProposalOriginSchema,
  commerceSystemAuthoritySchema,
  dropHeldOutputRequestSchema,
  integrationAccountAuthoritySchema,
  noteRefusedEffectRequestSchema,
  operationalEmailProposalSchema,
  replyEmailProposalSchema,
  resolveCommerceApprovalRequestSchema,
  settleAssignmentRequestSchema,
  waitForCommerceApprovalRequestSchema,
} from "@seams/contracts/case-rpc";
import { assertNever, isNonBlankString, isRecord } from "@seams/std";
import { flowLabelForAuthority } from "./context-source";
import {
  equal,
  integer,
  parseAssignmentStart,
  parseCaseBinding,
  parseCaseContent,
  parseCaseTrigger,
  parseCommerceAction,
  parseConnectorDeliveryReceipt,
  parseEmailProposalEvidence,
  parseSessionProposal,
  parseTerminalDisposition,
} from "./record-parsers";
import type {
  AbandonAssignmentRequest,
  AcceptCommerceEntityPlaneProposalRequest,
  AcceptCommerceOutcomeRequest,
  AcceptCommerceProposalRequest,
  AcceptProposalRequest,
  BeginAssignmentRequest,
  CaseCommerceApprovalRecord,
  CaseEmailProposal,
  CaseEnsureRequest,
  CaseOutputDropReason,
  CommerceCaseAuthority,
  CommerceCaseProposal,
  CommerceEntityPlaneCaseProposal,
  ParsedAcceptCommerceProposalRequest,
  ParsedDeliveryReceiptRequest,
  PersistedCommerceProposal,
  PrepareOngoingCaseTurnRequest,
  ResolveCommerceApprovalRequest,
  SettleAssignmentRequest,
  WaitForCommerceApprovalRequest,
} from "./types";

export function parseCaseEnsureRequest(
  value: unknown,
): CaseEnsureRequest | null {
  const request = checked(caseEnsureRequestSchema, value);
  return request === null
    ? null
    : {
        identity: {
          organisationId: request.identity.organisationId,
          caseId: request.identity.caseId,
        },
        purpose: request.purpose,
        workspaceRevision: request.workspaceRevision,
        lifecycle: { kind: "open", openedAt: request.lifecycle.openedAt },
      };
}

export function parsePrepareOngoingCaseTurnRequest(
  value: unknown,
): PrepareOngoingCaseTurnRequest | null {
  if (!isRecord(value)) return null;
  const ensure = parseCaseEnsureRequest(value.ensure);
  const trigger = parseCaseTrigger(value.trigger);
  const binding = parseCaseBinding(value.binding);
  return ensure === null || trigger === null || binding === null
    ? null
    : { ensure, trigger, binding };
}

export function parseBeginAssignmentRequest(
  value: unknown,
): BeginAssignmentRequest | null {
  const request = checked(beginAssignmentRequestSchema, value);
  if (request === null) return null;
  const start = parseAssignmentStart(request.start);
  return start === null
    ? null
    : {
        caseId: request.caseId,
        assignmentId: request.assignmentId,
        sessionId: request.sessionId,
        expectedCaseRevision: request.expectedCaseRevision,
        start,
      };
}

export function parseAbandonAssignmentRequest(
  value: unknown,
): AbandonAssignmentRequest | null {
  const request = checked(abandonAssignmentRequestSchema, value);
  if (request === null) return null;
  if ((request.expectedState === "running") !== (request.expectedStartId !== null))
    return null;
  return {
    caseId: request.caseId,
    assignmentId: request.assignmentId,
    sessionId: request.sessionId,
    expectedCaseRevision: request.expectedCaseRevision,
    expectedState: request.expectedState,
    expectedStartId: request.expectedStartId,
    proof: {
      kind: request.proof.kind,
      sessionId: request.proof.sessionId,
      inspectedAt: request.proof.inspectedAt,
    },
    minimumAgeMs: request.minimumAgeMs,
    abandonedAt: request.abandonedAt,
  };
}

export function parseSettleAssignmentRequest(
  value: unknown,
): SettleAssignmentRequest | null {
  const request = checked(settleAssignmentRequestSchema, value);
  if (request === null) return null;
  const disposition = parseTerminalDisposition(request.disposition);
  return disposition === null
    ? null
    : {
        caseId: request.caseId,
        assignmentId: request.assignmentId,
        sessionId: request.sessionId,
        expectedCaseRevision: request.expectedCaseRevision,
        expectedStartId: request.expectedStartId,
        disposition,
      };
}

export async function parseAcceptProposalRequest(
  value: unknown,
): Promise<AcceptProposalRequest | null> {
  if (!isRecord(value) || !integer(value.acceptedAt)) return null;
  const proposal = parseSessionProposal(value.proposal);
  const requestAuthority = parseStoredRequestAuthority(value.requestAuthority);
  if (
    proposal === null ||
    !requestAuthority.ok ||
    value.flowBinding === undefined
  )
    return null;
  const flowBinding = await FlowBinding.restore(value.flowBinding);
  return flowBinding.ok
    ? {
        proposal,
        requestAuthority: requestAuthority.value.requestAuthority,
        acceptedAt: value.acceptedAt,
        flowBinding: flowBinding.value,
      }
    : null;
}

export async function parseAcceptCommerceProposalRequest(
  value: unknown,
): Promise<ParsedAcceptCommerceProposalRequest | null> {
  if (!isRecord(value) || !integer(value.acceptedAt)) return null;
  const proposal = parseCommerceCaseProposal(value.proposal);
  if (proposal === null) return null;
  if (proposal.origin.kind === "merchant_control") {
    if (
      value.flowBinding !== undefined ||
      value.authorityPartition === undefined
    )
      return null;
    const partition = parseStoredAuthorityPartition(value.authorityPartition);
    return partition.ok &&
      (await isCurrentAuthorityPartition(
        proposal.requestAuthority,
        partition.value,
      ))
      ? {
          kind: "merchant_input",
          proposal: { ...proposal, origin: proposal.origin },
          acceptedAt: value.acceptedAt,
          authorityPartition: partition.value,
        }
      : null;
  }
  if (value.flowBinding === undefined) return null;
  const toolCallId = value.toolCallId;
  if (
    toolCallId !== undefined &&
    (!isNonBlankString(toolCallId) || toolCallId.length > 200)
  )
    return null;
  const turnId = value.turnId;
  if (
    turnId !== undefined &&
    (!isNonBlankString(turnId) || turnId.length > 200)
  )
    return null;
  const flowBinding = await FlowBinding.restore(value.flowBinding);
  return flowBinding.ok
    ? {
        kind: "agent_bound",
        proposal: { ...proposal, origin: proposal.origin },
        acceptedAt: value.acceptedAt,
        flowBinding: flowBinding.value,
        ...(toolCallId === undefined ? {} : { toolCallId }),
        ...(turnId === undefined ? {} : { turnId }),
      }
    : null;
}

export async function parseAcceptCommerceEntityPlaneProposalRequest(
  value: unknown,
): Promise<AcceptCommerceEntityPlaneProposalRequest | null> {
  if (
    !isRecord(value) ||
    !integer(value.acceptedAt) ||
    value.flowBinding === undefined
  )
    return null;
  const proposal = parseCommerceEntityPlaneCaseProposal(value.proposal);
  if (proposal === null) return null;
  const flowBinding = await FlowBinding.restore(value.flowBinding);
  return flowBinding.ok
    ? { proposal, acceptedAt: value.acceptedAt, flowBinding: flowBinding.value }
    : null;
}

export function isEntityPlaneCommerceProposalRequest(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    isRecord(value.proposal) &&
    value.proposal.kind === "entity_plane"
  );
}

export function commerceMutationMatchesProposal(
  execution: ActionMutationExecution,
  input:
    AcceptCommerceProposalRequest | AcceptCommerceEntityPlaneProposalRequest,
): boolean {
  const proposal = input.proposal;
  if (proposal.requestAuthority.organisationId !== execution.organisationId)
    return false;
  switch (execution.kind) {
    case "control_session":
      return (
        proposal.origin.kind === "merchant_control" &&
        proposal.origin.userId === execution.userId &&
        proposal.origin.controlSessionId === execution.controlSessionId
      );
    case "session_turn":
      return (
        proposal.origin.kind === "agent_session" &&
        proposal.origin.sessionId === execution.execution.sessionId &&
        input.flowBinding.turnId === execution.execution.turnId &&
        equal(proposal.requestAuthority, execution.execution.requestAuthority)
      );
    case "slack_approver":
      // A Slack approver approves a proposal; it never makes one.
      return false;
    default:
      return assertNever(execution);
  }
}

export async function bindMerchantCommerceProposal(
  db: OrganisationDatabase,
  input: Variant<ParsedAcceptCommerceProposalRequest, "merchant_input">,
  proposalDigest: string,
): Promise<AcceptCommerceProposalRequest | null> {
  const label = await flowLabelForAuthority(
    db,
    input.proposal.requestAuthority,
  );
  if (label === null) return null;
  const initial = await InformationFlowContext.create({
    organisationId: input.proposal.requestAuthority.organisationId,
    sessionId: input.proposal.origin.controlSessionId,
    authorityPartitionDigest: input.authorityPartition.digest,
  });
  if (!initial.ok) return null;
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "case_entry",
      caseId: input.proposal.caseId,
      entryId: `commerce_proposal:${input.proposal.proposalId}`,
    },
    sourceRevision: input.proposal.basedOnRevision + 1,
    contentDigest: proposalDigest,
    inputLabel: label,
    observedAt: input.acceptedAt,
  });
  if (!evidence.ok) return null;
  const advanced = await advanceInformationFlowContext({
    context: initial.value,
    observation: evidence.value,
    inputLabel: label,
  });
  return advanced.ok
    ? {
        proposal: input.proposal,
        acceptedAt: input.acceptedAt,
        flowBinding: flowBindingForContext(
          advanced.value.context,
          `merchant:${input.proposal.proposalId}`,
        ),
      }
    : null;
}

export function readCaseMetaId(sql: SqlStorage): string | null {
  const row = sql
    .exec<{ case_id: string }>(
      "SELECT case_id FROM case_meta WHERE singleton = 1",
    )
    .toArray()[0];
  return row?.case_id ?? null;
}

export function parseCaseEmailProposal(
  value: unknown,
): CaseEmailProposal | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  if ((value as Record<string, unknown>).kind === "operational_new_message") {
    const proposal = checked(operationalEmailProposalSchema, value);
    if (proposal === null) return null;
    const lifecycle = parseEmailReplyProposalLifecycle(proposal.lifecycle);
    const target = parseEmailProposalTarget(proposal.target);
    if (!lifecycle.ok || target === null) return null;
    return {
      kind: "operational_new_message",
      proposalId: proposal.proposalId,
      version: proposal.version,
      caseId: proposal.caseId,
      integrationAccountId: proposal.integrationAccountId,
      target,
      targetDigest: proposal.targetDigest,
      subjectDigest: proposal.subjectDigest,
      bodyDigest: proposal.bodyDigest,
      snapshotDigest: proposal.snapshotDigest,
      policyVersion: proposal.policyVersion,
      credentialGeneration: proposal.credentialGeneration,
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
      lifecycle: lifecycle.value,
    };
  }
  const proposal = checked(replyEmailProposalSchema, value);
  if (proposal === null) return null;
  const lifecycle = parseEmailReplyProposalLifecycle(proposal.lifecycle);
  const evidence = parseEmailProposalEvidence(proposal.evidence);
  if (!lifecycle.ok || evidence === null) return null;
  return {
    proposalId: proposal.proposalId,
    version: proposal.version,
    caseId: proposal.caseId,
    threadId: proposal.threadId,
    providerDraftId: proposal.providerDraftId,
    evidence,
    providerDraftMessageId: proposal.providerDraftMessageId,
    triggeringProviderMessageId: proposal.triggeringProviderMessageId,
    mailboxBindingId: proposal.mailboxBindingId,
    bindingRevision: proposal.bindingRevision,
    policyVersion: proposal.policyVersion,
    targetDigest: proposal.targetDigest,
    bodyDigest: proposal.bodyDigest,
    snapshotDigest: proposal.snapshotDigest,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    lifecycle: lifecycle.value,
  };
}

export function parseCaseEmailProposalJson(
  payload: string,
): CaseEmailProposal | null {
  try {
    return parseCaseEmailProposal(JSON.parse(payload));
  } catch {
    return null;
  }
}

export function parseWaitForCommerceApprovalRequest(
  value: unknown,
): WaitForCommerceApprovalRequest | null {
  const request = checked(waitForCommerceApprovalRequestSchema, value);
  return request === null
    ? null
    : {
        caseId: request.caseId,
        proposalId: request.proposalId,
        actionNonce: request.actionNonce,
        expectedCaseRevision: request.expectedCaseRevision,
        requestedAt: request.requestedAt,
      };
}

export function parseResolveCommerceApprovalRequest(
  value: unknown,
): ResolveCommerceApprovalRequest | null {
  const request = checked(resolveCommerceApprovalRequestSchema, value);
  if (request === null) return null;
  const decision = parseMerchantActionDecision(request.decision);
  return decision.ok
    ? {
        caseId: request.caseId,
        proposalId: request.proposalId,
        actionNonce: request.actionNonce,
        decision: decision.value,
      }
    : null;
}

export function parseCaseCommerceApprovalRecordJson(
  value: string,
): CaseCommerceApprovalRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  const record = checked(commerceApprovalRecordSchema, raw);
  if (record === null) return null;
  const fields = record as typeof record & Record<string, unknown>;
  const request = parseWaitForCommerceApprovalRequest(record.request);
  if (request === null) return null;
  if (fields.kind === "waiting") return { kind: "waiting", request };
  if (fields.kind === "lapsed")
    return integer(fields.lapsedAt)
      ? { kind: "lapsed", request, lapsedAt: fields.lapsedAt }
      : null;
  if (fields.kind !== "decided") return null;
  const decision = parseMerchantActionDecision(fields.decision);
  return decision.ok
    ? { kind: "decided", request, decision: decision.value }
    : null;
}

export function merchantDecisionMatchesAction(
  decision: MerchantActionDecision,
  organisationId: string,
  actionNonce: string,
): boolean {
  switch (decision.kind) {
    case "approved":
      return (
        decision.evidence.authentication.challenge.organisationId ===
          organisationId &&
        decision.evidence.authentication.challenge.actionNonce === actionNonce
      );
    case "rejected":
      return (
        decision.evidence.decision.action.organisationId === organisationId &&
        decision.evidence.decision.action.actionNonce === actionNonce
      );
    default:
      return assertNeverDecision(decision);
  }
}

function assertNeverDecision(value: never): false {
  void value;
  return false;
}

function parseCommerceCaseProposal(
  value: unknown,
): CommerceCaseProposal | null {
  const envelope = checked(commerceCaseProposalSchema, value);
  if (envelope === null || !isRecord(value)) return null;
  const origin = parseCommerceProposalOrigin(
    envelope.origin as Record<string, unknown>,
  );
  if (origin === null) return null;
  const requestAuthority = parseStoredRequestAuthority(value.requestAuthority);
  const action = parseCommerceAction(value.action);
  if (!requestAuthority.ok || action === null) return null;
  if (
    action.kind === "submit_supplier_payout" ||
    action.kind === "resume_supplier_payout_funding"
  ) {
    const authority = checked(integrationAccountAuthoritySchema, value.authority);
    if (value.provenance !== null || authority === null) return null;
    const account = parseIntegrationAccountId(authority.integrationAccountId);
    if (!account.ok) return null;
    return {
      proposalId: envelope.proposalId,
      caseId: envelope.caseId,
      basedOnRevision: envelope.basedOnRevision,
      requestAuthority: requestAuthority.value.requestAuthority,
      action,
      authority: {
        kind: "integration_account",
        integrationAccountId: account.value,
      },
      provenance: null,
      origin,
    };
  }
  if (
    action.kind === "install_merchant_plugin" ||
    action.kind === "publish_cafe_menu" ||
    action.kind === "change_menu_price" ||
    action.kind === "refund_order" ||
    action.kind === "stock_operation"
  ) {
    const authority = parsePluginCaseAuthority(value.authority);
    if (value.provenance !== null || authority === null) return null;
    return {
      proposalId: envelope.proposalId,
      caseId: envelope.caseId,
      basedOnRevision: envelope.basedOnRevision,
      requestAuthority: requestAuthority.value.requestAuthority,
      action,
      authority,
      provenance: null,
      origin,
    };
  }
  const provenance = parseSourceProvenance(value.provenance);
  const authority =
    provenance === null
      ? null
      : parseCommerceCaseAuthority(value.authority, provenance);
  return !requestAuthority.ok ||
    action === null ||
    provenance === null ||
    authority === null
    ? null
    : {
        proposalId: envelope.proposalId,
        caseId: envelope.caseId,
        basedOnRevision: envelope.basedOnRevision,
        requestAuthority: requestAuthority.value.requestAuthority,
        action,
        authority,
        provenance,
        origin,
      };
}

// A merchant plugin lives in Pantry Commerce (Commerce); no source record
// names its integration account, so the authority stands on its own.
function parsePluginCaseAuthority(
  value: unknown,
): CommerceCaseAuthority | null {
  const authority = checked(commerceSystemAuthoritySchema, value);
  if (authority === null || authority.system !== "satyr_commerce") return null;
  const revision = parseCommerceSystemRevision(authority.revision);
  const integrationAccountId = parseIntegrationAccountId(
    authority.integrationAccountId,
  );
  return revision.ok && integrationAccountId.ok
    ? {
        kind: "commerce_system",
        system: "satyr_commerce",
        revision: revision.value,
        integrationAccountId: integrationAccountId.value,
      }
    : null;
}

function parseCommerceCaseAuthority(
  value: unknown,
  provenance: SourceProvenance,
): CommerceCaseAuthority | null {
  if (!isRecord(value)) return null;
  if (value.kind === "lab") {
    return provenance.source === "lab" ? { kind: "lab" } : null;
  }
  const authority = checked(commerceSystemAuthoritySchema, value);
  if (authority === null) return null;
  const revision = parseCommerceSystemRevision(authority.revision);
  const integrationAccountId = parseIntegrationAccountId(
    authority.integrationAccountId,
  );
  if (
    !revision.ok ||
    !integrationAccountId.ok ||
    integrationAccountId.value !== provenance.integrationAccountId ||
    (authority.system === "satyr_commerce" &&
      provenance.source !== "underclerk") ||
    (authority.system === "shopify" && provenance.source !== "shopify")
  ) {
    return null;
  }
  return {
    kind: "commerce_system",
    system: authority.system,
    revision: revision.value,
    integrationAccountId: integrationAccountId.value,
  };
}

function parseCommerceProposalOrigin(
  value: Record<string, unknown>,
): CommerceCaseProposal["origin"] | null {
  const origin = checked(commerceProposalOriginSchema, value);
  if (origin === null) return null;
  return origin.kind === "merchant_control"
    ? {
        kind: "merchant_control",
        userId: origin.userId,
        controlSessionId: origin.controlSessionId,
      }
    : {
        kind: "agent_session",
        sessionId: origin.sessionId,
        assignmentId: origin.assignmentId,
        threadId: origin.threadId,
      };
}

export function parseCommerceCaseProposalJson(
  value: string,
): CommerceCaseProposal | null {
  try {
    return parseCommerceCaseProposal(JSON.parse(value));
  } catch {
    return null;
  }
}

export function parsePersistedCommerceProposalJson(
  value: string,
): PersistedCommerceProposal | null {
  try {
    const decoded: unknown = JSON.parse(value);
    return isRecord(decoded) && decoded.kind === "entity_plane"
      ? parseCommerceEntityPlaneCaseProposal(decoded)
      : parseCommerceCaseProposal(decoded);
  } catch {
    return null;
  }
}

function parseCommerceEntityPlaneCaseProposal(
  value: unknown,
): CommerceEntityPlaneCaseProposal | null {
  const envelope = checked(commerceEntityPlaneCaseProposalSchema, value);
  if (envelope === null) return null;
  const fields = envelope as typeof envelope & Record<string, unknown>;
  const requestAuthority = parseStoredRequestAuthority(fields.requestAuthority);
  const proposal = parseCommerceEntityPlaneProposal(fields.proposal);
  const origin = parseCommerceProposalOrigin(
    envelope.origin as Record<string, unknown>,
  );
  return !requestAuthority.ok || proposal === null || origin === null
    ? null
    : {
        kind: "entity_plane",
        proposalId: envelope.proposalId,
        caseId: envelope.caseId,
        basedOnRevision: envelope.basedOnRevision,
        requestAuthority: requestAuthority.value.requestAuthority,
        proposal,
        origin,
      };
}

export function parseCommerceEntityPlaneCaseProposalJson(
  value: string,
): CommerceEntityPlaneCaseProposal | null {
  try {
    return parseCommerceEntityPlaneCaseProposal(JSON.parse(value));
  } catch {
    return null;
  }
}

export function parseCommerceProposalAcceptance(value: string): {
  readonly kind: "accepted" | "already_accepted";
  readonly revision: number;
  readonly acceptedAt: number;
} | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return null;
  }
  const acceptance = checked(commerceProposalAcceptanceSchema, decoded);
  if (acceptance === null) return null;
  const acceptedAt = (acceptance as Record<string, unknown>).acceptedAt;
  return {
    kind: "already_accepted",
    revision: acceptance.revision,
    acceptedAt: integer(acceptedAt) ? acceptedAt : 0,
  };
}

export function parseAcceptDeliveryReceiptRequest(
  value: unknown,
): ParsedDeliveryReceiptRequest | null {
  const request = checked(acceptDeliveryReceiptRequestSchema, value);
  if (request === null) return null;
  const receipt = parseConnectorDeliveryReceipt(request.receipt);
  return receipt === null ? null : { outputId: request.outputId, receipt };
}

type NoteRefusedEffectRequest = Readonly<{
  requestId: string;
  organisationId: string;
  reason: CaseOutputDropReason;
  requestAuthority: RequestAuthority;
  authorityPartitionDigest: string;
  notedAt: number;
}>;

export function parseNoteRefusedEffectRequest(
  value: unknown,
): NoteRefusedEffectRequest | null {
  const request = checked(noteRefusedEffectRequestSchema, value);
  if (request === null) return null;
  const authority = parseStoredRequestAuthority(request.requestAuthority);
  return authority.ok
    ? {
        requestId: request.requestId,
        organisationId: request.organisationId,
        reason: request.reason,
        requestAuthority: authority.value.requestAuthority,
        authorityPartitionDigest: request.authorityPartitionDigest,
        notedAt: request.notedAt,
      }
    : null;
}

export type DropHeldOutputRequest = Readonly<{
  outputId: string;
  reason: CaseOutputDropReason;
  requestAuthority: RequestAuthority;
  droppedAt: number;
}>;

export function parseDropHeldOutputRequest(
  value: unknown,
): DropHeldOutputRequest | null {
  const request = checked(dropHeldOutputRequestSchema, value);
  if (request === null) return null;
  const authority = parseStoredRequestAuthority(request.requestAuthority);
  return authority.ok
    ? {
        outputId: request.outputId,
        reason: request.reason,
        requestAuthority: authority.value.requestAuthority,
        droppedAt: request.droppedAt,
      }
    : null;
}

export function parseAcceptCommerceOutcomeRequest(
  value: unknown,
): AcceptCommerceOutcomeRequest | null {
  const request = checked(acceptCommerceOutcomeRequestSchema, value);
  if (request === null) return null;
  const outcome = parseCommerceCaseOutcome(request.outcome);
  const content = parseCaseContent(request.content);
  return outcome === null || content === null || content.kind !== "text"
    ? null
    : {
        caseId: request.caseId,
        proposalId: request.proposalId,
        actionNonce: request.actionNonce,
        outcome,
        content,
        acceptedAt: request.acceptedAt,
      };
}

function parseCommerceCaseOutcome(
  value: unknown,
): AcceptCommerceOutcomeRequest["outcome"] | null {
  const outcome = checked(commerceCaseOutcomeSchema, value);
  if (outcome === null) return null;
  switch (outcome.kind) {
    case "provider_receipt": {
      const receipt = parseCommerceProviderReceipt(outcome.receipt);
      return receipt.ok
        ? { kind: "provider_receipt", receipt: receipt.value }
        : null;
    }
    case "merchant_rejection": {
      const evidence = parseMerchantActionRejectionEvidence(outcome.evidence);
      return evidence.ok
        ? { kind: "merchant_rejection", evidence: evidence.value }
        : null;
    }
    case "execution_failure":
      return { kind: "execution_failure", actionNonce: outcome.actionNonce };
  }
}

export function commerceOutcomeMatchesAction(
  outcome: AcceptCommerceOutcomeRequest["outcome"],
  organisationId: string,
  actionNonce: string,
): boolean {
  switch (outcome.kind) {
    case "provider_receipt":
      return outcome.receipt.actionNonce === actionNonce;
    case "merchant_rejection":
      return (
        outcome.evidence.decision.action.actionNonce === actionNonce &&
        outcome.evidence.decision.action.organisationId === organisationId
      );
    case "execution_failure":
      return outcome.actionNonce === actionNonce;
    default:
      return assertNeverCommerceOutcome(outcome);
  }
}

function assertNeverCommerceOutcome(value: never): false {
  void value;
  return false;
}
