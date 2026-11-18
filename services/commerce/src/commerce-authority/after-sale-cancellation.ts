import { guardMove, orderSubject } from "../plugins/machine-guards.ts";
import { paymentAwaitsInvoice } from "../plugins/companies/index.ts";
import {
  checkoutProfileOf,
  parseCancelOrderCommand,
  parseRefundOrderCommand,
  parseFulfillment,
  parseInventoryAllocation,
  parseOrder,
  parsePayment,
  parseRefundAttempt,
  parseRefundOrderTendersCommand,
  type CancelCommerceOrderV1,
  type RefundCommerceOrderTendersV1,
  type RefundCommerceOrderV1,
  type CommerceTenderRefundPartV1,
  type CommerceTenderRefundV1,
  type CommerceResourcesV1,
  type CommerceFulfillmentV1,
  type CommerceInventoryPositionV1,
  type CommerceMerchantSnapshotV1,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
  type CommerceOrderAdjustmentV1,
  type CommerceOrderV1,
  type CommercePaymentRefundResultV1,
  type CommercePaymentV1,
  type CommercePreparationTicketV1,
  orderOriginCheckoutId,
} from "@seams/commerce-client";
import { planOrderTicketCancellation } from "../plugins/food-service/index.ts";
import {
  commerceTransition,
  isTerminalCommerceState,
  type Checkout,
  type CheckoutPaymentAttempt,
  type CommerceMachineEvent,
  type InventoryAllocation,
  type Money,
  type RefundAttempt,
  type RefundAttemptLifecycle,
  type RefundAllocation,
} from "@seams/commerce-contracts";

import {
  refundAttemptMoney,
  refundFits,
  safeMoneySum,
  tenderPosition,
} from "../payments/position.ts";

import {
  listPendingRefunds,
  readRefundAttempt,
  readRefundCommand,
  type StoredRefundAttempt,
} from "../payments/payment-records.ts";
import {
  planTenderRefund,
  type TenderRefundPart,
} from "../payments/refund-split.ts";
import {
  listInventoryAllocations,
  readCheckout,
  readCheckoutPaymentAttempt,
  readInventoryAllocation,
} from "../checkout-persistence.ts";
import type { CommerceDatabase } from "../database.ts";
import { readInventoryPositionForItemLocation } from "../inventory-persistence.ts";
import type {
  MerchantPaymentRefundCommand,
  PaymentRefundGateway,
} from "../payments/provider.ts";
import {
  accountedPositionCanRelease,
  isAccountedPosition,
  releasedInventoryPosition,
} from "./inventory-planning.ts";
import {
  checkoutOrderMatchesCheckout,
  findResource,
  amountDue,
  sameMoney,
  sha256,
  timestampAtOrBefore,
} from "./checkout-shared.ts";
import { errorMessage, isRecord } from "@seams/std";
import { storedValueRedemption } from "../plugins/stored-value/index.ts";
import { readManualTender } from "../payments/manual-tender.ts";
import type { Variant, VariantBy } from "@seams/type-utils";
import {
  balanceCheckoutOrder,
  orderMatchesAccepted,
  readAcceptedOrder,
  readPaymentChange,
  refundCeilings,
  type AcceptedOrder,
  type RefundCeilings,
} from "./order-changes.ts";

type AfterSaleMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

export type CancellationReservationPlan = Readonly<{
  order: CommerceOrderV1;
  fulfillment: CommerceFulfillmentV1;
  /** The order's preparation tickets, cancelled before preparation ended. */
  tickets: readonly CommercePreparationTicketV1[];
  allocations: readonly InventoryAllocation[];
  positions: readonly CommerceInventoryPositionV1[];
  refundAttempt: RefundAttempt;
}>;

type CancellationResolutionBase = Readonly<{
  order: CommerceOrderV1;
  refundAttempt: RefundAttempt;
  /** Where a refund with no payment provider credits its money. */
  storedValueCredit?: StoredValueCreditTarget;
}>;

export type CancellationResolutionPlan = CancellationResolutionBase &
  (
    | Readonly<{ kind: "refunded"; payment: CommercePaymentV1 }>
    | Readonly<{
        kind: "processing" | "rejected" | "indeterminate";
        payment?: never;
      }>
  );

export type RefundReservationPlan = Readonly<{
  order: CommerceOrderV1;
  refundAttempt: RefundAttempt;
}>;

type RefundResolutionBase = Readonly<{
  order: CommerceOrderV1;
  refundAttempt: RefundAttempt;
  /** Where a refund with no payment provider credits its money. */
  storedValueCredit?: StoredValueCreditTarget;
}>;

/**
 * A refund that no payment provider makes: a stored-value payment returns
 * to its own account, and a refund to store credit goes to the customer.
 */
type StoredValueCreditTarget =
  | Readonly<{ kind: "account"; accountId: string }>
  | Readonly<{ kind: "store_credit"; customerId: string; currency: string }>;

export type RefundResolutionPlan = RefundResolutionBase &
  (
    | Readonly<{ kind: "refunded"; payment: CommercePaymentV1 }>
    | Readonly<{
        kind: "processing" | "rejected" | "indeterminate";
        payment?: never;
      }>
  );

type AfterSaleMutationCommand =
  CancelCommerceOrderV1 | RefundCommerceOrderV1;

