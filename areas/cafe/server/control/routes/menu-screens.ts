import {
  MENU_SCREEN_CODE_ALPHABET,
  type MenuScreenFacts,
  type MenuScreenFeed,
  type MenuScreenPairing,
  type MenuScreenPairingState,
} from "@purin-labs/cafe-control-api";
import { type MenuScreenPickup } from "@purin-labs/control-api";
import { encodeBase64Url, sha256Hex } from "@purin-labs/std";
import { CommerceStorefrontClient } from "@purin-labs/commerce-client";

import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { MenuBoardCommandReply } from "../../actors/menu-board-commands";
import {
  menuScreenSocketToken,
  parseMenuScreenToken,
} from "../../actors/menu-screens";
import {
  CAFE_MENU_ID,
  CAFE_STOREFRONT_ID,
  orderPageUrl,
} from "./commerce-menu-publication";
import { controlError, controlJson } from "@purin-labs/control/worker/http";
import { readOrganisationEnvironment } from "@purin-labs/agent/control/organisation-runtime";
import { resolveOrganisationCommerceMerchantBinding } from "@purin-labs/connections/data/commerce-merchant-binding";
import { readCafeImageContent } from "../../contract/media";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { createCommerceClient } from "@purin-labs/area-commerce/server/contract/client";
import {
  countOpenScreenPairings,
  deleteCollectedScreenPairing,
  deleteExpiredScreenPairings,
  insertScreenPairing,
  readScreenPairingState,
} from "../../data/screen-pairing";

/**
 * The routes of a shop screen (Plan 40B phase 1), with no Portal session:
 *
 *   POST /v1/screens/pairings              a new code for a screen to show
 *   GET  /v1/screens/pairings/:pairingId   the screen's token, one time, once a
 *                                          member paired it (Bearer: the secret)
 *   GET  /v1/screens/feed                  the board release and the live
 *                                          menu facts (Bearer: the token)
 *   GET  /v1/screens/pickup                the order codes of a pickup board
 *                                          (Bearer: the token)
 *   GET  /v1/screens/socket                the signal socket (the token is
 *                                          the second subprotocol)
 *
 * The feed reads the shop's published menu as the order page reads it, so
 * that a board and the order page agree on availability and prices.
 */

const PAIRING_MS = 10 * 60_000;
/** Open pairings across every shop; a burst beyond it waits for expiry. */
const OPEN_PAIRING_LIMIT = 5_000;
/**
 * Open pairings from one address, so that one client cannot hold the codes
 * of every shop. A shop network that pairs many TVs at once stays below it.
 */
const ADDRESS_PAIRING_LIMIT = 50;

export async function handleMenuScreenRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/v1/screens/pairings")
    return request.method === "POST"
      ? startPairing(request, env)
      : controlError("method_not_allowed", 405);
  const pairing = /^\/v1\/screens\/pairings\/(pairing_[a-f0-9]{24})$/u.exec(
    pathname,
  );
  if (pairing !== null)
    return request.method === "GET"
      ? readPairing(request, env, pairing[1] ?? "")
      : controlError("method_not_allowed", 405);
  if (pathname === "/v1/screens/feed")
    return request.method === "GET"
      ? readFeed(request, env)
      : controlError("method_not_allowed", 405);
  if (pathname === "/v1/screens/pickup")
    return request.method === "GET"
      ? readPickup(request, env)
      : controlError("method_not_allowed", 405);
  if (pathname === "/v1/screens/socket") return openSocket(request, env);
  const media = /^\/v1\/screens\/media\/([^/]+)\/(media_[0-9a-f]{32})$/u.exec(
    pathname,
  );
  if (media !== null)
    return request.method === "GET"
      ? readScreenMedia(env, decodeURIComponent(media[1] ?? ""), media[2] ?? "")
      : controlError("method_not_allowed", 405);
  return controlError("not_found", 404);
}

/**
 * A board's image for a TV (Plan 40B, the image element). A TV loads it as
 * an <img> with no session, so the image is public only while the newest
 * release of a board of that Organisation names it; any other image of the
 * library, or a draft's image, answers 404.
 */
