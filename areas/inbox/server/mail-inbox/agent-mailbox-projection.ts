import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Env } from "@purin-labs/kernel/env";
import { resolveActiveConnectorActorAtScope } from "@purin-labs/actor-runtime/actors/actor-router";
import {
  readAgentMailboxBinding,
  readEmailMailboxAccount,
  readMailboxIngressPolicy,
} from "../data/email-mailbox";
import { gmailConnectorIdValue } from "@purin-labs/area-inbox-contract/server/connector-ids";
import { resolveIntegrationAccount } from "@purin-labs/connections/data/integration-account";
import type { MailboxSetupModel } from "@purin-labs/control-api";
import { readGmailModelState } from "./gmail-model-consent";
import {
  parseConnectorId,
  type IntegrationAccountId,
} from "@purin-labs/kernel/ids";

export async function readAgentMailboxProjection(
  env: Env,
  scope: OrganisationExecutionScope,
  integrationAccountId: IntegrationAccountId,
): Promise<Record<string, unknown> | null> {
  const target = {
    db: scope.database,
    organisationId: scope.organisationId,
    integrationAccountId,
  };
  // The three records are read by the same key and decide nothing together.
  const [mailbox, account, binding] = await Promise.all([
    readEmailMailboxAccount(target),
    resolveIntegrationAccount(target),
    readAgentMailboxBinding(target),
  ]);
  if (!mailbox.ok || !account.ok) return null;
  // The Connector is addressed only for a mailbox that is connected.
  const [policy, runtime, model] = await Promise.all([
    readMailboxIngressPolicy({
      ...target,
      connectedAt: account.value.createdAt,
    }),
    readAgentMailboxRuntime(env, scope, integrationAccountId),
    readGmailModelState({ env, scope, now: Date.now() }),
  ]);
  return {
    integration_account_id: integrationAccountId,
    environment: mailbox.value.environment,
    observed_address: mailbox.value.observedAddress,
    address_observed_at: mailbox.value.addressObservedAt,
    connection_lifecycle: account.value.lifecycle.kind,
    binding: binding.ok
      ? {
          mailbox_binding_id: binding.value.binding.mailboxBindingId,
          current_revision: binding.value.binding.currentRevision,
          installation_id: binding.value.currentRevision.installationId,
          response_policy: binding.value.currentRevision.responsePolicy,
        }
      : null,
    policy,
    runtime,
    model: modelProjection(model),
  };
}

/**
 * Whether new mail may go to the workspace's model. New mail waits while an
 * acceptance is needed or Purin has not reviewed the model.
 */
function modelProjection(model: MailboxSetupModel): Record<string, unknown> {
  switch (model.kind) {
    case "approved":
    case "consent_needed":
      return { kind: model.kind, name: model.review.name };
    case "not_reviewed":
      return { kind: model.kind, name: model.name };
    case "unavailable":
      return { kind: model.kind };
  }
}

/**
 * Live processing status is best-effort decoration on the durable projection:
 * a Connector that cannot be reached leaves the mailbox visible with
 * runtime null rather than failing the whole read.
 */
async function readAgentMailboxRuntime(
  env: Env,
  scope: OrganisationExecutionScope,
  integrationAccountId: IntegrationAccountId,
): Promise<Record<string, unknown> | null> {
  const connectorId = parseConnectorId(
    gmailConnectorIdValue(integrationAccountId),
  );
  if (!connectorId.ok) return null;
  // The reservation checks the placement of the request's scope in its own
  // batch, so the directory is not read again.
  const connector = await resolveActiveConnectorActorAtScope({
    scope,
    namespace: env.CONNECTOR,
    connectorId: connectorId.value,
    now: Date.now(),
  });
  if (!connector.ok) return null;
  const inspected = await connector.value.inspectEmailRuntime();
  if (!inspected.ok || inspected.value === null) return null;
  const runtime = inspected.value;
  return {
    policy_version: runtime.policyVersion,
    processing: runtime.processing,
    accepted_history_id: runtime.acceptedHistoryId,
    watch_expires_at: runtime.watchExpiresAt,
    last_evaluation_started_at: runtime.lastEvaluationStartedAt,
    disabled_at: runtime.disabledAt,
    usage: {
      active_cases: runtime.usage.activeCases,
      admitted_last_hour: runtime.usage.admittedLastHour,
      tokens_reserved: runtime.usage.tokens.reserved,
      tokens_consumed: runtime.usage.tokens.consumed,
      next_evaluation_at: runtime.usage.nextEvaluationAt,
    },
  };
}
