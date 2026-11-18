import { selectInventoryConsumptionPlan } from "@seams/contracts";
import type {
  InventoryData,
  ProductDeleteBlock,
  ProductPhotos,
  StockRow,
  StockStatus,
  StockPolicy,
  Quantity,
} from "@seams/contracts";
import { productDeleteBlock } from "@seams/commerce-client";
import type {
  CommerceResourcesV1,
  CommerceMediaLibraryV1,
  CommerceInventoryPositionV1,
  CommerceStockSnapshot,
} from "@seams/commerce-client";

export function inventoryQuantity(quantity: Quantity): string {
  const units = {
    each: "each",
    gram: "g",
    kilogram: "kg",
    milliliter: "ml",
    liter: "L",
  };
  return `${(quantity.amount / 10 ** quantity.scale).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${units[quantity.unit]}`;
}

const NO_PHOTOS: ProductPhotos = { revision: 0, items: [] };

/**
 * Each product's photos in the shop's order. A buyer reads the same public
 * address, so the Portal shows the bytes that the shop's catalog names.
 */
export function productPhotos(
  library: CommerceMediaLibraryV1,
  publicImageBase: string,
): ReadonlyMap<string, ProductPhotos> {
  const media = new Map(library.media.map((item) => [item.id, item]));
  const photos = new Map<string, ProductPhotos>();
  for (const product of library.products) {
    const items = [];
    for (const entry of product.media) {
      const image = media.get(entry.mediaId);
      if (image === undefined) continue;
      items.push({
        mediaId: image.id,
        url: `${publicImageBase}/${encodeURIComponent(image.id)}?v=${image.sha256.slice(0, 16)}`,
        altText: image.altText,
      });
    }
    photos.set(product.productId, { revision: product.revision, items });
  }
  return photos;
}

