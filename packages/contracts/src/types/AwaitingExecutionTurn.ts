import type { EffectId } from "./EffectId";
import type { ExecutionId } from "./ExecutionId";
import type { TurnIdentity } from "./TurnIdentity";

export type AwaitingExecutionTurn = {
  identity: TurnIdentity;
  executionId: ExecutionId;
  effectId: EffectId;
};
