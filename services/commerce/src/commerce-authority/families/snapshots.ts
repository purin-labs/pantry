import {
  parseAcknowledgeDeliveryCommand,
  type AcknowledgeCommerceDeliveryV1,
  type CommerceDeliveryV1,
  type CommerceFoodServiceSnapshotV1,
  type CommercePreparationTicketV1,
  type CommerceDeliveryAcknowledgementV1,
  type CommerceMerchantSnapshotV1,
  type CommerceMigrationInventoryV2,
  type CommerceMerchantProvisioningResultV1,
  type CommerceSoldOutMarksV1,
  type CommerceFailedPaymentsV1,
  type CommercePaymentsV1,
  type CommerceOrderTimesV1,
  type CommercePickupQueueV1,
  type CommerceCounterCashTenderV1,
} from "@purin-labs/commerce-client";
import type { Checkout, CheckoutPaymentAttempt } from "@purin-labs/commerce-contracts";
import type { FailedPaymentsWindow } from "../../payments/failed-payments.ts";
import { readManualTender } from "../../payments/manual-tender.ts";
import {
  readCheckout,
  readCheckoutPaymentAttemptForCheckout,
} from "../../checkout-persistence.ts";
import {
  readProductSales,
  type ProductSalesWindow,
  type ProductSalesReport,
} from "../product-sales.ts";
import {
  ArchiveAuthority,
  type ArchiveOptions,
  type ArchiveStore,
} from "../../archive.ts";
import { requireIdentity } from "../command-guards.ts";
import {
  type DeliveryOutboxTable,
  type DeliveryStatusRow,
  type StoredDeliveryRow,
  deliveryAcknowledgement,
  deliverySettlement,
  parseStoredDelivery,
} from "../deliveries.ts";
import { CommerceAuthorityBase } from "./base.ts";

/**
 * Reads of the merchant's records, deliveries, provisioning and the archive.
 */
export abstract class CommerceSnapshotFamily extends CommerceAuthorityBase {
  provisionMerchant(
    rawCommand: unknown,
  ): CommerceMerchantProvisioningResultV1 {
    return this.provisioning.provisionMerchant(rawCommand);
  }

  provisionDemo(rawCommand: unknown): CommerceMerchantSnapshotV1 {
    return this.provisioning.provisionDemo(rawCommand);
  }

  acknowledgeDelivery(
    rawCommand: unknown,
  ): CommerceDeliveryAcknowledgementV1 {
    const command: AcknowledgeCommerceDeliveryV1 =
      parseAcknowledgeDeliveryCommand(rawCommand);
    return this.acknowledgeStoredDelivery(command, "observation_outbox");
  }

  protected acknowledgeStoredDelivery(
    command: AcknowledgeCommerceDeliveryV1,
    table: DeliveryOutboxTable,
  ): CommerceDeliveryAcknowledgementV1 {
    const row = this.readDeliveryStatus(command, table);
    if (row === undefined) throw new Error("Delivery not found");
    const settled = deliverySettlement(command, row);
    if (settled !== undefined) return settled;
    if (row.status !== "pending") throw new Error("Delivery status is invalid");
    const updated =
      command.rejection === undefined
        ? this.database
            .prepare(
              `UPDATE ${table}
           SET status = 'delivered', delivered_at = ?
           WHERE merchant_id = ? AND delivery_id = ? AND status = 'pending'`,
            )
            .run(command.acknowledgedAt, command.merchantId, command.deliveryId)
        : this.database
            .prepare(
              `UPDATE ${table}
           SET status = 'rejected', rejected_at = ?, rejected_reason = ?
           WHERE merchant_id = ? AND delivery_id = ? AND status = 'pending'`,
            )
            .run(
              command.acknowledgedAt,
              command.rejection.reason,
              command.merchantId,
              command.deliveryId,
            );
    if (updated.changes === 0) {
      const replay = this.readDeliveryStatus(command, table);
      const replaySettled =
        replay === undefined ? undefined : deliverySettlement(command, replay);
      if (replaySettled === undefined) {
        throw new Error("Delivery acknowledgement was not committed");
      }
      return replaySettled;
    }
    return deliveryAcknowledgement(
      command,
      command.rejection === undefined ? "acknowledged" : "rejected",
      command.acknowledgedAt,
    );
  }

  protected readDeliveryStatus(
    command: AcknowledgeCommerceDeliveryV1,
    table: DeliveryOutboxTable,
  ): DeliveryStatusRow | undefined {
    return this.database
      .prepare(
        `SELECT merchant.external_reference AS organisationId, delivery.status,
              delivery.delivered_at AS deliveredAt,
              delivery.rejected_at AS rejectedAt
       FROM ${table} AS delivery
       JOIN merchant ON merchant.merchant_id = delivery.merchant_id
       WHERE delivery.merchant_id = ? AND delivery.delivery_id = ?`,
      )
      .get<DeliveryStatusRow>(command.merchantId, command.deliveryId);
  }

