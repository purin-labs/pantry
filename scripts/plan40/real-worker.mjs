import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "../../packages/std/src/index.ts";
import { singleDatabaseMigrations } from "../../workers/platform/scripts/single-database-schema.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const port = readPort(process.env.PLAN40_PORT ?? "31840", "PLAN40_PORT");
const commercePort = readPort(process.env.PLAN40_COMMERCE_PORT ?? "3102", "PLAN40_COMMERCE_PORT");
const inspectorPort = readPort(process.env.PLAN40_INSPECTOR_PORT ?? "32940", "PLAN40_INSPECTOR_PORT");
const commerceInspectorPort = readPort(process.env.PLAN40_COMMERCE_INSPECTOR_PORT ?? "32941", "PLAN40_COMMERCE_INSPECTOR_PORT");
const origin = `http://127.0.0.1:${port}`;
const commerceOrigin = `http://127.0.0.1:${commercePort}`;
const setupToken = "plan40-local-setup-token";
const runId = `${Date.now()}-${process.pid}`;
const workerServiceName = `pantry-plan40-${runId}`;
const commerceServiceName = `commerce-plan40-${runId}`;
const stateDirectory = join("/private/tmp", `pantry-plan40-real-worker-${runId}`);
const commerceStateDirectory = join("/private/tmp", `pantry-plan40-commerce-${runId}`);
const generatedDirectory = await mkdtemp(join(tmpdir(), "pantry-plan40-real-worker-build-"));
const generatedConfig = join(generatedDirectory, "wrangler.jsonc");
const generatedCommerceConfig = join(generatedDirectory, "commerce.wrangler.jsonc");
const commerceAssetsDirectory = await mkdtemp(join(generatedDirectory, "commerce-assets-"));
const commerceEnvFile = join(generatedDirectory, ".dev.vars.local");
let workerProcess;
let commerceProcess;

