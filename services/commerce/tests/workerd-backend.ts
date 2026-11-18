// The built fixture Worker (tests/fixture-worker/worker.ts) in workerd through
// Miniflare: the production Worker and merchant Durable Object, so requests
// queue on the object as they do in production. Journeys that measure
// concurrency use it; the in-process backend runs requests one at a time.
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CommerceAdminClient,
  CommerceStorefrontClient,
} from "@seams/commerce-client";

import { seedLocalCommerce } from "../scripts/seed-local-commerce.ts";
import { BASE_URL, NOW, merchantId } from "./journey-support.ts";

const SERVICE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE_TOKEN = "underclerk-workerd-service-token";
// One key for the process, so a merchant reopened after an eviction signs
// with the key it had.
const SIGNING_KEY = generateKeyPairSync("ed25519");

type MiniflareInstance = Readonly<{
  ready: Promise<URL>;
  dispatchFetch: (url: string, init: RequestInit) => Promise<Response>;
  dispose: () => Promise<void>;
}>;

/**
 * `persistDirectory` keeps the merchant objects' storage in a folder, so a
 * second start on the same folder is the same merchant after an eviction; it
 * is not seeded again.
 */
export async function startWorkerdBackend(
  options: Readonly<{ persistDirectory?: string }> = {},
) {
  const artifact = mkdtempSync(join(tmpdir(), "underclerk-workerd-"));
  const built = spawnSync(
    process.execPath,
    [join(SERVICE, "scripts/build-fixture-worker.mjs"), artifact],
    { cwd: SERVICE, encoding: "utf8" },
  );
  if (built.status !== 0)
    throw new Error(`Fixture Worker build failed: ${built.stderr}`);
  const settings = JSON.parse(
    readFileSync(join(artifact, "fixture-worker.json"), "utf8"),
  ) as { compatibilityDate: string; compatibilityFlags: string[] };
  const wranglerRequire = createRequire(
    createRequire(`${SERVICE}/`).resolve("wrangler/package.json"),
  );
  const { Miniflare } = wranglerRequire("miniflare") as {
    Miniflare: new (options: Record<string, unknown>) => MiniflareInstance;
  };
  const { privateKey } = SIGNING_KEY;
  const miniflare = new Miniflare({
    modules: true,
    scriptPath: join(artifact, "worker.js"),
    modulesRoot: artifact,
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
      SATYR_DEPLOYMENT_PROFILE: "local",
      UNDERCLERK_SERVICE_TOKEN: SERVICE_TOKEN,
      UNDERCLERK_BUYER_SESSION_SECRET:
        "underclerk-workerd-buyer-session-secret-01",
      UNDERCLERK_SIGNING_KEY_ID: "key_underclerk_workerd",
      UNDERCLERK_SIGNING_PRIVATE_KEY_PKCS8_B64: privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64url"),
      JAPAN_CARRIER_SIGNING_KEY: "underclerk-workerd-carrier-key",
      UNDERCLERK_FIXTURE_NOW: NOW,
    },
  });
  const origin = (await miniflare.ready).origin;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    const response = await miniflare.dispatchFetch(
      `${origin}${url.pathname}${url.search}`,
      {
        method: request.method,
        headers: [...request.headers.entries()],
        ...(body === undefined ? {} : { body }),
      },
    );
    return new Response(
      response.status === 204 ? null : await response.arrayBuffer(),
      { status: response.status, headers: [...response.headers.entries()] },
    );
  };
  const admin = new CommerceAdminClient({
    baseUrl: BASE_URL,
    serviceToken: SERVICE_TOKEN,
    fetch,
  });
  const buyer = new CommerceStorefrontClient({ baseUrl: BASE_URL, fetch });
  const reopened =
    options.persistDirectory !== undefined &&
    (await admin.readSnapshot(merchantId)).ok;
  if (!reopened) await seedLocalCommerce(admin, buyer);
  /** Requests that reached the merchant object by route kind; resets them. */
  const takeRequestCounts = async (): Promise<Record<string, number>> => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/merchants/${encodeURIComponent(merchantId)}/test-request-counts`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
      },
    );
    return (await response.json()) as Record<string, number>;
  };
  return {
    admin,
    buyer,
    fetch,
    takeRequestCounts,
    close: async () => {
      await miniflare.dispose();
      rmSync(artifact, { recursive: true, force: true });
    },
  };
}
