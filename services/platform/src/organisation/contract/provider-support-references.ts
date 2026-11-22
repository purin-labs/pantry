import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import type { OrganisationEnvironment } from "../../data/control-plane";
import type { ProviderAttemptSupportReference } from "../../data/connection-flow-parts";
import { prepareProjectionRevisionBump } from "../../data/organisation-onboarding-row";

/**
 * The support references of a provider: a failed provider start becomes a
 * reference that a person can quote, and a working provider closes its open
 * references.
 */
export async function recordProviderStartFailure(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly environment: OrganisationEnvironment;
  readonly actorUserId: UserId;
  readonly provider: string;
  readonly route: string;
  readonly reasonCode: string;
  readonly retryable: boolean;
  readonly now: number;
}): Promise<{
  readonly supportReference: string;
  readonly correlationId: string;
}> {
  const supportReference = `PANTRY-${crypto.randomUUID()}`;
  const correlationId = `provider_start_${crypto.randomUUID()}`;
  await input.db
    .prepare(
      `INSERT INTO onboarding_support_reference (
       support_reference, organisation_id, environment, actor_user_id,
       correlation_id, route, operation, reason_code, retry_classification,
       first_occurred_at, latest_occurred_at, occurrence_count, resolved_at,
       provider, adapter_operation, lifecycle_before, lifecycle_after,
       redacted_provider_status, redacted_provider_request_id,
       durable_receipts, last_successful_phase
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
    )
    .bind(
      supportReference,
      input.organisationId,
      input.environment,
      input.actorUserId,
      correlationId,
      input.route,
      "provider.attempt.start",
      input.reasonCode,
      input.retryable ? "retryable" : "terminal",
      input.now,
      input.now,
      input.provider,
      "provider.authorization.start",
      "not_started",
      "not_started",
    )
    .run();
  return { supportReference, correlationId };
}

export function prepareResolveOpenSupportReferences(
  session: Pick<OrganisationDatabaseSession, "prepare">,
  input: {
    readonly organisationId: OrganisationId;
    readonly provider?: string;
    readonly now: number;
  },
): D1PreparedStatement {
  if (input.provider === undefined) {
    return session
      .prepare(
        `UPDATE onboarding_support_reference
       SET resolved_at = ?
       WHERE organisation_id = ? AND resolved_at IS NULL`,
      )
      .bind(input.now, input.organisationId);
  }
  return session
    .prepare(
      `UPDATE onboarding_support_reference
     SET resolved_at = ?
     WHERE organisation_id = ? AND provider = ? AND resolved_at IS NULL`,
    )
    .bind(input.now, input.organisationId, input.provider);
}

/**
 * Closes a provider's open support references when the organisation has that
 * provider working by another path, such as a Stripe account that Stripe's
 * hosted onboarding made after a failed Connect. The projection moves on so
 * the Portal stops showing the old failure. Answers whether one was open.
 */
export async function resolveOpenProviderSupportReferences(
  db: Pick<OrganisationDatabaseSession, "prepare">,
  input: {
    readonly organisationId: OrganisationId;
    readonly provider: string;
    readonly now: number;
  },
): Promise<boolean> {
  const resolved = await prepareResolveOpenSupportReferences(db, input).run();
  if (resolved.meta.changes === 0) return false;
  await prepareProjectionRevisionBump(db, input.organisationId).run();
  return true;
}

/** The support reference of a provider attempt that failed. */
export function prepareProviderAttemptSupportReference(
  session: Pick<OrganisationDatabaseSession, "prepare">,
  input: ProviderAttemptSupportReference,
): D1PreparedStatement {
  return session
    .prepare(
      `INSERT INTO onboarding_support_reference (
         support_reference, organisation_id, environment, actor_user_id,
         correlation_id, route, operation, reason_code, retry_classification,
         first_occurred_at, latest_occurred_at, occurrence_count, resolved_at,
         provider, adapter_operation, lifecycle_before, lifecycle_after,
         redacted_provider_status, redacted_provider_request_id,
         durable_receipts, last_successful_phase
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL,
         ?, ?, ?, 'failed', ?, ?, ?, ?
       )`,
    )
    .bind(
      input.supportReference,
      input.organisationId,
      input.environment,
      input.actorUserId,
      input.correlationId,
      input.route,
      input.operation,
      input.reasonCode,
      input.retryClassification,
      input.now,
      input.now,
      input.provider,
      input.adapterOperation,
      input.lifecycleBefore,
      input.redactedProviderStatus,
      input.redactedProviderRequestId,
      input.durableReceipts,
      input.lastSuccessfulPhase,
    );
}
