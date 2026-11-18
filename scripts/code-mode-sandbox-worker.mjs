import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readCodeModeSandboxEnvironment,
  workerDeployArguments,
} from "./worker-environment.mjs";

// The sandbox Worker runs the QuickJS VM of a Pi Code Mode script. The
// platform Worker binds its class by name, so this Worker deploys first: a
// platform deployment that names a missing Worker fails.

const [operation, environment = "production", ...extra] = process.argv.slice(2);
if (operation !== "check" && operation !== "deploy")
  throw new Error("Select check or deploy");
if (extra.length > 0)
  throw new Error("Options are forbidden; edit the named Wrangler profile");

const config = readCodeModeSandboxEnvironment(environment);
const directory = resolve(import.meta.dirname, "../services/platform");
const target = ["--config", "wrangler.code-mode-sandbox.jsonc"];
console.log(`${operation}: ${config.name} (${environment})`);

const bundle = mkdtempSync(join(tmpdir(), "satyr-code-mode-sandbox-"));
try {
  wrangler([
    ...workerDeployArguments(environment),
    ...target,
    "--dry-run",
    "--outdir",
    bundle,
  ]);
  requireSandboxScript(bundle);
} finally {
  rmSync(bundle, { recursive: true, force: true });
}
if (operation === "deploy")
  wrangler([...workerDeployArguments(environment), ...target]);

function wrangler(args) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: directory,
    stdio: "inherit",
    env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

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

function isUploadedModule(name) {
  return !name.endsWith(".map") && name !== "README.md";
}

function isWasmModule(name) {
  return name.endsWith(".wasm");
}
