import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { isActorExecutionActive } from "./actor-execution-quiescence";
import {
  fetchConnectorMail,
  isSessionMailExecutionActive,
} from "../mail-inbox/execution";
import type { SessionTurnExecution } from "../chat/turn-access";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { gmailMailAdapter } from "../mail/gmail-mail-adapter";
import type { SqlStorage, SqlStorageValue } from "@cloudflare/workers-types";

import {
  resolveActiveProviderConnectionCredential,
  resolveActiveProviderConnectionBinding,
} from "../credential-vault/provider-connection-resolution";
import {
  connectionCredentialAuthority,
  resolveActiveProviderAccountContext,
} from "../data/integration-account";
import {
  resolveEmailSenderAccount,
  parseEmailProposalTarget,
  type EmailProposalTarget,
} from "../data/email-operational";
import {
  resolveEmailProposalRecipient,
  validEmailSelfTestContent,
} from "../data/email-self-test";
import { dispatchRfcMessageId } from "../mail/reply-target";
import {
  buildOperationalEmailRaw,
  normalizeOperationalBody,
  normalizeOperationalSubject,
} from "../mail/operational-message";
import type { GmailApiError } from "../mail/gmail-adapter";
import { resolveGmailAccessToken } from "../mail/gmail-oauth";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  createEmailContentCipher,
  type EmailContentCipher,
} from "./email-active-content";
import {
  CAPABILITY_KEYS,
  capabilityDefinitionById,
} from "../authorization/capability-catalogue";
import { isNonNegativeInteger, isSha256Hex, sha256Hex } from "@purin-labs/std";

const OPERATIONAL_EMAIL_PROJECTION_BATCH_SIZE = 100;
const OPERATIONAL_EMAIL_PROJECTION_RETRY_MS = 60_000;

type OperationalEmailProposalState =
  | "awaiting_approval"
  | "sent"
  | "send_indeterminate"
  | "rejected"
  | "expired"
  | "superseded"
  | "revoked";

export type OperationalEmailProposalRecord = Readonly<{
  readonly proposalId: string;
  readonly version: number;
  readonly caseId: string;
  readonly integrationAccountId: IntegrationAccountId;
  readonly target: EmailProposalTarget;
  readonly targetDigest: string;
  readonly subjectDigest: string;
  readonly bodyDigest: string;
  readonly snapshotDigest: string;
  readonly policyVersion: number;
  readonly credentialGeneration: number;
  readonly state: OperationalEmailProposalState;
  readonly approvedSnapshotDigest: string | null;
  readonly nonceB64: string | null;
  readonly ciphertextB64: string | null;
  readonly contentBytes: number | null;
  readonly sentMessageId: string | null;
  readonly sentThreadId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly updatedAt: number;
}>;

type OperationalEmailProposalPreview = Readonly<{
  readonly proposalId: string;
  readonly version: number;
  readonly caseId: string;
  readonly integrationAccountId: IntegrationAccountId;
  readonly target: EmailProposalTarget;
  readonly sender: string;
  readonly recipient: string;
  readonly recipientDisplayName: string | null;
  readonly subject: string;
  readonly body: string;
  readonly targetDigest: string;
  readonly snapshotDigest: string;
  readonly expiresAt: number;
  readonly state: OperationalEmailProposalState;
}>;

export type OperationalEmailProposalOutcome =
  | {
      readonly kind: "current";
      readonly preview: OperationalEmailProposalPreview;
    }
  | { readonly kind: "proposal_missing" }
  | { readonly kind: "expired" }
  | { readonly kind: "target_changed" }
  | { readonly kind: "content_unavailable" };

export type OperationalEmailDispatchOutcome =
  | {
      readonly kind: "sent";
      readonly providerMessageId: string;
      readonly providerThreadId: string;
      readonly version: number;
      readonly snapshotDigest: string;
    }
  | { readonly kind: "stale_approval"; readonly currentSnapshotDigest: string }
  | { readonly kind: "expired" }
  | { readonly kind: "proposal_missing" }
  | { readonly kind: "target_changed" }
  | { readonly kind: "send_indeterminate"; readonly rfcMessageId: string };

type OperationalEmailProposalError = Readonly<{ readonly code: string }>;

type OperationalEmailProposalRequest = Readonly<{
  readonly execution: SessionTurnExecution;
  readonly sql: SqlStorage;
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
  readonly integrationAccountId: IntegrationAccountId;
  readonly proposalId: string;
  readonly caseId: string;
  readonly target: EmailProposalTarget;
  readonly subject: string;
  readonly body: string;
  readonly policyVersion: number;
  readonly credentialGeneration: number;
  readonly now: number;
  readonly expiresAt: number;
}>;

export async function createOperationalEmailProposal(
  input: OperationalEmailProposalRequest,
): Promise<
  Result<OperationalEmailProposalRecord, OperationalEmailProposalError>
