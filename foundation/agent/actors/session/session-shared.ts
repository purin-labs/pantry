import {
  markSteeringInputJournaled,
  steeringInputsToJournal,
  turnTriggerEntryId,
} from "../harness-steering";
import { armAlarmBy } from "@purin-labs/actor-runtime/actors/lifecycle/actor-alarm";
import type { AcceptedInputRef, HarnessTurnLease } from "@purin-labs/contracts";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseCaseId,
  parseOrganisationId,
  newRequestId,
  type SessionId,
} from "@purin-labs/kernel/ids";
import { traceLog, traceWarn } from "@purin-labs/kernel/observability";
import type { Result } from "@purin-labs/kernel/result";
import { resolveActiveCaseActorAtPlacement } from "@purin-labs/actor-runtime/actors/actor-router";
import type { PlacedActorRpc } from "@purin-labs/actor-runtime/actors/actor-stubs";
import { type AgentSessionPersistence } from "../agent-session-schema";
import { SessionExecutionAdmission } from "../session-execution-admission";
import { type CanonicalHarnessCheckpointPayload } from "../agent-session-harness-checkpoint";
import { ActiveAttachmentPreparationControl } from "../message-attachment-preparation";
import { releaseEndedCodeModeExecutions } from "../agent-session-code-mode-settlement";
import type { EmbeddedHarnessActiveTurn } from "../embedded-harness";
import { type PortalChatCleanupError } from "../portal-chat-cleanup";
import type { ActorExportError } from "@purin-labs/actor-runtime/actors/actor-export";
import { errorMessage } from "@purin-labs/std";
import { deferredExecutionRelease } from "./replay";
import {
  CODE_MODE_RELEASE_RETRY_MS,
  type TrackedTransientSessionExecution,
} from "./support";
import type { SessionToolWiring } from "./tool-wiring";
import type {
  CanonicalHarnessEventError,
  CheckpointPublicationError,
} from "./types";
import {
  acceptHarnessEvent,
  appendHarnessHistory,
  type AcceptHarnessEventInput,
  type AppendHarnessHistoryInput,
  type HarnessAuthorityError,
  type HarnessEventAcceptance,
  type HarnessHistoryAcceptanceWithUsage,
} from "../agent-session-harness-authority";

/**
 * The RPC method of the Case Actor that journals one steering input of a
 * person in the Case. The input parses there. `CaseActor` of the
 * conversation module implements it; this module is below it, so the
 * Session names this interface and not the class.
 */
export interface CaseSteeringRpc {
  acceptSteeringInput(
    raw: unknown,
  ): Promise<
    Result<
      { readonly kind: "accepted" | "duplicate" },
      { readonly code: string }
    >
  >;
}

/**
 * The state that the modules of the Session actor share (Refactor 17, step
 * A1.9). The Actor makes one value in its constructor and gives it to each
 * module, so a module names its state and does not reach a field of a class
 * above or below it. The value lives as long as the Actor instance: it holds
 * no stored row, and a new instance starts with the values below.
 */
export class SessionShared {
  constructor(
    private readonly actor: Readonly<{
      ctx(): DurableObjectState;
      env(): Env;
    }>,
    /** The agent tools and the parts of the areas, from the Worker's class. */
    readonly sessionTools: () => SessionToolWiring,
  ) {}

  /** The state of the Actor instance. */
  get ctx(): DurableObjectState {
    return this.actor.ctx();
  }

  /**
   * The bindings of the Actor, read at each use: a module sees the same
   * bindings as a method of the Actor class.
   */
  get env(): Env {
    return this.actor.env();
  }

  persistence!: AgentSessionPersistence;

  portalChatCleanup: Promise<Result<void, PortalChatCleanupError>> | null =
    null;

  portalChatQuiescence: Promise<Result<null, ActorExportError>> | null = null;

  canonicalTurn: Promise<Result<null, ActorExportError>> | null = null;

  /**
   * The payload of the checkpoint the turn being started restores, when its
   * read began beside the turn's admission. Only the restore of that same
   * checkpoint record takes it.
   */
  startedCheckpointPayload: {
    readonly checkpoint: string;
    readonly payload: CanonicalHarnessCheckpointPayload;
  } | null = null;

  /** The archive write of the last accepted checkpoint, while it runs. */
  checkpointPublication: Promise<
    Result<null, CheckpointPublicationError>
  > | null = null;

  readonly transientExecutions = new Set<TrackedTransientSessionExecution>();

  readonly liveGoalRuns = new Set<string>();

  activeMessagePreparation: ActiveAttachmentPreparationControl | null = null;

