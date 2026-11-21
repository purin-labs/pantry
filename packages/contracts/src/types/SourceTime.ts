import type { Timestamp } from "./Timestamp";

export type SourceTime =
  | { kind: "producer"; occurredAt: Timestamp }
  | { kind: "pantry"; issuedAt: Timestamp };
