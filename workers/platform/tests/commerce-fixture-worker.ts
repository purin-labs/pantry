// Platform tests reach Commerce only as a built Worker (Plan 76 phase 1).
// This module builds Commerce's fixture Worker
// (services/commerce/tests/fixture-worker) once per source state and runs it
// in Miniflare. The fixture Worker is the production Worker with a
// deterministic payment gateway, an optional fixed clock and named seed
// scenarios; Platform code talks to it over HTTP exactly as to production.
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCES = [
  "services/commerce/src",
  "services/commerce/tests/fixture-worker",
  "services/commerce/scripts/build-fixture-worker.mjs",
  "packages/commerce-contracts/src",
  "packages/commerce-client/src",
  "packages/commerce-query-sqlite/src",
  "packages/std/src",
  "packages/type-utils/src",
];

export type CommerceWorkerOptions = Readonly<{
  /** A fixed clock for every Commerce timestamp, as an ISO string. */
  now?: string;
  serviceToken?: string;
  /** An Ed25519 PKCS8 key (base64url) and its key id; generated when absent. */
  signingKey?: Readonly<{ keyId: string; privateKeyPkcs8B64: string }>;
  carrierSigningKey?: string;
}>;

export type CommerceWorker = Readonly<{
  baseUrl: string;
  serviceToken: string;
  signingKeyId: string;
  publicKeyB64: string;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Runs a named seed scenario of the fixture Worker for one merchant. */
  fixture: <Result = unknown>(merchantId: string, input: Readonly<{ kind: string } & Record<string, unknown>>) => Promise<Result>;
  dispose: () => Promise<void>;
}>;

/** The directory of the built fixture Worker; builds it when the sources changed. */
export function commerceFixtureWorkerArtifact(): string {
  const configured = process.env.COMMERCE_FIXTURE_WORKER_ARTIFACT;
  if (configured !== undefined && configured !== "") return resolve(configured);
  const cache = join(tmpdir(), "pantry-commerce-fixture-worker", sourceKey());
  if (existsSync(join(cache, "worker.js"))) return cache;
  const building = `${cache}.building-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(cache), { recursive: true });
  execFileSync(process.execPath, [join(repository, "services/commerce/scripts/build-fixture-worker.mjs"), building], {
    stdio: "ignore",
  });
  try {
    renameSync(building, cache);
  } catch {
    // Another test process built the same sources first.
    rmSync(building, { recursive: true, force: true });
  }
  return cache;
}

export async function startCommerceWorker(options: CommerceWorkerOptions = {}): Promise<CommerceWorker> {
  const artifact = commerceFixtureWorkerArtifact();
  const settings = JSON.parse(readFileSync(join(artifact, "fixture-worker.json"), "utf8")) as {
    compatibilityDate: string;
    compatibilityFlags: string[];
  };
  const serviceToken = options.serviceToken ?? "commerce-fixture-service-token";
  const signingKey = options.signingKey ?? generatedSigningKey();
  const miniflare = new Miniflare({
    modules: true,
    scriptPath: join(artifact, "worker.js"),
    modulesRoot: artifact,
    modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
    compatibilityDate: settings.compatibilityDate,
    compatibilityFlags: settings.compatibilityFlags,
    durableObjects: {
      COMMERCE_MERCHANT: { className: "CommerceFixtureMerchantDO", useSQLite: true },
    },
    bindings: {
      PANTRY_DEPLOYMENT_PROFILE: "local",
      COMMERCE_SERVICE_TOKEN: serviceToken,
      COMMERCE_BUYER_SESSION_SECRET: "commerce-fixture-buyer-session-secret-0001",
      COMMERCE_SIGNING_KEY_ID: signingKey.keyId,
      COMMERCE_SIGNING_PRIVATE_KEY_PKCS8_B64: signingKey.privateKeyPkcs8B64,
      JAPAN_CARRIER_SIGNING_KEY: options.carrierSigningKey ?? "commerce-fixture-carrier-key",
      ...(options.now === undefined ? {} : { COMMERCE_FIXTURE_NOW: options.now }),
    },
  });
  const baseUrl = (await miniflare.ready).origin;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const response = await miniflare.dispatchFetch(`${baseUrl}${url.pathname}${url.search}`, {
      method: request.method,
      headers: [...request.headers.entries()],
      ...(body === undefined ? {} : { body }),
    });
    return new Response(response.status === 204 ? null : await response.arrayBuffer(), {
      status: response.status,
      headers: [...response.headers.entries()],
    });
  };
  const publicKey = await fetch(`${baseUrl}/v1/admin/merchants/fixture_signing_key/test-signing-key`, {
    headers: { authorization: `Bearer ${serviceToken}` },
  });
  if (!publicKey.ok) throw new Error(`Commerce fixture Worker did not start: ${publicKey.status}`);
  const { publicKeyB64 } = (await publicKey.json()) as { publicKeyB64: string };
  return {
    baseUrl,
    serviceToken,
    signingKeyId: signingKey.keyId,
    publicKeyB64,
    fetch,
    async fixture(merchantId, input) {
      const response = await fetch(`${baseUrl}/v1/admin/merchants/${encodeURIComponent(merchantId)}/test-fixture`, {
        method: "POST",
        headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(`Commerce fixture ${input.kind} failed: ${JSON.stringify(result)}`);
      return result as never;
    },
    dispose: () => miniflare.dispose(),
  };
}

function generatedSigningKey(): Readonly<{ keyId: string; privateKeyPkcs8B64: string }> {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId: "key_commerce_fixture",
    privateKeyPkcs8B64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
  };
}

// Paths, sizes and modification times of every input: a cheap key for the
// built artifact that changes whenever a source changes.
function sourceKey(): string {
  const hash = createHash("sha256");
  for (const source of SOURCES) {
    for (const file of listFiles(join(repository, source))) {
      const stat = statSync(file);
      hash.update(`${relative(repository, file)}:${stat.size}:${stat.mtimeMs}\n`);
    }
  }
  return hash.digest("hex").slice(0, 24);
}

function listFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => listFiles(join(path, entry.name)));
}
