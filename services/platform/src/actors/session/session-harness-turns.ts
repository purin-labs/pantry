import { readAcceptedCheckpointFinalization } from "../agent-session-finalization";
import { executeCostsViewForHarness } from "../../agent-tools/costs/view-handler";
import { collaborationAgentLabel } from "../collaboration-agent";
import {
  acceptedExecutionAccountAuthority,
  accountAccessOfOneRead,
} from "../../account-platform/access";
import {
  admitPantryExecutionBilling,
  markPantryExecutionDispatched,
  readPantryExecutionAdmissionBinding,
  reconcilePantryExecutionBilling,
  retainPantryExecutionUncertainty,
} from "../../account-platform/execution-billing";
import { armAlarmBy } from "../lifecycle/actor-alarm";
import {
  proposeCommerceActionForHarness,
  proposeCafeMenuPublicationForHarness,
  proposeMenuPriceForHarness,
  proposeOrderRefundForHarness,
  proposeStockActionForHarness,
  proposeMerchantPluginForHarness,
} from "../harness-commerce-proposal";
import {
  createSessionGoalExecution,
  findServedGoalCase,
  StartedGoalExecution,
  type GoalExecution,
} from "../session-goal-usage";
import { authorizeChatHarnessLease } from "../../chat/turn-access";
import { decideChatFlowDelivery } from "../../chat/information-flow";
import {
  readChatForkHistoryForCase,
  admitChatForkInformationFlow,
  authorizeForkHistoryAccess,
} from "../../chat/forks";
import {
  admitSideCaseInformationFlow,
  authorizeSideCaseAccess,
} from "../../chat/side-cases";
import { readSideCaseOrigin } from "../../chat/side-case-origin";
import { admitSlackSideCaseInformationFlow } from "../../slack/side-cases";
import {
  writeHarnessTurnContinuation,
  finishHarnessTurnContinuation,
} from "../agent-session-continuation";
import { embeddedHarnessCostsTools } from "../agent-session-costs";
import {
  proposeMemoryForHarness,
  turnMayProposeMemory,
} from "../harness-memory-proposal";
import {
  proposeSideCaseForHarness,
  turnMayProposeSideCase,
} from "../harness-side-case-proposal";
import {
  requestPermissionForHarness,
  scheduleFollowUpForHarness,
  turnMayRequestPermission,
  turnMayScheduleFollowUp,
} from "../harness-follow-up";
import type { BakeryBrowserContext } from "@seams/bakery-model/bakery-context";
import type { BakerySurfaceAttachmentV1 } from "@seams/bakery-model/bakery-surface";
import type { HarnessTurnLease } from "@seams/contracts";
import { parseSessionId, type RequestId, type OrganisationId } from "../../ids";
import { traceLog, traceWarn } from "../../observability";
import { verifyWorkspaceRevisionReceipt } from "../../workspace-revision-store";
import type { Result } from "../../result";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
  reusableWorkspaceReceiptCheck,
  type FencedWorkspaceReceiptCheck,
  admittedSessionModelRoute,
  admittedSessionToolHost,
  admittedSessionOperation,
} from "../session-execution-admission";
import { readCanonicalSessionForPersistence } from "../agent-session-canonical";
import {
  commitCancellationResolvedSession,
  commitCancellationStartedSession,
  readCaseSessionAssignment,
} from "../actor-journal/transactions";
import {
  commitStartedSession,
  readAcceptedSessionInput,
  readSessionTurnModelContext,
  restoreSessionTurnContext,
  type ActorTransitionCommitResult,
  type CancellationStartedSessionCommit,
  type CheckpointingStartedSessionCommit,
} from "../actor-journal";
import {
  preflightHarnessTurnLease,
  readHarnessHistory,
  readHarnessHistoryUsage,
  hasUnpublishedHarnessCheckpoint,
  type HarnessCheckpointCommit,
} from "../agent-session-harness-authority";
import {
  readCheckpointPayloadForRestore,
  prepareHarnessCheckpoint,
  validateCheckpointBudgetBinding,
  type CanonicalHarnessCheckpointInput,
} from "../agent-session-harness-checkpoint";
import { ActiveAttachmentPreparationControl } from "../message-attachment-preparation";
import {
  createAttachmentInspectionTool,
  createMessageLinkTool,
} from "../message-tools";
import { createCatalogHarnessToolHost } from "../embedded-harness-tool-host";
import type {
  EmbeddedHarnessAdapter,
  EmbeddedHarnessUserInput,
} from "../embedded-harness";
import { selectEmbeddedHarnessAdapterForModelRoute } from "../embedded-harness-adapter";
import type { CanonicalEmbeddedHarnessInput } from "../canonical-embedded-harness-input";
import {
  buildTextTurnCancellationResolvedCommit,
  buildTextTurnCancellationStartedCommit,
  buildTextTurnCheckpointingCommit,
  type CanonicalTextTurnCompletionIdentity,
} from "../agent-session-text-turn";
import { parseStoredAttachmentList } from "../../messages/stored-attachment";
import {
  readSessionBudgetAccount,
  reserveRunBudget,
  RUN_TIME_STOP_GRACE_MS,
  canonicalRunBudgetIdentity,
  sessionBudgetAccountDigest,
  settleControlledRunCancellation,
} from "../agent-session-budget";
import {
  authorizeCapabilityUse,
  authorizeCapabilityUseWithAuthority,
  type CapabilityAuthorizationRequest,
  CONTEXT_CASE_READ_CAPABILITY,
} from "../../authorization/access-grants/turn-authority";
import type { ModelRoute } from "@seams/contracts";
import { failSessionTurnStream } from "../agent-session-turn-stream";
import {
  buildCanonicalTextTurnStart,
  withNextRuntimeGeneration,
} from "../agent-session-turn-start";
import {
  decideCaseConversationSink,
  sinkRefusalAsksPerson,
} from "../case-conversation-sink";
import {
  prepareSessionInformationFlow,
  readSessionInformationFlow,
  readSessionTurnFlowBinding as readPersistedSessionTurnFlowBinding,
} from "../agent-session-information-flow";
import { sha256Hex } from "@seams/std";
import {
  announceSurfaceEffect,
  executeBakerySurfaceForHarness,
  readSavedBakeryRunForHarness,
} from "../../agent-tools/bakery/handlers";
import {
  editEmailReplyDraftForEmbeddedHarness,
  editProductionPlanForEmbeddedHarness,
  proposeEmailOperationalForEmbeddedHarness,
  proposeEmailReplyForEmbeddedHarness,
  proposeSlackMessageForEmbeddedHarness,
  readEmailReplyDraftForEmbeddedHarness,
  readProductionPlanForEmbeddedHarness,
  readWhatsAppSupportForEmbeddedHarness,
  searchEmailMailboxForEmbeddedHarness,
  sendWhatsAppSupportReplyForEmbeddedHarness,
} from "../../agent-tools/channels/handlers";
import {
  advanceOrderQueueForEmbeddedHarness,
  markSoldOutForEmbeddedHarness,
  readEntityContextForEmbeddedHarness,
  readMerchantReportForEmbeddedHarness,
  readOrderQueueForEmbeddedHarness,
  readPaymentsForEmbeddedHarness,
  readSoldOutForEmbeddedHarness,
} from "../../agent-tools/commerce/handlers";
import {
  pauseDeviceForEmbeddedHarness,
  readDeviceSnapshotsForEmbeddedHarness,
  readDevicesForEmbeddedHarness,
} from "../../agent-tools/devices/handlers";
import { readJevFeaturesForEmbeddedHarness } from "../../agent-tools/jev/handlers";
import {
  editEmailDraftForEmbeddedHarness,
  editMenuBoardForEmbeddedHarness,
  createMenuBoardForEmbeddedHarness,
  archiveMenuBoardForEmbeddedHarness,
  editMenuDraftForEmbeddedHarness,
  editProductDescriptionDraftForEmbeddedHarness,
  moveWorkflowCanvasForEmbeddedHarness,
  readEmailDraftForEmbeddedHarness,
  readMenuBoardsForEmbeddedHarness,
  readMenuDraftForEmbeddedHarness,
  readProductDescriptionDraftForEmbeddedHarness,
  readWorkflowCanvasForEmbeddedHarness,
} from "../../agent-tools/drafts/handlers";
import {
  queryWorkspaceForEmbeddedHarness,
  readFileForEmbeddedHarness,
  searchFilesForEmbeddedHarness,
} from "../../agent-tools/files/handlers";
import {
  listIntegrationsForEmbeddedHarness,
  readAirtableForHarness,
  readCustomConnectorForEmbeddedHarness,
  writeAirtableForHarness,
} from "../../agent-tools/integrations/handlers";
import {
  createSupplierForEmbeddedHarness,
  readRecipeWorkflowForEmbeddedHarness,
  readRecipesForEmbeddedHarness,
  readSuppliersForEmbeddedHarness,
  saveRecipeForEmbeddedHarness,
} from "../../agent-tools/kitchen/handlers";
import { withToolContext } from "../../agent-tools/context";
import {
  createMenuBoardDraftPreview,
  withSettledToolArguments,
} from "../../agent-tools/drafts/board-draft-preview";
import {
  materializeAcceptedAttachment,
  materializeEmbeddedHarnessUserInput,
  readPreparedInspection,
  readSessionTurnAttachments,
  validateAcceptedTurnContext,
} from "./attachments";
import {
  authorizeCanonicalRunSources,
  claimCanonicalRunCapability,
} from "./capability-claims";
import {
  type AcceptedCustomConnectorCatalog,
  canonicalEmbeddedHarnessRuntimeSource,
  canonicalTextTurnWorkspaceReceipt,
  fenceWithoutReceiptCheck,
  ignoreGoalClose,
  ignoreUnusedForkHistory,
  ignoreUnusedSideCaseOrigin,
  ignoreUnusedStartFence,
  materializeEmbeddedHarnessSource,
  normalizeBakerySurfaceContext,
  resolveAcceptedCustomConnectorCatalog,
  resolveCanonicalEmbeddedHarnessCheckpointBinding,
  sideCaseHarnessInstructions,
  textTurnHarnessCheckpointInput,
  turnToolSelection,
} from "./harness-source";
import { projectWorkingHistory, requirePiHarnessLease } from "./model-context";
import {
  admittedMessageLinkEgress,
  createEmbeddedHarnessModelRouteLease,
  monotonicNanoseconds,
  recordMessageAttachmentObservation,
} from "./model-route";
import {
  acceptCanonicalRunModelUsage,
  combinedHarnessUsage,
  failCanonicalRunBudget,
  projectCurrentHarnessHistoryBudgetWarning,
  reconcileCanonicalRunBudgetDeadline,
  reconcileSleepingSessionRunBudget,
  settleCanonicalRunBudget,
} from "./run-budget";
import {
  type CanonicalTextTurnInput,
  destroyWorkspaceExecutor,
  failFrozenCanonicalPreparation,
} from "./support";
import {
  measureSessionHarnessPreparation,
  traceSessionHarnessPreparation,
  traceSessionTurnCompletion,
  traceTurnCompletionRefused,
} from "./traces";
import { authorizedBakerySurfaceCommands } from "./transient-turns";
import {
  commitCheckpointAndAlarm,
  completeEmbeddedHarnessTurnWithinBudget,
  embeddedHarnessFailureDetail,
} from "./turn-completion";
import type {
  CanonicalEmbeddedHarnessCancellationError,
  CanonicalEmbeddedHarnessInputError,
  CanonicalEmbeddedHarnessRunError,
  CanonicalEmbeddedHarnessRuntimeSource,
  CanonicalEmbeddedHarnessTextTurnError,
  CanonicalEmbeddedHarnessTextTurnResult,
  CanonicalEmbeddedHarnessTurnResult,
  CanonicalHarnessCheckpointCommitError,
} from "./types";
import { SessionCheckpoints } from "./session-checkpoints";

