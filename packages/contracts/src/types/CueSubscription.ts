import type { CueAction } from "./CueAction";
import type { Predicate } from "./Predicate";
import type { SurfaceRef } from "./SurfaceRef";

export type CueSubscription = {
  subscriptionId: string;
  organisationId: string;
  version: number;
  surfaceScope: SurfaceRef;
  source: string;
  eventType: string;
  condition: Predicate | null;
  action: CueAction;
  tier: number;
  debounceMs: number | null;
  maxPerHour: number | null;
  enabled: boolean;
};
