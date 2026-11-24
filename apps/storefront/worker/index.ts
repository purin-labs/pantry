/**
 * The standalone shop site, such as shop.purin.io, and the QR order pages at
 * `<shop name>.<MENU_HOST_SUFFIX>` (Plan 40B phase 2). The Worker passes
 * `/v1/*` and `/health` to the Commerce Worker through a service binding,
 * so the page calls Commerce on its own origin, like any operator's site.
 *
 * On an order page host the Worker asks Commerce which storefront the shop
 * name opens. A name that no shop holds answers 404. The page learns its
 * storefront from a meta tag that the Worker adds, and the Worker passes on
 * only the buyer routes of that storefront: no name reaches another
 * merchant.
 */
type ServiceBinding = Readonly<{
  fetch(request: Request): Promise<Response>;
}>;

type Env = Readonly<{
  COMMERCE: ServiceBinding;
  ASSETS: ServiceBinding;
  /** The order page domain, `menu.purin.io` in production. */
  MENU_HOST_SUFFIX?: string;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const name = menuHostName(url.hostname, env.MENU_HOST_SUFFIX);
    if (name === undefined) return siteResponse(request, url, env);
    if (url.pathname === "/health") return env.COMMERCE.fetch(request);
    // A host deeper under the order page domain is no shop's.
    if (name === null) return missingShop(url);
    let shop: ShopName | null;
    try {
      shop = await lookUpShop(env, name);
    } catch {
      return jsonResponse(503, {
        message: "The shop is unavailable; try again",
      });
    }
    if (shop === null) return missingShop(url);
    if (!shop.current) {
      const moved = new URL(url);
      moved.hostname = `${shop.currentName}.${env.MENU_HOST_SUFFIX}`;
      return Response.redirect(moved.toString(), 301);
    }
    if (url.pathname.startsWith("/v1/"))
      return url.pathname.startsWith(storefrontPrefix(shop))
        ? env.COMMERCE.fetch(request)
        : jsonResponse(404, { message: "Route not found" });
    return withShopMeta(await env.ASSETS.fetch(request), shop);
  },
};

function siteResponse(request: Request, url: URL, env: Env): Promise<Response> {
  return url.pathname.startsWith("/v1/") || url.pathname === "/health"
    ? env.COMMERCE.fetch(request)
    : env.ASSETS.fetch(request);
}

/**
 * The shop name of an order page host: undefined for a host outside the
 * order page domain, null for a host under it that names no single label.
 */
function menuHostName(
  hostname: string,
  suffix: string | undefined,
): string | null | undefined {
  if (suffix === undefined || suffix.length === 0) return undefined;
  const host = hostname.toLowerCase();
  if (!host.endsWith(`.${suffix}`)) return undefined;
  const label = host.slice(0, -suffix.length - 1);
  return label.length === 0 || label.includes(".") ? null : label;
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

function storefrontPrefix(shop: ShopName): string {
  return `/v1/public/merchants/${encodeURIComponent(shop.merchantId)}/storefronts/${encodeURIComponent(shop.storefrontId)}/`;
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

function missingShop(url: URL): Response {
  if (url.pathname.startsWith("/v1/"))
    return jsonResponse(404, { message: "Shop not found" });
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
