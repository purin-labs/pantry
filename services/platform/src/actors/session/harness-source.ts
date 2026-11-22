import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { SessionSideCase } from "./conversation-port";
import { turnMayProposeSideCase } from "./turn-tool-offers";
import type {
  AcceptedHarnessEventCursor,
  AcceptedInputRef,
  AgentSessionLifecycle,
  CaseAssignment,
  HarnessCheckpointRecord,
  HarnessTurnLease,
  RequestAuthority,
  SessionBudgetAccount,
  TurnIdentity,
  WorkspaceRevisionReceipt,
} from "@purin-labs/contracts";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  classifyHarnessCheckpoint,
  readLatestHarnessCheckpoint,
  type HarnessAuthorityError,
  type HarnessHistoryMaterialization,
  type HarnessHistoryUsage,
} from "../agent-session-harness-authority";
import type { HarnessHistoryRead } from "../harness-history";
import type { CanonicalHarnessCheckpointInput } from "../agent-session-harness-checkpoint";
import { digestModelRoute } from "../../models/route";
import { harnessToolCatalogDigest } from "../embedded-harness-tool-host";
import type {
  ToolRegistry,
  TurnTool,
} from "../../agent-tools/catalog/tool-registry";
import type { SessionToolWiring } from "./tool-wiring";
import type {
  EmbeddedHarnessAdapter,
  EmbeddedHarnessSource,
} from "../embedded-harness";
import { selectEmbeddedHarnessAdapterForModelRoute } from "../embedded-harness-adapter";
import { harnessCapabilitiesFromCapabilityKeys } from "../../agent-tools/catalog/code-mode";
import {
  type CurrentEffectiveGrantAuthority,
  resolveEffectiveGrantSetForAuthorityPartition,
} from "@purin-labs/authority/authorization/access-grants/turn-authority";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, errorMessage, sha256Hex } from "@purin-labs/std";
import {
  endsOnAnswer,
  freshLineageSource,
  hasSupersededProjectContext,
  projectMaterializedHarnessHistory,
  recoverFreshHarnessHistory,
} from "./model-context";
import { traceHarnessRestoreMetrics } from "./traces";
import type {
  CanonicalEmbeddedHarnessCheckpointBinding,
  CanonicalEmbeddedHarnessResolution,
  CanonicalEmbeddedHarnessRunError,
  CanonicalEmbeddedHarnessRuntimeSource,
  CanonicalHarnessCheckpointRestoreError,
  CheckpointPublicationError,
} from "./types";
import type { SessionToolContext } from "../../agent-tools/context";
import type {
  HarnessSideCaseProposalRequest,
  HarnessSideCaseProposalResult,
} from "../../agent-tools/catalog/types";

/**
 * The tools that a turn adds to the tool list, with the live authority that
 * selected them. The same Actor call decides its other capability questions
 * against this authority and does not read the grants again.
 */
export type AcceptedTurnTools = Readonly<{
  readonly authority: CurrentEffectiveGrantAuthority;
  readonly turnTools: readonly TurnTool[];
}>;

export async function resolveAcceptedTurnTools(input: {
  /** Gives the tools that the grants of the turn select. */
  readonly turnTools: SessionToolWiring["turnTools"];
  readonly scope: OrganisationExecutionScope;
  readonly organisationId: OrganisationId;
  readonly authority: RequestAuthority;
  readonly userAuthority: import("@purin-labs/tenancy/organisation-access/access").OrganisationUserAuthority;
  readonly assignment: CaseAssignment;
}): Promise<Result<AcceptedTurnTools, CanonicalEmbeddedHarnessRunError>> {
  const authority = await resolveEffectiveGrantSetForAuthorityPartition({
    db: input.scope.database,
    accountAccess: input.scope.accountAccess,
    userAuthority: input.userAuthority,
    action: "execute",
    organisationId: input.organisationId,
    authority: input.authority,
    authorityPartition: input.assignment.authorityPartition,
  });
  if (!authority.ok) {
    return {
      ok: false,
      error: { code: "embedded_harness_authority_partition_unavailable" },
    };
  }
  const catalog = await input.turnTools({
    database: input.scope.database,
    effectiveGrants: authority.value.effectiveGrantSet,
  });
  return catalog.ok
    ? {
        ok: true,
        value: { authority: authority.value, turnTools: catalog.value },
      }
    : {
        ok: false,
        error: {
          code: "embedded_harness_custom_connector_catalog_unavailable",
        },
      };
}

