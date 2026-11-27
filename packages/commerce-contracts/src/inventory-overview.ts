import { isRecord } from "@purin-labs/std";

export type StockStatus =
  "uncounted" | "out" | "low" | "healthy" | "unconfigured";
export type ProductDeleteBlock = "sold" | "on_menu" | null;
type ProductPhoto = Readonly<{
  mediaId: string;
  url: string;
  altText: string;
}>;
/** A product's photos in the shop's order; revision 0 before the first. */
export type ProductPhotos = Readonly<{
  revision: number;
  items: readonly ProductPhoto[];
}>;
type ProductLink = Readonly<{
  productId: string;
  productTitle: string;
  productRevision: number;
  deleteBlock: ProductDeleteBlock;
  variantId: string;
  variantTitle: string;
  variantRevision: number;
  offerId: string;
  offerRevision: number;
  price: Readonly<{ amountMinor: number; currency: string }>;
  description: string;
  image: Readonly<{ url: string; altText: string }> | null;
  photos: ProductPhotos;
}>;
export type StockLot = Readonly<{
  id: string;
  code: string;
  remaining: string;
  expiresAt: string | null;
  status: string;
}>;
type StockBalance = Readonly<{
  id: string;
  inventoryItemId: string;
  positionId: string | null;
  recipeCount: number;
  locationId: string | null;
  name: string;
  location: string;
  onHand: string | null;
  allocated: string | null;
  available: string | null;
  reorderPoint: string | null;
  target: string | null;
  status: StockStatus;
  lots: readonly StockLot[];
  movements: readonly {
    id: string;
    direction: "increase" | "decrease";
    quantity: string;
    reason: string;
    occurredAt: string;
  }[];
  reservations: readonly {
    id: string;
    orderId: string | null;
    state: "held" | "allocated_to_order";
    quantity: string;
  }[];
}>;
export type StockRow = StockBalance &
  (
    | Readonly<{
        kind: "supply";
        category: "ingredient" | "packaging" | "operating_supply";
        product: null;
      }>
    | Readonly<{
        kind: "product";
        category: "finished_good";
        product: ProductLink;
      }>
    | Readonly<{
        kind: "unlinked_product";
        category: "finished_good";
        product: null;
      }>
  );
