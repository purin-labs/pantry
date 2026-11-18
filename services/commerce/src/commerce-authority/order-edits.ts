import {
  checkoutOnlineSource,
  parseCheckout,
  parseEditOrderCommand,
  parseExchangeOrderLinesCommand,
  parseFulfillment,
  parseInventoryAllocation,
  parseInventoryPosition,
  parseOrder,
  type EditCommerceOrderV1,
  type ExchangeCommerceOrderLinesV1,
  type CommerceBuyerQuotedCheckoutV1,
  type CommerceFoodServiceResourcesV1,
  type CommerceFulfillmentV1,
  type CommerceInventoryPositionV1,
  type CommerceMerchantSnapshotV1,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
  type CommerceOrderChangeLineV1,
  type CommerceOrderChangesV1,
  type CommerceOrderEditV1,
  type CommerceOrderExchangeV1,
  type CommerceOrderLineItemV1,
  type CommerceOrderV1,
  type CommercePickupFulfillmentV1,
  type CommerceReturnV1,
} from "@seams/commerce-client";
import {
  commerceTransition,
  type Cart,
  type Checkout,
  type InventoryAllocation,
  type InventoryAllocationOrderCommitPoint,
  type InventoryRequirement,
} from "@seams/commerce-contracts";

import { buyerSessionDigest } from "../buyer-session.ts";
import type { BuyerCheckoutProfileClaims } from "./buyer-checkout/types.ts";
import {
  readCheckout,
  readInventoryAllocation,
  readStorefront,
} from "../checkout-persistence.ts";
import type { CommerceDatabase } from "../database.ts";
import { readInventoryPositionForItemLocation } from "../inventory-persistence.ts";
import { allocateTaxAcrossLines } from "./checkout-payment-planning.ts";
import {
  buildCheckoutQuote,
  resolveCheckoutSelection,
  scaleCheckoutRequirement,
  storefrontPercentageTax,
  timestampAfterSeconds,
} from "./checkout-planning.ts";
import { findResource, orderLineIdFor, sha256 } from "./checkout-shared.ts";
import {
  accountedPositionCanRelease,
  isAccountedPosition,
  readUsableInventoryQuantity,
  releasedInventoryPosition,
  wholeAmountAtScale,
} from "./inventory-planning.ts";
import {
  listOrderChanges,
  orderMatchesAccepted,
  readAcceptedOrder,
} from "./order-changes.ts";
import { orderBalance } from "../payments/position.ts";
import { readReturn } from "../plugins/returns/index.ts";
import { guardMove, orderSubject } from "../plugins/machine-guards.ts";

type Money = Readonly<{ amountMinor: number; currency: string }>;

export type OrderEditMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

export type OrderEditCommitRequest = Readonly<{
  command: EditCommerceOrderV1;
  merchant: OrderEditMerchantRow;
  previousOrderRevision: number;
  order: CommerceOrderV1;
  fulfillment: CommerceFulfillmentV1;
  allocations: readonly InventoryAllocation[];
  positions: readonly CommerceInventoryPositionV1[];
  edit: CommerceOrderEditV1;
}>;

export type OrderExchangeCommitRequest = Readonly<{
  command: ExchangeCommerceOrderLinesV1;
  merchant: OrderEditMerchantRow;
  previousOrderRevision: number;
  order: CommerceOrderV1;
  /** The new fulfillment that hands over the exchange lines. */
  fulfillment: CommerceFulfillmentV1;
  allocations: readonly InventoryAllocation[];
  positions: readonly CommerceInventoryPositionV1[];
  exchange: CommerceOrderExchangeV1;
  /** The return, closed by this exchange. */
  returnRecord: CommerceReturnV1;
}>;

/** The record of a buyer opening a balance checkout. */
export type OpenCommerceOrderBalanceInternalV1 = Readonly<{
  schemaVersion: "underclerk.open-order-balance.internal.v1";
  merchantId: string;
  idempotencyKey: string;
  requestedAt: string;
  orderId: string;
  orderRevision: number;
  checkoutId: string;
}>;

export type OrderBalanceCheckoutRequest = Readonly<{
  command: OpenCommerceOrderBalanceInternalV1;
  merchant: OrderEditMerchantRow;
  /** One checkout has one cart; a balance checkout's cart has no lines. */
  cart: Cart;
  checkout: Checkout;
}>;

export type OrderBalanceCheckoutResult =
  | Readonly<{ kind: "created"; checkout: CommerceBuyerQuotedCheckoutV1 }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export type OrderEditCommandAuthorityOptions = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  readMerchant: (merchantId: string) => OrderEditMerchantRow | undefined;
  readSnapshot: (
    merchantId: string,
  ) => CommerceMerchantSnapshotV1 | undefined;
  readFoodServiceResources: (
    merchantId: string,
  ) => CommerceFoodServiceResourcesV1;
  readReplay: (
    merchantId: string,
    idempotencyKey: string,
    command: EditCommerceOrderV1 | ExchangeCommerceOrderLinesV1,
  ) => CommerceMutationResultV1 | undefined;
  commit: (request: OrderEditCommitRequest) => CommerceMutationResultV1;
  commitExchange: (request: OrderExchangeCommitRequest) => CommerceMutationResultV1;
  commitBalanceCheckout: (request: OrderBalanceCheckoutRequest) => void;
  readBuyerQuotedCheckout: (
    merchantId: string,
    checkoutId: string,
    sessionId: string,
  ) => CommerceBuyerQuotedCheckoutV1 | undefined;
  validateMerchant: (
    merchantId: string,
    merchant: OrderEditMerchantRow | undefined,
  ) => CommerceMutationErrorV1 | undefined;
  rejected: (error: CommerceMutationErrorV1) => CommerceMutationResultV1;
  invalidCommand: (error: unknown) => CommerceMutationErrorV1;
}>;

