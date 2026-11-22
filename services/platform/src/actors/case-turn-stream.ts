import type { ConnectorIdentity } from "@purin-labs/contracts";
import type { VariantBy } from "@purin-labs/type-utils";
import type {
  ChannelId,
  OrganisationId,
  RequestId,
  SessionId,
  WorkspaceId,
} from "@purin-labs/kernel/ids";
import type { SerializedFlowBinding } from "../policy/information-flow";
import type { SessionActorRoute } from "./actor-router";
import type { EmbeddedHarnessTurnError } from "./embedded-harness";

// The stream of an ongoing Case turn into its thread: what the Case walk
// gives the Connector, and the ids of the turn. The Slack channel of the
// Connector streams it (`connector-slack-stream.ts`).

/** The turn id of an ongoing Case turn, from its ingress. */
export function slackCaseTurnId(ingressId: string): string {
  return `turn_${ingressId}`;
}

/** The stream id of an ongoing Case turn, from its ingress. */
export function slackCaseStreamId(ingressId: string): string {
  return `stream_${slackCaseTurnId(ingressId)}`;
}

/** The idempotency key of the output of an ongoing Case turn. */
export function slackCaseOutputIdempotencyKey(ingressId: string): string {
  return `case_output_proposal_${ingressId}_entry_${ingressId}`;
}

export type ConnectorCaseTurnStreamInput = {
  readonly identity: ConnectorIdentity;
  readonly requestId: RequestId;
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
  readonly sessionRoute: SessionActorRoute;
  readonly turnId: string;
  readonly streamId: string;
  readonly expectedIdempotencyKey: string;
  readonly target: {
    readonly workspaceId: WorkspaceId;
    readonly channelId: ChannelId;
    readonly threadTs: string;
    /** The Slack user that the answer replies to. Slack streams need it. */
    readonly recipientUserId: string;
  };
  readonly receivedAt: number;
};

/**
 * The walking path's check of the turn's current flow binding against the
 * thread, with live delivery authority. `unavailable` means that the check
 * could not run now; it releases nothing and denies nothing.
 */
export type ConnectorCaseStreamRelease = (
  binding: SerializedFlowBinding,
) => Promise<"allow" | "deny" | "unavailable">;

export type ConnectorCaseTurnStreamResult = {
  readonly finalMessage: string;
  readonly canonicalMessage: string;
};

export type ConnectorCaseTurnStreamError =
  | {
      readonly kind: "history_corruption";
      readonly code: VariantBy<
        EmbeddedHarnessTurnError,
        "code",
        "embedded_harness_history_failed"
      >["code"];
    }
  | { readonly kind: "operational"; readonly code: string };
