import type { InboxSubjectReads } from "@purin-labs/authority/access-control/subject-reads";
import type { InboxAutomationRecords } from "@purin-labs/tenancy/organisation-access/automation-records";
import { isPositiveInteger } from "@purin-labs/std";

// The reads of the Inbox records that an access decision of the authority
// module makes (Refactor 17). The Worker registers them
// (`worker-ports.ts`). Each function is one D1 read and writes nothing. The
// subject sources are SQL parts of the one subject list read of authority.

type PresentRow = { readonly present: 1 };

export const INBOX_SUBJECT_READS: InboxSubjectReads = {
  subjectSources: [
    {
      reference: `SELECT 'agent_mailbox', integration_account_id, mailbox_binding_id, current_revision
        FROM agent_mailbox_binding WHERE organisation_id = ?`,
      option: `SELECT 'agent_mailbox', binding.integration_account_id, binding.mailbox_binding_id,
             binding.current_revision, account.display_name || ' · Agent mailbox'
        FROM agent_mailbox_binding AS binding
        JOIN integration_account AS account
          ON account.integration_account_id = binding.integration_account_id
         AND account.organisation_id = binding.organisation_id
       WHERE binding.organisation_id = ?`,
    },
    {
      reference: `SELECT 'whatsapp_support', integration_account_id, support_binding_id, current_revision
        FROM whatsapp_support_binding WHERE organisation_id = ?`,
      option: `SELECT 'whatsapp_support', binding.integration_account_id, binding.support_binding_id,
             binding.current_revision, account.display_name || ' · WhatsApp support'
        FROM whatsapp_support_binding AS binding
        JOIN integration_account AS account
          ON account.integration_account_id = binding.integration_account_id
         AND account.organisation_id = binding.organisation_id
       WHERE binding.organisation_id = ?`,
    },
  ],

  async agentMailboxAuthorityIsLive(db, authority) {
    const row = await db
      .prepare(
        `SELECT 1 AS present
       FROM organisation AS organisation
       JOIN integration_account AS account
         ON account.organisation_id = organisation.organisation_id
       JOIN agent_mailbox_binding AS binding
         ON binding.integration_account_id = account.integration_account_id
        AND binding.organisation_id = organisation.organisation_id
       JOIN mailbox_ingress_policy AS policy
         ON policy.integration_account_id = account.integration_account_id
        AND policy.organisation_id = organisation.organisation_id
       JOIN mailbox_ingress_policy_revision AS revision
         ON revision.integration_account_id = policy.integration_account_id
        AND revision.policy_version = policy.current_version
       JOIN mailbox_ingress_policy_revision AS admitted
         ON admitted.integration_account_id = policy.integration_account_id
       WHERE organisation.organisation_id = ?
         AND organisation.status = 'active'
         AND account.integration_account_id = ?
         AND account.lifecycle = 'active'
         AND binding.mailbox_binding_id = ?
         AND binding.current_revision = ?
         AND admitted.policy_version = ?
         AND admitted.policy_version <= policy.current_version
         AND revision.kind = 'enabled'
         AND NOT EXISTS (
           SELECT 1
           FROM mailbox_ingress_policy_revision AS since_admission
           WHERE since_admission.integration_account_id = policy.integration_account_id
             AND since_admission.policy_version >= admitted.policy_version
             AND since_admission.policy_version <= policy.current_version
             AND since_admission.kind <> 'enabled'
         )
       LIMIT 1`,
      )
      .bind(
        authority.organisationId,
        authority.integrationAccountId,
        authority.mailboxBindingId,
        authority.bindingRevision,
        authority.mailboxPolicyVersion,
      )
      .first<PresentRow>();
    return row?.present === 1;
  },

  async whatsAppSupportAuthorityIsLive(db, authority) {
    const row = await db
      .prepare(
        `SELECT 1 AS present
       FROM organisation AS organisation
       JOIN integration_account AS account
         ON account.organisation_id = organisation.organisation_id
       JOIN whatsapp_support_binding AS binding
         ON binding.integration_account_id = account.integration_account_id
        AND binding.organisation_id = organisation.organisation_id
       JOIN whatsapp_ingress_policy AS policy
         ON policy.integration_account_id = account.integration_account_id
        AND policy.organisation_id = organisation.organisation_id
       JOIN whatsapp_ingress_policy_revision AS revision
         ON revision.integration_account_id = policy.integration_account_id
        AND revision.policy_version = policy.current_version
       WHERE organisation.organisation_id = ?
         AND organisation.status = 'active'
         AND account.integration_account_id = ?
         AND account.lifecycle = 'active'
         AND binding.support_binding_id = ?
         AND binding.current_revision = ?
         AND policy.current_version = ?
         AND revision.processing = 'enabled'
       LIMIT 1`,
      )
      .bind(
        authority.organisationId,
        authority.integrationAccountId,
        authority.supportBindingId,
        authority.bindingRevision,
        authority.ingressPolicyVersion,
      )
      .first<PresentRow>();
    return row?.present === 1;
  },

  async mailboxPolicyVersion(db, organisationId, integrationAccountId) {
    const row = await db
      .prepare(
        `SELECT current_version AS policyVersion FROM mailbox_ingress_policy
      WHERE organisation_id = ? AND integration_account_id = ?`,
      )
      .bind(organisationId, integrationAccountId)
      .first<{ policyVersion: unknown }>();
    return isPositiveInteger(row?.policyVersion) ? row.policyVersion : null;
  },

  async whatsAppPolicyVersion(db, organisationId, integrationAccountId) {
    const row = await db
      .prepare(
        `SELECT current_version AS policyVersion FROM whatsapp_ingress_policy
      WHERE organisation_id = ? AND integration_account_id = ?`,
      )
      .bind(organisationId, integrationAccountId)
      .first<{ policyVersion: unknown }>();
    return isPositiveInteger(row?.policyVersion) ? row.policyVersion : null;
  },

  async agentMailboxBindingIsCurrent(db, organisationId, subject) {
    const row = await db
      .prepare(
        `SELECT 1 AS present
             FROM integration_account AS account
             JOIN agent_mailbox_binding AS binding
               ON binding.organisation_id = account.organisation_id
              AND binding.integration_account_id = account.integration_account_id
            WHERE account.organisation_id = ? AND account.integration_account_id = ?
              AND account.lifecycle = 'active'
              AND binding.mailbox_binding_id = ? AND binding.current_revision = ?
            LIMIT 1`,
      )
      .bind(
        organisationId,
        subject.integrationAccountId,
        subject.mailboxBindingId,
        subject.bindingRevision,
      )
      .first<PresentRow>();
    return row?.present === 1;
  },

  async whatsAppSupportBindingIsCurrent(db, organisationId, subject) {
    const row = await db
      .prepare(
        `SELECT 1 AS present
             FROM integration_account AS account
             JOIN whatsapp_support_binding AS binding
               ON binding.organisation_id = account.organisation_id
              AND binding.integration_account_id = account.integration_account_id
            WHERE account.organisation_id = ? AND account.integration_account_id = ?
              AND account.lifecycle = 'active'
              AND binding.support_binding_id = ? AND binding.current_revision = ?
            LIMIT 1`,
      )
      .bind(
        organisationId,
        subject.integrationAccountId,
        subject.supportBindingId,
        subject.bindingRevision,
      )
      .first<PresentRow>();
    return row?.present === 1;
  },
};

