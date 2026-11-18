import { armAlarmBy } from "../../services/platform/src/actors/lifecycle/actor-alarm.ts";
import {
  CandidateActor as ProviderActor,
  ProposalOrganisation as ProviderOrganisation,
} from "./provider-worker.mjs";
export { default, ProposalCase } from "./provider-worker.mjs";
export { CodeModePlatformGovernorActor } from "../../services/platform/src/actors/code-mode-platform-governor.ts";
import {
  createRegistry,
  defineExtension,
  GenerationTask,
  ROOT_CONVERSATION_ID,
  ToolResultEntry,
  AssistantEntry,
  hook,
} from "@earendil-works/pi-durable";

export class ProposalOrganisation extends ProviderOrganisation {
  async settleCodeModeBudget(input) {
    const result = await super.settleCodeModeBudget(input);
    if (
      this.env.TRIAL_SCENARIO === "provider_codemode_organisation_settlement"
    ) {
      const response = await fetch(
        `${this.env.PROVIDER_URL}/organisation-settlement-held`,
        {
          method: "POST",
          body: JSON.stringify({
            scenario: this.env.TRIAL_SCENARIO,
            input,
            result,
          }),
        },
      );
      await response.json();
    }
    return result;
  }
}
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { CodemodeStoreDoc } from "@earendil-works/pi-durable/codemode";
import { ActorSqliteDatabase } from "../../services/platform/src/actors/pi-durable-database.ts";
import {
  CodeModeResult,
  CodeModeStore,
  createDurableHostTools,
} from "../../services/platform/src/actors/pi-durable-tools.ts";
import { hasUnfinishedCodeModeCall } from "../../services/platform/src/actors/pi-durable-recovery.ts";
import { preflightHarnessTurnLease } from "../../services/platform/src/actors/agent-session-harness-authority.ts";
import { buildCanonicalTextTurnStart } from "../../services/platform/src/actors/agent-session-turn-start.ts";
import {
  commitAcceptedSessionInput,
  commitRuntimeActivatedSession,
} from "../../services/platform/src/actors/actor-journal.ts";
import {
  commitCancellationStartedSession,
  commitCancellationResolvedSession,
} from "../../services/platform/src/actors/actor-journal/transactions.ts";
import {
  reserveRunBudget,
  readSessionBudgetAccount,
  settleRunBudget,
  markRunBudgetIndeterminate,
  reconcileRunBudget,
} from "../../services/platform/src/actors/agent-session-budget.ts";
import {
  buildTextTurnCancellationStartedCommit,
  buildTextTurnCancellationResolvedCommit,
} from "../../services/platform/src/actors/agent-session-text-turn.ts";
import { failSessionTurnStream } from "../../services/platform/src/actors/agent-session-turn-stream.ts";
import { organisationId } from "./proposal-worker.mjs";
import { installMcpFixture, mcpCatalog, readMcp } from "./mcp-fixture.mjs";
import { readSessionTurnFlowBinding } from "../../services/platform/src/actors/agent-session-information-flow.ts";
import {
  toPiPrompt,
  toHistoryContent,
} from "../../services/platform/src/actors/pi-user-input.ts";
import { imageInput } from "./attachment-fixture.mjs";
import { createSessionReplayResponse } from "../../services/platform/src/actors/session/replay.ts";
import { exerciseSlowWatch } from "./observation-fixture.mjs";
import { readPortalTaskItems } from "./portal-task-projection.mjs";
import {
  createTaskHistoryFixture,
  exerciseTaskOwnership,
} from "./ownership-fixture.mjs";
import { parseChatCommand } from "../../services/platform/src/chat/conversation.ts";
import {
  admitSteeringInput,
  markSteeringInputPlaced,
  markSteeringInputQueued,
  markSteeringInputWithdrawn,
} from "../../services/platform/src/actors/harness-steering.ts";
import { readJsonRecord } from "../../services/platform/src/control/http.ts";
import { canonicalJson, sha256Hex } from "../../packages/std/src/index.ts";
import {
  portalInputRequestId,
  parsePortalInputIdentity,
} from "./portal-input-identity.mjs";
import {
  installPortalAuthority,
  createPortalReplay,
  completePortalConversation,
  createPortalCompletionStream,
  readPortalConversation,
  authorizePortalInput,
  sharePortalTrial,
  setPortalContributorRole,
  conversationId,
} from "./portal-observation-fixture.mjs";