> {
  if (
    !(await isSessionMailExecutionActive(
      input.sql,
      input.scope,
      input.env.DB,
      input.execution,
    ))
  )
    return {
      ok: false,
      error: { code: "connector_execution_authority_inactive" },
    };
  const content = normalizeContent(input.subject, input.body);
  if (
    content === null ||
    !validEmailSelfTestContent(input.target, content.subject, content.body)
  ) {
    return { ok: false, error: { code: "operational_email_content_invalid" } };
  }
  if (input.expiresAt <= input.now) {
    return { ok: false, error: { code: "operational_email_expiry_invalid" } };
  }
  const cipher = await operationalCipherForRecord(input);
  if (!cipher.ok) return cipher;
  const targetDigest = await digestTarget(input.target);
  const subjectDigest = await cipher.value.digest(content.subject);
  const bodyDigest = await cipher.value.digest(content.body);
  if (
    !(await isSessionMailExecutionActive(
      input.sql,
      input.scope,
      input.env.DB,
      input.execution,
    ))
  )
    return {
      ok: false,
      error: { code: "connector_execution_authority_inactive" },
    };
  const existing = latestOperationalEmailProposal(input.sql, input.proposalId);
  if (existing !== null) {
    if (
      existing.version !== 1 ||
      existing.state !== "awaiting_approval" ||
      existing.caseId !== input.caseId ||
      existing.integrationAccountId !== input.integrationAccountId ||
      existing.targetDigest !== targetDigest ||
      existing.subjectDigest !== subjectDigest ||
      existing.bodyDigest !== bodyDigest
    ) {
      return {
        ok: false,
        error: { code: "operational_email_proposal_conflict" },
      };
    }
    return { ok: true, value: existing };
  }
  const authority = await resolveOperationalGmailBinding(input);
  if (
    !(await isSessionMailExecutionActive(
      input.sql,
      input.scope,
      input.env.DB,
      input.execution,
    ))
  )
    return {
      ok: false,
      error: { code: "connector_execution_authority_inactive" },
    };
  if (!authority.ok) return authority;
  if (authority.value.credentialGeneration !== input.credentialGeneration) {
    return { ok: false, error: { code: "operational_email_credential_stale" } };
  }
  const target = await resolveEmailProposalRecipient({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
    proposalId: input.proposalId,
    caseId: input.caseId,
    now: input.now,
    target: input.target,
  });
  if (
    !(await isSessionMailExecutionActive(
      input.sql,
      input.scope,
      input.env.DB,
      input.execution,
    ))
  )
    return {
      ok: false,
      error: { code: "connector_execution_authority_inactive" },
    };
  if (!target.ok) return { ok: false, error: { code: target.error.code } };
  const sender = await readSender(input);
  if (
    !(await isSessionMailExecutionActive(
      input.sql,
      input.scope,
      input.env.DB,
      input.execution,
    ))
  )
    return {
      ok: false,
      error: { code: "connector_execution_authority_inactive" },
    };
  if (!sender.ok) return sender;
  const snapshotDigest = await digestOperationalEmailSnapshot({
    proposalId: input.proposalId,
    version: 1,
    caseId: input.caseId,
    integrationAccountId: input.integrationAccountId,
    authorizationProduct: authority.value.authorizationProduct,
    credentialGeneration: input.credentialGeneration,
    policyVersion: input.policyVersion,
    expiresAt: input.expiresAt,
    sender: sender.value,
    recipient: target.value.address,
    targetDigest,
    subjectDigest,
    bodyDigest,
  });
  if (
    !(await isSessionMailExecutionActive(
      input.sql,
      input.scope,
      input.env.DB,
      input.execution,
    ))
  )
    return {
      ok: false,
      error: { code: "connector_execution_authority_inactive" },
    };
  const sealed = await cipher.value.seal(
    input.caseId,
    { proposalId: input.proposalId, version: 1 },
    JSON.stringify({ subject: content.subject, body: content.body }),
  );
  if (
    !(await isSessionMailExecutionActive(
      input.sql,
      input.scope,
      input.env.DB,
      input.execution,
    ))
  )
    return {
      ok: false,
      error: { code: "connector_execution_authority_inactive" },
    };
  input.sql.exec(
    `INSERT INTO connector_email_operational_proposal (
       proposal_id, version, case_id, integration_account_id, target_json,
       target_digest, subject_digest, body_digest, snapshot_digest,
       policy_version, credential_generation, state, approved_snapshot_digest,
       nonce_b64, ciphertext_b64, content_bytes, sent_message_id,
       sent_thread_id, created_at, expires_at, updated_at
     ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', NULL, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    input.proposalId,
    input.caseId,
    input.integrationAccountId,
    JSON.stringify(input.target),
    targetDigest,
    subjectDigest,
    bodyDigest,
    snapshotDigest,
    input.policyVersion,
    input.credentialGeneration,
    sealed.nonceB64,
    sealed.ciphertextB64,
    sealed.bytes,
    input.now,
    input.expiresAt,
    input.now,
  );
  const created = latestOperationalEmailProposal(input.sql, input.proposalId);
  return created === null
    ? { ok: false, error: { code: "operational_email_proposal_write_failed" } }
    : { ok: true, value: created };
}

export async function editOperationalEmailProposal(
  input: Readonly<{
    readonly sql: SqlStorage;
    readonly env: Env;
    readonly scope: OrganisationExecutionScope;
    readonly integrationAccountId: IntegrationAccountId;
    readonly proposalId: string;
    readonly subject: string;
    readonly body: string;
    /** The version that the person started from (Refactor 15, refactor 8). */
    readonly expectedVersion?: number | undefined;
    readonly now: number;
  }>,
): Promise<
  Result<OperationalEmailProposalRecord, OperationalEmailProposalError>
> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const current = latestOperationalEmailProposal(input.sql, input.proposalId);
  if (current === null)
    return { ok: false, error: { code: "operational_email_proposal_missing" } };
  if (current.integrationAccountId !== input.integrationAccountId) {
    return { ok: false, error: { code: "operational_email_identity_invalid" } };
  }
  if (current.state !== "awaiting_approval") {
    return {
      ok: false,
      error: { code: "operational_email_proposal_immutable" },
    };
  }
  // An edit that started from an older version would replace a newer one.
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== current.version
  )
    return { ok: false, error: { code: "operational_email_proposal_stale" } };
  if (input.now >= current.expiresAt) {
    purgeOperationalEmailContent(
      input.sql,
      current.proposalId,
      current.version,
    );
    input.sql.exec(
      `UPDATE connector_email_operational_proposal
       SET state = 'expired', updated_at = ?
       WHERE proposal_id = ? AND version = ? AND state = 'awaiting_approval'`,
      input.now,
      current.proposalId,
      current.version,
    );
    return { ok: false, error: { code: "operational_email_proposal_expired" } };
  }
  const content = normalizeContent(input.subject, input.body);
  if (
    content === null ||
    !validEmailSelfTestContent(current.target, content.subject, content.body)
  ) {
    return { ok: false, error: { code: "operational_email_content_invalid" } };
  }
  const cipher = await operationalCipherForRecord(input);
  if (!cipher.ok) return cipher;
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const target = await resolveEmailProposalRecipient({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
    proposalId: input.proposalId,
    caseId: current.caseId,
    now: input.now,
    target: current.target,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!target.ok) return { ok: false, error: { code: target.error.code } };
  const sender = await readSender(input);
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!sender.ok) return sender;
  const binding = await resolveOperationalGmailBinding(input);
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!binding.ok) return binding;
  const version = current.version + 1;
  const targetDigest = await digestTarget(current.target);
  const subjectDigest = await cipher.value.digest(content.subject);
  const bodyDigest = await cipher.value.digest(content.body);
  const snapshotDigest = await digestOperationalEmailSnapshot({
    proposalId: input.proposalId,
    version,
    caseId: current.caseId,
    integrationAccountId: input.integrationAccountId,
    authorizationProduct: binding.value.authorizationProduct,
    credentialGeneration: binding.value.credentialGeneration,
    policyVersion: current.policyVersion,
    expiresAt: current.expiresAt,
    sender: sender.value,
    recipient: target.value.address,
    targetDigest,
    subjectDigest,
    bodyDigest,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const sealed = await cipher.value.seal(
    current.caseId,
    { proposalId: input.proposalId, version },
    JSON.stringify({ subject: content.subject, body: content.body }),
  );
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  input.sql.exec(
    `UPDATE connector_email_operational_proposal
        SET state = 'superseded', nonce_b64 = NULL, ciphertext_b64 = NULL,
            content_bytes = NULL, updated_at = ?
      WHERE proposal_id = ? AND version = ? AND state = 'awaiting_approval'`,
    input.now,
    input.proposalId,
    current.version,
  );
  input.sql.exec(
    `INSERT INTO connector_email_operational_proposal (
       proposal_id, version, case_id, integration_account_id, target_json,
       target_digest, subject_digest, body_digest, snapshot_digest,
       policy_version, credential_generation, state, approved_snapshot_digest,
       nonce_b64, ciphertext_b64, content_bytes, sent_message_id,
       sent_thread_id, created_at, expires_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', NULL, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    input.proposalId,
    version,
    current.caseId,
    input.integrationAccountId,
    JSON.stringify(current.target),
    targetDigest,
    subjectDigest,
    bodyDigest,
    snapshotDigest,
    current.policyVersion,
    binding.value.credentialGeneration,
    sealed.nonceB64,
    sealed.ciphertextB64,
    sealed.bytes,
    current.createdAt,
    current.expiresAt,
    input.now,
  );
  const edited = latestOperationalEmailProposal(input.sql, input.proposalId);
  return edited === null
    ? { ok: false, error: { code: "operational_email_proposal_write_failed" } }
    : { ok: true, value: edited };
}

export async function previewOperationalEmailProposal(
  input: Readonly<{
    readonly sql: SqlStorage;
    readonly env: Env;
    readonly scope: OrganisationExecutionScope;
    readonly integrationAccountId: IntegrationAccountId;
    readonly proposalId: string;
    readonly now: number;
  }>,
): Promise<
  Result<OperationalEmailProposalOutcome, OperationalEmailProposalError>
> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const record = latestOperationalEmailProposal(input.sql, input.proposalId);
  if (record === null)
    return { ok: false, error: { code: "operational_email_proposal_missing" } };
  if (record.integrationAccountId !== input.integrationAccountId) {
    return { ok: false, error: { code: "operational_email_identity_invalid" } };
  }
  if (record.state === "sent" || record.state === "send_indeterminate") {
    return { ok: true, value: { kind: "content_unavailable" } };
  }
  if (input.now >= record.expiresAt) {
    purgeOperationalEmailContent(input.sql, record.proposalId, record.version);
    input.sql.exec(
      `UPDATE connector_email_operational_proposal SET state = 'expired', updated_at = ?
       WHERE proposal_id = ? AND version = ? AND state = 'awaiting_approval'`,
      input.now,
      record.proposalId,
      record.version,
    );
    return { ok: true, value: { kind: "expired" } };
  }
  if (record.nonceB64 === null || record.ciphertextB64 === null) {
    return { ok: true, value: { kind: "content_unavailable" } };
  }
  const cipher = await operationalCipherForRecord(input);
  if (!cipher.ok) return cipher;
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const opened = await cipher.value.open(
    record.caseId,
    { proposalId: record.proposalId, version: record.version },
    { nonceB64: record.nonceB64, ciphertextB64: record.ciphertextB64 },
  );
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!opened.ok) return { ok: true, value: { kind: "content_unavailable" } };
  const content = parseContent(opened.value);
  if (
    content === null ||
    !validEmailSelfTestContent(record.target, content.subject, content.body)
  )
    return { ok: true, value: { kind: "content_unavailable" } };
  const target = await resolveEmailProposalRecipient({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
    proposalId: input.proposalId,
    caseId: record.caseId,
    now: input.now,
    target: record.target,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!target.ok) {
    if (
      target.error.code === "email_operational_contact_not_found" ||
      target.error.code === "email_operational_contact_suppressed" ||
      target.error.code === "email_operational_contact_inactive"
    ) {
      input.sql.exec(
        `UPDATE connector_email_operational_proposal
            SET state = 'superseded', nonce_b64 = NULL, ciphertext_b64 = NULL,
                content_bytes = NULL, updated_at = ?
          WHERE proposal_id = ? AND version = ?`,
        input.now,
        record.proposalId,
        record.version,
      );
      return { ok: true, value: { kind: "target_changed" } };
    }
    return { ok: false, error: { code: target.error.code } };
  }
  const sender = await readSender(input);
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!sender.ok) return sender;
  const binding = await resolveOperationalGmailBinding(input);
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!binding.ok) return binding;
  const targetDigest = await digestTarget(record.target);
  const subjectDigest = await cipher.value.digest(content.subject);
  const bodyDigest = await cipher.value.digest(content.body);
  const snapshotDigest = await digestOperationalEmailSnapshot({
    proposalId: record.proposalId,
    version: record.version,
    caseId: record.caseId,
    integrationAccountId: record.integrationAccountId,
    authorizationProduct: binding.value.authorizationProduct,
    credentialGeneration: binding.value.credentialGeneration,
    policyVersion: record.policyVersion,
    expiresAt: record.expiresAt,
    sender: sender.value,
    recipient: target.value.address,
    targetDigest,
    subjectDigest,
    bodyDigest,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (
    targetDigest !== record.targetDigest ||
    subjectDigest !== record.subjectDigest ||
    bodyDigest !== record.bodyDigest ||
    binding.value.credentialGeneration !== record.credentialGeneration ||
    snapshotDigest !== record.snapshotDigest
  ) {
    purgeOperationalEmailContent(input.sql, record.proposalId, record.version);
    input.sql.exec(
      `UPDATE connector_email_operational_proposal
          SET state = 'superseded', updated_at = ?
        WHERE proposal_id = ? AND version = ? AND state = 'awaiting_approval'`,
      input.now,
      record.proposalId,
      record.version,
    );
    return { ok: true, value: { kind: "target_changed" } };
  }
  return {
    ok: true,
    value: {
      kind: "current",
      preview: {
        proposalId: record.proposalId,
        version: record.version,
        caseId: record.caseId,
        integrationAccountId: record.integrationAccountId,
        target: record.target,
        sender: sender.value,
        recipient: target.value.address,
        recipientDisplayName: target.value.displayName,
        subject: content.subject,
        body: content.body,
        targetDigest,
        snapshotDigest,
        expiresAt: record.expiresAt,
        state: record.state,
      },
    },
  };
}

export async function dispatchOperationalEmail(
  input: Readonly<{
    readonly sql: SqlStorage;
    readonly env: Env;
    readonly scope: OrganisationExecutionScope;
    readonly integrationAccountId: IntegrationAccountId;
    readonly proposalId: string;
    readonly approvedVersion: number;
    readonly approvedSnapshotDigest: string;
    readonly now: number;
  }>,
): Promise<
  Result<OperationalEmailDispatchOutcome, OperationalEmailProposalError>
> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const record = latestOperationalEmailProposal(input.sql, input.proposalId);
  if (record === null)
    return { ok: false, error: { code: "operational_email_proposal_missing" } };
  if (record.integrationAccountId !== input.integrationAccountId) {
    return { ok: false, error: { code: "operational_email_identity_invalid" } };
  }
  if (record.state === "sent") {
    if (record.sentMessageId === null || record.sentThreadId === null)
      return {
        ok: false,
        error: { code: "operational_email_dispatch_receipt_missing" },
      };
    return {
      ok: true,
      value: {
        kind: "sent",
        providerMessageId: record.sentMessageId,
        providerThreadId: record.sentThreadId,
        version: record.version,
        snapshotDigest: record.snapshotDigest,
      },
    };
  }
  if (record.state === "send_indeterminate") {
    const rfcMessageId = readOperationalEmailDispatchId(input.sql, record);
    return rfcMessageId === null
      ? {
          ok: false,
          error: { code: "operational_email_dispatch_receipt_missing" },
        }
      : { ok: true, value: { kind: "send_indeterminate", rfcMessageId } };
  }
  if (record.state !== "awaiting_approval") {
    return {
      ok: false,
      error: { code: "operational_email_proposal_immutable" },
    };
  }
  if (
    record.policyVersion !==
    capabilityDefinitionById(CAPABILITY_KEYS.emailOperationalPropose)
      .capabilityVersion
  ) {
    return { ok: false, error: { code: "operational_email_policy_stale" } };
  }
  if (input.now >= record.expiresAt) {
    purgeOperationalEmailContent(input.sql, record.proposalId, record.version);
    input.sql.exec(
      `UPDATE connector_email_operational_proposal SET state = 'expired', updated_at = ?
       WHERE proposal_id = ? AND version = ?`,
      input.now,
      record.proposalId,
      record.version,
    );
    return { ok: true, value: { kind: "expired" } };
  }
  const cipher = await operationalCipherForRecord(input);
  if (!cipher.ok) return cipher;
  const authority = await resolveOperationalGmailAuthority(input);
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!authority.ok) return authority;
  if (authority.value.credentialGeneration !== record.credentialGeneration) {
    return { ok: false, error: { code: "operational_email_credential_stale" } };
  }
  const target = await resolveEmailProposalRecipient({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
    proposalId: input.proposalId,
    caseId: record.caseId,
    now: input.now,
    target: record.target,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!target.ok) {
    if (
      target.error.code === "email_operational_contact_not_found" ||
      target.error.code === "email_operational_contact_suppressed" ||
      target.error.code === "email_operational_contact_inactive"
    ) {
      purgeOperationalEmailContent(
        input.sql,
        record.proposalId,
        record.version,
      );
      input.sql.exec(
        `UPDATE connector_email_operational_proposal
            SET state = 'superseded', updated_at = ?
          WHERE proposal_id = ? AND version = ? AND state = 'awaiting_approval'`,
        input.now,
        record.proposalId,
        record.version,
      );
      return { ok: true, value: { kind: "target_changed" } };
    }
    return { ok: false, error: { code: target.error.code } };
  }
  const sender = await readSender(input);
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!sender.ok) return sender;
  if (record.nonceB64 === null || record.ciphertextB64 === null) {
    return {
      ok: false,
      error: { code: "operational_email_content_unavailable" },
    };
  }
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const opened = await cipher.value.open(
    record.caseId,
    { proposalId: record.proposalId, version: record.version },
    { nonceB64: record.nonceB64, ciphertextB64: record.ciphertextB64 },
  );
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!opened.ok) {
    return { ok: false, error: { code: opened.error.code } };
  }
  const content = parseContent(opened.value);
  if (
    content === null ||
    !validEmailSelfTestContent(record.target, content.subject, content.body)
  ) {
    return {
      ok: false,
      error: { code: "operational_email_content_unavailable" },
    };
  }
  const targetDigest = await digestTarget(record.target);
  const subjectDigest = await cipher.value.digest(content.subject);
  const bodyDigest = await cipher.value.digest(content.body);
  const currentSnapshotDigest = await digestOperationalEmailSnapshot({
    proposalId: record.proposalId,
    version: record.version,
    caseId: record.caseId,
    integrationAccountId: record.integrationAccountId,
    authorizationProduct: authority.value.authorizationProduct,
    credentialGeneration: authority.value.credentialGeneration,
    policyVersion: record.policyVersion,
    expiresAt: record.expiresAt,
    sender: sender.value,
    recipient: target.value.address,
    targetDigest,
    subjectDigest,
    bodyDigest,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (record.snapshotDigest !== currentSnapshotDigest) {
    purgeOperationalEmailContent(input.sql, record.proposalId, record.version);
    input.sql.exec(
      `UPDATE connector_email_operational_proposal
          SET state = 'superseded', updated_at = ?
        WHERE proposal_id = ? AND version = ? AND state = 'awaiting_approval'`,
      input.now,
      record.proposalId,
      record.version,
    );
    return { ok: true, value: { kind: "target_changed" } };
  }
  if (
    input.approvedVersion !== record.version ||
    input.approvedSnapshotDigest !== currentSnapshotDigest
  ) {
    return {
      ok: true,
      value: { kind: "stale_approval", currentSnapshotDigest },
    };
  }
  const rfcMessageId = dispatchRfcMessageId(
    record.proposalId,
    record.version,
    sender.value,
  );
  const raw = buildOperationalEmailRaw({
    from: sender.value,
    to: target.value.address,
    subject: content.subject,
    body: content.body,
    rfcMessageId,
  });
  const sent = await gmailMailAdapter.products[
    authority.value.authorizationProduct
  ].submission.sendMessage({
    accessToken: authority.value.accessToken,
    raw,
    fetcher: submitOperationalEmail.bind(null, input, record, rfcMessageId),
  });
  const claimed = latestOperationalEmailProposal(input.sql, input.proposalId);
  if (claimed?.state !== "send_indeterminate")
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!sent.ok) {
    if (isDefinitiveGmailSendRejection(sent.error)) {
      input.sql.exec(
        `UPDATE connector_email_operational_proposal
            SET state = 'awaiting_approval', approved_snapshot_digest = NULL,
                nonce_b64 = ?, ciphertext_b64 = ?, content_bytes = ?, updated_at = ?
          WHERE proposal_id = ? AND version = ?`,
        record.nonceB64,
        record.ciphertextB64,
        record.contentBytes,
        input.now,
        record.proposalId,
        record.version,
      );
      return { ok: false, error: { code: sent.error.code } };
    }
    return { ok: true, value: { kind: "send_indeterminate", rfcMessageId } };
  }
  input.sql.exec(
    `UPDATE connector_email_operational_proposal
        SET state = 'sent', sent_message_id = ?, sent_thread_id = ?,
            updated_at = ?
      WHERE proposal_id = ? AND version = ?`,
    sent.value.messageId,
    sent.value.threadId,
    input.now,
    record.proposalId,
    record.version,
  );
  return {
    ok: true,
    value: {
      kind: "sent",
      providerMessageId: sent.value.messageId,
      providerThreadId: sent.value.threadId,
      version: record.version,
      snapshotDigest: currentSnapshotDigest,
    },
  };
}

