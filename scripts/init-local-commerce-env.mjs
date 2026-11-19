import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { readWorkerEnvironment } from "./worker-environment.mjs";

const root = resolve(import.meta.dirname, "..");
const platformPath = resolve(root, "services/platform/.dev.vars.local");
const commercePath = resolve(root, "services/commerce/.dev.vars.local");
// The values that the local account Worker needs to answer this Platform.
// The account Worker runs from the Seams checkout and reads its .env.local.
const accountPlatformPath = resolve(
  root,
  "services/platform/.dev.vars.local.account-platform",
);
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
  "UNDERCLERK_SERVICE_TOKEN",
);
const commerceToken = readEnvironmentValue(
  commerceEngine,
  "UNDERCLERK_SERVICE_TOKEN",
);

if (
  platformToken !== undefined &&
  commerceToken !== undefined &&
  platformToken !== commerceToken
) {
  throw new Error(
    "Platform and Underclerk already have different local service tokens",
  );
}

const serviceToken = commerceToken ?? platformToken ?? randomSecret();
let nextPlatform = upsertEnvironmentValue(
  platform,
  "UNDERCLERK_SERVICE_TOKEN",
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
nextPlatform = ensureEnvironmentValue(
  nextPlatform,
  "ACCOUNT_PLATFORM_PROVISION_TOKEN",
  randomSecret,
);
nextPlatform = ensureEnvironmentValue(
  nextPlatform,
  "ACCOUNT_PLATFORM_USER_ASSERTION_PKCS8_B64U",
  generateSigningKey,
);
// The account Worker signs each provision of an Organisation and holds the
// private key. The Platform keeps the public half.
const accountPlatform = await readEnvironmentFile(accountPlatformPath);
const provisionPrivateJwk =
  readEnvironmentValue(
    accountPlatform,
    "ACCOUNT_PROVISION_ASSERTION_PRIVATE_JWK_JSON",
  ) ?? JSON.stringify(generateSigningJwk());
nextPlatform = upsertEnvironmentValue(
  nextPlatform,
  "ACCOUNT_PLATFORM_PROVISION_ASSERTION_JWK",
  quoted(JSON.stringify(publicJwk(JSON.parse(provisionPrivateJwk)))),
);
const accountPlatformValues = accountPlatformEnvironment({
  vars: platformConfig.vars,
  provisionToken: requireEnvironmentValue(
    nextPlatform,
    "ACCOUNT_PLATFORM_PROVISION_TOKEN",
  ),
  userAssertionPkcs8: requireEnvironmentValue(
    nextPlatform,
    "ACCOUNT_PLATFORM_USER_ASSERTION_PKCS8_B64U",
  ),
  provisionPrivateJwk,
  invitationSecretKey:
    readEnvironmentValue(
      accountPlatform,
      "CONSOLE_EMAIL_INVITATION_SECRET_KEY_B64U",
    ) ?? randomSecret(),
});
let nextCommerce = upsertEnvironmentValue(
  commerceEngine,
  "UNDERCLERK_SERVICE_TOKEN",
  serviceToken,
);
nextCommerce = ensureEnvironmentValue(
  nextCommerce,
  "UNDERCLERK_BUYER_SESSION_SECRET",
  randomSecret,
);
nextCommerce = ensureEnvironmentValue(
  nextCommerce,
  "UNDERCLERK_SIGNING_PRIVATE_KEY_PKCS8_B64",
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
  writeEnvironmentFile(
    accountPlatformPath,
    upsertEnvironmentValues("", accountPlatformValues),
  ),
]);
await pairAccountPlatform();
ensureLocalSecretsStore();

console.log("Local Platform and Underclerk secrets are ready.");

/**
 * Gives the local account Worker the values that match this Platform. The
 * Worker is `seams-sdk-d1-local` of the Seams checkout, which reads the
 * .env.local of that checkout. Other lines of that file are kept.
 */
