import { SessionActorBase } from "./session-actor-base";
import {
  SessionCheckpoints,
  type SessionCheckpointsRpc,
} from "./session-checkpoints";
import {
  SessionHarnessTurns,
  type SessionHarnessTurnsRpc,
} from "./session-harness-turns";
import {
  actorMachineCensus,
  type MachineCensus,
} from "../lifecycle/machine-census";
import {
  armAlarmAfterFailedSteps,
  runAlarmSteps,
} from "../lifecycle/actor-alarm";
import {
  MAX_STEERING_TEXT_CHARS,
  admitSteeringInput,
  markSteeringInputWithdrawn,
  readSteeringInputByRequest,
  settledSteeringInput,
  steeringMessageHasNoFiles,
  steeringRequesterMatches,
  turnTriggerEntryId,
  type SteeringInputState,
} from "../harness-steering";
import { toHistoryContent } from "../pi-user-input";
import { reconcilePantryExecutionBilling } from "../../account-platform/execution-billing";
import { buildRecoveringSessionCancellation } from "../agent-session-recovery";
import { beginPiDurableRecovery } from "../pi-durable-recovery";
import { piDurableImportSchema } from "../pi-durable-checkpoint";
import {
  readSessionExecutionContent,
  readSessionExecutionRecords,
} from "../agent-session-execution-records";
import type {
  CaseExecutionSessionRecords,
  CaseExecutionStoredContent,
  SessionExecutionContentTarget,
} from "../../case-execution/records";
import { reconcileSessionGoalUsage } from "../session-goal-usage";
import { assertCompletedHistory } from "../../chat/fork-history";
import { discardHarnessTurnContinuation } from "../agent-session-continuation";
import type { ChatContextDetails } from "@purin-labs/control-api";
import {
  canEraseArchivedHarnessHistory,
  type HarnessHistoryErasureRequest,
  type OrganisationArchiveCleanupError,
} from "../organisation-archive-cleanup";
import { readAcceptedCheckpointFinalization } from "../agent-session-finalization";
import type {
  AcceptedInputRef,
  HarnessCheckpointRecord,
  HarnessTurnLease,
} from "@purin-labs/contracts";
import type { ActorActivationRequest } from "../actor-registry";
import type { Env } from "../../env";
import {
  parseRequestId,
  parseSessionId,
  parseOrganisationId,
  type RequestId,
  type SessionId,
  type OrganisationId,
} from "../../ids";
import { traceLog } from "../../observability";
import { verifyWorkspaceRevisionReceipt } from "../../workspace-revision-store";
import type { Result } from "../../result";
import { initializeAgentSessionPersistence } from "../agent-session-schema";
import { CANONICAL_SESSION_SCHEMA_VERSION } from "../actor-schema-versions";
import {
  inspectAgentSessionCutoverQuiescence,
  type SessionCutoverInspectionError,
  type SessionCutoverQuiescence,
} from "../agent-session-cutover-quiescence";
import { SessionExecutionAdmission } from "../session-execution-admission";
import { settleActorExecution } from "../actor-execution-quiescence";
import {
  readCanonicalSessionForPersistence,
  readCanonicalSessionProjection,
  type CanonicalSessionAccessError,
  type ImportedCanonicalSessionRecord,
} from "../agent-session-canonical";
import {
  commitAcceptedSessionInput,
  commitInitializedCaseSession,
  commitInitializedSession,
  commitRuntimeActivatedSession,
  restoreContextBundle,
  type AcceptedSessionInputCommit,
  type ActorTransitionCommitError,
  type ActorTransitionCommitResult,
  type InitializedCaseSessionCommit,
  type InitializedSessionCommit,
  type RuntimeActivatedSessionCommit,
} from "../actor-journal";
import {
  readCaseSessionAssignment,
  parseStoredCaseAssignment,
} from "../actor-journal/transactions";
import {
  eraseHarnessHistoryForOrganisation,
  preflightHarnessTurnLease,
  readHarnessHistory,
  dropArchivedHarnessCheckpointPayloads,
  hasUnpublishedHarnessCheckpoint,
  type HarnessHistoryErasure,
} from "../agent-session-harness-authority";
import {
  loadCanonicalHarnessCheckpoint,
  validateCheckpointBudgetBinding,
} from "../agent-session-harness-checkpoint";
import { inspectLatestMessageLinkReceipt } from "../message-link-receipt-inspection";
import type { PageEffectReceipt, PageEffectSettlement } from "./tool-wiring";
import {
  reconcileCodeModeSettlements,
  reconcileFrozenCodeModeSettlements,
  type RelocationSessionSettlementRequest,
} from "../agent-session-code-mode-settlement";
import type {
  EmbeddedHarnessUserInput,
  EmbeddedHarnessSteerError,
} from "../embedded-harness";
import { selectEmbeddedHarnessAdapterForModelRoute } from "../embedded-harness-adapter";
import type { CanonicalEmbeddedHarnessInput } from "../canonical-embedded-harness-input";
import {
  buildTextTurnCancellationStartedCommit,
  type CanonicalTextTurnTransitionError,
} from "../agent-session-text-turn";
import { readSessionBudgetAccount } from "../agent-session-budget";
import { admitActorRecovery } from "../actor-activation";
import {
  canAdmitSessionWork,
  closePortalChatCleanupAdmission,
  readPortalChatErasure,
  type PortalChatCleanupError,
  type PortalChatCleanupRequest,
} from "../portal-chat-cleanup";
import type { ActorFenceToken } from "../actor-registry";
import type { ActorExportError } from "../actor-export";
import {
  failSessionTurnStream,
  readSessionTurnStream,
  type SessionTurnStreamError,
} from "../agent-session-turn-stream";
import {
  prepareSessionInformationFlow,
  readSessionInformationFlow,
  readSessionTurnFlowBinding as readPersistedSessionTurnFlowBinding,
} from "../agent-session-information-flow";
import { sameJson, sha256Hex } from "@purin-labs/std";
import type { ActorImportSqlMigration } from "../actor-export";
import { type PlacedActorExportSource } from "../lifecycle/placed-actor";
import { sessionReachableAttachmentObjectKeys } from "./attachments";
import { indeterminateEffectCensus } from "./indeterminate-effect-census";
import {
  inspectSessionBudget,
  inspectSessionCheckpoint,
  readSessionInspectionHeader,
} from "./inspection";
import { confirmedContextObservation } from "./model-context";
import {
  createSessionReplayResponse,
  failOrphanedSessionTurnStreams,
} from "./replay";
import {
  readCurrentHarnessTurnLease,
  reconcileCanonicalRunBudgetDeadline,
  schedulePersistedRunBudgetDeadline,
} from "./run-budget";
import {
  type CanonicalTextTurnInput,
  parseHarnessTurnLeaseProjection,
  sessionPlacementR2Keys,
} from "./support";
import type {
  CanonicalEmbeddedHarnessCancellationError,
  CanonicalEmbeddedHarnessInputError,
  CanonicalEmbeddedHarnessTextTurnError,
  CanonicalEmbeddedHarnessTextTurnResult,
  CanonicalHarnessCheckpointRestoreError,
  CanonicalHarnessHistoryErasureError,
  CanonicalInputAcceptanceError,
  SessionInformationFlowPreparationInput,
  SessionInformationFlowPreparationResult,
  SessionInspection,
  SessionInspectionError,
  SessionInterruptTurnInput,
  SessionInterruptTurnResult,
  SessionPing,
  SessionReplayInput,
  SessionStateError,
  SessionSteerTurnInput,
  SessionSteerTurnResult,
  SessionTurnInspection,
  TurnStateInvalidError,
} from "./types";
import { SessionTurnRecovery } from "./session-turn-recovery";

