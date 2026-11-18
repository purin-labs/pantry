// The mutations of pickups, shipping labels and tracking, as the ledger
// commits them.
import { writeInventoryAllocation } from "../checkout-persistence.ts";
import {
  writeFulfillment,
  writeOrder,
  writeShipment,
} from "../commerce-persistence.ts";
import {
  insertSaleMovement,
  updateInventoryLot,
  updateInventoryPosition,
} from "../inventory-persistence.ts";
import { type ShippingLabelPurchaseResult } from "../shipping-gateway.ts";
import { writeShipmentLabelAttempt } from "../shipping-persistence.ts";
import { CustomerAuthority } from "../plugins/customers/index.ts";
import {
  type FulfillmentTrackingAttachmentPlan,
  type PickupCompletionPlan,
  type ShippingTrackingPlan,
} from "./fulfillment-planning.ts";
import { findPositionForMovement } from "./inventory-planning.ts";
import {
  fulfillmentObservation,
  inventoryPositionObservation,
  orderObservation,
  shipmentObservation,
} from "./observations.ts";
import {
  type AttachFulfillmentTrackingCommand,
  type CompleteCommercePickupV1,
  type MarkCommercePickupReadyV1,
  type PurchaseShippingLabelCommand,
  type RecordShippingTrackingCommand,
  type CommerceAggregateObservationV1,
  type CommerceFirstPartyShipmentV1,
  type CommerceFulfillmentV1,
  type CommerceShipmentLabelAttemptV1,
  parseShipment,
} from "@seams/commerce-client";
import { type ShipmentLabelRateSnapshot } from "@seams/commerce-contracts";
import {
  commandDigest,
  type CommerceMutation,
  type MerchantRow,
} from "./ledger.ts";

export function pickupReadyMutation(
  command: MarkCommercePickupReadyV1,
  merchant: MerchantRow,
  fulfillment: CommerceFulfillmentV1,
  committedAt: string,
  customers: CustomerAuthority,
): CommerceMutation {
  return {
    command,
    merchant,
    committedAt,
    commandKind: "mark_pickup_ready",
    resource: {
      kind: "fulfillment",
      id: fulfillment.id,
      revision: fulfillment.revision,
    },
    observations: [fulfillmentObservation(fulfillment)],
    write: (database) => {
      writeFulfillment(database, command.merchantId, fulfillment);
      customers.notifyOrderReady(
        command.merchantId,
        fulfillment.orderId,
        committedAt,
      );
    },
  };
}

export function pickupCompletionMutation(
  command: CompleteCommercePickupV1,
  merchant: MerchantRow,
  plan: PickupCompletionPlan,
  committedAt: string,
): CommerceMutation {
  const observations: CommerceAggregateObservationV1[] = [
    orderObservation(plan.order),
    fulfillmentObservation(plan.fulfillment),
  ];
  for (const movement of plan.movements) {
    observations.push({ kind: "inventory_movement", resource: movement });
  }
  for (const lot of plan.lots)
    observations.push({ kind: "inventory_lot", resource: lot });
  for (const position of plan.positions) {
    observations.push(inventoryPositionObservation(position));
  }
  return {
    command,
    merchant,
    committedAt,
    commandKind: "complete_pickup",
    resource: {
      kind: "fulfillment",
      id: plan.fulfillment.id,
      revision: plan.fulfillment.revision,
    },
    observations,
    write: (database) => {
      writeOrder(database, command.merchantId, plan.order);
      writeFulfillment(database, command.merchantId, plan.fulfillment);
      for (const allocation of plan.allocations) {
        writeInventoryAllocation(
          database,
          command.merchantId,
          "commit",
          allocation,
        );
      }
      for (const movement of plan.movements) {
        const position = findPositionForMovement(plan.positions, movement);
        insertSaleMovement(database, command.merchantId, position.id, movement);
      }
      for (const lot of plan.lots) {
        updateInventoryLot(database, command.merchantId, lot.revision - 1, lot);
      }
      for (const position of plan.positions) {
        updateInventoryPosition(
          database,
          command.merchantId,
          position.revision - 1,
          position,
        );
      }
    },
  };
}

