import type { ConnectorId } from "./ConnectorId";
import type { OrganisationId } from "@purin-labs/commerce-contracts";
import type { PrincipalId } from "./PrincipalId";

export type RequestAuthority =
  | {
      kind: "direct_conversation";
      organisationId: OrganisationId;
      requesterPersonId: PrincipalId;
      membershipRevision: number;
      role: string;
      connectorId: ConnectorId;
      integrationAccountId: string;
      conversationId: string;
    }
  | {
      kind: "shared_conversation";
      organisationId: OrganisationId;
      requesterPersonId: PrincipalId;
      membershipRevision: number;
      role: string;
      connectorId: ConnectorId;
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
