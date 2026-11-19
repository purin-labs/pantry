import {
  parseRecordOrderManualPaymentCommand,
  type CommerceMutationResultV1,
  type CommerceTenderRefundV1,
  type CommerceReturnV1,
  type CommerceOrderChangesV1,
  type CommerceCompanyInvoiceV1,
  type CommerceDraftOrderViewV1,
  type CommerceDraftOrderV1,
} from "@seams/commerce-client";
import { rejected } from "../ledger.ts";
import { beginSnapshotCommand } from "../merchant-command.ts";
import { FulfillmentCommandAuthority } from "../fulfillment-commands.ts";
import {
  DraftOrderCommandAuthority,
  type DraftInvoiceCheckout,
} from "../../plugins/draft-orders/index.ts";
import {
  OrderEditCommandAuthority,
  type OrderBalanceCheckoutResult,
} from "../order-edits.ts";
import {
  orderManualPaymentMutation,
  planOrderManualPayment,
} from "../../payments/order-manual-payment.ts";
import { InventoryFamily } from "./inventory.ts";

/**
 * Order commands after placement: returns, edits, draft orders, invoices, fulfillment, cancellations and refunds.
 */
export abstract class OrderFamily extends InventoryFamily {
  requestReturn(
    rawCommand: unknown,
    requestedBy: CommerceReturnV1["requestedBy"] = "staff",
  ): CommerceMutationResultV1 {
    return this.returns.requestReturn(rawCommand, requestedBy);
  }

  authorizeReturn(rawCommand: unknown): CommerceMutationResultV1 {
    return this.returns.authorizeReturn(rawCommand);
  }

  receiveReturn(rawCommand: unknown): CommerceMutationResultV1 {
    return this.returns.receiveReturn(rawCommand);
  }

  closeReturn(rawCommand: unknown): CommerceMutationResultV1 {
    return this.returns.closeReturn(rawCommand);
  }

  listOrderReturns(
    merchantId: string,
    orderId: string,
  ): readonly CommerceReturnV1[] {
    return this.returns.listOrderReturns(merchantId, orderId);
  }

  editOrder(rawCommand: unknown): CommerceMutationResultV1 {
    return this.orderEdits.editOrder(rawCommand);
  }

  exchangeOrderLines(rawCommand: unknown): CommerceMutationResultV1 {
    return this.orderEdits.exchangeOrderLines(rawCommand);
  }

  readOrderChanges(
    merchantId: string,
    orderId: string,
  ): CommerceOrderChangesV1 | undefined {
    return this.orderEdits.readOrderChanges(merchantId, orderId);
  }

  openOrderBalance(
    input: Parameters<OrderEditCommandAuthority["openOrderBalance"]>[0],
  ): OrderBalanceCheckoutResult {
    return this.orderEdits.openOrderBalance(input);
  }

  createDraftOrder(rawCommand: unknown): CommerceMutationResultV1 {
    return this.draftOrders.createDraftOrder(rawCommand);
  }

  updateDraftOrder(rawCommand: unknown): CommerceMutationResultV1 {
    return this.draftOrders.updateDraftOrder(rawCommand);
  }

  sendDraftInvoice(rawCommand: unknown): CommerceMutationResultV1 {
    return this.draftOrders.sendDraftInvoice(rawCommand);
  }

  cancelDraftOrder(rawCommand: unknown): CommerceMutationResultV1 {
    return this.draftOrders.cancelDraftOrder(rawCommand);
  }

  markDraftOrderPaid(rawCommand: unknown): CommerceMutationResultV1 {
    return this.draftOrders.markDraftOrderPaid(rawCommand);
  }

  placeDraftOrderOnTerms(rawCommand: unknown): CommerceMutationResultV1 {
    return this.draftOrders.placeDraftOrderOnTerms(rawCommand);
  }

  recordInvoicePayment(rawCommand: unknown): CommerceMutationResultV1 {
    return this.invoices.recordInvoicePayment(rawCommand);
  }

  listInvoices(merchantId: string): readonly CommerceCompanyInvoiceV1[] {
    return this.invoices.listInvoices(merchantId);
  }

  /** Marks due open invoices overdue; returns when the next one is due. */
  markOverdueInvoices(): string | null {
    return this.invoices.markOverdueInvoices();
  }

  /** Records what an order still owes as paid in cash or by bank transfer. */
  recordOrderManualPayment(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(
      {
        ...this.ledger.commandPorts,
        readSnapshot: (merchantId) => this.readSnapshot(merchantId),
      },
      rawCommand,
      parseRecordOrderManualPaymentCommand,
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot } = start;
    const plan = planOrderManualPayment(
      this.database,
      command,
      snapshot.resources,
    );
    if ("code" in plan) return rejected(plan);
    return this.ledger.commit(
      orderManualPaymentMutation(command, merchant, plan, this.now()),
    );
  }

  readDraftOrderView(
    merchantId: string,
    draftOrderId: string,
  ): CommerceDraftOrderViewV1 | undefined {
    return this.draftOrders.readDraftOrderView(merchantId, draftOrderId);
  }

  readInvoicedDraft(
    merchantId: string,
    storefrontId: string,
    draftOrderId: string,
    draftRevision: number,
  ): CommerceDraftOrderV1 | undefined {
    return this.draftOrders.readInvoicedDraft(
      merchantId,
      storefrontId,
      draftOrderId,
      draftRevision,
    );
  }

  openDraftInvoice(
    input: Parameters<DraftOrderCommandAuthority["openDraftInvoice"]>[0],
  ): DraftInvoiceCheckout {
    return this.draftOrders.openDraftInvoice(input);
  }

  quoteShipmentLabelRate(
    rawCommand: unknown,
  ): ReturnType<FulfillmentCommandAuthority["quoteShipmentLabelRate"]> {
    return this.fulfillmentCommands.quoteShipmentLabelRate(rawCommand);
  }

  purchaseShippingLabel(rawCommand: unknown): CommerceMutationResultV1 {
    return this.fulfillmentCommands.purchaseShippingLabel(rawCommand);
  }

  recordShippingTracking(rawCommand: unknown): CommerceMutationResultV1 {
    return this.fulfillmentCommands.recordShippingTracking(rawCommand);
  }

  attachFulfillmentTracking(rawCommand: unknown): CommerceMutationResultV1 {
    return this.fulfillmentCommands.attachFulfillmentTracking(rawCommand);
  }

  markPickupReady(rawCommand: unknown): CommerceMutationResultV1 {
    return this.fulfillmentCommands.markPickupReady(rawCommand);
  }

  completePickup(rawCommand: unknown): CommerceMutationResultV1 {
    return this.fulfillmentCommands.completePickup(rawCommand);
  }

  async cancelOrder(rawCommand: unknown): Promise<CommerceMutationResultV1> {
    return this.afterSaleCommands.cancelOrder(rawCommand);
  }

  /** Reads due pending refunds again; returns when the next one is due. */
  reconcilePendingRefunds(): Promise<string | null> {
    return this.afterSaleCommands.reconcilePendingRefunds();
  }

  async refundOrder(rawCommand: unknown): Promise<CommerceMutationResultV1> {
    return this.afterSaleCommands.refundOrder(rawCommand);
  }

  recordCounterManualCashRefund(rawCommand: unknown): CommerceMutationResultV1 {
    return this.afterSaleCommands.recordCounterManualCashRefund(rawCommand);
  }

  async refundOrderTenders(
    rawCommand: unknown,
  ): Promise<CommerceTenderRefundV1> {
    return this.afterSaleCommands.refundOrderTenders(rawCommand);
  }
}
