// Collections (Plan 76A step 6). A collection is a storefront list of
// products: chosen by staff in an order (manual), or chosen by a rule over
// product fields (automated). Membership is stored; a catalog change updates
// the members of every automated collection in the same transaction.
import type { CommerceEngineTimestamp } from "./commerce-resources.ts";
import { parseCreateCommerceCollectionV1 as parseCreateCommerceCollectionV1Record, parseDeleteCommerceCollectionV1 as parseDeleteCommerceCollectionV1Record, parseCommerceBuyerCollectionPageV1 as parseCommerceBuyerCollectionPageV1Record, parseCommerceBuyerCollectionsV1 as parseCommerceBuyerCollectionsV1Record, parseCommerceCollectionV1 as parseCommerceCollectionV1Record, parseUpdateCommerceCollectionV1 as parseUpdateCommerceCollectionV1Record, parseCommerceCollectionsV1 as parseCommerceCollectionsV1Record } from "@purin-labs/commerce-contracts/records/api-collections";
import { decodeRecord } from "./entity-plane/record-decoding.ts";

type Money = Readonly<{ amountMinor: number; currency: string }>;

export const COLLECTION_SORT_ORDERS = [
  "manual",
  "title",
  "price_ascending",
  "price_descending",
  "newest",
] as const;
export type CommerceCollectionSortOrder =
  (typeof COLLECTION_SORT_ORDERS)[number];

export type CommerceCollectionConditionV1 =
  | Readonly<{ field: "tag" | "product_type" | "vendor"; equals: string }>
  | Readonly<{ field: "title"; contains: string }>
  | Readonly<{ field: "price"; below: number }>
  | Readonly<{ field: "price"; atLeast: number }>;

export type CommerceCollectionRuleV1 = Readonly<{
  match: "all" | "any";
  conditions: readonly CommerceCollectionConditionV1[];
}>;

export type CommerceCollectionSelectionV1 =
  | Readonly<{ kind: "manual"; productIds: readonly string[] }>
  | Readonly<{ kind: "automated"; rule: CommerceCollectionRuleV1 }>;

export type CommerceCollectionV1 = Readonly<{
  id: string;
  revision: number;
  handle: string;
  title: string;
  description: string;
  salesChannelId: string;
  sortOrder: CommerceCollectionSortOrder;
  status: "active" | "draft";
  selection: CommerceCollectionSelectionV1;
  /** Stored members, in collection order before the sort is applied. */
  productIds: readonly string[];
  occurredAt: CommerceEngineTimestamp;
}>;

type CollectionCommandBase = Readonly<{
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
  collectionId: string;
}>;

export type CreateCommerceCollectionV1 = CollectionCommandBase &
  Readonly<{
    schemaVersion: "commerce.create-collection.v1";
    handle: string;
    title: string;
    description: string;
    salesChannelId: string;
    sortOrder: CommerceCollectionSortOrder;
    status: "active" | "draft";
    selection: CommerceCollectionSelectionV1;
  }>;

export type UpdateCommerceCollectionV1 = CollectionCommandBase &
  Readonly<{
    schemaVersion: "commerce.update-collection.v1";
    expectedRevision: number;
    changes: Readonly<{
      title?: string;
      description?: string;
      sortOrder?: CommerceCollectionSortOrder;
      status?: "active" | "draft";
      selection?: CommerceCollectionSelectionV1;
    }>;
  }>;

export type DeleteCommerceCollectionV1 = CollectionCommandBase &
  Readonly<{
    schemaVersion: "commerce.delete-collection.v1";
    expectedRevision: number;
  }>;

export type CommerceCollectionCommandV1 =
  | CreateCommerceCollectionV1
  | UpdateCommerceCollectionV1
  | DeleteCommerceCollectionV1;

export type CommerceBuyerCollectionSummaryV1 = Readonly<{
  handle: string;
  title: string;
  description: string;
}>;

export type CommerceBuyerCollectionsV1 = Readonly<{
  schemaVersion: "commerce.buyer-collections.v1";
  collections: readonly CommerceBuyerCollectionSummaryV1[];
}>;

export type CommerceBuyerCollectionProductV1 = Readonly<{
  productId: string;
  title: string;
  handle: string | null;
  price: Money;
  available: boolean;
  tags: readonly string[];
}>;

export type CommerceBuyerCollectionPageV1 = Readonly<{
  schemaVersion: "commerce.buyer-collection-page.v1";
  collection: CommerceBuyerCollectionSummaryV1;
  products: readonly CommerceBuyerCollectionProductV1[];
  /** Pass as `after` for the next page; null on the last page. */
  nextCursor: string | null;
}>;

export type CommerceCollectionPageFilterV1 = Readonly<{
  after?: string;
  limit?: number;
  tag?: string;
  minimumPrice?: number;
  maximumPrice?: number;
  availableOnly?: boolean;
}>;

export function parseCreateCollectionCommand(value: unknown): CreateCommerceCollectionV1 {
  return decodeRecord(parseCreateCommerceCollectionV1Record, value);
}

export function parseUpdateCollectionCommand(value: unknown): UpdateCommerceCollectionV1 {
  return decodeRecord(parseUpdateCommerceCollectionV1Record, value);
}

export function parseDeleteCollectionCommand(value: unknown): DeleteCommerceCollectionV1 {
  return decodeRecord(parseDeleteCommerceCollectionV1Record, value);
}

export function parseCollection(value: unknown): CommerceCollectionV1 {
  return decodeRecord(parseCommerceCollectionV1Record, value);
}

export function parseCollections(value: unknown): readonly CommerceCollectionV1[] {
  return decodeRecord(parseCommerceCollectionsV1Record, value);
}

export function parseBuyerCollections(value: unknown): CommerceBuyerCollectionsV1 {
  return decodeRecord(parseCommerceBuyerCollectionsV1Record, value);
}

export function parseBuyerCollectionPage(value: unknown): CommerceBuyerCollectionPageV1 {
  return decodeRecord(parseCommerceBuyerCollectionPageV1Record, value);
}

/** Whether a product's fields satisfy a collection rule. */
export function collectionRuleMatches(
  rule: CommerceCollectionRuleV1,
  product: Readonly<{
    title: string;
    productType: string;
    vendor: string;
    tags: readonly string[];
    priceMinor: number | null;
  }>,
): boolean {
  const test = (condition: CommerceCollectionConditionV1): boolean => {
    switch (condition.field) {
      case "tag":
        return product.tags.includes(condition.equals);
      case "product_type":
        return product.productType === condition.equals;
      case "vendor":
        return product.vendor === condition.equals;
      case "title":
        return product.title.toLowerCase().includes(condition.contains.toLowerCase());
      case "price":
        if (product.priceMinor === null) return false;
        return "below" in condition
          ? product.priceMinor < condition.below
          : product.priceMinor >= condition.atLeast;
    }
  };
  return rule.match === "all"
    ? rule.conditions.every(test)
    : rule.conditions.some(test);
}
