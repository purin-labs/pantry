import { isActorExecutionActive } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import { fetchConnectorMail } from "../mail-inbox/execution";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { GMAIL_MAILBOX } from "../mail/gmail-mail-adapter";
import {
  authorizeEmailProposalFlow,
  fenceEmailCaseContextCollectionEffect,
  readEmailProposalFlow,
  emailCaseContextDiscoveryDraftCleanupCandidates,
} from "./email-case-context-collection-evidence";
import {
  emailProposalMemoryStanding,
  readEmailProposalMemory,
} from "./email-proposal-memory";
import type { ShownMemoryRevision } from "@purin-labs/area-brain-contract/server/memory/turn-memory";
import {
  dropEmailProposalPurchaseRequestSources,
  readEmailProposalChatContext,
  readEmailProposalChatSources,
  readEmailProposalSources,
} from "./email-proposal-sources";
import {
  locateReplySources,
  type LocatedReplySource,
} from "../mail-inbox/reply-sources";
import type { FlowBinding } from "@purin-labs/authority/policy/information-flow/index";
import type {
  SqlStorage,
  DurableObjectStorage,
} from "@cloudflare/workers-types";

import {
  buildGmailReplyRaw,
  deriveGmailReplyTarget,
  digestEmailBody,
  digestEmailSnapshot,
  digestGmailReplyTarget,
  dispatchRfcMessageId,
  proposalRfcMessageId,
  type GmailReplyTarget,
} from "../mail-inbox/reply-target";
import { extractMailbox } from "../mail/gmail-adapter";
import type { Env } from "@purin-labs/kernel/env";
import type { GmailDraft } from "../mail/gmail-adapter";
import type { Result } from "@purin-labs/kernel/result";
import type { RequestAuthority } from "@purin-labs/contracts";
import type {
  MailReplyEdit,
  MailReplyCorrection,
  MailRelationshipLookup,
} from "@purin-labs/control-api";
import { authorizeMailSource } from "@purin-labs/area-inbox-contract/server/mail-source-authorization";
import {
  claimEmailMaintenancePass,
  emailMaintenanceCandidates,
  latestEmailDraftOperation,
  readEmailDraftOperation,
  readEmailDraftSentMessageId,
  readEmailReplyCorrection,
  readEmailRuntime,
  recordEmailCorrectionLearning,
  recordEmailDraftOperation,
  recordEmailReplyCorrection,
  updateEmailDraftState,
  type EmailDraftOperation,
} from "./connector-email";
import {
  projectEmailReplyProposal,
  readAgentMailboxBinding,
} from "../data/email-mailbox";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { buildAgentMailboxAuthority } from "@purin-labs/authority/request-authority/index";
import { resolveConnectorGmailAccess } from "./connector-email-evaluation";
import { authorizeEmailChatSourceDelivery } from "../mail-inbox/chat-source-access";
import {
  authorizeEmailCommerceDelivery,
  readEmailCommerceEvidence,
  validateEmailCommerceEvidence,
  readEmailRelationship,
  recordEmailRelationshipCorrection,
  recordPendingEmailRelationshipVerification,
  hasPendingEmailRelationshipVerification,
  settleEmailRelationshipVerification,
  type EmailRelationshipRead,
} from "../mail-inbox/supplier-context";
import type { Variant } from "@purin-labs/type-utils";

export type EmailRelationshipPreview =
  | Variant<EmailRelationshipRead, "suppliers">
  | (Variant<EmailRelationshipRead, "purchase_request"> &
      Readonly<{ version: number; snapshotDigest: string }>);

type RelationshipInput = Readonly<{
  sql: SqlStorage;
  env: Env;
  scope: OrganisationExecutionScope;
  proposalId: string;
  authority: Variant<RequestAuthority, "control">;
  lookup: MailRelationshipLookup;
  now: number;
  fetcher: typeof fetch;
}>;

export async function previewEmailRelationship(
  input: RelationshipInput,
): Promise<Result<EmailRelationshipPreview, EmailProposalError>> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const fetcher = fetchConnectorMail.bind(
    null,
    input.sql,
    input.scope,
    input.fetcher,
  );
  if (
    readEmailProposalFlow(input.sql, input.proposalId)?.dependency.kind ===
    "case_context_collection_evidence"
  )
    return {
      ok: false,
      error: {
        code: "email_case_context_collection_relationship_edit_unavailable",
      },
    };
  const mailOperations = GMAIL_MAILBOX;
  const operation = latestEmailDraftOperation(input.sql, input.proposalId);
  const runtime = readEmailRuntime(input.sql);
  if (
    operation === null ||
    operation.state !== "awaiting_approval" ||
    runtime === null ||
    runtime.organisationId !== input.scope.organisationId ||
    runtime.disabledAt !== null ||
    input.now > operation.expiresAt
  )
    return { ok: false, error: { code: "email_relationship_unavailable" } };
  const account = parseIntegrationAccountId(runtime.integrationAccountId);
  const organisation = parseOrganisationId(runtime.organisationId);
  if (
    !account.ok ||
    !organisation.ok ||
    (await authorizeMailSource(input.env, input.authority, account.value)) ===
      null
  )
    return { ok: false, error: { code: "email_reply_unavailable" } };
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const binding = await readAgentMailboxBinding({
    db: input.scope.database,
    organisationId: organisation.value,
    integrationAccountId: account.value,
  });
  if (!binding.ok)
    return { ok: false, error: { code: "email_relationship_unavailable" } };
  const mailboxAuthority = buildAgentMailboxAuthority({
    organisationId: organisation.value,
    integrationAccountId: account.value,
    mailboxBindingId: binding.value.binding.mailboxBindingId,
    bindingRevision: binding.value.currentRevision.revision,
    mailboxPolicyVersion: runtime.policyVersion,
  }).requestAuthority;
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: runtime.organisationId,
    integrationAccountId: runtime.integrationAccountId,
    now: input.now,
    fetcher,
  });
  if (!access.ok) return access;
  const message = await mailOperations.reads.readMessage({
    accessToken: access.value,
    messageId: operation.triggeringMessageId,
    fetcher,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!message.ok) return message;
  const relationship = await readEmailRelationship(
    input.env,
    mailboxAuthority,
    input.authority,
    operation.caseId,
    message.value,
    input.lookup,
  );
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!relationship.ok) return relationship;
  if (
    (await authorizeMailSource(input.env, input.authority, account.value)) ===
    null
  )
    return { ok: false, error: { code: "email_reply_unavailable" } };
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (relationship.value.kind === "suppliers")
    return { ok: true, value: relationship.value };
  const inspection = await inspectCurrentDraft(input, operation, access.value);
  if (!inspection.ok) return inspection;
  if (inspection.value.kind !== "current")
    return { ok: false, error: { code: "email_relationship_unavailable" } };
  const version =
    inspection.value.bodyDigest === operation.bodyDigest
      ? operation.version
      : operation.version + 1;
  const snapshotDigest = await digestEmailSnapshot({
    proposalId: operation.proposalId,
    version,
    bodyDigest: inspection.value.bodyDigest,
    targetDigest: operation.targetDigest,
  });
  const delivered = await authorizeEmailCommerceDelivery(
    input.env,
    input.authority,
    relationship.value.evidence,
  );
  if (!delivered.ok) return delivered;
  if (
    (await authorizeMailSource(input.env, input.authority, account.value)) ===
    null
  )
    return { ok: false, error: { code: "email_reply_unavailable" } };
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  // The response stays transient. Only canonical references enter the correction receipt.
  return {
    ok: true,
    value: {
      kind: "purchase_request",
      supplierEntryId: relationship.value.supplierEntryId,
      supplierId: relationship.value.supplierId,
      supplierName: relationship.value.supplierName,
      purchaseRequestEntryId: relationship.value.purchaseRequestEntryId,
      purchaseRequestId: relationship.value.purchaseRequestId,
      merchantRevision: relationship.value.merchantRevision,
      facts: relationship.value.facts,
      relationshipDigest: relationship.value.relationshipDigest,
      evidence: relationship.value.evidence,
      version,
      snapshotDigest,
    },
  };
}