// The conditions of the access check of tenancy for a mailbox authority and
// a support authority (Refactor 17): each one is a part of its one D1 read.
export const INBOX_AUTOMATION_RECORDS: InboxAutomationRecords = {
  agentMailboxIsCurrent: (authority) => ({
    sql: `EXISTS (SELECT 1 FROM agent_mailbox_binding b
          JOIN integration_account a ON a.organisation_id = b.organisation_id
            AND a.integration_account_id = b.integration_account_id
          WHERE b.organisation_id = ? AND b.mailbox_binding_id = ?
            AND b.current_revision = ? AND a.lifecycle = 'active')`,
    bindings: [
      authority.organisationId,
      authority.mailboxBindingId,
      authority.bindingRevision,
    ],
  }),
  whatsAppSupportIsCurrent: (authority) => ({
    sql: `EXISTS (SELECT 1 FROM whatsapp_support_binding b
          JOIN integration_account a ON a.organisation_id = b.organisation_id
            AND a.integration_account_id = b.integration_account_id
          WHERE b.organisation_id = ? AND b.support_binding_id = ?
            AND b.current_revision = ? AND a.lifecycle = 'active')`,
    bindings: [
      authority.organisationId,
      authority.supportBindingId,
      authority.bindingRevision,
    ],
  }),
};
