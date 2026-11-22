import type {
  AssistantMessageEventStream,
  AssistantMessage,
  Model,
  Api,
} from "@earendil-works/pi-ai";
import type { PiModelResponse } from "./pi-model-transport";
/**
 * Whether a provider's error says that the credential has no allowance left:
 * HTTP 402, OpenAI's `insufficient_quota`, or the ChatGPT usage limit of a
 * subscription. The SDK starts its error text with the HTTP status, except
 * for the subscription, whose text names the limit. Any other text is not
 * such a refusal.
 */
export function providerAllowanceSpent(message: string | undefined): boolean {
  return (
    message !== undefined &&
    (/^402\b/u.test(message) ||
      /\binsufficient_quota\b/u.test(message) ||
      /^You have hit your ChatGPT usage limit\b/u.test(message))
  );
}

/**
 * Whether a failed model request generated no tokens: the provider answered
 * with an error status and reported no usage. A refusal for a spent
 * allowance keeps its own outcome.
 */
export function errorStatusWithoutTokens(
  response: PiModelResponse,
  error: AssistantMessage,
): boolean {
  return (
    response.errorStatus === true &&
    error.usage.totalTokens === 0 &&
    !providerAllowanceSpent(error.errorMessage)
  );
}

export function failNativeStream(
  output: AssistantMessageEventStream,
  model: Model<Api>,
  error: unknown,
): void {
  const message: AssistantMessage = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    stopReason: "error",
    errorMessage: String(error),
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  output.push({ type: "error", reason: "error", error: message });
  output.end(message);
}