async function submitOperationalEmail(
  input: Parameters<typeof dispatchOperationalEmail>[0],
  record: OperationalEmailProposalRecord,
  rfcMessageId: string,
  request: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<Response> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    throw new Error("connector_placement_conflict");
  // Purge before issuance so a lost provider response cannot retain readable content.
  input.sql.exec(
    `INSERT INTO connector_email_operational_dispatch (proposal_id, version, rfc_message_id)
     VALUES (?, ?, ?) ON CONFLICT (proposal_id, version) DO UPDATE SET rfc_message_id = excluded.rfc_message_id`,
    record.proposalId,
    record.version,
    rfcMessageId,
  );
  input.sql.exec(
    `UPDATE connector_email_operational_proposal
     SET state = 'send_indeterminate', approved_snapshot_digest = ?, updated_at = ?,
         nonce_b64 = NULL, ciphertext_b64 = NULL, content_bytes = NULL
     WHERE proposal_id = ? AND version = ? AND state = 'awaiting_approval'`,
    input.approvedSnapshotDigest,
    input.now,
    record.proposalId,
    record.version,
  );
  return fetch(request, init);
}

export function readOperationalEmailDispatchId(
  sql: SqlStorage,
  record: OperationalEmailProposalRecord,
): string | null {
  const row = sql
    .exec<{ rfcMessageId: string }>(
      `SELECT rfc_message_id AS rfcMessageId FROM connector_email_operational_dispatch
     WHERE proposal_id = ? AND version = ?`,
      record.proposalId,
      record.version,
    )
    .toArray()[0];
  return row?.rfcMessageId ?? null;
}

