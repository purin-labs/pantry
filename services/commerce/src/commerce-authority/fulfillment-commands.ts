import {
  parseAttachFulfillmentTrackingCommand,
  parseCompletePickupCommand,
  parseMarkPickupReadyCommand,
  parsePurchaseShippingLabelCommand,
  parseQuoteShipmentLabelRateCommand,
  parseRecordShippingTrackingCommand,
  type CompleteCommercePickupV1,
  type AttachFulfillmentTrackingCommand,
  type MarkCommercePickupReadyV1,
  type PurchaseShippingLabelCommand,
  type QuoteShipmentLabelRateCommand,
  type RecordShippingTrackingCommand,
  type ShipmentLabelRateResult,
  type CommerceFoodServiceResourcesV1,
  type CommerceFulfillmentV1,
  type CommerceMerchantSnapshotV1,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
  type CommerceFirstPartyShipmentV1,
} from "@seams/commerce-client";
import {
  commerceTransition,
  type ShipmentLabelRateSnapshot,
} from "@seams/commerce-contracts";
import type { CommerceDatabase } from "../database.ts";
import { digestOfCommand, type MerchantRow } from "./ledger.ts";
import {
  beginSnapshotCommand,
  type MerchantCommandPorts,
} from "./merchant-command.ts";
import {
  readShipmentLabelRate,
  readShipmentLabelRateByIdempotency,
  writeShipmentLabelRate,
} from "../shipping-persistence.ts";
import type {
  ShippingGateway,
  ShippingLabelPurchaseResult,
} from "../shipping-gateway.ts";
import {
  planFulfillmentTrackingAttachment,
  planPickupCompletion,
  planPickupReady,
  planShipmentLabelRate,
  planShippingTracking,
  resolveShipmentShippingRoute,
  type PickupCompletionPlan,
  type FulfillmentTrackingAttachmentPlan,
  type ShippingTrackingPlan,
} from "./fulfillment-planning.ts";
import { guardMove } from "../plugins/machine-guards.ts";

type FulfillmentMutationCommand =
  | MarkCommercePickupReadyV1
  | CompleteCommercePickupV1
  | PurchaseShippingLabelCommand
  | AttachFulfillmentTrackingCommand
  | RecordShippingTrackingCommand;

type FulfillmentCommandAuthorityOptions =
  MerchantCommandPorts<FulfillmentMutationCommand> &
    Readonly<{
      database: CommerceDatabase;
      readSnapshot: (
        merchantId: string,
      ) => CommerceMerchantSnapshotV1 | undefined;
      readFoodServiceResources: (
        merchantId: string,
      ) => CommerceFoodServiceResourcesV1;
      commitPickupReady: (
        command: MarkCommercePickupReadyV1,
        merchant: MerchantRow,
        fulfillment: CommerceFulfillmentV1,
      ) => CommerceMutationResultV1;
      commitPickupCompletion: (
        command: CompleteCommercePickupV1,
        merchant: MerchantRow,
        plan: PickupCompletionPlan,
      ) => CommerceMutationResultV1;
      commitShippingLabel: (
        command: PurchaseShippingLabelCommand,
        merchant: MerchantRow,
        shipment: CommerceFirstPartyShipmentV1,
        rate: ShipmentLabelRateSnapshot,
        purchase: ShippingLabelPurchaseResult,
      ) => CommerceMutationResultV1;
      commitShippingTracking: (
        command: RecordShippingTrackingCommand,
        merchant: MerchantRow,
        plan: ShippingTrackingPlan,
      ) => CommerceMutationResultV1;
      commitFulfillmentTrackingAttachment: (
        command: AttachFulfillmentTrackingCommand,
        merchant: MerchantRow,
        plan: FulfillmentTrackingAttachmentPlan,
      ) => CommerceMutationResultV1;
      quoteLabelRate: ShippingGateway["quoteLabelRate"];
      purchaseLabel: ShippingGateway["purchaseLabel"];
      verifyTrackingEvent: ShippingGateway["verifyTrackingEvent"];
    }>;

export class FulfillmentCommandAuthority {
  readonly #options: FulfillmentCommandAuthorityOptions;

  constructor(options: FulfillmentCommandAuthorityOptions) {
    this.#options = options;
  }

  markPickupReady(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parseMarkPickupReadyCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot } = start;
    const plan = planPickupReady(
      command,
      snapshot.resources,
      this.#options.readFoodServiceResources(command.merchantId),
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    // A merchant plugin's guard can refuse to mark the pickup ready.
    const guarded = guardMove(
      this.#options.database,
      command.merchantId,
      plan.move,
    );
    if (guarded !== undefined) return this.#options.rejected(guarded);
    return this.#options.commitPickupReady(command, merchant, plan.fulfillment);
  }

  completePickup(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parseCompletePickupCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot } = start;
    const plan = planPickupCompletion(
      this.#options.database,
      command,
      snapshot.resources,
      this.#options.readFoodServiceResources(command.merchantId),
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commitPickupCompletion(command, merchant, plan.value);
  }

