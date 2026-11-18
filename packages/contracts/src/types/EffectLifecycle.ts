import type { DispatchingEffect } from "./DispatchingEffect";
import type { IndeterminateEffect } from "./IndeterminateEffect";
import type { PendingEffect } from "./PendingEffect";
import type { ReconciledEffect } from "./ReconciledEffect";
import type { SettledEffect } from "./SettledEffect";

export type EffectLifecycle<Request, Receipt> =
  | { kind: "pending"; state: PendingEffect<Request> }
  | { kind: "dispatching"; state: DispatchingEffect<Request> }
  | { kind: "settled"; state: SettledEffect<Receipt> }
  | { kind: "reconciled"; state: ReconciledEffect<Receipt> }
  | { kind: "indeterminate"; state: IndeterminateEffect<Request> };