export async function correctEmailRelationship(
  input: Omit<RelationshipInput, "lookup"> &
    Readonly<{
      correction: MailReplyCorrection;
      storage: DurableObjectStorage;
    }>,
): Promise<Result<EmailReplyEditReceipt, EmailProposalError>> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const fetcher = fetchConnectorMail.bind(
    null,
    input.sql,
    input.scope,
    input.fetcher,
  );
  const mailOperations = GMAIL_MAILBOX;
  const selected = await previewEmailRelationship({
    sql: input.sql,
    env: input.env,
    scope: input.scope,
    proposalId: input.proposalId,
    authority: input.authority,
    now: input.now,
    fetcher: input.fetcher,
    lookup: {
      kind: "purchase_request",
      supplierEntryId: input.correction.supplierEntryId,
      purchaseRequestId: input.correction.purchaseRequestId,
    },
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!selected.ok) return selected;
  if (
    selected.value.kind !== "purchase_request" ||
    selected.value.version !== input.correction.version ||
    selected.value.snapshotDigest !== input.correction.snapshotDigest ||
    selected.value.relationshipDigest !== input.correction.relationshipDigest
  )
    return { ok: false, error: { code: "email_reply_edit_stale" } };
  const operation = latestEmailDraftOperation(input.sql, input.proposalId);
  if (operation === null)
    return { ok: false, error: { code: "email_relationship_unavailable" } };
  const bodyDigest = await digestEmailBody(input.correction.body);
  const unchanged = await digestEmailSnapshot({
    proposalId: operation.proposalId,
    version: selected.value.version,
    bodyDigest,
    targetDigest: operation.targetDigest,
  });
  if (unchanged === selected.value.snapshotDigest)
    return { ok: false, error: { code: "email_relationship_reply_required" } };
  const runtime = readEmailRuntime(input.sql);
  if (runtime === null || runtime.disabledAt !== null)
    return { ok: false, error: { code: "email_relationship_unavailable" } };
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: runtime.organisationId,
    integrationAccountId: runtime.integrationAccountId,
    now: input.now,
    fetcher,
  });
  if (!access.ok) return access;
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const inspection = await inspectCurrentDraft(input, operation, access.value);
  if (!inspection.ok) return inspection;
  if (
    inspection.value.kind !== "current" ||
    (await digestEmailSnapshot({
      proposalId: operation.proposalId,
      version: selected.value.version,
      bodyDigest: inspection.value.bodyDigest,
      targetDigest: operation.targetDigest,
    })) !== input.correction.snapshotDigest
  )
    return { ok: false, error: { code: "email_reply_edit_stale" } };
  const allowed = await authorizeEmailCommerceDelivery(
    input.env,
    input.authority,
    selected.value.evidence,
  );
  const account = parseIntegrationAccountId(runtime.integrationAccountId);
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!allowed.ok) return allowed;
  if (
    !account.ok ||
    (await authorizeMailSource(input.env, input.authority, account.value)) ===
      null
  )
    return { ok: false, error: { code: "email_reply_unavailable" } };
  const version = selected.value.version + 1;
  const snapshotDigest = await digestEmailSnapshot({
    proposalId: operation.proposalId,
    version,
    bodyDigest,
    targetDigest: operation.targetDigest,
  });
  const raw = buildGmailReplyRaw({
    target: inspection.value.target,
    body: input.correction.body,
    rfcMessageId: proposalRfcMessageId(
      operation.proposalId,
      version,
      inspection.value.target.accountAddress,
    ),
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  // Fence the old association durably before a provider write with an uncertain outcome.
  updateEmailDraftState(input.sql, {
    proposalId: operation.proposalId,
    version: operation.version,
    state: "invalidated",
    now: input.now,
  });
  const updated = await mailOperations.drafts.replaceBody({
    accessToken: access.value,
    draftId: operation.draftId,
    threadId: operation.threadId,
    raw,
    fetcher,
  });
  if (!updated.ok)
    return {
      ok: false,
      error: { code: "email_relationship_save_unconfirmed" },
    };
  // An acknowledged replacement retains its exact references and digests before export.
  input.storage.transactionSync(
    persistRelationshipCorrection.bind(
      null,
      input.sql,
      operation,
      input.authority.userId,
      selected.value,
      version,
      bodyDigest,
      snapshotDigest,
      updated.value.draftMessageId,
      input.now,
    ),
  );
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const replacement = readEmailDraftOperation(
    input.sql,
    operation.proposalId,
    version,
  );
  if (replacement === null)
    throw new Error("email_relationship_receipt_missing");
  const checked = await inspectCurrentDraft(input, replacement, access.value);
  if (
    !checked.ok ||
    checked.value.kind !== "current" ||
    checked.value.bodyDigest !== bodyDigest
  )
    return {
      ok: false,
      error: { code: "email_relationship_save_unconfirmed" },
    };
  const delivery = await authorizeEmailCommerceDelivery(
    input.env,
    input.authority,
    selected.value.evidence,
  );
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!delivery.ok) return delivery;
  if (
    (await authorizeMailSource(input.env, input.authority, account.value)) ===
    null
  )
    return { ok: false, error: { code: "email_reply_unavailable" } };
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  input.storage.transactionSync(
    verifyRelationshipCorrection.bind(
      null,
      input.sql,
      operation.proposalId,
      version,
      input.now,
    ),
  );
  return {
    ok: true,
    value: {
      version,
      bodyDigest,
      snapshotDigest,
      draftMessageId: updated.value.draftMessageId,
    },
  };
}

/**
 * Draft-as-proposal machinery. The visible Gmail draft is the temporary
 * proposal store: previews fetch and digest the current draft just in time,
 * a body-only edit becomes the next proposal version, a trusted-target edit
 * invalidates the proposal, and delivery captures an immutable snapshot
 * before messages.send so a concurrent draft edit can never change the
 * outgoing message. Ambiguous sends reconcile through the deterministic
 * dispatch Message-ID before any retry.
 */

export type EmailProposalPreview = {
  readonly proposalId: string;
  readonly baseVersion: number;
  readonly currentVersion: number;
  readonly bodyEdited: boolean;
  readonly to: string;
  readonly subject: string;
  readonly threadId: string;
  readonly body: string;
  readonly targetDigest: string;
  readonly bodyDigest: string;
  readonly snapshotDigest: string;
  readonly expiresAt: number;
  readonly state: EmailDraftOperation["state"];
  /** The Memory revisions the drafting turn was shown. Identities only. */
  readonly memory: readonly ShownMemoryRevision[];
  /**
   * The records the draft cites whose words are still in `body`, with where
   * those words are. Identities and read evidence only.
   */
  readonly sources: readonly LocatedReplySource[];
};

export type EmailProposalPreviewOutcome =
  | { readonly kind: "current"; readonly preview: EmailProposalPreview }
  | { readonly kind: "proposal_missing" }
  | {
      readonly kind: "invalidated";
      readonly reason: "target_changed" | "unsupported_content";
    }
  | { readonly kind: "expired" };

type EmailProposalError = { readonly code: string };

export type EmailReplyEditReceipt = Readonly<{
  version: number;
  bodyDigest: string;
  snapshotDigest: string;
  draftMessageId: string;
}>;

