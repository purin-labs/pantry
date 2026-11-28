import React from "react";
import {
  commerceAddressNeedsState,
  type CommerceInternationalShippingCountry,
  type CommerceBuyerCatalogListingV1,
  type CommerceBuyerCatalogV1,
  type CommerceBuyerCartLineV1,
  type CommerceBuyerMenuEntryV1,
  type CommerceBuyerMenuV1,
  type CommerceBuyerPickupCheckoutLineV1,
  type CommerceBuyerQuotedCheckoutV1,
  type CommerceBuyerQuotedShippingCheckoutV1,
  type CommerceBuyerShippingCheckoutLineV1,
  type CommerceBuyerShippingServiceV1,
  CURRENCY_MINOR_UNITS,
} from "@purin-labs/commerce-client";
import { assertNever } from "@purin-labs/std";
import { patisserieProduct, type PatisserieProductId } from "./patisserie.tsx";
import type { CafeLanguage } from "./checkout-errors.ts";
import type {
  BuyerBasket,
  BuyerContactDraft,
  CafeBasket,
  CafeBasketItem,
  CafeConfiguration,
  CafeInterfaceCopy,
  CafeProductConfiguration,
  CafeProductCopy,
  CafeProductId,
  CafeProductSelection,
  CafeSelection,
  CafeSelectionResult,
  ShippingAddressDraft,
  ShippingBasket,
  ShippingBasketItem,
  ShippingCountryCode,
  ShippingListingImage,
  ShippingSelectionResult,
  StorefrontConfiguration,
} from "./storefront-types.ts";
import type {
  CheckoutReviewLine,
  CheckoutViewCopy,
  OrderViewCopy,
  QuantityStepperProps,
} from "./storefront-views.tsx";
import {
  CAFE_INTERFACE_COPY,
  CAFE_PRODUCT_CONFIGURATIONS,
  CAFE_PRODUCT_COPY,
} from "./cafe-copy.ts";
import type { ShippingCountryCopy } from "./shipping-address.ts";

const SHIPPING_LISTING_IMAGES: Readonly<Record<string, ShippingListingImage>> =
  {
    "COOKIE-BOX-6-SG": {
      imageUrl: "/products/nuki-neko-gift-box.webp",
      imageAlt:
        "Open kraft gift box with three cat-shaped madeleines and three cat-face cookies",
    },
    "SESAME-BOX-6-SG": {
      imageUrl: "/products/nuki-cookies-sesame.webp",
      imageAlt: "Black sesame cat-face cookies arranged on a baking tray",
    },
    "GINGER-BOX-6-SG": {
      imageUrl: "/products/nuki-cookies-ginger.webp",
      imageAlt: "Golden ginger cat-face cookies arranged on a baking tray",
    },
    "TARO-BOX-6-SG": {
      imageUrl: "/products/nuki-financier-taro.webp",
      imageAlt: "Taro cat-shaped madeleines on a cream ceramic plate",
    },
    "MATCHA-BOX-6-SG": {
      imageUrl: "/products/nuki-cookies-matcha.webp",
      imageAlt: "Matcha cat-face cookies arranged on a baking tray",
    },
  };

const DEFAULT_SHIPPING_LISTING_IMAGE: ShippingListingImage = {
  imageUrl: "/products/nuki-cookie-box.webp",
  imageAlt: "Open kraft box of six square butter cookies",
};

function CafeBasketLine(
  props: Readonly<{
    itemKey: string;
    imageUrl: string | undefined;
    label: string;
    quantity: number;
    total: Readonly<{ amountMinor: number; currency: string }>;
    detail?: string;
    addVisibleLabel: string;
    addLabel: string;
    removeLabel: string;
    selectedLabel: string;
    maximum: 0 | 12;
    onDecrease: React.MouseEventHandler<HTMLButtonElement>;
    onIncrease: React.MouseEventHandler<HTMLButtonElement>;
  }>,
): React.ReactNode {
  return (
    <li>
      {props.imageUrl === undefined ? (
        <span className="basket-line-mark" aria-hidden="true">
          {props.label.slice(0, 1)}
        </span>
      ) : (
        <img src={props.imageUrl} alt="" width={1448} height={1086} />
      )}
      <div>
        <strong>{props.label}</strong>
        {props.detail === undefined ? null : <small>{props.detail}</small>}
        <div className="basket-line-stepper">
          <QuantityStepper
            itemKey={props.itemKey}
            label={props.label}
            addVisibleLabel={props.addVisibleLabel}
            addLabel={props.addLabel}
            removeLabel={props.removeLabel}
            selectedLabel={props.selectedLabel}
            value={props.quantity}
            minimum={0}
            maximum={props.maximum}
            onDecrease={props.onDecrease}
            onIncrease={props.onIncrease}
          />
        </div>
      </div>
      <div className="basket-line-meta">
        <strong>{money(props.total)}</strong>
      </div>
    </li>
  );
}

