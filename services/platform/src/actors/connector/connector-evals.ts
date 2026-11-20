import type { ConnectorIdentity } from "@purin-labs/contracts";
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
  type EvalTaskEnd,
  EVAL_RUN_TOKEN_BUDGET,
  EVAL_TASK_TOKEN_ALLOWANCE,
  evalRunTokensUsed,
} from "../connector-eval";
import type { EvalTaskServices } from "../../evals/contract/eval-task";
import { publishEvalRunResult, readEvalRunFixture } from "../../evals/access";
import { createEvalTurnMemoryReader } from "../../memory/access";
import { newRequestId } from "../../ids";
import { traceWarn } from "../../observability";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { isActorExecutionActive } from "../actor-execution-quiescence";
import { invalid } from "./support";
import { type ConnectorResult } from "./types";
import { ConnectorActorBase } from "./connector-actor-base";

/** The parts of an eval run that the agent turn of a task uses. */
const EVAL_TASK_SERVICES: EvalTaskServices = {
  readEvalRunFixture,
  createEvalTurnMemoryReader,
  settleEvalTask,
  evalRunTokensUsed,
  runTokenBudget: EVAL_RUN_TOKEN_BUDGET,
  taskTokenAllowance: EVAL_TASK_TOKEN_ALLOWANCE,
};

type ConnectorEmailIdentityRequest = {
  readonly identity: ConnectorIdentity;
  readonly now: number;
};

/**
 * Eval runs and their settlement for the Connector. The mailbox level gives
 * the agent that an eval tries: it says if the agent is on, and it runs one
 * task as a turn of that agent.
 */
export abstract class ConnectorEvals extends ConnectorActorBase {
  /** True when the mailbox agent that an eval tries is active. */
  protected abstract evalAgentActive(): boolean;

  /** Runs one claimed task as a turn of the mailbox agent. */
  protected abstract runEvalTask(
    scope: OrganisationExecutionScope,
    claim: ClaimedEvalTask,
    evals: EvalTaskServices,
    now: number,
  ): Promise<EvalTaskEnd>;

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
    return this.trackExecution(this.admittedStartEvalRun.bind(this, input));
  }

  protected async admittedStartEvalRun(
    input: Parameters<ConnectorEvals["startEvalRun"]>[0],
  ): Promise<ConnectorResult<Readonly<{ runId: string; caseId: string }>>> {
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    if (!this.evalAgentActive()) return invalid("eval_unavailable");
    const admitted = this.ctx.storage.transactionSync(
      admitEvalRun.bind(null, this.ctx.storage.sql, {
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
    await this.armAlarm();
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
    return this.trackExecution(
      this.admittedReadEvalRunCommand.bind(this, input),
    );
  }

  protected async admittedReadEvalRunCommand(
    input: Parameters<ConnectorEvals["readEvalRunCommand"]>[0],
  ): Promise<
    ConnectorResult<Readonly<{ runId: string; caseId: string }> | null>
  > {
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const earlier = findEvalRunCommand(this.ctx.storage.sql, input);
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
    return this.trackExecution(this.admittedCancelEvalRun.bind(this, input));
  }

  protected async admittedCancelEvalRun(
    input: Parameters<ConnectorEvals["cancelEvalRun"]>[0],
  ): Promise<
    ConnectorResult<Readonly<{ runId: string; caseId: string }> | null>
  > {
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const run = this.ctx.storage.transactionSync(() =>
      cancelEvalRun(this.ctx.storage.sql, {
        evalId: input.evalId,
        runId: input.runId,
        now: input.now,
      }),
    );
    if (run === null) return { ok: true, value: null };
    await this.armAlarm();
    return { ok: true, value: { runId: run.runId, caseId: run.caseId } };
  }

  /**
   * The runs of one Eval in progress on this mailbox. They carry no result:
   * a result is released only from the settled run, under its label.
   */
  async readEvalRunProgress(
    input: ConnectorEmailIdentityRequest & Readonly<{ evalId: string }>,
  ): Promise<ConnectorResult<ReturnType<typeof readEvalRunProgress>>> {
    return this.trackExecution(
      this.admittedReadEvalRunProgress.bind(this, input),
    );
  }

  protected async admittedReadEvalRunProgress(
    input: Parameters<ConnectorEvals["readEvalRunProgress"]>[0],
  ): Promise<ConnectorResult<ReturnType<typeof readEvalRunProgress>>> {
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    return {
      ok: true,
      value: readEvalRunProgress(this.ctx.storage.sql, input.evalId),
    };
  }

  protected async runDueEvalWork(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    const sql = this.ctx.storage.sql;
    for (let processed = 0; processed < 4; processed += 1) {
      if (!(await isActorExecutionActive(sql, scope))) return;
      const now = Date.now();
      const claim = this.ctx.storage.transactionSync(
        claimDueEvalTask.bind(null, sql, now),
      );
      if (claim === null) break;
      // A task that throws leaves its turn's end unknown. The next claim
      // reads what it left on the Case.
      const end = await this.runEvalTask(
        scope,
        claim,
        EVAL_TASK_SERVICES,
        now,
      ).catch((): EvalTaskEnd => ({
        kind: "deferred",
        retryAt: now + 30_000,
        exhausted: { kind: "indeterminate", code: "eval_task_failed" },
      }));
      if (end.kind === "inactive") return;
      if (end.kind !== "deferred") continue;
      const key = { runId: claim.run.runId, taskId: claim.task.taskId };
      if (claim.attempt >= EVAL_TASK_MAX_CLAIMS) {
        this.ctx.storage.transactionSync(
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
      this.ctx.storage.transactionSync(
        deferEvalTask.bind(null, sql, { ...key, availableAt: end.retryAt }),
      );
    }
    await this.publishSettledEvalRuns(scope);
  }

  /**
   * Publishes each run whose tasks have all settled. The OrganisationActor
   * receives the settled result alone. A run it cannot take now is tried
   * again later, with the same result.
   */
  protected async publishSettledEvalRuns(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    const sql = this.ctx.storage.sql;
    for (let published = 0; published < 4; published += 1) {
      const now = Date.now();
      const settled = this.ctx.storage.transactionSync(
        readSettledEvalRun.bind(null, sql, now),
      );
      if (settled === null) return;
      const runId = settled.result.runId;
      const outcome = await publishEvalRunResult({
        env: this.env,
        execution: scope,
        organisationId: scope.organisationId,
        result: settled.result,
        flowLabels: settled.flowLabels,
      }).catch(() => "unavailable" as const);
      if (!(await isActorExecutionActive(sql, scope))) return;
      if (outcome === "unavailable") {
        this.ctx.storage.transactionSync(
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
      this.ctx.storage.transactionSync(
        markEvalRunPublished.bind(null, sql, { runId, now }),
      );
    }
  }
}
