import type { CaseBindingId } from "./CaseBindingId";
import type { CaseContent } from "./CaseContent";
import type { CaseId } from "./CaseId";
import type { CaseRevision } from "./CaseRevision";
import type { ConnectorAddress } from "./ConnectorAddress";
import type { ConnectorDeliveryId } from "./ConnectorDeliveryId";
import type { IdempotencyKey } from "./IdempotencyKey";
import type { Timestamp } from "./Timestamp";

export type ConnectorDelivery = {
  deliveryId: ConnectorDeliveryId;
  bindingId: CaseBindingId;
  address: ConnectorAddress;
  caseId: CaseId;
  caseRevision: CaseRevision;
  content: CaseContent;
  idempotencyKey: IdempotencyKey;
  addressedAt: Timestamp;
};
