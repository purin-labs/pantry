import type { PlacedActorRpc } from "@purin-labs/actor-runtime/actors/actor-stubs";
import type {
  ConnectorDeliveryResult,
  ConnectorResult,
} from "@purin-labs/conversation/actors/connector/types";
import type { SlackSideCaseStartOutcome } from "./connector-side-case";
import type { SlackSideCaseParked } from "./connector-slack-case-work";
import type { ConnectorSlackIngressOutcome } from "./connector-slack-ingress";

/**
 * The RPC methods of a Slack Connector Actor that the Slack surface calls:
 * the ingress of an event, the release of a held output or a permission, and
 * the side Case of a thread. Each method parses its own request.
 * `ConnectorDO`, the class of the Worker, implements this interface, and the
 * surface names it, not the class.
 */
export interface SlackConnectorRpc {
  acceptCaseWork(raw: unknown): Promise<
    ConnectorResult<{
      readonly kind: "accepted" | "duplicate";
      readonly eventId: string;
    }>
  >;
  admitSlackCaseWork(
    raw: unknown,
  ): Promise<ConnectorResult<ConnectorSlackIngressOutcome>>;
  releaseSlackPermission(
    raw: unknown,
  ): Promise<ConnectorResult<{ readonly kind: "allowed" | "denied" }>>;
  deliverApprovedOutput(
    raw: unknown,
  ): Promise<ConnectorResult<ConnectorDeliveryResult>>;
  parkSlackSideCase(
    raw: unknown,
  ): Promise<ConnectorResult<SlackSideCaseParked>>;
  postSlackSideCaseProposal(
    raw: unknown,
  ): Promise<ConnectorResult<{ readonly posted: boolean }>>;
  startSlackSideCase(
    raw: unknown,
  ): Promise<ConnectorResult<SlackSideCaseStartOutcome>>;
}

/** The Connector Actor as the Slack surface calls it. */
export type SlackConnectorActor = PlacedActorRpc & SlackConnectorRpc;