export async function editEmailReplyBody(
  input: Readonly<{
    sql: SqlStorage;
    env: Env;
    scope: OrganisationExecutionScope;
    proposalId: string;
    authority: Variant<RequestAuthority, "control">;
    edit: MailReplyEdit;
    /**
     * `shared` when the new body came from a shared draft that more than one
     * person or an agent wrote (Plan 40D). Such a version records no
     * correction, because its words have no single editor.
     */
    attribution: "single_editor" | "shared";
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<Result<EmailReplyEditReceipt, EmailProposalError>> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const fetcher = fetchConnectorMail.bind(
    null,
    input.sql,
    input.scope,
    input.fetcher,
  );
  const mailOperations = GMAIL_MAILBOX;
  const operation = latestEmailDraftOperation(input.sql, input.proposalId);
  const runtime = readEmailRuntime(input.sql);
  if (
    operation === null ||
    operation.state !== "awaiting_approval" ||
    runtime === null ||
    runtime.organisationId !== input.scope.organisationId ||
    runtime.disabledAt !== null ||
    input.now > operation.expiresAt
  )
    return { ok: false, error: { code: "email_reply_edit_unavailable" } };
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: runtime.organisationId,
    integrationAccountId: runtime.integrationAccountId,
    now: input.now,
    fetcher,
  });
  if (!access.ok) return access;
  const inspected = await inspectCurrentDraft(input, operation, access.value);
  if (!inspected.ok) return inspected;
  if (inspected.value.kind !== "current")
    return { ok: false, error: { code: "email_reply_edit_unavailable" } };
  const current = inspected.value;
  const disclosure = await authorizeStoredEmailProposalFlow(
    input,
    operation,
    "draft",
    current.to,
  );
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!disclosure.ok) return disclosure;
  const currentVersion =
    current.bodyDigest === operation.bodyDigest
      ? operation.version
      : operation.version + 1;
  const currentSnapshot = await digestEmailSnapshot({
    targetDigest: operation.targetDigest,
    bodyDigest: current.bodyDigest,
    proposalId: operation.proposalId,
    version: currentVersion,
  });
  if (
    currentVersion !== input.edit.version ||
    currentSnapshot !== input.edit.snapshotDigest
  )
    return { ok: false, error: { code: "email_reply_edit_stale" } };
  const bodyDigest = await digestEmailBody(input.edit.body);
  const version = currentVersion + 1;
  const snapshotDigest = await digestEmailSnapshot({
    targetDigest: operation.targetDigest,
    bodyDigest,
    proposalId: operation.proposalId,
    version,
  });
  const raw = buildGmailReplyRaw({
    target: current.target,
    body: input.edit.body,
    rfcMessageId: proposalRfcMessageId(
      operation.proposalId,
      version,
      current.target.accountAddress,
    ),
  });
  const authorized = await authorizeEmailReplyReview(
    input.sql,
    input.env,
    input.scope,
    input.authority,
    operation.proposalId,
  );
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!authorized.ok) return authorized;
  const liveRuntime = readEmailRuntime(input.sql);
  if (liveRuntime === null || liveRuntime.disabledAt !== null)
    return { ok: false, error: { code: "email_reply_edit_unavailable" } };
  const fenced = await fenceEmailCaseContextCollectionEffect({
    env: input.env,
    sql: input.sql,
    proposalId: operation.proposalId,
    caseId: operation.caseId,
    version,
    effect: "draft",
    targetDigest: operation.targetDigest,
    contentDigest: bodyDigest,
    binding: disclosure.value,
    expiresAt: operation.expiresAt,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!fenced.ok) return fenced;
  const updated = await mailOperations.drafts.replaceBody({
    accessToken: access.value,
    draftId: operation.draftId,
    threadId: operation.threadId,
    raw,
    fetcher,
  });
  if (!updated.ok)
    return { ok: false, error: { code: "email_reply_edit_unconfirmed" } };
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const checked = await inspectCurrentDraft(input, operation, access.value);
  if (
    !checked.ok ||
    checked.value.kind !== "current" ||
    checked.value.bodyDigest !== bodyDigest
  )
    return { ok: false, error: { code: "email_reply_edit_unconfirmed" } };
  const delivery = await authorizeEmailReplyReview(
    input.sql,
    input.env,
    input.scope,
    input.authority,
    operation.proposalId,
  );
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!delivery.ok) return delivery;
  recordEmailDraftOperation(input.sql, {
    proposalId: operation.proposalId,
    version,
    caseId: operation.caseId,
    threadId: operation.threadId,
    draftId: operation.draftId,
    draftMessageId: updated.value.draftMessageId,
    triggeringMessageId: operation.triggeringMessageId,
    targetDigest: operation.targetDigest,
    bodyDigest,
    snapshotDigest,
    policyVersion: operation.policyVersion,
    expiresAt: operation.expiresAt,
    now: input.now,
  });
  const flow = readEmailProposalFlow(input.sql, operation.proposalId);
  // A correction is recorded only when every earlier body is accounted for.
  // A draft changed in Gmail since its last recorded version, or built on a
  // version that has no such record, has words nobody here can attribute.
  if (
    flow !== null &&
    input.attribution === "single_editor" &&
    currentVersion === operation.version &&
    (operation.version === 1 ||
      readEmailReplyCorrection(
        input.sql,
        operation.proposalId,
        operation.version,
      ) !== null)
  ) {
    recordEmailReplyCorrection(input.sql, {
      proposalId: operation.proposalId,
      version,
      caseId: operation.caseId,
      correctedVersion: operation.version,
      correctedBodyDigest: operation.bodyDigest,
      bodyDigest,
      editorPersonId: input.authority.requesterPersonId,
      flowBindingJson: JSON.stringify(flow.binding),
      recordedAt: input.now,
    });
    // The mailbox agent learns from a recorded correction in its own turn.
    recordEmailCorrectionLearning(input.sql, {
      proposalId: operation.proposalId,
      version,
      now: input.now,
    });
  }
  return {
    ok: true,
    value: {
      version,
      bodyDigest,
      snapshotDigest,
      draftMessageId: updated.value.draftMessageId,
    },
  };
}

function persistRelationshipCorrection(
  sql: SqlStorage,
  operation: EmailDraftOperation,
  userId: string,
  relationship: Variant<EmailRelationshipRead, "purchase_request">,
  version: number,
  bodyDigest: string,
  snapshotDigest: string,
  draftMessageId: string,
  now: number,
): void {
  recordEmailRelationshipCorrection(
    sql,
    operation.proposalId,
    version,
    userId,
    relationship,
  );
  dropEmailProposalPurchaseRequestSources(sql, operation.proposalId);
  recordEmailDraftOperation(sql, {
    proposalId: operation.proposalId,
    version,
    caseId: operation.caseId,
    threadId: operation.threadId,
    draftId: operation.draftId,
    draftMessageId,
    triggeringMessageId: operation.triggeringMessageId,
    targetDigest: operation.targetDigest,
    bodyDigest,
    snapshotDigest,
    policyVersion: operation.policyVersion,
    expiresAt: operation.expiresAt,
    now,
  });
  updateEmailDraftState(sql, {
    proposalId: operation.proposalId,
    version,
    state: "invalidated",
    now,
  });
  recordPendingEmailRelationshipVerification(
    sql,
    operation.proposalId,
    version,
  );
}

function verifyRelationshipCorrection(
  sql: SqlStorage,
  proposalId: string,
  version: number,
  now: number,
): void {
  updateEmailDraftState(sql, {
    proposalId,
    version,
    state: "awaiting_approval",
    now,
  });
  settleEmailRelationshipVerification(sql, proposalId, version);
}