export function pendingOperationalEmailProjections(
  sql: SqlStorage,
): readonly OperationalEmailProposalRecord[] {
  const rows = sql
    .exec<{ proposalId: string }>(
      `SELECT p.proposal_id AS proposalId FROM connector_email_operational_proposal p
     LEFT JOIN connector_email_operational_projection w ON w.proposal_id = p.proposal_id
     WHERE p.version = (SELECT MAX(version) FROM connector_email_operational_proposal WHERE proposal_id = p.proposal_id)
       AND (w.proposal_id IS NULL OR w.version != p.version OR w.state != p.state OR w.updated_at != p.updated_at)
     ORDER BY p.updated_at LIMIT ?`,
      OPERATIONAL_EMAIL_PROJECTION_BATCH_SIZE,
    )
    .toArray();
  const pending: OperationalEmailProposalRecord[] = [];
  for (const row of rows) {
    const record = latestOperationalEmailProposal(sql, row.proposalId);
    if (record !== null) pending.push(record);
  }
  return pending;
}

export function settleOperationalEmailProjection(
  sql: SqlStorage,
  record: OperationalEmailProposalRecord,
): void {
  sql.exec(
    `INSERT INTO connector_email_operational_projection (proposal_id, version, state, updated_at)
     VALUES (?, ?, ?, ?) ON CONFLICT (proposal_id) DO UPDATE SET
       version = excluded.version, state = excluded.state, updated_at = excluded.updated_at`,
    record.proposalId,
    record.version,
    record.state,
    record.updatedAt,
  );
}

