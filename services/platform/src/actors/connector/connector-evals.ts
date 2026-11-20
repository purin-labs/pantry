import type { ConnectorModuleHost } from "./channel-adapter";
import { readEmailRuntime } from "../connector-email";
import {
  admitEvalRun,
  cancelEvalRun,
  claimDueEvalTask,
  deferEvalRunPublication,
  deferEvalTask,
  EVAL_TASK_MAX_CLAIMS,
  findEvalRunCommand,
  markEvalRunPublished,
  readEvalRunProgress,
  readSettledEvalRun,
  settleEvalTask,
  type ClaimedEvalTask,
} from "../connector-eval";
import { processEvalTask, type EvalTaskEnd } from "../eval-task-processing";
import { publishEvalRunResult } from "../../evals/access";
import { newRequestId } from "../../ids";
import { traceWarn } from "../../observability";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { isActorExecutionActive } from "../actor-execution-quiescence";
import { invalid } from "./support";
import { type ConnectorResult } from "./types";
import { type ConnectorEmailIdentityRequest } from "./whatsapp-parsers";
import type { ConnectorDO } from "../connector";

/**
 * Eval runs and their settlement for the Connector.
 */
export class ConnectorEvals {
  constructor(private readonly host: ConnectorModuleHost) {}

  /**
   * Starts one eval run of this mailbox's agent. The caller has checked who
   * asks and what they may try. The same command sent again answers with the
   * run it made.
   */
  async startEvalRun(
    input: ConnectorEmailIdentityRequest &
      Readonly<{
        runId: string;
        caseId: string;
        commandId: string;
        requestDigest: string;
        eval: Readonly<{ evalId: string; revision: number }>;
        scenarioIds: readonly string[];
        routes: ClaimedEvalTask["run"]["routes"];
        configurations: ClaimedEvalTask["run"]["configurations"];
        startedByPersonId: string;
      }>,
  ): Promise<ConnectorResult<Readonly<{ runId: string; caseId: string }>>> {
    return this.host.trackExecution(
      this.admittedStartEvalRun.bind(this, input),
    );
  }

  private async admittedStartEvalRun(
    input: Parameters<ConnectorDO["startEvalRun"]>[0],
  ): Promise<ConnectorResult<Readonly<{ runId: string; caseId: string }>>> {
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const runtime = readEmailRuntime(this.host.ctx.storage.sql);
    if (runtime === null || runtime.disabledAt !== null)
      return invalid("eval_unavailable");
    const admitted = this.host.ctx.storage.transactionSync(
      admitEvalRun.bind(null, this.host.ctx.storage.sql, {
        runId: input.runId,
        caseId: input.caseId,
        commandId: input.commandId,
        requestDigest: input.requestDigest,
        eval: input.eval,
        scenarioIds: input.scenarioIds,
        routes: input.routes,
        configurations: input.configurations,
        startedByPersonId: input.startedByPersonId,
        now: input.now,
      }),
    );
    if (admitted.kind === "command_conflict")
      return invalid("eval_command_conflict");
    if (admitted.kind === "capacity_exceeded")
      return invalid("eval_capacity_exceeded");
    await this.host.armAlarm();
    return {
      ok: true,
      value: { runId: admitted.run.runId, caseId: admitted.run.caseId },
    };
  }

  /**
   * The run that an earlier send of a start command made. Null means the
   * command is new to this mailbox. The caller asks this before it checks
   * the present state, so a repeated command gets its first answer.
   */
  async readEvalRunCommand(
    input: ConnectorEmailIdentityRequest &
      Readonly<{ commandId: string; requestDigest: string }>,
  ): Promise<
    ConnectorResult<Readonly<{ runId: string; caseId: string }> | null>
  > {
    return this.host.trackExecution(
      this.admittedReadEvalRunCommand.bind(this, input),
    );
  }

  private async admittedReadEvalRunCommand(
    input: Parameters<ConnectorDO["readEvalRunCommand"]>[0],
  ): Promise<
    ConnectorResult<Readonly<{ runId: string; caseId: string }> | null>
  > {
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const earlier = findEvalRunCommand(this.host.ctx.storage.sql, input);
    if (earlier === null) return { ok: true, value: null };
    if (earlier.kind === "command_conflict")
      return invalid("eval_command_conflict");
    return {
      ok: true,
      value: { runId: earlier.run.runId, caseId: earlier.run.caseId },
    };
  }

  /**
   * Cancels one eval run in progress. Tasks not yet started end as
   * cancelled. Null means this mailbox holds no such run.
   */
  async cancelEvalRun(
    input: ConnectorEmailIdentityRequest &
      Readonly<{ evalId: string; runId: string }>,
  ): Promise<
    ConnectorResult<Readonly<{ runId: string; caseId: string }> | null>
  > {
    return this.host.trackExecution(
      this.admittedCancelEvalRun.bind(this, input),
    );
  }

  private async admittedCancelEvalRun(
    input: Parameters<ConnectorDO["cancelEvalRun"]>[0],
  ): Promise<
    ConnectorResult<Readonly<{ runId: string; caseId: string }> | null>
  > {
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const run = this.host.ctx.storage.transactionSync(() =>
      cancelEvalRun(this.host.ctx.storage.sql, {
        evalId: input.evalId,
        runId: input.runId,
        now: input.now,
      }),
    );
    if (run === null) return { ok: true, value: null };
    await this.host.armAlarm();
    return { ok: true, value: { runId: run.runId, caseId: run.caseId } };
  }

