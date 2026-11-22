import type { OrganisationId } from "@purin-labs/kernel/ids";
import type {
  AccessGrantLifecycle as ContractAccessGrantLifecycle,
  AccessGrantTarget as ContractAccessGrantTarget,
  CommerceReadGrantScope as ContractCommerceReadGrantScope,
  GrantProvenance as ContractGrantProvenance,
  GrantSubject as ContractGrantSubject,
  WorkflowAuthorityKind as ContractWorkflowAuthorityKind,
} from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";

type WorkflowAuthorityKind = ContractWorkflowAuthorityKind;
export type GrantSubject = Readonly<ContractGrantSubject>;

export type ContextVisibility =
  | Readonly<{ readonly kind: "organisation_role"; readonly role: string }>
  | Readonly<{ readonly kind: "person"; readonly personId: string }>
  | Readonly<{
      readonly kind: "conversation";
      readonly integrationAccountId: string;
      readonly conversationId: string;
    }>
  | Readonly<{ readonly kind: "case"; readonly caseId: string }>
  | Readonly<{
      readonly kind: "workflow";
      readonly workflowKind: WorkflowAuthorityKind;
      readonly workflowId: string;
      readonly workflowRevision: number;
    }>
  | Readonly<{
      readonly kind: "agent_mailbox";
      readonly integrationAccountId: string;
      readonly mailboxBindingId: string;
      readonly bindingRevision: number;
    }>
  | Readonly<{
      readonly kind: "whatsapp_support";
      readonly integrationAccountId: string;
      readonly supportBindingId: string;
      readonly bindingRevision: number;
    }>;

type AccessGrantId = string;

export type AccessGrantTarget = Readonly<ContractAccessGrantTarget>;
export type CommerceReadGrantScope = Readonly<ContractCommerceReadGrantScope>;
export type AccessGrantLifecycle = Readonly<ContractAccessGrantLifecycle>;
export type GrantProvenance = Readonly<ContractGrantProvenance>;

export type FileResourceAccessGrantTarget = Variant<
  AccessGrantTarget,
  "file_resource"
>;

export type AccessGrant = Readonly<{
  readonly grantId: AccessGrantId;
  readonly organisationId: OrganisationId;
  readonly subject: GrantSubject;
  readonly target: AccessGrantTarget;
  readonly provenance: GrantProvenance;
  readonly lifecycle: AccessGrantLifecycle;
}>;
