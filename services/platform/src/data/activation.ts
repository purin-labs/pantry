import type { OrganisationDatabase } from "../database-handles";
import {
  prepareOrganisationLifecycleMove,
  type LifecycleFence,
} from "./organisation-lifecycle-moves";
import type {
  FirstOperationalTask,
  OnboardingActivationPhase,
} from "@purin-labs/contracts";

import {
  newActivationAttemptId,
  newActivationReceiptId,
  parseActivationAttemptId,
  parseActivationReceiptId,
  parseChannelId,
  parseSetupSnapshotId,
  parseWorkspaceId,
  type ActivationAttemptId,
  type ActivationReceiptId,
  type ChannelId,
  type SetupSnapshotId,
  type OrganisationId,
  type WorkspaceId,
} from "../ids";
import type { Result } from "../result";
import type { OrganisationEnvironment } from "./control-plane";
import {
  prepareControlMutationReceipt,
  prepareOnboardingAuditEvent,
  prepareOnboardingEvent,
  readControlMutationReplay,
  type ControlMutationBoundary,
  type ControlMutationIdentity,
  type ControlMutationReceiptScope,
} from "./control-mutation";
import type { CapabilityProfile } from "./onboarding";
import {
  prepareResolveOpenSupportReferences,
} from "../organisation/contract/provider-support-references";
import {
  deriveFirstOperationalTask,
  prepareFirstOperationalTask,
  readFirstOperationalTask,
} from "./first-operational-task";
import type { Variant } from "@purin-labs/type-utils";
import { positiveIntegerOrNull } from "@purin-labs/std";

export type ActivationStep =
  "readiness" | "placement" | "policy" | "cues" | "accounts" | "publish";

export type ActivationMutation = {
  readonly boundary: Variant<
    ControlMutationBoundary,
    "configuration_versioned"
  >;
  readonly scope: ControlMutationReceiptScope;
  readonly identity: ControlMutationIdentity;
};

export type OnboardingActivationInput = {
  readonly organisationId: OrganisationId;
  readonly readinessVersion: number;
  readonly readinessHash: string;
  readonly mutation: ActivationMutation;
  readonly now: number;
};

export type CueActivationSelection = {
  readonly presetId:
    "observe_commerce" | "commerce_operator" | "proactive_triage";
  readonly workspaceId: WorkspaceId;
  readonly channelId: ChannelId;
};

export type ActivationContext = {
  readonly attemptId: ActivationAttemptId;
  readonly organisationId: OrganisationId;
  readonly organisationName: string;
  readonly readinessVersion: number;
  readonly readinessHash: string;
  readonly environment: OrganisationEnvironment;
  readonly capabilityProfile: CapabilityProfile;
  readonly policySnapshotId: SetupSnapshotId;
  readonly cueSnapshotId: SetupSnapshotId;
  readonly cueSelection: CueActivationSelection;
  readonly completedSteps: ReadonlySet<ActivationStep>;
  readonly mutation: ActivationMutation;
  /** The placement that the Organisation Actor admitted the activation under. */
  readonly fence: LifecycleFence;
};

export type ActivationReceipt = {
  readonly activationReceiptId: ActivationReceiptId;
  readonly activationAttemptId: ActivationAttemptId;
  readonly organisationId: OrganisationId;
  readonly readinessHash: string;
  readonly environment: OrganisationEnvironment;
  readonly policySnapshotId: SetupSnapshotId;
  readonly cueSnapshotId: SetupSnapshotId;
  readonly capabilityProfile: CapabilityProfile;
  readonly firstTask: FirstOperationalTask;
  readonly activatedAt: number;
};

type ActivationStart =
  | { readonly kind: "run"; readonly context: ActivationContext }
  | { readonly kind: "completed"; readonly receipt: ActivationReceipt };

type ActivationError =
  | {
      readonly code: "activation_readiness_stale";
      readonly detail: ActivationStaleDetail;
    }
  | { readonly code: "activation_state_invalid" }
  | { readonly code: "activation_attempt_corrupt" }
  | { readonly code: "activation_attempt_in_progress" };

type ActivationStaleDetail =
  | "readiness_assessment_missing"
  | "configuration_changed_since_assessment"
  | "client_configuration_stale"
  | "assessment_environment_mismatch"
  | "organisation_lifecycle_incompatible";

export type ActivationFailureReceipt = {
  readonly reasonCode: string;
  readonly retryable: boolean;
  readonly correlationId: string;
  readonly supportReference: string;
  readonly mutationReceiptId: string;
};

