import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  isResourceCreationOption,
  readChatGptExitEnvironment,
  readCodeModeSandboxEnvironment,
  readModelExitEnvironment,
  readWorkerEnvironment,
  requireLocalWorkerSecrets,
  validateWorkerOrigins,
  workerDeployArguments,
  workerDirectory,
} from "./worker-environment.mjs";
import { requireGatewayBuilds } from "../services/shop-gateway/check-pack.mjs";
import { requirePhysicsBundles } from "./check-physics-dist.mjs";

const [service, operation, environment, ...extra] = process.argv.slice(2);
const config = readWorkerEnvironment(service, environment);
validateWorkerOrigins(service, environment, config);
if (operation === "dev") {
  requireLocalWorkerSecrets(service, config);
}
if (!["dev", "deploy", "types", "migrate", "schema"].includes(operation)) {
  throw new Error("Unknown Worker operation");
}
if (operation === "dev" && environment !== "local") {
  throw new Error("Development requires local");
}
if (operation === "deploy" && environment === "local") {
  throw new Error("Deployment requires production");
}
if (operation !== "dev" && extra.some(isContainerOption)) {
  throw new Error("Container availability is a local development option");
}
if (extra.some(isResourceCreationOption)) {
  throw new Error(
    "Automatic resource creation is forbidden; create the resource and name it in the Wrangler profile",
  );
}
if (extra.some(isTargetOverride)) {
  throw new Error(
    "Target overrides are forbidden; edit the named Wrangler profile",
  );
}
const root = resolve(import.meta.dirname, "..");
// A Portal build without the shop gateway builds ships an installer that fails
// on every shop computer, so a production upload refuses it (Plan 85). A
// Portal build without a Kitchen physics bundle of a manifest, or with a
// changed file, cannot resume a saved run, so the upload refuses it too
// (Refactor 16, step 9B).
if (
  service === "platform" &&
  operation === "deploy" &&
  environment === "production" &&
  !extra.includes("--dry-run")
) {
  requireGatewayBuilds(resolve(root, "apps/portal/dist/shop-gateway"));
  await requirePhysicsBundles(resolve(root, "apps/portal/dist"));
}
const persistence = ".wrangler/square-acceptance";
let commands;
switch (operation) {
  case "dev":
    commands = [
      [
        "dev",
        "--local",
        "--env",
        environment,
        "--persist-to",
        persistence,
        ...boundWorkerDevelopmentConfigs(),
      ],
    ];
    break;
  case "migrate":
    if (environment !== "local") {
      throw new Error("Migrations require local");
    }
    commands = config.d1_databases.map(databaseMigrationCommand);
    break;
  case "schema":
    // check-d1-schema.mjs compares each bound database with its baseline.
    commands = [];
    break;
  case "deploy":
    commands = [workerDeployArguments(environment)];
    break;
  default:
    commands = [[operation, "--env", environment]];
}
console.log(`${operation}: ${config.name} (${environment})`);
if (operation === "schema") {
  const check = spawnSync(
    process.execPath,
    [resolve(root, "scripts/check-d1-schema.mjs"), service, environment],
    { cwd: root, stdio: "inherit" },
  );
  if (check.error) throw check.error;
  process.exitCode = check.status ?? 1;
}
for (const args of commands) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args, ...extra], {
    cwd: workerDirectory(service),
    stdio: "inherit",
    env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}

/**
 * The platform Worker binds the class of the Code Mode sandbox Worker, the
 * model exit Worker and the ChatGPT exit Worker by name. Local development
 * runs the four Workers in one process: the first configuration is the Worker
 * that answers requests. Without the ChatGPT exit Worker, every turn on the
 * ChatGPT subscription route fails with a 503.
 */
function boundWorkerDevelopmentConfigs() {
  if (service !== "platform") return [];
  readCodeModeSandboxEnvironment(environment);
  readModelExitEnvironment(environment);
  readChatGptExitEnvironment(environment);
  return [
    "--config",
    "wrangler.jsonc",
    "--config",
    "wrangler.code-mode-sandbox.jsonc",
    "--config",
    "wrangler.model-exit.jsonc",
    "--config",
    "wrangler.chatgpt-exit.jsonc",
  ];
}

function databaseMigrationCommand(database) {
  return [
    "d1",
    "migrations",
    "apply",
    database.binding,
    "--env",
    environment,
    environment === "local" ? "--local" : "--remote",
    ...(environment === "local" ? ["--persist-to", persistence] : []),
  ];
}

function isTargetOverride(argument) {
  return /^--?(env|e|name|config|c|var|remote|env-file|persist-to|port|ip|inspector-port)(=|$)/u.test(
    argument,
  );
}

function isContainerOption(argument) {
  return /^--enable-containers(=|$)/u.test(argument);
}
