import { armAlarmBy } from "../../services/platform/src/actors/lifecycle/actor-alarm.ts";
import { CandidateActor as SeamActor, readRecords } from "./seam-worker.mjs";
import {
  CURRENT_SQLITE_SCHEMA_VERSION,
  SqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite";
import { ActorSqliteDatabase } from "../../services/platform/src/actors/pi-durable-database.ts";
import { sha256Hex } from "../../packages/std/src/index.ts";
import { resolvePantryPlatformModelRoute } from "../../services/platform/src/models/route.ts";
export { default } from "./seam-worker.mjs";
import {
  admitPantryExecutionBilling,
  markPantryExecutionDispatched,
  readPantryExecutionAdmissionBinding,
} from "../../services/platform/src/account-platform/execution-billing.ts";
import { createActorActivationSchema } from "../../services/platform/src/actors/actor-activation.ts";
import { seedTrialWorkflowAccount } from "./draft-seed.mjs";
import { canonicalStopNotice } from "../../services/platform/src/actors/pi-durable-history.ts";
import { eraseActorContentSql } from "../../services/platform/src/actors/placement-execution-quiescence.ts";
import { createSessionSchema } from "../../services/platform/src/actors/agent-session-schema.ts";
import { CANONICAL_SESSION_SCHEMA_VERSION } from "../../services/platform/src/actors/actor-schema-versions.ts";
import {
  commitInitializedSession,
  commitAcceptedSessionInput,
  commitRuntimeActivatedSession,
  commitCompletedSessionTurn,
} from "../../services/platform/src/actors/actor-journal.ts";
import {
  commitCheckpointingStartedSession,
  commitPreparedSessionCheckpoint,
  recoverInterruptedSessionInTransaction,
} from "../../services/platform/src/actors/actor-journal/transactions.ts";
import { buildCanonicalTextTurnStart } from "../../services/platform/src/actors/agent-session-turn-start.ts";
import {
  buildTextTurnCheckpointingCommit,
  buildTextTurnCheckpointCommittedCommit,
} from "../../services/platform/src/actors/agent-session-text-turn.ts";
import { readImportedCanonicalSession } from "../../services/platform/src/actors/agent-session-canonical.ts";
import {
  acceptRunModelUsage,
  createSessionBudgetAccount,
  reserveRunBudget,
  readSessionBudgetAccount,
  settleRunBudget,
  sessionBudgetAccountDigest,
} from "../../services/platform/src/actors/agent-session-budget.ts";
import {
  acceptHarnessEvent,
  readLatestHarnessCheckpoint,
  preflightHarnessTurnLease,
  readHarnessCheckpointPublication,
  markHarnessCheckpointPublishedInTransaction,
} from "../../services/platform/src/actors/agent-session-harness-authority.ts";
import {
  prepareHarnessCheckpoint,
  loadCanonicalHarnessCheckpoint,
  uploadHarnessCheckpoint,
  validateCheckpointBudgetBinding,
} from "../../services/platform/src/actors/agent-session-harness-checkpoint.ts";
import { readAcceptedCheckpointFinalization } from "../../services/platform/src/actors/agent-session-finalization.ts";
import {
  prepareSessionInformationFlow,
  appendSessionInformationFlowInTransaction,
  readSessionTurnFlowBinding,
} from "../../services/platform/src/actors/agent-session-information-flow.ts";
import {
  beginSessionTurnStream,
  readSessionTurnReplay,
} from "../../services/platform/src/actors/agent-session-turn-stream.ts";
import {
  parseRequestId,
  parseOrganisationId,
} from "../../services/platform/src/ids.ts";
import { parseSessionTurnInputDigest } from "../../services/platform/src/actors/agent-session-turn-input-digest.ts";
import {
  captureActorExport,
  importActorExport,
  loadActorExport,
  newActorExportId,
  parseActorExportRef,
  readActivationExportSource,
} from "../../services/platform/src/actors/actor-export.ts";
import { parseActorFenceToken } from "../../services/platform/src/actors/actor-registry.ts";

const identity = {
  organisationId: "organisation_plan50_seams",
  sessionId: "session_plan50_seams",
  streamId: "stream_plan50_seams",
};
const budgetRevision = "budget_plan50_seams";
const turnId = "turn_plan50_seams";
const checkpointScenarios = new Set([
  "checkpoint_publication_gap",
  "checkpoint_write_rollback",
  "checkpoint_revoked_authority",
  "checkpoint_upload_gap",
  "portable_completion",
  "recovery_tools",
  "recovery_revoked",
  "recovery_budget_exhausted",
  "recovery_cancelled",
  "recovery_unknown_usage",
  "recovery_schema_upgrade",
  "recovery_tool_denied",
  "recovery_tool_cancelled",
  "recovery_read_restart",
  "recovery_read_expired",
  "recovery_read_revoked",
  "draft_response_loss",
  "draft_member_revoked",
  "draft_receipt_wait",
  "draft_placement_frozen",
  "draft_browser",
  "draft_browser_restricted",
  "recovery_portable_tools",
  "recovery_portable_revoked",
  "recovery_portable_unknown_usage",
  "proposal_response_loss",
  "proposal_grant_revoked",
  "provider_response_loss",
  "provider_receipt_wait",
  "provider_revoked_model",
  "provider_extension_missing",
  "provider_extension_incompatible",
  "provider_codemode_restart",
  "provider_codemode_settlement",
  "provider_codemode_organisation_settlement",
  "provider_codemode_queue",
  "provider_codemode_cancel",
  "provider_codemode_effect_cancel",
]);

// Platform's notice for a turn that ended without its answer.
const UNFINISHED_ANSWER_NOTICE =
  "Sous Chef could not finish this answer. Ask again to continue.";

function required(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export class CandidateActor extends SeamActor {
  tokenLimit = 1000;
  rejectedUsage = null;
  rejectedCheckpoint = false;
  finishing = false;

  authority() {
    return {
      requestAuthority: {
        kind: "workflow",
        organisationId: identity.organisationId,
        workflowId: "workflow_plan50_seams",
        workflowRevision: 1,
      },
      authorityPartitionDigest: "a".repeat(64),
    };
  }

  initialState() {
    return initializedState(required(resolvePantryPlatformModelRoute(this.env)));
  }

  turnRequest(now, startId, nextTurnId, generation) {
    return trialTurnRequest(
      now,
      startId,
      nextTurnId,
      generation,
      this.authority(),
    );
  }

  initializeAdmission() {
    createActorActivationSchema(this.ctx.storage.sql);
    createSessionSchema(this.ctx.storage.sql);
    this.ctx.storage.transactionSync(
      recoverInterruptedSessionInTransaction.bind(
        null,
        this.ctx.storage.sql,
        Date.now(),
      ),
    );
  }

  lifecycle() {
    const result = readImportedCanonicalSession(
      this.ctx.storage.sql,
      identity.organisationId,
    );
    if (!result.ok && result.error.code === "canonical_session_missing")
      return null;
    return required(result).lifecycle;
  }

  admission() {
    const lifecycle = this.lifecycle();
    if (lifecycle === null) return null;
    return {
      generation:
        lifecycle.kind === "processing"
          ? lifecycle.state.runtimeLease.generation
          : 0,
      status: lifecycle.kind === "processing" ? "admitted" : "blocked",
    };
  }

  writeLease(generation) {
    if (generation !== 1 || this.lifecycle() !== null)
      throw new Error("Canonical admission cannot renew an interrupted turn");
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    writeTrialActivation(sql, {
      organisationId: identity.organisationId,
      physicalName: `${identity.organisationId}:${identity.sessionId}`,
      placementEpoch: 1,
      fenceToken: "dof_trial",
      now,
    });
    const state = this.initialState();
    required(
      commitInitializedSession(this.ctx.storage, {
        source: "surface_actor",
        commandId: "initialize_trial",
        event: {
          envelopeVersion: "actor-envelope.v1",
          payloadVersion: "session-transition.v1",
          eventId: "initialize_trial",
          organisationId: identity.organisationId,
          actorId: identity.sessionId,
          streamId: identity.streamId,
          sequence: 0,
          sourceTime: { kind: "satyr", issuedAt: now },
          acceptedAt: now,
          correlationId: "trial",
          causation: { kind: "command", commandId: "initialize_trial" },
          idempotencyKey: "initialize_trial",
          runtimeRevision: "runtime_plan50_seams",
          principal: { kind: "system", componentId: "surface_actor" },
          sensitivity: "organisation_private",
          retention: "session",
          body: { kind: "session_initialized", state: state.state },
        },
        state,
        projection: {
          threadKey: "thread_trial",
          track: "managed-agents",
          startedAt: now,
        },
      }),
    );
    required(
      createSessionBudgetAccount(sql, {
        organisationId: identity.organisationId,
        sessionId: identity.sessionId,
        operationId: "initialize_budget",
        now,
        budget: {
          budgetRevision,
          maxTokens: this.tokenLimit,
          maxWallMs: 60000,
          maxToolCalls: 10,
        },
      }),
    );
    const start = required(
      buildCanonicalTextTurnStart({
        current: state,
        request: this.turnRequest(now, "start_trial", turnId, 1),
      }),
    );
    required(commitAcceptedSessionInput(this.ctx.storage, start.acceptedInput));
    required(
      commitRuntimeActivatedSession(this.ctx.storage, start.activatedRuntime),
    );
    required(
      reserveRunBudget(sql, {
        organisationId: identity.organisationId,
        sessionId: identity.sessionId,
        operationId: "reserve_trial",
        now,
        runId: "run_trial",
        reservationId: `reservation_${identity.sessionId}_run_trial_1_1_${budgetRevision}`,
        runtimeGeneration: 1,
        turnLeaseGeneration: 1,
        budgetRevision,
        turnId: "turn_plan50_seams",
      }),
    );
  }

  async modelResponse(context, options) {
    const budget = required(
      readSessionBudgetAccount(this.ctx.storage.sql, identity),
    );
    if (
      this.lifecycle()?.kind !== "processing" ||
      budget.kind !== "open" ||
      budget.reservation.kind !== "active" ||
      budget.reservation.reservation.deadlineAt <= Date.now()
    )
      throw new Error("Canonical dispatch blocked");
    return super.modelResponse(context, options);
  }

  nativeModelTokens() {
    if (
      this.ctx.storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_revisions'",
        )
        .toArray().length === 0
    )
      return 0;
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT r.kind, r.content FROM documents d JOIN document_revisions r ON r.document_id = d.id WHERE d.kind = ? AND d.retired_at IS NULL",
        JSON.stringify("pi.usage"),
      )
      .toArray();
    let tokens = 0;
    for (const row of rows) {
      if (row.kind !== "base")
        throw new Error("Pi usage requires a complete checkpoint");
      const usage = JSON.parse(row.content);
      for (const model of Object.values(usage.models)) {
        if (!Number.isSafeInteger(model.totalTokens) || model.totalTokens < 0)
          throw new Error("Invalid native model usage");
        tokens += model.totalTokens;
      }
    }
    return tokens;
  }

  acceptNativeModelUsage(tokens, sequence) {
    if (tokens === 0) return;
    if (tokens < 0) throw new Error("Native model usage decreased");
    const budget = required(
      readSessionBudgetAccount(this.ctx.storage.sql, identity),
    );
    if (budget.kind !== "open" || budget.reservation.kind !== "active")
      throw new Error("Model usage requires active reservation");
    const reservation = budget.reservation.reservation;
    required(
      acceptRunModelUsage(this.ctx.storage.sql, {
        organisationId: identity.organisationId,
        sessionId: identity.sessionId,
        operationId: `accept_model_usage_trial:${sequence}`,
        now: Date.now(),
        runId: reservation.runId,
        reservationId: reservation.reservationId,
        runtimeGeneration: reservation.runtimeGeneration,
        turnLeaseGeneration: reservation.turnLeaseGeneration,
        budgetRevision,
        usage: {
          tokens: budget.reservation.acceptedUsage.tokens + tokens,
          activeWallMs: budget.reservation.acceptedUsage.activeWallMs,
          capabilityCalls: budget.reservation.acceptedUsage.capabilityCalls,
        },
      }),
    );
  }

  async acceptOne(lease, fact) {
    const accepted = await super.acceptOne(lease, fact);
    if (!accepted.ok || fact.kind !== "assistant_message") return accepted;
    if (accepted.value.kind === "duplicate") return accepted;
    if (
      (await this.ctx.storage.get("evaluation_scenario")) ===
      "model_usage_rollback"
    ) {
      this.rejectedUsage = fact.usage.totalTokens;
      throw new Error("Injected failure after canonical usage write");
    }
    if (fact.stopReason !== "completed") return accepted;
    if (
      (await this.ctx.storage.get("evaluation_scenario")) ===
      "completion_commit"
    )
      this.acceptCompletion(lease);
    else if (
      checkpointScenarios.has(await this.ctx.storage.get("evaluation_scenario"))
    ) {
      await this.acceptTerminalOutput(lease, fact);
      this.settleCompletion(lease);
      await this.acceptSavedCheckpoint();
    }
    return accepted;
  }

  acceptCompletion(lease) {
    const current = this.lifecycle();
    this.settleCompletion(lease);
    const checkpointing = required(
      buildTextTurnCheckpointingCommit({
        current,
        harnessLease: lease,
        workspaceRevisionReceipt: completedWorkspaceReceipt(current),
        completion: {
          completionId: `complete_${lease.turn.turnId}`,
          acceptedAt: Date.now(),
        },
      }),
    );
    required(
      commitCheckpointingStartedSession(this.ctx.storage, checkpointing),
    );
  }

  settleCompletion(lease) {
    const budget = required(
      readSessionBudgetAccount(this.ctx.storage.sql, identity),
    );
    required(
      settleRunBudget(this.ctx.storage.sql, {
        organisationId: identity.organisationId,
        sessionId: identity.sessionId,
        operationId: `settle_completed_trial:${lease.runtimeLease.generation}`,
        now: Date.now(),
        runId: budget.reservation.reservation.runId,
        reservationId: budget.reservation.reservation.reservationId,
        runtimeGeneration: lease.runtimeLease.generation,
        turnLeaseGeneration: lease.turn.turnLeaseGeneration,
        budgetRevision,
        usage: budget.reservation.acceptedUsage,
        outcome: "succeeded",
      }),
    );
  }

  async acceptTerminalOutput(lease, fact) {
    const events = [
      { type: "agent_message", text: fact.content[0].text, finalMessage: true },
      { type: "done", outcome: null },
    ];
    await this.acceptProjectedEvents(lease, events);
  }

  async acceptProjectedEvents(lease, events) {
    const turnId = lease.turn.turnId;
    const row = this.ctx.storage.sql
      .exec("SELECT last_sequence FROM session_harness_lease")
      .one();
    const firstSequence = (row.last_sequence ?? 0) + 1;
    for (let index = 0; index < events.length; index += 1) {
      const acceptedAt = Date.now();
      const sequence = firstSequence + index;
      const payload = JSON.stringify({
        turnId,
        sequence,
        emittedAt: acceptedAt,
        event: events[index],
      });
      required(
        acceptHarnessEvent(this.ctx.storage, {
          leaseId: lease.leaseId,
          sessionId: identity.sessionId,
          turn: lease.turn,
          sequence,
          eventDigest: await sha256Hex(payload),
          payload,
          acceptedAt,
        }),
      );
    }
  }

  async submit() {
    await this.prepareSubmittedTurn();
    return super.submit();
  }

  async prepareSubmittedTurn() {
    const turnId = this.currentLease().turn.turnId;
    const scenario = await this.ctx.storage.get("evaluation_scenario");
    if (checkpointScenarios.has(scenario)) {
      await this.ctx.storage.put(
        "evaluation_original_lease",
        this.currentLease(),
      );
      const sql = this.ctx.storage.sql;
      const now = Date.now();
      required(
        beginSessionTurnStream(sql, {
          turnId,
          requestId: required(parseRequestId("request_trial")),
          organisationId: required(
            parseOrganisationId(identity.organisationId),
          ),
          inputDigest: required(parseSessionTurnInputDigest("c".repeat(64))),
          startedAt: now,
        }),
      );
      const flow = required(
        await prepareSessionInformationFlow({
          sql,
          organisationId: identity.organisationId,
          sessionId: identity.sessionId,
          turnId,
          authorityPartitionDigest: this.authority().authorityPartitionDigest,
          contextBundle: {
            organisationId: identity.organisationId,
            caseId: "case_plan50_seams",
            assignmentId: "assignment_plan50_seams",
            sessionId: identity.sessionId,
            policyVersion: this.lifecycle().state.contract.policyVersion,
            assemblyStrategyVersion: "assembly_trial",
            assembledAt: now,
            items: [],
            usage: { items: 0, estimatedTokens: 0 },
            disposition: { kind: "complete" },
          },
        }),
      );
      required(appendSessionInformationFlowInTransaction(sql, flow));
      // A completed turn records its account billing, which admission opens
      // before the model is called.
      const modelRoute = this.lifecycle().state.contract.modelRoute;
      const context = { env: this.env, storage: this.ctx.storage };
      const binding = required(
        await readPantryExecutionAdmissionBinding(context, this.currentLease()),
      );
      required(
        await admitPantryExecutionBilling(context, {
          lease: this.currentLease(),
          binding,
          modelRoute,
          modelRouteDigest: await sha256Hex(JSON.stringify(modelRoute)),
          continuation: "fresh",
        }),
      );
      required(markPantryExecutionDispatched(sql, turnId));
    }
  }

  async acceptSavedCheckpoint() {
    const current = this.lifecycle();
    if (current?.kind !== "processing") return;
    const lease = this.currentLease();
    const sql = this.ctx.storage.sql;
    const row = sql.exec("SELECT * FROM session_harness_lease").one();
    const budget = required(readSessionBudgetAccount(sql, identity));
    if (budget.kind !== "open" || budget.reservation.kind !== "none") return;
    const material = await nativeCompletionMaterial(sql);
    const bytes = new TextEncoder().encode(JSON.stringify(material));
    const prepared = required(
      await prepareHarnessCheckpoint({
        storage: this.ctx.storage,
        now: Date.now,
        checkpoint: {
          leaseId: lease.leaseId,
          backendId: "pi",
          session: identity,
          cursor: {
            kind: "accepted",
            turn: lease.turn,
            lastSequence: row.last_sequence,
            lastEventDigest: row.last_event_digest,
          },
          historyCursor: {
            lastSequence: row.history_sequence,
            lastEntryDigest: row.history_digest,
          },
          runtimeLease: lease.runtimeLease,
          runtimeRevision: lease.runtimeRevision,
          policyVersion: current.state.contract.policyVersion,
          budgetRevision,
          budgetUsage: budget.usage,
          usageCursor: budget.usageCursor,
          budgetAccountDigest: await sessionBudgetAccountDigest(budget),
          lastActorEventSequence: current.state.contract.lastEventSequence,
          workspaceBaseRevision: initialWorkspaceReceipt(current).revision,
          workspaceRevision: completedWorkspaceReceipt(current).revision,
          instructionDigest: "b".repeat(64),
          toolCatalogDigest: "e".repeat(64),
          modelRouteDigest: await sha256Hex(
            JSON.stringify(current.state.contract.modelRoute),
          ),
          formatVersion: "pi-durable-sqlite-completion.v1",
          harnessBuild: "pi-durable-1.0.0-trial",
          checkpoint: bytes.buffer,
          createdAt: Date.now(),
        },
      }),
    );
    const transition = required(
      buildTextTurnCheckpointingCommit({
        current,
        harnessLease: lease,
        workspaceRevisionReceipt: completedWorkspaceReceipt(current),
        completion: {
          completionId: `complete_${lease.turn.turnId}`,
          acceptedAt: Date.now(),
        },
      }),
    );
    required(
      commitPreparedSessionCheckpoint(this.ctx.storage, prepared, transition),
    );
    await armAlarmBy(this.ctx.storage, Date.now() + 1_000);
    if (
      (await this.ctx.storage.get("evaluation_scenario")) ===
      "checkpoint_write_rollback"
    ) {
      this.rejectedCheckpoint = true;
      throw new Error("Injected failure after pending checkpoint acceptance");
    }
  }

  async finalizeSavedCheckpoint() {
    const saved = required(
      readAcceptedCheckpointFinalization(this.ctx.storage.sql),
    );
    if (saved.kind !== "pending") return;
    const { current, checkpoint, publication } = saved.finalization;
    const turnId = checkpoint.cursor.turn.turnId;
    const authority = await this.provider("/authorize", {
      operation: "finalize_checkpoint",
      turnId,
      checkpointSha256: checkpoint.blob.sha256,
    });
    if (!authority.allowed) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const budget = required(
      readSessionBudgetAccount(this.ctx.storage.sql, identity),
    );
    required(
      await validateCheckpointBudgetBinding({ checkpoint, account: budget }),
    );
    const flow = required(
      await readSessionTurnFlowBinding(this.ctx.storage.sql, {
        organisationId: identity.organisationId,
        sessionId: identity.sessionId,
        turnId,
      }),
    );
    if (
      flow === null ||
      flow.authorityPartitionDigest !==
        this.authority().authorityPartitionDigest
    )
      throw new Error("Missing saved flow binding");
    const expectedMaterial = JSON.stringify(
      await nativeCompletionMaterial(this.ctx.storage.sql),
    );
    if (publication.kind === "upload_pending") {
      if (new TextDecoder().decode(publication.payload) !== expectedMaterial)
        throw new Error("Saved native completion binding changed");
      required(
        await uploadHarnessCheckpoint({
          storage: this.ctx.storage,
          bucket: this.env.ARCHIVE,
          root: { get: fixtureCheckpointRoot },
          publication,
        }),
      );
      if (
        (await this.ctx.storage.get("evaluation_scenario")) ===
          "checkpoint_upload_gap" &&
        !(await this.ctx.storage.get("evaluation_upload_fault_consumed"))
      ) {
        await this.ctx.storage.put("evaluation_upload_fault_consumed", true);
        await this.provider("/upload-held", {
          checkpointSha256: checkpoint.blob.sha256,
        });
      }
    }
    const completion = {
      completionId: `finalize_${turnId}_${checkpoint.cursor.lastSequence}`,
      acceptedAt: checkpoint.blob.createdAt,
    };
    const commit = required(
      await buildTextTurnCheckpointCommittedCommit({
        current,
        harnessCheckpoint: checkpoint,
        completion,
      }),
    );
    // A pure start builder supplies the restore validator; it admits no turn.
    const restore = required(
      buildCanonicalTextTurnStart({
        current: commit.state,
        request: this.turnRequest(
          Date.now(),
          "verify_restore",
          "verify_restore_turn",
          checkpoint.runtimeLease.generation + 1,
        ),
      }),
    );
    const material = required(
      await loadCanonicalHarnessCheckpoint({
        bucket: this.env.ARCHIVE,
        root: { get: fixtureCheckpointRoot },
        state: restore.activatedRuntime.state,
        checkpoint,
        manifest: {
          backendId: "pi",
          harnessBuild: "pi-durable-1.0.0-trial",
          checkpointFormat: "pi-durable-sqlite-completion.v1",
          model: current.state.contract.modelRoute.model,
        },
        sql: this.ctx.storage.sql,
      }),
    );
    if (new TextDecoder().decode(material) !== expectedMaterial)
      throw new Error("Encrypted completion material differs from Pi binding");
    const stillAuthorized = await this.provider("/authorize", {
      operation: "commit_finalization",
      turnId,
      checkpointSha256: checkpoint.blob.sha256,
    });
    if (!stillAuthorized.allowed) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.beforeCheckpointFinalization();
    const latest = required(
      readAcceptedCheckpointFinalization(this.ctx.storage.sql),
    );
    if (
      latest.kind !== "pending" ||
      JSON.stringify(latest.finalization.current) !== JSON.stringify(current) ||
      JSON.stringify(latest.finalization.checkpoint) !==
        JSON.stringify(checkpoint)
    )
      throw new Error("Saved checkpoint changed during finalization");
    if (publication.kind === "upload_pending")
      required(
        this.ctx.storage.transactionSync(
          markHarnessCheckpointPublishedInTransaction.bind(
            null,
            this.ctx.storage.sql,
            publication,
          ),
        ),
      );
    required(
      commitCompletedSessionTurn(this.ctx.storage, {
        checkpoint: commit,
        lastSequence: checkpoint.cursor.lastSequence - 1,
        completedAt: completion.acceptedAt,
      }),
    );
    await this.ctx.storage.deleteAlarm();
  }

  async beforeCheckpointFinalization() {}

  async commitBatch(sqlite, database, writes, context) {
    try {
      const seq = await super.commitBatch(sqlite, database, writes, context);
      if (
        (await this.ctx.storage.get("evaluation_scenario")) ===
          "completion_commit" &&
        this.lifecycle()?.kind === "checkpointing"
      )
        await this.provider("/commit-held", { seq });
      const scenario = await this.ctx.storage.get("evaluation_scenario");
      if (
        checkpointScenarios.has(scenario) &&
        scenario !== "checkpoint_upload_gap" &&
        scenario !== "portable_completion" &&
        !scenario.startsWith("recovery_") &&
        !scenario.startsWith("draft_") &&
        !scenario.startsWith("proposal_") &&
        !scenario.startsWith("provider_") &&
        this.lifecycle()?.kind === "checkpointing"
      )
        await this.provider("/commit-held", { seq });
      return seq;
    } catch (error) {
      if (this.rejectedUsage !== null)
        await this.provider("/rollback-held", { tokens: this.rejectedUsage });
      if (this.rejectedCheckpoint)
        await this.provider("/checkpoint-rollback-held", {});
      throw error;
    }
  }

  async drive() {
    if (this.finishing) return;
    this.finishing = true;
    try {
      if (
        this.lifecycle()?.kind === "checkpointing" &&
        readTrialCheckpoint(this.ctx.storage.sql) !== null
      )
        return await this.finalizeSavedCheckpoint();
      if (this.lifecycle()?.kind !== "processing") {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      await super.drive();
      await this.completeInterruptedTurn();
      if (
        this.lifecycle()?.kind === "checkpointing" &&
        checkpointScenarios.has(
          await this.ctx.storage.get("evaluation_scenario"),
        )
      ) {
        await armAlarmBy(this.ctx.storage, Date.now() + 1_000);
        await this.finalizeSavedCheckpoint();
      }
    } finally {
      this.finishing = false;
    }
  }

  // Pi ends a run without an answer when its model request was lost with
  // its process. Like Platform, the turn then completes with a notice.
  async completeInterruptedTurn() {
    if (
      this.lifecycle()?.kind !== "processing" ||
      !checkpointScenarios.has(
        await this.ctx.storage.get("evaluation_scenario"),
      )
    )
      return;
    const submission = this.ctx.storage.sql
      .exec("SELECT record FROM submissions ORDER BY id DESC LIMIT 1")
      .toArray()[0];
    const record =
      submission === undefined ? null : JSON.parse(submission.record);
    if (record?.status !== "unanswered" || record.reason !== "interrupted")
      return;
    const lease = this.currentLease();
    required(
      await this.acceptOne(
        lease,
        canonicalStopNotice(
          UNFINISHED_ANSWER_NOTICE,
          this.lifecycle().state.contract.modelRoute.model,
          lease.turn,
          Date.now(),
        ),
      ),
    );
  }

  async snapshot() {
    const lifecycle = this.lifecycle();
    const sql = this.ctx.storage.sql;
    const seam = await super.snapshot();
    const scenario = await this.ctx.storage.get("evaluation_scenario");
    return {
      ...seam,
      activation: readTrialActivation(sql),
      lifecycle,
      budget:
        lifecycle === null
          ? null
          : required(readSessionBudgetAccount(sql, identity)),
      checkpoint: readTrialCheckpoint(sql),
      checkpointPublication: await trialCheckpointPublication(sql),
      checkpointObjects: (await this.env.ARCHIVE.list()).objects.map(
        checkpointObject,
      ),
      replay: readTrialReplay(sql),
      nativeTables: readNativeTables(sql),
      oldLease: checkpointScenarios.has(scenario)
        ? preflightHarnessTurnLease(
            this.ctx.storage,
            await this.ctx.storage.get("evaluation_original_lease"),
            Date.now(),
          )
        : null,
    };
  }

  async capturePortableState() {
    const lifecycle = this.lifecycle();
    let referencedR2Keys;
    switch (lifecycle?.kind) {
      case "sleeping":
        referencedR2Keys = [
          readTrialCheckpoint(this.ctx.storage.sql).blob.objectKey,
        ];
        break;
      case "recovering":
        if (
          this.ctx.storage.sql
            .exec("SELECT lease_id FROM session_harness_lease")
            .toArray().length !== 0
        )
          throw new Error("Unfinished export requires fenced execution");
        referencedR2Keys = [];
        break;
      default:
        throw new Error("Export requires completed or fenced recovering work");
    }
    await this.ctx.storage.deleteAlarm();
    const activation = required(
      readActivationExportSource(this.ctx.storage.sql),
    );
    return required(
      await captureActorExport({
        storage: this.ctx.storage,
        bucket: this.env.ARCHIVE,
        root: { get: fixtureCheckpointRoot },
        expectedFenceToken: activation.fenceToken,
        exportId: newActorExportId(),
        referencedR2Keys,
        now: Date.now(),
      }),
    );
  }

  async prepareImportTarget(organisationId, physicalName) {
    if (this.lifecycle() !== null)
      throw new Error("Import target already has canonical work");
    writeTrialActivation(this.ctx.storage.sql, {
      organisationId,
      physicalName,
      placementEpoch: 2,
      fenceToken: "dof_replacement",
      now: Date.now(),
    });
    const sqlite = await SqliteStorage.open(
      new ActorSqliteDatabase(this.ctx.storage),
    );
    await sqlite.close();
    const sql = this.ctx.storage.sql;
    const metadata = sql.exec("SELECT * FROM durable_metadata").one();
    const schema = sql.exec("SELECT * FROM durable_schema").one();
    if (
      metadata.next_id !== "2" ||
      metadata.next_seq !== 1 ||
      schema.version !== CURRENT_SQLITE_SCHEMA_VERSION
    )
      throw new Error("Import requires pristine pinned Pi storage");
    // The generic import owns these rows. Keep the schema made by Pi's public initializer.
    sql.exec("DELETE FROM durable_metadata");
    sql.exec("DELETE FROM durable_schema");
  }

  async restorePortableState(body) {
    const ref = parseActorExportRef(body.exportRef);
    if (!ref.ok) return ref;
    const fence = parseActorFenceToken(body.expectedFenceToken);
    if (!fence.ok) return fence;
    const envelope = await loadActorExport({
      bucket: this.env.ARCHIVE,
      root: { get: fixtureCheckpointRoot },
      ref: ref.value,
    });
    if (!envelope.ok) return envelope;
    return importActorExport({
      storage: this.ctx.storage,
      bucket: this.env.ARCHIVE,
      envelope: envelope.value,
      expectedTargetFenceToken: fence.value,
      now: Date.now(),
    });
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/start" && this.env.TRIAL_WORKFLOW_ACCOUNT === "seed")
      await seedTrialWorkflowAccount(this.env);
    if (path === "/export")
      return Response.json(await this.capturePortableState());
    if (path === "/prepare-import") {
      const body = await request.json();
      const organisationId = required(parseOrganisationId(body.organisationId));
      const physicalName = new URL(request.url).searchParams.get("scenario");
      await this.prepareImportTarget(organisationId, physicalName);
      return Response.json({ prepared: true });
    }
    if (path === "/import")
      return Response.json(
        await this.restorePortableState(await request.json()),
      );
    if (path === "/reopen") {
      const { root } = await this.getRuntime();
      return Response.json({
        rootId: root.id,
        snapshot: await this.snapshot(),
      });
    }
    if (path === "/discard-source") {
      const checkpoint = readTrialCheckpoint(this.ctx.storage.sql);
      if (checkpoint !== null)
        await this.env.ARCHIVE.delete(checkpoint.blob.objectKey);
      await this.ctx.storage.deleteAlarm();
      this.ctx.storage.transactionSync(
        eraseActorContentSql.bind(null, this.ctx.storage.sql),
      );
      const keys = [...(await this.ctx.storage.list()).keys()];
      if (keys.length > 0) await this.ctx.storage.delete(keys);
      return Response.json({ discarded: true });
    }
    if (path === "/wake") {
      await armAlarmBy(this.ctx.storage, Date.now() + 1_000);
      return Response.json({ scheduled: true });
    }
    if (path === "/start" && this.admission()?.status === "blocked")
      return Response.json({
        accepted: false,
        error: "canonical_recovery_required",
      });
    if (path === "/cancel" || path === "/stale")
      return new Response("Outside canonical interruption trial", {
        status: 404,
      });
    return super.fetch(request);
  }
}

function writeTrialActivation(sql, input) {
  sql.exec(
    `INSERT INTO state_object_activation (
      singleton, registry_id, activation_token, organisation_id, object_kind,
      logical_object_id, physical_object_name, placement_kind, placement_epoch,
      placement_cell_id, location_hint, residency_jurisdiction, schema_version,
      state_version, fence_token, activated_at
    ) VALUES (1, 'dor_trial', 'doa_trial', ?, 'session', ?, ?, 'affinity', ?, 'cell-trial', 'wnam', NULL, ?, 1, ?, ?)`,
    input.organisationId,
    identity.sessionId,
    input.physicalName,
    input.placementEpoch,
    CANONICAL_SESSION_SCHEMA_VERSION,
    input.fenceToken,
    input.now,
  );
}

function readNativeTables(sql) {
  const names = new Set(
    sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map(tableName),
  );
  const tables = [];
  for (const name of [
    "durable_schema",
    "durable_metadata",
    "record_ids",
    "conversations",
    "entries",
    "tasks",
    "submissions",
    "documents",
    "document_revisions",
  ]) {
    const order = name === "document_revisions" ? "document_id, seq" : "rowid";
    if (names.has(name))
      tables.push({
        name,
        rows: sql.exec(`SELECT * FROM ${name} ORDER BY ${order}`).toArray(),
      });
  }
  return tables;
}

function tableName(row) {
  return row.name;
}

function readTrialActivation(sql) {
  const activation = readActivationExportSource(sql);
  if (!activation.ok && activation.error.code === "actor_not_activated")
    return null;
  return required(activation);
}

function nativeCompletion(sql) {
  const names = new Set(
    sql.exec("SELECT name FROM sqlite_master").toArray().map(tableName),
  );
  return {
    entries: readRecords(sql, names, "entries"),
    tasks: readRecords(sql, names, "tasks"),
    submissions: readRecords(sql, names, "submissions"),
  };
}

async function nativeCompletionMaterial(sql) {
  const native = nativeCompletion(sql);
  return {
    kind: "pi-durable-sqlite-completion.v1",
    packageVersion: "1.0.0",
    nextSeq: sql.exec("SELECT next_seq FROM durable_metadata").one().next_seq,
    submissionId: native.submissions[0].id,
    nativeStateDigest: await sha256Hex(JSON.stringify(native)),
  };
}

async function trialCheckpointPublication(sql) {
  const checkpoint = readTrialCheckpoint(sql);
  if (checkpoint === null) return null;
  const publication = required(
    readHarnessCheckpointPublication(sql, checkpoint),
  );
  if (publication.kind === "published") return { kind: "published" };
  return {
    kind: "upload_pending",
    byteLength: publication.payload.byteLength,
    sha256: await sha256Hex(publication.payload),
  };
}

async function fixtureCheckpointRoot() {
  return "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
}

function checkpointObject(object) {
  return { key: object.key, size: object.size };
}

function readTrialReplay(sql) {
  const turnId =
    readTrialCheckpoint(sql)?.cursor.turn.turnId ?? "turn_plan50_seams";
  const result = readSessionTurnReplay(sql, {
    organisationId: required(parseOrganisationId(identity.organisationId)),
    turnId,
    afterSequence: -1,
  });
  if (!result.ok && result.error.code === "session_turn_not_found") return null;
  return required(result);
}

function readTrialCheckpoint(sql) {
  const result = readLatestHarnessCheckpoint(sql, identity.sessionId);
  if (!result.ok && result.error.code === "harness_checkpoint_missing")
    return null;
  return required(result);
}

function trialTurnRequest(now, startId, nextTurnId, generation, authority) {
  return {
    startId,
    correlationId: "trial",
    acceptedAt: now,
    admittedAt: now,
    harnessLeaseExpiresAt: now + 60000,
    input: {
      kind: "case",
      inputId: generation === 1 ? "input_plan50_seams" : "input_restore_trial",
      caseId: "case_plan50_seams",
      assignmentId: "assignment_plan50_seams",
      caseRevision: 1,
      contentDigest: "c".repeat(64),
      workspaceRevision: "workspace_plan50_seams",
      contextBundleDigest: "d".repeat(64),
    },
    requestAuthority: authority.requestAuthority,
    authorityPartitionDigest: authority.authorityPartitionDigest,
    turnId: nextTurnId,
    runtimeLease: { generation, leaseId: `runtime_plan50_${generation}` },
    turnLeaseGeneration: generation,
    origin: {
      kind: "command",
      principal: { kind: "system", componentId: "surface_actor" },
    },
  };
}

function initializedState(modelRoute) {
  return {
    kind: "sleeping",
    state: {
      identity,
      contract: {
        policyVersion: "policy_trial",
        budgetRevision,
        runtimeRevision: "runtime_plan50_seams",
        modelRoute,
        lastEventSequence: 0,
      },
      resumePoint: {
        kind: "new",
        workspaceRevisionReceipt: {
          receiptId: "workspace_trial",
          outcome: "accepted",
          workspaceId: "workspace_trial",
          revision: "workspace_plan50_seams",
          canonicalHead: "f".repeat(64),
          correlationId: "trial",
          causation: { kind: "command", commandId: "initialize_trial" },
        },
      },
    },
  };
}

function completedWorkspaceReceipt(current) {
  if (current.state.activeTurn?.kind === "reducing_result")
    return current.state.activeTurn.state.workspaceRevisionReceipt;
  return initialWorkspaceReceipt(current);
}

function initialWorkspaceReceipt(current) {
  const resumePoint = current.state.resumePoint;
  if (resumePoint.kind === "new") return resumePoint.workspaceRevisionReceipt;
  return resumePoint.checkpoint.workspaceRevisionReceipt;
}