try {
  await writeWranglerConfig(generatedConfig, resolve(scriptDirectory, "real-worker.ts"));
  await writeCommerceConfig(generatedCommerceConfig);
  const commerceEnvironment = await writeCommerceEnvironment(commerceEnvFile);
  commerceProcess = spawn(
    resolve(repositoryRoot, "services/commerce/node_modules/.bin/wrangler"),
    ["dev", "--local", "--env", "local",
      "--config", generatedCommerceConfig,
      "--persist-to", commerceStateDirectory, "--port", String(commercePort),
      "--inspector-port", String(commerceInspectorPort), "--enable-containers=false", "--ip", "127.0.0.1"],
    { cwd: resolve(repositoryRoot, "services/commerce"), stdio: "inherit", env: { ...process.env, ...commerceEnvironment, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" } },
  );
  await waitForWorker(commerceProcess, commerceOrigin);
  await initializeDatabase(generatedConfig);
  workerProcess = spawn(
    "pnpm",
    ["--filter", "@purin-labs/platform", "exec", "wrangler", "dev", "--local", "--config", generatedConfig,
      "--persist-to", stateDirectory, "--port", String(port), "--inspector-port", String(inspectorPort),
      "--enable-containers=false", "--ip", "127.0.0.1"],
    { cwd: repositoryRoot, stdio: "inherit", env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" } },
  );
  await waitForWorker(workerProcess, origin);
  const setup = await fetch(`${origin}/__plan40/setup`, {
    method: "POST",
    headers: { "x-plan40-setup-token": setupToken },
  });
  const setupText = await setup.text();
  if (!setup.ok) throw new Error(`Plan 40 setup failed (${setup.status}): ${setupText}`);
  console.log(`Plan 40 real Worker ready at ${origin}`);
  console.log(`${origin}/__plan40/demo/owner`);
  console.log(`${origin}/__plan40/demo/editor`);
  await waitForExit(workerProcess);
} finally {
  if (workerProcess !== undefined && workerProcess.exitCode === null) workerProcess.kill("SIGTERM");
  if (commerceProcess !== undefined && commerceProcess.exitCode === null) commerceProcess.kill("SIGTERM");
  await rm(generatedDirectory, { recursive: true, force: true });
}

async function writeWranglerConfig(outfile, workerEntry) {
  const source = await readFile(resolve(scriptDirectory, "real-worker.wrangler.jsonc"), "utf8");
  const rewritten = source
    .replace('"name": "pantry-plan40-browser"', `"name": ${JSON.stringify(workerServiceName)}`)
    .replace('"main": "./real-worker.ts"', `"main": ${JSON.stringify(workerEntry)}`)
    .replace('"directory": "../../apps/portal/dist"', `"directory": ${JSON.stringify(resolve(repositoryRoot, "apps/portal/dist"))}`)
    .replace('"service": "pantry-commerce"', `"service": ${JSON.stringify(commerceServiceName)}`)
    .replaceAll("http://127.0.0.1:31840", origin)
    .replaceAll("http://127.0.0.1:3102", commerceOrigin);
  await writeFile(outfile, rewritten);
}

async function writeCommerceConfig(outfile) {
  const source = await readFile(resolve(repositoryRoot, "services/commerce/wrangler.jsonc"), "utf8");
  const workerEntry = resolve(repositoryRoot, "services/commerce/src/worker.ts");
  const expectedValues = [
    '"main": "src/worker.ts"',
    '"name": "pantry-commerce"',
    '"directory": "../../apps/storefront/dist"',
    '"service": "pantry"',
  ];
  if (hasMissingConfigValue(source, expectedValues)) {
    throw new Error("Commerce Wrangler config no longer matches the Plan 40 harness boundary");
  }
  const rewritten = source
    .replace('"main": "src/worker.ts"', `"main": ${JSON.stringify(workerEntry)}`)
    .replace('"name": "pantry-commerce"', `"name": ${JSON.stringify(commerceServiceName)}`)
    .replace('"directory": "../../apps/storefront/dist"', `"directory": ${JSON.stringify(commerceAssetsDirectory)}`)
    .replace('"service": "pantry"', `"service": ${JSON.stringify(workerServiceName)}`);
  await writeFile(outfile, rewritten);
}

function hasMissingConfigValue(source, expectedValues) {
  for (const value of expectedValues) {
    if (!source.includes(value)) return true;
  }
  return false;
}

async function writeCommerceEnvironment(outfile) {
  const keyPair = generateKeyPairSync("ed25519");
  const signingPrivateKey = keyPair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const environment = {
    COMMERCE_SERVICE_TOKEN: "plan40-browser-commerce-token",
    COMMERCE_BUYER_SESSION_SECRET: randomBytes(32).toString("base64url"),
    COMMERCE_SIGNING_PRIVATE_KEY_PKCS8_B64: signingPrivateKey,
    JAPAN_CARRIER_SIGNING_KEY: randomBytes(32).toString("base64url"),
  };
  const contents = `${Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
  await writeFile(outfile, contents);
  return environment;
}

async function initializeDatabase(configPath) {
  const result = spawnSync(
    "pnpm",
    ["--filter", "@purin-labs/platform", "exec", "wrangler", "d1", "execute", "pantry-plan40-browser", "--local",
      "--file", join(singleDatabaseMigrations(), "0001_current_schema.sql"),
      "--persist-to", stateDirectory, "--config", configPath],
    { cwd: repositoryRoot, stdio: "inherit", env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" } },
  );
  if (result.status !== 0) throw new Error(`D1 initialization failed with status ${String(result.status)}`);
}

async function waitForWorker(child, workerOrigin) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited before startup (${String(child.exitCode)})`);
    try {
      const response = await fetch(`${workerOrigin}/health`);
      if (response.status < 500) return;
    } catch {
      // The local server is still compiling.
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for the disposable Worker");
}

function waitForExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("exit", resolveExit);
    child.once("error", rejectExit);
  });
}

function readPort(value, name) {
  const portValue = Number(value);
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return portValue;
}
