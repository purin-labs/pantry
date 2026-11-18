import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { clearLocalPorts } from "./local-process-runner.mjs";

const CADDY_PORTS = [2019, 3001, 3002, 3003, 3004, 3005];

export function createLocalProxyProcess(root) {
  const caddyfile = resolve(root, "Caddyfile");
  const caddy = readCaddyPath();
  runCaddy(caddy, ["validate", "--config", caddyfile]);
  clearLocalPorts(CADDY_PORTS);
  return {
    name: "caddy",
    headerColor: "33",
    lifecycle: "persistent",
    readyPattern: /serving initial configuration/u,
    command: caddy,
    args: ["run", "--config", caddyfile],
  };
}

function readCaddyPath() {
  const result = spawnSync("which", ["caddy"], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status === 0 && result.stdout.trim().length > 0)
    return result.stdout.trim();
  throw new Error("Caddy was not found; install it with `brew install caddy`");
}

function runCaddy(caddy, args) {
  const result = spawnSync(caddy, args, { encoding: "utf8", env: process.env });
  requireSuccessfulCommand(result, `run caddy ${args[0]}`);
}

function requireSuccessfulCommand(result, action) {
  if (result.error !== undefined) throw result.error;
  if (result.status === 0) return;
  const details = String(result.stderr || "").trim();
  throw new Error(
    `${action} failed${details.length > 0 ? `: ${details}` : ""}`,
  );
}