export function connectedStockOverview(
  snapshot: CommerceStockSnapshot,
  photos: ReadonlyMap<string, ProductPhotos> = new Map(),
): InventoryData {
  const photosOf = (productId: string): ProductPhotos =>
    photos.get(productId) ?? NO_PHOTOS;
  const resources = snapshot.commerce.resources;
  const offers = saleOffers(resources);
  const archivedVariants = archivedVariantIds(resources);
  const deleteBlocks = new Map<string, ProductDeleteBlock>();
  const deleteBlockOf = (productId: string): ProductDeleteBlock => {
    const known = deleteBlocks.get(productId);
    if (known !== undefined) return known;
    const block = productDeleteBlock(
      productId,
      resources,
      snapshot.foodService.resources.menus,
    );
    deleteBlocks.set(productId, block);
    return block;
  };
  const rows = inventoryOverview(
    resources,
    snapshot.foodService.resources.stockPolicies,
  );
  for (const row of rows) {
    if (row.positionId === null) continue;
    row.recipeCount = snapshot.foodService.resources.recipeRevisions.filter(
      recipeProducesItem.bind(null, row.inventoryItemId),
    ).length;
    const usable = snapshot.usable.find(
      usablePosition.bind(null, row.positionId),
    );
    if (usable === undefined)
      throw new Error("Sellable inventory is unavailable");
    row.available = inventoryQuantity(usable.quantity);
    const policy = currentPolicy(
      snapshot.foodService.resources.stockPolicies,
      row.inventoryItemId,
      row.locationId,
    );
    row.status = inventoryStockStatus(
      usable.quantity,
      policy?.replenishment.kind === "threshold"
        ? policy.replenishment.reorderPoint
        : null,
    );
  }
  for (const row of rows) {
    row.movements = snapshot.movements
      .filter(movementForRow.bind(null, row.inventoryItemId, row.locationId))
      .sort(recentMovementFirst)
      .slice(0, 10)
      .map(movementSummary);
    row.reservations = snapshot.allocations
      .filter(reservationForRow.bind(null, row.inventoryItemId, row.locationId))
      .map(reservationSummary);
  }
  const result: StockRow[] = [];
  const linkedVariants = new Set<string>();
  const productsById = new Map(resources.products.map(productEntry));
  for (const row of rows) {
    if (row.category !== "finished_good") {
      const lots = stockLots(snapshot, row.inventoryItemId, row.locationId);
      result.push({
        ...row,
        kind: "supply",
        category: row.category,
        product: null,
        lots,
      });
      continue;
    }
    let mapped = false;
    let archived = false;
    for (const variant of resources.variants) {
      const offer = offers.get(variant.id);
      const variantArchived = archivedVariants.has(variant.id);
      if (offer === undefined && !variantArchived) continue;
      const plan = selectInventoryConsumptionPlan(
        snapshot.consumptionPlans,
        variant.id,
        row.locationId,
      );
      if (plan === undefined || plan.mode.kind !== "direct") continue;
      let consumesItem = false;
      for (const component of plan.mode.components) {
        if (component.inventoryItemId === row.inventoryItemId)
          consumesItem = true;
      }
      if (consumesItem && variantArchived) archived = true;
      const product = productsById.get(variant.productId);
      if (!consumesItem || product === undefined || offer === undefined)
        continue;
      linkedVariants.add(variant.id);
      mapped = true;
      const name = variantDisplayName(product.title, variant.title);
      result.push({
        ...row,
        id: JSON.stringify([row.id, variant.id]),
        name,
        kind: "product",
        category: "finished_good",
        product: {
          ...saleLink(product, variant, offer, deleteBlockOf(product.id)),
          price: offer.price,
          description: product.description,
          image: variantImage(variant) ?? firstPhoto(photosOf(product.id)),
          photos: photosOf(product.id),
        },
        lots: stockLots(snapshot, row.inventoryItemId, row.locationId),
      });
    }
    // Stock of an archived product is no longer a product on sale, and its
    // link is not missing.
    if (!mapped && !archived)
      result.push({
        ...row,
        kind: "unlinked_product",
        category: "finished_good",
        product: null,
        lots: stockLots(snapshot, row.inventoryItemId, row.locationId),
      });
  }
  const untrackedProducts = [];
  for (const variant of resources.variants) {
    const offer = offers.get(variant.id);
    if (offer === undefined || linkedVariants.has(variant.id)) continue;
    const product = productsById.get(variant.productId);
    if (product === undefined) continue;
    const name = variantDisplayName(product.title, variant.title);
    untrackedProducts.push({
      ...saleLink(product, variant, offer, deleteBlockOf(product.id)),
      price: offer.price,
      description: product.description,
      image: variantImage(variant) ?? firstPhoto(photosOf(product.id)),
      photos: photosOf(product.id),
      name,
      madeToOrder: snapshot.consumptionPlans.some(
        preparedPlanForVariant.bind(null, variant.id),
      ),
    });
  }
  const archivedProducts = resources.products
    .filter((product) => product.status === "archived")
    .map((product) => ({
      productId: product.id,
      title: product.title,
      revision: product.revision,
      deleteBlock: deleteBlockOf(product.id),
      image: firstPhoto(photosOf(product.id)),
      photos: photosOf(product.id),
    }));
  return { rows: result, untrackedProducts, archivedProducts };
}

function firstPhoto(
  photos: ProductPhotos,
): Readonly<{ url: string; altText: string }> | null {
  const first = photos.items[0];
  return first === undefined
    ? null
    : { url: first.url, altText: first.altText };
}

function saleLink(
  product: CommerceResourcesV1["products"][number],
  variant: CommerceResourcesV1["variants"][number],
  offer: CommerceResourcesV1["offers"][number],
  deleteBlock: ProductDeleteBlock,
) {
  return {
    productId: product.id,
    productTitle: product.title,
    productRevision: product.revision,
    deleteBlock,
    variantId: variant.id,
    variantTitle: variant.title,
    variantRevision: variant.revision,
    offerId: offer.id,
    offerRevision: offer.revision,
  };
}

function variantImage(
  variant: CommerceResourcesV1["variants"][number],
): Readonly<{ url: string; altText: string }> | null {
  for (const media of variant.media)
    if (media.kind === "image")
      return { url: media.url, altText: media.altText };
  return null;
}

function preparedPlanForVariant(
  variantId: string,
  plan: CommerceStockSnapshot["consumptionPlans"][number],
): boolean {
  return (
    plan.variantId === variantId &&
    plan.lifecycle === "active" &&
    plan.mode.kind === "prepared"
  );
}

