import qrcode from "qrcode-generator";
import {
  parseCommerceBuyerSessionV4,
  type CommerceClientError,
  type CommerceBuyerCatalogV1,
  type CommerceBuyerCartLineV1,
  type CommerceBuyerCartV1,
  type CommerceBuyerModifierGroupV1,
  type CommerceBuyerQuotedCheckoutV1,
  type CommerceBuyerQuotedShippingCheckoutV1,
  type CommerceBuyerSessionV4,
} from "@purin-labs/commerce-client";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, isRecord } from "@purin-labs/std";
import {
  checkoutStorageKey,
  kioskStorageKey,
  orderStatusStorageKey,
  type StorageShop,
} from "./shop-storage.ts";
import type { CafeLanguage } from "./checkout-errors.ts";
import type {
  ActiveBuyerCart,
  BuyerBasket,
  BuyerCartState,
  BuyerContactDraft,
  BuyerContactPolicy,
  BuyerContext,
  BuyerOrderAccess,
  CafeBasket,
  CafeBasketItem,
  CafeConfiguration,
  ShippingAddressDraft,
  ShippingBasket,
  ShippingBasketItem,
  StoredCartReference,
  StoredCheckoutRecovery,
  StorefrontConfiguration,
} from "./storefront-types.ts";
import {
  boundedQuantity,
  cafeInterfaceCopy,
  cafeReviewLineDetail,
  cafeSelection,
  hasCafeBasketItemId,
  hasCafeProductSelectionId,
  hasShippingBasketItemVariantId,
  initialBasket,
  menuLineItem,
  resolvedShippingServiceCode,
  shippingListingImage,
  uniqueListing,
} from "./storefront-basket.tsx";
import { parseShippingCountry } from "./shipping-address.ts";

const CAFE_LANGUAGE_STORAGE_KEY = "pantry.storefront.cafe.language";

type StorefrontLocation = Readonly<{
  hash: string;
  origin: string;
  pathname: string;
}>;

export function recoveryFromLocation(
  location: StorefrontLocation,
): BuyerOrderAccess | undefined {
  const fragment = new URLSearchParams(
    location.hash.startsWith("#") ? location.hash.slice(1) : location.hash,
  );
  const checkoutId = normalizedText(fragment.get("order"));
  const token = normalizedText(fragment.get("access"));
  return checkoutId === undefined || token === undefined
    ? undefined
    : {
        checkoutId,
        token,
        returnUrl: `${location.origin}${location.pathname}#${fragment.toString()}`,
      };
}

export function locationHasOrderAccessIntent(
  location: Readonly<{ hash: string }>,
): boolean {
  const fragment = new URLSearchParams(
    location.hash.startsWith("#") ? location.hash.slice(1) : location.hash,
  );
  return fragment.has("order") || fragment.has("access");
}

function normalizedText(value: string | null): string | undefined {
  return value === null || value.length === 0 || value !== value.trim()
    ? undefined
    : value;
}

const ORDER_QR_SVG_CACHE = new Map<string, string>();

export function orderQrSvg(url: string): string {
  const cached = ORDER_QR_SVG_CACHE.get(url);
  if (cached !== undefined) return cached;
  const qr = qrcode(0, "L");
  qr.addData(url);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  ORDER_QR_SVG_CACHE.set(url, svg);
  return svg;
}

export type StoredReceiptLineV1 = Readonly<{
  label: string;
  detail?: string;
  quantity: number;
  totalMinor: number;
  currency: string;
  imageUrl?: string;
}>;

export type StoredReceiptV1 = Readonly<{
  version: 1;
  checkoutId: string;
  fulfillment: "pickup" | "shipping";
  savedAt: string;
  lines: readonly StoredReceiptLineV1[];
}>;

const RECEIPT_STORAGE_PREFIX = "pantry.order-receipt.";
const RECEIPT_STORAGE_LIMIT = 12;

function receiptStorageKey(checkoutId: string): string {
  return `${RECEIPT_STORAGE_PREFIX}${checkoutId}`;
}

export function saveOrderReceipt(receipt: StoredReceiptV1): void {
  try {
    pruneOrderReceipts();
    window.localStorage.setItem(
      receiptStorageKey(receipt.checkoutId),
      JSON.stringify(receipt),
    );
  } catch {
    // The order page degrades to totals-only when storage is unavailable.
  }
}

