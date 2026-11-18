import type { ActionClass } from "./ActionClass";
import type { EffectId } from "./EffectId";
import type { PolicyVersion } from "./PolicyVersion";

export type ProposedEffectRef = {
  effectId: EffectId;
  policyVersion: PolicyVersion;
  stakes: ActionClass;
};
