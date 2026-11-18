import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Env } from "../env";
import { resolveActiveConnectorActorAtScope } from "../actors/actor-router";
import {
  gmailConnectorIdValue,
  readAgentMailboxBinding,
  readEmailMailboxAccount,
  readMailboxIngressPolicy,
} from "../data/email-mailbox";
import { resolveIntegrationAccount } from "../data/integration-account";
import { parseConnectorId, type IntegrationAccountId } from "../ids";
import { readActiveCredentialAuthorizedAt } from "../data/integration-account-reads";

/**
 * When this mailbox's Gmail authorization was granted, and when it is expected
 * to lapse. A pilot runs on a Testing-status Google project whose refresh
 * tokens expire on a fixed clock, so an operator needs the date before it
 * passes rather than a mailbox that quietly stops. Deployments without a
 * configured window report no expiry at all instead of inventing one.
 */
export async function readMailboxAuthorizationWindow(
  env: Env,
  scope: OrganisationExecutionScope,
  integrationAccountId: IntegrationAccountId,
): Promise<Record<string, unknown> | null> {
  const authorizedAt = await readActiveCredentialAuthorizedAt(
    scope.database,
    scope.organisationId,
    integrationAccountId,
  );
  if (authorizedAt === null) return null;
  const days = Number(env.GMAIL_OAUTH_PILOT_EXPIRY_DAYS ?? "");
  const windowed = Number.isSafeInteger(days) && days > 0;
  return {
    authorized_at: authorizedAt,
    expires_at: windowed ? authorizedAt + days * 86_400_000 : null,
    expiry_window_days: windowed ? days : null,
  };
}

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
  // The four records are read by the same key and decide nothing together.
  const [mailbox, account, binding, authorization] = await Promise.all([
    readEmailMailboxAccount(target),
    resolveIntegrationAccount(target),
    readAgentMailboxBinding(target),
    readMailboxAuthorizationWindow(env, scope, integrationAccountId),
  ]);
  if (!mailbox.ok || !account.ok) return null;
  // The Connector is addressed only for a mailbox that is connected.
  const [policy, runtime] = await Promise.all([
    readMailboxIngressPolicy({
      ...target,
      connectedAt: account.value.createdAt,
    }),
    readAgentMailboxRuntime(env, scope, integrationAccountId),
  ]);
  return {
    integration_account_id: integrationAccountId,
    environment: mailbox.value.environment,
    observed_address: mailbox.value.observedAddress,
    address_observed_at: mailbox.value.addressObservedAt,
    connection_lifecycle: account.value.lifecycle.kind,
    authorization,
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
  };
}

/**
 * Live processing status is best-effort decoration on the durable projection:
 * a Connector that cannot be reached leaves the mailbox visible with
 * runtime null rather than failing the whole read.
 */
export async function readAgentMailboxRuntime(
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
