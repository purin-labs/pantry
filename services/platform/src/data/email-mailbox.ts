import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
  type OrganisationPlacementBindings,
} from "../organisation-execution-scope";

import {
  parseCaseId,
  parseOrganisationId,
  parseIntegrationAccountId,
  type CaseId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  emailReplyProposalSupersedes,
  emailReplyProposalTransition,
  isEmailReplyProposalKind,
  type EmailReplyProposalKind,
} from "./email-reply-proposal-lifecycle";
import {
  hasOnlyKeys,
  isNonBlankString,
  isRecord,
  nonNegativeIntegerOrNull,
  positiveIntegerOrNull,
} from "@purin-labs/std";

type EmailEnvironment = "development" | "production";

type EmailMailboxAccount = {
  readonly integrationAccountId: IntegrationAccountId;
  readonly organisationId: OrganisationId;
  readonly environment: EmailEnvironment;
  readonly googleSubject: string;
  readonly observedAddress: string;
  readonly addressObservedAt: number;
};

type AgentMailboxBinding = {
  readonly mailboxBindingId: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly currentRevision: number;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

type AgentMailboxBindingRevision = {
  readonly mailboxBindingId: string;
  readonly revision: number;
  readonly organisationId: OrganisationId;
  readonly installationId: string;
  readonly responsePolicy: "cue_routed";
  readonly grantsDigest: string;
  readonly policyDigest: string;
  readonly createdBy: string;
  readonly createdAt: number;
};

export type MailboxIngressDebounce = {
  readonly kind: "push_triggered";
  readonly coalesceSeconds: 30;
};

type MailboxIngressOverflow = "pause_and_notify";

export type MailboxIngressPolicy =
  | {
      readonly kind: "disabled_by_default";
      readonly connectedAt: number;
    }
  | {
      readonly kind: "disabled_by_operator";
      readonly policyVersion: number;
      readonly publishedBy: string;
      readonly publishedAt: number;
    }
  | {
      readonly kind: "enabled";
      readonly policyVersion: number;
      readonly maxActiveCases: number;
      readonly maxMessagesPerHour: number;
      readonly dailyTokenBudget: number;
      readonly maxMessageBytes: number;
      readonly maxAttachmentBytes: number;
      readonly debounce: MailboxIngressDebounce;
      readonly overflow: MailboxIngressOverflow;
      readonly publishedBy: string;
      readonly publishedAt: number;
    };

export type MailboxIngressPolicyPublishRequest =
  | { readonly kind: "disabled_by_operator" }
  | {
      readonly kind: "enabled";
      readonly maxActiveCases: number;
      readonly maxMessagesPerHour: number;
      readonly dailyTokenBudget: number;
      readonly maxMessageBytes: number;
      readonly maxAttachmentBytes: number;
      readonly debounce: MailboxIngressDebounce;
      readonly overflow: MailboxIngressOverflow;
    };

export type MailboxProcessingPauseReason =
  | {
      readonly kind: "active_case_limit";
      readonly observed: number;
      readonly limit: number;
    }
  | {
      readonly kind: "hourly_message_limit";
      readonly observed: number;
      readonly limit: number;
      readonly windowEndsAt: number;
    }
  | {
      readonly kind: "daily_token_budget";
      readonly reserved: number;
      readonly consumed: number;
      readonly limit: number;
      readonly windowEndsAt: number;
    }
  | {
      readonly kind: "message_too_large";
      readonly providerMessageId: string;
      readonly observedBytes: number;
      readonly limitBytes: number;
    }
  | {
      readonly kind: "attachment_too_large";
      readonly providerMessageId: string;
      readonly providerAttachmentId: string;
      readonly observedBytes: number;
      readonly limitBytes: number;
    }
  | {
      readonly kind: "attachment_total_too_large";
      readonly providerMessageId: string;
      readonly observedBytes: number;
      readonly limitBytes: number;
    }
  | {
      /**
       * Gmail will not issue an access token for this mailbox any more. Unlike
       * a limit pause, no window rolls over and no operator setting clears it:
       * processing stays closed until someone re-authorizes.
       */
      readonly kind: "authorization_expired";
      readonly reasonCode: string;
      readonly observedAt: number;
    };

type EmailProposalDisposal =
  | { readonly kind: "cleanup_pending" }
  | { readonly kind: "cleaned"; readonly deletedAt: number }
  | { readonly kind: "cleanup_unreachable"; readonly reason: string };

export type EmailReplyProposalLifecycle =
  | { readonly kind: "draft_creation_indeterminate" }
  | { readonly kind: "awaiting_approval" }
  | {
      readonly kind: "approved";
      readonly approvedBy: string;
      readonly approvedAt: number;
      readonly approvedSnapshotDigest: string;
    }
  | {
      readonly kind: "sent";
      readonly providerMessageId: string;
      readonly sentAt: number;
    }
  | {
      readonly kind: "send_indeterminate";
      readonly rfcMessageId: string;
    }
  | {
      readonly kind: "operator_attested_present" | "operator_attested_absent";
      readonly attestedBy: string;
      readonly attestedAt: number;
    }
  | { readonly kind: "proposal_missing" }
  | {
      readonly kind: "invalidated";
      readonly reason: "target_changed" | "unsupported_content";
      readonly disposal: EmailProposalDisposal;
    }
  | {
      readonly kind: "rejected";
      readonly rejectedBy: string;
      readonly rejectedAt: number;
      readonly disposal: EmailProposalDisposal;
    }
  | {
      readonly kind: "expired";
      readonly expiredAt: number;
      readonly disposal: EmailProposalDisposal;
    }
  | {
      readonly kind: "superseded";
      readonly supersededByVersion: number;
      readonly disposal: EmailProposalDisposal;
    }
  | {
      readonly kind: "revoked";
      readonly revokedAt: number;
      readonly disposal: EmailProposalDisposal;
    };

type EmailFieldError = {
  readonly code: "missing_field" | "invalid_field";
  readonly field: string;
};

type EmailMailboxAccountError =
  | { readonly code: "email_mailbox_identity_claimed" }
  | { readonly code: "email_mailbox_account_missing" }
  | { readonly code: "email_mailbox_write_failed" };

type AgentMailboxAssignmentError =
  | { readonly code: "email_mailbox_account_missing" }
  | { readonly code: "mailbox_installation_inactive" }
  | { readonly code: "mailbox_binding_write_failed" };

type MailboxPolicyPublishError =
  | { readonly code: "email_mailbox_account_missing" }
  | { readonly code: "mailbox_policy_publish_conflict" };

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const EMAIL_CUE_COALESCE_SECONDS = 30;

export function gmailThreadCaseIdValue(
  integrationAccountId: string,
  gmailThreadId: string,
): Result<CaseId, { readonly code: "invalid_field"; readonly field: string }> {
  const parsed = parseCaseId(
    `case_gmail_${integrationAccountId}_${gmailThreadId}`,
  );
  return parsed.ok
    ? parsed
    : { ok: false, error: { code: "invalid_field", field: "gmailThreadId" } };
}

type GmailPilotBudget = {
  readonly environment: string;
  readonly consumed: number;
  readonly operatingCap: number;
  readonly submissionTrigger: number;
  readonly remaining: number;
  readonly status: "healthy" | "submit_verification" | "exhausted";
};

/**
 * Google's test-user allowance counts unique Google accounts that have ever
 * granted consent to the project, and removing a user is not assumed to give
 * the slot back. So this counts distinct Google subjects ever registered in an
 * environment rather than currently-active mailboxes: aliases of one account
 * cost one slot, a re-authorization costs nothing, and a revoked mailbox does
 * not refund one.
 */
export async function readGmailPilotBudget(input: {
  readonly databases: readonly OrganisationDatabase[];
  readonly environment: string;
  readonly operatingCap: number;
  readonly submissionTrigger: number;
}): Promise<GmailPilotBudget> {
  const subjects = new Set<string>();
  for (const database of input.databases) {
    const rows = await database
      .prepare(
        "SELECT DISTINCT google_subject AS subject FROM email_mailbox_account WHERE environment = ?",
      )
      .bind(input.environment)
      .all<{ readonly subject: string }>();
    for (const row of rows.results) subjects.add(row.subject);
  }
  const consumed = subjects.size;
  const remaining = Math.max(0, input.operatingCap - consumed);
  return {
    environment: input.environment,
    consumed,
    operatingCap: input.operatingCap,
    submissionTrigger: input.submissionTrigger,
    remaining,
    status:
      consumed >= input.operatingCap
        ? "exhausted"
        : consumed >= input.submissionTrigger
          ? "submit_verification"
          : "healthy",
  };
}

export async function readEmailMailboxIdentityClaimant(input: {
  readonly db: OrganisationDatabase;
  readonly environment: EmailEnvironment;
  readonly googleSubject: string;
}): Promise<{
  readonly organisationId: string;
  readonly integrationAccountId: string;
} | null> {
  return input.db
    .prepare(
      `SELECT integration_account_id AS integrationAccountId, organisation_id AS organisationId
       FROM email_mailbox_account
       WHERE environment = ? AND google_subject = ?`,
    )
    .bind(input.environment, input.googleSubject)
    .first<{
      readonly integrationAccountId: string;
      readonly organisationId: string;
    }>();
}

/**
 * Routes a push hint to the single mailbox observed at this address. The
 * observed address is display data, never authorization: an ambiguous or
 * unknown address drops the hint, and the Connector reconciles against its
 * own credentials before accepting any message fact.
 */
export async function findEmailMailboxByAddress(input: {
  readonly env: OrganisationPlacementBindings;
  readonly observedAddress: string;
}): Promise<{
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
} | null> {
  let match: {
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
  } | null = null;
  for (const database of configuredOrganisationDatabases(input.env)) {
    const rows = await database
      .prepare(
        `SELECT organisation_id AS organisationId, integration_account_id AS integrationAccountId
       FROM email_mailbox_account WHERE observed_address = ?`,
      )
      .bind(input.observedAddress)
      .all<{
        readonly organisationId: unknown;
        readonly integrationAccountId: unknown;
      }>();
    for (const row of rows.results) {
      if (
        typeof row.organisationId !== "string" ||
        typeof row.integrationAccountId !== "string"
      )
        throw new Error("email_mailbox_identity_invalid");
      const organisationId = parseOrganisationId(row.organisationId);
      const accountId = parseIntegrationAccountId(row.integrationAccountId);
      if (!organisationId.ok || !accountId.ok)
        throw new Error("email_mailbox_identity_invalid");
      const scope = await OrganisationExecutionScope.resolve(
        input.env,
        organisationId.value,
      );
      if (!scope.ok) throw new Error(scope.error.code);
      if (scope.value.database !== database) continue;
      if (match !== null) return null;
      match = {
        organisationId: organisationId.value,
        integrationAccountId: accountId.value,
      };
    }
  }
  return match;
}

export async function registerEmailMailboxAccount(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly environment: EmailEnvironment;
  readonly googleSubject: string;
  readonly observedAddress: string;
  readonly now: number;
}): Promise<Result<EmailMailboxAccount, EmailMailboxAccountError>> {
  const claimed = await readEmailMailboxIdentityClaimant(input);
  if (
    claimed !== null &&
    (claimed.organisationId !== input.organisationId ||
      claimed.integrationAccountId !== input.integrationAccountId)
  ) {
    return { ok: false, error: { code: "email_mailbox_identity_claimed" } };
  }
  try {
    await input.db
      .prepare(
        `INSERT INTO email_mailbox_account (
         integration_account_id, organisation_id, environment, google_subject,
         observed_address, address_observed_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (integration_account_id) DO UPDATE SET
         observed_address = excluded.observed_address,
         address_observed_at = excluded.address_observed_at
       WHERE email_mailbox_account.organisation_id = excluded.organisation_id
         AND email_mailbox_account.google_subject = excluded.google_subject`,
      )
      .bind(
        input.integrationAccountId,
        input.organisationId,
        input.environment,
        input.googleSubject,
        input.observedAddress,
        input.now,
      )
      .run();
  } catch {
    return { ok: false, error: { code: "email_mailbox_write_failed" } };
  }
  const stored = await readEmailMailboxAccount(input);
  return stored.ok
    ? stored
    : { ok: false, error: { code: "email_mailbox_write_failed" } };
}

