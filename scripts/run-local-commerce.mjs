import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  readWorkerEnvironment,
  requireLocalWorkerSecrets,
  validateWorkerOrigins,
} from "./worker-environment.mjs";
import { clearLocalPorts, runLocalProcesses } from "./local-process-runner.mjs";

const root = resolve(import.meta.dirname, "..");
const options = process.argv.slice(2);
if (options.length > 1 || options.some(isUnsupportedOption)) {
  throw new Error("The backend only accepts --enable-containers=false");
}
const commands = [];
const ports = [];
const docker = dockerIsAvailable();
const containers = docker && options.length === 0;
for (const service of ["underclerk", "platform"]) {
  const config = readWorkerEnvironment(service, "local");
  validateWorkerOrigins(service, "local", config);
  requireLocalWorkerSecrets(service, config);
  ports.push(config.dev.port, config.dev.inspector_port);
  commands.push({
    name: service,
    headerColor: service === "platform" ? "35" : "36",
    lifecycle: "persistent",
    readyPattern: /Ready on/u,
    command: "node",
    args: [
      "scripts/run-worker.mjs",
      service,
      "dev",
      "local",
      ...(service === "platform" && !containers
        ? ["--enable-containers=false"]
        : []),
    ],
  });
}
if (!docker) {
  console.log(
    "Docker is unavailable; local container work is disabled. OAuth and commerce remain available.",
  );
}
// Stop the Workers of an earlier run first: the repair below changes the
// databases that they serve.
clearLocalPorts(ports);
// A local database keeps the schema of the day it was made: the baselines are
// edited in place and Wrangler never applies them again. On drift, apply the
// patch scripts that remove it. If drift stays, stop here and name the missing
// table, instead of serving 503 from routes that read it.
if (runScript("check-d1-schema.mjs", "platform", "local") !== 0) {
  console.log("Applying the D1 patch scripts to the local databases.");
  runScript("repair-local-d1.mjs", "platform");
  if (runScript("check-d1-schema.mjs", "platform", "local") !== 0) {
    console.error(
      "The local Platform databases do not match their baselines. Nothing started.",
    );
    process.exit(1);
  }
}
await runLocalProcesses(root, commands, "commerce").ready;
console.log(
  "Commerce Workers ready. Run pnpm site for https://localhost:3003 (Square Sandbox).",
);
// The Platform asks the account Worker on each Portal request. That Worker
// belongs to the Seams checkout and runs in its own process.
console.log(
  "The Portal also needs the local account Worker (seams-sdk-d1-local): run pnpm router in the Seams checkout.",
);

function runScript(script, ...args) {
  const result = spawnSync(
    process.execPath,
    [resolve(root, "scripts", script), ...args],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  return result.status;
}

function dockerIsAvailable() {
  const result = spawnSync(
    "docker",
    ["info", "--format", "{{.ServerVersion}}"],
    {
      encoding: "utf8",
    },
  );
  return result.status === 0 && result.stdout.trim().length > 0;
}

function isUnsupportedOption(option) {
  return option !== "--enable-containers=false";
}