type CancellationPlanResult<Plan> =
  | Readonly<{ kind: "planned"; value: Plan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

type AfterSaleCommandAuthorityOptions = Readonly<{
  database: CommerceDatabase;
  paymentGateway: PaymentRefundGateway;
  now: () => string;
  readMerchant: (merchantId: string) => AfterSaleMerchantRow | undefined;
  readSnapshot: (
    merchantId: string,
  ) => CommerceMerchantSnapshotV1 | undefined;
  readReplay: (
    merchantId: string,
    idempotencyKey: string,
    command: AfterSaleMutationCommand,
  ) => CommerceMutationResultV1 | undefined;
  validateMerchant: (
    merchantId: string,
    merchant: AfterSaleMerchantRow | undefined,
  ) => CommerceMutationErrorV1 | undefined;
  rejected: (error: CommerceMutationErrorV1) => CommerceMutationResultV1;
  invalidCommand: (error: unknown) => CommerceMutationErrorV1;
  commandDigest: (command: AfterSaleMutationCommand) => string;
  reserveCancellation: (
    command: CancelCommerceOrderV1,
    merchant: AfterSaleMerchantRow,
    plan: CancellationReservationPlan,
    commandDigest: string,
  ) => void;
  resolveCancellation: (
    command: CancelCommerceOrderV1,
    merchant: AfterSaleMerchantRow,
    plan: CancellationResolutionPlan,
  ) => CommerceMutationResultV1;
  reserveRefund: (
    command: RefundCommerceOrderV1,
    merchant: AfterSaleMerchantRow,
    plan: RefundReservationPlan,
    commandDigest: string,
  ) => void;
  resolveRefund: (
    command: RefundCommerceOrderV1,
    merchant: AfterSaleMerchantRow,
    plan: RefundResolutionPlan,
  ) => CommerceMutationResultV1;
  /** The customer an order belongs to, for a refund to store credit. */
  customerIdForOrder: (merchantId: string, orderId: string) => string | null;
}>;

export class AfterSaleCommandAuthority {
  readonly #options: AfterSaleCommandAuthorityOptions;

  constructor(options: AfterSaleCommandAuthorityOptions) {
    this.#options = options;
  }

  async cancelOrder(rawCommand: unknown): Promise<CommerceMutationResultV1> {
    let command: CancelCommerceOrderV1;
    try {
      command = parseCancelOrderCommand(rawCommand);
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
    if (replay !== undefined) {
      await this.#refundOtherPayments(command);
      return replay;
    }
    if (merchant === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const digest = this.#options.commandDigest(command);
    const stored = readRefundAttempt(
      this.#options.database,
      command.merchantId,
      command.refundAttemptId,
    );
    const attempt =
      stored === undefined
        ? this.#reserveNewCancellation(command, merchant, digest)
        : this.#resumeCancellation(command, stored, digest);
    if (isMutationResult(attempt)) return attempt;
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (snapshot === undefined) {
      throw new Error("Cancellation reservation lost its merchant snapshot");
    }
    const credit = this.#storedValueCredit(command, undefined);
    let executionResult: CommercePaymentRefundResultV1;
    if (credit !== undefined) {
      executionResult = internalRefundResult(
        "stored_value",
        attempt,
        this.#options.now(),
      );
    } else if (this.#isManual(command)) {
      executionResult = internalRefundResult(
        "manual",
        attempt,
        this.#options.now(),
      );
    } else {
      const request = planCancellationRefundRequest(
        this.#options.database,
        command,
        attempt,
        snapshot.resources,
      );
      if (request.kind === "rejected")
        return this.#options.rejected(request.error);
      executionResult = await this.#options.paymentGateway.refund(
        withEarlierTry(request.value, attempt),
      );
    }
    const currentMerchant = this.#options.readMerchant(command.merchantId);
    if (currentMerchant === undefined) {
      throw new Error(
        "Cancellation merchant disappeared before refund resolution",
      );
    }
    const currentSnapshot = this.#options.readSnapshot(command.merchantId);
    if (currentSnapshot === undefined) {
      throw new Error(
        "Cancellation snapshot disappeared before refund resolution",
      );
    }
    const resolution = planCancellationResolution(
      command,
      attempt,
      executionResult,
      currentSnapshot.resources,
      this.#options.now(),
    );
    if (resolution.kind === "rejected") {
      return this.#options.rejected(resolution.error);
    }
    const result = this.#options.resolveCancellation(
      command,
      currentMerchant,
      credit === undefined
        ? resolution.value
        : { ...resolution.value, storedValueCredit: credit },
    );
    await this.#refundOtherPayments(command);
    return result;
  }

  // A cancelled order also refunds what is left of its other payments, such
  // as the balance of an edit. Each refund has an attempt derived from the
  // cancellation, so a repeated cancellation starts none of them twice; an
  // attempt that did not finish is left to refund reconciliation.
  async #refundOtherPayments(command: CancelCommerceOrderV1): Promise<void> {
    const { database } = this.#options;
    const first = this.#options.readSnapshot(command.merchantId);
    if (first === undefined) return;
    const paymentIds = first.resources.payments
      .filter(
        (payment) =>
          payment.orderId === command.orderId && payment.id !== command.paymentId,
      )
      .map((payment) => payment.id);
    for (const paymentId of paymentIds) {
      const refundAttemptId = `${command.refundAttemptId}_${sha256(paymentId).slice(0, 16)}`;
      if (readRefundAttempt(database, command.merchantId, refundAttemptId))
        continue;
      const merchant = this.#options.readMerchant(command.merchantId);
      const snapshot = this.#options.readSnapshot(command.merchantId);
      const order =
        snapshot === undefined
          ? undefined
          : findResource(snapshot.resources.orders, command.orderId);
      const payment =
        snapshot === undefined
          ? undefined
          : findResource(snapshot.resources.payments, paymentId);
      if (
        merchant === undefined ||
        order?.lifecycle.state !== "cancelled" ||
        payment === undefined ||
        (payment.lifecycle.state !== "captured" &&
          payment.lifecycle.state !== "partially_refunded")
      )
        continue;
      const amount = tenderPosition(
        database,
        command.merchantId,
        order.id,
        payment,
      )?.refundable;
      if (amount === undefined || amount.amountMinor === 0) continue;
      const allocation = allocateRefund(
        order,
        refundCeilings(database, command.merchantId, order),
        amount,
      );
      if (allocation === undefined) continue;
      await this.refundOrder({
        schemaVersion: "underclerk.refund-order.v1",
        merchantId: command.merchantId,
        expectedMerchantRevision: merchant.revision,
        idempotencyKey: refundAttemptId,
        requestedAt: this.#options.now(),
        orderId: order.id,
        orderRevision: order.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId,
        refundPolicyId: "order_cancellation",
        amount,
        allocation,
        reason: command.reason,
      });
    }
  }

  async refundOrder(rawCommand: unknown): Promise<CommerceMutationResultV1> {
    let command: RefundCommerceOrderV1;
    try {
      command = parseRefundOrderCommand(rawCommand);
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
    if (merchant === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const digest = this.#options.commandDigest(command);
    const stored = readRefundAttempt(
      this.#options.database,
      command.merchantId,
      command.refundAttemptId,
    );
    const attempt =
      stored === undefined
        ? this.#reserveNewRefund(command, merchant, digest)
        : this.#resumeRefund(command, stored, digest);
    if (isMutationResult(attempt)) return attempt;
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (snapshot === undefined)
      throw new Error("Refund reservation lost its merchant snapshot");
    const credit = this.#storedValueCredit(command, command.destination);
    let executionResult: CommercePaymentRefundResultV1;
    if (credit !== undefined) {
      executionResult = internalRefundResult(
        "stored_value",
        attempt,
        this.#options.now(),
      );
    } else if (this.#isManual(command)) {
      executionResult = internalRefundResult(
        "manual",
        attempt,
        this.#options.now(),
      );
    } else {
      const request = planRefundRequest(
        this.#options.database,
        command,
        attempt,
        snapshot.resources,
      );
      if (request.kind === "rejected")
        return this.#options.rejected(request.error);
      executionResult = await this.#options.paymentGateway.refund(
        withEarlierTry(request.value, attempt),
      );
    }
    const currentMerchant = this.#options.readMerchant(command.merchantId);
    if (currentMerchant === undefined) {
      throw new Error("Refund merchant disappeared before resolution");
    }
    const currentSnapshot = this.#options.readSnapshot(command.merchantId);
    if (currentSnapshot === undefined)
      throw new Error("Refund snapshot disappeared before resolution");
    const resolution = planRefundResolution(
      this.#options.database,
      command,
      attempt,
      executionResult,
      currentSnapshot.resources,
      this.#options.now(),
    );
    if (resolution.kind === "rejected")
      return this.#options.rejected(resolution.error);
    return this.#options.resolveRefund(
      command,
      currentMerchant,
      credit === undefined
        ? resolution.value
        : { ...resolution.value, storedValueCredit: credit },
    );
  }

  /**
   * Splits one refund over the order's payments and runs each part as an
   * ordinary refund of one payment. A part whose attempt exists runs again
   * with the command that reserved it, so the same request resumes where it
   * stopped. A refused part stops the parts after it.
   */
  async refundOrderTenders(
    rawCommand: unknown,
  ): Promise<CommerceTenderRefundV1> {
    const refused = (
      error: CommerceMutationErrorV1,
    ): CommerceTenderRefundV1 => ({
      schemaVersion: "underclerk.tender-refund.v1",
      outcome: "rejected",
      error,
    });
    let command: RefundCommerceOrderTendersV1;
    try {
      command = parseRefundOrderTendersCommand(rawCommand);
    } catch (error) {
      return refused(this.#options.invalidCommand(error));
    }
    const { database } = this.#options;
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      this.#options.readMerchant(command.merchantId),
    );
    if (merchantError !== undefined) return refused(merchantError);
    const snapshot = this.#options.readSnapshot(command.merchantId);
    const order =
      snapshot === undefined
        ? undefined
        : findResource(snapshot.resources.orders, command.orderId);
    if (snapshot === undefined || order === undefined)
      return refused({
        code: "resource_not_found",
        kind: "commerce_order",
        id: command.orderId,
      });
    const plan = planTenderRefund(
      database,
      command.merchantId,
      order,
      snapshot.resources.payments,
      command,
    );
    if (plan.kind === "rejected") return refused(plan.error);
    const parts: CommerceTenderRefundPartV1[] = [];
    for (const part of plan.parts) {
      const stored = readRefundCommand(
        database,
        command.merchantId,
        part.refundAttemptId,
      );
      const result = await this.refundOrder(
        stored ?? this.#tenderRefundCommand(command, part),
      );
      parts.push({
        paymentId: part.paymentId,
        refundAttemptId: part.refundAttemptId,
        amount: part.amount,
        result,
      });
      if (result.outcome === "rejected") break;
    }
    return {
      schemaVersion: "underclerk.tender-refund.v1",
      outcome: "split",
      orderId: order.id,
      parts,
    };
  }

  // A part's own refund command, with the revisions that hold now.
  #tenderRefundCommand(
    command: RefundCommerceOrderTendersV1,
    part: TenderRefundPart,
  ): RefundCommerceOrderV1 | undefined {
    const merchant = this.#options.readMerchant(command.merchantId);
    const resources = this.#options.readSnapshot(command.merchantId)?.resources;
    const order =
      resources === undefined
        ? undefined
        : findResource(resources.orders, command.orderId);
    const payment =
      resources === undefined
        ? undefined
        : findResource(resources.payments, part.paymentId);
    if (merchant === undefined || order === undefined || payment === undefined)
      return undefined;
    return {
      schemaVersion: "underclerk.refund-order.v1",
      merchantId: command.merchantId,
      expectedMerchantRevision: merchant.revision,
      idempotencyKey: part.refundAttemptId,
      requestedAt: command.requestedAt,
      orderId: order.id,
      orderRevision: order.revision,
      paymentId: payment.id,
      paymentRevision: payment.revision,
      refundAttemptId: part.refundAttemptId,
      refundPolicyId: command.refundPolicyId,
      amount: part.amount,
      allocation: part.allocation,
      reason: command.reason,
    };
  }

  /** Whether staff took the payment in cash or by bank transfer. */
  #isManual(
    command: CancelCommerceOrderV1 | RefundCommerceOrderV1,
  ): boolean {
    return (
      readManualTender(
        this.#options.database,
        command.merchantId,
        command.paymentId,
      ) !== undefined
    );
  }

  /**
   * Where a refund goes with no payment provider: back to the account of a
   * stored-value payment, or to the order's customer as store credit.
   */
  #storedValueCredit(
    command: CancelCommerceOrderV1 | RefundCommerceOrderV1,
    destination: "store_credit" | undefined,
  ): StoredValueCreditTarget | undefined {
    const redemption = storedValueRedemption(
      this.#options.database,
      command.merchantId,
      command.paymentId,
    );
    if (redemption !== undefined)
      return { kind: "account", accountId: redemption.accountId };
    if (destination !== "store_credit") return undefined;
    const customerId = this.#options.customerIdForOrder(
      command.merchantId,
      command.orderId,
    );
    return customerId === null ||
      command.schemaVersion !== "underclerk.refund-order.v1"
      ? undefined
      : {
          kind: "store_credit",
          customerId,
          currency: command.amount.currency,
        };
  }

  /**
   * Reads again each refund that waits on the payment provider and is due,
   * by replaying the command that reserved it: the receipt is the one that
   * the caller's own retry gets. Returns when the next refund is due, or
   * null when none waits.
   */
  async reconcilePendingRefunds(): Promise<string | null> {
    const now = this.#options.now();
    for (const pending of listPendingRefunds(this.#options.database, 20)) {
      if (pending.reconcileAfter > now) break;
      try {
        const command = pending.command;
        await (isRecord(command) &&
        command.schemaVersion === "underclerk.cancel-order.v1"
          ? this.cancelOrder(command)
          : this.refundOrder(command));
      } catch (error) {
        console.warn(
          "underclerk.refund_reconciliation_failed",
          pending.refundAttemptId,
          errorMessage(error),
        );
      }
    }
    return (
      listPendingRefunds(this.#options.database, 1)[0]?.reconcileAfter ?? null
    );
  }

  async reconcileRefund(
    merchantId: string,
    refundAttemptId: string,
  ): Promise<CommerceMutationResultV1> {
    const merchant = this.#options.readMerchant(merchantId);
    const stored = readRefundAttempt(
      this.#options.database,
      merchantId,
      refundAttemptId,
    );
    if (
      merchant === undefined ||
      stored === undefined ||
      stored.attempt.reason.kind !== "order_refund"
    ) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "refund.reconciliation",
      });
    }
    const ask = commerceTransition(
      "refund_attempt",
      stored.attempt.lifecycle,
      "ask_provider",
    );
    if (!ask.allowed) return this.#options.rejected(ask.refusal);
    const snapshot = this.#options.readSnapshot(merchantId);
    if (snapshot === undefined)
      throw new Error("Refund reconciliation lost its merchant snapshot");
    const command = refundReconciliationCommand(
      merchant,
      stored.attempt,
      snapshot.resources,
    );
    if (command === undefined) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "refund.reconciliationResources",
      });
    }
    const request = planRefundRequest(
      this.#options.database,
      command,
      stored.attempt,
      snapshot.resources,
    );
    if (request.kind === "rejected")
      return this.#options.rejected(request.error);
    const executionResult = await this.#options.paymentGateway.refund(
      withEarlierTry(request.value, stored.attempt),
    );
    const currentMerchant = this.#options.readMerchant(merchantId);
    const currentSnapshot = this.#options.readSnapshot(merchantId);
    if (currentMerchant === undefined || currentSnapshot === undefined) {
      throw new Error("Refund reconciliation lost its current merchant state");
    }
    const resolution = planRefundResolution(
      this.#options.database,
      command,
      stored.attempt,
      executionResult,
      currentSnapshot.resources,
      this.#options.now(),
    );
    return resolution.kind === "rejected"
      ? this.#options.rejected(resolution.error)
      : this.#options.resolveRefund(command, currentMerchant, resolution.value);
  }

  #reserveNewCancellation(
    command: CancelCommerceOrderV1,
    merchant: AfterSaleMerchantRow,
    digest: string,
  ): RefundAttempt | CommerceMutationResultV1 {
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (snapshot === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const reservation = planCancellationReservation(
      this.#options.database,
      command,
      snapshot.resources,
    );
    if (reservation.kind === "rejected")
      return this.#options.rejected(reservation.error);
    this.#options.reserveCancellation(
      command,
      merchant,
      reservation.value,
      digest,
    );
    return reservation.value.refundAttempt;
  }

  #resumeCancellation(
    command: CancelCommerceOrderV1,
    stored: StoredRefundAttempt,
    digest: string,
  ): RefundAttempt | CommerceMutationResultV1 {
    if (stored.commandDigest !== digest) {
      return this.#options.rejected({
        code: "idempotency_conflict",
        idempotencyKey: command.idempotencyKey,
      });
    }
    if (isTerminalCommerceState("refund_attempt", stored.attempt.lifecycle.state)) {
      throw new Error("Resolved refund attempt is missing its command receipt");
    }
    return stored.attempt;
  }

  #reserveNewRefund(
    command: RefundCommerceOrderV1,
    merchant: AfterSaleMerchantRow,
    digest: string,
  ): RefundAttempt | CommerceMutationResultV1 {
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (snapshot === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const reservation = planRefundReservation(
      this.#options.database,
      command,
      snapshot.resources,
    );
    if (reservation.kind === "rejected")
      return this.#options.rejected(reservation.error);
    this.#options.reserveRefund(command, merchant, reservation.value, digest);
    return reservation.value.refundAttempt;
  }

  #resumeRefund(
    command: RefundCommerceOrderV1,
    stored: StoredRefundAttempt,
    digest: string,
  ): RefundAttempt | CommerceMutationResultV1 {
    if (stored.commandDigest !== digest) {
      return this.#options.rejected({
        code: "idempotency_conflict",
        idempotencyKey: command.idempotencyKey,
      });
    }
    if (isTerminalCommerceState("refund_attempt", stored.attempt.lifecycle.state)) {
      throw new Error("Resolved refund attempt is missing its command receipt");
    }
    return stored.attempt;
  }
}