export async function readEmailMailboxAccount(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
}): Promise<Result<EmailMailboxAccount, EmailMailboxAccountError>> {
  const row = await input.db
    .prepare(
      `SELECT integration_account_id AS integrationAccountId, organisation_id AS organisationId,
            environment, google_subject AS googleSubject,
            observed_address AS observedAddress, address_observed_at AS addressObservedAt
       FROM email_mailbox_account
       WHERE organisation_id = ? AND integration_account_id = ?`,
    )
    .bind(input.organisationId, input.integrationAccountId)
    .first<{
      readonly integrationAccountId: string;
      readonly organisationId: string;
      readonly environment: string;
      readonly googleSubject: string;
      readonly observedAddress: string;
      readonly addressObservedAt: number;
    }>();
  if (
    row === null ||
    (row.environment !== "development" && row.environment !== "production")
  ) {
    return { ok: false, error: { code: "email_mailbox_account_missing" } };
  }
  return {
    ok: true,
    value: {
      integrationAccountId: input.integrationAccountId,
      organisationId: input.organisationId,
      environment: row.environment,
      googleSubject: row.googleSubject,
      observedAddress: row.observedAddress,
      addressObservedAt: row.addressObservedAt,
    },
  };
}

export async function assignAgentMailbox(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly mailboxBindingId: string;
  readonly installationId: string;
  readonly grantsDigest: string;
  readonly policyDigest: string;
  readonly createdBy: string;
  readonly now: number;
}): Promise<Result<AgentMailboxBindingRevision, AgentMailboxAssignmentError>> {
  if (
    !SHA256_HEX.test(input.grantsDigest) ||
    !SHA256_HEX.test(input.policyDigest)
  ) {
    return { ok: false, error: { code: "mailbox_binding_write_failed" } };
  }
  const account = await readEmailMailboxAccount(input);
  if (!account.ok)
    return { ok: false, error: { code: "email_mailbox_account_missing" } };
  const installation = await input.db
    .prepare(
      `SELECT 1 AS present FROM agent_installation
       WHERE organisation_id = ? AND installation_id = ? AND lifecycle = 'active'`,
    )
    .bind(input.organisationId, input.installationId)
    .first<{ readonly present: 1 }>();
  if (installation?.present !== 1) {
    return { ok: false, error: { code: "mailbox_installation_inactive" } };
  }
  const existing = await readAgentMailboxBinding(input);
  const revision = existing.ok ? existing.value.binding.currentRevision + 1 : 1;
  const bindingId = existing.ok
    ? existing.value.binding.mailboxBindingId
    : input.mailboxBindingId;
  const statements = existing.ok
    ? [
        input.db
          .prepare(
            `UPDATE agent_mailbox_binding
             SET current_revision = ?, updated_at = ?
             WHERE mailbox_binding_id = ? AND organisation_id = ? AND current_revision = ?`,
          )
          .bind(
            revision,
            input.now,
            bindingId,
            input.organisationId,
            revision - 1,
          ),
      ]
    : [
        input.db
          .prepare(
            `INSERT INTO agent_mailbox_binding (
             mailbox_binding_id, organisation_id, integration_account_id, current_revision,
             created_by_user_id, created_at, updated_at
           ) VALUES (?, ?, ?, 1, ?, ?, ?)`,
          )
          .bind(
            bindingId,
            input.organisationId,
            input.integrationAccountId,
            input.createdBy,
            input.now,
            input.now,
          ),
      ];
  statements.push(
    input.db
      .prepare(
        `INSERT INTO agent_mailbox_binding_revision (
         mailbox_binding_id, revision, organisation_id, installation_id, response_policy,
         grants_digest, policy_digest, created_by_user_id, created_at
       ) VALUES (?, ?, ?, ?, 'cue_routed', ?, ?, ?, ?)`,
      )
      .bind(
        bindingId,
        revision,
        input.organisationId,
        input.installationId,
        input.grantsDigest,
        input.policyDigest,
        input.createdBy,
        input.now,
      ),
  );
  try {
    await input.db.batch(statements);
  } catch {
    return { ok: false, error: { code: "mailbox_binding_write_failed" } };
  }
  return {
    ok: true,
    value: {
      mailboxBindingId: bindingId,
      revision,
      organisationId: input.organisationId,
      installationId: input.installationId,
      responsePolicy: "cue_routed",
      grantsDigest: input.grantsDigest,
      policyDigest: input.policyDigest,
      createdBy: input.createdBy,
      createdAt: input.now,
    },
  };
}