export async function resolveCanonicalEmbeddedHarnessCheckpointBinding(input: {
  /** The one list of the agent tools. */
  registry: ToolRegistry;
  state: Variant<AgentSessionLifecycle, "sleeping" | "processing">;
  runtime: CanonicalEmbeddedHarnessRuntimeSource;
  harnessInstructions: string;
  assignment: CaseAssignment;
  /** The tools that this turn adds to the tool list. */
  turnTools: readonly TurnTool[];
  bakerySurfaceCommands: readonly string[];
  memoryProposal: boolean;
  followUp: boolean;
  permissionRequest: boolean;
  sideCaseProposal: boolean;
}): Promise<
  Result<CanonicalEmbeddedHarnessResolution, CanonicalEmbeddedHarnessRunError>
> {
  const adapter = selectEmbeddedHarnessAdapterForModelRoute(
    input.state.state.contract.modelRoute,
  );
  const instructionDigest = await sha256Hex(input.harnessInstructions);
  if (
    !embeddedHarnessAdapterSupportsModel(
      adapter,
      input.state.state.contract.modelRoute.model,
    )
  ) {
    return {
      ok: false,
      error: { code: "embedded_harness_model_authority_unavailable" },
    };
  }
  const modelRouteDigest = await digestModelRoute(
    input.state.state.contract.modelRoute,
  );
  const capabilities = harnessCapabilitiesFromCapabilityKeys(
    input.assignment.authorityPartition.capabilityKeys,
  );
  if (!capabilities.ok) {
    return {
      ok: false,
      error: { code: "embedded_harness_resource_scope_invalid" },
    };
  }
  const currentCatalogDigest = await harnessToolCatalogDigest(
    input.registry,
    capabilities.value,
    input.turnTools,
    input.bakerySurfaceCommands,
    input.memoryProposal,
    input.followUp,
    input.permissionRequest,
    input.sideCaseProposal,
  );
  const runtime = selectRuntimeForHarnessCatalog(
    input.runtime,
    currentCatalogDigest,
  );
  const workspace = canonicalTextTurnWorkspaceReceipt(input.state, runtime);
  if (!workspace.ok) {
    return {
      ok: false,
      error: { code: "embedded_harness_runtime_source_mismatch" },
    };
  }
  if (
    input.assignment.sessionId !== input.state.state.identity.sessionId ||
    input.assignment.authority.authorityPartitionDigest !==
      input.assignment.authorityPartition.digest ||
    input.assignment.authorityPartition.policyVersion !==
      input.state.state.contract.policyVersion
  ) {
    return {
      ok: false,
      error: { code: "embedded_harness_tool_catalog_digest_mismatch" },
    };
  }
  if (
    runtime.kind === "resume_turn" &&
    (runtime.binding.instructionDigest !== instructionDigest ||
      runtime.binding.toolCatalogDigest !== currentCatalogDigest ||
      runtime.binding.modelRouteDigest !== modelRouteDigest ||
      runtime.binding.workspaceRevision !== workspace.value.revision ||
      runtime.binding.policyRevision !==
        input.state.state.contract.policyVersion)
  ) {
    return {
      ok: false,
      error: { code: "embedded_harness_runtime_source_mismatch" },
    };
  }
  if (runtime.kind === "restore") {
    if (runtime.checkpoint.instructionDigest !== instructionDigest) {
      return {
        ok: false,
        error: { code: "embedded_harness_instruction_digest_mismatch" },
      };
    }
    if (runtime.checkpoint.modelRouteDigest !== modelRouteDigest) {
      return {
        ok: false,
        error: { code: "embedded_harness_model_route_digest_mismatch" },
      };
    }
  }
  return {
    ok: true,
    value: {
      runtime,
      binding: {
        workspaceRevisionReceipt: workspace.value,
        instructionDigest,
        toolCatalogDigest: currentCatalogDigest,
        modelRouteDigest,
        workspaceRevision: workspace.value.revision,
        policyRevision: input.state.state.contract.policyVersion,
      },
    },
  };
}