type ActivationRow = {
  lifecycle: unknown;
  organisationName: unknown;
  readinessVersion: unknown;
  readinessHash: unknown;
  capabilityProfile: unknown;
  activationAttemptId: unknown;
  policySnapshotId: unknown;
  cueSnapshotId: unknown;
  cuePresetId: unknown;
  cueWorkspaceId: unknown;
  cueChannelId: unknown;
  attemptStatus: unknown;
  leaseOwner: unknown;
  leaseExpiresAt: unknown;
  environment: unknown;
  assessmentEnvironment: unknown;
  configurationVersion: unknown;
  assessmentConfigurationVersion: unknown;
  projectionRevision: unknown;
};

const ACTIVATION_LEASE_MS = 5 * 60 * 1_000;

type ReceiptRow = {
  activationReceiptId: unknown;
  activationAttemptId: unknown;
  organisationId: unknown;
  readinessHash: unknown;
  policySnapshotId: unknown;
  cueSnapshotId: unknown;
  capabilityProfile: unknown;
  activatedAt: unknown;
  environment: unknown;
};

export async function beginOnboardingActivation(input: {
  readonly db: OrganisationDatabase;
  readonly request: OnboardingActivationInput;
  readonly fence: LifecycleFence;
}): Promise<Result<ActivationStart, ActivationError>> {
  const existingReceipt = await readActivationReceiptByHash(
    input.db,
    input.request.organisationId,
    input.request.readinessHash,
  );
  if (existingReceipt !== null) {
    await recordCompletedActivationMutation(
      input.db,
      input.request,
      existingReceipt,
    );
    return { ok: true, value: { kind: "completed", receipt: existingReceipt } };
  }
  const row = await readActivationRow(
    input.db,
    input.request.organisationId,
    input.request.readinessVersion,
    input.request.readinessHash,
  );
  const parsed = parseActivationRow(row, input.request);
  if (!parsed.ok) {
    return parsed;
  }
  const attemptId = parsed.value.attemptId ?? newActivationAttemptId();
  const session = input.db.withSession("first-primary");
  const isResume = parsed.value.attemptId !== null;
  const projectionRevision = parsed.value.projectionRevision + 1;
  const lifecycleIdentity = activationEvidenceIdentity(
    input.request.mutation.identity,
    isResume ? "resume" : "start",
  );
  await session.batch([
    session
      .prepare(
        `INSERT INTO organisation_activation_attempt (
         activation_attempt_id, organisation_id, readiness_version, readiness_hash, status,
         failure_code, retryable, started_at, updated_at, completed_at, environment,
         lease_owner, lease_expires_at
       ) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT (organisation_id, readiness_hash) DO UPDATE SET
         status = 'running', failure_code = NULL, retryable = NULL,
         updated_at = excluded.updated_at, completed_at = NULL,
         lease_owner = excluded.lease_owner, lease_expires_at = excluded.lease_expires_at`,
      )
      .bind(
        attemptId,
        input.request.organisationId,
        input.request.readinessVersion,
        input.request.readinessHash,
        input.request.now,
        input.request.now,
        parsed.value.environment,
        input.request.mutation.identity.causationId,
        input.request.now + ACTIVATION_LEASE_MS,
      ),
    prepareOrganisationLifecycleMove(session, {
      organisationId: input.request.organisationId,
      event: "start_activation",
      from: ["configuring", "activating"],
      fence: input.fence,
      set: {
        sql: `activation_attempt_id = ?, readiness_version = ?,
           activation_receipt_id = NULL, activated_at = NULL,
           suspension_reason_code = NULL, suspended_at = NULL,
           archived_at = NULL, purge_after = NULL,
           projection_revision = projection_revision + 1`,
        bindings: [attemptId, input.request.readinessVersion],
      },
      guard: { sql: "environment = ?", bindings: [parsed.value.environment] },
      now: input.request.now,
    }),
    prepareOnboardingAuditEvent(session, lifecycleIdentity, {
      organisationId: input.request.organisationId,
      environment: parsed.value.environment,
      actorUserId: input.request.mutation.scope.userId,
      operation: isResume
        ? "organisation.activation.resume"
        : "organisation.activation.start",
      targetKind: "organisation_activation_attempt",
      targetId: attemptId,
      oldLifecycle: isResume ? "activating" : "configuring",
      newLifecycle: "activating",
      configurationVersion:
        input.request.mutation.boundary.expectedConfigurationVersion,
      projectionRevision,
      reasonCode: isResume ? "activation_resumed" : "activation_started",
    }),
    prepareOnboardingEvent(session, lifecycleIdentity, {
      eventId: `${input.request.mutation.identity.auditEventId}:${isResume ? "resume" : "start"}`,
      eventType: isResume ? "onboarding_resumed" : "activation_started",
      organisationId: input.request.organisationId,
      environment: parsed.value.environment,
      projectionRevision,
      attributes: {
        activation_attempt_id: attemptId,
        readiness_version: input.request.readinessVersion,
      },
    }),
  ]);
  const completedSteps = await readCompletedSteps(input.db, attemptId);
  return {
    ok: true,
    value: {
      kind: "run",
      context: {
        attemptId,
        organisationId: input.request.organisationId,
        organisationName: parsed.value.organisationName,
        readinessVersion: input.request.readinessVersion,
        readinessHash: input.request.readinessHash,
        environment: parsed.value.environment,
        capabilityProfile: parsed.value.capabilityProfile,
        policySnapshotId: parsed.value.policySnapshotId,
        cueSnapshotId: parsed.value.cueSnapshotId,
        cueSelection: parsed.value.cueSelection,
        completedSteps,
        mutation: input.request.mutation,
        fence: input.fence,
      },
    },
  };
}

