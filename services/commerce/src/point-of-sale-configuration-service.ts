import { parsePointOfSaleConfiguration } from "@purin-labs/commerce-client";
import type { PointOfSaleConfiguration } from "@purin-labs/commerce-contracts";

import type { CommerceDatabase } from "./database.ts";
import {
  publishPointOfSaleConfiguration,
  readPublishedPointOfSaleConfiguration,
} from "./point-of-sale-configuration-persistence.ts";

/**
 * Publication of the policy a counter sells under.
 *
 * A counter's policy is published, not drafted and staged: there is one
 * authority per Pantry location and it is either in force or it is not. The
 * revision ladder is what makes republishing safe — a sale pins the revision it
 * was rung up under, so changing the counter's prices or tax cannot move a sale
 * that has already been accepted.
 */
export type PointOfSaleConfigurationError =
  | Readonly<{ code: "invalid_configuration"; field: string }>
  | Readonly<{ code: "merchant_not_found"; merchantId: string }>
  | Readonly<{
      code: "revision_conflict";
      expectedRevision: number | null;
      actualRevision: number | null;
    }>;

export type PointOfSaleConfigurationResult<TValue> =
  | Readonly<{ ok: true; value: TValue }>
  | Readonly<{ ok: false; error: PointOfSaleConfigurationError }>;

export type PublishPointOfSaleConfiguration = Readonly<{
  merchantId: string;
  /**
   * The revision the caller believes is published, or null when publishing a
   * counter's first policy. A caller that has not seen the current revision
   * cannot replace it.
   */
  expectedRevision: number | null;
  publishedAt: string;
  publishedBy: string;
  /** Everything except revision and lifecycle, which this service assigns. */
  configuration: Readonly<Record<string, unknown>>;
}>;

export class PointOfSaleConfigurationService {
  readonly #database: CommerceDatabase;

  constructor(database: CommerceDatabase) {
    this.#database = database;
  }

  publish(
    input: PublishPointOfSaleConfiguration,
  ): PointOfSaleConfigurationResult<PointOfSaleConfiguration> {
    return this.#database.transaction(
      publishTransaction.bind(undefined, this.#database, input),
    );
  }

  readPublished(
    merchantId: string,
    pantryLocationId: string,
  ): PointOfSaleConfiguration | undefined {
    return readPublishedPointOfSaleConfiguration(
      this.#database,
      merchantId,
      pantryLocationId,
    );
  }

  /** Every counter this merchant currently sells through. */
  listPublished(merchantId: string): readonly PointOfSaleConfiguration[] {
    const rows = this.#database
      .prepare(
        `SELECT configuration_json AS configurationJson
       FROM point_of_sale_configuration
       WHERE merchant_id = ? AND lifecycle_state = 'published'
       ORDER BY satyr_location_id ASC`,
      )
      .all<Readonly<{ configurationJson: string }>>(merchantId);
    return rows.map((row) =>
      parsePointOfSaleConfiguration(JSON.parse(row.configurationJson)),
    );
  }
}

function publishTransaction(
  database: CommerceDatabase,
  input: PublishPointOfSaleConfiguration,
): PointOfSaleConfigurationResult<PointOfSaleConfiguration> {
  const merchant = database
    .prepare(
      "SELECT merchant_id AS merchantId FROM merchant WHERE merchant_id = ?",
    )
    .get<Readonly<{ merchantId: string }>>(input.merchantId);
  if (merchant === undefined) {
    return {
      ok: false,
      error: { code: "merchant_not_found", merchantId: input.merchantId },
    };
  }
  const pantryLocationId = input.configuration.satyrLocationId;
  if (typeof pantryLocationId !== "string" || pantryLocationId.length === 0) {
    return {
      ok: false,
      error: {
        code: "invalid_configuration",
        field: "pointOfSaleConfiguration.satyrLocationId",
      },
    };
  }
  const current = readPublishedPointOfSaleConfiguration(
    database,
    input.merchantId,
    pantryLocationId,
  );
  const actualRevision = current?.revision ?? null;
  if (actualRevision !== input.expectedRevision) {
    return {
      ok: false,
      error: {
        code: "revision_conflict",
        expectedRevision: input.expectedRevision,
        actualRevision,
      },
    };
  }

  // Revision and lifecycle are assigned here, never accepted from the caller: a
  // caller that could name its own revision could publish underneath a sale
  // that had already pinned one.
  let configuration: PointOfSaleConfiguration;
  try {
    configuration = parsePointOfSaleConfiguration({
      ...input.configuration,
      merchantId: input.merchantId,
      revision: (actualRevision ?? 0) + 1,
      lifecycle: {
        state: "published",
        publishedAt: input.publishedAt,
        publishedBy: input.publishedBy,
      },
    });
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "invalid_configuration",
        field:
          cause instanceof Error ? cause.message : "pointOfSaleConfiguration",
      },
    };
  }
  publishPointOfSaleConfiguration(
    database,
    input.merchantId,
    configuration,
    input.publishedAt,
  );
  return { ok: true, value: configuration };
}