async function readScreenMedia(
  env: Env,
  organisationIdRaw: string,
  mediaId: string,
): Promise<Response> {
  const organisationId = parseOrganisationId(organisationIdRaw);
  if (!organisationId.ok) return controlError("not_found", 404);
  let read: MenuBoardCommandReply<{ kind: "published_media"; mediaId: string }>;
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: organisationId.value,
      now: Date.now(),
    });
    read = (await organisation.menuBoardCommand({
      organisationId: organisationId.value,
      command: { kind: "published_media", mediaId },
    })) as MenuBoardCommandReply<{ kind: "published_media"; mediaId: string }>;
  } catch {
    return controlError("not_found", 404);
  }
  if (!read.ok || !read.value.named) return controlError("not_found", 404);
  const content = await readCafeImageContent(
    env,
    organisationId.value,
    mediaId,
  );
  if (content === null) return controlError("not_found", 404);
  return new Response(content.bytes, {
    status: 200,
    headers: {
      "content-type": content.contentType,
      // A short cache: an image that a new release drops stops in minutes.
      "cache-control": "public, max-age=300",
      ...(content.etag === null ? {} : { etag: content.etag }),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

async function startPairing(request: Request, env: Env): Promise<Response> {
  const now = Date.now();
  const clientKey = await pairingClientKey(request);
  await deleteExpiredScreenPairings(env.DB, now);
  const open = await countOpenScreenPairings(env.DB, clientKey);
  if ((open?.mine ?? 0) >= ADDRESS_PAIRING_LIMIT)
    return controlError("menu_screen_pairing_limit", 429);
  if ((open?.total ?? 0) >= OPEN_PAIRING_LIMIT)
    return controlError("menu_screen_pairing_busy", 429);
  const secret = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const secretHash = await sha256Hex(secret);
  const expiresAt = now + PAIRING_MS;
  // A code that another screen shows now is taken; try a few others.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pairingId = `pairing_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const code = pairingCode();
    const inserted = await insertScreenPairing(env.DB, {
      pairingId,
      code,
      secretHash,
      clientKey,
      createdAt: now,
      expiresAt,
    });
    if (inserted) {
      const pairing: MenuScreenPairing = { pairingId, code, secret, expiresAt };
      return controlJson(pairing, 201);
    }
  }
  return controlError("menu_screen_pairing_busy", 429);
}

/**
 * The hash of the address that asks for a code. Cloudflare sets
 * CF-Connecting-IP and replaces a value that the client sends. One client
 * often holds a whole IPv6 /64, so the prefix counts as one address. Only
 * the hash is stored, and it goes with its row when the code expires.
 */
async function pairingClientKey(request: Request): Promise<string> {
  const address = (request.headers.get("CF-Connecting-IP") ?? "").trim();
  const client = address.includes(".")
    ? address.slice(address.lastIndexOf(":") + 1)
    : address.includes(":")
      ? ipv6Prefix(address)
      : address;
  return sha256Hex(`screen_pairing_client:${client.toLowerCase()}`);
}

function ipv6Prefix(address: string): string {
  const [head = "", tail] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups =
    tail === undefined
      ? left
      : [
          ...left,
          ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill(
            "0",
          ),
          ...right,
        ];
  return groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/u, ""))
    .join(":");
}

async function readPairing(
  request: Request,
  env: Env,
  pairingId: string,
): Promise<Response> {
  const secret = bearer(request);
  if (secret === null) return controlError("menu_screen_refused", 401);
  const row = await readScreenPairingState(env.DB, pairingId);
  if (row === null || row.expires_at <= Date.now())
    return controlError("menu_screen_pairing_expired", 404);
  if (!timingSafeEqualText(await sha256Hex(secret), row.secret_hash))
    return controlError("menu_screen_refused", 401);
  if (row.screen_token === null) {
    const waiting: MenuScreenPairingState = {
      state: "waiting",
      expiresAt: row.expires_at,
    };
    return controlJson(waiting);
  }
  // The screen takes its token one time; the row and the token go with it.
  if (!(await deleteCollectedScreenPairing(env.DB, pairingId)))
    return controlError("menu_screen_pairing_expired", 404);
  const paired: MenuScreenPairingState = {
    state: "paired",
    token: row.screen_token,
  };
  return controlJson(paired);
}

type ScreenFeedCommand = Readonly<{
  kind: "screen_feed";
  screenId: string;
  secret: string;
}>;

/** The paired screen of the bearer token, as the Organisation Actor reads it. */
async function readPairedScreen(
  request: Request,
  env: Env,
): Promise<
  | Readonly<{
      organisationId: OrganisationId;
      read: Extract<MenuBoardCommandReply<ScreenFeedCommand>, { ok: true }>;
    }>
  | Response
