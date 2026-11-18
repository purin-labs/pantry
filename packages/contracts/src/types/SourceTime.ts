import type { Timestamp } from "./Timestamp";

export type SourceTime =
  | { kind: "producer"; occurredAt: Timestamp }
  | { kind: "satyr"; issuedAt: Timestamp };
