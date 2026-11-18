import type { CaseContributionSource } from "./CaseContributionSource";
import type { CaseEntryId } from "./CaseEntryId";
import type { CaseOutputId } from "./CaseOutputId";
import type { ConnectorDelivery } from "./ConnectorDelivery";
import type { ConnectorId } from "./ConnectorId";

export type CaseOutput = {
  outputId: CaseOutputId;
  source: CaseContributionSource;
  entryId: CaseEntryId;
  connectorId: ConnectorId;
  delivery: ConnectorDelivery;
};
