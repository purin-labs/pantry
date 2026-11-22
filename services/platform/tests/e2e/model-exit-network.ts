import { WorkerEntrypoint } from "cloudflare:workers";
import {
  containerRequest,
  exitRefusal,
  forwardChatGptRequest,
} from "@purin-labs/agent/chatgpt-exit/forward";

/** The mark on each request that left the E2E runtime through the exit Worker. */
export const MODEL_EXIT_EGRESS_HEADER = "x-e2e-model-exit-egress";

/** The mark on each request that left the E2E runtime through the ChatGPT exit. */
export const CHATGPT_EXIT_EGRESS_HEADER = "x-e2e-chatgpt-exit-egress";

/**
 * The internet as the model exit Worker reaches it in the E2E runtime. The
 * exit Worker's outbound requests arrive here and go on through the test
 * network with a mark that only this path adds, so a fake provider can
 * tell a request that left through the exit Worker (Plan 73).
 */
export class ModelExitNetwork extends WorkerEntrypoint {
  override fetch(request: Request): Promise<Response> {
    const marked = new Request(request);
    marked.headers.set(MODEL_EXIT_EGRESS_HEADER, "1");
    return fetch(marked);
  }
}

/**
 * The ChatGPT exit as the platform Worker reaches it in the E2E runtime
 * (Plan 75). The E2E runtime cannot run a container, so this entrypoint
 * stands in for the ChatGPT exit Worker and its container: it runs both of
 * their steps, `containerRequest` and `forwardChatGptRequest`, and the
 * forwarded request goes on through the test network with a mark that only
 * this path adds.
 */
export class ChatGptExitNetwork extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    const handOver = containerRequest(request);
    if (handOver === null)
      return exitRefusal(403, "chatgpt_exit_host_refused", null);
    return forwardChatGptRequest(handOver, {
      fetch: fetchWithChatGptExitMark,
      colo: "E2E",
    });
  }
}

function fetchWithChatGptExitMark(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const marked = new Request(input, init);
  marked.headers.set(CHATGPT_EXIT_EGRESS_HEADER, "1");
  return fetch(marked);
}