> {
  const raw = bearer(request);
  const token = raw === null ? null : parseMenuScreenToken(raw);
  if (token === null) return controlError("menu_screen_refused", 401);
  const organisationId = parseOrganisationId(token.organisationId);
  if (!organisationId.ok) return controlError("menu_screen_refused", 401);
  const command = {
    kind: "screen_feed",
    screenId: token.screenId,
    secret: token.secret,
  } as const;
  let read: MenuBoardCommandReply<typeof command>;
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: organisationId.value,
      now: Date.now(),
    });
    read = (await organisation.menuBoardCommand({
      organisationId: organisationId.value,
      command,
    })) as MenuBoardCommandReply<typeof command>;
  } catch {
    return controlError("menu_screen_unavailable", 503);
  }
  if (!read.ok)
    return read.error.code === "menu_screen_refused"
      ? controlError("menu_screen_refused", 401)
      : controlError("menu_screen_unavailable", 503);
  return { organisationId: organisationId.value, read };
}

async function readFeed(request: Request, env: Env): Promise<Response> {
  const screen = await readPairedScreen(request, env);
  if (screen instanceof Response) return screen;
  const feed: MenuScreenFeed = {
    screen: screen.read.value.screen,
    release: screen.read.value.release,
    facts: await readMenuScreenFacts(env, screen.organisationId),
  };
  return controlJson(feed);
}

/**
 * The codes of the shop's open pickups. A board that shows no codes never
 * reads them, so a menu screen costs Commerce nothing more. The codes name
 * no buyer, so any paired screen of the shop may show them.
 */
async function readPickup(request: Request, env: Env): Promise<Response> {
  const screen = await readPairedScreen(request, env);
  if (screen instanceof Response) return screen;
  const pickup = await readMenuScreenPickup(env, screen.organisationId);
  return pickup === null
    ? controlError("menu_screen_unavailable", 503)
    : controlJson(pickup);
}

async function readMenuScreenPickup(
  env: Env,
  organisationId: OrganisationId,
): Promise<MenuScreenPickup | null> {
  try {
    const scope = await OrganisationExecutionScope.resolve(env, organisationId);
    if (!scope.ok) return null;
    const environment = await readOrganisationEnvironment(
      scope.value.database,
      organisationId,
    );
    if (environment === null) return null;
    const binding = await resolveOrganisationCommerceMerchantBinding({
      db: scope.value.database,
      organisationId,
      environment,
    });
    if (!binding.ok) return null;
    const admin = createCommerceClient(env, undefined, {
      kind: "organisation",
      organisationId: String(organisationId),
    });
    if (admin === null) return null;
    const queue = await admin.readPickupQueue(binding.value.merchantId);
    if (!queue.ok) return null;
    const codes = (stage: "preparing" | "ready"): string[] =>
      queue.value.entries
        .filter((entry) => entry.stage === stage)
        .map((entry) => entry.code);
    return {
      observedAt: Date.now(),
      preparing: codes("preparing"),
      ready: codes("ready"),
    };
  } catch {
    return null;
  }
}

async function openSocket(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return controlError("websocket_required", 426);
  const raw = menuScreenSocketToken(request);
  const token = raw === null ? null : parseMenuScreenToken(raw);
  if (token === null) return controlError("menu_screen_refused", 401);
  const organisationId = parseOrganisationId(token.organisationId);
  if (!organisationId.ok) return controlError("menu_screen_refused", 401);
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: organisationId.value,
      now: Date.now(),
    });
    return await organisation.fetch(request);
  } catch {
    return controlError("menu_screen_unavailable", 503);
  }
}

/** The shop's Commerce merchant and a storefront client. */
export type CafeShop = Readonly<{
  merchantId: string;
  buyer: CommerceStorefrontClient;
}>;

/**
 * The shop's merchant and a storefront client. `no_merchant` when the
 * Organisation has no Commerce merchant, or this Worker has no Commerce; null
 * when the read fails.
 */
export async function resolveCafeBuyer(
  env: Env,
  organisationId: OrganisationId,
): Promise<CafeShop | "no_merchant" | null> {
  const base = env.COMMERCE_BASE_URL?.trim();
  if (base === undefined || base.length === 0) return "no_merchant";
  try {
    const scope = await OrganisationExecutionScope.resolve(env, organisationId);
    if (!scope.ok) return null;
    const environment = await readOrganisationEnvironment(
      scope.value.database,
      organisationId,
    );
    if (environment === null) return null;
    const binding = await resolveOrganisationCommerceMerchantBinding({
      db: scope.value.database,
      organisationId,
      environment,
    });
    if (!binding.ok)
      return binding.error.code === "commerce_binding_not_found"
        ? "no_merchant"
        : null;
    const merchantId = binding.value.merchantId;
    const buyer = new CommerceStorefrontClient({
      baseUrl: base,
      fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
    });
    return { merchantId, buyer };
  } catch {
    return null;
  }
}