export async function checkpointActivationStep(input: {
  readonly db: OrganisationDatabase;
  readonly context: ActivationContext;
  readonly step: ActivationStep;
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly now: number;
}): Promise<void> {
  const session = input.db.withSession("first-primary");
  const current = await session
    .prepare(
      `SELECT projection_revision AS projectionRevision
     FROM organisation_onboarding
     WHERE organisation_id = ? AND activation_attempt_id = ?`,
    )
    .bind(input.context.organisationId, input.context.attemptId)
    .first<{ readonly projectionRevision: unknown }>();
  if (current === null || typeof current.projectionRevision !== "number") {
    throw new Error("activation checkpoint projection is missing");
  }
  const projectionRevision = current.projectionRevision + 1;
  await session.batch([
    session
      .prepare(
        `INSERT OR IGNORE INTO organisation_activation_step (
         activation_attempt_id, step, status, receipt, completed_at
       ) VALUES (?, ?, 'completed', ?, ?)`,
      )
      .bind(
        input.context.attemptId,
        input.step,
        JSON.stringify(input.receipt),
        input.now,
      ),
    session
      .prepare(
        `UPDATE organisation_activation_attempt
       SET updated_at = ?, lease_owner = ?, lease_expires_at = ?
       WHERE activation_attempt_id = ? AND status = 'running'`,
      )
      .bind(
        input.now,
        input.context.mutation.identity.causationId,
        input.now + ACTIVATION_LEASE_MS,
        input.context.attemptId,
      ),
    session
      .prepare(
        `UPDATE organisation_onboarding
       SET projection_revision = projection_revision + 1, updated_at = ?
       WHERE activation_attempt_id = ?`,
      )
      .bind(input.now, input.context.attemptId),
    prepareOnboardingEvent(session, input.context.mutation.identity, {
      eventId: `event_${input.context.attemptId}_${input.step}`,
      eventType: "activation_phase_completed",
      organisationId: input.context.organisationId,
      environment: input.context.environment,
      projectionRevision,
      attributes: {
        activation_attempt_id: input.context.attemptId,
        phase: activationPhase(input.step),
      },
    }),
  ]);
}

