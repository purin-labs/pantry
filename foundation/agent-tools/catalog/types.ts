import type { CodemodeRemote } from "@earendil-works/pi-codemode/portable";
import type {
  AuthorizedHarnessToolResult,
  CodeModeExecutionOutcome,
  FileContextProvider,
} from "@purin-labs/contracts";
import type { IntegrationAccountId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import type { JsonSchema } from "./selection";
import type { TurnTool } from "./tool-registry";

/** The file that a file tool names: its account, its provider and its id. */
export type CanonicalFileReference = Readonly<{
  readonly integrationAccountId: IntegrationAccountId;
  readonly provider: FileContextProvider;
  readonly providerFileId: string;
}>;

export type FileSearchToolResult = Readonly<{
  readonly reference: CanonicalFileReference;
  readonly segmentIndex: number;
  readonly sourceRevision: number;
  readonly title: string;
  readonly displayPath: string;
  readonly deepLink: string;
  readonly excerpt: string;
  readonly metadataOnlyReason: string | null;
}>;

export type FileReadToolResult =
  | Readonly<{
      readonly kind: "content";
      readonly reference: CanonicalFileReference;
      readonly title: string;
      readonly displayPath: string;
      readonly deepLink: string;
      readonly startSegment: number;
      readonly segments: readonly string[];
      readonly continuation:
        | Readonly<{ readonly kind: "complete" }>
        | Readonly<{ readonly kind: "more"; readonly nextSegment: number }>;
    }>
  | Readonly<{
      readonly kind: "metadata_only";
      readonly reference: CanonicalFileReference;
      readonly title: string;
      readonly displayPath: string;
      readonly deepLink: string;
      readonly reason: string;
    }>;

export type HarnessCodeModeSandbox = (executionId: string) => CodemodeRemote;

export type HarnessNativeCodeMode =
  | {
      readonly kind: "enabled";
      /**
       * `null` when this deployment has no sandbox Worker. Admission then
       * fails before any reservation, and no other executor takes its place.
       */
      readonly sandbox: HarnessCodeModeSandbox | null;
      readonly admission: HarnessCodeModeAdmission;
      executeTool(
        executionLease: HarnessCodeModeExecutionLease,
        name: string,
        inputJson: string,
        callId: string,
      ): Promise<AuthorizedHarnessToolResult>;
      /**
       * The capabilities that the nested call `callId` claimed. They are the
       * sources of its result, and they are stored with that result.
       */
      claimedCapabilities(callId: string): readonly string[];
      /**
       * Whether a result with these sources may reach generated code now. It
       * reads current authority, and it spends no allowance. A replay asks
       * this for every recorded result, because a recorded result is not
       * current authorization.
       */
      authorizeSources(
        capabilities: readonly string[],
      ): Promise<Result<null, { readonly detail: string }>>;
    }
  | {
      readonly kind: "disabled";
      readonly sandbox?: never;
      readonly admission?: never;
      readonly executeTool?: never;
      readonly claimedCapabilities?: never;
      readonly authorizeSources?: never;
    };

export type HarnessToolDefinition = {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly strict: true;
  readonly parameters: JsonSchema;
};

export type HarnessCodeModeAuthority = {
  readonly mode: "hybrid";
  readonly catalogDigest: string;
  readonly definitions: readonly HarnessToolDefinition[];
  readonly codeMode: HarnessNativeCodeMode;
  readonly claimCapability: HarnessCapabilityClaim;
  executeTool(
    name: string,
    inputJson: string,
    callId: string,
  ): Promise<AuthorizedHarnessToolResult>;
};

export type HarnessCatalogSelection = {
  readonly allowedCapabilities: readonly HarnessCapabilityName[];
  /** The tools that this turn adds, for example custom connector operations. */
  readonly turnTools?: readonly TurnTool[];
  /**
   * The page commands that the turn offers (Plan 87). A surface tool is
   * offered when its command is in this list. The field keeps its first
   * name: the first page with commands was the Kitchen workspace.
   */
  readonly bakerySurfaceCommands?: readonly string[];
  /** True for a turn that may propose a Memory from a person's message. */
  readonly memoryProposal?: boolean;
  /** True for a Slack thread turn, which may schedule a follow-up turn. */
  readonly followUp?: boolean;
  /**
   * True for a Portal chat turn or a Slack thread turn, which may propose a
   * side Case (Plan 74).
   */
  readonly sideCaseProposal?: boolean;
  /**
   * True for a Slack thread or Portal chat turn, which may ask a person for
   * a capability it lacks.
   */
  readonly permissionRequest?: boolean;
};

/** What the agent states when it proposes a Memory from a chat message. */
export type HarnessMemoryProposalRequest = Readonly<{
  statement: string;
  memoryKind: "fact" | "preference";
}>;

export type HarnessMemoryProposalResult =
  | Readonly<{
      kind: "memory_proposed";
      state: "waiting_for_review";
      detail: string;
      reason?: never;
    }>
  | Readonly<{
      kind: "memory_not_proposed";
      reason: string;
      state?: never;
      detail?: never;
    }>;

export type HarnessMemoryProposal = (
  request: HarnessMemoryProposalRequest,
) => Promise<HarnessMemoryProposalResult>;

/** When to come back to a Slack thread, and what to do then. */
export type HarnessFollowUpRequest = Readonly<{
  afterMinutes: number;
  note: string;
}>;

export type HarnessFollowUpResult =
  | Readonly<{
      kind: "follow_up_scheduled";
      dueAt: string;
      afterMinutes: number;
      detail: string;
      reason?: never;
    }>
  | Readonly<{
      kind: "follow_up_not_scheduled";
      reason: string;
      dueAt?: never;
      afterMinutes?: never;
      detail?: never;
    }>;

export type HarnessFollowUpSchedule = (
  request: HarnessFollowUpRequest,
) => Promise<HarnessFollowUpResult>;

/** Separate work that the agent proposes as a side Case (Plan 74). */
export type HarnessSideCaseProposalRequest = Readonly<{
  title: string;
  brief: string;
}>;

export type HarnessSideCaseProposalResult =
  | Readonly<{
      kind: "side_case_proposed";
      detail: string;
      reason?: never;
    }>
  | Readonly<{
      kind: "side_case_not_proposed";
      reason: string;
      detail?: never;
    }>;

export type HarnessSideCaseProposal = (
  request: HarnessSideCaseProposalRequest,
) => Promise<HarnessSideCaseProposalResult>;

export type HarnessCapabilityName =
  | typeof CAPABILITY_KEYS.airtableApiRead
  | typeof CAPABILITY_KEYS.airtableApiWrite
  | typeof CAPABILITY_KEYS.integrationDiscoveryRead
  | typeof CAPABILITY_KEYS.emailMailboxRead
  | typeof CAPABILITY_KEYS.emailReplyPropose
  | typeof CAPABILITY_KEYS.emailOperationalPropose
  | typeof CAPABILITY_KEYS.slackMessagePropose
  | typeof CAPABILITY_KEYS.whatsappSupportRead
  | typeof CAPABILITY_KEYS.whatsappSupportReplySend
  | typeof CAPABILITY_KEYS.commerceEntityPlaneContext
  | typeof CAPABILITY_KEYS.commerceWorkflowCanvasMove
  | typeof CAPABILITY_KEYS.commerceProductDescriptionDraftEdit
  | typeof CAPABILITY_KEYS.commerceMenuDraftRead
  | typeof CAPABILITY_KEYS.commerceMenuDraftEdit
  | typeof CAPABILITY_KEYS.commerceProductionPlanEdit
  | typeof CAPABILITY_KEYS.commerceOrderQueueAdvance
  | typeof CAPABILITY_KEYS.commerceSoldOutMark
  | typeof CAPABILITY_KEYS.commerceRecipeSave
  | typeof CAPABILITY_KEYS.commerceSupplyCostSave
  | typeof CAPABILITY_KEYS.commerceSupplierCreate
  | typeof CAPABILITY_KEYS.deviceRead
  | typeof CAPABILITY_KEYS.devicePause
  | typeof CAPABILITY_KEYS.recipeWorkflowRead
  | typeof CAPABILITY_KEYS.recipeWorkflowPropose
  | typeof CAPABILITY_KEYS.deviceCameraRead
  | typeof CAPABILITY_KEYS.jevFeaturesRead
  | typeof CAPABILITY_KEYS.jevFeaturesManage
  | typeof CAPABILITY_KEYS.billingAccountRead
  | typeof CAPABILITY_KEYS.organisationLogoChange
  | typeof CAPABILITY_KEYS.bakeRead
  | typeof CAPABILITY_KEYS.bakePropose
  | typeof CAPABILITY_KEYS.bakeRunPause
  | typeof CAPABILITY_KEYS.marketingEmailDraftEdit
  | typeof CAPABILITY_KEYS.commerceActionPropose
  | typeof CAPABILITY_KEYS.fileRead
  | typeof CAPABILITY_KEYS.messageAttachmentInspect
  | typeof CAPABILITY_KEYS.messageLinkRead
  | typeof CAPABILITY_KEYS.customConnectorRead
  | typeof CAPABILITY_KEYS.customConnectorWrite
  | typeof CAPABILITY_KEYS.workspaceQuery;

/** The tool call a proposal comes from, as the accepted history names it. */
export type CommerceActionProposalOrigin = Readonly<{ toolCallId: string }>;

export type StaffPageToolReceipt = Readonly<{
  receiptId: string;
  result: string;
}>;

export type HarnessCapabilityClaimInput = {
  readonly callId: string;
  readonly capability: HarnessCapabilityName;
  readonly boundary: "direct_tool" | "code_mode" | "attachment_preparation";
};

export type HarnessCapabilityClaim = (
  input: HarnessCapabilityClaimInput,
) => Promise<
  Result<
    null,
    {
      readonly code: "embedded_harness_capability_claim_rejected";
      readonly detail: string;
    }
  >
>;

export type HarnessCodeModeConstructionError =
  | { readonly code: "embedded_harness_tool_catalog_digest_mismatch" }
  | { readonly code: "embedded_harness_custom_connector_unavailable" }
  | { readonly code: "embedded_harness_surface_unavailable" };

export type HarnessResourceScopeError = {
  readonly code: "embedded_harness_resource_scope_invalid";
  readonly scope: string;
};

export type HarnessCodeModeExecutionLease = {
  readonly executionId: string;
  readonly leaseId: string;
};

/** An execution that the admission holds for the current runtime lease. */
export type HarnessCodeModeAdmittedExecution = HarnessCodeModeExecutionLease & {
  /** The deadline of the first admission. A resumed execution keeps it. */
  readonly executionDeadlineAt: number;
  /**
   * `false` when an earlier process admitted the execution under another
   * catalog or policy. The reservation settles, and no VM starts.
   */
  readonly runnable: boolean;
};

/**
 * Decides whether results with these sources may be read now. It validates
 * current authority for every capability, and it claims no budget.
 */
export type HarnessSourceAuthorization = (
  capabilities: readonly HarnessCapabilityName[],
) => Promise<Result<null, { readonly detail: string }>>;

export type HarnessCodeModeExecutionOutcome = CodeModeExecutionOutcome;

/**
 * A capability claim that a global admission freeze refused. The script that
 * made the call stops: it must not continue on a value that the freeze kept
 * from it.
 */
export class CodeModeAdmissionFrozenError extends Error {
  constructor() {
    super("Code Mode capability claim failed: code_mode_platform_disabled");
    this.name = "CodeModeAdmissionFrozenError";
  }
}

export type HarnessCodeModeAdmission = {
  begin(
    source: string,
    callId: string,
  ): Promise<HarnessCodeModeAdmittedExecution>;
  /** Rejects with `CodeModeAdmissionFrozenError` during an admission freeze. */
  claim(
    lease: HarnessCodeModeExecutionLease,
    callId: string,
    inputBytes: number,
  ): Promise<void>;
  complete(
    lease: HarnessCodeModeExecutionLease,
    callId: string,
    outputBytes: number,
  ): Promise<void>;
  /**
   * Ends the capability calls that an earlier process of this execution left
   * in flight, or that a failed claim or completion left in flight, and takes
   * the counts of the Organisation. It runs only after the calls of this
   * process ended.
   */
  abandon(lease: HarnessCodeModeExecutionLease): Promise<void>;
  settle(
    lease: HarnessCodeModeExecutionLease,
    outcome: HarnessCodeModeExecutionOutcome,
    outputBytes: number,
  ): Promise<void>;
};

export type HarnessWorkspaceQuery =
  | { readonly kind: "read"; readonly path: string }
  | { readonly kind: "search"; readonly query: string; readonly limit: number };

export type HarnessWorkspaceQueryResult =
  | {
      readonly kind: "file";
      readonly revision: string;
      readonly path: string;
      readonly mediaType: string;
      readonly sha256: string;
      readonly content: string;
    }
  | {
      readonly kind: "matches";
      readonly revision: string;
      readonly matches: readonly {
        readonly path: string;
        readonly line: number;
        readonly excerpt: string;
      }[];
      readonly truncated: boolean;
    };

export type WorkspaceQuery = (
  input: HarnessWorkspaceQuery,
) => Promise<HarnessWorkspaceQueryResult>;

export type HarnessFileSearch = Readonly<{
  readonly query: string;
  readonly limit: number;
}>;

export type HarnessFileRead = Readonly<{
  readonly reference: CanonicalFileReference;
  readonly startSegment: number;
}>;

export type FileSearch = (
  input: HarnessFileSearch,
) => Promise<readonly FileSearchToolResult[]>;

export type FileRead = (input: HarnessFileRead) => Promise<FileReadToolResult>;

type MessageAttachmentInspectResult = Readonly<Record<string, unknown>>;

type MessageLinkReadResult = Readonly<Record<string, unknown>>;

export type MessageAttachmentInspect = (input: {
  readonly attachmentId: string;
}) => Promise<MessageAttachmentInspectResult>;

export type MessageLinkRead = (input: {
  readonly url: string;
}) => Promise<MessageLinkReadResult>;