export async function authorizeEmailReplyReview(
  sql: SqlStorage,
  env: Env,
  scope: OrganisationExecutionScope,
  authority: Variant<RequestAuthority, "control">,
  proposalId: string,
): Promise<Result<null, EmailProposalError>> {
  if (!(await isActorExecutionActive(sql, scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const runtime = readEmailRuntime(sql);
  if (
    runtime === null ||
    runtime.organisationId !== scope.organisationId ||
    runtime.organisationId !== authority.organisationId
  )
    return { ok: false, error: { code: "email_reply_unavailable" } };
  const accountId = parseIntegrationAccountId(runtime.integrationAccountId);
  if (
    !accountId.ok ||
    latestEmailDraftOperation(sql, proposalId) === null ||
    (await authorizeMailSource(env, authority, accountId.value)) === null
  )
    return { ok: false, error: { code: "email_reply_unavailable" } };
  if (!(await isActorExecutionActive(sql, scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  // Every source that the drafting turn read covers the reply: a mailbox
  // turn's commerce evidence, or every source, Memory and Project that a
  // Portal chat read before it drafted.
  const delivery = await authorizeEmailCommerceDelivery(
    env,
    authority,
    readEmailCommerceEvidence(sql, proposalId),
  );
  if (!(await isActorExecutionActive(sql, scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!delivery.ok) return delivery;
  const chat = await authorizeEmailChatSourceDelivery(
    env,
    authority,
    readEmailProposalChatSources(sql, proposalId),
    readEmailProposalChatContext(sql, proposalId),
  );
  if (!(await isActorExecutionActive(sql, scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  return chat;
}

export async function previewEmailProposal(
  input: Readonly<{
    sql: SqlStorage;
    env: Env;
    scope: OrganisationExecutionScope;
    proposalId: string;
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<Result<EmailProposalPreviewOutcome, EmailProposalError>> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const operation = latestEmailDraftOperation(input.sql, input.proposalId);
  if (operation === null)
    return { ok: false, error: { code: "email_proposal_unknown" } };
  if (operation.state === "sent") {
    return { ok: false, error: { code: "email_proposal_already_sent" } };
  }
  const correctionPending =
    operation.state === "invalidated" &&
    hasPendingEmailRelationshipVerification(
      input.sql,
      operation.proposalId,
      operation.version,
    );
  if (
    operation.state !== "awaiting_approval" &&
    operation.state !== "send_indeterminate" &&
    !correctionPending
  )
    return { ok: false, error: { code: "email_reply_edit_unavailable" } };
  if (input.now > operation.expiresAt) {
    return { ok: true, value: { kind: "expired" } };
  }
  const runtime = readEmailRuntime(input.sql);
  if (runtime === null || runtime.organisationId !== input.scope.organisationId)
    return { ok: false, error: { code: "email_runtime_missing" } };
  const commerce = await validateEmailCommerceEvidence(
    input.env,
    runtime.organisationId,
    readEmailCommerceEvidence(input.sql, operation.proposalId),
  );
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!commerce.ok) return commerce;
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: runtime.organisationId,
    integrationAccountId: runtime.integrationAccountId,
    now: input.now,
    fetcher: fetchConnectorMail.bind(
      null,
      input.sql,
      input.scope,
      input.fetcher,
    ),
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!access.ok) return access;
  const inspection = await inspectCurrentDraft(input, operation, access.value);
  if (!inspection.ok) return inspection;
  if (inspection.value.kind !== "current")
    return { ok: true, value: inspection.value };
  const current = inspection.value;
  if (correctionPending && current.bodyDigest !== operation.bodyDigest)
    return {
      ok: false,
      error: { code: "email_relationship_save_unconfirmed" },
    };
  const disclosure = await authorizeStoredEmailProposalFlow(
    input,
    operation,
    "preview",
    current.to,
  );
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!disclosure.ok) return disclosure;
  const bodyEdited = current.bodyDigest !== operation.bodyDigest;
  const currentVersion = bodyEdited ? operation.version + 1 : operation.version;
  const snapshotDigest = await digestEmailSnapshot({
    targetDigest: operation.targetDigest,
    bodyDigest: current.bodyDigest,
    proposalId: operation.proposalId,
    version: currentVersion,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (correctionPending)
    verifyRelationshipCorrection(
      input.sql,
      operation.proposalId,
      operation.version,
      input.now,
    );
  return {
    ok: true,
    value: {
      kind: "current",
      preview: {
        proposalId: operation.proposalId,
        baseVersion: operation.version,
        currentVersion,
        bodyEdited,
        to: current.to,
        subject: current.subject,
        threadId: operation.threadId,
        body: current.body,
        targetDigest: operation.targetDigest,
        bodyDigest: current.bodyDigest,
        snapshotDigest,
        expiresAt: operation.expiresAt,
        state: correctionPending ? "awaiting_approval" : operation.state,
        memory: readEmailProposalMemory(input.sql, operation.proposalId),
        sources: await locateReplySources(
          current.body,
          readEmailProposalSources(input.sql, operation.proposalId),
        ),
      },
    },
  };
}

export type EmailDispatchOutcome =
  | {
      readonly kind: "sent";
      readonly providerMessageId: string;
      readonly version: number;
      readonly bodyDigest: string;
      readonly snapshotDigest: string;
      readonly rfcMessageId?: never;
    }
  | { readonly kind: "stale_approval"; readonly currentSnapshotDigest: string }
  | {
      readonly kind: "invalidated";
      readonly reason: "target_changed" | "unsupported_content";
    }
  | { readonly kind: "proposal_missing" }
  | { readonly kind: "expired" }
  | {
      readonly kind: "send_indeterminate";
      readonly version: number;
      readonly bodyDigest: string;
      readonly snapshotDigest: string;
      readonly rfcMessageId: string;
      readonly providerMessageId?: never;
    };

/**
 * The immutable send ladder: recheck the runtime is not fenced, refetch the
 * current draft, reconstruct and compare the frozen target, compare the
 * complete snapshot against the approved digests, capture the exact body in
 * request-scoped memory, send the raw snapshot with the deterministic
 * dispatch Message-ID, then delete the proposal draft as cleanup that can
 * never cause a second delivery.
 */
export async function dispatchEmailReply(
  input: Readonly<{
    sql: SqlStorage;
    env: Env;
    scope: OrganisationExecutionScope;
    proposalId: string;
    approvedVersion: number;
    approvedSnapshotDigest: string;
    now: number;
    fetcher: typeof fetch;
    beforeSend?: () => Promise<Result<null, EmailProposalError>>;
  }>,
): Promise<Result<EmailDispatchOutcome, EmailProposalError>> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const fetcher = fetchConnectorMail.bind(
    null,
    input.sql,
    input.scope,
    input.fetcher,
  );
  const mailOperations = GMAIL_MAILBOX;
  const runtime = readEmailRuntime(input.sql);
  if (
    runtime === null ||
    runtime.organisationId !== input.scope.organisationId ||
    runtime.disabledAt !== null
  ) {
    return { ok: false, error: { code: "connector_email_runtime_missing" } };
  }
  const operation = latestEmailDraftOperation(input.sql, input.proposalId);
  if (operation === null)
    return { ok: false, error: { code: "email_proposal_unknown" } };
  if (operation.sentMessageId !== null) {
    return {
      ok: true,
      value: {
        kind: "sent",
        providerMessageId: operation.sentMessageId,
        version: operation.version,
        bodyDigest: operation.bodyDigest,
        snapshotDigest: operation.snapshotDigest,
      },
    };
  }
  if (operation.state === "sent")
    return { ok: false, error: { code: "email_proposal_already_sent" } };
  if (input.now > operation.expiresAt)
    return { ok: true, value: { kind: "expired" } };
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: runtime.organisationId,
    integrationAccountId: runtime.integrationAccountId,
    now: input.now,
    fetcher,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!access.ok) return { ok: false, error: { code: access.error.code } };
  if (operation.state === "send_indeterminate") {
    const reconciled = await reconcileIndeterminateSend(
      input,
      operation,
      access.value,
      operation.version,
    );
    if (!reconciled.ok) return reconciled;
    if (!(await isActorExecutionActive(input.sql, input.scope)))
      return { ok: false, error: { code: "connector_placement_conflict" } };

    if (reconciled.value !== null) {
      return {
        ok: true,
        value: {
          kind: "sent",
          providerMessageId: reconciled.value,
          version: operation.version,
          bodyDigest: operation.bodyDigest,
          snapshotDigest: operation.snapshotDigest,
        },
      };
    }
    const address = await accountAddress(
      input.scope,
      runtime.integrationAccountId,
    );
    if (address === null)
      return { ok: false, error: { code: "email_mailbox_account_missing" } };
    return {
      ok: true,
      value: {
        kind: "send_indeterminate",
        version: operation.version,
        bodyDigest: operation.bodyDigest,
        snapshotDigest: operation.snapshotDigest,
        rfcMessageId: dispatchRfcMessageId(
          operation.proposalId,
          operation.version,
          address,
        ),
      },
    };
  }
  if (operation.state !== "awaiting_approval")
    return { ok: false, error: { code: "email_reply_edit_unavailable" } };
  const inspection = await inspectCurrentDraft(
    {
      sql: input.sql,
      env: input.env,
      scope: input.scope,
      now: input.now,
      fetcher: input.fetcher,
    },
    operation,
    access.value,
  );
  if (!inspection.ok) return inspection;
  if (inspection.value.kind === "proposal_missing") {
    return { ok: true, value: { kind: "proposal_missing" } };
  }
  if (inspection.value.kind === "invalidated") {
    return { ok: true, value: inspection.value };
  }
  const current = inspection.value;
  const dispatchVersion =
    current.bodyDigest === operation.bodyDigest
      ? operation.version
      : operation.version + 1;
  const currentSnapshot = await digestEmailSnapshot({
    targetDigest: operation.targetDigest,
    bodyDigest: current.bodyDigest,
    proposalId: operation.proposalId,
    version: dispatchVersion,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (
    dispatchVersion !== input.approvedVersion ||
    currentSnapshot !== input.approvedSnapshotDigest
  ) {
    return {
      ok: true,
      value: { kind: "stale_approval", currentSnapshotDigest: currentSnapshot },
    };
  }
  const target = current.target;
  const rfcMessageId = dispatchRfcMessageId(
    operation.proposalId,
    dispatchVersion,
    target.accountAddress,
  );
  const raw = buildGmailReplyRaw({
    target,
    body: current.body,
    rfcMessageId,
  });
  // The marker precedes the send so a crash between the two leaves
  // send_indeterminate rather than awaiting_approval: the next attempt then
  // reconciles by the dispatch Message-ID instead of blindly sending again.
  // A concurrent caller that finished meanwhile is honoured idempotently.
  const sentMessageId = readEmailDraftSentMessageId(
    input.sql,
    operation.proposalId,
    operation.version,
  );
  if (sentMessageId !== null) {
    return {
      ok: true,
      value: {
        kind: "sent",
        providerMessageId: sentMessageId,
        version: dispatchVersion,
        bodyDigest: current.bodyDigest,
        snapshotDigest: currentSnapshot,
      },
    };
  }
  const delivery =
    input.beforeSend === undefined
      ? await validateEmailCommerceEvidence(
          input.env,
          runtime.organisationId,
          readEmailCommerceEvidence(input.sql, operation.proposalId),
        )
      : await input.beforeSend();
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!delivery.ok) return delivery;
  const disclosure = await authorizeStoredEmailProposalFlow(
    input,
    operation,
    "send",
    current.to,
  );
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!disclosure.ok) return disclosure;
  const fenced = await fenceEmailCaseContextCollectionEffect({
    env: input.env,
    sql: input.sql,
    proposalId: operation.proposalId,
    caseId: operation.caseId,
    version: dispatchVersion,
    effect: "send",
    targetDigest: operation.targetDigest,
    contentDigest: current.bodyDigest,
    binding: disclosure.value,
    expiresAt: operation.expiresAt,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!fenced.ok) return fenced;
  if (dispatchVersion !== operation.version) {
    recordEmailDraftOperation(input.sql, {
      proposalId: operation.proposalId,
      version: dispatchVersion,
      caseId: operation.caseId,
      threadId: operation.threadId,
      draftId: operation.draftId,
      draftMessageId: operation.draftMessageId,
      triggeringMessageId: operation.triggeringMessageId,
      targetDigest: operation.targetDigest,
      bodyDigest: current.bodyDigest,
      snapshotDigest: currentSnapshot,
      policyVersion: operation.policyVersion,
      expiresAt: operation.expiresAt,
      now: input.now,
    });
  }
  updateEmailDraftState(input.sql, {
    proposalId: operation.proposalId,
    version: dispatchVersion,
    state: "send_indeterminate",
    approvedSnapshotDigest: input.approvedSnapshotDigest,
    now: input.now,
  });
  const sent = await mailOperations.submission.sendReply({
    accessToken: access.value,
    raw,
    threadId: operation.threadId,
    fetcher,
  });
  if (!sent.ok) {
    // A rejection Gmail returned before accepting the message definitely did
    // not send, so the claim reverts and the operator can retry cleanly. An
    // unavailable upstream — or a 2xx whose body could not be read — may have
    // sent, and stays indeterminate for Message-ID reconciliation.
    if (
      sent.error.code === "gmail_unauthorized" ||
      sent.error.code === "gmail_rate_limited" ||
      sent.error.code === "gmail_not_found"
    ) {
      updateEmailDraftState(input.sql, {
        proposalId: operation.proposalId,
        version: dispatchVersion,
        state: operation.state,
        now: input.now,
      });
      return { ok: false, error: { code: sent.error.code } };
    }
    return {
      ok: true,
      value: {
        kind: "send_indeterminate",
        version: dispatchVersion,
        bodyDigest: current.bodyDigest,
        snapshotDigest: currentSnapshot,
        rfcMessageId,
      },
    };
  }
  updateEmailDraftState(input.sql, {
    proposalId: operation.proposalId,
    version: dispatchVersion,
    state: "cleanup_pending",
    approvedSnapshotDigest: input.approvedSnapshotDigest,
    sentMessageId: sent.value.messageId,
    bodyDigest: current.bodyDigest,
    snapshotDigest: currentSnapshot,
    now: input.now,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const cleanup = await mailOperations.drafts.dispose({
    accessToken: access.value,
    draftId: operation.draftId,
    fetcher,
  });
  if (cleanup.ok) {
    updateEmailDraftState(input.sql, {
      proposalId: operation.proposalId,
      version: dispatchVersion,
      state: "sent",
      now: input.now,
    });
  }
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  return {
    ok: true,
    value: {
      kind: "sent",
      providerMessageId: sent.value.messageId,
      version: dispatchVersion,
      bodyDigest: current.bodyDigest,
      snapshotDigest: currentSnapshot,
    },
  };
}

export type EmailProposalResolution =
  | {
      readonly kind: "sent";
      readonly providerMessageId: string;
      readonly version: number;
      readonly bodyDigest: string;
      readonly snapshotDigest: string;
    }
  | { readonly kind: "unresolved" }
  | { readonly kind: "deleted" }
  | { readonly kind: "cleanup_pending" }
  | { readonly kind: "no_action" };

/**
 * Records a provider-observed result for an indeterminate or cleanup state.
 * Resolution reconciles by the deterministic dispatch Message-ID and retries
 * draft deletion; it never creates or sends a message.
 */
export async function resolveEmailProposalState(
  input: Readonly<{
    sql: SqlStorage;
    env: Env;
    scope: OrganisationExecutionScope;
    proposalId: string;
    dispatchVersion: number;
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<Result<EmailProposalResolution, EmailProposalError>> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const fetcher = fetchConnectorMail.bind(
    null,
    input.sql,
    input.scope,
    input.fetcher,
  );
  const mailOperations = GMAIL_MAILBOX;
  const runtime = readEmailRuntime(input.sql);
  if (runtime === null || runtime.organisationId !== input.scope.organisationId)
    return { ok: false, error: { code: "connector_email_runtime_missing" } };
  const operation = latestEmailDraftOperation(input.sql, input.proposalId);
  if (operation === null)
    return { ok: false, error: { code: "email_proposal_unknown" } };
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: runtime.organisationId,
    integrationAccountId: runtime.integrationAccountId,
    now: input.now,
    fetcher,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!access.ok) return { ok: false, error: { code: access.error.code } };
  if (operation.state === "send_indeterminate") {
    const reconciled = await reconcileIndeterminateSend(
      input,
      operation,
      access.value,
      operation.version,
    );
    if (!reconciled.ok) return reconciled;
    if (!(await isActorExecutionActive(input.sql, input.scope)))
      return { ok: false, error: { code: "connector_placement_conflict" } };

    if (reconciled.value === null)
      return { ok: true, value: { kind: "unresolved" } };
    const cleanup = await mailOperations.drafts.dispose({
      accessToken: access.value,
      draftId: operation.draftId,
      fetcher,
    });
    if (cleanup.ok) {
      updateEmailDraftState(input.sql, {
        proposalId: operation.proposalId,
        version: operation.version,
        state: "sent",
        sentMessageId: reconciled.value,
        now: input.now,
      });
    }
    if (!(await isActorExecutionActive(input.sql, input.scope)))
      return { ok: false, error: { code: "connector_placement_conflict" } };
    return {
      ok: true,
      value: {
        kind: "sent",
        providerMessageId: reconciled.value,
        version: operation.version,
        bodyDigest: operation.bodyDigest,
        snapshotDigest: operation.snapshotDigest,
      },
    };
  }
  if (
    operation.state === "cleanup_pending" ||
    operation.state === "cleanup_unreachable"
  ) {
    const deleted = await mailOperations.drafts.dispose({
      accessToken: access.value,
      draftId: operation.draftId,
      fetcher,
    });
    if (!deleted.ok) {
      return { ok: true, value: { kind: "cleanup_pending" } };
    }
    updateEmailDraftState(input.sql, {
      proposalId: operation.proposalId,
      version: operation.version,
      state: operation.sentMessageId === null ? "deleted" : "sent",
      now: input.now,
    });
    if (!(await isActorExecutionActive(input.sql, input.scope)))
      return { ok: false, error: { code: "connector_placement_conflict" } };
    return { ok: true, value: { kind: "deleted" } };
  }
  return { ok: true, value: { kind: "no_action" } };
}

export type EmailDisposalOutcome =
  | { readonly kind: "deleted" }
  | { readonly kind: "cleanup_pending" }
  | { readonly kind: "cleanup_unreachable" };

export async function disposeEmailProposal(
  input: Readonly<{
    sql: SqlStorage;
    env: Env;
    scope: OrganisationExecutionScope;
    proposalId: string;
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<Result<EmailDisposalOutcome, EmailProposalError>> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const fetcher = fetchConnectorMail.bind(
    null,
    input.sql,
    input.scope,
    input.fetcher,
  );
  const mailOperations = GMAIL_MAILBOX;
  const runtime = readEmailRuntime(input.sql);
  const operation = latestEmailDraftOperation(input.sql, input.proposalId);
  if (operation === null)
    return { ok: false, error: { code: "email_proposal_unknown" } };
  if (operation.state === "deleted")
    return { ok: true, value: { kind: "deleted" } };
  if (
    runtime === null ||
    runtime.organisationId !== input.scope.organisationId
  ) {
    return { ok: false, error: { code: "connector_email_runtime_missing" } };
  }
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: runtime.organisationId,
    integrationAccountId: runtime.integrationAccountId,
    now: input.now,
    fetcher,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!access.ok) {
    updateEmailDraftState(input.sql, {
      proposalId: operation.proposalId,
      version: operation.version,
      state: "cleanup_pending",
      now: input.now,
    });
    return { ok: true, value: { kind: "cleanup_pending" } };
  }
  const deleted = await mailOperations.drafts.dispose({
    accessToken: access.value,
    draftId: operation.draftId,
    fetcher,
  });
  if (!deleted.ok) {
    const permanent = deleted.error.code === "gmail_unauthorized";
    updateEmailDraftState(input.sql, {
      proposalId: operation.proposalId,
      version: operation.version,
      state: permanent ? "cleanup_unreachable" : "cleanup_pending",
      now: input.now,
    });
    return {
      ok: true,
      value: { kind: permanent ? "cleanup_unreachable" : "cleanup_pending" },
    };
  }
  updateEmailDraftState(input.sql, {
    proposalId: operation.proposalId,
    version: operation.version,
    state: "deleted",
    now: input.now,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  return { ok: true, value: { kind: "deleted" } };
}

type CurrentDraftInspection =
  | {
      readonly kind: "current";
      readonly body: string;
      readonly bodyDigest: string;
      readonly to: string;
      readonly subject: string;
      readonly target: GmailReplyTarget;
    }
  | { readonly kind: "proposal_missing" }
  | {
      readonly kind: "invalidated";
      readonly reason: "target_changed" | "unsupported_content";
    };

/**
 * The corrected reply one recorded correction produced, as Gmail holds it
 * now. It is returned only while that version is still the draft and its
 * body still has the recorded digest. The text is read for one turn and
 * stored nowhere.
 */
export async function readCorrectedEmailReply(
  input: Readonly<{
    sql: SqlStorage;
    env: Env;
    scope: OrganisationExecutionScope;
    proposalId: string;
    version: number;
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<
  | Readonly<{
      kind: "current";
      operation: EmailDraftOperation;
      bodyDigest: string;
      body: string;
    }>
  | Readonly<{ kind: "gone" | "unavailable"; body?: never }>
> {
  const correction = readEmailReplyCorrection(
    input.sql,
    input.proposalId,
    input.version,
  );
  const operation = latestEmailDraftOperation(input.sql, input.proposalId);
  const runtime = readEmailRuntime(input.sql);
  if (
    correction === null ||
    operation === null ||
    operation.version !== input.version ||
    operation.state !== "awaiting_approval" ||
    runtime === null ||
    runtime.disabledAt !== null
  )
    return { kind: "gone" };
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: runtime.organisationId,
    integrationAccountId: runtime.integrationAccountId,
    now: input.now,
    fetcher: fetchConnectorMail.bind(
      null,
      input.sql,
      input.scope,
      input.fetcher,
    ),
  });
  if (!access.ok) return { kind: "unavailable" };
  const inspected = await inspectCurrentDraft(input, operation, access.value);
  if (!inspected.ok) return { kind: "unavailable" };
  return inspected.value.kind === "current" &&
    inspected.value.bodyDigest === correction.bodyDigest
    ? {
        kind: "current",
        operation,
        bodyDigest: correction.bodyDigest,
        body: inspected.value.body,
      }
    : { kind: "gone" };
}

async function inspectCurrentDraft(
  input: Readonly<{
    sql: SqlStorage;
    env: Env;
    scope: OrganisationExecutionScope;
    now: number;
    fetcher: typeof fetch;
  }>,
  operation: EmailDraftOperation,
  accessToken: string,
): Promise<Result<CurrentDraftInspection, EmailProposalError>> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const fetcher = fetchConnectorMail.bind(
    null,
    input.sql,
    input.scope,
    input.fetcher,
  );
  const mailOperations = GMAIL_MAILBOX;
  const runtime = readEmailRuntime(input.sql);
  if (runtime === null || runtime.organisationId !== input.scope.organisationId)
    return { ok: false, error: { code: "connector_email_runtime_missing" } };
  const draft = await mailOperations.drafts.read({
    accessToken,
    draftId: operation.draftId,
    fetcher,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!draft.ok) {
    if (draft.error.code === "gmail_not_found") {
      updateEmailDraftState(input.sql, {
        proposalId: operation.proposalId,
        version: operation.version,
        state: "deleted",
        now: input.now,
      });
      return { ok: true, value: { kind: "proposal_missing" } };
    }
    return { ok: false, error: { code: draft.error.code } };
  }
  const target = await reconstructTarget(input, operation, accessToken);
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!target.ok) return target;
  const violation = detectTargetViolation(draft.value, target.value, operation);
  if (violation !== null) {
    settleEmailRelationshipVerification(
      input.sql,
      operation.proposalId,
      operation.version,
    );
    updateEmailDraftState(input.sql, {
      proposalId: operation.proposalId,
      version: operation.version,
      state: "invalidated",
      now: input.now,
    });
    return { ok: true, value: { kind: "invalidated", reason: violation } };
  }
  const bodyDigest = await digestEmailBody(draft.value.bodyText);
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  return {
    ok: true,
    value: {
      kind: "current",
      body: draft.value.bodyText,
      bodyDigest,
      to: target.value.to,
      subject: target.value.subject,
      target: target.value,
    },
  };
}

async function reconstructTarget(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    now: number;
    fetcher: typeof fetch;
    sql: SqlStorage;
  }>,
  operation: EmailDraftOperation,
  accessToken: string,
): Promise<Result<GmailReplyTarget, EmailProposalError>> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const fetcher = fetchConnectorMail.bind(
    null,
    input.sql,
    input.scope,
    input.fetcher,
  );
  const mailOperations = GMAIL_MAILBOX;
  const runtime = readEmailRuntime(input.sql);
  if (runtime === null || runtime.organisationId !== input.scope.organisationId)
    return { ok: false, error: { code: "connector_email_runtime_missing" } };
  const source = await mailOperations.reads.readMessage({
    accessToken,
    messageId: operation.triggeringMessageId,
    fetcher,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!source.ok) return { ok: false, error: { code: source.error.code } };
  const address = await accountAddress(
    input.scope,
    runtime.integrationAccountId,
  );
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (address === null)
    return { ok: false, error: { code: "email_mailbox_account_missing" } };
  const target = deriveGmailReplyTarget({
    accountAddress: address,
    sourceMessageId: operation.triggeringMessageId,
    threadId: operation.threadId,
    headers: source.value.headers,
    policyVersion: operation.policyVersion,
    expiresAt: operation.expiresAt,
  });
  if (!target.ok) return { ok: false, error: { code: target.error.code } };
  const digest = await digestGmailReplyTarget(target.value);
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (digest !== operation.targetDigest) {
    return { ok: false, error: { code: "email_reply_target_drifted" } };
  }
  return target;
}

function detectTargetViolation(
  draft: GmailDraft,
  target: Readonly<{ to: string; subject: string }>,
  operation: EmailDraftOperation,
): "target_changed" | "unsupported_content" | null {
  if (draft.threadId !== operation.threadId) return "target_changed";
  if (draft.cc.length > 0 || draft.bcc.length > 0) return "target_changed";
  const recipients = draft.to.map(
    (entry) => extractMailbox(entry) ?? entry.toLowerCase(),
  );
  if (recipients.length !== 1 || recipients[0] !== target.to)
    return "target_changed";
  const draftSubject = draft.headers.subject
    .replaceAll(/[\r\n]+/gu, " ")
    .trim();
  if (draftSubject !== target.subject) return "target_changed";
  if (draft.hasAttachments) return "unsupported_content";
  const unsupported = draft.mimeTypes.some((mime) => {
    const normalized = mime.toLowerCase();
    return (
      normalized !== "text/plain" &&
      normalized !== "text/html" &&
      !normalized.startsWith("multipart/")
    );
  });
  return unsupported ? "unsupported_content" : null;
}

async function reconcileIndeterminateSend(
  input: Readonly<{
    sql: SqlStorage;
    env: Env;
    scope: OrganisationExecutionScope;
    now: number;
    fetcher: typeof fetch;
  }>,
  operation: EmailDraftOperation,
  accessToken: string,
  dispatchVersion: number,
): Promise<Result<string | null, EmailProposalError>> {
  const mailOperations = GMAIL_MAILBOX;
  const runtime = readEmailRuntime(input.sql);
  if (runtime === null || runtime.organisationId !== input.scope.organisationId)
    return { ok: false, error: { code: "connector_email_runtime_missing" } };
  const address = await accountAddress(
    input.scope,
    runtime.integrationAccountId,
  );
  if (address === null)
    return { ok: false, error: { code: "email_mailbox_account_missing" } };
  const found = await mailOperations.reads.findSubmissionEvidence({
    accessToken,
    rfcMessageId: dispatchRfcMessageId(
      operation.proposalId,
      dispatchVersion,
      address,
    ),
    fetcher: fetchConnectorMail.bind(
      null,
      input.sql,
      input.scope,
      input.fetcher,
    ),
  });
  if (!found.ok) return { ok: false, error: { code: found.error.code } };
  if (found.value === null) return { ok: true, value: null };
  updateEmailDraftState(input.sql, {
    proposalId: operation.proposalId,
    version: operation.version,
    state: "cleanup_pending",
    sentMessageId: found.value.messageId,
    now: input.now,
  });
  return { ok: true, value: found.value.messageId };
}

async function accountAddress(
  scope: OrganisationExecutionScope,
  integrationAccountId: string,
): Promise<string | null> {
  const row = await scope.database
    .prepare(
      `SELECT observed_address AS observedAddress FROM email_mailbox_account
       WHERE organisation_id = ? AND integration_account_id = ?`,
    )
    .bind(scope.organisationId, integrationAccountId)
    .first<{ readonly observedAddress: string }>();
  return row?.observedAddress ?? null;
}

type EmailMaintenanceSummary = {
  readonly ran: boolean;
  readonly disposedExpired: number;
  readonly resolvedSent: number;
  readonly cleaned: number;
  readonly unresolved: number;
};

/**
 * The scheduled half of the proposal lifecycle. Everything here recovers a
 * state whose remedy needs no judgement: an expired proposal's draft is
 * removed from the organisation's Gmail, an ambiguous send is reconciled by its
 * dispatch Message-ID, and a failed draft deletion is retried. Anything that
 * still cannot progress is left for the next pass rather than looped on.
 */
export async function runEmailProposalMaintenance(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    sql: SqlStorage;
    env: Env;
    now: number;
    fetcher: typeof fetch;
    withProposalLock: <T>(
      proposalId: string,
      task: () => Promise<T>,
    ) => Promise<T>;
  }>,
): Promise<EmailMaintenanceSummary> {
  const active = await isActorExecutionActive(input.sql, input.scope);
  const claimed = active && claimEmailMaintenancePass(input.sql, input.now);
  const summary = {
    ran: claimed,
    disposedExpired: 0,
    resolvedSent: 0,
    cleaned: 0,
    unresolved: 0,
  };
  if (!claimed) return summary;
  const unknownDrafts = await cleanUnknownCaseContextCollectionDrafts(input);
  summary.cleaned += unknownDrafts.cleaned;
  summary.unresolved += unknownDrafts.unresolved;
  for (const candidate of emailMaintenanceCandidates(input.sql, input.now)) {
    if (!(await isActorExecutionActive(input.sql, input.scope))) break;
    const operation = candidate.operation;
    if (candidate.action === "dispose_expired") {
      const disposed = await input.withProposalLock(operation.proposalId, () =>
        disposeEmailProposal({
          sql: input.sql,
          env: input.env,
          scope: input.scope,
          proposalId: operation.proposalId,
          now: input.now,
          fetcher: input.fetcher,
        }),
      );
      if (disposed.ok && disposed.value.kind === "deleted") {
        summary.disposedExpired += 1;
        await projectMaintainedLifecycle(input, operation, "expired");
      } else {
        summary.unresolved += 1;
      }
      continue;
    }
    const resolved = await input.withProposalLock(operation.proposalId, () =>
      resolveEmailProposalState({
        sql: input.sql,
        env: input.env,
        scope: input.scope,
        proposalId: operation.proposalId,
        dispatchVersion: operation.version,
        now: input.now,
        fetcher: input.fetcher,
      }),
    );
    if (!resolved.ok) {
      summary.unresolved += 1;
      continue;
    }
    switch (resolved.value.kind) {
      case "sent":
        summary.resolvedSent += 1;
        await projectMaintainedLifecycle(input, operation, "sent");
        break;
      case "deleted":
        summary.cleaned += 1;
        if (operation.sentMessageId !== null)
          await projectMaintainedLifecycle(input, operation, "sent");
        break;
      default:
        summary.unresolved += 1;
        break;
    }
  }
  return summary;
}

async function cleanUnknownCaseContextCollectionDrafts(
  input: Pick<
    Parameters<typeof runEmailProposalMaintenance>[0],
    "env" | "sql" | "now" | "fetcher" | "scope"
  >,
): Promise<Readonly<{ cleaned: number; unresolved: number }>> {
  const fetcher = fetchConnectorMail.bind(
    null,
    input.sql,
    input.scope,
    input.fetcher,
  );
  const candidates = emailCaseContextDiscoveryDraftCleanupCandidates(
    input.sql,
    input.now,
  );
  if (candidates.length === 0) return { cleaned: 0, unresolved: 0 };
  const runtime = readEmailRuntime(input.sql);
  if (runtime === null) return { cleaned: 0, unresolved: candidates.length };
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: runtime.organisationId,
    integrationAccountId: runtime.integrationAccountId,
    now: input.now,
    fetcher,
  });
  if (!access.ok) return { cleaned: 0, unresolved: candidates.length };
  const operations = GMAIL_MAILBOX.drafts;
  let cleaned = 0;
  for (const candidate of candidates) {
    const found = await operations.findCreationEvidence({
      accessToken: access.value,
      rfcMessageId: candidate.rfcMessageId,
      fetcher,
    });
    if (!found.ok || found.value === null) continue;
    const deleted = await operations.dispose({
      accessToken: access.value,
      draftId: found.value.draftId,
      fetcher,
    });
    if (!deleted.ok && deleted.error.code !== "gmail_not_found") continue;
    input.sql.exec(
      "UPDATE email_case_context_collection_draft_attempt SET state = 'deleted' WHERE proposal_id = ?",
      candidate.proposalId,
    );
    cleaned++;
  }
  return { cleaned, unresolved: candidates.length - cleaned };
}

/**
 * Keeps the operator queue truthful after an unattended transition. Best
 * effort by design: the durable truth lives in the Connector's draft table,
 * and the next preview re-syncs a projection this write could not reach.
 */
async function projectMaintainedLifecycle(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    sql: SqlStorage;
    env: Env;
    now: number;
  }>,
  operation: EmailDraftOperation,
  lifecycleKind: "expired" | "sent",
): Promise<void> {
  const runtime = readEmailRuntime(input.sql);
  if (runtime === null) return;
  const organisationId = parseOrganisationId(runtime.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    runtime.integrationAccountId,
  );
  if (!organisationId.ok || !integrationAccountId.ok) return;
  await projectEmailReplyProposal({
    scope: input.scope,
    integrationAccountId: integrationAccountId.value,
    proposalId: operation.proposalId,
    caseId: operation.caseId,
    gmailThreadId: operation.threadId,
    currentVersion: operation.version,
    lifecycleKind,
    now: input.now,
  }).catch(() => undefined);
}

async function authorizeStoredEmailProposalFlow(
  input: Readonly<{
    sql: SqlStorage;
    env: Env;
    scope: OrganisationExecutionScope;
    proposalId: string;
  }>,
  operation: EmailDraftOperation,
  surface: "draft" | "preview" | "send",
  to: string,
): Promise<Result<FlowBinding | null, EmailProposalError>> {
  if (readEmailProposalFlow(input.sql, operation.proposalId) === null) {
    // A reply that a Portal chat drafted keeps no flow, and still rests on
    // the Memory that its chat was shown.
    if (surface === "draft") return { ok: true, value: null };
    const runtime = readEmailRuntime(input.sql);
    const organisationId = parseOrganisationId(runtime?.organisationId ?? "");
    if (runtime === null || runtime.disabledAt !== null)
      return { ok: false, error: { code: "email_runtime_missing" } };
    if (!organisationId.ok)
      return { ok: false, error: { code: "email_reply_unavailable" } };
    const standing = await requireEmailProposalMemoryInForce(
      input,
      operation.proposalId,
      organisationId.value,
    );
    return standing.ok ? { ok: true, value: null } : standing;
  }
  const runtime = readEmailRuntime(input.sql);
  if (runtime === null || runtime.disabledAt !== null)
    return { ok: false, error: { code: "email_runtime_missing" } };
  const organisationId = parseOrganisationId(runtime.organisationId);
  const accountId = parseIntegrationAccountId(runtime.integrationAccountId);
  if (!organisationId.ok || !accountId.ok)
    return { ok: false, error: { code: "email_reply_unavailable" } };
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const binding = await readAgentMailboxBinding({
    db: input.scope.database,
    organisationId: organisationId.value,
    integrationAccountId: accountId.value,
  });
  if (!binding.ok) return { ok: false, error: { code: binding.error.code } };
  const authority = buildAgentMailboxAuthority({
    organisationId: organisationId.value,
    integrationAccountId: accountId.value,
    mailboxBindingId: binding.value.binding.mailboxBindingId,
    bindingRevision: binding.value.currentRevision.revision,
    mailboxPolicyVersion: operation.policyVersion,
  }).requestAuthority;
  const authorized = await authorizeEmailProposalFlow({
    env: input.env,
    sql: input.sql,
    proposalId: operation.proposalId,
    authority,
    surface,
    to,
    approvalSatisfied: surface === "send",
    caseId: operation.caseId,
    triggeringMessageId: operation.triggeringMessageId,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!authorized.ok || surface === "draft") return authorized;
  const standing = await requireEmailProposalMemoryInForce(
    input,
    operation.proposalId,
    organisationId.value,
  );
  return standing.ok ? authorized : standing;
}

/**
 * A reply is previewed and sent later than its turn ran. It may be relied on
 * only while the Memory that turn was shown is still in force.
 */
async function requireEmailProposalMemoryInForce(
  input: Readonly<{
    sql: SqlStorage;
    env: Env;
    scope: OrganisationExecutionScope;
  }>,
  proposalId: string,
  organisationId: OrganisationId,
): Promise<Result<null, EmailProposalError>> {
  const standing = await emailProposalMemoryStanding({
    env: input.env,
    scope: input.scope,
    sql: input.sql,
    organisationId,
    proposalId,
    now: Date.now(),
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (standing !== "in_force")
    return {
      ok: false,
      error: {
        code:
          standing === "changed"
            ? "email_memory_changed"
            : "email_memory_unavailable",
      },
    };
  return { ok: true, value: null };
}