export async function completeOnboardingActivation(input: {
  readonly db: OrganisationDatabase;
  readonly context: ActivationContext;
  readonly now: number;
}): Promise<ActivationReceipt> {
  const existing = await readActivationReceiptByHash(
    input.db,
    input.context.organisationId,
    input.context.readinessHash,
  );
  if (existing !== null) {
    return existing;
  }
  const activationReceiptId = newActivationReceiptId();
  const firstTask = await deriveFirstOperationalTask(
    input.db,
    input.context.organisationId,
  );
  const session = input.db.withSession("first-primary");
  const current = await session
    .prepare(
      `SELECT projection_revision AS projectionRevision,
            configuration_version AS configurationVersion
     FROM organisation_onboarding
     WHERE organisation_id = ? AND activation_attempt_id = ?`,
    )
    .bind(input.context.organisationId, input.context.attemptId)
    .first<{
      readonly projectionRevision: unknown;
      readonly configurationVersion: unknown;
    }>();
  if (
    current === null ||
    typeof current.projectionRevision !== "number" ||
    typeof current.configurationVersion !== "number"
  ) {
    throw new Error("activation completion fence is missing");
  }
  const projectionRevision = current.projectionRevision + 1;
  const mutationResponseBody = activationMutationReceiptBody(
    input.context.mutation.identity.receiptId,
    input.context.organisationId,
    activationReceiptId,
    firstTask,
  );
  const succeededIdentity = activationEvidenceIdentity(
    input.context.mutation.identity,
    "succeeded",
  );
  await session.batch([
    session
      .prepare(
        `INSERT INTO organisation_activation_receipt (
         activation_receipt_id, activation_attempt_id, organisation_id, readiness_hash,
         policy_snapshot_id, cue_snapshot_id, capability_profile, activated_at, environment
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        activationReceiptId,
        input.context.attemptId,
        input.context.organisationId,
        input.context.readinessHash,
        input.context.policySnapshotId,
        input.context.cueSnapshotId,
        input.context.capabilityProfile,
        input.now,
        input.context.environment,
      ),
    prepareFirstOperationalTask(
      session,
      activationReceiptId,
      firstTask,
      input.now,
    ),
    session
      .prepare(
        `UPDATE organisation_activation_attempt SET status = 'completed', failure_code = NULL,
         retryable = NULL, updated_at = ?, completed_at = ?,
         lease_owner = NULL, lease_expires_at = NULL
       WHERE activation_attempt_id = ?`,
      )
      .bind(input.now, input.now, input.context.attemptId),
    prepareOrganisationLifecycleMove(session, {
      organisationId: input.context.organisationId,
      event: "activate",
      from: ["activating"],
      fence: input.context.fence,
      set: {
        sql: `activation_attempt_id = NULL, readiness_version = NULL,
         activated_at = ?, activation_receipt_id = ?,
         projection_revision = projection_revision + 1`,
        bindings: [input.now, activationReceiptId],
      },
      guard: {
        sql: "activation_attempt_id = ?",
        bindings: [input.context.attemptId],
      },
      now: input.now,
    }),
    prepareResolveOpenSupportReferences(session, {
      organisationId: input.context.organisationId,
      now: input.now,
    }),
    prepareControlMutationReceipt(session, {
      scope: input.context.mutation.scope,
      boundary: input.context.mutation.boundary,
      identity: input.context.mutation.identity,
      responseStatus: 200,
      responseBody: mutationResponseBody,
    }),
    prepareOnboardingAuditEvent(session, succeededIdentity, {
      organisationId: input.context.organisationId,
      environment: input.context.environment,
      actorUserId: input.context.mutation.scope.userId,
      operation: "organisation.activation.succeed",
      targetKind: "organisation_activation_attempt",
      targetId: input.context.attemptId,
      oldLifecycle: "activating",
      newLifecycle: "active",
      configurationVersion: current.configurationVersion,
      projectionRevision,
      reasonCode: "activation_succeeded",
    }),
    prepareOnboardingEvent(session, succeededIdentity, {
      eventId: `${input.context.mutation.identity.auditEventId}:activation_succeeded`,
      eventType: "activation_succeeded",
      organisationId: input.context.organisationId,
      environment: input.context.environment,
      projectionRevision,
      attributes: {
        activation_attempt_id: input.context.attemptId,
        activation_receipt_id: activationReceiptId,
      },
    }),
    prepareOnboardingEvent(session, succeededIdentity, {
      eventId: `${input.context.mutation.identity.auditEventId}:first_task_presented`,
      eventType: "first_task_presented",
      organisationId: input.context.organisationId,
      environment: input.context.environment,
      projectionRevision,
      attributes: {
        activation_receipt_id: activationReceiptId,
        task_kind: firstTask.kind,
      },
    }),
    prepareOnboardingEvent(session, succeededIdentity, {
      eventId: `${input.context.mutation.identity.auditEventId}:stage_completed`,
      eventType: "onboarding_stage_completed",
      organisationId: input.context.organisationId,
      environment: input.context.environment,
      projectionRevision,
      attributes: {
        stage: "review_activation",
        receipt_id: activationReceiptId,
      },
    }),
  ]);
  return {
    activationReceiptId,
    activationAttemptId: input.context.attemptId,
    organisationId: input.context.organisationId,
    readinessHash: input.context.readinessHash,
    environment: input.context.environment,
    policySnapshotId: input.context.policySnapshotId,
    cueSnapshotId: input.context.cueSnapshotId,
    capabilityProfile: input.context.capabilityProfile,
    firstTask,
    activatedAt: input.now,
  };
}

export async function activatePendingIntegrationAccounts(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly now: number;
}): Promise<number> {
  const session = input.db.withSession("first-primary");
  const results = await session.batch([
    session
      .prepare(
        `UPDATE integration_account SET lifecycle = 'active', lifecycle_reason_code = NULL,
         updated_at = ? WHERE organisation_id = ? AND lifecycle = 'pending_activation'`,
      )
      .bind(input.now, input.organisationId),
    session
      .prepare(
        `UPDATE integration_account
       SET is_default_for_provider = 1, updated_at = ?
       WHERE organisation_id = ? AND lifecycle = 'active' AND is_default_for_provider = 0
         AND integration_account_id = (
           SELECT candidate.integration_account_id
           FROM integration_account AS candidate
           WHERE candidate.organisation_id = integration_account.organisation_id
             AND candidate.provider = integration_account.provider
             AND candidate.environment = integration_account.environment
             AND candidate.lifecycle = 'active'
           ORDER BY candidate.created_at, candidate.integration_account_id
           LIMIT 1
         )
         AND NOT EXISTS (
           SELECT 1
           FROM integration_account AS current_default
           WHERE current_default.organisation_id = integration_account.organisation_id
             AND current_default.provider = integration_account.provider
             AND current_default.environment = integration_account.environment
             AND current_default.is_default_for_provider = 1
         )`,
      )
      .bind(input.now, input.organisationId),
  ]);
  return results[0]?.meta.changes ?? 0;
}

export async function failOnboardingActivation(input: {
  readonly db: OrganisationDatabase;
  readonly context: ActivationContext;
  readonly failureCode: string;
  readonly retryable: boolean;
  readonly now: number;
}): Promise<ActivationFailureReceipt> {
  const retryable = input.retryable ? 1 : 0;
  const session = input.db.withSession("first-primary");
  const current = await session
    .prepare(
      `SELECT projection_revision AS projectionRevision,
            configuration_version AS configurationVersion
     FROM organisation_onboarding
     WHERE organisation_id = ? AND activation_attempt_id = ?`,
    )
    .bind(input.context.organisationId, input.context.attemptId)
    .first<{
      readonly projectionRevision: unknown;
      readonly configurationVersion: unknown;
    }>();
  if (
    current === null ||
    typeof current.projectionRevision !== "number" ||
    typeof current.configurationVersion !== "number"
  ) {
    throw new Error("activation failure fence is missing");
  }
  const projectionRevision = current.projectionRevision + 1;
  const correlationId = input.context.mutation.identity.correlationId;
  const supportReference = `SATYR-${crypto.randomUUID()}`;
  const completedSteps = await readCompletedSteps(
    input.db,
    input.context.attemptId,
  );
  const failedIdentity = activationEvidenceIdentity(
    input.context.mutation.identity,
    "failed",
  );
  const supportIdentity = activationEvidenceIdentity(
    input.context.mutation.identity,
    "support",
  );
  const responseBody = {
    kind: input.retryable ? "retryable_failure" : "terminal_failure",
    reason_code: input.failureCode,
    correlation_id: correlationId,
    support_reference: supportReference,
    receipt_id: input.context.mutation.identity.receiptId,
    organisation_id: input.context.organisationId,
  };
  await session.batch([
    session
      .prepare(
        `UPDATE organisation_activation_attempt SET status = 'failed', failure_code = ?, retryable = ?,
         updated_at = ?, completed_at = NULL,
         lease_owner = NULL, lease_expires_at = NULL WHERE activation_attempt_id = ?`,
      )
      .bind(input.failureCode, retryable, input.now, input.context.attemptId),
    prepareOrganisationLifecycleMove(session, {
      organisationId: input.context.organisationId,
      event: "fail_activation",
      from: ["activating"],
      fence: input.context.fence,
      set: {
        sql: `activation_attempt_id = NULL, readiness_version = NULL,
         projection_revision = projection_revision + 1`,
        bindings: [],
      },
      guard: {
        sql: "activation_attempt_id = ?",
        bindings: [input.context.attemptId],
      },
      now: input.now,
    }),
    prepareControlMutationReceipt(session, {
      scope: input.context.mutation.scope,
      boundary: input.context.mutation.boundary,
      identity: input.context.mutation.identity,
      responseStatus: input.retryable ? 503 : 422,
      responseBody,
    }),
    prepareOnboardingAuditEvent(session, failedIdentity, {
      organisationId: input.context.organisationId,
      environment: input.context.environment,
      actorUserId: input.context.mutation.scope.userId,
      operation: "organisation.activation.fail",
      targetKind: "organisation_activation_attempt",
      targetId: input.context.attemptId,
      oldLifecycle: "activating",
      newLifecycle: "configuring",
      configurationVersion: current.configurationVersion,
      projectionRevision,
      reasonCode: input.failureCode,
    }),
    session
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
         NULL, 'activation', 'activating', 'configuring',
         NULL, NULL, ?, ?
       )`,
      )
      .bind(
        supportReference,
        input.context.organisationId,
        input.context.environment,
        input.context.mutation.scope.userId,
        correlationId,
        input.context.mutation.scope.route,
        input.context.mutation.scope.operation,
        input.failureCode,
        input.retryable ? "retryable" : "terminal",
        input.now,
        input.now,
        JSON.stringify({
          activation_attempt_id: input.context.attemptId,
          completed_steps: [...completedSteps],
        }),
        latestActivationPhase(completedSteps),
      ),
    prepareOnboardingEvent(session, failedIdentity, {
      eventId: `${failedIdentity.auditEventId}:activation_failed`,
      eventType: "activation_failed",
      organisationId: input.context.organisationId,
      environment: input.context.environment,
      projectionRevision,
      attributes: {
        activation_attempt_id: input.context.attemptId,
        reason_code: input.failureCode,
        retryable: input.retryable,
        support_reference: supportReference,
      },
    }),
    prepareOnboardingEvent(session, supportIdentity, {
      eventId: `${supportIdentity.auditEventId}:support_reference_created`,
      eventType: "support_reference_created",
      organisationId: input.context.organisationId,
      environment: input.context.environment,
      projectionRevision,
      attributes: {
        activation_attempt_id: input.context.attemptId,
        reason_code: input.failureCode,
        support_reference: supportReference,
      },
    }),
  ]);
  return {
    reasonCode: input.failureCode,
    retryable: input.retryable,
    correlationId,
    supportReference,
    mutationReceiptId: input.context.mutation.identity.receiptId,
  };
}

