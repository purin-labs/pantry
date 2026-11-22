import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  OnboardingActionCode,
  OnboardingActivation,
  OnboardingActivationPhase,
  OnboardingCredentialHealth,
  OnboardingCueTarget,
  OnboardingEventRecency,
  OnboardingNextAction,
  OnboardingOperatingProfile,
  OnboardingProjectionV1,
  OnboardingProviderAccount,
  OnboardingSelectedResource,
  OnboardingReadiness,
  OnboardingReadinessBlocker,
  OnboardingStepProjection as SharedOnboardingStepProjection,
  OnboardingSupportReference,
  OnboardingWebhookHealth,
  OrganisationOnboardingLifecycle as SharedOrganisationOnboardingLifecycle,
} from "@purin-labs/contracts";

import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type {
  ActiveOrganisationMembership,
  OrganisationOnboardingLifecycle,
} from "./control-plane";
import {
  listIntegrationAccounts,
  type IntegrationAccount,
  type IntegrationAccountLifecycle,
} from "./integration-account";
import { readFirstOperationalTask } from "./first-operational-task";
import {
  parseConnectionProvider,
  type ConnectionProvider,
} from "./provider-attempt";
import {
  loadSetupSelection,
  parsePersistedCapabilityProfile,
  readCurrentReadiness,
  type CapabilityProfile,
  type ReadinessBlocker,
  type SetupSelection,
} from "./onboarding";
import type { Variant } from "@purin-labs/type-utils";
import type { OrganisationQuerySource } from "./query-source";
import { assertNever } from "@purin-labs/std";

type OnboardingProjectionRow = {
  readonly organisationId: unknown;
  readonly name: unknown;
  readonly plan: unknown;
  readonly organisationCreatedAt: unknown;
  readonly environment: unknown;
  readonly lifecycle: unknown;
  readonly capabilityProfile: unknown;
  readonly readinessVersion: unknown;
  readonly activationAttemptId: unknown;
  readonly activatedAt: unknown;
  readonly activationReceiptId: unknown;
  readonly archivedAt: unknown;
  readonly purgeAfter: unknown;
  readonly projectionRevision: unknown;
  readonly configurationVersion: unknown;
  readonly updatedAt: unknown;
};

type ActivationAttemptRow = {
  readonly activationAttemptId: unknown;
  readonly status: unknown;
  readonly failureCode: unknown;
  readonly retryable: unknown;
  readonly startedAt: unknown;
};

type ActivationStepRow = {
  readonly step: unknown;
};

type LatestProviderAttemptRow = {
  readonly attemptId: unknown;
  readonly provider: unknown;
  readonly lifecycle: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
  readonly expiresAt: unknown;
  readonly failureReasonCode: unknown;
  readonly failedAt: unknown;
  readonly completedAt: unknown;
};

type LatestProviderAttempt = {
  readonly attemptId: string;
  readonly provider: ConnectionProvider;
  readonly lifecycle:
    | "created"
    | "authorizing"
    | "callback_received"
    | "provisioning"
    | "connected"
    | "cancelled"
    | "failed"
    | "expired";
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly reasonCode: string | null;
  readonly completedAt: number | null;
};

type ProviderAccountProjectionRow = {
  readonly integrationAccountId: unknown;
  readonly grantedScopes: unknown;
  readonly connectionLifecycle: unknown;
  readonly credentialLifecycle: unknown;
  readonly workspaceId: unknown;
  readonly surfaceScopes: unknown;
  readonly lastEventReceivedAt: unknown;
  readonly webhookCount: unknown;
  readonly liveWebhookCount: unknown;
  readonly degradedWebhookCount: unknown;
  readonly disabledWebhookCount: unknown;
  readonly revokedWebhookCount: unknown;
};

type SelectedDestinationRow = {
  readonly integrationAccountId: unknown;
  readonly workspaceId: unknown;
  readonly channelId: unknown;
  readonly displayLabel: unknown;
  readonly resourceKind: unknown;
};

type SelectedShopifyCommerceSystemRow = {
  readonly integrationAccountId: unknown;
};

type CommerceSystemStepEvidence = Readonly<{
  revision: number;
  selectedAt: number;
}>;

type ProviderAccountProjectionDetails = {
  readonly scopes: readonly string[];
  readonly selectedResources: readonly OnboardingSelectedResource[];
  readonly credentialHealth: OnboardingCredentialHealth;
  readonly webhookHealth: OnboardingWebhookHealth;
  readonly eventRecency: OnboardingEventRecency;
};

type OrganisationProjectionState = {
  readonly organisationId: OrganisationId;
  readonly name: string;
  readonly plan: string;
  readonly organisationCreatedAt: number;
  readonly lifecycle: OrganisationOnboardingLifecycle;
  readonly capabilityProfile: CapabilityProfile;
  readonly projectionRevision: number;
  readonly configurationVersion: number;
  readonly updatedAt: number;
};

export type OnboardingProjection = OnboardingProjectionV1;
type OnboardingStepProjection = SharedOnboardingStepProjection;
type ActivationProjection = OnboardingActivation;
type ActivationPhase = OnboardingActivationPhase;
type ReadinessProjection = OnboardingReadiness;
type ReadinessBlockerProjection = OnboardingReadinessBlocker;
type NextActionProjection = OnboardingNextAction;
type ProviderAccountProjection = OnboardingProviderAccount;
type OperatingProfileProjection = OnboardingOperatingProfile;
type CueTargetProjection = OnboardingCueTarget;

const READINESS_REQUIREMENTS = [
  "verified_owner",
  "provider_credentials",
  "provider_webhooks",
  "operating_policy",
  "cue_destination",
] as const;

function ignoreRejection(): void {}

