import type { CaseContent } from "./CaseContent";
import type { CaseId } from "./CaseId";
import type { ConnectorId } from "./ConnectorId";
import type { ConnectorIngressId } from "./ConnectorIngressId";
import type { ProviderDeliveryCursor } from "./ProviderDeliveryCursor";
import type { Timestamp } from "./Timestamp";

export type ConnectorIngress = {
  ingressId: ConnectorIngressId;
  connectorId: ConnectorId;
  nativeEventId: string;
  nativeCursor: ProviderDeliveryCursor;
  caseId: CaseId;
  content: CaseContent;
  receivedAt: Timestamp;
};
