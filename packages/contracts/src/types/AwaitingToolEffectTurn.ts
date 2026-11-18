import type { EffectId } from "./EffectId";
import type { TurnIdentity } from "./TurnIdentity";

export type AwaitingToolEffectTurn = {
  identity: TurnIdentity;
  effectId: EffectId;
};
