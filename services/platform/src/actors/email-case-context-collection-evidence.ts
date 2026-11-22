import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { RequestAuthority } from "@purin-labs/contracts";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseOrganisationId,
  parseCaseId,
  parseIntegrationAccountId,
} from "@purin-labs/kernel/ids";
import { readEmailReplyRecipient } from "../mail-inbox/verified-sender";
import type { FlowRecipient } from "@purin-labs/authority/policy/information-flow/types";
import type { Result } from "@purin-labs/kernel/result";
import {
  requireActiveOrganisationActor,
  resolveActiveCaseActor,
} from "@purin-labs/actor-runtime/actors/actor-router";
import {
  parseCaseContextCollectionEvidenceDependency,
  type CaseContextCollectionEvidenceDependency,
  type CaseContextCollectionEffectAttempt,
} from "../case-context-discovery/evidence";
import { caseContextCollectionEvidenceDependency } from "../case-context-discovery/evidence";
import {
  FlowBinding,
  FlowLabel,
  InformationFlowContext,
  ObservationEvidence,
  advanceInformationFlowContext,
  createCurrentSourceFlowLabel,
  decideAutomaticContextAdmission,
  currentFlowSinkCheck,
  decideFlowSink,
  evaluateFlowLabelSink,
  digestCanonical,
  digestFlowBinding,
  type SerializedFlowBinding,
} from "@purin-labs/authority/policy/information-flow/index";
import { isRecord, parseJsonOrNull } from "@purin-labs/std";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { GMAIL_MAILBOX } from "@purin-labs/connections/mail/gmail-mail-adapter";
import {
  extractMailbox,
  type GmailMessageContent,
} from "@purin-labs/connections/mail/gmail-adapter";
import { resolveConnectorGmailAccess } from "./connector-email-evaluation";
import type { Variant } from "@purin-labs/type-utils";

type MailboxAuthority = Variant<RequestAuthority, "agent_mailbox">;
type EvidenceError = Readonly<{ code: string }>;

export class EmailTurnInformationFlow {
  private constructor(
    private readonly env: Env,
    private readonly authority: MailboxAuthority,
    private readonly caseId: string,
    readonly dependency: CaseContextCollectionEvidenceDependency,
    private readonly turnId: string,
    private context: InformationFlowContext,
  ) {}

  static async create(
    input: Readonly<{
      env: Env;
      authority: MailboxAuthority;
      caseId: string;
      dependency: CaseContextCollectionEvidenceDependency;
      sessionId: string;
      turnId: string;
      authorityPartitionDigest: string;
    }>,
  ): Promise<Result<EmailTurnInformationFlow, EvidenceError>> {
    if (input.dependency.kind === "case_context_collection_evidence") {
      const label = await prepareCaseContextCollectionFlowLabel(
        input.env,
        input.authority,
        input.caseId,
        input.dependency,
      );
      if (!label.ok) return label;
    }
    const context = await InformationFlowContext.create({
      organisationId: input.authority.organisationId,
      sessionId: input.sessionId,
      authorityPartitionDigest: input.authorityPartitionDigest,
    });
    if (!context.ok) return context;
    return {
      ok: true,
      value: new EmailTurnInformationFlow(
        input.env,
        input.authority,
        input.caseId,
        input.dependency,
        input.turnId,
        context.value,
      ),
    };
  }

  binding(): SerializedFlowBinding {
    return FlowBinding.fromContext(this.context, this.turnId).toJSON();
  }

  async observe(contentDigest: string): Promise<Result<null, EvidenceError>> {
    if (this.dependency.kind !== "case_context_collection_evidence")
      return {
        ok: false,
        error: { code: "case_context_collection_evidence_invalid" },
      };
    const constrained = await prepareCaseContextCollectionFlowLabel(
      this.env,
      this.authority,
      this.caseId,
      this.dependency,
    );
    if (!constrained.ok) return constrained;
    const evidence = await ObservationEvidence.create({
      source: {
        kind: "case_context_collection_evidence",
        organisationId: this.authority.organisationId,
        caseContextCollectionId: this.dependency.caseContextCollectionId,
        dependencyDigest: await digestCanonical(this.dependency),
      },
      sourceRevision: this.dependency.caseContextCollectionRevision,
      contentDigest,
      inputLabel: constrained.value,
      observedAt: Date.now(),
    });
    if (!evidence.ok) return evidence;
    const advanced = await advanceInformationFlowContext({
      context: this.context,
      observation: evidence.value,
      inputLabel: constrained.value,
    });
    if (!advanced.ok) return advanced;
    this.context = advanced.value.context;
    return { ok: true, value: null };
  }

