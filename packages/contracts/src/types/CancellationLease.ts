import type { RuntimeLease } from "./RuntimeLease";
import type { TurnLeaseGeneration } from "./TurnLeaseGeneration";

export type CancellationLease =
  | { kind: "none" }
  | {
      kind: "active";
      runtimeLease: RuntimeLease;
      turnLeaseGeneration: TurnLeaseGeneration;
    };