export class QuantityStepper extends React.PureComponent<QuantityStepperProps> {
  render(): React.ReactNode {
    if (this.props.value === 0) {
      return (
        <button
          className="quantity-add quantity-add-text"
          type="button"
          data-item-key={this.props.itemKey}
          aria-label={this.props.addLabel}
          disabled={this.props.maximum === 0}
          onClick={this.props.onIncrease}
        >
          {this.props.addVisibleLabel}
        </button>
      );
    }
    return (
      <div
        className="quantity-stepper"
        role="group"
        aria-label={`${this.props.label} quantity`}
      >
        <button
          type="button"
          data-item-key={this.props.itemKey}
          aria-label={this.props.removeLabel}
          disabled={this.props.value <= this.props.minimum}
          onClick={this.props.onDecrease}
        >
          −
        </button>
        <output
          aria-live="polite"
          aria-label={`${this.props.value} ${this.props.selectedLabel}`}
        >
          {this.props.value}
        </output>
        <button
          type="button"
          data-item-key={this.props.itemKey}
          aria-label={this.props.addLabel}
          disabled={this.props.value >= this.props.maximum}
          onClick={this.props.onIncrease}
        >
          +
        </button>
      </div>
    );
  }
}

export function cafeSelection(
  catalog: CommerceBuyerCatalogV1,
  config: CafeConfiguration,
): CafeSelectionResult {
  if (config.storefrontId !== catalog.storefront.storefrontId) {
    return {
      ok: false,
      message: "The café catalog belongs to another storefront.",
    };
  }
  const products: CafeProductSelection[] = [];
  if (config.presentation === "menu") {
    products.push(...publishedMenuProducts(catalog));
  } else {
    for (const productConfig of CAFE_PRODUCT_CONFIGURATIONS) {
      const product = cafeProductSelection(catalog, productConfig);
      if (product !== undefined) products.push(product);
    }
  }
  const first = products[0];
  if (first === undefined)
    return { ok: false, message: "The café menu is not serving now. Check the shop’s hours and try again." };
  return { ok: true, value: { products: [first, ...products.slice(1)] } };
}

type PublishedMenuSection = Readonly<{
  anchor: string;
  name: string;
  products: readonly CafeProductSelection[];
}>;

/**
 * The sections of the published menus in their order, each with its items.
 * An item whose section the menu does not list goes under `fallbackName`.
 */
export function publishedMenuSections(
  selection: CafeSelection,
  fallbackName: string,
): readonly PublishedMenuSection[] {
  const sections: PublishedMenuSection[] = [];
  const placed = new Set<CafeProductSelection>();
  const menus = [...new Set(selection.products.map((product) => product.menu))];
  for (const menu of menus) {
    const ordered = [...menu.sections].sort((a, b) => a.position - b.position);
    for (const section of ordered) {
      const products = selection.products.filter(
        (product) =>
          product.menu === menu &&
          product.entry.sectionId === section.sectionId,
      );
      if (products.length === 0) continue;
      for (const product of products) placed.add(product);
      sections.push({
        anchor: `menu-section-${sections.length + 1}`,
        name: section.name,
        products,
      });
    }
  }
  const unplaced = selection.products.filter((product) => !placed.has(product));
  if (unplaced.length > 0)
    sections.push({
      anchor: `menu-section-${sections.length + 1}`,
      name: fallbackName,
      products: unplaced,
    });
  return sections;
}

/**
 * Every item of a shop's published menus, in menu order. An item shows its
 * listing's title, description and first image.
 */
function publishedMenuProducts(
  catalog: CommerceBuyerCatalogV1,
): readonly CafeProductSelection[] {
  const products: CafeProductSelection[] = [];
  const seen = new Set<string>();
  for (const menu of catalog.menus) {
    for (const entry of menu.entries) {
      if (seen.has(entry.menuEntryId)) continue;
      const listing = uniqueListing(catalog.listings, entry.variantId);
      if (listing === undefined) continue;
      seen.add(entry.menuEntryId);
      products.push({
        config: publishedMenuConfiguration(entry, listing),
        menu,
        entry,
        listing,
      });
    }
  }
  return products;
}

function publishedMenuConfiguration(
  entry: Readonly<{ menuEntryId: string }>,
  listing: CommerceBuyerCatalogListingV1,
): CafeProductConfiguration {
  const image = listing.media.find((item) => item.kind === "image");
  return {
    menuEntryId: entry.menuEntryId,
    category: "bake",
    flavor: "menu",
    imageUrl: image?.url,
    imageAlt: image?.altText ?? "",
    preparation: "unstated",
    copy: {
      title: listing.title,
      description: listing.description,
      allergens: "",
    },
  };
}

function cafeProductSelection(
  catalog: CommerceBuyerCatalogV1,
  config: CafeProductConfiguration,
): CafeProductSelection | undefined {
  let matchedMenu: CommerceBuyerMenuV1 | undefined;
  let matchedEntry: CommerceBuyerMenuEntryV1 | undefined;
  // A menu published from the Portal names its own entries, so an entry
  // also matches by the variant of the café product it sells.
  const variantId = config.menuEntryId.replace(/^menu_entry_/u, "variant_");
  for (const menu of catalog.menus) {
    for (const entry of menu.entries) {
      if (
        entry.menuEntryId !== config.menuEntryId &&
        entry.variantId !== variantId
      )
        continue;
      if (matchedEntry !== undefined) return undefined;
      matchedMenu = menu;
      matchedEntry = entry;
    }
  }
  if (matchedMenu === undefined || matchedEntry === undefined) return undefined;
  const listing = uniqueListing(catalog.listings, matchedEntry.variantId);
  return listing === undefined
    ? undefined
    : { config, menu: matchedMenu, entry: matchedEntry, listing };
}

