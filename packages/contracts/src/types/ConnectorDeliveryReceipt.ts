import type { ConnectorDeliveryId } from "./ConnectorDeliveryId";
import type { ConnectorId } from "./ConnectorId";
import type { IdempotencyKey } from "./IdempotencyKey";
import type { Timestamp } from "./Timestamp";

export type ConnectorDeliveryReceipt = {
  deliveryId: ConnectorDeliveryId;
  connectorId: ConnectorId;
  idempotencyKey: IdempotencyKey;
  nativeReceiptId: string;
  deliveredAt: Timestamp;
};
