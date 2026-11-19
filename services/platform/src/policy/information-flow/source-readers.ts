import type { RequestAuthority } from "@purin-labs/contracts";

import type { ContextVisibility } from "../../authorization/access-grants/types";
import { assertNever } from "@purin-labs/std";
export function sourceReaderForAuthority(
  authority: RequestAuthority,
): ContextVisibility {
  switch (authority.kind) {
    case "direct_conversation":
    case "control":
      return { kind: "person", personId: authority.requesterPersonId };
    case "shared_conversation":
      return {
        kind: "conversation",
        integrationAccountId: authority.integrationAccountId,
        conversationId: authority.conversationId,
      };
    case "workflow":
      return {
        kind: "workflow",
        workflowKind: "cue_subscription",
        workflowId: authority.workflowId,
        workflowRevision: authority.workflowRevision,
      };
    case "agent_mailbox":
      return {
        kind: "agent_mailbox",
        integrationAccountId: authority.integrationAccountId,
        mailboxBindingId: authority.mailboxBindingId,
        bindingRevision: authority.bindingRevision,
      };
    case "whatsapp_support":
      return {
        kind: "whatsapp_support",
        integrationAccountId: authority.integrationAccountId,
        supportBindingId: authority.supportBindingId,
        bindingRevision: authority.bindingRevision,
      };
    default:
      return assertNever(authority);
  }
}