  quoteShipmentLabelRate(
    rawCommand: unknown,
  ):
    | ShipmentLabelRateResult
    | Readonly<{ outcome: "rejected"; error: CommerceMutationErrorV1 }> {
    let command: QuoteShipmentLabelRateCommand;
    try {
      command = parseQuoteShipmentLabelRateCommand(rawCommand);
    } catch (error) {
      return {
        outcome: "rejected",
        error: this.#options.invalidCommand(error),
      };
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return { outcome: "rejected", error: merchantError };
    const replay = readShipmentLabelRateByIdempotency(
      this.#options.database,
      command.merchantId,
      command.idempotencyKey,
    );
    if (replay !== undefined) {
      return replay.commandDigest === digestOfCommand(command)
        ? {
            schemaVersion: "underclerk.shipment-label-rate-result.v1",
            outcome: "replayed",
            rate: replay.rate,
          }
        : {
            outcome: "rejected",
            error: {
              code: "idempotency_conflict",
              idempotencyKey: command.idempotencyKey,
            },
          };
    }
    if (merchant === undefined)
      return {
        outcome: "rejected",
        error: { code: "merchant_not_found", merchantId: command.merchantId },
      };
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (snapshot === undefined)
      return {
        outcome: "rejected",
        error: { code: "merchant_not_found", merchantId: command.merchantId },
      };
    const plan = planShipmentLabelRate(
      this.#options.database,
      command,
      snapshot.resources,
    );
    if (plan.kind === "rejected")
      return { outcome: "rejected", error: plan.error };
    const quote = this.#options.quoteLabelRate(plan.request);
    if (quote.kind === "unavailable_route") {
      return {
        outcome: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "shipment.shippingRoute",
        },
      };
    }
    writeShipmentLabelRate(
      this.#options.database,
      command.merchantId,
      quote.rate,
      command.idempotencyKey,
      digestOfCommand(command),
      command.requestedAt,
    );
    return {
      schemaVersion: "underclerk.shipment-label-rate-result.v1",
      outcome: "quoted",
      rate: quote.rate,
    };
  }

  purchaseShippingLabel(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parsePurchaseShippingLabelCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot } = start;
    const shipment = snapshot.resources.shipments.find(
      (candidate) => candidate.id === command.shipmentId,
    );
    const rate = readShipmentLabelRate(
      this.#options.database,
      command.merchantId,
      command.labelRateId,
    );
    if (shipment?.kind === "first_party") {
      const purchase = commerceTransition(
        "shipment",
        shipment.lifecycle,
        "purchase_label",
      );
      if (!purchase.allowed) return this.#options.rejected(purchase.refusal);
    }
    if (
      shipment?.kind !== "first_party" ||
      shipment.revision !== command.shipmentRevision ||
      rate === undefined ||
      rate.shipmentId !== command.shipmentId ||
      rate.shipmentRevision !== command.shipmentRevision ||
      Date.parse(rate.expiresAt) <= Date.parse(command.requestedAt)
    ) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "shipment.labelRate",
      });
    }
    const route = resolveShipmentShippingRoute(
      this.#options.database,
      command.merchantId,
      snapshot.resources,
      shipment,
    );
    if (
      route.kind === "rejected" ||
      rate.providerAccountReference !==
        route.value.acceptedCarrierRate.providerAccountReference ||
      rate.service.code !== route.value.acceptedCarrierRate.service.code ||
      rate.service.name !== route.value.acceptedCarrierRate.service.name ||
      rate.packagePlanDigest !== route.value.packagePlanDigest
    ) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "shipment.shippingRoute",
      });
    }
    const purchase = this.#options.purchaseLabel({
      routeBinding: route.value.routeBinding,
      shipmentId: command.shipmentId,
      serviceCode: rate.service.code,
      labelAttemptId: command.labelAttemptId,
      rateReference: rate.rateReference,
      purchasedAt: command.requestedAt,
    });
    return this.#options.commitShippingLabel(
      command,
      merchant,
      shipment,
      rate,
      purchase,
    );
  }

  recordShippingTracking(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parseRecordShippingTrackingCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot } = start;
    const shipment = snapshot.resources.shipments.find(
      (candidate) => candidate.id === command.shipmentId,
    );
    if (
      shipment?.kind !== "first_party" ||
      shipment.revision !== command.shipmentRevision
    ) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "shipment.tracking",
      });
    }
    const route = resolveShipmentShippingRoute(
      this.#options.database,
      command.merchantId,
      snapshot.resources,
      shipment,
    );
    if (route.kind === "rejected") return this.#options.rejected(route.error);
    if (
      !this.#options.verifyTrackingEvent({
        routeBinding: route.value.routeBinding,
        shipmentId: command.shipmentId,
        serviceCode: route.value.acceptedCarrierRate.service.code,
        state: command.event.state,
        providerEventId: command.event.providerEventId,
        occurredAt: command.event.occurredAt,
        location: command.event.location,
        signature: command.event.signature,
      })
    ) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "shipment.tracking",
      });
    }
    const plan = planShippingTracking(
      this.#options.database,
      command,
      snapshot.resources,
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commitShippingTracking(command, merchant, plan.value);
  }

  attachFulfillmentTracking(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parseAttachFulfillmentTrackingCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot } = start;
    const plan = planFulfillmentTrackingAttachment(command, snapshot.resources);
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commitFulfillmentTrackingAttachment(
      command,
      merchant,
      plan.value,
    );
  }
}
