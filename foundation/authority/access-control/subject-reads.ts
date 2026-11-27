import type { RequestAuthority } from "@purin-labs/contracts";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
import type { Variant } from "@purin-labs/type-utils";
import type { GrantSubject } from "../authorization/access-grants/types";

/**
 * The records of the Inbox that an access decision reads (Refactor 17): the
 * agent mailbox and the WhatsApp support binding of an account and their
 * ingress policies. Each member is one D1 read. The Inbox owns the tables,
 * and the Worker registers its reads (`worker-ports.ts`). The rules stay
 * here: a member answers only what the record says now.
 */
export type InboxSubjectReads = Readonly<{
  /**
   * A mailbox authority is live while the organisation and the mailbox
   * account are active, the agent assignment is still the binding revision
   * the turn was admitted under, and mail processing has stayed on without a
   * break since that turn was admitted.
   *
   * The binding revision carries what the agent may read and do, so it must
   * match exactly. A policy revision carries only the processing switch and
   * five limits. It grants nothing and removes nothing. A change of the
   * limits therefore leaves earlier work live: a reply draft that waits for
   * approval can still be reviewed, edited, sent or rejected.
   *
   * Processing stayed on when the revision the turn was admitted under
   * exists, the current revision is that one or a later one, and every
   * revision from the one to the other, both included, is `enabled`. One
   * `disabled_by_operator` revision in that range ends the authority for
   * good. It stays ended after processing is turned on again: the operator
   * stopped the mailbox, and work from before the stop does not come back.
   */
  agentMailboxAuthorityIsLive(
    db: OrganisationDatabase,
    authority: Variant<RequestAuthority, "agent_mailbox">,
  ): Promise<boolean>;
  /**
   * A WhatsApp support authority is live only while the organisation,
   * phone-number account, agent binding revision, and published ingress
   * policy all match the exact values the turn was admitted under and
   * processing is still enabled.
   */
  whatsAppSupportAuthorityIsLive(
    db: OrganisationDatabase,
    authority: Variant<RequestAuthority, "whatsapp_support">,
  ): Promise<boolean>;
  /** The current version of the mail ingress policy of an account. */
  mailboxPolicyVersion(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
    integrationAccountId: IntegrationAccountId,
  ): Promise<number | null>;
  /** The current version of the WhatsApp ingress policy of an account. */
  whatsAppPolicyVersion(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
    integrationAccountId: IntegrationAccountId,
  ): Promise<number | null>;
  /** Whether the account is active and the binding is at its revision. */
  agentMailboxBindingIsCurrent(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
    subject: Variant<GrantSubject, "agent_mailbox">,
  ): Promise<boolean>;
  /** Whether the account is active and the binding is at its revision. */
  whatsAppSupportBindingIsCurrent(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
    subject: Variant<GrantSubject, "whatsapp_support">,
  ): Promise<boolean>;
}>;

export const inboxSubjectReads = definePort<InboxSubjectReads>(
  "inbox_subject_reads",
);

/**
 * The automation records that an access decision reads (Refactor 17): a cue
 * subscription and an agent schedule binding. Each member is one D1 read.
 * The agent module owns the tables, and the Worker registers its reads
 * (`worker-ports.ts`).
 */
export type WorkflowSubjectReads = Readonly<{
  /** Whether the organisation is active and the subscription is on at its version. */
  cueSubscriptionAuthorityIsLive(
    db: OrganisationDatabase,
    authority: Variant<RequestAuthority, "workflow">,
  ): Promise<boolean>;
  /** Whether the organisation is active and the binding is on at its revision. */
  scheduleBindingAuthorityIsLive(
    db: OrganisationDatabase,
    authority: Variant<RequestAuthority, "workflow">,
  ): Promise<boolean>;
  /** Whether the subscription is on at the revision of the subject. */
  cueSubscriptionIsCurrent(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
    subject: Variant<GrantSubject, "workflow">,
  ): Promise<boolean>;
  /** Whether the schedule binding is on at the revision of the subject. */
  scheduleBindingIsCurrent(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
    subject: Variant<GrantSubject, "workflow">,
  ): Promise<boolean>;
}>;

export const workflowSubjectReads = definePort<WorkflowSubjectReads>(
  "workflow_subject_reads",
);