export async function readAgentMailboxBinding(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
}): Promise<
  Result<
    {
      readonly binding: AgentMailboxBinding;
      readonly currentRevision: AgentMailboxBindingRevision;
    },
    { readonly code: "mailbox_binding_missing" }
  >
> {
  const row = await input.db
    .prepare(
      `SELECT binding.mailbox_binding_id AS mailboxBindingId,
            binding.current_revision AS currentRevision,
            binding.created_by_user_id AS createdBy,
            binding.created_at AS createdAt,
            binding.updated_at AS updatedAt,
            revision.installation_id AS installationId,
            revision.grants_digest AS grantsDigest,
            revision.policy_digest AS policyDigest,
            revision.created_by_user_id AS revisionCreatedBy,
            revision.created_at AS revisionCreatedAt
       FROM agent_mailbox_binding AS binding
       JOIN agent_mailbox_binding_revision AS revision
         ON revision.mailbox_binding_id = binding.mailbox_binding_id
        AND revision.revision = binding.current_revision
       WHERE binding.organisation_id = ? AND binding.integration_account_id = ?`,
    )
    .bind(input.organisationId, input.integrationAccountId)
    .first<{
      readonly mailboxBindingId: string;
      readonly currentRevision: number;
      readonly createdBy: string;
      readonly createdAt: number;
      readonly updatedAt: number;
      readonly installationId: string;
      readonly grantsDigest: string;
      readonly policyDigest: string;
      readonly revisionCreatedBy: string;
      readonly revisionCreatedAt: number;
    }>();
  if (row === null)
    return { ok: false, error: { code: "mailbox_binding_missing" } };
  return {
    ok: true,
    value: {
      binding: {
        mailboxBindingId: row.mailboxBindingId,
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        currentRevision: row.currentRevision,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      currentRevision: {
        mailboxBindingId: row.mailboxBindingId,
        revision: row.currentRevision,
        organisationId: input.organisationId,
        installationId: row.installationId,
        responsePolicy: "cue_routed",
        grantsDigest: row.grantsDigest,
        policyDigest: row.policyDigest,
        createdBy: row.revisionCreatedBy,
        createdAt: row.revisionCreatedAt,
      },
    },
  };
}

export async function readMailboxIngressPolicy(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly connectedAt: number;
}): Promise<MailboxIngressPolicy> {
  const row = await input.db
    .prepare(
      `SELECT revision.policy_version AS policyVersion, revision.kind AS kind,
            revision.max_active_cases AS maxActiveCases,
            revision.max_messages_per_hour AS maxMessagesPerHour,
            revision.daily_token_budget AS dailyTokenBudget,
            revision.max_message_bytes AS maxMessageBytes,
            revision.max_attachment_bytes AS maxAttachmentBytes,
            revision.published_by_user_id AS publishedBy,
            revision.published_at AS publishedAt
       FROM mailbox_ingress_policy AS head
       JOIN mailbox_ingress_policy_revision AS revision
         ON revision.integration_account_id = head.integration_account_id
        AND revision.policy_version = head.current_version
       WHERE head.organisation_id = ? AND head.integration_account_id = ?`,
    )
    .bind(input.organisationId, input.integrationAccountId)
    .first<{
      readonly policyVersion: number;
      readonly kind: string;
      readonly maxActiveCases: number | null;
      readonly maxMessagesPerHour: number | null;
      readonly dailyTokenBudget: number | null;
      readonly maxMessageBytes: number | null;
      readonly maxAttachmentBytes: number | null;
      readonly publishedBy: string;
      readonly publishedAt: number;
    }>();
  if (row === null) {
    return { kind: "disabled_by_default", connectedAt: input.connectedAt };
  }
  if (
    row.kind === "enabled" &&
    row.maxActiveCases !== null &&
    row.maxMessagesPerHour !== null &&
    row.dailyTokenBudget !== null &&
    row.maxMessageBytes !== null &&
    row.maxAttachmentBytes !== null
  ) {
    return {
      kind: "enabled",
      policyVersion: row.policyVersion,
      maxActiveCases: row.maxActiveCases,
      maxMessagesPerHour: row.maxMessagesPerHour,
      dailyTokenBudget: row.dailyTokenBudget,
      maxMessageBytes: row.maxMessageBytes,
      maxAttachmentBytes: row.maxAttachmentBytes,
      debounce: {
        kind: "push_triggered",
        coalesceSeconds: EMAIL_CUE_COALESCE_SECONDS,
      },
      overflow: "pause_and_notify",
      publishedBy: row.publishedBy,
      publishedAt: row.publishedAt,
    };
  }
  return {
    kind: "disabled_by_operator",
    policyVersion: row.policyVersion,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt,
  };
}

