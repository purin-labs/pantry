// Shared by check-d1-schema.mjs and repair-local-d1.mjs: one D1 statement or
// file through Wrangler, against the local, staging or production database of
// a Worker profile.
import { spawnSync } from "node:child_process";

import { workerDirectory } from "./worker-environment.mjs";

/** The rows of one statement. */
export function d1Rows(target, binding, query) {
  const result = wrangler(target, binding, ["--json", "--command", query]);
  const start = result.indexOf("[");
  const parsed = JSON.parse(result.slice(start));
  const rows = parsed[0]?.results;
  if (!Array.isArray(rows) || parsed[0]?.success !== true)
    throw new Error(`wrangler returned no rows for ${binding}`);
  return rows;
}

/** Runs a statement or a file; the result says if D1 refused it. */
export function d1Execute(target, binding, { command, file }) {
  try {
    wrangler(
      target,
      binding,
      command === undefined ? ["--file", file] : ["--command", command],
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error.message ?? error) };
  }
}

/**
 * target: { service, environment, persistTo? }. persistTo applies only to the
 * local profile.
 */
function wrangler({ service, environment, persistTo }, binding, args) {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      binding,
      "--env",
      environment,
      environment === "local" ? "--local" : "--remote",
      ...(environment === "local" && persistTo !== undefined
        ? ["--persist-to", persistTo]
        : []),
      ...args,
    ],
    {
      cwd: workerDirectory(service),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `wrangler could not run on ${binding}: ${result.stderr || result.stdout}`.slice(
        0,
        2000,
      ),
    );
  return result.stdout;
}