export function nextOperationalEmailMaintenanceAt(
  sql: SqlStorage,
): number | null {
  const projectionAt =
    pendingOperationalEmailProjections(sql).length > 0
      ? Date.now() + OPERATIONAL_EMAIL_PROJECTION_RETRY_MS
      : null;
  const row = sql
    .exec<{ expiresAt: number | null }>(
      "SELECT MIN(expires_at) AS expiresAt FROM connector_email_operational_proposal WHERE state = 'awaiting_approval'",
    )
    .toArray()[0];
  const expiresAt = row?.expiresAt ?? null;
  if (projectionAt === null) return expiresAt;
  return expiresAt === null ? projectionAt : Math.min(projectionAt, expiresAt);
}

export function rejectOperationalEmailProposal(
  sql: SqlStorage,
  proposalId: string,
  version: number,
  now: number,
): Result<null, OperationalEmailProposalError> {
  const record = readOperationalEmailProposal(sql, proposalId, version);
  if (record === null)
    return { ok: false, error: { code: "operational_email_proposal_missing" } };
  if (record.state !== "awaiting_approval") {
    return {
      ok: false,
      error: { code: "operational_email_proposal_immutable" },
    };
  }
  purgeOperationalEmailContent(sql, proposalId, version);
  sql.exec(
    `UPDATE connector_email_operational_proposal SET state = 'rejected', updated_at = ?
     WHERE proposal_id = ? AND version = ?`,
    now,
    proposalId,
    version,
  );
  return { ok: true, value: null };
}

