import type {
  EvalConfiguration,
  EvalContent,
  EvalRevisionRef,
  EvalRoute,
  EvalTaskKey,
  EvalTaskOutcome,
  EvalTaskResult,
} from "@purin-labs/control-api";
import type { FlowLabel } from "@purin-labs/authority/policy/information-flow/index";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { CreateEvalTurnMemoryReader } from "../memory/memory-service";

export type ConnectorEvalRun = Readonly<{
  runId: string;
  commandId: string;
  eval: EvalRevisionRef;
  caseId: string;
  startedByPersonId: string;
  startedAt: number;
  routes: readonly EvalRoute[];
  configurations: readonly EvalConfiguration[];
  cancelledAt: number | null;
}>;

export type ConnectorEvalTask = EvalTaskKey & Readonly<{ position: number }>;

export type ClaimedEvalTask = Readonly<{
  run: ConnectorEvalRun;
  task: ConnectorEvalTask;
  /** How many times this task has been claimed, this claim included. */
  attempt: number;
}>;

/** What one task ended with, and the label of what its turn observed. */
export type SettledEvalTask = Readonly<{
  result: Omit<EvalTaskResult, keyof EvalTaskKey>;
  flowLabel: unknown;
}>;

/**
 * How one claim of a task ended. `settled` is recorded already. `deferred`
 * leaves the task claimed for another try, and names what it ends with if no
 * tries are left.
 */
export type EvalTaskEnd =
  | Readonly<{ kind: "settled"; outcome: EvalTaskOutcome }>
  | Readonly<{
      kind: "deferred";
      retryAt: number;
      exhausted: EvalTaskOutcome;
    }>
  /** The Connector stopped being the active instance. Nothing was changed. */
  | Readonly<{ kind: "inactive" }>;

/** One scenario of one Eval revision as a run reads it, with its label. */
type EvalRunFixture = Readonly<{
  subject: EvalContent["subject"];
  scenario: EvalContent["scenarios"][number];
  flowLabel: FlowLabel;
}>;

/** The exact Eval revision and scenario that one eval task tries. */
export type EvalRunFixtureRequest = Readonly<{
  env: Env;
  execution: OrganisationExecutionScope;
  organisationId: OrganisationId;
  eval: Readonly<{ evalId: string; revision: number }>;
  scenarioId: string;
}>;

export type EvalRunFixtureRead =
  | Readonly<{ kind: "read"; fixture: EvalRunFixture }>
  | Readonly<{ kind: "missing"; fixture?: never }>
  | Readonly<{ kind: "unreadable"; fixture?: never }>;

type ReadEvalRunFixture = (
  input: EvalRunFixtureRequest,
) => Promise<EvalRunFixtureRead>;

type SettleEvalTask = (
  sql: SqlStorage,
  input: Readonly<{ runId: string; taskId: string }> & SettledEvalTask,
) => void;

type EvalRunTokensUsed = (sql: SqlStorage, runId: string) => number;

/**
 * What the Eval level of the Connector gives the agent turn of one eval
 * task: the scenario fixture, the Memory of the turn, and the record of the
 * run in the Connector. The agent that an eval tries runs the turn, and the
 * Eval level keeps the run.
 */
export type EvalTaskServices = Readonly<{
  readEvalRunFixture: ReadEvalRunFixture;
  createEvalTurnMemoryReader: CreateEvalTurnMemoryReader;
  settleEvalTask: SettleEvalTask;
  evalRunTokensUsed: EvalRunTokensUsed;
  /** The tokens of one run, for all its tasks. */
  runTokenBudget: number;
  /** The most tokens that one task may use. */
  taskTokenAllowance: number;
}>;