export function readOrderReceipt(checkoutId: string): StoredReceiptV1 | undefined {
  try {
    const raw = window.localStorage.getItem(receiptStorageKey(checkoutId));
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const receipt = parsed as StoredReceiptV1;
    if (
      receipt.version !== 1 ||
      receipt.checkoutId !== checkoutId ||
      !Array.isArray(receipt.lines)
    )
      return undefined;
    return receipt;
  } catch {
    return undefined;
  }
}

function pruneOrderReceipts(): void {
  const stored: Array<{ key: string; savedAt: string }> = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key === null || !key.startsWith(RECEIPT_STORAGE_PREFIX)) continue;
    try {
      const parsed: unknown = JSON.parse(
        window.localStorage.getItem(key) ?? "",
      );
      const savedAt =
        typeof parsed === "object" &&
        parsed !== null &&
        "savedAt" in parsed &&
        typeof parsed.savedAt === "string"
          ? parsed.savedAt
          : "";
      stored.push({ key, savedAt });
    } catch {
      stored.push({ key, savedAt: "" });
    }
  }
  if (stored.length < RECEIPT_STORAGE_LIMIT) return;
  stored.sort(compareBySavedAt);
  for (const entry of stored.slice(
    0,
    stored.length - RECEIPT_STORAGE_LIMIT + 1,
  )) {
    window.localStorage.removeItem(entry.key);
  }
}

function compareBySavedAt(
  a: Readonly<{ savedAt: string }>,
  b: Readonly<{ savedAt: string }>,
): number {
  return a.savedAt < b.savedAt ? -1 : a.savedAt > b.savedAt ? 1 : 0;
}

export function pickupReceipt(
  quote: CommerceBuyerQuotedCheckoutV1,
  context: BuyerContext,
  config: StorefrontConfiguration,
  language: CafeLanguage,
): StoredReceiptV1 {
  const copy = cafeInterfaceCopy(language);
  const lines = quote.quote.lines.map((line): StoredReceiptLineV1 => {
    if (line.kind === "menu") {
      const item = menuLineItem(line, context.catalog, config, language);
      return {
        label: item.title,
        detail: cafeReviewLineDetail(
          line.modifierOptionIds,
          item.preparation,
          copy,
          language,
        ),
        quantity: line.quantity,
        totalMinor: line.lineTotal.amountMinor,
        currency: line.lineTotal.currency,
        imageUrl: item.imageUrl,
      };
    }
    return {
      label: language === "ja" ? "カフェ商品" : "Café item",
      quantity: line.quantity,
      totalMinor: line.lineTotal.amountMinor,
      currency: line.lineTotal.currency,
    };
  });
  return {
    version: 1,
    checkoutId: quote.checkoutId,
    fulfillment: "pickup",
    savedAt: new Date().toISOString(),
    lines,
  };
}

export function shippingReceipt(
  quote: CommerceBuyerQuotedShippingCheckoutV1,
  context: BuyerContext,
): StoredReceiptV1 {
  const lines: StoredReceiptLineV1[] = [];
  for (const line of quote.quote.lines) {
    const listing = uniqueListing(context.catalog.listings, line.variantId);
    lines.push({
      label: listing?.title ?? "Cookie gift box",
      detail: listing?.description,
      quantity: line.quantity,
      totalMinor: line.lineTotal.amountMinor,
      currency: line.lineTotal.currency,
      imageUrl: shippingListingImage(listing).imageUrl,
    });
  }
  return {
    version: 1,
    checkoutId: quote.checkoutId,
    fulfillment: "shipping",
    savedAt: new Date().toISOString(),
    lines,
  };
}

export function activeCartForSession(
  cart: CommerceBuyerCartV1,
  session: CommerceBuyerSessionV4,
  fulfillment: "pickup" | "shipping",
  expectedCartId: string | undefined,
  minimumRevision: number,
): ActiveBuyerCart | undefined {
  if (
    cart.state !== "active" ||
    cart.fulfillment !== fulfillment ||
    cart.revision < minimumRevision ||
    (expectedCartId !== undefined && cart.cartId !== expectedCartId) ||
    cart.checkoutProfile.checkoutProfileId !==
      session.checkoutProfile.checkoutProfileId ||
    cart.checkoutProfile.revision !== session.checkoutProfile.revision
  ) {
    return undefined;
  }
  return cart;
}

