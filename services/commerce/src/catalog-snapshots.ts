// Storefront reads at the Worker (Plan 76 phase 7). A buyer's catalog read
// does not depend on the buyer: the session token only allows it, and a guest
// session is a signed token made from the storefront's revision and checkout
// profile. The Worker keeps the merchant object's snapshot of these in the
// Cache API for a few seconds, issues guest sessions and checks sessions
// itself, so these requests do not queue on the merchant object behind
// checkouts. A snapshot can show an item as available for those seconds after
// it sold out; the checkout still refuses it, so a snapshot can never
// oversell. A request that the snapshot cannot answer, such as a signed-in
// customer's session or a token for another storefront revision, goes to the
// merchant object, which decides as before.
import { isRecord } from "@seams/std";
import {
  parseCreateBuyerSessionCommand,
  type CommerceBuyerCatalogV1,
} from "@seams/commerce-client";

import { BuyerSessionAuthority } from "./buyer-session.ts";
import { catalogSearchRequest, searchCatalog } from "./catalog-search.ts";

/**
 * How long a catalog snapshot serves reads. A shop screen shows a sold-out
 * item within this time plus its own read (Plan 40B: 5 seconds in all).
 */
export const CATALOG_SNAPSHOT_SECONDS = 2;

const FETCHED_AT_HEADER = "x-underclerk-snapshot-fetched-at";

type CatalogSnapshot = Readonly<{
  organisationId: string;
  storefrontRevision: number;
  builtAt: string;
  checkoutProfile: Readonly<{
    checkoutProfileId: string;
    revision: number;
    configuration: unknown;
  }> | null;
  catalog: unknown;
}>;

type SnapshotOptions = Readonly<{
  sessionSecret: string;
  serviceToken: string;
  merchantObject: { fetch: (request: Request) => Promise<Response> };
}>;

