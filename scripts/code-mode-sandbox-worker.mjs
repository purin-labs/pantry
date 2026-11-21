import { readdirSync } from "node:fs";
import { readCodeModeSandboxEnvironment } from "./worker-environment.mjs";
import {
  checkAndDeploy,
  isUploadedModule,
  isWasmModule,
} from "./lib/side-worker.mjs";

// The sandbox Worker runs the QuickJS VM of a Pi Code Mode script. The
// platform Worker binds its class by name, so this Worker deploys first: a
// platform deployment that names a missing Worker fails.

const [operation, environment = "production", ...extra] = process.argv.slice(2);
if (operation !== "check" && operation !== "deploy")
  throw new Error("Select check or deploy");
if (extra.length > 0)
  throw new Error("Options are forbidden; edit the named Wrangler profile");

const config = readCodeModeSandboxEnvironment(environment);
console.log(`${operation}: ${config.name} (${environment})`);

checkAndDeploy({
  operation,
  environment,
  profile: "wrangler.code-mode-sandbox.jsonc",
  prefix: "pantry-code-sandbox-",
  check: requireSandboxScript,
});

/**
 * The script holds the Worker module and one Wasm module, the QuickJS VM. A
 * second Wasm module means that an import brought platform code into it.
 */
function requireSandboxScript(bundle) {
  const modules = readdirSync(bundle).filter(isUploadedModule);
  const wasm = modules.filter(isWasmModule);
  if (wasm.length !== 1 || !wasm[0].endsWith("-quickjs.wasm"))
    throw new Error(
      `code-mode-sandbox: the script must hold the QuickJS module only; found ${wasm.join(", ") || "no Wasm module"}`,
    );
  console.log(`check: script holds ${modules.length} module(s) with QuickJS`);
}
