// The built shared account Worker as a second Worker of a trial Miniflare
// runtime. The account authority is not simulated: the trial Worker reaches
// it only through the ACCOUNT_PLATFORM service binding, as in production.
// The keys of a run are kept in its directory, so a restarted runtime still
// verifies the assertions and provisions of the first one.
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ACCOUNT_WORKER = "plan50-account-authority";
const ACCOUNT_ORIGIN = "https://account.shared-account.invalid";
const NATIVE_ORIGIN = "https://satyr.shared-account.invalid";

export function accountWorkerArtifact() {
  const artifact = process.env.PANTRY_ACCOUNT_WORKER_ARTIFACT;
  if (!artifact)
    throw new Error(
      "Set PANTRY_ACCOUNT_WORKER_ARTIFACT to the built shared account Worker.",
    );
  return resolve(artifact);
}

async function runKeys(directory) {
  const path = join(directory, "account-keys.json");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const assertion = generateKeyPairSync("ed25519");
  const provision = generateKeyPairSync("ed25519");
  const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keys = {
    assertionPublic: assertion.publicKey.export({ format: "jwk" }),
    assertionPkcs8: assertion.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64url"),
    provisionPublic: provision.publicKey.export({ format: "jwk" }),
    provisionPrivate: provision.privateKey.export({ format: "jwk" }),
    googlePublic: google.publicKey.export({ format: "jwk" }),
    googlePrivate: google.privateKey.export({ format: "jwk" }),
  };
  await mkdir(directory, { recursive: true });
  await writeFile(path, JSON.stringify(keys));
  return keys;
}

/**
 * The account Worker's options, and the bindings and service binding that
 * the trial Worker adds to its own. `directory` must outlive restarts.
 */
export async function accountAuthorityRuntime(directory) {
  const artifact = accountWorkerArtifact();
  const keys = await runKeys(directory);
  return {
    artifactSha256: createHash("sha256")
      .update(await readFile(artifact))
      .digest("hex"),
    worker: {
      name: ACCOUNT_WORKER,
      modulesRoot: dirname(artifact),
      modules: [{ type: "ESModule", path: artifact }],
      compatibilityDate: "2026-07-07",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { ACCOUNT_DB: "plan50-account-authority" },
      bindings: {
        FIXTURE_ASSERTION_PUBLIC_JWK: JSON.stringify(keys.assertionPublic),
        FIXTURE_GOOGLE_PRIVATE_JWK: JSON.stringify(keys.googlePrivate),
        FIXTURE_GOOGLE_PUBLIC_JWK: JSON.stringify(keys.googlePublic),
        FIXTURE_GOOGLE_CLIENT_ID: "shared-account-satyr-e2e",
        FIXTURE_PROVISION_PRIVATE_JWK: JSON.stringify(keys.provisionPrivate),
      },
    },
    serviceBindings: { ACCOUNT_PLATFORM: ACCOUNT_WORKER },
    bindings: {
      ACCOUNT_PLATFORM_DEPLOYMENT_ID: "shared-account-satyr-e2e",
      ACCOUNT_PLATFORM_PROVISION_TOKEN: "shared-account-e2e-pantry-provision",
      ACCOUNT_PLATFORM_PROVISION_ASSERTION_JWK: JSON.stringify(
        keys.provisionPublic,
      ),
      ACCOUNT_PLATFORM_PROVISION_ASSERTION_KEY_ID: "account-shared-account-e2e",
      ACCOUNT_PLATFORM_PROVISION_ASSERTION_ISSUER: ACCOUNT_ORIGIN,
      ACCOUNT_PLATFORM_PROVISION_ASSERTION_AUDIENCE: NATIVE_ORIGIN,
      ACCOUNT_PLATFORM_USER_ASSERTION_KEY_ID: "satyr-shared-account-e2e",
      ACCOUNT_PLATFORM_USER_ASSERTION_PKCS8_B64U: keys.assertionPkcs8,
      ACCOUNT_PLATFORM_ASSERTION_ISSUER: NATIVE_ORIGIN,
      ACCOUNT_PLATFORM_ASSERTION_AUDIENCE: ACCOUNT_ORIGIN,
      GOOGLE_OIDC_CLIENT_ID: "shared-account-satyr-e2e",
    },
  };
}