function variantDisplayName(
  productTitle: string,
  variantTitle: string,
): string {
  return variantTitle === productTitle
    ? productTitle
    : `${productTitle} · ${variantTitle}`;
}

function productEntry(
  product: CommerceResourcesV1["products"][number],
): [string, CommerceResourcesV1["products"][number]] {
  return [product.id, product];
}

/**
 * The offer of each variant that a storefront can show: an active product and
 * variant with a listed offer on an ecommerce channel.
 */
export function saleOffers(
  resources: Pick<
    CommerceResourcesV1,
    "salesChannels" | "offers" | "products" | "variants"
  >,
): ReadonlyMap<string, CommerceResourcesV1["offers"][number]> {
  const channels = new Set<string>();
  for (const channel of resources.salesChannels) {
    if (
      channel.kind === "online" ||
      channel.kind === "marketplace" ||
      channel.kind === "agent"
    )
      channels.add(channel.id);
  }
  const activeProducts = new Set<string>();
  for (const product of resources.products)
    if (product.status === "active") activeProducts.add(product.id);
  const activeVariants = new Set<string>();
  for (const variant of resources.variants)
    if (variant.status === "active" && activeProducts.has(variant.productId))
      activeVariants.add(variant.id);
  const offers = new Map<
    string,
    CommerceResourcesV1["offers"][number]
  >();
  for (const offer of resources.offers) {
    if (
      channels.has(offer.salesChannelId) &&
      offer.lifecycle.state === "listed" &&
      activeVariants.has(offer.variantId)
    )
      offers.set(offer.variantId, offer);
  }
  return offers;
}

function archivedVariantIds(
  resources: Pick<CommerceResourcesV1, "products" | "variants">,
): ReadonlySet<string> {
  const archivedProducts = new Set<string>();
  for (const product of resources.products)
    if (product.status === "archived") archivedProducts.add(product.id);
  const variants = new Set<string>();
  for (const variant of resources.variants)
    if (
      variant.status === "archived" ||
      archivedProducts.has(variant.productId)
    )
      variants.add(variant.id);
  return variants;
}

function comparableQuantity(quantity: Quantity): number {
  const multiplier =
    quantity.unit === "kilogram" || quantity.unit === "liter" ? 1000 : 1;
  return (quantity.amount / 10 ** quantity.scale) * multiplier;
}

function dimension(quantity: Quantity): string {
  switch (quantity.unit) {
    case "gram":
    case "kilogram":
      return "mass";
    case "milliliter":
    case "liter":
      return "volume";
    case "each":
      return "count";
  }
}

export function inventoryStockStatus(
  available: Quantity | null,
  reorderPoint: Quantity | null,
): StockStatus {
  if (available === null) return "uncounted";
  if (available.amount <= 0) return "out";
  if (reorderPoint === null || dimension(available) !== dimension(reorderPoint))
    return "unconfigured";
  return comparableQuantity(available) <= comparableQuantity(reorderPoint)
    ? "low"
    : "healthy";
}

function positionForItem(
  id: string,
  position: CommerceInventoryPositionV1,
): boolean {
  return position.inventoryItemId === id;
}

function currentPolicy(
  policies: readonly StockPolicy[],
  itemId: string,
  locationId: string | null,
): StockPolicy | null {
  let current: StockPolicy | null = null;
  for (const policy of policies) {
    if (policy.inventoryItemId !== itemId || policy.locationId !== locationId)
      continue;
    if (current === null || policy.revision > current.revision)
      current = policy;
  }
  return current?.lifecycle === "active" ? current : null;
}