export async function publishMailboxIngressPolicy(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly environment: EmailEnvironment;
  readonly request: MailboxIngressPolicyPublishRequest;
  readonly publishedBy: string;
  readonly now: number;
}): Promise<Result<MailboxIngressPolicy, MailboxPolicyPublishError>> {
  const account = await readEmailMailboxAccount(input);
  if (!account.ok)
    return { ok: false, error: { code: "email_mailbox_account_missing" } };
  const head = await input.db
    .prepare(
      `SELECT current_version AS currentVersion FROM mailbox_ingress_policy
       WHERE organisation_id = ? AND integration_account_id = ?`,
    )
    .bind(input.organisationId, input.integrationAccountId)
    .first<{ readonly currentVersion: number }>();
  const currentVersion = head?.currentVersion ?? 0;
  const nextVersion = currentVersion + 1;
  const enabled = input.request.kind === "enabled" ? input.request : null;
  const statements = [
    input.db
      .prepare(
        `INSERT INTO mailbox_ingress_policy_revision (
         integration_account_id, policy_version, organisation_id, environment, kind,
         max_active_cases, max_messages_per_hour, daily_token_budget,
         max_message_bytes, max_attachment_bytes,
         published_by_user_id, published_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.integrationAccountId,
        nextVersion,
        input.organisationId,
        input.environment,
        input.request.kind,
        enabled?.maxActiveCases ?? null,
        enabled?.maxMessagesPerHour ?? null,
        enabled?.dailyTokenBudget ?? null,
        enabled?.maxMessageBytes ?? null,
        enabled?.maxAttachmentBytes ?? null,
        input.publishedBy,
        input.now,
      ),
    currentVersion === 0
      ? input.db
          .prepare(
            `INSERT INTO mailbox_ingress_policy (
             integration_account_id, organisation_id, environment, current_version, updated_at
           ) VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(
            input.integrationAccountId,
            input.organisationId,
            input.environment,
            nextVersion,
            input.now,
          )
      : input.db
          .prepare(
            `UPDATE mailbox_ingress_policy
             SET current_version = ?, updated_at = ?
             WHERE organisation_id = ? AND integration_account_id = ? AND current_version = ?`,
          )
          .bind(
            nextVersion,
            input.now,
            input.organisationId,
            input.integrationAccountId,
            currentVersion,
          ),
  ];
  try {
    await input.db.batch(statements);
  } catch {
    return { ok: false, error: { code: "mailbox_policy_publish_conflict" } };
  }
  return {
    ok: true,
    value:
      input.request.kind === "enabled"
        ? {
            kind: "enabled",
            policyVersion: nextVersion,
            maxActiveCases: input.request.maxActiveCases,
            maxMessagesPerHour: input.request.maxMessagesPerHour,
            dailyTokenBudget: input.request.dailyTokenBudget,
            maxMessageBytes: input.request.maxMessageBytes,
            maxAttachmentBytes: input.request.maxAttachmentBytes,
            debounce: {
              kind: "push_triggered",
              coalesceSeconds: EMAIL_CUE_COALESCE_SECONDS,
            },
            overflow: "pause_and_notify",
            publishedBy: input.publishedBy,
            publishedAt: input.now,
          }
        : {
            kind: "disabled_by_operator",
            policyVersion: nextVersion,
            publishedBy: input.publishedBy,
            publishedAt: input.now,
          },
  };
}

/**
 * The limits that a mailbox turns on with. The Portal sends none, so every
 * mailbox that a person turns on gets these. Processing pauses at a limit
 * until a person resumes it.
 */
const DEFAULT_MAILBOX_LIMITS = {
  maxActiveCases: 3,
  maxMessagesPerHour: 20,
  dailyTokenBudget: 1_000_000,
  maxMessageBytes: 262_144,
  maxAttachmentBytes: 5_242_880,
} as const;

/**
 * An enabled policy with no limits takes `DEFAULT_MAILBOX_LIMITS`. A request
 * that names limits names all five, with the fixed debounce and overflow.
 */
export function parseMailboxIngressPolicyPublishRequest(
  raw: unknown,
): Result<MailboxIngressPolicyPublishRequest, EmailFieldError> {
  if (!isRecord(raw)) return invalid("policy");
  if (raw.kind === "disabled_by_operator") {
    return hasOnlyKeys(raw, ["kind"])
      ? { ok: true, value: { kind: "disabled_by_operator" } }
      : invalid("policy");
  }
  if (raw.kind !== "enabled") return invalid("policy.kind");
  if (hasOnlyKeys(raw, ["kind"])) {
    return {
      ok: true,
      value: {
        kind: "enabled",
        ...DEFAULT_MAILBOX_LIMITS,
        debounce: {
          kind: "push_triggered",
          coalesceSeconds: EMAIL_CUE_COALESCE_SECONDS,
        },
        overflow: "pause_and_notify",
      },
    };
  }
  if (
    !hasOnlyKeys(raw, [
      "kind",
      "maxActiveCases",
      "maxMessagesPerHour",
      "dailyTokenBudget",
      "maxMessageBytes",
      "maxAttachmentBytes",
      "debounce",
      "overflow",
    ])
  ) {
    return invalid("policy");
  }
  const maxActiveCases = positiveIntegerOrNull(raw.maxActiveCases);
  const maxMessagesPerHour = positiveIntegerOrNull(raw.maxMessagesPerHour);
  const dailyTokenBudget = positiveIntegerOrNull(raw.dailyTokenBudget);
  const maxMessageBytes = positiveIntegerOrNull(raw.maxMessageBytes);
  const maxAttachmentBytes = positiveIntegerOrNull(raw.maxAttachmentBytes);
  if (maxActiveCases === null) return invalid("policy.maxActiveCases");
  if (maxMessagesPerHour === null) return invalid("policy.maxMessagesPerHour");
  if (dailyTokenBudget === null) return invalid("policy.dailyTokenBudget");
  if (maxMessageBytes === null) return invalid("policy.maxMessageBytes");
  if (maxAttachmentBytes === null) return invalid("policy.maxAttachmentBytes");
  if (
    !isRecord(raw.debounce) ||
    !hasOnlyKeys(raw.debounce, ["kind", "coalesceSeconds"]) ||
    raw.debounce.kind !== "push_triggered" ||
    raw.debounce.coalesceSeconds !== EMAIL_CUE_COALESCE_SECONDS
  ) {
    return invalid("policy.debounce");
  }
  if (raw.overflow !== "pause_and_notify") return invalid("policy.overflow");
  return {
    ok: true,
    value: {
      kind: "enabled",
      maxActiveCases,
      maxMessagesPerHour,
      dailyTokenBudget,
      maxMessageBytes,
      maxAttachmentBytes,
      debounce: {
        kind: "push_triggered",
        coalesceSeconds: EMAIL_CUE_COALESCE_SECONDS,
      },
      overflow: "pause_and_notify",
    },
  };
}

export function parseMailboxProcessingPauseReason(
  raw: unknown,
): Result<MailboxProcessingPauseReason, EmailFieldError> {
  if (!isRecord(raw)) return invalid("pauseReason");
  switch (raw.kind) {
    case "active_case_limit": {
      const observed = nonNegativeIntegerOrNull(raw.observed);
      const limit = positiveIntegerOrNull(raw.limit);
      return hasOnlyKeys(raw, ["kind", "observed", "limit"]) &&
        observed !== null &&
        limit !== null
        ? { ok: true, value: { kind: raw.kind, observed, limit } }
        : invalid("pauseReason");
    }
    case "hourly_message_limit": {
      const observed = nonNegativeIntegerOrNull(raw.observed);
      const limit = positiveIntegerOrNull(raw.limit);
      const windowEndsAt = nonNegativeIntegerOrNull(raw.windowEndsAt);
      return hasOnlyKeys(raw, ["kind", "observed", "limit", "windowEndsAt"]) &&
        observed !== null &&
        limit !== null &&
        windowEndsAt !== null
        ? { ok: true, value: { kind: raw.kind, observed, limit, windowEndsAt } }
        : invalid("pauseReason");
    }
    case "daily_token_budget": {
      const reserved = nonNegativeIntegerOrNull(raw.reserved);
      const consumed = nonNegativeIntegerOrNull(raw.consumed);
      const limit = positiveIntegerOrNull(raw.limit);
      const windowEndsAt = nonNegativeIntegerOrNull(raw.windowEndsAt);
      return hasOnlyKeys(raw, [
        "kind",
        "reserved",
        "consumed",
        "limit",
        "windowEndsAt",
      ]) &&
        reserved !== null &&
        consumed !== null &&
        limit !== null &&
        windowEndsAt !== null
        ? {
            ok: true,
            value: { kind: raw.kind, reserved, consumed, limit, windowEndsAt },
          }
        : invalid("pauseReason");
    }
    case "message_too_large": {
      const observedBytes = positiveIntegerOrNull(raw.observedBytes);
      const limitBytes = positiveIntegerOrNull(raw.limitBytes);
      return hasOnlyKeys(raw, [
        "kind",
        "providerMessageId",
        "observedBytes",
        "limitBytes",
      ]) &&
        isNonBlankString(raw.providerMessageId) &&
        observedBytes !== null &&
        limitBytes !== null
        ? {
            ok: true,
            value: {
              kind: raw.kind,
              providerMessageId: raw.providerMessageId,
              observedBytes,
              limitBytes,
            },
          }
        : invalid("pauseReason");
    }
    case "attachment_too_large": {
      const observedBytes = positiveIntegerOrNull(raw.observedBytes);
      const limitBytes = positiveIntegerOrNull(raw.limitBytes);
      return hasOnlyKeys(raw, [
        "kind",
        "providerMessageId",
        "providerAttachmentId",
        "observedBytes",
        "limitBytes",
      ]) &&
        isNonBlankString(raw.providerMessageId) &&
        isNonBlankString(raw.providerAttachmentId) &&
        observedBytes !== null &&
        limitBytes !== null
        ? {
            ok: true,
            value: {
              kind: raw.kind,
              providerMessageId: raw.providerMessageId,
              providerAttachmentId: raw.providerAttachmentId,
              observedBytes,
              limitBytes,
            },
          }
        : invalid("pauseReason");
    }
    case "authorization_expired": {
      const observedAt = nonNegativeIntegerOrNull(raw.observedAt);
      return hasOnlyKeys(raw, ["kind", "reasonCode", "observedAt"]) &&
        isNonBlankString(raw.reasonCode) &&
        observedAt !== null
        ? {
            ok: true,
            value: { kind: raw.kind, reasonCode: raw.reasonCode, observedAt },
          }
        : invalid("pauseReason");
    }
    case "attachment_total_too_large": {
      const observedBytes = positiveIntegerOrNull(raw.observedBytes);
      const limitBytes = positiveIntegerOrNull(raw.limitBytes);
      return hasOnlyKeys(raw, [
        "kind",
        "providerMessageId",
        "observedBytes",
        "limitBytes",
      ]) &&
        isNonBlankString(raw.providerMessageId) &&
        observedBytes !== null &&
        limitBytes !== null
        ? {
            ok: true,
            value: {
              kind: raw.kind,
              providerMessageId: raw.providerMessageId,
              observedBytes,
              limitBytes,
            },
          }
        : invalid("pauseReason");
    }
    default:
      return invalid("pauseReason.kind");
  }
}

export function parseEmailReplyProposalLifecycle(
  raw: unknown,
): Result<EmailReplyProposalLifecycle, EmailFieldError> {
  if (!isRecord(raw)) return invalid("proposalLifecycle");
  switch (raw.kind) {
    case "draft_creation_indeterminate":
    case "awaiting_approval":
    case "proposal_missing":
      return hasOnlyKeys(raw, ["kind"])
        ? { ok: true, value: { kind: raw.kind } }
        : invalid("proposalLifecycle");
    case "approved": {
      const approvedAt = nonNegativeIntegerOrNull(raw.approvedAt);
      return hasOnlyKeys(raw, [
        "kind",
        "approvedBy",
        "approvedAt",
        "approvedSnapshotDigest",
      ]) &&
        isNonBlankString(raw.approvedBy) &&
        approvedAt !== null &&
        typeof raw.approvedSnapshotDigest === "string" &&
        SHA256_HEX.test(raw.approvedSnapshotDigest)
        ? {
            ok: true,
            value: {
              kind: raw.kind,
              approvedBy: raw.approvedBy,
              approvedAt,
              approvedSnapshotDigest: raw.approvedSnapshotDigest,
            },
          }
        : invalid("proposalLifecycle");
    }
    case "sent": {
      const sentAt = nonNegativeIntegerOrNull(raw.sentAt);
      return hasOnlyKeys(raw, ["kind", "providerMessageId", "sentAt"]) &&
        isNonBlankString(raw.providerMessageId) &&
        sentAt !== null
        ? {
            ok: true,
            value: {
              kind: raw.kind,
              providerMessageId: raw.providerMessageId,
              sentAt,
            },
          }
        : invalid("proposalLifecycle");
    }
    case "send_indeterminate":
      return hasOnlyKeys(raw, ["kind", "rfcMessageId"]) &&
        isNonBlankString(raw.rfcMessageId)
        ? {
            ok: true,
            value: { kind: raw.kind, rfcMessageId: raw.rfcMessageId },
          }
        : invalid("proposalLifecycle");
    case "operator_attested_present":
    case "operator_attested_absent": {
      const attestedAt = nonNegativeIntegerOrNull(raw.attestedAt);
      return hasOnlyKeys(raw, ["kind", "attestedBy", "attestedAt"]) &&
        isNonBlankString(raw.attestedBy) &&
        attestedAt !== null
        ? {
            ok: true,
            value: {
              kind: raw.kind,
              attestedBy: raw.attestedBy,
              attestedAt,
            },
          }
        : invalid("proposalLifecycle");
    }
    case "invalidated": {
      const disposal = parseEmailProposalDisposal(raw.disposal);
      return hasOnlyKeys(raw, ["kind", "reason", "disposal"]) &&
        (raw.reason === "target_changed" ||
          raw.reason === "unsupported_content") &&
        disposal !== null
        ? { ok: true, value: { kind: raw.kind, reason: raw.reason, disposal } }
        : invalid("proposalLifecycle");
    }
    case "rejected": {
      const rejectedAt = nonNegativeIntegerOrNull(raw.rejectedAt);
      const disposal = parseEmailProposalDisposal(raw.disposal);
      return hasOnlyKeys(raw, [
        "kind",
        "rejectedBy",
        "rejectedAt",
        "disposal",
      ]) &&
        isNonBlankString(raw.rejectedBy) &&
        rejectedAt !== null &&
        disposal !== null
        ? {
            ok: true,
            value: {
              kind: raw.kind,
              rejectedBy: raw.rejectedBy,
              rejectedAt,
              disposal,
            },
          }
        : invalid("proposalLifecycle");
    }
    case "expired": {
      const expiredAt = nonNegativeIntegerOrNull(raw.expiredAt);
      const disposal = parseEmailProposalDisposal(raw.disposal);
      return hasOnlyKeys(raw, ["kind", "expiredAt", "disposal"]) &&
        expiredAt !== null &&
        disposal !== null
        ? { ok: true, value: { kind: raw.kind, expiredAt, disposal } }
        : invalid("proposalLifecycle");
    }
    case "superseded": {
      const supersededByVersion = positiveIntegerOrNull(
        raw.supersededByVersion,
      );
      const disposal = parseEmailProposalDisposal(raw.disposal);
      return hasOnlyKeys(raw, ["kind", "supersededByVersion", "disposal"]) &&
        supersededByVersion !== null &&
        disposal !== null
        ? { ok: true, value: { kind: raw.kind, supersededByVersion, disposal } }
        : invalid("proposalLifecycle");
    }
    case "revoked": {
      const revokedAt = nonNegativeIntegerOrNull(raw.revokedAt);
      const disposal = parseEmailProposalDisposal(raw.disposal);
      return hasOnlyKeys(raw, ["kind", "revokedAt", "disposal"]) &&
        revokedAt !== null &&
        disposal !== null
        ? { ok: true, value: { kind: raw.kind, revokedAt, disposal } }
        : invalid("proposalLifecycle");
    }
    default:
      return invalid("proposalLifecycle.kind");
  }
}

function parseEmailProposalDisposal(
  raw: unknown,
): EmailProposalDisposal | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "cleanup_pending":
      return hasOnlyKeys(raw, ["kind"]) ? { kind: raw.kind } : null;
    case "cleaned": {
      const deletedAt = nonNegativeIntegerOrNull(raw.deletedAt);
      return hasOnlyKeys(raw, ["kind", "deletedAt"]) && deletedAt !== null
        ? { kind: raw.kind, deletedAt }
        : null;
    }
    case "cleanup_unreachable":
      return hasOnlyKeys(raw, ["kind", "reason"]) &&
        isNonBlankString(raw.reason)
        ? { kind: raw.kind, reason: raw.reason }
        : null;
    default:
      return null;
  }
}

