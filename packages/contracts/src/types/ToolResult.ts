
export type ToolResult =
  | { status: "ok"; callId: string; result: unknown }
  | { status: "error"; callId: string; error: unknown };