export function shippingSelection(
  catalog: CommerceBuyerCatalogV1,
  basket: ShippingBasket,
): ShippingSelectionResult {
  if (catalog.listings.length === 0)
    return { ok: false, message: "No gift boxes are published right now." };
  if (basket.items.length === 0)
    return { ok: false, message: "Choose at least one gift box." };
  const listings: CommerceBuyerCatalogListingV1[] = [];
  for (const item of basket.items) {
    if (
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 12
    ) {
      return {
        ok: false,
        message: "Choose between 1 and 12 boxes of each selected style.",
      };
    }
    if (listings.some(hasListingVariantId.bind(undefined, item.variantId))) {
      return { ok: false, message: "Choose each gift box style once." };
    }
    const listing = uniqueListing(catalog.listings, item.variantId);
    if (listing === undefined)
      return {
        ok: false,
        message: "That gift box is no longer listed. Choose another gift box.",
      };
    if (listing.availability !== "available") {
      return {
        ok: false,
        message: `${listing.title} is sold out right now. Choose another gift box.`,
      };
    }
    listings.push(listing);
  }
  const first = listings[0];
  if (first === undefined)
    return { ok: false, message: "Choose at least one gift box." };
  return { ok: true, value: [first, ...listings.slice(1)] };
}

function hasListingVariantId(
  variantId: string,
  listing: CommerceBuyerCatalogListingV1,
): boolean {
  return listing.variantId === variantId;
}

export function shippingBasketItem(
  basket: ShippingBasket,
  variantId: string,
): ShippingBasketItem | undefined {
  return basket.items.find(
    hasShippingBasketItemVariantId.bind(undefined, variantId),
  );
}

export function hasShippingBasketItemVariantId(
  variantId: string,
  item: ShippingBasketItem,
): boolean {
  return item.variantId === variantId;
}

export function shippingBasketWithQuantity(
  basket: ShippingBasket,
  variantId: string,
  quantity: number,
): ShippingBasket {
  const nextQuantity = quantity <= 0 ? 0 : boundedPositiveQuantity(quantity);
  const items: ShippingBasketItem[] = [];
  let found = false;
  for (const item of basket.items) {
    if (item.variantId !== variantId) {
      items.push(item);
      continue;
    }
    found = true;
    if (nextQuantity > 0) items.push({ variantId, quantity: nextQuantity });
  }
  if (!found && nextQuantity > 0)
    items.push({ variantId, quantity: nextQuantity });
  return { ...basket, items };
}

export function shippingBasketCartLines(
  basket: ShippingBasket,
): readonly CommerceBuyerCartLineV1[] {
  return basket.items.map(shippingBasketCartLine);
}

function shippingBasketCartLine(
  item: ShippingBasketItem,
): CommerceBuyerCartLineV1 {
  return {
    kind: "catalog",
    variantId: item.variantId,
    quantity: item.quantity,
  };
}

export function shippingBasketCheckoutLines(
  basket: ShippingBasket,
): readonly CommerceBuyerShippingCheckoutLineV1[] {
  return basket.items.map(shippingBasketCheckoutLine);
}

function shippingBasketCheckoutLine(
  item: ShippingBasketItem,
): CommerceBuyerShippingCheckoutLineV1 {
  return { variantId: item.variantId, quantity: item.quantity };
}

export function shippingBasketSubtotal(
  listings: readonly CommerceBuyerCatalogListingV1[],
  basket: ShippingBasket,
): Readonly<{ amountMinor: number; currency: string }> {
  const first = listings[0];
  if (first === undefined) return { amountMinor: 0, currency: "JPY" };
  let amountMinor = 0;
  for (const listing of listings) {
    const item = shippingBasketItem(basket, listing.variantId);
    if (item !== undefined)
      amountMinor += listing.price.amountMinor * item.quantity;
  }
  return { amountMinor, currency: first.price.currency };
}

export function shippingOrderLines(
  listings: readonly CommerceBuyerCatalogListingV1[],
  basket: ShippingBasket,
): readonly React.ReactNode[] {
  const lines: React.ReactNode[] = [];
  for (const listing of listings)
    lines.push(shippingOrderLine(listing, basket));
  return lines;
}

function shippingOrderLine(
  listing: CommerceBuyerCatalogListingV1,
  basket: ShippingBasket,
): React.ReactNode {
  const item = shippingBasketItem(basket, listing.variantId);
  if (item === undefined) return null;
  return (
    <div className="shipping-order-line" key={listing.variantId}>
      <img
        src={shippingListingImage(listing).imageUrl}
        alt=""
        width={1448}
        height={1086}
      />
      <div>
        <strong>{listing.title}</strong>
        <small>
          {item.quantity} × {money(listing.price)}
        </small>
      </div>
      <strong>{money(shippingLineSubtotal(listing, item.quantity))}</strong>
    </div>
  );
}

export function shippingOrderSummaryLines(
  listings: readonly CommerceBuyerCatalogListingV1[],
  basket: ShippingBasket,
): readonly React.ReactNode[] {
  const lines: React.ReactNode[] = [];
  for (const listing of listings) {
    const item = shippingBasketItem(basket, listing.variantId);
    if (item === undefined) continue;
    lines.push(
      <li key={listing.variantId}>
        {item.quantity} × {listing.title}
      </li>,
    );
  }
  return lines;
}

