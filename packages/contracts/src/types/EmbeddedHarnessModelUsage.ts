
export type EmbeddedHarnessModelUsage = {
  modelCalls: number;
  callsWithUsage: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};
