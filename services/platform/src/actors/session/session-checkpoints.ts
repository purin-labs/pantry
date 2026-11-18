import { acceptedExecutionAccountAuthority } from "../../account-platform/access";
import { reconcilePantryExecutionBilling } from "../../account-platform/execution-billing";
import { armAlarmBy } from "../lifecycle/actor-alarm";
import type { Outcome } from "@seams/contracts";
import { validateLiveRequestAuthority } from "../../request-authority";
import { readAcceptedCheckpointFinalization } from "../agent-session-finalization";
import type {
  HarnessCheckpointRecord,
  HarnessTurnLease,
} from "@seams/contracts";
import {
  parseSessionId,
  newRequestId,
  type RequestId,
  type SessionId,
  type OrganisationId,
} from "../../ids";
import { traceWarn } from "../../observability";
import { verifyWorkspaceRevisionReceipt } from "../../workspace-revision-store";
import type { Result } from "../../result";
import {
  SessionExecutionAdmission,
  reusableWorkspaceReceiptCheck,
  type FencedWorkspaceReceiptCheck,
} from "../session-execution-admission";
import { readCanonicalSessionForPersistence } from "../agent-session-canonical";
import {
  commitCompletedSessionTurn,
  type ActorTransitionCommitResult,
  type CheckpointCommittedSessionCommit,
} from "../actor-journal";
import {
  readUnpublishedHarnessCheckpoint,
  markHarnessCheckpointPublishedInTransaction,
} from "../agent-session-harness-authority";
import {
  loadCanonicalHarnessCheckpoint,
  uploadHarnessCheckpoint,
  validateActiveRunCheckpointBudgetBinding,
  validateCheckpointBudgetBinding,
} from "../agent-session-harness-checkpoint";
import { selectEmbeddedHarnessAdapterForModelRoute } from "../embedded-harness-adapter";
import {
  buildTextTurnCheckpointCommittedCommit,
  type CanonicalTextTurnCompletionIdentity,
} from "../agent-session-text-turn";
import {
  readSessionBudgetAccount,
  canonicalRunBudgetIdentity,
} from "../agent-session-budget";
import {
  readSessionTurnReplay,
  type SessionTurnStreamError,
} from "../agent-session-turn-stream";
import { readSessionTurnFlowBinding as readPersistedSessionTurnFlowBinding } from "../agent-session-information-flow";
import type { SerializedFlowBinding } from "../../policy";
import { checkpointPublicationFailure } from "./harness-source";
import { checkpointReceipt } from "./support";
import { traceSessionTurnCompletion } from "./traces";
import type {
  CanonicalEmbeddedHarnessTextTurnError,
  CanonicalEmbeddedHarnessTextTurnResult,
  CanonicalHarnessCheckpointRestoreError,
  CanonicalInputAcceptanceError,
  CheckpointPublicationError,
  SessionStateError,
  TurnStateInvalidError,
} from "./types";
import { SessionProposalStaging } from "./session-proposal-staging";

/**
 * Harness checkpoint restore, publication and finalization for accepted turns.
 */
export abstract class SessionCheckpoints extends SessionProposalStaging {
  protected async scheduleCheckpointFinalization(): Promise<void> {
    const due = Date.now() + 1_000;
    await armAlarmBy(this.ctx.storage, due);
  }

