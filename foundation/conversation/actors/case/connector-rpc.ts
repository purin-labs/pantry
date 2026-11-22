import type {
  ConnectorDeliveryResult,
  ConnectorResult,
} from "../connector/types";

/**
 * The Connector RPC methods that a Case walk calls. `ConnectorDO`, the class
 * of the Worker, implements them; the Case code names this interface and not
 * the class.
 */
export type CaseConnectorRpc = Readonly<{
  acceptIngress(raw: unknown): Promise<
    ConnectorResult<{
      readonly kind: "accepted" | "duplicate";
      readonly caseId: string;
    }>
  >;
  deliver(raw: unknown): Promise<ConnectorResult<ConnectorDeliveryResult>>;
}>;
