import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { readAdmittedChatInput } from "../../chat/turn-access";
import { parseGoalIdentity } from "../case-goals";
import { parseSourceProvenance } from "./source-provenance";
import { parseCaseEvidenceDependency } from "../../case-context-discovery/evidence";
import { parseMessageCaseContent } from "../case-content";
import type {
  AuthorityPartition,
  CaseAssignment,
  CaseAssignmentLifecycle,
  CaseAssignmentStart,
  CaseAssignmentTerminalDisposition,
  CaseBinding,
  CaseContent,
  CaseContextEntryRef,
  CaseJournalCursor,
  CaseLifecycle,
  CaseProposalRejection,
  CaseTrigger,
  CaseOutput as ContractCaseOutput,
  RequestAuthority,
  SessionProposal,
  SessionProposalDisposition,
  StoredMessageAttachment,
} from "@purin-labs/contracts";
import { parseStoredAttachmentList } from "../../messages/stored-attachment";
import { parseStoredAuthorityPartition } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import { parseStoredRequestAuthority } from "@purin-labs/authority/request-authority/index";
import { FlowLabel } from "@purin-labs/authority/policy/index";
import { caseParts } from "./parts";
import type { Variant } from "@purin-labs/type-utils";
import {
  checked,
  connectorDeliverySchema,
  parseConnectorAddressWire,
} from "@purin-labs/contracts/connector-rpc";
import {
  assignmentLifecycleSchema,
  assignmentStartSchema,
  caseAssignmentSchema,
  caseBindingSchema,
  caseContributionSourceSchema,
  caseDeliveryReceiptSchema,
  caseLifecycleSchema,
  caseOutputSchema,
  caseProposalAcceptanceSchema,
  caseTriggerSchema,
  caseTriggerSourceSchema,
  contextEntrySchema,
  droppedOutputSchema,
  heldOutputSchema,
  rejectedOutputSchema,
  goalMessageSchema,
  journalCursorSchema,
  outputLifecycleSchema,
  proposalDispositionSchema,
  proposedEffectSchema,
  proposedEntrySchema,
  sessionProposalSchema,
  terminalDispositionSchema,
} from "@purin-labs/contracts/case-rpc";
import { isRecord } from "@purin-labs/std";
import { flowLabelForAuthority } from "./context-source";
import {
  type CaseContributionSource,
  type CaseResult,
  type CaseTriggerRecord,
  type ConnectorDeliveryReceipt,
  MAX_TRIGGER_TITLE,
  type RawCaseOutput,
  type RawCaseOutputLifecycle,
  type RawCaseProposalAcceptance,
} from "./types";

export function parseCaseTrigger(value: unknown): CaseTriggerRecord | null {
  const trigger = checked(caseTriggerSchema, value);
  if (trigger === null) return null;
  const record = trigger as typeof trigger & Record<string, unknown>;
  const content = parseCaseContent(record.content);
  const source = parseCaseTriggerSource(
    trigger.source as Record<string, unknown>,
  );
  const authority = parseStoredRequestAuthority(record.requestAuthority);
  if (
    content?.kind === "record_message" &&
    authority.ok &&
    content.provenance.organisationId !==
      authority.value.requestAuthority.organisationId
  )
    return null;
  const attachments =
    record.attachments === undefined
      ? { ok: true, value: [] as readonly StoredMessageAttachment[] }
      : parseStoredAttachmentList(record.attachments);
  const title = trigger.title;
  if (title !== undefined && title.length > MAX_TRIGGER_TITLE) return null;
  return content === null || source === null || !authority.ok || !attachments.ok
    ? null
    : {
        triggerId: trigger.triggerId,
        caseId: trigger.caseId,
        source,
        requestAuthority: authority.value.requestAuthority,
        content,
        acceptedAt: trigger.acceptedAt,
        attachments: attachments.value,
        ...(title === undefined ? {} : { title }),
      };
}

function parseCaseTriggerSource(
  value: Record<string, unknown>,
): CaseTrigger["source"] | null {
  const source = checked(caseTriggerSourceSchema, value);
  if (source === null) return null;
  switch (source.kind) {
    case "connector":
      return {
        kind: "connector",
        connectorId: source.connectorId,
        ingressId: source.ingressId,
      };
    case "cue":
      return { kind: "cue", eventId: source.eventId };
    case "api":
      return { kind: "api", commandId: source.commandId };
  }
}

export function parseCaseBindingJson(value: string): CaseBinding | null {
  try {
    return parseCaseBinding(JSON.parse(value));
  } catch {
    return null;
  }
}

