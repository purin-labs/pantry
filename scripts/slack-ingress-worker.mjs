import { readSlackIngressEnvironment } from "./worker-environment.mjs";
import { checkAndDeploy, requireSmallScript } from "./lib/side-worker.mjs";

// A new isolate loads the whole script before it answers. The ingress Worker
// exists to be small, so an import that brings platform code into it removes
// its purpose. The platform Worker's own script holds two Wasm modules.
const MAXIMUM_SCRIPT_BYTES = 256 * 1024;

const environment = "production";
const [operation, ...extra] = process.argv.slice(2);
if (operation !== "check" && operation !== "deploy")
  throw new Error("Select check or deploy");
if (extra.length > 0)
  throw new Error("Options are forbidden; edit the named Wrangler profile");

const config = readSlackIngressEnvironment(environment);
console.log(`${operation}: ${config.name} (${environment})`);

checkAndDeploy({
  operation,
  environment,
  profile: "wrangler.slack-ingress.jsonc",
  prefix: "satyr-slack-ingress-",
  check: requireSmallScript.bind(null, "slack-ingress", MAXIMUM_SCRIPT_BYTES),
});
