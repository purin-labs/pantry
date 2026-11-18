import type { CaseOutput } from "./CaseOutput";
import type { ConnectorDeliveryReceipt } from "./ConnectorDeliveryReceipt";

export type CaseOutputLifecycle =
  | { kind: "pending"; output: CaseOutput }
  | { kind: "settled"; output: CaseOutput; receipt: ConnectorDeliveryReceipt };