export function parseCaseBinding(value: unknown): CaseBinding | null {
  const binding = checked(caseBindingSchema, value);
  if (binding === null) return null;
  const address = parseConnectorAddress(
    (value as Record<string, unknown>).address,
  );
  if (address === null) return null;
  return {
    bindingId: binding.bindingId,
    caseId: binding.caseId,
    connectorId: binding.connectorId,
    address,
  };
}

function parseConnectorAddress(
  value: unknown,
): CaseBinding["address"] | null {
  return parseConnectorAddressWire(value);
}

export function parseAssignmentLifecycleJson(
  value: string,
): CaseAssignmentLifecycle | null {
  try {
    return parseAssignmentLifecycle(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseAssignmentLifecycle(
  value: unknown,
): CaseAssignmentLifecycle | null {
  const lifecycle = checked(assignmentLifecycleSchema, value);
  if (lifecycle === null) return null;
  const record = lifecycle as typeof lifecycle & Record<string, unknown>;
  const assignment = parseCaseAssignment(record.assignment);
  if (assignment === null) return null;
  if (lifecycle.kind === "assigned") return { kind: "assigned", assignment };
  const start = parseAssignmentStart(record.start);
  if (start === null || start.sessionId !== assignment.sessionId) return null;
  if (lifecycle.kind === "running") return { kind: "running", assignment, start };
  if (lifecycle.kind === "settled") {
    const disposition = parseTerminalDisposition(record.disposition);
    return disposition === null
      ? null
      : { kind: "settled", assignment, start, disposition };
  }
  return null;
}

export function parseAssignmentStart(
  value: unknown,
): CaseAssignmentStart | null {
  const start = checked(assignmentStartSchema, value);
  return start === null
    ? null
    : {
        startId: start.startId,
        sessionId: start.sessionId,
        acceptedAt: start.acceptedAt,
      };
}

export function parseTerminalDisposition(
  value: unknown,
): CaseAssignmentTerminalDisposition | null {
  const disposition = checked(terminalDispositionSchema, value);
  if (disposition === null) return null;
  switch (disposition.kind) {
    case "completed":
      return {
        kind: "completed",
        proposalId: disposition.proposalId,
        settledAt: disposition.settledAt,
      };
    case "cancelled":
      return {
        kind: "cancelled",
        commandId: disposition.commandId,
        settledAt: disposition.settledAt,
      };
    case "failed":
      return {
        kind: "failed",
        code: disposition.code,
        settledAt: disposition.settledAt,
      };
    case "budget_exhausted":
      return {
        kind: "budget_exhausted",
        exhaustionId: disposition.exhaustionId,
        dimension: disposition.dimension,
        settledAt: disposition.settledAt,
      };
    case "abandoned":
      return {
        kind: "abandoned",
        reason: disposition.reason,
        settledAt: disposition.settledAt,
      };
  }
}

export function parseCaseAssignment(value: unknown): CaseAssignment | null {
  const assignment = checked(caseAssignmentSchema, value);
  if (
    assignment === null ||
    !["coordinator", "research", "specialist"].includes(
      String(assignment.role),
    ) ||
    !["read_and_propose", "approved_provider_writes"].includes(
      String(assignment.authority.capabilityProfile),
    )
  )
    return null;
  const { context } = assignment;
  const cursor = parseCursor(
    context.journalCursor as Record<string, unknown>,
  );
  const entries = context.entries.map(parseContextEntry);
  const authorityPartition = parseAuthorityPartition(
    assignment.authorityPartition,
  );
  const evidenceDependency = parseCaseEvidenceDependency(
    context.evidenceDependency,
  );
  if (
    cursor === null ||
    evidenceDependency === null ||
    entries.some((entry) => entry === null) ||
    authorityPartition === null ||
    authorityPartition.digest !== assignment.authority.authorityPartitionDigest
  )
    return null;
  if (
    evidenceDependency.kind === "case_context_collection_evidence" &&
    (authorityPartition.key.kind !== "agent_mailbox" ||
      authorityPartition.key.replyScope.kind !==
        "case_context_collection_evidence" ||
      authorityPartition.key.replyScope.recipientDigest !==
        evidenceDependency.recipientDigest ||
      authorityPartition.key.replyScope.dependencyDigest !==
        evidenceDependency.dependencyDigest)
  )
    return null;

  return {
    assignmentId: assignment.assignmentId,
    caseId: assignment.caseId,
    caseRevision: assignment.caseRevision,
    sessionId: assignment.sessionId,
    role:
      String(assignment.role) === "coordinator"
        ? "coordinator"
        : String(assignment.role) === "research"
          ? "research"
          : "specialist",
    objective: { instruction: assignment.objective.instruction },
    authority: {
      capabilityProfile:
        assignment.authority.capabilityProfile === "read_and_propose"
          ? "read_and_propose"
          : "approved_provider_writes",
      authorityPartitionDigest: assignment.authority.authorityPartitionDigest,
    },
    authorityPartition,
    budget: {
      budgetRevision: assignment.budget.budgetRevision,
      maxTokens: assignment.budget.maxTokens,
      maxWallMs: assignment.budget.maxWallMs,
      maxToolCalls: assignment.budget.maxToolCalls,
    },
    context: {
      caseId: context.caseId,
      revision: context.revision,
      journalCursor: cursor,
      workspaceRevision: context.workspaceRevision,
      entries: entries.filter(isPresent),
      evidenceDependency,
    },
  };
}

function parseAuthorityPartition(
  value: unknown,
): AuthorityPartition | null {
  const parsed = parseStoredAuthorityPartition(value);
  return parsed.ok ? parsed.value : null;
}

export function parseSessionProposalJson(
  value: string,
): SessionProposal | null {
  try {
    return parseSessionProposal(JSON.parse(value));
  } catch {
    return null;
  }
}

export function parseSessionProposal(value: unknown): SessionProposal | null {
  const proposal = checked(sessionProposalSchema, value);
  if (proposal === null) return null;
  const entries = proposal.entries.map(parseProposedEntry);
  const effects = proposal.requestedEffects.map(parseProposedEffect);
  return entries.some((entry) => entry === null) ||
    effects.some((effect) => effect === null)
    ? null
    : {
        proposalId: proposal.proposalId,
        assignmentId: proposal.assignmentId,
        caseId: proposal.caseId,
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
        basedOnRevision: proposal.basedOnRevision,
        entries: entries.filter(isPresent),
        requestedEffects: effects.filter(isPresent),
      };
}

export function parseCaseProposalAcceptanceJson(
  value: string,
): RawCaseProposalAcceptance | null {
  try {
    return parseCaseProposalAcceptance(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseCaseProposalAcceptance(
  value: unknown,
): RawCaseProposalAcceptance | null {
  const acceptance = checked(caseProposalAcceptanceSchema, value);
  if (acceptance === null) return null;
  const disposition = parseDisposition(acceptance.disposition);
  const outputs = acceptance.outputs.map(parseCaseOutput);
  return disposition === null || outputs.some((output) => output === null)
    ? null
    : { disposition, outputs: outputs.filter(isPresent) };
}

export function parseOutputLifecycleJson(
  value: string,
): RawCaseOutputLifecycle | null {
  try {
    return parseOutputLifecycle(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseOutputLifecycle(
  value: unknown,
): RawCaseOutputLifecycle | null {
  const lifecycle = checked(outputLifecycleSchema, value);
  if (lifecycle === null) return null;
  const output = parseCaseOutput(lifecycle.output);
  if (output === null) return null;
  if (lifecycle.kind === "pending") return { kind: "pending", output };
  if (lifecycle.kind === "settled") {
    const receipt = parseConnectorDeliveryReceipt(
      (value as Record<string, unknown>).receipt,
    );
    return receipt === null ? null : { kind: "settled", output, receipt };
  }
  if (lifecycle.kind === "held") {
    const held = checked(heldOutputSchema, value);
    return held === null
      ? null
      : {
          kind: "held",
          output,
          requestId: held.requestId,
          heldAt: held.heldAt,
        };
  }
  if (lifecycle.kind === "rejected") {
    const rejected = checked(rejectedOutputSchema, value);
    return rejected === null
      ? null
      : {
          kind: "rejected",
          output,
          reason: rejected.reason,
          rejectedAt: rejected.rejectedAt,
        };
  }
  const dropped =
    lifecycle.kind === "dropped" ? checked(droppedOutputSchema, value) : null;
  return dropped === null
    ? null
    : {
        kind: "dropped",
        output,
        reason: dropped.reason,
        droppedAt: dropped.droppedAt,
      };
}

function parseCaseContributionSource(
  value: unknown,
): CaseContributionSource | null {
  const source = checked(caseContributionSourceSchema, value);
  if (source === null) return null;
  switch (source.kind) {
    case "operator_command":
      return {
        kind: "operator_command",
        commandId: source.commandId,
        requestDigest: source.requestDigest,
      };
    case "agent_turn":
      return {
        kind: "agent_turn",
        assignmentId: source.assignmentId,
        sessionId: source.sessionId,
        turnId: source.turnId,
        proposalId: source.proposalId,
      };
    case "commerce_outcome":
      return {
        kind: "commerce_outcome",
        proposalId: source.proposalId,
        actionNonce: source.actionNonce,
      };
    case "commerce_approval_notice":
      return {
        kind: "commerce_approval_notice",
        proposalId: source.proposalId,
        actionNonce: source.actionNonce,
      };
  }
}

function parseCaseOutput(value: unknown): RawCaseOutput | null {
  const output = checked(caseOutputSchema, value);
  if (output === null || output.flowBinding === undefined) return null;
  const delivery = parseConnectorDelivery(output.delivery);
  const source = parseCaseContributionSource(output.source);
  return delivery === null || source === null
    ? null
    : {
        outputId: output.outputId,
        source,
        entryId: output.entryId,
        connectorId: output.connectorId,
        flowBinding: output.flowBinding as RawCaseOutput["flowBinding"],
        delivery,
      };
}

function parseConnectorDelivery(
  value: unknown,
): ContractCaseOutput["delivery"] | null {
  const delivery = checked(connectorDeliverySchema, value);
  if (delivery === null) return null;
  const content = parseCaseContent(delivery.content);
  const address = parseConnectorAddress(delivery.address);
  return content === null || address === null
    ? null
    : {
        deliveryId: delivery.deliveryId,
        bindingId: delivery.bindingId,
        address,
        caseId: delivery.caseId,
        caseRevision: delivery.caseRevision,
        content,
        idempotencyKey: delivery.idempotencyKey,
        addressedAt: delivery.addressedAt,
      };
}

export function parseConnectorDeliveryReceipt(
  value: unknown,
): ConnectorDeliveryReceipt | null {
  const receipt = checked(caseDeliveryReceiptSchema, value);
  return receipt === null
    ? null
    : {
        deliveryId: receipt.deliveryId,
        connectorId: receipt.connectorId,
        idempotencyKey: receipt.idempotencyKey,
        nativeReceiptId: receipt.nativeReceiptId,
        deliveredAt: receipt.deliveredAt,
        flowBindingDigest: receipt.flowBindingDigest,
        decisionDigest: receipt.decisionDigest,
      };
}

function parseContextEntry(value: unknown): CaseContextEntryRef | null {
  const entry = checked(contextEntrySchema, value);
  if (entry === null) return null;
  return entry.kind === "inline_preview"
    ? {
        kind: "inline_preview",
        entryId: entry.entryId,
        digest: entry.digest,
        preview: entry.preview,
      }
    : {
        kind: "artifact",
        entryId: entry.entryId,
        digest: entry.digest,
        artifact: {
          id: entry.artifact.id,
          kind: entry.artifact.kind,
          url: entry.artifact.url,
        },
      };
}

function parseProposedEffect(
  value: unknown,
): SessionProposal["requestedEffects"][number] | null {
  const effect = checked(proposedEffectSchema, value);
  return effect === null
    ? null
    : {
        effectId: effect.effectId,
        policyVersion: effect.policyVersion,
        stakes: effect.stakes,
      };
}

function parseProposedEntry(
  value: unknown,
): SessionProposal["entries"][number] | null {
  const entry = checked(proposedEntrySchema, value);
  if (entry === null) return null;
  const content = parseCaseContent(entry.content);
  if (content === null) return null;
  if (entry.kind === "observation")
    return { kind: "observation", entryId: entry.entryId, content };
  return integer(entry.baseRevision)
    ? {
        kind: "shared_change",
        entryId: entry.entryId,
        baseRevision: entry.baseRevision,
        content,
      }
    : null;
}

export function parseCaseContent(value: unknown): CaseContent | null {
  if (!isRecord(value)) return null;
  if (value.kind === "user_message" || value.kind === "record_message") {
    return parseMessageCaseContent(value);
  }
  if (
    value.kind === "text" &&
    typeof value.text === "string" &&
    value.text.trim().length > 0
  ) {
    return { kind: "text", text: value.text };
  }
  if (value.kind === "commerce_reference") {
    const provenance = parseSourceProvenance(value.provenance);
    return provenance === null
      ? null
      : { kind: "commerce_reference", provenance };
  }
  if (value.kind !== "entity_plane_proposal") return null;
  const proposal = caseParts().commerce.parseEntityPlaneCommand(
    value.proposal,
  );
  return proposal === null ? null : { kind: "entity_plane_proposal", proposal };
}

function parseCursor(
  value: Record<string, unknown>,
): CaseJournalCursor | null {
  const cursor = checked(journalCursorSchema, value);
  if (cursor === null) return null;
  return cursor.kind === "before_first"
    ? { kind: "before_first" }
    : {
        kind: "accepted",
        sequence: cursor.sequence,
        entryDigest: cursor.entryDigest,
      };
}

function parseDisposition(
  value: unknown,
): SessionProposalDisposition | null {
  const disposition = checked(proposalDispositionSchema, value);
  if (disposition === null) return null;
  if (disposition.kind !== "rejected")
    return { kind: disposition.kind, revision: disposition.revision };
  // A stored reason is read with String(), as the first parser read it.
  const reason = String(disposition.reason);
  return reason === "assignment_missing" ||
    reason === "assignment_mismatch" ||
    reason === "session_mismatch" ||
    reason === "empty_proposal" ||
    reason === "invalid_entry" ||
    reason === "case_not_open"
    ? { kind: "rejected", reason }
    : null;
}

export function parseLifecycle(value: string): CaseLifecycle | null {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  const lifecycle = checked(caseLifecycleSchema, raw);
  if (lifecycle === null) return null;
  switch (lifecycle.kind) {
    case "open":
      return { kind: "open", openedAt: lifecycle.openedAt };
    case "waiting": {
      const wait = lifecycle.wait;
      switch (wait.kind) {
        case "input":
          return { kind: "waiting", wait: { kind: "input", triggerId: wait.triggerId } };
        case "approval":
          return {
            kind: "waiting",
            wait: { kind: "approval", approvalRequestId: wait.approvalRequestId },
          };
        case "schedule":
          return {
            kind: "waiting",
            wait: { kind: "schedule", scheduleId: wait.scheduleId },
          };
      }
    }
    case "completing":
      return { kind: "completing", startedAt: lifecycle.startedAt };
    case "completed":
      return { kind: "completed", completedAt: lifecycle.completedAt };
    case "quarantined":
      return {
        kind: "quarantined",
        reason: lifecycle.reason,
        quarantinedAt: lifecycle.quarantinedAt,
      };
    case "archived":
      return { kind: "archived", archivedAt: lifecycle.archivedAt };
  }
}

export function proposalDisposition(
  reason: CaseProposalRejection,
): CaseResult<RawCaseProposalAcceptance> {
  return {
    ok: true,
    value: { disposition: { kind: "rejected", reason }, outputs: [] },
  };
}

export function invalid<T>(code: string): CaseResult<T> {
  return { ok: false, error: { code } };
}

export function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function isOpen(value: string): boolean {
  return parseLifecycle(value)?.kind === "open";
}

export function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

export async function flowLabelForTrigger(
  scope: OrganisationExecutionScope,
  trigger: CaseTriggerRecord,
): Promise<FlowLabel | null> {
  if (trigger.requestAuthority.kind === "control") {
    const admitted = await readAdmittedChatInput(
      scope.database,
      trigger.requestAuthority,
      `turn_${trigger.triggerId}`,
    );
    if (admitted !== null) return admitted.inputLabel;
  }
  return flowLabelForAuthority(scope.database, trigger.requestAuthority);
}

export type GoalMessage = {
  readonly organisationId: string;
  readonly caseId: string;
  readonly commandId: string;
  readonly text: string;
  readonly requestAuthority: Variant<
    RequestAuthority,
    "direct_conversation" | "shared_conversation"
  >;
  readonly authorityPartition: AuthorityPartition;
  readonly support: "pi" | "unavailable";
  readonly acceptedAt: number;
};

export function parseGoalMessage(raw: unknown): GoalMessage | null {
  const identity = parseGoalIdentity(raw);
  const message = checked(goalMessageSchema, raw);
  if (
    identity === null ||
    message === null ||
    message.commandId.length > 256 ||
    message.text.length > 8192
  )
    return null;
  const authority = parseStoredRequestAuthority(message.requestAuthority);
  const partition = parseAuthorityPartition(message.authorityPartition);
  if (
    !authority.ok ||
    (authority.value.requestAuthority.kind !== "direct_conversation" &&
      authority.value.requestAuthority.kind !== "shared_conversation") ||
    partition === null ||
    authority.value.requestAuthority.organisationId !==
      identity.organisationId ||
    partition.key.organisationId !== identity.organisationId
  )
    return null;
  return {
    organisationId: identity.organisationId,
    caseId: identity.caseId,
    commandId: message.commandId,
    text: message.text,
    requestAuthority: authority.value.requestAuthority,
    authorityPartition: partition,
    support: message.support,
    acceptedAt: message.acceptedAt,
  };
}
