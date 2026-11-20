import type {
  AccessDecisionExplanation,
  AccessDecisionQuestion,
  AccessGrantLifecycle,
  AccessSubjectRef,
  AccessTargetRef,
  CapabilityDefinition,
  CapabilityMode,
  CapabilityPolicyProvenance,
  CapabilityRef,
  CommerceReadGrantScope,
  FileContextProvider,
  FileResourceScope,
  OnboardingControlRole,
} from "@purin-labs/contracts";
import type { StrictUnion, Variant } from "@purin-labs/type-utils";
import type { ControlErrorKind } from "./errors.ts";
import type {
  AccessControlAvailability,
  AccessControlBoundedPage,
  AgentPermissionListRead,
  CaseContextCollectionMetadataView,
  CaseContextCollectionRelationshipDecision,
  FileResourceDiscoveryEntry,
} from "../index.ts";

export type AccessSubview = "access" | "capabilities" | "data_flow";
export type AccessRequesterRole = OnboardingControlRole;

export type AccessBoundaryName =
  "access_control" | "access_options" | "access_explanation";

type AccessBoundaryDecodeError = Readonly<{
  kind: "decode";
  boundary: AccessBoundaryName;
  field: string;
  code: string;
  reason: string;
  details: Readonly<Record<string, string>> | null;
}>;

export type AccessError =
  | AccessBoundaryDecodeError
  | Readonly<{
      kind: "control";
      controlKind: ControlErrorKind;
      message: string;
    }>
  | Readonly<{
      kind: "network";
      message: string;
    }>
  | Readonly<{
      kind: "internal";
      message: string;
    }>;

export type AccessResult<TValue> =
  | Readonly<{ ok: true; value: TValue }>
  | Readonly<{ ok: false; error: AccessError }>;

export type AccessControlSubjectView = Readonly<{
  subjectRefId: string;
  kind:
    | "organisation_role"
    | "person"
    | "conversation"
    | "workflow"
    | "agent_mailbox"
    | "whatsapp_support"
    | "case";
  label: string;
  availability: "available" | "unavailable";
}>;

export type AccessControlCapabilityView = Readonly<{
  definition: CapabilityDefinition;
  mode: CapabilityMode;
  provenance: CapabilityPolicyProvenance;
  revision: number;
  changedAt: number;
  availability: AccessControlAvailability;
  activeGrantCount: number;
  actions: Readonly<{ kind: "read_only" | "change_capability_mode" }>;
}>;

export type AccessControlGrantView = Readonly<{
  grantId: string;
  revision: number;
  subject: AccessControlSubjectView;
  capability: Readonly<{
    capabilityId: string;
    capabilityVersion: number;
    label: string;
    risk: CapabilityDefinition["risk"];
  }>;
  resource: Readonly<{
    targetRefId: string;
    kind: "platform" | "integration_resource" | "commerce_scope";
    label: string;
    integrationAccountId: string | null;
    revision: number;
  }>;
  provenance: Readonly<{
    kind: "operator" | "baseline" | "integration_setup" | "cutover";
    label: string;
  }>;
  lifecycle: AccessGrantLifecycle;
  actions: Readonly<{ kind: "read_only" | "revoke_grant" }>;
}>;

export type AccessControlSourcePolicyView = Readonly<{
  sourceRefId: string;
  revision: number;
  capability: Readonly<{
    capabilityId: string;
    capabilityVersion: number;
    label: string;
  }>;
  owner: Readonly<{ integrationAccountId: string; label: string }>;
  resourceLabel: string;
  readers: readonly AccessControlSubjectView[];
  availability:
    | Readonly<{ kind: "available" }>
    | Readonly<{
        kind: "unavailable";
        reason:
          | "capability_disabled"
          | "resource_unavailable"
          | "subject_unavailable"
          | "policy_unavailable";
      }>;
  actions: Readonly<{ kind: "check_destination" }>;
}>;

export type AccessControlView = Readonly<{
  organisation: Readonly<{
    organisationId: string;
    name: string;
    lifecycle:
      | "draft"
      | "configuring"
      | "activating"
      | "active"
      | "suspended"
      | "archived";
    configurationVersion: number;
    requesterRole: AccessRequesterRole;
    actions:
      | Readonly<{ kind: "read_only" }>
      | Readonly<{ kind: "manage"; createGrant: true; applyDefaults: true }>;
  }>;
  revision: number;
  summary: Readonly<{
    capabilities: number;
    enabledCapabilities: number;
    approvalRequiredCapabilities: number;
    integrations: number;
    activeGrants: number;
    sourcePolicies: number;
  }>;
  capabilities: readonly AccessControlCapabilityView[];
  integrationResources: readonly Readonly<{
    integrationAccountId: string;
    provider: string;
    displayName: string;
    availability: AccessControlAvailability;
    updatedAt: number;
    actions: Readonly<{ kind: "none" }>;
  }>[];
  grants: AccessControlBoundedPage<AccessControlGrantView>;
  sourceFlowPolicies: AccessControlBoundedPage<AccessControlSourcePolicyView>;
}>;

export type AccessControlOption = Readonly<{
  kind:
    | "organisation_role"
    | "person"
    | "conversation"
    | "workflow"
    | "agent_mailbox"
    | "whatsapp_support"
    | "case"
    | "integration_account"
    | "provider_resource"
    | "access_target"
    | "commerce_target";
  refId: string;
  revision: number | null;
  label: string;
  detail: string;
  availability: AccessControlAvailability;
}>;

