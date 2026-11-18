import type { CaseWait } from "./CaseWait";
import type { Timestamp } from "./Timestamp";

export type CaseLifecycle =
  | { kind: "open"; openedAt: Timestamp }
  | { kind: "waiting"; wait: CaseWait }
  | { kind: "completing"; startedAt: Timestamp }
  | { kind: "completed"; completedAt: Timestamp }
  | { kind: "quarantined"; reason: string; quarantinedAt: Timestamp }
  | { kind: "archived"; archivedAt: Timestamp };