function embeddedHarnessAdapterSupportsModel(
  adapter: EmbeddedHarnessAdapter,
  model: string,
): boolean {
  return model === adapter.manifest.model;
}

function selectRuntimeForHarnessCatalog(
  runtime: CanonicalEmbeddedHarnessRuntimeSource,
  currentCatalogDigest: string,
): CanonicalEmbeddedHarnessRuntimeSource {
  if (
    runtime.kind === "restore" &&
    runtime.checkpoint.toolCatalogDigest !== currentCatalogDigest
  ) {
    return {
      kind: "fresh_lineage",
      reason: "tool_catalog_digest_mismatch",
    };
  }
  return runtime;
}

export async function materializeEmbeddedHarnessSource(input: {
  backendId: "pi";
  source: CanonicalEmbeddedHarnessRuntimeSource;
  sessionId: string;
  requestingOrganisationId: OrganisationId;
  acceptedInput: AcceptedInputRef;
  turn: TurnIdentity;
  restoreCheckpoint(input: {
    requestingOrganisationId: OrganisationId;
    checkpoint: HarnessCheckpointRecord;
  }): Promise<Result<ArrayBuffer, CanonicalHarnessCheckpointRestoreError>>;
  readHistory(
    sessionId: string,
    organisationId: OrganisationId,
    throughSequence?: number,
  ): Promise<Result<HarnessHistoryMaterialization, HarnessAuthorityError>>;
  readUsage(
    sessionId: string,
    organisationId: OrganisationId,
  ): Result<HarnessHistoryUsage, HarnessAuthorityError>;
}): Promise<
  Result<
    EmbeddedHarnessSource,
    CanonicalHarnessCheckpointRestoreError | HarnessAuthorityError
  >
