import type { GlobalDatabase, OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { connectionFlowParts } from "./connection-flow-parts";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  newProviderConnectionAttemptId,
  newProviderProvisioningAttemptId,
  newProviderStateId,
  parseIntegrationAccountId,
  parseProviderConnectionAttemptId,
  parseProviderConnectionId,
  parseProviderProvisioningAttemptId,
  parseProviderStateId,
  parseOrganisationId,
  type IntegrationAccountId,
  type ProviderConnectionAttemptId,
  type ProviderConnectionId,
  type ProviderProvisioningAttemptId,
  type ProviderStateId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  prepareControlMutationReceipt,
  prepareOnboardingAuditEvent,
  prepareOnboardingEvent,
  requireStoredConfigurationVersionedBoundary,
  type ControlMutationBoundary,
  type ControlMutationIdentity,
  type ControlMutationReceiptScope,
} from "./control-mutation";
import type { OrganisationEnvironment } from "./control-plane";
import type { Variant } from "@purin-labs/type-utils";
import type { OrganisationQuerySource } from "./query-source";
import {
  prepareProjectionRevisionBump,
} from "./organisation-onboarding-row";

export type ConnectionProvider =
  | "airtable"
  | "dropbox"
  | "notion"
  | "slack"
  | "shopify"
  | "square"
  | "stripe"
  | "gmail"
  | "google_drive"
  | "whatsapp";

type ProviderAttemptBase = {
  readonly attemptId: ProviderConnectionAttemptId;
  readonly organisationId: OrganisationId;
  readonly provider: ConnectionProvider;
  readonly environment: OrganisationEnvironment;
  readonly userId: UserId;
  readonly existingIntegrationAccountId: IntegrationAccountId | null;
  readonly purpose: "connect" | "reconnect" | "rotate";
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ProviderConnectionAttempt =
  | (ProviderAttemptBase & { readonly kind: "created" })
  | (ProviderAttemptBase & {
      readonly kind: "authorizing";
      readonly providerStateId: ProviderStateId;
      readonly authorizationStartedAt: number;
    })
  | (ProviderAttemptBase & {
      readonly kind: "callback_received";
      readonly providerStateId: ProviderStateId;
      readonly authorizationStartedAt: number;
      readonly callbackReceiptId: string;
      readonly callbackReceivedAt: number;
    })
  | (ProviderAttemptBase & {
      readonly kind: "provisioning";
      readonly providerStateId: ProviderStateId;
      readonly authorizationStartedAt: number;
      readonly callbackReceiptId: string;
      readonly callbackReceivedAt: number;
      readonly provisioningAttemptId: ProviderProvisioningAttemptId;
      readonly provisioningPhase: ProviderProvisioningPhase;
      readonly provisioningStartedAt: number;
    })
  | (ProviderAttemptBase & {
      readonly kind: "connected";
      readonly providerStateId: ProviderStateId;
      readonly authorizationStartedAt: number;
      readonly callbackReceiptId: string;
      readonly callbackReceivedAt: number;
      readonly provisioningAttemptId: ProviderProvisioningAttemptId;
      readonly provisioningPhase: ProviderProvisioningPhase;
      readonly provisioningStartedAt: number;
      readonly connectionId: ProviderConnectionId;
      readonly integrationAccountIds: readonly IntegrationAccountId[];
      readonly completedAt: number;
    })
  | (ProviderAttemptBase & {
      readonly kind: "cancelled";
      readonly cancelledByUserId: UserId;
      readonly cancelledAt: number;
      readonly completedAt: number;
    })
  | (ProviderAttemptBase & {
      readonly kind: "failed";
      readonly reasonCode: string;
      readonly retryable: boolean;
      readonly correlationId: string;
      readonly failedAt: number;
      readonly completedAt: number;
    })
  | (ProviderAttemptBase & {
      readonly kind: "expired";
      readonly expiredAt: number;
      readonly completedAt: number;
    });

export type ProvisioningProviderConnectionAttempt = Variant<
  ProviderConnectionAttempt,
  "provisioning"
>;

export type ProviderProvisioningPhase =
  | "discovering_identity"
  | "persisting_credential"
  | "discovering_accounts"
  | "reconciling_webhooks"
  | "discovering_resources"
  | "verifying_connection"
  | "finalizing";

export type ProviderAttemptWire = {
  readonly attempt_id: string;
  readonly organisation_id: string;
  readonly provider: ConnectionProvider;
  readonly environment: OrganisationEnvironment;
  readonly existing_integration_account_id: string | null;
  readonly purpose: "connect" | "reconnect" | "rotate";
  readonly state: ProviderAttemptStateWire;
  readonly expires_at: number;
  readonly created_at: number;
  readonly updated_at: number;
};

export type ProviderFailureEvidence = {
  readonly redactedProviderStatus: string | null;
  readonly redactedProviderRequestId: string | null;
};

export type ProviderManifestEvidence =
  | {
      readonly kind: "healthy";
      readonly evidenceCode:
        | "callback_identity_verified"
        | "provider_identity_verified"
        | "provider_webhook_verified"
        | "shared_application_subscription_verified";
    }
  | {
      readonly kind: "degraded";
      readonly missingOptionalCapabilities: readonly string[];
      readonly repairActions: readonly string[];
    }
  | {
      readonly kind: "blocked";
      readonly reasonCode: string;
      readonly repairActions: readonly string[];
    }
  | { readonly kind: "observation_unsupported" };

export type ProviderAttemptStateWire =
  | { readonly kind: "created" }
  | {
      readonly kind: "authorizing";
      readonly authorization_started_at: number;
    }
  | {
      readonly kind: "callback_received";
      readonly callback_receipt_id: string;
      readonly received_at: number;
    }
  | {
      readonly kind: "provisioning";
      readonly provisioning_attempt_id: string;
      readonly phase: ProviderProvisioningPhase;
      readonly started_at: number;
    }
  | {
      readonly kind: "connected";
      readonly connection_id: string;
      readonly integration_account_ids: readonly string[];
      readonly completed_at: number;
    }
  | {
      readonly kind: "cancelled";
      readonly cancelled_by: string;
      readonly cancelled_at: number;
    }
  | {
      readonly kind: "failed";
      readonly reason_code: string;
      readonly retryable: boolean;
      readonly correlation_id: string;
      readonly failed_at: number;
    }
  | { readonly kind: "expired"; readonly expired_at: number };

export type ProviderAuthorizationContext = {
  readonly attempt: Variant<ProviderConnectionAttempt, "callback_received">;
  readonly pkceVerifier: string | null;
  readonly providerContext: string;
  readonly returnPath: string;
  readonly portalSubjectHash: string;
};

type ProviderAttemptError =
  | { readonly code: "provider_attempt_not_found" }
  | { readonly code: "provider_attempt_open" }
  | { readonly code: "provider_attempt_terminal" }
  | { readonly code: "provider_attempt_state_conflict" }
  | { readonly code: "provider_state_invalid" }
  | { readonly code: "provider_state_replayed" }
  | { readonly code: "authorization_expired" }
  | { readonly code: "configuration_version_conflict" };

export type ProviderAttemptMutation = {
  readonly boundary: Variant<
    ControlMutationBoundary,
    "configuration_versioned"
  >;
  readonly scope: ControlMutationReceiptScope;
  readonly identity: ControlMutationIdentity;
};

type ProviderAttemptRow = {
  readonly attemptId: unknown;
  readonly organisationId: unknown;
  readonly provider: unknown;
  readonly environment: unknown;
  readonly userId: unknown;
  readonly existingIntegrationAccountId: unknown;
  readonly purpose: unknown;
  readonly lifecycle: unknown;
  readonly providerStateId: unknown;
  readonly authorizationStartedAt: unknown;
  readonly callbackReceiptId: unknown;
  readonly callbackReceivedAt: unknown;
  readonly provisioningAttemptId: unknown;
  readonly provisioningPhase: unknown;
  readonly provisioningStartedAt: unknown;
  readonly connectionId: unknown;
  readonly integrationAccountIds: unknown;
  readonly cancelledByUserId: unknown;
  readonly cancelledAt: unknown;
  readonly failureReasonCode: unknown;
  readonly failureRetryable: unknown;
  readonly failureCorrelationId: unknown;
  readonly failedAt: unknown;
  readonly expiresAt: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
  readonly completedAt: unknown;
};

type AuthorizationStateRow = {
  readonly attemptId: unknown;
  readonly organisationId: unknown;
  readonly provider: unknown;
  readonly environment: unknown;
  readonly userId: unknown;
  readonly portalSubjectHash: unknown;
  readonly pkceVerifier: unknown;
  readonly providerContext: unknown;
  readonly returnPath: unknown;
  readonly expiresAt: unknown;
  readonly consumedAt: unknown;
  readonly callbackCodeHash: unknown;
  readonly callbackReceiptId: unknown;
  readonly invalidatedAt: unknown;
  readonly invalidationReason: unknown;
};

type OrganisationVersionRow = {
  readonly environment: unknown;
  readonly configurationVersion: unknown;
  readonly projectionRevision: unknown;
};

type ResumableAuthorizationRow = {
  readonly attemptId: unknown;
  readonly receiptId: unknown;
  readonly route: unknown;
  readonly operation: unknown;
  readonly idempotencyKey: unknown;
  readonly requestHash: unknown;
  readonly expectedConfigurationVersion: unknown;
};

const ATTEMPT_SELECT = `
  SELECT
    attempt_id AS attemptId, organisation_id AS organisationId, provider, environment,
    user_id AS userId,
    existing_integration_account_id AS existingIntegrationAccountId, purpose,
    lifecycle, provider_state_id AS providerStateId,
    authorization_started_at AS authorizationStartedAt,
    callback_receipt_id AS callbackReceiptId,
    callback_received_at AS callbackReceivedAt,
    provisioning_attempt_id AS provisioningAttemptId,
    provisioning_phase AS provisioningPhase,
    provisioning_started_at AS provisioningStartedAt,
    connection_id AS connectionId,
    integration_account_ids AS integrationAccountIds,
    cancelled_by_user_id AS cancelledByUserId,
    cancelled_at AS cancelledAt, failure_reason_code AS failureReasonCode,
    failure_retryable AS failureRetryable,
    failure_correlation_id AS failureCorrelationId, failed_at AS failedAt,
    expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt,
    completed_at AS completedAt
  FROM provider_connection_attempt`;

export async function createAuthorizingProviderAttempt(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly provider: ConnectionProvider;
  readonly userId: UserId;
  readonly existingIntegrationAccountId: IntegrationAccountId | null;
  readonly purpose: "connect" | "reconnect" | "rotate";
  readonly portalSubjectHash: string;
  readonly stateHash: string;
  readonly nonceHash: string;
  readonly pkceVerifier: string | null;
  readonly providerContext: string;
  readonly returnPath: string;
  readonly expiresAt: number;
  readonly mutation: ProviderAttemptMutation;
  readonly now: number;
}): Promise<
  Result<
    {
      readonly attempt: Variant<ProviderConnectionAttempt, "authorizing">;
      readonly receiptId: string;
    },
    ProviderAttemptError
  >
