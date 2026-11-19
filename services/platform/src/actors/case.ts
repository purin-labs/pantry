import {
  censusOfActorMachines,
  type MachineCensus,
} from "./lifecycle/machine-census";
import {
  authorizeActionMutationExecution,
  parseActionMutationExecution,
  type ActionMutationExecution,
} from "./action-mutation-execution";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { parseSlackGoalCommand } from "../slack/goal-command";
import {
  type GoalAdmission,
  createCaseGoalSchema,
  readCaseGoal,
  bindCaseGoalExecution,
  closeCaseGoalExecution,
  parseGoalExecutionRequest,
  applyCaseGoalCommand,
  admitCaseGoalOperation,
  acceptCaseGoalUsage,
  parseGoalIdentity,
  parseGoalCommandRequest,
  parseGoalAdmissionRequest,
  parseGoalUsageRequest,
} from "./case-goals";
import type {
  MailInboxWork,
  MailWorkAssignment,
  MailWorkReply,
} from "@purin-labs/control-api";
import {
  mailWorkCaseState,
  mailWorkAssignment,
  mailWorkReply,
} from "../mail-inbox/work-projection";
import {
  readCaseExecutionContent,
  readCaseExecutionRecords,
} from "./case-execution-records";
import type {
  CaseExecutionCaseRecords,
  CaseExecutionContentTarget,
  CaseExecutionStoredContent,
} from "../case-execution/records";
import {
  createConversationExecutionSchema,
  persistConversationExecution,
  readConversationExecution,
  type ConversationExecution,
} from "../chat/execution";
import { reachableAttachmentObjectKeys } from "../messages/attachment-reachability";
import type {
  CaseGoalSnapshot,
  CaseAssignmentLifecycle,
} from "@purin-labs/contracts";
import type { Env } from "../env";
import { requireActiveOrganisationActor } from "./actor-router";
import {
  newRequestId,
  parseOrganisationId,
  type CaseId,
  type OrganisationId,
} from "../ids";
import { traceLog, traceWarn } from "../observability";
import { parseEmailReplyProposalLifecycle } from "../data/email-mailbox";
import { emailReplyProposalTransition } from "../data/email-reply-proposal-lifecycle";
import {
  createActorActivationSchema,
  admitActorRecovery,
  pinnedActorDatabase,
  inspectActorActivation,
  type ActorActivationInspection,
} from "./actor-activation";
import {
  actorExecutionAdmissionOpen,
  closeActorExecutionAdmission,
  createActorExecutionBarrierSchema,
  settleActorExecution,
} from "./actor-execution-quiescence";
import { createActorImportSchema, type ActorExportError } from "./actor-export";
import type {
  ActorActivationRequest,
  ActorActivationIdentity,
  ActorFenceToken,
} from "./actor-registry";
import { CASE_ACTOR_SCHEMA_VERSION } from "./actor-schema-versions";
import type {
  CaseContextSource,
  CaseContextSourceReader,
  CaseContextSourceReaderError,
} from "../context/projection";
import type {
  CaseContextTailCandidate,
  CaseContextTailReader,
} from "../context/assembly";
import { parseStoredRequestAuthority } from "../request-authority";
import type { Result } from "../result";
import {
  advanceInformationFlowContext,
  digestFlowBinding,
  flowBindingForContext,
  FlowLabel,
  InformationFlowContext,
  ObservationEvidence,
} from "../policy";
import type { SerializedFlowBinding } from "../policy";
import { sourceReaderForAuthority } from "../policy/information-flow/source-readers";
import { errorMessage, isRecord, parseJsonOrNull, sha256Hex } from "@purin-labs/std";
import { PlacedActor } from "./lifecycle/placed-actor";
import {
  armAlarmBy,
  rearmActorAlarm,
  runAlarmStepsTogether,
} from "./lifecycle/actor-alarm";
import {
  APPROVAL_MISSING_ACTION_LAPSE_MS,
  caseAlarmReconcilers,
  caseWakeAlarmAt,
  commerceApprovalsToRead,
} from "./case-alarm";
import { ASSIGNMENT_ABANDON_AFTER_MS } from "./case/assignment.machine";
import {
  hasStaleAssignment,
  logAbandonSkipped,
  staleAssignmentCensus,
} from "./case/assignment-census";
import { runCaseSchemaMigrations } from "./case-schema";
import {
  contextSourceDigestMatches,
  enqueueCaseContextProjection,
  flowLabelForAuthority,
  ignoreUnusedFlowLabel,
  readCaseContextSource,
  readCaseContextTail,
  readCommerceProposalFlowBinding,
  readJournal,
  readAssignmentLifecycles,
  readMeta,
  readOutputFlowBinding,
  replayAuthorityForFlowBinding,
  replayAuthorityForPartition,
  restoreCaseOutput,
  restoreCaseProposalAcceptance,
  restoreCaseSnapshot,
  restoreOutputLifecycle,
  serializeCaseOutput,
  serializeCaseProposalAcceptance,
  serializeCaseSnapshot,
  serializeOutputLifecycle,
  readCommerceApproval,
} from "./case/context-source";
import {
  acceptCaseProposalWithProjections,
  acceptCaseSteeringInput,
  acceptCaseTrigger,
  acceptGoalMessage,
  abandonCaseAssignment,
  assignCaseSession,
  attachCaseBinding,
  beginCaseAssignment,
  ensureCase,
  parseCaseSteeringInput,
  prepareOngoingCaseTurn,
  retainContextProjection,
  settleCaseAssignment,
} from "./case/lifecycle";
import {
  appendJournal,
  dropCaseOutput,
  dropUndeliveredOutputs,
  holdCaseOutputLifecycle,
  rejectCaseOutputLifecycle,
  droppedOutputNote,
  inspectCase,
  refusedEffectNote,
  settleCaseOutput,
} from "./case/outputs";
import {
  type CommerceApprovalNotice,
  acceptCommerceEntityPlaneProposal,
  acceptCommerceOutcome,
  acceptCommerceProposal,
  lapseCommerceApproval,
  reconcileCommerceApprovalWait,
  resolveCommerceApproval,
  waitForCommerceApproval,
} from "./case/proposals";
import {
  equal,
  flowLabelForTrigger,
  invalid,
  isOpen,
  parseAssignmentLifecycleJson,
  parseCaseAssignment,
  parseCaseBinding,
  parseCaseContent,
  parseCaseTrigger,
  parseGoalMessage,
  parseLifecycle,
} from "./case/record-parsers";
import {
  bindMerchantCommerceProposal,
  commerceMutationMatchesProposal,
  isEntityPlaneCommerceProposalRequest,
  parseAcceptCommerceEntityPlaneProposalRequest,
  parseAcceptCommerceOutcomeRequest,
  parseAcceptCommerceProposalRequest,
  parseAcceptDeliveryReceiptRequest,
  parseAcceptProposalRequest,
  parseAbandonAssignmentRequest,
  parseBeginAssignmentRequest,
  parseCaseEmailProposal,
  parseCaseEmailProposalJson,
  parseCaseEnsureRequest,
  parseCommerceProposalAcceptance,
  parseDropHeldOutputRequest,
  parseNoteRefusedEffectRequest,
  parsePersistedCommerceProposalJson,
  parsePrepareOngoingCaseTurnRequest,
  parseResolveCommerceApprovalRequest,
  parseSettleAssignmentRequest,
  parseWaitForCommerceApprovalRequest,
  readCaseMetaId,
} from "./case/request-parsers";
import type {
  CaseCommerceOutcomeAcceptance,
  CaseEmailProposal,
  CaseOutput,
  CaseOutputLifecycle,
  CaseProposalAcceptance,
  CaseResult,
  CaseSnapshot,
  CaseTriggerRecord,
  CommerceEntityPlaneCaseProposal,
  JsonRow,
  LifecycleRow,
  ProposalRow,
  QuarantinedCaseDiscardResult,
} from "./case/types";
import type { Variant } from "@purin-labs/type-utils";

/** What a Case did with the ledger entry of the action that it waits on. */
type CommerceApprovalSync = Readonly<{
  kind: "waiting" | "decided" | "lapsed" | "not_waiting";
  revision: number;
}>;

