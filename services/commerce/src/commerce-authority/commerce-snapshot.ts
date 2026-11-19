import {
  parseFoodServiceSnapshot,
  parseMerchantSnapshot,
  type CommerceFoodServiceResourcesV1,
  type CommerceFoodServiceSnapshotV1,
  type CommerceMerchantSnapshotV1,
  type CommercePreparationTicketV1,
} from "@purin-labs/commerce-client";
import type { CommerceDatabase } from "../database.ts";
import { requireIdentity } from "./command-guards.ts";
import type { CommerceSigner } from "./contracts.ts";
import {
  listFulfillments,
  listLocations,
  listOffers,
  listOrders,
  listPayments,
  listProducts,
  listSalesChannels,
  listShipments,
  listVariants,
} from "../commerce-persistence.ts";
import {
  listInventoryItems,
  listInventoryPositions,
} from "../inventory-persistence.ts";
import {
  readFailedPayments,
  readPayments,
  type FailedPaymentsWindow,
} from "../payments/failed-payments.ts";
import type {
  CommerceFailedPaymentsV1,
  CommercePaymentsV1,
} from "@purin-labs/commerce-client";
import { readOrderTimes, type OrderTimesWindow } from "./order-times.ts";
import type { CommerceOrderTimesV1 } from "@purin-labs/commerce-client";
import {
  readPickupQueue,
  readSoldOutMarks,
  readPreparationTicket,
  readFoodServiceResources,
} from "../plugins/food-service/index.ts";
import type { CommerceSoldOutMarksV1 } from "@purin-labs/commerce-client";
import type { CommercePickupQueueV1 } from "@purin-labs/commerce-client";

type SnapshotMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

type CommerceSnapshotReaderOptions = Readonly<{
  database: CommerceDatabase;
  signer: Pick<CommerceSigner, "keyId" | "publicKeyB64">;
  readMerchant: (merchantId: string) => SnapshotMerchantRow | undefined;
}>;

export class CommerceSnapshotReader {
  readonly #options: CommerceSnapshotReaderOptions;

  constructor(options: CommerceSnapshotReaderOptions) {
    this.#options = options;
  }

  readSnapshot(merchantId: string): CommerceMerchantSnapshotV1 | undefined {
    const merchant = this.#options.readMerchant(
      requireIdentity(merchantId, "merchantId"),
    );
    if (merchant === undefined) return undefined;
    return parseMerchantSnapshot({
      schemaVersion: "underclerk.commerce-snapshot.v2",
      merchantId: merchant.merchantId,
      merchantRevision: merchant.revision,
      deliverySigner: {
        keyId: this.#options.signer.keyId,
        algorithm: "ed25519",
        publicKeyB64: this.#options.signer.publicKeyB64,
      },
      resources: {
        locations: listLocations(this.#options.database, merchant.merchantId),
        salesChannels: listSalesChannels(
          this.#options.database,
          merchant.merchantId,
        ),
        products: listProducts(this.#options.database, merchant.merchantId),
        variants: listVariants(this.#options.database, merchant.merchantId),
        inventoryItems: listInventoryItems(
          this.#options.database,
          merchant.merchantId,
        ),
        offers: listOffers(this.#options.database, merchant.merchantId),
        inventoryPositions: listInventoryPositions(
          this.#options.database,
          merchant.merchantId,
        ),
        orders: listOrders(this.#options.database, merchant.merchantId),
        payments: listPayments(this.#options.database, merchant.merchantId),
        fulfillments: listFulfillments(
          this.#options.database,
          merchant.merchantId,
        ),
        shipments: listShipments(this.#options.database, merchant.merchantId),
      },
    });
  }

  readFoodServiceSnapshot(
    merchantId: string,
  ): CommerceFoodServiceSnapshotV1 | undefined {
    const merchant = this.#options.readMerchant(
      requireIdentity(merchantId, "merchantId"),
    );
    if (merchant === undefined) return undefined;
    return parseFoodServiceSnapshot({
      schemaVersion: "underclerk.food-service-snapshot.v2",
      merchantId: merchant.merchantId,
      merchantRevision: merchant.revision,
      deliverySigner: {
        keyId: this.#options.signer.keyId,
        algorithm: "ed25519",
        publicKeyB64: this.#options.signer.publicKeyB64,
      },
      resources: this.readFoodServiceResources(merchant.merchantId),
    });
  }

  readSoldOutMarks(
    merchantId: string,
    now: string,
  ): CommerceSoldOutMarksV1 | undefined {
    const merchant = this.#options.readMerchant(
      requireIdentity(merchantId, "merchantId"),
    );
    if (merchant === undefined) return undefined;
    return readSoldOutMarks(
      this.#options.database,
      merchant.merchantId,
      merchant.revision,
      now,
    );
  }

  readOrderTimes(
    merchantId: string,
    window: OrderTimesWindow,
  ): CommerceOrderTimesV1 | undefined {
    const merchant = this.#options.readMerchant(
      requireIdentity(merchantId, "merchantId"),
    );
    if (merchant === undefined) return undefined;
    return readOrderTimes(
      this.#options.database,
      merchant.merchantId,
      merchant.revision,
      window,
    );
  }

  readFailedPayments(
    merchantId: string,
    window: FailedPaymentsWindow,
  ): CommerceFailedPaymentsV1 | undefined {
    const merchant = this.#options.readMerchant(
      requireIdentity(merchantId, "merchantId"),
    );
    if (merchant === undefined) return undefined;
    return readFailedPayments(
      this.#options.database,
      merchant.merchantId,
      merchant.revision,
      window,
    );
  }

  readPayments(
    merchantId: string,
    window: FailedPaymentsWindow,
  ): CommercePaymentsV1 | undefined {
    const merchant = this.#options.readMerchant(
      requireIdentity(merchantId, "merchantId"),
    );
    if (merchant === undefined) return undefined;
    return readPayments(
      this.#options.database,
      merchant.merchantId,
      merchant.revision,
      window,
    );
  }

  readPickupQueue(merchantId: string): CommercePickupQueueV1 | undefined {
    const merchant = this.#options.readMerchant(
      requireIdentity(merchantId, "merchantId"),
    );
    if (merchant === undefined) return undefined;
    return readPickupQueue(
      this.#options.database,
      merchant.merchantId,
      merchant.revision,
    );
  }

  readPreparationTicket(
    merchantId: string,
    ticketId: string,
  ): CommercePreparationTicketV1 | undefined {
    return readPreparationTicket(
      this.#options.database,
      requireIdentity(merchantId, "merchantId"),
      requireIdentity(ticketId, "ticketId"),
    );
  }

  readFoodServiceResources(merchantId: string): CommerceFoodServiceResourcesV1 {
    return readFoodServiceResources(
      this.#options.database,
      requireIdentity(merchantId, "merchantId"),
    );
  }
}