export function shippingLabelMutation(
  command: PurchaseShippingLabelCommand,
  merchant: MerchantRow,
  shipment: CommerceFirstPartyShipmentV1,
  rate: ShipmentLabelRateSnapshot,
  purchase: ShippingLabelPurchaseResult,
): CommerceMutation {
  const committedAt = command.requestedAt;
  const attempt: CommerceShipmentLabelAttemptV1 = {
    labelAttemptId: command.labelAttemptId,
    shipmentId: command.shipmentId,
    shipmentRevision: command.shipmentRevision,
    labelRateId: rate.labelRateId,
    rateReference: rate.rateReference,
    packagePlanDigest: rate.packagePlanDigest,
    idempotencyKey: command.idempotencyKey,
    revision: 1,
    lifecycle: {
      state: "purchased",
      providerLabelReference: purchase.providerLabelReference,
      trackingNumber: purchase.trackingNumber,
      purchasedAt: command.requestedAt,
    },
  };
  const nextShipment = parseShipment({
    ...shipment,
    revision: shipment.revision + 1,
    lifecycle: {
      state: "label_purchased",
      labelAttemptId: command.labelAttemptId,
      trackingNumber: purchase.trackingNumber,
      purchasedAt: command.requestedAt,
    },
    occurredAt: command.requestedAt,
  });
  if (nextShipment.kind !== "first_party") {
    throw new Error("Shipping label parser returned another shipment branch");
  }
  return {
    command,
    merchant,
    committedAt,
    commandKind: "purchase_shipping_label",
    resource: {
      kind: "shipment",
      id: nextShipment.id,
      revision: nextShipment.revision,
    },
    observations: [shipmentObservation(nextShipment)],
    write: (database) => {
      writeShipment(database, command.merchantId, nextShipment);
      writeShipmentLabelAttempt(
        database,
        command.merchantId,
        attempt,
        commandDigest(command),
        committedAt,
      );
    },
  };
}

export function shippingTrackingMutation(
  command: RecordShippingTrackingCommand,
  merchant: MerchantRow,
  plan: ShippingTrackingPlan,
  customers: CustomerAuthority,
): CommerceMutation {
  const committedAt = command.requestedAt;
  const observations: CommerceAggregateObservationV1[] = [
    shipmentObservation(plan.shipment),
  ];
  if (plan.kind === "in_transit") {
    observations.push(fulfillmentObservation(plan.fulfillment));
  } else {
    observations.push(orderObservation(plan.order));
    for (const movement of plan.movements)
      observations.push({ kind: "inventory_movement", resource: movement });
    for (const lot of plan.lots)
      observations.push({ kind: "inventory_lot", resource: lot });
    for (const position of plan.positions)
      observations.push(inventoryPositionObservation(position));
  }
  return {
    command,
    merchant,
    committedAt,
    commandKind: "record_shipping_tracking",
    resource: {
      kind: "shipment",
      id: plan.shipment.id,
      revision: plan.shipment.revision,
    },
    observations,
    write: (database) => {
      writeShipment(database, command.merchantId, plan.shipment);
      if (plan.kind === "in_transit") {
        writeFulfillment(database, command.merchantId, plan.fulfillment);
        // The carrier's first scan is a handover too; one email per order.
        customers.notifyOrderShipped(
          command.merchantId,
          plan.fulfillment.orderId,
          committedAt,
        );
      } else {
        writeOrder(database, command.merchantId, plan.order);
        for (const allocation of plan.allocations)
          writeInventoryAllocation(
            database,
            command.merchantId,
            "commit",
            allocation,
          );
        for (const movement of plan.movements) {
          const position = findPositionForMovement(plan.positions, movement);
          insertSaleMovement(
            database,
            command.merchantId,
            position.id,
            movement,
          );
        }
        for (const lot of plan.lots)
          updateInventoryLot(
            database,
            command.merchantId,
            lot.revision - 1,
            lot,
          );
        for (const position of plan.positions)
          updateInventoryPosition(
            database,
            command.merchantId,
            position.revision - 1,
            position,
          );
      }
    },
  };
}

export function fulfillmentTrackingAttachmentMutation(
  command: AttachFulfillmentTrackingCommand,
  merchant: MerchantRow,
  plan: FulfillmentTrackingAttachmentPlan,
  customers: CustomerAuthority,
): CommerceMutation {
  const committedAt = command.requestedAt;
  return {
    command,
    merchant,
    committedAt,
    commandKind: "attach_fulfillment_tracking",
    resource: {
      kind: "fulfillment",
      id: plan.fulfillment.id,
      revision: plan.fulfillment.revision,
    },
    observations: [
      shipmentObservation(plan.shipment),
      fulfillmentObservation(plan.fulfillment),
    ],
    write: (database) => {
      writeShipment(database, command.merchantId, plan.shipment);
      writeFulfillment(database, command.merchantId, plan.fulfillment);
      customers.notifyOrderShipped(
        command.merchantId,
        plan.fulfillment.orderId,
        committedAt,
      );
    },
  };
}
