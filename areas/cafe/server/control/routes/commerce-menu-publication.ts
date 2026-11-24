import { parseMenuHours } from "@purin-labs/control-api";

import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { Env } from "@purin-labs/kernel/env";
import { sha256Hex } from "@purin-labs/std";
import { resolveMerchantControlContext } from "@purin-labs/area-commerce-contract/server/merchant-control";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
} from "@purin-labs/control/worker/http";
import {
  CAFE_MENU_ID,
  CAFE_STOREFRONT_ID,
  cafeMenuEntry,
  cafeProductPhotos,
  planCafeMenu,
  publishedCafeMenu,
} from "@purin-labs/area-cafe-contract/server/menu-publication";

export {
  CAFE_MENU_ID,
  CAFE_STOREFRONT_ID,
} from "@purin-labs/area-cafe-contract/server/menu-publication";

/**
 * Publishes the shop's café menu from the Portal's shared menu draft. An
 * owner or an admin publishes the draft revision that they saw. Each draft
 * item names a product, which the café sells through its offer in the café
 * storefront's sales channel, with the variant's active consumption plan at
 * the café. A published menu is replaced by its next revision, so the café
 * shows one menu. A read lists the products that the café can sell, for the
 * Menus page's item picker, the revision of the published menu, and the
 * address of the shop's café on Commerce's hosted page.
 */
export type CommerceMenuPublicationControlRoute = Readonly<{
  /** `commerceShopName` sets the address of the shop's QR order page. */
  kind: "commerceMenuPublication" | "commerceShopName";
  organisationIdRaw: string;
}>;

export function matchCommerceMenuPublicationControlRoute(
  pathname: string,
): CommerceMenuPublicationControlRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/(menu-publication|shop-name)$/u.exec(
      pathname,
    );
  return match === null
    ? null
    : {
        kind:
          match[2] === "shop-name"
            ? "commerceShopName"
            : "commerceMenuPublication",
        organisationIdRaw: decodeURIComponent(match[1] ?? ""),
      };
}