export type InventoryData = Readonly<{
  rows: readonly StockRow[];
  untrackedProducts: readonly (ProductLink &
    Readonly<{ name: string; madeToOrder: boolean }>)[];
  /** Off sale, and off the rows and the untracked list. */
  archivedProducts: readonly ArchivedProduct[];
}>;
export type ArchivedProduct = Readonly<{
  productId: string;
  title: string;
  revision: number;
  deleteBlock: ProductDeleteBlock;
  image: Readonly<{ url: string; altText: string }> | null;
  photos: ProductPhotos;
}>;
function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
function stockCategory(value: unknown): value is StockRow["category"] {
  return (
    value === "ingredient" ||
    value === "packaging" ||
    value === "finished_good" ||
    value === "operating_supply"
  );
}
function stockStatus(value: unknown): value is StockStatus {
  return (
    value === "uncounted" ||
    value === "out" ||
    value === "low" ||
    value === "healthy" ||
    value === "unconfigured"
  );
}
function parseRow(value: unknown): StockRow {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.inventoryItemId !== "string" ||
    !nullableText(value.locationId) ||
    !nullableText(value.positionId) ||
    !Number.isSafeInteger(value.recipeCount) ||
    Number(value.recipeCount) < 0 ||
    typeof value.name !== "string" ||
    !stockCategory(value.category) ||
    typeof value.location !== "string" ||
    !nullableText(value.onHand) ||
    !nullableText(value.allocated) ||
    !nullableText(value.available) ||
    !nullableText(value.reorderPoint) ||
    !nullableText(value.target) ||
    !stockStatus(value.status) ||
    !Array.isArray(value.lots) ||
    !Array.isArray(value.movements) ||
    !Array.isArray(value.reservations)
  )
    throw new Error("Invalid stock data");
  const balance: StockBalance = {
    id: value.id,
    inventoryItemId: value.inventoryItemId,
    positionId: value.positionId,
    recipeCount: Number(value.recipeCount),
    locationId: value.locationId,
    name: value.name,
    location: value.location,
    onHand: value.onHand,
    allocated: value.allocated,
    available: value.available,
    reorderPoint: value.reorderPoint,
    target: value.target,
    status: value.status,
    lots: value.lots.map(parseStockLot),
    movements: value.movements.map(parseStockMovement),
    reservations: value.reservations.map(parseStockReservation),
  };
  if (
    value.kind === "unlinked_product" &&
    value.category === "finished_good" &&
    value.product === null
  )
    return {
      ...balance,
      kind: "unlinked_product",
      category: "finished_good",
      product: null,
    };
  if (value.kind === "product" && value.category === "finished_good")
    return {
      ...balance,
      kind: "product",
      category: "finished_good",
      product: parseProductLink(value.product),
    };
  if (
    value.kind === "supply" &&
    value.category !== "finished_good" &&
    value.product === null
  )
    return {
      ...balance,
      kind: "supply",
      category: value.category,
      product: null,
    };
  throw new Error("Invalid stock row kind");
}
function positiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function deleteBlock(value: unknown): value is ProductDeleteBlock {
  return value === null || value === "sold" || value === "on_menu";
}
function parseProductPhotos(value: unknown): ProductPhotos {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !Array.isArray(value.items)
  )
    throw new Error("Invalid product photos");
  return {
    revision: Number(value.revision),
    items: value.items.map(parseProductPhoto),
  };
}
function parseProductPhoto(value: unknown): ProductPhoto {
  if (
    !isRecord(value) ||
    typeof value.mediaId !== "string" ||
    typeof value.url !== "string" ||
    typeof value.altText !== "string"
  )
    throw new Error("Invalid product photo");
  return { mediaId: value.mediaId, url: value.url, altText: value.altText };
}
function parseArchivedProduct(value: unknown): ArchivedProduct {
  if (
    !isRecord(value) ||
    typeof value.productId !== "string" ||
    typeof value.title !== "string" ||
    !positiveRevision(value.revision) ||
    !deleteBlock(value.deleteBlock) ||
    !(
      value.image === null ||
      (isRecord(value.image) &&
        typeof value.image.url === "string" &&
        typeof value.image.altText === "string")
    )
  )
    throw new Error("Invalid archived product");
  return {
    productId: value.productId,
    title: value.title,
    revision: value.revision,
    deleteBlock: value.deleteBlock,
    image:
      value.image === null
        ? null
        : {
            url: String(value.image.url),
            altText: String(value.image.altText),
          },
    photos: parseProductPhotos(value.photos),
  };
}
function parseProductLink(value: unknown): ProductLink {
  if (
    !isRecord(value) ||
    typeof value.productId !== "string" ||
    typeof value.productTitle !== "string" ||
    !positiveRevision(value.productRevision) ||
    !deleteBlock(value.deleteBlock) ||
    typeof value.variantId !== "string" ||
    typeof value.variantTitle !== "string" ||
    !positiveRevision(value.variantRevision) ||
    typeof value.offerId !== "string" ||
    !positiveRevision(value.offerRevision) ||
    !isRecord(value.price) ||
    !Number.isSafeInteger(value.price.amountMinor) ||
    typeof value.price.currency !== "string" ||
    typeof value.description !== "string" ||
    !(
      value.image === null ||
      (isRecord(value.image) &&
        typeof value.image.url === "string" &&
        typeof value.image.altText === "string")
    )
  )
    throw new Error("Invalid product link");
  return {
    productId: value.productId,
    productTitle: value.productTitle,
    productRevision: value.productRevision,
    deleteBlock: value.deleteBlock,
    variantId: value.variantId,
    variantTitle: value.variantTitle,
    variantRevision: value.variantRevision,
    offerId: value.offerId,
    offerRevision: value.offerRevision,
    price: {
      amountMinor: Number(value.price.amountMinor),
      currency: value.price.currency,
    },
    description: value.description,
    image:
      value.image === null
        ? null
        : {
            url: String(value.image.url),
            altText: String(value.image.altText),
          },
    photos: parseProductPhotos(value.photos),
  };
}
function parseStockLot(value: unknown): StockLot {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.code !== "string" ||
    typeof value.remaining !== "string" ||
    typeof value.status !== "string" ||
    !nullableText(value.expiresAt)
  )
    throw new Error("Invalid lot");
  return {
    id: value.id,
    code: value.code,
    remaining: value.remaining,
    status: value.status,
    expiresAt: value.expiresAt,
  };
}
export function parseInventory(value: unknown): InventoryData {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !Array.isArray(value.rows) ||
    !Array.isArray(value.untrackedProducts) ||
    !Array.isArray(value.archivedProducts)
  )
    throw new Error("Invalid inventory response");
  return {
    rows: value.rows.map(parseRow),
    untrackedProducts: value.untrackedProducts.map(parseUntrackedProduct),
    archivedProducts: value.archivedProducts.map(parseArchivedProduct),
  };
}
function parseUntrackedProduct(
  value: unknown,
): InventoryData["untrackedProducts"][number] {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.madeToOrder !== "boolean"
  )
    throw new Error("Invalid catalogue product");
  return {
    ...parseProductLink(value),
    name: value.name,
    madeToOrder: value.madeToOrder,
  };
}

function parseStockMovement(value: unknown): StockRow["movements"][number] {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    (value.direction !== "increase" && value.direction !== "decrease") ||
    typeof value.quantity !== "string" ||
    typeof value.reason !== "string" ||
    typeof value.occurredAt !== "string"
  )
    throw new Error("Invalid stock movement");
  return {
    id: value.id,
    direction: value.direction,
    quantity: value.quantity,
    reason: value.reason,
    occurredAt: value.occurredAt,
  };
}
function parseStockReservation(
  value: unknown,
): StockRow["reservations"][number] {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !nullableText(value.orderId) ||
    (value.state !== "held" && value.state !== "allocated_to_order") ||
    typeof value.quantity !== "string"
  )
    throw new Error("Invalid stock reservation");
  return {
    id: value.id,
    orderId: value.orderId,
    state: value.state,
    quantity: value.quantity,
  };
}