function activationStaleDetail(
  row: ActivationRow | null,
  request: OnboardingActivationInput,
): ActivationStaleDetail | null {
  if (
    row === null ||
    typeof row.organisationName !== "string" ||
    row.readinessVersion !== request.readinessVersion ||
    row.readinessHash !== request.readinessHash
  ) {
    return "readiness_assessment_missing";
  }
  if (row.assessmentConfigurationVersion !== row.configurationVersion) {
    return "configuration_changed_since_assessment";
  }
  if (
    row.configurationVersion !==
    request.mutation.boundary.expectedConfigurationVersion
  ) {
    return "client_configuration_stale";
  }
  if (row.assessmentEnvironment !== row.environment) {
    return "assessment_environment_mismatch";
  }
  if (row.lifecycle !== "configuring" && row.lifecycle !== "activating") {
    return "organisation_lifecycle_incompatible";
  }
  return null;
}

function readActivationRow(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  readinessVersion: number,
  readinessHash: string,
): Promise<ActivationRow | null> {
  return db
    .prepare(
      `SELECT o.lifecycle, t.name AS organisationName, a.readiness_version AS readinessVersion,
            a.readiness_hash AS readinessHash, o.capability_profile AS capabilityProfile,
            x.activation_attempt_id AS activationAttemptId,
            a.policy_snapshot_id AS policySnapshotId, a.cue_snapshot_id AS cueSnapshotId,
            s.cue_preset_id AS cuePresetId, d.workspace_id AS cueWorkspaceId,
            d.channel_id AS cueChannelId, x.status AS attemptStatus,
            x.lease_owner AS leaseOwner, x.lease_expires_at AS leaseExpiresAt,
            o.environment, a.environment AS assessmentEnvironment,
            o.configuration_version AS configurationVersion,
            a.configuration_version AS assessmentConfigurationVersion,
            o.projection_revision AS projectionRevision
     FROM organisation_onboarding o
     JOIN organisation t ON t.organisation_id = o.organisation_id
     JOIN organisation_readiness_assessment a ON a.organisation_id = o.organisation_id
       AND a.readiness_version = ? AND a.readiness_hash = ?
     JOIN organisation_onboarding_selection s ON s.organisation_id = o.organisation_id
     JOIN organisation_communication_destination d ON d.organisation_id = o.organisation_id
     LEFT JOIN organisation_activation_attempt x ON x.organisation_id = o.organisation_id
       AND x.readiness_hash = a.readiness_hash
     WHERE o.organisation_id = ?`,
    )
    .bind(readinessVersion, readinessHash, organisationId)
    .first<ActivationRow>();
}