  activeEmbeddedHarnessTurn: {
    readonly leaseId: HarnessTurnLease["leaseId"];
    readonly lease: HarnessTurnLease;
    readonly acceptedInput: AcceptedInputRef;
    readonly execution: SessionExecutionAdmission;
    readonly turn: EmbeddedHarnessActiveTurn;
  } | null = null;

  /**
   * Releases the Code Mode executions that an ended turn left open. A turn
   * that is cancelled, that fails, or that cannot resume settles no script,
   * so its reservation is released at its owners. The alarm repeats a
   * release that an owner deferred.
   */
  async releaseEndedExecutions(): Promise<void> {
    const released = await releaseEndedCodeModeExecutions({
      env: this.env,
      storage: this.ctx.storage,
      now: Date.now(),
    }).catch(deferredExecutionRelease);
    if (released.deferred)
      await armAlarmBy(
        this.ctx.storage,
        Date.now() + CODE_MODE_RELEASE_RETRY_MS,
      );
  }

  /**
   * Journal in the Case the steering inputs that a turn placed (Plan 71).
   * The run calls this when the turn ends. An input that the turn did not
   * place stays out of the Case, so a surface can run it as a new turn. A
   * failed call leaves the input unjournaled, and a resumed run of the turn
   * tries again.
   */
  async journalPlacedSteeringInputs(
    input: {
      readonly execution: SessionExecutionAdmission;
      readonly lease: HarnessTurnLease;
    },
    sessionId: SessionId,
  ): Promise<void> {
    const turnId = String(input.lease.turn.turnId);
    const placed = steeringInputsToJournal(
      this.ctx.storage.sql,
      sessionId,
      turnId,
    );
    const triggerEntryId = turnTriggerEntryId(turnId);
    if (placed.length === 0 || triggerEntryId === null) return;
    try {
      const organisationId = parseOrganisationId(
        input.lease.session.organisationId,
      );
      if (!organisationId.ok) throw new Error("steering_organisation_invalid");
      for (const steering of placed) {
        if (steering.inputRef.kind !== "case")
          throw new Error("steering_input_not_case");
        const caseId = parseCaseId(steering.inputRef.caseId);
        if (!caseId.ok) throw new Error("steering_case_invalid");
        const caseActor = await resolveActiveCaseActorAtPlacement<
          PlacedActorRpc & CaseSteeringRpc
        >({
          env: this.env,
          namespace: this.env.CASE,
          organisationId: organisationId.value,
          caseId: caseId.value,
          placement: input.execution.scope.placement,
          now: Date.now(),
        });
        if (!caseActor.ok) throw new Error(caseActor.error.code);
        const journaled = await caseActor.value.acceptSteeringInput({
          caseId: steering.inputRef.caseId,
          assignmentId: steering.inputRef.assignmentId,
          inputId: steering.inputId,
          triggerEntryId,
          content: { kind: "user_message", message: steering.message },
          requestAuthority: input.lease.requestAuthority,
          acceptedAt: steering.admittedAt,
        });
        if (!journaled.ok) throw new Error(journaled.error.code);
        markSteeringInputJournaled(
          this.ctx.storage.sql,
          sessionId,
          steering.inputId,
          Date.now(),
        );
      }
    } catch (error) {
      traceWarn("agent_session.steering_journal_failed", {
        requestId: newRequestId(),
        turn_id: turnId,
        error: errorMessage(error).slice(0, 300),
      });
    }
  }

  /** Accepts one event of the harness. The harness calls it as its sink. */
  async acceptCanonicalHarnessEvent(
    input: AcceptHarnessEventInput,
  ): Promise<Result<HarnessEventAcceptance, CanonicalHarnessEventError>> {
    return acceptHarnessEvent(this.ctx.storage, input);
  }

  async appendHarnessHistory(
    input: AppendHarnessHistoryInput,
  ): Promise<
    Result<
      HarnessHistoryAcceptanceWithUsage,
      | HarnessAuthorityError
      | { readonly code: "canonical_session_schema_mismatch" }
    >
  > {
    const appendStartedAt = Date.now();
    const result = await appendHarnessHistory(this.ctx.storage, input);
    if (result.ok) {
      traceLog("session.harness_history_append_metrics", {
        requestId: newRequestId(),
        session_id: input.sessionId,
        turn_id: input.turn.turnId,
        outcome: result.value.kind,
        entry_count: result.value.usage.entryCount,
        durable_bytes: result.value.usage.inlineBytes,
        append_duration_ms: Date.now() - appendStartedAt,
      });
    }
    return result;
  }
}
