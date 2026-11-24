import type { CaseWait } from "./CaseWait";
import type { Timestamp } from "./Timestamp";

export type CaseLifecycle =
  | { kind: "open"; openedAt: Timestamp }
  | { kind: "waiting"; wait: CaseWait }
  | { kind: "quarantined"; reason: string; quarantinedAt: Timestamp };