function refundReconciliationCommand(
  merchant: AfterSaleMerchantRow,
  attempt: RefundAttempt,
  resources: CommerceResourcesV1,
): RefundCommerceOrderV1 | undefined {
  if (attempt.reason.kind !== "order_refund") return undefined;
  const order = findResource(resources.orders, attempt.orderId);
  const payment = findResource(resources.payments, attempt.paymentId);
  if (order === undefined || payment === undefined) return undefined;
  return {
    schemaVersion: "underclerk.refund-order.v1",
    merchantId: merchant.merchantId,
    expectedMerchantRevision: merchant.revision,
    idempotencyKey: attempt.idempotencyIdentity,
    requestedAt: payment.occurredAt,
    orderId: order.id,
    orderRevision: order.revision,
    paymentId: payment.id,
    paymentRevision: payment.revision,
    refundAttemptId: attempt.refundAttemptId,
    refundPolicyId: attempt.reason.policyId,
    amount: refundAttemptMoney(attempt),
    allocation: attempt.allocation,
    reason: attempt.reason.reason,
  };
}

function planCancellationReservation(
  database: CommerceDatabase,
  command: CancelCommerceOrderV1,
  resources: CommerceResourcesV1,
): CancellationPlanResult<CancellationReservationPlan> {
  const order = findResource(resources.orders, command.orderId);
  const payment = findResource(resources.payments, command.paymentId);
  const fulfillment = findResource(
    resources.fulfillments,
    command.fulfillmentId,
  );
  const revisionError = firstRevisionError(
    command,
    order,
    payment,
    fulfillment,
  );
  if (revisionError !== undefined)
    return { kind: "rejected", error: revisionError };
  if (
    order === undefined ||
    payment === undefined ||
    fulfillment === undefined
  ) {
    throw new Error("Cancellation revision validation lost a resource");
  }
  const moveRefusal = firstRefusal(
    commerceTransition("order", order.lifecycle, "cancel"),
    commerceTransition("payment", payment.lifecycle, "request_refund"),
    ...(fulfillment.kind === "pickup"
      ? [commerceTransition("pickup_fulfillment", fulfillment.lifecycle, "cancel")]
      : fulfillment.kind === "shipping"
        ? [
            commerceTransition(
              "shipping_fulfillment",
              fulfillment.lifecycle,
              "cancel",
            ),
          ]
        : []),
  );
  if (moveRefusal !== undefined)
    return { kind: "rejected", error: moveRefusal };
  // A merchant plugin's guard can refuse the cancellation.
  const guarded = guardMove(database, command.merchantId, {
    machine: "order",
    event: "cancel",
    from: order.lifecycle.state,
    to: "cancelled",
    subject: orderSubject(order, fulfillment, resources.variants),
    at: command.requestedAt,
    attempt: command.idempotencyKey,
  });
  if (guarded !== undefined) return { kind: "rejected", error: guarded };
  if (
    !cancellationRelationshipsAreValid(command, order, payment, fulfillment)
  ) {
    return cancellationRejected("cancellation.lifecycle");
  }
  // An order on a company's terms is cancelled after the company paid.
  if (paymentAwaitsInvoice(database, command.merchantId, payment.id))
    return cancellationRejected("invoice.unpaid");
  const accepted = readAcceptedOrder(database, command.merchantId, order);
  if (
    !paymentIsRefundable(database, command.merchantId, order, payment) ||
    accepted === undefined ||
    !orderMatchesAccepted(order, accepted)
  ) {
    return cancellationRejected("cancellation.checkoutPayment");
  }
  // The cancellation refunds what is left of the named payment; the order's
  // other payments are refunded after it.
  const remaining = tenderPosition(
    database,
    command.merchantId,
    order.id,
    payment,
  )?.refundable;
  if (remaining === undefined || remaining.amountMinor === 0) {
    return cancellationRejected("cancellation.amount");
  }
  // Staff can cancel a made-to-order order until its preparation ends
  // (Refactor 15 decision 1); a completed ticket used its stock.
  const ticketPlan = planOrderTicketCancellation(
    database,
    command.merchantId,
    order.id,
    command.requestedAt,
  );
  if (ticketPlan.kind === "rejected") return ticketPlan;
  const allocationPlan = planOrderAllocationRelease(
    database,
    command,
    order,
    fulfillment.locationId,
    accepted,
  );
  if (allocationPlan.kind === "rejected") return allocationPlan;
  const allocation = allocateRefund(
    order,
    refundCeilings(database, command.merchantId, order),
    remaining,
  );
  if (allocation === undefined)
    return cancellationRejected("cancellation.allocation");
  const refundAttempt = buildRequestedRefundAttempt(
    command,
    order,
    payment,
    allocation,
  );
  return {
    kind: "planned",
    value: {
      order: cancelledOrder(command, order, refundAttempt),
      fulfillment: cancelledFulfillment(command, fulfillment),
      tickets: ticketPlan.tickets,
      allocations: allocationPlan.value.allocations,
      positions: allocationPlan.value.positions,
      refundAttempt,
    },
  };
}