/** A guest session from the snapshot; any other session from the object. */
export async function createSessionThroughSnapshot(
  request: Request,
  route: Readonly<{ merchantId: string; storefrontId: string }>,
  options: SnapshotOptions,
): Promise<Response> {
  const body = await request.text();
  const forward = () =>
    options.merchantObject.fetch(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
      }),
    );
  let guest: boolean;
  try {
    guest =
      parseCreateBuyerSessionCommand(JSON.parse(body)).buyer.kind === "guest";
  } catch {
    return forward();
  }
  if (!guest) return forward();
  const stored = await cachedSnapshot(
    new URL(request.url).origin,
    route,
    options,
  );
  const profile = stored?.snapshot.checkoutProfile;
  if (stored === undefined || profile === null || profile === undefined)
    return forward();
  // Issued at the snapshot's own time: the merchant object's clock is never
  // earlier, so it never sees a session issued in its future.
  const issued = new BuyerSessionAuthority({
    secret: options.sessionSecret,
    now: () => stored.snapshot.builtAt,
  }).issue({
    merchantId: route.merchantId,
    storefrontId: route.storefrontId,
    storefrontRevision: stored.snapshot.storefrontRevision,
    checkoutProfile: {
      checkoutProfileId: profile.checkoutProfileId,
      revision: profile.revision,
    },
    buyer: { kind: "guest" },
  });
  return new Response(
    JSON.stringify({
      schemaVersion: "underclerk.buyer-session.v4",
      token: issued.token,
      expiresAt: issued.claims.expiresAt,
      storefrontRevision: issued.claims.storefrontRevision,
      checkoutProfile: issued.claims.checkoutProfile,
      checkoutProfileConfiguration: profile.configuration,
      buyer: { kind: issued.claims.buyer.kind },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

export async function readCatalogThroughSnapshot(
  request: Request,
  route: Readonly<{
    kind: "read_buyer_catalog" | "search_buyer_catalog";
    merchantId: string;
    storefrontId: string;
  }>,
  options: SnapshotOptions,
): Promise<Response> {
  const forward = () => options.merchantObject.fetch(request);
  const token = bearerToken(request);
  if (token === undefined) return forward();
  const origin = new URL(request.url).origin;
  const stored = await cachedSnapshot(origin, route, options);
  if (stored === undefined) return forward();
  const verified = new BuyerSessionAuthority({
    secret: options.sessionSecret,
    now: () => snapshotNow(stored),
  }).verify(token, {
    merchantId: route.merchantId,
    storefrontId: route.storefrontId,
    storefrontRevision: stored.snapshot.storefrontRevision,
  });
  if (!verified.ok) return forward();
  let body: unknown = stored.snapshot.catalog;
  if (route.kind === "search_buyer_catalog") {
    const search = catalogSearchRequest(request);
    if (search === undefined) return forward();
    body = searchCatalog(
      stored.snapshot.catalog as CommerceBuyerCatalogV1,
      search.query,
      search.limit,
    );
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// The object's clock as it built the snapshot, moved on by the time since:
// the real time in production, the fixed time of a test Worker.
function snapshotNow(
  stored: Readonly<{ snapshot: CatalogSnapshot; fetchedAt: number }>,
): string {
  return new Date(
    Date.parse(stored.snapshot.builtAt) + (Date.now() - stored.fetchedAt),
  ).toISOString();
}

async function cachedSnapshot(
  origin: string,
  route: Readonly<{ merchantId: string; storefrontId: string }>,
  options: Readonly<{
    serviceToken: string;
    merchantObject: { fetch: (request: Request) => Promise<Response> };
  }>,
): Promise<
  Readonly<{ snapshot: CatalogSnapshot; fetchedAt: number }> | undefined
> {
  // Cloudflare's default cache; a Node test has none, and reads every time.
  const cache =
    typeof caches === "undefined"
      ? undefined
      : (caches as CacheStorage & { default?: Cache }).default;
  const merchant = encodeURIComponent(route.merchantId);
  const storefront = encodeURIComponent(route.storefrontId);
  const key = new Request(
    `https://underclerk.internal/catalog-snapshots/${merchant}/${storefront}?origin=${encodeURIComponent(origin)}`,
  );
  let response = await cache?.match(key);
  if (response === undefined) {
    const built = await options.merchantObject.fetch(
      new Request(
        `https://underclerk.internal/v1/internal/merchants/${merchant}/storefronts/${storefront}/catalog-snapshot`,
        {
          headers: {
            authorization: `Bearer ${options.serviceToken}`,
            "x-underclerk-public-origin": origin,
          },
        },
      ),
    );
    if (!built.ok) return undefined;
    response = new Response(await built.text(), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `max-age=${CATALOG_SNAPSHOT_SECONDS}`,
        [FETCHED_AT_HEADER]: String(Date.now()),
      },
    });
    await cache?.put(key, response.clone());
  }
  let snapshot: CatalogSnapshot | undefined;
  try {
    snapshot = parseSnapshot(await response.json());
  } catch {
    return undefined;
  }
  const fetchedAt = Number(response.headers.get(FETCHED_AT_HEADER));
  return snapshot === undefined || !Number.isSafeInteger(fetchedAt)
    ? undefined
    : { snapshot, fetchedAt };
}

function parseSnapshot(value: unknown): CatalogSnapshot | undefined {
  return isRecord(value) &&
    value.schemaVersion === "underclerk.catalog-snapshot.v1" &&
    typeof value.organisationId === "string" &&
    typeof value.storefrontRevision === "number" &&
    typeof value.builtAt === "string" &&
    isRecord(value.catalog)
    ? {
        organisationId: value.organisationId,
        storefrontRevision: value.storefrontRevision,
        builtAt: value.builtAt,
        checkoutProfile: parseProfile(value.checkoutProfile),
        catalog: value.catalog,
      }
    : undefined;
}

function parseProfile(value: unknown): CatalogSnapshot["checkoutProfile"] {
  return isRecord(value) &&
    typeof value.checkoutProfileId === "string" &&
    typeof value.revision === "number" &&
    isRecord(value.configuration)
    ? {
        checkoutProfileId: value.checkoutProfileId,
        revision: value.revision,
        configuration: value.configuration,
      }
    : null;
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") === true ? header.slice(7) : undefined;
}