function required(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export class CandidateActor extends ProviderActor {
  requestAuthority() {
    if (this.portalAuthority === undefined)
      throw new Error("Missing admitted operator authority");
    return this.portalAuthority;
  }

  offerGrantIds() {
    return ["grant_native_offer_read_observer"];
  }

  currentLease() {
    const control = this.inputControl();
    if (control?.command.kind === "cancel") return control.command.lease;
    return super.currentLease();
  }

  async alarm() {
    this.portalAuthority = await this.ctx.storage.get("portal_trial_authority");
    return super.alarm();
  }
  initializeAdmission() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS evaluation_input_control (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), phase TEXT NOT NULL CHECK (phase IN ('queued', 'admitted', 'complete')), command TEXT NOT NULL CHECK (json_valid(command)))",
    );
    const pending = this.inputControl();
    if (pending?.command.kind === "cancel" && pending.phase !== "complete") {
      this.ctx.waitUntil(armAlarmBy(this.ctx.storage, Date.now() + 1000));
      return;
    }
    super.initializeAdmission();
  }

  inputControl() {
    const row = this.ctx.storage.sql
      .exec(
        "SELECT phase, command FROM evaluation_input_control WHERE singleton = 1",
      )
      .toArray()[0];
    return row === undefined
      ? null
      : { phase: row.phase, command: JSON.parse(row.command) };
  }

  async drive() {
    const pending = this.inputControl();
    if (pending?.command.kind === "cancel" && pending.phase !== "complete")
      await this.finishCancellation();
    return super.drive();
  }

  async beforeCheckpointFinalization() {
    if (this.nativeCommitActive) return;
    const completed = await completePortalConversation(this);
    if (
      (await this.ctx.storage.get("evaluation_scenario")) ===
      "provider_codemode_restart"
    )
      await this.provider("/portal-settled-held", {
        revision: completed.revision,
      });
  }

  async acceptFacts(facts) {
    // A steering input that Pi placed in the running turn completes the steer.
    const steering = this.inputControl();
    if (
      steering?.command.kind === "steer" &&
      steering.phase === "queued" &&
      facts.some(isSteeringFact.bind(null, steering.command))
    ) {
      await super.acceptFacts(facts);
      markSteeringInputPlaced(
        this.ctx.storage.sql,
        steering.command.lease.session.sessionId,
        steering.command.portalInput.inputId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE evaluation_input_control SET phase = 'complete' WHERE singleton = 1",
      );
      return;
    }
    if (
      facts.length !== 2 ||
      facts[0].kind !== "assistant_message" ||
      facts[0].stopReason !== "completed" ||
      facts[1].kind !== "user_input"
    )
      return super.acceptFacts(facts);
    const previousGeneration = this.currentLease().runtimeLease.generation;
    await super.acceptFacts([facts[0]]);
    await this.finalizeSavedCheckpoint();
    if (this.queuedInputRequest === undefined)
      throw new Error("Missing queued input identity");
    this.startFollowup(this.queuedInputRequest, previousGeneration);
    await this.prepareSubmittedTurn();
    const lease = this.currentLease();
    await super.acceptFacts([
      {
        kind: "user_input",
        turn: lease.turn,
        input: this.historyInput(lease),
        content: facts[1].content,
        acceptedAt: facts[1].acceptedAt,
      },
    ]);
  }

  async acceptOne(lease, fact) {
    const accepted = await super.acceptOne(lease, fact);
    if (
      accepted.ok &&
      accepted.value.kind !== "duplicate" &&
      fact.kind === "assistant_message" &&
      fact.stopReason === "tool_use"
    ) {
      await this.acceptProjectedEvents(
        lease,
        fact.content.filter(isToolCall).map(projectToolCall),
      );
    }
    return accepted;
  }
  async createModelRegistry() {
    this.image = await imageInput(organisationId);
    return super.createModelRegistry();
  }

  async userHistoryContent(message, entry, writes) {
    if (
      typeof message.content === "string" ||
      entry.kind === STEERING_ENTRY_KIND
    )
      return super.userHistoryContent(message);
    const submission = writes.find(submissionForEntry.bind(null, entry.id));
    if (submission?.value.requestId !== "input_plan50_seams")
      throw new Error("Image input requires its accepted attachment source");
    const input = [{ kind: "text", text: super.inputContent() }, this.image];
    const prompt = required(toPiPrompt(input));
    if (
      JSON.stringify(message.content) !==
      JSON.stringify([{ type: "text", text: prompt.text }, ...prompt.images])
    )
      throw new Error("Attachment content differs from its admitted source");
    return input.map(toHistoryContent);
  }
  profileCapabilities() {
    return [...super.profileCapabilities(), "custom_connector.read"];
  }

  async catalogSelection() {
    this.mcp = await mcpCatalog(this.env, this.requestAuthority());
    return {
      allowedCapabilities: this.catalogCapabilities(),
      customConnectorOperations: this.mcp.entries,
    };
  }

  toolDefinitions(host) {
    return host.definitions.filter(
      isTrialTool.bind(null, this.mcp.entries[0].toolName),
    );
  }

  toolReplay(name) {
    if (name === this.mcp.entries[0].toolName) return "safe";
    return super.toolReplay(name);
  }

  async readCustomConnector(lease, entry, rawArguments, operationId) {
    const flow = required(
      await readSessionTurnFlowBinding(this.ctx.storage.sql, {
        organisationId,
        sessionId: lease.session.sessionId,
        turnId: lease.turn.turnId,
      }),
    );
    if (flow === null) throw new Error("Missing MCP flow binding");
    return readMcp(
      this,
      lease,
      flow.binding,
      this.mcp,
      entry,
      rawArguments,
      operationId,
    );
  }
  async resolveProfileBinding() {
    const binding = await super.resolveProfileBinding();
    if (binding.kind !== "resolved") return binding;
    return {
      kind: "resolved",
      profile: binding.profile,
      instructions: binding.instructions,
      extensionName: `${binding.extensionName}/codemode-v1`,
    };
  }

  async registry() {
    if (this.observedOffer !== undefined) await this.acceptOfferObservation();
    const lease = this.currentLease();
    const host = await super.toolHost(lease);
    const tools = createDurableHostTools(
      {
        ...host,
        definitions: this.toolDefinitions(host),
      },
      this.preflight.bind(this, lease),
      lease.turn.turnId,
      this.toolReplay.bind(this),
    );
    this.trustedExtension = defineExtension({
      name: this.extensionName(),
      tools,
      hooks: [
        hook(GenerationTask, {
          afterTools: finishCodeModeRound.bind(null, this, lease.turn.turnId),
          onYield: enableNextTurnTools.bind(null, this),
        }),
      ],
    });
    this.initialTools = tools.filter(isInitialTool);
    this.executionRegistry ??= createRegistry();
    this.executionRegistry.install(this.trustedExtension);
    return this.executionRegistry;
  }

  rootAgent(model) {
    return { ...super.rootAgent(model), tools: this.initialTools };
  }

  // As Platform's runtime does on a resumed turn: while Pi holds a Code Mode
  // call, the agent offers the tool, so Pi can run the call again.
  async initialize() {
    const runtime = await super.initialize();
    if (hasUnfinishedCodeModeCall(this.ctx.storage.sql)) {
      const agent = await runtime.root.agent(BACKGROUND_CONTEXT);
      if (!agent.tools.some(isCodeModeTool))
        await runtime.root.configure(
          {
            tools: [
              ...agent.tools,
              ...this.initialTools.filter(isCodeModeTool),
            ],
          },
          BACKGROUND_CONTEXT,
        );
    }
    return runtime;
  }

  async preflight(lease) {
    required(preflightHarnessTurnLease(this.ctx.storage, lease, Date.now()));
  }

  async commitBatch(sqlite, database, writes, context) {
    // Pi places a native steer as its own entry inside the running turn; it
    // is a user input of that turn, not a queued input that starts the next.
    const steeringEntry = writes.find(isSteeringEntryWrite);
    this.steeringInputId = steeringEntry?.value.data.inputId;
    const messages = writes.filter(isEntryWrite).flatMap(entryMessages);
    const queuedBoundary =
      steeringEntry === undefined &&
      messages.some(isFinalAnswer) &&
      messages.some(isUserInput);
    if (queuedBoundary) {
      const userEntry = writes.find(isUserEntryWrite);
      const submission = writes.find(
        submissionForEntry.bind(null, userEntry.value.id),
      );
      if (
        submission?.value.type !== "input" ||
        typeof submission.value.requestId !== "string"
      )
        throw new Error("Queued input has no admitted submission identity");
      this.queuedInputRequest = submission.value.requestId;
      this.inputBoundary = {
        roles: messages.map(messageRole),
        lifecycle: this.lifecycle().kind,
        acceptance: { kind: "pending" },
      };
    }
    let seq;
    this.nativeCommitActive = true;
    try {
      seq = await super.commitBatch(sqlite, database, writes, context);
    } catch (error) {
      if (queuedBoundary) {
        this.inputBoundary.acceptance = {
          kind: "rejected",
          reason: String(error),
        };
      }
      throw error;
    } finally {
      this.nativeCommitActive = false;
      this.steeringInputId = undefined;
    }
    if (queuedBoundary) {
      await this.prepareGoalExecution();
      await this.registry();
      this.inputBoundary.acceptance = {
        kind: "accepted",
        turnId: this.currentLease().turn.turnId,
      };
    }
    for (const write of writes) {
      if (
        write.type === "document.change" &&
        write.content.kind === "base" &&
        write.content.value.state?.kind === "pending_settlement" &&
        [
          "provider_codemode_settlement",
          "provider_codemode_organisation_settlement",
        ].includes(await this.ctx.storage.get("evaluation_scenario"))
      )
        await this.provider("/code-result-held", {
          taskResult: write.content.value.state,
        });
      if (
        write.type !== "document.change" ||
        write.content.kind !== "base" ||
        write.content.value.state?.kind !== "completed"
      )
        continue;
      const record = this.ctx.storage.sql
        .exec("SELECT kind FROM documents WHERE id = ?", write.id)
        .toArray()[0];
      if (record?.kind === JSON.stringify(CodeModeResult.definition.kind))
        await this.provider("/code-result-held", {
          taskResult: write.content.value.state,
        });
    }
    return seq;
  }

  validateRecoverableTools(sql, generation) {
    const rows = sql
      .exec(
        "SELECT record FROM tasks WHERE json_extract(record, '$.kind') = 'pi.tool' AND json_extract(record, '$.owner') = ?",
        generation.id,
      )
      .toArray();
    if (rows.length !== 1) throw new Error("Expected one saved Code Mode task");
    const task = JSON.parse(rows[0].record);
    if (
      task.input.callId !== "code_original" ||
      task.state.checkpoint.phase !== "execute"
    )
      throw new Error("Unexpected interrupted Code Mode task");
    const result = sql
      .exec(
        "SELECT r.content FROM documents d JOIN document_revisions r ON r.document_id = d.id WHERE d.kind = ? AND d.owner_id = ? AND r.kind = 'base'",
        JSON.stringify(CodeModeResult.definition.kind),
        task.id,
      )
      .toArray();
    if (
      result.length !== 1 ||
      !["completed", "pending_settlement"].includes(
        JSON.parse(result[0].content).state.kind,
      )
    )
      throw new Error("Interrupted Code Mode requires its saved receipt");
  }

  async admitRecovery() {
    if (!(await this.admitExtensionRecovery())) return;
    if (!(await this.admitProposalRecoveryAuthority())) return;
    this.ctx.storage.transactionSync(this.resumeNativeExecution.bind(this));
  }

  startFollowup(inputId, previousGeneration) {
    const current = this.lifecycle();
    if (current?.kind !== "sleeping")
      throw new Error("Follow-up requires a stopped turn");
    const now = Date.now();
    const generation = previousGeneration + 1;
    const turnId = `turn_plan50_followup_${generation}`;
    const request = this.turnRequest(
      now,
      `start_${turnId}`,
      turnId,
      generation,
    );
    request.input.inputId = inputId;
    const start = required(
      buildCanonicalTextTurnStart({
        current,
        request,
      }),
    );
    required(commitAcceptedSessionInput(this.ctx.storage, start.acceptedInput));
    required(
      commitRuntimeActivatedSession(this.ctx.storage, start.activatedRuntime),
    );
    const lease = start.harnessLease;
    required(
      reserveRunBudget(this.ctx.storage.sql, {
        organisationId,
        sessionId: lease.session.sessionId,
        operationId: `reserve_${turnId}`,
        now,
        runId: `run_${turnId}`,
        reservationId: `reservation_${lease.session.sessionId}_run_${turnId}_${generation}_${lease.turn.turnLeaseGeneration}_${lease.turn.budgetRevision}`,
        runtimeGeneration: generation,
        turnLeaseGeneration: lease.turn.turnLeaseGeneration,
        budgetRevision: lease.turn.budgetRevision,
        turnId: lease.turn.turnId,
      }),
    );
  }

  inputContent() {
    if (this.currentLease().turn.turnId.startsWith("turn_plan50_followup_"))
      return "Load the saved proposal with Code Mode. Do not create another proposal.";
    const prompt = required(
      toPiPrompt([{ kind: "text", text: super.inputContent() }, this.image]),
    );
    return [{ type: "text", text: prompt.text }, ...prompt.images];
  }

  startCancellation(command) {
    const lease = command.lease;
    const cancellation = {
      cancellationId: inputCancellationId(command),
      correlationId: "trial",
      acceptedAt: command.acceptedAt,
    };
    required(
      commitCancellationStartedSession(
        this.ctx.storage,
        required(
          buildTextTurnCancellationStartedCommit({
            current: this.lifecycle(),
            harnessLease: lease,
            cancellation,
          }),
        ),
      ),
    );
    if (command.kind === "cancel") this.preserveInterruptedModelBudget(command);
  }

  preserveInterruptedModelBudget(command) {
    if (command.modelUsage.kind === "none") return;
    const lease = command.lease;
    const budget = required(
      readSessionBudgetAccount(this.ctx.storage.sql, lease.session),
    );
    if (budget.reservation.kind === "indeterminate") return;
    if (budget.reservation.kind !== "active")
      throw new Error(
        "Interrupted model request requires an active reservation",
      );
    const reservation = budget.reservation.reservation;
    required(
      markRunBudgetIndeterminate(this.ctx.storage.sql, {
        organisationId,
        sessionId: lease.session.sessionId,
        operationId: `cancel_unknown_model_${reservation.reservationId}`,
        now: Date.now(),
        runId: reservation.runId,
        reservationId: reservation.reservationId,
        runtimeGeneration: reservation.runtimeGeneration,
        turnLeaseGeneration: reservation.turnLeaseGeneration,
        budgetRevision: reservation.budgetRevision,
        reason: "model_receipt_missing",
      }),
    );
  }

  resolveCancellation(command) {
    const lease = command.lease;
    const now = Date.now();
    const cancellation = {
      cancellationId: inputCancellationId(command),
      correlationId: "trial",
      acceptedAt: command.acceptedAt,
    };
    const budget = required(
      readSessionBudgetAccount(this.ctx.storage.sql, lease.session),
    );
    if (budget.reservation.kind === "none")
      throw new Error("Cancellation requires an unsettled reservation");
    if (budget.reservation.kind === "active") {
      const reservation = budget.reservation.reservation;
      required(
        settleRunBudget(this.ctx.storage.sql, {
          organisationId,
          sessionId: lease.session.sessionId,
          operationId: cancellation.cancellationId,
          now,
          runId: reservation.runId,
          reservationId: reservation.reservationId,
          runtimeGeneration: reservation.runtimeGeneration,
          turnLeaseGeneration: reservation.turnLeaseGeneration,
          budgetRevision: reservation.budgetRevision,
          usage: budget.reservation.acceptedUsage,
          outcome: "cancelled",
        }),
      );
    }
    required(
      commitCancellationResolvedSession(
        this.ctx.storage,
        required(
          buildTextTurnCancellationResolvedCommit({
            current: this.lifecycle(),
            cancellation,
          }),
        ),
      ),
    );
    required(
      failSessionTurnStream(
        this.ctx.storage.sql,
        lease.turn.turnId,
        "Stopped by operator.",
        now,
      ),
    );
  }

  // A steer joins the running turn natively, as Platform's steering does
  // (Plan 71): Pi places it after the current step, and nothing is aborted.
  async steer(requester, portalInput) {
    const existing = this.inputControl();
    if (existing !== null) {
      if (
        existing.command.kind !== "steer" ||
        existing.command.requester.userId !== requester.userId ||
        JSON.stringify(existing.command.portalInput) !==
          JSON.stringify(portalInput)
      )
        return Response.json(
          { error: "input_control_conflict" },
          { status: 409 },
        );
      return Response.json({
        accepted: true,
        submissionId: existing.command.submissionId,
      });
    }
    const lease = this.currentLease();
    await this.preflight(lease);
    const { root } = await this.getRuntime();
    const acceptedAt = Date.now();
    const nativeRequestId = portalInputRequestId(
      requester.userId,
      portalInput,
      await sha256Hex(canonicalJson(portalInput)),
      acceptedAt,
    );
    // As Platform does, the Session admits the steering input for this turn
    // first; history accepts its placement only against that record.
    const sql = this.ctx.storage.sql;
    const sessionId = lease.session.sessionId;
    const inputId = portalInput.inputId;
    const admitted = admitSteeringInput(sql, {
      sessionId,
      turnId: lease.turn.turnId,
      inputId,
      requestId: nativeRequestId,
      inputRef: { ...this.historyInput(lease), inputId },
      content: [{ kind: "text", text: portalInput.text }].map(toHistoryContent),
      message: {
        firstPart: { kind: "text", text: portalInput.text },
        remainingParts: [],
      },
      admittedAt: acceptedAt,
    });
    if (admitted.kind === "conflict")
      return Response.json(
        { error: "steering_request_conflict" },
        { status: 409 },
      );
    let submission;
    try {
      submission = await root.submit(
        {
          type: "input",
          requestId: nativeRequestId,
          content: portalInput.text,
          whenIdle: "reject",
          whenBusy: "steer",
          entry: {
            kind: STEERING_ENTRY_KIND,
            data: { inputId: portalInput.inputId },
          },
        },
        BACKGROUND_CONTEXT,
      );
    } catch (error) {
      markSteeringInputWithdrawn(sql, sessionId, inputId);
      return Response.json(
        { error: "turn_not_running", detail: String(error) },
        { status: 409 },
      );
    }
    markSteeringInputQueued(sql, sessionId, inputId, String(submission.id));
    this.ctx.storage.sql.exec(
      "INSERT INTO evaluation_input_control VALUES (1, 'queued', ?)",
      JSON.stringify({
        kind: "steer",
        lease,
        acceptedAt,
        requester,
        portalInput,
        nativeRequestId,
        submissionId: submission.id,
      }),
    );
    await this.provider("/steering-held", { submissionId: submission.id });
    // The actor keeps driving the running turn after this request ends.
    this.ctx.waitUntil(this.drive());
    return Response.json({ accepted: true, submissionId: submission.id });
  }

  historyInput(lease) {
    const input = super.historyInput(lease);
    return this.steeringInputId === undefined
      ? input
      : { ...input, inputId: this.steeringInputId };
  }

  async cancelAssignment(requester) {
    const existing = this.inputControl();
    if (existing !== null) {
      if (existing.command.kind !== "cancel")
        return Response.json(
          { error: "input_control_conflict" },
          { status: 409 },
        );
      if (existing.phase !== "complete") await this.finishCancellation();
      return Response.json({
        accepted: true,
        cancellationId: `cancel_${existing.command.lease.turn.inputId}`,
      });
    }
    const lease = this.currentLease();
    await this.preflight(lease);
    const command = {
      kind: "cancel",
      requester,
      lease,
      acceptedAt: Date.now(),
      modelUsage: this.interruptedModelUsage(lease),
    };
    this.ctx.storage.transactionSync(
      this.admitCancellation.bind(this, command),
    );
    await armAlarmBy(this.ctx.storage, Date.now() + 1000);
    await this.provider("/cancellation-held", {
      cancellationId: `cancel_${lease.turn.inputId}`,
    });
    await this.finishCancellation();
    return Response.json({
      accepted: true,
      cancellationId: `cancel_${lease.turn.inputId}`,
    });
  }

  admitCancellation(command) {
    this.startCancellation(command);
    this.ctx.storage.sql.exec(
      "INSERT INTO evaluation_input_control VALUES (1, 'queued', ?)",
      JSON.stringify(command),
    );
  }

  interruptedModelUsage(lease) {
    const pending = this.ctx.storage.sql
      .exec(
        "SELECT record FROM tasks WHERE json_extract(record, '$.kind') = 'pi.generation' AND json_extract(record, '$.state.checkpoint.phase') = 'request' AND json_extract(record, '$.state.status') != 'terminal'",
      )
      .toArray();
    if (pending.length === 0) return { kind: "none" };
    if (pending.length !== 1)
      throw new Error("Expected one interrupted model request");
    const budget = required(
      readSessionBudgetAccount(this.ctx.storage.sql, lease.session),
    );
    if (budget.reservation.kind !== "active")
      throw new Error("Expected active model reservation");
    return {
      kind: "unknown",
      modelRequestId: `model_request_${JSON.parse(pending[0].record).id}`,
      runId: budget.reservation.reservation.runId,
      reservationId: budget.reservation.reservation.reservationId,
    };
  }

  async reconcileCancelledModelUsage() {
    const control = this.inputControl();
    if (
      control?.phase !== "complete" ||
      control.command.kind !== "cancel" ||
      control.command.modelUsage.kind !== "unknown"
    )
      return Response.json({ reconciled: false, reason: "not_waiting" });
    const command = control.command;
    const budget = required(
      readSessionBudgetAccount(this.ctx.storage.sql, command.lease.session),
    );
    if (budget.reservation.kind !== "indeterminate")
      return Response.json({ reconciled: false, reason: "not_waiting" });
    const expected = command.modelUsage;
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
      return Response.json({ reconciled: false, reason: "evidence_mismatch" });
    const reconciled = this.ctx.storage.transactionSync(
      this.acceptCancelledModelUsage.bind(this, command, receipt),
    );
    return Response.json(
      reconciled
        ? { reconciled: true }
        : { reconciled: false, reason: "not_waiting" },
    );
  }

  acceptCancelledModelUsage(command, receipt) {
    const budget = required(
      readSessionBudgetAccount(this.ctx.storage.sql, command.lease.session),
    );
    if (budget.reservation.kind !== "indeterminate") return false;
    const reservation = budget.reservation.reservation;
    if (
      reservation.runId !== receipt.runId ||
      reservation.reservationId !== receipt.reservationId
    )
      throw new Error(
        "Cancelled model reservation changed before reconciliation",
      );
    required(
      reconcileRunBudget(this.ctx.storage.sql, {
        organisationId,
        sessionId: command.lease.session.sessionId,
        operationId: `reconcile_${receipt.modelRequestId}`,
        now: Date.now(),
        runId: reservation.runId,
        reservationId: reservation.reservationId,
        runtimeGeneration: reservation.runtimeGeneration,
        turnLeaseGeneration: reservation.turnLeaseGeneration,
        budgetRevision: reservation.budgetRevision,
        usage: {
          tokens: budget.reservation.acceptedUsage.tokens + receipt.tokens,
          activeWallMs: budget.reservation.acceptedUsage.activeWallMs,
          capabilityCalls: budget.reservation.acceptedUsage.capabilityCalls,
        },
        outcome: "cancelled",
      }),
    );
    return true;
  }

  finishCancellation() {
    if (this.cancellationWork === undefined)
      this.cancellationWork = this.runCancellation();
    return this.cancellationWork;
  }

  async runCancellation() {
    const pending = this.inputControl();
    if (pending === null || pending.phase === "complete") return;
    this.assignment = await this.ctx.storage.get("proposal_assignment");
    const { root } =
      this.runtime === null
        ? await this.openCancellationRuntime()
        : await this.runtime;
    await root.abort(BACKGROUND_CONTEXT, { background: true });
    this.ctx.storage.transactionSync(
      this.completeCancellation.bind(this, pending.command),
    );
    await this.ctx.storage.deleteAlarm();
  }

  async openCancellationRuntime() {
    // Recovery needs task abort handlers, but has no authority to start inference.
    const { harness, storage } = await this.openHarness(
      createModels(),
      this.cancellationRegistry(),
    );
    const root = await harness.root(BACKGROUND_CONTEXT);
    const runtime = { harness, root, storage };
    this.runtime = Promise.resolve(runtime);
    return runtime;
  }

  cancellationRegistry() {
    return createRegistry();
  }

  historyMessages(entry, writes) {
    if (
      this.lifecycle()?.kind === "cancelling" &&
      entry.kind === AssistantEntry.kind &&
      entry.model?.length === 1 &&
      entry.model[0].role === "assistant" &&
      entry.model[0].stopReason === "aborted"
    ) {
      for (const write of writes) {
        if (
          write.type === "task" &&
          write.value.id === entry.byTaskId &&
          write.value.kind === "pi.generation" &&
          write.value.abortRequested === true &&
          write.value.state.status === "terminal" &&
          write.value.state.outcome.status === "aborted"
        ) {
          // Preserve the partial in Pi's abort record without accepting it as
          // conversation output after canonical cancellation fenced the turn.
          return [];
        }
      }
    }
    if (
      this.lifecycle()?.kind === "cancelling" &&
      entry.kind === ToolResultEntry.kind
    ) {
      for (const write of writes) {
        if (
          write.type === "task" &&
          write.value.kind === "pi.tool" &&
          write.value.abortRequested === true &&
          write.value.state.status === "terminal" &&
          write.value.state.outcome.status === "aborted" &&
          write.value.state.outcome.result?.entryId === entry.id
        ) {
          // Pi's abort record closes its task. The fenced Pantry turn cannot
          // accept this synthetic result as new execution history.
          return [];
        }
      }
    }
    return super.historyMessages(entry, writes);
  }

  completeCancellation(command) {
    this.resolveCancellation(command);
    this.ctx.storage.sql.exec(
      "UPDATE evaluation_input_control SET phase = 'complete' WHERE singleton = 1",
    );
  }

  async fetch(request) {
    this.portalAuthority = await this.ctx.storage.get("portal_trial_authority");
    if (new URL(request.url).pathname === "/share-trial")
      return Response.json(await sharePortalTrial(this));
    if (new URL(request.url).pathname === "/promote-contributor")
      return Response.json(await setPortalContributorRole(this, "editor", 1));
    if (new URL(request.url).pathname === "/demote-contributor")
      return Response.json(await setPortalContributorRole(this, "viewer", 2));
    if (new URL(request.url).pathname === "/restore-contributor")
      return Response.json(await setPortalContributorRole(this, "editor", 3));
    if (new URL(request.url).pathname === "/portal-conversation")
      return Response.json(await readPortalConversation(this));
    if (new URL(request.url).pathname === "/portal-completion")
      return Response.json(await completePortalConversation(this));
    if (new URL(request.url).pathname === "/portal-completion-stream")
      return createPortalCompletionStream(this);
    if (new URL(request.url).pathname === "/portal-replay") {
      const after = Number(
        new URL(request.url).searchParams.get("after") ?? "-1",
      );
      if (!Number.isSafeInteger(after) || after < -1)
        return new Response("Invalid cursor.", { status: 400 });
      return createPortalReplay(this, after, request);
    }
    if (new URL(request.url).pathname === "/watch-probe") {
      const { root, harness } = await this.getRuntime();
      return Response.json(await exerciseSlowWatch(root, harness, this));
    }
    if (new URL(request.url).pathname === "/task-history-probe") {
      this.assignment = await this.ctx.storage.get("proposal_assignment");
      const { root, harness } = await this.getRuntime();
      return Response.json(
        await createTaskHistoryFixture(
          harness,
          this.executionRegistry,
          root.id,
        ),
      );
    }
    if (new URL(request.url).pathname === "/ownership-probe") {
      const { harness } = await this.getRuntime();
      return Response.json(
        await exerciseTaskOwnership(harness, this.executionRegistry),
      );
    }
    if (new URL(request.url).pathname === "/alarm-schedule-probe") {
      const initial = Date.now() + 60_000;
      await this.ctx.storage.setAlarm(initial);
      await armAlarmBy(this.ctx.storage, initial + 60_000);
      const afterLater = await this.ctx.storage.getAlarm();
      const earlier = Date.now() + 1_000;
      await armAlarmBy(this.ctx.storage, earlier);
      const afterEarlier = await this.ctx.storage.getAlarm();
      return Response.json({ initial, afterLater, earlier, afterEarlier });
    }
    if (new URL(request.url).pathname === "/replay") {
      const url = new URL(request.url);
      const response = createSessionReplayResponse(
        { sql: this.ctx.storage.sql, durableState: this.ctx },
        {
          organisationId,
          turnId: "turn_plan50_seams",
          afterSequence: Number(url.searchParams.get("after") ?? "-1"),
        },
      );
      if (!response.ok) return Response.json(response, { status: 409 });
      return response.value;
    }
    if (new URL(request.url).pathname === "/start") {
      await installMcpFixture(
        this.env,
        new URL(request.url).searchParams.get("scenario"),
      );
      if (this.portalAuthority === undefined) {
        this.portalAuthority = await installPortalAuthority(
          this.env,
          new URL(request.url).searchParams.get("scenario") ===
            "provider_codemode_queue",
        );
        await this.ctx.storage.put(
          "portal_trial_authority",
          this.portalAuthority,
        );
      }
    }
    const path = new URL(request.url).pathname;
    if (path === "/portal-tasks") return readPortalTaskItems(this, request);
    if (path === "/reconcile-model-usage")
      return this.reconcileCancelledModelUsage();
    if (
      path !== "/steer" &&
      path !== "/queue" &&
      path !== "/followup" &&
      path !== "/withdraw" &&
      path !== "/cancel"
    )
      return super.fetch(request);
    const command = await authorizePortalInput(this, request);
    if (command.kind === "denied")
      return Response.json({ error: "chat_not_found" }, { status: 403 });
    if (path === "/cancel") return this.cancelAssignment(command.requester);
    if (path === "/steer" || path === "/queue" || path === "/withdraw") {
      if (request.method !== "POST")
        return new Response("POST required.", { status: 405 });
      const body = await readJsonRecord(request);
      if (!body.ok)
        return Response.json(
          { error: "chat_request_invalid" },
          { status: 400 },
        );
      const parsed = parseChatCommand(body.value);
      if (!parsed.ok)
        return Response.json({ error: parsed.error }, { status: 400 });
      const input = parsed.value;
      if (
        input.conversationId !== conversationId ||
        (path === "/queue" && input.kind !== "next") ||
        (path === "/steer" && input.kind !== "steer") ||
        (path === "/withdraw" && input.kind !== "withdraw")
      )
        return Response.json(
          { error: "invalid_input_command" },
          { status: 400 },
        );
      if (input.kind === "withdraw") {
        const record = await readPortalSubmission(
          this.ctx.storage,
          command.requester.userId,
          input.inputId,
          null,
        );
        if (record === null)
          return Response.json(
            { error: "submission_not_found" },
            { status: 404 },
          );
        if (record.status === "done" || record.status === "unanswered")
          return Response.json({ outcome: "settled" });
        const { harness } = await this.getRuntime();
        const submission = await harness.submission(
          record.id,
          BACKGROUND_CONTEXT,
        );
        return Response.json({
          outcome: await submission.abort(BACKGROUND_CONTEXT),
        });
      }
      if (
        input.model !== this.lifecycle().state.contract.modelRoute.model ||
        input.browserContext.kind !== "unavailable" ||
        input.surfaceContext !== null ||
        input.attachments.length !== 0 ||
        input.effort !== undefined
      )
        return Response.json(
          { error: "unsupported_input_context" },
          { status: 400 },
        );
      if (input.kind === "steer") return this.steer(command.requester, input);
      if (new URL(request.url).searchParams.get("hold") === "admission")
        await this.provider("/input-admission-held", {
          inputId: input.inputId,
        });
      const currentCommand = await authorizePortalInput(this, request);
      if (currentCommand.kind === "denied")
        return Response.json({ error: "chat_not_found" }, { status: 403 });
      return this.ctx.blockConcurrencyWhile(
        this.queuePortalInput.bind(this, currentCommand.requester, input),
      );
    }
    this.assignment = await this.ctx.storage.get("proposal_assignment");
    this.ctx.storage.transactionSync(
      this.startFollowup.bind(
        this,
        "input_restore_trial",
        this.lifecycle().state.resumePoint.checkpoint.runtimeGeneration,
      ),
    );
    const { root } = await this.getRuntime();
    const agent = await root.agent(BACKGROUND_CONTEXT);
    await root.configure(
      {
        tools: [
          ...agent.tools.filter(isAdditionalTool),
          ...this.initialTools.filter(isCodeModeTool),
        ],
      },
      BACKGROUND_CONTEXT,
    );
    const submission = await this.submit();
    this.ctx.waitUntil(this.drive());
    return Response.json({ accepted: true, submissionId: submission.id });
  }

  async queuePortalInput(requester, input) {
    const digest = await sha256Hex(canonicalJson(input));
    const existing = await readPortalSubmission(
      this.ctx.storage,
      requester.userId,
      input.inputId,
      input.requestId,
    );
    if (existing !== null) {
      const identity = parsePortalInputIdentity(existing.requestId);
      if (identity.mode !== "next" || identity.digest !== digest)
        return Response.json(
          { error: "idempotency_key_conflict" },
          { status: 409 },
        );
      return Response.json(existing);
    }
    await this.preflight(this.currentLease());
    const { root } = await this.getRuntime();
    const requestId = portalInputRequestId(
      requester.userId,
      input,
      digest,
      Date.now(),
    );
    const submission = await root.submit(
      {
        type: "input",
        requestId,
        whenBusy: "followUp",
        content: input.text,
      },
      BACKGROUND_CONTEXT,
    );
    return Response.json(await submission.status(BACKGROUND_CONTEXT));
  }

  async snapshot() {
    const snapshot = await super.snapshot();
    snapshot.inputControl = this.inputControl();
    snapshot.inputBoundary = this.inputBoundary ?? null;
    const storage = await SqliteStorage.open(
      new ActorSqliteDatabase(this.ctx.storage),
    );
    try {
      const execution = await readConversationDocument(
        storage,
        CodeModeStore.definition.kind,
      );
      const scratch = await readConversationDocument(
        storage,
        CodemodeStoreDoc.definition.kind,
      );
      return {
        ...snapshot,
        executionAuthority: this.requestAuthority(),
        codeStore:
          execution === null && scratch === null
            ? null
            : {
                execution: execution?.execution ?? { kind: "none" },
                values: scratch?.values ?? {},
              },
      };
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  }
}