export async function recordEmailThreadCase(input: {
  readonly scope: OrganisationExecutionScope;
  readonly integrationAccountId: IntegrationAccountId;
  readonly gmailThreadId: string;
  readonly caseId: CaseId;
  readonly mailboxBindingId: string;
  readonly bindingRevision: number;
  readonly now: number;
}): Promise<
  Result<
    CaseId,
    {
      readonly code:
        "email_thread_case_write_failed" | "organisation_placement_conflict";
    }
  >
> {
  try {
    await input.scope.database
      .prepare(
        `INSERT INTO email_thread_case (
         organisation_id, integration_account_id, gmail_thread_id, case_id,
         mailbox_binding_id, binding_revision, created_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
         AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')
       ON CONFLICT (integration_account_id, gmail_thread_id) DO NOTHING`,
      )
      .bind(
        input.scope.organisationId,
        input.integrationAccountId,
        input.gmailThreadId,
        input.caseId,
        input.mailboxBindingId,
        input.bindingRevision,
        input.now,
        input.scope.organisationId,
        input.scope.placement.placementEpoch,
        input.scope.placement.placementCellId,
        input.scope.fenceToken,
      )
      .run();
  } catch {
    return { ok: false, error: { code: "email_thread_case_write_failed" } };
  }
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  const stored = await readEmailThreadCase({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
    gmailThreadId: input.gmailThreadId,
  });
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  return stored === null
    ? { ok: false, error: { code: "email_thread_case_write_failed" } }
    : { ok: true, value: stored };
}