/**
 * Canonical embedded harness turns: input, preparation, the run with its tools, and the checkpoint commit.
 */
export abstract class SessionHarnessTurns extends SessionCheckpoints {
  protected selectEmbeddedHarnessAdapter(
    modelRoute: ModelRoute,
  ): EmbeddedHarnessAdapter {
    return selectEmbeddedHarnessAdapterForModelRoute(modelRoute);
  }

  async cancelCanonicalEmbeddedHarnessTurn(
    input: CancellationStartedSessionCommit,
  ): Promise<
    Result<
      ActorTransitionCommitResult,
      CanonicalEmbeddedHarnessCancellationError
    >
  > {
    const committed = commitCancellationStartedSession(this.ctx.storage, input);
    if (!committed.ok) return committed;
    const preparation = this.activeMessagePreparation;
    if (
      input.harnessLease !== undefined &&
      preparation !== null &&
      preparation.leaseId === input.harnessLease.leaseId
    ) {
      await preparation.cancel();
      const budget = this.ctx.storage.transactionSync(
        settleControlledRunCancellation.bind(null, this.ctx.storage.sql, {
          ...canonicalRunBudgetIdentity(input.harnessLease),
          now: Date.now(),
        }),
      );
      if (!budget.ok) return budget;
    }
    const active = this.activeEmbeddedHarnessTurn;
    if (
      input.harnessLease !== undefined &&
      active !== null &&
      active.leaseId === input.harnessLease.leaseId
    ) {
      const cancelled = await active.turn.cancel();
      if (!cancelled.ok) return cancelled;
    }
    const current = await readCanonicalSessionForPersistence(
      this.persistence,
      this.ctx.storage.sql,
      input.event.organisationId,
    );
    if (!current.ok || current.value.lifecycle.kind !== "cancelling") {
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "lifecycle_not_cancelling",
        },
      };
    }
    const resolved = buildTextTurnCancellationResolvedCommit({
      current: current.value.lifecycle,
      cancellation: {
        cancellationId: input.commandId,
        correlationId: input.event.correlationId,
        acceptedAt: input.event.acceptedAt,
      },
    });
    if (!resolved.ok) return resolved;
    const ended = commitCancellationResolvedSession(
      this.ctx.storage,
      resolved.value,
    );
    if (ended.ok)
      this.ctx.waitUntil(
        reconcilePantryExecutionBilling({
          env: this.env,
          storage: this.ctx.storage,
        }),
      );
    if (ended.ok) await this.releaseEndedExecutions();
    return ended;
  }

  async commitCanonicalHarnessCheckpoint(
    input: CanonicalHarnessCheckpointInput,
    transition: CheckpointingStartedSessionCommit,
  ): Promise<
    Result<HarnessCheckpointCommit, CanonicalHarnessCheckpointCommitError>
  > {
    const account = readSessionBudgetAccount(this.ctx.storage.sql, {
      organisationId: input.session.organisationId,
      sessionId: input.session.sessionId,
    });
    if (!account.ok) return account;
    if (
      account.value.kind !== "open" ||
      account.value.reservation.kind !== "none"
    ) {
      return account.value.kind === "exhausted"
        ? {
            ok: false,
            error: {
              code: "budget_exhausted",
              exhaustion: account.value.exhaustion,
            },
          }
        : { ok: false, error: { code: "budget_reservation_conflict" } };
    }
    const binding = await validateCheckpointBudgetBinding({
      checkpoint: input,
      account: account.value,
    });
    if (!binding.ok) return binding;
    const prepared = await prepareHarnessCheckpoint({
      storage: this.ctx.storage,
      checkpoint: input,
      now: Date.now,
    });
    if (!prepared.ok) return prepared;
    return this.ctx.storage.transaction(
      commitCheckpointAndAlarm.bind(
        null,
        this.ctx.storage,
        prepared.value,
        transition,
      ),
    );
  }

  /**
   * The caller has read the placement fence for this execution, and reads it
   * again after this returns and before the input reaches a model.
   *
   * A caller that resolves the turn's connector catalog in the same call
   * gives it here. The context capability is then decided against the
   * authority of that catalog, with no second read of the grants.
   * This input read can reuse the catalog's account answer. Execution checks
   * around billing still use the scope's live account access.
   */
  protected async readCanonicalEmbeddedHarnessInput(input: {
    execution: SessionExecutionAdmission;
    requestingOrganisationId: OrganisationId;
    lease: HarnessTurnLease;
    turnPrompt: string;
    resolvedCatalog: Promise<
      Result<AcceptedCustomConnectorCatalog, unknown>
    > | null;
  }): Promise<
    Result<CanonicalEmbeddedHarnessInput, CanonicalEmbeddedHarnessInputError>
  > {
    const execution = input.execution;
    if (execution.scope.organisationId !== input.requestingOrganisationId)
      return { ok: false, error: { code: "invalid_persisted_state" } };
    if (
      !(await authorizeChatHarnessLease(
        this.env.DB,
        execution.scope.database,
        input.requestingOrganisationId,
        input.lease,
        accountAccessOfOneRead(execution.scope.accountAccess),
      ))
    )
      return { ok: false, error: { code: "invalid_persisted_state" } };
    const startedAt = Date.now();
    const initial = await readCanonicalSessionForPersistence(
      this.persistence,
      this.ctx.storage.sql,
      input.requestingOrganisationId,
    );
    if (!initial.ok) return initial;
    if (initial.value.lifecycle.kind !== "processing") {
      return { ok: false, error: { code: "invalid_persisted_state" } };
    }
    const authorized = preflightHarnessTurnLease(
      this.ctx.storage,
      input.lease,
      startedAt,
    );
    if (!authorized.ok) return authorized;
    const turn = initial.value.lifecycle.state.activeTurn.state.identity;
    const accepted = readAcceptedSessionInput(this.ctx.storage.sql, {
      organisationId: initial.value.lifecycle.state.identity.organisationId,
      sessionId: initial.value.lifecycle.state.identity.sessionId,
      streamId: initial.value.lifecycle.state.identity.streamId,
      turnId: turn.turnId,
      inputId: turn.inputId,
    });
    if (!accepted.ok) return accepted;
    if (accepted.value.kind !== "case") {
      return {
        ok: false,
        error: { code: "embedded_harness_input_identity_invalid" },
      };
    }
    const assignment = readCaseSessionAssignment(this.ctx.storage.sql);
    const workspaceRevision =
      initial.value.lifecycle.state.resumePoint.kind === "new"
        ? initial.value.lifecycle.state.resumePoint.workspaceRevisionReceipt
            .revision
        : initial.value.lifecycle.state.resumePoint.checkpoint
            .workspaceRevisionReceipt.revision;
    const digest = await sha256Hex(input.turnPrompt);
    if (
      assignment === null ||
      assignment.caseId !== accepted.value.caseId ||
      assignment.assignmentId !== accepted.value.assignmentId ||
      assignment.caseRevision !== accepted.value.caseRevision ||
      assignment.sessionId !==
        initial.value.lifecycle.state.identity.sessionId ||
      accepted.value.contentDigest !== digest ||
      accepted.value.workspaceRevision !== workspaceRevision
    ) {
      return { ok: false, error: { code: "invalid_persisted_state" } };
    }
    const context = await readSessionTurnModelContext(this.ctx.storage.sql, {
      turnId: turn.turnId,
      organisationId: initial.value.lifecycle.state.identity.organisationId,
      sessionId: initial.value.lifecycle.state.identity.sessionId,
    });
    if (!context.ok) {
      return context;
    }
    const validContext = await validateAcceptedTurnContext({
      acceptedInput: accepted.value,
      assignment,
      lease: input.lease,
      context: context.value,
    });
    if (!validContext) {
      return { ok: false, error: { code: "invalid_persisted_state" } };
    }
    const informationFlow = await readSessionInformationFlow(
      this.ctx.storage.sql,
      {
        organisationId: initial.value.lifecycle.state.identity.organisationId,
        sessionId: initial.value.lifecycle.state.identity.sessionId,
      },
    );
    if (
      !informationFlow.ok ||
      informationFlow.value === null ||
      informationFlow.value.context.authorityPartitionDigest !==
        input.lease.authorityPartitionDigest
    ) {
      return { ok: false, error: { code: "invalid_persisted_state" } };
    }
    const contextRead: CapabilityAuthorizationRequest = {
      capabilities: [
        {
          kind: "platform_capability",
          capabilityId: CONTEXT_CASE_READ_CAPABILITY,
          capabilityVersion: 1,
        },
      ],
    };
    const resolvedCatalog = await input.resolvedCatalog;
    if (resolvedCatalog !== null && !resolvedCatalog.ok)
      return { ok: false, error: { code: "invalid_persisted_state" } };
    const liveContextAuthority =
      resolvedCatalog === null
        ? await authorizeCapabilityUse({
            db: execution.scope.database,
            accountAccess: execution.scope.accountAccess,
            userAuthority: acceptedExecutionAccountAuthority(
              input.lease.session.sessionId,
              input.lease.turn.turnId,
            ),
            action: "execute",
            organisationId: input.requestingOrganisationId,
            authority: input.lease.requestAuthority,
            authorityPartition: assignment.authorityPartition,
            request: contextRead,
          })
        : authorizeCapabilityUseWithAuthority(
            resolvedCatalog.value.authority,
            contextRead,
          );
    if (!liveContextAuthority.ok) {
      return { ok: false, error: { code: "invalid_persisted_state" } };
    }
    const attachments = readSessionTurnAttachments(this.ctx.storage.sql, {
      turnId: turn.turnId,
      organisationId: initial.value.lifecycle.state.identity.organisationId,
      sessionId: initial.value.lifecycle.state.identity.sessionId,
    });
    if (attachments === null)
      return { ok: false, error: { code: "invalid_persisted_state" } };
    return {
      ok: true,
      value: {
        turnId: turn.turnId,
        inputId: turn.inputId,
        instruction: input.turnPrompt,
        attachments: attachments.attachments,
        links: attachments.links,
        acceptedInput: accepted.value,
        contextBundle: context.value.bundle,
        contextBundleDigest: context.value.bundleDigest,
        modelContext: context.value.modelContext,
        projectContext: context.value.projectContext,
      },
    };
  }

  /**
   * The caller has verified the workspace receipt under the placement fence
   * and started the fork history read. Everything read here is released only
   * after the fence is read again before the turn starts.
   */
  protected async runCanonicalEmbeddedHarnessTurn(input: {
    execution: SessionExecutionAdmission;
    customConnectorCatalog: AcceptedCustomConnectorCatalog | null;
    inheritedHistory: ReturnType<typeof readChatForkHistoryForCase> | null;
    /**
     * The goal execution that the caller started to bind, and that the caller
     * closes. Null when the turn resumes in a later call: this call then
     * binds the execution and closes it.
     */
    goalExecution: StartedGoalExecution | null;
    requestingOrganisationId: OrganisationId;
    requestId: RequestId;
    runtime: CanonicalEmbeddedHarnessRuntimeSource;
    lease: HarnessTurnLease;
    harnessInstructions: string;
    thinkingLevel?: import("../embedded-harness").EmbeddedHarnessThinkingLevel;
    turnPrompt: string;
    browserContext: BakeryBrowserContext;
    surfaceContext: BakerySurfaceAttachmentV1 | null;
  }): Promise<
    Result<CanonicalEmbeddedHarnessTurnResult, CanonicalEmbeddedHarnessRunError>
  > {
    let phaseStartedAt = Date.now();
    const session = await readCanonicalSessionForPersistence(
      this.persistence,
      this.ctx.storage.sql,
      input.requestingOrganisationId,
    );
    traceSessionHarnessPreparation(
      input,
      input.lease.turn.turnId,
      "harness_session",
      phaseStartedAt,
    );
    if (!session.ok) return session;
    if (session.value.lifecycle.kind !== "processing") {
      return {
        ok: false,
        error: { code: "embedded_harness_model_authority_unavailable" },
      };
    }
    const modelRoute = session.value.lifecycle.state.contract.modelRoute;
    const adapter = this.selectEmbeddedHarnessAdapter(modelRoute);
    const assignment = readCaseSessionAssignment(this.ctx.storage.sql);
    if (assignment === null || input.inheritedHistory === null) {
      return {
        ok: false,
        error: { code: "embedded_harness_input_identity_invalid" },
      };
    }
    // A side Case's proposal is read beside its fork history (Plan 74).
    const sideCaseRead = readSideCaseOrigin(
      input.execution.scope,
      String(assignment.caseId),
    );
    void sideCaseRead.catch(ignoreUnusedSideCaseOrigin);
    const inheritedHistory = await input.inheritedHistory;
    if (inheritedHistory.entries.length > 0) {
      if (input.lease.requestAuthority.kind !== "control")
        throw new Error("chat_fork_history_forbidden");
      await authorizeForkHistoryAccess(
        input.execution.scope,
        inheritedHistory,
        input.lease.requestAuthority,
      );
    }
    await admitChatForkInformationFlow(
      input.execution.scope.database,
      input.execution.scope.accountAccess,
      this.ctx.storage,
      input.lease,
      inheritedHistory,
      requireSessionExecution.bind(null, input.execution, input.lease),
    );
    const sideCaseOrigin = await sideCaseRead;
    if (sideCaseOrigin?.kind === "slack_thread")
      await admitSlackSideCaseInformationFlow(
        this.ctx.storage,
        input.lease,
        sideCaseOrigin.proposal,
        requireSessionExecution.bind(null, input.execution, input.lease),
        this.env,
      );
    if (sideCaseOrigin?.kind === "portal_chat") {
      if (input.lease.requestAuthority.kind !== "control")
        throw new Error("side_case_forbidden");
      await authorizeSideCaseAccess(
        input.execution.scope,
        sideCaseOrigin.proposal,
        input.lease.requestAuthority,
      );
      await admitSideCaseInformationFlow(
        input.execution.scope.database,
        input.execution.scope.accountAccess,
        this.ctx.storage,
        input.lease,
        sideCaseOrigin.proposal,
        requireSessionExecution.bind(null, input.execution, input.lease),
      );
    }
    const currentFlow = await readPersistedSessionTurnFlowBinding(
      this.ctx.storage.sql,
      {
        organisationId: input.requestingOrganisationId,
        sessionId: input.lease.session.sessionId,
        turnId: input.lease.turn.turnId,
      },
    );
    if (
      !currentFlow.ok ||
      currentFlow.value === null ||
      currentFlow.value.authorityPartitionDigest !==
        input.lease.authorityPartitionDigest
    ) {
      return {
        ok: false,
        error: { code: "embedded_harness_information_flow_unavailable" },
      };
    }
    if (input.lease.requestAuthority.kind === "control") {
      const admission = await decideChatFlowDelivery(
        input.execution.scope.database,
        input.execution.scope.accountAccess,
        currentFlow.value.binding,
        input.lease.requestAuthority,
      );
      if (admission.kind !== "allow") {
        return {
          ok: false,
          error: { code: "embedded_harness_information_flow_unavailable" },
        };
      }
    }
    const forkInstructions =
      inheritedHistory.entries.length === 0
        ? input.harnessInstructions
        : `${input.harnessInstructions}\n\nThis chat is a fork. Earlier messages and settled tool results are inherited history. Execute only the newly accepted request. Prior approvals and effects cannot authorize new actions. Shared workspaces have their current state; inspect their current revision before editing.`;
    const harnessInstructions = sideCaseHarnessInstructions(
      forkInstructions,
      sideCaseOrigin,
    );
    const parsedSessionId = parseSessionId(
      session.value.lifecycle.state.identity.sessionId,
    );
    if (!parsedSessionId.ok) {
      return {
        ok: false,
        error: { code: "embedded_harness_input_identity_invalid" },
      };
    }
    const sessionId = parsedSessionId.value;
    // These four read the organisation's records and decide nothing alone.
    // The turn starts only after the fence is read again below.
    const catalogRead =
      input.customConnectorCatalog === null
        ? resolveAcceptedCustomConnectorCatalog({
            scope: input.execution.scope,
            organisationId: input.requestingOrganisationId,
            authority: input.lease.requestAuthority,
            userAuthority: acceptedExecutionAccountAuthority(
              input.lease.session.sessionId,
              input.lease.turn.turnId,
            ),
            assignment,
          })
        : Promise.resolve({
            ok: true as const,
            value: input.customConnectorCatalog,
          });
    const [
      canonicalInput,
      customConnectorCatalog,
      resolvedModelRouteLease,
      servedCase,
    ] = await Promise.all([
      measureSessionHarnessPreparation(
        input,
        "harness_input",
        this.readCanonicalEmbeddedHarnessInput({
          execution: input.execution,
          requestingOrganisationId: input.requestingOrganisationId,
          lease: input.lease,
          turnPrompt: input.turnPrompt,
          resolvedCatalog: catalogRead,
        }),
      ),
      measureSessionHarnessPreparation(
        input,
        "harness_custom_catalog",
        catalogRead,
      ),
      measureSessionHarnessPreparation(
        input,
        "harness_model_route",
        createEmbeddedHarnessModelRouteLease({
          env: this.env,
          scope: input.execution.scope,
          sessionId,
          modelRoute,
        }),
      ),
      input.goalExecution === null
        ? findServedGoalCase(this.env, input.execution.scope, assignment)
        : null,
    ]);
    if (!canonicalInput.ok) return canonicalInput;
    if (!customConnectorCatalog.ok) return customConnectorCatalog;
    if (
      this.activeMessagePreparation !== null ||
      this.activeEmbeddedHarnessTurn !== null
    ) {
      return {
        ok: false,
        error: { code: "embedded_harness_model_authority_unavailable" },
      };
    }
    const messagePreparation = new ActiveAttachmentPreparationControl(
      input.lease.leaseId,
      destroyWorkspaceExecutor.bind(null, this.env),
    );
    this.activeMessagePreparation = messagePreparation;
    let harnessInput: Awaited<
      ReturnType<typeof materializeEmbeddedHarnessUserInput>
    >;
    const inheritedAttachments: Record<
      string,
      readonly EmbeddedHarnessUserInput[]
    > = {};
    phaseStartedAt = Date.now();
    try {
      for (const entry of inheritedHistory.entries) {
        if (entry.kind !== "user_input") continue;
        for (const content of entry.content) {
          if (
            content.kind !== "attachment" ||
            inheritedAttachments[content.attachment.id] !== undefined
          )
            continue;
          const prepared = await materializeAcceptedAttachment({
            execution: input.execution,
            env: this.env,
            archive: this.env.ARCHIVE,
            storage: this.ctx.storage,
            lease: input.lease,
            organisationId: input.requestingOrganisationId,
            attachment: content.attachment,
            executionControl: messagePreparation,
          });
          if (!prepared.ok) return prepared;
          inheritedAttachments[content.attachment.id] = prepared.value.inputs;
        }
      }
      harnessInput = await materializeEmbeddedHarnessUserInput({
        execution: input.execution,
        archive: this.env.ARCHIVE,
        env: this.env,
        storage: this.ctx.storage,
        lease: input.lease,
        organisationId: input.requestingOrganisationId,
        input: canonicalInput.value,
        executionControl: messagePreparation,
      });
    } finally {
      messagePreparation.settle();
      if (this.activeMessagePreparation === messagePreparation) {
        this.activeMessagePreparation = null;
      }
    }
    traceSessionHarnessPreparation(
      input,
      input.lease.turn.turnId,
      "harness_user_input",
      phaseStartedAt,
    );
    if (!harnessInput.ok) return harnessInput;
    phaseStartedAt = Date.now();
    const permissionRequest = await turnMayRequestPermission({
      db: input.execution.scope.database,
      organisationId: String(input.execution.scope.organisationId),
      authority: input.lease.requestAuthority,
      sessionId: String(input.lease.session.sessionId),
      turnId: String(input.lease.turn.turnId),
    });
    const binding = await resolveCanonicalEmbeddedHarnessCheckpointBinding({
      state: session.value.lifecycle,
      runtime: input.runtime,
      harnessInstructions,
      assignment,
      customConnectorOperations: customConnectorCatalog.value.entries,
      bakerySurfaceCommands: authorizedBakerySurfaceCommands(
        input.lease.requestAuthority,
      ),
      memoryProposal: turnMayProposeMemory(input.lease.requestAuthority),
      followUp: turnMayScheduleFollowUp(
        input.lease.requestAuthority,
        String(input.lease.turn.turnId),
      ),
      permissionRequest,
      sideCaseProposal: turnMayProposeSideCase(
        input.lease.requestAuthority,
        String(input.lease.turn.turnId),
        permissionRequest,
      ),
    });
    traceSessionHarnessPreparation(
      input,
      input.lease.turn.turnId,
      "harness_checkpoint_binding",
      phaseStartedAt,
    );
    if (!binding.ok) return binding;
    const budgetIdentity = canonicalRunBudgetIdentity(input.lease);
    const budgetAccount = readSessionBudgetAccount(
      this.ctx.storage.sql,
      budgetIdentity,
    );
    if (!budgetAccount.ok) return budgetAccount;
    if (
      budgetAccount.value.kind !== "open" ||
      budgetAccount.value.reservation.kind !== "active"
    ) {
      return budgetAccount.value.kind === "exhausted"
        ? {
            ok: false,
            error: {
              code: "budget_exhausted",
              exhaustion: budgetAccount.value.exhaustion,
            },
          }
        : { ok: false, error: { code: "budget_reservation_conflict" } };
    }
    phaseStartedAt = Date.now();
    const tool = withToolContext({
      env: this.env,
      storage: this.ctx.storage,
      execution: input.execution,
      lease: input.lease,
      assignment,
    });
    // Plan 40B phase 7: a board edit shows on the board while the model
    // writes it.
    const boardDraftPreview = createMenuBoardDraftPreview({
      env: this.env,
      storage: this.ctx.storage,
      execution: input.execution,
      lease: input.lease,
      assignment,
    });
    const toolHostPreparation = createCatalogHarnessToolHost({
      env: this.env,
      storage: this.ctx.storage,
      organisationId: input.requestingOrganisationId,
      lease: input.lease,
      expectedCatalogDigest: binding.value.binding.toolCatalogDigest,
      capabilityKeys: assignment.authorityPartition.capabilityKeys,
      customConnectorOperations: customConnectorCatalog.value.entries,
      bakerySurfaceCommands: authorizedBakerySurfaceCommands(
        input.lease.requestAuthority,
      ),
      memoryProposal: turnMayProposeMemory(input.lease.requestAuthority),
      followUp: turnMayScheduleFollowUp(
        input.lease.requestAuthority,
        String(input.lease.turn.turnId),
      ),
      permissionRequest,
      sideCaseProposal: turnMayProposeSideCase(
        input.lease.requestAuthority,
        String(input.lease.turn.turnId),
        permissionRequest,
      ),
      readCustomConnector: readCustomConnectorForEmbeddedHarness.bind(
        null,
        this.env,
        this.ctx.storage,
        input.execution,
        input.lease,
        assignment,
        customConnectorCatalog.value.authority.effectiveGrantSet,
      ),
      proposeCustomConnectorWrite:
        this.proposeCustomConnectorWriteForEmbeddedHarness.bind(this, {
          execution: input.execution,
          lease: input.lease,
          assignment,
        }),
      // Both message tools are scoped to this turn's own message, so neither
      // can reach a file or a link from another conversation.
      inspectMessageAttachment: createAttachmentInspectionTool({
        attachments: canonicalInput.value.attachments,
        readPreparation: readPreparedInspection.bind(
          null,
          input.execution,
          this.ctx.storage,
          this.env.ARCHIVE,
          input.lease,
        ),
        recordObservation: recordMessageAttachmentObservation.bind(null, {
          execution: input.execution,
          storage: this.ctx.storage,
          lease: input.lease,
          caseId: assignment.caseId,
        }),
      }),
      readMessageLink: admittedSessionOperation(
        input.execution,
        input.lease,
        createMessageLinkTool({
          links: canonicalInput.value.links,
          egress: admittedMessageLinkEgress(
            input.execution,
            input.lease,
            this.env,
          ),
        }),
      ),
      readAirtable: tool(readAirtableForHarness),
      writeAirtable: tool(writeAirtableForHarness),
      listIntegrations: tool(listIntegrationsForEmbeddedHarness),
      searchEmailMailbox: tool(searchEmailMailboxForEmbeddedHarness),
      proposeEmailReply: tool(proposeEmailReplyForEmbeddedHarness),
      readEmailReplyDraft: tool(readEmailReplyDraftForEmbeddedHarness),
      editEmailReplyDraft: tool(editEmailReplyDraftForEmbeddedHarness),
      readProductionPlan: tool(readProductionPlanForEmbeddedHarness),
      editProductionPlan: tool(editProductionPlanForEmbeddedHarness),
      proposeEmailOperational: tool(proposeEmailOperationalForEmbeddedHarness),
      proposeSlackMessage: tool(proposeSlackMessageForEmbeddedHarness),
      readWhatsAppSupport: tool(readWhatsAppSupportForEmbeddedHarness),
      sendWhatsAppSupportReply: sendWhatsAppSupportReplyForEmbeddedHarness.bind(
        null,
        this.env,
        input.execution,
        input.lease,
        assignment,
        input.turnPrompt,
      ),
      readEntityContext: tool(readEntityContextForEmbeddedHarness),
      readMerchantReport: tool(readMerchantReportForEmbeddedHarness),
      readWorkflowCanvas: tool(readWorkflowCanvasForEmbeddedHarness),
      moveWorkflowCanvasObject: tool(moveWorkflowCanvasForEmbeddedHarness),
      readProductDescriptionDraft: tool(
        readProductDescriptionDraftForEmbeddedHarness,
      ),
      editProductDescriptionDraft: tool(
        editProductDescriptionDraftForEmbeddedHarness,
      ),
      readMenuDraft: tool(readMenuDraftForEmbeddedHarness),
      readEmailDraft: tool(readEmailDraftForEmbeddedHarness),
      editEmailDraft: tool(editEmailDraftForEmbeddedHarness),
      searchFiles: tool(searchFilesForEmbeddedHarness),
      readFile: tool(readFileForEmbeddedHarness),
      readSavedBakeryRun: readSavedBakeryRunForHarness.bind(
        null,
        input.requestId,
        this.env,
        this.ctx.storage,
        input.execution,
        input.lease,
        input.browserContext,
      ),
      queryWorkspace: queryWorkspaceForEmbeddedHarness.bind(
        null,
        this.env,
        this.persistence,
        this.ctx.storage,
        input.execution,
        input.lease,
      ),
      proposeCommerceAction: tool(proposeCommerceActionForHarness),
      editMenuDraft: tool(editMenuDraftForEmbeddedHarness),
      readMenuBoards: tool(readMenuBoardsForEmbeddedHarness),
      editMenuBoard: tool(editMenuBoardForEmbeddedHarness),
      createMenuBoard: tool(createMenuBoardForEmbeddedHarness),
      archiveMenuBoard: tool(archiveMenuBoardForEmbeddedHarness),
      readOrderQueue: tool(readOrderQueueForEmbeddedHarness),
      readPayments: tool(readPaymentsForEmbeddedHarness),
      advanceOrderQueue: tool(advanceOrderQueueForEmbeddedHarness),
      readSoldOut: tool(readSoldOutForEmbeddedHarness),
      readRecipeWorkflow: tool(readRecipeWorkflowForEmbeddedHarness),
      proposeRecipeWorkflow: this.proposeRecipeWorkflowForEmbeddedHarness.bind(
        this,
        {
          execution: input.execution,
          lease: input.lease,
          assignment,
        },
      ),
      readDevices: tool(readDevicesForEmbeddedHarness),
      readDeviceSnapshots: tool(readDeviceSnapshotsForEmbeddedHarness),
      readJevFeatures: tool(readJevFeaturesForEmbeddedHarness),
      proposeJevFeature: this.proposeJevFeatureForEmbeddedHarness.bind(this, {
        execution: input.execution,
        lease: input.lease,
        assignment,
      }),
      pauseDevice: tool(pauseDeviceForEmbeddedHarness),
      proposeDevice: this.proposeDeviceForEmbeddedHarness.bind(this, {
        execution: input.execution,
        lease: input.lease,
        assignment,
      }),
      markSoldOut: tool(markSoldOutForEmbeddedHarness),
      readRecipes: tool(readRecipesForEmbeddedHarness),
      saveRecipe: tool(saveRecipeForEmbeddedHarness),
      ...embeddedHarnessCostsTools(
        this.env,
        this.ctx.storage,
        input.execution,
        input.lease,
        assignment,
      ),
      readSuppliers: tool(readSuppliersForEmbeddedHarness),
      createSupplier: tool(createSupplierForEmbeddedHarness),
      proposeOrderRefund: tool(proposeOrderRefundForHarness),
      proposeStockAction: tool(proposeStockActionForHarness),
      proposeCafeMenuPublication: tool(proposeCafeMenuPublicationForHarness),
      proposeMenuPrice: tool(proposeMenuPriceForHarness),
      proposeMerchantPlugin: tool(proposeMerchantPluginForHarness),
      proposeCampaignBrief: this.proposeCampaignBriefForEmbeddedHarness.bind(
        this,
        {
          execution: input.execution,
          lease: input.lease,
          assignment,
        },
      ),
      proposeConfiguration: this.proposeConfigurationForEmbeddedHarness.bind(
        this,
        {
          execution: input.execution,
          lease: input.lease,
          assignment,
        },
      ),
      executeBakerySurface: executeBakerySurfaceForHarness.bind(null, {
        db: input.execution.scope.database,
        accountAccess: input.execution.scope.accountAccess,
        archive: this.env.ARCHIVE,
        storage: this.ctx.storage,
        organisationId: input.requestingOrganisationId,
        sessionId: session.value.lifecycle.state.identity.sessionId,
        requestId: input.requestId,
        lease: input.lease,
        browserContext: input.browserContext,
        announceEffect: announceSurfaceEffect.bind(
          null,
          input.execution.scope,
          input.lease.requestAuthority,
        ),
        surfaceReadiness: { kind: "unprepared" },
      }),
      executeCostsViewCommand: executeCostsViewForHarness.bind(null, {
        db: input.execution.scope.database,
        accountAccess: input.execution.scope.accountAccess,
        storage: this.ctx.storage,
        organisationId: input.requestingOrganisationId,
        sessionId: session.value.lifecycle.state.identity.sessionId,
        requestId: input.requestId,
        lease: input.lease,
        browserContext: input.browserContext,
        agentLabel: collaborationAgentLabel.bind(
          null,
          input.execution.scope,
          assignment,
        ),
        announceEffect: announceSurfaceEffect.bind(
          null,
          input.execution.scope,
          input.lease.requestAuthority,
        ),
      }),
      proposeMemory: tool(proposeMemoryForHarness),
      scheduleFollowUp: scheduleFollowUpForHarness.bind(null, {
        env: this.env,
        execution: input.execution,
        lease: input.lease,
      }),
      proposeSideCase: tool(proposeSideCaseForHarness),
      requestPermission: requestPermissionForHarness.bind(null, {
        env: this.env,
        execution: input.execution,
        lease: input.lease,
        caseId: String(assignment.caseId),
      }),
      claimCapability: claimCanonicalRunCapability.bind(
        null,
        this.ctx.storage,
        input.execution,
        budgetIdentity,
        input.lease,
      ),
      authorizeSources: authorizeCanonicalRunSources.bind(
        null,
        this.ctx.storage,
        input.execution,
        budgetIdentity,
        input.lease,
      ),
      nowNs: monotonicNanoseconds,
    });
    const sourceStartedAt = Date.now();
    const sourcePreparation = materializeEmbeddedHarnessSource({
      backendId: adapter.manifest.backendId,
      source: binding.value.runtime,
      sessionId,
      requestingOrganisationId: input.requestingOrganisationId,
      acceptedInput: canonicalInput.value.acceptedInput,
      turn: input.lease.turn,
      restoreCheckpoint: this.restoreCanonicalHarnessCheckpointForRun.bind(
        this,
        input.lease,
      ),
      readHistory: readHarnessHistory.bind(null, this.ctx.storage.sql),
      readUsage: readHarnessHistoryUsage.bind(null, this.ctx.storage.sql),
    });
    const [toolHost, source] = await Promise.all([
      measureSessionHarnessPreparation(
        input,
        "harness_tool_host",
        toolHostPreparation,
        phaseStartedAt,
      ),
      measureSessionHarnessPreparation(
        input,
        "harness_history_restore",
        sourcePreparation,
        sourceStartedAt,
      ),
    ]);
    if (!toolHost.ok) return toolHost;
    if (!source.ok) return source;
    if (!resolvedModelRouteLease.ok) return resolvedModelRouteLease;
    const modelRouteLease = admittedSessionModelRoute(
      { kind: "canonical", admission: input.execution, lease: input.lease },
      resolvedModelRouteLease.value,
    );
    const promptEncoder = new TextEncoder();
    traceLog("session.harness_prompt_metrics", {
      requestId: input.requestId,
      organisation_id: input.requestingOrganisationId,
      turn_id: input.lease.turn.turnId,
      backend: adapter.manifest.backendId,
      source_kind: source.value.kind,
      instructions_bytes: promptEncoder.encode(input.harnessInstructions)
        .byteLength,
      user_input_bytes: promptEncoder.encode(JSON.stringify(harnessInput.value))
        .byteLength,
      tool_catalog_bytes: promptEncoder.encode(
        JSON.stringify(toolHost.value.definitions),
      ).byteLength,
      tool_count: toolHost.value.definitions.length,
    });
    phaseStartedAt = Date.now();
    let goalExecution: GoalExecution;
    if (input.goalExecution === null) {
      try {
        goalExecution = await createSessionGoalExecution(
          {
            env: this.env,
            storage: this.ctx.storage,
            liveRuns: this.liveGoalRuns,
          },
          input.lease,
          assignment,
          input.requestId,
          servedCase,
        );
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "embedded_harness_runtime_unavailable",
            detail:
              error instanceof Error
                ? error.message
                : "goal_admission_unavailable",
          },
        };
      }
    } else {
      const bound = await input.goalExecution.bound;
      if (!bound.ok) {
        return {
          ok: false,
          error: {
            code: "embedded_harness_runtime_unavailable",
            detail: bound.error,
          },
        };
      }
      goalExecution = {
        control: bound.value.control,
        close: input.goalExecution.close.bind(input.goalExecution),
      };
    }
    let goalClosing: Promise<void> | null = null;
    try {
      const runtime = adapter.construct({
        persistence: {
          kind: "actor",
          storage: this.ctx.storage,
          preflight: requirePiHarnessLease.bind(
            null,
            this.ctx.storage,
            input.lease,
          ),
        },
        goalModelCalls: goalExecution.control,
        source: source.value,
        inheritedHistory: projectWorkingHistory(
          inheritedHistory.entries,
          input.lease.turn.turnId,
        ),
        inheritedAttachments,
        sessionId,
        acceptedInput: canonicalInput.value.acceptedInput,
        model: modelRoute.model,
        modelTokenAllowance:
          budgetAccount.value.reservation.reservation.allowance.tokens -
          (input.runtime.kind === "resume_turn"
            ? input.runtime.priorUsage.totalTokens
            : 0),
        harnessInstructions,
        thinkingLevel: input.thinkingLevel,
        modelRouteLease,
        checkpointBinding: {
          ...binding.value.binding,
          cursor:
            binding.value.runtime.kind === "restore"
              ? binding.value.runtime.checkpoint.cursor
              : binding.value.runtime.kind === "resume_turn"
                ? binding.value.runtime.cursor
                : null,
        },
        toolHost: admittedSessionToolHost(
          { kind: "canonical", admission: input.execution, lease: input.lease },
          withSettledToolArguments(toolHost.value, boardDraftPreview),
        ),
        toolArguments: boardDraftPreview,
        eventSink: this,
        historySink: this,
        turnLease: input.lease,
        now: Date.now,
      });
      traceSessionHarnessPreparation(
        input,
        input.lease.turn.turnId,
        "harness_runtime",
        phaseStartedAt,
      );
      if (!runtime.ok) return runtime;

      try {
        const authorized = preflightHarnessTurnLease(
          this.ctx.storage,
          input.lease,
          Date.now(),
        );
        if (!authorized.ok) return authorized;
        // The authority check runs beside the reads of the account binding
        // and fee policy, which have no effect. Billing writes and reserves
        // only after the check passes.
        const [active, billingBinding] = await Promise.all([
          input.execution.isTurnActive(input.lease),
          readPantryExecutionAdmissionBinding(
            { env: this.env, storage: this.ctx.storage },
            input.lease,
          ),
        ]);
        if (!active)
          return {
            ok: false,
            error: { code: "embedded_harness_model_authority_unavailable" },
          };
        if (this.activeEmbeddedHarnessTurn !== null) {
          return {
            ok: false,
            error: { code: "embedded_harness_model_authority_unavailable" },
          };
        }
        if (
          Date.now() >= budgetAccount.value.reservation.reservation.deadlineAt
        ) {
          return { ok: false, error: { code: "budget_reservation_conflict" } };
        }
        if (!billingBinding.ok) return billingBinding;
        const billing = await admitPantryExecutionBilling(
          { env: this.env, storage: this.ctx.storage },
          {
            lease: input.lease,
            binding: billingBinding.value,
            modelRoute,
            modelRouteDigest: binding.value.binding.modelRouteDigest,
            continuation:
              input.runtime.kind === "resume_turn" ? "resume_turn" : "fresh",
          },
        );
        if (!billing.ok) return billing;
        // Account admission can wait. Check current execution authority again at dispatch.
        if (!(await input.execution.isTurnActive(input.lease)))
          return {
            ok: false,
            error: { code: "embedded_harness_model_authority_unavailable" },
          };
        if (
          Date.now() >= budgetAccount.value.reservation.reservation.deadlineAt
        )
          return { ok: false, error: { code: "budget_reservation_conflict" } };
        const dispatched = markPantryExecutionDispatched(
          this.ctx.storage.sql,
          input.lease.turn.turnId,
        );
        if (!dispatched.ok) return dispatched;
        const starting = runtime.value.startTurn(harnessInput.value);
        const started = await starting.completion;
        if (!started.ok) return started;
        this.activeEmbeddedHarnessTurn = {
          leaseId: input.lease.leaseId,
          lease: input.lease,
          acceptedInput: canonicalInput.value.acceptedInput,
          execution: input.execution,
          turn: started.value,
        };
        if (!(await input.execution.isTurnActive(input.lease))) {
          await started.value.cancel();
          return {
            ok: false,
            error: { code: "embedded_harness_model_authority_unavailable" },
          };
        }
        const completion = await completeEmbeddedHarnessTurnWithinBudget(
          started.value,
          Math.max(
            0,
            budgetAccount.value.reservation.reservation.deadlineAt - Date.now(),
          ),
        );
        if (completion.kind === "deadline_exceeded") {
          const cancelled = completion.cancellation;
          if (!cancelled.ok) return cancelled;
          const exhausted = reconcileCanonicalRunBudgetDeadline(
            this.ctx.storage,
            Math.max(
              Date.now(),
              budgetAccount.value.reservation.reservation.deadlineAt +
                RUN_TIME_STOP_GRACE_MS,
            ),
          );
          if (!exhausted.ok) return exhausted;
          return exhausted.value.kind === "exhausted"
            ? {
                ok: false,
                error: {
                  code: "budget_exhausted",
                  exhaustion: exhausted.value.exhaustion,
                },
              }
            : { ok: false, error: { code: "budget_deadline_not_elapsed" } };
        }
        const completed = completion.value;
        if (!completed.ok) return completed;
        phaseStartedAt = Date.now();
        // The model work of this turn has ended. The goal execution closes
        // beside the read of the fence, and the close is awaited before the
        // turn completes.
        goalClosing = goalExecution.close();
        void goalClosing.catch(ignoreGoalClose);
        const stillActive = await input.execution.isTurnActive(input.lease);
        traceSessionTurnCompletion(
          input,
          input.lease.turn.turnId,
          "turn_authority",
          phaseStartedAt,
        );
        if (!stillActive)
          return {
            ok: false,
            error: { code: "embedded_harness_model_authority_unavailable" },
          };
        return {
          ok: true,
          value: {
            ...completed.value,
            modelUsage:
              input.runtime.kind === "resume_turn"
                ? combinedHarnessUsage(
                    input.runtime.priorUsage,
                    completed.value.modelUsage,
                  )
                : completed.value.modelUsage,
            binding: binding.value.binding,
            manifest: adapter.manifest,
          },
        };
      } finally {
        retainPantryExecutionUncertainty(
          this.ctx.storage.sql,
          input.lease.turn.turnId,
        );
        if (this.activeEmbeddedHarnessTurn?.leaseId === input.lease.leaseId) {
          this.activeEmbeddedHarnessTurn = null;
        }
        phaseStartedAt = Date.now();
        await runtime.value.close();
        await this.journalPlacedSteeringInputs(input, sessionId);
        await projectCurrentHarnessHistoryBudgetWarning({
          env: this.env,
          execution: input.execution,
          sql: this.ctx.storage.sql,
          sessionId,
          turnId: input.lease.turn.turnId,
          warningAt: Date.now(),
        });
        traceSessionTurnCompletion(
          input,
          input.lease.turn.turnId,
          "runtime_close",
          phaseStartedAt,
        );
      }
    } finally {
      phaseStartedAt = Date.now();
      goalClosing ??= goalExecution.close();
      // A caller that started the goal execution waits for this close beside
      // the fence that it reads next, or when the turn has failed.
      if (input.goalExecution === null) {
        await goalClosing;
        traceSessionTurnCompletion(
          input,
          input.lease.turn.turnId,
          "goal_close",
          phaseStartedAt,
        );
      } else {
        void goalClosing.catch(ignoreGoalClose);
      }
    }
  }

  protected async runAndCheckpointCanonicalEmbeddedHarnessTextTurn(input: {
    execution: SessionExecutionAdmission;
    /**
     * The connector catalog the same call resolved to start this turn. Null
     * when the turn resumes in a later call, which resolves it again.
     */
    customConnectorCatalog: AcceptedCustomConnectorCatalog | null;
    /**
     * The receipt check that read the fence of this turn's start commit in
     * the same call. Null when the turn resumes in a later call, which checks
     * the receipt itself.
     */
    startReceiptCheck: FencedWorkspaceReceiptCheck | null;
    /**
     * The read of the Case's fork history that the same call started. Null
     * when the turn resumes in a later call, which starts the read itself.
     */
    startedInheritedHistory: ReturnType<
      typeof readChatForkHistoryForCase
    > | null;
    /**
     * The read of the registry row of the Case that this Session serves,
     * which the same call started beside the fence of its start commit. Null
     * when the turn resumes in a later call, which reads the row itself.
     */
    startedGoalCase: ReturnType<typeof findServedGoalCase> | null;
    requestingOrganisationId: OrganisationId;
    requestId: RequestId;
    runtime: CanonicalEmbeddedHarnessRuntimeSource;
    lease: HarnessTurnLease;
    harnessInstructions: string;
    thinkingLevel?: import("../embedded-harness").EmbeddedHarnessThinkingLevel;
    turnPrompt: string;
    browserContext: BakeryBrowserContext;
    surfaceContext: BakerySurfaceAttachmentV1 | null;
    completion: CanonicalTextTurnCompletionIdentity;
  }): Promise<
    Result<
      CanonicalEmbeddedHarnessTextTurnResult,
      CanonicalEmbeddedHarnessTextTurnError
    >
  > {
    let phaseStartedAt = Date.now();
    const before = await readCanonicalSessionForPersistence(
      this.persistence,
      this.ctx.storage.sql,
      input.requestingOrganisationId,
    );
    traceSessionHarnessPreparation(
      input,
      input.lease.turn.turnId,
      "run_session",
      phaseStartedAt,
    );
    if (!before.ok) return before;
    if (before.value.lifecycle.kind !== "processing") {
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "lifecycle_not_processing",
        },
      };
    }
    const receipt = canonicalTextTurnWorkspaceReceipt(
      before.value.lifecycle,
      input.runtime,
    );
    if (!receipt.ok) return receipt;
    phaseStartedAt = Date.now();
    // The start of this turn checked the receipt with the fence of its commit
    // and started the read of the Case's fork history beside it. Only this
    // Session's storage was used since. A turn that resumes in a later call
    // checks the receipt and starts the read here.
    const assignment = readCaseSessionAssignment(this.ctx.storage.sql);
    const inheritedHistory =
      input.startedInheritedHistory ??
      (assignment === null
        ? null
        : readChatForkHistoryForCase(
            this.env,
            input.execution.scope,
            String(assignment.caseId),
          ));
    void inheritedHistory?.catch(ignoreUnusedForkHistory);
    const verifiedReceipt =
      reusableWorkspaceReceiptCheck(input.startReceiptCheck, receipt.value) ??
      (await verifyWorkspaceRevisionReceipt(
        input.execution.scope,
        input.requestingOrganisationId,
        receipt.value,
      ));
    traceSessionHarnessPreparation(
      input,
      input.lease.turn.turnId,
      "run_workspace_receipt",
      phaseStartedAt,
    );
    if (!verifiedReceipt.ok) {
      return {
        ok: false,
        error: {
          code: "workspace_revision_receipt_invalid",
          reason: verifiedReceipt.error.code,
        },
      };
    }
    phaseStartedAt = Date.now();
    const budgetIdentity = canonicalRunBudgetIdentity(input.lease);
    const reserved = this.ctx.storage.transactionSync(
      reserveRunBudget.bind(null, this.ctx.storage.sql, {
        ...budgetIdentity,
        operationId: `budget_reserve_${budgetIdentity.runId}`,
        turnId: input.lease.turn.turnId,
        now: Date.now(),
      }),
    );
    if (!reserved.ok) return reserved;
    // The alarm cuts off a run that is still going after its grace period.
    await armAlarmBy(
      this.ctx.storage,
      reserved.value.deadlineAt + RUN_TIME_STOP_GRACE_MS,
    );
    traceSessionHarnessPreparation(
      input,
      input.lease.turn.turnId,
      "run_budget_admission",
      phaseStartedAt,
    );
    // The start of this turn read the fence and the Case's registry row in
    // one wait, and only this Session's storage was used since. The goal
    // execution binds now, beside the reads of the harness turn. This method
    // waits for its close on every path.
    const goalExecution =
      input.startedGoalCase === null || assignment === null
        ? null
        : StartedGoalExecution.start(
            {
              env: this.env,
              storage: this.ctx.storage,
              liveRuns: this.liveGoalRuns,
            },
            input.lease,
            assignment,
            input.requestId,
            input.startedGoalCase,
          );
    let completed;
    try {
      completed = await this.runCanonicalEmbeddedHarnessTurn({
        execution: input.execution,
        customConnectorCatalog: input.customConnectorCatalog,
        inheritedHistory,
        goalExecution,
        requestingOrganisationId: input.requestingOrganisationId,
        requestId: input.requestId,
        runtime: input.runtime,
        lease: input.lease,
        harnessInstructions: input.harnessInstructions,
        thinkingLevel: input.thinkingLevel,
        turnPrompt: input.turnPrompt,
        browserContext: input.browserContext,
        surfaceContext: input.surfaceContext,
      });
    } catch (error) {
      await goalExecution?.close();
      throw error;
    }
    if (!completed.ok) {
      await goalExecution?.close();
      const failed = failCanonicalRunBudget(
        this.ctx.storage,
        budgetIdentity,
        input.lease,
        completed.error,
        Date.now(),
      );
      return failed.ok ? completed : failed;
    }
    phaseStartedAt = Date.now();
    // The checkpoint carries this receipt, and the completion checks it. The
    // receipt statement reads the placement fence too, so one round trip
    // serves the fence here and the receipt check of the completion. The
    // close of the goal execution, which started when the model work ended,
    // shares this wait.
    const goalClosed =
      goalExecution === null
        ? null
        : goalExecution
            .close()
            .then(
              traceSessionTurnCompletion.bind(
                null,
                input,
                input.lease.turn.turnId,
                "goal_close",
                phaseStartedAt,
              ),
            );
    const [fenceAfterHarness] = await Promise.all([
      input.execution.isActiveWithWorkspaceReceipt(
        completed.value.binding.workspaceRevisionReceipt,
      ),
      goalClosed,
    ]);
    traceSessionTurnCompletion(
      input,
      input.lease.turn.turnId,
      "placement_check",
      phaseStartedAt,
    );
    if (!fenceAfterHarness.active || !input.execution.isLocallyOpen()) {
      traceTurnCompletionRefused(
        input,
        fenceAfterHarness.active ? "locally_closed" : "fence_inactive",
      );
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "fence_closed",
        },
      };
    }
    phaseStartedAt = Date.now();
    const currentFlowBinding = await readPersistedSessionTurnFlowBinding(
      this.ctx.storage.sql,
      {
        organisationId: String(input.requestingOrganisationId),
        sessionId: String(input.lease.session.sessionId),
        turnId: String(input.lease.turn.turnId),
      },
    );
    if (
      !currentFlowBinding.ok ||
      currentFlowBinding.value === null ||
      currentFlowBinding.value.authorityPartitionDigest !==
        input.lease.authorityPartitionDigest
    ) {
      traceTurnCompletionRefused(
        input,
        !currentFlowBinding.ok
          ? `flow_binding_${currentFlowBinding.error.code}`
          : currentFlowBinding.value === null
            ? "flow_binding_missing"
            : "flow_binding_authority_mismatch",
      );
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "flow_binding_invalid",
        },
      };
    }
    // The run has ended: a turn the time limit stopped may finish its last
    // model call after the limit.
    const modelUsageAccepted = acceptCanonicalRunModelUsage(
      this.ctx.storage,
      budgetIdentity,
      completed.value.modelUsage.totalTokens,
      Date.now(),
      true,
    );
    if (!modelUsageAccepted.ok) {
      return modelUsageAccepted;
    }
    // The lifecycle is read before the run settles: a cancel that moved the
    // turn out of processing settles the run as cancelled, not as succeeded
    // (Refactor 15, refactor 3).
    const after = await readCanonicalSessionForPersistence(
      this.persistence,
      this.ctx.storage.sql,
      input.requestingOrganisationId,
    );
    const settled = settleCanonicalRunBudget(
      this.ctx.storage,
      budgetIdentity,
      after.ok && after.value.lifecycle.kind === "processing"
        ? "succeeded"
        : "cancelled",
      Date.now(),
    );
    if (!after.ok || after.value.lifecycle.kind !== "processing") {
      traceTurnCompletionRefused(
        input,
        after.ok
          ? `lifecycle_${after.value.lifecycle.kind}`
          : "session_unreadable",
      );
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "lifecycle_not_processing",
        },
      };
    }
    if (!settled.ok) return settled;
    const checkpointing = buildTextTurnCheckpointingCommit({
      current: after.value.lifecycle,
      harnessLease: input.lease,
      workspaceRevisionReceipt: receipt.value,
      completion: input.completion,
    });
    if (!checkpointing.ok) return checkpointing;

    const harnessCheckpoint = await this.commitCanonicalHarnessCheckpoint(
      textTurnHarnessCheckpointInput({
        state: after.value.lifecycle,
        binding: completed.value.binding,
        manifest: completed.value.manifest,
        lease: input.lease,
        cursor: completed.value.cursor,
        historyCursor: completed.value.historyCursor,
        checkpoint: completed.value.checkpoint,
        budgetAccount: settled.value,
        budgetAccountDigest: await sessionBudgetAccountDigest(settled.value),
        workspaceRevisionReceipt:
          completed.value.binding.workspaceRevisionReceipt,
        createdAt: input.completion.acceptedAt,
      }),
      checkpointing.value,
    );
    if (!harnessCheckpoint.ok) return harnessCheckpoint;
    traceSessionTurnCompletion(
      input,
      input.lease.turn.turnId,
      "checkpoint_accept",
      phaseStartedAt,
    );

    // The fence was read after the harness returned, and only this Session's
    // own storage was used since then.
    const finalized = await this.finalizeAcceptedSessionCheckpoint({
      execution: input.execution,
      requestingOrganisationId: input.requestingOrganisationId,
      caller: {
        kind: "turn",
        requestId: input.requestId,
        receiptCheck: fenceAfterHarness.check,
      },
      turnId: input.lease.turn.turnId,
    });
    if (!finalized.ok) return finalized;
    return {
      ok: true,
      value: {
        outcome: finalized.value.outcome,
        finalMessage: finalized.value.finalMessage,
        cursor: finalized.value.cursor,
        checkpoint: finalized.value.checkpoint,
        state: finalized.value.state,
        modelUsage: completed.value.modelUsage,
        flowBinding: finalized.value.flowBinding,
      },
    };
  }

  protected async prepareCanonicalTextTurn(
    input: CanonicalTextTurnInput,
  ): Promise<
    Result<
      CanonicalEmbeddedHarnessTextTurnResult,
      CanonicalEmbeddedHarnessTextTurnError
    >
  > {
    const execution = await SessionExecutionAdmission.resolve(
      this.env,
      this.ctx.storage,
      input.requestingOrganisationId,
    );
    if (execution === null)
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "execution_unavailable",
        },
      };
    let phaseStartedAt = Date.now();
    const attachments = parseStoredAttachmentList(input.attachments);
    if (!attachments.ok)
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "attachments_invalid",
        },
      };
    const context = await restoreSessionTurnContext(input.context);
    traceSessionHarnessPreparation(
      input,
      input.start.turnId,
      "start_context",
      phaseStartedAt,
    );
    if (context === null)
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "context_unavailable",
        },
      };
    const surfaceContext = await normalizeBakerySurfaceContext(
      input.surfaceContext,
    );
    if (!surfaceContext.ok)
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "surface_context_invalid",
        },
      };
    phaseStartedAt = Date.now();
    const current = await readCanonicalSessionForPersistence(
      this.persistence,
      this.ctx.storage.sql,
      input.requestingOrganisationId,
    );
    traceSessionHarnessPreparation(
      input,
      input.start.turnId,
      "start_session",
      phaseStartedAt,
    );
    if (!current.ok) return current;
    if (current.value.lifecycle.kind !== "sleeping") {
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "lifecycle_not_sleeping",
        },
      };
    }
    const reconciledBudget = reconcileSleepingSessionRunBudget(
      this.ctx.storage,
      current.value.lifecycle.state.identity,
      Date.now(),
    );
    if (!reconciledBudget.ok) return reconciledBudget;
    phaseStartedAt = Date.now();
    const runtime = await canonicalEmbeddedHarnessRuntimeSource(
      this.ctx.storage.sql,
      current.value.lifecycle,
      this.selectEmbeddedHarnessAdapter(
        current.value.lifecycle.state.contract.modelRoute,
      ),
    );
    traceSessionHarnessPreparation(
      input,
      input.start.turnId,
      "start_runtime_source",
      phaseStartedAt,
    );
    if (!runtime.ok) return runtime;
    // A Session holds one unpublished checkpoint at most: it drops the payload
    // of a checkpoint when it accepts the next one. An archive write that is
    // not finished is finished before this turn starts.
    if (hasUnpublishedHarnessCheckpoint(this.ctx.storage.sql)) {
      const published = await this.publishAcceptedCheckpoint({
        execution,
        attempt: "resumed",
        trace: input,
      });
      if (!published.ok) return published;
    }
    // A checkpoint's payload is immutable, and reading it decides nothing. Its
    // read starts here, beside the reads that decide whether the turn may
    // start, and is used only when the restore is then admitted. The Session
    // keeps the payload of its latest checkpoint, so this read is local.
    if (runtime.value.kind === "restore") {
      this.startedCheckpointPayload = {
        checkpoint: JSON.stringify(runtime.value.checkpoint),
        payload: readCheckpointPayloadForRestore({
          sql: this.ctx.storage.sql,
          bucket: this.env.ARCHIVE,
          root: this.env.DATA_ENCRYPTION_ROOT,
          checkpoint: runtime.value.checkpoint,
        }),
      };
    }
    const assignment = readCaseSessionAssignment(this.ctx.storage.sql);
    if (assignment === null) {
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "assignment_missing",
        },
      };
    }
    phaseStartedAt = Date.now();
    // Two more reads share the wait of the connector catalog. The Case's fork
    // history is an independent read, consumed where the harness turn needs
    // it. The receipt statement reads the placement fence too: it is the
    // fence of the start commit, and the turn does not read the receipt
    // again. Between this wait and the commit the turn uses only this
    // Session's storage.
    const inheritedHistory = readChatForkHistoryForCase(
      this.env,
      execution.scope,
      String(assignment.caseId),
    );
    void inheritedHistory.catch(ignoreUnusedForkHistory);
    // A side Case adds its instruction to every turn, also to the binding
    // that this start pins, so the run and its checkpoint agree.
    const sideCaseOrigin = readSideCaseOrigin(
      execution.scope,
      String(assignment.caseId),
    );
    void sideCaseOrigin.catch(ignoreUnusedSideCaseOrigin);
    const startReceipt = canonicalTextTurnWorkspaceReceipt(
      current.value.lifecycle,
      runtime.value,
    );
    const startFenceRead = startReceipt.ok
      ? execution.isActiveWithWorkspaceReceipt(startReceipt.value)
      : execution.isActive().then(fenceWithoutReceiptCheck);
    void startFenceRead.catch(ignoreUnusedStartFence);
    // The registry row of the Case that this Session serves is one more read
    // of this wait. With it the goal execution binds beside the reads of the
    // harness turn, with no read of its own.
    const servedGoalCase = findServedGoalCase(
      this.env,
      execution.scope,
      assignment,
    );
    const customConnectorCatalog = await resolveAcceptedCustomConnectorCatalog({
      scope: execution.scope,
      organisationId: input.requestingOrganisationId,
      authority: input.start.requestAuthority,
      userAuthority: acceptedExecutionAccountAuthority(
        assignment.sessionId,
        input.start.turnId,
      ),
      assignment,
    });
    traceSessionHarnessPreparation(
      input,
      input.start.turnId,
      "start_custom_catalog",
      phaseStartedAt,
    );
    if (!customConnectorCatalog.ok) return customConnectorCatalog;
    phaseStartedAt = Date.now();
    const runtimePreflight =
      await resolveCanonicalEmbeddedHarnessCheckpointBinding({
        state: current.value.lifecycle,
        runtime: runtime.value,
        harnessInstructions: sideCaseHarnessInstructions(
          input.harnessInstructions,
          await sideCaseOrigin,
        ),
        assignment,
        customConnectorOperations: customConnectorCatalog.value.entries,
        bakerySurfaceCommands: authorizedBakerySurfaceCommands(
          input.start.requestAuthority,
        ),
        memoryProposal: turnMayProposeMemory(input.start.requestAuthority),
        followUp: turnMayScheduleFollowUp(
          input.start.requestAuthority,
          String(input.start.turnId),
        ),
        ...(await turnToolSelection({
          db: execution.scope.database,
          organisationId: String(execution.scope.organisationId),
          authority: input.start.requestAuthority,
          sessionId: String(assignment.sessionId),
          turnId: String(input.start.turnId),
        })),
      });
    traceSessionHarnessPreparation(
      input,
      input.start.turnId,
      "start_checkpoint_binding",
      phaseStartedAt,
    );
    if (!runtimePreflight.ok) return runtimePreflight;
    const start = buildCanonicalTextTurnStart({
      current: current.value.lifecycle,
      request:
        "runtimeLease" in input.start
          ? input.start
          : withNextRuntimeGeneration(current.value.lifecycle, input.start),
    });
    if (!start.ok) return start;
    phaseStartedAt = Date.now();
    const informationFlow = await prepareSessionInformationFlow({
      sql: this.ctx.storage.sql,
      organisationId: String(input.requestingOrganisationId),
      sessionId: String(start.value.harnessLease.session.sessionId),
      turnId: start.value.harnessLease.turn.turnId,
      authorityPartitionDigest:
        start.value.harnessLease.authorityPartitionDigest,
      contextBundle: context.bundle,
    });
    traceSessionHarnessPreparation(
      input,
      input.start.turnId,
      "start_information_flow",
      phaseStartedAt,
    );
    if (!informationFlow.ok) {
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "information_flow_unavailable",
        },
      };
    }
    if (input.streamSink !== null) {
      // The authority is the live one that this call resolved for the
      // connector catalog. A refused sink leaves no turn and no stream.
      phaseStartedAt = Date.now();
      const sink = await decideCaseConversationSink(
        customConnectorCatalog.value.authority,
        informationFlow.value.binding,
        input.streamSink.channelId,
        this.env,
      );
      traceSessionHarnessPreparation(
        input,
        input.start.turnId,
        "start_stream_sink",
        phaseStartedAt,
      );
      // An answer that waits for a person still runs its turn. The stream
      // releases nothing, and the delivery holds the answer.
      if (!sink.ok && !sinkRefusalAsksPerson(sink.error.code))
        return {
          ok: false,
          error: {
            code: "canonical_text_turn_sink_refused",
            refusal: sink.error.code,
          },
        };
    }
    phaseStartedAt = Date.now();
    const startFence = await startFenceRead;
    if (!startFence.active || !execution.isLocallyOpen())
      return this.ctx.storage.transactionSync(
        failFrozenCanonicalPreparation.bind(null, this.ctx.storage.sql, input),
      );
    const started = commitStartedSession(this.ctx.storage, {
      acceptedInput: start.value.acceptedInput,
      activatedRuntime: start.value.activatedRuntime,
      attachments: attachments.value,
      links: input.links,
      context,
      informationFlow: informationFlow.value,
      stream: {
        turnId: start.value.harnessLease.turn.turnId,
        requestId: input.requestId,
        organisationId: input.requestingOrganisationId,
        inputDigest: input.inputDigest,
        startedAt: input.start.admittedAt,
      },
    });
    traceSessionHarnessPreparation(
      input,
      input.start.turnId,
      "start_commit",
      phaseStartedAt,
    );
    if (!started.ok) return started;
    try {
      writeHarnessTurnContinuation(this.ctx.storage.sql, {
        kind: "harness_turn_continuation.v1",
        organisationId: input.requestingOrganisationId,
        requestId: input.requestId,
        turnId: start.value.harnessLease.turn.turnId,
        leaseId: start.value.harnessLease.leaseId,
        harnessInstructions: input.harnessInstructions,
        turnPrompt: input.turnPrompt,
        thinkingLevel: input.thinkingLevel ?? null,
        browserContext: input.browserContext,
        completion: input.completion,
        binding: {
          instructionDigest: runtimePreflight.value.binding.instructionDigest,
          toolCatalogDigest: runtimePreflight.value.binding.toolCatalogDigest,
          modelRouteDigest: runtimePreflight.value.binding.modelRouteDigest,
          workspaceRevision: runtimePreflight.value.binding.workspaceRevision,
          policyRevision: runtimePreflight.value.binding.policyRevision,
        },
      });
      const completed =
        await this.runAndCheckpointCanonicalEmbeddedHarnessTextTurn({
          execution,
          customConnectorCatalog: customConnectorCatalog.value,
          startReceiptCheck: startFence.check,
          startedInheritedHistory: inheritedHistory,
          startedGoalCase: servedGoalCase,
          requestingOrganisationId: input.requestingOrganisationId,
          requestId: input.requestId,
          runtime: runtimePreflight.value.runtime,
          lease: start.value.harnessLease,
          harnessInstructions: input.harnessInstructions,
          thinkingLevel: input.thinkingLevel,
          turnPrompt: input.turnPrompt,
          browserContext: input.browserContext,
          surfaceContext: surfaceContext.value,
          completion: input.completion,
        });
      if (
        !completed.ok &&
        finalizationPendingFor(
          this.ctx.storage.sql,
          start.value.harnessLease.turn.turnId,
        )
      ) {
        // The turn's checkpoint is accepted, so the turn has its answer. A
        // failure in its completion schedules the completion again; the
        // alarm completes the turn and its stream (Refactor 15, refactor 3).
        traceWarn("session.turn_completion_deferred", {
          requestId: input.requestId,
          organisation_id: input.requestingOrganisationId,
          session_id: start.value.harnessLease.session.sessionId,
          turn_id: start.value.harnessLease.turn.turnId,
          reason: completed.error.code,
        });
        await this.scheduleCheckpointFinalization();
      } else if (!completed.ok) {
        traceWarn("session.embedded_turn_failed", {
          requestId: input.requestId,
          organisation_id: input.requestingOrganisationId,
          session_id: start.value.harnessLease.session.sessionId,
          turn_id: start.value.harnessLease.turn.turnId,
          reason: completed.error.code,
          budget_dimension:
            completed.error.code === "budget_exhausted"
              ? completed.error.exhaustion.dimension
              : null,
          budget_tokens:
            completed.error.code === "budget_exhausted"
              ? completed.error.exhaustion.observedUsage.tokens
              : null,
          detail: embeddedHarnessFailureDetail(completed.error),
        });
        const cancelled = await this.resolveFailedTurn({
          organisationId: input.requestingOrganisationId,
          lease: start.value.harnessLease,
          cancellationId:
            completed.error.code === "budget_exhausted"
              ? `cancel_${completed.error.exhaustion.exhaustionId}`
              : `cancel_${input.requestId}`,
          correlationId:
            completed.error.code === "budget_exhausted"
              ? completed.error.exhaustion.exhaustionId
              : input.requestId,
          acceptedAt: Date.now(),
        });
        if (!cancelled.ok) {
          traceWarn("session.failed_turn_cancellation_deferred", {
            requestId: input.requestId,
            organisation_id: input.requestingOrganisationId,
            session_id: start.value.harnessLease.session.sessionId,
            turn_id: start.value.harnessLease.turn.turnId,
            failure_reason: completed.error.code,
            cancellation_reason: cancelled.error.code,
          });
        }
        failSessionTurnStream(
          this.ctx.storage.sql,
          start.value.harnessLease.turn.turnId,
          completed.error.code,
          input.completion.acceptedAt,
        );
      }
      return completed;
    } finally {
      finishHarnessTurnContinuation(
        this.ctx.storage.sql,
        start.value.harnessLease.turn.turnId,
      );
    }
  }

  protected async resolveFailedTurn(input: {
    readonly organisationId: OrganisationId;
    readonly lease: HarnessTurnLease;
    readonly cancellationId: string;
    readonly correlationId: string;
    readonly acceptedAt: number;
  }): Promise<Result<null, CanonicalEmbeddedHarnessTextTurnError>> {
    const current = await readCanonicalSessionForPersistence(
      this.persistence,
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!current.ok) return current;
    if (current.value.lifecycle.kind !== "processing") {
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "lifecycle_not_processing",
        },
      };
    }
    const cancellation = buildTextTurnCancellationStartedCommit({
      current: current.value.lifecycle,
      harnessLease: input.lease,
      cancellation: {
        cancellationId: input.cancellationId,
        correlationId: input.correlationId,
        acceptedAt: Math.min(input.acceptedAt, input.lease.expiresAt - 1),
      },
    });
    if (!cancellation.ok) return cancellation;
    const resolved = await this.cancelCanonicalEmbeddedHarnessTurn(
      cancellation.value,
    );
    return resolved.ok ? { ok: true, value: null } : resolved;
  }
}

/** True when the accepted checkpoint of this turn waits for its completion. */
function finalizationPendingFor(sql: SqlStorage, turnId: string): boolean {
  const pending = readAcceptedCheckpointFinalization(sql);
  return (
    pending.ok &&
    pending.value.kind === "pending" &&
    pending.value.finalization.current.state.turnId === turnId
  );
}