/**
 * The Session actor: the RPC methods over the layers of `actors/session/`.
 * It names no product area. The class of the Worker, `SessionDO`, gives it
 * the agent tools and the parts of the areas.
 */
export abstract class SessionActor
  extends SessionActorBase
  implements SessionCheckpointsRpc, SessionHarnessTurnsRpc
{
  /** The checkpoints of the Session: restore, finalization and publication. */
  protected readonly checkpoints = new SessionCheckpoints(this.shared);

  /** The turns of the embedded harness: input, run, checkpoint and failure. */
  protected readonly harnessTurns = new SessionHarnessTurns(
    this.shared,
    this.checkpoints,
  );

  /** The recovery of an interrupted turn and of a checkpoint that waits. */
  protected readonly recovery = new SessionTurnRecovery(
    this.shared,
    this.checkpoints,
    this.harnessTurns,
  );

  cancelCanonicalEmbeddedHarnessTurn(
    ...input: Parameters<
      SessionHarnessTurns["cancelCanonicalEmbeddedHarnessTurn"]
    >
  ) {
    return this.harnessTurns.cancelCanonicalEmbeddedHarnessTurn(...input);
  }

  commitCanonicalHarnessCheckpoint(
    ...input: Parameters<
      SessionHarnessTurns["commitCanonicalHarnessCheckpoint"]
    >
  ) {
    return this.harnessTurns.commitCanonicalHarnessCheckpoint(...input);
  }

  completeCanonicalCheckpointAndStream(
    ...input: Parameters<
      SessionCheckpoints["completeCanonicalCheckpointAndStream"]
    >
  ) {
    return this.checkpoints.completeCanonicalCheckpointAndStream(...input);
  }

  readSessionTurnFlowBinding(
    ...input: Parameters<SessionCheckpoints["readSessionTurnFlowBinding"]>
  ) {
    return this.checkpoints.readSessionTurnFlowBinding(...input);
  }

  readCompletedTurn(
    ...input: Parameters<SessionCheckpoints["readCompletedTurn"]>
  ) {
    return this.checkpoints.readCompletedTurn(...input);
  }

  /** State counts of this Actor's machines, for the census (Refactor 15, S5). */
  async machineCensus(): Promise<readonly MachineCensus[]> {
    const census = await actorMachineCensus(this.ctx.storage);
    const unknown = indeterminateEffectCensus(this.ctx.storage.sql, Date.now());
    return unknown === null ? census : [...census, unknown];
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { executionBarrier: true });
    this.shared.persistence = this.ctx.storage.transactionSync(
      initializeAgentSessionPersistence.bind(null, this.ctx.storage.sql),
    );
    const nativeRecovery = this.ctx.storage.transactionSync(
      beginPiDurableRecovery.bind(
        null,
        this.sessionTools().registry,
        this.ctx.storage,
        Date.now(),
      ),
    );
    if (nativeRecovery)
      this.ctx.blockConcurrencyWhile(async () => {
        try {
          await this.recovery.resumePendingPiTurn();
        } finally {
          // An old quarantine ends here too; its checks keep any other work.
          await this.recovery.endInterruptedTurnQuarantine();
        }
      });
    if (!nativeRecovery)
      this.ctx.blockConcurrencyWhile(
        this.recovery.endOrQuarantineInterruptedTurn.bind(this.recovery),
      );
    const finalization = readAcceptedCheckpointFinalization(
      this.ctx.storage.sql,
    );
    if (
      (finalization.ok && finalization.value.kind === "pending") ||
      hasUnpublishedHarnessCheckpoint(this.ctx.storage.sql)
    )
      this.ctx.blockConcurrencyWhile(
        this.checkpoints.scheduleCheckpointFinalization.bind(this.checkpoints),
      );
  }

  protected acceptsActivation(input: ActorActivationRequest): boolean {
    return input.schemaVersion === CANONICAL_SESSION_SCHEMA_VERSION;
  }

  protected override async referencedArchiveKeys(): Promise<
    Result<Iterable<string>, ActorExportError>
  > {
    return {
      ok: true,
      value: [
        ...sessionPlacementR2Keys(this.ctx.storage.sql),
        ...sessionReachableAttachmentObjectKeys(this.ctx.storage.sql),
      ],
    };
  }

  async reconcileRelocationSettlements(
    request: RelocationSessionSettlementRequest,
  ) {
    return reconcileFrozenCodeModeSettlements(
      this.env,
      this.ctx.storage,
      request,
    );
  }

  protected quiesceForExport(expectedFenceToken: ActorFenceToken) {
    return this.quiescePortalChatCleanup({ expectedFenceToken });
  }

  protected override async prepareExport(
    quiesced: null,
  ): Promise<Result<PlacedActorExportSource, ActorExportError>> {
    // The export copies each checkpoint's archive object. The Session's own
    // copy of a payload does not move: the target reads the archive once.
    dropArchivedHarnessCheckpointPayloads(this.ctx.storage.sql);
    return super.prepareExport(quiesced);
  }

  async erasePortalChatSession(
    input: PortalChatCleanupRequest,
  ): Promise<Result<void, PortalChatCleanupError>> {
    if (
      !canAdmitSessionWork(this.ctx.storage.sql, input) ||
      this.shared.portalChatCleanup !== null
    )
      return { ok: false, error: { code: "chat_cleanup_conflict" } };
    this.shared.portalChatCleanup = this.admitPortalChatCleanup(input);
    try {
      return await this.shared.portalChatCleanup;
    } finally {
      this.shared.portalChatCleanup = null;
    }
  }

  async quiescePortalChatCleanup(input: {
    readonly expectedFenceToken: ActorFenceToken;
  }): Promise<Result<null, ActorExportError>> {
    const closed = closePortalChatCleanupAdmission(
      this.ctx.storage.sql,
      input.expectedFenceToken,
    );
    if (!closed.ok) return closed;
    if (this.shared.portalChatQuiescence === null)
      this.shared.portalChatQuiescence = this.drainPortalChatCleanup(
        closed.value,
      );
    const result = await this.shared.portalChatQuiescence;
    if (!result.ok) this.shared.portalChatQuiescence = null;
    return result;
  }

  async eraseHarnessHistory(
    input: HarnessHistoryErasureRequest,
  ): Promise<
    Result<
      HarnessHistoryErasure,
      CanonicalHarnessHistoryErasureError | OrganisationArchiveCleanupError
    >
  > {
    if (
      !(await canEraseArchivedHarnessHistory(
        this.env,
        this.ctx.storage.sql,
        input,
      ))
    )
      return {
        ok: false,
        error: { code: "organisation_archive_cleanup_conflict" },
      };
    await this.shared.activeMessagePreparation?.cancel();
    await this.shared.activeEmbeddedHarnessTurn?.turn.cancel();
    if (
      !(await canEraseArchivedHarnessHistory(
        this.env,
        this.ctx.storage.sql,
        input,
      ))
    )
      return {
        ok: false,
        error: { code: "organisation_archive_cleanup_conflict" },
      };
    return eraseHarnessHistoryForOrganisation(
      this.ctx.storage,
      input.requestingOrganisationId,
    );
  }

  async inspectHarnessHistoryReferences(input: {
    readonly requestingOrganisationId: OrganisationId;
  }): Promise<Result<readonly string[], CanonicalHarnessHistoryErasureError>> {
    const erasure = await readPortalChatErasure(this.ctx.storage);
    if (erasure !== null) {
      if (erasure.organisationId !== input.requestingOrganisationId)
        return {
          ok: false,
          error: { code: "canonical_session_organisation_mismatch" },
        };
      return {
        ok: true,
        value: erasure.kind === "pending" ? erasure.objectKeys : [],
      };
    }
    const session = await readCanonicalSessionForPersistence(
      this.shared.persistence,
      this.ctx.storage.sql,
      input.requestingOrganisationId,
    );
    if (!session.ok) return session;

    try {
      return {
        ok: true,
        value: sessionPlacementR2Keys(this.ctx.storage.sql),
      };
    } catch {
      return { ok: false, error: { code: "harness_history_invalid" } };
    }
  }

  protected override importSqlMigration(): ActorImportSqlMigration {
    return piDurableImportSchema;
  }

  async ping(): Promise<SessionPing> {
    return { ok: true, kind: "session" };
  }

  /** Every attachment object a turn of this session still names. */
  async listReachableAttachmentObjectKeys(): Promise<readonly string[]> {
    return sessionReachableAttachmentObjectKeys(this.ctx.storage.sql);
  }

  async inspectImportedCanonicalSession(input: {
    requestingOrganisationId: OrganisationId;
  }): Promise<
    Result<ImportedCanonicalSessionRecord, CanonicalSessionAccessError>
  > {
    return readCanonicalSessionForPersistence(
      this.shared.persistence,
      this.ctx.storage.sql,
      input.requestingOrganisationId,
    );
  }

  /**
   * Whether this instance is running a transient turn. A transient turn
   * runs only in the instance that took its call, so an instance that
   * started later runs none, whatever a stopped one left on record. The
   * alarm that closes those records was set for the end of the stopped
   * turn's lease. When no turn runs, and this Session may still act, that
   * alarm is brought forward to now.
   */
  async releaseStoppedTransientTurns(input: {
    readonly organisationId: OrganisationId;
    readonly sessionId: SessionId;
  }): Promise<
    Result<{ readonly kind: "running" | "idle" }, SessionInspectionError>
  > {
    const header = readSessionInspectionHeader(this.ctx.storage.sql, input);
    if (!header.ok) return header;
    if (this.shared.transientExecutions.size > 0)
      return { ok: true, value: { kind: "running" } };
    const now = Date.now();
    const alarmAt = await this.ctx.storage.getAlarm();
    if (alarmAt !== null && alarmAt > now) {
      const execution = await SessionExecutionAdmission.resolve(
        this.env,
        this.ctx.storage,
        input.organisationId,
      );
      // A turn that began during those reads keeps the alarm it set.
      if (execution !== null && this.shared.transientExecutions.size === 0)
        await this.ctx.storage.setAlarm(now);
    }
    return {
      ok: true,
      value: {
        kind: this.shared.transientExecutions.size > 0 ? "running" : "idle",
      },
    };
  }

  /**
   * A call from the conversation residency Actor. It does no work: the call
   * itself keeps this object in memory between the turns of a conversation.
   */
  async keepResident(): Promise<void> {}

  async inspectCanonicalSessionState(input: {
    readonly organisationId: OrganisationId;
    readonly sessionId: SessionId;
  }): Promise<Result<SessionInspection, SessionInspectionError>> {
    const header = readSessionInspectionHeader(this.ctx.storage.sql, input);
    if (!header.ok) return header;

    const alarmAt = await this.ctx.storage.getAlarm();
    const quiescence = inspectAgentSessionCutoverQuiescence({
      sql: this.ctx.storage.sql,
      organisationId: input.organisationId,
      sessionId: input.sessionId,
      inspectedAt: Date.now(),
      alarmAt,
      runtime: {
        persistence: "v28_canonical",
        lifecycleKind: header.value.lifecycleKind,
      },
    });
    if (!quiescence.ok) return quiescence;

    const budget = inspectSessionBudget(this.ctx.storage.sql, input);
    if (!budget.ok) return budget;

    const sessionProjection = readCanonicalSessionProjection(
      this.ctx.storage.sql,
      input.organisationId,
      input.sessionId,
    );
    if (sessionProjection === null) {
      return { ok: false, error: { code: "session_inspection_corrupt" } };
    }

    const checkpoint = await inspectSessionCheckpoint(
      this.ctx.storage.sql,
      input.organisationId,
      input.sessionId,
      sessionProjection.state.contract.modelRoute,
      this.harnessTurns.selectEmbeddedHarnessAdapter(
        sessionProjection.state.contract.modelRoute,
      ),
    );
    if (!checkpoint.ok) return checkpoint;

    return {
      ok: true,
      value: {
        identity: {
          organisationId: input.organisationId,
          sessionId: input.sessionId,
        },
        lifecycleKind: header.value.lifecycleKind,
        quiescence: quiescence.value,
        checkpoint: checkpoint.value,
        budget: budget.value.budget,
        reservation: budget.value.reservation,
        preparation: this.shared.activeMessagePreparation?.inspect() ?? {
          kind: "none",
        },
        latestMessageLinkReceipt: inspectLatestMessageLinkReceipt(
          this.ctx.storage.sql,
          input.sessionId,
        ),
      },
    };
  }

  async prepareSessionInformationFlow(
    input: SessionInformationFlowPreparationInput,
  ): Promise<
    Result<SessionInformationFlowPreparationResult, { readonly code: string }>
  > {
    const contextBundle = await restoreContextBundle(input.contextBundle);
    if (contextBundle === null)
      return { ok: false, error: { code: "invalid_persisted_state" } };
    const session = await readCanonicalSessionForPersistence(
      this.shared.persistence,
      this.ctx.storage.sql,
      input.requestingOrganisationId,
    );
    if (!session.ok) return { ok: false, error: { code: session.error.code } };
    if (
      session.value.sessionId !== input.sessionId ||
      (session.value.lifecycle.kind !== "sleeping" &&
        session.value.lifecycle.kind !== "processing")
    ) {
      return { ok: false, error: { code: "invalid_persisted_state" } };
    }
    if (
      contextBundle.organisationId !== input.requestingOrganisationId ||
      contextBundle.sessionId !== input.sessionId
    ) {
      return { ok: false, error: { code: "invalid_persisted_state" } };
    }
    const persisted = await readPersistedSessionTurnFlowBinding(
      this.ctx.storage.sql,
      {
        organisationId: input.requestingOrganisationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
      },
    );
    if (!persisted.ok)
      return { ok: false, error: { code: "invalid_persisted_state" } };
    if (persisted.value !== null) {
      return persisted.value.authorityPartitionDigest ===
        input.authorityPartitionDigest
        ? { ok: true, value: { flowBinding: persisted.value.binding.toJSON() } }
        : { ok: false, error: { code: "invalid_persisted_state" } };
    }
    const prepared = await prepareSessionInformationFlow({
      sql: this.ctx.storage.sql,
      organisationId: input.requestingOrganisationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      authorityPartitionDigest: input.authorityPartitionDigest,
      contextBundle,
    });
    return prepared.ok
      ? { ok: true, value: { flowBinding: prepared.value.binding.toJSON() } }
      : { ok: false, error: { code: prepared.error.code } };
  }

  async acceptCanonicalInput(
    input: AcceptedSessionInputCommit,
  ): Promise<
    Result<ActorTransitionCommitResult, CanonicalInputAcceptanceError>
  > {
    return commitAcceptedSessionInput(this.ctx.storage, input);
  }

  async initializeCanonicalSession(
    input: InitializedSessionCommit,
  ): Promise<
    Result<ActorTransitionCommitResult, CanonicalInputAcceptanceError>
  > {
    if ((await this.ctx.storage.get("portal-chat-erasure")) !== undefined)
      return { ok: false, error: { code: "invalid_transition" } };
    const workspaceReceipt =
      input.state.state.resumePoint.kind === "new"
        ? input.state.state.resumePoint.workspaceRevisionReceipt
        : input.state.state.resumePoint.checkpoint.workspaceRevisionReceipt;
    const organisationId = parseOrganisationId(
      input.state.state.identity.organisationId,
    );
    if (!organisationId.ok)
      return { ok: false, error: { code: "invalid_transition" } };
    const execution = await SessionExecutionAdmission.resolve(
      this.env,
      this.ctx.storage,
      organisationId.value,
    );
    if (execution === null)
      return { ok: false, error: { code: "invalid_transition" } };
    const verified = await verifyWorkspaceRevisionReceipt(
      execution.scope,
      input.state.state.identity.organisationId,
      workspaceReceipt,
    );
    if (!verified.ok) {
      return {
        ok: false,
        error: {
          code: "workspace_revision_receipt_invalid",
          reason: verified.error.code,
        },
      };
    }
    return commitInitializedSession(this.ctx.storage, input);
  }

  async inspectCaseSessionInitialization(
    input: InitializedCaseSessionCommit,
  ): Promise<
    Result<
      { readonly kind: "missing" | "initialized" },
      { readonly code: string }
    >
  > {
    const assignment = parseStoredCaseAssignment(input.assignment);
    const organisationId = parseOrganisationId(
      input.initialization.state.state.identity.organisationId,
    );
    const sessionId = parseSessionId(
      input.initialization.state.state.identity.sessionId,
    );
    if (
      assignment === null ||
      !organisationId.ok ||
      !sessionId.ok ||
      assignment.sessionId !== sessionId.value ||
      assignment.authorityPartition.key.organisationId !== organisationId.value
    )
      return { ok: false, error: { code: "invalid_transition" } };
    const execution = await SessionExecutionAdmission.resolve(
      this.env,
      this.ctx.storage,
      organisationId.value,
    );
    if (
      execution === null ||
      !(await execution.isActive()) ||
      !canAdmitSessionWork(this.ctx.storage.sql, {
        requestingOrganisationId: organisationId.value,
        sessionId: sessionId.value,
        placement: execution.scope.placement,
      })
    )
      return { ok: false, error: { code: "session_placement_conflict" } };
    const previous = readCaseSessionAssignment(this.ctx.storage.sql);
    if (previous === null) {
      const parent = this.ctx.storage.sql
        .exec("SELECT 1 FROM session_case_parent WHERE singleton = 1")
        .toArray();
      return parent.length === 0
        ? { ok: true, value: { kind: "missing" } }
        : { ok: false, error: { code: "invalid_transition" } };
    }
    const state = readCanonicalSessionProjection(
      this.ctx.storage.sql,
      organisationId.value,
      assignment.sessionId,
    );
    const budget = readSessionBudgetAccount(this.ctx.storage.sql, {
      organisationId: organisationId.value,
      sessionId: assignment.sessionId,
    });
    if (
      !sameJson(previous, assignment) ||
      !sameJson(state, input.initialization.state) ||
      !budget.ok ||
      !sameJson(budget.value.budget, assignment.budget)
    )
      return {
        ok: false,
        error: { code: "case_session_initialization_conflict" },
      };
    if (!(await execution.isActive()))
      return { ok: false, error: { code: "session_placement_conflict" } };
    return { ok: true, value: { kind: "initialized" } };
  }

  async initializeCaseSession(
    input: InitializedCaseSessionCommit,
  ): Promise<
    Result<ActorTransitionCommitResult, CanonicalInputAcceptanceError>
  > {
    const organisationId = parseOrganisationId(
      input.initialization.state.state.identity.organisationId,
    );
    const sessionId = parseSessionId(
      input.initialization.state.state.identity.sessionId,
    );
    if (!organisationId.ok || !sessionId.ok)
      return { ok: false, error: { code: "invalid_transition" } };
    const [execution, erasure] = await Promise.all([
      SessionExecutionAdmission.resolve(
        this.env,
        this.ctx.storage,
        organisationId.value,
      ),
      this.ctx.storage.get("portal-chat-erasure"),
    ]);
    if (
      execution === null ||
      !canAdmitSessionWork(this.ctx.storage.sql, {
        requestingOrganisationId: organisationId.value,
        sessionId: sessionId.value,
        placement: execution.scope.placement,
      })
    )
      return { ok: false, error: { code: "invalid_transition" } };
    if (erasure !== undefined)
      return { ok: false, error: { code: "invalid_transition" } };
    // Verify the receipt and captured placement in one authoritative read.
    // Export can close local admission while that read is pending.
    const workspaceReceipt =
      input.initialization.state.state.resumePoint.kind === "new"
        ? input.initialization.state.state.resumePoint.workspaceRevisionReceipt
        : input.initialization.state.state.resumePoint.checkpoint
            .workspaceRevisionReceipt;
    const verified = await verifyWorkspaceRevisionReceipt(
      execution.scope,
      organisationId.value,
      workspaceReceipt,
    );
    if (!verified.ok) {
      if (verified.error.code === "organisation_placement_conflict")
        return { ok: false, error: { code: "invalid_transition" } };
      return {
        ok: false,
        error: {
          code: "workspace_revision_receipt_invalid",
          reason: verified.error.code,
        },
      };
    }
    if (
      !canAdmitSessionWork(this.ctx.storage.sql, {
        requestingOrganisationId: organisationId.value,
        sessionId: sessionId.value,
        placement: execution.scope.placement,
      })
    )
      return { ok: false, error: { code: "invalid_transition" } };
    return commitInitializedCaseSession(this.ctx.storage, input);
  }

  async activateCanonicalRuntime(
    input: RuntimeActivatedSessionCommit,
  ): Promise<
    Result<ActorTransitionCommitResult, CanonicalInputAcceptanceError>
  > {
    return commitRuntimeActivatedSession(this.ctx.storage, input);
  }

  /**
   * Admit a steering input into the running turn (Plan 71). Only the turn's
   * requester may steer it, with text. The input runs under the turn's
   * authority and budget, and it has the label of the turn's starting input:
   * it comes from the same person in the same conversation, so the turn's
   * binding already holds that label. A refusal is a result: the surface then
   * runs the message as the next turn.
   */
  async steerCanonicalEmbeddedHarnessTurn(
    input: SessionSteerTurnInput,
  ): Promise<
    Result<
      SessionSteerTurnResult,
      | {
          readonly code:
            | "invalid_config"
            | "steering_request_conflict"
            | "steering_journal_unavailable";
        }
      | EmbeddedHarnessSteerError
    >
  > {
    const requestId = parseRequestId(input.requestId);
    const organisationId = parseOrganisationId(input.organisationId);
    const sessionId = parseSessionId(input.sessionId);
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (
      !requestId.ok ||
      !organisationId.ok ||
      !sessionId.ok ||
      text.length === 0 ||
      text.length > MAX_STEERING_TEXT_CHARS ||
      !steeringMessageHasNoFiles(input.message)
    )
      return { ok: false, error: { code: "invalid_config" } };
    const active = this.shared.activeEmbeddedHarnessTurn;
    if (
      active === null ||
      active.lease.session.organisationId !== organisationId.value ||
      active.lease.session.sessionId !== sessionId.value ||
      !preflightHarnessTurnLease(this.ctx.storage, active.lease, Date.now()).ok
    )
      return {
        ok: true,
        value: { kind: "refused", reason: "turn_not_running" },
      };
    if (
      !steeringRequesterMatches(active.lease.requestAuthority, input.requester)
    )
      return {
        ok: true,
        value: { kind: "refused", reason: "requester_mismatch" },
      };
    const acceptedInput = active.acceptedInput;
    const triggerEntryId = turnTriggerEntryId(String(active.lease.turn.turnId));
    if (acceptedInput.kind !== "case" || triggerEntryId === null)
      return {
        ok: true,
        value: { kind: "refused", reason: "steering_unsupported" },
      };
    const steeringInput: readonly EmbeddedHarnessUserInput[] = [
      { kind: "text", text },
    ];
    const inputId = `steer_${(await sha256Hex(requestId.value)).slice(0, 32)}`;
    const inputRef: AcceptedInputRef = {
      ...acceptedInput,
      inputId,
      contentDigest: await sha256Hex(text),
    };
    const admission = this.ctx.storage.transactionSync(() =>
      admitSteeringInput(this.ctx.storage.sql, {
        sessionId: sessionId.value,
        turnId: String(active.lease.turn.turnId),
        inputId,
        requestId: requestId.value,
        inputRef,
        content: steeringInput.map(toHistoryContent),
        message: input.message,
        admittedAt: Date.now(),
      }),
    );
    if (admission.kind === "conflict")
      return { ok: false, error: { code: "steering_request_conflict" } };
    if (admission.kind === "duplicate" && admission.input.state !== "admitted")
      return {
        ok: true,
        value:
          admission.input.state === "withdrawn"
            ? { kind: "refused", reason: "turn_not_running" }
            : { kind: "accepted", inputId },
      };
    // The Case journals the message when the turn ends, and only if the turn
    // placed it (journalPlacedSteeringInputs). A message that the turn did
    // not read leaves no Case entry, so a surface can run it as a new turn.
    const steered = await active.turn.steer({ inputId, input: steeringInput });
    if (!steered.ok) {
      markSteeringInputWithdrawn(
        this.ctx.storage.sql,
        sessionId.value,
        inputId,
      );
      return steered;
    }
    if (steered.value.kind === "refused") {
      markSteeringInputWithdrawn(
        this.ctx.storage.sql,
        sessionId.value,
        inputId,
      );
      return {
        ok: true,
        value: { kind: "refused", reason: steered.value.reason },
      };
    }
    return { ok: true, value: { kind: "accepted", inputId } };
  }

  /**
   * The state of a steering input that a surface sent (Plan 71). A surface
   * that parked a message as steered asks this when the turn ends: `placed`
   * means the turn read it, `withdrawn` that the surface runs it next.
   */
  async readSteeringInputState(input: {
    readonly organisationId: OrganisationId;
    readonly sessionId: SessionId;
    readonly requestId: RequestId;
  }): Promise<
    Result<
      { readonly state: SteeringInputState | "missing" },
      { readonly code: "invalid_config" }
    >
  > {
    const organisationId = parseOrganisationId(input.organisationId);
    const sessionId = parseSessionId(input.sessionId);
    const requestId = parseRequestId(input.requestId);
    if (!organisationId.ok || !sessionId.ok || !requestId.ok)
      return { ok: false, error: { code: "invalid_config" } };
    const sql = this.ctx.storage.sql;
    const steering = readSteeringInputByRequest(
      sql,
      sessionId.value,
      requestId.value,
    );
    if (steering === null) return { ok: true, value: { state: "missing" } };
    const live = this.shared.activeEmbeddedHarnessTurn?.lease.turn.turnId;
    const settled = this.ctx.storage.transactionSync(() =>
      settledSteeringInput(
        sql,
        steering,
        live === undefined ? null : String(live),
      ),
    );
    return { ok: true, value: { state: settled.state } };
  }

  async interruptCanonicalEmbeddedHarnessTurn(
    input: SessionInterruptTurnInput,
  ): Promise<
    Result<
      SessionInterruptTurnResult,
      | CanonicalSessionAccessError
      | CanonicalEmbeddedHarnessCancellationError
      | CanonicalTextTurnTransitionError
      | SessionTurnStreamError
      | ActorTransitionCommitError
      | TurnStateInvalidError
      | {
          readonly code: "invalid_config" | "organisation_mismatch";
        }
    >
  > {
    const requestId = parseRequestId(input.requestId);
    const organisationId = parseOrganisationId(input.organisationId);
    const sessionId = parseSessionId(input.sessionId);
    if (
      !requestId.ok ||
      !organisationId.ok ||
      !sessionId.ok ||
      !Number.isSafeInteger(input.interruptedAt) ||
      input.interruptedAt < 0
    ) {
      return { ok: false, error: { code: "invalid_config" } };
    }
    const current = await readCanonicalSessionForPersistence(
      this.shared.persistence,
      this.ctx.storage.sql,
      organisationId.value,
    );
    if (!current.ok) return current;
    if (current.value.lifecycle.state.identity.sessionId !== sessionId.value) {
      return { ok: false, error: { code: "invalid_config" } };
    }
    if (current.value.lifecycle.kind === "recovering") {
      const turnId =
        current.value.lifecycle.state.activeTurn.state.identity.turnId;
      const cancellation = buildRecoveringSessionCancellation({
        current: current.value.lifecycle,
        event: {
          operationId: `cancel_${requestId.value}`,
          acceptedAt: input.interruptedAt,
        },
      });
      if (!cancellation.ok)
        return {
          ok: false,
          error: {
            code: "canonical_text_turn_state_invalid",
            reason: "recovery_cancellation_invalid",
          },
        };
      const cancelled =
        await this.harnessTurns.cancelCanonicalEmbeddedHarnessTurn(
          cancellation.value,
        );
      if (!cancelled.ok) return cancelled;
      discardHarnessTurnContinuation(this.ctx.storage.sql);
      const failed = failOrphanedSessionTurnStreams(
        this.ctx.storage.sql,
        input.interruptedAt,
      );
      if (!failed.ok) return failed;
      return { ok: true, value: { kind: "interrupted", turnId } };
    }
    if (current.value.lifecycle.kind !== "processing") {
      const failed = failOrphanedSessionTurnStreams(
        this.ctx.storage.sql,
        input.interruptedAt,
      );
      if (!failed.ok) return failed;
      return { ok: true, value: { kind: "no_active_turn" } };
    }
    const leaseRow = this.ctx.storage.sql
      .exec<{ lease_projection: string }>(
        `SELECT lease_projection
       FROM session_harness_lease
       WHERE session_id = ?
       LIMIT 1`,
        sessionId.value,
      )
      .toArray()[0];
    const lease = parseHarnessTurnLeaseProjection(leaseRow?.lease_projection);
    if (lease === null) {
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "lease_missing",
        },
      };
    }
    const turnId =
      current.value.lifecycle.state.activeTurn.state.identity.turnId;
    const cancellationAcceptedAt = Math.min(
      input.interruptedAt,
      lease.expiresAt - 1,
    );
    if (cancellationAcceptedAt < lease.issuedAt) {
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "lease_expired",
        },
      };
    }
    const cancellation = buildTextTurnCancellationStartedCommit({
      current: current.value.lifecycle,
      harnessLease: lease,
      cancellation: {
        cancellationId: `cancel_${requestId.value}`,
        correlationId: requestId.value,
        acceptedAt: cancellationAcceptedAt,
      },
    });
    if (!cancellation.ok) return cancellation;
    const interrupted =
      await this.harnessTurns.cancelCanonicalEmbeddedHarnessTurn(
        cancellation.value,
      );
    if (!interrupted.ok) return interrupted;
    traceLog("session.canonical_turn_interrupted", {
      requestId: requestId.value,
      organisation_id: organisationId.value,
      session_id: sessionId.value,
      turn_id: turnId,
      interrupted_at: input.interruptedAt,
    });
    return { ok: true, value: { kind: "interrupted", turnId } };
  }

  async restoreCanonicalHarnessCheckpoint(input: {
    requestingOrganisationId: OrganisationId;
    checkpoint: HarnessCheckpointRecord;
  }): Promise<Result<ArrayBuffer, CanonicalHarnessCheckpointRestoreError>> {
    const session = await readCanonicalSessionForPersistence(
      this.shared.persistence,
      this.ctx.storage.sql,
      input.requestingOrganisationId,
    );
    if (!session.ok) return session;
    const account = readSessionBudgetAccount(this.ctx.storage.sql, {
      organisationId: input.requestingOrganisationId,
      sessionId: input.checkpoint.session.sessionId,
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
      checkpoint: input.checkpoint,
      account: account.value,
    });
    if (!binding.ok) return binding;
    const adapter = selectEmbeddedHarnessAdapterForModelRoute(
      session.value.lifecycle.state.contract.modelRoute,
    );
    return loadCanonicalHarnessCheckpoint({
      bucket: this.env.ARCHIVE,
      root: this.env.DATA_ENCRYPTION_ROOT,
      state: session.value.lifecycle,
      checkpoint: input.checkpoint,
      manifest: adapter.manifest,
      sql: this.ctx.storage.sql,
    });
  }

  async resolveCanonicalEmbeddedHarnessInput(input: {
    requestingOrganisationId: OrganisationId;
    lease: HarnessTurnLease;
    turnPrompt: string;
  }): Promise<
    Result<CanonicalEmbeddedHarnessInput, CanonicalEmbeddedHarnessInputError>
  > {
    const execution = await SessionExecutionAdmission.resolve(
      this.env,
      this.ctx.storage,
      input.requestingOrganisationId,
    );
    if (execution === null || !(await execution.isActive()))
      return { ok: false, error: { code: "invalid_persisted_state" } };
    return this.harnessTurns.readCanonicalEmbeddedHarnessInput({
      execution,
      requestingOrganisationId: input.requestingOrganisationId,
      lease: input.lease,
      turnPrompt: input.turnPrompt,
      resolvedCatalog: null,
    });
  }

  async readConfirmedContextObservations(input: {
    readonly requestingOrganisationId: OrganisationId;
    readonly sessionId: SessionId;
  }): Promise<readonly ChatContextDetails[]> {
    const session = await readCanonicalSessionForPersistence(
      this.shared.persistence,
      this.ctx.storage.sql,
      input.requestingOrganisationId,
    );
    if (
      !session.ok ||
      session.value.lifecycle.state.identity.sessionId !== input.sessionId
    )
      return [];
    const flow = await readSessionInformationFlow(this.ctx.storage.sql, {
      organisationId: input.requestingOrganisationId,
      sessionId: input.sessionId,
    });
    if (!flow.ok || flow.value === null) return [];
    const contexts: ChatContextDetails[] = [];
    for (const evidence of flow.value.observations) {
      const context = confirmedContextObservation(evidence);
      if (context !== null) contexts.push(context);
    }
    return contexts.slice(-12);
  }

  async startCanonicalEmbeddedHarnessTextTurn(
    input: CanonicalTextTurnInput,
  ): Promise<
    Result<
      CanonicalEmbeddedHarnessTextTurnResult,
      CanonicalEmbeddedHarnessTextTurnError
    >
  > {
    if (this.shared.canonicalTurn !== null)
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "turn_running",
        },
      };
    const work = this.harnessTurns.prepareCanonicalTextTurn(input);
    this.shared.canonicalTurn = settleActorExecution(work);
    try {
      return await work;
    } finally {
      this.shared.canonicalTurn = null;
      this.shared.startedCheckpointPayload = null;
    }
  }

  async settleBakerySurfaceEffect(input: {
    readonly requestingOrganisationId: OrganisationId;
    readonly receipt: PageEffectReceipt;
  }): Promise<PageEffectSettlement> {
    const execution = await SessionExecutionAdmission.resolve(
      this.env,
      this.ctx.storage,
      input.requestingOrganisationId,
    );
    if (execution === null)
      return { ok: false, code: "surface_effect_authority_invalid" };
    return this.sessionTools().pageEffects.settle({
      db: execution.scope.database,
      storage: this.ctx.storage,
      organisationId: input.requestingOrganisationId,
      receipt: input.receipt,
    });
  }

  async replayStream(
    input: SessionReplayInput,
  ): Promise<Result<Response, SessionStateError>> {
    const session = await readCanonicalSessionForPersistence(
      this.shared.persistence,
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!session.ok) {
      return session.error.code === "canonical_session_organisation_mismatch"
        ? { ok: false, error: { code: "organisation_mismatch" } }
        : { ok: false, error: { code: "session_not_initialized" } };
    }
    return createSessionReplayResponse(this, input);
  }

  /**
   * The execution records of this Session with each turn's stored label, for
   * the Case execution projection. The caller decides what its reader may
   * see. Null means that this is not the Session the caller named.
   */
  async readExecutionRecords(input: {
    readonly organisationId: OrganisationId;
    readonly sessionId: SessionId;
  }): Promise<CaseExecutionSessionRecords | null> {
    const session = await readCanonicalSessionForPersistence(
      this.shared.persistence,
      this.ctx.storage.sql,
      input.organisationId,
    );
    return session.ok && session.value.sessionId === input.sessionId
      ? readSessionExecutionRecords(this.ctx.storage.sql, input.sessionId)
      : null;
  }

  /** The stored content of one tool call. The caller authorized the read. */
  async readExecutionContent(input: {
    readonly organisationId: OrganisationId;
    readonly sessionId: SessionId;
    readonly target: SessionExecutionContentTarget;
  }): Promise<readonly CaseExecutionStoredContent[] | null> {
    const session = await readCanonicalSessionForPersistence(
      this.shared.persistence,
      this.ctx.storage.sql,
      input.organisationId,
    );
    return session.ok && session.value.sessionId === input.sessionId
      ? readSessionExecutionContent(
          this.ctx.storage.sql,
          input.sessionId,
          input.target,
        )
      : null;
  }

  async inspectTurnStream(
    raw: unknown,
  ): Promise<Result<SessionTurnInspection, SessionStateError>> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, error: { code: "invalid_config" } };
    }
    const input = raw as Record<string, unknown>;
    const organisationId =
      typeof input.organisationId === "string"
        ? parseOrganisationId(input.organisationId)
        : null;
    if (
      organisationId === null ||
      !organisationId.ok ||
      typeof input.turnId !== "string" ||
      input.turnId.length === 0
    ) {
      return { ok: false, error: { code: "invalid_config" } };
    }
    const stream = readSessionTurnStream(this.ctx.storage.sql, input.turnId);
    if (!stream.ok) {
      return stream.error.code === "session_turn_not_found"
        ? { ok: true, value: { kind: "missing" } }
        : stream;
    }
    if (stream.value.organisationId !== organisationId.value)
      return { ok: false, error: { code: "organisation_mismatch" } };
    return { ok: true, value: { kind: "present", state: stream.value.kind } };
  }

  async readCompletedChatHistory(input: {
    readonly organisationId: OrganisationId;
    readonly sessionId: SessionId;
    readonly turnId: string;
    readonly throughSequence: number | null;
  }): Promise<string> {
    const completed = await this.checkpoints.readCompletedTurn(input);
    if (!completed.ok) throw new Error("chat_fork_boundary_unavailable");
    const materialized = await readHarnessHistory(
      this.ctx.storage.sql,
      input.sessionId,
      input.organisationId,
      input.throughSequence ?? undefined,
    );
    if (
      !materialized.ok ||
      materialized.value.kind !== "bounded_history" ||
      materialized.value.history.cursor === null
    )
      throw new Error("chat_fork_history_unavailable");
    assertCompletedHistory(materialized.value.history.entries);
    return JSON.stringify({
      entries: materialized.value.history.entries,
      bindings: [completed.value.flowBinding],
      cursor: materialized.value.history.cursor,
    });
  }

  async inspectCutoverQuiescence(input: {
    readonly organisationId: OrganisationId;
    readonly sessionId: SessionId;
  }): Promise<
    Result<
      SessionCutoverQuiescence,
      SessionCutoverInspectionError | CanonicalSessionAccessError
    >
  > {
    const record = await readCanonicalSessionForPersistence(
      this.shared.persistence,
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!record.ok) return record;
    if (record.value.sessionId !== input.sessionId) {
      return { ok: false, error: { code: "session_mismatch" } };
    }
    const alarmAt = await this.ctx.storage.getAlarm();
    return inspectAgentSessionCutoverQuiescence({
      sql: this.ctx.storage.sql,
      organisationId: input.organisationId,
      sessionId: input.sessionId,
      inspectedAt: Date.now(),
      alarmAt,
      runtime: {
        persistence: "v28_canonical",
        lifecycleKind: record.value.lifecycle.kind,
      },
    });
  }

  /** Runs in a row with a failed alarm step; the backoff grows with it. */
  private readonly alarmRetries = { failures: 0 };

  /**
   * The Session's alarm. Each step runs on its own (Refactor 15, S3): a step
   * that fails does not stop the steps after it, and the alarm comes back
   * for it after a backoff.
   */
  async alarm(): Promise<void> {
    const billed = await runAlarmSteps("session", [
      {
        name: "execution_billing",
        run: () =>
          reconcilePantryExecutionBilling({
            env: this.env,
            storage: this.ctx.storage,
          }),
      },
    ]);
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (admission.kind !== "admitted") return;
    const failed = await runAlarmSteps("session", [
      {
        name: "checkpoint_finalization",
        run: () => this.recovery.resumeAcceptedCheckpointFinalization(),
      },
      { name: "run_budget_deadline", run: () => this.endExhaustedRun() },
      {
        name: "code_mode_settlements",
        run: () =>
          reconcileCodeModeSettlements({
            env: this.env,
            storage: this.ctx.storage,
          }),
      },
      // An old quarantine settles its old Code Mode settlements and ends.
      {
        name: "quarantine_end",
        run: () => this.recovery.endInterruptedTurnQuarantine(),
      },
      {
        name: "ended_executions",
        run: () => this.shared.releaseEndedExecutions(),
      },
      {
        name: "bakery_surface_effects",
        run: () =>
          this.sessionTools().pageEffects.reconcile({
            db: admission.scope.database,
            storage: this.ctx.storage,
          }),
      },
      {
        name: "goal_usage",
        run: () =>
          reconcileSessionGoalUsage({
            env: this.env,
            storage: this.ctx.storage,
            liveRuns: this.shared.liveGoalRuns,
          }),
      },
      {
        name: "pending_pi_turn",
        run: () => this.recovery.resumePendingPiTurn(),
      },
      {
        name: "run_budget_deadline_arm",
        run: () => schedulePersistedRunBudgetDeadline(this.ctx.storage),
      },
    ]);
    await armAlarmAfterFailedSteps(this.ctx.storage, this.alarmRetries, [
      ...billed,
      ...failed,
    ]);
  }

  /** Ends the turn whose run budget passed its deadline or ran out. */
  private async endExhaustedRun(): Promise<void> {
    const budget = reconcileCanonicalRunBudgetDeadline(
      this.ctx.storage,
      Date.now(),
    );
    const exhaustion = budget.ok
      ? budget.value.kind === "exhausted"
        ? budget.value.exhaustion
        : null
      : budget.error.code === "budget_exhausted"
        ? budget.error.exhaustion
        : null;
    if (exhaustion === null) return;
    const lease = readCurrentHarnessTurnLease(this.ctx.storage.sql);
    const organisationId =
      lease === null ? null : parseOrganisationId(lease.session.organisationId);
    if (lease === null || organisationId?.ok !== true) return;
    await this.harnessTurns.resolveFailedTurn({
      organisationId: organisationId.value,
      lease,
      cancellationId: `cancel_${exhaustion.exhaustionId}`,
      correlationId: exhaustion.exhaustionId,
      acceptedAt: exhaustion.exhaustedAt,
    });
    failSessionTurnStream(
      this.ctx.storage.sql,
      lease.turn.turnId,
      "budget_exhausted",
      exhaustion.exhaustedAt,
    );
  }
}
