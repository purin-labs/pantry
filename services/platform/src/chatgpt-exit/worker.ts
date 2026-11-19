import { Container } from "@cloudflare/containers";
import { containerRequest, exitRefusal } from "./forward";

/**
 * The ChatGPT exit Worker (Plan 75).
 *
 * chatgpt.com refuses requests from a Worker and accepts them from a
 * container. The Platform sends each chatgpt.com request of the ChatGPT
 * subscription route here, through its service binding CHATGPT_EXIT, and
 * this Worker hands it to one shared container in Asia Pacific. The
 * container (services/chatgpt-exit) runs `forwardChatGptRequest`.
 *
 * The Worker and the container hold no credential and keep no state; the
 * request carries the organisation's token. Neither logs a header, a body or
 * a token, and neither retries.
 */
export class ChatGptExitContainer extends Container<ChatGptExitEnv> {
  defaultPort = 8080;
  requiredPorts = [8080];
  // A container start costs about two seconds, and an idle lite container
  // costs about US$0.003 an hour.
  sleepAfter = "1h";
  enableInternet = true;
  pingEndpoint = "/health";
}

type ChatGptExitEnv = {
  readonly CHATGPT_EXIT_CONTAINER: DurableObjectNamespace<ChatGptExitContainer>;
  readonly PANTRY_DEPLOYMENT_PROFILE: string;
};

/** All organisations share one container. */
const CONTAINER_NAME = "chatgpt-exit";
/**
 * Northeast Asia. OpenAI refuses Hong Kong, which the wider "apac" hint
 * allows; the container also refuses to forward from there.
 */
const CONTAINER_LOCATION_HINT = "apac-ne" satisfies DurableObjectLocationHint;

export default {
  fetch: handOverChatGptRequest,
} satisfies ExportedHandler<ChatGptExitEnv>;

async function handOverChatGptRequest(
  request: Request,
  env: ChatGptExitEnv,
): Promise<Response> {
  const handOver = containerRequest(request);
  if (handOver === null)
    return exitRefusal(403, "chatgpt_exit_host_refused", null);
  return env.CHATGPT_EXIT_CONTAINER.getByName(CONTAINER_NAME, {
    locationHint: CONTAINER_LOCATION_HINT,
  }).fetch(handOver);
}
