import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Env } from "../env";
import { gmailConnectorIdValue } from "../mail-inbox/contract/connector-ids";
import { resolveActiveConnectorActorAtPlacement } from "../actors/actor-router";
import {
  newRequestId,
  parseConnectorId,
  parseIntegrationAccountId,
} from "../ids";
import { traceWarn } from "../observability";

const WATCH_RENEWAL_MARGIN_MS = 24 * 3_600_000;

/**
 * Scheduled email-watch reconciliation subject: every enabled mailbox policy
 * keeps a live Gmail watch. A mailbox whose Connector runtime is missing or
 * disabled re-activates from a fresh floor (activation failures at publish
 * time converge here), and a watch expiring inside the renewal margin is
 * renewed. One mailbox failing never blocks the rest of the sweep.
 */
export async function reconcileOrganisationEmailWatches(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    now: number;
  }>,
): Promise<void> {
  const enabled = await listEnabledMailboxPolicies(input.scope);
  if (enabled.length === 0) return;
  let repairs = 0;
  let failure: string | null = null;
  for (const policy of enabled) {
    const outcome = await reconcileMailboxWatch(
      input.env,
      input.scope,
      policy,
      input.now,
    );
    if (outcome === "repaired") repairs += 1;
    if (outcome === "failed")
      failure = failure ?? "email_watch_reconciliation_failed";
  }
  // As for the onboarding subjects, a run that repaired nothing and did not
  // fail leaves no record: it repeats each quarter of an hour.
  if (repairs === 0 && failure === null) return;
  const environment =
    enabled[0]?.environment === "production" ? "production" : "development";
  await input.scope.database
    .prepare(
      `INSERT INTO onboarding_reconciliation_run (
       reconciliation_run_id, organisation_id, environment, subject_kind,
       lifecycle, repair_count, reason_code, started_at, completed_at
     ) VALUES (?, ?, ?, 'email_watches', ?, ?, ?, ?, ?)`,
    )
    .bind(
      `reconciliation_${crypto.randomUUID()}`,
      input.scope.organisationId,
      environment,
      failure === null ? "completed" : "failed",
      repairs,
      failure,
      input.now,
      input.now,
    )
    .run();
}

type EnabledMailboxPolicy = {
  readonly integrationAccountId: string;
  readonly environment: string;
  readonly policyVersion: number;
  readonly maxActiveCases: number;
  readonly maxMessagesPerHour: number;
  readonly dailyTokenBudget: number;
  readonly maxMessageBytes: number;
  readonly maxAttachmentBytes: number;
};

async function listEnabledMailboxPolicies(
  scope: OrganisationExecutionScope,
): Promise<readonly EnabledMailboxPolicy[]> {
  const rows = await scope.database
    .prepare(
      `SELECT head.integration_account_id AS integrationAccountId,
            head.environment AS environment,
            head.current_version AS policyVersion,
            revision.max_active_cases AS maxActiveCases,
            revision.max_messages_per_hour AS maxMessagesPerHour,
            revision.daily_token_budget AS dailyTokenBudget,
            revision.max_message_bytes AS maxMessageBytes,
            revision.max_attachment_bytes AS maxAttachmentBytes
       FROM mailbox_ingress_policy AS head
       JOIN mailbox_ingress_policy_revision AS revision
         ON revision.integration_account_id = head.integration_account_id
        AND revision.policy_version = head.current_version
       WHERE head.organisation_id = ? AND revision.kind = 'enabled'`,
    )
    .bind(scope.organisationId)
    .all<EnabledMailboxPolicy>();
  return (rows.results ?? []).filter(
    (row) =>
      typeof row.integrationAccountId === "string" &&
      typeof row.policyVersion === "number" &&
      typeof row.maxActiveCases === "number",
  );
}

async function reconcileMailboxWatch(
  env: Env,
  scope: OrganisationExecutionScope,
  policy: EnabledMailboxPolicy,
  now: number,
): Promise<"current" | "repaired" | "failed"> {
  const organisationId = scope.organisationId;
  const integrationAccountId = parseIntegrationAccountId(
    policy.integrationAccountId,
  );
  const connectorId = parseConnectorId(
    gmailConnectorIdValue(policy.integrationAccountId),
  );
  if (!integrationAccountId.ok || !connectorId.ok) return "failed";
  const connector = await resolveActiveConnectorActorAtPlacement({
    env: env,
    placement: scope.placement,
    namespace: env.CONNECTOR,
    organisationId,
    connectorId: connectorId.value,
    now,
  });
  if (!connector.ok) {
    traceWarn("email_watch.connector_unavailable", {
      requestId: newRequestId(),
      integration_account_id: policy.integrationAccountId,
      reason: connector.error.code,
    });
    return "failed";
  }
  const identity = { organisationId, connectorId: connectorId.value };
  const inspected = await connector.value.inspectEmailRuntime();
  if (!inspected.ok) return "failed";
  const runtime = inspected.value;
  if (runtime === null || runtime.disabledAt !== null) {
    const activated = await connector.value.activateEmailProcessing({
      identity,
      integrationAccountId: integrationAccountId.value,
      policyVersion: policy.policyVersion,
      limits: {
        maxActiveCases: policy.maxActiveCases,
        maxMessagesPerHour: policy.maxMessagesPerHour,
        dailyTokenBudget: policy.dailyTokenBudget,
        maxMessageBytes: policy.maxMessageBytes,
        maxAttachmentBytes: policy.maxAttachmentBytes,
      },
      now,
    });
    if (!activated.ok) {
      traceWarn("email_watch.activation_failed", {
        requestId: newRequestId(),
        integration_account_id: policy.integrationAccountId,
        reason: activated.error.code,
      });
      return "failed";
    }
    return "repaired";
  }
  if (
    runtime.watchExpiresAt !== null &&
    runtime.watchExpiresAt > now + WATCH_RENEWAL_MARGIN_MS
  ) {
    return "current";
  }
  const renewed = await connector.value.renewEmailWatch({ identity, now });
  if (!renewed.ok) {
    traceWarn("email_watch.renewal_failed", {
      requestId: newRequestId(),
      integration_account_id: policy.integrationAccountId,
      reason: renewed.error.code,
    });
    return "failed";
  }
  return "repaired";
}