// Pantry's document holds the turn's Code Mode attempt; Pi's holds script values.
async function readConversationDocument(storage, kind) {
  const record = await storage.findDocument(
    { kind, scope: { kind: "conversation", conversationId: 1 } },
    "current",
    BACKGROUND_CONTEXT,
  );
  if (record === undefined) return null;
  return (await storage.document(record.id, "current", BACKGROUND_CONTEXT))
    .value;
}

function isEntryWrite(write) {
  return write.type === "entry";
}

async function findPortalSubmission(
  storage,
  conversationId,
  requesterId,
  inputId,
  requestId,
) {
  let cursor;
  let found = null;
  do {
    const page = await storage.scanSubmissions(
      { conversationId },
      64,
      cursor,
      BACKGROUND_CONTEXT,
    );
    for (const record of page.items) {
      const identity = parsePortalInputIdentity(record.requestId);
      if (
        identity === null ||
        identity.requesterId !== requesterId ||
        (identity.inputId !== inputId && identity.requestId !== requestId)
      )
        continue;
      if (found !== null) throw new Error("Duplicate Portal input identity");
      found = record;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
}

async function readPortalSubmission(
  actorStorage,
  requesterId,
  inputId,
  requestId,
) {
  const storage = await SqliteStorage.open(
    new ActorSqliteDatabase(actorStorage),
  );
  try {
    return await findPortalSubmission(
      storage,
      ROOT_CONVERSATION_ID,
      requesterId,
      inputId,
      requestId,
    );
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
}

function inputCancellationId(command) {
  switch (command.kind) {
    case "cancel":
      return `cancel_${command.lease.turn.inputId}`;
    default:
      throw new Error("Unknown input control command");
  }
}

const STEERING_ENTRY_KIND = "satyr.steer";

function isSteeringEntryWrite(write) {
  return write.type === "entry" && write.value.kind === STEERING_ENTRY_KIND;
}

function isSteeringFact(command, fact) {
  return (
    fact.kind === "user_input" &&
    fact.input.inputId === command.portalInput.inputId
  );
}

function isUserEntryWrite(write) {
  return isEntryWrite(write) && entryMessages(write).some(isUserInput);
}

async function enableNextTurnTools(actor, answer, api, context) {
  const { root } = await actor.getRuntime();
  const agent = await root.agent(context);
  await root.configure(
    {
      tools: [
        ...agent.tools.filter(isAdditionalTool),
        ...actor.initialTools.filter(isCodeModeTool),
      ],
    },
    context,
  );
}

function entryMessages(write) {
  return write.value.model ?? [];
}

function isFinalAnswer(message) {
  return message.role === "assistant" && message.stopReason === "stop";
}

function isUserInput(message) {
  return message.role === "user";
}

function messageRole(message) {
  return message.role;
}

function isInitialTool(tool) {
  return tool.name === "codemode" || tool.name === "tool_search";
}

async function finishCodeModeRound(
  actor,
  turnId,
  assistant,
  results,
  api,
  context,
) {
  const store = await api.snapshot(CodeModeStore, api.conversationId, context);
  if (store?.execution.kind !== "used" || store.execution.turnId !== turnId)
    return;
  const { root } = await actor.getRuntime();
  const agent = await root.agent(context);
  await root.configure(
    { tools: agent.tools.filter(isAdditionalTool) },
    context,
  );
}
function isAdditionalTool(tool) {
  return tool.name !== "codemode";
}

function isCodeModeTool(tool) {
  return tool.name === "codemode";
}

function isTrialTool(mcpName, definition) {
  return (
    definition.name === "commerce_propose_action" || definition.name === mcpName
  );
}

function submissionForEntry(entryId, write) {
  return write.type === "submission" && write.value.entry === entryId;
}

function isToolCall(content) {
  return content.kind === "tool_call";
}

function projectToolCall(content) {
  return {
    type: "agent_tool_use",
    tool: content.tool,
    args: content.arguments,
    callId: content.callId,
  };
}
