import {
  markSteeringInputJournaled,
  steeringInputsToJournal,
  turnTriggerEntryId,
} from "../harness-steering";
import { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { armAlarmBy } from "../lifecycle/actor-alarm";
import type { AcceptedInputRef, HarnessTurnLease } from "@purin-labs/contracts";
import type { Env } from "../../env";
import {
  parseCaseId,
  parseOrganisationId,
  newRequestId,
  type SessionId,
  type OrganisationId,
} from "../../ids";
import { traceLog, traceWarn } from "../../observability";
import type { Result } from "../../result";
import { resolveActiveCaseActorAtPlacement } from "../actor-router";
import { type AgentSessionPersistence } from "../agent-session-schema";
import { SessionExecutionAdmission } from "../session-execution-admission";
import { readCanonicalSessionForPersistence } from "../agent-session-canonical";
import {
  acceptHarnessEvent,
  appendHarnessHistory,
  type AcceptHarnessEventInput,
  type AppendHarnessHistoryInput,
  type HarnessAuthorityError,
  type HarnessEventAcceptance,
  type HarnessHistoryAcceptanceWithUsage,
} from "../agent-session-harness-authority";
import { type CanonicalHarnessCheckpointPayload } from "../agent-session-harness-checkpoint";
import { ActiveAttachmentPreparationControl } from "../message-attachment-preparation";
import { releaseEndedCodeModeExecutions } from "../agent-session-code-mode-settlement";
import type { EmbeddedHarnessActiveTurn } from "../embedded-harness";
import {
  canAdmitSessionWork,
  isPortalChatCleanupPlacementActive,
  readPortalChatErasure,
  PORTAL_CHAT_ERASURE_KEY,
  type PortalChatCleanupError,
  type PortalChatCleanupRequest,
  type PortalChatErasure,
} from "../portal-chat-cleanup";
import { eraseActorContentSql } from "../placement-execution-quiescence";
import type { ActorExportError } from "../actor-export";
import type { Variant } from "@purin-labs/type-utils";
import { errorMessage } from "@purin-labs/std";
import { PlacedActor } from "../lifecycle/placed-actor";
import { deferredExecutionRelease } from "./replay";
import {
  CODE_MODE_RELEASE_RETRY_MS,
  type TrackedTransientSessionExecution,
  sessionPlacementR2Keys,
} from "./support";
import type { SessionToolWiring } from "./tool-wiring";
import type {
  CanonicalHarnessEventError,
  CheckpointPublicationError,
} from "./types";

/**
 * The Session actor's state and its Portal chat cleanup (Refactor 10, step 2.5). The layers above it add checkpoints, harness turns, recovery and transient turns; `SessionDO` adds the RPC methods.
 */
export abstract class SessionActorBase extends PlacedActor<null> {
  protected persistence!: AgentSessionPersistence;

  /**
   * The agent tools and the parts of the product areas. The Worker's class
   * gives them, so the Session names no area. It is a method, not a field:
   * the constructor reads it before a field of the last class exists.
   */
  protected abstract sessionTools(): SessionToolWiring;

  protected portalChatCleanup: Promise<
    Result<void, PortalChatCleanupError>
  > | null = null;

  protected portalChatQuiescence: Promise<
    Result<null, ActorExportError>
  > | null = null;

  protected canonicalTurn: Promise<Result<null, ActorExportError>> | null =
    null;

  /**
   * The payload of the checkpoint the turn being started restores, when its
   * read began beside the turn's admission. Only the restore of that same
   * checkpoint record takes it.
   */
  protected startedCheckpointPayload: {
    readonly checkpoint: string;
    readonly payload: CanonicalHarnessCheckpointPayload;
  } | null = null;

  /** The archive write of the last accepted checkpoint, while it runs. */
  protected checkpointPublication: Promise<
    Result<null, CheckpointPublicationError>
  > | null = null;

  protected readonly transientExecutions =
    new Set<TrackedTransientSessionExecution>();

  protected readonly liveGoalRuns = new Set<string>();

  protected activeMessagePreparation: ActiveAttachmentPreparationControl | null =
    null;

  protected activeEmbeddedHarnessTurn: {
    readonly leaseId: HarnessTurnLease["leaseId"];
    readonly lease: HarnessTurnLease;
    readonly acceptedInput: AcceptedInputRef;
    readonly execution: SessionExecutionAdmission;
    readonly turn: EmbeddedHarnessActiveTurn;
  } | null = null;

  protected async admitPortalChatCleanup(
    input: PortalChatCleanupRequest,
  ): Promise<Result<void, PortalChatCleanupError>> {
    try {
      const execution = await OrganisationExecutionScope.resolveAtPlacement(
        this.env,
        input.requestingOrganisationId,
        input.placement,
      );
      if (
        !execution.ok ||
        !(await isPortalChatCleanupPlacementActive(
          execution.value.database,
          input,
        ))
      )
        return { ok: false, error: { code: "chat_cleanup_conflict" } };
      let erasure = await readPortalChatErasure(this.ctx.storage);
      if (
        erasure !== null &&
        (erasure.organisationId !== input.requestingOrganisationId ||
          erasure.sessionId !== input.sessionId)
      )
        throw new Error("session_organisation_mismatch");
      if (erasure === null) {
        const session = await readCanonicalSessionForPersistence(
          this.persistence,
          this.ctx.storage.sql,
          input.requestingOrganisationId,
        );
        if (!session.ok) throw new Error(session.error.code);
        if (session.value.sessionId !== input.sessionId)
          throw new Error("session_identity_mismatch");
        erasure = {
          kind: "pending",
          organisationId: input.requestingOrganisationId,
          sessionId: input.sessionId,
          objectKeys: [
            ...new Set([
              ...input.objectKeys,
              ...sessionPlacementR2Keys(this.ctx.storage.sql),
            ]),
          ],
        };
      }
      // A placement read may finish after export has closed local admission.
      if (!canAdmitSessionWork(this.ctx.storage.sql, input))
        return { ok: false, error: { code: "chat_cleanup_conflict" } };
      if (erasure.kind === "erased") return { ok: true, value: undefined };
      await this.ctx.storage.put(PORTAL_CHAT_ERASURE_KEY, erasure);
      await this.finishPortalChatCleanup(erasure);
      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: { code: "chat_cleanup_failed", detail: errorMessage(error) },
      };
    }
  }

  protected async finishPortalChatCleanup(
    erasure: Variant<PortalChatErasure, "pending">,
  ): Promise<void> {
    await this.activeMessagePreparation?.cancel();
    await this.activeEmbeddedHarnessTurn?.turn.cancel();
    // An archive write that is in flight would put the checkpoint back after
    // the delete below.
    await this.checkpointPublication;
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.transactionSync(
      eraseActorContentSql.bind(null, this.ctx.storage.sql),
    );
    const keys: string[] = [];
    for (const key of (await this.ctx.storage.list()).keys()) {
      if (key !== PORTAL_CHAT_ERASURE_KEY) keys.push(key);
    }
    if (keys.length > 0) await this.ctx.storage.delete(keys);
    if (erasure.objectKeys.length > 0)
      await this.env.ARCHIVE.delete([...erasure.objectKeys]);
    await this.ctx.storage.put(PORTAL_CHAT_ERASURE_KEY, {
      kind: "erased",
      organisationId: erasure.organisationId,
      sessionId: erasure.sessionId,
    } satisfies PortalChatErasure);
  }

  protected async drainPortalChatCleanup(identity: {
    readonly organisationId: OrganisationId;
    readonly sessionId: SessionId;
  }): Promise<Result<null, ActorExportError>> {
    try {
      const cleanup = await this.portalChatCleanup;
      if (
        cleanup !== null &&
        !cleanup.ok &&
        cleanup.error.code === "chat_cleanup_failed"
      )
        return {
          ok: false,
          error: { code: "actor_cleanup_failed", detail: cleanup.error.detail },
        };
      const erasure = await readPortalChatErasure(this.ctx.storage);
      if (
        erasure !== null &&
        (erasure.organisationId !== identity.organisationId ||
          erasure.sessionId !== identity.sessionId)
      )
        throw new Error("session_organisation_mismatch");
      if (erasure?.kind === "pending")
        await this.finishPortalChatCleanup(erasure);
      await this.activeMessagePreparation?.cancel();
      await this.activeEmbeddedHarnessTurn?.turn.cancel();
      const transientExecutions = [...this.transientExecutions];
      for (const transient of transientExecutions) {
        if (transient.execution.state.kind === "running") {
          const cancelled = await transient.execution.state.turn.cancel();
          if (!cancelled.ok) throw new Error(cancelled.error.detail);
        }
      }
      const execution = await this.canonicalTurn;
      if (execution !== null && !execution.ok) return execution;
      // A checkpoint's archive write continues after its turn's call.
      await this.checkpointPublication;
      for (const transient of transientExecutions) {
        const settled = await transient.settlement;
        if (!settled.ok) return settled;
      }
      return { ok: true, value: null };
    } catch (error) {
      return {
        ok: false,
        error: { code: "actor_cleanup_failed", detail: errorMessage(error) },
      };
    }
  }

  /**
   * Releases the Code Mode executions that an ended turn left open. A turn
   * that is cancelled, that fails, or that cannot resume settles no script,
   * so its reservation is released at its owners. The alarm repeats a
   * release that an owner deferred.
   */
  protected async releaseEndedExecutions(): Promise<void> {
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
  protected async journalPlacedSteeringInputs(
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
        const caseActor = await resolveActiveCaseActorAtPlacement({
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

  get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  get storage(): DurableObjectStorage {
    return this.ctx.storage;
  }

  get durableState(): DurableObjectState {
    return this.ctx;
  }

  get bindings(): Env {
    return this.env;
  }
}
