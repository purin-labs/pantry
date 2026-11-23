import { CandidateActor as CanonicalActor } from "./canonical-worker.mjs";
import {
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { createActorActivationSchema } from "../../foundation/actor-runtime/actors/actor-activation.ts";
import { createSessionSchema } from "../../foundation/agent/actors/agent-session-schema.ts";
import {
  buildSessionExecutionRecovery,
  buildSessionRecoveryAction,
  buildSessionExecutionResume,
  buildRecoveringSessionCancellation,
} from "../../foundation/agent/actors/agent-session-recovery.ts";
import {
  commitExecutionRecoveryStartedSession,
  commitExecutionRecoveryUpdatedSession,
  commitExecutionResumedSession,
} from "../../foundation/agent/actors/actor-journal.ts";
import { commitCancellationStartedSession } from "../../foundation/agent/actors/actor-journal/transactions.ts";
import {
  readSessionBudgetAccount,
  markRunBudgetIndeterminate,
  reserveRunBudget,
  settleRunBudget,
  reconcileRunBudget,
  claimRunCapability,
} from "../../foundation/agent/actors/agent-session-budget.ts";
import { preflightHarnessTurnLease } from "../../foundation/agent/actors/agent-session-harness-authority.ts";
import { validateCanonicalSessionAdvance } from "../../foundation/agent/actor-wasm.ts";
import { catalogHarnessToolCatalogDigest } from "../../foundation/agent-tools/catalog/selection.ts";
import { createCatalogHarnessCodeMode } from "../../foundation/agent-tools/catalog/code-mode.ts";
import { TOOL_REGISTRY } from "../../workers/platform/src/agent-tools/registry.ts";
import { CAPABILITY_KEYS } from "../../foundation/authority/authorization/capability-catalogue.ts";
import { renderHarnessHistoryContent } from "../../foundation/agent/actors/harness-history.ts";
import { buildTextTurnCancellationStartedCommit } from "../../foundation/agent/actors/agent-session-text-turn.ts";
export { default } from "./canonical-worker.mjs";

function required(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function parseNativeTask(row) {
  const task = JSON.parse(row.record);
  if (
    task.kind !== "pi.generation" ||
    !Number.isSafeInteger(task.id) ||
    !task.state.checkpoint
  )
    throw new Error("Missing native generation continuation");
  return task;
}

function runIdentity(reservation, session) {
  return {
    organisationId: session.organisationId,
    sessionId: session.sessionId,
    runId: reservation.runId,
    reservationId: reservation.reservationId,
    runtimeGeneration: reservation.runtimeGeneration,
    turnLeaseGeneration: reservation.turnLeaseGeneration,
    budgetRevision: reservation.budgetRevision,
  };
}

export class CandidateActor extends CanonicalActor {
  recoveringExecution = false;
  initializeAdmission() {
    createActorActivationSchema(this.ctx.storage.sql);
    this.ctx.storage.transactionSync(
      createSessionSchema.bind(null, this.ctx.storage.sql),
    );
    this.ctx.storage.transactionSync(this.recoverNativeExecution.bind(this));
    const current = this.lifecycle();
    if (
      current?.kind === "recovering" &&
      current.state.action.kind === "resume_task"
    )
      this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 1_000));
  }

  recoverNativeExecution() {
    const current = this.lifecycle();
    if (current?.kind !== "processing") return;
    const sql = this.ctx.storage.sql;
    const taskRows = sql
      .exec(
        "SELECT record FROM tasks WHERE json_extract(record, '$.kind') = 'pi.generation' AND json_extract(record, '$.state.status') <> 'terminal'",
      )
      .toArray();
    if (taskRows.length !== 1)
      throw new Error("Recovery requires one saved generation task");
    const task = parseNativeTask(taskRows[0]);
    const submission = JSON.parse(
      sql
        .exec(
          "SELECT record FROM submissions WHERE conversation_id = ? AND request_id = ?",
          task.conversationId,
          JSON.stringify(current.state.activeTurn.state.identity.inputId),
        )
        .one().record,
    );
    const history = sql
      .exec(
        "SELECT sequence, entry_digest FROM session_harness_history ORDER BY sequence DESC LIMIT 1",
      )
      .one();
    const budget = required(
      readSessionBudgetAccount(sql, current.state.identity),
    );
    if (budget.kind !== "open" || budget.reservation.kind !== "active")
      throw new Error("Interrupted generation requires its reservation");
    const reservation = budget.reservation.reservation;
    const now = Date.now();
    let action;
    switch (task.state.checkpoint.phase) {
      case "tools":
        this.validateRecoverableTools(sql, task);
        required(
          settleRunBudget(sql, {
            ...runIdentity(reservation, current.state.identity),
            operationId: `settle_interrupted_${task.id}_${reservation.runId}`,
            now,
            usage: budget.reservation.acceptedUsage,
            outcome: "succeeded",
          }),
        );
        action = { kind: "resume_task" };
        break;
      case "request":
        required(
          markRunBudgetIndeterminate(sql, {
            ...runIdentity(reservation, current.state.identity),
            operationId: `unknown_model_${task.id}`,
            now,
            reason: "model_receipt_missing",
          }),
        );
        action = {
          kind: "await_evidence",
          evidence: {
            kind: "model_usage",
            modelRequestId: `model_request_${task.id}`,
            runId: reservation.runId,
            reservationId: reservation.reservationId,
          },
        };
        break;
      default:
        throw new Error(
          `Unsupported native trial phase: ${task.state.checkpoint.phase}`,
        );
    }
    const commit = required(
      buildSessionExecutionRecovery({
        current,
        fencedHarnessLease: this.currentLease(),
        continuation: {
          kind: "pi",
          harnessTaskId: String(task.id),
          submissionId: String(submission.id),
          harnessBuild: "pi-durable@1.0.0",
          historyCursor: {
            lastSequence: history.sequence,
            lastEntryDigest: history.entry_digest,
          },
        },
        action,
        event: {
          operationId: `recover_${task.id}_${reservation.runtimeGeneration}`,
          acceptedAt: now,
        },
      }),
    );
    required(commitExecutionRecoveryStartedSession(this.ctx.storage, commit));
  }

  async registry() {
    const lease = this.currentLease();
    const host = await this.toolHost(lease);
    const registry = createRegistry();
    this.trustedExtension = defineExtension({
      name: this.extensionName(),
      tools: this.toolDefinitions(host).map(
        createCatalogTool.bind(null, this, lease, host),
      ),
    });
    registry.install(this.trustedExtension);
    return registry;
  }

  extensionName() {
    return "pantry-recovery-trial";
  }

  async toolHost(lease) {
    const catalogSelection = {
      allowedCapabilities: this.catalogCapabilities(),
    };
    return required(
      await createCatalogHarnessCodeMode({
        registry: TOOL_REGISTRY,
        expectedCatalogDigest: await catalogHarnessToolCatalogDigest(
          TOOL_REGISTRY,
          catalogSelection,
        ),
        catalogSelection,
        admission: {
          begin: unavailableTool,
          claim: unavailableTool,
          complete: unavailableTool,
          settle: unavailableTool,
        },
        services: {
          integrations: { listIntegrations: unavailableTool },
          commerce: {
            readEntityContext: unavailableTool,
            readMerchantReport: unavailableTool,
            readProductDescriptionDraft: this.readProductDraft.bind(
              this,
              lease,
            ),
            editProductDescriptionDraft: this.editProductDraft.bind(
              this,
              lease,
            ),
          },
          kitchen: {
            readWorkflowCanvas: rejectWorkflowCanvasTool,
            moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
          },
          menu: { readMenuDraft: unavailableTool },
          channels: {
            readEmailDraft: unavailableTool,
            editEmailDraft: unavailableTool,
          },
          files: { queryWorkspace: unavailableTool },
        },
        claimCapability: this.claimToolCapability.bind(this, lease),
      }),
    );
  }

  catalogCapabilities() {
    return [CAPABILITY_KEYS.commerceEntityPlaneContext];
  }

  toolDefinitions(host) {
    const definition = host.definitions.find(isProductDraftRead);
    if (definition === undefined)
      throw new Error("Published catalog has no product draft read");
    return [definition];
  }

  toolReplay(name) {
    if (name === "product_description_draft_read") return "safe";
    throw new Error("This trial has no replay contract for the selected tool");
  }

  validateRecoverableTools(sql, generation) {
    validateRecoverableRead(sql, generation);
  }

  async claimToolCapability(lease, claim) {
    required(preflightHarnessTurnLease(this.ctx.storage, lease, Date.now()));
    const authorized = await this.provider("/authorize", {
      operation:
        claim.capability === CAPABILITY_KEYS.commerceProductDescriptionDraftEdit
          ? "product_description_draft_edit"
          : "product_description_draft_read",
      callId: claim.callId,
      capability: claim.capability,
      boundary: claim.boundary,
      generation: lease.runtimeLease.generation,
    });
    if (!authorized.allowed)
      throw new Error("Current trial authority denied read");
    required(preflightHarnessTurnLease(this.ctx.storage, lease, Date.now()));
    const budget = required(
      readSessionBudgetAccount(this.ctx.storage.sql, lease.session),
    );
    required(
      claimRunCapability(this.ctx.storage.sql, {
        ...runIdentity(budget.reservation.reservation, lease.session),
        operationId: `direct_tool_${budget.reservation.reservation.runId}_${claim.callId}`,
        claimId: `direct_tool_${budget.reservation.reservation.runId}_${claim.callId}`,
        now: Date.now(),
      }),
    );
    return { ok: true, value: null };
  }

  async readProductDraft(lease, request) {
    required(preflightHarnessTurnLease(this.ctx.storage, lease, Date.now()));
    const result = await this.provider("/read", request);
    required(preflightHarnessTurnLease(this.ctx.storage, lease, Date.now()));
    return {
      product: {
        productId: request.productId,
        title: result.product,
        description: "Almond financier",
        revision: result.revision,
      },
      draft: { kind: "not_started" },
    };
  }

  async editProductDraft() {
    return unavailableTool();
  }

  async commitBatch(sqlite, database, writes, context) {
    const seq = await super.commitBatch(sqlite, database, writes, context);
    if (this.holdToolIntent(writes))
      await this.provider("/commit-held", { seq });
    return seq;
  }

  holdToolIntent(writes) {
    return writes.some(isToolIntent);
  }

  async drive() {
    const current = this.lifecycle();
    if (current?.kind !== "recovering") return super.drive();
    if (this.recoveringExecution) return;
    this.recoveringExecution = true;
    try {
      await this.admitRecovery();
    } finally {
      this.recoveringExecution = false;
    }
    if (this.lifecycle()?.kind === "processing") await super.drive();
  }

  async admitRecovery() {
    const current = this.lifecycle();
    if (current.state.action.kind !== "resume_task") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const authority = await this.provider("/authorize", {
      operation: "resume_execution",
      taskId: current.state.continuation.harnessTaskId,
    });
    if (
      this.lifecycle()?.state.contract.lastEventSequence !==
      current.state.contract.lastEventSequence
    )
      return;
    if (!authority.allowed) {
      this.updateAction({ kind: "blocked", reason: "authorization" });
      await this.ctx.storage.deleteAlarm();
      return;
    }
    try {
      this.ctx.storage.transactionSync(this.resumeNativeExecution.bind(this));
      const resumed = this.lifecycle();
      if (
        resumed.kind === "recovering" &&
        resumed.state.action.kind === "blocked"
      )
        await this.ctx.storage.deleteAlarm();
    } catch (error) {
      await this.provider("/recovery-error", { error: String(error) });
      throw error;
    }
  }

  updateAction(action) {
    const current = this.lifecycle();
    required(
      commitExecutionRecoveryUpdatedSession(
        this.ctx.storage,
        required(
          buildSessionRecoveryAction({
            current,
            action,
            event: {
              operationId: `action_${current.state.contract.lastEventSequence}`,
              acceptedAt: Date.now(),
            },
          }),
        ),
      ),
    );
  }

  resumeNativeExecution() {
    const current = this.lifecycle();
    const generation = current.state.fencedRuntime.generation + 1;
    const now = Date.now();
    const turn = current.state.activeTurn.state.identity;
    const budget = reserveRunBudget(this.ctx.storage.sql, {
      organisationId: current.state.identity.organisationId,
      sessionId: current.state.identity.sessionId,
      operationId: `reserve_recovery_${generation}`,
      now,
      runId: `run_trial_${generation}`,
      reservationId: `reservation_${current.state.identity.sessionId}_run_trial_${generation}_${generation}_${turn.turnLeaseGeneration}_${turn.budgetRevision}`,
      runtimeGeneration: generation,
      turnLeaseGeneration: turn.turnLeaseGeneration,
      budgetRevision: turn.budgetRevision,
      turnId: turn.turnId,
    });
    if (!budget.ok) {
      if (budget.error.code === "budget_exhausted") {
        this.updateAction({ kind: "blocked", reason: "budget" });
        return;
      }
      throw new Error(JSON.stringify(budget.error));
    }
    const commit = required(
      buildSessionExecutionResume({
        current,
        runtimeLease: { generation, leaseId: `runtime_recovery_${generation}` },
        requestAuthority: this.authority().requestAuthority,
        authorityPartitionDigest: this.authority().authorityPartitionDigest,
        harnessLeaseId: `lease_recovery_${generation}`,
        expiresAt:
          now +
          (this.env.TRIAL_SCENARIO === "recovery_read_expired" &&
          generation === 2
            ? 1500
            : 60_000),
        event: { operationId: `resume_${generation}`, acceptedAt: now },
      }),
    );
    required(commitExecutionResumedSession(this.ctx.storage, commit));
  }

  async fetch(request) {
    // The first model call's estimated usage, so that call uses the whole
    // budget. It follows the prompt: a new tool description changes it.
    if (this.env.TRIAL_SCENARIO === "recovery_budget_exhausted")
      this.tokenLimit = 180;
    if (new URL(request.url).pathname === "/recover-expired") {
      const expiry = preflightHarnessTurnLease(
        this.ctx.storage,
        this.currentLease(),
        Date.now(),
      );
      if (expiry.ok || expiry.error.code !== "harness_lease_expired")
        throw new Error("Expected an expired executor lease");
      this.ctx.storage.transactionSync(this.recoverNativeExecution.bind(this));
      await this.ctx.storage.deleteAlarm();
      return Response.json({ expiry, state: this.lifecycle() });
    }
    const path = new URL(request.url).pathname;
    if (path === "/reconcile-model-usage") {
      const current = this.lifecycle();
      if (
        current.kind !== "recovering" ||
        current.state.action.kind !== "await_evidence" ||
        current.state.action.evidence.kind !== "model_usage"
      )
        return Response.json({ reconciled: false, reason: "not_waiting" });
      const expected = current.state.action.evidence;
      const receipt = await this.provider("/model-usage-evidence", expected);
      if (receipt.kind === "pending")
        return Response.json({ reconciled: false, reason: "pending" });
      if (
        receipt.kind !== "known" ||
        receipt.modelRequestId !== expected.modelRequestId ||
        receipt.runId !== expected.runId ||
        receipt.reservationId !== expected.reservationId ||
        !Number.isSafeInteger(receipt.tokens) ||
        receipt.tokens < 0
      )
        return Response.json({
          reconciled: false,
          reason: "evidence_mismatch",
        });
      this.ctx.storage.transactionSync(
        this.acceptRecoveredModelUsage.bind(this, current, receipt),
      );
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
      return Response.json({ reconciled: true });
    }
    if (path === "/stage-schema32") {
      this.ctx.storage.transactionSync(this.stageSchema32.bind(this));
      return Response.json({ staged: true });
    }
    if (path === "/cancel-recovery") {
      const current = this.lifecycle();
      required(
        commitCancellationStartedSession(
          this.ctx.storage,
          required(
            buildRecoveringSessionCancellation({
              current,
              event: { operationId: "cancel_recovery", acceptedAt: Date.now() },
            }),
          ),
        ),
      );
      return Response.json({ cancelled: true, state: this.lifecycle() });
    }
    if (path === "/cancel-running") {
      const current = this.lifecycle();
      const budget = required(
        readSessionBudgetAccount(this.ctx.storage.sql, current.state.identity),
      );
      this.ctx.storage.transactionSync(
        this.cancelRunningRead.bind(this, current, budget),
      );
      return Response.json({ cancelled: true, state: this.lifecycle() });
    }
    if (path === "/stale") {
      const lease = await this.ctx.storage.get("evaluation_original_lease");
      return Response.json(
        preflightHarnessTurnLease(this.ctx.storage, lease, Date.now()),
      );
    }
    if (path === "/try-resume") {
      const current = this.lifecycle();
      const runtimeLease = {
        generation: current.state.fencedRuntime.generation + 1,
        leaseId: "attempted_resume",
      };
      const state = {
        kind: "processing",
        state: {
          identity: current.state.identity,
          contract: {
            ...current.state.contract,
            lastEventSequence: current.state.contract.lastEventSequence + 1,
          },
          resumePoint: current.state.resumePoint,
          runtimeLease,
          activeTurn: current.state.activeTurn,
        },
      };
      return Response.json(
        validateCanonicalSessionAdvance({
          current,
          command: { kind: "resume_execution", runtimeLease },
          transition: { kind: "execution_resumed", state: state.state },
          state,
        }),
      );
    }
    return super.fetch(request);
  }

  acceptRecoveredModelUsage(expected, receipt) {
    const current = this.lifecycle();
    if (
      current.kind !== "recovering" ||
      current.state.contract.lastEventSequence !==
        expected.state.contract.lastEventSequence
    )
      throw new Error("Recovery changed before usage reconciliation");
    const budget = required(
      readSessionBudgetAccount(this.ctx.storage.sql, current.state.identity),
    );
    if (budget.kind !== "open" || budget.reservation.kind !== "indeterminate")
      throw new Error("Missing indeterminate model reservation");
    required(
      reconcileRunBudget(this.ctx.storage.sql, {
        ...runIdentity(budget.reservation.reservation, current.state.identity),
        operationId: `reconcile_${receipt.modelRequestId}`,
        now: Date.now(),
        usage: {
          tokens: budget.reservation.acceptedUsage.tokens + receipt.tokens,
          activeWallMs: budget.reservation.acceptedUsage.activeWallMs,
          capabilityCalls: budget.reservation.acceptedUsage.capabilityCalls,
        },
        outcome: "failed",
      }),
    );
    this.updateAction({ kind: "resume_task" });
  }

  cancelRunningRead(current, budget) {
    const now = Date.now();
    required(
      commitCancellationStartedSession(
        this.ctx.storage,
        required(
          buildTextTurnCancellationStartedCommit({
            current,
            harnessLease: this.currentLease(),
            cancellation: {
              cancellationId: "cancel_running_read",
              correlationId: "trial",
              acceptedAt: now,
            },
          }),
        ),
      ),
    );
    required(
      settleRunBudget(this.ctx.storage.sql, {
        ...runIdentity(budget.reservation.reservation, current.state.identity),
        operationId: "settle_cancelled_read",
        now,
        usage: budget.reservation.acceptedUsage,
        outcome: "cancelled",
      }),
    );
  }

  stageSchema32() {
    const sql = this.ctx.storage.sql;
    const schema = sql
      .exec(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_meta'",
      )
      .one().sql;
    const oldSchema = schema
      .replace("session_meta", "session_meta_previous")
      .replace("'recovering', ", "");
    if (oldSchema.includes("'recovering'"))
      throw new Error("Expected schema32 lifecycle constraint");
    sql.exec(oldSchema);
    sql.exec("INSERT INTO session_meta_previous SELECT * FROM session_meta");
    sql.exec("DROP TABLE session_meta");
    sql.exec("ALTER TABLE session_meta_previous RENAME TO session_meta");
    sql.exec(
      "UPDATE do_schema_meta SET value = 32 WHERE key = 'session_hot_schema'",
    );
  }

  async snapshot() {
    const snapshot = await super.snapshot();
    return {
      ...snapshot,
      hotSchemaVersion: this.ctx.storage.sql
        .exec(
          "SELECT value FROM do_schema_meta WHERE key = 'session_hot_schema'",
        )
        .one().value,
      migrationTables: this.ctx.storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE name IN ('session_meta_previous', 'session_meta_recovery')",
        )
        .toArray(),
    };
  }
}

