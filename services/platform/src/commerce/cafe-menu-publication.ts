// What a café menu publication sends to Commerce. A person's publication
// and an agent's approved one read the shared menu draft through this code,
// so both check the same items against the same stock facts.
import type {
  PublishMenuCommand,
  CommerceMediaLibraryV1,
  CommerceStockSnapshot,
} from "@seams/commerce-client";
import type { MenuDraftSnapshot } from "@seams/menu-draft-crdt";
import { cafeMediaBaseFor } from "./cafe-media";
import { productPhotos } from "./inventory-overview";

export type CafeMenuDefinition = PublishMenuCommand["menu"];
type MenuEntryInput = CafeMenuDefinition["entries"][number];
type PublishedMenu =
  CommerceStockSnapshot["foodService"]["resources"]["menus"][number];
type Cafe = Readonly<{ salesChannelId: string; locationId: string }>;

/** The café storefront that every Pantry shop is provisioned with. */
export const CAFE_STOREFRONT_ID = "storefront_cafe";
export const CAFE_MENU_ID = "menu_cafe_main";

export type CafeMenuPlan =
  | Readonly<{
      kind: "ready";
      menu: CafeMenuDefinition;
      expectedMenuRevision: number | undefined;
      merchantRevision: number;
      /** The titles of the published entries that this menu no longer has. */
      removedNames: readonly string[];
      /** The entries that the published menu does not have yet. */
      addedEntryIds: readonly string[];
    }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "not_sellable"; items: readonly string[] }>;

/** The published café menu, when the shop has one. */
export function publishedCafeMenu(
  stock: CommerceStockSnapshot,
): PublishedMenu | undefined {
  return stock.foodService.resources.menus.find(
    (menu) => menu.menuId === CAFE_MENU_ID,
  );
}

/**
 * The Commerce menu of one draft: each item's listed offer in the café's
 * sales channel, with its plan, in sections that hold an item.
 */
export function planCafeMenu(
  draft: MenuDraftSnapshot,
  stock: CommerceStockSnapshot,
  cafe: Cafe,
): CafeMenuPlan {
  if (draft.items.length === 0) return { kind: "empty" };
  const published = publishedCafeMenu(stock);
  const entries: MenuEntryInput[] = [];
  const unsellable: string[] = [];
  for (const item of draft.items) {
    const entry = cafeMenuEntry(stock, cafe, item, published);
    if (entry === null) unsellable.push(item.displayName);
    else entries.push(entry);
  }
  if (unsellable.length > 0) return { kind: "not_sellable", items: unsellable };
  const sectionIds = new Set(entries.map((entry) => entry.sectionId));
  const sections = draft.sections
    .filter((section) => sectionIds.has(section.id))
    .map((section, position) => ({
      sectionId: section.id,
      name: section.title.trim().length > 0 ? section.title.trim() : "Menu",
      position,
    }));
  const offers = new Set(entries.map((entry) => entry.offerId));
  const publishedOffers = new Set(
    published?.entries.map((entry) => entry.offerId) ?? [],
  );
  return {
    kind: "ready",
    menu: {
      menuId: CAFE_MENU_ID,
      name: menuName(draft),
      salesChannelId: cafe.salesChannelId,
      scope: { kind: "location", locationId: cafe.locationId },
      // A publication keeps the serving hours; only a person sets new ones.
      validity: published?.validity ?? { kind: "always" },
      sections,
      entries,
    },
    expectedMenuRevision: published?.revision,
    merchantRevision: stock.commerce.merchantRevision,
    removedNames: (published?.entries ?? [])
      .filter((entry) => !offers.has(entry.offerId))
      .map((entry) => offerTitle(stock, entry.offerId)),
    addedEntryIds: entries
      .filter((entry) => !publishedOffers.has(entry.offerId))
      .map((entry) => entry.menuEntryId),
  };
}

function offerTitle(stock: CommerceStockSnapshot, offerId: string): string {
  const offer = stock.commerce.resources.offers.find(
    (candidate) => candidate.id === offerId,
  );
  const variant = stock.commerce.resources.variants.find(
    (candidate) => candidate.id === offer?.variantId,
  );
  const product = stock.commerce.resources.products.find(
    (candidate) => candidate.id === variant?.productId,
  );
  return product?.title ?? offerId;
}

/**
 * The café entry of a draft item: the product's listed offer in the café
 * sales channel and the variant's active consumption plan at the café. An
 * entry that the published menu already sells keeps its modifier groups.
 */
export function cafeMenuEntry(
  stock: CommerceStockSnapshot,
  cafe: Cafe,
  item: MenuDraftSnapshot["items"][number],
  published: PublishedMenu | undefined,
): MenuEntryInput | null {
  const variants = new Set(
    stock.commerce.resources.variants
      .filter((variant) => variant.productId === item.productId)
      .map((variant) => variant.id),
  );
  for (const offer of stock.commerce.resources.offers) {
    if (
      !variants.has(offer.variantId) ||
      offer.salesChannelId !== cafe.salesChannelId ||
      offer.lifecycle.state !== "listed"
    )
      continue;
    const plan = stock.consumptionPlans.find(
      (candidate) =>
        candidate.variantId === offer.variantId &&
        candidate.lifecycle === "active" &&
        planSellsAtCafe(candidate) &&
        (candidate.scope.kind === "organisation" ||
          candidate.scope.locationId === cafe.locationId),
    );
    if (plan === undefined) continue;
    const kept = published?.entries.find((entry) => entry.offerId === offer.id);
    return {
      menuEntryId: item.id,
      sectionId: item.placement.sectionId,
      offerId: offer.id,
      offerRevision: offer.revision,
      consumptionPlanId: plan.consumptionPlanId,
      consumptionPlanRevision: plan.revision,
      modifierGroupRevisions: kept?.modifierGroupRevisions ?? [],
    };
  }
  return null;
}

/**
 * Each product's first photo in the café's shop, by product (Plan 40B,
 * product photos), at the address that the café storefront serves it; the
 * board editor's Products panel shows it.
 */
export function cafeProductPhotos(
  library: CommerceMediaLibraryV1,
  commerceBase: string,
  merchantId: string,
): ReadonlyMap<string, Readonly<{ url: string; altText: string }>> {
  const photos = productPhotos(
    library,
    cafeMediaBaseFor(commerceBase, merchantId).replace(/\/$/u, ""),
  );
  const first = new Map<string, Readonly<{ url: string; altText: string }>>();
  for (const [productId, product] of photos) {
    const photo = product.items[0];
    if (photo !== undefined)
      first.set(productId, { url: photo.url, altText: photo.altText });
  }
  return first;
}

/**
 * A buyer sees a menu entry only when its plan tracks stock, and a direct
 * plan takes stock when the order is fulfilled.
 */
function planSellsAtCafe(
  plan: CommerceStockSnapshot["consumptionPlans"][number],
): boolean {
  return (
    plan.mode.kind !== "untracked" &&
    (plan.mode.kind !== "direct" ||
      plan.mode.commitOn === "fulfillment_completed")
  );
}

function menuName(draft: MenuDraftSnapshot): string {
  const title = draft.title.trim();
  return title.length > 0 ? title : "Café menu";
}
