import type { CaseBindingId } from "./CaseBindingId";
import type { CaseId } from "./CaseId";
import type { ConnectorAddress } from "./ConnectorAddress";
import type { ConnectorId } from "./ConnectorId";

export type CaseBinding = {
  bindingId: CaseBindingId;
  caseId: CaseId;
  connectorId: ConnectorId;
  address: ConnectorAddress;
};
