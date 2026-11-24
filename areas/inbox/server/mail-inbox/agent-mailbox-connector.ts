import type { Env } from "@purin-labs/kernel/env";
import type { ConnectorActorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import type { Result } from "@purin-labs/kernel/result";
import { resolveActiveConnectorActor } from "@purin-labs/actor-runtime/actors/actor-router";
import {
  listEnabledMailboxAccounts,
  type MailboxIngressPolicy,
} from "../data/email-mailbox";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { gmailConnectorIdValue } from "@purin-labs/area-inbox-contract/server/connector-ids";
import { whatsappConnectorIdValue } from "../data/whatsapp";
import {
  newRequestId,
  parseConnectorId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
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

/** Resolves the active Connector of one mailbox or one WhatsApp number. */
async function activeConnector(
  env: Env,
  organisationId: OrganisationId,
  connectorIdValue: string,
  invalidCode: string,
): Promise<Result<AgentMailboxConnectorHandle, { readonly code: string }>> {
  const connectorId = parseConnectorId(connectorIdValue);
  if (!connectorId.ok) return { ok: false, error: { code: invalidCode } };
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

export function agentMailboxConnector(
  env: Env,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
): Promise<Result<AgentMailboxConnectorHandle, { readonly code: string }>> {
  return activeConnector(
    env,
    organisationId,
    gmailConnectorIdValue(integrationAccountId),
    "agent_mailbox_connector_invalid",
  );
}

export function whatsappConnector(
  env: Env,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
): Promise<Result<AgentMailboxConnectorHandle, { readonly code: string }>> {
  return activeConnector(
    env,
    organisationId,
    whatsappConnectorIdValue(integrationAccountId),
    "whatsapp_connector_invalid",
  );
}

/**
 * Wakes the waiting reply turns of each mailbox whose agent is on, after an
 * owner or admin accepted the terms of the mail model, and changes the card
 * of each wait. A mailbox that cannot be reached runs its turns at their
 * retry times.
 */
export async function wakeMailboxesAfterModelAcceptance(
  env: Env,
  scope: OrganisationExecutionScope,
  now: number,
): Promise<void> {
  const accounts = await listEnabledMailboxAccounts({
    db: scope.database,
    organisationId: scope.organisationId,
  });
  await Promise.all(
    accounts.map(async (account) => {
      const connector = await agentMailboxConnector(
        env,
        scope.organisationId,
        account,
      );
      const woken = connector.ok
        ? await connector.value.stub.wakeEmailReplyTurns({
            identity: connector.value.identity,
            now,
          })
        : connector;
      if (!woken.ok)
        traceWarn("inbox.mailbox_wake_failed", {
          requestId: newRequestId(),
          organisationId: scope.organisationId,
          code: woken.error.code,
        });
    }),
  );
}