function parseActivationRow(
  row: ActivationRow | null,
  request: OnboardingActivationInput,
): Result<
  {
    readonly attemptId: ActivationAttemptId | null;
    readonly organisationName: string;
    readonly environment: OrganisationEnvironment;
    readonly capabilityProfile: CapabilityProfile;
    readonly policySnapshotId: SetupSnapshotId;
    readonly cueSnapshotId: SetupSnapshotId;
    readonly cueSelection: CueActivationSelection;
    readonly projectionRevision: number;
  },
  ActivationError
> {
  const staleDetail = activationStaleDetail(row, request);
  if (staleDetail !== null || row === null) {
    return {
      ok: false,
      error: {
        code: "activation_readiness_stale",
        detail: staleDetail ?? "readiness_assessment_missing",
      },
    };
  }
  if (
    row.attemptStatus === "running" &&
    typeof row.leaseOwner === "string" &&
    typeof row.leaseExpiresAt === "number" &&
    row.leaseExpiresAt > request.now &&
    row.leaseOwner !== request.mutation.identity.causationId
  ) {
    return { ok: false, error: { code: "activation_attempt_in_progress" } };
  }
  const organisationName =
    typeof row.organisationName === "string" ? row.organisationName : null;
  const environment = parseOrganisationEnvironment(row.environment);
  const capabilityProfile = parseCapabilityProfile(row.capabilityProfile);
  const policySnapshotId = parseSnapshotId(row.policySnapshotId);
  const cueSnapshotId = parseSnapshotId(row.cueSnapshotId);
  const attemptId = parseNullableAttemptId(row.activationAttemptId);
  const cueSelection = parseCueSelection(row);
  const projectionRevision = positiveIntegerOrNull(row.projectionRevision);
  if (
    environment === null ||
    capabilityProfile === null ||
    policySnapshotId === null ||
    cueSnapshotId === null ||
    attemptId === undefined ||
    cueSelection === null ||
    projectionRevision === null ||
    organisationName === null
  ) {
    return { ok: false, error: { code: "activation_attempt_corrupt" } };
  }
  return {
    ok: true,
    value: {
      attemptId,
      organisationName,
      environment,
      capabilityProfile,
      policySnapshotId,
      cueSnapshotId,
      cueSelection,
      projectionRevision,
    },
  };
}