> {
  const restoreStartedAt = Date.now();
  const retainedUsage = input.readUsage(
    input.sessionId,
    input.requestingOrganisationId,
  );
  if (!retainedUsage.ok) return retainedUsage;
  if (input.source.kind === "fresh") {
    const materialization = await input.readHistory(
      input.sessionId,
      input.requestingOrganisationId,
    );
    if (!materialization.ok) return materialization;
    traceHarnessRestoreMetrics(
      input,
      "fresh",
      retainedUsage.value,
      materialization.value,
      restoreStartedAt,
    );
    const history = projectMaterializedHarnessHistory(
      materialization.value,
      input.turn.turnId,
    );
    if (!history.ok) return history;
    if (history.value.entries.length === 0)
      return { ok: true, value: { kind: "fresh" } };
    return endsOnAnswer(history.value)
      ? freshLineageSource(history.value)
      : recoverFreshHarnessHistory({
          history: history.value,
          acceptedInput: input.acceptedInput,
          turn: input.turn,
        });
  }
  if (input.source.kind === "resume_turn") {
    const materialization = await input.readHistory(
      input.sessionId,
      input.requestingOrganisationId,
    );
    if (!materialization.ok) return materialization;
    const history = projectMaterializedHarnessHistory(
      materialization.value,
      input.turn.turnId,
    );
    if (!history.ok) return history;
    if (history.value.cursor === null)
      return { ok: false, error: { code: "harness_history_lineage_conflict" } };
    return {
      ok: true,
      value: {
        kind: "resume_turn",
        historyCursor: history.value.cursor,
        history: history.value,
      },
    };
  }
  if (input.source.kind === "fresh_lineage") {
    const materialization = await input.readHistory(
      input.sessionId,
      input.requestingOrganisationId,
    );
    if (!materialization.ok) return materialization;
    traceHarnessRestoreMetrics(
      input,
      "fresh_lineage",
      retainedUsage.value,
      materialization.value,
      restoreStartedAt,
    );
    const history = projectMaterializedHarnessHistory(
      materialization.value,
      input.turn.turnId,
    );
    if (!history.ok) return history;
    return freshLineageSource(history.value);
  }
  // A turn that failed after the checkpoint left its history and a failure
  // note, but no checkpoint: the turn rebuilds its context from the whole
  // history, so the model sees the failed request.
  if (
    retainedUsage.value.entryCount >
    input.source.checkpoint.historyCursor.lastSequence
  ) {
    const materialization = await input.readHistory(
      input.sessionId,
      input.requestingOrganisationId,
    );
    if (!materialization.ok) return materialization;
    const history = projectMaterializedHarnessHistory(
      materialization.value,
      input.turn.turnId,
    );
    if (!history.ok) return history;
    if (endsOnAnswer(history.value)) return freshLineageSource(history.value);
  }
  const [checkpoint, materialization] = await Promise.all([
    input.restoreCheckpoint({
      requestingOrganisationId: input.requestingOrganisationId,
      checkpoint: input.source.checkpoint,
    }),
    input.readHistory(
      input.source.checkpoint.session.sessionId,
      input.requestingOrganisationId,
      input.source.checkpoint.historyCursor.lastSequence,
    ),
  ]);
  if (!checkpoint.ok) return checkpoint;
  if (!materialization.ok) return materialization;
  traceHarnessRestoreMetrics(
    input,
    "checkpoint",
    retainedUsage.value,
    materialization.value,
    restoreStartedAt,
  );
  const history = projectMaterializedHarnessHistory(
    materialization.value,
    input.turn.turnId,
  );
  if (!history.ok) return history;
  if (
    history.value.cursor?.lastSequence !==
      input.source.checkpoint.historyCursor.lastSequence ||
    history.value.cursor.lastEntryDigest !==
      input.source.checkpoint.historyCursor.lastEntryDigest
  ) {
    return { ok: false, error: { code: "harness_history_cursor_mismatch" } };
  }
  const originalHistory = materializedHarnessHistory(materialization.value);
  if (!originalHistory.ok) return originalHistory;
  if (
    hasSupersededProjectContext(
      originalHistory.value.entries,
      input.turn.turnId,
    )
  )
    return freshLineageSource(history.value);
  return {
    ok: true,
    value: {
      kind: "restore",
      checkpoint: checkpoint.value,
      historyCursor: input.source.checkpoint.historyCursor,
      history: history.value,
    },
  };
}

/** A turn refused before it reads its fork history never consults that read. */
export function ignoreUnusedForkHistory(): void {}

/** A turn refused before it admits its side Case never consults that read. */
export function ignoreUnusedSideCaseOrigin(): void {}

/**
 * The side Case that a Slack thread started (Plan 74). Slack gives its rules.
 */
export interface SlackThreadSideCase {
  /**
   * Stores the agent's proposal of a side Case and posts it in the thread
   * with its Start button.
   */
  propose(
    input: SessionToolContext,
    authority: Variant<
      HarnessTurnLease["requestAuthority"],
      "direct_conversation" | "shared_conversation"
    >,
    request: HarnessSideCaseProposalRequest,
  ): Promise<HarnessSideCaseProposalResult>;
}