function planCancellationRefundRequest(
  database: CommerceDatabase,
  command: CancelCommerceOrderV1,
  attempt: RefundAttempt,
  resources: CommerceResourcesV1,
): CancellationPlanResult<MerchantPaymentRefundCommand> {
  const order = findResource(resources.orders, command.orderId);
  const payment = findResource(resources.payments, command.paymentId);
  if (order === undefined) {
    return cancellationMissing("commerce_order", command.orderId);
  }
  if (payment === undefined)
    return cancellationMissing("payment", command.paymentId);
  const moveRefusal = cancellationMoveRefusal(
    order,
    payment,
    attempt,
    "ask_provider",
  );
  if (moveRefusal !== undefined)
    return { kind: "rejected", error: moveRefusal };
  if (!reservedCancellationMatches(command, order, payment, attempt)) {
    return cancellationRejected("cancellation.reservation");
  }
  const checkoutContext = readCapturedCheckoutContext(
    database,
    command.merchantId,
    order,
    payment,
  );
  if (
    checkoutContext === undefined ||
    !orderIsAccepted(database, command.merchantId, order) ||
    !sameMoney(checkoutContext.paymentAttempt.binding.amount, payment.amount)
  ) {
    return cancellationRejected("cancellation.paymentBinding");
  }
  return {
    kind: "planned",
    value: {
      merchantId: command.merchantId,
      providerRequestId:
        checkoutContext.paymentAttempt.binding.providerRequestId,
      paymentAttemptId: checkoutContext.paymentAttempt.paymentAttemptId,
      checkoutId: checkoutContext.checkout.checkoutId,
      orderId: order.id,
      refundAttemptId: attempt.refundAttemptId,
      idempotencyKey: attempt.idempotencyIdentity,
      money: payment.amount,
      refundMoney: refundAttemptMoney(attempt),
      paymentBinding: checkoutContext.paymentAttempt.binding.paymentBinding,
      providerPaymentReference:
        checkoutContext.paymentAttempt.lifecycle.providerPaymentReference,
      reason: command.reason,
    },
  };
}

function planRefundReservation(
  database: CommerceDatabase,
  command: RefundCommerceOrderV1,
  resources: CommerceResourcesV1,
): CancellationPlanResult<RefundReservationPlan> {
  const order = findResource(resources.orders, command.orderId);
  const payment = findResource(resources.payments, command.paymentId);
  const revisionError = firstRefundRevisionError(command, order, payment);
  if (revisionError !== undefined)
    return { kind: "rejected", error: revisionError };
  if (order === undefined || payment === undefined) {
    throw new Error("Refund revision validation lost a resource");
  }
  const moveRefusal = firstRefusal(
    commerceTransition("order", order.lifecycle, "refund"),
    commerceTransition("payment", payment.lifecycle, "request_refund"),
  );
  if (moveRefusal !== undefined)
    return { kind: "rejected", error: moveRefusal };
  // A merchant plugin's guard can refuse the refund.
  const guarded = guardMove(database, command.merchantId, {
    machine: "order",
    event: "refund",
    from: order.lifecycle.state,
    to: order.lifecycle.state,
    subject: {
      ...orderSubject(order, undefined, resources.variants),
      refundMinor: command.amount.amountMinor,
    },
    at: command.requestedAt,
    attempt: command.idempotencyKey,
  });
  if (guarded !== undefined) return { kind: "rejected", error: guarded };
  if (
    !refundRelationshipsAreValid(command, order, payment) ||
    !refundAllocationMatchesOrder(
      command.amount,
      command.allocation,
      order,
      refundCeilings(database, command.merchantId, order),
    )
  ) {
    return cancellationRejected("refund.relationships");
  }
  if (paymentAwaitsInvoice(database, command.merchantId, payment.id))
    return cancellationRejected("invoice.unpaid");
  if (
    !paymentIsRefundable(database, command.merchantId, order, payment) ||
    !orderIsAccepted(database, command.merchantId, order) ||
    // Store credit takes the place of a card refund, not of stored value.
    (command.destination === "store_credit" &&
      storedValueRedemption(database, command.merchantId, payment.id) !==
        undefined)
  ) {
    return cancellationRejected("refund.checkoutPayment");
  }
  if (
    !refundFits(
      tenderPosition(database, command.merchantId, order.id, payment),
      command.amount,
    )
  ) {
    return cancellationRejected("refund.amount");
  }
  const refundAttempt = buildRequestedOrderRefundAttempt(
    command,
    order,
    payment,
  );
  return {
    kind: "planned",
    value: {
      order: pendingRefundOrder(command, order, refundAttempt),
      refundAttempt,
    },
  };
}

function planRefundRequest(
  database: CommerceDatabase,
  command: RefundCommerceOrderV1,
  attempt: RefundAttempt,
  resources: CommerceResourcesV1,
): CancellationPlanResult<MerchantPaymentRefundCommand> {
  const order = findResource(resources.orders, command.orderId);
  const payment = findResource(resources.payments, command.paymentId);
  if (order === undefined)
    return cancellationMissing("commerce_order", command.orderId);
  if (payment === undefined)
    return cancellationMissing("payment", command.paymentId);
  const moveRefusal = firstRefusal(
    commerceTransition("payment", payment.lifecycle, "request_refund"),
    commerceTransition("refund_attempt", attempt.lifecycle, "ask_provider"),
  );
  if (moveRefusal !== undefined)
    return { kind: "rejected", error: moveRefusal };
  if (
    !reservedRefundMatches(
      command,
      order,
      payment,
      attempt,
      refundCeilings(database, command.merchantId, order),
    )
  ) {
    return cancellationRejected("refund.reservation");
  }
  const checkoutContext = readCapturedCheckoutContext(
    database,
    command.merchantId,
    order,
    payment,
  );
  if (
    checkoutContext === undefined ||
    !orderIsAccepted(database, command.merchantId, order) ||
    !sameMoney(checkoutContext.paymentAttempt.binding.amount, payment.amount)
  ) {
    return cancellationRejected("refund.paymentBinding");
  }
  return {
    kind: "planned",
    value: {
      merchantId: command.merchantId,
      providerRequestId:
        checkoutContext.paymentAttempt.binding.providerRequestId,
      paymentAttemptId: checkoutContext.paymentAttempt.paymentAttemptId,
      checkoutId: checkoutContext.checkout.checkoutId,
      orderId: order.id,
      refundAttemptId: attempt.refundAttemptId,
      idempotencyKey: attempt.idempotencyIdentity,
      money: payment.amount,
      refundMoney: refundAttemptMoney(attempt),
      paymentBinding: checkoutContext.paymentAttempt.binding.paymentBinding,
      providerPaymentReference:
        checkoutContext.paymentAttempt.lifecycle.providerPaymentReference,
      reason: command.reason,
    },
  };
}

function planRefundResolution(
  database: CommerceDatabase,
  command: RefundCommerceOrderV1,
  attempt: RefundAttempt,
  providerResult: CommercePaymentRefundResultV1,
  resources: CommerceResourcesV1,
  resolvedAt: string,
): CancellationPlanResult<RefundResolutionPlan> {
  const order = findResource(resources.orders, command.orderId);
  const payment = findResource(resources.payments, command.paymentId);
  if (order === undefined)
    return cancellationMissing("commerce_order", command.orderId);
  if (payment === undefined)
    return cancellationMissing("payment", command.paymentId);
  const moveRefusal = firstRefusal(
    commerceTransition("payment", payment.lifecycle, "request_refund"),
    commerceTransition(
      "refund_attempt",
      attempt.lifecycle,
      refundAttemptEvent(providerResult),
    ),
  );
  if (moveRefusal !== undefined)
    return { kind: "rejected", error: moveRefusal };
  if (
    !reservedRefundMatches(
      command,
      order,
      payment,
      attempt,
      refundCeilings(database, command.merchantId, order),
    )
  ) {
    return cancellationRejected("refund.resolution");
  }
  if (
    providerResult.kind === "refunded" &&
    !sameMoney(providerResult.money, refundAttemptMoney(attempt))
  ) {
    throw new Error("Payment provider returned a different refund amount");
  }
  const resolvedOrder = resolvedRefundOrder(
    order,
    attempt.refundAttemptId,
    refundAdjustmentStatus(providerResult),
    resolvedAt,
  );
  const resolvedAttempt = resolvedRefundAttempt(
    attempt,
    providerResult,
    resolvedAt,
  );
  switch (providerResult.kind) {
    case "refunded":
      return {
        kind: "planned",
        value: {
          kind: "refunded",
          order: resolvedOrder,
          payment: refundedPayment(payment, providerResult),
          refundAttempt: resolvedAttempt,
        },
      };
    case "processing":
      return {
        kind: "planned",
        value: {
          kind: "processing",
          order: resolvedOrder,
          refundAttempt: resolvedAttempt,
        },
      };
    case "rejected":
      return {
        kind: "planned",
        value: {
          kind: "rejected",
          order: resolvedOrder,
          refundAttempt: resolvedAttempt,
        },
      };
    case "indeterminate":
      return {
        kind: "planned",
        value: {
          kind: "indeterminate",
          order: resolvedOrder,
          refundAttempt: resolvedAttempt,
        },
      };
  }
}

