import type { AgentStatus } from "./AgentStatus";
import type { ErrorInfo } from "./ErrorInfo";
import type { Outcome } from "./Outcome";

export type AgentEvent =
  | { type: "agent_message"; text: string; finalMessage: boolean }
  | { type: "agent_tool_use"; tool: string; args: unknown; callId: string }
  | { type: "custom_tool_use"; tool: string; args: unknown; callId: string }
  | { type: "status"; state: AgentStatus }
  | { type: "done"; outcome: Outcome | null }
  | { type: "error"; error: ErrorInfo; retryable: boolean };