  /** The event feed across the archive and the live outbox. */
  readEvents(
    merchantId: string,
    after: string | undefined,
    limit: number,
    store: ArchiveStore | undefined,
  ): ReturnType<ArchiveAuthority["readEvents"]> {
    return this.archive.readEvents(merchantId, after, limit, store);
  }

  readOrderRecord(
    merchantId: string,
    orderId: string,
    store: ArchiveStore | undefined,
  ): ReturnType<ArchiveAuthority["readOrderRecord"]> {
    return this.archive.readOrderRecord(merchantId, orderId, store);
  }

  /** Moves finished orders and old events to the archive store. */
  runArchive(
    merchantId: string,
    store: ArchiveStore,
    options?: ArchiveOptions,
  ): ReturnType<ArchiveAuthority["run"]> {
    return this.archive.run(merchantId, store, options);
  }

  readMigrationInventory(
    merchantId: string,
  ): CommerceMigrationInventoryV2 | undefined {
    return this.inventoryCommands.readMigrationInventory(merchantId);
  }

  /**
   * One counter sale, as the operator who rang it up.
   *
   * A counter sale has no storefront and no buyer session, so the buyer-facing
   * order read cannot reach it. This is the only path by which the till can
   * show what it just sold — the receipt, and the payment's actual state when
   * that state is not yet settled.
   */
  readCounterSale(
    merchantId: string,
    checkoutId: string,
  ):
    | Readonly<{
        checkout: Checkout;
        paymentAttempt: CheckoutPaymentAttempt | null;
        manualTender?: CommerceCounterCashTenderV1;
      }>
    | undefined {
    const checkout = readCheckout(this.database, merchantId, checkoutId);
    if (checkout === undefined || checkout.source.kind !== "point_of_sale")
      return undefined;
    const rawManual =
      checkout.lifecycle.state === "accepted" &&
      checkout.lifecycle.manualPaymentId !== undefined
        ? readManualTender(
            this.database,
            merchantId,
            checkout.lifecycle.manualPaymentId,
          )
        : undefined;
    const manualTender: CommerceCounterCashTenderV1 | undefined =
      rawManual !== undefined &&
      rawManual.method === "cash" &&
      rawManual.cashReceivedMinor !== undefined &&
      rawManual.changeDueMinor !== undefined
        ? {
            method: "cash",
            cashReceivedMinor: rawManual.cashReceivedMinor,
            changeDueMinor: rawManual.changeDueMinor,
            recordedAt: rawManual.recordedAt,
          }
        : undefined;
    return {
      checkout,
      paymentAttempt:
        readCheckoutPaymentAttemptForCheckout(
          this.database,
          merchantId,
          checkoutId,
        ) ?? null,
      ...(manualTender === undefined ? {} : { manualTender }),
    };
  }

  readSnapshot(merchantId: string): CommerceMerchantSnapshotV1 | undefined {
    return this.commerceSnapshots.readSnapshot(merchantId);
  }

  readProductSales(
    merchantId: string,
    window: ProductSalesWindow,
  ): ProductSalesReport | undefined {
    return readProductSales(this.database, merchantId, window);
  }

  readOrderTimes(
    merchantId: string,
    window: FailedPaymentsWindow,
  ): CommerceOrderTimesV1 | undefined {
    return this.commerceSnapshots.readOrderTimes(merchantId, window);
  }

  readFailedPayments(
    merchantId: string,
    window: FailedPaymentsWindow,
  ): CommerceFailedPaymentsV1 | undefined {
    return this.commerceSnapshots.readFailedPayments(merchantId, window);
  }

  readPayments(
    merchantId: string,
    window: FailedPaymentsWindow,
  ): CommercePaymentsV1 | undefined {
    return this.commerceSnapshots.readPayments(merchantId, window);
  }

  readFoodServiceSnapshot(
    merchantId: string,
  ): CommerceFoodServiceSnapshotV1 | undefined {
    return this.commerceSnapshots.readFoodServiceSnapshot(merchantId);
  }

  readPreparationTicket(
    merchantId: string,
    ticketId: string,
  ): CommercePreparationTicketV1 | undefined {
    return this.commerceSnapshots.readPreparationTicket(merchantId, ticketId);
  }

  readSoldOutMarks(merchantId: string): CommerceSoldOutMarksV1 | undefined {
    return this.commerceSnapshots.readSoldOutMarks(merchantId, this.now());
  }

  readPickupQueue(merchantId: string): CommercePickupQueueV1 | undefined {
    return this.commerceSnapshots.readPickupQueue(merchantId);
  }

  pendingDeliveries(
    merchantId: string,
  ): readonly CommerceDeliveryV1[] {
    const normalized = requireIdentity(merchantId, "merchantId");
    const rows = this.database
      .prepare(
        `SELECT delivery_json AS deliveryJson
         FROM observation_outbox
         WHERE merchant_id = ? AND status = 'pending'
         ORDER BY merchant_revision, delivery_id`,
      )
      .all<StoredDeliveryRow>(normalized);
    return rows.map(parseStoredDelivery);
  }
}