function planCancellationResolution(
  command: CancelCommerceOrderV1,
  attempt: RefundAttempt,
  providerResult: CommercePaymentRefundResultV1,
  resources: CommerceResourcesV1,
  resolvedAt: string,
): CancellationPlanResult<CancellationResolutionPlan> {
  const order = findResource(resources.orders, command.orderId);
  const payment = findResource(resources.payments, command.paymentId);
  if (order === undefined)
    return cancellationMissing("commerce_order", command.orderId);
  if (payment === undefined)
    return cancellationMissing("payment", command.paymentId);
  const moveRefusal = cancellationMoveRefusal(
    order,
    payment,
    attempt,
    refundAttemptEvent(providerResult),
  );
  if (moveRefusal !== undefined)
    return { kind: "rejected", error: moveRefusal };
  if (!reservedCancellationMatches(command, order, payment, attempt)) {
    return cancellationRejected("cancellation.resolution");
  }
  if (
    providerResult.kind === "refunded" &&
    !sameMoney(providerResult.money, refundAttemptMoney(attempt))
  ) {
    throw new Error("Payment provider returned a different refund amount");
  }
  const status = refundAdjustmentStatus(providerResult);
  const resolvedOrder = resolvedCancellationOrder(
    order,
    attempt.refundAttemptId,
    status,
    resolvedAt,
  );
  const resolvedAttempt = resolvedRefundAttempt(
    attempt,
    providerResult,
    resolvedAt,
  );
  switch (providerResult.kind) {
    case "refunded":
      return {
        kind: "planned",
        value: {
          kind: "refunded",
          order: resolvedOrder,
          payment: refundedPayment(payment, providerResult),
          refundAttempt: resolvedAttempt,
        },
      };
    case "processing":
      return {
        kind: "planned",
        value: {
          kind: "processing",
          order: resolvedOrder,
          refundAttempt: resolvedAttempt,
        },
      };
    case "rejected":
      return {
        kind: "planned",
        value: {
          kind: "rejected",
          order: resolvedOrder,
          refundAttempt: resolvedAttempt,
        },
      };
    case "indeterminate":
      return {
        kind: "planned",
        value: {
          kind: "indeterminate",
          order: resolvedOrder,
          refundAttempt: resolvedAttempt,
        },
      };
  }
}