export class CaseDO
  extends PlacedActor<null>
  implements CaseContextSourceReader
{
  /** State counts of this Actor's machines, for the census (Refactor 15, S5). */
  async machineCensus(): Promise<readonly MachineCensus[]> {
    const alarm = await this.ctx.storage.getAlarm();
    const now = Date.now();
    const census = censusOfActorMachines(this.ctx.storage.sql, { alarm, now });
    const stale = staleAssignmentCensus(this.ctx.storage.sql, alarm, now);
    return stale === null ? census : [...census, stale];
  }

  private discarded = false;
  private projectionWork: Promise<void> | null = null;
  private readonly executions = new Set<
    Promise<Result<null, ActorExportError>>
  >();
  private conversationWork: Promise<Result<null, ActorExportError>> | null =
    null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { executionBarrier: true });
    const startedAt = Date.now();
    this.ctx.storage.transactionSync(
      createCaseSchema.bind(null, this.ctx.storage.sql),
    );
    console.log(
      JSON.stringify({
        event: "case.schema_ready",
        started_at: startedAt,
        duration_ms: Date.now() - startedAt,
      }),
    );
    // Only new work sets the wakeup of its alarm step. A row from a release
    // before that step has none, so the Case sets it when it wakes.
    const wakeAt = caseWakeAlarmAt(this.ctx.storage.sql, Date.now());
    if (wakeAt !== null)
      void this.ctx.blockConcurrencyWhile(() =>
        armAlarmBy(this.ctx.storage, wakeAt),
      );
  }

  // Internal RPCs; operator authorization belongs to the control-plane caller.
  async acceptGoalMessage(raw: unknown): Promise<CaseResult<CaseOutput>> {
    if (this.discarded) return invalid("case_discarded");
    const input = parseGoalMessage(raw);
    if (input === null) return invalid("goal_request_invalid");
    const command = parseSlackGoalCommand(input.text);
    if (command.kind === "ordinary") return invalid("goal_request_invalid");
    const digest = await sha256Hex(
      JSON.stringify({
        text: input.text,
        requestAuthority: input.requestAuthority,
      }),
    );
    const contentDigest = await sha256Hex(
      JSON.stringify({ kind: "text", text: input.text }),
    );
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (
      admission.kind !== "admitted" ||
      admission.scope.organisationId !== input.organisationId
    ) {
      return invalid("case_request_invalid");
    }
    const label = await flowLabelForAuthority(
      admission.scope.database,
      input.requestAuthority,
    );
    if (label === null) return invalid("case_flow_binding_invalid");
    const initial = await InformationFlowContext.create({
      organisationId: input.organisationId,
      sessionId: input.commandId,
      authorityPartitionDigest: input.authorityPartition.digest,
    });
    if (!initial.ok) return invalid("case_flow_binding_invalid");
    const evidence = await ObservationEvidence.create({
      source: {
        kind: "case_entry",
        caseId: input.caseId,
        entryId: `goal_command:${input.commandId}`,
      },
      sourceRevision: 1,
      contentDigest,
      inputLabel: label,
      observedAt: input.acceptedAt,
    });
    if (!evidence.ok) return invalid("case_flow_binding_invalid");
    const flow = await advanceInformationFlowContext({
      context: initial.value,
      observation: evidence.value,
      inputLabel: label,
    });
    if (!flow.ok) return invalid("case_flow_binding_invalid");
    const binding = flowBindingForContext(
      flow.value.context,
      `goal:${input.commandId}`,
    );
    const result = this.ctx.storage.transactionSync(
      acceptGoalMessage.bind(
        null,
        this.ctx.storage.sql,
        input,
        command,
        digest,
        contentDigest,
        binding,
      ),
    );
    if (!result.ok) return result;
    const restored = await restoreCaseOutput(result.value);
    return restored.ok
      ? { ok: true, value: serializeCaseOutput(restored.value) }
      : restored;
  }

  async readGoal(raw: unknown): Promise<CaseResult<CaseGoalSnapshot>> {
    if (this.discarded) return invalid("case_discarded");
    const identity = parseGoalIdentity(raw);
    if (identity === null) return invalid("goal_request_invalid");
    return readCaseGoal(this.ctx.storage.sql, identity);
  }

  async bindGoalExecution(raw: unknown): Promise<CaseResult<CaseGoalSnapshot>> {
    if (this.discarded) return invalid("case_discarded");
    const request = parseGoalExecutionRequest(raw);
    if (request === null) return invalid("goal_request_invalid");
    return this.ctx.storage.transactionSync(
      bindCaseGoalExecution.bind(null, this.ctx.storage.sql, request),
    );
  }

  async closeGoalExecution(
    raw: unknown,
  ): Promise<CaseResult<CaseGoalSnapshot>> {
    if (this.discarded) return invalid("case_discarded");
    const request = parseGoalExecutionRequest(raw);
    if (request === null) return invalid("goal_request_invalid");
    return this.ctx.storage.transactionSync(
      closeCaseGoalExecution.bind(null, this.ctx.storage.sql, request),
    );
  }

  async applyGoalCommand(raw: unknown): Promise<CaseResult<CaseGoalSnapshot>> {
    if (this.discarded) return invalid("case_discarded");
    const request = parseGoalCommandRequest(raw);
    if (request === null) return invalid("goal_request_invalid");
    return this.ctx.storage.transactionSync(
      applyCaseGoalCommand.bind(null, this.ctx.storage.sql, request),
    );
  }

  async admitGoalOperation(raw: unknown): Promise<CaseResult<GoalAdmission>> {
    if (this.discarded) return invalid("case_discarded");
    const request = parseGoalAdmissionRequest(raw);
    if (request === null) return invalid("goal_request_invalid");
    return this.ctx.storage.transactionSync(
      admitCaseGoalOperation.bind(null, this.ctx.storage.sql, request),
    );
  }

  async acceptGoalUsage(raw: unknown): Promise<CaseResult<CaseGoalSnapshot>> {
    if (this.discarded) return invalid("case_discarded");
    const request = parseGoalUsageRequest(raw);
    if (request === null) return invalid("goal_request_invalid");
    return this.ctx.storage.transactionSync(
      acceptCaseGoalUsage.bind(null, this.ctx.storage.sql, request),
    );
  }

  async scheduleConversation(input: ConversationExecution): Promise<void> {
    const startedAt = Date.now();
    if (this.discarded) throw new Error("case_discarded");
    if (!actorExecutionAdmissionOpen(this.ctx.storage.sql))
      throw new Error("case_placement_conflict");
    persistConversationExecution(this.ctx.storage.sql, input);
    const persistedAt = Date.now();
    await this.rearm();
    console.log(
      JSON.stringify({
        event: "chat.case_schedule_timing",
        organisation_id: input.scope.organisationId,
        conversation_id: input.conversationId,
        started_at: startedAt,
        persist_ms: persistedAt - startedAt,
        alarm_ms: Date.now() - persistedAt,
      }),
    );
    this.ctx.waitUntil(this.resumeConversation());
  }

  /** Sets the alarm from the Case's stored work. */
  private rearm(): Promise<number | null> {
    return rearmActorAlarm(
      this.ctx.storage,
      caseAlarmReconcilers(this.ctx.storage.sql),
    );
  }

  async alarm(): Promise<void> {
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (admission.kind !== "admitted")
      return this.logStaleSkip(`admission_${admission.kind}`);
    if (this.discarded) return this.logStaleSkip("discarded");
    // The retry wakeup is set before the work runs, so a lost run is tried
    // again while its work waits.
    if ((await this.rearm()) === null) return this.logStaleSkip("no_wakeup");
    // Each step runs on its own (Refactor 15, S3). The wakeup set above
    // brings a failed step back.
    await runAlarmStepsTogether("case", [
      {
        name: "context_projections",
        run: () => this.flushContextProjections(),
      },
      { name: "conversation", run: () => this.resumeConversation() },
      {
        name: "undelivered_outputs",
        run: () => this.dropUndeliveredOutputs(),
      },
      {
        name: "commerce_approval_wait",
        run: () =>
          this.reconcileCommerceApprovalWait(admission.scope.organisationId),
      },
      {
        name: "abandoned_assignments",
        run: () => this.abandonStoppedAssignments(admission.scope),
      },
    ]);
  }

  /** Drops the pending answers that nothing delivered within a day. */
  private dropUndeliveredOutputs(): void {
    const now = Date.now();
    const dropped = this.ctx.storage.transactionSync(() =>
      dropUndeliveredOutputs(this.ctx.storage.sql, now),
    );
    if (dropped.length > 0)
      traceWarn("case.undelivered_outputs_dropped", {
        requestId: newRequestId(),
        count: dropped.length,
      });
  }

  /**
   * Ends each assignment that nothing moved for 30 minutes and whose Session
   * runs no turn (Refactor 15, refactor 9). A delivery of the same work does
   * this sooner; this step ends one that no delivery comes back to.
   */
  private async abandonStoppedAssignments(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    const now = Date.now();
    if (!hasStaleAssignment(this.ctx.storage.sql, now)) return;
    const meta = readMeta(this.ctx.storage.sql);
    if (meta === null) return logAbandonSkipped({ reason: "no_meta" });
    // A Case that waits, for an approval for one, keeps its assignments: its
    // own wait ends them.
    if (!isOpen(meta.lifecycle_json))
      return logAbandonSkipped({ reason: "not_open", case_id: meta.case_id });
    const { recoverAbandonedAssignments, sessionQuiescenceProver } =
      await import("./case/abandoned-assignments");
    const recovered = await recoverAbandonedAssignments({
      caseActor: this,
      proveQuiescence: sessionQuiescenceProver(this.env, scope),
      minimumAgeMs: ASSIGNMENT_ABANDON_AFTER_MS,
      now,
    });
    if (!recovered.ok)
      logAbandonSkipped({
        reason: `assignments:${recovered.error.code}`,
        case_id: meta.case_id,
      });
    // The wakeup set before this step still counts the ended assignments.
    if (recovered.ok && recovered.value.abandoned.length > 0)
      await this.rearm();
  }

  /** Logs an alarm that ends before its abandon step, for a stale Case. */
  private logStaleSkip(reason: string): void {
    try {
      if (!hasStaleAssignment(this.ctx.storage.sql, Date.now())) return;
      logAbandonSkipped({
        reason,
        case_id: readMeta(this.ctx.storage.sql)?.case_id ?? "no_meta",
      });
    } catch {
      // A Case with no tables holds no assignment.
    }
  }

  private async scheduleContextProjections(): Promise<void> {
    await this.rearm();
    this.ctx.waitUntil(this.flushContextProjections());
  }

  private async flushContextProjections(): Promise<void> {
    if (this.projectionWork !== null) return;
    const work = this.trackExecution(this.publishContextProjections.bind(this));
    this.projectionWork = work;
    try {
      await work;
    } catch (error) {
      console.warn("case.context_projection_retry", error);
    } finally {
      this.projectionWork = null;
    }
  }

  private async publishContextProjections(): Promise<void> {
    if (this.discarded || !actorExecutionAdmissionOpen(this.ctx.storage.sql))
      return;
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (admission.kind !== "admitted") return;
    const meta = readMeta(this.ctx.storage.sql);
    if (
      meta === null ||
      meta.organisation_id !== admission.scope.organisationId
    )
      throw new Error("case_projection_identity_invalid");
    const pending = this.ctx.storage.sql
      .exec<{ entry_id: string }>(
        "SELECT entry_id FROM case_context_projection_outbox ORDER BY rowid LIMIT 32",
      )
      .toArray();
    for (const entry of pending) {
      if (this.discarded || !actorExecutionAdmissionOpen(this.ctx.storage.sql))
        return;
      const sent = await enqueueCaseContextProjection(
        this.env,
        this.ctx.storage.sql,
        meta.case_id,
        entry.entry_id,
      );
      if (!sent) throw new Error("case_projection_source_missing");
      this.ctx.storage.sql.exec(
        "DELETE FROM case_context_projection_outbox WHERE entry_id = ?",
        entry.entry_id,
      );
    }
  }

  private async resumeConversation(): Promise<void> {
    if (this.discarded || !actorExecutionAdmissionOpen(this.ctx.storage.sql))
      return;
    const pending = readConversationExecution(this.ctx.storage.sql);
    if (pending === null) return;
    if (this.conversationWork !== null) return;
    const work = this.runConversation(pending);
    this.conversationWork = settleActorExecution(work);
    try {
      await work;
    } finally {
      this.conversationWork = null;
    }
    // A schedule that came during this run, such as a steered message while
    // the stopped turn ended, does not wait for the recovery alarm.
    const next = readConversationExecution(this.ctx.storage.sql);
    if (next !== null && next.wakeId !== pending.wakeId)
      await this.resumeConversation();
  }

  private async runConversation(
    pending: NonNullable<ReturnType<typeof readConversationExecution>>,
  ): Promise<void> {
    try {
      const recovery = await admitActorRecovery(this.env, this.ctx.storage);
      if (recovery.kind !== "admitted") return;
      const { resumeConversationExecution } =
        await import("../chat/application");
      const outcome = await resumeConversationExecution(
        this.env,
        recovery.scope,
        pending,
        this,
      );
      if (outcome === "settled") {
        this.ctx.storage.sql.exec(
          "DELETE FROM portal_conversation_execution WHERE singleton = 1 AND wake_id = ?",
          pending.wakeId,
        );
      }
    } catch (error) {
      traceWarn("portal_chat_recovery_pending", {
        requestId: newRequestId(),
        organisation_id: pending.scope.organisationId,
        conversation_id: pending.conversationId,
        wake_id: pending.wakeId,
        error: errorMessage(error).slice(0, 500),
      });
    }
  }

  async quiesceConversationExecution(input: {
    readonly expectedFenceToken: ActorFenceToken;
  }): Promise<Result<null, ActorExportError>> {
    const closed = closeActorExecutionAdmission(
      this.ctx.storage.sql,
      input.expectedFenceToken,
    );
    if (!closed.ok) return closed;
    for (const pending of [...this.executions]) {
      const settled = await pending;
      if (!settled.ok) return settled;
    }
    const work = await this.conversationWork;
    await this.rearm();
    return work ?? { ok: true, value: null };
  }

  private async trackExecution<Value>(
    start: () => Promise<Value>,
  ): Promise<Value> {
    const work = start();
    const settlement = settleActorExecution(work);
    this.executions.add(settlement);
    try {
      return await work;
    } finally {
      this.executions.delete(settlement);
    }
  }

  private async admitCommerceMutation(raw: unknown) {
    if (
      this.discarded ||
      !actorExecutionAdmissionOpen(this.ctx.storage.sql) ||
      !isRecord(raw)
    )
      return null;
    const execution = parseActionMutationExecution(raw.execution);
    if (execution === null) return null;
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    const meta = readMeta(this.ctx.storage.sql);
    if (
      admission.kind !== "admitted" ||
      meta === null ||
      meta.organisation_id !== admission.scope.organisationId ||
      !(await authorizeActionMutationExecution(
        this.env,
        admission.scope,
        execution,
      )) ||
      !actorExecutionAdmissionOpen(this.ctx.storage.sql)
    )
      return null;
    return { scope: admission.scope, execution };
  }

  private async commerceMutationActive(admission: {
    scope: OrganisationExecutionScope;
    execution: ActionMutationExecution;
  }): Promise<boolean> {
    return (
      !this.discarded &&
      (await authorizeActionMutationExecution(
        this.env,
        admission.scope,
        admission.execution,
      )) &&
      actorExecutionAdmissionOpen(this.ctx.storage.sql)
    );
  }

  protected acceptsActivation(input: ActorActivationRequest): boolean {
    return (
      input.schemaVersion === CASE_ACTOR_SCHEMA_VERSION &&
      input.identity.objectKind === "case"
    );
  }

  async inspectActivation(
    input: ActorActivationIdentity,
  ): Promise<ActorActivationInspection> {
    return this.ctx.storage.transactionSync(
      inspectActorActivation.bind(null, this.ctx.storage.sql, input),
    );
  }

  async discardQuarantinedState(
    input: ActorActivationIdentity,
  ): Promise<QuarantinedCaseDiscardResult> {
    if (this.discarded) {
      return {
        ok: true,
        value: {
          kind: "already_empty",
          stateVersion: null,
          reachableAttachmentCount: 0,
        },
      };
    }
    const activation = this.ctx.storage.transactionSync(
      inspectActorActivation.bind(null, this.ctx.storage.sql, input),
    );
    if (activation.kind === "missing") {
      await this.ctx.storage.deleteAll();
      this.discarded = true;
      return {
        ok: true,
        value: {
          kind: "already_empty",
          stateVersion: null,
          reachableAttachmentCount: 0,
        },
      };
    }
    if (
      !discardableQuarantinedCaseActivation(activation, input.schemaVersion)
    ) {
      return {
        ok: false,
        error: { code: "quarantined_case_discard_conflict" },
      };
    }
    const reachableAttachmentCount = (
      await this.listReachableAttachmentObjectKeys()
    ).length;
    await this.ctx.storage.deleteAll();
    this.discarded = true;
    return {
      ok: true,
      value: {
        kind: "discarded",
        stateVersion: activation.stateVersion,
        reachableAttachmentCount,
      },
    };
  }

  protected override async referencedArchiveKeys(): Promise<
    Result<Iterable<string>, ActorExportError>
  > {
    return { ok: true, value: await this.listReachableAttachmentObjectKeys() };
  }

  protected quiesceForExport(expectedFenceToken: ActorFenceToken) {
    return this.quiesceConversationExecution({ expectedFenceToken });
  }

  async ensure(
    raw: unknown,
  ): Promise<
    CaseResult<{ readonly kind: "ensured"; readonly revision: number }>
  > {
    if (this.discarded || !actorExecutionAdmissionOpen(this.ctx.storage.sql))
      return invalid("case_execution_authority_inactive");
    const input = parseCaseEnsureRequest(raw);
    if (input === null) return invalid("case_request_invalid");
    return this.ctx.storage.transactionSync(
      ensureCase.bind(null, this.ctx.storage.sql, input),
    );
  }

  async prepareDirectTurn(raw: unknown): Promise<
    CaseResult<{
      readonly kind: "accepted" | "duplicate";
      readonly snapshot: CaseSnapshot;
    }>
  > {
    if (!isRecord(raw) || !("binding" in raw))
      return invalid("case_request_invalid");
    const ensured = await this.ensure(raw.ensure);
    if (!ensured.ok) return ensured;
    const triggered = await this.acceptTrigger(raw.trigger);
    if (!triggered.ok) return triggered;
    if (raw.binding !== null) {
      const bound = await this.attachBinding(raw.binding);
      if (!bound.ok) return bound;
    }
    const snapshot = await this.inspect();
    if (!snapshot.ok) return snapshot;
    return {
      ok: true,
      value: { kind: triggered.value.kind, snapshot: snapshot.value },
    };
  }

  /**
   * Journal a steering input that an assignment's turn placed (Plan 71). The
   * Session sends it when the turn ends, so the assignment can have left
   * `running`. The entry copies the authority, visibility, label and replay
   * scope of the turn's trigger: it comes from the same requester in the
   * same conversation. It does not change the Case revision, so the turn's
   * proposals and approvals stay valid. Later turns read it as context.
   */
  async acceptSteeringInput(
    raw: unknown,
  ): Promise<CaseResult<{ readonly kind: "accepted" | "duplicate" }>> {
    if (this.discarded || !actorExecutionAdmissionOpen(this.ctx.storage.sql))
      return invalid("case_execution_authority_inactive");
    const input = parseCaseSteeringInput(raw);
    if (input === null) return invalid("case_steering_invalid");
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (
      admission.kind !== "admitted" ||
      admission.scope.organisationId !== input.requestAuthority.organisationId
    )
      return invalid("case_request_invalid");
    const contentDigest = await sha256Hex(JSON.stringify(input.content));
    if (this.discarded || !actorExecutionAdmissionOpen(this.ctx.storage.sql))
      return invalid("case_execution_authority_inactive");
    const result = this.ctx.storage.transactionSync(
      acceptCaseSteeringInput.bind(
        null,
        this.ctx.storage.sql,
        input,
        contentDigest,
      ),
    );
    if (result.ok && result.value.kind === "accepted")
      await this.scheduleContextProjections();
    return result;
  }

  async acceptTrigger(raw: unknown): Promise<
    CaseResult<{
      readonly kind: "accepted" | "duplicate";
      readonly revision: number;
    }>
  > {
    if (this.discarded || !actorExecutionAdmissionOpen(this.ctx.storage.sql))
      return invalid("case_execution_authority_inactive");
    const trigger = parseCaseTrigger(raw);
    if (trigger === null) return invalid("case_trigger_invalid");
    const startedAt = Date.now();
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (
      admission.kind !== "admitted" ||
      admission.scope.organisationId !== trigger.requestAuthority.organisationId
    ) {
      return invalid("case_request_invalid");
    }
    await this.reconcileCommerceApprovalWait(admission.scope.organisationId);
    const recoveredAt = Date.now();
    const inputLabel = await flowLabelForTrigger(admission.scope, trigger);
    if (inputLabel === null) return invalid("case_trigger_invalid");
    const labelledAt = Date.now();
    const contentDigest = await sha256Hex(JSON.stringify(trigger.content));
    if (this.discarded || !actorExecutionAdmissionOpen(this.ctx.storage.sql))
      return invalid("case_execution_authority_inactive");
    const result = this.ctx.storage.transactionSync(
      acceptCaseTrigger.bind(
        null,
        this.ctx.storage.sql,
        trigger,
        contentDigest,
        inputLabel,
      ),
    );
    const committedAt = Date.now();
    if (result.ok) {
      await this.scheduleContextProjections();
    }
    console.log(
      JSON.stringify({
        event: "case.trigger_admission_timing",
        organisation_id: trigger.requestAuthority.organisationId,
        case_id: trigger.caseId,
        trigger_id: trigger.triggerId,
        recovery_ms: recoveredAt - startedAt,
        label_ms: labelledAt - recoveredAt,
        commit_ms: committedAt - labelledAt,
        projection_schedule_ms: Date.now() - committedAt,
      }),
    );
    return result;
  }

  /**
   * A Case that waits for an approval refuses new triggers until the wait
   * ends. The action ledger owns the decision (Refactor 15, refactor 1): this
   * reads the ledger entry and moves the wait to what it shows, so a decision
   * whose Case update failed, or an action that expired, ends the wait here.
   * A read failure leaves the Case waiting for the next try.
   */
  private async reconcileCommerceApprovalWait(
    organisationId: OrganisationId,
  ): Promise<void> {
    const meta = readMeta(this.ctx.storage.sql);
    if (meta === null) return;
    // The wait of the Case, and each waiting approval that it no longer
    // waits for, as after an archive during the wait.
    for (const actionNonce of commerceApprovalsToRead(this.ctx.storage.sql))
      await this.reconcileCommerceApprovalFromLedger(
        organisationId,
        meta.case_id,
        actionNonce,
      );
  }

  private async reconcileCommerceApprovalFromLedger(
    organisationId: OrganisationId,
    caseId: string,
    actionNonce: string,
  ): Promise<CaseResult<CommerceApprovalSync>> {
    const now = Date.now();
    let action;
    try {
      const organisation = await requireActiveOrganisationActor({
        env: this.env,
        organisationId,
        now,
      });
      action = await organisation.getAction({
        organisationId,
        nonce: actionNonce,
        now,
      });
    } catch (error) {
      traceWarn("case.commerce_approval_read_failed", {
        requestId: newRequestId(),
        organisation_id: organisationId,
        case_id: caseId,
        error: errorMessage(error).slice(0, 500),
      });
      return invalid("case_commerce_approval_ledger_unavailable");
    }
    if (!action.ok)
      return action.error.code === "action_not_found"
        ? this.lapseApprovalWithoutAction(organisationId, caseId, actionNonce)
        : invalid("case_commerce_approval_ledger_unavailable");
    if (this.discarded || !actorExecutionAdmissionOpen(this.ctx.storage.sql))
      return invalid("case_not_open");
    const entry = action.value;
    const reconciled = this.ctx.storage.transactionSync(() =>
      reconcileCommerceApprovalWait(this.ctx.storage.sql, { caseId, entry }),
    );
    if (
      reconciled.ok &&
      (reconciled.value.kind === "decided" ||
        reconciled.value.kind === "lapsed")
    ) {
      traceLog("case.commerce_approval_reconciled", {
        requestId: newRequestId(),
        organisation_id: organisationId,
        case_id: caseId,
        action_nonce: actionNonce,
        outcome: reconciled.value.kind,
        ledger_state: entry.state,
      });
      await this.rearm();
    }
    if (!reconciled.ok) return reconciled;
    return {
      ok: true,
      value: {
        kind: reconciled.value.kind,
        revision: readMeta(this.ctx.storage.sql)?.revision ?? 0,
      },
    };
  }

  /**
   * Lapses a wait whose action the ledger does not hold, so no person can
   * decide it and no read can end it. A wait younger than
   * APPROVAL_MISSING_ACTION_LAPSE_MS stays, so its ledger entry can land.
   */
  private async lapseApprovalWithoutAction(
    organisationId: OrganisationId,
    caseId: string,
    actionNonce: string,
  ): Promise<CaseResult<CommerceApprovalSync>> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const record = readCommerceApproval(sql, actionNonce);
    if (
      record?.kind !== "waiting" ||
      now - record.request.requestedAt < APPROVAL_MISSING_ACTION_LAPSE_MS
    )
      return invalid("case_commerce_approval_ledger_unavailable");
    if (this.discarded || !actorExecutionAdmissionOpen(sql))
      return invalid("case_not_open");
    const lapsed = this.ctx.storage.transactionSync(() =>
      lapseCommerceApproval(sql, { caseId, actionNonce, lapsedAt: now }),
    );
    if (!lapsed.ok) return lapsed;
    if (lapsed.value.kind === "lapsed") {
      traceLog("case.commerce_approval_reconciled", {
        requestId: newRequestId(),
        organisation_id: organisationId,
        case_id: caseId,
        action_nonce: actionNonce,
        outcome: "lapsed",
        ledger_state: "action_not_found",
      });
      await this.rearm();
    }
    return {
      ok: true,
      value: {
        kind: lapsed.value.kind,
        revision: readMeta(sql)?.revision ?? 0,
      },
    };
  }

  private async syncWaitBeforeOutcome(actionNonce: string): Promise<void> {
    const meta = readMeta(this.ctx.storage.sql);
    const lifecycle =
      meta === null ? null : parseLifecycle(meta.lifecycle_json);
    if (
      meta === null ||
      lifecycle?.kind !== "waiting" ||
      lifecycle.wait.kind !== "approval" ||
      String(lifecycle.wait.approvalRequestId) !== actionNonce
    )
      return;
    const organisationId = parseOrganisationId(meta.organisation_id);
    if (!organisationId.ok) return;
    await this.reconcileCommerceApprovalFromLedger(
      organisationId.value,
      meta.case_id,
      actionNonce,
    );
  }

  /**
   * Moves the Case's wait on `actionNonce` to what the action ledger shows.
   * A route or a Slack click calls it after it decided an action; the Case
   * reads the decision itself and does not take it from the caller.
   */
  async syncCommerceApprovalWait(
    raw: unknown,
  ): Promise<CaseResult<CommerceApprovalSync>> {
    if (
      !isRecord(raw) ||
      typeof raw.caseId !== "string" ||
      typeof raw.actionNonce !== "string"
    )
      return invalid("case_commerce_approval_decision_invalid");
    const meta = readMeta(this.ctx.storage.sql);
    if (meta === null || meta.case_id !== raw.caseId)
      return invalid("case_identity_mismatch");
    const organisationId = parseOrganisationId(meta.organisation_id);
    if (!organisationId.ok) return invalid("case_identity_mismatch");
    return this.reconcileCommerceApprovalFromLedger(
      organisationId.value,
      meta.case_id,
      raw.actionNonce,
    );
  }

  async read(
    input: Parameters<CaseContextSourceReader["read"]>[0],
  ): Promise<Result<CaseContextSource, CaseContextSourceReaderError>> {
    const source = await readCaseContextSource(this.ctx.storage.sql, input);
    if (!source.ok) return source;
    return (await contextSourceDigestMatches(source.value))
      ? source
      : { ok: false, error: { code: "storage_failure" } };
  }

  async readTail(
    input: Parameters<CaseContextTailReader["readTail"]>[0],
  ): Promise<readonly CaseContextTailCandidate[]> {
    return readCaseContextTail(this.ctx.storage.sql, input);
  }

  async readMetadata(input: {
    organisationId: OrganisationId;
    caseId: CaseId;
    entryId: string;
  }) {
    const row = this.ctx.storage.sql
      .exec<{ sequence: number; request_authority_json: string }>(
        `SELECT journal.sequence, journal.request_authority_json FROM case_journal journal JOIN case_meta meta ON meta.singleton = 1
       WHERE meta.organisation_id = ? AND meta.case_id = ? AND journal.entry_id = ?`,
        input.organisationId,
        input.caseId,
        input.entryId,
      )
      .toArray()[0];
    if (row === undefined)
      return { ok: false as const, error: { code: "source_missing" as const } };
    const source = await this.read({
      organisationId: input.organisationId,
      source: {
        kind: "case_entry",
        caseId: input.caseId,
        entryId: input.entryId,
      },
      sourceRevision: row.sequence,
    });
    if (!source.ok) return source;
    return {
      ok: true as const,
      value: {
        inputLabel: source.value.inputLabel,
        sourceRevision: source.value.sourceRevision,
        contentDigest: source.value.contentDigest,
        contentKind: source.value.content.kind,
        authorPersonId: journalAuthorPersonId(row.request_authority_json),
      },
    };
  }

  /**
   * A call from the conversation residency Actor. It does no work: the call
   * itself keeps this object in memory between the turns of a conversation.
   */
  async keepResident(): Promise<void> {}

  async prepareOngoingTurn(raw: unknown): Promise<CaseResult<CaseSnapshot>> {
    if (this.discarded || !actorExecutionAdmissionOpen(this.ctx.storage.sql))
      return invalid("case_execution_authority_inactive");
    const input = parsePrepareOngoingCaseTurnRequest(raw);
    if (input === null) return invalid("case_request_invalid");
    const startedAt = Date.now();
    // The label reads decide nothing by themselves. They start beside the
    // admission, on the database this Case's activation pins, and the label
    // is used only when the admission returns a scope on that database.
    const pinned = pinnedActorDatabase(
      this.env,
      this.ctx.storage.sql,
      input.trigger.requestAuthority.organisationId,
    );
    const startedLabel =
      pinned === null
        ? null
        : flowLabelForAuthority(pinned, input.trigger.requestAuthority);
    void startedLabel?.catch(ignoreUnusedFlowLabel);
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    const admittedAt = Date.now();
    if (
      admission.kind !== "admitted" ||
      admission.scope.organisationId !==
        input.trigger.requestAuthority.organisationId
    ) {
      return invalid("case_request_invalid");
    }
    const inputLabel = await (startedLabel !== null &&
    pinned === admission.scope.database
      ? startedLabel
      : flowLabelForAuthority(
          admission.scope.database,
          input.trigger.requestAuthority,
        ));
    const labelledAt = Date.now();
    if (inputLabel === null) return invalid("case_request_invalid");
    // A Slack thread's Case can wait on an expired card too.
    await this.reconcileCommerceApprovalWait(admission.scope.organisationId);
    const contentDigest = await sha256Hex(
      JSON.stringify(input.trigger.content),
    );
    if (this.discarded || !actorExecutionAdmissionOpen(this.ctx.storage.sql))
      return invalid("case_execution_authority_inactive");
    const result = this.ctx.storage.transactionSync(
      prepareOngoingCaseTurn.bind(
        null,
        this.ctx.storage.sql,
        input,
        contentDigest,
        inputLabel,
      ),
    );
    if (!result.ok) return result;
    const restored = await restoreCaseSnapshot(result.value);
    if (!restored.ok) return restored;
    await this.scheduleContextProjections();
    // The waits of this admission, with the place where this Case runs. The
    // time of each database read depends on that place.
    traceLog("case.turn_admission_timing", {
      requestId: newRequestId(),
      organisation_id: input.ensure.identity.organisationId,
      case_id: input.ensure.identity.caseId,
      trigger_id: input.trigger.triggerId,
      started_at: startedAt,
      admission_ms: admittedAt - startedAt,
      label_ms: labelledAt - admittedAt,
      commit_ms: Date.now() - labelledAt,
    });
    return { ok: true, value: serializeCaseSnapshot(restored.value) };
  }

  async attachBinding(raw: unknown): Promise<
    CaseResult<{
      readonly kind: "attached" | "already_attached";
      readonly revision: number;
    }>
  > {
    if (this.discarded || !actorExecutionAdmissionOpen(this.ctx.storage.sql))
      return invalid("case_execution_authority_inactive");
    const binding = parseCaseBinding(raw);
    if (binding === null) return invalid("case_binding_invalid");
    return this.ctx.storage.transactionSync(
      attachCaseBinding.bind(null, this.ctx.storage.sql, binding),
    );
  }

  async assignSession(raw: unknown): Promise<
    CaseResult<{
      readonly kind: "assigned" | "already_assigned";
      readonly revision: number;
    }>
  > {
    if (this.discarded || !actorExecutionAdmissionOpen(this.ctx.storage.sql))
      return invalid("case_execution_authority_inactive");
    const assignment = parseCaseAssignment(raw);
    if (assignment === null) return invalid("case_assignment_invalid");
    const result = this.ctx.storage.transactionSync(
      assignCaseSession.bind(
        null,
        this.ctx.storage.sql,
        assignment,
        Date.now(),
      ),
    );
    // The abandoned-assignment step learns of the new assignment.
    if (result.ok && result.value.kind === "assigned") await this.rearm();
    return result;
  }

  async beginAssignment(raw: unknown): Promise<
    CaseResult<{
      readonly kind: "running" | "already_running";
      readonly lifecycle: CaseAssignmentLifecycle;
    }>
  > {
    if (this.discarded || !actorExecutionAdmissionOpen(this.ctx.storage.sql))
      return invalid("case_execution_authority_inactive");
    const input = parseBeginAssignmentRequest(raw);
    if (input === null) return invalid("case_assignment_start_invalid");
    return this.ctx.storage.transactionSync(
      beginCaseAssignment.bind(null, this.ctx.storage.sql, input),
    );
  }

  async settleAssignment(raw: unknown): Promise<
    CaseResult<{
      readonly kind: "settled" | "already_settled";
      readonly lifecycle: CaseAssignmentLifecycle;
    }>
  > {
    const input = parseSettleAssignmentRequest(raw);
    if (input === null) return invalid("case_assignment_settlement_invalid");
    return this.ctx.storage.transactionSync(
      settleCaseAssignment.bind(null, this.ctx.storage.sql, input),
    );
  }

  /**
   * Ends an assignment that no live turn will finish, on the Session's proof
   * that it runs no turn (Refactor 15, refactor 9).
   */
  async abandonAssignment(raw: unknown): Promise<
    CaseResult<{
      readonly kind: "abandoned" | "already_abandoned";
      readonly lifecycle: CaseAssignmentLifecycle;
    }>
  > {
    if (this.discarded || !actorExecutionAdmissionOpen(this.ctx.storage.sql))
      return invalid("case_execution_authority_inactive");
    const input = parseAbandonAssignmentRequest(raw);
    if (input === null) return invalid("case_assignment_abandon_invalid");
    return this.ctx.storage.transactionSync(
      abandonCaseAssignment.bind(null, this.ctx.storage.sql, input),
    );
  }

  async acceptSessionProposal(
    raw: unknown,
  ): Promise<CaseResult<CaseProposalAcceptance>> {
    const input = await parseAcceptProposalRequest(raw);
    if (input === null) return invalid("case_proposal_invalid");
    const entryDigests = await Promise.all(
      input.proposal.entries.map((entry) =>
        sha256Hex(JSON.stringify(entry.content)),
      ),
    );
    // The projection of each accepted entry is retained in this Case's
    // outbox with the acceptance, as for a trigger. It is published after
    // this call returns, so the caller does not wait for the queue. The alarm
    // publishes what an interrupted call leaves.
    const result = this.ctx.storage.transactionSync(
      acceptCaseProposalWithProjections.bind(
        null,
        this.ctx.storage.sql,
        input,
        entryDigests,
      ),
    );
    if (!result.ok) return result;
    const restored = await restoreCaseProposalAcceptance(result.value);
    if (!restored.ok) return invalid(restored.error.code);
    if (restored.value.disposition.kind === "accepted")
      await this.scheduleContextProjections();
    return { ok: true, value: serializeCaseProposalAcceptance(restored.value) };
  }

  async acceptCommerceProposal(raw: unknown) {
    if (isEntityPlaneCommerceProposalRequest(raw))
      return this.acceptCommerceEntityPlaneProposal(raw);
    return this.trackExecution(
      this.admittedAcceptCommerceProposal.bind(this, raw),
    );
  }

  private async admittedAcceptCommerceProposal(raw: unknown): Promise<
    CaseResult<{
      readonly kind: "accepted" | "already_accepted";
      readonly revision: number;
      readonly flowBinding: SerializedFlowBinding;
    }>
  > {
    const admission = await this.admitCommerceMutation(raw);
    if (admission === null) return invalid("case_execution_authority_inactive");
    const parsed = await parseAcceptCommerceProposalRequest(raw);
    if (parsed === null) return invalid("case_commerce_proposal_invalid");
    const digest = await sha256Hex(JSON.stringify(parsed.proposal));
    const existing =
      this.ctx.storage.sql
        .exec<JsonRow>(
          "SELECT proposal_id FROM case_commerce_proposal WHERE proposal_id = ?",
          parsed.proposal.proposalId,
        )
        .toArray()[0] ?? null;
    const storedBinding =
      existing === null
        ? null
        : await readCommerceProposalFlowBinding(
            this.ctx.storage.sql,
            parsed.proposal.proposalId,
          );
    if (storedBinding !== null && !storedBinding.ok)
      return invalid(storedBinding.error.code);
    if (
      storedBinding?.ok &&
      parsed.kind === "agent_bound" &&
      !equal(storedBinding.value.toJSON(), parsed.flowBinding.toJSON())
    ) {
      return invalid("case_commerce_proposal_conflict");
    }
    const input = storedBinding?.ok
      ? {
          proposal: parsed.proposal,
          acceptedAt: parsed.acceptedAt,
          flowBinding: storedBinding.value,
        }
      : parsed.kind === "agent_bound"
        ? parsed
        : await bindMerchantCommerceProposal(
            admission.scope.database,
            parsed,
            digest,
          );
    if (input === null) return invalid("case_commerce_proposal_invalid");
    if (!commerceMutationMatchesProposal(admission.execution, input))
      return invalid("case_execution_identity_mismatch");
    if (!(await this.commerceMutationActive(admission)))
      return invalid("case_execution_authority_inactive");
    const result = this.ctx.storage.transactionSync(
      acceptCommerceProposal.bind(null, this.ctx.storage.sql, input, digest),
    );
    if (!result.ok) return result;
    const acceptedBinding = await readCommerceProposalFlowBinding(
      this.ctx.storage.sql,
      input.proposal.proposalId,
    );
    if (!acceptedBinding.ok) return invalid(acceptedBinding.error.code);
    if (!(await this.commerceMutationActive(admission)))
      return invalid("case_execution_authority_inactive");
    await enqueueCaseContextProjection(
      this.env,
      this.ctx.storage.sql,
      input.proposal.caseId,
      `commerce_proposal:${input.proposal.proposalId}`,
    );
    if (!(await this.commerceMutationActive(admission)))
      return invalid("case_execution_authority_inactive");
    return {
      ok: true,
      value: { ...result.value, flowBinding: acceptedBinding.value.toJSON() },
    };
  }

  async acceptCommerceEntityPlaneProposal(raw: unknown) {
    return this.trackExecution(
      this.admittedAcceptCommerceEntityPlaneProposal.bind(this, raw),
    );
  }

  private async admittedAcceptCommerceEntityPlaneProposal(
    raw: unknown,
  ): Promise<
    CaseResult<{
      readonly kind: "accepted" | "already_accepted";
      readonly revision: number;
      readonly flowBinding: SerializedFlowBinding;
    }>
  > {
    const admission = await this.admitCommerceMutation(raw);
    if (admission === null) return invalid("case_execution_authority_inactive");
    const input = await parseAcceptCommerceEntityPlaneProposalRequest(raw);
    if (input === null) return invalid("case_entity_plane_proposal_invalid");
    if (!commerceMutationMatchesProposal(admission.execution, input))
      return invalid("case_execution_identity_mismatch");
    const digest = await sha256Hex(JSON.stringify(input.proposal));
    const journalDigest = await sha256Hex(
      JSON.stringify({
        kind: "entity_plane_proposal",
        proposal: input.proposal.proposal,
      }),
    );
    if (!(await this.commerceMutationActive(admission)))
      return invalid("case_execution_authority_inactive");
    const result = this.ctx.storage.transactionSync(
      acceptCommerceEntityPlaneProposal.bind(
        null,
        this.ctx.storage.sql,
        input,
        digest,
        journalDigest,
      ),
    );
    if (!result.ok) return result;
    if (!(await this.commerceMutationActive(admission)))
      return invalid("case_execution_authority_inactive");
    await enqueueCaseContextProjection(
      this.env,
      this.ctx.storage.sql,
      input.proposal.caseId,
      `commerce_proposal:${input.proposal.proposalId}`,
    );
    if (!(await this.commerceMutationActive(admission)))
      return invalid("case_execution_authority_inactive");
    return {
      ok: true,
      value: { ...result.value, flowBinding: input.flowBinding.toJSON() },
    };
  }

  async readAcceptedCommerceEntityPlaneProposal(
    input: Readonly<{
      readonly proposalId: string;
    }>,
  ): Promise<CaseResult<CommerceEntityPlaneCaseProposal | null>> {
    if (input.proposalId.length === 0)
      return invalid("case_entity_plane_proposal_invalid");
    const row =
      this.ctx.storage.sql
        .exec<ProposalRow>(
          "SELECT proposal_id, payload, acceptance_json FROM case_commerce_proposal WHERE proposal_id = ?",
          input.proposalId,
        )
        .toArray()[0] ?? null;
    if (row === null) return { ok: true, value: null };
    const proposal = parsePersistedCommerceProposalJson(row.payload);
    const acceptance = parseCommerceProposalAcceptance(row.acceptance_json);
    if (proposal === null || acceptance === null)
      return invalid("case_storage_corrupt");
    const entityPlaneProposal = "proposal" in proposal ? proposal : null;
    return {
      ok: true,
      value: entityPlaneProposal,
    };
  }

  async acceptEmailProposal(
    raw: unknown,
  ): Promise<CaseResult<{ readonly kind: "accepted" | "duplicate" }>> {
    const input = parseCaseEmailProposal(raw);
    if (input === null) return invalid("case_email_proposal_invalid");
    if (input.caseId !== readCaseMetaId(this.ctx.storage.sql)) {
      return invalid("case_email_proposal_case_mismatch");
    }
    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ payload: string }>(
          "SELECT payload FROM case_email_proposal WHERE proposal_id = ? AND version = ?",
          input.proposalId,
          input.version,
        )
        .toArray()[0];
      const payload = JSON.stringify(input);
      if (existing !== undefined) {
        return existing.payload === payload
          ? { ok: true as const, value: { kind: "duplicate" as const } }
          : invalid("case_email_proposal_conflict");
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO case_email_proposal (proposal_id, version, payload) VALUES (?, ?, ?)",
        input.proposalId,
        input.version,
        payload,
      );
      return { ok: true as const, value: { kind: "accepted" as const } };
    });
  }

  async transitionEmailProposal(
    raw: unknown,
  ): Promise<CaseResult<{ readonly kind: "transitioned" | "unchanged" }>> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return invalid("case_email_proposal_transition_invalid");
    }
    const request = raw as Record<string, unknown>;
    const lifecycle = parseEmailReplyProposalLifecycle(request.lifecycle);
    if (
      !lifecycle.ok ||
      typeof request.proposalId !== "string" ||
      typeof request.version !== "number" ||
      !Number.isSafeInteger(request.version)
    ) {
      return invalid("case_email_proposal_transition_invalid");
    }
    const proposalId = request.proposalId;
    const version = request.version;
    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ payload: string }>(
          "SELECT payload FROM case_email_proposal WHERE proposal_id = ? AND version = ?",
          proposalId,
          version,
        )
        .toArray()[0];
      if (existing === undefined) return invalid("case_email_proposal_unknown");
      const parsed = parseCaseEmailProposalJson(existing.payload);
      if (parsed === null) return invalid("case_email_proposal_corrupt");
      const move = emailReplyProposalTransition(
        parsed.lifecycle.kind,
        lifecycle.value.kind,
      );
      // A repeat of the terminal state changes nothing, so the copies may
      // follow it. Any other move out of a terminal state is immutable, and a
      // move that the machine does not allow is refused.
      if (move.kind === "repeat")
        return { ok: true as const, value: { kind: "unchanged" as const } };
      if (move.kind === "refused")
        return invalid(
          move.terminal
            ? "case_email_proposal_immutable"
            : "case_email_proposal_transition_refused",
        );
      const written = this.ctx.storage.sql.exec(
        `UPDATE case_email_proposal SET payload = ?
          WHERE proposal_id = ? AND version = ?
            AND json_extract(payload, '$.lifecycle.kind') = ?`,
        JSON.stringify({ ...parsed, lifecycle: lifecycle.value }),
        proposalId,
        version,
        parsed.lifecycle.kind,
      );
      if (written.rowsWritten !== 1)
        return invalid("case_email_proposal_transition_stale");
      return { ok: true as const, value: { kind: "transitioned" as const } };
    });
  }

  async readEmailProposals(): Promise<
    CaseResult<readonly CaseEmailProposal[]>
  > {
    const rows = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM case_email_proposal ORDER BY proposal_id, version",
      )
      .toArray();
    const proposals: CaseEmailProposal[] = [];
    for (const row of rows) {
      const parsed = parseCaseEmailProposalJson(row.payload);
      if (parsed === null) return invalid("case_email_proposal_corrupt");
      proposals.push(parsed);
    }
    return { ok: true, value: proposals };
  }

  async readMailWork(
    input: Readonly<{
      organisationId: OrganisationId;
      caseId: CaseId;
      threadId: string;
    }>,
  ): Promise<CaseResult<Variant<MailInboxWork, "linked">>> {
    // Inbox projection excludes Case journals, objectives and assignment context.
    const sql = this.ctx.storage.sql;
    const meta = readMeta(sql);
    if (
      meta === null ||
      meta.organisation_id !== input.organisationId ||
      meta.case_id !== input.caseId
    )
      return invalid("mail_inbox_not_found");
    const lifecycle = parseLifecycle(meta.lifecycle_json);
    if (lifecycle === null) return invalid("case_storage_corrupt");
    const assignmentRows = sql
      .exec<LifecycleRow>(
        "SELECT lifecycle_json FROM case_assignment ORDER BY rowid DESC LIMIT 21",
      )
      .toArray();
    const assignments: MailWorkAssignment[] = [];
    for (const row of assignmentRows.slice(0, 20)) {
      const assignment = parseAssignmentLifecycleJson(row.lifecycle_json);
      if (assignment === null) return invalid("case_storage_corrupt");
      assignments.push(mailWorkAssignment(assignment));
    }
    const proposalRows = sql
      .exec<JsonRow>(
        `SELECT payload FROM case_email_proposal AS current
       WHERE json_extract(payload, '$.threadId') = ?
         AND json_extract(payload, '$.kind') IS NULL
         AND version = (SELECT MAX(version) FROM case_email_proposal WHERE proposal_id = current.proposal_id)
       ORDER BY rowid DESC LIMIT 21`,
        input.threadId,
      )
      .toArray();
    const replies: MailWorkReply[] = [];
    for (const row of proposalRows.slice(0, 20)) {
      const proposal = parseCaseEmailProposalJson(row.payload);
      if (
        proposal === null ||
        "kind" in proposal ||
        proposal.caseId !== input.caseId ||
        proposal.threadId !== input.threadId
      )
        return invalid("case_storage_corrupt");
      replies.push(mailWorkReply(proposal));
    }
    return {
      ok: true,
      value: {
        kind: "linked",
        caseId: meta.case_id,
        revision: meta.revision,
        state: mailWorkCaseState(lifecycle),
        assignments,
        replies,
        moreAssignments: assignmentRows.length > 20,
        moreReplies: proposalRows.length > 20,
      },
    };
  }

  async waitForCommerceApproval(raw: unknown) {
    return this.trackExecution(
      this.admittedWaitForCommerceApproval.bind(this, raw),
    );
  }

  private async admittedWaitForCommerceApproval(raw: unknown): Promise<
    CaseResult<{
      readonly kind: "waiting" | "already_waiting" | "already_resolved";
      readonly revision: number;
      /** The approval notice for the thread, when the caller gave one. */
      readonly notice: CaseOutputLifecycle | null;
    }>
  > {
    const admission = await this.admitCommerceMutation(raw);
    if (admission === null) return invalid("case_execution_authority_inactive");
    const input = parseWaitForCommerceApprovalRequest(raw);
    if (input === null)
      return invalid("case_commerce_approval_request_invalid");
    const content =
      isRecord(raw) && raw.notice !== undefined
        ? parseCaseContent(raw.notice)
        : undefined;
    if (content === null || (content !== undefined && content.kind !== "text"))
      return invalid("case_commerce_approval_request_invalid");
    let notice: CommerceApprovalNotice | undefined;
    if (content !== undefined) {
      const flowBinding = await readCommerceProposalFlowBinding(
        this.ctx.storage.sql,
        input.proposalId,
      );
      if (!flowBinding.ok) return invalid(flowBinding.error.code);
      notice = {
        content,
        digest: await sha256Hex(JSON.stringify(content)),
        flowBinding: flowBinding.value,
      };
    }
    if (!(await this.commerceMutationActive(admission)))
      return invalid("case_execution_authority_inactive");
    const result = this.ctx.storage.transactionSync(
      waitForCommerceApproval.bind(null, this.ctx.storage.sql, input, notice),
    );
    if (!(await this.commerceMutationActive(admission)))
      return invalid("case_execution_authority_inactive");
    if (!result.ok) return result;
    const stored = result.value.notice;
    if (stored === null)
      return { ok: true, value: { ...result.value, notice: null } };
    const restored = await restoreOutputLifecycle(stored);
    if (!restored.ok) return invalid(restored.error.code);
    if (result.value.kind === "waiting")
      await enqueueCaseContextProjection(
        this.env,
        this.ctx.storage.sql,
        input.caseId,
        `commerce_approval_notice:${input.actionNonce}`,
      );
    return {
      ok: true,
      value: {
        ...result.value,
        notice: serializeOutputLifecycle(restored.value),
      },
    };
  }

  /** The card text of an action's approval notice, or null without one. */
  async readCommerceApprovalNotice(
    input: Readonly<{ caseId: string; actionNonce: string }>,
  ): Promise<string | null> {
    const meta = readMeta(this.ctx.storage.sql);
    if (meta === null || meta.case_id !== input.caseId) return null;
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM case_journal WHERE entry_id = ?",
        `commerce_approval_notice:${input.actionNonce}`,
      )
      .toArray()[0];
    const content = row === undefined ? null : parseJsonOrNull(row.payload);
    return isRecord(content) && typeof content.text === "string"
      ? content.text
      : null;
  }

  async resolveCommerceApproval(raw: unknown): Promise<
    CaseResult<{
      readonly kind: "resolved" | "already_resolved";
      readonly revision: number;
    }>
  > {
    const input = parseResolveCommerceApprovalRequest(raw);
    if (input === null)
      return invalid("case_commerce_approval_decision_invalid");
    return this.ctx.storage.transactionSync(
      resolveCommerceApproval.bind(null, this.ctx.storage.sql, input),
    );
  }

  async acceptDeliveryReceipt(raw: unknown): Promise<
    CaseResult<{
      readonly kind: "settled" | "already_settled";
      readonly output: CaseOutputLifecycle;
    }>
  > {
    const input = parseAcceptDeliveryReceiptRequest(raw);
    if (input === null) return invalid("case_delivery_receipt_invalid");
    const binding = await readOutputFlowBinding(
      this.ctx.storage.sql,
      input.outputId,
    );
    if (!binding.ok) return invalid(binding.error.code);
    const expectedFlowBindingDigest = await digestFlowBinding(binding.value);
    const result = this.ctx.storage.transactionSync(
      settleCaseOutput.bind(null, this.ctx.storage.sql, {
        ...input,
        expectedFlowBindingDigest,
      }),
    );
    if (!result.ok) return result;
    const output = await restoreOutputLifecycle(result.value.output);
    if (!output.ok) return invalid(output.error.code);
    return {
      ok: true,
      value: {
        kind: result.value.kind,
        output: serializeOutputLifecycle(output.value),
      },
    };
  }

  /**
   * Records that an output waits for a person's decision (Refactor 15). No
   * resume path sends a held output; only the decision moves it.
   */
  async holdOutput(
    raw: unknown,
  ): Promise<
    CaseResult<{ readonly kind: "held" | "already_held" | "not_pending" }>
  > {
    if (
      !isRecord(raw) ||
      typeof raw.outputId !== "string" ||
      typeof raw.requestId !== "string" ||
      raw.requestId.length === 0
    )
      return invalid("case_output_hold_invalid");
    const input = {
      outputId: raw.outputId,
      requestId: raw.requestId,
      heldAt: Date.now(),
    };
    return this.ctx.storage.transactionSync(() =>
      holdCaseOutputLifecycle(this.ctx.storage.sql, input),
    );
  }

  /** Records that the provider refused an output's delivery for good. */
  async rejectOutput(
    raw: unknown,
  ): Promise<CaseResult<{ readonly kind: "rejected" | "not_open" }>> {
    if (
      !isRecord(raw) ||
      typeof raw.outputId !== "string" ||
      typeof raw.reason !== "string" ||
      raw.reason.length === 0
    )
      return invalid("case_output_reject_invalid");
    const input = {
      outputId: raw.outputId,
      reason: raw.reason,
      rejectedAt: Date.now(),
    };
    return this.ctx.storage.transactionSync(() =>
      rejectCaseOutputLifecycle(this.ctx.storage.sql, input),
    );
  }

  /**
   * Drop an output that waited for a person's approval. The Case journal
   * says so in fixed text, so that the agent's next turn knows that the
   * answer was not sent. A repeated call changes nothing.
   */
  async dropHeldOutput(raw: unknown): Promise<
    CaseResult<{
      readonly kind: "dropped" | "already_dropped";
    }>
  > {
    const input = parseDropHeldOutputRequest(raw);
    if (input === null) return invalid("case_output_drop_invalid");
    const binding = await readOutputFlowBinding(
      this.ctx.storage.sql,
      input.outputId,
    );
    if (!binding.ok) return invalid(binding.error.code);
    const content = {
      kind: "text" as const,
      text: droppedOutputNote(input.reason),
    };
    const label = await FlowLabel.create([
      {
        owner: {
          kind: "organisation",
          organisationId: binding.value.organisationId,
        },
        readers: [sourceReaderForAuthority(input.requestAuthority)],
      },
    ]);
    if (!label.ok) return invalid("case_output_drop_invalid");
    const digest = await sha256Hex(JSON.stringify(content));
    const result = this.ctx.storage.transactionSync(
      dropCaseOutput.bind(null, this.ctx.storage.sql, {
        ...input,
        content,
        digest,
        label: label.value,
        replayAuthority: replayAuthorityForFlowBinding(binding.value),
      }),
    );
    if (result.ok && result.value.kind === "dropped")
      await this.scheduleContextProjections();
    return result;
  }

  /**
   * Record that a tool effect did not happen, because a person denied it or
   * nobody decided. The next turn reads this fixed text. A repeated call adds
   * nothing.
   */
  async noteRefusedEffect(raw: unknown): Promise<CaseResult<null>> {
    const input = parseNoteRefusedEffectRequest(raw);
    if (input === null) return invalid("case_effect_note_invalid");
    const content = {
      kind: "text" as const,
      text: refusedEffectNote(input.reason),
    };
    const label = await FlowLabel.create([
      {
        owner: { kind: "organisation", organisationId: input.organisationId },
        readers: [sourceReaderForAuthority(input.requestAuthority)],
      },
    ]);
    if (!label.ok) return invalid("case_effect_note_invalid");
    const digest = await sha256Hex(JSON.stringify(content));
    const entryId = `effect_refused:${input.requestId}`;
    const sql = this.ctx.storage.sql;
    const noted = this.ctx.storage.transactionSync(() => {
      const meta = readMeta(sql);
      if (meta === null) return false;
      if (readJournal(sql, entryId) !== null || !isOpen(meta.lifecycle_json))
        return false;
      appendJournal(
        sql,
        entryId,
        content,
        digest,
        input.requestAuthority,
        sourceReaderForAuthority(input.requestAuthority),
        label.value,
        replayAuthorityForPartition(input.authorityPartitionDigest),
        input.notedAt,
      );
      retainContextProjection(sql, entryId);
      sql.exec(
        "UPDATE case_meta SET revision = ? WHERE singleton = 1",
        meta.revision + 1,
      );
      return true;
    });
    if (noted) await this.scheduleContextProjections();
    return { ok: true, value: null };
  }

  async acceptCommerceOutcome(
    raw: unknown,
  ): Promise<CaseResult<CaseCommerceOutcomeAcceptance>> {
    const input = parseAcceptCommerceOutcomeRequest(raw);
    if (input === null) return invalid("case_commerce_outcome_invalid");
    // An action ran, so the ledger decided it. A Case that still waits on it
    // missed that decision; it reads it first, so the receipt is accepted.
    await this.syncWaitBeforeOutcome(input.actionNonce);
    const flowBinding = await readCommerceProposalFlowBinding(
      this.ctx.storage.sql,
      input.proposalId,
    );
    if (!flowBinding.ok) return invalid(flowBinding.error.code);
    if (input.outcome.kind === "provider_receipt") {
      const expectedFlowBindingDigest = await digestFlowBinding(
        flowBinding.value,
      );
      if (
        input.outcome.receipt.flowBindingDigest !== expectedFlowBindingDigest
      ) {
        return invalid("case_commerce_outcome_flow_mismatch");
      }
    }
    const digest = await sha256Hex(JSON.stringify(input.content));
    const result = this.ctx.storage.transactionSync(
      acceptCommerceOutcome.bind(
        null,
        this.ctx.storage.sql,
        { ...input, flowBinding: flowBinding.value },
        digest,
      ),
    );
    if (!result.ok) return result;
    const output =
      result.value.output === null
        ? { ok: true as const, value: null }
        : await restoreOutputLifecycle(result.value.output);
    if (!output.ok) return invalid(output.error.code);
    const restored = {
      ok: true as const,
      value: { ...result.value, output: output.value },
    };
    if (restored.ok) {
      await enqueueCaseContextProjection(
        this.env,
        this.ctx.storage.sql,
        input.caseId,
        `commerce_outcome:${input.actionNonce}`,
      );
    }
    return {
      ok: true,
      value: {
        ...restored.value,
        output:
          restored.value.output === null
            ? null
            : serializeOutputLifecycle(restored.value.output),
      },
    };
  }

  async inspect(): Promise<CaseResult<CaseSnapshot>> {
    return inspectCase(this.ctx.storage.sql);
  }

  /**
   * The assignment lifecycles of this Case and nothing else. The abandon
   * step reads them here, so an old answer whose stored label no longer
   * restores does not keep a stopped assignment active (Refactor 15).
   */
  async assignmentLifecycles(): Promise<
    CaseResult<readonly CaseAssignmentLifecycle[]>
  > {
    const lifecycles = readAssignmentLifecycles(this.ctx.storage.sql);
    return lifecycles === null
      ? invalid("case_storage_corrupt")
      : { ok: true, value: lifecycles };
  }

  /**
   * The execution records of this Case with their stored labels, for the
   * execution projection. The caller decides what its reader may see.
   */
  async readExecutionRecords(): Promise<CaseExecutionCaseRecords | null> {
    return this.discarded
      ? null
      : readCaseExecutionRecords(this.ctx.storage.sql);
  }

  /** The stored content of one record. The caller has authorized the read. */
  async readExecutionContent(
    target: CaseExecutionContentTarget,
  ): Promise<readonly CaseExecutionStoredContent[] | null> {
    return this.discarded
      ? null
      : readCaseExecutionContent(this.ctx.storage.sql, target);
  }

  /** Every attachment object a trigger of this case still names. */
  async listReachableAttachmentObjectKeys(): Promise<readonly string[]> {
    const keys = new Set<string>();
    for (const row of this.ctx.storage.sql
      .exec<JsonRow>("SELECT payload FROM case_trigger")
      .toArray()) {
      let trigger: CaseTriggerRecord | null;
      try {
        trigger = parseCaseTrigger(JSON.parse(row.payload));
      } catch {
        throw new Error("case_attachment_inventory_invalid");
      }
      if (trigger === null)
        throw new Error("case_attachment_inventory_invalid");
      for (const key of reachableAttachmentObjectKeys(trigger.attachments))
        keys.add(key);
    }
    return [...keys];
  }
}

function discardableQuarantinedCaseActivation(
  activation: ActorActivationInspection,
  expectedSchemaVersion: number,
): boolean {
  return (
    activation.kind === "mismatch" &&
    activation.reason === "identity" &&
    activation.schemaVersion === expectedSchemaVersion &&
    activation.mismatchedFields.length === 3 &&
    activation.mismatchedFields[0] === "registryId" &&
    activation.mismatchedFields[1] === "activationToken" &&
    activation.mismatchedFields[2] === "fenceToken"
  );
}

function createCaseSchema(sql: SqlStorage): void {
  createActorActivationSchema(sql);
  createActorExecutionBarrierSchema(sql);
  createActorImportSchema(sql);
  createConversationExecutionSchema(sql);
  createCaseGoalSchema(sql);
  runCaseSchemaMigrations(sql);
}

// The person whose accepted authority admitted an entry, when a person did.
function journalAuthorPersonId(requestAuthorityJson: string): string | null {
  const authority = parseStoredRequestAuthority(
    parseJsonOrNull(requestAuthorityJson),
  );
  if (!authority.ok) return null;
  const accepted = authority.value.requestAuthority;
  return accepted.kind === "control" || accepted.kind === "direct_conversation"
    ? accepted.requesterPersonId
    : null;
}