/**
 * The shop's published café menu as a guest of its order page sees it:
 * Commerce's storefront snapshot, which can lag a sale by a few seconds.
 * Null when the shop has no Commerce merchant or Commerce does not
 * answer; the screen then keeps its saved facts as not verified.
 */
export async function readMenuScreenFacts(
  env: Env,
  organisationId: OrganisationId,
): Promise<MenuScreenFacts | null> {
  return (await readPublishedCafeMenu(env, organisationId))?.facts ?? null;
}

/** One entry of the published café menu, with the names that a buyer sees. */
type PublishedMenuEntryName = Readonly<{
  menuEntryId: string;
  name: string;
  sectionId: string;
  sectionName: string;
}>;

/**
 * The published café menu as a guest sees it: the screen facts, and each
 * entry's name and section (Plan 40B phase 5), so that an agent can name an
 * item that the Portal's menu draft does not hold. Null as for the facts.
 */
export async function readPublishedCafeMenu(
  env: Env,
  organisationId: OrganisationId,
): Promise<Readonly<{
  facts: MenuScreenFacts;
  names: readonly PublishedMenuEntryName[];
}> | null> {
  try {
    const shop = await resolveCafeBuyer(env, organisationId);
    if (shop === null || shop === "no_merchant") return null;
    const { merchantId, buyer } = shop;
    // The QR code opens the shop's order page; the shop name read runs
    // beside the guest session, and a failed read keeps the hosted page.
    const admin = createCommerceClient(env, undefined, {
      kind: "organisation",
      organisationId: String(organisationId),
    });
    const [session, shopName] = await Promise.all([
      buyer.createSession(merchantId, CAFE_STOREFRONT_ID, {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      }),
      admin === null
        ? null
        : admin.readStorefrontShopName(merchantId, CAFE_STOREFRONT_ID),
    ]);
    if (!session.ok) return null;
    const catalog = await buyer.readCatalog(
      merchantId,
      CAFE_STOREFRONT_ID,
      session.value.token,
    );
    if (!catalog.ok) return null;
    const menu = catalog.value.menus.find(
      (candidate) => candidate.menuId === CAFE_MENU_ID,
    );
    const titles = new Map(
      catalog.value.listings.map((listing) => [
        listing.variantId,
        listing.title,
      ]),
    );
    // A board shows the product's first photo, as the shop page does.
    const photos = new Map(
      catalog.value.listings.flatMap((listing) => {
        const photo = listing.media.find((item) => item.kind === "image");
        return photo === undefined
          ? []
          : [[listing.variantId, { url: photo.url, altText: photo.altText }]];
      }),
    );
    const sectionNames = new Map(
      (menu?.sections ?? []).map((section) => [
        section.sectionId,
        section.name,
      ]),
    );
    const names = (menu?.entries ?? []).map((entry) => ({
      menuEntryId: entry.menuEntryId,
      name: titles.get(entry.variantId) ?? entry.menuEntryId,
      sectionId: entry.sectionId,
      sectionName: sectionNames.get(entry.sectionId) ?? "",
    }));
    const facts: MenuScreenFacts = {
      observedAt: Date.now(),
      entries: (menu?.entries ?? []).map((entry) => ({
        menuEntryId: entry.menuEntryId,
        price: {
          amountMinor: entry.price.amountMinor,
          currency: entry.price.currency,
        },
        // A compare-at price at or below the price is no deal to show. The
        // key goes only with a deal, so that a player from before phase 4,
        // which reads exact keys, still reads every other entry.
        ...(entry.compareAtPrice !== null &&
        entry.compareAtPrice.amountMinor > entry.price.amountMinor
          ? {
              compareAtPrice: {
                amountMinor: entry.compareAtPrice.amountMinor,
                currency: entry.compareAtPrice.currency,
              },
            }
          : {}),
        availability: entry.availability,
        // The key goes only with a photo, as with the deal above.
        ...(photos.has(entry.variantId)
          ? { image: photos.get(entry.variantId) }
          : {}),
      })),
      orderUrl: orderPageUrl(
        env,
        merchantId,
        shopName?.ok === true ? shopName.value.name : null,
      ),
    };
    return { facts, names };
  } catch {
    return null;
  }
}

function pairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let code = "";
  // 32 letters: each byte keeps its low five bits, so no letter is likelier.
  for (const byte of bytes)
    code += MENU_SCREEN_CODE_ALPHABET[byte % MENU_SCREEN_CODE_ALPHABET.length];
  return code;
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._:-]{1,512})$/u.exec(header);
  return match === null ? null : (match[1] ?? null);
}

function timingSafeEqualText(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    crypto.subtle.timingSafeEqual(leftBytes, rightBytes)
  );
}