export function submittedCartForSession(
  cart: CommerceBuyerCartV1,
  session: CommerceBuyerSessionV4,
  fulfillment: "pickup" | "shipping",
  expectedCartId: string,
  minimumRevision: number,
): Variant<BuyerCartState, "submitted"> | undefined {
  if (
    cart.state !== "submitted" ||
    cart.fulfillment !== fulfillment ||
    cart.cartId !== expectedCartId ||
    cart.revision < minimumRevision ||
    cart.checkoutProfile.checkoutProfileId !==
      session.checkoutProfile.checkoutProfileId ||
    cart.checkoutProfile.revision !== session.checkoutProfile.revision
  ) {
    return undefined;
  }
  return {
    kind: "submitted",
    cartId: cart.cartId,
    revision: cart.revision,
    checkoutId: cart.checkoutId,
  };
}

export function contextWithSubmittedCart(
  context: BuyerContext,
  cart: ActiveBuyerCart,
  checkoutId: string,
): BuyerContext {
  return {
    ...context,
    cart: {
      kind: "submitted",
      cartId: cart.cartId,
      revision: cart.revision + 1,
      checkoutId,
    },
  };
}

export function sameBuyerCartLines(
  left: readonly CommerceBuyerCartLineV1[],
  right: readonly CommerceBuyerCartLineV1[],
): boolean {
  if (left.length !== right.length) return false;
  for (const [index, leftLine] of left.entries()) {
    const rightLine = right[index];
    if (
      rightLine === undefined ||
      leftLine.kind !== rightLine.kind ||
      leftLine.quantity !== rightLine.quantity
    )
      return false;
    if (leftLine.kind === "catalog") {
      if (
        rightLine.kind !== "catalog" ||
        leftLine.variantId !== rightLine.variantId
      )
        return false;
      continue;
    }
    if (
      rightLine.kind !== "menu" ||
      leftLine.menuId !== rightLine.menuId ||
      leftLine.menuEntryId !== rightLine.menuEntryId ||
      !sameStrings(leftLine.modifierOptionIds, rightLine.modifierOptionIds)
    )
      return false;
  }
  return true;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  for (const [index, value] of left.entries()) {
    if (right[index] !== value) return false;
  }
  return true;
}

export function isUnavailableBuyerSession(error: CommerceClientError): boolean {
  return error.kind === "http" && error.status === 401;
}

export function isMissingBuyerCart(error: CommerceClientError): boolean {
  return error.kind === "http" && error.status === 404;
}

export function isMissingBuyerCheckout(error: CommerceClientError): boolean {
  return error.kind === "http" && error.status === 404;
}

type StoredCafeBasket = Readonly<{
  kind: "cafe";
  buyerContact: BuyerContactDraft;
  items: readonly Readonly<{
    menuEntryId: string;
    quantity: number;
    modifierOptionIds: readonly string[];
  }>[];
}>;

type StoredShippingBasket = Readonly<{
  kind: "shipping";
  buyerContact: BuyerContactDraft;
  items: readonly Readonly<{ variantId: string; quantity: number }>[];
  shippingServiceCode: string | undefined;
  address: ShippingAddressDraft;
}>;

export function saveStoredCheckoutContext(
  config: StorefrontConfiguration,
  context: BuyerContext,
): void {
  try {
    window.sessionStorage.setItem(
      checkoutStorageKey(config),
      JSON.stringify({
        schemaVersion: "pantry.storefront-checkout-session.v7",
        merchantId: config.merchantId,
        storefrontId: config.storefrontId,
        session: context.session,
        operationId: context.runId,
        cart: storedCartReference(context.cart),
        basket: storedBasket(context.basket),
      }),
    );
  } catch {
    // The in-memory checkout keeps working when storage is unavailable.
  }
}

function storedCartReference(cart: BuyerCartState): StoredCartReference {
  switch (cart.kind) {
    case "absent":
      return { kind: "absent" };
    case "active":
      return {
        kind: "active",
        cartId: cart.cart.cartId,
        revision: cart.cart.revision,
      };
    case "submitted":
      return {
        kind: "submitted",
        cartId: cart.cartId,
        revision: cart.revision,
        checkoutId: cart.checkoutId,
      };
    default:
      return assertNever(cart, "Unhandled storefront state");
  }
}