function parseCueSelection(row: ActivationRow): CueActivationSelection | null {
  if (
    (row.cuePresetId !== "observe_commerce" &&
      row.cuePresetId !== "commerce_operator" &&
      row.cuePresetId !== "proactive_triage") ||
    typeof row.cueWorkspaceId !== "string" ||
    typeof row.cueChannelId !== "string"
  ) {
    return null;
  }
  const workspaceId = parseWorkspaceId(row.cueWorkspaceId);
  const channelId = parseChannelId(row.cueChannelId);
  return workspaceId.ok && channelId.ok
    ? {
        presetId: row.cuePresetId,
        workspaceId: workspaceId.value,
        channelId: channelId.value,
      }
    : null;
}

function parseCapabilityProfile(raw: unknown): CapabilityProfile | null {
  return raw === "read_and_propose" || raw === "approved_provider_writes"
    ? raw
    : null;
}

function parseOrganisationEnvironment(
  raw: unknown,
): OrganisationEnvironment | null {
  return raw === "development" || raw === "production" ? raw : null;
}

function activationPhase(step: ActivationStep): OnboardingActivationPhase {
  switch (step) {
    case "readiness":
      return "validating";
    case "placement":
      return "assigning_runtime";
    case "policy":
      return "publishing_policy";
    case "cues":
      return "publishing_cues";
    case "accounts":
      return "enabling_connections";
    case "publish":
      return "finalizing";
  }
}

function activationMutationReceiptBody(
  mutationReceiptId: string,
  organisationId: OrganisationId,
  activationReceiptId: ActivationReceiptId,
  firstTask: FirstOperationalTask,
) {
  return {
    receipt_id: mutationReceiptId,
    organisation_id: organisationId,
    activation_receipt_id: activationReceiptId,
    first_task: firstTask,
  };
}

function activationEvidenceIdentity(
  identity: ControlMutationIdentity,
  suffix:
    | "start"
    | "resume"
    | "succeeded"
    | "already_succeeded"
    | "failed"
    | "support",
): ControlMutationIdentity {
  return {
    receiptId: identity.receiptId,
    auditEventId: `${identity.auditEventId}:${suffix}`,
    correlationId: identity.correlationId,
    causationId: identity.causationId,
    portalSubjectHash: identity.portalSubjectHash,
    createdAt: identity.createdAt,
  };
}

function latestActivationPhase(
  completedSteps: ReadonlySet<ActivationStep>,
): string | null {
  const ordered: readonly ActivationStep[] = [
    "readiness",
    "placement",
    "policy",
    "cues",
    "accounts",
    "publish",
  ];
  let latest: ActivationStep | null = null;
  for (const step of ordered) {
    if (completedSteps.has(step)) {
      latest = step;
    }
  }
  return latest === null ? null : activationPhase(latest);
}