export function expireOperationalEmailProposals(
  sql: SqlStorage,
  now: number,
): readonly OperationalEmailProposalRecord[] {
  const expired = sql
    .exec<{ readonly proposalId: string; readonly version: number }>(
      `SELECT proposal_id AS proposalId, version
       FROM connector_email_operational_proposal
       WHERE state = 'awaiting_approval' AND expires_at <= ?`,
      now,
    )
    .toArray();
  for (const proposal of expired) {
    purgeOperationalEmailContent(sql, proposal.proposalId, proposal.version);
    sql.exec(
      `UPDATE connector_email_operational_proposal
       SET state = 'expired', updated_at = ?
       WHERE proposal_id = ? AND version = ? AND state = 'awaiting_approval'`,
      now,
      proposal.proposalId,
      proposal.version,
    );
  }
  return expired
    .map((proposal) =>
      readOperationalEmailProposal(sql, proposal.proposalId, proposal.version),
    )
    .filter(
      (proposal): proposal is OperationalEmailProposalRecord =>
        proposal !== null,
    );
}

export function revokeOperationalEmailProposals(
  sql: SqlStorage,
  integrationAccountId: IntegrationAccountId,
  now: number,
): readonly OperationalEmailProposalRecord[] {
  const pending = sql
    .exec<{ readonly proposalId: string; readonly version: number }>(
      `SELECT proposal_id AS proposalId, version
       FROM connector_email_operational_proposal
       WHERE integration_account_id = ? AND state = 'awaiting_approval'`,
      integrationAccountId,
    )
    .toArray();
  for (const proposal of pending) {
    purgeOperationalEmailContent(sql, proposal.proposalId, proposal.version);
    sql.exec(
      `UPDATE connector_email_operational_proposal
       SET state = 'revoked', updated_at = ?
       WHERE proposal_id = ? AND version = ? AND state = 'awaiting_approval'`,
      now,
      proposal.proposalId,
      proposal.version,
    );
  }
  return pending
    .map((proposal) =>
      readOperationalEmailProposal(sql, proposal.proposalId, proposal.version),
    )
    .filter(
      (proposal): proposal is OperationalEmailProposalRecord =>
        proposal !== null,
    );
}

export function latestOperationalEmailProposal(
  sql: SqlStorage,
  proposalId: string,
): OperationalEmailProposalRecord | null {
  const row = sql
    .exec<OperationalEmailProposalRow>(
      `SELECT proposal_id AS proposalId, version, case_id AS caseId,
          integration_account_id AS integrationAccountId, target_json AS targetJson,
          target_digest AS targetDigest, subject_digest AS subjectDigest,
          body_digest AS bodyDigest, snapshot_digest AS snapshotDigest,
          policy_version AS policyVersion, credential_generation AS credentialGeneration,
          state, approved_snapshot_digest AS approvedSnapshotDigest,
          nonce_b64 AS nonceB64, ciphertext_b64 AS ciphertextB64,
          content_bytes AS contentBytes, sent_message_id AS sentMessageId,
          sent_thread_id AS sentThreadId, created_at AS createdAt,
          expires_at AS expiresAt, updated_at AS updatedAt
       FROM connector_email_operational_proposal
       WHERE proposal_id = ? ORDER BY version DESC LIMIT 1`,
      proposalId,
    )
    .toArray()[0];
  return row === undefined ? null : parseOperationalEmailProposalRow(row);
}

