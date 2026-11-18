import type { EffectId } from "./EffectId";
import type { ModelRequestId } from "./ModelRequestId";
import type { RunBudgetReservationId } from "./RunBudgetReservationId";
import type { RunId } from "./RunId";

export type SessionRecoveryEvidence =
  | {
      kind: "model_usage";
      modelRequestId: ModelRequestId;
      runId: RunId;
      reservationId: RunBudgetReservationId;
    }
  | { kind: "effect_receipt"; effectId: EffectId };
