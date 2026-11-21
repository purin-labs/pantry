// Staff edits of catalog records (Plan 76A step 1). Each command names one
// record and its expected revision, and changes only the fields it carries.
import {
  type CommerceOfferV1,
  type CommerceProductStatus,
  type CommerceProductV1,
  type CommerceEngineTimestamp,
  type CommerceVariantStatus,
  type CommerceVariantV1,
  type CommerceResourcesV1,
} from "./commerce-resources.ts";
import type { StorefrontTaxConfiguration } from "@purin-labs/commerce-contracts";
import type { Menu } from "@purin-labs/commerce-contracts/records/commerce-records";
import { parseUpdateCommerceStorefrontTaxV1 as parseUpdateCommerceStorefrontTaxV1Record } from "@purin-labs/commerce-contracts/records/api-catalog-edits";
import { parseDeleteCommerceProductV1 as parseDeleteCommerceProductV1Record, parseUpdateCommerceOfferV1 as parseUpdateCommerceOfferV1Record, parseUpdateCommerceProductV1 as parseUpdateCommerceProductV1Record, parseUpdateCommerceVariantV1 as parseUpdateCommerceVariantV1Record } from "@purin-labs/commerce-contracts/records/api-catalog-edits";
import { decodeRecord } from "./entity-plane/record-decoding.ts";

type CatalogEditBase = Readonly<{
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
}>;

export type CommerceProductChangesV1 = Readonly<{
  title?: string;
  description?: string;
  handle?: string | null;
  productType?: string;
  vendor?: string;
  tags?: readonly string[];
  status?: CommerceProductStatus;
}>;

export type DeleteCommerceProductV1 = CatalogEditBase &
  Readonly<{
    schemaVersion: "commerce.delete-product.v1";
    productId: string;
    expectedProductRevision: number;
  }>;

export type UpdateCommerceProductV1 = CatalogEditBase &
  Readonly<{
    schemaVersion: "commerce.update-product.v1";
    productId: string;
    expectedProductRevision: number;
    changes: CommerceProductChangesV1;
  }>;

export type CommerceVariantChangesV1 = Readonly<{
  title?: string;
  sku?: string;
  barcode?: string | null;
  options?: CommerceVariantV1["options"];
  media?: CommerceVariantV1["media"];
  status?: CommerceVariantStatus;
}>;

export type UpdateCommerceVariantV1 = CatalogEditBase &
  Readonly<{
    schemaVersion: "commerce.update-variant.v1";
    variantId: string;
    expectedVariantRevision: number;
    changes: CommerceVariantChangesV1;
  }>;

export type CommerceOfferChangesV1 = Readonly<{
  price?: CommerceOfferV1["price"];
  compareAtPrice?: CommerceOfferV1["compareAtPrice"];
  /** `archived` takes a listed offer off sale; `listed` puts it back. */
  listing?: "listed" | "archived";
}>;

export type UpdateCommerceOfferV1 = CatalogEditBase &
  Readonly<{
    schemaVersion: "commerce.update-offer.v1";
    offerId: string;
    expectedOfferRevision: number;
    changes: CommerceOfferChangesV1;
  }>;

/** Changes a storefront's tax rule; the storefront gets a new revision. */
export type UpdateCommerceStorefrontTaxV1 = CatalogEditBase &
  Readonly<{
    schemaVersion: "commerce.update-storefront-tax.v1";
    storefrontId: string;
    expectedStorefrontRevision: number;
    tax: StorefrontTaxConfiguration;
  }>;

export function parseUpdateStorefrontTaxCommand(
  value: unknown,
): UpdateCommerceStorefrontTaxV1 {
  return decodeRecord(parseUpdateCommerceStorefrontTaxV1Record, value);
}

export function parseUpdateProductCommand(value: unknown): UpdateCommerceProductV1 {
  return decodeRecord(parseUpdateCommerceProductV1Record, value);
}

export function parseDeleteProductCommand(value: unknown): DeleteCommerceProductV1 {
  return decodeRecord(parseDeleteCommerceProductV1Record, value);
}

/**
 * The refusals that a merchant snapshot can show: a product with an order line
 * keeps its history, and a published menu entry needs its offer. The Portal
 * reads this before it offers Delete; the delete command checks it again.
 */
export function productDeleteBlock(
  productId: string,
  resources: Pick<CommerceResourcesV1, "variants" | "offers" | "orders">,
  menus: readonly Menu[],
): "sold" | "on_menu" | null {
  const variantIds = new Set<string>();
  for (const variant of resources.variants)
    if (variant.productId === productId) variantIds.add(variant.id);
  for (const order of resources.orders)
    for (const line of order.lineItems)
      if ("variantId" in line.source && variantIds.has(line.source.variantId))
        return "sold";
  const offerIds = new Set<string>();
  for (const offer of resources.offers)
    if (variantIds.has(offer.variantId)) offerIds.add(offer.id);
  for (const menu of menus) {
    if (menu.lifecycle.state !== "published") continue;
    for (const entry of menu.entries)
      if (entry.lifecycle === "active" && offerIds.has(entry.offerId))
        return "on_menu";
  }
  return null;
}

export function parseUpdateVariantCommand(value: unknown): UpdateCommerceVariantV1 {
  return decodeRecord(parseUpdateCommerceVariantV1Record, value);
}

export function parseUpdateOfferCommand(value: unknown): UpdateCommerceOfferV1 {
  return decodeRecord(parseUpdateCommerceOfferV1Record, value);
}

/** The product after a validated update; the caller checks the revision. */
export function applyProductChanges(
  product: CommerceProductV1,
  changes: CommerceProductChangesV1,
  occurredAt: CommerceEngineTimestamp,
): CommerceProductV1 {
  return {
    ...product,
    ...changes,
    revision: product.revision + 1,
    occurredAt,
  };
}

export function applyVariantChanges(
  variant: CommerceVariantV1,
  changes: CommerceVariantChangesV1,
  occurredAt: CommerceEngineTimestamp,
): CommerceVariantV1 {
  return {
    ...variant,
    ...changes,
    revision: variant.revision + 1,
    occurredAt,
  };
}
