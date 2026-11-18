import type { HarnessOpaqueContinuation } from "./HarnessOpaqueContinuation";

export type HarnessAssistantContent =
  | { kind: "text"; text: string; continuation: HarnessOpaqueContinuation }
  | {
      kind: "thinking";
      text: string;
      redacted: boolean;
      continuation: HarnessOpaqueContinuation;
    }
  | {
      kind: "tool_call";
      callId: string;
      tool: string;
      arguments: unknown;
      continuation: HarnessOpaqueContinuation;
    };