  /**
   * Records one admitted Memory revision the model is about to be shown, so
   * the turn's binding and every later sink check carry its restrictions.
   */
  async observeMemory(
    observation: ObservationEvidence,
    inputLabel: FlowLabel,
  ): Promise<Result<null, EvidenceError>> {
    const advanced = await advanceInformationFlowContext({
      context: this.context,
      observation,
      inputLabel,
    });
    if (!advanced.ok) return advanced;
    this.context = advanced.value.context;
    return { ok: true, value: null };
  }
}

async function prepareCaseContextCollectionFlowLabel(
  env: Env,
  authority: MailboxAuthority,
  caseId: string,
  dependency: Variant<
    CaseContextCollectionEvidenceDependency,
    "case_context_collection_evidence"
  >,
): Promise<Result<FlowLabel, EvidenceError>> {
  const valid = await validateEmailCaseContextCollectionDependency(
    env,
    authority.organisationId,
    dependency,
  );
  if (!valid.ok) return valid;
  const organisationId = parseOrganisationId(authority.organisationId);
  if (!organisationId.ok)
    return {
      ok: false,
      error: { code: "case_context_collection_evidence_invalid" },
    };
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok)
    return { ok: false, error: { code: execution.error.code } };
  const current = await createCurrentSourceFlowLabel({
    kind: "ingress",
    db: execution.value.database,
    authority,
  });
  if (!current.ok) return current;
  const originalLabels = await selectedCaseContextCollectionSourceLabels(
    env,
    dependency,
  );
  if (!originalLabels.ok) return originalLabels;
  const policies = [...current.value.policies];
  for (const original of originalLabels.value)
    policies.push(...original.policies);
  policies.push({
    owner: {
      kind: "recipient_constraint",
      organisationId: authority.organisationId,
      recipient: dependency.recipient,
    },
    readers: current.value.policies.flatMap(policyReaders),
  });
  const label = await FlowLabel.create(
    policies,
    originalLabels.value.find((original) => original.writer !== undefined)
      ?.writer,
  );
  if (!label.ok) return label;
  const admission = await decideAutomaticContextAdmission({
    subject: { kind: "authority_derived", requestAuthority: authority, caseId },
    inputLabel: label.value,
    recipient: dependency.recipient,
  });
  return admission.kind === "admit"
    ? label
    : { ok: false, error: { code: "email_evidence_admission_denied" } };
}

async function selectedCaseContextCollectionSourceLabels(
  env: Env,
  dependency: Variant<
    CaseContextCollectionEvidenceDependency,
    "case_context_collection_evidence"
  >,
): Promise<Result<readonly FlowLabel[], EvidenceError>> {
  const organisationId = parseOrganisationId(
    dependency.recipient.organisationId,
  );
  if (!organisationId.ok) return organisationId;
  const labels: FlowLabel[] = [];
  for (const selected of dependency.selections) {
    const caseId = parseCaseId(selected.source.caseId);
    if (!caseId.ok) return caseId;
    const actor = await resolveActiveCaseActor({
      env: env,
      namespace: env.CASE,
      organisationId: organisationId.value,
      caseId: caseId.value,
      now: Date.now(),
    });
    if (!actor.ok) return actor;
    const metadata = await actor.value.readMetadata({
      organisationId: organisationId.value,
      caseId: caseId.value,
      entryId: `trigger:trigger_email_${selected.source.reference}`,
    });
    if (!metadata.ok)
      return {
        ok: false,
        error: { code: "case_context_collection_evidence_stale" },
      };
    const label = await FlowLabel.restore(metadata.value.inputLabel);
    if (!label.ok) return label;
    labels.push(label.value);
  }
  return { ok: true, value: labels };
}
function policyReaders(
  policy: import("@purin-labs/authority/policy/information-flow/index").CanonicalFlowPolicy,
) {
  return policy.readers;
}

