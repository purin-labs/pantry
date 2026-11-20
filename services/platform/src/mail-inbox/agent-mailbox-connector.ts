import type { Env, ConnectorActorStub } from "../env";
import type { Result } from "../result";
import { resolveActiveConnectorActor } from "../actors/actor-router";
import { type MailboxIngressPolicy } from "../data/email-mailbox";
import { gmailConnectorIdValue } from "./contract/connector-ids";
import {
  parseConnectorId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../ids";
import type { Variant } from "@purin-labs/type-utils";

export function emailLimitsFromPolicy(
  policy: Variant<MailboxIngressPolicy, "enabled">,
): {
  readonly maxActiveCases: number;
  readonly maxMessagesPerHour: number;
  readonly dailyTokenBudget: number;
  readonly maxMessageBytes: number;
  readonly maxAttachmentBytes: number;
} {
  return {
    maxActiveCases: policy.maxActiveCases,
    maxMessagesPerHour: policy.maxMessagesPerHour,
    dailyTokenBudget: policy.dailyTokenBudget,
    maxMessageBytes: policy.maxMessageBytes,
    maxAttachmentBytes: policy.maxAttachmentBytes,
  };
}

export type AgentMailboxConnectorHandle = {
  readonly stub: ConnectorActorStub;
  readonly identity: {
    readonly organisationId: OrganisationId;
    readonly connectorId: string;
  };
};

export async function agentMailboxConnector(
  env: Env,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
): Promise<Result<AgentMailboxConnectorHandle, { readonly code: string }>> {
  const connectorId = parseConnectorId(
    gmailConnectorIdValue(integrationAccountId),
  );
  if (!connectorId.ok)
    return { ok: false, error: { code: "agent_mailbox_connector_invalid" } };
  const connector = await resolveActiveConnectorActor({
    env: env,
    namespace: env.CONNECTOR,
    organisationId,
    connectorId: connectorId.value,
    now: Date.now(),
  });
  return connector.ok
    ? {
        ok: true,
        value: {
          stub: connector.value,
          identity: { organisationId, connectorId: connectorId.value },
        },
      }
    : { ok: false, error: { code: connector.error.code } };
}