export async function readEmailThreadCase(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly gmailThreadId: string;
}): Promise<CaseId | null> {
  const row = await input.db
    .prepare(
      `SELECT case_id AS caseId FROM email_thread_case
       WHERE organisation_id = ? AND integration_account_id = ? AND gmail_thread_id = ?`,
    )
    .bind(input.organisationId, input.integrationAccountId, input.gmailThreadId)
    .first<{ readonly caseId: string }>();
  if (row === null) return null;
  const parsed = parseCaseId(row.caseId);
  return parsed.ok ? parsed.value : null;
}

export type EmailReplyProposalProjection = {
  readonly proposalId: string;
  readonly organisationId: string;
  readonly integrationAccountId: string;
  readonly caseId: string;
  readonly gmailThreadId: string;
  readonly currentVersion: number;
  readonly lifecycleKind: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/**
 * Copies one move of a reply proposal to the Portal queue. The row moves only
 * forward: a later version replaces a version that it may supersede, and a
 * move of the same version must be one that the proposal machine allows. A
 * repeat changes nothing. The write is a compare-and-set on the row that this
 * call read; a lost race reads the row again and decides again.
 */
export async function projectEmailReplyProposal(input: {
  readonly scope: OrganisationExecutionScope;
  readonly integrationAccountId: IntegrationAccountId;
  readonly proposalId: string;
  readonly caseId: string;
  readonly gmailThreadId: string;
  readonly currentVersion: number;
  readonly lifecycleKind: EmailReplyProposalKind;
  readonly now: number;
}): Promise<
  Result<
    null,
    {
      readonly code:
        | "email_reply_projection_write_failed"
        | "email_reply_projection_refused"
        | "organisation_placement_conflict";
    }
  >
> {
  const placement = `EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
         AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')`;
  const placementValues = [
    input.scope.organisationId,
    input.scope.placement.placementEpoch,
    input.scope.placement.placementCellId,
    input.scope.fenceToken,
  ];
  try {
    let settled = false;
    for (let attempt = 0; attempt < 3 && !settled; attempt++) {
      const stored = await input.scope.database
        .prepare(
          `SELECT current_version AS version, lifecycle_kind AS kind
           FROM email_reply_proposal WHERE proposal_id = ? AND organisation_id = ?`,
        )
        .bind(input.proposalId, input.scope.organisationId)
        .first<{ readonly version: number; readonly kind: string }>();
      const written =
        stored === null
          ? await input.scope.database
              .prepare(
                `INSERT INTO email_reply_proposal (
                 proposal_id, organisation_id, integration_account_id, case_id, gmail_thread_id,
                 current_version, lifecycle_kind, created_at, updated_at
               ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${placement}
               ON CONFLICT (proposal_id) DO NOTHING`,
              )
              .bind(
                input.proposalId,
                input.scope.organisationId,
                input.integrationAccountId,
                input.caseId,
                input.gmailThreadId,
                input.currentVersion,
                input.lifecycleKind,
                input.now,
                input.now,
                ...placementValues,
              )
              .run()
          : null;
      if (stored !== null) {
        const move = projectedMove(stored, input);
        if (move === "refused")
          return {
            ok: false,
            error: { code: "email_reply_projection_refused" },
          };
        settled = move === "repeat";
        if (settled) break;
        const updated = await input.scope.database
          .prepare(
            `UPDATE email_reply_proposal
             SET current_version = ?, lifecycle_kind = ?, updated_at = max(updated_at, ?)
             WHERE proposal_id = ? AND organisation_id = ? AND current_version = ?
               AND lifecycle_kind = ? AND ${placement}`,
          )
          .bind(
            input.currentVersion,
            input.lifecycleKind,
            input.now,
            input.proposalId,
            input.scope.organisationId,
            stored.version,
            stored.kind,
            ...placementValues,
          )
          .run();
        settled = updated.meta.changes === 1;
        if (settled) break;
      } else if (written !== null && written.meta.changes === 1) {
        settled = true;
        break;
      }
      if (!(await input.scope.isActive()))
        return {
          ok: false,
          error: { code: "organisation_placement_conflict" },
        };
    }
    if (!(await input.scope.isActive()))
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    return settled
      ? { ok: true, value: null }
      : { ok: false, error: { code: "email_reply_projection_write_failed" } };
  } catch {
    return {
      ok: false,
      error: { code: "email_reply_projection_write_failed" },
    };
  }
}

/** How the queue row may follow a move: by the version, then by the machine. */
function projectedMove(
  stored: Readonly<{ version: number; kind: string }>,
  next: Readonly<{
    currentVersion: number;
    lifecycleKind: EmailReplyProposalKind;
  }>,
): "move" | "repeat" | "refused" {
  if (!isEmailReplyProposalKind(stored.kind)) return "refused";
  if (next.currentVersion < stored.version) return "refused";
  if (next.currentVersion > stored.version)
    return emailReplyProposalSupersedes(stored.kind) ? "move" : "refused";
  if (stored.kind === next.lifecycleKind) return "repeat";
  const move = emailReplyProposalTransition(stored.kind, next.lifecycleKind);
  return move.kind === "moved" ? "move" : "refused";
}

export async function readEmailReplyProposalProjection(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly proposalId: string;
}): Promise<EmailReplyProposalProjection | null> {
  return input.db
    .prepare(
      `SELECT proposal_id AS proposalId, organisation_id AS organisationId,
            integration_account_id AS integrationAccountId, case_id AS caseId,
            gmail_thread_id AS gmailThreadId, current_version AS currentVersion,
            lifecycle_kind AS lifecycleKind, created_at AS createdAt, updated_at AS updatedAt
       FROM email_reply_proposal WHERE organisation_id = ? AND proposal_id = ?`,
    )
    .bind(input.organisationId, input.proposalId)
    .first<EmailReplyProposalProjection>();
}