export async function prepareEmailCaseContextCollectionDependency(
  env: Env,
  input: Readonly<{
    organisationId: string;
    caseId: string;
    integrationAccountId: string;
    triggeringMessageId: string;
  }>,
): Promise<Result<CaseContextCollectionEvidenceDependency, EvidenceError>> {
  const organisationId = parseOrganisationId(input.organisationId);
  if (!organisationId.ok) return organisationId;
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: organisationId.value,
    now: Date.now(),
  });
  const result = await organisation.prepareCaseContextCollectionEvidence({
    organisationId: organisationId.value,
    caseId: input.caseId,
    integrationAccountId: input.integrationAccountId,
    triggeringMessageId: input.triggeringMessageId,
  });
  if (!result.ok) return result;
  const dependency = parseCaseContextCollectionEvidenceDependency(result.value);
  return dependency === null
    ? { ok: false, error: { code: "case_context_collection_evidence_invalid" } }
    : { ok: true, value: dependency };
}

export async function validateEmailCaseContextCollectionDependency(
  env: Env,
  organisation: string,
  dependency: CaseContextCollectionEvidenceDependency,
): Promise<Result<null, EvidenceError>> {
  if (dependency.kind === "source_only") return { ok: true, value: null };
  const organisationId = parseOrganisationId(organisation);
  if (!organisationId.ok) return organisationId;
  const actor = await requireActiveOrganisationActor({
    env,
    organisationId: organisationId.value,
    now: Date.now(),
  });
  return actor.validateCaseContextCollectionEvidence({
    organisationId: organisationId.value,
    dependency,
  });
}

export async function validateCaseContextCollectionEmailMessage(
  env: Env,
  dependency: Variant<
    CaseContextCollectionEvidenceDependency,
    "case_context_collection_evidence"
  >,
  messageId: string,
  content: GmailMessageContent,
): Promise<Result<null, EvidenceError>> {
  const valid = await validateEmailCaseContextCollectionDependency(
    env,
    dependency.recipient.organisationId,
    dependency,
  );
  if (!valid.ok) return valid;
  const organisationId = parseOrganisationId(
    dependency.recipient.organisationId,
  );
  if (!organisationId.ok)
    return {
      ok: false,
      error: { code: "case_context_collection_evidence_invalid" },
    };
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok)
    return { ok: false, error: { code: execution.error.code } };
  const receipt = await execution.value.database
    .prepare(
      `SELECT gmail_thread_id AS thread_id FROM email_message_receipt WHERE organisation_id = ? AND integration_account_id = ? AND provider_message_id = ? AND contact_verification_id = ? AND contact_verification_revision = ?`,
    )
    .bind(
      dependency.recipient.organisationId,
      dependency.recipient.integrationAccountId,
      messageId,
      dependency.recipient.verificationId,
      dependency.recipient.verificationRevision,
    )
    .first<{ thread_id: string }>();
  const sender =
    content.headers.from === null ? null : extractMailbox(content.headers.from);
  const replyTo =
    content.headers.replyTo === null
      ? sender
      : extractMailbox(content.headers.replyTo);
  if (
    receipt === null ||
    receipt.thread_id !== content.threadId ||
    sender === null ||
    replyTo !== sender ||
    (await digestCanonical(sender)) !== dependency.recipient.endpointDigest
  )
    return { ok: false, error: { code: "email_recipient_mismatch" } };
  return { ok: true, value: null };
}

