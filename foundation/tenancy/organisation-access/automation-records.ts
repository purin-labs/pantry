import type { RequestAuthority } from "@purin-labs/contracts";
import { definePort } from "@purin-labs/kernel/port";
import type { Variant } from "@purin-labs/type-utils";

/**
 * A condition of one SELECT of tenancy, with its bind values in the order
 * of its `?` marks. The owner of the tables writes it.
 */
export type AutomationRecordCondition = Readonly<{
  sql: string;
  bindings: readonly (string | number)[];
}>;

/**
 * The automation records that the access check of an Organisation reads
 * (Refactor 17). An automation acts while its own record is current. The
 * check is one D1 read of tenancy, and each member gives one condition of
 * it: true while the record of the authority is current. The agent module
 * owns the workflow tables and the Inbox owns the binding tables. The Worker
 * registers the conditions (`worker-ports.ts`).
 */
export type WorkflowAutomationRecords = Readonly<{
  /** The enabled revision of a cue subscription or of a schedule binding. */
  workflowIsCurrent(
    authority: Variant<RequestAuthority, "workflow">,
  ): AutomationRecordCondition;
}>;

export const workflowAutomationRecords = definePort<WorkflowAutomationRecords>(
  "workflow_automation_records",
);

export type InboxAutomationRecords = Readonly<{
  /** The current revision of a mailbox binding of an active account. */
  agentMailboxIsCurrent(
    authority: Variant<RequestAuthority, "agent_mailbox">,
  ): AutomationRecordCondition;
  /** The current revision of a support binding of an active account. */
  whatsAppSupportIsCurrent(
    authority: Variant<RequestAuthority, "whatsapp_support">,
  ): AutomationRecordCondition;
}>;

export const inboxAutomationRecords = definePort<InboxAutomationRecords>(
  "inbox_automation_records",
);