function readOperationalEmailProposal(
  sql: SqlStorage,
  proposalId: string,
  version: number,
): OperationalEmailProposalRecord | null {
  const row = sql
    .exec<OperationalEmailProposalRow>(
      `SELECT proposal_id AS proposalId, version, case_id AS caseId,
          integration_account_id AS integrationAccountId, target_json AS targetJson,
          target_digest AS targetDigest, subject_digest AS subjectDigest,
          body_digest AS bodyDigest, snapshot_digest AS snapshotDigest,
          policy_version AS policyVersion, credential_generation AS credentialGeneration,
          state, approved_snapshot_digest AS approvedSnapshotDigest,
          nonce_b64 AS nonceB64, ciphertext_b64 AS ciphertextB64,
          content_bytes AS contentBytes, sent_message_id AS sentMessageId,
          sent_thread_id AS sentThreadId, created_at AS createdAt,
          expires_at AS expiresAt, updated_at AS updatedAt
       FROM connector_email_operational_proposal
       WHERE proposal_id = ? AND version = ?`,
      proposalId,
      version,
    )
    .toArray()[0];
  return row === undefined ? null : parseOperationalEmailProposalRow(row);
}

function purgeOperationalEmailContent(
  sql: SqlStorage,
  proposalId: string,
  version: number,
): void {
  sql.exec(
    `UPDATE connector_email_operational_proposal
        SET nonce_b64 = NULL, ciphertext_b64 = NULL, content_bytes = NULL
      WHERE proposal_id = ? AND version = ?`,
    proposalId,
    version,
  );
}

