import { readModelExitEnvironment } from "./worker-environment.mjs";
import { checkAndDeploy, requireSmallScript } from "./lib/side-worker.mjs";

// The model exit Worker sends each direct model-provider request of the
// platform Worker from a data centre near AWS Tokyo (Plan 73). The platform
// Worker binds it by name, so this Worker deploys first: a platform
// deployment that names a missing Worker fails.

// The Worker forwards requests and nothing else. A larger script means that
// an import brought platform code into it.
const MAXIMUM_SCRIPT_BYTES = 64 * 1024;

const [operation, environment = "production", ...extra] = process.argv.slice(2);
if (operation !== "check" && operation !== "deploy")
  throw new Error("Select check or deploy");
if (extra.length > 0)
  throw new Error("Options are forbidden; edit the named Wrangler profile");

const config = readModelExitEnvironment(environment);
console.log(`${operation}: ${config.name} (${environment})`);

checkAndDeploy({
  operation,
  environment,
  profile: "wrangler.model-exit.jsonc",
  prefix: "satyr-model-exit-",
  check: requireSmallScript.bind(null, "model-exit", MAXIMUM_SCRIPT_BYTES),
});