async function recordCompletedActivationMutation(
  db: OrganisationDatabase,
  request: OnboardingActivationInput,
  receipt: ActivationReceipt,
): Promise<void> {
  const replay = await readControlMutationReplay({
    db,
    scope: request.mutation.scope,
    boundary: request.mutation.boundary,
  });
  if (replay.kind === "replay") {
    return;
  }
  if (replay.kind === "conflict") {
    throw new Error("completed activation mutation idempotency conflict");
  }
  const organisation = await db
    .prepare(
      `SELECT lifecycle, configuration_version AS configurationVersion,
            projection_revision AS projectionRevision
     FROM organisation_onboarding WHERE organisation_id = ?`,
    )
    .bind(request.organisationId)
    .first<{
      readonly lifecycle: unknown;
      readonly configurationVersion: unknown;
      readonly projectionRevision: unknown;
    }>();
  if (
    organisation?.lifecycle !== "active" ||
    typeof organisation.configurationVersion !== "number" ||
    typeof organisation.projectionRevision !== "number"
  ) {
    throw new Error("completed activation organisation state is invalid");
  }
  const session = db.withSession("first-primary");
  const replayIdentity = activationEvidenceIdentity(
    request.mutation.identity,
    "already_succeeded",
  );
  await session.batch([
    prepareControlMutationReceipt(session, {
      scope: request.mutation.scope,
      boundary: request.mutation.boundary,
      identity: request.mutation.identity,
      responseStatus: 200,
      responseBody: activationMutationReceiptBody(
        request.mutation.identity.receiptId,
        request.organisationId,
        receipt.activationReceiptId,
        receipt.firstTask,
      ),
    }),
    prepareOnboardingAuditEvent(session, replayIdentity, {
      organisationId: request.organisationId,
      environment: receipt.environment,
      actorUserId: request.mutation.scope.userId,
      operation: "organisation.activation.read",
      targetKind: "organisation_activation_receipt",
      targetId: receipt.activationReceiptId,
      oldLifecycle: "active",
      newLifecycle: "active",
      configurationVersion: organisation.configurationVersion,
      projectionRevision: organisation.projectionRevision,
      reasonCode: "activation_already_succeeded",
    }),
  ]);
}

function parseSnapshotId(raw: unknown): SetupSnapshotId | null {
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = parseSetupSnapshotId(raw);
  return parsed.ok ? parsed.value : null;
}

function parseNullableAttemptId(
  raw: unknown,
): ActivationAttemptId | null | undefined {
  if (raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const parsed = parseActivationAttemptId(raw);
  return parsed.ok ? parsed.value : undefined;
}

async function readCompletedSteps(
  db: OrganisationDatabase,
  attemptId: ActivationAttemptId,
): Promise<ReadonlySet<ActivationStep>> {
  const rows = await db
    .prepare(
      `SELECT step FROM organisation_activation_step
     WHERE activation_attempt_id = ? AND status = 'completed'`,
    )
    .bind(attemptId)
    .all<{ step: unknown }>();
  const completed = new Set<ActivationStep>();
  for (const row of rows.results ?? []) {
    if (isActivationStep(row.step)) {
      completed.add(row.step);
    }
  }
  return completed;
}

function isActivationStep(raw: unknown): raw is ActivationStep {
  return (
    raw === "readiness" ||
    raw === "placement" ||
    raw === "policy" ||
    raw === "cues" ||
    raw === "accounts" ||
    raw === "publish"
  );
}

async function readActivationReceiptByHash(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  readinessHash: string,
): Promise<ActivationReceipt | null> {
  const row = await db
    .prepare(
      `SELECT activation_receipt_id AS activationReceiptId,
            activation_attempt_id AS activationAttemptId, organisation_id AS organisationId,
            readiness_hash AS readinessHash, policy_snapshot_id AS policySnapshotId,
            cue_snapshot_id AS cueSnapshotId, capability_profile AS capabilityProfile,
            activated_at AS activatedAt, environment
     FROM organisation_activation_receipt WHERE organisation_id = ? AND readiness_hash = ?`,
    )
    .bind(organisationId, readinessHash)
    .first<ReceiptRow>();
  if (
    row === null ||
    typeof row.activationReceiptId !== "string" ||
    typeof row.activationAttemptId !== "string" ||
    row.organisationId !== organisationId ||
    row.readinessHash !== readinessHash ||
    typeof row.activatedAt !== "number"
  ) {
    return null;
  }
  const receiptId = parseActivationReceiptId(row.activationReceiptId);
  const attemptId = parseActivationAttemptId(row.activationAttemptId);
  const policySnapshotId = parseSnapshotId(row.policySnapshotId);
  const cueSnapshotId = parseSnapshotId(row.cueSnapshotId);
  const capabilityProfile = parseCapabilityProfile(row.capabilityProfile);
  const environment = parseOrganisationEnvironment(row.environment);
  if (
    !receiptId.ok ||
    !attemptId.ok ||
    policySnapshotId === null ||
    cueSnapshotId === null ||
    capabilityProfile === null ||
    environment === null
  ) {
    throw new Error("activation receipt persistence invariant failed");
  }
  const firstTask = await readFirstOperationalTask(db, organisationId);
  if (firstTask === null) {
    throw new Error("activation first operational task is missing");
  }
  return {
    activationReceiptId: receiptId.value,
    activationAttemptId: attemptId.value,
    organisationId,
    readinessHash,
    environment,
    policySnapshotId,
    cueSnapshotId,
    capabilityProfile,
    firstTask,
    activatedAt: row.activatedAt,
  };
}
