import {
  collectionRuleMatches,
  parseCollection,
  parseCreateCollectionCommand,
  parseDeleteCollectionCommand,
  parseUpdateCollectionCommand,
  type CommerceBuyerCollectionPageV1,
  type CommerceBuyerCollectionProductV1,
  type CommerceBuyerCollectionSummaryV1,
  type CommerceCollectionCommandV1,
  type CommerceCollectionPageFilterV1,
  type CommerceCollectionSelectionV1,
  type CommerceCollectionV1,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
  type CommerceProductV1,
} from "@seams/commerce-client";

import {
  listOffers,
  listProducts,
  listVariants,
} from "../../commerce-persistence.ts";
import type { CommerceDatabase } from "../../database.ts";

export type CollectionMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

export type CollectionCommitRequest = Readonly<{
  command: CommerceCollectionCommandV1;
  merchant: CollectionMerchantRow;
  collectionId: string;
  revision: number;
  write: () => void;
}>;

type CollectionAuthorityOptions = Readonly<{
  database: CommerceDatabase;
  readMerchant: (merchantId: string) => CollectionMerchantRow | undefined;
  readReplay: (
    merchantId: string,
    idempotencyKey: string,
    command: CommerceCollectionCommandV1,
  ) => CommerceMutationResultV1 | undefined;
  validateMerchant: (
    merchantId: string,
    merchant: CollectionMerchantRow | undefined,
  ) => CommerceMutationErrorV1 | undefined;
  rejected: (error: CommerceMutationErrorV1) => CommerceMutationResultV1;
  invalidCommand: (error: unknown) => CommerceMutationErrorV1;
  commit: (request: CollectionCommitRequest) => CommerceMutationResultV1;
}>;

/** A product as a collection sees it on one sales channel. */
type ProductFacts = Readonly<{
  product: CommerceProductV1;
  /** The lowest listed price on the channel, or null when not on sale. */
  price: Readonly<{ amountMinor: number; currency: string }> | null;
  available: boolean;
}>;

const PAGE_LIMIT = 100;

export class CollectionAuthority {
  readonly #options: CollectionAuthorityOptions;

  constructor(options: CollectionAuthorityOptions) {
    this.#options = options;
  }

