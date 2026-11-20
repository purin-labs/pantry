// The built fixture Worker (tests/fixture-worker/worker.ts) in workerd through
// Miniflare, with the merchant Durable Object on SQLite as in production. The
// workerd journeys and the schema upgrade rehearsal start it here.
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const FIXTURE_SERVICE_TOKEN = "underclerk-workerd-service-token";
/** The fixture clock; journeys build their records at this time. */
export const FIXTURE_NOW = "2026-08-14T10:00:00.000Z";

export type FixtureMiniflare = Readonly<{
  origin: string;
  dispatchFetch: (url: string, init?: RequestInit) => Promise<Response>;
  dispose: () => Promise<void>;
}>;

/** Builds the fixture Worker of this tree into `outdir`. */
export function buildFixtureWorker(outdir: string): void {
  const built = spawnSync(
    process.execPath,
    [join(SERVICE, "scripts/build-fixture-worker.mjs"), outdir],
    { cwd: SERVICE, encoding: "utf8" },
  );
  if (built.status !== 0)
    throw new Error(
      `Fixture Worker build failed: ${built.stdout}${built.stderr}`,
    );
}

export function fixtureSigningKey(): KeyObject {
  return generateKeyPairSync("ed25519").privateKey;
}

/**
 * Starts a built fixture Worker. `persistDirectory` keeps the merchant
 * objects' storage in a folder, so a second start on the same folder opens the
 * same merchant, as after an eviction or a deploy.
 */
export async function startFixtureMiniflare(
  options: Readonly<{
    artifact: string;
    signingKey: KeyObject;
    persistDirectory?: string;
  }>,
): Promise<FixtureMiniflare> {
  const settings = JSON.parse(
    readFileSync(join(options.artifact, "fixture-worker.json"), "utf8"),
  ) as { compatibilityDate: string; compatibilityFlags: string[] };
  const wranglerRequire = createRequire(
    createRequire(`${SERVICE}/`).resolve("wrangler/package.json"),
  );
  const { Miniflare } = wranglerRequire("miniflare") as {
    Miniflare: new (options: Record<string, unknown>) => Readonly<{
      ready: Promise<URL>;
      dispatchFetch: (url: string, init?: RequestInit) => Promise<Response>;
      dispose: () => Promise<void>;
    }>;
  };
  const miniflare = new Miniflare({
    modules: true,
    scriptPath: join(options.artifact, "worker.js"),
    modulesRoot: options.artifact,
    modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
    compatibilityDate: settings.compatibilityDate,
    compatibilityFlags: settings.compatibilityFlags,
    durableObjects: {
      UNDERCLERK_MERCHANT: {
        className: "CommerceFixtureMerchantDO",
        useSQLite: true,
      },
    },
    ...(options.persistDirectory === undefined
      ? {}
      : { durableObjectsPersist: options.persistDirectory }),
    bindings: {
      PANTRY_DEPLOYMENT_PROFILE: "local",
      UNDERCLERK_SERVICE_TOKEN: FIXTURE_SERVICE_TOKEN,
      UNDERCLERK_BUYER_SESSION_SECRET:
        "underclerk-workerd-buyer-session-secret-01",
      UNDERCLERK_SIGNING_KEY_ID: "key_underclerk_workerd",
      UNDERCLERK_SIGNING_PRIVATE_KEY_PKCS8_B64: options.signingKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64url"),
      JAPAN_CARRIER_SIGNING_KEY: "underclerk-workerd-carrier-key",
      UNDERCLERK_FIXTURE_NOW: FIXTURE_NOW,
    },
  });
  const origin = (await miniflare.ready).origin;
  return {
    origin,
    dispatchFetch: (url, init) => miniflare.dispatchFetch(url, init),
    dispose: () => miniflare.dispose(),
  };
}
