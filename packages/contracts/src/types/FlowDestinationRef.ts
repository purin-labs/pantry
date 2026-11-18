
export type FlowDestinationRef =
  | { kind: "conversation"; conversationRefId: string; revision: number }
  | { kind: "workflow"; workflowRefId: string; revision: number };
