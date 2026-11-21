import {
  parseCreateMediaCommand,
  parseDeleteMediaCommand,
  parseMediaRecord,
  parseProductMedia,
  parseSetProductMediaCommand,
  parseUpdateMediaCommand,
  type CommerceMediaCommandV1,
  type CommerceMediaLibraryV1,
  type CommerceMediaV1,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
  type CommerceProductMediaV1,
  type CommerceVariantV1,
} from "@purin-labs/commerce-client";

import { listProducts, listVariants } from "../../commerce-persistence.ts";
import type { CommerceDatabase } from "../../database.ts";
import type { MerchantRow } from "../../commerce-authority/ledger.ts";
import {
  commitPlannedCommand,
  type MerchantCommandPorts,
} from "../../commerce-authority/merchant-command.ts";
import type { StoredMedia } from "./media-store.ts";

export type MediaCommitRequest = Readonly<{
  command: CommerceMediaCommandV1;
  merchant: MerchantRow;
  resource: Readonly<{
    kind: "media" | "product_media";
    id: string;
    revision: number;
  }>;
  write: () => void;
}>;

type MediaAuthorityOptions = MerchantCommandPorts<CommerceMediaCommandV1> &
  Readonly<{
    database: CommerceDatabase;
    commit: (request: MediaCommitRequest) => CommerceMutationResultV1;
  }>;

type Planned = Omit<MediaCommitRequest, "command" | "merchant">;

export class MediaAuthority {
  readonly #options: MediaAuthorityOptions;

  constructor(options: MediaAuthorityOptions) {
    this.#options = options;
  }

