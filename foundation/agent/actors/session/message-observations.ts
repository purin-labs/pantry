import type {
  HarnessTurnLease,
  StoredMessageAttachment,
} from "@purin-labs/contracts";
import {
  createCurrentSourceFlowLabel,
  ObservationEvidence,
  outsideWrittenFlowLabel,
  type FlowLabel,
} from "@purin-labs/authority/policy/index";
import { admitSessionInformationFlowObservation } from "../agent-session-information-flow";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
} from "../session-execution-admission";
import type { MessageLinkReceipt } from "../../messages/link-reader";

/** The turn whose Session a message tool's read is recorded in. */
export type MessageObservationContext = Readonly<{
  execution: SessionExecutionAdmission;
  storage: DurableObjectStorage;
  lease: HarnessTurnLease;
  caseId: string;
}>;

/**
 * Records a file of the turn's message that a tool read. A member attached
 * the file, so its label is the message's own ingress label, with no writer.
 */
export async function recordMessageAttachmentObservation(
  context: MessageObservationContext,
  observed: Readonly<{ attachment: StoredMessageAttachment }>,
): Promise<void> {
  await admitMessageObservation(context, {
    what: "Message attachment",
    entryId: String(observed.attachment.id),
    contentDigest: String(observed.attachment.sha256),
    label: ingressLabel,
  });
}

/**
 * Records the text of a public page that a link of the turn's message named.
 * A member shared the link, but a person outside the Organisation wrote the
 * page, so its label states the writer `outside` (Plan 89). An effect with a
 * consequence later in this Session then asks the person who asked.
 *
 * The source names the page by its origin and path digest, never by its URL,
 * because a query string can carry a secret.
 */
export async function recordMessageLinkObservation(
  context: MessageObservationContext,
  observed: Readonly<{ receipt: MessageLinkReceipt }>,
): Promise<void> {
  await admitMessageObservation(context, {
    what: "Message link",
    entryId: `message_link:${observed.receipt.finalOrigin}:${observed.receipt.pathDigest}`,
    contentDigest: observed.receipt.contentDigest,
    label: async (current) =>
      outsideWrittenFlowLabel(await ingressLabel(current)),
  });
}

async function ingressLabel(
  context: MessageObservationContext,
): Promise<FlowLabel> {
  // The message was admitted under this conversation's authority, so a read
  // from it carries that ingress label, not a broader one of the Session.
  const label = await createCurrentSourceFlowLabel({
    kind: "ingress",
    db: context.execution.scope.database,
    authority: context.lease.requestAuthority,
  });
  if (!label.ok) {
    throw new Error(`Message flow label is unavailable: ${label.error.code}`);
  }
  return label.value;
}

async function admitMessageObservation(
  context: MessageObservationContext,
  read: Readonly<{
    what: string;
    entryId: string;
    contentDigest: string;
    label: (context: MessageObservationContext) => Promise<FlowLabel>;
  }>,
): Promise<void> {
  await requireSessionExecution(context.execution, context.lease);
  const observedAt = Date.now();
  const inputLabel = await read.label(context);
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "case_entry",
      caseId: context.caseId,
      entryId: read.entryId,
    },
    sourceRevision: observedAt,
    contentDigest: read.contentDigest,
    inputLabel,
    observedAt,
  });
  if (!evidence.ok) {
    throw new Error(
      `${read.what} observation is invalid: ${evidence.error.code}`,
    );
  }
  await requireSessionExecution(context.execution, context.lease);
  const admitted = await admitSessionInformationFlowObservation({
    authorizeCommit: requireSessionExecution.bind(
      null,
      context.execution,
      context.lease,
    ),
    sql: context.storage.sql,
    transactionSync: context.storage.transactionSync.bind(context.storage),
    organisationId: context.execution.scope.organisationId,
    sessionId: context.lease.session.sessionId,
    turnId: context.lease.turn.turnId,
    authorityPartitionDigest: context.lease.authorityPartitionDigest,
    inputLabel,
    observation: evidence.value,
    observedAt,
  });
  if (!admitted.ok) {
    throw new Error(
      `${read.what} information-flow commit failed: ${admitted.error.code}`,
    );
  }
}