export async function buildOnboardingProjection(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly membership: ActiveOrganisationMembership;
  readonly now: number;
}): Promise<OnboardingProjection | null> {
  if (input.organisationId !== input.membership.organisationId) {
    return null;
  }
  // The account list needs nothing from the Organisation row.
  const accountsRead = listIntegrationAccounts({
    db: input.db,
    organisationId: input.organisationId,
  });
  accountsRead.catch(ignoreRejection);
  const row = await input.db
    .prepare(
      `SELECT t.organisation_id AS organisationId, t.name, t.plan,
            t.created_at AS organisationCreatedAt, o.environment, o.lifecycle,
            o.capability_profile AS capabilityProfile,
            o.readiness_version AS readinessVersion,
            o.activation_attempt_id AS activationAttemptId,
            o.activated_at AS activatedAt,
            o.activation_receipt_id AS activationReceiptId,
            o.archived_at AS archivedAt, o.purge_after AS purgeAfter,
            o.projection_revision AS projectionRevision,
            o.configuration_version AS configurationVersion,
            o.updated_at AS updatedAt
     FROM organisation t
     JOIN organisation_onboarding o ON o.organisation_id = t.organisation_id
     WHERE t.organisation_id = ?`,
    )
    .bind(input.organisationId)
    .first<OnboardingProjectionRow>();
  if (row === null) {
    return null;
  }

  const state = parseProjectionState(row);
  const accounts = await accountsRead;
  const [
    accountDetails,
    selection,
    readiness,
    activation,
    firstTask,
    providerAttempts,
    supportReference,
    commerceSystem,
    inference,
  ] = await Promise.all([
    readProviderAccountProjectionDetails(
      input.db,
      state.organisationId,
      accounts,
    ),
    loadSetupSelection({
      db: input.db,
      organisationId: input.organisationId,
      capabilityProfile: state.capabilityProfile,
    }),
    buildReadinessProjection(input.db, state),
    buildActivationProjection(input.db, state),
    readFirstOperationalTask(input.db, state.organisationId),
    listLatestProviderAttempts(input.db, state.organisationId),
    buildSupportReference(input.db, state.organisationId),
    readCommerceSystemStepEvidence(input.db, state.organisationId),
    readInferenceStepEvidence(input.db, state.organisationId),
  ]);
  const steps = buildSteps(
    state,
    input.membership,
    accounts,
    commerceSystem,
    inference,
    selection,
    readiness,
    activation,
    providerAttempts,
    input.now,
  );

  return {
    schema_version: 1,
    projection_revision: state.projectionRevision,
    configuration_version: state.configurationVersion,
    organisation: {
      organisation_id: state.organisationId,
      name: state.name,
      plan: state.plan,
      lifecycle: projectOrganisationLifecycle(state.lifecycle),
      capability_profile: state.capabilityProfile,
      created_at: state.organisationCreatedAt,
    },
    membership: {
      user_id: input.membership.userId,
      person_id: input.membership.personId,
      role: input.membership.role,
      created_at: input.membership.createdAt,
    },
    steps: [...steps],
    provider_accounts: accounts.map((account) => {
      const details = accountDetails.get(account.integrationAccountId);
      if (details === undefined) {
        throw new Error(
          "onboarding projection provider account details are missing",
        );
      }
      return projectProviderAccount(account, details);
    }),
    operating_profile: projectOperatingProfile(selection),
    readiness,
    activation,
    next_action: selectNextAction(state, steps, activation),
    first_task: firstTask,
    support_reference: supportReference,
    updated_at: state.updatedAt,
  };
}