  /** `uploaded` is what the store holds under the command's digest, if anything. */
  createMedia(
    rawCommand: unknown,
    uploaded: StoredMedia | null,
  ): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseCreateMediaCommand, (command) => {
      const { database } = this.#options;
      if (
        readMedia(database, command.merchantId, command.mediaId) !== undefined
      )
        return {
          code: "resource_already_exists",
          kind: "media",
          id: command.mediaId,
        };
      if (uploaded === null || uploaded.sha256 !== command.sha256)
        return {
          code: "resource_not_found",
          kind: "media_upload",
          id: command.sha256,
        };
      const media = parseMediaRecord({
        id: command.mediaId,
        revision: 1,
        sha256: command.sha256,
        contentType: uploaded.contentType,
        byteSize: uploaded.size,
        altText: command.altText,
        occurredAt: command.requestedAt,
      });
      return {
        resource: { kind: "media", id: media.id, revision: 1 },
        write: () => writeMedia(database, command.merchantId, media, undefined),
      };
    });
  }

  updateMedia(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseUpdateMediaCommand, (command) => {
      const { database } = this.#options;
      const current = readMedia(database, command.merchantId, command.mediaId);
      const stale = staleMedia(
        current,
        command.mediaId,
        command.expectedRevision,
      );
      if (stale !== undefined || current === undefined)
        return stale ?? notFound(command.mediaId);
      const media = {
        ...current,
        revision: current.revision + 1,
        altText: command.altText,
        occurredAt: command.requestedAt,
      };
      return {
        resource: { kind: "media", id: media.id, revision: media.revision },
        write: () =>
          writeMedia(database, command.merchantId, media, current.revision),
      };
    });
  }

  // A product still showing the image keeps it; staff take it off first.
  deleteMedia(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseDeleteMediaCommand, (command) => {
      const { database } = this.#options;
      const current = readMedia(database, command.merchantId, command.mediaId);
      const stale = staleMedia(
        current,
        command.mediaId,
        command.expectedRevision,
      );
      if (stale !== undefined || current === undefined)
        return stale ?? notFound(command.mediaId);
      if (productsShowing(database, command.merchantId, command.mediaId) > 0)
        return {
          code: "resource_relationship_invalid",
          field: "media.products",
        };
      return {
        resource: {
          kind: "media",
          id: current.id,
          revision: current.revision + 1,
        },
        write: () => {
          const deleted = database
            .prepare(
              "DELETE FROM media WHERE merchant_id = ? AND media_id = ? AND revision = ?",
            )
            .run(command.merchantId, current.id, current.revision);
          if (deleted.changes !== 1)
            throw new Error(`Media ${current.id} moved during the write`);
        },
      };
    });
  }

  setProductMedia(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseSetProductMediaCommand, (command) => {
      const { database } = this.#options;
      const { merchantId, productId } = command;
      if (
        !listProducts(database, merchantId).some(
          (product) => product.id === productId,
        )
      )
        return { code: "resource_not_found", kind: "product", id: productId };
      const current = readProductMedia(database, merchantId, productId);
      const actual = current?.revision ?? 0;
      if (actual !== command.expectedRevision)
        return {
          code: "stale_resource_revision",
          kind: "product_media",
          id: productId,
          expected: command.expectedRevision,
          actual,
        };
      const variants = new Set(
        listVariants(database, merchantId)
          .filter((variant) => variant.productId === productId)
          .map((variant) => variant.id),
      );
      for (const item of command.media) {
        if (readMedia(database, merchantId, item.mediaId) === undefined)
          return notFound(item.mediaId);
        const foreign = item.variantIds.find(
          (variantId) => !variants.has(variantId),
        );
        if (foreign !== undefined)
          return {
            code: "resource_relationship_invalid",
            field: "media.variantIds",
          };
      }
      const list = parseProductMedia({
        productId,
        revision: actual + 1,
        media: command.media,
      });
      return {
        resource: {
          kind: "product_media",
          id: productId,
          revision: list.revision,
        },
        write: () =>
          writeProductMedia(
            database,
            merchantId,
            list,
            current?.revision,
            command.requestedAt,
          ),
      };
    });
  }

  library(merchantId: string): CommerceMediaLibraryV1 {
    const { database } = this.#options;
    return {
      schemaVersion: "commerce.media.v1",
      media: database
        .prepare(
          "SELECT media_json AS json FROM media WHERE merchant_id = ? ORDER BY media_id",
        )
        .all<Readonly<{ json: string }>>(merchantId)
        .map((row) => parseMediaRecord(JSON.parse(row.json))),
      products: database
        .prepare(
          "SELECT media_json AS json FROM product_media WHERE merchant_id = ? ORDER BY product_id",
        )
        .all<Readonly<{ json: string }>>(merchantId)
        .map((row) => parseProductMedia(JSON.parse(row.json))),
    };
  }

  #run<TCommand extends CommerceMediaCommandV1>(
    rawCommand: unknown,
    parse: (value: unknown) => TCommand,
    plan: (command: TCommand) => Planned | CommerceMutationErrorV1,
  ): CommerceMutationResultV1 {
    return commitPlannedCommand(this.#options, rawCommand, parse, plan);
  }
}

/**
 * The images a variant shows: its product's media for every variant or for
 * this one, in the product's order.
 */
export function variantMedia(
  database: CommerceDatabase,
  merchantId: string,
  variant: Pick<CommerceVariantV1, "id" | "productId">,
): readonly CommerceMediaV1[] {
  const list = readProductMedia(database, merchantId, variant.productId);
  if (list === undefined) return [];
  return list.media
    .filter(
      (item) =>
        item.variantIds.length === 0 || item.variantIds.includes(variant.id),
    )
    .map((item) => readMedia(database, merchantId, item.mediaId))
    .filter((media): media is CommerceMediaV1 => media !== undefined);
}

export function readMedia(
  database: CommerceDatabase,
  merchantId: string,
  mediaId: string,
): CommerceMediaV1 | undefined {
  const row = database
    .prepare(
      "SELECT media_json AS json FROM media WHERE merchant_id = ? AND media_id = ?",
    )
    .get<Readonly<{ json: string }>>(merchantId, mediaId);
  return row === undefined ? undefined : parseMediaRecord(JSON.parse(row.json));
}

/** How many media records still name these bytes; the last one out deletes them. */
export function mediaUsingBytes(
  database: CommerceDatabase,
  merchantId: string,
  sha256: string,
): number {
  return (
    database
      .prepare(
        "SELECT count(*) AS count FROM media WHERE merchant_id = ? AND sha256 = ?",
      )
      .get<Readonly<{ count: number }>>(merchantId, sha256)?.count ?? 0
  );
}