/** The buyer line of a balance checkout. */
export const ORDER_BALANCE_LINE_ID = "order_balance";

type PositionPlan = Map<string, CommerceInventoryPositionV1>;

type PlannedEdit = Omit<OrderEditCommitRequest, "command" | "merchant">;
type PlannedExchange = Omit<OrderExchangeCommitRequest, "command" | "merchant">;

/** What an allocation needs from its command: the merchant, the time and a change id. */
type AllocationContext = Readonly<{
  merchantId: string;
  requestedAt: string;
  editId: string;
}>;

export class OrderEditCommandAuthority {
  readonly #options: OrderEditCommandAuthorityOptions;

  constructor(options: OrderEditCommandAuthorityOptions) {
    this.#options = options;
  }

  editOrder(rawCommand: unknown): CommerceMutationResultV1 {
    let command: EditCommerceOrderV1;
    try {
      command = parseEditOrderCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (merchant === undefined || snapshot === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    const planned = this.#planEdit(command, snapshot.resources);
    if ("code" in planned) return this.#options.rejected(planned);
    return this.#options.commit({ command, merchant, ...planned });
  }

  exchangeOrderLines(rawCommand: unknown): CommerceMutationResultV1 {
    let command: ExchangeCommerceOrderLinesV1;
    try {
      command = parseExchangeOrderLinesCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined) return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(command.merchantId, command.idempotencyKey, command);
    if (replay !== undefined) return replay;
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (merchant === undefined || snapshot === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    const planned = this.#planExchange(command, snapshot.resources);
    if ("code" in planned) return this.#options.rejected(planned);
    return this.#options.commitExchange({ command, merchant, ...planned });
  }

  readOrderChanges(
    merchantId: string,
    orderId: string,
  ): CommerceOrderChangesV1 | undefined {
    const snapshot = this.#options.readSnapshot(merchantId);
    const order =
      snapshot === undefined
        ? undefined
        : findResource(snapshot.resources.orders, orderId);
    if (snapshot === undefined || order === undefined) return undefined;
    return {
      schemaVersion: "underclerk.order-changes.v1",
      orderId: order.id,
      orderRevision: order.revision,
      changes: listOrderChanges(this.#options.database, merchantId, order.id),
      balance: orderBalance(order, snapshot.resources.payments),
    };
  }

  /**
   * Opens, or returns, the checkout for what an edited order still owes. One
   * order revision has one open balance checkout for the buyer's session.
   */
  openOrderBalance(
    input: Readonly<{ claims: BuyerCheckoutProfileClaims; orderId: string }>,
  ): OrderBalanceCheckoutResult {
    const { claims } = input;
    const merchant = this.#options.readMerchant(claims.merchantId);
    const snapshot = this.#options.readSnapshot(claims.merchantId);
    if (merchant === undefined || snapshot === undefined)
      throw new Error("Verified buyer session lost its merchant");
    const order = findResource(snapshot.resources.orders, input.orderId);
    if (
      order === undefined ||
      order.origin.kind !== "online" ||
      order.origin.storefrontId !== claims.storefrontId
    )
      return rejected("orderBalance.order");
    const open = commerceTransition("order", order.lifecycle, "open_balance");
    if (!open.allowed) return { kind: "rejected", error: open.refusal };
    const outstanding = orderBalance(
      order,
      snapshot.resources.payments,
    ).outstanding;
    if (outstanding.amountMinor === 0) return rejected("orderBalance.none");
    const fulfillment = activePickupFulfillment(
      snapshot.resources.fulfillments,
      order,
    );
    const origin = readCheckout(
      this.#options.database,
      claims.merchantId,
      order.origin.checkoutId,
    );
    const originSource = origin === undefined ? undefined : checkoutOnlineSource(origin);
    const storefront = readStorefront(
      this.#options.database,
      claims.merchantId,
      order.origin.storefrontId,
    );
    if (
      fulfillment === undefined ||
      origin === undefined ||
      originSource === undefined ||
      storefront === undefined
    )
      return rejected("orderBalance.order.origin");
    const digest = buyerSessionDigest(claims.sessionId);
    for (let attempt = 1; ; attempt += 1) {
      const checkoutId = balanceCheckoutId(order, attempt);
      const existing = readCheckout(
        this.#options.database,
        claims.merchantId,
        checkoutId,
      );
      if (existing === undefined) {
        const requestedAt = this.#options.now();
        const expiresAt = timestampAfterSeconds(
          requestedAt,
          storefront.checkout.quoteTtlSeconds,
        );
        if (expiresAt === undefined) return rejected("orderBalance.policy");
        const cart: Cart = {
          cartId: `cart_${checkoutId}`,
          storefrontId: originSource.storefrontId,
          checkoutProfile: originSource.checkoutProfile,
          buyerSessionDigest: digest,
          revision: 1,
          lines: [],
          lifecycle: { state: "submitted", checkoutId, submittedAt: requestedAt },
        };
        const checkout = parseCheckout({
          checkoutId,
          source: {
            ...originSource,
            cartId: cart.cartId,
            buyerSessionDigest: digest,
          },
          revision: 1,
          lifecycle: {
            state: "quoted",
            quote: buildCheckoutQuote({
              checkoutRevision: 1,
              lines: [
                {
                  checkoutLineId: ORDER_BALANCE_LINE_ID,
                  source: {
                    kind: "order_balance",
                    orderId: order.id,
                    orderRevision: order.revision,
                  },
                  quantity: { amount: 1, scale: 0, unit: "each" },
                  unitPrice: outstanding,
                  lineTotal: outstanding,
                  allocationIds: [],
                  title: "Order balance",
                },
              ],
              totals: {
                subtotal: outstanding,
                tax: zero(outstanding.currency),
                duty: zero(outstanding.currency),
                shipping: zero(outstanding.currency),
                total: outstanding,
              },
              fulfillment: {
                kind: "pickup",
                promise: {
                  locationId: fulfillment.locationId,
                  readyAt: fulfillment.expectedBy,
                },
              },
              quotedAt: requestedAt,
              expiresAt,
            }),
          },
        });
        this.#options.commitBalanceCheckout({
          command: {
            schemaVersion: "underclerk.open-order-balance.internal.v1",
            merchantId: claims.merchantId,
            idempotencyKey: checkoutId,
            requestedAt,
            orderId: order.id,
            orderRevision: order.revision,
            checkoutId,
          },
          merchant,
          cart,
          checkout,
        });
        return this.#view(claims, checkoutId);
      }
      const owned = checkoutOnlineSource(existing)?.buyerSessionDigest === digest;
      if (existing.lifecycle.state === "payment_pending")
        return rejected("orderBalance.paymentPending");
      if (
        owned &&
        existing.lifecycle.state === "quoted" &&
        Date.parse(existing.lifecycle.quote.expiresAt) >
          Date.parse(this.#options.now())
      )
        return this.#view(claims, checkoutId);
    }
  }

  #view(
    claims: BuyerCheckoutProfileClaims,
    checkoutId: string,
  ): OrderBalanceCheckoutResult {
    const checkout = this.#options.readBuyerQuotedCheckout(
      claims.merchantId,
      checkoutId,
      claims.sessionId,
    );
    return checkout === undefined
      ? rejected("orderBalance.checkout")
      : { kind: "created", checkout };
  }

  #planEdit(
    command: EditCommerceOrderV1,
    resources: CommerceMerchantSnapshotV1["resources"],
  ): PlannedEdit | CommerceMutationErrorV1 {
    const { database } = this.#options;
    const order = findResource(resources.orders, command.orderId);
    if (order === undefined)
      return {
        code: "resource_not_found",
        kind: "commerce_order",
        id: command.orderId,
      };
    if (order.revision !== command.expectedOrderRevision)
      return {
        code: "stale_resource_revision",
        kind: "commerce_order",
        id: order.id,
        expected: command.expectedOrderRevision,
        actual: order.revision,
      };
    // Edits stop when fulfilment starts: a pickup order that staff began to
    // prepare or made ready takes a return instead.
    const editMove = commerceTransition("order", order.lifecycle, "edit");
    if (!editMove.allowed) return editMove.refusal;
    if (order.origin.kind !== "online") return invalid("orderEdit.order.origin");
    const fulfillment = activePickupFulfillment(resources.fulfillments, order);
    if (fulfillment === undefined) return invalid("orderEdit.fulfillment");
    const pickupEdit = commerceTransition(
      "pickup_fulfillment",
      fulfillment.lifecycle,
      "edit",
    );
    if (!pickupEdit.allowed) return pickupEdit.refusal;
    if (handedOverFulfillments(resources.fulfillments, order).length > 0)
      return invalid("orderEdit.fulfillment");
    // A merchant plugin's guard can refuse the edit.
    const editGuard = guardMove(database, command.merchantId, {
      machine: "order",
      event: "edit",
      from: order.lifecycle.state,
      to: editMove.to,
      subject: orderSubject(order, fulfillment, resources.variants),
      at: command.requestedAt,
      attempt: command.idempotencyKey,
    });
    if (editGuard !== undefined) return editGuard;
    const storefront = readStorefront(
      database,
      command.merchantId,
      order.origin.storefrontId,
    );
    if (
      storefront === undefined ||
      storefront.fulfillment.kind !== "pickup" ||
      storefront.checkout.tax.kind !== "percentage"
    )
      return invalid("orderEdit.storefront");
    const accepted = readAcceptedOrder(database, command.merchantId, order);
    if (accepted === undefined || !orderMatchesAccepted(order, accepted))
      return invalid("orderEdit.acceptedOrder");
    const currency = order.totals.total.currency;
    for (const money of [
      order.totals.discount,
      order.totals.serviceFee,
      order.totals.tip,
      order.totals.rounding,
    ]) {
      if (money.amountMinor !== 0) return invalid("orderEdit.order.totals");
    }
    const acceptedLines = new Map(
      accepted.lines.map((line) => [line.orderLineId, line]),
    );
    const changes = new Map(
      command.lineChanges.map((line) => [line.orderLineId, line.quantity]),
    );
    for (const [orderLineId, quantity] of changes) {
      const line = findResource(order.lineItems, orderLineId);
      if (line === undefined)
        return { code: "resource_not_found", kind: "order_line", id: orderLineId };
      // Only stock lines change; food made to order is cancelled instead.
      if (line.source.kind !== "catalog") return invalid("orderEdit.lines.editable");
      if (quantity === line.quantity.amount)
        return invalid("orderEdit.lines.unchanged");
    }
    const positions: PositionPlan = new Map();
    const advanced = new Set<string>();
    const allocations: InventoryAllocation[] = [];
    const lines: Array<
      Readonly<{ line: CommerceOrderLineItemV1; allocationIds: readonly string[] }>
    > = [];
    for (const line of order.lineItems) {
      const acceptedLine = acceptedLines.get(line.id);
      if (acceptedLine === undefined) return invalid("orderEdit.acceptedOrder");
      const quantity = changes.get(line.id);
      if (quantity === undefined) {
        lines.push({ line, allocationIds: acceptedLine.allocationIds });
        continue;
      }
      if (line.source.kind !== "catalog") return invalid("orderEdit.lines.editable");
      for (const allocationId of acceptedLine.allocationIds) {
        const released = this.#release(
          command,
          order,
          line.id,
          fulfillment.locationId,
          allocationId,
          positions,
          advanced,
        );
        if ("code" in released) return released;
        allocations.push(released);
      }
      if (quantity === 0) continue;
      const requirements =
        line.source.inventory.kind === "requirements"
          ? line.source.inventory.items
          : [];
      const allocated = this.#allocate(
        command,
        order,
        line.id,
        quantity,
        requirements,
        fulfillment.locationId,
        "fulfillment_completed",
        positions,
        advanced,
      );
      if ("code" in allocated) return allocated;
      allocations.push(...allocated);
      const lineTotal = line.unitPrice.amountMinor * quantity;
      if (!Number.isSafeInteger(lineTotal)) return invalid("orderEdit.lineTotal");
      lines.push({
        line: {
          ...line,
          quantity: { amount: quantity, scale: 0, unit: "each" },
          lineTotal: { amountMinor: lineTotal, currency },
        },
        allocationIds: allocated.map((allocation) => allocation.allocationId),
      });
    }
    const foodService = this.#options.readFoodServiceResources(
      command.merchantId,
    );
    for (const addition of command.additions) {
      if (
        order.lineItems.some(
          (line) =>
            line.source.kind === "catalog" &&
            line.source.variantId === addition.variantId,
        )
      )
        return invalid("orderEdit.additions.existingLine");
      const selection = resolveCheckoutSelection(
        database,
        command.merchantId,
        { kind: "catalog", variantId: addition.variantId },
        foodService,
        resources,
        storefront.salesChannelId,
        fulfillment.locationId,
        command.requestedAt,
        undefined,
      );
      if (selection.kind === "rejected") return selection.error;
      const { variant, offer, source, requirements, consumeOn } =
        selection.value;
      if (source.kind !== "catalog") return invalid("orderEdit.additions.source");
      if (offer.price.currency !== currency)
        return invalid("orderEdit.additions.currency");
      if (consumeOn !== "fulfillment_completed")
        return invalid("orderEdit.additions.consumption");
      const orderLineId = orderLineIdFor(
        order.id,
        `edit:${command.editId}:${addition.variantId}`,
      );
      const allocated = this.#allocate(
        command,
        order,
        orderLineId,
        addition.quantity,
        requirements,
        fulfillment.locationId,
        consumeOn,
        positions,
        advanced,
      );
      if ("code" in allocated) return allocated;
      allocations.push(...allocated);
      const lineTotal = offer.price.amountMinor * addition.quantity;
      if (!Number.isSafeInteger(lineTotal)) return invalid("orderEdit.lineTotal");
      lines.push({
        line: {
          id: orderLineId,
          source,
          sku: source.merchantCode,
          title: variant.title,
          quantity: { amount: addition.quantity, scale: 0, unit: "each" },
          fulfilledQuantity: { amount: 0, scale: 0, unit: "each" },
          unitPrice: offer.price,
          tax: zero(currency),
          discount: zero(currency),
          lineTotal: { amountMinor: lineTotal, currency },
        },
        allocationIds: allocated.map((allocation) => allocation.allocationId),
      });
    }
    if (lines.length === 0) return invalid("orderEdit.lines.empty");
    let subtotal = 0;
    for (const { line } of lines) subtotal += line.lineTotal.amountMinor;
    if (!Number.isSafeInteger(subtotal)) return invalid("orderEdit.subtotal");
    const taxed = storefrontPercentageTax(subtotal, storefront.checkout.tax);
    if (taxed === undefined) return invalid("orderEdit.tax");
    const taxAmount = taxed.tax;
    const taxes = allocateTaxAcrossLines(
      lines.map(({ line }) => ({ id: line.id, amountMinor: line.lineTotal.amountMinor })),
      subtotal,
      { amountMinor: taxAmount, currency },
    );
    if (taxes === undefined) return invalid("orderEdit.tax");
    const lineItems = lines.map(({ line }, index) => {
      const tax = taxes[index];
      if (tax === undefined) throw new Error("Edited line tax disappeared");
      return { ...line, tax };
    });
    const total =
      taxed.total +
      order.totals.duty.amountMinor +
      order.totals.shipping.amountMinor;
    const nextOrder = parseOrder({
      ...order,
      revision: order.revision + 1,
      lineItems,
      totals: {
        ...order.totals,
        subtotal: { amountMinor: subtotal, currency },
        tax: { amountMinor: taxAmount, currency },
        total: { amountMinor: total, currency },
      },
      occurredAt: command.requestedAt,
    });
    const nextFulfillment = parseFulfillment({
      ...fulfillment,
      revision: fulfillment.revision + 1,
      lineItems: lineItems.map((line) => ({
        lineItemId: line.id,
        quantity: line.quantity.amount,
      })),
      occurredAt: command.requestedAt,
    });
    const changeLines = (
      items: readonly CommerceOrderLineItemV1[],
      allocationIdsOf: (lineId: string) => readonly string[],
    ): CommerceOrderChangeLineV1[] =>
      items.map((line) => ({
        orderLineId: line.id,
        quantity: line.quantity.amount,
        lineTotal: line.lineTotal,
        tax: line.tax,
        allocationIds: allocationIdsOf(line.id),
      }));
    const allocationIdsAfter = new Map(
      lines.map(({ line, allocationIds }) => [line.id, allocationIds]),
    );
    const edit: CommerceOrderEditV1 = {
      kind: "edit",
      id: command.editId,
      orderId: order.id,
      orderRevisionBefore: order.revision,
      orderRevisionAfter: nextOrder.revision,
      reason: command.reason,
      lineChanges: command.lineChanges.map((change) => ({
        orderLineId: change.orderLineId,
        quantityBefore:
          findResource(order.lineItems, change.orderLineId)?.quantity.amount ?? 0,
        quantityAfter: change.quantity,
      })),
      additions: command.additions.map((addition) => ({
        orderLineId: orderLineIdFor(
          order.id,
          `edit:${command.editId}:${addition.variantId}`,
        ),
        variantId: addition.variantId,
        quantity: addition.quantity,
      })),
      totalBefore: order.totals.total,
      totalAfter: nextOrder.totals.total,
      linesBefore: changeLines(
        order.lineItems,
        (lineId) => acceptedLines.get(lineId)?.allocationIds ?? [],
      ),
      linesAfter: changeLines(
        lineItems,
        (lineId) => allocationIdsAfter.get(lineId) ?? [],
      ),
      occurredAt: command.requestedAt,
    };
    return {
      previousOrderRevision: order.revision,
      order: nextOrder,
      fulfillment: nextFulfillment,
      allocations,
      positions: [...positions.values()],
      edit,
    };
  }

  // An exchange on a handed-over pickup order: the return's received units
  // leave their lines, the new lines join the order with stock held for them,
  // and a new pickup fulfillment hands them over. The balance then says if
  // the buyer pays more or staff refund the rest.
  #planExchange(
    command: ExchangeCommerceOrderLinesV1,
    resources: CommerceMerchantSnapshotV1["resources"],
  ): PlannedExchange | CommerceMutationErrorV1 {
    const { database } = this.#options;
    const order = findResource(resources.orders, command.orderId);
    if (order === undefined)
      return { code: "resource_not_found", kind: "commerce_order", id: command.orderId };
    if (order.revision !== command.expectedOrderRevision)
      return {
        code: "stale_resource_revision",
        kind: "commerce_order",
        id: order.id,
        expected: command.expectedOrderRevision,
        actual: order.revision,
      };
    const exchangeMove = commerceTransition(
      "order",
      order.lifecycle,
      "exchange",
    );
    if (!exchangeMove.allowed) return exchangeMove.refusal;
    if (order.origin.kind !== "online") return invalid("orderExchange.order.origin");
    const returned = readReturn(database, command.merchantId, command.returnId);
    if (returned === undefined || returned.orderId !== order.id)
      return { code: "resource_not_found", kind: "return", id: command.returnId };
    if (returned.revision !== command.expectedReturnRevision)
      return {
        code: "stale_resource_revision",
        kind: "return",
        id: returned.id,
        expected: command.expectedReturnRevision,
        actual: returned.revision,
      };
    const settle = commerceTransition("return", returned.lifecycle, "exchange");
    if (!settle.allowed) return settle.refusal;
    const back = new Map(
      returned.lines
        .filter((line) => line.decision === "authorized")
        .map((line) => [line.orderLineId, line.quantity]),
    );
    if (back.size === 0) return invalid("orderExchange.return.lines");
    const handedOver = handedOverFulfillments(resources.fulfillments, order);
    const previous = handedOver[0];
    if (previous === undefined || previous.kind !== "pickup")
      return invalid("orderExchange.fulfillment");
    // A merchant plugin's guard can refuse the exchange.
    const exchangeGuard = guardMove(database, command.merchantId, {
      machine: "order",
      event: "exchange",
      from: order.lifecycle.state,
      to: exchangeMove.to,
      subject: orderSubject(order, previous, resources.variants),
      at: command.requestedAt,
      attempt: command.idempotencyKey,
    });
    if (exchangeGuard !== undefined) return exchangeGuard;
    const storefront = readStorefront(
      database,
      command.merchantId,
      order.origin.storefrontId,
    );
    if (
      storefront === undefined ||
      storefront.fulfillment.kind !== "pickup" ||
      storefront.checkout.tax.kind !== "percentage"
    )
      return invalid("orderExchange.storefront");
    const accepted = readAcceptedOrder(database, command.merchantId, order);
    if (accepted === undefined || !orderMatchesAccepted(order, accepted))
      return invalid("orderExchange.acceptedOrder");
    const currency = order.totals.total.currency;
    for (const money of [
      order.totals.discount,
      order.totals.serviceFee,
      order.totals.tip,
      order.totals.rounding,
    ]) {
      if (money.amountMinor !== 0) return invalid("orderExchange.order.totals");
    }
    for (const orderLineId of back.keys())
      if (findResource(order.lineItems, orderLineId) === undefined)
        return invalid("orderExchange.return.lines");
    const acceptedLines = new Map(accepted.lines.map((line) => [line.orderLineId, line]));
    const lines: Array<
      Readonly<{ line: CommerceOrderLineItemV1; allocationIds: readonly string[] }>
    > = [];
    const lineChanges: Array<
      Readonly<{ orderLineId: string; quantityBefore: number; quantityAfter: number }>
    > = [];
    for (const line of order.lineItems) {
      const acceptedLine = acceptedLines.get(line.id);
      if (acceptedLine === undefined) return invalid("orderExchange.acceptedOrder");
      const quantityBack = back.get(line.id) ?? 0;
      if (quantityBack === 0) {
        lines.push({ line, allocationIds: acceptedLine.allocationIds });
        continue;
      }
      // The units were handed over and came back through the return, which
      // restocked them; their allocations stay committed to the first sale.
      const quantity = line.quantity.amount - quantityBack;
      if (quantity < 0) return invalid("orderExchange.return.lines");
      lineChanges.push({
        orderLineId: line.id,
        quantityBefore: line.quantity.amount,
        quantityAfter: quantity,
      });
      if (quantity === 0) continue;
      const lineTotal = line.unitPrice.amountMinor * quantity;
      if (!Number.isSafeInteger(lineTotal)) return invalid("orderExchange.lineTotal");
      lines.push({
        line: {
          ...line,
          quantity: { amount: quantity, scale: 0, unit: "each" },
          fulfilledQuantity: {
            amount: Math.min(line.fulfilledQuantity.amount, quantity),
            scale: 0,
            unit: "each",
          },
          lineTotal: { amountMinor: lineTotal, currency },
        },
        allocationIds: acceptedLine.allocationIds,
      });
    }
    const positions: PositionPlan = new Map();
    const advanced = new Set<string>();
    const allocations: InventoryAllocation[] = [];
    const context = {
      merchantId: command.merchantId,
      requestedAt: command.requestedAt,
      editId: `exchange:${command.exchangeId}`,
    };
    const foodService = this.#options.readFoodServiceResources(command.merchantId);
    const added: CommerceOrderLineItemV1[] = [];
    for (const addition of command.additions) {
      const selection = resolveCheckoutSelection(
        database,
        command.merchantId,
        { kind: "catalog", variantId: addition.variantId },
        foodService,
        resources,
        storefront.salesChannelId,
        previous.locationId,
        command.requestedAt,
        undefined,
      );
      if (selection.kind === "rejected") return selection.error;
      const { variant, offer, source, requirements, consumeOn } = selection.value;
      if (source.kind !== "catalog") return invalid("orderExchange.additions.source");
      if (offer.price.currency !== currency) return invalid("orderExchange.additions.currency");
      if (consumeOn !== "fulfillment_completed")
        return invalid("orderExchange.additions.consumption");
      const orderLineId = orderLineIdFor(
        order.id,
        `exchange:${command.exchangeId}:${addition.variantId}`,
      );
      const allocated = this.#allocate(
        context,
        order,
        orderLineId,
        addition.quantity,
        requirements,
        previous.locationId,
        consumeOn,
        positions,
        advanced,
      );
      if ("code" in allocated) return allocated;
      allocations.push(...allocated);
      const lineTotal = offer.price.amountMinor * addition.quantity;
      if (!Number.isSafeInteger(lineTotal)) return invalid("orderExchange.lineTotal");
      const line: CommerceOrderLineItemV1 = {
        id: orderLineId,
        source,
        sku: source.merchantCode,
        title: variant.title,
        quantity: { amount: addition.quantity, scale: 0, unit: "each" },
        fulfilledQuantity: { amount: 0, scale: 0, unit: "each" },
        unitPrice: offer.price,
        tax: zero(currency),
        discount: zero(currency),
        lineTotal: { amountMinor: lineTotal, currency },
      };
      added.push(line);
      lines.push({ line, allocationIds: allocated.map((allocation) => allocation.allocationId) });
    }
    let subtotal = 0;
    for (const { line } of lines) subtotal += line.lineTotal.amountMinor;
    if (!Number.isSafeInteger(subtotal)) return invalid("orderExchange.subtotal");
    const taxed = storefrontPercentageTax(subtotal, storefront.checkout.tax);
    if (taxed === undefined) return invalid("orderExchange.tax");
    const taxAmount = taxed.tax;
    const taxes = allocateTaxAcrossLines(
      lines.map(({ line }) => ({ id: line.id, amountMinor: line.lineTotal.amountMinor })),
      subtotal,
      { amountMinor: taxAmount, currency },
    );
    if (taxes === undefined) return invalid("orderExchange.tax");
    const lineItems = lines.map(({ line }, index) => {
      const tax = taxes[index];
      if (tax === undefined) throw new Error("Exchanged line tax disappeared");
      return { ...line, tax };
    });
    const total =
      taxed.total +
      order.totals.duty.amountMinor +
      order.totals.shipping.amountMinor;
    const nextOrder = parseOrder({
      ...order,
      revision: order.revision + 1,
      lineItems,
      totals: {
        ...order.totals,
        subtotal: { amountMinor: subtotal, currency },
        tax: { amountMinor: taxAmount, currency },
        total: { amountMinor: total, currency },
      },
      lifecycle: { state: exchangeMove.to, since: command.requestedAt },
      occurredAt: command.requestedAt,
    });
    const expectedBy = timestampAfterSeconds(
      command.requestedAt,
      storefront.fulfillment.readyLeadTimeSeconds,
    );
    if (expectedBy === undefined) return invalid("orderExchange.storefront");
    const fulfillment = parseFulfillment({
      kind: "pickup",
      id: `fulfillment_${sha256(`${command.merchantId}:${order.id}:exchange:${command.exchangeId}`).slice(0, 32)}`,
      revision: 1,
      orderId: order.id,
      lineItems: added.map((line) => ({ lineItemId: line.id, quantity: line.quantity.amount })),
      locationId: previous.locationId,
      expectedBy,
      lifecycle: { state: "requested", requestedAt: command.requestedAt },
      occurredAt: command.requestedAt,
    });
    const changeLines = (
      items: readonly CommerceOrderLineItemV1[],
      allocationIdsOf: (lineId: string) => readonly string[],
    ): CommerceOrderChangeLineV1[] =>
      items.map((line) => ({
        orderLineId: line.id,
        quantity: line.quantity.amount,
        lineTotal: line.lineTotal,
        tax: line.tax,
        allocationIds: allocationIdsOf(line.id),
      }));
    const allocationIdsAfter = new Map(
      lines.map(({ line, allocationIds }) => [line.id, allocationIds]),
    );
    const exchange: CommerceOrderExchangeV1 = {
      kind: "exchange",
      id: command.exchangeId,
      orderId: order.id,
      orderRevisionBefore: order.revision,
      orderRevisionAfter: nextOrder.revision,
      reason: command.reason,
      lineChanges,
      additions: added.map((line) => ({
        orderLineId: line.id,
        variantId: line.source.kind === "catalog" ? line.source.variantId : "",
        quantity: line.quantity.amount,
      })),
      totalBefore: order.totals.total,
      totalAfter: nextOrder.totals.total,
      linesBefore: changeLines(
        order.lineItems,
        (lineId) => acceptedLines.get(lineId)?.allocationIds ?? [],
      ),
      linesAfter: changeLines(lineItems, (lineId) => allocationIdsAfter.get(lineId) ?? []),
      occurredAt: command.requestedAt,
      returnId: returned.id,
      fulfillmentId: fulfillment.id,
    };
    return {
      previousOrderRevision: order.revision,
      order: nextOrder,
      fulfillment,
      allocations,
      positions: [...positions.values()],
      exchange,
      returnRecord: {
        ...returned,
        revision: returned.revision + 1,
        lifecycle: {
          state: settle.to,
          closedAt: command.requestedAt,
          refundAttemptId: null,
          exchangeId: command.exchangeId,
        },
        occurredAt: command.requestedAt,
      },
    };
  }

  #release(
    command: EditCommerceOrderV1,
    order: CommerceOrderV1,
    orderLineId: string,
    locationId: string,
    allocationId: string,
    positions: PositionPlan,
    advanced: Set<string>,
  ): InventoryAllocation | CommerceMutationErrorV1 {
    const allocation = readInventoryAllocation(
      this.#options.database,
      command.merchantId,
      allocationId,
    );
    if (
      allocation === undefined ||
      allocation.lifecycle.state !== "allocated_to_order" ||
      allocation.lifecycle.orderId !== order.id ||
      allocation.lifecycle.orderLineId !== orderLineId ||
      allocation.locationId !== locationId
    )
      return invalid("orderEdit.inventoryAllocations");
    const key = positionKey(allocation.inventoryItemId, allocation.locationId);
    const position =
      positions.get(key) ??
      readInventoryPositionForItemLocation(
        this.#options.database,
        command.merchantId,
        allocation.inventoryItemId,
        allocation.locationId,
      );
    if (
      position === undefined ||
      !isAccountedPosition(position) ||
      !accountedPositionCanRelease(position, allocation.quantity)
    )
      return invalid("orderEdit.inventoryPosition");
    positions.set(
      key,
      releasedInventoryPosition(
        position,
        allocation.quantity,
        command.requestedAt,
        advanced.has(key),
      ),
    );
    advanced.add(key);
    return parseInventoryAllocation({
      ...allocation,
      revision: allocation.revision + 1,
      lifecycle: {
        state: "released",
        demand: { kind: "order", orderId: order.id, orderLineId },
        reason: "order_edited",
        releasedAt: command.requestedAt,
      },
    });
  }

  #allocate(
    command: AllocationContext,
    order: CommerceOrderV1,
    orderLineId: string,
    lineQuantity: number,
    requirements: readonly InventoryRequirement[],
    locationId: string,
    consumeOn: InventoryAllocationOrderCommitPoint,
    positions: PositionPlan,
    advanced: Set<string>,
  ): readonly InventoryAllocation[] | CommerceMutationErrorV1 {
    const allocations: InventoryAllocation[] = [];
    for (const requirement of requirements) {
      const key = positionKey(requirement.inventoryItemId, locationId);
      const position =
        positions.get(key) ??
        readInventoryPositionForItemLocation(
          this.#options.database,
          command.merchantId,
          requirement.inventoryItemId,
          locationId,
        );
      if (position === undefined)
        return {
          code: "resource_not_found",
          kind: "inventory_position",
          id: `${requirement.inventoryItemId}:${locationId}`,
        };
      if (
        position.balance.kind !== "accounted" ||
        position.balance.available.unit !== requirement.quantity.unit
      )
        return invalid("inventoryPosition.balance");
      const required = scaleCheckoutRequirement(
        requirement.quantity,
        lineQuantity,
        position.balance.available.scale,
      );
      if (required === undefined) return invalid("inventoryRequirement.quantity");
      const usable = readUsableInventoryQuantity(
        this.#options.database,
        command.merchantId,
        position,
        command.requestedAt,
      );
      if (wholeAmountAtScale(usable, position.balance.available.scale) < required)
        return {
          code: "insufficient_inventory",
          inventoryItemId: requirement.inventoryItemId,
          locationId,
          requestedAmount: required,
          availableAmount: wholeAmountAtScale(
            usable,
            position.balance.available.scale,
          ),
        };
      positions.set(
        key,
        parseInventoryPosition({
          ...position,
          revision: position.revision + (advanced.has(key) ? 0 : 1),
          balance: {
            kind: "accounted",
            onHand: position.balance.onHand,
            allocated: {
              ...position.balance.allocated,
              amount: position.balance.allocated.amount + required,
            },
            available: {
              ...position.balance.available,
              amount: position.balance.available.amount - required,
            },
          },
          occurredAt: command.requestedAt,
        }),
      );
      advanced.add(key);
      allocations.push(
        parseInventoryAllocation({
          allocationId: `allocation_${sha256(
            `${command.merchantId}:${order.id}:${command.editId}:${orderLineId}:${requirement.inventoryItemId}`,
          )}`,
          inventoryItemId: requirement.inventoryItemId,
          locationId,
          quantity: {
            amount: required,
            scale: position.balance.available.scale,
            unit: position.balance.available.unit,
          },
          revision: 1,
          lifecycle: {
            state: "allocated_to_order",
            orderId: order.id,
            orderLineId,
            consumeOn,
            allocatedAt: command.requestedAt,
          },
        }),
      );
    }
    return allocations;
  }
}