  async completeCanonicalCheckpointAndStream(input: {
    execution: SessionExecutionAdmission;
    checkpoint: CheckpointCommittedSessionCommit;
    lastSequence: number;
    completedAt: number;
  }): Promise<
    Result<
      ActorTransitionCommitResult,
      | CanonicalInputAcceptanceError
      | SessionTurnStreamError
      | TurnStateInvalidError
    >
  > {
    // The caller verified the checkpoint's receipt in the statement that also
    // read the placement fence, and has not waited since. Local admission can
    // still close in between, so it is read again here.
    if (!input.execution.isLocallyOpen())
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "execution_closed",
        },
      };
    return commitCompletedSessionTurn(this.ctx.storage, input);
  }

  protected async restoreCanonicalHarnessCheckpointForRun(
    lease: HarnessTurnLease,
    input: {
      requestingOrganisationId: OrganisationId;
      checkpoint: HarnessCheckpointRecord;
    },
  ): Promise<Result<ArrayBuffer, CanonicalHarnessCheckpointRestoreError>> {
    const execution = await SessionExecutionAdmission.resolve(
      this.env,
      this.ctx.storage,
      input.requestingOrganisationId,
    );
    if (execution === null || !(await execution.isTurnActive(lease)))
      return {
        ok: false,
        error: {
          code: "request_authority_inactive",
          detail: "restore_origin_inactive",
        },
      };
    const before = await validateLiveRequestAuthority({
      db: execution.scope.database,
      accountAccess: execution.scope.accountAccess,
      authority: lease.requestAuthority,
      userAuthority: acceptedExecutionAccountAuthority(
        lease.session.sessionId,
        lease.turn.turnId,
      ),
      action: "restore",
    });
    if (!before.ok) return before;
    const session = await readCanonicalSessionForPersistence(
      this.persistence,
      this.ctx.storage.sql,
      input.requestingOrganisationId,
    );
    if (!session.ok) return session;
    const account = readSessionBudgetAccount(this.ctx.storage.sql, {
      organisationId: input.requestingOrganisationId,
      sessionId: input.checkpoint.session.sessionId,
    });
    if (!account.ok) return account;
    const budgetBinding = await validateActiveRunCheckpointBudgetBinding({
      sql: this.ctx.storage.sql,
      account: account.value,
      checkpoint: input.checkpoint,
      identity: canonicalRunBudgetIdentity(lease),
    });
    if (!budgetBinding.ok) return budgetBinding;
    const adapter = selectEmbeddedHarnessAdapterForModelRoute(
      session.value.lifecycle.state.contract.modelRoute,
    );
    const started = this.startedCheckpointPayload;
    const restored = await loadCanonicalHarnessCheckpoint({
      bucket: this.env.ARCHIVE,
      root: this.env.DATA_ENCRYPTION_ROOT,
      state: session.value.lifecycle,
      checkpoint: input.checkpoint,
      manifest: adapter.manifest,
      sql: this.ctx.storage.sql,
      payload:
        started !== null &&
        started.checkpoint === JSON.stringify(input.checkpoint)
          ? started.payload
          : undefined,
    });
    if (!restored.ok) return restored;
    const current = await validateLiveRequestAuthority({
      db: execution.scope.database,
      accountAccess: execution.scope.accountAccess,
      authority: lease.requestAuthority,
      userAuthority: acceptedExecutionAccountAuthority(
        lease.session.sessionId,
        lease.turn.turnId,
      ),
      action: "restore",
    });
    if (!current.ok) return current;
    if (!(await execution.isTurnActive(lease)))
      return {
        ok: false,
        error: {
          code: "request_authority_inactive",
          detail: "restore_origin_inactive",
        },
      };
    return restored;
  }

  /**
   * Complete the turn of the accepted checkpoint, then publish the
   * checkpoint. The caller has read the placement fence and has not waited
   * since: the turn itself after its harness returned, the recovery alarm in
   * its admission.
   *
   * The checkpoint and its payload are in this Session's storage when the
   * turn completes, so neither the final stream record nor the turn's call
   * waits for the archive write. A failed archive write does not fail the
   * completed turn. The alarm repeats it, and the next turn waits for it.
   */
  protected async finalizeAcceptedSessionCheckpoint(input: {
    execution: SessionExecutionAdmission;
    requestingOrganisationId: OrganisationId;
    /**
     * The turn that accepted the checkpoint in this call, or the recovery
     * alarm that resumes a finalization an earlier call began.
     */
    caller:
      | {
          readonly kind: "turn";
          readonly requestId: RequestId;
          /** The receipt check that read the fence after the harness returned. */
          readonly receiptCheck: FencedWorkspaceReceiptCheck | null;
        }
      | { readonly kind: "recovery" };
    turnId: string;
  }): Promise<
    Result<
      Omit<CanonicalEmbeddedHarnessTextTurnResult, "modelUsage">,
      CanonicalEmbeddedHarnessTextTurnError
    >
  > {
    if (!input.execution.isLocallyOpen())
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "execution_closed",
        },
      };
    const pending = readAcceptedCheckpointFinalization(this.ctx.storage.sql);
    if (!pending.ok) return pending;
    if (
      pending.value.kind !== "pending" ||
      pending.value.finalization.current.state.turnId !== input.turnId ||
      pending.value.finalization.current.state.identity.organisationId !==
        input.requestingOrganisationId
    )
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "finalization_not_pending",
        },
      };
    const { current, checkpoint, publication } = pending.value.finalization;
    const completion: CanonicalTextTurnCompletionIdentity = {
      completionId: `finalize_${checkpoint.turn.turnId}_${checkpoint.cursor.lastSequence}`,
      acceptedAt: checkpoint.blob.createdAt,
    };
    const committed = await buildTextTurnCheckpointCommittedCommit({
      current,
      harnessCheckpoint: checkpoint,
      completion,
    });
    if (!committed.ok) return committed;
    const trace = {
      requestId:
        input.caller.kind === "turn" ? input.caller.requestId : newRequestId(),
      requestingOrganisationId: input.requestingOrganisationId,
    };
    // The receipt statement reads the placement fence together with the
    // receipt. A turn read it after its harness returned and has used only
    // this Session's storage since. The recovery alarm reads it here. Every
    // write of the completion follows it without a further wait.
    let phaseStartedAt = Date.now();
    const completionReceipt = checkpointReceipt(committed.value);
    const verified =
      (input.caller.kind === "turn"
        ? reusableWorkspaceReceiptCheck(
            input.caller.receiptCheck,
            completionReceipt,
          )
        : null) ??
      (await verifyWorkspaceRevisionReceipt(
        input.execution.scope,
        input.requestingOrganisationId,
        completionReceipt,
      ));
    traceSessionTurnCompletion(
      trace,
      input.turnId,
      "checkpoint_receipt",
      phaseStartedAt,
    );
    if (!verified.ok) {
      // A placement that is no longer active ends the step as a closed fence did.
      if (verified.error.code === "organisation_placement_conflict")
        return {
          ok: false,
          error: {
            code: "canonical_text_turn_state_invalid",
            reason: "placement_inactive",
          },
        };
      return {
        ok: false,
        error: {
          code: "workspace_revision_receipt_invalid",
          reason: verified.error.code,
        },
      };
    }
    if (!input.execution.isLocallyOpen())
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "execution_closed",
        },
      };
    phaseStartedAt = Date.now();
    const account = readSessionBudgetAccount(
      this.ctx.storage.sql,
      current.state.identity,
    );
    if (!account.ok) return account;
    const bound = await validateCheckpointBudgetBinding({
      checkpoint,
      account: account.value,
    });
    if (!bound.ok) return bound;
    const flow = await readPersistedSessionTurnFlowBinding(
      this.ctx.storage.sql,
      {
        organisationId: input.requestingOrganisationId,
        sessionId: current.state.identity.sessionId,
        turnId: input.turnId,
      },
    );
    if (!flow.ok || flow.value === null)
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "flow_binding_missing",
        },
      };
    const slept = await this.completeCanonicalCheckpointAndStream({
      execution: input.execution,
      checkpoint: committed.value,
      lastSequence: checkpoint.cursor.lastSequence - 1,
      completedAt: completion.acceptedAt,
    });
    traceSessionTurnCompletion(
      trace,
      input.turnId,
      "stream_completion",
      phaseStartedAt,
    );
    if (!slept.ok) return slept;
    this.ctx.waitUntil(
      reconcilePantryExecutionBilling({
        env: this.env,
        storage: this.ctx.storage,
      }),
    );
    // The turn is complete, and the archive write starts now. The Case
    // posts the answer when the turn's call returns, so that call does not
    // wait for the write. The next turn waits for it before it restores the
    // checkpoint. The recovery alarm has no caller to answer and waits here.
    if (publication.kind === "upload_pending") {
      const publishing = this.publishAcceptedCheckpoint({
        execution: input.execution,
        attempt: input.caller.kind === "turn" ? "first" : "resumed",
        trace,
      });
      if (input.caller.kind === "turn") this.ctx.waitUntil(publishing);
      else await publishing;
    }
    const sessionId = parseSessionId(current.state.identity.sessionId);
    if (!sessionId.ok)
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "session_id_invalid",
        },
      };
    const terminal = await this.readCompletedTurn({
      organisationId: input.requestingOrganisationId,
      sessionId: sessionId.value,
      turnId: input.turnId,
    });
    if (!terminal.ok)
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "stream_completion_refused",
        },
      };
    return {
      ok: true,
      value: {
        outcome: terminal.value.outcome,
        finalMessage: terminal.value.finalMessage,
        cursor: checkpoint.cursor,
        checkpoint,
        state: committed.value.state,
        flowBinding: terminal.value.flowBinding,
      },
    };
  }

  /**
   * Write this Session's unpublished checkpoint to the archive and mark it
   * published. One publication runs at a time, and a second caller gets the
   * running one. A failed publication has set the alarm that repeats it when
   * the result arrives. The result never rejects.
   */
  protected publishAcceptedCheckpoint(input: {
    execution: SessionExecutionAdmission;
    /**
     * "first" when the caller accepted the checkpoint in the same call.
     * "resumed" when an earlier call may have written it already.
     */
    attempt: "first" | "resumed";
    trace: {
      readonly requestId: RequestId;
      readonly requestingOrganisationId: OrganisationId;
    };
  }): Promise<Result<null, CheckpointPublicationError>> {
    if (this.checkpointPublication !== null) return this.checkpointPublication;
    const work = this.runCheckpointPublication(input)
      .catch(checkpointPublicationFailure)
      .then(this.deferFailedCheckpointPublication.bind(this, input.trace))
      .catch(checkpointPublicationFailure);
    this.checkpointPublication = work;
    void work.finally(this.clearCheckpointPublication.bind(this, work));
    return work;
  }

  /** A failed archive write is left to the alarm. */
  protected async deferFailedCheckpointPublication(
    trace: {
      readonly requestId: RequestId;
      readonly requestingOrganisationId: OrganisationId;
    },
    published: Result<null, CheckpointPublicationError>,
  ): Promise<Result<null, CheckpointPublicationError>> {
    if (published.ok) return published;
    traceWarn("session.checkpoint_publication_deferred", {
      requestId: trace.requestId,
      organisation_id: trace.requestingOrganisationId,
      reason: published.error.code,
    });
    await this.scheduleCheckpointFinalization();
    return published;
  }

  protected clearCheckpointPublication(
    work: Promise<Result<null, CheckpointPublicationError>>,
  ): void {
    if (this.checkpointPublication === work) this.checkpointPublication = null;
  }

  protected async runCheckpointPublication(input: {
    execution: SessionExecutionAdmission;
    attempt: "first" | "resumed";
    trace: {
      readonly requestId: RequestId;
      readonly requestingOrganisationId: OrganisationId;
    };
  }): Promise<Result<null, CheckpointPublicationError>> {
    if (!input.execution.isLocallyOpen())
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "execution_closed",
        },
      };
    const unpublished = readUnpublishedHarnessCheckpoint(this.ctx.storage.sql);
    if (!unpublished.ok) return unpublished;
    const publication = unpublished.value;
    if (publication === null) return { ok: true, value: null };
    const turnId = publication.checkpoint.turn.turnId;
    let phaseStartedAt = Date.now();
    const uploaded = await uploadHarnessCheckpoint({
      storage: this.ctx.storage,
      bucket: this.env.ARCHIVE,
      root: this.env.DATA_ENCRYPTION_ROOT,
      publication,
      attempt: input.attempt,
    });
    traceSessionTurnCompletion(
      input.trace,
      turnId,
      "checkpoint_upload",
      phaseStartedAt,
    );
    if (!uploaded.ok) return uploaded;
    // The upload is the last wait before the mark, so the placement fence is
    // read after it. The mark follows that read without a further wait.
    phaseStartedAt = Date.now();
    const active = await input.execution.isActive();
    traceSessionTurnCompletion(
      input.trace,
      turnId,
      "checkpoint_publish",
      phaseStartedAt,
    );
    if (!active)
      return {
        ok: false,
        error: {
          code: "canonical_text_turn_state_invalid",
          reason: "execution_inactive",
        },
      };
    const published = this.ctx.storage.transactionSync(
      markHarnessCheckpointPublishedInTransaction.bind(
        null,
        this.ctx.storage.sql,
        publication,
      ),
    );
    return published.ok ? { ok: true, value: null } : published;
  }

  async readSessionTurnFlowBinding(input: {
    readonly requestingOrganisationId: OrganisationId;
    readonly sessionId: SessionId;
    readonly turnId: string;
  }): Promise<Result<SerializedFlowBinding, SessionStateError>> {
    const session = await readCanonicalSessionForPersistence(
      this.persistence,
      this.ctx.storage.sql,
      input.requestingOrganisationId,
    );
    if (!session.ok) {
      return session.error.code === "canonical_session_organisation_mismatch"
        ? { ok: false, error: { code: "organisation_mismatch" } }
        : { ok: false, error: { code: "session_not_initialized" } };
    }
    if (session.value.sessionId !== input.sessionId) {
      return { ok: false, error: { code: "organisation_mismatch" } };
    }
    const binding = await readPersistedSessionTurnFlowBinding(
      this.ctx.storage.sql,
      {
        organisationId: input.requestingOrganisationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
      },
    );
    if (!binding.ok)
      return { ok: false, error: { code: "invalid_persisted_state" } };
    if (binding.value === null) {
      return { ok: false, error: { code: "session_turn_not_found" } };
    }
    return { ok: true, value: binding.value.binding.toJSON() };
  }

  async readCompletedTurn(input: {
    readonly organisationId: OrganisationId;
    readonly sessionId: SessionId;
    readonly turnId: string;
  }): Promise<
    Result<
      {
        readonly outcome: Outcome;
        readonly finalMessage: string;
        readonly flowBinding: SerializedFlowBinding;
      },
      SessionStateError
    >
  > {
    const binding = await this.readSessionTurnFlowBinding({
      requestingOrganisationId: input.organisationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
    });
    if (!binding.ok) return binding;
    let afterSequence = -1;
    let finalMessage: string | null = null;
    let outcome: Outcome | null = null;
    for (;;) {
      const replay = readSessionTurnReplay(this.ctx.storage.sql, {
        organisationId: input.organisationId,
        turnId: input.turnId,
        afterSequence,
      });
      if (!replay.ok) return replay;
      if (replay.value.state.kind !== "complete")
        return { ok: false, error: { code: "invalid_persisted_state" } };
      for (const envelope of replay.value.envelopes) {
        afterSequence = envelope.sequence;
        if (envelope.event.type === "done") outcome = envelope.event.outcome;
        if (
          envelope.event.type === "agent_message" &&
          envelope.event.finalMessage
        )
          finalMessage = envelope.event.text.trim();
      }
      if (replay.value.caughtUp) break;
    }
    return finalMessage === null || outcome === null
      ? { ok: false, error: { code: "invalid_persisted_state" } }
      : {
          ok: true,
          value: { outcome, finalMessage, flowBinding: binding.value },
        };
  }

  protected clearCanonicalTurn(): void {
    this.canonicalTurn = null;
  }
}