function readProductMedia(
  database: CommerceDatabase,
  merchantId: string,
  productId: string,
): CommerceProductMediaV1 | undefined {
  const row = database
    .prepare(
      "SELECT media_json AS json FROM product_media WHERE merchant_id = ? AND product_id = ?",
    )
    .get<Readonly<{ json: string }>>(merchantId, productId);
  return row === undefined
    ? undefined
    : parseProductMedia(JSON.parse(row.json));
}

function productsShowing(
  database: CommerceDatabase,
  merchantId: string,
  mediaId: string,
) {
  return (
    database
      .prepare(
        "SELECT count(*) AS count FROM product_media_item WHERE merchant_id = ? AND media_id = ?",
      )
      .get<Readonly<{ count: number }>>(merchantId, mediaId)?.count ?? 0
  );
}

function writeMedia(
  database: CommerceDatabase,
  merchantId: string,
  media: CommerceMediaV1,
  previousRevision: number | undefined,
): void {
  if (previousRevision === undefined) {
    database
      .prepare(
        `INSERT INTO media (merchant_id, media_id, revision, sha256, media_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        media.id,
        media.revision,
        media.sha256,
        JSON.stringify(media),
        media.occurredAt,
      );
    return;
  }
  const written = database
    .prepare(
      `UPDATE media SET revision = ?, media_json = ?, occurred_at = ?
       WHERE merchant_id = ? AND media_id = ? AND revision = ?`,
    )
    .run(
      media.revision,
      JSON.stringify(media),
      media.occurredAt,
      merchantId,
      media.id,
      previousRevision,
    );
  if (written.changes !== 1)
    throw new Error(`Media ${media.id} moved during the write`);
}

function writeProductMedia(
  database: CommerceDatabase,
  merchantId: string,
  list: CommerceProductMediaV1,
  previousRevision: number | undefined,
  occurredAt: string,
): void {
  const json = JSON.stringify(list);
  if (previousRevision === undefined) {
    database
      .prepare(
        `INSERT INTO product_media (merchant_id, product_id, revision, media_json, occurred_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(merchantId, list.productId, list.revision, json, occurredAt);
  } else {
    const written = database
      .prepare(
        `UPDATE product_media SET revision = ?, media_json = ?, occurred_at = ?
         WHERE merchant_id = ? AND product_id = ? AND revision = ?`,
      )
      .run(
        list.revision,
        json,
        occurredAt,
        merchantId,
        list.productId,
        previousRevision,
      );
    if (written.changes !== 1)
      throw new Error(`Product media ${list.productId} moved during the write`);
  }
  database
    .prepare(
      "DELETE FROM product_media_item WHERE merchant_id = ? AND product_id = ?",
    )
    .run(merchantId, list.productId);
  list.media.forEach((item, position) =>
    database
      .prepare(
        `INSERT INTO product_media_item (merchant_id, product_id, media_id, position)
         VALUES (?, ?, ?, ?)`,
      )
      .run(merchantId, list.productId, item.mediaId, position),
  );
}

function staleMedia(
  current: CommerceMediaV1 | undefined,
  mediaId: string,
  expected: number,
): CommerceMutationErrorV1 | undefined {
  if (current === undefined) return notFound(mediaId);
  return current.revision === expected
    ? undefined
    : {
        code: "stale_resource_revision",
        kind: "media",
        id: mediaId,
        expected,
        actual: current.revision,
      };
}

function notFound(mediaId: string): CommerceMutationErrorV1 {
  return { code: "resource_not_found", kind: "media", id: mediaId };
}

/** Removes the media list of a deleted product. The images stay in the library. */
export function removeProductMedia(
  database: CommerceDatabase,
  merchantId: string,
  productId: string,
): void {
  database
    .prepare(
      "DELETE FROM product_media_item WHERE merchant_id = ? AND product_id = ?",
    )
    .run(merchantId, productId);
  database
    .prepare(
      "DELETE FROM product_media WHERE merchant_id = ? AND product_id = ?",
    )
    .run(merchantId, productId);
}