async function validateCaseContextCollectionProviderSources(
  env: Env,
  dependency: Variant<
    CaseContextCollectionEvidenceDependency,
    "case_context_collection_evidence"
  >,
): Promise<Result<null, EvidenceError>> {
  const access = await resolveConnectorGmailAccess({
    env,
    organisationId: dependency.recipient.organisationId,
    integrationAccountId: dependency.recipient.integrationAccountId,
    now: Date.now(),
    fetcher: runtimeFetch,
  });
  if (!access.ok) return access;
  for (const selected of dependency.selections) {
    const content = await GMAIL_MAILBOX.reads.readMessage({
      accessToken: access.value,
      messageId: selected.source.reference,
      fetcher: runtimeFetch,
    });
    if (!content.ok) {
      if (content.error.code === "gmail_not_found") {
        const organisationId = parseOrganisationId(
          dependency.recipient.organisationId,
        );
        if (!organisationId.ok) return organisationId;
        const organisation = await requireActiveOrganisationActor({
          env,
          organisationId: organisationId.value,
          now: Date.now(),
        });
        await organisation.eraseCaseContextCollectionSource({
          organisationId: organisationId.value,
          selection: selected.source,
        });
        return {
          ok: false,
          error: { code: "case_context_collection_evidence_stale" },
        };
      }
      return content;
    }
    const valid = await validateCaseContextCollectionEmailMessage(
      env,
      dependency,
      selected.source.reference,
      content.value,
    );
    if (!valid.ok) return valid;
  }
  return { ok: true, value: null };
}