/**
 * The harness instructions of a turn of a side Case: the Case's own, and the
 * side Case instruction of its kind (Plan 74). A Slack thread keeps one
 * Session over its turns, so each turn and the binding that its start pins
 * get the same text, and the instruction digest of the checkpoint holds.
 */
export function sideCaseHarnessInstructions(
  instructions: string,
  sideCase: SessionSideCase | null,
): string {
  return sideCase === null
    ? instructions
    : `${instructions}\n\n${sideCase.instruction}`;
}

/**
 * The origin-selected tools of a turn that starts: a permission request, and
 * a side Case proposal on a Portal chat step. Both read the Session's chat
 * binding once.
 */
export async function turnToolSelection(
  mayRequestPermission: SessionToolWiring["mayRequestPermission"],
  input: Parameters<SessionToolWiring["mayRequestPermission"]>[0],
): Promise<{ permissionRequest: boolean; sideCaseProposal: boolean }> {
  const permissionRequest = await mayRequestPermission(input);
  return {
    permissionRequest,
    sideCaseProposal: turnMayProposeSideCase(
      input.authority,
      input.turnId,
      permissionRequest,
    ),
  };
}

/** A fence read that a refused start never consults. */
export function ignoreUnusedStartFence(): void {}

/** The owner of a goal execution awaits its close and reports its failure. */
export function ignoreGoalClose(): void {}

export function fenceWithoutReceiptCheck(active: boolean): {
  readonly active: boolean;
  readonly check: null;
} {
  return { active, check: null };
}

export function checkpointPublicationFailure(
  error: unknown,
): Result<null, CheckpointPublicationError> {
  return {
    ok: false,
    error: { code: "checkpoint_write_failed", detail: errorMessage(error) },
  };
}

export function materializedHarnessHistory(
  materialization: HarnessHistoryMaterialization,
): Result<HarnessHistoryRead, HarnessAuthorityError> {
  switch (materialization.kind) {
    case "empty":
    case "bounded_history":
      return { ok: true, value: materialization.history };
    case "history_materialization_limit":
      return {
        ok: false,
        error: {
          code: "harness_history_materialization_limit",
          requiredBytes: materialization.requiredBytes,
          allowedBytes: materialization.allowedBytes,
        },
      };
    default:
      return assertNever(materialization);
  }
}

export function canonicalTextTurnWorkspaceReceipt(
  state: Variant<AgentSessionLifecycle, "sleeping" | "processing">,
  runtime: CanonicalEmbeddedHarnessRuntimeSource,
): Result<
  WorkspaceRevisionReceipt,
  { code: "canonical_text_turn_checkpoint_binding_invalid" }
> {
  const resumePoint = state.state.resumePoint;
  if (runtime.kind === "resume_turn")
    return {
      ok: true,
      value:
        resumePoint.kind === "new"
          ? resumePoint.workspaceRevisionReceipt
          : resumePoint.checkpoint.workspaceRevisionReceipt,
    };
  if (runtime.kind === "fresh" || runtime.kind === "fresh_lineage") {
    return resumePoint.kind === "new"
      ? { ok: true, value: resumePoint.workspaceRevisionReceipt }
      : runtime.kind === "fresh_lineage"
        ? { ok: true, value: resumePoint.checkpoint.workspaceRevisionReceipt }
        : {
            ok: false,
            error: { code: "canonical_text_turn_checkpoint_binding_invalid" },
          };
  }
  if (resumePoint.kind !== "checkpoint") {
    return {
      ok: false,
      error: { code: "canonical_text_turn_checkpoint_binding_invalid" },
    };
  }
  const checkpoint = runtime.checkpoint;
  const resume = resumePoint.checkpoint;
  const valid =
    JSON.stringify(checkpoint.session) ===
      JSON.stringify(state.state.identity) &&
    checkpoint.blob.sha256 === resume.stateDigest &&
    checkpoint.runtimeRevision === resume.runtimeRevision &&
    checkpoint.runtimeLease.generation === resume.runtimeGeneration &&
    checkpoint.policyVersion === resume.policyVersion &&
    checkpoint.lastActorEventSequence + 1 === resume.lastEventSequence &&
    checkpoint.workspaceRevision === resume.workspaceRevisionReceipt.revision;
  return valid
    ? { ok: true, value: resume.workspaceRevisionReceipt }
    : {
        ok: false,
        error: { code: "canonical_text_turn_checkpoint_binding_invalid" },
      };
}

