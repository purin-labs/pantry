import type { AgentEvent } from "./AgentEvent";

export type AgentEventEnvelope = {
  turnId: string;
  sequence: number;
  emittedAt: number;
  event: AgentEvent;
};