export function createEmailProposalFlowSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS email_proposal_flow (
    proposal_id TEXT PRIMARY KEY, dependency_json TEXT NOT NULL CHECK (json_valid(dependency_json)),
    binding_json TEXT NOT NULL CHECK (json_valid(binding_json))
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS email_proposal_case_context_collection_effect (
    attempt_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json))
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS email_case_context_collection_draft_attempt (
    proposal_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL,
    rfc_message_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('indeterminate', 'completed', 'cleanup_pending', 'deleted'))
  )`);
}

export function claimEmailCaseContextCollectionDraft(
  sql: SqlStorage,
  proposalId: string,
  requestDigest: string,
  rfcMessageId: string,
  expiresAt: number,
): Result<null, EvidenceError> {
  const flow = readEmailProposalFlow(sql, proposalId);
  if (flow === null || flow.dependency.kind === "source_only")
    return { ok: true, value: null };
  const previous = sql
    .exec<{ request_digest: string }>(
      "SELECT request_digest FROM email_case_context_collection_draft_attempt WHERE proposal_id = ?",
      proposalId,
    )
    .toArray()[0];
  if (previous !== undefined)
    return {
      ok: false,
      error: {
        code:
          previous.request_digest === requestDigest
            ? "email_draft_creation_indeterminate"
            : "email_proposal_conflict",
      },
    };
  sql.exec(
    "INSERT INTO email_case_context_collection_draft_attempt VALUES (?, ?, ?, ?, 'indeterminate')",
    proposalId,
    requestDigest,
    rfcMessageId,
    expiresAt,
  );
  return { ok: true, value: null };
}

export function recordEmailProposalFlow(
  sql: SqlStorage,
  proposalId: string,
  dependency: CaseContextCollectionEvidenceDependency,
  binding: SerializedFlowBinding,
): Result<null, EvidenceError> {
  const current = readEmailProposalFlow(sql, proposalId);
  if (current !== null)
    return JSON.stringify(current.dependency) === JSON.stringify(dependency) &&
      JSON.stringify(current.binding) === JSON.stringify(binding)
      ? { ok: true, value: null }
      : { ok: false, error: { code: "email_proposal_flow_conflict" } };
  sql.exec(
    "INSERT INTO email_proposal_flow VALUES (?, ?, ?)",
    proposalId,
    JSON.stringify(dependency),
    JSON.stringify(binding),
  );
  return { ok: true, value: null };
}

/**
 * Removes the flow record of a proposal that has no draft receipt, so a
 * fresh attempt at its turn records the flow it produces.
 */
export function clearEmailProposalFlow(
  sql: SqlStorage,
  proposalId: string,
): void {
  sql.exec("DELETE FROM email_proposal_flow WHERE proposal_id = ?", proposalId);
}

export function readEmailProposalFlow(
  sql: SqlStorage,
  proposalId: string,
): Readonly<{
  dependency: CaseContextCollectionEvidenceDependency;
  binding: unknown;
}> | null {
  const row = sql
    .exec<{ dependency_json: string; binding_json: string }>(
      "SELECT * FROM email_proposal_flow WHERE proposal_id = ?",
      proposalId,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const dependency = parseCaseContextCollectionEvidenceDependency(
    parseJsonOrNull(row.dependency_json),
  );
  const binding: unknown = parseJsonOrNull(row.binding_json);
  if (dependency === null || !isRecord(binding))
    throw new Error("email_proposal_flow_corrupt");
  return { dependency, binding };
}

export async function authorizeEmailProposalFlow(
  input: Readonly<{
    env: Env;
    sql: SqlStorage;
    proposalId: string;
    authority: MailboxAuthority;
    surface: "draft" | "preview" | "send";
    to: string;
    approvalSatisfied: boolean;
    /** The Case and the admitted message the proposal replies to. */
    caseId: string;
    triggeringMessageId: string;
  }>,
): Promise<Result<FlowBinding | null, EvidenceError>> {
  const organisationId = parseOrganisationId(input.authority.organisationId);
  if (!organisationId.ok)
    return {
      ok: false,
      error: { code: "case_context_collection_evidence_invalid" },
    };
  const execution = await OrganisationExecutionScope.resolve(
    input.env,
    organisationId.value,
  );
  if (!execution.ok)
    return { ok: false, error: { code: execution.error.code } };
  const stored = readEmailProposalFlow(input.sql, input.proposalId);
  // Existing source-only proposals are normalized at this persistence boundary.
  if (stored === null) return { ok: true, value: null };
  const binding = await FlowBinding.restore(stored.binding);
  if (
    !binding.ok ||
    binding.value.organisationId !== input.authority.organisationId
  )
    return { ok: false, error: { code: "email_proposal_flow_invalid" } };
  const valid = await validateEmailCaseContextCollectionDependency(
    input.env,
    input.authority.organisationId,
    stored.dependency,
  );
  if (!valid.ok) return valid;
  if (
    stored.dependency.kind === "case_context_collection_evidence" &&
    !binding.value.flowLabel.policies.some(isRecipientConstraint)
  )
    return { ok: false, error: { code: "email_proposal_flow_invalid" } };
  if (
    stored.dependency.kind === "case_context_collection_evidence" &&
    stored.dependency.recipient.endpointDigest !==
      (await digestCanonical(input.to))
  )
    return { ok: false, error: { code: "email_recipient_mismatch" } };
  const sink = emailProposalSink(
    stored.dependency,
    input.authority,
    input.approvalSatisfied,
    stored.dependency.kind === "source_only"
      ? await plainReplyRecipient(execution.value.database, input)
      : null,
  );
  const organisationAuthz = await currentFlowSinkCheck({
    db: execution.value.database,
    flowLabel: binding.value.flowLabel,
    sink,
  });
  if (!organisationAuthz.ok)
    return { ok: false, error: { code: "email_disclosure_denied" } };
  const decision = await decideFlowSink({
    ...organisationAuthz.value,
    binding: binding.value,
  });
  if (decision.kind !== "allow")
    return { ok: false, error: { code: "email_disclosure_denied" } };
  if (stored.dependency.kind === "case_context_collection_evidence") {
    const available = await validateCaseContextCollectionProviderSources(
      input.env,
      stored.dependency,
    );
    if (!available.ok) return available;
  }
  const current = await createCurrentSourceFlowLabel({
    kind: "ingress",
    db: execution.value.database,
    authority: input.authority,
  });
  if (!current.ok) return current;
  if (
    evaluateFlowLabelSink({
      ...organisationAuthz.value,
      flowLabel: current.value,
    }).kind !== "allow"
  )
    return { ok: false, error: { code: "email_disclosure_denied" } };
  return { ok: true, value: binding.value };
}

/**
 * The verified recipient a plain reply is bound to at one surface. It is
 * derived again each time from the admitted message and its verification as
 * they stand now. A reply addressed anywhere but the verified address is
 * bound to nobody.
 */
async function plainReplyRecipient(
  db: OrganisationDatabase,
  input: Pick<
    Parameters<typeof authorizeEmailProposalFlow>[0],
    "authority" | "caseId" | "triggeringMessageId" | "to"
  >,
): Promise<FlowRecipient | null> {
  const recipient = await readPlainReplyRecipient(db, {
    organisationId: input.authority.organisationId,
    integrationAccountId: input.authority.integrationAccountId,
    caseId: input.caseId,
    triggeringMessageId: input.triggeringMessageId,
  });
  return recipient !== null &&
    recipient.endpointDigest === (await digestCanonical(input.to))
    ? recipient
    : null;
}

/**
 * The verified recipient a plain reply to one admitted message is bound to,
 * before its address is known. Mail admission bound the message to its
 * sender's verification only when a reply goes to that sender.
 */
export async function readPlainReplyRecipient(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: string;
    integrationAccountId: string;
    caseId: string;
    triggeringMessageId: string;
  }>,
): Promise<FlowRecipient | null> {
  const organisationId = parseOrganisationId(input.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    input.integrationAccountId,
  );
  const caseId = parseCaseId(input.caseId);
  if (!organisationId.ok || !integrationAccountId.ok || !caseId.ok) return null;
  return readEmailReplyRecipient({
    db,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    caseId: caseId.value,
    messageId: input.triggeringMessageId,
  });
}

/**
 * The sink a proposal's flow passes before it is drafted, previewed or sent.
 * Every reply is a mailbox tool effect, including replies on collected
 * evidence. Recipient binding adds a restriction without changing which
 * organisation capability rules govern the effect.
 */
function emailProposalSink(
  dependency: CaseContextCollectionEvidenceDependency,
  authority: MailboxAuthority,
  approvalSatisfied: boolean,
  plainRecipient: FlowRecipient | null,
) {
  const recipient =
    dependency.kind === "case_context_collection_evidence"
      ? dependency.recipient
      : plainRecipient;
  return {
    kind: "tool_effect" as const,
    destinationAuthority: authority,
    capabilityId: CAPABILITY_KEYS.emailReplyPropose,
    integrationAccountId: authority.integrationAccountId,
    resourceScope: "mailbox",
    approvalSatisfied,
    ...(recipient === null ? {} : { recipient }),
  };
}

/**
 * Whether the draft this turn produces could carry content under `label`. It
 * is the sink check the stored proposal flow must pass when the draft is
 * created, before any approval. Optional context is offered to the turn only
 * when this allows it; the proposal's cumulative flow is still checked then.
 * `plainRecipient` is the verified recipient a plain reply is bound to.
 */
export async function emailTurnDestinationMayReceive(
  db: OrganisationDatabase,
  authority: MailboxAuthority,
  dependency: CaseContextCollectionEvidenceDependency,
  label: FlowLabel,
  plainRecipient: FlowRecipient | null,
): Promise<"allow" | "deny"> {
  const check = await currentFlowSinkCheck({
    db,
    flowLabel: label,
    sink: emailProposalSink(dependency, authority, false, plainRecipient),
  });
  return check.ok && evaluateFlowLabelSink(check.value).kind === "allow"
    ? "allow"
    : "deny";
}

function isRecipientConstraint(
  policy: import("@purin-labs/authority/policy/information-flow/index").CanonicalFlowPolicy,
): boolean {
  return policy.owner.kind === "recipient_constraint";
}

export async function fenceEmailCaseContextCollectionEffect(
  input: Readonly<{
    env: Env;
    sql: SqlStorage;
    proposalId: string;
    caseId: string;
    version: number;
    effect: "draft" | "send";
    targetDigest: string;
    contentDigest: string;
    binding: FlowBinding | null;
    expiresAt: number;
  }>,
): Promise<Result<null, EvidenceError>> {
  const stored = readEmailProposalFlow(input.sql, input.proposalId);
  if (stored === null || stored.dependency.kind === "source_only")
    return { ok: true, value: null };
  if (input.binding === null)
    return { ok: false, error: { code: "email_proposal_flow_invalid" } };
  const organisationId = parseOrganisationId(input.binding.organisationId);
  if (!organisationId.ok) return organisationId;
  const attempt: CaseContextCollectionEffectAttempt = {
    attemptId: `${input.proposalId}.${input.version}.${input.effect}`,
    caseId: input.caseId,
    proposalId: input.proposalId,
    proposalVersion: input.version,
    effect: input.effect,
    targetDigest: input.targetDigest,
    contentDigest: input.contentDigest,
    flowBindingDigest: await digestFlowBinding(input.binding),
    dependency: stored.dependency,
    expiresAt: input.expiresAt,
  };
  const actor = await requireActiveOrganisationActor({
    env: input.env,
    organisationId: organisationId.value,
    now: Date.now(),
  });
  const receipt = await actor.commitCaseContextCollectionEffectFence({
    organisationId: organisationId.value,
    attempt,
  });
  if (!receipt.ok) return receipt;
  if (receipt.value.kind === "rejected")
    return { ok: false, error: { code: receipt.value.reason } };
  input.sql.exec(
    "INSERT INTO email_proposal_case_context_collection_effect VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    attempt.attemptId,
    input.proposalId,
    JSON.stringify(receipt.value),
  );
  return { ok: true, value: null };
}

export function invalidateEmailCaseContextCollectionProposals(
  sql: SqlStorage,
  input: Readonly<{
    caseContextCollectionId: string;
    caseContextCollectionRevision: number;
    policyRevision: number;
    now: number;
  }>,
): void {
  const rows = sql
    .exec<{ proposal_id: string; dependency_json: string }>(
      "SELECT proposal_id, dependency_json FROM email_proposal_flow",
    )
    .toArray();
  for (const row of rows) {
    const dependency = parseCaseContextCollectionEvidenceDependency(
      parseJsonOrNull(row.dependency_json),
    );
    if (
      dependency?.kind !== "case_context_collection_evidence" ||
      dependency.caseContextCollectionId !== input.caseContextCollectionId ||
      (dependency.caseContextCollectionRevision ===
        input.caseContextCollectionRevision &&
        dependency.policyRevision === input.policyRevision)
    )
      continue;
    sql.exec(
      `UPDATE connector_email_draft SET state = 'cleanup_pending', updated_at = ?
      WHERE proposal_id = ? AND state IN ('awaiting_approval', 'invalidated')`,
      input.now,
      row.proposal_id,
    );
    sql.exec(
      "UPDATE email_case_context_collection_draft_attempt SET state = 'cleanup_pending' WHERE proposal_id = ? AND state = 'indeterminate'",
      row.proposal_id,
    );
  }
}

export function nextEmailCaseContextCollectionDraftCleanupAt(
  sql: SqlStorage,
): number | null {
  const row = sql
    .exec<{ due_at: number | null }>(
      `SELECT MIN(CASE state WHEN 'cleanup_pending' THEN 0 ELSE expires_at END) AS due_at
    FROM email_case_context_collection_draft_attempt WHERE state IN ('indeterminate', 'cleanup_pending')`,
    )
    .toArray()[0];
  return row?.due_at ?? null;
}

export function emailCaseContextDiscoveryDraftCleanupCandidates(
  sql: SqlStorage,
  now: number,
): readonly Readonly<{ proposalId: string; rfcMessageId: string }>[] {
  return sql
    .exec<{ proposal_id: string; rfc_message_id: string }>(
      `SELECT proposal_id, rfc_message_id FROM email_case_context_collection_draft_attempt
    WHERE state = 'cleanup_pending' OR (state = 'indeterminate' AND expires_at <= ?) LIMIT 20`,
      now,
    )
    .toArray()
    .map(draftCleanupCandidate);
}

function draftCleanupCandidate(
  row: Readonly<{ proposal_id: string; rfc_message_id: string }>,
) {
  return { proposalId: row.proposal_id, rfcMessageId: row.rfc_message_id };
}

export async function readEmailProposalEvidence(
  sql: SqlStorage,
  proposalId: string,
): Promise<
  import("../case-context-discovery/evidence").CaseContextCollectionProposalEvidence
> {
  const stored = readEmailProposalFlow(sql, proposalId);
  if (stored === null || stored.dependency.kind === "source_only")
    return { kind: "source_only" };
  const binding = await FlowBinding.restore(stored.binding);
  if (!binding.ok) throw new Error("email_proposal_flow_corrupt");
  const dependency = await caseContextCollectionEvidenceDependency(
    stored.dependency,
  );
  if (dependency.kind === "source_only")
    throw new Error("case_context_collection_evidence_corrupt");
  return {
    kind: "case_context_collection_evidence",
    dependency,
    flowBindingDigest: await digestFlowBinding(binding.value),
  };
}
