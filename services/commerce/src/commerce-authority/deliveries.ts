import {
  parseCommerceDelivery,
  type AcknowledgeCommerceDeliveryV1,
  type CommerceDeliveryV1,
  type CommerceDeliveryAcknowledgementV1,
} from "@purin-labs/commerce-client";

export type StoredDeliveryRow = Readonly<{ deliveryJson: string }>;

export type DeliveryStatusRow = Readonly<{
  organisationId: string;
  status: string;
  deliveredAt: string | null;
  rejectedAt: string | null;
}>;

export type DeliveryOutboxTable = "observation_outbox";

/**
 * A delivery already settled — delivered or rejected — replays its recorded
 * outcome regardless of what the retry asked for, so an acknowledge and a
 * rejection cannot race each other into disagreement.
 */
export function deliverySettlement(
  command: AcknowledgeCommerceDeliveryV1,
  row: DeliveryStatusRow,
): CommerceDeliveryAcknowledgementV1 | undefined {
  if (row.status === "delivered") {
    if (row.deliveredAt === null)
      throw new Error("Delivered observation is missing its timestamp");
    return deliveryAcknowledgement(
      command,
      "already_acknowledged",
      row.deliveredAt,
    );
  }
  if (row.status === "rejected") {
    if (row.rejectedAt === null)
      throw new Error("Rejected observation is missing its timestamp");
    return deliveryAcknowledgement(command, "already_rejected", row.rejectedAt);
  }
  return undefined;
}

export function deliveryAcknowledgement(
  command: AcknowledgeCommerceDeliveryV1,
  outcome: CommerceDeliveryAcknowledgementV1["outcome"],
  acknowledgedAt: string,
): CommerceDeliveryAcknowledgementV1 {
  return {
    schemaVersion: "underclerk.delivery-acknowledgement.v2",
    outcome,
    merchantId: command.merchantId,
    deliveryId: command.deliveryId,
    acknowledgedAt,
  };
}

export function parseStoredDelivery(
  row: StoredDeliveryRow,
): CommerceDeliveryV1 {
  const value: unknown = JSON.parse(row.deliveryJson);
  return parseCommerceDelivery(value);
}
