/**
 * The standalone shop site, such as shop.purin.io, and the QR order pages at
 * `<MENU_HOST>/<shop name>/` (Plan 40B phase 2). The Worker passes
 * `/v1/*` and `/health` to the Commerce Worker through a service binding,
 * so the page calls Commerce on its own origin, like any operator's site.
 *
 * On the order page host the Worker asks Commerce which storefront the
 * first path segment names. A name that no shop holds answers 404. The page
 * learns its storefront from a meta tag that the Worker adds. Every shop
 * shares the order page host, so the Worker passes on only the buyer routes
 * of a storefront: no admin route and no other Commerce route.
 */
type ServiceBinding = Readonly<{
  fetch(request: Request): Promise<Response>;
}>;

type Env = Readonly<{
  COMMERCE: ServiceBinding;
  ASSETS: ServiceBinding;
  /** The order page host, `menu.purin.io` in production. */
  MENU_HOST?: string;
}>;

type ShopName = Readonly<{
  name: string;
  merchantId: string;
  storefrontId: string;
  current: boolean;
  currentName: string;
}>;

declare class HTMLRewriter {
  on(
    selector: string,
    handlers: Readonly<{
      element(element: {
        append(content: string, options: { html: boolean }): void;
      }): void;
    }>,
  ): HTMLRewriter;
  transform(response: Response): Response;
}

/** The meta tag that names the page's storefront; the page reads it. */
const SHOP_META_NAME = "commerce-shop";

// A name keeps its storefront for good, so a short cache only delays a new
// name; a missing name is cached for less time.
const FOUND_SECONDS = 60;
const MISSING_SECONDS = 10;
const CACHE_LIMIT = 500;
const shopNames = new Map<
  string,
  Readonly<{ shop: ShopName | null; expiresAt: number }>
>();

/** The buyer routes of one storefront, which an order page calls. */
const BUYER_ROUTE = /^\/v1\/public\/merchants\/[^/]+\/storefronts\/[^/]+\//u;

/**
 * The folders of the built site beside the shop pages. The commerce engine
 * reserves these names, so no shop takes one.
 */
const SITE_FOLDERS: ReadonlySet<string> = new Set(["assets", "products"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const menuHost = env.MENU_HOST?.trim().toLowerCase() ?? "";
    return menuHost.length > 0 && url.hostname.toLowerCase() === menuHost
      ? orderPageResponse(request, url, env)
      : siteResponse(request, url, env);
  },
};

async function orderPageResponse(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  if (url.pathname === "/health") return env.COMMERCE.fetch(request);
  if (url.pathname.startsWith("/v1/"))
    return BUYER_ROUTE.test(url.pathname)
      ? env.COMMERCE.fetch(request)
      : jsonResponse(404, { message: "Route not found" });
  const segment = url.pathname.split("/")[1] ?? "";
  // A built file: a site folder, or a file such as /favicon.svg.
  if (SITE_FOLDERS.has(segment) || segment.includes("."))
    return builtFile(request, env);
  if (segment.length === 0) return missingShop();
  let shop: ShopName | null;
  try {
    shop = await lookUpShop(env, segment.toLowerCase());
  } catch {
    return jsonResponse(503, {
      message: "The shop is unavailable; try again",
    });
  }
  if (shop === null) return missingShop();
  // An earlier name, a name in capitals, a path with no final slash or a
  // deeper path moves to the shop's page; the query stays.
  const page = `/${shop.currentName}/`;
  if (url.pathname !== page) {
    const moved = new URL(url);
    moved.pathname = page;
    return Response.redirect(moved.toString(), 301);
  }
  const index = new Request(new URL("/", url).toString(), request);
  return withShopMeta(await env.ASSETS.fetch(index), shop);
}

/**
 * A built file of the site. For a missing file the assets answer with the
 * shop site's page, which is no order page: the Worker answers 404.
 */
async function builtFile(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  return (response.headers.get("content-type") ?? "").startsWith("text/html")
    ? missingShop()
    : response;
}

function siteResponse(request: Request, url: URL, env: Env): Promise<Response> {
  return url.pathname.startsWith("/v1/") || url.pathname === "/health"
    ? env.COMMERCE.fetch(request)
    : env.ASSETS.fetch(request);
}

async function lookUpShop(env: Env, name: string): Promise<ShopName | null> {
  const now = Date.now();
  const cached = shopNames.get(name);
  if (cached !== undefined && cached.expiresAt > now) return cached.shop;
  const response = await env.COMMERCE.fetch(
    new Request(
      `https://commerce.internal/v1/public/shop-names/${encodeURIComponent(name)}`,
    ),
  );
  // A Commerce failure is not an answer about the name: it is not cached.
  if (response.status !== 200 && response.status !== 404)
    throw new Error(`Shop name lookup answered ${response.status}`);
  const shop =
    response.status === 200 ? parseShopName(await response.json(), name) : null;
  if (shopNames.size >= CACHE_LIMIT) shopNames.clear();
  shopNames.set(name, {
    shop,
    expiresAt: now + (shop === null ? MISSING_SECONDS : FOUND_SECONDS) * 1000,
  });
  return shop;
}

function parseShopName(value: unknown, name: string): ShopName | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return record.name === name &&
    typeof record.merchantId === "string" &&
    typeof record.storefrontId === "string" &&
    typeof record.current === "boolean" &&
    typeof record.currentName === "string"
    ? {
        name,
        merchantId: record.merchantId,
        storefrontId: record.storefrontId,
        current: record.current,
        currentName: record.currentName,
      }
    : null;
}

function withShopMeta(response: Response, shop: ShopName): Response {
  if (!(response.headers.get("content-type") ?? "").startsWith("text/html"))
    return response;
  const content = escapeAttribute(
    JSON.stringify({
      name: shop.name,
      merchantId: shop.merchantId,
      storefrontId: shop.storefrontId,
    }),
  );
  return new HTMLRewriter()
    .on("head", {
      element(element) {
        element.append(`<meta name="${SHOP_META_NAME}" content="${content}">`, {
          html: true,
        });
      },
    })
    .transform(response);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function missingShop(): Response {
  return new Response(MISSING_SHOP_PAGE, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": `public, max-age=${MISSING_SECONDS}`,
    },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const MISSING_SHOP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>No shop at this address</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, sans-serif; background: #f7f3ee; color: #2b2622; }
main { max-width: 28rem; padding: 0 1rem; text-align: center; }
h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
p { margin: 0; color: #6b625a; }
@media (prefers-color-scheme: dark) { body { background: #1d1a17; color: #f1ebe4; } p { color: #b3a99f; } }
</style>
</head>
<body>
<main>
<h1>No shop at this address</h1>
<p>Check the address on the QR code, or ask the staff for the shop's menu.</p>
</main>
</body>
</html>
`;