async function pairAccountPlatform() {
  const seamsRoot = process.env.SEAMS_MONOREPO_ROOT?.trim();
  if (!seamsRoot) {
    console.log(
      "Account Worker values are in services/platform/.dev.vars.local.account-platform. " +
        "Set SEAMS_MONOREPO_ROOT to the Seams checkout and run pnpm local:init again to install them.",
    );
    return;
  }
  const checkout = resolve(seamsRoot);
  if (!existsSync(resolve(checkout, "packages/wallet-console-server-ts")))
    throw new Error("SEAMS_MONOREPO_ROOT is not a Seams checkout");
  const path = resolve(checkout, ".env.local");
  await writeEnvironmentFile(
    path,
    upsertEnvironmentValues(
      await readEnvironmentFile(path),
      accountPlatformValues,
    ),
  );
  console.log(
    "The local account Worker values are installed in the Seams checkout. Restart its local Workers.",
  );
}

/** The account Worker's side of each value that the two Workers share. */
function accountPlatformEnvironment(input) {
  const { vars } = input;
  const placement = JSON.parse(vars.PANTRY_ORGANISATION_PLACEMENT_PROFILE);
  const userKey = createPrivateKey({
    key: Buffer.from(input.userAssertionPkcs8, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  return {
    PANTRY_DEPLOYMENT_ID: vars.ACCOUNT_PLATFORM_DEPLOYMENT_ID,
    PANTRY_ACCOUNT_ASSERTION_ISSUER: vars.ACCOUNT_PLATFORM_ASSERTION_ISSUER,
    PANTRY_ACCOUNT_ASSERTION_AUDIENCE: vars.ACCOUNT_PLATFORM_ASSERTION_AUDIENCE,
    PANTRY_ACCOUNT_USER_ASSERTION_KEY_ID:
      vars.ACCOUNT_PLATFORM_USER_ASSERTION_KEY_ID,
    PANTRY_ACCOUNT_USER_ASSERTION_PUBLIC_JWK_JSON: quoted(
      JSON.stringify(createPublicKey(userKey).export({ format: "jwk" })),
    ),
    PANTRY_GOOGLE_OIDC_CLIENT_ID: vars.GOOGLE_OIDC_CLIENT_ID,
    // The account Worker sends each provision to the Platform Worker itself.
    PANTRY_SERVICE_ORIGIN: `http://127.0.0.1:${String(platformConfig.dev.port)}`,
    PANTRY_PROVISION_PLACEMENT_CELL_ID: placement.placementCellId,
    PANTRY_PROVISION_ENVIRONMENT: "development",
    PANTRY_PROVISION_TOKEN: input.provisionToken,
    ACCOUNT_PROVISION_ASSERTION_ISSUER:
      vars.ACCOUNT_PLATFORM_PROVISION_ASSERTION_ISSUER,
    ACCOUNT_PROVISION_ASSERTION_AUDIENCE:
      vars.ACCOUNT_PLATFORM_PROVISION_ASSERTION_AUDIENCE,
    ACCOUNT_PROVISION_ASSERTION_KEY_ID:
      vars.ACCOUNT_PLATFORM_PROVISION_ASSERTION_KEY_ID,
    ACCOUNT_PROVISION_ASSERTION_PRIVATE_JWK_JSON: quoted(
      input.provisionPrivateJwk,
    ),
    // The private entry point of the account Worker builds its invitation
    // mail service for each request. It keeps the mail and sends none.
    CONSOLE_EMAIL_RUNTIME_PROFILE: "DEVELOPMENT",
    CONSOLE_EMAIL_PROVIDER: "CAPTURE",
    CONSOLE_EMAIL_INVITATION_SECRET_KEY_ID: "satyr-local-invitation-v1",
    CONSOLE_EMAIL_INVITATION_SECRET_KEY_B64U: input.invitationSecretKey,
  };
}

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

function requireEnvironmentValue(contents, key) {
  const value = readEnvironmentValue(contents, key);
  if (value === undefined) throw new Error(`Local value ${key} is missing`);
  return value;
}

function upsertEnvironmentValues(contents, values) {
  let next = contents;
  for (const [key, value] of Object.entries(values))
    next = upsertEnvironmentValue(next, key, value);
  return next;
}

/** A JSON value as one line of an environment file. */
function quoted(json) {
  return `'${json}'`;
}

function generateSigningJwk() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "jwk" });
}

function publicJwk(privateJwk) {
  return { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x };
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
