/**
 * The Worker bindings of the model exits: the model exit Worker (Plan 73)
 * and the ChatGPT exit Worker with its container (Plan 75).
 */
export type ModelExitBinding = {
  readonly MODEL_EXIT: Fetcher;
  readonly CHATGPT_EXIT: Fetcher;
};

/**
 * The fetch of a direct request to a model provider: the ChatGPT
 * subscription, OpenAI, Anthropic, the Gemini API and the Claude account,
 * with their sign-in, refresh and allowance requests. The request goes through the
 * model exit Worker, which runs near AWS Tokyo. A chatgpt.com request goes
 * through the ChatGPT exit instead: chatgpt.com refuses requests from a
 * Worker and accepts them from a container. The OpenRouter platform route
 * does not use this fetch.
 */
export function modelProviderFetch(bindings: ModelExitBinding): typeof fetch {
  return fetchThroughModelExit.bind(null, bindings);
}

function fetchThroughModelExit(
  bindings: ModelExitBinding,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const exit =
    requestHostname(input) === "chatgpt.com"
      ? bindings.CHATGPT_EXIT
      : bindings.MODEL_EXIT;
  return exit.fetch(input, init);
}

function requestHostname(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.hostname;
  return new URL(typeof input === "string" ? input : input.url).hostname;
}