function storedBasket(
  basket: BuyerBasket,
): StoredCafeBasket | StoredShippingBasket {
  if (basket.kind === "cafe") {
    return {
      kind: "cafe",
      buyerContact: basket.buyerContact,
      items: basket.items,
    };
  }
  return {
    kind: "shipping",
    buyerContact: basket.buyerContact,
    items: basket.items,
    shippingServiceCode: basket.shippingServiceCode,
    address: basket.address,
  };
}

export function clearStoredCheckoutContext(shop: StorageShop): void {
  try {
    window.sessionStorage.removeItem(checkoutStorageKey(shop));
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

export function readStoredCheckoutRecovery(
  config: StorefrontConfiguration,
): StoredCheckoutRecovery | undefined {
  try {
    const raw = window.sessionStorage.getItem(
      checkoutStorageKey(config),
    );
    if (raw === null) return undefined;
    const parsed = parseStoredCheckoutRecovery(JSON.parse(raw), config);
    if (parsed !== undefined) return parsed;
    clearStoredCheckoutContext(config);
    return undefined;
  } catch {
    clearStoredCheckoutContext(config);
    return undefined;
  }
}

export function parseStoredCheckoutRecovery(
  value: unknown,
  config: StorefrontConfiguration,
): StoredCheckoutRecovery | undefined {
  if (
    !isRecord(value) ||
    !hasExactFields(value, [
      "schemaVersion",
      "merchantId",
      "storefrontId",
      "session",
      "operationId",
      "cart",
      "basket",
    ]) ||
    value.schemaVersion !== "pantry.storefront-checkout-session.v7" ||
    value.merchantId !== config.merchantId ||
    value.storefrontId !== config.storefrontId
  ) {
    return undefined;
  }
  let session: CommerceBuyerSessionV4;
  try {
    session = parseCommerceBuyerSessionV4(value.session);
  } catch {
    return undefined;
  }
  if (Date.parse(session.expiresAt) <= Date.now()) return undefined;
  const operationId =
    typeof value.operationId === "string"
      ? normalizedText(value.operationId)
      : undefined;
  if (operationId === undefined) return undefined;
  const cart = parseStoredCartReference(value.cart);
  if (cart === undefined) return undefined;
  return { session, operationId, cart, basket: value.basket };
}

function parseStoredCartReference(
  value: unknown,
): StoredCartReference | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "absent") {
    return hasExactFields(value, ["kind"]) ? { kind: "absent" } : undefined;
  }
  if (
    typeof value.cartId !== "string" ||
    value.cartId.length === 0 ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  )
    return undefined;
  if (
    value.kind === "active" &&
    hasExactFields(value, ["kind", "cartId", "revision"])
  ) {
    return { kind: "active", cartId: value.cartId, revision: value.revision };
  }
  if (
    value.kind === "submitted" &&
    hasExactFields(value, ["kind", "cartId", "revision", "checkoutId"]) &&
    typeof value.checkoutId === "string" &&
    value.checkoutId.length > 0
  ) {
    return {
      kind: "submitted",
      cartId: value.cartId,
      revision: value.revision,
      checkoutId: value.checkoutId,
    };
  }
  return undefined;
}

export function restoredBasket(
  config: StorefrontConfiguration,
  catalog: CommerceBuyerCatalogV1,
  stored: unknown,
  contactPolicy: BuyerContactPolicy,
): BuyerBasket {
  const fallback = initialBasket(config, catalog);
  if (config.kind === "cafe")
    return (
      restoredCafeBasket(stored, catalog, config, contactPolicy) ?? fallback
    );
  return restoredShippingBasket(stored, catalog, contactPolicy) ?? fallback;
}

