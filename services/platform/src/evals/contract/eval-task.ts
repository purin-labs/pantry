import type {
  ClaimedEvalTask,
  EvalTaskEnd,
  evalRunTokensUsed,
  SettledEvalTask,
  settleEvalTask,
} from "../../actors/connector-eval";
import type { readEvalRunFixture } from "../access";
import type { createEvalTurnMemoryReader } from "../../memory/access";

export type { ClaimedEvalTask, EvalTaskEnd, SettledEvalTask };

/**
 * What the Eval level of the Connector gives the agent turn of one eval
 * task: the scenario fixture, the Memory of the turn, and the record of the
 * run in the Connector. The agent that an eval tries runs the turn, and the
 * Eval level keeps the run.
 */
export type EvalTaskServices = Readonly<{
  readEvalRunFixture: typeof readEvalRunFixture;
  createEvalTurnMemoryReader: typeof createEvalTurnMemoryReader;
  settleEvalTask: typeof settleEvalTask;
  evalRunTokensUsed: typeof evalRunTokensUsed;
  /** The tokens of one run, for all its tasks. */
  runTokenBudget: number;
  /** The most tokens that one task may use. */
  taskTokenAllowance: number;
}>;
