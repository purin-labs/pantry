import {
  convertPrice,
  parseCreateMarketCommand,
  parseMarket,
  parseUpdateMarketCommand,
  type CommerceMarketCommandV1,
  type CommerceMarketV1,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
} from "@seams/commerce-client";

import { listVariants } from "../../commerce-persistence.ts";
import { readStorefront } from "../../checkout-persistence.ts";
import type { CommerceDatabase } from "../../database.ts";

export type MarketMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

export type MarketCommitRequest = Readonly<{
  command: CommerceMarketCommandV1;
  merchant: MarketMerchantRow;
  market: CommerceMarketV1;
  previousRevision: number | undefined;
}>;

export type MarketAuthorityOptions = Readonly<{
  database: CommerceDatabase;
  readMerchant: (merchantId: string) => MarketMerchantRow | undefined;
  readReplay: (
    merchantId: string,
    idempotencyKey: string,
    command: CommerceMarketCommandV1,
  ) => CommerceMutationResultV1 | undefined;
  validateMerchant: (
    merchantId: string,
    merchant: MarketMerchantRow | undefined,
  ) => CommerceMutationErrorV1 | undefined;
  rejected: (error: CommerceMutationErrorV1) => CommerceMutationResultV1;
  invalidCommand: (error: unknown) => CommerceMutationErrorV1;
  commit: (request: MarketCommitRequest) => CommerceMutationResultV1;
}>;

export class MarketAuthority {
  readonly #options: MarketAuthorityOptions;

  constructor(options: MarketAuthorityOptions) {
    this.#options = options;
  }

  createMarket(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseCreateMarketCommand, (command) => {
      if (readMarket(this.#options.database, command.merchantId, command.marketId))
        return { code: "resource_already_exists", kind: "market", id: command.marketId };
      const market: CommerceMarketV1 = {
        id: command.marketId,
        revision: 1,
        name: command.name,
        countries: command.countries,
        currency: command.currency,
        storefrontIds: command.storefrontIds,
        pricing: command.pricing,
        status: "active",
        occurredAt: command.requestedAt,
      };
      return this.#checked(command.merchantId, market, undefined);
    });
  }

  updateMarket(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseUpdateMarketCommand, (command) => {
      const current = readMarket(this.#options.database, command.merchantId, command.marketId);
      if (current === undefined)
        return { code: "resource_not_found", kind: "market", id: command.marketId };
      if (current.revision !== command.expectedRevision)
        return {
          code: "stale_resource_revision",
          kind: "market",
          id: current.id,
          expected: command.expectedRevision,
          actual: current.revision,
        };
      return this.#checked(
        command.merchantId,
        {
          ...current,
          ...command.changes,
          revision: current.revision + 1,
          occurredAt: command.requestedAt,
        },
        current.revision,
      );
    });
  }

  listMarkets(merchantId: string): readonly CommerceMarketV1[] {
    return this.#options.database
      .prepare(
        "SELECT market_json AS json FROM market WHERE merchant_id = ? ORDER BY market_id",
      )
      .all<Readonly<{ json: string }>>(merchantId)
      .map((row) => parseMarket(JSON.parse(row.json)));
  }

  // The storefronts must exist, and a price list may name only known
  // variants.
  #checked(
    merchantId: string,
    market: CommerceMarketV1,
    previousRevision: number | undefined,
  ): Omit<MarketCommitRequest, "command" | "merchant"> | CommerceMutationErrorV1 {
    const { database } = this.#options;
    for (const storefrontId of market.storefrontIds)
      if (readStorefront(database, merchantId, storefrontId) === undefined)
        return { code: "resource_not_found", kind: "storefront", id: storefrontId };
    if (market.pricing.kind === "price_list") {
      const known = new Set(listVariants(database, merchantId).map((variant) => variant.id));
      const unknown = market.pricing.prices.find((price) => !known.has(price.variantId));
      if (unknown !== undefined)
        return { code: "resource_not_found", kind: "sellable_variant", id: unknown.variantId };
    }
    return { market, previousRevision };
  }

  #run<TCommand extends CommerceMarketCommandV1>(
    rawCommand: unknown,
    parse: (value: unknown) => TCommand,
    plan: (
      command: TCommand,
    ) => Omit<MarketCommitRequest, "command" | "merchant"> | CommerceMutationErrorV1,
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
}

export function writeMarket(
  database: CommerceDatabase,
  merchantId: string,
  market: CommerceMarketV1,
  previousRevision: number | undefined,
): void {
  if (previousRevision === undefined) {
    database
      .prepare(
        `INSERT INTO market (
           merchant_id, market_id, revision, currency, status, market_json, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        market.id,
        market.revision,
        market.currency,
        market.status,
        JSON.stringify(market),
        market.occurredAt,
      );
    return;
  }
  const written = database
    .prepare(
      `UPDATE market SET revision = ?, currency = ?, status = ?, market_json = ?,
         occurred_at = ?
       WHERE merchant_id = ? AND market_id = ? AND revision = ?`,
    )
    .run(
      market.revision,
      market.currency,
      market.status,
      JSON.stringify(market),
      market.occurredAt,
      merchantId,
      market.id,
      previousRevision,
    );
  if (written.changes !== 1) throw new Error(`Market ${market.id} moved during the write`);
}

export function readMarket(
  database: CommerceDatabase,
  merchantId: string,
  marketId: string,
): CommerceMarketV1 | undefined {
  const row = database
    .prepare("SELECT market_json AS json FROM market WHERE merchant_id = ? AND market_id = ?")
    .get<Readonly<{ json: string }>>(merchantId, marketId);
  return row === undefined ? undefined : parseMarket(JSON.parse(row.json));
}

/** A variant's unit price in a market, or undefined when it has none. */
export function marketUnitPrice(
  market: CommerceMarketV1,
  variantId: string,
  shopPrice: Readonly<{ amountMinor: number; currency: string }>,
): Readonly<{ amountMinor: number; currency: string }> | undefined {
  if (market.pricing.kind === "price_list") {
    const price = market.pricing.prices.find((item) => item.variantId === variantId);
    return price === undefined
      ? undefined
      : { amountMinor: price.amountMinor, currency: market.currency };
  }
  return {
    amountMinor: convertPrice(
      shopPrice.amountMinor,
      shopPrice.currency,
      market.currency,
      market.pricing.rate.value,
      market.pricing.roundingIncrement,
    ),
    currency: market.currency,
  };
}

/** Whether a market's price list names this variant. */
export function marketCitesVariant(
  database: CommerceDatabase,
  merchantId: string,
  variantId: string,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 FROM market
         WHERE merchant_id = ? AND instr(market_json, ?) > 0 LIMIT 1`,
      )
      .get(merchantId, variantId) !== undefined
  );
}