function restoredCafeBasket(
  stored: unknown,
  catalog: CommerceBuyerCatalogV1,
  config: CafeConfiguration,
  contactPolicy: BuyerContactPolicy,
): CafeBasket | undefined {
  if (
    !isRecord(stored) ||
    !hasExactFields(stored, ["kind", "buyerContact", "items"]) ||
    stored.kind !== "cafe" ||
    !Array.isArray(stored.items)
  )
    return undefined;
  const buyerContact = restoredBuyerContact(stored.buyerContact, contactPolicy);
  if (buyerContact === undefined) return undefined;
  const selection = cafeSelection(catalog, config);
  if (!selection.ok) return undefined;
  const items: CafeBasketItem[] = [];
  for (const item of stored.items) {
    if (
      !isRecord(item) ||
      !hasExactFields(item, ["menuEntryId", "quantity", "modifierOptionIds"])
    )
      continue;
    const menuEntryId =
      typeof item.menuEntryId === "string" ? item.menuEntryId : undefined;
    if (menuEntryId === undefined) continue;
    const product = selection.value.products.find(
      hasCafeProductSelectionId.bind(undefined, menuEntryId),
    );
    if (product === undefined || product.entry.availability !== "available")
      continue;
    const quantity = boundedQuantity(
      typeof item.quantity === "number" ? item.quantity : 0,
    );
    if (quantity === 0) continue;
    const knownOptionIds = product.entry.modifierGroups.flatMap(
      modifierGroupOptionIds,
    );
    const modifierOptionIds = Array.isArray(item.modifierOptionIds)
      ? item.modifierOptionIds.filter(
          (optionId: unknown): optionId is string =>
            typeof optionId === "string" && knownOptionIds.includes(optionId),
        )
      : [];
    if (items.some(hasCafeBasketItemId.bind(undefined, menuEntryId))) continue;
    items.push({ menuEntryId, quantity, modifierOptionIds });
  }
  return { kind: "cafe", buyerContact, items };
}

function modifierGroupOptionIds(
  group: CommerceBuyerModifierGroupV1,
): readonly string[] {
  return group.options.map(readModifierOptionId);
}

function readModifierOptionId(
  option: Readonly<{ modifierOptionId: string }>,
): string {
  return option.modifierOptionId;
}

function restoredShippingBasket(
  stored: unknown,
  catalog: CommerceBuyerCatalogV1,
  contactPolicy: BuyerContactPolicy,
): ShippingBasket | undefined {
  if (
    !isRecord(stored) ||
    stored.kind !== "shipping" ||
    !hasExactFields(stored, [
      "kind",
      "buyerContact",
      "items",
      "shippingServiceCode",
      "address",
    ])
  )
    return undefined;
  const address = restoredShippingAddress(stored.address);
  const buyerContact = restoredBuyerContact(stored.buyerContact, contactPolicy);
  const items = restoredShippingItems(stored.items, catalog);
  if (
    address === undefined ||
    buyerContact === undefined ||
    items === undefined
  )
    return undefined;
  const shippingServiceCode = resolvedShippingServiceCode(
    catalog,
    address.countryCode,
    typeof stored.shippingServiceCode === "string"
      ? stored.shippingServiceCode
      : undefined,
  );
  if (
    shippingServiceCode === undefined ||
    shippingServiceCode !== stored.shippingServiceCode
  ) {
    return undefined;
  }
  return {
    kind: "shipping",
    buyerContact,
    items,
    shippingServiceCode,
    address,
  };
}

function restoredShippingAddress(
  value: unknown,
): ShippingAddressDraft | undefined {
  if (!isRecord(value) || typeof value.countryCode !== "string")
    return undefined;
  const countryCode = parseShippingCountry(value.countryCode);
  if (countryCode === undefined) return undefined;
  switch (countryCode) {
    case "JP":
      if (
        !hasExactFields(value, [
          "countryCode",
          "recipientName",
          "addressLine1",
          "locality",
          "administrativeArea",
          "postalCode",
        ]) ||
        typeof value.recipientName !== "string" ||
        typeof value.addressLine1 !== "string" ||
        typeof value.locality !== "string" ||
        typeof value.administrativeArea !== "string" ||
        typeof value.postalCode !== "string"
      )
        return undefined;
      return {
        countryCode,
        recipientName: value.recipientName,
        addressLine1: value.addressLine1,
        locality: value.locality,
        administrativeArea: value.administrativeArea,
        postalCode: value.postalCode,
      };
    case "SG":
      if (
        !hasExactFields(value, [
          "countryCode",
          "recipientName",
          "addressLine1",
          "locality",
          "postalCode",
        ]) ||
        typeof value.recipientName !== "string" ||
        typeof value.addressLine1 !== "string" ||
        value.locality !== "Singapore" ||
        typeof value.postalCode !== "string"
      )
        return undefined;
      return {
        countryCode,
        recipientName: value.recipientName,
        addressLine1: value.addressLine1,
        locality: "Singapore",
        postalCode: value.postalCode,
      };
  }
}