export function shippingServiceSelection(
  catalog: CommerceBuyerCatalogV1,
  basket: ShippingBasket,
):
  | Readonly<{ ok: true; value: CommerceBuyerShippingServiceV1 }>
  | Readonly<{ ok: false; message: string }> {
  if (catalog.storefront.fulfillment !== "shipping") {
    return {
      ok: false,
      message: "This storefront does not publish delivery services.",
    };
  }
  if (basket.shippingServiceCode === undefined) {
    return shippingServicesForCountry(catalog, basket.address.countryCode)
      .length === 0
      ? {
          ok: false,
          message: shippingCountryCopy(basket.address.countryCode).noServices,
        }
      : {
          ok: false,
          message: "Delivery is temporarily unavailable. Try again later.",
        };
  }
  const service = uniqueShippingService(
    catalog,
    basket.address.countryCode,
    basket.shippingServiceCode,
  );
  return service === undefined
    ? {
        ok: false,
        message:
          "That delivery service is no longer available. Select another service.",
      }
    : { ok: true, value: service };
}

export function shippingServicesForCountry(
  catalog: CommerceBuyerCatalogV1,
  destinationCountry: ShippingCountryCode,
): readonly CommerceBuyerShippingServiceV1[] {
  return catalog.storefront.fulfillment === "shipping"
    ? catalog.storefront.shippingServices.filter(
        (service) => service.destinationCountry === destinationCountry,
      )
    : [];
}

