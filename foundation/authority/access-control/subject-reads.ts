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
 * One kind of subject as a part of the subject list (Refactor 17). The
 * owner of the table writes the SELECT, and the authority module puts it
 * into its one UNION ALL statement, so the list stays one D1 read.
 *
 * Each text is one SELECT with one `?`, the organisation id. `reference`
 * gives the columns kind, firstId, secondId and revision, in this order.
 * `option` gives the same four columns and a fifth, the label.
 */
export type SubjectSource = Readonly<{
  reference: string;
  option: string;
}>;

/** The parts of the subject list, each after `UNION ALL` but the first. */
export function subjectSourcesSql(
  sources: readonly SubjectSource[],
  column: keyof SubjectSource,
): string {
  return sources.map((source) => source[column]).join(`
      UNION ALL
      `);
}

/**
 * The records of the Inbox that an access decision reads (Refactor 17): the
 * agent mailbox and the WhatsApp support binding of an account and their
 * ingress policies. Each function is one D1 read. The Inbox owns the tables,
 * and the Worker registers its reads (`worker-ports.ts`). The rules stay
 * here: a member answers only what the record says now.
 */
export type InboxSubjectReads = Readonly<{
  /** The agent mailboxes and the WhatsApp support bindings as subjects. */
  subjectSources: readonly SubjectSource[];
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
 * subscription and an agent schedule binding. Each function is one D1 read.
 * The agent module owns the tables, and the Worker registers its reads
 * (`worker-ports.ts`).
 */
export type WorkflowSubjectReads = Readonly<{
  /** The enabled cue subscriptions and schedule bindings as subjects. */
  subjectSources: readonly SubjectSource[];
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

/**
 * The Slack channels of an Organisation as conversation subjects (Refactor
 * 17). The Organisation area owns the table, and the Worker registers the
 * part (`worker-ports.ts`).
 */
export type ConversationSubjectReads = Readonly<{
  subjectSources: readonly SubjectSource[];
}>;

export const conversationSubjectReads = definePort<ConversationSubjectReads>(
  "conversation_subject_reads",
);

/** The subject sources of each owner, in the order of the subject list. */
export function subjectSources(): readonly SubjectSource[] {
  return [
    ...conversationSubjectReads.use().subjectSources,
    ...workflowSubjectReads.use().subjectSources,
    ...inboxSubjectReads.use().subjectSources,
  ];
}