export function balanceCheckoutId(
  order: CommerceOrderV1,
  attempt: number,
): string {
  return `checkout_balance_${sha256(`${order.id}:${order.revision}`).slice(0, 32)}_${attempt}`;
}

// The order's one open pickup fulfillment: neither cancelled nor handed over.
// After an exchange it is the exchange's fulfillment.
function activePickupFulfillment(
  fulfillments: readonly CommerceFulfillmentV1[],
  order: CommerceOrderV1,
): CommercePickupFulfillmentV1 | undefined {
  const active = fulfillments.filter(
    (fulfillment) =>
      fulfillment.orderId === order.id &&
      fulfillment.lifecycle.state !== "cancelled" &&
      fulfillment.lifecycle.state !== "completed",
  );
  const fulfillment = active[0];
  return active.length === 1 && fulfillment?.kind === "pickup"
    ? fulfillment
    : undefined;
}

function handedOverFulfillments(
  fulfillments: readonly CommerceFulfillmentV1[],
  order: CommerceOrderV1,
): readonly CommerceFulfillmentV1[] {
  return fulfillments.filter(
    (fulfillment) =>
      fulfillment.orderId === order.id && fulfillment.lifecycle.state === "completed",
  );
}

function positionKey(inventoryItemId: string, locationId: string): string {
  return `${inventoryItemId}\u0000${locationId}`;
}

function zero(currency: string): Money {
  return { amountMinor: 0, currency };
}

function invalid(field: string): CommerceMutationErrorV1 {
  return { code: "resource_relationship_invalid", field };
}

function rejected(field: string): OrderBalanceCheckoutResult {
  return { kind: "rejected", error: invalid(field) };
}