export function uniqueShippingService(
  catalog: CommerceBuyerCatalogV1,
  destinationCountry: ShippingCountryCode,
  serviceCode: string,
): CommerceBuyerShippingServiceV1 | undefined {
  const matches = shippingServicesForCountry(
    catalog,
    destinationCountry,
  ).filter(
    (service) =>
      service.service.code === serviceCode &&
      isAvailableShippingService(service),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function isAvailableShippingService(
  service: CommerceBuyerShippingServiceV1,
): boolean {
  return service.availability.state === "available";
}

// The merchant's first uploaded image, else the built-in picture for the SKU.
export function shippingListingImage(
  listing: CommerceBuyerCatalogListingV1 | undefined,
): ShippingListingImage {
  const media = listing?.media.find((item) => item.kind === "image");
  if (media !== undefined) return { imageUrl: media.url, imageAlt: media.altText };
  return (
    (listing === undefined ? undefined : SHIPPING_LISTING_IMAGES[listing.sku]) ??
    DEFAULT_SHIPPING_LISTING_IMAGE
  );
}

export function shippingListingCount(count: number): string {
  return `${count} gift ${count === 1 ? "box" : "boxes"}`;
}

function shippingLineSubtotal(
  listing: CommerceBuyerCatalogListingV1,
  quantity: number,
): Readonly<{ amountMinor: number; currency: string }> {
  return {
    amountMinor: listing.price.amountMinor * quantity,
    currency: listing.price.currency,
  };
}

export function uniqueListing(
  listings: readonly CommerceBuyerCatalogListingV1[],
  variantId: string,
): CommerceBuyerCatalogListingV1 | undefined {
  const matches = listings.filter((listing) => listing.variantId === variantId);
  return matches.length === 1 ? matches[0] : undefined;
}

export function initialBasket(
  config: StorefrontConfiguration,
  catalog: CommerceBuyerCatalogV1,
): BuyerBasket {
  return config.kind === "cafe"
    ? initialCafeBasket()
    : initialShippingBasket(catalog);
}

export function initialCafeBasket(): CafeBasket {
  return { kind: "cafe", buyerContact: emptyBuyerContact(), items: [] };
}

export function initialShippingBasket(
  catalog: CommerceBuyerCatalogV1,
): ShippingBasket {
  const countryCode: ShippingCountryCode = "SG";
  return {
    kind: "shipping",
    buyerContact: emptyBuyerContact(),
    items: initialShippingItems(catalog),
    shippingServiceCode: resolvedShippingServiceCode(
      catalog,
      countryCode,
      undefined,
    ),
    address: initialShippingAddress(countryCode),
  };
}

function initialShippingItems(
  catalog: CommerceBuyerCatalogV1,
): readonly ShippingBasketItem[] {
  const listing = catalog.listings.find(isAvailableShippingListing);
  return listing === undefined
    ? []
    : [{ variantId: listing.variantId, quantity: 1 }];
}

export function resolvedShippingServiceCode(
  catalog: CommerceBuyerCatalogV1,
  destinationCountry: ShippingCountryCode,
  serviceCode: string | undefined,
): string | undefined {
  if (
    serviceCode !== undefined &&
    uniqueShippingService(catalog, destinationCountry, serviceCode) !==
      undefined
  ) {
    return serviceCode;
  }
  return shippingServicesForCountry(catalog, destinationCountry).find(
    isAvailableShippingService,
  )?.service.code;
}

function emptyBuyerContact(): BuyerContactDraft {
  return { email: "", phone: "" };
}

function isAvailableShippingListing(
  listing: CommerceBuyerCatalogListingV1,
): boolean {
  return listing.availability === "available";
}

export function boundedQuantity(value: number): number {
  return Number.isInteger(value) ? Math.max(0, Math.min(12, value)) : 0;
}

function boundedPositiveQuantity(value: number): number {
  return Number.isInteger(value) ? Math.max(1, Math.min(12, value)) : 1;
}

export function cafeBasketHasItems(basket: CafeBasket): boolean {
  return basket.items.length > 0;
}

export function cafeBasketItemCount(basket: CafeBasket): number {
  return basket.items.reduce(sumCafeBasketQuantity, 0);
}

function sumCafeBasketQuantity(total: number, item: CafeBasketItem): number {
  return total + item.quantity;
}

export function cafeBasketQuantity(basket: CafeBasket, menuEntryId: string): number {
  return (
    basket.items.find(hasCafeBasketItemId.bind(undefined, menuEntryId))
      ?.quantity ?? 0
  );
}

export function cafeBasketModifiers(
  basket: CafeBasket,
  menuEntryId: string,
): readonly string[] {
  return (
    basket.items.find(hasCafeBasketItemId.bind(undefined, menuEntryId))
      ?.modifierOptionIds ?? []
  );
}

export function hasCafeBasketItemId(
  menuEntryId: string,
  item: CafeBasketItem,
): boolean {
  return item.menuEntryId === menuEntryId;
}

export function withCafeQuantity(
  basket: CafeBasket,
  menuEntryId: string,
  quantity: number,
): CafeBasket {
  const existing = basket.items.find(
    hasCafeBasketItemId.bind(undefined, menuEntryId),
  );
  const remaining = basket.items.filter(
    notCafeBasketItemId.bind(undefined, menuEntryId),
  );
  if (quantity === 0) return { ...basket, items: remaining };
  const item: CafeBasketItem = {
    menuEntryId,
    quantity,
    modifierOptionIds: existing?.modifierOptionIds ?? [],
  };
  return { ...basket, items: [...remaining, item] };
}

function notCafeBasketItemId(
  menuEntryId: string,
  item: CafeBasketItem,
): boolean {
  return item.menuEntryId !== menuEntryId;
}

export function withCafeModifier(
  basket: CafeBasket,
  menuEntryId: string,
  modifierOptionId: string,
): CafeBasket {
  const existing = basket.items.find(
    hasCafeBasketItemId.bind(undefined, menuEntryId),
  );
  if (existing === undefined) {
    const added: CafeBasketItem = {
      menuEntryId,
      quantity: 1,
      modifierOptionIds: [modifierOptionId],
    };
    return { ...basket, items: [...basket.items, added] };
  }
  const modifierOptionIds = existing.modifierOptionIds.includes(
    modifierOptionId,
  )
    ? []
    : [modifierOptionId];
  const next: CafeBasketItem = { ...existing, modifierOptionIds };
  return {
    ...basket,
    items: basket.items.map(replaceCafeBasketItem.bind(undefined, next)),
  };
}

function replaceCafeBasketItem(
  next: CafeBasketItem,
  item: CafeBasketItem,
): CafeBasketItem {
  return item.menuEntryId === next.menuEntryId ? next : item;
}

export function cafeBasketTotal(
  basket: CafeBasket,
  selection: CafeSelection,
): Readonly<{ amountMinor: number; currency: string }> {
  let amountMinor = 0;
  for (const item of basket.items) {
    const product = selection.products.find(
      hasCafeProductSelectionId.bind(undefined, item.menuEntryId),
    );
    if (product !== undefined)
      amountMinor += cafeLineTotal(item, product).amountMinor;
  }
  return {
    amountMinor,
    currency: selection.products[0].entry.price.currency,
  };
}

function cafeLineTotal(
  item: CafeBasketItem,
  product: CafeProductSelection,
): Readonly<{ amountMinor: number; currency: string }> {
  let modifierAmount = 0;
  for (const group of product.entry.modifierGroups) {
    for (const option of group.options) {
      if (item.modifierOptionIds.includes(option.modifierOptionId))
        modifierAmount += option.priceDelta.amountMinor;
    }
  }
  return {
    amountMinor:
      (product.entry.price.amountMinor + modifierAmount) * item.quantity,
    currency: product.entry.price.currency,
  };
}

export function hasCafeProductSelectionId(
  menuEntryId: string,
  product: CafeProductSelection,
): boolean {
  return product.config.menuEntryId === menuEntryId;
}

export function cafeCheckoutLines(
  basket: CafeBasket,
  selection: CafeSelection,
): readonly CommerceBuyerPickupCheckoutLineV1[] {
  const lines: CommerceBuyerPickupCheckoutLineV1[] = [];
  for (const item of basket.items) {
    const product = selection.products.find(
      hasCafeProductSelectionId.bind(undefined, item.menuEntryId),
    );
    if (product === undefined) continue;
    lines.push({
      kind: "menu",
      menuId: product.menu.menuId,
      menuEntryId: product.entry.menuEntryId,
      quantity: item.quantity,
      modifierOptionIds: item.modifierOptionIds,
    });
  }
  return lines;
}

export function cafeCheckoutReviewLines(
  quote: CommerceBuyerQuotedCheckoutV1,
  catalog: CommerceBuyerCatalogV1,
  config: StorefrontConfiguration,
  copy: CafeInterfaceCopy,
  language: CafeLanguage,
): readonly CheckoutReviewLine[] {
  return quote.quote.lines.map((line) => {
    switch (line.kind) {
      case "catalog":
        return {
          key: `catalog:${line.variantId}`,
          label: language === "ja" ? "カフェ商品" : "Café item",
          detail: copy.readyNow,
          quantity: line.quantity,
          total: line.lineTotal,
        };
      case "menu": {
        const item = menuLineItem(line, catalog, config, language);
        return {
          key: `menu:${line.menuId}:${line.menuEntryId}`,
          label: item.title,
          detail: cafeReviewLineDetail(
            line.modifierOptionIds,
            item.preparation,
            copy,
            language,
          ),
          quantity: line.quantity,
          total: line.lineTotal,
          imageUrl: item.imageUrl,
        };
      }
      case "order_balance":
        return {
          key: `order_balance:${line.orderId}`,
          label: language === "ja" ? "ご注文の差額" : "Order balance",
          detail: "",
          quantity: line.quantity,
          total: line.lineTotal,
        };
      default:
        return assertNever(line, "Unhandled storefront state");
    }
  });
}

export function cafeReviewLineDetail(
  modifierOptionIds: readonly string[],
  preparation: CafeProductConfiguration["preparation"],
  copy: CafeInterfaceCopy,
  language: CafeLanguage,
): string {
  const names = modifierOptionIds
    .map((modifierOptionId) => cafeModifierName(language, modifierOptionId, ""))
    .filter(hasText);
  return [names.join(", "), cafeProductPreparation(copy, preparation).label]
    .filter(hasText)
    .join(" · ");
}

/**
 * What a quote's menu line shows. On a shop's order page it is the item's
 * listing; the demo shops show their own products' copy and art.
 */
export function menuLineItem(
  line: Readonly<{ menuEntryId: string; variantId: string }>,
  catalog: CommerceBuyerCatalogV1,
  config: StorefrontConfiguration,
  language: CafeLanguage,
): Readonly<{
  title: string;
  imageUrl: string | undefined;
  preparation: CafeProductConfiguration["preparation"];
}> {
  const menuEntryId =
    config.kind === "cafe" && config.presentation === "menu"
      ? undefined
      : cafeProductIdOfLine(line);
  const demo =
    menuEntryId === undefined
      ? undefined
      : cafeProductConfiguration(menuEntryId);
  if (menuEntryId !== undefined && demo !== undefined)
    return {
      title: cafeProductCopy(language, menuEntryId).title,
      imageUrl: demo.imageUrl,
      preparation: demo.preparation,
    };
  const listing = uniqueListing(catalog.listings, line.variantId);
  if (listing !== undefined) {
    const item = publishedMenuConfiguration(
      { menuEntryId: line.menuEntryId },
      listing,
    );
    return {
      title: listing.title,
      imageUrl: item.imageUrl,
      preparation: item.preparation,
    };
  }
  return {
    title: language === "ja" ? "メニュー商品" : "Menu item",
    imageUrl: undefined,
    preparation: "made_to_order",
  };
}

function cafeProductConfiguration(
  menuEntryId: CafeProductId,
): CafeProductConfiguration | undefined {
  return CAFE_PRODUCT_CONFIGURATIONS.find(
    hasCafeProductConfigurationId.bind(undefined, menuEntryId),
  );
}

export function cafeBasketLines(
  basket: CafeBasket,
  selection: CafeSelection,
  language: CafeLanguage,
  interfaceCopy: CafeInterfaceCopy,
  onDecrease: React.MouseEventHandler<HTMLButtonElement>,
  onIncrease: React.MouseEventHandler<HTMLButtonElement>,
): readonly React.ReactNode[] {
  const lines: React.ReactNode[] = [];
  for (const product of selection.products) {
    const item = basket.items.find(
      hasCafeBasketItemId.bind(undefined, product.config.menuEntryId),
    );
    if (item === undefined) continue;
    const copy = cafeItemCopy(language, product.config);
    lines.push(
      <CafeBasketLine
        key={product.config.menuEntryId}
        itemKey={product.config.menuEntryId}
        imageUrl={product.config.imageUrl}
        label={copy.title}
        quantity={item.quantity}
        detail={cafeBasketItemDetail(item, product, language)}
        total={cafeLineTotal(item, product)}
        addVisibleLabel={interfaceCopy.addAction}
        addLabel={`${interfaceCopy.addOne} ${copy.title}`}
        removeLabel={`${interfaceCopy.removeOne} ${copy.title}`}
        selectedLabel={interfaceCopy.selected}
        maximum={product.entry.availability === "available" ? 12 : 0}
        onDecrease={onDecrease}
        onIncrease={onIncrease}
      />,
    );
  }
  return lines;
}

function cafeBasketItemDetail(
  item: CafeBasketItem,
  product: CafeProductSelection,
  language: CafeLanguage,
): string | undefined {
  if (product.entry.modifierGroups.length === 0) return undefined;
  // The demo's one modifier is oat milk, so no choice means dairy milk.
  if (item.modifierOptionIds.length === 0)
    return product.config.flavor === "menu"
      ? undefined
      : cafeInterfaceCopy(language).dairyMilk;
  const names: string[] = [];
  for (const group of product.entry.modifierGroups) {
    for (const option of group.options) {
      if (item.modifierOptionIds.includes(option.modifierOptionId)) {
        names.push(
          cafeModifierName(language, option.modifierOptionId, option.name),
        );
      }
    }
  }
  return names.join(", ");
}

/** A shop's own item has its listing's copy; a demo product has its own. */
export function cafeItemCopy(
  language: CafeLanguage,
  config: CafeProductConfiguration,
): CafeProductCopy {
  if (config.copy !== undefined) return config.copy;
  const menuEntryId = parseCafeProductId(config.menuEntryId);
  if (menuEntryId === undefined) throw new Error("Unknown café item");
  return cafeProductCopy(language, menuEntryId);
}

function cafeProductCopy(
  language: CafeLanguage,
  menuEntryId: CafeProductId,
): CafeProductCopy {
  if (isPatisserieProductId(menuEntryId)) {
    const product = patisserieProduct(menuEntryId);
    if (product === undefined) throw new Error("Unknown pâtisserie item");
    return product.copy[language];
  }
  return CAFE_PRODUCT_COPY[language][menuEntryId];
}

function isPatisserieProductId(
  menuEntryId: CafeProductId,
): menuEntryId is PatisserieProductId {
  return menuEntryId.startsWith("menu_entry_patisserie_");
}

export function cafeProductPreparation(
  copy: CafeInterfaceCopy,
  preparation: CafeProductConfiguration["preparation"],
): Readonly<{ label: string; timing: string }> {
  switch (preparation) {
    case "made_to_order":
      return { label: copy.madeToOrder, timing: copy.readyInMinutes };
    case "baked_today":
      return { label: copy.bakedToday, timing: copy.readyNow };
    case "unstated":
      return { label: "", timing: "" };
    default:
      return assertNever(preparation, "Unhandled storefront state");
  }
}

export function cafeMenuItemCount(copy: CafeInterfaceCopy, count: number): string {
  return copy.htmlLanguage === "ja"
    ? `${count}商品`
    : `${count} menu ${count === 1 ? "item" : "items"}`;
}

export function cafeCategoryItemCount(
  copy: CafeInterfaceCopy,
  products: readonly CafeProductSelection[],
  category: CafeProductConfiguration["category"],
): string {
  let count = 0;
  for (const product of products)
    if (product.config.category === category) count += 1;
  return cafeMenuItemCount(copy, count);
}

export function cafeModifierName(
  language: CafeLanguage,
  modifierOptionId: string,
  fallback: string,
): string {
  return modifierOptionId === "modifier_option_oat_milk"
    ? cafeInterfaceCopy(language).oatMilk
    : fallback;
}

function parseCafeProductId(
  value: string | undefined,
): CafeProductId | undefined {
  if (value === undefined) return undefined;
  return CAFE_PRODUCT_CONFIGURATIONS.find(
    hasCafeProductConfigurationId.bind(undefined, value),
  )?.menuEntryId;
}

/**
 * The café product of a menu line. A menu published from the Portal names its
 * own entries, so the line also matches by the variant that it sells.
 */
function cafeProductIdOfLine(
  line: Readonly<{ menuEntryId: string; variantId: string }>,
): CafeProductId | undefined {
  return (
    parseCafeProductId(line.menuEntryId) ??
    parseCafeProductId(line.variantId.replace(/^variant_/u, "menu_entry_"))
  );
}

function hasCafeProductConfigurationId(
  value: string,
  config: CafeProductConfiguration,
): boolean {
  return config.menuEntryId === value;
}

export function shippingCheckoutReviewLines(
  quote: CommerceBuyerQuotedShippingCheckoutV1,
  listings: readonly CommerceBuyerCatalogListingV1[],
): readonly CheckoutReviewLine[] {
  const lines: CheckoutReviewLine[] = [];
  let lineNumber = 0;
  for (const line of quote.quote.lines) {
    lineNumber += 1;
    const listing = uniqueListing(listings, line.variantId);
    lines.push({
      key: `catalog:${line.variantId}:${lineNumber}`,
      label: listing?.title ?? "Cookie gift box",
      detail: listing?.description ?? "Baked in Japan",
      quantity: line.quantity,
      total: line.lineTotal,
      imageUrl: shippingListingImage(listing).imageUrl,
    });
  }
  return lines;
}

export function cafeCheckoutCopy(
  copy: CafeInterfaceCopy,
  total: Readonly<{ amountMinor: number; currency: string }>,
): CheckoutViewCopy {
  return {
    items: copy.items,
    shipping: "Shipping",
    duty: "Duty",
    tax: copy.tax,
    taxIncluded: copy.taxIncluded,
    total: copy.total,
    expired: copy.quoteExpired,
    refresh: copy.refreshQuote,
    pay: `${copy.pay} · ${money(total)}`,
    edit: copy.editOrder,
    paymentNote: copy.paymentNote,
  };
}

export function shippingCheckoutCopy(
  total: Readonly<{ amountMinor: number; currency: string }>,
): CheckoutViewCopy {
  return {
    items: "Items",
    shipping: "Shipping",
    duty: "Duty",
    tax: "Tax",
    taxIncluded: "Includes tax",
    total: "Total",
    expired:
      "This quote expired. Refresh it to confirm current stock, shipping, duty, and tax.",
    refresh: "Refresh quote",
    pay: `Pay securely · ${money(total)}`,
    edit: "Edit basket and address",
    paymentNote:
      "Payment details are collected securely by the payment provider selected by this store.",
  };
}

export function cafeOrderViewCopy(copy: CafeInterfaceCopy): OrderViewCopy {
  return {
    paid: copy.paid,
    nextAction: copy.nextAction,
    lastUpdated: copy.lastUpdated,
    progress: copy.orderProgress,
    returnUrl: copy.returnUrl,
    returnUrlDetail: copy.returnUrlDetail,
    copyLink: copy.copyLink,
    refresh: copy.refreshStatus,
  };
}

const SHIPPING_COUNTRY_COPY: Readonly<
  Record<"JP" | "SG", ShippingCountryCopy>
> = {
  JP: {
    name: "Japan",
    heroDetail:
      "Our neko cookies are baked in Japan and packed for delivery within Japan.",
    deliveryHeading: "Delivery to Japan",
    deliveryDetail: "Enter the address to calculate a domestic carrier quote.",
    destinationDetail: "Delivery quotes are calculated for Japan addresses.",
    noServices:
      "No delivery services are published for Japan. Check again later.",
    correctionDetail:
      "The address provider found a formatting correction for Japan. Review both versions before continuing.",
    localityLabel: "City or ward",
    areaLabel: "Prefecture",
    postalLabel: "Postal code",
    postalInputMode: "numeric",
    postalPattern: "[0-9]{3}-?[0-9]{4}",
    postalHint: "Use a seven-digit Japanese postal code.",
    quoteEyebrow: "Domestic delivery quote",
    quoteTitle: "Ready to send within Japan",
    quoteDetail: "tracked delivery within Japan from Tokyo.",
    orderEyebrow: "Japan domestic delivery",
  },
  SG: {
    name: "Singapore",
    heroDetail:
      "Our neko cookies are baked in Japan and packed for international delivery to Singapore.",
    deliveryHeading: "Delivery to Singapore",
    deliveryDetail:
      "Enter the address to calculate an international carrier quote.",
    destinationDetail:
      "Delivery quotes are calculated for Singapore addresses.",
    noServices:
      "No delivery services are published for Singapore. Check again later.",
    correctionDetail:
      "The address provider found a formatting correction for Singapore. Review both versions before continuing.",
    localityLabel: "City",
    areaLabel: "Region",
    postalLabel: "Postal code",
    postalInputMode: "numeric",
    postalPattern: "[0-9]{6}",
    postalHint: "Use a six-digit Singapore postal code.",
    quoteEyebrow: "International delivery quote",
    quoteTitle: "Ready to send to Singapore",
    quoteDetail: "tracked delivery from Tokyo.",
    orderEyebrow: "Japan to Singapore",
  },
};

const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

/** Copy for a destination of a general international route. */
function internationalCountryCopy(
  countryCode: CommerceInternationalShippingCountry,
): ShippingCountryCopy {
  const name = REGION_NAMES.of(countryCode) ?? countryCode;
  const unitedStates = countryCode === "US";
  const australia = countryCode === "AU";
  return {
    name,
    heroDetail: `Our neko cookies are baked in Japan and packed for international delivery to ${name}.`,
    deliveryHeading: `Delivery to ${name}`,
    deliveryDetail:
      "Enter the address to calculate an international carrier quote.",
    destinationDetail: `Delivery quotes are calculated for ${name} addresses.`,
    noServices: `No delivery services are published for ${name}. Check again later.`,
    correctionDetail: `The address provider found a formatting correction for ${name}. Review both versions before continuing.`,
    localityLabel: australia ? "Suburb or city" : "City",
    areaLabel: "State",
    postalLabel: unitedStates
      ? "ZIP code"
      : australia
        ? "Postcode"
        : "Postal code",
    postalInputMode: unitedStates || australia ? "numeric" : undefined,
    postalPattern: unitedStates
      ? "[0-9]{5}(-[0-9]{4})?"
      : australia
        ? "[0-9]{4}"
        : undefined,
    postalHint: unitedStates
      ? "Use a five-digit ZIP code."
      : australia
        ? "Use a four-digit postcode."
        : `Use the postal code of ${name}.`,
    quoteEyebrow: "International delivery quote",
    quoteTitle: `Ready to send to ${name}`,
    quoteDetail: "tracked delivery from Tokyo.",
    orderEyebrow: `Japan to ${name}`,
  };
}

export function shippingCountryCopy(
  countryCode: ShippingCountryCode,
): ShippingCountryCopy {
  return countryCode === "JP" || countryCode === "SG"
    ? SHIPPING_COUNTRY_COPY[countryCode]
    : internationalCountryCopy(countryCode);
}

export function initialShippingAddress(
  countryCode: ShippingCountryCode,
): ShippingAddressDraft {
  switch (countryCode) {
    case "JP":
      return {
        countryCode,
        recipientName: "",
        addressLine1: "",
        locality: "",
        administrativeArea: "",
        postalCode: "",
      };
    case "SG":
      return {
        countryCode,
        recipientName: "",
        addressLine1: "",
        locality: "Singapore",
        postalCode: "",
      };
    default:
      return {
        countryCode,
        recipientName: "",
        addressLine1: "",
        locality: "",
        ...(commerceAddressNeedsState(countryCode)
          ? { administrativeArea: "" }
          : {}),
        postalCode: "",
      };
  }
}

export function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

export function cafeInterfaceCopy(language: CafeLanguage): CafeInterfaceCopy {
  return CAFE_INTERFACE_COPY[language];
}

export function money(
  value: Readonly<{ amountMinor: number; currency: string }>,
): string {
  const digits = CURRENCY_MINOR_UNITS[value.currency] ?? 2;
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: value.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value.amountMinor / 10 ** digits);
}
