import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { readWorkerEnvironment } from "./worker-environment.mjs";

const root = resolve(import.meta.dirname, "..");
const platformPath = resolve(root, "workers/platform/.dev.vars.local");
const commercePath = resolve(root, "services/commerce/.dev.vars.local");
const platformConfig = readWorkerEnvironment("platform", "local");
const secretsStoreId = platformConfig.secrets_store_secrets[0].store_id;
const localSecrets = platformConfig.secrets_store_secrets.map(secretName);

function secretName(binding) {
  return binding.secret_name;
}

const platform = await readEnvironmentFile(platformPath);
const commerceEngine = await readEnvironmentFile(commercePath);
const platformToken = readEnvironmentValue(
  platform,
  "COMMERCE_SERVICE_TOKEN",
);
const commerceToken = readEnvironmentValue(
  commerceEngine,
  "COMMERCE_SERVICE_TOKEN",
);

if (
  platformToken !== undefined &&
  commerceToken !== undefined &&
  platformToken !== commerceToken
) {
  throw new Error(
    "Platform and Commerce already have different local service tokens",
  );
}

const serviceToken = commerceToken ?? platformToken ?? randomSecret();
let nextPlatform = upsertEnvironmentValue(
  platform,
  "COMMERCE_SERVICE_TOKEN",
  serviceToken,
);
nextPlatform = ensureEnvironmentValue(
  nextPlatform,
  "SESSION_TOKEN_SECRET",
  randomSecret,
);
nextPlatform = ensureEnvironmentValue(
  nextPlatform,
  "SLACK_OAUTH_STATE_SECRET",
  randomSecret,
);
let nextCommerce = upsertEnvironmentValue(
  commerceEngine,
  "COMMERCE_SERVICE_TOKEN",
  serviceToken,
);
nextCommerce = ensureEnvironmentValue(
  nextCommerce,
  "COMMERCE_BUYER_SESSION_SECRET",
  randomSecret,
);
nextCommerce = ensureEnvironmentValue(
  nextCommerce,
  "COMMERCE_SIGNING_PRIVATE_KEY_PKCS8_B64",
  generateSigningKey,
);
nextCommerce = ensureEnvironmentValue(
  nextCommerce,
  "JAPAN_CARRIER_SIGNING_KEY",
  randomSecret,
);

await Promise.all([
  writeEnvironmentFile(platformPath, nextPlatform),
  writeEnvironmentFile(commercePath, nextCommerce),
]);
ensureLocalSecretsStore();

console.log("Local Platform and Commerce secrets are ready.");

function ensureLocalSecretsStore() {
  const listed = runSecretsStoreCommand(["secret", "list", secretsStoreId]);
  const existing = `${listed.stdout}\n${listed.stderr}`;
  // Wrangler reports a store with no secret as a failed list. That is the
  // state of a new local persistence directory.
  if (
    listed.status !== 0 &&
    !existing.includes("List request returned no secrets")
  )
    throw new Error(
      "Could not inspect local Secrets Store; existing roots were left unchanged",
    );
  for (const name of localSecrets) {
    if (existing.includes(name)) continue;
    const created = runSecretsStoreCommand([
      "secret",
      "create",
      secretsStoreId,
      "--name",
      name,
      "--scopes",
      "workers",
      "--value",
      randomBytes(32).toString("base64"),
    ]);
    if (created.status !== 0) {
      throw new Error(
        `Could not create local Secrets Store secret ${name}: ${created.stderr}`,
      );
    }
  }
}

function runSecretsStoreCommand(args) {
  return spawnSync(
    "pnpm",
    [
      "--filter",
      "@purin-labs/platform",
      "exec",
      "wrangler",
      "secrets-store",
      ...args,
      "--remote=false",
      "--persist-to",
      ".wrangler/square-acceptance",
    ],
    { cwd: root, env: process.env, encoding: "utf8" },
  );
}

async function readEnvironmentFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "";
    throw error;
  }
}

function readEnvironmentValue(contents, key) {
  const value = parseEnv(contents)[key];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function ensureEnvironmentValue(contents, key, createValue) {
  return readEnvironmentValue(contents, key) === undefined
    ? upsertEnvironmentValue(contents, key, createValue())
    : contents;
}

function upsertEnvironmentValue(contents, key, value) {
  const lines =
    contents.length === 0 ? [] : contents.replace(/\n$/u, "").split(/\r?\n/u);
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index === -1) lines.push(`${key}=${value}`);
  else lines[index] = `${key}=${value}`;
  return `${lines.join("\n")}\n`;
}

function randomSecret() {
  return randomBytes(32).toString("base64url");
}

function generateSigningKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey
    .export({ type: "pkcs8", format: "der" })
    .toString("base64url");
}

async function writeEnvironmentFile(path, contents) {
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}