function isToolIntent(write) {
  return write.type === "entry" && write.value.model?.some(hasToolIntent);
}

function hasToolIntent(message) {
  return message.role === "assistant" && message.stopReason === "toolUse";
}

function isProductDraftRead(definition) {
  return definition.name === "product_description_draft_read";
}

async function unavailableTool() {
  throw new Error("Tool is outside this trial's selected catalog");
}

function validateRecoverableRead(sql, generation) {
  const rows = sql
    .exec(
      "SELECT record FROM tasks WHERE json_extract(record, '$.kind') = 'pi.tool' AND json_extract(record, '$.owner') = ?",
      generation.id,
    )
    .toArray();
  if (rows.length !== 1)
    throw new Error("This trial requires one saved product draft read");
  const tool = JSON.parse(rows[0].record);
  if (tool.owner !== generation.id)
    throw new Error("Saved read belongs to another generation");
  const assistant = JSON.parse(
    sql
      .exec("SELECT record FROM entries WHERE id = ?", tool.input.assistant)
      .one().record,
  );
  const call = assistant.model[0].content.find(
    matchesSavedCall.bind(null, tool.input.callId),
  );
  if (call?.name !== "product_description_draft_read")
    throw new Error("This trial cannot replay an external effect");
  switch (tool.state.checkpoint.phase) {
    case "call":
      if (tool.state.status !== "pending")
        throw new Error("Saved read admission is invalid");
      return;
    case "execute":
      if (
        tool.state.status !== "running" ||
        tool.state.checkpoint.replay !== "safe"
      )
        throw new Error("Saved read cannot repeat safely");
      return;
    default:
      throw new Error("Saved read has an unsupported phase");
  }
}