async function buildSupportReference(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<OnboardingSupportReference> {
  const row = await db
    .prepare(
      `SELECT support_reference AS supportReference
     FROM onboarding_support_reference
     WHERE organisation_id = ? AND resolved_at IS NULL
     ORDER BY latest_occurred_at DESC, support_reference DESC
     LIMIT 1`,
    )
    .bind(organisationId)
    .first<{ readonly supportReference: unknown }>();
  return row === null
    ? { kind: "none" }
    : {
        kind: "available",
        reference: requireString(row.supportReference, "support reference"),
      };
}

async function readCommerceSystemStepEvidence(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<CommerceSystemStepEvidence | null> {
  const row = await db
    .prepare(
      `SELECT revision, selected_at AS selectedAt
     FROM organisation_commerce_system
     WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      readonly revision: unknown;
      readonly selectedAt: unknown;
    }>();
  if (row === null) return null;
  return {
    revision: requirePositiveInteger(row.revision, "commerce system revision"),
    selectedAt: requirePositiveInteger(
      row.selectedAt,
      "commerce system selected at",
    ),
  };
}

type InferenceStepEvidence = {
  readonly selectionKind: string;
  readonly selectedAt: number;
};

async function readInferenceStepEvidence(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<InferenceStepEvidence | null> {
  const row = await db
    .prepare(
      `SELECT selection_kind AS selectionKind, selected_at AS selectedAt
     FROM organisation_inference_selection
     WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{ readonly selectionKind: unknown; readonly selectedAt: unknown }>();
  if (row === null) return null;
  return {
    selectionKind: requireString(row.selectionKind, "inference selection kind"),
    selectedAt: requireInteger(row.selectedAt, "inference selected_at"),
  };
}

function projectOrganisationLifecycle(
  lifecycle: OrganisationOnboardingLifecycle,
): SharedOrganisationOnboardingLifecycle {
  switch (lifecycle.kind) {
    case "configuring":
      return {
        kind: lifecycle.kind,
        organisation_id: lifecycle.organisationId,
        configuration_version: lifecycle.configurationVersion,
        environment: lifecycle.environment,
      };
    case "activating":
      return {
        kind: lifecycle.kind,
        organisation_id: lifecycle.organisationId,
        activation_attempt_id: lifecycle.activationAttemptId,
        readiness_version: lifecycle.readinessVersion,
        environment: lifecycle.environment,
      };
    case "active":
      return {
        kind: lifecycle.kind,
        organisation_id: lifecycle.organisationId,
        activation_receipt_id: lifecycle.activationReceiptId,
        activated_at: lifecycle.activatedAt,
        environment: lifecycle.environment,
      };
    case "archived":
      return {
        kind: lifecycle.kind,
        organisation_id: lifecycle.organisationId,
        archived_at: lifecycle.archivedAt,
        purge_after: lifecycle.purgeAfter,
        environment: lifecycle.environment,
      };
    default:
      return assertNever(lifecycle);
  }
}

function parseProjectionState(
  row: OnboardingProjectionRow,
): OrganisationProjectionState {
  const organisationId = parseOrganisationId(
    requireString(row.organisationId, "organisation id"),
  );
  if (!organisationId.ok) {
    throw new Error("onboarding projection has an invalid organisation id");
  }
  return {
    organisationId: organisationId.value,
    name: requireString(row.name, "organisation name"),
    plan: requireString(row.plan, "organisation plan"),
    organisationCreatedAt: requireInteger(
      row.organisationCreatedAt,
      "organisation created_at",
    ),
    lifecycle: parseOnboardingLifecycle(row),
    capabilityProfile: parsePersistedCapabilityProfile(row.capabilityProfile),
    projectionRevision: requirePositiveInteger(
      row.projectionRevision,
      "projection revision",
    ),
    configurationVersion: requirePositiveInteger(
      row.configurationVersion,
      "configuration version",
    ),
    updatedAt: requireInteger(row.updatedAt, "onboarding updated_at"),
  };
}

function parseOnboardingLifecycle(
  row: OnboardingProjectionRow,
): OrganisationOnboardingLifecycle {
  const organisationId = parseOrganisationId(
    requireString(row.organisationId, "organisation id"),
  );
  if (!organisationId.ok) {
    throw new Error("onboarding projection has an invalid organisation id");
  }
  const environment = requireOrganisationEnvironment(row.environment);
  switch (row.lifecycle) {
    case "configuring":
      return {
        kind: "configuring",
        organisationId: organisationId.value,
        configurationVersion: requirePositiveInteger(
          row.configurationVersion,
          "configuration version",
        ),
        environment,
      };
    case "activating":
      return {
        kind: "activating",
        organisationId: organisationId.value,
        activationAttemptId: requireString(
          row.activationAttemptId,
          "activation attempt id",
        ),
        readinessVersion: requirePositiveInteger(
          row.readinessVersion,
          "readiness version",
        ),
        environment,
      };
    case "active":
      return {
        kind: "active",
        organisationId: organisationId.value,
        activatedAt: requireInteger(row.activatedAt, "activated_at"),
        activationReceiptId: requireString(
          row.activationReceiptId,
          "activation receipt id",
        ),
        environment,
      };
    case "archived":
      return {
        kind: "archived",
        organisationId: organisationId.value,
        archivedAt: requireInteger(row.archivedAt, "archived_at"),
        purgeAfter: requireInteger(row.purgeAfter, "purge_after"),
        environment,
      };
    default:
      throw new Error("onboarding projection has an invalid lifecycle");
  }
}

async function buildReadinessProjection(
  db: OrganisationQuerySource,
  state: OrganisationProjectionState,
): Promise<ReadinessProjection> {
  const assessment = await readCurrentReadiness({
    db,
    organisationId: state.organisationId,
  });
  if (
    assessment === null ||
    (assessment.kind === "blocked" &&
      assessment.readinessVersion === 0 &&
      assessment.blockers.length === 0)
  ) {
    return {
      kind: "blocked",
      readiness_version: 0,
      readiness_hash: "unassessed",
      configuration_version: state.configurationVersion,
      blockers: [{ code: "readiness_not_evaluated" }],
      approval_authentication: [],
      assessed_at: 0,
    };
  }
  if (assessment.kind === "blocked") {
    return {
      kind: "blocked",
      readiness_version: assessment.readinessVersion,
      readiness_hash: assessment.readinessHash,
      configuration_version: assessment.configurationVersion,
      blockers: assessment.blockers.map(projectReadinessBlocker),
      approval_authentication: [...assessment.approvalAuthentication],
      assessed_at: assessment.assessedAt,
    };
  }
  return {
    kind: "ready",
    readiness_version: assessment.readinessVersion,
    readiness_hash: assessment.readinessHash,
    requirements: [...READINESS_REQUIREMENTS],
    configuration_version: assessment.configurationVersion,
    approval_authentication: [...assessment.approvalAuthentication],
    assessed_at: assessment.assessedAt,
  };
}

function projectReadinessBlocker(
  blocker: ReadinessBlocker,
): ReadinessBlockerProjection {
  switch (blocker.code) {
    case "credential_unresolved":
      return {
        code: blocker.code,
        integration_account_id: blocker.integrationAccountId,
      };
    case "webhook_unhealthy":
      return {
        code: blocker.code,
        integration_account_id: blocker.integrationAccountId,
      };
    case "owner_missing":
    case "placement_missing":
    case "communication_connection_missing":
    case "communication_destination_missing":
    case "commerce_system_missing":
    case "policy_snapshot_missing":
    case "cue_snapshot_missing":
    case "environment_conflict":
    case "runtime_admission_unavailable":
      return { code: blocker.code };
    default:
      return assertNever(blocker);
  }
}

async function buildActivationProjection(
  db: OrganisationQuerySource,
  state: OrganisationProjectionState,
): Promise<ActivationProjection> {
  switch (state.lifecycle.kind) {
    case "configuring":
      return projectLatestActivationAttempt(db, state.organisationId);
    case "activating":
      return {
        kind: "running",
        activation_attempt_id: state.lifecycle.activationAttemptId,
        phase: await resolveActivationPhase(
          db,
          state.lifecycle.activationAttemptId,
        ),
        started_at: await readActivationStartedAt(
          db,
          state.lifecycle.activationAttemptId,
        ),
      };
    case "active":
      return {
        kind: "succeeded",
        activation_attempt_id: await readActivationReceiptAttemptId(
          db,
          state.lifecycle.activationReceiptId,
        ),
        activation_receipt_id: state.lifecycle.activationReceiptId,
        activated_at: state.lifecycle.activatedAt,
      };
    case "archived":
      return { kind: "idle", organisation_id: state.organisationId };
    default:
      return assertNever(state.lifecycle);
  }
}

async function projectLatestActivationAttempt(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<ActivationProjection> {
  const row = await db
    .prepare(
      `SELECT activation_attempt_id AS activationAttemptId, status,
            failure_code AS failureCode, retryable, started_at AS startedAt
     FROM organisation_activation_attempt
     WHERE organisation_id = ?
     ORDER BY started_at DESC, activation_attempt_id DESC
     LIMIT 1`,
    )
    .bind(organisationId)
    .first<ActivationAttemptRow>();
  if (row === null || row.status === "completed") {
    return { kind: "idle", organisation_id: organisationId };
  }
  if (row.status !== "failed") {
    throw new Error(
      "configuring organisation has an invalid activation attempt",
    );
  }
  const attemptId = requireString(
    row.activationAttemptId,
    "activation attempt id",
  );
  const phase = await resolveActivationPhase(db, attemptId);
  const reasonCode = requireString(row.failureCode, "activation failure code");
  return requireSqliteBoolean(row.retryable, "activation retryable")
    ? {
        kind: "failed_retryable",
        activation_attempt_id: attemptId,
        phase,
        reason_code: reasonCode,
        retry_after_ms: 1_000,
      }
    : {
        kind: "failed_terminal",
        activation_attempt_id: attemptId,
        phase,
        reason_code: reasonCode,
      };
}

async function readActivationReceiptAttemptId(
  db: OrganisationQuerySource,
  activationReceiptId: string,
): Promise<string> {
  const row = await db
    .prepare(
      `SELECT activation_attempt_id AS activationAttemptId
     FROM organisation_activation_receipt
     WHERE activation_receipt_id = ?`,
    )
    .bind(activationReceiptId)
    .first<{ readonly activationAttemptId: unknown }>();
  if (row === null) {
    throw new Error("activation receipt is missing");
  }
  return requireString(
    row.activationAttemptId,
    "activation receipt attempt id",
  );
}

async function readActivationStartedAt(
  db: OrganisationQuerySource,
  attemptId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT started_at AS startedAt
     FROM organisation_activation_attempt
     WHERE activation_attempt_id = ?`,
    )
    .bind(attemptId)
    .first<ActivationAttemptRow>();
  if (row === null) {
    throw new Error("activation attempt is missing");
  }
  return requireInteger(row.startedAt, "activation started_at");
}

async function resolveActivationPhase(
  db: OrganisationQuerySource,
  attemptId: string,
): Promise<ActivationPhase> {
  const row = await db
    .prepare(
      `SELECT step
     FROM organisation_activation_step
     WHERE activation_attempt_id = ? AND status = 'completed'
       AND step IN ('readiness', 'placement', 'policy', 'cues', 'accounts', 'publish')
     ORDER BY completed_at DESC
     LIMIT 1`,
    )
    .bind(attemptId)
    .first<ActivationStepRow>();
  if (row === null) {
    return "validating";
  }
  switch (row.step) {
    case "readiness":
      return "assigning_runtime";
    case "placement":
      return "publishing_policy";
    case "policy":
      return "publishing_cues";
    case "cues":
      return "enabling_connections";
    case "accounts":
    case "publish":
      return "finalizing";
    default:
      throw new Error("activation attempt has an invalid completed step");
  }
}

function buildSteps(
  state: OrganisationProjectionState,
  membership: ActiveOrganisationMembership,
  accounts: readonly IntegrationAccount[],
  commerceSystem: CommerceSystemStepEvidence | null,
  inference: InferenceStepEvidence | null,
  selection: SetupSelection | null,
  readiness: ReadinessProjection,
  activation: ActivationProjection,
  providerAttempts: readonly LatestProviderAttempt[],
  now: number,
): OnboardingStepProjection[] {
  const communicationConnection = accounts.find(
    isUsableCommunicationConnection,
  );
  const slackAttempt = findLatestProviderAttempt(providerAttempts, "slack");
  const commerceAttempt = findLatestProviderAttempt(
    providerAttempts,
    "shopify",
  );
  return [
    {
      kind: "complete",
      step: "workspace",
      completed_at: membership.createdAt,
      receipt_id: `membership:${membership.userId}`,
    },
    inference === null
      ? { kind: "available", step: "inference", action: "choose_inference" }
      : {
          kind: "complete",
          step: "inference",
          completed_at: inference.selectedAt,
          receipt_id: `inference:${inference.selectionKind}`,
        },
    commerceSystem === null
      ? projectProviderStep(
          "commerce",
          "connect_commerce",
          commerceAttempt,
          now,
        )
      : {
          kind: "complete",
          step: "commerce",
          completed_at: commerceSystem.selectedAt,
          receipt_id: `commerce-system:${commerceSystem.revision}`,
        },
    communicationConnection === undefined
      ? projectProviderStep("conversations", "connect_slack", slackAttempt, now)
      : {
          kind: "complete",
          step: "conversations",
          completed_at: communicationConnection.updatedAt,
          receipt_id: communicationConnection.integrationAccountId,
        },
    selection === null && state.lifecycle.kind !== "active"
      ? communicationConnection === undefined || commerceSystem === null
        ? {
            kind: "unavailable",
            step: "operating_profile",
            reason_code: "provider_accounts_required",
          }
        : {
            kind: "available",
            step: "operating_profile",
            action: "save_operating_profile",
          }
      : {
          kind: "complete",
          step: "operating_profile",
          completed_at: state.updatedAt,
          receipt_id: `setup:${state.configurationVersion}`,
        },
    projectActivationStep(state, readiness, activation),
  ];
}

function projectProviderStep(
  step: "commerce" | "conversations",
  action: "connect_commerce" | "connect_slack",
  attempt: LatestProviderAttempt | null,
  now: number,
): OnboardingStepProjection {
  if (attempt === null || attempt.lifecycle === "connected") {
    return { kind: "available", step, action };
  }
  switch (attempt.lifecycle) {
    case "created":
    case "authorizing":
    case "callback_received":
    case "provisioning":
      // An abandoned authorization is only marked expired by reconciliation;
      // project it as expired as soon as its deadline passes so the merchant
      // can retry immediately instead of waiting out the next cron tick.
      if (attempt.expiresAt <= now) {
        return {
          kind: "action_required",
          step,
          reason_code: "authorization_expired",
          action,
        };
      }
      return {
        kind: "in_progress",
        step,
        attempt_id: attempt.attemptId,
        started_at: attempt.startedAt,
      };
    case "cancelled":
      return {
        kind: "action_required",
        step,
        reason_code: "authorization_cancelled",
        action,
      };
    case "expired":
      return {
        kind: "action_required",
        step,
        reason_code: "authorization_expired",
        action,
      };
    case "failed":
      return {
        kind: "action_required",
        step,
        reason_code: attempt.reasonCode ?? "provider_temporarily_unavailable",
        action,
      };
  }
}

async function listLatestProviderAttempts(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<readonly LatestProviderAttempt[]> {
  const rows = await db
    .prepare(
      `SELECT attempt_id AS attemptId, provider, lifecycle,
            created_at AS createdAt, updated_at AS updatedAt,
            expires_at AS expiresAt,
            failure_reason_code AS failureReasonCode,
            failed_at AS failedAt, completed_at AS completedAt
     FROM provider_connection_attempt
     WHERE organisation_id = ?
       AND attempt_id IN (
         SELECT latest.attempt_id
         FROM provider_connection_attempt AS latest
         WHERE latest.organisation_id = provider_connection_attempt.organisation_id
           AND latest.provider = provider_connection_attempt.provider
         ORDER BY latest.created_at DESC, latest.attempt_id DESC
         LIMIT 1
       )
     ORDER BY provider`,
    )
    .bind(organisationId)
    .all<LatestProviderAttemptRow>();
  const attempts: LatestProviderAttempt[] = [];
  for (const row of rows.results ?? []) {
    attempts.push(requireLatestProviderAttempt(row));
  }
  return attempts;
}

function requireLatestProviderAttempt(
  row: LatestProviderAttemptRow,
): LatestProviderAttempt {
  const lifecycle = requireProviderAttemptLifecycle(row.lifecycle);
  const failedAt =
    row.failedAt === null
      ? null
      : requireInteger(row.failedAt, "provider attempt failed_at");
  const completedAt =
    row.completedAt === null
      ? null
      : requireInteger(row.completedAt, "provider attempt completed_at");
  return {
    attemptId: requireString(row.attemptId, "provider attempt id"),
    provider: requireProjectionProvider(row.provider),
    lifecycle,
    startedAt: requireInteger(row.createdAt, "provider attempt created_at"),
    expiresAt: requireInteger(row.expiresAt, "provider attempt expires_at"),
    reasonCode:
      row.failureReasonCode === null
        ? null
        : requireString(
            row.failureReasonCode,
            "provider attempt failure reason",
          ),
    completedAt: failedAt ?? completedAt,
  };
}

function requireProviderAttemptLifecycle(
  raw: unknown,
): LatestProviderAttempt["lifecycle"] {
  switch (raw) {
    case "created":
    case "authorizing":
    case "callback_received":
    case "provisioning":
    case "connected":
    case "cancelled":
    case "failed":
    case "expired":
      return raw;
    default:
      throw new Error(
        "onboarding projection provider attempt lifecycle is invalid",
      );
  }
}

function requireProjectionProvider(
  raw: unknown,
): LatestProviderAttempt["provider"] {
  const provider = parseConnectionProvider(raw);
  if (provider !== null) return provider;
  throw new Error("onboarding projection provider attempt provider is invalid");
}

function findLatestProviderAttempt(
  attempts: readonly LatestProviderAttempt[],
  provider: LatestProviderAttempt["provider"],
): LatestProviderAttempt | null {
  for (const attempt of attempts) {
    if (attempt.provider === provider) {
      return attempt;
    }
  }
  return null;
}

function projectActivationStep(
  state: OrganisationProjectionState,
  readiness: ReadinessProjection,
  activation: ActivationProjection,
): OnboardingStepProjection {
  if (state.lifecycle.kind === "archived") {
    return {
      kind: "unavailable",
      step: "review_activation",
      reason_code: "organisation_archived",
    };
  }
  switch (activation.kind) {
    case "idle":
      return state.lifecycle.kind === "configuring" &&
        readiness.kind === "ready"
        ? {
            kind: "available",
            step: "review_activation",
            action: "activate_organisation",
          }
        : {
            kind: "unavailable",
            step: "review_activation",
            reason_code: "readiness_required",
          };
    case "running":
      return {
        kind: "in_progress",
        step: "review_activation",
        attempt_id: activation.activation_attempt_id,
        started_at: activation.started_at,
      };
    case "failed_retryable":
      return {
        kind: "action_required",
        step: "review_activation",
        reason_code: activation.reason_code,
        action: "retry_activation",
      };
    case "failed_terminal":
      return {
        kind: "action_required",
        step: "review_activation",
        reason_code: activation.reason_code,
        action: "save_operating_profile",
      };
    case "succeeded":
      return {
        kind: "complete",
        step: "review_activation",
        completed_at: activation.activated_at,
        receipt_id: activation.activation_receipt_id,
      };
    default:
      return assertNever(activation);
  }
}

function selectNextAction(
  state: OrganisationProjectionState,
  steps: readonly OnboardingStepProjection[],
  activation: ActivationProjection,
): NextActionProjection {
  if (state.lifecycle.kind === "archived") {
    return performAction(
      "restore_organisation",
      "Restore organisation",
      state.organisationId,
      "same_page",
    );
  }
  if (activation.kind === "running") {
    return {
      kind: "wait",
      action_code: "activate_organisation",
      label: "Activation is in progress",
      retry_after_ms: 1_000,
    };
  }
  if (activation.kind === "succeeded") {
    return {
      kind: "done",
      action_code: "onboarding_complete",
      label: "Onboarding complete",
    };
  }
  const inProgress = findInProgressStep(steps);
  if (inProgress !== null) {
    return {
      kind: "wait",
      action_code:
        inProgress.step === "conversations"
          ? "connect_slack"
          : "connect_commerce",
      label:
        inProgress.step === "conversations"
          ? "Slack connection is in progress"
          : "Commerce connection is in progress",
      retry_after_ms: 1_000,
    };
  }
  const actionable = steps.find(isActionableStep);
  if (actionable === undefined) {
    return {
      kind: "wait",
      action_code: "activate_organisation",
      label: "Checking activation readiness",
      retry_after_ms: 1_000,
    };
  }
  if (actionable.kind === "action_required") {
    return {
      kind: "repair",
      action_code: actionable.action,
      label: actionLabel(actionable.action),
      route: actionRoute(actionable.action, state.organisationId),
      presentation: actionPresentation(actionable.action),
      retry_safety: actionRetrySafety(actionable.action),
      reason_code: actionable.reason_code,
    };
  }
  return performAction(
    actionable.action,
    actionLabel(actionable.action),
    state.organisationId,
    actionPresentation(actionable.action),
  );
}

function findInProgressStep(
  steps: readonly OnboardingStepProjection[],
): Variant<OnboardingStepProjection, "in_progress"> | null {
  for (const step of steps) {
    if (
      step.kind === "in_progress" &&
      (step.step === "commerce" || step.step === "conversations")
    ) {
      return step;
    }
  }
  return null;
}

function performAction(
  action: OnboardingActionCode,
  label: string,
  organisationId: OrganisationId,
  presentation: "same_page" | "popup",
): Variant<NextActionProjection, "perform"> {
  return {
    kind: "perform",
    action_code: action,
    label,
    route: actionRoute(action, organisationId),
    presentation,
    retry_safety: actionRetrySafety(action),
  };
}

function actionRoute(
  action: OnboardingActionCode,
  organisationId: OrganisationId,
): string {
  switch (action) {
    case "connect_slack":
      return `/v1/control/organisations/${organisationId}/providers/slack/start`;
    case "choose_inference":
    case "connect_commerce":
      return `/portal/${organisationId}/integrations`;
    case "save_operating_profile":
      return `/v1/control/organisations/${organisationId}/setup`;
    case "activate_organisation":
    case "retry_activation":
      return `/v1/control/organisations/${organisationId}/activate`;
    case "restore_organisation":
      return `/v1/control/organisations/${organisationId}/restore`;
    case "onboarding_complete":
      return `/v1/control/organisations/${organisationId}`;
    default:
      return assertNever(action);
  }
}

function actionLabel(action: OnboardingActionCode): string {
  switch (action) {
    case "connect_slack":
      return "Connect Slack";
    case "choose_inference":
      return "Choose AI account";
    case "connect_commerce":
      return "Choose commerce system";
    case "save_operating_profile":
      return "Save Slack destination";
    case "activate_organisation":
      return "Activate organisation";
    case "retry_activation":
      return "Retry activation";
    case "restore_organisation":
      return "Restore organisation";
    case "onboarding_complete":
      return "Onboarding complete";
    default:
      return assertNever(action);
  }
}

function actionPresentation(
  action: OnboardingActionCode,
): "same_page" | "popup" {
  switch (action) {
    case "connect_slack":
      return "popup";
    case "choose_inference":
    case "connect_commerce":
    case "save_operating_profile":
    case "activate_organisation":
    case "retry_activation":
    case "restore_organisation":
    case "onboarding_complete":
      return "same_page";
    default:
      return assertNever(action);
  }
}

function actionRetrySafety(
  action: OnboardingActionCode,
): "safe" | "requires_confirmation" {
  switch (action) {
    case "connect_slack":
    case "choose_inference":
    case "connect_commerce":
    case "save_operating_profile":
    case "activate_organisation":
    case "retry_activation":
    case "restore_organisation":
    case "onboarding_complete":
      return "safe";
    default:
      return assertNever(action);
  }
}

async function readProviderAccountProjectionDetails(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
  accounts: readonly IntegrationAccount[],
): Promise<ReadonlyMap<string, ProviderAccountProjectionDetails>> {
  const [accountRows, destinationRows, bindingRow] = await Promise.all([
    db
      .prepare(
        `SELECT account.integration_account_id AS integrationAccountId,
              connection.granted_scopes AS grantedScopes,
              connection.lifecycle AS connectionLifecycle,
              credential.lifecycle AS credentialLifecycle,
              surface.workspace_id AS workspaceId,
              surface.scopes AS surfaceScopes,
              surface.last_event_received_at AS lastEventReceivedAt,
              COUNT(webhook.provider_webhook_id) AS webhookCount,
              SUM(CASE WHEN webhook.lifecycle = 'live' THEN 1 ELSE 0 END) AS liveWebhookCount,
              SUM(CASE WHEN webhook.lifecycle = 'degraded' THEN 1 ELSE 0 END) AS degradedWebhookCount,
              SUM(CASE WHEN webhook.lifecycle = 'disabled' THEN 1 ELSE 0 END) AS disabledWebhookCount,
              SUM(CASE WHEN webhook.lifecycle = 'revoked' THEN 1 ELSE 0 END) AS revokedWebhookCount
       FROM integration_account AS account
       JOIN provider_connection AS connection
         ON connection.provider_connection_id = account.provider_connection_id
       LEFT JOIN provider_credential_generation AS credential
         ON credential.provider_connection_id = connection.provider_connection_id
        AND credential.credential_generation = connection.credential_generation
        AND credential.lifecycle = 'active'
       LEFT JOIN surface_installation AS surface
         ON surface.integration_account_id = account.integration_account_id
       LEFT JOIN provider_webhook AS webhook
         ON webhook.integration_account_id = account.integration_account_id
        AND webhook.credential_generation = connection.credential_generation
       WHERE account.organisation_id = ?
         AND account.source_kind = 'built_in'
       GROUP BY account.integration_account_id,
                connection.granted_scopes,
                connection.lifecycle,
                credential.lifecycle,
                surface.workspace_id,
                surface.scopes,
                surface.last_event_received_at`,
      )
      .bind(organisationId)
      .all<ProviderAccountProjectionRow>(),
    db
      .prepare(
        `SELECT destination.integration_account_id AS integrationAccountId,
              destination.workspace_id AS workspaceId,
              destination.channel_id AS channelId,
              resource.display_label AS displayLabel,
              resource.resource_kind AS resourceKind
       FROM organisation_slack_channel AS destination
       JOIN provider_resource_snapshot AS snapshot
         ON snapshot.organisation_id = destination.organisation_id
        AND snapshot.integration_account_id = destination.integration_account_id
        AND snapshot.created_at = (
          SELECT MAX(latest.created_at)
          FROM provider_resource_snapshot AS latest
          WHERE latest.organisation_id = snapshot.organisation_id
            AND latest.integration_account_id = snapshot.integration_account_id
        )
       JOIN provider_discovered_resource AS resource
         ON resource.snapshot_revision = snapshot.snapshot_revision
        AND resource.canonical_resource_id = destination.channel_id
        AND resource.provider_revision = destination.provider_revision
        AND resource.access_state = 'accessible'
       WHERE destination.organisation_id = ?`,
      )
      .bind(organisationId)
      .all<SelectedDestinationRow>(),
    db
      .prepare(
        `SELECT shopify_integration_account_id AS integrationAccountId
       FROM organisation_commerce_system
       WHERE organisation_id = ? AND system_kind = 'shopify'`,
      )
      .bind(organisationId)
      .first<SelectedShopifyCommerceSystemRow>(),
  ]);

  const selectedResourcesByAccount = new Map<
    string,
    OnboardingSelectedResource[]
  >();
  const selectedWorkspacesByAccount = new Map<string, Set<string>>();
  for (const row of destinationRows.results ?? []) {
    const accountId = requireString(
      row.integrationAccountId,
      "setup destination integration account id",
    );
    const workspaceId = requireString(
      row.workspaceId,
      "setup destination workspace id",
    );
    const channelId = requireString(
      row.channelId,
      "setup destination channel id",
    );
    const displayLabel = requireString(
      row.displayLabel,
      "selected resource display label",
    );
    const resourceKind = requireString(
      row.resourceKind,
      "selected resource kind",
    );
    const resources = selectedResourcesByAccount.get(accountId) ?? [];
    const workspaces =
      selectedWorkspacesByAccount.get(accountId) ?? new Set<string>();
    if (!workspaces.has(workspaceId)) {
      resources.push({
        resource_kind: "workspace",
        canonical_resource_id: workspaceId,
        display_label: "Slack workspace",
      });
      workspaces.add(workspaceId);
      selectedWorkspacesByAccount.set(accountId, workspaces);
    }
    resources.push({
      resource_kind: resourceKind,
      canonical_resource_id: channelId,
      display_label: selectedResourceDisplayLabel(
        resourceKind,
        displayLabel,
        channelId,
      ),
    });
    selectedResourcesByAccount.set(accountId, resources);
  }

  const selectedCommerceAccountIds = new Set<string>();
  if (bindingRow !== null) {
    selectedCommerceAccountIds.add(
      requireString(
        bindingRow.integrationAccountId,
        "selected Shopify integration account id",
      ),
    );
  }

  const detailsByAccount = new Map<string, ProviderAccountProjectionDetails>();
  for (const row of accountRows.results ?? []) {
    const integrationAccountId = requireString(
      row.integrationAccountId,
      "provider account integration account id",
    );
    const account = accounts.find(
      (candidate) => candidate.integrationAccountId === integrationAccountId,
    );
    if (account === undefined) {
      throw new Error(
        "provider account detail does not belong to the account projection",
      );
    }
    const selectedResources =
      selectedResourcesByAccount.get(integrationAccountId) ?? [];
    if (
      selectedCommerceAccountIds.has(integrationAccountId) &&
      account.provider === "shopify"
    ) {
      selectedResources.push({
        resource_kind: "shop",
        canonical_resource_id: account.providerAccountId,
        display_label: account.displayName,
      });
    }
    detailsByAccount.set(integrationAccountId, {
      scopes: parseProjectionStringArray(
        row.surfaceScopes ?? row.grantedScopes,
        "provider account scopes",
      ),
      selectedResources,
      credentialHealth: projectCredentialHealth(
        account,
        row.connectionLifecycle,
        row.credentialLifecycle,
      ),
      webhookHealth: projectWebhookHealth(row),
      eventRecency:
        row.workspaceId === null || row.workspaceId === undefined
          ? { kind: "unavailable" }
          : row.lastEventReceivedAt === null
            ? { kind: "unavailable" }
            : {
                kind: "available",
                at: requireInteger(
                  row.lastEventReceivedAt,
                  "last successful event at",
                ),
              },
    });
  }
  if (detailsByAccount.size !== accounts.length) {
    throw new Error("provider account projection details are incomplete");
  }
  return detailsByAccount;
}

function selectedResourceDisplayLabel(
  resourceKind: string,
  rawLabel: string,
  canonicalResourceId: string,
): string {
  if (rawLabel !== canonicalResourceId) {
    return rawLabel;
  }
  return resourceKind.includes("channel")
    ? "Slack channel"
    : "Selected resource";
}

function parseProjectionStringArray(
  raw: unknown,
  field: string,
): readonly string[] {
  if (typeof raw !== "string") {
    throw new Error(`${field} must be a JSON array`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${field} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON array`);
  }
  return parsed.map((entry, index) =>
    requireString(entry, `${field}[${index}]`),
  );
}

function projectCredentialHealth(
  account: IntegrationAccount,
  rawConnectionLifecycle: unknown,
  rawCredentialLifecycle: unknown,
): OnboardingCredentialHealth {
  const connectionLifecycle = requireProviderConnectionLifecycle(
    rawConnectionLifecycle,
  );
  if (
    account.lifecycle.kind === "disabled" ||
    account.lifecycle.kind === "revoked" ||
    connectionLifecycle === "disabled" ||
    connectionLifecycle === "revoked"
  ) {
    return { kind: "missing" };
  }
  if (
    account.lifecycle.kind === "degraded" ||
    account.lifecycle.kind === "reauth_required" ||
    connectionLifecycle === "reauth_required"
  ) {
    return { kind: "degraded" };
  }
  if (rawCredentialLifecycle !== "active") {
    return { kind: "missing" };
  }
  return account.lifecycle.kind === "active" && connectionLifecycle === "active"
    ? { kind: "healthy" }
    : { kind: "degraded" };
}

function projectWebhookHealth(
  row: ProviderAccountProjectionRow,
): OnboardingWebhookHealth {
  const webhookCount = requireInteger(
    row.webhookCount,
    "provider webhook count",
  );
  if (webhookCount === 0) {
    return { kind: "missing" };
  }
  const liveCount = requireInteger(
    row.liveWebhookCount,
    "live provider webhook count",
  );
  const degradedCount = requireInteger(
    row.degradedWebhookCount,
    "degraded provider webhook count",
  );
  const disabledCount = requireInteger(
    row.disabledWebhookCount,
    "disabled provider webhook count",
  );
  const revokedCount = requireInteger(
    row.revokedWebhookCount,
    "revoked provider webhook count",
  );
  if (
    liveCount > 0 &&
    degradedCount === 0 &&
    disabledCount === 0 &&
    revokedCount === 0
  ) {
    return { kind: "healthy" };
  }
  if (
    degradedCount > 0 ||
    disabledCount > 0 ||
    revokedCount > 0 ||
    (liveCount === 0 && disabledCount + revokedCount < webhookCount)
  ) {
    return { kind: "degraded" };
  }
  return { kind: "disabled" };
}

function requireProviderConnectionLifecycle(
  raw: unknown,
): "connecting" | "active" | "reauth_required" | "disabled" | "revoked" {
  switch (raw) {
    case "connecting":
    case "active":
    case "reauth_required":
    case "disabled":
    case "revoked":
      return raw;
    default:
      throw new Error("provider connection lifecycle is invalid");
  }
}

function projectProviderAccount(
  account: IntegrationAccount,
  details: ProviderAccountProjectionDetails,
): ProviderAccountProjection {
  return {
    integration_account_id: account.integrationAccountId,
    provider: account.provider,
    provider_account_id: account.providerAccountId,
    account_kind: account.accountKind,
    display_name: account.displayName,
    environment: account.environment,
    lifecycle: projectIntegrationAccountLifecycle(account.lifecycle),
    is_default_for_provider: account.isDefaultForProvider,
    capabilities: [...account.capabilities],
    scopes: [...details.scopes],
    selected_resources: [...details.selectedResources],
    credential_health: details.credentialHealth,
    webhook_health: details.webhookHealth,
    event_recency: details.eventRecency,
    audience_policy: projectAudiencePolicy(account.audiencePolicy),
    retention_policy: projectRetentionPolicy(account.retentionPolicy),
    created_at: account.createdAt,
    updated_at: account.updatedAt,
  };
}

function projectIntegrationAccountLifecycle(
  lifecycle: IntegrationAccountLifecycle,
): ProviderAccountProjection["lifecycle"] {
  switch (lifecycle.kind) {
    case "connecting":
    case "pending_activation":
    case "active":
      return { kind: lifecycle.kind };
    case "degraded":
    case "reauth_required":
      return { kind: lifecycle.kind, reason_code: lifecycle.reasonCode };
    case "disabled":
      return {
        kind: lifecycle.kind,
        disabled_by_user_id: lifecycle.disabledByUserId,
        disabled_at: lifecycle.disabledAt,
      };
    case "revoked":
      return { kind: lifecycle.kind, revoked_at: lifecycle.revokedAt };
    default:
      return assertNever(lifecycle);
  }
}

function projectAudiencePolicy(
  policy: IntegrationAccount["audiencePolicy"],
): ProviderAccountProjection["audience_policy"] {
  switch (policy.kind) {
    case "operator":
      return { kind: policy.kind };
    case "customer":
      return { kind: policy.kind, consent_required: policy.consentRequired };
    default:
      return assertNever(policy);
  }
}

function projectRetentionPolicy(
  policy: IntegrationAccount["retentionPolicy"],
): ProviderAccountProjection["retention_policy"] {
  switch (policy.kind) {
    case "organisation_default":
      return { kind: policy.kind };
    case "days":
      return { kind: policy.kind, days: policy.days };
    default:
      return assertNever(policy);
  }
}

function projectOperatingProfile(
  selection: SetupSelection | null,
): OperatingProfileProjection {
  if (selection === null) {
    return { kind: "unconfigured" };
  }
  return {
    kind: "configured",
    policy_template_id: selection.policyTemplateId,
    capability_profile: selection.capabilityProfile,
    cue_preset_id: selection.cuePresetId,
    cue_target: projectCueTarget(selection),
  };
}

function projectCueTarget(selection: SetupSelection): CueTargetProjection {
  return {
    kind: "slack",
    workspace_id: selection.cueTarget.workspaceId,
    channel_id: selection.cueTarget.channelId,
  };
}

function isUsableCommunicationConnection(account: IntegrationAccount): boolean {
  return account.provider === "slack" && isUsableLifecycle(account.lifecycle);
}

function isUsableLifecycle(lifecycle: IntegrationAccountLifecycle): boolean {
  switch (lifecycle.kind) {
    case "connecting":
    case "pending_activation":
    case "active":
    case "degraded":
    case "reauth_required":
      return true;
    case "disabled":
    case "revoked":
      return false;
    default:
      return assertNever(lifecycle);
  }
}

function isActionableStep(
  step: OnboardingStepProjection,
): step is Variant<OnboardingStepProjection, "available" | "action_required"> {
  return step.kind === "available" || step.kind === "action_required";
}

function requireOrganisationEnvironment(
  raw: unknown,
): "development" | "production" {
  if (raw !== "development" && raw !== "production") {
    throw new Error("organisation has an invalid environment");
  }
  return raw;
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return raw;
}

function requireInteger(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return raw;
}

function requirePositiveInteger(raw: unknown, field: string): number {
  const value = requireInteger(raw, field);
  if (value < 1) {
    throw new Error(`${field} must be positive`);
  }
  return value;
}

function requireSqliteBoolean(raw: unknown, field: string): boolean {
  if (raw === 0) {
    return false;
  }
  if (raw === 1) {
    return true;
  }
  throw new Error(`${field} must be a SQLite boolean`);
}
