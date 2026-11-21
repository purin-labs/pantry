import type { MailboxReplyScope } from "./MailboxReplyScope";
import type { OrganisationId } from "@purin-labs/contract-schema";
import type { PrincipalId } from "./PrincipalId";

export type AuthorityPartitionKey =
  | {
      kind: "direct_conversation";
      organisationId: OrganisationId;
      requesterPersonId: PrincipalId;
      membershipRevision: number;
      role: string;
      integrationAccountId: string;
      conversationId: string;
    }
  | {
      kind: "shared_conversation";
      organisationId: OrganisationId;
      membershipRevision: number;
      role: string;
      integrationAccountId: string;
      conversationId: string;
    }
  | {
      kind: "workflow";
      organisationId: OrganisationId;
      workflowId: string;
      workflowRevision: number;
    }
  | {
      kind: "agent_mailbox";
      organisationId: OrganisationId;
      integrationAccountId: string;
      mailboxBindingId: string;
      bindingRevision: number;
      mailboxPolicyVersion: number;
      replyScope: MailboxReplyScope;
    }
  | {
      kind: "whatsapp_support";
      organisationId: OrganisationId;
      integrationAccountId: string;
      supportBindingId: string;
      bindingRevision: number;
      ingressPolicyVersion: number;
    }
  | {
      kind: "control";
      organisationId: OrganisationId;
      requesterPersonId: PrincipalId;
      userId: string;
      membershipRevision: number;
      role: string;
    };