function matchesSavedCall(callId, content) {
  return content.type === "toolCall" && content.id === callId;
}

function createCatalogTool(actor, lease, host, definition) {
  return defineTool({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    replay: actor.toolReplay(definition.name),
    execute: executeCatalogTool.bind(null, actor, lease, host, definition.name),
  });
}

async function executeCatalogTool(
  actor,
  lease,
  host,
  name,
  input,
  api,
  context,
) {
  context.abortSignal.throwIfAborted();
  required(preflightHarnessTurnLease(actor.ctx.storage, lease, Date.now()));
  const result = await host.executeTool(
    name,
    JSON.stringify(input),
    api.callId,
  );
  context.abortSignal.throwIfAborted();
  const admission = preflightHarnessTurnLease(
    actor.ctx.storage,
    lease,
    Date.now(),
  );
  if (!admission.ok) {
    await actor.provider("/rejected-tool-result", {
      callId: api.callId,
      reason: admission.error.code,
    });
    throw new Error(admission.error.code);
  }
  if (
    result.kind !== result.authority.kind ||
    result.output.kind !== "inline" ||
    result.output.digest !== result.authority.resultDigest
  )
    throw new Error("Tool Host returned invalid read authority");
  // Pi 1.5 gives the model a tool's `output`.
  return {
    output: [
      {
        type: "text",
        text: result.output.content.map(renderHarnessHistoryContent).join("\n"),
      },
    ],
    details: { pantryAuthority: result.authority },
    isError: result.status === "failed",
  };
}

async function rejectWorkflowCanvasTool() {
  throw new Error("Workflow canvas is outside this fixture");
}