function restoredShippingItems(
  value: unknown,
  catalog: CommerceBuyerCatalogV1,
): readonly ShippingBasketItem[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const items: ShippingBasketItem[] = [];
  for (const item of value) {
    if (!isRecord(item) || !hasExactFields(item, ["variantId", "quantity"]))
      return undefined;
    const variantId =
      typeof item.variantId === "string" && item.variantId.length > 0
        ? item.variantId
        : undefined;
    const quantity =
      typeof item.quantity === "number" &&
      Number.isSafeInteger(item.quantity) &&
      item.quantity >= 1 &&
      item.quantity <= 12
        ? item.quantity
        : undefined;
    if (variantId === undefined || quantity === undefined) {
      return undefined;
    }
    if (items.some(hasShippingBasketItemVariantId.bind(undefined, variantId)))
      return undefined;
    const listing = uniqueListing(catalog.listings, variantId);
    if (listing === undefined || listing.availability !== "available")
      return undefined;
    items.push({ variantId, quantity });
  }
  return items;
}

function restoredBuyerContact(
  value: unknown,
  policy: BuyerContactPolicy,
): BuyerContactDraft | undefined {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["email", "phone"]) ||
    typeof value.email !== "string" ||
    typeof value.phone !== "string"
  ) {
    return undefined;
  }
  return {
    email: value.email,
    phone: policy === "email_required" ? "" : value.phone,
  };
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    fields.every(recordHasKey.bind(undefined, keys))
  );
}

function recordHasKey(keys: readonly string[], field: string): boolean {
  return keys.includes(field);
}

export function readKioskMode(shop: StorageShop, location: Location): boolean {
  const requested = new URLSearchParams(location.search).get("kiosk");
  try {
    if (requested === "1") {
      window.localStorage.setItem(kioskStorageKey(shop), "1");
      return true;
    }
    if (requested === "0") {
      window.localStorage.removeItem(kioskStorageKey(shop));
      return false;
    }
    return window.localStorage.getItem(kioskStorageKey(shop)) === "1";
  } catch {
    return requested === "1";
  }
}

export function parseCafeLanguage(value: string | null): CafeLanguage | undefined {
  if (value === "en" || value === "ja") return value;
  return undefined;
}

export function readCafeLanguage(): CafeLanguage {
  try {
    return (
      parseCafeLanguage(
        window.localStorage.getItem(CAFE_LANGUAGE_STORAGE_KEY),
      ) ?? "en"
    );
  } catch {
    return "en";
  }
}

export function saveCafeLanguage(language: CafeLanguage): void {
  try {
    window.localStorage.setItem(CAFE_LANGUAGE_STORAGE_KEY, language);
  } catch {
    // The selected language remains active until the page is reloaded.
  }
}

export function saveOrderStatusUrl(shop: StorageShop, returnUrl: string): void {
  try {
    window.localStorage.setItem(orderStatusStorageKey(shop), returnUrl);
  } catch {
    // The return URL remains usable when browser storage is unavailable.
  }
}

export function readOrderStatusUrl(shop: StorageShop): string | undefined {
  try {
    const stored = normalizedText(
      window.localStorage.getItem(orderStatusStorageKey(shop)),
    );
    if (stored === undefined) return undefined;
    const url = new URL(stored);
    const access = recoveryFromLocation(url);
    if (
      url.origin === window.location.origin &&
      url.pathname === window.location.pathname &&
      access !== undefined
    ) {
      return access.returnUrl;
    }
    clearOrderStatusUrl(shop);
    return undefined;
  } catch {
    clearOrderStatusUrl(shop);
    return undefined;
  }
}

export function clearOrderStatusUrl(shop: StorageShop): void {
  try {
    window.localStorage.removeItem(orderStatusStorageKey(shop));
  } catch {
    // The URL fragment is still cleared when browser storage is unavailable.
  }
}