export async function handleCommerceMenuPublicationControlRoute(
  request: Request,
  env: Env,
  route: CommerceMenuPublicationControlRoute,
): Promise<Response> {
  if (route.kind === "commerceShopName")
    return request.method === "PUT"
      ? setShopName(request, env, route)
      : controlError("method_not_allowed", 405);
  if (request.method === "GET") return readCafeMenuOptions(request, env, route);
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  const documentRevision = body.ok ? body.value.documentRevision : undefined;
  if (
    typeof documentRevision !== "number" ||
    !Number.isSafeInteger(documentRevision) ||
    documentRevision < 1
  )
    return controlError("menu_publication_invalid", 422);
  // No `hours` field keeps the menu's hours; null makes it all day.
  const rawHours = body.ok ? body.value.hours : undefined;
  const hours =
    rawHours === undefined || rawHours === null
      ? rawHours
      : parseMenuHours(rawHours);
  if (hours === null && rawHours !== null)
    return controlError("menu_publication_invalid", 422);
  const merchant = await resolveMerchantControlContext(env, authorized);
  if (merchant instanceof Response) return merchant;

  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now: Date.now(),
  });
  const stored = await organisation.readMenuDraft({
    organisationId: authorized.organisationId,
  });
  if (!stored.ok) return controlError("menu_draft_unavailable", 503);
  // Another editor may have changed the menu since the owner looked at it.
  if (stored.value.revision !== documentRevision)
    return controlJson(
      {
        ok: false,
        error: "menu_draft_changed",
        documentRevision: stored.value.revision,
      },
      409,
    );
  const draft = stored.value.draft;

  const [storefront, stock] = await Promise.all([
    merchant.client.readStorefront(merchant.merchantId, CAFE_STOREFRONT_ID),
    merchant.client.readStockSnapshot(merchant.merchantId),
  ]);
  if (!stock.ok) return controlError("commerce_unavailable", 503);
  if (!storefront.ok || storefront.value.fulfillment.kind !== "pickup")
    return controlError("cafe_storefront_missing", 409);
  const cafe = {
    salesChannelId: storefront.value.salesChannelId,
    locationId: storefront.value.fulfillment.locationId,
  };
  const plan = planCafeMenu(draft, stock.value, cafe);
  if (plan.kind === "empty") return controlError("menu_draft_empty", 422);
  if (plan.kind === "not_sellable")
    return controlJson(
      { ok: false, error: "menu_items_not_sellable", items: plan.items },
      422,
    );

  const expectedMenuRevision = plan.expectedMenuRevision;
  // A repeated click on the same draft and menu revision replays.
  const idempotencyKey = `menu_publication_${(
    await sha256Hex(
      `${authorized.organisationId}:${documentRevision}:${expectedMenuRevision ?? 0}:${JSON.stringify(hours ?? null)}`,
    )
  ).slice(0, 32)}`;
  const result = await merchant.client.publishMenu({
    merchantId: merchant.merchantId,
    expectedMerchantRevision: stock.value.commerce.merchantRevision,
    idempotencyKey,
    menu: {
      ...plan.menu,
      validity:
        hours === undefined
          ? plan.menu.validity
          : hours === null
            ? { kind: "always" }
            : {
                kind: "schedule",
                timeZone: hours.timeZone,
                slots: hours.slots.map((slot) => ({
                  days: [...slot.days],
                  startsAt: slot.startsAt,
                  endsAt: slot.endsAt,
                })),
              },
    },
    ...(expectedMenuRevision === undefined ? {} : { expectedMenuRevision }),
  });
  if (!result.ok) return controlError("commerce_unavailable", 503);
  if (result.value.outcome === "rejected")
    return controlJson(
      {
        ok: false,
        error:
          "field" in result.value.error &&
          result.value.error.field === "menu.validity"
            ? "menu_hours_invalid"
            : result.value.error.code === "stale_merchant_revision" ||
                result.value.error.code === "stale_resource_revision"
              ? "menu_publication_conflict"
              : "menu_publication_refused",
        detail: result.value.error.code,
      },
      409,
    );
  // The shop's screens show the new menu now; Commerce's event follows.
  await organisation
    .signalMenuScreens({ organisationId: authorized.organisationId })
    .catch(ignoreSignalFailure);
  return controlJson({
    ok: true,
    menu: {
      menuId: CAFE_MENU_ID,
      revision: (expectedMenuRevision ?? 0) + 1,
      entries: plan.menu.entries.length,
      documentRevision,
    },
  });
}

async function readCafeMenuOptions(
  request: Request,
  env: Env,
  route: CommerceMenuPublicationControlRoute,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const merchant = await resolveMerchantControlContext(env, authorized);
  if (merchant instanceof Response) return merchant;
  const [storefront, stock, shopName, library] = await Promise.all([
    merchant.client.readStorefront(merchant.merchantId, CAFE_STOREFRONT_ID),
    merchant.client.readStockSnapshot(merchant.merchantId),
    merchant.client.readStorefrontShopName(
      merchant.merchantId,
      CAFE_STOREFRONT_ID,
    ),
    merchant.client.listMedia(merchant.merchantId),
  ]);
  if (!stock.ok) return controlError("commerce_unavailable", 503);
  if (!storefront.ok || storefront.value.fulfillment.kind !== "pickup")
    return controlError("cafe_storefront_missing", 409);
  const cafe = {
    salesChannelId: storefront.value.salesChannelId,
    locationId: storefront.value.fulfillment.locationId,
  };
  const published = publishedCafeMenu(stock.value);
  // A Commerce without shop names still serves the menu page.
  const name = shopName.ok ? shopName.value.name : null;
  // A failed photo read leaves the products without photos.
  const base = env.COMMERCE_BASE_URL;
  const photos =
    library.ok && base !== undefined
      ? cafeProductPhotos(library.value, base, merchant.merchantId)
      : new Map();
  const products = stock.value.commerce.resources.products.flatMap((product) =>
    product.status === "active" &&
    cafeMenuEntry(
      stock.value,
      cafe,
      {
        id: "item_option",
        productId: product.id,
        displayName: product.title,
        description: "",
        placement: { sectionId: "section_option", order: 0 },
      },
      undefined,
    ) !== null
      ? [
          {
            productId: product.id,
            title: product.title,
            image: photos.get(product.id) ?? null,
          },
        ]
      : [],
  );
  return controlJson({
    ok: true,
    products,
    shopUrl: orderPageUrl(env, merchant.merchantId, name),
    shopName: shopNameAddress(env, name),
    published:
      published === undefined
        ? null
        : { revision: published.revision, entries: published.entries.length },
    hours:
      published?.validity.kind === "schedule"
        ? {
            timeZone: published.validity.timeZone,
            slots: published.validity.slots,
          }
        : null,
  });
}