/**
 * The organisation's reply queue. Open proposals are the ones an approver can still
 * act on; settled ones are listed only so the recent outcome stays visible.
 */
export async function listEmailReplyProposalProjections(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly limit: number;
}): Promise<readonly EmailReplyProposalProjection[]> {
  const rows = await input.db
    .prepare(
      `SELECT proposal_id AS proposalId, organisation_id AS organisationId,
            integration_account_id AS integrationAccountId, case_id AS caseId,
            gmail_thread_id AS gmailThreadId, current_version AS currentVersion,
            lifecycle_kind AS lifecycleKind, created_at AS createdAt, updated_at AS updatedAt
       FROM email_reply_proposal WHERE organisation_id = ?
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .bind(input.organisationId, input.limit)
    .all<EmailReplyProposalProjection>();
  return rows.results;
}

export async function listEmailReplyProposalProjectionsForCase(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly caseId: CaseId;
  readonly limit: number;
}): Promise<readonly EmailReplyProposalProjection[]> {
  const rows = await input.db
    .prepare(
      `SELECT proposal_id AS proposalId, organisation_id AS organisationId,
            integration_account_id AS integrationAccountId, case_id AS caseId,
            gmail_thread_id AS gmailThreadId, current_version AS currentVersion,
            lifecycle_kind AS lifecycleKind, created_at AS createdAt, updated_at AS updatedAt
       FROM email_reply_proposal
       WHERE organisation_id = ? AND case_id = ?
       ORDER BY updated_at DESC, proposal_id ASC
       LIMIT ?`,
    )
    .bind(input.organisationId, input.caseId, input.limit)
    .all<EmailReplyProposalProjection>();
  return rows.results;
}

export async function readLatestEmailReplyProposalProjectionForCase(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly caseId: CaseId;
}): Promise<EmailReplyProposalProjection | null> {
  return input.db
    .prepare(
      `SELECT proposal_id AS proposalId, organisation_id AS organisationId,
            integration_account_id AS integrationAccountId, case_id AS caseId,
            gmail_thread_id AS gmailThreadId, current_version AS currentVersion,
            lifecycle_kind AS lifecycleKind, created_at AS createdAt, updated_at AS updatedAt
       FROM email_reply_proposal
       WHERE organisation_id = ? AND case_id = ?
       ORDER BY updated_at DESC, proposal_id ASC
       LIMIT 1`,
    )
    .bind(input.organisationId, input.caseId)
    .first<EmailReplyProposalProjection>();
}

export async function recordEmailMessageReceipt(input: {
  readonly scope: OrganisationExecutionScope;
  readonly integrationAccountId: IntegrationAccountId;
  readonly providerMessageId: string;
  readonly gmailThreadId: string;
  readonly caseId: CaseId;
  readonly policyVersion: number;
  readonly now: number;
}): Promise<
  Result<
    null,
    {
      readonly code:
        | "email_message_receipt_write_failed"
        | "organisation_placement_conflict";
    }
  >
> {
  try {
    await input.scope.database
      .prepare(
        `INSERT INTO email_message_receipt (
         organisation_id, integration_account_id, provider_message_id, gmail_thread_id,
         case_id, policy_version, admitted_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
         AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')
       ON CONFLICT (integration_account_id, provider_message_id) DO NOTHING`,
      )
      .bind(
        input.scope.organisationId,
        input.integrationAccountId,
        input.providerMessageId,
        input.gmailThreadId,
        input.caseId,
        input.policyVersion,
        input.now,
        input.scope.organisationId,
        input.scope.placement.placementEpoch,
        input.scope.placement.placementCellId,
        input.scope.fenceToken,
      )
      .run();
    if (!(await input.scope.isActive()))
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    return { ok: true, value: null };
  } catch {
    return { ok: false, error: { code: "email_message_receipt_write_failed" } };
  }
}

/**
 * The verified contact one admitted message is bound to, or null when the
 * message has no receipt in this Case or its receipt names no contact.
 */
export async function readEmailMessageReceiptContact(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    providerMessageId: string;
    caseId: CaseId;
  }>,
): Promise<Readonly<{
  verificationId: string;
  verificationRevision: number;
}> | null> {
  const row = await input.db
    .prepare(
      `SELECT contact_verification_id AS verificationId,
              contact_verification_revision AS verificationRevision
       FROM email_message_receipt
       WHERE organisation_id = ?
         AND integration_account_id = ?
         AND provider_message_id = ?
         AND case_id = ?`,
    )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      input.providerMessageId,
      input.caseId,
    )
    .first<{
      readonly verificationId: unknown;
      readonly verificationRevision: unknown;
    }>();
  return typeof row?.verificationId === "string" &&
    typeof row.verificationRevision === "number" &&
    Number.isSafeInteger(row.verificationRevision) &&
    row.verificationRevision > 0
    ? {
        verificationId: row.verificationId,
        verificationRevision: row.verificationRevision,
      }
    : null;
}

export async function emailMessageReceiptMatches(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    providerMessageId: string;
    caseId: CaseId;
    admittedAt: number;
    verificationId: string;
    verificationRevision: number;
  }>,
): Promise<boolean> {
  const row = await input.db
    .prepare(
      `SELECT 1 AS matched
       FROM email_message_receipt
       WHERE organisation_id = ?
         AND integration_account_id = ?
         AND provider_message_id = ?
         AND case_id = ?
         AND admitted_at = ?
         AND contact_verification_id = ?
         AND contact_verification_revision = ?`,
    )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      input.providerMessageId,
      input.caseId,
      input.admittedAt,
      input.verificationId,
      input.verificationRevision,
    )
    .first<{ readonly matched: number }>();
  return row?.matched === 1;
}

/**
 * Binds a message's receipt to its sender's verified contact as the message
 * is admitted. Only the verification's identity and revision are stored; the
 * address that matched it is not.
 */
export async function bindAdmittedEmailMessageSender(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    integrationAccountId: IntegrationAccountId;
    providerMessageId: string;
    caseId: CaseId;
    verificationId: string;
    verificationRevision: number;
  }>,
): Promise<
  Result<
    null,
    {
      readonly code:
        | "email_message_receipt_binding_failed"
        | "organisation_placement_conflict";
    }
  >
> {
  try {
    await input.scope.database
      .prepare(
        `UPDATE email_message_receipt
         SET contact_verification_id = ?, contact_verification_revision = ?
         WHERE organisation_id = ?
           AND integration_account_id = ?
           AND provider_message_id = ?
           AND case_id = ?
           AND EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
             AND placement_epoch = ? AND placement_cell_id = ?
             AND fence_token = ? AND status = 'active')`,
      )
      .bind(
        input.verificationId,
        input.verificationRevision,
        input.scope.organisationId,
        input.integrationAccountId,
        input.providerMessageId,
        input.caseId,
        input.scope.organisationId,
        input.scope.placement.placementEpoch,
        input.scope.placement.placementCellId,
        input.scope.fenceToken,
      )
      .run();
    if (!(await input.scope.isActive()))
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    const bound = await readEmailMessageReceiptContact({
      db: input.scope.database,
      organisationId: input.scope.organisationId,
      integrationAccountId: input.integrationAccountId,
      providerMessageId: input.providerMessageId,
      caseId: input.caseId,
    });
    return bound?.verificationId === input.verificationId &&
      bound.verificationRevision === input.verificationRevision
      ? { ok: true, value: null }
      : { ok: false, error: { code: "email_message_receipt_binding_failed" } };
  } catch {
    return {
      ok: false,
      error: { code: "email_message_receipt_binding_failed" },
    };
  }
}

export async function bindEmailMessageReceiptContact(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    integrationAccountId: IntegrationAccountId;
    providerMessageId: string;
    caseId: CaseId;
    admittedAt: number;
    verificationId: string;
    verificationRevision: number;
  }>,
): Promise<
  Result<
    null,
    {
      readonly code:
        | "email_message_receipt_binding_failed"
        | "organisation_placement_conflict";
    }
  >
> {
  try {
    await input.scope.database
      .prepare(
        `UPDATE email_message_receipt
         SET contact_verification_id = ?, contact_verification_revision = ?
         WHERE organisation_id = ?
           AND integration_account_id = ?
           AND provider_message_id = ?
           AND case_id = ?
           AND admitted_at = ?
           AND EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
             AND placement_epoch = ? AND placement_cell_id = ?
             AND fence_token = ? AND status = 'active')`,
      )
      .bind(
        input.verificationId,
        input.verificationRevision,
        input.scope.organisationId,
        input.integrationAccountId,
        input.providerMessageId,
        input.caseId,
        input.admittedAt,
        input.scope.organisationId,
        input.scope.placement.placementEpoch,
        input.scope.placement.placementCellId,
        input.scope.fenceToken,
      )
      .run();
    if (!(await input.scope.isActive()))
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    if (
      await emailMessageReceiptMatches({
        db: input.scope.database,
        organisationId: input.scope.organisationId,
        integrationAccountId: input.integrationAccountId,
        providerMessageId: input.providerMessageId,
        caseId: input.caseId,
        admittedAt: input.admittedAt,
        verificationId: input.verificationId,
        verificationRevision: input.verificationRevision,
      })
    ) {
      return { ok: true, value: null };
    }
  } catch {
    // The source receipt remains unbound and therefore unusable by CaseContextCollections.
  }
  return {
    ok: false,
    error: { code: "email_message_receipt_binding_failed" },
  };
}

function invalid(field: string): Result<never, EmailFieldError> {
  return { ok: false, error: { code: "invalid_field", field } };
}