  createCollection(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseCreateCollectionCommand, (command) => {
      if (this.#read(command.merchantId, command.collectionId) !== undefined)
        return {
          code: "resource_already_exists",
          kind: "collection",
          id: command.collectionId,
        };
      if (this.#byHandle(command.merchantId, command.handle) !== undefined)
        return invalid("collection.handle.taken");
      const unknown = this.#unknownProduct(command.merchantId, command.selection);
      if (unknown !== undefined)
        return { code: "resource_not_found", kind: "product", id: unknown };
      const collection: CommerceCollectionV1 = {
        id: command.collectionId,
        revision: 1,
        handle: command.handle,
        title: command.title,
        description: command.description,
        salesChannelId: command.salesChannelId,
        sortOrder: command.sortOrder,
        status: command.status,
        selection: command.selection,
        productIds: [],
        occurredAt: command.requestedAt,
      };
      return {
        collectionId: collection.id,
        revision: 1,
        write: () => this.#write(command.merchantId, collection, undefined),
      };
    });
  }

  updateCollection(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseUpdateCollectionCommand, (command) => {
      const current = this.#current(
        command.merchantId,
        command.collectionId,
        command.expectedRevision,
      );
      if ("code" in current) return current;
      const next: CommerceCollectionV1 = {
        ...current,
        ...command.changes,
        revision: current.revision + 1,
        occurredAt: command.requestedAt,
      };
      if (next.sortOrder === "manual" && next.selection.kind !== "manual")
        return invalid("collection.sortOrder");
      const unknown = this.#unknownProduct(command.merchantId, next.selection);
      if (unknown !== undefined)
        return { code: "resource_not_found", kind: "product", id: unknown };
      return {
        collectionId: next.id,
        revision: next.revision,
        write: () => this.#write(command.merchantId, next, current.revision),
      };
    });
  }

  deleteCollection(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseDeleteCollectionCommand, (command) => {
      const current = this.#current(
        command.merchantId,
        command.collectionId,
        command.expectedRevision,
      );
      if ("code" in current) return current;
      return {
        collectionId: current.id,
        revision: current.revision + 1,
        write: () => {
          const { database } = this.#options;
          database
            .prepare(
              "DELETE FROM collection_member WHERE merchant_id = ? AND collection_id = ?",
            )
            .run(command.merchantId, current.id);
          database
            .prepare("DELETE FROM collection WHERE merchant_id = ? AND collection_id = ?")
            .run(command.merchantId, current.id);
        },
      };
    });
  }

  listCollections(merchantId: string): readonly CommerceCollectionV1[] {
    return this.#options.database
      .prepare(
        `SELECT collection_json AS json FROM collection
         WHERE merchant_id = ? ORDER BY handle`,
      )
      .all<Readonly<{ json: string }>>(merchantId)
      .map((row) => this.#withMembers(merchantId, parseCollection(JSON.parse(row.json))));
  }

  /**
   * Inside a catalog command's transaction: brings every automated
   * collection's members up to date with the catalog it just wrote.
   */
  refreshAutomated(merchantId: string): void {
    const collections = this.listCollections(merchantId).filter(
      (collection) => collection.selection.kind === "automated",
    );
    if (collections.length === 0) return;
    const facts = new Map<string, readonly ProductFacts[]>();
    for (const collection of collections) {
      const channel = collection.salesChannelId;
      const products =
        facts.get(channel) ?? this.#facts(merchantId, channel);
      facts.set(channel, products);
      this.#replaceMembers(merchantId, collection, products);
    }
  }

  buyerCollections(
    merchantId: string,
    salesChannelId: string,
  ): readonly CommerceBuyerCollectionSummaryV1[] {
    return this.listCollections(merchantId)
      .filter(
        (collection) =>
          collection.status === "active" &&
          collection.salesChannelId === salesChannelId,
      )
      .map(summary);
  }

  buyerCollectionPage(
    merchantId: string,
    salesChannelId: string,
    handle: string,
    filter: CommerceCollectionPageFilterV1,
  ): CommerceBuyerCollectionPageV1 | undefined {
    const found = this.#byHandle(merchantId, handle);
    const collection =
      found === undefined ? undefined : this.#withMembers(merchantId, found);
    if (
      collection === undefined ||
      collection.status !== "active" ||
      collection.salesChannelId !== salesChannelId
    )
      return undefined;
    const facts = new Map(
      this.#facts(merchantId, salesChannelId).map((item) => [item.product.id, item]),
    );
    // A product off sale or not active stays a member but is not shown.
    const visible: ProductFacts[] = [];
    for (const productId of collection.productIds) {
      const item = facts.get(productId);
      if (item === undefined || item.price === null || item.product.status !== "active")
        continue;
      if (filter.tag !== undefined && !item.product.tags.includes(filter.tag)) continue;
      if (filter.minimumPrice !== undefined && item.price.amountMinor < filter.minimumPrice)
        continue;
      if (filter.maximumPrice !== undefined && item.price.amountMinor > filter.maximumPrice)
        continue;
      if (filter.availableOnly === true && !item.available) continue;
      visible.push(item);
    }
    sortProducts(visible, collection.sortOrder);
    const start = filter.after === undefined ? 0 : Number(filter.after);
    if (!Number.isSafeInteger(start) || start < 0) return undefined;
    const limit = Math.max(1, Math.min(PAGE_LIMIT, filter.limit ?? 24));
    const page = visible.slice(start, start + limit);
    return {
      schemaVersion: "underclerk.buyer-collection-page.v1",
      collection: summary(collection),
      products: page.map(buyerProduct),
      nextCursor: start + limit < visible.length ? String(start + limit) : null,
    };
  }

  #write(
    merchantId: string,
    collection: CommerceCollectionV1,
    previousRevision: number | undefined,
  ): void {
    const { database } = this.#options;
    const stored = { ...collection, productIds: [] };
    if (previousRevision === undefined) {
      database
        .prepare(
          `INSERT INTO collection (
             merchant_id, collection_id, revision, handle, sales_channel_id,
             status, collection_json, occurred_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          merchantId,
          collection.id,
          collection.revision,
          collection.handle,
          collection.salesChannelId,
          collection.status,
          JSON.stringify(stored),
          collection.occurredAt,
        );
    } else {
      const written = database
        .prepare(
          `UPDATE collection SET revision = ?, status = ?, collection_json = ?,
             occurred_at = ?
           WHERE merchant_id = ? AND collection_id = ? AND revision = ?`,
        )
        .run(
          collection.revision,
          collection.status,
          JSON.stringify(stored),
          collection.occurredAt,
          merchantId,
          collection.id,
          previousRevision,
        );
      if (written.changes !== 1)
        throw new Error(`Collection ${collection.id} moved during the write`);
    }
    this.#replaceMembers(
      merchantId,
      collection,
      this.#facts(merchantId, collection.salesChannelId),
    );
  }

  // Manual members keep the staff order; automated members are the products
  // the rule selects, in catalog order.
  #replaceMembers(
    merchantId: string,
    collection: CommerceCollectionV1,
    facts: readonly ProductFacts[],
  ): void {
    const { database } = this.#options;
    const members =
      collection.selection.kind === "manual"
        ? collection.selection.productIds
        : facts
            .filter((item) =>
              collection.selection.kind === "automated" &&
              item.product.status === "active" &&
              collectionRuleMatches(collection.selection.rule, {
                title: item.product.title,
                productType: item.product.productType,
                vendor: item.product.vendor,
                tags: item.product.tags,
                priceMinor: item.price?.amountMinor ?? null,
              }),
            )
            .map((item) => item.product.id);
    const current = this.#members(merchantId, collection.id);
    if (current.length === members.length && current.every((id, i) => id === members[i]))
      return;
    database
      .prepare("DELETE FROM collection_member WHERE merchant_id = ? AND collection_id = ?")
      .run(merchantId, collection.id);
    members.forEach((productId, position) =>
      database
        .prepare(
          `INSERT INTO collection_member (merchant_id, collection_id, product_id, position)
           VALUES (?, ?, ?, ?)`,
        )
        .run(merchantId, collection.id, productId, position),
    );
  }

  #facts(merchantId: string, salesChannelId: string): readonly ProductFacts[] {
    const { database } = this.#options;
    const variants = listVariants(database, merchantId);
    const offers = listOffers(database, merchantId).filter(
      (offer) =>
        offer.salesChannelId === salesChannelId && offer.lifecycle.state === "listed",
    );
    return listProducts(database, merchantId)
      .slice()
      .sort((left, right) => (left.id < right.id ? -1 : 1))
      .map((product) => {
        const variantIds = new Set(
          variants
            .filter(
              (variant) => variant.productId === product.id && variant.status === "active",
            )
            .map((variant) => variant.id),
        );
        const productOffers = offers.filter((offer) => variantIds.has(offer.variantId));
        let price: ProductFacts["price"] = null;
        for (const offer of productOffers)
          if (price === null || offer.price.amountMinor < price.amountMinor)
            price = offer.price;
        return {
          product,
          price,
          available: productOffers.some((offer) => offer.availability.state === "available"),
        };
      });
  }

  #run<TCommand extends CommerceCollectionCommandV1>(
    rawCommand: unknown,
    parse: (value: unknown) => TCommand,
    plan: (
      command: TCommand,
    ) => Omit<CollectionCommitRequest, "command" | "merchant"> | CommerceMutationErrorV1,
  ): CommerceMutationResultV1 {
    let command: TCommand;
    try {
      command = parse(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined) return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    const planned = plan(command);
    if ("code" in planned) return this.#options.rejected(planned);
    return this.#options.commit({ command, merchant, ...planned });
  }

  #current(
    merchantId: string,
    collectionId: string,
    expectedRevision: number,
  ): CommerceCollectionV1 | CommerceMutationErrorV1 {
    const current = this.#read(merchantId, collectionId);
    if (current === undefined)
      return { code: "resource_not_found", kind: "collection", id: collectionId };
    if (current.revision !== expectedRevision)
      return {
        code: "stale_resource_revision",
        kind: "collection",
        id: collectionId,
        expected: expectedRevision,
        actual: current.revision,
      };
    return current;
  }

  #unknownProduct(
    merchantId: string,
    selection: CommerceCollectionSelectionV1,
  ): string | undefined {
    if (selection.kind !== "manual") return undefined;
    const known = new Set(
      listProducts(this.#options.database, merchantId).map((product) => product.id),
    );
    return selection.productIds.find((productId) => !known.has(productId));
  }

  #read(merchantId: string, collectionId: string): CommerceCollectionV1 | undefined {
    const row = this.#options.database
      .prepare(
        "SELECT collection_json AS json FROM collection WHERE merchant_id = ? AND collection_id = ?",
      )
      .get<Readonly<{ json: string }>>(merchantId, collectionId);
    return row === undefined ? undefined : parseCollection(JSON.parse(row.json));
  }

  #byHandle(merchantId: string, handle: string): CommerceCollectionV1 | undefined {
    const row = this.#options.database
      .prepare(
        "SELECT collection_json AS json FROM collection WHERE merchant_id = ? AND handle = ?",
      )
      .get<Readonly<{ json: string }>>(merchantId, handle);
    return row === undefined ? undefined : parseCollection(JSON.parse(row.json));
  }

  #members(merchantId: string, collectionId: string): readonly string[] {
    return this.#options.database
      .prepare(
        `SELECT product_id AS productId FROM collection_member
         WHERE merchant_id = ? AND collection_id = ? ORDER BY position`,
      )
      .all<Readonly<{ productId: string }>>(merchantId, collectionId)
      .map((row) => row.productId);
  }

  #withMembers(
    merchantId: string,
    collection: CommerceCollectionV1,
  ): CommerceCollectionV1 {
    return { ...collection, productIds: this.#members(merchantId, collection.id) };
  }
}

function sortProducts(
  items: ProductFacts[],
  order: CommerceCollectionV1["sortOrder"],
): void {
  const byTitle = (left: ProductFacts, right: ProductFacts) =>
    left.product.title.localeCompare(right.product.title) ||
    (left.product.id < right.product.id ? -1 : 1);
  const price = (item: ProductFacts) => item.price?.amountMinor ?? 0;
  switch (order) {
    case "manual":
      return;
    case "title":
      items.sort(byTitle);
      return;
    case "price_ascending":
      items.sort((left, right) => price(left) - price(right) || byTitle(left, right));
      return;
    case "price_descending":
      items.sort((left, right) => price(right) - price(left) || byTitle(left, right));
      return;
    case "newest":
      items.sort(
        (left, right) =>
          right.product.occurredAt.localeCompare(left.product.occurredAt) ||
          byTitle(left, right),
      );
  }
}

function summary(collection: CommerceCollectionV1): CommerceBuyerCollectionSummaryV1 {
  return {
    handle: collection.handle,
    title: collection.title,
    description: collection.description,
  };
}

function buyerProduct(item: ProductFacts): CommerceBuyerCollectionProductV1 {
  if (item.price === null) throw new Error("A visible product has a price");
  return {
    productId: item.product.id,
    title: item.product.title,
    handle: item.product.handle,
    price: item.price,
    available: item.available,
    tags: item.product.tags,
  };
}

function invalid(field: string): CommerceMutationErrorV1 {
  return { code: "resource_relationship_invalid", field };
}

/** Removes a product that no longer exists from every collection. */
export function removeProductFromCollections(
  database: CommerceDatabase,
  merchantId: string,
  productId: string,
): void {
  database
    .prepare(
      "DELETE FROM collection_member WHERE merchant_id = ? AND product_id = ?",
    )
    .run(merchantId, productId);
}