export function inventoryOverview(
  resources: Pick<
    CommerceResourcesV1,
    "inventoryItems" | "inventoryPositions" | "locations"
  >,
  policies: readonly StockPolicy[],
) {
  const rows = [];
  for (const item of resources.inventoryItems) {
    if (item.lifecycle !== "active") continue;
    const positions = resources.inventoryPositions.filter(
      positionForItem.bind(null, item.id),
    );
    for (const position of positions.length > 0 ? positions : [null]) {
      const policy = currentPolicy(
        policies,
        item.id,
        position?.locationId ?? null,
      );
      const threshold =
        policy?.replenishment.kind === "threshold"
          ? policy.replenishment
          : null;
      const available = position?.balance.available ?? null;
      const status = inventoryStockStatus(
        available,
        threshold?.reorderPoint ?? null,
      );
      let locationName = "No location recorded";
      for (const location of resources.locations) {
        if (location.id === position?.locationId) locationName = location.name;
      }
      const movements: StockRow["movements"] = [];
      const reservations: StockRow["reservations"] = [];
      rows.push({
        id: position?.id ?? item.id,
        inventoryItemId: item.id,
        positionId: position?.id ?? null,
        recipeCount: 0,
        movements,
        reservations,
        locationId: position?.locationId ?? null,
        name: item.name,
        category: item.category,
        location: locationName,
        onHand:
          position?.balance.kind === "accounted"
            ? inventoryQuantity(position.balance.onHand)
            : null,
        allocated:
          position?.balance.kind === "accounted"
            ? inventoryQuantity(position.balance.allocated)
            : null,
        available: available === null ? null : inventoryQuantity(available),
        reorderPoint:
          threshold === null ? null : inventoryQuantity(threshold.reorderPoint),
        target:
          threshold === null
            ? null
            : inventoryQuantity(threshold.targetQuantity),
        status,
      });
    }
  }
  return rows;
}

function stockLots(
  snapshot: CommerceStockSnapshot,
  itemId: string,
  locationId: string | null,
) {
  const lots = [];
  for (const lot of snapshot.lots) {
    if (lot.inventoryItemId !== itemId || lot.locationId !== locationId)
      continue;
    lots.push({
      id: lot.id,
      code: lot.lotCode,
      remaining: inventoryQuantity(lot.remainingQuantity),
      expiresAt: lot.expiry.kind === "expires" ? lot.expiry.expiresAt : null,
      status: lot.lifecycle.state,
    });
  }
  return lots;
}

function usablePosition(
  id: string,
  value: CommerceStockSnapshot["usable"][number],
): boolean {
  return value.positionId === id;
}

function recipeProducesItem(
  id: string,
  recipe: CommerceStockSnapshot["foodService"]["resources"]["recipeRevisions"][number],
): boolean {
  return (
    recipe.lifecycle.state === "active" &&
    recipe.output.kind === "stocked" &&
    recipe.output.inventoryItemId === id
  );
}

function movementForRow(
  itemId: string,
  locationId: string | null,
  movement: CommerceStockSnapshot["movements"][number],
): boolean {
  return (
    movement.inventoryItemId === itemId && movement.locationId === locationId
  );
}
function recentMovementFirst(
  left: CommerceStockSnapshot["movements"][number],
  right: CommerceStockSnapshot["movements"][number],
): number {
  return (
    right.occurredAt.localeCompare(left.occurredAt) ||
    right.id.localeCompare(left.id)
  );
}
function movementSummary(
  movement: CommerceStockSnapshot["movements"][number],
): StockRow["movements"][number] {
  return {
    id: movement.id,
    direction: movement.change.kind,
    quantity: inventoryQuantity(movement.change.quantity),
    reason: movement.change.reason.kind,
    occurredAt: movement.occurredAt,
  };
}
function reservationForRow(
  itemId: string,
  locationId: string | null,
  allocation: CommerceStockSnapshot["allocations"][number],
): boolean {
  return (
    allocation.inventoryItemId === itemId &&
    allocation.locationId === locationId &&
    (allocation.lifecycle.state === "held" ||
      allocation.lifecycle.state === "allocated_to_order")
  );
}
function reservationSummary(
  allocation: CommerceStockSnapshot["allocations"][number],
): StockRow["reservations"][number] {
  const lifecycle = allocation.lifecycle;
  if (lifecycle.state !== "held" && lifecycle.state !== "allocated_to_order")
    throw new Error("Reservation is no longer active");
  return {
    id: String(allocation.allocationId),
    orderId:
      lifecycle.state === "allocated_to_order"
        ? String(lifecycle.orderId)
        : null,
    state: lifecycle.state,
    quantity: inventoryQuantity(allocation.quantity),
  };
}
