// The built fixture Worker (tests/fixture-worker/worker.ts) in workerd through
// Miniflare: the production Worker and merchant Durable Object, so requests
// queue on the object as they do in production. Journeys that measure
// concurrency use it; the in-process backend runs requests one at a time.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommerceAdminClient,
  CommerceStorefrontClient,
} from "@purin-labs/commerce-client";

import {
  FIXTURE_SERVICE_TOKEN,
  buildFixtureWorker,
  fixtureSigningKey,
  startFixtureMiniflare,
} from "../scripts/fixture-miniflare.ts";
import { seedLocalCommerce } from "../scripts/seed-local-commerce.ts";
import { BASE_URL, merchantId } from "./journey-support.ts";

// One key for the process, so a merchant reopened after an eviction signs
// with the key it had.
const SIGNING_KEY = fixtureSigningKey();

/**
 * `persistDirectory` keeps the merchant objects' storage in a folder, so a
 * second start on the same folder is the same merchant after an eviction; it
 * is not seeded again.
 */
export async function startWorkerdBackend(
  options: Readonly<{ persistDirectory?: string }> = {},
) {
  const artifact = mkdtempSync(join(tmpdir(), "underclerk-workerd-"));
  buildFixtureWorker(artifact);
  const miniflare = await startFixtureMiniflare({
    artifact,
    signingKey: SIGNING_KEY,
    ...(options.persistDirectory === undefined
      ? {}
      : { persistDirectory: options.persistDirectory }),
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    const response = await miniflare.dispatchFetch(
      `${miniflare.origin}${url.pathname}${url.search}`,
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
    serviceToken: FIXTURE_SERVICE_TOKEN,
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
        headers: { authorization: `Bearer ${FIXTURE_SERVICE_TOKEN}` },
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
