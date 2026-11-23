import type { ConnectorIdentity } from "@purin-labs/contracts";
import { isNonBlankString, isPositiveInteger, isRecord } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";

import {
  parseCaseId,
  parseConnectorId,
  parseIntegrationAccountId,
  parseOrganisationId,
  parseSlackInstallationId,
  parseSlackOrganisationConnectionId,
  type RequestId,
} from "@purin-labs/kernel/ids";
import { parseSlackCaseEventEnvelope } from "../case-command-message";
import type { SlackMessageEvent } from "../events";
import type {
  SlackCaseIngressAdmission,
  SlackCaseIngressRoute,
} from "../ingress-admission";

/**
 * A verified Slack message whose admission its Connector decides. The Worker
 * supplies the signed event and the directory route. The Connector reads every
 * organisation record the decision depends on.
 */
type ConnectorSlackIngressRequest = {
  readonly identity: ConnectorIdentity;
  readonly requestId: RequestId;
  readonly receivedAt: number;
  readonly event: SlackMessageEvent;
  readonly route: SlackCaseIngressRoute;
};

export type ConnectorSlackIngressOutcome =
  | { readonly kind: "accepted" | "duplicate"; readonly eventId: string }
  | Variant<
      SlackCaseIngressAdmission,
      "identity_link_required" | "rejected" | "retry"
    >;

export function parseConnectorSlackIngressRequest(
  value: unknown,
): ConnectorSlackIngressRequest | null {
  if (
    !isRecord(value) ||
    !isRecord(value.identity) ||
    !isNonBlankString(value.identity.organisationId) ||
    !isNonBlankString(value.identity.connectorId)
  ) {
    return null;
  }
  const organisationId = parseOrganisationId(value.identity.organisationId);
  const connectorId = parseConnectorId(value.identity.connectorId);
  const envelope = parseSlackCaseEventEnvelope(value);
  const route = parseSlackCaseIngressRoute(value.route);
  if (
    !organisationId.ok ||
    !connectorId.ok ||
    !envelope.ok ||
    route === null ||
    route.organisationId !== organisationId.value
  ) {
    return null;
  }
  return {
    identity: {
      organisationId: organisationId.value,
      connectorId: connectorId.value,
    },
    requestId: envelope.value.requestId,
    receivedAt: envelope.value.receivedAt,
    event: envelope.value.event,
    route,
  };
}

function parseSlackCaseIngressRoute(
  value: unknown,
): SlackCaseIngressRoute | null {
  if (
    !isRecord(value) ||
    !isNonBlankString(value.installationId) ||
    !isNonBlankString(value.connectionId) ||
    !isNonBlankString(value.organisationId) ||
    !isNonBlankString(value.integrationAccountId) ||
    !isNonBlankString(value.caseId) ||
    !isRecord(value.routingSource) ||
    (value.routingSource.kind !== "channel_default" &&
      value.routingSource.kind !== "dm_selection") ||
    !isPositiveInteger(value.routingSource.revision)
  ) {
    return null;
  }
  const installationId = parseSlackInstallationId(value.installationId);
  const connectionId = parseSlackOrganisationConnectionId(value.connectionId);
  const organisationId = parseOrganisationId(value.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    value.integrationAccountId,
  );
  const caseId = parseCaseId(value.caseId);
  if (
    !installationId.ok ||
    !connectionId.ok ||
    !organisationId.ok ||
    !integrationAccountId.ok ||
    !caseId.ok
  ) {
    return null;
  }
  return {
    installationId: installationId.value,
    connectionId: connectionId.value,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    caseId: caseId.value,
    routingSource: {
      kind: value.routingSource.kind,
      revision: value.routingSource.revision,
    },
  };
}