/** Commerce serves each shop's café page at `/shops/<merchantId>`. */
function hostedShopUrl(env: Env, merchantId: string): string | null {
  const base = env.COMMERCE_BASE_URL?.trim();
  if (base === undefined || base.length === 0) return null;
  return `${base.replace(/\/+$/u, "")}/shops/${encodeURIComponent(merchantId)}`;
}

/**
 * The address of a shop's QR order page (Plan 40B phase 2): its shop name
 * under the order page domain, or the hosted page while it has no name.
 */
export function orderPageUrl(
  env: Env,
  merchantId: string,
  shopName: string | null,
): string | null {
  const origin = orderPageOrigin(env, shopName);
  return origin === null ? hostedShopUrl(env, merchantId) : `${origin}/`;
}

function orderPageOrigin(env: Env, shopName: string | null): string | null {
  const template = env.SHOP_ORDER_PAGE_ORIGIN?.trim();
  if (
    shopName === null ||
    template === undefined ||
    !template.includes("{name}")
  )
    return null;
  return template.replace("{name}", shopName);
}

/**
 * The shop name and the order page address around it, for the Menus page;
 * null when this deployment serves no order page domain.
 */
function shopNameAddress(
  env: Env,
  name: string | null,
): Readonly<{ name: string | null; prefix: string; suffix: string }> | null {
  const template = env.SHOP_ORDER_PAGE_ORIGIN?.trim();
  if (template === undefined || !template.includes("{name}")) return null;
  const [prefix = "", suffix = ""] = template.split("{name}");
  return { name, prefix, suffix };
}

/**
 * Takes a shop name for the shop's café storefront. Commerce refuses a
 * name of the wrong form, a reserved name, another shop's name and one name
 * too many; the shop's screens then show the new address in their QR code.
 */
async function setShopName(
  request: Request,
  env: Env,
  route: CommerceMenuPublicationControlRoute,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  const name = body.ok ? body.value.name : undefined;
  if (typeof name !== "string" || name.length > 64)
    return controlError("shop_name_invalid", 422);
  const merchant = await resolveMerchantControlContext(env, authorized);
  if (merchant instanceof Response) return merchant;
  const result = await merchant.client.setStorefrontShopName(
    merchant.merchantId,
    CAFE_STOREFRONT_ID,
    name,
  );
  if (!result.ok) return controlError("commerce_unavailable", 503);
  if (result.value.outcome === "refused")
    return controlError(
      `shop_name_${result.value.reason}`,
      result.value.reason === "taken" || result.value.reason === "limit"
        ? 409
        : 422,
    );
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now: Date.now(),
  });
  await organisation
    .signalMenuScreens({ organisationId: authorized.organisationId })
    .catch(ignoreSignalFailure);
  const shopName = result.value.shopName;
  return controlJson({
    ok: true,
    shopName: shopNameAddress(env, shopName.name),
    previousNames: shopName.previousNames,
    shopUrl: orderPageUrl(env, merchant.merchantId, shopName.name),
  });
}

/** A lost signal costs the screens a later read, never the publication. */
function ignoreSignalFailure(): number {
  return 0;
}
