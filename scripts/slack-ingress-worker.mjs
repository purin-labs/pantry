import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readSlackIngressEnvironment,
  workerDeployArguments,
} from "./worker-environment.mjs";

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
const directory = resolve(import.meta.dirname, "../services/platform");
const target = ["--config", "wrangler.slack-ingress.jsonc"];
console.log(`${operation}: ${config.name} (${environment})`);

const bundle = mkdtempSync(join(tmpdir(), "satyr-slack-ingress-"));
try {
  wrangler([
    ...workerDeployArguments(environment),
    ...target,
    "--dry-run",
    "--outdir",
    bundle,
  ]);
  requireSmallScript(bundle);
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

function requireSmallScript(bundle) {
  const modules = readdirSync(bundle).filter(isUploadedModule);
  const wasm = modules.filter(isWasmModule);
  if (wasm.length > 0)
    throw new Error(
      `slack-ingress: the script holds a Wasm module (${wasm.join(", ")}); an import brought platform code into it`,
    );
  const bytes = modules.reduce(addModuleBytes, 0);
  if (bytes > MAXIMUM_SCRIPT_BYTES)
    throw new Error(
      `slack-ingress: the script is ${bytes} bytes; the limit is ${MAXIMUM_SCRIPT_BYTES}`,
    );
  console.log(`check: script is ${bytes} bytes in ${modules.length} module(s)`);

  function addModuleBytes(total, name) {
    return total + statSync(join(bundle, name)).size;
  }
}

function isUploadedModule(name) {
  return !name.endsWith(".map") && name !== "README.md";
}

function isWasmModule(name) {
  return name.endsWith(".wasm");
}