async function operationalCipherForRecord(
  input: Readonly<{
    readonly env: Env;
    readonly sql: SqlStorage;
    readonly scope: OrganisationExecutionScope;
    readonly integrationAccountId: IntegrationAccountId;
  }>,
): Promise<Result<EmailContentCipher, OperationalEmailProposalError>> {
  const cipher = await createEmailContentCipher({
    root: input.env.DATA_ENCRYPTION_ROOT,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  return cipher.ok ? cipher : { ok: false, error: { code: cipher.error.code } };
}

async function readSender(
  input: Readonly<{
    readonly env: Env;
    readonly sql: SqlStorage;
    readonly scope: OrganisationExecutionScope;
    readonly integrationAccountId: IntegrationAccountId;
  }>,
): Promise<Result<string, OperationalEmailProposalError>> {
  const sender = await resolveEmailSenderAccount({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (sender.ok) return { ok: true, value: sender.value.observedAddress };
  return { ok: false, error: { code: sender.error.code } };
}

async function resolveOperationalGmailAuthority(
  input: Readonly<{
    readonly env: Env;
    readonly sql: SqlStorage;
    readonly scope: OrganisationExecutionScope;
    readonly integrationAccountId: IntegrationAccountId;
  }>,
): Promise<
  Result<
    {
      readonly accessToken: string;
      readonly credentialGeneration: number;
      readonly authorizationProduct: "full_mailbox_pilot" | "send_only";
    },
    OperationalEmailProposalError
  >
> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const context = await resolveActiveProviderAccountContext({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (!context.ok) return { ok: false, error: { code: context.error.code } };
  if (
    context.value.account.provider !== "gmail" ||
    context.value.connection.authorizationProduct.kind !== "gmail"
  ) {
    return { ok: false, error: { code: "operational_email_provider_invalid" } };
  }
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const credential = await resolveActiveProviderConnectionCredential({
    db: input.scope.database,
    keys: input.env,
    context: context.value,
    expectedProvider: "gmail",
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (!credential.ok)
    return { ok: false, error: { code: credential.error.code } };
  if (credential.value.kind !== "oauth_tokens") {
    return {
      ok: false,
      error: { code: "operational_email_credential_invalid" },
    };
  }
  const authority = connectionCredentialAuthority(
    context.value.connection.authority,
  );
  const token = await resolveGmailAccessToken({
    env: input.env,
    scope: input.scope,
    handle: authority.credentialRef,
    tokens: credential.value,
    product: context.value.connection.authorizationProduct.product,
    now: Date.now(),
    fetcher: fetchConnectorMail.bind(
      null,
      input.sql,
      input.scope,
      runtimeFetch,
    ),
  });
  return token.ok
    ? {
        ok: true,
        value: {
          accessToken: token.value,
          credentialGeneration: authority.credentialGeneration,
          authorizationProduct:
            context.value.connection.authorizationProduct.product,
        },
      }
    : { ok: false, error: { code: token.error.code } };
}

async function resolveOperationalGmailBinding(
  input: Readonly<{
    readonly env: Env;
    readonly sql: SqlStorage;
    readonly scope: OrganisationExecutionScope;
    readonly integrationAccountId: IntegrationAccountId;
  }>,
): Promise<
  Result<
    {
      readonly credentialGeneration: number;
      readonly authorizationProduct: "full_mailbox_pilot" | "send_only";
    },
    OperationalEmailProposalError
  >
> {
  const context = await resolveActiveProviderAccountContext({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (!context.ok) return { ok: false, error: { code: context.error.code } };
  if (
    context.value.account.provider !== "gmail" ||
    context.value.connection.authorizationProduct.kind !== "gmail"
  ) {
    return { ok: false, error: { code: "operational_email_provider_invalid" } };
  }
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const binding = await resolveActiveProviderConnectionBinding({
    db: input.scope.database,
    context: context.value,
    expectedProvider: "gmail",
  });
  if (!binding.ok) return { ok: false, error: { code: binding.error.code } };
  return {
    ok: true,
    value: {
      credentialGeneration: binding.value.credentialGeneration,
      authorizationProduct:
        context.value.connection.authorizationProduct.product,
    },
  };
}

function normalizeContent(
  subject: string,
  body: string,
): { readonly subject: string; readonly body: string } | null {
  const normalizedSubject = normalizeOperationalSubject(subject);
  const normalizedBody = normalizeOperationalBody(body);
  return normalizedSubject === null || normalizedBody === null
    ? null
    : { subject: normalizedSubject, body: normalizedBody };
}

async function digestTarget(target: EmailProposalTarget): Promise<string> {
  return sha256Hex(
    JSON.stringify({ kind: "pantry_operational_target_v1", target }),
  );
}

export async function digestOperationalEmailSnapshot(
  input: Readonly<{
    readonly proposalId: string;
    readonly version: number;
    readonly caseId: string;
    readonly integrationAccountId: IntegrationAccountId;
    readonly authorizationProduct: "full_mailbox_pilot" | "send_only";
    readonly credentialGeneration: number;
    readonly policyVersion: number;
    readonly expiresAt: number;
    readonly sender: string;
    readonly recipient: string;
    readonly targetDigest: string;
    readonly subjectDigest: string;
    readonly bodyDigest: string;
  }>,
): Promise<string> {
  return sha256Hex(
    JSON.stringify({ kind: "pantry_operational_snapshot_v1", ...input }),
  );
}

function parseContent(
  value: string,
): { readonly subject: string; readonly body: string } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    const record = Object.fromEntries(Object.entries(parsed));
    const subject = record.subject;
    const body = record.body;
    return typeof subject === "string" &&
      typeof body === "string" &&
      normalizeOperationalSubject(subject) === subject &&
      normalizeOperationalBody(body) === body
      ? { subject, body }
      : null;
  } catch {
    return null;
  }
}

type OperationalEmailProposalRow = Record<string, SqlStorageValue> &
  Readonly<{
    readonly proposalId: SqlStorageValue;
    readonly version: SqlStorageValue;
    readonly caseId: SqlStorageValue;
    readonly integrationAccountId: SqlStorageValue;
    readonly targetJson: SqlStorageValue;
    readonly targetDigest: SqlStorageValue;
    readonly subjectDigest: SqlStorageValue;
    readonly bodyDigest: SqlStorageValue;
    readonly snapshotDigest: SqlStorageValue;
    readonly policyVersion: SqlStorageValue;
    readonly credentialGeneration: SqlStorageValue;
    readonly state: SqlStorageValue;
    readonly approvedSnapshotDigest: SqlStorageValue;
    readonly nonceB64: SqlStorageValue;
    readonly ciphertextB64: SqlStorageValue;
    readonly contentBytes: SqlStorageValue;
    readonly sentMessageId: SqlStorageValue;
    readonly sentThreadId: SqlStorageValue;
    readonly createdAt: SqlStorageValue;
    readonly expiresAt: SqlStorageValue;
    readonly updatedAt: SqlStorageValue;
  }>;

function parseOperationalEmailProposalRow(
  row: OperationalEmailProposalRow,
): OperationalEmailProposalRecord {
  const integrationAccountId =
    typeof row.integrationAccountId === "string"
      ? parseIntegrationAccountId(row.integrationAccountId)
      : null;
  const target = parseTargetJson(row.targetJson);
  if (
    typeof row.proposalId !== "string" ||
    typeof row.version !== "number" ||
    !Number.isSafeInteger(row.version) ||
    row.version <= 0 ||
    typeof row.caseId !== "string" ||
    integrationAccountId === null ||
    !integrationAccountId.ok ||
    target === null ||
    !isSha256Hex(row.targetDigest) ||
    !isSha256Hex(row.subjectDigest) ||
    !isSha256Hex(row.bodyDigest) ||
    !isSha256Hex(row.snapshotDigest) ||
    typeof row.policyVersion !== "number" ||
    !Number.isSafeInteger(row.policyVersion) ||
    row.policyVersion <= 0 ||
    typeof row.credentialGeneration !== "number" ||
    !Number.isSafeInteger(row.credentialGeneration) ||
    row.credentialGeneration <= 0 ||
    !isProposalState(row.state) ||
    (row.approvedSnapshotDigest !== null &&
      !isSha256Hex(row.approvedSnapshotDigest)) ||
    (row.nonceB64 !== null && typeof row.nonceB64 !== "string") ||
    (row.ciphertextB64 !== null && typeof row.ciphertextB64 !== "string") ||
    (row.contentBytes !== null &&
      (typeof row.contentBytes !== "number" ||
        !Number.isSafeInteger(row.contentBytes))) ||
    (row.sentMessageId !== null && typeof row.sentMessageId !== "string") ||
    (row.sentThreadId !== null && typeof row.sentThreadId !== "string") ||
    !isNonNegativeInteger(row.createdAt) ||
    !isNonNegativeInteger(row.expiresAt) ||
    !isNonNegativeInteger(row.updatedAt)
  ) {
    throw new Error("connector_email_operational_proposal_corrupt");
  }
  return {
    proposalId: row.proposalId,
    version: row.version,
    caseId: row.caseId,
    integrationAccountId: integrationAccountId.value,
    target,
    targetDigest: row.targetDigest,
    subjectDigest: row.subjectDigest,
    bodyDigest: row.bodyDigest,
    snapshotDigest: row.snapshotDigest,
    policyVersion: row.policyVersion,
    credentialGeneration: row.credentialGeneration,
    state: row.state,
    approvedSnapshotDigest:
      row.approvedSnapshotDigest === null ? null : row.approvedSnapshotDigest,
    nonceB64: row.nonceB64 === null ? null : row.nonceB64,
    ciphertextB64: row.ciphertextB64 === null ? null : row.ciphertextB64,
    contentBytes: row.contentBytes === null ? null : row.contentBytes,
    sentMessageId: row.sentMessageId === null ? null : row.sentMessageId,
    sentThreadId: row.sentThreadId === null ? null : row.sentThreadId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
  };
}

function parseTargetJson(value: unknown): EmailProposalTarget | null {
  try {
    return typeof value === "string"
      ? parseEmailProposalTarget(JSON.parse(value))
      : null;
  } catch {
    return null;
  }
}

function isProposalState(
  value: unknown,
): value is OperationalEmailProposalState {
  return (
    value === "awaiting_approval" ||
    value === "sent" ||
    value === "send_indeterminate" ||
    value === "rejected" ||
    value === "expired" ||
    value === "superseded" ||
    value === "revoked"
  );
}

export function isDefinitiveGmailSendRejection(error: GmailApiError): boolean {
  return (
    error.code === "gmail_unauthorized" ||
    error.code === "gmail_rate_limited" ||
    error.code === "gmail_not_found" ||
    (error.code === "gmail_unavailable" &&
      error.status >= 400 &&
      error.status < 500)
  );
}
