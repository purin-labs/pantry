import { readChatGptExitEnvironment } from "./worker-environment.mjs";
import { checkAndDeploy, requireSmallScript } from "./lib/side-worker.mjs";

// The ChatGPT exit Worker hands each chatgpt.com request of the ChatGPT
// subscription route to one small container (Plan 75). The platform Worker
// binds it by name, so this Worker deploys first: a platform deployment that
// names a missing Worker fails.

// The Worker holds the container class and a hand-over, nothing else. A
// larger script means that an import brought platform code into it.
const MAXIMUM_SCRIPT_BYTES = 96 * 1024;

const [operation, environment = "production", ...extra] = process.argv.slice(2);
if (operation !== "check" && operation !== "deploy")
  throw new Error("Select check or deploy");
if (extra.length > 0)
  throw new Error("Options are forbidden; edit the named Wrangler profile");

const config = readChatGptExitEnvironment(environment);
console.log(`${operation}: ${config.name} (${environment})`);

// The dry run also builds the container image.
checkAndDeploy({
  operation,
  environment,
  profile: "wrangler.chatgpt-exit.jsonc",
  prefix: "satyr-chatgpt-exit-",
  check: requireSmallScript.bind(null, "chatgpt-exit", MAXIMUM_SCRIPT_BYTES),
});