> {
  const session = input.db.withSession("first-primary");
  const organisation = await readOrganisationVersion(session, input.organisationId);
  if (
    organisation === null ||
    organisation.configurationVersion !==
      input.mutation.boundary.expectedConfigurationVersion
  ) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  const open = await session
    .prepare(
      `${ATTEMPT_SELECT}
     WHERE organisation_id = ? AND provider = ?
       AND (
         (existing_integration_account_id IS NULL AND ? IS NULL)
         OR existing_integration_account_id = ?
       )
       AND lifecycle IN ('created', 'authorizing', 'callback_received', 'provisioning')`,
    )
    .bind(
      input.organisationId,
      input.provider,
      input.existingIntegrationAccountId,
      input.existingIntegrationAccountId,
    )
    .first<ProviderAttemptRow>();
  if (open !== null) {
    const attempt = requireProviderAttempt(open);
    if (attempt.expiresAt > input.now) {
      return { ok: false, error: { code: "provider_attempt_open" } };
    }
    const expired = await expireProviderAttemptIfDue({
      db: input.db,
      organisationId: input.organisationId,
      attemptId: attempt.attemptId,
      portalSubjectHash: input.portalSubjectHash,
      now: input.now,
    });
    if (!expired.ok) return expired;
    if (expired.value.kind !== "expired") {
      return { ok: false, error: { code: "provider_attempt_state_conflict" } };
    }
  }

  const attemptId = newProviderConnectionAttemptId();
  const providerStateId = newProviderStateId();
  const projectionRevision = organisation.projectionRevision + 1;
  const attemptWire: ProviderAttemptWire = {
    attempt_id: attemptId,
    organisation_id: input.organisationId,
    provider: input.provider,
    environment: organisation.environment,
    existing_integration_account_id: input.existingIntegrationAccountId,
    purpose: input.purpose,
    state: {
      kind: "authorizing",
      authorization_started_at: input.now,
    },
    expires_at: input.expiresAt,
    created_at: input.now,
    updated_at: input.now,
  };
  const responseBody = {
    kind: "success",
    attempt: attemptWire,
    receipt: {
      receipt_id: input.mutation.identity.receiptId,
      organisation_id: input.organisationId,
    },
  };
  const eventIdentity = providerEventIdentity(input.mutation.identity);
  await session.batch([
    session
      .prepare(
        `INSERT INTO provider_connection_attempt (
         attempt_id, organisation_id, provider, environment, user_id,
         existing_integration_account_id, purpose, lifecycle, provider_state_id,
         authorization_started_at, callback_receipt_id, callback_received_at,
         provisioning_attempt_id, provisioning_phase, provisioning_started_at,
         connection_id, integration_account_ids, cancelled_by_user_id,
         cancelled_at, failure_reason_code, failure_retryable, failure_correlation_id,
         failed_at, expires_at, created_at, updated_at, completed_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, 'authorizing', ?, ?,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, ?, ?, ?, NULL
       )`,
      )
      .bind(
        attemptId,
        input.organisationId,
        input.provider,
        organisation.environment,
        input.userId,
        input.existingIntegrationAccountId,
        input.purpose,
        providerStateId,
        input.now,
        input.expiresAt,
        input.now,
        input.now,
      ),
    session
      .prepare(
        `INSERT INTO provider_authorization_state (
         provider_state_id, state_hash, attempt_id, organisation_id, provider, environment,
         user_id, portal_subject_hash, nonce_hash, pkce_verifier,
         provider_context, return_path, created_at, expires_at, consumed_at,
         callback_code_hash, callback_receipt_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .bind(
        providerStateId,
        input.stateHash,
        attemptId,
        input.organisationId,
        input.provider,
        organisation.environment,
        input.userId,
        input.portalSubjectHash,
        input.nonceHash,
        input.pkceVerifier,
        input.providerContext,
        input.returnPath,
        input.now,
        input.expiresAt,
      ),
    prepareProjectionRevisionBump(session, input.organisationId, { atConfigurationVersion: organisation.configurationVersion }),
    prepareControlMutationReceipt(session, {
      scope: input.mutation.scope,
      boundary: input.mutation.boundary,
      identity: input.mutation.identity,
      responseStatus: 201,
      responseBody,
    }),
    prepareOnboardingAuditEvent(session, input.mutation.identity, {
      organisationId: input.organisationId,
      environment: organisation.environment,
      actorUserId: input.userId,
      operation: "provider.attempt.start",
      targetKind: "provider_connection_attempt",
      targetId: attemptId,
      oldLifecycle: null,
      newLifecycle: "authorizing",
      configurationVersion: organisation.configurationVersion,
      projectionRevision,
      reasonCode: "authorization_started",
    }),
    prepareOnboardingEvent(session, eventIdentity, {
      eventId: eventIdentity.auditEventId,
      eventType: "provider_attempt_started",
      organisationId: input.organisationId,
      environment: organisation.environment,
      projectionRevision,
      attributes: { attempt_id: attemptId, provider: input.provider },
    }),
  ]);
  const attempt = await readProviderAttempt({
    db: session,
    organisationId: input.organisationId,
    attemptId,
  });
  if (!attempt.ok || attempt.value.kind !== "authorizing") {
    throw new Error("provider attempt start persistence invariant failed");
  }
  return {
    ok: true,
    value: {
      attempt: attempt.value,
      receiptId: input.mutation.identity.receiptId,
    },
  };
}

export async function readProviderAttempt(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
  readonly attemptId: ProviderConnectionAttemptId;
}): Promise<Result<ProviderConnectionAttempt, ProviderAttemptError>> {
  const row = await input.db
    .prepare(`${ATTEMPT_SELECT} WHERE organisation_id = ? AND attempt_id = ?`)
    .bind(input.organisationId, input.attemptId)
    .first<ProviderAttemptRow>();
  if (row === null) {
    return { ok: false, error: { code: "provider_attempt_not_found" } };
  }
  return { ok: true, value: requireProviderAttempt(row) };
}

export async function readResumableProviderAuthorization(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
  readonly provider: ConnectionProvider;
  readonly userId: UserId;
  readonly existingIntegrationAccountId: IntegrationAccountId | null;
  readonly purpose: "connect" | "reconnect" | "rotate";
  readonly providerContext: string;
}): Promise<{
  readonly attempt: Variant<ProviderConnectionAttempt, "authorizing">;
  readonly receiptId: string;
  readonly mutation: Pick<ProviderAttemptMutation, "boundary" | "scope">;
} | null> {
  const row = await input.db
    .prepare(
      `SELECT attempt.attempt_id AS attemptId,
            receipt.receipt_id AS receiptId,
            receipt.route,
            receipt.operation,
            receipt.idempotency_key AS idempotencyKey,
            receipt.request_hash AS requestHash,
            audit.configuration_version AS expectedConfigurationVersion
     FROM provider_connection_attempt AS attempt
     JOIN provider_authorization_state AS authorization
       ON authorization.attempt_id = attempt.attempt_id
     JOIN onboarding_audit_event AS audit
       ON audit.target_kind = 'provider_connection_attempt'
      AND audit.target_id = attempt.attempt_id
      AND audit.reason_code = 'authorization_started'
     JOIN control_mutation_receipt AS receipt
       ON receipt.receipt_id = audit.idempotency_receipt_id
     WHERE attempt.organisation_id = ?
       AND attempt.provider = ?
       AND attempt.user_id = ?
       AND attempt.existing_integration_account_id IS ?
       AND attempt.purpose = ?
       AND attempt.lifecycle = 'authorizing'
       AND authorization.provider_context = ?
       AND authorization.consumed_at IS NULL
       AND authorization.invalidated_at IS NULL
       AND receipt.user_id = ?
       AND receipt.organisation_scope = ?
     ORDER BY attempt.created_at DESC
     LIMIT 1`,
    )
    .bind(
      input.organisationId,
      input.provider,
      input.userId,
      input.existingIntegrationAccountId,
      input.purpose,
      input.providerContext,
      input.userId,
      input.organisationId,
    )
    .first<ResumableAuthorizationRow>();
  if (row === null) {
    return null;
  }
  const attemptId = parseStringId(
    row.attemptId,
    parseProviderConnectionAttemptId,
    "attempt_id",
  );
  const attempt = await readProviderAttempt({
    db: input.db,
    organisationId: input.organisationId,
    attemptId,
  });
  if (!attempt.ok || attempt.value.kind !== "authorizing") {
    throw new Error("resumable provider attempt is corrupt");
  }
  if (
    typeof row.receiptId !== "string" ||
    !/^receipt_[0-9a-f-]{36}$/u.test(row.receiptId) ||
    typeof row.route !== "string" ||
    row.route.length === 0 ||
    typeof row.operation !== "string" ||
    row.operation.length === 0
  ) {
    throw new Error("resumable provider authorization receipt is corrupt");
  }
  return {
    attempt: attempt.value,
    receiptId: row.receiptId,
    mutation: {
      boundary: requireStoredConfigurationVersionedBoundary({
        idempotencyKey: row.idempotencyKey,
        requestHash: row.requestHash,
        expectedConfigurationVersion: row.expectedConfigurationVersion,
      }),
      scope: {
        userId: input.userId,
        organisationScope: input.organisationId,
        route: row.route,
        operation: row.operation,
      },
    },
  };
}

export async function expireProviderAttemptIfDue(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly attemptId: ProviderConnectionAttemptId;
  readonly portalSubjectHash: string;
  readonly now: number;
}): Promise<Result<ProviderConnectionAttempt, ProviderAttemptError>> {
  const session = input.db.withSession("first-primary");
  const current = await readProviderAttempt({
    db: session,
    organisationId: input.organisationId,
    attemptId: input.attemptId,
  });
  if (
    !current.ok ||
    !isOpenAttempt(current.value) ||
    current.value.expiresAt > input.now
  ) {
    return current;
  }
  const organisation = await readOrganisationVersion(session, input.organisationId);
  if (organisation === null) {
    return { ok: false, error: { code: "provider_attempt_not_found" } };
  }
  const identity = callbackEventIdentity(
    current.value.userId,
    input.portalSubjectHash,
    input.now,
    `provider_expiry_${input.attemptId}`,
  );
  const statements: D1PreparedStatement[] = [];
  if (current.value.kind === "provisioning") {
    statements.push(
      session
        .prepare(
          `UPDATE provider_provisioning_attempt
         SET lifecycle = 'failed_retryable', reason_code = 'authorization_expired',
             correlation_id = ?, updated_at = ?, completed_at = ?
         WHERE provisioning_attempt_id = ? AND lifecycle = 'running'`,
        )
        .bind(
          identity.correlationId,
          input.now,
          input.now,
          current.value.provisioningAttemptId,
        ),
    );
  }
  const attemptUpdateIndex = statements.length;
  statements.push(
    session
      .prepare(
        `UPDATE provider_connection_attempt
       SET lifecycle = 'expired', completed_at = ?, updated_at = ?
       WHERE organisation_id = ? AND attempt_id = ? AND expires_at <= ?
         AND lifecycle IN ('created', 'authorizing', 'callback_received', 'provisioning')`,
      )
      .bind(input.now, input.now, input.organisationId, input.attemptId, input.now),
    invalidateAuthorizationStateStatement(
      session,
      input.attemptId,
      input.now,
      "expired",
    ),
    prepareProjectionRevisionBump(session, input.organisationId, { updatedAt: input.now }),
    prepareOnboardingAuditEvent(session, identity, {
      organisationId: input.organisationId,
      environment: organisation.environment,
      actorUserId: current.value.userId,
      operation: "provider.attempt.expire",
      targetKind: "provider_connection_attempt",
      targetId: input.attemptId,
      oldLifecycle: current.value.kind,
      newLifecycle: "expired",
      configurationVersion: organisation.configurationVersion,
      projectionRevision: organisation.projectionRevision + 1,
      reasonCode: "authorization_expired",
    }),
    prepareOnboardingEvent(session, identity, {
      eventId: identity.auditEventId,
      eventType: "provider_attempt_expired",
      organisationId: input.organisationId,
      environment: organisation.environment,
      projectionRevision: organisation.projectionRevision + 1,
      attributes: {
        attempt_id: input.attemptId,
        provider: current.value.provider,
      },
    }),
  );
  const results = await session.batch(statements);
  if (results[attemptUpdateIndex]?.meta.changes !== 1) {
    return readProviderAttempt({
      db: session,
      organisationId: input.organisationId,
      attemptId: input.attemptId,
    });
  }
  return readProviderAttempt({
    db: session,
    organisationId: input.organisationId,
    attemptId: input.attemptId,
  });
}

export async function consumeProviderAuthorizationState(input: {
  readonly scope: OrganisationExecutionScope;
  readonly provider: ConnectionProvider;
  readonly stateHash: string;
  readonly callbackCodeHash: string;
  readonly now: number;
}): Promise<
  Result<
    | {
        readonly kind: "consumed";
        readonly value: ProviderAuthorizationContext;
      }
    | {
        readonly kind: "replayed";
        readonly attempt: ProviderConnectionAttempt;
        readonly returnPath: string;
      },
    ProviderAttemptError
  >
> {
  const session = input.scope.database.withSession("first-primary");
  const row = await session
    .prepare(
      `SELECT attempt_id AS attemptId, organisation_id AS organisationId, provider, environment,
            user_id AS userId,
            portal_subject_hash AS portalSubjectHash,
            pkce_verifier AS pkceVerifier,
            provider_context AS providerContext, return_path AS returnPath,
            expires_at AS expiresAt, consumed_at AS consumedAt,
            callback_code_hash AS callbackCodeHash,
            callback_receipt_id AS callbackReceiptId,
            invalidated_at AS invalidatedAt,
            invalidation_reason AS invalidationReason
     FROM provider_authorization_state WHERE state_hash = ?`,
    )
    .bind(input.stateHash)
    .first<AuthorizationStateRow>();
  const state = parseAuthorizationState(row);
  if (
    !state.ok ||
    state.value.provider !== input.provider ||
    state.value.organisationId !== input.scope.organisationId
  ) {
    return { ok: false, error: { code: "provider_state_invalid" } };
  }
  if (state.value.invalidatedAt !== null) {
    if (
      state.value.callbackCodeHash !== null &&
      state.value.callbackCodeHash !== input.callbackCodeHash
    ) {
      return { ok: false, error: { code: "provider_state_replayed" } };
    }
    const existing = await readProviderAttempt({
      db: session,
      organisationId: state.value.organisationId,
      attemptId: state.value.attemptId,
    });
    if (!existing.ok || isOpenAttempt(existing.value)) {
      return { ok: false, error: { code: "provider_state_invalid" } };
    }
    return {
      ok: true,
      value: {
        kind: "replayed",
        attempt: existing.value,
        returnPath: state.value.returnPath,
      },
    };
  }
  if (state.value.consumedAt !== null) {
    if (state.value.callbackCodeHash !== input.callbackCodeHash) {
      return { ok: false, error: { code: "provider_state_replayed" } };
    }
    const existing = await readProviderAttempt({
      db: session,
      organisationId: state.value.organisationId,
      attemptId: state.value.attemptId,
    });
    return existing.ok
      ? {
          ok: true,
          value: {
            kind: "replayed",
            attempt: existing.value,
            returnPath: state.value.returnPath,
          },
        }
      : existing;
  }
  if (state.value.expiresAt <= input.now) {
    await expireProviderAttemptIfDue({
      db: input.scope.database,
      organisationId: state.value.organisationId,
      attemptId: state.value.attemptId,
      portalSubjectHash: state.value.portalSubjectHash,
      now: input.now,
    });
    return { ok: false, error: { code: "authorization_expired" } };
  }

  const callbackReceiptId = `provider_callback_${crypto.randomUUID()}`;
  const results = await session.batch([
    session
      .prepare(
        `UPDATE provider_authorization_state
       SET consumed_at = ?, callback_code_hash = ?, callback_receipt_id = ?
       WHERE state_hash = ? AND consumed_at IS NULL
         AND invalidated_at IS NULL AND expires_at > ?`,
      )
      .bind(
        input.now,
        input.callbackCodeHash,
        callbackReceiptId,
        input.stateHash,
        input.now,
      ),
    session
      .prepare(
        `UPDATE provider_connection_attempt
       SET lifecycle = 'callback_received', callback_receipt_id = ?,
           callback_received_at = ?, updated_at = ?
       WHERE attempt_id = ? AND lifecycle = 'authorizing'
         AND EXISTS (
           SELECT 1 FROM provider_authorization_state
           WHERE attempt_id = ? AND callback_receipt_id = ?
         )`,
      )
      .bind(
        callbackReceiptId,
        input.now,
        input.now,
        state.value.attemptId,
        state.value.attemptId,
        callbackReceiptId,
      ),
    prepareProjectionRevisionBump(session, state.value.organisationId),
    input.scope.prepareMutationFence(),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    return { ok: false, error: { code: "provider_attempt_state_conflict" } };
  }
  const attempt = await readProviderAttempt({
    db: session,
    organisationId: state.value.organisationId,
    attemptId: state.value.attemptId,
  });
  if (!attempt.ok || attempt.value.kind !== "callback_received") {
    throw new Error("provider callback receipt persistence invariant failed");
  }
  return {
    ok: true,
    value: {
      kind: "consumed",
      value: {
        attempt: attempt.value,
        pkceVerifier: state.value.pkceVerifier,
        providerContext: state.value.providerContext,
        returnPath: state.value.returnPath,
        portalSubjectHash: state.value.portalSubjectHash,
      },
    },
  };
}

export async function beginProviderProvisioning(input: {
  readonly scope: OrganisationExecutionScope;
  readonly attempt: Variant<ProviderConnectionAttempt, "callback_received">;
  readonly now: number;
}): Promise<
  Result<ProvisioningProviderConnectionAttempt, ProviderAttemptError>
> {
  const provisioningAttemptId = newProviderProvisioningAttemptId();
  const session = input.scope.database.withSession("first-primary");
  const results = await session.batch([
    session
      .prepare(
        `INSERT INTO provider_provisioning_attempt (
         provisioning_attempt_id, attempt_id, organisation_id, provider, environment,
         lifecycle, phase, reason_code, correlation_id, started_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, 'running', 'discovering_identity',
                 NULL, NULL, ?, ?, NULL)`,
      )
      .bind(
        provisioningAttemptId,
        input.attempt.attemptId,
        input.attempt.organisationId,
        input.attempt.provider,
        input.attempt.environment,
        input.now,
        input.now,
      ),
    session
      .prepare(
        `UPDATE provider_connection_attempt
       SET lifecycle = 'provisioning', provisioning_attempt_id = ?,
           provisioning_phase = 'discovering_identity',
           provisioning_started_at = ?, updated_at = ?
       WHERE attempt_id = ? AND lifecycle = 'callback_received'
         AND callback_receipt_id = ?`,
      )
      .bind(
        provisioningAttemptId,
        input.now,
        input.now,
        input.attempt.attemptId,
        input.attempt.callbackReceiptId,
      ),
    prepareProjectionRevisionBump(session, input.attempt.organisationId),
    input.scope.prepareMutationFence(),
  ]);
  if (results[1]?.meta.changes !== 1) {
    return { ok: false, error: { code: "provider_attempt_state_conflict" } };
  }
  const current = await readProviderAttempt({
    db: session,
    organisationId: input.attempt.organisationId,
    attemptId: input.attempt.attemptId,
  });
  if (!current.ok || current.value.kind !== "provisioning") {
    throw new Error("provider provisioning start persistence invariant failed");
  }
  return { ok: true, value: current.value };
}

export async function recordProviderProvisioningPhase(input: {
  readonly scope: OrganisationExecutionScope;
  readonly attempt: ProvisioningProviderConnectionAttempt;
  readonly phase: ProviderProvisioningPhase;
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly nextPhase: ProviderProvisioningPhase;
  readonly now: number;
}): Promise<
  Result<ProvisioningProviderConnectionAttempt, ProviderAttemptError>
> {
  if (input.attempt.provisioningPhase !== input.phase) {
    return { ok: false, error: { code: "provider_attempt_state_conflict" } };
  }
  const receiptId = `provisioning_receipt_${crypto.randomUUID()}`;
  const session = input.scope.database.withSession("first-primary");
  const results = await session.batch([
    session
      .prepare(
        `INSERT INTO provider_provisioning_receipt (
         receipt_id, provisioning_attempt_id, phase, receipt, completed_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (provisioning_attempt_id, phase) DO NOTHING`,
      )
      .bind(
        receiptId,
        input.attempt.provisioningAttemptId,
        input.phase,
        JSON.stringify(input.receipt),
        input.now,
      ),
    session
      .prepare(
        `UPDATE provider_provisioning_attempt
       SET phase = ?, updated_at = ?
       WHERE provisioning_attempt_id = ? AND lifecycle = 'running' AND phase = ?`,
      )
      .bind(
        input.nextPhase,
        input.now,
        input.attempt.provisioningAttemptId,
        input.phase,
      ),
    session
      .prepare(
        `UPDATE provider_connection_attempt
       SET provisioning_phase = ?, updated_at = ?
       WHERE attempt_id = ? AND lifecycle = 'provisioning'
         AND provisioning_attempt_id = ? AND provisioning_phase = ?`,
      )
      .bind(
        input.nextPhase,
        input.now,
        input.attempt.attemptId,
        input.attempt.provisioningAttemptId,
        input.phase,
      ),
    input.scope.prepareMutationFence(),
  ]);
  if (results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
    return { ok: false, error: { code: "provider_attempt_state_conflict" } };
  }
  const current = await readProviderAttempt({
    db: session,
    organisationId: input.attempt.organisationId,
    attemptId: input.attempt.attemptId,
  });
  if (!current.ok || current.value.kind !== "provisioning") {
    throw new Error("provider provisioning phase persistence invariant failed");
  }
  return { ok: true, value: current.value };
}

export async function completeProviderProvisioning(input: {
  readonly scope: OrganisationExecutionScope;
  readonly manifestDatabase: GlobalDatabase;
  readonly attempt: ProvisioningProviderConnectionAttempt;
  readonly connectionId: ProviderConnectionId;
  readonly integrationAccountIds: readonly IntegrationAccountId[];
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly manifestEvidence: ProviderManifestEvidence;
  readonly portalSubjectHash: string;
  readonly now: number;
}): Promise<
  Result<Variant<ProviderConnectionAttempt, "connected">, ProviderAttemptError>
> {
  if (
    input.attempt.provisioningPhase !== "finalizing" ||
    input.integrationAccountIds.length === 0
  ) {
    return { ok: false, error: { code: "provider_attempt_state_conflict" } };
  }
  const organisation = await readOrganisationVersion(
    input.scope.database,
    input.attempt.organisationId,
  );
  if (organisation === null) {
    return { ok: false, error: { code: "provider_attempt_not_found" } };
  }
  const eventIdentity = callbackEventIdentity(
    input.attempt.userId,
    input.portalSubjectHash,
    input.now,
  );
  const finalReceiptId = `provisioning_receipt_${crypto.randomUUID()}`;
  const session = input.scope.database.withSession("first-primary");
  const statements: D1PreparedStatement[] = [
    session
      .prepare(
        `INSERT INTO provider_provisioning_receipt (
         receipt_id, provisioning_attempt_id, phase, receipt, completed_at
       ) VALUES (?, ?, 'finalizing', ?, ?)
       ON CONFLICT (provisioning_attempt_id, phase) DO NOTHING`,
      )
      .bind(
        finalReceiptId,
        input.attempt.provisioningAttemptId,
        JSON.stringify(input.receipt),
        input.now,
      ),
    session
      .prepare(
        `UPDATE provider_provisioning_attempt
       SET lifecycle = 'succeeded', updated_at = ?, completed_at = ?
       WHERE provisioning_attempt_id = ? AND lifecycle = 'running'
         AND phase = 'finalizing'`,
      )
      .bind(input.now, input.now, input.attempt.provisioningAttemptId),
    session
      .prepare(
        `UPDATE provider_connection_attempt
       SET lifecycle = 'connected', connection_id = ?,
           integration_account_ids = ?, completed_at = ?, updated_at = ?
       WHERE attempt_id = ? AND lifecycle = 'provisioning'
         AND provisioning_attempt_id = ? AND provisioning_phase = 'finalizing'`,
      )
      .bind(
        input.connectionId,
        JSON.stringify(input.integrationAccountIds),
        input.now,
        input.now,
        input.attempt.attemptId,
        input.attempt.provisioningAttemptId,
      ),
    invalidateAuthorizationStateStatement(
      session,
      input.attempt.attemptId,
      input.now,
      "connected",
    ),
    prepareProjectionRevisionBump(session, input.attempt.organisationId),
    prepareOnboardingEvent(session, eventIdentity, {
      eventId: eventIdentity.auditEventId,
      eventType: "provider_attempt_connected",
      organisationId: input.attempt.organisationId,
      environment: input.attempt.environment,
      projectionRevision: organisation.projectionRevision + 1,
      attributes: {
        attempt_id: input.attempt.attemptId,
        provider: input.attempt.provider,
        connection_id: input.connectionId,
      },
    }),
    prepareOnboardingEvent(session, eventIdentity, {
      eventId: `event_${crypto.randomUUID()}`,
      eventType: "onboarding_stage_completed",
      organisationId: input.attempt.organisationId,
      environment: input.attempt.environment,
      projectionRevision: organisation.projectionRevision + 1,
      attributes: {
        stage:
          input.attempt.provider === "slack" ? "conversations" : "commerce",
        receipt_id: finalReceiptId,
      },
    }),
  ];
  const manifestVersion = await readCurrentProviderManifestVersion(
    input.manifestDatabase,
    input.attempt.provider,
    input.attempt.environment,
  );
  if (manifestVersion !== null) {
    for (const integrationAccountId of input.integrationAccountIds) {
      statements.push(
        prepareProviderManifestObservation(session, {
          organisationId: input.attempt.organisationId,
          integrationAccountId,
          provider: input.attempt.provider,
          environment: input.attempt.environment,
          manifestVersion,
          evidence: input.manifestEvidence,
          now: input.now,
        }),
      );
    }
  }
  const results = await session.batch([
    ...statements,
    input.scope.prepareMutationFence(),
  ]);
  if (results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
    return { ok: false, error: { code: "provider_attempt_state_conflict" } };
  }
  const current = await readProviderAttempt({
    db: session,
    organisationId: input.attempt.organisationId,
    attemptId: input.attempt.attemptId,
  });
  if (!current.ok || current.value.kind !== "connected") {
    throw new Error(
      "provider provisioning completion persistence invariant failed",
    );
  }
  return { ok: true, value: current.value };
}

export async function recordProviderManifestObservation(input: {
  readonly scope: OrganisationExecutionScope;
  readonly manifestDatabase: GlobalDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly provider: ConnectionProvider;
  readonly environment: OrganisationEnvironment;
  readonly evidence: ProviderManifestEvidence;
  readonly now: number;
}): Promise<void> {
  const manifestVersion = await readCurrentProviderManifestVersion(
    input.manifestDatabase,
    input.provider,
    input.environment,
  );
  if (manifestVersion === null) return;
  await input.scope.database.batch([
    prepareProviderManifestObservation(input.scope.database, {
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      provider: input.provider,
      environment: input.environment,
      manifestVersion,
      evidence: input.evidence,
      now: input.now,
    }),
    input.scope.prepareMutationFence(),
  ]);
}

async function readCurrentProviderManifestVersion(
  database: GlobalDatabase,
  provider: ConnectionProvider,
  environment: OrganisationEnvironment,
): Promise<number | null> {
  const row = await database
    .prepare(
      `SELECT manifest_version AS version FROM provider_manifest
     WHERE provider = ? AND environment = ? ORDER BY manifest_version DESC LIMIT 1`,
    )
    .bind(provider, environment)
    .first<{ readonly version: unknown }>();
  if (row === null) return null;
  if (
    typeof row.version !== "number" ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1
  ) {
    throw new Error("provider_manifest_version_invalid");
  }
  return row.version;
}

/**
 * Records a health check of a provider account when its result differs from
 * the account's latest row. The scheduled run and each readiness read check
 * every account, so a result that stays the same writes nothing: an
 * account's rows are the changes of its health, and `observed_at` is the
 * time that the current result was first seen.
 */
function prepareProviderManifestObservation(
  database: Pick<OrganisationDatabase, "prepare">,
  input: {
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: IntegrationAccountId;
    readonly provider: ConnectionProvider;
    readonly environment: OrganisationEnvironment;
    readonly manifestVersion: number;
    readonly evidence: ProviderManifestEvidence;
    readonly now: number;
  },
): D1PreparedStatement {
  const values = providerManifestObservationValues(input.evidence);
  return database
    .prepare(
      `INSERT INTO provider_manifest_observation (
      observation_id, organisation_id, integration_account_id, provider, environment,
      manifest_version, lifecycle, evidence_code, reason_code,
      missing_optional_capabilities, repair_actions, observed_at
    )
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
    WHERE NOT EXISTS (
      SELECT 1 FROM (
        SELECT provider, environment, manifest_version, lifecycle, evidence_code,
               reason_code, missing_optional_capabilities, repair_actions
        FROM provider_manifest_observation
        WHERE integration_account_id = ?3
        ORDER BY observed_at DESC, observation_id DESC
        LIMIT 1
      ) AS latest
      WHERE latest.provider = ?4 AND latest.environment = ?5
        AND latest.manifest_version = ?6 AND latest.lifecycle = ?7
        AND latest.evidence_code IS ?8 AND latest.reason_code IS ?9
        AND latest.missing_optional_capabilities IS ?10
        AND latest.repair_actions IS ?11
    )`,
    )
    .bind(
      `provider_observation_${crypto.randomUUID()}`,
      input.organisationId,
      input.integrationAccountId,
      input.provider,
      input.environment,
      input.manifestVersion,
      values.lifecycle,
      values.evidenceCode,
      values.reasonCode,
      values.missingOptionalCapabilities,
      values.repairActions,
      input.now,
    );
}

function providerManifestObservationValues(
  evidence: ProviderManifestEvidence,
): {
  readonly lifecycle:
    "healthy" | "degraded" | "blocked" | "observation_unsupported";
  readonly evidenceCode: string | null;
  readonly reasonCode: string | null;
  readonly missingOptionalCapabilities: string | null;
  readonly repairActions: string | null;
} {
  switch (evidence.kind) {
    case "healthy":
      return {
        lifecycle: "healthy",
        evidenceCode: evidence.evidenceCode,
        reasonCode: null,
        missingOptionalCapabilities: null,
        repairActions: null,
      };
    case "degraded":
      return {
        lifecycle: "degraded",
        evidenceCode: null,
        reasonCode: null,
        missingOptionalCapabilities: JSON.stringify(
          evidence.missingOptionalCapabilities,
        ),
        repairActions: JSON.stringify(evidence.repairActions),
      };
    case "blocked":
      return {
        lifecycle: "blocked",
        evidenceCode: null,
        reasonCode: evidence.reasonCode,
        missingOptionalCapabilities: null,
        repairActions: JSON.stringify(evidence.repairActions),
      };
    case "observation_unsupported":
      return {
        lifecycle: "observation_unsupported",
        evidenceCode: null,
        reasonCode: null,
        missingOptionalCapabilities: null,
        repairActions: null,
      };
  }
}

export async function failProviderAttempt(input: {
  readonly scope: OrganisationExecutionScope;
  readonly attempt: ProviderConnectionAttempt;
  readonly reasonCode: string;
  readonly retryable: boolean;
  readonly providerEvidence: ProviderFailureEvidence;
  readonly portalSubjectHash: string;
  readonly now: number;
}): Promise<
  Result<Variant<ProviderConnectionAttempt, "failed">, ProviderAttemptError>
> {
  if (!isOpenAttempt(input.attempt)) {
    return { ok: false, error: { code: "provider_attempt_terminal" } };
  }
  const correlationId = `provider_failure_${crypto.randomUUID()}`;
  const organisation = await readOrganisationVersion(
    input.scope.database,
    input.attempt.organisationId,
  );
  if (organisation === null) {
    return { ok: false, error: { code: "provider_attempt_not_found" } };
  }
  const eventIdentity = callbackEventIdentity(
    input.attempt.userId,
    input.portalSubjectHash,
    input.now,
    correlationId,
  );
  const supportReference = `PANTRY-${crypto.randomUUID()}`;
  const supportEventIdentity = providerEventIdentity(eventIdentity);
  const session = input.scope.database.withSession("first-primary");
  const statements: D1PreparedStatement[] = [];
  if (input.attempt.kind === "provisioning") {
    statements.push(
      session
        .prepare(
          `UPDATE provider_provisioning_attempt
         SET lifecycle = ?, reason_code = ?, correlation_id = ?,
             updated_at = ?, completed_at = ?
         WHERE provisioning_attempt_id = ? AND lifecycle = 'running'`,
        )
        .bind(
          input.retryable ? "failed_retryable" : "failed_terminal",
          input.reasonCode,
          correlationId,
          input.now,
          input.now,
          input.attempt.provisioningAttemptId,
        ),
    );
  }
  statements.push(
    session
      .prepare(
        `UPDATE provider_connection_attempt
       SET lifecycle = 'failed', failure_reason_code = ?,
           failure_retryable = ?, failure_correlation_id = ?,
           failed_at = ?, completed_at = ?, updated_at = ?
       WHERE attempt_id = ?
         AND lifecycle IN ('created', 'authorizing', 'callback_received', 'provisioning')`,
      )
      .bind(
        input.reasonCode,
        input.retryable ? 1 : 0,
        correlationId,
        input.now,
        input.now,
        input.now,
        input.attempt.attemptId,
      ),
    invalidateAuthorizationStateStatement(
      session,
      input.attempt.attemptId,
      input.now,
      "failed",
    ),
    prepareProjectionRevisionBump(session, input.attempt.organisationId),
    prepareOnboardingEvent(session, eventIdentity, {
      eventId: eventIdentity.auditEventId,
      eventType: "provider_attempt_failed",
      organisationId: input.attempt.organisationId,
      environment: input.attempt.environment,
      projectionRevision: organisation.projectionRevision + 1,
      attributes: {
        attempt_id: input.attempt.attemptId,
        provider: input.attempt.provider,
        reason_code: input.reasonCode,
        retryable: input.retryable,
      },
    }),
    prepareOnboardingAuditEvent(session, eventIdentity, {
      organisationId: input.attempt.organisationId,
      environment: input.attempt.environment,
      actorUserId: input.attempt.userId,
      operation: "provider.attempt.fail",
      targetKind: "provider_connection_attempt",
      targetId: input.attempt.attemptId,
      oldLifecycle: input.attempt.kind,
      newLifecycle: "failed",
      configurationVersion: organisation.configurationVersion,
      projectionRevision: organisation.projectionRevision + 1,
      reasonCode: input.reasonCode,
    }),
    connectionFlowParts.use().prepareProviderAttemptSupportReference(session, {
      supportReference,
      organisationId: input.attempt.organisationId,
      environment: input.attempt.environment,
      actorUserId: input.attempt.userId,
      correlationId,
      route: `/v1/control/providers/${input.attempt.provider}/callback`,
      operation: "provider.callback.provision",
      reasonCode: input.reasonCode,
      retryClassification: input.retryable ? "retryable" : "terminal",
      now: input.now,
      provider: input.attempt.provider,
      adapterOperation:
        input.attempt.kind === "provisioning"
          ? input.attempt.provisioningPhase
          : "authorization",
      lifecycleBefore: input.attempt.kind,
      redactedProviderStatus: input.providerEvidence.redactedProviderStatus,
      redactedProviderRequestId:
        input.providerEvidence.redactedProviderRequestId,
      durableReceipts: JSON.stringify(
        providerAttemptReceiptReferences(input.attempt),
      ),
      lastSuccessfulPhase:
        input.attempt.kind === "provisioning"
          ? input.attempt.provisioningPhase
          : null,
    }),
    prepareOnboardingEvent(session, supportEventIdentity, {
      eventId: supportEventIdentity.auditEventId,
      eventType: "support_reference_created",
      organisationId: input.attempt.organisationId,
      environment: input.attempt.environment,
      projectionRevision: organisation.projectionRevision + 1,
      attributes: {
        attempt_id: input.attempt.attemptId,
        provider: input.attempt.provider,
        reason_code: input.reasonCode,
        support_reference: supportReference,
      },
    }),
  );
  await session.batch([...statements, input.scope.prepareMutationFence()]);
  const current = await readProviderAttempt({
    db: session,
    organisationId: input.attempt.organisationId,
    attemptId: input.attempt.attemptId,
  });
  if (!current.ok || current.value.kind !== "failed") {
    throw new Error("provider attempt failure persistence invariant failed");
  }
  return { ok: true, value: current.value };
}

function providerAttemptReceiptReferences(
  attempt: ProviderConnectionAttempt,
): Readonly<Record<string, string>> {
  switch (attempt.kind) {
    case "created":
    case "authorizing":
    case "cancelled":
    case "failed":
    case "expired":
      return { attempt_id: attempt.attemptId };
    case "callback_received":
      return {
        attempt_id: attempt.attemptId,
        callback_receipt_id: attempt.callbackReceiptId,
      };
    case "provisioning":
    case "connected":
      return {
        attempt_id: attempt.attemptId,
        callback_receipt_id: attempt.callbackReceiptId,
        provisioning_attempt_id: attempt.provisioningAttemptId,
      };
  }
}

export async function cancelProviderAttempt(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly attemptId: ProviderConnectionAttemptId;
  readonly actorUserId: UserId;
  readonly reasonCode: "authorization_cancelled" | "support_admin_invalidated";
  readonly mutation: ProviderAttemptMutation;
  readonly now: number;
}): Promise<
  Result<
    {
      readonly attempt: Variant<ProviderConnectionAttempt, "cancelled">;
      readonly receiptId: string;
    },
    ProviderAttemptError
  >
> {
  const session = input.db.withSession("first-primary");
  const organisation = await readOrganisationVersion(session, input.organisationId);
  if (organisation === null) {
    return { ok: false, error: { code: "provider_attempt_not_found" } };
  }
  if (
    organisation.configurationVersion !==
    input.mutation.boundary.expectedConfigurationVersion
  ) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  const current = await readProviderAttempt({
    db: session,
    organisationId: input.organisationId,
    attemptId: input.attemptId,
  });
  if (!current.ok) {
    return current;
  }
  if (!isOpenAttempt(current.value)) {
    return { ok: false, error: { code: "provider_attempt_terminal" } };
  }
  const projectionRevision = organisation.projectionRevision + 1;
  const responseBody = {
    receipt_id: input.mutation.identity.receiptId,
    organisation_id: input.organisationId,
    attempt_id: input.attemptId,
  };
  const eventIdentity = providerEventIdentity(input.mutation.identity);
  const results = await session.batch([
    session
      .prepare(
        `UPDATE provider_connection_attempt
       SET lifecycle = 'cancelled', cancelled_by_user_id = ?,
           cancelled_at = ?, completed_at = ?, updated_at = ?
       WHERE organisation_id = ? AND attempt_id = ?
         AND lifecycle IN ('created', 'authorizing', 'callback_received', 'provisioning')`,
      )
      .bind(
        input.actorUserId,
        input.now,
        input.now,
        input.now,
        input.organisationId,
        input.attemptId,
      ),
    invalidateAuthorizationStateStatement(
      session,
      input.attemptId,
      input.now,
      "cancelled",
    ),
    prepareProjectionRevisionBump(session, input.organisationId, { atConfigurationVersion: organisation.configurationVersion }),
    prepareControlMutationReceipt(session, {
      scope: input.mutation.scope,
      boundary: input.mutation.boundary,
      identity: input.mutation.identity,
      responseStatus: 200,
      responseBody,
    }),
    prepareOnboardingAuditEvent(session, input.mutation.identity, {
      organisationId: input.organisationId,
      environment: organisation.environment,
      actorUserId: input.actorUserId,
      operation: "provider.attempt.cancel",
      targetKind: "provider_connection_attempt",
      targetId: input.attemptId,
      oldLifecycle: current.value.kind,
      newLifecycle: "cancelled",
      configurationVersion: organisation.configurationVersion,
      projectionRevision,
      reasonCode: input.reasonCode,
    }),
    prepareOnboardingEvent(session, eventIdentity, {
      eventId: eventIdentity.auditEventId,
      eventType: "provider_attempt_cancelled",
      organisationId: input.organisationId,
      environment: organisation.environment,
      projectionRevision,
      attributes: {
        attempt_id: input.attemptId,
        provider: current.value.provider,
      },
    }),
  ]);
  if (results[0]?.meta.changes !== 1) {
    return { ok: false, error: { code: "provider_attempt_state_conflict" } };
  }
  const cancelled = await readProviderAttempt({
    db: session,
    organisationId: input.organisationId,
    attemptId: input.attemptId,
  });
  if (!cancelled.ok || cancelled.value.kind !== "cancelled") {
    throw new Error(
      "provider attempt cancellation persistence invariant failed",
    );
  }
  return {
    ok: true,
    value: {
      attempt: cancelled.value,
      receiptId: input.mutation.identity.receiptId,
    },
  };
}

export function providerAttemptWire(
  attempt: ProviderConnectionAttempt,
): ProviderAttemptWire {
  return {
    attempt_id: attempt.attemptId,
    organisation_id: attempt.organisationId,
    provider: attempt.provider,
    environment: attempt.environment,
    existing_integration_account_id: attempt.existingIntegrationAccountId,
    purpose: attempt.purpose,
    state: providerAttemptStateWire(attempt),
    expires_at: attempt.expiresAt,
    created_at: attempt.createdAt,
    updated_at: attempt.updatedAt,
  };
}

function providerAttemptStateWire(
  attempt: ProviderConnectionAttempt,
): ProviderAttemptStateWire {
  switch (attempt.kind) {
    case "created":
      return { kind: "created" };
    case "authorizing":
      return {
        kind: "authorizing",
        authorization_started_at: attempt.authorizationStartedAt,
      };
    case "callback_received":
      return {
        kind: "callback_received",
        callback_receipt_id: attempt.callbackReceiptId,
        received_at: attempt.callbackReceivedAt,
      };
    case "provisioning":
      return {
        kind: "provisioning",
        provisioning_attempt_id: attempt.provisioningAttemptId,
        phase: attempt.provisioningPhase,
        started_at: attempt.provisioningStartedAt,
      };
    case "connected":
      return {
        kind: "connected",
        connection_id: attempt.connectionId,
        integration_account_ids: attempt.integrationAccountIds,
        completed_at: attempt.completedAt,
      };
    case "cancelled":
      return {
        kind: "cancelled",
        cancelled_by: attempt.cancelledByUserId,
        cancelled_at: attempt.cancelledAt,
      };
    case "failed":
      return {
        kind: "failed",
        reason_code: attempt.reasonCode,
        retryable: attempt.retryable,
        correlation_id: attempt.correlationId,
        failed_at: attempt.failedAt,
      };
    case "expired":
      return { kind: "expired", expired_at: attempt.expiredAt };
  }
}

function isOpenAttempt(attempt: ProviderConnectionAttempt): boolean {
  switch (attempt.kind) {
    case "created":
    case "authorizing":
    case "callback_received":
    case "provisioning":
      return true;
    case "connected":
    case "cancelled":
    case "failed":
    case "expired":
      return false;
  }
}

function requireProviderAttempt(
  row: ProviderAttemptRow,
): ProviderConnectionAttempt {
  const attemptId = parseStringId(
    row.attemptId,
    parseProviderConnectionAttemptId,
    "attempt_id",
  );
  const organisationId = parseStringId(row.organisationId, parseOrganisationId, "organisation_id");
  const provider = requireProvider(row.provider);
  const environment = requireEnvironment(row.environment);
  const userId = parseStringId(
    row.userId,
    parseUserId,
    "user_id",
  );
  const existingIntegrationAccountId =
    row.existingIntegrationAccountId === null
      ? null
      : parseStringId(
          row.existingIntegrationAccountId,
          parseIntegrationAccountId,
          "existing_integration_account_id",
        );
  const base: ProviderAttemptBase = {
    attemptId,
    organisationId,
    provider,
    environment,
    userId,
    existingIntegrationAccountId,
    purpose: requireAttemptPurpose(row.purpose),
    expiresAt: requireNumber(row.expiresAt, "expires_at"),
    createdAt: requireNumber(row.createdAt, "created_at"),
    updatedAt: requireNumber(row.updatedAt, "updated_at"),
  };
  switch (row.lifecycle) {
    case "created":
      return {
        kind: "created",
        attemptId: base.attemptId,
        organisationId: base.organisationId,
        provider: base.provider,
        environment: base.environment,
        userId: base.userId,
        existingIntegrationAccountId: base.existingIntegrationAccountId,
        purpose: base.purpose,
        expiresAt: base.expiresAt,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
      };
    case "authorizing":
      return {
        kind: "authorizing",
        attemptId: base.attemptId,
        organisationId: base.organisationId,
        provider: base.provider,
        environment: base.environment,
        userId: base.userId,
        existingIntegrationAccountId: base.existingIntegrationAccountId,
        purpose: base.purpose,
        expiresAt: base.expiresAt,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        providerStateId: parseStringId(
          row.providerStateId,
          parseProviderStateId,
          "provider_state_id",
        ),
        authorizationStartedAt: requireNumber(
          row.authorizationStartedAt,
          "authorization_started_at",
        ),
      };
    case "callback_received":
      return {
        kind: "callback_received",
        attemptId: base.attemptId,
        organisationId: base.organisationId,
        provider: base.provider,
        environment: base.environment,
        userId: base.userId,
        existingIntegrationAccountId: base.existingIntegrationAccountId,
        purpose: base.purpose,
        expiresAt: base.expiresAt,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        providerStateId: parseStringId(
          row.providerStateId,
          parseProviderStateId,
          "provider_state_id",
        ),
        authorizationStartedAt: requireNumber(
          row.authorizationStartedAt,
          "authorization_started_at",
        ),
        callbackReceiptId: requireString(
          row.callbackReceiptId,
          "callback_receipt_id",
        ),
        callbackReceivedAt: requireNumber(
          row.callbackReceivedAt,
          "callback_received_at",
        ),
      };
    case "provisioning":
      return buildProvisioningAttempt(base, row);
    case "connected":
      return buildConnectedAttempt(base, row);
    case "cancelled":
      return {
        kind: "cancelled",
        attemptId: base.attemptId,
        organisationId: base.organisationId,
        provider: base.provider,
        environment: base.environment,
        userId: base.userId,
        existingIntegrationAccountId: base.existingIntegrationAccountId,
        purpose: base.purpose,
        expiresAt: base.expiresAt,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        cancelledByUserId: parseStringId(
          row.cancelledByUserId,
          parseUserId,
          "cancelled_by_user_id",
        ),
        cancelledAt: requireNumber(row.cancelledAt, "cancelled_at"),
        completedAt: requireNumber(row.completedAt, "completed_at"),
      };
    case "failed":
      return {
        kind: "failed",
        attemptId: base.attemptId,
        organisationId: base.organisationId,
        provider: base.provider,
        environment: base.environment,
        userId: base.userId,
        existingIntegrationAccountId: base.existingIntegrationAccountId,
        purpose: base.purpose,
        expiresAt: base.expiresAt,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        reasonCode: requireString(row.failureReasonCode, "failure_reason_code"),
        retryable: requireBooleanInteger(
          row.failureRetryable,
          "failure_retryable",
        ),
        correlationId: requireString(
          row.failureCorrelationId,
          "failure_correlation_id",
        ),
        failedAt: requireNumber(row.failedAt, "failed_at"),
        completedAt: requireNumber(row.completedAt, "completed_at"),
      };
    case "expired":
      return {
        kind: "expired",
        attemptId: base.attemptId,
        organisationId: base.organisationId,
        provider: base.provider,
        environment: base.environment,
        userId: base.userId,
        existingIntegrationAccountId: base.existingIntegrationAccountId,
        purpose: base.purpose,
        expiresAt: base.expiresAt,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        expiredAt: requireNumber(row.completedAt, "completed_at"),
        completedAt: requireNumber(row.completedAt, "completed_at"),
      };
    default:
      throw new Error("provider attempt lifecycle is invalid");
  }
}

function buildProvisioningAttempt(
  base: ProviderAttemptBase,
  row: ProviderAttemptRow,
): ProvisioningProviderConnectionAttempt {
  return {
    kind: "provisioning",
    attemptId: base.attemptId,
    organisationId: base.organisationId,
    provider: base.provider,
    environment: base.environment,
    userId: base.userId,
    existingIntegrationAccountId: base.existingIntegrationAccountId,
    purpose: base.purpose,
    expiresAt: base.expiresAt,
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
    providerStateId: parseStringId(
      row.providerStateId,
      parseProviderStateId,
      "provider_state_id",
    ),
    authorizationStartedAt: requireNumber(
      row.authorizationStartedAt,
      "authorization_started_at",
    ),
    callbackReceiptId: requireString(
      row.callbackReceiptId,
      "callback_receipt_id",
    ),
    callbackReceivedAt: requireNumber(
      row.callbackReceivedAt,
      "callback_received_at",
    ),
    provisioningAttemptId: parseStringId(
      row.provisioningAttemptId,
      parseProviderProvisioningAttemptId,
      "provisioning_attempt_id",
    ),
    provisioningPhase: requireProvisioningPhase(row.provisioningPhase),
    provisioningStartedAt: requireNumber(
      row.provisioningStartedAt,
      "provisioning_started_at",
    ),
  };
}

function buildConnectedAttempt(
  base: ProviderAttemptBase,
  row: ProviderAttemptRow,
): Variant<ProviderConnectionAttempt, "connected"> {
  const provisioning = buildProvisioningAttempt(base, row);
  return {
    kind: "connected",
    attemptId: base.attemptId,
    organisationId: base.organisationId,
    provider: base.provider,
    environment: base.environment,
    userId: base.userId,
    existingIntegrationAccountId: base.existingIntegrationAccountId,
    purpose: base.purpose,
    expiresAt: base.expiresAt,
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
    providerStateId: provisioning.providerStateId,
    authorizationStartedAt: provisioning.authorizationStartedAt,
    callbackReceiptId: provisioning.callbackReceiptId,
    callbackReceivedAt: provisioning.callbackReceivedAt,
    provisioningAttemptId: provisioning.provisioningAttemptId,
    provisioningPhase: provisioning.provisioningPhase,
    provisioningStartedAt: provisioning.provisioningStartedAt,
    connectionId: parseStringId(
      row.connectionId,
      parseProviderConnectionId,
      "connection_id",
    ),
    integrationAccountIds: requireIntegrationAccountIds(
      row.integrationAccountIds,
    ),
    completedAt: requireNumber(row.completedAt, "completed_at"),
  };
}

function requireIntegrationAccountIds(
  raw: unknown,
): readonly IntegrationAccountId[] {
  const value = requireJson(raw, "integration_account_ids");
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("provider attempt integration_account_ids is invalid");
  }
  const ids: IntegrationAccountId[] = [];
  for (const item of value) {
    ids.push(
      parseStringId(item, parseIntegrationAccountId, "integration_account_ids"),
    );
  }
  return ids;
}

function parseAuthorizationState(row: AuthorizationStateRow | null): Result<
  {
    readonly attemptId: ProviderConnectionAttemptId;
    readonly organisationId: OrganisationId;
    readonly provider: ConnectionProvider;
    readonly environment: OrganisationEnvironment;
    readonly userId: UserId;
    readonly portalSubjectHash: string;
    readonly pkceVerifier: string | null;
    readonly providerContext: string;
    readonly returnPath: string;
    readonly expiresAt: number;
    readonly consumedAt: number | null;
    readonly callbackCodeHash: string | null;
    readonly callbackReceiptId: string | null;
    readonly invalidatedAt: number | null;
    readonly invalidationReason: string | null;
  },
  ProviderAttemptError
> {
  if (row === null) {
    return { ok: false, error: { code: "provider_state_invalid" } };
  }
  try {
    return {
      ok: true,
      value: {
        attemptId: parseStringId(
          row.attemptId,
          parseProviderConnectionAttemptId,
          "attempt_id",
        ),
        organisationId: parseStringId(row.organisationId, parseOrganisationId, "organisation_id"),
        provider: requireProvider(row.provider),
        environment: requireEnvironment(row.environment),
        userId: parseStringId(
          row.userId,
          parseUserId,
          "user_id",
        ),
        portalSubjectHash: requireString(
          row.portalSubjectHash,
          "portal_subject_hash",
        ),
        pkceVerifier: nullableString(row.pkceVerifier, "pkce_verifier"),
        providerContext: requireString(row.providerContext, "provider_context"),
        returnPath: requireString(row.returnPath, "return_path"),
        expiresAt: requireNumber(row.expiresAt, "expires_at"),
        consumedAt: nullableNumber(row.consumedAt, "consumed_at"),
        callbackCodeHash: nullableString(
          row.callbackCodeHash,
          "callback_code_hash",
        ),
        callbackReceiptId: nullableString(
          row.callbackReceiptId,
          "callback_receipt_id",
        ),
        invalidatedAt: nullableNumber(row.invalidatedAt, "invalidated_at"),
        invalidationReason: nullableString(
          row.invalidationReason,
          "invalidation_reason",
        ),
      },
    };
  } catch {
    return { ok: false, error: { code: "provider_state_invalid" } };
  }
}

function invalidateAuthorizationStateStatement(
  db: OrganisationQuerySource,
  attemptId: ProviderConnectionAttemptId,
  now: number,
  reason: "cancelled" | "connected" | "expired" | "failed",
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_authorization_state
     SET invalidated_at = COALESCE(invalidated_at, ?),
         invalidation_reason = COALESCE(invalidation_reason, ?)
     WHERE attempt_id = ?`,
    )
    .bind(now, reason, attemptId);
}

async function readOrganisationVersion(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<{
  readonly environment: OrganisationEnvironment;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
} | null> {
  const row = await db
    .prepare(
      `SELECT environment, configuration_version AS configurationVersion,
            projection_revision AS projectionRevision
     FROM organisation_onboarding WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<OrganisationVersionRow>();
  if (row === null) {
    return null;
  }
  return {
    environment: requireEnvironment(row.environment),
    configurationVersion: requirePositiveInteger(
      row.configurationVersion,
      "configuration_version",
    ),
    projectionRevision: requirePositiveInteger(
      row.projectionRevision,
      "projection_revision",
    ),
  };
}

const CONNECTION_PROVIDERS: Readonly<Record<ConnectionProvider, true>> = {
  airtable: true,
  dropbox: true,
  gmail: true,
  google_drive: true,
  notion: true,
  shopify: true,
  slack: true,
  square: true,
  stripe: true,
  whatsapp: true,
};

function isConnectionProvider(raw: unknown): raw is ConnectionProvider {
  return typeof raw === "string" && Object.hasOwn(CONNECTION_PROVIDERS, raw);
}

export function parseConnectionProvider(
  raw: unknown,
): ConnectionProvider | null {
  return isConnectionProvider(raw) ? raw : null;
}

function requireProvider(raw: unknown): ConnectionProvider {
  const provider = parseConnectionProvider(raw);
  if (provider !== null) return provider;
  throw new Error("provider attempt provider is invalid");
}

function requireAttemptPurpose(raw: unknown): ProviderAttemptBase["purpose"] {
  if (raw === "connect" || raw === "reconnect" || raw === "rotate") {
    return raw;
  }
  throw new Error("provider attempt purpose is invalid");
}

function requireEnvironment(raw: unknown): OrganisationEnvironment {
  if (raw === "development" || raw === "production") {
    return raw;
  }
  throw new Error("provider attempt environment is invalid");
}

function requireProvisioningPhase(raw: unknown): ProviderProvisioningPhase {
  switch (raw) {
    case "discovering_identity":
    case "persisting_credential":
    case "discovering_accounts":
    case "reconciling_webhooks":
    case "discovering_resources":
    case "verifying_connection":
    case "finalizing":
      return raw;
    default:
      throw new Error("provider provisioning phase is invalid");
  }
}

function parseStringId<TValue>(
  raw: unknown,
  parser: (value: string) => Result<TValue, unknown>,
  field: string,
): TValue {
  if (typeof raw !== "string") {
    throw new Error(`provider attempt ${field} is invalid`);
  }
  const parsed = parser(raw);
  if (!parsed.ok) {
    throw new Error(`provider attempt ${field} is invalid`);
  }
  return parsed.value;
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`provider attempt ${field} is invalid`);
  }
  return raw;
}

function nullableString(raw: unknown, field: string): string | null {
  return raw === null ? null : requireString(raw, field);
}

function requireNumber(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`provider attempt ${field} is invalid`);
  }
  return raw;
}

function nullableNumber(raw: unknown, field: string): number | null {
  return raw === null ? null : requireNumber(raw, field);
}

function requirePositiveInteger(raw: unknown, field: string): number {
  const value = requireNumber(raw, field);
  if (value < 1) {
    throw new Error(`provider attempt ${field} is invalid`);
  }
  return value;
}

function requireBooleanInteger(raw: unknown, field: string): boolean {
  if (raw === 0) {
    return false;
  }
  if (raw === 1) {
    return true;
  }
  throw new Error(`provider attempt ${field} is invalid`);
}

function requireJson(raw: unknown, field: string): unknown {
  if (typeof raw !== "string") {
    throw new Error(`provider attempt ${field} is invalid`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`provider attempt ${field} is invalid`);
  }
}

function providerEventIdentity(
  identity: ControlMutationIdentity,
): ControlMutationIdentity {
  return {
    receiptId: identity.receiptId,
    auditEventId: `event_${crypto.randomUUID()}`,
    correlationId: identity.correlationId,
    causationId: identity.causationId,
    portalSubjectHash: identity.portalSubjectHash,
    createdAt: identity.createdAt,
  };
}

function callbackEventIdentity(
  userId: UserId,
  portalSubjectHash: string,
  now: number,
  correlationId = `correlation_${crypto.randomUUID()}`,
): ControlMutationIdentity {
  return {
    receiptId: `provider_callback_receipt_${crypto.randomUUID()}`,
    auditEventId: `event_${crypto.randomUUID()}`,
    correlationId,
    causationId: `provider_callback_${crypto.randomUUID()}`,
    portalSubjectHash:
      portalSubjectHash.length > 0
        ? portalSubjectHash
        : `app_user:${userId}`,
    createdAt: now,
  };
}