function firstRevisionError(
  command: CancelCommerceOrderV1,
  order: CommerceOrderV1 | undefined,
  payment: CommercePaymentV1 | undefined,
  fulfillment: CommerceFulfillmentV1 | undefined,
): CommerceMutationErrorV1 | undefined {
  const candidates = [
    revisionError(
      "commerce_order",
      command.orderId,
      command.orderRevision,
      order?.revision,
    ),
    revisionError(
      "payment",
      command.paymentId,
      command.paymentRevision,
      payment?.revision,
    ),
    revisionError(
      "fulfillment",
      command.fulfillmentId,
      command.fulfillmentRevision,
      fulfillment?.revision,
    ),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function revisionError(
  kind: string,
  id: string,
  expected: number,
  actual: number | undefined,
): CommerceMutationErrorV1 | undefined {
  if (actual === undefined) return { code: "resource_not_found", kind, id };
  return actual === expected
    ? undefined
    : { code: "stale_resource_revision", kind, id, expected, actual };
}

function firstRefundRevisionError(
  command: RefundCommerceOrderV1,
  order: CommerceOrderV1 | undefined,
  payment: CommercePaymentV1 | undefined,
): CommerceMutationErrorV1 | undefined {
  return (
    revisionError(
      "commerce_order",
      command.orderId,
      command.orderRevision,
      order?.revision,
    ) ??
    revisionError(
      "payment",
      command.paymentId,
      command.paymentRevision,
      payment?.revision,
    )
  );
}

function refundRelationshipsAreValid(
  command: RefundCommerceOrderV1,
  order: CommerceOrderV1,
  payment: CommercePaymentV1,
): boolean {
  // An order can hold more than one payment, so a refund is bounded by the
  // named payment. A cancelled order still refunds what its other payments
  // took; the order and payment machines decide the states.
  return (
    payment.orderId === order.id &&
    payment.amount.currency === order.totals.total.currency &&
    command.amount.currency === order.totals.total.currency &&
    command.amount.amountMinor > 0 &&
    command.amount.amountMinor <= payment.amount.amountMinor
  );
}

// Each part of a refund is bounded by the most that part of the order has
// been, so a refund after an edit can name a line the edit removed.
function refundAllocationMatchesOrder(
  amount: Money,
  allocation: RefundAllocation,
  order: CommerceOrderV1,
  ceilings: RefundCeilings,
): boolean {
  const currency = order.totals.total.currency;
  let lineTotal = 0;
  for (const line of allocation.lineAllocations) {
    const maximum = ceilings.lineTotals.get(line.orderLineId);
    if (
      maximum === undefined ||
      line.amount.currency !== currency ||
      line.amount.amountMinor > maximum
    ) {
      return false;
    }
    lineTotal = safeMoneySum(lineTotal, line.amount.amountMinor);
  }
  // A line refund already returns the tax that its price included, so tax
  // named on top would pay it back twice.
  if (order.totals.taxIncluded === true && allocation.taxAllocations.length > 0)
    return false;
  let taxTotal = 0;
  for (const tax of allocation.taxAllocations) {
    const maximum = ceilings.lineTaxes.get(tax.orderLineId);
    if (
      maximum === undefined ||
      tax.amount.currency !== currency ||
      tax.amount.amountMinor > maximum
    ) {
      return false;
    }
    taxTotal = safeMoneySum(taxTotal, tax.amount.amountMinor);
  }
  let dutyTotal = 0;
  for (const duty of allocation.dutyAllocations) {
    if (
      !ceilings.lineTotals.has(duty.orderLineId) ||
      duty.amount.currency !== amount.currency
    )
      return false;
    dutyTotal = safeMoneySum(dutyTotal, duty.amount.amountMinor);
  }
  if (
    allocation.shippingAllocation.currency !== amount.currency ||
    allocation.shippingAllocation.amountMinor >
      order.totals.shipping.amountMinor ||
    dutyTotal > order.totals.duty.amountMinor ||
    lineTotal > ceilings.subtotal ||
    taxTotal > ceilings.tax
  ) {
    return false;
  }
  return sameMoney(refundAllocationMoney(allocation), amount);
}

/**
 * Spreads a refund over the order: line amounts first, then line taxes,
 * duty and shipping. A refund of the whole order names every part in full.
 */
function allocateRefund(
  order: CommerceOrderV1,
  ceilings: RefundCeilings,
  amount: Money,
): RefundAllocation | undefined {
  let left = amount.amountMinor;
  const take = (available: number): number => {
    const taken = Math.min(left, Math.max(0, available));
    left -= taken;
    return taken;
  };
  const money = (amountMinor: number): Money => ({
    amountMinor,
    currency: amount.currency,
  });
  const lineAllocations = [];
  for (const line of order.lineItems) {
    const taken = take(ceilings.lineTotals.get(line.id) ?? 0);
    if (taken > 0) lineAllocations.push({ orderLineId: line.id, amount: money(taken) });
  }
  // A line refund already returns the tax that its price included.
  const taxAllocations = [];
  for (const line of order.totals.taxIncluded === true ? [] : order.lineItems) {
    const taken = take(ceilings.lineTaxes.get(line.id) ?? 0);
    if (taken > 0) taxAllocations.push({ orderLineId: line.id, amount: money(taken) });
  }
  const firstLine = order.lineItems[0];
  const duty = take(order.totals.duty.amountMinor);
  const dutyAllocations =
    duty > 0 && firstLine !== undefined
      ? [{ orderLineId: firstLine.id, amount: money(duty) }]
      : [];
  const shipping = take(order.totals.shipping.amountMinor);
  if (left !== 0 || (duty > 0 && firstLine === undefined)) return undefined;
  const allocation = {
    lineAllocations,
    taxAllocations,
    dutyAllocations,
    shippingAllocation: money(shipping),
  };
  return refundAllocationMatchesOrder(amount, allocation, order, ceilings)
    ? allocation
    : undefined;
}

function orderIsAccepted(
  database: CommerceDatabase,
  merchantId: string,
  order: CommerceOrderV1,
): boolean {
  const accepted = readAcceptedOrder(database, merchantId, order);
  return accepted !== undefined && orderMatchesAccepted(order, accepted);
}

function refundAllocationMoney(allocation: RefundAllocation): Money {
  const currency = allocation.shippingAllocation.currency;
  let amountMinor = allocation.shippingAllocation.amountMinor;
  for (const item of [
    ...allocation.lineAllocations,
    ...allocation.taxAllocations,
    ...allocation.dutyAllocations,
  ]) {
    if (item.amount.currency !== currency)
      throw new Error("Refund allocation currencies must match");
    amountMinor = safeMoneySum(amountMinor, item.amount.amountMinor);
  }
  return { amountMinor, currency };
}

function cancellationRelationshipsAreValid(
  command: CancelCommerceOrderV1,
  order: CommerceOrderV1,
  payment: CommercePaymentV1,
  fulfillment: CommerceFulfillmentV1,
): boolean {
  // The named payment is the order's first. An edited order may hold more
  // payments and earlier refunds; none of its refunds may still be pending.
  return (
    (payment.lifecycle.state !== "captured" ||
      timestampAtOrBefore(payment.lifecycle.capturedAt, command.requestedAt)) &&
    (fulfillment.kind === "pickup" || fulfillment.kind === "shipping") &&
    fulfillment.lifecycle.state === "requested" &&
    payment.orderId === order.id &&
    fulfillment.orderId === order.id &&
    payment.amount.currency === order.totals.total.currency &&
    payment.amount.amountMinor > 0 &&
    timestampAtOrBefore(
      fulfillment.lifecycle.requestedAt,
      command.requestedAt,
    ) &&
    order.adjustments.every(
      (adjustment) =>
        adjustment.kind === "refund" && adjustment.status !== "pending",
    ) &&
    order.lineItems.length > 0 &&
    order.lineItems.every(cancellableOrderLine) &&
    exactFulfillmentLines(order, fulfillment) &&
    supportedCancellationTotals(order)
  );
}

function cancellableOrderLine(
  line: CommerceOrderV1["lineItems"][number],
): boolean {
  return (
    (line.source.kind === "catalog" || line.source.kind === "food_service") &&
    line.fulfilledQuantity.amount === 0 &&
    line.fulfilledQuantity.scale === line.quantity.scale &&
    line.fulfilledQuantity.unit === line.quantity.unit
  );
}

function exactFulfillmentLines(
  order: CommerceOrderV1,
  fulfillment: CommerceFulfillmentV1,
): boolean {
  if (order.lineItems.length !== fulfillment.lineItems.length) return false;
  for (const orderLine of order.lineItems) {
    const matches = fulfillment.lineItems.filter(
      fulfillmentLineMatchesOrderLine.bind(undefined, orderLine),
    );
    if (matches.length !== 1) return false;
  }
  return true;
}

function fulfillmentLineMatchesOrderLine(
  orderLine: CommerceOrderV1["lineItems"][number],
  fulfillmentLine: CommerceFulfillmentV1["lineItems"][number],
): boolean {
  return (
    fulfillmentLine.lineItemId === orderLine.id &&
    orderLine.quantity.scale === 0 &&
    orderLine.quantity.unit === "each" &&
    fulfillmentLine.quantity === orderLine.quantity.amount
  );
}

function supportedCancellationTotals(order: CommerceOrderV1): boolean {
  const currency = order.totals.total.currency;
  const monies = [
    order.totals.subtotal,
    order.totals.discount,
    order.totals.tax,
    order.totals.duty,
    order.totals.shipping,
    order.totals.serviceFee,
    order.totals.tip,
    order.totals.rounding,
    order.totals.total,
  ];
  if (
    monies.some(moneyHasDifferentCurrency.bind(undefined, currency)) ||
    order.totals.total.amountMinor <= 0 ||
    order.totals.serviceFee.amountMinor !== 0 ||
    order.totals.tip.amountMinor !== 0 ||
    order.totals.rounding.amountMinor !== 0
  ) {
    return false;
  }
  let lineTotal = 0;
  let taxTotal = 0;
  for (const line of order.lineItems) {
    if (line.lineTotal.currency !== currency || line.tax.currency !== currency)
      return false;
    lineTotal = safeMoneySum(lineTotal, line.lineTotal.amountMinor);
    taxTotal = safeMoneySum(taxTotal, line.tax.amountMinor);
  }
  // Included tax is a part of the line totals, not an amount on top.
  const allocatedTotal = safeMoneySum(
    order.totals.taxIncluded === true
      ? lineTotal
      : safeMoneySum(lineTotal, taxTotal),
    safeMoneySum(
      order.totals.duty.amountMinor,
      order.totals.shipping.amountMinor,
    ),
  );
  return (
    lineTotal === order.totals.subtotal.amountMinor &&
    taxTotal === order.totals.tax.amountMinor &&
    allocatedTotal === order.totals.total.amountMinor
  );
}

function moneyHasDifferentCurrency(
  currency: string,
  money: Readonly<{ currency: string }>,
): boolean {
  return money.currency !== currency;
}

type AcceptedCheckout = Omit<Checkout, "lifecycle"> &
  Readonly<{
    lifecycle: VariantBy<Checkout["lifecycle"], "state", "accepted">;
  }>;

type CapturedPaymentAttempt = Omit<CheckoutPaymentAttempt, "lifecycle"> &
  Readonly<{
    lifecycle: VariantBy<
      CheckoutPaymentAttempt["lifecycle"],
      "state",
      "captured"
    >;
  }>;

type CapturedCheckoutContext = Readonly<{
  checkout: AcceptedCheckout;
  paymentAttempt: CapturedPaymentAttempt;
}>;

/**
 * A payment that a refund can return: a captured card payment of the
 * order's checkout or of a balance checkout, a stored-value payment that
 * redeemed its account for this order, or a manual payment of this order.
 */
function paymentIsRefundable(
  database: CommerceDatabase,
  merchantId: string,
  order: CommerceOrderV1,
  payment: CommercePaymentV1,
): boolean {
  const redemption = storedValueRedemption(database, merchantId, payment.id);
  if (redemption !== undefined)
    return (
      redemption.orderId === order.id &&
      redemption.amountMinor === payment.amount.amountMinor
    );
  const manual = readManualTender(database, merchantId, payment.id);
  if (manual !== undefined)
    return (
      manual.orderId === order.id &&
      manual.amountMinor === payment.amount.amountMinor &&
      manual.currency === payment.amount.currency
    );
  const checkoutContext = readCapturedCheckoutContext(
    database,
    merchantId,
    order,
    payment,
  );
  return (
    checkoutContext !== undefined &&
    sameMoney(checkoutContext.paymentAttempt.binding.amount, payment.amount) &&
    checkoutContext.checkout.lifecycle.paymentAttemptId ===
      checkoutContext.paymentAttempt.paymentAttemptId
  );
}

/**
 * The result of a refund that Commerce makes itself: to stored value, or
 * of a manual payment that staff return in cash or by bank transfer.
 */
function internalRefundResult(
  tender: "stored_value" | "manual",
  attempt: RefundAttempt,
  refundedAt: string,
): CommercePaymentRefundResultV1 {
  return {
    schemaVersion: "underclerk.payment-refund-result.v1",
    kind: "refunded",
    providerRefundReference: `${tender}_${attempt.refundAttemptId}`,
    money: refundAttemptMoney(attempt),
    refundedAt,
  };
}

function readCapturedCheckoutContext(
  database: CommerceDatabase,
  merchantId: string,
  order: CommerceOrderV1,
  payment: CommercePaymentV1,
): CapturedCheckoutContext | undefined {
  // Refund reads the captured Checkout behind a payment. The first payment's
  // Checkout is on the order origin, for both channels; only online pins a
  // storefront profile. A later payment came from a balance checkout that its
  // order change names.
  const change = readPaymentChange(database, merchantId, payment.id);
  const checkoutId =
    change === undefined
      ? orderOriginCheckoutId(order.origin)
      : change.checkoutId;
  if (checkoutId === undefined) return undefined;
  const checkout = readCheckout(database, merchantId, checkoutId);
  if (
    checkout === undefined ||
    !isAcceptedCheckout(checkout) ||
    checkout.lifecycle.orderId !== order.id ||
    (change === undefined
      ? !checkoutOrderMatchesCheckout(
          order.origin,
          checkout.checkoutId,
          checkoutProfileOf(checkout),
        )
      : change.orderId !== order.id ||
        balanceCheckoutOrder(checkout)?.orderId !== order.id)
  ) {
    return undefined;
  }
  if (checkout.lifecycle.paymentAttemptId === undefined) return undefined;
  const paymentAttempt = readCheckoutPaymentAttempt(
    database,
    merchantId,
    checkout.lifecycle.paymentAttemptId,
  );
  if (
    paymentAttempt === undefined ||
    !isCapturedPaymentAttempt(paymentAttempt) ||
    paymentAttempt.binding.checkoutId !== checkout.checkoutId ||
    paymentAttempt.binding.quoteDigest !==
      checkout.lifecycle.quote.quoteDigest ||
    !sameMoney(
      paymentAttempt.binding.amount,
      amountDue(checkout.lifecycle.quote),
    )
  ) {
    return undefined;
  }
  return { checkout, paymentAttempt };
}

function isAcceptedCheckout(checkout: Checkout): checkout is AcceptedCheckout {
  return checkout.lifecycle.state === "accepted";
}

function isCapturedPaymentAttempt(
  attempt: CheckoutPaymentAttempt,
): attempt is CapturedPaymentAttempt {
  return attempt.lifecycle.state === "captured";
}

type AllocationReleasePlan = Readonly<{
  allocations: readonly InventoryAllocation[];
  positions: readonly CommerceInventoryPositionV1[];
}>;

function planOrderAllocationRelease(
  database: CommerceDatabase,
  command: CancelCommerceOrderV1,
  order: CommerceOrderV1,
  fulfillmentLocationId: string,
  accepted: AcceptedOrder,
): CancellationPlanResult<AllocationReleasePlan> {
  const expectedAllocationIds = new Set<string>();
  for (const acceptedLine of accepted.lines) {
    if (findResource(order.lineItems, acceptedLine.orderLineId) === undefined)
      return cancellationRejected("cancellation.checkoutLines");
    for (const allocationId of acceptedLine.allocationIds) {
      if (expectedAllocationIds.has(allocationId)) {
        return cancellationRejected("cancellation.inventoryAllocations");
      }
      expectedAllocationIds.add(allocationId);
    }
  }
  if (accepted.lines.length !== order.lineItems.length) {
    return cancellationRejected("cancellation.checkoutLines");
  }
  // An edit releases the allocations of the lines it changed; the order still
  // holds only the ones its last change accepted.
  const ownedAllocations = listInventoryAllocations(
    database,
    command.merchantId,
  ).filter(
    (allocation) =>
      allocation.lifecycle.state === "allocated_to_order" &&
      allocation.lifecycle.orderId === order.id,
  );
  if (ownedAllocations.length !== expectedAllocationIds.size) {
    return cancellationRejected("cancellation.inventoryAllocations");
  }
  const allocations: InventoryAllocation[] = [];
  const positions = new Map<string, CommerceInventoryPositionV1>();
  for (const allocationId of expectedAllocationIds) {
    const allocation = readInventoryAllocation(
      database,
      command.merchantId,
      allocationId,
    );
    // A made-to-order line holds its stock until its ticket completes; the
    // ticket's cancellation (planned with this one) gives the stock back.
    if (
      allocation === undefined ||
      allocation.lifecycle.state !== "allocated_to_order" ||
      allocation.lifecycle.orderId !== order.id ||
      allocation.locationId !== fulfillmentLocationId ||
      (allocation.lifecycle.consumeOn !== "fulfillment_completed" &&
        allocation.lifecycle.consumeOn !== "preparation_completed")
    ) {
      return cancellationRejected("cancellation.inventoryAllocations");
    }
    const release = commerceTransition(
      "inventory_allocation",
      allocation.lifecycle,
      "release",
    );
    if (!release.allowed) return { kind: "rejected", error: release.refusal };
    const positionKey = inventoryPositionKey(allocation);
    const currentPosition =
      positions.get(positionKey) ??
      readInventoryPositionForItemLocation(
        database,
        command.merchantId,
        allocation.inventoryItemId,
        allocation.locationId,
      );
    if (
      currentPosition === undefined ||
      !isAccountedPosition(currentPosition) ||
      !accountedPositionCanRelease(currentPosition, allocation.quantity)
    ) {
      return cancellationRejected("cancellation.inventoryPosition");
    }
    const nextPosition = releasedInventoryPosition(
      currentPosition,
      allocation.quantity,
      command.requestedAt,
      positions.has(positionKey),
    );
    positions.set(positionKey, nextPosition);
    allocations.push(
      parseInventoryAllocation({
        allocationId: allocation.allocationId,
        inventoryItemId: allocation.inventoryItemId,
        locationId: allocation.locationId,
        quantity: allocation.quantity,
        revision: allocation.revision + 1,
        lifecycle: {
          state: release.to,
          demand: {
            kind: "order",
            orderId: allocation.lifecycle.orderId,
            orderLineId: allocation.lifecycle.orderLineId,
          },
          reason: "order_cancelled",
          releasedAt: command.requestedAt,
        },
      }),
    );
  }
  return {
    kind: "planned",
    value: { allocations, positions: [...positions.values()] },
  };
}

function cancelledOrder(
  command: CancelCommerceOrderV1,
  order: CommerceOrderV1,
  attempt: RefundAttempt,
): CommerceOrderV1 {
  const zero = { amountMinor: 0, currency: order.totals.total.currency };
  return parseOrder({
    id: order.id,
    revision: order.revision + 1,
    origin: order.origin,
    buyer: order.buyer,
    ...(order.market === undefined ? {} : { market: order.market }),
    lineItems: order.lineItems,
    totals: order.totals,
    adjustments: [
      ...order.adjustments,
      {
        id: cancellationAdjustmentId(attempt.refundAttemptId),
        kind: "cancellation",
        status: "completed",
        occurredAt: command.requestedAt,
        amount: zero,
        reason: command.reason,
      },
      {
        id: refundAdjustmentId(attempt.refundAttemptId),
        kind: "refund",
        status: "pending",
        occurredAt: command.requestedAt,
        amount: refundAttemptMoney(attempt),
        reason: command.reason,
      },
    ],
    lifecycle: {
      state: "cancelled",
      cancelledAt: command.requestedAt,
      reason: command.reason,
    },
    occurredAt: command.requestedAt,
  });
}

function pendingRefundOrder(
  command: RefundCommerceOrderV1,
  order: CommerceOrderV1,
  attempt: RefundAttempt,
): CommerceOrderV1 {
  return parseOrder({
    id: order.id,
    revision: order.revision + 1,
    origin: order.origin,
    buyer: order.buyer,
    ...(order.market === undefined ? {} : { market: order.market }),
    lineItems: order.lineItems,
    totals: order.totals,
    adjustments: [
      ...order.adjustments,
      {
        id: refundAdjustmentId(attempt.refundAttemptId),
        kind: "refund",
        status: "pending",
        occurredAt: command.requestedAt,
        amount: refundAttemptMoney(attempt),
        reason: command.reason,
      },
    ],
    lifecycle: order.lifecycle,
    occurredAt: command.requestedAt,
  });
}

function cancelledFulfillment(
  command: CancelCommerceOrderV1,
  fulfillment: CommerceFulfillmentV1,
): CommerceFulfillmentV1 {
  const base = {
    id: fulfillment.id,
    revision: fulfillment.revision + 1,
    orderId: fulfillment.orderId,
    lineItems: fulfillment.lineItems,
    locationId: fulfillment.locationId,
    expectedBy: fulfillment.expectedBy,
    lifecycle: {
      state: "cancelled" as const,
      cancelledAt: command.requestedAt,
      reason: command.reason,
    },
    occurredAt: command.requestedAt,
  };
  return fulfillment.kind === "shipping"
    ? parseFulfillment({
        ...base,
        kind: fulfillment.kind,
        binding: fulfillment.binding,
      })
    : parseFulfillment({ ...base, kind: fulfillment.kind });
}

function reservedCancellationMatches(
  command: CancelCommerceOrderV1,
  order: CommerceOrderV1,
  payment: CommercePaymentV1,
  attempt: RefundAttempt,
): boolean {
  if (
    payment.orderId !== order.id ||
    attempt.refundAttemptId !== command.refundAttemptId ||
    attempt.orderId !== order.id ||
    attempt.paymentId !== payment.id ||
    attempt.idempotencyIdentity !== command.refundAttemptId ||
    attempt.reason.kind !== "cancellation" ||
    attempt.reason.reason !== command.reason ||
    refundAttemptMoney(attempt).amountMinor > payment.amount.amountMinor
  ) {
    return false;
  }
  const cancellation = findAdjustment(
    order,
    cancellationAdjustmentId(attempt.refundAttemptId),
  );
  const refund = findAdjustment(
    order,
    refundAdjustmentId(attempt.refundAttemptId),
  );
  return (
    cancellation?.kind === "cancellation" &&
    cancellation.status === "completed" &&
    refund?.kind === "refund" &&
    refund.status === "pending" &&
    sameMoney(refund.amount, refundAttemptMoney(attempt))
  );
}

function reservedRefundMatches(
  command: RefundCommerceOrderV1,
  order: CommerceOrderV1,
  payment: CommercePaymentV1,
  attempt: RefundAttempt,
  ceilings: RefundCeilings,
): boolean {
  if (
    payment.orderId !== order.id ||
    attempt.refundAttemptId !== command.refundAttemptId ||
    attempt.orderId !== order.id ||
    attempt.paymentId !== payment.id ||
    attempt.idempotencyIdentity !== command.refundAttemptId ||
    attempt.reason.kind !== "order_refund" ||
    attempt.reason.policyId !== command.refundPolicyId ||
    attempt.reason.reason !== command.reason ||
    !sameMoney(refundAttemptMoney(attempt), command.amount) ||
    !refundAllocationMatchesOrder(
      command.amount,
      attempt.allocation,
      order,
      ceilings,
    )
  ) {
    return false;
  }
  const refund = findAdjustment(
    order,
    refundAdjustmentId(attempt.refundAttemptId),
  );
  return (
    refund?.kind === "refund" &&
    refund.status === "pending" &&
    sameMoney(refund.amount, command.amount)
  );
}

function resolvedCancellationOrder(
  order: CommerceOrderV1,
  refundAttemptId: string,
  status: CommerceOrderAdjustmentV1["status"],
  resolvedAt: string,
): CommerceOrderV1 {
  const adjustments: CommerceOrderAdjustmentV1[] = [];
  let found = false;
  for (const adjustment of order.adjustments) {
    if (adjustment.id === refundAdjustmentId(refundAttemptId)) {
      found = true;
      adjustments.push({
        id: adjustment.id,
        kind: adjustment.kind,
        status,
        occurredAt: adjustment.occurredAt,
        amount: adjustment.amount,
        reason: adjustment.reason,
      });
    } else {
      adjustments.push(adjustment);
    }
  }
  if (!found) throw new Error("Cancellation refund adjustment disappeared");
  return parseOrder({
    id: order.id,
    revision: order.revision + 1,
    origin: order.origin,
    buyer: order.buyer,
    ...(order.market === undefined ? {} : { market: order.market }),
    lineItems: order.lineItems,
    totals: order.totals,
    adjustments,
    lifecycle: order.lifecycle,
    occurredAt: resolvedAt,
  });
}

function resolvedRefundOrder(
  order: CommerceOrderV1,
  refundAttemptId: string,
  status: CommerceOrderAdjustmentV1["status"],
  resolvedAt: string,
): CommerceOrderV1 {
  return updateRefundAdjustment(order, refundAttemptId, status, resolvedAt);
}

function updateRefundAdjustment(
  order: CommerceOrderV1,
  refundAttemptId: string,
  status: CommerceOrderAdjustmentV1["status"],
  occurredAt: string,
): CommerceOrderV1 {
  const adjustments: CommerceOrderAdjustmentV1[] = [];
  let found = false;
  for (const adjustment of order.adjustments) {
    if (adjustment.id === refundAdjustmentId(refundAttemptId)) {
      found = true;
      adjustments.push({
        id: adjustment.id,
        kind: adjustment.kind,
        status,
        occurredAt: adjustment.occurredAt,
        amount: adjustment.amount,
        reason: adjustment.reason,
      });
    } else {
      adjustments.push(adjustment);
    }
  }
  if (!found) throw new Error("Refund adjustment disappeared");
  return parseOrder({
    id: order.id,
    revision: order.revision + 1,
    origin: order.origin,
    buyer: order.buyer,
    ...(order.market === undefined ? {} : { market: order.market }),
    lineItems: order.lineItems,
    totals: order.totals,
    adjustments,
    lifecycle: order.lifecycle,
    occurredAt,
  });
}

function inventoryPositionKey(allocation: InventoryAllocation): string {
  return `${allocation.inventoryItemId}\u0000${allocation.locationId}`;
}

function buildRequestedRefundAttempt(
  command: CancelCommerceOrderV1,
  order: CommerceOrderV1,
  payment: CommercePaymentV1,
  allocation: RefundAllocation,
): RefundAttempt {
  return parseRefundAttempt({
    refundAttemptId: command.refundAttemptId,
    orderId: order.id,
    paymentId: payment.id,
    revision: 1,
    reason: { kind: "cancellation", reason: command.reason },
    allocation,
    idempotencyIdentity: command.refundAttemptId,
    lifecycle: { state: "requested", requestedAt: command.requestedAt },
  });
}

function buildRequestedOrderRefundAttempt(
  command: RefundCommerceOrderV1,
  order: CommerceOrderV1,
  payment: CommercePaymentV1,
): RefundAttempt {
  return parseRefundAttempt({
    refundAttemptId: command.refundAttemptId,
    orderId: order.id,
    paymentId: payment.id,
    revision: 1,
    reason: {
      kind: "order_refund",
      policyId: command.refundPolicyId,
      reason: command.reason,
    },
    allocation: command.allocation,
    idempotencyIdentity: command.refundAttemptId,
    lifecycle: { state: "requested", requestedAt: command.requestedAt },
  });
}

function refundedPayment(
  payment: CommercePaymentV1,
  result: Variant<CommercePaymentRefundResultV1, "refunded">,
): CommercePaymentV1 {
  const refundedAmountMinor = safeMoneySum(
    payment.lifecycle.state === "partially_refunded"
      ? payment.lifecycle.refundedAmount.amountMinor
      : 0,
    result.money.amountMinor,
  );
  const move = commerceTransition(
    "payment",
    payment.lifecycle,
    refundedAmountMinor === payment.amount.amountMinor
      ? "refund_rest"
      : "refund_part",
  );
  if (!move.allowed)
    throw new Error("A resolved refund met a payment that cannot refund");
  const state = move.to;
  return parsePayment({
    id: payment.id,
    revision: payment.revision + 1,
    orderId: payment.orderId,
    amount: payment.amount,
    lifecycle: {
      state,
      refundedAt: result.refundedAt,
      refundedAmount: {
        amountMinor: refundedAmountMinor,
        currency: payment.amount.currency,
      },
    },
    occurredAt: result.refundedAt,
  });
}

function resolvedRefundAttempt(
  attempt: RefundAttempt,
  result: CommercePaymentRefundResultV1,
  resolvedAt: string,
): RefundAttempt {
  switch (result.kind) {
    case "refunded":
      return refundAttemptWithLifecycle(attempt, {
        state: "succeeded",
        providerRefundReference: result.providerRefundReference,
        refundedAt: result.refundedAt,
      });
    case "processing":
      return refundAttemptWithLifecycle(attempt, {
        state: "processing",
        reconciliationIdentity: result.reconciliationIdentity,
        reconcileAfter: result.reconcileAfter,
      });
    case "rejected":
      return refundAttemptWithLifecycle(attempt, {
        state: "failed",
        reason: result.reason,
        failedAt: resolvedAt,
      });
    case "indeterminate":
      return refundAttemptWithLifecycle(attempt, {
        state: "indeterminate",
        reconciliationIdentity: result.reconciliationIdentity,
        reconcileAfter: result.reconcileAfter,
      });
  }
}

function refundAttemptWithLifecycle(
  attempt: RefundAttempt,
  lifecycle: RefundAttemptLifecycle,
): RefundAttempt {
  return parseRefundAttempt({
    refundAttemptId: attempt.refundAttemptId,
    orderId: attempt.orderId,
    paymentId: attempt.paymentId,
    revision: attempt.revision + 1,
    reason: attempt.reason,
    allocation: attempt.allocation,
    idempotencyIdentity: attempt.idempotencyIdentity,
    lifecycle,
  });
}

/** The refund request, with what an earlier try of the attempt left. */
function withEarlierTry(
  request: MerchantPaymentRefundCommand,
  attempt: RefundAttempt,
): MerchantPaymentRefundCommand {
  switch (attempt.lifecycle.state) {
    case "processing":
      return {
        ...request,
        earlierTry: {
          kind: "processing",
          providerRefundReference: attempt.lifecycle.reconciliationIdentity,
        },
      };
    case "indeterminate":
      return { ...request, earlierTry: { kind: "unknown" } };
    default:
      return request;
  }
}

/** The refund attempt machine's event for a provider's answer. */
function refundAttemptEvent(
  result: CommercePaymentRefundResultV1,
): CommerceMachineEvent<"refund_attempt"> {
  switch (result.kind) {
    case "refunded":
      return "succeed";
    case "processing":
      return "report_processing";
    case "indeterminate":
      return "report_indeterminate";
    case "rejected":
      return "fail";
  }
}

/** The first move that a machine refuses, if one is refused. */
function firstRefusal(
  ...moves: readonly (
    | Readonly<{ allowed: true }>
    | Readonly<{ allowed: false; refusal: CommerceMutationErrorV1 }>
  )[]
): CommerceMutationErrorV1 | undefined {
  for (const move of moves) if (!move.allowed) return move.refusal;
  return undefined;
}

/** A cancellation's refund moves the cancelled order, its payment and the attempt. */
function cancellationMoveRefusal(
  order: CommerceOrderV1,
  payment: CommercePaymentV1,
  attempt: RefundAttempt,
  attemptEvent: CommerceMachineEvent<"refund_attempt">,
): CommerceMutationErrorV1 | undefined {
  return firstRefusal(
    commerceTransition("order", order.lifecycle, "resolve_cancellation"),
    commerceTransition("payment", payment.lifecycle, "request_refund"),
    commerceTransition("refund_attempt", attempt.lifecycle, attemptEvent),
  );
}

function refundAdjustmentStatus(
  result: CommercePaymentRefundResultV1,
): CommerceOrderAdjustmentV1["status"] {
  switch (result.kind) {
    case "refunded":
      return "completed";
    case "rejected":
      return "failed";
    case "processing":
    case "indeterminate":
      return "pending";
  }
}

function findAdjustment(
  order: CommerceOrderV1,
  adjustmentId: string,
): CommerceOrderAdjustmentV1 | undefined {
  for (const adjustment of order.adjustments) {
    if (adjustment.id === adjustmentId) return adjustment;
  }
  return undefined;
}

function cancellationAdjustmentId(refundAttemptId: string): string {
  return `cancellation_${refundAttemptId}`;
}

export function refundAdjustmentId(refundAttemptId: string): string {
  return `refund_${refundAttemptId}`;
}

function cancellationRejected(field: string): CancellationPlanResult<never> {
  return {
    kind: "rejected",
    error: { code: "resource_relationship_invalid", field },
  };
}

function cancellationMissing(
  kind: string,
  id: string,
): CancellationPlanResult<never> {
  return { kind: "rejected", error: { code: "resource_not_found", kind, id } };
}

function isMutationResult(
  value: RefundAttempt | CommerceMutationResultV1,
): value is CommerceMutationResultV1 {
  return "outcome" in value;
}
