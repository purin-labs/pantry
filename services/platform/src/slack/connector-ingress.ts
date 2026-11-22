import { actorPhysicalName } from "../actors/actor-registry";
import { actorStub } from "../actors/actor-stubs";
import type { ConnectorSlackIngressOutcome } from "../actors/connector-slack-ingress";
import type { CredentialVaultBindings } from "../credential-vault/keyring";
import type { RequestId } from "@purin-labs/kernel/ids";
import type { OrganisationPlacementBindings } from "@purin-labs/tenancy/organisation-execution-scope";
import { deriveSlackCaseRouteIdentities } from "./case-routing";
import type { SlackMessageEvent } from "./events";
import {
  resolveSlackIngressCredentialAtPlacement,
  type PendingSlackIngressCredential,
} from "./ingress-admission";
import type { ResolvedSlackThreadRoute } from "./organisation-routing";
import type { Env } from "@purin-labs/kernel/env";

/** What a Worker needs to hand a Slack message to its Connector. */
export type ConnectorSlackIngressBindings = OrganisationPlacementBindings &
  CredentialVaultBindings & {
    readonly CONNECTOR: Env["CONNECTOR"];
  };

/**
 * The Connector's decision on one Slack message, with the bot credential
 * that resolved beside it. An authorized decision and a decision that answers
 * the person use the credential. It never rejects.
 */
type ConnectorSlackDecision = {
  readonly outcome: ConnectorSlackIngressOutcome;
  readonly slackCredential: PendingSlackIngressCredential;
};

/**
 * Hand a routed Slack message to its Connector for admission and
 * acceptance. The Connector decides beside the organisation's records and
 * accepts the Case work in the same call.
 *
 * Null means that no Connector serves the published placement, or that the
 * Connector did not decide the message. The caller then decides the message
 * and activates a Connector. The platform Worker and the Slack ingress Worker
 * both make this call, so it lives in one place.
 */
export async function decideSlackCaseAtConnector(
  env: ConnectorSlackIngressBindings,
  event: SlackMessageEvent,
  requestId: RequestId,
  receivedAt: number,
  route: ResolvedSlackThreadRoute,
): Promise<ConnectorSlackDecision | null> {
  const placement = route.placement;
  // A credential held by another organisation keeps that organisation's
  // placement fence on the decision, which only the Worker path applies.
  if (
    placement === null ||
    route.credentialOrganisationId !== route.organisationId
  )
    return null;
  const identities = deriveSlackCaseRouteIdentities(
    route.integrationAccountId,
    event,
  );
  if (!identities.ok) return null;
  const connector = actorStub(
    env.CONNECTOR,
    actorPhysicalName(
      {
        objectKind: "connector",
        organisationId: route.organisationId,
        logicalObjectId: identities.value.connectorId,
      },
      placement,
    ),
    placement,
  );
  // The bot credential resolves while the Connector decides, so the progress
  // status can follow the acknowledgement at once.
  const slackCredential = resolveSlackIngressCredentialAtPlacement({
    env,
    keys: env,
    route,
    placement,
  });
  const admitted = await connector.admitSlackCaseWork({
    identity: {
      organisationId: route.organisationId,
      connectorId: identities.value.connectorId,
    },
    requestId,
    receivedAt,
    event,
    route: {
      installationId: route.installationId,
      connectionId: route.connectionId,
      organisationId: route.organisationId,
      integrationAccountId: route.integrationAccountId,
      caseId: route.caseId,
      routingSource: route.routingSource,
    },
  });
  return admitted.ok ? { outcome: admitted.value, slackCredential } : null;
}
