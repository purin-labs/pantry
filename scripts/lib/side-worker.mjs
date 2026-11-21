// The check and deploy of a small Worker beside the platform Worker: the
// Slack ingress, model exit, ChatGPT exit, Code Mode sandbox and 1Password
// store Workers. Wrangler builds each one from services/platform, with the
// Wrangler profile that the script names.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import {
  requireReleaseTarget,
  workerDeployArguments,
} from "../worker-environment.mjs";

export const platformDirectory = resolve(
  import.meta.dirname,
  "../../services/platform",
);

/** Runs Wrangler in services/platform. A failure ends the process. */
function wrangler(args) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: platformDirectory,
    stdio: "inherit",
    env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/**
 * Builds the Worker of the Wrangler profile `profile` with a dry run into a
 * new temporary directory named from `prefix`, and checks the bundle with
 * `check`. With the "deploy" operation, it then deploys the Worker.
 */
export function checkAndDeploy({
  operation,
  environment,
  profile,
  prefix,
  check,
}) {
  const target = ["--config", profile];
  const bundle = mkdtempSync(join(tmpdir(), prefix));
  try {
    wrangler([
      ...workerDeployArguments(environment),
      ...target,
      "--dry-run",
      "--outdir",
      bundle,
    ]);
    check(bundle);
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
  if (operation === "deploy") {
    const { unstable_readConfig } = createRequire(
      join(platformDirectory, "package.json"),
    )("wrangler");
    requireReleaseTarget(
      unstable_readConfig({
        config: join(platformDirectory, profile),
        env: environment,
      }),
    );
    wrangler([...workerDeployArguments(environment), ...target]);
  }
}

export function isUploadedModule(name) {
  return !name.endsWith(".map") && name !== "README.md";
}

export function isWasmModule(name) {
  return name.endsWith(".wasm");
}

/**
 * Refuses a script that holds a Wasm module or that has more than
 * `maximumBytes`: an import brought platform code into it. `label` starts
 * each message.
 */
export function requireSmallScript(label, maximumBytes, bundle) {
  const modules = readdirSync(bundle).filter(isUploadedModule);
  const wasm = modules.filter(isWasmModule);
  if (wasm.length > 0) {
    throw new Error(
      `${label}: the script holds a Wasm module (${wasm.join(", ")}); an import brought platform code into it`,
    );
  }
  const bytes = modules.reduce(addModuleBytes, 0);
  if (bytes > maximumBytes) {
    throw new Error(
      `${label}: the script is ${bytes} bytes; the limit is ${maximumBytes}`,
    );
  }
  console.log(`check: script is ${bytes} bytes in ${modules.length} module(s)`);

  function addModuleBytes(total, name) {
    return total + statSync(join(bundle, name)).size;
  }
}