  /**
   * The runs of one Eval in progress on this mailbox. They carry no result:
   * a result is released only from the settled run, under its label.
   */
  async readEvalRunProgress(
    input: ConnectorEmailIdentityRequest & Readonly<{ evalId: string }>,
  ): Promise<ConnectorResult<ReturnType<typeof readEvalRunProgress>>> {
    return this.host.trackExecution(
      this.admittedReadEvalRunProgress.bind(this, input),
    );
  }

  private async admittedReadEvalRunProgress(
    input: Parameters<ConnectorDO["readEvalRunProgress"]>[0],
  ): Promise<ConnectorResult<ReturnType<typeof readEvalRunProgress>>> {
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    return {
      ok: true,
      value: readEvalRunProgress(this.host.ctx.storage.sql, input.evalId),
    };
  }

  async runDueEvalWork(scope: OrganisationExecutionScope): Promise<void> {
    const sql = this.host.ctx.storage.sql;
    for (let processed = 0; processed < 4; processed += 1) {
      if (!(await isActorExecutionActive(sql, scope))) return;
      const now = Date.now();
      const claim = this.host.ctx.storage.transactionSync(
        claimDueEvalTask.bind(null, sql, now),
      );
      if (claim === null) break;
      // A task that throws leaves its turn's end unknown. The next claim
      // reads what it left on the Case.
      const end = await this.runEvalTask(scope, claim, now).catch(
        (): EvalTaskEnd => ({
          kind: "deferred",
          retryAt: now + 30_000,
          exhausted: { kind: "indeterminate", code: "eval_task_failed" },
        }),
      );
      if (end.kind === "inactive") return;
      if (end.kind !== "deferred") continue;
      const key = { runId: claim.run.runId, taskId: claim.task.taskId };
      if (claim.attempt >= EVAL_TASK_MAX_CLAIMS) {
        this.host.ctx.storage.transactionSync(
          settleEvalTask.bind(null, sql, {
            ...key,
            result: {
              outcome: end.exhausted,
              execution: null,
              pins: null,
              totalTokens: null,
            },
            flowLabel: null,
          }),
        );
        traceWarn("connector.eval_task_claims_exhausted", {
          requestId: newRequestId(),
          reason: end.exhausted.kind,
        });
        continue;
      }
      this.host.ctx.storage.transactionSync(
        deferEvalTask.bind(null, sql, { ...key, availableAt: end.retryAt }),
      );
    }
    await this.publishSettledEvalRuns(scope);
  }

  private async runEvalTask(
    scope: OrganisationExecutionScope,
    claim: ClaimedEvalTask,
    now: number,
  ): Promise<EvalTaskEnd> {
    const sql = this.host.ctx.storage.sql;
    const agentUnavailable = (): EvalTaskEnd => {
      const outcome = {
        kind: "unavailable",
        reason: "agent_unavailable",
      } as const;
      settleEvalTask(sql, {
        runId: claim.run.runId,
        taskId: claim.task.taskId,
        result: { outcome, execution: null, pins: null, totalTokens: null },
        flowLabel: null,
      });
      return { kind: "settled", outcome };
    };
    const runtime = readEmailRuntime(sql);
    if (runtime === null || runtime.disabledAt !== null)
      return agentUnavailable();
    const binding = await scope.database
      .prepare(
        `SELECT mailbox_binding_id AS mailboxBindingId, current_revision AS currentRevision
         FROM agent_mailbox_binding WHERE organisation_id = ? AND integration_account_id = ?`,
      )
      .bind(runtime.organisationId, runtime.integrationAccountId)
      .first<{
        readonly mailboxBindingId: string;
        readonly currentRevision: number;
      }>();
    if (!(await isActorExecutionActive(sql, scope)))
      return { kind: "inactive" };
    if (binding === null) return agentUnavailable();
    return processEvalTask(this.host.env, {
      scope,
      connectorSql: sql,
      organisationId: runtime.organisationId,
      integrationAccountId: runtime.integrationAccountId,
      mailboxBindingId: binding.mailboxBindingId,
      bindingRevision: binding.currentRevision,
      mailboxPolicyVersion: runtime.policyVersion,
      dailyTokenBudget: runtime.limits.dailyTokenBudget,
      claim,
      now,
    });
  }

  /**
   * Publishes each run whose tasks have all settled. The OrganisationActor
   * receives the settled result alone. A run it cannot take now is tried
   * again later, with the same result.
   */
  private async publishSettledEvalRuns(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    const sql = this.host.ctx.storage.sql;
    for (let published = 0; published < 4; published += 1) {
      const now = Date.now();
      const settled = this.host.ctx.storage.transactionSync(
        readSettledEvalRun.bind(null, sql, now),
      );
      if (settled === null) return;
      const runId = settled.result.runId;
      const outcome = await publishEvalRunResult({
        env: this.host.env,
        execution: scope,
        organisationId: scope.organisationId,
        result: settled.result,
        flowLabels: settled.flowLabels,
      }).catch(() => "unavailable" as const);
      if (!(await isActorExecutionActive(sql, scope))) return;
      if (outcome === "unavailable") {
        this.host.ctx.storage.transactionSync(
          deferEvalRunPublication.bind(null, sql, {
            runId,
            publishAfter: now + 60_000,
          }),
        );
        continue;
      }
      if (outcome === "refused")
        traceWarn("connector.eval_run_result_refused", {
          requestId: newRequestId(),
          reason: "eval_run_result_refused",
        });
      this.host.ctx.storage.transactionSync(
        markEvalRunPublished.bind(null, sql, { runId, now }),
      );
    }
  }
}

/** The RPC methods of this module. The Actor class has one method for each. */
export type ConnectorEvalsRpc = Pick<
  ConnectorEvals,
  | "startEvalRun"
  | "readEvalRunCommand"
  | "cancelEvalRun"
  | "readEvalRunProgress"
>;