export type AccessOptionsPage = AccessControlBoundedPage<AccessControlOption>;

export type AccessRouteContent = Readonly<{
  view: AccessControlView;
  subjects: readonly AccessControlOption[];
  integrations: readonly AccessControlOption[];
  cases: readonly AccessControlOption[];
}>;

export type AccessRouteLoadState =
  | Readonly<{ kind: "loading" }>
  | (AccessRouteContent & Readonly<{ kind: "ready" }>)
  | Readonly<{ kind: "failed"; error: AccessError }>;

export type AccessMutationCommand =
  | Readonly<{
      kind: "create_grant";
      expectedRevision: number;
      subjectRef: AccessSubjectRef;
      target: AccessGrantTargetSelection;
    }>
  | Readonly<{
      kind: "revoke_grant";
      expectedRevision: number;
      grantId: string;
      grantRevision: number;
      reason: string;
    }>
  | Readonly<{
      kind: "change_capability_mode";
      expectedRevision: number;
      capabilityId: string;
      capabilityVersion: number;
      capabilityRevision: number;
      mode: CapabilityMode;
    }>
  | Readonly<{ kind: "apply_defaults"; expectedRevision: number }>;

export type AccessExplainRequest = AccessDecisionQuestion;
export type AccessExplainResult = AccessDecisionExplanation;
export type AccessGrantTargetSelection = StrictUnion<
  | Readonly<{
      kind: "custom_connector_operation";
      capabilityRef: CapabilityRef;
      integrationRef: string;
      connectorId: string;
      definitionRevision: number;
      definitionDigest: string;
      operationId: string;
    }>
  | Readonly<{ kind: "platform"; capabilityRef: CapabilityRef }>
  | Readonly<{
      kind: "commerce_entity_type";
      capabilityRef: CapabilityRef;
      /** The entity type of the commerce read grant that the selection makes. */
      entityTypeId: Variant<
        CommerceReadGrantScope,
        "entity_type"
      >["entityTypeId"];
    }>
  /** A list read that an agent permission request names. */
  | Readonly<{
      kind: "commerce_list";
      capabilityRef: CapabilityRef;
      listId: AgentPermissionListRead;
    }>
  | Readonly<{
      kind: "existing_target";
      capabilityRef: CapabilityRef;
      targetRef: AccessTargetRef;
    }>
  | Readonly<{
      kind: "published_commerce_target";
      capabilityRef: CapabilityRef;
      targetRef: AccessTargetRef;
    }>
  | Readonly<{
      kind: "provider_resource";
      capabilityRef: CapabilityRef;
      integrationRef: string;
      resourceRef: string;
    }>
  | Readonly<{
      kind: "file_resource";
      capabilityRef: CapabilityRef;
      integrationRef: string;
      scope: FileResourceScope;
    }>
>;

export type FileResourceAccount = Readonly<{
  integrationAccountId: string;
  provider: FileContextProvider;
  displayName: string;
}>;

export type DropboxResourcePage = Readonly<{
  provider: "dropbox";
  entries: readonly FileResourceDiscoveryEntry[];
  nextCursor: string | null;
}>;

export type GoogleDrivePickerConfig = Readonly<{
  clientId: string;
  apiKey: string;
  appId: string;
  expectedPermissionId: string;
  scope: "https://www.googleapis.com/auth/drive.file";
}>;

export type GoogleDrivePickedFile = Readonly<{
  providerFileId: string;
  name: string;
}>;

export type FileResourceSelection = Readonly<{
  integrationRef: string;
  scope: FileResourceScope;
}>;

export type AccessRouteTransport = Readonly<{
  readCaseContextCollections: (
    organisationId: string,
    caseRef: string,
    revision: number,
  ) => Promise<readonly CaseContextCollectionMetadataView[]>;
  /** The pages that a Case's agent received from a screen (Plan 87). */
  readCaseScreenObservations: (
    organisationId: string,
    caseRef: string,
    revision: number,
  ) => Promise<
    readonly import("../case-screen-observations.ts").CaseScreenObservationView[]
  >;
  reviewCaseContextCollection: (
    organisationId: string,
    caseContextCollectionId: string,
    revision: number,
    decision: CaseContextCollectionRelationshipDecision,
  ) => Promise<void>;
  readBudget: (
    organisationId: string,
  ) => Promise<import("./ai-budget").AiBudgetView>;
  saveBudget: (
    organisationId: string,
    revision: number,
    limits: import("./ai-budget").AiBudgetLimits,
  ) => Promise<void>;
  read: (
    organisationId: string,
    grantCursor: string | null,
    sourceCursor: string | null,
  ) => Promise<AccessResult<AccessControlView>>;
  readOptions: (
    organisationId: string,
    kind: "subjects" | "resources" | "cases" | "commerce_targets",
    query: string,
    cursor: string | null,
    integrationRef: string | null,
  ) => Promise<AccessResult<AccessOptionsPage>>;
  mutate: (
    organisationId: string,
    command: AccessMutationCommand,
  ) => Promise<AccessResult<void>>;
  explain: (
    organisationId: string,
    question: AccessExplainRequest,
  ) => Promise<AccessResult<AccessExplainResult>>;
  discoverDropbox: (
    organisationId: string,
    input: Readonly<{
      integrationAccountId: string;
      path: string;
      query: string;
      cursor: string | null;
    }>,
  ) => Promise<DropboxResourcePage>;
  pickGoogleDrive: (
    organisationId: string,
    integrationAccountId: string,
  ) => Promise<GoogleDrivePickedFile | null>;
}>;