export async function canonicalEmbeddedHarnessRuntimeSource(
  sql: SqlStorage,
  state: Variant<AgentSessionLifecycle, "sleeping">,
  adapter: EmbeddedHarnessAdapter,
): Promise<
  Result<CanonicalEmbeddedHarnessRuntimeSource, HarnessAuthorityError>
> {
  if (state.state.resumePoint.kind === "new") {
    return { ok: true, value: { kind: "fresh" } };
  }
  const checkpoint = readLatestHarnessCheckpoint(
    sql,
    state.state.identity.sessionId,
  );
  if (!checkpoint.ok) return checkpoint;
  const modelRouteDigest = await digestModelRoute(
    state.state.contract.modelRoute,
  );
  const classification = classifyHarnessCheckpoint({
    checkpoint: checkpoint.value,
    backendId: adapter.manifest.backendId,
    harnessBuild: adapter.manifest.harnessBuild,
    checkpointFormat: adapter.manifest.checkpointFormat,
    modelRouteDigest,
  });
  return classification.kind === "compatible"
    ? {
        ok: true,
        value: { kind: "restore", checkpoint: classification.checkpoint },
      }
    : {
        ok: true,
        value: { kind: "fresh_lineage", reason: classification.reason },
      };
}

export function textTurnHarnessCheckpointInput(input: {
  state: Variant<AgentSessionLifecycle, "processing">;
  binding: CanonicalEmbeddedHarnessCheckpointBinding;
  manifest: EmbeddedHarnessAdapter["manifest"];
  lease: HarnessTurnLease;
  cursor: AcceptedHarnessEventCursor;
  historyCursor: import("@purin-labs/contracts").HarnessHistoryCursor;
  checkpoint: ArrayBuffer;
  budgetAccount: SessionBudgetAccount;
  budgetAccountDigest: string;
  workspaceRevisionReceipt: WorkspaceRevisionReceipt;
  createdAt: number;
}): CanonicalHarnessCheckpointInput {
  return {
    leaseId: input.lease.leaseId,
    backendId: input.manifest.backendId,
    session: input.state.state.identity,
    cursor: {
      kind: "accepted",
      turn: input.cursor.turn,
      lastSequence: input.cursor.lastSequence,
      lastEventDigest: input.cursor.lastEventDigest,
    },
    historyCursor: input.historyCursor,
    runtimeLease: input.state.state.runtimeLease,
    runtimeRevision: input.state.state.contract.runtimeRevision,
    policyVersion: input.state.state.contract.policyVersion,
    budgetRevision: input.budgetAccount.budget.budgetRevision,
    budgetUsage: input.budgetAccount.usage,
    usageCursor: input.budgetAccount.usageCursor,
    budgetAccountDigest: input.budgetAccountDigest,
    lastActorEventSequence: input.state.state.contract.lastEventSequence,
    workspaceBaseRevision: input.workspaceRevisionReceipt.revision,
    workspaceRevision: input.workspaceRevisionReceipt.revision,
    instructionDigest: input.binding.instructionDigest,
    toolCatalogDigest: input.binding.toolCatalogDigest,
    modelRouteDigest: input.binding.modelRouteDigest,
    formatVersion: input.manifest.checkpointFormat,
    harnessBuild: input.manifest.harnessBuild,
    checkpoint: input.checkpoint,
    createdAt: input.createdAt,
  };
}
